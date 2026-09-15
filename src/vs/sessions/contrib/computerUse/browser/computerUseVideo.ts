/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DeferredPromise, raceCancellationError, raceTimeout } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITransaction, observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IComputerUseVideoBatch, IComputerUseVideoConfig, IComputerUseVideoCursor, IComputerUseVideoFocus, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';

export interface IComputerUseDecodedFrame {
	readonly timestamp: number;
	readonly width: number;
	readonly height: number;
	draw(context: CanvasRenderingContext2D): void;
	close(): void;
}

export interface IComputerUseVideoDecoder extends IDisposable {
	readonly decodeQueueSize: number;
	decode(frame: IComputerUseVideoFrame): void;
	flush(): Promise<void>;
}

export interface IComputerUseVideoDecoderFactory {
	readonly available: boolean;
	isSupported(config: IComputerUseVideoConfig): Promise<boolean>;
	create(config: IComputerUseVideoConfig, output: (frame: IComputerUseDecodedFrame) => void, error: (error: Error) => void): IComputerUseVideoDecoder;
}

export interface IComputerUseVideoScheduler {
	now(): number;
	schedule(callback: () => void, delay: number): IDisposable;
	animationFrame(callback: (now: number) => void): IDisposable;
}

export interface IComputerUseVideoRenderer {
	render(frame: IComputerUseDecodedFrame, focus?: IComputerUseVideoFocus): void;
	clear(): void;
}

interface IComputerUsePresentationFrame {
	readonly frame: IComputerUseDecodedFrame;
	readonly focus?: IComputerUseVideoFocus;
}

export interface IComputerUsePlaybackState {
	readonly status: IComputerUseVideoBatch['status'] | 'paused' | 'unsupported';
	readonly message: string;
	readonly phase?: 'connecting' | 'resuming' | 'buffering' | 'reconnecting' | 'finishing';
	readonly target?: IComputerUseVideoBatch['target'];
	readonly retainedFrame?: boolean;
}

export interface IComputerUseStopState {
	readonly status: 'idle' | 'stopping' | 'stopped' | 'error';
	readonly message?: string;
}

const MAX_ENCODED_FRAMES = 60;
const MAX_ENCODED_CHARACTERS = Math.ceil(4 * 1024 * 1024 / 3) * 4;
const MAX_DECODE_QUEUE = 4;
const MAX_DECODED_FRAMES = 8;
// Hardware decoders can retain more frames than the presentation queue allows.
const MAX_PENDING_DECODES = 32;
const READ_INTERVAL_MS = 50;
const IDLE_READ_INTERVAL_MS = 250;
const PLAYOUT_DELAY_MS = 200;
const BUFFERING_AFTER_MS = 250;
const RECOVERY_PLAYOUT_US = 150_000;
const STALE_AFTER_MS = 2000;
const HOST_RECONNECT_RETRY_INTERVAL_MS = 250;
const HOST_RECONNECT_TIMEOUT_MS = 5000;

/** Owns a bounded, visible-only decode pipeline. The editor input owns the source. */
export class ComputerUseVideo extends Disposable {

	readonly state = observableValue<IComputerUsePlaybackState>(this, {
		status: 'starting',
		message: localize('computerUse.connecting', "Connecting to the agent-controlled window…"),
		phase: 'connecting',
	});
	readonly paused = observableValue<boolean>(this, false);
	readonly stopState = observableValue<IComputerUseStopState>(this, { status: 'idle' });

	private readonly polling = this._register(new MutableDisposable<IDisposable>());
	private readonly readDelay = this._register(new MutableDisposable<IDisposable>());
	private readonly animation = this._register(new MutableDisposable<IDisposable>());
	private readonly staleness = this._register(new MutableDisposable<IDisposable>());
	private readonly resumeBuffering = this._register(new MutableDisposable<IDisposable>());
	private readonly cancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly decoder = this._register(new MutableDisposable<IComputerUseVideoDecoder>());
	private encoded: IComputerUseVideoFrame[] = [];
	private decoded: IComputerUsePresentationFrame[] = [];
	private pendingFocus: { timestamp: number; focus?: IComputerUseVideoFocus }[] = [];
	private cursor: IComputerUseVideoCursor | undefined;
	private config: IComputerUseVideoConfig | undefined;
	private streamId: string | undefined;
	private target: IComputerUseVideoBatch['target'];
	private lastSequence = 0;
	private pendingDecodes = 0;
	private decoderGeneration = 0;
	private minimumPresentationTimestamp = 0;
	private originTimestamp: number | undefined;
	private originTime = 0;
	private lastLiveActivityTime: number | undefined;
	private lastPresentedTimestamp: number | undefined;
	private visible = false;
	private reading = false;
	private readMarkedBuffering = false;
	private pumping = false;
	private finishing = false;
	private finalSubmission: DeferredPromise<void> | undefined;
	private hasRenderedFrame = false;
	private hostReconnectStartedAt: number | undefined;
	private resumingFromPause = false;
	private halted = false;
	private disposed = false;

	constructor(
		private readonly source: ISessionComputerUseVideoSource,
		private readonly factory: IComputerUseVideoDecoderFactory,
		private readonly scheduler: IComputerUseVideoScheduler,
		private readonly renderer: IComputerUseVideoRenderer,
	) {
		super();
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible || this.disposed) {
			return;
		}
		this.visible = visible;
		if (visible) {
			this.start();
		} else {
			this.suspend();
			if (!this.halted && !this.paused.get()) {
				this.publish('paused', localize('computerUse.hidden', "Viewing suspended while hidden. The agent may still be running."));
			}
		}
	}

	pause(): void {
		if (this.disposed) {
			return;
		}
		transaction(tx => {
			this.paused.set(true, tx);
			this.suspend();
			this.publish('paused', this.source.kind === 'recording'
				? localize('computerUse.recordingPaused', "Recording playback paused.")
				: localize('computerUse.paused', "Viewing paused. The last frame is not live. This does not stop the agent."), tx);
		});
	}

	resume(): void {
		if (this.disposed) {
			return;
		}
		transaction(tx => {
			this.paused.set(false, tx);
			this.halted = false;
			this.resumingFromPause = this.visible && this.hasRenderedFrame;
			if (this.stopState.get().status === 'stopped') {
				this.stopState.set({ status: 'idle' }, tx);
			}
			this.start(tx);
		});
	}

	seek(positionMs: number): void {
		if (!this.source.seek || this.disposed) {
			return;
		}
		this.source.seek(positionMs);
		this.restartAfterSeek();
	}

	async stopAgent(): Promise<void> {
		if (this.disposed || this.stopState.get().status === 'stopping' || this.stopState.get().status === 'stopped') {
			return;
		}
		this.stopState.set({ status: 'stopping' }, undefined);
		try {
			await this.source.stop();
			if (!this.disposed) {
				transaction(tx => {
					this.halted = true;
					this.suspend();
					this.stopState.set({ status: 'stopped' }, tx);
					this.publish('stopped', localize('computerUse.agentStopped', "Agent stopped. The last frame is not live."), tx);
				});
			}
		} catch (error) {
			if (!this.disposed) {
				this.stopState.set({
					status: 'error',
					message: localize('computerUse.stopFailed', "Could not stop the agent: {0}. The agent may still be running. Try Stop Agent again.", toErrorMessage(error)),
				}, undefined);
			}
		}
	}

	private get running(): boolean {
		return !this.disposed && this.visible && !this.paused.get() && !this.halted;
	}

	private start(tx?: ITransaction): void {
		if (!this.running || this.cancellation.value) {
			return;
		}
		if (!this.factory.available) {
			this.fail('unsupported', this.source.kind === 'recording'
				? localize('computerUse.recordingWebCodecsUnavailable', "Computer Use recording playback requires a browser with WebCodecs and H.264 decoding support.")
				: localize('computerUse.webCodecsUnavailable', "Live video requires a browser with WebCodecs and H.264 decoding support. No preview is available in this client."), tx);
			return;
		}
		this.hostReconnectStartedAt = undefined;
		this.cancellation.value = new CancellationTokenSource();
		if (this.resumingFromPause) {
			this.publishResuming(tx);
			this.resumeBuffering.value = this.scheduler.schedule(() => {
				this.resumeBuffering.clear();
				if (this.running && this.resumingFromPause) {
					this.publish('starting', this.source.kind === 'recording'
						? localize('computerUse.bufferingRecordingResume', "Buffering recorded video… The last frame remains visible.")
						: localize('computerUse.bufferingResume', "Buffering live video… The last frame is not live."), undefined, 'buffering');
				}
			}, BUFFERING_AFTER_MS);
		} else {
			this.publish('starting', this.source.kind === 'recording'
				? localize('computerUse.loadingRecording', "Loading Computer Use recording…")
				: localize('computerUse.connecting', "Connecting to the agent-controlled window…"), tx, 'connecting');
		}
		this.scheduleRead(0);
	}

	private suspend(): void {
		this.cancellation.value?.cancel();
		this.cancellation.clear();
		this.polling.clear();
		this.readDelay.clear();
		this.resumeBuffering.clear();
		this.readMarkedBuffering = false;
		this.resumingFromPause = false;
		this.resetDecoder();
		this.cursor = undefined;
		this.config = undefined;
		this.streamId = undefined;
	}

	private scheduleRead(delay: number): void {
		if (this.running && !this.reading && !this.polling.value) {
			this.polling.value = this.scheduler.schedule(() => {
				this.polling.clear();
				void this.read();
			}, delay);
		}
	}

	private async read(): Promise<void> {
		const cancellation = this.cancellation.value;
		if (!this.running || !cancellation || this.reading) {
			return;
		}
		const startedAt = this.scheduler.now();
		this.reading = true;
		this.readMarkedBuffering = false;
		this.readDelay.value = this.scheduler.schedule(() => {
			this.readDelay.clear();
			if (this.running && this.reading && this.hasRenderedFrame && this.state.get().status === 'live') {
				this.readMarkedBuffering = true;
				this.publish('starting', localize('computerUse.buffering', "Buffering live video… The last frame is not live."), undefined, 'buffering');
			}
		}, BUFFERING_AFTER_MS);
		let readingSource = true;
		try {
			const batch = await this.source.read(this.cursor, cancellation.token);
			readingSource = false;
			this.readDelay.clear();
			if (!cancellation.token.isCancellationRequested && this.running) {
				await this.acceptBatch(batch, cancellation);
			}
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && this.running) {
				const message = toErrorMessage(error);
				if (!readingSource || !this.recoverFromHostError()) {
					this.fail('error', this.source.kind === 'recording'
						? localize('computerUse.recordingReadFailed', "The Computer Use recording is unavailable: {0}", message)
						: localize('computerUse.readFailed', "Live video is unavailable: {0}", message));
				}
			}
		} finally {
			this.readDelay.clear();
			this.readMarkedBuffering = false;
			this.reading = false;
			const interval = this.hostReconnectStartedAt !== undefined
				? HOST_RECONNECT_RETRY_INTERVAL_MS
				: this.state.get().status === 'idle' ? IDLE_READ_INTERVAL_MS : READ_INTERVAL_MS;
			this.scheduleRead(Math.max(0, interval - (this.scheduler.now() - startedAt)));
		}
	}

	private async acceptBatch(batch: IComputerUseVideoBatch, cancellation: CancellationTokenSource): Promise<void> {
		if (batch.status !== 'live') {
			if (batch.status === 'error' && this.recoverFromHostError()) {
				return;
			}
			this.hostReconnectStartedAt = undefined;
			const sameTarget = !batch.target || (this.target?.app === batch.target.app && this.target.windowId === batch.target.windowId);
			if (batch.status === 'starting' && sameTarget && this.resumingFromPause && this.hasRenderedFrame) {
				this.publishResuming();
				return;
			}
			this.resumingFromPause = false;
			this.resumeBuffering.clear();
			if (batch.status === 'idle' && sameTarget) {
				await this.finishStream(cancellation);
				if (cancellation.token.isCancellationRequested || !this.running) {
					return;
				}
				this.source.onPlaybackEnded?.();
			}
			const retainFrame = this.hasRenderedFrame && sameTarget
				&& (batch.status === 'idle' || (batch.status === 'starting' && this.source.kind !== 'recording' && !batch.target));
			this.resetDecoder();
			this.config = undefined;
			this.streamId = undefined;
			this.cursor = undefined;
			if (!retainFrame) {
				this.target = batch.target;
				this.clearFrame();
			}
			switch (batch.status) {
				case 'idle':
					this.publish('idle', retainFrame
						? this.source.kind === 'recording'
							? localize('computerUse.recordingEnded', "Recording ended. Showing the last frame.")
							: localize('computerUse.lastFrame', "Stream ended. Showing the last frame (not live).")
						: batch.message || (this.source.kind === 'recording'
							? localize('computerUse.recordingEmpty', "This Computer Use recording contains no playable video.")
							: localize('computerUse.idle', "Waiting for the agent to use an application.")));
					break;
				case 'starting':
					this.publish(
						'starting',
						retainFrame
							? localize('computerUse.waitingForNextWindowWithFrame', "{0} The last frame is not live.", batch.message || localize('computerUse.waitingForNextWindow', "Waiting for the agent to select another application window."))
							: batch.message || localize('computerUse.starting', "Starting the agent-controlled window stream…"),
						undefined,
						retainFrame ? 'reconnecting' : 'connecting',
					);
					break;
				case 'stopped':
					this.fail('stopped', batch.message || localize('computerUse.streamStopped', "Window sharing ended. The agent may still be running."));
					break;
				case 'permissionRequired':
					this.fail('permissionRequired', batch.message || localize('computerUse.permissionRequired', "Screen capture permission is required on the agent host. Grant permission there, then resume viewing."));
					break;
				case 'error':
					this.fail('error', batch.message || localize('computerUse.hostError', "The agent host could not provide live video."));
					break;
			}
			return;
		}

		if (!batch.config || !batch.streamId || !batch.target) {
			this.fail('error', this.source.kind === 'recording'
				? localize('computerUse.incompleteRecording', "The agent host returned incomplete Computer Use recording data.")
				: localize('computerUse.incompleteStream', "The agent host returned an incomplete live video stream."));
			return;
		}
		this.hostReconnectStartedAt = undefined;

		const targetChanged = this.target?.app !== batch.target.app || this.target?.windowId !== batch.target.windowId;
		const resuming = this.resumingFromPause && this.hasRenderedFrame && !targetChanged;
		if (targetChanged) {
			this.resumingFromPause = false;
			this.resumeBuffering.clear();
		}
		const changed = this.streamId !== batch.streamId || !sameConfig(this.config, batch.config) || targetChanged;
		this.target = batch.target;
		if (changed) {
			this.resetDecoder();
			this.cursor = undefined;
			if (!this.hasRenderedFrame || targetChanged) {
				this.clearFrame();
			}
			if (resuming) {
				this.publishResuming();
			} else {
				this.publish('starting', this.source.kind === 'recording'
					? localize('computerUse.preparingRecordingDecoder', "Preparing recorded video…")
					: localize('computerUse.preparingDecoder', "Preparing live video…"), undefined, 'buffering');
			}
			if (!await this.factory.isSupported(batch.config)) {
				if (!cancellation.token.isCancellationRequested) {
					this.fail('unsupported', localize('computerUse.h264Unsupported', "This client cannot decode the host's H.264 video stream. Use a client with a supported H.264 decoder."));
				}
				return;
			}
			if (cancellation.token.isCancellationRequested || !this.running) {
				return;
			}
			this.config = batch.config;
			this.streamId = batch.streamId;
		}

		const frames = (batch.frames ?? []).filter(frame => frame.sequence > this.lastSequence);
		let lastGap = -1;
		let previous = this.lastSequence;
		for (let index = 0; index < frames.length; index++) {
			if (previous > 0 && frames[index].sequence !== previous + 1) {
				lastGap = index;
			}
			previous = frames[index].sequence;
		}
		const needsRecovery = changed || batch.dropped || lastGap >= 0 || this.lastSequence === 0
			|| this.encoded.length + frames.length > MAX_ENCODED_FRAMES
			|| encodedSize(this.encoded) + encodedSize(frames) > MAX_ENCODED_CHARACTERS;
		if (needsRecovery) {
			const candidates = lastGap >= 0 ? frames.slice(lastGap) : [...this.encoded, ...frames];
			if (!changed) {
				this.resetDecoder();
			}
			const keyFrame = candidates.findLastIndex(frame => frame.keyFrame);
			const recovered = keyFrame < 0 ? [] : candidates.slice(keyFrame);
			if (!recovered.length || recovered.length > MAX_ENCODED_FRAMES || encodedSize(recovered) > MAX_ENCODED_CHARACTERS) {
				this.cursor = undefined;
				if (resuming) {
					this.publishResuming();
				} else {
					this.publish('starting', this.source.kind === 'recording'
						? localize('computerUse.synchronizingRecording', "Synchronizing recorded video…")
						: localize('computerUse.synchronizing', "Synchronizing live video. Any previous frame is not live."), undefined, 'buffering');
				}
				return;
			}
			this.createDecoder();
			this.encoded = recovered;
			this.minimumPresentationTimestamp = this.encoded[this.encoded.length - 1].timestamp - RECOVERY_PLAYOUT_US;
			if (resuming) {
				this.publishResuming();
			} else {
				this.publish('starting', this.source.kind === 'recording'
					? localize('computerUse.synchronizingRecording', "Synchronizing recorded video…")
					: localize('computerUse.synchronizing', "Synchronizing live video. Any previous frame is not live."), undefined, 'buffering');
			}
		} else {
			this.encoded.push(...frames);
		}
		const lastFrame = frames.at(-1) ?? this.encoded.at(-1);
		if (lastFrame) {
			this.lastSequence = lastFrame.sequence;
			this.cursor = { streamId: batch.streamId, after: this.lastSequence };
		}
		if (this.state.get().status === 'live' || (this.readMarkedBuffering && !frames.length && this.hasRenderedFrame)) {
			this.publishLive();
		}
		if (!frames.length && this.hasRenderedFrame) {
			this.lastLiveActivityTime = this.scheduler.now();
			this.scheduleStalenessCheck();
		}
		this.pumpDecoder();
	}

	private createDecoder(): void {
		if (!this.config || !this.running) {
			return;
		}
		const generation = ++this.decoderGeneration;
		this.decoder.value = this.factory.create(this.config, frame => {
			if (generation !== this.decoderGeneration || !this.running) {
				frame.close();
				return;
			}
			this.pendingDecodes = Math.max(0, this.pendingDecodes - 1);
			const metadataIndex = this.pendingFocus.findIndex(metadata => metadata.timestamp === frame.timestamp);
			const focus = metadataIndex < 0 ? undefined : this.pendingFocus.splice(metadataIndex, 1)[0].focus;
			if (frame.timestamp < this.minimumPresentationTimestamp || this.lastPresentedTimestamp !== undefined && frame.timestamp <= this.lastPresentedTimestamp) {
				frame.close();
			} else {
				this.decoded.push({ frame, focus });
				this.decoded.sort((first, second) => first.frame.timestamp - second.frame.timestamp);
				while (this.decoded.length > (this.finishing ? 1 : MAX_DECODED_FRAMES)) {
					this.decoded.shift()!.frame.close();
				}
				this.schedulePresentation();
			}
			this.pumpDecoder();
		}, error => {
			if (generation === this.decoderGeneration && this.running) {
				this.fail('error', this.source.kind === 'recording'
					? localize('computerUse.recordingDecodeFailed', "Recorded video decoding failed: {0}. Resume playback to retry.", toErrorMessage(error))
					: localize('computerUse.decodeFailed', "Live video decoding failed: {0}. Resume viewing to reconnect.", toErrorMessage(error)));
			}
		});
	}

	private pumpDecoder(): void {
		if (this.pumping) {
			return;
		}
		this.pumping = true;
		try {
			while (this.running && this.decoder.value && this.encoded.length
				&& this.decoder.value.decodeQueueSize < MAX_DECODE_QUEUE
				&& this.pendingDecodes < MAX_PENDING_DECODES
				&& this.decoded.length < MAX_DECODED_FRAMES) {
				const frame = this.encoded.shift()!;
				this.pendingDecodes++;
				this.pendingFocus.push({ timestamp: frame.timestamp, focus: frame.focus });
				this.decoder.value.decode(frame);
			}
			if (this.finishing && !this.encoded.length) {
				void this.finalSubmission?.complete();
			}
		} catch (error) {
			this.fail('error', this.source.kind === 'recording'
				? localize('computerUse.recordingDecodeFailed', "Recorded video decoding failed: {0}. Resume playback to retry.", toErrorMessage(error))
				: localize('computerUse.decodeFailed', "Live video decoding failed: {0}. Resume viewing to reconnect.", toErrorMessage(error)));
		} finally {
			this.pumping = false;
		}
	}

	private schedulePresentation(): void {
		if (this.animation.value || this.finishing || !this.running || !this.decoded.length) {
			return;
		}
		if (this.originTimestamp === undefined) {
			this.originTimestamp = this.decoded[0].frame.timestamp;
			this.originTime = this.scheduler.now() + PLAYOUT_DELAY_MS;
		}
		this.animation.value = this.scheduler.animationFrame(now => {
			this.animation.clear();
			this.present(now);
		});
	}

	private present(now: number): void {
		if (!this.running || this.originTimestamp === undefined) {
			return;
		}
		const timestamp = this.originTimestamp + (now - this.originTime) * 1000;
		let presentation: IComputerUsePresentationFrame | undefined;
		while (this.decoded.length && this.decoded[0].frame.timestamp <= timestamp) {
			presentation?.frame.close();
			presentation = this.decoded.shift();
		}
		if (presentation) {
			this.renderPresentation(presentation, now, true);
		}
		this.pumpDecoder();
		this.schedulePresentation();
	}

	private renderPresentation({ frame, focus }: IComputerUsePresentationFrame, now: number, live: boolean): void {
		try {
			this.renderer.render(frame, focus);
			this.source.onFramePresented?.(frame.timestamp);
			this.hasRenderedFrame = true;
			this.resumingFromPause = false;
			this.resumeBuffering.clear();
			this.lastLiveActivityTime = now;
			this.lastPresentedTimestamp = frame.timestamp;
			if (live) {
				this.publishLive();
				this.scheduleStalenessCheck();
			}
		} catch (error) {
			this.fail('error', this.source.kind === 'recording'
				? localize('computerUse.recordingRenderFailed', "Recorded video could not be displayed: {0}", toErrorMessage(error))
				: localize('computerUse.renderFailed', "Live video could not be displayed: {0}", toErrorMessage(error)));
		} finally {
			frame.close();
		}
	}

	private async finishStream(cancellation: CancellationTokenSource): Promise<void> {
		const decoder = this.decoder.value;
		if (!decoder) {
			return;
		}
		this.publish('starting', this.source.kind === 'recording'
			? localize('computerUse.finishingRecording', "Finishing recorded playback…")
			: localize('computerUse.finishingStream', "Finishing the stream. The last frame is not live."), undefined, 'finishing');
		this.finishing = true;
		const submitted = this.finalSubmission = new DeferredPromise<void>();
		this.animation.clear();
		this.staleness.clear();
		while (this.decoded.length > 1) {
			this.decoded.shift()!.frame.close();
		}
		try {
			this.pumpDecoder();
			const drained = await raceCancellationError(raceTimeout(submitted.p.then(() => true), 2000), cancellation.token);
			if (drained !== true) {
				throw new Error(localize('computerUse.drainTimeout', "Timed out while submitting the final video frames."));
			}
			if (cancellation.token.isCancellationRequested || !this.running || this.decoder.value !== decoder) {
				return;
			}
			// Flushing requires the next chunk to be a keyframe, so finish all submissions first.
			const flushed = await raceCancellationError(raceTimeout(decoder.flush().then(() => true), 2000), cancellation.token);
			if (flushed !== true) {
				throw new Error(localize('computerUse.flushTimeout', "Timed out while decoding the final video frame."));
			}
			if (cancellation.token.isCancellationRequested || !this.running || this.decoder.value !== decoder) {
				return;
			}
			const last = this.decoded.pop();
			if (last) {
				this.renderPresentation(last, this.scheduler.now(), false);
			}
		} finally {
			if (this.finalSubmission === submitted) {
				this.finalSubmission = undefined;
			}
			this.finishing = false;
		}
	}

	private clearFrame(): void {
		this.hasRenderedFrame = false;
		this.renderer.clear();
	}

	private publishLive(): void {
		this.publish('live', this.source.kind === 'recording'
			? localize('computerUse.playingRecording', "Playing Recording")
			: localize('computerUse.live', "Live"));
	}

	private publishResuming(tx?: ITransaction): void {
		if (this.resumingFromPause && this.state.get().phase === 'buffering') {
			return;
		}
		this.publish('starting', this.source.kind === 'recording'
			? localize('computerUse.resumingRecording', "Resuming recorded video…")
			: localize('computerUse.resuming', "Resuming live video…"), tx, 'resuming');
	}

	private recoverFromHostError(): boolean {
		const now = this.scheduler.now();
		if (this.hostReconnectStartedAt !== undefined && now - this.hostReconnectStartedAt >= HOST_RECONNECT_TIMEOUT_MS) {
			return false;
		}
		this.hostReconnectStartedAt ??= now;
		this.resumingFromPause = false;
		this.resumeBuffering.clear();
		this.resetDecoder();
		this.config = undefined;
		this.streamId = undefined;
		this.cursor = undefined;
		this.publish('starting', this.source.kind === 'recording'
			? localize('computerUse.reopeningRecording', "Recording access was interrupted. Retrying…")
			: this.hasRenderedFrame
				? localize('computerUse.reconnecting', "Video connection interrupted. Reconnecting… The last frame is not live.")
				: localize('computerUse.reconnectingInitial', "Video connection interrupted. Reconnecting…"), undefined, 'reconnecting');
		return true;
	}

	private restartAfterSeek(): void {
		if (this.disposed) {
			return;
		}
		this.halted = false;
		this.suspend();
		this.start();
	}

	private scheduleStalenessCheck(): void {
		if (this.staleness.value || !this.running || this.lastLiveActivityTime === undefined) {
			return;
		}
		const remaining = STALE_AFTER_MS - (this.scheduler.now() - this.lastLiveActivityTime);
		this.staleness.value = this.scheduler.schedule(() => {
			this.staleness.clear();
			if (this.running && this.lastLiveActivityTime !== undefined) {
				if (this.scheduler.now() - this.lastLiveActivityTime >= STALE_AFTER_MS) {
					this.publish('starting', localize('computerUse.stale', "Video is delayed. The last frame is not live."), undefined, 'buffering');
				} else {
					this.scheduleStalenessCheck();
				}
			}
		}, Math.max(0, remaining));
	}

	private resetDecoder(): void {
		void this.finalSubmission?.complete();
		this.finalSubmission = undefined;
		this.finishing = false;
		this.decoderGeneration++;
		this.decoder.clear();
		this.animation.clear();
		this.staleness.clear();
		for (const presentation of this.decoded) {
			presentation.frame.close();
		}
		this.decoded = [];
		this.encoded = [];
		this.pendingFocus = [];
		this.pendingDecodes = 0;
		this.lastSequence = 0;
		this.originTimestamp = undefined;
		this.lastLiveActivityTime = undefined;
		this.lastPresentedTimestamp = undefined;
		this.minimumPresentationTimestamp = 0;
	}

	private fail(status: IComputerUsePlaybackState['status'], message: string, tx?: ITransaction): void {
		this.halted = true;
		this.suspend();
		this.clearFrame();
		this.publish(status, message, tx);
	}

	private publish(status: IComputerUsePlaybackState['status'], message: string, tx?: ITransaction, phase?: IComputerUsePlaybackState['phase']): void {
		const current = this.state.get();
		const retainedFrame = status === 'idle' && this.hasRenderedFrame;
		if (current.status !== status || current.message !== message || current.target?.app !== this.target?.app
			|| current.target?.windowId !== this.target?.windowId || current.target?.title !== this.target?.title
			|| current.phase !== phase || !!current.retainedFrame !== retainedFrame) {
			this.state.set({ status, message, phase, target: this.target, ...(retainedFrame ? { retainedFrame: true } : {}) }, tx);
		}
	}

	override dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.suspend();
			this.clearFrame();
			super.dispose();
		}
	}
}

function sameConfig(first: IComputerUseVideoConfig | undefined, second: IComputerUseVideoConfig): boolean {
	return first?.codec === second.codec && first.codedWidth === second.codedWidth
		&& first.codedHeight === second.codedHeight && first.description === second.description;
}

function encodedSize(frames: readonly IComputerUseVideoFrame[]): number {
	return frames.reduce((size, frame) => size + frame.data.length, 0);
}
