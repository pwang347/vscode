/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { matchesSomeScheme, Schemas } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { getMobileNativeBridge, getCapacitorBrowserPlugin } from '../../../browser/nativeBridge.js';

/**
 * Overrides the default external opener on mobile to open URLs in an in-app
 * browser (Chrome Custom Tabs on Android, SFSafariViewController on iOS)
 * rather than the system browser or `window.open()`.
 *
 * Uses two strategies depending on what's available:
 * 1. **Capacitor Browser plugin** -- available when the Capacitor bridge is
 *    injected (e.g. when serving from local webDir).
 * 2. **MobileNative JS bridge** -- injected by the native app via
 *    `addJavascriptInterface`, persists across navigations. Used when the
 *    WebView has navigated to a remote code server where Capacitor plugins
 *    may not be available.
 *
 * Both paths open an in-app browser that the user can dismiss to return
 * to the app, and both support the `code-oss://` redirect for OAuth.
 */
class MobileExternalOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.externalOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
	) {
		super();

		const browserPlugin = getCapacitorBrowserPlugin();
		const nativeBridge = getMobileNativeBridge();

		if (browserPlugin) {
			openerService.setDefaultExternalOpener({
				openExternal: async (href: string) => {
					if (matchesSomeScheme(href, Schemas.http, Schemas.https)) {
						await browserPlugin.open({ url: href });
					} else {
						mainWindow.location.href = href;
					}
					return true;
				}
			});
		} else if (nativeBridge) {
			openerService.setDefaultExternalOpener({
				openExternal: async (href: string) => {
					if (matchesSomeScheme(href, Schemas.http, Schemas.https)) {
						nativeBridge.openExternal(href);
					} else {
						mainWindow.location.href = href;
					}
					return true;
				}
			});
		}
	}
}

registerWorkbenchContribution2(MobileExternalOpenerContribution.ID, MobileExternalOpenerContribution, WorkbenchPhase.BlockStartup);
