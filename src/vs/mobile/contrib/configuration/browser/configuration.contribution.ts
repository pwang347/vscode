/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Configuration overrides for the mobile workbench.
 * Sets sensible defaults for mobile use.
 */
class MobileConfigurationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.configuration';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.applyMobileDefaults();
	}

	private applyMobileDefaults(): void {
		// Mobile-optimized editor defaults
		const overrides: Record<string, unknown> = {
			'editor.minimap.enabled': false,        // Save screen space
			'editor.wordWrap': 'on',                // Wrap on narrow screens
			'editor.lineNumbers': 'on',
			'editor.fontSize': 16,
			'editor.glyphMargin': false,             // More horizontal space
			'editor.folding': true,
			'editor.scrollBeyondLastLine': false,
			'workbench.editor.showTabs': 'none',     // No tabs in mobile (stack navigation)
			'workbench.editor.useModal': 'all',       // All editors open as modal
			'terminal.integrated.fontSize': 15,
		};

		for (const [key, value] of Object.entries(overrides)) {
			const current = this.configurationService.inspect(key);
			// Only override if the user hasn't explicitly set a value
			if (current.userValue === undefined) {
				this.configurationService.updateValue(key, value);
			}
		}
	}
}

registerWorkbenchContribution2(MobileConfigurationContribution.ID, MobileConfigurationContribution, WorkbenchPhase.AfterRestored);
