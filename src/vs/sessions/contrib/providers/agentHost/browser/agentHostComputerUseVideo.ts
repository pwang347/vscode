/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError, getErrorMessage } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { vBoolean, vObj, vOptionalProp } from '../../../../../base/common/validation.js';
import { localize } from '../../../../../nls.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { buildMcpChannel } from '../../../../../platform/agentHost/common/mcpChannel.js';
import { IComputerUseSharedThought, IComputerUseVideoBatch, IComputerUseVideoCursor, ISessionComputerUseVideoSource, parseComputerUseVideoResource } from '../../../../services/sessions/common/computerUse.js';

const COMPUTER_USE_SERVER = 'computer-use';
const VIDEO_RESOURCE = 'computer-use://video/live';
const stopResultValidator = vObj({ isError: vOptionalProp(vBoolean()) });

interface IAgentHostComputerUseVideoOptions {
	readonly hostLabel: string;
	readonly chat: URI;
	readonly connection: IAgentConnection;
	readonly thought?: IObservable<IComputerUseSharedThought | undefined>;
	readonly getConnection: () => IAgentConnection | undefined;
	readonly isEnabled?: () => boolean;
	readonly cancelChat: () => Promise<void>;
}

export class AgentHostComputerUseVideoSource extends Disposable implements ISessionComputerUseVideoSource {
	readonly hostLabel: string;
	readonly thought: IObservable<IComputerUseSharedThought | undefined>;
	private readonly _channel: string;

	constructor(private readonly _options: IAgentHostComputerUseVideoOptions) {
		super();
		this.hostLabel = _options.hostLabel;
		this.thought = _options.thought ?? constObservable(undefined);
		this._channel = buildMcpChannel(_options.chat, COMPUTER_USE_SERVER);
	}

	async read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		this._assertCanRead();
		if (cursor && (!cursor.streamId || cursor.streamId.length > 256 || !Number.isSafeInteger(cursor.after) || cursor.after < 0)) {
			throw new Error(localize('computerUse.invalidCursor', "The Computer Use video position is invalid."));
		}
		const uri = cursor ? `${VIDEO_RESOURCE}?streamId=${encodeURIComponent(cursor.streamId)}&after=${cursor.after}` : VIDEO_RESOURCE;
		const result = await raceCancellationError(this._options.connection.handleMcpRequest(this._channel, 'resources/read', { uri }), token);
		this._assertCanRead();
		return parseComputerUseVideoResource(result);
	}

	async stop(): Promise<void> {
		this._assertConnected();
		const results = await Promise.allSettled([
			this._stopNativeControl(),
			this._cancelChat(),
		]);
		const errors = results.flatMap(result => result.status === 'rejected' ? [getErrorMessage(result.reason)] : []);
		if (errors.length) {
			throw new Error(localize('computerUse.stopFailed', "Could not confirm that the agent stopped: {0}", errors.join('; ')));
		}
	}

	private async _cancelChat(): Promise<void> {
		this._assertConnected();
		await this._options.cancelChat();
		this._assertConnected();
	}

	private async _stopNativeControl(): Promise<void> {
		const response = await this._options.connection.handleMcpRequest(this._channel, 'tools/call', {
			name: 'stop_computer_use',
			arguments: {},
		});
		this._assertConnected();
		if (stopResultValidator.validateOrThrow(response).isError) {
			throw new Error(localize('computerUse.nativeStopFailed', "The native Computer Use service could not stop this session."));
		}
	}

	private _assertConnected(): void {
		if (this._store.isDisposed) {
			throw new CancellationError();
		}
		if (this._options.getConnection() !== this._options.connection) {
			throw new Error(localize('computerUse.hostDisconnected', "The selected agent host disconnected. Reopen the viewer after reconnecting."));
		}
	}

	private _assertCanRead(): void {
		this._assertConnected();
		if (this._options.isEnabled?.() === false) {
			throw new Error(localize('computerUse.disabled', "Computer Use has been disabled for this session."));
		}
	}
}
