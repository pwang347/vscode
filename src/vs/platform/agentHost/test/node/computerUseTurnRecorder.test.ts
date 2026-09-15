/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseComputerUseRecordingSegment } from '../../common/computerUseRecording.js';
import { ComputerUseRecordingStore } from '../../node/chatContributions/computerUseRecording/computerUseRecordingStore.js';
import { ComputerUseTurnRecorder, type IComputerUseRecordingScheduler } from '../../node/chatContributions/computerUseRecording/computerUseTurnRecorder.js';

interface IScheduledTask {
	readonly time: number;
	readonly callback: () => void | Promise<void>;
	cancelled: boolean;
}

class TestRecordingScheduler implements IComputerUseRecordingScheduler {
	private readonly _tasks: IScheduledTask[] = [];
	private _now = 0;

	now(): number {
		return this._now;
	}

	schedule(callback: () => void | Promise<void>, delay: number): IDisposable {
		const task = { time: this._now + delay, callback, cancelled: false };
		this._tasks.push(task);
		return toDisposable(() => task.cancelled = true);
	}

	async advanceTo(time: number): Promise<void> {
		while (true) {
			const next = this._tasks
				.filter(task => !task.cancelled && task.time <= time)
				.sort((first, second) => first.time - second.time)[0];
			if (!next) {
				break;
			}
			next.cancelled = true;
			this._now = next.time;
			await next.callback();
		}
		this._now = time;
	}
}

function resource(streamId: string, frames: readonly { sequence: number; timestamp: number; keyFrame: boolean; data: readonly number[] }[]) {
	return {
		contents: [{
			uri: 'computer-use://video/live',
			mimeType: 'application/json',
			text: JSON.stringify({
				version: 1,
				status: 'live',
				streamId,
				target: { app: 'Code', windowId: 7, title: 'Editor' },
				config: {
					codec: 'avc1.64001f',
					codedWidth: 1280,
					codedHeight: 720,
					description: Buffer.from([1, 2, 3, 4]).toString('base64'),
				},
				frames: frames.map(frame => ({
					...frame,
					duration: 33_333,
					data: Buffer.from(frame.data).toString('base64'),
				})),
			}),
		}],
	};
}

suite('Computer Use Turn Recorder', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const temporaryRoots: string[] = [];

	teardown(async () => {
		await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	test('records without a viewer at fixed cadence and recovers the cursor at a keyframe', async () => {
		const root = URI.file(await fs.mkdtemp(join(tmpdir(), 'vscode-computer-use-turn-')));
		temporaryRoots.push(root.fsPath);
		const store = await ComputerUseRecordingStore.create(root, 'turn', '2026-09-14T20:00:00.000Z');
		const scheduler = new TestRecordingScheduler();
		const calls: { time: number; uri: string }[] = [];
		const responses: Array<unknown | Error> = [
			resource('stream', [{ sequence: 1, timestamp: 0, keyFrame: true, data: [10] }]),
			new Error('temporary read failure'),
			resource('stream', [
				{ sequence: 3, timestamp: 66_666, keyFrame: false, data: [30] },
				{ sequence: 4, timestamp: 99_999, keyFrame: true, data: [40] },
			]),
		];
		let firstPersistedFrames = 0;
		const recorder = disposables.add(new ComputerUseTurnRecorder(store, {
			scheduler,
			pollIntervalMs: 100,
			readTimeoutMs: 1000,
			readResource: async uri => {
				calls.push({ time: scheduler.now(), uri });
				const response = responses.shift();
				if (response instanceof Error) {
					throw response;
				}
				return response;
			},
			onFirstFramePersisted: () => firstPersistedFrames++,
		}));

		recorder.start();
		recorder.recordThought({ source: 'reasoning', text: 'Inspecting', streaming: true });
		await scheduler.advanceTo(50);
		recorder.recordThought({ source: 'reasoning', text: 'Inspecting the page.', streaming: false });
		await scheduler.advanceTo(200);
		const result = await recorder.stop();
		assert.ok(result);
		const firstSequences = await Promise.all(result.manifest.segments.map(async segment =>
			parseComputerUseRecordingSegment(await fs.readFile(join(root.fsPath, 'computer-use-recordings', 'turn', segment.file))).samples[0].sequence
		));

		assert.deepStrictEqual({
			calls,
			firstPersistedFrames,
			segments: result.manifest.segments.map(segment => ({ startTimeMs: segment.startTimeMs, sampleCount: segment.sampleCount })),
			gaps: result.manifest.gaps,
			thoughts: result.manifest.thoughts,
			firstSequences,
		}, {
			calls: [
				{ time: 0, uri: 'computer-use://video/live' },
				{ time: 100, uri: 'computer-use://video/live?streamId=stream&after=1' },
				{ time: 200, uri: 'computer-use://video/live?streamId=stream&after=1' },
			],
			firstPersistedFrames: 1,
			segments: [
				{ startTimeMs: 0, sampleCount: 1 },
				{ startTimeMs: 234, sampleCount: 1 },
			],
			gaps: [
				{ startTimeMs: 34, durationMs: 100, reason: 'readError' },
				{ startTimeMs: 134, durationMs: 100, reason: 'cursorReset' },
			],
			thoughts: [
				{ timeMs: 0, source: 'reasoning', text: 'Inspecting', streaming: true },
				{ timeMs: 50, source: 'reasoning', text: 'Inspecting the page.', streaming: false },
			],
			firstSequences: [1, 4],
		});
	});
});
