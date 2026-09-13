/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IComputerUseVideoBatch, parseComputerUseVideoResource } from '../../common/computerUse.js';

const liveBatch: IComputerUseVideoBatch = {
	version: 1,
	status: 'live',
	streamId: 'stream-1',
	target: { app: 'Verification', windowId: 42, title: 'Synthetic app' },
	config: { codec: 'avc1.42E01F', codedWidth: 1280, codedHeight: 720, description: 'AQIDBA==' },
	frames: [
		{ sequence: 1, timestamp: 0, duration: 33333, keyFrame: true, data: 'AQIDBA==' },
		{ sequence: 2, timestamp: 33333, duration: 33333, keyFrame: false, data: 'BQYHCA==' },
	],
};

function resource(batch: Partial<IComputerUseVideoBatch>) {
	return { contents: [{ uri: 'computer-use://video/live', mimeType: 'application/json', text: JSON.stringify(batch) }] };
}

suite('Computer Use video resource', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts an ordered H264 batch with microsecond timestamps', () => {
		assert.deepStrictEqual(parseComputerUseVideoResource(resource(liveBatch)), liveBatch);
	});

	test('accepts idle and permission states without media payloads', () => {
		const batches: IComputerUseVideoBatch[] = [
			{ version: 1, status: 'idle' },
			{ version: 1, status: 'permissionRequired', message: 'Screen Recording is required.' },
		];
		assert.deepStrictEqual(batches.map(batch => parseComputerUseVideoResource(resource(batch))), batches);
	});

	test('rejects live packets without a target or configuration', () => {
		assert.throws(() => parseComputerUseVideoResource(resource({ version: 1, status: 'live', streamId: '1' })), /missing its target/);
	});

	test('rejects unsupported codec and excessive decoded dimensions', () => {
		for (const config of [
			{ ...liveBatch.config!, codec: 'video/jpeg' },
			{ ...liveBatch.config!, codedWidth: 4096, codedHeight: 4096 },
			{ ...liveBatch.config!, codedWidth: 1.5 },
			{ ...liveBatch.config!, description: '<not-base64>' },
		]) {
			assert.throws(() => parseComputerUseVideoResource(resource({ ...liveBatch, config })), /decoder configuration/);
		}
	});

	test('rejects duplicate, out-of-order, and oversized frames', () => {
		const first = liveBatch.frames![0];
		for (const frames of [
			[first, first],
			[{ ...first, sequence: -1 }],
			[{ ...first, timestamp: -1 }],
			[{ ...first, duration: 0 }],
			[{ ...first, data: 'invalid' }],
			[{ ...first, data: 'AAAA'.repeat(400_000) }],
		]) {
			assert.throws(() => parseComputerUseVideoResource(resource({ ...liveBatch, frames })), /video frame/);
		}
	});

	test('limits packets per batch and rejects unknown protocol versions', () => {
		assert.throws(() => parseComputerUseVideoResource(resource({
			...liveBatch,
			frames: Array.from({ length: 61 }, (_, index) => ({ ...liveBatch.frames![0], sequence: index + 1 })),
		})), /Too many/);
		const response = resource(liveBatch);
		response.contents[0].text = JSON.stringify({ ...liveBatch, version: 2 });
		assert.throws(() => parseComputerUseVideoResource(response), /Unsupported/);
	});

	test('requires a native video resource rather than arbitrary MCP content', () => {
		assert.throws(() => parseComputerUseVideoResource({ contents: [{ uri: 'file:///tmp/other', text: '{}' }] }), /Missing/);
		assert.throws(() => parseComputerUseVideoResource({ contents: [{ uri: 'computer-use://video/live', text: '{' }] }));
	});
});
