/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor-parity editor change highlighting (Phase 57): after an agent
 * write lands, the modified places are highlighted inside the open editor
 * with the same colors as the chat's diff cards — whole-line green for
 * added lines, red rows (view zones) for deleted lines — and the first
 * change is revealed.
 *
 * The backend writes the file to disk and the `tool_result` SSE event
 * arrives right after, but an already-open editor's model reloads
 * asynchronously (file watcher) and a not-yet-open editor appears later.
 * Both are handled by re-probing `listCodeEditors` until the model content
 * matches the write's new content (EOL-insensitive — the backend writes
 * `\r\n` on Windows while the new content is `\n`; see `normalizeEol`) —
 * a dirty user buffer never matches, so it is never decorated. Any editor
 * that appears later (Explorer open included) re-probes pending writes via
 * `onCodeEditorAdd`. A highlight persists until the same file is written
 * again or the pane closes; opening the file from the chat (tool card,
 * Review, files list) re-applies the stored highlight.
 *
 * Phase 95: while a file's overlay is up, an always-visible keep-bar
 * overlay widget is pinned to the top of the editor viewport ("Keep
 * changes to x.py?" + Keep / Discard — a view zone above line 1 scrolled
 * away with the content, so pointing at a change left no choice on
 * screen). Keep resolves the overlay — the green additions ARE the kept
 * on-disk content and the red deleted rows disappear — and the pane
 * marks the file resolved in its turn record; Discard reverts the file
 * on disk first (and re-arms the bar when the revert fails). Resolved
 * overlays never resurrect: the pane skips resolved changes when
 * re-arming from a restored session.
 *
 * Phase 95 follow-up (user feedback): a resolved bar STAYS up — only its
 * Keep / Discard buttons go (a status chip shows the outcome, Kept /
 * Discarded) while the red/green marks clear; the chip lives until the
 * file is written again, the model navigates away or the pane closes.
 *
 * Phase 95 follow-up ② (user feedback): the bar moves INTO the file path
 * row — the breadcrumbs row under the editor tabs, pinned to the row's
 * right edge (path label left, Keep / Discard right, layout unchanged;
 * it used to float over the first content lines). The editor's overlay
 * layer is clipped to the content area (overflow-guard), so no overlay
 * position can ever reach the path row: the bar attaches to the workbench
 * breadcrumb row instead and is cleared together with its highlight.
 * Breadcrumbs hidden or disabled → top-right overlay widget fallback.
 *
 * Phase 95 follow-up ③ (user feedback): a freshly created file opened
 * from the Explorer stayed unhighlighted (no green, no keep-bar). VS Code
 * reuses ONE code editor widget per text-editor pane — opening another
 * file swaps the model without a new editor, so `onCodeEditorAdd` never
 * fires again and the write's poll (~10s) is long dead by the time the
 * user opens the file. Every wired editor now re-probes pending writes
 * on model switches (Explorer opens included) and content reloads (a
 * file-watcher load lagging past the poll).
 *
 * Phase 110 (user feedback): the highlight ACCUMULATES a turn's writes —
 * the registered change is the turn's consolidated entry (the pre-turn
 * baseline vs the current content), so a file written several times in
 * one turn keeps every earlier write's lines green (a file created this
 * turn is all green) and additions cancel out against later deletes;
 * the per-step diff stays in the step's own chat card.
 */

import { $, append } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor, IOverlayWidget, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration } from '../../../../editor/common/model.js';
import { IVibeAICodeChange } from '../../../../platform/vibeAI/common/vibeAI.js';
import { computeDiffLines, normalizeEol } from './vibeAIDiff.js';
import './media/vibeAIChat.css';

const RETRY_INTERVAL_MS = 250;
/** ~10s of retries — covers the file-watcher reload and a chat-driven open. */
const RETRY_LIMIT = 40;
/**
 * Safety cap: a huge full-file rewrite skips the editor overlay (the chat's
 * diff card still shows it) instead of dropping a thousand decorations.
 */
const MAX_HIGHLIGHT_LINES = 1000;

/** One applied editor highlight (per file URI): its decorations + zones. */
interface IVibeAIEditorHighlight {
	readonly change: IVibeAICodeChange;
	readonly collection: IEditorDecorationsCollection;
	readonly zoneIds: string[];
	/**
	 * Phase 95: the keep-bar overlay widget (the breadcrumbs-hidden
	 * fallback) — removed together with the overlay when the change
	 * resolves.
	 */
	readonly barWidgets: IOverlayWidget[];
	/**
	 * Phase 95 (user feedback ②): keep-bars attached to the file path row
	 * are plain DOM (the overlay layer can't reach the path row) — they
	 * are cleared with the highlight too.
	 */
	readonly barDomNodes: HTMLElement[];
	/**
	 * Phase 95 follow-up (user feedback): per-bar resolve — the bar STAYS
	 * up after a keep/discard (only the buttons go, a status chip shows
	 * the outcome), so its resolve hook is kept alongside the widget.
	 */
	readonly barResolvers: ((state: 'kept' | 'discarded') => void)[];
	/** Phase 95 follow-up: the bar's resolved state (idempotency guard). */
	barState?: 'kept' | 'discarded';
	readonly modelListener: IDisposable | undefined;
}

/**
 * Phase 95: per-file review handlers wired by the chat pane — the
 * keep-bar's Keep / Discard land there (keep marks the file resolved in
 * its turn record; discard reverts the file on disk first and returns
 * false when the revert failed so the bar stays up for a retry).
 */
export interface IVibeAIFileReviewHandlers {
	keepFile: (change: IVibeAICodeChange) => void;
	discardFile: (change: IVibeAICodeChange) => Promise<boolean> | boolean;
}

export class VibeAIEditorHighlighter extends Disposable {

	private disposed = false;
	/** Latest live write per file URI — re-applied when the file opens from the chat. */
	private readonly pending = new Map<string, IVibeAICodeChange>();
	private readonly applied = new Map<string, IVibeAIEditorHighlight>();
	private readonly polling = new Set<string>();
	private readonly timers = new Set<number>();
	/** Editors already wired for re-probing (one code editor per text-editor pane). */
	private readonly wiredEditors = new WeakSet<ICodeEditor>();
	/** Phase 95: the pane's per-file review handlers (keep-bar actions). */
	private fileActions: IVibeAIFileReviewHandlers | undefined;

	constructor(private readonly codeEditorService: ICodeEditorService) {
		super();
		// A file opened from the Explorer (not the chat) creates its editor
		// after the write landed — re-probe pending writes whenever any code
		// editor appears so the red/green overlay is not limited to
		// chat-driven opens. `schedule` re-runs the content-match probe and
		// no-ops when a poll is already chasing the file.
		this._register(this.codeEditorService.onCodeEditorAdd(editor => {
			this.wireEditor(editor);
			if (this.disposed || this.pending.size === 0) {
				return;
			}
			for (const key of Array.from(this.pending.keys())) {
				this.schedule(key);
			}
		}));
		// Editors that exist already (restored tabs) never fire the add
		// event again — wire them too.
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.wireEditor(editor);
		}
	}

	/**
	 * Phase 95 (user feedback ③): a freshly created file opened from the
	 * Explorer stayed unhighlighted (no green, no keep-bar). VS Code reuses
	 * ONE code editor widget per text-editor pane — opening another file
	 * swaps the model without a new editor, so `onCodeEditorAdd` never fires
	 * again and the write's poll (~10s) is long dead by the time the user
	 * opens the file. Re-probe pending writes on model switches (Explorer
	 * opens included) and on content changes (a file-watcher load lagging
	 * past the poll) so the overlay can never be missed.
	 */
	private wireEditor(editor: ICodeEditor): void {
		if (this.wiredEditors.has(editor)) {
			return;
		}
		this.wiredEditors.add(editor);
		this._register(editor.onDidChangeModel(() => this.reprobePending()));
		this._register(editor.onDidChangeModelContent(() => this.reprobePending()));
	}

	private reprobePending(): void {
		if (this.disposed || this.pending.size === 0) {
			return;
		}
		for (const key of Array.from(this.pending.keys())) {
			this.schedule(key);
		}
	}

	/**
	 * Phase 95: wires the keep-bar's per-file actions to the chat pane —
	 * keep resolves the file's overlay and marks it resolved in its turn
	 * record (persisted); discard reverts the file on disk first.
	 */
	setFileActions(handlers: IVibeAIFileReviewHandlers): void {
		this.fileActions = handlers;
	}

	override dispose(): void {
		this.disposed = true;
		for (const timer of this.timers) {
			window.clearTimeout(timer);
		}
		this.timers.clear();
		for (const key of Array.from(this.applied.keys())) {
			this.clearHighlight(key);
		}
		this.pending.clear();
		super.dispose();
	}
	/**
	 * Registers a live agent write (`tool_result` with a `code_change`) and
	 * highlights it once an open editor shows the new content. Phase 110:
	 * the pane passes the turn's accumulated (consolidated) change — the
	 * highlight shows the file's net diff for the whole turn, not the
	 * last write's step diff alone.
	 */
	highlight(change: IVibeAICodeChange, resolveUri: (path: string) => URI | undefined): void {
		if (change.action === 'delete' || change.newContent === undefined) {
			// Deletions have no on-disk lines to highlight; the chat's diff
			// card shows the red note.
			return;
		}
		const uri = resolveUri(change.filePath);
		if (!uri) {
			return;
		}
		this.pending.set(uri.toString(), change);
		this.schedule(uri.toString());
	}

	/**
	 * Re-applies the stored (live) highlight for a file the user is opening
	 * from the chat — no-op when the file was never written or is already
	 * highlighted with the same content.
	 */
	applyForUri(uri: URI): void {
		if (this.pending.has(uri.toString())) {
			this.schedule(uri.toString());
		}
	}

	/**
	 * Phase 95: resolves a file's pending change — the red/green overlay
	 * clears and the change stops re-applying when the file re-opens. The
	 * green additions ARE the kept on-disk content; the red deleted rows
	 * disappear. Called by the pane when a keep lands (editor bar, files
	 * list row or the turn-level Keep) and after a successful per-file
	 * revert (the on-disk content is the original again).
	 */
	resolveForUri(uri: URI, state: 'kept' | 'discarded' = 'kept'): void {
		if (this.pending.has(uri.toString()) || this.applied.has(uri.toString())) {
			this.resolveKey(uri.toString(), state);
			return;
		}
		// Defensive: URI spellings can drift between the highlight and the
		// resolve (casing, drive-letter encoding) — fall back to a decoded
		// path-suffix match so a Keep can never strand a live overlay.
		try {
			const target = decodeURIComponent(uri.path).toLowerCase();
			for (const source of [this.applied, this.pending]) {
				for (const candidate of Array.from(source.keys())) {
					const candidatePath = decodeURIComponent(URI.parse(candidate).path).toLowerCase();
					if (candidatePath === target || candidatePath.endsWith(target)) {
						this.resolveKey(candidate, state);
						return;
					}
				}
			}
		} catch {
			// Malformed URI spellings — the exact match above is the contract.
		}
	}

	private resolveKey(key: string, state: 'kept' | 'discarded' = 'kept'): void {
		this.pending.delete(key);
		this.resolveAppliedHighlight(key, state);
	}

	/**
	 * Phase 95 follow-up (user feedback): resolves ONE applied highlight —
	 * the red/green marks clear but the keep-bar STAYS up: the Keep /
	 * Discard buttons go and a status chip shows the outcome (Kept /
	 * Discarded). The applied entry survives (the model listener stays
	 * armed) so the resolved chip still clears on a model change / a newer
	 * write; the pane-side marks keep the overlay from resurrecting.
	 */
	private resolveAppliedHighlight(key: string, state: 'kept' | 'discarded'): void {
		const previous = this.applied.get(key);
		if (!previous || previous.barState === state) {
			return;
		}
		previous.barState = state;
		try {
			previous.collection.clear();
		} catch {
			// The editor may already be gone — decorations die with it.
		}
		this.removeZones(key, previous.zoneIds);
		for (const resolve of previous.barResolvers) {
			try {
				resolve(state);
			} catch {
				// The bar is cosmetic — a failed chip update is harmless.
			}
		}
	}

	/** Removes this highlight's deleted-row view zones from every matching editor. */
	private removeZones(key: string, zoneIds: string[]): void {
		if (zoneIds.length === 0) {
			return;
		}
		const target = key.toLowerCase();
		for (const editor of this.codeEditorService.listCodeEditors()) {
			if ((editor.getModel()?.uri.toString() ?? '').toLowerCase() === target) {
				editor.changeViewZones(accessor => {
					for (const id of zoneIds) {
						accessor.removeZone(id);
					}
				});
			}
		}
	}

	/**
	 * Re-arms the highlighter for a change read back from a persisted
	 * session (Phase 58 follow-up): stored as pending only — no polling,
	 * no reveal — so opening the file from the restored chat (tool card,
	 * file row, Review) re-applies the red/green highlight via
	 * `applyForUri`. Live writes register through `highlight`; a restart
	 * forgets them, which used to leave restored chats without any editor
	 * highlighting. The content-match guard in `applyOnce` keeps changes
	 * the file has since moved past inert.
	 */
	registerRestored(change: IVibeAICodeChange, resolveUri: (path: string) => URI | undefined): void {
		if (change.action === 'delete' || change.newContent === undefined) {
			// Deletions have no on-disk lines to highlight.
			return;
		}
		const uri = resolveUri(change.filePath);
		if (!uri) {
			return;
		}
		this.pending.set(uri.toString(), change);
	}

	/**
	 * Polls for an editor whose model shows the write's new content (the
	 * watcher reload or the chat-driven open may lag a few hundred ms).
	 */
	private schedule(key: string): void {
		if (this.polling.has(key)) {
			// A poll is already chasing this file; it reads the latest
			// pending write on every tick.
			return;
		}
		this.polling.add(key);
		const tick = (tries: number) => {
			const change = this.pending.get(key);
			if (this.disposed || !change) {
				this.polling.delete(key);
				return;
			}
			if (this.applyOnce(key, change) || tries >= RETRY_LIMIT) {
				this.polling.delete(key);
				return;
			}
			const timer = window.setTimeout(() => tick(tries + 1), RETRY_INTERVAL_MS);
			this.timers.add(timer);
		};
		tick(0);
	}

	private applyOnce(key: string, change: IVibeAICodeChange): boolean {
		const existing = this.applied.get(key);
		if (existing && existing.change === change) {
			// Already applied for this exact write — keep it (no re-reveal).
			return true;
		}
		const target = key.toLowerCase();
		const editors = this.codeEditorService.listCodeEditors().filter(
			editor => (editor.getModel()?.uri.toString() ?? '').toLowerCase() === target
		);
		let appliedAny = false;
		for (const editor of editors) {
			const model = editor.getModel();
			// The model must show the write's new content: a stale model is
			// still waiting for the file watcher, a dirty buffer is the
			// user's — never decorate either. `normalizeEol` — the backend
			// writes `\r\n` on Windows (aiofiles text mode) while the write's
			// new content is `\n`; a raw comparison mismatched every line and
			// never decorated.
			if (!model || normalizeEol(model.getValue()) !== normalizeEol(change.newContent ?? '')) {
				continue;
			}
			this.applyToEditor(editor, key, change);
			appliedAny = true;
		}
		return appliedAny;
	}

	private applyToEditor(editor: ICodeEditor, key: string, change: IVibeAICodeChange): void {
		// A newer write to the same file supersedes the previous highlight.
		this.clearHighlight(key);

		const lines = computeDiffLines(change.oldContent ?? '', change.newContent ?? '');
		const decorations: IModelDeltaDecoration[] = [];
		const deletedRuns: { afterLineNumber: number; texts: string[] }[] = [];
		let firstChangedLine: number | undefined;
		let lastKeptLine = 0;
		let decorated = 0;

		for (let i = 0; i < lines.length && decorated < MAX_HIGHLIGHT_LINES; i++) {
			const line = lines[i];
			if (line.type === 'del') {
				const texts: string[] = [];
				while (i < lines.length && lines[i].type === 'del') {
					texts.push(lines[i].text);
					i++;
					decorated++;
				}
				i--;
				deletedRuns.push({ afterLineNumber: lastKeptLine, texts });
				continue;
			}
			if (line.type === 'add') {
				const no = line.newLine;
				if (no !== undefined) {
					decorations.push({
						range: { startLineNumber: no, startColumn: 1, endLineNumber: no, endColumn: 1 },
						options: { description: 'vibe-ai-editor-added-line', isWholeLine: true, className: 'vibe-ai-editor-line-added' },
					});
					firstChangedLine = firstChangedLine ?? no;
					decorated++;
				}
				lastKeptLine = no ?? lastKeptLine;
			} else {
				lastKeptLine = line.newLine ?? lastKeptLine;
			}
		}

		if (decorations.length === 0 && deletedRuns.length === 0) {
			return;
		}

		const collection = editor.createDecorationsCollection(decorations);
		const zoneIds: string[] = [];
		if (deletedRuns.length > 0) {
			// Deleted lines do not exist in the new content — surface them
			// as red view-zone rows (Cursor editor overlay parity), with the
			// editor's exact font so the zone height matches the rows.
			const fontInfo = editor.getOption(EditorOption.fontInfo);
			const contentLeft = editor.getLayoutInfo().contentLeft;
			editor.changeViewZones(accessor => {
				for (const run of deletedRuns) {
					const domNode = $('div.vibe-ai-editor-deleted-rows');
					domNode.style.fontFamily = fontInfo.fontFamily;
					domNode.style.fontSize = `${fontInfo.fontSize}px`;
					domNode.style.lineHeight = `${fontInfo.lineHeight}px`;
					for (const text of run.texts) {
						const row = $('div.vibe-ai-editor-deleted-row');
						row.style.paddingLeft = `${contentLeft}px`;
						row.textContent = text;
						domNode.appendChild(row);
					}
					zoneIds.push(accessor.addZone({
						afterLineNumber: run.afterLineNumber,
						heightInLines: run.texts.length,
						domNode,
					}));
				}
			});
		}

		// Phase 95 (follow-up): the keep-file bar — an always-visible
		// "Keep changes to x.py?" pill (path label left, Keep / Discard
		// right) while the red/green overlay is up. Keep clears the
		// overlay but leaves the bar up (buttons go, a status chip shows
		// the outcome); Discard reverts the file first. Defensive: a bar
		// failure must not strand the overlay — the applied entry below
		// is what resolveForUri / clearHighlight remove.
		const barWidgets: IOverlayWidget[] = [];
		const barDomNodes: HTMLElement[] = [];
		const barResolvers: ((state: 'kept' | 'discarded') => void)[] = [];
		try {
			const bar = this.addKeepBar(editor, key, change);
			if (bar.widget) {
				barWidgets.push(bar.widget);
			}
			barDomNodes.push(bar.domNode);
			barResolvers.push(bar.resolve);
		} catch {
			// The bar is cosmetic — the overlay still resolves cleanly.
		}

		this.applied.set(key, {
			change,
			collection,
			zoneIds,
			barWidgets,
			barDomNodes,
			barResolvers,
			// Navigating the editor away leaves stale zones behind — drop
			// the highlight when the model changes.
			modelListener: editor.onDidChangeModel(() => this.clearHighlight(key)),
		});

		if (firstChangedLine !== undefined) {
			editor.revealLineInCenterIfOutsideViewport(firstChangedLine);
		}
	}

	/**
	 * Phase 95 (follow-up): builds the keep-file bar (Cursor editor overlay
	 * parity) — an always-visible "Keep changes to <path>?" pill with Keep /
	 * Discard actions. Phase 95 (user feedback ②): it lives IN the file
	 * path row — the breadcrumbs row under the editor tabs — pinned to the
	 * row's right edge (path label left, buttons right, layout unchanged;
	 * it used to float over the first content lines). The editor's overlay
	 * layer is clipped to the content area, so no overlay position can
	 * reach the path row: the bar attaches to the workbench breadcrumb row
	 * instead, and when breadcrumbs are hidden/disabled it falls back to a
	 * top-right overlay widget. Keep resolves the overlay and notifies the
	 * pane (the per-change mark lands in the turn record); Discard asks the
	 * pane to revert the file first and re-arms when the revert fails.
	 * Returns the overlay-widget fallback (removed by clearHighlight), the
	 * DOM node (also removed by clearHighlight) plus the resolve hook — the
	 * bar STAYS up after a resolve (only the buttons go, a status chip
	 * shows the outcome), so the chip swap rides on `resolve`.
	 */
	private addKeepBar(editor: ICodeEditor, key: string, change: IVibeAICodeChange): { widget: IOverlayWidget | undefined; domNode: HTMLElement; resolve: (state: 'kept' | 'discarded') => void } {
		const domNode = $('div.vibe-ai-keep-bar');
		const label = append(domNode, $('span.vibe-ai-keep-bar-label'));
		label.textContent = localize('vibeAIChat.keepBar.title', "Keep changes to {0}?", change.filePath);
		label.title = change.filePath;
		const actions = append(domNode, $('div.vibe-ai-keep-bar-actions'));
		const keep = append(actions, $('button.vibe-ai-keep-bar-btn.vibe-ai-keep-bar-keep')) as HTMLButtonElement;
		keep.textContent = localize('vibeAIChat.keepBar.keep', "Keep");
		keep.title = localize('vibeAIChat.keepBar.keepTitle', "Keep this file's changes and clear the change marks");
		const discard = append(actions, $('button.vibe-ai-keep-bar-btn.vibe-ai-keep-bar-discard')) as HTMLButtonElement;
		discard.textContent = localize('vibeAIChat.keepBar.discard', "Discard");
		discard.title = localize('vibeAIChat.keepBar.discardTitle', "Revert this file to its pre-change content");
		const status = append(domNode, $('span.vibe-ai-keep-bar-status'));
		// Widget DOM dies with the widget — plain listeners are enough (they
		// are dropped when the bar is removed with the highlight).
		this.wireBarActions(keep, discard, key, change);
		const resolve = (state: 'kept' | 'discarded') => {
			// The bar stays up: the buttons go, the status chip shows the
			// outcome (CSS swaps the display off the `.resolved` class).
			domNode.classList.add('resolved');
			domNode.classList.toggle('discarded', state === 'discarded');
			actions.style.display = 'none';
			status.textContent = state === 'kept'
				? localize('vibeAIChat.keepBar.kept', "Kept")
				: localize('vibeAIChat.keepBar.discarded', "Discarded");
		};
		// Phase 95 (user feedback ②): attach to the file path row (the
		// breadcrumbs row under the tabs) so the bar sits at the row's
		// right edge — the editor's overlay layer is clipped to the content
		// area and can never reach it. No visible breadcrumbs row (hidden
		// or disabled) → overlay-widget fallback pinned to the editor's
		// top-right corner (TOP_RIGHT_CORNER — the renderer right-anchors
		// it next to the minimap with setTop(0) + setRight, same anchor as
		// the find widget, and it stays visible wherever the user scrolls).
		// No stackOrdinal: the corner stacking branch never right-anchors
		// (it only bumps the top by previous widgets' widths), which would
		// drop the bar at the top-left.
		const pathRow = this.findPathRow(editor);
		if (pathRow) {
			pathRow.appendChild(domNode);
			return { widget: undefined, domNode, resolve };
		}
		const widget: IOverlayWidget = {
			getId: () => `vibe-ai-keep-bar-${key}`,
			getDomNode: () => domNode,
			getPosition: () => ({ preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }),
		};
		editor.addOverlayWidget(widget);
		return { widget, domNode, resolve };
	}

	/**
	 * The file path row: the breadcrumbs row under the editor tabs (the row
	 * rendering the file path). Must be visible — breadcrumbs disabled or
	 * hidden collapses the row (`hidden` class) and would hide the bar with
	 * it, so the caller falls back to the overlay widget then.
	 */
	private findPathRow(editor: ICodeEditor): HTMLElement | undefined {
		try {
			const group = editor.getDomNode()?.closest('.editor-group-container');
			const row = group?.querySelector('.breadcrumbs-below-tabs:not(.hidden)');
			return row instanceof HTMLElement && row.offsetHeight > 0 ? row : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Phase 95: wires the Keep / Discard actions for the pinned bar —
	 * keep resolves the file's overlay (the pane marks it resolved in
	 * its turn record); discard reverts the file on disk first (a failed
	 * revert re-enables the buttons for a retry).
	 */
	private wireBarActions(keep: HTMLButtonElement, discard: HTMLButtonElement, key: string, change: IVibeAICodeChange): void {
		keep.addEventListener('click', e => {
			e.stopPropagation();
			this.resolveKey(key, 'kept');
			this.fileActions?.keepFile(change);
		});
		let discarding = false;
		discard.addEventListener('click', e => {
			e.stopPropagation();
			if (discarding) {
				return;
			}
			discarding = true;
			discard.classList.add('disabled');
			Promise.resolve(this.fileActions ? this.fileActions.discardFile(change) : false)
				.then(ok => {
					discarding = false;
					if (!ok) {
						// The revert failed (or nothing handled it) — the
						// bar stays up for a retry.
						discard.classList.remove('disabled');
					}
				})
				.catch(() => {
					// Defensive: the pane logs revert errors itself.
					discarding = false;
					discard.classList.remove('disabled');
				});
		});
	}

	private clearHighlight(key: string): void {
		const previous = this.applied.get(key);
		if (!previous) {
			return;
		}
		this.applied.delete(key);
		previous.modelListener?.dispose();
		try {
			previous.collection.clear();
		} catch {
			// The editor may already be gone — decorations die with it.
		}
		this.removeZones(key, previous.zoneIds);
		if (previous.barWidgets.length > 0) {
			const target = key.toLowerCase();
			for (const editor of this.codeEditorService.listCodeEditors()) {
				if ((editor.getModel()?.uri.toString() ?? '').toLowerCase() === target) {
					// Phase 95 (follow-up): the keep-bar goes with the
					// overlay (a resolved bar only survives while its
					// applied entry does).
					for (const widget of previous.barWidgets) {
						try {
							editor.removeOverlayWidget(widget);
						} catch {
							// The editor may already be gone.
						}
					}
				}
			}
		}
		// Phase 95 (user feedback ②): path-row keep-bars are plain DOM —
		// they go with the highlight too.
		for (const domNode of previous.barDomNodes) {
			try {
				domNode.remove();
			} catch {
				// The editor may already be gone.
			}
		}
	}
}