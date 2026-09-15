/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { constObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, isAgentHostContentRefUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { OPEN_COMPUTER_USE_RECORDING_COMMAND_ID } from '../../../../platform/agentHost/common/computerUseRecording.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsCategories } from '../../../common/categories.js';
import { SessionSupportsComputerUseVideoContext } from '../../../common/contextkeys.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { ComputerUseAnnotatingContext, ComputerUseAnnotationAttachingContext, ComputerUseAnnotationStyleContext, ComputerUseAnnotationWidthContext, ComputerUseFollowActionContext, ComputerUseFullScreenContext, ComputerUseFullScreenSupportedContext, ComputerUseHasAnnotationsContext, ComputerUseHasFrameContext, ComputerUsePausedContext, ComputerUsePlayerContext } from './computerUseContext.js';
import { ComputerUseEditor } from './computerUseEditor.js';
import { ComputerUseEditorInput, IComputerUseViewerIdentity } from './computerUseEditorInput.js';
import { ComputerUsePlayer } from './computerUsePlayer.js';
import { createComputerUseActivity } from './computerUseActivity.js';
import { ComputerUseAnnotationStyle, ComputerUseAnnotationWidth } from './computerUseAnnotationCanvas.js';
import { ComputerUseRecordingSource } from './computerUseRecordingSource.js';

const annotationYellowIcon = registerIcon('computer-use-annotation-yellow', Codicon.circleFilled, localize('computerUse.annotationYellowIcon', "Icon for the yellow Computer Use annotation highlighter."));
const annotationPinkIcon = registerIcon('computer-use-annotation-pink', Codicon.circleFilled, localize('computerUse.annotationPinkIcon', "Icon for the pink Computer Use annotation highlighter."));
const annotationBlueIcon = registerIcon('computer-use-annotation-blue', Codicon.circleFilled, localize('computerUse.annotationBlueIcon', "Icon for the blue Computer Use annotation highlighter."));
const annotationThinIcon = registerIcon('computer-use-annotation-width-thin', Codicon.remove, localize('computerUse.annotationThinIcon', "Icon for the thin Computer Use annotation highlighter."));
const annotationMediumIcon = registerIcon('computer-use-annotation-width-medium', Codicon.remove, localize('computerUse.annotationMediumIcon', "Icon for the medium Computer Use annotation highlighter."));
const annotationThickIcon = registerIcon('computer-use-annotation-width-thick', Codicon.remove, localize('computerUse.annotationThickIcon', "Icon for the thick Computer Use annotation highlighter."));

export class ViewComputerUseAction extends Action2 {
	constructor() {
		const when = ContextKeyExpr.and(ChatContextKeys.enabled, SessionSupportsComputerUseVideoContext);
		super({
			id: 'sessions.viewComputerUse',
			title: localize2('computerUse.view', "View Computer Use"),
			icon: Codicon.deviceDesktop,
			category: SessionsCategories.Sessions,
			f1: true,
			precondition: when,
			menu: { id: Menus.SessionHeaderContext, group: '1_view', order: 1, when },
		});
	}

	override async run(accessor: ServicesAccessor, context?: IActiveSession): Promise<void> {
		const session = context ?? accessor.get(ISessionContext).session.get();
		if (!session) {
			return;
		}
		await openComputerUseViewer(accessor, session, session.activeChat.get());
	}
}

registerAction2(ViewComputerUseAction);

export async function openComputerUseViewer(accessor: ServicesAccessor, session: ISession, chat: IChat, revealExisting = true): Promise<void> {
	if (!session.capabilities.get().supportsComputerUseVideo || accessor.get(IChatEntitlementService).sentiment.hidden) {
		return;
	}
	const identity: IComputerUseViewerIdentity = { providerId: session.providerId, sessionId: session.sessionId, chatResource: chat.resource };
	const editorService = accessor.get(IEditorService);
	const existing = editorService.editors.find((input): input is ComputerUseEditorInput => input instanceof ComputerUseEditorInput && input.isFor(identity));
	if (existing) {
		if (revealExisting) {
			await editorService.openEditor(existing, { pinned: true, revealIfOpened: true });
		}
		return;
	}
	const provider = accessor.get(ISessionsProvidersService).getProvider(session.providerId);
	const source = provider?.getComputerUseVideoSource?.(session.sessionId, chat.resource);
	if (!source) {
		throw new Error(localize('computerUse.sourceUnavailable', "Live Computer Use viewing is no longer available for this session on its agent host."));
	}
	const input = new ComputerUseEditorInput(identity, session.title, chat.title, source, createComputerUseActivity(chat, session.remoteConnectionStatus));
	try {
		await editorService.openEditor(input, { pinned: true, revealIfOpened: true });
	} finally {
		if (!editorService.editors.includes(input)) {
			input.dispose();
		}
	}
}

export async function openComputerUseRecording(recordingUri: URI, editorService: IEditorService, fileService: IFileService, title?: string, hostLabel?: string, attachmentChatResource?: URI): Promise<void> {
	const identity: IComputerUseViewerIdentity = {
		providerId: 'computerUseRecording',
		sessionId: recordingUri.authority || 'local',
		chatResource: recordingUri,
	};
	const existing = editorService.editors.find((input): input is ComputerUseEditorInput => input instanceof ComputerUseEditorInput && input.isFor(identity));
	if (existing) {
		existing.setAttachmentChatResource(attachmentChatResource);
		existing.source.seek?.(0);
		const pane = await editorService.openEditor(existing, { pinned: true, revealIfOpened: true });
		if (pane instanceof ComputerUseEditor) {
			pane.restartRecordingPlayback();
		}
		return;
	}

	const source = await ComputerUseRecordingSource.create(recordingUri, fileService, Date.now, hostLabel, title);
	const input = new ComputerUseEditorInput(
		identity,
		constObservable(source.hostLabel),
		constObservable(localize('computerUse.recording', "Recording")),
		source,
		undefined,
		attachmentChatResource,
	);
	try {
		await editorService.openEditor(input, { pinned: true, revealIfOpened: true });
	} finally {
		if (!editorService.editors.includes(input)) {
			input.dispose();
		}
	}
}

registerAction2(class OpenComputerUseRecordingAction extends Action2 {
	constructor() {
		super({
			id: OPEN_COMPUTER_USE_RECORDING_COMMAND_ID,
			title: localize2('sessions.openComputerUseRecording', "Open Computer Use Recording"),
			precondition: ChatContextKeys.enabled,
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, recordingUriValue: string, recordingTitleValue?: string, attachmentChatResourceValue?: string): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		let recordingUri: URI;
		try {
			recordingUri = URI.parse(recordingUriValue);
		} catch {
			notificationService.error(localize('computerUse.invalidRecordingUri', "The Computer Use recording location is invalid."));
			return;
		}
		if ((recordingUri.scheme !== Schemas.file || !!recordingUri.query || !!recordingUri.fragment)
			&& (recordingUri.scheme !== AGENT_HOST_SCHEME || !isAgentHostContentRefUri(recordingUri))) {
			notificationService.error(localize('computerUse.invalidRecordingLocation', "The Computer Use recording location is not trusted."));
			return;
		}
		try {
			const hostLabel = recordingUri.scheme === AGENT_HOST_SCHEME
				? localize('computerUse.recording.remoteHost', "Recorded on {0}", accessor.get(ILabelService).getHostLabel(recordingUri.scheme, recordingUri.authority))
				: undefined;
			const title = typeof recordingTitleValue === 'string' && recordingTitleValue.length > 0 && recordingTitleValue.length <= 160 && recordingTitleValue === recordingTitleValue.trim() && !/[\r\n]/.test(recordingTitleValue)
				? recordingTitleValue
				: undefined;
			let attachmentChatResource: URI | undefined;
			if (attachmentChatResourceValue !== undefined) {
				if (typeof attachmentChatResourceValue !== 'string' || !attachmentChatResourceValue || attachmentChatResourceValue.length > 4096) {
					notificationService.error(localize('computerUse.invalidRecordingChat', "The chat associated with this Computer Use recording is invalid."));
					return;
				}
				try {
					attachmentChatResource = URI.parse(attachmentChatResourceValue);
				} catch {
					notificationService.error(localize('computerUse.invalidRecordingChat', "The chat associated with this Computer Use recording is invalid."));
					return;
				}
			}
			await openComputerUseRecording(recordingUri, accessor.get(IEditorService), accessor.get(IFileService), title, hostLabel, attachmentChatResource);
		} catch (error) {
			notificationService.error(localize('computerUse.openRecordingFailed', "The Computer Use recording could not be opened: {0}", getErrorMessage(error)));
		}
	}
});

registerAction2(class PauseComputerUseViewingAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.computerUse.pauseViewing',
			title: localize2('computerUse.pauseViewing', "Pause Viewing"),
			tooltip: localize2('computerUse.pauseViewingTooltip', "Pause Viewing (Does Not Stop the Agent)"),
			icon: Codicon.debugPause,
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 1, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext.negate(), ComputerUsePausedContext.negate()) },
		});
	}
	override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
		player?.pauseViewing();
	}
});

registerAction2(class ResumeComputerUseViewingAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.computerUse.resumeViewing',
			title: localize2('computerUse.resumeViewing', "Resume Viewing"),
			icon: Codicon.debugContinue,
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 1, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext.negate(), ComputerUsePausedContext) },
		});
	}
	override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
		player?.resumeViewing();
	}
});

registerAction2(class ComputerUseFullScreenAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.computerUse.fullScreen',
			title: localize2('computerUse.fullScreen', "Full Screen"),
			toggled: { condition: ComputerUseFullScreenContext, title: localize('computerUse.exitFullScreen', "Exit Full Screen") },
			icon: Codicon.screenFull,
			precondition: ComputerUseFullScreenSupportedContext,
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 2, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext.negate()) },
		});

		registerAction2(class FollowComputerUseAction extends Action2 {
			constructor() {
				super({
					id: 'sessions.computerUse.followAction',
					title: localize2('computerUse.followAction', "Follow Action"),
					tooltip: localize2('computerUse.followActionTooltip', "Follow Action: Zoom to 2x around the agent's action point (view only)"),
					toggled: ComputerUseFollowActionContext,
					menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 3, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext.negate()) },
				});
			}

			override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
				player?.toggleFollowAction();
			}
		});

		registerAction2(class AnnotateComputerUseFrameAction extends Action2 {
			constructor() {
				super({
					id: 'sessions.computerUse.annotateFrame',
					title: localize2('computerUse.annotateFrame', "Annotate Frame"),
					tooltip: localize2('computerUse.annotateFrameTooltip', "Freeze and Annotate the Current Frame"),
					icon: Codicon.edit,
					precondition: ComputerUseHasFrameContext,
					menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 4, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext.negate()) },
				});
			}

			override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
				player?.startAnnotation();
			}
		});

		function registerAnnotationStyleAction(id: string, title: ReturnType<typeof localize2>, style: ComputerUseAnnotationStyle, icon: ThemeIcon): void {
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id,
						title,
						icon,
						toggled: ComputerUseAnnotationStyleContext.isEqualTo(style),
						menu: { id: Menus.ComputerUsePlayer, group: '1_annotationColors', order: style === 'yellow' ? 1 : style === 'pink' ? 2 : 3, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext) },
					});
				}

				override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
					player?.setAnnotationStyle(style);
				}
			});
		}

		registerAnnotationStyleAction('sessions.computerUse.annotationYellow', localize2('computerUse.annotationYellow', "Yellow Highlighter"), 'yellow', annotationYellowIcon);
		registerAnnotationStyleAction('sessions.computerUse.annotationPink', localize2('computerUse.annotationPink', "Pink Highlighter"), 'pink', annotationPinkIcon);
		registerAnnotationStyleAction('sessions.computerUse.annotationBlue', localize2('computerUse.annotationBlue', "Blue Highlighter"), 'blue', annotationBlueIcon);

		function registerAnnotationWidthAction(id: string, title: ReturnType<typeof localize2>, width: ComputerUseAnnotationWidth, icon: ThemeIcon, order: number): void {
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id,
						title,
						icon,
						toggled: ComputerUseAnnotationWidthContext.isEqualTo(width),
						menu: { id: Menus.ComputerUsePlayer, group: '2_annotationWidths', order, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext) },
					});
				}

				override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
					player?.setAnnotationWidth(width);
				}
			});
		}

		registerAnnotationWidthAction('sessions.computerUse.annotationThin', localize2('computerUse.annotationThin', "Thin Highlighter"), 'thin', annotationThinIcon, 1);
		registerAnnotationWidthAction('sessions.computerUse.annotationMedium', localize2('computerUse.annotationMedium', "Medium Highlighter"), 'medium', annotationMediumIcon, 2);
		registerAnnotationWidthAction('sessions.computerUse.annotationThick', localize2('computerUse.annotationThick', "Thick Highlighter"), 'thick', annotationThickIcon, 3);

		registerAction2(class ResetComputerUseAnnotationsAction extends Action2 {
			constructor() {
				super({
					id: 'sessions.computerUse.resetAnnotations',
					title: localize2('computerUse.resetAnnotations', "Reset Annotations"),
					icon: Codicon.clearAll,
					precondition: ComputerUseHasAnnotationsContext,
					menu: { id: Menus.ComputerUsePlayer, group: '3_annotationActions', order: 1, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext) },
				});
			}

			override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
				player?.resetAnnotations();
			}
		});

		registerAction2(class AttachComputerUseAnnotationAction extends Action2 {
			constructor() {
				super({
					id: 'sessions.computerUse.attachAnnotation',
					title: localize2('computerUse.attachAnnotation', "Attach to Chat"),
					icon: Codicon.attach,
					precondition: ComputerUseAnnotationAttachingContext.negate(),
					menu: { id: Menus.ComputerUsePlayer, group: '3_annotationActions', order: 2, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext) },
				});
			}

			override async run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): Promise<void> {
				await player?.attachAnnotation();
			}
		});

		registerAction2(class ReturnFromComputerUseAnnotationAction extends Action2 {
			constructor() {
				super({
					id: 'sessions.computerUse.returnFromAnnotation',
					title: localize2('computerUse.returnFromAnnotation', "Return to Video"),
					icon: Codicon.debugContinue,
					menu: { id: Menus.ComputerUsePlayer, group: '3_annotationActions', order: 3, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUseAnnotatingContext) },
				});
			}

			override run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): void {
				player?.returnFromAnnotation();
			}
		});
	}
	override async run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): Promise<void> {
		await player?.toggleFullScreen();
	}
});
