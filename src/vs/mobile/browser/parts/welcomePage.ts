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
import { IServerInfo } from '../../services/connection/connectionService.js';

/**
 * Welcome page — the first screen shown to the user when not connected.
 * Displays saved servers and a button to connect to a new one.
 */
export class WelcomePage extends Disposable {

	private readonly _onDidSelectServer = this._register(new Emitter<IServerInfo>());
	readonly onDidSelectServer = this._onDidSelectServer.event;

	private readonly _onDidRequestNewConnection = this._register(new Emitter<void>());
	readonly onDidRequestNewConnection = this._onDidRequestNewConnection.event;

	private container!: HTMLElement;
	private serverListContainer!: HTMLElement;

	constructor(parent: HTMLElement) {
		super();
		this.create(parent);
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-welcome-page'));

		// Logo/title area — icon to the left of text
		const header = append(this.container, $('.welcome-header'));
		const iconContainer = append(header, $('.welcome-icon'));
		const iconSpan = append(iconContainer, $('span'));
		iconSpan.classList.add(...ThemeIcon.asClassNameArray(Codicon.code));
		const titleGroup = append(header, $('.welcome-title-group'));
		const title = append(titleGroup, $('h1.welcome-title'));
		title.textContent = localize('vsCodeMobile', "VS Code Mobile");
		const subtitle = append(titleGroup, $('p.welcome-subtitle'));
		subtitle.textContent = localize('connectToStart', "Connect to a remote server to start coding.");

		// Server list
		this.serverListContainer = append(this.container, $('.welcome-server-list'));

		// Connect button
		const connectButton = append(this.container, $('button.welcome-connect-button'));
		const plusIcon = append(connectButton, $('span'));
		plusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		const buttonLabel = append(connectButton, $('span'));
		buttonLabel.textContent = localize('addServer', "Add VS Code Server");
		this._register(addDisposableListener(connectButton, 'click', () => {
			this._onDidRequestNewConnection.fire();
		}));
	}

	updateServers(servers: IServerInfo[]): void {
		this.serverListContainer.textContent = '';
		for (const server of servers) {
			const item = append(this.serverListContainer, $('button.welcome-server-item'));
			const serverIcon = append(item, $('span.server-icon'));
			serverIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.vm));
			const info = append(item, $('.server-info'));
			const name = append(info, $('span.server-name'));
			name.textContent = server.name;
			const address = append(info, $('span.server-address'));
			address.textContent = `${server.address}:${server.port}`;
			const chevron = append(item, $('span.server-chevron'));
			chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
			this._register(addDisposableListener(item, 'click', () => {
				// Immediate visual feedback before page reload
				item.classList.add('loading');
				chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
				chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
				this._onDidSelectServer.fire(server);
			}));
		}
	}

	show(): void {
		this.container.style.display = '';
	}

	hide(): void {
		this.container.style.display = 'none';
	}
}
