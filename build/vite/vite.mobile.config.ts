/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig, type Plugin } from 'vite';
import * as fs from 'fs';
import path, { join } from 'path';
import { rollupEsmUrlPlugin } from '@vscode/rollup-plugin-esm-url';

const REPO_ROOT = join(__dirname, '../..');

/**
 * Vite plugin that replaces the BUILD->INSERT_PRODUCT_CONFIGURATION placeholder
 * in product.js with the actual product.json contents — mirroring what the
 * standard web build does via createVSCodeWebFileContentMapper.
 */
function productConfigPlugin(): Plugin {
	return {
		name: 'vscode-product-config',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('vs/platform/product/common/product.ts') && !id.endsWith('vs/platform/product/common/product.js')) {
				return null;
			}
			if (!code.includes('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/')) {
				return null;
			}

			const productJson = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'product.json'), 'utf-8'));

			// Merge product.overrides.json when running in dev
			try {
				const overrides = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'product.overrides.json'), 'utf-8'));
				Object.assign(productJson, overrides);
			} catch { /* no overrides file */ }

			const packageJson = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
			const productConfiguration = JSON.stringify({
				...productJson,
				version: packageJson.version,
			});
			// Remove outer braces — the placeholder sits inside an object literal: { /*...*/ }
			const replacement = productConfiguration.substring(1, productConfiguration.length - 1);
			return code.replace('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/', () => replacement);
		}
	};
}

export default defineConfig({
	base: './',
	plugins: [
		rollupEsmUrlPlugin({}),
		productConfigPlugin(),
	],
	resolve: {
		alias: {
			'~@vscode/codicons': join(__dirname, '../../node_modules/@vscode/codicons'),
		}
	},
	esbuild: {
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
			}
		},
	},
	root: '../..', // To support /out/... paths
	build: {
		outDir: join(__dirname, '../../out-vscode-mobile-bundle'),
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: {
				mobile: path.resolve(__dirname, 'mobile-vite.html'),
			},
		},
		watch: {},
	},
});
