/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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

	readonly onDidChangeStatus: import('../../../../base/common/event.js').Event<ConnectionStatus>;
	readonly onDidChangeServer: import('../../../../base/common/event.js').Event<IServerInfo | undefined>;

	readonly status: ConnectionStatus;
	readonly currentServer: IServerInfo | undefined;

	/**
	 * Whether the session info (server connection) can be edited by the user.
	 * When false, the connection was provided externally (e.g. by the mobile
	 * app shell or web browser) and the user cannot change it.
	 */
	readonly sessionEditable: boolean;

	/**
	 * Initialize the connection from externally-provided session info.
	 * When `editable` is false, the user cannot change the server connection.
	 */
	initializeFromExternal(server: IServerInfo, editable: boolean): void;

	/**
	 * Connect to a remote VS Code server.
	 * The connection happens over the Tailscale VPN --
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
	 * Remove a saved server by address and port.
	 */
	removeServer(address: string, port: number): void;

	/**
	 * Get the last connected server (for auto-reconnect).
	 */
	getLastServer(): IServerInfo | undefined;
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
 * No Tailscale SDK is embedded -- Tailscale runs as a separate VPN on the device.
 */
export class ConnectionService extends Disposable implements IConnectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<ConnectionStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onDidChangeServer = this._register(new Emitter<IServerInfo | undefined>());
	readonly onDidChangeServer = this._onDidChangeServer.event;

	private _status: ConnectionStatus = 'disconnected';
	private _currentServer: IServerInfo | undefined;
	private _sessionEditable = true;

	get status(): ConnectionStatus { return this._status; }
	get currentServer(): IServerInfo | undefined { return this._currentServer; }
	get sessionEditable(): boolean { return this._sessionEditable; }

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	initializeFromExternal(server: IServerInfo, editable: boolean): void {
		this._sessionEditable = editable;
		this._currentServer = server;
		this.setStatus('connected');
		this._onDidChangeServer.fire(server);
	}

	async connect(server: IServerInfo): Promise<void> {
		this.setStatus('reconnecting');

		try {
			this._currentServer = server;
			this._onDidChangeServer.fire(server);

			// Save as last connected server
			this.storageService.store(LAST_SERVER_KEY, JSON.stringify(server), StorageScope.APPLICATION, StorageTarget.USER);

			// Save to server list (without connection token -- tokens are
			// stored in sessionStorage for the active session and in the
			// native keychain via MobileSecretStorageProvider for persistence).
			this.saveServer(server);

			// Check if we already have the correct remoteAuthority in the URL.
			// If so, just update the status -- no reload needed.
			const currentParams = new URLSearchParams(mainWindow.location.search);
			const desiredAuthority = `${server.address}:${server.port}`;
			if (currentParams.get('remoteAuthority') === desiredAuthority) {
				this.setStatus('connected');
				return;
			}

			// Store connection token in sessionStorage (survives the reload
			// but not exposed in URL query strings, browser history, or
			// referer headers).
			if (server.connectionToken) {
				mainWindow.sessionStorage.setItem('mobile.connectionToken', server.connectionToken);
			} else {
				mainWindow.sessionStorage.removeItem('mobile.connectionToken');
			}

			// Reload the app with remoteAuthority in the URL (no token).
			// The mobile.ts bootstrap reads the token from sessionStorage
			// and passes it to the workbench options.
			const params = new URLSearchParams();
			params.set('remoteAuthority', desiredAuthority);
			// NOTE: this triggers a page reload and the promise never resolves.
			this.logService.info(`[mobile] Connecting to ${desiredAuthority}, reloading...`);
			mainWindow.location.search = params.toString();
		} catch (err) {
			this.setStatus('disconnected');
			const message = `Failed to connect to ${server.address}:${server.port}`;
			throw new Error(message, { cause: err });
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
		// Strip connectionToken from persisted data -- tokens should not
		// be stored in plain-text localStorage. For persistent token storage,
		// use the native keychain via MobileSecretStorageProvider.
		const serverToSave: IServerInfo = {
			name: server.name,
			address: server.address,
			port: server.port,
		};
		const existing = servers.findIndex(s => s.address === server.address && s.port === server.port);
		if (existing >= 0) {
			servers[existing] = serverToSave;
		} else {
			servers.push(serverToSave);
		}
		this.storageService.store(SAVED_SERVERS_KEY, JSON.stringify(servers), StorageScope.APPLICATION, StorageTarget.USER);
	}

	removeServer(address: string, port: number): void {
		const servers = this.getSavedServers().filter(s => !(s.address === address && s.port === port));
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
