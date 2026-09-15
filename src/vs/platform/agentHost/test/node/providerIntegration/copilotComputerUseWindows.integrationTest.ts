/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { CopilotClient, RuntimeConnection, ToolSet, type CopilotSession } from '@github/copilot-sdk';
// eslint-disable-next-line local/code-import-patterns -- This opt-in desktop test uses the existing root Playwright dev dependency.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { join, resolve } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../../common/agentHostTelemetry.js';
import { getAppNodeModulesUri } from '../../../node/appNodeModules.js';
import { createCopilotCliEnvironment } from '../../../node/copilot/copilotCliEnvironment.js';
import { COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR, COPILOT_COMPUTER_USE_SERVER_NAME, resolveCopilotComputerUsePlugin } from '../../../node/copilot/copilotComputerUse.js';
import { createIsolatedProviderEnvironment } from '../providerTestEnvironment.js';
import { applicationRowValidator, applicationTitleValidator, bounded, createCaptureMarker, findElementIndex, findFixtureWindow, FixtureConsent, getPlaywright, observationTimeout, parseApplicationRows, readNativeContent, type BrowserChannel, type CaptureMarker, type IFixtureWindow, type INativeArguments, type INativeContent } from './copilotComputerUseWindowsTestUtils.js';

const nativeTestsEnabled = isWindows && process.env['VSCODE_COMPUTER_USE_NATIVE_TEST'] === '1';

type NativeToolResult = Awaited<ReturnType<CopilotSession['rpc']['mcp']['apps']['callTool']>>;

interface IFixtureOptions {
	readonly seedText?: string;
	readonly denyAppConsent?: boolean;
}

async function readInput(page: Page, id: 'input' | 'guard') {
	return page.locator(`#${id}`).evaluate((input: HTMLInputElement) => ({
		value: input.value,
		selection: [input.selectionStart, input.selectionEnd],
		focused: input.ownerDocument.activeElement === input,
	}));
}

async function readTarget(page: Page) {
	return {
		input: await readInput(page, 'input'),
		status: await page.locator('#status').textContent(),
		scrollTop: await page.locator('#scroll').evaluate(element => element.scrollTop),
	};
}

async function readGuard(page: Page) {
	return {
		input: await readInput(page, 'guard'),
		events: await page.locator('body').getAttribute('data-input-events'),
	};
}

async function readForeground(target: Page, guard: Page) {
	return {
		target: await target.evaluate(() => document.hasFocus()),
		guard: await guard.evaluate(() => document.hasFocus()),
	};
}

async function assertGuardForeground(target: Page, guard: Page): Promise<void> {
	await getPlaywright().expect.poll(() => readForeground(target, guard), {
		timeout: observationTimeout,
		message: 'The guard must be foreground and the native target must remain background',
	}).toEqual({ target: false, guard: true });
}

async function createPages(context: BrowserContext, browser: Browser, id: string, marker: CaptureMarker, options: IFixtureOptions): Promise<{ target: Page; guard: Page }> {
	context.setDefaultTimeout(observationTimeout);
	await context.route('**/*', route => route.abort());
	await context.setOffline(true);
	const target = context.pages()[0] ?? await context.newPage();
	await target.setContent(`<!doctype html>
		<html lang="en"><head>
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
			<title>${id} target</title>
		</head><body>
			<h1>${id} target</h1>
			<label for="input">Fixture input</label><input id="input" type="text">
			<button id="button" type="button">Update Fixture Status</button>
			<output id="status" role="status">idle</output>
			<div id="scroll" tabindex="0" role="region" aria-label="Fixture scroll area" style="overflow: auto; height: 160px">
				<div style="height: 1600px">Fixture scroll content</div>
			</div>
			<div role="img" aria-label="Fixture capture marker" style="display: flex">
				${marker.map(color => `<span style="display: block; width: 24px; height: 48px; background: rgb(${color.join(',')})"></span>`).join('')}
			</div>
		</body></html>`);
	await target.locator('#button').evaluate(button => button.addEventListener('click', () => {
		const status = document.getElementById('status');
		if (status) {
			status.textContent = 'clicked';
		}
	}));
	if (options.seedText !== undefined) {
		await target.locator('#input').evaluate((input: HTMLInputElement, text) => {
			input.value = text;
			input.focus();
			input.setSelectionRange(text.length, text.length);
		}, options.seedText);
	}

	const connection = await browser.newBrowserCDPSession();
	let guard: Page;
	try {
		const targetConnection = await context.newCDPSession(target);
		let browserContextId: string | undefined;
		try {
			const { targetInfo } = await bounded(targetConnection.send('Target.getTargetInfo'), 'Identifying the fixture browser context');
			browserContextId = targetInfo.browserContextId;
		} finally {
			await bounded(targetConnection.detach(), 'Detaching the target context connection', observationTimeout);
		}
		const [, page] = await Promise.all([
			bounded(connection.send('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true, background: true, width: 720, height: 640 }), 'Creating the guard window'),
			context.waitForEvent('page'),
		]);
		guard = page;
		const windowIds: number[] = [];
		for (const [index, page] of [target, guard].entries()) {
			const pageConnection = await context.newCDPSession(page);
			try {
				// Playwright enables focus emulation by default, which hides the real foreground window.
				await bounded(pageConnection.send('Emulation.setFocusEmulationEnabled', { enabled: false }), 'Disabling fixture focus emulation');
				const { windowId } = await bounded(pageConnection.send('Browser.getWindowForTarget'), 'Identifying a fixture browser window');
				windowIds.push(windowId);
				await bounded(connection.send('Browser.setWindowBounds', {
					windowId,
					bounds: { left: 40 + index * 740, top: 40, width: 720, height: 640 },
				}), 'Positioning a fixture browser window');
			} finally {
				await bounded(pageConnection.detach(), 'Detaching the fixture page connection', observationTimeout);
			}
		}
		assert.notStrictEqual(windowIds[0], windowIds[1], 'The fixture must use two windows, not two tabs');
	} finally {
		await bounded(connection.detach(), 'Detaching the fixture browser connection', observationTimeout);
	}

	await guard.setContent(`<!doctype html>
		<html lang="en"><head>
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
			<title>${id} guard</title>
		</head><body data-input-events="0">
			<h1>${id} guard</h1>
			<label for="guard">Untouched guard input</label><input id="guard" type="text" value="${id} unchanged">
		</body></html>`);
	await guard.evaluate(() => {
		let events = 0;
		for (const event of ['input', 'keydown', 'pointerdown', 'wheel']) {
			document.addEventListener(event, () => {
				document.body.dataset.inputEvents = String(++events);
			}, true);
		}
	});
	await guard.bringToFront();
	await guard.locator('#guard').evaluate((input: HTMLInputElement) => {
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	});
	await assertGuardForeground(target, guard);
	return { target, guard };
}

class NativeFixture {
	private readonly results: { tool: keyof INativeArguments; arguments: object; isError: boolean; text: string; imageCount: number }[] = [];
	private readonly observations: { phase: string; target: Awaited<ReturnType<typeof readTarget>>; guard: Awaited<ReturnType<typeof readGuard>>; foreground: Awaited<ReturnType<typeof readForeground>> }[] = [];
	private verifiedImage: { bytes: Buffer; extension: string } | undefined;

	constructor(
		readonly page: Page,
		readonly guard: Page,
		readonly target: IFixtureWindow,
		private readonly session: CopilotSession,
		readonly consent: FixtureConsent,
		private readonly guardState: Awaited<ReturnType<typeof readGuard>>,
		private readonly title: string,
		private readonly marker: CaptureMarker,
	) { }

	async assertGuardUnchanged(): Promise<void> {
		assert.deepStrictEqual(await readGuard(this.guard), this.guardState, 'Native actions must not reach the guard window');
		await assertGuardForeground(this.page, this.guard);
	}

	async recordObservation(phase: string): Promise<void> {
		this.observations.push({
			phase,
			target: await readTarget(this.page),
			guard: await readGuard(this.guard),
			foreground: await readForeground(this.page, this.guard),
		});
	}

	async call<K extends keyof INativeArguments>(tool: K, args: INativeArguments[K]): Promise<INativeContent> {
		assert.strictEqual(this.consent.activeOperation, undefined, 'Native fixture operations must be serial');
		await this.assertGuardUnchanged();
		await this.recordObservation(`before-${tool}`);
		const arguments_ = { ...args, app: this.target.app, window: this.target.window };
		this.consent.activeOperation = { app: this.target.app, window: this.target.window, tool };
		try {
			let raw: NativeToolResult;
			try {
				raw = await bounded(this.session.rpc.mcp.apps.callTool({
					serverName: COPILOT_COMPUTER_USE_SERVER_NAME,
					originServerName: COPILOT_COMPUTER_USE_SERVER_NAME,
					toolName: tool,
					arguments: arguments_,
				}), `Native ${tool}`);
			} catch {
				throw new Error(`Native ${tool} failed or timed out (RPC payload omitted); no action was retried`);
			}
			const result = readNativeContent(raw);
			const text = tool !== 'get_window_state' || result.text.includes(this.title)
				? result.text : '[omitted: fixture snapshot identity was not verified]';
			this.results.push({ tool, arguments: arguments_, isError: result.isError, text, imageCount: result.images.length });
			assert.ok(!result.isError || (tool === 'get_window_state' && this.consent.counts.appDeclined === 1),
				`Native ${tool} refused the fixture operation; no further actions may be sent`);
			return result;
		} finally {
			this.consent.activeOperation = undefined;
			await this.recordObservation(`after-${tool}`);
			await this.assertGuardUnchanged();
			assert.strictEqual(this.consent.counts.unexpected, 0, 'Unexpected elicitations must be declined, never silently accepted');
		}
	}

	async element(role: 'AXTextField' | 'AXButton' | 'AXScrollArea', id: 'input' | 'button' | 'scroll'): Promise<number> {
		const snapshot = await this.call('get_window_state', { capture_mode: 'text', mode: 'full', request_budget_ms: 15_000 });
		assert.ok(!snapshot.isError && snapshot.images.length === 0 && snapshot.text.includes(this.title), 'Text snapshots must identify only the fixture and contain no image');
		return findElementIndex(snapshot.text, role, id);
	}

	async verifyImage(result: INativeContent): Promise<void> {
		assert.ok(!result.isError && result.images.length === 1, 'Window capture must return an actual native image');
		const image = result.images[0];
		assert.ok(image.mimeType === 'image/jpeg' || image.mimeType === 'image/png', 'The native window capture must be JPEG or PNG');
		assert.ok(/^[A-Za-z0-9+/]+={0,2}$/.test(image.data), 'The native image must contain base64 bytes');
		const bytes = Buffer.from(image.data, 'base64');
		const signature = image.mimeType === 'image/jpeg' ? [0xff, 0xd8, 0xff] : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		assert.ok(bytes.subarray(0, signature.length).equals(Buffer.from(signature)), 'The native image signature must match its MIME type');
		const decoded = await bounded(this.page.evaluate(async ({ image, colors }) => {
			const decodedImage = new Image();
			decodedImage.src = `data:${image.mimeType};base64,${image.data}`;
			await decodedImage.decode();
			const canvas = document.createElement('canvas');
			canvas.width = decodedImage.naturalWidth;
			canvas.height = decodedImage.naturalHeight;
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('The fixture needs a 2D canvas to verify native capture');
			}
			context.drawImage(decodedImage, 0, 0);
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
			let containsMarker = false;
			for (let y = 0; y < canvas.height && !containsMarker; y += 2) {
				let nextColor = 0;
				let run = 0;
				for (let x = 0; x < canvas.width; x++) {
					const offset = (y * canvas.width + x) * 4;
					const color = colors[nextColor];
					if (color.every((value, channel) => Math.abs(pixels[offset + channel] - value) < 30)) {
						if (++run >= 6) {
							run = 0;
							if (++nextColor === colors.length) {
								containsMarker = true;
								break;
							}
						}
					} else {
						run = 0;
					}
				}
			}
			return { width: canvas.width, height: canvas.height, containsMarker };
		}, { image, colors: this.marker }), 'Decoding the native fixture image');
		assert.ok(decoded.width > 64 && decoded.height > 48 && decoded.containsMarker, 'The decoded native image must contain the target-only capture marker, not the guard or another window');
		this.verifiedImage = { bytes, extension: image.mimeType === 'image/jpeg' ? 'jpg' : 'png' };
	}

	async saveEvidence(directory: string): Promise<void> {
		await writeFile(join(directory, 'native-target-results.json'), JSON.stringify({
			target: this.target,
			documentTitle: this.title,
			guardDocumentTitle: await this.guard.title(),
			consent: this.consent.counts,
			decisions: this.consent.decisions,
			results: this.results,
		}, undefined, '\t'));
		await writeFile(join(directory, 'dom-observations.json'), JSON.stringify(this.observations, undefined, '\t'));
		if (this.verifiedImage) {
			await writeFile(join(directory, `native-target.${this.verifiedImage.extension}`), this.verifiedImage.bytes);
		}
	}
}

async function stopClient(client: CopilotClient): Promise<void> {
	try {
		const errors = await bounded(client.stop(), 'Stopping the fixture runtime', 10_000);
		assert.strictEqual(errors.length, 0, 'The isolated runtime must stop cleanly (runtime logs omitted)');
	} catch {
		await bounded(client.forceStop(), 'Force-stopping the owned fixture runtime', 5_000);
		throw new Error('The isolated SDK runtime did not stop cleanly');
	}
}

async function withFixture(channel: BrowserChannel, name: string, options: IFixtureOptions, logService: NullLogService, run: (fixture: NativeFixture) => Promise<void>): Promise<void> {
	assert.ok(nativeTestsEnabled, 'Native GUI fixtures require Windows and VSCODE_COMPUTER_USE_NATIVE_TEST=1');
	assert.ok(!process.versions.electron || process.env['ELECTRON_RUN_AS_NODE'] === '1', 'Use the Node test runner, with standalone Node or Electron in Node mode; Playwright is unsupported in Electron renderers');
	const cliPath = URI.joinPath(getAppNodeModulesUri(), '@github', `copilot-${process.platform}-${process.arch}`, 'index.js').fsPath;
	const pluginPath = await resolveCopilotComputerUsePlugin({
		cliPath,
		platform: process.platform,
		hostLaunchKind: AgentHostLaunchKind.VSCodeMainProcess,
		isBuilt: false,
		developmentPluginPath: process.env[COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR],
	}, logService);
	assert.ok(pluginPath, 'The native Computer Use bundle must be available');
	const buildDirectory = join(process.cwd(), '.build');
	await mkdir(buildDirectory, { recursive: true });
	const home = await mkdtemp(join(buildDirectory, `computer-use-native-${channel}-`));
	let context: BrowserContext | undefined;
	let browser: Browser | undefined;
	let client: CopilotClient | undefined;
	let session: CopilotSession | undefined;
	let fixture: NativeFixture | undefined;
	let evidenceDirectory: string | undefined;
	const consent = new FixtureConsent(options.denyAppConsent ?? false);
	try {
		const outputDirectory = process.env['VSCODE_COMPUTER_USE_NATIVE_OUTPUT_DIR'];
		if (outputDirectory) {
			const outputRoot = resolve(outputDirectory);
			await mkdir(outputRoot, { recursive: true });
			evidenceDirectory = await mkdtemp(join(outputRoot, `${channel}-${name}-`));
		}
		const temporaryDirectory = join(home, 'runtime-temp');
		await mkdir(temporaryDirectory);
		const environment = createIsolatedProviderEnvironment(home, {
			...process.env,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
		});
		context = await getPlaywright().chromium.launchPersistentContext(join(home, 'browser-profile'), {
			channel: channel === 'msedge' ? 'msedge' : undefined,
			headless: false,
			chromiumSandbox: true,
			viewport: null,
			serviceWorkers: 'block',
			acceptDownloads: false,
			downloadsPath: join(home, 'downloads'),
			// Edge needs Windows known-folder resolution; the explicit browser profile stays isolated.
			env: {
				...process.env,
				TEMP: temporaryDirectory,
				TMP: temporaryDirectory,
				GH_TOKEN: undefined,
				GITHUB_TOKEN: undefined,
			},
			args: ['--force-renderer-accessibility'],
			timeout: 20_000,
		});
		browser = context.browser() ?? undefined;
		assert.ok(browser, 'A persistent Chromium context must own a browser');
		const nonce = randomUUID();
		const id = `vscode-native-${nonce}`;
		const marker = createCaptureMarker(nonce);
		const pages = await createPages(context, browser, id, marker, options);
		if (evidenceDirectory) {
			await writeFile(join(evidenceDirectory, 'fixture-setup.json'), JSON.stringify({
				documentTitle: await pages.target.title(),
				guardDocumentTitle: await pages.guard.title(),
				target: await readTarget(pages.target),
				guard: await readGuard(pages.guard),
				foreground: await readForeground(pages.target, pages.guard),
			}, undefined, '\t'));
		}
		client = new CopilotClient({
			mode: 'empty',
			connection: RuntimeConnection.forStdio({ path: cliPath }),
			baseDirectory: join(home, '.copilot'),
			workingDirectory: home,
			builtinPluginDirectories: [pluginPath],
			useLoggedInUser: false,
			logLevel: 'none',
			env: {
				...createCopilotCliEnvironment(environment, ['GH_TOKEN', 'GITHUB_TOKEN']),
				AUTO_APPROVAL: 'false',
				GH_TOKEN: undefined,
				GITHUB_TOKEN: undefined,
			},
		});
		await bounded(client.start(), 'Starting the isolated SDK runtime');
		session = await bounded(client.createSession({
			model: 'computer-use-native-test',
			workingDirectory: home,
			availableTools: new ToolSet().addMcp('*'),
			enableMcpApps: true,
			provider: { type: 'openai', wireApi: 'responses', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-a-real-key' },
			onPermissionRequest: () => {
				consent.counts.permissions++;
				return { kind: 'denied-interactively-by-user' };
			},
			onElicitationRequest: context => consent.respond(context),
		}), 'Creating the isolated SDK session');
		consent.sessionId = session.sessionId;
		const { tools } = await bounded(session.rpc.mcp.listTools({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME }), 'Listing native tool metadata');
		const requiredTools = ['list_apps', 'get_window_state'];
		assert.deepStrictEqual(requiredTools.filter(name => tools.some(tool => tool.name === name)), requiredTools);
		let listing: INativeContent;
		try {
			listing = readNativeContent(await bounded(session.rpc.mcp.apps.callTool({
				serverName: COPILOT_COMPUTER_USE_SERVER_NAME,
				originServerName: COPILOT_COMPUTER_USE_SERVER_NAME,
				toolName: 'list_apps',
				arguments: {},
			}), 'Discovering only the fixture windows'));
		} catch {
			throw new Error('Native fixture discovery failed (application listing omitted)');
		}
		assert.ok(!listing.isError && listing.images.length === 0, 'Application discovery must return text without desktop capture');
		const applications = parseApplicationRows(listing.text);
		if (evidenceDirectory) {
			// Diagnostic candidates never authorize an action; target selection below remains exact.
			const fixtureCandidates = applications
				.filter(row => applicationTitleValidator.validate(row).content?.title.includes(id))
				.map(row => applicationRowValidator.validate(row).content)
				.filter(row => row !== undefined);
			await writeFile(join(evidenceDirectory, 'fixture-discovery.json'), JSON.stringify({
				isError: listing.isError,
				textEmpty: listing.text.length === 0,
				imageCount: listing.images.length,
				consent: consent.counts,
				fixtureCandidates,
			}, undefined, '\t'));
		}
		const target = findFixtureWindow(applications, `${id} target`, channel);
		const guard = findFixtureWindow(applications, `${id} guard`, channel);
		assert.strictEqual(target.app, guard.app, 'Both fixture windows must belong to the same application');
		assert.notStrictEqual(target.window, guard.window, 'Native discovery must distinguish the two fixture windows');
		consent.target = target;
		fixture = new NativeFixture(pages.target, pages.guard, target, session, consent, await readGuard(pages.guard), `${id} target`, marker);
		try {
			await fixture.recordObservation('before-scenario');
			await run(fixture);
		} finally {
			try {
				await fixture.recordObservation('after-scenario');
				await fixture.assertGuardUnchanged();
				assert.deepStrictEqual({ unexpected: consent.counts.unexpected, permissions: consent.counts.permissions }, { unexpected: 0, permissions: 0 });
			} finally {
				if (evidenceDirectory) {
					await fixture.saveEvidence(evidenceDirectory);
				}
			}
		}
		assert.ok(options.denyAppConsent ? consent.counts.appDeclined === 1 : consent.counts.appAllowed > 0, 'Every fresh fixture must exercise initial application consent');
	} finally {
		consent.activeOperation = undefined;
		try {
			if (session) {
				await bounded(session.disconnect(), 'Disconnecting the fixture session', 10_000);
			}
		} finally {
			try {
				if (client) {
					await stopClient(client);
				}
			} finally {
				try {
					if (browser) {
						await bounded(browser.close(), 'Closing the fixture browser', 10_000);
					} else if (context) {
						await bounded(context.close(), 'Closing the fixture context', 10_000);
					}
				} finally {
					await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
				}
			}
		}
	}
}

(nativeTestsEnabled ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use Windows Native', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const channels: readonly BrowserChannel[] = process.env['VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST'] === '1' ? ['chromium', 'msedge'] : ['chromium'];
	const filter = nativeTestsEnabled && process.env['VSCODE_COMPUTER_USE_NATIVE_GREP'] ? new RegExp(process.env['VSCODE_COMPUTER_USE_NATIVE_GREP']) : undefined;
	for (const channel of channels) {
		suite(channel, function () {
			this.timeout(240_000);
			this.retries(0);

			function scenario(name: string, options: IFixtureOptions, run: (fixture: NativeFixture) => Promise<void>): void {
				(!filter || filter.test(`${channel} ${name}`) ? test : test.skip)(name, async function () {
					await withFixture(channel, name, options, store.add(new NullLogService()), run);
				});
			}

			scenario('type-text', {}, async fixture => {
				const index = await fixture.element('AXTextField', 'input');
				assert.strictEqual((await readInput(fixture.page, 'input')).value, '');
				await fixture.call('click', { element_index: index });
				const text = 'Typed by the native Windows fixture';
				await fixture.call('type_text', { element_index: index, text });
				await getPlaywright().expect.poll(async () => (await readInput(fixture.page, 'input')).value, {
					timeout: observationTimeout,
					message: 'Native type_text must change the DOM, including when dispatch is reported unverified',
				}).toBe(text);
			});

			scenario('focused-type-text', {}, async fixture => {
				const index = await fixture.element('AXTextField', 'input');
				await fixture.call('click', { element_index: index });
				const text = 'Typed into the selected window without an index';
				await fixture.call('type_text', { text });
				await getPlaywright().expect.poll(async () => (await readInput(fixture.page, 'input')).value, {
					timeout: observationTimeout,
					message: 'Focused native typing must stay in the selected window',
				}).toBe(text);
			});

			const seedText = 'Independently seeded selection text';
			scenario('select-all', { seedText }, async fixture => {
				const index = await fixture.element('AXTextField', 'input');
				assert.deepStrictEqual(await readInput(fixture.page, 'input'), { value: seedText, selection: [seedText.length, seedText.length], focused: true });
				await fixture.call('press_key', { element_index: index, key: 'ctrl+a' });
				await getPlaywright().expect.poll(() => readInput(fixture.page, 'input'), {
					timeout: observationTimeout,
					message: 'Native Ctrl+A must select the independently seeded DOM input',
				}).toEqual({ value: seedText, selection: [0, seedText.length], focused: true });
			});

			scenario('focused-select-all', { seedText }, async fixture => {
				const index = await fixture.element('AXTextField', 'input');
				await fixture.call('click', { element_index: index });
				await fixture.call('press_key', { key: 'ctrl+a' });
				await getPlaywright().expect.poll(() => readInput(fixture.page, 'input'), {
					timeout: observationTimeout,
					message: 'Focused native Ctrl+A must stay in the selected window',
				}).toEqual({ value: seedText, selection: [0, seedText.length], focused: true });
			});

			scenario('scroll', {}, async fixture => {
				const index = await fixture.element('AXScrollArea', 'scroll');
				assert.strictEqual(await fixture.page.locator('#scroll').evaluate(element => element.scrollTop), 0);
				await fixture.call('scroll', { element_index: index, dy: 5 });
				await getPlaywright().expect.poll(() => fixture.page.locator('#scroll').evaluate(element => element.scrollTop), {
					timeout: observationTimeout,
					message: 'Positive native dy must scroll the target DOM down',
				}).toBeGreaterThan(0);
			});

			scenario('button-click', {}, async fixture => {
				const index = await fixture.element('AXButton', 'button');
				assert.strictEqual(await fixture.page.locator('#status').textContent(), 'idle');
				await fixture.call('click', { element_index: index });
				await getPlaywright().expect.poll(() => fixture.page.locator('#status').textContent(), {
					timeout: observationTimeout,
					message: 'Native click must execute the fixture button handler',
				}).toBe('clicked');
			});

			scenario('capture', {}, async fixture => {
				const result = await fixture.call('get_window_state', { capture_mode: 'image', mode: 'full', request_budget_ms: 15_000 });
				await fixture.verifyImage(result);
			});

			scenario('decline-consent', { denyAppConsent: true }, async fixture => {
				const before = await readTarget(fixture.page);
				const result = await fixture.call('get_window_state', { capture_mode: 'text', mode: 'full', request_budget_ms: 15_000 });
				assert.ok(/\b(?:denied|declined|refused|not (?:allowed|authorized|granted))\b/i.test(result.text), 'Declining initial app consent must return an explicit refusal');
				assert.deepStrictEqual({
					target: await readTarget(fixture.page),
					images: result.images.length,
					consent: fixture.consent.counts,
				}, {
					target: before,
					images: 0,
					consent: { appAllowed: 0, appDeclined: 1, foregroundAllowed: 0, unexpected: 0, permissions: 0 },
				});
			});
		});
	}
});
