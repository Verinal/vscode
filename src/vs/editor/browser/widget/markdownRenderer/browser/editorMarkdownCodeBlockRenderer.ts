/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { basename } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IMarkdownCodeBlockRenderer, IMarkdownRendererExtraOptions } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { EditorOption, IEditorOptions } from '../../../../common/config/editorOptions.js';
import { BareFontInfo } from '../../../../common/config/fontInfo.js';
import { createBareFontInfoFromRawSettings } from '../../../../common/config/fontInfoFromSettings.js';
import { ILanguageService } from '../../../../common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../common/languages/modesRegistry.js';
import { tokenizeToString } from '../../../../common/languages/textToHtmlTokenizer.js';
import { applyFontInfo } from '../../../config/domFontInfo.js';
import { ICodeEditor, isCodeEditor } from '../../../editorBrowser.js';
import { localize } from '../../../../../nls.js';
import './renderedMarkdown.css';

/** Matches file-name-like tokens (e.g. "app.tsx", "src/foo.py"). */
const FILE_LIKE_PATTERN = /^[\w.\-/\\]+\.\w{1,5}$/;

/** Code blocks longer than this many lines are clamped with an expand pill. */
const MAX_COLLAPSED_LINES = 20;

/**
 * The fence info string may carry a file name after the language
 * (e.g. ```tsx src/app.tsx or ```python:11.py) — prefer it for the code
 * block header title, falling back to the language itself.
 */
function getCodeBlockTitle(languageAlias: string | undefined, rawInfo: string | undefined): { label: string; path?: string } {
	if (rawInfo) {
		for (const token of rawInfo.split(/[\s,:?{}|+]+/).slice(1)) {
			if (FILE_LIKE_PATTERN.test(token)) {
				return { label: basename(token), path: token };
			}
		}
	}
	if (languageAlias && FILE_LIKE_PATTERN.test(languageAlias)) {
		return { label: basename(languageAlias), path: languageAlias };
	}
	return { label: languageAlias ?? '' };
}

/**
 * Renders markdown code blocks using the editor's tokenization and font settings.
 *
 * When the caller opts in ({@link IMarkdownRendererExtraOptions.codeBlockHeader}),
 * the block is wrapped with a header showing the file name or language on the
 * left and a hover-revealed copy button on the right.
 */
export class EditorMarkdownCodeBlockRenderer implements IMarkdownCodeBlockRenderer {

	private static _ttpTokenizer = createTrustedTypesPolicy('tokenizeToString', {
		createHTML(html: string) {
			return html;
		}
	});

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) { }

	public async renderCodeBlock(languageAlias: string | undefined, value: string, options: IMarkdownRendererExtraOptions, rawInfo?: string): Promise<HTMLElement> {
		const editor = isCodeEditor(options.context) ? options.context : undefined;

		// In markdown, it is possible that we stumble upon language aliases (e.g.js instead of javascript).
		// it is possible no alias is given in which case we fall back to the current editor lang
		let languageId: string | undefined | null;
		if (languageAlias) {
			languageId = this._languageService.getLanguageIdByLanguageName(languageAlias);
		} else if (editor) {
			languageId = editor.getModel()?.getLanguageId();
		}
		if (!languageId) {
			// The fence may name a file (```python:11.py — the alias above
			// already resolves — or a bare ```11.py): the file extension tells
			// the syntax, so derive the language from the file name.
			languageId = this.guessLanguageIdFromFileName(languageAlias, rawInfo);
		}
		if (!languageId) {
			languageId = PLAINTEXT_LANGUAGE_ID;
		}
		const html = await tokenizeToString(this._languageService, value, languageId);

		const content = EditorMarkdownCodeBlockRenderer._ttpTokenizer ? EditorMarkdownCodeBlockRenderer._ttpTokenizer.createHTML(html) ?? html : html;

		const root = document.createElement('span');
		root.innerHTML = content as string;
		// eslint-disable-next-line no-restricted-syntax
		const codeElement = root.querySelector('.monaco-tokenized-source');
		if (!isHTMLElement(codeElement)) {
			return document.createElement('span');
		}

		applyFontInfo(codeElement, this.getFontInfo(editor));

		// Opt-in (e.g. from the vibeAI chat view): a ChatGPT/GitHub-style header
		// bar overlaying the top of the block — file name or language on the
		// left, a hover-revealed copy button on the right.
		if (options.codeBlockHeader) {
			return this.withCodeBlockHeader(root, value, languageAlias, rawInfo, this._languageService.getLanguageName(languageId) ?? undefined);
		}

		return root;
	}

	/**
	 * Derives a tokenization language from a file name in the fence
	 * (e.g. ```11.py) — the file extension tells the syntax. Returns
	 * undefined when no file-name-like token yields a language.
	 */
	private guessLanguageIdFromFileName(languageAlias: string | undefined, rawInfo: string | undefined): string | undefined {
		const candidates: string[] = [];
		if (languageAlias) {
			candidates.push(languageAlias);
		}
		if (rawInfo) {
			for (const token of rawInfo.split(/[\s,:?{}|+]+/)) {
				if (token) {
					candidates.push(token);
				}
			}
		}
		for (const candidate of candidates) {
			if (!FILE_LIKE_PATTERN.test(candidate)) {
				continue;
			}
			try {
				const guessed = this._languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(candidate.replace(/\\/g, '/')));
				if (guessed) {
					return guessed;
				}
			} catch {
				// ignore and try the next candidate
			}
		}
		return undefined;
	}

	/**
	 * Wraps the tokenized source in a headered block. The header shows the
	 * file name when the fence info string carries one (e.g. ```tsx src/app.tsx),
	 * otherwise the language. The copy button is revealed while the block is
	 * hovered or focused.
	 */
	private withCodeBlockHeader(root: HTMLElement, value: string, languageAlias: string | undefined, rawInfo: string | undefined, languageName: string | undefined): HTMLElement {
		const block = document.createElement('div');
		block.className = 'vibe-ai-code-block';

		const header = document.createElement('div');
		header.className = 'vibe-ai-code-block-header';
		header.style.userSelect = 'none';

		const titleInfo = getCodeBlockTitle(languageAlias, rawInfo);

		const titleGroup = document.createElement('span');
		titleGroup.className = 'vibe-ai-code-block-title-group';
		if (titleInfo.path) {
			const fileIcon = document.createElement('span');
			fileIcon.className = 'codicon codicon-file';
			fileIcon.setAttribute('aria-hidden', 'true');
			titleGroup.appendChild(fileIcon);
		}
		const title = document.createElement('span');
		title.className = 'vibe-ai-code-block-title';
		title.textContent = titleInfo.label || languageName || '';
		if (titleInfo.path && titleInfo.path !== titleInfo.label) {
			title.title = titleInfo.path;
		}
		titleGroup.appendChild(title);

		const copyButton = document.createElement('button');
		copyButton.type = 'button';
		copyButton.className = 'vibe-ai-code-block-copy';
		copyButton.title = localize('copyCodeBlock', "Copy");
		copyButton.setAttribute('aria-label', localize('copyCodeBlock', "Copy"));
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-copy';
		icon.setAttribute('aria-hidden', 'true');
		copyButton.appendChild(icon);

		const codeBlockWindow = getWindow(block);
		let copiedResetTimer: number | undefined;
		copyButton.addEventListener('click', async event => {
			event.preventDefault();
			event.stopPropagation();
			if (!value) {
				return;
			}
			try {
				await this._clipboardService.writeText(value);
			} catch {
				return;
			}
			status(localize('codeBlockCopied', "Copied to clipboard"));
			// Brief check-mark feedback, like the built-in hover copy button.
			icon.className = 'codicon codicon-check';
			copyButton.classList.add('copied');
			if (copiedResetTimer !== undefined) {
				codeBlockWindow.clearTimeout(copiedResetTimer);
			}
			copiedResetTimer = codeBlockWindow.setTimeout(() => {
				copiedResetTimer = undefined;
				icon.className = 'codicon codicon-copy';
				copyButton.classList.remove('copied');
			}, 1600);
		});

		header.append(titleGroup, copyButton);

		const body = document.createElement('div');
		body.className = 'vibe-ai-code-block-body';
		while (root.firstChild) {
			body.appendChild(root.firstChild);
		}

		block.append(header, body);

		// Long code is clamped to ~20 lines (CSS max-height) and gets a
		// hover-revealed expand pill at the very bottom; short code renders
		// in full with no clamp.
		const lineCount = value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
		if (lineCount > MAX_COLLAPSED_LINES) {
			const expandButton = document.createElement('button');
			expandButton.type = 'button';
			expandButton.className = 'vibe-ai-code-block-expand';
			expandButton.setAttribute('aria-expanded', 'false');
			const pill = document.createElement('span');
			pill.className = 'vibe-ai-code-block-expand-pill';
			const chevron = document.createElement('span');
			chevron.className = 'codicon codicon-chevron-down';
			chevron.setAttribute('aria-hidden', 'true');
			const label = document.createElement('span');
			label.textContent = localize('expandCodeBlock', "Expand");
			pill.append(chevron, label);
			expandButton.appendChild(pill);
			expandButton.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				const expanded = block.classList.toggle('expanded');
				expandButton.setAttribute('aria-expanded', String(expanded));
				chevron.className = expanded ? 'codicon codicon-chevron-up' : 'codicon codicon-chevron-down';
				label.textContent = expanded ? localize('collapseCodeBlock', "Collapse") : localize('expandCodeBlock', "Expand");
			});
			block.appendChild(expandButton);
		}

		return block;
	}

	private getFontInfo(editor: ICodeEditor | undefined): BareFontInfo {
		// Use editor's font if we have one
		if (editor) {
			return editor.getOption(EditorOption.fontInfo);
		} else {
			// Otherwise use the global font settings.
			// Pass in fake pixel ratio of 1 since we only need the font info to apply font family
			return createBareFontInfoFromRawSettings({
				fontFamily: this._configurationService.getValue<IEditorOptions>('editor').fontFamily
			}, 1);
		}
	}
}
