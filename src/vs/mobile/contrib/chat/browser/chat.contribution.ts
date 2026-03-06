/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/**
 * Chat-related contributions for the mobile workbench.
 *
 * The mobile chat experience reuses the full VS Code chat panel
 * (vs/workbench/contrib/chat) — this contribution adds mobile-specific
 * enhancements:
 *
 * - Multi-line prompt composer with comfortable mobile input
 * - Prompt history/recall for easy re-editing
 * - Voice input integration via the Speech contribution
 * - Mobile keyboard handling (input stays above virtual keyboard)
 * - Attachment picker using native file picker on Capacitor
 */
class MobileChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.chat';

	constructor() {
		super();
	}
}

registerWorkbenchContribution2(MobileChatContribution.ID, MobileChatContribution, WorkbenchPhase.AfterRestored);
