/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resolveBackendRootPath } from '../../node/vibeAIService.js';

suite('resolveBackendRootPath', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.promises.mkdtemp(join(os.tmpdir(), 'vibeai-backend-root-'));
	});

	teardown(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test('absolute configured path passes through untouched', () => {
		const absolute = join(root, 'backend');
		assert.strictEqual(
			resolveBackendRootPath(absolute, join(root, 'app'), join(root, 'exe', 'Vulcan.exe')),
			absolute,
			'an absolute backendRoot must never be re-anchored'
		);
	});

	test('empty configured path passes through untouched', () => {
		assert.strictEqual(
			resolveBackendRootPath('', join(root, 'app'), join(root, 'exe', 'Vulcan.exe')),
			'',
			'an unset backendRoot must stay unset so the caller warns about it'
		);
	});

	test('relative path resolves against the app root when it contains app/main.py', () => {
		const backend = join(root, 'checkout', 'vscode', 'backend');
		fs.mkdirSync(join(backend, 'app'), { recursive: true });
		fs.writeFileSync(join(backend, 'app', 'main.py'), '');
		assert.strictEqual(
			resolveBackendRootPath('backend', join(root, 'checkout', 'vscode'), join(root, 'exe', 'Vulcan.exe')),
			backend,
			'a backend shipped inside the fork checkout resolves to the app-root candidate'
		);
	});

	test('relative path resolves against the app-root parent (dev checkout layout)', () => {
		const backend = join(root, 'checkout', 'backend');
		fs.mkdirSync(join(backend, 'app'), { recursive: true });
		fs.writeFileSync(join(backend, 'app', 'main.py'), '');
		assert.strictEqual(
			resolveBackendRootPath('backend', join(root, 'checkout', 'vscode'), join(root, 'exe', 'Vulcan.exe')),
			backend,
			'a backend next to vscode/ resolves to the parent-of-app-root candidate'
		);
	});

	test('relative path resolves against the exe directory (portable layout)', () => {
		const backend = join(root, 'portable', 'backend');
		fs.mkdirSync(join(backend, 'app'), { recursive: true });
		fs.writeFileSync(join(backend, 'app', 'main.py'), '');
		assert.strictEqual(
			resolveBackendRootPath('backend', join(root, 'elsewhere', 'app'), join(root, 'portable', 'Vulcan.exe')),
			backend,
			'a backend next to the packaged exe resolves to the exe-dir candidate'
		);
	});

	test('nothing found falls back to the app-root candidate for a concrete warning', () => {
		const appRoot = join(root, 'checkout', 'vscode');
		assert.strictEqual(
			resolveBackendRootPath('backend', appRoot, join(root, 'exe', 'Vulcan.exe')),
			join(appRoot, 'backend'),
			'the fallback must name a concrete path so the not-found warning is actionable'
		);
	});
});
