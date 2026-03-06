/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { localize2 } from '../../../../nls.js';

/**
 * Mobile file viewer contribution.
 *
 * Provides a simplified file viewing experience for mobile:
 * - Monaco editor in read-only mode by default
 * - Syntax highlighting with full language support
 * - Pinch-to-zoom support for code viewing
 * - "Edit" mode toggle for basic editing (no IntelliSense)
 * - File tree accessible via the Files tab in navigation bar
 *
 * File viewing uses the standard EditorService/EditorParts infrastructure
 * with modal editor overlay (same pattern as sessions window).
 */
class MobileFileViewerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.fileViewer';

	constructor(
		@IEditorService _editorService: IEditorService,
	) {
		super();
	}
}

registerWorkbenchContribution2(MobileFileViewerContribution.ID, MobileFileViewerContribution, WorkbenchPhase.AfterRestored);

// Register "Open File" action for mobile
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'mobile.openFile',
			title: localize2('openFile', 'Open File'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);

		// Opens the quick file picker, which then opens the file
		// in the modal editor overlay (standard VS Code behavior
		// when workbench.editor.useModal === 'all')
		await editorService.openEditor({
			resource: undefined,
			options: { pinned: true }
		});
	}
});
