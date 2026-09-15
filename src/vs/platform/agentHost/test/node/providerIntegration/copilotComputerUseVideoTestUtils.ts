/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { vArray, vBoolean, vLiteral, vNumber, vObj, vOptionalProp, vString, vUnion } from '../../../../../base/common/validation.js';
import { ChatInputRequestPurpose, readChatInputRequestPurpose } from '../../../common/meta/agentChatInputRequestMeta.js';
import { ChatInputQuestionKind, type ChatInputRequest } from '../../../common/state/protocol/channels-chat/state.js';
import { isFixtureApplicationConsentMessage, type BrowserChannel, type CaptureMarker, type FixtureConsent, type IFixtureWindow } from './copilotComputerUseWindowsTestUtils.js';
import type { ITypingInterruptionObservation } from './copilotComputerUseTypingTestUtils.js';

export const liveVideoUri = 'computer-use://video/live';
export const videoMaxBytes = 1024 * 1024;
const streamIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const configValidator = vObj({ codec: vString(), codedWidth: vNumber(), codedHeight: vNumber(), description: vString() });
const frameValidator = vObj({ sequence: vNumber(), timestamp: vNumber(), duration: vNumber(), keyFrame: vBoolean(), data: vString() });
const batchValidator = vObj({
	version: vNumber(),
	status: vUnion(vLiteral('idle'), vLiteral('starting'), vLiteral('live'), vLiteral('stopped'), vLiteral('permissionRequired'), vLiteral('error')),
	streamId: vOptionalProp(vString()),
	target: vOptionalProp(vObj({ app: vString(), windowId: vNumber(), title: vString() })),
	config: vOptionalProp(configValidator),
	frames: vOptionalProp(vArray(frameValidator)),
	dropped: vOptionalProp(vBoolean()),
});

export type NativeVideoBatch = ReturnType<typeof parseVideoBatch>;
export type NativeVideoConfig = NonNullable<NativeVideoBatch['config']>;

export interface IVideoCursor {
	readonly streamId: string;
	readonly after: number;
}

export interface IVideoPeerEvidence {
	readonly boundary: 'native-mcp' | 'authenticated-agent-host';
	readonly consent: FixtureConsent['counts'];
	readonly authorizations: number;
	readonly reads: number;
	readonly nativeAbortNotifications?: number;
	readonly fakeModelRequests?: number;
	readonly cancelledChat?: string;
	readonly cancelledTurn?: string;
	readonly siblingProgressAfterCancellation?: boolean;
	readonly nativeStopInvoked?: boolean;
	readonly typingInterruption?: ITypingInterruptionObservation;
	readonly discovery?: {
		readonly expectedTitlePrefix: string;
		readonly rowCount: number;
		readonly fixtureTitles: readonly string[];
	};
}

export interface IVideoFixturePeer {
	readonly consent: FixtureConsent;
	readonly authorizations: number;
	readonly readCount: number;
	start(): Promise<void>;
	rememberProcesses(): Promise<void>;
	discover(title: string, channel: BrowserChannel): Promise<{ target: IFixtureWindow; guard: IFixtureWindow }>;
	authorize(target: IFixtureWindow, title: string): Promise<void>;
	assertConsent(): void;
	read(cursor?: IVideoCursor): Promise<NativeVideoBatch>;
	close(): Promise<void>;
	getEvidence(): IVideoPeerEvidence;
}

export function nativeVideoTestsEnabled(platform: string, environment: NodeJS.ProcessEnv): boolean {
	return platform === 'win32' && environment.VSCODE_COMPUTER_USE_NATIVE_TEST === '1'
		&& environment.VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST === '1';
}

export function ahpVideoTestsEnabled(platform: string, environment: NodeJS.ProcessEnv): boolean {
	return nativeVideoTestsEnabled(platform, environment) && environment.VSCODE_COMPUTER_USE_VIDEO_AHP_TEST === '1';
}

export function isFixtureApplicationQuestion(request: ChatInputRequest, target: IFixtureWindow): boolean {
	const question = request.questions?.[0];
	return readChatInputRequestPurpose(request) === ChatInputRequestPurpose.Elicitation
		&& request.url === undefined && isFixtureApplicationConsentMessage(request.message, target.name)
		&& request.questions?.length === 1 && question?.id === 'choice'
		&& question.kind === ChatInputQuestionKind.SingleSelect && question.allowFreeformInput !== true
		&& question.options.some(option => option.id === 'allow');
}

export function parseVideoResource(result: unknown, uri: string): NativeVideoBatch {
	const resource = vObj({ contents: vArray(vObj({ uri: vString(), mimeType: vString(), text: vString() })) }).validate(result).content;
	assert.ok(resource?.contents.length === 1, 'Native video must return exactly one JSON text resource (payload omitted)');
	const content = resource.contents[0];
	assert.ok(content.uri === uri && content.mimeType === 'application/json', 'Native video must echo the requested resource URI and JSON MIME type (payload omitted)');
	return parseVideoBatch(content.text);
}
export function videoReadUri(cursor?: IVideoCursor): string {
	if (!cursor) {
		return liveVideoUri;
	}
	assert.ok(streamIdPattern.test(cursor.streamId) && Number.isSafeInteger(cursor.after) && cursor.after >= 0, 'Invalid video cursor (values omitted)');
	return `${liveVideoUri}?streamId=${cursor.streamId}&after=${cursor.after}`;
}

function decodeBase64(value: string): Buffer {
	assert.ok(value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Native video must contain base64, not a screenshot or a URL (bytes omitted)');
	const bytes = Buffer.from(value, 'base64');
	assert.ok(bytes.toString('base64') === value, 'Native video base64 must be canonical (bytes omitted)');
	return bytes;
}

function validateAvcC(config: NativeVideoConfig): number {
	assert.ok(/^avc1\.[0-9a-f]{6}$/i.test(config.codec), 'Native video must advertise an AVC codec');
	assert.ok(Number.isSafeInteger(config.codedWidth) && config.codedWidth >= 2 && config.codedWidth <= 1280 && config.codedWidth % 2 === 0
		&& Number.isSafeInteger(config.codedHeight) && config.codedHeight >= 2 && config.codedHeight <= 720 && config.codedHeight % 2 === 0,
		'Native video dimensions must be positive, even and bounded to 1280 x 720');
	const bytes = decodeBase64(config.description);
	assert.ok(bytes.length >= 11 && bytes[0] === 1 && (bytes[4] & 3) === 3, 'The decoder description must be avcC with four-byte NAL lengths (bytes omitted)');
	assert.ok(bytes.subarray(1, 4).toString('hex') === config.codec.slice(5).toLowerCase(), 'The AVC codec must agree with avcC (bytes omitted)');
	let offset = 6;
	const readParameterSets = (count: number, nalType: number) => {
		assert.ok(count > 0, 'avcC must include SPS and PPS parameter sets (bytes omitted)');
		for (let index = 0; index < count; index++) {
			assert.ok(offset + 2 <= bytes.length, 'Truncated avcC parameter length (bytes omitted)');
			const length = bytes.readUInt16BE(offset);
			offset += 2;
			assert.ok(length > 0 && offset + length <= bytes.length && (bytes[offset] & 31) === nalType, 'Invalid avcC parameter set (bytes omitted)');
			offset += length;
		}
	};
	readParameterSets(bytes[5] & 31, 7);
	assert.ok(offset < bytes.length, 'avcC must contain a PPS count (bytes omitted)');
	const ppsCount = bytes[offset++];
	readParameterSets(ppsCount, 8);
	return bytes.length;
}

function validateAccessUnit(data: string, keyFrame: boolean): number {
	const bytes = decodeBase64(data);
	let offset = 0;
	let containsIdr = false;
	while (offset < bytes.length) {
		assert.ok(offset + 4 < bytes.length, 'Truncated AVCC NAL length (bytes omitted)');
		const length = bytes.readUInt32BE(offset);
		offset += 4;
		assert.ok(length > 0 && offset + length <= bytes.length, 'Video frames must be four-byte length-prefixed AVCC, not Annex B (bytes omitted)');
		const type = bytes[offset] & 31;
		assert.ok((bytes[offset] & 128) === 0 && type > 0 && type < 24, 'Invalid AVC NAL header (bytes omitted)');
		containsIdr ||= type === 5;
		offset += length;
	}
	assert.ok(keyFrame === containsIdr, 'The keyframe flag must agree with the encoded IDR access unit (bytes omitted)');
	return bytes.length;
}

/** Validates the native wire contract without importing the higher-layer Sessions parser or retaining diagnostic payloads. */
export function parseVideoBatch(text: string) {
	assert.ok(Buffer.byteLength(text) <= 2 * videoMaxBytes, 'The video JSON envelope must be bounded (payload omitted)');
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('Native video must return JSON (payload omitted)');
	}
	const batch = batchValidator.validate(value).content;
	assert.ok(batch && batch.version === 1, 'Invalid native video version, status or fields (payload omitted)');
	const frames = batch.frames ?? [];
	assert.ok(frames.length <= 60, 'A native video batch must contain at most 60 frames');
	assert.ok(batch.streamId === undefined || streamIdPattern.test(batch.streamId), 'Invalid native stream identifier (value omitted)');
	if (batch.target) {
		assert.ok(batch.target.app.length > 0 && batch.target.title.length > 0
			&& Number.isSafeInteger(batch.target.windowId) && batch.target.windowId > 0, 'Invalid native video target (identity omitted)');
	}
	if (batch.status !== 'starting' && batch.status !== 'live') {
		assert.ok(frames.length === 0 && batch.config === undefined, 'Inactive video must not retain frames or decoder configuration (payload omitted)');
	}
	if (frames.length) {
		assert.ok(batch.status === 'live' && batch.streamId && batch.target && batch.config, 'Encoded frames require a live stream, target and decoder configuration (payload omitted)');
	}
	let byteCount = batch.config ? validateAvcC(batch.config) : 0;
	let previousSequence = 0;
	let previousTimestamp = -1;
	for (const frame of frames) {
		assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence > previousSequence
			&& Number.isSafeInteger(frame.timestamp) && frame.timestamp > previousTimestamp
			&& Number.isSafeInteger(frame.duration) && frame.duration > 0,
			'Frame sequences and microsecond timestamps must increase, with a positive duration (payload omitted)');
		byteCount += validateAccessUnit(frame.data, frame.keyFrame);
		previousSequence = frame.sequence;
		previousTimestamp = frame.timestamp;
	}
	assert.ok(byteCount <= videoMaxBytes, 'Encoded frames plus avcC must fit within 1 MiB (bytes omitted)');
	if (batch.dropped && frames.length) {
		assert.ok(frames[0].keyFrame, 'A dropped-frame recovery batch must begin with a keyframe');
	}
	return { ...batch, frames, dropped: batch.dropped ?? false };
}

export interface IDecodedVideoFrame {
	readonly sequence: number;
	readonly timestamp: number;
	readonly duration: number;
	readonly width: number;
	readonly height: number;
	readonly phase: number;
	readonly containsGuard: boolean;
}

export interface IBrowserVideoDecoder {
	decode(batch: NativeVideoBatch): Promise<void>;
	takeFrames(): IDecodedVideoFrame[];
	reset(): void;
	close(): void;
}

/** Runs entirely inside the secure fixture client page, using native WebCodecs and closing every output VideoFrame. */
export function createBrowserVideoDecoder(markers: { readonly target: readonly CaptureMarker[]; readonly guard: CaptureMarker }): IBrowserVideoDecoder {
	if (!globalThis.isSecureContext || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
		throw new Error('The fixture client requires a secure origin and real WebCodecs AVC decoding; try the installed Edge channel');
	}
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) {
		throw new Error('The fixture client requires a canvas for decoded-frame verification');
	}
	const markerCodes = [...markers.target, markers.guard].map(marker => marker.map(color => (color[0] > 128 ? 4 : 0) + (color[1] > 128 ? 2 : 0) + (color[2] > 128 ? 1 : 0)));
	const output: IDecodedVideoFrame[] = [];
	const pending = new Map<number, { sequence: number; duration: number }>();
	let streamId: string | undefined;
	let configuration: NativeVideoConfig | undefined;
	let failed = false;

	const inspectPixels = (pixels: Uint8ClampedArray, width: number, height: number) => {
		const found = new Set<number>();
		for (let y = 0; y < height; y += 4) {
			const runs: { color: number; start: number; end: number }[] = [];
			let previousColor = -1;
			let start = 0;
			for (let x = 0; x <= width; x++) {
				const offset = (y * width + x) * 4;
				const red = pixels[offset];
				const green = pixels[offset + 1];
				const blue = pixels[offset + 2];
				const bits = (red > 128 ? 4 : 0) + (green > 128 ? 2 : 0) + (blue > 128 ? 1 : 0);
				const vivid = (red < 56 || red > 200) && (green < 56 || green > 200) && (blue < 56 || blue > 200);
				const color = x < width && vivid && bits > 0 && bits < 7 ? bits : -1;
				if (color !== previousColor || x === width) {
					if (previousColor >= 0 && x - start >= 6) {
						runs.push({ color: previousColor, start, end: x });
					}
					previousColor = color;
					start = x;
				}
			}
			for (const [markerIndex, codes] of markerCodes.entries()) {
				for (let index = 0; index <= runs.length - codes.length; index++) {
					if (codes.every((code, cell) => runs[index + cell].color === code
						&& (cell === 0 || runs[index + cell].start - runs[index + cell - 1].end <= 6))) {
						found.add(markerIndex);
					}
				}
			}
		}
		return { phase: markers.target.findIndex((_, index) => found.has(index)), containsGuard: found.has(markers.target.length) };
	};
	const decoder = new VideoDecoder({
		output: frame => {
			try {
				const metadata = pending.get(frame.timestamp);
				if (!metadata || !configuration || frame.displayWidth !== configuration.codedWidth || frame.displayHeight !== configuration.codedHeight) {
					failed = true;
					return;
				}
				pending.delete(frame.timestamp);
				if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
					canvas.width = frame.displayWidth;
					canvas.height = frame.displayHeight;
				}
				context.drawImage(frame, 0, 0);
				const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
				output.push({
					sequence: metadata.sequence,
					timestamp: frame.timestamp,
					duration: frame.duration ?? metadata.duration,
					width: frame.displayWidth,
					height: frame.displayHeight,
					...inspectPixels(pixels, canvas.width, canvas.height),
				});
			} catch {
				failed = true;
			} finally {
				frame.close();
			}
		},
		error: () => { failed = true; },
	});
	const bytes = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
	return {
		async decode(batch) {
			if (failed) {
				throw new Error('Native WebCodecs decoding or decoded-frame inspection failed (media omitted)');
			}
			if (!batch.frames.length) {
				return;
			}
			if (!batch.config || !batch.streamId) {
				throw new Error('Encoded video requires stream configuration');
			}
			const reset = streamId !== batch.streamId || batch.dropped;
			if (reset) {
				if (!batch.frames[0].keyFrame) {
					throw new Error('A decoder reset must begin with a native keyframe');
				}
				decoder.reset();
				pending.clear();
				output.length = 0;
				const config: VideoDecoderConfig = {
					codec: batch.config.codec,
					codedWidth: batch.config.codedWidth,
					codedHeight: batch.config.codedHeight,
					description: bytes(batch.config.description),
					optimizeForLatency: true,
				};
				if (!(await VideoDecoder.isConfigSupported(config)).supported) {
					throw new Error('The installed browser cannot decode the native AVC configuration; no decoder is mocked');
				}
				decoder.configure(config);
				streamId = batch.streamId;
				configuration = batch.config;
			} else if (JSON.stringify(configuration) !== JSON.stringify(batch.config)) {
				throw new Error('A decoder configuration change must create a fresh stream');
			}
			for (const frame of batch.frames) {
				pending.set(frame.timestamp, { sequence: frame.sequence, duration: frame.duration });
				decoder.decode(new EncodedVideoChunk({
					type: frame.keyFrame ? 'key' : 'delta',
					timestamp: frame.timestamp,
					duration: frame.duration,
					data: bytes(frame.data),
				}));
			}
		},
		takeFrames() {
			if (failed) {
				throw new Error('Native WebCodecs decoding or decoded-frame inspection failed (media omitted)');
			}
			return output.splice(0);
		},
		reset() {
			decoder.reset();
			pending.clear();
			output.length = 0;
			streamId = undefined;
			configuration = undefined;
		},
		close() {
			decoder.close();
			pending.clear();
			output.length = 0;
			if (failed) {
				throw new Error('Native WebCodecs reported a late decoding failure (media omitted)');
			}
		},
	};
}
