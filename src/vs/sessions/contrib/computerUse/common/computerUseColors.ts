/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';

export const computerUseAnnotationYellow = registerColor(
	'computerUse.annotationYellow',
	{ dark: '#FFD60A', light: '#FFCC00', hcDark: '#FFFF00', hcLight: '#8A6800' },
	localize('computerUse.annotationYellowColor', "Color of the yellow Computer Use annotation highlighter."),
);

export const computerUseAnnotationPink = registerColor(
	'computerUse.annotationPink',
	{ dark: '#FF6B8A', light: '#C42B55', hcDark: '#FF8FA6', hcLight: '#A31545' },
	localize('computerUse.annotationPinkColor', "Color of the pink Computer Use annotation highlighter."),
);

export const computerUseAnnotationBlue = registerColor(
	'computerUse.annotationBlue',
	{ dark: '#4DA6FF', light: '#0066CC', hcDark: '#75BEFF', hcLight: '#005A9E' },
	localize('computerUse.annotationBlueColor', "Color of the blue Computer Use annotation highlighter."),
);
