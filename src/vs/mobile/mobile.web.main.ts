/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// #######################################################################
// ###                                                                 ###
// ### !!! PLEASE ADD COMMON IMPORTS INTO MOBILE.COMMON.MAIN.TS !!!    ###
// ###                                                                 ###
// #######################################################################

//#region --- full web workbench

// Bring in the complete web workbench with all service registrations.
import '../workbench/workbench.web.main.js';

//#endregion


//#region --- mobile common

import './mobile.common.main.js';

//#endregion


//#region --- mobile web services

import '../workbench/services/integrity/browser/integrityService.js';
import '../workbench/services/textMate/browser/textMateTokenizationFeature.contribution.js';
import '../workbench/services/search/browser/searchService.js';
import '../workbench/services/textfile/browser/browserTextFileService.js';
import '../workbench/services/keybinding/browser/keyboardLayoutService.js';
import '../workbench/services/extensions/browser/extensionService.js';
import '../workbench/services/extensionManagement/browser/webExtensionsScannerService.js';
import '../workbench/services/extensionManagement/common/extensionManagementServerService.js';
import '../workbench/services/extensionManagement/browser/extensionGalleryManifestService.js';
import '../workbench/services/telemetry/browser/telemetryService.js';
import '../workbench/services/configurationResolver/browser/configurationResolverService.js';
import '../workbench/services/url/browser/urlService.js';
import '../workbench/services/update/browser/updateService.js';
import '../workbench/services/workspaces/browser/workspacesService.js';
import '../workbench/services/workingCopy/browser/workingCopyBackupService.js';
import '../workbench/services/path/browser/pathService.js';
import '../workbench/services/themes/browser/browserHostColorSchemeService.js';
import '../workbench/services/encryption/browser/encryptionService.js';
import '../workbench/services/secrets/browser/secretStorageService.js';
import '../workbench/services/localization/browser/localeService.js';
import '../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import '../workbench/services/host/browser/browserHostService.js';
import '../workbench/services/lifecycle/browser/lifecycleService.js';
import '../workbench/services/clipboard/browser/clipboardService.js';
import '../workbench/services/dialogs/browser/fileDialogService.js';
import '../workbench/services/userDataSync/browser/userDataSyncEnablementService.js';
import '../workbench/services/timer/browser/timerService.js';

//#endregion
