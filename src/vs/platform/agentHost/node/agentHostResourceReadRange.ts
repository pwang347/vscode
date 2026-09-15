/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { etag, FileSystemProviderErrorCode, FileType, hasOpenReadWriteCloseCapability, type IFileService, type IStat, toFileSystemProviderErrorCode } from '../../files/common/files.js';
import { AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES, parseResourceReadRangeParams, type IAgentHostResourceReadRangeParams, type IAgentHostResourceReadRangeResult } from '../common/agentHostResourceReadRange.js';
import { AhpErrorCodes, JsonRpcErrorCodes, ProtocolError } from '../common/state/sessionProtocol.js';

function version(stat: IStat): { size: number; etag: string } {
	if (!(stat.type & FileType.File) || stat.type & FileType.Directory
		|| !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES
		|| !Number.isFinite(stat.mtime) || stat.mtime < 0) {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'The resource must be a regular file of at most 16 MiB.');
	}
	return { size: stat.size, etag: etag(stat) };
}

function assertVersion(current: { size: number; etag: string }, expectedSize?: number, expectedEtag?: string): void {
	if (expectedSize !== undefined && current.size !== expectedSize || expectedEtag !== undefined && current.etag !== expectedEtag) {
		throw new ProtocolError(AhpErrorCodes.Conflict, 'The resource changed while it was being read.');
	}
}

/**
 * Uses the same registered local-file provider as resourceRead, but requires its
 * descriptor API so a bounded request cannot fall back to a whole-file allocation.
 */
export async function readAgentHostResourceRange(fileService: IFileService, input: IAgentHostResourceReadRangeParams): Promise<IAgentHostResourceReadRangeResult> {
	const params = parseResourceReadRangeParams(input);
	const uri = URI.parse(params.uri, true);
	try {
		await fileService.activateProvider(Schemas.file);
		const provider = fileService.getProvider(Schemas.file);
		if (!provider || !hasOpenReadWriteCloseCapability(provider)) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, 'The local file provider does not support bounded reads.');
		}
		const before = version(await provider.stat(uri));
		assertVersion(before, params.expectedSize, params.expectedEtag);
		if (params.offset > before.size) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'The byte offset is beyond the end of the resource.');
		}
		const length = Math.min(params.length, before.size - params.offset);
		const fd = await provider.open(uri, { create: false });
		try {
			assertVersion(version(await provider.stat(uri)), before.size, before.etag);
			const bytes = VSBuffer.alloc(length);
			let read = 0;
			while (read < length) {
				const count = await provider.read(fd, params.offset + read, bytes.buffer, read, length - read);
				if (!Number.isSafeInteger(count) || count < 1 || count > length - read) {
					throw new ProtocolError(AhpErrorCodes.Conflict, 'The resource was truncated or returned an incomplete byte range.');
				}
				read += count;
			}
			assertVersion(version(await provider.stat(uri)), before.size, before.etag);
			return {
				encoding: 'base64', data: encodeBase64(bytes), offset: params.offset,
				size: before.size, etag: before.etag, eof: params.offset + read === before.size,
			};
		} finally {
			await provider.close(fd);
		}
	} catch (error) {
		if (error instanceof ProtocolError) {
			throw error;
		}
		switch (toFileSystemProviderErrorCode(error)) {
			case FileSystemProviderErrorCode.FileNotFound:
				throw new ProtocolError(AhpErrorCodes.NotFound, 'The resource was deleted or is no longer available.');
			case FileSystemProviderErrorCode.NoPermissions:
				throw new ProtocolError(AhpErrorCodes.PermissionDenied, 'Permission to read the resource was denied.');
			default:
				throw new ProtocolError(JsonRpcErrorCodes.InternalError, 'The bounded resource read failed.');
		}
	}
}
