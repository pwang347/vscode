/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConnectionService, IServerInfo } from '../../../services/connection/connectionService.js';

/**
 * Contribution that provides the server connection management UI.
 * Allows users to add, select, and manage remote VS Code servers.
 */
class ConnectionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.connection';

	constructor(
		@IConnectionService private readonly connectionService: IConnectionService,
	) {
		super();

		// Auto-connect to last server on startup
		const lastServer = (this.connectionService as import('../../../services/connection/connectionService.js').ConnectionService).getLastServer();
		if (lastServer) {
			this.connectionService.connect(lastServer);
		}
	}
}

registerWorkbenchContribution2(ConnectionContribution.ID, ConnectionContribution, WorkbenchPhase.AfterRestored);

// Register "Connect to Server" action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'mobile.connectToServer',
			title: localize2('connectToServer', 'Connect to Server'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const connectionService = accessor.get(IConnectionService);

		const savedServers = connectionService.getSavedServers();

		interface IServerQuickPickItem extends IQuickPickItem {
			server?: IServerInfo;
		}

		const items: (IServerQuickPickItem | IQuickPickSeparator)[] = [
			...savedServers.map(server => ({
				label: server.name,
				description: `${server.address}:${server.port}`,
				server,
			})),
			{ type: 'separator', label: '' } satisfies IQuickPickSeparator,
			{ label: localize('addNewServer', "Add New Server...") },
		];

		const pick = await quickInputService.pick(items, {
			placeHolder: localize('selectServer', "Select a server to connect to"),
		});

		if (!pick) {
			return;
		}

		if (pick.server) {
			await connectionService.connect(pick.server);
		} else {
			// Add new server flow
			const name = await quickInputService.input({
				placeHolder: localize('serverName', "Server name (e.g., my-dev-machine)"),
				prompt: localize('enterServerName', "Enter a friendly name for this server"),
			});

			if (!name) {
				return;
			}

			const address = await quickInputService.input({
				placeHolder: localize('serverAddress', "Tailscale address (e.g., my-dev-machine or 100.x.y.z)"),
				prompt: localize('enterServerAddress', "Enter the Tailscale machine name or IP address"),
			});

			if (!address) {
				return;
			}

			const portStr = await quickInputService.input({
				placeHolder: localize('serverPort', "Port (default: 8000)"),
				prompt: localize('enterServerPort', "Enter the VS Code server port"),
				value: '8000',
			});

			const port = parseInt(portStr || '8000', 10);
			if (isNaN(port) || port < 1 || port > 65535) {
				return;
			}

			const token = await quickInputService.input({
				placeHolder: localize('connectionToken', "Connection token (optional)"),
				prompt: localize('enterConnectionToken', "Enter the VS Code server connection token"),
				password: true,
			});

			const server: IServerInfo = {
				name,
				address,
				port,
				connectionToken: token || undefined,
			};

			await connectionService.connect(server);
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
	}
});
