/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { COMPUTER_USE_ACCESSIBILITY_VERBOSITY, ComputerUseFocusedContext } from './computerUseContext.js';
import { ComputerUseEditor } from './computerUseEditor.js';

export class ComputerUseAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 120;
	readonly name = 'computerUse';
	readonly type = AccessibleViewType.Help;
	readonly when = ComputerUseFocusedContext;

	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		return createProvider(accessor, this.type);
	}
}

export class ComputerUseAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 120;
	readonly name = 'computerUse';
	readonly type = AccessibleViewType.View;
	readonly when = ComputerUseFocusedContext;

	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		return createProvider(accessor, this.type);
	}
}

function createProvider(accessor: ServicesAccessor, type: AccessibleViewType): AccessibleContentProvider | undefined {
	const editorService = accessor.get(IEditorService);
	const editor = editorService.activeEditorPane;
	const player = editor instanceof ComputerUseEditor ? editor.getPlayer() : undefined;
	if (!player) {
		return undefined;
	}
	const focused = getActiveElement();
	const help = [
		localize('computerUse.help.overview', "You are in the Computer Use viewer. It shows live video of only the application window controlled by the agent. The host, session, and chat are identified above the video. Switching the active session or chat never redirects this viewer."),
		localize('computerUse.help.navigation', "Use Tab and Shift+Tab to move between the viewer, Stop Agent, and video controls. Use the arrow keys within the video controls toolbar. Enter or Space activates a focused action."),
		localize('computerUse.help.pause', "Pause Viewing freezes the last visible frame and disconnects viewing. It does not stop the agent. Resume Viewing reconnects to live video, rather than replaying earlier frames. Hiding or closing the viewer also disconnects viewing without stopping the agent."),
		localize('computerUse.help.stop', "Stop Agent stops the agent in the captured chat on the identified host, even while viewing is paused or video is unavailable. If stopping fails, the error is displayed and the agent may still be running. Try Stop Agent again."),
		localize('computerUse.help.fullScreen', "Full Screen expands the whole player, including Stop Agent and the host and session labels. On macOS desktop, it stays in the current Space so viewing does not move away from the controlled application. Use Exit Full Screen to leave without stopping the agent. Escape also exits full screen, but on the agent host computer it remains the native emergency stop shortcut. Opening accessibility help or the accessible view leaves full screen so its text remains visible."),
		localize('computerUse.help.readOnly', "This is a view-only player. Mouse and keyboard input are not sent to the computer. There is no audio, recording, or playback history."),
		localize('computerUse.help.video', "Video pixels are not transcribed. Open the accessible view to read the host, session, window title, and current viewing status{0}. Return to the captured chat to read the agent's progress.", '<keybinding:editor.action.accessibleView>'),
	].join('\n');
	const provider = new AccessibleContentProvider(
		AccessibleViewProviderId.ComputerUse,
		{ type },
		() => type === AccessibleViewType.View ? player.getAccessibleContent() : help,
		() => {
			if (isHTMLElement(focused) && focused.isConnected) {
				focused.focus();
			} else if (player.domNode.isConnected) {
				player.focus();
			} else {
				editorService.activeEditorPane?.focus();
			}
		},
		COMPUTER_USE_ACCESSIBILITY_VERBOSITY,
		() => { void player.exitFullScreen(false); },
		type === AccessibleViewType.View ? [toAction({
			id: 'sessions.computerUse.stopAgent',
			label: localize('computerUse.stopAgent', "Stop Agent"),
			class: ThemeIcon.asClassName(Codicon.debugStop),
			run: () => player.stopAgent(),
		})] : undefined,
		undefined,
		undefined,
		type === AccessibleViewType.View ? Event.any(
			Event.fromObservableLight(player.video.state),
			Event.fromObservableLight(player.video.stopState),
			Event.fromObservableLight(player.input.sessionTitle),
			Event.fromObservableLight(player.input.chatTitle),
		) : undefined,
	);
	provider.onDidRequestClearLastProvider = Event.map(Event.once(player.input.onWillDispose), () => AccessibleViewProviderId.ComputerUse);
	return provider;
}
