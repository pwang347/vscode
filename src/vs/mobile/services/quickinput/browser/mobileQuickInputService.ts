/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mobileQuickInput.css';
import { $, append, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
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
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';

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
 * - Drag-to-resize with snap-to-top and snap-to-dismiss
 */
export class MobileQuickInputService extends WorkbenchQuickInputService {

	/** Fraction of viewport height below which a downward drag dismisses. */
	private static readonly DISMISS_THRESHOLD = 0.3;
	/** Fraction of viewport height above which an upward drag snaps to top. */
	private static readonly SNAP_TOP_THRESHOLD = 0.55;

	private _overlay: HTMLElement | undefined;
	private _handle: HTMLElement | undefined;
	private _widget: HTMLElement | undefined;
	private readonly _overlayListener = this._register(new MutableDisposable());
	private readonly _dragListeners = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(configurationService, instantiationService, keybindingService, contextKeyService, themeService, layoutService);
	}

	protected override createController(): QuickInputController {
		const controller = super.createController();

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

		// Sheet handle + drag
		this._ensureHandle();
		this._widget?.classList.remove('mobile-sheet-snapped-top');
	}

	private _onControllerHide(): void {
		this._overlay?.classList.remove('visible');
		this._overlayListener.clear();
		this._dragListeners.clear();
		if (this._widget) {
			this._widget.style.removeProperty('--mobile-sheet-translate-y');
			this._widget.classList.remove('mobile-sheet-dragging', 'mobile-sheet-snapped-top');
		}
	}

	/**
	 * Inserts the bottom-sheet drag handle indicator as the first child
	 * of the `.quick-input-widget` element and wires up drag listeners.
	 */
	private _ensureHandle(): void {
		if (!this._widget) {
			const container = this.layoutService.activeContainer;
			for (let i = 0; i < container.children.length; i++) {
				const child = container.children[i] as HTMLElement;
				if (child.classList.contains('quick-input-widget')) {
					this._widget = child;
					break;
				}
			}
		}

		if (!this._widget) {
			return;
		}

		if (!this._handle) {
			this._handle = $('.mobile-sheet-handle');
			this._widget.insertBefore(this._handle, this._widget.firstChild);
		}

		this._setupDrag();
	}

	/**
	 * Sets up pointer-based drag on the sheet handle.
	 * - Dragging up past `SNAP_TOP_THRESHOLD` of the viewport snaps to full screen.
	 * - Dragging down past `DISMISS_THRESHOLD` of the viewport dismisses.
	 * - Otherwise the sheet springs back.
	 */
	private _setupDrag(): void {
		const handle = this._handle;
		const widget = this._widget;
		if (!handle || !widget) {
			return;
		}

		const store = new DisposableStore();
		this._dragListeners.value = store;

		store.add(addDisposableListener(handle, EventType.POINTER_DOWN, (e: PointerEvent) => {
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);

			const startY = e.clientY;
			const win = getWindow(handle);
			const viewportHeight = win.innerHeight;
			const isSnappedTop = widget.classList.contains('mobile-sheet-snapped-top');

			widget.classList.add('mobile-sheet-dragging');

			const onMove = (ev: PointerEvent) => {
				const deltaY = ev.clientY - startY;
				widget.style.setProperty('--mobile-sheet-translate-y', `${Math.max(0, deltaY)}px`);
			};

			const onUp = (ev: PointerEvent) => {
				moveListener.dispose();
				upListener.dispose();
				handle.releasePointerCapture(ev.pointerId);

				widget.classList.remove('mobile-sheet-dragging');

				const deltaY = ev.clientY - startY;
				const absDelta = Math.abs(deltaY);

				if (deltaY > 0 && absDelta > viewportHeight * MobileQuickInputService.DISMISS_THRESHOLD) {
					// Dragged down far enough — dismiss
					widget.style.removeProperty('--mobile-sheet-translate-y');
					this.cancel();
				} else if (deltaY < 0 && !isSnappedTop && absDelta > viewportHeight * (MobileQuickInputService.SNAP_TOP_THRESHOLD - 0.3)) {
					// Dragged up far enough from default — snap to top
					widget.style.removeProperty('--mobile-sheet-translate-y');
					widget.classList.add('mobile-sheet-snapped-top');
				} else if (deltaY > 0 && isSnappedTop && absDelta > viewportHeight * 0.15) {
					// Dragged down from snapped-top — unsnap back to default
					widget.style.removeProperty('--mobile-sheet-translate-y');
					widget.classList.remove('mobile-sheet-snapped-top');
				} else {
					// Spring back
					widget.style.removeProperty('--mobile-sheet-translate-y');
				}
			};

			const moveListener = addDisposableListener(win, EventType.POINTER_MOVE, onMove);
			const upListener = addDisposableListener(win, EventType.POINTER_UP, onUp);
		}));
	}
}

registerSingleton(IQuickInputService, MobileQuickInputService, InstantiationType.Delayed);

