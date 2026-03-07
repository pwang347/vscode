/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConnectionService, IServerInfo } from '../../../services/connection/connectionService.js';
import { $, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

/**
 * Show a mobile-friendly connection form as an HTML overlay.
 */
function showConnectionForm(savedServers: IServerInfo[]): Promise<IServerInfo | undefined> {
	return new Promise((resolve) => {
		const overlay = append(mainWindow.document.body, $('.mobile-connection-overlay'));
		overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);display:flex;flex-direction:column;padding:20px;font-family:var(--vscode-font-family,system-ui);overflow-y:auto;';

		const title = append(overlay, $('h2'));
		title.textContent = localize('connectToServer', "Connect to Server");
		title.style.cssText = 'margin:0 0 16px;font-size:20px;font-weight:600;';

		const errorBox = append(overlay, $('div'));
		errorBox.style.cssText = 'display:none;padding:10px;margin-bottom:12px;background:#f4877133;border:1px solid #f48771;border-radius:6px;font-size:13px;color:#f48771;';

		// Saved servers list
		if (savedServers.length > 0) {
			const savedLabel = append(overlay, $('div'));
			savedLabel.textContent = localize('savedServers', "Saved Servers");
			savedLabel.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;opacity:0.7;';
			for (const server of savedServers) {
				const btn = append(overlay, $('button'));
				btn.textContent = `${server.name} (${server.address}:${server.port})`;
				btn.style.cssText = 'display:block;width:100%;padding:12px;margin-bottom:8px;background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-input-border,#444);border-radius:6px;font-size:15px;text-align:left;cursor:pointer;';
				btn.addEventListener('click', () => { cleanup(); resolve(server); });
			}
			const sep = append(overlay, $('hr'));
			sep.style.cssText = 'border:none;border-top:1px solid var(--vscode-input-border,#444);margin:12px 0;';
		}

		const newLabel = append(overlay, $('div'));
		newLabel.textContent = localize('newServer', "New Server");
		newLabel.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;opacity:0.7;';

		function createField(labelText: string, placeholder: string, value: string, type = 'text'): HTMLInputElement {
			const label = append(overlay, $('label'));
			label.textContent = labelText;
			label.style.cssText = 'display:block;font-size:13px;margin-bottom:4px;opacity:0.8;';
			const input = append(overlay, $('input')) as HTMLInputElement;
			input.type = type;
			input.placeholder = placeholder;
			input.value = value;
			input.style.cssText = 'display:block;width:100%;padding:10px 12px;margin-bottom:12px;background:var(--vscode-input-background,#2a2a2a);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#444);border-radius:6px;font-size:16px;box-sizing:border-box;outline:none;';
			input.addEventListener('focus', () => { input.style.borderColor = 'var(--vscode-focusBorder,#007acc)'; });
			input.addEventListener('blur', () => { input.style.borderColor = 'var(--vscode-input-border,#444)'; });
			return input;
		}

		const nameInput = createField(localize('serverNameLabel', "Server Name"), 'my-dev-machine', 'pauls-macbook-pro-2');
		const addressInput = createField(localize('addressLabel', "Host / Tailscale Name"), 'my-machine or 100.x.y.z', 'pauls-macbook-pro-2');
		const portInput = createField(localize('portLabel', "Port"), '9888', '9888', 'number');
		const tokenInput = createField(localize('tokenLabel', "Connection Token"), 'dev-token', 'dev-token', 'password');

		const btnRow = append(overlay, $('div'));
		btnRow.style.cssText = 'display:flex;gap:10px;margin-top:4px;';

		const cancelBtn = append(btnRow, $('button'));
		cancelBtn.textContent = localize('cancel', "Cancel");
		cancelBtn.style.cssText = 'flex:1;padding:12px;background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-input-border,#444);border-radius:6px;font-size:16px;cursor:pointer;';
		cancelBtn.addEventListener('click', () => { cleanup(); resolve(undefined); });

		const connectBtn = append(btnRow, $('button'));
		connectBtn.textContent = localize('connect', "Connect");
		connectBtn.style.cssText = 'flex:1;padding:12px;background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border:none;border-radius:6px;font-size:16px;font-weight:600;cursor:pointer;';
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

		// Auto-connect to last server on startup (only if URL already has remoteAuthority)
		const params = new URLSearchParams(mainWindow.location.search);
		if (params.has('remoteAuthority')) {
			const lastServer = (this.connectionService as import('../../../services/connection/connectionService.js').ConnectionService).getLastServer();
			if (lastServer) {
				this.connectionService.connect(lastServer);
			}
		}
	}
}

registerWorkbenchContribution2(ConnectionContribution.ID, ConnectionContribution, WorkbenchPhase.AfterRestored);

// Register "Connect to Server" action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'mobile.connectToServer',
			title: localize2('connectToServerAction', 'Connect to Server'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const connectionService = accessor.get(IConnectionService);
		const savedServers = connectionService.getSavedServers();

		const server = await showConnectionForm(savedServers);
		if (!server) {
			return;
		}

		try {
			await connectionService.connect(server);
		} catch (error) {
			// Show error on screen
			const errorDiv = append(mainWindow.document.body, $('div'));
			errorDiv.style.cssText = 'position:fixed;bottom:80px;left:12px;right:12px;z-index:10001;padding:12px;background:#f4877133;border:1px solid #f48771;border-radius:8px;color:#f48771;font-size:14px;text-align:center;';
			errorDiv.textContent = String(error);
			setTimeout(() => errorDiv.remove(), 5000);
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
		// Reload without remoteAuthority
		mainWindow.location.search = '';
	}
});
