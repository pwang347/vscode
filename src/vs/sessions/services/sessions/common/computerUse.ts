/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { vArray, vBoolean, vEnum, vNumber, vObj, vOptionalProp, vString } from '../../../../base/common/validation.js';

export interface IComputerUseVideoCursor {
	readonly streamId: string;
	readonly after: number;
}

export interface IComputerUseVideoFrame {
	readonly sequence: number;
	readonly timestamp: number;
	readonly duration: number;
	readonly keyFrame: boolean;
	readonly data: string;
}

export interface IComputerUseVideoConfig {
	readonly codec: string;
	readonly codedWidth: number;
	readonly codedHeight: number;
	readonly description: string;
}

export interface IComputerUseVideoBatch {
	readonly version: 1;
	readonly status: 'idle' | 'starting' | 'live' | 'stopped' | 'permissionRequired' | 'error';
	readonly message?: string;
	readonly streamId?: string;
	readonly target?: { readonly app: string; readonly windowId: number; readonly title: string };
	readonly config?: IComputerUseVideoConfig;
	readonly frames?: readonly IComputerUseVideoFrame[];
	readonly dropped?: boolean;
}

/** A live, read-only video connection bound to one host, session, and chat. */
export interface ISessionComputerUseVideoSource extends IDisposable {
	readonly hostLabel: string;
	read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch>;
	/** Stops the represented agent's work, not merely video playback. */
	stop(): Promise<void>;
}

const resourceValidator = vObj({
	contents: vArray(vObj({
		uri: vString(),
		mimeType: vOptionalProp(vString()),
		text: vString(),
	})),
});

const batchValidator = vObj({
	version: vNumber(),
	status: vEnum('idle', 'starting', 'live', 'stopped', 'permissionRequired', 'error'),
	message: vOptionalProp(vString()),
	streamId: vOptionalProp(vString()),
	target: vOptionalProp(vObj({ app: vString(), windowId: vNumber(), title: vString() })),
	config: vOptionalProp(vObj({
		codec: vString(),
		codedWidth: vNumber(),
		codedHeight: vNumber(),
		description: vString(),
	})),
	frames: vOptionalProp(vArray(vObj({
		sequence: vNumber(),
		timestamp: vNumber(),
		duration: vNumber(),
		keyFrame: vBoolean(),
		data: vString(),
	}))),
	dropped: vOptionalProp(vBoolean()),
});

const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_ENCODED_BATCH_LENGTH = Math.ceil(MAX_BATCH_BYTES / 3) * 4;
const MAX_ENCODED_FRAME_LENGTH = Math.ceil(MAX_FRAME_BYTES / 3) * 4;

function isBase64(value: string, maximumLength: number): boolean {
	return value.length > 0 && value.length <= maximumLength && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** Validates bounded video data before handing untrusted host bytes to the decoder. */
export function parseComputerUseVideoResource(value: unknown): IComputerUseVideoBatch {
	const resource = resourceValidator.validateOrThrow(value);
	const content = resource.contents.find(item => /^computer-use:\/\/video\/live(?:\?|$)/.test(item.uri));
	if (!content || content.mimeType !== 'application/json' || content.text.length > MAX_ENCODED_BATCH_LENGTH + 64 * 1024) {
		throw new Error('Missing or oversized Computer Use video resource.');
	}
	const parsed: unknown = JSON.parse(content.text);
	const batch = batchValidator.validateOrThrow(parsed);
	if (batch.version !== 1 || (batch.streamId !== undefined && (!batch.streamId || batch.streamId.length > 256))) {
		throw new Error('Unsupported Computer Use video stream.');
	}
	if ((batch.message?.length ?? 0) > 4096 || (batch.status !== 'live' && (batch.frames?.length ?? 0) > 0)) {
		throw new Error('Invalid Computer Use video state.');
	}
	if (batch.status === 'live' && (!batch.streamId || !batch.target || !batch.config)) {
		throw new Error('The live Computer Use stream is missing its target or decoder configuration.');
	}
	if (batch.target && (!Number.isSafeInteger(batch.target.windowId) || batch.target.windowId < 1 || batch.target.app.length > 1024 || batch.target.title.length > 4096)) {
		throw new Error('Invalid Computer Use video target.');
	}
	if (batch.config) {
		const { codec, codedWidth, codedHeight, description } = batch.config;
		if (!/^avc1\.[0-9a-f]{6}$/i.test(codec)
			|| !Number.isSafeInteger(codedWidth) || !Number.isSafeInteger(codedHeight)
			|| codedWidth < 1 || codedHeight < 1 || codedWidth > 4096 || codedHeight > 4096
			|| codedWidth * codedHeight > 1920 * 1080
			|| !isBase64(description, 16 * 1024)) {
			throw new Error('Invalid Computer Use video decoder configuration.');
		}
	}
	let encodedBytes = 0;
	let previousSequence = 0;
	let previousTimestamp = -1;
	if ((batch.frames?.length ?? 0) > 60) {
		throw new Error('Too many Computer Use video frames in one batch.');
	}
	for (const frame of batch.frames ?? []) {
		encodedBytes += frame.data.length;
		if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= previousSequence
			|| !Number.isSafeInteger(frame.timestamp) || frame.timestamp < 0 || frame.timestamp < previousTimestamp
			|| !Number.isSafeInteger(frame.duration) || frame.duration < 1 || frame.duration > 1_000_000
			|| !isBase64(frame.data, MAX_ENCODED_FRAME_LENGTH) || encodedBytes > MAX_ENCODED_BATCH_LENGTH) {
			throw new Error('Invalid or oversized Computer Use video frame.');
		}
		previousSequence = frame.sequence;
		previousTimestamp = frame.timestamp;
	}
	return { ...batch, version: 1 };
}
