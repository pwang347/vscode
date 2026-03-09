/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capacitor plugin type definitions and accessors, plus the MobileNative
 * bridge interface and accessor.
 *
 * These use `globalThis` (not `mainWindow`) so they can live in `common/`
 * and be imported by `vs/mobile/services/` without layering violations.
 */

//#region --- MobileNative Bridge ---

/**
 * Unified native JS bridge interface injected by the Android app via
 * `WebView.addJavascriptInterface("MobileNative", ...)`.
 *
 * Unlike Capacitor plugins, this bridge persists across WebView navigations
 * because `addJavascriptInterface` objects survive page loads.
 */
export interface IMobileNativeBridge {
	// Secure storage
	secureStorageGet(key: string): string | null;
	secureStorageSet(key: string, value: string): void;
	secureStorageRemove(key: string): void;
	secureStorageKeys(): string; // JSON-encoded string[]

	// Navigation
	navigateToShell(): void;
	minimizeApp(): void;

	// External opener
	openExternal(url: string): void;

	// Haptics
	hapticImpact(style: string): void;
	hapticNotification(type: string): void;
	hapticSelectionChanged(): void;

	// Background service
	startBackgroundService(): void;
	stopBackgroundService(): void;
}

/**
 * Cached bridge reference. `undefined` means not yet checked,
 * `null` means checked and not available.
 */
let cachedBridge: IMobileNativeBridge | null | undefined;

/**
 * Get the MobileNative JS bridge injected by the native mobile app.
 *
 * Uses `globalThis` so this function can be used from both `common/`
 * and `browser/` layers. In a browser context `globalThis === window`.
 */
export function getMobileNativeBridge(): IMobileNativeBridge | undefined {
	if (cachedBridge !== undefined) {
		return cachedBridge ?? undefined;
	}
	try {
		const bridge = (globalThis as Record<string, unknown>).MobileNative as
			IMobileNativeBridge | undefined;
		if (bridge && typeof bridge.navigateToShell === 'function') {
			cachedBridge = bridge;
			return bridge;
		}
		cachedBridge = null;
		return undefined;
	} catch {
		cachedBridge = null;
		return undefined;
	}
}

/**
 * Check whether a specific method exists on the native bridge.
 */
export function hasBridgeMethod(method: keyof IMobileNativeBridge): boolean {
	const bridge = getMobileNativeBridge();
	return bridge !== undefined && typeof bridge[method] === 'function';
}

//#endregion

/**
 * Capacitor Haptics plugin.
 */
export interface ICapacitorHaptics {
	impact(options: { style: string }): Promise<void>;
	notification(options: { type: string }): Promise<void>;
	selectionChanged(): Promise<void>;
}

/**
 * Capacitor App plugin for deep-link URL listening.
 */
export interface ICapacitorAppPlugin {
	addListener(event: 'appUrlOpen', callback: (data: { url: string }) => void): Promise<{ remove: () => void }>;
}

/**
 * Capacitor Browser plugin for opening URLs in an in-app browser.
 */
export interface ICapacitorBrowserPlugin {
	open(options: { url: string }): Promise<void>;
	close(): Promise<void>;
}

/**
 * Get Capacitor plugins from the global Capacitor bridge.
 * Only available when the page is served from the local Capacitor web dir.
 */
function getCapacitorPlugins(): { Haptics?: ICapacitorHaptics; App?: ICapacitorAppPlugin; Browser?: ICapacitorBrowserPlugin } | undefined {
	try {
		const capacitor = (globalThis as Record<string, unknown>).Capacitor as
			{ Plugins?: { Haptics?: ICapacitorHaptics; App?: ICapacitorAppPlugin; Browser?: ICapacitorBrowserPlugin } } | undefined;
		return capacitor?.Plugins;
	} catch {
		return undefined;
	}
}

/**
 * Get the Capacitor Haptics plugin.
 */
export function getCapacitorHapticsPlugin(): ICapacitorHaptics | undefined {
	return getCapacitorPlugins()?.Haptics;
}

/**
 * Get the Capacitor App plugin (for deep-link URL listening).
 */
export function getCapacitorAppPlugin(): ICapacitorAppPlugin | undefined {
	return getCapacitorPlugins()?.App;
}

/**
 * Get the Capacitor Browser plugin (for in-app browser).
 */
export function getCapacitorBrowserPlugin(): ICapacitorBrowserPlugin | undefined {
	return getCapacitorPlugins()?.Browser;
}
