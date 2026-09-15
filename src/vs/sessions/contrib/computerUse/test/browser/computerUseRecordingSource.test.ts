/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { serializeComputerUseRecordingSegment } from '../../../../../platform/agentHost/common/computerUseRecording.js';
import { ComputerUseRecordingSource } from '../../browser/computerUseRecordingSource.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';

suite('ComputerUseRecordingSource', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('lazily replays rolling GOP segments on their normalized timeline and preserves pause time', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const root = URI.from({ scheme: Schemas.inMemory, path: '/recording' });
		await fileService.createFolder(root);
		const segment = (streamId: string, byte: number) => serializeComputerUseRecordingSegment({
			streamId,
			target: { app: 'Code', windowId: 7, title: 'Editor' },
			config: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
				description: Uint8Array.of(1, 2, 3, 4),
			},
			samples: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 100_000,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(byte),
			}],
		});
		const first = segment('stream-1', 10);
		const second = segment('stream-2', 20);
		await fileService.writeFile(URI.joinPath(root, 'segment-000001.gop'), VSBuffer.wrap(first));
		await fileService.writeFile(URI.joinPath(root, 'segment-000002.gop'), VSBuffer.wrap(second));
		const manifestUri = URI.joinPath(root, 'manifest.json');
		await fileService.writeFile(manifestUri, VSBuffer.fromString(JSON.stringify({
			version: 1,
			recordingId: 'recording-1',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 500,
			sizeBytes: first.byteLength + second.byteLength,
			trimmed: true,
			segments: [
				{ file: 'segment-000001.gop', startTimeMs: 60_000, durationMs: 100, sizeBytes: first.byteLength, sampleCount: 1 },
				{ file: 'segment-000002.gop', startTimeMs: 60_400, durationMs: 100, sizeBytes: second.byteLength, sampleCount: 1 },
			],
			gaps: [{ startTimeMs: 60_100, durationMs: 300, reason: 'readError' }],
		})));
		let now = 0;
		const source = store.add(await ComputerUseRecordingSource.create(manifestUri, fileService, () => now));
		const firstBatch = await source.read(undefined, CancellationToken.None);
		now = 50;
		const beforePause = await source.read({ streamId: 'recording-1:stream-1', after: 1 }, CancellationToken.None);
		now = 1000;
		const resumed = await source.read(undefined, CancellationToken.None);
		now = 1050;
		const waiting = await source.read({ streamId: 'recording-1:stream-1', after: 2 }, CancellationToken.None);
		now = 1100;
		const secondBatch = await source.read({ streamId: 'recording-1:stream-1', after: 2 }, CancellationToken.None);
		const ended = await source.read({ streamId: 'recording-1:stream-2', after: 3 }, CancellationToken.None);

		assert.deepStrictEqual({
			kind: source.kind,
			trimmed: source.info.manifest.trimmed,
			first: firstBatch.frames?.map(frame => ({ timestamp: frame.timestamp, sequence: frame.sequence, data: frame.data })),
			beforePause: beforePause.frames,
			resumed: resumed.frames?.map(frame => ({ timestamp: frame.timestamp, sequence: frame.sequence, data: frame.data })),
			waiting: waiting.frames,
			second: secondBatch.frames?.map(frame => ({ timestamp: frame.timestamp, sequence: frame.sequence, data: frame.data })),
			ended: ended.status,
			thought: source.thought?.get(),
		}, {
			kind: 'recording',
			trimmed: true,
			first: [{ timestamp: 0, sequence: 1, data: 'Cg==' }],
			beforePause: [],
			resumed: [{ timestamp: 0, sequence: 2, data: 'Cg==' }],
			waiting: [],
			second: [{ timestamp: 400_000, sequence: 3, data: 'FA==' }],
			ended: 'idle',
			thought: undefined,
		});
	});

	test('replays thoughts on the playback timeline and discards pre-seek state', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const root = URI.from({ scheme: Schemas.inMemory, path: '/thought-recording' });
		await fileService.createFolder(root);
		const segment = serializeComputerUseRecordingSegment({
			streamId: 'stream',
			target: { app: 'Code', windowId: 7, title: 'Editor' },
			config: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
				description: Uint8Array.of(1, 2, 3, 4),
			},
			samples: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 100_000,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(10),
			}, {
				sequence: 2,
				timestampUs: 400_000,
				durationUs: 100_000,
				keyFrame: false,
				frameCount: 1,
				data: Uint8Array.of(20),
			}],
		});
		await fileService.writeFile(URI.joinPath(root, 'segment-000001.gop'), VSBuffer.wrap(segment));
		const manifestUri = URI.joinPath(root, 'manifest.json');
		await fileService.writeFile(manifestUri, VSBuffer.fromString(JSON.stringify({
			version: 1,
			recordingId: 'recording-thoughts',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 500,
			sizeBytes: segment.byteLength,
			trimmed: false,
			segments: [{ file: 'segment-000001.gop', startTimeMs: 1000, durationMs: 500, sizeBytes: segment.byteLength, sampleCount: 2 }],
			gaps: [],
			thoughts: [
				{ timeMs: 1000, source: 'reasoning', text: 'Inspecting', streaming: true },
				{ timeMs: 1100, source: 'reasoning', text: 'Inspecting the page.', streaming: false },
				{ timeMs: 1400, source: 'activity', text: 'Clicking the button', streaming: true },
			],
		})));
		let now = 0;
		const source = store.add(await ComputerUseRecordingSource.create(manifestUri, fileService, () => now));

		await source.read(undefined, CancellationToken.None);
		const started = source.thought?.get();
		now = 100;
		await source.read({ streamId: 'recording-thoughts:stream', after: 1 }, CancellationToken.None);
		const completed = source.thought?.get();
		source.seek(250);
		const clearedOnSeek = source.thought?.get();
		await source.read(undefined, CancellationToken.None);
		const afterSeek = source.thought?.get();
		source.onFramePresented(400_000);
		const atActivity = source.thought?.get();
		source.restart();
		const clearedOnRestart = source.thought?.get();
		await source.read(undefined, CancellationToken.None);
		const restarted = source.thought?.get();
		source.onPlaybackEnded();

		assert.deepStrictEqual({
			started,
			completed,
			clearedOnSeek,
			afterSeek,
			atActivity,
			clearedOnRestart,
			restarted,
			ended: source.thought?.get(),
		}, {
			started: { source: 'reasoning', text: 'Inspecting', streaming: true },
			completed: { source: 'reasoning', text: 'Inspecting the page.', streaming: false },
			clearedOnSeek: undefined,
			afterSeek: undefined,
			atActivity: { source: 'activity', text: 'Clicking the button', streaming: true },
			clearedOnRestart: undefined,
			restarted: { source: 'reasoning', text: 'Inspecting', streaming: true },
			ended: undefined,
		});
	});

	test('reads hover previews and unchanged ranges from existing segment metadata', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const root = URI.from({ scheme: Schemas.inMemory, path: '/preview-recording' });
		await fileService.createFolder(root);
		const segment = serializeComputerUseRecordingSegment({
			streamId: 'stream',
			target: { app: 'Code', windowId: 7, title: 'Editor' },
			config: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
				description: Uint8Array.of(1, 2, 3, 4),
			},
			samples: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 100_000,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(10),
			}, {
				sequence: 2,
				timestampUs: 100_000,
				durationUs: 300_000,
				keyFrame: false,
				frameCount: 3,
				data: Uint8Array.of(20),
			}],
		});
		await fileService.writeFile(URI.joinPath(root, 'segment-000001.gop'), VSBuffer.wrap(segment));
		const manifestUri = URI.joinPath(root, 'manifest.json');
		await fileService.writeFile(manifestUri, VSBuffer.fromString(JSON.stringify({
			version: 1,
			recordingId: 'recording-preview',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 400,
			sizeBytes: segment.byteLength,
			trimmed: false,
			segments: [{ file: 'segment-000001.gop', startTimeMs: 1000, durationMs: 400, sizeBytes: segment.byteLength, sampleCount: 2 }],
			gaps: [],
		})));
		const source = store.add(await ComputerUseRecordingSource.create(manifestUri, fileService));
		const ranges = await source.readRecordingTimeline(CancellationToken.None);
		const preview = await source.readRecordingPreview(350, CancellationToken.None);

		assert.deepStrictEqual({
			ranges,
			preview: preview && {
				config: preview.config,
				frames: preview.frames.map(frame => ({
					sequence: frame.sequence,
					timestamp: frame.timestamp,
					duration: frame.duration,
					keyFrame: frame.keyFrame,
					data: frame.data,
				})),
			},
		}, {
			ranges: [{ startMs: 200, durationMs: 200 }],
			preview: {
				config: {
					codec: 'avc1.64001f',
					codedWidth: 1280,
					codedHeight: 720,
					description: 'AQIDBA==',
				},
				frames: [{
					sequence: 1,
					timestamp: 0,
					duration: 100_000,
					keyFrame: true,
					data: 'Cg==',
				}, {
					sequence: 2,
					timestamp: 100_000,
					duration: 300_000,
					keyFrame: false,
					data: 'FA==',
				}],
			},
		});
	});
});
