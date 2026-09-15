/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { clamp } from '../../../../base/common/numbers.js';
import { observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IComputerUseVideoFocus } from '../../../services/sessions/common/computerUse.js';
import { IComputerUseDecodedFrame, IComputerUseVideoRenderer, IComputerUseVideoScheduler } from './computerUseVideo.js';

interface IViewport {
	readonly x: number;
	readonly y: number;
	readonly size: number;
}

const FULL_WINDOW: IViewport = { x: 0, y: 0, size: 1 };
const PAN_DURATION_MS = 200;

/** Retains one full-window bitmap so local zoom never needs another host frame. */
export class ComputerUseVideoCanvas extends Disposable implements IComputerUseVideoRenderer {
	readonly followAction = observableValue(this, false);
	readonly tracking = observableValue(this, false);

	private readonly source = $<HTMLCanvasElement>('canvas');
	private readonly animation = this._register(new MutableDisposable<IDisposable>());
	private readonly context: CanvasRenderingContext2D;
	private readonly sourceContext: CanvasRenderingContext2D;
	private focus: IComputerUseVideoFocus | undefined;
	private viewport = FULL_WINDOW;
	private target = FULL_WINDOW;
	private from = FULL_WINDOW;
	private started = 0;
	private moving = false;
	private paused = true;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly scheduler: IComputerUseVideoScheduler,
		private reducedMotion: boolean,
	) {
		super();
		const context = canvas.getContext('2d', { alpha: false });
		const sourceContext = this.source.getContext('2d', { alpha: false });
		if (!context || !sourceContext) {
			throw new Error(localize('computerUse.canvasUnavailable', "A video rendering surface is unavailable."));
		}
		this.context = context;
		this.sourceContext = sourceContext;
	}

	render(frame: IComputerUseDecodedFrame, focus?: IComputerUseVideoFocus): void {
		if (this.source.width !== frame.width || this.source.height !== frame.height) {
			this.clear();
			this.source.width = this.canvas.width = frame.width;
			this.source.height = this.canvas.height = frame.height;
		}
		frame.draw(this.sourceContext);
		this.focus = focus;
		this.updateTarget();
	}

	setFollowAction(enabled: boolean): void {
		transaction(tx => {
			this.followAction.set(enabled, tx);
			this.updateTarget();
		});
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
		if (paused) {
			this.sample(this.scheduler.now());
			this.animation.clear();
		} else {
			this.scheduleAnimation();
		}
	}

	setReducedMotion(reducedMotion: boolean): void {
		this.reducedMotion = reducedMotion;
		if (reducedMotion) {
			this.finishTransition();
			this.paint();
		}
	}

	private updateTarget(): void {
		const focus = this.followAction.get() ? this.focus : undefined;
		this.tracking.set(focus !== undefined, undefined);
		const target: IViewport = focus
			? { x: clamp(focus.x - 0.25, 0, 0.5), y: clamp(focus.y - 0.25, 0, 0.5), size: 0.5 }
			: FULL_WINDOW;
		this.sample(this.scheduler.now());
		if (target.x !== this.target.x || target.y !== this.target.y || target.size !== this.target.size) {
			this.from = this.viewport;
			this.target = target;
			this.started = this.scheduler.now();
			this.moving = true;
		}
		if (!focus || this.reducedMotion || this.paused) {
			this.finishTransition();
		}
		this.paint();
		this.scheduleAnimation();
	}

	private sample(now: number): void {
		if (!this.moving) {
			return;
		}
		const progress = clamp((now - this.started) / PAN_DURATION_MS, 0, 1);
		const eased = 1 - (1 - progress) ** 3;
		this.viewport = {
			x: this.from.x + (this.target.x - this.from.x) * eased,
			y: this.from.y + (this.target.y - this.from.y) * eased,
			size: this.from.size + (this.target.size - this.from.size) * eased,
		};
		if (progress === 1) {
			this.finishTransition();
		}
	}

	private finishTransition(): void {
		this.animation.clear();
		this.viewport = this.target;
		this.moving = false;
	}

	private scheduleAnimation(): void {
		if (!this.moving || this.paused || this.animation.value) {
			return;
		}
		this.animation.value = this.scheduler.animationFrame(now => {
			this.animation.clear();
			this.sample(now);
			this.paint();
			this.scheduleAnimation();
		});
	}

	private paint(): void {
		if (this.source.width && this.source.height) {
			const { x, y, size } = this.viewport;
			this.context.drawImage(
				this.source, x * this.source.width, y * this.source.height, size * this.source.width, size * this.source.height,
				0, 0, this.canvas.width, this.canvas.height,
			);
		}
	}

	clear(): void {
		this.animation.clear();
		this.focus = undefined;
		this.moving = false;
		this.viewport = this.target = this.from = FULL_WINDOW;
		this.source.width = this.source.height = this.canvas.width = this.canvas.height = 0;
		this.tracking.set(false, undefined);
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
