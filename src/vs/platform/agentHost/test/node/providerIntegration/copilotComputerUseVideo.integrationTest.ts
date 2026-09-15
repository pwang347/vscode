/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import { createRequire } from 'module';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// eslint-disable-next-line local/code-import-patterns -- This opt-in desktop test uses the existing root Playwright dev dependency.
import type { Browser, BrowserContext, JSHandle, Page } from '@playwright/test';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { join, resolve } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { vArray, vObj, vString } from '../../../../../base/common/validation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../../common/agentHostTelemetry.js';
import { getAppNodeModulesUri } from '../../../node/appNodeModules.js';
import { createCopilotCliEnvironment } from '../../../node/copilot/copilotCliEnvironment.js';
import { COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR, COPILOT_COMPUTER_USE_SERVER_NAME, resolveCopilotComputerUsePlugin } from '../../../node/copilot/copilotComputerUse.js';
import { createIsolatedProviderEnvironment } from '../providerTestEnvironment.js';
import { assertInterruptedTypingResult, assertPartialNativeTyping, assertTypingUnchangedAfterStop, createTypingProbe, nativeTypingStopTestsEnabled, typingPayloadLength, typingQuietWindowMs, type ITypingInterruptionObservation, type ITypingProbe, type ITypingSample } from './copilotComputerUseTypingTestUtils.js';
import { ahpVideoTestsEnabled, createBrowserVideoDecoder, liveVideoUri, nativeVideoTestsEnabled, parseVideoResource, videoReadUri, type IBrowserVideoDecoder, type IDecodedVideoFrame, type IVideoCursor, type IVideoFixturePeer, type IVideoPeerEvidence, type NativeVideoBatch } from './copilotComputerUseVideoTestUtils.js';
import { applicationTitleValidator, bounded, closeOwnedProcesses, createCaptureMarker, findElementIndex, findFixtureWindow, FixtureConsent, getPlaywright, observationTimeout, parseApplicationRows, readNativeContent, rememberOwnedProcesses, type BrowserChannel, type CaptureMarker, type IFixtureWindow, type INativeArguments, type INativeContent } from './copilotComputerUseWindowsTestUtils.js';

const enabled = nativeVideoTestsEnabled(process.platform, process.env);
const requestOptions = { timeout: 25_000 };
const stopVisibilityValidator = vObj({ ui: vObj({ visibility: vArray(vString()) }) });
type Lifecycle = 'assistant.turn_start' | 'assistant.turn_end' | 'user.abort' | 'assistant.abort';

function loadMcpSdk() {
	const require = createRequire(import.meta.url);
	return {
		client: require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js'),
		stdio: require('@modelcontextprotocol/sdk/client/stdio.js') as typeof import('@modelcontextprotocol/sdk/client/stdio.js'),
		types: require('@modelcontextprotocol/sdk/types.js') as typeof import('@modelcontextprotocol/sdk/types.js'),
	};
}

class NativeVideoPeer implements IVideoFixturePeer {
	readonly consent = new FixtureConsent(false);
	readonly sessionId = randomUUID();
	readonly ownedProcesses = new Set<number>();
	private readonly sdk = loadMcpSdk();
	private readonly client: Client;
	private readonly transport: StdioClientTransport;
	private protocolFailed = false;
	private closed = false;
	private abortWaiter: DeferredPromise<void> | undefined;
	private stopRequested = false;
	private inputSnapshot: string | undefined;
	private typingInterruption: ITypingInterruptionObservation | undefined;
	private discovery: IVideoPeerEvidence['discovery'];
	abortNotifications = 0;
	readCount = 0;
	authorizations = 0;

	constructor(pluginPath: string, home: string, private readonly allowFixtureInput = false) {
		const environment = createCopilotCliEnvironment(createIsolatedProviderEnvironment(home), ['GH_TOKEN', 'GITHUB_TOKEN']);
		environment.AUTO_APPROVAL = 'false';
		environment.COPILOT_COMPUTER_USE_HOME = join(home, 'computer-use');
		environment.TEMP = home;
		environment.TMP = home;
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(environment)) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
		this.transport = new this.sdk.stdio.StdioClientTransport({
			command: join(pluginPath, 'computer-use-mcp.exe'),
			args: [],
			cwd: home,
			env,
			stderr: 'ignore',
		});
		this.client = new this.sdk.client.Client({ name: 'vscode-native-video-regression', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
		this.consent.sessionId = this.sessionId;
		this.client.onerror = () => { this.protocolFailed = true; };
		this.client.setRequestHandler(this.sdk.types.ElicitRequestSchema, request => {
			if (request.params.mode === 'url' || this.stopRequested) {
				this.consent.counts.unexpected++;
				return { action: 'decline' };
			}
			return {
				...this.consent.respond({
					...request.params,
					sessionId: this.sessionId,
					elicitationSource: COPILOT_COMPUTER_USE_SERVER_NAME,
				})
			};
		});
		this.client.fallbackNotificationHandler = async notification => {
			if (notification.method === 'notifications/copilot' && notification.params?.type === 'user.abort') {
				this.abortNotifications++;
				await this.abortWaiter?.complete();
			}
		};
	}

	private async request<T>(operation: string, run: () => Promise<T>): Promise<T> {
		assert.ok(!this.closed && !this.protocolFailed, 'Native MCP transport failed; no further operations may be sent');
		try {
			const result = await bounded(run(), operation);
			assert.ok(!this.protocolFailed, 'Native MCP transport reported a protocol error');
			return result;
		} catch {
			this.protocolFailed = true;
			throw new Error(`${operation} failed or timed out (RPC payload omitted); no native action was retried`);
		}
	}

	async start(): Promise<void> {
		await this.request('Initializing the isolated native MCP session', () => this.client.connect(this.transport, requestOptions));
		await this.rememberProcesses();
	}

	async rememberProcesses(): Promise<void> {
		if (this.transport.pid !== null) {
			await rememberOwnedProcesses(this.transport.pid, this.ownedProcesses);
		}
	}

	async verifyMetadata(): Promise<void> {
		const { resources } = await this.request('Listing native video resource metadata', () => this.client.listResources({}, requestOptions));
		const { tools } = await this.request('Listing app-only stop metadata', () => this.client.listTools({}, requestOptions));
		const stop = tools.find(tool => tool.name === 'stop_computer_use');
		assert.ok(stop, 'The native helper must advertise stop_computer_use');
		assert.deepStrictEqual({
			resource: resources.some(resource => resource.uri === liveVideoUri && resource.mimeType === 'application/json'),
			visibility: stopVisibilityValidator.validate(stop._meta).content?.ui.visibility,
			arguments: Object.keys(stop.inputSchema.properties ?? {}),
			additionalProperties: stop.inputSchema.additionalProperties,
		}, { resource: true, visibility: ['app'], arguments: [], additionalProperties: false });
	}

	async discover(title: string, channel: BrowserChannel): Promise<{ target: IFixtureWindow; guard: IFixtureWindow }> {
		const listing = readNativeContent(await this.request('Discovering only owned fixture windows', () => this.client.callTool({ name: 'list_apps', arguments: {} }, undefined, requestOptions)));
		assert.ok(!listing.isError && listing.images.length === 0, 'Native discovery must not fail or capture images (listing omitted)');
		const rows = parseApplicationRows(listing.text);
		this.discovery = {
			expectedTitlePrefix: title, rowCount: rows.length,
			fixtureTitles: rows.flatMap(row => {
				const candidate = applicationTitleValidator.validate(row).content?.title;
				return candidate?.includes(title) ? [candidate.slice(0, 256)] : [];
			}).slice(0, 4),
		};
		assert.ok(rows.length > 0, 'Native discovery returned no application rows; check that the Windows session is connected and unlocked (listing omitted)');
		const target = findFixtureWindow(rows, `${title} target`, channel);
		const guard = findFixtureWindow(rows, `${title} guard`, channel);
		assert.ok(target.app === guard.app && target.window !== guard.window, 'Native discovery must identify distinct fixture windows in the same browser process');
		this.consent.target = target;
		await this.rememberProcesses();
		return { target, guard };
	}

	async lifecycle(type: Lifecycle): Promise<void> {
		await this.request(`Sending native ${type}`, async () => {
			await this.client.notification({ method: 'notifications/copilot', params: { type } });
			// Video reads use an out-of-band thread; ping is a barrier for the main-thread lifecycle handler.
			await this.client.ping(requestOptions);
		});
	}

	async authorize(target: IFixtureWindow, title: string): Promise<void> {
		assert.strictEqual(this.consent.activeOperation, undefined, 'Fixture authorization must be serial');
		this.consent.target = target;
		this.consent.activeOperation = { app: target.app, window: target.window, tool: 'get_window_state' };
		try {
			const result = readNativeContent(await this.request('Authorizing the exact native target', () => this.client.callTool({
				name: 'get_window_state',
				arguments: { app: target.app, window: target.window, capture_mode: 'text', mode: 'full', request_budget_ms: 15_000 },
			}, undefined, requestOptions)));
			assert.ok(!result.isError && result.images.length === 0 && result.text.includes(title), 'Authorization requires a successful consented text snapshot of the exact fixture (payload omitted)');
			assert.ok(this.consent.counts.appAllowed > 0, 'A fresh native session must obtain fixture-bound, session-local application consent');
			if (this.allowFixtureInput) {
				this.inputSnapshot = result.text;
			}
			this.authorizations++;
			await this.rememberProcesses();
		} finally {
			this.consent.activeOperation = undefined;
			this.assertConsent();
		}
	}

	assertConsent(): void {
		assert.ok(!this.protocolFailed, 'Native MCP transport reported a protocol error (payload omitted)');
		if (this.allowFixtureInput) {
			assert.deepStrictEqual({
				unexpected: this.consent.counts.unexpected, permissions: this.consent.counts.permissions,
			}, { unexpected: 0, permissions: 0 }, 'Input consent must remain bound to the exact active fixture operation');
		} else {
			assert.deepStrictEqual({
				unexpected: this.consent.counts.unexpected,
				foreground: this.consent.counts.foregroundAllowed,
				permissions: this.consent.counts.permissions,
			}, { unexpected: 0, foreground: 0, permissions: 0 }, 'Only the exact fixture application consent may be accepted by this read-only native scenario');
		}
	}

	inputElementIndex(): number {
		assert.ok(this.allowFixtureInput && this.inputSnapshot, 'Input requires the successful fixture-bound native snapshot');
		return findElementIndex(this.inputSnapshot, 'AXTextField', 'input');
	}

	private async input<K extends 'click' | 'type_text'>(tool: K, args: INativeArguments[K]): Promise<INativeContent> {
		const target = this.consent.target;
		assert.ok(this.allowFixtureInput && !this.stopRequested && target && this.consent.counts.appAllowed > 0, 'Only an authorized fixture may receive native input, and never after Stop');
		assert.strictEqual(this.consent.activeOperation, undefined, 'Native input operations must be serial');
		this.consent.activeOperation = { app: target.app, window: target.window, tool };
		try {
			const result = readNativeContent(await this.request(`Native fixture ${tool}`, () => this.client.callTool({
				name: tool,
				arguments: { ...args, app: target.app, window: target.window, capture_mode: 'text' },
			}, undefined, requestOptions)));
			assert.ok(!result.images.length, 'Native fixture input must not return media');
			return result;
		} finally {
			this.consent.activeOperation = undefined;
			this.assertConsent();
		}
	}

	async clickInput(elementIndex: number): Promise<void> {
		const result = await this.input('click', { element_index: elementIndex });
		assert.ok(!result.isError, 'Native fixture click failed; no input may be retried (payload omitted)');
	}

	typeInput(elementIndex: number, text: string): Promise<INativeContent> {
		return this.input('type_text', { element_index: elementIndex, text });
	}

	recordTypingInterruption(observation: ITypingInterruptionObservation): void {
		this.typingInterruption = observation;
	}

	async read(cursor?: IVideoCursor): Promise<NativeVideoBatch> {
		const uri = videoReadUri(cursor);
		this.readCount++;
		const resource = await this.request('Reading native encoded video', () => this.client.readResource({ uri }, requestOptions));
		const batch = parseVideoResource(resource, uri);
		this.assertConsent();
		return batch;
	}

	async rejectResource(uri: string): Promise<void> {
		let rejected = false;
		try {
			await bounded(this.client.readResource({ uri }, requestOptions), 'Rejecting a malformed video resource');
		} catch (error) {
			if (error instanceof this.sdk.types.McpError && error.code === this.sdk.types.ErrorCode.InvalidParams) {
				rejected = true;
			} else {
				throw new Error('Malformed video resource must fail with InvalidParams (RPC payload omitted)');
			}
		}
		assert.ok(rejected, 'The viewer must reject target selectors and malformed cursors, not return a video batch');
		this.assertConsent();
	}

	async stop(): Promise<number> {
		this.stopRequested = true;
		this.abortWaiter = new DeferredPromise<void>();
		try {
			const result = readNativeContent(await this.request('Stopping native Computer Use from the app', () => this.client.callTool({ name: 'stop_computer_use', arguments: {} }, undefined, requestOptions)));
			const acknowledgedAt = Date.now();
			assert.ok(!result.isError && result.images.length === 0, 'Native Stop must succeed without media; failures stop the scenario');
			await bounded(this.abortWaiter.p, 'Receiving the native user.abort notification', observationTimeout);
			return acknowledgedAt;
		} finally {
			this.abortWaiter = undefined;
		}
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			await this.rememberProcesses();
		} finally {
			await closeOwnedProcesses(this.ownedProcesses, () => this.client.close());
		}
	}

	getEvidence(): IVideoPeerEvidence {
		return {
			boundary: 'native-mcp', consent: this.consent.counts, authorizations: this.authorizations,
			reads: this.readCount, nativeAbortNotifications: this.abortNotifications,
			typingInterruption: this.typingInterruption,
			discovery: this.discovery,
		};
	}
}

interface IVideoObservation {
	readonly streamId: string;
	readonly codec: string;
	readonly width: number;
	readonly height: number;
	readonly decodedFrames: number;
	readonly encodedFrames: number;
	readonly droppedBatches: number;
	readonly phases: readonly number[];
	readonly firstSequence: number;
	readonly lastSequence: number;
	readonly firstTimestamp: number;
	readonly lastTimestamp: number;
	readonly cadence: number;
	readonly elapsedMs: number;
}

async function readGuard(page: Page) {
	return bounded(page.locator('#guard').evaluate((input: HTMLInputElement) => ({
		value: input.value,
		selection: [input.selectionStart, input.selectionEnd],
		focused: document.activeElement === input,
		foreground: document.hasFocus(),
		visibility: document.visibilityState,
		inputEvents: document.body.dataset.inputEvents,
	})), 'Observing the guard window', observationTimeout);
}

class VideoFixture<T extends IVideoFixturePeer = NativeVideoPeer> {
	readonly observations: IVideoObservation[] = [];
	cursor: IVideoCursor | undefined;

	constructor(
		readonly page: Page,
		readonly viewer: Page,
		readonly target: IFixtureWindow,
		readonly guard: IFixtureWindow,
		readonly title: string,
		readonly browser: Browser,
		readonly targetBrowserWindowId: number,
		readonly decoder: JSHandle<IBrowserVideoDecoder>,
		public peer: T,
		private readonly guardState: Awaited<ReturnType<typeof readGuard>>,
	) { }

	async assertGuard(): Promise<void> {
		assert.deepStrictEqual(await readGuard(this.viewer), this.guardState, 'Video reads must leave guard input, selection, event counts and actual Windows focus unchanged');
		if (!this.page.isClosed()) {
			assert.ok(!await bounded(this.page.evaluate(() => document.hasFocus()), 'Observing target focus', observationTimeout), 'The native target must remain in the background');
		}
		this.peer.assertConsent();
	}

	async assertGuardInput(): Promise<void> {
		const current = await readGuard(this.viewer);
		assert.deepStrictEqual({
			value: current.value, selection: current.selection, focused: current.focused, inputEvents: current.inputEvents,
		}, {
			value: this.guardState.value, selection: this.guardState.selection, focused: this.guardState.focused, inputEvents: this.guardState.inputEvents,
		}, 'Native typing must never change the guard input, even during an authorized foreground fallback');
		this.peer.assertConsent();
	}

	async authorize(): Promise<void> {
		await this.assertGuard();
		await this.peer.authorize(this.target, this.title);
		await this.assertGuard();
	}

	async read(cursor = this.cursor): Promise<NativeVideoBatch> {
		const visibility = await bounded(Promise.all([
			this.viewer.locator('#viewer').isVisible(),
			this.viewer.evaluate(() => document.visibilityState === 'visible'),
		]), 'Observing viewer visibility', observationTimeout);
		assert.ok(visibility.every(visible => visible), 'Native video reads require a visible fixture viewer');
		const batch = await this.peer.read(cursor);
		if (batch.target) {
			assert.ok((batch.target.app === this.target.app || batch.target.app === this.target.name)
				&& batch.target.windowId === this.target.window
				&& (batch.target.title === this.target.title || batch.target.title === this.title),
				'Video must stay bound to the exact consented fixture, never the guard or another application (identity omitted)');
		}
		if (batch.frames.length) {
			assert.ok(batch.streamId, 'A live batch must identify its stream');
			if (cursor?.streamId === batch.streamId) {
				assert.ok(batch.frames[0].sequence > cursor.after, 'Cursor reads must not replay previously consumed encoded frames');
			}
			this.cursor = { streamId: batch.streamId, after: batch.frames[batch.frames.length - 1].sequence };
		}
		return batch;
	}

	async cleared(statuses: readonly NativeVideoBatch['status'][]): Promise<void> {
		const batch = await this.read();
		assert.ok(statuses.includes(batch.status) && batch.frames.length === 0 && batch.config === undefined, 'Revoked/stopped video must immediately clear encoded frames and decoder configuration (payload omitted)');
		await this.assertGuard();
	}

	async waitForHostCancellation(): Promise<void> {
		const deadline = Date.now() + observationTimeout;
		while (Date.now() < deadline) {
			const batch = await this.read();
			assert.ok(batch.status !== 'error' && batch.status !== 'permissionRequired', 'Host cancellation must revoke video, not hide a native error or policy refusal');
			if ((batch.status === 'idle' || batch.status === 'stopped') && !batch.frames.length && !batch.config && !batch.target && !batch.streamId) {
				await this.cleared(['idle', 'stopped']);
				return;
			}
			await timeout(100);
		}
		assert.fail('Ordinary AHP cancellation must revoke native video within five seconds while reads keep the viewer lease alive');
	}

	async collect(differentFrom?: string, minimumFrames = 6): Promise<IVideoObservation> {
		const started = Date.now();
		const frames: IDecodedVideoFrame[] = [];
		const phases = new Set<number>();
		let firstBatch: NativeVideoBatch | undefined;
		let encodedFrames = 0;
		let droppedBatches = 0;
		let lastTimestamp = -1;
		await this.decoder.evaluate((decoder, freshStream) => {
			if (freshStream) {
				decoder.reset();
			} else {
				decoder.takeFrames();
			}
		}, differentFrom !== undefined);
		while (Date.now() - started < 12_000) {
			const batch = await this.read();
			assert.ok(batch.status === 'starting' || batch.status === 'live', `Native video did not become live (${batch.status}; payload omitted)`);
			if (batch.frames.length && batch.streamId !== differentFrom) {
				if (!firstBatch) {
					assert.ok(batch.frames[0].keyFrame, 'The first batch of a fresh stream must contain a keyframe and avcC');
					firstBatch = batch;
				}
				assert.ok(batch.streamId === firstBatch.streamId, 'A visible, unchanged fixture must not continually replace its video stream');
				for (const frame of batch.frames) {
					assert.ok(frame.timestamp > lastTimestamp, 'Presentation timestamps must increase across resource batches');
					lastTimestamp = frame.timestamp;
				}
				encodedFrames += batch.frames.length;
				droppedBatches += Number(batch.dropped);
				await bounded(this.decoder.evaluate((decoder, batch) => decoder.decode(batch), batch), 'Submitting native AVCC to real WebCodecs');
			}
			await timeout(100);
			const decoded = await bounded(this.decoder.evaluate(decoder => decoder.takeFrames()), 'Inspecting actual decoded video frames');
			for (const frame of decoded) {
				assert.ok(frame.phase >= 0 && !frame.containsGuard && frame.width > 64 && frame.height > 48,
					'Every decoded frame must contain a nonce-specific target marker and no guard marker');
				const previous = frames[frames.length - 1];
				assert.ok(!previous || (frame.sequence > previous.sequence && frame.timestamp > previous.timestamp), 'Decoded output must advance, not replay a stale frame');
				frames.push(frame);
				phases.add(frame.phase);
			}
			if (frames.length >= minimumFrames && phases.size >= 3 && frames[frames.length - 1].timestamp - frames[0].timestamp >= 1_000_000) {
				break;
			}
		}
		assert.ok(firstBatch?.streamId && firstBatch.config && frames.length >= minimumFrames && phases.size >= 3,
			`Expected at least ${minimumFrames} real decoded frames and three animated marker phases within 12 seconds (media omitted)`);
		const first = frames[0];
		const last = frames[frames.length - 1];
		const span = last.timestamp - first.timestamp;
		const cadence = (frames.length - 1) * 1_000_000 / span;
		assert.ok(span >= 1_000_000 && cadence >= 3, 'Animated native video must span at least one second at a meaningful decoded cadence (at least 3 FPS, not an exact 30 FPS)');
		const observation: IVideoObservation = {
			streamId: firstBatch.streamId,
			codec: firstBatch.config.codec,
			width: first.width,
			height: first.height,
			decodedFrames: frames.length,
			encodedFrames,
			droppedBatches,
			phases: [...phases].sort(),
			firstSequence: first.sequence,
			lastSequence: last.sequence,
			firstTimestamp: first.timestamp,
			lastTimestamp: last.timestamp,
			cadence,
			elapsedMs: Date.now() - started,
		};
		this.observations.push(observation);
		await this.assertGuard();
		return observation;
	}

	async resize(): Promise<void> {
		const before = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		const connection = await bounded(this.browser.newBrowserCDPSession(), 'Connecting to the owned browser for resize', observationTimeout);
		try {
			await bounded(connection.send('Browser.setWindowBounds', { windowId: this.targetBrowserWindowId, bounds: { width: 980, height: 760 } }), 'Resizing only the owned target window');
		} finally {
			await bounded(connection.detach(), 'Detaching the resize connection', observationTimeout);
		}
		await getPlaywright().expect.poll(() => this.page.evaluate(() => ({ width: innerWidth, height: innerHeight })), {
			timeout: observationTimeout, message: 'The owned target viewport must actually resize',
		}).not.toEqual(before);
		await this.assertGuard();
	}
}

async function runTypingInterruption(fixture: VideoFixture): Promise<void> {
	const chunk = `vscode_typing_${randomUUID().replace(/-/g, '')}_`;
	const text = chunk.repeat(Math.ceil(typingPayloadLength / chunk.length)).slice(0, typingPayloadLength);
	let probe: JSHandle<ITypingProbe> | undefined;
	type TypingOutcome = { readonly kind: 'result'; readonly result: INativeContent } | { readonly kind: 'rpcFailure' };
	let settled: TypingOutcome | undefined;
	let typing: Promise<TypingOutcome> | undefined;
	let stopAttempted = false;
	try {
		probe = await bounded(fixture.page.evaluateHandle(createTypingProbe, text), 'Installing the fixture-only typing observer');
		const typingProbe = probe;
		const read = () => bounded(typingProbe.evaluate(probe => probe.read()), 'Observing native fixture typing', observationTimeout);
		const initial = await read();
		assert.ok(initial.length === 0 && initial.inputEvents === 0, 'The typing fixture must start empty without synthetic input');
		await fixture.peer.lifecycle('assistant.turn_start');
		await fixture.authorize();
		await fixture.collect();
		const index = fixture.peer.inputElementIndex();
		await fixture.peer.clickInput(index);
		assert.ok((await read()).focused, 'The native click must focus the exact fixture input');
		await fixture.assertGuard();

		typing = fixture.peer.typeInput(index, text).then(result => {
			settled = { kind: 'result', result };
			return settled;
		}, () => {
			settled = { kind: 'rpcFailure' };
			return settled;
		});
		const partialDeadline = Date.now() + observationTimeout;
		let partial: ITypingSample | undefined;
		while (Date.now() < partialDeadline) {
			assert.ok(settled === undefined, 'The long native input must still be in flight before Stop; early results/refusals fail the scenario');
			const sample = await read();
			await fixture.assertGuardInput();
			if (sample.length >= 32) {
				assertPartialNativeTyping(sample, text.length);
				partial = sample;
				break;
			}
			await timeout(25);
		}
		assert.ok(partial, 'Native typing must produce an observable partial prefix within five seconds');
		const duringInput = await bounded(fixture.read(), 'Reading video while the native input actor is busy', 1500);
		assert.ok(duringInput.status === 'live' || duringInput.status === 'starting', 'The separate viewer pipe must remain responsive during native typing');
		assert.ok(settled === undefined, 'Stop must be sent before the long native type_text result has completed');

		stopAttempted = true;
		const stopRequestedAt = Date.now();
		const acknowledgedAt = await bounded(fixture.peer.stop(), 'Acknowledging Stop during native typing', observationTimeout);
		const acknowledged = await read();
		assertPartialNativeTyping(acknowledged, text.length);
		assertTypingUnchangedAfterStop(acknowledged, acknowledged, acknowledgedAt);
		await fixture.assertGuard();
		const quietUntil = Date.now() + typingQuietWindowMs;
		let current = acknowledged;
		while (Date.now() < quietUntil) {
			await timeout(50);
			current = await read();
			assertTypingUnchangedAfterStop(acknowledged, current, acknowledgedAt);
			await fixture.assertGuard();
		}
		const outcome = await bounded(typing, 'Settling the interrupted native type_text', observationTimeout);
		assert.ok(outcome.kind === 'result', 'Interrupted native typing must return a tool result, not lose its RPC (payload omitted)');
		assertInterruptedTypingResult(outcome.result);
		current = await read();
		assertTypingUnchangedAfterStop(acknowledged, current, acknowledgedAt);
		await fixture.cleared(['stopped']);
		assert.strictEqual(fixture.peer.abortNotifications, 1, 'The in-flight Stop must emit exactly one native user.abort');
		fixture.peer.recordTypingInterruption({
			requestedLength: text.length, beforeStopLength: partial.length,
			acknowledgedLength: acknowledged.length, finalLength: current.length,
			inputEventsAtAcknowledgement: acknowledged.inputEvents, inputEventsAfterQuietWindow: current.inputEvents,
			quietWindowMs: typingQuietWindowMs, stopAcknowledgementMs: acknowledgedAt - stopRequestedAt,
			nativeResultIsError: outcome.result.isError,
		});
	} finally {
		try {
			if (typing && !stopAttempted) {
				stopAttempted = true;
				await bounded(fixture.peer.stop(), 'Stopping an unfinished fixture input during cleanup', observationTimeout);
			}
		} finally {
			if (probe) {
				try {
					await bounded(probe.evaluate(probe => probe.dispose()), 'Removing the fixture typing observer', observationTimeout);
				} finally {
					await bounded(probe.dispose(), 'Releasing the fixture typing observer', observationTimeout);
				}
			}
		}
	}
}

function fixtureHtml(title: string, guard: boolean): string {
	return `<!doctype html><html lang="en"><head><title>${title}</title></head>
		<body data-input-events="0"><h1>${title}</h1>
		<canvas id="marker" width="384" height="72" role="img" aria-label="${guard ? 'Guard' : 'Animated target'} nonce marker"></canvas>
		${guard ? `<p><label for="guard">Untouched guard input</label><input id="guard" value="${title} unchanged"></p>
		<section id="viewer" aria-label="Native video regression decoder"><p>Fixture-only video decoder</p></section>` : '<p>Only this synthetic window may be authorized for video.</p>'}
		</body></html>`;
}

async function startFixtureOrigin(server: Server): Promise<string> {
	await bounded(new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	}), 'Starting the loopback fixture origin', observationTimeout);
	const address = server.address();
	assert.ok(address && typeof address !== 'string', 'The fixture origin must bind only a loopback TCP port');
	return `http://127.0.0.1:${address.port}`;
}

async function createPages(context: BrowserContext, browser: Browser, origin: string, id: string, markers: { target: readonly CaptureMarker[]; guard: CaptureMarker }): Promise<{ target: Page; guard: Page; windowId: number }> {
	context.setDefaultTimeout(observationTimeout);
	await context.route('**/*', route => route.request().url() === `${origin}/${id}/target` || route.request().url() === `${origin}/${id}/guard` ? route.continue() : route.abort());
	const target = context.pages()[0] ?? await context.newPage();
	await target.goto(`${origin}/${id}/target`);
	const connection = await bounded(browser.newBrowserCDPSession(), 'Connecting to the owned fixture browser', observationTimeout);
	let guard: Page;
	const windowIds: number[] = [];
	try {
		const targetConnection = await bounded(context.newCDPSession(target), 'Connecting to the owned target page', observationTimeout);
		let browserContextId: string | undefined;
		try {
			const { targetInfo } = await bounded(targetConnection.send('Target.getTargetInfo'), 'Identifying the fixture browser context', observationTimeout);
			browserContextId = targetInfo.browserContextId;
		} finally {
			await bounded(targetConnection.detach(), 'Detaching the target page connection', observationTimeout);
		}
		[guard] = await Promise.all([
			context.waitForEvent('page'),
			bounded(connection.send('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true, background: true, width: 720, height: 640 }), 'Creating the owned guard window'),
		]);
		await guard.goto(`${origin}/${id}/guard`);
		for (const [index, page] of [target, guard].entries()) {
			const pageConnection = await bounded(context.newCDPSession(page), 'Connecting to an owned fixture page', observationTimeout);
			try {
				await bounded(pageConnection.send('Emulation.setFocusEmulationEnabled', { enabled: false }), 'Disabling default Playwright focus emulation');
				const { windowId } = await bounded(pageConnection.send('Browser.getWindowForTarget'), 'Identifying an owned browser window', observationTimeout);
				windowIds.push(windowId);
				await bounded(connection.send('Browser.setWindowBounds', { windowId, bounds: { left: 40 + index * 740, top: 40, width: 720, height: 640 } }), 'Positioning only owned fixture windows');
			} finally {
				await bounded(pageConnection.detach(), 'Detaching a fixture page connection', observationTimeout);
			}
		}
	} finally {
		await bounded(connection.detach(), 'Detaching the fixture browser connection', observationTimeout);
	}
	assert.notStrictEqual(windowIds[0], windowIds[1], 'The video fixture requires two distinct native windows, not two tabs');
	for (const [page, phases] of [[target, markers.target], [guard, [markers.guard]]] as const) {
		await page.locator('#marker').evaluate((canvas: HTMLCanvasElement, phases) => {
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('The fixture needs a marker canvas');
			}
			let phase = 0;
			const draw = () => {
				for (const [index, color] of phases[phase].entries()) {
					context.fillStyle = `rgb(${color.join(',')})`;
					context.fillRect(index * 24, 0, 24, canvas.height);
				}
				phase = (phase + 1) % phases.length;
			};
			draw();
			if (phases.length > 1) {
				setInterval(draw, 100);
			}
		}, phases);
	}
	await guard.evaluate(() => {
		let count = 0;
		for (const event of ['input', 'keydown', 'pointerdown', 'wheel']) {
			document.addEventListener(event, () => { document.body.dataset.inputEvents = String(++count); }, true);
		}
	});
	await guard.bringToFront();
	await guard.locator('#guard').evaluate((input: HTMLInputElement) => {
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	});
	await getPlaywright().expect.poll(async () => ({
		target: await target.evaluate(() => document.hasFocus()),
		guard: await guard.evaluate(() => document.hasFocus()),
	}), { timeout: observationTimeout, message: 'Only the guard may be foreground' }).toEqual({ target: false, guard: true });
	return { target, guard, windowId: windowIds[0] };
}

async function withFixture<T extends IVideoFixturePeer>(channel: BrowserChannel, name: string, logService: NullLogService, run: (fixture: VideoFixture<T>, replacePeer: () => Promise<void>) => Promise<void>, createPeerInstance: (pluginPath: string, home: string) => T): Promise<void> {
	assert.ok(enabled, 'Native video requires Windows and both explicit native/video opt-ins');
	assert.ok(!process.versions.electron || process.env['ELECTRON_RUN_AS_NODE'] === '1', 'Use the existing Node runner, never the Electron renderer runner, for Playwright');
	assert.ok(!process.env['DEBUG'] && !process.env['PWDEBUG'], 'Disable protocol/debug tracing so encoded media cannot be written to logs');
	assert.ok(!Object.keys(process.env).some(key => key.toUpperCase().startsWith('COPILOT_COMPUTER_USE_TEST_')
		|| key.toUpperCase() === 'COPILOT_COMPUTER_USE_PLATFORM_SERVICE_EXPECTED_PID'), 'Remove native test bypasses and external helper endpoints before running real capture coverage');
	const { createServer } = await import('http');
	const cliPath = URI.joinPath(getAppNodeModulesUri(), '@github', `copilot-${process.platform}-${process.arch}`, 'index.js').fsPath;
	const pluginPath = await resolveCopilotComputerUsePlugin({
		cliPath, platform: process.platform, hostLaunchKind: AgentHostLaunchKind.VSCodeMainProcess, isBuilt: false,
		developmentPluginPath: process.env[COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR],
	}, logService);
	assert.ok(pluginPath, 'The complete native Computer Use bundle must be available');
	const buildDirectory = join(process.cwd(), '.build');
	await mkdir(buildDirectory, { recursive: true });
	const home = await mkdtemp(join(buildDirectory, `computer-use-video-${channel}-`));
	const id = `vscode-native-${randomUUID()}`;
	const markers = { target: Array.from({ length: 6 }, () => createCaptureMarker(randomUUID())), guard: createCaptureMarker(randomUUID()) };
	const server = createServer((request, response) => {
		const isTarget = request.url === `/${id}/target`;
		const isGuard = request.url === `/${id}/guard`;
		if (request.method !== 'GET' || (!isTarget && !isGuard)) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': 'default-src \'none\'; frame-ancestors \'none\'',
		});
		response.end(fixtureHtml(`${id} ${isGuard ? 'guard' : 'target'}`, isGuard));
	});
	let context: BrowserContext | undefined;
	let peer: T | undefined;
	let decoder: JSHandle<IBrowserVideoDecoder> | undefined;
	let fixture: VideoFixture<T> | undefined;
	let evidence: string | undefined;
	let browserPid: number | undefined;
	let disposing = false;
	const browserProcesses = new Set<number>();
	const peers: T[] = [];
	try {
		const outputDirectory = process.env['VSCODE_COMPUTER_USE_VIDEO_OUTPUT_DIR'];
		if (outputDirectory) {
			const outputRoot = resolve(outputDirectory);
			await mkdir(outputRoot, { recursive: true });
			evidence = await mkdtemp(join(outputRoot, `${channel}-${name}-`));
		}
		const origin = await startFixtureOrigin(server);
		const browserTemp = join(home, 'browser-temp');
		await mkdir(browserTemp);
		const browserEnvironment: NodeJS.ProcessEnv = { ...process.env, TEMP: browserTemp, TMP: browserTemp };
		for (const key of Object.keys(browserEnvironment)) {
			if (key.toUpperCase() === 'GH_TOKEN' || key.toUpperCase() === 'GITHUB_TOKEN') {
				delete browserEnvironment[key];
			}
		}
		context = await getPlaywright().chromium.launchPersistentContext(join(home, 'browser-profile'), {
			channel: channel === 'msedge' ? 'msedge' : undefined,
			headless: false, chromiumSandbox: true, viewport: null, serviceWorkers: 'block', acceptDownloads: false,
			downloadsPath: join(home, 'downloads'), env: browserEnvironment, args: ['--force-renderer-accessibility'], timeout: 20_000,
		});
		const browser = context.browser();
		assert.ok(browser, 'The fixture must own a fresh browser process and profile');
		const connection = await bounded(browser.newBrowserCDPSession(), 'Connecting to the owned browser process', observationTimeout);
		try {
			const { processInfo } = await bounded(connection.send('SystemInfo.getProcessInfo'), 'Identifying the owned browser process');
			browserPid = processInfo.find(process => process.type === 'browser')?.id;
			assert.ok(browserPid && Number.isSafeInteger(browserPid), 'The fixture must track its browser PID for failure cleanup');
			await rememberOwnedProcesses(browserPid, browserProcesses);
		} finally {
			await bounded(connection.detach(), 'Detaching the browser process connection', observationTimeout);
		}
		const pages = await bounded(createPages(context, browser, origin, id, markers), 'Creating isolated video fixture windows', 30_000);
		decoder = await bounded(pages.guard.evaluateHandle(createBrowserVideoDecoder, markers), 'Initializing real browser WebCodecs');
		const createPeer = async () => {
			assert.ok(!disposing, 'A timed-out fixture must not start another native session');
			const nativeHome = await mkdtemp(join(home, 'native-session-'));
			assert.ok(!disposing, 'A timed-out fixture must not start another native session');
			peer = createPeerInstance(pluginPath, nativeHome);
			peers.push(peer);
			await bounded(peer.start(), 'Starting the isolated video fixture provider', 60_000);
			return peer;
		};
		peer = await createPeer();
		// A viewer read before discovery/consent must not launch or authorize a target.
		const idle = await peer.read();
		assert.ok(idle.status === 'idle' && !idle.frames.length && peer.consent.counts.appAllowed === 0, 'Opening the idle resource must not grant application access');
		await peer.rememberProcesses();
		const windows = await peer.discover(id, channel);
		const currentFixture = fixture = new VideoFixture(pages.target, pages.guard, windows.target, windows.guard, `${id} target`, browser, pages.windowId, decoder, peer, await readGuard(pages.guard));
		await bounded(run(currentFixture, async () => {
			await currentFixture.peer.close();
			const next = await createPeer();
			currentFixture.peer = next;
			const discovered = await next.discover(id, channel);
			assert.deepStrictEqual(discovered, windows, 'A replacement session must rediscover exactly the same owned windows');
		}), 'Running the native video scenario', 90_000);
		await fixture.assertGuard();
	} finally {
		disposing = true;
		try {
			if (evidence) {
				await writeFile(join(evidence, 'video-summary.json'), JSON.stringify({
					target: fixture?.target,
					guard: fixture?.guard,
					observations: fixture?.observations ?? [],
					sessions: peers.map(peer => peer.getEvidence()),
				}, undefined, '\t'));
			}
		} finally {
			try {
				await peer?.close();
			} finally {
				try {
					if (decoder) {
						try {
							await bounded(decoder.evaluate(decoder => decoder.close()), 'Closing native browser decoders', observationTimeout);
						} finally {
							await bounded(decoder.dispose(), 'Releasing the browser decoder handle', observationTimeout);
						}
					}
				} finally {
					try {
						try {
							if (browserPid) {
								await rememberOwnedProcesses(browserPid, browserProcesses);
							}
						} finally {
							await closeOwnedProcesses(browserProcesses, async () => { await context?.close(); });
						}
					} finally {
						try {
							server.closeAllConnections();
							if (server.listening) {
								await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 'Closing the fixture origin', observationTimeout);
							}
						} finally {
							await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
						}
					}
				}
			}
		}
	}
}

(enabled ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use Windows Video (native boundary)', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const channels: readonly BrowserChannel[] = process.env['VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST'] === '1' ? ['chromium', 'msedge'] : ['chromium'];
	const filter = enabled && process.env['VSCODE_COMPUTER_USE_VIDEO_GREP'] ? new RegExp(process.env['VSCODE_COMPUTER_USE_VIDEO_GREP']) : undefined;
	for (const channel of channels) {
		suite(channel, function () {
			this.timeout(240_000);
			this.retries(0);

			function scenario(name: string, run: (fixture: VideoFixture, replacePeer: () => Promise<void>) => Promise<void>): void {
				(!filter || filter.test(`${channel} ${name}`) ? test : test.skip)(name, async () => withFixture(channel, name, store.add(new NullLogService()), run, (pluginPath, home) => new NativeVideoPeer(pluginPath, home)));
			}

			scenario('idle-resource-and-rejected-selectors', async fixture => {
				await fixture.peer.verifyMetadata();
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.cleared(['idle']);
				for (const query of [`window=${fixture.guard.window}`, `windowId=${fixture.guard.window}`, `app=${encodeURIComponent(fixture.guard.app)}`, 'after=1', 'streamId=first&streamId=second', 'streamId=first&after=-1', 'streamId=first&after=0&after=1']) {
					await fixture.peer.rejectResource(`${liveVideoUri}?${query}`);
				}
				await fixture.cleared(['idle']);
				assert.strictEqual(fixture.peer.consent.counts.appAllowed, 0, 'Neither resource reads nor lifecycle notifications may approve an application');
			});

			scenario('encoded-cadence-and-target-only-pixels', async fixture => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				await fixture.collect(undefined, 12);
				await fixture.peer.rejectResource(`${videoReadUri(fixture.cursor)}&window=${fixture.guard.window}`);
			});

			scenario('resize-resets-config-and-keyframe', async fixture => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				const before = await fixture.collect();
				await fixture.resize();
				const after = await fixture.collect(before.streamId);
				assert.ok(after.streamId !== before.streamId && (after.width !== before.width || after.height !== before.height), 'An actual target resize must yield a new stream and changed decoded dimensions');
			});

			scenario('hidden-viewer-expires-and-resumes', async fixture => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				const before = await fixture.collect();
				const reads = fixture.peer.readCount;
				await fixture.viewer.locator('#viewer').evaluate((element: HTMLElement) => { element.hidden = true; });
				await assert.rejects(() => fixture.read(), /visible fixture viewer/);
				await timeout(3_600);
				assert.strictEqual(fixture.peer.readCount, reads, 'A hidden viewer must make no native resource reads for longer than the three-second TTL');
				await fixture.viewer.locator('#viewer').evaluate((element: HTMLElement) => { element.hidden = false; });
				await fixture.collect(before.streamId);
				assert.strictEqual(fixture.peer.authorizations, 1, 'Resuming within the active control lease must not manufacture a new target authorization');
			});

			scenario('app-stop-latches-and-emits-user-abort', async fixture => {
				await fixture.peer.verifyMetadata();
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				await fixture.collect();
				await fixture.peer.stop();
				await fixture.cleared(['stopped']);
				await fixture.cleared(['stopped']);
				assert.strictEqual(fixture.peer.abortNotifications, 1, 'App Stop must emit the real native user.abort notification');
			});

			scenario('turn-end-requires-new-authorization', async fixture => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				const before = await fixture.collect();
				await fixture.peer.lifecycle('assistant.turn_end');
				await fixture.cleared(['idle']);
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.cleared(['idle']);
				await fixture.authorize();
				await fixture.collect(before.streamId);
				assert.strictEqual(fixture.peer.authorizations, 2, 'A new turn must successfully perceive the target again before it can stream');
			});

			for (const lifecycle of ['user.abort', 'assistant.abort'] as const) {
				scenario(`${lifecycle}-revokes-video`, async fixture => {
					await fixture.peer.lifecycle('assistant.turn_start');
					await fixture.authorize();
					await fixture.collect();
					await fixture.peer.lifecycle(lifecycle);
					await fixture.cleared(['stopped']);
					await fixture.peer.lifecycle('assistant.turn_start');
					await fixture.cleared(['idle']);
				});
			}

			scenario('closed-target-never-redirects-to-guard', async fixture => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				await fixture.collect();
				await fixture.page.close();
				await fixture.cleared(['stopped', 'idle', 'permissionRequired', 'error']);
				await fixture.cleared(['stopped', 'idle', 'permissionRequired', 'error']);
			});

			scenario('session-replacement-clears-authorization', async (fixture, replacePeer) => {
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.authorize();
				const before = await fixture.collect();
				await replacePeer();
				await fixture.cleared(['idle']);
				await fixture.peer.lifecycle('assistant.turn_start');
				await fixture.cleared(['idle']);
				assert.strictEqual(fixture.peer.consent.counts.appAllowed, 0, 'The replacement native session must not inherit the old application grant');
				await fixture.authorize();
				await fixture.collect(before.streamId);
			});
		});
	}
});

const ahpEnabled = ahpVideoTestsEnabled(process.platform, process.env);
(ahpEnabled ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use Windows Video (authenticated AHP)', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const channels: readonly BrowserChannel[] = process.env['VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST'] === '1' ? ['chromium', 'msedge'] : ['chromium'];
	const filter = ahpEnabled && process.env['VSCODE_COMPUTER_USE_VIDEO_GREP'] ? new RegExp(process.env['VSCODE_COMPUTER_USE_VIDEO_GREP']) : undefined;
	for (const channel of channels) {
		suite(channel, function () {
			this.timeout(240_000);
			this.retries(0);
			for (const nativeStop of [true, false]) {
				const name = nativeStop ? 'authenticated-ahp-video-and-exact-chat-stop' : 'authenticated-ahp-host-cancellation-revokes-video';
				(!filter || filter.test(`${channel} ${name}`) ? test : test.skip)(name, async () => {
					const { AgentHostVideoPeer } = await import('./copilotComputerUseVideoAhpTestPeer.js');
					await withFixture<InstanceType<typeof AgentHostVideoPeer>>(channel, name, store.add(new NullLogService()), async fixture => {
						await fixture.authorize();
						await fixture.collect(undefined, 12);
						await fixture.peer.assertSiblingVideoIdle();
						if (nativeStop) {
							await fixture.peer.stopNative();
						}
						await fixture.peer.cancelExactChat(() => fixture.waitForHostCancellation());
						await fixture.cleared(nativeStop ? ['stopped'] : ['idle', 'stopped']);
						await fixture.peer.assertSiblingVideoIdle();
					}, (pluginPath, home) => new AgentHostVideoPeer(pluginPath, home));
				});
			}
		});
	}
});

const typingStopEnabled = nativeTypingStopTestsEnabled(process.platform, process.env);
(typingStopEnabled ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use Windows Stop During Input', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const channels: readonly BrowserChannel[] = process.env['VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST'] === '1' ? ['chromium', 'msedge'] : ['chromium'];
	const filter = typingStopEnabled && process.env['VSCODE_COMPUTER_USE_VIDEO_GREP'] ? new RegExp(process.env['VSCODE_COMPUTER_USE_VIDEO_GREP']) : undefined;
	for (const channel of channels) {
		suite(channel, function () {
			this.timeout(240_000);
			this.retries(0);
			const name = 'stop-interrupts-native-typing';
			(!filter || filter.test(`${channel} ${name}`) ? test : test.skip)(name, async () => {
				await withFixture(channel, name, store.add(new NullLogService()), runTypingInterruption,
					(pluginPath, home) => new NativeVideoPeer(pluginPath, home, true));
			});
		});
	}
});
