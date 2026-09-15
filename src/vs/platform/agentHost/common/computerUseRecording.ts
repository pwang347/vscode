/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';

export const COMPUTER_USE_RECORDING_FORMAT_VERSION = 1;
export const OPEN_COMPUTER_USE_RECORDING_COMMAND_ID = 'sessions.openComputerUseRecording';
export const COMPUTER_USE_RECORDING_MAX_DURATION_MS = 30 * 60 * 1000;
export const COMPUTER_USE_RECORDING_MAX_SIZE_BYTES = 500 * 1024 * 1024;
export const COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS = 2 * 60 * 1000;
export const COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
export const COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES = 4096;
export const COMPUTER_USE_RECORDING_MAX_SEGMENTS = 65_536;
export const COMPUTER_USE_RECORDING_MAX_GAPS = 4096;
export const COMPUTER_USE_RECORDING_MAX_THOUGHTS = 4096;
export const COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH = 512;
export const COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const COMPUTER_USE_RECORDING_MAX_SEGMENT_HEADER_BYTES = 1024 * 1024;
export const COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES = 4;

const SEGMENT_FILE_PATTERN = /^segment-[0-9]{6}\.gop$/;
const RECORDING_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const AVC_CODEC_PATTERN = /^avc1\.[0-9a-f]{6}$/i;
const MAX_CONFIG_DESCRIPTION_BYTES = 16 * 1024;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const MAX_SEGMENT_DURATION_US = COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS * 1000;
const THOUGHT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function isComputerUseRecordingId(value: string): boolean {
	return RECORDING_ID_PATTERN.test(value);
}

export function isComputerUseRecordingSegmentFile(value: string): boolean {
	return SEGMENT_FILE_PATTERN.test(value);
}

export type ComputerUseRecordingGapReason =
	| 'cursorReset'
	| 'droppedFrames'
	| 'invalidResource'
	| 'readError'
	| 'segmentLimit';

export interface IComputerUseRecordingGap {
	readonly startTimeMs: number;
	readonly durationMs: number;
	readonly reason: ComputerUseRecordingGapReason;
}

export interface IComputerUseRecordingSegmentReference {
	readonly file: string;
	readonly startTimeMs: number;
	readonly durationMs: number;
	readonly sizeBytes: number;
	readonly sampleCount: number;
}

/** A provider-shared thought state at an absolute position in the recording timeline. */
export interface IComputerUseRecordingThought {
	readonly timeMs: number;
	readonly source: 'reasoning' | 'activity';
	readonly text: string;
	readonly streaming: boolean;
}

export interface IComputerUseRecordingFocus {
	readonly x: number;
	readonly y: number;
}

export interface IComputerUseRecordingTarget {
	readonly app: string;
	readonly windowId: number;
	readonly title: string;
}

export interface IComputerUseRecordingDecoderConfig {
	readonly codec: string;
	readonly codedWidth: number;
	readonly codedHeight: number;
	readonly description: Uint8Array;
}

export interface IComputerUseRecordingSample {
	readonly sequence: number;
	readonly timestampUs: number;
	readonly durationUs: number;
	readonly keyFrame: boolean;
	readonly frameCount: number;
	readonly focus?: IComputerUseRecordingFocus;
	readonly data: Uint8Array;
}

export interface IComputerUseRecordingSegment {
	readonly streamId: string;
	readonly target: IComputerUseRecordingTarget;
	readonly config: IComputerUseRecordingDecoderConfig;
	readonly samples: readonly IComputerUseRecordingSample[];
}

export interface IComputerUseRecordingSegmentSampleHeader {
	readonly sequence: number;
	readonly timestampUs: number;
	readonly durationUs: number;
	readonly keyFrame: boolean;
	readonly frameCount: number;
	readonly focus?: IComputerUseRecordingFocus;
	readonly offset: number;
	readonly length: number;
}

export interface IComputerUseRecordingSegmentHeader {
	readonly version: typeof COMPUTER_USE_RECORDING_FORMAT_VERSION;
	readonly streamId: string;
	readonly target: IComputerUseRecordingTarget;
	readonly config: {
		readonly codec: string;
		readonly codedWidth: number;
		readonly codedHeight: number;
		readonly descriptionOffset: number;
		readonly descriptionLength: number;
	};
	readonly startTimestampUs: number;
	readonly durationUs: number;
	readonly samples: readonly IComputerUseRecordingSegmentSampleHeader[];
}

export interface IParsedComputerUseRecordingSegment {
	readonly header: IComputerUseRecordingSegmentHeader;
	readonly config: IComputerUseRecordingDecoderConfig;
	readonly samples: readonly IComputerUseRecordingSample[];
}

/** Validated root index for one locally persisted Computer Use recording. */
export interface IComputerUseRecordingManifest {
	readonly version: typeof COMPUTER_USE_RECORDING_FORMAT_VERSION;
	readonly recordingId: string;
	readonly createdAt: string;
	readonly finalized: boolean;
	readonly durationMs: number;
	readonly sizeBytes: number;
	readonly trimmed: boolean;
	readonly segments: readonly IComputerUseRecordingSegmentReference[];
	readonly gaps: readonly IComputerUseRecordingGap[];
	readonly thoughts?: readonly IComputerUseRecordingThought[];
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid Computer Use recording ${name}.`);
	}
	return value as Record<string, unknown>;
}

function readInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Invalid Computer Use recording ${key}.`);
	}
	return value as number;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== 'boolean') {
		throw new Error(`Invalid Computer Use recording ${key}.`);
	}
	return value;
}

function readString(record: Record<string, unknown>, key: string, maximumLength: number): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
		throw new Error(`Invalid Computer Use recording ${key}.`);
	}
	return value;
}

function readFocus(value: unknown): IComputerUseRecordingFocus | undefined {
	if (value === undefined) {
		return undefined;
	}
	const record = asRecord(value, 'focus');
	const x = record.x;
	const y = record.y;
	if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1
		|| typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) {
		throw new Error('Invalid Computer Use recording focus.');
	}
	return { x, y };
}

function readTarget(value: unknown): IComputerUseRecordingTarget {
	const record = asRecord(value, 'target');
	return {
		app: readString(record, 'app', 1024),
		windowId: readInteger(record, 'windowId', 1, Number.MAX_SAFE_INTEGER),
		title: readString(record, 'title', 4096),
	};
}

function validateCodec(codec: string, codedWidth: number, codedHeight: number): void {
	if (!AVC_CODEC_PATTERN.test(codec)
		|| codedWidth < 1 || codedWidth > 4096
		|| codedHeight < 1 || codedHeight > 4096
		|| codedWidth * codedHeight > 1920 * 1080) {
		throw new Error('Invalid Computer Use recording decoder configuration.');
	}
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
	if (first.byteLength !== second.byteLength) {
		return false;
	}
	for (let index = 0; index < first.byteLength; index++) {
		if (first[index] !== second[index]) {
			return false;
		}
	}
	return true;
}

function readSegment(value: unknown): IComputerUseRecordingSegmentReference {
	const record = asRecord(value, 'segment');
	const file = record.file;
	if (typeof file !== 'string' || !isComputerUseRecordingSegmentFile(file)) {
		throw new Error('Invalid Computer Use recording segment path.');
	}
	return {
		file,
		startTimeMs: readInteger(record, 'startTimeMs', 0, Number.MAX_SAFE_INTEGER),
		durationMs: readInteger(record, 'durationMs', 1, COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS),
		sizeBytes: readInteger(record, 'sizeBytes', 1, COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES),
		sampleCount: readInteger(record, 'sampleCount', 1, COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES),
	};
}

export function isComputerUseRecordingThoughtText(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH * 2
		&& Array.from(value).length <= COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH
		&& !THOUGHT_CONTROL_CHARACTER_PATTERN.test(value);
}

/** Validates one bounded provider-shared thought event. */
export function parseComputerUseRecordingThought(value: unknown): IComputerUseRecordingThought {
	const record = asRecord(value, 'thought');
	const source = record.source;
	if (source !== 'reasoning' && source !== 'activity') {
		throw new Error('Invalid Computer Use recording thought source.');
	}
	if (!isComputerUseRecordingThoughtText(record.text)) {
		throw new Error('Invalid Computer Use recording thought text.');
	}
	if (typeof record.streaming !== 'boolean') {
		throw new Error('Invalid Computer Use recording thought streaming flag.');
	}
	return {
		timeMs: readInteger(record, 'timeMs', 0, Number.MAX_SAFE_INTEGER),
		source,
		text: record.text,
		streaming: record.streaming,
	};
}

/**
 * Encodes a segment as a four-byte big-endian header length, UTF-8 JSON header,
 * then raw decoder configuration and AVCC access-unit bytes.
 */
export function serializeComputerUseRecordingSegment(segment: IComputerUseRecordingSegment): Uint8Array {
	if (!(segment.config.description instanceof Uint8Array)
		|| segment.config.description.byteLength < 1
		|| segment.config.description.byteLength > MAX_CONFIG_DESCRIPTION_BYTES
		|| segment.samples.length < 1
		|| segment.samples.length > COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES) {
		throw new Error('Invalid Computer Use recording segment payload.');
	}
	readTarget(segment.target);
	const streamId = readString({ streamId: segment.streamId }, 'streamId', 256);
	const codec = readString({ codec: segment.config.codec }, 'codec', 32);
	validateCodec(codec, segment.config.codedWidth, segment.config.codedHeight);

	let payloadLength = segment.config.description.byteLength;
	const sampleHeaders: IComputerUseRecordingSegmentSampleHeader[] = [];
	for (const sample of segment.samples) {
		if (!(sample.data instanceof Uint8Array) || sample.data.byteLength < 1 || sample.data.byteLength > MAX_SAMPLE_BYTES) {
			throw new Error('Invalid Computer Use recording sample payload.');
		}
		sampleHeaders.push({
			sequence: sample.sequence,
			timestampUs: sample.timestampUs,
			durationUs: sample.durationUs,
			keyFrame: sample.keyFrame,
			frameCount: sample.frameCount,
			...(sample.focus ? { focus: sample.focus } : {}),
			offset: payloadLength,
			length: sample.data.byteLength,
		});
		payloadLength += sample.data.byteLength;
		if (payloadLength > COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES) {
			throw new Error('Computer Use recording segment is oversized.');
		}
	}

	const startTimestampUs = sampleHeaders[0].timestampUs;
	const durationUs = Math.max(...sampleHeaders.map(sample => sample.timestampUs + sample.durationUs)) - startTimestampUs;
	const header: IComputerUseRecordingSegmentHeader = {
		version: COMPUTER_USE_RECORDING_FORMAT_VERSION,
		streamId,
		target: segment.target,
		config: {
			codec,
			codedWidth: segment.config.codedWidth,
			codedHeight: segment.config.codedHeight,
			descriptionOffset: 0,
			descriptionLength: segment.config.description.byteLength,
		},
		startTimestampUs,
		durationUs,
		samples: sampleHeaders,
	};
	const headerBytes = VSBuffer.fromString(JSON.stringify(header));
	if (headerBytes.byteLength > COMPUTER_USE_RECORDING_MAX_SEGMENT_HEADER_BYTES) {
		throw new Error('Computer Use recording segment header is oversized.');
	}
	const totalLength = COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES + headerBytes.byteLength + payloadLength;
	if (totalLength > COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES) {
		throw new Error('Computer Use recording segment is oversized.');
	}
	const prefix = VSBuffer.alloc(COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES);
	prefix.writeUInt32BE(headerBytes.byteLength, 0);
	const encoded = VSBuffer.concat([
		prefix,
		headerBytes,
		VSBuffer.wrap(segment.config.description),
		...segment.samples.map(sample => VSBuffer.wrap(sample.data)),
	], totalLength).buffer;
	parseComputerUseRecordingSegment(encoded);
	return encoded;
}

interface IParsedComputerUseRecordingSegmentHeaderData {
	readonly header: IComputerUseRecordingSegmentHeader;
	readonly payloadOffset: number;
}

function parseComputerUseRecordingSegmentHeaderData(value: Uint8Array, segmentByteLength: number): IParsedComputerUseRecordingSegmentHeaderData {
	if (!(value instanceof Uint8Array)
		|| !Number.isSafeInteger(segmentByteLength)
		|| segmentByteLength <= COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES
		|| segmentByteLength > COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES
		|| value.byteLength < COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES
		|| value.byteLength > segmentByteLength) {
		throw new Error('Invalid or oversized Computer Use recording segment.');
	}
	const bytes = VSBuffer.wrap(value);
	const headerLength = bytes.readUInt32BE(0);
	const payloadOffset = COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES + headerLength;
	if (headerLength < 2
		|| headerLength > COMPUTER_USE_RECORDING_MAX_SEGMENT_HEADER_BYTES
		|| payloadOffset > value.byteLength
		|| payloadOffset >= segmentByteLength) {
		throw new Error('Invalid Computer Use recording segment header length.');
	}
	const headerBytes = bytes.slice(COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES, payloadOffset);
	const headerText = headerBytes.toString();
	if (!bytesEqual(headerBytes.buffer, VSBuffer.fromString(headerText).buffer)) {
		throw new Error('Invalid Computer Use recording segment header encoding.');
	}

	let parsedHeader: unknown;
	try {
		parsedHeader = JSON.parse(headerText);
	} catch {
		throw new Error('Invalid Computer Use recording segment header JSON.');
	}
	const record = asRecord(parsedHeader, 'segment header');
	if (record.version !== COMPUTER_USE_RECORDING_FORMAT_VERSION) {
		throw new Error('Unsupported Computer Use recording segment version.');
	}
	const streamId = readString(record, 'streamId', 256);
	const target = readTarget(record.target);
	const configRecord = asRecord(record.config, 'decoder configuration');
	const codec = readString(configRecord, 'codec', 32);
	const codedWidth = readInteger(configRecord, 'codedWidth', 1, 4096);
	const codedHeight = readInteger(configRecord, 'codedHeight', 1, 4096);
	validateCodec(codec, codedWidth, codedHeight);
	const descriptionOffset = readInteger(configRecord, 'descriptionOffset', 0, 0);
	const descriptionLength = readInteger(configRecord, 'descriptionLength', 1, MAX_CONFIG_DESCRIPTION_BYTES);
	const payloadLength = segmentByteLength - payloadOffset;
	if (descriptionOffset + descriptionLength > payloadLength) {
		throw new Error('Invalid Computer Use recording decoder configuration range.');
	}
	if (!Array.isArray(record.samples) || record.samples.length < 1 || record.samples.length > COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES) {
		throw new Error('Invalid Computer Use recording segment samples.');
	}

	const startTimestampUs = readInteger(record, 'startTimestampUs', 0, Number.MAX_SAFE_INTEGER);
	const durationUs = readInteger(record, 'durationUs', 1, MAX_SEGMENT_DURATION_US);
	let previousSequence = 0;
	let previousTimestamp = -1;
	let expectedOffset = descriptionLength;
	let latestEnd = startTimestampUs;
	const sampleHeaders: IComputerUseRecordingSegmentSampleHeader[] = [];
	for (const value of record.samples) {
		const sampleRecord = asRecord(value, 'sample');
		const sequence = readInteger(sampleRecord, 'sequence', 1, Number.MAX_SAFE_INTEGER);
		const timestampUs = readInteger(sampleRecord, 'timestampUs', startTimestampUs, Number.MAX_SAFE_INTEGER);
		const sampleDurationUs = readInteger(sampleRecord, 'durationUs', 1, MAX_SEGMENT_DURATION_US);
		const keyFrame = readBoolean(sampleRecord, 'keyFrame');
		const frameCount = readInteger(sampleRecord, 'frameCount', 1, COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES);
		const focus = readFocus(sampleRecord.focus);
		const offset = readInteger(sampleRecord, 'offset', expectedOffset, expectedOffset);
		const length = readInteger(sampleRecord, 'length', 1, MAX_SAMPLE_BYTES);
		if (sequence <= previousSequence || timestampUs < previousTimestamp || offset + length > payloadLength) {
			throw new Error('Invalid Computer Use recording sample order or range.');
		}
		const sampleHeader: IComputerUseRecordingSegmentSampleHeader = {
			sequence,
			timestampUs,
			durationUs: sampleDurationUs,
			keyFrame,
			frameCount,
			...(focus ? { focus } : {}),
			offset,
			length,
		};
		sampleHeaders.push(sampleHeader);
		previousSequence = sequence;
		previousTimestamp = timestampUs;
		expectedOffset += length;
		latestEnd = Math.max(latestEnd, timestampUs + sampleDurationUs);
	}
	if (!sampleHeaders[0].keyFrame || expectedOffset !== payloadLength || latestEnd - startTimestampUs !== durationUs) {
		throw new Error('Invalid Computer Use recording segment boundary.');
	}

	const header: IComputerUseRecordingSegmentHeader = {
		version: COMPUTER_USE_RECORDING_FORMAT_VERSION,
		streamId,
		target,
		config: {
			codec,
			codedWidth,
			codedHeight,
			descriptionOffset,
			descriptionLength,
		},
		startTimestampUs,
		durationUs,
		samples: sampleHeaders,
	};
	return { header, payloadOffset };
}

/** Parses and bounds segment metadata without requiring the encoded video payload. */
export function parseComputerUseRecordingSegmentHeader(value: Uint8Array, segmentByteLength: number): IComputerUseRecordingSegmentHeader {
	return parseComputerUseRecordingSegmentHeaderData(value, segmentByteLength).header;
}

/** Parses and bounds a binary segment before its bytes are handed to a browser decoder. */
export function parseComputerUseRecordingSegment(value: Uint8Array): IParsedComputerUseRecordingSegment {
	const { header, payloadOffset } = parseComputerUseRecordingSegmentHeaderData(value, value.byteLength);
	const payload = value.subarray(payloadOffset);
	return {
		header,
		config: {
			codec: header.config.codec,
			codedWidth: header.config.codedWidth,
			codedHeight: header.config.codedHeight,
			description: payload.subarray(header.config.descriptionOffset, header.config.descriptionOffset + header.config.descriptionLength),
		},
		samples: header.samples.map(sample => ({
			sequence: sample.sequence,
			timestampUs: sample.timestampUs,
			durationUs: sample.durationUs,
			keyFrame: sample.keyFrame,
			frameCount: sample.frameCount,
			...(sample.focus ? { focus: sample.focus } : {}),
			data: payload.subarray(sample.offset, sample.offset + sample.length),
		})),
	};
}

function readGap(value: unknown): IComputerUseRecordingGap {
	const record = asRecord(value, 'gap');
	const reason = record.reason;
	if (reason !== 'cursorReset'
		&& reason !== 'droppedFrames'
		&& reason !== 'invalidResource'
		&& reason !== 'readError'
		&& reason !== 'segmentLimit') {
		throw new Error('Invalid Computer Use recording gap reason.');
	}
	return {
		startTimeMs: readInteger(record, 'startTimeMs', 0, Number.MAX_SAFE_INTEGER),
		durationMs: readInteger(record, 'durationMs', 1, COMPUTER_USE_RECORDING_MAX_DURATION_MS),
		reason,
	};
}

function readIsoDate(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length > 64) {
		throw new Error(`Invalid Computer Use recording ${key}.`);
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
		throw new Error(`Invalid Computer Use recording ${key}.`);
	}
	return value;
}

/** Parses a root manifest without permitting arbitrary segment paths or unbounded collections. */
export function parseComputerUseRecordingManifest(value: unknown): IComputerUseRecordingManifest {
	const record = asRecord(value, 'manifest');
	if (record.version !== COMPUTER_USE_RECORDING_FORMAT_VERSION) {
		throw new Error('Unsupported Computer Use recording manifest version.');
	}
	const recordingId = record.recordingId;
	if (typeof recordingId !== 'string' || !isComputerUseRecordingId(recordingId)) {
		throw new Error('Invalid Computer Use recording id.');
	}
	if (!Array.isArray(record.segments) || record.segments.length > COMPUTER_USE_RECORDING_MAX_SEGMENTS) {
		throw new Error('Invalid Computer Use recording segments.');
	}
	if (!Array.isArray(record.gaps) || record.gaps.length > COMPUTER_USE_RECORDING_MAX_GAPS) {
		throw new Error('Invalid Computer Use recording gaps.');
	}
	if (record.thoughts !== undefined && (!Array.isArray(record.thoughts) || record.thoughts.length > COMPUTER_USE_RECORDING_MAX_THOUGHTS)) {
		throw new Error('Invalid Computer Use recording thoughts.');
	}

	const segments = record.segments.map(readSegment);
	const gaps = record.gaps.map(readGap);
	const thoughts = record.thoughts?.map(parseComputerUseRecordingThought);
	let previousThoughtTime = -1;
	for (const thought of thoughts ?? []) {
		if (thought.timeMs < previousThoughtTime) {
			throw new Error('Invalid Computer Use recording thought order.');
		}
		previousThoughtTime = thought.timeMs;
	}
	const files = new Set<string>();
	let previousEnd = -1;
	let sizeBytes = 0;
	for (const segment of segments) {
		const segmentEnd = segment.startTimeMs + segment.durationMs;
		if (!Number.isSafeInteger(segmentEnd) || files.has(segment.file) || segment.startTimeMs < previousEnd) {
			throw new Error('Invalid Computer Use recording segment order.');
		}
		files.add(segment.file);
		previousEnd = segmentEnd;
		sizeBytes += segment.sizeBytes;
	}

	const declaredSizeBytes = readInteger(record, 'sizeBytes', 0, COMPUTER_USE_RECORDING_MAX_SIZE_BYTES);
	if (sizeBytes !== declaredSizeBytes) {
		throw new Error('Invalid Computer Use recording size total.');
	}
	const declaredDurationMs = readInteger(record, 'durationMs', 0, COMPUTER_USE_RECORDING_MAX_DURATION_MS);
	const firstStart = segments[0]?.startTimeMs;
	if (firstStart === undefined) {
		if (gaps.length !== 0 || thoughts?.length || declaredDurationMs !== 0 || declaredSizeBytes !== 0) {
			throw new Error('Invalid empty Computer Use recording manifest.');
		}
	} else {
		let lastEnd = previousEnd;
		let previousGapEnd = firstStart;
		let segmentIndex = 0;
		for (const gap of gaps) {
			const gapEnd = gap.startTimeMs + gap.durationMs;
			if (!Number.isSafeInteger(gapEnd) || gap.startTimeMs < previousGapEnd) {
				throw new Error('Invalid Computer Use recording gap order.');
			}
			while (segmentIndex < segments.length && segments[segmentIndex].startTimeMs + segments[segmentIndex].durationMs <= gap.startTimeMs) {
				segmentIndex++;
			}
			if (segmentIndex < segments.length && segments[segmentIndex].startTimeMs < gapEnd) {
				throw new Error('Invalid Computer Use recording gap overlap.');
			}
			previousGapEnd = gapEnd;
			lastEnd = Math.max(lastEnd, gapEnd);
		}
		if (lastEnd - firstStart !== declaredDurationMs) {
			throw new Error('Invalid Computer Use recording duration total.');
		}
		if (thoughts?.some(thought => thought.timeMs < firstStart || thought.timeMs > lastEnd)) {
			throw new Error('Invalid Computer Use recording thought timeline.');
		}
	}

	return {
		version: COMPUTER_USE_RECORDING_FORMAT_VERSION,
		recordingId,
		createdAt: readIsoDate(record, 'createdAt'),
		finalized: readBoolean(record, 'finalized'),
		durationMs: declaredDurationMs,
		sizeBytes: declaredSizeBytes,
		trimmed: readBoolean(record, 'trimmed'),
		segments,
		gaps,
		...(thoughts !== undefined ? { thoughts } : {}),
	};
}

/** Bounds and parses the UTF-8 JSON form of a recording manifest. */
export function parseComputerUseRecordingManifestJson(value: string): IComputerUseRecordingManifest {
	if (typeof value !== 'string' || VSBuffer.fromString(value).byteLength > COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES) {
		throw new Error('Invalid or oversized Computer Use recording manifest JSON.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Invalid Computer Use recording manifest JSON.');
	}
	return parseComputerUseRecordingManifest(parsed);
}
