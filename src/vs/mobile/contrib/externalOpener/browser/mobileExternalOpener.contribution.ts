/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { matchesSomeScheme, Schemas } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { MobileURLCallbackProvider } from '../../../services/url/mobileUrlCallbackProvider.js';

/**
 * Capacitor Browser plugin interface for opening URLs in the system browser.
 */
interface ICapacitorBrowserPlugin {
	open(options: { url: string }): Promise<void>;
	close(): Promise<void>;
}

/**
 * Overrides the default external opener on mobile to use the Capacitor
 * Browser plugin. This opens URLs in the system browser (Safari/Chrome)
 * rather than `window.open()`, which is critical for the OAuth flow:
 *
 * - In-app `window.open()` may be blocked by the Capacitor WebView
 * - Even if opened, the in-app browser cannot redirect back to the app
 *   via custom URI schemes (`code-oss://`)
 * - The system browser properly handles the `code-oss://` redirect,
 *   allowing the OS to route it back to the app
 *
 * For non-Capacitor environments (browser testing), this falls back
 * to the standard `window.open()` behavior.
 */
class MobileExternalOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.externalOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
	) {
		super();

		const browserPlugin = this._getBrowserPlugin();
		if (browserPlugin) {
			openerService.setDefaultExternalOpener({
				openExternal: async (href: string) => {
					if (matchesSomeScheme(href, Schemas.http, Schemas.https)) {
						await browserPlugin.open({ url: href });
					} else {
						// For non-HTTP schemes (e.g. mailto:), let the OS handle it
						mainWindow.location.href = href;
					}
					return true;
				}
			});
		}
	}

	private _getBrowserPlugin(): ICapacitorBrowserPlugin | undefined {
		return MobileURLCallbackProvider.getBrowserPlugin() as ICapacitorBrowserPlugin | undefined;
	}
}

registerWorkbenchContribution2(MobileExternalOpenerContribution.ID, MobileExternalOpenerContribution, WorkbenchPhase.BlockStartup);
