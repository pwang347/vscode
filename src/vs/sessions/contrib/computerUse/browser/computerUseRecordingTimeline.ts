/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IComputerUseDecodedFrame, IComputerUseVideoDecoder, IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler } from './computerUseVideo.js';
import { ComputerUseRecordingActionKind, IComputerUseRecordingActionEvent, IComputerUseRecordingTimelineRange, ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';

const PREVIEW_DELAY_MS = 80;
const MAX_TIMELINE_MARKERS = 256;
const MAX_ACCESSIBLE_ACTIONS = 20;

interface ICompactRecordingAction extends IComputerUseRecordingActionEvent {
	readonly count: number;
}

function actionLabel(kind: ComputerUseRecordingActionKind): string {
	switch (kind) {
		case 'click': return localize('computerUse.recordingAction.click', "Click");
		case 'text': return localize('computerUse.recordingAction.text', "Text entry");
		case 'key': return localize('computerUse.recordingAction.key', "Key press");
		case 'scroll': return localize('computerUse.recordingAction.scroll', "Scroll");
		case 'drag': return localize('computerUse.recordingAction.drag', "Drag");
		case 'secondary': return localize('computerUse.recordingAction.secondary', "Secondary action");
		case 'application': return localize('computerUse.recordingAction.application', "Application launch");
	}
}

function actionDisplayLabel(action: ICompactRecordingAction): string {
	return action.count > 1
		? localize('computerUse.recordingActionCluster', "{0} and {1} more actions", actionLabel(action.kind), action.count - 1)
		: actionLabel(action.kind);
}

function formatPlaybackTime(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	return localize('computerUse.playbackTime', "{0}:{1}", Math.floor(totalSeconds / 60), String(totalSeconds % 60).padStart(2, '0'));
}

/** Renders recording progress, unchanged-frame ranges, and lazy frame previews. */
export class ComputerUseRecordingTimeline extends Disposable {

	readonly domNode: HTMLElement;

	private readonly input: HTMLInputElement;
	private readonly rail: HTMLElement;
	private readonly inactiveMarkers: HTMLElement;
	private readonly actionMarkers: HTMLElement;
	private readonly previewProgress: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly thumb: HTMLElement;
	private readonly positionLabel: HTMLElement;
	private readonly preview: HTMLElement;
	private readonly previewCanvas: HTMLCanvasElement;
	private readonly previewStatus: HTMLElement;
	private readonly previewTime: HTMLElement;
	private readonly previewInactive: HTMLElement;
	private readonly previewAction: HTMLElement;
	private readonly previewDelay = this._register(new MutableDisposable<IDisposable>());
	private readonly timelineCancellation = new CancellationTokenSource();
	private previewCancellation: CancellationTokenSource | undefined;
	private previewDecoder: IComputerUseVideoDecoder | undefined;
	private actionMarkerElements: HTMLButtonElement[] = [];
	private inactiveRanges: readonly IComputerUseRecordingTimelineRange[] = [];
	private actions: readonly ICompactRecordingAction[] = [];
	private positionMs = 0;
	private previewPositionMs: number | undefined;
	private scrubbing = false;
	private focused = false;
	private pointerInside = false;
	private actionFocused = false;
	private previewGeneration = 0;
	private previewActionEvent: ICompactRecordingAction | undefined;

	constructor(
		container: HTMLElement,
		private readonly source: ISessionComputerUseVideoSource,
		private readonly durationMs: number,
		private readonly decoderFactory: IComputerUseVideoDecoderFactory,
		private readonly scheduler: IComputerUseVideoScheduler,
		private readonly seek: (positionMs: number) => void,
	) {
		super();
		this._register(toDisposable(() => this.timelineCancellation.dispose(true)));
		this.domNode = dom.append(container, dom.$('.computer-use-timeline'));
		this.preview = dom.append(this.domNode, dom.$('.computer-use-timeline-preview', { 'aria-hidden': 'true' }));
		const previewFrame = dom.append(this.preview, dom.$('.computer-use-timeline-preview-frame'));
		this.previewCanvas = dom.append(previewFrame, dom.$('canvas.computer-use-timeline-preview-canvas')) as HTMLCanvasElement;
		this.previewStatus = dom.append(previewFrame, dom.$('span.computer-use-timeline-preview-status'));
		this.previewInactive = dom.append(previewFrame, dom.$('span.computer-use-timeline-preview-inactive', undefined, localize('computerUse.recordingUnchanged', "Unchanged")));
		this.previewTime = dom.append(this.preview, dom.$('span.computer-use-timeline-preview-time'));
		this.previewAction = dom.append(this.preview, dom.$('span.computer-use-timeline-preview-action'));
		this.previewAction.hidden = true;

		const row = dom.append(this.domNode, dom.$('.computer-use-timeline-row'));
		const track = dom.append(row, dom.$('.computer-use-timeline-track'));
		this.input = dom.append(track, dom.$('input.computer-use-timeline-input', {
			type: 'range',
			min: '0',
			max: String(durationMs),
			step: '100',
			'aria-label': localize('computerUse.recordingTimeline', "Recording Timeline"),
		})) as HTMLInputElement;
		this.rail = dom.append(track, dom.$('.computer-use-timeline-rail'));
		this.inactiveMarkers = dom.append(this.rail, dom.$('.computer-use-timeline-inactive-markers'));
		this.previewProgress = dom.append(this.rail, dom.$('.computer-use-timeline-preview-progress', { 'aria-hidden': 'true' }));
		this.progress = dom.append(this.rail, dom.$('.computer-use-timeline-progress'));
		this.thumb = dom.append(this.rail, dom.$('.computer-use-timeline-thumb'));
		this.actionMarkers = dom.append(this.rail, dom.$('.computer-use-timeline-action-markers', { role: 'group', 'aria-label': localize('computerUse.recordingActions', "Recorded Computer Use Actions") }));
		this.positionLabel = dom.append(row, dom.$('span.computer-use-timeline-label', { 'aria-hidden': 'true' }));

		this._register(autorun(reader => {
			const positionMs = source.recordingPositionMs?.read(reader) ?? 0;
			if (!this.scrubbing) {
				this.updatePosition(positionMs);
			}
		}));
		this._register(dom.addDisposableListener(track, dom.EventType.POINTER_MOVE, event => {
			this.pointerInside = true;
			const fraction = this.getPointerFraction(event);
			this.showPreview(fraction * this.durationMs, fraction, false);
		}));
		this._register(dom.addDisposableListener(track, dom.EventType.POINTER_LEAVE, () => {
			this.pointerInside = false;
			if (this.scrubbing) {
				return;
			}
			if (this.focused) {
				const fraction = this.durationMs > 0 ? this.positionMs / this.durationMs : 0;
				this.showPreview(this.positionMs, fraction, true);
			} else if (!this.actionFocused) {
				this.hidePreview();
			}
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.POINTER_DOWN, event => {
			this.scrubbing = true;
			const fraction = this.getPointerFraction(event);
			this.showPreview(fraction * this.durationMs, fraction, true);
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.INPUT, () => {
			this.scrubbing = true;
			const positionMs = Number(this.input.value);
			this.updatePosition(positionMs);
			this.showPreview(positionMs, this.durationMs > 0 ? positionMs / this.durationMs : 0, true);
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.CHANGE, () => {
			this.scrubbing = false;
			this.seek(Number(this.input.value));
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.FOCUS, () => {
			this.focused = true;
			this.showPreview(this.positionMs, this.durationMs > 0 ? this.positionMs / this.durationMs : 0, true);
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.BLUR, () => {
			this.focused = false;
			this.scrubbing = false;
			if (!this.pointerInside) {
				this.hidePreview();
			}
		}));
		this._register(dom.addDisposableListener(this.input, dom.EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				this.hidePreview();
			}
		}));

		this.updatePosition(0);
		void this.loadTimeline();
	}

	getAccessibleContent(): string {
		const position = formatPlaybackTime(this.positionMs);
		const duration = formatPlaybackTime(this.durationMs);
		const summary = this.inactiveRanges.length > 0
			? localize('computerUse.accessibleRecordingTimelineWithInactive', "Recording position: {0} of {1}. Dimmed timeline sections mark periods where the captured image did not change.", position, duration)
			: localize('computerUse.accessibleRecordingTimeline', "Recording position: {0} of {1}.", position, duration);
		if (this.actions.length === 0) {
			return summary;
		}
		const actionCount = this.actions.reduce((total, action) => total + action.count, 0);
		const visible = this.actions.slice(0, MAX_ACCESSIBLE_ACTIONS);
		const visibleActions = visible
			.map(action => localize('computerUse.accessibleRecordingAction', "{0} at {1}", actionDisplayLabel(action), formatPlaybackTime(action.timeMs)));
		const remaining = actionCount - visible.reduce((total, action) => total + action.count, 0);
		return [
			summary,
			localize('computerUse.accessibleRecordingActions', "Recorded actions: {0}.", actionCount),
			...visibleActions,
			remaining > 0 ? localize('computerUse.accessibleRecordingActionsRemaining', "{0} more actions.", remaining) : '',
		].filter(Boolean).join('\n');
	}

	private async loadTimeline(): Promise<void> {
		if (this.source.readRecordingTimeline) {
			try {
				this.inactiveRanges = await this.source.readRecordingTimeline(this.timelineCancellation.token);
				if (!this.timelineCancellation.token.isCancellationRequested) {
					this.renderInactiveRanges();
				}
			} catch (error) {
				if (!isCancellationError(error)) {
					this.input.setAttribute('aria-description', localize('computerUse.recordingTimelineMetadataUnavailable', "Unchanged-frame markers are unavailable for this recording."));
				}
			}
		}
		if (this.source.readRecordingActions) {
			try {
				const actions = await this.source.readRecordingActions(this.timelineCancellation.token);
				if (!this.timelineCancellation.token.isCancellationRequested) {
					this.actions = this.compactActions(actions);
					this.renderActions();
				}
			} catch (error) {
				if (!isCancellationError(error)) {
					this.input.setAttribute('aria-description', localize('computerUse.recordingActionMarkersUnavailable', "Recorded action markers are unavailable for this recording."));
				}
			}
		}
		if (!this.timelineCancellation.token.isCancellationRequested) {
			this.updatePosition(this.positionMs);
			if (this.previewPositionMs !== undefined) {
				this.updatePreviewMetadata(this.previewPositionMs, this.previewActionEvent);
			}
		}
	}

	private renderInactiveRanges(): void {
		dom.clearNode(this.inactiveMarkers);
		for (const range of this.compactRanges(this.inactiveRanges)) {
			const marker = dom.append(this.inactiveMarkers, dom.$('span.computer-use-timeline-inactive'));
			marker.style.left = `${range.startMs / this.durationMs * 100}%`;
			marker.style.width = `${range.durationMs / this.durationMs * 100}%`;
		}
	}

	private compactRanges(ranges: readonly IComputerUseRecordingTimelineRange[]): readonly IComputerUseRecordingTimelineRange[] {
		if (this.durationMs <= 0) {
			return [];
		}
		if (ranges.length <= MAX_TIMELINE_MARKERS) {
			return ranges;
		}
		const binDuration = this.durationMs / MAX_TIMELINE_MARKERS;
		const inactiveByBin = new Array<number>(MAX_TIMELINE_MARKERS).fill(0);
		for (const range of ranges) {
			const firstBin = Math.max(0, Math.floor(range.startMs / binDuration));
			const lastBin = Math.min(MAX_TIMELINE_MARKERS - 1, Math.floor((range.startMs + range.durationMs) / binDuration));
			for (let index = firstBin; index <= lastBin; index++) {
				const binStart = index * binDuration;
				const overlap = Math.max(0, Math.min(range.startMs + range.durationMs, binStart + binDuration) - Math.max(range.startMs, binStart));
				inactiveByBin[index] += overlap;
			}
		}
		const result: IComputerUseRecordingTimelineRange[] = [];
		for (let index = 0; index < inactiveByBin.length; index++) {
			if (inactiveByBin[index] < binDuration / 2) {
				continue;
			}
			const startMs = index * binDuration;
			const previous = result.at(-1);
			if (previous && Math.abs(previous.startMs + previous.durationMs - startMs) < 0.001) {
				result[result.length - 1] = { startMs: previous.startMs, durationMs: previous.durationMs + binDuration };
			} else {
				result.push({ startMs, durationMs: binDuration });
			}
		}
		return result;
	}

	private compactActions(actions: readonly IComputerUseRecordingActionEvent[]): readonly ICompactRecordingAction[] {
		if (this.durationMs <= 0) {
			return [];
		}
		if (actions.length <= MAX_TIMELINE_MARKERS) {
			return actions.map(action => ({ ...action, count: 1 }));
		}
		const bins = new Map<number, ICompactRecordingAction>();
		for (const action of actions) {
			const bin = Math.min(MAX_TIMELINE_MARKERS - 1, Math.floor(action.timeMs / this.durationMs * MAX_TIMELINE_MARKERS));
			const previous = bins.get(bin);
			bins.set(bin, { ...action, count: (previous?.count ?? 0) + 1 });
		}
		return [...bins.values()];
	}

	private renderActions(): void {
		dom.clearNode(this.actionMarkers);
		this.actionMarkerElements = [];
		this.actions.forEach((action, index) => {
			const marker = dom.append(this.actionMarkers, dom.$<HTMLButtonElement>(`button.computer-use-timeline-action.computer-use-timeline-action-${action.kind}`, {
				type: 'button',
				tabindex: index === 0 ? '0' : '-1',
				'aria-label': this.actionAriaLabel(action),
			}));
			this.actionMarkerElements.push(marker);
			marker.style.left = `${this.durationMs > 0 ? action.timeMs / this.durationMs * 100 : 0}%`;
			this._register(dom.addDisposableListener(marker, dom.EventType.POINTER_MOVE, event => {
				event.stopPropagation();
				this.pointerInside = true;
				this.showPreview(action.timeMs, action.timeMs / this.durationMs, false, action);
			}));
			this._register(dom.addDisposableListener(marker, dom.EventType.POINTER_LEAVE, () => {
				this.pointerInside = false;
				if (!this.focused && !this.actionFocused && !this.scrubbing) {
					this.hidePreview();
				}
			}));
			this._register(dom.addDisposableListener(marker, dom.EventType.FOCUS, () => {
				this.actionFocused = true;
				this.showPreview(action.timeMs, action.timeMs / this.durationMs, true, action);
			}));
			this._register(dom.addDisposableListener(marker, dom.EventType.BLUR, event => {
				this.actionFocused = dom.isHTMLElement(event.relatedTarget) && this.actionMarkers.contains(event.relatedTarget);
				if (!this.pointerInside && !this.focused && !this.actionFocused) {
					this.hidePreview();
				}
			}));
			this._register(dom.addDisposableListener(marker, dom.EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this.seekAction(action);
			}));
			this._register(dom.addDisposableListener(marker, dom.EventType.KEY_DOWN, event => this.navigateActions(event, index)));
		});
	}

	private navigateActions(event: KeyboardEvent, index: number): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.hidePreview();
			return;
		}
		let nextIndex: number | undefined;
		if (event.key === 'ArrowLeft') {
			nextIndex = Math.max(0, index - 1);
		} else if (event.key === 'ArrowRight') {
			nextIndex = Math.min(this.actions.length - 1, index + 1);
		} else if (event.key === 'Home') {
			nextIndex = 0;
		} else if (event.key === 'End') {
			nextIndex = this.actions.length - 1;
		}
		if (nextIndex === undefined) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.actionMarkerElements.forEach((marker, markerIndex) => marker.tabIndex = markerIndex === nextIndex ? 0 : -1);
		this.actionMarkerElements[nextIndex]?.focus();
	}

	private seekAction(action: ICompactRecordingAction): void {
		this.updatePosition(action.timeMs);
		this.showPreview(action.timeMs, action.timeMs / this.durationMs, true, action);
		this.seek(action.timeMs);
	}

	private actionAriaLabel(action: ICompactRecordingAction): string {
		return localize('computerUse.recordingActionAtTime', "{0} at {1}. Activate to seek.", actionDisplayLabel(action), formatPlaybackTime(action.timeMs));
	}

	private updatePosition(positionMs: number): void {
		this.positionMs = Math.min(this.durationMs, Math.max(0, Math.round(positionMs)));
		this.input.value = String(this.positionMs);
		const progress = `${this.durationMs > 0 ? this.positionMs / this.durationMs * 100 : 0}%`;
		this.progress.style.width = progress;
		this.thumb.style.left = progress;
		const position = formatPlaybackTime(this.positionMs);
		const duration = formatPlaybackTime(this.durationMs);
		this.input.setAttribute('aria-valuetext', this.isInactive(this.positionMs)
			? localize('computerUse.recordingPositionUnchanged', "{0} of {1}, unchanged footage", position, duration)
			: localize('computerUse.recordingPosition', "{0} of {1}", position, duration));
		this.positionLabel.textContent = localize('computerUse.recordingPositionVisual', "{0} / {1}", position, duration);
	}

	private getPointerFraction(event: PointerEvent): number {
		const bounds = this.rail.getBoundingClientRect();
		if (bounds.width <= 0) {
			return this.durationMs > 0 ? Number(this.input.value) / this.durationMs : 0;
		}
		return Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
	}

	private showPreview(positionMs: number, fraction: number, immediate: boolean, action?: ICompactRecordingAction): void {
		const clampedPositionMs = Math.min(this.durationMs, Math.max(0, Math.round(positionMs)));
		const clampedFraction = Math.min(1, Math.max(0, fraction));
		this.cancelPreview();
		this.previewPositionMs = clampedPositionMs;
		this.previewActionEvent = action;
		this.domNode.classList.add('is-preview-visible');
		this.previewProgress.style.width = `${clampedFraction * 100}%`;
		this.updatePreviewMetadata(clampedPositionMs, action);
		this.positionPreview(clampedFraction);
		if (!this.previewCanvas.classList.contains('is-visible')) {
			this.previewStatus.textContent = localize('computerUse.recordingPreviewLoading', "Loading preview…");
		}
		const generation = this.previewGeneration;
		this.previewDelay.value = this.scheduler.schedule(() => {
			this.previewDelay.clear();
			void this.loadPreview(clampedPositionMs, generation);
		}, immediate ? 0 : PREVIEW_DELAY_MS);
	}

	private updatePreviewMetadata(positionMs: number, action?: ICompactRecordingAction): void {
		this.previewTime.textContent = formatPlaybackTime(positionMs);
		this.previewInactive.hidden = !this.isInactive(positionMs);
		this.previewAction.hidden = !action;
		this.previewAction.textContent = action ? actionDisplayLabel(action) : '';
	}

	private positionPreview(fraction: number): void {
		const railBounds = this.rail.getBoundingClientRect();
		const timelineBounds = this.domNode.getBoundingClientRect();
		const halfWidth = this.preview.offsetWidth / 2;
		const rawLeft = railBounds.left - timelineBounds.left + railBounds.width * Math.min(1, Math.max(0, fraction));
		const left = Math.min(Math.max(rawLeft, halfWidth), Math.max(halfWidth, timelineBounds.width - halfWidth));
		this.preview.style.left = `${left}px`;
	}

	private async loadPreview(positionMs: number, generation: number): Promise<void> {
		if (generation !== this.previewGeneration) {
			return;
		}
		if (!this.source.readRecordingPreview || !this.decoderFactory.available) {
			this.showPreviewUnavailable(generation);
			return;
		}
		const source = new CancellationTokenSource();
		this.previewCancellation = source;
		let decodedFrame: IComputerUseDecodedFrame | undefined;
		let decoder: IComputerUseVideoDecoder | undefined;
		try {
			const preview = await this.source.readRecordingPreview(positionMs, source.token);
			if (!preview || source.token.isCancellationRequested || generation !== this.previewGeneration) {
				if (!source.token.isCancellationRequested && generation === this.previewGeneration) {
					this.showPreviewUnavailable(generation);
				}
				return;
			}
			const supported = await this.decoderFactory.isSupported(preview.config);
			if (!supported || source.token.isCancellationRequested || generation !== this.previewGeneration) {
				if (!source.token.isCancellationRequested && generation === this.previewGeneration) {
					this.showPreviewUnavailable(generation);
				}
				return;
			}
			let decoderError: Error | undefined;
			decoder = this.decoderFactory.create(preview.config, frame => {
				decodedFrame?.close();
				decodedFrame = frame;
			}, error => decoderError = error);
			this.previewDecoder = decoder;
			for (const frame of preview.frames) {
				decoder.decode(frame);
			}
			await decoder.flush();
			if (decoderError) {
				throw decoderError;
			}
			if (!decodedFrame) {
				this.showPreviewUnavailable(generation);
				return;
			}
			if (source.token.isCancellationRequested || generation !== this.previewGeneration) {
				return;
			}
			this.previewCanvas.width = decodedFrame.width;
			this.previewCanvas.height = decodedFrame.height;
			const context = this.previewCanvas.getContext('2d');
			if (!context) {
				throw new Error('Computer Use recording preview canvas is unavailable.');
			}
			decodedFrame.draw(context);
			this.previewCanvas.classList.add('is-visible');
			this.previewStatus.textContent = '';
		} catch (error) {
			if (!isCancellationError(error) && !source.token.isCancellationRequested && generation === this.previewGeneration) {
				this.showPreviewUnavailable(generation);
			}
		} finally {
			decodedFrame?.close();
			if (decoder && this.previewDecoder === decoder) {
				decoder.dispose();
				this.previewDecoder = undefined;
			}
			if (this.previewCancellation === source) {
				this.previewCancellation = undefined;
				source.dispose();
			}
		}
	}

	private showPreviewUnavailable(generation: number): void {
		if (generation !== this.previewGeneration) {
			return;
		}
		this.previewCanvas.classList.remove('is-visible');
		this.previewStatus.textContent = localize('computerUse.recordingPreviewUnavailable', "Preview unavailable");
	}

	private hidePreview(): void {
		this.previewPositionMs = undefined;
		this.previewActionEvent = undefined;
		this.previewProgress.style.width = '0%';
		this.previewDelay.clear();
		this.cancelPreview();
		this.domNode.classList.remove('is-preview-visible');
	}

	private cancelPreview(): void {
		this.previewGeneration++;
		this.previewCancellation?.dispose(true);
		this.previewCancellation = undefined;
		this.previewDecoder?.dispose();
		this.previewDecoder = undefined;
	}

	private isInactive(positionMs: number): boolean {
		return this.inactiveRanges.some(range => positionMs >= range.startMs && positionMs < range.startMs + range.durationMs);
	}

	override dispose(): void {
		this.cancelPreview();
		super.dispose();
	}
}
