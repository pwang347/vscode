/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import gulp from 'gulp';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as task from './lib/task.ts';

const REPO_ROOT = path.dirname(import.meta.dirname);

/**
 * Build the mobile web bundle using the standard esbuild bundler.
 *
 * This produces a web bundle optimized for the Capacitor WebView,
 * using the standard web entry points from build/next/index.ts.
 */
function runMobileEsbuildBundle(outDir: string, minify: boolean): void {
	const nodePath = process.execPath;
	const scriptPath = path.join(REPO_ROOT, 'build/next/index.ts');
	const args = [scriptPath, 'bundle', '--out', outDir, '--target', 'web'];
	if (minify) {
		args.push('--minify');
		args.push('--mangle-privates');
	}

	cp.execFileSync(nodePath, args, {
		stdio: 'inherit',
		cwd: REPO_ROOT,
	});
}

// Development build (no minification)
const mobileWebDevTask = task.define('vscode-mobile-web-dev', () => {
	runMobileEsbuildBundle('out-vscode-mobile', false);
});

// Production build (minified)
const mobileWebProdTask = task.define('vscode-mobile-web', () => {
	runMobileEsbuildBundle('out-vscode-mobile', true);
});

/**
 * Generate a static index.html for the Capacitor app.
 * Replaces the server-side {{...}} template placeholders with
 * paths relative to the app root so the WebView can load the
 * bundled assets directly from disk.
 */
const copyMobileHtmlTask = task.define('copy-mobile-html', () => {
	const outDir = path.join(REPO_ROOT, 'out-vscode-mobile');
	const srcHtml = path.join(REPO_ROOT, 'src/vs/mobile/browser/mobile.html');
	let html = fs.readFileSync(srcHtml, 'utf-8');

	// In the bundle output, files live at the root (no "out/" subdirectory).
	// The server template uses {{WORKBENCH_WEB_BASE_URL}}/out/... paths which
	// become "./out/..." — we need to strip the "/out" segment so they resolve
	// to "./vs/..." relative to the Capacitor webDir root.
	const replacements: Record<string, string> = {
		'WORKBENCH_WEB_BASE_URL': '.',
		'WORKBENCH_WEB_CONFIGURATION': '{}',
		'WORKBENCH_AUTH_SESSION': '',
		'WORKBENCH_NLS_FALLBACK_URL': '',
		'WORKBENCH_NLS_URL': '',
	};
	html = html.replace(/\{\{([^}]+)\}\}/g, (_, key) => replacements[key] ?? '');

	// Strip the erroneous "/out/" path segment from asset URLs.
	// E.g. "./out/vs/mobile/browser/mobile.js" → "./vs/mobile/browser/mobile.js"
	html = html.replace(/\.\/out\//g, './');

	// Fix the _VSCODE_FILE_ROOT for Capacitor. Using './' would cause
	// FileAccess.asBrowserUri() to generate file:// URIs (via URI.file()),
	// which Capacitor's WebView blocks. Using the full https://localhost/
	// origin ensures all resource URIs use the correct scheme.
	html = html.replace(
		'globalThis._VSCODE_FILE_ROOT = baseUrl + \'/out/\';',
		'globalThis._VSCODE_FILE_ROOT = \'https://localhost/\';'
	);

	// Remove empty script tags (NLS scripts with empty src cause the browser
	// to load the current page as JavaScript, which fails silently).
	html = html.replace(/<script[^>]*\bsrc=""[^>]*><\/script>\s*/g, '');

	// Write the processed index.html for Capacitor
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'index.html'), html);

	// Also keep the original template for server-side use
	const nestedDir = path.join(outDir, 'vs/mobile/browser');
	fs.mkdirSync(nestedDir, { recursive: true });
	fs.copyFileSync(srcHtml, path.join(nestedDir, 'mobile.html'));
});

// Combined dev task
gulp.task('vscode-mobile-web-dev', task.series(mobileWebDevTask, copyMobileHtmlTask));

// Combined production task
gulp.task('vscode-mobile-web', task.series(mobileWebProdTask, copyMobileHtmlTask));
