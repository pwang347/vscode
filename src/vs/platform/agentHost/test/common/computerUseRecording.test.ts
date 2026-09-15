/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { COMPUTER_USE_RECORDING_MAX_THOUGHTS, COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH, COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES, parseComputerUseRecordingManifest, parseComputerUseRecordingSegment, parseComputerUseRecordingSegmentHeader, serializeComputerUseRecordingSegment } from '../../common/computerUseRecording.js';

suite('Computer Use Recording Contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('validates manifest segment paths and totals', () => {
		const manifest = {
			version: 1,
			recordingId: 'recording-1',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 34,
			sizeBytes: 128,
			trimmed: false,
			segments: [{
				file: 'segment-000001.gop',
				startTimeMs: 0,
				durationMs: 34,
				sizeBytes: 128,
				sampleCount: 1,
			}],
			gaps: [],
		} as const;

		assert.deepStrictEqual(parseComputerUseRecordingManifest(manifest), manifest);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			segments: [{ ...manifest.segments[0], file: '../outside.gop' }],
		}), /segment path/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			gaps: [{ startTimeMs: 0, durationMs: 1, reason: 'readError' }],
		}), /gap overlap/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			durationMs: 50,
			gaps: [
				{ startTimeMs: 40, durationMs: 10, reason: 'readError' },
				{ startTimeMs: 35, durationMs: 1, reason: 'cursorReset' },
			],
		}), /gap order/i);
	});

	test('validates optional bounded thought events without requiring them on old manifests', () => {
		const manifest = {
			version: 1,
			recordingId: 'recording-1',
			createdAt: '2026-09-14T20:00:00.000Z',
			finalized: true,
			durationMs: 34,
			sizeBytes: 128,
			trimmed: false,
			segments: [{
				file: 'segment-000001.gop',
				startTimeMs: 10,
				durationMs: 34,
				sizeBytes: 128,
				sampleCount: 1,
			}],
			gaps: [],
		} as const;
		const thoughts = [
			{ timeMs: 10, source: 'reasoning', text: 'Inspecting the page', streaming: true },
			{ timeMs: 10, source: 'reasoning', text: 'Inspecting the page.', streaming: false },
			{ timeMs: 44, source: 'activity', text: 'Clicking the button', streaming: false },
		] as const;

		assert.deepStrictEqual(parseComputerUseRecordingManifest({ ...manifest, thoughts }), { ...manifest, thoughts });
		assert.strictEqual(parseComputerUseRecordingManifest(manifest).thoughts, undefined);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: Array.from({ length: COMPUTER_USE_RECORDING_MAX_THOUGHTS + 1 }, (_, timeMs) => ({
				timeMs,
				source: 'reasoning',
				text: 'Thinking',
				streaming: true,
			})),
		}), /thoughts/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: 10, source: 'reasoning', text: 'x'.repeat(COMPUTER_USE_RECORDING_MAX_THOUGHT_TEXT_LENGTH + 1), streaming: true }],
		}), /thought text/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: 10, source: 'reasoning', text: 'unsafe\u0000text', streaming: true }],
		}), /thought text/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: 10, source: 'privateReasoning', text: 'Thinking', streaming: true }],
		}), /thought source/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: 10, source: 'reasoning', text: 'Thinking', streaming: 'true' }],
		}), /thought streaming/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [
				{ timeMs: 20, source: 'reasoning', text: 'First', streaming: true },
				{ timeMs: 19, source: 'reasoning', text: 'Second', streaming: true },
			],
		}), /thought order/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: Number.MAX_SAFE_INTEGER + 1, source: 'activity', text: 'Unsafe timestamp', streaming: false }],
		}), /timeMs/i);
		assert.throws(() => parseComputerUseRecordingManifest({
			...manifest,
			thoughts: [{ timeMs: 45, source: 'activity', text: 'Outside playback', streaming: false }],
		}), /thought timeline/i);
	});

	test('serializes decoder configuration and AVCC samples as bounded binary payloads', () => {
		const bytes = serializeComputerUseRecordingSegment({
			streamId: 'stream-1',
			target: { app: 'Code', windowId: 7, title: 'Editor' },
			config: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
				description: Uint8Array.of(1, 2, 3, 4),
			},
			samples: [{
				sequence: 4,
				timestampUs: 1_000_000,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				focus: { x: 0.25, y: 0.75 },
				data: Uint8Array.of(5, 6, 7),
			}, {
				sequence: 5,
				timestampUs: 1_033_333,
				durationUs: 66_666,
				keyFrame: false,
				frameCount: 2,
				data: Uint8Array.of(8, 9),
			}],
		});

		const parsed = parseComputerUseRecordingSegment(bytes);
		const headerLength = VSBuffer.wrap(bytes).readUInt32BE(0);
		const parsedHeader = parseComputerUseRecordingSegmentHeader(
			bytes.subarray(0, COMPUTER_USE_RECORDING_SEGMENT_HEADER_LENGTH_BYTES + headerLength),
			bytes.byteLength,
		);
		assert.deepStrictEqual({
			header: parsed.header,
			headerOnly: {
				durationUs: parsedHeader.durationUs,
				sampleCount: parsedHeader.samples.length,
				lastSampleLength: parsedHeader.samples.at(-1)?.length,
			},
			description: [...parsed.config.description],
			samples: parsed.samples.map(sample => ({ ...sample, data: [...sample.data] })),
		}, {
			header: {
				version: 1,
				streamId: 'stream-1',
				target: { app: 'Code', windowId: 7, title: 'Editor' },
				config: {
					codec: 'avc1.64001f',
					codedWidth: 1280,
					codedHeight: 720,
					descriptionOffset: 0,
					descriptionLength: 4,
				},
				startTimestampUs: 1_000_000,
				durationUs: 99_999,
				samples: [{
					sequence: 4,
					timestampUs: 1_000_000,
					durationUs: 33_333,
					keyFrame: true,
					frameCount: 1,
					focus: { x: 0.25, y: 0.75 },
					offset: 4,
					length: 3,
				}, {
					sequence: 5,
					timestampUs: 1_033_333,
					durationUs: 66_666,
					keyFrame: false,
					frameCount: 2,
					offset: 7,
					length: 2,
				}],
			},
			headerOnly: {
				durationUs: 99_999,
				sampleCount: 2,
				lastSampleLength: 2,
			},
			description: [1, 2, 3, 4],
			samples: [{
				sequence: 4,
				timestampUs: 1_000_000,
				durationUs: 33_333,
				keyFrame: true,
				frameCount: 1,
				focus: { x: 0.25, y: 0.75 },
				data: [5, 6, 7],
			}, {
				sequence: 5,
				timestampUs: 1_033_333,
				durationUs: 66_666,
				keyFrame: false,
				frameCount: 2,
				data: [8, 9],
			}],
		});
	});
});
