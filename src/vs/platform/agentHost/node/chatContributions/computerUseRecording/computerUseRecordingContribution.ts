/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import type { ISettableObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { createChatMementoKey, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IDispatchedAction, type IHydrationContext, type IRestoredChat, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { COMPUTER_USE_RECORDING_MAX_THOUGHTS, COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH, isComputerUseRecordingThoughtText, type ComputerUseRecordingActionKind, type IComputerUseRecordingThought } from '../../../common/computerUseRecording.js';
import { buildMcpChannel } from '../../../common/mcpChannel.js';
import { AgentSystemNotificationKind, toAgentSystemNotificationMeta } from '../../../common/meta/agentSystemNotificationMeta.js';
import { readToolCallMeta } from '../../../common/meta/agentToolCallMeta.js';
import { ISessionDataService } from '../../../common/sessionDataService.js';
import { ActionType, type StateAction } from '../../../common/state/sessionActions.js';
import { isAhpChatChannel, isSessionStatusArchived, MessageKind, parseRequiredSessionUriFromChatUri, ResponsePartKind, withMessageRequestHiddenFromTranscript, type URI as ProtocolURI } from '../../../common/state/sessionState.js';
import { ILogService } from '../../../../log/common/log.js';
import { IAgentHostLocalTurns } from '../../agentHostLocalTurns.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';
import { IAgentHostProviderService } from '../../agentHostProviderService.js';
import { COMPUTER_USE_RECORDINGS_DIRECTORY, ComputerUseRecordingStore, type IComputerUseRecordingFinalization } from './computerUseRecordingStore.js';
import { ComputerUseTurnRecorder, systemComputerUseRecordingScheduler } from './computerUseTurnRecorder.js';

const COMPUTER_USE_SERVER_NAME = 'computer-use';

interface IRecordingMemento {
	readonly started: boolean;
}

interface IActiveRecording {
	readonly session: ProtocolURI;
	readonly chat: ProtocolURI;
	readonly turnId: string;
	readonly recordingId: string;
	readonly memento: ISettableObservable<IRecordingMemento>;
	readonly thoughtState: ITurnThoughtState;
	readonly pendingActions: Map<string, { readonly kind: ComputerUseRecordingActionKind; readonly occurredAt: number }>;
	readonly bufferedActions: { readonly kind: ComputerUseRecordingActionKind; readonly occurredAt: number }[];
	recorder: Promise<ComputerUseTurnRecorder | undefined>;
	recorderInstance?: ComputerUseTurnRecorder;
	suppressNotice: boolean;
	finalization?: Promise<void>;
}

interface IPendingRecordingNotice {
	readonly result: IComputerUseRecordingFinalization;
	readonly sourceTurnId: string;
}

type ComputerUseRecordingThoughtState = Omit<IComputerUseRecordingThought, 'timeMs'>;

interface ITurnThoughtState {
	readonly turnId: string;
	readonly buffered: ComputerUseRecordingThoughtState[];
	reasoningPartId?: string;
	reasoningText: string;
	current?: ComputerUseRecordingThoughtState;
	recorder?: ComputerUseTurnRecorder;
}

const recordingMementoKey = createChatMementoKey<IRecordingMemento, [turnId: string]>('computerUseRecording', () => ({ started: false }));

function toRecordingActionKind(toolName: string | undefined): ComputerUseRecordingActionKind | undefined {
	switch (toolName) {
		case 'click': return 'click';
		case 'set_value':
		case 'patch_text':
		case 'type_text': return 'text';
		case 'press_key': return 'key';
		case 'scroll': return 'scroll';
		case 'drag': return 'drag';
		case 'perform_secondary_action': return 'secondary';
		case 'launch_app': return 'application';
		default: return undefined;
	}
}

export class ComputerUseRecordingContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'computerUseRecording';
	readonly order = 250;

	private readonly _active = new Map<ProtocolURI, Map<string, IActiveRecording>>();
	private readonly _thoughtStates = new Map<ProtocolURI, ITurnThoughtState>();
	private readonly _pendingNotices = new Map<ProtocolURI, IPendingRecordingNotice[]>();
	private readonly _recoveries = new Map<ProtocolURI, Promise<void>>();
	private readonly _archiveCleanups = new Map<ProtocolURI, Promise<void>>();

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IAgentHostProviderService private readonly _providerService: IAgentHostProviderService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IAgentHostLocalTurns private readonly _localTurns: IAgentHostLocalTurns,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._sessionDataService.onWillDeleteSessionData(event => {
			event.waitUntil(this._prepareSessionDeletion(event.session.toString()));
		}));
		this._register(this._stateManager.onDidRemoveSession(session => this._forgetSession(session)));
	}

	onDidDispatchAction(dispatched: IDispatchedAction): void {
		if (dispatched.rejectionReason !== undefined) {
			return;
		}
		const { action } = dispatched;
		if (action.type === ActionType.SessionIsArchivedChanged && action.isArchived) {
			void this._archiveSession(dispatched.session);
			return;
		}
		if (action.type === ActionType.SessionChatRemoved) {
			void this._removeChat(dispatched.session, action.chat).catch(error => {
				this._logService.warn(`[ComputerUseRecording] Failed to clean up removed chat recordings: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}
		if (!isAhpChatChannel(dispatched.channel)) {
			return;
		}

		this._captureSharedThought(dispatched.channel, action);
		this._flushPendingNotices(dispatched.channel);
		const active = action.type === ActionType.ChatToolCallReady || action.type === ActionType.ChatToolCallComplete
			? this._active.get(dispatched.channel)?.get(action.turnId)
			: undefined;
		if (action.type === ActionType.ChatToolCallComplete && active) {
			this._completeAction(active, action.toolCallId, action.result.success);
			return;
		}
		if (action.type !== ActionType.ChatToolCallReady) {
			return;
		}
		const toolMeta = readToolCallMeta(action);
		if (toolMeta.mcpServerName !== COMPUTER_USE_SERVER_NAME
			|| this._stateManager.getActiveTurnId(dispatched.channel) !== action.turnId
			|| isSessionStatusArchived(this._stateManager.getSessionState(dispatched.session)?.status)) {
			return;
		}
		if (active) {
			this._trackAction(active, action.toolCallId, toRecordingActionKind(toolMeta.mcpToolName));
			return;
		}
		const memento = this._context.memento(recordingMementoKey, dispatched.channel, action.turnId);
		if (memento.get().started) {
			return;
		}
		const recordingId = generateUuid();
		const thoughtState = this._getThoughtState(dispatched.channel, action.turnId);
		memento.set({ started: true }, undefined);
		const entry: IActiveRecording = {
			session: dispatched.session,
			chat: dispatched.channel,
			turnId: action.turnId,
			recordingId,
			memento,
			thoughtState,
			pendingActions: new Map(),
			bufferedActions: [],
			suppressNotice: false,
			recorder: Promise.resolve(undefined),
		};
		this._trackAction(entry, action.toolCallId, toRecordingActionKind(toolMeta.mcpToolName));
		entry.recorder = this._createRecorder(entry).catch(error => {
			this._logService.warn(`[ComputerUseRecording] Failed to start recording: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		this._setActive(entry);
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (turn.reason.kind === 'rejected' || !turn.turnId) {
			return;
		}
		const thoughtState = this._thoughtStates.get(turn.channel);
		if (thoughtState?.turnId === turn.turnId) {
			this._finishThought(thoughtState);
		}
		if (turn.reason.kind === 'error' && turn.reason.resumable) {
			return;
		}
		const entry = this._active.get(turn.channel)?.get(turn.turnId);
		if (entry) {
			void this._finalize(entry, true);
		} else if (thoughtState?.turnId === turn.turnId) {
			this._thoughtStates.delete(turn.channel);
		}
	}

	async onHydrateChat(context: IHydrationContext, restored: IRestoredChat): Promise<IRestoredChat> {
		if (isSessionStatusArchived(this._stateManager.getSessionState(context.session)?.status)) {
			await this._archiveSession(context.session);
		} else {
			await this._recoverChat(context.session, context.chat);
		}
		return restored;
	}

	private async _createRecorder(entry: IActiveRecording): Promise<ComputerUseTurnRecorder> {
		await this._archiveCleanups.get(entry.session);
		const chat = URI.parse(entry.chat);
		const recordingsDirectory = this._recordingsDirectory(entry.session, entry.chat);
		await this._recoverChat(entry.session, entry.chat);
		const store = await ComputerUseRecordingStore.createInDirectory(recordingsDirectory, entry.recordingId, new Date().toISOString());
		const channel = buildMcpChannel(chat, COMPUTER_USE_SERVER_NAME);
		const recorder = new ComputerUseTurnRecorder(store, {
			scheduler: systemComputerUseRecordingScheduler,
			readResource: uri => this._providerService.handleMcpRequest(channel, 'resources/read', { uri }),
		});
		recorder.start();
		entry.recorderInstance = recorder;
		for (const action of entry.bufferedActions.splice(0)) {
			recorder.recordAction(action.kind, action.occurredAt);
		}
		entry.thoughtState.recorder = recorder;
		for (const thought of entry.thoughtState.buffered.splice(0)) {
			recorder.recordThought(thought);
		}
		return recorder;
	}

	private _trackAction(entry: IActiveRecording, toolCallId: string, kind: ComputerUseRecordingActionKind | undefined): void {
		if (!kind || entry.pendingActions.has(toolCallId)) {
			return;
		}
		entry.pendingActions.set(toolCallId, { kind, occurredAt: systemComputerUseRecordingScheduler.now() });
	}

	private _completeAction(entry: IActiveRecording, toolCallId: string, success: boolean): void {
		const action = entry.pendingActions.get(toolCallId);
		entry.pendingActions.delete(toolCallId);
		if (!action || !success) {
			return;
		}
		if (entry.recorderInstance) {
			entry.recorderInstance.recordAction(action.kind, action.occurredAt);
		} else {
			entry.bufferedActions.push(action);
		}
	}

	private _setActive(entry: IActiveRecording): void {
		let turns = this._active.get(entry.chat);
		if (!turns) {
			turns = new Map();
			this._active.set(entry.chat, turns);
		}
		turns.set(entry.turnId, entry);
	}

	private _deleteActive(entry: IActiveRecording): void {
		const turns = this._active.get(entry.chat);
		if (turns?.delete(entry.turnId) && turns.size === 0) {
			this._active.delete(entry.chat);
		}
		if (this._thoughtStates.get(entry.chat) === entry.thoughtState) {
			this._thoughtStates.delete(entry.chat);
		}
		this._context.deleteMemento(recordingMementoKey, entry.chat, entry.turnId);
	}

	private _finalize(entry: IActiveRecording, publishNotice: boolean): Promise<void> {
		this._finishThought(entry.thoughtState);
		if (!publishNotice) {
			entry.suppressNotice = true;
		}
		if (!entry.finalization) {
			entry.finalization = (async () => {
				const recorder = await entry.recorder;
				try {
					const result = await recorder?.stop();
					if (result && !entry.suppressNotice) {
						this._queueNotice(entry.chat, { result, sourceTurnId: entry.turnId });
					}
				} finally {
					recorder?.dispose();
					this._deleteActive(entry);
				}
			})().catch(error => {
				this._logService.warn(`[ComputerUseRecording] Failed to finalize recording: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return entry.finalization;
	}

	private _queueNotice(chat: ProtocolURI, notice: IPendingRecordingNotice): void {
		let pending = this._pendingNotices.get(chat);
		if (!pending) {
			pending = [];
			this._pendingNotices.set(chat, pending);
		}
		pending.push(notice);
		this._flushPendingNotices(chat);
	}

	private _flushPendingNotices(chat: ProtocolURI): void {
		if (this._stateManager.getActiveTurnId(chat) !== undefined) {
			return;
		}
		const state = this._stateManager.getChatState(chat);
		const pending = this._pendingNotices.get(chat);
		if (!state || !pending?.length) {
			if (!state) {
				this._pendingNotices.delete(chat);
			}
			return;
		}
		this._pendingNotices.delete(chat);
		for (const notice of pending) {
			this._publishNotice(chat, notice);
		}
	}

	private _publishNotice(chat: ProtocolURI, notice: IPendingRecordingNotice): void {
		const content = this._recordingTitle(chat, notice.sourceTurnId);
		const meta = toAgentSystemNotificationMeta({
			kind: AgentSystemNotificationKind.ComputerUseRecording,
			recordingUri: notice.result.recordingUri,
			recordingTitle: content,
			durationMs: notice.result.manifest.durationMs,
			sizeBytes: notice.result.manifest.sizeBytes,
			trimmed: notice.result.manifest.trimmed,
		});
		const turnId = generateUuid();
		this._stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: withMessageRequestHiddenFromTranscript({
				text: content,
				origin: { kind: MessageKind.SystemNotification },
				_meta: meta,
			}, true),
		});
		this._stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatResponsePart,
			turnId,
			part: {
				kind: ResponsePartKind.SystemNotification,
				content,
				_meta: meta,
			},
		});
		this._stateManager.dispatchServerAction(chat, { type: ActionType.ChatTurnComplete, turnId, duration: 0 });
		const turns = this._stateManager.getChatState(chat)?.turns;
		const recorded = turns?.find(turn => turn.id === turnId);
		if (turns && recorded) {
			const session = parseRequiredSessionUriFromChatUri(chat);
			this._localTurns.record(session, chat, recorded, this._localTurns.findAnchorTurnId(chat, turns, turnId));
		}
	}

	private _recordingTitle(chat: ProtocolURI, sourceTurnId: string): string {
		const turn = this._stateManager.getChatState(chat)?.turns.find(candidate => candidate.id === sourceTurnId);
		const markdown = turn?.responseParts.findLast(part => part.kind === ResponsePartKind.Markdown && !!part.content);
		const raw = markdown?.kind === ResponsePartKind.Markdown ? markdown.content : turn?.message.text;
		const firstLine = raw?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
		if (!firstLine) {
			return localize('agentHost.computerUseRecordingReady', "Computer Use recording");
		}
		const title = firstLine
			.replace(/\[(?<label>[^\]]+)\]\([^)]+\)/g, '$<label>')
			.replace(/^[\s#>*+-]+/, '')
			.replace(/[`*_~]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!title) {
			return localize('agentHost.computerUseRecordingReady', "Computer Use recording");
		}
		return title.length <= 100 ? title : `${title.slice(0, 99).trimEnd()}…`;
	}

	private async _removeChat(session: ProtocolURI, chat: ProtocolURI): Promise<void> {
		const turns = this._active.get(chat);
		const recovery = this._recoveries.get(chat);
		const finalizations: Promise<void>[] = [];
		if (turns) {
			for (const entry of turns.values()) {
				finalizations.push(this._finalize(entry, false));
			}
		}
		this._pendingNotices.delete(chat);
		this._thoughtStates.delete(chat);
		this._recoveries.delete(chat);
		await Promise.allSettled(recovery ? [recovery] : []);
		await Promise.all(finalizations);
		await this._deleteRecordingsDirectory(this._recordingsDirectory(session, chat));
	}

	private async _prepareSessionDeletion(session: ProtocolURI): Promise<void> {
		const finalizations: Promise<void>[] = [];
		const recoveries = this._sessionRecoveries(session);
		for (const turns of this._active.values()) {
			for (const entry of turns.values()) {
				if (entry.session === session) {
					finalizations.push(this._finalize(entry, false));
				}
			}
		}
		this._clearSessionBookkeeping(session);
		await Promise.allSettled(recoveries);
		await Promise.all(finalizations);
	}

	private _forgetSession(session: ProtocolURI): void {
		void this._archiveSession(session);
	}

	private _archiveSession(session: ProtocolURI): Promise<void> {
		const existing = this._archiveCleanups.get(session);
		if (existing) {
			return existing;
		}
		const finalizations: Promise<void>[] = [];
		const recoveries = this._sessionRecoveries(session);
		for (const turns of this._active.values()) {
			for (const entry of turns.values()) {
				if (entry.session === session) {
					finalizations.push(this._finalize(entry, false));
				}
			}
		}
		this._clearSessionBookkeeping(session);
		const cleanup = (async () => {
			await Promise.allSettled(recoveries);
			await Promise.all(finalizations);
			const sessionDirectory = this._sessionDataService.getSessionDataDir(URI.parse(session));
			await this._deleteRecordingsDirectory(URI.joinPath(sessionDirectory, COMPUTER_USE_RECORDINGS_DIRECTORY));
		})().catch(error => {
			this._logService.warn(`[ComputerUseRecording] Failed to clean up archived recordings: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			if (this._archiveCleanups.get(session) === cleanup) {
				this._archiveCleanups.delete(session);
			}
		});
		this._archiveCleanups.set(session, cleanup);
		return cleanup;
	}

	private _clearSessionBookkeeping(session: ProtocolURI): void {
		for (const chat of this._pendingNotices.keys()) {
			if (parseRequiredSessionUriFromChatUri(chat) === session) {
				this._pendingNotices.delete(chat);
			}
		}
		for (const chat of this._recoveries.keys()) {
			if (parseRequiredSessionUriFromChatUri(chat) === session) {
				this._recoveries.delete(chat);
			}
		}
		for (const chat of this._thoughtStates.keys()) {
			if (parseRequiredSessionUriFromChatUri(chat) === session) {
				this._thoughtStates.delete(chat);
			}
		}
	}

	private async _recoverChat(session: ProtocolURI, chat: ProtocolURI): Promise<void> {
		let recovery = this._recoveries.get(chat);
		if (!recovery) {
			recovery = (async () => {
				const result = await ComputerUseRecordingStore.recoverFromDirectory(this._recordingsDirectory(session, chat));
				if (result.invalidRecordingIds.length > 0) {
					this._logService.warn(`[ComputerUseRecording] Removed ${result.invalidRecordingIds.length} invalid local recording(s) during recovery.`);
				}
			})().catch(error => {
				if (this._recoveries.get(chat) === recovery) {
					this._recoveries.delete(chat);
				}
				throw error;
			});
			this._recoveries.set(chat, recovery);
		}
		await recovery;
	}

	private _sessionRecoveries(session: ProtocolURI): Promise<void>[] {
		const recoveries: Promise<void>[] = [];
		for (const [chat, recovery] of this._recoveries) {
			if (parseRequiredSessionUriFromChatUri(chat) === session) {
				recoveries.push(recovery);
			}
		}
		return recoveries;
	}

	private _recordingsDirectory(session: ProtocolURI, chat: ProtocolURI): URI {
		const sessionDirectory = this._sessionDataService.getSessionDataDir(URI.parse(session));
		const chatKey = createHash('sha256').update(chat).digest('hex');
		return URI.joinPath(sessionDirectory, COMPUTER_USE_RECORDINGS_DIRECTORY, chatKey);
	}

	private async _deleteRecordingsDirectory(directory: URI): Promise<void> {
		if (directory.scheme !== Schemas.file) {
			throw new Error('Computer Use recordings require a local file session-data directory.');
		}
		await fs.rm(directory.fsPath, { recursive: true, force: true });
	}

	/** Persists only provider-shared reasoning deltas and activity text, never generic action or message payloads. */
	private _captureSharedThought(chat: ProtocolURI, action: StateAction): void {
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				this._thoughtStates.set(chat, {
					turnId: action.turnId,
					buffered: [],
					reasoningText: '',
				});
				return;
			case ActionType.ChatReasoning: {
				if (this._stateManager.getActiveTurnId(chat) !== action.turnId) {
					return;
				}
				const state = this._getThoughtState(chat, action.turnId);
				const content = action.content.length > COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH * 2
					? action.content.slice(-COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH * 2)
					: action.content;
				const combined = `${state.reasoningPartId === action.partId ? state.reasoningText : ''}${content}`;
				const text = this._boundedThoughtText(combined);
				state.reasoningPartId = action.partId;
				state.reasoningText = text ?? '';
				if (text) {
					this._recordThought(state, { source: 'reasoning', text, streaming: true });
				}
				return;
			}
			case ActionType.ChatActivityChanged: {
				const turnId = this._stateManager.getActiveTurnId(chat);
				if (!turnId) {
					return;
				}
				const state = this._getThoughtState(chat, turnId);
				if (!action.activity) {
					if (state.current?.source === 'activity') {
						this._finishThought(state);
					}
					return;
				}
				const text = this._boundedThoughtText(action.activity);
				if (text) {
					this._recordThought(state, { source: 'activity', text, streaming: true });
				}
				return;
			}
		}

		const turnId = this._thoughtBoundaryTurnId(action);
		const state = turnId ? this._thoughtStates.get(chat) : undefined;
		if (!state || state.turnId !== turnId) {
			return;
		}
		this._finishThought(state);
	}

	private _thoughtBoundaryTurnId(action: StateAction): string | undefined {
		switch (action.type) {
			case ActionType.ChatToolCallStart:
			case ActionType.ChatToolCallDelta:
			case ActionType.ChatToolCallReady:
			case ActionType.ChatToolCallConfirmed:
			case ActionType.ChatToolCallComplete:
			case ActionType.ChatToolCallResultConfirmed:
			case ActionType.ChatToolCallContentChanged:
			case ActionType.ChatToolCallAuthRequired:
			case ActionType.ChatToolCallAuthResolved:
			case ActionType.ChatDelta:
			case ActionType.ChatResponsePart:
			case ActionType.ChatTurnComplete:
			case ActionType.ChatTurnCancelled:
			case ActionType.ChatError:
				return action.turnId;
			default:
				return undefined;
		}
	}

	private _getThoughtState(chat: ProtocolURI, turnId: string): ITurnThoughtState {
		let state = this._thoughtStates.get(chat);
		if (!state || state.turnId !== turnId) {
			state = { turnId, buffered: [], reasoningText: '' };
			this._thoughtStates.set(chat, state);
		}
		return state;
	}

	private _boundedThoughtText(value: string): string | undefined {
		const boundedValue = value.length > COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH * 2
			? value.slice(-COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH * 2)
			: value;
		const characters = Array.from(boundedValue);
		const text = characters.length > COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH
			? characters.slice(characters.length - COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH).join('')
			: boundedValue;
		return isComputerUseRecordingThoughtText(text) ? text : undefined;
	}

	private _recordThought(state: ITurnThoughtState, thought: ComputerUseRecordingThoughtState): void {
		state.current = thought;
		if (state.recorder) {
			state.recorder.recordThought(thought);
			return;
		}
		const previous = state.buffered.at(-1);
		if (previous?.source === thought.source) {
			state.buffered[state.buffered.length - 1] = thought;
		} else {
			state.buffered.push(thought);
			if (state.buffered.length > COMPUTER_USE_RECORDING_MAX_THOUGHTS) {
				state.buffered.shift();
			}
		}
	}

	private _finishThought(state: ITurnThoughtState): void {
		const current = state.current;
		if (current?.streaming) {
			this._recordThought(state, { ...current, streaming: false });
		}
	}

	override dispose(): void {
		for (const turns of this._active.values()) {
			for (const entry of turns.values()) {
				void this._finalize(entry, false);
			}
		}
		this._pendingNotices.clear();
		this._thoughtStates.clear();
		this._recoveries.clear();
		super.dispose();
	}
}
