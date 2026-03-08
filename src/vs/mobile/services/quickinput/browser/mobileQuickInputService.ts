/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mobileQuickInput.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { QuickInputController } from '../../../../platform/quickinput/browser/quickInputController.js';
import { QuickInputService as WorkbenchQuickInputService } from '../../../../workbench/services/quickinput/browser/quickInputService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Mobile-specific QuickInputService that renders the quick pick as a bottom
 * sheet instead of the default top-aligned dropdown. This follows standard
 * mobile design patterns (iOS action sheets / Android bottom sheets) and
 * provides larger touch targets, a backdrop overlay, and slide-up animation.
 *
 * All features of the standard quick pick are preserved: search/filter,
 * separators, multi-select checkboxes, item buttons, progress bar, back
 * navigation, and tree mode.
 *
 * The heavy lifting is done by the companion CSS file which transforms the
 * `.quick-input-widget` into a bottom sheet using `!important` overrides
 * for the inline styles set by `QuickInputController.updateLayout()`.
 * This service adds:
 * - Backdrop overlay for dismiss-on-tap
 * - Sheet drag handle indicator
 */
export class MobileQuickInputService extends WorkbenchQuickInputService {

	private _overlay: HTMLElement | undefined;
	private _handle: HTMLElement | undefined;
	private readonly _overlayListener = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@ILayoutService layoutService: ILayoutService,
	) {
		// Pass all parameters to the parent. `keybindingService` is passed
		// directly to super without redeclaring it to avoid conflicting with
		// the parent's private property.
		super(configurationService, instantiationService, keybindingService, contextKeyService, themeService, layoutService);
	}

	protected override createController(): QuickInputController {
		const controller = super.createController();

		// Show/hide the backdrop overlay when the quick input opens/closes.
		this._register(controller.onShow(() => this._onControllerShow()));
		this._register(controller.onHide(() => this._onControllerHide()));

		return controller;
	}

	private _onControllerShow(): void {
		// Backdrop overlay
		if (!this._overlay) {
			this._overlay = append(this.layoutService.mainContainer, $('.mobile-quick-input-overlay'));
		}
		this._overlayListener.value = addDisposableListener(this._overlay, EventType.CLICK, () => {
			this.cancel();
		});
		this._overlay.classList.add('visible');

		// Sheet handle
		this._ensureHandle();
	}

	private _onControllerHide(): void {
		this._overlay?.classList.remove('visible');
		this._overlayListener.clear();
	}

	/**
	 * Inserts the bottom-sheet drag handle indicator as the first child
	 * of the `.quick-input-widget` element if not already present.
	 */
	private _ensureHandle(): void {
		if (this._handle) {
			return;
		}
		const parent = this.currentQuickInput;
		if (!parent) {
			return;
		}
		const container = this.layoutService.activeContainer;
		for (let i = 0; i < container.children.length; i++) {
			const child = container.children[i];
			if (child.classList.contains('quick-input-widget')) {
				this._handle = $('.mobile-sheet-handle');
				child.insertBefore(this._handle, child.firstChild);
				break;
			}
		}
	}
}

registerSingleton(IQuickInputService, MobileQuickInputService, InstantiationType.Delayed);

