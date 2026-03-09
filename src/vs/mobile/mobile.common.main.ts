/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//#region --- editor/workbench core

import '../editor/editor.all.js';

import '../workbench/api/browser/extensionHost.contribution.js';
import '../workbench/browser/workbench.contribution.js';

//#endregion


//#region --- workbench actions

import '../workbench/browser/actions/textInputActions.js';
import '../workbench/browser/actions/developerActions.js';
import '../workbench/browser/actions/listCommands.js';
import '../workbench/browser/actions/navigationActions.js';
import '../workbench/browser/actions/windowActions.js';
import '../workbench/browser/actions/quickAccessActions.js';
import '../workbench/browser/actions/widgetNavigationCommands.js';

//#endregion


//#region --- mobile external opener

import './contrib/externalOpener/browser/mobileExternalOpener.contribution.js';

//#endregion


//#region --- mobile background connection keeper

import './contrib/connection/browser/backgroundConnectionKeeper.contribution.js';

//#endregion


//#region --- API Extension Points

import '../workbench/services/actions/common/menusExtensionPoint.js';
import '../workbench/api/common/configurationExtensionPoint.js';
import '../workbench/api/browser/viewsExtensionPoint.js';

//#endregion


//#region --- workbench parts

import '../workbench/browser/parts/editor/editor.contribution.js';
import '../workbench/browser/parts/editor/editorParts.js';
import '../workbench/browser/parts/statusbar/statusbarPart.js';

//#endregion


//#region --- workbench services

import '../platform/actions/common/actions.contribution.js';
import '../platform/undoRedo/common/undoRedoService.js';
import '../platform/mcp/common/mcpResourceScannerService.js';
import '../workbench/services/workspaces/common/editSessionIdentityService.js';
import '../workbench/services/workspaces/common/canonicalUriService.js';
import '../workbench/services/extensions/browser/extensionUrlHandler.js';
import '../workbench/services/keybinding/common/keybindingEditing.js';
import '../workbench/services/decorations/browser/decorationsService.js';
import '../workbench/services/dialogs/common/dialogService.js';
import '../workbench/services/progress/browser/progressService.js';
import '../workbench/services/editor/browser/codeEditorService.js';
import '../workbench/services/preferences/browser/preferencesService.js';
import '../workbench/services/configuration/common/jsonEditingService.js';
import '../workbench/services/textmodelResolver/common/textModelResolverService.js';
import '../workbench/services/editor/browser/editorService.js';
import '../workbench/services/editor/browser/editorResolverService.js';
import '../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import '../workbench/services/aiRelatedInformation/common/aiRelatedInformationService.js';
import '../workbench/services/aiSettingsSearch/common/aiSettingsSearchService.js';
import '../workbench/services/history/browser/historyService.js';
import '../workbench/services/activity/browser/activityService.js';
import '../workbench/services/keybinding/browser/keybindingService.js';
import '../workbench/services/untitled/common/untitledTextEditorService.js';
import '../workbench/services/textresourceProperties/common/textResourcePropertiesService.js';
import '../workbench/services/textfile/common/textEditorService.js';
import '../workbench/services/language/common/languageService.js';
import '../workbench/services/model/common/modelService.js';
import '../workbench/services/notebook/common/notebookDocumentService.js';
import '../workbench/services/commands/common/commandService.js';
import '../workbench/services/themes/browser/workbenchThemeService.js';
import '../workbench/services/label/common/labelService.js';
import '../workbench/services/extensions/common/extensionManifestPropertiesService.js';
import '../workbench/services/extensionManagement/common/extensionGalleryService.js';
import '../workbench/services/extensionManagement/browser/extensionEnablementService.js';
import '../workbench/services/extensionManagement/browser/builtinExtensionsScannerService.js';
import '../workbench/services/extensionRecommendations/common/extensionIgnoredRecommendationsService.js';
import '../workbench/services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import '../workbench/services/extensionManagement/common/extensionFeaturesManagemetService.js';
import '../workbench/services/notification/common/notificationService.js';
import '../workbench/services/userDataSync/common/userDataSyncUtil.js';
import '../workbench/services/userDataProfile/browser/userDataProfileImportExportService.js';
import '../workbench/services/userDataProfile/browser/userDataProfileManagement.js';
import '../workbench/services/userDataProfile/common/remoteUserDataProfiles.js';
import '../workbench/services/remote/common/remoteExplorerService.js';
import '../workbench/services/remote/common/remoteExtensionsScanner.js';
import '../workbench/services/terminal/common/embedderTerminalService.js';
import '../workbench/services/workingCopy/common/workingCopyService.js';
import '../workbench/services/workingCopy/common/workingCopyFileService.js';
import '../workbench/services/workingCopy/common/workingCopyEditorService.js';
import '../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import '../workbench/services/views/browser/viewDescriptorService.js';
import '../workbench/services/views/browser/viewsService.js';
import './services/quickinput/browser/mobileQuickInputService.js';
import '../workbench/services/userDataSync/browser/userDataSyncWorkbenchService.js';
import '../workbench/services/authentication/browser/authenticationService.js';
import '../workbench/services/authentication/browser/authenticationExtensionsService.js';
import '../workbench/services/authentication/browser/authenticationUsageService.js';
import '../workbench/services/authentication/browser/authenticationAccessService.js';
import '../workbench/services/authentication/browser/authenticationMcpUsageService.js';
import '../workbench/services/authentication/browser/authenticationMcpAccessService.js';
import '../workbench/services/authentication/browser/authenticationMcpService.js';
import '../workbench/services/authentication/browser/dynamicAuthenticationProviderStorageService.js';
import '../workbench/services/authentication/browser/authenticationQueryService.js';
import '../platform/hover/browser/hoverService.js';
import '../platform/userInteraction/browser/userInteractionServiceImpl.js';
import '../workbench/services/assignment/common/assignmentService.js';
import '../workbench/services/outline/browser/outlineService.js';
import '../workbench/services/languageDetection/browser/languageDetectionWorkerServiceImpl.js';
import '../editor/common/services/languageFeaturesService.js';
import '../editor/common/services/semanticTokensStylingService.js';
import '../editor/common/services/treeViewsDndService.js';
import '../workbench/services/textMate/browser/textMateTokenizationFeature.contribution.js';
import '../workbench/services/treeSitter/browser/treeSitter.contribution.js';
import '../workbench/services/userActivity/common/userActivityService.js';
import '../workbench/services/userActivity/browser/userActivityBrowser.js';
import '../workbench/services/userAttention/browser/userAttentionBrowser.js';
import '../workbench/services/editor/browser/editorPaneService.js';
import '../workbench/services/editor/common/customEditorLabelService.js';
import '../workbench/services/dataChannel/browser/dataChannelService.js';
import '../workbench/services/inlineCompletions/common/inlineCompletionsUnification.js';
import '../workbench/services/chat/common/chatEntitlementService.js';
import '../workbench/services/log/common/defaultLogLevels.js';

import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { GlobalExtensionEnablementService } from '../platform/extensionManagement/common/extensionEnablementService.js';
import { IAllowedExtensionsService, IGlobalExtensionEnablementService } from '../platform/extensionManagement/common/extensionManagement.js';
import { ContextViewService } from '../platform/contextview/browser/contextViewService.js';
import { IContextViewService } from '../platform/contextview/browser/contextView.js';
import { IListService, ListService } from '../platform/list/browser/listService.js';
import { MarkerDecorationsService } from '../editor/common/services/markerDecorationsService.js';
import { IMarkerDecorationsService } from '../editor/common/services/markerDecorations.js';
import { IMarkerService } from '../platform/markers/common/markers.js';
import { MarkerService } from '../platform/markers/common/markerService.js';
import { ContextKeyService } from '../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import { ITextResourceConfigurationService } from '../editor/common/services/textResourceConfiguration.js';
import { TextResourceConfigurationService } from '../editor/common/services/textResourceConfigurationService.js';
import { IDownloadService } from '../platform/download/common/download.js';
import { DownloadService } from '../platform/download/common/downloadService.js';
import { OpenerService } from '../editor/browser/services/openerService.js';
import { IOpenerService } from '../platform/opener/common/opener.js';
import { IgnoredExtensionsManagementService, IIgnoredExtensionsManagementService } from '../platform/userDataSync/common/ignoredExtensions.js';
import { ExtensionStorageService, IExtensionStorageService } from '../platform/extensionManagement/common/extensionStorage.js';
import { IUserDataSyncLogService } from '../platform/userDataSync/common/userDataSync.js';
import { UserDataSyncLogService } from '../platform/userDataSync/common/userDataSyncLog.js';
import { AllowedExtensionsService } from '../platform/extensionManagement/common/allowedExtensionsService.js';
import { IAllowedMcpServersService, IMcpGalleryService } from '../platform/mcp/common/mcpManagement.js';
import { McpGalleryService } from '../platform/mcp/common/mcpGalleryService.js';
import { AllowedMcpServersService } from '../platform/mcp/common/allowedMcpServersService.js';
import { IWebWorkerService } from '../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../platform/webWorker/browser/webWorkerServiceImpl.js';
import { IConnectionService, ConnectionService } from './services/connection/browser/connectionService.js';

registerSingleton(IUserDataSyncLogService, UserDataSyncLogService, InstantiationType.Delayed);
registerSingleton(IAllowedExtensionsService, AllowedExtensionsService, InstantiationType.Delayed);
registerSingleton(IIgnoredExtensionsManagementService, IgnoredExtensionsManagementService, InstantiationType.Delayed);
registerSingleton(IGlobalExtensionEnablementService, GlobalExtensionEnablementService, InstantiationType.Delayed);
registerSingleton(IExtensionStorageService, ExtensionStorageService, InstantiationType.Delayed);
registerSingleton(IContextViewService, ContextViewService, InstantiationType.Delayed);
registerSingleton(IListService, ListService, InstantiationType.Delayed);
registerSingleton(IMarkerDecorationsService, MarkerDecorationsService, InstantiationType.Delayed);
registerSingleton(IMarkerService, MarkerService, InstantiationType.Delayed);
registerSingleton(IContextKeyService, ContextKeyService, InstantiationType.Delayed);
registerSingleton(ITextResourceConfigurationService, TextResourceConfigurationService, InstantiationType.Delayed);
registerSingleton(IDownloadService, DownloadService, InstantiationType.Delayed);
registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed);
registerSingleton(IWebWorkerService, WebWorkerService, InstantiationType.Delayed);
registerSingleton(IMcpGalleryService, McpGalleryService, InstantiationType.Delayed);
registerSingleton(IAllowedMcpServersService, AllowedMcpServersService, InstantiationType.Delayed);
registerSingleton(IConnectionService, ConnectionService, InstantiationType.Delayed);

// Haptic feedback (Capacitor)
import './services/haptics/browser/hapticFeedbackService.js';

//#endregion


//#region --- workbench contributions (mobile-relevant subset)

// Default Account
import '../workbench/services/accounts/browser/defaultAccount.js';

// Telemetry
import '../workbench/contrib/telemetry/browser/telemetry.contribution.js';

// Chat (primary surface for mobile)
import '../workbench/contrib/chat/browser/chat.contribution.js';
import '../workbench/contrib/mcp/browser/mcp.contribution.js';
import '../workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.js';
import '../workbench/contrib/chat/browser/contextContrib/chatContext.contribution.js';

// Speech (voice input on mobile)
import '../workbench/contrib/speech/browser/speech.contribution.js';

// Explorer (file browsing)
import '../workbench/contrib/files/browser/explorerViewlet.js';
import '../workbench/contrib/files/browser/fileActions.contribution.js';
import '../workbench/contrib/files/browser/files.contribution.js';

// Terminal
import '../workbench/contrib/terminal/terminal.all.js';

// Remote
import '../workbench/contrib/remote/common/remote.contribution.js';
import '../workbench/contrib/remote/browser/remote.contribution.js';

// Search
import '../workbench/contrib/search/browser/search.contribution.js';
import '../workbench/contrib/search/browser/searchView.js';

// SCM / Git (for viewing changes)
import '../workbench/contrib/git/browser/git.contributions.js';
import '../workbench/contrib/scm/browser/scm.contribution.js';

// Logs
import '../workbench/contrib/logs/common/logs.contribution.js';

// Quickaccess
import '../workbench/contrib/quickaccess/browser/quickAccess.contribution.js';

// Notebook
import '../workbench/contrib/notebook/browser/notebook.contribution.js';

// Themes
import '../workbench/contrib/themes/browser/themes.contribution.js';

// Authentication
import '../workbench/contrib/authentication/browser/authentication.contribution.js';

// Accessibility
import '../workbench/contrib/accessibility/browser/accessibility.contribution.js';

// Code Editor base contributions
import '../workbench/contrib/codeEditor/browser/codeEditor.contribution.js';

// Snippets
import '../workbench/contrib/snippets/browser/snippets.contribution.js';

// URL Support
import '../workbench/contrib/url/browser/url.contribution.js';

// Webview
import '../workbench/contrib/webview/browser/webview.contribution.js';
import '../workbench/contrib/webviewPanel/browser/webviewPanel.contribution.js';
import '../workbench/contrib/webviewView/browser/webviewView.contribution.js';

// Extensions Management
import '../workbench/contrib/extensions/browser/extensions.contribution.js';
import '../workbench/contrib/extensions/browser/extensionsViewlet.js';

// Output
import '../workbench/contrib/output/browser/output.contribution.js';
import '../workbench/contrib/output/browser/outputView.js';

// Welcome views
import '../workbench/contrib/welcomeViews/common/viewsWelcome.contribution.js';

// List
import '../workbench/contrib/list/browser/list.contribution.js';

// Accessibility Signals
import '../workbench/contrib/accessibilitySignals/browser/accessibilitySignal.contribution.js';

// Language Detection
import '../workbench/contrib/languageDetection/browser/languageDetection.contribution.js';

// Metered Connection
import '../workbench/contrib/meteredConnection/browser/meteredConnection.contribution.js';

// Mobile Connection (server management UI)
import './contrib/connection/browser/connection.contribution.js';

// Mobile Layout (drawer-based navigation, simplified chrome)
import './contrib/mobileLayout/browser/mobileLayout.contribution.js';

//#endregion
