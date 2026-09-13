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
import { constObservable, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { IComputerUseVideoBatch, IComputerUseVideoConfig, IComputerUseVideoCursor, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../../services/sessions/common/computerUse.js';
import '../../browser/computerUseActions.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { ComputerUsePlayer } from '../../browser/computerUsePlayer.js';

type FixtureState = 'loading' | 'live' | 'paused' | 'error';

class FixtureVideoSource extends Disposable implements ISessionComputerUseVideoSource {
	readonly hostLabel = 'Build Mac · Remote Agent Host';
	private stopped = false;
	private readonly started: number;

	constructor(
		private readonly mode: FixtureState,
		private readonly encoded: { config: IComputerUseVideoConfig; data: string } | undefined,
		private readonly now: () => number,
	) {
		super();
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
		if (!this.encoded) {
			return { version: 1, status: 'error', message: 'This fixture needs a browser with H.264 encoding support to generate its sample video.' };
		}
		const latest = Math.max(1, Math.floor((this.now() - this.started) / (1000 / 30)) + 1);
		const first = cursor ? Math.max(cursor.after + 1, latest - 2) : latest;
		const frames: IComputerUseVideoFrame[] = [];
		for (let sequence = first; sequence <= latest; sequence++) {
			frames.push({
				sequence, timestamp: Math.round(sequence * 1_000_000 / 30), duration: 33333,
				keyFrame: true, data: this.encoded.data,
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

async function renderPlayer({ container, disposableStore, theme }: ComponentFixtureContext, state: FixtureState, narrow = false): Promise<void> {
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
		},
	});
	const encoded = state === 'live' || state === 'paused' ? await encodeFixtureVideo(container) : undefined;
	const source = new FixtureVideoSource(state, encoded, () => getWindow(container).performance.now());
	const input = disposableStore.add(new ComputerUseEditorInput(
		{ providerId: 'fixture-remote-host', sessionId: 'checkout-session', chatResource: URI.from({ scheme: 'fixture-chat', path: '/checkout' }) },
		constObservable('Verify the checkout experience'),
		constObservable('Browser verification'),
		source,
	));
	const player = disposableStore.add(instantiationService.createInstance(ComputerUsePlayer, container, input, undefined));
	player.setVisible(true);
	const cancellation = new CancellationTokenSource();
	try {
		const ready = await raceTimeout(waitForState(player.video.state, current => {
			return state === 'loading' ? current.message.startsWith('Connecting')
				: current.status === 'live' || current.status === 'error' || current.status === 'permissionRequired' || current.status === 'unsupported';
		}, undefined, cancellation.token), 2000);
		if (!ready) {
			throw new Error('The Computer Use fixture did not produce a decoded frame.');
		}
		if (state === 'paused' && ready.status === 'live') {
			player.pauseViewing();
		}
	} finally {
		cancellation.dispose(true);
	}
}

/** WebCodecs callbacks run outside the fixture's virtual clock. */
function definePlayerFixture(state: FixtureState, narrow = false) {
	return defineComponentFixture({
		render: context => renderPlayer(context, state, narrow),
		virtualTime: { enabled: false },
		additionalThemes: narrow ? undefined : ['darkHighContrast', 'lightHighContrast'],
	});
}

export default defineThemedFixtureGroup({ path: 'sessions/computerUse/' }, {
	Loading: definePlayerFixture('loading'),
	Live: definePlayerFixture('live'),
	Paused: definePlayerFixture('paused'),
	PermissionRequired: definePlayerFixture('error'),
	Narrow: definePlayerFixture('paused', true),
});
