/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrowserWindow } from 'electron';
import { Event } from '../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

/**
 * Keeps macOS content fullscreen in the current Space, with `disableHtmlFullscreenWindowResize` enabled.
 */
export function registerInPlaceHtmlFullScreen(window: BrowserWindow): IDisposable {
	const store = new DisposableStore();
	let enteredSimpleFullScreen = false;
	const exit = () => {
		if (!enteredSimpleFullScreen) {
			return;
		}
		enteredSimpleFullScreen = false;
		if (!window.isDestroyed() && !window.isFullScreen()) {
			window.setSimpleFullScreen(false);
			window.webContents.focus();
		}
	};
	store.add(Event.fromNodeEventEmitter(window.webContents, 'enter-html-full-screen')(() => {
		if (!window.isDestroyed() && !window.isFullScreen() && !window.isSimpleFullScreen()) {
			window.setSimpleFullScreen(true);
			enteredSimpleFullScreen = true;
			window.webContents.focus();
		}
	}));
	store.add(Event.fromNodeEventEmitter(window.webContents, 'leave-html-full-screen')(exit));
	store.add(Event.fromNodeEventEmitter(window.webContents, 'render-process-gone')(exit));
	store.add(toDisposable(exit));
	return store;
}
