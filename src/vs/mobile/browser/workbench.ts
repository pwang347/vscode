/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../workbench/browser/style.js';
import './media/style.css';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { Emitter, Event, setGlobalLeakWarningThreshold } from '../../base/common/event.js';
import { getActiveDocument, getActiveElement, getClientArea, getWindows, IDimension, isAncestorUsingFlowTo, size, Dimension, runWhenWindowIdle, $, append } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { isChrome, isFirefox, isSafari } from '../../base/browser/browser.js';
import { mark } from '../../base/common/performance.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { isWindows, isLinux } from '../../base/common/platform.js';
import { Parts, Position, PanelAlignment, IWorkbenchLayoutService, SINGLE_WINDOW_PARTS, MULTI_WINDOW_PARTS, IPartVisibilityChangeEvent } from '../../workbench/services/layout/browser/layoutService.js';
import { ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { Part } from '../../workbench/browser/part.js';
import { Direction, IViewSize } from '../../base/browser/ui/grid/grid.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../workbench/common/views.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { mainWindow, CodeWindow } from '../../base/browser/window.js';
import { coalesce } from '../../base/common/arrays.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { ILifecycleService, LifecyclePhase, WillShutdownEvent } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { NotificationService } from '../../workbench/services/notification/common/notificationService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../platform/hover/browser/hover.js';
import { setHoverDelegateFactory } from '../../base/browser/ui/hover/hoverDelegateFactory.js';
import { setBaseLayerHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate2.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../workbench/common/contributions.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../workbench/common/editor.js';
import { setARIAContainer } from '../../base/browser/ui/aria/aria.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../editor/common/config/fontInfoFromSettings.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { WorkbenchContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import { AccessibilityProgressSignalScheduler } from '../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { setProgressAccessibilitySignalScheduler } from '../../base/browser/ui/progressbar/progressAccessibilitySignal.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { NotificationAccessibleView } from '../../workbench/browser/parts/notifications/notificationAccessibleView.js';
import { NotificationsCenter } from '../../workbench/browser/parts/notifications/notificationsCenter.js';
import { NotificationsAlerts } from '../../workbench/browser/parts/notifications/notificationsAlerts.js';
import { NotificationsStatus } from '../../workbench/browser/parts/notifications/notificationsStatus.js';
import { registerNotificationCommands } from '../../workbench/browser/parts/notifications/notificationsCommands.js';
import { NotificationsToasts } from '../../workbench/browser/parts/notifications/notificationsToasts.js';
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { ConnectionBar } from './parts/connectionBar.js';
import { NavigationBar } from './parts/navigationBar.js';
import { MobileTab } from './parts/parts.js';
import { IsMobileAppContext, MobileOrientationContext } from '../common/contextkeys.js';


//#region Workbench Options

export interface IMobileWorkbenchOptions {
	extraClasses?: string[];
}

//#endregion

export class MobileWorkbench extends Disposable implements IWorkbenchLayoutService {

	declare readonly _serviceBrand: undefined;

	//#region Lifecycle Events

	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	readonly onWillShutdown = this._onWillShutdown.event;

	private readonly _onDidShutdown = this._register(new Emitter<void>());
	readonly onDidShutdown = this._onDidShutdown.event;

	//#endregion

	//#region Events

	private readonly _onDidChangeZenMode = this._register(new Emitter<boolean>());
	readonly onDidChangeZenMode = this._onDidChangeZenMode.event;

	private readonly _onDidChangeMainEditorCenteredLayout = this._register(new Emitter<boolean>());
	readonly onDidChangeMainEditorCenteredLayout = this._onDidChangeMainEditorCenteredLayout.event;

	private readonly _onDidChangePanelAlignment = this._register(new Emitter<PanelAlignment>());
	readonly onDidChangePanelAlignment = this._onDidChangePanelAlignment.event;

	private readonly _onDidChangeWindowMaximized = this._register(new Emitter<{ windowId: number; maximized: boolean }>());
	readonly onDidChangeWindowMaximized = this._onDidChangeWindowMaximized.event;

	private readonly _onDidChangePanelPosition = this._register(new Emitter<string>());
	readonly onDidChangePanelPosition = this._onDidChangePanelPosition.event;

	private readonly _onDidChangePartVisibility = this._register(new Emitter<IPartVisibilityChangeEvent>());
	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;

	private readonly _onDidChangeNotificationsVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeNotificationsVisibility = this._onDidChangeNotificationsVisibility.event;

	private readonly _onDidChangeAuxiliaryBarMaximized = this._register(new Emitter<void>());
	readonly onDidChangeAuxiliaryBarMaximized = this._onDidChangeAuxiliaryBarMaximized.event;

	private readonly _onDidLayoutMainContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutMainContainer = this._onDidLayoutMainContainer.event;

	private readonly _onDidLayoutActiveContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutActiveContainer = this._onDidLayoutActiveContainer.event;

	private readonly _onDidLayoutContainer = this._register(new Emitter<{ container: HTMLElement; dimension: IDimension }>());
	readonly onDidLayoutContainer = this._onDidLayoutContainer.event;

	private readonly _onDidAddContainer = this._register(new Emitter<{ container: HTMLElement; disposables: DisposableStore }>());
	readonly onDidAddContainer = this._onDidAddContainer.event;

	private readonly _onDidChangeActiveContainer = this._register(new Emitter<void>());
	readonly onDidChangeActiveContainer = this._onDidChangeActiveContainer.event;

	//#endregion

	//#region Properties

	readonly mainContainer = document.createElement('div');

	get activeContainer(): HTMLElement {
		return this.getContainerFromDocument(getActiveDocument());
	}

	get containers(): Iterable<HTMLElement> {
		const containers: HTMLElement[] = [];
		for (const { window } of getWindows()) {
			containers.push(this.getContainerFromDocument(window.document));
		}
		return containers;
	}

	private getContainerFromDocument(targetDocument: Document): HTMLElement {
		if (targetDocument === this.mainContainer.ownerDocument) {
			return this.mainContainer;
		}
		// eslint-disable-next-line no-restricted-syntax
		return targetDocument.body.getElementsByClassName('monaco-workbench')[0] as HTMLElement;
	}

	private _mainContainerDimension!: IDimension;
	get mainContainerDimension(): IDimension { return this._mainContainerDimension; }

	get activeContainerDimension(): IDimension {
		return this.mainContainerDimension;
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	get activeContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	private computeContainerOffset(): ILayoutOffsetInfo {
		const top = this.connectionBar?.getHeight() ?? 44;
		return { top, quickPickTop: top };
	}

	//#endregion

	//#region State

	private readonly parts = new Map<string, Part>();

	private connectionBar: ConnectionBar | undefined;
	private navigationBar: NavigationBar | undefined;

	private activeViewContainer!: HTMLElement;
	private chatViewContainer!: HTMLElement;
	private filesViewContainer!: HTMLElement;
	private terminalViewContainer!: HTMLElement;

	private activeTab: MobileTab = MobileTab.Chat;

	private mainWindowFullscreen = false;

	private readonly restoredPromise = new DeferredPromise<void>();
	readonly whenRestored = this.restoredPromise.p;
	private _restored = false;
	readonly openedDefaultEditors = false;

	//#endregion

	//#region Services

	private editorGroupService!: IEditorGroupsService;
	private editorService!: IEditorService;
	private paneCompositeService!: IPaneCompositePartService;
	private viewDescriptorService!: IViewDescriptorService;

	//#endregion

	constructor(
		protected readonly parent: HTMLElement,
		private readonly options: IMobileWorkbenchOptions | undefined,
		private readonly serviceCollection: ServiceCollection,
		logService: ILogService
	) {
		super();

		mark('code/willStartWorkbench');
		this.registerErrorHandler(logService);
	}

	//#region Error Handling

	private registerErrorHandler(logService: ILogService): void {
		if (!isFirefox) {
			Error.stackTraceLimit = 100;
		}

		mainWindow.addEventListener('unhandledrejection', (event) => {
			onUnexpectedError(event.reason);
			event.preventDefault();
		});

		setUnexpectedErrorHandler(error => this.handleUnexpectedError(error, logService));
	}

	private previousUnexpectedError: { message: string | undefined; time: number } = { message: undefined, time: 0 };
	private handleUnexpectedError(error: unknown, logService: ILogService): void {
		const message = toErrorMessage(error, true);
		if (!message) {
			return;
		}

		const now = Date.now();
		if (message === this.previousUnexpectedError.message && now - this.previousUnexpectedError.time <= 1000) {
			return;
		}

		this.previousUnexpectedError.time = now;
		this.previousUnexpectedError.message = message;
		logService.error(message);
	}

	//#endregion

	//#region Startup

	startup(): IInstantiationService {
		try {
			this._register(setGlobalLeakWarningThreshold(175));

			const instantiationService = this.initServices(this.serviceCollection);

			instantiationService.invokeFunction(accessor => {
				const lifecycleService = accessor.get(ILifecycleService);
				const storageService = accessor.get(IStorageService);
				const configurationService = accessor.get(IConfigurationService);
				const hostService = accessor.get(IHostService);
				const hoverService = accessor.get(IHoverService);
				const dialogService = accessor.get(IDialogService);
				const notificationService = accessor.get(INotificationService) as NotificationService;
				const markdownRendererService = accessor.get(IMarkdownRendererService);
				const contextKeyService = accessor.get(IContextKeyService);

				// Set code block renderer
				markdownRendererService.setDefaultCodeBlockRenderer(instantiationService.createInstance(EditorMarkdownCodeBlockRenderer));

				// Default Hover Delegate
				setHoverDelegateFactory((placement, enableInstantHover) => instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover: enableInstantHover }, {}));
				setBaseLayerHoverDelegate(hoverService);

				// Set mobile context key
				IsMobileAppContext.bindTo(contextKeyService).set(true);

				// Track orientation
				this.trackOrientation(contextKeyService);

				// Layout
				this.initLayout(accessor);

				// Registries
				Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).start(accessor);
				Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor);

				// Context Keys
				this._register(instantiationService.createInstance(WorkbenchContextKeysHandler));

				// Register Listeners
				this.registerListeners(lifecycleService, storageService, configurationService, hostService, dialogService);

				// Render Workbench
				this.renderWorkbench(instantiationService, notificationService, storageService, configurationService);

				// Layout
				this.layout();

				// Restore
				this.restore(lifecycleService);
			});

			return instantiationService;
		} catch (error) {
			onUnexpectedError(error);
			throw error;
		}
	}

	private initServices(serviceCollection: ServiceCollection): IInstantiationService {
		serviceCollection.set(IWorkbenchLayoutService, this);

		const contributedServices = getSingletonServiceDescriptors();
		for (const [id, descriptor] of contributedServices) {
			serviceCollection.set(id, descriptor);
		}

		const instantiationService = new InstantiationService(serviceCollection, true);

		instantiationService.invokeFunction(accessor => {
			const lifecycleService = accessor.get(ILifecycleService);
			lifecycleService.phase = LifecyclePhase.Ready;
		});

		return instantiationService;
	}

	private trackOrientation(contextKeyService: IContextKeyService): void {
		const orientationKey = MobileOrientationContext.bindTo(contextKeyService);
		const update = () => {
			orientationKey.set(mainWindow.innerWidth > mainWindow.innerHeight ? 'landscape' : 'portrait');
		};
		update();
		this._register({
			dispose: () => mainWindow.removeEventListener('resize', update)
		});
		mainWindow.addEventListener('resize', update);
	}

	private registerListeners(lifecycleService: ILifecycleService, storageService: IStorageService, configurationService: IConfigurationService, hostService: IHostService, dialogService: IDialogService): void {
		// Font info
		this._register(lifecycleService.onWillShutdown(() => this.storeFontInfo(storageService)));

		// Lifecycle
		this._register(lifecycleService.onWillShutdown(event => this._onWillShutdown.fire(event)));
		this._register(lifecycleService.onDidShutdown(() => {
			this._onDidShutdown.fire();
			this.dispose();
		}));

		// Flush storage on focus loss
		this._register(hostService.onDidChangeFocus(focus => {
			if (!focus) {
				storageService.flush();
			}
		}));

		// Dialogs
		this._register(dialogService.onWillShowDialog(() => this.mainContainer.classList.add('modal-dialog-visible')));
		this._register(dialogService.onDidShowDialog(() => this.mainContainer.classList.remove('modal-dialog-visible')));
	}

	//#region Font Caching

	private restoreFontInfo(storageService: IStorageService, configurationService: IConfigurationService): void {
		const storedFontInfoRaw = storageService.get('editorFontInfo', StorageScope.APPLICATION);
		if (storedFontInfoRaw) {
			try {
				const storedFontInfo = JSON.parse(storedFontInfoRaw);
				if (Array.isArray(storedFontInfo)) {
					FontMeasurements.restoreFontInfo(mainWindow, storedFontInfo);
				}
			} catch {
				/* ignore */
			}
		}
		FontMeasurements.readFontInfo(mainWindow, createBareFontInfoFromRawSettings(configurationService.getValue('editor'), PixelRatio.getInstance(mainWindow).value));
	}

	private storeFontInfo(storageService: IStorageService): void {
		const serializedFontInfo = FontMeasurements.serializeFontInfo(mainWindow);
		if (serializedFontInfo) {
			storageService.store('editorFontInfo', JSON.stringify(serializedFontInfo), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	//#endregion

	private renderWorkbench(instantiationService: IInstantiationService, notificationService: NotificationService, storageService: IStorageService, configurationService: IConfigurationService): void {
		// ARIA & Signals
		setARIAContainer(this.mainContainer);
		setProgressAccessibilitySignalScheduler((msDelayTime: number, msLoopTime?: number) => instantiationService.createInstance(AccessibilityProgressSignalScheduler, msDelayTime, msLoopTime));

		// Workbench classes
		const platformClass = isWindows ? 'windows' : isLinux ? 'linux' : 'mac';
		const workbenchClasses = coalesce([
			'monaco-workbench',
			'mobile-workbench',
			platformClass,
			'web',
			isChrome ? 'chromium' : isFirefox ? 'firefox' : isSafari ? 'safari' : undefined,
			...(this.options?.extraClasses ?? [])
		]);

		this.mainContainer.classList.add(...workbenchClasses);

		// Warm up font cache
		this.restoreFontInfo(storageService, configurationService);

		// Create mobile layout structure
		this.createMobileLayout(instantiationService);

		// Create chat bar part (registered as ChatBar for the VS Code chat panel)
		this.createChatBarPart();

		// Create hidden editor part (for modal editor overlay)
		this.createHiddenEditorPart();

		// Notification Handlers
		this.createNotificationsHandlers(instantiationService, notificationService);

		// Add Workbench to DOM
		this.parent.appendChild(this.mainContainer);
	}

	private createMobileLayout(instantiationService: IInstantiationService): void {
		// Connection bar (top)
		const connectionBarContainer = append(this.mainContainer, $(''));
		this.connectionBar = this._register(instantiationService.createInstance(ConnectionBar, connectionBarContainer));
		this._register(this.connectionBar.onDidPressBack(() => this.navigateBack()));

		// Active view area (center, takes remaining space)
		this.activeViewContainer = append(this.mainContainer, $('.mobile-active-view'));

		// Create view containers for each tab
		this.chatViewContainer = append(this.activeViewContainer, $('.mobile-view.mobile-chat-view'));
		this.filesViewContainer = append(this.activeViewContainer, $('.mobile-view.mobile-file-view.hidden'));
		this.terminalViewContainer = append(this.activeViewContainer, $('.mobile-view.mobile-terminal-view.hidden'));

		// Navigation bar (bottom)
		const navigationBarContainer = append(this.mainContainer, $(''));
		this.navigationBar = this._register(instantiationService.createInstance(NavigationBar, navigationBarContainer));
		this._register(this.navigationBar.onDidSelectTab(tab => this.switchTab(tab)));
	}

	private createChatBarPart(): void {
		// The chat bar part is created within the chat view container
		// and uses the standard VS Code chat panel services
		const chatPartContainer = document.createElement('div');
		chatPartContainer.classList.add('part', 'mobile-chat-bar');
		chatPartContainer.id = Parts.CHATBAR_PART;
		chatPartContainer.setAttribute('role', 'main');
		chatPartContainer.style.width = '100%';
		chatPartContainer.style.height = '100%';

		this.chatViewContainer.appendChild(chatPartContainer);

		mark('code/willCreatePart/' + Parts.CHATBAR_PART);
		this.getPart(Parts.CHATBAR_PART).create(chatPartContainer);
		mark('code/didCreatePart/' + Parts.CHATBAR_PART);
	}

	private createHiddenEditorPart(): void {
		const editorPartContainer = document.createElement('div');
		editorPartContainer.classList.add('part', 'editor');
		editorPartContainer.id = Parts.EDITOR_PART;
		editorPartContainer.setAttribute('role', 'main');
		editorPartContainer.style.display = 'none';

		mark('code/willCreatePart/workbench.parts.editor');
		this.getPart(Parts.EDITOR_PART).create(editorPartContainer, { restorePreviousState: false });
		mark('code/didCreatePart/workbench.parts.editor');

		this.mainContainer.appendChild(editorPartContainer);
	}

	private createNotificationsHandlers(instantiationService: IInstantiationService, notificationService: NotificationService): void {
		const notificationsCenter = this._register(instantiationService.createInstance(NotificationsCenter, this.mainContainer, notificationService.model));
		const notificationsToasts = this._register(instantiationService.createInstance(NotificationsToasts, this.mainContainer, notificationService.model));
		this._register(instantiationService.createInstance(NotificationsAlerts, notificationService.model));
		const notificationsStatus = this._register(instantiationService.createInstance(NotificationsStatus, notificationService.model));

		this._register(notificationsCenter.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
			notificationsToasts.update(notificationsCenter.isVisible);
		}));

		this._register(notificationsToasts.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
		}));

		registerNotificationCommands(notificationsCenter, notificationsToasts, notificationService.model);
		AccessibleViewRegistry.register(new NotificationAccessibleView());

		this.registerNotifications({
			onDidChangeNotificationsVisibility: Event.map(
				Event.any(notificationsToasts.onDidChangeVisibility, notificationsCenter.onDidChangeVisibility),
				() => notificationsToasts.isVisible || notificationsCenter.isVisible
			)
		});
	}

	private registerNotifications(delegate: { onDidChangeNotificationsVisibility: Event<boolean> }): void {
		this._register(delegate.onDidChangeNotificationsVisibility(visible => this._onDidChangeNotificationsVisibility.fire(visible)));
	}

	//#region Tab Navigation

	private switchTab(tab: MobileTab): void {
		if (this.activeTab === tab) {
			return;
		}

		this.activeTab = tab;

		// Show/hide view containers
		this.chatViewContainer.classList.toggle('hidden', tab !== MobileTab.Chat);
		this.filesViewContainer.classList.toggle('hidden', tab !== MobileTab.Files);
		this.terminalViewContainer.classList.toggle('hidden', tab !== MobileTab.Terminal);

		// Open corresponding pane composites
		if (tab === MobileTab.Chat) {
			const defaultView = this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.ChatBar);
			if (defaultView) {
				this.paneCompositeService.openPaneComposite(defaultView.id, ViewContainerLocation.ChatBar);
			}
		}
	}

	private navigateBack(): void {
		// TODO: Implement view stack back navigation
		// For now, switch to chat tab as default
		this.navigationBar?.selectTab(MobileTab.Chat);
	}

	//#endregion

	private restore(lifecycleService: ILifecycleService): void {
		mark('code/didStartWorkbench');
		performance.measure('perf: workbench create & restore', 'code/didLoadWorkbenchMain', 'code/didStartWorkbench');

		// Restore parts
		this.restoreParts();

		lifecycleService.phase = LifecyclePhase.Restored;
		this.setRestored();

		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenWindowIdle(mainWindow, () => lifecycleService.phase = LifecyclePhase.Eventually, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private restoreParts(): void {
		// Open the default chat view
		const defaultChatView = this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.ChatBar);
		if (defaultChatView) {
			this.paneCompositeService.openPaneComposite(defaultChatView.id, ViewContainerLocation.ChatBar);
		}
	}

	private setRestored(): void {
		this._restored = true;
		this.restoredPromise.complete();
	}

	//#endregion

	//#region Initialization

	initLayout(accessor: ServicesAccessor): void {
		this.editorGroupService = accessor.get(IEditorGroupsService);
		this.editorService = accessor.get(IEditorService);
		this.paneCompositeService = accessor.get(IPaneCompositePartService);
		this.viewDescriptorService = accessor.get(IViewDescriptorService);

		// Handle editor opens (show in modal)
		this._register(this.editorService.onWillOpenEditor(() => {
			// Editors open via modal overlay in mobile
		}));

		this._mainContainerDimension = getClientArea(this.parent, new Dimension(375, 812)); // iPhone-sized default
	}

	//#endregion

	//#region Layout Methods

	layout(): void {
		this._mainContainerDimension = getClientArea(
			this.mainWindowFullscreen ? mainWindow.document.body : this.parent
		);

		size(this.mainContainer, this._mainContainerDimension.width, this._mainContainerDimension.height);

		this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
	}

	private handleContainerDidLayout(container: HTMLElement, dimension: IDimension): void {
		this._onDidLayoutContainer.fire({ container, dimension });
		if (container === this.mainContainer) {
			this._onDidLayoutMainContainer.fire(dimension);
		}
		if (container === this.activeContainer) {
			this._onDidLayoutActiveContainer.fire(dimension);
		}
	}

	//#endregion

	//#region Part Management

	registerPart(part: Part): { dispose(): void } {
		const id = part.getId();
		this.parts.set(id, part);
		return { dispose: () => this.parts.delete(id) };
	}

	getPart(key: Parts): Part {
		const part = this.parts.get(key);
		if (!part) {
			throw new Error(`Unknown part ${key}`);
		}
		return part;
	}

	hasFocus(part: Parts): boolean {
		const container = this.getContainer(mainWindow, part);
		if (!container) {
			return false;
		}
		const activeElement = getActiveElement();
		if (!activeElement) {
			return false;
		}
		return isAncestorUsingFlowTo(activeElement, container);
	}

	focusPart(part: MULTI_WINDOW_PARTS, targetWindow: Window): void;
	focusPart(part: SINGLE_WINDOW_PARTS): void;
	focusPart(part: Parts, _targetWindow: Window = mainWindow): void {
		switch (part) {
			case Parts.EDITOR_PART:
				this.editorGroupService.activeGroup.focus();
				break;
			case Parts.CHATBAR_PART:
				this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.ChatBar)?.focus();
				break;
			default: {
				const container = this.getContainer(mainWindow, part);
				container?.focus();
			}
		}
	}

	focus(): void {
		this.focusPart(Parts.CHATBAR_PART);
	}

	//#endregion

	//#region Container Methods

	getContainer(targetWindow: Window): HTMLElement;
	getContainer(targetWindow: Window, part: Parts): HTMLElement | undefined;
	getContainer(targetWindow: Window, part?: Parts): HTMLElement | undefined {
		if (typeof part === 'undefined') {
			return this.getContainerFromDocument(targetWindow.document);
		}
		if (targetWindow === mainWindow) {
			return this.parts.get(part)?.getContainer();
		}
		return undefined;
	}

	whenContainerStylesLoaded(_window: CodeWindow): Promise<void> | undefined {
		return undefined;
	}

	//#endregion

	//#region Part Visibility — simplified for mobile

	isActivityBarHidden(): boolean {
		return true;
	}

	isVisible(part: SINGLE_WINDOW_PARTS): boolean;
	isVisible(part: MULTI_WINDOW_PARTS, targetWindow: Window): boolean;
	isVisible(part: Parts, _targetWindow?: Window): boolean {
		switch (part) {
			case Parts.CHATBAR_PART:
				return this.activeTab === MobileTab.Chat;
			case Parts.EDITOR_PART:
				return false; // Editors are modal
			case Parts.TITLEBAR_PART:
			case Parts.SIDEBAR_PART:
			case Parts.AUXILIARYBAR_PART:
			case Parts.PANEL_PART:
			case Parts.ACTIVITYBAR_PART:
			case Parts.STATUSBAR_PART:
			case Parts.BANNER_PART:
			default:
				return false;
		}
	}

	setPartHidden(_hidden: boolean, _part: Parts): void {
		// Mobile uses tab navigation instead of part visibility
	}

	//#endregion

	//#region Position Methods (Fixed)

	getSideBarPosition(): Position {
		return Position.LEFT;
	}

	getPanelPosition(): Position {
		return Position.BOTTOM;
	}

	setPanelPosition(_position: Position): void {
		// No-op
	}

	getPanelAlignment(): PanelAlignment {
		return 'justify';
	}

	setPanelAlignment(_alignment: PanelAlignment): void {
		// No-op
	}

	//#endregion

	//#region Size Methods

	getSize(_part: Parts): IViewSize {
		return { width: this._mainContainerDimension.width, height: this._mainContainerDimension.height };
	}

	setSize(_part: Parts, _size: IViewSize): void {
		// No-op — mobile layout is not resizable
	}

	resizePart(_part: Parts, _sizeChangeWidth: number, _sizeChangeHeight: number): void {
		// No-op
	}

	getMaximumEditorDimensions(_container: HTMLElement): IDimension {
		return this._mainContainerDimension;
	}

	//#endregion

	//#region No-ops for unsupported features

	toggleZenMode(): void { /* not applicable */ }

	toggleMaximizedPanel(): void { /* not applicable */ }
	isRestored(): boolean { return this._restored; }
	hasMainWindowBorder(): boolean { return false; }
	getMainWindowBorderRadius(): string | undefined { return undefined; }
	isPanelMaximized(): boolean { return false; }
	isAuxiliaryBarMaximized(): boolean { return false; }
	setAuxiliaryBarMaximized(_maximized: boolean): boolean { return false; }
	toggleMaximizedAuxiliaryBar(): void { /* not applicable */ }
	toggleMenuBar(): void { /* not applicable */ }
	isMainEditorLayoutCentered(): boolean { return false; }
	centerMainEditorLayout(_active: boolean): void { /* not applicable */ }
	isWindowMaximized(_targetWindow: Window): boolean { return false; }
	updateWindowMaximizedState(_targetWindow: Window, _maximized: boolean): void { /* not applicable */ }
	getVisibleNeighborPart(_part: Parts, _direction: Direction): Parts | undefined { return undefined; }

	//#endregion
}
