/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRenderedMarkdown, MarkdownRenderOptions, renderMarkdown } from '../../../base/browser/markdownRenderer.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { IMarkdownString, MarkdownStringTrustedOptions } from '../../../base/common/htmlContent.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IOpenerService } from '../../opener/common/opener.js';

/**
 * Renders markdown to HTML.
 *
 * This interface allows a upper level component to pass a custom markdown renderer to sub-components.
 *
 * If you want to render markdown content in a standard way, prefer using the {@linkcode IMarkdownRendererService}.
 */
export interface IMarkdownRenderer {
	render(markdown: IMarkdownString, options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown;
}

export interface IMarkdownRendererExtraOptions {
	/**
	 * The context in which the markdown is being rendered.
	 */
	readonly context?: unknown;
	/**
	 * Render a header above each code block showing the file name or language
	 * together with a hover-revealed copy button.
	 */
	readonly codeBlockHeader?: boolean;
	/**
	 * Make inline code spans that are plain http(s) URLs clickable: a plain
	 * click opens the URL in the built-in Simple Browser, Ctrl/Cmd+Click
	 * opens it in the system default browser.
	 */
	readonly inlineCodeLinks?: boolean;
	/**
	 * Reroutes fence language aliases before native resolution (lowercase
	 * alias → replacement alias, e.g. `{ powershell: 'shellscript' }`).
	 * Aliases that resolve nowhere (```shell, ```console) tokenize plain;
	 * others (```powershell) resolve to a grammar that colors bare dev
	 * commands not at all — both render white next to a colored ```bash
	 * block. The chat view maps the shell family onto shellscript.
	 */
	readonly languageAliases?: Record<string, string>;
}

export interface IMarkdownCodeBlockRenderer {
	renderCodeBlock(languageAlias: string | undefined, value: string, options: IMarkdownRendererExtraOptions, rawInfo?: string): Promise<HTMLElement>;
}


export const IMarkdownRendererService = createDecorator<IMarkdownRendererService>('markdownRendererService');

/**
 * Service that renders markdown content in a standard manner.
 *
 * Unlike the lower-level {@linkcode renderMarkdown} function, this includes built-in support for features such as syntax
 * highlighting of code blocks and link handling.
 *
 * This service should be preferred for rendering markdown in most cases.
 */
export interface IMarkdownRendererService extends IMarkdownRenderer {
	readonly _serviceBrand: undefined;

	render(markdown: IMarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions, outElement?: HTMLElement): IRenderedMarkdown;

	setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void;
}


export class MarkdownRendererService implements IMarkdownRendererService {
	declare readonly _serviceBrand: undefined;

	private _defaultCodeBlockRenderer: IMarkdownCodeBlockRenderer | undefined;

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@ICommandService private readonly _commandService: ICommandService,
	) { }

	render(markdown: IMarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions, outElement?: HTMLElement): IRenderedMarkdown {
		const resolvedOptions = { ...options };

		if (!resolvedOptions.actionHandler) {
			resolvedOptions.actionHandler = (link, mdStr) => {
				return openLinkFromMarkdown(this._openerService, link, mdStr.isTrusted);
			};
		}

		if (!resolvedOptions.codeBlockRenderer) {
			resolvedOptions.codeBlockRenderer = (alias, value, info) => {
				return this._defaultCodeBlockRenderer?.renderCodeBlock(alias, value, resolvedOptions ?? {}, info) ?? Promise.resolve(document.createElement('span'));
			};
		}

		const rendered = renderMarkdown(markdown, resolvedOptions, outElement);
		rendered.element.classList.add('rendered-markdown');
		if (resolvedOptions.inlineCodeLinks) {
			attachInlineCodeLinks(rendered.element, this._openerService, this._commandService);
		}
		return rendered;
	}

	setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void {
		this._defaultCodeBlockRenderer = renderer;
	}
}

/** Inline code spans whose entire trimmed text is an http(s) URL become clickable. */
const INLINE_CODE_LINK_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Links up inline code chips that are plain web URLs: a plain click opens
 * the URL in the built-in Simple Browser (a webview editor in the editor
 * area), Ctrl/Cmd+Click opens it in the system default browser. Code inside
 * fenced blocks never linkifies — only inline chips do.
 */
function attachInlineCodeLinks(root: HTMLElement, openerService: IOpenerService, commandService: ICommandService): void {
	// eslint-disable-next-line no-restricted-syntax
	for (const codeElement of root.querySelectorAll('code')) {
		const url = codeElement.textContent?.trim() ?? '';
		if (!INLINE_CODE_LINK_PATTERN.test(url)) {
			continue;
		}
		if (codeElement.closest('pre, [data-code], .vibe-ai-code-block')) {
			continue;
		}
		codeElement.classList.add('inline-code-link');
		codeElement.title = localize('inlineCodeLink.tooltip', "Click to open in the built-in browser. Ctrl+Click to open in the system default browser.");
		codeElement.tabIndex = 0;
		codeElement.addEventListener('click', event => {
			if (event.defaultPrevented) {
				return;
			}
			// A drag-selection ending on the chip must not navigate.
			const selection = codeElement.ownerDocument.getSelection();
			if (selection && !selection.isCollapsed && selection.containsNode(codeElement, true)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			openInlineCodeLink(commandService, openerService, url, event.ctrlKey || event.metaKey);
		});
		codeElement.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			openInlineCodeLink(commandService, openerService, url, event.ctrlKey || event.metaKey);
		});
	}
}

function openInlineCodeLink(commandService: ICommandService, openerService: IOpenerService, url: string, openExternal: boolean): void {
	if (openExternal) {
		openInlineCodeLinkExternal(openerService, url);
		return;
	}
	// Built-in browser — the simple-browser webview editor in the editor area.
	commandService.executeCommand('simpleBrowser.show', url).catch(() => {
		// simple-browser unavailable — fall back to the system default browser
		openInlineCodeLinkExternal(openerService, url);
	});
}

async function openInlineCodeLinkExternal(openerService: IOpenerService, url: string): Promise<void> {
	try {
		await openerService.open(URI.parse(url), { openExternal: true, fromUserGesture: true });
	} catch (e) {
		onUnexpectedError(e);
	}
}

export async function openLinkFromMarkdown(openerService: IOpenerService, link: string, isTrusted: boolean | MarkdownStringTrustedOptions | undefined, skipValidation?: boolean): Promise<boolean> {
	try {
		return await openerService.open(link, {
			fromUserGesture: true,
			allowContributedOpeners: true,
			allowCommands: toAllowCommandsOption(isTrusted),
			skipValidation
		});
	} catch (e) {
		onUnexpectedError(e);
		return false;
	}
}

function toAllowCommandsOption(isTrusted: boolean | MarkdownStringTrustedOptions | undefined): boolean | readonly string[] {
	if (isTrusted === true) {
		return true; // Allow all commands
	}

	if (isTrusted && Array.isArray(isTrusted.enabledCommands)) {
		return isTrusted.enabledCommands; // Allow subset of commands
	}

	return false; // Block commands
}

registerSingleton(IMarkdownRendererService, MarkdownRendererService, InstantiationType.Delayed);
