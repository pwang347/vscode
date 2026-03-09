/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export const IHapticFeedbackService = createDecorator<IHapticFeedbackService>('mobileHapticFeedbackService');

export const enum HapticImpactStyle {
	Light = 'LIGHT',
	Medium = 'MEDIUM',
	Heavy = 'HEAVY',
}

export const enum HapticNotificationType {
	Success = 'SUCCESS',
	Warning = 'WARNING',
	Error = 'ERROR',
}

export interface IHapticFeedbackService {
	readonly _serviceBrand: undefined;

	/**
	 * Trigger an impact haptic feedback.
	 * Used for UI interactions like button presses and tab switches.
	 */
	impact(style: HapticImpactStyle): Promise<void>;

	/**
	 * Trigger a notification haptic feedback.
	 * Used for system events like success/error.
	 */
	notification(type: HapticNotificationType): Promise<void>;

	/**
	 * Trigger a selection change haptic.
	 * Used for scrolling through items, picker changes.
	 */
	selectionChanged(): Promise<void>;
}

/**
 * Interface for the Capacitor Haptics plugin, available at runtime in the app.
 */
interface ICapacitorHaptics {
	impact(options: { style: string }): Promise<void>;
	notification(options: { type: string }): Promise<void>;
	selectionChanged(): Promise<void>;
}

/**
 * Native JS bridge injected by the mobile app's WebView via
 * addJavascriptInterface. Persists across navigations, so it
 * remains available even on remote code-server pages where
 * Capacitor plugins are not injected.
 */
interface IMobileNativeHapticsBridge {
	hapticImpact(style: string): void;
}

/**
 * Haptic feedback service for mobile.
 *
 * In the Capacitor app, this bridges to the @capacitor/haptics native plugin
 * via the Capacitor plugin registry on globalThis.
 * In a web context (browser testing), haptics are no-ops.
 *
 * The service respects the system "reduce motion" accessibility setting --
 * when enabled, all haptic methods become no-ops.
 */
export class HapticFeedbackService extends Disposable implements IHapticFeedbackService {

	declare readonly _serviceBrand: undefined;

	private _prefersReducedMotion: boolean;

	constructor() {
		super();

		// Respect system accessibility setting and react to changes
		const mql = typeof mainWindow.matchMedia !== 'undefined'
			? mainWindow.matchMedia('(prefers-reduced-motion: reduce)')
			: undefined;
		this._prefersReducedMotion = mql?.matches ?? false;
		if (mql) {
			this._register(addDisposableListener(mql, 'change', () => {
				this._prefersReducedMotion = mql.matches;
			}));
		}
	}

	private getHapticsPlugin(): ICapacitorHaptics | undefined {
		try {
			const capacitor = (globalThis as Record<string, unknown>).Capacitor as { Plugins?: Record<string, unknown> } | undefined;
			return capacitor?.Plugins?.Haptics as ICapacitorHaptics | undefined;
		} catch {
			return undefined;
		}
	}

	private getNativeBridge(): IMobileNativeHapticsBridge | undefined {
		try {
			const bridge = (globalThis as Record<string, unknown>).MobileNative as IMobileNativeHapticsBridge | undefined;
			return bridge && typeof bridge.hapticImpact === 'function' ? bridge : undefined;
		} catch {
			return undefined;
		}
	}

	async impact(style: HapticImpactStyle): Promise<void> {
		if (this._prefersReducedMotion) {
			return;
		}

		const haptics = this.getHapticsPlugin();
		if (haptics) {
			try {
				await haptics.impact({ style });
				return;
			} catch {
				// fall through to native bridge
			}
		}

		const bridge = this.getNativeBridge();
		if (bridge) {
			try {
				bridge.hapticImpact(style);
			} catch {
				// Native bridge not available
			}
		}
	}

	async notification(type: HapticNotificationType): Promise<void> {
		if (this._prefersReducedMotion) {
			return;
		}

		const haptics = this.getHapticsPlugin();
		if (haptics) {
			try {
				await haptics.notification({ type });
			} catch {
				// Plugin not available
			}
		}
	}

	async selectionChanged(): Promise<void> {
		if (this._prefersReducedMotion) {
			return;
		}

		const haptics = this.getHapticsPlugin();
		if (haptics) {
			try {
				await haptics.selectionChanged();
			} catch {
				// Plugin not available
			}
		}
	}
}

registerSingleton(IHapticFeedbackService, HapticFeedbackService, InstantiationType.Delayed);
