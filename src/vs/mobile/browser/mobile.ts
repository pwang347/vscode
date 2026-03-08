/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { mark } from '../../base/common/performance.js';
import { parse } from '../../base/common/marshalling.js';
import { Schemas } from '../../base/common/network.js';
import { posix } from '../../base/common/path.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import product from '../../platform/product/common/product.js';
import { isFolderToOpen, isWorkspaceToOpen } from '../../platform/window/common/window.js';
import type { IWorkbenchConstructionOptions, IWorkspace, IWorkspaceProvider } from '../../workbench/browser/web.api.js';
import type { IWebSocketFactory, IWebSocket } from '../../platform/remote/browser/browserSocketFactory.js';
import { BrowserMain } from '../../workbench/browser/web.main.js';
import { domContentLoaded, getWindow } from '../../base/browser/dom.js';
import { Emitter } from '../../base/common/event.js';
import { MobileWorkbench, IMobileWorkbenchOptions } from './workbench.js';
import { MobileURLCallbackProvider } from '../services/url/browser/mobileUrlCallbackProvider.js';
import type { ISecretStorageProvider } from '../../platform/secrets/common/secrets.js';

// Import mobile entry point — brings in the full web workbench
// services plus mobile-specific services and contributions.
import '../mobile.web.main.js';

/**
 * Mobile workbench bootstrapper.
 *
 * Reads configuration from DOM meta tags (injected by the VS Code server),
 * creates the workspace provider, and launches the mobile workbench by invoking
 * the `create` function from the web factory.
 */

class MobileWorkspaceProvider extends Disposable implements IWorkspaceProvider {

	static create(config: IWorkbenchConstructionOptions & { folderUri?: UriComponents; workspaceUri?: UriComponents }): MobileWorkspaceProvider {
		let workspace: IWorkspace;
		let payload = Object.create(null);

		const query = new URL(mainWindow.document.location.href).searchParams;
		query.forEach((value, key) => {
			switch (key) {
				case 'folder':
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						workspace = { folderUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { folderUri: URI.parse(value) };
					}
					break;
				case 'workspace':
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						workspace = { workspaceUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { workspaceUri: URI.parse(value) };
					}
					break;
				case 'payload':
					try {
						payload = parse(value);
					} catch (error) {
						console.error(error);
					}
					break;
			}
		});

		// Fallback to config attributes
		if (!workspace!) {
			if (config.folderUri) {
				workspace = { folderUri: URI.revive(config.folderUri) };
			} else if (config.workspaceUri) {
				workspace = { workspaceUri: URI.revive(config.workspaceUri) };
			}
		}

		return new MobileWorkspaceProvider(workspace!, payload);
	}

	readonly trusted = true;

	private constructor(
		readonly workspace: IWorkspace,
		readonly payload: object,
	) {
		super();
	}

	async open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean> {
		// On mobile, we always reuse the same window (single-window model).
		// Preserve existing query params (remoteAuthority, connectionToken)
		// so the connection survives across folder opens.
		const params = new URLSearchParams(mainWindow.location.search);

		// Clear old workspace params before setting new ones
		params.delete('folder');
		params.delete('workspace');

		if (workspace) {
			if (isFolderToOpen(workspace)) {
				params.set('folder', workspace.folderUri.toString());
			} else if (isWorkspaceToOpen(workspace)) {
				params.set('workspace', workspace.workspaceUri.toString());
			}
		}

		if (options?.payload) {
			params.set('payload', JSON.stringify(options.payload));
		}

		const url = `${mainWindow.location.origin}${mainWindow.location.pathname}?${params.toString()}`;
		mainWindow.location.href = url;

		return true;
	}
}

/**
 * MobileBrowserMain extends the standard BrowserMain to use
 * MobileWorkbench (custom mobile layout) instead of the standard Workbench.
 */
class MobileBrowserMain extends BrowserMain {

	constructor(
		domElement: HTMLElement,
		configuration: IWorkbenchConstructionOptions,
		private readonly mobileOptions?: IMobileWorkbenchOptions,
	) {
		super(domElement, configuration);
	}

	override async open(): Promise<never> {

		// Init services and wait for DOM to be ready in parallel
		const [services] = await Promise.all([this.initServices(), domContentLoaded(getWindow(this.domElement))]);

		// Create Mobile Workbench (custom layout with connection bar, navigation bar, etc.)
		const workbench = new MobileWorkbench(this.domElement, this.mobileOptions, services.serviceCollection, services.logService);

		// Startup
		workbench.startup();

		// Mark workbench as open
		mark('code/didStartWorkbench');

		// The mobile workbench doesn't return the IWorkbench facade —
		// it runs as a standalone app (no embedder API needed).
		return new Promise(() => { /* keep alive */ });
	}
}

/**
 * WebSocket factory that forces ws:// instead of wss://.
 * Capacitor serves from https://localhost, so the default factory
 * would use wss://, but dev VS Code servers use plain ws://.
 */
function createMobileWebSocketFactory(): IWebSocketFactory {
	return {
		create(url: string, debugLabel: string): IWebSocket {
			const wsUrl = url.replace(/^wss:\/\//, 'ws://');
			const socket = new WebSocket(wsUrl);

			const onData = new Emitter<ArrayBuffer>();
			const onOpen = new Emitter<void>();
			const onClose = new Emitter<void>();
			const onError = new Emitter<unknown>();

			socket.binaryType = 'arraybuffer';
			socket.addEventListener('message', (e) => onData.fire(e.data as ArrayBuffer));
			socket.addEventListener('open', () => onOpen.fire());
			socket.addEventListener('close', () => onClose.fire());
			socket.addEventListener('error', (e) => onError.fire(e));

			return {
				onData: onData.event,
				onOpen: onOpen.event,
				onClose: onClose.event,
				onError: onError.event,
				send(data: ArrayBuffer | ArrayBufferView) { socket.send(data); },
				close() { socket.close(); },
			};
		}
	};
}

/**
 * Persists secrets (auth tokens) in localStorage so the user doesn't have
 * to re-authenticate on every page load. Uses transparent (no-op) encryption
 * since we're in a sandboxed WebView — there is no OS keychain available.
 */
class MobileSecretStorageProvider implements ISecretStorageProvider {

	private static readonly STORAGE_KEY = 'mobile.secrets';

	type = 'persisted' as const;

	private readonly _secrets: Promise<Record<string, string>>;

	constructor() {
		this._secrets = this._load();
	}

	private async _load(): Promise<Record<string, string>> {
		const raw = localStorage.getItem(MobileSecretStorageProvider.STORAGE_KEY);
		if (raw) {
			try {
				return JSON.parse(raw);
			} catch {
				localStorage.removeItem(MobileSecretStorageProvider.STORAGE_KEY);
			}
		}
		return {};
	}

	private async _save(): Promise<void> {
		localStorage.setItem(MobileSecretStorageProvider.STORAGE_KEY, JSON.stringify(await this._secrets));
	}

	async get(key: string): Promise<string | undefined> {
		return (await this._secrets)[key];
	}

	async set(key: string, value: string): Promise<void> {
		(await this._secrets)[key] = value;
		await this._save();
	}

	async delete(key: string): Promise<void> {
		delete (await this._secrets)[key];
		await this._save();
	}

	async keys(): Promise<string[]> {
		return Object.keys(await this._secrets);
	}
}

(async function () {

	// Read workbench configuration from the DOM (injected by server)
	// eslint-disable-next-line no-restricted-syntax
	const configData = mainWindow.document.getElementById('vscode-workbench-web-configuration')?.getAttribute('data-settings');

	let config: IWorkbenchConstructionOptions & { folderUri?: UriComponents; workspaceUri?: UriComponents } = {};
	if (configData) {
		try {
			config = parse(configData);
		} catch (error) {
			console.error('Failed to parse workbench configuration', error);
		}
	}

	// Create workspace provider from URL query params or config
	const workspaceProvider = MobileWorkspaceProvider.create(config);

	// Check for remote authority from URL params (set by ConnectionService)
	const urlParams = new URL(mainWindow.location.href).searchParams;
	const remoteAuthority = urlParams.get('remoteAuthority') || config.remoteAuthority;
	const connectionToken = urlParams.get('connectionToken') || config.connectionToken;

	// Build construction options for the mobile workbench
	const options: IWorkbenchConstructionOptions = {
		...config,
		workspaceProvider,
		remoteAuthority: remoteAuthority || undefined,
		connectionToken: connectionToken || undefined,
		// Force ws:// for remote connections. Capacitor serves the app from
		// https://localhost, so the default factory picks wss://, but the
		// VS Code dev server runs plain HTTP/WS.
		webSocketFactory: remoteAuthority ? createMobileWebSocketFactory() : undefined,
		// Persist auth tokens (GitHub, etc.) in localStorage so the user
		// doesn't have to re-authenticate on every page load / navigation.
		secretStorageProvider: new MobileSecretStorageProvider(),
		// Enable OAuth callback flow on mobile. The MobileURLCallbackProvider
		// listens for deep-link URL opens from the Capacitor App plugin,
		// allowing GitHub OAuth to redirect back to the app.
		urlCallbackProvider: new MobileURLCallbackProvider(product.urlProtocol ?? 'code-oss'),
		productConfiguration: {
			...product,
			...config.productConfiguration,
			// The OSS product.json doesn't include extensionsGallery.
			// For the mobile app to install extensions (e.g. GitHub Copilot Chat
			// during the sign-in setup flow), we need the VS Marketplace config.
			// The server may provide it via config; fall back to the public gallery.
			extensionsGallery: config.productConfiguration?.extensionsGallery ?? product.extensionsGallery,
			// The OSS product.json doesn't include extensionEnabledApiProposals.
			// Copilot extensions require proposed API access to register chat
			// participants and use private APIs. Merge from server config or
			// provide the required proposals for Copilot.
			extensionEnabledApiProposals: config.productConfiguration?.extensionEnabledApiProposals ?? product.extensionEnabledApiProposals ?? {
				'GitHub.copilot': [
					'inlineCompletionsAdditions', 'interactive', 'terminalDataWriteEvent', 'devDeviceId'
				],
				'GitHub.copilot-chat': [
					'interactive', 'terminalDataWriteEvent', 'terminalExecuteCommandEvent', 'terminalSelection',
					'terminalQuickFixProvider', 'chatParticipantAdditions', 'defaultChatParticipant', 'embeddings',
					'chatProvider', 'mappedEditsProvider', 'aiRelatedInformation', 'aiSettingsSearch',
					'codeActionAI', 'findTextInFiles', 'findTextInFiles2', 'textSearchProvider', 'textSearchProvider2',
					'activeComment', 'commentReveal', 'contribSourceControlInputBoxMenu',
					'contribCommentThreadAdditionalMenu', 'contribCommentsViewThreadMenus',
					'newSymbolNamesProvider', 'findFiles2', 'chatReferenceDiagnostic', 'extensionsAny',
					'authLearnMore', 'testObserver', 'aiTextSearchProvider', 'documentFiltersExclusive',
					'chatParticipantPrivate', 'contribDebugCreateConfiguration', 'inlineCompletionsAdditions',
					'chatReferenceBinaryData', 'languageModelSystem', 'languageModelCapabilities',
					'languageModelThinkingPart', 'chatStatusItem', 'taskProblemMatcherStatus',
					'contribLanguageModelToolSets', 'textDocumentChangeReason', 'resolvers',
					'taskExecutionTerminal', 'dataChannels', 'chatSessionsProvider', 'devDeviceId',
					'contribEditorContentMenu'
				],
			},
		},
		// Configuration defaults applied before the config service is ready.
		// Use this for settings that must be active from startup without
		// requiring a config write (which would fail if the service isn't ready).
		configurationDefaults: {
			// Device code flow works on mobile without requiring browser redirects
			// or custom URI scheme callbacks. The user copies a code and pastes it
			// at github.com/login/device in any browser.
			'github-authentication.preferDeviceCodeFlow': true,
			// Disable the web worker extension host on mobile. Capacitor serves
			// from https://localhost which blocks loading the worker iframe from
			// a file:// URL. All extensions run on the remote extension host instead.
			// Without this, activateByEvent hangs forever waiting for the broken
			// web worker host, blocking auth provider activation and sign-in.
			'extensions.webWorker': false,
			// Mobile uses its own welcome page and chat-first flow; suppress the
			// built-in welcome editor that would otherwise open on startup.
			'workbench.startupEditor': 'none',
		}
	};

	// Build mobile workbench options with external session info.
	// When the web browser provides remoteAuthority via URL or server config,
	// the session is forced (non-editable) — the user cannot change the server.
	// On the mobile app shell, the native side manages connections and can
	// pass session info with editable=true to allow the user to switch servers.
	let mobileOptions: IMobileWorkbenchOptions | undefined;
	if (remoteAuthority) {
		const [address, portStr] = remoteAuthority.split(':');
		mobileOptions = {
			sessionInfo: {
				server: {
					name: address,
					address,
					port: parseInt(portStr || '9888', 10),
					connectionToken: typeof connectionToken === 'string' ? connectionToken : undefined,
				},
				// Web browser sessions are non-editable by default.
				// The mobile app shell can override this by injecting
				// a 'mobileSessionEditable' meta tag or query param.
				editable: urlParams.get('mobileSessionEditable') === 'true',
			},
		};
	}

	// Launch the workbench
	mark('code/didLoadWorkbenchMain');
	try {
		// Add mobile class for CSS overrides
		mainWindow.document.body.classList.add('mobile-app');

		// Grab a reference to the loading splash (defined in mobile.html)
		// before the workbench modifies the DOM, so we can remove it after startup.
		const loadingSplash = mainWindow.document.body.firstElementChild as HTMLElement | null;

		// Always use MobileBrowserMain which creates the MobileWorkbench
		// with custom layout. When connected (remoteAuthority set),
		// MobileWorkbench creates real ChatWidget, file tree, and terminal
		// widgets backed by the remote server's services.
		await new MobileBrowserMain(mainWindow.document.body, options, {
			...mobileOptions,
			loadingSplash: loadingSplash ?? undefined,
		}).open();
	} catch (error) {
		console.error('[mobile] Failed to start workbench:', error);
		mainWindow.document.body.textContent = String(error);
	}

})();
