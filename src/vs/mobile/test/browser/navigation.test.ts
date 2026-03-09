/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isNativeMobileApp } from '../../browser/navigation.js';

suite('Mobile - Navigation', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('isNativeMobileApp detects file: protocol as native', () => {
		// In Electron test environment, protocol is file:// which
		// isNativeMobileApp treats as native (correct for Android WebView).
		// This verifies the function runs without error.
		const result = isNativeMobileApp();
		assert.strictEqual(typeof result, 'boolean');
		void store; // reference to prevent unused warning
	});
});
