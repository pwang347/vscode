/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { nativeVideoTestsEnabled } from './copilotComputerUseVideoTestUtils.js';
import type { INativeContent } from './copilotComputerUseWindowsTestUtils.js';

export const typingPayloadLength = 4096;
export const typingQuietWindowMs = 2000;

export interface ITypingSample {
	readonly length: number;
	readonly matchesPrefix: boolean;
	readonly inputEvents: number;
	readonly lastInputAt: number | undefined;
	readonly sampledAt: number;
	readonly focused: boolean;
	readonly selection: readonly (number | null)[];
}

export interface ITypingProbe {
	read(): ITypingSample;
	dispose(): void;
}

export interface ITypingInterruptionObservation {
	readonly requestedLength: number;
	readonly beforeStopLength: number;
	readonly acknowledgedLength: number;
	readonly finalLength: number;
	readonly inputEventsAtAcknowledgement: number;
	readonly inputEventsAfterQuietWindow: number;
	readonly quietWindowMs: number;
	readonly stopAcknowledgementMs: number;
	readonly nativeResultIsError: boolean;
}

export function nativeTypingStopTestsEnabled(platform: string, environment: NodeJS.ProcessEnv): boolean {
	return nativeVideoTestsEnabled(platform, environment) && environment.VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST === '1';
}

/** Installs an empty fixture-owned input and observes native input without generating any input events itself. */
export function createTypingProbe(text: string): ITypingProbe {
	if (document.getElementById('input')) {
		throw new Error('The typing fixture must own its exact input element');
	}
	const container = document.createElement('p');
	const label = document.createElement('label');
	label.htmlFor = 'input';
	label.textContent = 'Interruptible fixture input';
	const input = document.createElement('input');
	input.id = 'input';
	input.type = 'text';
	input.autocomplete = 'off';
	input.spellcheck = false;
	container.append(label, input);
	document.body.append(container);
	const controller = new AbortController();
	let inputEvents = 0;
	let lastInputAt: number | undefined;
	input.addEventListener('input', () => {
		inputEvents++;
		lastInputAt = Date.now();
	}, { signal: controller.signal });
	return {
		read: () => ({
			length: input.value.length,
			matchesPrefix: text.startsWith(input.value),
			inputEvents,
			lastInputAt,
			sampledAt: Date.now(),
			focused: document.activeElement === input,
			selection: [input.selectionStart, input.selectionEnd],
		}),
		dispose: () => {
			controller.abort();
			container.remove();
		},
	};
}

export function assertPartialNativeTyping(sample: ITypingSample, requestedLength: number): void {
	assert.ok(sample.matchesPrefix && sample.length >= 32 && sample.length < requestedLength && sample.inputEvents > 0,
		'Native typing must produce a real, incomplete fixture prefix before Stop (text omitted)');
}

export function assertTypingUnchangedAfterStop(acknowledged: ITypingSample, current: ITypingSample, acknowledgedAt: number): void {
	assert.ok(current.sampledAt >= acknowledgedAt, 'The fixture and runner must observe the same Windows wall clock');
	assert.ok(current.lastInputAt === undefined || current.lastInputAt <= acknowledgedAt,
		'No native input event may arrive after Stop acknowledgement (text omitted)');
	assert.deepStrictEqual({
		length: current.length, matchesPrefix: current.matchesPrefix, inputEvents: current.inputEvents,
		selection: current.selection, focused: current.focused,
	}, {
		length: acknowledged.length, matchesPrefix: true, inputEvents: acknowledged.inputEvents,
		selection: acknowledged.selection, focused: acknowledged.focused,
	}, 'Text, input-event count and selection must stay unchanged after Stop acknowledgement');
}

export function assertInterruptedTypingResult(result: INativeContent): void {
	assert.ok(result.images.length === 0, 'Interrupted text input must not return media');
	assert.ok(!result.isError || /\b(?:stopped|cancelled|canceled)\b/i.test(result.text),
		'Only an explicit Stop/cancellation refusal is expected from the interrupted native action (payload omitted)');
}
