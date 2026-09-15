/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ActionType, type ActionEnvelope } from '../../../common/state/sessionActions.js';
import { buildChatUri } from '../../../common/state/sessionState.js';
import type { AhpNotification } from '../../../common/state/sessionProtocol.js';
import { assertIdleVideoHasNoTarget, isVideoCancellationAcknowledgement } from './copilotComputerUseVideoAhpTestPeer.js';
import type { NativeVideoBatch } from './copilotComputerUseVideoTestUtils.js';

suite('Computer Use AHP video predicates (no transport)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const expected = {
		chat: buildChatUri('copilotcli:/fixture', 'target'),
		turnId: 'target-turn',
		clientId: 'fixture-client',
		clientSeq: 7,
	};
	const cancellation: ActionEnvelope = {
		channel: expected.chat,
		serverSeq: 1,
		origin: { clientId: expected.clientId, clientSeq: expected.clientSeq },
		action: { type: ActionType.ChatTurnCancelled, turnId: expected.turnId, duration: 100 },
	};
	const notification = (envelope: ActionEnvelope): AhpNotification => ({ jsonrpc: '2.0', method: 'action', params: envelope });
	const idle: NativeVideoBatch = { version: 1, status: 'idle', frames: [], dropped: false };

	test('accepts only the acknowledgement of the issued exact-chat cancellation', () => {
		assert.strictEqual(isVideoCancellationAcknowledgement(notification(cancellation), expected), true);
	});

	test('rejects other chats, sessions, turns, clients, sequences, server actions and rejected echoes', () => {
		const mismatches: ActionEnvelope[] = [
			{ ...cancellation, channel: buildChatUri('copilotcli:/fixture', 'guard') },
			{ ...cancellation, channel: buildChatUri('copilotcli:/other-session', 'target') },
			{ ...cancellation, action: { type: ActionType.ChatTurnCancelled, turnId: 'other-turn', duration: 100 } },
			{ ...cancellation, origin: { clientId: 'other-client', clientSeq: expected.clientSeq } },
			{ ...cancellation, origin: { clientId: expected.clientId, clientSeq: expected.clientSeq - 1 } },
			{ ...cancellation, origin: undefined },
			{ ...cancellation, rejectionReason: 'rejected fixture action' },
		];
		assert.deepStrictEqual(mismatches.map(envelope => isVideoCancellationAcknowledgement(notification(envelope), expected)), Array(mismatches.length).fill(false));
	});

	test('rejects unrelated actions and non-action notifications', () => {
		const delta: ActionEnvelope = {
			...cancellation,
			action: { type: ActionType.ChatDelta, turnId: expected.turnId, partId: 'fixture-part', content: 'fixture heartbeat' },
		};
		assert.deepStrictEqual([
			isVideoCancellationAcknowledgement(notification(delta), expected),
			isVideoCancellationAcknowledgement({ jsonrpc: '2.0', method: 'unsubscribe', params: { channel: expected.chat } }, expected),
		], [false, false]);
	});

	test('accepts only the uninitialized sibling video state', () => {
		assert.doesNotThrow(() => assertIdleVideoHasNoTarget(idle));
	});

	test('rejects sibling stream/target metadata and media, even with idle status', () => {
		const invalid: NativeVideoBatch[] = [
			{ ...idle, streamId: 'other-chat-stream' },
			{ ...idle, target: { app: 'fixture-app', windowId: 42, title: 'fixture target' } },
			{ ...idle, config: { codec: 'avc1.42001f', codedWidth: 2, codedHeight: 2, description: 'synthetic-not-media' } },
			{ ...idle, frames: [{ sequence: 1, timestamp: 0, duration: 33_334, keyFrame: true, data: 'synthetic-not-media' }] },
			{ ...idle, status: 'starting' },
			{ ...idle, status: 'live' },
			{ ...idle, status: 'stopped' },
		];
		for (const batch of invalid) {
			assert.throws(() => assertIdleVideoHasNoTarget(batch), /must not inherit/);
		}
	});
});
