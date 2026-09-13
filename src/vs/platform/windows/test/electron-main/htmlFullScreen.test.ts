/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import type { BrowserWindow, WebContents } from 'electron';
import { stub } from 'sinon';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { registerInPlaceHtmlFullScreen } from '../../electron-main/htmlFullScreen.js';

suite('In-place HTML fullscreen', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(native = false, simple = false) {
		const events = new EventEmitter();
		const calls: boolean[] = [];
		const state = { native, simple, destroyed: false };
		const webContents = upcastPartial<WebContents>({
			on: stub().callsFake((event: string, listener: () => void) => events.on(event, listener)),
			removeListener: stub().callsFake((event: string, listener: () => void) => events.removeListener(event, listener)),
			focus: () => { },
		});
		const window = upcastPartial<BrowserWindow>({
			webContents,
			isFullScreen: () => state.native,
			isSimpleFullScreen: () => state.simple,
			isDestroyed: () => state.destroyed,
			setSimpleFullScreen: value => {
				calls.push(value);
				state.simple = value;
			},
		});
		const registration = store.add(registerInPlaceHtmlFullScreen(window));
		return { events, calls, state, registration };
	}

	test('content fullscreen enters the current Space and restores the window once', () => {
		const { events, calls, state } = setup();
		events.emit('enter-html-full-screen');
		events.emit('enter-html-full-screen');
		assert.deepStrictEqual({ calls: [...calls], state: { ...state } }, {
			calls: [true], state: { native: false, simple: true, destroyed: false },
		});
		events.emit('leave-html-full-screen');
		events.emit('leave-html-full-screen');
		assert.deepStrictEqual(calls, [true, false]);
	});

	test('preserves pre-existing native and simple fullscreen', () => {
		const results = [[true, false], [false, true]].map(([native, simple]) => {
			const { events, calls, state, registration } = setup(native, simple);
			events.emit('enter-html-full-screen');
			events.emit('leave-html-full-screen');
			registration.dispose();
			return { calls, state };
		});
		assert.deepStrictEqual(results, [
			{ calls: [], state: { native: true, simple: false, destroyed: false } },
			{ calls: [], state: { native: false, simple: true, destroyed: false } },
		]);
	});

	test('restores its fullscreen state after a renderer crash', () => {
		const { events, calls, registration } = setup();
		events.emit('enter-html-full-screen');
		events.emit('render-process-gone');
		registration.dispose();
		assert.deepStrictEqual({ calls, listeners: events.eventNames() }, { calls: [true, false], listeners: [] });
	});

	test('disposal restores owned fullscreen and removes listeners', () => {
		const { events, calls, registration } = setup();
		events.emit('enter-html-full-screen');
		registration.dispose();
		assert.deepStrictEqual({ calls, listeners: events.eventNames() }, { calls: [true, false], listeners: [] });
	});

	test('does not touch a destroyed window or undo a later native fullscreen choice', () => {
		const results = ['destroyed', 'native'].map(change => {
			const { events, calls, state, registration } = setup();
			events.emit('enter-html-full-screen');
			if (change === 'destroyed') {
				state.destroyed = true;
			} else {
				state.native = true;
				state.simple = false;
			}
			events.emit('leave-html-full-screen');
			registration.dispose();
			return calls;
		});
		assert.deepStrictEqual(results, [[true], [true]]);
	});
});
