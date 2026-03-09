/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PersistentConnectionEventType, ReconnectionWaitEvent } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DomEmitter } from '../../../../base/browser/event.js';

/**
 * Native bridge exposed by the Android app via `addJavascriptInterface`.
 * Available when running inside the Capacitor WebView.
 */
interface MobileNativeBridge {
	startBackgroundService(): void;
	stopBackgroundService(): void;
}

function getMobileNativeBridge(): MobileNativeBridge | undefined {
	return (mainWindow as unknown as Record<string, unknown>).MobileNative as MobileNativeBridge | undefined;
}

/**
 * Keeps the remote connection alive across mobile app background/foreground
 * transitions.
 *
 * When a Capacitor-based mobile app goes to the background, the OS suspends
 * the WebView's JavaScript execution and may close WebSocket connections.
 * When the app returns to foreground, the standard `PersistentConnection`
 * reconnection loop resumes but may be waiting on a backoff timer.
 *
 * This contribution:
 * 1. Starts an Android foreground service (via the native bridge) to keep
 *    the WebView alive in the background
 * 2. Tracks `document.visibilitychange` to detect background/foreground
 * 3. When the app resumes from background during a `ReconnectionWait`,
 *    immediately skips the wait timer so reconnection happens instantly
 */
class MobileBackgroundConnectionKeeper extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'mobile.backgroundConnectionKeeper';

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const connection = remoteAgentService.getConnection();
		if (!connection) {
			return;
		}

		// Start the native foreground service to keep the app alive in the
		// background. This prevents Android from suspending the WebView and
		// closing the WebSocket.
		const nativeBridge = getMobileNativeBridge();
		if (nativeBridge) {
			try {
				nativeBridge.startBackgroundService();
				this.logService.info('[mobile] Started background connection service');
				this._register({
					dispose: () => {
						try {
							nativeBridge.stopBackgroundService();
						} catch {
							// Best effort -- the native side may already be torn down
						}
					}
				});
			} catch (err) {
				this.logService.warn('[mobile] Failed to start background connection service', err);
			}
		}

		let lastHiddenTime = 0;
		let reconnectWaitEvent: ReconnectionWaitEvent | null = null;
		const reconnectWaitDisposable = this._register(new MutableDisposable());

		// Track the current reconnection wait event so we can skip it on resume
		this._register(connection.onDidStateChange((e) => {
			switch (e.type) {
				case PersistentConnectionEventType.ReconnectionWait:
					reconnectWaitEvent = e;
					reconnectWaitDisposable.value = {
						dispose: () => { reconnectWaitEvent = null; }
					};
					break;
				case PersistentConnectionEventType.ReconnectionRunning:
				case PersistentConnectionEventType.ConnectionGain:
				case PersistentConnectionEventType.ReconnectionPermanentFailure:
					reconnectWaitDisposable.clear();
					break;
			}
		}));

		// Listen for visibility changes to detect background/foreground
		const visibilityEmitter = this._register(new DomEmitter(mainWindow.document, 'visibilitychange'));
		this._register(visibilityEmitter.event(() => {
			if (mainWindow.document.hidden) {
				// App going to background -- record the time
				lastHiddenTime = Date.now();
				this.logService.info('[mobile] App entering background');
			} else {
				// App returning to foreground
				const backgroundDuration = lastHiddenTime > 0 ? Date.now() - lastHiddenTime : 0;
				this.logService.info(`[mobile] App returning to foreground after ${Math.round(backgroundDuration / 1000)}s`);

				// If we're currently waiting to reconnect, skip the wait
				// timer so the reconnection attempt happens immediately.
				if (reconnectWaitEvent) {
					this.logService.info('[mobile] Skipping reconnection wait timer -- resuming immediately');
					reconnectWaitEvent.skipWait();
				}
			}
		}));
	}
}

registerWorkbenchContribution2(MobileBackgroundConnectionKeeper.ID, MobileBackgroundConnectionKeeper, WorkbenchPhase.BlockRestore);
