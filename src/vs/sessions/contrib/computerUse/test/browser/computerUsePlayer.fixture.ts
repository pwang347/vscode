/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, getWindow } from '../../../../../base/browser/dom.js';
import '../../../../../base/browser/ui/codicons/codiconStyles.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { IComputerUseRecordingPreview, IComputerUseRecordingTimelineRange, IComputerUseSharedThought, IComputerUseVideoBatch, IComputerUseVideoConfig, IComputerUseVideoCursor, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../../services/sessions/common/computerUse.js';
import '../../browser/computerUseActions.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { ComputerUsePlayer } from '../../browser/computerUsePlayer.js';
import { IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler } from '../../browser/computerUseVideo.js';

type FixtureState = 'loading' | 'live' | 'buffering' | 'synchronizing' | 'reconnecting' | 'paused' | 'completed' | 'stopped' | 'recording' | 'annotation' | 'error';

class FixtureVideoSource extends Disposable implements ISessionComputerUseVideoSource {
	readonly hostLabel = 'Build Mac · Remote Agent Host';
	readonly kind?: 'recording';
	readonly thought;
	readonly recordingDurationMs?: number;
	readonly recordingPositionMs = observableValue(this, 0);
	private stopped = false;
	private reconnecting = false;
	private synchronizing = false;
	private framePresented = false;
	private readonly started: number;

	constructor(
		private readonly mode: FixtureState,
		private readonly encoded: { config: IComputerUseVideoConfig; data: string } | undefined,
		private readonly now: () => number,
		private readonly tracking: boolean,
		thought: IComputerUseSharedThought | undefined,
	) {
		super();
		this.kind = mode === 'recording' ? 'recording' : undefined;
		this.recordingDurationMs = mode === 'recording' ? 60_000 : undefined;
		this.thought = constObservable(thought);
		this.started = now();
	}

	async read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (this.stopped) {
			return { version: 1, status: 'stopped' };
		}
		if (this.mode === 'loading') {
			return { version: 1, status: 'starting', message: 'Connecting to the agent-controlled window…' };
		}
		if (this.mode === 'error') {
			return { version: 1, status: 'permissionRequired', message: 'Screen capture permission is required on Build Mac. Grant permission on the host, then resume viewing.' };
		}
		if (this.mode === 'reconnecting' && this.reconnecting) {
			return new Promise<IComputerUseVideoBatch>((_resolve, reject) => {
				const cancellation = token.onCancellationRequested(() => {
					cancellation.dispose();
					reject(new CancellationError());
				});
			});
		}
		if (this.mode === 'reconnecting' && cursor && this.now() - this.started >= 350) {
			this.reconnecting = true;
			return { version: 1, status: 'error', message: 'native video request timed out' };
		}
		if (this.mode === 'buffering' && cursor && this.now() - this.started >= 350) {
			return new Promise<IComputerUseVideoBatch>((_resolve, reject) => {
				const cancellation = token.onCancellationRequested(() => {
					cancellation.dispose();
					reject(new CancellationError());
				});
			});
		}
		if (this.mode === 'synchronizing' && (this.synchronizing || this.framePresented && !!cursor)) {
			this.synchronizing = true;
			if (!this.encoded) {
				return { version: 1, status: 'error', message: 'This fixture needs a browser with H.264 encoding support to generate its sample video.' };
			}
			return {
				version: 1,
				status: 'live',
				streamId: 'fixture-stream-next',
				config: this.encoded.config,
				target: { app: 'Browser', windowId: 1, title: 'Preview — Checkout flow' },
				frames: [],
			};
		}
		if (!this.encoded) {
			return { version: 1, status: 'error', message: 'This fixture needs a browser with H.264 encoding support to generate its sample video.' };
		}
		if (this.mode === 'completed' && cursor) {
			return { version: 1, status: 'idle' };
		}
		const latest = Math.max(1, Math.floor((this.now() - this.started) / (1000 / 30)) + 1);
		const first = cursor ? Math.max(cursor.after + 1, latest - 2) : latest;
		const frames: IComputerUseVideoFrame[] = [];
		for (let sequence = first; sequence <= latest; sequence++) {
			frames.push({
				sequence, timestamp: Math.round(sequence * 1_000_000 / 30), duration: 33333,
				keyFrame: true, data: this.encoded.data,
				...(this.tracking ? { focus: { x: 443 / 640, y: 266 / 360 } } : {}),
			});
		}
		return {
			version: 1, status: 'live', streamId: 'fixture-stream', config: this.encoded.config,
			target: { app: 'Browser', windowId: 1, title: 'Preview — Checkout flow' }, frames,
		};
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	async readRecordingTimeline(): Promise<readonly IComputerUseRecordingTimelineRange[]> {
		return [
			{ startMs: 8000, durationMs: 9000 },
			{ startMs: 28_000, durationMs: 14_000 },
			{ startMs: 50_000, durationMs: 5000 },
		];
	}

	async readRecordingPreview(positionMs: number): Promise<IComputerUseRecordingPreview | undefined> {
		return this.encoded ? {
			config: this.encoded.config,
			frames: [{
				sequence: 1,
				timestamp: positionMs * 1000,
				duration: 33_333,
				keyFrame: true,
				data: this.encoded.data,
			}],
		} : undefined;
	}

	seek(positionMs: number): void {
		this.recordingPositionMs.set(positionMs, undefined);
	}

	onFramePresented(timestampUs: number): void {
		this.framePresented = true;
		this.recordingPositionMs.set(Math.min(this.recordingDurationMs ?? 0, timestampUs / 1000), undefined);
	}

	onPlaybackEnded(): void {
		this.recordingPositionMs.set(this.recordingDurationMs ?? 0, undefined);
	}
}

function paintFixtureFrame(context: CanvasRenderingContext2D): void {
	context.fillStyle = '#f6f7fa';
	context.fillRect(0, 0, 640, 360);
	context.fillStyle = '#e3e7ee';
	context.fillRect(0, 0, 640, 36);
	context.fillStyle = '#ffffff';
	context.fillRect(90, 70, 460, 235);
	context.fillStyle = '#253047';
	context.font = '24px sans-serif';
	context.fillText('Checkout', 118, 116);
	context.font = '16px sans-serif';
	context.fillText('Review your order', 118, 154);
	context.fillStyle = '#e3e7ee';
	context.fillRect(118, 182, 402, 48);
	context.fillStyle = '#285ac8';
	context.fillRect(366, 250, 154, 32);
	context.fillStyle = '#ffffff';
	context.fillText('Continue', 408, 272);
}

function createImmediateFixtureDecoderFactory(): IComputerUseVideoDecoderFactory {
	return {
		available: true,
		async isSupported() { return true; },
		create(_config, output) {
			let disposed = false;
			return {
				decodeQueueSize: 0,
				decode: frame => {
					if (!disposed) {
						output({
							timestamp: frame.timestamp,
							width: 640,
							height: 360,
							draw: context => paintFixtureFrame(context),
							close: () => { },
						});
					}
				},
				async flush() { },
				dispose: () => disposed = true,
			};
		},
	};
}

function createFixtureScheduler(container: HTMLElement): IComputerUseVideoScheduler {
	const targetWindow = getWindow(container);
	return {
		now: () => targetWindow.performance.now(),
		schedule: (callback, delay) => {
			const handle = targetWindow.setTimeout(callback, delay);
			return toDisposable(() => targetWindow.clearTimeout(handle));
		},
		animationFrame: callback => {
			const handle = targetWindow.setTimeout(() => callback(targetWindow.performance.now()), 16);
			return toDisposable(() => targetWindow.clearTimeout(handle));
		},
	};
}

/** Generates actual AVCC video; fixtures use the production WebCodecs decoder and player. */
async function encodeFixtureVideo(container: HTMLElement): Promise<{ config: IComputerUseVideoConfig; data: string } | undefined> {
	const targetWindow = getWindow(container);
	if (typeof targetWindow.VideoEncoder !== 'function' || typeof targetWindow.VideoFrame !== 'function') {
		return undefined;
	}
	const encoderConfig: VideoEncoderConfig = {
		codec: 'avc1.42001e', width: 640, height: 360, bitrate: 750_000, framerate: 30,
		avc: { format: 'avc' }, latencyMode: 'realtime',
	};
	if (!(await targetWindow.VideoEncoder.isConfigSupported(encoderConfig)).supported) {
		return undefined;
	}
	const canvas = $<HTMLCanvasElement>('canvas');
	canvas.width = 640;
	canvas.height = 360;
	const context = canvas.getContext('2d')!;
	paintFixtureFrame(context);
	let config: IComputerUseVideoConfig | undefined;
	let data: string | undefined;
	let failure: Error | undefined;
	const encoder = new targetWindow.VideoEncoder({
		output: (chunk, metadata) => {
			const decoderConfig = metadata?.decoderConfig;
			const description = decoderConfig?.description;
			if (decoderConfig && description) {
				const bytes = ArrayBuffer.isView(description)
					? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
					: new Uint8Array(description);
				config = {
					codec: decoderConfig.codec, codedWidth: 640, codedHeight: 360,
					description: encodeBase64(VSBuffer.wrap(bytes)),
				};
			}
			const bytes = new Uint8Array(chunk.byteLength);
			chunk.copyTo(bytes);
			data = encodeBase64(VSBuffer.wrap(bytes));
		},
		error: error => { failure = error; },
	});
	const store = new DisposableStore();
	store.add(toDisposable(() => {
		if (encoder.state !== 'closed') {
			encoder.close();
		}
		canvas.width = 0;
		canvas.height = 0;
	}));
	try {
		encoder.configure(encoderConfig);
		const frame = new targetWindow.VideoFrame(canvas, { timestamp: 0, duration: 33333 });
		try {
			encoder.encode(frame, { keyFrame: true });
		} finally {
			frame.close();
		}
		await encoder.flush();
		if (failure) {
			throw failure;
		}
		return config && data ? { config, data } : undefined;
	} finally {
		store.dispose();
	}
}

async function renderPlayer({ container, disposableStore, theme }: ComponentFixtureContext, state: FixtureState, narrow: boolean, follow: boolean, tracking: boolean, thought: IComputerUseSharedThought | undefined): Promise<void> {
	container.style.width = narrow ? '380px' : '820px';
	container.style.height = narrow ? '400px' : '560px';
	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: theme,
		additionalServices: registration => {
			registerWorkbenchServices(registration);
			registration.define(IMenuService, MenuService);
			registration.define(ICommandService, CommandService);
			registration.definePartialInstance(IExtensionService, {
				whenInstalledExtensionsRegistered: async () => true,
				activationEventIsDone: () => true,
				activateByEvent: async () => { },
			});
			registration.define(IContextKeyService, ContextKeyService);
			registration.define(IStorageService, InMemoryStorageService);
			registration.defineInstance(IChatWidgetService, new class extends mock<IChatWidgetService>() { });
		},
	});
	const encoded = state === 'live' || state === 'buffering' || state === 'synchronizing' || state === 'reconnecting' || state === 'paused' || state === 'completed' || state === 'stopped' || state === 'recording' || state === 'annotation' ? await encodeFixtureVideo(container) : undefined;
	const source = new FixtureVideoSource(state, encoded, () => getWindow(container).performance.now(), tracking, thought);
	const input = disposableStore.add(new ComputerUseEditorInput(
		{ providerId: 'fixture-remote-host', sessionId: 'checkout-session', chatResource: URI.from({ scheme: 'fixture-chat', path: '/checkout' }) },
		constObservable('Verify the checkout experience'),
		constObservable('Browser verification'),
		source,
		constObservable({
			message: state === 'error' ? 'Waiting for screen capture permission on Build Mac.'
				: state === 'completed' ? 'Finished verifying the order confirmation.'
					: state === 'stopped' ? 'The agent was stopped after verifying the order confirmation.'
						: 'Checking the checkout form, then selecting Continue to verify the order confirmation.',
			active: state !== 'error' && state !== 'completed' && state !== 'stopped',
		}),
	));
	const player = disposableStore.add(instantiationService.createInstance(ComputerUsePlayer, container, input, {
		...(state === 'synchronizing' ? { decoderFactory: createImmediateFixtureDecoderFactory() } : {}),
		isDocumentVisible: () => true,
		scheduler: createFixtureScheduler(container),
	}));
	if (follow) {
		player.toggleFollowAction();
	}
	if (state === 'annotation') {
		player.videoCanvas.render({
			timestamp: 0,
			width: 640,
			height: 360,
			draw: context => paintFixtureFrame(context),
			close: () => { },
		});
		player.startAnnotation();
		const targetWindow = getWindow(container);
		player.annotationCanvas.canvas.dispatchEvent(new targetWindow.KeyboardEvent('keydown', { key: ' ' }));
		for (let index = 0; index < 48; index++) {
			player.annotationCanvas.canvas.dispatchEvent(new targetWindow.KeyboardEvent('keydown', { key: 'ArrowRight' }));
		}
		player.annotationCanvas.canvas.dispatchEvent(new targetWindow.KeyboardEvent('keydown', { key: ' ' }));
		player.setVisible(true);
		return;
	}
	player.setVisible(true);
	const cancellation = new CancellationTokenSource();
	try {
		const ready = await raceTimeout(waitForState(player.video.state, current => {
			return state === 'loading' ? current.message.startsWith('Connecting')
				: state === 'buffering' ? current.phase === 'buffering'
					: state === 'synchronizing' ? current.phase === 'buffering' && current.message.startsWith('Synchronizing')
						: state === 'reconnecting' ? current.phase === 'reconnecting'
							: state === 'completed' ? current.retainedFrame === true
								: current.status === 'live' || current.status === 'error' || current.status === 'permissionRequired' || current.status === 'unsupported';
		}, undefined, cancellation.token), 2000);
		if (!ready) {
			throw new Error('The Computer Use fixture did not produce a decoded frame.');
		}
		if (state === 'paused' && ready.status === 'live') {
			player.pauseViewing();
		} else if (state === 'stopped' && ready.status === 'live') {
			await player.stopAgent();
		}
	} finally {
		cancellation.dispose(true);
	}
}

/** WebCodecs callbacks run outside the fixture's virtual clock. */
function definePlayerFixture(state: FixtureState, narrow = false, follow = false, tracking = true, thought?: IComputerUseSharedThought) {
	return defineComponentFixture({
		render: context => renderPlayer(context, state, narrow, follow, tracking, thought),
		virtualTime: { enabled: false },
		additionalThemes: narrow ? undefined : ['darkHighContrast', 'lightHighContrast'],
	});
}

export default defineThemedFixtureGroup({ path: 'sessions/computerUse/' }, {
	Loading: definePlayerFixture('loading'),
	Live: definePlayerFixture('live'),
	Buffering: definePlayerFixture('buffering'),
	Synchronizing: definePlayerFixture('synchronizing'),
	SynchronizingNarrow: definePlayerFixture('synchronizing', true),
	Reconnecting: definePlayerFixture('reconnecting'),
	Paused: definePlayerFixture('paused'),
	Stopped: definePlayerFixture('stopped'),
	Recording: definePlayerFixture('recording'),
	RecordingNarrow: definePlayerFixture('recording', true),
	Annotating: definePlayerFixture('annotation'),
	AnnotatingNarrow: definePlayerFixture('annotation', true),
	PermissionRequired: definePlayerFixture('error'),
	Narrow: definePlayerFixture('paused', true),
	FollowAction: definePlayerFixture('live', false, true),
	FollowActionNarrow: definePlayerFixture('paused', true, true),
	Thinking: definePlayerFixture('live', false, false, true, { source: 'reasoning', text: 'The document is empty. I will type the requested text now.', streaming: true }),
	ThinkingNarrow: definePlayerFixture('live', true, false, true, { source: 'activity', text: 'Reading the TextEdit window before typing.', streaming: true }),
	RecordedThought: definePlayerFixture('recording', false, false, true, { source: 'reasoning', text: 'The field is focused. I will enter the text.', streaming: false }),
	OlderHost: definePlayerFixture('live', false, true, false),
	Completed: definePlayerFixture('completed'),
	CompletedFollowAction: definePlayerFixture('completed', false, true),
});
