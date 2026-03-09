/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/connectionForm.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConnectionService, IServerInfo } from '../../../services/connection/browser/connectionService.js';
import { $, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { MobileSessionEditableContext } from '../../../common/contextkeys.js';
import { navigateToShell } from '../../../browser/navigation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

/**
 * Show a mobile-friendly connection form as an HTML overlay.
 */
function showConnectionForm(savedServers: IServerInfo[]): Promise<IServerInfo | undefined> {
	return new Promise((resolve) => {
		const overlay = append(mainWindow.document.body, $('.mobile-connection-overlay'));

		const title = append(overlay, $('h2.connection-form-title'));
		title.textContent = localize('connectToServer', "Connect to Server");

		const errorBox = append(overlay, $('div.connection-form-error'));

		// Saved servers list
		if (savedServers.length > 0) {
			const savedLabel = append(overlay, $('div.connection-form-section-label'));
			savedLabel.textContent = localize('savedServers', "Saved Servers");
			for (const server of savedServers) {
				const btn = append(overlay, $('button.connection-form-saved-server'));
				btn.textContent = `${server.name} (${server.address}:${server.port})`;
				btn.addEventListener('click', () => { cleanup(); resolve(server); });
			}
			append(overlay, $('hr.connection-form-separator'));
		}

		const newLabel = append(overlay, $('div.connection-form-section-label'));
		newLabel.textContent = localize('newServer', "New Server");

		function createField(labelText: string, placeholder: string, value: string, type = 'text'): HTMLInputElement {
			const label = append(overlay, $('label.connection-form-label'));
			label.textContent = labelText;
			const input = append(overlay, $('input.connection-form-input')) as HTMLInputElement;
			input.type = type;
			input.placeholder = placeholder;
			input.value = value;
			return input;
		}

		const nameInput = createField(localize('serverNameLabel', "Server Name"), 'my-dev-machine', '');
		const addressInput = createField(localize('addressLabel', "Host / Tailscale Name"), 'my-machine or 100.x.y.z', '');
		const portInput = createField(localize('portLabel', "Port"), '9888', '', 'number');
		const tokenInput = createField(localize('tokenLabel', "Connection Token"), 'dev-token', '', 'password');

		const btnRow = append(overlay, $('div.connection-form-button-row'));

		const cancelBtn = append(btnRow, $('button.connection-form-cancel'));
		cancelBtn.textContent = localize('cancel', "Cancel");
		cancelBtn.addEventListener('click', () => { cleanup(); resolve(undefined); });

		const connectBtn = append(btnRow, $('button.connection-form-connect'));
		connectBtn.textContent = localize('connect', "Connect");
		connectBtn.addEventListener('click', () => {
			const name = nameInput.value.trim();
			const address = addressInput.value.trim();
			const port = parseInt(portInput.value || '9888', 10);
			const token = tokenInput.value.trim();

			if (!address) {
				errorBox.textContent = localize('addressRequired', "Host / Tailscale name is required.");
				errorBox.style.display = 'block';
				return;
			}
			if (!name) {
				nameInput.value = address;
			}
			if (isNaN(port) || port < 1 || port > 65535) {
				errorBox.textContent = localize('invalidPort', "Port must be between 1 and 65535.");
				errorBox.style.display = 'block';
				return;
			}

			cleanup();
			resolve({
				name: nameInput.value.trim() || address,
				address,
				port,
				connectionToken: token || undefined,
			});
		});

		function cleanup() {
			overlay.remove();
		}
	});
}

/**
 * Contribution that provides the server connection management UI.
 */
class ConnectionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.connection';

	constructor(
		@IConnectionService private readonly connectionService: IConnectionService,
	) {
		super();

		// Auto-connect to last server on startup (only if URL already has remoteAuthority
		// and session info was not externally provided)
		if (this.connectionService.sessionEditable) {
			const params = new URLSearchParams(mainWindow.location.search);
			if (params.has('remoteAuthority')) {
				const lastServer = (this.connectionService as import('../../../services/connection/browser/connectionService.js').ConnectionService).getLastServer();
				if (lastServer) {
					this.connectionService.connect(lastServer);
				}
			}
		}
	}
}

registerWorkbenchContribution2(ConnectionContribution.ID, ConnectionContribution, WorkbenchPhase.AfterRestored);

// Register "Connect to Server" action (only available when session is editable)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'mobile.connectToServer',
			title: localize2('connectToServerAction', 'Connect to Server'),
			f1: true,
			precondition: MobileSessionEditableContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const connectionService = accessor.get(IConnectionService);
		if (!connectionService.sessionEditable) {
			return;
		}
		const savedServers = connectionService.getSavedServers();

		const server = await showConnectionForm(savedServers);
		if (!server) {
			return;
		}

		try {
			await connectionService.connect(server);
		} catch (error) {
			const notificationService = accessor.get(INotificationService);
			notificationService.notify({
				severity: Severity.Error,
				message: localize('connectionFailed', "Failed to connect: {0}", String(error)),
			});
		}
	}
});

// Register "Disconnect" action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'mobile.disconnect',
			title: localize2('disconnect', 'Disconnect from Server'),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const connectionService = accessor.get(IConnectionService);
		connectionService.disconnect();
		// Navigate back to the app shell (server selection page)
		navigateToShell();
	}
});
