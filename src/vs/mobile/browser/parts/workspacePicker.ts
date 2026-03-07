/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { $, append, addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { localize } from '../../../nls.js';
import { shorten } from '../../../base/common/labels.js';
import { posix } from '../../../base/common/path.js';

export interface ISavedWorkspace {
	readonly path: string;
	readonly label?: string;
}

/**
 * Workspace picker — shown after connecting to a server, before opening the chat.
 * Displays saved workspaces and allows opening a folder by path.
 */
export class WorkspacePicker extends Disposable {

	private readonly _onDidSelectWorkspace = this._register(new Emitter<string>());
	readonly onDidSelectWorkspace = this._onDidSelectWorkspace.event;

	private readonly _onDidRequestOpenFolder = this._register(new Emitter<void>());
	readonly onDidRequestOpenFolder = this._onDidRequestOpenFolder.event;

	private readonly _onDidRemoveWorkspace = this._register(new Emitter<string>());
	readonly onDidRemoveWorkspace = this._onDidRemoveWorkspace.event;

	private readonly _onDidPressBack = this._register(new Emitter<void>());
	readonly onDidPressBack = this._onDidPressBack.event;

	private container!: HTMLElement;
	private workspaceListContainer!: HTMLElement;
	private serverNameLabel!: HTMLElement;
	private readonly itemDisposables = this._register(new DisposableStore());

	constructor(parent: HTMLElement) {
		super();
		this.create(parent);
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-workspace-picker'));

		// Top bar with back button
		const topBar = append(this.container, $('.workspace-picker-topbar'));
		const backButton = append(topBar, $('button.workspace-picker-back'));
		backButton.setAttribute('aria-label', localize('back', "Go Back"));
		const backIcon = append(backButton, $('span'));
		backIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowLeft));
		this._register(addDisposableListener(backButton, 'click', () => {
			this._onDidPressBack.fire();
		}));

		this.serverNameLabel = append(topBar, $('span.workspace-picker-server'));
		this.serverNameLabel.textContent = '';

		// Title
		const title = append(this.container, $('h2.workspace-picker-title'));
		title.textContent = localize('selectWorkspace', "Select a Workspace");

		// Section label
		const sectionLabel = append(this.container, $('p.workspace-picker-section-label'));
		sectionLabel.textContent = localize('recents', "Recents");

		// Workspace list
		this.workspaceListContainer = append(this.container, $('.workspace-picker-list'));

		// Open folder button
		const openFolderButton = append(this.container, $('button.workspace-picker-open'));
		const folderIcon = append(openFolderButton, $('span'));
		folderIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		const openLabel = append(openFolderButton, $('span'));
		openLabel.textContent = localize('addWorkspace', "Add Workspace");
		this._register(addDisposableListener(openFolderButton, 'click', () => {
			this._onDidRequestOpenFolder.fire();
		}));
	}

	setServerName(name: string): void {
		this.serverNameLabel.textContent = name;
	}

	/**
	 * Compute minimal distinguishing labels for a set of workspace paths.
	 * Uses the same `shorten` algorithm as editor tab labels.
	 */
	private computeLabels(workspaces: ISavedWorkspace[]): string[] {
		const paths = workspaces.map(ws => ws.path);
		// shorten expects forward-slash paths; remote paths are typically posix
		return shorten(paths, posix.sep);
	}

	updateWorkspaces(workspaces: ISavedWorkspace[]): void {
		this.itemDisposables.clear();
		this.workspaceListContainer.textContent = '';

		const labels = this.computeLabels(workspaces);

		for (let i = 0; i < workspaces.length; i++) {
			const ws = workspaces[i];
			const item = append(this.workspaceListContainer, $('button.workspace-picker-item'));
			const wsIcon = append(item, $('span.ws-icon'));
			wsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.rootFolder));
			const info = append(item, $('.ws-info'));
			const label = append(info, $('span.ws-label'));
			label.textContent = ws.label || posix.basename(ws.path) || labels[i];
			const path = append(info, $('span.ws-path'));
			path.textContent = ws.path;
			const chevron = append(item, $('span.ws-chevron'));
			chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
			this.itemDisposables.add(addDisposableListener(item, 'click', () => {
				// Immediate visual feedback before page reload
				item.classList.add('loading');
				chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
				chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
				this._onDidSelectWorkspace.fire(ws.path);
			}));
		}
	}

	show(): void {
		this.container.style.display = '';
	}

	hide(): void {
		this.container.style.display = 'none';
	}
}
