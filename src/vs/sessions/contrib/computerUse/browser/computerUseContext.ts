/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const ComputerUsePlayerContext = new RawContextKey<boolean>('computerUsePlayer', false);
export const ComputerUseFocusedContext = new RawContextKey<boolean>('computerUseFocused', false);
export const ComputerUsePausedContext = new RawContextKey<boolean>('computerUseViewingPaused', false);
export const ComputerUseFullScreenContext = new RawContextKey<boolean>('computerUseFullScreen', false);
export const ComputerUseFullScreenSupportedContext = new RawContextKey<boolean>('computerUseFullScreenSupported', false);
export const ComputerUseFollowActionContext = new RawContextKey<boolean>('computerUseFollowAction', false);
export const ComputerUseHasFrameContext = new RawContextKey<boolean>('computerUseHasFrame', false);
export const ComputerUseAnnotatingContext = new RawContextKey<boolean>('computerUseAnnotating', false);
export const ComputerUseAnnotationStyleContext = new RawContextKey<string>('computerUseAnnotationStyle', 'yellow');
export const ComputerUseAnnotationWidthContext = new RawContextKey<string>('computerUseAnnotationWidth', 'thin');
export const ComputerUseHasAnnotationsContext = new RawContextKey<boolean>('computerUseHasAnnotations', false);
export const ComputerUseAnnotationAttachingContext = new RawContextKey<boolean>('computerUseAnnotationAttaching', false);

export const COMPUTER_USE_ACCESSIBILITY_VERBOSITY = 'accessibility.verbosity.computerUse';
