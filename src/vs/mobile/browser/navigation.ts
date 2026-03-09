/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { IDisposable } from '../../base/common/lifecycle.js';
import { getMobileNativeBridge } from './nativeBridge.js';

/**
 * Listen for the Android hardware back button.
 *
 * The native Android `MainActivity` dispatches a cancelable `mobilebackbutton`
 * DOM event to the WebView on every back press. If the callback calls
 * `preventDefault()` on the event, the native side treats the press as
 * consumed. Otherwise it falls through to default behavior.
 *
 * This works on both the local Capacitor shell page AND remote server pages
 * because the event is dispatched via `evaluateJavascript`, not through
 * Capacitor plugins (which are not injected on remote pages).
 */
export function listenMobileBackButton(callback: () => void): IDisposable {
	return addDisposableListener(mainWindow, 'mobilebackbutton', (e: Event) => {
		e.preventDefault();
		callback();
	});
}

/**
 * Minimize the mobile app (move to background).
 * Uses the MobileNative JS bridge injected by the Android WebView.
 */
export function minimizeApp(): void {
	getMobileNativeBridge()?.minimizeApp();
}

/**
 * Whether the app is running inside the native mobile shell (Capacitor).
 * Detected by the presence of the `MobileNative` JS bridge injected by
 * the native WebView, or by being served from a Capacitor local origin.
 */
export function isNativeMobileApp(): boolean {
	const origin = mainWindow.location.origin;
	if (origin === 'capacitor://localhost' || origin === 'https://localhost') {
		return true;
	}
	if (mainWindow.location.protocol === 'file:') {
		return true;
	}
	return getMobileNativeBridge() !== undefined;
}

/**
 * Navigate back to the mobile app shell (server selection page).
 *
 * When the workbench is served from a remote VS Code server (e.g.
 * `http://server:9888/chat`), simply clearing `location.search` would
 * reload the same remote page without connection params, causing errors.
 * Instead, we detect that we're on a remote origin and navigate to the
 * Capacitor app's local shell URL.
 *
 * On iOS Capacitor uses `capacitor://localhost`, on Android it uses
 * `https://localhost`. When running in a plain browser (no Capacitor),
 * we fall back to clearing the search params.
 */
export function navigateToShell(): void {
	const origin = mainWindow.location.origin;

	// Capacitor local origins -- the shell is always at the root
	if (origin === 'capacitor://localhost' || origin === 'https://localhost') {
		mainWindow.location.href = origin + '/';
		return;
	}

	// Android file:// -- shell is at the asset root
	if (mainWindow.location.protocol === 'file:') {
		mainWindow.location.href = 'file:///android_asset/public/index.html';
		return;
	}

	// Native bridge -- available when running inside the mobile app
	// on a remote server page where the Capacitor origin isn't active.
	const nativeBridge = getMobileNativeBridge();
	if (nativeBridge?.navigateToShell) {
		nativeBridge.navigateToShell();
		return;
	}

	// Fallback for browser-based usage: clear query params to reset.
	// This works when the page origin IS the VS Code server (no separate shell).
	mainWindow.location.search = '';
}
