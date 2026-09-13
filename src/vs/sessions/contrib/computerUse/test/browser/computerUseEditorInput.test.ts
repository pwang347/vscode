/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ComputerUseEditorInput, IComputerUseViewerIdentity } from '../../browser/computerUseEditorInput.js';
import { TestVideoSource } from './computerUseTestUtils.js';

suite('ComputerUseEditorInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const chatResource = URI.from({ scheme: 'test-chat', authority: 'host-a', path: '/chat-1' });
	const identity: IComputerUseViewerIdentity = { providerId: 'remote-host-a', sessionId: 'session-1', chatResource };

	function createInput(binding = identity) {
		return store.add(new ComputerUseEditorInput(binding, constObservable('Session'), constObservable('Chat'), new TestVideoSource('Remote Mac')));
	}

	test('matches the captured provider, session and chat, not a global viewer', () => {
		const input = createInput();
		const matches = [
			createInput(),
			createInput({ ...identity, providerId: 'remote-host-b' }),
			createInput({ ...identity, sessionId: 'session-2' }),
			createInput({ ...identity, chatResource: chatResource.with({ path: '/chat-2' }) }),
		].map(other => input.matches(other));
		assert.deepStrictEqual(matches, [true, false, false, false]);
	});

	test('copies routing identity while following only the captured titles', () => {
		const binding = { ...identity };
		const sessionTitle = observableValue('sessionTitle', 'First session');
		const chatTitle = observableValue('chatTitle', 'Captured chat');
		const input = store.add(new ComputerUseEditorInput(binding, sessionTitle, chatTitle, new TestVideoSource('Host A')));
		binding.providerId = 'remote-host-b';
		binding.sessionId = 'session-2';
		binding.chatResource = chatResource.with({ path: '/different-chat' });
		sessionTitle.set('Renamed session', undefined);
		chatTitle.set('Renamed captured chat', undefined);
		assert.deepStrictEqual({
			captured: input.isFor(identity),
			retargeted: input.isFor(binding),
			title: input.getTitle(),
		}, { captured: true, retargeted: false, title: 'Computer Use: Renamed captured chat — Renamed session — Host A' });
	});

	test('is transient and releases the source without stopping the agent', () => {
		const input = createInput();
		const source = input.source as TestVideoSource;
		input.dispose();
		assert.deepStrictEqual({
			resource: input.resource,
			untyped: input.toUntyped(),
			reopenable: input.canReopen(),
			disposed: source.disposeCalls,
			stops: source.stopCalls,
		}, { resource: undefined, untyped: undefined, reopenable: false, disposed: 1, stops: 0 });
	});
});
