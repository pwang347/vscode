/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
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
	const recording = player.input.source.kind === 'recording';
	const help = [
		recording
			? localize('computerUse.help.recordingOverview', "You are in the Computer Use recording player. It replays video of only the application window the agent controlled. The host is identified above the video.")
			: localize('computerUse.help.overview', "You are in the Computer Use viewer. It shows live video of only the application window controlled by the agent. The host is identified above the video; the accessible view includes the session and chat. Switching the active session or chat never redirects this viewer."),
		recording
			? localize('computerUse.help.openRecording', "A recording opens when you activate its playback command in chat. Activating that command again after playback ends restarts it.")
			: localize('computerUse.help.autoOpen', "The viewer opens automatically when the active chat begins a Computer Use action. Additional Computer Use actions reuse the same viewer without repeatedly moving focus."),
		localize('computerUse.help.navigation', "Use Tab and Shift+Tab to move between the player and video controls. Use the arrow keys within the video controls toolbar. Enter or Space activates a focused action. While video is playing, the controls fade after a short period without interaction; moving the pointer over the video or moving keyboard focus to a control reveals them again."),
		recording
			? localize('computerUse.help.pauseRecording', "Click the video or use Pause Viewing to pause recorded playback on the last visible frame. Click again or use Resume Viewing to continue from the same point. Clicking an ended recording restarts it. Hiding or closing the player also pauses playback.")
			: localize('computerUse.help.pause', "Click the video or use Pause Viewing to freeze the last visible frame and disconnect viewing. Click again or use Resume Viewing to return to the live edge rather than replaying earlier frames. The last frame remains visible while viewing resumes. This does not stop the agent. Hiding or closing the viewer also disconnects viewing without stopping the agent."),
		recording ? localize('computerUse.help.timeline', "Use the Recording Timeline slider to seek. Hover over the timeline or focus it with the keyboard to show a frame preview. Arrow keys adjust the focused slider, and playback resumes from the selected position. Dimmed sections mark periods where the captured image did not change.") : '',
		recording
			? localize('computerUse.help.recordingLastFrame', "When playback ends, the last recorded frame remains visible. Activate the recording's playback command in chat to restart it.")
			: localize('computerUse.help.lastFrame', "When live viewing completes, the last received video frame remains visible and is labelled as not live. That retained frame is separate from the host-side recording. A transient connection interruption, closed agent-controlled window, or same-window decoder synchronization keeps it visible; the top-left status reports Buffering or Reconnecting. A new target clears the old frame before new footage paints; permission failures and persistent connection errors also clear it."),
		localize('computerUse.help.recording', "After a Computer Use operation, its recording appears in chat and opens in this player. The agent host retains the newest 30 minutes up to 500 MiB, may trim older footage, and deletes the recording with its chat or archived session. Recorded playback also replays bounded provider-shared reasoning and activity bubbles captured during the recording; hidden reasoning is never included. Recorded playback is labelled separately from live video, cannot send input to the host, and does not offer Stop Agent."),
		localize('computerUse.help.follow', "Follow Action toggles a 2x magnified view centered on the agent's cursor or focused control. It changes only this viewer, not the host application's zoom or keyboard focus. Turning it off immediately shows the full window. Older hosts or missing tracking data show the full window. Panning honors reduced-motion preferences, and pauses with the footage."),
		localize('computerUse.help.annotation', "Annotate Frame freezes a copy of the currently displayed frame and opens highlighter controls. Choose a yellow, pink, or blue highlighter and a thin, medium, or thick width. New annotations use the selected color and width; existing marks remain unchanged. Draw with the pointer, or use the arrow keys to move the keyboard marker and Space to start or stop a stroke. Reset Annotations clears every mark. Attach to Chat adds the frozen frame to the exact captured chat, with or without highlights, and includes its application, window, source, Follow Action state, and recording timestamp when available. Return to Video or Escape exits annotation mode and resumes only if playback was running before annotation started."),
		localize('computerUse.help.activity', "A transient bubble appears only when the agent shares reasoning or a user-visible activity update. It fades after inactivity and is omitted when the agent shares nothing. The accessible view includes the current bubble text. It never exposes hidden reasoning."),
		recording
			? localize('computerUse.help.recordingStop', "Recorded playback cannot stop or send input to an agent.")
			: localize('computerUse.help.stop', "Stop Agent stops the agent in the captured chat. It works while viewing is paused or video is unavailable. You can also return to the captured chat to cancel its work."),
		localize('computerUse.help.fullScreen', "Full Screen expands the whole player, including the host name and video controls. On macOS desktop, it stays in the current Space so viewing does not move away from the controlled application. Use Exit Full Screen to leave without stopping the agent. Escape also exits full screen, but on the agent host computer it remains the native emergency stop shortcut. Opening accessibility help or the accessible view leaves full screen so its text remains visible."),
		localize('computerUse.help.readOnly', "This is a view-only player. Mouse and keyboard input are not sent to the computer. Computer Use video has no audio."),
		recording
			? localize('computerUse.help.recordingVideo', "Video pixels are not transcribed. Visual indicators distinguish loading, playing, paused, ended, and unavailable states. Open the accessible view to read the host, window title, and full playback status{0}.", '<keybinding:editor.action.accessibleView>')
			: localize('computerUse.help.video', "Video pixels are not transcribed. Visual indicators distinguish connecting, buffering, reconnecting, live, paused, ended, stopped, and unavailable states. Open the accessible view to read the host, session, window title, and full current viewing status{0}. Return to the captured chat to read the agent's progress.", '<keybinding:editor.action.accessibleView>'),
	].filter(Boolean).join('\n');
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
		undefined,
		undefined,
		undefined,
		type === AccessibleViewType.View ? Event.any(
			Event.fromObservableLight(player.video.state),
			Event.fromObservableLight(player.video.stopState),
			Event.fromObservableLight(player.videoCanvas.followAction),
			Event.fromObservableLight(player.videoCanvas.tracking),
			Event.fromObservableLight(player.input.activity),
			Event.fromObservableLight(player.input.sessionTitle),
			Event.fromObservableLight(player.input.chatTitle),
		) : undefined,
	);
	provider.onDidRequestClearLastProvider = Event.map(Event.once(player.input.onWillDispose), () => AccessibleViewProviderId.ComputerUse);
	return provider;
}
