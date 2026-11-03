/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 228: the shared "Editor Mode" submenu id (Preview ✓ / Markdown /
 * Save to Workspace — Phase 225) lives in a LEAF module on purpose. The
 * rendered plan doc pane (Phase 226) opens this same menu from its header
 * "..." while the markdown resolver module (Phase 225) imports the pane
 * module for the plan-doc delegation — that markdown ⇄ planDocPane import
 * cycle threw "Cannot access 'VIBE_AI_PLAN_DOC_PANE_ID' before
 * initialization" at startup whenever the pane module was loaded first:
 * the resolver's module-top-level EditorTitle registration evaluated a
 * ContextKeyExpr that read a binding from the still-initializing pane
 * module. Both sides import the id from here instead; no back-edge.
 */

import { URI } from '../../../../base/common/uri.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

export const VIBE_AI_EDITOR_MODE_MENU = new MenuId('vibeAIMarkdownEditorModeMenu');

// ==================== per-file mode storage (Phase 229) ====================
//
// The mode helpers live in this leaf module so BOTH consumers import them
// without touching each other: the markdown resolver (vibeAIMarkdown.ts —
// md family) and the plan doc pane (vibeAIPlanDocPane.ts — Phase 229 hosts
// both views and persists switches from its "..." menu). Importing the
// helpers from vibeAIMarkdown.ts would re-create the markdown ⇄
// planDocPane import cycle that already crashed startup once (TDZ, see
// vibeAIMarkdown.ts).

export type MarkdownEditorMode = 'preview' | 'markdown';

/** Per-file mode memory (Cursor: "The mode is saved per file"). */
export const MARKDOWN_MODE_STORAGE_KEY = 'vibeAI.markdown.editorModes';
const MARKDOWN_MODE_STORAGE_CAP = 500;

function readMarkdownModes(storage: IStorageService): Record<string, MarkdownEditorMode> {
	try {
		return JSON.parse(storage.get(MARKDOWN_MODE_STORAGE_KEY, StorageScope.APPLICATION, '{}')) as Record<string, MarkdownEditorMode>;
	} catch {
		return {};
	}
}

/** Per-file mode of a resource; files never switched default to Preview. */
export function getMarkdownEditorMode(storage: IStorageService, uriIdentityService: IUriIdentityService, resource: URI): MarkdownEditorMode {
	return readMarkdownModes(storage)[uriIdentityService.asCanonicalUri(resource).toString()] ?? 'preview';
}

/** Records the mode and evicts the oldest entry past the cap (insertion-ordered store). */
export function writeMarkdownEditorMode(storage: IStorageService, uriIdentityService: IUriIdentityService, resource: URI, mode: MarkdownEditorMode): void {
	const key = uriIdentityService.asCanonicalUri(resource).toString();
	const modes = readMarkdownModes(storage);
	delete modes[key];
	const entries = Object.entries(modes);
	entries.push([key, mode]);
	const trimmed = entries.slice(Math.max(0, entries.length - MARKDOWN_MODE_STORAGE_CAP));
	storage.store(MARKDOWN_MODE_STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)), StorageScope.APPLICATION, StorageTarget.MACHINE);
}
