/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/computerUsePlayer.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Menus } from '../../../browser/menus.js';
import { COMPUTER_USE_ACCESSIBILITY_VERBOSITY, ComputerUseFocusedContext, ComputerUseFullScreenContext, ComputerUseFullScreenSupportedContext, ComputerUsePausedContext, ComputerUsePlayerContext } from './computerUseContext.js';
import { createComputerUseVideoDecoder, createComputerUseVideoScheduler } from './computerUseDecoder.js';
import { ComputerUseEditorInput } from './computerUseEditorInput.js';
import { ComputerUseVideo, IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler } from './computerUseVideo.js';

export interface IComputerUsePlayerOptions {
	readonly decoderFactory?: IComputerUseVideoDecoderFactory;
	readonly scheduler?: IComputerUseVideoScheduler;
}

export class ComputerUsePlayer extends Disposable {

	readonly domNode: HTMLElement;
	readonly scopedContextKeyService: IContextKeyService;
	readonly video: ComputerUseVideo;

	private readonly canvas: HTMLCanvasElement;
	private readonly hostLabel: HTMLElement;
	private readonly sessionLabel: HTMLElement;
	private readonly targetLabel: HTMLElement;
	private readonly statusLabel: HTMLElement;
	private readonly stateMessage: HTMLElement;
	private readonly actionError: HTMLElement;
	private readonly stopButton: Button;
	private readonly toolbarContainer: HTMLElement;
	private readonly fullScreenError = observableValue<string | undefined>(this, undefined);
	private visible = false;
	private disposed = false;
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
	) {
		super();
		this.domNode = dom.append(container, dom.$('.computer-use-player', { role: 'region', tabindex: '0' }));
		this.scopedContextKeyService = this._register(contextKeyService.createScoped(this.domNode));
		const scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));
		ComputerUsePlayerContext.bindTo(this.scopedContextKeyService).set(true);
		const focused = ComputerUseFocusedContext.bindTo(this.scopedContextKeyService);
		const paused = ComputerUsePausedContext.bindTo(this.scopedContextKeyService);
		const fullScreen = ComputerUseFullScreenContext.bindTo(this.scopedContextKeyService);
		ComputerUseFullScreenSupportedContext.bindTo(this.scopedContextKeyService).set(
			!!this.domNode.ownerDocument.fullscreenEnabled && typeof this.domNode.requestFullscreen === 'function',
		);
		const focusTracker = this._register(dom.trackFocus(this.domNode));
		this._register(focusTracker.onDidFocus(() => focused.set(true)));
		this._register(focusTracker.onDidBlur(() => focused.set(false)));

		const header = dom.append(this.domNode, dom.$('.computer-use-header'));
		const identity = dom.append(header, dom.$('.computer-use-identity'));
		this.hostLabel = dom.append(identity, dom.$('.computer-use-host'));
		this.sessionLabel = dom.append(identity, dom.$('h2.computer-use-session'));
		const stopContainer = dom.append(header, dom.$('.computer-use-stop'));
		this.stopButton = this._register(new Button(stopContainer, { ...defaultButtonStyles, title: false }));
		this.stopButton.label = localize('computerUse.stopAgent', "Stop Agent");
		this._register(this.stopButton.onDidClick(() => { void this.stopAgent(); }));
		this._register(hoverService.setupDelayedHover(this.stopButton.element, {
			content: localize('computerUse.stopAgentHover', "Stop the agent in this chat on {0}. This is separate from pausing the video.", input.source.hostLabel),
		}));

		const stage = dom.append(this.domNode, dom.$('.computer-use-stage'));
		this.canvas = dom.append(stage, dom.$('canvas.computer-use-video', { 'aria-hidden': 'true' }));
		this.canvas.width = 0;
		this.canvas.height = 0;
		this.stateMessage = dom.append(stage, dom.$('.computer-use-state-message', { 'aria-hidden': 'true' }));
		const footer = dom.append(this.domNode, dom.$('.computer-use-footer'));
		this.targetLabel = dom.append(footer, dom.$('.computer-use-target'));
		const controlRow = dom.append(footer, dom.$('.computer-use-controls'));
		this.statusLabel = dom.append(controlRow, dom.$('.computer-use-status', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
		const toolbarContainer = this.toolbarContainer = dom.append(controlRow, dom.$('.computer-use-toolbar'));
		const toolbar = this._register(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.ComputerUsePlayer, {
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			menuOptions: { shouldForwardArgs: true },
			ariaLabel: localize('computerUse.controls', "Live Video Controls"),
			icon: false,
			label: true,
		}));
		toolbar.context = this;
		dom.append(footer, dom.$('.computer-use-viewing-note', {}, localize('computerUse.viewingNote', "Pausing viewing does not stop the agent.")));
		this.actionError = dom.append(footer, dom.$('.computer-use-action-error', { role: 'alert' }));
		this.actionError.hidden = true;

		for (const label of [this.hostLabel, this.sessionLabel, this.targetLabel, this.statusLabel]) {
			this._register(hoverService.setupDelayedHover(label, () => ({ content: label.textContent ?? '' })));
		}

		this.video = this._register(new ComputerUseVideo(
			input.source,
			options?.decoderFactory ?? createComputerUseVideoDecoder(this.domNode),
			options?.scheduler ?? createComputerUseVideoScheduler(this.domNode),
			{
				render: frame => {
					if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
						this.canvas.width = frame.width;
						this.canvas.height = frame.height;
					}
					const context = this.canvas.getContext('2d', { alpha: false });
					if (!context) {
						throw new Error(localize('computerUse.canvasUnavailable', "A video rendering surface is unavailable."));
					}
					frame.draw(context);
					this.domNode.classList.add('has-frame');
				},
				clear: () => {
					this.canvas.width = 0;
					this.canvas.height = 0;
					this.domNode.classList.remove('has-frame');
				},
			},
		));

		this._register(autorun(reader => {
			const sessionTitle = input.sessionTitle.read(reader);
			const chatTitle = input.chatTitle.read(reader);
			this.hostLabel.textContent = input.source.hostLabel;
			this.sessionLabel.textContent = sessionTitle === chatTitle ? sessionTitle : localize('computerUse.sessionAndChat', "{0} / {1}", sessionTitle, chatTitle);
			this.domNode.setAttribute('aria-label', localize('computerUse.playerLabel', "Computer Use, {0}, {1}", input.source.hostLabel, this.sessionLabel.textContent));
			this.stopButton.setAriaLabel(localize('computerUse.stopAgentAria', "Stop Agent, {0}, {1}", chatTitle, input.source.hostLabel));
		}));
		this._register(autorun(reader => {
			const state = this.video.state.read(reader);
			const manuallyPaused = this.video.paused.read(reader);
			const stop = this.video.stopState.read(reader);
			const error = stop.message ?? this.fullScreenError.read(reader);
			paused.set(manuallyPaused || ['error', 'permissionRequired', 'unsupported', 'stopped'].includes(state.status));
			this.domNode.classList.toggle('is-live', state.status === 'live');
			this.domNode.classList.toggle('is-error', ['error', 'permissionRequired', 'unsupported'].includes(state.status));
			this.statusLabel.textContent = state.message;
			this.stateMessage.textContent = state.message;
			this.targetLabel.textContent = state.target
				? localize('computerUse.target', "{0} — {1}", state.target.app, state.target.title || localize('computerUse.untitledWindow', "Untitled window"))
				: localize('computerUse.targetPending', "Only the agent-controlled window is shared");
			this.stopButton.enabled = stop.status !== 'stopping' && stop.status !== 'stopped';
			this.stopButton.label = stop.status === 'stopping' ? localize('computerUse.stopping', "Stopping Agent…")
				: stop.status === 'stopped' ? localize('computerUse.stopped', "Agent Stopped")
					: localize('computerUse.stopAgent', "Stop Agent");
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
		this.visible = visible;
		if (!visible) {
			void this.exitFullScreen(false);
		}
		this.updateVisibility();
	}

	private updateVisibility(): void {
		this.video.setVisible(this.visible && !this.domNode.ownerDocument.hidden);
	}

	pauseViewing(): void {
		this.focusPlayerIfControlsFocused();
		this.video.pause();
	}

	resumeViewing(): void {
		this.focusPlayerIfControlsFocused();
		this.video.resume();
	}

	stopAgent(): Promise<void> { return this.video.stopAgent(); }

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
		return [
			localize('computerUse.accessibleIdentity', "Computer Use on {0}. Session and chat: {1}.", this.input.source.hostLabel, this.sessionLabel.textContent),
			this.video.state.get().message,
			this.targetLabel.textContent ?? '',
			this.video.stopState.get().status === 'stopping' ? localize('computerUse.stopping', "Stopping Agent…") : '',
			this.video.stopState.get().message ?? '',
			localize('computerUse.accessibleVideo', "This is live video of only the agent-controlled window. Video pixels are not transcribed. Return to the captured chat to read the agent's progress."),
			localize('computerUse.accessibleReadOnly', "The viewer cannot send mouse or keyboard input to the host. Pausing or closing viewing does not stop the agent. Use Stop Agent to stop its work."),
		].filter(Boolean).join('\n');
	}

	focus(): void {
		this.domNode.focus();
	}

	override dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.previousFullScreenFocus = undefined;
			if (this.isFullScreen) {
				void this.domNode.ownerDocument.exitFullscreen().catch(() => { /* The editor may already have been removed. */ });
			}
			super.dispose();
			this.domNode.remove();
		}
	}
}
