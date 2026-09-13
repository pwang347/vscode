/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsCategories } from '../../../common/categories.js';
import { SessionSupportsComputerUseVideoContext } from '../../../common/contextkeys.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { ComputerUseFullScreenContext, ComputerUseFullScreenSupportedContext, ComputerUsePausedContext, ComputerUsePlayerContext } from './computerUseContext.js';
import { ComputerUseEditorInput, IComputerUseViewerIdentity } from './computerUseEditorInput.js';
import { ComputerUsePlayer } from './computerUsePlayer.js';

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
			menu: [
				{ id: Menus.SessionBarToolbar, group: 'navigation', order: 8, when },
				{ id: Menus.SessionHeaderContext, group: '1_view', order: 1, when },
			],
		});
	}

	override async run(accessor: ServicesAccessor, context?: IActiveSession): Promise<void> {
		const session = context ?? accessor.get(ISessionContext).session.get();
		if (!session?.capabilities.get().supportsComputerUseVideo || accessor.get(IChatEntitlementService).sentiment.hidden) {
			return;
		}
		const chat = session.activeChat.get();
		const identity: IComputerUseViewerIdentity = { providerId: session.providerId, sessionId: session.sessionId, chatResource: chat.resource };
		const editorService = accessor.get(IEditorService);
		const existing = editorService.editors.find((input): input is ComputerUseEditorInput => input instanceof ComputerUseEditorInput && input.isFor(identity));
		if (existing) {
			await editorService.openEditor(existing, { pinned: true, revealIfOpened: true });
			return;
		}
		const provider = accessor.get(ISessionsProvidersService).getProvider(session.providerId);
		const source = provider?.getComputerUseVideoSource?.(session.sessionId, chat.resource);
		if (!source) {
			throw new Error(localize('computerUse.sourceUnavailable', "Live Computer Use viewing is no longer available for this session on its agent host."));
		}
		const input = new ComputerUseEditorInput(identity, session.title, chat.title, source);
		try {
			await editorService.openEditor(input, { pinned: true, revealIfOpened: true });
		} finally {
			if (!editorService.editors.includes(input)) {
				input.dispose();
			}
		}
	}
}

registerAction2(ViewComputerUseAction);

registerAction2(class PauseComputerUseViewingAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.computerUse.pauseViewing',
			title: localize2('computerUse.pauseViewing', "Pause Viewing"),
			tooltip: localize2('computerUse.pauseViewingTooltip', "Pause Viewing (Does Not Stop the Agent)"),
			icon: Codicon.debugPause,
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 1, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUsePausedContext.negate()) },
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
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 1, when: ContextKeyExpr.and(ComputerUsePlayerContext, ComputerUsePausedContext) },
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
			menu: { id: Menus.ComputerUsePlayer, group: 'navigation', order: 2, when: ComputerUsePlayerContext },
		});
	}
	override async run(_accessor: ServicesAccessor, player?: ComputerUsePlayer): Promise<void> {
		await player?.toggleFullScreen();
	}
});
