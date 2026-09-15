/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../../common/agentHostTelemetry.js';
import { getAppNodeModulesUri } from '../../../node/appNodeModules.js';
import { COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR, resolveCopilotComputerUsePlugin } from '../../../node/copilot/copilotComputerUse.js';
import { bounded } from './copilotComputerUseWindowsTestUtils.js';

const enabled = isWindows && process.env['VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_TEST'] === '1';

(enabled ? suite : suite.skip)('Agent Host Provider Integration - Copilot Computer Use AHP Idle (no GUI)', function () {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const filter = enabled && process.env['VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_GREP']
		? new RegExp(process.env['VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_GREP']) : undefined;

	for (const nativeStop of [false, true]) {
		const name = nativeStop
			? 'authenticated-idle-app-stop-and-exact-chat-cancellation'
			: 'authenticated-idle-resource-and-exact-chat-cancellation';
		(!filter || filter.test(name) ? test : test.skip)(name, async function () {
			this.timeout(240_000);
			this.retries(0);
			const { AgentHostVideoPeer, assertIdleVideoHasNoTarget } = await import('./copilotComputerUseVideoAhpTestPeer.js');
			const cliPath = URI.joinPath(getAppNodeModulesUri(), '@github', `copilot-${process.platform}-${process.arch}`, 'index.js').fsPath;
			const pluginPath = await resolveCopilotComputerUsePlugin({
				cliPath, platform: process.platform, hostLaunchKind: AgentHostLaunchKind.VSCodeCLI,
				isBuilt: false, remoteEnabled: true,
				developmentPluginPath: process.env[COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR],
			}, store.add(new NullLogService()));
			assert.ok(pluginPath, 'The complete native Computer Use bundle must be available for idle MCP routing');
			const home = await mkdtemp(join(tmpdir(), 'vscode-ahp-idle-regression-'));
			const peer = new AgentHostVideoPeer(pluginPath, home);
			try {
				await bounded(peer.start(), 'Starting the real authenticated idle AHP fixture', 60_000);
				await bounded((async () => {
					assertIdleVideoHasNoTarget(await peer.read());
					await peer.assertSiblingVideoIdle();
					if (nativeStop) {
						await peer.stopNative();
					}
					await peer.cancelExactChat(async () => {
						const batch = await peer.read();
						assert.ok((batch.status === 'idle' || batch.status === 'stopped') && !batch.frames.length
							&& batch.config === undefined && batch.target === undefined && batch.streamId === undefined,
							'Idle cancellation must not authorize a target or return video data');
					});
					const evidence = peer.getEvidence();
					assert.deepStrictEqual({
						authorizations: peer.authorizations,
						appAllowed: peer.consent.counts.appAllowed,
						nativeStopInvoked: evidence.nativeStopInvoked,
						siblingProgressAfterCancellation: evidence.siblingProgressAfterCancellation,
					}, {
						authorizations: 0, appAllowed: 0, nativeStopInvoked: nativeStop, siblingProgressAfterCancellation: true,
					});
				})(), 'Checking idle AHP routing and exact-chat cancellation', 90_000);
			} finally {
				try {
					await peer.close();
				} finally {
					await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
				}
			}
		});
	}
});
