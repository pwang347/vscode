/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';

export interface IComputerUseViewerIdentity {
	readonly providerId: string;
	readonly sessionId: string;
	readonly chatResource: URI;
}

/** A transient viewer; the captured identity never follows the active session or chat. */
export class ComputerUseEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.sessions.computerUse';
	static readonly EDITOR_ID = 'workbench.editor.sessions.computerUse';

	readonly resource = undefined;
	readonly identity: IComputerUseViewerIdentity;

	constructor(
		identity: IComputerUseViewerIdentity,
		readonly sessionTitle: IObservable<string>,
		readonly chatTitle: IObservable<string>,
		readonly source: ISessionComputerUseVideoSource,
	) {
		super();
		this.identity = { ...identity };
		this._register(source);
		this._register(autorun(reader => {
			sessionTitle.read(reader);
			chatTitle.read(reader);
			this._onDidChangeLabel.fire();
		}));
	}

	override get typeId(): string { return ComputerUseEditorInput.ID; }
	override get editorId(): string { return ComputerUseEditorInput.EDITOR_ID; }

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('computerUse.editorName', "Computer Use: {0}", this.chatTitle.get());
	}

	override getDescription(): string {
		return this.source.hostLabel;
	}

	override getTitle(): string {
		return localize('computerUse.editorTitle', "{0} — {1} — {2}", this.getName(), this.sessionTitle.get(), this.source.hostLabel);
	}

	override getIcon(): ThemeIcon {
		return Codicon.deviceDesktop;
	}

	override canReopen(): boolean {
		return false;
	}

	isFor(identity: IComputerUseViewerIdentity): boolean {
		return this.identity.providerId === identity.providerId
			&& this.identity.sessionId === identity.sessionId
			&& isEqual(this.identity.chatResource, identity.chatResource);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other === this || other instanceof ComputerUseEditorInput && this.isFor(other.identity);
	}
}
