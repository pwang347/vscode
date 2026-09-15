/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatInputRequestPurpose, withChatInputRequestPurpose } from '../../../common/meta/agentChatInputRequestMeta.js';
import { ChatInputQuestionKind, type ChatInputRequest } from '../../../common/state/protocol/channels-chat/state.js';
import { startRealServer, TestProtocolClient } from '../serverIntegrationTestHelpers.js';
import { ahpVideoTestsEnabled, isFixtureApplicationQuestion, liveVideoUri, nativeVideoTestsEnabled, parseVideoBatch, parseVideoResource, videoMaxBytes, videoReadUri } from './copilotComputerUseVideoTestUtils.js';
import { findFixtureWindow, FixtureConsent, parseApplicationRows, readNativeContent } from './copilotComputerUseWindowsTestUtils.js';

suite('Computer Use Windows video test contracts (no desktop)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fixtureTitle = 'vscode-native-00000000-0000-4000-8000-000000000001 target';
	const target = { app: 'process:fixture.exe', name: 'Fixture Browser', window: 42, title: fixtureTitle, running: true };
	const config = {
		codec: 'avc1.42001f', codedWidth: 640, codedHeight: 480,
		description: Buffer.from([1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1f, 1, 0, 1, 0x68]).toString('base64'),
	};
	const frame = { sequence: 1, timestamp: 0, duration: 33_334, keyFrame: true, data: Buffer.from([0, 0, 0, 2, 0x65, 0x88]).toString('base64') };
	const live = { version: 1, status: 'live', streamId: 'native-1', target: { app: target.name, windowId: target.window, title: fixtureTitle }, config, frames: [frame] };

	test('desktop capture requires Windows and both opt-ins, not the metadata-only video flag', () => {
		const cases: { platform: string; environment: NodeJS.ProcessEnv }[] = [
			{ platform: 'win32', environment: {} },
			{ platform: 'win32', environment: { VSCODE_COMPUTER_USE_NATIVE_TEST: '1' } },
			{ platform: 'win32', environment: { VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' } },
			{ platform: 'win32', environment: { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_VIDEO_TEST: '1' } },
			{ platform: 'linux', environment: { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' } },
			{ platform: 'darwin', environment: { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' } },
			{ platform: 'win32', environment: { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' } },
		];
		assert.deepStrictEqual(cases.map(({ platform, environment }) => nativeVideoTestsEnabled(platform, environment)), [false, false, false, false, false, false, true]);
	});

	test('the real AHP routing case requires its additional opt-in', () => {
		const native = { VSCODE_COMPUTER_USE_NATIVE_TEST: '1', VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST: '1' };
		assert.deepStrictEqual([
			ahpVideoTestsEnabled('win32', {}),
			ahpVideoTestsEnabled('win32', { VSCODE_COMPUTER_USE_VIDEO_AHP_TEST: '1' }),
			ahpVideoTestsEnabled('win32', native),
			ahpVideoTestsEnabled('win32', { ...native, VSCODE_COMPUTER_USE_VIDEO_AHP_TEST: '1' }),
			ahpVideoTestsEnabled('linux', { ...native, VSCODE_COMPUTER_USE_VIDEO_AHP_TEST: '1' }),
		], [false, false, false, true, false]);
	});

	test('authenticated test helpers reject invalid tokens before opening sockets or starting servers', async () => {
		for (const connectionToken of ['', 'invalid token', 'invalid?token']) {
			assert.throws(() => new TestProtocolClient(0, undefined, undefined, { connectionToken }), /test connection token/);
			await assert.rejects(startRealServer({ homeDir: 'unused-before-token-validation', connectionToken, mockLlm: true }), /test connection token/);
		}
	});

	test('native and AHP resource envelopes must preserve the exact video URI and JSON MIME type', () => {
		const text = '{"version":1,"status":"idle"}';
		assert.deepStrictEqual(parseVideoResource({ contents: [{ uri: liveVideoUri, mimeType: 'application/json', text }] }, liveVideoUri), {
			version: 1, status: 'idle', frames: [], dropped: false,
		});
		for (const contents of [
			[],
			[{ uri: 'computer-use://other', mimeType: 'application/json', text }],
			[{ uri: liveVideoUri, mimeType: 'image/png', text }],
			[{ uri: liveVideoUri, mimeType: 'application/json', blob: 'omitted' }],
		]) {
			assert.throws(() => parseVideoResource({ contents }, liveVideoUri), /payload omitted/);
		}
	});

	test('AHP consent accepts only the exact fixture application elicitation with a session-local choice', () => {
		const request = withChatInputRequestPurpose<ChatInputRequest>({
			id: 'fixture-input', message: `Copilot Computer Use wants to use ${target.name}.`,
			questions: [{ id: 'choice', title: 'choice', message: 'choice', kind: ChatInputQuestionKind.SingleSelect, options: [{ id: 'allow', label: 'Allow for This Session' }, { id: 'always', label: 'Always' }] }],
		}, ChatInputRequestPurpose.Elicitation);
		const invalid: ChatInputRequest[] = [
			withChatInputRequestPurpose(request, ChatInputRequestPurpose.AskUser),
			{ ...request, message: 'Use a different application?' },
			{ ...request, url: 'https://example.invalid/approval' },
			{ ...request, questions: [] },
			{ ...request, questions: [{ id: 'choice', title: 'choice', message: 'choice', kind: ChatInputQuestionKind.SingleSelect, options: [{ id: 'always', label: 'Always' }] }] },
			{ ...request, questions: [{ id: 'choice', title: 'choice', message: 'choice', kind: ChatInputQuestionKind.SingleSelect, allowFreeformInput: true, options: [{ id: 'allow', label: 'Allow' }] }] },
		];
		assert.deepStrictEqual([request, ...invalid].map(value => isFixtureApplicationQuestion(value, target)), [true, false, false, false, false, false, false]);
	});

	test('viewer URIs contain only validated stream and sequence cursors', () => {
		assert.deepStrictEqual([videoReadUri(), videoReadUri({ streamId: 'native_1-A', after: 12 })], [liveVideoUri, `${liveVideoUri}?streamId=native_1-A&after=12`]);
		for (const cursor of [{ streamId: 'native&window=42', after: 1 }, { streamId: 'native', after: -1 }, { streamId: 'native', after: 0.5 }]) {
			assert.throws(() => videoReadUri(cursor), /Invalid video cursor/);
		}
	});

	test('omitted empty frames and dropped flags are normalized without inventing media', () => {
		assert.deepStrictEqual(parseVideoBatch('{"version":1,"status":"idle"}'), {
			version: 1, status: 'idle', frames: [], dropped: false,
		});
	});

	test('validates an AVC wire envelope without claiming to decode its synthetic bytes', () => {
		const parsed = parseVideoBatch(JSON.stringify(live));
		assert.deepStrictEqual({
			version: parsed.version, status: parsed.status, streamId: parsed.streamId,
			dimensions: [parsed.config?.codedWidth, parsed.config?.codedHeight],
			frames: parsed.frames.map(({ sequence, timestamp, duration, keyFrame }) => ({ sequence, timestamp, duration, keyFrame })),
		}, { version: 1, status: 'live', streamId: 'native-1', dimensions: [640, 480], frames: [{ sequence: 1, timestamp: 0, duration: 33_334, keyFrame: true }] });
	});

	test('rejects invalid status, identity, dimensions, codec and inactive payloads', () => {
		for (const value of [
			{ ...live, version: 2 },
			{ ...live, status: 'unknown' },
			{ ...live, status: 'stopped' },
			{ ...live, status: 'permissionRequired' },
			{ ...live, target: { ...live.target, windowId: -1 } },
			{ ...live, streamId: 'native&window=42' },
			{ ...live, config: undefined },
			{ ...live, config: { ...config, codec: 'vp8' } },
			{ ...live, config: { ...config, codedWidth: 1282 } },
			{ ...live, config: { ...config, codedHeight: 722 } },
			{ ...live, config: { ...config, codedWidth: 639 } },
		]) {
			assert.throws(() => parseVideoBatch(JSON.stringify(value)), assert.AssertionError);
		}
	});

	test('rejects malformed avcC, Annex B, empty frames and incorrect keyframe flags', () => {
		for (const value of [
			{ ...live, config: { ...config, description: 'not base64' } },
			{ ...live, config: { ...config, description: Buffer.from([1, 0x42, 0, 0x1f, 0xfe]).toString('base64') } },
			{ ...live, config: { ...config, codec: 'avc1.64001f' } },
			{ ...live, frames: [{ ...frame, data: '' }] },
			{ ...live, frames: [{ ...frame, data: Buffer.from([0, 0, 1, 0x65, 0x88]).toString('base64') }] },
			{ ...live, frames: [{ ...frame, keyFrame: false }] },
			{ ...live, dropped: true, frames: [{ ...frame, keyFrame: false, data: Buffer.from([0, 0, 0, 2, 0x41, 0x88]).toString('base64') }] },
		]) {
			assert.throws(() => parseVideoBatch(JSON.stringify(value)), assert.AssertionError);
		}
	});

	test('requires increasing integer sequences and microsecond timestamps with positive duration', () => {
		for (const invalid of [
			{ ...frame, sequence: 0 },
			{ ...frame, timestamp: -1 },
			{ ...frame, timestamp: 0.5 },
			{ ...frame, duration: 0 },
			{ ...frame, sequence: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			assert.throws(() => parseVideoBatch(JSON.stringify({ ...live, frames: [invalid] })), assert.AssertionError);
		}
		assert.throws(() => parseVideoBatch(JSON.stringify({ ...live, frames: [frame, frame] })), /sequences and microsecond timestamps/);
	});

	test('checks the exact 60-frame and 1 MiB encoded byte limits, including avcC', () => {
		const frames = Array.from({ length: 60 }, (_, index) => ({ ...frame, sequence: index + 1, timestamp: index * 33_334 }));
		assert.strictEqual(parseVideoBatch(JSON.stringify({ ...live, frames })).frames.length, 60);
		assert.throws(() => parseVideoBatch(JSON.stringify({ ...live, frames: [...frames, { ...frame, sequence: 61, timestamp: 60 * 33_334 }] })), /at most 60/);
		const accessUnit = Buffer.alloc(videoMaxBytes - Buffer.from(config.description, 'base64').length);
		accessUnit.writeUInt32BE(accessUnit.length - 4);
		accessUnit[4] = 0x65;
		const atLimit = { ...live, frames: [{ ...frame, data: accessUnit.toString('base64') }] };
		assert.strictEqual(parseVideoBatch(JSON.stringify(atLimit)).frames.length, 1);
		const overLimit = Buffer.concat([accessUnit, Buffer.from([0])]);
		overLimit.writeUInt32BE(overLimit.length - 4);
		assert.throws(() => parseVideoBatch(JSON.stringify({ ...live, frames: [{ ...frame, data: overLimit.toString('base64') }] })), /1 MiB/);
	});

	test('malformed wire data never appears in diagnostics', () => {
		const privatePayload = 'PRIVATE_PAYLOAD_DO_NOT_LOG';
		try {
			parseVideoBatch(privatePayload);
			assert.fail('Malformed JSON must fail');
		} catch (error) {
			assert.ok(error instanceof Error && error.message === 'Native video must return JSON (payload omitted)' && !error.message.includes(privatePayload));
		}
	});

	test('shared discovery accepts exact known Edge captions, never substring matches', () => {
		const suffixes = ['', ' - Microsoft Edge', ' - Profile 1 - Microsoft\u200b Edge', ' - Work - Microsoft\u200b Edge'];
		assert.deepStrictEqual(suffixes.map(suffix => findFixtureWindow([{ ...target, title: fixtureTitle + suffix }], fixtureTitle, 'msedge').window), [42, 42, 42, 42]);
		for (const title of [`prefix ${fixtureTitle}`, `${fixtureTitle} - Unrecognized Browser`, `${fixtureTitle} extra`]) {
			assert.throws(() => findFixtureWindow([{ ...target, title }], fixtureTitle, 'msedge'), /Exactly one/);
		}
		assert.throws(() => findFixtureWindow([target, target], fixtureTitle, 'msedge'), /Exactly one/);
		assert.throws(() => parseApplicationRows('unrelated private app listing'), /listing omitted/);
	});

	test('shared consent keeps exact source/session/target checks and session-local choices', () => {
		const consent = new FixtureConsent(false);
		consent.sessionId = 'fixture-session';
		consent.target = target;
		consent.activeOperation = { app: target.app, window: target.window, tool: 'get_window_state' };
		const prompt = {
			sessionId: 'fixture-session', elicitationSource: 'computer-use',
			message: `Copilot Computer Use wants to use ${target.name}.`,
			requestedSchema: { type: 'object' as const, properties: { choice: { type: 'string' as const, enum: ['allow', 'always', 'deny'] } } },
		};
		assert.deepStrictEqual([
			consent.respond(prompt),
			consent.respond({ ...prompt, sessionId: 'other-session' }),
			consent.respond({ ...prompt, elicitationSource: 'other-server' }),
			consent.respond({ ...prompt, message: 'Allow another application?' }),
			consent.respond({ ...prompt, requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['always'] } } } }),
		], [
			{ action: 'accept', content: { choice: 'allow' } },
			{ action: 'decline' }, { action: 'decline' }, { action: 'decline' }, { action: 'decline' },
		]);
	});

	test('shared native result reader preserves refusal and image results without logging payloads', () => {
		assert.deepStrictEqual(readNativeContent({ isError: true, content: [{ type: 'text', text: 'Fixture refusal' }] }), {
			isError: true, text: 'Fixture refusal', images: [],
		});
		assert.deepStrictEqual(readNativeContent({ content: [{ type: 'image', mimeType: 'image/png', data: 'fixture-only' }] }), {
			isError: false, text: '', images: [{ mimeType: 'image/png', data: 'fixture-only' }],
		});
	});

	test('shared consent still allows native foreground fallback only for an exact active fixture action', () => {
		const consent = new FixtureConsent(false);
		consent.sessionId = 'fixture-session';
		consent.target = target;
		consent.activeOperation = { app: target.app, window: target.window, tool: 'get_window_state' };
		const prompt = {
			sessionId: 'fixture-session', elicitationSource: 'computer-use',
			message: 'Computer use can\'t finish this action in the background. Allow foreground actions?',
			requestedSchema: { type: 'object' as const, properties: { choice: { type: 'string' as const, enum: ['allow_foreground', 'deny'] } } },
		};
		const perception = consent.respond(prompt);
		consent.activeOperation = { app: target.app, window: target.window, tool: 'click' };
		const click = consent.respond(prompt);
		consent.activeOperation = { app: target.app, window: target.window + 1, tool: 'click' };
		const otherWindow = consent.respond(prompt);
		assert.deepStrictEqual([perception, click, otherWindow], [
			{ action: 'decline' }, { action: 'accept', content: { choice: 'allow_foreground' } }, { action: 'decline' },
		]);
	});

	test('shared negative-consent fixture still declines an otherwise valid application prompt', () => {
		const consent = new FixtureConsent(true);
		consent.sessionId = 'fixture-session';
		consent.target = target;
		consent.activeOperation = { app: target.app, window: target.window, tool: 'get_window_state' };
		const result = consent.respond({
			sessionId: 'fixture-session', elicitationSource: 'computer-use',
			message: `Allow Copilot Computer Use to use ${target.name}?`,
			requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['allow', 'always', 'deny'] } } },
		});
		assert.deepStrictEqual({ result, counts: consent.counts }, {
			result: { action: 'decline' },
			counts: { appAllowed: 0, appDeclined: 1, foregroundAllowed: 0, unexpected: 0, permissions: 0 },
		});
	});
});
