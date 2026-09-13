/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { CopilotClient, RuntimeConnection, ToolSet, type CopilotSession, type SessionConfig } from '@github/copilot-sdk';
import { join } from '../../../../../base/common/path.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../../common/agentHostTelemetry.js';
import { getAppNodeModulesUri } from '../../../node/appNodeModules.js';
import { createCopilotCliEnvironment } from '../../../node/copilot/copilotCliEnvironment.js';
import { COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR, COPILOT_COMPUTER_USE_SERVER_NAME, resolveCopilotComputerUsePlugin } from '../../../node/copilot/copilotComputerUse.js';
import { createIsolatedProviderEnvironment } from '../providerTestEnvironment.js';

(isMacintosh ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the native bundle and lists its tools without desktop access or model requests', async function () {
		this.timeout(60_000);
		const cliPath = URI.joinPath(getAppNodeModulesUri(), '@github', `copilot-darwin-${process.arch}`, 'index.js').fsPath;
		const pluginPath = await resolveCopilotComputerUsePlugin({
			cliPath,
			platform: process.platform,
			hostLaunchKind: AgentHostLaunchKind.VSCodeMainProcess,
			isBuilt: false,
			developmentPluginPath: process.env[COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR],
		}, store.add(new NullLogService()));
		assert.ok(pluginPath, 'The native Computer Use bundle must be available');

		const home = await mkdtemp(join(tmpdir(), 'copilot-computer-use-sdk-'));
		const client = new CopilotClient({
			mode: 'empty',
			connection: RuntimeConnection.forStdio({ path: cliPath }),
			baseDirectory: join(home, '.copilot'),
			workingDirectory: home,
			builtinPluginDirectories: [pluginPath],
			useLoggedInUser: false,
			logLevel: 'error',
			env: createCopilotCliEnvironment({
				...createIsolatedProviderEnvironment(home),
				GITHUB_TOKEN: undefined,
				GH_TOKEN: undefined,
			}),
		});
		let session: CopilotSession | undefined;
		let permissionRequests = 0;
		let elicitations = 0;
		try {
			await client.start();
			const config: SessionConfig = {
				model: 'computer-use-test',
				workingDirectory: home,
				availableTools: new ToolSet().addMcp('*'),
				enableMcpApps: true,
				provider: {
					type: 'openai',
					wireApi: 'responses',
					baseUrl: 'http://127.0.0.1:1/v1',
					apiKey: 'not-a-real-key',
				},
				onPermissionRequest: () => {
					permissionRequests++;
					return { kind: 'denied-interactively-by-user' };
				},
				onElicitationRequest: async () => {
					elicitations++;
					return { action: 'cancel' };
				},
			};
			session = await client.createSession(config);
			const before = (await session.rpc.mcp.list()).servers.find(server => server.name === COPILOT_COMPUTER_USE_SERVER_NAME);
			await session.rpc.mcp.enable({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME });
			const { tools } = await session.rpc.mcp.listTools({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME });
			const requiredTools = ['list_apps', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll'];
			const exposed = requiredTools.filter(name => tools.some(tool => tool.name === name));
			await session.rpc.tools.initializeAndValidate();
			const { tools: modelTools } = await session.rpc.tools.getCurrentMetadata();
			const offered = requiredTools.filter(name => modelTools?.some(tool => tool.mcpServerName === COPILOT_COMPUTER_USE_SERVER_NAME && tool.mcpToolName === name));
			if (process.env['VSCODE_COMPUTER_USE_VIDEO_TEST'] === '1') {
				const readVideo = async () => {
					const resource = await session!.rpc.mcp.apps.readResource({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME, uri: 'computer-use://video/live' });
					const contents = resource.contents.find(content => content.uri === 'computer-use://video/live');
					assert.ok(contents && typeof contents.text === 'string', 'The native helper must expose its video resource');
					return JSON.parse(contents.text) as { version: number; status: string; frames?: unknown[] };
				};
				const idleVideo = await readVideo();
				const stop = await session.rpc.mcp.apps.callTool({
					serverName: COPILOT_COMPUTER_USE_SERVER_NAME,
					originServerName: COPILOT_COMPUTER_USE_SERVER_NAME,
					toolName: 'stop_computer_use',
					arguments: {},
				});
				const stoppedVideo = await readVideo();
				assert.deepStrictEqual({
					modelOffersStop: modelTools?.some(tool => tool.mcpToolName === 'stop_computer_use'),
					idle: { version: idleVideo.version, status: idleVideo.status, frames: idleVideo.frames?.length ?? 0 },
					stopFailed: stop.isError ?? false,
					stopped: { version: stoppedVideo.version, status: stoppedVideo.status, frames: stoppedVideo.frames?.length ?? 0 },
				}, {
					modelOffersStop: false,
					idle: { version: 1, status: 'idle', frames: 0 },
					stopFailed: false,
					stopped: { version: 1, status: 'stopped', frames: 0 },
				});
			}
			await session.rpc.mcp.disable({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME });
			const after = (await session.rpc.mcp.list()).servers.find(server => server.name === COPILOT_COMPUTER_USE_SERVER_NAME);
			await session.rpc.mcp.enable({ serverName: COPILOT_COMPUTER_USE_SERVER_NAME });
			await session.disconnect();
			session = await client.createSession({ ...config, disabledMcpServers: [COPILOT_COMPUTER_USE_SERVER_NAME] });
			const disabledAtLaunch = (await session.rpc.mcp.list()).servers.find(server => server.name === COPILOT_COMPUTER_USE_SERVER_NAME);

			assert.deepStrictEqual({
				source: before?.source,
				before: before?.status,
				exposed,
				offered,
				after: after?.status,
				disabledAtLaunch: disabledAtLaunch?.status,
				permissionRequests,
				elicitations,
			}, {
				source: 'builtin',
				before: 'connected',
				exposed: requiredTools,
				offered: requiredTools,
				after: 'disabled',
				disabledAtLaunch: 'disabled',
				permissionRequests: 0,
				elicitations: 0,
			});
		} finally {
			try {
				await session?.disconnect();
			} finally {
				try {
					await client.stop();
				} finally {
					await rm(home, { recursive: true, force: true });
				}
			}
		}
	});
});
