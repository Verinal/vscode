/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAIAutomation, IVibeAIAutomationTrigger, IVibeAIChatRequest, IVibeAIBackgroundAgent, IVibeAIContextUsage, IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAIFileContext, IVibeAIMessage, IVibeAIModelProvider, IVibeAIParallelRun, IVibeAIStreamData, IVibeAIService, VibeAICustomizeKind, VibeAICustomizeScope } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getDurationString } from '../../../../base/common/date.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VibeAIChatSessionStore, IVibeAIChatHandoff, IVibeAIChatSession, VIBE_AI_HANDOFF_MAX_AGE_MS, VIBE_AI_HANDOFF_STORAGE_KEY, parseVibeAIChatHandoff } from './vibeAIChatSessionStore.js';
import { VibeAIChatPane, VIBE_AI_SHELL_LANGUAGE_ALIASES, readImageAsDataUrl } from './vibeAIChatPane.js';
import { VibeAISettingsEditorInput } from './vibeAISettingsEditor.js';
import { VibeAIModelStore, VIBE_AI_NO_MODEL_MESSAGE } from './vibeAIModelStore.js';
import { enhanceFileChips } from './vibeAIFileChips.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import './media/vibeAIAgentsHub.css';

const $ = DOM.$;

/**
 * r30: one tab in the right-side expansion area — an opened file, the
 * embedded browser, or the terminal (Cursor keeps all three on the right).
 */
type VibeAIFpTab =
	| { kind: 'file'; id: string; fsPath: string; display: string }
	| { kind: 'browser'; id: string }
	| { kind: 'terminal'; id: string };


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
/** Phase 184: per-message image cap (the chat pane's MAX_ATTACHED_IMAGES parity). */
const HUB_MAX_ATTACHED_IMAGES = 8;
/** Phase 184: attached file content clip (the pane's FILE_CONTEXT_MAX_CHARS parity; the backend re-clips to 6000). */
const HUB_FILE_CONTEXT_MAX_CHARS = 6000;

/**
 * Phase 184: a hub attachment entry — the shared `IVibeAIFileContext`
 * shape but mutable, so the async file read can fill `content` on the
 * entry the chip already renders (identical structure, assignable both
 * ways).
 */
type VibeAIHubFileEntry = { path: string; kind?: 'file' | 'folder'; content?: string };

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

/** r16: context-ring geometry — same 20×20 viewBox / r 7.5 arc as the chat pane (Phase 41). */
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * 7.5;

// r22: smooth streaming for the live transcript — the same pump scheme as
// the chat pane: deltas accumulate in the turn's text and a repeating tick
// paints a few more characters (proportional catch-up), so bursty SSE
// arrivals render as a steady typewriter flow instead of clumps.
const SMOOTH_STREAM_TICK_MS = 40;
const SMOOTH_STREAM_MIN_CHARS = 3;
const SMOOTH_STREAM_CATCHUP_DIVISOR = 6;

/**
 * r23: the MCP create form's prefilled mcpServers JSON (Cursor parity —
 * the standard config shape users already have from other tools; the
 * wrapper is optional, a bare name → config map is accepted too).
 */
const MCP_JSON_TEMPLATE = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`;

/**
 * r20: Context Usage panel constants — mirrored from the chat pane
 * (Phase 41): default limit, the editable clamp range and the per-part
 * label + bar color table. The panel DOM reuses the pane's
 * `.vibe-ai-context-*` classes (vibeAIChat.css is loaded in this window),
 * so only the small helpers are duplicated here.
 */
const DEFAULT_CONTEXT_LIMIT = 200_000;
const CONTEXT_LIMIT_MIN = 100_000;
const CONTEXT_LIMIT_MAX = 1_000_000;
const CONTEXT_PART_STYLES: Record<string, { label: string; color: string }> = {
	systemPrompt: { label: 'System prompt', color: 'var(--vscode-descriptionForeground, #9d9d9d)' },
	toolDefinitions: { label: 'Tool definitions', color: 'var(--vscode-charts-purple, #b180d7)' },
	mcpDynamicTools: { label: 'MCP & dynamic tools', color: '#e35f8a' },
	rules: { label: 'Rules', color: 'var(--vscode-charts-blue, #3794ff)' },
	skills: { label: 'Skills', color: 'var(--vscode-charts-green, #89d185)' },
	learnings: { label: 'Learnings', color: 'var(--vscode-charts-yellow, #cca700)' },
	subagents: { label: 'Subagents', color: 'var(--vscode-charts-orange, #d18616)' },
	goal: { label: 'Goal', color: 'var(--vscode-charts-purple, #b180d7)' },
	filesContext: { label: 'Files & context', color: 'var(--vscode-charts-orange, #d18616)' },
	conversation: { label: 'Conversation', color: '#c55450' },
};

/** Cursor-parity token formatting: "535", "3.6K", "18.7K", "200K", "1M". */
function formatContextTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		const k = tokens / 1000;
		return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
	}
	return `${tokens}`;
}

/** Parses a context-limit value ("200000", "200K", "1.5m") — undefined = unparseable. */
function parseContextTokens(raw: string): number | undefined {
	const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
	if (!match) {
		return undefined;
	}
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value)) {
		return undefined;
	}
	const suffix = match[2]?.toLowerCase();
	const scale = suffix === 'k' ? 1000 : suffix === 'm' ? 1_000_000 : 1;
	return Math.round(value * scale);
}

/**
 * r20: light "Worked for Xs" counts suffix from the persisted step names —
 * read / scan steps fold into "Read N files · Searched N times" segments
 * (the pane's workedCountsSegments equivalent, minus the card grouping).
 */
function workedCountsSuffix(steps: readonly { name: string; status?: string }[]): string {
	const done = steps.filter(step => step.status !== 'error');
	const reads = done.filter(step => step.name === 'read_file').length;
	const scans = done.filter(step => step.name === 'grep' || step.name === 'search_codebase' || step.name === 'list_files').length;
	const segments: string[] = [];
	if (reads > 0) {
		segments.push(localize('vibeAIAgentsHub.workedReads', "Read {0} files", reads));
	}
	if (scans > 0) {
		segments.push(localize('vibeAIAgentsHub.workedScans', "Searched {0} times", scans));
	}
	return segments.join(' · ');
}

/**
 * r21: one bundled marketplace entry — a template the local backend really
 * creates through customizeCreate (no remote directory server; this is the
 * honest local counterpart of Cursor's marketplace).
 */
interface VibeAIMarketEntry {
	readonly kind: VibeAICustomizeKind;
	readonly name: string;
	readonly description: string;
	readonly content?: string;
	readonly command?: string;
	readonly args?: string[];
}

/** r21: the bundled catalog — well-known MCP servers + starter rules/skills. */
const MARKETPLACE_CATALOG: VibeAIMarketEntry[] = [
	{
		kind: 'mcp',
		name: 'Filesystem',
		description: localize('vibeAIAgentsHub.mktFsDesc', "Read and edit files under the project folder"),
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
	},
	{
		kind: 'mcp',
		name: 'Fetch',
		description: localize('vibeAIAgentsHub.mktFetchDesc', "Let the model fetch web pages over HTTP"),
		command: 'uvx',
		args: ['mcp-server-fetch'],
	},
	{
		kind: 'mcp',
		name: 'Memory',
		description: localize('vibeAIAgentsHub.mktMemoryDesc', "Persistent knowledge-graph memory between sessions"),
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-memory'],
	},
	{
		kind: 'mcp',
		name: 'Sequential Thinking',
		description: localize('vibeAIAgentsHub.mktSeqDesc', "Structured step-by-step reasoning tool"),
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
	},
	{
		kind: 'mcp',
		name: 'Git',
		description: localize('vibeAIAgentsHub.mktGitDesc', "Git insight (status / diff / log) for the active repository"),
		command: 'uvx',
		args: ['mcp-server-git'],
	},
	{
		kind: 'rules',
		name: 'Reply in Traditional Chinese',
		description: localize('vibeAIAgentsHub.mktZhDesc', "Always answer in zh-TW; code stays English"),
		content: 'Always respond in Traditional Chinese (zh-TW).\nKeep identifiers, code, commands and file paths in English.\nExplain technical terms with their English original in parentheses when first used.',
	},
	{
		kind: 'rules',
		name: 'Conventional Commits',
		description: localize('vibeAIAgentsHub.mktCommitDesc', "Commit messages follow Conventional Commits"),
		content: 'Write commit messages as Conventional Commits:\n`type(scope): subject`\n\ntype ∈ feat | fix | docs | style | refactor | perf | test | chore.\nThe subject is imperative, lowercase, no trailing period, ≤ 72 chars.\nThe body (when needed) explains WHY, not WHAT.',
	},
	{
		kind: 'rules',
		name: 'Small, focused changes',
		description: localize('vibeAIAgentsHub.mktSmallDesc', "Surgical diffs — no drive-by refactors"),
		content: 'Keep changes surgical: touch only what the task requires.\nNo drive-by reformatting, renames or dependency bumps.\nWhen a bigger cleanup is warranted, propose it in the reply instead of doing it silently.',
	},
	{
		kind: 'skills',
		name: 'code-review',
		description: localize('vibeAIAgentsHub.mktReviewDesc', "Checklist-driven review of the current diff"),
		content: '# Code Review\n\nReview the current diff against this checklist and report findings by severity:\n\n1. Correctness — logic errors, unhandled edge cases, off-by-one.\n2. Safety — injection, unsafe shell usage, secrets in code.\n3. Consistency — naming, style and idioms of the surrounding code.\n4. Tests — the changed behavior has coverage.\n\nEnd with a verdict: approve, comment, or request changes.',
	},
	{
		kind: 'skills',
		name: 'commit-message',
		description: localize('vibeAIAgentsHub.mktMsgDesc', "Derive a commit message from the staged diff"),
		content: '# Commit Message\n\n1. Run `git diff --staged` and summarize the change.\n2. Pick the Conventional Commits type (feat / fix / docs / refactor / test / chore).\n3. Write `type(scope): subject` (imperative, ≤ 72 chars) plus a body explaining why.\n4. Show the message for confirmation before committing.',
	},
];

/** Session-id → live turn for sessions streaming right now (hub-wide). */
const liveTurns = new Map<string, VibeAILiveTurn>();

/**
 * r12: one conversation the agent window itself is running — the composer
 * send streams the agent loop right here (Cursor parity) instead of
 * handing off to the IDE. The accumulated text persists to the session
 * store when the turn finishes.
 */
interface VibeAIHubLiveTurn {
	readonly sessionId: string;
	text: string;
	state: string;
	toolName: string | undefined;
	error: string | undefined;
	/** r22: chars painted so far — the pump advances it toward text.length. */
	smoothedAt: number;
	/** r22: pending pump tick (renderHubLiveText); undefined = pump idle. */
	smoothTimer: number | undefined;
	statusEl: HTMLElement | undefined;
	textEl: HTMLElement | undefined;
	/** r20: turn start — the persisted trace's duration source. */
	startedAt: number;
	/** r20: tool steps in arrival order (the live + persisted Worked rows). */
	steps: { name: string; status: string; detail?: string; thinking?: string }[];
	/** r20: the live Worked steps container (re-bound by renderConversation). */
	stepsEl: HTMLElement | undefined;
	/** r24: wall clock of the open thinking round — closes into a "Thought for Xs" step. */
	thinkingStartedAt: number | undefined;
	/** r27: the open round's thinking text — rides the (expandable) Thought step. */
	thinking: string;
}

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
	/** r29/r30: the right-side expansion area — a tabbed panel (files / browser / terminal). */
	private filepane: HTMLElement | undefined;
	private fpTabsEl: HTMLElement | undefined;
	private fpBodyEl: HTMLElement | undefined;
	/** r30: open right-pane tabs — opened files, the embedded browser, the terminal. */
	private fpTabs: VibeAIFpTab[] = [];
	private fpActiveId: string | undefined;
	private fpTabSeq = 0;
	/** r30: the live terminal instance living in the right pane's Terminal tab. */
	private fpTerminal: ITerminalInstance | undefined;
	private fpTerminalObserver: ResizeObserver | undefined;
	private fpTerminalTitle: string | undefined;
	private fpTerminalTitleSub: IDisposable | undefined;
	/** r30: the URL currently shown in the Browser tab (undefined = new-tab page). */
	private fpBrowserUrl: string | undefined;
	private static readonly BROWSER_RECENTS_STORAGE_KEY = 'vibeAI.agentWindow.browserRecents';
	private sessionsEl: HTMLElement | undefined;
	private backgroundEl: HTMLElement | undefined;
	private parallelEl: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private projectNameEl: HTMLElement | undefined;
	private repoListEl: HTMLElement | undefined;
	private filterInput: HTMLInputElement | undefined;
	private sidebarFilter = '';
	// r37: per-project history grouping — which groups are collapsed and how
	// many threads each reveals (2 by default; "More" adds five per click).
	private sidebarGroupClosed = new Set<string>();
	private sidebarGroupLimit = new Map<string, number>();
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

	/** r12: agent-window runs dispatched by this pane (requestId counter). */
	private hubRequestCounter = 0;

	/** r12: session-id → the in-flight conversation run in this window. */
	private readonly hubTurns = new Map<string, VibeAIHubLiveTurn>();

	/** r13: the top-bar slot rendering the expanded thread's title. */
	private chatTitleEl: HTMLElement | undefined;

	/** r14: the chat pane's tokenized code block renderer (same pipeline). */
	private readonly editorCodeBlockRenderer: EditorMarkdownCodeBlockRenderer;

	/** r15: the sent message currently being edited (inline edit UI). */
	private editingMessage: { sessionId: string; index: number } | undefined;
	/** Set when a press outside the edit card just closed it — the click of
	 * that same gesture must not re-open another card's edit (click-outside
	 * means exit, IDE pane parity). Cleared by the next pointerdown (the
	 * reset runs first in createEditor's document-capture listener). */
	private editClickSuppressed = false;

	// --- Phase 184: real attachments (Cursor-parity chips), agent window ---
	/** Files/images attached to the NEXT composer message (chips row). */
	private readonly hubFiles: VibeAIHubFileEntry[] = [];
	private readonly hubImages: string[] = [];
	/** The composer's attachment chips row (hidden while empty). */
	private composerAttRow: HTMLElement | undefined;
	/**
	 * The open edit card's own attachment set — seeded from the edited
	 * message's sent attachments (chips/thumbnails above the card),
	 * editable in place (chip ✕ removes, "+" / paste adds). The composer's
	 * pending set is never touched (same decoupling as the IDE pane).
	 */
	/**
	 * Phase 184: the open edit card's own attachment set (seeded from the
	 * message when the edit opens; written back on submit) — the edit box
	 * no longer mirrors the bottom composer's pending chips.
	 */
	private editingAttachments: { files: VibeAIHubFileEntry[]; images: string[] } | undefined;
	/** Phase 184: the open edit card's attachment chips row (in-place re-render). */
	private editingAttRow: HTMLElement | undefined;
	/** Phase 184: the composer chips row's listeners (cleared on re-render). */
	private readonly hubChipListeners = this._register(new DisposableStore());
	/**
	 * The open edit card's attachment chips row listeners — a DEDICATED
	 * store: renderHubAttachmentChipsInto clears its store on every re-render,
	 * and routing it at paneDisposables wiped every pane-level listener with
	 * it (the document-level click-outside edit cancel, the composer's send,
	 * the rail rows) the first time an edit card rendered.
	 */
	private readonly editChipListeners = this._register(new DisposableStore());

	/** r28: every model chip (composer + open edit cards) — picks refresh all. */
	private readonly modelChips = new Set<HTMLButtonElement>();

	/** r16: the context chip row under/above the composer (project chip re-parents out of it). */
	private chipsEl: HTMLElement | undefined;
	/** r16: the project chip — moves into the composer bar in follow-up mode. */
	private projectChipEl: HTMLElement | undefined;
	/** r16: the "This PC" chip — moves into the composer bar with the project chip. */
	private envChipEl: HTMLElement | undefined;
	/** r16: Cursor-parity context usage ring in the composer bar (Phase 41 geometry). */
	private contextRingButton: HTMLElement | undefined;
	private contextRingArc: SVGElement | undefined;
	/** r16: latest context usage estimate for the expanded conversation. */
	private contextUsage: IVibeAIContextUsage | undefined;
	private contextUsageSeq = 0;
	/** r20: the Context Usage panel above the composer (pane's Phase 41 panel). */
	private contextPanelEl: HTMLElement | undefined;
	private contextPercentEl: HTMLElement | undefined;
	private contextTotalEl: HTMLElement | undefined;
	private contextBarEl: HTMLElement | undefined;
	private contextRowsEl: HTMLElement | undefined;
	private contextWarningEl: HTMLElement | undefined;
	private contextSliderEl: HTMLInputElement | undefined;
	private contextLimitInputEl: HTMLInputElement | undefined;
	private contextPanelOpen = false;
	private contextLimit = DEFAULT_CONTEXT_LIMIT;

	/** r17: the Cursor-parity Customize page (Rules / Skills / MCP) in the center canvas. */
	private customizeEl: HTMLElement | undefined;
	private customizeListEl: HTMLElement | undefined;
	private customizeRowEl: HTMLElement | undefined;
	private customizeActive = false;
	private customizeKind: VibeAICustomizeKind = 'mcp';
	private customizeSearch = '';
	private customizeFormOpen = false;
	/** r21: the Browse Marketplace view (bundled one-click catalog) replaces the manage page. */
	private customizeMarketOpen = false;
	/** r21: already-added catalog entries (`kind:name`) — their Add buttons flip to Added. */
	private readonly marketAdded = new Set<string>();

	// Phase 189: the Automations page (trigger + prompt rules the backend
	// runs unattended) in the center canvas — Cursor Automations parity.
	private automationsEl: HTMLElement | undefined;
	private automationsRowEl: HTMLElement | undefined;
	private automationsActive = false;
	private automationFormOpen = false;
	/** Latest list from the backend (undefined = not fetched yet). */
	private automations: IVibeAIAutomation[] | undefined;

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
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super(VibeAIAgentsHubPane.ID, group, telemetryService, themeService, storageService);
		this.sessionStore = new VibeAIChatSessionStore(storageService, contextService);
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
		// r14: the chat pane's editor-backed tokenized code block renderer —
		// agent-window answers use the exact same code block pipeline.
		this.editorCodeBlockRenderer = this.instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
		this.isAgentWindow = environmentService.isVibeAgentWindow;
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, $('.vibe-ai-agents-hub'));

		// Click-outside closes an open message-edit card (IDE pane's prompt
		// edit contract): any press outside the edit box tears it down and
		// restores the static card. Presses inside the edit box, its in-pane
		// dropdown menus (.vibe-ai-agents-menu) or workbench overlays (quick
		// pick, context views) keep the edit. The press that closed an edit
		// sets editClickSuppressed so its click cannot re-open another card's
		// edit; the reset above runs first on every fresh press.
		this.paneDisposables.add(DOM.addDisposableListener(document, 'pointerdown', e => {
			this.editClickSuppressed = false;
			if (!this.editingMessage) {
				return;
			}
			const target = e.target as Node | null;
			if (!target) {
				return;
			}
			const box = this.chatEl?.querySelector('.vibe-ai-agents-chat-edit-box');
			if (box?.contains(target)) {
				return;
			}
			if (target instanceof Element && target.closest('.vibe-ai-agents-menu, .context-view, .quick-input-widget')) {
				return;
			}
			this.cancelMessageEdit();
			this.editClickSuppressed = true;
		}, true));

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
				// composer is the new conversation. r17: it also leaves
				// the Customize page. Phase 189: and the Automations page.
				this.setCustomizeMode(false);
				this.setAutomationsMode(false);
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
		// Phase 189: Automations — trigger + prompt rules the backend runs
		// unattended (schedule / git commit / Run now), Cursor parity. The
		// row opens the manage page in the center canvas (click again to
		// leave), same interaction as Customize.
		this.automationsRowEl = this.appendActionRow(actions, localize('vibeAIAgentsHub.automations', "Automations"), Codicon.sync, () => {
			this.setAutomationsMode(!this.automationsActive);
		});
		this.customizeRowEl = this.appendActionRow(actions, localize('vibeAIAgentsHub.customize', "Customize"), Codicon.gear, () => {
			// r17: Cursor parity — Customize renders the manage page in the
			// center canvas (click again to leave); the Settings editor stays
			// reachable from the footer gear.
			this.setCustomizeMode(!this.customizeActive);
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
		// r31: the wrap groups main + the right pane — the pane takes HALF
		// OF THIS WRAP (the area right of the sidebar), so a collapsed rail
		// makes it half of the whole window.
		const chatwrap = DOM.append(this.root, $('.vibe-ai-agents-chatwrap'));
		const main = DOM.append(chatwrap, $('.vibe-ai-agents-main'));
		// r29: the right-side file expansion area (Cursor parity) — the root
		// lays out [side | main | filepane]; hidden until a chat file
		// reference is clicked, main then narrows to give it room.
		// r30: the pane is tabbed (files / Browser / Terminal, Cursor parity).
		this.filepane = DOM.append(chatwrap, $('.vibe-ai-agents-filepane'));
		this.fpTabsEl = DOM.append(this.filepane, $('.vibe-ai-agents-fp-tabs'));
		this.fpBodyEl = DOM.append(this.filepane, $('.vibe-ai-agents-fp-body'));

		// --- top bar (Phase 181): project and "This PC" moved into the
		// composer's context chips; the bar keeps only the "IDE ↗" jump back
		// to a real editor window (agent window only)
		const topbar = DOM.append(main, $('.vibe-ai-agents-topbar'));
		// r13: the expanded thread's title lives here (left side of the top
		// bar, Cursor parity) — not inside the transcript. The sidebar
		// toggle stays in the rail header (it survives collapsing); the
		// top bar's right end carries the r36 mirror toggle for the
		// right-hand pane.
		this.chatTitleEl = DOM.append(topbar, $('div.vibe-ai-agents-topbar-chat'));
		if (this.isAgentWindow) {
			const ideBtn = DOM.append(topbar, $('button.vibe-ai-agents-ide')) as HTMLButtonElement;
			DOM.append(ideBtn, $('span.codicon.codicon-link-external'));
			ideBtn.appendChild(document.createTextNode(localize('vibeAIAgentsHub.openIde', "IDE")));
			ideBtn.title = localize('vibeAIAgentsHub.openIdeTitle', "Open this project in the IDE");
			ideBtn.setAttribute('aria-label', ideBtn.title);
			this.paneDisposables.add(DOM.addDisposableListener(ideBtn, DOM.EventType.CLICK, () => this.openInIde()));
			// r36: mirror of the rail-header sidebar toggle — collapses/expands
			// the right pane (open tabs, terminal, browser) from the top bar.
			const paneBtn = DOM.append(topbar, $('button.codicon.codicon-layout-sidebar-right.vibe-ai-agents-head-btn.vibe-ai-agents-pane-btn')) as HTMLButtonElement;
			paneBtn.title = localize('vibeAIAgentsHub.togglePane', "Toggle right pane");
			this.paneDisposables.add(DOM.addDisposableListener(paneBtn, DOM.EventType.CLICK, () => {
				if (!this.root) {
					return;
				}
				const visible = (this.root.classList.contains('file-open') || this.root.classList.contains('pane-open')) && !this.root.classList.contains('pane-collapsed');
				if (visible) {
					this.root.classList.add('pane-collapsed');
				} else {
					this.root.classList.remove('pane-collapsed');
					if (!this.root.classList.contains('file-open')) {
						this.root.classList.add('pane-open');
					}
				}
			}));
		}

		// --- centered composer (starts conversations right from the hub)
		const center = DOM.append(main, $('.vibe-ai-agents-center'));
		// Phase 181 r8: clicking a thread expands its conversation in the
		// center canvas above the composer (Cursor agent-window parity).
		this.chatEl = DOM.append(center, $('.vibe-ai-agents-chat'));
		// Phase 181 r2: context chips float ABOVE the composer card,
		// borderless (Cursor layout) — target project + "This PC".
		const chips = DOM.append(center, $('.vibe-ai-agents-chips'));
		this.chipsEl = chips;
		const projectChip = DOM.append(chips, $('.vibe-ai-agents-chip'));
		this.projectChipEl = projectChip;
		DOM.append(projectChip, $('span.codicon.codicon-folder'));
		this.projectNameEl = DOM.append(projectChip, $('span.vibe-ai-agents-project-name'));
		DOM.append(projectChip, $('span.codicon.codicon-chevron-down.vibe-ai-agents-chip-caret'));
		this.paneDisposables.add(DOM.addDisposableListener(projectChip, DOM.EventType.CLICK, () => { this.pickProjectFromRepos(projectChip); }));
		const envChip = DOM.append(chips, $('.vibe-ai-agents-chip.vibe-ai-agents-chip-static'));
		this.envChipEl = envChip;
		DOM.append(envChip, $('span.codicon.codicon-vm'));
		DOM.append(envChip, $('span')).textContent = localize('vibeAIAgentsHub.thisPC', "This PC");
		const composer = DOM.append(center, $('.vibe-ai-agents-composer'));
		// r20: the Context Usage panel — hidden above the input; the ring
		// toggles it. Reuses the pane's `.vibe-ai-context-*` DOM + CSS.
		this.buildHubContextPanel(composer);
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
		// Phase 184: image paste on the composer — screenshots/photos on the
		// clipboard attach as thumbnail chips (IDE pane parity); a clipboard
		// without images lets the native text paste run untouched.
		this.paneDisposables.add(DOM.addDisposableListener(this.composerInput, DOM.EventType.PASTE, e => {
			this.handleHubImagePaste(e, this.hubImages, () => this.renderHubAttachmentChips());
		}));
		// Phase 184: the composer's attachment chips row — the pending
		// chips (image thumbnails + file pills) ride ABOVE the textarea
		// inside the composer card (the IDE composer's chips row layout).
		this.composerAttRow = DOM.append(composer, $('.vibe-ai-agents-att-row'));
		this.composerAttRow.style.display = 'none';
		composer.insertBefore(this.composerAttRow, this.composerInput);
		this.renderHubAttachmentChips();
		const composerBar = DOM.append(composer, $('.vibe-ai-agents-composer-bar'));
		// Phase 181/182: the "+" attaches a project file as a REAL context
		// chip (the `@rel/path` mention text keeps working when typed).
		const addBtn = DOM.append(composerBar, $('button.codicon.codicon-add.vibe-ai-agents-add')) as HTMLButtonElement;
		addBtn.title = localize('vibeAIAgentsHub.attachContext', "Attach file context");
		addBtn.setAttribute('aria-label', addBtn.title);
		this.paneDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => { this.attachFileContext(); }));
		// r16: Cursor-parity context usage ring — sits left of the model chip.
		this.buildHubContextRing(composerBar);
		// Model chip (Cursor parity): dropdown over the configured models,
		// mirrors the chat pane's default via the `vibeAI.chat.model` setting.
		// r28: registered — a pick from any chip refreshes all of them.
		const modelBtn = DOM.append(composerBar, $('button.vibe-ai-agents-model')) as HTMLButtonElement;
		this.registerModelChip(modelBtn);
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

		// r17: the Customize manage page (Rules / Skills / MCP) — hidden
		// until the sidebar's Customize row selects it (.cx-open).
		this.customizeEl = DOM.append(center, $('.vibe-ai-agents-cx'));
		this.customizeEl.style.display = 'none';

		// Phase 189: the Automations page — hidden until the sidebar's
		// Automations row selects it (.auto-open).
		this.automationsEl = DOM.append(center, $('.vibe-ai-agents-auto'));
		this.automationsEl.style.display = 'none';

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
		// Phase 184: the pending chips leave the composer with the send —
		// they ride the new message (agent window) or hand off to the pane
		// conversation (IDE window).
		const files = this.hubFiles.splice(0, this.hubFiles.length);
		const images = this.hubImages.splice(0, this.hubImages.length);
		this.renderHubAttachmentChips();
		// r12: the agent window runs conversations itself — the composer
		// send streams the agent loop right here (no IDE handoff).
		if (this.isAgentWindow) {
			this.sendInAgentWindow(text, files, images);
			return;
		}
		this.openChat(pane => pane.sendFromHub(text, this.resolveProjectRoot(), files, images));
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
		// r12: conversations this window is running stream into the center
		// transcript — they bypass the sidebar-only tracking below.
		const hubTurn = this.hubTurns.get(data.sessionId);
		if (hubTurn) {
			this.handleHubTurnEvent(hubTurn, data);
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
	 * Sidebar thread list — the flat view (IDE windows / rail search).
	 * Phase 183 (user: repositories 要像圖三分組): in the agent window the
	 * history groups INTO the Repositories rows instead (renderRepos,
	 * Cursor parity), so this section hides there; it still shows the
	 * empty-state hint. Live ones show a spinner + turn state in place of
	 * the timestamp. Hover ✕ deletes.
	 */
	private renderSessions(): void {
		if (!this.sessionsEl) {
			return;
		}
		this.sessionsEl.innerText = '';
		this.sessionsEl.style.display = '';

		const sessions = this.sessionStore.list();
		if (sessions.length === 0) {
			DOM.append(this.sessionsEl, $('.vibe-ai-agents-empty')).textContent = localize('vibeAIAgentsHub.noSessions', "No conversations yet — say something in the chat or start one above.");
			return;
		}
		if (this.isAgentWindow && !this.sidebarFilter) {
			// Phase 183: the history lives inside the Repositories rows —
			// hide the flat list (also clears a stale previous render).
			this.sessionsEl.style.display = 'none';
			return;
		}
		// Pinned first (Phase 49 parity), then most recently updated.
		const sorted = [...sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
		// Phase 181 r2: the rail search box filters threads by title.
		const filtered = this.sidebarFilter
			? sorted.filter(s => s.title.toLowerCase().includes(this.sidebarFilter))
			: sorted;
		for (const session of filtered.slice(0, SESSIONS_MAX)) {
			this.renderSessionRow(session, true);
		}
	}

	/** r37: one thread row — shared by the flat list and the repo groups. */
	private renderSessionRow(session: IVibeAIChatSession, showProjectBadge: boolean, container: HTMLElement = this.sessionsEl!): void {
		const live = liveTurns.get(session.id);
		const row = DOM.append(container, $('.vibe-ai-agents-thread'));
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
		// Flat list only: grouped mode names the project on its header
		// instead, so the per-row badge would just repeat it.
		if (showProjectBadge) {
			const projectLabel = this.sessionProjectLabel(session);
			if (projectLabel) {
				DOM.append(meta, $('span.vibe-ai-agents-thread-project')).textContent = projectLabel;
			}
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
				// r17: opening a thread leaves the Customize page.
				// Phase 189: and the Automations page.
				this.setCustomizeMode(false);
				this.setAutomationsMode(false);
				// r29: the right pane belongs to the old thread — close it.
				this.closeHubFilePane();
				this.selectedSessionId = fresh.id;
				this.renderConversation();
				// Phase 183: the thread rows live inside the repo groups —
				// repaint them so the .active highlight follows the click.
				this.renderRepos();
				this.renderSessions();
				return;
			}
			this.openChat(pane => pane.loadSession(fresh));
		}));
	}

	/**
	 * Phase 181 r8: the center canvas transcript for the expanded thread —
	 * the conversation renders above the composer (Cursor agent-window
	 * parity). "Open in IDE" hands the thread to a real IDE window; ✕
	 * collapses back to the fresh composer.
	 */
	/**
	 * r10: once a thread is expanded the composer area restructures like Cursor's
	 * follow-up bar — slim one-line input with a "Send follow-up" placeholder and
	 * the context chips re-ordered below the composer (CSS `.chat-open`).
	 */
	private setFollowUpMode(on: boolean): void {
		this.root?.classList.toggle('chat-open', on);
		// r16: in follow-up mode BOTH chips (project + This PC) live in the
		// composer bar right of ＋ (Cursor); the fresh composer keeps them
		// in the chip row above.
		if (this.projectChipEl && this.envChipEl) {
			if (on && this.contextRingButton?.parentElement) {
				const bar = this.contextRingButton.parentElement;
				bar.insertBefore(this.projectChipEl, this.contextRingButton);
				bar.insertBefore(this.envChipEl, this.contextRingButton);
			} else if (!on && this.chipsEl) {
				this.chipsEl.prepend(this.envChipEl);
				this.chipsEl.prepend(this.projectChipEl);
			}
		}
		if (on) {
			// r20: re-sync the panel's limit to the thread being expanded
			// (switching threads while the panel is open re-targets it) and
			// repaint it from the latest estimate.
			const session = this.selectedSessionId
				? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
				: undefined;
			if (session?.contextLimit !== undefined) {
				this.contextLimit = session.contextLimit;
			}
			if (this.contextPanelOpen) {
				this.renderHubContextPanel();
			}
			this.refreshHubContextUsage();
		} else {
			// r20: collapsing the thread closes the Context Usage panel (the
			// fresh composer has no conversation to describe).
			this.toggleContextPanel(false);
		}
		if (this.composerInput) {
			this.composerInput.rows = on ? 1 : 3;
			this.composerInput.placeholder = on
				? localize('vibeAIAgentsHub.followUp', "Send follow-up")
				: localize('vibeAIAgentsHub.composerPlaceholder', "Plan, Build, / for skills, @ for context");
		}
	}

	/**
	 * r16: Cursor-parity context usage ring (the chat pane's Phase 41
	 * geometry) — a small circular progress indicator in the composer bar;
	 * the arc fills with the conversation's context usage percentage.
	 */
	private buildHubContextRing(toolbar: HTMLElement): void {
		const button = $('button.vibe-ai-context-ring');
		button.title = localize('vibeAIAgentsHub.contextRing', "Context Usage");
		button.setAttribute('aria-label', button.title);

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('aria-hidden', 'true');

		const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		track.setAttribute('cx', '10');
		track.setAttribute('cy', '10');
		track.setAttribute('r', '7.5');
		track.setAttribute('class', 'vibe-ai-context-ring-track');

		const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		arc.setAttribute('cx', '10');
		arc.setAttribute('cy', '10');
		arc.setAttribute('r', '7.5');
		arc.setAttribute('class', 'vibe-ai-context-ring-arc');
		// Start the arc at 12 o'clock and grow clockwise (same as the pane).
		arc.setAttribute('transform', 'rotate(-90 10 10)');
		svg.appendChild(track);
		svg.appendChild(arc);
		button.appendChild(svg);

		toolbar.appendChild(button);
		this.contextRingButton = button;
		this.contextRingArc = arc;
		// r20: the ring toggles the Context Usage panel (pane parity).
		this.paneDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => { this.toggleContextPanel(); }));
		this.renderHubContextRing();
	}

	/**
	 * r20: builds the Context Usage panel — the chat pane's Phase 41 card
	 * (percent + segmented bar + part rows + editable limit), inserted
	 * above the composer input and hidden until the ring toggles it.
	 */
	private buildHubContextPanel(composer: HTMLElement): void {
		// r26: the panel is a SIBLING card floating above the composer (pane
		// parity) — nesting it inside the bordered composer card double-framed
		// it and clipped an inner scrollbar into view.
		const panel = $('.vibe-ai-context-panel');
		panel.style.display = 'none';
		composer.parentElement?.insertBefore(panel, composer);
		this.contextPanelEl = panel;

		const header = DOM.append(panel, $('.vibe-ai-context-panel-header'));
		DOM.append(header, $('span.vibe-ai-context-panel-title')).textContent = localize('vibeAIAgentsHub.contextUsage', "Context Usage");
		const close = DOM.append(header, $('button.codicon.codicon-close.vibe-ai-context-panel-close')) as HTMLButtonElement;
		close.setAttribute('aria-label', localize('vibeAIAgentsHub.contextUsageClose', "Close"));
		this.paneDisposables.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, () => this.toggleContextPanel(false)));

		const usageRow = DOM.append(panel, $('.vibe-ai-context-usage-row'));
		this.contextPercentEl = DOM.append(usageRow, $('span.vibe-ai-context-percent'));
		const totalWrap = DOM.append(usageRow, $('span.vibe-ai-context-total'));
		this.contextTotalEl = DOM.append(totalWrap, $('span.vibe-ai-context-total-text'));
		DOM.append(totalWrap, $('span.vibe-ai-context-total-suffix')).textContent = localize('vibeAIAgentsHub.contextTokens', "Tokens");

		this.contextBarEl = DOM.append(panel, $('.vibe-ai-context-bar'));

		const sliderRow = DOM.append(panel, $('.vibe-ai-context-slider-row'));
		DOM.append(sliderRow, $('span.vibe-ai-context-slider-label')).textContent = localize('vibeAIAgentsHub.contextLimitLabel', "Limit");
		this.contextSliderEl = DOM.append(sliderRow, $('input.vibe-ai-context-slider')) as HTMLInputElement;
		this.contextSliderEl.type = 'range';
		this.contextSliderEl.min = `${CONTEXT_LIMIT_MIN}`;
		this.contextSliderEl.max = `${CONTEXT_LIMIT_MAX}`;
		this.contextSliderEl.step = '50000';
		this.contextSliderEl.title = localize('vibeAIAgentsHub.contextLimitSlider', "Maximum context (100K–1M tokens)");
		// Dragging re-renders locally; the persisted limit + fresh estimate
		// commit on release (pane parity).
		this.paneDisposables.add(DOM.addDisposableListener(this.contextSliderEl, 'input', () => {
			const parsed = Number.parseInt(this.contextSliderEl?.value ?? '', 10);
			if (Number.isFinite(parsed)) {
				this.contextLimit = Math.max(CONTEXT_LIMIT_MIN, Math.min(CONTEXT_LIMIT_MAX, parsed));
				this.renderHubContextPanel();
			}
		}));
		this.paneDisposables.add(DOM.addDisposableListener(this.contextSliderEl, 'change', () => {
			this.persistContextLimit();
		}));
		this.contextLimitInputEl = DOM.append(sliderRow, $('input.vibe-ai-context-limit-input')) as HTMLInputElement;
		this.contextLimitInputEl.type = 'text';
		this.contextLimitInputEl.spellcheck = false;
		this.contextLimitInputEl.title = localize('vibeAIAgentsHub.contextLimitEdit', "Edit the context limit (100K–1M tokens)");
		this.contextLimitInputEl.setAttribute('aria-label', this.contextLimitInputEl.title);
		this.paneDisposables.add(DOM.addDisposableListener(this.contextLimitInputEl, 'focus', () => this.contextLimitInputEl?.select()));
		this.paneDisposables.add(DOM.addDisposableListener(this.contextLimitInputEl, 'input', () => {
			const parsed = parseContextTokens(this.contextLimitInputEl?.value ?? '');
			if (parsed !== undefined) {
				this.contextLimit = Math.max(CONTEXT_LIMIT_MIN, Math.min(CONTEXT_LIMIT_MAX, parsed));
				this.renderHubContextPanel();
			}
		}));
		this.paneDisposables.add(DOM.addDisposableListener(this.contextLimitInputEl, 'change', () => {
			this.persistContextLimit();
		}));
		this.paneDisposables.add(DOM.addDisposableListener(this.contextLimitInputEl, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				DOM.EventHelper.stop(e, true);
				this.contextLimitInputEl?.blur();
			} else if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				if (this.contextLimitInputEl) {
					this.contextLimitInputEl.value = formatContextTokens(this.contextLimit);
					this.contextLimitInputEl.blur();
				}
			}
		}));

		this.contextRowsEl = DOM.append(panel, $('.vibe-ai-context-rows'));
		this.contextWarningEl = DOM.append(panel, $('.vibe-ai-context-warning'));
		this.renderHubContextPanel();
	}

	/** Commits the edited limit: persists to the session, refreshes the estimate. */
	private persistContextLimit(): void {
		if (this.contextLimitInputEl) {
			this.contextLimitInputEl.value = formatContextTokens(this.contextLimit);
		}
		this.renderHubContextPanel();
		const session = this.selectedSessionId
			? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
			: undefined;
		if (session) {
			this.sessionStore.save(session.id, session.messages, this.contextLimit);
		}
		this.refreshHubContextUsage();
	}

	/** Shows/hides the Context Usage panel (defaults to toggling). */
	private toggleContextPanel(open?: boolean): void {
		const target = open ?? !this.contextPanelOpen;
		if (target === this.contextPanelOpen || !this.contextPanelEl) {
			return;
		}
		this.contextPanelOpen = target;
		this.contextPanelEl.style.display = target ? 'block' : 'none';
		if (target) {
			const session = this.selectedSessionId
				? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
				: undefined;
			this.contextLimit = session?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
			this.refreshHubContextUsage();
			this.renderHubContextPanel();
		}
	}

	/** Renders percent / total / limit labels, the bar, the part rows and the warning. */
	private renderHubContextPanel(): void {
		if (!this.contextPercentEl || !this.contextTotalEl || !this.contextLimitInputEl || !this.contextBarEl || !this.contextRowsEl || !this.contextWarningEl) {
			return;
		}
		const usage = this.contextUsage;
		const limit = this.contextLimit;
		const percent = usage ? usage.percentFull : 0;
		const total = usage ? usage.totalTokens : 0;

		const percentText = percent >= 10 ? `${Math.round(percent)}` : `${Number(percent.toFixed(1))}`;
		this.contextPercentEl.textContent = localize('vibeAIAgentsHub.contextPercentFull', "{0}% Full", percentText);
		this.contextTotalEl.textContent = `~${formatContextTokens(total)} / ${formatContextTokens(limit)}`;
		if (this.contextSliderEl) {
			this.contextSliderEl.value = `${limit}`;
		}
		if (this.contextLimitInputEl && this.contextLimitInputEl !== document.activeElement) {
			this.contextLimitInputEl.value = formatContextTokens(limit);
		}

		DOM.clearNode(this.contextBarEl);
		DOM.clearNode(this.contextRowsEl);
		for (const part of usage?.parts ?? []) {
			const style = CONTEXT_PART_STYLES[part.key];
			const segment = DOM.append(this.contextBarEl, $('span.vibe-ai-context-bar-segment'));
			segment.style.width = `${Math.min(100, Math.max(0, part.tokens / limit * 100))}%`;
			segment.style.background = style?.color ?? 'var(--vscode-charts-purple)';
			segment.title = `${style?.label ?? part.key}: ${part.tokens.toLocaleString()}`;

			const row = DOM.append(this.contextRowsEl, $('.vibe-ai-context-row'));
			const dot = DOM.append(row, $('span.vibe-ai-context-row-dot'));
			dot.style.background = style?.color ?? 'var(--vscode-charts-purple)';
			DOM.append(row, $('span.vibe-ai-context-row-label')).textContent = style?.label ?? part.key;
			const tokens = DOM.append(row, $('span.vibe-ai-context-row-tokens'));
			tokens.textContent = formatContextTokens(part.tokens);
			tokens.title = `${part.tokens.toLocaleString()} tokens`;
		}

		DOM.clearNode(this.contextWarningEl);
		if (usage?.overLimit) {
			this.contextWarningEl.style.display = 'flex';
			const icon = DOM.append(this.contextWarningEl, $('span.codicon.codicon-warning'));
			icon.setAttribute('aria-hidden', 'true');
			DOM.append(this.contextWarningEl, $('span')).textContent = localize(
				'vibeAIAgentsHub.contextOverLimit',
				"Over the {0} token limit — older history will be compressed before the next request",
				formatContextTokens(limit)
			);
		} else {
			this.contextWarningEl.style.display = 'none';
		}
	}

	/** r16: paints the ring arc + tooltip from the latest usage estimate. */
	private renderHubContextRing(): void {
		const percent = Math.min(100, Math.max(0, this.contextUsage?.percentFull ?? 0));
		if (this.contextRingArc) {
			this.contextRingArc.style.strokeDasharray = `${CONTEXT_RING_CIRCUMFERENCE}`;
			this.contextRingArc.style.strokeDashoffset = `${CONTEXT_RING_CIRCUMFERENCE * (1 - percent / 100)}`;
		}
		if (this.contextRingButton) {
			this.contextRingButton.classList.toggle('over-limit', percent >= 100);
			this.contextRingButton.title = percent > 0
				? localize('vibeAIAgentsHub.contextRingPercent', "Context Usage {0}%", Math.round(percent))
				: localize('vibeAIAgentsHub.contextRing', "Context Usage");
		}
	}

	/**
	 * r16: re-estimates the expanded conversation's context usage from the
	 * session store — same backend endpoint the chat pane uses. A newer
	 * estimate supersedes in-flight ones via the sequence guard.
	 */
	private refreshHubContextUsage(): void {
		const session = this.selectedSessionId
			? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
			: undefined;
		if (!session || session.messages.length === 0) {
			this.contextUsage = undefined;
			this.renderHubContextRing();
			this.renderHubContextPanel();
			return;
		}
		const seq = ++this.contextUsageSeq;
		this.vibeAIService.contextUsage({
			messages: session.messages.map(m => ({ role: m.role, content: m.content })),
			contextLimit: session.contextLimit,
			workspaceRoot: this.resolveProjectRoot(),
		}).then(usage => {
			if (seq !== this.contextUsageSeq) {
				return; // a newer estimate superseded this one
			}
			this.contextUsage = usage;
			this.renderHubContextRing();
			this.renderHubContextPanel();
		}).catch(err => {
			this.logService.warn('[vibeAI] hub context usage estimate failed', err);
		});
	}

	// ==================== Automations page (Phase 189, Cursor parity) ====================

	/**
	 * Phase 189: the sidebar's Automations row renders the manage page in
	 * the center canvas — like Cursor's Automations tab. Lists the
	 * workspace's rules (trigger + prompt + model binding) that the local
	 * backend runs unattended: every N minutes / daily at HH:MM / on a git
	 * commit / on demand via "Run now". Same open/leave interaction as the
	 * Customize page.
	 */
	private setAutomationsMode(on: boolean): void {
		if (this.automationsActive === on) {
			return;
		}
		this.automationsActive = on;
		this.automationFormOpen = false;
		this.root?.classList.toggle('auto-open', on);
		this.automationsRowEl?.classList.toggle('active', on);
		// One center canvas — opening Automations leaves Customize (the
		// flag flip above makes the round-trip safe).
		if (on && this.customizeActive) {
			this.setCustomizeMode(false);
		}
		if (this.automationsEl) {
			this.automationsEl.style.display = on ? '' : 'none';
		}
		if (on) {
			this.toggleContextPanel(false);
			this.closeHubFilePane();
			if (this.chatTitleEl) {
				this.chatTitleEl.innerText = '';
			}
			void this.renderAutomationsPage();
		} else if (this.selectedSessionId) {
			this.renderConversation(); // restores the topbar title + follow-up composer
		}
	}

	/** Phase 189: page chrome (title + New Automation) then the rule list. */
	private async renderAutomationsPage(): Promise<void> {
		if (!this.automationsEl) {
			return;
		}
		this.automationsEl.innerText = '';
		const head = DOM.append(this.automationsEl, $('.vibe-ai-agents-auto-head'));
		DOM.append(head, $('h2.vibe-ai-agents-auto-title')).textContent = localize('vibeAIAgentsHub.autoTitle', "Automations");
		const newBtn = DOM.append(head, $('button.vibe-ai-agents-auto-new')) as HTMLButtonElement;
		newBtn.textContent = localize('vibeAIAgentsHub.autoNew', "New Automation");
		this.paneDisposables.add(DOM.addDisposableListener(newBtn, DOM.EventType.CLICK, () => {
			this.automationFormOpen = true;
			void this.renderAutomationsPage();
		}));
		DOM.append(this.automationsEl, $('.vibe-ai-agents-auto-hint')).textContent = localize('vibeAIAgentsHub.autoHint',
			"Rules that run a full agent from the local backend — on a schedule, on a git commit, or on demand.");
		const formWrap = DOM.append(this.automationsEl, $('.vibe-ai-agents-auto-form'));
		if (this.automationFormOpen) {
			this.renderAutomationForm(formWrap);
		}
		const list = DOM.append(this.automationsEl, $('.vibe-ai-agents-auto-list'));
		try {
			this.automations = await this.vibeAIService.listAutomations(this.resolveProjectRoot());
		} catch {
			this.automations = [];
		}
		// The page may have been left (or re-rendered) while fetching.
		if (!this.automationsActive || !list.isConnected) {
			return;
		}
		list.innerText = '';
		if (!this.automations.length) {
			DOM.append(list, $('.vibe-ai-agents-auto-empty')).textContent = localize('vibeAIAgentsHub.autoEmpty',
				"No automations yet — create one, or ask for one in chat (\"automate checking tests every morning\").");
			return;
		}
		for (const automation of this.automations) {
			this.renderAutomationCard(list, automation);
		}
	}

	/** Phase 189: human summary of a rule's trigger ("Every 30m", "Daily at 09:00", ...). */
	private automationTriggerText(automation: IVibeAIAutomation): string {
		switch (automation.trigger.type) {
			case 'interval':
				return localize('vibeAIAgentsHub.autoTrigEvery', "Every {0}m", String(automation.trigger.everyMinutes ?? 30));
			case 'daily':
				return localize('vibeAIAgentsHub.autoTrigDaily', "Daily at {0}", automation.trigger.dailyAt ?? '09:00');
			case 'git_commit':
				return localize('vibeAIAgentsHub.autoTrigGit', "On git commit");
			default:
				return localize('vibeAIAgentsHub.autoTrigManual', "Manual (Run now)");
		}
	}

	/** Phase 189: one rule card — status pill, meta line, latest run, actions. */
	private renderAutomationCard(container: HTMLElement, automation: IVibeAIAutomation): void {
		const card = DOM.append(container, $('.vibe-ai-agents-auto-card'));
		card.classList.toggle('off', !automation.enabled);
		const cardHead = DOM.append(card, $('.vibe-ai-agents-auto-card-head'));
		DOM.append(cardHead, $('.vibe-ai-agents-auto-name')).textContent = automation.name;
		const status = DOM.append(cardHead, $('.vibe-ai-agents-auto-status'));
		status.textContent = automation.enabled
			? localize('vibeAIAgentsHub.autoActive', "Active")
			: localize('vibeAIAgentsHub.autoInactive', "Inactive");
		status.classList.toggle('on', automation.enabled);

		const meta: string[] = [this.automationTriggerText(automation)];
		const boundModel = automation.provider?.model;
		if (boundModel) {
			meta.push(localize('vibeAIAgentsHub.autoModel', "model: {0}", boundModel));
		}
		if (automation.lastRunAt) {
			meta.push(this.relativeTime(automation.lastRunAt));
		}
		DOM.append(card, $('.vibe-ai-agents-auto-meta')).textContent = meta.join(' · ');

		// Latest run (running spinner / summary clip / error line).
		const runs = automation.runs ?? [];
		const last = runs.length ? runs[runs.length - 1] : undefined;
		if (last) {
			const runLine = DOM.append(card, $('.vibe-ai-agents-auto-runline'));
			runLine.classList.add(last.status);
			const label = last.status === 'running'
				? localize('vibeAIAgentsHub.autoRunRunning', "Running…")
				: last.status === 'error'
					? localize('vibeAIAgentsHub.autoRunError', "Failed — {0}", last.error || 'unknown error')
					: (last.summary || localize('vibeAIAgentsHub.autoRunDone', "Done"));
			runLine.textContent = `${this.relativeTime(last.startedAt)} · ${label}`;
			runLine.title = last.error || last.summary || '';
		}

		const actions = DOM.append(card, $('.vibe-ai-agents-auto-actions'));
		const runBtn = DOM.append(actions, $('button.vibe-ai-agents-auto-run')) as HTMLButtonElement;
		runBtn.textContent = localize('vibeAIAgentsHub.autoRunNow', "Run now");
		runBtn.disabled = !automation.enabled || last?.status === 'running';
		this.paneDisposables.add(DOM.addDisposableListener(runBtn, DOM.EventType.CLICK, async () => {
			runBtn.disabled = true;
			try {
				await this.vibeAIService.runAutomationNow(this.resolveProjectRoot(), automation.id);
			} catch { /* busy/404 — the re-render reflects the real state */ }
			void this.renderAutomationsPage();
		}));
		const toggleBtn = DOM.append(actions, $('button.vibe-ai-agents-auto-toggle')) as HTMLButtonElement;
		toggleBtn.textContent = automation.enabled
			? localize('vibeAIAgentsHub.autoDisable', "Disable")
			: localize('vibeAIAgentsHub.autoEnable', "Enable");
		this.paneDisposables.add(DOM.addDisposableListener(toggleBtn, DOM.EventType.CLICK, async () => {
			try {
				await this.vibeAIService.updateAutomation(this.resolveProjectRoot(), automation.id, { enabled: !automation.enabled });
			} catch { /* re-render shows the truth */ }
			void this.renderAutomationsPage();
		}));
		const deleteBtn = DOM.append(actions, $('button.vibe-ai-agents-auto-delete')) as HTMLButtonElement;
		deleteBtn.textContent = localize('vibeAIAgentsHub.autoDelete', "Delete");
		this.paneDisposables.add(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, async () => {
			try {
				await this.vibeAIService.deleteAutomation(this.resolveProjectRoot(), automation.id);
			} catch { /* re-render shows the truth */ }
			void this.renderAutomationsPage();
		}));
	}

	/** Phase 189: the New Automation form — name, prompt, trigger, model binding. */
	private renderAutomationForm(container: HTMLElement): void {
		const models = this.modelStore.list().filter(m => !m.disabled);
		const root = this.resolveProjectRoot();
		const form = DOM.append(container, $('.vibe-ai-agents-auto-form-body'));

		const nameInput = DOM.append(form, $('input.vibe-ai-agents-auto-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.spellcheck = false;
		nameInput.placeholder = localize('vibeAIAgentsHub.autoNamePh', "Name — e.g. Nightly test sweep");

		const promptInput = DOM.append(form, $('textarea.vibe-ai-agents-auto-prompt')) as HTMLTextAreaElement;
		promptInput.rows = 4;
		promptInput.spellcheck = false;
		promptInput.placeholder = localize('vibeAIAgentsHub.autoPromptPh', "What the agent should do every time this fires…");

		const row = DOM.append(form, $('.vibe-ai-agents-auto-form-row'));
		const triggerSelect = DOM.append(row, $('select.vibe-ai-agents-auto-input')) as HTMLSelectElement;
		for (const [value, label] of <const>[
			['manual', localize('vibeAIAgentsHub.autoTrigManual', "Manual (Run now)")],
			['interval', localize('vibeAIAgentsHub.autoTrigEveryLabel', "Every N minutes")],
			['daily', localize('vibeAIAgentsHub.autoTrigDailyLabel', "Daily at…")],
			['git_commit', localize('vibeAIAgentsHub.autoTrigGitLabel', "On git commit")],
		]) {
			const option = DOM.append(triggerSelect, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
		}
		const intervalInput = DOM.append(row, $('input.vibe-ai-agents-auto-input.vibe-ai-agents-auto-cond')) as HTMLInputElement;
		intervalInput.type = 'number';
		intervalInput.min = '1';
		intervalInput.max = '1440';
		intervalInput.value = '30';
		intervalInput.title = localize('vibeAIAgentsHub.autoEveryTitle', "Minutes between runs (1–1440)");
		intervalInput.style.display = 'none';
		const dailyInput = DOM.append(row, $('input.vibe-ai-agents-auto-input.vibe-ai-agents-auto-cond')) as HTMLInputElement;
		dailyInput.type = 'time';
		dailyInput.value = '09:00';
		dailyInput.style.display = 'none';

		const modelSelect = DOM.append(row, $('select.vibe-ai-agents-auto-input')) as HTMLSelectElement;
		models.forEach((model, index) => {
			const option = DOM.append(modelSelect, $('option')) as HTMLOptionElement;
			option.value = String(index);
			option.textContent = model.name || model.modelId;
		});
		if (!models.length) {
			const option = DOM.append(modelSelect, $('option')) as HTMLOptionElement;
			option.value = '';
			option.textContent = localize('vibeAIAgentsHub.autoNoModel', "No model configured (Settings → Models)");
			modelSelect.disabled = true;
		}

		const errorEl = DOM.append(form, $('.vibe-ai-agents-auto-form-error'));
		const actions = DOM.append(form, $('.vibe-ai-agents-auto-form-actions'));
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-agents-auto-cancel')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAIAgentsHub.autoCancel', "Cancel");
		this.paneDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this.automationFormOpen = false;
			void this.renderAutomationsPage();
		}));
		const createBtn = DOM.append(actions, $('button.vibe-ai-agents-auto-create')) as HTMLButtonElement;
		createBtn.textContent = localize('vibeAIAgentsHub.autoCreate', "Create Automation");
		if (!root) {
			createBtn.disabled = true;
			errorEl.textContent = localize('vibeAIAgentsHub.autoNoProject', "Open a project folder first — automations live in the project.");
		}

		const syncConditional = () => {
			intervalInput.style.display = triggerSelect.value === 'interval' ? '' : 'none';
			dailyInput.style.display = triggerSelect.value === 'daily' ? '' : 'none';
		};
		this.paneDisposables.add(DOM.addStandardDisposableListener(triggerSelect, DOM.EventType.CHANGE, syncConditional));

		this.paneDisposables.add(DOM.addDisposableListener(createBtn, DOM.EventType.CLICK, async () => {
			errorEl.textContent = '';
			const name = nameInput.value.trim();
			const prompt = promptInput.value.trim();
			if (!name || !prompt) {
				errorEl.textContent = localize('vibeAIAgentsHub.autoNeedNamePrompt', "Name and prompt are required.");
				return;
			}
			const ttype = triggerSelect.value as IVibeAIAutomationTrigger['type'];
			const everyMinutes = Number.parseInt(intervalInput.value, 10);
			const trigger: IVibeAIAutomationTrigger = {
				type: ttype,
				everyMinutes: ttype === 'interval' ? (Number.isFinite(everyMinutes) ? everyMinutes : 0) : undefined,
				dailyAt: ttype === 'daily' ? dailyInput.value : undefined,
			};
			const modelIndex = Number.parseInt(modelSelect.value, 10);
			const model = Number.isFinite(modelIndex) ? models[modelIndex] : undefined;
			const provider = model ? this.modelStore.resolveProvider(model) : undefined;
			createBtn.disabled = true;
			try {
				await this.vibeAIService.createAutomation(root, { name, prompt, trigger, provider });
				this.automationFormOpen = false;
				await this.renderAutomationsPage();
			} catch (e) {
				createBtn.disabled = false;
				errorEl.textContent = e instanceof Error ? e.message : String(e);
			}
		}));
	}

	// ==================== Customize page (r17, Cursor parity) ====================

	/**
	 * r17: the sidebar's Customize row renders the manage page (Rules /
	 * Skills / MCP) in the center canvas — like Cursor's Customize tab —
	 * instead of swapping to the Settings editor tab. Click the row again
	 * (or New Chat / opening a thread) returns to the conversation view.
	 */
	private setCustomizeMode(on: boolean): void {
		if (this.customizeActive === on) {
			return;
		}
		this.customizeActive = on;
		this.customizeFormOpen = false;
		this.root?.classList.toggle('cx-open', on);
		this.customizeRowEl?.classList.toggle('active', on);
		// Phase 189: one center canvas — Customize replaces the Automations
		// page when it opens (the guard above makes the round-trip safe).
		if (on && this.automationsActive) {
			this.setAutomationsMode(false);
		}
		if (this.customizeEl) {
			this.customizeEl.style.display = on ? '' : 'none';
		}
		if (on) {
			// r20: the manage page replaces the conversation — close the panel.
			this.toggleContextPanel(false);
			// r29: the manage page replaces the conversation — the file pane goes too.
			this.closeHubFilePane();
			if (this.chatTitleEl) {
				this.chatTitleEl.innerText = '';
			}
			this.renderCustomizePage();
		} else {
			// r21: leaving Customize forgets the marketplace view — the next
			// entry opens the manage page.
			this.customizeMarketOpen = false;
			if (this.selectedSessionId) {
				this.renderConversation(); // restores the topbar title + follow-up composer
			}
		}
	}

	/** r17: the page chrome — search + Browse Marketplace + kind pills — then the list. */
	private renderCustomizePage(): void {
		if (this.customizeMarketOpen) {
			this.renderMarketplacePage();
			return;
		}
		if (!this.customizeEl) {
			return;
		}
		this.customizeEl.innerText = '';
		const top = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-top'));
		const search = DOM.append(top, $('input.vibe-ai-agents-cx-search')) as HTMLInputElement;
		search.type = 'text';
		search.spellcheck = false;
		search.placeholder = localize('vibeAIAgentsHub.cxSearch', "Search Rules, Skills, MCPs...");
		search.value = this.customizeSearch;
		this.paneDisposables.add(DOM.addStandardDisposableListener(search, DOM.EventType.INPUT, () => {
			this.customizeSearch = search.value;
			this.renderCustomizeList();
		}));
		const browse = DOM.append(top, $('button.vibe-ai-agents-cx-market')) as HTMLButtonElement;
		browse.textContent = localize('vibeAIAgentsHub.cxMarket', "Browse Marketplace");
		// r21: opens the bundled marketplace (searchable, one-click add) —
		// the honest local counterpart of Cursor's directory.
		this.paneDisposables.add(DOM.addDisposableListener(browse, DOM.EventType.CLICK, () => {
			this.customizeMarketOpen = true;
			this.renderCustomizePage();
		}));
		const pills = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-pills'));
		const pillLabels: Record<VibeAICustomizeKind, string> = {
			rules: localize('vibeAIAgentsHub.cxTabRules', "Rules"),
			skills: localize('vibeAIAgentsHub.cxTabSkills', "Skills"),
			mcp: localize('vibeAIAgentsHub.cxTabMcp', "MCP"),
		};
		for (const kind of ['rules', 'skills', 'mcp'] as const) {
			const pill = DOM.append(pills, $('button.vibe-ai-agents-cx-pill')) as HTMLButtonElement;
			pill.textContent = pillLabels[kind];
			pill.classList.toggle('active', this.customizeKind === kind);
			this.paneDisposables.add(DOM.addDisposableListener(pill, DOM.EventType.CLICK, () => {
				if (this.customizeKind === kind) {
					return;
				}
				this.customizeKind = kind;
				this.customizeFormOpen = false;
				this.renderCustomizePage();
			}));
		}
		this.customizeListEl = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-list'));
		this.renderCustomizeList();
	}

	/**
	 * r21: the bundled marketplace — same chrome as the manage page (search
	 * + kind pills) with a Back button; cards carry one-click Add buttons
	 * that create the entry through the normal customizeCreate backend.
	 */
	private renderMarketplacePage(): void {
		if (!this.customizeEl) {
			return;
		}
		this.customizeEl.innerText = '';
		const top = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-top'));
		const search = DOM.append(top, $('input.vibe-ai-agents-cx-search')) as HTMLInputElement;
		search.type = 'text';
		search.spellcheck = false;
		search.placeholder = localize('vibeAIAgentsHub.mktSearch', "Search the marketplace...");
		search.value = this.customizeSearch;
		this.paneDisposables.add(DOM.addStandardDisposableListener(search, DOM.EventType.INPUT, () => {
			this.customizeSearch = search.value;
			this.renderMarketplaceList();
		}));
		const back = DOM.append(top, $('button.vibe-ai-agents-cx-market')) as HTMLButtonElement;
		back.textContent = localize('vibeAIAgentsHub.mktBack', "Back");
		this.paneDisposables.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => {
			this.customizeMarketOpen = false;
			this.renderCustomizePage();
		}));
		const pills = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-pills'));
		const pillLabels: Record<VibeAICustomizeKind, string> = {
			rules: localize('vibeAIAgentsHub.cxTabRules', "Rules"),
			skills: localize('vibeAIAgentsHub.cxTabSkills', "Skills"),
			mcp: localize('vibeAIAgentsHub.cxTabMcp', "MCP"),
		};
		for (const kind of ['rules', 'skills', 'mcp'] as const) {
			const pill = DOM.append(pills, $('button.vibe-ai-agents-cx-pill')) as HTMLButtonElement;
			pill.textContent = pillLabels[kind];
			pill.classList.toggle('active', this.customizeKind === kind);
			this.paneDisposables.add(DOM.addDisposableListener(pill, DOM.EventType.CLICK, () => {
				if (this.customizeKind === kind) {
					return;
				}
				this.customizeKind = kind;
				for (const sibling of pills.children) {
					sibling.classList.toggle('active', (sibling as HTMLElement).textContent === pillLabels[kind]);
				}
				this.renderMarketplaceList();
			}));
		}
		this.customizeListEl = DOM.append(this.customizeEl, $('.vibe-ai-agents-cx-list'));
		this.renderMarketplaceList();
	}

	/** r21: renders the catalog cards for the active kind (search-filtered). */
	private renderMarketplaceList(): void {
		const list = this.customizeListEl;
		if (!list) {
			return;
		}
		list.innerText = '';
		const q = this.customizeSearch.trim().toLowerCase();
		const entries = MARKETPLACE_CATALOG.filter(entry => entry.kind === this.customizeKind
			&& (!q || entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q)));
		if (entries.length === 0) {
			DOM.append(list, $('.vibe-ai-agents-cx-empty')).textContent = localize('vibeAIAgentsHub.mktEmpty', "No matches in the catalog.");
			return;
		}
		// r25: same as the form — project presence comes from resolveProjectRoot,
		// not the workspace (the agent window never has folders).
		const projectName = this.projectDisplayName();
		for (const entry of entries) {
			const card = DOM.append(list, $('.vibe-ai-agents-cx-card'));
			const dot = DOM.append(card, $('span.vibe-ai-agents-cx-dot'));
			dot.classList.add('codicon', entry.kind === 'rules' ? 'codicon-note' : entry.kind === 'skills' ? 'codicon-zap' : 'codicon-plug', 'icon');
			const main = DOM.append(card, $('.vibe-ai-agents-cx-main'));
			DOM.append(main, $('.vibe-ai-agents-cx-title')).textContent = entry.name;
			DOM.append(main, $('.vibe-ai-agents-cx-desc')).textContent = entry.description;
			const actions = DOM.append(card, $('.vibe-ai-agents-cx-actions'));
			const addBtn = DOM.append(actions, $('button.vibe-ai-agents-cx-market-add')) as HTMLButtonElement;
			const key = `${entry.kind}:${entry.name}`;
			if (this.marketAdded.has(key)) {
				addBtn.disabled = true;
				addBtn.textContent = localize('vibeAIAgentsHub.mktAdded', "Added");
				continue;
			}
			addBtn.textContent = localize('vibeAIAgentsHub.mktAdd', "Add");
			addBtn.title = projectName
				? localize('vibeAIAgentsHub.mktAddProject', "Add to project ({0})", projectName)
				: localize('vibeAIAgentsHub.mktAddGlobal', "Add globally (no folder open)");
			this.paneDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => {
				addBtn.disabled = true;
				this.vibeAIService.customizeCreate(entry.kind, {
					name: entry.name,
					scope: projectName ? 'project' : 'global',
					...(entry.description ? { description: entry.description } : {}),
					...(entry.content !== undefined ? { content: entry.content } : {}),
					...(entry.command ? { command: entry.command } : {}),
					...(entry.args ? { args: entry.args } : {}),
					...(entry.kind === 'rules' ? { alwaysApply: true } : {}),
				}, this.resolveProjectRoot()).then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAIAgentsHub.mktAddFailed', "Adding failed"));
						addBtn.disabled = false;
						return;
					}
					this.marketAdded.add(key);
					addBtn.textContent = localize('vibeAIAgentsHub.mktAdded', "Added");
					this.notificationService.info(localize('vibeAIAgentsHub.mktAddedNote', "{0} added — it is in your {1} list now.", entry.name, entry.kind));
				}).catch(() => {
					addBtn.disabled = false;
					this.notificationService.error(localize('vibeAIAgentsHub.mktAddFailed', "Adding failed"));
				});
			}));
		}
	}

	/** r17: fetches the merged dual-scope list and renders it (search-filtered). */
	private renderCustomizeList(): void {
		const list = this.customizeListEl;
		if (!list) {
			return;
		}
		list.innerText = '';
		// r21: the create form renders ABOVE a dedicated items container and
		// is NOT rebuilt by the async refresh — the response only re-renders
		// items, so opening the form (and typing in it) survives the fetch.
		if (this.customizeFormOpen) {
			this.renderCustomizeForm(list);
		}
		const itemsEl = DOM.append(list, $('.vibe-ai-agents-cx-items'));
		DOM.append(itemsEl, $('.vibe-ai-agents-cx-empty')).textContent = '…';
		const kind = this.customizeKind;
		this.vibeAIService.customizeList(kind, this.resolveProjectRoot()).then(items => {
			if (!itemsEl.isConnected || this.customizeKind !== kind) {
				return; // the page / tab switched while the request was in flight
			}
			itemsEl.innerText = '';
			const q = this.customizeSearch.trim().toLowerCase();
			const filtered = q
				? items.filter(i => i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q))
				: items;
			if (kind === 'mcp') {
				this.renderMcpSections(filtered, itemsEl);
			} else if (filtered.length === 0) {
				DOM.append(itemsEl, $('.vibe-ai-agents-cx-empty')).textContent = localize('vibeAIAgentsHub.cxEmpty', "Nothing here yet.");
			} else {
				for (const item of filtered) {
					this.renderCustomizeCard(kind, item, itemsEl);
				}
			}
			this.renderCustomizeNewRow(itemsEl);
		}).catch(error => {
			if (!itemsEl.isConnected) {
				return;
			}
			itemsEl.innerText = '';
			const failed = DOM.append(itemsEl, $('.vibe-ai-agents-cx-empty'));
			failed.textContent = localize('vibeAIAgentsHub.cxLoadFailed', "Failed to load — check the backend connection.");
			failed.title = String(error);
		});
	}

	/** r17: MCP rows grouped like Cursor — Needs Attention / Connected / the rest. */
	private renderMcpSections(items: IVibeAICustomizeItem[], list: HTMLElement): void {
		const needs = items.filter(i => i.status === 'failed');
		const connected = items.filter(i => i.status === 'connected');
		const idle = items.filter(i => i.status !== 'failed' && i.status !== 'connected');
		if (items.length === 0) {
			DOM.append(list, $('.vibe-ai-agents-cx-empty')).textContent = localize('vibeAIAgentsHub.cxEmpty', "Nothing here yet.");
			return;
		}
		if (needs.length > 0) {
			this.renderCxSectionLabel(list, localize('vibeAIAgentsHub.cxNeedsAttention', "Needs Attention"), needs.length);
			for (const item of needs) {
				this.renderCustomizeCard('mcp', item, list);
			}
		}
		if (connected.length > 0) {
			this.renderCxSectionLabel(list, localize('vibeAIAgentsHub.cxConnected', "Connected"), connected.length);
			for (const item of connected) {
				this.renderCustomizeCard('mcp', item, list);
			}
		}
		if (idle.length > 0) {
			this.renderCxSectionLabel(list, localize('vibeAIAgentsHub.cxIdle', "Not connected"), idle.length);
			for (const item of idle) {
				this.renderCustomizeCard('mcp', item, list);
			}
		}
	}

	private renderCxSectionLabel(list: HTMLElement, label: string, count: number): void {
		const section = DOM.append(list, $('.vibe-ai-agents-cx-section'));
		DOM.append(section, $('span')).textContent = label;
		DOM.append(section, $('span.vibe-ai-agents-cx-section-count')).textContent = String(count);
	}

	/**
	 * r17: one entry card — status dot (MCP) / kind icon, name + scope
	 * badge, meta line; actions: MCP toggle + reload, open file, delete.
	 */
	private renderCustomizeCard(kind: VibeAICustomizeKind, item: IVibeAICustomizeItem, container: HTMLElement): void {
		const scope: VibeAICustomizeScope = item.origin === 'global' ? 'global' : 'project';
		const card = DOM.append(container, $('.vibe-ai-agents-cx-card' + (item.enabled === false ? '.off' : '')));
		const dot = DOM.append(card, $('span.vibe-ai-agents-cx-dot'));
		if (kind === 'mcp') {
			dot.classList.add(item.status === 'connected' ? 'ok' : item.status === 'failed' ? 'fail' : 'off');
		} else {
			dot.classList.add('codicon', kind === 'rules' ? 'codicon-note' : 'codicon-zap', 'icon');
		}
		const main = DOM.append(card, $('.vibe-ai-agents-cx-main'));
		const title = DOM.append(main, $('.vibe-ai-agents-cx-title'));
		DOM.append(title, $('span.vibe-ai-agents-cx-name')).textContent = item.name;
		const badge = DOM.append(title, $('span.vibe-ai-agents-cx-scope'));
		badge.classList.add(item.origin === 'global' ? 'global' : 'project');
		badge.textContent = item.origin === 'global'
			? localize('vibeAIAgentsHub.cxScopeGlobal', "Global")
			: localize('vibeAIAgentsHub.cxScopeProject', "Project");
		const meta: string[] = [];
		if (item.description) {
			meta.push(item.description);
		}
		if (kind === 'mcp') {
			if (item.status === 'connected') {
				meta.push(localize('vibeAIAgentsHub.cxTools', "{0} tools enabled", item.toolCount ?? 0));
			} else if (item.status === 'failed' && item.error) {
				meta.push(item.error);
			} else if (item.status === 'disabled') {
				meta.push(localize('vibeAIAgentsHub.cxDisabled', "Disabled"));
			}
		}
		if (kind === 'rules') {
			meta.push(item.alwaysApply
				? localize('vibeAIAgentsHub.cxRuleAlways', "always apply")
				: (item.globs?.length ? `globs: ${item.globs.join(', ')}` : localize('vibeAIAgentsHub.cxRuleOnDemand', "on demand")));
		}
		if (kind === 'skills' && item.disableModelInvocation) {
			meta.push(localize('vibeAIAgentsHub.cxSkillManual', "/name only"));
		}
		if (meta.length > 0) {
			DOM.append(main, $('.vibe-ai-agents-cx-desc')).textContent = meta.join(' · ');
		}
		const actions = DOM.append(card, $('.vibe-ai-agents-cx-actions'));
		if (kind === 'mcp') {
			// --- enable toggle (writes + hot-reloads, like the Settings page)
			const toggle = DOM.append(actions, $('.vibe-ai-agents-cx-switch'));
			toggle.classList.toggle('checked', item.enabled !== false);
			toggle.title = item.enabled !== false
				? localize('vibeAIAgentsHub.cxEnabledTip', "Enabled — click to disable")
				: localize('vibeAIAgentsHub.cxDisabledTip', "Disabled — click to enable");
			this.paneDisposables.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
				void this.vibeAIService.customizeToggle('mcp', item.name, scope, this.resolveProjectRoot()).then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAIAgentsHub.cxToggleFailed', "Toggle failed"));
						return;
					}
					this.renderCustomizeList();
				});
			}));
			// --- reload & reconnect
			const reloadBtn = DOM.append(actions, $('button.codicon.codicon-refresh.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
			reloadBtn.title = localize('vibeAIAgentsHub.cxReload', "Reload & reconnect");
			reloadBtn.setAttribute('aria-label', reloadBtn.title);
			this.paneDisposables.add(DOM.addDisposableListener(reloadBtn, DOM.EventType.CLICK, () => {
				void this.vibeAIService.reloadMcp().then(result => {
					if (!result.ok) {
						this.notificationService.error(result.error ?? localize('vibeAIAgentsHub.cxReloadFailed', "Reload failed"));
					}
					this.renderCustomizeList();
				});
			}));
		}
		// --- open the definition file
		const openBtn = DOM.append(actions, $('button.codicon.codicon-go-to-file.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		openBtn.title = localize('vibeAIAgentsHub.cxOpenFile', "Open file");
		openBtn.setAttribute('aria-label', openBtn.title);
		if (!item.path) {
			openBtn.disabled = true;
		} else {
			this.paneDisposables.add(DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, () => {
				// Phase 225: editing intent (the definition file) — bypass the
				// markdown Preview default resolver.
				void this.editorService.openEditor({ resource: URI.file(item.path), options: { override: DEFAULT_EDITOR_ASSOCIATION.id } });
			}));
		}
		// --- delete from the row's own scope
		const deleteBtn = DOM.append(actions, $('button.codicon.codicon-trash.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
		deleteBtn.title = localize('vibeAIAgentsHub.cxDelete', "Delete");
		deleteBtn.setAttribute('aria-label', deleteBtn.title);
		this.paneDisposables.add(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, () => {
			void this.vibeAIService.customizeDelete(kind, item.name, scope, this.resolveProjectRoot()).then(result => {
				if (!result.ok) {
					this.notificationService.error(result.error ?? localize('vibeAIAgentsHub.cxDeleteFailed', "Delete failed"));
					return;
				}
				this.renderCustomizeList();
			});
		}));
	}

	/** r17: the "+ New …" card at the bottom of the list (opens the inline form). */
	private renderCustomizeNewRow(list: HTMLElement): void {
		const label = this.customizeKind === 'mcp'
			? {
				title: localize('vibeAIAgentsHub.cxNewMcp', "New MCP Server"),
				desc: localize('vibeAIAgentsHub.cxNewMcpDesc', "Add a Custom MCP Server"),
			}
			: this.customizeKind === 'rules'
				? {
					title: localize('vibeAIAgentsHub.cxNewRule', "New Rule"),
					desc: localize('vibeAIAgentsHub.cxNewRuleDesc', "Add a project or global rule (.mdc)"),
				}
				: {
					title: localize('vibeAIAgentsHub.cxNewSkill', "New Skill"),
					desc: localize('vibeAIAgentsHub.cxNewSkillDesc', "Add a SKILL.md package"),
				};
		const row = DOM.append(list, $('button.vibe-ai-agents-cx-new')) as HTMLButtonElement;
		DOM.append(row, $('span.codicon.codicon-add'));
		const text = DOM.append(row, $('.vibe-ai-agents-cx-new-text'));
		DOM.append(text, $('span.vibe-ai-agents-cx-new-title')).textContent = label.title;
		DOM.append(text, $('span.vibe-ai-agents-cx-new-desc')).textContent = label.desc;
		this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
			this.customizeFormOpen = true;
			this.renderCustomizeList();
		}));
	}

	/**
	 * r17: the inline create form (same payload as the Settings pages).
	 * r23 (user: 「mcp 肯定是 json 格式優先」): the MCP form is a
	 * mcpServers JSON editor (Cursor parity) — the standard config shape
	 * users already have from other tools; the JSON keys carry
	 * name/command/args/env.
	 */
	private renderCustomizeForm(list: HTMLElement): void {
		const kind = this.customizeKind;
		const card = DOM.append(list, $('.vibe-ai-agents-cx-card.form'));
		DOM.append(card, $('.vibe-ai-agents-cx-form-title')).textContent = localize('vibeAIAgentsHub.cxAddTitle', "Add {0}", kind === 'mcp' ? 'MCP Server' : kind === 'rules' ? 'Rule' : 'Skill');
		const err = DOM.append(card, $('span.vibe-ai-agents-cx-form-err'));
		err.style.display = 'none';

		const row1 = DOM.append(card, $('.vibe-ai-agents-cx-form-row'));
		const scopeSel = DOM.append(row1, $('select.vibe-ai-agents-cx-input')) as HTMLSelectElement;
		// r25: the agent window runs on a neutral workspace (no folders) —
		// resolve the project like every customize call does and show its name.
		const projectName = this.projectDisplayName();
		const projectOpt = DOM.append(scopeSel, $('option')) as HTMLOptionElement;
		projectOpt.value = 'project';
		projectOpt.textContent = projectName
			? localize('vibeAIAgentsHub.cxScopeProjectName', "Project ({0})", projectName)
			: localize('vibeAIAgentsHub.cxScopeProjectNoFolder', "Project (no folder open)");
		projectOpt.disabled = !projectName;
		const globalOpt = DOM.append(scopeSel, $('option')) as HTMLOptionElement;
		globalOpt.value = 'global';
		globalOpt.textContent = localize('vibeAIAgentsHub.cxScopeGlobalTip', "Global (every workspace)");
		scopeSel.value = projectName ? 'project' : 'global';

		let nameIn: HTMLInputElement | undefined;
		let descIn: HTMLInputElement | undefined;
		let contentTa: HTMLTextAreaElement | undefined;
		let jsonTa: HTMLTextAreaElement | undefined;
		if (kind !== 'mcp') {
			nameIn = DOM.append(row1, $('input.vibe-ai-agents-cx-input')) as HTMLInputElement;
			nameIn.placeholder = localize('vibeAIAgentsHub.cxFieldName', "Name");
			descIn = DOM.append(card, $('input.vibe-ai-agents-cx-input')) as HTMLInputElement;
			descIn.placeholder = localize('vibeAIAgentsHub.cxFieldDesc', "Description (optional)");
			contentTa = DOM.append(card, $('textarea.vibe-ai-agents-cx-input')) as HTMLTextAreaElement;
			contentTa.rows = 6;
			contentTa.spellcheck = false;
			contentTa.placeholder = localize('vibeAIAgentsHub.cxFieldContent', "Content (Markdown body)");
		} else {
			jsonTa = DOM.append(card, $('textarea.vibe-ai-agents-cx-input.vibe-ai-agents-cx-json')) as HTMLTextAreaElement;
			jsonTa.rows = 8;
			jsonTa.spellcheck = false;
			jsonTa.value = MCP_JSON_TEMPLATE;
		}

		const actions = DOM.append(card, $('.vibe-ai-agents-cx-form-actions'));
		const saveBtn = DOM.append(actions, $('button.vibe-ai-agents-cx-save')) as HTMLButtonElement;
		saveBtn.textContent = localize('vibeAIAgentsHub.cxSave', "Save");
		const cancelBtn = DOM.append(actions, $('button.vibe-ai-agents-cx-cancel')) as HTMLButtonElement;
		cancelBtn.textContent = localize('vibeAIAgentsHub.cxCancel', "Cancel");
		const showMsg = (message: string): void => {
			err.textContent = message;
			err.style.display = 'block';
		};
		this.paneDisposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this.customizeFormOpen = false;
			this.renderCustomizeList();
		}));
		this.paneDisposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, async () => {
			if (kind === 'mcp') {
				await this.saveMcpJsonForm(
					jsonTa!.value,
					scopeSel.value as VibeAICustomizeScope,
					saveBtn,
					showMsg,
					() => {
						this.customizeFormOpen = false;
						this.renderCustomizeList();
					}
				);
				return;
			}
			const name = nameIn!.value.trim();
			if (!name) {
				showMsg(localize('vibeAIAgentsHub.cxNameRequired', "Name is required."));
				return;
			}
			const data: IVibeAICustomizeCreateData = {
				name,
				scope: scopeSel.value as VibeAICustomizeScope,
				...(descIn?.value.trim() ? { description: descIn.value.trim() } : {}),
				...(contentTa?.value.trim() ? { content: contentTa.value } : {}),
			};
			saveBtn.disabled = true;
			const result = await this.vibeAIService.customizeCreate(kind, data, this.resolveProjectRoot());
			saveBtn.disabled = false;
			if (!result.ok) {
				showMsg(result.error ?? localize('vibeAIAgentsHub.cxCreateFailed', "Create failed."));
				return;
			}
			this.customizeFormOpen = false;
			this.renderCustomizeList();
		}));
	}

	/**
	 * r23: parses the MCP form's mcpServers JSON — the wrapped Cursor /
	 * claude_desktop shape `{ "mcpServers": { … } }`, or a bare
	 * name → config map — and creates every entry through the same backend
	 * payload the old field form built. The first failure surfaces in the
	 * form (earlier servers stay created).
	 */
	private async saveMcpJsonForm(raw: string, scope: VibeAICustomizeScope, saveBtn: HTMLButtonElement, showMsg: (message: string) => void, done: () => void): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			showMsg(localize('vibeAIAgentsHub.cxJsonInvalid', "Invalid JSON — check the syntax and try again."));
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
			showMsg(localize('vibeAIAgentsHub.cxJsonNoServers', "No servers found — the JSON needs a \"mcpServers\" object."));
			return;
		}
		const batch: IVibeAICustomizeCreateData[] = [];
		for (const [name, cfg] of Object.entries(servers)) {
			const config = (cfg ?? {}) as Record<string, unknown>;
			const command = typeof config.command === 'string' ? config.command.trim() : '';
			if (!name.trim() || !command) {
				showMsg(localize('vibeAIAgentsHub.cxJsonServerInvalid', "Each server needs a name and a \"command\" (e.g. npx, python)."));
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
			const result = await this.vibeAIService.customizeCreate('mcp', entry, this.resolveProjectRoot());
			saveBtn.disabled = false;
			if (!result.ok) {
				showMsg(localize('vibeAIAgentsHub.cxJsonCreateFailed', "Failed to create \"{0}\": {1}", entry.name, result.error ?? localize('vibeAIAgentsHub.cxCreateFailed', "Create failed.")));
				return;
			}
		}
		done();
	}

	/**
	 * Tears the inline message-edit card down (Esc or a press outside it) —
	 * the card restores its static text and the stored message is untouched.
	 */
	private cancelMessageEdit(): void {
		this.editingMessage = undefined;
		this.editingAttachments = undefined;
		this.editingAttRow = undefined;
		this.renderConversation();
	}

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
			if (this.chatTitleEl) {
				this.chatTitleEl.innerText = '';
			}
			this.setFollowUpMode(false);
			return;
		}
		this.chatEl.style.display = '';
		this.setFollowUpMode(true);
		// r13: the thread title + its actions render into the top bar.
		if (this.chatTitleEl) {
			this.chatTitleEl.innerText = '';
			DOM.append(this.chatTitleEl, $('span.vibe-ai-agents-chat-title')).textContent = session.title || localize('vibeAIAgentsHub.chatUntitled', "New conversation");
			const openIde = DOM.append(this.chatTitleEl, $('button.codicon.codicon-link-external.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
			openIde.title = localize('vibeAIAgentsHub.chatOpenIde', "Continue this conversation in the IDE");
			openIde.setAttribute('aria-label', openIde.title);
			const fresh = session;
			this.paneDisposables.add(DOM.addDisposableListener(openIde, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.handOffSessionToIde(fresh);
			}));
			const close = DOM.append(this.chatTitleEl, $('button.codicon.codicon-close.vibe-ai-agents-icon-btn')) as HTMLButtonElement;
			close.title = localize('vibeAIAgentsHub.chatClose', "Collapse conversation");
			close.setAttribute('aria-label', close.title);
			this.paneDisposables.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.selectedSessionId = undefined;
				this.renderConversation();
				this.renderSessions();
			}));
		}
		const body = DOM.append(this.chatEl, $('.vibe-ai-agents-chat-body'));
		session.messages.forEach((message, index) => {
			// Phase 181 r9 (user: 抄 Cursor 的對話後樣子): user turns render
			// as a plain full-width card; agent turns as document-style
			// markdown (no bubble) with a copy affordance — Cursor's thread
			// view, not a chat bubble list.
			if (message.role === 'user') {
				const row = DOM.append(body, $('.vibe-ai-agents-chat-msg.user'));
				// r15/r19: click the sent card itself to edit inline (Cursor
				// parity — ⤶ affordance sits at the card's right); saving
				// truncates the conversation and re-runs the turn.
				if (this.editingMessage && this.editingMessage.sessionId === session.id && this.editingMessage.index === index) {
					// r28: the edit card IS the composer — the exact same classes
					// (.vibe-ai-agents-composer / -input / -bar) so it looks and
					// behaves exactly like the composer below (完完全全一模一樣),
					// including the same model chip (picks sync, see registerModelChip).
					const box = DOM.append(row, $('.vibe-ai-agents-composer.vibe-ai-agents-chat-edit-box'));
					// Phase 184: the edit card carries the message's own
					// attachment set — chips sit above the input (composer
					// parity); adding/removing re-renders ONLY this row so the
					// textarea's in-progress text survives.
					const attRow = DOM.append(box, $('.vibe-ai-agents-att-row'));
					attRow.style.display = 'none';
					this.editingAttRow = attRow;
					this.renderEditingAttRow();
					const ta = DOM.append(box, $('textarea.vibe-ai-agents-composer-input.vibe-ai-agents-chat-edit-input')) as HTMLTextAreaElement;
					ta.value = message.content;
					ta.rows = 1;
					this.paneDisposables.add(DOM.addDisposableListener(ta, DOM.EventType.PASTE, e => {
						if (this.editingAttachments) {
							this.handleHubImagePaste(e, this.editingAttachments.images, () => this.renderEditingAttRow());
						}
					}));
					const bar = DOM.append(box, $('.vibe-ai-agents-composer-bar.vibe-ai-agents-chat-edit-bar'));
					const addBtn = DOM.append(bar, $('button.codicon.codicon-add.vibe-ai-agents-add')) as HTMLButtonElement;
					addBtn.title = localize('vibeAIAgentsHub.attachContext', "Attach file context");
					addBtn.setAttribute('aria-label', addBtn.title);
					this.paneDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => { this.attachFileContext('edit'); }));
					const modelBtn = DOM.append(bar, $('button.vibe-ai-agents-model')) as HTMLButtonElement;
					this.registerModelChip(modelBtn);
					const micBtn = DOM.append(bar, $('button.codicon.codicon-mic.vibe-ai-agents-mic')) as HTMLButtonElement;
					micBtn.title = localize('vibeAIAgentsHub.voice', "Voice input");
					micBtn.setAttribute('aria-label', micBtn.title);
					this.paneDisposables.add(DOM.addDisposableListener(micBtn, DOM.EventType.CLICK, () => { this.toggleVoiceInput(micBtn, ta); }));
					const send = DOM.append(bar, $('button.codicon.codicon-arrow-up.vibe-ai-agents-send')) as HTMLButtonElement;
					send.title = localize('vibeAIAgentsHub.editApply', "Save and resend");
					send.setAttribute('aria-label', send.title);
					const submit = () => { this.submitMessageEdit(session, index, ta.value); };
					this.paneDisposables.add(DOM.addDisposableListener(send, DOM.EventType.CLICK, e => { DOM.EventHelper.stop(e, true); submit(); }));
					this.paneDisposables.add(DOM.addStandardDisposableListener(ta, DOM.EventType.KEY_DOWN, (e: StandardKeyboardEvent) => {
						if (e.equals(KeyCode.Enter)) {
							e.preventDefault();
							submit();
						} else if (e.equals(KeyCode.Escape)) {
							e.preventDefault();
							this.cancelMessageEdit();
						}
					}));
					setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
					return;
				}
			DOM.append(row, $('span.vibe-ai-agents-chat-role')).textContent = localize('vibeAIAgentsHub.chatYou', "You");
			// Phase 184: the message carries its attachments — thumbnails +
			// file chips above the text card (IDE pane parity).
			this.renderHubUserAttachments(row, message);
			const card = DOM.append(row, $('div.vibe-ai-agents-chat-text.vibe-ai-agents-msg-card'));
			card.textContent = this.clipMessage(message.content);
			// r28: the ⤶ affordance is gone — the card itself is the edit
			// entry (Cursor parity; the side icon read as a stray button).
			this.paneDisposables.add(DOM.addDisposableListener(card, DOM.EventType.CLICK, e => {
					DOM.EventHelper.stop(e, true);
					// The click of the gesture that just closed an edit card
					// (outside press) must not open this card's edit — the user
					// asked for exit, not for the edit to hop to another message.
					if (this.editClickSuppressed) {
						return;
					}
					if (this.hubTurns.has(session.id)) {
						this.notificationService.warn(localize('vibeAIAgentsHub.turnBusy', "The agent is still working on this conversation — please wait for it to finish."));
						return;
					}
					this.editingMessage = { sessionId: session.id, index };
					// Phase 184: the edit seeds its OWN attachment set from the
					// message (IDE prompt-edit parity) — copies, so canceling
					// leaves the stored message untouched.
					this.editingAttachments = {
						files: (message.files ?? []).map(file => ({ ...file })),
						images: [...(message.images ?? [])],
					};
					this.renderConversation();
				}));
				return;
			}
			const row = DOM.append(body, $('.vibe-ai-agents-chat-msg.assistant'));
			const meta = DOM.append(row, $('.vibe-ai-agents-chat-meta'));
			DOM.append(meta, $('span.vibe-ai-agents-chat-role')).textContent = localize('vibeAIAgentsHub.chatAgent', "Agent");
			// r20: the persisted working trace — a collapsed "Worked for Xs"
			// row above the answer (Cursor parity; the user re-opens the
			// native <details> to see the tool steps).
			if (message.worked && message.worked.steps.length > 0) {
				const shell = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
				const summary = DOM.append(shell, $('summary'));
				const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-chevron'));
				chevron.setAttribute('aria-hidden', 'true');
				const label = DOM.append(summary, $('span'));
				const duration = getDurationString(message.worked.durationMs ?? 0);
				label.textContent = workedCountsSuffix(message.worked.steps)
					? localize('vibeAIAgentsHub.workedFor', "Worked for {0} · {1}", duration, workedCountsSuffix(message.worked.steps))
					: localize('vibeAIAgentsHub.workedForPlain', "Worked for {0}", duration);
				const stepsEl = DOM.append(shell, $('.vibe-ai-worked-steps'));
				for (const step of message.worked.steps) {
					this.appendWorkedStepRow(stepsEl, step);
				}
			}
			const textEl = DOM.append(row, $('div.vibe-ai-agents-chat-text.vibe-ai-chat-markdown'));
			this.renderHubMarkdown(message.content, false, textEl);
			// r28: IDE-parity turn footer — the copy button sits BELOW the
			// answer (pane .vibe-ai-turn-footer), not up in the meta row.
			// r31: the ↺ 撤回 joins it (pane .codicon-discard parity). The
			// hub records no file changes, so the rollback drops this turn
			// and everything after it from the conversation and puts the
			// prompt back in the composer (a live run ignores it).
			const footer = DOM.append(row, $('.vibe-ai-turn-footer'));
			const undoBtn = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-discard')) as HTMLButtonElement;
			undoBtn.title = localize('vibeAIAgentsHub.checkpointRestore', "Undo — remove this turn and everything after, and put the prompt back");
			undoBtn.setAttribute('aria-label', undoBtn.title);
			this.paneDisposables.add(DOM.addDisposableListener(undoBtn, DOM.EventType.CLICK, () => {
				if (this.hubTurns.has(session.id)) {
					this.notificationService.warn(localize('vibeAIAgentsHub.turnBusy', "The agent is still working on this conversation — please wait for it to finish."));
					return;
				}
				const cutIndex = index > 0 && session.messages[index - 1].role === 'user' ? index - 1 : index;
				const cut = session.messages[cutIndex];
				const prompt = cut?.role === 'user' ? cut.content : '';
				// Phase 184: the cut prompt's attachments return to the
				// composer with its text (the resend can re-edit the set).
				if (cut?.role === 'user') {
					for (const img of cut.images ?? []) {
						if (this.hubImages.length >= HUB_MAX_ATTACHED_IMAGES) {
							break;
						}
						if (!this.hubImages.includes(img)) {
							this.hubImages.push(img);
						}
					}
					for (const file of cut.files ?? []) {
						if (!this.hubFiles.some(existing => existing.path === file.path)) {
							this.hubFiles.push({ ...file });
						}
					}
					this.renderHubAttachmentChips();
				}
				this.sessionStore.save(session.id, session.messages.slice(0, cutIndex), this.contextLimit);
				if (this.composerInput) {
					this.composerInput.value = prompt;
				}
				this.renderConversation();
			}));
			const copyBtn = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-copy')) as HTMLButtonElement;
			copyBtn.title = localize('vibeAIAgentsHub.copyAnswer', "Copy response");
			copyBtn.setAttribute('aria-label', copyBtn.title);
			this.paneDisposables.add(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, () => {
				navigator.clipboard?.writeText(message.content);
			}));
			DOM.append(footer, $('span.spacer'));
		});
		// r12: the in-flight run streams into a live block at the end of
		// the transcript (spinner + state + growing answer).
		const live = this.hubTurns.get(session.id);
		if (live) {
			const block = DOM.append(body, $('.vibe-ai-agents-chat-msg.assistant.live'));
			const meta = DOM.append(block, $('.vibe-ai-agents-chat-meta'));
			DOM.append(meta, $('span.codicon.codicon-loading.vibe-ai-agents-chat-spin'));
			const status = DOM.append(meta, $('span.vibe-ai-agents-chat-state'));
			status.textContent = this.hubTurnStatusLabel(live);
			live.statusEl = status;
			// r20: the live Worked shell (open while streaming — Cursor
			// parity) shows the steps captured so far; tool events repaint it.
			if (live.steps.length > 0) {
				const shell = DOM.append(block, $('details.vibe-ai-worked')) as HTMLDetailsElement;
				shell.open = true;
				const summary = DOM.append(shell, $('summary'));
				const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-chevron'));
				chevron.setAttribute('aria-hidden', 'true');
				DOM.append(summary, $('span')).textContent = localize('vibeAIAgentsHub.workingLabel', "Working…");
				live.stepsEl = DOM.append(shell, $('.vibe-ai-worked-steps'));
				this.renderHubLiveSteps(live);
			}
			// r14: streaming body = the pane's streaming look (pulsing caret).
			const textEl = DOM.append(block, $('div.vibe-ai-agents-chat-text.vibe-ai-chat-markdown.vibe-ai-streaming'));
			live.textEl = textEl;
			this.renderHubLiveText(live, true);
		}
		body.scrollTop = body.scrollHeight;
	}

	/** r20: repaints the live Worked steps (running spinner / ok check / error). */
	private renderHubLiveSteps(turn: VibeAIHubLiveTurn): void {
		if (!turn.stepsEl) {
			return;
		}
		DOM.clearNode(turn.stepsEl);
		for (const step of turn.steps) {
			this.appendWorkedStepRow(turn.stepsEl, step);
		}
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
	private toggleVoiceInput(micBtn: HTMLButtonElement, target?: HTMLTextAreaElement): void {
		const input = target ?? this.composerInput;
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
			if (text && input) {
				const current = input.value;
				input.value = current && !current.endsWith(' ') ? `${current} ${text.trim()}` : current + text.trim();
				input.focus();
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

	// ==================== in-window agent runs (r12) ====================

	/**
	 * r12: sends the composer text as a live conversation in THIS window —
	 * a fresh send creates (and expands) a session; a follow-up appends to
	 * the expanded one. The agent loop streams from the backend into the
	 * center transcript; nothing jumps to the IDE. Model routing mirrors
	 * the chat pane (Settings → Models / Auto pool).
	 */
	private sendInAgentWindow(text: string, files: IVibeAIFileContext[] = [], images: string[] = []): void {
		const existing = this.selectedSessionId
			? this.sessionStore.list().find(s => s.id === this.selectedSessionId)
			: undefined;
		const sessionId = existing?.id ?? generateUuid();
		// One turn at a time per conversation (the backend's steer gate is
		// pane-driven; the hub keeps it simple and refuses politely).
		if (this.hubTurns.has(sessionId)) {
			this.notificationService.warn(localize('vibeAIAgentsHub.turnBusy', "The agent is still working on this conversation — please wait for it to finish."));
			if (this.composerInput) {
				this.composerInput.value = text;
			}
			// Phase 184: a refused send puts the chips back on the composer.
			this.hubFiles.push(...files);
			this.hubImages.push(...images);
			this.renderHubAttachmentChips();
			return;
		}
		// Phase 184: the message carries its attachments — the thread
		// restores the sent chips and the edit card re-edits the set.
		const messages: IVibeAIMessage[] = [...(existing?.messages ?? []), {
			role: 'user',
			content: text,
			...(images.length > 0 ? { images } : {}),
			...(files.length > 0 ? { files } : {}),
		}];
		this.sessionStore.save(sessionId, messages, undefined, undefined, 'agent', undefined, this.resolveProjectRoot());
		this.selectedSessionId = sessionId;
		this.startHubTurn(sessionId, messages);
	}

	/**
	 * r15: an edited sent message is saved in place and the conversation
	 * after it is discarded (Cursor-parity edit & resubmit) — the agent
	 * turn then re-runs from that point.
	 */
	private submitMessageEdit(session: IVibeAIChatSession, index: number, text: string): void {
		this.editingMessage = undefined;
		const attachments = this.editingAttachments;
		this.editingAttachments = undefined;
		this.editingAttRow = undefined;
		const trimmed = text.trim();
		if (!trimmed) {
			this.renderConversation();
			return;
		}
		const original = session.messages[index];
		const images = attachments?.images ?? [];
		const files = attachments?.files ?? [];
		// Phase 184: the edit's own attachment set replaces the message's —
		// removals stick (the readonly fields force the explicit rebuild;
		// a spread would carry stale keys when every chip came off).
		const edited: { -readonly [K in keyof IVibeAIMessage]: IVibeAIMessage[K] } = { ...original, content: trimmed };
		if (images.length > 0) {
			edited.images = images;
		} else {
			delete edited.images;
		}
		if (files.length > 0) {
			edited.files = files;
		} else {
			delete edited.files;
		}
		const messages = [...session.messages.slice(0, index), edited];
		this.sessionStore.save(session.id, messages, undefined, undefined, 'agent', undefined, this.resolveProjectRoot());
		this.selectedSessionId = session.id;
		this.startHubTurn(session.id, messages);
	}

	/**
	 * r12/r15: dispatches an agent turn for the conversation in THIS window —
	 * model routing mirrors the chat pane (Settings → Models / Auto pool);
	 * no usable model fails fast with a notification. Shared by the composer
	 * send and the edited-message resend.
	 */
	private startHubTurn(sessionId: string, messages: IVibeAIMessage[]): void {
		if (this.hubTurns.has(sessionId)) {
			this.notificationService.warn(localize('vibeAIAgentsHub.turnBusy', "The agent is still working on this conversation — please wait for it to finish."));
			return;
		}
		// Model routing resolves BEFORE the turn opens — same gate as the
		// chat pane: no usable model fails fast with a notification.
		const selection = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		const configured = selection !== 'Auto' ? this.modelStore.get(selection) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		const autoPool = selection === 'Auto' ? this.buildAutoPool() : undefined;
		if (selection === 'Auto' ? (autoPool?.length ?? 0) === 0 : !configured || !provider) {
			this.notificationService.warn(VIBE_AI_NO_MODEL_MESSAGE);
			this.renderConversation();
			this.renderSessions();
			return;
		}
		const autoMode = this.configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
		// Phase 184: the LAST user message's attachments drive this turn —
		// its images ride the request messages (the backend reads
		// messages[-1].images) and its files go as context.files (the
		// orchestrator's _build_context_note), matching the chat pane's
		// request shape.
		const lastUser = [...messages].reverse().find(m => m.role === 'user');
		const turnFiles = lastUser?.files ?? [];
		const request: IVibeAIChatRequest = {
			messages: messages.map(m => ({ role: m.role, content: m.content, ...(m.images && m.images.length > 0 ? { images: m.images } : {}) })),
			stream: true,
			sessionId,
			permissionMode: this.configurationService.getValue<string>('vibeAI.agent.permissionMode') || undefined,
			workspaceRoot: this.resolveProjectRoot(),
			...(turnFiles.length > 0 ? { context: { files: turnFiles } } : {}),
			...(selection === 'Auto'
				? { model: 'auto', autoPool: autoPool!, autoMode }
				: { model: configured!.modelId, ...(provider ? { provider } : {}) }),
		};
		const turn: VibeAIHubLiveTurn = {
			sessionId,
			text: '',
			state: 'thinking',
			toolName: undefined,
			error: undefined,
			smoothedAt: 0,
			smoothTimer: undefined,
			thinkingStartedAt: undefined,
			thinking: '',
			statusEl: undefined,
			textEl: undefined,
			startedAt: Date.now(),
			steps: [],
			stepsEl: undefined,
		};
		this.hubTurns.set(sessionId, turn);
		liveTurns.set(sessionId, { state: turn.state, lastEventAt: Date.now() });
		this.renderConversation();
		this.renderSessions();
		const requestId = `vibe-hub-${++this.hubRequestCounter}`;
		this.vibeAIService.agentStream(requestId, request).catch(err => {
			this.logService.error('[vibeAI] hub agent stream rejected', err);
		});
	}

	/** Phase 70 Auto routing pool — the same assembly as the chat pane's. */
	private buildAutoPool(): IVibeAIModelProvider[] {
		const pool: IVibeAIModelProvider[] = [];
		for (const model of this.modelStore.list()) {
			if (model.disabled) {
				continue;
			}
			const provider = this.modelStore.resolveProvider(model);
			if (!provider) {
				continue; // connection gone — the router can't use it
			}
			pool.push({
				...provider,
				tier: model.tier && model.tier !== 'auto' ? model.tier : undefined,
			});
		}
		return pool;
	}

	/**
	 * r12: stream events for a conversation this window is running. Text
	 * deltas grow the live transcript block (r22: smoothed pump paint);
	 * state/tool events refresh the status row; done/error persists the
	 * assistant message into the session store.
	 */
	private handleHubTurnEvent(turn: VibeAIHubLiveTurn, data: IVibeAIStreamData): void {
		switch (data.type) {
			case 'text':
				// r24: the answer text closes an open thinking round first —
				// the round lands as a "Thought for Xs" step in the Worked rows.
				this.closeHubThinkingStep(turn);
				turn.text += data.text ?? '';
				this.renderHubLiveText(turn);
				return;
			case 'thinking':
				// r24: thinking leaves a trace — the round's wall clock starts
				// on the first delta (closeHubThinkingStep settles it).
				// r27: the deltas themselves ride the Thought step (expandable).
				if (!turn.state || turn.state === 'thinking') {
					turn.state = 'thinking';
				}
				if (turn.thinkingStartedAt === undefined) {
					turn.thinkingStartedAt = Date.now();
				}
				turn.thinking += data.text ?? '';
				break;
			case 'tool_start':
				this.closeHubThinkingStep(turn);
				turn.state = 'executing_tools';
				turn.toolName = data.tool?.name ?? turn.toolName;
				// r20: capture the step (the live + persisted Worked rows).
				// r24: the row carries the call's target (path/command/pattern).
				if (turn.toolName) {
					turn.steps.push({ name: turn.toolName, status: 'running', detail: this.toolStepDetail(data.tool?.arguments) });
					// First step: build the live Worked shell (renderConversation
					// binds live.stepsEl; later steps just repaint the rows).
					if (turn.steps.length === 1 && this.selectedSessionId === turn.sessionId) {
						this.renderConversation();
					}
				}
				break;
			case 'tool_result': {
				turn.state = 'executing_tools';
				turn.toolName = undefined;
				// r20: settle the matching running step (last one wins — ids
				// aren't tracked here, arrival order is).
				const running = [...turn.steps].reverse().find(step => step.status === 'running');
				const status = data.tool?.status === 'error' ? 'error' : 'ok';
				if (running) {
					running.status = status;
				} else if (data.tool?.name) {
					turn.steps.push({ name: data.tool.name, status, detail: this.toolStepDetail(data.tool?.arguments) });
				}
				break;
			}
			case 'turn_state': {
				const state = data.turnState ?? turn.state;
				if (TERMINAL_TURN_STATES.has(state)) {
					this.finishHubTurn(turn);
					return;
				}
				turn.state = state;
				break;
			}
			case 'error':
				turn.error = data.message ?? localize('vibeAIAgentsHub.turnError', "The agent run failed.");
				this.finishHubTurn(turn);
				return;
			case 'done':
				this.finishHubTurn(turn);
				return;
			default:
				return;
		}
		liveTurns.set(turn.sessionId, { state: turn.state, lastEventAt: Date.now() });
		this.renderHubLiveStatus(turn);
	}

	/** Persists the finished turn's answer and repaints transcript + sidebar. */
	private finishHubTurn(turn: VibeAIHubLiveTurn): void {
		// r22: the smoothing pump dies with the live block — the persisted
		// message below replaces it (renderConversation re-renders from the
		// store), so nothing may keep painting into the detached element.
		this.stopHubSmoothPump(turn);
		// r24: a turn that ends right after thinking (no text/tool event
		// followed) still leaves its "Thought for Xs" trace.
		this.closeHubThinkingStep(turn);
		this.hubTurns.delete(turn.sessionId);
		liveTurns.delete(turn.sessionId);
		const session = this.sessionStore.list().find(s => s.id === turn.sessionId);
		if (session) {
			const content = turn.error
				? (turn.text ? `${turn.text}\n\n${turn.error}` : turn.error)
				: turn.text;
			// r20: the turn's working trace rides the assistant message —
			// r24: the detail rides the step (a running step at done = the
			// result event was lost, the call itself completed).
			const steps = turn.steps.map(step => ({ name: step.name, status: step.status === 'running' ? 'ok' : step.status, detail: step.detail, thinking: step.thinking }));
			const worked = steps.length > 0
				? { durationMs: Date.now() - turn.startedAt, steps }
				: undefined;
			if (content.trim()) {
				this.sessionStore.save(turn.sessionId, [...session.messages, { role: 'assistant', content, ...(worked ? { worked } : {}) }]);
			}
		}
		if (this.selectedSessionId === turn.sessionId) {
			this.renderConversation();
			this.refreshHubContextUsage();
		}
		this.renderSessions();
	}

	/** Refreshes the live status row + sidebar spinner (state changed). */
	private renderHubLiveStatus(turn: VibeAIHubLiveTurn): void {
		if (turn.statusEl) {
			turn.statusEl.textContent = this.hubTurnStatusLabel(turn);
		}
		// r20: tool events ride here too — repaint the live Worked steps.
		this.renderHubLiveSteps(turn);
		if (this.selectedSessionId === turn.sessionId) {
			this.renderSessions();
		}
	}

	/**
	 * r22: streams the answer into the live block through a smoothing pump —
	 * deltas accumulate in `turn.text` and a repeating tick paints a few more
	 * characters (proportional catch-up), so bursty arrivals render as a
	 * steady typewriter flow instead of clumps. force paints up to the
	 * current smoothed position immediately (the live shell just rebuilt);
	 * the pump stops when it catches up (the next delta restarts it) and
	 * finishHubTurn cancels it (the persisted message replaces the live
	 * block).
	 */
	private renderHubLiveText(turn: VibeAIHubLiveTurn, force = false): void {
		if (!turn.text) {
			return;
		}
		if (force) {
			this.paintHubLiveText(turn);
			return;
		}
		if (turn.smoothTimer !== undefined) {
			return; // pump already running
		}
		const anchor = turn.textEl ?? this.chatEl;
		if (!anchor) {
			return;
		}
		turn.smoothTimer = DOM.getWindow(anchor).setTimeout(() => {
			turn.smoothTimer = undefined;
			if (!turn.textEl) {
				return; // the conversation view closed / rebuilt under the pump
			}
			const target = turn.text.length;
			if (turn.smoothedAt < target) {
				const backlog = target - turn.smoothedAt;
				turn.smoothedAt = Math.min(
					target,
					turn.smoothedAt + Math.max(SMOOTH_STREAM_MIN_CHARS, Math.ceil(backlog / SMOOTH_STREAM_CATCHUP_DIVISOR))
				);
				this.paintHubLiveText(turn);
			}
			if (turn.smoothedAt < turn.text.length) {
				this.renderHubLiveText(turn);
			}
		}, SMOOTH_STREAM_TICK_MS);
	}

	/** r22: paints the live block up to the pump's smoothed position. */
	private paintHubLiveText(turn: VibeAIHubLiveTurn): void {
		if (!turn.textEl || !turn.text) {
			return;
		}
		turn.textEl.innerText = '';
		this.renderHubMarkdown(turn.text.slice(0, turn.smoothedAt), true, turn.textEl);
		turn.textEl.closest('.vibe-ai-agents-chat-body')?.scrollTo({ top: 999999 });
	}

	/** r22: stops the turn's smoothing pump (turn end / view teardown). */
	private stopHubSmoothPump(turn: VibeAIHubLiveTurn): void {
		if (turn.smoothTimer === undefined) {
			return;
		}
		const anchor = turn.textEl ?? this.chatEl;
		if (anchor) {
			DOM.getWindow(anchor).clearTimeout(turn.smoothTimer);
		}
		turn.smoothTimer = undefined;
	}

	/** The live status row's label for the turn's current state. */
	private hubTurnStatusLabel(turn: VibeAIHubLiveTurn): string {
		if (turn.state === 'executing_tools') {
			return turn.toolName
				? localize('vibeAIAgentsHub.turnTool', "Running {0}…", turn.toolName)
				: localize('vibeAIAgentsHub.turnWorking', "Working…");
		}
		return localize('vibeAIAgentsHub.turnThinking', "Thinking…");
	}

	/**
	 * r24: closes an open thinking round into a "Thought for Xs" step
	 * (user: thinking left no trace in the Worked rows). The next tool or
	 * text event after thinking settles the round; the live rows repaint
	 * here because the text case returns before renderHubLiveStatus.
	 */
	private closeHubThinkingStep(turn: VibeAIHubLiveTurn): void {
		if (turn.thinkingStartedAt === undefined) {
			return;
		}
		const startedAt = turn.thinkingStartedAt;
		turn.thinkingStartedAt = undefined;
		const thinking = turn.thinking.trim();
		turn.thinking = '';
		// r27: heartbeat-only rounds (Phase 94 輪界空心跳 — the model didn't
		// actually think) leave no row, so every visible "Thought for Xs"
		// expands to real text.
		if (!thinking) {
			return;
		}
		turn.steps.push({
			name: localize('vibeAIAgentsHub.thoughtStep', "Thought for {0}", getDurationString(Date.now() - startedAt)),
			status: 'ok',
			thinking,
		});
		this.renderHubLiveSteps(turn);
	}

	/**
	 * r24: the call's target for a Worked step row (user: 「比如 read_file
	 * xxx.py」) — the first informative string of the parsed arguments
	 * (grep shows its pattern, run_terminal its command, the rest their
	 * path). Sanitized to a single line, capped at 80 chars.
	 * r27: the backend emits `arguments` as the PARSED object (orchestrator
	 * yields the json.loads dict) — tolerate the raw JSON string too
	 * (vibeAIChatPane.terminalCommandFromArgs precedent).
	 */
	private toolStepDetail(rawArguments: unknown): string | undefined {
		if (!rawArguments) {
			return undefined;
		}
		let args: Record<string, unknown>;
		if (typeof rawArguments === 'string') {
			try {
				const parsed: unknown = JSON.parse(rawArguments);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return undefined;
				}
				args = parsed as Record<string, unknown>;
			} catch {
				return undefined;
			}
		} else if (typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
			args = rawArguments as Record<string, unknown>;
		} else {
			return undefined;
		}
		for (const key of ['command', 'pattern', 'query', 'url', 'rule', 'skill', 'path']) {
			const value = args[key];
			if (typeof value === 'string' && value.trim()) {
				const detail = value.replace(/\s+/g, ' ').trim();
				return detail.length > 80 ? `${detail.slice(0, 80)}…` : detail;
			}
		}
		return undefined;
	}

	/**
	 * r24: one Worked step row — status icon, tool name, dimmed target.
	 * r27: a step carrying thinking renders as an expandable details row
	 * (Cursor parity: "Thought for Xs" opens to the round's text).
	 */
	private appendWorkedStepRow(stepsEl: HTMLElement, step: { name: string; status?: string; detail?: string; thinking?: string }): void {
		const container = step.thinking
			? DOM.append(stepsEl, $('details.vibe-ai-agents-worked-thought'))
			: DOM.append(stepsEl, $('.vibe-ai-agents-worked-step'));
		const stepRow = step.thinking
			? DOM.append(container, $('summary.vibe-ai-agents-worked-step'))
			: container;
		const icon = DOM.append(stepRow, $('span.codicon'));
		if (step.status === 'running') {
			icon.classList.add('codicon-loading', 'vibe-ai-agents-chat-spin');
		} else {
			icon.classList.add(step.status === 'error' ? 'codicon-error' : 'codicon-check', step.status === 'error' ? 'vibe-ai-agents-worked-fail' : 'vibe-ai-agents-worked-ok');
		}
		DOM.append(stepRow, $('span')).textContent = step.name;
		if (step.detail) {
			DOM.append(stepRow, $('span.vibe-ai-agents-worked-detail')).textContent = step.detail;
		}
		if (step.thinking) {
			DOM.append(stepRow, $('span.codicon.codicon-chevron-right.vibe-ai-agents-worked-thought-caret'));
			DOM.append(container, $('div.vibe-ai-agents-worked-thought-text')).textContent = step.thinking;
		}
	}

	/** Transcript clip limit (shared by the persisted and live paths). */
	private clipMessage(value: string): string {
		return value.length > 20000 ? `${value.substring(0, 20000)}…` : value;
	}

	/**
	 * r14: the chat pane's answer rendering, verbatim — same MarkdownString
	 * flags, same render options (tokenized code blocks with header bar via
	 * EditorMarkdownCodeBlockRenderer) and the same body class
	 * (`vibe-ai-chat-markdown`, styled by vibeAIChat.css), so agent-window
	 * answers look exactly like IDE chat answers. Streaming passes
	 * fillInIncompleteTokens like the pane does.
	 */
	private renderHubMarkdown(text: string, streaming: boolean, el: HTMLElement): void {
		try {
			this.markdownRendererService.render(
				new MarkdownString(this.clipMessage(text), { isTrusted: true, supportThemeIcons: true, supportHtml: true }),
				{
					fillInIncompleteTokens: streaming,
					codeBlockHeader: true,
					// Phase 192: shell-family fences (powershell etc.) tokenize
					// with the bash-proven shellscript grammar, same as the
					// chat pane (shared const — see vibeAIChatPane.ts).
					languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES,
					codeBlockRenderer: (languageId, value, rawInfo) =>
						this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true, languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES }, rawInfo),
				},
				el,
			);
			if (!streaming) {
				// r29: finished renders get file chips — inline code naming
				// a real local file becomes clickable (opens in the right pane).
				this.enhanceHubFileChips(el);
			}
		} catch {
			el.textContent = text;
		}
	}

	private enhanceHubFileChips(el: HTMLElement): void {
		enhanceFileChips(el, {
			fileService: this.fileService,
			resolveRoot: () => this.resolveProjectRoot() ?? this.contextService.getWorkspace().folders[0]?.uri.fsPath,
			onOpen: (fsPath, display) => this.openHubFilePane(fsPath, display),
			onMissing: (_fsPath, display) => {
				this.notificationService.warn(localize('vibeAIAgentsHub.fileChipMissing', "{0} no longer exists on disk — it was deleted or removed by a rollback.", display));
			},
		});
	}

	/**
	 * r29: opens a local file in the right-side expansion area — the chat
	 * column narrows and the pane shows the file next to the thread.
	 * r30: the pane is tabbed; a file gets (or reuses) a file tab.
	 */
	private openHubFilePane(fsPath: string, display: string): void {
		if (!this.root) {
			return;
		}
		let id = this.fpTabs.find(t => t.kind === 'file' && t.fsPath === fsPath)?.id;
		if (!id) {
			id = `f${++this.fpTabSeq}`;
			this.fpTabs.push({ kind: 'file', id, fsPath, display });
		}
		this.root.classList.add('file-open');
		this.root.classList.remove('pane-collapsed');
		this.activateFpTab(id);
	}

	/** r30: opens (or re-activates) the embedded-browser tab, Cursor's "+" new tab. */
	private openFpBrowserTab(): void {
		if (!this.root) {
			return;
		}
		let id = this.fpTabs.find(t => t.kind === 'browser')?.id;
		if (!id) {
			id = `b${++this.fpTabSeq}`;
			this.fpTabs.push({ kind: 'browser', id });
		}
		this.root.classList.add('file-open');
		this.activateFpTab(id);
	}

	/** r30: opens (or re-activates) the terminal tab. */
	private openFpTerminalTab(): void {
		if (!this.root) {
			return;
		}
		let id = this.fpTabs.find(t => t.kind === 'terminal')?.id;
		if (!id) {
			id = `t${++this.fpTabSeq}`;
			this.fpTabs.push({ kind: 'terminal', id });
		}
		this.root.classList.add('file-open');
		this.activateFpTab(id);
	}

	private activateFpTab(id: string): void {
		this.fpActiveId = id;
		this.renderFpTabs();
		const body = this.fpBodyEl;
		if (!body) {
			return;
		}
		body.innerText = '';
		const tab = this.fpTabs.find(t => t.id === id);
		if (!tab) {
			return;
		}
		if (tab.kind === 'file') {
			this.renderFpFile(body, tab);
		} else if (tab.kind === 'browser') {
			this.renderFpBrowser(body);
		} else {
			void this.renderFpTerminal(body);
		}
	}

	private closeFpTab(id: string): void {
		if (this.fpTabs.find(t => t.id === id)?.kind === 'terminal') {
			this.fpTerminal?.dispose();
			this.fpTerminal = undefined;
		}
		this.fpTabs = this.fpTabs.filter(t => t.id !== id);
		if (this.fpActiveId === id) {
			const next = this.fpTabs[this.fpTabs.length - 1];
			if (next) {
				this.activateFpTab(next.id);
				return;
			}
			this.closeHubFilePane();
			return;
		}
		this.renderFpTabs();
	}

	private renderFpTabs(): void {
		const strip = this.fpTabsEl;
		if (!strip) {
			return;
		}
		strip.innerText = '';
		for (const tab of this.fpTabs) {
			const tabEl = DOM.append(strip, tab.id === this.fpActiveId ? $('div.vibe-ai-agents-fp-tab.active') : $('div.vibe-ai-agents-fp-tab'));
			const icon = tab.kind === 'file' ? 'codicon-file' : tab.kind === 'browser' ? 'codicon-globe' : 'codicon-terminal';
			// r33: DOM.append treats a plain string as a text node — $() creates the element.
			DOM.append(tabEl, $(`span.codicon.${icon}`));
			const label = DOM.append(tabEl, $('span.vibe-ai-agents-fp-tab-label'));
			if (tab.kind === 'file') {
				// r33: tabs show only the file name; the full path rides on the hover tooltip.
				const parts = tab.display.replace(/\\/g, '/').split('/');
				label.textContent = parts[parts.length - 1] || tab.display;
				tabEl.title = tab.display;
			} else if (tab.kind === 'browser') {
				label.textContent = localize('vibeAIAgentsHub.fpBrowser', "Browser");
			} else {
				// r34: show the shell name once the instance reports it.
				label.textContent = this.fpTerminalTitle || localize('vibeAIAgentsHub.fpTerminal', "Terminal");
			}
			const close = DOM.append(tabEl, $('span.codicon.codicon-close.vibe-ai-agents-fp-tab-close'));
			close.title = localize('vibeAIAgentsHub.fpTabClose', "Close tab");
			this.paneDisposables.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, e => {
				e.stopPropagation();
				this.closeFpTab(tab.id);
			}));
			this.paneDisposables.add(DOM.addDisposableListener(tabEl, DOM.EventType.CLICK, () => this.activateFpTab(tab.id)));
		}
		// r30: Cursor's "+" (new browser tab) plus a terminal shortcut.
		const actions = DOM.append(strip, $('.vibe-ai-agents-fp-actions'));
		const addBtn = DOM.append(actions, $('span.codicon.codicon-add.vibe-ai-agents-fp-action'));
		addBtn.title = localize('vibeAIAgentsHub.fpNewTab', "New browser tab");
		this.paneDisposables.add(DOM.addDisposableListener(addBtn, DOM.EventType.CLICK, () => this.openFpBrowserTab()));
		const termBtn = DOM.append(actions, $('span.codicon.codicon-terminal.vibe-ai-agents-fp-action'));
		termBtn.title = localize('vibeAIAgentsHub.fpNewTerminal', "Open terminal");
		this.paneDisposables.add(DOM.addDisposableListener(termBtn, DOM.EventType.CLICK, () => this.openFpTerminalTab()));
	}

	/** r30: one opened file — markdown previews rendered, text as monospace. */
	private renderFpFile(body: HTMLElement, tab: { fsPath: string; display: string }): void {
		const host = DOM.append(body, $('.vibe-ai-agents-fp-file'));
		const myId = tab.fsPath;
		if (/\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|7z|exe|dll|woff2?|ttf|eot|mp[34]|wav|ogg|mov|avi)$/i.test(tab.display)) {
			const note = DOM.append(host, $('div.vibe-ai-agents-file-note'));
			note.textContent = localize('vibeAIAgentsHub.filePaneBinary', "Binary file — open it in the IDE instead.");
			const openBtn = DOM.append(note, $('button.vibe-ai-agents-file-ide')) as HTMLButtonElement;
			openBtn.textContent = localize('vibeAIAgentsHub.filePaneOpenIde', "Open in IDE");
			this.paneDisposables.add(DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, () => {
				void this.commandService.executeCommand('vscode.open', URI.file(tab.fsPath));
			}));
			return;
		}
		void this.fileService.readFile(URI.file(tab.fsPath)).then(content => {
			if (this.fpActiveId !== this.fpTabs.find(t => t.kind === 'file' && t.fsPath === myId)?.id || !host.isConnected) {
				return; // another tab took the pane meanwhile
			}
			const text = content.value.toString();
			const capped = text.length > 200000 ? `${text.slice(0, 200000)}\n…` : text;
			if (/\.md$/i.test(tab.display)) {
				this.renderHubMarkdown(capped, false, host);
			} else {
				// r33: token colors come from the same editor pipeline as answer code
				// blocks — the absolute path rides as the fence info to pick the language.
				this.editorCodeBlockRenderer.renderCodeBlock(undefined, capped, {}, tab.fsPath).then(el => {
					if (this.fpActiveId !== this.fpTabs.find(t => t.kind === 'file' && t.fsPath === myId)?.id || !host.isConnected) {
						return; // another tab took the pane meanwhile
					}
					DOM.append(host, $('pre.vibe-ai-agents-file-pre')).appendChild(el);
				}, () => {
					DOM.append(host, $('pre.vibe-ai-agents-file-pre')).textContent = capped;
				});
			}
		}, () => {
			host.textContent = localize('vibeAIAgentsHub.filePaneReadError', "Could not read this file.");
		});
	}

	/** r30: the embedded browser — URL bar + iframe, or the new-tab page. */
	private renderFpBrowser(body: HTMLElement): void {
		const bar = DOM.append(body, $('.vibe-ai-agents-fp-urlbar'));
		const reload = DOM.append(bar, $('span.codicon.codicon-refresh.vibe-ai-agents-fp-url-action'));
		reload.title = localize('vibeAIAgentsHub.fpReload', "Reload");
		this.paneDisposables.add(DOM.addDisposableListener(reload, DOM.EventType.CLICK, () => {
			const id = this.fpTabs.find(t => t.kind === 'browser')?.id;
			if (id) {
				this.activateFpTab(id);
			}
		}));
		const input = DOM.append(bar, $('input.vibe-ai-agents-fp-url-input')) as HTMLInputElement;
		input.placeholder = localize('vibeAIAgentsHub.fpUrlPlaceholder', "Search or enter URL");
		input.value = this.fpBrowserUrl ?? '';
		this.paneDisposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, e => {
			if ((e as KeyboardEvent).key === 'Enter') {
				this.navigateFpBrowser(input.value.trim());
			}
		}));
		if (this.fpBrowserUrl) {
			const frame = DOM.append(body, $('iframe.vibe-ai-agents-fp-frame')) as HTMLIFrameElement;
			frame.src = this.fpBrowserUrl;
		} else {
			this.renderFpBrowserHome(body);
		}
	}

	private navigateFpBrowser(raw: string): void {
		if (!raw) {
			return;
		}
		const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
		this.fpBrowserUrl = url;
		this.pushBrowserRecent(url);
		const id = this.fpTabs.find(t => t.kind === 'browser')?.id;
		if (id) {
			this.activateFpTab(id);
		}
	}

	/** r30: the new-tab page (Cursor's Browser home) — URL box + Recents. */
	private renderFpBrowserHome(body: HTMLElement): void {
		const home = DOM.append(body, $('.vibe-ai-agents-fp-home'));
		const box = DOM.append(home, $('.vibe-ai-agents-fp-home-box'));
		const input = DOM.append(box, $('input.vibe-ai-agents-fp-home-input')) as HTMLInputElement;
		input.placeholder = localize('vibeAIAgentsHub.fpUrlPlaceholder', "Search or enter URL");
		this.paneDisposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, e => {
			if ((e as KeyboardEvent).key === 'Enter') {
				this.navigateFpBrowser(input.value.trim());
			}
		}));
		DOM.append(home, $('div.vibe-ai-agents-fp-recents-title')).textContent = localize('vibeAIAgentsHub.fpRecents', "Recents");
		for (const recent of this.browserRecents()) {
			const row = DOM.append(home, $('div.vibe-ai-agents-fp-recent'));
			DOM.append(row, $('span.codicon.codicon-browser'));
			DOM.append(row, $('span.vibe-ai-agents-fp-recent-title')).textContent = recent.title;
			DOM.append(row, $('span.vibe-ai-agents-fp-recent-url')).textContent = recent.url;
			this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this.navigateFpBrowser(recent.url)));
		}
	}

	private browserRecents(): { title: string; url: string }[] {
		try {
			return JSON.parse(this.storageService.get(VibeAIAgentsHubPane.BROWSER_RECENTS_STORAGE_KEY, StorageScope.APPLICATION, '[]'));
		} catch {
			return [];
		}
	}

	private pushBrowserRecent(url: string): void {
		let title = url;
		try {
			title = new URL(url).host;
		} catch {
			// keep the raw string as the title
		}
		const recents = [{ title, url }, ...this.browserRecents().filter(r => r.url !== url)].slice(0, 8);
		this.storageService.store(VibeAIAgentsHubPane.BROWSER_RECENTS_STORAGE_KEY, JSON.stringify(recents), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** r30: a real terminal living in the right pane (Cursor parity). */
	private async renderFpTerminal(body: HTMLElement): Promise<void> {
		const host = DOM.append(body, $('.vibe-ai-agents-fp-terminal'));
		if (!this.fpTerminal) {
			const root = this.resolveProjectRoot() ?? this.contextService.getWorkspace().folders[0]?.uri.fsPath;
			this.fpTerminal = await this.terminalService.createTerminal({ cwd: root ? URI.file(root) : undefined });
		}
		const instance = this.fpTerminal;
		instance.attachToElement(host);
		// r34: a terminal stays blank until it is laid out with real pixel
		// dimensions — layout() is also what opens the instance's containerReady
		// barrier and starts the shell process. Track the pane as it resizes.
		instance.setVisible(true);
		const measure = () => {
			const w = host.clientWidth;
			const h = host.clientHeight;
			if (w > 0 && h > 0) {
				instance.layout(new DOM.Dimension(w, h));
			}
		};
		this.fpTerminalObserver?.disconnect();
		this.fpTerminalObserver = new ResizeObserver(measure);
		this.fpTerminalObserver.observe(host);
		measure();
		// r34: Cursor names the terminal tab by shell (e.g. "powershell").
		this.fpTerminalTitleSub?.dispose();
		this.fpTerminalTitle = instance.title;
		this.fpTerminalTitleSub = instance.onTitleChanged(i => {
			this.fpTerminalTitle = i.title;
			this.renderFpTabs();
		});
		this.renderFpTabs();
	}

	private closeHubFilePane(): void {
		this.fpTabs = [];
		this.fpActiveId = undefined;
		this.fpTerminal?.dispose();
		this.fpTerminal = undefined;
		this.fpTerminalObserver?.disconnect();
		this.fpTerminalObserver = undefined;
		this.fpTerminalTitleSub?.dispose();
		this.fpTerminalTitleSub = undefined;
		this.fpTerminalTitle = undefined;
		this.fpBrowserUrl = undefined;
		if (this.filepane) {
			this.filepane.innerText = '';
			this.fpTabsEl = DOM.append(this.filepane, $('.vibe-ai-agents-fp-tabs'));
			this.fpBodyEl = DOM.append(this.filepane, $('.vibe-ai-agents-fp-body'));
		}
		this.root?.classList.remove('file-open');
		this.root?.classList.remove('pane-open');
		this.root?.classList.remove('pane-collapsed');
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
		// r37: list() returns storage order, not recency — find() pinned the
		// window's project to the OLDEST thread's root (a stale test_app
		// shadowed the project actually being worked on). Take the most
		// recently touched thread's root instead.
		const recent = this.sessionStore.list().filter(s => !!s.workspaceRoot).sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (recent?.workspaceRoot) {
			return recent.workspaceRoot;
		}
		const queued = this.storageService.get(AGENT_WINDOW_PROJECT_STORAGE_KEY, StorageScope.APPLICATION);
		if (queued) {
			return queued;
		}
		return this.contextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	/** r25: folder name of the resolved project — Customize scope pickers show
	 * it (Cursor shows the project name) instead of a "no folder" mislabel. */
	private projectDisplayName(): string | undefined {
		const root = this.resolveProjectRoot();
		return root?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || undefined;
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

	/**
	 * Repaints the Repositories list (Cursor's per-repo sidebar rows).
	 * Phase 183 (user: repositories 要像圖三分組，展開預設 2 筆、More +5):
	 * in the agent window each repo expands INLINE like Cursor's sidebar —
	 * its recent conversations render right under the row, the 2 most
	 * recent by default and "More" reveals five more per click. The caret
	 * toggles the group; clicking the row selects the project (composer
	 * target) and expands it. IDE windows and rail search keep plain rows.
	 */
	private renderRepos(): void {
		if (!this.repoListEl) {
			return;
		}
		this.repoListEl.innerText = '';
		const active = this.resolveProjectRoot()?.toLowerCase();
		const groupIntoRepos = this.isAgentWindow && !this.sidebarFilter;
		// r37: bucket the history per project — a session without a root
		// falls under the active project ('' when even that is missing).
		// Pinned first, then most recently updated (same sort as the flat
		// list), so every group shows its newest threads first.
		const activeRoot = this.resolveProjectRoot() ?? '';
		const groups = new Map<string, IVibeAIChatSession[]>();
		if (groupIntoRepos) {
			const sorted = [...this.sessionStore.list()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
			for (const session of sorted) {
				const key = (session.workspaceRoot ?? activeRoot).toLowerCase();
				const bucket = groups.get(key);
				if (bucket) {
					bucket.push(session);
				} else {
					groups.set(key, [session]);
				}
			}
		}
		// Active project first, then by each repo's most recent thread.
		const roots = [...this.knownProjectRoots()].sort((a, b) => {
			if (active && a.toLowerCase() === active) {
				return -1;
			}
			if (active && b.toLowerCase() === active) {
				return 1;
			}
			return (groups.get(b.toLowerCase())?.[0]?.updatedAt ?? 0) - (groups.get(a.toLowerCase())?.[0]?.updatedAt ?? 0);
		});
		for (const root of roots) {
			const key = root.toLowerCase();
			const isOpen = !this.sidebarGroupClosed.has(key);
			const row = DOM.append(this.repoListEl, $('.vibe-ai-agents-repo'));
			if (active && key === active) {
				row.classList.add('active');
			}
			row.title = root;
			if (groupIntoRepos) {
				// The caret expands/collapses the group; selecting the row
				// (below) expands too — like Cursor, selection opens it.
				const caret = DOM.append(row, $('span.codicon.' + (isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right') + '.vibe-ai-agents-repo-caret'));
				this.paneDisposables.add(DOM.addDisposableListener(caret, DOM.EventType.CLICK, e => {
					DOM.EventHelper.stop(e, true);
					if (isOpen) {
						this.sidebarGroupClosed.add(key);
					} else {
						this.sidebarGroupClosed.delete(key);
					}
					this.renderRepos();
				}));
			}
			DOM.append(row, $('span.codicon.codicon-folder'));
			DOM.append(row, $('.vibe-ai-agents-repo-name')).textContent = basename(URI.file(root));
			this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				this.lastOpenedProjectRoot = root;
				this.sidebarGroupClosed.delete(key);
				this.render();
				this.composerInput?.focus();
			}));
			if (groupIntoRepos && isOpen) {
				this.renderRepoThreads(key, groups.get(key) ?? []);
			}
		}
		// Sessions without any root (and no active project) keep a trailing
		// "This window" group so they never vanish from the sidebar.
		const orphan = groups.get('');
		if (groupIntoRepos && orphan?.length) {
			const key = '';
			const isOpen = !this.sidebarGroupClosed.has(key);
			const row = DOM.append(this.repoListEl, $('.vibe-ai-agents-repo'));
			row.title = localize('vibeAIAgentsHub.ungroupedThreads', "This window");
			DOM.append(row, $('span.codicon.' + (isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right') + '.vibe-ai-agents-repo-caret'));
			DOM.append(row, $('span.codicon.codicon-window'));
			DOM.append(row, $('.vibe-ai-agents-repo-name')).textContent = row.title;
			this.paneDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				if (isOpen) {
					this.sidebarGroupClosed.add(key);
				} else {
					this.sidebarGroupClosed.delete(key);
				}
				this.renderRepos();
			}));
			if (isOpen) {
				this.renderRepoThreads(key, orphan);
			}
		}
	}

	/** Phase 183: one repo's inline history — 2 by default, More +5 per click. */
	private renderRepoThreads(key: string, threads: IVibeAIChatSession[]): void {
		const list = DOM.append(this.repoListEl!, $('.vibe-ai-agents-repo-threads'));
		const limit = this.sidebarGroupLimit.get(key) ?? 2;
		for (const session of threads.slice(0, limit)) {
			this.renderSessionRow(session, false, list);
		}
		if (threads.length > limit) {
			const more = DOM.append(list, $('.vibe-ai-agents-thread-more'));
			more.textContent = localize('vibeAIAgentsHub.moreThreads', "More");
			this.paneDisposables.add(DOM.addDisposableListener(more, DOM.EventType.CLICK, () => {
				this.sidebarGroupLimit.set(key, limit + 5);
				this.renderRepos();
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
	/**
	 * r28: the composer's and the edit cards' model chips all register here —
	 * they read the same `vibeAI.chat.model` setting, and refreshModelChips
	 * rewrites every live label after a pick so they stay in lock-step
	 * (user: 連修改選中的模型都要同步).
	 */
	private registerModelChip(btn: HTMLButtonElement): void {
		btn.appendChild(document.createTextNode(this.currentModelLabel()));
		DOM.append(btn, $('span.codicon.codicon-chevron-down'));
		this.modelChips.add(btn);
		this.paneDisposables.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => { this.pickModel(btn); }));
	}

	private refreshModelChips(): void {
		for (const btn of [...this.modelChips]) {
			if (!btn.isConnected) {
				this.modelChips.delete(btn); // transcript re-render orphaned it
				continue;
			}
			btn.innerText = '';
			btn.appendChild(document.createTextNode(this.currentModelLabel()));
			DOM.append(btn, $('span.codicon.codicon-chevron-down'));
		}
	}

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
					// r28: every chip (composer + any open edit card) follows —
					// they all read the same setting, so they stay in lock-step.
					this.refreshModelChips();
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
	 * `@rel/path` to the prompt. r19: target defaults to the composer; the
	 * message-edit card passes its own textarea.
	 */
	/**
	 * Phase 184: attaches a project file as a REAL context chip (IDE pane
	 * parity) instead of inserting an `@path` mention — the quick-pick
	 * lists the project's files, the pick reads the content (clipped) and
	 * the chip lands on the destination set: the composer's pending
	 * attachments (`composer`) or the open edit card's own set (`edit`).
	 */
	private async attachFileContext(dest: 'composer' | 'edit' = 'composer'): Promise<void> {
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
			if (!picked) {
				return;
			}
			const rel = picked.label;
			if (dest === 'edit') {
				const set = this.editingAttachments;
				if (!set || set.files.some(file => file.path === rel)) {
					return;
				}
				set.files.push({ path: rel, content: '' });
				this.renderEditingAttRow();
				void this.readHubFileContent(rel).then(content => {
					const entry = this.editingAttachments?.files.find(file => file.path === rel);
					if (entry) {
						entry.content = content;
					}
				});
				return;
			}
			if (this.hubFiles.some(file => file.path === rel)) {
				return;
			}
			this.hubFiles.push({ path: rel, content: '' });
			this.renderHubAttachmentChips();
			void this.readHubFileContent(rel).then(content => {
				const entry = this.hubFiles.find(file => file.path === rel);
				if (entry) {
					entry.content = content;
				}
			});
		}));
		picker.show();
	}

	/** Phase 184: reads an attached file's content (clipped; unreadable → empty). */
	private async readHubFileContent(rel: string): Promise<string> {
		const root = this.resolveProjectRoot();
		if (!root) {
			return '';
		}
		try {
			const read = await this.fileService.readFile(URI.file(`${root.replace(/[\\/]+$/, '')}/${rel.replace(/\\/g, '/')}`));
			const text = read.value.toString();
			return text.length > HUB_FILE_CONTEXT_MAX_CHARS ? text.substring(0, HUB_FILE_CONTEXT_MAX_CHARS) : text;
		} catch (err) {
			this.logService.warn('[vibeAI] failed to read the attached file', err);
			this.notificationService.warn(localize('vibeAIAgentsHub.attachReadFailed', "\"{0}\" could not be read — it attaches without content.", rel));
			return '';
		}
	}

	/**
	 * Phase 184: image paste on a hub composer surface (the bottom
	 * composer or an open edit card) — image items on the clipboard
	 * attach as thumbnail chips and the native paste is swallowed.
	 * `refresh` re-renders the target's chips row only (never the whole
	 * conversation — an edit card's in-progress text must survive).
	 */
	private handleHubImagePaste(e: ClipboardEvent, targetImages: string[], refresh: () => void): void {
		const items = e.clipboardData?.items;
		if (!items) {
			return;
		}
		const files: File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) {
					files.push(file);
				}
			}
		}
		if (files.length === 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		void this.attachHubImages(files, targetImages, refresh);
	}

	/** Phase 184: reads image files into downscaled data-URL chips (capped). */
	private async attachHubImages(files: File[], targetImages: string[], refresh: () => void): Promise<void> {
		let rejected = false;
		for (const file of files) {
			if (targetImages.length >= HUB_MAX_ATTACHED_IMAGES) {
				rejected = true;
				break;
			}
			try {
				targetImages.push(await readImageAsDataUrl(file));
			} catch (err) {
				this.logService.warn('[vibeAI] failed to read the pasted image', err);
				this.notificationService.error(localize('vibeAIAgentsHub.imageReadFailed', "Failed to read the pasted image — try copying it again."));
			}
		}
		if (rejected) {
			this.notificationService.warn(localize(
				'vibeAIAgentsHub.tooManyImages',
				"At most {0} images can be attached per message.",
				HUB_MAX_ATTACHED_IMAGES
			));
		}
		refresh();
	}

	/** Phase 184: renders the composer's pending attachment chips. */
	private renderHubAttachmentChips(): void {
		if (!this.composerAttRow) {
			return;
		}
		this.renderHubAttachmentChipsInto(this.composerAttRow, this.hubFiles, this.hubImages, this.hubChipListeners, () => this.renderHubAttachmentChips());
	}

	/** Phase 184: re-renders the open edit card's chips row in place. */
	private renderEditingAttRow(): void {
		if (!this.editingAttRow || !this.editingAttachments) {
			return;
		}
		this.renderHubAttachmentChipsInto(this.editingAttRow, this.editingAttachments.files, this.editingAttachments.images, this.editChipListeners, () => this.renderEditingAttRow());
	}

	/**
	 * Phase 184: a sent user message's attachment strip — image thumbnails
	 * + file chips above the text card (same DOM as the IDE pane's
	 * `.vibe-ai-user-attachments`, so the pane styles apply).
	 */
	private renderHubUserAttachments(row: HTMLElement, message: IVibeAIMessage): void {
		const images = message.images ?? [];
		const files = message.files ?? [];
		if (images.length === 0 && files.length === 0) {
			return;
		}
		const strip = DOM.append(row, $('.vibe-ai-user-attachments'));
		for (const dataUrl of images) {
			const img = DOM.append(strip, $('img.vibe-ai-user-image')) as HTMLImageElement;
			img.src = dataUrl;
			img.alt = '';
		}
		for (const file of files) {
			const chip = DOM.append(strip, $('.vibe-ai-user-att-chip'));
			const icon = DOM.append(chip, $('span.codicon' + (file.kind === 'folder' ? '.codicon-symbol-folder' : '.codicon-symbol-file')));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(chip, $('span.vibe-ai-user-att-name'));
			name.textContent = file.path;
			name.title = file.path;
		}
	}

	/**
	 * Phase 184: pending-attachment chips (image tiles + file pills, each
	 * removable) — reuses the pane composer's `.vibe-ai-chip` styles. The
	 * chip sets mutate in place so the caller's captured references stay
	 * live; `listeners.clear()` keeps re-renders from accumulating dead
	 * listeners — callers must pass the row's DEDICATED store (composer →
	 * hubChipListeners, edit card → editChipListeners), never a shared one.
	 */
	private renderHubAttachmentChipsInto(row: HTMLElement, files: IVibeAIFileContext[], images: string[], listeners: DisposableStore, refresh: () => void): void {
		listeners.clear();
		DOM.clearNode(row);
		row.style.display = (images.length > 0 || files.length > 0) ? 'flex' : 'none';
		for (const dataUrl of images) {
			const chip = DOM.append(row, $('.vibe-ai-chip.vibe-ai-image-chip'));
			const img = DOM.append(chip, $('img.vibe-ai-image-chip-thumb')) as HTMLImageElement;
			img.src = dataUrl;
			img.alt = '';
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIAgentsHub.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				const index = images.indexOf(dataUrl);
				if (index >= 0) {
					images.splice(index, 1);
				}
				refresh();
			}));
		}
		for (const file of files) {
			const chip = DOM.append(row, $('.vibe-ai-chip'));
			const icon = DOM.append(chip, $('span.codicon.codicon-symbol-file'));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(chip, $('span.vibe-ai-chip-name'));
			name.textContent = file.path;
			name.title = file.path;
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIAgentsHub.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				const index = files.indexOf(file);
				if (index >= 0) {
					files.splice(index, 1);
				}
				refresh();
			}));
		}
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
