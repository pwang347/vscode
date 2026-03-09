/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parts specific to the mobile workbench.
 */
export const enum MobileParts {
	TOP_BAR = 'workbench.parts.mobile.topBar',
	DRAWER = 'workbench.parts.mobile.drawer',
}

/**
 * Phases of the mobile app flow.
 */
export const enum MobilePhase {
	Welcome = 'welcome',
	WorkspacePicker = 'workspacePicker',
	Chat = 'chat',
}
