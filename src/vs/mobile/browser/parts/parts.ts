/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parts specific to the mobile workbench.
 */
export const enum MobileParts {
	CONNECTION_BAR = 'workbench.parts.mobile.connectionBar',
	NAVIGATION_BAR = 'workbench.parts.mobile.navigationBar',
	TOP_BAR = 'workbench.parts.mobile.topBar',
	DRAWER = 'workbench.parts.mobile.drawer',
}

/**
 * Navigation tabs available in the mobile workbench.
 */
export const enum MobileTab {
	Chat = 'chat',
	Files = 'files',
}

/**
 * Phases of the mobile app flow.
 */
export const enum MobilePhase {
	Welcome = 'welcome',
	WorkspacePicker = 'workspacePicker',
	Chat = 'chat',
}
