/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import gulp from 'gulp';
import * as fs from 'fs';
import * as path from 'path';
import * as task from './lib/task.ts';

const REPO_ROOT = path.dirname(import.meta.dirname);

/**
 * Build the thin mobile app shell for Capacitor.
 *
 * The mobile app is now a lightweight shell that handles server
 * connection and workspace selection. The full workbench JS/CSS
 * is served from the code server's /chat endpoint, so the app
 * doesn't need to bundle any VS Code source.
 */
const copyMobileShellTask = task.define('copy-mobile-shell', () => {
	const outDir = path.join(REPO_ROOT, 'out-vscode-mobile');
	const srcHtml = path.join(REPO_ROOT, 'src/vs/mobile/browser/shell.html');
	const html = fs.readFileSync(srcHtml, 'utf-8');

	// Write the shell as index.html for Capacitor
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'index.html'), html);

	// Write a build date marker so the app can display its version
	fs.writeFileSync(path.join(outDir, 'date'), new Date().toISOString());
});

// Development build (thin shell only)
gulp.task('vscode-mobile-web-dev', task.series(copyMobileShellTask));

// Production build (thin shell only — same as dev, the shell is already minimal)
gulp.task('vscode-mobile-web', task.series(copyMobileShellTask));
