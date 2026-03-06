/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { parse } from '../../base/common/marshalling.js';
import { Schemas } from '../../base/common/network.js';
import { posix } from '../../base/common/path.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import product from '../../platform/product/common/product.js';
import { isFolderToOpen, isWorkspaceToOpen } from '../../platform/window/common/window.js';
import type { IWorkbenchConstructionOptions, IWorkspace, IWorkspaceProvider } from '../../workbench/browser/web.api.js';

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
		// On mobile, we always reuse the same window (single-window model)
		const params = new URLSearchParams();

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

		if (options?.reuse) {
			mainWindow.location.href = url;
		} else {
			mainWindow.location.href = url;
		}

		return true;
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

	// Build construction options for the mobile workbench
	const options: IWorkbenchConstructionOptions = {
		...config,
		workspaceProvider,
		productConfiguration: {
			...product,
			...config.productConfiguration,
		}
	};

	// Create the mobile workbench — services and contributions are already
	// registered via the static import of mobile.web.main.js above.
	const { create } = await import('../../workbench/browser/web.factory.js');
	create(mainWindow.document.body, options);

})();
