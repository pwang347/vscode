/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm, truncate, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, type IFileOpenOptions } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { AGENT_HOST_RESOURCE_RANGE_MAX_BYTES, AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES, parseResourceReadRangeParams, type IAgentHostResourceReadRangeParams } from '../../common/agentHostResourceReadRange.js';
import { AhpErrorCodes, JsonRpcErrorCodes, ProtocolError } from '../../common/state/sessionProtocol.js';
import { readAgentHostResourceRange } from '../../node/agentHostResourceReadRange.js';

class RangeTestFileProvider extends DiskFileSystemProvider {
	readonly reads: { position: number; length: number; bufferSize: number }[] = [];
	opens = 0;
	closes = 0;
	maxReadLength = Number.MAX_SAFE_INTEGER;
	afterRead: (() => Promise<void>) | undefined;
	denyOpen = false;
	returnZero = false;

	override async open(resource: URI, options: IFileOpenOptions): Promise<number> {
		this.opens++;
		if (this.denyOpen) {
			throw createFileSystemProviderError('sensitive source path', FileSystemProviderErrorCode.NoPermissions);
		}
		return super.open(resource, options);
	}
	override async close(fd: number): Promise<void> {
		this.closes++;
		return super.close(fd);
	}
	override async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		this.reads.push({ position: pos, length, bufferSize: data.byteLength });
		const count = this.returnZero ? 0 : await super.read(fd, pos, data, offset, Math.min(length, this.maxReadLength));
		await this.afterRead?.();
		return count;
	}
	override async readFile(): Promise<Uint8Array> {
		throw new Error('A bounded read must never load the whole file.');
	}
}

suite('AgentHostResourceReadRange', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let file: URI;
	let fileService: FileService;
	let provider: RangeTestFileProvider;
	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'agent-host-resource-range-'));
		file = URI.file(join(root, 'segment-000001.gop'));
		await writeFile(file.fsPath, Buffer.from('0123456789'));
		provider = disposables.add(new RangeTestFileProvider(new NullLogService()));
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', provider));
	});
	teardown(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

	function params(offset = 0, length = 4): IAgentHostResourceReadRangeParams {
		return { channel: 'ahp-root://', uri: file.toString(), offset, length };
	}
	const code = (expected: number) => (error: unknown) => error instanceof ProtocolError && error.code === expected;

	test('reads only the selected slice through bounded descriptor reads', async () => {
		const result = await readAgentHostResourceRange(fileService, params(3, 4));
		assert.strictEqual(decodeBase64(result.data).toString(), '3456');
		assert.deepStrictEqual({ encoding: result.encoding, offset: result.offset, size: result.size, eof: result.eof }, {
			encoding: 'base64', offset: 3, size: 10, eof: false,
		});
		assert.ok(result.etag.length > 0 && result.etag.length <= 256);
		assert.deepStrictEqual(provider.reads, [{ position: 3, length: 4, bufferSize: 4 }]);
		assert.strictEqual(provider.closes, 1);
	});

	test('zero-length metadata and EOF reads still verify read access', async () => {
		const metadata = await readAgentHostResourceRange(fileService, params(0, 0));
		const eof = await readAgentHostResourceRange(fileService, { ...params(10, 4), expectedSize: metadata.size, expectedEtag: metadata.etag });
		assert.strictEqual(metadata.data, '');
		assert.strictEqual(metadata.eof, false);
		assert.strictEqual(eof.data, '');
		assert.strictEqual(eof.eof, true);
		assert.strictEqual(provider.reads.length, 0);
		assert.strictEqual(provider.opens, 2);
		assert.strictEqual(provider.closes, 2);
		const tail = await readAgentHostResourceRange(fileService, params(8, 4));
		assert.strictEqual(decodeBase64(tail.data).toString(), '89');
		assert.strictEqual(tail.eof, true);
		await assert.rejects(readAgentHostResourceRange(fileService, params(11, 1)), code(JsonRpcErrorCodes.InvalidParams));
	});

	test('fills partial provider reads without growing the bounded allocation', async () => {
		provider.maxReadLength = 2;
		const result = await readAgentHostResourceRange(fileService, params(1, 7));
		assert.strictEqual(decodeBase64(result.data).toString(), '1234567');
		assert.deepStrictEqual(provider.reads.map(read => read.position), [1, 3, 5, 7]);
		assert.ok(provider.reads.every(read => read.bufferSize === 7));
	});

	test('rejects directories but returns an explicit EOF for an empty readable file', async () => {
		await assert.rejects(readAgentHostResourceRange(fileService, { ...params(), uri: URI.file(root).toString() }), code(JsonRpcErrorCodes.InvalidParams));
		assert.strictEqual(provider.opens, 0);
		await truncate(file.fsPath, 0);
		const result = await readAgentHostResourceRange(fileService, params());
		assert.strictEqual(result.size, 0);
		assert.strictEqual(result.data, '');
		assert.strictEqual(result.eof, true);
		assert.strictEqual(provider.opens, 1);
		assert.strictEqual(provider.closes, 1);
		assert.strictEqual(provider.reads.length, 0);
	});

	test('requires descriptor-read capability instead of falling back to whole-file reads', async () => {
		const unsupportedService = disposables.add(new FileService(new NullLogService()));
		const wholeFileProvider = disposables.add(new InMemoryFileSystemProvider());
		wholeFileProvider.setReadOnly(true);
		disposables.add(unsupportedService.registerProvider('file', wholeFileProvider));
		await assert.rejects(readAgentHostResourceRange(unsupportedService, params()), error =>
			code(JsonRpcErrorCodes.InternalError)(error) && error instanceof Error && error.message.includes('does not support bounded reads'));
	});

	test('enforces the exact chunk and file size limits before reading bytes', async () => {
		await truncate(file.fsPath, AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES);
		const chunk = await readAgentHostResourceRange(fileService, params(0, AGENT_HOST_RESOURCE_RANGE_MAX_BYTES));
		assert.strictEqual(decodeBase64(chunk.data).byteLength, AGENT_HOST_RESOURCE_RANGE_MAX_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chunk })) < 8 * 1024 * 1024);
		assert.strictEqual(provider.reads.length, 1);
		assert.strictEqual(provider.reads[0].bufferSize, AGENT_HOST_RESOURCE_RANGE_MAX_BYTES);
		await assert.rejects(readAgentHostResourceRange(fileService, params(0, AGENT_HOST_RESOURCE_RANGE_MAX_BYTES + 1)), code(JsonRpcErrorCodes.InvalidParams));
		await truncate(file.fsPath, AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES + 1);
		await assert.rejects(readAgentHostResourceRange(fileService, params(0, 1)), code(JsonRpcErrorCodes.InvalidParams));
		assert.strictEqual(provider.reads.length, 1);
	});

	test('rejects malformed and foreign resource ranges without opening a file', async () => {
		const invalid: unknown[] = [
			null, {}, { ...params(), channel: 'ahp-chat://other' }, { ...params(), offset: -1 },
			{ ...params(), length: 1.5 }, { ...params(), expectedSize: -1 }, { ...params(), expectedEtag: '' },
			{ ...params(), expectedEtag: 'x'.repeat(257) }, { ...params(), uri: 'https://example.com/secret' },
			{ ...params(), uri: 'file://remote-host/share/file' }, { ...params(), uri: `${file}?query` },
			{ ...params(), uri: `${file}#fragment` }, { ...params(), uri: 'file:///invalid%00path' },
			{ ...params(), uri: 'file:relative' }, { ...params(), uri: `${file}?` }, { ...params(), uri: `${file}#` },
		];
		for (const value of invalid) {
			assert.throws(() => parseResourceReadRangeParams(value), code(JsonRpcErrorCodes.InvalidParams));
		}
		assert.strictEqual(provider.opens, 0);
	});

	test('rejects changed version expectations and changes during a read', async () => {
		const first = await readAgentHostResourceRange(fileService, params(0, 0));
		await assert.rejects(readAgentHostResourceRange(fileService, { ...params(), expectedEtag: 'old' }), code(AhpErrorCodes.Conflict));
		await assert.rejects(readAgentHostResourceRange(fileService, { ...params(), expectedSize: 11 }), code(AhpErrorCodes.Conflict));
		provider.afterRead = () => utimes(file.fsPath, new Date(2_000_000), new Date(2_000_000));
		await assert.rejects(readAgentHostResourceRange(fileService, { ...params(), expectedEtag: first.etag }), code(AhpErrorCodes.Conflict));
		assert.strictEqual(provider.opens, provider.closes);
	});

	test('truncation, denial, and missing files fail explicitly without leaking provider errors', async () => {
		provider.returnZero = true;
		await assert.rejects(readAgentHostResourceRange(fileService, params()), code(AhpErrorCodes.Conflict));
		assert.strictEqual(provider.opens, provider.closes);
		provider.denyOpen = true;
		await assert.rejects(readAgentHostResourceRange(fileService, params(0, 0)), error =>
			code(AhpErrorCodes.PermissionDenied)(error) && error instanceof Error && !error.message.includes('sensitive'));
		await rm(file.fsPath);
		await assert.rejects(readAgentHostResourceRange(fileService, params()), code(AhpErrorCodes.NotFound));
	});
});
