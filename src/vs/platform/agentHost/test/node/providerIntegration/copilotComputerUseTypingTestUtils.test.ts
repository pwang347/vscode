/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { assertInterruptedTypingResult, assertPartialNativeTyping, assertTypingUnchangedAfterStop, nativeTypingStopTestsEnabled, typingPayloadLength, type ITypingSample } from './copilotComputerUseTypingTestUtils.js';

suite('Computer Use typing interruption observations (no desktop)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const sample: ITypingSample = {
		length: 32, matchesPrefix: true, inputEvents: 32, lastInputAt: 999, sampledAt: 1000,
		focused: true, selection: [32, 32],
	};

	test('requires a separate typing Stop opt-in in addition to both native video gates', () => {
		const video = { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' };
		assert.deepStrictEqual([
			nativeTypingStopTestsEnabled('win32', {}),
			nativeTypingStopTestsEnabled('win32', video),
			nativeTypingStopTestsEnabled('win32', { VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST: '1' }),
			nativeTypingStopTestsEnabled('win32', { ...video, VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST: '1' }),
			nativeTypingStopTestsEnabled('linux', { ...video, VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST: '1' }),
		], [false, false, false, true, false]);
	});

	test('requires actual native input events and an incomplete matching prefix', () => {
		assert.doesNotThrow(() => assertPartialNativeTyping(sample, typingPayloadLength));
		for (const invalid of [
			{ ...sample, length: 0 },
			{ ...sample, length: typingPayloadLength },
			{ ...sample, matchesPrefix: false },
			{ ...sample, inputEvents: 0 },
		]) {
			assert.throws(() => assertPartialNativeTyping(invalid, typingPayloadLength), /real, incomplete fixture prefix/);
		}
	});

	test('accepts an unchanged post-acknowledgement observation', () => {
		assert.doesNotThrow(() => assertTypingUnchangedAfterStop(sample, { ...sample, sampledAt: 3000 }, 1000));
	});

	test('rejects input events after the acknowledgement, even if a later sample is stable', () => {
		const late = { ...sample, lastInputAt: 1001, sampledAt: 1002 };
		assert.throws(() => assertTypingUnchangedAfterStop(late, late, 1000), /after Stop acknowledgement/);
	});

	test('rejects changed text, counters, selection, prefix or clock without restarting the quiet window', () => {
		for (const invalid of [
			{ ...sample, length: 33 },
			{ ...sample, inputEvents: 33 },
			{ ...sample, matchesPrefix: false },
			{ ...sample, selection: [0, 0] },
			{ ...sample, sampledAt: 999 },
		]) {
			assert.throws(() => assertTypingUnchangedAfterStop(sample, invalid, 1000), assert.AssertionError);
		}
	});

	test('allows an explicit cancellation result but does not hide unrelated native failures or media', () => {
		for (const text of ['Computer Use was stopped', 'native request cancelled']) {
			assert.doesNotThrow(() => assertInterruptedTypingResult({ isError: true, text, images: [] }));
		}
		assert.doesNotThrow(() => assertInterruptedTypingResult({ isError: false, text: 'dispatched_unverified', images: [] }));
		assert.throws(() => assertInterruptedTypingResult({ isError: true, text: 'unexpected native failure', images: [] }), /explicit Stop/);
		assert.throws(() => assertInterruptedTypingResult({ isError: false, text: '', images: [{ mimeType: 'image/png', data: 'synthetic-not-media' }] }), /must not return media/);
	});

});
