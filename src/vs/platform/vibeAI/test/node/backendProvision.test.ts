/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { findPythonInRegistryOutput } from '../../node/vibeAIService.js';

suite('findPythonInRegistryOutput', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses the PEP 514 default-value line printed by reg query /ve', () => {
		// reg.exe prints the default value as: "(Default)    REG_SZ    C:\...\Python312\"
		const output = [
			'',
			'HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.12\\InstallPath',
			'    (Default)    REG_SZ    C:\\Users\\John Smith\\AppData\\Local\\Programs\\Python\\Python312\\',
			''
		].join('\r\n');
		assert.strictEqual(
			findPythonInRegistryOutput(output),
			'C:\\Users\\John Smith\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
			'the registry install path must be extracted and joined with python.exe'
		);
	});

	test('returns undefined when the value is not a REG_SZ string', () => {
		const output = [
			'',
			'HKEY_CURRENT_USER\\Software\\Python\\PythonCore\\3.12\\InstallPath',
			'    (Default)    REG_BINARY    3C3E',
			''
		].join('\r\n');
		assert.strictEqual(findPythonInRegistryOutput(output), undefined);
	});

	test('returns undefined for empty or missing output', () => {
		assert.strictEqual(findPythonInRegistryOutput(null), undefined);
		assert.strictEqual(findPythonInRegistryOutput(''), undefined);
	});
});
