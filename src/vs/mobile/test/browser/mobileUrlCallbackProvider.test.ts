/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { MobileURLCallbackProvider } from '../../services/url/browser/mobileUrlCallbackProvider.js';
import { URI } from '../../../base/common/uri.js';

suite('Mobile - MobileURLCallbackProvider', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let provider: MobileURLCallbackProvider;

	setup(() => {
		provider = store.add(new MobileURLCallbackProvider('code-oss'));
	});

	test('create returns URI with the configured scheme', () => {
		const uri = provider.create({
			authority: 'vscode.github-authentication',
			path: '/did-authenticate',
		});

		assert.strictEqual(uri.scheme, 'code-oss');
		assert.strictEqual(uri.authority, 'callback');
	});

	test('create encodes components in query', () => {
		const uri = provider.create({
			scheme: 'vscode',
			authority: 'my-ext',
			path: '/callback',
			query: 'token=abc',
		});

		const query = uri.query;
		assert.ok(query.includes('vscode-scheme=vscode'));
		assert.ok(query.includes('vscode-authority=my-ext'));
		assert.ok(query.includes('vscode-path='));
		assert.ok(query.includes('vscode-query='));
	});

	test('create handles empty options', () => {
		const uri = provider.create({});
		assert.strictEqual(uri.scheme, 'code-oss');
		assert.strictEqual(uri.authority, 'callback');
		assert.strictEqual(uri.path, '/');
	});

	test('onCallback fires for valid URIs with matching scheme', async () => {
		const received: URI[] = [];
		store.add(provider.onCallback((uri: URI) => received.push(uri)));

		// Simulate the global callback (as the native app would call it)
		const callback = (globalThis as Record<string, unknown>).__mobileUrlCallback as (url: string) => void;
		assert.ok(typeof callback === 'function', 'global callback should be registered');

		callback('code-oss://vscode.github-authentication/did-authenticate?code=123');

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0].scheme, 'code-oss');
		assert.strictEqual(received[0].authority, 'vscode.github-authentication');
	});

	test('onCallback rejects URIs with wrong scheme', () => {
		const received: URI[] = [];
		store.add(provider.onCallback((uri: URI) => received.push(uri)));

		const callback = (globalThis as Record<string, unknown>).__mobileUrlCallback as (url: string) => void;

		// The provider logs a console.warn for rejected schemes — suppress it in tests
		const originalWarn = console.warn;
		console.warn = () => { /* expected warning */ };
		try {
			callback('https://evil.com/steal-tokens?code=123');
		} finally {
			console.warn = originalWarn;
		}

		assert.strictEqual(received.length, 0);
	});

	test('global callback is cleaned up on dispose', () => {
		provider.dispose();

		// After dispose, the global callback should be removed
		assert.strictEqual((globalThis as Record<string, unknown>).__mobileUrlCallback, undefined);
	});
});
