/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';

export const IConnectionService = createDecorator<IConnectionService>('mobileConnectionService');

export interface IServerInfo {
	readonly name: string;
	readonly address: string;
	readonly port: number;
	readonly connectionToken?: string;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface IConnectionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeStatus: import('../../../base/common/event.js').Event<ConnectionStatus>;
	readonly onDidChangeServer: import('../../../base/common/event.js').Event<IServerInfo | undefined>;

	readonly status: ConnectionStatus;
	readonly currentServer: IServerInfo | undefined;

	/**
	 * Connect to a remote VS Code server.
	 * The connection happens over the Tailscale VPN —
	 * the mobile device and server must both be on the same Tailnet.
	 */
	connect(server: IServerInfo): Promise<void>;

	/**
	 * Disconnect from the current server.
	 */
	disconnect(): void;

	/**
	 * Get the list of saved servers.
	 */
	getSavedServers(): IServerInfo[];

	/**
	 * Save a server to the list.
	 */
	saveServer(server: IServerInfo): void;

	/**
	 * Remove a saved server.
	 */
	removeServer(address: string): void;
}

const SAVED_SERVERS_KEY = 'mobile.savedServers';
const LAST_SERVER_KEY = 'mobile.lastServer';

/**
 * Manages connections to remote VS Code servers over Tailscale networking.
 *
 * The connection model is simple:
 * 1. Both the mobile device and the server machine run Tailscale
 * 2. The user provides the Tailscale machine name + port
 * 3. The app connects using the standard VS Code remote protocol (WebSocket)
 * 4. Authentication uses VS Code server connection tokens
 *
 * No Tailscale SDK is embedded — Tailscale runs as a separate VPN on the device.
 */
export class ConnectionService extends Disposable implements IConnectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<ConnectionStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onDidChangeServer = this._register(new Emitter<IServerInfo | undefined>());
	readonly onDidChangeServer = this._onDidChangeServer.event;

	private _status: ConnectionStatus = 'disconnected';
	private _currentServer: IServerInfo | undefined;

	get status(): ConnectionStatus { return this._status; }
	get currentServer(): IServerInfo | undefined { return this._currentServer; }

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	async connect(server: IServerInfo): Promise<void> {
		this.setStatus('reconnecting');

		try {
			// The actual WebSocket connection to the VS Code server is handled
			// by the standard remote agent service via IWorkbenchConstructionOptions.
			// This service manages the UI state and server list.
			//
			// In the Capacitor app, the connection goes through the device's
			// Tailscale VPN tunnel — no special SDK needed.
			this._currentServer = server;
			this._onDidChangeServer.fire(server);

			// Save as last connected server
			this.storageService.store(LAST_SERVER_KEY, JSON.stringify(server), StorageScope.APPLICATION, StorageTarget.USER);

			// Save to server list
			this.saveServer(server);

			this.setStatus('connected');
		} catch {
			this.setStatus('disconnected');
			throw new Error(`Failed to connect to ${server.address}:${server.port}`);
		}
	}

	disconnect(): void {
		this._currentServer = undefined;
		this._onDidChangeServer.fire(undefined);
		this.setStatus('disconnected');
	}

	getSavedServers(): IServerInfo[] {
		const raw = this.storageService.get(SAVED_SERVERS_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const servers = JSON.parse(raw);
			return Array.isArray(servers) ? servers : [];
		} catch {
			return [];
		}
	}

	saveServer(server: IServerInfo): void {
		const servers = this.getSavedServers();
		const existing = servers.findIndex(s => s.address === server.address && s.port === server.port);
		if (existing >= 0) {
			servers[existing] = server;
		} else {
			servers.push(server);
		}
		this.storageService.store(SAVED_SERVERS_KEY, JSON.stringify(servers), StorageScope.APPLICATION, StorageTarget.USER);
	}

	removeServer(address: string): void {
		const servers = this.getSavedServers().filter(s => s.address !== address);
		this.storageService.store(SAVED_SERVERS_KEY, JSON.stringify(servers), StorageScope.APPLICATION, StorageTarget.USER);
	}

	getLastServer(): IServerInfo | undefined {
		const raw = this.storageService.get(LAST_SERVER_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	private setStatus(status: ConnectionStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}
}
