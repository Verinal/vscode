/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { timeout } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
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
/**
 * Safety cap for diff-line tokenization (Phase 87): tokenizing a huge
 * full-file rewrite would block the renderer — beyond this many source
 * lines the rows keep the plain text (the red/green backgrounds, gutter
 * and line numbers are unaffected).
 */
const MAX_TOKENIZE_LINES = 5000;
/** Retries this often (ms) for the diff rows' language tokenizer (Phase 94). */
const TOKENIZATION_RETRY_DELAY_MS = 1000;
/** Gives up after this many retries — a language with no grammar keeps rendering plain. */
const TOKENIZATION_RETRY_ATTEMPTS = 30;

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
 * The raw path argument of a file tool — the header click opens this
 * (the display summary may be a bare name or carry a line-range suffix).
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

/**
 * Phase 135: last path segment for the card header — the header shows the
 * bare file name instead of the relative path (the full path stays in the
 * tooltip).
 */
function baseName(path: string): string {
	const segments = path.replace(/\\/g, '/').split('/').filter(segment => segment.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * Phase 148: mutating tool cards keep their body after completion — the
 * write diff / command output stay visible (the pre-141 inline agreement,
 * user request); read-only scan cards fold to the one-line summary row.
 * Mirrors the pane's `isMutatingTool` — kept local because the pane
 * imports this module (importing back would be a cycle).
 */
function isMutatingTool(name: string): boolean {
	return name === 'write_file' || name === 'delete_file' || name === 'run_terminal';
}

function summarizeArgs(name: string, args: unknown): string {
	if (args && typeof args === 'object') {
		const record = args as Record<string, unknown>;
		if (name === 'run_terminal') {
			// Phase 136: the command moved into the output area (shown in
			// full there) — the header line no longer repeats it.
			return '';
		}
		if (name === 'read_file' || name === 'write_file' || name === 'list_files' || name === 'delete_file') {
			const path = String(record['path'] ?? '.');
			if (name === 'read_file') {
				// Phase 63/135: bare file name + "L10–L20" / symbol — the full
				// relative path stays in the tooltip.
				const range = describeReadArgs(record);
				return range.length > 0 ? `${baseName(path)} ${range}` : baseName(path);
			}
			if (name === 'write_file') {
				// Phase 135: bare file name — the diff header path line is gone.
				return baseName(path);
			}
			return path;
		}
		if (name === 'search_codebase') {
			return String(record['query'] ?? '');
		}
		if (name === 'grep') {
			const pattern = String(record['pattern'] ?? '');
			const scope = String(record['path'] ?? '');
			// Phase 135: scope shows only its last segment (`backend/app` → `app`).
			return scope.length > 0 ? `${pattern} · ${baseName(scope)}` : pattern;
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
 * numbers and theme-matched syntax highlighting; the header carries the
 * bare file name with the new/modified badge and `+N −M` stats, a click
 * on it opens the file, and the hover actions hold the restore button.
 * Phase 141: the card itself is a <details> whose header row is the
 * <summary> — setResult folds a completed card to its one-line summary
 * row (the chevron/header re-opens it — open-file cards open the editor
 * at the exact range instead, Phase 65/135 affordance kept).
 * Phase 148 (Phase 141 reversed for mutating tools, user request):
 * write_file / delete_file / run_terminal cards KEEP their body after
 * completion — the red/green diff and the command output are the result
 * the user reads right on the card (the pre-141 inline agreement); only
 * read-only scan cards fold to the one-line row.
 */
export class VibeAIToolCard {

	readonly element: HTMLElement;

	private readonly headerStatus: HTMLElement;
	private readonly argsSummary: HTMLElement;
	// Phase 135: kept as fields — renderDiff inserts the action badge and the
	// +N −M stats onto the header, before the hover actions span.
	private readonly headerEl: HTMLElement;
	private readonly actionsEl: HTMLElement;
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
	/** Phase 149: display-only widened range (same-file read merge) — the
	 * recorded read (snapshot) keeps the call's own resolved range. */
	private widenedRead: IVibeAIReadRange | undefined;
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
		// Phase 141: the card is a <details> — its header row is the
		// <summary> (the native toggle replaces the old static header).
		// Pending is expanded (the streaming body is the point); setResult
		// folds read-only cards to the one-line summary (Phase 148:
		// mutating cards keep their body — the diff/output IS the result).
		this.element = $('details.vibe-ai-tool-card');
		(this.element as HTMLDetailsElement).open = true;

		// --- header (the <summary> row)
		const header = DOM.append(this.element, $('summary.vibe-ai-tool-card-header'));
		this.headerEl = header;

		this.headerStatus = DOM.append(header, $('span.codicon.codicon-loading.vibe-ai-tool-card-status'));
		this.headerStatus.setAttribute('aria-hidden', 'true');

		const icon = DOM.append(header, $(`span.codicon.${TOOL_ICONS[name] ?? 'codicon-symbol-file'}.vibe-ai-tool-card-icon`));
		icon.setAttribute('aria-hidden', 'true');

		const label = DOM.append(header, $('span.vibe-ai-tool-card-label'));
		label.textContent = TOOL_LABELS[name] ?? name;

		this.argsSummary = DOM.append(header, $('span.vibe-ai-tool-card-args'));
		this.argsSummary.textContent = summarizeArgs(name, args);
		this.argsSummary.title = summarizeArgs(name, args);

		// Phase 65/135: clicking the header (the bare file name) opens the
		// file — read cards jump to the read range, write cards to the first
		// changed line (Cursor parity). The hover open-file button is gone —
		// this click is the open affordance now.
		if (onOpenFile && (name === 'read_file' || name === 'write_file') && argPath(name, args)) {
			header.classList.add('vibe-ai-clickable');
			header.title = localize('vibeAIChat.tool.openHeader', "Open in editor");
			this.disposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, e => {
				// Phase 141: the header is the <summary> — opening the file
				// must not ALSO toggle the card body (preventDefault stops
				// the native details toggle; stopPropagation mirrors the
				// restore button's pattern). Open-file cards keep the Phase
				// 65/135 semantics: the click opens the editor at the exact
				// range instead of expanding the inline body.
				e.preventDefault();
				e.stopPropagation();
				const path = argPath(name, args);
				if (!path) {
					return;
				}
				const range = headerJumpRange(name, args, this.displayRead, this.firstChangeLine);
				onOpenFile(path, range?.start, range?.end);
			}));
		}

		// --- hover actions (restore only — Phase 135 removed the open-file
		//     hover button; clicking the header opens the file instead)
		const actions = DOM.append(header, $('span.vibe-ai-tool-card-actions'));
		this.actionsEl = actions;

		// Phase 141: the collapse chevron (Cursor parity, the same
		// affordance as the Worked shell) — rotates 90deg while the body
		// is expanded, points right on the folded one-line row.
		const chevron = DOM.append(header, $('span.codicon.codicon-chevron-right.vibe-ai-tool-card-chevron'));
		chevron.setAttribute('aria-hidden', 'true');

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
		if (name === 'run_terminal') {
			// Phase 136: the command is the first line of the output area —
			// shown in full as soon as the card is created (the header no
			// longer carries it).
			this.renderOutput(undefined);
		}

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

	/**
	 * Phase 149: the display range for the same-file read merge — the
	 * widened union set by the Worked grouping, falling back to this
	 * call's own resolved range (the snapshot keeps recording the call's
	 * own range; the union is display-only, the header jump follows it).
	 */
	get displayRead(): IVibeAIReadRange | undefined {
		return this.widenedRead ?? this.read;
	}

	/** Phase 149: widens the displayed read range (same-file read merge). */
	widenReadRange(range: IVibeAIReadRange): void {
		if (range.end < range.start) {
			return;
		}
		this.widenedRead = range;
		if (this.name === 'read_file') {
			this.updateArgsSummaryWithRead(range);
		}
	}

	private readonly disposables = new DisposableStore();

	private appendRestoreAction(actions: HTMLElement): void {
		const restoreButton = DOM.append(actions, $('button.codicon.codicon-discard.vibe-ai-icon-btn')) as HTMLButtonElement;
		restoreButton.title = localize('vibeAIChat.tool.restoreTitle', "Restore the file to its pre-change content");
		restoreButton.style.display = 'none'; // shown by setResult when restorable
		this.disposables.add(DOM.addDisposableListener(restoreButton, DOM.EventType.CLICK, e => {
			e.stopPropagation(); // header click must not double-fire
			e.preventDefault(); // Phase 141: a click inside the <summary> must not toggle the card
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
		// Phase 141: the card finalized — read-only cards fold to their
		// one-line summary row (the chevron/header re-opens them, and
		// open-file cards open the editor at the exact range instead).
		// Phase 148: mutating cards (write_file / delete_file /
		// run_terminal) KEEP the body — the red/green diff and the command
		// output are the result the user reads right here (the pre-141
		// inline agreement). Restored cards run setResult on construction
		// too, so restored history renders isomorphic with the live view
		// (mutating cards expanded, read-only cards one-line; zero wiring).
		if (!isMutatingTool(this.name)) {
			(this.element as HTMLDetailsElement).open = false;
		}
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

	/** Phase 63: replaces the args summary with the actual line range read. */
	private updateArgsSummaryWithRead(read: IVibeAIReadRange): void {
		const record = (this.args && typeof this.args === 'object') ? this.args as Record<string, unknown> : {};
		// Phase 135: bare file name — the full relative path stays in the tooltip.
		const path = baseName(String(record['path'] ?? '.'));
		const parts: string[] = [];
		if (read.symbol) {
			parts.push(read.symbol);
		}
		parts.push(`L${read.start}–L${read.end}`);
		const text = `${path} ${parts.join(' ')}`;
		this.argsSummary.textContent = text;
		this.argsSummary.title = text;
	}

	/**
	 * Phase 58: collapsible output preview for run_terminal results —
	 * collapsed to 5 lines (80px) with the same Show all / Collapse
	 * toggle as the diff preview (expanded: 24 scrollable lines).
	 * Phase 136: the command itself is the first line of the output area
	 * (shown in full, no ellipsis); the "Output" label is gone.
	 */
	private renderOutput(output: string | undefined): void {
		// A repeated setResult replaces the previous render.
		DOM.clearNode(this.outputSection);
		const command = this.name === 'run_terminal' ? this.terminalCommand() : '';
		const text = (output ?? '').replace(/\s+$/, '');
		if (command.length === 0 && text.length === 0) {
			this.outputSection.style.display = 'none';
			return;
		}
		if (command.length > 0) {
			const cmd = DOM.append(this.outputSection, $('div.vibe-ai-tool-card-cmd'));
			cmd.textContent = command;
		}
		if (text.length > 0) {
			const pre = DOM.append(this.outputSection, $('pre.vibe-ai-tool-card-output-pre'));
			pre.textContent = text;
			const lines = text.split('\n').length;
			if (lines > COLLAPSED_OUTPUT_LINES) {
				this.appendOutputToggle(this.outputSection, pre, lines);
			}
		}
		this.outputSection.style.display = 'block';
	}

	/** Phase 136: the raw command argument of a run_terminal call. */
	private terminalCommand(): string {
		const record = (this.args && typeof this.args === 'object') ? this.args as Record<string, unknown> : {};
		return String(record['command'] ?? '');
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
		// Phase 135: the diff header line (path + action + stats) is gone —
		// the action badge and stats moved up onto the card header next to
		// the bare file name (one line per change, Cursor-style).
		if (change.action) {
			const action = $('span.vibe-ai-tool-card-action');
			action.textContent = change.action === 'create'
				? localize('vibeAIChat.tool.created', "new")
				: change.action === 'delete'
					? localize('vibeAIChat.tool.deletedAction', "deleted")
					: localize('vibeAIChat.tool.modified', "modified");
			action.style.opacity = '0.6';
			action.style.flexShrink = '0';
			this.headerEl.insertBefore(action, this.actionsEl);
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
			// --- +N −M stats (Phase 135: on the card header, after the badge)
			const stats = computeDiffStats(change.oldContent ?? '', change.newContent);
			if (stats.additions > 0 || stats.deletions > 0) {
				this.headerEl.insertBefore(this.appendStatsBadge(stats), this.actionsEl);
			}

			// --- inline red/green preview (collapsed to 5 rows, Cursor-style;
			//     the toggle grows it to 24 scrollable rows)
			const body = DOM.append(this.diffSection, $('div.vibe-ai-tool-card-diff-body'));
			const { changed, firstChangeRow, rows } = renderDiffBody(body, change.oldContent ?? '', change.newContent);
			// Row count (diff rows + "⋯" separators), not just the changed
			// count — a context-heavy small edit still clips at the cap.
			if (body.childElementCount > COLLAPSED_DIFF_LINES) {
				this.appendExpandToggle(body, changed, firstChangeRow?.span);
			}
			// Phase 87: theme-matched token colors fill in once the file's
			// language grammar is loaded — rows render plain text until then,
			// and the collapsed preview already starts at the changed region.
			// Phase 94: the language is resolved per retry attempt — during
			// the startup-restore window the registry has no language yet,
			// so a one-shot resolution here would give up immediately.
			void fillDiffTokenColors(
				rows,
				change.oldContent ?? '',
				change.newContent,
				this.languageService,
				() => this.languageGuessFor(change.filePath)
			);
		}

		this.diffSection.style.display = 'block';
	}

	/**
	 * Maps a file path to its tokenization language — the raw registry
	 * guess, null while the language itself is not registered yet (the
	 * startup-restore window). A genuinely plain-text file resolves
	 * 'plaintext' statically, so callers can tell the two apart.
	 */
	private languageGuessFor(filePath: string): string | null {
		try {
			return this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(filePath.replace(/\\/g, '/')));
		} catch {
			return null;
		}
	}

	private appendStatsBadge(stats: { additions: number; deletions: number }): HTMLElement {
		const badge = $('span.vibe-ai-tool-card-stats');
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
		return badge;
	}

	private appendExpandToggle(body: HTMLElement, changed: number, firstChangeRow: HTMLElement | undefined): void {
		const toggle = DOM.append(this.diffSection, $('button.vibe-ai-tool-card-expand')) as HTMLButtonElement;
		toggle.textContent = localize('vibeAIChat.tool.expand', "Show all {0} changed lines", changed);
		let expanded = false;
		this.disposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			expanded = !expanded;
			// Expand grows the preview to 24 scrollable rows (not unlimited
			// — the card stays a card instead of swallowing the thread).
			body.style.maxHeight = expanded ? `${EXPANDED_DIFF_BODY_HEIGHT}px` : `${MAX_DIFF_BODY_HEIGHT}px`;
			if (!expanded && firstChangeRow) {
				// Collapsing jumps back to the changed region instead of
				// leaving the preview wherever the expanded view was.
				scrollDiffBodyToRow(body, firstChangeRow);
			}
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
 * `_tokenizeToString` returns HTML wrapped in
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

/**
 * Tokenizes a whole text and returns the per-line HTML (one entry per
 * source line, in order). Phase 87: per-row tokenization used
 * `tokenizeToStringSync`, which returns the null tokenizer for any
 * language whose TextMate grammar has not been activated yet (no editor
 * has opened the file) — every diff row rendered uncolored. The async
 * `tokenizeToString` awaits `TokenizationRegistry.getOrCreate(languageId)`
 * so the real grammar is used. Tokenizing the whole text also keeps state
 * (open strings, template literals, block comments) correct across lines.
 * `_tokenizeToString` separates lines with `<br/>` and HTML-escapes the
 * text, so splitting on the literal yields ready-to-assign markup.
 */
async function tokenizeDiffLines(languageService: ILanguageService, text: string, languageId: string): Promise<string[]> {
	if (!text || text.split('\n').length > MAX_TOKENIZE_LINES) {
		return [];
	}
	try {
		const html = await tokenizeToString(languageService, text, languageId);
		// Phase 94: while the grammar is still missing, getOrCreate resolves
		// null and the output is the null-tokenizer fallback (default
		// foreground only). Tokenizing the same text with a null language
		// yields exactly that baseline — identical output means nothing is
		// colored yet, so the caller keeps retrying instead of filling the
		// rows with a visually unchanged swap.
		const baseline = await tokenizeToString(languageService, text, null);
		if (html === baseline) {
			return [];
		}
		const inner = stripTokenizedWrapper(html);
		return inner.split('<br/>');
	} catch {
		return [];
	}
}

/** One rendered diff row, kept for post-render token coloring + scrolling. */
interface IDiffRowTarget {
	/** The row's text span — filled with token HTML after tokenization. */
	readonly span: HTMLElement;
	readonly type: 'add' | 'del' | 'same';
	readonly oldLine?: number;
	readonly newLine?: number;
}

/**
 * Fills the rendered diff rows with theme-matched token spans (Phase 87).
 * Rows render plain text first; once the file's language grammar is loaded
 * each row's text span is swapped for the tokenized HTML — the markup is
 * pre-escaped by `_tokenizeToString`, so it is assigned as-is (wrapped in
 * the card's TrustedHTML policy like the old per-row path).
 *
 * Phase 94: the language registry and its TextMate grammars register with
 * the extension host after the pane re-renders restored conversations — a
 * restored card's one-shot pass resolved no language and every row stayed
 * default-colored (gray) forever. The language is re-resolved per attempt
 * (a genuinely plain-text file resolves 'plaintext' statically and stops);
 * each attempt's tokenizeToString awaits TokenizationRegistry.getOrCreate,
 * which also triggers a pending grammar factory load — a later attempt
 * usually lands the colored markup. Bounded: the retries stop on success,
 * error, the attempt cap, or when the rows left the document (re-render /
 * dispose) — a language with no grammar keeps rendering plain.
 */
async function fillDiffTokenColors(rows: readonly IDiffRowTarget[], original: string, updated: string, languageService: ILanguageService, resolveLanguageId: () => string | null): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	for (let attempt = 1; attempt <= TOKENIZATION_RETRY_ATTEMPTS; attempt++) {
		// Re-resolved per attempt: during the restore window the guess for a
		// code file returns null (the language itself is not registered yet).
		const languageId = resolveLanguageId();
		if (languageId === PLAINTEXT_LANGUAGE_ID) {
			return; // genuinely plain text — nothing to color
		}
		if (languageId !== null) {
			const [oldTokens, newTokens] = await Promise.all([
				tokenizeDiffLines(languageService, original, languageId),
				tokenizeDiffLines(languageService, updated, languageId),
			]);
			if (oldTokens.length > 0 || newTokens.length > 0) {
				for (const row of rows) {
					const tokens = row.type === 'del' ? oldTokens : newTokens;
					const index = ((row.type === 'del' ? row.oldLine : row.newLine) ?? 0) - 1;
					const html = index >= 0 && index < tokens.length ? tokens[index] : undefined;
					if (html !== undefined && html.length > 0) {
						row.span.innerHTML = (ttpTokenizer ? ttpTokenizer.createHTML(html) ?? html : html) as string;
					}
				}
				return;
			}
		}
		// Not tokenizable yet (language or grammar not registered — the
		// startup-restore window). The next attempt's tokenizeToString
		// bootstraps the pending registrations, so wait and re-resolve.
		if (!rows[0].span.isConnected) {
			return; // the card was re-rendered — these rows are gone
		}
		await timeout(TOKENIZATION_RETRY_DELAY_MS);
	}
}

/**
 * Scrolls a diff body so a row (measured by its text span) is in view —
 * used when the expanded preview collapses back down (Phase 87).
 */
function scrollDiffBodyToRow(body: HTMLElement, row: HTMLElement): void {
	if (body.getBoundingClientRect().height === 0) {
		// Not laid out (hidden card) — nothing to scroll.
		return;
	}
	// Keep ~2 context rows visible above the change instead of snapping it
	// to the very top edge; the browser clamps the result into range.
	const delta = row.getBoundingClientRect().top - body.getBoundingClientRect().top - 32;
	if (Math.abs(delta) > 2) {
		body.scrollTop += delta;
	}
}

function renderDiffBody(container: HTMLElement, original: string, updated: string): { changed: number; firstChangeRow: IDiffRowTarget | undefined; rows: IDiffRowTarget[] } {
	const lines = computeDiffLines(original, updated);
	let changed = 0;
	for (const line of lines) {
		if (line.type !== 'same') {
			changed++;
		}
	}

	const rows: IDiffRowTarget[] = [];
	let firstChangeRow: IDiffRowTarget | undefined;
	const pushRow = (line: IVibeAIDiffLine): void => {
		const row = appendDiffRow(container, line);
		rows.push(row);
		if (!firstChangeRow && line.type !== 'same') {
			firstChangeRow = row;
		}
	};
	const pushSeparator = (omitted: number): void => {
		const separator = DOM.append(container, $('div.vibe-ai-diff-separator'));
		separator.textContent = localize('vibeAIChat.tool.unchanged', "⋯ {0} unchanged lines ⋯", omitted);
	};

	let i = 0;
	while (i < lines.length) {
		if (lines[i].type === 'same') {
			let run = 0;
			while (i + run < lines.length && lines[i + run].type === 'same') {
				run++;
			}
			// Compress long unchanged runs (Cursor-style "⋯") — Phase 87:
			// leading and trailing runs keep 2 context lines toward the
			// change so the collapsed preview starts at the changed region
			// instead of the file head; middle runs keep 2 on each side.
			if (run > COMPRESSED_UNCHANGED_RUN && !(i === 0 && i + run === lines.length)) {
				if (i === 0) {
					pushSeparator(run - 2);
					pushRow(lines[i + run - 2]);
					pushRow(lines[i + run - 1]);
				} else if (i + run === lines.length) {
					pushRow(lines[i]);
					pushRow(lines[i + 1]);
					pushSeparator(run - 2);
				} else {
					pushRow(lines[i]);
					pushRow(lines[i + 1]);
					pushSeparator(run - COMPRESSED_UNCHANGED_RUN);
					pushRow(lines[i + run - 2]);
					pushRow(lines[i + run - 1]);
				}
			} else {
				for (let k = 0; k < run; k++) {
					pushRow(lines[i + k]);
				}
			}
			i += run;
			continue;
		}
		pushRow(lines[i]);
		i++;
	}
	return { changed, firstChangeRow, rows };
}

function appendDiffRow(container: HTMLElement, line: IVibeAIDiffLine): IDiffRowTarget {
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

	// Plain text first — theme-matched token spans fill in once the file's
	// language grammar is loaded (fillDiffTokenColors, Phase 87). The old
	// per-row path tokenized with `tokenizeToStringSync`, which used the
	// null tokenizer for languages whose grammar was not yet activated and
	// broke multi-line token state.
	const text = DOM.append(row, $('span.diff-text'));
	text.textContent = line.text;
	if (line.type === 'same') {
		text.style.opacity = '0.55';
	}
	return { span: text, type: line.type, oldLine: line.oldLine, newLine: line.newLine };
}


