/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/computerUsePlayer.css';
import * as dom from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { resizeImage } from '../../../../workbench/contrib/chat/browser/chatImageUtils.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { Menus } from '../../../browser/menus.js';
import { COMPUTER_USE_ACCESSIBILITY_VERBOSITY, ComputerUseAnnotatingContext, ComputerUseAnnotationAttachingContext, ComputerUseAnnotationStyleContext, ComputerUseAnnotationWidthContext, ComputerUseFocusedContext, ComputerUseFollowActionContext, ComputerUseFullScreenContext, ComputerUseFullScreenSupportedContext, ComputerUseHasAnnotationsContext, ComputerUseHasFrameContext, ComputerUsePausedContext, ComputerUsePlayerContext } from './computerUseContext.js';
import { ComputerUseAnnotationCanvas, ComputerUseAnnotationStyle, ComputerUseAnnotationWidth } from './computerUseAnnotationCanvas.js';
import { createComputerUseVideoDecoder, createComputerUseVideoScheduler } from './computerUseDecoder.js';
import { ComputerUseEditorInput } from './computerUseEditorInput.js';
import { ComputerUseVideo, IComputerUsePlaybackState, IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler, IComputerUseStopState } from './computerUseVideo.js';
import { ComputerUseVideoCanvas } from './computerUseVideoCanvas.js';
import { ComputerUseThoughtBubble } from './computerUseThoughtBubble.js';
import { ComputerUseRecordingTimeline } from './computerUseRecordingTimeline.js';

export interface IComputerUsePlayerOptions {
	readonly decoderFactory?: IComputerUseVideoDecoderFactory;
	readonly scheduler?: IComputerUseVideoScheduler;
	readonly isDocumentVisible?: () => boolean;
}

const CONTROLS_IDLE_HIDE_DELAY_MS = 2500;
const PLAYBACK_FEEDBACK_HIDE_DELAY_MS = 700;

function annotationStyleLabel(style: ComputerUseAnnotationStyle): string {
	switch (style) {
		case 'yellow': return localize('computerUse.annotationStyle.yellow', "Yellow");
		case 'pink': return localize('computerUse.annotationStyle.pink', "Pink");
		case 'blue': return localize('computerUse.annotationStyle.blue', "Blue");
	}
}

function annotationWidthLabel(width: ComputerUseAnnotationWidth): string {
	switch (width) {
		case 'thin': return localize('computerUse.annotationWidth.thin', "Thin");
		case 'medium': return localize('computerUse.annotationWidth.medium', "Medium");
		case 'thick': return localize('computerUse.annotationWidth.thick', "Thick");
	}
}
export class ComputerUsePlayer extends Disposable {

	readonly domNode: HTMLElement;
	readonly scopedContextKeyService: IContextKeyService;
	readonly video: ComputerUseVideo;
	readonly videoCanvas: ComputerUseVideoCanvas;
	readonly thoughtBubble: ComputerUseThoughtBubble;
	readonly recordingTimeline?: ComputerUseRecordingTimeline;
	readonly annotationCanvas: ComputerUseAnnotationCanvas;

	private readonly canvas: HTMLCanvasElement;
	private readonly stage: HTMLElement;
	private readonly hostLabel: HTMLElement;
	private readonly stopButton?: Button;
	private readonly statusLabel: HTMLElement;
	private readonly statusIcon: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly stateMessage: HTMLElement;
	private readonly stateMessageIcon: HTMLElement;
	private readonly stateMessageText: HTMLElement;
	private readonly playbackFeedback: HTMLElement;
	private readonly playbackFeedbackIcon: HTMLElement;
	private readonly actionError: HTMLElement;
	private readonly controlRow: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private toolbar: MenuWorkbenchToolBar | undefined;
	private readonly scheduler: IComputerUseVideoScheduler;
	private readonly isDocumentVisible: () => boolean;
	private readonly controlsIdle = this._register(new MutableDisposable<IDisposable>());
	private readonly playbackFeedbackHide = this._register(new MutableDisposable<IDisposable>());
	private readonly fullScreenError = observableValue<string | undefined>(this, undefined);
	private readonly annotatingContext: IContextKey<boolean>;
	private readonly annotationAttachingContext: IContextKey<boolean>;
	private annotationResumePlayback = false;
	private statusIconBusy = false;
	private visible = false;
	private disposed = false;
	private controlsPointerInside = false;
	private previousFullScreenFocus: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		readonly input: ComputerUseEditorInput,
		options: IComputerUsePlayerOptions | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IThemeService private readonly themeService: IThemeService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.domNode = dom.append(container, dom.$('.computer-use-player', { role: 'region', tabindex: '0' }));
		this.scheduler = options?.scheduler ?? createComputerUseVideoScheduler(this.domNode);
		this.isDocumentVisible = options?.isDocumentVisible ?? (() => !this.domNode.ownerDocument.hidden);
		const decoderFactory = options?.decoderFactory ?? createComputerUseVideoDecoder(this.domNode);
		this.scopedContextKeyService = this._register(contextKeyService.createScoped(this.domNode));
		const scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));
		ComputerUsePlayerContext.bindTo(this.scopedContextKeyService).set(true);
		const focused = ComputerUseFocusedContext.bindTo(this.scopedContextKeyService);
		const paused = ComputerUsePausedContext.bindTo(this.scopedContextKeyService);
		const fullScreen = ComputerUseFullScreenContext.bindTo(this.scopedContextKeyService);
		const followAction = ComputerUseFollowActionContext.bindTo(this.scopedContextKeyService);
		const hasFrame = ComputerUseHasFrameContext.bindTo(this.scopedContextKeyService);
		this.annotatingContext = ComputerUseAnnotatingContext.bindTo(this.scopedContextKeyService);
		const annotationStyle = ComputerUseAnnotationStyleContext.bindTo(this.scopedContextKeyService);
		const annotationWidth = ComputerUseAnnotationWidthContext.bindTo(this.scopedContextKeyService);
		const hasAnnotations = ComputerUseHasAnnotationsContext.bindTo(this.scopedContextKeyService);
		this.annotationAttachingContext = ComputerUseAnnotationAttachingContext.bindTo(this.scopedContextKeyService);
		ComputerUseFullScreenSupportedContext.bindTo(this.scopedContextKeyService).set(
			!!this.domNode.ownerDocument.fullscreenEnabled && typeof this.domNode.requestFullscreen === 'function',
		);
		const focusTracker = this._register(dom.trackFocus(this.domNode));
		this._register(focusTracker.onDidFocus(() => focused.set(true)));
		this._register(focusTracker.onDidBlur(() => focused.set(false)));

		const header = dom.append(this.domNode, dom.$('.computer-use-header'));
		this.hostLabel = dom.append(header, dom.$('.computer-use-host'));
		if (input.source.kind !== 'recording') {
			const stopContainer = dom.append(header, dom.$('.computer-use-stop'));
			this.stopButton = this._register(new Button(stopContainer, { ...defaultButtonStyles, secondary: true, title: false }));
			this.stopButton.label = localize('computerUse.stopAgent', "Stop Agent");
			this._register(this.stopButton.onDidClick(() => { void this.stopAgent(); }));
			this._register(hoverService.setupDelayedHover(this.stopButton.element, {
				content: localize('computerUse.stopAgentHover', "Stop the agent in this chat on {0}. This is separate from pausing the video.", input.source.hostLabel),
			}));
		}

		const stage = this.stage = dom.append(this.domNode, dom.$('.computer-use-stage', { 'aria-busy': 'true' }));
		this.canvas = dom.append(stage, dom.$('canvas.computer-use-video', { 'aria-hidden': 'true' }));
		this.canvas.width = 0;
		this.canvas.height = 0;
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.CLICK, () => this.toggleViewing()));
		this.annotationCanvas = this._register(scopedInstantiationService.createInstance(ComputerUseAnnotationCanvas, stage));
		this._register(this.annotationCanvas.onDidRequestExit(() => this.returnFromAnnotation()));
		this._register(autorun(reader => {
			if (this.disposed) {
				return;
			}
			annotationStyle.set(this.annotationCanvas.style.read(reader));
			annotationWidth.set(this.annotationCanvas.width.read(reader));
			hasAnnotations.set(this.annotationCanvas.annotationCount.read(reader) > 0);
			this.toolbar?.refresh();
		}));
		this.playbackFeedback = dom.append(stage, dom.$('.computer-use-playback-feedback', { 'aria-hidden': 'true' }));
		this.playbackFeedbackIcon = dom.append(this.playbackFeedback, dom.$('span.computer-use-playback-feedback-icon', { 'aria-hidden': 'true' }));
		this.stateMessage = dom.append(stage, dom.$('.computer-use-state-message', { 'aria-hidden': 'true' }));
		this.stateMessageIcon = dom.append(this.stateMessage, dom.$('span.computer-use-state-message-icon', { 'aria-hidden': 'true' }));
		this.stateMessageIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.loadingCompact));
		this.stateMessageText = dom.append(this.stateMessage, dom.$('span.computer-use-state-message-text'));
		const thoughtBubble = dom.append(stage, dom.$('.computer-use-thought', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-hidden': 'true' }));
		const thoughtLabel = dom.append(thoughtBubble, dom.$('.computer-use-thought-label'));
		const thoughtMessage = dom.append(thoughtBubble, dom.$('.computer-use-thought-message'));
		this.statusLabel = dom.append(stage, dom.$('.computer-use-status', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
		this.statusIcon = dom.append(this.statusLabel, dom.$('span.computer-use-status-icon', { 'aria-hidden': 'true' }));
		this.statusText = dom.append(this.statusLabel, dom.$('span.computer-use-status-text'));
		const controlRow = this.controlRow = dom.append(stage, dom.$('.computer-use-controls'));
		const recordingPosition = input.source.recordingPositionMs;
		const recordingDuration = input.source.recordingDurationMs;
		if (input.source.kind === 'recording' && recordingPosition && recordingDuration !== undefined && input.source.seek) {
			this.recordingTimeline = this._register(new ComputerUseRecordingTimeline(
				controlRow,
				input.source,
				recordingDuration,
				decoderFactory,
				this.scheduler,
				positionMs => this.video.seek(positionMs),
			));
		}
		const toolbarContainer = this.toolbarContainer = dom.append(controlRow, dom.$('.computer-use-toolbar'));
		const toolbar = this.toolbar = this._register(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.ComputerUsePlayer, {
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			menuOptions: { shouldForwardArgs: true },
			ariaLabel: input.source.kind === 'recording'
				? localize('computerUse.recordingControls', "Recording Playback Controls")
				: localize('computerUse.controls', "Live Video Controls"),
			icon: false,
			label: true,
			toolbarOptions: {
				primaryGroup: () => true,
				useSeparatorsInPrimaryActions: true,
			},
		}));
		toolbar.context = this;
		const followStatus = dom.append(this.domNode, dom.$('.computer-use-follow-status', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
		const footer = dom.append(this.domNode, dom.$('.computer-use-footer'));
		this.actionError = dom.append(footer, dom.$('.computer-use-action-error', { role: 'alert' }));
		this.actionError.hidden = true;

		this._register(hoverService.setupDelayedHover(this.hostLabel, () => ({ content: this.hostLabel.textContent ?? '' })));
		this._register(hoverService.setupDelayedHover(this.statusLabel, () => ({ content: this.statusLabel.getAttribute('aria-label') ?? this.statusText.textContent ?? '' })));

		this.thoughtBubble = this._register(new ComputerUseThoughtBubble(
			input.source.thought ?? constObservable(undefined),
			input.activity,
			this.scheduler,
		));
		this._register(autorun(reader => {
			const thought = this.thoughtBubble.state.read(reader);
			const visible = thought?.visible === true;
			thoughtBubble.classList.toggle('is-visible', visible);
			thoughtBubble.classList.toggle('is-streaming', visible && thought.streaming);
			thoughtBubble.setAttribute('aria-hidden', String(!visible));
			if (thought) {
				thoughtLabel.textContent = thought.source === 'reasoning'
					? localize('computerUse.thought.reasoning', "Agent thinking")
					: localize('computerUse.thought.activity', "Agent activity");
				thoughtMessage.textContent = thought.message;
			}
		}));
		this.videoCanvas = this._register(new ComputerUseVideoCanvas(this.canvas, this.scheduler, accessibilityService.isMotionReduced()));
		this.video = this._register(new ComputerUseVideo(
			input.source,
			decoderFactory,
			this.scheduler,
			{
				render: (frame, focus) => {
					this.videoCanvas.render(frame, focus);
					this.domNode.classList.add('has-frame');
					hasFrame.set(true);
					this.toolbar?.refresh();
				},
				clear: () => {
					if (this.disposed) {
						this.videoCanvas.clear();
						return;
					}
					if (this.annotationCanvas.isActive) {
						this.returnFromAnnotation(false, false);
					}
					this.videoCanvas.clear();
					this.domNode.classList.remove('has-frame');
					hasFrame.set(false);
					this.toolbar?.refresh();
				},
			},
		));
		this._register(autorun(reader => {
			const following = this.videoCanvas.followAction.read(reader);
			this.videoCanvas.tracking.read(reader);
			this.video.state.read(reader);
			followAction.set(following);
			followStatus.hidden = !following;
			followStatus.textContent = following ? this.getFollowActionMessage() : '';
		}));
		this._register(accessibilityService.onDidChangeReducedMotion(() => {
			this.videoCanvas.setReducedMotion(accessibilityService.isMotionReduced());
			this.updatePlayerAnimations();
		}));
		this._register(themeService.onDidColorThemeChange(() => this.updatePlayerAnimations()));
		this._register(dom.addDisposableListener(stage, dom.EventType.POINTER_MOVE, () => this.revealControls()));
		this._register(dom.addDisposableListener(stage, dom.EventType.POINTER_DOWN, () => this.revealControls()));
		this._register(dom.addDisposableListener(stage, dom.EventType.POINTER_LEAVE, () => this.hideControls()));
		this._register(dom.addDisposableListener(controlRow, dom.EventType.MOUSE_ENTER, () => {
			this.controlsPointerInside = true;
			this.controlsIdle.clear();
			this.domNode.classList.add('is-controls-visible');
		}));
		this._register(dom.addDisposableListener(controlRow, dom.EventType.MOUSE_LEAVE, () => {
			this.controlsPointerInside = false;
			this.revealControls();
		}));
		const controlsFocusTracker = this._register(dom.trackFocus(controlRow));
		this._register(controlsFocusTracker.onDidFocus(() => {
			this.controlsIdle.clear();
			this.domNode.classList.add('is-controls-visible');
		}));
		this._register(controlsFocusTracker.onDidBlur(() => this.revealControls()));

		this._register(autorun(reader => {
			const sessionTitle = input.sessionTitle.read(reader);
			const chatTitle = input.chatTitle.read(reader);
			this.hostLabel.textContent = input.source.hostLabel;
			const sessionAndChat = sessionTitle === chatTitle ? sessionTitle : localize('computerUse.sessionAndChat', "{0} / {1}", sessionTitle, chatTitle);
			this.domNode.setAttribute('aria-label', input.source.kind === 'recording'
				? localize('computerUse.recordingPlayerLabel', "Computer Use recording, {0}", input.source.hostLabel)
				: localize('computerUse.playerLabel', "Computer Use, {0}, {1}", input.source.hostLabel, sessionAndChat));
		}));
		this._register(autorun(reader => {
			const state = this.video.state.read(reader);
			const manuallyPaused = this.video.paused.read(reader);
			const stop = this.video.stopState.read(reader);
			const error = stop.message ?? this.fullScreenError.read(reader);
			if (this.stopButton) {
				this.stopButton.enabled = stop.status !== 'stopping' && stop.status !== 'stopped';
				this.stopButton.label = stop.status === 'stopping'
					? localize('computerUse.stoppingAgent', "Stopping Agent…")
					: stop.status === 'stopped'
						? localize('computerUse.stoppedAgent', "Agent Stopped")
						: localize('computerUse.stopAgent', "Stop Agent");
			}
			paused.set(manuallyPaused || ['error', 'permissionRequired', 'unsupported', 'stopped'].includes(state.status));
			const bufferedLiveFrame = state.status === 'starting'
				&& state.phase === 'buffering'
				&& this.domNode.classList.contains('has-frame');
			this.domNode.classList.toggle('is-live', input.source.kind !== 'recording' && (state.status === 'live' || bufferedLiveFrame));
			this.domNode.classList.toggle('is-recording', input.source.kind === 'recording');
			this.domNode.classList.toggle('is-stopped', state.status === 'stopped' || stop.status === 'stopped');
			this.domNode.classList.toggle('is-last-frame', !!state.retainedFrame);
			this.domNode.classList.toggle('is-error', ['error', 'permissionRequired', 'unsupported'].includes(state.status));
			this.domNode.classList.toggle('is-buffering', state.status === 'starting' && state.phase !== 'resuming');
			this.domNode.classList.toggle('is-paused', state.status === 'paused' || manuallyPaused);
			this.domNode.classList.toggle('has-action-error', !!error);
			this.updateVisualStatus(state, manuallyPaused, stop);
			if (this.shouldAutoHideControls()) {
				this.revealControls();
			} else {
				this.controlsIdle.clear();
				this.domNode.classList.add('is-controls-visible');
			}
			this.updatePlayerAnimations();
			this.videoCanvas.setPaused(state.status !== 'live');
			this.stateMessageText.textContent = state.message;
			this.actionError.hidden = !error;
			this.actionError.textContent = error ?? '';
		}));

		const targetDocument = this.domNode.ownerDocument;
		this._register(dom.addDisposableListener(targetDocument, 'visibilitychange', () => this.updateVisibility()));
		this._register(dom.addDisposableListener(targetDocument, 'fullscreenchange', () => {
			const isFullScreen = this.isFullScreen;
			fullScreen.set(isFullScreen);
			if (!isFullScreen && this.previousFullScreenFocus) {
				(this.previousFullScreenFocus.isConnected ? this.previousFullScreenFocus : this.domNode).focus();
				this.previousFullScreenFocus = undefined;
			}
		}));
		this._register(dom.addDisposableListener(this.domNode, dom.EventType.KEY_DOWN, event => {
			this.revealControls();
			if (!this.isFullScreen) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				void this.toggleFullScreen();
			} else if (event.key === 'Tab') {
				const activeElement = this.playerRoot.activeElement;
				if (event.shiftKey && activeElement === this.domNode) {
					event.preventDefault();
					for (let index = toolbar.getItemsLength() - 1; index >= 0; index--) {
						if (toolbar.getItemAction(index)?.enabled) {
							toolbar.focus(index);
							break;
						}
					}
				} else if (!event.shiftKey && toolbarContainer.contains(activeElement)) {
					event.preventDefault();
					this.domNode.focus();
				}
			}
		}));
		this._register(Event.once(input.onWillDispose)(() => this.dispose()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(COMPUTER_USE_ACCESSIBILITY_VERBOSITY)) {
				this.updateAccessibilityHint();
			}
		}));
		this._register(accessibilityService.onDidChangeScreenReaderOptimized(() => this.updateAccessibilityHint()));
		this._register(keybindingService.onDidUpdateKeybindings(() => this.updateAccessibilityHint()));
		this.updateAccessibilityHint();
	}

	private updateAccessibilityHint(): void {
		const hint = this.configurationService.getValue<boolean>(COMPUTER_USE_ACCESSIBILITY_VERBOSITY) !== false
			&& this.accessibilityService.isScreenReaderOptimized()
			? localize('computerUse.accessibilityHint', "Use {0} for Computer Use accessibility help.", this.keybindingService.lookupKeybinding('editor.action.accessibilityHelp')?.getAriaLabel() ?? localize('computerUse.accessibilityHelpCommand', "the Open Accessibility Help command"))
			: '';
		this.domNode.setAttribute('aria-description', hint);
	}

	setVisible(visible: boolean): void {
		if (!visible && this.annotationCanvas.isActive) {
			this.returnFromAnnotation(this.annotationResumePlayback, false);
		}
		this.visible = visible;
		this.thoughtBubble.setVisible(visible);
		if (!visible) {
			void this.exitFullScreen(false);
			this.controlsIdle.clear();
			this.domNode.classList.remove('is-controls-visible');
		} else {
			this.revealControls();
		}
		this.updateVisibility();
	}

	private updateVisibility(): void {
		this.updatePlayerAnimations();
		this.video.setVisible(this.visible && this.isDocumentVisible());
	}

	private updatePlayerAnimations(): void {
		const motionEnabled = this.visible && this.isDocumentVisible()
			&& !this.accessibilityService.isMotionReduced() && !isHighContrast(this.themeService.getColorTheme().type);
		this.domNode.classList.toggle('is-hud-animated', motionEnabled);
		this.domNode.classList.toggle('is-live-indicator-animated', motionEnabled && this.video.state.get().status === 'live');
		this.statusIcon.classList.toggle('codicon-modifier-spin', motionEnabled && this.statusIconBusy);
		this.stateMessageIcon.classList.toggle('codicon-modifier-spin', motionEnabled && this.statusIconBusy);
	}

	private updateVisualStatus(state: IComputerUsePlaybackState, manuallyPaused: boolean, stop: IComputerUseStopState): void {
		let label: string;
		let icon: ThemeIcon;
		let busy = false;
		let announcement = state.message;
		if (stop.status === 'stopping') {
			label = localize('computerUse.visualStatus.stopping', "Stopping");
			icon = Codicon.loadingCompact;
			busy = true;
			announcement = localize('computerUse.visualStatus.stoppingAnnouncement', "Stopping Agent…");
		} else if (stop.status === 'stopped' || state.status === 'stopped') {
			label = localize('computerUse.visualStatus.stopped', "Stopped");
			icon = Codicon.debugStop;
		} else if (manuallyPaused || state.status === 'paused') {
			label = localize('computerUse.visualStatus.paused', "Paused");
			icon = Codicon.debugPause;
		} else if (state.retainedFrame) {
			label = localize('computerUse.visualStatus.ended', "Ended");
			icon = Codicon.primitiveSquare;
		} else if (state.status === 'live') {
			label = this.input.source.kind === 'recording'
				? localize('computerUse.visualStatus.playing', "Playing")
				: localize('computerUse.visualStatus.live', "Live");
			icon = this.input.source.kind === 'recording' ? Codicon.play : Codicon.circleFilledCompact;
		} else if (state.status === 'starting') {
			switch (state.phase) {
				case 'resuming':
					label = localize('computerUse.visualStatus.resuming', "Resuming");
					icon = Codicon.play;
					break;
				case 'reconnecting':
					busy = true;
					icon = Codicon.loadingCompact;
					label = localize('computerUse.visualStatus.reconnecting', "Reconnecting");
					break;
				case 'finishing':
					busy = true;
					icon = Codicon.loadingCompact;
					label = localize('computerUse.visualStatus.finishing', "Finishing");
					break;
				case 'buffering':
					busy = true;
					icon = Codicon.loadingCompact;
					label = localize('computerUse.visualStatus.buffering', "Buffering");
					break;
				default:
					busy = true;
					icon = Codicon.loadingCompact;
					label = localize('computerUse.visualStatus.connecting', "Connecting");
			}
		} else if (state.status === 'idle') {
			label = localize('computerUse.visualStatus.waiting', "Waiting");
			icon = Codicon.loadingCompact;
			busy = true;
		} else if (state.status === 'permissionRequired') {
			label = localize('computerUse.visualStatus.permissionRequired', "Permission required");
			icon = Codicon.warningCompact;
		} else {
			label = localize('computerUse.visualStatus.unavailable', "Unavailable");
			icon = Codicon.errorSmall;
		}
		this.statusIconBusy = busy;
		this.statusIcon.className = 'computer-use-status-icon';
		this.statusIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
		this.statusText.textContent = label;
		this.statusLabel.setAttribute('aria-label', announcement);
		this.stage.setAttribute('aria-busy', String(busy));
		this.stateMessageIcon.hidden = !busy;
	}

	private revealControls(): void {
		this.controlsIdle.clear();
		this.domNode.classList.add('is-controls-visible');
		if (this.visible && this.shouldAutoHideControls()) {
			this.controlsIdle.value = this.scheduler.schedule(() => {
				this.controlsIdle.clear();
				if (this.shouldAutoHideControls() && !this.controlsPointerInside && !this.controlRow.contains(this.playerRoot.activeElement)) {
					this.domNode.classList.remove('is-controls-visible');
				}
			}, CONTROLS_IDLE_HIDE_DELAY_MS);
		}
	}

	private hideControls(): void {
		this.controlsIdle.clear();
		if (this.shouldAutoHideControls() && !this.controlRow.contains(this.playerRoot.activeElement)) {
			this.domNode.classList.remove('is-controls-visible');
		}
	}

	private shouldAutoHideControls(): boolean {
		return this.domNode.classList.contains('has-frame')
			&& !this.annotationCanvas.isActive
			&& (this.input.source.kind === 'recording' || this.video.state.get().status === 'live');
	}

	pauseViewing(): void {
		this.focusPlayerIfControlsFocused();
		this.video.pause();
	}

	resumeViewing(): void {
		this.focusPlayerIfControlsFocused();
		if (this.annotationCanvas.isActive) {
			this.returnFromAnnotation(true);
			return;
		}
		this.video.resume();
	}

	startAnnotation(): void {
		if (this.annotationCanvas.isActive || this.canvas.width < 1 || this.canvas.height < 1) {
			return;
		}
		const state = this.video.state.get();
		this.annotationResumePlayback = !this.video.paused.get() && (state.status === 'live' || state.status === 'starting');
		if (this.annotationResumePlayback) {
			this.video.pause();
		}
		if (!this.annotationCanvas.start(this.canvas)) {
			if (this.annotationResumePlayback) {
				this.video.resume();
			}
			this.annotationResumePlayback = false;
			return;
		}
		this.annotatingContext.set(true);
		this.domNode.classList.add('is-annotating');
		this.toolbar?.refresh();
		this.controlsIdle.clear();
		this.domNode.classList.add('is-controls-visible');
		status(localize('computerUse.annotationStarted', "Annotation mode. The current frame is frozen."));
	}

	setAnnotationStyle(style: ComputerUseAnnotationStyle): void {
		if (this.annotationCanvas.isActive) {
			this.annotationCanvas.setStyle(style);
			status(localize('computerUse.annotationStyleChanged', "{0} highlighter selected.", annotationStyleLabel(style)));
		}
	}

	setAnnotationWidth(width: ComputerUseAnnotationWidth): void {
		if (this.annotationCanvas.isActive) {
			this.annotationCanvas.setWidth(width);
			status(localize('computerUse.annotationWidthChanged', "Highlighter width set to {0}.", annotationWidthLabel(width)));
		}
	}

	resetAnnotations(): void {
		if (this.annotationCanvas.isActive) {
			this.annotationCanvas.reset();
			status(localize('computerUse.annotationsReset', "Annotations cleared."));
		}
	}

	async attachAnnotation(): Promise<void> {
		if (!this.annotationCanvas.isActive || this.annotationAttachingContext.get()) {
			return;
		}
		const chatResource = this.input.attachmentChatResource;
		const widget = chatResource ? this.chatWidgetService.getWidgetBySessionResource(chatResource) : undefined;
		if (!widget) {
			this.notificationService.error(localize('computerUse.annotationChatUnavailable', "The captured chat is not open, so the annotated frame could not be attached. Return to that chat and try again."));
			return;
		}
		this.annotationAttachingContext.set(true);
		this.toolbar?.refresh();
		try {
			const bytes = await resizeImage(await this.annotationCanvas.toPng(), 'image/png');
			const state = this.video.state.get();
			const hasAnnotations = this.annotationCanvas.annotationCount.get() > 0;
			const positionMs = this.input.source.kind === 'recording' ? this.input.source.recordingPositionMs?.get() : undefined;
			const attachment: IChatRequestVariableEntry = {
				kind: 'image',
				id: `computer-use-annotation:${generateUuid()}`,
				name: hasAnnotations
					? localize('computerUse.annotationAttachment', "Annotated Computer Use Frame")
					: localize('computerUse.frameAttachment', "Computer Use Frame"),
				icon: Codicon.fileMedia,
				value: bytes,
				mimeType: 'image/png',
				_meta: {
					'vscode.computerUse.annotation': hasAnnotations,
					'vscode.computerUse.source': this.input.source.kind ?? 'live',
					...(state.target?.app ? { 'vscode.computerUse.application': state.target.app } : {}),
					...(state.target?.title ? { 'vscode.computerUse.windowTitle': state.target.title } : {}),
					...(positionMs !== undefined ? { 'vscode.computerUse.positionMs': Math.round(positionMs) } : {}),
					'vscode.computerUse.followAction': this.videoCanvas.followAction.get(),
				},
			};
			widget.attachmentModel.addContext(attachment);
			widget.focusInput();
			status(hasAnnotations
				? localize('computerUse.annotationAttached', "Annotated frame attached to {0}.", this.input.chatTitle.get())
				: localize('computerUse.frameAttached', "Frame attached to {0}.", this.input.chatTitle.get()));
		} catch (error) {
			this.notificationService.error(localize('computerUse.annotationAttachFailed', "The annotated frame could not be attached: {0}", toErrorMessage(error)));
		} finally {
			this.annotationAttachingContext.set(false);
			this.toolbar?.refresh();
		}
	}

	returnFromAnnotation(resumePlayback = this.annotationResumePlayback, announce = true): void {
		if (!this.annotationCanvas.isActive) {
			return;
		}
		this.annotationCanvas.stop();
		this.annotatingContext.set(false);
		this.domNode.classList.remove('is-annotating');
		this.toolbar?.refresh();
		const shouldResume = resumePlayback && this.video.stopState.get().status !== 'stopped' && this.video.state.get().status !== 'stopped';
		this.annotationResumePlayback = false;
		if (shouldResume) {
			this.video.resume();
		}
		this.revealControls();
		if (announce) {
			this.focus();
			status(localize('computerUse.annotationEnded', "Returned to video."));
		}
	}

	private toggleViewing(): void {
		const state = this.video.state.get();
		if (this.video.paused.get() || state.status === 'paused') {
			this.video.resume();
			this.showPlaybackFeedback(Codicon.play);
		} else if (this.input.source.kind === 'recording' && state.retainedFrame) {
			this.video.seek(0);
			this.showPlaybackFeedback(Codicon.play);
		} else if (state.status === 'live' || state.status === 'starting') {
			this.video.pause();
			this.showPlaybackFeedback(Codicon.debugPause);
		}
	}

	private showPlaybackFeedback(icon: ThemeIcon): void {
		this.playbackFeedbackHide.clear();
		this.playbackFeedbackIcon.className = 'computer-use-playback-feedback-icon';
		this.playbackFeedbackIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
		this.playbackFeedback.classList.add('is-visible');
		this.playbackFeedbackHide.value = this.scheduler.schedule(() => {
			this.playbackFeedbackHide.clear();
			this.playbackFeedback.classList.remove('is-visible');
		}, PLAYBACK_FEEDBACK_HIDE_DELAY_MS);
	}

	toggleFollowAction(): void {
		this.focusPlayerIfControlsFocused();
		this.videoCanvas.setFollowAction(!this.videoCanvas.followAction.get());
	}

	private getFollowActionMessage(): string {
		return !this.videoCanvas.followAction.get()
			? localize('computerUse.followOff', "Follow Action is off. Showing the full window.")
			: this.videoCanvas.tracking.get()
				? this.video.state.get().status === 'live'
					? localize('computerUse.followTracking', "Following the agent's action at 2x zoom.")
					: this.input.source.kind === 'recording'
						? localize('computerUse.followRecordingPaused', "2x view of the recorded frame. Tracking resumes with playback.")
						: localize('computerUse.followPaused', "2x view of the last frame. Tracking resumes with live video.")
				: localize('computerUse.followWaiting', "No agent position is available. Showing the full window until tracking data arrives.");
	}

	stopAgent(): Promise<void> { return this.video.stopAgent(); }

	restartRecordingPlayback(): void {
		if (this.input.source.kind === 'recording') {
			this.video.seek(0);
		}
	}

	private get playerRoot(): Document | ShadowRoot {
		return dom.getShadowRoot(this.domNode) ?? this.domNode.ownerDocument;
	}

	private get isFullScreen(): boolean {
		return this.playerRoot.fullscreenElement === this.domNode;
	}

	private focusPlayerIfControlsFocused(): void {
		if (this.toolbarContainer.contains(this.playerRoot.activeElement)) {
			this.focus();
		}
	}

	async exitFullScreen(restoreFocus = true): Promise<void> {
		if (!restoreFocus) {
			this.previousFullScreenFocus = undefined;
		}
		if (this.isFullScreen) {
			await this.toggleFullScreen();
		}
	}

	async toggleFullScreen(): Promise<void> {
		this.fullScreenError.set(undefined, undefined);
		const targetDocument = this.domNode.ownerDocument;
		try {
			if (this.isFullScreen) {
				await targetDocument.exitFullscreen();
			} else {
				const focused = this.playerRoot.activeElement;
				this.previousFullScreenFocus = dom.isHTMLElement(focused) && this.domNode.contains(focused) ? focused : this.domNode;
				await this.domNode.requestFullscreen();
				if (!this.disposed && this.isFullScreen) {
					this.focus();
				}
			}
		} catch (error) {
			if (!this.disposed) {
				this.fullScreenError.set(localize('computerUse.fullScreenFailed', "Full screen is unavailable: {0}", toErrorMessage(error)), undefined);
			}
		}
	}

	getAccessibleContent(): string {
		const sessionTitle = this.input.sessionTitle.get();
		const chatTitle = this.input.chatTitle.get();
		const sessionAndChat = sessionTitle === chatTitle ? sessionTitle : localize('computerUse.sessionAndChat', "{0} / {1}", sessionTitle, chatTitle);
		const target = this.video.state.get().target;
		const recording = this.input.source.kind === 'recording';
		const targetLabel = target
			? localize('computerUse.target', "{0} — {1}", target.app, target.title || localize('computerUse.untitledWindow', "Untitled window"))
			: localize('computerUse.targetPending', "Only the agent-controlled window is shared");
		const thought = this.thoughtBubble.state.get();
		return [
			recording
				? localize('computerUse.accessibleRecordingIdentity', "Computer Use recording. {0}.", this.input.source.hostLabel)
				: localize('computerUse.accessibleIdentity', "Computer Use on {0}. Session and chat: {1}.", this.input.source.hostLabel, sessionAndChat),
			this.video.state.get().message,
			targetLabel,
			this.getFollowActionMessage(),
			this.annotationCanvas.isActive
				? localize('computerUse.accessibleAnnotation', "Annotation mode is active with {0} mark(s). The current frame is frozen. Selected color: {1}. Selected width: {2}.", this.annotationCanvas.annotationCount.get(), annotationStyleLabel(this.annotationCanvas.style.get()), annotationWidthLabel(this.annotationCanvas.width.get()))
				: '',
			thought?.visible
				? localize('computerUse.accessibleThought', "{0}: {1}", thought.source === 'reasoning'
					? localize('computerUse.thought.reasoning', "Agent thinking")
					: localize('computerUse.thought.activity', "Agent activity"), thought.message)
				: recording ? '' : localize('computerUse.accessibleActivity', "Agent activity: {0}", this.input.activity.get().message),
			this.recordingTimeline?.getAccessibleContent() ?? '',
			this.video.stopState.get().status === 'stopping' ? localize('computerUse.stopping', "Stopping Agent…") : '',
			this.video.stopState.get().message ?? '',
			recording
				? localize('computerUse.accessibleRecording', "This is recorded video of only the application window the agent controlled. Video pixels are not transcribed.")
				: localize('computerUse.accessibleVideo', "This is live video of only the agent-controlled window. Video pixels are not transcribed. Return to the captured chat to read the agent's progress."),
			recording
				? localize('computerUse.accessibleRecordingReadOnly', "Recording playback cannot send input to the host or stop the agent.")
				: localize('computerUse.accessibleReadOnly', "The viewer cannot send mouse or keyboard input to the host. Pausing or closing viewing does not stop the agent. Return to the captured chat to cancel or stop its work."),
		].filter(Boolean).join('\n');
	}

	focus(): void {
		this.domNode.focus();
	}

	override dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.toolbar = undefined;
			this.previousFullScreenFocus = undefined;
			if (this.isFullScreen) {
				void this.domNode.ownerDocument.exitFullscreen().catch(() => { /* The editor may already have been removed. */ });
			}
			super.dispose();
			this.domNode.remove();
		}
	}

}
