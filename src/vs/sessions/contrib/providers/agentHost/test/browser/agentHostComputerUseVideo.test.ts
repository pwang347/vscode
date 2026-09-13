/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import { buildMcpChannel } from '../../../../../../platform/agentHost/common/mcpChannel.js';
import { buildChatUri, buildDefaultChatUri } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostComputerUseVideoSource } from '../../browser/agentHostComputerUseVideo.js';

const idleResource = { contents: [{ uri: 'computer-use://video/live', mimeType: 'application/json', text: '{"version":1,"status":"idle"}' }] };

class VideoConnection extends mock<IAgentConnection>() {
	readonly calls: { channel: string; method: string; params: Record<string, unknown> | undefined }[] = [];
	readBarrier: DeferredPromise<unknown> | undefined;
	stopError = false;

	override async handleMcpRequest(channel: string, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
		this.calls.push({ channel, method, params });
		return method === 'resources/read' ? this.readBarrier?.p ?? idleResource : { isError: this.stopError };
	}
}

suite('Agent Host Computer Use video routing', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps identical chat identifiers on different hosts separate', async () => {
		const chat = URI.parse(buildDefaultChatUri('copilotcli:/same-id'));
		const connections = [new VideoConnection(), new VideoConnection()];
		const sources = connections.map((connection, index) => store.add(new AgentHostComputerUseVideoSource({
			hostLabel: `Host ${index}`,
			chat,
			connection,
			getConnection: () => connection,
			cancelChat: async () => { },
		})));
		await sources[0].read(undefined, CancellationToken.None);
		await sources[1].read({ streamId: 'second stream', after: 6 }, CancellationToken.None);

		assert.deepStrictEqual(connections.map(connection => connection.calls), [
			[{ channel: buildMcpChannel(chat, 'computer-use'), method: 'resources/read', params: { uri: 'computer-use://video/live' } }],
			[{ channel: buildMcpChannel(chat, 'computer-use'), method: 'resources/read', params: { uri: 'computer-use://video/live?streamId=second%20stream&after=6' } }],
		]);
	});

	test('stops the exact peer chat and its native control, even without reading video', async () => {
		const connection = new VideoConnection();
		const chat = URI.parse(buildChatUri('copilotcli:/session', 'peer'));
		const cancelled: string[] = [];
		const source = store.add(new AgentHostComputerUseVideoSource({
			hostLabel: 'Remote Mac',
			chat,
			connection,
			getConnection: () => connection,
			cancelChat: async () => { cancelled.push(chat.toString()); },
		}));

		await source.stop();

		assert.deepStrictEqual({
			cancelled,
			calls: connection.calls,
		}, {
			cancelled: [chat.toString()],
			calls: [{ channel: buildMcpChannel(chat, 'computer-use'), method: 'tools/call', params: { name: 'stop_computer_use', arguments: {} } }],
		});
	});

	test('never silently retargets a viewer after its host connection changes', async () => {
		const original = new VideoConnection();
		const replacement = new VideoConnection();
		let current: IAgentConnection = original;
		const source = store.add(new AgentHostComputerUseVideoSource({
			hostLabel: 'Original Host',
			chat: URI.parse(buildDefaultChatUri('copilotcli:/session')),
			connection: original,
			getConnection: () => current,
			cancelChat: async () => { throw new Error('Cancellation must not target a replacement host'); },
		}));
		current = replacement;
		await assert.rejects(source.read(undefined, CancellationToken.None), /disconnected/);
		await assert.rejects(source.stop(), /disconnected/);
		assert.deepStrictEqual([original.calls, replacement.calls], [[], []]);
	});

	test('cancels a hidden viewer and discards an in-flight media response', async () => {
		const connection = new VideoConnection();
		connection.readBarrier = new DeferredPromise();
		const source = store.add(new AgentHostComputerUseVideoSource({
			hostLabel: 'Host',
			chat: URI.parse(buildDefaultChatUri('copilotcli:/session')),
			connection,
			getConnection: () => connection,
			cancelChat: async () => { },
		}));
		const cancellation = store.add(new CancellationTokenSource());
		const reading = source.read(undefined, cancellation.token);
		cancellation.cancel();
		await assert.rejects(reading, isCancellationError);
		connection.readBarrier.complete(idleResource);
		source.dispose();
		await assert.rejects(source.read(undefined, CancellationToken.None), isCancellationError);
	});

	test('reports native stop failure but still sends chat cancellation', async () => {
		const connection = new VideoConnection();
		connection.stopError = true;
		let cancelled = false;
		const source = store.add(new AgentHostComputerUseVideoSource({
			hostLabel: 'Host',
			chat: URI.parse(buildDefaultChatUri('copilotcli:/session')),
			connection,
			getConnection: () => connection,
			cancelChat: async () => { cancelled = true; },
		}));

		await assert.rejects(source.stop(), /Could not confirm/);
		assert.strictEqual(cancelled, true);
	});

	test('does not restart a disabled native server just to view its video', async () => {
		const connection = new VideoConnection();
		let enabled = true;
		const source = store.add(new AgentHostComputerUseVideoSource({
			hostLabel: 'Host',
			chat: URI.parse(buildDefaultChatUri('copilotcli:/session')),
			connection,
			getConnection: () => connection,
			isEnabled: () => enabled,
			cancelChat: async () => { },
		}));
		await source.read(undefined, CancellationToken.None);
		enabled = false;
		await assert.rejects(source.read(undefined, CancellationToken.None), /disabled/);
		assert.strictEqual(connection.calls.length, 1);
	});
});
