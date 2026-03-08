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
import { matchesFuzzy } from '../../../base/common/filters.js';

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

	private readonly _onDidAddWorkspace = this._register(new Emitter<string>());
	readonly onDidAddWorkspace = this._onDidAddWorkspace.event;

	private readonly _onDidRequestOpenFolder = this._register(new Emitter<void>());
	readonly onDidRequestOpenFolder = this._onDidRequestOpenFolder.event;

	private readonly _onDidRemoveWorkspace = this._register(new Emitter<string>());
	readonly onDidRemoveWorkspace = this._onDidRemoveWorkspace.event;

	private container!: HTMLElement;
	private workspaceListContainer!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private loadingOverlay!: HTMLElement;
	private currentWorkspaces: ISavedWorkspace[] = [];
	private readonly itemDisposables = this._register(new DisposableStore());

	constructor(parent: HTMLElement) {
		super();
		this.create(parent);
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-workspace-picker'));
		this.container.style.position = 'relative';

		// Loading overlay (hidden by default)
		this.loadingOverlay = append(this.container, $('.workspace-picker-loading-overlay'));
		this.loadingOverlay.style.display = 'none';
		append(this.loadingOverlay, $('div.spinner'));

		// Title
		const title = append(this.container, $('h2.workspace-picker-title'));
		title.textContent = localize('selectWorkspace', "Select a Workspace");

		// Floating add button (bottom-right)
		const fab = append(this.container, $('button.workspace-picker-fab'));
		const fabIcon = append(fab, $('span'));
		fabIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		this._register(addDisposableListener(fab, 'click', () => {
			this._onDidRequestOpenFolder.fire();
		}));

		// Search input
		const searchRow = append(this.container, $('.workspace-picker-search'));
		this.searchInput = append(searchRow, $('input.workspace-picker-search-input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('filterWorkspaces', "Filter workspaces...");
		this.searchInput.autocapitalize = 'off';
		this.searchInput.autocomplete = 'off';
		this.searchInput.spellcheck = false;
		this._register(addDisposableListener(this.searchInput, 'input', () => {
			this.renderFilteredWorkspaces();
		}));

		// Section label
		const sectionLabel = append(this.container, $('p.workspace-picker-section-label'));
		sectionLabel.textContent = localize('recents', "Recents");

		// Workspace list
		this.workspaceListContainer = append(this.container, $('.workspace-picker-list'));
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
		this.currentWorkspaces = workspaces;
		this.searchInput.value = '';
		this.renderFilteredWorkspaces();
	}

	private renderFilteredWorkspaces(): void {
		this.itemDisposables.clear();
		this.workspaceListContainer.textContent = '';

		const query = this.searchInput.value.trim();
		const filtered = query
			? this.currentWorkspaces.filter(ws => matchesFuzzy(query, ws.label || posix.basename(ws.path) || ws.path, true))
			: this.currentWorkspaces;

		const labels = this.computeLabels(filtered);

		for (let i = 0; i < filtered.length; i++) {
			const ws = filtered[i];
			const item = append(this.workspaceListContainer, $('button.workspace-picker-item'));
			const wsIcon = append(item, $('span.ws-icon'));
			wsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
			const info = append(item, $('.ws-info'));
			const label = append(info, $('span.ws-label'));
			label.textContent = ws.label || posix.basename(ws.path) || labels[i];
			const path = append(info, $('span.ws-path'));
			path.textContent = ws.path;
			const removeBtn = append(item, $('button.ws-remove'));
			const removeIcon = append(removeBtn, $('span'));
			removeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			this.itemDisposables.add(addDisposableListener(removeBtn, 'click', (e) => {
				e.stopPropagation();
				this._onDidRemoveWorkspace.fire(ws.path);
			}));
			this.itemDisposables.add(addDisposableListener(item, 'click', () => {
				// Immediate visual feedback before page reload
				item.classList.add('loading');
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
