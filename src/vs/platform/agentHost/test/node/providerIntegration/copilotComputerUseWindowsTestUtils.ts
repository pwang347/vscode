/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createRequire } from 'module';
import type { ElicitationContext, ElicitationResult } from '@github/copilot-sdk';
import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { hasKey, isObject } from '../../../../../base/common/types.js';
import { vArray, vBoolean, vLiteral, vNumber, vObj, vOptionalProp, vString, vUnion } from '../../../../../base/common/validation.js';
import { killTree } from '../../../../../base/node/processes.js';
import { COPILOT_COMPUTER_USE_SERVER_NAME } from '../../../node/copilot/copilotComputerUse.js';

const nativeTimeout = 25_000;
export const observationTimeout = 5_000;
const foregroundMessage = 'Computer use can\'t finish this action in the background. Allow foreground actions?';
const capturePalette = [[240, 16, 240], [16, 240, 16], [16, 240, 240], [240, 16, 16], [240, 240, 16], [16, 16, 240]] as const;
const nativeContentValidator = vObj({
	isError: vOptionalProp(vBoolean()),
	content: vArray(vUnion(
		vObj({ type: vLiteral('text'), text: vString() }),
		vObj({ type: vLiteral('image'), mimeType: vString(), data: vString() }),
	)),
});
export const applicationTitleValidator = vObj({ title: vString() });
export const applicationRowValidator = vObj({ app: vString(), name: vString(), window: vNumber(), title: vString(), running: vBoolean() });

export type BrowserChannel = 'chromium' | 'msedge';
export type CaptureMarker = readonly (readonly [number, number, number])[];
type Playwright = typeof import('@playwright/test');
let playwright: Playwright | undefined;

/** Loads the dev-only driver through Node, outside Electron's production-package import map. */
export function getPlaywright(): Playwright {
	playwright ??= createRequire(import.meta.url)('@playwright/test') as Playwright;
	return playwright;
}

export interface IFixtureWindow {
	readonly app: string;
	readonly name: string;
	readonly window: number;
	readonly title: string;
}

export interface INativeArguments {
	get_window_state: { capture_mode: 'text' | 'image'; mode: 'full'; request_budget_ms: number };
	click: { element_index: number };
	type_text: { element_index?: number; text: string };
	press_key: { element_index?: number; key: 'ctrl+a' };
	scroll: { element_index: number; dy: number };
}

interface INativeImage {
	readonly mimeType: string;
	readonly data: string;
}

export interface INativeContent {
	readonly isError: boolean;
	readonly text: string;
	readonly images: readonly INativeImage[];
}

export async function bounded<T>(promise: Promise<T>, operation: string, timeout = nativeTimeout): Promise<T> {
	const result = await raceTimeout(promise.then(value => ({ value })), timeout);
	assert.ok(result, `${operation} timed out; no native action will be retried`);
	return result.value;
}

function processRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isObject(error) && error.code === 'ESRCH') {
			return false;
		}
		throw new Error('Could not verify termination of an owned fixture process');
	}
}

export async function rememberOwnedProcesses(rootPid: number, owned: Set<number>): Promise<void> {
	owned.add(rootPid);
	if (!processRunning(rootPid)) {
		return;
	}
	const { getProcessList } = createRequire(import.meta.url)('@vscode/windows-process-tree') as typeof import('@vscode/windows-process-tree');
	const pids = await bounded(new Promise<number[]>((resolve, reject) => {
		getProcessList(rootPid, processes => {
			if (!processes) {
				reject(new Error('Could not enumerate descendants of the owned fixture process'));
				return;
			}
			resolve(processes.map(process => process.pid));
		});
	}), 'Remembering owned fixture descendants', observationTimeout);
	for (const pid of pids) {
		owned.add(pid);
	}
}

export async function closeOwnedProcesses(owned: Set<number>, close: () => Promise<void>, gracefulTimeout = 10_000): Promise<void> {
	const errors: Error[] = [];
	try {
		await bounded(close(), 'Closing owned fixture processes', gracefulTimeout);
	} catch {
		errors.push(new Error('Graceful fixture process shutdown failed'));
	}
	const deadline = Date.now() + observationTimeout;
	while ([...owned].some(processRunning) && Date.now() < deadline) {
		await timeout(100);
	}
	for (const pid of owned) {
		if (processRunning(pid)) {
			try {
				await bounded(killTree(pid, true), 'Terminating an owned fixture process tree', observationTimeout);
			} catch {
				errors.push(new Error('Forced cleanup of an owned fixture process tree failed'));
			}
			errors.push(new Error('A fixture process outlived graceful shutdown and required forced cleanup'));
		}
	}
	assert.ok(![...owned].some(processRunning), 'All owned native/browser descendants must exit before removing profiles');
	if (errors.length) {
		throw new AggregateError(errors, 'Fixture process cleanup failed');
	}
}

export function readNativeContent(result: unknown): INativeContent {
	const validated = nativeContentValidator.validate(result).content;
	assert.ok(validated, 'The native tool must return text/image MCP content (result omitted)');
	const text: string[] = [];
	const images: INativeImage[] = [];
	for (const block of validated.content) {
		if (block.type === 'text') {
			text.push(block.text);
		} else {
			images.push({ mimeType: block.mimeType, data: block.data });
		}
	}
	return { isError: validated.isError ?? false, text: text.join('\n'), images };
}

/** Never include unfiltered application listings, even in assertion or JSON parse errors. */
export function parseApplicationRows(text: string): readonly unknown[] {
	try {
		return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
	} catch {
		throw new Error('list_apps must return JSONL application rows (listing omitted)');
	}
}

export function findFixtureWindow(rows: readonly unknown[], title: string, channel: BrowserChannel): IFixtureWindow {
	const suffixes = channel === 'msedge'
		? ['Microsoft Edge', 'Microsoft\u200b Edge', 'Profile 1 - Microsoft Edge', 'Profile 1 - Microsoft\u200b Edge', 'Work - Microsoft Edge', 'Work - Microsoft\u200b Edge']
		: ['Chromium', 'Google Chrome for Testing'];
	const titles = new Set([title, ...suffixes.map(suffix => `${title} - ${suffix}`)]);
	const matches: IFixtureWindow[] = [];
	for (const row of rows) {
		const rowTitle = applicationTitleValidator.validate(row).content?.title;
		if (!rowTitle || !titles.has(rowTitle)) {
			continue;
		}
		const application = applicationRowValidator.validate(row).content;
		assert.ok(application, 'The exact fixture must have a valid application row (listing omitted)');
		assert.ok(application.app.length > 0 && application.name.length > 0 && Number.isSafeInteger(application.window) && application.window > 0
			&& application.running, 'The exact fixture row must identify a running application and opaque window');
		matches.push(application);
	}
	assert.strictEqual(matches.length, 1, 'Exactly one native window must match the unique fixture title');
	return matches[0];
}

export function findElementIndex(text: string, role: 'AXTextField' | 'AXButton' | 'AXScrollArea', id: 'input' | 'button' | 'scroll'): number {
	for (const line of text.split(/\r?\n/)) {
		const node = /^\s*(?<index>\d+)\s+(?<role>AX\w+)\b/.exec(line);
		const automationId = /\bID:\s*(?<id>\S+)/.exec(line);
		if (node?.groups?.role === role && automationId?.groups?.id === id) {
			const index = Number(node.groups.index);
			assert.ok(Number.isSafeInteger(index), 'Fixture element indices must be safe integers');
			// Chromium exposes duplicate legacy UIA aliases; the first exact role + ID is authoritative.
			return index;
		}
	}
	throw new Error(`The fixture snapshot must contain ${role} with automation ID ${id}`);
}

export function createCaptureMarker(nonce: string): CaptureMarker {
	let index = 0;
	return [...nonce.replace(/-/g, '').slice(0, 16)].map(digit => {
		index = (index + 1 + parseInt(digit, 16) % (capturePalette.length - 1)) % capturePalette.length;
		return capturePalette[index];
	});
}

export function isFixtureApplicationConsentMessage(message: string | undefined, name: string): boolean {
	return message === `Allow Copilot Computer Use to use ${name}?`
		|| message === `Copilot Computer Use wants to use ${name}.`;
}

export class FixtureConsent {
	sessionId: string | undefined;
	target: IFixtureWindow | undefined;
	activeOperation: { readonly app: string; readonly window: number; readonly tool: keyof INativeArguments } | undefined;
	readonly counts = { appAllowed: 0, appDeclined: 0, foregroundAllowed: 0, unexpected: 0, permissions: 0 };
	readonly decisions: { app: string; window: number; tool: keyof INativeArguments; scope: 'application' | 'foreground'; choice: 'allow' | 'allow_foreground' | 'decline'; message: string; sessionId: string }[] = [];

	constructor(private readonly denyAppConsent: boolean) { }

	respond(context: ElicitationContext): ElicitationResult {
		const target = this.target;
		const operation = this.activeOperation;
		const choice = context.requestedSchema?.properties.choice;
		const choices = choice?.type === 'string'
			? hasKey(choice, { enum: true }) ? choice.enum : hasKey(choice, { oneOf: true }) ? choice.oneOf.map(option => option.const) : []
			: [];
		if (!target || !operation || operation.app !== target.app || operation.window !== target.window
			|| context.sessionId !== this.sessionId || context.elicitationSource !== COPILOT_COMPUTER_USE_SERVER_NAME
			|| (context.mode !== undefined && context.mode !== 'form')
			|| context.requestedSchema?.type !== 'object') {
			this.counts.unexpected++;
			return { action: 'decline' };
		}
		if (isFixtureApplicationConsentMessage(context.message, target.name) && choices.includes('allow')) {
			if (this.denyAppConsent) {
				this.counts.appDeclined++;
				return this.recordDecision(context, 'application', 'decline');
			}
			this.counts.appAllowed++;
			return this.recordDecision(context, 'application', 'allow');
		}
		if (!this.denyAppConsent && operation.tool !== 'get_window_state'
			&& context.message === foregroundMessage && choices.includes('allow_foreground')) {
			this.counts.foregroundAllowed++;
			return this.recordDecision(context, 'foreground', 'allow_foreground');
		}
		this.counts.unexpected++;
		return { action: 'decline' };
	}

	private recordDecision(context: ElicitationContext, scope: 'application' | 'foreground', choice: 'allow' | 'allow_foreground' | 'decline'): ElicitationResult {
		assert.ok(this.activeOperation);
		this.decisions.push({ ...this.activeOperation, scope, choice, message: context.message, sessionId: context.sessionId });
		return choice === 'decline' ? { action: 'decline' } : { action: 'accept', content: { choice } };
	}
}
