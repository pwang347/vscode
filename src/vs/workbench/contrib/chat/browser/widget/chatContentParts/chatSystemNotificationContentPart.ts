/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { Button, IButtonStyles } from '../../../../../../base/browser/ui/button/button.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { dirname, isEqual, joinPath } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES, parseComputerUseRecordingManifestJson, parseComputerUseRecordingSegment } from '../../../../../../platform/agentHost/common/computerUseRecording.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IChatSystemNotificationPart } from '../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { getCompactCodicon } from '../../chatIcons.js';
import './media/chatSystemNotificationContentPart.css';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatProgressSubPart } from './chatProgressContentPart.js';

const transparentButtonStyles: IButtonStyles = {
	buttonBackground: undefined,
	buttonBorder: undefined,
	buttonForeground: undefined,
	buttonHoverBackground: undefined,
	buttonSecondaryBackground: undefined,
	buttonSecondaryBorder: undefined,
	buttonSecondaryForeground: undefined,
	buttonSecondaryHoverBackground: undefined,
	buttonSeparator: undefined,
};

export class ChatSystemNotificationContentPart extends Disposable implements IChatContentPart {
	readonly domNode: HTMLElement;
	readonly inlineTimingContainer: HTMLElement | undefined;

	constructor(
		private readonly notification: IChatSystemNotificationPart,
		renderer: IMarkdownRenderer,
		private readonly context: IChatContentPartRenderContext | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();

		let notificationNode: HTMLElement;
		if (notification.presentation === 'workspaceTransition') {
			notificationNode = this._renderWorkspaceTransition(notification);
		} else if (notification.presentation === 'computerUseRecording' && notification.computerUseRecording) {
			notificationNode = this._renderComputerUseRecording(notification);
		} else if (notification.collapsible) {
			const firstLineBreak = notification.content.value.indexOf('\n');
			const detailsValue = firstLineBreak === -1 ? '' : notification.content.value.slice(firstLineBreak).trim();
			if (detailsValue) {
				notificationNode = this._renderCollapsibleNotification(notification, renderer, firstLineBreak, detailsValue);
			} else {
				notificationNode = this._renderNotification(notification, renderer, instantiationService);
			}
		} else {
			notificationNode = this._renderNotification(notification, renderer, instantiationService);
		}

		if (notification.renderInlineTiming) {
			this.domNode = dom.$('.chat-system-notification-layout');
			this.domNode.appendChild(notificationNode);
			this.inlineTimingContainer = dom.append(this.domNode, dom.$('span.chat-system-notification-timing'));
		} else {
			this.domNode = notificationNode;
			this.inlineTimingContainer = undefined;
		}
	}

	private _renderComputerUseRecording(notification: IChatSystemNotificationPart): HTMLElement {
		const recording = notification.computerUseRecording!;
		const owner = dom.$('.chat-computer-use-recording');
		const button = this._register(new Button(owner, { ...transparentButtonStyles, title: false }));
		button.element.classList.add('chat-computer-use-recording-button');
		button.element.ariaLabel = notification.accessibilityLabel ?? recording.command.title;
		const preview = dom.append(button.element, dom.$('.chat-computer-use-recording-preview'));
		const canvas = dom.append(preview, dom.$('canvas.chat-computer-use-recording-poster', { 'aria-hidden': 'true' })) as HTMLCanvasElement;
		const placeholder = dom.append(preview, dom.$('span.chat-computer-use-recording-placeholder'));
		placeholder.classList.add(...ThemeIcon.asClassNameArray(Codicon.deviceDesktop));
		placeholder.setAttribute('aria-hidden', 'true');
		const play = dom.append(preview, dom.$('span.chat-computer-use-recording-play'));
		const playIcon = dom.append(play, dom.$('span'));
		playIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
		playIcon.setAttribute('aria-hidden', 'true');
		const totalSeconds = Math.max(0, Math.round(recording.durationMs / 1000));
		const duration = localize('chat.computerUseRecording.duration', "{0}:{1}", Math.floor(totalSeconds / 60), String(totalSeconds % 60).padStart(2, '0'));
		dom.append(preview, dom.$('span.chat-computer-use-recording-duration', undefined, recording.trimmed
			? localize('chat.computerUseRecording.lastDuration', "Last {0}", duration)
			: duration));
		const details = dom.append(button.element, dom.$('.chat-computer-use-recording-details'));
		dom.append(details, dom.$('.chat-computer-use-recording-title', undefined, recording.title));
		dom.append(details, dom.$('.chat-computer-use-recording-kind', undefined, localize('chat.computerUseRecording.kind', "Computer Use recording")));
		this._register(button.onDidClick(() => {
			void this.commandService.executeCommand(
				recording.command.id,
				...(recording.command.arguments ?? []),
				...(this.context ? [this.context.element.sessionResource.toString()] : []),
			);
		}));
		this._register(this.hoverService.setupDelayedHover(button.element, { content: recording.title }));
		void this._renderComputerUseRecordingPoster(canvas, recording.recordingUri).then(() => {
			if (!this._store.isDisposed) {
				owner.classList.add('has-poster');
			}
		}).catch(() => {
			if (!this._store.isDisposed) {
				owner.classList.add('poster-unavailable');
			}
		});
		return owner;
	}

	private async _renderComputerUseRecordingPoster(canvas: HTMLCanvasElement, recordingUri: URI): Promise<void> {
		const manifestFile = await this.fileService.readFile(recordingUri, { limits: { size: COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES } });
		const manifest = parseComputerUseRecordingManifestJson(manifestFile.value.toString());
		const reference = manifest.segments.at(-1);
		if (!manifest.finalized || !reference) {
			throw new Error('Computer Use recording has no poster frame.');
		}
		const segmentFile = await this.fileService.readFile(joinPath(dirname(recordingUri), reference.file), { limits: { size: reference.sizeBytes } });
		if (segmentFile.value.byteLength !== reference.sizeBytes) {
			throw new Error('Computer Use recording poster segment changed.');
		}
		const segment = parseComputerUseRecordingSegment(segmentFile.value.buffer);
		if (segment.samples.length !== reference.sampleCount || Math.ceil(segment.header.durationUs / 1000) !== reference.durationMs) {
			throw new Error('Computer Use recording poster segment does not match its manifest.');
		}
		const sample = segment.samples.find(frame => frame.keyFrame);
		if (!sample) {
			throw new Error('Computer Use recording poster has no keyframe.');
		}
		const targetWindow = dom.getWindow(canvas);
		const Decoder = targetWindow.VideoDecoder;
		const Chunk = targetWindow.EncodedVideoChunk;
		if (typeof Decoder !== 'function' || typeof Chunk !== 'function') {
			throw new Error('Computer Use recording poster decoding is unavailable.');
		}
		const decodedFrame = new DeferredPromise<VideoFrame>();
		const decoder = new Decoder({
			output: frame => decodedFrame.complete(frame),
			error: error => decodedFrame.error(error),
		});
		const decoderDisposable = this._register(toDisposable(() => {
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}));
		try {
			decoder.configure({
				codec: segment.config.codec,
				codedWidth: segment.config.codedWidth,
				codedHeight: segment.config.codedHeight,
				description: segment.config.description,
				optimizeForLatency: true,
			});
			decoder.decode(new Chunk({
				type: 'key',
				timestamp: sample.timestampUs,
				duration: sample.durationUs,
				data: sample.data,
			}));
			const [frame] = await Promise.all([decodedFrame.p, decoder.flush()]);
			try {
				if (this._store.isDisposed) {
					return;
				}
				canvas.width = frame.displayWidth;
				canvas.height = frame.displayHeight;
				const context = canvas.getContext('2d');
				if (!context) {
					throw new Error('Computer Use recording poster canvas is unavailable.');
				}
				context.drawImage(frame, 0, 0);
			} finally {
				frame.close();
			}
		} finally {
			decoderDisposable.dispose();
		}
	}

	private _renderWorkspaceTransition(notification: IChatSystemNotificationPart): HTMLElement {
		const owner = dom.$('.chat-workspace-transition');
		owner.setAttribute('role', 'separator');
		owner.setAttribute('aria-orientation', 'horizontal');
		owner.setAttribute('aria-label', notification.accessibilityLabel ?? renderAsPlaintext(notification.content));
		dom.append(owner, dom.$('span.chat-workspace-transition-line')).setAttribute('aria-hidden', 'true');
		const label = dom.append(owner, dom.$('span.chat-workspace-transition-label'));
		this._register(this.hoverService.setupDelayedHover(label, { content: renderAsPlaintext(notification.content) }));
		const workspaceNameIndex = notification.workspaceName ? notification.content.value.lastIndexOf(notification.workspaceName) : -1;
		const iconIndex = workspaceNameIndex >= 0 ? workspaceNameIndex : 0;
		label.append(notification.content.value.slice(0, iconIndex));
		const icon = dom.append(label, dom.$('span.chat-workspace-transition-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(notification.icon ?? Codicon.folderCompact));
		icon.setAttribute('aria-hidden', 'true');
		label.append(notification.content.value.slice(iconIndex));
		dom.append(owner, dom.$('span.chat-workspace-transition-line')).setAttribute('aria-hidden', 'true');
		return owner;
	}

	private _renderNotification(notification: IChatSystemNotificationPart, renderer: IMarkdownRenderer, instantiationService: IInstantiationService): HTMLElement {
		const rendered = this._register(renderer.render(notification.content));
		return this._register(instantiationService.createInstance(ChatProgressSubPart, rendered.element, notification.icon ?? Codicon.check, undefined)).domNode;
	}

	private _renderCollapsibleNotification(notification: IChatSystemNotificationPart, renderer: IMarkdownRenderer, firstLineBreak: number, detailsValue: string): HTMLElement {
		const summary: IMarkdownString = {
			...notification.content,
			value: notification.content.value.slice(0, firstLineBreak),
		};
		const details: IMarkdownString = {
			...notification.content,
			value: detailsValue,
		};
		const owner = dom.$('.chat-system-notification-disclosure.collapsed');
		const header = this._register(new Button(owner, { ...transparentButtonStyles, title: false }));
		header.element.classList.add('chat-system-notification-disclosure-header');
		const icon = dom.append(header.element, dom.$('span.chat-system-notification-disclosure-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(getCompactCodicon(notification.icon ?? Codicon.check)));
		icon.setAttribute('aria-hidden', 'true');
		const renderedSummary = this._register(renderer.render(summary));
		renderedSummary.element.classList.add('chat-system-notification-disclosure-summary');
		header.element.appendChild(renderedSummary.element);
		const twistie = dom.append(header.element, dom.$('span.chat-collapsible-hover-chevron'));
		twistie.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRightCompact));
		twistie.setAttribute('aria-hidden', 'true');

		const renderedDetails = this._register(renderer.render(details));
		renderedDetails.element.classList.add('chat-system-notification-disclosure-body');
		owner.appendChild(renderedDetails.element);
		const summaryText = renderAsPlaintext(summary);
		const apply = (expanded: boolean) => {
			owner.classList.toggle('collapsed', !expanded);
			twistie.classList.toggle('expanded', expanded);
			header.element.ariaExpanded = String(expanded);
			header.element.ariaLabel = expanded
				? localize('chat.systemNotification.hideDetails', "Hide details for {0}", summaryText)
				: localize('chat.systemNotification.showDetails', "Show details for {0}", summaryText);
		};
		apply(false);
		this._register(header.onDidClick(() => {
			owner.dispatchEvent(new CustomEvent(ChatCollapsibleContentPart.userToggleEvent, { bubbles: true }));
			apply(owner.classList.contains('collapsed'));
		}));
		return owner;
	}

	hasSameContent(other: IChatRendererContent): boolean {
		return other.kind === 'systemNotification'
			&& other.content.value === this.notification.content.value
			&& ThemeIcon.isEqual(other.icon ?? Codicon.check, this.notification.icon ?? Codicon.check)
			&& !!other.collapsible === !!this.notification.collapsible
			&& !!other.renderInlineTiming === !!this.notification.renderInlineTiming
			&& other.presentation === this.notification.presentation
			&& other.workspaceName === this.notification.workspaceName
			&& other.accessibilityLabel === this.notification.accessibilityLabel
			&& other.computerUseRecording?.title === this.notification.computerUseRecording?.title
			&& other.computerUseRecording?.durationMs === this.notification.computerUseRecording?.durationMs
			&& other.computerUseRecording?.trimmed === this.notification.computerUseRecording?.trimmed
			&& isEqual(other.computerUseRecording?.recordingUri, this.notification.computerUseRecording?.recordingUri);
	}
}
