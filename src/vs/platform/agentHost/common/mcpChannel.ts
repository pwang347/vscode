/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { AgentSession } from './agent.js';
import { parseChatUri } from './state/sessionState.js';

/** Creates the MCP side channel for one exact host-side chat. */
export function buildMcpChannel(chatUri: URI, serverName: string): string {
	const chat = parseChatUri(chatUri);
	if (!chat) {
		throw new Error(`Malformed AHP chat URI: ${chatUri.toString()}`);
	}
	const providerId = AgentSession.provider(chat.session);
	if (!providerId) {
		throw new Error(`Malformed Agent Host session URI: ${chat.session}`);
	}
	return `mcp://${providerId}/${encodeURIComponent(chatUri.toString())}/${encodeURIComponent(serverName)}`;
}
