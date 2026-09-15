/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { URI } from '../../../../base/common/uri.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseComputerUseRecordingManifest, parseComputerUseRecordingSegment } from '../../common/computerUseRecording.js';
import { ComputerUseRecordingStore } from '../../node/chatContributions/computerUseRecording/computerUseRecordingStore.js';

suite('Computer Use Recording Store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const temporaryRoots: string[] = [];

	teardown(async () => {
		await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	test('persists raw GOP bytes and coalesces identical consecutive delta access units', async () => {
		const chatDataDirectory = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-recording-')));
		temporaryRoots.push(chatDataDirectory.fsPath);
		const store = await ComputerUseRecordingStore.create(chatDataDirectory, 'recording-1', '2026-09-14T20:00:00.000Z');
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };

		await store.appendFrames({
			streamId: 'stream-1',
			config,
			target,
			frames: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(10, 11, 12),
			}, {
				sequence: 2,
				timestampUs: 33_333,
				durationUs: 33_333,
				keyFrame: false,
				frameCount: 1,
				focus: { x: 0.5, y: 0.25 },
				data: Uint8Array.of(20, 21),
			}, {
				sequence: 3,
				timestampUs: 66_666,
				durationUs: 33_333,
				keyFrame: false,
				frameCount: 1,
				focus: { x: 0.5, y: 0.25 },
				data: Uint8Array.of(20, 21),
			}, {
				sequence: 4,
				timestampUs: 99_999,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(30, 31, 32),
			}],
		});
		const result = await store.finalize();
		assert.ok(result);

		const manifestPath = join(chatDataDirectory.fsPath, 'computer-use-recordings', 'recording-1', 'manifest.json');
		const manifest = parseComputerUseRecordingManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
		const segmentPath = join(chatDataDirectory.fsPath, 'computer-use-recordings', 'recording-1', manifest.segments[0].file);
		const segment = parseComputerUseRecordingSegment(await fs.readFile(segmentPath));
		const files = (await fs.readdir(join(chatDataDirectory.fsPath, 'computer-use-recordings', 'recording-1'))).sort();
		const modes = process.platform === 'win32' ? [] : [
			(await fs.stat(manifestPath)).mode & 0o077,
			(await fs.stat(segmentPath)).mode & 0o077,
		];

		assert.deepStrictEqual({
			files,
			modes,
			manifest,
			samples: segment.samples.map(sample => ({
				sequence: sample.sequence,
				durationUs: sample.durationUs,
				frameCount: sample.frameCount,
				focus: sample.focus,
				data: [...sample.data],
			})),
		}, {
			files: ['manifest.json', 'segment-000001.gop'],
			modes: process.platform === 'win32' ? [] : [0, 0],
			manifest: {
				version: 1,
				recordingId: 'recording-1',
				createdAt: '2026-09-14T20:00:00.000Z',
				finalized: true,
				durationMs: 134,
				sizeBytes: manifest.segments[0].sizeBytes,
				trimmed: false,
				segments: [{
					file: 'segment-000001.gop',
					startTimeMs: 0,
					durationMs: 134,
					sizeBytes: manifest.segments[0].sizeBytes,
					sampleCount: 3,
				}],
				gaps: [],
			},
			samples: [{
				sequence: 1,
				durationUs: 33_333,
				frameCount: 1,
				focus: undefined,
				data: [10, 11, 12],
			}, {
				sequence: 2,
				durationUs: 66_666,
				frameCount: 2,
				focus: { x: 0.5, y: 0.25 },
				data: [20, 21],
			}, {
				sequence: 4,
				durationUs: 33_333,
				frameCount: 1,
				focus: undefined,
				data: [30, 31, 32],
			}],
		});
	});

	test('evicts only whole oldest keyframe-started segments under duration and byte limits', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-rolling-')));
		temporaryRoots.push(root.fsPath);
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };
		const makeFrames = (size: number) => [1, 2, 3, 4].map(sequence => ({
			sequence,
			timestampUs: (sequence - 1) * 40_000,
			durationUs: 40_000,
			keyFrame: true,
			frameCount: 1,
			data: new Uint8Array(size).fill(sequence),
		}));

		const durationStore = await ComputerUseRecordingStore.create(root, 'duration-limited', '2026-09-14T20:00:00.000Z', {
			maxDurationMs: 75,
			maxSizeBytes: 1024 * 1024,
			targetSegmentDurationMs: 1,
		});

		await durationStore.appendFrames({ streamId: 'stream', config, target, frames: makeFrames(8) });
		const durationResult = await durationStore.finalize();
		assert.ok(durationResult);

		const byteStore = await ComputerUseRecordingStore.create(root, 'byte-limited', '2026-09-14T20:00:00.000Z', {
			maxDurationMs: 60_000,
			maxSizeBytes: 2000,
			targetSegmentDurationMs: 1,
		});
		await byteStore.appendFrames({ streamId: 'stream', config, target, frames: makeFrames(800) });
		const byteResult = await byteStore.finalize();
		assert.ok(byteResult);

		const segmentStarts = await Promise.all([
			...durationResult.manifest.segments.map(async segment => parseComputerUseRecordingSegment(await fs.readFile(join(
				root.fsPath,
				'computer-use-recordings',
				'duration-limited',
				segment.file,
			))).samples[0].keyFrame),
			...byteResult.manifest.segments.map(async segment => parseComputerUseRecordingSegment(await fs.readFile(join(
				root.fsPath,
				'computer-use-recordings',
				'byte-limited',
				segment.file,
			))).samples[0].keyFrame),
		]);

		assert.deepStrictEqual({
			duration: {
				files: durationResult.manifest.segments.map(segment => segment.file),
				durationMs: durationResult.manifest.durationMs,
				trimmed: durationResult.manifest.trimmed,
			},
			bytes: {
				files: byteResult.manifest.segments.map(segment => segment.file),
				sizeBytes: byteResult.manifest.sizeBytes,
				underLimit: byteResult.manifest.sizeBytes <= 2000,
				trimmed: byteResult.manifest.trimmed,
			},
			segmentStarts,
		}, {
			duration: {
				files: ['segment-000004.gop'],
				durationMs: 40,
				trimmed: true,
			},
			bytes: {
				files: ['segment-000004.gop'],
				sizeBytes: byteResult.manifest.segments[0].sizeBytes,
				underLimit: true,
				trimmed: true,
			},
			segmentStarts: [true, true],
		});
	});

	test('persists bounded thoughts and trims them with retained segments', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-thoughts-')));
		temporaryRoots.push(root.fsPath);
		const store = await ComputerUseRecordingStore.create(root, 'thoughts', '2026-09-14T20:00:00.000Z', {
			maxDurationMs: 75,
			maxSizeBytes: 1024 * 1024,
			targetSegmentDurationMs: 1,
		});
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };
		for (let sequence = 1; sequence <= 4; sequence++) {
			await store.appendFrames({
				streamId: 'stream',
				config,
				target,
				frames: [{
					sequence,
					timestampUs: (sequence - 1) * 40_000,
					durationUs: 40_000,
					keyFrame: true,
					frameCount: 1,
					data: Uint8Array.of(sequence),
				}],
			});
			store.recordThought({
				timeMs: (sequence - 1) * 40,
				source: sequence === 4 ? 'activity' : 'reasoning',
				text: `Thought ${sequence}`,
				streaming: sequence !== 4,
			});
		}
		store.recordThought({ timeMs: 150, source: 'activity', text: 'Finished', streaming: false });
		const result = await store.finalize();
		assert.ok(result);

		assert.deepStrictEqual({
			segments: result.manifest.segments.map(segment => ({ startTimeMs: segment.startTimeMs, durationMs: segment.durationMs })),
			thoughts: result.manifest.thoughts,
		}, {
			segments: [{ startTimeMs: 120, durationMs: 40 }],
			thoughts: [
				{ timeMs: 120, source: 'activity', text: 'Thought 4', streaming: false },
				{ timeMs: 150, source: 'activity', text: 'Finished', streaming: false },
			],
		});
	});

	test('persists and coalesces error gaps while requiring keyframe recovery', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-gaps-')));
		temporaryRoots.push(root.fsPath);
		const store = await ComputerUseRecordingStore.create(root, 'gaps', '2026-09-14T20:00:00.000Z');
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };

		await store.appendFrames({
			streamId: 'stream',
			config,
			target,
			frames: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(1),
			}],
		});
		await store.recordGap('readError', 250);
		await store.recordGap('readError', 250);
		const rollingPath = join(root.fsPath, 'computer-use-recordings', 'gaps', 'manifest.json');
		const rolling = parseComputerUseRecordingManifest(JSON.parse(await fs.readFile(rollingPath, 'utf8')));

		await store.appendFrames({
			streamId: 'stream',
			config,
			target,
			frames: [{
				sequence: 2,
				timestampUs: 33_333,
				durationUs: 33_333,
				keyFrame: false,
				frameCount: 1,
				data: Uint8Array.of(2),
			}, {
				sequence: 3,
				timestampUs: 66_666,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(3),
			}],
		});
		const result = await store.finalize();
		assert.ok(result);

		assert.deepStrictEqual({
			rolling: {
				finalized: rolling.finalized,
				durationMs: rolling.durationMs,
				gaps: rolling.gaps,
			},
			final: {
				durationMs: result.manifest.durationMs,
				segments: result.manifest.segments.map(segment => ({
					startTimeMs: segment.startTimeMs,
					sampleCount: segment.sampleCount,
				})),
				gaps: result.manifest.gaps,
			},
		}, {
			rolling: {
				finalized: false,
				durationMs: 534,
				gaps: [{ startTimeMs: 34, durationMs: 500, reason: 'readError' }],
			},
			final: {
				durationMs: 568,
				segments: [
					{ startTimeMs: 0, sampleCount: 1 },
					{ startTimeMs: 534, sampleCount: 1 },
				],
				gaps: [{ startTimeMs: 34, durationMs: 500, reason: 'readError' }],
			},
		});
	});

	test('recovers interrupted manifests, removes stale temp files, and rejects corrupt recordings', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-recovery-')));
		temporaryRoots.push(root.fsPath);
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };
		const frames = [{
			sequence: 1,
			timestampUs: 0,
			durationUs: 33_333,
			keyFrame: true,
			frameCount: 1,
			data: Uint8Array.of(1, 2, 3),
		}];

		const empty = await ComputerUseRecordingStore.create(root, 'empty', '2026-09-14T20:00:00.000Z');
		assert.strictEqual(await empty.finalize(), undefined);

		const interrupted = await ComputerUseRecordingStore.create(root, 'interrupted', '2026-09-14T20:00:00.000Z');
		await interrupted.appendFrames({ streamId: 'stream', config, target, frames });
		await interrupted.recordGap('readError', 10);
		const interruptedDirectory = join(root.fsPath, 'computer-use-recordings', 'interrupted');
		await fs.writeFile(join(interruptedDirectory, 'manifest.json.tmp-00000000-0000-4000-8000-000000000000'), 'stale');

		const corrupt = await ComputerUseRecordingStore.create(root, 'corrupt', '2026-09-14T20:00:00.000Z');
		await corrupt.appendFrames({ streamId: 'stream', config, target, frames });
		const corruptResult = await corrupt.finalize();
		assert.ok(corruptResult);
		const corruptSegment = join(root.fsPath, 'computer-use-recordings', 'corrupt', corruptResult.manifest.segments[0].file);
		await fs.writeFile(corruptSegment, new Uint8Array(corruptResult.manifest.segments[0].sizeBytes));

		const recovery = await ComputerUseRecordingStore.recover(root);
		const recoveredManifest = parseComputerUseRecordingManifest(JSON.parse(await fs.readFile(join(interruptedDirectory, 'manifest.json'), 'utf8')));
		const interruptedFiles = (await fs.readdir(interruptedDirectory)).sort();
		const emptyExists = await fs.access(join(root.fsPath, 'computer-use-recordings', 'empty')).then(() => true, () => false);
		const corruptExists = await fs.access(join(root.fsPath, 'computer-use-recordings', 'corrupt')).then(() => true, () => false);

		assert.deepStrictEqual({
			recovery: {
				recordingIds: recovery.recordings.map(manifest => manifest.recordingId),
				invalidRecordingIds: recovery.invalidRecordingIds,
			},
			recoveredFinalized: recoveredManifest.finalized,
			interruptedFiles,
			emptyExists,
			corruptExists,
		}, {
			recovery: {
				recordingIds: ['interrupted'],
				invalidRecordingIds: ['corrupt'],
			},
			recoveredFinalized: true,
			interruptedFiles: ['manifest.json', 'segment-000001.gop'],
			emptyExists: false,
			corruptExists: false,
		});
	});

	test('bounds an open segment and drops overflow deltas until the next keyframe', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-segment-bound-')));
		temporaryRoots.push(root.fsPath);
		const store = await ComputerUseRecordingStore.create(root, 'bounded', '2026-09-14T20:00:00.000Z', {
			maxSegmentBytes: 100 * 1024,
			targetSegmentDurationMs: 60_000,
		});
		const config = {
			codec: 'avc1.64001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: Uint8Array.of(1, 2, 3, 4),
		};
		const target = { app: 'Code', windowId: 7, title: 'Editor' };
		await store.appendFrames({
			streamId: 'stream',
			config,
			target,
			frames: [1, 2, 3, 4, 5].map(sequence => ({
				sequence,
				timestampUs: (sequence - 1) * 33_333,
				durationUs: 33_333,
				keyFrame: sequence === 1 || sequence === 5,
				frameCount: 1,
				data: new Uint8Array(40 * 1024).fill(sequence),
			})),
		});
		const result = await store.finalize();
		assert.ok(result);

		assert.deepStrictEqual({
			segments: result.manifest.segments.map(segment => ({
				startTimeMs: segment.startTimeMs,
				durationMs: segment.durationMs,
				sampleCount: segment.sampleCount,
				underLimit: segment.sizeBytes <= 100 * 1024,
			})),
			gaps: result.manifest.gaps,
		}, {
			segments: [
				{ startTimeMs: 0, durationMs: 67, sampleCount: 2, underLimit: true },
				{ startTimeMs: 134, durationMs: 34, sampleCount: 1, underLimit: true },
			],
			gaps: [{ startTimeMs: 67, durationMs: 67, reason: 'segmentLimit' }],
		});
	});
});
