/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'com.microsoft.vscode.mobile',
	appName: 'VS Code Mobile',
	webDir: '../out-vscode-mobile',
	server: {
		// In development, point to the VS Code server with live reload
		// url: 'http://localhost:8080',
		// cleartext: true,
	},
	plugins: {
		SplashScreen: {
			launchAutoHide: true,
			launchShowDuration: 2000,
			backgroundColor: '#1e1e1e',
			showSpinner: true,
			spinnerColor: '#007acc',
		},
		Keyboard: {
			resize: 'ionic',
			resizeOnFullScreen: true,
		},
		StatusBar: {
			style: 'DARK', // Light text for dark background
			backgroundColor: '#1e1e1e',
		},
		PushNotifications: {
			presentationOptions: ['badge', 'sound', 'alert'],
		},
	},
	ios: {
		contentInset: 'always',
		allowsLinkPreview: false,
		scrollEnabled: false,
		// Allow WebSocket connections over Tailscale network
		limitsNavigationsToAppBoundDomains: false,
	},
	android: {
		allowMixedContent: true, // Tailscale may use HTTP internally
		captureInput: true,
		webContentsDebuggingEnabled: true, // Disable in production
	},
};

export default config;
