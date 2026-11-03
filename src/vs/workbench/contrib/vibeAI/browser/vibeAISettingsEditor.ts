/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAIService, VibeAICustomizeKind, VibeAICustomizeScope } from '../../../../platform/vibeAI/common/vibeAI.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorInputCapabilities, IEditorOpenContext, IUntitledTextResourceEditorInput, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeAIConnectionConfig, IVibeAIModelConfig, providerLabel, VIBE_AI_PROVIDER_PRESETS, VibeAIModelStore } from './vibeAIModelStore.js';
import './media/vibeAISettings.css';

const $ = DOM.$;

/** Pages rendered in the settings editor's content area. */
type SettingsPage = 'general' | 'models' | 'rules' | 'skills' | 'mcp' | 'unavailable';

/**
 * One sidebar navigation entry. `command` entries run directly and keep
 * the settings editor open so both tabs stay reachable.
 */
interface INavEntry {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly page?: SettingsPage;
	readonly command?: string;
	readonly commandArg?: string | undefined;
}

/**
 * Sidebar navigation (Cursor-parity layout, minus the account/user info
 * section — this fork requires no login). Sections without an
 * implementation render the generic placeholder page.
 */
const NAV_ENTRIES: Array<INavEntry | 'divider'> = [
	{ id: 'general', label: "General", icon: 'codicon-settings-gear', page: 'general' },
	{ id: 'vscodesettings', label: "VS Code Settings", icon: 'codicon-link-external', command: 'workbench.action.openSettings' },
	'divider',
	{ id: 'plan', label: "Plan & Usage", icon: 'codicon-graph', page: 'unavailable' },
	{ id: 'agents', label: "Agents", icon: 'codicon-sparkle', page: 'unavailable' },
	{ id: 'cloudAgents', label: "Cloud Agents", icon: 'codicon-cloud', page: 'unavailable' },
	'divider',
	{ id: 'models', label: "Models", icon: 'codicon-server', page: 'models' },
	{ id: 'git', label: "Git & PRs", icon: 'codicon-git-pull-request', page: 'unavailable' },
	{ id: 'rules', label: "Rules", icon: 'codicon-notebook', page: 'rules' },
	{ id: 'skills', label: "Skills", icon: 'codicon-lightbulb', page: 'skills' },
	{ id: 'mcp', label: "MCP", icon: 'codicon-plug', page: 'mcp' },
	{ id: 'browser', label: "Browser & Network", icon: 'codicon-globe', page: 'unavailable' },
	{ id: 'tab', label: "Tab", icon: 'codicon-arrow-right', page: 'unavailable' },
	{ id: 'indexing', label: "Indexing & Docs", icon: 'codicon-book', page: 'unavailable' },
	{ id: 'beta', label: "Beta", icon: 'codicon-beaker', page: 'unavailable' },
	'divider',
	{ id: 'docs', label: "Docs", icon: 'codicon-book', page: 'unavailable' },
];

/** Same key the chat pane's session store persists conversations under. */
const CHAT_SESSIONS_STORAGE_KEY = 'vibeAI.chat.sessions';
/** Phase 79: the chat pane's open-tab strip state (open + active sessions). */
const CHAT_OPEN_STATE_STORAGE_KEY = 'vibeAI.chat.openState';
/** Chat model selection config (empty = Auto / backend default). */
const CHAT_MODEL_CONFIG_KEY = 'vibeAI.chat.model';
/** Phase 184 r3: editor width under this collapses the nav to an icon rail. */
const RAIL_COLLAPSE_WIDTH = 600;
/** Phase 184 r4: the MCP add form's JSON-first template (Cursor / claude_desktop shape). */
const MCP_JSON_TEMPLATE = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`;
/**
 * Phase 186: skeletons for the customize add form's "Open file" — an
 * UNSAVED untitled editor pre-filled with the file format (keys in place,
 * body empty), mirroring what the create endpoints write (backend
 * app/api/customize.py). Save with Ctrl+S into the scope's folder —
 * .vibe/rules/<name>.mdc / .vibe/skills/<name>/SKILL.md — and hot reload
 * picks it up next turn.
 */
const RULES_FILE_TEMPLATE = [
	'---',
	'description: ',
	'globs: ',
	'alwaysApply: false',
	'---',
	'',
	'',
].join('\n');
const SKILLS_FILE_TEMPLATE = [
	'---',
	'name: ',
	'description: ',
	'disable-model-invocation: false',
	'---',
	'',
	'',
].join('\n');

/**
 * Editor input for the Cursor-parity settings editor (the title-bar gear
 * opens it directly in the editor area — no modal window, no dropdown).
 */
export class VibeAISettingsEditorInput extends EditorInput {

	static readonly ID: string = 'workbench.editors.vibeAISettings';

	readonly resource = undefined;

	private static _instance: VibeAISettingsEditorInput | undefined;

	/** Gets or creates the singleton instance of this input. */
	static getOrCreate(): VibeAISettingsEditorInput {
		if (!VibeAISettingsEditorInput._instance || VibeAISettingsEditorInput._instance.isDisposed()) {
			VibeAISettingsEditorInput._instance = new VibeAISettingsEditorInput();
		}
		return VibeAISettingsEditorInput._instance;
	}

	override get typeId(): string {
		return VibeAISettingsEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Singleton: one settings editor shared across all editor groups.
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('vibeAISettingsEditorName', "Settings");
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof VibeAISettingsEditorInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

/**
 * Cursor-parity settings editor (opened by the "Settings" gear in the title
 * bar): a searchable sidebar and a content area rendered directly in the
 * editor area as a tab. Fully implemented pages: General (backend check,
 * VS Code settings shortcuts, Tab completion / status bar toggles, chat
 * history), Models (provider connections — type + base URL + API key —
 * plus imported model names routed through them; the registry the chat
 * pane's model dropdown reads) and the Customize trio (Phase 142): Rules,
 * Skills and MCP — dual-scope lists (project .vibe / global ~/.vibe with
 * scope badges, project wins on name conflicts), an add form per page and
 * per-row open / delete actions; MCP rows carry an enable toggle and a
 * connection-status light backed by the config hot-reload. The remaining
 * Cursor sections are rendered as placeholders.
 */
export class VibeAISettingsEditorPane extends EditorPane {

	static readonly ID: string = 'workbench.editors.vibeAISettings.pane';

	// --- DOM (created once per pane)
	private root: HTMLElement | undefined;
	private navList: HTMLElement | undefined;
	private contentEl: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	/** Phase 184 r3: narrow-width watcher — collapses the sidebar to an icon rail. */
	private railObserver: ResizeObserver | undefined;

	// --- listeners: pane-level + per-render (cleared on every page render)
	private readonly paneDisposables = this._register(new DisposableStore());
	private readonly pageDisposables = this._register(new DisposableStore());

	// --- shared model registry (persisted in global storage)
	private readonly modelStore: VibeAIModelStore;

	// --- state
	private currentPage: string = 'general';
	/** Connection form state on the Models page: 'new' | connection id | undefined (closed). */
	private editingConnectionId: string | 'new' | undefined;
	/** Model form state on the Models page: 'new' | registry id | undefined (closed). */
	private editingModelId: string | 'new' | undefined;
	/** Phase 142: open add-form kind on the Rules / Skills / MCP pages (undefined = closed). */
	private customizeFormKind: VibeAICustomizeKind | undefined;
	/** Phase 185: inline edit target on the customize pages (kind + name + origin layer). */
	private customizeEditing: { kind: VibeAICustomizeKind; name: string; origin: string } | undefined;
	/** Model connectivity results: id -> '' (ok) or error message. */
	private readonly testResults = new Map<string, string>();
	/** Connection scan results: id -> message shown on the connection row. */
	private readonly scanResults = new Map<string, { ok: boolean; message: string }>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IVibeAIService private readonly vibeAIService: IVibeAIService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(VibeAISettingsEditorPane.ID, group, telemetryService, themeService, storageService);
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, $('.vibe-ai-settings-editor'));

		// --- sidebar: search + navigation
		const sidebar = DOM.append(this.root, $('.vibe-ai-settings-sidebar'));
		const search = DOM.append(sidebar, $('input.vibe-ai-settings-search')) as HTMLInputElement;
		search.type = 'text';
		search.spellcheck = false;
		search.placeholder = localize('vibeAISettings.search', "Search settings Ctrl+F");
		this.searchInput = search;
		this.navList = DOM.append(sidebar, $('.vibe-ai-settings-nav'));
		this.renderNav();

		// --- content area
		this.contentEl = DOM.append(this.root, $('.vibe-ai-settings-content'));

		// --- pane-level listeners
		this.paneDisposables.add(DOM.addDisposableListener(search, DOM.EventType.INPUT, () => this.filterNav(search.value)));
		this.paneDisposables.add(DOM.addDisposableListener(this.root, DOM.EventType.KEY_DOWN, e => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
				DOM.EventHelper.stop(e, true);
				this.searchInput?.focus();
				this.searchInput?.select();
			}
		}));
		// --- Phase 184 r3: a narrow editor collapses the sidebar to an
		//     icon-only rail (Cursor parity) — search and labels hide,
		//     entries become centered icon squares (names live on the
		//     title tooltip). The observer rides the editor area's width,
		//     not the window's, so a split/side-by-side layout collapses
		//     the nav exactly when the content would get squeezed.
		this.railObserver = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width ?? this.root?.clientWidth ?? 0;
			this.root?.classList.toggle('vibe-ai-settings-rail', width < RAIL_COLLAPSE_WIDTH);
		});
		this.railObserver.observe(this.root);
		this.paneDisposables.add(toDisposable(() => this.railObserver?.disconnect()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		super.setInput(input, options, context, token);
		this.showPage(this.currentPage);
	}

	override clearInput(): void {
		super.clearInput();
		this.pageDisposables.clear();
		if (this.contentEl) {
			this.contentEl.innerText = '';
		}
	}

	override focus(): void {
		// Focus the search box unless the user is already working inside
		// the editor (e.g. typing in a form field).
		if (!this.root?.contains(this.root.ownerDocument.activeElement)) {
			this.searchInput?.focus();
		}
	}

	override layout(_dimension: DOM.Dimension): void {
		// The flex layout fills the editor area — no manual sizing needed.
	}

	// ==================== sidebar navigation ====================

	private renderNav(): void {
		if (!this.navList) {
			return;
		}
		this.navList.innerText = '';
		for (const entry of NAV_ENTRIES) {
			if (entry === 'divider') {
				DOM.append(this.navList, $('.vibe-ai-settings-nav-divider'));
				continue;
			}
			const item = DOM.append(this.navList, $('.vibe-ai-settings-nav-item'));
			item.dataset.navId = entry.id;
			item.setAttribute('role', 'button');
			item.setAttribute('tabindex', '0');
			item.classList.toggle('active', entry.id === this.currentPage);
			const icon = DOM.append(item, $(`span.codicon.${entry.icon}`));
			icon.setAttribute('aria-hidden', 'true');
			// Phase 184 r3: a class of its own so the icon rail can hide
			// the label; the item's title keeps the name on hover.
			const label = DOM.append(item, $('span.vibe-ai-settings-nav-label'));
			label.textContent = entry.label;
			item.title = entry.label;
			if (entry.command) {
				// Direct-action entry (VS Code Settings): affordance.
				DOM.append(item, $('span.vibe-ai-settings-nav-arrow')).textContent = '→';
			}
			this.paneDisposables.add(DOM.addDisposableListener(item, DOM.EventType.CLICK, () => {
				if (entry.command) {
					// Run in a separate tab; the settings editor stays open.
					void this.commandService.executeCommand(entry.command, entry.commandArg);
					return;
				}
				this.currentPage = entry.id;
				this.updateNavActive();
				this.customizeEditing = undefined; // Phase 185: leaving the page closes the inline edit
				this.showPage(entry.id);
			}));
		}
	}

	private updateNavActive(): void {
		if (!this.navList) {
			return;
		}
		for (const child of Array.from(this.navList.children)) {
			const item = child as HTMLElement;
			item.classList.toggle('active', item.dataset.navId === this.currentPage);
		}
	}

	private filterNav(query: string): void {
		if (!this.navList) {
			return;
		}
		const q = query.trim().toLowerCase();
		for (const child of Array.from(this.navList.children)) {
			const item = child as HTMLElement;
			if (item.classList.contains('vibe-ai-settings-nav-divider')) {
				continue;
			}
			const label = item.textContent ?? '';
			item.style.display = q.length > 0 && !label.toLowerCase().includes(q) ? 'none' : '';
		}
	}

	private showPage(pageId: string): void {
		if (!this.contentEl) {
			return;
		}
		this.pageDisposables.clear();
		this.contentEl.innerText = '';
		const entry = NAV_ENTRIES.find((e): e is INavEntry => e !== 'divider' && e.id === pageId);
		switch (entry?.page) {
			case 'general':
				this.renderGeneralPage();
				break;
			case 'models':
				this.renderModelsPage();
				break;
			case 'rules':
				this.renderRulesPage();
				break;
			case 'skills':
				this.renderSkillsPage();
				break;
			case 'mcp':
				this.renderMcpPage();
				break;
			default:
				this.renderUnavailablePage(entry?.label ?? '');
				break;
		}
	}

	// ==================== General page ====================

	private renderGeneralPage(): void {
		if (!this.contentEl) {
			return;
		}
		DOM.append(this.contentEl, $('h1.vibe-ai-settings-title')).textContent = localize('vibeAISettings.general', "General");

		// --- backend connection card
		const backendCard = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(backendCard, $('.vibe-ai-settings-card-title')).textContent = localize('vibeAISettings.backendTitle', "VibeAI Backend");
		DOM.append(backendCard, $('.vibe-ai-settings-card-desc')).textContent = localize('vibeAISettings.backendDesc', "Check the connection to the local VibeCoding backend");
		const backendRow = DOM.append(backendCard, $('.vibe-ai-settings-card-actions'));
		const checkBtn = DOM.append(backendRow, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		checkBtn.textContent = localize('vibeAISettings.check', "Check");
		const resultEl = DOM.append(backendRow, $('span.vibe-ai-settings-check-result'));
		resultEl.style.display = 'none';
		this.pageDisposables.add(DOM.addDisposableListener(checkBtn, DOM.EventType.CLICK, async () => {
			checkBtn.disabled = true;
			resultEl.style.display = 'block';
			resultEl.className = 'vibe-ai-settings-check-result';
			resultEl.textContent = '…';
			const ok = await this.vibeAIService.healthCheck();
			checkBtn.disabled = false;
			resultEl.className = `vibe-ai-settings-check-result ${ok ? 'ok' : 'fail'}`;
			resultEl.textContent = ok
				? localize('vibeAISettings.connected', "✓ Connected")
				: localize('vibeAISettings.unreachable', "✗ Unreachable");
		}));
		// Phase 196/198: Restart — kill the spawned backend AND everything
		// still listening on the configured port (orphans/zombies this window
		// does not own), then start it again (an unreachable backend used to
		// leave the user with no recourse short of closing the whole editor).
		// The result element doubles as the feedback line; both buttons stay
		// disabled while it runs.
		const restartBtn = DOM.append(backendRow, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		restartBtn.textContent = localize('vibeAISettings.restart', "Restart");
		restartBtn.title = localize('vibeAISettings.restartTitle', "Kill the backend port (including leftover processes) and start it again");
		this.pageDisposables.add(DOM.addDisposableListener(restartBtn, DOM.EventType.CLICK, async () => {
			restartBtn.disabled = true;
			checkBtn.disabled = true;
			resultEl.style.display = 'block';
			resultEl.className = 'vibe-ai-settings-check-result';
			resultEl.textContent = '…';
			const ok = await this.vibeAIService.restartBackend();
			restartBtn.disabled = false;
			checkBtn.disabled = false;
			resultEl.className = `vibe-ai-settings-check-result ${ok ? 'ok' : 'fail'}`;
			resultEl.textContent = ok
				? localize('vibeAISettings.restarted', "✓ Restarted")
				: localize('vibeAISettings.restartFailed', "✗ Restart failed");
		}));

		this.appendGroupLabel(localize('vibeAISettings.preferences', "Preferences"));

		this.appendOpenCard(
			localize('vibeAISettings.editorSettings', "Editor Settings"),
			localize('vibeAISettings.editorSettingsDesc', "Configure font, formatting, minimap and more"),
			'workbench.action.openSettings',
			'editor',
		);
		this.appendOpenCard(
			localize('vibeAISettings.keybindings', "Keyboard Shortcuts"),
			localize('vibeAISettings.keybindingsDesc', "Configure keyboard shortcuts"),
			'workbench.action.openGlobalKeybindings',
		);
		this.appendToggleCard(
			localize('vibeAISettings.tabCompletion', "Tab Completion"),
			localize('vibeAISettings.tabCompletionDesc', "Enable Cursor-style Tab completion (ghost text)"),
			'vibeAI.inlineCompletion.enabled',
		);

		// Phase 139: terminal permission control (Cursor parity) — the
		// approval-mode select feeds the agent's terminal gate per turn.
		this.appendSelectCard(
			localize('vibeAISettings.permissionMode', "Terminal Permission"),
			localize('vibeAISettings.permissionModeDesc', "When the agent's terminal commands need your approval"),
			'vibeAI.agent.permissionMode',
			[
				{ value: 'review_all', label: localize('vibeAISettings.permissionMode.reviewAll', "Always ask") },
				{ value: 'high_risk', label: localize('vibeAISettings.permissionMode.highRisk', "High-risk only (default)") },
				{ value: 'trusted', label: localize('vibeAISettings.permissionMode.trusted', "Full trust") },
			],
		);

		this.appendGroupLabel(localize('vibeAISettings.layout', "Layout"));

		this.appendToggleCard(
			localize('vibeAISettings.statusBar', "Status Bar"),
			localize('vibeAISettings.statusBarDesc', "Show status bar at the bottom of the window"),
			'workbench.statusBar.visible',
		);
		this.appendActionCard(
			localize('vibeAISettings.clearHistory', "Clear Chat History"),
			localize('vibeAISettings.clearHistoryDesc', "Clear all persisted VibeAI conversations for this workspace"),
			localize('vibeAISettings.clear', "Clear"),
			() => {
				this.storageService.remove(CHAT_SESSIONS_STORAGE_KEY, StorageScope.WORKSPACE);
				// Phase 79: the cleared history leaves no open-tab ghosts.
				this.storageService.remove(CHAT_OPEN_STATE_STORAGE_KEY, StorageScope.WORKSPACE);
				this.notificationService.info(localize('vibeAISettings.cleared', "VibeAI chat history cleared"));
			},
		);
	}

	// ==================== shared card helpers ====================

	private appendGroupLabel(text: string): void {
		if (!this.contentEl) {
			return;
		}
		DOM.append(this.contentEl, $('.vibe-ai-settings-group')).textContent = text;
	}

	/** Card with an "Open" button that runs a command (opens another tab). */
	private appendOpenCard(title: string, description: string, command: string, arg?: string | undefined): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(card, $('.vibe-ai-settings-card-title')).textContent = title;
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = description;
		const actions = DOM.append(card, $('.vibe-ai-settings-card-actions'));
		const btn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		btn.textContent = localize('vibeAISettings.open', "Open");
		DOM.append(btn, $('span.codicon.codicon-link-external'));
		this.pageDisposables.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => {
			// Run in another tab; the settings editor stays open.
			void this.commandService.executeCommand(command, arg);
		}));
	}

	/** Card with a Cursor-style green toggle switch bound to a boolean setting. */
	private appendToggleCard(title: string, description: string, settingKey: string): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(card, $('.vibe-ai-settings-card-title')).textContent = title;
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = description;
		const actions = DOM.append(card, $('.vibe-ai-settings-card-actions'));
		const toggle = DOM.append(actions, $('.vibe-ai-settings-toggle'));
		const sync = () => toggle.classList.toggle('checked', this.configurationService.getValue<boolean>(settingKey) !== false);
		sync();
		this.pageDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, async () => {
			const current = this.configurationService.getValue<boolean>(settingKey) !== false;
			await this.configurationService.updateValue(settingKey, !current);
			sync();
		}));
	}

	/** Card with a Cursor-style select bound to an enum setting. */
	private appendSelectCard(title: string, description: string, settingKey: string, options: { value: string; label: string }[]): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(card, $('.vibe-ai-settings-card-title')).textContent = title;
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = description;
		const actions = DOM.append(card, $('.vibe-ai-settings-card-actions'));
		const select = DOM.append(actions, $('select.vibe-ai-settings-input')) as HTMLSelectElement;
		for (const opt of options) {
			const option = DOM.append(select, $('option')) as HTMLOptionElement;
			option.value = opt.value;
			option.textContent = opt.label;
		}
		const sync = () => {
			const current = this.configurationService.getValue<string>(settingKey);
			select.value = options.some(o => o.value === current) ? current : (options[1]?.value ?? options[0]?.value ?? '');
		};
		sync();
		this.pageDisposables.add(DOM.addDisposableListener(select, DOM.EventType.CHANGE, async () => {
			await this.configurationService.updateValue(settingKey, select.value);
		}));
		this.pageDisposables.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(settingKey)) {
				sync();
			}
		}));
	}

	/** Card with a button that runs a custom action. */
	private appendActionCard(title: string, description: string, buttonLabel: string, action: () => void): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(card, $('.vibe-ai-settings-card-title')).textContent = title;
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = description;
		const actions = DOM.append(card, $('.vibe-ai-settings-card-actions'));
		const btn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		btn.textContent = buttonLabel;
		this.pageDisposables.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, action));
	}

	// ==================== Models page (connections + model names) ====================

	private mkIconButton(actions: HTMLElement, icon: string, title: string): HTMLButtonElement {
		const btn = DOM.append(actions, $(`button.codicon.${icon}.vibe-ai-settings-icon-btn`)) as HTMLButtonElement;
		btn.title = title;
		btn.setAttribute('aria-label', title);
		return btn;
	}

	private mkFormField(card: HTMLElement, labelText: string, value: string, placeholder: string, isPassword: boolean): HTMLInputElement {
		const field = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(field, $('label')).textContent = labelText;
		const input = DOM.append(field, $('input.vibe-ai-settings-input')) as HTMLInputElement;
		input.type = isPassword ? 'password' : 'text';
		input.spellcheck = false;
		input.value = value;
		input.placeholder = placeholder;
		return input;
	}

	/**
	 * Cursor-parity flow: a connection (provider type + base URL + API key)
	 * is configured first, then model names are imported separately and
	 * routed through one of the connections.
	 */
	private renderModelsPage(): void {
		if (!this.contentEl) {
			return;
		}
		const head = DOM.append(this.contentEl, $('.vibe-ai-settings-page-head'));
		DOM.append(head, $('h1.vibe-ai-settings-title')).textContent = localize('vibeAISettings.models', "Models");
		const addConnBtn = DOM.append(head, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		addConnBtn.textContent = localize('vibeAISettings.addConnection', "Add Connection");
		this.pageDisposables.add(DOM.addDisposableListener(addConnBtn, DOM.EventType.CLICK, () => {
			this.editingConnectionId = 'new';
			this.showPage(this.currentPage);
		}));

		DOM.append(this.contentEl, $('.vibe-ai-settings-page-desc')).textContent = localize('vibeAISettings.modelsDesc', "First add a connection: pick the provider type (OpenAI, Anthropic, ...), then enter the base URL and API key. Model names are imported separately and route through a connection. \"Auto\" keeps using the backend's default model.");

		// --- connections (provider type + URL + key)
		const connections = this.modelStore.listConnections();
		this.appendGroupLabel(localize('vibeAISettings.connectionsGroup', "Connections"));
		if (this.editingConnectionId !== undefined) {
			this.renderConnectionForm(this.editingConnectionId === 'new' ? undefined : this.modelStore.getConnection(this.editingConnectionId));
		} else if (connections.length === 0) {
			DOM.append(this.contentEl, $('.vibe-ai-settings-empty')).textContent = localize('vibeAISettings.noConnections', "No connections yet — add one to import models.");
		}
		for (const connection of connections) {
			if (this.editingConnectionId === connection.id) {
				continue; // being edited — rendered as the form above
			}
			this.renderConnectionRow(connection);
		}
		if (connections.length > 0 && this.editingConnectionId === undefined) {
			const moreBtn = DOM.append(this.contentEl, $('button.vibe-ai-settings-btn.vibe-ai-settings-inline-btn')) as HTMLButtonElement;
			moreBtn.textContent = localize('vibeAISettings.addConnection', "Add Connection");
			this.pageDisposables.add(DOM.addDisposableListener(moreBtn, DOM.EventType.CLICK, () => {
				this.editingConnectionId = 'new';
				this.showPage(this.currentPage);
			}));
		}

		// --- models (names routed through a connection)
		const models = this.modelStore.list();
		this.appendGroupLabel(localize('vibeAISettings.modelsGroup', "Models"));
		if (this.editingModelId !== undefined) {
			this.renderModelForm(this.editingModelId === 'new' ? undefined : this.modelStore.get(this.editingModelId));
		} else if (models.length === 0) {
			DOM.append(this.contentEl, $('.vibe-ai-settings-empty')).textContent = localize('vibeAISettings.noModels', "No models imported yet — add one to select it in the chat's model dropdown.");
		}
		for (const model of models) {
			if (this.editingModelId === model.id) {
				continue; // being edited — rendered as the form above
			}
			this.renderModelRow(model);
		}
		if (this.editingModelId === undefined) {
			const addModelBtn = DOM.append(this.contentEl, $('button.vibe-ai-settings-btn.vibe-ai-settings-inline-btn')) as HTMLButtonElement;
			addModelBtn.textContent = localize('vibeAISettings.addModel', "Add Model");
			this.pageDisposables.add(DOM.addDisposableListener(addModelBtn, DOM.EventType.CLICK, () => {
				this.editingModelId = 'new';
				this.showPage(this.currentPage);
			}));
		}
	}

	private renderModelRow(model: IVibeAIModelConfig): void {
		if (!this.contentEl) {
			return;
		}
		const selectedId = this.configurationService.getValue<string>(CHAT_MODEL_CONFIG_KEY) || '';
		const isDefault = selectedId === model.id;
		const connection = this.modelStore.getConnection(model.connectionId);
		const enabled = !model.disabled;
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card.vibe-ai-settings-model' + (enabled ? '' : '.off')));
		const titleRow = DOM.append(card, $('.vibe-ai-settings-model-title'));
		DOM.append(titleRow, $('span.vibe-ai-settings-model-name')).textContent = model.name;
		if (isDefault) {
			DOM.append(titleRow, $('span.vibe-ai-settings-badge')).textContent = localize('vibeAISettings.defaultBadge', "Default");
		}
		const metaParts = [
			model.modelId,
			// Phase 70: Auto-routing tier (Cursor-parity tier label).
			model.tier
				? localize('vibeAISettings.tierMeta', "tier: {0}", model.tier)
				: localize('vibeAISettings.tierMetaAuto', "tier: auto-infer"),
			connection
				? localize('vibeAISettings.viaConnection', "via {0}", providerLabel(connection.provider))
				: localize('vibeAISettings.missingConnection', "connection missing"),
		];
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = metaParts.join(' · ');

		const actions = DOM.append(card, $('.vibe-ai-settings-model-actions'));

		// inline test result (kept across re-renders via this.testResults)
		const resultEl = DOM.append(actions, $('span.vibe-ai-settings-check-result'));
		resultEl.style.display = 'none';
		const savedResult = this.testResults.get(model.id);
		if (savedResult !== undefined) {
			resultEl.className = `vibe-ai-settings-check-result ${savedResult === '' ? 'ok' : 'fail'}`;
			resultEl.textContent = savedResult === '' ? localize('vibeAISettings.connected', "✓ Connected") : `✗ ${savedResult}`;
			resultEl.title = savedResult;
			resultEl.style.display = 'block';
		}

		// --- Test connection (1-token ping through the model's connection)
		const testBtn = this.mkIconButton(actions, 'codicon-pulse', localize('vibeAISettings.test', "Test connection"));
		const provider = this.modelStore.resolveProvider(model);
		if (!provider) {
			testBtn.disabled = true;
		} else {
			this.pageDisposables.add(DOM.addDisposableListener(testBtn, DOM.EventType.CLICK, async () => {
				testBtn.classList.remove('codicon-pulse');
				// Phase 235：配對 modifier-spin——裸 codicon-loading 在 1.142 基底 CSS 無動畫
				testBtn.classList.add('codicon-loading', 'codicon-modifier-spin');
				testBtn.disabled = true;
				resultEl.style.display = 'block';
				resultEl.className = 'vibe-ai-settings-check-result';
				resultEl.textContent = '…';
				const error = await this.vibeAIService.testModel(provider);
				this.testResults.set(model.id, error);
				testBtn.classList.remove('codicon-loading', 'codicon-modifier-spin');
				testBtn.classList.add('codicon-pulse');
				testBtn.disabled = false;
				resultEl.className = `vibe-ai-settings-check-result ${error === '' ? 'ok' : 'fail'}`;
				resultEl.textContent = error === '' ? localize('vibeAISettings.connected', "✓ Connected") : `✗ ${error}`;
				resultEl.title = error;
			}));
		}

		// --- Set as default (preselects in the chat's model dropdown)
		const defaultBtn = this.mkIconButton(actions, 'codicon-check', isDefault
			? localize('vibeAISettings.isDefault', "Default model")
			: localize('vibeAISettings.setDefault', "Set as default model"));
		if (isDefault) {
			defaultBtn.disabled = true;
		} else {
			this.pageDisposables.add(DOM.addDisposableListener(defaultBtn, DOM.EventType.CLICK, () => {
				void this.configurationService.updateValue(CHAT_MODEL_CONFIG_KEY, model.id);
				this.showPage(this.currentPage);
			}));
		}

		// --- Edit
		const editBtn = this.mkIconButton(actions, 'codicon-edit', localize('vibeAISettings.editModel', "Edit model"));
		this.pageDisposables.add(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, () => {
			this.editingModelId = model.id;
			this.showPage(this.currentPage);
		}));

		// --- Delete (resets the chat selection when it pointed at this model)
		const deleteBtn = this.mkIconButton(actions, 'codicon-trash', localize('vibeAISettings.deleteModel', "Delete model"));
		this.pageDisposables.add(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, () => {
			this.modelStore.delete(model.id);
			this.testResults.delete(model.id);
			if (this.configurationService.getValue<string>(CHAT_MODEL_CONFIG_KEY) === model.id) {
				void this.configurationService.updateValue(CHAT_MODEL_CONFIG_KEY, '');
			}
			this.showPage(this.currentPage);
		}));

		// --- Enable/disable (Cursor-parity toggle: hides the model from the chat's model dropdown)
		const toggle = DOM.append(actions, $('.vibe-ai-settings-toggle'));
		toggle.classList.toggle('checked', enabled);
		toggle.title = enabled
			? localize('vibeAISettings.enabledTip', "Enabled — click to hide this model from the chat's model dropdown")
			: localize('vibeAISettings.disabledTip', "Disabled — click to show this model in the chat's model dropdown");
		this.pageDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			this.modelStore.setEnabled(model.id, !enabled);
			if (enabled && this.configurationService.getValue<string>(CHAT_MODEL_CONFIG_KEY) === model.id) {
				// Disabling the default model clears the chat's selection.
				void this.configurationService.updateValue(CHAT_MODEL_CONFIG_KEY, '');
			}
			this.showPage(this.currentPage);
		}));
	}

	private renderConnectionRow(connection: IVibeAIConnectionConfig): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card.vibe-ai-settings-model'));
		const titleRow = DOM.append(card, $('.vibe-ai-settings-model-title'));
		DOM.append(titleRow, $('span.vibe-ai-settings-model-name')).textContent = providerLabel(connection.provider);
		const modelCount = this.modelStore.list().filter(m => m.connectionId === connection.id).length;
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = [
			connection.baseUrl,
			connection.apiKey
				? localize('vibeAISettings.keySaved', "API key saved")
				: localize('vibeAISettings.noKey', "No API key"),
			localize('vibeAISettings.connModels', "{0} models", modelCount),
		].join(' · ');

		const actions = DOM.append(card, $('.vibe-ai-settings-model-actions'));

		// inline scan result (kept across re-renders via this.scanResults)
		const resultEl = DOM.append(actions, $('span.vibe-ai-settings-check-result'));
		resultEl.style.display = 'none';
		const savedScan = this.scanResults.get(connection.id);
		if (savedScan !== undefined) {
			resultEl.className = `vibe-ai-settings-check-result ${savedScan.ok ? 'ok' : 'fail'}`;
			resultEl.textContent = savedScan.message;
			resultEl.style.display = 'block';
		}

		// --- Scan models (GET /models — imports every model the provider lists)
		const scanBtn = this.mkIconButton(actions, 'codicon-search', localize('vibeAISettings.scan', "Scan models (GET /models)"));
		this.pageDisposables.add(DOM.addDisposableListener(scanBtn, DOM.EventType.CLICK, async () => {
			scanBtn.classList.remove('codicon-search');
			// Phase 235：配對 modifier-spin——裸 codicon-loading 在 1.142 基底 CSS 無動畫
			scanBtn.classList.add('codicon-loading', 'codicon-modifier-spin');
			scanBtn.disabled = true;
			resultEl.style.display = 'block';
			resultEl.className = 'vibe-ai-settings-check-result';
			resultEl.textContent = '…';
			await this.scanConnectionModels(connection);
		}));

		// --- Edit
		const editBtn = this.mkIconButton(actions, 'codicon-edit', localize('vibeAISettings.editConnection', "Edit connection"));
		this.pageDisposables.add(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, () => {
			this.editingConnectionId = connection.id;
			this.showPage(this.currentPage);
		}));

		// --- Delete (removes its models; resets the chat selection when needed)
		const deleteBtn = this.mkIconButton(actions, 'codicon-trash', localize('vibeAISettings.deleteConnection', "Delete connection"));
		this.pageDisposables.add(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, () => {
			const removed = this.modelStore.deleteConnection(connection.id);
			const selected = this.configurationService.getValue<string>(CHAT_MODEL_CONFIG_KEY) || '';
			if (removed.some(m => m.id === selected)) {
				void this.configurationService.updateValue(CHAT_MODEL_CONFIG_KEY, '');
			}
			this.showPage(this.currentPage);
		}));
	}

	/**
	 * Scans a connection's `/models` endpoint (Cursor-parity "scan models")
	 * and imports every model the provider lists that is not imported yet —
	 * new ones land enabled, ready to be toggled off. The outcome is shown
	 * on the connection row.
	 */
	private async scanConnectionModels(connection: IVibeAIConnectionConfig): Promise<void> {
		try {
			const ids = await this.vibeAIService.discoverModels(connection.baseUrl, connection.apiKey);
			const added = this.modelStore.importDiscovered(connection.id, ids);
			this.scanResults.set(connection.id, {
				ok: true,
				message: added > 0
					? localize('vibeAISettings.scanImported', "✓ {0} models found, {1} new imported", ids.length, added)
					: localize('vibeAISettings.scanFound', "✓ {0} models found", ids.length),
			});
		} catch (error) {
			this.scanResults.set(connection.id, {
				ok: false,
				message: String(error).replace(/^Error:\s*/, ''),
			});
		}
		this.showPage(this.currentPage);
	}

	/** Add/Edit connection form: provider type → base URL (prefilled) → API key. */
	private renderConnectionForm(editing: IVibeAIConnectionConfig | undefined): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card.vibe-ai-settings-form'));
		DOM.append(card, $('.vibe-ai-settings-form-title')).textContent = editing
			? localize('vibeAISettings.editConnectionTitle', "Edit connection")
			: localize('vibeAISettings.addConnectionTitle', "Add connection");

		// --- connection type (fills the provider's default base URL)
		const providerField = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(providerField, $('label')).textContent = localize('vibeAISettings.fieldProvider', "Connection type");
		const providerSelect = DOM.append(providerField, $('select.vibe-ai-settings-input')) as HTMLSelectElement;
		for (const preset of VIBE_AI_PROVIDER_PRESETS) {
			const option = DOM.append(providerSelect, $('option')) as HTMLOptionElement;
			option.value = preset.id;
			option.textContent = preset.label;
		}
		providerSelect.value = editing?.provider ?? 'openai';

		const urlInput = this.mkFormField(card,
			localize('vibeAISettings.fieldBaseUrl', "Base URL"),
			editing?.baseUrl ?? VIBE_AI_PROVIDER_PRESETS[0].baseUrl,
			localize('vibeAISettings.fieldBaseUrlPh', "e.g. https://api.openai.com/v1"),
			false,
		);
		const keyInput = this.mkFormField(card,
			localize('vibeAISettings.fieldApiKey', "API Key (optional)"),
			editing?.apiKey ?? '',
			localize('vibeAISettings.fieldApiKeyPh', "Bearer key — leave empty for local servers"),
			true,
		);
		// Picking a connection type fills the provider's default base URL.
		this.pageDisposables.add(DOM.addDisposableListener(providerSelect, DOM.EventType.CHANGE, () => {
			const preset = VIBE_AI_PROVIDER_PRESETS.find(p => p.id === providerSelect.value);
			if (preset?.baseUrl) {
				urlInput.value = preset.baseUrl;
			}
		}));

		const errorEl = DOM.append(card, $('span.vibe-ai-settings-form-error'));
		errorEl.style.display = 'none';

		const actions = DOM.append(card, $('.vibe-ai-settings-form-actions'));
		const saveBtn = DOM.append(actions, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		saveBtn.textContent = localize('vibeAISettings.save', "Save");
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAISettings.cancel', "Cancel");

		/** Validates the fields: `{ config }` on success, `{ error }` otherwise. */
		const readForm = (): { config: IVibeAIConnectionConfig } | { error: string } => {
			const baseUrl = urlInput.value.trim().replace(/\/+$/, '');
			const apiKey = keyInput.value.trim();
			if (!baseUrl) {
				return { error: localize('vibeAISettings.connUrlRequired', "Base URL is required — pick a connection type or enter the endpoint.") };
			}
			if (!/^https?:\/\//.test(baseUrl)) {
				return { error: localize('vibeAISettings.formUrl', "Base URL must start with http:// or https://") };
			}
			return {
				config: {
					id: editing?.id ?? `conn-${Date.now()}`,
					provider: providerSelect.value,
					baseUrl,
					apiKey: apiKey || undefined,
					createdAt: editing?.createdAt ?? Date.now(),
				},
			};
		};

		this.pageDisposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, () => {
			const form = readForm();
			if ('error' in form) {
				errorEl.textContent = form.error;
				errorEl.className = 'vibe-ai-settings-form-error fail';
				errorEl.style.display = 'block';
				return;
			}
			this.modelStore.upsertConnection(form.config);
			this.editingConnectionId = undefined;
			const saved = form.config;
			this.showPage(this.currentPage);
			// Cursor-parity: scan the connection's /models right away so the
			// discovered models show up in the Models section with toggles.
			void this.scanConnectionModels(saved);
		}));

		this.pageDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this.editingConnectionId = undefined;
			this.showPage(this.currentPage);
		}));
	}

	/**
	 * Add/Edit model form (Cursor-parity): pick the connection, then enter
	 * the model name — no URL/key here, they live on the connection.
	 */
	private renderModelForm(editing: IVibeAIModelConfig | undefined): void {
		if (!this.contentEl) {
			return;
		}
		const connections = this.modelStore.listConnections();
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card.vibe-ai-settings-form'));
		DOM.append(card, $('.vibe-ai-settings-form-title')).textContent = editing
			? localize('vibeAISettings.editModelTitle', "Edit model")
			: localize('vibeAISettings.addModelTitle', "Add model");

		const errorEl = DOM.append(card, $('span.vibe-ai-settings-form-error'));
		errorEl.style.display = 'none';

		if (connections.length === 0) {
			// Models route through a connection — nothing to attach to yet.
			errorEl.className = 'vibe-ai-settings-form-error fail';
			errorEl.textContent = localize('vibeAISettings.needConnection', "Add a connection first — models route through a provider connection.");
			errorEl.style.display = 'block';
			const closeActions = DOM.append(card, $('.vibe-ai-settings-form-actions'));
			const closeBtn = DOM.append(closeActions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
			closeBtn.textContent = localize('vibeAISettings.cancel', "Cancel");
			this.pageDisposables.add(DOM.addDisposableListener(closeBtn, DOM.EventType.CLICK, () => {
				this.editingModelId = undefined;
				this.showPage(this.currentPage);
			}));
			return;
		}

		// --- connection the model routes through
		const connField = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(connField, $('label')).textContent = localize('vibeAISettings.fieldConnection', "Connection");
		const connSelect = DOM.append(connField, $('select.vibe-ai-settings-input')) as HTMLSelectElement;
		for (const connection of connections) {
			const option = DOM.append(connSelect, $('option')) as HTMLOptionElement;
			option.value = connection.id;
			option.textContent = `${providerLabel(connection.provider)} — ${connection.baseUrl}`;
		}
		connSelect.value = editing?.connectionId ?? connections[0].id;

		const modelInput = this.mkFormField(card,
			localize('vibeAISettings.fieldModelId', "Model ID"),
			editing?.modelId ?? '',
			localize('vibeAISettings.fieldModelIdPh', "The provider's model name, e.g. deepseek-chat"),
			false,
		);
		const nameInput = this.mkFormField(card,
			localize('vibeAISettings.fieldName', "Display name (optional)"),
			editing?.name ?? '',
			localize('vibeAISettings.fieldNamePh', "Defaults to the model ID"),
			false,
		);

		// --- Phase 70: Auto-routing tier (Cursor-parity tier labels) — the
		// Auto router groups the pool into fast/mid/strong; 'auto' infers
		// the tier from the model id keywords in the backend.
		const tierField = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(tierField, $('label')).textContent = localize('vibeAISettings.fieldTier', "Auto-routing tier");
		const tierSelect = DOM.append(tierField, $('select.vibe-ai-settings-input')) as HTMLSelectElement;
		for (const tierOption of [
			['auto', localize('vibeAISettings.tierAuto', "Auto-infer (from the model name)")],
			['fast', localize('vibeAISettings.tierFast', "Fast — small quick models")],
			['mid', localize('vibeAISettings.tierMid', "Mid — balanced models")],
			['strong', localize('vibeAISettings.tierStrong', "Strong — most capable models")],
		]) {
			const option = DOM.append(tierSelect, $('option')) as HTMLOptionElement;
			option.value = tierOption[0];
			option.textContent = tierOption[1];
		}
		tierSelect.value = editing?.tier ?? 'auto';

		const actions = DOM.append(card, $('.vibe-ai-settings-form-actions'));
		const saveBtn = DOM.append(actions, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		saveBtn.textContent = localize('vibeAISettings.save', "Save");
		const testBtn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		testBtn.textContent = localize('vibeAISettings.test', "Test");
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAISettings.cancel', "Cancel");

		/** Shows a validation/test outcome in the form's message line. */
		const showFormMessage = (message: string, ok: boolean): void => {
			errorEl.className = `vibe-ai-settings-form-error ${ok ? 'ok' : 'fail'}`;
			errorEl.textContent = message;
			errorEl.style.display = 'block';
		};

		/** Validates the fields: `{ config }` on success, `{ error }` otherwise. */
		const readForm = (): { config: IVibeAIModelConfig } | { error: string } => {
			const modelId = modelInput.value.trim();
			const name = nameInput.value.trim() || modelId;
			const connectionId = connSelect.value;
			const tier = tierSelect.value;
			if (!modelId) {
				return { error: localize('vibeAISettings.modelIdRequired', "Model ID is required — the provider's model name, e.g. deepseek-chat.") };
			}
			if (!this.modelStore.getConnection(connectionId)) {
				return { error: localize('vibeAISettings.missingConnection', "connection missing") };
			}
			return {
				config: {
					id: editing?.id ?? `model-${Date.now()}`,
					connectionId,
					name,
					modelId,
					// Phase 70: tier hint ('auto' = infer in the backend).
					...(tier && tier !== 'auto' ? { tier } : {}),
					createdAt: editing?.createdAt ?? Date.now(),
				},
			};
		};

		this.pageDisposables.add(DOM.addDisposableListener(testBtn, DOM.EventType.CLICK, async () => {
			const form = readForm();
			if ('error' in form) {
				showFormMessage(form.error, false);
				return;
			}
			const provider = this.modelStore.resolveProvider(form.config);
			if (!provider) {
				showFormMessage(localize('vibeAISettings.missingConnection', "connection missing"), false);
				return;
			}
			errorEl.className = 'vibe-ai-settings-form-error';
			errorEl.textContent = '…';
			errorEl.style.display = 'block';
			testBtn.disabled = true;
			const error = await this.vibeAIService.testModel(provider);
			testBtn.disabled = false;
			showFormMessage(error === '' ? localize('vibeAISettings.connected', "✓ Connected") : `✗ ${error}`, error === '');
		}));

		this.pageDisposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, () => {
			const form = readForm();
			if ('error' in form) {
				showFormMessage(form.error, false);
				return;
			}
			this.modelStore.upsert(form.config);
			this.testResults.delete(form.config.id);
			this.editingModelId = undefined;
			this.showPage(this.currentPage);
		}));

		this.pageDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this.editingModelId = undefined;
			this.showPage(this.currentPage);
		}));
	}

	// ==================== Customize pages (Rules / Skills / MCP) ====================

	private renderRulesPage(): void {
		this.renderCustomizeShell(
			'rules',
			localize('vibeAISettings.rules', "Rules"),
			localize('vibeAISettings.rulesDesc', "Project rules live in .vibe/rules/*.mdc and inject by trigger (alwaysApply / globs / description). Global rules live in ~/.vibe/rules and apply to every workspace. Project entries win on name conflicts."),
			localize('vibeAISettings.addRule', "Add Rule"),
		);
	}

	private renderSkillsPage(): void {
		this.renderCustomizeShell(
			'skills',
			localize('vibeAISettings.skills', "Skills"),
			localize('vibeAISettings.skillsDesc', "Skills are SKILL.md packages under .vibe/skills/<name>/ (project) or ~/.vibe/skills (global). The model sees the directory listing and loads the full skill with activate_skill. Project entries win on name conflicts."),
			localize('vibeAISettings.addSkill', "Add Skill"),
		);
	}

	private renderMcpPage(): void {
		this.renderCustomizeShell(
			'mcp',
			localize('vibeAISettings.mcp', "MCP"),
			localize('vibeAISettings.mcpDesc', "MCP servers come from .vibe/mcp.json (project) and ~/.vibe/mcp.json (global); project wins on name conflicts. Toggle a server to enable or disable it — the change hot-reloads and reconnects."),
			localize('vibeAISettings.addServer', "Add Server"),
		);
	}

	/**
	 * Shared page shell for the customize pages: head (title + Add button),
	 * description, the open add form (when any) and the async item list.
	 */
	private renderCustomizeShell(kind: VibeAICustomizeKind, title: string, description: string, addLabel: string): void {
		if (!this.contentEl) {
			return;
		}
		const head = DOM.append(this.contentEl, $('.vibe-ai-settings-page-head'));
		DOM.append(head, $('h1.vibe-ai-settings-title')).textContent = title;
		const addBtn = DOM.append(head, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		addBtn.textContent = addLabel;
		this.pageDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => {
			this.customizeFormKind = kind;
			this.customizeEditing = undefined; // Phase 185: add and inline-edit are mutually exclusive
			this.showPage(this.currentPage);
		}));
		DOM.append(this.contentEl, $('.vibe-ai-settings-page-desc')).textContent = description;
		if (this.customizeFormKind === kind) {
			this.renderCustomizeForm(kind);
		}
		const listEl = DOM.append(this.contentEl, $('.vibe-ai-settings-list'));
		this.loadCustomizeItems(kind, listEl);
	}

	/** Fetches the merged dual-scope list and renders one row per entry. */
	private loadCustomizeItems(kind: VibeAICustomizeKind, listEl: HTMLElement): void {
		listEl.innerText = '';
		DOM.append(listEl, $('.vibe-ai-settings-empty')).textContent = '…';
		this.vibeAIService.customizeList(kind).then(items => {
			if (!listEl.isConnected) {
				return; // the page switched while the request was in flight
			}
			listEl.innerText = '';
			if (items.length === 0) {
				DOM.append(listEl, $('.vibe-ai-settings-empty')).textContent = localize('vibeAISettings.noCustomItems', "Nothing here yet — add one.");
				return;
			}
			for (const item of items) {
				this.renderCustomizeRow(kind, item, listEl);
			}
		}).catch(error => {
			if (!listEl.isConnected) {
				return;
			}
			listEl.innerText = '';
			const failed = DOM.append(listEl, $('.vibe-ai-settings-empty'));
			failed.textContent = localize('vibeAISettings.loadFailed', "Failed to load — check the backend connection.");
			failed.title = String(error);
		});
	}

	/** The row's scope: origin "global" → global layer, else project (Phase 142). */
	private customizeScopeOf(item: IVibeAICustomizeItem): VibeAICustomizeScope {
		return item.origin === 'global' ? 'global' : 'project';
	}

	/**
	 * One customize row: name + scope badge (project blue / global grey) +
	 * kind meta + actions — every kind carries an enable toggle (Phase 185
	 * extends the MCP switch to rules/skills), an inline edit button and
	 * opens its definition file; every row deletes itself from its own
	 * scope (Phase 142). The row being edited renders as an in-place form
	 * card instead (same position in the list — no top-of-page expansion).
	 */
	private renderCustomizeRow(kind: VibeAICustomizeKind, item: IVibeAICustomizeItem, container: HTMLElement): void {
		if (this.customizeEditing?.kind === kind && this.customizeEditing.name === item.name && this.customizeEditing.origin === item.origin) {
			this.renderCustomizeEditForm(kind, item, container);
			return;
		}
		const card = DOM.append(container, $('.vibe-ai-settings-card.vibe-ai-settings-custom' + (item.enabled === false || item.disabled === true ? '.off' : '')));
		const titleRow = DOM.append(card, $('.vibe-ai-settings-model-title'));
		DOM.append(titleRow, $('span.vibe-ai-settings-model-name')).textContent = item.name;
		const isGlobal = item.origin === 'global';
		const badge = DOM.append(titleRow, $('span.vibe-ai-settings-scope-badge'));
		badge.classList.add(isGlobal ? 'global' : 'project');
		badge.textContent = isGlobal
			? localize('vibeAISettings.scopeBadgeGlobal', "Global")
			: localize('vibeAISettings.scopeBadgeProject', "Project");

		const metaParts: string[] = [];
		if (item.description) {
			metaParts.push(item.description);
		}
		if (kind === 'rules') {
			metaParts.push(
				item.alwaysApply
					? localize('vibeAISettings.ruleAlways', "always apply")
					: (item.globs?.length ? `globs: ${item.globs.join(', ')}` : localize('vibeAISettings.ruleOnDemand', "on demand")),
			);
		}
		if (kind === 'mcp') {
			if (item.command) {
				metaParts.push(item.command);
			}
			if (item.status === 'connected' && typeof item.toolCount === 'number') {
				metaParts.push(localize('vibeAISettings.mcpTools', "{0} tools", item.toolCount));
			}
		}
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = metaParts.join(' · ');

		const actions = DOM.append(card, $('.vibe-ai-settings-model-actions'));
		const scope = this.customizeScopeOf(item);

		if (kind === 'mcp') {
			// --- connection-status light (lazy: not connected until the
			// agent loop or the reload button connects)
			const statusEl = DOM.append(actions, $('span.vibe-ai-settings-check-result'));
			const status = item.status ?? 'disconnected';
			if (status === 'connected') {
				statusEl.className = 'vibe-ai-settings-check-result ok';
				statusEl.textContent = localize('vibeAISettings.mcpConnected', "✓ Connected");
			} else if (status === 'failed') {
				statusEl.className = 'vibe-ai-settings-check-result fail';
				statusEl.textContent = localize('vibeAISettings.mcpFailed', "✗ Failed");
				statusEl.title = item.error ?? '';
			} else if (status === 'disabled') {
				statusEl.className = 'vibe-ai-settings-check-result';
				statusEl.textContent = localize('vibeAISettings.mcpDisabled', "Disabled");
			} else {
				statusEl.className = 'vibe-ai-settings-check-result';
				statusEl.textContent = localize('vibeAISettings.mcpDisconnected', "Not connected");
			}

			// --- enabled toggle (Cursor-parity switch; writes + hot-reloads)
			const toggle = DOM.append(actions, $('.vibe-ai-settings-toggle'));
			toggle.classList.toggle('checked', item.enabled !== false);
			toggle.title = item.enabled !== false
				? localize('vibeAISettings.mcpEnabledTip', "Enabled — click to disable this server")
				: localize('vibeAISettings.mcpDisabledTip', "Disabled — click to enable this server");
			this.pageDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
				void this.vibeAIService.customizeToggle('mcp', item.name, scope).then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAISettings.toggleFailed', "Toggle failed"));
						return;
					}
					this.showPage(this.currentPage);
				});
			}));

			// --- reload & reconnect (after mcp.json changes)
			const reloadBtn = this.mkIconButton(actions, 'codicon-refresh', localize('vibeAISettings.mcpReload', "Reload & reconnect"));
			this.pageDisposables.add(DOM.addDisposableListener(reloadBtn, DOM.EventType.CLICK, () => {
				void this.vibeAIService.reloadMcp().then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAISettings.reloadFailed', "Reload failed"));
					}
					this.showPage(this.currentPage);
				});
			}));
		}

		// --- Phase 185: enable toggle for rules / skills (frontmatter
		// `disabled: true`; hot reload picks the mtime change up next turn)
		if (kind !== 'mcp') {
			const on = item.disabled !== true;
			const toggle = DOM.append(actions, $('.vibe-ai-settings-toggle'));
			toggle.classList.toggle('checked', on);
			toggle.title = on
				? localize('vibeAISettings.itemEnabledTip', "Enabled — click to disable")
				: localize('vibeAISettings.itemDisabledTip', "Disabled — click to enable");
			this.pageDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
				void this.vibeAIService.customizeToggle(kind, item.name, scope).then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAISettings.toggleFailed', "Toggle failed"));
						return;
					}
					this.showPage(this.currentPage);
				});
			}));
		}

		// --- inline edit (same fields as the add form, rendered in place)
		const editBtn = this.mkIconButton(actions, 'codicon-edit', localize('vibeAISettings.editItem', "Edit"));
		this.pageDisposables.add(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, () => {
			this.customizeFormKind = undefined;
			this.customizeEditing = { kind, name: item.name, origin: item.origin };
			this.showPage(this.currentPage);
		}));

		// --- open the definition file (rules .mdc / skills SKILL.md / mcp.json)
		const openBtn = this.mkIconButton(actions, 'codicon-go-to-file', localize('vibeAISettings.openFile', "Open file"));
		if (!item.path) {
			openBtn.disabled = true;
		} else {
			this.pageDisposables.add(DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, () => {
				// Phase 225: editing intent (the definition file) — bypass the
				// markdown Preview default resolver.
				void this.editorService.openEditor({ resource: URI.file(item.path), options: { override: DEFAULT_EDITOR_ASSOCIATION.id } });
			}));
		}

		// --- delete (from the row's own scope)
		const deleteBtn = this.mkIconButton(actions, 'codicon-trash', localize('vibeAISettings.deleteItem', "Delete"));
		this.pageDisposables.add(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, () => {
			void this.vibeAIService.customizeDelete(kind, item.name, scope).then(result => {
				if (!result.ok) {
					this.notificationService.error(result.error ?? localize('vibeAISettings.deleteFailed', "Delete failed"));
					return;
				}
				this.showPage(this.currentPage);
			});
		}));
	}

	/**
	 * Phase 185: inline edit form — the add form's fields, prefilled from
	 * the item, rendered inside the item's own block (this card takes the
	 * row's place in the list; no top-of-page expansion). Save goes through
	 * the same create endpoints (a same-name write is the update; mcp
	 * merge-writes the entry); name and scope stay fixed to the item.
	 */
	private renderCustomizeEditForm(kind: VibeAICustomizeKind, item: IVibeAICustomizeItem, container: HTMLElement): void {
		const scope = this.customizeScopeOf(item);
		const card = DOM.append(container, $('.vibe-ai-settings-card.vibe-ai-settings-custom.vibe-ai-settings-form'));
		const titleRow = DOM.append(card, $('.vibe-ai-settings-model-title'));
		DOM.append(titleRow, $('span.vibe-ai-settings-model-name')).textContent = item.name;
		const isGlobal = item.origin === 'global';
		const badge = DOM.append(titleRow, $('span.vibe-ai-settings-scope-badge'));
		badge.classList.add(isGlobal ? 'global' : 'project');
		badge.textContent = isGlobal
			? localize('vibeAISettings.scopeBadgeGlobal', "Global")
			: localize('vibeAISettings.scopeBadgeProject', "Project");

		const errorEl = DOM.append(card, $('span.vibe-ai-settings-form-error'));
		errorEl.style.display = 'none';
		const showFormMessage = (message: string): void => {
			errorEl.textContent = message;
			errorEl.style.display = 'block';
		};

		let jsonTa: HTMLTextAreaElement | undefined;
		if (kind === 'mcp') {
			jsonTa = this.mkFormTextarea(card,
				localize('vibeAISettings.fieldMcpJson', "Servers JSON"),
				this.mcpEditJson(item),
				localize('vibeAISettings.fieldMcpJsonPh', '{"mcpServers": { ... }} or a bare name → config map'),
			);
			jsonTa.classList.add('vibe-ai-settings-json');
		} else {
			// Name is the file identity — fixed; rename = delete + re-add.
			const nameInput = this.mkFormField(card,
				localize('vibeAISettings.fieldCustomName', "Name"),
				item.name,
				'',
				false,
			);
			nameInput.readOnly = true;
			nameInput.title = localize('vibeAISettings.editNameFixed', "Name is fixed — delete and re-add to rename");
		}

		let descInput: HTMLInputElement | undefined;
		let contentInput: HTMLTextAreaElement | undefined;
		let globsInput: HTMLInputElement | undefined;
		let alwaysToggle: HTMLElement | undefined;
		let disableToggle: HTMLElement | undefined;
		if (kind !== 'mcp') {
			descInput = this.mkFormField(card,
				localize('vibeAISettings.fieldDescription', "Description (optional)"),
				item.description,
				localize('vibeAISettings.fieldDescriptionPh', "Shown in the rules directory / skill listing"),
				false,
			);
			contentInput = this.mkFormTextarea(card,
				localize('vibeAISettings.fieldContent', "Content (Markdown body)"),
				item.content ?? '',
				localize('vibeAISettings.fieldContentPh', "The rule / skill instructions written in Markdown"),
			);
		}
		if (kind === 'rules') {
			globsInput = this.mkFormField(card,
				localize('vibeAISettings.fieldGlobs', "Globs (optional, comma-separated)"),
				(item.globs ?? []).join(', '),
				localize('vibeAISettings.fieldGlobsPh', "e.g. *.py, src/**/*.ts — matched against context files"),
				false,
			);
			alwaysToggle = this.mkFormToggle(card,
				localize('vibeAISettings.fieldAlwaysApply', "Always apply"),
				localize('vibeAISettings.fieldAlwaysApplyDesc', "Inject into every prompt (otherwise trigger by globs / description)"),
			);
			alwaysToggle.classList.toggle('checked', item.alwaysApply === true);
		}
		if (kind === 'skills') {
			disableToggle = this.mkFormToggle(card,
				localize('vibeAISettings.fieldDisableInvocation', "Disable model invocation"),
				localize('vibeAISettings.fieldDisableInvocationDesc', "Hide from the model — only triggerable by typing /name"),
			);
			disableToggle.classList.toggle('checked', item.disableModelInvocation === true);
		}

		const actions = DOM.append(card, $('.vibe-ai-settings-form-actions'));
		const saveBtn = DOM.append(actions, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		saveBtn.textContent = localize('vibeAISettings.save', "Save");
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAISettings.cancel', "Cancel");

		const closeEdit = (): void => {
			this.customizeEditing = undefined;
			this.showPage(this.currentPage);
		};
		this.pageDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, closeEdit));
		this.pageDisposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, async () => {
			if (kind === 'mcp') {
				// Merge-write the entry back into the origin layer's mcp.json
				// (same JSON-first path as the add form; validation first).
				await this.saveMcpJsonForm(jsonTa!.value, scope, saveBtn, showFormMessage, closeEdit);
				return;
			}
			const data: IVibeAICustomizeCreateData = {
				name: item.name,
				scope,
				...(descInput?.value.trim() ? { description: descInput.value.trim() } : {}),
				...(contentInput?.value ? { content: contentInput.value } : {}),
				...(kind === 'rules'
					? {
						alwaysApply: alwaysToggle?.classList.contains('checked') === true,
						globs: (globsInput?.value ?? '').split(',').map(g => g.trim()).filter(Boolean),
					}
					: {}),
				...(kind === 'skills' && disableToggle?.classList.contains('checked') ? { disableModelInvocation: true } : {}),
			};
			saveBtn.disabled = true;
			const result = await this.vibeAIService.customizeCreate(kind, data);
			saveBtn.disabled = false;
			if (!result.ok) {
				showFormMessage(result.error ?? localize('vibeAISettings.createFailed', "Create failed."));
				return;
			}
			closeEdit();
		}));
	}

	/** Phase 185: one-server mcpServers JSON for the inline edit textarea. */
	private mcpEditJson(item: IVibeAICustomizeItem): string {
		const config: Record<string, unknown> = { command: item.command ?? '' };
		if (item.args && item.args.length > 0) {
			config['args'] = item.args;
		}
		if (item.env && Object.keys(item.env).length > 0) {
			config['env'] = item.env;
		}
		if (item.cwd) {
			config['cwd'] = item.cwd;
		}
		return JSON.stringify({ mcpServers: { [item.name]: config } }, null, 2);
	}

	/**
	 * Phase 186: the add form's "Open file" — opens an UNSAVED untitled
	 * editor pre-filled with the kind's file skeleton (frontmatter keys in
	 * place, body empty — RULES_FILE_TEMPLATE / SKILLS_FILE_TEMPLATE /
	 * MCP_JSON_TEMPLATE). The user fills the body and saves wherever they
	 * pick (Ctrl+S → e.g. .vibe/rules/<name>.mdc); hot reload picks the
	 * file up next turn. mcp.json is JSON, the other two Markdown.
	 */
	private openCustomizeTemplate(kind: VibeAICustomizeKind): void {
		const contents = kind === 'mcp'
			? MCP_JSON_TEMPLATE
			: kind === 'rules' ? RULES_FILE_TEMPLATE : SKILLS_FILE_TEMPLATE;
		void this.editorService.openEditor({
			contents,
			languageId: kind === 'mcp' ? 'json' : 'markdown',
			resource: undefined,
		} satisfies IUntitledTextResourceEditorInput);
	}

	/** Add form (modeled on the Models connection form): scope first, then kind fields. */
	private renderCustomizeForm(kind: VibeAICustomizeKind): void {
		if (!this.contentEl) {
			return;
		}
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card.vibe-ai-settings-form'));
		const titleRow = DOM.append(card, $('.vibe-ai-settings-form-title.has-actions'));
		DOM.append(titleRow, $('span')).textContent = localize('vibeAISettings.addCustomTitle', "Add {0}", kind);
		const openBtn = this.mkIconButton(titleRow, 'codicon-go-to-file', localize('vibeAISettings.openTemplateFile', "Open file — new unsaved file with this format's skeleton"));
		this.pageDisposables.add(DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, () => {
			this.openCustomizeTemplate(kind);
		}));

		const errorEl = DOM.append(card, $('span.vibe-ai-settings-form-error'));
		errorEl.style.display = 'none';

		const hasFolder = !!this.contextService.getWorkspace().folders[0];
		const scopeSelect = this.mkScopeSelect(card, hasFolder ? 'project' : 'global');

		let nameInput: HTMLInputElement | undefined;
		let jsonTa: HTMLTextAreaElement | undefined;
		if (kind === 'mcp') {
			// Phase 184 r4: MCP is JSON-first (the agent window's r23 form) —
			// one mcpServers textarea instead of the Name/Command/Arguments
			// triplets; multiple servers land in one save.
			jsonTa = this.mkFormTextarea(card,
				localize('vibeAISettings.fieldMcpJson', "Servers JSON"),
				MCP_JSON_TEMPLATE,
				localize('vibeAISettings.fieldMcpJsonPh', '{"mcpServers": { ... }} or a bare name → config map'),
			);
			jsonTa.classList.add('vibe-ai-settings-json');
		} else {
			nameInput = this.mkFormField(card,
				localize('vibeAISettings.fieldCustomName', "Name"),
				'',
				this.customizeNamePlaceholder(kind),
				false,
			);
		}

		let descInput: HTMLInputElement | undefined;
		let contentInput: HTMLTextAreaElement | undefined;
		let globsInput: HTMLInputElement | undefined;
		let alwaysToggle: HTMLElement | undefined;
		let disableToggle: HTMLElement | undefined;
		if (kind !== 'mcp') {
			descInput = this.mkFormField(card,
				localize('vibeAISettings.fieldDescription', "Description (optional)"),
				'',
				localize('vibeAISettings.fieldDescriptionPh', "Shown in the rules directory / skill listing"),
				false,
			);
			contentInput = this.mkFormTextarea(card,
				localize('vibeAISettings.fieldContent', "Content (Markdown body)"),
				'',
				localize('vibeAISettings.fieldContentPh', "The rule / skill instructions written in Markdown"),
			);
		}
		if (kind === 'rules') {
			globsInput = this.mkFormField(card,
				localize('vibeAISettings.fieldGlobs', "Globs (optional, comma-separated)"),
				'',
				localize('vibeAISettings.fieldGlobsPh', "e.g. *.py, src/**/*.ts — matched against context files"),
				false,
			);
			alwaysToggle = this.mkFormToggle(card,
				localize('vibeAISettings.fieldAlwaysApply', "Always apply"),
				localize('vibeAISettings.fieldAlwaysApplyDesc', "Inject into every prompt (otherwise trigger by globs / description)"),
			);
		}
		if (kind === 'skills') {
			disableToggle = this.mkFormToggle(card,
				localize('vibeAISettings.fieldDisableInvocation', "Disable model invocation"),
				localize('vibeAISettings.fieldDisableInvocationDesc', "Hide from the model — only triggerable by typing /name"),
			);
		}

		const actions = DOM.append(card, $('.vibe-ai-settings-form-actions'));
		const saveBtn = DOM.append(actions, $('button.vibe-ai-settings-btn.primary')) as HTMLButtonElement;
		saveBtn.textContent = localize('vibeAISettings.save', "Save");
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-settings-btn')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAISettings.cancel', "Cancel");

		const showFormMessage = (message: string, ok: boolean): void => {
			errorEl.className = `vibe-ai-settings-form-error ${ok ? 'ok' : 'fail'}`;
			errorEl.textContent = message;
			errorEl.style.display = 'block';
		};

		this.pageDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this.customizeFormKind = undefined;
			this.showPage(this.currentPage);
		}));

		this.pageDisposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, async () => {
			if (kind === 'mcp') {
				// Phase 184 r4: JSON-first — parse once, create every server.
				await this.saveMcpJsonForm(
					jsonTa!.value,
					scopeSelect.value as VibeAICustomizeScope,
					saveBtn,
					message => showFormMessage(message, false),
					() => {
						this.customizeFormKind = undefined;
						this.showPage(this.currentPage);
					}
				);
				return;
			}
			const name = nameInput!.value.trim();
			if (!name) {
				showFormMessage(localize('vibeAISettings.nameRequired', "Name is required."), false);
				return;
			}
			const globs = kind === 'rules' ? (globsInput?.value ?? '').split(',').map(g => g.trim()).filter(Boolean) : [];
			const data: IVibeAICustomizeCreateData = {
				name,
				scope: scopeSelect.value as VibeAICustomizeScope,
				// rules / skills: description + Markdown body
				...(descInput?.value.trim() ? { description: descInput.value.trim() } : {}),
				...(contentInput?.value.trim() ? { content: contentInput.value } : {}),
				// rules: trigger matrix (alwaysApply / globs)
				...(kind === 'rules' && alwaysToggle?.classList.contains('checked') ? { alwaysApply: true } : {}),
				...(kind === 'rules' && globs.length > 0 ? { globs } : {}),
				// skills: hide from the model (user-trigger only)
				...(kind === 'skills' && disableToggle?.classList.contains('checked') ? { disableModelInvocation: true } : {}),
			};
			saveBtn.disabled = true;
			const result = await this.vibeAIService.customizeCreate(kind, data);
			saveBtn.disabled = false;
			if (!result.ok) {
				showFormMessage(result.error ?? localize('vibeAISettings.createFailed', "Create failed."), false);
				return;
			}
			this.customizeFormKind = undefined;
			this.showPage(this.currentPage);
		}));
	}

	/**
	 * Phase 184 r4: parses the MCP form's mcpServers JSON — the wrapped
	 * Cursor / claude_desktop shape `{ "mcpServers": { … } }`, or a bare
	 * name → config map — and creates every entry through the same backend
	 * payload the old field form built. Validation runs before the button
	 * disables; the first create failure surfaces in the form (earlier
	 * servers stay created).
	 */
	private async saveMcpJsonForm(raw: string, scope: VibeAICustomizeScope, saveBtn: HTMLButtonElement, showMsg: (message: string) => void, done: () => void): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			showMsg(localize('vibeAISettings.mcpJsonInvalid', "Invalid JSON — check the syntax and try again."));
			return;
		}
		let servers: Record<string, unknown> | undefined;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const obj = parsed as Record<string, unknown>;
			if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
				servers = obj.mcpServers as Record<string, unknown>;
			} else {
				const entries = Object.entries(obj);
				if (entries.length > 0 && entries.every(([, cfg]) => cfg && typeof cfg === 'object' && !Array.isArray(cfg))) {
					servers = obj; // bare map without the mcpServers wrapper
				}
			}
		}
		if (!servers || Object.keys(servers).length === 0) {
			showMsg(localize('vibeAISettings.mcpJsonNoServers', "No servers found — the JSON needs a \"mcpServers\" object."));
			return;
		}
		const batch: IVibeAICustomizeCreateData[] = [];
		for (const [name, cfg] of Object.entries(servers)) {
			const config = (cfg ?? {}) as Record<string, unknown>;
			const command = typeof config.command === 'string' ? config.command.trim() : '';
			if (!name.trim() || !command) {
				showMsg(localize('vibeAISettings.mcpJsonServerInvalid', "Each server needs a name and a \"command\" (e.g. npx, python)."));
				return;
			}
			const args = Array.isArray(config.args)
				? config.args.filter((arg): arg is string => typeof arg === 'string')
				: undefined;
			let env: Record<string, string> | undefined;
			if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
				const collected: Record<string, string> = {};
				for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
					if (typeof value === 'string') {
						collected[key] = value;
					}
				}
				env = Object.keys(collected).length > 0 ? collected : undefined;
			}
			batch.push({
				name: name.trim(),
				scope,
				command,
				...(args && args.length > 0 ? { args } : {}),
				...(env && Object.keys(env).length > 0 ? { env } : {}),
			});
		}
		for (const entry of batch) {
			saveBtn.disabled = true;
			const result = await this.vibeAIService.customizeCreate('mcp', entry);
			saveBtn.disabled = false;
			if (!result.ok) {
				showMsg(localize('vibeAISettings.mcpJsonCreateFailed', "Failed to create \"{0}\": {1}", entry.name, result.error ?? localize('vibeAISettings.createFailed', "Create failed.")));
				return;
			}
		}
		done();
	}

	/** Scope select (project / global) for the customize add form (Cursor parity:
	 * the project option is named after the open workspace root; without a
	 * folder the project option is disabled and global is the only choice). */
	private mkScopeSelect(card: HTMLElement, current: VibeAICustomizeScope): HTMLSelectElement {
		const field = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(field, $('label')).textContent = localize('vibeAISettings.fieldScope', "Scope");
		const select = DOM.append(field, $('select.vibe-ai-settings-input')) as HTMLSelectElement;
		const folder = this.contextService.getWorkspace().folders[0];
		for (const [value, label, disabled] of [
			['project', folder
				? localize('vibeAISettings.scopeProject', "Project ({0})", folder.name)
				: localize('vibeAISettings.scopeProjectNoFolder', "Project (no folder open)"), !folder],
			['global', localize('vibeAISettings.scopeGlobal', "Global (every workspace)"), false],
		] as const) {
			const option = DOM.append(select, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
			option.disabled = disabled;
		}
		select.value = current;
		return select;
	}

	/** Multi-line content field for the customize add form. */
	private mkFormTextarea(card: HTMLElement, labelText: string, value: string, placeholder: string): HTMLTextAreaElement {
		const field = DOM.append(card, $('.vibe-ai-settings-field'));
		DOM.append(field, $('label')).textContent = labelText;
		const textarea = DOM.append(field, $('textarea.vibe-ai-settings-input')) as HTMLTextAreaElement;
		textarea.spellcheck = false;
		textarea.value = value;
		textarea.placeholder = placeholder;
		textarea.rows = 6;
		return textarea;
	}

	/** Cursor-parity toggle row inside the customize add form (tooltip = description). */
	private mkFormToggle(card: HTMLElement, labelText: string, description: string): HTMLElement {
		const field = DOM.append(card, $('.vibe-ai-settings-field.vibe-ai-settings-field-row'));
		const label = DOM.append(field, $('label'));
		label.textContent = labelText;
		label.title = description;
		const toggle = DOM.append(field, $('.vibe-ai-settings-toggle'));
		toggle.title = description;
		this.pageDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			toggle.classList.toggle('checked');
		}));
		return toggle;
	}

	/** Name placeholder per customize kind (MCP goes through the JSON form, no name field). */
	private customizeNamePlaceholder(kind: Exclude<VibeAICustomizeKind, 'mcp'>): string {
		if (kind === 'rules') {
			return localize('vibeAISettings.ruleNamePh', "kebab-case name, e.g. code-review (creates <name>.mdc)");
		}
		return localize('vibeAISettings.skillNamePh', "folder name, e.g. commit-helper (creates <name>/SKILL.md)");
	}

	private renderUnavailablePage(label: string): void {
		if (!this.contentEl) {
			return;
		}
		DOM.append(this.contentEl, $('h1.vibe-ai-settings-title')).textContent = label;
		const card = DOM.append(this.contentEl, $('.vibe-ai-settings-card'));
		DOM.append(card, $('.vibe-ai-settings-card-title')).textContent = localize('vibeAISettings.unavailableTitle', "Not available");
		DOM.append(card, $('.vibe-ai-settings-card-desc')).textContent = localize('vibeAISettings.unavailableDesc', "This section is not available in this build of VibeAI.");
	}
}