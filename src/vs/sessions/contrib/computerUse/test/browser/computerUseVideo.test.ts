/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IComputerUseVideoBatch } from '../../../../services/sessions/common/computerUse.js';
import { ComputerUseVideo } from '../../browser/computerUseVideo.js';
import { TestVideoDecoderFactory, TestVideoScheduler, TestVideoSource, testVideoConfig, videoBatch, videoFrame } from './computerUseTestUtils.js';

suite('ComputerUseVideo', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createVideo() {
		const source = store.add(new TestVideoSource());
		const factory = new TestVideoDecoderFactory();
		const scheduler = new TestVideoScheduler();
		const rendered: { timestamp: number; now: number }[] = [];
		let clears = 0;
		const video = store.add(new ComputerUseVideo(source, factory, scheduler, {
			render: frame => rendered.push({ timestamp: frame.timestamp, now: scheduler.now() }),
			clear: () => clears++,
		}));
		return { video, source, factory, scheduler, rendered, get clears() { return clears; } };
	}

	test('paces decoded frames by timestamp instead of presenting a batch synchronously', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		source.results.push(videoBatch(Array.from({ length: 5 }, (_, index) => videoFrame(index + 1, index === 0))));
		video.setVisible(true);
		await scheduler.advance(0);
		const initiallyRendered = rendered.length;
		await scheduler.advance(210);
		video.dispose();
		assert.deepStrictEqual({
			initiallyRendered,
			timestamps: rendered.map(frame => frame.timestamp),
			paced: rendered.every((frame, index) => !index || frame.now - rendered[index - 1].now >= 16),
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
			pending: scheduler.pendingCallbacks,
		}, {
			initiallyRendered: 0,
			timestamps: [0, 33333, 66666, 99999, 133332],
			paced: true,
			closedOnce: true,
			pending: 0,
		});
	});

	test('bounds encoded and decoder queues and recovers at the latest complete GOP', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.automatic = false;
		source.results.push(
			videoBatch(Array.from({ length: 60 }, (_, index) => videoFrame(index + 1, index === 0))),
			videoBatch(Array.from({ length: 8 }, (_, index) => videoFrame(index + 61, index === 4))),
		);
		video.setVisible(true);
		await scheduler.advance(50);
		video.dispose();
		assert.deepStrictEqual({
			decoded: factory.decoders.map(decoder => decoder.sequences),
			maximumQueue: Math.max(...factory.decoders.map(decoder => decoder.peakQueueSize)),
			released: factory.decoders.every(decoder => decoder.disposed),
			reads: source.peakReads,
		}, {
			decoded: [[1, 2, 3, 4], [65, 66, 67, 68]],
			maximumQueue: 4,
			released: true,
			reads: 1,
		});
	});

	test('keeps feeding hardware decoders that retain eight frames before producing output', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		factory.outputDelay = 8;
		source.results.push(
			videoBatch(Array.from({ length: 30 }, (_, index) => videoFrame(index + 1, index === 0))),
			videoBatch(Array.from({ length: 10 }, (_, index) => videoFrame(index + 31))),
		);
		video.setVisible(true);
		await scheduler.advance(400);
		video.dispose();

		assert.deepStrictEqual({
			rendered: rendered.length > 0,
			decoderCount: factory.decoders.length,
			submitted: factory.decoders[0].sequences.length,
			boundedFrames: factory.peakFrames <= 8,
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
		}, { rendered: true, decoderCount: 1, submitted: 40, boundedFrames: true, closedOnce: true });
	});

	test('bounds submissions even when the decoder never produces frames', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.outputDelay = Infinity;
		source.results.push(videoBatch(Array.from({ length: 50 }, (_, index) => videoFrame(index + 1, index === 0))));
		video.setVisible(true);
		await scheduler.advance(500);
		video.dispose();

		assert.deepStrictEqual(factory.decoders.map(decoder => ({ submitted: decoder.sequences.length, disposed: decoder.disposed })), [
			{ submitted: 32, disposed: true },
		]);
	});

	test('encoded byte pressure also recovers without feeding corrupt deltas', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.automatic = false;
		const data = 'A'.repeat(200_000);
		for (let batch = 0; batch < 4; batch++) {
			source.results.push(videoBatch(Array.from({ length: 10 }, (_, index) => ({
				...videoFrame(batch * 10 + index + 1, index === 0 && (batch === 0 || batch === 3)), data,
			}))));
		}
		video.setVisible(true);
		await scheduler.advance(150);
		assert.deepStrictEqual(factory.decoders.map(decoder => decoder.sequences), [[1, 2, 3, 4], [31, 32, 33, 34]]);
	});

	test('closes old recovery frames and bounds decoded frame ownership', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		source.results.push(videoBatch(Array.from({ length: 60 }, (_, index) => videoFrame(index + 1, index === 0))));
		video.setVisible(true);
		await scheduler.advance(230);
		video.dispose();
		assert.deepStrictEqual({
			bounded: factory.peakFrames <= 8,
			recentOnly: rendered.every(frame => frame.timestamp >= videoFrame(60).timestamp - 150_000),
			rendered: rendered.length,
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
		}, { bounded: true, recentOnly: true, rendered: 5, closedOnce: true });
	});

	test('late decoded frames cannot move presentation backwards', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		source.results.push(videoBatch([videoFrame(1, true), videoFrame(2), videoFrame(3)]));
		video.setVisible(true);
		await scheduler.advance(150);
		factory.decoders[0].emit(33333);
		await scheduler.advance(50);
		video.dispose();
		assert.deepStrictEqual({
			timestamps: rendered.map(frame => frame.timestamp),
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
		}, { timestamps: [0, 33333, 66666], closedOnce: true });
	});

	test('does not repeatedly allocate decoders while waiting for the first keyframe', async () => {
		const { video, source, factory, scheduler } = createVideo();
		source.results.push(videoBatch([]));
		video.setVisible(true);
		await scheduler.advance(500);
		assert.deepStrictEqual({
			decoders: factory.decoders.length,
			supportChecks: factory.supportChecks.length,
			reads: source.calls.length,
		}, { decoders: 0, supportChecks: 1, reads: 11 });
	});

	test('missing packets discard deltas until a fresh keyframe', async () => {
		const { video, source, factory, scheduler } = createVideo();
		source.results.push(
			videoBatch([videoFrame(1, true), videoFrame(2)]),
			videoBatch([videoFrame(4), videoFrame(5, true), videoFrame(6)]),
			videoBatch([videoFrame(8)]),
			videoBatch([videoFrame(9, true), videoFrame(10)]),
		);
		video.setVisible(true);
		await scheduler.advance(150);
		video.dispose();
		assert.deepStrictEqual({
			sequences: factory.decoders.flatMap(decoder => decoder.sequences),
			recoveryCursor: source.calls[3].cursor,
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
		}, { sequences: [1, 2, 5, 6, 9, 10], recoveryCursor: undefined, closedOnce: true });
	});

	test('a dropped batch without a keyframe requests a new GOP', async () => {
		const { video, source, factory, scheduler } = createVideo();
		source.results.push(
			videoBatch([videoFrame(1, true)]),
			videoBatch([videoFrame(2)], { dropped: true }),
			videoBatch([videoFrame(3, true)]),
		);
		video.setVisible(true);
		await scheduler.advance(100);
		assert.deepStrictEqual({
			sequences: factory.decoders.flatMap(decoder => decoder.sequences),
			cursor: source.calls[2].cursor,
		}, { sequences: [1, 3], cursor: undefined });
	});

	test('recovery from a buffered keyframe retains the accepted cursor', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.automatic = false;
		source.results.push(
			videoBatch(Array.from({ length: 30 }, (_, index) => videoFrame(index + 1, index === 0))),
			videoBatch([videoFrame(31, true), videoFrame(32)]),
			videoBatch([], { dropped: true }),
			videoBatch([]),
		);
		video.setVisible(true);
		await scheduler.advance(150);
		assert.deepStrictEqual({
			decoders: factory.decoders.map(decoder => decoder.sequences),
			cursor: source.calls[3].cursor,
		}, { decoders: [[1, 2, 3, 4], [31, 32]], cursor: { streamId: 'stream-a', after: 32 } });
	});

	test('stream and decoder configuration switches dispose old frames and decoders', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		source.results.push(
			videoBatch([videoFrame(1, true), videoFrame(2)]),
			videoBatch([videoFrame(1, true)], {
				streamId: 'stream-b',
				config: { ...testVideoConfig, codedWidth: 64, description: 'Ag==' },
				target: { app: 'Other app', windowId: 2, title: 'Other window' },
			}),
		);
		video.setVisible(true);
		await scheduler.advance(50);
		factory.decoders[0].emit(0);
		await scheduler.advance(80);
		video.dispose();
		assert.deepStrictEqual({
			configs: factory.supportChecks.map(config => config.codedWidth),
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
			decodersClosed: factory.decoders.every(decoder => decoder.disposed),
			rendered: rendered.map(frame => frame.timestamp),
			target: video.state.get().target?.title,
		}, { configs: [32, 64], closedOnce: true, decodersClosed: true, rendered: [0], target: 'Other window' });
	});

	test('changed configuration on the same stream requires a new keyframe', async () => {
		const { video, source, factory, scheduler } = createVideo();
		source.results.push(
			videoBatch([videoFrame(1, true)]),
			videoBatch([videoFrame(2)], { config: { ...testVideoConfig, description: 'Ag==' } }),
			videoBatch([videoFrame(3, true)], { config: { ...testVideoConfig, description: 'Ag==' } }),
		);
		video.setVisible(true);
		await scheduler.advance(100);
		assert.deepStrictEqual({
			sequences: factory.decoders.flatMap(decoder => decoder.sequences),
			recoveryCursor: source.calls[2].cursor,
			supportChecks: factory.supportChecks.length,
		}, { sequences: [1, 3], recoveryCursor: undefined, supportChecks: 2 });
	});

	test('pause and resume never overlap a cancelled but unresolved read', async () => {
		const { video, source, scheduler, factory } = createVideo();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		source.results.push(pending, videoBatch([videoFrame(10, true)]));
		video.setVisible(true);
		await scheduler.advance(0);
		video.pause();
		video.resume();
		await scheduler.advance(500);
		const beforeSettlement = source.calls.length;
		await pending.complete(videoBatch([videoFrame(1, true)]));
		await scheduler.advance(50);
		video.dispose();
		await scheduler.advance(500);
		assert.deepStrictEqual({
			beforeSettlement,
			reads: source.calls.length,
			peakReads: source.peakReads,
			cancelled: source.calls.every(call => call.token.isCancellationRequested),
			cursors: source.calls.map(call => call.cursor),
			sequences: factory.decoders.flatMap(decoder => decoder.sequences),
			pending: scheduler.pendingCallbacks,
		}, { beforeSettlement: 1, reads: 2, peakReads: 1, cancelled: true, cursors: [undefined, undefined], sequences: [10], pending: 0 });
	});

	test('a cancelled support check cannot override the resumed stream', async () => {
		const { video, source, factory, scheduler } = createVideo();
		const support = new DeferredPromise<boolean>();
		factory.supportGate = support;
		source.results.push(videoBatch([videoFrame(1, true)]), videoBatch([videoFrame(10, true)]));
		video.setVisible(true);
		await scheduler.advance(0);
		video.pause();
		video.resume();
		factory.supportGate = undefined;
		await support.complete(false);
		await scheduler.advance(150);
		assert.deepStrictEqual({
			status: video.state.get().status,
			sequences: factory.decoders.flatMap(decoder => decoder.sequences),
			cursors: source.calls.slice(0, 2).map(call => call.cursor),
		}, { status: 'live', sequences: [10], cursors: [undefined, undefined] });
	});

	test('hidden and disposed viewers stop all polling without stopping the agent', async () => {
		const { video, source, scheduler, factory } = createVideo();
		source.results.push(videoBatch([videoFrame(1, true)]));
		await scheduler.advance(200);
		const initiallyHidden = source.calls.length;
		video.setVisible(true);
		await scheduler.advance(0);
		video.setVisible(false);
		await scheduler.advance(200);
		const afterHide = source.calls.length;
		video.setVisible(true);
		await scheduler.advance(0);
		video.dispose();
		await scheduler.advance(200);
		assert.deepStrictEqual({
			initiallyHidden, afterHide,
			finalReads: source.calls.length,
			stops: source.stopCalls,
			cursors: source.calls.map(call => call.cursor),
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
			pending: scheduler.pendingCallbacks,
		}, { initiallyHidden: 0, afterHide: 1, finalReads: 2, stops: 0, cursors: [undefined, undefined], closedOnce: true, pending: 0 });
	});

	test('pausing releases queued frames while retaining only the rendered canvas', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true), videoFrame(2), videoFrame(3)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(70);
		const clearsBeforePause = setup.clears;
		setup.video.pause();
		await setup.scheduler.advance(500);
		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			clearedOnPause: setup.clears !== clearsBeforePause,
			rendered: setup.rendered.length,
			closedOnce: setup.factory.frames.every(frame => frame.closeCount === 1),
			decodersClosed: setup.factory.decoders.every(decoder => decoder.disposed),
			stops: setup.source.stopCalls,
		}, { status: 'paused', clearedOnPause: false, rendered: 1, closedOnce: true, decodersClosed: true, stops: 0 });
	});

	test('Stop Agent works while paused and does not wait for video reads', async () => {
		const { video, source, scheduler } = createVideo();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		source.results.push(pending);
		video.setVisible(true);
		await scheduler.advance(0);
		video.pause();
		await video.stopAgent();
		await pending.complete(videoBatch([]));
		await scheduler.advance(100);
		assert.deepStrictEqual({
			stops: source.stopCalls,
			stopState: video.stopState.get().status,
			status: video.state.get().status,
			reads: source.calls.length,
		}, { stops: 1, stopState: 'stopped', status: 'stopped', reads: 1 });
	});

	test('an unreachable host is never reported as stopped and can be retried', async () => {
		const { video, source } = createVideo();
		source.stopError = new Error('Host disconnected');
		video.pause();
		await video.stopAgent();
		const failure = video.stopState.get();
		const viewingAfterFailure = video.state.get().status;
		source.stopError = undefined;
		await video.stopAgent();
		assert.deepStrictEqual({
			failed: failure.status,
			disclosesRunning: failure.message?.includes('may still be running'),
			viewingAfterFailure,
			retried: source.stopCalls,
			finalState: video.stopState.get().status,
		}, { failed: 'error', disclosesRunning: true, viewingAfterFailure: 'paused', retried: 2, finalState: 'stopped' });
	});

	test('unavailable WebCodecs does not start a video request', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.available = false;
		video.setVisible(true);
		await scheduler.advance(500);
		assert.deepStrictEqual({
			status: video.state.get().status,
			reads: source.calls.length,
			decoders: factory.decoders.length,
		}, { status: 'unsupported', reads: 0, decoders: 0 });
	});

	test('an unsupported H264 configuration is shown instead of a fake live preview', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		factory.supported = false;
		source.results.push(videoBatch([videoFrame(1, true)]));
		video.setVisible(true);
		await scheduler.advance(500);
		assert.deepStrictEqual({
			status: video.state.get().status,
			reads: source.calls.length,
			decoders: factory.decoders.length,
			rendered: rendered.length,
		}, { status: 'unsupported', reads: 1, decoders: 0, rendered: 0 });
	});

	test('permission errors blank the old target and halt reads', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(70);
		const before = setup.clears;
		setup.source.results.push({ version: 1, status: 'permissionRequired' });
		await setup.scheduler.advance(500);
		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			blanked: setup.clears > before,
			target: setup.video.state.get().target,
			reads: setup.source.calls.length,
			released: setup.factory.frames.every(frame => frame.closeCount === 1),
		}, { status: 'permissionRequired', blanked: true, target: undefined, reads: 3, released: true });
	});

	test('a stalled read cannot leave an old frame marked live indefinitely', async () => {
		const { video, source, scheduler } = createVideo();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		source.results.push(videoBatch([videoFrame(1, true)]), pending);
		video.setVisible(true);
		await scheduler.advance(2200);
		const result = {
			status: video.state.get().status,
			stale: video.state.get().message.includes('not live'),
			reads: source.calls.length,
			peakReads: source.peakReads,
		};
		video.dispose();
		await pending.complete(videoBatch([]));
		assert.deepStrictEqual(result, { status: 'starting', stale: true, reads: 2, peakReads: 1 });
	});

	test('decoder errors release frames and stop polling', async () => {
		const { video, source, factory, scheduler } = createVideo();
		source.results.push(videoBatch([videoFrame(1, true), videoFrame(2)]));
		video.setVisible(true);
		await scheduler.advance(0);
		factory.decoders[0].error(new Error('Decode failed'));
		factory.decoders[0].emit(33333);
		await scheduler.advance(500);
		assert.deepStrictEqual({
			status: video.state.get().status,
			reads: source.calls.length,
			closedOnce: factory.frames.every(frame => frame.closeCount === 1),
			pending: scheduler.pendingCallbacks,
		}, { status: 'error', reads: 1, closedOnce: true, pending: 0 });
	});
});
