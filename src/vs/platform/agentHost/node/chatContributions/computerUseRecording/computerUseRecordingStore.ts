/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { COMPUTER_USE_RECORDING_FORMAT_VERSION, COMPUTER_USE_RECORDING_MAX_DURATION_MS, COMPUTER_USE_RECORDING_MAX_GAPS, COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES, COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES, COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS, COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES, COMPUTER_USE_RECORDING_MAX_SIZE_BYTES, COMPUTER_USE_RECORDING_MAX_THOUGHTS, type ComputerUseRecordingGapReason, type IComputerUseRecordingDecoderConfig, type IComputerUseRecordingFocus, type IComputerUseRecordingGap, type IComputerUseRecordingManifest, type IComputerUseRecordingSample, type IComputerUseRecordingSegmentReference, type IComputerUseRecordingTarget, type IComputerUseRecordingThought, isComputerUseRecordingId, isComputerUseRecordingSegmentFile, parseComputerUseRecordingManifest, parseComputerUseRecordingManifestJson, parseComputerUseRecordingSegment, parseComputerUseRecordingThought, serializeComputerUseRecordingSegment } from '../../../common/computerUseRecording.js';

export const COMPUTER_USE_RECORDINGS_DIRECTORY = 'computer-use-recordings';
export const COMPUTER_USE_RECORDING_MANIFEST_FILE = 'manifest.json';

const DEFAULT_TARGET_SEGMENT_DURATION_MS = 10_000;
const SEGMENT_HEADER_BASE_BUDGET_BYTES = 8 * 1024;
const SEGMENT_HEADER_SAMPLE_BUDGET_BYTES = 256;
const MAX_INPUT_FRAMES = 60;
const TEMP_FILE_PATTERN = /^(?:manifest\.json|segment-[0-9]{6}\.gop)\.tmp-[0-9a-f-]{36}$/;

export interface IComputerUseRecordingStoreLimits {
	readonly maxDurationMs?: number;
	readonly maxSizeBytes?: number;
	readonly maxSegmentBytes?: number;
	readonly maxSegmentDurationMs?: number;
	readonly targetSegmentDurationMs?: number;
}

interface IResolvedComputerUseRecordingStoreLimits {
	readonly maxDurationMs: number;
	readonly maxSizeBytes: number;
	readonly maxSegmentBytes: number;
	readonly maxSegmentDurationMs: number;
	readonly targetSegmentDurationMs: number;
}

interface IMutableComputerUseRecordingSample {
	sequence: number;
	timestampUs: number;
	durationUs: number;
	keyFrame: boolean;
	frameCount: number;
	focus?: IComputerUseRecordingFocus;
	data: Uint8Array;
}

interface ICurrentSegment {
	readonly streamId: string;
	readonly target: IComputerUseRecordingTarget;
	readonly config: IComputerUseRecordingDecoderConfig;
	readonly startTimeMs: number;
	readonly samples: IMutableComputerUseRecordingSample[];
}

export interface IComputerUseRecordingFrameBatch {
	readonly streamId: string;
	readonly target: IComputerUseRecordingTarget;
	readonly config: IComputerUseRecordingDecoderConfig;
	readonly frames: readonly IComputerUseRecordingSample[];
}

export interface IComputerUseRecordingFinalization {
	readonly recordingUri: string;
	readonly manifest: IComputerUseRecordingManifest;
}

export interface IComputerUseRecordingRecoveryResult {
	readonly recordings: readonly IComputerUseRecordingManifest[];
	readonly invalidRecordingIds: readonly string[];
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

function focusEqual(first: IComputerUseRecordingFocus | undefined, second: IComputerUseRecordingFocus | undefined): boolean {
	return first === second || !!first && !!second && first.x === second.x && first.y === second.y;
}

function configEqual(first: IComputerUseRecordingDecoderConfig, second: IComputerUseRecordingDecoderConfig): boolean {
	return first.codec === second.codec
		&& first.codedWidth === second.codedWidth
		&& first.codedHeight === second.codedHeight
		&& bytesEqual(first.description, second.description);
}

function targetEqual(first: IComputerUseRecordingTarget, second: IComputerUseRecordingTarget): boolean {
	return first.app === second.app && first.windowId === second.windowId && first.title === second.title;
}

function cloneConfig(config: IComputerUseRecordingDecoderConfig): IComputerUseRecordingDecoderConfig {
	return { ...config, description: new Uint8Array(config.description) };
}

function cloneSample(sample: IComputerUseRecordingSample): IMutableComputerUseRecordingSample {
	return {
		...sample,
		...(sample.focus ? { focus: { ...sample.focus } } : {}),
		data: new Uint8Array(sample.data),
	};
}

function isWindowsRenameContention(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

function isFileNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function writeFileAtomic(path: string, contents: Uint8Array): Promise<void> {
	const temporaryPath = `${path}.tmp-${generateUuid()}`;
	const handle = await fs.open(temporaryPath, 'wx', 0o600);
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		try {
			await fs.rename(temporaryPath, path);
		} catch (error) {
			if (process.platform !== 'win32' || !isWindowsRenameContention(error)) {
				throw error;
			}
			await fs.rm(path, { force: true });
			await fs.rename(temporaryPath, path);
		}
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

async function createPrivateDirectory(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error('Computer Use recording path is not a private directory.');
	}
	if (process.platform !== 'win32') {
		await fs.chmod(path, 0o700);
	}
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
	const stat = await fs.lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
		throw new Error('Invalid Computer Use recording file.');
	}
	const contents = await fs.readFile(path);
	if (contents.byteLength !== stat.size) {
		throw new Error('Computer Use recording file changed while it was being read.');
	}
	return contents;
}

function resolveLimits(options: IComputerUseRecordingStoreLimits | undefined): IResolvedComputerUseRecordingStoreLimits {
	const maxDurationMs = options?.maxDurationMs ?? COMPUTER_USE_RECORDING_MAX_DURATION_MS;
	const maxSizeBytes = options?.maxSizeBytes ?? COMPUTER_USE_RECORDING_MAX_SIZE_BYTES;
	const maxSegmentBytes = options?.maxSegmentBytes ?? COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES;
	const maxSegmentDurationMs = options?.maxSegmentDurationMs ?? COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS;
	const targetSegmentDurationMs = options?.targetSegmentDurationMs ?? DEFAULT_TARGET_SEGMENT_DURATION_MS;
	if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > COMPUTER_USE_RECORDING_MAX_DURATION_MS
		|| !Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 1 || maxSizeBytes > COMPUTER_USE_RECORDING_MAX_SIZE_BYTES
		|| !Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 16 * 1024 || maxSegmentBytes > COMPUTER_USE_RECORDING_MAX_SEGMENT_BYTES
		|| !Number.isSafeInteger(maxSegmentDurationMs) || maxSegmentDurationMs < 1 || maxSegmentDurationMs > COMPUTER_USE_RECORDING_MAX_SEGMENT_DURATION_MS
		|| !Number.isSafeInteger(targetSegmentDurationMs) || targetSegmentDurationMs < 1 || targetSegmentDurationMs > maxSegmentDurationMs) {
		throw new Error('Invalid Computer Use recording store limits.');
	}
	return { maxDurationMs, maxSizeBytes, maxSegmentBytes, maxSegmentDurationMs, targetSegmentDurationMs };
}

/**
 * Persists local screen-control footage in a private, chat-scoped directory
 * below its owning session data. The files contain window metadata, raw video,
 * and bounded provider-shared thought text and must remain owner-only.
 */
export class ComputerUseRecordingStore {
	private readonly _segments: IComputerUseRecordingSegmentReference[] = [];
	private readonly _gaps: IComputerUseRecordingGap[] = [];
	private readonly _thoughts: IComputerUseRecordingThought[] = [];
	private _current: ICurrentSegment | undefined;
	private _nextSegmentNumber = 1;
	private _timelineEndMs = 0;
	private _lastThoughtTimeMs = -1;
	private _trimmed = false;
	private _finalized = false;
	private _result: IComputerUseRecordingFinalization | undefined;
	private _hasPersistedFrames = false;
	private _pendingSegmentLimitGapUs = 0;
	private _waitingAfterSegmentLimit = false;

	private constructor(
		private readonly _recordingDirectory: URI,
		private readonly _recordingId: string,
		private readonly _createdAt: string,
		private readonly _limits: IResolvedComputerUseRecordingStoreLimits,
	) { }

	get hasPersistedFrames(): boolean {
		return this._hasPersistedFrames;
	}

	static async create(chatDataDirectory: URI, recordingId: string, createdAt: string, limits?: IComputerUseRecordingStoreLimits): Promise<ComputerUseRecordingStore> {
		return ComputerUseRecordingStore.createInDirectory(URI.joinPath(chatDataDirectory, COMPUTER_USE_RECORDINGS_DIRECTORY), recordingId, createdAt, limits);
	}

	static async createInDirectory(recordingsDirectory: URI, recordingId: string, createdAt: string, limits?: IComputerUseRecordingStoreLimits): Promise<ComputerUseRecordingStore> {
		if (recordingsDirectory.scheme !== Schemas.file) {
			throw new Error('Computer Use recordings require a local file session-data directory.');
		}
		parseComputerUseRecordingManifest({
			version: COMPUTER_USE_RECORDING_FORMAT_VERSION,
			recordingId,
			createdAt,
			finalized: false,
			durationMs: 0,
			sizeBytes: 0,
			trimmed: false,
			segments: [],
			gaps: [],
		});
		const recordingDirectory = URI.joinPath(recordingsDirectory, recordingId);
		await createPrivateDirectory(recordingsDirectory.fsPath);
		await createPrivateDirectory(recordingDirectory.fsPath);
		return new ComputerUseRecordingStore(recordingDirectory, recordingId, createdAt, resolveLimits(limits));
	}

	static async recover(chatDataDirectory: URI): Promise<IComputerUseRecordingRecoveryResult> {
		return ComputerUseRecordingStore.recoverFromDirectory(URI.joinPath(chatDataDirectory, COMPUTER_USE_RECORDINGS_DIRECTORY));
	}

	static async recoverFromDirectory(recordingsDirectory: URI): Promise<IComputerUseRecordingRecoveryResult> {
		if (recordingsDirectory.scheme !== Schemas.file) {
			throw new Error('Computer Use recordings require a local file session-data directory.');
		}
		const recordingsPath = recordingsDirectory.fsPath;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(recordingsPath, { withFileTypes: true });
		} catch (error) {
			if (isFileNotFound(error)) {
				return { recordings: [], invalidRecordingIds: [] };
			}
			throw error;
		}

		const recordings: IComputerUseRecordingManifest[] = [];
		const invalidRecordingIds: string[] = [];
		for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
			if (!isComputerUseRecordingId(entry.name)) {
				continue;
			}
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				invalidRecordingIds.push(entry.name);
				await fs.rm(join(recordingsPath, entry.name), { force: true });
				continue;
			}
			const recordingDirectory = join(recordingsPath, entry.name);
			try {
				const files = await fs.readdir(recordingDirectory, { withFileTypes: true });
				for (const file of files) {
					if (TEMP_FILE_PATTERN.test(file.name)) {
						await fs.rm(join(recordingDirectory, file.name), { force: true });
					}
				}
				const manifestBytes = await readRegularFile(join(recordingDirectory, COMPUTER_USE_RECORDING_MANIFEST_FILE), COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES);
				let manifest = parseComputerUseRecordingManifestJson(VSBuffer.wrap(manifestBytes).toString());
				if (manifest.recordingId !== entry.name) {
					throw new Error('Computer Use recording directory does not match its manifest.');
				}
				const referenced = new Set(manifest.segments.map(segment => segment.file));
				for (const segment of manifest.segments) {
					const segmentBytes = await readRegularFile(join(recordingDirectory, segment.file), segment.sizeBytes);
					if (segmentBytes.byteLength !== segment.sizeBytes) {
						throw new Error('Computer Use recording segment size does not match its manifest.');
					}
					const parsed = parseComputerUseRecordingSegment(segmentBytes);
					if (parsed.header.samples.length !== segment.sampleCount || Math.ceil(parsed.header.durationUs / 1000) !== segment.durationMs) {
						throw new Error('Computer Use recording segment header does not match its manifest.');
					}
				}
				for (const file of files) {
					if (isComputerUseRecordingSegmentFile(file.name) && !referenced.has(file.name)) {
						await fs.rm(join(recordingDirectory, file.name), { force: true });
					}
				}
				if (!manifest.finalized) {
					manifest = parseComputerUseRecordingManifest({ ...manifest, finalized: true });
					await writeFileAtomic(
						join(recordingDirectory, COMPUTER_USE_RECORDING_MANIFEST_FILE),
						VSBuffer.fromString(JSON.stringify(manifest)).buffer,
					);
				}
				recordings.push(manifest);
			} catch {
				invalidRecordingIds.push(entry.name);
				await fs.rm(recordingDirectory, { recursive: true, force: true });
			}
		}
		return { recordings, invalidRecordingIds };
	}

	async appendFrames(batch: IComputerUseRecordingFrameBatch): Promise<void> {
		if (this._finalized) {
			throw new Error('Cannot append to a finalized Computer Use recording.');
		}
		if (batch.frames.length > MAX_INPUT_FRAMES) {
			throw new Error('Too many frames in one Computer Use recording batch.');
		}
		if (this._current && (this._current.streamId !== batch.streamId
			|| !configEqual(this._current.config, batch.config)
			|| !targetEqual(this._current.target, batch.target))) {
			await this._flushCurrent();
		}

		for (const frame of batch.frames) {
			if (this._current && frame.keyFrame && this._currentDurationUs() >= this._limits.targetSegmentDurationMs * 1000) {
				await this._flushCurrent();
			}
			if (!this._current) {
				if (!frame.keyFrame) {
					if (this._waitingAfterSegmentLimit) {
						this._pendingSegmentLimitGapUs += frame.durationUs;
					}
					continue;
				}
				await this._flushSegmentLimitGap();
				this._current = {
					streamId: batch.streamId,
					target: { ...batch.target },
					config: cloneConfig(batch.config),
					startTimeMs: this._timelineEndMs,
					samples: [],
				};
			}
			const previous = this._current.samples.at(-1);
			const coalesces = !frame.keyFrame && previous && !previous.keyFrame
				&& focusEqual(previous.focus, frame.focus)
				&& bytesEqual(previous.data, frame.data);
			if (this._wouldExceedCurrent(frame, !!coalesces)) {
				if (frame.keyFrame && this._current.samples.length > 0) {
					await this._flushCurrent();
					this._current = {
						streamId: batch.streamId,
						target: { ...batch.target },
						config: cloneConfig(batch.config),
						startTimeMs: this._timelineEndMs,
						samples: [],
					};
				}
				if (this._wouldExceedCurrent(frame, false)) {
					await this._flushCurrent();
					this._waitingAfterSegmentLimit = true;
					this._pendingSegmentLimitGapUs += frame.durationUs;
					continue;
				}
			}
			if (coalesces && previous) {
				previous.durationUs = Math.max(previous.timestampUs + previous.durationUs, frame.timestampUs + frame.durationUs) - previous.timestampUs;
				previous.frameCount += frame.frameCount;
				continue;
			}
			this._current.samples.push(cloneSample(frame));
		}
	}

	recordThought(thought: IComputerUseRecordingThought): void {
		if (this._finalized) {
			throw new Error('Cannot append a thought to a finalized Computer Use recording.');
		}
		const parsed = parseComputerUseRecordingThought(thought);
		if (parsed.timeMs < this._lastThoughtTimeMs) {
			throw new Error('Invalid Computer Use recording thought order.');
		}
		this._lastThoughtTimeMs = parsed.timeMs;
		const previous = this._thoughts.at(-1);
		if (previous?.timeMs === parsed.timeMs && previous.source === parsed.source) {
			this._thoughts[this._thoughts.length - 1] = parsed;
			return;
		}
		this._thoughts.push(parsed);
		if (this._thoughts.length > COMPUTER_USE_RECORDING_MAX_THOUGHTS) {
			this._thoughts.shift();
			this._trimmed = true;
		}
	}

	private _wouldExceedCurrent(frame: IComputerUseRecordingSample, coalesces: boolean): boolean {
		const current = this._current;
		if (!current) {
			return false;
		}
		const samples = current.samples;
		const sampleCount = samples.length + (coalesces ? 0 : 1);
		if (sampleCount > COMPUTER_USE_RECORDING_MAX_SEGMENT_SAMPLES) {
			return true;
		}
		const startTimestampUs = samples[0]?.timestampUs ?? frame.timestampUs;
		const latestEndUs = Math.max(
			frame.timestampUs + frame.durationUs,
			...samples.map(sample => sample.timestampUs + sample.durationUs),
		);
		if (latestEndUs - startTimestampUs > this._limits.maxSegmentDurationMs * 1000) {
			return true;
		}
		const payloadBytes = current.config.description.byteLength
			+ samples.reduce((total, sample) => total + sample.data.byteLength, 0)
			+ (coalesces ? 0 : frame.data.byteLength);
		const headerBudget = SEGMENT_HEADER_BASE_BUDGET_BYTES + sampleCount * SEGMENT_HEADER_SAMPLE_BUDGET_BYTES;
		return 4 + headerBudget + payloadBytes > this._limits.maxSegmentBytes;
	}

	async recordGap(reason: ComputerUseRecordingGapReason, durationMs: number): Promise<void> {
		if (this._finalized) {
			throw new Error('Cannot append a gap to a finalized Computer Use recording.');
		}
		if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > this._limits.maxDurationMs) {
			throw new Error('Invalid Computer Use recording gap duration.');
		}
		await this._flushCurrent();
		if (reason !== 'segmentLimit') {
			await this._flushSegmentLimitGap();
		}
		if (this._segments.length === 0) {
			return;
		}
		const last = this._gaps.at(-1);
		if (last?.reason === reason && last.startTimeMs + last.durationMs === this._timelineEndMs) {
			this._gaps[this._gaps.length - 1] = { ...last, durationMs: last.durationMs + durationMs };
		} else {
			this._gaps.push({ startTimeMs: this._timelineEndMs, durationMs, reason });
		}
		this._timelineEndMs += durationMs;
		if (this._gaps.length > COMPUTER_USE_RECORDING_MAX_GAPS) {
			this._gaps.shift();
			this._trimmed = true;
		}
		const evicted = this._applyRetention();
		await this._writeManifest(false);
		await Promise.all(evicted.map(segment => fs.rm(join(this._recordingDirectory.fsPath, segment.file), { force: true })));
	}

	async finalize(): Promise<IComputerUseRecordingFinalization | undefined> {
		if (this._finalized) {
			return this._result;
		}
		await this._flushCurrent();
		await this._flushSegmentLimitGap();
		this._finalized = true;
		if (this._segments.length === 0) {
			await fs.rm(this._recordingDirectory.fsPath, { recursive: true, force: true });
			return undefined;
		}
		const manifest = await this._writeManifest(true);
		this._result = {
			recordingUri: URI.file(join(this._recordingDirectory.fsPath, COMPUTER_USE_RECORDING_MANIFEST_FILE)).toString(),
			manifest,
		};
		return this._result;
	}

	private async _flushCurrent(): Promise<void> {
		const current = this._current;
		this._current = undefined;
		if (!current?.samples.length) {
			return;
		}
		const contents = serializeComputerUseRecordingSegment({
			streamId: current.streamId,
			target: current.target,
			config: current.config,
			samples: current.samples,
		});
		const file = `segment-${String(this._nextSegmentNumber++).padStart(6, '0')}.gop`;
		await writeFileAtomic(join(this._recordingDirectory.fsPath, file), contents);
		this._hasPersistedFrames = true;
		const header = parseComputerUseRecordingSegment(contents).header;
		const durationMs = Math.ceil(header.durationUs / 1000);
		const reference = {
			file,
			startTimeMs: current.startTimeMs,
			durationMs,
			sizeBytes: contents.byteLength,
			sampleCount: header.samples.length,
		};
		this._segments.push(reference);
		this._timelineEndMs = current.startTimeMs + durationMs;
		const evicted = this._applyRetention();
		await this._writeManifest(false);
		await Promise.all(evicted.map(segment => fs.rm(join(this._recordingDirectory.fsPath, segment.file), { force: true })));
	}

	private _currentDurationUs(): number {
		const samples = this._current?.samples;
		if (!samples?.length) {
			return 0;
		}
		const start = samples[0].timestampUs;
		return Math.max(...samples.map(sample => sample.timestampUs + sample.durationUs)) - start;
	}

	private _applyRetention(): IComputerUseRecordingSegmentReference[] {
		const evicted: IComputerUseRecordingSegmentReference[] = [];
		if (this._segments.length === 0) {
			return evicted;
		}
		let sizeBytes = this._segments.reduce((total, segment) => total + segment.sizeBytes, 0);
		const latestEnd = this._timelineEndMs;
		while (this._segments.length > 0) {
			const oldest = this._segments[0];
			const overDuration = latestEnd - oldest.startTimeMs > this._limits.maxDurationMs;
			if (!overDuration && sizeBytes <= this._limits.maxSizeBytes) {
				break;
			}
			this._segments.shift();
			evicted.push(oldest);
			sizeBytes -= oldest.sizeBytes;
			this._trimmed = true;
		}
		const firstStart = this._segments[0]?.startTimeMs;
		if (firstStart === undefined) {
			this._gaps.splice(0);
			this._thoughts.splice(0);
		} else {
			for (let index = this._gaps.length - 1; index >= 0; index--) {
				if (this._gaps[index].startTimeMs < firstStart) {
					this._gaps.splice(index, 1);
				}
			}
			while (this._thoughts[0]?.timeMs < firstStart) {
				this._thoughts.shift();
			}
		}
		return evicted;
	}

	private async _writeManifest(finalized: boolean): Promise<IComputerUseRecordingManifest> {
		const firstStart = this._segments[0]?.startTimeMs ?? 0;
		const lastEnd = Math.max(
			firstStart,
			...this._segments.map(segment => segment.startTimeMs + segment.durationMs),
			...this._gaps.map(gap => gap.startTimeMs + gap.durationMs),
		);
		const thoughts = this._thoughts.filter(thought => thought.timeMs >= firstStart && thought.timeMs <= lastEnd);
		const manifest = parseComputerUseRecordingManifest({
			version: COMPUTER_USE_RECORDING_FORMAT_VERSION,
			recordingId: this._recordingId,
			createdAt: this._createdAt,
			finalized,
			durationMs: lastEnd - firstStart,
			sizeBytes: this._segments.reduce((total, segment) => total + segment.sizeBytes, 0),
			trimmed: this._trimmed,
			segments: this._segments,
			gaps: this._gaps,
			...(thoughts.length > 0 ? { thoughts } : {}),
		});
		await writeFileAtomic(
			join(this._recordingDirectory.fsPath, COMPUTER_USE_RECORDING_MANIFEST_FILE),
			VSBuffer.fromString(JSON.stringify(manifest)).buffer,
		);
		return manifest;
	}

	private async _flushSegmentLimitGap(): Promise<void> {
		let durationMs = Math.ceil(this._pendingSegmentLimitGapUs / 1000);
		this._pendingSegmentLimitGapUs = 0;
		this._waitingAfterSegmentLimit = false;
		while (durationMs > 0) {
			const chunk = Math.min(durationMs, this._limits.maxDurationMs);
			await this.recordGap('segmentLimit', chunk);
			durationMs -= chunk;
		}
	}
}
