/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import { URI } from '../../../../../base/common/uri.js';
import { vArray, vObj, vOptionalProp, vString } from '../../../../../base/common/validation.js';
import { buildMcpChannel } from '../../../common/mcpChannel.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputResponseKind, ToolCallCancellationReason, TurnState, type ChatInputRequest } from '../../../common/state/protocol/channels-chat/state.js';
import { type SubscribeResult } from '../../../common/state/protocol/commands.js';
import { buildChatUri, buildDefaultChatUri, MessageKind } from '../../../common/state/sessionState.js';
import type { AhpNotification } from '../../../common/state/sessionProtocol.js';
import { COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR, COPILOT_COMPUTER_USE_REMOTE_ENABLED_ENV_VAR, COPILOT_COMPUTER_USE_SERVER_NAME } from '../../../node/copilot/copilotComputerUse.js';
import { createProviderSession } from '../providerIntegrationTestHelpers.js';
import { getActionEnvelope, isActionNotification, startRealServer, stopServer, TestProtocolClient, type IMockScenario, type IServerHandle } from '../serverIntegrationTestHelpers.js';
import { isFixtureApplicationQuestion, parseVideoResource, videoReadUri, type IVideoCursor, type IVideoFixturePeer, type IVideoPeerEvidence, type NativeVideoBatch } from './copilotComputerUseVideoTestUtils.js';
import { bounded, closeOwnedProcesses, findFixtureWindow, FixtureConsent, observationTimeout, parseApplicationRows, readNativeContent, rememberOwnedProcesses, type BrowserChannel, type IFixtureWindow } from './copilotComputerUseWindowsTestUtils.js';

const operationTimeout = 25_000;
const chatSummaryValidator = vObj({
	activeTurn: vOptionalProp(vObj({ id: vString() })),
	turns: vArray(vObj({ id: vString(), state: vString() })),
});

export function isVideoCancellationAcknowledgement(notification: AhpNotification, expected: { readonly chat: string; readonly turnId: string; readonly clientId: string; readonly clientSeq: number }): boolean {
	if (!isActionNotification(notification, ActionType.ChatTurnCancelled)) {
		return false;
	}
	const envelope = getActionEnvelope(notification);
	return envelope.channel === expected.chat && envelope.action.type === ActionType.ChatTurnCancelled && envelope.action.turnId === expected.turnId
		&& envelope.origin?.clientId === expected.clientId && envelope.origin.clientSeq === expected.clientSeq && envelope.rejectionReason === undefined;
}

export function assertIdleVideoHasNoTarget(batch: NativeVideoBatch): void {
	assert.ok(batch.status === 'idle' && !batch.frames.length && batch.config === undefined
		&& batch.target === undefined && batch.streamId === undefined, 'The sibling chat must not inherit target identity, stream identity or video data');
}

function heldTextScenario(id: string, marker: string): { scenario: IMockScenario; release: () => void } {
	const chunks = Array.from({ length: 360 }, (_, index) => ({ content: `${marker}${index};`, delayMs: index === 0 ? 0 : 500 }));
	return {
		scenario: { id, definition: { type: 'multi-turn', turns: [{ kind: 'content', chunks }] } },
		// The existing fake server retains this array; truncating it releases every in-flight stream within one chunk.
		release: () => { chunks.length = 0; },
	};
}

/** Drives only public AHP and real Copilot/native processes; the sole synthetic boundary is the loopback model service. */
export class AgentHostVideoPeer implements IVideoFixturePeer {
	readonly consent = new FixtureConsent(false);
	authorizations = 0;
	readCount = 0;
	private readonly connectionToken = randomUUID();
	private readonly clientId = `native-video-${randomUUID()}`;
	private readonly guardTurn = `guard-turn-${randomUUID()}`;
	private readonly targetTurn = `target-turn-${randomUUID()}`;
	private readonly guardMarker = `fixture_guard_${randomUUID()}_`;
	private readonly targetMarker = `fixture_target_${randomUUID()}_`;
	private readonly guardScenario = heldTextScenario(`video-guard-${randomUUID()}`, this.guardMarker);
	private readonly targetScenario = heldTextScenario(`video-target-${randomUUID()}`, this.targetMarker);
	private readonly ownedProcesses = new Set<number>();
	private readonly answeredRequests = new Set<string>();
	private readonly deniedTools = new Set<string>();
	private server: IServerHandle | undefined;
	private client: TestProtocolClient | undefined;
	private workspace: string | undefined;
	private session: string | undefined;
	private guardChat: string | undefined;
	private targetChat: string | undefined;
	private target: IFixtureWindow | undefined;
	private nextClientSeq = 1;
	private targetStartedAt = 0;
	private closed = false;
	private requestsFailed = false;
	private cancelled = false;
	private siblingProgressAfterCancellation = false;
	private nativeStopInvoked = false;

	constructor(private readonly pluginPath: string, private readonly home: string) { }

	private get connectedClient(): TestProtocolClient {
		assert.ok(this.client && !this.closed, 'The authenticated fixture client must be connected');
		return this.client;
	}

	private async call<T>(method: string, params: object, timeout = operationTimeout): Promise<T> {
		assert.ok(!this.requestsFailed, 'A failed AHP request stops the scenario; no native operation will be retried');
		const client = this.connectedClient;
		try {
			return await client.call<T>(method, params, timeout);
		} catch {
			this.requestsFailed = true;
			throw new Error(`Authenticated AHP ${method} failed (payload omitted); no native operation was retried`);
		} finally {
			client.clearAhpSnapshot();
		}
	}

	private mcpCall<T>(chat: string, method: string, params: object): Promise<T> {
		return this.call(method, { ...params, channel: buildMcpChannel(URI.parse(chat), COPILOT_COMPUTER_USE_SERVER_NAME) });
	}

	async start(): Promise<void> {
		this.workspace = await mkdtemp(join(tmpdir(), 'vscode-native-ahp-workspace-'));
		if (this.closed) {
			await rm(this.workspace, { recursive: true, force: true });
			throw new Error('A disposed video fixture cannot start an Agent Host');
		}
		const environment: NodeJS.ProcessEnv = {
			VSCODE_DEV: '1',
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			OTEL_SDK_DISABLED: 'true',
			[COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR]: this.pluginPath,
			[COPILOT_COMPUTER_USE_REMOTE_ENABLED_ENV_VAR]: '1',
			COPILOT_COMPUTER_USE_HOME: join(this.home, 'computer-use'),
		};
		for (const key of Object.keys(process.env)) {
			if (key.toUpperCase() === 'GH_TOKEN' || key.toUpperCase() === 'GITHUB_TOKEN') {
				environment[key] = undefined;
			}
		}
		this.server = await startRealServer({
			homeDir: this.home,
			userDataDir: join(this.home, 'user-data'),
			connectionToken: this.connectionToken,
			mockLlm: true,
			mockScenarios: [this.guardScenario.scenario, this.targetScenario.scenario],
			logLevel: 'off',
			env: environment,
		});
		if (this.closed) {
			try {
				await stopServer(this.server);
			} finally {
				await this.server.mockLlm?.close();
			}
			throw new Error('A disposed video fixture cannot retain a late Agent Host startup');
		}
		await this.rememberProcesses();
		assert.ok(this.server.mockLlm && new URL(this.server.mockLlm.url).hostname === '127.0.0.1', 'Model and token endpoints must be the existing loopback fake service');

		for (const connectionToken of [undefined, `wrong-${this.connectionToken}`]) {
			assert.ok(!this.closed, 'A disposed fixture must not start another AHP client');
			const rejectedClient = new TestProtocolClient(this.server.port, undefined, undefined, { connectionToken });
			try {
				await assert.rejects(bounded(rejectedClient.connect(), 'Rejecting missing or incorrect AHP authentication', observationTimeout), /403/);
			} finally {
				rejectedClient.close();
			}
		}
		assert.ok(!this.closed, 'A disposed fixture must not start another AHP client');
		this.client = new TestProtocolClient(this.server.port, undefined, undefined, { connectionToken: this.connectionToken });
		await bounded(this.client.connect(), 'Connecting the authenticated AHP fixture', observationTimeout);
		const sessions: string[] = [];
		try {
			this.session = await createProviderSession(this.client, {
				provider: 'copilotcli', scheme: 'copilotcli', githubToken: 'not-a-real-token',
			}, this.clientId, sessions, URI.file(this.workspace));
		} finally {
			this.session ??= sessions[0];
			this.client.clearAhpSnapshot();
		}
		assert.ok(this.session, 'The real Copilot provider must create a session with synthetic local credentials');
		this.guardChat = buildDefaultChatUri(this.session);
		this.targetChat = buildChatUri(this.session, `video-${randomUUID()}`);
		await this.call('createChat', { channel: this.session, chat: this.targetChat });
		await this.call('subscribe', { channel: this.targetChat });
		this.consent.sessionId = this.targetChat;
		this.startTurn(this.guardChat, this.guardTurn, this.guardScenario.scenario.id);
		await this.waitForProgress(this.guardChat, this.guardTurn, this.guardMarker, 0);
		this.targetStartedAt = performance.now();
		this.startTurn(this.targetChat, this.targetTurn, this.targetScenario.scenario.id);
		await this.waitForProgress(this.targetChat, this.targetTurn, this.targetMarker, 0);
		this.assertConsent();
		await this.rememberProcesses();
	}

	private startTurn(chat: string, turnId: string, scenario: string): void {
		this.connectedClient.dispatch({
			channel: chat,
			clientSeq: this.nextClientSeq++,
			action: {
				type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
				message: { text: `[scenario:${scenario}] Stream only the fixture heartbeat; do not call tools.`, origin: { kind: MessageKind.User } },
			},
		});
	}

	private progress(chat: string, turnId: string, marker: string): number {
		const text = this.connectedClient.receivedNotifications().flatMap(notification => {
			if (!isActionNotification(notification, ActionType.ChatDelta)) {
				return [];
			}
			const envelope = getActionEnvelope(notification);
			const action = envelope.action;
			return envelope.channel === chat && action.type === ActionType.ChatDelta && action.turnId === turnId ? [action.content] : [];
		}).join('');
		const matches = [...text.matchAll(new RegExp(`${escapeRegExpCharacters(marker)}(?<sequence>\\d+);`, 'g'))];
		return matches.length ? Number(matches[matches.length - 1].groups?.sequence) : -1;
	}

	private async waitForProgress(chat: string, turnId: string, marker: string, minimum: number): Promise<void> {
		await this.connectedClient.waitForNotification(notification => !this.closed && isActionNotification(notification, ActionType.ChatDelta)
			&& getActionEnvelope(notification).channel === chat && this.progress(chat, turnId, marker) >= minimum, 30_000);
	}

	async rememberProcesses(): Promise<void> {
		if (this.server?.process.pid !== undefined) {
			await rememberOwnedProcesses(this.server.process.pid, this.ownedProcesses);
		}
	}

	async discover(title: string, channel: BrowserChannel): Promise<{ target: IFixtureWindow; guard: IFixtureWindow }> {
		assert.ok(this.targetChat);
		const result = readNativeContent(await this.mcpCall(this.targetChat, 'tools/call', { name: 'list_apps', arguments: {} }));
		assert.ok(!result.isError && !result.images.length, 'Authenticated native discovery must return text without failure or media (listing omitted)');
		const rows = parseApplicationRows(result.text);
		const target = findFixtureWindow(rows, `${title} target`, channel);
		const guard = findFixtureWindow(rows, `${title} guard`, channel);
		assert.ok(target.app === guard.app && target.window !== guard.window, 'AHP discovery must distinguish the two owned windows');
		this.target = this.consent.target = target;
		this.assertConsent();
		await this.rememberProcesses();
		return { target, guard };
	}

	private answerInput(chat: string, request: ChatInputRequest, accept: boolean): void {
		this.answeredRequests.add(request.id);
		this.connectedClient.dispatch({
			channel: chat,
			clientSeq: this.nextClientSeq++,
			action: {
				type: ActionType.ChatInputCompleted, requestId: request.id,
				response: accept ? ChatInputResponseKind.Accept : ChatInputResponseKind.Decline,
				...(accept ? {
					answers: { choice: { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Selected, value: 'allow' } } },
				} : {}),
			},
		});
	}

	private denyUnexpected(notification: AhpNotification): void {
		const envelope = getActionEnvelope(notification);
		const action = envelope.action;
		if (action.type === ActionType.ChatInputRequested && !this.answeredRequests.has(action.request.id)) {
			this.consent.counts.unexpected++;
			this.answerInput(envelope.channel, action.request, false);
		} else if (action.type === ActionType.ChatToolCallReady && !action.confirmed && !this.deniedTools.has(action.toolCallId)) {
			this.deniedTools.add(action.toolCallId);
			this.consent.counts.permissions++;
			this.connectedClient.dispatch({
				channel: envelope.channel, clientSeq: this.nextClientSeq++,
				action: {
					type: ActionType.ChatToolCallConfirmed, turnId: action.turnId, toolCallId: action.toolCallId,
					approved: false, reason: ToolCallCancellationReason.Denied,
				},
			});
		}
	}

	async authorize(target: IFixtureWindow, title: string): Promise<void> {
		assert.ok(this.targetChat && target === this.target, 'Only the exact discovered fixture may be authorized');
		this.assertConsent();
		assert.strictEqual(this.consent.activeOperation, undefined, 'AHP fixture authorization must be serial');
		this.consent.activeOperation = { app: target.app, window: target.window, tool: 'get_window_state' };
		const response = this.mcpCall(this.targetChat, 'tools/call', {
			name: 'get_window_state',
			arguments: { app: target.app, window: target.window, capture_mode: 'text', mode: 'full', request_budget_ms: 15_000 },
		});
		try {
			const first = await Promise.race([
				response.then(result => ({ kind: 'result' as const, result })),
				this.connectedClient.waitForNotification(notification =>
					isActionNotification(notification, ActionType.ChatInputRequested)
					|| isActionNotification(notification, ActionType.ChatToolCallReady), operationTimeout)
					.then(notification => ({ kind: 'question' as const, notification })),
			]);
			assert.ok(first.kind === 'question', 'Native authorization must request fixture application consent through AHP before completing (result omitted)');
			const envelope = getActionEnvelope(first.notification);
			const action = envelope.action;
			if (envelope.channel !== this.targetChat || action.type !== ActionType.ChatInputRequested || !isFixtureApplicationQuestion(action.request, target)) {
				this.denyUnexpected(first.notification);
				throw new Error('Unexpected AHP consent request was declined; no native action will be retried');
			}
			this.answerInput(this.targetChat, action.request, true);
			this.consent.counts.appAllowed++;
			const result = readNativeContent(await response);
			assert.ok(!result.isError && !result.images.length && result.text.includes(title), 'AHP authorization must return a successful text snapshot of the exact fixture (payload omitted)');
			this.authorizations++;
			await this.rememberProcesses();
		} finally {
			this.consent.activeOperation = undefined;
			this.assertConsent();
		}
	}

	assertConsent(): void {
		if (this.client && !this.closed) {
			for (const notification of this.client.receivedNotifications()) {
				if (isActionNotification(notification, ActionType.ChatInputRequested) || isActionNotification(notification, ActionType.ChatToolCallReady)) {
					this.denyUnexpected(notification);
				}
			}
		}
		assert.deepStrictEqual({
			unexpected: this.consent.counts.unexpected,
			permissions: this.consent.counts.permissions,
			foreground: this.consent.counts.foregroundAllowed,
		}, { unexpected: 0, permissions: 0, foreground: 0 }, 'The AHP fixture accepts only its exact application question, never other prompts or persistent grants');
	}

	async read(cursor?: IVideoCursor): Promise<NativeVideoBatch> {
		assert.ok(this.targetChat);
		this.readCount++;
		const uri = videoReadUri(cursor);
		const batch = parseVideoResource(await this.mcpCall(this.targetChat, 'resources/read', { uri }), uri);
		this.assertConsent();
		return batch;
	}

	async assertSiblingVideoIdle(): Promise<void> {
		assert.ok(this.guardChat);
		const uri = videoReadUri();
		this.readCount++;
		const batch = parseVideoResource(await this.mcpCall(this.guardChat, 'resources/read', { uri }), uri);
		assertIdleVideoHasNoTarget(batch);
	}

	private async chatSummary(chat: string) {
		const result = await this.call<SubscribeResult>('subscribe', { channel: chat });
		const summary = chatSummaryValidator.validate(result.snapshot?.state).content;
		assert.ok(summary, 'AHP must return a current chat snapshot (contents omitted)');
		return summary;
	}

	async stopNative(): Promise<void> {
		assert.ok(this.targetChat);
		const stop = readNativeContent(await this.mcpCall(this.targetChat, 'tools/call', { name: 'stop_computer_use', arguments: {} }));
		assert.ok(!stop.isError && !stop.images.length, 'App-only Stop must succeed through the authenticated AHP MCP side channel');
		const stopped = await this.read();
		assert.ok(stopped.status === 'stopped' && !stopped.frames.length && !stopped.config, 'Native Stop must clear media before ordinary host cancellation');
		this.nativeStopInvoked = true;
	}

	async cancelExactChat(checkVideoRevoked: () => Promise<void>): Promise<void> {
		assert.ok(this.targetChat && this.guardChat);
		const cancelSeq = this.nextClientSeq++;
		this.connectedClient.dispatch({
			channel: this.targetChat,
			clientSeq: cancelSeq,
			action: { type: ActionType.ChatTurnCancelled, turnId: this.targetTurn, duration: Math.round(performance.now() - this.targetStartedAt) },
		});
		const acknowledgement = { chat: this.targetChat, turnId: this.targetTurn, clientId: this.clientId, clientSeq: cancelSeq };
		await this.connectedClient.waitForNotification(notification => isVideoCancellationAcknowledgement(notification, acknowledgement), operationTimeout);
		await checkVideoRevoked();
		const guardProgress = this.progress(this.guardChat, this.guardTurn, this.guardMarker);
		assert.ok(guardProgress >= 0, 'The sibling must have an actual SDK response before cancellation');
		await this.waitForProgress(this.guardChat, this.guardTurn, this.guardMarker, guardProgress + 3);
		const target = await this.chatSummary(this.targetChat);
		const guard = await this.chatSummary(this.guardChat);
		assert.deepStrictEqual({
			targetActive: target.activeTurn?.id,
			targetState: target.turns.find(turn => turn.id === this.targetTurn)?.state,
			guardActive: guard.activeTurn?.id,
			guardCancelled: this.connectedClient.receivedNotifications(notification =>
				isActionNotification(notification, ActionType.ChatTurnCancelled) && getActionEnvelope(notification).channel === this.guardChat).length,
		}, { targetActive: undefined, targetState: TurnState.Cancelled, guardActive: this.guardTurn, guardCancelled: 0 });
		const modelRequests = this.server?.mockLlm?.getRequests?.();
		assert.ok(modelRequests && modelRequests.length >= 2, 'Both turns must have reached the real SDK and loopback fake model POST endpoint');
		this.cancelled = true;
		this.siblingProgressAfterCancellation = true;
		this.assertConsent();
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.guardScenario.release();
		this.targetScenario.release();
		try {
			await this.rememberProcesses();
		} finally {
			try {
				if (this.client && this.session) {
					await bounded(this.client.call('disposeSession', { channel: this.session }, 10_000), 'Disposing the owned AHP session', 10_000);
				}
			} finally {
				this.client?.clearAhpSnapshot();
				this.client?.close();
				try {
					await closeOwnedProcesses(this.ownedProcesses, () => stopServer(this.server), 35_000);
				} finally {
					try {
						if (this.server?.mockLlm) {
							await bounded(this.server.mockLlm.close(), 'Closing the loopback fake model service', observationTimeout);
						}
					} finally {
						if (this.workspace) {
							await rm(this.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
						}
					}
				}
			}
		}
	}

	getEvidence(): IVideoPeerEvidence {
		return {
			boundary: 'authenticated-agent-host', consent: this.consent.counts, authorizations: this.authorizations,
			reads: this.readCount, fakeModelRequests: this.server?.mockLlm?.getRequests?.().length,
			cancelledChat: this.cancelled ? this.targetChat : undefined,
			cancelledTurn: this.cancelled ? this.targetTurn : undefined,
			siblingProgressAfterCancellation: this.siblingProgressAfterCancellation,
			nativeStopInvoked: this.nativeStopInvoked,
		};
	}
}
