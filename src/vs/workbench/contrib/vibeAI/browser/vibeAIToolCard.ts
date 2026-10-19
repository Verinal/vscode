/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { tokenizeToStringSync } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { IVibeAICodeChange, IVibeAIReadRange } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IVibeAIPersistedToolCall } from './vibeAIChatSessionStore.js';
import { IVibeAIDiffLine, computeDiffLines, computeDiffStats } from './vibeAIDiff.js';
import './media/vibeAIChat.css';

const $ = DOM.$;

const TOOL_LABELS: Record<string, string> = {
	read_file: localize('vibeAIChat.tool.read_file', "Read file"),
	write_file: localize('vibeAIChat.tool.write_file', "Write file"),
	delete_file: localize('vibeAIChat.tool.delete_file', "Delete file"),
	list_files: localize('vibeAIChat.tool.list_files', "List directory"),
	run_terminal: localize('vibeAIChat.tool.run_terminal', "Run command"),
	search_codebase: localize('vibeAIChat.tool.search_codebase', "Search codebase"),
	grep: localize('vibeAIChat.tool.grep', "Grep"),
};

const TOOL_ICONS: Record<string, string> = {
	read_file: 'codicon-file',
	write_file: 'codicon-new-file',
	delete_file: 'codicon-trash',
	list_files: 'codicon-folder',
	run_terminal: 'codicon-terminal',
	search_codebase: 'codicon-search',
	grep: 'codicon-search',
};

const MAX_DIFF_BODY_HEIGHT = 80;
/** Collapsed preview cap: 5 diff rows (the toggle appears above this). */
const COLLAPSED_DIFF_LINES = 5;
/** Expanded preview cap (the toggle): 24 diff rows, scrollable beyond. */
const EXPANDED_DIFF_BODY_HEIGHT = 384;
/** Collapsed output preview cap (run_terminal): 5 lines at the 16px line-height. */
const COLLAPSED_OUTPUT_LINES = 5;
const COMPRESSED_UNCHANGED_RUN = 4;

/** Tolerant 1-based line-number coercion (models may send string numbers). */
function asLineNumber(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Phase 63: compact read range for read_file cards — the requested symbol
 * and/or "L10-L20" from the call arguments. The ACTUAL resolved range
 * replaces this once the result arrives (setResult).
 */
function describeReadArgs(record: Record<string, unknown>): string {
	const parts: string[] = [];
	const symbol = record['symbol'];
	if (typeof symbol === 'string' && symbol.length > 0) {
		parts.push(symbol);
	}
	const start = asLineNumber(record['start_line']);
	const end = asLineNumber(record['end_line']);
	if (start !== undefined && end !== undefined) {
		parts.push(`L${start}–L${end}`);
	} else if (start !== undefined) {
		parts.push(`L${start}–…`);
	} else if (end !== undefined) {
		parts.push(`L1–L${end}`);
	}
	return parts.join(' ');
}

/**
 * The raw path argument of a file tool — the open-file hover action uses
 * this (the display summary may carry a line-range suffix).
 */
function argPath(name: string, args: unknown): string | undefined {
	if (args && typeof args === 'object') {
		const record = args as Record<string, unknown>;
		if (name === 'read_file' || name === 'write_file' || name === 'list_files' || name === 'delete_file') {
			const path = String(record['path'] ?? '');
			return path.length > 0 ? path : undefined;
		}
	}
	return undefined;
}

function summarizeArgs(name: string, args: unknown): string {
	if (args && typeof args === 'object') {
		const record = args as Record<string, unknown>;
		if (name === 'run_terminal') {
			return String(record['command'] ?? '');
		}
		if (name === 'read_file' || name === 'write_file' || name === 'list_files' || name === 'delete_file') {
			const path = String(record['path'] ?? '.');
			if (name === 'read_file') {
				// Phase 63: "x.py L10-L20" / "x.py symbol" right after the path.
				const range = describeReadArgs(record);
				return range.length > 0 ? `${path} ${range}` : path;
			}
			return path;
		}
		if (name === 'search_codebase') {
			return String(record['query'] ?? '');
		}
		if (name === 'grep') {
			const pattern = String(record['pattern'] ?? '');
			const scope = String(record['path'] ?? '');
			return scope.length > 0 ? `${pattern} · ${scope}` : pattern;
		}
	}
	// Fallback: JSON for objects — String() shows "[object Object]".
	if (args && typeof args === 'object') {
		return JSON.stringify(args).slice(0, 80);
	}
	return String(args ?? '').slice(0, 80);
}

/**
 * Phase 65: the line range a header click jumps to — the actual resolved
 * read range (arrives via setResult), the first changed line of a write
 * (computed from the diff), or the args' requested range. `undefined` =
 * open without a selection (top of the file).
 */
function headerJumpRange(
	name: string,
	args: unknown,
	read: IVibeAIReadRange | undefined,
	firstChangeLine: number | undefined
): { start: number; end?: number } | undefined {
	if (name === 'read_file') {
		// The actual range wins once the result arrived; the requested
		// range from the args is the streaming/restore fallback.
		if (read) {
			return { start: read.start, end: read.end };
		}
		const record = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
		const start = asLineNumber(record['start_line']);
		const end = asLineNumber(record['end_line']);
		if (start !== undefined) {
			return { start, end };
		}
		if (end !== undefined) {
			return { start: 1, end };
		}
		return undefined;
	}
	if (name === 'write_file') {
		// Jump to the first changed line of the write (new-file numbering);
		// a partial write's args range is the fallback (full-file writes
		// start at line 1).
		if (firstChangeLine !== undefined) {
			return { start: firstChangeLine };
		}
		const record = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
		const start = asLineNumber(record['start_line']);
		if (start !== undefined) {
			return { start };
		}
		return undefined;
	}
	return undefined;
}

/**
 * Cursor-style activity card for a single agent tool call. Created on
 * `tool_start` (pending), finalized on `tool_result` with a status icon
 * and — for file changes — an inline red/green diff preview with line
 * numbers, theme-matched syntax highlighting, `+N −M` stats, hover actions
 * (open file / restore) and a restore action.
 */
export class VibeAIToolCard {

	readonly element: HTMLElement;

	private readonly headerStatus: HTMLElement;
	private readonly argsSummary: HTMLElement;
	private readonly streamSection: HTMLElement;
	private readonly streamPre: HTMLElement;
	private readonly outputSection: HTMLElement;
	private readonly diffSection: HTMLElement;
	// Phase 45: the call identity and result are kept as fields so
	// snapshot() can capture the card for lossless history persistence.
	private readonly name: string;
	private readonly args: unknown;
	private status: string | undefined;
	private result: string | undefined;
	private output: string | undefined;
	private change: IVibeAICodeChange | undefined;
	private read: IVibeAIReadRange | undefined;
	/** Phase 65: first changed line of the rendered diff — header click reveal target. */
	private firstChangeLine: number | undefined;
	private restored = false;
	private restoring = false;
	private streamText: string | undefined;
	private restoreButton: HTMLButtonElement | undefined;

	constructor(
		name: string,
		args: unknown,
		private readonly languageService: ILanguageService,
		private readonly onRestore: (change: IVibeAICodeChange) => Promise<boolean>,
		onOpenFile: ((path: string, line?: number, endLine?: number) => void) | undefined
	) {
		this.name = name;
		this.args = args;
		this.element = $('.vibe-ai-tool-card');

		// --- header
		const header = DOM.append(this.element, $('.vibe-ai-tool-card-header'));

		this.headerStatus = DOM.append(header, $('span.codicon.codicon-loading.vibe-ai-tool-card-status'));
		this.headerStatus.setAttribute('aria-hidden', 'true');

		const icon = DOM.append(header, $(`span.codicon.${TOOL_ICONS[name] ?? 'codicon-symbol-file'}.vibe-ai-tool-card-icon`));
		icon.setAttribute('aria-hidden', 'true');

		const label = DOM.append(header, $('span.vibe-ai-tool-card-label'));
		label.textContent = TOOL_LABELS[name] ?? name;

		this.argsSummary = DOM.append(header, $('span.vibe-ai-tool-card-args'));
		this.argsSummary.textContent = summarizeArgs(name, args);
		this.argsSummary.title = summarizeArgs(name, args);

		// Phase 65: clicking the header opens the file — read cards jump to
		// the read range, write cards to the first changed line (Cursor
		// parity). The hover action buttons stop propagation so a click on
		// them doesn't double-fire the open.
		if (onOpenFile && (name === 'read_file' || name === 'write_file') && argPath(name, args)) {
			header.classList.add('vibe-ai-clickable');
			header.title = localize('vibeAIChat.tool.openHeader', "Open in editor");
			this.disposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
				const path = argPath(name, args);
				if (!path) {
					return;
				}
				const range = headerJumpRange(name, args, this.read, this.firstChangeLine);
				onOpenFile(path, range?.start, range?.end);
			}));
		}

		// --- hover actions (open file + restore) — reveal on hover
		const actions = DOM.append(header, $('span.vibe-ai-tool-card-actions'));
		if (onOpenFile) {
			const openBtn = DOM.append(actions, $('button.codicon.codicon-go-to-file.vibe-ai-icon-btn')) as HTMLButtonElement;
			openBtn.title = localize('vibeAIChat.tool.openFile', "Open file");
			DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, e => {
				e.stopPropagation(); // header click must not double-fire the open
				const path = argPath(name, args);
				if (path) {
					const range = headerJumpRange(name, args, this.read, this.firstChangeLine);
					onOpenFile(path, range?.start, range?.end);
				}
			});
		}

		// --- streaming write section (shown while write_file content arrives)
		this.streamSection = DOM.append(this.element, $('.vibe-ai-tool-card-stream'));
		this.streamSection.style.display = 'none';
		const streamLabel = DOM.append(this.streamSection, $('div.vibe-ai-tool-card-stream-label'));
		streamLabel.textContent = localize('vibeAIChat.tool.generating', "Generating…");
		this.streamPre = DOM.append(this.streamSection, $('pre.vibe-ai-tool-card-stream-pre'));

		// --- terminal output section (shown once a run_terminal result
		//     arrives; the children are rebuilt by setResult)
		this.outputSection = DOM.append(this.element, $('.vibe-ai-tool-card-output'));
		this.outputSection.style.display = 'none';

		// --- diff section (shown once a file change result arrives)
		this.diffSection = DOM.append(this.element, $('.vibe-ai-tool-card-diff'));
		this.diffSection.style.display = 'none';
		this.restoreButton = undefined;

		// restore action (only meaningful once the result arrives)
		this.appendRestoreAction(actions);
	}

	/** Detaches card-level listeners (called by the pane on removal). */
	dispose(): void {
		this.disposables.dispose();
	}

	/**
	 * Persistable snapshot of this card (Phase 45: lossless history
	 * restore) — the call identity plus everything setResult recorded.
	 */
	snapshot(): IVibeAIPersistedToolCall {
		return {
			name: this.name,
			args: this.args,
			status: this.status,
			result: this.result,
			output: this.output,
			codeChange: this.change,
			read: this.read,
			streamText: this.streamText,
		};
	}

	private readonly disposables = new DisposableStore();

	private appendRestoreAction(actions: HTMLElement): void {
		const restoreButton = DOM.append(actions, $('button.codicon.codicon-discard.vibe-ai-icon-btn')) as HTMLButtonElement;
		restoreButton.title = localize('vibeAIChat.tool.restoreTitle', "Restore the file to its pre-change content");
		restoreButton.style.display = 'none'; // shown by setResult when restorable
		this.disposables.add(DOM.addDisposableListener(restoreButton, DOM.EventType.CLICK, e => {
			e.stopPropagation(); // header click must not double-fire
			if (this.restoring || this.restored || !this.change) {
				return;
			}
			this.restoring = true;
			restoreButton.disabled = true;
			this.onRestore(this.change).then(ok => {
				this.restoring = false;
				if (ok) {
					this.restored = true;
					restoreButton.classList.add('disabled');
					restoreButton.title = localize('vibeAIChat.tool.restored', "Restored");
				} else {
					restoreButton.disabled = false;
				}
			});
		}));
		this.restoreButton = restoreButton;
	}

	/** Live content of a streaming write_file, appended on every `file_delta`. */
	appendStreamText(text: string): void {
		if (text.length === 0) {
			return;
		}
		this.streamSection.style.display = 'block';
		this.streamText = (this.streamText ?? '') + text;
		this.streamPre.textContent = this.streamText;
		this.streamPre.scrollTop = this.streamPre.scrollHeight;
	}

	/** Finalizes the card: status icon, output preview and diff preview. */
	setResult(status: string | undefined, summary: string | undefined, change: IVibeAICodeChange | undefined, output?: string, read?: IVibeAIReadRange): void {
		this.status = status;
		this.result = summary;
		this.change = change;
		this.output = output;
		this.read = read;
		this.streamSection.style.display = 'none';
		// Phase 63: read_file results carry the ACTUAL line range read (args
		// may omit the range; a symbol read resolves its own range) — replace
		// the args summary with the resolved "x.py L10-L20".
		if (read && this.name === 'read_file') {
			this.updateArgsSummaryWithRead(read);
		}
		// Terminal output preview (Phase 58): collapsed to 5 lines with the
		// same Show all / Collapse toggle as the diff preview. Shown for both
		// success and error statuses — a traceback is the interesting part.
		this.renderOutput(output);
		if (status === 'error') {
			this.headerStatus.classList.remove('codicon-loading');
			this.headerStatus.classList.add('codicon-error');
			this.headerStatus.style.color = 'var(--vscode-charts-red)';
			return;
		}
		this.headerStatus.classList.remove('codicon-loading');
		this.headerStatus.classList.add('codicon-check');
		this.headerStatus.style.color = 'var(--vscode-charts-green)';
		if (change) {
			this.renderDiff(change);
		}
	}

	/**
	 * Phase 58: collapsible output preview for run_terminal results —
	 * collapsed to 5 lines (80px) with the same Show all / Collapse
	 * toggle as the diff preview (expanded: 24 scrollable lines).
	 */
	/** Phase 63: replaces the args summary with the actual line range read. */
	private updateArgsSummaryWithRead(read: IVibeAIReadRange): void {
		const record = (this.args && typeof this.args === 'object') ? this.args as Record<string, unknown> : {};
		const path = String(record['path'] ?? '.');
		const parts: string[] = [];
		if (read.symbol) {
			parts.push(read.symbol);
		}
		parts.push(`L${read.start}–L${read.end}`);
		const text = `${path} ${parts.join(' ')}`;
		this.argsSummary.textContent = text;
		this.argsSummary.title = text;
	}

	private renderOutput(output: string | undefined): void {
		// A repeated setResult replaces the previous render.
		DOM.clearNode(this.outputSection);
		const text = (output ?? '').replace(/\s+$/, '');
		if (text.length === 0) {
			this.outputSection.style.display = 'none';
			return;
		}
		const label = DOM.append(this.outputSection, $('div.vibe-ai-tool-card-output-label'));
		label.textContent = localize('vibeAIChat.tool.output', "Output");
		const pre = DOM.append(this.outputSection, $('pre.vibe-ai-tool-card-output-pre'));
		pre.textContent = text;
		const lines = text.split('\n').length;
		if (lines > COLLAPSED_OUTPUT_LINES) {
			this.appendOutputToggle(this.outputSection, pre, lines);
		}
		this.outputSection.style.display = 'block';
	}

	private appendOutputToggle(section: HTMLElement, body: HTMLElement, lines: number): void {
		const toggle = DOM.append(section, $('button.vibe-ai-tool-card-expand')) as HTMLButtonElement;
		toggle.textContent = localize('vibeAIChat.tool.expandOutput', "Show all {0} lines", lines);
		let expanded = false;
		this.disposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			expanded = !expanded;
			// Same 5 → 24 row behavior as the diff preview (Phase 58).
			body.style.maxHeight = expanded ? `${EXPANDED_DIFF_BODY_HEIGHT}px` : `${MAX_DIFF_BODY_HEIGHT}px`;
			toggle.textContent = expanded
				? localize('vibeAIChat.tool.collapse', "Collapse")
				: localize('vibeAIChat.tool.expandOutput', "Show all {0} lines", lines);
		}));
	}

	private renderDiff(change: IVibeAICodeChange): void {
		// --- diff header: path + action + stats
		const header = DOM.append(this.diffSection, $('div.vibe-ai-tool-card-diff-header'));

		const filePath = DOM.append(header, $('span.vibe-ai-tool-card-path'));
		filePath.textContent = change.filePath;
		filePath.title = change.filePath;

		if (change.action) {
			const action = DOM.append(header, $('span.vibe-ai-tool-card-action'));
			action.textContent = change.action === 'create'
				? localize('vibeAIChat.tool.created', "new")
				: change.action === 'delete'
					? localize('vibeAIChat.tool.deletedAction', "deleted")
					: localize('vibeAIChat.tool.modified', "modified");
			action.style.opacity = '0.6';
			action.style.flexShrink = '0';
		}

		if (change.action === 'delete') {
			const note = DOM.append(this.diffSection, $('p.vibe-ai-tool-card-note'));
			note.textContent = localize('vibeAIChat.tool.deletedNote', "File deleted from disk.");
			note.style.color = 'var(--vscode-charts-red)';
			this.diffSection.style.display = 'block';
			return;
		}

		// Phase 65: first changed line in the NEW file — a header click on a
		// write card opens the editor at this line.
		if (change.newContent !== undefined) {
			this.firstChangeLine = computeDiffLines(change.oldContent ?? '', change.newContent)
				.find(line => line.type !== 'same')?.newLine;
		}

		// --- restore action (only for updates with known pre-change content)
		if (change.oldContent !== undefined && change.oldContent !== null && this.restoreButton) {
			this.restoreButton.style.display = 'flex';
		}

		if (change.newContent !== undefined) {
			// --- +N −M stats
			const stats = computeDiffStats(change.oldContent ?? '', change.newContent);
			if (stats.additions > 0 || stats.deletions > 0) {
				this.appendStatsBadge(header, stats);
			}

			// --- inline red/green preview (collapsed to 5 rows, Cursor-style;
			//     the toggle grows it to 24 scrollable rows)
			const body = DOM.append(this.diffSection, $('div.vibe-ai-tool-card-diff-body'));
			const changed = renderDiffBody(body, change.oldContent ?? '', change.newContent, this.languageService, this.languageIdFor(change.filePath));
			// Row count (diff rows + "⋯" separators), not just the changed
			// count — a context-heavy small edit still clips at the cap.
			if (body.childElementCount > COLLAPSED_DIFF_LINES) {
				this.appendExpandToggle(body, changed);
			}
		}

		this.diffSection.style.display = 'block';
	}

	/** Maps a file path to a tokenization language id (plaintext fallback). */
	private languageIdFor(filePath: string): string {
		try {
			return this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(filePath.replace(/\\/g, '/')))
				?? PLAINTEXT_LANGUAGE_ID;
		} catch {
			return PLAINTEXT_LANGUAGE_ID;
		}
	}

	private appendStatsBadge(header: HTMLElement, stats: { additions: number; deletions: number }): void {
		const badge = DOM.append(header, $('span.vibe-ai-tool-card-stats'));
		if (stats.additions > 0) {
			const added = DOM.append(badge, $('span'));
			added.textContent = `+${stats.additions}`;
			added.style.color = 'var(--vscode-charts-green)';
		}
		if (stats.additions > 0 && stats.deletions > 0) {
			DOM.append(badge, $('span')).textContent = ' ';
		}
		if (stats.deletions > 0) {
			const removed = DOM.append(badge, $('span'));
			removed.textContent = `-${stats.deletions}`;
			removed.style.color = 'var(--vscode-charts-red)';
		}
	}

	private appendExpandToggle(body: HTMLElement, changed: number): void {
		const toggle = DOM.append(this.diffSection, $('button.vibe-ai-tool-card-expand')) as HTMLButtonElement;
		toggle.textContent = localize('vibeAIChat.tool.expand', "Show all {0} changed lines", changed);
		let expanded = false;
		this.disposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			expanded = !expanded;
			// Expand grows the preview to 24 scrollable rows (not unlimited
			// — the card stays a card instead of swallowing the thread).
			body.style.maxHeight = expanded ? `${EXPANDED_DIFF_BODY_HEIGHT}px` : `${MAX_DIFF_BODY_HEIGHT}px`;
			toggle.textContent = expanded
				? localize('vibeAIChat.tool.collapse', "Collapse")
				: localize('vibeAIChat.tool.expand', "Show all {0} changed lines", changed);
		}));
	}
}

// Unique policy name — 'tokenizeToString' is owned by the editor's
// EditorMarkdownCodeBlockRenderer (src/vs/editor/browser/widget/
// markdownRenderer/browser/editorMarkdownCodeBlockRenderer.ts). Chrome
// throws on a second createPolicy with the same name and
// createTrustedTypesPolicy then returns undefined, which used to break
// the editor's code-block swap with "This document requires
// 'TrustedHTML' assignment" — fenced code blocks stayed as raw inline
// text (the wall-of-text bug).
const ttpTokenizer = createTrustedTypesPolicy('vibeAIToolCardTokenizer', {
	createHTML(html: string) {
		return html;
	}
});

/**
 * `tokenizeToStringSync` returns HTML wrapped in
 * `<div class="monaco-tokenized-source">…</div>`. Diff rows render per-line
 * into an inline `<span>`, so the wrapper is stripped and only the inner
 * `<span class="mtkN">` token spans are kept (same pattern as the fork's
 * mobile diff helpers).
 */
function stripTokenizedWrapper(html: string): string {
	const openTag = '<div class="monaco-tokenized-source">';
	const closeTag = '</div>';
	if (html.startsWith(openTag) && html.endsWith(closeTag)) {
		return html.substring(openTag.length, html.length - closeTag.length);
	}
	return html;
}

/** Tokenizes one diff line for theme-matched syntax highlighting. */
function highlightLine(languageService: ILanguageService, text: string, languageId: string): string {
	try {
		const html = tokenizeToStringSync(languageService, text, languageId);
		const inner = stripTokenizedWrapper(html);
		return (ttpTokenizer ? ttpTokenizer.createHTML(inner) ?? inner : inner) as string;
	} catch {
		return '';
	}
}

function renderDiffBody(container: HTMLElement, original: string, updated: string, languageService: ILanguageService, languageId: string): number {
	const lines = computeDiffLines(original, updated);
	let changed = 0;
	for (const line of lines) {
		if (line.type !== 'same') {
			changed++;
		}
	}

	let i = 0;
	while (i < lines.length) {
		if (lines[i].type === 'same') {
			let run = 0;
			while (i + run < lines.length && lines[i + run].type === 'same') {
				run++;
			}
			// Compress long unchanged runs between changes (Cursor-style "⋯").
			if (i > 0 && i + run < lines.length && run > COMPRESSED_UNCHANGED_RUN) {
				appendDiffRow(container, lines[i], languageService, languageId);
				appendDiffRow(container, lines[i + 1], languageService, languageId);
				const separator = DOM.append(container, $('div.vibe-ai-diff-separator'));
				separator.textContent = localize('vibeAIChat.tool.unchanged', "⋯ {0} unchanged lines ⋯", run - COMPRESSED_UNCHANGED_RUN);
				i += run - 2;
				continue;
			}
			for (let k = 0; k < run; k++) {
				appendDiffRow(container, lines[i + k], languageService, languageId);
			}
			i += run;
			continue;
		}
		appendDiffRow(container, lines[i], languageService, languageId);
		i++;
	}
	return changed;
}

function appendDiffRow(container: HTMLElement, line: IVibeAIDiffLine, languageService: ILanguageService, languageId: string): void {
	const row = DOM.append(container, $('div.vibe-ai-diff-line'));
	row.classList.add(line.type);

	// gutter (+ / −)
	const gutter = DOM.append(row, $('span.diff-gutter'));
	gutter.style.userSelect = 'none';
	if (line.type === 'add') {
		gutter.textContent = '+';
	} else if (line.type === 'del') {
		gutter.textContent = '−';
	} else {
		gutter.textContent = ' ';
	}

	// line number (Cursor-parity: dimmed, right-aligned)
	const lineNo = DOM.append(row, $('span.diff-line-no'));
	lineNo.style.userSelect = 'none';
	lineNo.textContent = String(line.type === 'add' ? line.newLine ?? '' : line.oldLine ?? '');

	// syntax-highlighted text (token spans styled by the workbench theme)
	const text = DOM.append(row, $('span.diff-text'));
	text.innerHTML = highlightLine(languageService, line.text, languageId);
	if (line.type === 'same') {
		text.style.opacity = '0.55';
	}
}


