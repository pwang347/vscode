/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from '../../platform/actions/common/actions.js';

/**
 * Menu IDs for the Mobile workbench layout.
 */
export const MobileMenus = {
	ConnectionBarLeft: new MenuId('MobileConnectionBarLeft'),
	ConnectionBarRight: new MenuId('MobileConnectionBarRight'),
	NavigationBar: new MenuId('MobileNavigationBar'),
	ChatBarTitle: new MenuId('MobileChatBarTitle'),
	FileViewerTitle: new MenuId('MobileFileViewerTitle'),
	TerminalTitle: new MenuId('MobileTerminalTitle'),
	ConnectionSettings: new MenuId('MobileConnectionSettings'),
} as const;
