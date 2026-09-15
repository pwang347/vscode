/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ISessionComputerUseVideoSource } from '../../../services/sessions/common/computerUse.js';
import { COMPUTER_USE_EDITOR_INPUT_ID } from '../common/computerUse.js';
import type { IComputerUseActivity } from './computerUseActivity.js';

export interface IComputerUseViewerIdentity {
	readonly providerId: string;
	readonly sessionId: string;
	readonly chatResource: URI;
}

/** A transient viewer; the captured identity never follows the active session or chat. */
export class ComputerUseEditorInput extends EditorInput {

	static readonly ID = COMPUTER_USE_EDITOR_INPUT_ID;
	static readonly EDITOR_ID = 'workbench.editor.sessions.computerUse';

	readonly resource = undefined;
	readonly identity: IComputerUseViewerIdentity;
	private _attachmentChatResource: URI | undefined;

	constructor(
		identity: IComputerUseViewerIdentity,
		readonly sessionTitle: IObservable<string>,
		readonly chatTitle: IObservable<string>,
		readonly source: ISessionComputerUseVideoSource,
		readonly activity: IObservable<IComputerUseActivity> = constObservable({
			message: localize('computerUse.activityUnavailable', "Activity is unavailable for this chat."), active: false,
		}),
		attachmentChatResource?: URI,
	) {
		super();
		this.identity = { ...identity };
		this._attachmentChatResource = attachmentChatResource ?? (source.kind === 'recording' ? undefined : identity.chatResource);
		this._register(source);
		this._register(autorun(reader => {
			sessionTitle.read(reader);
			chatTitle.read(reader);
			this._onDidChangeLabel.fire();
		}));
	}

	get attachmentChatResource(): URI | undefined {
		return this._attachmentChatResource;
	}

	setAttachmentChatResource(resource: URI | undefined): void {
		this._attachmentChatResource ??= resource;
	}

	override get typeId(): string { return ComputerUseEditorInput.ID; }
	override get editorId(): string { return ComputerUseEditorInput.EDITOR_ID; }

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		if (this.source.kind === 'recording') {
			return this.source.title
				? localize('computerUse.titledRecordingEditorName', "Computer Use Recording: {0}", this.source.title)
				: localize('computerUse.recordingEditorName', "Computer Use Recording");
		}
		return localize('computerUse.editorName', "Computer Use: {0}", this.chatTitle.get());
	}

	override getDescription(): string {
		return this.source.hostLabel;
	}

	override getTitle(): string {
		if (this.source.kind === 'recording') {
			return localize('computerUse.recordingEditorTitle', "{0} — {1}", this.getName(), this.source.hostLabel);
		}
		return localize('computerUse.editorTitle', "{0} — {1} — {2}", this.getName(), this.sessionTitle.get(), this.source.hostLabel);
	}

	override getIcon(): ThemeIcon {
		return this.source.kind === 'recording' ? Codicon.playCircle : Codicon.deviceDesktop;
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
