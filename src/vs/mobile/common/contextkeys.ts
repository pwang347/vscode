/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

//#region < --- Mobile App --- >

export const IsMobileAppContext = new RawContextKey<boolean>('isMobileApp', false, localize('isMobileApp', "Whether the app is running in mobile mode"));

//#endregion

//#region < --- App Phase --- >

export const MobilePhaseContext = new RawContextKey<string>('mobilePhase', 'welcome', localize('mobilePhase', "The current mobile app phase: welcome, workspacePicker, or chat"));

//#endregion

//#region < --- Connection --- >

export const MobileConnectionStatusContext = new RawContextKey<string>('mobileConnectionStatus', 'disconnected', localize('mobileConnectionStatus', "The current mobile connection status: connected, reconnecting, or disconnected"));
export const MobileSessionEditableContext = new RawContextKey<boolean>('mobileSessionEditable', true, localize('mobileSessionEditable', "Whether the mobile session connection can be edited by the user"));

//#endregion

//#region < --- Navigation --- >

export const MobileActiveTabContext = new RawContextKey<string>('mobileActiveTab', 'chat', localize('mobileActiveTab', "The currently active tab in the mobile navigation bar"));
export const MobileCanGoBackContext = new RawContextKey<boolean>('mobileCanGoBack', false, localize('mobileCanGoBack', "Whether the mobile navigation stack can go back"));

//#endregion

//#region < --- Drawer --- >

export const MobileDrawerOpenContext = new RawContextKey<boolean>('mobileDrawerOpen', false, localize('mobileDrawerOpen', "Whether the mobile drawer is currently open"));

//#endregion

//#region < --- Chat --- >

export const MobileChatBarFocusContext = new RawContextKey<boolean>('mobileChatBarFocus', false, localize('mobileChatBarFocus', "Whether the mobile chat bar has keyboard focus"));

//#endregion

//#region < --- Orientation --- >

export const MobileOrientationContext = new RawContextKey<string>('mobileOrientation', 'portrait', localize('mobileOrientation', "The current device orientation: portrait or landscape"));

//#endregion

//#region < --- Keyboard --- >

export const MobileKeyboardVisibleContext = new RawContextKey<boolean>('mobileKeyboardVisible', false, localize('mobileKeyboardVisible', "Whether the virtual keyboard is currently visible"));

//#endregion
