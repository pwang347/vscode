/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../../browser/menus.js';
import { ISessionContext } from '../../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IChat, ISessionCapabilities } from '../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ViewComputerUseAction } from '../../browser/computerUseActions.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { TestVideoSource } from './computerUseTestUtils.js';

suite('ViewComputerUseAction', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createSession(providerId: string, sessionId: string) {
		const chat = (id: string): IChat => upcastPartial<IChat>({
			resource: URI.from({ scheme: 'test-chat', authority: providerId, path: `/${id}` }),
			title: constObservable(id),
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

	test('gates both session header menus on AI enablement and source capability', () => {
		const items = [Menus.SessionBarToolbar, Menus.SessionHeaderContext]
			.map(menu => MenuRegistry.getMenuItems(menu).filter(isIMenuItem).find(item => item.command.id === 'sessions.viewComputerUse'));
		assert.deepStrictEqual(items.map(item => ({
			title: item?.command.title,
			capabilityGate: item?.when?.keys().includes('sessionSupportsComputerUseVideo'),
			aiGate: item?.when?.keys().some(key => key === 'chatIsEnabled'),
		})), Array.from({ length: 2 }, () => ({
			title: { value: 'View Computer Use', original: 'View Computer Use' },
			capabilityGate: true,
			aiGate: true,
		})));
	});
});
