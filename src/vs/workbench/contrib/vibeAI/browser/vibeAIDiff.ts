/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Line-based diff used by the VibeAI chat tool cards (agent write_file
 * previews). Self-contained LCS with common prefix/suffix trimming and
 * an OOM guard — ported from the proven diff helpers of the deprecated
 * web frontend so the card renders the same red/green preview.
 */

const MAX_LCS_CELLS = 4_000_000;

export interface IVibeAIDiffLine {
	readonly type: 'add' | 'del' | 'same';
	readonly text: string;
	/** 1-based line in the original document (absent for pure additions). */
	readonly oldLine?: number;
	/** 1-based line in the updated document (absent for pure deletions). */
	readonly newLine?: number;
}

export function computeDiffStats(original: string, updated: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of computeDiffLines(original, updated)) {
		if (line.type === 'add') {
			additions++;
		} else if (line.type === 'del') {
			deletions++;
		}
	}
	return { additions, deletions };
}

/**
 * Normalizes CRLF / CR line endings to LF. The backend writes text with
 * platform line endings (aiofiles text mode translates `\n` to `\r\n` on
 * Windows) while the write's new content keeps `\n` — comparing or
 * diffing the raw strings mismatched every line on Windows. Diffing,
 * previews and the editor highlighter's content guard all normalize
 * before splitting.
 */
export function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function computeDiffLines(original: string, updated: string): IVibeAIDiffLine[] {
	const oldLines = original.length === 0 ? [] : normalizeEol(original).split('\n');
	const newLines = updated.length === 0 ? [] : normalizeEol(updated).split('\n');

	const result: IVibeAIDiffLine[] = [];

	// Trim the common prefix/suffix first — the LCS below then only runs
	// over the changed middle, which keeps typical edits tiny.
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	for (let i = 0; i < prefix; i++) {
		result.push({ type: 'same', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
	}
	appendLcsEdits(result, oldLines.slice(prefix, oldLines.length - suffix), newLines.slice(prefix, newLines.length - suffix), prefix);
	for (let i = 0; i < suffix; i++) {
		const oldIndex = oldLines.length - suffix + i;
		const newIndex = newLines.length - suffix + i;
		result.push({ type: 'same', text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
	}
	return result;
}

function appendLcsEdits(result: IVibeAIDiffLine[], oldMid: string[], newMid: string[], offset: number): void {
	const m = oldMid.length;
	const n = newMid.length;
	if (m === 0 && n === 0) {
		return;
	}

	// OOM guard: fall back to a full replace block for huge rewrites.
	if (m * n > MAX_LCS_CELLS) {
		for (let i = 0; i < m; i++) {
			result.push({ type: 'del', text: oldMid[i], oldLine: offset + i + 1 });
		}
		for (let j = 0; j < n; j++) {
			result.push({ type: 'add', text: newMid[j], newLine: offset + j + 1 });
		}
		return;
	}

	// dp[i][j] = LCS length of oldMid[i..] and newMid[j..]
	const dp: Uint32Array[] = [];
	for (let i = 0; i <= m; i++) {
		dp.push(new Uint32Array(n + 1));
	}
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = oldMid[i] === newMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (oldMid[i] === newMid[j]) {
			result.push({ type: 'same', text: oldMid[i], oldLine: offset + i + 1, newLine: offset + j + 1 });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			result.push({ type: 'del', text: oldMid[i], oldLine: offset + i + 1 });
			i++;
		} else {
			result.push({ type: 'add', text: newMid[j], newLine: offset + j + 1 });
			j++;
		}
	}
	while (i < m) {
		result.push({ type: 'del', text: oldMid[i], oldLine: offset + i + 1 });
		i++;
	}
	while (j < n) {
		result.push({ type: 'add', text: newMid[j], newLine: offset + j + 1 });
		j++;
	}
}