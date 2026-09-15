/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ComputerUseEditorInput } from './computerUseEditorInput.js';
import { ComputerUsePlayer } from './computerUsePlayer.js';

export class ComputerUseEditor extends EditorPane {
	static readonly ID = ComputerUseEditorInput.EDITOR_ID;

	private container: HTMLElement | undefined;
	private readonly player = this._register(new MutableDisposable<ComputerUsePlayer>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ComputerUseEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.computer-use-editor'));
	}

	override async setInput(input: ComputerUseEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.player.clear();
		await super.setInput(input, options, context, token);
		if (!token.isCancellationRequested && this.input === input && this.container && !input.isDisposed()) {
			this.player.value = this.instantiationService.createInstance(ComputerUsePlayer, this.container, input, undefined);
			this.player.value.setVisible(this.isVisible());
		}
	}

	override get scopedContextKeyService(): IContextKeyService | undefined {
		return this.player.value?.scopedContextKeyService;
	}

	protected override setEditorVisible(visible: boolean): void {
		this.player.value?.setVisible(visible);
	}

	override clearInput(): void {
		this.player.clear();
		super.clearInput();
	}

	getPlayer(): ComputerUsePlayer | undefined {
		return this.player.value;
	}

	restartRecordingPlayback(): void {
		this.player.value?.restartRecordingPlayback();
	}

	override focus(): void {
		this.player.value?.focus();
	}

	override layout(_dimension: Dimension): void { }
}
