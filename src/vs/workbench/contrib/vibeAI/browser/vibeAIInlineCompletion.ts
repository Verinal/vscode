/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Position } from '../../../../editor/common/core/position.js';
import {
	InlineCompletionContext,
	InlineCompletionTriggerKind,
	InlineCompletions,
	InlineCompletionsProvider,
} from '../../../../editor/common/languages.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IVibeAIService } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IVibeAIStats } from './vibeAIStats.js';
import { VibeAIModelStore } from './vibeAIModelStore.js';

/**
 * Cursor-style Tab completion: turns a short typing pause into ghost text
 * fetched from the local VibeCoding backend (`POST /api/completion`, FIM
 * style). Registered for all languages by the vibeAI workbench contribution.
 */

const DEBOUNCE_MS = 250;           // idle window before a request is sent
const MAX_PREFIX_CHARS = 2000;     // clip of the text before the cursor
const MAX_SUFFIX_CHARS = 500;      // clip of the text after the cursor
const PREFIX_MAX_LINES = 300;      // line window scanned before the cursor
const SUFFIX_MAX_LINES = 60;       // line window scanned after the cursor

function wait(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export class VibeAIInlineCompletionProvider implements InlineCompletionsProvider {

	private requestCounter = 0;
	private readonly modelStore: VibeAIModelStore;

	constructor(
		@IVibeAIService private readonly vibeAIService: IVibeAIService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVibeAIStats private readonly stats: IVibeAIStats,
		@IStorageService storageService: IStorageService,
	) {
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
	}

	/**
	 * Cursor-parity Tab Stats: reports a shown ghost text so the status bar
	 * can surface "Tab Stats: shown/accepted (pct%)".
	 */
	handleItemDidShow(): void {
		this.stats.reportShown();
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<InlineCompletions | undefined> {
		if (!this.configurationService.getValue<boolean>('vibeAI.inlineCompletion.enabled', { resource: model.uri })) {
			return undefined;
		}

		// Custom models only (no default-model fallback): Tab completion goes
		// to the editor's resolved model provider (Settings → Models). Nothing
		// configured → skip silently (no ghost text, no backend request).
		const provider = this.modelStore.resolveEditorModelProvider();
		if (!provider) {
			return undefined;
		}

		// Don't suggest while overtyping a selected suggestion.
		if (context.selectedSuggestionInfo) {
			return undefined;
		}

		// FIM context: text before / after the cursor, clipped to keep the
		// request payload small even in large files.
		const prefixStartLine = Math.max(1, position.lineNumber - PREFIX_MAX_LINES);
		const prefix = model.getValueInRange({
			startLineNumber: prefixStartLine,
			startColumn: 1,
			endLineNumber: position.lineNumber,
			endColumn: position.column,
		});
		if (prefix.trim().length === 0) {
			return undefined; // no context at all (e.g. start of file)
		}
		const suffixEndLine = Math.min(model.getLineCount(), position.lineNumber + SUFFIX_MAX_LINES);
		const suffix = model.getValueInRange({
			startLineNumber: position.lineNumber,
			startColumn: position.column,
			endLineNumber: suffixEndLine,
			endColumn: model.getLineMaxColumn(suffixEndLine),
		});

		// Debounce: the engine re-triggers on every keystroke; wait for a short
		// idle window before hitting the backend. The token is cancelled when a
		// newer request supersedes this one, which discards stale requests.
		if (context.triggerKind === InlineCompletionTriggerKind.Automatic) {
			await wait(DEBOUNCE_MS);
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		const requestId = `inline-${++this.requestCounter}`;
		this.logService.trace(`[VibeAI] requesting inline completion (${requestId})`);

		const completion = await this.vibeAIService.complete({
			prefix: prefix.length > MAX_PREFIX_CHARS ? prefix.substring(prefix.length - MAX_PREFIX_CHARS) : prefix,
			suffix: suffix.length > MAX_SUFFIX_CHARS ? suffix.substring(0, MAX_SUFFIX_CHARS) : suffix,
			language: model.getLanguageId(),
			provider,
		});

		if (token.isCancellationRequested || !completion) {
			return undefined;
		}
		this.logService.trace(`[VibeAI] inline completion received (${requestId}, ${completion.length} chars)`);

		// No `range` — the text is inserted at the cursor position as ghost text.
		return { items: [{ insertText: completion }] };
	}

	disposeInlineCompletions(): void {
		// Nothing cached — completions are fetched per request.
	}
}
