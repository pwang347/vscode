/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ChatInteractivity, IChat, ISessionCapabilities, SessionStatus } from '../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ComputerUseAutoOpenContribution } from '../../browser/computerUseAutoOpen.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { TestVideoSource } from './computerUseTestUtils.js';

suite('ComputerUseAutoOpenContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function chat(id: string): IChat {
		return upcastPartial<IChat>({
			resource: URI.from({ scheme: 'test-chat', authority: 'host-a', path: `/${id}` }),
			title: constObservable(id),
			status: constObservable(SessionStatus.InProgress),
			description: constObservable(undefined),
			interactivity: constObservable(ChatInteractivity.Full),
		});
	}

	test('opens the exact active chat once per turn and re-reveals an existing viewer', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const firstChat = chat('first');
		const secondChat = chat('second');
		const activeChat = observableValue('activeChat', firstChat);
		const activeSession = upcastPartial<IActiveSession>({
			providerId: 'host-a',
			sessionId: 'session-a',
			activeChat,
			title: constObservable('Session'),
			capabilities: constObservable(upcastPartial<ISessionCapabilities>({ supportsComputerUseVideo: true })),
		});
		const invocation = store.add(new Emitter<{ sessionId: string; chatResource: URI; turnId: string }>());
		const inputs: ComputerUseEditorInput[] = [];
		let openCount = 0;
		const provider = upcastPartial<ISessionsProvider>({
			id: 'host-a',
			onDidInvokeComputerUseTool: invocation.event,
			getComputerUseVideoSource: () => new TestVideoSource('Host A'),
		});
		instantiationService.stub(ISessionsProvidersService, upcastPartial<ISessionsProvidersService>({
			onDidChangeProviders: Event.None,
			getProviders: () => [provider],
			getProvider: <T extends ISessionsProvider>() => provider as T,
		}));
		instantiationService.stub(ISessionsService, upcastPartial<ISessionsService>({
			activeSession: observableValue<IActiveSession | undefined>('activeSession', activeSession),
		}));
		instantiationService.stub(IChatEntitlementService, upcastPartial<IChatEntitlementService>({
			sentiment: { hidden: false },
		}));
		instantiationService.stub(INotificationService, upcastPartial<INotificationService>({ error: () => undefined }));
		instantiationService.stub(IEditorService, upcastPartial<IEditorService>({
			get editors() { return inputs; },
			openEditor: async (input: EditorInput | IUntypedEditorInput): Promise<undefined> => {
				assert.ok(input instanceof ComputerUseEditorInput);
				openCount++;
				if (!inputs.includes(input)) {
					inputs.push(store.add(input));
				}
				return undefined;
			},
		}));
		store.add(instantiationService.createInstance(ComputerUseAutoOpenContribution));

		invocation.fire({ sessionId: 'other-session', chatResource: firstChat.resource, turnId: 'turn-1' });
		invocation.fire({ sessionId: 'session-a', chatResource: secondChat.resource, turnId: 'turn-1' });
		invocation.fire({ sessionId: 'session-a', chatResource: firstChat.resource, turnId: 'turn-1' });
		invocation.fire({ sessionId: 'session-a', chatResource: firstChat.resource, turnId: 'turn-1' });
		await timeout(0);
		invocation.fire({ sessionId: 'session-a', chatResource: firstChat.resource, turnId: 'turn-2' });
		await timeout(0);
		activeChat.set(secondChat, undefined);
		invocation.fire({ sessionId: 'session-a', chatResource: secondChat.resource, turnId: 'turn-1' });
		await timeout(0);

		assert.deepStrictEqual({
			openCount,
			chats: inputs.map(input => input.identity.chatResource.path),
		}, {
			openCount: 3,
			chats: ['/first', '/second'],
		});
	});
});
