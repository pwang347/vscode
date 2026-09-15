/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { IComputerUseSharedThought } from '../../../services/sessions/common/computerUse.js';
import { IComputerUseActivity } from './computerUseActivity.js';
import { IComputerUseVideoScheduler } from './computerUseVideo.js';

export const COMPUTER_USE_THOUGHT_COMMIT_DELAY_MS = 650;
export const COMPUTER_USE_THOUGHT_VISIBLE_MS = 7000;
const COMPUTER_USE_THOUGHT_MAX_LENGTH = 240;

export interface IComputerUseThoughtBubbleState {
	readonly visible: boolean;
	readonly message: string;
	readonly source: 'reasoning' | 'activity';
	readonly streaming: boolean;
}

/** Presents only provider-shared reasoning or user-visible activity; silence has no placeholder. */
export class ComputerUseThoughtBubble extends Disposable {
	readonly state = observableValue<IComputerUseThoughtBubbleState | undefined>(this, undefined);

	private readonly pendingCommit = this._register(new MutableDisposable<IDisposable>());
	private readonly pendingHide = this._register(new MutableDisposable<IDisposable>());
	private visible = true;
	private previousThought: IComputerUseSharedThought | undefined;
	private previousActivityMessage: string | undefined;

	constructor(
		thought: IObservable<IComputerUseSharedThought | undefined>,
		activity: IObservable<IComputerUseActivity>,
		private readonly scheduler: IComputerUseVideoScheduler,
	) {
		super();
		this._register(autorun(reader => {
			const shared = thought.read(reader);
			const progress = activity.read(reader);
			if (!sameThought(shared, this.previousThought)) {
				this.previousThought = shared;
				this.handleSharedThought(shared);
			}
			if (progress.message !== this.previousActivityMessage) {
				this.previousActivityMessage = progress.message;
				if (!shared && progress.active && progress.shared) {
					this.commit('activity', progress.message, true);
				}
			}
		}));
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.pendingCommit.clear();
			this.pendingHide.clear();
			this.hide();
		}
	}

	private handleSharedThought(thought: IComputerUseSharedThought | undefined): void {
		this.pendingCommit.clear();
		if (!thought) {
			this.hide();
			return;
		}
		const message = normalizeThought(thought.text);
		if (!message) {
			return;
		}
		if (!thought.streaming || /[.!?…]["')\]]?$/.test(message)) {
			this.commit(thought.source, message, thought.streaming);
			return;
		}
		this.pendingCommit.value = this.scheduler.schedule(() => {
			this.pendingCommit.clear();
			this.commit(thought.source, message, thought.streaming);
		}, COMPUTER_USE_THOUGHT_COMMIT_DELAY_MS);
	}

	private commit(source: IComputerUseThoughtBubbleState['source'], message: string, streaming: boolean): void {
		if (!this.visible) {
			return;
		}
		const normalized = normalizeThought(message);
		if (!normalized) {
			return;
		}
		this.state.set({ visible: true, message: normalized, source, streaming }, undefined);
		this.pendingHide.value = this.scheduler.schedule(() => this.hide(), COMPUTER_USE_THOUGHT_VISIBLE_MS);
	}

	private hide(): void {
		this.pendingHide.clear();
		const current = this.state.get();
		if (current?.visible) {
			this.state.set({ ...current, visible: false, streaming: false }, undefined);
		}
	}
}

function sameThought(first: IComputerUseSharedThought | undefined, second: IComputerUseSharedThought | undefined): boolean {
	return first === second || !!first && !!second
		&& first.source === second.source
		&& first.text === second.text
		&& first.streaming === second.streaming;
}

function normalizeThought(value: string): string {
	const text = renderAsPlaintext({ value: value.slice(0, 8192) }).replace(/\s+/g, ' ').trim();
	const characters = Array.from(text);
	if (characters.length <= COMPUTER_USE_THOUGHT_MAX_LENGTH) {
		return text;
	}
	return `…${characters.slice(characters.length - COMPUTER_USE_THOUGHT_MAX_LENGTH + 1).join('')}`;
}
