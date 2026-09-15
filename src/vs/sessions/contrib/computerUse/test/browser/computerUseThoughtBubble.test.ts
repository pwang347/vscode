/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IComputerUseSharedThought } from '../../../../services/sessions/common/computerUse.js';
import { IComputerUseActivity } from '../../browser/computerUseActivity.js';
import { COMPUTER_USE_THOUGHT_COMMIT_DELAY_MS, COMPUTER_USE_THOUGHT_VISIBLE_MS, ComputerUseThoughtBubble } from '../../browser/computerUseThoughtBubble.js';
import { TestVideoScheduler } from './computerUseTestUtils.js';

suite('ComputerUseThoughtBubble', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const thought = observableValue<IComputerUseSharedThought | undefined>('thought', undefined);
		const activity = observableValue<IComputerUseActivity>('activity', { message: 'Waiting', active: false });
		const scheduler = new TestVideoScheduler();
		const bubble = store.add(new ComputerUseThoughtBubble(thought, activity, scheduler));
		return { thought, activity, scheduler, bubble };
	}

	test('renders no placeholder and coalesces partial reasoning after silence', async () => {
		const { thought, activity, scheduler, bubble } = setup();
		assert.strictEqual(bubble.state.get(), undefined);
		activity.set({ message: 'Working…', active: true }, undefined);
		assert.strictEqual(bubble.state.get(), undefined);

		thought.set({ source: 'reasoning', text: 'The window is', streaming: true }, undefined);
		await scheduler.advance(COMPUTER_USE_THOUGHT_COMMIT_DELAY_MS - 1);
		assert.strictEqual(bubble.state.get(), undefined);
		thought.set({ source: 'reasoning', text: 'The window is ready', streaming: true }, undefined);
		await scheduler.advance(COMPUTER_USE_THOUGHT_COMMIT_DELAY_MS);

		assert.deepStrictEqual(bubble.state.get(), {
			visible: true,
			message: 'The window is ready',
			source: 'reasoning',
			streaming: true,
		});
	});

	test('shows complete thoughts immediately and fades after silence', async () => {
		const { thought, scheduler, bubble } = setup();
		thought.set({ source: 'reasoning', text: 'The field is focused. I will type now.', streaming: true }, undefined);
		assert.deepStrictEqual(bubble.state.get(), {
			visible: true,
			message: 'The field is focused. I will type now.',
			source: 'reasoning',
			streaming: true,
		});
		await scheduler.advance(COMPUTER_USE_THOUGHT_VISIBLE_MS);
		assert.deepStrictEqual(bubble.state.get(), {
			visible: false,
			message: 'The field is focused. I will type now.',
			source: 'reasoning',
			streaming: false,
		});
	});

	test('clears a previous-turn thought when the provider clears its stream', () => {
		const { thought, bubble } = setup();
		thought.set({ source: 'reasoning', text: 'I will type now.', streaming: false }, undefined);
		thought.set(undefined, undefined);
		assert.deepStrictEqual(bubble.state.get(), {
			visible: false,
			message: 'I will type now.',
			source: 'reasoning',
			streaming: false,
		});
	});

	test('uses active progress only when no shared reasoning is available', () => {
		const { thought, activity, bubble } = setup();
		activity.set({ message: 'Reading the TextEdit window', active: true, shared: true }, undefined);
		const activityState = bubble.state.get();
		thought.set({ source: 'reasoning', text: 'The document is empty.', streaming: false }, undefined);
		activity.set({ message: 'Typing in TextEdit', active: true, shared: true }, undefined);

		assert.deepStrictEqual({
			activityState,
			reasoningState: bubble.state.get(),
		}, {
			activityState: {
				visible: true,
				message: 'Reading the TextEdit window',
				source: 'activity',
				streaming: true,
			},
			reasoningState: {
				visible: true,
				message: 'The document is empty.',
				source: 'reasoning',
				streaming: false,
			},
		});
	});

	test('hides immediately when the viewer is hidden and does not replay stale text', () => {
		const { thought, bubble } = setup();
		thought.set({ source: 'reasoning', text: 'I will click Continue.', streaming: false }, undefined);
		bubble.setVisible(false);
		thought.set({ source: 'reasoning', text: 'This arrived while hidden.', streaming: false }, undefined);
		bubble.setVisible(true);

		assert.deepStrictEqual(bubble.state.get(), {
			visible: false,
			message: 'I will click Continue.',
			source: 'reasoning',
			streaming: false,
		});
	});

	test('bounds and flattens shared Markdown text', () => {
		const { thought, bubble } = setup();
		thought.set({ source: 'reasoning', text: `**Plan**\n\n${'x'.repeat(300)}.`, streaming: false }, undefined);
		const state = bubble.state.get();
		assert.ok(state);
		assert.strictEqual(state.message.includes('\n'), false);
		assert.strictEqual(state.message.length, 240);
		assert.ok(state.message.startsWith('…'));
	});
});
