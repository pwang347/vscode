/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { timeout } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { AgentSession } from '../../common/agent.js';
import { IAgentHostChatContributions } from '../../common/agentHostChatContributionsService.js';
import { parseComputerUseRecordingManifestJson } from '../../common/computerUseRecording.js';
import { buildMcpChannel } from '../../common/mcpChannel.js';
import { readAgentSystemNotificationMeta } from '../../common/meta/agentSystemNotificationMeta.js';
import { ISessionDataService, type IWillDeleteSessionDataEvent } from '../../common/sessionDataService.js';
import { ActionType, type StateAction } from '../../common/state/sessionActions.js';
import { buildChatUri, buildDefaultChatUri, isMessageRequestHiddenFromTranscript, MessageKind, ResponsePartKind, SessionStatus, type Turn } from '../../common/state/sessionState.js';
import { AgentHostChatContributions } from '../../node/agentHostChatContributionsService.js';
import { IAgentHostLocalTurns } from '../../node/agentHostLocalTurns.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../node/agentHostStateManager.js';
import { IAgentHostProviderService } from '../../node/agentHostProviderService.js';
import { ComputerUseRecordingContribution } from '../../node/chatContributions/computerUseRecording/computerUseRecordingContribution.js';
import { createNullSessionDataService } from '../common/sessionTestHelpers.js';
import { createTestAgentHostProviderService } from './testAgentHostProviderService.js';

interface IRecordedLocalTurn {
	readonly session: string;
	readonly chat: string;
	readonly turn: Turn;
	readonly anchorTurnId: string | undefined;
}

class RecordingLocalTurns implements IAgentHostLocalTurns {
	declare readonly _serviceBrand: undefined;
	readonly records: IRecordedLocalTurn[] = [];

	isLocal(): boolean {
		return false;
	}

	findAnchorTurnId(_chat: string, turns: readonly Turn[], turnId: string): string | undefined {
		return turns[turns.findIndex(turn => turn.id === turnId) - 1]?.id;
	}

	record(session: string, chat: string, turn: Turn, anchorTurnId: string | undefined): void {
		this.records.push({ session, chat, turn, anchorTurnId });
	}
}

interface IProviderRequest {
	readonly channel: string;
	readonly method: string;
	readonly params: Record<string, unknown> | undefined;
}

function liveResource() {
	return {
		contents: [{
			uri: 'computer-use://video/live',
			mimeType: 'application/json',
			text: JSON.stringify({
				version: 1,
				status: 'live',
				streamId: 'stream',
				target: { app: 'Code', windowId: 7, title: 'Editor' },
				config: {
					codec: 'avc1.64001f',
					codedWidth: 1280,
					codedHeight: 720,
					description: Buffer.from([1, 2, 3, 4]).toString('base64'),
				},
				frames: [{
					sequence: 1,
					timestamp: 0,
					duration: 33_333,
					keyFrame: true,
					data: Buffer.from([1, 2, 3]).toString('base64'),
				}],
			}),
		}],
	};
}

const idleResource = {
	contents: [{
		uri: 'computer-use://video/live',
		mimeType: 'application/json',
		text: '{"version":1,"status":"idle"}',
	}],
};

function ready(turnId: string, mcpServerName = 'computer-use'): StateAction {
	return {
		type: ActionType.ChatToolCallReady,
		turnId,
		toolCallId: `tool-${turnId}`,
		invocationMessage: 'Use the computer',
		_meta: { mcpServerName },
	};
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!await predicate()) {
		if (Date.now() >= deadline) {
			assert.fail(message);
		}
		await timeout(10);
	}
}

suite('Computer Use Recording Contribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const temporaryRoots: string[] = [];

	teardown(async () => {
		await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	function createHarness(response: () => unknown) {
		const root = URI.file(join(tmpdir(), `vscode-computer-use-contribution-${Date.now()}-${Math.random().toString(16).slice(2)}`));
		temporaryRoots.push(root.fsPath);
		const directories = new Map<string, URI>();
		const getSessionDataDir = (resource: URI): URI => {
			let directory = directories.get(resource.toString());
			if (!directory) {
				directory = URI.joinPath(root, `session-${directories.size + 1}`);
				directories.set(resource.toString(), directory);
			}
			return directory;
		};
		const sessionDataListeners = new Set<(event: IWillDeleteSessionDataEvent) => unknown>();
		const onWillDeleteSessionData: ISessionDataService['onWillDeleteSessionData'] = (listener, _thisArgs, listenerDisposables) => {
			sessionDataListeners.add(listener);
			const disposable = { dispose: () => sessionDataListeners.delete(listener) };
			if (Array.isArray(listenerDisposables)) {
				listenerDisposables.push(disposable);
			} else {
				listenerDisposables?.add(disposable);
			}
			return disposable;
		};
		const dataService: ISessionDataService = {
			...createNullSessionDataService(),
			getSessionDataDir,
			onWillDeleteSessionData,
			deleteSessionData: async resource => {
				const pending: Promise<unknown>[] = [];
				const event: IWillDeleteSessionDataEvent = {
					session: resource,
					workingDirectories: undefined,
					waitUntil: promise => pending.push(promise),
				};
				for (const listener of sessionDataListeners) {
					listener(event);
				}
				await Promise.allSettled(pending);
				await fs.rm(getSessionDataDir(resource).fsPath, { recursive: true, force: true });
			},
		};
		const requests: IProviderRequest[] = [];
		const providerService: IAgentHostProviderService = {
			...createTestAgentHostProviderService(() => undefined),
			handleMcpRequest: async (channel, method, params) => {
				requests.push({ channel, method, params });
				return response();
			},
		};
		const logService = new NullLogService();
		const stateManager = disposables.add(new AgentHostStateManager(logService));
		const localTurns = new RecordingLocalTurns();
		const services = new ServiceCollection(
			[ILogService, logService],
			[IAgentHostStateManager, stateManager],
			[IAgentHostProviderService, providerService],
			[ISessionDataService, dataService],
			[IAgentHostLocalTurns, localTurns],
		);
		const instantiationService = disposables.add(new InstantiationService(services, true));
		const contributions: IAgentHostChatContributions = disposables.add(new AgentHostChatContributions(logService, instantiationService));
		services.set(IAgentHostChatContributions, contributions);
		disposables.add(contributions.registerContribution(ComputerUseRecordingContribution));
		return { contributions, dataService, directories, localTurns, requests, root, stateManager };
	}

	function createSession(stateManager: AgentHostStateManager, id: string) {
		const session = AgentSession.uri('copilot', id).toString();
		stateManager.createSession({
			resource: session,
			provider: 'copilot',
			title: id,
			status: SessionStatus.IsRead,
			createdAt: '2026-09-14T20:00:00.000Z',
			modifiedAt: '2026-09-14T20:00:00.000Z',
		});
		return { session, chat: buildDefaultChatUri(session) };
	}

	function startTurn(stateManager: AgentHostStateManager, chat: string, turnId: string): void {
		stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: '2026-09-14T20:00:00.000Z',
			message: { text: 'Control the computer', origin: { kind: MessageKind.User } },
		});
	}

	test('starts once for the exact chat and turn, then queues its durable notice until that chat is idle', async () => {
		const harness = createHarness(liveResource);
		const { session, chat } = createSession(harness.stateManager, 'exact-turn');
		startTurn(harness.stateManager, chat, 'turn-1');
		assert.strictEqual(harness.stateManager.getActiveTurnId(chat), 'turn-1');
		const reasoning = {
			type: ActionType.ChatReasoning,
			turnId: 'turn-1',
			partId: 'reasoning',
			content: 'The document is empty. I will type now.',
		} as const;
		harness.stateManager.dispatchServerAction(chat, reasoning);
		harness.contributions.didDispatchAction({ channel: chat, session, action: reasoning });

		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('wrong-turn') });
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1', 'other-server') });
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1') });
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1') });
		await waitFor(() => harness.requests.length === 1, 'The recorder did not issue its first host-side read.');
		harness.stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatResponsePart,
			turnId: 'turn-1',
			part: { kind: ResponsePartKind.Markdown, id: 'final-summary', content: 'Opened an untitled TextEdit document.' },
		});

		harness.contributions.turnEnd({ session, channel: chat, turnId: 'turn-1', reason: { kind: 'success' } });
		await waitFor(async () => {
			const recordings = URI.joinPath(harness.dataService.getSessionDataDir(URI.parse(session)), 'computer-use-recordings');
			const chatKeys = await fs.readdir(recordings.fsPath).catch(() => []);
			return chatKeys.length === 1
				&& await fs.readdir(URI.joinPath(recordings, chatKeys[0]).fsPath).then(entries => entries.length === 1, () => false);
		}, 'The recording did not finalize while the chat remained active.');
		assert.strictEqual(harness.localTurns.records.length, 0);

		const complete = { type: ActionType.ChatTurnComplete, turnId: 'turn-1', duration: 100 } as const;
		harness.stateManager.dispatchServerAction(chat, complete);
		harness.contributions.didDispatchAction({ channel: chat, session, action: complete });
		await waitFor(() => harness.localTurns.records.length === 1, 'The queued recording notice was not published when the exact chat became idle.');
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1') });
		await timeout(20);

		const record = harness.localTurns.records[0];
		const part = record.turn.responseParts[0];
		if (part.kind !== ResponsePartKind.SystemNotification) {
			assert.fail('Expected a Computer Use recording system notification.');
		}
		const meta = readAgentSystemNotificationMeta(part);
		const recordingUri = URI.parse(meta.recordingUri ?? '');
		const manifest = parseComputerUseRecordingManifestJson(await fs.readFile(recordingUri.fsPath, 'utf8'));
		const sessionDataDirectory = harness.dataService.getSessionDataDir(URI.parse(session));
		assert.deepStrictEqual({
			requests: harness.requests,
			localTurn: {
				session: record.session,
				chat: record.chat,
				anchorTurnId: record.anchorTurnId,
				requestHidden: isMessageRequestHiddenFromTranscript(record.turn.message),
				messageOrigin: record.turn.message.origin.kind,
				partKind: part.kind,
				meta: {
					kind: meta.kind,
					title: meta.recordingTitle,
					recordingInsideSession: recordingUri.scheme === 'file' && recordingUri.path.startsWith(`${sessionDataDirectory.path}/computer-use-recordings/`),
					durationMs: meta.durationMs,
					sizeBytesPositive: (meta.sizeBytes ?? 0) > 0,
					trimmed: meta.trimmed,
				},
				thoughts: manifest.thoughts?.map(thought => ({
					source: thought.source,
					text: thought.text,
					streaming: thought.streaming,
				})),
			},
		}, {
			requests: [{
				channel: buildMcpChannel(URI.parse(chat), 'computer-use'),
				method: 'resources/read',
				params: { uri: 'computer-use://video/live' },
			}],
			localTurn: {
				session,
				chat,
				anchorTurnId: 'turn-1',
				requestHidden: true,
				messageOrigin: MessageKind.SystemNotification,
				partKind: ResponsePartKind.SystemNotification,
				meta: {
					kind: 'computerUseRecording',
					title: 'Opened an untitled TextEdit document.',
					recordingInsideSession: true,
					durationMs: 34,
					sizeBytesPositive: true,
					trimmed: false,
				},
				thoughts: [{
					source: 'reasoning',
					text: 'The document is empty. I will type now.',
					streaming: false,
				}],
			},
		});
	});

	test('publishes no notice when cancelled or errored turns store no decodable frame', async () => {
		const harness = createHarness(() => idleResource);
		for (const [index, reason] of [
			{ kind: 'cancelled' } as const,
			{ kind: 'error', error: { errorType: 'internalError', message: 'failed' }, resumable: false } as const,
	].entries()) {
			const { session, chat } = createSession(harness.stateManager, `empty-${index}`);
			const turnId = `turn-${index}`;
			startTurn(harness.stateManager, chat, turnId);
			harness.contributions.didDispatchAction({ channel: chat, session, action: ready(turnId) });
			await waitFor(() => harness.requests.length === index + 1, 'The empty recording did not poll.');
			harness.stateManager.dispatchServerAction(chat, reason.kind === 'error' ? {
				type: ActionType.ChatError,
				turnId,
				duration: 0,
				part: { kind: ResponsePartKind.Error, error: reason.error, resumable: reason.resumable },
			} : {
				type: ActionType.ChatTurnCancelled,
				turnId,
				duration: 0,
			});
			harness.contributions.turnEnd({ session, channel: chat, turnId, reason });
		}
		await waitFor(async () => {
			for (const directory of harness.directories.values()) {
				const recordings = URI.joinPath(directory, 'computer-use-recordings');
				for (const chatKey of await fs.readdir(recordings.fsPath).catch(() => [])) {
					if (await fs.readdir(URI.joinPath(recordings, chatKey).fsPath).then(entries => entries.length > 0, () => false)) {
						return false;
					}
				}
			}
			return true;
		}, 'An empty recording directory remained after finalization.');

		assert.deepStrictEqual({
			requestCount: harness.requests.length,
			localTurns: harness.localTurns.records,
		}, {
			requestCount: 2,
			localTurns: [],
		});
	});

	test('keeps recording across a resumable provider error', async () => {
		const harness = createHarness(liveResource);
		const { session, chat } = createSession(harness.stateManager, 'resumable');
		startTurn(harness.stateManager, chat, 'turn-1');
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1') });
		await waitFor(() => harness.requests.length === 1, 'The resumable recording did not start.');

		harness.contributions.turnEnd({
			session,
			channel: chat,
			turnId: 'turn-1',
			reason: { kind: 'error', error: { errorType: 'requestFailed', message: 'retry' }, resumable: true },
		});
		await waitFor(() => harness.requests.length >= 2, 'The recorder stopped on a resumable provider error.');
		assert.strictEqual(harness.localTurns.records.length, 0);

		const error = {
			type: ActionType.ChatError,
			turnId: 'turn-1',
			duration: 0,
			part: {
				kind: ResponsePartKind.Error,
				error: { errorType: 'requestFailed', message: 'failed' },
				resumable: false,
			},
		} as const;
		harness.stateManager.dispatchServerAction(chat, error);
		harness.contributions.turnEnd({
			session,
			channel: chat,
			turnId: 'turn-1',
			reason: { kind: 'error', error: error.part.error, resumable: false },
		});
		await waitFor(() => harness.localTurns.records.length === 1, 'The recording did not finalize after the logical turn ended.');
	});

	test('archive finalizes active recorders and deletes only the session recording tree', async () => {
		const harness = createHarness(liveResource);
		const { session, chat } = createSession(harness.stateManager, 'archive');
		const peer = buildChatUri(session, 'peer');
		harness.stateManager.addChat(session, peer, { title: 'Peer' });
		startTurn(harness.stateManager, chat, 'turn-1');
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('turn-1') });
		await waitFor(() => harness.requests.length === 1, 'The archive recording did not start.');

		const dataDirectory = harness.dataService.getSessionDataDir(URI.parse(session));
		const recordings = URI.joinPath(dataDirectory, 'computer-use-recordings');
		await fs.mkdir(URI.joinPath(recordings, 'stale-chat', 'stale-recording').fsPath, { recursive: true });
		await fs.mkdir(dataDirectory.fsPath, { recursive: true });
		await fs.writeFile(URI.joinPath(dataDirectory, 'keep.txt').fsPath, 'keep');
		const archive = { type: ActionType.SessionIsArchivedChanged, isArchived: true } as const;
		harness.contributions.didDispatchAction({ channel: session, session, action: archive, rejectionReason: 'rejected' });
		assert.ok(await fs.readdir(recordings.fsPath));

		harness.stateManager.dispatchServerAction(session, archive);
		harness.contributions.didDispatchAction({ channel: session, session, action: archive });
		await waitFor(() => fs.access(recordings.fsPath).then(() => false, () => true), 'Archive did not remove the session recording directory.');

		assert.deepStrictEqual({
			kept: await fs.readFile(URI.joinPath(dataDirectory, 'keep.txt').fsPath, 'utf8'),
			localTurns: harness.localTurns.records,
		}, {
			kept: 'keep',
			localTurns: [],
		});
	});

	test('restoring an archived chat removes recordings left by an interrupted cleanup', async () => {
		const harness = createHarness(liveResource);
		const { session, chat } = createSession(harness.stateManager, 'restored-archive');
		harness.stateManager.dispatchServerAction(session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
		const recordings = URI.joinPath(harness.dataService.getSessionDataDir(URI.parse(session)), 'computer-use-recordings');
		await fs.mkdir(URI.joinPath(recordings, 'stale-chat', 'stale-recording').fsPath, { recursive: true });

		const restored = { title: 'Archived' };
		assert.strictEqual(await harness.contributions.hydrateChat({ session, chat }, restored), restored);
		assert.strictEqual(await fs.access(recordings.fsPath).then(() => true, () => false), false);
	});

	test('chat and session removal stop recorders, delete footage, and clear late turn state', async () => {
		const harness = createHarness(liveResource);
		const { session, chat } = createSession(harness.stateManager, 'removed');
		const peer = buildChatUri(session, 'peer');
		harness.stateManager.addChat(session, peer, { title: 'Peer' });
		startTurn(harness.stateManager, chat, 'default-turn');
		startTurn(harness.stateManager, peer, 'peer-turn');
		harness.contributions.didDispatchAction({ channel: chat, session, action: ready('default-turn') });
		harness.contributions.didDispatchAction({ channel: peer, session, action: ready('peer-turn') });
		await waitFor(() => harness.requests.length === 2, 'The removal recordings did not start.');

		harness.stateManager.removeChat(session, peer);
		harness.contributions.didDispatchAction({
			channel: session,
			session,
			action: { type: ActionType.SessionChatRemoved, chat: peer },
		});
		const dataDirectory = harness.dataService.getSessionDataDir(URI.parse(session));
		const recordings = URI.joinPath(dataDirectory, 'computer-use-recordings');
		await waitFor(async () => {
			const chatKeys = await fs.readdir(recordings.fsPath).catch(() => []);
			return chatKeys.length === 1;
		}, 'Removed chat recordings were not deleted.');
		harness.stateManager.removeSession(session);
		await harness.dataService.deleteSessionData(URI.parse(session));
		assert.strictEqual(await fs.access(dataDirectory.fsPath).then(() => true, () => false), false);
		const requestCount = harness.requests.length;
		harness.contributions.turnEnd({ session, channel: chat, turnId: 'default-turn', reason: { kind: 'success' } });
		harness.contributions.turnEnd({ session, channel: peer, turnId: 'peer-turn', reason: { kind: 'success' } });
		await timeout(300);

		assert.deepStrictEqual({
			requestCount,
			requestCountAfterRemoval: harness.requests.length,
			localTurns: harness.localTurns.records,
		}, {
			requestCount: 2,
			requestCountAfterRemoval: 2,
			localTurns: [],
		});
	});
});
