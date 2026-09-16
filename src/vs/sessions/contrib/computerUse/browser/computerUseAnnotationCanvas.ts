/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { clamp } from '../../../../base/common/numbers.js';
import { observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ColorIdentifier, getColorRegistry } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { computerUseAnnotationBlue, computerUseAnnotationPink, computerUseAnnotationYellow } from '../common/computerUseColors.js';

export type ComputerUseAnnotationStyle = 'yellow' | 'pink' | 'blue';
export type ComputerUseAnnotationWidth = 'thin' | 'medium' | 'thick';

interface IAnnotationPoint {
	readonly x: number;
	readonly y: number;
}

interface IAnnotationStyle {
	readonly color: ColorIdentifier;
	readonly opacity: number;
}

interface IAnnotationWidth {
	readonly minimum: number;
	readonly ratio: number;
}

const ANNOTATION_STYLES: Record<ComputerUseAnnotationStyle, IAnnotationStyle> = {
	yellow: { color: computerUseAnnotationYellow, opacity: 0.5 },
	pink: { color: computerUseAnnotationPink, opacity: 0.45 },
	blue: { color: computerUseAnnotationBlue, opacity: 0.45 },
};

const ANNOTATION_WIDTHS: Record<ComputerUseAnnotationWidth, IAnnotationWidth> = {
	thin: { minimum: 4, ratio: 0.02 },
	medium: { minimum: 6, ratio: 0.03 },
	thick: { minimum: 8, ratio: 0.04 },
};

/** Draws highlighter marks over a frozen copy of the visible Computer Use frame. */
export class ComputerUseAnnotationCanvas extends Disposable {

	readonly canvas: HTMLCanvasElement;
	readonly style = observableValue<ComputerUseAnnotationStyle>(this, 'yellow');
	readonly width = observableValue<ComputerUseAnnotationWidth>(this, 'thin');
	readonly annotationCount = observableValue(this, 0);
	private readonly cursor: HTMLElement;
	private readonly snapshot = dom.$<HTMLCanvasElement>('canvas');
	private readonly strokeBase = dom.$<HTMLCanvasElement>('canvas');
	private readonly context: CanvasRenderingContext2D;
	private readonly snapshotContext: CanvasRenderingContext2D;
	private readonly strokeBaseContext: CanvasRenderingContext2D;
	private readonly _onDidRequestExit = this._register(new Emitter<void>());
	readonly onDidRequestExit: Event<void> = this._onDidRequestExit.event;
	private drawing = false;
	private moved = false;
	private keyboardDrawing = false;
	private lastPoint: IAnnotationPoint | undefined;
	private strokePoints: IAnnotationPoint[] = [];
	private keyboardPoint: IAnnotationPoint | undefined;
	private active = false;

	constructor(
		container: HTMLElement,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this.canvas = dom.append(container, dom.$('canvas.computer-use-annotation-canvas', {
			tabindex: '0',
			role: 'application',
			'aria-label': localize('computerUse.annotationCanvas', "Frame annotation canvas. Use the pointer to highlight. For keyboard drawing, use arrow keys to move the marker and Space to start or stop a stroke. Press Escape to return to video."),
			'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight Space Escape',
			'aria-hidden': 'true',
		})) as HTMLCanvasElement;
		this.cursor = dom.append(container, dom.$('.computer-use-annotation-cursor', { 'aria-hidden': 'true' }));
		const context = this.canvas.getContext('2d', { alpha: false });
		const snapshotContext = this.snapshot.getContext('2d', { alpha: false });
		const strokeBaseContext = this.strokeBase.getContext('2d', { alpha: false });
		if (!context || !snapshotContext || !strokeBaseContext) {
			throw new Error(localize('computerUse.annotationCanvasUnavailable', "A frame annotation surface is unavailable."));
		}
		this.context = context;
		this.snapshotContext = snapshotContext;
		this.strokeBaseContext = strokeBaseContext;
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_DOWN, event => this.onPointerDown(event)));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_MOVE, event => this.onPointerMove(event)));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_UP, () => this.finishStroke()));
		this._register(dom.addDisposableListener(this.canvas, 'pointercancel', () => this.finishStroke()));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.FOCUS, () => this.updateCursor()));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.BLUR, () => {
			this.finishKeyboardStroke();
			this.cursor.classList.remove('is-visible');
		}));
	}

	get isActive(): boolean {
		return this.active;
	}

	start(source: HTMLCanvasElement): boolean {
		if (source.width < 1 || source.height < 1) {
			return false;
		}
		this.canvas.width = this.snapshot.width = this.strokeBase.width = source.width;
		this.canvas.height = this.snapshot.height = this.strokeBase.height = source.height;
		this.snapshotContext.drawImage(source, 0, 0);
		this.strokeBaseContext.drawImage(source, 0, 0);
		this.context.drawImage(this.snapshot, 0, 0);
		this.annotationCount.set(0, undefined);
		this.keyboardPoint = { x: source.width / 2, y: source.height / 2 };
		this.active = true;
		this.canvas.classList.add('is-visible');
		this.canvas.setAttribute('aria-hidden', 'false');
		this.canvas.focus();
		this.updateCursor();
		return true;
	}

	stop(): void {
		this.finishStroke();
		this.finishKeyboardStroke();
		this.active = false;
		this.canvas.classList.remove('is-visible');
		this.canvas.setAttribute('aria-hidden', 'true');
		this.cursor.classList.remove('is-visible', 'is-drawing');
		this.canvas.width = this.canvas.height = this.snapshot.width = this.snapshot.height = this.strokeBase.width = this.strokeBase.height = 0;
		this.strokePoints = [];
		this.annotationCount.set(0, undefined);
	}

	setStyle(style: ComputerUseAnnotationStyle): void {
		this.finishStroke();
		this.finishKeyboardStroke();
		this.style.set(style, undefined);
	}

	setWidth(width: ComputerUseAnnotationWidth): void {
		this.finishStroke();
		this.finishKeyboardStroke();
		this.width.set(width, undefined);
		this.updateCursor();
	}

	reset(): void {
		if (!this.active) {
			return;
		}
		this.finishStroke();
		this.finishKeyboardStroke();
		this.context.drawImage(this.snapshot, 0, 0);
		this.strokePoints = [];
		this.annotationCount.set(0, undefined);
	}

	async toPng(): Promise<Uint8Array> {
		if (!this.active || this.canvas.width < 1 || this.canvas.height < 1) {
			throw new Error(localize('computerUse.annotationFrameUnavailable', "The frozen frame is no longer available."));
		}
		const blob = await new Promise<Blob | null>(resolve => this.canvas.toBlob(resolve, 'image/png'));
		if (!blob) {
			throw new Error(localize('computerUse.annotationEncodeFailed', "The annotated frame could not be encoded."));
		}
		return new Uint8Array(await blob.arrayBuffer());
	}

	private onPointerDown(event: PointerEvent): void {
		if (!this.active || event.button !== 0) {
			return;
		}
		const point = this.toCanvasPoint(event.clientX, event.clientY, false);
		if (!point) {
			return;
		}
		event.preventDefault();
		this.canvas.focus();
		this.canvas.setPointerCapture(event.pointerId);
		this.keyboardPoint = point;
		this.beginStroke(point);
		this.updateCursor();
	}

	private onPointerMove(event: PointerEvent): void {
		if (!this.drawing || !this.lastPoint) {
			return;
		}
		const point = this.toCanvasPoint(event.clientX, event.clientY, true);
		if (!point) {
			return;
		}
		event.preventDefault();
		this.drawLine(this.lastPoint, point);
		this.lastPoint = point;
		this.keyboardPoint = point;
		this.moved = true;
		this.updateCursor();
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (!this.active) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this._onDidRequestExit.fire();
			return;
		}
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			if (this.keyboardDrawing) {
				this.finishKeyboardStroke();
			} else {
				this.keyboardDrawing = true;
				this.beginStroke(this.keyboardPoint ?? { x: this.canvas.width / 2, y: this.canvas.height / 2 });
				this.cursor.classList.add('is-drawing');
			}
			return;
		}
		const direction = {
			ArrowUp: { x: 0, y: -1 },
			ArrowDown: { x: 0, y: 1 },
			ArrowLeft: { x: -1, y: 0 },
			ArrowRight: { x: 1, y: 0 },
		}[event.key];
		if (!direction) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const current = this.keyboardPoint ?? { x: this.canvas.width / 2, y: this.canvas.height / 2 };
		const distance = event.shiftKey ? 20 : 5;
		const next = {
			x: clamp(current.x + direction.x * distance, 0, this.canvas.width),
			y: clamp(current.y + direction.y * distance, 0, this.canvas.height),
		};
		if (this.keyboardDrawing) {
			this.drawLine(current, next);
			this.lastPoint = next;
			this.moved = true;
		}
		this.keyboardPoint = next;
		this.updateCursor();
	}

	private beginStroke(point: IAnnotationPoint): void {
		this.drawing = true;
		this.moved = false;
		this.lastPoint = point;
		this.strokePoints = [point];
		this.strokeBaseContext.drawImage(this.canvas, 0, 0);
	}

	private finishStroke(): void {
		if (!this.drawing || !this.lastPoint) {
			return;
		}
		if (!this.moved) {
			this.drawDot(this.lastPoint);
		}
		this.drawing = false;
		this.lastPoint = undefined;
		this.strokePoints = [];
		this.moved = false;
		this.annotationCount.set(this.annotationCount.get() + 1, undefined);
	}

	private finishKeyboardStroke(): void {
		if (!this.keyboardDrawing) {
			return;
		}
		this.keyboardDrawing = false;
		this.cursor.classList.remove('is-drawing');
		this.finishStroke();
	}

	private drawLine(from: IAnnotationPoint, to: IAnnotationPoint): void {
		if (this.strokePoints.length === 0) {
			this.strokePoints.push(from);
		}
		const last = this.strokePoints.at(-1);
		if (!last || last.x !== to.x || last.y !== to.y) {
			this.strokePoints.push(to);
		}
		this.context.drawImage(this.strokeBase, 0, 0);
		this.configureContext();
		this.context.beginPath();
		this.context.moveTo(this.strokePoints[0].x, this.strokePoints[0].y);
		if (this.strokePoints.length === 2) {
			this.context.lineTo(to.x, to.y);
		} else {
			for (let index = 1; index < this.strokePoints.length - 1; index++) {
				const point = this.strokePoints[index];
				const next = this.strokePoints[index + 1];
				this.context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
			}
			this.context.lineTo(to.x, to.y);
		}
		this.context.stroke();
		this.context.restore();
	}

	private drawDot(point: IAnnotationPoint): void {
		const definition = this.configureContext();
		this.context.beginPath();
		this.context.arc(point.x, point.y, this.lineWidth() / 2, 0, Math.PI * 2);
		this.context.fillStyle = this.resolveColor(definition);
		this.context.fill();
		this.context.restore();
	}

	private configureContext(): IAnnotationStyle {
		const definition = ANNOTATION_STYLES[this.style.get()];
		this.context.save();
		this.context.globalAlpha = definition.opacity;
		this.context.strokeStyle = this.resolveColor(definition);
		this.context.lineWidth = this.lineWidth();
		this.context.lineCap = 'round';
		this.context.lineJoin = 'round';
		return definition;
	}

	private resolveColor(style: IAnnotationStyle): string {
		const theme = this.themeService.getColorTheme();
		const color = (theme.getColor(style.color) ?? getColorRegistry().resolveDefaultColor(style.color, theme))?.toString();
		if (!color) {
			throw new Error(localize('computerUse.annotationColorUnavailable', "The selected annotation color is unavailable in this theme."));
		}
		return color;
	}

	private lineWidth(): number {
		const width = ANNOTATION_WIDTHS[this.width.get()];
		return Math.max(width.minimum, Math.round(Math.min(this.canvas.width, this.canvas.height) * width.ratio));
	}

	private toCanvasPoint(clientX: number, clientY: number, clampToFrame: boolean): IAnnotationPoint | undefined {
		const bounds = this.canvas.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0 || this.canvas.width <= 0 || this.canvas.height <= 0) {
			return undefined;
		}
		const scale = Math.min(bounds.width / this.canvas.width, bounds.height / this.canvas.height);
		const width = this.canvas.width * scale;
		const height = this.canvas.height * scale;
		const left = bounds.left + (bounds.width - width) / 2;
		const top = bounds.top + (bounds.height - height) / 2;
		if (!clampToFrame && (clientX < left || clientX > left + width || clientY < top || clientY > top + height)) {
			return undefined;
		}
		return {
			x: clamp((clientX - left) / scale, 0, this.canvas.width),
			y: clamp((clientY - top) / scale, 0, this.canvas.height),
		};
	}

	private updateCursor(): void {
		if (!this.active || !this.keyboardPoint) {
			this.cursor.classList.remove('is-visible');
			return;
		}
		const bounds = this.canvas.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) {
			return;
		}
		const scale = Math.min(bounds.width / this.canvas.width, bounds.height / this.canvas.height);
		const width = this.canvas.width * scale;
		const height = this.canvas.height * scale;
		const left = (bounds.width - width) / 2 + this.keyboardPoint.x * scale;
		const top = (bounds.height - height) / 2 + this.keyboardPoint.y * scale;
		const cursorSize = Math.max(4, Math.round(this.lineWidth() * scale));
		this.cursor.style.left = `${left}px`;
		this.cursor.style.top = `${top}px`;
		this.cursor.style.width = `${cursorSize}px`;
		this.cursor.style.height = `${cursorSize}px`;
		this.cursor.classList.toggle('is-visible', this.canvas.matches(':focus-visible'));
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
