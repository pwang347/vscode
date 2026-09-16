/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import '../../../../../base/browser/ui/codicons/codiconStyles.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { IChatWidget, IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatAttachmentModel } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { IChatRequestVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IComputerUseRecordingPreview, IComputerUseVideoBatch } from '../../../../services/sessions/common/computerUse.js';
import '../../browser/computerUseActions.js';
import { ComputerUseEditorInput } from '../../browser/computerUseEditorInput.js';
import { ComputerUsePlayer } from '../../browser/computerUsePlayer.js';
import { testVideoConfig, TestVideoDecoderFactory, TestVideoScheduler, TestVideoSource, videoBatch, videoFrame } from './computerUseTestUtils.js';

suite('ComputerUsePlayer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(kind?: 'recording') {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IContextKeyService, store.add(instantiationService.createInstance(ContextKeyService)));
		instantiationService.stub(IMenuService, store.add(instantiationService.createInstance(MenuService)));
		instantiationService.stub(ICommandService, store.add(instantiationService.createInstance(CommandService)));
		const chatResource = URI.parse('test-chat://host-a/chat-a');
		const attachments: IChatRequestVariableEntry[] = [];
		let chatInputFocusCount = 0;
		const widget = upcastPartial<IChatWidget>({
			attachmentModel: upcastPartial<ChatAttachmentModel>({
				addContext: (...entries: IChatRequestVariableEntry[]) => attachments.push(...entries),
			}),
			focusInput: () => chatInputFocusCount++,
		});
		instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
			getWidgetBySessionResource: resource => resource.toString() === chatResource.toString() ? widget : undefined,
		}));
		const reducedMotionChanged = store.add(new Emitter<void>());
		const accessibility = new class extends TestAccessibilityService {
			reducedMotion = true;
			override onDidChangeReducedMotion = reducedMotionChanged.event;
			override isMotionReduced(): boolean { return this.reducedMotion; }
		};
		instantiationService.stub(IAccessibilityService, accessibility);
		const container = append(mainWindow.document.body, $('.computer-use-test-container'));
		store.add(toDisposable(() => container.remove()));
		const source = new TestVideoSource('Remote Mac', kind);
		const activity = observableValue('activity', { message: 'Checking the checkout form', active: true });
		const input = store.add(new ComputerUseEditorInput(
			{ providerId: 'host-a', sessionId: 'session-a', chatResource },
			constObservable('Session'), constObservable('Chat'), source, activity, chatResource,
		));
		const factory = new TestVideoDecoderFactory();
		factory.paint = context => {
			for (const [x, y, color] of [[0, 0, 'red'], [16, 0, 'lime'], [0, 12, 'blue'], [16, 12, 'yellow']] as const) {
				context.fillStyle = color;
				context.fillRect(x, y, 16, 12);
			}
		};
		const scheduler = new TestVideoScheduler();
		const player = store.add(instantiationService.createInstance(ComputerUsePlayer, container, input, { decoderFactory: factory, scheduler }));
		const canvas = player.domNode.querySelector('canvas')!;
		const pixel = () => Array.from(canvas.getContext('2d')!.getImageData(4, 4, 1, 1).data);
		return { player, source, scheduler, canvas, pixel, instantiationService, activity, factory, accessibility, reducedMotionChanged, attachments, get chatInputFocusCount() { return chatInputFocusCount; } };
	}

	test('completed playback keeps the last pixels without the waiting overlay', async () => {
		const { player, source, scheduler, pixel } = setup();
		source.results.push(videoBatch([videoFrame(1, true)]), { version: 1, status: 'idle' });
		player.setVisible(true);
		await scheduler.advance(300);
		assert.deepStrictEqual({
			pixel: pixel(),
			retained: player.domNode.classList.contains('is-last-frame'),
			waiting: player.getAccessibleContent().includes('Waiting for the agent to use an application'),
			labelledNotLive: player.getAccessibleContent().includes('not live'),
		}, { pixel: [255, 0, 0, 255], retained: true, waiting: false, labelledNotLive: true });
	});

	test('matches the rounded Agents editor shell at the lower focus boundary', () => {
		const { player } = setup();
		const host = player.domNode.parentElement!;
		host.classList.add('agent-sessions-workbench');
		host.style.setProperty('--vscode-cornerRadius-large', '8px');
		host.style.setProperty('--vscode-strokeThickness', '1px');
		player.focus();
		const style = mainWindow.getComputedStyle(player.domNode);

		assert.deepStrictEqual({
			borderWidth: style.borderBottomWidth,
			bottomLeftRadius: style.borderBottomLeftRadius,
			bottomRightRadius: style.borderBottomRightRadius,
		}, {
			borderWidth: '0px',
			bottomLeftRadius: '7px',
			bottomRightRadius: '7px',
		});
	});

	test('clicking video toggles viewing and restarts an ended recording', async () => {
		const live = setup();
		live.source.results.push(videoBatch([videoFrame(1, true)]));
		live.player.setVisible(true);
		await live.scheduler.advance(300);
		live.canvas.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true }));
		const paused = {
			manuallyPaused: live.player.video.paused.get(),
			status: live.player.video.state.get().status,
			feedbackVisible: live.player.domNode.querySelector('.computer-use-playback-feedback')?.classList.contains('is-visible'),
			feedbackIcon: live.player.domNode.querySelector('.computer-use-playback-feedback-icon')?.classList.contains('codicon-debug-pause'),
		};
		live.canvas.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true }));
		const resumed = {
			manuallyPaused: live.player.video.paused.get(),
			status: live.player.video.state.get().status,
			phase: live.player.video.state.get().phase,
			feedbackVisible: live.player.domNode.querySelector('.computer-use-playback-feedback')?.classList.contains('is-visible'),
			feedbackIcon: live.player.domNode.querySelector('.computer-use-playback-feedback-icon')?.classList.contains('codicon-play'),
			visualStatus: live.player.domNode.querySelector('.computer-use-status-text')?.textContent,
			busy: live.player.domNode.querySelector('.computer-use-stage')?.getAttribute('aria-busy'),
			buffering: live.player.domNode.classList.contains('is-buffering'),
		};
		await live.scheduler.advance(700);
		const feedbackHidden = !live.player.domNode.querySelector('.computer-use-playback-feedback')?.classList.contains('is-visible');

		const recording = setup('recording');
		recording.source.results.push(videoBatch([videoFrame(1, true)]), { version: 1, status: 'idle' });
		recording.player.setVisible(true);
		await recording.scheduler.advance(300);
		const ended = recording.player.video.state.get().retainedFrame;
		recording.canvas.dispatchEvent(new mainWindow.MouseEvent('click', { bubbles: true }));

		assert.deepStrictEqual({
			paused,
			resumed,
			feedbackHidden,
			recording: {
				ended,
				seekCalls: recording.source.seekCalls,
				status: recording.player.video.state.get().status,
			},
		}, {
			paused: { manuallyPaused: true, status: 'paused', feedbackVisible: true, feedbackIcon: true },
			resumed: {
				manuallyPaused: false,
				status: 'starting',
				phase: 'resuming',
				feedbackVisible: true,
				feedbackIcon: true,
				visualStatus: 'Resuming',
				busy: 'false',
				buffering: false,
			},
			feedbackHidden: true,
			recording: {
				ended: true,
				seekCalls: [0],
				status: 'starting',
			},
		});
	});

	test('click feedback uses a prominent high-contrast display treatment', async () => {
		const { player, source, scheduler, canvas } = setup();
		player.domNode.style.setProperty('--vscode-spacing-size40', '4px');
		player.domNode.style.setProperty('--vscode-spacing-size160', '16px');
		player.domNode.style.setProperty('--vscode-spacing-size320', '32px');
		player.domNode.style.setProperty('--vscode-codiconFontSize', '16px');
		player.domNode.style.setProperty('--vscode-cornerRadius-circle', '9999px');
		player.domNode.style.setProperty('--vscode-strokeThickness', '1px');
		player.domNode.style.setProperty('--vscode-editorWidget-background', 'rgb(10, 10, 10)');
		player.domNode.style.setProperty('--vscode-editor-background', 'rgb(0, 0, 0)');
		player.domNode.style.setProperty('--vscode-foreground', 'rgb(250, 250, 250)');
		player.domNode.style.setProperty('--vscode-icon-foreground', 'rgb(100, 100, 100)');
		player.domNode.style.setProperty('--vscode-contrastActiveBorder', 'rgb(255, 255, 0)');
		player.domNode.style.setProperty('--vscode-widget-shadow', 'rgb(0, 0, 0)');
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		canvas.click();
		const feedback = player.domNode.querySelector<HTMLElement>('.computer-use-playback-feedback')!;
		const icon = player.domNode.querySelector<HTMLElement>('.computer-use-playback-feedback-icon')!;
		const feedbackStyle = mainWindow.getComputedStyle(feedback);
		const iconStyle = mainWindow.getComputedStyle(icon);
		const iconBounds = icon.getBoundingClientRect();
		const normal = {
			surface: {
				width: feedbackStyle.width,
				height: feedbackStyle.height,
				opacity: feedbackStyle.opacity,
				background: feedbackStyle.backgroundColor,
				border: feedbackStyle.borderColor,
				shadow: feedbackStyle.boxShadow,
			},
			icon: {
				fontSize: iconStyle.fontSize,
				width: iconBounds.width,
				height: iconBounds.height,
				color: iconStyle.color,
			},
		};
		player.domNode.parentElement!.classList.add('hc-black');
		const highContrastStyle = mainWindow.getComputedStyle(feedback);

		assert.deepStrictEqual({
			normal,
			highContrast: {
				opacity: highContrastStyle.opacity,
				background: highContrastStyle.backgroundColor,
				border: highContrastStyle.borderColor,
				shadow: highContrastStyle.boxShadow,
			},
		}, {
			normal: {
				surface: {
					width: '64px',
					height: '64px',
					opacity: '1',
					background: 'rgb(10, 10, 10)',
					border: 'rgb(250, 250, 250)',
					shadow: 'rgb(0, 0, 0) 0px 4px 16px 0px',
				},
				icon: {
					fontSize: '16px',
					width: 32,
					height: 32,
					color: 'rgb(250, 250, 250)',
				},
			},
			highContrast: {
				opacity: '1',
				background: 'rgb(0, 0, 0)',
				border: 'rgb(255, 255, 0)',
				shadow: 'none',
			},
		});
	});

	test('annotates a frozen frame and attaches it to the exact chat', async () => {
		const context = setup();
		context.source.results.push(videoBatch([videoFrame(1, true)]));
		context.player.setVisible(true);
		await context.scheduler.advance(300);
		context.player.startAnnotation();
		const annotationCanvas = context.player.annotationCanvas.canvas;
		const annotationContext = annotationCanvas.getContext('2d')!;
		const baseline = annotationContext.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
		const changedPixels = () => {
			const current = annotationContext.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
			let changed = 0;
			for (let index = 0; index < current.data.length; index += 4) {
				if (current.data[index] !== baseline.data[index]
					|| current.data[index + 1] !== baseline.data[index + 1]
					|| current.data[index + 2] !== baseline.data[index + 2]
					|| current.data[index + 3] !== baseline.data[index + 3]) {
					changed++;
				}
			}
			return changed;
		};
		const drawKeyboardDot = () => {
			annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
			annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
		};
		const defaultWidth = context.player.annotationCanvas.width.get();
		drawKeyboardDot();
		const thinPixels = changedPixels();
		const beforeReset = context.player.annotationCanvas.annotationCount.get();
		context.player.setAnnotationWidth('thick');
		const countAfterWidthChange = context.player.annotationCanvas.annotationCount.get();
		context.player.resetAnnotations();
		const afterReset = context.player.annotationCanvas.annotationCount.get();
		context.player.setAnnotationStyle('pink');
		drawKeyboardDot();
		const thickPixels = changedPixels();
		const annotating = context.player.domNode.classList.contains('is-annotating');
		const selectedStyle = context.player.annotationCanvas.style.get();
		const selectedWidth = context.player.annotationCanvas.width.get();
		const toolbarLabels = [...context.player.domNode.querySelectorAll<HTMLElement>('.computer-use-toolbar .action-label')]
			.map(element => element.getAttribute('aria-label'))
			.filter((label): label is string => !!label);
		const selectedToolbarStyles = [...context.player.domNode.querySelectorAll<HTMLElement>('.computer-use-toolbar .action-label.checked')]
			.map(element => element.getAttribute('aria-label'));
		const swatchClasses = toolbarLabels.slice(0, 3).map(label =>
			context.player.domNode.querySelector<HTMLElement>(`.computer-use-toolbar .action-label[aria-label="${label}"]`)?.className);
		const centeredAnnotationControls = [...context.player.domNode.querySelectorAll<HTMLElement>(`.computer-use-toolbar .action-label:is(
			.codicon-computer-use-annotation-yellow,
			.codicon-computer-use-annotation-pink,
			.codicon-computer-use-annotation-blue,
			.codicon-computer-use-annotation-width-thin,
			.codicon-computer-use-annotation-width-medium,
			.codicon-computer-use-annotation-width-thick
		)`)]
			.every(element => mainWindow.getComputedStyle(element).justifyContent === 'center');
		const accessibleSelection = context.player.getAccessibleContent().includes('Selected color: Pink. Selected width: Thick.');
		await context.player.attachAnnotation();
		const attachment = context.attachments[0];
		assert.ok(attachment);
		const frozenPixel = Array.from(annotationCanvas.getContext('2d')!.getImageData(4, 4, 1, 1).data);
		annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape' }));

		assert.deepStrictEqual({
			frozen: {
				active: annotating,
				pixel: frozenPixel,
				beforeReset,
				countAfterWidthChange,
				afterReset,
				defaultWidth,
				selectedStyle,
				selectedWidth,
				thickIsWider: thickPixels > thinPixels,
				accessibleSelection,
				centeredAnnotationControls,
				toolbarLabels,
				selectedToolbarStyles,
				swatchClasses,
			},
			attachment: {
				kind: attachment.kind,
				name: attachment.name,
				mimeType: attachment.kind === 'image' ? attachment.mimeType : undefined,
				png: attachment.value instanceof Uint8Array ? [...attachment.value.slice(0, 8)] : [],
				meta: attachment._meta,
			},
			chatInputFocusCount: context.chatInputFocusCount,
			returned: {
				active: context.player.annotationCanvas.isActive,
				paused: context.player.video.paused.get(),
				status: context.player.video.state.get().status,
			},
		}, {
			frozen: {
				active: true,
				pixel: [255, 0, 0, 255],
				beforeReset: 1,
				countAfterWidthChange: 1,
				afterReset: 0,
				defaultWidth: 'thin',
				selectedStyle: 'pink',
				selectedWidth: 'thick',
				thickIsWider: true,
				accessibleSelection: true,
				centeredAnnotationControls: true,
				toolbarLabels: [
					'Yellow Highlighter',
					'Pink Highlighter',
					'Blue Highlighter',
					'Thin Highlighter',
					'Medium Highlighter',
					'Thick Highlighter',
					'Reset Annotations',
					'Attach to Chat',
					'Return to Video',
				],
				selectedToolbarStyles: ['Pink Highlighter', 'Thick Highlighter'],
				swatchClasses: [
					'action-label codicon codicon-computer-use-annotation-yellow',
					'action-label checked codicon codicon-computer-use-annotation-pink',
					'action-label codicon codicon-computer-use-annotation-blue',
				],
			},
			attachment: {
				kind: 'image',
				name: 'Annotated Computer Use Frame',
				mimeType: 'image/png',
				png: [137, 80, 78, 71, 13, 10, 26, 10],
				meta: {
					'vscode.computerUse.annotation': true,
					'vscode.computerUse.source': 'live',
					'vscode.computerUse.application': 'Agent Browser',
					'vscode.computerUse.windowTitle': 'Example window',
					'vscode.computerUse.followAction': false,
				},
			},
			chatInputFocusCount: 1,
			returned: {
				active: false,
				paused: false,
				status: 'starting',
			},
		});
	});

	test('highlighter strokes remain smooth and uniformly translucent across sampled points', async () => {
		const context = setup();
		context.source.results.push(videoBatch([videoFrame(1, true)]));
		context.player.setVisible(true);
		await context.scheduler.advance(300);
		context.player.startAnnotation();
		const canvas = context.player.annotationCanvas.canvas;
		const canvasContext = canvas.getContext('2d')!;
		canvasContext.fillStyle = 'black';
		canvasContext.fillRect(0, 0, canvas.width, canvas.height);
		canvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
		for (let index = 0; index < 3; index++) {
			canvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowRight' }));
		}
		canvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
		const pixels = [18, 21, 23, 26, 28].map(x =>
			Array.from(canvasContext.getImageData(x, 12, 1, 1).data));

		assert.deepStrictEqual({
			annotationCount: context.player.annotationCanvas.annotationCount.get(),
			painted: pixels.every(pixel => pixel.some((channel, index) => index < 3 && channel > 0)),
			uniform: new Set(pixels.map(pixel => pixel.join(','))).size === 1,
		}, {
			annotationCount: 1,
			painted: true,
			uniform: true,
		});
	});

	test('attaches the frozen frame without requiring annotations', async () => {
		const context = setup();
		context.source.results.push(videoBatch([videoFrame(1, true)]));
		context.player.setVisible(true);
		await context.scheduler.advance(300);
		context.player.startAnnotation();

		const attachAction = context.player.domNode.querySelector<HTMLElement>('.computer-use-toolbar .action-label[aria-label="Attach to Chat"]');
		await context.player.attachAnnotation();
		const attachment = context.attachments[0];

		assert.deepStrictEqual({
			annotationCount: context.player.annotationCanvas.annotationCount.get(),
			attachEnabled: attachAction?.getAttribute('aria-disabled') !== 'true',
			attachment: attachment ? {
				kind: attachment.kind,
				name: attachment.name,
				mimeType: attachment.kind === 'image' ? attachment.mimeType : undefined,
				annotation: attachment._meta?.['vscode.computerUse.annotation'],
			} : undefined,
			chatInputFocusCount: context.chatInputFocusCount,
		}, {
			annotationCount: 0,
			attachEnabled: true,
			attachment: {
				kind: 'image',
				name: 'Computer Use Frame',
				mimeType: 'image/png',
				annotation: false,
			},
			chatInputFocusCount: 1,
		});
	});

	test('annotated recording frame carries its playback position', async () => {
		const context = setup('recording');
		context.source.results.push(videoBatch([videoFrame(1, true)]));
		context.player.setVisible(true);
		await context.scheduler.advance(300);
		context.source.recordingPositionMs.set(2250, undefined);
		context.player.startAnnotation();
		const annotationCanvas = context.player.annotationCanvas.canvas;
		annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
		annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowDown' }));
		annotationCanvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: ' ' }));
		await context.player.attachAnnotation();

		assert.deepStrictEqual(context.attachments[0]?._meta, {
			'vscode.computerUse.annotation': true,
			'vscode.computerUse.source': 'recording',
			'vscode.computerUse.application': 'Agent Browser',
			'vscode.computerUse.windowTitle': 'Example window',
			'vscode.computerUse.positionMs': 2250,
			'vscode.computerUse.followAction': false,
		});
	});

	test('returning from annotation preserves an existing pause', async () => {
		const context = setup('recording');
		context.source.results.push(videoBatch([videoFrame(1, true)]));
		context.player.setVisible(true);
		await context.scheduler.advance(300);
		context.player.pauseViewing();
		context.player.startAnnotation();
		context.player.annotationCanvas.canvas.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape' }));
		await context.scheduler.advance(3000);

		assert.deepStrictEqual({
			annotating: context.player.annotationCanvas.isActive,
			paused: context.player.video.paused.get(),
			status: context.player.video.state.get().status,
			controlsHidden: !context.player.domNode.classList.contains('is-controls-visible'),
		}, {
			annotating: false,
			paused: true,
			status: 'paused',
			controlsHidden: true,
		});
	});

	test('live and stopped playback expose distinct visual state classes', async () => {
		const { player, source, scheduler } = setup();
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const live = {
			live: player.domNode.classList.contains('is-live'),
			stopped: player.domNode.classList.contains('is-stopped'),
			animated: player.domNode.classList.contains('is-live-indicator-animated'),
			stop: player.domNode.querySelector('.computer-use-stop')?.textContent,
		};
		await player.stopAgent();
		assert.deepStrictEqual({
			live,
			stopped: {
				live: player.domNode.classList.contains('is-live'),
				stopped: player.domNode.classList.contains('is-stopped'),
				animated: player.domNode.classList.contains('is-live-indicator-animated'),
				stop: player.domNode.querySelector('.computer-use-stop .monaco-button')?.getAttribute('aria-disabled'),
			},
		}, {
			live: { live: true, stopped: false, animated: false, stop: 'Stop Agent' },
			stopped: { live: false, stopped: true, animated: false, stop: 'true' },
		});
	});

	test('live border remains stable while a rendered frame is buffering', async () => {
		const { player, source, scheduler } = setup();
		const pending = new DeferredPromise<IComputerUseVideoBatch>();
		source.results.push(videoBatch([videoFrame(1, true)]), pending);
		player.setVisible(true);
		await scheduler.advance(300);
		const buffering = {
			status: player.video.state.get().status,
			phase: player.video.state.get().phase,
			hasFrame: player.domNode.classList.contains('has-frame'),
			liveBorder: player.domNode.classList.contains('is-live'),
		};
		await pending.complete(videoBatch([]));
		await scheduler.advance(0);

		assert.deepStrictEqual({
			buffering,
			recovered: {
				status: player.video.state.get().status,
				liveBorder: player.domNode.classList.contains('is-live'),
			},
		}, {
			buffering: {
				status: 'starting',
				phase: 'buffering',
				hasFrame: true,
				liveBorder: true,
			},
			recovered: {
				status: 'live',
				liveBorder: true,
			},
		});
	});

	test('recorded playback is labelled separately and never appears live', async () => {
		const { player, source, scheduler } = setup('recording');
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const timeline = player.domNode.querySelector<HTMLInputElement>('.computer-use-timeline-input');
		assert.ok(timeline);
		const playingStatus = player.domNode.querySelector('.computer-use-status-text')?.textContent;
		timeline.value = '2000';
		timeline.dispatchEvent(new mainWindow.Event('change'));
		assert.deepStrictEqual({
			recording: player.domNode.classList.contains('is-recording'),
			live: player.domNode.classList.contains('is-live'),
			status: playingStatus,
			stop: player.domNode.querySelector('.computer-use-stop'),
			timeline: {
				max: timeline.max,
				label: player.domNode.querySelector('.computer-use-timeline-label')?.textContent,
				seekCalls: source.seekCalls,
			},
		}, {
			recording: true,
			live: false,
			status: 'Playing',
			stop: null,
			timeline: {
				max: '4000',
				label: '0:02 / 0:04',
				seekCalls: [2000],
			},
		});
		assert.ok(player.getAccessibleContent().includes('recorded video'));
		assert.ok(!player.getAccessibleContent().includes('This is live video'));
	});

	test('restarting recorded playback always seeks to the beginning', async () => {
		const { player, source } = setup('recording');
		player.video.seek(2000);
		player.restartRecordingPlayback();

		assert.deepStrictEqual({
			seekCalls: source.seekCalls,
			positionMs: source.recordingPositionMs.get(),
		}, {
			seekCalls: [2000, 0],
			positionMs: 0,
		});
	});

	test('recording timeline distinguishes elapsed footage', () => {
		const { player, source } = setup('recording');
		player.domNode.style.setProperty('--vscode-descriptionForeground', 'rgb(255, 255, 255)');
		player.domNode.style.setProperty('--vscode-editor-background', 'rgb(0, 0, 0)');
		player.domNode.style.setProperty('--vscode-foreground', 'rgb(255, 255, 255)');
		source.recordingPositionMs.set(2000, undefined);
		const progress = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-progress')!;
		const rail = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-rail')!;
		const thumb = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-thumb')!;

		assert.deepStrictEqual({
			progressWidth: progress.style.width,
			progressColor: mainWindow.getComputedStyle(progress).backgroundColor,
			railColor: mainWindow.getComputedStyle(rail).backgroundColor,
			thumbPosition: thumb.style.left,
			thumbColor: mainWindow.getComputedStyle(thumb).backgroundColor,
		}, {
			progressWidth: '50%',
			progressColor: 'color(srgb 0.55 0.55 0.55)',
			railColor: 'color(srgb 1 1 1 / 0.2)',
			thumbPosition: '50%',
			thumbColor: 'color(srgb 0.55 0.55 0.55)',
		});
	});

	test('recording timeline previews prospective progress without moving playback', () => {
		const { player, source } = setup('recording');
		player.domNode.style.width = '800px';
		source.recordingPositionMs.set(1000, undefined);
		const track = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-track')!;
		const progress = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-progress')!;
		const previewProgress = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview-progress')!;
		const thumb = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-thumb')!;
		const trackBounds = track.getBoundingClientRect();

		track.dispatchEvent(new mainWindow.PointerEvent('pointermove', {
			bubbles: true,
			clientX: trackBounds.left + trackBounds.width * 0.75,
		}));
		const hovered = {
			progressWidth: progress.style.width,
			previewProgressWidth: previewProgress.style.width,
			thumbPosition: thumb.style.left,
		};
		track.dispatchEvent(new mainWindow.PointerEvent('pointerleave', { bubbles: true }));

		assert.deepStrictEqual({
			hovered,
			previewProgressAfterLeave: previewProgress.style.width,
		}, {
			hovered: {
				progressWidth: '25%',
				previewProgressWidth: '75%',
				thumbPosition: '25%',
			},
			previewProgressAfterLeave: '0%',
		});
	});

	test('recording controls overlay the video and hide without pointer intent', async () => {
		const { player, source, scheduler } = setup('recording');
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const stage = player.domNode.querySelector<HTMLElement>('.computer-use-stage')!;
		const controls = player.domNode.querySelector<HTMLElement>('.computer-use-controls')!;
		const timeline = player.domNode.querySelector<HTMLElement>('.computer-use-timeline')!;
		const timelineInput = player.domNode.querySelector<HTMLInputElement>('.computer-use-timeline-input')!;

		await scheduler.advance(3000);
		const idle = {
			visibleClass: player.domNode.classList.contains('is-controls-visible'),
			opacity: mainWindow.getComputedStyle(controls).opacity,
			timelinePointerEvents: mainWindow.getComputedStyle(timeline).pointerEvents,
		};
		stage.dispatchEvent(new mainWindow.Event('pointermove'));
		const pointer = {
			visibleClass: player.domNode.classList.contains('is-controls-visible'),
			opacity: mainWindow.getComputedStyle(controls).opacity,
			timelinePointerEvents: mainWindow.getComputedStyle(timeline).pointerEvents,
		};
		stage.dispatchEvent(new mainWindow.Event('pointerleave'));
		const outside = {
			visibleClass: player.domNode.classList.contains('is-controls-visible'),
			opacity: mainWindow.getComputedStyle(controls).opacity,
			timelinePointerEvents: mainWindow.getComputedStyle(timeline).pointerEvents,
		};
		timelineInput.focus();
		const keyboardFocus = {
			opacity: mainWindow.getComputedStyle(controls).opacity,
			timelinePointerEvents: mainWindow.getComputedStyle(timeline).pointerEvents,
		};
		timelineInput.blur();
		await scheduler.advance(3000);
		const keyboardBlurOpacity = mainWindow.getComputedStyle(controls).opacity;
		stage.dispatchEvent(new mainWindow.Event('pointermove'));
		player.domNode.querySelector<HTMLCanvasElement>('.computer-use-video')!.click();
		stage.dispatchEvent(new mainWindow.Event('pointerleave'));

		assert.deepStrictEqual({
			timelineInControls: controls.contains(timeline),
			controlsInStage: stage.contains(controls),
			idle,
			pointer,
			outside,
			keyboardFocus,
			keyboardBlurOpacity,
			pausedOutsideOpacity: mainWindow.getComputedStyle(controls).opacity,
		}, {
			timelineInControls: true,
			controlsInStage: true,
			idle: {
				visibleClass: false,
				opacity: '0',
				timelinePointerEvents: 'none',
			},
			pointer: {
				visibleClass: true,
				opacity: '1',
				timelinePointerEvents: 'auto',
			},
			outside: {
				visibleClass: false,
				opacity: '0',
				timelinePointerEvents: 'none',
			},
			keyboardFocus: {
				opacity: '1',
				timelinePointerEvents: 'auto',
			},
			keyboardBlurOpacity: '0',
			pausedOutsideOpacity: '0',
		});
	});

	test('recording timeline previews frames and marks unchanged footage', async () => {
		const { player, source, scheduler } = setup('recording');
		await scheduler.advance(0);
		const timeline = player.domNode.querySelector<HTMLInputElement>('.computer-use-timeline-input')!;
		timeline.focus();
		timeline.value = '2000';
		timeline.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		await scheduler.advance(0);
		const preview = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview')!;
		const previewCanvas = player.domNode.querySelector<HTMLCanvasElement>('.computer-use-timeline-preview-canvas')!;
		const previewPixel = Array.from(previewCanvas.getContext('2d')!.getImageData(4, 4, 1, 1).data);
		const marker = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-inactive')!;

		assert.deepStrictEqual({
			previewVisible: player.domNode.querySelector('.computer-use-timeline')?.classList.contains('is-preview-visible'),
			previewFrameVisible: previewCanvas.classList.contains('is-visible'),
			previewPixel,
			previewTime: preview.querySelector('.computer-use-timeline-preview-time')?.textContent,
			unchanged: {
				badgeHidden: player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview-inactive')?.hidden,
				ariaValue: timeline.getAttribute('aria-valuetext'),
				markerLeft: marker.style.left,
				markerWidth: marker.style.width,
			},
			previewCalls: source.recordingPreviewCalls,
			accessibleTimeline: player.getAccessibleContent().includes('Dimmed timeline sections mark periods where the captured image did not change.'),
		}, {
			previewVisible: true,
			previewFrameVisible: true,
			previewPixel: [255, 0, 0, 255],
			previewTime: '0:02',
			unchanged: {
				badgeHidden: false,
				ariaValue: '0:02 of 0:04, unchanged footage',
				markerLeft: '37.5%',
				markerWidth: '25%',
			},
			previewCalls: [2000],
			accessibleTimeline: true,
		});
	});

	test('recording timeline exposes categorized action markers that seek and preview', async () => {
		const { player, source, scheduler } = setup('recording');
		await scheduler.advance(0);
		const markers = [...player.domNode.querySelectorAll<HTMLButtonElement>('.computer-use-timeline-action')];
		assert.strictEqual(markers.length, 3);
		player.domNode.style.setProperty('--vscode-spacing-size20', '2px');
		player.domNode.style.setProperty('--vscode-spacing-size60', '6px');
		markers[0].focus();
		markers[0].dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await scheduler.advance(0);
		const focused = mainWindow.document.activeElement as HTMLButtonElement;
		const markerStyles = markers.map(marker => {
			const style = mainWindow.getComputedStyle(marker, '::before');
			return { width: style.width, height: style.height, opacity: style.opacity };
		});
		const previewProgress = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview-progress')!;
		focused.dispatchEvent(new mainWindow.Event('focus'));
		const focusedPreviewProgress = previewProgress.style.width;
		focused.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		const previewProgressAfterEscape = previewProgress.style.width;
		focused.click();
		const previewAction = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview-action');

		assert.deepStrictEqual({
			classes: markers.map(marker => marker.className),
			labels: markers.map(marker => marker.getAttribute('aria-label')),
			focused: focused.getAttribute('aria-label'),
			tabStops: markers.map(marker => marker.tabIndex),
			monochrome: new Set(markers.map(marker => mainWindow.getComputedStyle(marker).color)).size === 1,
			markerStyles,
			focusedPreviewProgress,
			previewProgressAfterEscape,
			previewAction: previewAction?.textContent,
			seekCalls: source.seekCalls,
			accessible: player.getAccessibleContent().includes('Recorded actions: 3.'),
		}, {
			classes: [
				'computer-use-timeline-action computer-use-timeline-action-click',
				'computer-use-timeline-action computer-use-timeline-action-text',
				'computer-use-timeline-action computer-use-timeline-action-scroll',
			],
			labels: [
				'Click at 0:00. Activate to seek.',
				'Text entry at 0:02. Activate to seek.',
				'Scroll at 0:03. Activate to seek.',
			],
			focused: 'Text entry at 0:02. Activate to seek.',
			tabStops: [-1, 0, -1],
			monochrome: true,
			markerStyles: [
				{ width: '2px', height: '6px', opacity: '0.4' },
				{ width: '2px', height: '6px', opacity: '0.4' },
				{ width: '2px', height: '6px', opacity: '0.4' },
			],
			focusedPreviewProgress: '50%',
			previewProgressAfterEscape: '0%',
			previewAction: 'Text entry',
			seekCalls: [2000],
			accessible: true,
		});
	});

	test('recording hover preview stays anchored at the start of the timeline', async () => {
		const { player, scheduler } = setup('recording');
		player.domNode.style.width = '800px';
		await scheduler.advance(0);
		const timeline = player.domNode.querySelector<HTMLElement>('.computer-use-timeline')!;
		const track = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-track')!;
		const preview = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview')!;
		const trackBounds = track.getBoundingClientRect();
		track.dispatchEvent(new mainWindow.PointerEvent('pointermove', {
			bubbles: true,
			clientX: trackBounds.left + 1,
		}));
		const previewBounds = preview.getBoundingClientRect();
		const timelineBounds = timeline.getBoundingClientRect();

		assert.deepStrictEqual({
			previewVisible: timeline.classList.contains('is-preview-visible'),
			hasPreviewWidth: previewBounds.width > 0,
			anchoredToStart: Math.abs(previewBounds.left - timelineBounds.left) < 1,
		}, {
			previewVisible: true,
			hasPreviewWidth: true,
			anchoredToStart: true,
		});
	});

	test('recording timeline keeps the current frame visible while loading its replacement', async () => {
		const { player, source, scheduler } = setup('recording');
		await scheduler.advance(0);
		const timeline = player.domNode.querySelector<HTMLInputElement>('.computer-use-timeline-input')!;
		const previewCanvas = player.domNode.querySelector<HTMLCanvasElement>('.computer-use-timeline-preview-canvas')!;
		const previewStatus = player.domNode.querySelector<HTMLElement>('.computer-use-timeline-preview-status')!;
		timeline.focus();
		timeline.value = '1000';
		timeline.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		await scheduler.advance(0);

		const pendingPreview = new DeferredPromise<IComputerUseRecordingPreview>();
		source.recordingPreviewResults.push(pendingPreview);
		timeline.value = '3000';
		timeline.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		await scheduler.advance(0);
		const whileLoading = {
			frameVisible: previewCanvas.classList.contains('is-visible'),
			status: previewStatus.textContent,
			time: player.domNode.querySelector('.computer-use-timeline-preview-time')?.textContent,
		};
		await pendingPreview.complete({
			config: testVideoConfig,
			frames: [{ ...videoFrame(1, true), timestamp: 3_000_000 }],
		});
		await scheduler.advance(0);

		assert.deepStrictEqual({
			whileLoading,
			afterLoading: {
				frameVisible: previewCanvas.classList.contains('is-visible'),
				status: previewStatus.textContent,
			},
			previewCalls: source.recordingPreviewCalls,
		}, {
			whileLoading: {
				frameVisible: true,
				status: '',
				time: '0:03',
			},
			afterLoading: {
				frameVisible: true,
				status: '',
			},
			previewCalls: [1000, 3000],
		});
	});

	test('adaptive HUD reports playback health and hides idle live controls', async () => {
		const { player, source, scheduler } = setup();
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const stage = player.domNode.querySelector<HTMLElement>('.computer-use-stage')!;
		const status = player.domNode.querySelector<HTMLElement>('.computer-use-status')!;
		const statusText = player.domNode.querySelector<HTMLElement>('.computer-use-status-text')!;
		const controls = player.domNode.querySelector<HTMLElement>('.computer-use-controls')!;
		const live = {
			status: statusText.textContent,
			announcement: status.getAttribute('aria-label'),
			busy: stage.getAttribute('aria-busy'),
			controlsInStage: stage.contains(controls),
			controlsVisible: player.domNode.classList.contains('is-controls-visible'),
		};
		await scheduler.advance(3000);
		const controlsHiddenWhenIdle = !player.domNode.classList.contains('is-controls-visible');
		stage.dispatchEvent(new mainWindow.Event('pointermove'));
		const controlsRevealedByPointer = player.domNode.classList.contains('is-controls-visible');
		await scheduler.advance(3000);
		const controlsHiddenAgain = !player.domNode.classList.contains('is-controls-visible');
		stage.dispatchEvent(new mainWindow.Event('pointerdown'));
		const controlsRevealedByTouch = player.domNode.classList.contains('is-controls-visible');
		source.results.push(new Error('native video request timed out'));
		await scheduler.advance(50);
		assert.deepStrictEqual({
			live,
			controlsHiddenWhenIdle,
			controlsRevealedByPointer,
			controlsHiddenAgain,
			controlsRevealedByTouch,
			reconnecting: {
				status: statusText.textContent,
				announcement: status.getAttribute('aria-label'),
				busy: stage.getAttribute('aria-busy'),
				hasFrame: player.domNode.classList.contains('has-frame'),
			},
		}, {
			live: {
				status: 'Live',
				announcement: 'Live',
				busy: 'false',
				controlsInStage: true,
				controlsVisible: true,
			},
			controlsHiddenWhenIdle: true,
			controlsRevealedByPointer: true,
			controlsHiddenAgain: true,
			controlsRevealedByTouch: true,
			reconnecting: {
				status: 'Reconnecting',
				announcement: 'Video connection interrupted. Reconnecting… The last frame is not live.',
				busy: 'true',
				hasFrame: true,
			},
		});
	});

	test('same-target synchronization keeps pixels and shows Buffering in the top-left status', async () => {
		const { player, source, scheduler, pixel } = setup();
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const displayed = pixel();
		source.results.push(videoBatch([], { streamId: 'stream-b' }));
		await scheduler.advance(100);
		const statusLabel = player.domNode.querySelector<HTMLElement>('.computer-use-status')!;

		assert.deepStrictEqual({
			pixel: pixel(),
			unchanged: displayed,
			hasFrame: player.domNode.classList.contains('has-frame'),
			status: player.domNode.querySelector('.computer-use-status-text')?.textContent,
			announcement: statusLabel.getAttribute('aria-label'),
			busy: player.domNode.querySelector('.computer-use-stage')?.getAttribute('aria-busy'),
		}, {
			pixel: [255, 0, 0, 255],
			unchanged: [255, 0, 0, 255],
			hasFrame: true,
			status: 'Buffering',
			announcement: 'Synchronizing live video. Any previous frame is not live.',
			busy: 'true',
		});
	});

	test('busy indicators animate unless reduced motion is enabled', () => {
		const { player, accessibility, reducedMotionChanged } = setup('recording');
		const stateMessageIcon = player.domNode.querySelector<HTMLElement>('.computer-use-state-message-icon')!;
		const statusIcon = player.domNode.querySelector<HTMLElement>('.computer-use-status-icon')!;
		const animations = () => ({
			stateMessage: mainWindow.getComputedStyle(stateMessageIcon).animationName,
			status: mainWindow.getComputedStyle(statusIcon).animationName,
		});

		accessibility.reducedMotion = false;
		player.setVisible(true);
		const enabled = animations();
		accessibility.reducedMotion = true;
		reducedMotionChanged.fire();

		assert.deepStrictEqual({ enabled, reduced: animations() }, {
			enabled: { stateMessage: 'codicon-spin', status: 'codicon-spin' },
			reduced: { stateMessage: 'none', status: 'none' },
		});
	});

	test('waiting for an application shows an animated loading indicator', async () => {
		const { player, source, scheduler, accessibility, reducedMotionChanged } = setup();
		accessibility.reducedMotion = false;
		reducedMotionChanged.fire();
		source.results.push({ version: 1, status: 'idle' });
		player.setVisible(true);
		await scheduler.advance(300);
		const stage = player.domNode.querySelector<HTMLElement>('.computer-use-stage')!;
		const stateMessageIcon = player.domNode.querySelector<HTMLElement>('.computer-use-state-message-icon')!;

		assert.deepStrictEqual({
			message: player.domNode.querySelector('.computer-use-state-message-text')?.textContent,
			hidden: stateMessageIcon.hidden,
			display: mainWindow.getComputedStyle(stateMessageIcon).display,
			animation: mainWindow.getComputedStyle(stateMessageIcon).animationName,
			busy: stage.getAttribute('aria-busy'),
		}, {
			message: 'Waiting for the agent to use an application.',
			hidden: false,
			display: 'block',
			animation: 'codicon-spin',
			busy: 'true',
		});
	});

	test('hovering the video controls suspends their idle timeout', async () => {
		const { player, source, scheduler } = setup();
		source.results.push(videoBatch([videoFrame(1, true)]));
		player.setVisible(true);
		await scheduler.advance(300);
		const controls = player.domNode.querySelector<HTMLElement>('.computer-use-controls')!;
		controls.dispatchEvent(new mainWindow.Event('mouseenter'));
		await scheduler.advance(3000);
		const visibleWhileHovered = player.domNode.classList.contains('is-controls-visible');
		controls.dispatchEvent(new mainWindow.Event('mouseleave'));
		await scheduler.advance(3000);
		assert.deepStrictEqual({
			visibleWhileHovered,
			hiddenAfterLeaving: !player.domNode.classList.contains('is-controls-visible'),
		}, {
			visibleWhileHovered: true,
			hiddenAfterLeaving: true,
		});
	});

	test('Follow Action magnifies the agent point and turning it off restores the full paused frame', async () => {
		const { player, source, scheduler, pixel } = setup();
		source.results.push(videoBatch([{ ...videoFrame(1, true), focus: { x: 0.75, y: 0.25 } }]));
		player.setVisible(true);
		await scheduler.advance(300);
		const full = pixel();
		player.toggleFollowAction();
		await scheduler.advance(250);
		const following = pixel();
		player.pauseViewing();
		player.toggleFollowAction();
		assert.deepStrictEqual({
			full, following, restored: pixel(), stops: source.stopCalls,
			paused: player.video.paused.get(),
		}, { full: [255, 0, 0, 255], following: [0, 255, 0, 255], restored: [255, 0, 0, 255], stops: 0, paused: true });
	});

	test('keeps exact-chat activity in accessible content without permanent visual chrome', () => {
		const { player, activity } = setup();
		player.pauseViewing();
		activity.set({ message: 'Clicking Continue to verify the order', active: true }, undefined);
		assert.deepStrictEqual({
			visibleActivity: player.domNode.querySelector('.computer-use-activity'),
			accessible: player.getAccessibleContent().includes('Clicking Continue to verify the order'),
			paused: player.video.paused.get(),
		}, {
			visibleActivity: null,
			accessible: true,
			paused: true,
		});
	});

	test('shows a transient shared-thought bubble without reserving permanent chrome', async () => {
		const { player, source, scheduler, accessibility, reducedMotionChanged } = setup();
		const bubble = player.domNode.querySelector<HTMLElement>('.computer-use-thought')!;

		accessibility.reducedMotion = false;
		reducedMotionChanged.fire();
		player.setVisible(true);
		source.thought.set({ source: 'reasoning', text: 'The document is empty. I will type now.', streaming: true }, undefined);
		assert.deepStrictEqual({
			visible: bubble.classList.contains('is-visible'),
			streaming: bubble.classList.contains('is-streaming'),
			animated: player.domNode.classList.contains('is-hud-animated'),
			label: bubble.querySelector('.computer-use-thought-label')?.textContent,
			message: bubble.querySelector('.computer-use-thought-message')?.textContent,
			ariaHidden: bubble.getAttribute('aria-hidden'),
			accessible: player.getAccessibleContent().includes('Agent thinking: The document is empty. I will type now.'),
		}, {
			visible: true,
			streaming: true,
			animated: true,
			label: 'Agent thinking',
			message: 'The document is empty. I will type now.',
			ariaHidden: 'false',
			accessible: true,
		});
		accessibility.reducedMotion = true;
		reducedMotionChanged.fire();
		assert.strictEqual(player.domNode.classList.contains('is-hud-animated'), false);
		await scheduler.advance(7000);
		assert.deepStrictEqual({
			visible: bubble.classList.contains('is-visible'),
			ariaHidden: bubble.getAttribute('aria-hidden'),
		}, { visible: false, ariaHidden: 'true' });
	});

	test('the visible header keeps identity minimal while retaining the live safety action', () => {
		const { player } = setup();
		const header = player.domNode.querySelector('.computer-use-header')!;
		const accessible = player.getAccessibleContent();
		assert.deepStrictEqual({
			headerText: header.textContent,
			headerButtons: header.querySelectorAll('button, [role="button"]').length,
			sessionVisible: header.querySelector('.computer-use-session') !== null,
			targetVisible: header.querySelector('.computer-use-target') !== null,
			sessionAccessible: accessible.includes('Session and chat: Session / Chat'),
			scopeAccessible: accessible.includes('Only the agent-controlled window is shared'),
		}, {
			headerText: `${player.input.source.hostLabel}Stop Agent`,
			headerButtons: 1,
			sessionVisible: false,
			targetVisible: false,
			sessionAccessible: true,
			scopeAccessible: true,
		});
	});

	test('Follow Action clamps at the window edge and falls back for hosts without tracking data', async () => {
		const { player, source, scheduler, pixel } = setup();
		player.toggleFollowAction();
		source.results.push(videoBatch([{ ...videoFrame(1, true), focus: { x: 1, y: 1 } }]));
		player.setVisible(true);
		await scheduler.advance(300);
		const edge = pixel();
		source.results.push(videoBatch([videoFrame(2)]));
		await scheduler.advance(100);
		assert.deepStrictEqual({
			edge,
			untracked: pixel(),
			waiting: player.getAccessibleContent().includes('No agent position is available'),
			followEnabled: player.videoCanvas.followAction.get(),
		}, { edge: [255, 255, 0, 255], untracked: [255, 0, 0, 255], waiting: true, followEnabled: true });
	});

	test('panning is smooth, freezes while paused, and honors reduced motion', async () => {
		const { player, source, scheduler, pixel, factory } = setup();
		factory.paint = context => {
			for (let x = 0; x < 32; x++) {
				context.fillStyle = `rgb(${x * 8}, 0, 0)`;
				context.fillRect(x, 0, 1, 24);
			}
		};
		player.videoCanvas.setReducedMotion(false);
		source.results.push(videoBatch([{ ...videoFrame(1, true), focus: { x: 0.75, y: 0.25 } }]));
		player.setVisible(true);
		await scheduler.advance(300);
		const full = pixel()[0];
		player.toggleFollowAction();
		const immediate = pixel()[0];
		await scheduler.advance(48);
		const intermediate = pixel()[0];
		player.pauseViewing();
		await scheduler.advance(250);
		const paused = pixel()[0];
		player.videoCanvas.setReducedMotion(true);
		const reduced = pixel()[0];
		assert.deepStrictEqual({
			noInitialJump: full === immediate,
			interpolates: intermediate > full && intermediate < reduced,
			paused: paused === intermediate,
			zoomed: reduced > 128,
		}, { noInitialJump: true, interpolates: true, paused: true, zoomed: true });
	});

	test('the follow command targets its invoking player and remains keyboard accessible', async () => {
		const first = setup();
		const second = setup();
		const command = CommandsRegistry.getCommand('sessions.computerUse.followAction')!;
		const button = first.player.domNode.querySelector<HTMLElement>('[aria-label^="Follow Action"]')!;
		button.focus();
		await first.instantiationService.invokeFunction(accessor => command.handler(accessor, first.player));
		assert.deepStrictEqual({
			first: first.player.videoCanvas.followAction.get(),
			second: second.player.videoCanvas.followAction.get(),
			control: first.player.domNode.querySelector('[aria-label^="Follow Action"]')?.getAttribute('role'),
			focusRetained: mainWindow.document.activeElement === first.player.domNode,
		}, { first: true, second: false, control: 'button', focusRetained: true });
	});
});
