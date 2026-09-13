/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './computerUseActions.js';
import { localize } from '../../../../nls.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { ComputerUseEditor } from './computerUseEditor.js';
import { ComputerUseEditorInput } from './computerUseEditorInput.js';
import { ComputerUseAccessibilityHelp, ComputerUseAccessibleView } from './computerUseAccessibility.js';
import { COMPUTER_USE_ACCESSIBILITY_VERBOSITY } from './computerUseContext.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ComputerUseEditor, ComputerUseEditor.ID, localize('computerUse.editor', "Computer Use")),
	[new SyncDescriptor(ComputerUseEditorInput)],
);

AccessibleViewRegistry.register(new ComputerUseAccessibilityHelp());
AccessibleViewRegistry.register(new ComputerUseAccessibleView());

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'accessibility',
	properties: {
		[COMPUTER_USE_ACCESSIBILITY_VERBOSITY]: {
			type: 'boolean',
			default: true,
			tags: ['accessibility'],
			description: localize('computerUse.verbosity', "Provide information about how to access Computer Use accessibility help when the live video viewer is focused."),
		},
	},
});
