/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITransaction, observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IComputerUseVideoBatch, IComputerUseVideoConfig, IComputerUseVideoCursor, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';

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
	render(frame: IComputerUseDecodedFrame): void;
	clear(): void;
}

export interface IComputerUsePlaybackState {
	readonly status: IComputerUseVideoBatch['status'] | 'paused' | 'unsupported';
	readonly message: string;
	readonly target?: IComputerUseVideoBatch['target'];
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
const PLAYOUT_DELAY_MS = 50;
const RECOVERY_PLAYOUT_US = 150_000;
const STALE_AFTER_MS = 2000;

/** Owns a bounded, visible-only decode pipeline. The editor input owns the source. */
export class ComputerUseVideo extends Disposable {

	readonly state = observableValue<IComputerUsePlaybackState>(this, {
		status: 'starting',
		message: localize('computerUse.connecting', "Connecting to the agent-controlled window…"),
	});
	readonly paused = observableValue<boolean>(this, false);
	readonly stopState = observableValue<IComputerUseStopState>(this, { status: 'idle' });

	private readonly polling = this._register(new MutableDisposable<IDisposable>());
	private readonly animation = this._register(new MutableDisposable<IDisposable>());
	private readonly staleness = this._register(new MutableDisposable<IDisposable>());
	private readonly cancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly decoder = this._register(new MutableDisposable<IComputerUseVideoDecoder>());
	private encoded: IComputerUseVideoFrame[] = [];
	private decoded: IComputerUseDecodedFrame[] = [];
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
	private lastPresentationTime: number | undefined;
	private lastPresentedTimestamp: number | undefined;
	private visible = false;
	private reading = false;
	private pumping = false;
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
			this.publish('paused', localize('computerUse.paused', "Viewing paused. The last frame is not live. This does not stop the agent."), tx);
		});
	}

	resume(): void {
		if (this.disposed) {
			return;
		}
		transaction(tx => {
			this.paused.set(false, tx);
			this.halted = false;
			if (this.stopState.get().status === 'stopped') {
				this.stopState.set({ status: 'idle' }, tx);
			}
			this.start(tx);
		});
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
			this.fail('unsupported', localize('computerUse.webCodecsUnavailable', "Live video requires a browser with WebCodecs and H.264 decoding support. No preview is available in this client."), tx);
			return;
		}
		this.cancellation.value = new CancellationTokenSource();
		this.publish('starting', localize('computerUse.connecting', "Connecting to the agent-controlled window…"), tx);
		this.scheduleRead(0);
	}

	private suspend(): void {
		this.cancellation.value?.cancel();
		this.cancellation.clear();
		this.polling.clear();
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
		this.reading = true;
		try {
			const batch = await this.source.read(this.cursor, cancellation.token);
			if (!cancellation.token.isCancellationRequested && this.running) {
				await this.acceptBatch(batch, cancellation);
			}
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && this.running) {
				this.fail('error', localize('computerUse.readFailed', "Live video is unavailable: {0}", toErrorMessage(error)));
			}
		} finally {
			this.reading = false;
			this.scheduleRead(this.state.get().status === 'idle' ? 250 : 50);
		}
	}

	private async acceptBatch(batch: IComputerUseVideoBatch, cancellation: CancellationTokenSource): Promise<void> {
		if (batch.status !== 'live') {
			this.resetDecoder();
			this.config = undefined;
			this.streamId = undefined;
			this.cursor = undefined;
			this.target = batch.target;
			this.renderer.clear();
			switch (batch.status) {
				case 'idle':
					this.publish('idle', batch.message || localize('computerUse.idle', "Waiting for the agent to use an application."));
					break;
				case 'starting':
					this.publish('starting', batch.message || localize('computerUse.starting', "Starting the agent-controlled window stream…"));
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
			this.fail('error', localize('computerUse.incompleteStream', "The agent host returned an incomplete live video stream."));
			return;
		}

		const changed = this.streamId !== batch.streamId || !sameConfig(this.config, batch.config)
			|| this.target?.app !== batch.target.app || this.target?.windowId !== batch.target.windowId;
		this.target = batch.target;
		if (changed) {
			this.resetDecoder();
			this.cursor = undefined;
			this.renderer.clear();
			this.publish('starting', localize('computerUse.preparingDecoder', "Preparing live video…"));
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
				this.publish('starting', localize('computerUse.synchronizing', "Synchronizing live video. Any previous frame is not live."));
				return;
			}
			this.createDecoder();
			this.encoded = recovered;
			this.minimumPresentationTimestamp = this.encoded[this.encoded.length - 1].timestamp - RECOVERY_PLAYOUT_US;
			this.publish('starting', localize('computerUse.synchronizing', "Synchronizing live video. Any previous frame is not live."));
		} else {
			this.encoded.push(...frames);
		}
		const lastFrame = frames.at(-1) ?? this.encoded.at(-1);
		if (lastFrame) {
			this.lastSequence = lastFrame.sequence;
			this.cursor = { streamId: batch.streamId, after: this.lastSequence };
		}
		if (this.state.get().status === 'live') {
			this.publish('live', localize('computerUse.live', "Live"));
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
			if (frame.timestamp < this.minimumPresentationTimestamp || this.lastPresentedTimestamp !== undefined && frame.timestamp <= this.lastPresentedTimestamp) {
				frame.close();
			} else {
				this.decoded.push(frame);
				this.decoded.sort((first, second) => first.timestamp - second.timestamp);
				while (this.decoded.length > MAX_DECODED_FRAMES) {
					this.decoded.shift()!.close();
				}
				this.schedulePresentation();
			}
			this.pumpDecoder();
		}, error => {
			if (generation === this.decoderGeneration && this.running) {
				this.fail('error', localize('computerUse.decodeFailed', "Live video decoding failed: {0}. Resume viewing to reconnect.", toErrorMessage(error)));
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
				this.decoder.value.decode(frame);
			}
		} catch (error) {
			this.fail('error', localize('computerUse.decodeFailed', "Live video decoding failed: {0}. Resume viewing to reconnect.", toErrorMessage(error)));
		} finally {
			this.pumping = false;
		}
	}

	private schedulePresentation(): void {
		if (this.animation.value || !this.running || !this.decoded.length) {
			return;
		}
		if (this.originTimestamp === undefined) {
			this.originTimestamp = this.decoded[0].timestamp;
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
		let frame: IComputerUseDecodedFrame | undefined;
		while (this.decoded.length && this.decoded[0].timestamp <= timestamp) {
			frame?.close();
			frame = this.decoded.shift();
		}
		if (frame) {
			try {
				this.renderer.render(frame);
				this.lastPresentationTime = now;
				this.lastPresentedTimestamp = frame.timestamp;
				this.publish('live', localize('computerUse.live', "Live"));
				this.scheduleStalenessCheck();
			} catch (error) {
				this.fail('error', localize('computerUse.renderFailed', "Live video could not be displayed: {0}", toErrorMessage(error)));
			} finally {
				frame.close();
			}
		}
		this.pumpDecoder();
		this.schedulePresentation();
	}

	private scheduleStalenessCheck(): void {
		if (this.staleness.value || !this.running || this.lastPresentationTime === undefined) {
			return;
		}
		const remaining = STALE_AFTER_MS - (this.scheduler.now() - this.lastPresentationTime);
		this.staleness.value = this.scheduler.schedule(() => {
			this.staleness.clear();
			if (this.running && this.lastPresentationTime !== undefined) {
				if (this.scheduler.now() - this.lastPresentationTime >= STALE_AFTER_MS) {
					this.publish('starting', localize('computerUse.stale', "Video is delayed. The last frame is not live."));
				} else {
					this.scheduleStalenessCheck();
				}
			}
		}, Math.max(0, remaining));
	}

	private resetDecoder(): void {
		this.decoderGeneration++;
		this.decoder.clear();
		this.animation.clear();
		this.staleness.clear();
		for (const frame of this.decoded) {
			frame.close();
		}
		this.decoded = [];
		this.encoded = [];
		this.pendingDecodes = 0;
		this.lastSequence = 0;
		this.originTimestamp = undefined;
		this.lastPresentationTime = undefined;
		this.lastPresentedTimestamp = undefined;
		this.minimumPresentationTimestamp = 0;
	}

	private fail(status: IComputerUsePlaybackState['status'], message: string, tx?: ITransaction): void {
		this.halted = true;
		this.suspend();
		this.renderer.clear();
		this.publish(status, message, tx);
	}

	private publish(status: IComputerUsePlaybackState['status'], message: string, tx?: ITransaction): void {
		const current = this.state.get();
		if (current.status !== status || current.message !== message || current.target?.app !== this.target?.app
			|| current.target?.windowId !== this.target?.windowId || current.target?.title !== this.target?.title) {
			this.state.set({ status, message, target: this.target }, tx);
		}
	}

	override dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.suspend();
			this.renderer.clear();
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
