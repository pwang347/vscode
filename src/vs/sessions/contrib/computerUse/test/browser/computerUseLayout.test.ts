/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IView, LayoutPriority, Orientation, SplitView } from '../../../../../base/browser/ui/splitview/splitview.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IPartVisibilityChangeEvent, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { ComputerUseLayoutController } from '../../browser/computerUseLayout.js';
import { TestVideoSource } from './computerUseTestUtils.js';

suite('ComputerUseLayoutController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(chatMinimum = 300) {
		const container = append(mainWindow.document.body, $('.computer-use-layout-test'));
		store.add(toDisposable(() => container.remove()));
		const split = store.add(new SplitView(container, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));
		const view = (minimumSize: number, priority: LayoutPriority): IView => ({
			element: $('div'),
			minimumSize,
			maximumSize: Infinity,
			priority,
			onDidChange: Event.None,
			layout: () => { },
		});
		split.addView(view(170, LayoutPriority.Normal), 200);
		split.addView(view(chatMinimum, LayoutPriority.High), 500);
		split.addView(view(300, LayoutPriority.Normal), 500);
		split.layout(1200);
		const indices = new Map([[Parts.SIDEBAR_PART, 0], [Parts.SESSIONS_PART, 1], [Parts.EDITOR_PART, 2]]);
		const changed = store.add(new Emitter<void>());
		const visibility = store.add(new Emitter<IPartVisibilityChangeEvent>());
		const instantiationService = store.add(new TestInstantiationService());
		let selected: EditorInput | undefined;
		let activeElsewhere: EditorInput | undefined;
		let compactRequests = 0;
		let activationExpansionSuppressions = 0;
		const mainGroup = upcastPartial<IEditorGroup>({ get activeEditor() { return selected ?? null; } });
		instantiationService.stub(IEditorGroupsService, {
			mainPart: upcastPartial<IEditorGroupsService['mainPart']>({ activeGroup: mainGroup }),
		});
		instantiationService.stub(IEditorService, {
			onDidActiveEditorChange: changed.event,
			get activeEditor() { return activeElsewhere ?? selected; },
		});
		const setVisible = (part: Parts, visible: boolean) => {
			split.setViewVisible(indices.get(part)!, visible);
			visibility.fire({ partId: part, visible });
		};
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: visibility.event,
			isVisible: part => split.isViewVisible(indices.get(part)!),
			setPartHidden: (hidden, part) => setVisible(part, !hidden),
			suppressSessionsPartActivationResize: () => {
				activationExpansionSuppressions++;
				return toDisposable(() => activationExpansionSuppressions--);
			},
			getSize: part => ({ width: split.getViewSize(indices.get(part)!), height: 500 }),
			setSize: (part, size) => {
				compactRequests++;
				split.resizeView(indices.get(part)!, size.width);
			},
		});
		const controller = store.add(instantiationService.createInstance(ComputerUseLayoutController));
		const input = store.add(new ComputerUseEditorInput(
			{ providerId: 'host', sessionId: 'session', chatResource: URI.parse('test-chat://host/main') },
			constObservable('Session'), constObservable('Chat'), new TestVideoSource(),
		));
		return {
			controller, input, split, setVisible,
			select(editor: EditorInput | undefined) { selected = editor; changed.fire(); },
			selectAuxiliary(editor: EditorInput) { activeElsewhere = editor; changed.fire(); },
			get activationExpansionSuppressed() { return activationExpansionSuppressions > 0; },
			snapshot: () => ({ sidebar: split.isViewVisible(0), chatVisible: split.isViewVisible(1), chatWidth: split.getViewSize(1), editor: split.isViewVisible(2), compactRequests }),
		};
	}

	test('selecting Computer Use collapses the sidebar and uses the real chat minimum', () => {
		const context = setup(340);
		context.select(context.input);
		assert.deepStrictEqual(context.snapshot(), { sidebar: false, chatVisible: true, chatWidth: 340, editor: true, compactRequests: 1 });
	});

	test('keeps the compact composition on exit and respects manual changes until reselected', () => {
		const context = setup();
		context.select(context.input);
		context.select(undefined);
		const afterExit = context.snapshot();
		context.select(context.input);
		context.setVisible(Parts.SIDEBAR_PART, true);
		context.split.resizeView(1, 450);
		const manual = context.snapshot();
		context.select(undefined);
		context.select(context.input);
		assert.deepStrictEqual({ afterExit, manual, reselected: context.snapshot() }, {
			afterExit: { sidebar: false, chatVisible: true, chatWidth: 300, editor: true, compactRequests: 1 },
			manual: { sidebar: true, chatVisible: true, chatWidth: 450, editor: true, compactRequests: 2 },
			reselected: { sidebar: false, chatVisible: true, chatWidth: 300, editor: true, compactRequests: 3 },
		});
	});

	test('waits until the editor area is visible before compacting', () => {
		const context = setup();
		context.setVisible(Parts.EDITOR_PART, false);
		context.select(context.input);
		const before = context.snapshot().compactRequests;
		context.setVisible(Parts.EDITOR_PART, true);
		assert.deepStrictEqual({ before, after: context.snapshot() }, {
			before: 0,
			after: { sidebar: false, chatVisible: true, chatWidth: 300, editor: true, compactRequests: 1 },
		});
	});

	test('an auxiliary-window viewer does not resize the main window', () => {
		const context = setup();
		const before = context.snapshot();
		context.selectAuxiliary(context.input);
		assert.deepStrictEqual(context.snapshot(), before);
	});

	test('suppresses chat focus expansion only while Computer Use is active', () => {
		const context = setup();
		context.select(context.input);
		assert.strictEqual(context.activationExpansionSuppressed, true);
		context.select(undefined);
		assert.strictEqual(context.activationExpansionSuppressed, false);
	});

	test('disposing the contribution removes the automatic layout behavior', () => {
		const context = setup();
		context.controller.dispose();
		const before = context.snapshot();
		context.select(context.input);
		assert.deepStrictEqual(context.snapshot(), before);
	});
});
