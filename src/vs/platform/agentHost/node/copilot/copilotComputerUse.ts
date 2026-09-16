/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Dirent } from 'fs';
import type { CustomAgentConfig } from '@github/copilot-sdk';
import * as fs from 'fs/promises';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { isObject } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostLaunchKind } from '../../common/agentHostTelemetry.js';

export const COPILOT_COMPUTER_USE_SERVER_NAME = 'computer-use';
export const COPILOT_COMPUTER_USE_AGENT_NAME = 'computer-use';
export const COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR = 'VSCODE_COMPUTER_USE_PLUGIN_PATH';
export const COPILOT_COMPUTER_USE_REMOTE_ENABLED_ENV_VAR = 'VSCODE_AGENT_HOST_COMPUTER_USE';

const COPILOT_COMPUTER_USE_AGENT_TOOLS = [
	'computer-use-get_window_state',
	'computer-use-list_apps',
	'computer-use-click',
	'computer-use-set_value',
	'computer-use-patch_text',
	'computer-use-type_text',
	'computer-use-press_key',
	'computer-use-scroll',
	'computer-use-perform_secondary_action',
	'computer-use-drag',
] as const;

/** Returns the hard-scoped custom agent paired with the native Computer Use plugin. */
export function createCopilotComputerUseAgent(platform: NodeJS.Platform): CustomAgentConfig {
	return {
		name: COPILOT_COMPUTER_USE_AGENT_NAME,
		displayName: 'Computer Use',
		description: 'Use for tasks that require observing or manipulating a desktop application UI when no dedicated app-specific MCP server can complete the task.',
		tools: [
			...COPILOT_COMPUTER_USE_AGENT_TOOLS,
			...(platform === 'win32' ? ['computer-use-start_app'] : []),
			'ask_user',
		],
		prompt: 'Complete the requested desktop application task using Computer Use tools. Stay in the direct app loop: discover only when necessary, perceive the exact window, perform the requested action, and verify the result. Do not delegate or switch to shell, terminal, browser, filesystem, session-management, skill, or agent-management tools.',
		infer: true,
	};
}

interface IComputerUsePluginOptions {
	readonly cliPath: string;
	readonly platform: NodeJS.Platform;
	readonly hostLaunchKind: AgentHostLaunchKind;
	readonly isBuilt: boolean;
	readonly developmentPluginPath?: string;
	readonly remoteEnabled?: boolean;
}

/** Resolves the native desktop bundle without starting it or requesting OS permissions. */
export async function resolveCopilotComputerUsePlugin(options: IComputerUsePluginOptions, logService: ILogService): Promise<string | undefined> {
	if ((options.platform !== 'darwin' && options.platform !== 'win32') || (options.hostLaunchKind !== AgentHostLaunchKind.VSCodeMainProcess && !options.remoteEnabled)) {
		return undefined;
	}

	const developmentPluginPath = !options.isBuilt ? options.developmentPluginPath : undefined;
	if (developmentPluginPath && !isAbsolute(developmentPluginPath)) {
		throw new Error(localize('computerUse.absolutePath', "{0} must be an absolute path to the built Computer Use plugin.", COPILOT_COMPUTER_USE_PLUGIN_PATH_ENV_VAR));
	}
	const pluginPath = developmentPluginPath || join(dirname(options.cliPath), 'plugins', COPILOT_COMPUTER_USE_SERVER_NAME);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(pluginPath, { withFileTypes: true });
	} catch (error) {
		if (!developmentPluginPath && isObject(error) && error.code === 'ENOENT') {
			logService.warn(`[Copilot] Computer Use is unavailable: the bundled plugin is missing at ${pluginPath}`);
			return undefined;
		}
		throw error;
	}

	const manifest: { readonly name?: unknown } = JSON.parse(await fs.readFile(join(pluginPath, '.plugin', 'plugin.json'), 'utf8'));
	if (!isObject(manifest) || manifest.name !== COPILOT_COMPUTER_USE_SERVER_NAME) {
		throw new Error(localize('computerUse.invalidManifest', "Invalid Computer Use plugin manifest in {0}.", pluginPath));
	}
	const requiredFiles = [join(pluginPath, '.mcp.json')];
	if (options.platform === 'win32') {
		requiredFiles.push(join(pluginPath, 'computer-use-mcp.exe'), join(pluginPath, 'CopilotComputerUse.exe'));
	} else {
		const apps = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
		if (apps.length !== 1) {
			throw new Error(localize('computerUse.nativeApp', "Computer Use requires exactly one native helper app in {0}.", pluginPath));
		}
		requiredFiles.push(join(pluginPath, 'computer-use-mcp'), join(pluginPath, apps[0].name, 'Contents', 'Info.plist'));
		const executables = await fs.readdir(join(pluginPath, apps[0].name, 'Contents', 'MacOS'), { withFileTypes: true });
		if (!executables.some(entry => entry.isFile())) {
			throw new Error(localize('computerUse.missingExecutable', "Computer Use native helper has no executable in {0}.", pluginPath));
		}
	}
	for (const file of requiredFiles) {
		if (!(await fs.stat(file)).isFile()) {
			throw new Error(localize('computerUse.requiredFile', "Computer Use requires a file at {0}.", file));
		}
	}

	return pluginPath;
}
