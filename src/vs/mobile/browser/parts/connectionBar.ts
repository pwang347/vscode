/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/connectionBar.css';
import { Disposable } from '../../../base/common/lifecycle.js';
import { $, append, addDisposableListener } from '../../../base/browser/dom.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { MobileConnectionStatusContext, MobileCanGoBackContext } from '../../common/contextkeys.js';
import { Emitter } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { localize } from '../../../nls.js';

export interface IConnectionInfo {
	readonly serverName: string;
	readonly status: 'connected' | 'reconnecting' | 'disconnected';
}

/**
 * Mobile connection bar — a minimal top bar showing connection status
 * and an optional back button for navigating the view stack.
 */
export class ConnectionBar extends Disposable {

	private readonly _onDidPressBack = this._register(new Emitter<void>());
	readonly onDidPressBack = this._onDidPressBack.event;

	private readonly _onDidPressSettings = this._register(new Emitter<void>());
	readonly onDidPressSettings = this._onDidPressSettings.event;

	private container!: HTMLElement;
	private backButton!: HTMLElement;
	private statusIndicator!: HTMLElement;
	private serverNameLabel!: HTMLElement;

	private readonly connectionStatusKey;
	private readonly canGoBackKey;

	constructor(
		parent: HTMLElement,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.connectionStatusKey = MobileConnectionStatusContext.bindTo(contextKeyService);
		this.canGoBackKey = MobileCanGoBackContext.bindTo(contextKeyService);

		this.create(parent);
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-connection-bar'));

		// Back button (hidden by default, shown when view stack has depth > 1)
		this.backButton = append(this.container, $('.back-button'));
		this.backButton.style.display = 'none';
		this.backButton.setAttribute('role', 'button');
		this.backButton.setAttribute('aria-label', localize('back', "Go Back"));

		const backIcon = append(this.backButton, $('span'));
		backIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronLeft));
		this._register(addDisposableListener(this.backButton, 'click', () => {
			this._onDidPressBack.fire();
		}));

		// Connection status section
		const connectionStatus = append(this.container, $('.connection-status'));

		this.statusIndicator = append(connectionStatus, $('.status-indicator'));
		this.statusIndicator.classList.add('disconnected');
		this.statusIndicator.setAttribute('aria-label', localize('connectionStatus', "Connection Status"));

		this.serverNameLabel = append(connectionStatus, $('.server-name'));
		this.serverNameLabel.textContent = localize('notConnected', "Not Connected");

		// Settings/actions area
		const actions = append(this.container, $('.connection-actions'));
		const settingsButton = append(actions, $('.back-button')); // reuse styling
		settingsButton.setAttribute('role', 'button');
		settingsButton.setAttribute('aria-label', localize('connectionSettings', "Connection Settings"));

		const settingsIcon = append(settingsButton, $('span'));
		settingsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
		this._register(addDisposableListener(settingsButton, 'click', () => {
			this._onDidPressSettings.fire();
		}));
	}

	updateConnection(info: IConnectionInfo): void {
		this.statusIndicator.className = 'status-indicator';
		this.statusIndicator.classList.add(info.status);
		this.serverNameLabel.textContent = info.serverName;
		this.connectionStatusKey.set(info.status);
	}

	setCanGoBack(canGoBack: boolean): void {
		this.backButton.style.display = canGoBack ? '' : 'none';
		this.canGoBackKey.set(canGoBack);
	}

	getHeight(): number {
		return 44; // Fixed height matching CSS
	}
}
