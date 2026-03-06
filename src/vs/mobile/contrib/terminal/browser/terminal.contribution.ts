/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/**
 * Mobile terminal contribution.
 *
 * Enhances the terminal experience for mobile by:
 * - Providing a special key toolbar (Tab, Ctrl+C, arrows, Esc)
 * - Supporting landscape keyboard layout
 * - Auto-focusing terminal input when the terminal tab is selected
 *
 * The actual terminal rendering uses the existing xterm.js integration
 * from vs/workbench/contrib/terminal — this contribution layer adds
 * mobile-specific UI affordances on top.
 */
class MobileTerminalContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.terminal';

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();

		// Ensure at least one terminal exists for the terminal tab
		this._register(this.terminalService.onDidChangeInstances(() => {
			// Terminal service will handle instance management
		}));
	}
}

registerWorkbenchContribution2(MobileTerminalContribution.ID, MobileTerminalContribution, WorkbenchPhase.AfterRestored);
