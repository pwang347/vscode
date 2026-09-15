/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../base/common/async.js';
import { Disposable, type IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import type { ComputerUseRecordingActionKind, ComputerUseRecordingGapReason, IComputerUseRecordingThought } from '../../../common/computerUseRecording.js';
import { type ComputerUseRecordingStore, type IComputerUseRecordingFinalization } from './computerUseRecordingStore.js';
import { COMPUTER_USE_VIDEO_RESOURCE, type IComputerUseVideoBatch, type IComputerUseVideoCursor, parseComputerUseVideoResource } from './computerUseVideoResource.js';

export const COMPUTER_USE_RECORDING_POLL_INTERVAL_MS = 250;
export const COMPUTER_USE_RECORDING_READ_TIMEOUT_MS = 5000;

export interface IComputerUseRecordingScheduler {
	now(): number;
	schedule(callback: () => void | Promise<void>, delay: number): IDisposable;
}

export const systemComputerUseRecordingScheduler: IComputerUseRecordingScheduler = {
	now: () => Date.now(),
	schedule: (callback, delay) => disposableTimeout(() => { void callback(); }, delay),
};

interface IComputerUseTurnRecorderOptions {
	readonly scheduler: IComputerUseRecordingScheduler;
	readonly pollIntervalMs?: number;
	readonly readTimeoutMs?: number;
	readonly readResource: (uri: string) => Promise<unknown>;
	readonly onFirstFramePersisted?: () => void;
}

type ReadOutcome =
	| { readonly kind: 'result'; readonly value: unknown }
	| { readonly kind: 'error' }
	| { readonly kind: 'timeout' };

interface ITimedOutRead {
	outcome: Exclude<ReadOutcome, { kind: 'timeout' }> | undefined;
}

interface IPendingGap {
	readonly reason: ComputerUseRecordingGapReason;
	durationMs: number;
}

/** Polls one exact chat/turn stream until stopped and finalizes its local store. */
export class ComputerUseTurnRecorder extends Disposable {
	private readonly _scheduledPoll = this._register(new MutableDisposable<IDisposable>());
	private readonly _pollIntervalMs: number;
	private readonly _readTimeoutMs: number;
	private _cursor: IComputerUseVideoCursor | undefined;
	private _started = false;
	private _startedAt: number | undefined;
	private _lastThoughtTimeMs = 0;
	private _lastActionTimeMs = 0;
	private _stopping = false;
	private _nextPollAt = 0;
	private _pollPromise: Promise<void> | undefined;
	private _stopPromise: Promise<IComputerUseRecordingFinalization | undefined> | undefined;
	private _timedOutRead: ITimedOutRead | undefined;
	private _pendingGap: IPendingGap | undefined;
	private _firstFramePersisted = false;
	private _failure: Error | undefined;

	constructor(
		private readonly _recordingStore: ComputerUseRecordingStore,
		private readonly _options: IComputerUseTurnRecorderOptions,
	) {
		super();
		this._pollIntervalMs = _options.pollIntervalMs ?? COMPUTER_USE_RECORDING_POLL_INTERVAL_MS;
		this._readTimeoutMs = _options.readTimeoutMs ?? COMPUTER_USE_RECORDING_READ_TIMEOUT_MS;
		if (!Number.isSafeInteger(this._pollIntervalMs) || this._pollIntervalMs < 1
			|| !Number.isSafeInteger(this._readTimeoutMs) || this._readTimeoutMs < this._pollIntervalMs) {
			throw new Error('Invalid Computer Use recording polling cadence.');
		}
	}

	start(): void {
		if (this._started || this._stopping) {
			return;
		}
		this._started = true;
		this._startedAt = this._options.scheduler.now();
		this._nextPollAt = this._startedAt;
		this._schedulePoll();
	}

	recordThought(thought: Omit<IComputerUseRecordingThought, 'timeMs'>): void {
		if (this._startedAt === undefined || this._stopping) {
			return;
		}
		const timeMs = Math.max(this._lastThoughtTimeMs, Math.round(this._options.scheduler.now() - this._startedAt));
		this._recordingStore.recordThought({ timeMs, ...thought });
		this._lastThoughtTimeMs = timeMs;
	}

	recordAction(kind: ComputerUseRecordingActionKind, occurredAt = this._options.scheduler.now()): void {
		if (this._startedAt === undefined || this._stopping) {
			return;
		}
		const timeMs = Math.max(this._lastActionTimeMs, Math.round(occurredAt - this._startedAt));
		this._recordingStore.recordAction({ timeMs, kind });
		this._lastActionTimeMs = timeMs;
	}

	stop(): Promise<IComputerUseRecordingFinalization | undefined> {
		if (!this._stopPromise) {
			this._stopPromise = this._stop();
		}
		return this._stopPromise;
	}

	private async _stop(): Promise<IComputerUseRecordingFinalization | undefined> {
		this._stopping = true;
		this._scheduledPoll.clear();
		await this._pollPromise;
		await this._flushPendingGap();
		const result = await this._recordingStore.finalize();
		this._notifyFirstFramePersisted();
		if (this._failure) {
			throw this._failure;
		}
		return result;
	}

	private _schedulePoll(): void {
		if (this._stopping || this._failure) {
			return;
		}
		const delay = Math.max(0, this._nextPollAt - this._options.scheduler.now());
		this._scheduledPoll.value = this._options.scheduler.schedule(async () => {
			const promise = this._poll();
			this._pollPromise = promise;
			try {
				await promise;
			} finally {
				if (this._pollPromise === promise) {
					this._pollPromise = undefined;
				}
			}
		}, delay);
	}

	private async _poll(): Promise<void> {
		this._nextPollAt += this._pollIntervalMs;
		try {
			const outcome = await this._read();
			switch (outcome.kind) {
				case 'result':
					await this._acceptBatch(parseComputerUseVideoResource(outcome.value));
					break;
				case 'error':
				this._addGap('readError');
					break;
				case 'timeout':
					this._addGap('readError');
					break;
			}
		} catch (error) {
			if (error instanceof Error && /^Invalid|^Missing|^Unsupported/.test(error.message)) {
				this._addGap('invalidResource');
			} else {
				this._failure = error instanceof Error ? error : new Error(String(error));
			}
		}
		while (this._nextPollAt < this._options.scheduler.now()) {
			this._nextPollAt += this._pollIntervalMs;
		}
		this._schedulePoll();
	}

	private async _read(): Promise<ReadOutcome> {
		if (this._timedOutRead) {
			if (!this._timedOutRead.outcome) {
				return { kind: 'timeout' };
			}
			const outcome = this._timedOutRead.outcome;
			this._timedOutRead = undefined;
			return outcome;
		}

		const uri = this._cursor
			? `${COMPUTER_USE_VIDEO_RESOURCE}?streamId=${encodeURIComponent(this._cursor.streamId)}&after=${this._cursor.after}`
			: COMPUTER_USE_VIDEO_RESOURCE;
		const pending: ITimedOutRead = { outcome: undefined };
		const read: Promise<Exclude<ReadOutcome, { kind: 'timeout' }>> = Promise.resolve()
			.then(() => this._options.readResource(uri))
			.then<Exclude<ReadOutcome, { kind: 'timeout' }>, Exclude<ReadOutcome, { kind: 'timeout' }>>(
				value => ({ kind: 'result', value }),
				() => ({ kind: 'error' }),
			);
		void read.then(outcome => pending.outcome = outcome);
		let timeout: IDisposable | undefined;
		const timed = new Promise<ReadOutcome>(resolve => {
			timeout = this._options.scheduler.schedule(() => resolve({ kind: 'timeout' }), this._readTimeoutMs);
		});
		const outcome = await Promise.race([read, timed]);
		timeout?.dispose();
		if (outcome.kind === 'timeout') {
			this._timedOutRead = pending;
		}
		return outcome;
	}

	private async _acceptBatch(batch: IComputerUseVideoBatch): Promise<void> {
		if (batch.status !== 'live' || !batch.streamId || !batch.target || !batch.config) {
			this._cursor = undefined;
			this._addGap('invalidResource');
			return;
		}

		await this._flushPendingGap();
		const sameStream = !this._cursor || this._cursor.streamId === batch.streamId;
		let frames = batch.frames.filter(frame => !sameStream || !this._cursor || frame.sequence > this._cursor.after);
		let gapIndex = -1;
		let previousSequence = sameStream ? this._cursor?.after ?? 0 : 0;
		for (let index = 0; index < frames.length; index++) {
			if (previousSequence > 0 && frames[index].sequence !== previousSequence + 1) {
				gapIndex = index;
			}
			previousSequence = frames[index].sequence;
		}
		const gapReason: ComputerUseRecordingGapReason | undefined = !sameStream || gapIndex >= 0
			? 'cursorReset'
			: batch.dropped ? 'droppedFrames' : undefined;
		if (gapReason) {
			this._addGap(gapReason);
			await this._flushPendingGap();
			const candidates = gapIndex >= 0 ? frames.slice(gapIndex) : frames;
			const keyFrameIndex = candidates.findLastIndex(frame => frame.keyFrame);
			frames = keyFrameIndex < 0 ? [] : candidates.slice(keyFrameIndex);
			this._cursor = undefined;
		}
		if (frames.length > 0) {
			await this._recordingStore.appendFrames({
				streamId: batch.streamId,
				target: batch.target,
				config: batch.config,
				frames,
			});
			this._notifyFirstFramePersisted();
		}
		const lastFrame = frames.at(-1);
		if (lastFrame) {
			this._cursor = { streamId: batch.streamId, after: lastFrame.sequence };
		}
	}

	private _addGap(reason: ComputerUseRecordingGapReason): void {
		if (this._pendingGap?.reason === reason) {
			this._pendingGap.durationMs += this._pollIntervalMs;
		} else {
			this._pendingGap = { reason, durationMs: this._pollIntervalMs };
		}
	}

	private async _flushPendingGap(): Promise<void> {
		const gap = this._pendingGap;
		this._pendingGap = undefined;
		if (gap) {
			await this._recordingStore.recordGap(gap.reason, gap.durationMs);
			this._notifyFirstFramePersisted();
		}
	}

	private _notifyFirstFramePersisted(): void {
		if (!this._firstFramePersisted && this._recordingStore.hasPersistedFrames) {
			this._firstFramePersisted = true;
			this._options.onFirstFramePersisted?.();
		}
	}

	override dispose(): void {
		this._stopping = true;
		this._scheduledPoll.clear();
		this._timedOutRead = undefined;
		super.dispose();
	}
}
