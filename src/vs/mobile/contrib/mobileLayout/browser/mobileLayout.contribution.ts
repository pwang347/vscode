/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import './media/mobileLayout.css';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { mainWindow } from '../../../../base/browser/window.js';

/**
 * Mobile layout contribution -- hides desktop-only chrome when
 * connected to a remote server. Navigation is handled by the
 * MobileWorkbench's drawer and phase-based layout.
 */
class MobileLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.layout';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		// Only apply when connected (remoteAuthority in URL)
		const params = new URLSearchParams(mainWindow.location.search);
		if (!params.has('remoteAuthority')) {
			return;
		}

		this.applyMobileLayout();
	}

	private applyMobileLayout(): void {
		// Hide desktop-only parts -- the MobileWorkbench manages its own
		// top bar, drawer, and view containers.
		this.layoutService.setPartHidden(true, Parts.TITLEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
	}
}

registerWorkbenchContribution2(MobileLayoutContribution.ID, MobileLayoutContribution, WorkbenchPhase.AfterRestored);
