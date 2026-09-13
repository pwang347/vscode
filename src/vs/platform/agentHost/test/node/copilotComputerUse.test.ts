/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../common/agentHostTelemetry.js';
import { resolveCopilotComputerUsePlugin } from '../../node/copilot/copilotComputerUse.js';

class ComputerUseLogService extends NullLogService {
	readonly warnings: string[] = [];

	override warn(message: string): void {
		this.warnings.push(message);
	}
}

suite('Copilot Computer Use', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let logService: ComputerUseLogService;

	setup(async () => {
		root = await fs.mkdtemp(join(os.tmpdir(), 'vscode-computer-use-'));
		logService = store.add(new ComputerUseLogService());
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function options(overrides: Partial<Parameters<typeof resolveCopilotComputerUsePlugin>[0]> = {}): Parameters<typeof resolveCopilotComputerUsePlugin>[0] {
		return {
			cliPath: join(root, 'index.js'),
			platform: 'darwin',
			hostLaunchKind: AgentHostLaunchKind.VSCodeMainProcess,
			isBuilt: false,
			...overrides,
		};
	}

	async function createPlugin(path: string, appName = 'Copilot Computer Use.app'): Promise<void> {
		const files = new Map([
			[join(path, '.plugin', 'plugin.json'), JSON.stringify({ name: 'computer-use' })],
			[join(path, '.mcp.json'), '{}'],
			[join(path, 'computer-use-mcp'), 'mcp'],
			[join(path, appName, 'Contents', 'Info.plist'), 'plist'],
			[join(path, appName, 'Contents', 'MacOS', 'computer-use'), 'native'],
		]);
		for (const [file, content] of files) {
			await fs.mkdir(dirname(file), { recursive: true });
			await fs.writeFile(file, content);
		}
	}

	test('resolves the bundled macOS plugin without launching a process', async () => {
		const plugin = join(root, 'plugins', 'computer-use');
		await createPlugin(plugin);

		assert.deepStrictEqual({
			path: await resolveCopilotComputerUsePlugin(options(), logService),
			warnings: logService.warnings,
		}, { path: plugin, warnings: [] });
	});

	test('uses a source-built helper only in development builds', async () => {
		const bundled = join(root, 'plugins', 'computer-use');
		const development = join(root, 'development');
		await createPlugin(bundled);
		await createPlugin(development, 'Copilot Computer Use Dev.app');

		assert.deepStrictEqual({
			development: await resolveCopilotComputerUsePlugin(options({ developmentPluginPath: development }), logService),
			packaged: await resolveCopilotComputerUsePlugin(options({ developmentPluginPath: development, isBuilt: true }), logService),
		}, { development, packaged: bundled });
	});

	test('does not expose the local desktop to standalone, remote, or non-macOS hosts', async () => {
		const excluded = [
			options({ hostLaunchKind: AgentHostLaunchKind.VSCodeCLI }),
			options({ hostLaunchKind: AgentHostLaunchKind.Unknown }),
			options({ platform: 'linux' }),
			options({ platform: 'win32' }),
		];

		assert.deepStrictEqual({
			paths: await Promise.all(excluded.map(option => resolveCopilotComputerUsePlugin(option, logService))),
			warnings: logService.warnings,
		}, { paths: [undefined, undefined, undefined, undefined], warnings: [] });
	});

	test('reports a missing optional bundle', async () => {
		const result = await resolveCopilotComputerUsePlugin(options(), logService);

		assert.deepStrictEqual({
			path: result,
			reported: logService.warnings.map(message => message.includes('Computer Use is unavailable')),
		}, { path: undefined, reported: [true] });
	});

	test('exposes the native bundle on a macOS remote host only after host-side opt-in', async () => {
		const plugin = join(root, 'plugins', 'computer-use');
		await createPlugin(plugin);

		assert.deepStrictEqual({
			disabled: await resolveCopilotComputerUsePlugin(options({ hostLaunchKind: AgentHostLaunchKind.Unknown }), logService),
			enabled: await resolveCopilotComputerUsePlugin(options({ hostLaunchKind: AgentHostLaunchKind.Unknown, remoteEnabled: true }), logService),
			unsupported: await resolveCopilotComputerUsePlugin(options({ platform: 'linux', remoteEnabled: true }), logService),
		}, { disabled: undefined, enabled: plugin, unsupported: undefined });
	});

	test('rejects a relative development override', async () => {
		await assert.rejects(resolveCopilotComputerUsePlugin(options({ developmentPluginPath: '../computer-use' }), logService), /must be an absolute path/);
	});

	test('does not silently fall back when a development override is missing', async () => {
		await createPlugin(join(root, 'plugins', 'computer-use'));

		await assert.rejects(resolveCopilotComputerUsePlugin(options({ developmentPluginPath: join(root, 'missing') }), logService), /ENOENT/);
	});

	test('rejects a bundle with a missing native executable', async () => {
		const plugin = join(root, 'plugins', 'computer-use');
		await createPlugin(plugin);
		await fs.unlink(join(plugin, 'Copilot Computer Use.app', 'Contents', 'MacOS', 'computer-use'));

		await assert.rejects(resolveCopilotComputerUsePlugin(options(), logService), /native helper has no executable/);
	});

	test('rejects a different plugin identity', async () => {
		const plugin = join(root, 'plugins', 'computer-use');
		await createPlugin(plugin);
		await fs.writeFile(join(plugin, '.plugin', 'plugin.json'), JSON.stringify({ name: 'another-plugin' }));

		await assert.rejects(resolveCopilotComputerUsePlugin(options(), logService), /Invalid Computer Use plugin manifest/);
	});
});
