/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 225: markdown files open Cursor-style — the rendered Markdown
 * preview (`vscode.markdown.preview.editor`) is the DEFAULT editor for the
 * md family, an "Editor Mode" submenu in the editor title menu switches
 * between Preview and the raw text ("Markdown") editor, offers Save to
 * Workspace for unsaved (untitled) docs (grayed otherwise, Cursor parity),
 * and the chosen mode
 * is remembered per file (user: 「應該默認就是md preview+editor，然後才可以選擇
 * markdown」— the reference is Cursor's Editor Mode menu, where Preview is
 * the checked default and Markdown is the alternative).
 *
 * How it hooks in: an `exclusive`-priority editor resolver for the md glob
 * family outranks every custom-editor `option` registration and the
 * Agents-window `workbench.editorAssociations` default (default selection
 * short-circuits on an exclusive candidate before associations are
 * consulted), so this single registration decides the default in both the
 * IDE window (which had none — raw text) and the Agent window (which had
 * the rich `vscode.markdown.editor` via
 * `workbench.editor.markdownDefaultEditorInAgentsWindow`). An explicit
 * `options.override` (or the `reopenActiveEditorWith` command the menu
 * items use) still bypasses this resolver entirely — that is what every
 * editing-intent open relies on (plan-doc streaming, line jumps, Customize
 * open-file all pass `override: DEFAULT_EDITOR_ASSOCIATION.id`).
 * Diffs/merges are untouched: this registration deliberately provides no
 * diff/merge factories and the resolver skips factory-less registrations
 * for those input kinds.
 *
 * Phase 252: preview mode opens the built-in hybrid (WYSIWYG) Markdown
 * editor (`vscode.markdown.editor`) instead of the read-only static preview
 * — Cursor's Preview is directly editable. The Editor Mode switch moved
 * from an EditorTitle submenu into always-visible "Preview | Markdown"
 * buttons next to the file row, and `breadcrumbs.filePath` now defaults to
 * 'last' so the breadcrumb row shows the bare file name like Cursor's
 * "ⓘ file.md" row.
 *
 * Phase 256: the switch's home is the breadcrumb bar's right-aligned
 * actions slot (`MenuId.BreadcrumbsTitle`, hosted by BreadcrumbsControl) —
 * Cursor renders the toggle in the "ⓘ file.md" row itself, while the
 * previous homes (title-bar pair, Phase 254's in-content pill inside the
 * webview) either sat a row too high or duplicated the toggle under the
 * lock/pencil control. The plan pane header "..." keeps enumerating the
 * same actions from the submenu id.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { CustomEditorInput } from '../../customEditor/browser/customEditorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextEditorService } from '../../../services/textfile/common/textEditorService.js';
import { URI } from '../../../../base/common/uri.js';
import { VibeAIChatPane } from './vibeAIChatPane.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getMarkdownEditorMode, MARKDOWN_MODE_STORAGE_KEY, MarkdownEditorMode, VIBE_AI_EDITOR_MODE_MENU, writeMarkdownEditorMode } from './vibeAIEditorMode.js';
import { createPlanDocEditorInput, isPlanDocResource, parsePlanDocText, planFromDoc, VibeAIPlanDocInput, VibeAIPlanDocPane, VIBE_AI_PLAN_DOC_EDITOR_ID, VIBE_AI_PLAN_DOC_PANE_ID } from './vibeAIPlanDocPane.js';
import { VibeAIModelStore } from './vibeAIModelStore.js';

/** View type of the built-in rendered Markdown preview tab (StaticMarkdownPreview). */
const MARKDOWN_PREVIEW_VIEW_TYPE = 'vscode.markdown.preview.editor';

/**
 * Phase 252: view type of the built-in hybrid (WYSIWYG) Markdown editor.
 * Cursor's "Preview" is an EDITABLE rendered view (user: 「人家的preview是直接
 * 可以編輯的，我們根本沒做到」), so the resolver's preview mode now opens this
 * instead of the read-only static preview — same upstream component the
 * classic preview shares its styling with, TextDocument stays the single
 * source of truth (native undo/redo, dirty state, hot-exit). The static
 * preview stays reachable via "Open With…"; both webviews count as the
 * 'preview' mode everywhere below (mode memory, context key, reopen).
 */
const MARKDOWN_RICH_EDITOR_VIEW_TYPE = 'vscode.markdown.editor';

function isMarkdownPreviewViewType(viewType: string | undefined): boolean {
	return viewType === MARKDOWN_PREVIEW_VIEW_TYPE || viewType === MARKDOWN_RICH_EDITOR_VIEW_TYPE;
}

/**
 * Exclusive resolver id. Must NOT be `DEFAULT_EDITOR_ASSOCIATION.id`
 * ('default') — the resolver's default selection excludes the built-in text
 * editor id from its candidates, so reusing it would silently disable the
 * whole registration.
 */
const MARKDOWN_RESOLVER_ID = 'vibeAI.markdown.default';

/** Same md family the built-in markdown extension selects on (minus the exotic litcoffee/ron/workbook extras). */
const MARKDOWN_GLOB = '*.{md,mkd,mkdn,mdwn,mdown,markdown,markdn,mdtxt,mdtext}';

const MARKDOWN_EXTENSIONS = ['.md', '.mkd', '.mkdn', '.mdwn', '.mdown', '.markdown', '.markdn', '.mdtxt', '.mdtext'];

// Per-file mode memory (Cursor: "The mode is saved per file") lives in
// ./vibeAIEditorMode.js — a leaf module both this resolver and the plan
// doc pane import (the pane persists in-place switches, Phase 229).

function isMarkdownFamilyResource(uri: URI): boolean {
	const path = uri.path.toLowerCase();
	return MARKDOWN_EXTENSIONS.some(ext => path.endsWith(ext));
}

/** Mode of the active markdown editor — drives the ✓ marks of the Editor Mode items. */
const CONTEXT_VIBE_AI_MARKDOWN_MODE = new RawContextKey<string | undefined>('vibeAIMarkdownMode', undefined, {
	type: 'string',
	description: localize('vibeAIMarkdown.modeContext', "The Editor Mode of the active markdown editor ('preview' or 'markdown')."),
});

// VIBE_AI_EDITOR_MODE_MENU lives in ./vibeAIEditorMode.js — a leaf module:
// defining it here (and having the plan doc pane import it back) made a
// markdown ⇄ planDocPane import cycle that crashed at startup with
// "Cannot access 'VIBE_AI_PLAN_DOC_PANE_ID' before initialization".

async function setModeAndReopen(accessor: ServicesAccessor, mode: MarkdownEditorMode, overrideViewType: string): Promise<unknown> {
	const editorService = accessor.get(IEditorService);
	const resource = editorService.activeEditorPane?.input?.resource;
	// Phase 229: the plan pane hosts BOTH modes — a switch from its header
	// "..." menu swaps the view in place and persists. A reopen would land
	// on the very same per-resource input and not rebuild the pane, so the
	// reopen path below is only for the bare text editor (line-jump opens).
	const activePane = editorService.activeEditorPane;
	if (activePane instanceof VibeAIPlanDocPane && activePane.input instanceof VibeAIPlanDocInput) {
		activePane.setEditorViewMode(mode);
		return undefined;
	}
	if (resource) {
		writeMarkdownEditorMode(accessor.get(IStorageService), accessor.get(IUriIdentityService), resource, mode);
	}
	// Same channel the built-in markdown extension's reopen commands use —
	// an explicit override resolves the target editor directly and bypasses
	// this contribution's exclusive default resolver.
	return accessor.get(ICommandService).executeCommand('reopenActiveEditorWith', overrideViewType);
}

/**
 * Phase 256: when-clause of the "Preview | Markdown" toggle — the segmented
 * pair renders in the breadcrumb bar's right-aligned actions slot
 * (MenuId.BreadcrumbsTitle, hosted by BreadcrumbsControl), Cursor parity for
 * the "ⓘ file.md" row. BOTH modes show the pair — the active mode is the
 * highlighted one: preview mode needs the way back to raw, raw mode the way
 * back to preview (the Phase 254 title-bar pair only served raw editors and
 * the Phase 254 in-content pill is gone — it duplicated the toggle inside
 * the webview). Excluded: the rendered plan pane (its header "..." carries
 * the same actions, Phase 228) and notebooks.
 */
const MARKDOWN_MODE_TOGGLE_WHEN = ContextKeyExpr.and(
	ContextKeyExpr.or(
		ContextKeyExpr.equals(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, 'preview'),
		ContextKeyExpr.equals(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, 'markdown'),
	),
	ContextKeyExpr.notEquals('activeEditor', VIBE_AI_PLAN_DOC_PANE_ID),
	ContextKeyExpr.not('notebookEditorFocused'),
);

export class VibeAIMarkdownModePreviewAction extends Action2 {
	static readonly ID = 'vibeAI.markdown.modePreview';

	constructor() {
		super({
			id: VibeAIMarkdownModePreviewAction.ID,
			title: localize2('vibeAIMarkdown.modePreview', "Preview"),
			f1: true,
			toggled: ContextKeyExpr.equals(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, 'preview'),
			// Phase 252: mode switch as ALWAYS-VISIBLE buttons — Cursor renders
			// the switch as "Preview | Markdown" pills next to the file row, a
			// submenu buried in the "..." overflow reads as "nothing there".
			// Phase 256: the pair lives in the breadcrumb bar's actions slot
			// (Cursor's "ⓘ file.md" row), in BOTH modes.
			menu: [
				{ id: VIBE_AI_EDITOR_MODE_MENU, order: 1 },
				{ id: MenuId.BreadcrumbsTitle, group: 'navigation', order: 1, when: MARKDOWN_MODE_TOGGLE_WHEN },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		// Phase 228: plan docs' Preview is the rendered plan pane, NOT the
		// built-in markdown preview webview (which mangles the front matter
		// into a table and, once reached, left no menu path back — user got
		// stuck). Reopening with the resolver registration id routes through
		// this contribution's plan-doc delegation to the plan pane.
		// Phase 252: Preview is the editable WYSIWYG rich editor (Cursor parity) —
		// the read-only static preview remains available via "Open With…".
		const resource = accessor.get(IEditorService).activeEditorPane?.input?.resource;
		if (resource && isPlanDocResource(resource)) {
			return setModeAndReopen(accessor, 'preview', MARKDOWN_RESOLVER_ID);
		}
		return setModeAndReopen(accessor, 'preview', MARKDOWN_RICH_EDITOR_VIEW_TYPE);
	}
}

export class VibeAIMarkdownModeMarkdownAction extends Action2 {
	static readonly ID = 'vibeAI.markdown.modeMarkdown';

	constructor() {
		super({
			id: VibeAIMarkdownModeMarkdownAction.ID,
			title: localize2('vibeAIMarkdown.modeMarkdown', "Markdown"),
			f1: true,
			toggled: ContextKeyExpr.equals(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, 'markdown'),
			menu: [
				{ id: VIBE_AI_EDITOR_MODE_MENU, order: 2 },
				{ id: MenuId.BreadcrumbsTitle, group: 'navigation', order: 2, when: MARKDOWN_MODE_TOGGLE_WHEN },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		// Phase 229: plan docs go to the raw view INSIDE the plan pane —
		// setModeAndReopen swaps it in place when the pane is active; this
		// resolver-id reopen covers a plan doc sitting in a bare text
		// editor (line-jump override) and routes it back through the
		// resolver into the pane's raw view.
		const resource = accessor.get(IEditorService).activeEditorPane?.input?.resource;
		if (resource && isPlanDocResource(resource)) {
			return setModeAndReopen(accessor, 'markdown', MARKDOWN_RESOLVER_ID);
		}
		return setModeAndReopen(accessor, 'markdown', DEFAULT_EDITOR_ASSOCIATION.id);
	}
}

export class VibeAIMarkdownSaveToWorkspaceAction extends Action2 {
	static readonly ID = 'vibeAI.markdown.saveToWorkspace';

	constructor() {
		super({
			id: VibeAIMarkdownSaveToWorkspaceAction.ID,
			title: localize2('vibeAIMarkdown.saveToWorkspace', "Save to Workspace"),
			f1: true,
			// Cursor parity: grayed for documents that already live inside
			// the workspace — only unsaved (untitled) documents enable it.
			precondition: ContextKeyExpr.equals('resourceScheme', 'untitled'),
			menu: [{ id: VIBE_AI_EDITOR_MODE_MENU, group: '2_save', order: 1 }],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		// The active editor is an untitled document (precondition) — the
		// built-in save flow brings the file dialog, associates the path
		// and keeps editing in the saved tab.
		return accessor.get(ICommandService).executeCommand('workbench.action.files.save');
	}
}

registerAction2(VibeAIMarkdownModePreviewAction);
registerAction2(VibeAIMarkdownModeMarkdownAction);
registerAction2(VibeAIMarkdownSaveToWorkspaceAction);

// ==================== Phase 228: plan doc controls in the raw ("Markdown") mode ====================

/**
 * Cursor's markdown mode keeps the model picker + Build + "..." in the same
 * row (editor title bar, image 3). The raw text editor can't host the plan
 * pane's in-page header, so the plan-doc controls register as editor title
 * actions — always-visible `navigation` buttons scoped to plan docs in
 * markdown mode (the rendered pane carries mode 'preview', so they hide
 * there where the pane header already has Build + model + "...").
 */
const PLAN_DOC_RAW_MODE_WHEN = ContextKeyExpr.and(
	ContextKeyExpr.regex('resourcePath', /\.plan\.md$/i),
	ContextKeyExpr.equals(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, 'markdown'),
	// Phase 229: the plan pane hosts the raw view with its own header
	// controls (Build + model + "...") — these title-bar buttons are only
	// for a plan doc that a line-jump override opened in a bare text editor.
	ContextKeyExpr.notEquals('activeEditor', VIBE_AI_PLAN_DOC_PANE_ID),
	ContextKeyExpr.not('notebookEditorFocused'),
);

export class VibeAIPlanDocBuildAction extends Action2 {
	static readonly ID = 'vibeAI.planDoc.build';

	constructor() {
		super({
			id: VibeAIPlanDocBuildAction.ID,
			title: localize2('vibeAIPlanMarkdown.build', "Build"),
			f1: true,
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 999, when: PLAN_DOC_RAW_MODE_WHEN }],
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const resource = editorService.activeEditorPane?.input?.resource;
		if (!resource || !isPlanDocResource(resource)) {
			return;
		}
		// The raw mode's text model IS the doc — parse the front matter live
		// so manual edits before Build are honored.
		const control = editorService.activeTextEditorControl;
		const parsed = parsePlanDocText((isCodeEditor(control) ? control.getModel()?.getValue() : '') ?? '');
		if (parsed.todos.length === 0) {
			return; // Same silent no-op as the rendered pane's Build.
		}
		accessor.get(IViewsService).openView(VibeAIChatPane.ID, false).then(view => {
			if (view) {
				void (view as VibeAIChatPane).buildPlanFromDoc(resource.fsPath.replace(/\\/g, '/'), planFromDoc(parsed));
			}
		}, () => {
			// The chat view is unavailable (agent window without it) —
			// the hub's decision card remains the execution path.
		});
	}
}

export class VibeAIPlanDocModelAction extends Action2 {
	static readonly ID = 'vibeAI.planDoc.model';

	constructor() {
		super({
			id: VibeAIPlanDocModelAction.ID,
			title: localize2('vibeAIPlanMarkdown.model', "Model"),
			f1: true,
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 998, when: PLAN_DOC_RAW_MODE_WHEN }],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// The chat pane (and the plan pane header) listen for config changes,
		// so writing the shared keys here routes every Build path.
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const modelStore = new VibeAIModelStore(accessor.get(IStorageService), configurationService);
		const current = configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		interface IPick extends IQuickPickItem { readonly model: string | '__custom__' }
		const picks: IPick[] = [
			{ label: localize('vibeAIPlanMarkdown.modelAuto', "Auto"), model: 'Auto' },
			...modelStore.list().filter(model => !model.disabled).map(model => ({ label: model.name, model: model.id })),
			{ label: localize('vibeAIPlanMarkdown.modelCustom', "Custom model…"), model: '__custom__' as const },
		];
		const picked = await quickInputService.pick(picks, {
			title: localize('vibeAIPlanMarkdown.modelPickTitle', "Select Model"),
			placeHolder: current,
		});
		if (!picked) {
			return;
		}
		if (picked.model === '__custom__') {
			try {
				const value = await quickInputService.input({
					title: localize('vibeAIPlanMarkdown.modelCustomTitle', "Custom model name"),
					placeHolder: localize('vibeAIPlanMarkdown.modelCustomPlaceholder', "e.g. my-model (empty = Auto)"),
					value: current !== 'Auto' ? current : '',
				});
				if (value !== undefined) {
					const trimmed = value.trim();
					await configurationService.updateValue('vibeAI.chat.model', trimmed.length > 0 ? trimmed : '');
				}
			} catch {
				// Cancelled — keep the current selection.
			}
			return;
		}
		await configurationService.updateValue('vibeAI.chat.model', picked.model === 'Auto' ? '' : picked.model);
	}
}

registerAction2(VibeAIPlanDocBuildAction);
registerAction2(VibeAIPlanDocModelAction);

// Phase 252→256: the EditorTitle "Editor Mode" submenu placement is GONE, and
// so is the Phase 252 title-bar pair and the Phase 254 in-content pill — the
// two mode actions above now register in the breadcrumb bar's actions slot
// (MenuId.BreadcrumbsTitle, always-visible "Preview | Markdown" buttons in
// both modes, Cursor parity with the "ⓘ file.md" row). The
// VIBE_AI_EDITOR_MODE_MENU submenu id itself stays: the plan pane's header
// "..." enumerates its actions from it (vibeAIPlanDocPane.ts getMenuActions).

export class VibeAIMarkdownEditorModeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIMarkdownEditorMode';

	private readonly modeContextKey: IContextKey<string | undefined>;

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@ITextEditorService private readonly textEditorService: ITextEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// One-line startup probe: if this never logs, the contribution did
		// not instantiate (no resolver, no mode memory, no mode context).
		console.info('[vibeAI] markdown editor-mode contribution started');
		this.modeContextKey = contextKeyService.createKey(CONTEXT_VIBE_AI_MARKDOWN_MODE.key, undefined);
		const updateModeContextKey = () => {
			const input = editorService.activeEditorPane?.input;
			if (!input) {
				this.modeContextKey.set(undefined);
				return;
			}
		const viewType = (input as { viewType?: string }).viewType;
		const resource = input.resource;
		// Phase 228/229: the plan pane hosts BOTH modes of a plan doc —
		// its ✓ follows the stored per-file view (the pane persists every
		// in-place switch; the storage listener below re-runs this).
		const typeId = (input as { typeId?: string }).typeId;
		if (typeId === VIBE_AI_PLAN_DOC_EDITOR_ID) {
			this.modeContextKey.set(resource ? getMarkdownEditorMode(this.storageService, this.uriIdentityService, resource) : 'preview');
		} else if (resource && isMarkdownFamilyResource(resource)) {
			// Phase 252: both preview webviews (rich editor + static preview)
			// count as the 'preview' mode.
			this.modeContextKey.set(isMarkdownPreviewViewType(viewType) ? 'preview' : 'markdown');
		} else if (isMarkdownPreviewViewType(viewType)) {
			this.modeContextKey.set('preview');
		} else {
			this.modeContextKey.set(undefined);
		}
		};
		updateModeContextKey();
		this._register(editorService.onDidActiveEditorChange(updateModeContextKey));
		// Phase 229: in-place mode switches persist via storage — refresh
		// the ✓ without waiting for an editor change. onDidChangeValue is
		// pre-filtered to the given scope+key.
		this._register(storageService.onDidChangeValue(
			StorageScope.APPLICATION,
			MARKDOWN_MODE_STORAGE_KEY,
			this._store,
		)(() => {
			updateModeContextKey();
		}));

		// The exclusive default resolver — see the file header comment.
		this._register(editorResolverService.registerEditor(
			MARKDOWN_GLOB,
			{
				id: MARKDOWN_RESOLVER_ID,
				label: localize('vibeAIMarkdown.defaultEditorLabel', "Markdown Preview"),
				priority: RegisteredEditorPriority.exclusive,
			},
			{ singlePerResource: true },
			{
				createEditorInput: (editorInput, group) => {
					const resource = editorInput.resource;
					if (!resource) {
						return { editor: this.textEditorService.createTextEditor(editorInput) };
					}
					// Phase 226: plan docs open as the rendered Plan editor
					// (Plans crumb + Build + front-matter To-dos) — delegated
					// here because the resolver's same-priority sort is
					// longer-glob-wins: a separate `*.plan.md` registration
					// would lose to this braces glob.
					// Phase 229: plan docs ALWAYS land in the plan pane — it
					// hosts both modes, and the stored per-file mode picks
					// its initial view (rendered or raw). A bare text editor
					// would lose the header (Build/model/mode menu) and drag
					// the stock chrome (line numbers, unicode boxes) along.
					if (isPlanDocResource(resource)) {
						return { editor: createPlanDocEditorInput(resource) };
					}
					try {
						if (getMarkdownEditorMode(this.storageService, this.uriIdentityService, resource) === 'markdown') {
							return { editor: this.textEditorService.createTextEditor(editorInput) };
						}
						return {
							// Phase 252: the editable WYSIWYG rich editor — Cursor's
							// Preview is directly editable, the read-only static
							// preview stays available via "Open With…".
							editor: CustomEditorInput.create(this.instantiationService, {
								resource,
								viewType: MARKDOWN_RICH_EDITOR_VIEW_TYPE,
								webviewTitle: undefined,
								preferredName: undefined,
								iconPath: undefined,
							}, group.id),
						};
					} catch {
						// Preview input creation failed (e.g. webview unavailable) —
						// a text editor always works.
						return { editor: this.textEditorService.createTextEditor(editorInput) };
					}
				},
				// Untitled markdown is an editing intent (e.g. Phase 186's
				// customize template skeletons) — always the raw text editor.
				createUntitledEditorInput: untitledEditorInput => ({ editor: this.textEditorService.createTextEditor(untitledEditorInput) }),
			},
		));
	}
}
