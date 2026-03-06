/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { addDisposableListener } from '../../../base/browser/dom.js';

const PULL_THRESHOLD = 80;   // Distance in px to trigger refresh
const RESISTANCE = 2.5;      // Resistance factor for overscroll

/**
 * Pull-to-refresh gesture for mobile views.
 *
 * Pull down on a scrollable view to trigger a refresh action.
 * Provides a spring-like resistance and visual indicator.
 *
 * Usage:
 * - Pull down on chat view: refresh session state
 * - Pull down on file tree: re-fetch remote file listing
 */
export class PullToRefresh extends Disposable {

	private readonly _onDidRefresh = this._register(new Emitter<void>());
	readonly onDidRefresh = this._onDidRefresh.event;

	private startY = 0;
	private pulling = false;
	private triggered = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly isAtTop: () => boolean,
	) {
		super();

		this.registerTouchListeners();
	}

	private registerTouchListeners(): void {
		this._register(addDisposableListener(this.container, 'touchstart', (e: TouchEvent) => {
			if (e.touches.length !== 1 || !this.isAtTop()) {
				return;
			}

			this.startY = e.touches[0].clientY;
			this.pulling = true;
			this.triggered = false;
		}, { passive: true }));

		this._register(addDisposableListener(this.container, 'touchmove', (e: TouchEvent) => {
			if (!this.pulling || e.touches.length !== 1) {
				return;
			}

			const deltaY = (e.touches[0].clientY - this.startY) / RESISTANCE;

			if (deltaY > 0 && this.isAtTop()) {
				// Apply visual feedback (e.g., pull indicator)
				if (deltaY >= PULL_THRESHOLD && !this.triggered) {
					this.triggered = true;
					// Could add visual cue here (spinner, etc.)
				}
			}
		}, { passive: true }));

		this._register(addDisposableListener(this.container, 'touchend', () => {
			if (this.pulling && this.triggered) {
				this._onDidRefresh.fire();
			}

			this.pulling = false;
			this.triggered = false;
		}, { passive: true }));

		this._register(addDisposableListener(this.container, 'touchcancel', () => {
			this.pulling = false;
			this.triggered = false;
		}, { passive: true }));
	}
}
