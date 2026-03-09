/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Re-export all native bridge and Capacitor plugin accessors from common/
 * so that consumers in `vs/mobile/browser/` and `vs/mobile/contrib/` can
 * import everything from one place.
 *
 * The actual implementations live in `vs/mobile/common/capacitorPlugins.ts`
 * to allow `vs/mobile/services/` to import them without layering violations.
 */
export {
	type IMobileNativeBridge,
	getMobileNativeBridge,
	hasBridgeMethod,
	type ICapacitorHaptics,
	type ICapacitorAppPlugin,
	type ICapacitorBrowserPlugin,
	getCapacitorHapticsPlugin,
	getCapacitorAppPlugin,
	getCapacitorBrowserPlugin,
} from '../common/capacitorPlugins.js';
