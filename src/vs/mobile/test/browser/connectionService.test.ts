/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ConnectionService } from '../../services/connection/browser/connectionService.js';
import { TestStorageService } from '../../../workbench/test/common/workbenchTestServices.js';
import { NullLogService } from '../../../platform/log/common/log.js';

suite('Mobile - ConnectionService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let connectionService: ConnectionService;
	let storageService: TestStorageService;

	setup(() => {
		storageService = store.add(new TestStorageService());
		connectionService = store.add(new ConnectionService(storageService, new NullLogService()));
	});

	test('initial state is disconnected with no server', () => {
		assert.strictEqual(connectionService.status, 'disconnected');
		assert.strictEqual(connectionService.currentServer, undefined);
		assert.strictEqual(connectionService.sessionEditable, true);
	});

	test('getSavedServers returns empty array initially', () => {
		assert.deepStrictEqual(connectionService.getSavedServers(), []);
	});

	test('saveServer stores and retrieves servers', () => {
		const server = { name: 'test', address: 'myhost', port: 9888 };
		connectionService.saveServer(server);

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].name, 'test');
		assert.strictEqual(saved[0].address, 'myhost');
		assert.strictEqual(saved[0].port, 9888);
	});

	test('saveServer strips connectionToken from persisted data', () => {
		const server = { name: 'test', address: 'myhost', port: 9888, connectionToken: 'secret-token' };
		connectionService.saveServer(server);

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].connectionToken, undefined);
	});

	test('saveServer deduplicates by address and port', () => {
		connectionService.saveServer({ name: 'v1', address: 'myhost', port: 9888 });
		connectionService.saveServer({ name: 'v2', address: 'myhost', port: 9888 });

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].name, 'v2');
	});

	test('saveServer allows same host with different ports', () => {
		connectionService.saveServer({ name: 'v1', address: 'myhost', port: 9888 });
		connectionService.saveServer({ name: 'v2', address: 'myhost', port: 8080 });

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 2);
	});

	test('removeServer removes by address and port', () => {
		connectionService.saveServer({ name: 'v1', address: 'myhost', port: 9888 });
		connectionService.saveServer({ name: 'v2', address: 'myhost', port: 8080 });

		connectionService.removeServer('myhost', 9888);

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].port, 8080);
	});

	test('removeServer does not remove non-matching port', () => {
		connectionService.saveServer({ name: 'v1', address: 'myhost', port: 9888 });

		connectionService.removeServer('myhost', 1234);

		const saved = connectionService.getSavedServers();
		assert.strictEqual(saved.length, 1);
	});

	test('initializeFromExternal sets server and status', () => {
		const server = { name: 'ext', address: 'external', port: 443 };
		connectionService.initializeFromExternal(server, false);

		assert.strictEqual(connectionService.status, 'connected');
		assert.strictEqual(connectionService.currentServer?.address, 'external');
		assert.strictEqual(connectionService.sessionEditable, false);
	});

	test('disconnect clears current server', () => {
		connectionService.initializeFromExternal({ name: 'x', address: 'a', port: 1 }, true);
		connectionService.disconnect();

		assert.strictEqual(connectionService.status, 'disconnected');
		assert.strictEqual(connectionService.currentServer, undefined);
	});

	test('getLastServer returns undefined initially', () => {
		assert.strictEqual(connectionService.getLastServer(), undefined);
	});

	test('onDidChangeStatus fires on status change', () => {
		const events: string[] = [];
		store.add(connectionService.onDidChangeStatus((s: string) => events.push(s)));

		connectionService.initializeFromExternal({ name: 'x', address: 'a', port: 1 }, true);
		connectionService.disconnect();

		assert.deepStrictEqual(events, ['connected', 'disconnected']);
	});
});
