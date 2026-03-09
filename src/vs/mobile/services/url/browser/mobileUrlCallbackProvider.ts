/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import type { IURLCallbackProvider } from '../../../../workbench/services/url/browser/urlService.js';
import { getCapacitorAppPlugin } from '../../../common/capacitorPlugins.js';

/**
 * URL callback provider for the mobile (Capacitor) workbench.
 *
 * Handles the OAuth redirect flow:
 * 1. The GitHub auth extension calls `env.openExternal(githubAuthUrl)`
 * 2. The system browser opens and the user authenticates
 * 3. GitHub redirects back to `code-oss://vscode.github-authentication/did-authenticate?...`
 * 4. The OS routes the `code-oss://` deep link back to the Capacitor app
 * 5. The `@capacitor/app` plugin fires the `appUrlOpen` event
 * 6. This provider fires `onCallback` with the parsed URI
 * 7. `BrowserURLService` forwards it to the extension's URI handler
 */
export class MobileURLCallbackProvider extends Disposable implements IURLCallbackProvider {

	private static readonly QUERY_KEYS: readonly ('scheme' | 'authority' | 'path' | 'query' | 'fragment')[] = [
		'scheme',
		'authority',
		'path',
		'query',
		'fragment'
	];

	private readonly _onCallback = this._register(new Emitter<URI>());
	readonly onCallback = this._onCallback.event;

	private readonly _uriScheme: string;

	constructor(uriScheme: string) {
		super();

		this._uriScheme = uriScheme;
		this._registerAppUrlListener();
	}

	/**
	 * Listen for deep-link URL opens from the Capacitor App plugin.
	 * When the OS opens a `code-oss://` URL, the app foregrounds
	 * and this listener fires with the full URL.
	 */
	private _registerAppUrlListener(): void {
		const appPlugin = getCapacitorAppPlugin();
		if (appPlugin) {
			const listenerPromise = appPlugin.addListener('appUrlOpen', (data: { url: string }) => {
				try {
					const uri = URI.parse(data.url);
					this._onCallback.fire(uri);
				} catch {
					// Malformed URL -- ignore
				}
			});
			this._register(toDisposable(() => {
				listenerPromise.then(handle => handle.remove());
			}));
		}

		// Register a window-level callback that the native app can invoke
		// directly via WebView.evaluateJavascript. This handles the case where
		// the Capacitor App plugin isn't active on a server-served page.
		// Scoped under a namespace to reduce global collision risk.
		const expectedScheme = this._uriScheme;
		const callbackFn = (url: string) => {
			try {
				const uri = URI.parse(url);
				// Only accept URIs matching the expected app scheme to prevent
				// arbitrary URI injection from malicious scripts.
				if (uri.scheme !== expectedScheme) {
					console.warn(`[mobile] Rejected URL callback with unexpected scheme: ${uri.scheme}`);
					return;
				}
				this._onCallback.fire(uri);
			} catch {
				// Malformed URL -- ignore
			}
		};
		(globalThis as Record<string, unknown>).__mobileUrlCallback = callbackFn;
		this._register(toDisposable(() => {
			if ((globalThis as Record<string, unknown>).__mobileUrlCallback === callbackFn) {
				delete (globalThis as Record<string, unknown>).__mobileUrlCallback;
			}
		}));
	}

	/**
	 * Creates a callback URI that the OAuth flow will redirect to.
	 * This URI uses the app's custom scheme (e.g. `code-oss://`) so
	 * the OS can route it back to the app after the browser-based
	 * authentication completes.
	 */
	create(options: Partial<UriComponents> = {}): URI {
		const queryParams: string[] = [];

		for (const key of MobileURLCallbackProvider.QUERY_KEYS) {
			const value = options[key];
			if (value) {
				queryParams.push(`vscode-${key}=${encodeURIComponent(value)}`);
			}
		}

		return URI.from({
			scheme: this._uriScheme,
			authority: 'callback',
			path: '/',
			query: queryParams.join('&'),
		});
	}
}
