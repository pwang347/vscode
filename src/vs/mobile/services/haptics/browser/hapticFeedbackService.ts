/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { getMobileNativeBridge, getCapacitorHapticsPlugin } from '../../../common/capacitorPlugins.js';

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
 * Haptic feedback service for mobile.
 *
 * In the Capacitor app, this bridges to the @capacitor/haptics native plugin
 * via the Capacitor plugin registry on globalThis.
 * Falls back to the MobileNative JS bridge (via `addJavascriptInterface`)
 * when Capacitor plugins are not available (e.g. on remote server pages).
 * In a web context (browser testing), haptics are no-ops.
 *
 * The service respects the system 'reduce motion' accessibility setting --
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

	async impact(style: HapticImpactStyle): Promise<void> {
		if (this._prefersReducedMotion) {
			return;
		}

		const haptics = getCapacitorHapticsPlugin();
		if (haptics) {
			try {
				await haptics.impact({ style });
				return;
			} catch {
				// fall through to native bridge
			}
		}

		const bridge = getMobileNativeBridge();
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

		const haptics = getCapacitorHapticsPlugin();
		if (haptics) {
			try {
				await haptics.notification({ type });
				return;
			} catch {
				// fall through to native bridge
			}
		}

		const bridge = getMobileNativeBridge();
		if (bridge) {
			try {
				bridge.hapticNotification(type);
			} catch {
				// Native bridge method may not exist
			}
		}
	}

	async selectionChanged(): Promise<void> {
		if (this._prefersReducedMotion) {
			return;
		}

		const haptics = getCapacitorHapticsPlugin();
		if (haptics) {
			try {
				await haptics.selectionChanged();
				return;
			} catch {
				// fall through to native bridge
			}
		}

		const bridge = getMobileNativeBridge();
		if (bridge) {
			try {
				bridge.hapticSelectionChanged();
			} catch {
				// Native bridge method may not exist
			}
		}
	}
}

registerSingleton(IHapticFeedbackService, HapticFeedbackService, InstantiationType.Delayed);
