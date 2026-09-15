/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../../base/common/buffer.js';
import type { IComputerUseRecordingDecoderConfig, IComputerUseRecordingSample, IComputerUseRecordingTarget } from '../../../common/computerUseRecording.js';

export const COMPUTER_USE_VIDEO_RESOURCE = 'computer-use://video/live';

const MAX_RESOURCE_CONTENTS = 16;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BATCH_TEXT_BYTES = Math.ceil(MAX_BATCH_BYTES / 3) * 4 + 64 * 1024;
const MAX_FRAME_BASE64_LENGTH = Math.ceil(MAX_FRAME_BYTES / 3) * 4;
const MAX_CONFIG_BASE64_LENGTH = Math.ceil(16 * 1024 / 3) * 4;
const MAX_FRAMES = 60;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const AVC_CODEC_PATTERN = /^avc1\.[0-9a-f]{6}$/i;

export interface IComputerUseVideoCursor {
	readonly streamId: string;
	readonly after: number;
}

export interface IComputerUseVideoBatch {
	readonly status: 'idle' | 'starting' | 'live' | 'stopped' | 'permissionRequired' | 'error';
	readonly streamId?: string;
	readonly target?: IComputerUseRecordingTarget;
	readonly config?: IComputerUseRecordingDecoderConfig;
	readonly frames: readonly IComputerUseRecordingSample[];
	readonly dropped: boolean;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid Computer Use video ${name}.`);
	}
	return value as Record<string, unknown>;
}

function readInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Invalid Computer Use video ${key}.`);
	}
	return value as number;
}

function readString(record: Record<string, unknown>, key: string, maximumLength: number): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
		throw new Error(`Invalid Computer Use video ${key}.`);
	}
	return value;
}

function decodeBoundedBase64(value: unknown, maximumEncodedLength: number, maximumBytes: number, name: string): Uint8Array {
	if (typeof value !== 'string'
		|| value.length === 0
		|| value.length > maximumEncodedLength
		|| value.length % 4 !== 0
		|| !BASE64_PATTERN.test(value)) {
		throw new Error(`Invalid Computer Use video ${name}.`);
	}
	const decoded = decodeBase64(value);
	if (decoded.byteLength < 1 || decoded.byteLength > maximumBytes) {
		throw new Error(`Invalid Computer Use video ${name}.`);
	}
	return decoded.buffer;
}

function readTarget(value: unknown): IComputerUseRecordingTarget {
	const record = asRecord(value, 'target');
	return {
		app: readString(record, 'app', 1024),
		windowId: readInteger(record, 'windowId', 1, Number.MAX_SAFE_INTEGER),
		title: readString(record, 'title', 4096),
	};
}

function readConfig(value: unknown): IComputerUseRecordingDecoderConfig {
	const record = asRecord(value, 'decoder configuration');
	const codec = readString(record, 'codec', 32);
	const codedWidth = readInteger(record, 'codedWidth', 1, 4096);
	const codedHeight = readInteger(record, 'codedHeight', 1, 4096);
	if (!AVC_CODEC_PATTERN.test(codec) || codedWidth * codedHeight > 1920 * 1080) {
		throw new Error('Invalid Computer Use video decoder configuration.');
	}
	return {
		codec,
		codedWidth,
		codedHeight,
		description: decodeBoundedBase64(record.description, MAX_CONFIG_BASE64_LENGTH, 16 * 1024, 'decoder description'),
	};
}

function readFrame(value: unknown): IComputerUseRecordingSample {
	const record = asRecord(value, 'frame');
	const keyFrame = record.keyFrame;
	if (typeof keyFrame !== 'boolean') {
		throw new Error('Invalid Computer Use video keyframe flag.');
	}
	let focus;
	if (record.focus !== undefined) {
		const focusRecord = asRecord(record.focus, 'focus');
		const x = focusRecord.x;
		const y = focusRecord.y;
		if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1
			|| typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) {
			throw new Error('Invalid Computer Use video focus.');
		}
		focus = { x, y };
	}
	return {
		sequence: readInteger(record, 'sequence', 1, Number.MAX_SAFE_INTEGER),
		timestampUs: readInteger(record, 'timestamp', 0, Number.MAX_SAFE_INTEGER),
		durationUs: readInteger(record, 'duration', 1, 1_000_000),
		keyFrame,
		frameCount: 1,
		...(focus ? { focus } : {}),
		data: decodeBoundedBase64(record.data, MAX_FRAME_BASE64_LENGTH, MAX_FRAME_BYTES, 'frame data'),
	};
}

/** Parses the bounded MCP resource response and decodes transport base64 once. */
export function parseComputerUseVideoResource(value: unknown): IComputerUseVideoBatch {
	const resource = asRecord(value, 'resource response');
	if (!Array.isArray(resource.contents) || resource.contents.length > MAX_RESOURCE_CONTENTS) {
		throw new Error('Invalid Computer Use video resource contents.');
	}
	const content = resource.contents.map(item => asRecord(item, 'resource content')).find(item => {
		const uri = item.uri;
		return typeof uri === 'string' && /^computer-use:\/\/video\/live(?:\?|$)/.test(uri);
	});
	if (!content || content.mimeType !== 'application/json' || typeof content.text !== 'string' || content.text.length > MAX_BATCH_TEXT_BYTES) {
		throw new Error('Missing or oversized Computer Use video resource.');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content.text);
	} catch {
		throw new Error('Invalid Computer Use video resource JSON.');
	}
	const record = asRecord(parsed, 'batch');
	if (record.version !== 1) {
		throw new Error('Unsupported Computer Use video version.');
	}
	const status = record.status;
	if (status !== 'idle' && status !== 'starting' && status !== 'live' && status !== 'stopped' && status !== 'permissionRequired' && status !== 'error') {
		throw new Error('Invalid Computer Use video status.');
	}
	const dropped = record.dropped === undefined ? false : record.dropped;
	if (typeof dropped !== 'boolean') {
		throw new Error('Invalid Computer Use video dropped flag.');
	}
	if (status !== 'live') {
		if (Array.isArray(record.frames) && record.frames.length > 0) {
			throw new Error('Invalid frames on an inactive Computer Use video stream.');
		}
		return { status, frames: [], dropped };
	}

	const streamId = readString(record, 'streamId', 256);
	const target = readTarget(record.target);
	const config = readConfig(record.config);
	if (!Array.isArray(record.frames) || record.frames.length > MAX_FRAMES) {
		throw new Error('Invalid Computer Use video frames.');
	}
	const frames = record.frames.map(readFrame);
	let previousSequence = 0;
	let previousTimestamp = -1;
	let totalBytes = 0;
	for (const frame of frames) {
		totalBytes += frame.data.byteLength;
		if (frame.sequence <= previousSequence || frame.timestampUs < previousTimestamp || totalBytes > MAX_BATCH_BYTES) {
			throw new Error('Invalid or oversized Computer Use video frame sequence.');
		}
		previousSequence = frame.sequence;
		previousTimestamp = frame.timestampUs;
	}
	return { status, streamId, target, config, frames, dropped };
}
