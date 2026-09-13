/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IComputerUseVideoBatch, IComputerUseVideoConfig, IComputerUseVideoCursor, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../../services/sessions/common/computerUse.js';
import { IComputerUseDecodedFrame, IComputerUseVideoDecoder, IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler } from '../../browser/computerUseVideo.js';

export class TestVideoScheduler implements IComputerUseVideoScheduler {
	private time = 0;
	private readonly callbacks = new Set<{ time: number; callback: () => void }>();

	now(): number { return this.time; }

	schedule(callback: () => void, delay: number): IDisposable {
		const entry = { time: this.time + delay, callback };
		this.callbacks.add(entry);
		return toDisposable(() => this.callbacks.delete(entry));
	}

	animationFrame(callback: (now: number) => void): IDisposable {
		return this.schedule(() => callback(this.time), 16);
	}

	async advance(milliseconds: number): Promise<void> {
		await this.flushMicrotasks();
		const end = this.time + milliseconds;
		for (;;) {
			const next = [...this.callbacks].sort((first, second) => first.time - second.time)[0];
			if (!next || next.time > end) {
				break;
			}
			this.time = next.time;
			this.callbacks.delete(next);
			next.callback();
			await this.flushMicrotasks();
		}
		this.time = end;
		await this.flushMicrotasks();
	}

	get pendingCallbacks(): number { return this.callbacks.size; }

	private async flushMicrotasks(): Promise<void> {
		for (let index = 0; index < 8; index++) {
			await Promise.resolve();
		}
	}
}

export const testVideoConfig: IComputerUseVideoConfig = {
	codec: 'avc1.42001e',
	codedWidth: 32,
	codedHeight: 24,
	description: 'AQ==',
};

export function videoFrame(sequence: number, keyFrame = false): IComputerUseVideoFrame {
	return { sequence, timestamp: (sequence - 1) * 33333, duration: 33333, keyFrame, data: 'AQ==' };
}

export function videoBatch(frames: readonly IComputerUseVideoFrame[], overrides?: Partial<IComputerUseVideoBatch>): IComputerUseVideoBatch {
	return {
		version: 1, status: 'live', streamId: 'stream-a', config: testVideoConfig,
		target: { app: 'Agent Browser', windowId: 1, title: 'Example window' },
		frames, ...overrides,
	};
}

export class TestVideoSource extends Disposable implements ISessionComputerUseVideoSource {
	readonly calls: { cursor: IComputerUseVideoCursor | undefined; token: CancellationToken }[] = [];
	readonly results: (IComputerUseVideoBatch | Error | DeferredPromise<IComputerUseVideoBatch>)[] = [];
	stopCalls = 0;
	disposeCalls = 0;
	stopError: Error | undefined;
	stopGate: DeferredPromise<void> | undefined;
	peakReads = 0;
	private reads = 0;
	private lastBatch = videoBatch([]);

	constructor(readonly hostLabel = 'Remote Mac') { super(); }

	async read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch> {
		this.calls.push({ cursor, token });
		this.peakReads = Math.max(this.peakReads, ++this.reads);
		try {
			const result = this.results.shift() ?? this.lastBatch;
			if (result instanceof Error) {
				throw result;
			}
			const batch = result instanceof DeferredPromise ? await result.p : result;
			this.lastBatch = { ...batch, frames: [], dropped: false };
			return batch;
		} finally {
			this.reads--;
		}
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		if (this.stopError) {
			throw this.stopError;
		}
		await this.stopGate?.p;
	}

	override dispose(): void {
		this.disposeCalls++;
		super.dispose();
	}
}

export class TestDecodedFrame implements IComputerUseDecodedFrame {
	readonly width = 32;
	readonly height = 24;
	closeCount = 0;
	constructor(readonly timestamp: number) { }
	draw(_context: CanvasRenderingContext2D): void { }
	close(): void { this.closeCount++; }
}

export class TestVideoDecoder implements IComputerUseVideoDecoder {
	readonly sequences: number[] = [];
	private readonly pending: IComputerUseVideoFrame[] = [];
	disposed = false;
	peakQueueSize = 0;

	constructor(
		readonly config: IComputerUseVideoConfig,
		private readonly factory: TestVideoDecoderFactory,
		private readonly output: (frame: IComputerUseDecodedFrame) => void,
		readonly error: (error: Error) => void,
	) { }

	get decodeQueueSize(): number { return this.factory.automatic ? 0 : this.pending.length; }

	decode(frame: IComputerUseVideoFrame): void {
		this.sequences.push(frame.sequence);
		this.pending.push(frame);
		this.peakQueueSize = Math.max(this.peakQueueSize, this.pending.length);
		if (this.factory.automatic && this.pending.length > this.factory.outputDelay) {
			this.releaseOne();
		}
	}

	releaseOne(): void {
		const frame = this.pending.shift();
		if (frame) {
			this.emit(frame.timestamp);
		}
	}

	emit(timestamp: number): void {
		const frame = new TestDecodedFrame(timestamp);
		this.factory.frames.push(frame);
		this.factory.peakFrames = Math.max(this.factory.peakFrames, this.factory.frames.filter(frame => frame.closeCount === 0).length);
		this.output(frame);
	}

	dispose(): void {
		this.disposed = true;
		this.pending.length = 0;
	}
}

export class TestVideoDecoderFactory implements IComputerUseVideoDecoderFactory {
	available = true;
	supported = true;
	supportGate: DeferredPromise<boolean> | undefined;
	automatic = true;
	outputDelay = 0;
	readonly decoders: TestVideoDecoder[] = [];
	readonly frames: TestDecodedFrame[] = [];
	readonly supportChecks: IComputerUseVideoConfig[] = [];
	peakFrames = 0;

	async isSupported(config: IComputerUseVideoConfig): Promise<boolean> {
		this.supportChecks.push(config);
		return this.supportGate ? this.supportGate.p : this.supported;
	}

	create(config: IComputerUseVideoConfig, output: (frame: IComputerUseDecodedFrame) => void, error: (error: Error) => void): IComputerUseVideoDecoder {
		const decoder = new TestVideoDecoder(config, this, output, error);
		this.decoders.push(decoder);
		return decoder;
	}
}
