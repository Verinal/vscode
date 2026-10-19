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
 * matches the write's new content — a dirty user buffer never matches, so
 * it is never decorated. A highlight persists until the same file is
 * written again or the pane closes; opening the file from the chat (tool
 * card, Review, files list) re-applies the stored highlight.
 */

import { $ } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration } from '../../../../editor/common/model.js';
import { IVibeAICodeChange } from '../../../../platform/vibeAI/common/vibeAI.js';
import { computeDiffLines } from './vibeAIDiff.js';
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
	readonly modelListener: IDisposable | undefined;
}

export class VibeAIEditorHighlighter extends Disposable {

	private disposed = false;
	/** Latest live write per file URI — re-applied when the file opens from the chat. */
	private readonly pending = new Map<string, IVibeAICodeChange>();
	private readonly applied = new Map<string, IVibeAIEditorHighlight>();
	private readonly polling = new Set<string>();
	private readonly timers = new Set<number>();

	constructor(private readonly codeEditorService: ICodeEditorService) {
		super();
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
	 * highlights it once an open editor shows the new content.
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
			// user's — never decorate either.
			if (!model || model.getValue() !== change.newContent) {
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

		this.applied.set(key, {
			change,
			collection,
			zoneIds,
			// Navigating the editor away leaves stale zones behind — drop
			// the highlight when the model changes.
			modelListener: editor.onDidChangeModel(() => this.clearHighlight(key)),
		});

		if (firstChangedLine !== undefined) {
			editor.revealLineInCenterIfOutsideViewport(firstChangedLine);
		}
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
		if (previous.zoneIds.length > 0) {
			const target = key.toLowerCase();
			for (const editor of this.codeEditorService.listCodeEditors()) {
				if ((editor.getModel()?.uri.toString() ?? '').toLowerCase() === target) {
					editor.changeViewZones(accessor => {
						for (const id of previous.zoneIds) {
							accessor.removeZone(id);
						}
					});
				}
			}
		}
	}
}