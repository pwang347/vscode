/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Schemas } from '../../../../../base/common/network.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { serializeComputerUseRecordingSegment } from '../../../../../platform/agentHost/common/computerUseRecording.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../../browser/menus.js';
import { ISessionContext } from '../../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ChatInteractivity, IChat, ISessionCapabilities, SessionRemoteConnectionStatus, SessionStatus } from '../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { openComputerUseRecording, ViewComputerUseAction } from '../../browser/computerUseActions.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { ComputerUseRecordingSource } from '../../browser/computerUseRecordingSource.js';
import { TestVideoSource } from './computerUseTestUtils.js';

suite('ViewComputerUseAction', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createSession(providerId: string, sessionId: string) {
		const chat = (id: string): IChat => upcastPartial<IChat>({
			resource: URI.from({ scheme: 'test-chat', authority: providerId, path: `/${id}` }),
			title: constObservable(id),
			status: constObservable(SessionStatus.InProgress),
			description: constObservable(new MarkdownString().appendText(`Working in ${id}`)),
			interactivity: constObservable(ChatInteractivity.Full),
		});
		const activeChat = observableValue('activeChat', chat('chat-1'));
		const session = upcastPartial<IActiveSession>({
			providerId, sessionId, activeChat,
			title: constObservable(sessionId),
			capabilities: constObservable(upcastPartial<ISessionCapabilities>({ supportsComputerUseVideo: true })),
		});
		return { session, activeChat, chat };
	}

	function setup() {
		const instantiationService = store.add(new TestInstantiationService());
		const first = createSession('host-a', 'same-session-id');
		const second = createSession('host-b', 'same-session-id');
		const scoped = observableValue<IActiveSession | undefined>('scopedSession', first.session);
		const inputs: ComputerUseEditorInput[] = [];
		const sources: TestVideoSource[] = [];
		const calls: { providerId: string; sessionId: string; resource: URI }[] = [];
		let hidden = false;
		let openGate: DeferredPromise<void> | undefined;
		instantiationService.stub(ISessionContext, { session: scoped });
		instantiationService.stub(IChatEntitlementService, { get sentiment() { return { hidden }; } });
		instantiationService.stub(IEditorService, {
			editors: inputs,
			openEditor: async (input: EditorInput | IUntypedEditorInput): Promise<undefined> => {
				assert.ok(input instanceof ComputerUseEditorInput);
				if (!inputs.includes(input)) {
					inputs.push(store.add(input));
				}
				await openGate?.p;
				return undefined;
			},
		});
		instantiationService.stub(ISessionsProvidersService, {
			getProvider: <T extends ISessionsProvider>(providerId: string): T => {
				const provider = upcastPartial<ISessionsProvider>({
					getComputerUseVideoSource: (sessionId: string, resource: URI) => {
						calls.push({ providerId, sessionId, resource });
						const source = new TestVideoSource(providerId);
						sources.push(source);
						return source;
					},
				});
				return provider as T;
			},
		});
		return {
			first, second, scoped, inputs, sources, calls,
			run: (session?: IActiveSession) => instantiationService.invokeFunction(accessor => new ViewComputerUseAction().run(accessor, session)),
			set hidden(value: boolean) { hidden = value; },
			set openGate(value: DeferredPromise<void>) { openGate = value; },
		};
	}

	test('uses the invoking session instead of the unrelated active scope', async () => {
		const context = setup();
		context.scoped.set(context.second.session, undefined);
		await context.run(context.first.session);
		assert.deepStrictEqual(context.calls.map(call => [call.providerId, call.sessionId, call.resource.authority]), [['host-a', 'same-session-id', 'host-a']]);
	});

	test('captures the exact active chat before opening and cannot retarget while awaiting', async () => {
		const context = setup();
		const gate = new DeferredPromise<void>();
		context.openGate = gate;
		const captured = context.first.activeChat.get().resource;
		const opening = context.run();
		context.first.activeChat.set(context.first.chat('chat-2'), undefined);
		context.scoped.set(context.second.session, undefined);
		await gate.complete();
		await opening;
		await context.inputs[0].source.stop();
		assert.deepStrictEqual({
			provider: context.inputs[0].identity.providerId,
			chat: context.inputs[0].identity.chatResource,
			captured,
			stops: context.sources.map(source => source.stopCalls),
			reads: context.sources.map(source => source.calls.length),
		}, { provider: 'host-a', chat: captured, captured, stops: [1], reads: [0] });
	});

	test('activity follows the captured chat rather than a different active host or chat', async () => {
		const context = setup();
		const description = observableValue('capturedDescription', new MarkdownString().appendText('Reviewing the form'));
		context.first.activeChat.set({ ...context.first.activeChat.get(), description }, undefined);
		await context.run(context.first.session);
		const initial = context.inputs[0].activity.get().message;
		context.first.activeChat.set(context.first.chat('chat-2'), undefined);
		context.scoped.set(context.second.session, undefined);
		description.set(new MarkdownString('Clicking **Continue**'), undefined);
		assert.deepStrictEqual({
			initial,
			current: context.inputs[0].activity.get().message,
		}, { initial: 'Reviewing the form', current: 'Clicking Continue' });
	});

	test('activity respects completion, hidden chats and disconnected hosts', async () => {
		const context = setup();
		const status = observableValue('status', SessionStatus.InProgress);
		const description = observableValue('description', new MarkdownString(' '));
		const interactivity = observableValue('interactivity', ChatInteractivity.Full);
		const connection = observableValue<SessionRemoteConnectionStatus>('connection', { kind: 'connected' });
		context.first.activeChat.set({ ...context.first.activeChat.get(), status, description, interactivity }, undefined);
		await context.run({ ...context.first.session, remoteConnectionStatus: connection });
		const activity = context.inputs[0].activity;
		const values = [activity.get()];
		status.set(SessionStatus.Completed, undefined);
		values.push(activity.get());
		interactivity.set(ChatInteractivity.Hidden, undefined);
		values.push(activity.get());
		connection.set({ kind: 'reconnecting' }, undefined);
		values.push(activity.get());
		assert.deepStrictEqual(values, [
			{ message: 'Working...', active: true },
			{ message: 'The agent finished this turn.', active: false },
			{ message: 'Activity is unavailable for this chat.', active: false },
			{ message: 'Agent host disconnected. Activity is not live.', active: false },
		]);
	});

	test('keeps different remote hosts and chats independent and reuses only exact matches', async () => {
		const context = setup();
		await context.run(context.first.session);
		await context.run(context.second.session);
		await context.run(context.first.session);
		context.first.activeChat.set(context.first.chat('chat-2'), undefined);
		await context.run(context.first.session);
		assert.deepStrictEqual({
			bindings: context.calls.map(call => [call.providerId, call.resource.path]),
			count: context.inputs.length,
			matches: context.inputs[0].matches(context.inputs[1]),
		}, { bindings: [['host-a', '/chat-1'], ['host-b', '/chat-1'], ['host-a', '/chat-2']], count: 3, matches: false });
	});

	test('does not create sources when AI features are hidden or capability is absent', async () => {
		const context = setup();
		context.hidden = true;
		await context.run();
		context.hidden = false;
		await context.run({ ...context.first.session, capabilities: constObservable(upcastPartial<ISessionCapabilities>({ supportsComputerUseVideo: false })) });
		assert.deepStrictEqual({ calls: context.calls.length, inputs: context.inputs.length }, { calls: 0, inputs: 0 });
	});

	test('keeps View Computer Use out of the chat toolbar and gates its context-menu entry', () => {
		const toolbarItem = MenuRegistry.getMenuItems(Menus.SessionBarToolbar).filter(isIMenuItem)
			.find(item => item.command.id === 'sessions.viewComputerUse');
		const contextItem = MenuRegistry.getMenuItems(Menus.SessionHeaderContext).filter(isIMenuItem)
			.find(item => item.command.id === 'sessions.viewComputerUse');
		assert.deepStrictEqual({
			toolbarItem,
			contextItem: {
				title: contextItem?.command.title,
				capabilityGate: contextItem?.when?.keys().includes('sessionSupportsComputerUseVideo'),
				aiGate: contextItem?.when?.keys().some(key => key === 'chatIsEnabled'),
			},
		}, {
			toolbarItem: undefined,
			contextItem: {
				title: { value: 'View Computer Use', original: 'View Computer Use' },
				capabilityGate: true,
				aiGate: true,
			},
		});
	});

	test('registers annotation controls in the scoped player toolbar', () => {
		const ids = new Set([
			'sessions.computerUse.annotateFrame',
			'sessions.computerUse.annotationYellow',
			'sessions.computerUse.annotationPink',
			'sessions.computerUse.annotationBlue',
			'sessions.computerUse.annotationThin',
			'sessions.computerUse.annotationMedium',
			'sessions.computerUse.annotationThick',
			'sessions.computerUse.resetAnnotations',
			'sessions.computerUse.attachAnnotation',
			'sessions.computerUse.returnFromAnnotation',
		]);
		const controls = MenuRegistry.getMenuItems(Menus.ComputerUsePlayer).filter(isIMenuItem)
			.filter(item => ids.has(item.command.id))
			.map(item => item.command.id)
			.sort();

		assert.deepStrictEqual(controls, [...ids].sort());
	});

	test('opens a validated recording and restarts its reused editor from the beginning', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const root = URI.from({ scheme: Schemas.inMemory, path: '/recording' });
		await fileService.createFolder(root);
		const segment = serializeComputerUseRecordingSegment({
			streamId: 'stream',
			target: { app: 'Code', windowId: 7, title: 'Editor' },
			config: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
				description: Uint8Array.of(1, 2, 3, 4),
			},
			samples: [{
				sequence: 1,
				timestampUs: 0,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				data: Uint8Array.of(10),
			}],
		});
		await fileService.writeFile(URI.joinPath(root, 'segment-000001.gop'), VSBuffer.wrap(segment));
		const manifest = URI.joinPath(root, 'manifest.json');
		await fileService.writeFile(manifest, VSBuffer.fromString(JSON.stringify({
			version: 1,
			recordingId: 'recording-1',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 34,
			sizeBytes: segment.byteLength,
			trimmed: false,
			segments: [{ file: 'segment-000001.gop', startTimeMs: 0, durationMs: 34, sizeBytes: segment.byteLength, sampleCount: 1 }],
			gaps: [],
		})));
		const inputs: ComputerUseEditorInput[] = [];
		let openCalls = 0;
		const editorService = upcastPartial<IEditorService>({
			editors: inputs,
			openEditor: async (input: EditorInput | IUntypedEditorInput) => {
				assert.ok(input instanceof ComputerUseEditorInput);
				openCalls++;
				if (!inputs.includes(input)) {
					inputs.push(store.add(input));
				}
				return undefined;
			},
		});

		const attachmentChatResource = URI.parse('test-chat://host-a/chat-a');
		await openComputerUseRecording(manifest, editorService, fileService, 'Entered text in TextEdit', undefined, attachmentChatResource);
		const source = inputs[0].source as ComputerUseRecordingSource;
		await source.read(undefined, CancellationToken.None);
		source.seek(20);
		const beforeReplay = {
			ended: source.playbackEnded,
			positionMs: source.recordingPositionMs.get(),
		};
		await openComputerUseRecording(manifest, editorService, fileService, 'Entered text in TextEdit');
		const replayed = await source.read(undefined, CancellationToken.None);

		assert.deepStrictEqual({
			beforeReplay,
			inputs: inputs.length,
			openCalls,
			kind: inputs[0].source.kind,
			name: inputs[0].getName(),
			attachmentChatResource: inputs[0].attachmentChatResource?.toString(),
			replayed: replayed.frames?.map(frame => frame.sequence),
		}, {
			beforeReplay: {
				ended: false,
				positionMs: 20,
			},
			inputs: 1,
			openCalls: 2,
			kind: 'recording',
			name: 'Computer Use Recording: Entered text in TextEdit',
			attachmentChatResource: 'test-chat://host-a/chat-a',
			replayed: [1],
		});
	});
});
