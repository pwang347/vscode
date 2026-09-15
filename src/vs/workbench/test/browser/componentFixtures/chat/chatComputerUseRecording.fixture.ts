/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChatContentMarkdownRenderer } from '../../../../contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { ChatSystemNotificationContentPart } from '../../../../contrib/chat/browser/widget/chatContentParts/chatSystemNotificationContentPart.js';
import { IChatSystemNotificationPart } from '../../../../contrib/chat/common/chatService/chatService.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';
import { registerChatFixtureServices } from './chatFixtureUtils.js';

import '../../../../contrib/chat/browser/widget/media/chat.css';

const highContrastThemes = ['darkHighContrast', 'lightHighContrast'] as const;

function renderRecording(context: ComponentFixtureContext, state: 'placeholder' | 'poster'): void {
	const { container, disposableStore } = context;
	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: context.theme,
		additionalServices: registerChatFixtureServices,
	});
	const notification: IChatSystemNotificationPart = {
		kind: 'systemNotification',
		content: new MarkdownString('Reviewed the checkout flow'),
		icon: Codicon.playCircle,
		presentation: 'computerUseRecording',
		accessibilityLabel: 'Reviewed the checkout flow. Computer Use video recording, 4:18.',
		computerUseRecording: {
			title: 'Reviewed the checkout flow',
			durationMs: 258_000,
			trimmed: false,
			recordingUri: URI.parse('fixture://computer-use/manifest.json'),
			command: {
				id: 'sessions.openComputerUseRecording',
				title: 'Play Reviewed the Checkout Flow',
			},
		},
	};
	const renderer = instantiationService.createInstance(ChatContentMarkdownRenderer);
	const part = disposableStore.add(instantiationService.createInstance(ChatSystemNotificationContentPart, notification, renderer, undefined));

	container.style.width = '452px';
	container.style.padding = '16px';
	container.classList.add('interactive-session');
	const itemContainer = dom.append(container, dom.$('.interactive-item-container'));
	itemContainer.appendChild(part.domNode);

	if (state !== 'placeholder') {
		const canvas = part.domNode.querySelector<HTMLCanvasElement>('.chat-computer-use-recording-poster');
		if (!canvas) {
			throw new Error('Expected the recording poster canvas.');
		}
		renderPoster(canvas);
		part.domNode.classList.add('has-poster');
	}
}

function renderPoster(canvas: HTMLCanvasElement): void {
	canvas.width = 640;
	canvas.height = 360;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('Expected a canvas rendering context.');
	}

	context.fillStyle = '#202225';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = '#2b2e32';
	context.fillRect(0, 0, canvas.width, 36);
	context.fillRect(0, 36, 136, canvas.height - 36);
	context.fillStyle = '#3b3f44';
	for (let index = 0; index < 7; index++) {
		context.fillRect(18, 62 + index * 34, 94 - index * 4, 8);
	}
	context.fillStyle = '#d2d4d7';
	context.fillRect(168, 74, 154, 10);
	context.fillStyle = '#747980';
	for (let index = 0; index < 8; index++) {
		context.fillRect(168, 108 + index * 25, 282 + (index % 3) * 46, 7);
	}
}

export default defineThemedFixtureGroup({ path: 'chat/' }, {
	Placeholder: defineComponentFixture({
		additionalThemes: highContrastThemes,
		render: context => renderRecording(context, 'placeholder'),
	}),
	Poster: defineComponentFixture({
		additionalThemes: highContrastThemes,
		render: context => renderRecording(context, 'poster'),
	}),
});
