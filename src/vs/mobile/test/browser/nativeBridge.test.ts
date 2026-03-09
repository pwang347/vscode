/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getMobileNativeBridge, hasBridgeMethod, getCapacitorHapticsPlugin, getCapacitorAppPlugin, getCapacitorBrowserPlugin } from '../../browser/nativeBridge.js';

suite('Mobile - NativeBridge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('getMobileNativeBridge returns undefined in test environment', () => {
		assert.strictEqual(getMobileNativeBridge(), undefined);
	});

	test('hasBridgeMethod returns false when bridge is unavailable', () => {
		assert.strictEqual(hasBridgeMethod('navigateToShell'), false);
		assert.strictEqual(hasBridgeMethod('minimizeApp'), false);
		assert.strictEqual(hasBridgeMethod('openExternal'), false);
	});

	test('getCapacitorHapticsPlugin returns undefined in test environment', () => {
		assert.strictEqual(getCapacitorHapticsPlugin(), undefined);
	});

	test('getCapacitorAppPlugin returns undefined in test environment', () => {
		assert.strictEqual(getCapacitorAppPlugin(), undefined);
	});

	test('getCapacitorBrowserPlugin returns undefined in test environment', () => {
		assert.strictEqual(getCapacitorBrowserPlugin(), undefined);
	});
});
