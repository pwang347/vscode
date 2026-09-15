/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { derived, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ChatInteractivity, getSessionStatusMessage, IChat, SessionRemoteConnectionStatus, SessionStatus } from '../../../services/sessions/common/session.js';

export interface IComputerUseActivity {
	readonly message: string;
	readonly active: boolean;
	/** Whether the agent supplied specific user-visible activity text. */
	readonly shared?: boolean;
}

/** Uses only the captured chat's shared activity summary, not its reasoning stream. */
export function createComputerUseActivity(chat: IChat, connection?: IObservable<SessionRemoteConnectionStatus | undefined>): IObservable<IComputerUseActivity> {
	return derived(reader => {
		const remote = connection?.read(reader);
		if (remote && remote.kind !== 'connected') {
			return { message: localize('computerUse.activityDisconnected', "Agent host disconnected. Activity is not live."), active: false };
		}
		if (chat.interactivity.read(reader) === ChatInteractivity.Hidden) {
			return { message: localize('computerUse.activityUnavailable', "Activity is unavailable for this chat."), active: false };
		}
		const status = chat.status.read(reader);
		const active = status === SessionStatus.InProgress;
		const description = chat.description.read(reader);
		const message = getSessionStatusMessage(status, description);
		if (message) {
			const text = (typeof message === 'string' ? message : renderAsPlaintext({ value: message.value.slice(0, 8192) })).trim();
			if (text) {
				return {
					message: text.length > 2000 ? localize('computerUse.activityTruncated', "{0}…", text.slice(0, 1999)) : text,
					active,
					...(description ? { shared: true } : {}),
				};
			}
		}
		const fallback = getSessionStatusMessage(status, undefined);
		if (typeof fallback === 'string') {
			return { message: fallback, active };
		}
		return {
			message: status === SessionStatus.Completed
				? localize('computerUse.activityCompleted', "The agent finished this turn.")
				: localize('computerUse.activityIdle', "Waiting for the agent to start."),
			active,
		};
	});
}
