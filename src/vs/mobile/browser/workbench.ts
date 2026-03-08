/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../workbench/browser/style.js';
import './media/style.css';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { Emitter, setGlobalLeakWarningThreshold } from '../../base/common/event.js';
import { getActiveDocument, getActiveElement, getClientArea, getWindows, IDimension, isAncestorUsingFlowTo, size, Dimension, runWhenWindowIdle, $, append, addDisposableListener } from '../../base/browser/dom.js';
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
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
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
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
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
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { MobilePhase } from './parts/parts.js';
import { IsMobileAppContext, MobileOrientationContext, MobilePhaseContext, MobileSessionEditableContext } from '../common/contextkeys.js';
import { ChatWidget } from '../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ChatAgentLocation } from '../../workbench/contrib/chat/common/constants.js';
import { IChatModelReference, IChatService, convertLegacyChatSessionTiming } from '../../workbench/contrib/chat/common/chatService/chatService.js';
import { SIDE_BAR_FOREGROUND, EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../workbench/common/theme.js';
import { editorBackground, inputBackground } from '../../platform/theme/common/colorRegistry.js';
import { WelcomePage } from './parts/welcomePage.js';
import { WorkspacePicker, ISavedWorkspace } from './parts/workspacePicker.js';
import { TopBar } from './parts/topBar.js';
import { Drawer, DrawerAction, IChatSessionItem } from './parts/drawer.js';
import { IConnectionService, IServerInfo } from '../services/connection/browser/connectionService.js';
import { IHapticFeedbackService, HapticImpactStyle } from '../services/haptics/browser/hapticFeedbackService.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { localize } from '../../nls.js';
import { URI } from '../../base/common/uri.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from '../../workbench/contrib/files/common/files.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { isNativeMobileApp, listenMobileBackButton, minimizeApp, navigateToShell } from './navigation.js';


//#region Workbench Options

/**
 * Session info provided externally by the caller (e.g. mobile app shell
 * or web browser). When provided, the connection is pre-established and
 * the user may or may not be able to change it depending on `editable`.
 */
export interface IMobileSessionInfo {
	/** The server to connect to. */
	readonly server: IServerInfo;
	/** Whether the user can change the connection. Defaults to true. */
	readonly editable: boolean;
}

export interface IMobileWorkbenchOptions {
	extraClasses?: string[];
	/**
	 * Externally-provided session info. When set, the mobile workbench
	 * skips the welcome page and uses this connection directly.
	 * If `editable` is false, the connection UI is locked.
	 */
	sessionInfo?: IMobileSessionInfo;
	/**
	 * An element to remove once the workbench has rendered (e.g. a loading splash).
	 */
	loadingSplash?: HTMLElement;
}

//#endregion

const SAVED_WORKSPACES_KEY = 'mobile.savedWorkspaces';

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
		const top = this.topBar?.getHeight() ?? 44;
		return { top, quickPickTop: top };
	}

	//#endregion

	//#region State

	private readonly parts = new Map<string, Part>();

	// Phase-based UI components
	private phase: MobilePhase = MobilePhase.Welcome;
	private phaseKey: { set(v: string): void } | undefined;
	private welcomePage: WelcomePage | undefined;
	private workspacePicker: WorkspacePicker | undefined;
	private topBar: TopBar | undefined;
	private drawer: Drawer | undefined;
	private chatViewContainer!: HTMLElement;
	private chatWidget: ChatWidget | undefined;
	private chatService: IChatService | undefined;
	private readonly currentModelRef = this._register(new MutableDisposable<IChatModelReference>());

	// Files view
	private filesViewContainer!: HTMLElement;
	private filesViewInitialized = false;
	private _activeView: 'chat' | 'files' = 'chat';

	// Editor overlay (shown when a file is opened from the explorer or chat)
	private editorOverlayContainer!: HTMLElement;
	private editorPartInitialized = false;
	private _editorVisible = false;
	private _editorOpenedFrom: 'chat' | 'files' = 'files';
	private _filesViewReady = false;

	private _keyboardVisible = false;
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
	private commandService!: ICommandService;
	private storageService!: IStorageService;
	private fileDialogService!: IFileDialogService;
	private quickInputService!: IQuickInputService;
	private workspaceContextService!: IWorkspaceContextService;

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
				const markdownRendererService = accessor.get(IMarkdownRendererService);
				const contextKeyService = accessor.get(IContextKeyService);
				this.commandService = accessor.get(ICommandService);
				this.storageService = storageService;
				this.fileDialogService = accessor.get(IFileDialogService);

				// Set code block renderer
				markdownRendererService.setDefaultCodeBlockRenderer(instantiationService.createInstance(EditorMarkdownCodeBlockRenderer));

				// Default Hover Delegate
				setHoverDelegateFactory((placement, enableInstantHover) => instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover: enableInstantHover }, {}));
				setBaseLayerHoverDelegate(hoverService);

				// Set mobile context key
				IsMobileAppContext.bindTo(contextKeyService).set(true);

				// Track orientation & keyboard
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
				this.renderWorkbench(instantiationService, storageService, configurationService, contextKeyService);

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

		const updateOrientation = () => {
			orientationKey.set(mainWindow.innerWidth > mainWindow.innerHeight ? 'landscape' : 'portrait');
		};
		updateOrientation();
		mainWindow.addEventListener('resize', updateOrientation);
		this._register({ dispose: () => mainWindow.removeEventListener('resize', updateOrientation) });

		// Detect keyboard open/close and relayout.
		// With Capacitor Keyboard.resize: 'body', Android resizes the WebView
		// body when the keyboard opens, which fires window 'resize' events.
		// On iOS, visualViewport.resize fires instead. We listen to both.
		const onKeyboardChange = () => {
			let keyboardVisible = false;
			if (mainWindow.visualViewport) {
				keyboardVisible = mainWindow.innerHeight - mainWindow.visualViewport.height > 150;
			}
			// Fallback: if the window was resized significantly smaller than
			// screen height, the keyboard is likely open (Android adjustResize).
			if (!keyboardVisible && mainWindow.screen) {
				keyboardVisible = mainWindow.screen.height - mainWindow.innerHeight > 200;
			}
			if (keyboardVisible !== this._keyboardVisible) {
				this._keyboardVisible = keyboardVisible;
				this.mainContainer.classList.toggle('keyboard-visible', keyboardVisible);
				this.layout();
			}
		};

		mainWindow.addEventListener('resize', onKeyboardChange);
		this._register({ dispose: () => mainWindow.removeEventListener('resize', onKeyboardChange) });

		if (mainWindow.visualViewport) {
			mainWindow.visualViewport.addEventListener('resize', onKeyboardChange);
			this._register({ dispose: () => mainWindow.visualViewport!.removeEventListener('resize', onKeyboardChange) });
		}
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

	private renderWorkbench(instantiationService: IInstantiationService, storageService: IStorageService, configurationService: IConfigurationService, contextKeyService: IContextKeyService): void {
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

		// Create mobile layout structure based on current state
		this.createMobileLayout(instantiationService, contextKeyService);

		// Bridge touch taps to click events for interactive elements
		// The VS Code Gesture system calls preventDefault() on touch events,
		// which prevents the browser from generating synthetic click events.
		// This means <a> links and buttons inside rendered markdown never receive clicks.
		this.setupTouchClickBridge();

		// Add Workbench to DOM
		this.parent.appendChild(this.mainContainer);

		// Remove the loading splash now that the workbench has rendered
		this.options?.loadingSplash?.remove();
	}

	private setupTouchClickBridge(): void {
		let touchStartTime = 0;
		let touchStartX = 0;
		let touchStartY = 0;
		let touchStartTarget: Element | null = null;

		this._register(addDisposableListener(this.mainContainer, 'touchstart', (e: TouchEvent) => {
			if (e.touches.length === 1) {
				touchStartTime = Date.now();
				touchStartX = e.touches[0].pageX;
				touchStartY = e.touches[0].pageY;
				touchStartTarget = mainWindow.document.elementFromPoint(e.touches[0].pageX, e.touches[0].pageY);
			}
		}, { passive: true }));

		this._register(addDisposableListener(this.mainContainer, 'touchend', (e: TouchEvent) => {
			if (e.changedTouches.length !== 1) {
				return;
			}
			const touch = e.changedTouches[0];
			const dt = Date.now() - touchStartTime;
			const dx = Math.abs(touch.pageX - touchStartX);
			const dy = Math.abs(touch.pageY - touchStartY);

			// Only for quick taps (< 300ms, < 10px movement)
			if (dt > 300 || dx > 10 || dy > 10) {
				return;
			}

			const target = mainWindow.document.elementFromPoint(touch.pageX, touch.pageY);
			if (!target) {
				return;
			}

			// Guard: if the DOM changed between touchstart and touchend
			// (e.g. a drawer opened), the element under the finger may be
			// completely different.  Only dispatch the synthetic click when
			// the start and end targets are the same element or one
			// contains the other.
			if (touchStartTarget && target !== touchStartTarget &&
				!target.contains(touchStartTarget) &&
				!touchStartTarget.contains(target)) {
				return;
			}

			// Find the closest interactive element that needs a synthetic click.
			// Native <button> elements already receive clicks with touch-action:
			// manipulation, so only target links and ARIA roles where the Gesture
			// system's preventDefault() suppresses the native click.
			const interactive = target.closest('a[href], a[data-href], [role="button"], [role="menuitem"]');
			if (interactive && !interactive.matches('button')) {
				interactive.dispatchEvent(new MouseEvent('click', {
					bubbles: true,
					cancelable: true,
					view: mainWindow,
					clientX: touch.clientX,
					clientY: touch.clientY,
				}));
			}
		}, { passive: true }));
	}

	//#region Mobile Layout — three-phase flow

	private createMobileLayout(instantiationService: IInstantiationService, contextKeyService: IContextKeyService): void {
		const phaseKey = MobilePhaseContext.bindTo(contextKeyService);
		this.phaseKey = phaseKey;
		const sessionEditableKey = MobileSessionEditableContext.bindTo(contextKeyService);

		// If external session info was provided, initialize the connection service
		const sessionInfo = this.options?.sessionInfo;
		if (sessionInfo) {
			const connectionService = instantiationService.invokeFunction(a => a.get(IConnectionService));
			connectionService.initializeFromExternal(sessionInfo.server, sessionInfo.editable);
			sessionEditableKey.set(sessionInfo.editable);
		}

		// Determine initial phase from URL query params or server-injected config.
		// When served from the code server's /chat endpoint, remoteAuthority is
		// in the DOM meta tag rather than the URL query string.
		const urlParams = new URLSearchParams(mainWindow.location.search);
		const configRemoteAuthority = this.getConfigRemoteAuthority();
		const remoteAuthority = urlParams.get('remoteAuthority') || configRemoteAuthority;
		const hasFolder = urlParams.has('folder') || urlParams.has('workspace');

		if (remoteAuthority && hasFolder) {
			this.phase = MobilePhase.Chat;
		} else if (remoteAuthority) {
			this.phase = MobilePhase.WorkspacePicker;
		} else {
			this.phase = MobilePhase.Welcome;
		}
		phaseKey.set(this.phase);

		// Create all phase containers (only one visible at a time)
		this.createWelcomePage(instantiationService);
		this.createWorkspacePicker(urlParams);
		this.createChatPhase(instantiationService, urlParams);

		// Show the correct phase
		this.showPhase(this.phase, phaseKey);

		// Android hardware back button handling via Capacitor App plugin.
		// Priority: dismiss quick pick → close drawer → close editor →
		// files→chat → chat→workspace picker → workspace picker→shell → minimize
		this._register(listenMobileBackButton(() => {
			// 1. Dismiss any open quick pick / input box
			if (this.quickInputService.currentQuickInput) {
				this.quickInputService.cancel();
				return;
			}

			// 2. Close drawer if open
			if (this.drawer?.isOpen) {
				this.drawer.close();
				return;
			}

			// 3. Phase-specific navigation
			switch (this.phase) {
				case MobilePhase.Chat:
					if (this._editorVisible) {
						// Editor visible → simulate top bar back (return to originating view)
						this.topBar?.fireBack();
					} else if (this._activeView === 'files') {
						// Files → chat
						this.showActiveView('chat');
					} else {
						// Chat → workspace picker
						this.switchToWorkspacePicker();
					}
					break;
				case MobilePhase.WorkspacePicker:
					// Workspace picker → server list (shell)
					navigateToShell();
					break;
				case MobilePhase.Welcome:
					// Welcome page (server list) → minimize the app
					minimizeApp();
					break;
			}
		}));
	}

	private createWelcomePage(instantiationService: IInstantiationService): void {
		this.welcomePage = this._register(new WelcomePage(this.mainContainer));

		// Populate saved servers
		const connectionService = instantiationService.invokeFunction(a => a.get(IConnectionService));
		this.welcomePage.updateServers(connectionService.getSavedServers());

		this._register(this.welcomePage.onDidSelectServer(server => {
			connectionService.connect(server);
		}));
		this._register(this.welcomePage.onDidRequestNewConnection(() => {
			this.commandService.executeCommand('mobile.connectToServer');
		}));
	}

	private createWorkspacePicker(urlParams: URLSearchParams): void {
		this.workspacePicker = this._register(new WorkspacePicker(this.mainContainer));

		const remoteAuthority = urlParams.get('remoteAuthority') || this.getConfigRemoteAuthority();

		// Populate saved workspaces
		const savedWorkspaces = this.getSavedWorkspaces();
		this.workspacePicker.updateWorkspaces(savedWorkspaces);

		this._register(this.workspacePicker.onDidSelectWorkspace(path => {
			this.openWorkspace(path, remoteAuthority ?? '');
		}));
		this._register(this.workspacePicker.onDidRequestOpenFolder(async () => {
			const result = await this.fileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				title: localize('addFolder', "Add Folder")
			});
			if (result && result.length > 0) {
				this.saveWorkspace(result[0].path);
				this.workspacePicker?.updateWorkspaces(this.getSavedWorkspaces());
			}
		}));
		this._register(this.workspacePicker.onDidAddWorkspace(path => {
			this.saveWorkspace(path);
			this.workspacePicker?.updateWorkspaces(this.getSavedWorkspaces());
		}));
		this._register(this.workspacePicker.onDidRemoveWorkspace(path => {
			this.removeWorkspace(path);
			this.workspacePicker?.updateWorkspaces(this.getSavedWorkspaces());
		}));
	}

	private createChatPhase(instantiationService: IInstantiationService, urlParams: URLSearchParams): void {
		// Top bar (hamburger + title)
		this.topBar = this._register(new TopBar(this.mainContainer));

		// Chat view container (fills remaining space)
		this.chatViewContainer = append(this.mainContainer, $('.mobile-active-view'));
		const chatView = append(this.chatViewContainer, $('.mobile-view.mobile-chat-view'));

		// Files view container (hidden by default, shown when "Files" is tapped)
		this.filesViewContainer = append(this.mainContainer, $('.mobile-active-view.mobile-files-view'));
		this.filesViewContainer.style.display = 'none';

		// Editor overlay (hidden by default, shown when a file is opened from explorer or chat)
		this.editorOverlayContainer = append(this.mainContainer, $('.mobile-active-view.mobile-editor-overlay'));
		this.editorOverlayContainer.style.display = 'none';

		// Create chat widget when in chat phase
		const remoteAuthority = urlParams.get('remoteAuthority') || this.getConfigRemoteAuthority();
		if (remoteAuthority && (urlParams.has('folder') || urlParams.has('workspace'))) {
			this.createChatWidget(instantiationService, chatView);
		}

		// Drawer (overlays entire workbench)
		this.drawer = this._register(instantiationService.createInstance(Drawer, this.mainContainer));

		// Wire up top bar → drawer
		this._register(this.topBar.onDidPressMenu(() => {
			this.drawer?.toggle();
		}));

		// Wire up top bar back button — navigate back through the stack:
		// editor → originating view (chat or files) → chat
		this._register(this.topBar.onDidPressBack(() => {
			if (this._editorVisible) {
				// Close editor, return to the view that opened it
				const returnTo = this._editorOpenedFrom;
				this.hideEditorOverlay();
				if (returnTo === 'chat') {
					// Restore chat directly — _activeView is already 'chat'
					// so showActiveView would early-return
					this.chatViewContainer.style.display = '';
					this.topBar?.setTitle(this.chatWidget?.viewModel?.model.title || localize('newChat', "New Chat"));
					this.topBar?.setBackVisible(false);
					this.layoutChatWidget();
				} else {
					this.filesViewContainer.style.display = '';
					this.topBar?.setTitle(this.getFilesViewTitle());
					this.topBar?.setBackVisible(true);
					this.layoutFilesView();
				}
			} else {
				this.showActiveView('chat');
			}
		}));

		// Wire up drawer actions
		this._register(this.drawer.onDidSelectAction(action => this.handleDrawerAction(instantiationService, action)));

		// Wire up drawer session selection
		this._register(this.drawer.onDidSelectSession(sessionId => this.switchToSession(URI.parse(sessionId))));

		// Populate drawer with chat sessions and refresh on changes
		if (this.chatService) {
			this.refreshDrawerSessions();
			this._register(this.chatService.onDidCreateModel(() => this.refreshDrawerSessions()));
			this._register(this.chatService.onDidDisposeSession(() => this.refreshDrawerSessions()));
		}

		// Wire up footer navigation — change server / workspace
		// Enable if session is editable, or if running inside the native
		// mobile app (where tapping the connection info returns to the
		// native shell's server list regardless of editability).
		const sessionEditable = this.options?.sessionInfo?.editable ?? true;
		const canNavigateToShell = sessionEditable || isNativeMobileApp();
		this._register(this.drawer.onDidPressConnection(() => {
			if (!canNavigateToShell) {
				return;
			}
			// Go back to the app shell (server selection page)
			navigateToShell();
		}));
		this._register(this.drawer.onDidPressWorkspace(() => {
			// Switch to workspace picker in-place (no reload)
			this.switchToWorkspacePicker();
		}));

		// Update drawer footer with connection + workspace info
		if (remoteAuthority) {
			this.drawer.updateConnectionInfo(remoteAuthority, 'connected', canNavigateToShell);
		}
		const folder = urlParams.get('folder');
		if (folder) {
			const allPaths = this.getSavedWorkspaces().map(w => w.path);
			this.drawer.updateWorkspaceInfo(folder, allPaths);
		}
	}

	private showPhase(phase: MobilePhase, phaseKey?: { set(v: string): void }): void {
		this.phase = phase;
		phaseKey?.set(phase);

		const isWelcome = phase === MobilePhase.Welcome;
		const isWorkspace = phase === MobilePhase.WorkspacePicker;
		const isChat = phase === MobilePhase.Chat;

		if (isWelcome) {
			this.welcomePage?.show();
		} else {
			this.welcomePage?.hide();
		}
		if (isWorkspace) {
			this.workspacePicker?.show();
		} else {
			this.workspacePicker?.hide();
		}
		if (isChat) {
			this.topBar?.show();
			this.chatViewContainer.style.display = '';
		} else {
			this.topBar?.hide();
			this.chatViewContainer.style.display = 'none';
		}
	}

	/**
	 * Switch back to the workspace picker without a page reload.
	 * Hides the chat phase UI and shows the picker, then updates the
	 * URL so a manual refresh lands on the picker too.
	 */
	private switchToWorkspacePicker(): void {
		// Close the drawer if open
		this.drawer?.close();

		// Also hide files/editor overlays if visible
		if (this.filesViewContainer) {
			this.filesViewContainer.style.display = 'none';
		}
		if (this.editorOverlayContainer) {
			this.editorOverlayContainer.style.display = 'none';
		}

		// Refresh the workspace list before showing
		this.workspacePicker?.updateWorkspaces(this.getSavedWorkspaces());

		// Switch phase
		this.showPhase(MobilePhase.WorkspacePicker, this.phaseKey);

		// Update URL without reloading so a manual refresh lands here
		const params = new URLSearchParams(mainWindow.location.search);
		params.delete('folder');
		params.delete('workspace');
		const newUrl = `${mainWindow.location.pathname}?${params.toString()}`;
		mainWindow.history.pushState(null, '', newUrl);
	}

	//#endregion

	//#region Workspace Management

	private getSavedWorkspaces(): ISavedWorkspace[] {
		const raw = this.storageService.get(SAVED_WORKSPACES_KEY, StorageScope.APPLICATION);
		let workspaces: ISavedWorkspace[] = [];
		if (raw) {
			try {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					workspaces = parsed;
				}
			} catch {
				// ignore
			}
		}
		return workspaces;
	}

	private saveWorkspace(path: string): void {
		const workspaces = this.getSavedWorkspaces();
		if (!workspaces.some(w => w.path === path)) {
			workspaces.push({ path });
			this.storageService.store(SAVED_WORKSPACES_KEY, JSON.stringify(workspaces), StorageScope.APPLICATION, StorageTarget.USER);
		}
	}

	private removeWorkspace(path: string): void {
		const workspaces = this.getSavedWorkspaces().filter(w => w.path !== path);
		this.storageService.store(SAVED_WORKSPACES_KEY, JSON.stringify(workspaces), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private openWorkspace(path: string, remoteAuthority: string): void {
		this.saveWorkspace(path);

		// If the selected workspace is already the current one, just switch
		// back to the chat phase without reloading.
		const currentFolder = new URLSearchParams(mainWindow.location.search).get('folder');
		if (currentFolder) {
			// The URL folder may be a full vscode-remote:// URI — extract the path
			const currentPath = currentFolder.replace(/^vscode-remote:\/\/[^/]*/, '');
			if (currentPath === path) {
				this.showPhase(MobilePhase.Chat, this.phaseKey);
				return;
			}
		}

		const params = new URLSearchParams(mainWindow.location.search);
		// Use full vscode-remote URI so the workspace resolver and validator work correctly
		const folderUri = remoteAuthority && path.startsWith('/')
			? `vscode-remote://${remoteAuthority}${path}`
			: path;
		params.set('folder', folderUri);
		params.set('remoteAuthority', remoteAuthority);
		mainWindow.location.search = params.toString();
	}

	/**
	 * Read the remote authority from the server-injected workbench configuration.
	 * When the mobile workbench is served from the code server's /chat endpoint,
	 * the remote authority is embedded in the DOM meta tag rather than the URL.
	 */
	private getConfigRemoteAuthority(): string | undefined {
		// eslint-disable-next-line no-restricted-syntax
		const configData = mainWindow.document.getElementById('vscode-workbench-web-configuration')?.getAttribute('data-settings');
		if (configData) {
			try {
				const config = JSON.parse(configData.replace(/&quot;/g, '"'));
				return config.remoteAuthority || undefined;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	//#endregion

	//#region Drawer Actions

	private handleDrawerAction(instantiationService: IInstantiationService, action: DrawerAction): void {
		switch (action) {
			case 'newChat': {
				this.showActiveView('chat');
				if (!this.chatService || !this.chatWidget) {
					break;
				}
				const modelRef = this.chatService.startNewLocalSession(ChatAgentLocation.Chat);
				this.currentModelRef.value = modelRef;
				this.chatWidget.setModel(modelRef.object);
				this.topBar?.setTitle(localize('newChat', "New Chat"));
				this.refreshDrawerSessions();
				break;
			}
			case 'files':
				this.showActiveView('files');
				this.initFilesView();
				break;
		}
	}

	private async refreshDrawerSessions(): Promise<void> {
		if (!this.chatService || !this.drawer) {
			return;
		}
		const details = await this.chatService.getLocalSessionHistory();
		const items: IChatSessionItem[] = details
			.filter(d => convertLegacyChatSessionTiming(d.timing).lastRequestStarted !== undefined)
			.sort((a, b) => b.lastMessageDate - a.lastMessageDate)
			.map(d => ({
				sessionId: d.sessionResource.toString(),
				title: d.title,
			}));
		this.drawer.updateSessions(items);
	}

	private async switchToSession(sessionResource: URI): Promise<void> {
		if (!this.chatService || !this.chatWidget) {
			return;
		}
		const modelRef = await this.chatService.acquireOrLoadSession(sessionResource, ChatAgentLocation.Chat, CancellationToken.None);
		if (modelRef) {
			this.currentModelRef.value = modelRef;
			this.chatWidget.setModel(modelRef.object);
			this.topBar?.setTitle(modelRef.object.title || localize('newChat', "New Chat"));
		}
	}

	//#endregion

	//#region Active View Switching

	private getFilesViewTitle(): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].name : localize('files', "Files");
	}

	private showActiveView(view: 'chat' | 'files'): void {
		if (this._activeView === view) {
			return;
		}
		this._activeView = view;
		this.hideEditorOverlay();

		if (view === 'chat') {
			this.chatViewContainer.style.display = '';
			this.filesViewContainer.style.display = 'none';
			this.topBar?.setTitle(this.chatWidget?.viewModel?.model.title || localize('newChat', "New Chat"));
			this.topBar?.setBackVisible(false);
			this.layoutChatWidget();
		} else {
			this.chatViewContainer.style.display = 'none';
			this.filesViewContainer.style.display = '';
			this.topBar?.setTitle(this.getFilesViewTitle());
			this.topBar?.setBackVisible(true);
			this.layoutFilesView();
		}
	}

	private showEditorOverlay(): void {
		if (this._editorVisible) {
			return;
		}
		this._editorVisible = true;
		this._editorOpenedFrom = this._activeView;
		this.initEditorPart();
		this.editorOverlayContainer.style.display = '';
		this.chatViewContainer.style.display = 'none';
		this.filesViewContainer.style.display = 'none';
		const editorName = this.editorService.activeEditor?.getName() ?? localize('editor', "Editor");
		this.topBar?.setTitle(editorName);
		this.topBar?.setBackVisible(true);
		this.layoutEditorOverlay();
	}

	private hideEditorOverlay(): void {
		if (!this._editorVisible) {
			return;
		}
		this._editorVisible = false;
		this.editorOverlayContainer.style.display = 'none';
		// Close all editors when leaving the overlay
		this.editorGroupService.activeGroup.closeAllEditors();
	}

	private initEditorPart(): void {
		if (this.editorPartInitialized) {
			return;
		}
		this.editorPartInitialized = true;

		const editorPart = this.parts.get(Parts.EDITOR_PART);
		if (editorPart) {
			const partContainer = document.createElement('div');
			partContainer.classList.add('part', 'editor');
			partContainer.id = Parts.EDITOR_PART;
			partContainer.setAttribute('role', 'main');
			this.editorOverlayContainer.appendChild(partContainer);
			editorPart.create(partContainer);
		}
	}

	private layoutEditorOverlay(): void {
		if (!this._editorVisible) {
			return;
		}
		const editorPart = this.parts.get(Parts.EDITOR_PART);
		if (!editorPart) {
			return;
		}
		const partContainer = editorPart.getContainer();
		if (!partContainer) {
			return;
		}
		const topBarHeight = this.topBar?.getHeight() ?? 44;
		const width = this._mainContainerDimension.width;
		const height = this._mainContainerDimension.height - topBarHeight;
		if (width > 0 && height > 0) {
			size(partContainer, width, height);
			editorPart.layout(width, height, topBarHeight, 0);
		}
	}

	private async initFilesView(): Promise<void> {
		if (this.filesViewInitialized) {
			this.layoutFilesView();
			return;
		}
		this.filesViewInitialized = true;

		try {
			// Force instantiation of the PaneCompositePartService (it's delayed).
			this.paneCompositeService.getPaneComposites(ViewContainerLocation.Sidebar);

			const sidebarPart = this.parts.get(Parts.SIDEBAR_PART);
			if (!sidebarPart) {
				return;
			}

			const partContainer = document.createElement('div');
			partContainer.classList.add('part', 'sidebar', 'left');
			partContainer.id = Parts.SIDEBAR_PART;
			partContainer.setAttribute('role', 'none');
			this.filesViewContainer.appendChild(partContainer);

			sidebarPart.create(partContainer);

			// Pre-initialize the editor part so file clicks can open editors
			// immediately. The EditorPart needs its DOM created before
			// editorService.openEditor() can render an editor widget.
			this.initEditorPart();

			await this.paneCompositeService.openPaneComposite(EXPLORER_VIEWLET_ID, ViewContainerLocation.Sidebar, true);
			this.layoutFilesView();

			// Close any auto-restored editors (e.g. welcome) and mark ready.
			// The _filesViewReady flag ensures the editor overlay stays hidden
			// until after initialization completes.
			await this.editorGroupService.activeGroup.closeAllEditors();
			this._filesViewReady = true;
		} catch (err) {
			console.error('[mobile] initFilesView error:', err);
		}
	}

	private layoutFilesView(): void {
		if (this._activeView !== 'files') {
			return;
		}
		const sidebarPart = this.parts.get(Parts.SIDEBAR_PART);
		if (!sidebarPart) {
			return;
		}
		// Skip layout if the part hasn't been create()'d yet — initFilesView
		// will call layoutFilesView again after creating the sidebar.
		const partContainer = sidebarPart.getContainer();
		if (!partContainer) {
			return;
		}
		const topBarHeight = this.topBar?.getHeight() ?? 44;
		const width = this._mainContainerDimension.width;
		const height = this._mainContainerDimension.height - topBarHeight;
		if (width > 0 && height > 0) {
			size(partContainer, width, height);
			sidebarPart.layout(width, height, topBarHeight, 0);
		}
	}

	//#endregion

	//#region Chat Widget

	private createChatWidget(instantiationService: IInstantiationService, container: HTMLElement): void {
		try {
			const contextKeyService = instantiationService.invokeFunction(accessor => accessor.get(IContextKeyService));
			const scopedContextKeyService = contextKeyService.createScoped(container);
			const scopedInstantiationService = instantiationService.createChild(
				new ServiceCollection([IContextKeyService, scopedContextKeyService])
			);

			const chatWidget = this._register(scopedInstantiationService.createInstance(
				ChatWidget,
				ChatAgentLocation.Chat,
				{ viewId: 'mobile.chat' },
				{
					autoScroll: true,
					renderFollowups: true,
					supportsFileReferences: true,
					enableImplicitContext: true,
					supportsChangingModes: true,
				},
				{
					listForeground: SIDE_BAR_FOREGROUND,
					listBackground: editorBackground,
					overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
					inputEditorBackground: inputBackground,
					resultEditorBackground: editorBackground,
				}
			));

			chatWidget.render(container);
			chatWidget.setVisible(true);
			this.chatWidget = chatWidget;

			// Haptic feedback + "sending" state on send — fires immediately when
			// the user taps send, before the async submission pipeline.
			const hapticService = instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IHapticFeedbackService); } catch { return undefined; }
			});
			this._register(chatWidget.onDidAcceptInput(() => {
				container.classList.add('mobile-sending');
				hapticService?.impact(HapticImpactStyle.Light);
			}));
			this._register(chatWidget.onDidSubmitAgent(() => {
				container.classList.remove('mobile-sending');
			}));

			this.chatService = instantiationService.invokeFunction(accessor => accessor.get(IChatService));
			const modelRef = this.chatService.startNewLocalSession(ChatAgentLocation.Chat);
			if (modelRef) {
				this.currentModelRef.value = modelRef;
				chatWidget.setModel(modelRef.object);
			}

			// Layout after the DOM is settled so the container has real dimensions
			mainWindow.requestAnimationFrame(() => {
				this.layoutChatWidget();
				setTimeout(() => this.layoutChatWidget(), 200);
			});
		} catch (error) {
			const errorMsg = append(container, $('.mobile-chat-error'));
			errorMsg.textContent = `Chat: ${error}`;
			errorMsg.style.cssText = 'padding:20px;color:var(--vscode-errorForeground,#f48771);font-size:13px;word-break:break-word;';
			console.error('[mobile] Failed to create ChatWidget:', error);
		}
	}

	//#endregion



	//#region Tab Navigation — replaced by drawer

	private restore(lifecycleService: ILifecycleService): void {
		mark('code/didStartWorkbench');
		performance.measure('perf: workbench create & restore', 'code/didLoadWorkbenchMain', 'code/didStartWorkbench');

		// Restore parts only in chat phase
		if (this.phase === MobilePhase.Chat) {
			this.restoreParts();
		}

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
		this.quickInputService = accessor.get(IQuickInputService);
		this.workspaceContextService = accessor.get(IWorkspaceContextService);

		// Force ViewsService instantiation so it populates the
		// PaneCompositeRegistry with built-in view containers (explorer, etc.).
		// ViewsService is Eager but behind a proxy — calling a method forces
		// construction which then registers all view container descriptors.
		accessor.get(IViewsService);

		// Handle editor opens — show editor overlay on top of the current view.
		// initEditorPart() is called lazily inside showEditorOverlay() so the
		// editor part DOM is created on first use, avoiding auto-restored
		// welcome/walkthrough editors at startup.
		this._register(this.editorService.onDidActiveEditorChange(() => {
			if (this.editorService.activeEditor && (this._activeView === 'files' ? this._filesViewReady : true)) {
				this.showEditorOverlay();
			}
		}));

		this._mainContainerDimension = getClientArea(this.parent, new Dimension(375, 812)); // iPhone-sized default
	}

	//#endregion

	//#region Layout Methods

	layout(): void {
		this._mainContainerDimension = getClientArea(
			this.mainWindowFullscreen ? mainWindow.document.body : this.parent
		);

		// When the virtual keyboard is visible, use the visual viewport height
		// so the flex layout shrinks the active view above the keyboard.
		if (this._keyboardVisible && mainWindow.visualViewport) {
			this._mainContainerDimension = new Dimension(
				this._mainContainerDimension.width,
				mainWindow.visualViewport.height
			);
		}

		size(this.mainContainer, this._mainContainerDimension.width, this._mainContainerDimension.height);

		// Layout the active view
		this.layoutChatWidget();
		this.layoutFilesView();
		this.layoutEditorOverlay();

		this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
	}

	private layoutChatWidget(): void {
		if (!this.chatWidget || this.phase !== MobilePhase.Chat) {
			return;
		}
		const topBarHeight = this.topBar?.getHeight() ?? 44;
		const width = this._mainContainerDimension.width;
		const height = this._mainContainerDimension.height - topBarHeight;
		if (width > 0 && height > 0) {
			this.chatWidget.layout(height, width);
		}
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
				return this.phase === MobilePhase.Chat;
			case Parts.SIDEBAR_PART:
				return this.phase === MobilePhase.Chat && this._activeView === 'files';
			case Parts.EDITOR_PART:
				return this._editorVisible;
			case Parts.TITLEBAR_PART:
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
		// Mobile uses phase-based navigation
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
