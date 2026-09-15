/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IComputerUseVideoConfig } from '../../../services/sessions/common/computerUse.js';
import { IComputerUseDecodedFrame, IComputerUseVideoDecoder, IComputerUseVideoDecoderFactory, IComputerUseVideoScheduler } from './computerUseVideo.js';

export function createComputerUseVideoDecoder(element: HTMLElement): IComputerUseVideoDecoderFactory {
	const targetWindow = getWindow(element);
	const decoderConstructor = targetWindow.VideoDecoder;
	const chunkConstructor = targetWindow.EncodedVideoChunk;
	const toConfig = (config: IComputerUseVideoConfig): VideoDecoderConfig => ({
		codec: config.codec,
		codedWidth: config.codedWidth,
		codedHeight: config.codedHeight,
		description: decodeBase64(config.description).buffer,
		optimizeForLatency: true,
	});
	return {
		available: typeof decoderConstructor === 'function' && typeof decoderConstructor.isConfigSupported === 'function' && typeof chunkConstructor === 'function',
		async isSupported(config) {
			return !!(await decoderConstructor.isConfigSupported(toConfig(config))).supported;
		},
		create(config, output, error): IComputerUseVideoDecoder {
			const decoder = new decoderConstructor({
				output: frame => {
					let closed = false;
					const decoded: IComputerUseDecodedFrame = {
						timestamp: frame.timestamp,
						width: frame.displayWidth,
						height: frame.displayHeight,
						draw: context => context.drawImage(frame, 0, 0),
						close: () => {
							if (!closed) {
								closed = true;
								frame.close();
							}
						},
					};
					try {
						output(decoded);
					} catch (failure) {
						decoded.close();
						error(failure instanceof Error ? failure : new Error(String(failure)));
					}
				},
				error,
			});
			try {
				decoder.configure(toConfig(config));
			} catch (error) {
				decoder.close();
				throw error;
			}
			return {
				get decodeQueueSize() { return decoder.decodeQueueSize; },
				decode: frame => decoder.decode(new chunkConstructor({
					type: frame.keyFrame ? 'key' : 'delta',
					timestamp: frame.timestamp,
					duration: frame.duration,
					data: decodeBase64(frame.data).buffer,
				})),
				flush: () => decoder.flush(),
				dispose: () => {
					if (decoder.state !== 'closed') {
						decoder.close();
					}
				},
			};
		},
	};
}

export function createComputerUseVideoScheduler(element: HTMLElement): IComputerUseVideoScheduler {
	const targetWindow = getWindow(element);
	return {
		now: () => targetWindow.performance.now(),
		schedule: (callback, delay) => {
			const handle = targetWindow.setTimeout(callback, delay);
			return toDisposable(() => targetWindow.clearTimeout(handle));
		},
		animationFrame: callback => {
			const handle = targetWindow.requestAnimationFrame(callback);
			return toDisposable(() => targetWindow.cancelAnimationFrame(handle));
		},
	};
}
