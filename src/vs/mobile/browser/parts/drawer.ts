/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { $, append, addDisposableListener, getWindow, isHTMLElement } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { MobileDrawerOpenContext } from '../../common/contextkeys.js';
import { localize } from '../../../nls.js';
import { posix } from '../../../base/common/path.js';
import { shorten } from '../../../base/common/labels.js';

export interface IChatSessionItem {
	readonly sessionId: string;
	readonly title: string;
}

export type DrawerAction = 'newChat' | 'files';

/**
 * Mobile drawer -- slides in from the left, provides navigation actions,
 * chat session list, and connection/workspace info.
 */
export class Drawer extends Disposable {

	private readonly _onDidSelectAction = this._register(new Emitter<DrawerAction>());
	readonly onDidSelectAction = this._onDidSelectAction.event;

	private readonly _onDidSelectSession = this._register(new Emitter<string>());
	readonly onDidSelectSession = this._onDidSelectSession.event;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidPressConnection = this._register(new Emitter<void>());
	readonly onDidPressConnection = this._onDidPressConnection.event;

	private readonly _onDidPressWorkspace = this._register(new Emitter<void>());
	readonly onDidPressWorkspace = this._onDidPressWorkspace.event;

	private container!: HTMLElement;
	private backdrop!: HTMLElement;
	private panel!: HTMLElement;
	private sessionListContainer!: HTMLElement;
	private connectionInfoLabel!: HTMLElement;
	private workspaceInfoLabel!: HTMLElement;
	private _isOpen = false;
	private _closeTimeout: ReturnType<typeof setTimeout> | undefined;
	private readonly sessionDisposables = this._register(new DisposableStore());
	private readonly _focusableElements: HTMLElement[] = [];
	private readonly _focusTrapListener = this._register(new MutableDisposable());

	private readonly drawerOpenKey;

	constructor(
		parent: HTMLElement,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.drawerOpenKey = MobileDrawerOpenContext.bindTo(contextKeyService);
		this.create(parent);
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	private create(parent: HTMLElement): void {
		this.container = append(parent, $('.mobile-drawer'));
		this.container.style.display = 'none';
		this.container.setAttribute('role', 'dialog');
		this.container.setAttribute('aria-modal', 'true');
		this.container.setAttribute('aria-label', localize('drawerLabel', "Navigation Drawer"));

		// Backdrop (tap to close)
		this.backdrop = append(this.container, $('.drawer-backdrop'));
		this._register(addDisposableListener(this.backdrop, 'click', () => this.close()));

		// Sliding panel
		this.panel = append(this.container, $('.drawer-panel'));
		this.panel.setAttribute('role', 'navigation');
		this.panel.setAttribute('tabindex', '-1');
		this.panel.setAttribute('aria-label', localize('drawerNavigation', "Mobile Navigation"));

		// Actions section
		const actionsSection = append(this.panel, $('.drawer-section.drawer-actions'));
		this.createActionItem(actionsSection, Codicon.add, localize('newChat', "New Chat"), 'newChat');
		this.createActionItem(actionsSection, Codicon.files, localize('files', "Files"), 'files');

		// Separator
		append(this.panel, $('.drawer-separator'));

		// Chat sessions section
		const sessionsHeader = append(this.panel, $('.drawer-section-header'));
		sessionsHeader.textContent = localize('chatSessions', "Chat Sessions");
		this.sessionListContainer = append(this.panel, $('.drawer-section.drawer-sessions'));

		// Separator
		append(this.panel, $('.drawer-separator'));

		// Footer: connection + workspace info (clickable to switch)
		const footer = append(this.panel, $('.drawer-section.drawer-footer'));
		this.connectionInfoLabel = append(footer, $('button.drawer-footer-item.connection-info'));
		this._focusableElements.push(this.connectionInfoLabel);
		this._register(addDisposableListener(this.connectionInfoLabel, 'click', () => {
			this.close();
			this._onDidPressConnection.fire();
		}));
		this.workspaceInfoLabel = append(footer, $('button.drawer-footer-item.workspace-info'));
		this._focusableElements.push(this.workspaceInfoLabel);
		this._register(addDisposableListener(this.workspaceInfoLabel, 'click', () => {
			this.close();
			this._onDidPressWorkspace.fire();
		}));
	}

	private createActionItem(parent: HTMLElement, icon: ThemeIcon, label: string, action: DrawerAction): void {
		const item = append(parent, $('button.drawer-action-item'));
		item.setAttribute('role', 'menuitem');
		const iconEl = append(item, $('span.drawer-action-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
		const labelEl = append(item, $('span.drawer-action-label'));
		labelEl.textContent = label;
		this._register(addDisposableListener(item, 'click', () => {
			this._onDidSelectAction.fire(action);
			this.close();
		}));
		this._focusableElements.push(item);
	}

	updateSessions(sessions: IChatSessionItem[]): void {
		this.sessionDisposables.clear();
		this.sessionListContainer.textContent = '';
		for (const session of sessions) {
			const item = append(this.sessionListContainer, $('button.drawer-session-item'));
			const icon = append(item, $('span.session-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.comment));
			const label = append(item, $('span.session-label'));
			label.textContent = session.title;
			this.sessionDisposables.add(addDisposableListener(item, 'click', () => {
				this._onDidSelectSession.fire(session.sessionId);
				this.close();
			}));
		}
	}

	updateConnectionInfo(serverName: string, status: string, editable = true): void {
		this.connectionInfoLabel.textContent = '';
		if (editable) {
			this.connectionInfoLabel.setAttribute('aria-label', localize('changeServer', "Connected to {0}. Click to change server.", serverName));
		} else {
			this.connectionInfoLabel.setAttribute('aria-label', localize('connectedTo', "Connected to {0}.", serverName));
			(this.connectionInfoLabel as HTMLButtonElement).disabled = true;
		}
		const dot = append(this.connectionInfoLabel, $('span.drawer-status-dot'));
		dot.classList.add(status);
		const label = append(this.connectionInfoLabel, $('span'));
		label.textContent = serverName;
		if (editable) {
			const chevron = append(this.connectionInfoLabel, $('span.drawer-footer-chevron'));
			chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		}
	}

	updateWorkspaceInfo(workspacePath: string, allWorkspacePaths?: string[]): void {
		this.workspaceInfoLabel.textContent = '';

		// Strip vscode-remote://authority prefix to get raw paths
		const stripRemote = (p: string) => p.replace(/^vscode-remote:\/\/[^/]+/, '');
		const rawPath = stripRemote(workspacePath);

		// Use basename when unique, shorten() only when disambiguation is needed
		let displayName: string;
		const baseName = posix.basename(rawPath) || rawPath;
		if (allWorkspacePaths && allWorkspacePaths.length > 1) {
			const rawPaths = allWorkspacePaths.map(stripRemote);
			const baseNames = rawPaths.map(p => posix.basename(p) || p);
			const isDuplicate = baseNames.filter(b => b === baseName).length > 1;
			if (isDuplicate) {
				const idx = rawPaths.indexOf(rawPath);
				const labels = shorten(rawPaths, posix.sep);
				displayName = idx >= 0 ? labels[idx] : baseName;
			} else {
				displayName = baseName;
			}
		} else {
			displayName = baseName;
		}

		this.workspaceInfoLabel.setAttribute('aria-label', localize('changeWorkspace', "Workspace: {0}. Click to change workspace.", displayName));
		const icon = append(this.workspaceInfoLabel, $('span'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
		const label = append(this.workspaceInfoLabel, $('span'));
		label.textContent = displayName;
		const chevron = append(this.workspaceInfoLabel, $('span.drawer-footer-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
	}

	open(): void {
		if (this._isOpen) {
			return;
		}
		this._isOpen = true;

		// Dismiss mobile keyboard by blurring the active element
		const activeElement = getWindow(this.container).document.activeElement;
		if (isHTMLElement(activeElement)) {
			activeElement.blur();
		}

		this.container.style.display = '';
		// Force reflow before adding class so the transition plays
		void this.container.offsetHeight;
		this.container.classList.add('open');
		this.drawerOpenKey.set(true);

		// Focus trap: trap Tab/Shift+Tab within the drawer panel
		this._focusTrapListener.value = addDisposableListener(this.container, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.close();
				return;
			}
			if (e.key !== 'Tab') {
				return;
			}
			const focusable = this._focusableElements.filter(el => el.offsetParent !== null);
			if (focusable.length === 0) {
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && getWindow(this.container).document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && getWindow(this.container).document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		});

		// Move focus into the drawer panel (not a button, to avoid visible outline)
		this.panel.focus();
	}

	close(): void {
		if (!this._isOpen) {
			return;
		}
		this._isOpen = false;
		this.container.classList.remove('open');
		this.drawerOpenKey.set(false);
		this._focusTrapListener.clear();
		// Clear any pending close timeout from a previous close
		if (this._closeTimeout !== undefined) {
			clearTimeout(this._closeTimeout);
			this._closeTimeout = undefined;
		}
		// Wait for transition to finish, then hide the container
		const onEnd = () => {
			this.container.removeEventListener('transitionend', onEnd);
			if (this._closeTimeout !== undefined) {
				clearTimeout(this._closeTimeout);
				this._closeTimeout = undefined;
			}
			if (!this._isOpen) {
				this.container.style.display = 'none';
			}
		};
		this.container.addEventListener('transitionend', onEnd);
		// Fallback in case transitionend doesn't fire
		this._closeTimeout = setTimeout(onEnd, 350);
		this._onDidClose.fire();
	}

	toggle(): void {
		if (this._isOpen) {
			this.close();
		} else {
			this.open();
		}
	}
}
