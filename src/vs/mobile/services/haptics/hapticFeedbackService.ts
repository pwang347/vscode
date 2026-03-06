/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

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
 * Haptic feedback service for mobile.
 *
 * In the Capacitor app, this bridges to the @capacitor/haptics native plugin
 * via the Capacitor plugin registry on globalThis.
 * In a web context (browser testing), haptics are no-ops.
 *
 * The service respects the system "reduce motion" accessibility setting —
 * when enabled, all haptic methods become no-ops.
 */
export class HapticFeedbackService extends Disposable implements IHapticFeedbackService {

	declare readonly _serviceBrand: undefined;

	private readonly isCapacitorApp: boolean;
	private readonly prefersReducedMotion: boolean;

	constructor() {
		super();

		// Detect if running inside a Capacitor WebView
		this.isCapacitorApp = typeof (globalThis as Record<string, unknown>).Capacitor !== 'undefined';

		// Respect system accessibility setting
		this.prefersReducedMotion = typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	private getHapticsPlugin(): ICapacitorHaptics | undefined {
		try {
			const capacitor = (globalThis as Record<string, unknown>).Capacitor as { Plugins?: Record<string, unknown> } | undefined;
			return capacitor?.Plugins?.Haptics as ICapacitorHaptics | undefined;
		} catch {
			return undefined;
		}
	}

	async impact(style: HapticImpactStyle): Promise<void> {
		if (this.prefersReducedMotion) {
			return;
		}

		if (this.isCapacitorApp) {
			try {
				const haptics = this.getHapticsPlugin();
				await haptics?.impact({ style });
			} catch {
				// Plugin not available — fail silently
			}
		}
	}

	async notification(type: HapticNotificationType): Promise<void> {
		if (this.prefersReducedMotion) {
			return;
		}

		if (this.isCapacitorApp) {
			try {
				const haptics = this.getHapticsPlugin();
				await haptics?.notification({ type });
			} catch {
				// Plugin not available
			}
		}
	}

	async selectionChanged(): Promise<void> {
		if (this.prefersReducedMotion) {
			return;
		}

		if (this.isCapacitorApp) {
			try {
				const haptics = this.getHapticsPlugin();
				await haptics?.selectionChanged();
			} catch {
				// Plugin not available
			}
		}
	}
}
