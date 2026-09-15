/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { vNumber, vObj, vOptionalProp, vString } from '../../../base/common/validation.js';
import { JsonRpcErrorCodes, ProtocolError } from './state/sessionProtocol.js';

export const ResourceReadRangeExtensionMethod = 'vscode/resourceReadRange';
export const ResourceReadRangeCapabilityMetaKey = 'vscode.resourceReadRange';
export const AGENT_HOST_RESOURCE_RANGE_MAX_BYTES = 1024 * 1024;
export const AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface IAgentHostResourceReadRangeParams {
	readonly channel: 'ahp-root://';
	readonly uri: string;
	readonly offset: number;
	readonly length: number;
	readonly expectedSize?: number;
	readonly expectedEtag?: string;
}

export interface IAgentHostResourceReadRangeResult {
	readonly encoding: 'base64';
	readonly data: string;
	readonly offset: number;
	readonly size: number;
	readonly etag: string;
	readonly eof: boolean;
}

const paramsValidator = vObj({
	channel: vString(),
	uri: vString(),
	offset: vNumber(),
	length: vNumber(),
	expectedSize: vOptionalProp(vNumber()),
	expectedEtag: vOptionalProp(vString()),
});

/** Bounds the extension before any provider activation, stat, allocation, or file read. */
export function parseResourceReadRangeParams(value: unknown): IAgentHostResourceReadRangeParams {
	const validated = paramsValidator.validate(value);
	if (validated.error) {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'Invalid bounded resource read parameters.');
	}
	const params = validated.content;
	if (params.channel !== 'ahp-root://' || !params.uri || params.uri.length > 4096
		|| !Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES
		|| !Number.isSafeInteger(params.length) || params.length < 0 || params.length > AGENT_HOST_RESOURCE_RANGE_MAX_BYTES
		|| params.expectedSize !== undefined && (!Number.isSafeInteger(params.expectedSize) || params.expectedSize < 0 || params.expectedSize > AGENT_HOST_RESOURCE_RANGE_MAX_FILE_BYTES)
		|| params.expectedEtag !== undefined && (!params.expectedEtag || params.expectedEtag.length > 256)) {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'Invalid bounded resource read parameters.');
	}
	let uri: URI;
	try {
		uri = URI.parse(params.uri, true);
	} catch {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'A valid local file URI is required.');
	}
	// URI.parse normalizes relative file paths, so also validate the original form.
	if (!params.uri.startsWith(`${Schemas.file}:/`) || /[?#]/.test(params.uri)
		|| uri.scheme !== Schemas.file || uri.authority || uri.query || uri.fragment
		|| !uri.path.startsWith('/') || /[\u0000-\u001F\u007F]/.test(uri.path)) {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, 'Only local file URIs without query or fragment are supported.');
	}
	return { ...params, channel: 'ahp-root://' };
}
