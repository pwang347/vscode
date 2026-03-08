/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { IHapticFeedbackService, HapticImpactStyle } from '../../services/haptics/browser/hapticFeedbackService.js';

export const enum SwipeDirection {
	Left = 'left',
	Right = 'right',
	Up = 'up',
	Down = 'down',
}

export interface ISwipeEvent {
	readonly direction: SwipeDirection;
	readonly velocity: number;
	readonly isEdgeSwipe: boolean;
}

const SWIPE_THRESHOLD = 50;     // Minimum distance in px
const VELOCITY_THRESHOLD = 0.3; // Minimum velocity in px/ms
const EDGE_THRESHOLD = 30;      // Edge swipe detection zone in px

/**
 * Touch-based swipe navigation for mobile.
 *
 * Detects swipe gestures (left, right, up, down) with velocity thresholds
 * and edge detection. Integrates with haptic feedback for tactile confirmation.
 *
 * Usage:
 * - Swipe from left edge: back navigation
 * - Swipe left/right on change cards: approve/reject
 * - Swipe up on change cards: skip to next
 *
 * Builds on the existing `vs/base/browser/touch.ts` Gesture class concepts
 * but implements mobile-specific gesture recognition with velocity and
 * edge-swipe detection.
 */
export class SwipeNavigation extends Disposable {

	private readonly _onDidSwipe = this._register(new Emitter<ISwipeEvent>());
	readonly onDidSwipe = this._onDidSwipe.event;

	private startX = 0;
	private startY = 0;
	private startTime = 0;
	private tracking = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly hapticService: IHapticFeedbackService | undefined,
	) {
		super();

		this.registerTouchListeners();
	}

	private registerTouchListeners(): void {
		this._register(addDisposableListener(this.container, 'touchstart', (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				this.tracking = false;
				return;
			}

			const touch = e.touches[0];
			this.startX = touch.clientX;
			this.startY = touch.clientY;
			this.startTime = Date.now();
			this.tracking = true;
		}, { passive: true }));

		this._register(addDisposableListener(this.container, 'touchend', (e: TouchEvent) => {
			if (!this.tracking || e.changedTouches.length !== 1) {
				this.tracking = false;
				return;
			}

			const touch = e.changedTouches[0];
			const deltaX = touch.clientX - this.startX;
			const deltaY = touch.clientY - this.startY;
			const elapsed = Date.now() - this.startTime;

			if (elapsed === 0) {
				this.tracking = false;
				return;
			}

			const absX = Math.abs(deltaX);
			const absY = Math.abs(deltaY);

			// Must exceed threshold
			if (absX < SWIPE_THRESHOLD && absY < SWIPE_THRESHOLD) {
				this.tracking = false;
				return;
			}

			// Determine primary direction
			const isHorizontal = absX > absY;
			const distance = isHorizontal ? absX : absY;
			const velocity = distance / elapsed;

			// Must exceed velocity threshold
			if (velocity < VELOCITY_THRESHOLD) {
				this.tracking = false;
				return;
			}

			const isEdgeSwipe = this.startX < EDGE_THRESHOLD || this.startX > (this.container.clientWidth - EDGE_THRESHOLD);

			let direction: SwipeDirection;
			if (isHorizontal) {
				direction = deltaX > 0 ? SwipeDirection.Right : SwipeDirection.Left;
			} else {
				direction = deltaY > 0 ? SwipeDirection.Down : SwipeDirection.Up;
			}

			// Haptic feedback on swipe completion
			this.hapticService?.impact(HapticImpactStyle.Light);

			this._onDidSwipe.fire({ direction, velocity, isEdgeSwipe });
			this.tracking = false;
		}, { passive: true }));

		this._register(addDisposableListener(this.container, 'touchcancel', () => {
			this.tracking = false;
		}, { passive: true }));
	}
}
