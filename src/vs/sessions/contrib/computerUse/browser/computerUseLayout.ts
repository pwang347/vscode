/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { isMobile, isWeb } from '../../../../base/common/platform.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { COMPUTER_USE_EDITOR_INPUT_ID } from '../common/computerUse.js';

export class ComputerUseLayoutController extends Disposable {
	static readonly ID = 'workbench.contrib.computerUseLayout';

	constructor(
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
	) {
		super();
		if (isWeb && isMobile) {
			return;
		}
		const activeEditor = observableFromEvent(this, editorService.onDidActiveEditorChange, () => editorGroupsService.mainPart.activeGroup.activeEditor ?? undefined);
		const contentVisible = observableFromEvent(this, layoutService.onDidChangePartVisibility, () =>
			layoutService.isVisible(Parts.EDITOR_PART, mainWindow) && layoutService.isVisible(Parts.SESSIONS_PART));
		let previousEditor: EditorInput | undefined;
		let pending = false;
		const activationExpansionSuppression = this._register(new MutableDisposable<IDisposable>());
		this._register(autorun(reader => {
			const editor = activeEditor.read(reader);
			const visible = contentVisible.read(reader);
			const computerUseActive = editor?.typeId === COMPUTER_USE_EDITOR_INPUT_ID;
			if (computerUseActive && !activationExpansionSuppression.value) {
				activationExpansionSuppression.value = layoutService.suppressSessionsPartActivationResize();
			} else if (!computerUseActive) {
				activationExpansionSuppression.clear();
			}
			if (editor !== previousEditor) {
				previousEditor = editor;
				pending = computerUseActive;
			}
			if (!pending || !visible) {
				return;
			}
			pending = false;
			layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			const size = layoutService.getSize(Parts.SESSIONS_PART);
			// Grid sizing clamps this to the current Sessions Part minimum without hiding it.
			layoutService.setSize(Parts.SESSIONS_PART, { width: 0, height: size.height });
		}));
	}
}
