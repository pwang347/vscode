/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionComputerUseInvocation } from '../../../services/sessions/common/computerUse.js';
import { ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import { openComputerUseViewer } from './computerUseActions.js';
import { ComputerUseEditorInput } from './computerUseEditorInput.js';

export class ComputerUseAutoOpenContribution extends Disposable {
	static readonly ID = 'workbench.contrib.computerUseAutoOpen';

	private readonly providerListeners = this._register(new DisposableMap<string>());
	private readonly opening = new Set<string>();
	private lastOpenedInvocationKey: string | undefined;

	constructor(
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		for (const provider of sessionsProvidersService.getProviders()) {
			this.registerProvider(provider);
		}
		this._register(sessionsProvidersService.onDidChangeProviders(event => {
			for (const provider of event.removed) {
				this.providerListeners.deleteAndDispose(provider.id);
			}
			for (const provider of event.added) {
				this.registerProvider(provider);
			}
		}));
	}

	private registerProvider(provider: ISessionsProvider): void {
		if (!provider.onDidInvokeComputerUseTool) {
			return;
		}
		this.providerListeners.set(provider.id, provider.onDidInvokeComputerUseTool(invocation => this.openViewer(provider, invocation)));
	}

	private openViewer(provider: ISessionsProvider, invocation: ISessionComputerUseInvocation): void {
		const session = this.sessionsService.activeSession.get();
		const chat = session?.activeChat.get();
		if (!session || session.providerId !== provider.id
			|| session.sessionId !== invocation.sessionId || !chat || !isEqual(chat.resource, invocation.chatResource)) {
			return;
		}
		const key = `${session.providerId}\0${session.sessionId}\0${chat.resource.toString()}`;
		const invocationKey = `${key}\0${invocation.turnId}`;
		if (this.lastOpenedInvocationKey === invocationKey) {
			return;
		}
		const existing = this.editorService.editors.find((input): input is ComputerUseEditorInput => input instanceof ComputerUseEditorInput && input.isFor({
			providerId: session.providerId,
			sessionId: session.sessionId,
			chatResource: chat.resource,
		}));
		if (this.opening.has(key)) {
			return;
		}
		this.lastOpenedInvocationKey = invocationKey;
		this.opening.add(key);
		const opening = existing
			? this.editorService.openEditor(existing, { pinned: true, revealIfOpened: true })
			: this.instantiationService.invokeFunction(accessor => openComputerUseViewer(accessor, session, chat));
		void opening
			.catch(error => {
				if (this.lastOpenedInvocationKey === invocationKey) {
					this.lastOpenedInvocationKey = undefined;
				}
				this.notificationService.error(localize('computerUse.autoOpenFailed', "Could not open the Computer Use viewer: {0}", toErrorMessage(error)));
			})
			.finally(() => this.opening.delete(key));
	}
}
