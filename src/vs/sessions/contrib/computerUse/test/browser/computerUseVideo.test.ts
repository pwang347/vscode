/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IComputerUseVideoBatch, IComputerUseVideoCursor, IComputerUseVideoFocus, ISessionComputerUseVideoSource } from '../../../../services/sessions/common/computerUse.js';
import { ComputerUseVideo } from '../../browser/computerUseVideo.js';
import { TestVideoDecoderFactory, TestVideoScheduler, TestVideoSource, testVideoConfig, videoBatch, videoFrame } from './computerUseTestUtils.js';

suite('ComputerUseVideo', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createVideo() {
		const source = store.add(new TestVideoSource());
		const factory = new TestVideoDecoderFactory();
		const scheduler = new TestVideoScheduler();
		const rendered: { timestamp: number; now: number; focus?: IComputerUseVideoFocus }[] = [];
		let clears = 0;
		const video = store.add(new ComputerUseVideo(source, factory, scheduler, {
			render: (frame, focus) => rendered.push({ timestamp: frame.timestamp, now: scheduler.now(), focus }),
			clear: () => clears++,
		}));
		return { video, source, factory, scheduler, rendered, get clears() { return clears; } };
	}

	function videoError(message: string): IComputerUseVideoBatch {
		return { version: 1, status: 'error', message };
	}

	class JitterVideoSource extends Disposable implements ISessionComputerUseVideoSource {
		readonly hostLabel = 'Remote host';
		readonly reads: { startedAt: number; completedAt: number }[] = [];
		private delayIndex = 0;

		constructor(
			private readonly scheduler: TestVideoScheduler,
			private readonly delays: readonly number[],
		) {
			super();
		}

		async read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch> {
			const startedAt = this.scheduler.now();
			const response = new DeferredPromise<IComputerUseVideoBatch>();
			const delay = this.delays[this.delayIndex++ % this.delays.length];
			const scheduled = this.scheduler.schedule(() => {
				if (token.isCancellationRequested) {
					void response.error(new CancellationError());
					return;
				}
				const completedAt = this.scheduler.now();
				const lastSequence = Math.max(1, Math.floor(completedAt * 30 / 1000));
				const firstSequence = Math.max(1, (cursor?.after ?? 0) + 1);
				this.reads.push({ startedAt, completedAt });
				void response.complete(videoBatch(Array.from(
					{ length: Math.max(0, lastSequence - firstSequence + 1) },
					(_, index) => videoFrame(firstSequence + index, true),
				)));
			}, delay);
			const cancelled = token.onCancellationRequested(() => {
				scheduled.dispose();
				void response.error(new CancellationError());
			});
			try {
				return await response.p;
			} finally {
				scheduled.dispose();
				cancelled.dispose();
			}
		}

		async stop(): Promise<void> { }
	}

	test('buffers bounded remote jitter without recurring playback stalls', async () => {
		const scheduler = new TestVideoScheduler();
		const source = store.add(new JitterVideoSource(scheduler, [20, 20, 180, 20, 20, 20]));
		const factory = new TestVideoDecoderFactory();
		const rendered: { timestamp: number; now: number }[] = [];
		const video = store.add(new ComputerUseVideo(source, factory, scheduler, {
			render: frame => rendered.push({ timestamp: frame.timestamp, now: scheduler.now() }),
			clear: () => { },
		}));
		video.setVisible(true);
		await scheduler.advance(3000);
		const gaps = rendered.slice(1).map((frame, index) => frame.now - rendered[index].now);
		const result = {
			startupMs: rendered[0]?.now,
			maximumGapMs: Math.max(...gaps),
			stallsOver66Ms: gaps.filter(gap => gap > 66).length,
			readIntervals: source.reads.slice(1).map((read, index) => read.startedAt - source.reads[index].startedAt).slice(0, 6),
			boundedFrames: factory.peakFrames <= 8,
		};
		video.setVisible(false);
		await scheduler.advance(0);
		assert.deepStrictEqual(result, {
			startupMs: 228,
			maximumGapMs: 62,
			stallsOver66Ms: 0,
			readIntervals: [50, 50, 180, 50, 50, 50],
			boundedFrames: true,
		});
	});

	test('does not add polling delay after a sustained slow response', async () => {
		const scheduler = new TestVideoScheduler();
		const source = store.add(new JitterVideoSource(scheduler, [120]));
		const factory = new TestVideoDecoderFactory();
		const rendered: { timestamp: number; now: number }[] = [];
		const video = store.add(new ComputerUseVideo(source, factory, scheduler, {
			render: frame => rendered.push({ timestamp: frame.timestamp, now: scheduler.now() }),
			clear: () => { },
		}));
		video.setVisible(true);
		await scheduler.advance(2000);
		const gaps = rendered.slice(1).map((frame, index) => frame.now - rendered[index].now);
		const result = {
			startupMs: rendered[0]?.now,
			maximumGapMs: Math.max(...gaps),
			readIntervals: source.reads.slice(1).map((read, index) => read.startedAt - source.reads[index].startedAt).slice(0, 6),
			boundedFrames: factory.peakFrames <= 8,
		};
		video.setVisible(false);
		await scheduler.advance(0);
		assert.deepStrictEqual(result, {
			startupMs: 328,
			maximumGapMs: 48,
			readIntervals: [120, 120, 120, 120, 120, 120],
			boundedFrames: true,
		});
	});

	test('resumes smoothly after transport jitter exceeds the bounded playout delay', async () => {
		const scheduler = new TestVideoScheduler();
		const source = store.add(new JitterVideoSource(scheduler, [20, 20, 300, ...Array(57).fill(20)]));
		const factory = new TestVideoDecoderFactory();
		const rendered: { timestamp: number; now: number }[] = [];
		const video = store.add(new ComputerUseVideo(source, factory, scheduler, {
			render: frame => rendered.push({ timestamp: frame.timestamp, now: scheduler.now() }),
			clear: () => { },
		}));
		video.setVisible(true);
		await scheduler.advance(3000);
		const gaps = rendered.slice(1).map((frame, index) => frame.now - rendered[index].now);
		const result = {
			outageDidNotCompound: Math.max(...gaps) < 300,
			resumedSmoothly: gaps.slice(-10).every(gap => gap <= 66),
			framesAdvancedAfterBurst: (rendered.at(-1)?.timestamp ?? 0) > 2_500_000,
			readIntervals: source.reads.slice(1).map((read, index) => read.startedAt - source.reads[index].startedAt).slice(0, 6),
			boundedFrames: factory.peakFrames <= 8,
		};
		video.setVisible(false);
		await scheduler.advance(0);
		assert.deepStrictEqual(result, {
			outageDidNotCompound: true,
			resumedSmoothly: true,
			framesAdvancedAfterBurst: true,
			readIntervals: [50, 50, 300, 50, 50, 50],
			boundedFrames: true,
		});
	});

	test('reports buffering during a slow read without clearing the last frame', async () => {
		const setup = createVideo();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		setup.source.results.push(videoBatch([videoFrame(1, true)]), pending);
		setup.video.setVisible(true);
		await setup.scheduler.advance(310);
		const buffering = {
			status: setup.video.state.get().status,
			message: setup.video.state.get().message,
			rendered: setup.rendered.length,
			clears: setup.clears,
		};
		await pending.complete(videoBatch([]));
		await setup.scheduler.advance(0);
		assert.deepStrictEqual({
			buffering,
			resumed: {
				status: setup.video.state.get().status,
				message: setup.video.state.get().message,
				rendered: setup.rendered.length,
				clears: setup.clears,
			},
		}, {
			buffering: {
				status: 'starting',
				message: 'Buffering live video… The last frame is not live.',
				rendered: 1,
				clears: 1,
			},
			resumed: {
				status: 'live',
				message: 'Live',
				rendered: 1,
				clears: 1,
			},
		});
	});

	test('retains the last received frame after completion, including hardware-buffered output', async () => {
		const setup = createVideo();
		setup.factory.outputDelay = 8;
		setup.source.results.push(
			videoBatch(Array.from({ length: 12 }, (_, index) => videoFrame(index + 1, index === 0))),
			{ version: 1, status: 'idle' },
		);
		setup.video.setVisible(true);
		await setup.scheduler.advance(500);
		assert.deepStrictEqual({
			lastFrame: setup.rendered.at(-1)?.timestamp,
			status: setup.video.state.get().status,
			retained: setup.video.state.get().retainedFrame,
			target: setup.video.state.get().target?.title,
			clears: setup.clears,
			decodersDisposed: setup.factory.decoders.every(decoder => decoder.disposed),
			framesClosed: setup.factory.frames.every(frame => frame.closeCount === 1),
		}, {
			lastFrame: videoFrame(12).timestamp, status: 'idle', retained: true, target: 'Example window',
			clears: 1, decodersDisposed: true, framesClosed: true,
		});
	});

	test('completion drains a bounded encoded backlog to the final frame', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		factory.outputDelay = 8;
		source.results.push(
			videoBatch(Array.from({ length: 30 }, (_, index) => videoFrame(index + 1, index === 0))),
			videoBatch(Array.from({ length: 30 }, (_, index) => videoFrame(index + 31))),
			{ version: 1, status: 'idle' },
		);
		video.setVisible(true);
		await scheduler.advance(50);
		const hadBacklog = factory.decoders[0].sequences.length < 60;
		await scheduler.advance(500);
		assert.deepStrictEqual({
			hadBacklog,
			lastFrame: rendered.at(-1)?.timestamp,
			submitted: factory.decoders[0].sequences.length,
			flushes: factory.decoders[0].flushCalls,
			bounded: factory.peakFrames <= 8,
		}, { hadBacklog: true, lastFrame: videoFrame(60).timestamp, submitted: 60, flushes: 1, bounded: true });
	});

	test('permission loss clears a previously retained completed frame', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]), { version: 1, status: 'idle' });
		setup.video.setVisible(true);
		await setup.scheduler.advance(100);
		const retained = setup.video.state.get().retainedFrame;
		setup.source.results.push({ version: 1, status: 'permissionRequired', message: 'Permission revoked' });
		await setup.scheduler.advance(300);
		assert.deepStrictEqual({
			retained,
			status: setup.video.state.get().status,
			retainedAfterRevocation: !!setup.video.state.get().retainedFrame,
			cleared: setup.clears > 1,
		}, { retained: true, status: 'permissionRequired', retainedAfterRevocation: false, cleared: true });
	});

	test('Stop Agent does not wait for a pending final-frame flush', async () => {
		const { video, source, factory, scheduler } = createVideo();
		const gate = new DeferredPromise<void>();
		factory.flushGate = gate;
		source.results.push(videoBatch([videoFrame(1, true)]), { version: 1, status: 'idle' });
		video.setVisible(true);
		await scheduler.advance(100);
		await video.stopAgent();
		const status = video.state.get().status;
		await gate.complete();
		await scheduler.advance(0);
		assert.deepStrictEqual({ status, afterFlush: video.state.get().status, stops: source.stopCalls }, {
			status: 'stopped', afterFlush: 'stopped', stops: 1,
		});
	});

	test('final-frame decoding errors are explicit rather than a successful completion', async () => {
		const { video, source, factory, scheduler } = createVideo();
		factory.flushError = new Error('Final frame decoding failed');
		source.results.push(videoBatch([videoFrame(1, true)]), { version: 1, status: 'idle' });
		video.setVisible(true);
		await scheduler.advance(100);
		assert.deepStrictEqual({
			status: video.state.get().status,
			error: video.state.get().message.includes('Final frame decoding failed'),
			retained: !!video.state.get().retainedFrame,
		}, { status: 'error', error: true, retained: false });
	});

	test('presents the action focus associated with each delayed decoded frame', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		factory.automatic = false;
		source.results.push(videoBatch([
			{ ...videoFrame(1, true), focus: { x: 0.25, y: 0.75 } },
			{ ...videoFrame(2), focus: { x: 0.75, y: 0.25 } },
			videoFrame(3),
		]));
		video.setVisible(true);
		await scheduler.advance(0);
		for (let index = 0; index < 3; index++) {
			factory.decoders[0].releaseOne();
		}
		await scheduler.advance(320);
		assert.deepStrictEqual(rendered.map(({ timestamp, focus }) => ({ timestamp, focus })), [
			{ timestamp: 0, focus: { x: 0.25, y: 0.75 } },
			{ timestamp: 33333, focus: { x: 0.75, y: 0.25 } },
			{ timestamp: 66666, focus: undefined },
		]);
	});

	test('does not reuse action focus when a new window reuses video timestamps', async () => {
		const { video, source, scheduler, rendered } = createVideo();
		source.results.push(videoBatch([{ ...videoFrame(1, true), focus: { x: 0.75, y: 0.25 } }]));
		video.setVisible(true);
		await scheduler.advance(230);
		source.results.push(videoBatch([videoFrame(1, true)], {
			streamId: 'stream-b', target: { app: 'Agent Browser', windowId: 2, title: 'Other window' },
		}));
		await scheduler.advance(250);
		assert.deepStrictEqual(rendered.map(frame => frame.focus), [{ x: 0.75, y: 0.25 }, undefined]);
	});

	test('paces decoded frames by timestamp instead of presenting a batch synchronously', async () => {
		const { video, source, factory, scheduler, rendered } = createVideo();
		source.results.push(videoBatch(Array.from({ length: 5 }, (_, index) => videoFrame(index + 1, index === 0))));
		video.setVisible(true);
		await scheduler.advance(0);
		const initiallyRendered = rendered.length;
		await scheduler.advance(350);
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
		await scheduler.advance(400);
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
		await scheduler.advance(250);
		factory.decoders[0].emit(33333);
		await scheduler.advance(100);
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
		}, { configs: [32, 64], closedOnce: true, decodersClosed: true, rendered: [], target: 'Other window' });
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
		await scheduler.advance(0);
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
		await scheduler.advance(300);
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
		await setup.scheduler.advance(230);
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

	test('resume keeps the frozen frame and only shows buffering after a real delay', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		setup.video.pause();
		const clearsBeforeResume = setup.clears;

		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		setup.source.results.push({ version: 1, status: 'starting' }, pending);
		const readsBeforeResume = setup.source.calls.length;
		setup.video.resume();
		const resuming = setup.video.state.get();
		await setup.scheduler.advance(249);
		const beforeDelay = setup.video.state.get();
		await setup.scheduler.advance(1);
		const delayed = setup.video.state.get();

		await pending.complete(videoBatch([videoFrame(1, true)], { streamId: 'stream-b' }));
		await setup.scheduler.advance(230);
		const resumed = setup.video.state.get();

		assert.deepStrictEqual({
			resuming: { status: resuming.status, phase: resuming.phase, message: resuming.message },
			beforeDelay: { status: beforeDelay.status, phase: beforeDelay.phase },
			delayed: { status: delayed.status, phase: delayed.phase, message: delayed.message },
			resumed: { status: resumed.status, phase: resumed.phase, message: resumed.message },
			clearedOnResume: setup.clears !== clearsBeforeResume,
			usedFreshCursor: setup.source.calls[readsBeforeResume]?.cursor,
		}, {
			resuming: { status: 'starting', phase: 'resuming', message: 'Resuming live video…' },
			beforeDelay: { status: 'starting', phase: 'resuming' },
			delayed: { status: 'starting', phase: 'buffering', message: 'Buffering live video… The last frame is not live.' },
			resumed: { status: 'live', phase: undefined, message: 'Live' },
			clearedOnResume: false,
			usedFreshCursor: undefined,
		});
	});

	test('recording seek restarts decoding from a fresh cursor', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(300);
		const readsBeforeSeek = setup.source.calls.length;
		setup.source.results.push(videoBatch([{ ...videoFrame(2, true), timestamp: 2_000_000 }]));
		setup.video.seek(2000);
		await setup.scheduler.advance(300);

		assert.deepStrictEqual({
			seekCursor: setup.source.calls[readsBeforeSeek].cursor,
			decoders: setup.factory.decoders.length,
			firstDecoderDisposed: setup.factory.decoders[0].disposed,
			rendered: setup.rendered.map(frame => frame.timestamp),
			position: setup.source.recordingPositionMs.get(),
		}, {
			seekCursor: undefined,
			decoders: 2,
			firstDecoderDisposed: true,
			rendered: [0, 2_000_000],
			position: 2000,
		});
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

	test('a transient host error retains the last frame and reconnects with a fresh cursor', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const readsBeforeError = setup.source.calls.length;
		const clearsBeforeError = setup.clears;
		setup.source.results.push(
			videoError('native video request timed out'),
			videoBatch([videoFrame(1, true)], {
				streamId: 'stream-b',
				config: { ...testVideoConfig, description: 'Ag==' },
			}),
		);
		await setup.scheduler.advance(100);
		const awaitingReplacement = {
			status: setup.video.state.get().status,
			rendered: setup.rendered.length,
			clears: setup.clears,
		};
		await setup.scheduler.advance(500);

		assert.deepStrictEqual({
			awaitingReplacement,
			status: setup.video.state.get().status,
			rendered: setup.rendered.length,
			cursors: setup.source.calls.slice(readsBeforeError, readsBeforeError + 2).map(call => call.cursor),
			clears: setup.clears,
		}, {
			awaitingReplacement: { status: 'starting', rendered: 1, clears: clearsBeforeError },
			status: 'live',
			rendered: 2,
			cursors: [{ streamId: 'stream-a', after: 1 }, undefined],
			clears: clearsBeforeError,
		});
	});

	test('a transient initial host error reconnects before any frame has rendered', async () => {
		const setup = createVideo();
		setup.source.results.push(
			videoError('native video request timed out'),
			videoBatch([videoFrame(1, true)]),
		);
		setup.video.setVisible(true);
		await setup.scheduler.advance(500);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			rendered: setup.rendered.length,
			cursors: setup.source.calls.slice(0, 2).map(call => call.cursor),
		}, {
			status: 'live',
			rendered: 1,
			cursors: [undefined, undefined],
		});
	});

	test('persistent initial host errors stop after the reconnect timeout', async () => {
		const setup = createVideo();
		setup.source.results.push(
			...Array.from({ length: 3 }, () => videoError('native video request timed out')),
		);
		setup.video.setVisible(true);
		await setup.scheduler.advance(5500);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			message: setup.video.state.get().message,
			reads: setup.source.calls.length,
			rendered: setup.rendered.length,
		}, {
			status: 'error',
			message: 'native video request timed out',
			reads: 21,
			rendered: 0,
		});
	});

	test('a reconnect clears the rendered frame immediately when the target changes', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const clearsBeforeError = setup.clears;
		setup.source.results.push(
			videoError('native video request timed out'),
			videoBatch([videoFrame(1, true)], {
				streamId: 'stream-b',
				target: { app: 'Other app', windowId: 2, title: 'Other window' },
			}),
		);
		await setup.scheduler.advance(300);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			rendered: setup.rendered.length,
			cleared: setup.clears > clearsBeforeError,
			target: setup.video.state.get().target,
		}, {
			status: 'starting',
			rendered: 1,
			cleared: true,
			target: { app: 'Other app', windowId: 2, title: 'Other window' },
		});
	});

	test('recovers when the video resource is temporarily missing during a target change', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		setup.source.results.push(
			...Array.from({ length: 3 }, () => new Error('Computer Use video does not exist')),
			videoBatch([videoFrame(1, true)], {
				streamId: 'stream-b',
				target: { app: 'Other app', windowId: 2, title: 'Other window' },
			}),
		);
		const readsBeforeTransition = setup.source.calls.length;
		await setup.scheduler.advance(1000);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			message: setup.video.state.get().message,
			rendered: setup.rendered.length,
			target: setup.video.state.get().target,
			cursors: setup.source.calls.slice(readsBeforeTransition, readsBeforeTransition + 4).map(call => call.cursor),
		}, {
			status: 'live',
			message: 'Live',
			rendered: 2,
			target: { app: 'Other app', windowId: 2, title: 'Other window' },
			cursors: [{ streamId: 'stream-a', after: 1 }, undefined, undefined, undefined],
		});
	});

	test('retains the last frame while waiting for a replacement authorized window', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const clearsBeforeTransition = setup.clears;
		setup.source.results.push({
			version: 1,
			status: 'starting',
			message: 'Waiting for the agent to select another application window.',
		});
		await setup.scheduler.advance(7000);
		const transition = {
			status: setup.video.state.get().status,
			message: setup.video.state.get().message,
			retained: setup.clears === clearsBeforeTransition,
			rendered: setup.rendered.length,
		};
		setup.source.results.push(videoBatch([videoFrame(1, true)], {
			streamId: 'stream-b',
			target: { app: 'Other app', windowId: 2, title: 'Other window' },
		}));
		await setup.scheduler.advance(300);

		assert.deepStrictEqual({
			transition,
			recovered: {
				status: setup.video.state.get().status,
				target: setup.video.state.get().target,
				rendered: setup.rendered.length,
			},
		}, {
			transition: {
				status: 'starting',
				message: 'Waiting for the agent to select another application window. The last frame is not live.',
				retained: true,
				rendered: 1,
			},
			recovered: {
				status: 'live',
				target: { app: 'Other app', windowId: 2, title: 'Other window' },
				rendered: 2,
			},
		});
	});

	test('retains the last frame while a same-target stream synchronizes', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const clearsBeforeSynchronization = setup.clears;
		setup.source.results.push(videoBatch([], { streamId: 'stream-b' }));
		await setup.scheduler.advance(100);
		const synchronizing = {
			status: setup.video.state.get().status,
			phase: setup.video.state.get().phase,
			message: setup.video.state.get().message,
			retained: setup.clears === clearsBeforeSynchronization,
			rendered: setup.rendered.length,
		};
		setup.source.results.push(videoBatch([videoFrame(1, true)], { streamId: 'stream-b' }));
		await setup.scheduler.advance(300);

		assert.deepStrictEqual({
			synchronizing,
			recovered: {
				status: setup.video.state.get().status,
				rendered: setup.rendered.length,
			},
		}, {
			synchronizing: {
				status: 'starting',
				phase: 'buffering',
				message: 'Synchronizing live video. Any previous frame is not live.',
				retained: true,
				rendered: 1,
			},
			recovered: {
				status: 'live',
				rendered: 2,
			},
		});
	});

	test('persistent host errors become terminal after the reconnect timeout', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const readsBeforeError = setup.source.calls.length;
		setup.source.results.push(
			...Array.from({ length: 3 }, () => videoError('native video request timed out')),
		);
		await setup.scheduler.advance(7000);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			message: setup.video.state.get().message,
			errorReads: setup.source.calls.length - readsBeforeError,
			cleared: setup.clears > 2,
		}, {
			status: 'error',
			message: 'native video request timed out',
			errorReads: 21,
			cleared: true,
		});
	});

	test('Stop Agent during host reconnect cancels further reads', async () => {
		const setup = createVideo();
		setup.source.results.push(videoBatch([videoFrame(1, true)]));
		setup.video.setVisible(true);
		await setup.scheduler.advance(230);
		const readsBeforeError = setup.source.calls.length;
		setup.source.results.push(
			videoError('native video request timed out'),
			videoBatch([videoFrame(1, true)], { streamId: 'stream-b' }),
		);
		await setup.scheduler.advance(30);
		await setup.video.stopAgent();
		await setup.scheduler.advance(500);

		assert.deepStrictEqual({
			status: setup.video.state.get().status,
			stopState: setup.video.stopState.get().status,
			reconnectReads: setup.source.calls.length - readsBeforeError,
		}, {
			status: 'stopped',
			stopState: 'stopped',
			reconnectReads: 1,
		});
	});

	test('a stalled read cannot leave an old frame marked live indefinitely', async () => {
		const { video, source, scheduler } = createVideo();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		source.results.push(videoBatch([videoFrame(1, true)]), pending);
		video.setVisible(true);
		await scheduler.advance(2300);
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
