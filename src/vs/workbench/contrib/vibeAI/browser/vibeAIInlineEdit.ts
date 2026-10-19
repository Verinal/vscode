/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	ContentWidgetPositionPreference,
	ICodeEditor,
	IContentWidget,
	IContentWidgetPosition,
} from '../../../../editor/browser/editorBrowser.js';
import type { IRange } from '../../../../editor/common/core/range.js';
import { IVibeAIModelProvider, IVibeAIService } from '../../../../platform/vibeAI/common/vibeAI.js';
import { computeDiffLines, computeDiffStats } from './vibeAIDiff.js';

/**
 * Cursor-style Ctrl+K inline edit.
 *
 * A floating prompt widget is anchored below the cursor line. Enter sends
 * the instruction together with the selection (or the whole file) to
 * `POST /api/chat/edit`; the rewritten code is previewed as an inline
 * red/green diff (same line-diff helper as the chat tool cards) and can be
 * accepted (undo-safe) or discarded with Esc.
 */

type VibeAIInlineEditState = 'prompt' | 'loading' | 'preview';

const activeSessions = new Map<string, VibeAIInlineEditSession>();

/**
 * Opens (or focuses the already open) inline edit widget for the editor.
 * `provider` is the editor's resolved model provider (Settings → Models
 * custom models) — requests without a usable model are gated before this
 * is called (the backend 400s 沒有模型可用 without one).
 */
export function startVibeAIInlineEdit(editor: ICodeEditor, vibeAIService: IVibeAIService, provider?: IVibeAIModelProvider): void {
	const existing = activeSessions.get(editor.getId());
	if (existing) {
		existing.focus();
		return;
	}
	activeSessions.set(editor.getId(), new VibeAIInlineEditSession(editor, vibeAIService, provider));
}

class VibeAIInlineEditSession extends Disposable implements IContentWidget {

	private static readonly WIDGET_ID = 'vibeAI.inlineEditWidget';

	private state: VibeAIInlineEditState = 'prompt';
	private disposed = false;
	private domNode: HTMLElement | undefined;
	private input: HTMLInputElement | undefined;
	private statusNode: HTMLElement | undefined;
	private previewNode: HTMLElement | undefined;
	private pendingCode: string | null = null;
	private readonly selectionRange: IRange | null;
	private readonly languageId: string;
	private readonly fileName: string;

	allowEditorOverflow = true;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly vibeAIService: IVibeAIService,
		private readonly provider: IVibeAIModelProvider | undefined
	) {
		super();

		const model = editor.getModel();
		if (!model) {
			throw new Error('VibeAI inline edit requires a model');
		}

		const selection = editor.getSelection();
		this.selectionRange = selection && !selection.isEmpty() ? selection : null;
		this.languageId = model.getLanguageId();
		this.fileName = model.uri.fsPath.replace(/\\/g, '/').split('/').pop() ?? model.uri.fsPath;
		const cursor = editor.getPosition();
		const anchorLine = this.selectionRange ? this.selectionRange.startLineNumber : (cursor ? cursor.lineNumber : 1);

		editor.addContentWidget(this);
		this._register(toDisposable(() => {
			this.disposed = true;
			activeSessions.delete(editor.getId());
			editor.removeContentWidget(this);
			editor.focus();
		}));

		// Make sure the anchor line (and with it the widget) is on screen.
		editor.revealLineInCenterIfOutsideViewport(anchorLine);
		this.focus();
	}

	getId(): string {
		return VibeAIInlineEditSession.WIDGET_ID;
	}

	getDomNode(): HTMLElement {
		if (!this.domNode) {
			this.buildDomNode();
		}
		return this.domNode!;
	}

	getPosition(): IContentWidgetPosition | null {
		const cursor = this.editor.getPosition();
		const lineNumber = this.selectionRange
			? this.selectionRange.startLineNumber
			: (cursor ? cursor.lineNumber : 1);
		return {
			position: { lineNumber, column: 1 },
			preference: [ContentWidgetPositionPreference.BELOW]
		};
	}

	focus(): void {
		this.input?.focus();
	}

	private buildDomNode(): void {
		const root = $('div.vibeai-inline-edit', {
			style: 'width:560px;max-width:92vw;border-radius:6px;border:1px solid #454545;background:#252526;box-shadow:0 4px 16px rgba(0,0,0,0.45);padding:8px 10px;font-size:12px;'
		});

		// Header: title + target (file name and selection range).
		const header = $('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;overflow:hidden;' });
		append(header, $('span', { style: 'font-weight:600;color:#c5c5c5;' }, 'VibeAI Edit'));
		append(header, $('span', { style: 'color:#9d9d9d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
			this.fileName + (this.selectionRange
				? ` (L${this.selectionRange.startLineNumber}-L${this.selectionRange.endLineNumber})`
				: ' (whole file)')));
		append(root, header);

		// Instruction input.
		this.input = <HTMLInputElement>$('input', {
			type: 'text',
			placeholder: 'Tell the AI what to change… (Enter to generate, Esc to cancel)',
			style: 'width:100%;box-sizing:border-box;background:#3c3c3c;color:#cccccc;border:1px solid #5a5a5a;border-radius:4px;padding:5px 8px;outline:none;'
		});
		this.input.addEventListener('keydown', e => this.onKeyDown(e));
		append(root, this.input);

		// Status line.
		this.statusNode = $('div', { style: 'margin-top:6px;min-height:15px;color:#9d9d9d;' });
		append(root, this.statusNode);

		// Diff preview (hidden until a rewrite came back).
		this.previewNode = $('div', {
			style: 'display:none;margin-top:6px;border-radius:4px;overflow:auto;max-height:280px;font-family:monospace;font-size:12px;line-height:17px;border:1px solid #333333;'
		});
		append(root, this.previewNode);

		this.domNode = root;
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.dispose();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			if (this.state === 'prompt') {
				void this.submit();
			} else if (this.state === 'preview') {
				this.accept();
			}
		} else if (e.key === 'Tab' && this.state === 'preview') {
			e.preventDefault();
			e.stopPropagation();
			this.accept();
		}
	}

	private async submit(): Promise<void> {
		const model = this.editor.getModel();
		const instruction = (this.input?.value ?? '').trim();
		if (!model || this.state !== 'prompt') {
			return;
		}
		if (!instruction) {
			this.setStatus('Type an instruction first.');
			return;
		}
		const code = this.selectionRange ? model.getValueInRange(this.selectionRange) : model.getValue();
		if (!code.trim()) {
			this.setStatus('Nothing to edit — the code is empty.');
			return;
		}

		this.state = 'loading';
		if (this.input) {
			this.input.disabled = true;
		}
		this.setStatus('Generating…');

		let newCode: string | null = null;
		try {
			newCode = await this.vibeAIService.inlineEdit({
				instruction,
				code,
				language: this.languageId,
				...(this.provider ? { provider: this.provider } : {}),
			});
		} finally {
			if (this.input) {
				this.input.disabled = false;
			}
		}

		if (this.disposed) {
			return;
		}
		if (!newCode) {
			this.state = 'prompt';
			this.setStatus('The backend returned nothing — is it running? (npm run dev)');
			return;
		}
		if (newCode === code) {
			this.state = 'prompt';
			this.setStatus('The AI produced no changes.');
			return;
		}

		this.pendingCode = newCode;
		this.state = 'preview';
		this.renderPreview(code, newCode);
	}

	private renderPreview(original: string, updated: string): void {
		const previewNode = this.previewNode;
		if (!previewNode) {
			return;
		}
		const stats = computeDiffStats(original, updated);
		clearNode(previewNode);
		for (const line of computeDiffLines(original, updated)) {
			const background = line.type === 'del' ? 'rgba(248,81,73,0.12)'
				: line.type === 'add' ? 'rgba(63,185,80,0.12)'
					: 'transparent';
			const color = line.type === 'del' ? '#f48484'
				: line.type === 'add' ? '#5cc46a'
					: '#808080';
			append(previewNode, $('div', { style: `white-space:pre;padding:0 8px;background:${background};color:${color};` },
				`${line.type === 'del' ? '−' : line.type === 'add' ? '+' : ' '} ${line.text}`));
		}
		previewNode.style.display = 'block';
		this.setStatus(`+${stats.additions} −${stats.deletions} · Enter / Tab to accept · Esc to discard`);
	}

	private accept(): void {
		const model = this.editor.getModel();
		if (!model || this.state !== 'preview' || this.pendingCode === null) {
			return;
		}
		const range = this.selectionRange ?? model.getFullModelRange();
		// Undo-safe: both paths land in the editor's undo stack, so Ctrl+Z
		// reverts the whole AI edit in one step.
		const selections = model.pushEditOperations([], [{ range, text: this.pendingCode }], () => null);
		if (selections && selections.length > 0) {
			this.editor.setSelections(selections);
		}
		this.dispose();
	}

	private setStatus(text: string): void {
		if (this.statusNode) {
			this.statusNode.textContent = text;
		}
	}
}
