/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAIBackgroundAgent, IVibeAIParallelRun, IVibeAIStreamData, IVibeAIService } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VibeAIChatSessionStore, IVibeAIChatHandoff, IVibeAIChatSession, VIBE_AI_HANDOFF_MAX_AGE_MS, VIBE_AI_HANDOFF_STORAGE_KEY, parseVibeAIChatHandoff } from './vibeAIChatSessionStore.js';
import { VibeAIChatPane } from './vibeAIChatPane.js';
import { VibeAISettingsEditorInput } from './vibeAISettingsEditor.js';
import { VibeAIModelStore } from './vibeAIModelStore.js';
import './media/vibeAIAgentsHub.css';

const $ = DOM.$;

/** Max sessions rendered in the sidebar (the store caps at 25 anyway). */
const SESSIONS_MAX = 25;
/** One-line clip for background agents' summary / error text. */
const BG_SUMMARY_MAX_CHARS = 120;
/** How often the background-agents strip refreshes while the hub is open. */
const BG_POLL_MS = 30_000;
/** One-line clip for a parallel run's prompt / variant detail. */
const PARALLEL_TEXT_MAX_CHARS = 90;
/** Parallel runs shown before older ones fall off (the registry prunes itself). */
const PARALLEL_RUNS_MAX = 6;

/**
 * Application-scoped storage key carrying the project folder the title-bar
 * pill queued when launching the agent window (Phase 177). The agent window
 * itself opens on a neutral workspace on purpose (opening the real folder
 * would share workspace storage with the IDE window), so the real project
 * travels through application storage instead of the workspace context.
 */
export const AGENT_WINDOW_PROJECT_STORAGE_KEY = 'vibeAI.agentWindow.project';

/**
 * Live state of one streaming conversation, tracked by the hub from the
 * shared stream (`onStreamData`, events carry the conversation's session
 * id — Phase 176). Keyed by session id; a terminal turn_state / done
 * removes the entry.
 */
interface VibeAILiveTurn {
	state: string;
	lastEventAt: number;
}

/** turn_state values (backend TurnStateMachine, Phase 150) → hub status label. */
const LIVE_STATE_LABELS: Record<string, string> = {
	'queued': localize('vibeAIAgentsHub.state.queued', "Queued"),
	'thinking': localize('vibeAIAgentsHub.state.thinking', "Thinking…"),
	'executing_tools': localize('vibeAIAgentsHub.state.executingTools', "Working…"),
	'waiting_approval': localize('vibeAIAgentsHub.state.waitingApproval', "Waiting for approval"),
	'waiting_user_input': localize('vibeAIAgentsHub.state.waitingUserInput', "Waiting for your answer"),
	'awaiting_plan_approval': localize('vibeAIAgentsHub.state.awaitingPlanApproval', "Waiting for plan approval"),
	'compacting': localize('vibeAIAgentsHub.state.compacting', "Compacting context…"),
	'finalizing': localize('vibeAIAgentsHub.state.finalizing', "Finalizing…"),
};

const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'interrupted']);

/** Session-id → live turn for sessions streaming right now (hub-wide). */
const liveTurns = new Map<string, VibeAILiveTurn>();

/**
 * Editor input for the Agents hub (the title-bar pill opens it directly in
 * the editor area — the fork's own multi-session agents surface, replacing
 * the upstream Agents Window whose agent stack (Claude / Codex / Copilot
 * CLI + GitHub sign-in) never touched the VibeCoding backend.
 */
export class VibeAIAgentsHubInput extends EditorInput {

	static readonly ID: string = 'workbench.editors.vibeAIAgentsHub';

	readonly resource = undefined;

	private static _instance: VibeAIAgentsHubInput | undefined;

	/** Gets or creates the singleton instance of this input. */
	static getOrCreate(): VibeAIAgentsHubInput {
		if (!VibeAIAgentsHubInput._instance || VibeAIAgentsHubInput._instance.isDisposed()) {
			VibeAIAgentsHubInput._instance = new VibeAIAgentsHubInput();
		}
		return VibeAIAgentsHubInput._instance;
	}

	override get typeId(): string {
		return VibeAIAgentsHubInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// Singleton: one hub editor shared across all editor groups.
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('vibeAIAgentsHubName', "Agents");
	}

	override getIcon(): ThemeIcon {
		return Codicon.agent;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof VibeAIAgentsHubInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

/**
 * Phase 176 — the Agents hub, laid out like Cursor's Agents page (the
 * screenshot the user asked to match): a left rail with New Chat /
 * Automations / Customize, a Projects section listing the workspace's
 * conversations (live ones show their turn state instead of a timestamp),
 * and a main canvas with a project top bar and a big centered composer
 * that starts a conversation right from the hub. Background subagents
 * (Phase 128 registry, read-only snapshot) surface as a strip under the
 * composer. Fully local + local-backend: no sign-in anywhere.
 */
export class VibeAIAgentsHubPane extends EditorPane {

	static readonly ID: string = 'workbench.editors.vibeAIAgentsHub.pane';

	// --- DOM (created once per pane)
	private root: HTMLElement | undefined;
	private sessionsEl: HTMLElement | undefined;
	private backgroundEl: HTMLElement | undefined;
	private parallelEl: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private projectNameEl: HTMLElement | undefined;
	private repoListEl: HTMLElement | undefined;
	private filterInput: HTMLInputElement | undefined;
	private sidebarFilter = '';
	private menuDisposables: DisposableStore | undefined;
	/** Thread expanded in the center canvas (undefined = fresh composer). */
	private selectedSessionId: string | undefined;
	/** Center transcript container (hidden until a thread is expanded). */
	private chatEl: HTMLElement | undefined;

	// --- listeners: pane-level (die with the pane)
	private readonly paneDisposables = this._register(new DisposableStore());

	private readonly sessionStore: VibeAIChatSessionStore;
	private readonly modelStore: VibeAIModelStore;
	/** Latest background-agents snapshot (undefined = not fetched yet). */
	private backgroundAgents: IVibeAIBackgroundAgent[] | undefined;
	/**
	 * Phase 179: this project's parallel runs from the backend registry
	 * (undefined = not fetched yet), overlaid by {@link parallelLive}.
	 */
	private parallelRuns: IVibeAIParallelRun[] | undefined;
	/**
	 * Phase 179: live parallel-run state straight from the stream —
	 * fresher than the polled registry between polls. A run the hub
	 * starts itself is seeded under its client requestId (`pending-…`)
	 * and adopted under the backend runId on the first start event.
	 */
	private readonly parallelLive = new Map<string, IVibeAIParallelRun>();
	/** The hub's in-flight parallel request ids → their live-run key. */
	private readonly parallelRequestToRun = new Map<string, string>();
	/** True in the standalone agent window (Phase 177), false in IDE windows. */
	private readonly isAgentWindow: boolean;
	/** Project of the last thread the user opened (agent window navigation). */
	private lastOpenedProjectRoot: string | undefined;
	/** Thread an IDE window just handed over (highlighted once, Phase 180). */
	private handoffSessionId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IVibeAIService private readonly vibeAIService: IVibeAIService,
		@IViewsService private readonly viewsService: IViewsService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(VibeAIAgentsHubPane.ID, group, telemetryService, themeService, storageService);
		this.sessionStore = new VibeAIChatSessionStore(storageService, contextService);
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
		this.isAgentWindow = environmentService.isVibeAgentWindow;
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, $('.vibe-ai-agents-hub'));

		// ==================== left rail (Cursor parity) ====================
		const side = DOM.append(this.root, $('.vibe-ai-agents-side'));

		// --- rail header (Cursor parity): collapse the rail + thread search
		const sideHead = DOM.append(side, $('.vibe-ai-agents-side-head'));
		const collapseBtn = DOM.append(sideHead, $('button.codicon.codicon-layout-sidebar-left.vibe-ai-agents-head-btn')) as HTMLButtonElement;
		collapseBtn.title = localize('vibeAIAgentsHub.toggleRail', "Toggle sidebar");
		this.paneDisposables.add(DOM.addDisposableListener(collapseBtn, DOM.EventType.CLICK, () => { this.root?.classList.toggle('rail-collapsed'); }));
		const searchBtn = DOM.append(sideHead, $('button.codicon.codicon-search.vibe-ai-agents-head-btn')) as HTMLButtonElement;
		searchBtn.title = localize('vibeAIAgentsHub.searchThreads', "Search conversations");
		this.filterInput = DOM.append(side, $('input.vibe-ai-agents-filter')) as HTMLInputElement;
		this.filterInput.placeholder = localize('vibeAIAgentsHub.filterPlaceholder', "Search conversations");
		this.filterInput.style.display = 'none';
		this.paneDisposables.add(DOM.addDisposableListener(searchBtn, DOM.EventType.CLICK, () => {
			if (!this.filterInput) {
				return;
			}
			const show = this.filterInput.style.display === 'none';
			this.filterInput.style.display = show ? 'block' : 'none';
			if (show) {
				this.filterInput.focus();
			} else {
				this.filterInput.value = '';
				this.sidebarFilter = '';
				this.renderSessions();
			}
		}));
		this.paneDisposables.add(DOM.addStandardDisposableListener(this.filterInput, DOM.EventType.INPUT, () => {
			this.sidebarFilter = (this.filterInput?.value ?? '').toLowerCase();
			this.renderSessions();
		}));

		// --- top actions
		const actions = DOM.append(side, $('.vibe-ai-agents-actions'));
		this.appendActionRow(actions, localize('vibeAIAgentsHub.newChat', "New Chat"), Codicon.plus, () => {
			// Phase 181 r7 (user: the agent window has no right-hand chat panel
			// and no second composer): New Chat just resets the hub's center
			// composer — the next send starts the new conversation. IDE
			// windows keep seeding the chat pane directly.
			if (this.isAgentWindow) {
				// r8: New Chat collapses the expanded thread — a fresh
				// composer is the new conversation.
				this.selectedSessionId = undefined;
				this.renderConversation();
				this.renderSessions();
				if (this.composerInput) {
					this.composerInput.value = '';
				}
				this.composerInput?.focus();
				return;
			}
			this.openChat(pane => pane.newConversation(this.resolveProjectRoot()));
		});
		// Automations (Cursor's scheduled agents) has no backend yet — the
		// row renders disabled instead of pretending.
		const automations = this.appendActionRow(actions, localize('vibeAIAgentsHub.automations', "Automations"), Codicon.sync, () => { });
		automations.classList.add('disabled');
		automations.title = localize('vibeAIAgentsHub.automationsDisabled', "Automations aren't available in this build yet");
		automations.setAttribute('aria-disabled', 'true');
		this.appendActionRow(actions, localize('vibeAIAgentsHub.customize', "Customize"), Codicon.gear, () => {
			this.editorService.openEditor(VibeAISettingsEditorInput.getOrCreate(), { pinned: true });
		});

		// --- Projects section (Cursor parity): "+ New Project" opens a
		// folder picker; Repositories lists every project this window has
		// chatted about (distinct roots across stored sessions).
		const projects = DOM.append(side, $('.vibe-ai-agents-projects'));
		DOM.append(projects, $('.vibe-ai-agents-section-label')).textContent = localize('vibeAIAgentsHub.projects', "Projects");
		const newProjectRow = DOM.append(projects, $('.vibe-ai-agents-new-project'));
		DOM.append(newProjectRow, $('span.codicon.codicon-new-folder'));
		DOM.append(newProjectRow, $('span')).textContent = localize('vibeAIAgentsHub.newProject', "New Project");
		this.paneDisposables.add(DOM.addDisposableListener(newProjectRow, DOM.EventType.CLICK, () => { this.pickProject(); }));
		const reposHead = DOM.append(projects, $('.vibe-ai-agents-repos-head'));
		const reposLabel = DOM.append(reposHead, $('.vibe-ai-agents-section-label'));
		reposLabel.textContent = localize('vibeAIAgentsHub.repositories', "Repositories");
		const repoFilterBtn = DOM.append(reposHead, $('button.codicon.codicon-filter.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		repoFilterBtn.title = localize('vibeAIAgentsHub.pickProject', "Open a project folder");
		this.paneDisposables.add(DOM.addDisposableListener(repoFilterBtn, DOM.EventType.CLICK, () => { this.pickProjectFromRepos(repoFilterBtn); }));
		const repoOpenBtn = DOM.append(reposHead, $('button.codicon.codicon-link-external.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		repoOpenBtn.title = localize('vibeAIAgentsHub.openIdeTitle', "Open this project in the IDE");
		this.paneDisposables.add(DOM.addDisposableListener(repoOpenBtn, DOM.EventType.CLICK, () => { this.openInIde(); }));
		this.repoListEl = DOM.append(projects, $('.vibe-ai-agents-repos'));

		// --- thread list (recent conversations; live ones show state)
		this.sessionsEl = DOM.append(side, $('.vibe-ai-agents-sessions'));

		// --- rail footer: the account row (Cursor parity) — there is no
		// sign-in anywhere in this fork, so the avatar stands for the local
		// product and the gear opens the VibeAI settings.
		const footer = DOM.append(side, $('.vibe-ai-agents-foot'));
		const userRow = DOM.append(footer, $('.vibe-ai-agents-user'));
		const avatar = DOM.append(userRow, $('span.vibe-ai-agents-avatar'));
		avatar.textContent = 'V';
		DOM.append(userRow, $('span.vibe-ai-agents-user-name')).textContent = localize('vibeAIAgentsHub.userName', "Vulcan");
		const userGear = DOM.append(userRow, $('button.codicon.codicon-settings-gear.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		userGear.title = localize('vibeAIAgentsHub.settings', "Settings");
		userGear.setAttribute('aria-label', userGear.title);
		this.paneDisposables.add(DOM.addDisposableListener(userGear, DOM.EventType.CLICK, () => {
			this.editorService.openEditor(VibeAISettingsEditorInput.getOrCreate(), { pinned: true });
		}));

		// ==================== main canvas ====================
		const main = DOM.append(this.root, $('.vibe-ai-agents-main'));

		// --- top bar (Phase 181): project and "This PC" moved into the
		// composer's context chips; the bar keeps only the "IDE ↗" jump back
		// to a real editor window (agent window only)
		const topbar = DOM.append(main, $('.vibe-ai-agents-topbar'));
		// Shown only while the rail is collapsed — brings the sidebar back.
		const railExpand = DOM.append(topbar, $('button.codicon.codicon-layout-sidebar-left.vibe-ai-agents-head-btn.vibe-ai-agents-rail-expand')) as HTMLButtonElement;
		railExpand.title = localize('vibeAIAgentsHub.toggleRail', "Toggle sidebar");
		this.paneDisposables.add(DOM.addDisposableListener(railExpand, DOM.EventType.CLICK, () => { this.root?.classList.toggle('rail-collapsed'); }));
		if (this.isAgentWindow) {
			const ideBtn = DOM.append(topbar, $('button.vibe-ai-agents-ide')) as HTMLButtonElement;
			DOM.append(ideBtn, $('span.codicon.codicon-link-external'));
			ideBtn.appendChild(document.createTextNode(localize('vibeAIAgentsHub.openIde', "IDE")));
			ideBtn.title = localize('vibeAIAgentsHub.openIdeTitle', "Open this project in the IDE");
			ideBtn.setAttribute('aria-label', ideBtn.title);
			this.paneDisposables.add(DOM.addDisposableListener(ideBtn, DOM.EventType.CLICK, () => this.openInIde()));
		}

		// --- centered composer (starts conversations right from the hub)
		const center = DOM.append(main, $('.vibe-ai-agents-center'));
		// Phase 181 r8: clicking a thread expands its conversation in the
		// center canvas above the composer (Cursor agent-window parity).
		this.chatEl = DOM.append(center, $('.vibe-ai-agents-chat'));
		// Phase 181 r2: context chips float ABOVE the composer card,
		// borderless (Cursor layout) — target project + "This PC".
		const chips = DOM.append(center, $('.vibe-ai-agents-chips'));
		const projectChip = DOM.append(chips, $('.vibe-ai-agents-chip'));
		DOM.append(projectChip, $('span.codicon.codicon-folder'));
		this.projectNameEl = DOM.append(projectChip, $('span.vibe-ai-agents-project-name'));
		DOM.append(projectChip, $('span.codicon.codicon-chevron-down.vibe-ai-agents-chip-caret'));
		this.paneDisposables.add(DOM.addDisposableListener(projectChip, DOM.EventType.CLICK, () => { this.pickProjectFromRepos(projectChip); }));
		const envChip = DOM.append(chips, $('.vibe-ai-agents-chip.vibe-ai-agents-chip-static'));
		DOM.append(envChip, $('span.codicon.codicon-vm'));
		DOM.append(envChip, $('span')).textContent = localize('vibeAIAgentsHub.thisPC', "This PC");
		const composer = DOM.append(center, $('.vibe-ai-agents-composer'));
		this.composerInput = DOM.append(composer, $('textarea.vibe-ai-agents-composer-input')) as HTMLTextAreaElement;
		this.composerInput.rows = 3;
		this.composerInput.placeholder = localize('vibeAIAgentsHub.composerPlaceholder', "Plan, Build, / for skills, @ for context");
		this.composerInput.setAttribute('aria-label', localize('vibeAIAgentsHub.composerAria', "Start a new agent conversation"));
		this.paneDisposables.add(DOM.addStandardDisposableListener(this.composerInput, DOM.EventType.KEY_DOWN, (e: StandardKeyboardEvent) => {
			// Enter sends; Shift+Enter stays a newline (equals() requires the
			// bare key, so modifier combos fall through to the newline).
			if (e.equals(KeyCode.Enter)) {
				e.preventDefault();
				this.sendComposer();
			}
		}));
		const composerBar = DOM.append(composer, $('.vibe-ai-agents-composer-bar'));
		// Phase 181: "@" file-context attach (Cursor's "+" / @ for context) —
		// picks a file under the active project and appends `@rel/path`.
		const addBtn = DOM.append(composerBar, $('button.codicon.codicon-add.vibe-ai-agents-add')) as HTMLButtonElement;
		addBtn.title = localize('vibeAIAgentsHub.attachContext', "Attach file context (@)");
		addBtn.setAttribute('aria-label', addBtn.title);
		this.paneDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => { this.attachFileContext(); }));
		// Model chip (Cursor parity): dropdown over the configured models,
		// mirrors the chat pane's default via the `vibeAI.chat.model` setting.
		const modelBtn = DOM.append(composerBar, $('button.vibe-ai-agents-model')) as HTMLButtonElement;
		modelBtn.appendChild(document.createTextNode(this.currentModelLabel()));
		DOM.append(modelBtn, $('span.codicon.codicon-chevron-down'));
		this.paneDisposables.add(DOM.addDisposableListener(modelBtn, DOM.EventType.CLICK, () => { this.pickModel(modelBtn); }));
		// Phase 181 r4: the ×N parallel toggle leaves the composer — this
		// slot is Cursor's voice input (Web Speech API, graceful fallback).
		const micBtn = DOM.append(composerBar, $('button.codicon.codicon-mic.vibe-ai-agents-mic')) as HTMLButtonElement;
		micBtn.title = localize('vibeAIAgentsHub.voice', "Voice input");
		micBtn.setAttribute('aria-label', micBtn.title);
		this.paneDisposables.add(DOM.addDisposableListener(micBtn, DOM.EventType.CLICK, () => { this.toggleVoiceInput(micBtn); }));
		const sendBtn = DOM.append(composerBar, $('button.codicon.codicon-arrow-up.vibe-ai-agents-send')) as HTMLButtonElement;
		sendBtn.title = localize('vibeAIAgentsHub.send', "Send (Enter)");
		sendBtn.setAttribute('aria-label', sendBtn.title);
		this.paneDisposables.add(DOM.addDisposableListener(sendBtn, DOM.EventType.CLICK, () => this.sendComposer()));

		// --- background subagents strip (only rendered when non-empty)
		this.backgroundEl = DOM.append(center, $('.vibe-ai-agents-bg'));

		// --- parallel runs section (Phase 179, only rendered when non-empty)
		this.parallelEl = DOM.append(center, $('.vibe-ai-agents-par'));

		// --- live progress: the shared stream carries the session id on
		// every event (Phase 176) — track per-session turns here without
		// touching the chat pane (which keeps routing by requestId).
		this.paneDisposables.add(this.vibeAIService.onStreamData(data => this.handleStreamData(data)));

		// --- background agents + parallel runs refresh while the hub is open
		const bgTimer = window.setInterval(() => {
			this.fetchBackgroundAgents();
			this.fetchParallelRuns();
		}, BG_POLL_MS);
		this.paneDisposables.add(toDisposable(() => window.clearInterval(bgTimer)));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		super.setInput(input, options, context, token);
		this.consumeSessionHandoff();
		this.fetchBackgroundAgents();
		this.fetchParallelRuns();
		this.render();
		this.composerInput?.focus();
	}

	override clearInput(): void {
		super.clearInput();
		if (this.sessionsEl) {
			this.sessionsEl.innerText = '';
		}
		if (this.backgroundEl) {
			this.backgroundEl.innerText = '';
		}
		if (this.parallelEl) {
			this.parallelEl.innerText = '';
		}
	}

	override focus(): void {
		this.composerInput?.focus();
	}

	override layout(_dimension: DOM.Dimension): void {
		// The flex layout fills the editor area — no manual sizing needed.
	}

	// ==================== actions ====================

	/**
	 * Sends from the hub composer. With the parallel chip off the text
	 * hands off to the chat pane as usual; with ×2-×4 it starts a parallel
	 * run right here (same prompt, N isolated git worktrees — pick the
	 * best result below, Cursor multi-agent parity).
	 */
	private sendComposer(): void {
		const text = this.composerInput?.value.trim() ?? '';
		if (!text) {
			return;
		}
		if (this.composerInput) {
			this.composerInput.value = '';
		}
		// Phase 180: the agent window has no chat view — a normal
		// conversation starts in a real IDE window on this project
		// (one-shot handoff; the IDE seeds the composer text there).
		if (this.isAgentWindow) {
			// Phase 181 r8: an expanded thread continues in the IDE with the
			// composer text; a fresh send still seeds a new conversation.
			const selected = this.selectedSessionId
				? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
				: undefined;
			if (selected) {
				this.handOffSessionToIde(selected, text);
			} else {
				this.startConversationInIde(text);
			}
			return;
		}
		this.openChat(pane => pane.sendFromHub(text, this.resolveProjectRoot()));
	}

	/** Focuses the chat view and runs the handoff on its pane instance. */
	private openChat(withPane: (pane: VibeAIChatPane) => void): void {
		this.viewsService.openView(VibeAIChatPane.ID, true).then(view => {
			if (view) {
				withPane(view as VibeAIChatPane);
			}
		});
	}

	/**
	 * Sidebar action row builder (icon + label, whole row clickable).
	 * The label arrives already localized — nls extraction needs literal
	 * localize() keys, so the helper must not localize dynamically.
	 */
	private appendActionRow(parent: HTMLElement, label: string, icon: ThemeIcon, onClick: () => void): HTMLElement {
		const row = DOM.append(parent, $('.vibe-ai-agents-row'));
		DOM.append(row, $('span' + ThemeIcon.asCSSSelector(icon)));
		DOM.append(row, $('span.vibe-ai-agents-row-label')).textContent = label;
		this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
			if (!row.classList.contains('disabled')) {
				onClick();
			}
		}));
		return row;
	}

	// ==================== live stream tracking ====================

	/**
	 * Tracks per-session turn progress. Only state-changing events
	 * re-render (text/thinking deltas just refresh the timestamp — the
	 * full event rate is far too high for a list rebuild). Parallel-run
	 * events (Phase 179) carry no session id — they route by their
	 * `parallel` stamp BEFORE the session guard.
	 */
	private handleStreamData(data: IVibeAIStreamData): void {
		if (data.parallel) {
			this.handleParallelData(data);
			return;
		}
		// The hub's own parallel requests fire local error/done events
		// (no sessionId, no parallel meta) — map them back to their
		// pending placeholder via the requestId.
		const pendingRunKey = data.requestId ? this.parallelRequestToRun.get(data.requestId) : undefined;
		if (pendingRunKey !== undefined) {
			this.handleParallelRequestEvent(pendingRunKey, data, data.requestId!);
			return;
		}
		if (!data.sessionId) {
			return;
		}
		const current = liveTurns.get(data.sessionId) ?? { state: '', lastEventAt: 0 };
		switch (data.type) {
			case 'turn_state': {
				const state = data.turnState ?? '';
				if (TERMINAL_TURN_STATES.has(state)) {
					liveTurns.delete(data.sessionId);
					this.render();
					return;
				}
				current.state = state;
				break;
			}
			case 'done':
				// Every stream (chat / agent / plan / execute) fires exactly
				// one done — the authoritative turn end for the hub.
				liveTurns.delete(data.sessionId);
				this.render();
				return;
			case 'tool_start':
			case 'tool_result':
				if (!current.state || current.state === 'thinking') {
					current.state = 'executing_tools';
				}
				break;
			case 'text':
			case 'thinking':
			case 'file_delta':
				// High-frequency noise: timestamp only (visible on next rebuild).
				break;
			default:
				if (!current.state) {
					current.state = 'executing_tools';
				}
				break;
		}
		current.lastEventAt = Date.now();
		liveTurns.set(data.sessionId, current);
		// Low-frequency events repaint; deltas wait for one.
		if (data.type === 'turn_state' || data.type === 'tool_start' || data.type === 'tool_result') {
			this.render();
		}
	}

	// ==================== parallel runs (Phase 179) ====================

	/**
	 * Live parallel-run progress from the shared stream. Every event of a
	 * parallel stream carries the `parallel` stamp; only the lifecycle
	 * events re-render (variant pass-through deltas are noise, same
	 * policy as session turns).
	 */
	private handleParallelData(data: IVibeAIStreamData): void {
		const meta = data.parallel!;
		if (!meta.runId) {
			return;
		}
		let run = this.parallelLive.get(meta.runId);
		if (!run && data.type === 'parallel_agent_start') {
			// First start event for an unknown run: adopt the hub's own
			// pending placeholder (keyed `pending-<requestId>` — match it
			// by variant count + model label + shared prompt so two
			// concurrent sends can't cross-adopt), else seed bare (a run
			// started in another window).
			const pending = [...this.parallelLive.entries()].find(([key, candidate]) =>
				key.startsWith('pending-')
				&& candidate.variants.length === meta.total
				&& (candidate.variants[meta.index]?.model ?? '') === (meta.model ?? '')
				&& (meta.prompt === undefined || candidate.prompt === meta.prompt)
			);
			if (pending) {
				this.parallelLive.delete(pending[0]);
				run = { ...pending[1], runId: meta.runId };
				if (data.requestId && this.parallelRequestToRun.get(data.requestId)?.startsWith('pending-')) {
					this.parallelRequestToRun.set(data.requestId, meta.runId);
				}
			} else {
				run = {
					runId: meta.runId,
					prompt: meta.prompt ?? '',
					createdAt: Date.now(),
					variants: Array.from({ length: Math.max(meta.total, 1) }, (_, index) => ({ index, status: 'running' })),
				};
			}
			this.parallelLive.set(meta.runId, run);
		}
		if (!run) {
			return;
		}
		const variants = run.variants;
		switch (data.type) {
			case 'parallel_agent_start': {
				variants[meta.index] = {
					...variants[meta.index] ?? { index: meta.index, status: 'running' },
					status: 'running',
					model: meta.model ?? variants[meta.index]?.model,
				};
				break;
			}
			case 'parallel_agent_done': {
				variants[meta.index] = {
					...variants[meta.index] ?? { index: meta.index, status: meta.status ?? 'done' },
					status: meta.status ?? 'done',
					model: meta.model ?? variants[meta.index]?.model,
					summary: meta.summary ?? variants[meta.index]?.summary,
					error: meta.error ?? variants[meta.index]?.error,
					changedFiles: meta.changedFiles ?? variants[meta.index]?.changedFiles,
					diffStat: meta.diffStat ?? variants[meta.index]?.diffStat,
					committed: meta.committed ?? variants[meta.index]?.committed,
				};
				break;
			}
			case 'parallel_done':
				// The authoritative registry snapshot (every variant settled).
				if (meta.runs) {
					this.parallelLive.set(meta.runs.runId, meta.runs);
				}
				break;
			default:
				// Pass-through variant event (thinking / tool / text): live
				// progress only, no re-render.
				return;
		}
		this.renderParallel();
		if (data.type !== 'parallel_agent_start') {
			this.fetchParallelRuns();
		}
	}

	/**
	 * Local stream events for one of the hub's own parallel requests
	 * (fired by the node service without parallel meta): an error marks
	 * the still-running variants failed (e.g. the backend's 400 detail),
	 * a done without any backend snapshot drops a never-adopted
	 * placeholder (the request never reached the backend).
	 */
	private handleParallelRequestEvent(runKey: string, data: IVibeAIStreamData, requestId: string): void {
		const run = this.parallelLive.get(runKey);
		if (data.type === 'error' && run) {
			const failed = run.variants.map(variant => variant.status === 'running'
				? { ...variant, status: 'error', error: data.message ?? 'parallel request failed' }
				: variant);
			run.variants.splice(0, run.variants.length, ...failed);
			this.renderParallel();
			return;
		}
		if (data.type === 'done') {
			this.parallelRequestToRun.delete(requestId);
			if (run && run.variants.every(variant => variant.status === 'running')) {
				this.parallelLive.delete(runKey);
				this.renderParallel();
			}
		}
	}

	// ==================== rendering ====================

	private render(): void {
		this.renderProject();
		this.renderRepos();
		this.renderSessions();
		this.renderBackground();
		this.renderParallel();
		this.renderConversation();
	}

	/**
	 * Sidebar thread list — every stored session under the workspace
	 * (Cursor's per-repo recent threads). Live ones show a spinner + turn
	 * state in place of the timestamp. Hover ✕ deletes.
	 */
	private renderSessions(): void {
		if (!this.sessionsEl) {
			return;
		}
		this.sessionsEl.innerText = '';

		const sessions = this.sessionStore.list();
		if (sessions.length === 0) {
			DOM.append(this.sessionsEl, $('.vibe-ai-agents-empty')).textContent = localize('vibeAIAgentsHub.noSessions', "No conversations yet — say something in the chat or start one above.");
			return;
		}
		// Pinned first (Phase 49 parity), then most recently updated.
		const sorted = [...sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
		// Phase 181 r2: the rail search box filters threads by title.
		const filtered = this.sidebarFilter
			? sorted.filter(s => s.title.toLowerCase().includes(this.sidebarFilter))
			: sorted;
		for (const session of filtered.slice(0, SESSIONS_MAX)) {
			const live = liveTurns.get(session.id);
			const row = DOM.append(this.sessionsEl, $('.vibe-ai-agents-thread'));
			if (live) {
				row.classList.add('live');
			}
			if (session.id === this.handoffSessionId) {
				row.classList.add('handoff');
			}
			// Phase 181 r8: the thread expanded in the center is highlighted.
			if (session.id === this.selectedSessionId) {
				row.classList.add('active');
			}
			if (session.pinned) {
				DOM.append(row, $('span.codicon.codicon-pinned.vibe-ai-agents-pin'));
			}
			DOM.append(row, $('.vibe-ai-agents-thread-title')).textContent = session.title;
			const meta = DOM.append(row, $('.vibe-ai-agents-thread-meta'));
			if (live) {
				DOM.append(meta, $('span.codicon.codicon-loading.vibe-ai-agents-spin'));
				DOM.append(meta, $('span')).textContent = LIVE_STATE_LABELS[live.state] ?? LIVE_STATE_LABELS.executing_tools;
			} else {
				meta.textContent = this.relativeTime(session.updatedAt);
			}
			// Agent window: threads may belong to other projects — badge the
			// project name when it differs from this window's resolution.
			const projectLabel = this.sessionProjectLabel(session);
			if (projectLabel) {
				DOM.append(meta, $('span.vibe-ai-agents-thread-project')).textContent = projectLabel;
			}
			const del = DOM.append(row, $('button.codicon.codicon-trash.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
			del.title = localize('vibeAIAgentsHub.delete', "Delete conversation");
			del.setAttribute('aria-label', del.title);
			this.paneDisposables.add(DOM.addDisposableListener(del, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.sessionStore.delete(session.id);
				this.render();
			}));
			this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				// Re-read from the store: the row may be stale (new turns
				// finished since the sidebar rendered).
				const fresh = this.sessionStore.list().find(s => s.id === session.id) ?? session;
				// Remember the thread's project: New Chat after opening a
				// thread should land in the same project (agent window).
				if (fresh.workspaceRoot) {
					this.lastOpenedProjectRoot = fresh.workspaceRoot;
					this.renderProject();
				}
				// Phase 180 (session roaming): the agent window has no chat
				// view — opening a thread hands it to a real IDE window on
				// the thread's project, which picks it up on restore.
				// Phase 181 r8 (user: 點線程是在中間展開對話): the agent
				// window expands the conversation in the center canvas;
				// "Open in IDE" on the transcript hands it to a real IDE
				// window (Phase 180 behavior stays one click away).
				this.handoffSessionId = undefined;
				if (this.isAgentWindow) {
					this.selectedSessionId = fresh.id;
					this.renderConversation();
					this.renderSessions();
					return;
				}
				this.openChat(pane => pane.loadSession(fresh));
			}));
		}
	}

	/**
	 * Phase 181 r8: the center canvas transcript for the expanded thread —
	 * the conversation renders above the composer (Cursor agent-window
	 * parity). "Open in IDE" hands the thread to a real IDE window; ✕
	 * collapses back to the fresh composer.
	 */
	private renderConversation(): void {
		if (!this.chatEl) {
			return;
		}
		this.chatEl.innerText = '';
		const session = this.selectedSessionId
			? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
			: undefined;
		if (!session) {
			this.selectedSessionId = undefined;
			this.chatEl.style.display = 'none';
			return;
		}
		this.chatEl.style.display = '';
		const head = DOM.append(this.chatEl, $('.vibe-ai-agents-chat-head'));
		DOM.append(head, $('span.vibe-ai-agents-chat-title')).textContent = session.title || localize('vibeAIAgentsHub.chatUntitled', "New conversation");
		const openIde = DOM.append(head, $('button.codicon.codicon-link-external.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		openIde.title = localize('vibeAIAgentsHub.chatOpenIde', "Continue this conversation in the IDE");
		openIde.setAttribute('aria-label', openIde.title);
		const fresh = session;
		this.paneDisposables.add(DOM.addDisposableListener(openIde, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.handOffSessionToIde(fresh);
		}));
		const close = DOM.append(head, $('button.codicon.codicon-close.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		close.title = localize('vibeAIAgentsHub.chatClose', "Collapse conversation");
		close.setAttribute('aria-label', close.title);
		this.paneDisposables.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.selectedSessionId = undefined;
			this.renderConversation();
			this.renderSessions();
		}));
		const body = DOM.append(this.chatEl, $('.vibe-ai-agents-chat-body'));
		const clipText = (value: string): string => value.length > 20000 ? `${value.substring(0, 20000)}…` : value;
		for (const message of session.messages) {
			// Phase 181 r9 (user: 抄 Cursor 的對話後樣子): user turns render
			// as a plain full-width card; agent turns as document-style
			// markdown (no bubble) with a copy affordance — Cursor's thread
			// view, not a chat bubble list.
			if (message.role === 'user') {
				const row = DOM.append(body, $('.vibe-ai-agents-chat-msg.user'));
				DOM.append(row, $('span.vibe-ai-agents-chat-role')).textContent = localize('vibeAIAgentsHub.chatYou', "You");
				DOM.append(row, $('div.vibe-ai-agents-chat-text')).textContent = clipText(message.content);
				continue;
			}
			const row = DOM.append(body, $('.vibe-ai-agents-chat-msg.assistant'));
			const meta = DOM.append(row, $('.vibe-ai-agents-chat-meta'));
			DOM.append(meta, $('span.vibe-ai-agents-chat-role')).textContent = localize('vibeAIAgentsHub.chatAgent', "Agent");
			const copy = DOM.append(meta, $('button.codicon.codicon-copy.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
			copy.title = localize('vibeAIAgentsHub.chatCopy', "Copy");
			copy.setAttribute('aria-label', copy.title);
			this.paneDisposables.add(DOM.addDisposableListener(copy, DOM.EventType.CLICK, () => {
				navigator.clipboard?.writeText(message.content);
				copy.classList.add('done');
			}));
			const textEl = DOM.append(row, $('div.vibe-ai-agents-chat-text'));
			try {
				this.markdownRendererService.render(
					new MarkdownString(clipText(message.content), { isTrusted: true, supportThemeIcons: true, supportHtml: true }),
					{ fillInIncompleteTokens: false, codeBlockHeader: true },
					textEl,
				);
			} catch {
				textEl.textContent = message.content;
			}
		}
		body.scrollTop = body.scrollHeight;
	}

	/** Background subagents strip under the composer (hidden when none). */
	private renderBackground(): void {
		if (!this.backgroundEl) {
			return;
		}
		this.backgroundEl.innerText = '';
		if (this.backgroundAgents !== undefined && this.backgroundAgents.length === 0) {
			return;
		}
		if (this.backgroundAgents === undefined) {
			// First render: fetch, then repaint.
			this.fetchBackgroundAgents();
			return;
		}
		DOM.append(this.backgroundEl, $('.vibe-ai-agents-bg-title')).textContent = localize('vibeAIAgentsHub.background', "Background agents");
		for (const agent of this.backgroundAgents) {
			const card = DOM.append(this.backgroundEl, $('.vibe-ai-agents-bg-card'));
			const titleRow = DOM.append(card, $('.vibe-ai-agents-bg-card-title'));
			if (agent.status === 'running') {
				DOM.append(titleRow, $('span.codicon.codicon-loading.vibe-ai-agents-spin'));
			} else if (agent.status === 'done') {
				DOM.append(titleRow, $('span.codicon.codicon-check.vibe-ai-agents-ok'));
			} else {
				DOM.append(titleRow, $('span.codicon.codicon-error.vibe-ai-agents-fail'));
			}
			DOM.append(titleRow, $('span.vibe-ai-agents-bg-name')).textContent = agent.name;
			const badge = DOM.append(titleRow, $('span.vibe-ai-agents-bg-badge.' + agent.status));
			badge.textContent = agent.status;

			const summary = agent.error || agent.summary || agent.title || '';
			DOM.append(card, $('.vibe-ai-agents-bg-desc')).textContent = summary.length > BG_SUMMARY_MAX_CHARS
				? `${summary.substring(0, BG_SUMMARY_MAX_CHARS)}…`
				: summary;
		}
	}

	/** Fetches the registry snapshot, then repaints only the strip. */
	private fetchBackgroundAgents(): void {
		this.vibeAIService.listBackgroundAgents().then(agents => {
			this.backgroundAgents = agents;
			this.renderBackground();
		}).catch(() => {
			this.backgroundAgents = [];
			this.renderBackground();
		});
	}

	// ==================== parallel runs rendering (Phase 179) ====================

	/**
	 * Parallel runs section under the composer — the registry snapshot
	 * (polled) overlaid by live stream state; a terminal registry entry
	 * supersedes its live copy. Hidden entirely when there is nothing.
	 */
	private renderParallel(): void {
		if (!this.parallelEl) {
			return;
		}
		this.parallelEl.innerText = '';
		const merged = new Map<string, IVibeAIParallelRun>();
		for (const run of this.parallelRuns ?? []) {
			merged.set(run.runId, run);
		}
		for (const [key, run] of this.parallelLive) {
			merged.set(key, run);
		}
		const runs = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, PARALLEL_RUNS_MAX);
		if (runs.length === 0) {
			return;
		}
		DOM.append(this.parallelEl, $('.vibe-ai-agents-par-title')).textContent = localize('vibeAIAgentsHub.parallelRuns', "Parallel runs");
		for (const run of runs) {
			this.renderParallelRun(run);
		}
	}

	/** One parallel run card: prompt header + one row per worktree variant. */
	private renderParallelRun(run: IVibeAIParallelRun): void {
		if (!this.parallelEl) {
			return;
		}
		const card = DOM.append(this.parallelEl, $('.vibe-ai-agents-par-card'));
		const head = DOM.append(card, $('.vibe-ai-agents-par-head'));
		DOM.append(head, $('span.codicon.codicon-git-branch'));
		const prompt = run.prompt.length > PARALLEL_TEXT_MAX_CHARS
			? `${run.prompt.substring(0, PARALLEL_TEXT_MAX_CHARS)}…`
			: run.prompt;
		DOM.append(head, $('span.vibe-ai-agents-par-prompt')).textContent = prompt || localize('vibeAIAgentsHub.parallelUntitled', "Parallel run");
		const busy = run.variants.some(variant => variant.status === 'running');
		if (busy) {
			DOM.append(head, $('span.codicon.codicon-loading.vibe-ai-agents-spin'));
		} else if (run.variants.some(variant => variant.status === 'done' || variant.status === 'error')) {
			const drop = DOM.append(head, $('button.codicon.codicon-trash.vibe-ai-agents-par-btn')) as HTMLButtonElement;
			drop.title = localize('vibeAIAgentsHub.parallelDiscardRun', "Discard the whole run");
			drop.setAttribute('aria-label', drop.title);
			this.paneDisposables.add(DOM.addDisposableListener(drop, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.discardParallel(run.runId, undefined);
			}));
		}
		for (const variant of run.variants) {
			const row = DOM.append(card, $('.vibe-ai-agents-par-variant'));
			switch (variant.status) {
				case 'running':
					DOM.append(row, $('span.codicon.codicon-loading.vibe-ai-agents-spin'));
					break;
				case 'done':
					DOM.append(row, $('span.codicon.codicon-check.vibe-ai-agents-ok'));
					break;
				case 'merged':
					DOM.append(row, $('span.codicon.codicon-git-merge.vibe-ai-agents-ok'));
					break;
				case 'error':
					DOM.append(row, $('span.codicon.codicon-error.vibe-ai-agents-fail'));
					break;
				default:
					DOM.append(row, $('span.codicon.codicon-circle-slash'));
			}
			DOM.append(row, $('span.vibe-ai-agents-par-model')).textContent = `w${variant.index} · ${variant.model ?? variant.status}`;
			const changes = variant.changedFiles?.length ?? 0;
			const detail = [
				variant.error ?? variant.summary ?? '',
				changes > 0 ? `${changes} files · ${variant.diffStat ?? ''}` : '',
			].filter(part => part.length > 0).join(' — ');
			DOM.append(row, $('span.vibe-ai-agents-par-desc')).textContent = detail.length > PARALLEL_TEXT_MAX_CHARS
				? `${detail.substring(0, PARALLEL_TEXT_MAX_CHARS)}…`
				: detail;
			if (variant.summary || variant.error) {
				row.title = variant.error ?? variant.summary ?? '';
			}
			if (variant.status === 'done') {
				const mergeBtn = DOM.append(row, $('button.codicon.codicon-git-merge.vibe-ai-agents-par-btn.vibe-ai-agents-par-merge')) as HTMLButtonElement;
				mergeBtn.title = localize('vibeAIAgentsHub.parallelMerge', "Merge this variant into the workspace");
				mergeBtn.setAttribute('aria-label', mergeBtn.title);
				this.paneDisposables.add(DOM.addDisposableListener(mergeBtn, DOM.EventType.CLICK, e => {
					DOM.EventHelper.stop(e, true);
					this.mergeParallel(run.runId, variant.index);
				}));
			}
			if (variant.status === 'done' || variant.status === 'error') {
				const drop = DOM.append(row, $('button.codicon.codicon-trash.vibe-ai-agents-par-btn')) as HTMLButtonElement;
				drop.title = localize('vibeAIAgentsHub.parallelDiscard', "Discard this variant");
				drop.setAttribute('aria-label', drop.title);
				this.paneDisposables.add(DOM.addDisposableListener(drop, DOM.EventType.CLICK, e => {
					DOM.EventHelper.stop(e, true);
					this.discardParallel(run.runId, variant.index);
				}));
			}
		}
	}

	/** Fetches the parallel-run registry snapshot, then repaints the section. */
	private fetchParallelRuns(): void {
		this.vibeAIService.listParallelRuns(this.resolveProjectRoot()).then(runs => {
			this.parallelRuns = runs;
			// Terminal registry entries supersede their live copies.
			for (const run of runs) {
				if (run.variants.every(variant => variant.status !== 'running')) {
					this.parallelLive.delete(run.runId);
				}
			}
			this.renderParallel();
		}).catch(() => {
			this.parallelRuns = this.parallelRuns ?? [];
			this.renderParallel();
		});
	}

	/** Merge one variant (the picked result) into the main workspace. */
	private mergeParallel(runId: string, index: number): void {
		this.vibeAIService.mergeParallelRun(this.resolveProjectRoot(), runId, index).then(result => {
			if (result.ok) {
				this.notificationService.info(localize('vibeAIAgentsHub.parallelMerged', "Variant w{0} merged into the workspace.", index));
			} else {
				this.notificationService.warn(result.error ?? localize('vibeAIAgentsHub.parallelMergeFailed', "Merging the variant failed"));
			}
			this.fetchParallelRuns();
		}).catch(error => {
			this.notificationService.error(localize('vibeAIAgentsHub.parallelMergeError', "Merging the variant failed: {0}", String(error)));
		});
	}

	/** Discard one variant (or, without index, the whole run). */
	private discardParallel(runId: string, index: number | undefined): void {
		this.vibeAIService.discardParallelRun(this.resolveProjectRoot(), runId, index).then(result => {
			if (!result.ok) {
				this.notificationService.warn(result.error ?? localize('vibeAIAgentsHub.parallelDiscardFailed', "Discarding the variant failed"));
			}
			this.parallelLive.delete(runId);
			this.fetchParallelRuns();
		}).catch(error => {
			this.notificationService.error(localize('vibeAIAgentsHub.parallelDiscardError', "Discarding the variant failed: {0}", String(error)));
		});
	}

	// ==================== voice input (Phase 181 r4) ====================

	private voiceRecognition: { stop: () => void } | undefined;

	/** Composer mic: Web Speech API dictation into the prompt textarea. */
	private toggleVoiceInput(micBtn: HTMLButtonElement): void {
		const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => unknown; SpeechRecognition?: new () => unknown }).webkitSpeechRecognition
			?? (window as unknown as { SpeechRecognition?: new () => unknown }).SpeechRecognition;
		if (!Ctor) {
			this.notificationService.warn(localize('vibeAIAgentsHub.voiceUnavailable', "Voice input isn't available in this environment"));
			return;
		}
		if (this.voiceRecognition) {
			this.voiceRecognition.stop();
			return;
		}
		const rec = new (Ctor as new () => {
			lang: string; continuous: boolean; interimResults: boolean;
			onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null;
			onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void;
		})();
		rec.lang = navigator.language || 'zh-TW';
		rec.continuous = true;
		rec.interimResults = false;
		rec.onresult = e => {
			let text = '';
			for (let i = e.resultIndex; i < e.results.length; i++) {
				if (e.results[i].isFinal) {
					text += e.results[i][0].transcript;
				}
			}
			if (text && this.composerInput) {
				const current = this.composerInput.value;
				this.composerInput.value = current && !current.endsWith(' ') ? `${current} ${text.trim()}` : current + text.trim();
				this.composerInput.focus();
			}
		};
		const stop = () => {
			this.voiceRecognition = undefined;
			micBtn.classList.remove('active');
		};
		rec.onerror = stop;
		rec.onend = stop;
		try {
			rec.start();
			this.voiceRecognition = rec;
			micBtn.classList.add('active');
		} catch {
			this.notificationService.warn(localize('vibeAIAgentsHub.voiceUnavailable', "Voice input isn't available in this environment"));
		}
	}

	// ==================== session roaming (Phase 180) ====================

	/**
	 * An IDE window handed a thread over (`vibeAI.agentHandoff`): highlight
	 * it in the sidebar. `newMessage` handoffs are left untouched — those
	 * are for IDE windows to seed a fresh conversation with.
	 */
	private consumeSessionHandoff(): void {
		const handoff = parseVibeAIChatHandoff(this.storageService.get(VIBE_AI_HANDOFF_STORAGE_KEY, StorageScope.APPLICATION));
		if (!handoff?.sessionId || Date.now() - handoff.ts > VIBE_AI_HANDOFF_MAX_AGE_MS) {
			return;
		}
		const session = this.sessionStore.list().find(candidate => candidate.id === handoff.sessionId);
		if (!session) {
			return;
		}
		this.storageService.remove(VIBE_AI_HANDOFF_STORAGE_KEY, StorageScope.APPLICATION);
		this.handoffSessionId = session.id;
		if (session.workspaceRoot) {
			this.lastOpenedProjectRoot = session.workspaceRoot;
		}
	}

	/**
	 * Hands a thread to a real IDE window on the thread's project: stamp
	 * the one-shot handoff, then "IDE ↗" (the receiving window's pickup
	 * contribution opens the chat view with the thread on restore).
	 */
	private handOffSessionToIde(session: IVibeAIChatSession, newMessage?: string): void {
		const handoff: IVibeAIChatHandoff = {
			sessionId: session.id,
			newMessage,
			workspaceRoot: session.workspaceRoot,
			ts: Date.now(),
		};
		this.storageService.store(VIBE_AI_HANDOFF_STORAGE_KEY, JSON.stringify(handoff), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.commandService.executeCommand('vibeAI.agentWindow.openIde', session.workspaceRoot ? URI.file(session.workspaceRoot) : undefined);
	}

	/**
	 * The agent window composer with the parallel chip off: seeds a fresh
	 * conversation in a real IDE window — one-shot handoff carries the
	 * text, the receiving window opens the chat view and sends it there.
	 */
	private startConversationInIde(text: string): void {
		const root = this.resolveProjectRoot();
		const handoff: IVibeAIChatHandoff = {
			newMessage: text,
			workspaceRoot: root,
			ts: Date.now(),
		};
		this.storageService.store(VIBE_AI_HANDOFF_STORAGE_KEY, JSON.stringify(handoff), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.commandService.executeCommand('vibeAI.agentWindow.openIde', root ? URI.file(root) : undefined);
	}

	// ==================== helpers ====================

	// ==================== agent window project (Phase 177) ====================

	/**
	 * The project this hub instance works against. In IDE windows this is
	 * undefined — every consumer falls back to the window workspace, exactly
	 * like before. In the standalone agent window the workspace is neutral
	 * on purpose (opening the real folder here would share workspace storage
	 * with the IDE window), so the project is recovered in order: the last
	 * thread the user opened, the most recent thread that carries a project,
	 * the folder queued by the title-bar pill when launching this window,
	 * and finally the window folder itself (empty workspace fallback).
	 */
	private resolveProjectRoot(): string | undefined {
		if (!this.isAgentWindow) {
			return undefined;
		}
		if (this.lastOpenedProjectRoot) {
			return this.lastOpenedProjectRoot;
		}
		const recent = this.sessionStore.list().find(s => !!s.workspaceRoot);
		if (recent?.workspaceRoot) {
			return recent.workspaceRoot;
		}
		const queued = this.storageService.get(AGENT_WINDOW_PROJECT_STORAGE_KEY, StorageScope.APPLICATION);
		if (queued) {
			return queued;
		}
		return this.contextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	/** "IDE ↗": opens the resolved project in a normal IDE window. */
	private openInIde(): void {
		const root = this.resolveProjectRoot();
		this.commandService.executeCommand('vibeAI.agentWindow.openIde', root ? URI.file(root) : undefined);
	}

	/** Repaints the composer's project chip (the active project target). */
	private renderProject(): void {
		// IDE windows keep showing the window folder; only the agent window
		// resolves its project through navigation/storage.
		const root = this.isAgentWindow
			? this.resolveProjectRoot()
			: this.contextService.getWorkspace().folders[0]?.uri.fsPath;
		const name = root
			? basename(URI.file(root))
			: localize('vibeAIAgentsHub.noFolder', "No folder opened");
		if (this.projectNameEl) {
			this.projectNameEl.textContent = name;
			this.projectNameEl.title = root ?? '';
		}
	}

	// ==================== projects & context (Phase 181) ====================

	/** Distinct project roots: active one first, then stored sessions. */
	private knownProjectRoots(): string[] {
		const seen = new Set<string>();
		const roots: string[] = [];
		const push = (root?: string) => {
			if (!root) {
				return;
			}
			const key = root.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				roots.push(root);
			}
		};
		push(this.resolveProjectRoot());
		for (const session of this.sessionStore.list()) {
			push(session.workspaceRoot);
		}
		return roots;
	}

	/** Repaints the Repositories list (Cursor's per-repo sidebar rows). */
	private renderRepos(): void {
		if (!this.repoListEl) {
			return;
		}
		this.repoListEl.innerText = '';
		const active = this.resolveProjectRoot()?.toLowerCase();
		for (const root of this.knownProjectRoots()) {
			const row = DOM.append(this.repoListEl, $('.vibe-ai-agents-repo'));
			if (active && root.toLowerCase() === active) {
				row.classList.add('active');
			}
			row.title = root;
			DOM.append(row, $('span.codicon.codicon-folder'));
			DOM.append(row, $('.vibe-ai-agents-repo-name')).textContent = basename(URI.file(root));
			this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				this.lastOpenedProjectRoot = root;
				this.render();
				this.composerInput?.focus();
			}));
		}
	}

	/** "+ New Project": pick a folder and make it the composer's target. */
	private async pickProject(): Promise<void> {
		const result = await this.fileDialogService.showOpenDialog({
			title: localize('vibeAIAgentsHub.pickProject', "Open a project folder"),
			openLabel: localize('vibeAIAgentsHub.pickProjectOpen', "Set as Project"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
		});
		const folder = result?.[0];
		if (!folder) {
			return;
		}
		this.lastOpenedProjectRoot = folder.fsPath;
		this.render();
	}

	// ==================== anchored dropdown menus (Phase 181 r3) ============

	/**
	 * Cursor-style dropdown anchored below the clicked chip (not a global
	 * quick pick): position near the anchor, dismiss on outside click or
	 * Escape. `render` fills the menu; call `close()` on selection.
	 */
	private openDropdownMenu(anchor: HTMLElement, render: (menu: HTMLElement, close: () => void) => void): void {
		if (!this.root) {
			return;
		}
		this.closeDropdownMenu();
		this.menuDisposables = new DisposableStore();
		const menu = document.createElement('div');
		menu.className = 'vibe-ai-agents-menu';
		const close = () => {
			menu.remove();
			this.menuDisposables?.dispose();
			this.menuDisposables = undefined;
		};
		render(menu, close);
		this.root.appendChild(menu);
		const rootRect = this.root.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		menu.style.visibility = 'hidden';
		const menuRect = menu.getBoundingClientRect();
		let left = anchorRect.left - rootRect.left;
		if (left + menuRect.width > rootRect.width - 8) {
			left = Math.max(8, rootRect.width - menuRect.width - 8);
		}
		let top = anchorRect.bottom - rootRect.top + 4;
		if (top + menuRect.height > rootRect.height - 8) {
			top = Math.max(8, anchorRect.top - rootRect.top - menuRect.height - 4);
		}
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
		menu.style.visibility = 'visible';
		this.menuDisposables.add(DOM.addDisposableListener(this.root, DOM.EventType.MOUSE_DOWN, e => {
			if (!menu.contains(e.target as Node)) {
				close();
			}
		}, true));
		this.menuDisposables.add(DOM.addDisposableListener(menu, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				close();
			}
		}));
	}

	private closeDropdownMenu(): void {
		this.menuDisposables?.dispose();
		this.menuDisposables = undefined;
		for (const stale of document.querySelectorAll('.vibe-ai-agents-menu')) {
			stale.remove();
		}
	}

	/** Composer project chip: Cursor-style anchored repo dropdown. */
	private pickProjectFromRepos(anchor?: HTMLElement): void {
		const at = anchor ?? this.projectNameEl?.parentElement ?? this.root ?? document.body;
		this.openDropdownMenu(at, (menu, close) => {
			const search = DOM.append(menu, $('input.vibe-ai-agents-menu-search')) as HTMLInputElement;
			search.type = 'text';
			search.placeholder = localize('vibeAIAgentsHub.menuSearch', "Search repos...");
			const list = DOM.append(menu, $('.vibe-ai-agents-menu-list'));
			const active = this.resolveProjectRoot()?.toLowerCase();
			const rows: HTMLElement[] = [];
			const addRow = (label: string, icon: string, onPick: () => void, checked = false) => {
				const row = DOM.append(list, $('.vibe-ai-agents-menu-row'));
				row.dataset.name = label.toLowerCase();
				DOM.append(row, $(`span.codicon.codicon-${icon}`));
				DOM.append(row, $('span')).textContent = label;
				if (checked) {
					DOM.append(row, $('span.codicon.codicon-check'));
				}
				this.menuDisposables?.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
					close();
					onPick();
				}));
				rows.push(row);
			};
			DOM.append(list, $('.vibe-ai-agents-menu-label')).textContent = localize('vibeAIAgentsHub.recents', "Recents");
			for (const root of this.knownProjectRoots()) {
				addRow(basename(URI.file(root)), 'folder', () => {
					this.lastOpenedProjectRoot = root;
					this.render();
				}, active === root.toLowerCase());
			}
			DOM.append(list, $('.vibe-ai-agents-menu-sep'));
			DOM.append(list, $('.vibe-ai-agents-menu-label')).textContent = localize('vibeAIAgentsHub.workspaces', "Workspaces");
			addRow(localize('vibeAIAgentsHub.newProject', "New Project…"), 'new-folder', () => { this.pickProject(); });
			this.menuDisposables?.add(DOM.addStandardDisposableListener(search, DOM.EventType.INPUT, () => {
				const q = search.value.toLowerCase();
				for (const row of rows) {
					row.style.display = !q || (row.dataset.name ?? '').includes(q) ? 'flex' : 'none';
				}
			}));
			search.focus();
		});
	}

	/** Model chip dropdown — writes the shared `vibeAI.chat.model` default. */
	private pickModel(modelBtn: HTMLButtonElement): void {
		this.openDropdownMenu(modelBtn, (menu, close) => {
			const list = DOM.append(menu, $('.vibe-ai-agents-menu-list'));
			const current = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
			const addRow = (label: string, id: string) => {
				const row = DOM.append(list, $('.vibe-ai-agents-menu-row'));
				DOM.append(row, $('span')).textContent = label;
				if (current === id) {
					DOM.append(row, $('span.codicon.codicon-check'));
				}
				this.menuDisposables?.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
					this.configurationService.updateValue('vibeAI.chat.model', id);
					modelBtn.innerText = '';
					modelBtn.appendChild(document.createTextNode(this.currentModelLabel()));
					DOM.append(modelBtn, $('span.codicon.codicon-chevron-down'));
					close();
				}));
			};
			addRow(localize('vibeAIAgentsHub.modelAuto', "Auto"), 'Auto');
			for (const model of this.modelStore.list()) {
				addRow(model.name.split('/').pop() || model.name, model.id);
			}
		});
	}

	/**
	 * Composer "+" (Cursor's @ for context): quick-pick a file under the
	 * active project (top level + one folder level, capped) and append
	 * `@rel/path` to the prompt.
	 */
	private async attachFileContext(): Promise<void> {
		const root = this.resolveProjectRoot();
		if (!root) {
			this.notificationService.warn(localize('vibeAIAgentsHub.noProjectForContext', "Open a project first — @ context attaches files from the project folder."));
			return;
		}
		const rels: string[] = [];
		try {
			const top = await this.fileService.resolve(URI.file(root), { resolveMetadata: false });
			for (const child of top.children ?? []) {
				if (child.isFile && rels.length < 200) {
					rels.push(child.resource.fsPath.slice(root.length + 1));
				}
			}
			for (const child of top.children ?? []) {
				if (!child.isDirectory || rels.length >= 200) {
					continue;
				}
				const sub = await this.fileService.resolve(child.resource, { resolveMetadata: false });
				for (const entry of sub.children ?? []) {
					if (entry.isFile && rels.length < 200) {
						rels.push(entry.resource.fsPath.slice(root.length + 1));
					}
				}
			}
		} catch {
			// Unreadable folder — offer whatever was collected.
		}
		if (rels.length === 0) {
			return;
		}
		const picker = this.quickInputService.createQuickPick<IQuickPickItem>();
		picker.items = rels.map(rel => ({ label: rel } as IQuickPickItem));
		picker.placeholder = localize('vibeAIAgentsHub.attachPick', "Attach a file as context");
		this.paneDisposables.add(picker.onDidAccept(() => {
			const picked = picker.activeItems[0];
			picker.hide();
			if (picked && this.composerInput) {
				const current = this.composerInput.value;
				this.composerInput.value = (current && !current.endsWith(' ') ? `${current} ` : '') + `@${picked.label}`;
				this.composerInput.focus();
			}
		}));
		picker.show();
	}

	/**
	 * Project badge for a thread row: the thread's project folder name when
	 * it differs from this window's project resolution (agent window threads
	 * can span projects). Empty string = no badge.
	 */
	private sessionProjectLabel(session: IVibeAIChatSession): string {
		if (!this.isAgentWindow || !session.workspaceRoot) {
			return '';
		}
		const root = this.resolveProjectRoot();
		if (root && session.workspaceRoot.toLowerCase() === root.toLowerCase()) {
			return '';
		}
		return basename(URI.file(session.workspaceRoot));
	}

	/** The model the chat pane would use right now (composer chip). */
	private currentModelLabel(): string {
		const selection = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		if (selection === 'Auto') {
			return localize('vibeAIAgentsHub.modelAuto', "Auto");
		}
		// Chip shows the bare model name (Cursor style: no provider prefix).
		return (this.modelStore.get(selection)?.name ?? selection).split('/').pop() || selection;
	}

	/** Coarse relative time for thread rows (s / m / h / d). */
	private relativeTime(timestamp: number): string {
		const delta = Math.max(0, Date.now() - timestamp);
		const seconds = Math.floor(delta / 1000);
		if (seconds < 60) {
			return localize('vibeAIAgentsHub.time.now', "just now");
		}
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) {
			return localize('vibeAIAgentsHub.time.minutes', "{0}m ago", minutes);
		}
		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return localize('vibeAIAgentsHub.time.hours', "{0}h ago", hours);
		}
		const days = Math.floor(hours / 24);
		return localize('vibeAIAgentsHub.time.days', "{0}d ago", days);
	}
}
