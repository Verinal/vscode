/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 251: the tool cards' inline red/green diff preview renders in a REAL
 * embedded DiffEditorWidget — the same widget the built-in chat uses for
 * code-edit blocks (CodeCompareBlockPart) — instead of hand-tokenized HTML
 * rows.
 *
 * Why: the previous preview piped every row through `tokenizeToString`
 * (`.mtkN` spans) and stacked dimming on top — translucent GitHub-palette
 * red/green line washes and a 0.55 opacity on unchanged rows — so the code
 * read gray-veiled next to the editor (user: 「代碼顏色像是被一層灰色罩住
 * 了，沒有編輯器裡面的鮮艷」). The embedded widget renders through the
 * editor's own view pipeline: theme token colors at the editor's font size,
 * TextMate + semantic tokens (the TS extension serves
 * `vscode-chat-code-block` URIs — see its getSemanticSupportedSchemes), the
 * theme's own diff colors for the red/green annotation, and built-in folding
 * of unchanged regions (`hideUnchangedRegions`) — nothing hand-tinted.
 *
 * Cost control: a widget per card is real memory, so the editor builds
 * lazily on first visibility (IntersectionObserver — a restored session
 * keeps its Worked shells folded, so only cards the user actually opens pay
 * for an editor) and the merged diff line count is capped (oversized diffs
 * report `renderable: false` so the caller falls back to the legacy HTML
 * rows in vibeAIToolCard).
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import * as dom from '../../../../base/browser/dom.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IDiffEditorConstructionOptions } from '../../../../editor/browser/editorBrowser.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getSimpleEditorOptions } from '../../codeEditor/browser/simpleEditorOptions.js';
import { MenuPreventer } from '../../codeEditor/browser/menuPreventer.js';
import { SelectionClipboardContributionID } from '../../codeEditor/browser/selectionClipboard.js';
import { ContextMenuController } from '../../../../editor/contrib/contextmenu/browser/contextmenu.js';
import { WordHighlighterContribution } from '../../../../editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import { ViewportSemanticTokensContribution } from '../../../../editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import { BracketMatchingController } from '../../../../editor/contrib/bracketMatching/browser/bracketMatching.js';
import { SmartSelectController } from '../../../../editor/contrib/smartSelect/browser/smartSelect.js';
import { ContentHoverController } from '../../../../editor/contrib/hover/browser/contentHoverController.js';
import { GlyphHoverController } from '../../../../editor/contrib/hover/browser/glyphHoverController.js';
import { GotoDefinitionAtPositionEditorContribution } from '../../../../editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import { localize } from '../../../../nls.js';
import { computeDiffLines } from './vibeAIDiff.js';

/** Collapsed preview height in rows — the legacy HTML path's cap (Phase 58). */
const COLLAPSED_EMBEDDED_DIFF_LINES = 5;

/** Expanded preview height in rows — the legacy toggle's 24-row budget. */
const EXPANDED_EMBEDDED_DIFF_LINES = 24;

/** Vertical padding of the embedded editor (top + bottom, in px). */
const EMBEDDED_DIFF_PADDING_Y = 6;

/**
 * Merged diff rows beyond this use the legacy tokenized-HTML path — the
 * embedded widget is per-card state, and a full-file rewrite of a giant
 * file should not mint one. The legacy path's compression keeps those
 * previews small.
 */
const MAX_EMBEDDED_DIFF_LINES = 2000;

/**
 * Startup-restore window retries for the language guess (same shape as
 * vibeAIToolCard's fillDiffTokenColors): languages register with the
 * extension host after the workbench parts render, so a restored card may
 * build with plaintext first and upgrade once the language registers.
 */
const LANGUAGE_RETRY_DELAY_MS = 1000;
const LANGUAGE_RETRY_ATTEMPTS = 30;

/** Fallback row height before the widget reports the real line height (the legacy path's 16px). */
const FALLBACK_LINE_HEIGHT = 16;

let pseudoModelCounter = 0;

function pseudoDiffUri(kind: 'original' | 'modified'): URI {
	pseudoModelCounter++;
	return URI.from({
		scheme: Schemas.vscodeChatCodeBlock,
		path: `/vibe-ai-tool-diff-${kind}-${pseudoModelCounter}-${generateUuid()}`,
	});
}

/**
 * The card's factory hook (the pane binds it to `instantiationService`).
 * Returning a non-renderable handle tells the caller to fall back to the
 * legacy HTML rows; `onBuildFailure` covers an async build error after the
 * caller already committed to the embedded path.
 */
export type VibeAIEmbeddedDiffFactory = (
	container: HTMLElement,
	original: string,
	updated: string,
	filePath: string,
	firstChangeLine: number | undefined,
	onBuildFailure: () => void,
) => VibeAIEmbeddedDiff;

export class VibeAIEmbeddedDiff extends Disposable {

	/** Merged diff row count — drives the caller's expand-toggle decision. */
	readonly lineCount: number;

	/** False when the diff is too big for an embedded widget (caller falls back). */
	readonly renderable: boolean;

	private readonly host: HTMLElement;
	private diffEditor: DiffEditorWidget | undefined;
	private expanded = false;
	private built = false;
	private observer: IntersectionObserver | undefined;
	private pendingModelCleanup: (() => void) | undefined;

	constructor(
		container: HTMLElement,
		private readonly original: string,
		private readonly updated: string,
		private readonly filePath: string,
		private readonly firstChangeLine: number | undefined,
		private readonly onBuildFailure: () => void,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.lineCount = computeMergedLineCount(original, updated);
		this.renderable = this.lineCount > 0 && this.lineCount <= MAX_EMBEDDED_DIFF_LINES;

		this.host = document.createElement('div');
		this.host.className = 'vibe-ai-embedded-diff-host';
		// Placeholder at the collapsed cap keeps the card's layout stable
		// until the widget builds and reports the real line height.
		this.host.style.height = `${Math.min(this.lineCount, COLLAPSED_EMBEDDED_DIFF_LINES) * FALLBACK_LINE_HEIGHT + EMBEDDED_DIFF_PADDING_Y}px`;
		container.appendChild(this.host);

		if (!this.renderable) {
			return;
		}

		// Build on first visibility: a <details> body (card or Worked shell)
		// that is closed reports no intersection, so folded history never
		// instantiates widgets until the user opens it.
		const window = dom.getWindow(container);
		const Observer = window.IntersectionObserver;
		if (typeof Observer !== 'function') {
			void this.build();
			return;
		}
		this.observer = new Observer(entries => {
			if (entries.some(entry => entry.isIntersecting)) {
				this.observer?.disconnect();
				this.observer = undefined;
				void this.build();
			}
		});
		this.observer.observe(this.host);
		this._register(toDisposable(() => this.observer?.disconnect()));
	}

	/** Grows/shrinks the preview between the collapsed and expanded row caps. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!this.diffEditor) {
			return; // not built yet — the layout() on build honors the flag
		}
		this.layout();
		if (!expanded) {
			// Collapsing jumps back to the changed region (legacy toggle parity).
			this.revealFirstChange();
		}
	}

	override dispose(): void {
		// The editor releases its models first (mirror CodeCompareBlockPart's
		// teardown order: widget, then models, then resolver references).
		this.diffEditor?.dispose();
		this.diffEditor = undefined;
		this.pendingModelCleanup?.();
		super.dispose();
	}

	private async build(): Promise<void> {
		if (this.built) {
			return;
		}
		this.built = true;
		try {
			const languageId = this.languageGuessFor();
			const languageSelection = this.languageService.createById(languageId ?? PLAINTEXT_LANGUAGE_ID);
			const originalUri = pseudoDiffUri('original');
			const modifiedUri = pseudoDiffUri('modified');
			const originalModel = this.modelService.createModel(this.original, languageSelection, originalUri, false);
			const modifiedModel = this.modelService.createModel(this.updated, languageSelection, modifiedUri, false);

			// Hold resolver references like the chat's code-block parts do —
			// the scheme is served by a content provider that hands back the
			// raw model, and an unreferenced resolved model may be disposed
			// once some consumer (e.g. WordHighlighter) drops its reference.
			const [originalRef, modifiedRef] = await Promise.all([
				this.textModelService.createModelReference(originalUri),
				this.textModelService.createModelReference(modifiedUri),
			]);
			if (this._store.isDisposed) {
				originalRef.dispose();
				modifiedRef.dispose();
				originalModel.dispose();
				modifiedModel.dispose();
				return;
			}
			this.pendingModelCleanup = () => {
				// Official order (MarkdownDiffBlockPart): models first, then refs.
				originalModel.dispose();
				modifiedModel.dispose();
				originalRef.dispose();
				modifiedRef.dispose();
			};

			if (languageId === null) {
				this.scheduleLanguageUpgrade(originalModel, modifiedModel);
			}

			const widgetOptions: ICodeEditorWidgetOptions = {
				contributions: EditorExtensionsRegistry.getSomeEditorContributions([
					MenuPreventer.ID,
					SelectionClipboardContributionID,
					ContextMenuController.ID,
					WordHighlighterContribution.ID,
					ViewportSemanticTokensContribution.ID,
					BracketMatchingController.ID,
					SmartSelectController.ID,
					ContentHoverController.ID,
					GlyphHoverController.ID,
					GotoDefinitionAtPositionEditorContribution.ID,
				]),
			};
			const options: IDiffEditorConstructionOptions = {
				...getSimpleEditorOptions(this.configurationService),
				wordWrap: 'off',
				lineNumbers: 'on',
				selectOnLineNumbers: true,
				scrollBeyondLastLine: false,
				lineDecorationsWidth: 12,
				lineNumbersMinChars: 3,
				dragAndDrop: false,
				padding: { top: EMBEDDED_DIFF_PADDING_Y / 2, bottom: EMBEDDED_DIFF_PADDING_Y / 2 },
				mouseWheelZoom: false,
				scrollbar: {
					vertical: 'auto',
					horizontal: 'auto',
					alwaysConsumeMouseWheel: false,
					useShadows: false,
					verticalScrollbarSize: 10,
					horizontalScrollbarSize: 10,
				},
				definitionLinkOpensInPeek: false,
				gotoLocation: {
					multiple: 'goto',
					multipleDeclarations: 'goto',
					multipleDefinitions: 'goto',
					multipleImplementations: 'goto',
				},
				ariaLabel: localize('vibeAIChat.tool.embeddedDiff', "Diff preview"),
				originalAriaLabel: localize('vibeAIChat.tool.embeddedDiffOriginal', "Original"),
				modifiedAriaLabel: localize('vibeAIChat.tool.embeddedDiffModified', "Modified"),
				diffCodeLens: false,
				renderMarginRevertIcon: false,
				stickyScroll: { enabled: false },
				diffAlgorithm: 'advanced',
				readOnly: true,
				isInEmbeddedEditor: true,
				useInlineViewWhenSpaceIsLimited: true,
				experimental: { useTrueInlineView: true },
				renderSideBySideInlineBreakpoint: 300,
				renderOverviewRuler: false,
				compactMode: true,
				hideUnchangedRegions: { enabled: true, contextLineCount: 2 },
				renderGutterMenu: false,
				automaticLayout: true,
				tabFocusMode: true,
			};
			const diffEditor = this._register(this.instantiationService.createInstance(
				DiffEditorWidget, this.host, options, { originalEditor: widgetOptions, modifiedEditor: widgetOptions }));
			this.diffEditor = diffEditor;
			diffEditor.setModel({ original: originalModel, modified: modifiedModel });

			// Content-height driven sizing: the host height is the diff's own
			// height capped to the collapsed/expanded row budget (the hidden
			// unchanged regions and the folding chevrons change it too).
			this._register(diffEditor.onDidContentSizeChange(() => this.layout()));
			this._register(diffEditor.onDidUpdateDiff(() => this.revealFirstChange()));
			this.layout();
			this.revealFirstChange();
		} catch {
			// Embedded build failed — hand the preview back to the legacy
			// tokenized-HTML rows so it never disappears.
			this.host.remove();
			this.onBuildFailure();
		}
	}

	/** Sizes the host: the widget's content height, capped to the row budget. */
	private layout(): void {
		const editor = this.diffEditor;
		if (!editor || !this.host.isConnected) {
			return;
		}
		const lineHeight = editor.getModifiedEditor().getOption(EditorOption.lineHeight) || FALLBACK_LINE_HEIGHT;
		const cap = (this.expanded ? EXPANDED_EMBEDDED_DIFF_LINES : COLLAPSED_EMBEDDED_DIFF_LINES) * lineHeight + EMBEDDED_DIFF_PADDING_Y;
		const height = Math.min(editor.getContentHeight(), cap);
		// A 1px guard: setting the height re-triggers automaticLayout, and a
		// scrollbar appearing/disappearing could oscillate the content height.
		if (Math.abs(parseFloat(this.host.style.height) - height) <= 1) {
			return;
		}
		this.host.style.height = `${height}px`;
	}

	/** Scrolls the collapsed preview to the changed region (legacy parity). */
	private revealFirstChange(): void {
		if (this.expanded) {
			return;
		}
		const line = Math.max(1, (this.firstChangeLine ?? 1) - 2);
		this.diffEditor?.getModifiedEditor().revealLineNearTop(line);
	}

	/**
	 * Same startup-restore window as the legacy path: the language registry
	 * has no languages yet right after boot, so the models were created as
	 * plaintext. Retries the guess; once it resolves, upgrades both models
	 * in place (the widget retokenizes — including semantic tokens).
	 */
	private scheduleLanguageUpgrade(originalModel: ITextModel, modifiedModel: ITextModel): void {
		let attempt = 0;
		const step = () => {
			attempt++;
			if (this._store.isDisposed || !this.built) {
				return;
			}
			const languageId = this.languageGuessFor();
			if (languageId && languageId !== PLAINTEXT_LANGUAGE_ID) {
				originalModel.setLanguage(languageId);
				modifiedModel.setLanguage(languageId);
				return;
			}
			if (attempt < LANGUAGE_RETRY_ATTEMPTS) {
				setTimeout(step, LANGUAGE_RETRY_DELAY_MS);
			}
		};
		setTimeout(step, LANGUAGE_RETRY_DELAY_MS);
	}

	/** Maps the changed file path to its language — null while it is not registered yet. */
	private languageGuessFor(): string | null {
		try {
			return this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(this.filePath.replace(/\\/g, '/')));
		} catch {
			return null;
		}
	}
}

/**
 * Merged diff row count for the renderable check — the legacy path's own
 * line count (adds + deletions + context). Common prefix/suffix trimming
 * inside computeDiffLines keeps this cheap for typical edits, and its OOM
 * guard covers giant rewrites.
 */
function computeMergedLineCount(original: string, updated: string): number {
	return computeDiffLines(original, updated).length;
}
