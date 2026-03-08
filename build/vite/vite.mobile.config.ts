/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'vite';
import path, { join } from 'path';
import { rollupEsmUrlPlugin } from '@vscode/rollup-plugin-esm-url';

export default defineConfig({
	base: './',
	plugins: [
		rollupEsmUrlPlugin({}),
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
