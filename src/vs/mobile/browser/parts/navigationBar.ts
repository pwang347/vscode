/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/navigationBar.css';
import { Disposable } from '../../../base/common/lifecycle.js';
import { mainWindow } from '../../../base/browser/window.js';
import { $, append, addDisposableListener } from '../../../base/browser/dom.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { MobileActiveTabContext, MobileKeyboardVisibleContext } from '../../common/contextkeys.js';
import { Emitter } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { MobileTab } from './parts.js';
import { localize } from '../../../nls.js';

export interface INavigationTab {
	readonly id: MobileTab;
	readonly label: string;
	readonly icon: ThemeIcon;
}

const DEFAULT_TABS: INavigationTab[] = [
	{ id: MobileTab.Chat, label: localize('chat', "Chat"), icon: Codicon.commentDiscussion },
	{ id: MobileTab.Files, label: localize('files', "Files"), icon: Codicon.files },
];

/**
 * Mobile navigation bar — a bottom tab bar following native mobile patterns.
 * Provides tab navigation between Chat, Files, and Terminal views.
 */
export class NavigationBar extends Disposable {

	private readonly _onDidSelectTab = this._register(new Emitter<MobileTab>());
	readonly onDidSelectTab = this._onDidSelectTab.event;

	private container!: HTMLElement;
	private readonly tabElements = new Map<MobileTab, HTMLElement>();
	private activeTab: MobileTab = MobileTab.Chat;

	private readonly activeTabKey;
	private readonly keyboardVisibleKey;

	constructor(
		parent: HTMLElement,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.activeTabKey = MobileActiveTabContext.bindTo(contextKeyService);
		this.keyboardVisibleKey = MobileKeyboardVisibleContext.bindTo(contextKeyService);
		this.activeTabKey.set(MobileTab.Chat);

		this.create(parent);
		this.setupKeyboardListener();
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-navigation-bar'));
		this.container.setAttribute('role', 'tablist');

		for (const tab of DEFAULT_TABS) {
			this.createTab(tab);
		}

		// Set initial active state
		this.updateActiveTab(MobileTab.Chat);
	}

	private createTab(tab: INavigationTab): void {
		const tabElement = append(this.container, $('.mobile-nav-tab'));
		tabElement.setAttribute('role', 'tab');
		tabElement.setAttribute('aria-label', tab.label);
		tabElement.setAttribute('aria-selected', 'false');
		tabElement.dataset.tabId = tab.id;

		// Icon
		const iconElement = append(tabElement, $('.tab-icon'));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(tab.icon));

		// Label
		const labelElement = append(tabElement, $('.tab-label'));
		labelElement.textContent = tab.label;

		// Click handler
		this._register(addDisposableListener(tabElement, 'click', () => {
			this.selectTab(tab.id);
		}));

		this.tabElements.set(tab.id, tabElement);
	}

	selectTab(tabId: MobileTab): void {
		if (this.activeTab === tabId) {
			return;
		}

		this.activeTab = tabId;
		this.updateActiveTab(tabId);
		this.activeTabKey.set(tabId);
		this._onDidSelectTab.fire(tabId);
	}

	private updateActiveTab(tabId: MobileTab): void {
		for (const [id, element] of this.tabElements) {
			const isActive = id === tabId;
			element.classList.toggle('active', isActive);
			element.setAttribute('aria-selected', String(isActive));
		}
	}

	getActiveTab(): MobileTab {
		return this.activeTab;
	}

	/**
	 * Hide the navigation bar when the virtual keyboard is open
	 * to maximize screen space for input.
	 */
	private setupKeyboardListener(): void {
		if (mainWindow.visualViewport) {
			const handler = () => {
				const viewportHeight = mainWindow.visualViewport!.height;
				const windowHeight = mainWindow.innerHeight;
				const keyboardVisible = windowHeight - viewportHeight > 150;

				this.container.classList.toggle('keyboard-visible', keyboardVisible);
				this.keyboardVisibleKey.set(keyboardVisible);
			};

			this._register(addDisposableListener(mainWindow.visualViewport, 'resize', handler));
		}
	}

	getHeight(): number {
		return 56; // Fixed height matching CSS
	}
}
