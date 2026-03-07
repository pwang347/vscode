/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { $, append, addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { localize } from '../../../nls.js';

/**
 * Mobile top bar — minimal bar with a hamburger button and a title.
 * Replaces the old ConnectionBar in the chat phase.
 */
export class TopBar extends Disposable {

	private readonly _onDidPressMenu = this._register(new Emitter<void>());
	readonly onDidPressMenu = this._onDidPressMenu.event;

	private readonly _onDidPressBack = this._register(new Emitter<void>());
	readonly onDidPressBack = this._onDidPressBack.event;

	private container!: HTMLElement;
	private menuButton!: HTMLElement;
	private backButton!: HTMLElement;
	private titleLabel!: HTMLElement;

	constructor(parent: HTMLElement) {
		super();
		this.create(parent);
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-top-bar'));

		// Back button (hidden by default, shown in sub-views like Files)
		this.backButton = append(this.container, $('button.top-bar-back'));
		this.backButton.setAttribute('role', 'button');
		this.backButton.setAttribute('aria-label', localize('goBack', "Go Back"));
		this.backButton.style.display = 'none';
		const backIcon = append(this.backButton, $('span'));
		backIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowLeft));
		this._register(addDisposableListener(this.backButton, 'click', () => {
			this._onDidPressBack.fire();
		}));

		// Hamburger button
		this.menuButton = append(this.container, $('button.top-bar-menu'));
		this.menuButton.setAttribute('role', 'button');
		this.menuButton.setAttribute('aria-label', localize('openMenu', "Open Menu"));
		const menuIcon = append(this.menuButton, $('span'));
		menuIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.menu));
		this._register(addDisposableListener(this.menuButton, 'click', () => {
			this._onDidPressMenu.fire();
		}));

		// Title
		this.titleLabel = append(this.container, $('span.top-bar-title'));
		this.titleLabel.textContent = localize('newChat', "New Chat");
	}

	setTitle(title: string): void {
		this.titleLabel.textContent = title;
	}

	setBackVisible(visible: boolean): void {
		this.backButton.style.display = visible ? '' : 'none';
		this.menuButton.style.display = visible ? 'none' : '';
	}

	getHeight(): number {
		return 44;
	}

	show(): void {
		this.container.style.display = '';
	}

	hide(): void {
		this.container.style.display = 'none';
	}
}
