/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { registerColor } from '../../platform/theme/common/colorUtils.js';
import { contrastBorder } from '../../platform/theme/common/colorRegistry.js';
import { Color } from '../../base/common/color.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND } from '../../workbench/common/theme.js';

// Connection bar colors
export const mobileConnectionBarBackground = registerColor(
	'mobileConnectionBar.background',
	SIDE_BAR_BACKGROUND,
	localize('mobileConnectionBar.background', 'Background color of the connection bar in the mobile app.')
);

export const mobileConnectionBarForeground = registerColor(
	'mobileConnectionBar.foreground',
	SIDE_BAR_FOREGROUND,
	localize('mobileConnectionBar.foreground', 'Foreground color of the connection bar in the mobile app.')
);

export const mobileConnectionBarBorder = registerColor(
	'mobileConnectionBar.border',
	{ dark: Color.fromHex('#808080').transparent(0.35), light: Color.fromHex('#808080').transparent(0.35), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('mobileConnectionBar.border', 'Border color of the connection bar in the mobile app.')
);

// Navigation bar colors
export const mobileNavigationBarBackground = registerColor(
	'mobileNavigationBar.background',
	SIDE_BAR_BACKGROUND,
	localize('mobileNavigationBar.background', 'Background color of the bottom navigation bar in the mobile app.')
);

export const mobileNavigationBarForeground = registerColor(
	'mobileNavigationBar.foreground',
	SIDE_BAR_FOREGROUND,
	localize('mobileNavigationBar.foreground', 'Foreground color of the bottom navigation bar in the mobile app.')
);

export const mobileNavigationBarBorder = registerColor(
	'mobileNavigationBar.border',
	{ dark: Color.fromHex('#808080').transparent(0.35), light: Color.fromHex('#808080').transparent(0.35), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('mobileNavigationBar.border', 'Border color of the bottom navigation bar in the mobile app.')
);

// Connection status indicator colors
export const mobileConnectionStatusConnected = registerColor(
	'mobileConnectionStatus.connected',
	{ dark: '#89D185', light: '#388A34', hcDark: '#89D185', hcLight: '#388A34' },
	localize('mobileConnectionStatus.connected', 'Color of the connection status indicator when connected.')
);

export const mobileConnectionStatusReconnecting = registerColor(
	'mobileConnectionStatus.reconnecting',
	{ dark: '#CCA700', light: '#BF8803', hcDark: '#CCA700', hcLight: '#BF8803' },
	localize('mobileConnectionStatus.reconnecting', 'Color of the connection status indicator when reconnecting.')
);

export const mobileConnectionStatusDisconnected = registerColor(
	'mobileConnectionStatus.disconnected',
	{ dark: '#F48771', light: '#E51400', hcDark: '#F48771', hcLight: '#E51400' },
	localize('mobileConnectionStatus.disconnected', 'Color of the connection status indicator when disconnected.')
);
