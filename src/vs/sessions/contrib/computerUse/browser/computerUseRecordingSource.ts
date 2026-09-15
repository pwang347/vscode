/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { type IFileContent, IFileService } from '../../../../platform/files/common/files.js';
import { COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES, COMPUTER_USE_RECORDING_MAX_SEGMENT_HEADER_BYTES, COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES, parseComputerUseRecordingManifestJson, parseComputerUseRecordingSegment, parseComputerUseRecordingSegmentHeader, type IComputerUseRecordingManifest, type IComputerUseRecordingSegmentHeader, type IParsedComputerUseRecordingSegment } from '../../../../platform/agentHost/common/computerUseRecording.js';
import { IComputerUseRecordingActionEvent, IComputerUseRecordingPreview, IComputerUseRecordingTimelineRange, IComputerUseSharedThought, IComputerUseVideoBatch, IComputerUseVideoCursor, IComputerUseVideoFrame, ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';

const PLAYBACK_BUFFER_MS = 250;
const PAUSE_DETECTION_MS = 100;
const MAX_PREVIEW_DECODE_FRAMES = 300;

/** Validated metadata displayed for a recorded Computer Use operation. */
export interface IComputerUseRecordingInfo {
	readonly manifest: IComputerUseRecordingManifest;
	readonly title?: string;
}

/** Replays a validated host-side recording without loading the bounded archive into memory. */
export class ComputerUseRecordingSource extends Disposable implements ISessionComputerUseVideoSource {
	readonly kind = 'recording' as const;
	readonly hostLabel: string;
	readonly recordingDurationMs: number;
	readonly recordingPositionMs = observableValue(this, 0);
	readonly thought = observableValue<IComputerUseSharedThought | undefined>(this, undefined);

	private segmentIndex = 0;
	private sampleIndex = 0;
	private sequence = 0;
	private segment: IParsedComputerUseRecordingSegment | undefined;
	private playbackStartedAt: number | undefined;
	private lastReadAt: number | undefined;
	private consumerHadCursor = false;
	private ended = false;
	private pendingSeekUs: number | undefined;
	private thoughtIndex = 0;
	private readonly firstSegmentStartMs: number;
	private timelineRanges: readonly IComputerUseRecordingTimelineRange[] | undefined;
	private previewSegment: { readonly index: number; readonly value: IParsedComputerUseRecordingSegment } | undefined;

	private constructor(
		readonly recordingUri: URI,
		readonly info: IComputerUseRecordingInfo,
		private readonly fileService: IFileService,
		private readonly now: () => number,
		hostLabel?: string,
	) {
		super();
		this.hostLabel = hostLabel ?? (recordingUri.authority
			? localize('computerUse.recording.remoteHost', "Recorded on {0}", recordingUri.authority)
			: localize('computerUse.recording.localHost', "Recorded on Local Agent Host"));
		this.firstSegmentStartMs = info.manifest.segments[0]?.startTimeMs ?? 0;
		this.recordingDurationMs = info.manifest.durationMs;
	}

	static async create(recordingUri: URI, fileService: IFileService, now: () => number = Date.now, hostLabel?: string, title?: string): Promise<ComputerUseRecordingSource> {
		let manifestFile: IFileContent;
		try {
			manifestFile = await fileService.readFile(recordingUri, { limits: { size: COMPUTER_USE_RECORDING_MAX_MANIFEST_BYTES } });
		} catch {
			throw new Error(localize('computerUse.recordingUnavailable', "This Computer Use recording was deleted or is no longer available."));
		}
		let manifest: IComputerUseRecordingManifest;
		try {
			manifest = parseComputerUseRecordingManifestJson(manifestFile.value.toString());
		} catch {
			throw new Error(localize('computerUse.recordingManifestInvalid', "This Computer Use recording has an invalid manifest."));
		}
		if (!manifest.finalized || manifest.segments.length === 0) {
			throw new Error(localize('computerUse.recordingNotFinalized', "This Computer Use recording is not finalized or contains no playable frames."));
		}
		return new ComputerUseRecordingSource(recordingUri, {
			manifest,
			...(title ? { title } : {}),
		}, fileService, now, hostLabel);
	}

	get playbackEnded(): boolean {
		return this.ended;
	}

	get title(): string | undefined {
		return this.info.title;
	}

	async read(cursor: IComputerUseVideoCursor | undefined, token: CancellationToken): Promise<IComputerUseVideoBatch> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (this.ended) {
			return { version: 1, status: 'idle' };
		}
		const now = this.now();
		if (this.playbackStartedAt === undefined) {
			this.playbackStartedAt = now;
		} else if (this.lastReadAt !== undefined && now - this.lastReadAt > PAUSE_DETECTION_MS) {
			this.playbackStartedAt += now - this.lastReadAt;
		}
		this.lastReadAt = now;
		const playbackPositionUs = (now - this.playbackStartedAt) * 1000;
		if (this.pendingSeekUs !== undefined) {
			const pendingSeekUs = this.pendingSeekUs;
			this.pendingSeekUs = undefined;
			await this.seekToKeyFrame(pendingSeekUs, token);
		}
		if (cursor) {
			this.consumerHadCursor = true;
		} else if (this.consumerHadCursor) {
			this.consumerHadCursor = false;
			await this.seekToKeyFrame(playbackPositionUs, token);
		}
		this.replayThoughtsThrough(playbackPositionUs / 1000);

		for (;;) {
			const segment = await this.getSegment(token);
			if (!segment) {
				this.ended = true;
				return { version: 1, status: 'idle' };
			}
			const reference = this.info.manifest.segments[this.segmentIndex];
			const playbackHorizonUs = (now - this.playbackStartedAt + PLAYBACK_BUFFER_MS) * 1000;
			const frames: IComputerUseVideoFrame[] = [];
			while (this.sampleIndex < segment.samples.length) {
				const sample = segment.samples[this.sampleIndex];
				const timestamp = (reference.startTimeMs - this.firstSegmentStartMs) * 1000
					+ sample.timestampUs - segment.header.startTimestampUs;
				if (timestamp > playbackHorizonUs && frames.length > 0) {
					break;
				}
				if (timestamp > playbackHorizonUs && this.sequence > 0) {
					break;
				}
				this.sampleIndex++;
				frames.push({
					sequence: ++this.sequence,
					timestamp,
					duration: sample.durationUs,
					keyFrame: sample.keyFrame,
					data: encodeBase64(VSBuffer.wrap(sample.data)),
					...(sample.focus ? { focus: sample.focus } : {}),
				});
			}
			const batch: IComputerUseVideoBatch = {
				version: 1,
				status: 'live',
				streamId: `${this.info.manifest.recordingId}:${segment.header.streamId}`,
				target: segment.header.target,
				config: {
					codec: segment.config.codec,
					codedWidth: segment.config.codedWidth,
					codedHeight: segment.config.codedHeight,
					description: encodeBase64(VSBuffer.wrap(segment.config.description)),
				},
				frames,
			};
			if (this.sampleIndex >= segment.samples.length) {
				this.segmentIndex++;
				this.sampleIndex = 0;
				this.segment = undefined;
			}
			return batch;
		}
	}

	async stop(): Promise<void> { }

	async readRecordingTimeline(token: CancellationToken): Promise<readonly IComputerUseRecordingTimelineRange[]> {
		if (this.timelineRanges) {
			return this.timelineRanges;
		}
		const ranges: IComputerUseRecordingTimelineRange[] = [];
		for (let index = 0; index < this.info.manifest.segments.length; index++) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const reference = this.info.manifest.segments[index];
			const header = await this.readSegmentHeader(index, token);
			for (const sample of header.samples) {
				if (sample.frameCount <= 1) {
					continue;
				}
				const firstFrameDurationUs = Math.max(1, Math.floor(sample.durationUs / sample.frameCount));
				const relativeStartUs = (reference.startTimeMs - this.firstSegmentStartMs) * 1000
					+ sample.timestampUs - header.startTimestampUs + firstFrameDurationUs;
				const endUs = relativeStartUs + sample.durationUs - firstFrameDurationUs;
				const startMs = Math.min(this.recordingDurationMs, Math.max(0, Math.floor(relativeStartUs / 1000)));
				const endMs = Math.min(this.recordingDurationMs, Math.max(startMs, Math.ceil(endUs / 1000)));
				if (endMs > startMs) {
					const previous = ranges.at(-1);
					if (previous && previous.startMs + previous.durationMs >= startMs) {
						ranges[ranges.length - 1] = {
							startMs: previous.startMs,
							durationMs: Math.max(previous.startMs + previous.durationMs, endMs) - previous.startMs,
						};
					} else {
						ranges.push({ startMs, durationMs: endMs - startMs });
					}
				}
			}
		}
		this.timelineRanges = ranges;
		return ranges;
	}

	async readRecordingActions(token: CancellationToken): Promise<readonly IComputerUseRecordingActionEvent[]> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		return (this.info.manifest.actions ?? []).map(action => ({
			timeMs: Math.min(this.recordingDurationMs, Math.max(0, action.timeMs - this.firstSegmentStartMs)),
			kind: action.kind,
		}));
	}

	async readRecordingPreview(positionMs: number, token: CancellationToken): Promise<IComputerUseRecordingPreview | undefined> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const clampedPositionMs = Math.min(this.recordingDurationMs, Math.max(0, Math.round(positionMs)));
		const absolutePositionMs = this.firstSegmentStartMs + clampedPositionMs;
		const segmentIndex = this.findNearestSegmentIndex(absolutePositionMs);
		if (segmentIndex < 0) {
			return undefined;
		}
		let segment: IParsedComputerUseRecordingSegment;
		if (this.previewSegment?.index === segmentIndex) {
			segment = this.previewSegment.value;
		} else {
			segment = await this.readSegmentAt(segmentIndex, token);
			this.previewSegment = { index: segmentIndex, value: segment };
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const reference = this.info.manifest.segments[segmentIndex];
		const localPositionUs = (absolutePositionMs - reference.startTimeMs) * 1000 + segment.header.startTimestampUs;
		const sampleIndex = Math.max(0, segment.samples.findLastIndex(sample => sample.timestampUs <= localPositionUs));
		const keyFrameIndex = segment.samples.findLastIndex((sample, index) => index <= sampleIndex && sample.keyFrame);
		if (keyFrameIndex < 0 || sampleIndex - keyFrameIndex + 1 > MAX_PREVIEW_DECODE_FRAMES) {
			return undefined;
		}
		return {
			config: {
				codec: segment.config.codec,
				codedWidth: segment.config.codedWidth,
				codedHeight: segment.config.codedHeight,
				description: encodeBase64(VSBuffer.wrap(segment.config.description)),
			},
			frames: segment.samples.slice(keyFrameIndex, sampleIndex + 1).map((sample, index) => ({
				sequence: index + 1,
				timestamp: sample.timestampUs,
				duration: sample.durationUs,
				keyFrame: sample.keyFrame,
				data: encodeBase64(VSBuffer.wrap(sample.data)),
				...(sample.focus ? { focus: sample.focus } : {}),
			})),
		};
	}

	restart(): void {
		this.seek(0);
	}

	seek(positionMs: number): void {
		const clampedPositionMs = Math.min(this.recordingDurationMs, Math.max(0, Math.round(positionMs)));
		const now = this.now();
		this.segmentIndex = 0;
		this.sampleIndex = 0;
		this.sequence = 0;
		this.segment = undefined;
		this.playbackStartedAt = now - clampedPositionMs;
		this.lastReadAt = now;
		this.consumerHadCursor = false;
		this.ended = false;
		this.pendingSeekUs = clampedPositionMs * 1000;
		this.thoughtIndex = this.info.manifest.thoughts?.findIndex(thought => thought.timeMs >= this.firstSegmentStartMs + clampedPositionMs) ?? -1;
		if (this.thoughtIndex < 0) {
			this.thoughtIndex = this.info.manifest.thoughts?.length ?? 0;
		}
		this.thought.set(undefined, undefined);
		this.recordingPositionMs.set(clampedPositionMs, undefined);
	}

	onFramePresented(timestampUs: number): void {
		const positionMs = Math.min(this.recordingDurationMs, Math.max(0, Math.round(timestampUs / 1000)));
		this.replayThoughtsThrough(positionMs);
		this.recordingPositionMs.set(positionMs, undefined);
	}

	onPlaybackEnded(): void {
		this.thought.set(undefined, undefined);
		this.recordingPositionMs.set(this.recordingDurationMs, undefined);
	}

	private replayThoughtsThrough(positionMs: number): void {
		const thoughts = this.info.manifest.thoughts;
		if (!thoughts) {
			return;
		}
		const absolutePositionMs = this.firstSegmentStartMs + positionMs;
		while (this.thoughtIndex < thoughts.length && thoughts[this.thoughtIndex].timeMs <= absolutePositionMs) {
			const thought = thoughts[this.thoughtIndex++];
			this.thought.set({
				source: thought.source,
				text: thought.text,
				streaming: thought.streaming,
			}, undefined);
		}
	}

	private async seekToKeyFrame(playbackPositionUs: number, token: CancellationToken): Promise<void> {
		const absolutePositionMs = this.firstSegmentStartMs + playbackPositionUs / 1000;
		this.segmentIndex = Math.max(0, this.info.manifest.segments.findLastIndex(reference => reference.startTimeMs <= absolutePositionMs));
		this.sampleIndex = 0;
		this.segment = undefined;
		const segment = await this.getSegment(token);
		if (!segment) {
			return;
		}
		const reference = this.info.manifest.segments[this.segmentIndex];
		for (let index = 1; index < segment.samples.length; index++) {
			const sample = segment.samples[index];
			const timestampUs = (reference.startTimeMs - this.firstSegmentStartMs) * 1000
				+ sample.timestampUs - segment.header.startTimestampUs;
			if (timestampUs > playbackPositionUs) {
				break;
			}
			if (sample.keyFrame) {
				this.sampleIndex = index;
			}
		}
	}

	private async getSegment(token: CancellationToken): Promise<IParsedComputerUseRecordingSegment | undefined> {
		if (this.segment) {
			return this.segment;
		}
		const reference = this.info.manifest.segments[this.segmentIndex];
		if (!reference) {
			return undefined;
		}
		this.segment = await this.readSegmentAt(this.segmentIndex, token);
		return this.segment;
	}

	private findNearestSegmentIndex(absolutePositionMs: number): number {
		const segments = this.info.manifest.segments;
		let index = segments.findLastIndex(reference => reference.startTimeMs <= absolutePositionMs);
		if (index < 0) {
			return segments.length > 0 ? 0 : -1;
		}
		const reference = segments[index];
		const next = segments[index + 1];
		if (next && absolutePositionMs > reference.startTimeMs + reference.durationMs
			&& next.startTimeMs - absolutePositionMs < absolutePositionMs - reference.startTimeMs - reference.durationMs) {
			index++;
		}
		return index;
	}

	private async readSegmentHeader(index: number, token: CancellationToken): Promise<IComputerUseRecordingSegmentHeader> {
		const reference = this.info.manifest.segments[index];
		const resource = joinPath(dirname(this.recordingUri), reference.file);
		let file: IFileContent;
		try {
			file = await this.fileService.readFile(resource, {
				position: 0,
				length: Math.min(reference.sizeBytes, COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES + COMPUTER_USE_RECORDING_MAX_SEGMENT_HEADER_BYTES),
				limits: { size: reference.sizeBytes },
			}, token);
		} catch {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			throw new Error(localize('computerUse.recordingSegmentUnavailable', "A Computer Use recording segment was deleted or is no longer available."));
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (file.size !== reference.sizeBytes) {
			throw new Error(localize('computerUse.recordingSegmentChanged', "A Computer Use recording segment changed or was deleted."));
		}
		let header: IComputerUseRecordingSegmentHeader;
		try {
			header = parseComputerUseRecordingSegmentHeader(file.value.buffer, reference.sizeBytes);
		} catch {
			throw new Error(localize('computerUse.recordingSegmentInvalid', "A Computer Use recording segment is invalid."));
		}
		if (header.samples.length !== reference.sampleCount || Math.ceil(header.durationUs / 1000) !== reference.durationMs) {
			throw new Error(localize('computerUse.recordingSegmentMismatch', "A Computer Use recording segment does not match its manifest."));
		}
		return header;
	}

	private async readSegmentAt(index: number, token: CancellationToken): Promise<IParsedComputerUseRecordingSegment> {
		const reference = this.info.manifest.segments[index];
		const resource = joinPath(dirname(this.recordingUri), reference.file);
		let file: IFileContent;
		try {
			file = await this.fileService.readFile(resource, { limits: { size: reference.sizeBytes } }, token);
		} catch {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			throw new Error(localize('computerUse.recordingSegmentUnavailable', "A Computer Use recording segment was deleted or is no longer available."));
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (file.value.byteLength !== reference.sizeBytes) {
			throw new Error(localize('computerUse.recordingSegmentChanged', "A Computer Use recording segment changed or was deleted."));
		}
		let segment: IParsedComputerUseRecordingSegment;
		try {
			segment = parseComputerUseRecordingSegment(file.value.buffer);
		} catch {
			throw new Error(localize('computerUse.recordingSegmentInvalid', "A Computer Use recording segment is invalid."));
		}
		if (segment.samples.length !== reference.sampleCount || Math.ceil(segment.header.durationUs / 1000) !== reference.durationMs) {
			throw new Error(localize('computerUse.recordingSegmentMismatch', "A Computer Use recording segment does not match its manifest."));
		}
		return segment;
	}
}
