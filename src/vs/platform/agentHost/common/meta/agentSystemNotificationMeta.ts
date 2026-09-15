/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { COMPUTER_USE_RECORDING_MAX_DURATION_MS, COMPUTER_USE_RECORDING_MAX_SIZE_BYTES } from '../computerUseRecording.js';

export const enum AgentSystemNotificationKind {
	WorktreeCreationFailure = 'worktreeCreationFailure',
	/** The session successfully changed to a requested workspace. */
	WorkspaceTransition = 'workspaceTransition',
	/** An automatic approval review did not finish before its deadline. */
	AutomaticApprovalReviewTimedOut = 'automaticApprovalReviewTimedOut',
	/** An automatic approval review stopped before reaching a decision. */
	AutomaticApprovalReviewAborted = 'automaticApprovalReviewAborted',
	/** Automatic approval review denials triggered the turn circuit breaker. */
	AutomaticApprovalReviewInterrupted = 'automaticApprovalReviewInterrupted',
	/** Agent Merge started monitoring the session's branch. */
	AgentMergeEnabled = 'agentMergeEnabled',
	/** Effective Agent Merge behavior changed while monitoring. */
	AgentMergeConfigurationChanged = 'agentMergeConfigurationChanged',
	/** Agent Merge stopped monitoring the session, usually on its own. */
	AgentMergeDisabled = 'agentMergeDisabled',
	/** The pull request Agent Merge was monitoring was merged. */
	AgentMergePullRequestMerged = 'agentMergePullRequestMerged',
	/** A finalized, host-owned Computer Use recording is available for playback. */
	ComputerUseRecording = 'computerUseRecording',
}

export const enum AgentSystemNotificationWorkspaceKind {
	Folder = 'folder',
	Worktree = 'worktree',
}

export const enum AgentSystemNotificationSeverity {
	Warning = 'warning',
}

const knownKinds: ReadonlySet<string> = new Set<string>([
	AgentSystemNotificationKind.WorktreeCreationFailure,
	AgentSystemNotificationKind.WorkspaceTransition,
	AgentSystemNotificationKind.AutomaticApprovalReviewTimedOut,
	AgentSystemNotificationKind.AutomaticApprovalReviewAborted,
	AgentSystemNotificationKind.AutomaticApprovalReviewInterrupted,
	AgentSystemNotificationKind.AgentMergeEnabled,
	AgentSystemNotificationKind.AgentMergeConfigurationChanged,
	AgentSystemNotificationKind.AgentMergeDisabled,
	AgentSystemNotificationKind.AgentMergePullRequestMerged,
	AgentSystemNotificationKind.ComputerUseRecording,
]);

interface IHasSystemNotificationMeta {
	readonly _meta?: Record<string, unknown>;
}

export interface IAgentSystemNotificationMeta {
	readonly kind?: AgentSystemNotificationKind;
	readonly severity?: AgentSystemNotificationSeverity;
	readonly workspaceKind?: AgentSystemNotificationWorkspaceKind;
	readonly workspaceName?: string;
	readonly recordingUri?: string;
	readonly recordingTitle?: string;
	readonly durationMs?: number;
	readonly sizeBytes?: number;
	readonly trimmed?: boolean;
}

export interface IAgentWorkspaceTransitionRecord {
	readonly content: string;
	readonly workspaceKind: AgentSystemNotificationWorkspaceKind;
	readonly workspaceName: string;
}

/** Reads recognized Agent Host system-notification metadata. */
export function readAgentSystemNotificationMeta(source: IHasSystemNotificationMeta): IAgentSystemNotificationMeta {
	const meta = source._meta;
	if (!meta) {
		return {};
	}
	const kind = meta['kind'];
	const workspaceKind = meta['workspaceKind'];
	const durationMs = meta['durationMs'];
	const sizeBytes = meta['sizeBytes'];
	const recordingTitle = meta['recordingTitle'];
	return {
		kind: typeof kind === 'string' && knownKinds.has(kind) ? kind as AgentSystemNotificationKind : undefined,
		severity: meta['severity'] === AgentSystemNotificationSeverity.Warning ? meta['severity'] : undefined,
		workspaceKind: workspaceKind === AgentSystemNotificationWorkspaceKind.Folder || workspaceKind === AgentSystemNotificationWorkspaceKind.Worktree ? workspaceKind : undefined,
		workspaceName: typeof meta['workspaceName'] === 'string' ? meta['workspaceName'] : undefined,
		recordingUri: typeof meta['recordingUri'] === 'string' && meta['recordingUri'].length <= 4096 ? meta['recordingUri'] : undefined,
		recordingTitle: typeof recordingTitle === 'string' && recordingTitle.length > 0 && recordingTitle.length <= 160 && recordingTitle === recordingTitle.trim() && !/[\r\n]/.test(recordingTitle) ? recordingTitle : undefined,
		durationMs: typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= COMPUTER_USE_RECORDING_MAX_DURATION_MS ? durationMs : undefined,
		sizeBytes: typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= COMPUTER_USE_RECORDING_MAX_SIZE_BYTES ? sizeBytes : undefined,
		trimmed: typeof meta['trimmed'] === 'boolean' ? meta['trimmed'] : undefined,
	};
}

/** Serializes Agent Host system-notification metadata for the open protocol bag. */
export function toAgentSystemNotificationMeta(meta: IAgentSystemNotificationMeta): Record<string, unknown> {
	return { ...meta };
}

/** Serializes a durable workspace-transition boundary. */
export function serializeAgentWorkspaceTransition(record: IAgentWorkspaceTransitionRecord): string {
	return JSON.stringify(record);
}

/** Parses and validates a durable workspace-transition boundary. */
export function parseAgentWorkspaceTransition(value: string): IAgentWorkspaceTransitionRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const candidate = parsed as Partial<IAgentWorkspaceTransitionRecord>;
	if (typeof candidate.content !== 'string'
		|| typeof candidate.workspaceName !== 'string'
		|| (candidate.workspaceKind !== AgentSystemNotificationWorkspaceKind.Folder && candidate.workspaceKind !== AgentSystemNotificationWorkspaceKind.Worktree)
	) {
		return undefined;
	}
	return {
		content: candidate.content,
		workspaceKind: candidate.workspaceKind,
		workspaceName: candidate.workspaceName,
	};
}
