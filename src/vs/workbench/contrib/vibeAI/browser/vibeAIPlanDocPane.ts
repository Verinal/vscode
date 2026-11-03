/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 226: the rendered Plan doc editor (Cursor parity, user screenshots).
 *
 * Cursor renders a plan file (`*.plan.md`) as a page: Plans breadcrumb +
 * Build + the "..." (Editor Mode) menu in the header, the markdown BODY as
 * rich rendered content, and a
 * To-dos block at the bottom driven by the YAML front matter (image 3: the
 * machine-readable data lives in `---` front matter — name / overview /
 * todos (id/content/status) — invisible in the rendered view). "+ New"
 * appends an inline editable row ("Todo description…" placeholder), a
 * selected row swaps the header to "N To-do Selected" with ✕ / ⚙ / Build in
 * New Agent, and the author row shows a chat-bubble icon + a SHORT agent
 * name. The user rejected the raw-text-editor + floating-widget rendering
 * (「這是什麼東西奇奇怪怪的…你完完全全看清楚人家的ui」) — this pane is the
 * rework.
 *
 * How it hooks in: plan docs stream into the text model (Phase 218-223
 * machinery unchanged — plan_doc_start/delta chunks apply through a model
 * reference), this pane attaches its OWN reference to the same model and
 * re-renders on every content change, so the streamed doc appears already
 * rendered (To-dos grow in as the front matter streams in). The markdown
 * resolver (Phase 225) defers `*.plan.md` resources here via
 * `createPlanDocEditorInput` — the exclusive braces glob would otherwise
 * outrank a separate plan-doc registration (resolver picks the longer glob).
 * Every open path (stream open, View Plan links, explorer double-click)
 * lands in this pane; Phase 219's approval overlay and Phase 224's To-dos
 * content widget stay as fallbacks for the raw-text editor (override opens).
 *
 * Writes: the pane edits the model (toggle a todo's front matter `status:`
 * line, + New appends a todo block, ⚙ delete) and saves immediately — the
 * backend's progress write-backs (Phase 226 `running`/`completed`/`failed`)
 * arrive as external model changes and re-render the block live.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { Action, IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVibeAIPlan } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { getSimpleEditorOptions } from '../../codeEditor/browser/simpleEditorOptions.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VibeAIChatPane } from './vibeAIChatPane.js';
import { getMarkdownEditorMode, MarkdownEditorMode, VIBE_AI_EDITOR_MODE_MENU, writeMarkdownEditorMode } from './vibeAIEditorMode.js';
import { buildModelMenuActions } from './vibeAIModelMenu.js';
import { VibeAIModelStore } from './vibeAIModelStore.js';
import './media/vibeAIPlanDoc.css';

const $ = DOM.$;

/** Editor pane / input type ids. */
export const VIBE_AI_PLAN_DOC_EDITOR_ID = 'workbench.editors.vibeAIPlanDoc';
/** The pane's id (differs from the input typeId — EditorTitle menu `activeEditor` carries this). */
export const VIBE_AI_PLAN_DOC_PANE_ID = 'workbench.editors.vibeAIPlanDoc.pane';

/** True for plan docs — the markdown preview resolver defers these to this pane. */
export function isPlanDocResource(resource: URI | undefined): boolean {
	return !!resource && resource.path.toLowerCase().endsWith('.plan.md');
}

/** Builds the typed input the resolver returns for a plan doc. */
export function createPlanDocEditorInput(resource: URI): VibeAIPlanDocInput {
	return new VibeAIPlanDocInput(resource);
}

// ==================== front matter (mirror of plan_store.py, Phase 226) ====================

type PlanTodoStatus = 'pending' | 'running' | 'completed' | 'failed' | string;

interface IPlanDocTodo {
	readonly id: number | string;
	readonly content: string;
	readonly status: PlanTodoStatus;
	/** 0-based model line of the todo's `    status:` line (-1 when absent). */
	readonly statusLine: number;
	/** 0-based model line of a legacy `- [ ] N.` checkbox line (-1 when absent). */
	readonly checkboxLine: number;
	/** 0-based [blockStart, blockEnd) model lines of the front matter block (legacy: -1). */
	readonly blockStart: number;
	readonly blockEnd: number;
}

interface IParsedPlanDoc {
	readonly name: string;
	readonly overview: string;
	readonly status: string;
	readonly todos: IPlanDocTodo[];
	/** 0-based line a NEW todo block inserts at (-1 = no front matter todos block). */
	readonly todosInsertLine: number;
	readonly hasFrontMatter: boolean;
	/** Body markdown (everything after the closing `---`). */
	readonly body: string;
}

/** Mirrors plan_store._yaml_scalar: quote + escape only unsafe scalars. */
function yamlScalar(value: string): string {
	const text = String(value ?? '');
	if (text === '' || /[:#"\n\\\[\]{}&*!|>%@`]/.test(text) || text !== text.trim()) {
		return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
	}
	return text;
}

/** Mirrors plan_store._yaml_unquote: strip double quotes, restore escapes. */
function yamlUnquote(value: string): string {
	const text = String(value ?? '').trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		const inner = text.slice(1, -1);
		let out = '';
		for (let i = 0; i < inner.length; i++) {
			if (inner[i] === '\\' && i + 1 < inner.length) {
				const nxt = inner[i + 1];
				out += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt;
				i++;
			} else {
				out += inner[i];
			}
		}
		return out;
	}
	return text;
}

/**
 * Parses the plan doc's front matter + body. Tolerates an UNCLOSED front
 * matter (mid-stream): everything streamed so far is parsed, the body is
 * empty until the closing `---` arrives — the rendered view grows the
 * To-dos in while the stream writes. Docs without front matter (Phase 211
 * checkbox era) fall back to checkbox rows and render the whole text.
 */
export function parsePlanDocText(text: string): IParsedPlanDoc {
	const lines = (text ?? '').split(/\r\n|\r|\n/);
	const todos: IPlanDocTodo[] = [];
	let name = '';
	let overview = '';
	let status = '';
	let hasFrontMatter = false;
	let frontClosed = false;
	let todosInsertLine = -1;
	let bodyStart = 0;

	if (lines.length > 0 && lines[0].trim() === '---') {
		hasFrontMatter = true;
		let inTodos = false;
		let todo: { id: number | string; content: string; status: string; statusLine: number; blockStart: number } | undefined;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed === '---') {
				if (todo) {
					todos.push({ ...todo, checkboxLine: -1, blockStart: todo.blockStart, blockEnd: i });
				}
				todo = undefined;
				frontClosed = true;
				bodyStart = i + 1;
				break;
			}
			if (!trimmed) {
				continue;
			}
			if (!/^\s/.test(line)) {
				// A top-level key closes the previous todo's block; the first
				// key AFTER the todos block ends is where a new todo inserts
				// (appending after `status:` would break the YAML mapping).
				if (todo) {
					todos.push({ ...todo, checkboxLine: -1, blockStart: todo.blockStart, blockEnd: i });
					todo = undefined;
				}
				const colon = trimmed.indexOf(':');
				const key = colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
				const value = colon === -1 ? '' : trimmed.slice(colon + 1).trim();
				if (key === 'todos') {
					inTodos = true;
				} else {
					if (inTodos && todosInsertLine === -1) {
						todosInsertLine = i;
					}
					inTodos = false;
					if (key === 'name') {
						name = yamlUnquote(value);
					} else if (key === 'overview') {
						overview = yamlUnquote(value);
					} else if (key === 'status') {
						status = yamlUnquote(value);
					}
				}
				continue;
			}
			if (inTodos && trimmed.startsWith('- ')) {
				if (todo) {
					todos.push({ ...todo, checkboxLine: -1, blockStart: todo.blockStart, blockEnd: i });
				}
				const block = trimmed.slice(2);
				const colon = block.indexOf(':');
				const key = colon === -1 ? block : block.slice(0, colon).trim();
				const value = colon === -1 ? '' : block.slice(colon + 1).trim();
				let id: number | string = todos.length + 1;
				if (key === 'id') {
					const raw = yamlUnquote(value).trim();
					id = /^\d+$/.test(raw) ? parseInt(raw, 10) : (raw || todos.length + 1);
				}
				todo = { id, content: '', status: 'pending', statusLine: -1, blockStart: i };
				continue;
			}
			if (todo) {
				const colon = trimmed.indexOf(':');
				const key = colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
				const value = colon === -1 ? '' : trimmed.slice(colon + 1).trim();
				if (key === 'content') {
					todo.content = yamlUnquote(value);
				} else if (key === 'status') {
					todo.status = yamlUnquote(value) || 'pending';
					todo.statusLine = i;
				}
			}
		}
		if (!frontClosed && todo) {
			// Stream cut inside the last todo block — it is still appended.
			todos.push({ ...todo, checkboxLine: -1, blockStart: todo.blockStart, blockEnd: lines.length });
			todosInsertLine = lines.length;
		} else if (!frontClosed && inTodos && todosInsertLine === -1) {
			// Stream cut between todos (no top-level key after them yet) —
			// append at the very end of what streamed so far.
			todosInsertLine = lines.length;
		}
	}

	// Legacy checkbox rows (Phase 211 docs without front matter).
	if (!hasFrontMatter) {
		const checkboxRe = /^(\s*)- \[([ xX])\] (\d+)\. (?:\*\*)?(.+?)(?:\*\*)?\s*$/;
		lines.forEach((line, i) => {
			const match = checkboxRe.exec(line);
			if (!match) {
				return;
			}
			todos.push({
				id: parseInt(match[3], 10),
				content: match[4].replace(/\s+(?:✅|⚠).*$/, ''),
				status: match[2].toLowerCase() === 'x' ? 'completed' : (line.includes('⚠') ? 'failed' : 'pending'),
				statusLine: -1,
				checkboxLine: i,
				blockStart: -1,
				blockEnd: -1,
			});
		});
	}

	const body = frontClosed ? lines.slice(bodyStart).join('\n') : '';
	return { name, overview, status, todos, todosInsertLine, hasFrontMatter, body };
}

/** Plan object built from the parsed doc — the chat pane's Build path consumes it. */
export function planFromDoc(parsed: IParsedPlanDoc): IVibeAIPlan {
	return {
		summary: parsed.name,
		steps: parsed.todos.map((todo, i) => ({
			id: typeof todo.id === 'number' ? todo.id : i + 1,
			title: todo.content,
		})),
	};
}

// ==================== input ====================

/**
 * Per-resource input for a plan doc. Serializable (the tab survives a
 * reload; the pane re-attaches to the file's model).
 */
export class VibeAIPlanDocInput extends EditorInput {

	static readonly ID: string = VIBE_AI_PLAN_DOC_EDITOR_ID;

	constructor(readonly resource: URI) {
		super();
	}

	override get typeId(): string {
		return VibeAIPlanDocInput.ID;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getIcon(): ThemeIcon {
		return Codicon.checklist;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput)
			|| (otherInput instanceof VibeAIPlanDocInput && otherInput.resource.toString() === this.resource.toString());
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: VibeAIPlanDocInput.ID } };
	}
}

// ==================== pane ====================

/**
 * The plan doc editor: header (Plans crumb + model + Build + "...") and TWO
 * body views (Phase 229, Cursor parity — one editor, two modes): the
 * rendered page (markdown body + To-dos) and the RAW view — a plain wrapped
 * code editor hosting the SAME text model (no line numbers, no unicode
 * boxes; Cursor's markdown mode look). The stored per-file editor mode
 * picks the initial view; the header "..." menu swaps in place.
 */
export class VibeAIPlanDocPane extends EditorPane {

	static readonly ID: string = VIBE_AI_PLAN_DOC_PANE_ID;

	// --- DOM skeleton (created once)
	private root: HTMLElement | undefined;
	private crumbNameEl: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	private mdEl: HTMLElement | undefined;
	private todosSectionEl: HTMLElement | undefined;
	private refSectionEl: HTMLElement | undefined;
	// --- raw view (Phase 229) — lazy editor widget + its host page
	private rawEl: HTMLElement | undefined;
	private editorWidget: CodeEditorWidget | undefined;

	// --- skeleton listeners (createEditor; never cleared)
	private readonly skeletonDisposables = this._register(new DisposableStore());
	// --- per-input listeners (model ref + content changes)
	private readonly inputDisposables = this._register(new DisposableStore());
	// --- per-render listeners (rows / actions — cleared each re-render)
	private readonly renderDisposables = this._register(new DisposableStore());

	private modelRef: IReference<IResolvedTextEditorModel> | undefined;
	private parsed: IParsedPlanDoc | undefined;
	private readonly selected = new Set<number>();
	/** An inline "+ New" input is open — model re-renders hold off. */
	private newTodoInput: HTMLInputElement | undefined;
	/** Keep the body pinned to the bottom while the doc streams in. */
	private followBottom = true;
	/** Which body view is up (Cursor's Editor Mode; persisted per file). */
	private viewMode: MarkdownEditorMode = 'preview';
	/** Trailing auto-save timer for raw-view typing. */
	private saveTimer: number | undefined;

	// --- shared
	private readonly editorCodeBlockRenderer: EditorMarkdownCodeBlockRenderer;

	// --- model dropdown (Phase 228, Cursor image 1 — same config as chat)
	private readonly modelStore: VibeAIModelStore;
	private model = 'Auto';
	private autoMode = 'balance';
	private modelLabelEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super(VibeAIPlanDocPane.ID, group, telemetryService, themeService, storageService);
		// App-lifetime shared renderer (no dispose — same as the chat pane).
		this.editorCodeBlockRenderer = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
		// The model registry is storage-backed (no service) — an own instance
		// reads the same Settings → Models data the chat pane sees.
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
		this.model = configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		this.autoMode = configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
		// Picks made elsewhere (chat input, raw-mode title bar) refresh the
		// header label live.
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeAI.chat.model') || e.affectsConfiguration('vibeAI.chat.autoMode')) {
				this.refreshModelFromConfig();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, $('.vibe-ai-plan-doc'));

		// --- header: Plans crumb + Build (Cursor parity, image 2)
		const header = DOM.append(this.root, $('.vibe-ai-plan-doc-header'));
		const crumb = DOM.append(header, $('.vibe-ai-plan-doc-crumb'));
		DOM.append(crumb, $('span.vibe-ai-plan-doc-crumb-root')).textContent = localize('vibeAIPlanDoc.plans', "Plans");
		DOM.append(crumb, $('span.vibe-ai-plan-doc-crumb-sep')).textContent = '›';
		// Phase 230: the RAW view is a file view — Cursor shows the file icon
		// + filename in the crumb there (the rendered view keeps the plan name).
		DOM.append(crumb, $('span.codicon.codicon-file.vibe-ai-plan-doc-crumb-file'));
		this.crumbNameEl = DOM.append(crumb, $('span.vibe-ai-plan-doc-crumb-name'));

		// Cursor parity (image 1): the model dropdown ("Auto ⌄") left of
		// Build — the shared menu the chat input uses, same config keys, so
		// a pick here routes Build/execute everywhere.
		const modelBtn = DOM.append(header, $('button.vibe-ai-plan-doc-model')) as HTMLButtonElement;
		modelBtn.setAttribute('aria-label', localize('vibeAIPlanDoc.modelPicker', "Select Model"));
		this.modelLabelEl = DOM.append(modelBtn, $('span.vibe-ai-plan-doc-model-label'));
		this.modelLabelEl.textContent = this.model;
		DOM.append(modelBtn, $('span.codicon.codicon-chevron-down.vibe-ai-plan-doc-model-chevron'));
		this.refreshModelFromConfig();
		this.skeletonDisposables.add(DOM.addDisposableListener(modelBtn, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.showModelMenu(modelBtn);
		}));

		const buildBtn = DOM.append(header, $('button.vibe-ai-plan-doc-build')) as HTMLButtonElement;
		buildBtn.setAttribute('aria-label', localize('vibeAIPlanDoc.build', "Build"));
		buildBtn.append(
			DOM.$('span.vibe-ai-plan-doc-build-label'),
			DOM.$('kbd.vibe-ai-plan-doc-build-kbd'),
		);
		(buildBtn.querySelector('.vibe-ai-plan-doc-build-label') as HTMLElement).textContent = localize('vibeAIPlanDoc.build', "Build");
		(buildBtn.querySelector('.vibe-ai-plan-doc-build-kbd') as HTMLElement).textContent = 'Ctrl+⏎';

		// Cursor parity (image 1): the "..." at the header's right end opens
		// the Editor Mode menu — Preview ✓ / Markdown / Save to Workspace.
		const moreBtn = DOM.append(header, $('button.vibe-ai-plan-doc-more')) as HTMLButtonElement;
		moreBtn.setAttribute('aria-label', localize('vibeAIPlanDoc.moreActions', "More Actions"));
		moreBtn.append(...ThemeIcon.asClassNameArray(Codicon.more).map(cls => DOM.$(`span.${cls}`)));
		this.skeletonDisposables.add(DOM.addDisposableListener(moreBtn, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.showEditorModeMenu(moreBtn);
		}));

		// --- body: one scrolling page — rendered markdown, then To-dos, then
		// Referenced by (Cursor parity: the To-dos card flows right after the
		// content; a short doc must not leave a void above a pinned card).
		this.bodyEl = DOM.append(this.root, $('.vibe-ai-plan-doc-body'));
		this.bodyEl.setAttribute('tabindex', '0');
		this.mdEl = DOM.append(this.bodyEl, $('.vibe-ai-plan-doc-md'));
		const side = DOM.append(this.bodyEl, $('.vibe-ai-plan-doc-side'));
		this.todosSectionEl = DOM.append(side, $('.vibe-ai-plan-doc-todos'));
		this.refSectionEl = DOM.append(side, $('.vibe-ai-plan-doc-ref'));

		// Phase 229: the RAW ("Markdown") page — same header, a plain wrapped
		// editor hosting the same text model (lazy widget). Hidden until the
		// stored per-file mode says 'markdown' (root gets `.raw-mode`).
		this.rawEl = DOM.append(this.root, $('.vibe-ai-plan-doc-raw'));

		// Capture phase: with the raw editor focused, its own Ctrl+Enter
		// (insert line) and the workbench Ctrl+S would win — Build/Save
		// must intercept first (Cursor: Build Ctrl+⏎ works in markdown mode).
		this.skeletonDisposables.add(DOM.addDisposableListener(this.root, DOM.EventType.KEY_DOWN, e => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				DOM.EventHelper.stop(e, true);
				this.buildPlan();
			} else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
				DOM.EventHelper.stop(e, true);
				this.saveNow();
			}
		}, true));
		this.skeletonDisposables.add(DOM.addDisposableListener(this.bodyEl, DOM.EventType.SCROLL, () => {
			if (!this.bodyEl) {
				return;
			}
			// Stick to the bottom while streaming; a deliberate scroll up
			// releases the pin (the same heuristic the chat pane uses).
			this.followBottom = this.bodyEl.scrollTop + this.bodyEl.clientHeight >= this.bodyEl.scrollHeight - 48;
		}));
		this.skeletonDisposables.add(DOM.addDisposableListener(buildBtn, DOM.EventType.CLICK, () => this.buildPlan()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		super.setInput(input, options, context, token);
		if (!(input instanceof VibeAIPlanDocInput)) {
			return;
		}
		this.inputDisposables.clear();
		this.renderDisposables.clear();
		this.selected.clear();
		this.followBottom = true;
		this.closeNewTodoInput();
		this.flushRawSave();
		this.modelRef?.dispose();
		this.modelRef = undefined;
		// Phase 229: the pane hosts both modes — the stored per-file mode
		// (Cursor's Editor Mode) picks the initial one.
		this.viewMode = getMarkdownEditorMode(this.storageService, this.uriIdentityService, input.resource);
		this.updateCrumb();
		try {
			this.modelRef = await this.textModelService.createModelReference(input.resource);
		} catch {
			// The file vanished between the event and the open — the doc
			// section renders the parse of nothing (empty state).
			this.parsed = undefined;
			this.applyViewMode();
			this.renderAll();
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}
		const model = this.modelRef.object.textEditorModel;
		if (!model) {
			return;
		}
		this.inputDisposables.add(this.modelRef);
		this.inputDisposables.add(model.onDidChangeContent(() => {
			this.scheduleRender();
			// Raw-view typing auto-saves (trailing debounce) — the plan pane
			// owns the file the same way it does for todo edits.
			this.scheduleRawSave();
		}));
		this.applyViewMode();
		this.renderAll();
	}

	override clearInput(): void {
		super.clearInput();
		this.inputDisposables.clear();
		this.renderDisposables.clear();
		this.flushRawSave();
		this.modelRef?.dispose();
		this.modelRef = undefined;
		this.parsed = undefined;
		this.selected.clear();
		this.closeNewTodoInput();
		this.editorWidget?.setModel(null);
		if (this.mdEl) {
			this.mdEl.innerText = '';
		}
		if (this.todosSectionEl) {
			this.todosSectionEl.innerText = '';
		}
		if (this.refSectionEl) {
			this.refSectionEl.innerText = '';
		}
	}

	override layout(_dimension: DOM.Dimension): void {
		// The flex layout fills the editor area; the raw editor widget uses
		// automaticLayout — no manual sizing needed.
	}

	override focus(): void {
		if (this.root?.contains(this.root.ownerDocument.activeElement)) {
			return;
		}
		if (this.viewMode === 'markdown') {
			this.editorWidget?.focus();
			return;
		}
		this.bodyEl?.focus();
	}

	/**
	 * Phase 229: the raw view's editor IS the pane's control — the chat
	 * pane resolves it via getCodeEditor(pane.getControl()) so the stream
	 * approval overlay / To-dos widgets can attach while a plan doc streams
	 * into a markdown-mode pane. The rendered view exposes no control.
	 */
	override getControl(): ICodeEditor | undefined {
		return this.viewMode === 'markdown' ? this.editorWidget ?? undefined : undefined;
	}

	// ==================== raw view (Phase 229, Cursor image 3) ====================

	/**
	 * In-place Editor Mode switch (the header "..." menu): swaps the body
	 * page and persists per file. No reopen — the resolver would return the
	 * very same per-resource input and the pane would not rebuild.
	 */
	setEditorViewMode(mode: MarkdownEditorMode): void {
		if (this.viewMode === mode) {
			return;
		}
		this.viewMode = mode;
		const input = this.input instanceof VibeAIPlanDocInput ? this.input : undefined;
		if (input) {
			writeMarkdownEditorMode(this.storageService, this.uriIdentityService, input.resource, mode);
		}
		this.applyViewMode();
		if (mode === 'markdown') {
			this.editorWidget?.focus();
		} else {
			this.bodyEl?.focus();
		}
	}

	/** Applies the current view mode to the DOM (root `.raw-mode` class). */
	private applyViewMode(): void {
		const raw = this.viewMode === 'markdown';
		this.root?.classList.toggle('raw-mode', raw);
		this.updateCrumb();
		if (raw) {
			const model = this.modelRef?.object.textEditorModel;
			if (model) {
				this.ensureRawEditor()?.setModel(model);
			}
		}
	}

	/**
	 * Crumb content per view (Phase 230, Cursor image 1): the RENDERED view
	 * shows the plan's front-matter name (Phase 226), the RAW view is a file
	 * view and shows the filename (icon + name, extension included).
	 */
	private updateCrumb(): void {
		if (!this.crumbNameEl) {
			return;
		}
		const input = this.input instanceof VibeAIPlanDocInput ? this.input : undefined;
		const fileName = input?.getName() ?? '';
		if (this.viewMode === 'markdown' || !this.parsed?.name) {
			this.crumbNameEl.textContent = fileName;
		} else {
			this.crumbNameEl.textContent = this.parsed.name;
		}
	}

	/**
	 * The raw editor widget, created on first markdown view: plain wrapped
	 * page — no line numbers/minimap (getSimpleEditorOptions), unicode
	 * highlight off (this fork silently opens workspaces untrusted, which
	 * boxed every CJK character gold), automatic layout.
	 */
	private ensureRawEditor(): CodeEditorWidget | undefined {
		if (this.editorWidget || !this.rawEl) {
			return this.editorWidget;
		}
		const widget = this._register(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.rawEl,
			{
				...getSimpleEditorOptions(this.configurationService),
				automaticLayout: true,
				padding: { top: 12, bottom: 24 },
				unicodeHighlight: {
					nonBasicASCII: false,
					invisibleCharacters: false,
					ambiguousCharacters: false,
				},
			},
			{ isSimpleWidget: false, contributions: EditorExtensionsRegistry.getEditorContributions() },
		));
		this.editorWidget = widget;
		return widget;
	}

	// ==================== raw view save (Phase 229) ====================

	/** Immediate save (Ctrl+S) — also cancels a pending auto-save. */
	private saveNow(): void {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		const model = this.modelRef?.object.textEditorModel;
		if (model) {
			void this.textFileService.save(model.uri);
		}
	}

	/** Trailing-debounce auto-save while the raw view is edited. */
	private scheduleRawSave(): void {
		if (this.viewMode !== 'markdown') {
			return;
		}
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined;
			const model = this.modelRef?.object.textEditorModel;
			if (model) {
				void this.textFileService.save(model.uri);
			}
		}, 1000);
	}

	/** Flushes a pending auto-save (input switch / tab close). */
	private flushRawSave(): void {
		if (this.saveTimer !== undefined) {
			this.saveNow();
		}
	}

	/**
	 * Cursor parity (image 1): the header "..." menu — a gray "Editor Mode"
	 * section title, then the Phase 225 mode items (✓ on the active one,
	 * Save to Workspace grayed for saved docs) resolved against the pane's
	 * scoped context so the toggles reflect this document.
	 */
	private showEditorModeMenu(anchor: HTMLElement): void {
		// getMenuActions returns per-group arrays — flatten with separators
		// between groups (the ─ before "Save to Workspace" in Cursor's menu).
		const menuActions: IAction[] = [];
		for (const [, groupActions] of this.menuService.getMenuActions(VIBE_AI_EDITOR_MODE_MENU, this.contextKeyService)) {
			if (groupActions.length && menuActions.length) {
				menuActions.push(new Separator());
			}
			menuActions.push(...groupActions);
		}
		const actions: IAction[] = [
			toAction({
				id: 'vibeAI.planDoc.editorModeHeader',
				label: localize('vibeAIPlanDoc.editorMode', "Editor Mode"),
				enabled: false,
				run: () => { },
			}),
			...menuActions,
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	// ==================== model dropdown (Phase 228, Cursor image 1) ====================

	/** Re-reads the shared config keys and refreshes the header label. */
	private refreshModelFromConfig(): void {
		this.model = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		this.autoMode = this.configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
		if (this.modelLabelEl) {
			// Imported models show their display name; ad-hoc/Auto show as-is.
			const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
			this.modelLabelEl.textContent = configured?.name ?? this.model;
		}
	}

	/** Same shape as the chat input's dropdown (vibeAIModelMenu.ts). */
	private showModelMenu(anchor: HTMLElement): void {
		// Settings-dialog changes land live (the same refresh the chat does).
		this.refreshModelFromConfig();
		const actions = buildModelMenuActions({
			modelStore: this.modelStore,
			currentModel: this.model,
			autoMode: this.autoMode,
			setModel: model => {
				void this.configurationService.updateValue('vibeAI.chat.model', model === 'Auto' ? '' : model);
				this.refreshModelFromConfig();
			},
			setAutoMode: mode => {
				void this.configurationService.updateValue('vibeAI.chat.autoMode', mode);
				this.autoMode = mode;
			},
			inputCustomModel: async current => {
				try {
					return await this.quickInputService.input({
						title: localize('vibeAIPlanDoc.modelCustomTitle', "Custom model name"),
						placeHolder: localize('vibeAIPlanDoc.modelCustomPlaceholder', "e.g. my-model (empty = Auto)"),
						value: current !== 'Auto' ? current : '',
					});
				} catch {
					return undefined;
				}
			},
		});
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	// ==================== rendering ====================

	private scheduleRender(): void {
		// An inline "+ New" input must not be blown away by a re-render
		// (its text lives in the DOM only until commit).
		if (this.newTodoInput && this.newTodoInput.isConnected) {
			return;
		}
		this.renderAll();
	}

	private renderAll(): void {
		const model = this.modelRef?.object.textEditorModel;
		if (!model || !this.mdEl || !this.todosSectionEl || !this.refSectionEl) {
			return;
		}
		this.renderDisposables.clear();
		this.parsed = parsePlanDocText(model.getValue());
		this.pruneSelection();
		// Cursor parity: the crumb shows the plan's name, not the filename
		// (arrives with the front matter mid-stream; falls back to the file).
		// updateCrumb picks name vs filename per the active view (Phase 230).
		this.updateCrumb();
		this.renderMarkdownBody(this.renderedBody(this.parsed));
		this.renderTodos(this.parsed);
		this.renderRef(this.parsed);
		if (this.followBottom && this.bodyEl) {
			this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
		}
	}

	/**
	 * Body markdown for the RENDERED view: the doc opens with `# 計畫：<name>`
	 * and the header crumb already shows the name (user: the title appears
	 * twice) — drop the leading heading while the front matter carries a
	 * name. Legacy docs without front matter keep theirs; the raw text
	 * editor and the model are untouched.
	 */
	private renderedBody(parsed: IParsedPlanDoc): string {
		if (!parsed.name) {
			return parsed.body;
		}
		const lines = parsed.body.split(/\r?\n/);
		let first = 0;
		while (first < lines.length && !lines[first].trim()) {
			first += 1;
		}
		if (first < lines.length && /^#\s+/.test(lines[first])) {
			lines.splice(0, first + 1);
			return lines.join('\n');
		}
		return parsed.body;
	}

	private renderMarkdownBody(body: string): void {
		if (!this.mdEl) {
			return;
		}
		this.mdEl.innerText = '';
		if (!body.trim()) {
			return;
		}
		try {
			this.markdownRendererService.render(
				new MarkdownString(body, { isTrusted: true, supportThemeIcons: true, supportHtml: true }),
				{
					codeBlockHeader: true,
					inlineCodeLinks: true,
					codeBlockRenderer: (languageId, value, rawInfo) =>
						this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true }, rawInfo),
				},
				this.mdEl,
			);
		} catch {
			this.mdEl.textContent = body;
		}
	}

	// ==================== To-dos block (Cursor parity) ====================

	private pruneSelection(): void {
		const count = this.parsed?.todos.length ?? 0;
		for (const index of Array.from(this.selected)) {
			if (index >= count) {
				this.selected.delete(index);
			}
		}
	}

	private renderTodos(parsed: IParsedPlanDoc): void {
		if (!this.todosSectionEl) {
			return;
		}
		const section = this.todosSectionEl;
		section.innerText = '';

		// Header: "N To-dos" (or the selection state) left, actions right.
		const header = DOM.append(section, $('.vibe-ai-plan-doc-todos-header'));
		const countEl = DOM.append(header, $('span.vibe-ai-plan-doc-todos-count'));
		const actionsEl = DOM.append(header, $('.vibe-ai-plan-doc-todos-actions'));

		// Rows: circle + plain content (no numbers, no bold).
		const list = DOM.append(section, $('.vibe-ai-plan-doc-todos-list'));
		parsed.todos.forEach((todo, index) => {
			const row = DOM.append(list, $('.vibe-ai-plan-doc-todos-item'));
			row.classList.toggle('selected', this.selected.has(index));
			row.setAttribute('role', 'button');
			row.setAttribute('tabindex', '0');
			const icon = DOM.append(row, $('span.codicon.vibe-ai-plan-doc-todos-icon'));
			switch (todo.status) {
				case 'completed':
					icon.classList.add('codicon-check', 'done');
					break;
				case 'failed':
					icon.classList.add('codicon-error', 'failed');
					break;
				case 'running':
					icon.classList.add('codicon-loading', 'running');
					break;
				default:
					icon.classList.add('codicon-circle-large-outline');
			}
			icon.title = localize('vibeAIPlanDoc.toggleTodo', "Toggle completed");
			DOM.append(row, $('span.vibe-ai-plan-doc-todos-label')).textContent = todo.content;
			this.renderDisposables.add(DOM.addDisposableListener(icon, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.toggleTodoStatus(index);
			}));
			this.renderDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => {
				if (e.target === icon) {
					return; // the circle click toggles status, not selection
				}
				DOM.EventHelper.stop(e, true);
				if (this.selected.has(index)) {
					this.selected.delete(index);
				} else {
					this.selected.add(index);
				}
				this.renderAll();
			}));
		});

		// "+ New" appends an inline editable row (Cursor parity, image 4) —
		// the row only exists while the input is open.
		if (this.newTodoInput) {
			const addRow = DOM.append(list, $('.vibe-ai-plan-doc-todos-add-row'));
			addRow.appendChild(this.newTodoInput);
			this.attachNewTodoInput(this.newTodoInput);
			this.newTodoInput.focus();
		}

		// Header actions.
		if (this.selected.size > 0) {
			countEl.textContent = localize('vibeAIPlanDoc.todosSelected', "{0} To-do(s) Selected", this.selected.size);
			// ✕ clear selection
			const clear = DOM.append(actionsEl, $('span.codicon.codicon-close.vibe-ai-plan-doc-todos-action'));
			clear.title = localize('vibeAIPlanDoc.clearSelection', "Clear selection");
			this.renderDisposables.add(DOM.addDisposableListener(clear, DOM.EventType.CLICK, () => {
				this.selected.clear();
				this.renderAll();
			}));
			// ⚙ todo actions on the selection (mark / delete)
			const gear = DOM.append(actionsEl, $('span.codicon.codicon-gear.vibe-ai-plan-doc-todos-action'));
			gear.title = localize('vibeAIPlanDoc.todoActions', "To-do actions");
			this.renderDisposables.add(DOM.addDisposableListener(gear, DOM.EventType.CLICK, () => {
				this.openSelectionMenu(gear, parsed);
			}));
			// Build in New Agent (Cursor parity, image 5)
			const buildNew = DOM.append(actionsEl, $('button.vibe-ai-plan-doc-build.vibe-ai-plan-doc-build-small'));
			buildNew.textContent = localize('vibeAIPlanDoc.buildInNewAgent', "Build in New Agent");
			this.renderDisposables.add(DOM.addDisposableListener(buildNew, DOM.EventType.CLICK, () => this.buildPlan()));
		} else {
			countEl.textContent = localize('vibeAIPlanDoc.todosCount', "{0} To-dos", parsed.todos.length);
			// "+ New" right-aligned
			const add = DOM.append(actionsEl, $('span.vibe-ai-plan-doc-todos-add'));
			add.textContent = localize('vibeAIPlanDoc.addTodo', "+ New");
			add.setAttribute('role', 'button');
			this.renderDisposables.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => this.openNewTodoInput()));
		}
	}

	private attachNewTodoInput(input: HTMLInputElement): void {
		this.renderDisposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				DOM.EventHelper.stop(e, true);
				this.commitNewTodo(input.value);
			} else if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				this.closeNewTodoInput();
				this.renderAll();
			}
		}));
		this.renderDisposables.add(DOM.addDisposableListener(input, DOM.EventType.BLUR, () => {
			// Blur commits non-empty text (nothing is lost), closes empty.
			if (this.newTodoInput === input) {
				this.commitNewTodo(input.value);
			}
		}));
	}

	private openSelectionMenu(anchor: HTMLElement, parsed: IParsedPlanDoc): void {
		if (!this.modelRef?.object.textEditorModel) {
			return;
		}
		const targets = Array.from(this.selected);
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new Action('vibeAIPlanDoc.markCompleted', localize('vibeAIPlanDoc.markCompleted', "Mark as completed"), undefined, true, () => {
					targets.forEach(index => this.writeTodoStatus(parsed.todos[index], 'completed'));
				}),
				new Action('vibeAIPlanDoc.markPending', localize('vibeAIPlanDoc.markPending', "Mark as pending"), undefined, true, () => {
					targets.forEach(index => this.writeTodoStatus(parsed.todos[index], 'pending'));
				}),
				new Action('vibeAIPlanDoc.deleteTodos', localize('vibeAIPlanDoc.deleteTodos', "Delete from list"), undefined, true, () => {
					this.deleteTodos(parsed, targets);
				}),
			],
		});
	}

	// ==================== model writes ====================

	private editModel(edit: (model: ITextModel) => void): void {
		const model = this.modelRef?.object.textEditorModel;
		if (!model) {
			return;
		}
		try {
			edit(model);
			void this.textFileService.save(model.uri);
		} catch (error) {
			this.notificationService.error(localize('vibeAIPlanDoc.writeFailed', "Failed to update the plan file: {0}", String(error)));
		}
	}

	private toggleTodoStatus(index: number): void {
		const parsed = this.parsed;
		const todo = parsed?.todos[index];
		if (!parsed || !todo) {
			return;
		}
		this.writeTodoStatus(todo, todo.status === 'completed' ? 'pending' : 'completed');
	}

	private writeTodoStatus(todo: IPlanDocTodo, docStatus: string): void {
		this.editModel(model => {
			if (todo.statusLine >= 0) {
				const lineNumber = todo.statusLine + 1;
				const line = model.getLineContent(lineNumber);
				const newLine = line.replace(/^(\s*)status:\s*.*$/, `$1status: ${docStatus}`);
				if (newLine !== line) {
					model.pushEditOperations([], [{ range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: line.length + 1 }, text: newLine }], () => null);
				}
			} else if (todo.checkboxLine >= 0) {
				const lineNumber = todo.checkboxLine + 1;
				const line = model.getLineContent(lineNumber);
				const newLine = docStatus === 'completed'
					? line.replace(/^(\s*)- \[ \]/, '$1- [x]')
					: line.replace(/^(\s*)- \[[xX]\]/, '$1- [ ]');
				if (newLine !== line) {
					model.pushEditOperations([], [{ range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: line.length + 1 }, text: newLine }], () => null);
				}
			}
		});
	}

	private openNewTodoInput(): void {
		if (this.newTodoInput?.isConnected) {
			this.newTodoInput.focus();
			return;
		}
		const input = DOM.$('input.vibe-ai-plan-doc-todo-input') as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = localize('vibeAIPlanDoc.todoPlaceholder', "Todo description…");
		this.newTodoInput = input;
		this.renderAll();
	}

	private closeNewTodoInput(): void {
		this.newTodoInput = undefined;
	}

	private commitNewTodo(content: string): void {
		const parsed = this.parsed;
		const text = (content ?? '').trim();
		this.closeNewTodoInput();
		if (!parsed || !text || parsed.todosInsertLine < 0) {
			this.renderAll();
			return;
		}
		const nextId = parsed.todos.reduce((max, todo) => Math.max(max, typeof todo.id === 'number' ? todo.id : 0), 0) + 1;
		const block = [
			`  - id: ${nextId}`,
			`    content: ${yamlScalar(text)}`,
			`    status: pending`,
		].join('\n');
		this.editModel(model => {
			model.pushEditOperations([], [{
				range: { startLineNumber: parsed.todosInsertLine + 1, startColumn: 1, endLineNumber: parsed.todosInsertLine + 1, endColumn: 1 },
				text: `${block}\n`,
			}], () => null);
		});
	}

	private deleteTodos(parsed: IParsedPlanDoc, indexes: number[]): void {
		this.editModel(model => {
			// Delete bottom-up so the recorded line numbers stay valid.
			const ranges = indexes
				.map(index => parsed.todos[index])
				.filter(todo => todo.blockStart >= 0 && todo.blockEnd > todo.blockStart)
				.sort((a, b) => b.blockStart - a.blockStart);
			for (const todo of ranges) {
				model.pushEditOperations([], [{
					range: { startLineNumber: todo.blockStart + 1, startColumn: 1, endLineNumber: todo.blockEnd + 1, endColumn: 1 },
					text: '',
				}], () => null);
			}
		});
		this.selected.clear();
	}

	// ==================== Referenced by (Cursor parity) ====================

	/**
	 * Static "Referenced by 1 Agent" + the creating agent's author row (the
	 * plan doc is created by the agent that wrote it — Cursor image 2). No
	 * live lookup: openView would force the chat view open on every render.
	 */
	private renderRef(parsed: IParsedPlanDoc): void {
		const section = this.refSectionEl;
		if (!section) {
			return;
		}
		section.innerText = '';
		const header = DOM.append(section, $('.vibe-ai-plan-doc-ref-header'));
		DOM.append(header, $('span.vibe-ai-plan-doc-ref-count')).textContent =
			localize('vibeAIPlanDoc.refBy', "Referenced by {0} Agent", 1);
		const add = DOM.append(header, $('span.vibe-ai-plan-doc-todos-add'));
		add.textContent = localize('vibeAIPlanDoc.addTodo', "+ New");
		add.setAttribute('role', 'button');
		add.title = localize('vibeAIPlanDoc.spawnAgent', "Execute the plan in a new agent");
		const author = DOM.append(section, $('.vibe-ai-plan-doc-ref-author'));
		const icon = DOM.append(author, $('span.codicon.codicon-comment-discussion.vibe-ai-plan-doc-ref-icon'));
		icon.setAttribute('aria-hidden', 'true');
		DOM.append(author, $('span.vibe-ai-plan-doc-ref-name')).textContent =
			localize('vibeAIPlanDoc.author', "{0} · Author", parsed.name || 'Plan');
		this.renderDisposables.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => this.buildPlan()));
	}

	// ==================== Build (header button / selection / ref + New) ====================

	/** Workspace-relative (or absolute) path of the open doc, for chat-pane matching. */
	private docRefPath(): string {
		const input = this.input instanceof VibeAIPlanDocInput ? this.input : undefined;
		if (!input) {
			return '';
		}
		return input.resource.fsPath.replace(/\\/g, '/');
	}

	/** Cursor parity: Build executes the plan (owning agent, else a new one). */
	private buildPlan(): void {
		const parsed = this.parsed;
		if (!parsed || parsed.todos.length === 0) {
			return;
		}
		this.withChatPane(pane => {
			void pane.buildPlanFromDoc(this.docRefPath(), planFromDoc(parsed));
		});
	}

	private withChatPane(fn: (pane: VibeAIChatPane) => void): void {
		this.viewsService.openView(VibeAIChatPane.ID, false).then(view => {
			if (view) {
				fn(view as VibeAIChatPane);
			}
		}, () => {
			// The chat view is unavailable (agent window without it) —
			// the decision card in the hub remains the execution path.
		});
	}
}
