/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { MarkdownRenderOptions } from '../../../../base/browser/markdownRenderer.js';
import { Action, IAction, SubmenuAction } from '../../../../base/common/actions.js';
import { timeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { fromNowByDay, getDurationString } from '../../../../base/common/date.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkdownRendererExtraOptions, IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAIChatRequest, IVibeAICodeChange, IVibeAIContextUsage, IVibeAIExecutePlanRequest, IVibeAIFileContext, IVibeAIMessage, IVibeAIModelProvider, IVibeAIModelRouting, IVibeAIPlan, IVibeAISkill, IVibeAIStreamData, IVibeAIService } from '../../../../platform/vibeAI/common/vibeAI.js';
import { VibeAIChatSessionStore, IVibeAIChatSession, IVibeAIPersistedToolCall, IVibeAIPersistedTurn, IVibeAIPersistedTurnSegment, IVibeAITurnTimelineNode } from './vibeAIChatSessionStore.js';
import { IVibeAIModelConfig, VIBE_AI_NO_MODEL_MESSAGE, VibeAIModelStore } from './vibeAIModelStore.js';
import { computeDiffLines, computeDiffStats } from './vibeAIDiff.js';
import { VibeAIToolCard } from './vibeAIToolCard.js';
import { VibeAIEditorHighlighter } from './vibeAIEditorHighlight.js';
import { IPendingMermaidPart, isMermaidCodeBlock, VibeAIMermaidRenderer } from './vibeAIMermaid.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import './media/vibeAIChat.css';

const $ = DOM.$;

/** Markdown re-render throttle while a stream is running (ms). */
const MARKDOWN_RENDER_THROTTLE_MS = 120;
/**
 * Phase 86: deferred mermaid mount safety net — the asyncRenderCallback is
 * the normal mount trigger, but it only fires once EVERY code block of the
 * render settled; a single never-settling promise (tokenizer, extension
 * activation) used to leave the diagram's holder empty (blank final
 * response). These bounds cap the deferred retries (~3s).
 */
const MERMAID_FLUSH_RETRY_DELAY_MS = 500;
const MERMAID_FLUSH_RETRY_ATTEMPTS = 6;
/** Textarea metrics: 13px font at line-height 1.5 → 19.5px per line (see .vibe-ai-input). */
const INPUT_LINE_HEIGHT_PX = 19.5;
/** Max textarea height before it starts scrolling: 10 text lines (Cursor parity). */
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT_PX * 10;
/** Phase 50: distance from the bottom (px) that still counts as "pinned" for the follow-latest scroll. */
const FOLLOW_LATEST_THRESHOLD_PX = 40;
/** Per-file context payload clip (backend clips to 6000 as well). */
const FILE_CONTEXT_MAX_CHARS = 6000;
/**
 * Phase 84.4: UI-side enforcement of the prompt's narration brevity rule.
 * A narration body folded into the Worked shell (closeTextRun intoWork)
 * longer than this renders its head + an ellipsis — a non-compliant model
 * can still stream a wall of analysis between tool calls, and that text
 * belongs in the thinking blocks anyway. The final answer body
 * (intoWork=false) and the restored answer node never cap.
 */
const NARRATION_MAX_CHARS = 150;
/**
 * Phase 61: max images attached per message (Ctrl+V paste / drag-drop).
 * Cursor-parity generosity with a storage sanity cap.
 */
const MAX_ATTACHED_IMAGES = 6;
/**
 * Phase 61: pasted images downscale to this max edge (px) before
 * attaching — keeps the request payload and the persisted history sane
 * (1568 matches the common vision-model input tile size).
 */
const IMAGE_MAX_EDGE = 1568;
/** Phase 41: default context-window limit (Cursor parity: 200K tokens). */
const DEFAULT_CONTEXT_LIMIT = 200_000;
/** Phase 41: editable context limit clamp range (tokens). */
const CONTEXT_LIMIT_MIN = 100_000;
const CONTEXT_LIMIT_MAX = 1_000_000;
/** Phase 41: context ring geometry — viewBox 20 with r 7.5 → 2πr ≈ 47.12. */
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * 7.5;

/** Phase 41: label + bar color per context usage category (Cursor parity). */
const CONTEXT_PART_STYLES: Record<string, { label: string; color: string }> = {
	systemPrompt: { label: 'System prompt', color: 'var(--vscode-descriptionForeground, #9d9d9d)' },
	toolDefinitions: { label: 'Tool definitions', color: 'var(--vscode-charts-purple, #b180d7)' },
	mcpDynamicTools: { label: 'MCP & dynamic tools', color: '#e35f8a' },
	rules: { label: 'Rules', color: 'var(--vscode-charts-blue, #3794ff)' },
	skills: { label: 'Skills', color: 'var(--vscode-charts-green, #89d185)' },
	filesContext: { label: 'Files & context', color: 'var(--vscode-charts-orange, #d18616)' },
	conversation: { label: 'Conversation', color: '#c55450' },
};

/**
 * Phase 84.4: caps a folded narration body to its head — when over the
 * cap, cuts back to the last sentence/line boundary inside the head (the
 * trim never ends mid-sentence) and appends an ellipsis marker.
 * Prompt-compliant interludes (at or under the cap) pass through
 * untouched.
 */
function capNarrationText(text: string): string {
	if (text.length <= NARRATION_MAX_CHARS) {
		return text;
	}
	const head = text.slice(0, NARRATION_MAX_CHARS);
	let cut = -1;
	for (const ch of ['\n', '。', '！', '？', '!', '?', '；', ';']) {
		cut = Math.max(cut, head.lastIndexOf(ch));
	}
	return (cut >= NARRATION_MAX_CHARS / 2 ? head.slice(0, cut + 1) : head) + ' …';
}

/**
 * Cursor-parity token formatting: "535", "3.6K", "18.7K", "200K", "1M".
 */
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

/**
 * Parses a context-limit value from user input: accepts plain token
 * counts ("200000") and K/M suffixes ("200K", "1.5m", "0.3M").
 */
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
 * Phase 57: mutating tools (file writes + terminal commands) render as
 * inline cards in the thread directly above the answer — always visible,
 * never inside the collapsible activity (reference image parity) — while
 * read-only scans (read/list/search) stay in the collapsible "Worked"
 * activity.
 */
function isMutatingTool(name: string): boolean {
	return name === 'write_file' || name === 'delete_file' || name === 'run_terminal';
}

/**
 * Phase 61: reads a pasted/dropped image File into a data URL, downscaled
 * to {@link IMAGE_MAX_EDGE} on its longest edge (canvas re-encode; PNG is
 * kept for screenshots, JPEG for photos). Oversized/undecodable images
 * resolve to the raw data URL — the attach path is best-effort.
 */
function readImageAsDataUrl(file: File): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result ?? '');
			if (!dataUrl.startsWith('data:image/')) {
				reject(new Error('not an image'));
				return;
			}
			resolve(dataUrl);
		};
		reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
		reader.readAsDataURL(file);
	}).then(dataUrl => downscaleDataUrl(dataUrl));
}

function downscaleDataUrl(dataUrl: string): Promise<string> {
	return new Promise<string>(resolve => {
		const img = new Image();
		img.onload = () => {
			const edge = Math.max(img.width, img.height);
			if (edge <= IMAGE_MAX_EDGE || img.width === 0 || img.height === 0) {
				resolve(dataUrl);
				return;
			}
			const scale = IMAGE_MAX_EDGE / edge;
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(img.width * scale));
			canvas.height = Math.max(1, Math.round(img.height * scale));
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				resolve(dataUrl);
				return;
			}
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			// Keep JPEG for photos (much smaller); PNG for the rest so
			// screenshot text stays sharp.
			resolve(canvas.toDataURL(dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png'));
		};
		// Undecodable (e.g. a format the browser can't draw) — raw data.
		img.onerror = () => resolve(dataUrl);
		img.src = dataUrl;
	});
}

/**
 * Phase 59: collapses a turn's file-change events into one FINAL entry
 * per file — a file written (or deleted) several times in one turn is
 * recorded once, keeping the FIRST event's `oldContent` (the pre-turn
 * baseline) and the LAST event's `newContent`. The files summary then
 * shows only the final modification result (one row per file with the
 * net diff badge) instead of one row per write, and Discard / the
 * per-turn undo / checkpoint rollback converge to the original content
 * with a single restore per file. A file created and deleted again
 * within the same turn is dropped entirely (net change: nothing).
 * Entries keep last-modified order (a re-written file moves to the
 * end) so the summary's Review still opens the most recently changed
 * file.
 */
function consolidateChanges(changes: IVibeAICodeChange[]): IVibeAICodeChange[] {
	const byPath = new Map<string, IVibeAICodeChange>();
	for (const change of changes) {
		if (!change.filePath) {
			continue;
		}
		const existing = byPath.get(change.filePath);
		if (!existing) {
			byPath.set(change.filePath, { ...change });
			continue;
		}
		// Re-insert at the end — the summary keeps last-modified order.
		byPath.delete(change.filePath);
		if (change.action === 'delete' && existing.action === 'create') {
			// Created and deleted again in this turn — net change is
			// nothing, so the file leaves the summary.
			continue;
		}
		let action = change.action ?? existing.action;
		if (change.action === 'delete') {
			// The file ends up gone — the delete wins over earlier writes.
			action = 'delete';
		} else if (change.action === 'create' || existing.action === 'create') {
			// Still new to this turn — Discard deletes it again.
			action = 'create';
		}
		byPath.set(change.filePath, {
			...existing,
			newContent: change.newContent ?? existing.newContent,
			action,
		});
	}
	return Array.from(byPath.values());
}

/**
 * A streamed assistant turn as rendered in the view. `thinking` is kept
 * separate from `text` because only `text` is persisted into the
 * conversation history sent back to the backend with the next request.
 */
interface StreamedTurn {
	text: string;
	thinking: string;
}

/**
 * Phase 71 (Plan mode, Cursor parity): the chat mode three-way — Ask
 * (read-only tools), Agent (full tools) and Plan (research → structured
 * plan → user approval → step-by-step execution).
 */
type VibeAIChatMode = 'ask' | 'agent' | 'plan';

/**
 * Phase 71 (Plan mode): a plan card's lifecycle. `awaiting` = the plan
 * was produced and waits for the user's approval (Build / Cancel);
 * `executing` = approved, the execute phase streams into the same turn.
 */
type VibeAIPlanCardStatus = 'awaiting' | 'executing' | 'executed' | 'cancelled';

/**
 * Live state of one running stream turn (Phase 44: one per conversation,
 * so several tabs can stream in parallel): the requestId the backend
 * events are routed by, the accumulated turn text/thinking, the in-flight
 * turn's DOM refs and the markdown render throttle. Hung on
 * {@link VibeAIConversation.stream} and torn down per conversation, so a
 * finished/aborted stream never pollutes another tab's thread.
 */
interface VibeAIStreamState {
	requestId: string;
	turn: StreamedTurn;

	// --- in-flight turn DOM (only set while the turn is open)
	// Phase 60: these are the CURRENT block run's refs — each contiguous
	// thinking/text/tool run builds its own block at the row end; the refs
	// reset when the run closes and the next run creates fresh blocks.
	thinkingDetails: HTMLDetailsElement | undefined;
	thinkingLabel: HTMLElement | undefined;
	thinkingText: HTMLElement | undefined;
	// Phase 50: the thinking text window auto-opens once on the first delta
	// of its run (a ~10-line-high view of the latest reasoning); a manual
	// collapse after that sticks — the flag makes the auto-open one-shot
	// per run (reset when the next Thought block opens).
	thinkingAutoOpened?: boolean;
	// Wall clock when the current thinking run opened — its "Thought for
	// Xs" label uses the run's own duration, not the whole turn's.
	thinkingRunStartedAt: number | undefined;
	// Char offset into `turn.thinking` where the current run began — the
	// run's text window renders only its own slice.
	thinkingRunStart: number;
	// Phase 61: ONE "Worked for Xs" block per turn (Cursor parity) — the
	// turn's whole activity (thinking runs, tool cards, narration steps)
	// collapses under a single collapsible. Created lazily on the turn's
	// first tool_start; a thinking-only turn never creates one (those stay
	// as plain "Thought for Xs" blocks).
	workShell: HTMLDetailsElement | undefined;
	// The shell's steps container — every activity element lands here in
	// arrival order (thinking sub-blocks, tool cards, narration bodies).
	workSteps: HTMLElement | undefined;
	workLabel: HTMLElement | undefined;
	// Whether any tool call arrived this turn (decides the finish label).
	workAnyTool: boolean;
	// Wall clock when the current tools run opened — its timeline node's
	// durationMs is per-run; the shell's label uses the turn's total.
	workRunStartedAt: number | undefined;
	// Phase 84.9: the frozen "Worked for Xs" duration — set when the shell
	// folds (Phase 84.11's mid-run answer-focus fold from updateTextElement
	// or the turn-end fold from finishStreaming; the shell stays open
	// through intermediate narrations). Un-frozen by the handleToolStart
	// reopen (a focus-folded shell that turned out to be a narration);
	// finishStreaming persists it so the restored label matches the live
	// fold moment.
	workFoldedMs?: number;
	// The CURRENT text run's markdown body — only that run's text slice
	// renders into it (created lazily on the run's first text delta).
	currentBody: HTMLElement | undefined;
	currentAssistantRow: HTMLElement | undefined;

	// --- Phase 60: chronological block runs (multiple per turn)
	// The event type of the open block run — the boundary signal: a
	// different incoming event type closes the run (round_end never
	// reaches the frontend; the event order is the only delimiter).
	lastBlockKind: 'thinking' | 'text' | 'tools' | undefined;
	// Char offset into `turn.text` where the current body's text begins.
	textRunStart: number;
	// Tool ids added since the current tools run opened (recorded with its
	// timeline node — mutating and read-only alike, in arrival order).
	toolsRunToolIds: string[];
	// Closed runs as chronological timeline nodes (offsets into the full
	// thinking/text + tool ids) — persisted with the turn record for the
	// ordered restore.
	timeline: IVibeAITurnTimelineNode[];
	// Markdown renders of already-closed body runs (handed to the record
	// store at finish — same async code-block swap as the final render —
	// or disposed at teardown on abort).
	closedRenders: DisposableStore[];
	// Phase 84: mermaid blocks created while streaming — their webview
	// mounts at run close / turn finish (flushStreamingMermaid), never per
	// delta. Parts whose holder is not in the document at flush time are
	// RETAINED and retried at the next flush instead of being dropped (a
	// dropped part keeps its spinner forever).
	pendingStreamingMermaid: IPendingMermaidPart[];
	// Phase 85: the mermaid blocks of the current streaming pass, in fence
	// order — reused across the pass's throttled re-renders so the same
	// element (and its spinner) survives instead of being rebuilt — and
	// the spinner animation restarted — per render. Cleared at run close
	// (the final render builds the spinner-less block) and at teardown.
	streamingMermaidParts: IPendingMermaidPart[];

	// --- agent tool activity (Cursor-style cards between user turn and answer)
	toolCards: Map<string, VibeAIToolCard>;
	pendingWriteCardId: string | undefined;

	// --- per-turn artifacts (checkpoint footer + files summary)
	turnChanges: IVibeAICodeChange[];
	turnStartedAt: number | undefined;

	// Phase 45: skip/resend + lossless persistence — the turn's user text
	// and DOM row (removed when the turn is skipped mid-stream), plus the
	// flags captured into the turn record at finish.
	userText: string;
	userRow: HTMLElement | undefined;
	contextCompressed: boolean;
	// Phase 51: the backend round hit its output token budget
	// (finish_reason=length) — captured into the turn record at finish and
	// surfaced as a truncation note (Cursor-style transparency).
	outputTruncated: boolean;
	// Phase 70: the model the Auto router picked for this turn (first
	// round + every fallback switch) — captured into the turn record at
	// finish and rendered as a footer-adjacent note (Cursor-parity
	// underlying-model display, `vibeAI.chat.autoReveal`).
	routedModel?: IVibeAIModelRouting;
	modelRoutedNote: HTMLElement | undefined;
	lastError: string | undefined;

	// --- Phase 71: Plan mode (research → plan → approval → execution)
	// The plan card's lifecycle: `awaiting` while the plan waits for the
	// user's Build / Cancel pick (the turn stays OPEN — the research
	// stream's done event does not finish it), `executing` after
	// approval (the execute stream renders into the same turn).
	planPhase: 'awaiting' | 'executing' | undefined;
	// The structured plan of the `plan` event (executed on approval).
	pendingPlan: IVibeAIPlan | undefined;
	// The `plan_done` roll-up — persisted with the turn record so the
	// restored card shows the per-step done/failed states.
	planResults: { stepsDone: number[]; stepsFailed: number[] } | undefined;
	// The plan card's DOM refs (in-place progress updates per step event).
	planCardRoot: HTMLElement | undefined;
	planProgress: HTMLElement | undefined;
	planStepRows: Map<number, HTMLElement> | undefined;

	// --- markdown streaming (throttled re-render)
	markdownRenderTimer: number | undefined;
	lastMarkdownRender: number;
	renderedMarkdown: DisposableStore | undefined;
}

/**
 * A completed turn (Phase 45): the per-turn artifacts captured at
 * finishStreaming — checkpoint rollback reads the recorded file changes
 * from it and the session store persists it so history restores with
 * full parity to the live view. `row` is runtime-only (never persisted).
 */
interface VibeAITurnRecord {
	userText: string;
	thinking?: string;
	thinkingDurationMs?: number;
	// Phase 61: the turn-level Worked block's total duration (the ONE
	// "Worked for Xs" collapsible covering the whole turn's activity).
	workDurationMs?: number;
	tools: IVibeAIPersistedToolCall[];
	answer: string;
	// Phase 58: interleaved narration segments (offsets into `answer`).
	segments?: IVibeAIPersistedTurnSegment[];
	// Phase 60: chronological block runs (see IVibeAITurnTimelineNode) —
	// the thinking/text offsets slice `thinking` / `answer`.
	timeline?: IVibeAITurnTimelineNode[];
	turnStartedAt?: number;
	contextCompressed?: boolean;
	outputTruncated?: boolean;
	// Phase 70: the model the Auto router picked for this turn (Cursor-
	// parity underlying-model display, persisted for restore parity).
	routedModel?: IVibeAIModelRouting;
	// Phase 71: the plan this turn produced (Plan mode) + its lifecycle —
	// persisted so history restores the card with the final states.
	plan?: IVibeAIPlan;
	planStatus?: VibeAIPlanCardStatus;
	planResults?: { stepsDone: number[]; stepsFailed: number[] };
	error?: string;
	turnChanges: IVibeAICodeChange[];
	rolledBack?: boolean;
	row: HTMLElement | undefined;
}

/**
 * One open conversation tab (editor-tab parity): every conversation owns
 * its history, context state and rendered thread; switching tabs toggles
 * the thread visibility and a conversation is deleted only via its ✕.
 * Phase 44: a conversation additionally owns its live stream state, so
 * every tab streams independently and in parallel.
 */
interface VibeAIConversation {
	id: string;
	sessionId: string;
	title: string;
	history: IVibeAIMessage[];
	attachedFiles: IVibeAIFileContext[];
	/**
	 * Phase 61: images attached to the next message (data URLs — Ctrl+V
	 * paste / drag-drop into the input box). Cleared on send.
	 */
	attachedImages: string[];
	contextLimit: number;
	contextUsage: IVibeAIContextUsage | undefined;
	container: HTMLElement;
	/** Live stream of this conversation — set while a turn runs. */
	stream: VibeAIStreamState | undefined;
	/** Per-turn listeners (footer / files summary / restored turns). */
	turnDisposables: DisposableStore;
	/**
	 * Completed turns (Phase 45): the per-turn artifacts read by
	 * checkpoint rollback and persisted for lossless history restore.
	 */
	turns: VibeAITurnRecord[];
	/**
	 * Listeners of completed turns' footers / files summaries — NOT
	 * cleared per turn (Phase 45 fix: only the latest turn's buttons
	 * worked when these lived on turnDisposables). Dies with the tab.
	 */
	turnRecordDisposables: DisposableStore;
	/** Sequence guard for this conversation's context-usage refreshes. */
	contextUsageSeq: number;
}

/**
 * Phase 47/48: one open in-place prompt edit. The edit box rebuilds the
 * main input's exact composer DOM (chips row + textarea + toolbar), so
 * it carries its own element refs — label/state updates fan out from
 * the pane-level mode/model/context state to BOTH composers (Cursor
 * parity: the edit box is identical to the input below and the
 * mode/model dropdowns stay in sync).
 */
interface VibeAIPromptEdit {
	conversation: VibeAIConversation;
	row: HTMLElement;
	bubble: HTMLElement;
	textarea: HTMLTextAreaElement;
	originalText: string;
	committing: boolean;
	/** Edit-scoped listeners (keyboard/input/blur + toolbar). */
	listeners: DisposableStore;
	/** Chips-row-scoped listeners (die with the edit). */
	chipsListeners: DisposableStore;
	/** The edit box's composer shell (.vibe-ai-input-container clone). */
	shell: HTMLElement;
	chipsRow: HTMLElement | undefined;
	modeButton: HTMLElement | undefined;
	modeIcon: HTMLElement | undefined;
	modeLabel: HTMLElement | undefined;
	modelButton: HTMLElement | undefined;
	modelLabel: HTMLElement | undefined;
	ringButton: HTMLElement | undefined;
	ringArc: SVGElement | undefined;
	sendButton: HTMLElement | undefined;
	stopButton: HTMLElement | undefined;
	micButton: HTMLElement | undefined;
}

/**
 * Cursor-style sidebar chat view backed by the local VibeCoding backend
 * (FastAPI + LLM). Streams via {@link IVibeAIService} and renders
 * Cursor-parity UI: markdown answers, thinking (collapsible "Thought for"),
 * tool activity cards with diffs, per-turn checkpoint footer with relative
 * time, a files-changed summary with Review, and a Cursor-style input box
 * with mode/model dropdowns and @-context chips.
 */
export class VibeAIChatPane extends ViewPane {

	static readonly ID = 'workbench.view.vibeAIChat';

	// --- persistent DOM
	private viewContainer: HTMLElement | undefined;
	private messagesContainer: HTMLElement | undefined;
	private tabBar: HTMLElement | undefined;
	private tabsContainer: HTMLElement | undefined;
	private statusRow: HTMLElement | undefined;
	private statusDot: HTMLElement | undefined;
	private statusLabel: HTMLElement | undefined;
	private inputElement: HTMLTextAreaElement | undefined;
	private chipsRow: HTMLElement | undefined;
	private modeButton: HTMLElement | undefined;
	private modeIcon: HTMLElement | undefined;
	private modeLabel: HTMLElement | undefined;
	private modelButton: HTMLElement | undefined;
	private modelLabel: HTMLElement | undefined;
	private sendButton: HTMLElement | undefined;
	private stopButton: HTMLElement | undefined;
	private micButton: HTMLElement | undefined;
	// --- Phase 56: docked files-summary review bar — the "N Files" row
	//     sticks directly above the input box (Cursor/native parity);
	//     its listeners live on their own store, cleared on re-render.
	private filesSummaryDock: HTMLElement | undefined;
	private readonly filesSummaryDisposables = new DisposableStore();

	// --- conversation tabs (editor-tab parity: one tab per conversation;
	//     conversations stay open until deleted via their tab's ✕)
	private conversations: VibeAIConversation[] = [];
	private activeConversationId: string | undefined;
	private conversationCounter = 0;
	// Phase 50: follow-latest — true while the messages holder is pinned at
	// its bottom (tracked by a scroll listener, see create()). Streaming
	// chases (thinking/answer/tool deltas) only scroll while the user has
	// not scrolled up to read; scrolling back to the bottom resumes.
	private followThreadBottom = true;
	private readonly tabDisposables = new DisposableStore();

	// --- state (mirrored pane fields of the active conversation)
	private history: IVibeAIMessage[] = [];
	// Phase 44: stream/turn state is per conversation (VibeAIConversation.
	// stream) — every tab streams independently and in parallel. The
	// request counter stays pane-level so requestIds are globally unique
	// and backend events are routed by requestId.
	private requestCounter = 0;
	private sessionId = `vibe-${Date.now()}`;
	// Cursor-parity tab title: "New Agent" until the first user message.
	private sessionTitle = 'New Agent';

	// --- input state (Cursor-style mode/model dropdowns + @ context chips)
	private mode: VibeAIChatMode = 'ask';
	private model = 'Auto';
	// Phase 70: Auto routing "Optimize For" bias (Cursor Router parity) —
	// cost | balance | intelligence. Read from `vibeAI.chat.autoMode` and
	// mirrored by the model menu's Optimize For submenu.
	private autoMode: string;
	private attachedFiles: IVibeAIFileContext[] = [];
	// Phase 61: images attached to the next message (data URLs — Ctrl+V
	// paste / drag-drop). Mirrors the active conversation, cleared on send.
	private attachedImages: string[] = [];

	// --- Phase 47: Cursor-parity sent-prompt editing — the one open
	//     in-place edit box (click a sent prompt → editable composer →
	//     Enter re-sends from that turn). Only one box edits at a time.
	//     Phase 48: the edit box reuses the main input's exact composer
	//     DOM, so its toolbar/chips/ring refs hang off this state and
	//     every label/state update fans out to both composers.
	private promptEdit: VibeAIPromptEdit | undefined;
	// --- Phase 48: the main input toolbar's listeners (die with the
	//     pane); an edit box's toolbar listeners live on its own store.
	private readonly inputToolbarDisposables = new DisposableStore();

	// --- Phase 72: the mode dropdown is a custom colored popup (not the
	//     stock context menu — that can't color individual items). One
	//     popup at a time, anchored above the trigger button; its
	//     outside-press/Esc listeners live on their own store.
	private modeMenuPopup: HTMLElement | undefined;
	private readonly modeMenuDisposables = new DisposableStore();

	// --- context usage panel (Phase 41: Cursor-parity token breakdown,
	//     toggled by the context ring left of the attach button)
	private contextPanel: HTMLElement | undefined;
	private contextRingButton: HTMLElement | undefined;
	private contextRingArc: SVGElement | undefined;
	private contextPercentLabel: HTMLElement | undefined;
	private contextTotalLabel: HTMLElement | undefined;
	private contextLimitInput: HTMLInputElement | undefined;
	private contextSlider: HTMLInputElement | undefined;
	private contextBar: HTMLElement | undefined;
	private contextRows: HTMLElement | undefined;
	private contextWarning: HTMLElement | undefined;
	private contextPanelOpen = false;
	private contextLimit = DEFAULT_CONTEXT_LIMIT;
	private contextUsage: IVibeAIContextUsage | undefined;

	// --- @ context chips listeners (cleared on every chip re-render)
	private readonly chipsDisposables = new DisposableStore();

	// --- persisted conversation history (Cursor-parity chat history)
	private readonly sessionStore: VibeAIChatSessionStore;

	// --- Phase 49: history dropdown (Cursor-parity in-pane menu anchored
	//     to the tab bar's clock button — search box + recency groups +
	//     per-row hover actions)
	private historyButton: HTMLButtonElement | undefined;
	private historyMenu: HTMLElement | undefined;
	// Menu-level listeners (search input, click-outside guard) live here;
	// the per-row listeners use their own store, cleared on every list
	// re-render while filtering (the search input's must survive).
	private readonly historyMenuDisposables = new DisposableStore();
	private readonly historyRowsDisposables = new DisposableStore();

	// --- Phase 78: `/` skill completion menu (Cursor-parity slash commands —
	//     a popup above the input lists workspace skills while a `/token` is
	//     being typed; Enter/Tab picks, Esc/click-outside dismisses; skills
	//     hidden from the model (disableModelInvocation) are user-trigger-only)
	private skillMenu: HTMLElement | undefined;
	private skillMenuIndex = -1;
	private skillList: IVibeAISkill[] = [];
	private skillListLoaded = false;
	private readonly skillMenuDisposables = new DisposableStore();
	private readonly skillRowsDisposables = new DisposableStore();

	// --- imported model registry (read by the settings editor's Models page)
	private readonly modelStore: VibeAIModelStore;

	// --- Phase 57: editor change highlighting (Cursor parity: the agent's
	//     file writes show green/red in the open editor like the chat's
	//     diff cards)
	private editorHighlighter: VibeAIEditorHighlighter | undefined;

	// --- Phase 83: mermaid diagram blocks (Cursor parity) — regular code
	//     blocks go through the editor-backed renderer (instantiated here so
	//     ```mermaid fences can be routed around it), mermaid blocks go to
	//     the built-in chat output renderer's inline webview.
	private readonly editorCodeBlockRenderer: EditorMarkdownCodeBlockRenderer;
	private readonly mermaidRenderer: VibeAIMermaidRenderer;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IStorageService storageService: IStorageService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IVibeAIService private readonly vibeAIService: IVibeAIService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);

		this._register(this.vibeAIService.onStreamData(data => this.handleStreamData(data)));
		this._register(this.chipsDisposables);
		this._register(this.tabDisposables);
		this._register(this.historyMenuDisposables);
		this._register(this.historyRowsDisposables);
		this._register(this.skillMenuDisposables);
		this._register(this.skillRowsDisposables);
		this._register(this.filesSummaryDisposables);
		// Phase 57: the agent's file writes highlight the modified places in
		// the open editor (green adds / red deletions, chat-diff colors).
		this.editorHighlighter = this._register(new VibeAIEditorHighlighter(codeEditorService));
		// Phase 83: the editor-backed code block renderer (the same renderer
		// the workbench installs as the markdown renderer service default) —
		// instantiated here so ```mermaid fences can be routed around it.
		this.editorCodeBlockRenderer = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
		this.mermaidRenderer = this._register(instantiationService.createInstance(VibeAIMermaidRenderer));
		this.sessionStore = new VibeAIChatSessionStore(storageService);
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
		this.model = configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		// Phase 70: Optimize For bias of the Auto router (Cursor parity).
		this.autoMode = configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Keep a reference for updateEmptyState() (.empty toggles layout).
		this.viewContainer = container;
		container.classList.add('vibe-ai-chat-view');

		// Cursor parity: the workbench pane header (icon + title + title
		// actions) is hidden — its actions move into the in-pane tab bar.
		container.parentElement?.classList.add('vibe-ai-chat-pane');

		// --- Cursor-parity tab bar ("New Agent ×" + new-chat / history / more)
		this.renderTabBar(container);

		// --- backend status (subtle: hidden entirely once connected)
		this.statusRow = DOM.append(container, $('.vibe-ai-chat-status'));
		this.statusDot = DOM.append(this.statusRow, $('span.vibe-ai-chat-status-dot'));
		this.statusLabel = DOM.append(this.statusRow, $('span.vibe-ai-chat-status-label'));

		// --- messages holder (scrolls above the docked input, Cursor parity)
		this.messagesContainer = DOM.append(container, $('.vibe-ai-chat-messages'));
		// Phase 50: follow-latest tracking. Content growth (streaming
		// deltas) does not fire scroll events, so this listener only
		// reflects the user's own scrolling: up pauses the bottom chase,
		// back at the bottom resumes it.
		this._register(DOM.addDisposableListener(this.messagesContainer, DOM.EventType.SCROLL, () => {
			const el = this.messagesContainer;
			if (el) {
				this.followThreadBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_LATEST_THRESHOLD_PX;
			}
		}));

		// --- conversation threads (editor-tab parity: each conversation
		//     owns a thread inside the holder; switching tabs toggles it)
		const first = this.createConversation();
		this.activeConversationId = first.id;
		this.syncFromActiveConversation();
		this.showOnlyConversation(first.id);
		this.renderTabs();

		// --- input area (Cursor-style rounded container docked at the
		//     bottom once the conversation has turns; on an empty new chat
		//     it stays pinned at the top as the tall composer — see
		//     .vibe-ai-chat-view.empty)
		const inputContainer = DOM.append(container, $('.vibe-ai-input-container'));

		this.chipsRow = DOM.append(inputContainer, $('.vibe-ai-input-chips'));
		this.chipsRow.style.display = 'none';

		this.inputElement = DOM.append(inputContainer, $('textarea.vibe-ai-input')) as HTMLTextAreaElement;
		this.inputElement.rows = 1;
		this.inputElement.wrap = 'soft';
		this.inputElement.spellcheck = false;
		this.inputElement.placeholder = localize(
			'vibeAIChat.inputPlaceholder',
			"Plan, Build, / for skills, @ for context"
		);

		this.renderInputToolbar(inputContainer);
		this.registerInputListeners();
		// Phase 47: Cursor-parity sent-prompt editing — one delegated click
		// listener covers every conversation thread (live and restored
		// rows): clicking a sent prompt box turns it into an editable box.
		this.registerPromptEditDelegation();

		// --- Phase 41: Context Usage panel — Cursor-parity token breakdown
		//     card above the input, toggled by the context ring.
		this.renderContextPanel(container, inputContainer);

		// --- Phase 56: docked files-summary review bar — the "N Files"
		//     row sticks directly above the input box (below the Context
		//     Usage panel) instead of scrolling with the thread.
		this.filesSummaryDock = $('.vibe-ai-files-dock');
		this.filesSummaryDock.style.display = 'none';
		container.insertBefore(this.filesSummaryDock, inputContainer);

		this.updateEmptyState();
		this.updateInputActions();

		// --- Phase 79: restore the previously open tabs + the current
		//     conversation (Cursor-parity chat restore) — runs after the
		//     whole UI is wired (chips/input/context panel) so the
		//     restored tabs go through the normal loadSession / tab-switch
		//     path; with nothing recorded the fresh tab above stays.
		this.restoreOpenConversations();

		// --- backend health polling
		void this.refreshBackendStatus();
	}

	/**
	 * Cursor-parity tab bar: the active conversation tab ("New Agent ×")
	 * plus the new-chat (+), history (clock) and more (…) actions.
	 */
	private renderTabBar(container: HTMLElement): void {
		this.tabBar = DOM.append(container, $('.vibe-ai-tabbar'));

		// --- tab strip: one tab per conversation (editor-tab parity); the
		//     ✕ on a tab deletes that conversation, + opens a new one
		this.tabsContainer = DOM.append(this.tabBar, $('.vibe-ai-tabbar-tabs'));

		const actions = DOM.append(this.tabBar, $('.vibe-ai-tabbar-actions'));
		const newChatButton = DOM.append(actions, $('button.vibe-ai-icon-btn.codicon.codicon-plus')) as HTMLButtonElement;
		newChatButton.title = localize('vibeAIChat.newChat', "New Chat");
		this._register(DOM.addDisposableListener(newChatButton, DOM.EventType.CLICK, () => this.newConversation()));

		const historyButton = DOM.append(actions, $('button.vibe-ai-icon-btn.codicon.codicon-history')) as HTMLButtonElement;
		historyButton.title = localize('vibeAIChat.history', "Chat History");
		// Phase 49: the clock opens the in-pane history dropdown.
		this.historyButton = historyButton;
		this._register(DOM.addDisposableListener(historyButton, DOM.EventType.CLICK, () => this.showHistory()));

		const moreButton = DOM.append(actions, $('button.vibe-ai-icon-btn.codicon.codicon-ellipsis')) as HTMLButtonElement;
		moreButton.title = localize('vibeAIChat.moreActions', "More Actions");
		this._register(DOM.addDisposableListener(moreButton, DOM.EventType.CLICK, () => this.showTabMenu(moreButton)));

		this.renderTabs();
	}

	/** "…" menu (Cursor-parity more actions). */
	private showTabMenu(anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new Action('vibeAI.chat.tab.newChat', localize('vibeAIChat.newChat', "New Chat"), undefined, true, async () => { this.newConversation(); }),
				new Action('vibeAI.chat.tab.closeChat', localize('vibeAIChat.closeChat', "Close Chat"), undefined, true, async () => {
					if (this.activeConversationId) {
						this.closeConversation(this.activeConversationId);
					}
				}),
				new Action('vibeAI.chat.tab.history', localize('vibeAIChat.history', "Chat History"), undefined, true, () => { this.showHistory(); }),
			],
		});
	}

	// ==================== conversation tabs (editor-tab parity) ====================

	private getActiveConversation(): VibeAIConversation | undefined {
		return this.conversations.find(conversation => conversation.id === this.activeConversationId);
	}

	/** Creates a new conversation (own hidden thread) without switching to it. */
	private createConversation(): VibeAIConversation {
		const container = $('.vibe-ai-chat-thread');
		container.style.display = 'none';
		const conversation: VibeAIConversation = {
			id: `vibe-convo-${++this.conversationCounter}`,
			sessionId: `vibe-${Date.now()}`,
			title: 'New Agent',
			history: [],
			attachedFiles: [],
			attachedImages: [],
			contextLimit: DEFAULT_CONTEXT_LIMIT,
			contextUsage: undefined,
			container,
			stream: undefined,
			turnDisposables: new DisposableStore(),
			turnRecordDisposables: new DisposableStore(),
			turns: [],
			contextUsageSeq: 0,
		};
		// The conversation's per-turn listeners die with the pane (and with
		// the tab's ✕, which disposes the store before removing the tab).
		this._register(conversation.turnDisposables);
		this._register(conversation.turnRecordDisposables);
		this.messagesContainer?.appendChild(container);
		this.conversations.push(conversation);
		return conversation;
	}

	/** A conversation is untouched when it has no turns and no attachments. */
	private isConversationEmpty(conversation: VibeAIConversation): boolean {
		return conversation.history.length === 0
			&& conversation.attachedFiles.length === 0
			&& conversation.attachedImages.length === 0
			&& conversation.container.children.length === 0;
	}

	/** Shows only the given conversation's thread (editor-tab switching). */
	private showOnlyConversation(id: string): void {
		for (const conversation of this.conversations) {
			conversation.container.style.display = conversation.id === id ? '' : 'none';
		}
	}

	/** Writes the mirrored pane state back to the active conversation. */
	private syncToActiveConversation(): void {
		const active = this.getActiveConversation();
		if (!active) {
			return;
		}
		active.history = this.history;
		active.attachedFiles = this.attachedFiles;
		active.attachedImages = this.attachedImages;
		active.contextLimit = this.contextLimit;
		active.contextUsage = this.contextUsage;
		active.sessionId = this.sessionId;
		active.title = this.sessionTitle;
	}

	/** Loads the active conversation's state into the mirrored pane fields. */
	private syncFromActiveConversation(): void {
		const active = this.getActiveConversation();
		if (!active) {
			return;
		}
		this.history = active.history;
		this.attachedFiles = active.attachedFiles;
		this.attachedImages = active.attachedImages;
		this.contextLimit = active.contextLimit;
		this.contextUsage = active.contextUsage;
		this.sessionId = active.sessionId;
		this.sessionTitle = active.title;
	}

	/**
	 * Switches to a conversation tab: mirrors its state into the pane,
	 * toggles thread visibility, refreshes chips/ring/empty-state. A
	 * running stream keeps rendering into its own (hidden) thread.
	 */
	private setActiveConversation(id: string): void {
		if (id === this.activeConversationId) {
			this.inputElement?.focus();
			return;
		}
		// Phase 47: an open prompt edit belongs to the thread we are
		// leaving — cancel it (its static text is restored).
		this.cancelPromptEdit();
		this.syncToActiveConversation();
		this.activeConversationId = id;
		this.syncFromActiveConversation();
		this.showOnlyConversation(id);
		this.renderTabs();
		this.renderChips();
		this.renderContextUsage();
		this.updateEmptyState();
		// Phase 56: the docked review bar belongs to the active
		// conversation — re-render it for the tab switched to.
		this.renderDockedFilesSummary();
		// Phase 44 fix: re-derive stop/mic/send from the NEW active
		// conversation — its stream state may differ from the tab we left
		// (a streaming tab switching to a fresh tab must swap the stop
		// button for the mic/send pair, and vice versa).
		this.updateInputActions();
		this.autoGrowInput();
		this.inputElement?.focus();
		void this.refreshContextUsage();
		// Phase 79: the tab strip state sticks across restarts (Cursor
		// parity — open tabs + the active conversation restore).
		this.persistOpenState();
	}

	/**
	 * "+" (editor-tab parity): always opens a new empty conversation tab —
	 * unlimited empty conversations can coexist in the tab strip. Every
	 * conversation stays open in its tab until deleted via its ✕.
	 */
	private newConversation(): void {
		this.setActiveConversation(this.createConversation().id);
	}

	/**
	 * Phase 79: persists the open-tab strip state — the session ids of
	 * every non-empty conversation in tab order plus the active one — so
	 * the tabs and the current conversation restore on the next window
	 * start (Cursor-parity chat restore). Empty conversations are skipped
	 * (the session store never keeps zero-message sessions either) and an
	 * active empty tab is not recorded — the restore falls back to the
	 * first restored tab.
	 */
	private persistOpenState(): void {
		const openIds: string[] = [];
		let activeId: string | undefined;
		for (const conversation of this.conversations) {
			if (this.isConversationEmpty(conversation)) {
				continue;
			}
			openIds.push(conversation.sessionId);
			if (conversation.id === this.activeConversationId) {
				activeId = conversation.sessionId;
			}
		}
		this.sessionStore.saveOpenState({ openIds, activeId });
	}

	/**
	 * Phase 79: reopens the persisted open-tab strip (Cursor-parity chat
	 * restore): every recorded session id that still exists in the store
	 * becomes a tab again (recorded order = previous tab order) and the
	 * recorded active conversation is focused again. Sessions deleted or
	 * evicted (MAX_SESSIONS) since the last window are skipped; when
	 * nothing restores, the pre-Phase-79 behavior applies (one fresh
	 * empty conversation).
	 */
	private restoreOpenConversations(): void {
		const state = this.sessionStore.getOpenState();
		if (state.openIds.length === 0) {
			return;
		}
		const sessions = this.sessionStore.list();
		const restoreSessions = state.openIds
			.map(id => sessions.find(session => session.id === id))
			.filter((session): session is IVibeAIChatSession => session !== undefined);
		if (restoreSessions.length === 0) {
			return;
		}
		// The first loadSession reuses the initial empty tab (its "reuse
		// the empty active conversation" branch); the rest open their own
		// tabs — the strip order matches the recorded one.
		for (const session of restoreSessions) {
			this.loadSession(session);
		}
		// Focus the recorded active conversation; when it was deleted or
		// never recorded (an empty tab was active at close time), fall
		// back to the first restored tab.
		const recorded = state.activeId;
		const activeSessionId = recorded && restoreSessions.some(session => session.id === recorded)
			? recorded
			: restoreSessions[0].id;
		const active = this.conversations.find(conversation => conversation.sessionId === activeSessionId);
		if (active) {
			this.setActiveConversation(active.id);
		}
	}

	/**
	 * ✕ on a tab (editor-tab parity): deletes that conversation. Closing
	 * the active tab activates a neighbor tab; closing the last tab opens
	 * a fresh empty conversation. A streaming conversation is cancelled
	 * first (its partial answer never pollutes other conversations).
	 */
	private closeConversation(id: string): void {
		const index = this.conversations.findIndex(conversation => conversation.id === id);
		if (index === -1) {
			return;
		}
		const conversation = this.conversations[index];
		// Phase 47: cancel an open prompt edit before the thread goes away
		// (only the active conversation's thread can be edited).
		if (this.promptEdit?.conversation === conversation) {
			this.cancelPromptEdit();
		}
		// Phase 44: a streaming conversation is aborted per conversation —
		// other tabs' streams keep running.
		if (conversation.stream) {
			this.abortStream(conversation);
		}
		// Its per-turn listeners (footer / files summary) die with the tab.
		conversation.turnDisposables.dispose();
		conversation.turnRecordDisposables.dispose();
		conversation.container.remove();
		this.conversations.splice(index, 1);
		if (this.activeConversationId === id) {
			const next = this.conversations[Math.min(index, this.conversations.length - 1)];
			if (next) {
				this.setActiveConversation(next.id);
			} else {
				const fresh = this.createConversation();
				this.activeConversationId = fresh.id;
				this.syncFromActiveConversation();
				this.showOnlyConversation(fresh.id);
				this.renderTabs();
				this.renderChips();
				this.renderContextUsage();
				this.updateEmptyState();
				// Phase 56: a fresh empty tab has nothing to review — the
				// docked bar hides.
				this.renderDockedFilesSummary();
				this.updateInputActions();
				this.autoGrowInput();
				this.inputElement?.focus();
			}
		} else {
			this.renderTabs();
		}
		// Phase 79: the closed tab never comes back on restore.
		this.persistOpenState();
	}

	/**
	 * Re-renders the tab strip: one tab per conversation. The active tab
	 * always shows its ✕ close button, other tabs reveal it on hover, and
	 * a streaming background conversation shows a pulsing dot.
	 */
	private renderTabs(): void {
		if (!this.tabsContainer) {
			return;
		}
		this.tabDisposables.clear();
		DOM.clearNode(this.tabsContainer);
		for (const conversation of this.conversations) {
			const tab = DOM.append(this.tabsContainer, $('.vibe-ai-tab'));
			tab.classList.toggle('active', conversation.id === this.activeConversationId);
			// Phase 44: per-conversation stream — every streaming tab (even
			// a background one) shows the pulsing dot.
			if (conversation.stream) {
				tab.classList.add('streaming');
				DOM.append(tab, $('span.vibe-ai-tab-stream-dot'));
			}
			const label = DOM.append(tab, $('span.vibe-ai-tab-label'));
			label.textContent = conversation.title;
			const close = DOM.append(tab, $('button.codicon.codicon-close.vibe-ai-tab-close')) as HTMLButtonElement;
			close.title = localize('vibeAIChat.tabClose', "Close");
			this.tabDisposables.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.closeConversation(conversation.id);
			}));
			this.tabDisposables.add(DOM.addDisposableListener(tab, DOM.EventType.CLICK, () => {
				if (conversation.id !== this.activeConversationId) {
					this.setActiveConversation(conversation.id);
				} else {
					this.inputElement?.focus();
				}
			}));
		}
	}

	private updateTabTitle(): void {
		// The title lives on the active conversation's tab.
		const active = this.getActiveConversation();
		if (active) {
			active.title = this.sessionTitle;
		}
		this.renderTabs();
	}

	/** Derives the tab title from the first user message (Cursor parity). */
	private deriveSessionTitle(text: string): string {
		const raw = text.trim().replace(/\s+/g, ' ');
		return raw.length > 40 ? `${raw.substring(0, 40)}…` : raw;
	}

	private renderInputToolbar(inputContainer: HTMLElement): void {
		// Phase 48: the toolbar comes from the shared builder (the edit
		// box builds the identical one); the main input keeps its element
		// refs on the pane — dropdown anchors, ring state and the
		// send/stop/mic visibility logic read them.
		const toolbar = this.buildInputToolbar(inputContainer, this.inputToolbarDisposables, {
			sendTitle: localize('vibeAIChat.send', "Send (Enter)"),
			onSend: () => this.send(),
		});
		this.modeButton = toolbar.modeButton;
		this.modeIcon = toolbar.modeIcon;
		this.modeLabel = toolbar.modeLabel;
		this.modelButton = toolbar.modelButton;
		this.modelLabel = toolbar.modelLabel;
		this.micButton = toolbar.micButton;
		this.stopButton = toolbar.stopButton;
		this.sendButton = toolbar.sendButton;
		this.contextRingButton = toolbar.ringButton;
		this.contextRingArc = toolbar.ringArc;
		this.updateModeLabel();
		this.updateModelLabel();
	}

	/**
	 * Phase 48: builds the Cursor-style input toolbar (mode/model
	 * dropdowns, context ring, attach, mic, stop, send) shared by the
	 * main input box and an in-place prompt edit box — the exact same
	 * DOM, classes and wiring, so the two are pixel-identical. Mode and
	 * model clicks open the shared menus anchored to the button that was
	 * clicked and write the shared pane state, keeping both toolbars in
	 * sync. All listeners go into `store` (pane lifetime for the main
	 * input, the edit's own store for an edit box).
	 */
	private buildInputToolbar(parent: HTMLElement, store: DisposableStore, opts: { sendTitle: string; onSend: () => void; showContextRing?: boolean }): {
		modeButton: HTMLElement;
		modeIcon: HTMLElement;
		modeLabel: HTMLElement;
		modelButton: HTMLElement;
		modelLabel: HTMLElement;
		ringButton: HTMLElement | undefined;
		ringArc: SVGElement | undefined;
		micButton: HTMLElement;
		stopButton: HTMLElement;
		sendButton: HTMLElement;
	} {
		const toolbar = DOM.append(parent, $('.vibe-ai-input-toolbar'));

		// mode dropdown (Agent / Plan / Ask) — Cursor-parity mode picker
		const modeButton = DOM.append(toolbar, $('button.vibe-ai-input-tool.mode')) as HTMLElement;
		const modeIcon = DOM.append(modeButton, $('span.codicon.codicon-commentDiscussion'));
		modeIcon.setAttribute('aria-hidden', 'true');
		const modeLabel = DOM.append(modeButton, $('span'));
		DOM.append(modeButton, $('span.codicon.codicon-chevron-down'));
		modeButton.title = localize('vibeAIChat.modeTitle', "Switch between Agent, Plan and Ask mode");

		// model dropdown — Cursor-parity "Auto ⌄"
		const modelButton = DOM.append(toolbar, $('button.vibe-ai-input-tool.model')) as HTMLElement;
		const modelLabel = DOM.append(modelButton, $('span'));
		DOM.append(modelButton, $('span.codicon.codicon-chevron-down'));
		modelButton.title = localize('vibeAIChat.modelTitle', "Select the model for this conversation");

		DOM.append(toolbar, $('span.spacer'));

		// Phase 41: Cursor-parity context ring — sits left of the attach
		// button, shows how full the context window is, and toggles the
		// Context Usage panel on click. Phase 50: the prompt edit box
		// opts out — usage belongs to the live input, not a resent prompt.
		const ring = opts.showContextRing === false ? undefined : this.buildContextRing(toolbar, store);

		// attach (paperclip) — Cursor-parity 📎, attaches the active file
		const attachButton = DOM.append(toolbar, $('button.vibe-ai-input-tool.codicon.codicon-attach')) as HTMLElement;
		attachButton.title = localize('vibeAIChat.mentionTitle', "Attach the current file to the conversation (@)");
		store.add(DOM.addDisposableListener(attachButton, DOM.EventType.CLICK, () => this.attachActiveFile()));

		// mic (voice input) — Cursor-parity 🎤, visible while the input is empty
		const micButton = DOM.append(toolbar, $('button.vibe-ai-input-tool.codicon.codicon-mic')) as HTMLElement;
		micButton.title = localize('vibeAIChat.micTitle', "Voice input");
		store.add(DOM.addDisposableListener(micButton, DOM.EventType.CLICK, () => this.showMicUnavailable()));

		// stop (visible while streaming)
		const stopButton = DOM.append(toolbar, $('button.vibe-ai-send-button.stop')) as HTMLElement;
		DOM.append(stopButton, $('span.codicon.codicon-debug-stop'));
		stopButton.title = localize('vibeAIChat.stop', "Stop");
		stopButton.style.display = 'none';
		store.add(DOM.addDisposableListener(stopButton, DOM.EventType.CLICK, () => this.cancel()));

		// send (Cursor-style round arrow button, visible once there is text)
		const sendButton = DOM.append(toolbar, $('button.vibe-ai-send-button')) as HTMLElement;
		DOM.append(sendButton, $('span.codicon.codicon-arrow-up'));
		sendButton.title = opts.sendTitle;
		sendButton.style.display = 'none';
		store.add(DOM.addDisposableListener(sendButton, DOM.EventType.CLICK, opts.onSend));

		// Mode/model dropdowns: anchored to THIS toolbar's buttons, they
		// write the shared pane state (both toolbars' labels re-render).
		store.add(DOM.addDisposableListener(modeButton, DOM.EventType.CLICK, () => this.showModeMenu(modeButton)));
		store.add(DOM.addDisposableListener(modelButton, DOM.EventType.CLICK, () => this.showModelMenu(modelButton)));

		return { modeButton, modeIcon, modeLabel, modelButton, modelLabel, ringButton: ring?.button, ringArc: ring?.arc, micButton, stopButton, sendButton };
	}

	/**
	 * Phase 41: Cursor-parity context ring — a small circular progress
	 * indicator left of the attach button. The arc fills with the context
	 * usage percentage; clicking toggles the Context Usage panel.
	 * Phase 48: shared by both toolbars — the caller keeps the refs
	 * (renderContextRingState fans out to every ring).
	 */
	private buildContextRing(toolbar: HTMLElement, store: DisposableStore): { button: HTMLElement; arc: SVGElement } {
		const button = $('button.vibe-ai-context-ring');
		button.title = localize('vibeAIChat.contextRingTitle', "Context Usage");
		button.setAttribute('aria-label', localize('vibeAIChat.contextRingTitle', "Context Usage"));
		store.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => this.toggleContextPanel()));

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
		// Start the arc at 12 o'clock and grow clockwise.
		arc.setAttribute('transform', 'rotate(-90 10 10)');
		arc.style.strokeDasharray = `${CONTEXT_RING_CIRCUMFERENCE}`;
		arc.style.strokeDashoffset = `${CONTEXT_RING_CIRCUMFERENCE}`;
		svg.appendChild(track);
		svg.appendChild(arc);
		button.appendChild(svg);

		toolbar.appendChild(button);
		return { button, arc };
	}

	/** Updates the context ring arc from the latest usage (both toolbars). */
	private renderContextRingState(): void {
		const percent = Math.min(100, Math.max(0, this.contextUsage?.percentFull ?? 0));
		const offset = `${CONTEXT_RING_CIRCUMFERENCE * (1 - percent / 100)}`;
		const overLimit = percent >= 100;
		if (this.contextRingButton && this.contextRingArc) {
			this.contextRingArc.style.strokeDashoffset = offset;
			this.contextRingButton.classList.toggle('over-limit', overLimit);
		}
		// Phase 48: the edit box's ring mirrors the main input's.
		const edit = this.promptEdit;
		if (edit?.ringButton && edit.ringArc) {
			edit.ringArc.style.strokeDashoffset = offset;
			edit.ringButton.classList.toggle('over-limit', overLimit);
		}
	}

	private registerInputListeners(): void {
		if (!this.inputElement) {
			return;
		}
		this._register(DOM.addDisposableListener(this.inputElement, DOM.EventType.KEY_DOWN, e => {
			// Phase 78: while the `/` skill completion menu is open it owns the
			// navigation keys (arrows walk, Enter/Tab pick, Esc dismisses —
			// Enter must NOT send the message mid-completion).
			if (this.skillMenu && this.handleSkillMenuKeys(e)) {
				return;
			}
			// Enter sends, Shift+Enter inserts a newline (Ctrl/Cmd+Enter also sends)
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				// An empty input never sends.
				if ((this.inputElement?.value.trim().length ?? 0) > 0) {
					this.send();
				}
			}
		}));
		this._register(DOM.addDisposableListener(this.inputElement, DOM.EventType.INPUT, () => {
			this.autoGrowInput();
			this.updateInputActions();
			// Phase 78: a `/token` being typed opens/filters the skill menu.
			void this.updateSkillMenu();
		}));
		// Phase 61: Ctrl+V image paste — screenshots/photos on the clipboard
		// attach as image chips (Cursor parity); a clipboard without images
		// lets the native text paste run untouched.
		this._register(DOM.addDisposableListener(this.inputElement, DOM.EventType.PASTE, e => {
			this.handleImagePaste(e);
		}));
		// Phase 61: drag-drop of image files into the input box (same path
		// as paste — the drop's text payloads are swallowed with images).
		this._register(DOM.addDisposableListener(this.inputElement, 'dragover', e => {
			if (Array.from(e.dataTransfer?.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
				e.preventDefault();
			}
		}));
		this._register(DOM.addDisposableListener(this.inputElement, 'drop', e => {
			const files = Array.from(e.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'));
			if (files.length === 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			void this.attachImageFiles(files);
		}));
		// Phase 48: mode/model clicks are wired inside buildInputToolbar —
		// one wiring per toolbar instance (main input + edit box).
	}

	/**
	 * Phase 61: image paste handling — image items on the clipboard attach
	 * as image chips and the native paste is swallowed (a file-path/HTML
	 * text payload would pollute the input); without images the native
	 * text paste runs untouched.
	 */
	private handleImagePaste(e: ClipboardEvent): void {
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
		void this.attachImageFiles(files);
	}

	/**
	 * Phase 61: attaches image files to the next message — read into
	 * downscaled data URLs (readImageAsDataUrl), surfaced as removable
	 * thumbnail chips, sent with the next turn as `images` on the user
	 * message (the backend builds the multimodal request from them).
	 */
	private async attachImageFiles(files: File[]): Promise<void> {
		let rejected = false;
		for (const file of files) {
			if (this.attachedImages.length >= MAX_ATTACHED_IMAGES) {
				rejected = true;
				break;
			}
			try {
				this.attachedImages.push(await readImageAsDataUrl(file));
			} catch (err) {
				this.logService.warn('[VibeAI] failed to read attached image', err);
				this.notificationService.error(localize('vibeAIChat.imageReadFailed', "Failed to read the pasted image — try copying it again."));
			}
		}
		if (rejected) {
			this.notificationService.warn(localize(
				'vibeAIChat.tooManyImages',
				"At most {0} images can be attached per message.",
				MAX_ATTACHED_IMAGES
			));
		}
		this.renderChips();
		this.updateInputActions();
	}

	private autoGrowInput(): void {
		if (!this.inputElement) {
			return;
		}
		this.inputElement.style.height = 'auto';
		this.inputElement.style.height = `${Math.min(this.inputElement.scrollHeight, INPUT_MAX_HEIGHT)}px`;
	}

	/**
	 * Cursor-parity input actions visibility: the send button appears once
	 * there is text, the mic shows while the input is empty, and the stop
	 * button shows while a stream runs with an empty input. Phase 45: the
	 * input may be used at any time — sending while a stream runs skips
	 * the in-flight turn, so the send button stays visible while typing
	 * even mid-stream (mic/stop yield to it). The context ring's
	 * visibility follows the conversation state (updateEmptyState): hidden
	 * on a fresh empty chat, shown once turns render.
	 */
	private updateInputActions(): void {
		const hasText = (this.inputElement?.value.trim().length ?? 0) > 0;
		// Phase 61: attached images enable the send button without text.
		const hasImages = this.attachedImages.length > 0;
		// Phase 44: the input box reflects the ACTIVE conversation's stream
		// only — other tabs' streams run in parallel and don't block it.
		const streaming = !!this.getActiveConversation()?.stream;
		if (this.sendButton) {
			this.sendButton.style.display = (hasText || hasImages) ? 'flex' : 'none';
			this.sendButton.classList.toggle('enabled', hasText || hasImages);
			this.sendButton.title = streaming
				? localize('vibeAIChat.sendSkips', "Send — skips the running answer (Enter)")
				: localize('vibeAIChat.send', "Send (Enter)");
		}
		if (this.micButton) {
			this.micButton.style.display = !hasText && !hasImages && !streaming ? 'flex' : 'none';
		}
		if (this.stopButton) {
			this.stopButton.style.display = streaming && !hasText && !hasImages ? 'flex' : 'none';
		}
		// Phase 48: the edit box's toolbar mirrors the same rules.
		this.updateEditToolbarActions();
	}

	/**
	 * Phase 48: refreshes the edit box toolbar's action buttons from the
	 * same rules as the main input — send (re-send) once there is text,
	 * mic while empty and idle, stop while the edited conversation
	 * streams with an empty box. Refreshed on every main-input action
	 * update (stream transitions included) and on edit input.
	 */
	private updateEditToolbarActions(): void {
		const edit = this.promptEdit;
		if (!edit) {
			return;
		}
		const hasText = edit.textarea.value.trim().length > 0;
		const streaming = !!edit.conversation.stream;
		if (edit.sendButton) {
			edit.sendButton.style.display = hasText ? 'flex' : 'none';
			edit.sendButton.classList.toggle('enabled', hasText);
			edit.sendButton.title = streaming
				? localize('vibeAIChat.resendSkips', "Re-send — aborts the running answer (Enter)")
				: localize('vibeAIChat.resend', "Re-send (Enter)");
		}
		if (edit.micButton) {
			edit.micButton.style.display = !hasText && !streaming ? 'flex' : 'none';
		}
		if (edit.stopButton) {
			edit.stopButton.style.display = streaming && !hasText ? 'flex' : 'none';
		}
	}

	/** Cursor-parity mic button: voice input is not wired up in this build. */
	private showMicUnavailable(): void {
		this.notificationService.info(localize(
			'vibeAIChat.micUnavailable',
			"Voice input is not available in this build of VibeAI — type your message instead."
		));
	}

	private send(): void {
		if (!this.inputElement) {
			return;
		}
		// Phase 47: sending from the main input cancels an open prompt
		// edit (its static text is restored) — the two never interleave.
		this.cancelPromptEdit();
		const conversation = this.getActiveConversation();
		// Phase 44: only THIS conversation's running stream matters — other
		// tabs' streams run in parallel. Phase 45: sending while a stream
		// runs skips the in-flight turn (abort + remove its unfinished user
		// message and partial answer) and sends the new message directly.
		if (conversation?.stream) {
			this.skipCurrentTurn(conversation);
		}
		const text = this.inputElement.value.trim();
		// Phase 61: an image-only message (no text) sends too.
		if (text.length === 0 && this.attachedImages.length === 0) {
			return;
		}
		if (!conversation) {
			return;
		}

		this.inputElement.value = '';
		this.autoGrowInput();
		this.updateInputActions();
		// Phase 78: the `/` skill menu closes with the input; the cached skill
		// list refreshes on the next completion so skills written mid-chat
		// (Phase 77 hot reload) show up without a pane reload.
		this.closeSkillMenu();
		this.skillListLoaded = false;
		// Phase 41: sending closes the Context Usage panel (Cursor parity).
		this.toggleContextPanel(false);
		// Phase 61: images attach to the user message (data URLs) and the
		// chips clear — the request's history carries them to the backend.
		const images = this.attachedImages.length > 0 ? [...this.attachedImages] : undefined;
		this.attachedImages = [];
		this.renderChips();
		this.history.push(images ? { role: 'user', content: text, images } : { role: 'user', content: text });
		// Cursor-parity tab title: the first user message names the chat.
		if (this.sessionTitle === 'New Agent' && text.length > 0) {
			this.sessionTitle = this.deriveSessionTitle(text);
			this.updateTabTitle();
		}
		const userRow = this.renderUserTurn(conversation, text, images);
		this.dispatchTurn(conversation, text, userRow);
	}

	/**
	 * Phase 47: opens the turn's live stream for a user prompt already
	 * pushed to history and rendered into the thread (`userRow`) —
	 * everything after the history push, shared by `send()` and the
	 * prompt-edit resend (Cursor-parity edit & resubmit). Reads the pane
	 * mirrors of the ACTIVE conversation (mode/model/context/limit), so
	 * callers must only dispatch for the active conversation — the edit
	 * resend guards that.
	 */
	private dispatchTurn(conversation: VibeAIConversation, text: string, userRow: HTMLElement): void {
		// Phase 44: the turn's live state hangs off this conversation, so
		// the stream keeps running (and rendering into its own thread) even
		// when its tab is switched away from (or closed) while it runs.
		const requestId = `vibe-${++this.requestCounter}`;
		// Routing resolves before the turn opens: the no-model gate below
		// surfaces the failure inside the turn it would have served.
		// Imported model (Settings → Models): route the request through its
		// connection's OpenAI-compatible endpoint via the provider override.
		// Ad-hoc model names (not imported) have no fallback anymore.
		const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		// Phase 70 Auto routing: when Auto is selected the request carries the
		// pseudo-model id 'auto' plus the non-disabled imported-model pool
		// (resolved provider overrides + tier hints) and the Optimize For
		// mode — the backend's router picks one per intent+complexity and
		// falls back down the list on provider failures.
		const autoPool = this.model === 'Auto' ? this.buildAutoPool() : undefined;
		this.startAssistantTurn(conversation, requestId, text, userRow);
		this.updateInputActions();
		this.renderTabs();

		// No default-model fallback: with nothing configured (an empty Auto
		// pool or an imported model whose connection is gone) the turn fails
		// fast with the backend's message instead of a doomed request.
		if (!this.hasUsableModel(configured, provider, autoPool)) {
			this.showError(VIBE_AI_NO_MODEL_MESSAGE, conversation);
			this.finishStreaming(conversation, requestId);
			return;
		}
		const request: IVibeAIChatRequest = {
			messages: [...this.history],
			stream: true,
			// Phase 41: custom context length — the backend compresses the
			// history to fit before running the agent loop.
			contextLimit: this.contextLimit,
			...(this.model === 'Auto'
				? {
					model: 'auto',
					...(autoPool && autoPool.length > 0 ? { autoPool, autoMode: this.autoMode } : {}),
				}
				: {
					model: configured?.modelId ?? this.model,
					...(provider ? { provider } : {}),
				}),
			...(this.attachedFiles.length > 0 ? { context: { files: this.attachedFiles } } : {}),
		};
		// Phase 71: Plan mode streams the research phase (read-only loop →
		// structured plan) — the plan event opens the approval card and the
		// execute phase streams into the same turn after Build. Agent mode
		// streams tool activity (tool_start / tool_result / file_delta)
		// rendered as cards between the user turn and the answer.
		const streamPromise = this.mode === 'plan'
			? this.vibeAIService.planStream(requestId, request)
			: this.mode === 'agent'
				? this.vibeAIService.agentStream(requestId, request)
				: this.vibeAIService.chatStream(requestId, request);
		streamPromise.catch(err => {
			// Network-level failures surface as `error` events on onStreamData;
			// this catch only guards against unexpected channel rejections.
			this.logService.error('[VibeAI] stream rejected', err);
		}).finally(() => {
			// The done event usually finishes the stream first; this only
			// runs when the promise settles without one (defensive). Captured
			// per-send so a newer turn in another tab is not torn down — and
			// (Phase 45) so a turn skipped right after this send no-ops here
			// instead of tearing down its successor.
			this.finishStreaming(conversation, requestId);
		});
	}

	private handleStreamData(data: IVibeAIStreamData): void {
		// Phase 44: route the event to the conversation that owns this
		// request — several tabs can stream in parallel, each rendering
		// into its own thread.
		const conversation = this.conversations.find(candidate => candidate.stream?.requestId === data.requestId);
		if (!conversation?.stream) {
			return;
		}

		switch (data.type) {
			case 'thinking':
				// Phase 60: contiguous thinking deltas stream into the same
				// Thought block; after any other block run a thinking delta
				// closes it and opens a NEW Thought block at the row end
				// (chronological position — multiple thoughts per turn).
				if (conversation.stream.lastBlockKind !== 'thinking') {
					this.closeRunsBefore(conversation, 'thinking');
					this.ensureThinkingRun(conversation);
				}
				conversation.stream.turn.thinking += data.text ?? '';
				this.updateThinkingElement(conversation);
				conversation.stream.lastBlockKind = 'thinking';
				break;
			case 'text':
				// Phase 60: the first text delta after thinking/tool activity
				// closes those runs and opens a NEW body at the row end —
				// the narration lands between the blocks it follows, in run
				// order (round_end never reaches the frontend; the event
				// order is the split signal — Cursor-parity interleaving).
				if (conversation.stream.lastBlockKind !== 'text') {
					this.closeRunsBefore(conversation, 'text');
					this.ensureTextRun(conversation);
					// Phase 84.9: NO fold at run start — an intermediate
					// narration streams BELOW the still-open Worked shell
					// (user request: only the FINAL answer collapses it).
					// When tool activity resumes, closeTextRun(intoWork)
					// tucks the narration into the shell. Phase 84.11: the
					// final answer announces itself mid-run — updateText-
					// Element folds the shell the moment this run outgrows
					// NARRATION_MAX_CHARS (a longer run cannot be a narration;
					// it would fold into the shell truncated anyway) and the
					// body drops the bounded window to stream directly.
				}
				conversation.stream.turn.text += data.text ?? '';
				this.updateTextElement(conversation);
				conversation.stream.lastBlockKind = 'text';
				break;
			case 'error': {
				const message = data.message ?? localize('vibeAIChat.unknownError', "Unknown backend error");
				// Phase 45: remember the error for the turn record (persisted).
				if (conversation.stream) {
					conversation.stream.lastError = message;
				}
				this.showError(message, conversation);
				break;
			}
			case 'done':
				this.finishStreaming(conversation, data.requestId);
				break;
			case 'tool_start':
				this.handleToolStart(conversation, data);
				break;
			case 'tool_result':
				this.handleToolResult(conversation, data);
				break;
			case 'file_delta':
				this.handleFileDelta(conversation, data);
				break;
			case 'context_compressed':
				this.handleContextCompressed(conversation, data);
				break;
			case 'output_truncated':
				// Phase 51: the round hit its per-round output budget
				// (finish_reason=length) — truncation note (Cursor parity).
				this.handleOutputTruncated(conversation);
				break;
			case 'model_routed':
				// Phase 70: the Auto router picked the model for this turn
				// (first round + every fallback switch) — footer-adjacent
				// note (Cursor-parity underlying-model display).
				this.handleModelRouted(conversation, data);
				break;
			case 'plan':
				// Phase 71: the research phase produced the structured plan
				// (or failed to — the retry note). Opens the approval card;
				// the turn stays open until the user builds or cancels.
				this.handlePlanReady(conversation, data);
				break;
			case 'plan_start':
				// Phase 71: the execute phase kicked off for the approved
				// plan — the card switches to progress mode.
				this.handlePlanStart(conversation, data);
				break;
			case 'plan_step_start':
				// Phase 71: one plan step began (its agent events follow).
				this.handlePlanStepStart(conversation, data);
				break;
			case 'plan_step_done':
				// Phase 71: one plan step finished.
				this.handlePlanStepDone(conversation, data);
				break;
			case 'plan_done':
				// Phase 71: the whole plan executed — the roll-up.
				this.handlePlanDone(conversation, data);
				break;
			// round_end carries no renderable payload.
		}
	}

	// ==================== Phase 71: Plan mode (Cursor parity) ====================

	/**
	 * Phase 71: the research phase produced the structured plan (the
	 * `plan` event). Closes the open research runs so the card lands
	 * after them and renders the approval card (summary + steps + Build /
	 * Cancel). A plan-less event = the backend failed to produce a valid
	 * plan — a retry note renders instead.
	 */
	private handlePlanReady(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow) {
			return;
		}
		// Close the research runs so the card appends after them (the
		// execute phase's blocks append after the card — run order).
		this.closeRunsBefore(conversation, 'plan');
		// Reset the open-run signal — a stale kind (the last research run)
		// would swallow the execute phase's first text/thinking deltas
		// (no new block run would open for them).
		state.lastBlockKind = undefined;
		state.pendingPlan = data.plan;
		if (!data.plan) {
			const note = DOM.append(state.currentAssistantRow, $('.vibe-ai-plan-failed-note'));
			note.textContent = localize(
				'vibeAIChat.planFailed',
				"Plan generation failed — the model didn't return a valid plan. Try again or switch to Agent mode."
			);
			this.scrollBottom(conversation, true);
			return;
		}
		state.planPhase = 'awaiting';
		this.renderPlanCard(conversation, state.currentAssistantRow, data.plan, 'awaiting');
		this.scrollBottom(conversation, true);
	}

	/**
	 * Phase 71: builds the plan card — header (icon + title + progress),
	 * optional summary, the numbered step rows and, while `awaiting`, the
	 * Build / Cancel actions. Re-renders in place during the execute
	 * phase (plan_start re-opens the same card as progress mode). The
	 * restore path passes the persisted per-step `results`.
	 */
	private renderPlanCard(conversation: VibeAIConversation, parent: HTMLElement, plan: IVibeAIPlan, status: VibeAIPlanCardStatus, results?: { stepsDone: number[]; stepsFailed: number[] }): void {
		const state = conversation.stream;
		// A re-render during the execute phase replaces the old card.
		if (state?.planCardRoot) {
			state.planCardRoot.remove();
			state.planCardRoot = undefined;
			state.planProgress = undefined;
			state.planStepRows = undefined;
		}
		const card = DOM.append(parent, $('.vibe-ai-plan-card'));
		card.classList.add(`vibe-ai-plan-${status}`);
		const header = DOM.append(card, $('.vibe-ai-plan-header'));
		const icon = DOM.append(header, $('span.codicon.codicon-checklist.vibe-ai-plan-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const title = DOM.append(header, $('span.vibe-ai-plan-title'));
		title.textContent = localize('vibeAIChat.planTitle', "Plan");
		const progress = DOM.append(header, $('span.vibe-ai-plan-progress'));
		progress.textContent = status === 'awaiting'
			? localize('vibeAIChat.planStepsCount', "{0} steps", plan.steps.length)
			: localize('vibeAIChat.planStepOfShort', "{0}/{1} steps done", results?.stepsDone.length ?? 0, plan.steps.length);
		if (state) {
			state.planCardRoot = card;
			state.planProgress = progress;
			state.planStepRows = new Map<number, HTMLElement>();
		}
		if (plan.summary && plan.summary.length > 0) {
			const summary = DOM.append(card, $('.vibe-ai-plan-summary'));
			summary.textContent = plan.summary;
		}
		const steps = DOM.append(card, $('.vibe-ai-plan-steps'));
		for (const step of plan.steps) {
			const stepRow = DOM.append(steps, $('.vibe-ai-plan-step'));
			stepRow.dataset['step'] = String(step.id);
			const stepIcon = DOM.append(stepRow, $('span.codicon.vibe-ai-plan-step-icon'));
			stepIcon.setAttribute('aria-hidden', 'true');
			const stepTitle = DOM.append(stepRow, $('span.vibe-ai-plan-step-title'));
			stepTitle.textContent = step.title;
			if (state?.planStepRows) {
				state.planStepRows.set(step.id, stepRow);
			}
			if (status === 'cancelled') {
				// A cancelled plan shows every step as not taken (gray).
				stepRow.classList.add('cancelled');
				stepIcon.classList.add('codicon-circle-slash');
			} else if (status === 'awaiting' || status === 'executing') {
				// Pending until its plan_step_start arrives.
				stepIcon.classList.add('codicon-circle-large-outline');
			}
		}
		// The awaiting card keeps the turn open until the user picks.
		if (status === 'awaiting') {
			this.renderPlanActions(conversation, card, plan);
		}
		// Executed plans show the recorded per-step results.
		if (status === 'executed') {
			this.applyPlanResults(card, plan, results ?? { stepsDone: [], stepsFailed: [] });
		}
	}

	/**
	 * Phase 71: the awaiting card's Build / Cancel actions. Build starts
	 * the execute phase (same turn while live, a fresh turn from a
	 * restored card); Cancel folds the turn closed with the plan kept as
	 * not-executed.
	 */
	private renderPlanActions(conversation: VibeAIConversation, card: HTMLElement, plan: IVibeAIPlan): void {
		const actions = DOM.append(card, $('.vibe-ai-plan-actions'));
		const build = DOM.append(actions, $('button.vibe-ai-plan-build')) as HTMLButtonElement;
		build.textContent = localize('vibeAIChat.planBuild', "Build");
		build.type = 'button';
		this.conversationPlanDisposables(conversation).add(DOM.addDisposableListener(build, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.executePlanFromCard(conversation, plan);
		}));
		const cancel = DOM.append(actions, $('button.vibe-ai-plan-cancel')) as HTMLButtonElement;
		cancel.textContent = localize('vibeAIChat.planCancel', "Cancel");
		cancel.type = 'button';
		this.conversationPlanDisposables(conversation).add(DOM.addDisposableListener(cancel, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			// Fold this card to its cancelled state (also works on a
			// restored card, where there is no live turn to close).
			card.classList.remove('vibe-ai-plan-awaiting');
			card.classList.add('vibe-ai-plan-cancelled');
			actions.remove();
			this.cancelPlan(conversation);
		}));
	}

	/**
	 * Phase 71: the listener store for a plan card's buttons — the live
	 * turn's per-turn disposables (die with the next turn in this
	 * conversation); a restored card uses the conversation's record
	 * disposables (die with the tab).
	 */
	private conversationPlanDisposables(conversation: VibeAIConversation): DisposableStore {
		return conversation.stream ? conversation.turnDisposables : conversation.turnRecordDisposables;
	}

	/**
	 * Phase 71: the user approved the plan (Build). While the research
	 * turn is still open the execute phase streams into the SAME turn —
	 * the stream state is kept, only its requestId rotates (the events
	 * route by it). A restored awaiting card (no live turn) opens a fresh
	 * turn and streams into it instead.
	 */
	private executePlanFromCard(conversation: VibeAIConversation, plan: IVibeAIPlan): void {
		const state = conversation.stream;
		if (state && state.planPhase === 'awaiting' && state.pendingPlan === plan && state.currentAssistantRow) {
			// Live awaiting turn: keep streaming the execute phase into it
			// (the identity check binds the card's own plan — a stale
			// restored card's plan opens a fresh turn below instead).
			const requestId = `vibe-${++this.requestCounter}`;
			state.requestId = requestId;
			state.pendingPlan = plan;
			state.planPhase = 'executing';
			this.renderPlanCard(conversation, state.currentAssistantRow, plan, 'executing');
			this.updateInputActions();
			this.renderTabs();
			this.dispatchPlanExecute(conversation, requestId, plan);
		} else {
			// Restored awaiting card: the original turn has no live stream
			// — a fresh assistant turn renders the execute phase.
			const requestId = `vibe-${++this.requestCounter}`;
			this.startAssistantTurn(conversation, requestId, '', undefined);
			const fresh = conversation.stream;
			if (!fresh) {
				return;
			}
			fresh.planPhase = 'executing';
			fresh.pendingPlan = plan;
			if (fresh.currentAssistantRow) {
				this.renderPlanCard(conversation, fresh.currentAssistantRow, plan, 'executing');
			}
			this.updateInputActions();
			this.renderTabs();
			this.dispatchPlanExecute(conversation, requestId, plan);
		}
		this.scrollBottom(conversation, true);
	}

	/**
	 * Phase 71: renders a restored plan card from a persisted turn record
	 * (history restore): executed plans show the recorded per-step
	 * results, cancelled ones their gray state — an `awaiting` status
	 * (never persisted in practice, defensive) keeps the buttons so the
	 * plan can still be executed after a reload.
	 */
	private renderRestoredPlanCard(conversation: VibeAIConversation, row: HTMLElement, turn: IVibeAIPersistedTurn): void {
		if (!turn.plan || turn.plan.steps.length === 0) {
			return;
		}
		const status: VibeAIPlanCardStatus = turn.planStatus ?? 'executed';
		this.renderPlanCard(conversation, row, turn.plan, status, turn.planResults);
	}

	/** Streams the execute phase for the approved plan (Phase 71). */
	private dispatchPlanExecute(conversation: VibeAIConversation, requestId: string, plan: IVibeAIPlan): void {
		// No default-model fallback: resolve routing first so the no-model
		// gate can fail the execute phase fast (every step would 400 anyway).
		const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		const autoPool = this.model === 'Auto' ? this.buildAutoPool() : undefined;
		if (!this.hasUsableModel(configured, provider, autoPool)) {
			this.showError(VIBE_AI_NO_MODEL_MESSAGE, conversation);
			this.finishStreaming(conversation, requestId);
			return;
		}
		const request = this.buildPlanExecuteRequest(conversation, plan, autoPool);
		this.vibeAIService.executePlanStream(requestId, request).catch(err => {
			this.logService.error('[VibeAI] plan execute stream rejected', err);
		}).finally(() => {
			// The done event usually finishes the stream first; this only
			// runs when the promise settles without one (defensive).
			this.finishStreaming(conversation, requestId);
		});
	}

	/**
	 * Phase 71: builds the execute request — the approved plan + the
	 * conversation so far (the last message is the plan turn's user
	 * request) + the active conversation's model/context mirrors.
	 */
	private buildPlanExecuteRequest(conversation: VibeAIConversation, plan: IVibeAIPlan, autoPool?: IVibeAIModelProvider[]): IVibeAIExecutePlanRequest {
		const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		return {
			plan,
			messages: [...conversation.history],
			stream: true,
			contextLimit: this.contextLimit,
			// The execute endpoint routes like chat turns: a provider
			// override for a named model, or the Auto pool + Optimize For
			// mode for 'auto' (each step's agent routes over it). No
			// default-model fallback — dispatchPlanExecute gates first.
			...(this.model !== 'Auto'
				? { model: configured?.modelId ?? this.model, ...(provider ? { provider } : {}) }
				: { model: 'auto', autoPool, autoMode: this.autoMode }),
			...(conversation.attachedFiles.length > 0 ? { context: { files: conversation.attachedFiles } } : {}),
		};
	}

	/**
	 * Phase 71: the user cancelled the plan — the turn folds closed with
	 * the card kept as not-executed (persisted with planStatus
	 * 'cancelled' so the restored card shows it).
	 */
	private cancelPlan(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || state.planPhase !== 'awaiting') {
			return;
		}
		state.planPhase = undefined;
		// Fold the card to its cancelled state (actions removed).
		if (state.planCardRoot) {
			state.planCardRoot.classList.remove('vibe-ai-plan-awaiting');
			state.planCardRoot.classList.add('vibe-ai-plan-cancelled');
			state.planCardRoot.querySelector('.vibe-ai-plan-actions')?.remove();
		}
		this.finishStreaming(conversation, state.requestId);
	}

	/** Phase 71: the execute phase kicked off — the card becomes progress. */
	private handlePlanStart(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const row = state?.currentAssistantRow;
		if (!state || !row) {
			return;
		}
		state.planPhase = 'executing';
		const plan = data.plan ?? state.pendingPlan;
		if (plan) {
			state.pendingPlan = plan;
			this.renderPlanCard(conversation, row, plan, 'executing');
		} else {
			// Defensive: a plan_start without a plan folds the awaiting
			// card's actions off (no approval picks mid-execution).
			state.planCardRoot?.querySelector('.vibe-ai-plan-actions')?.remove();
		}
		this.updatePlanProgress(conversation, 0, 0);
		this.scrollBottom(conversation);
	}

	/** Phase 71: one plan step began — its row shows the loading state. */
	private handlePlanStepStart(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const step = data.planStep;
		if (!state || !step) {
			return;
		}
		const row = state.planStepRows?.get(step.step);
		if (row) {
			row.classList.add('running');
			const icon = row.querySelector('.vibe-ai-plan-step-icon');
			if (icon) {
				icon.className = 'codicon codicon-loading vibe-ai-plan-step-icon';
			}
		}
		if (step.index !== undefined && step.total !== undefined) {
			// The running step's number (Cursor-parity "Step 2/5 — title").
			this.updatePlanProgress(conversation, step.index, step.total, step.title);
		}
		this.scrollBottom(conversation);
	}

	/** Phase 71: one plan step finished — check or error per its status. */
	private handlePlanStepDone(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const step = data.planStep;
		if (!state || !step) {
			return;
		}
		const failed = (step.failedTools ?? 0) > 0;
		const row = state.planStepRows?.get(step.step);
		if (row) {
			row.classList.remove('running');
			row.classList.toggle('failed', failed);
			const icon = row.querySelector('.vibe-ai-plan-step-icon');
			if (icon) {
				icon.className = `codicon vibe-ai-plan-step-icon ${failed ? 'codicon-error' : 'codicon-check'}`;
			}
		}
		if (step.total !== undefined) {
			this.updatePlanProgress(conversation, undefined, step.total);
		}
		this.scrollBottom(conversation);
	}

	/** Phase 71: the whole plan executed — the roll-up into the card. */
	private handlePlanDone(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const summary = data.planSummary;
		if (!state) {
			return;
		}
		state.planResults = summary
			? { stepsDone: [...summary.stepsDone], stepsFailed: [...summary.stepsFailed] }
			: { stepsDone: [], stepsFailed: [] };
		if (summary && state.planCardRoot && state.pendingPlan) {
			this.applyPlanResults(state.planCardRoot, state.pendingPlan, state.planResults);
		}
		this.updatePlanProgress(conversation, summary?.stepsDone.length, summary?.steps ?? 0);
		this.scrollBottom(conversation);
	}

	/** Phase 71: updates the plan card's header progress label. */
	private updatePlanProgress(conversation: VibeAIConversation, done: number | undefined, total: number, title?: string): void {
		const state = conversation.stream;
		if (!state?.planProgress) {
			return;
		}
		if (done !== undefined && total > 0) {
			state.planProgress.textContent = title
				? localize('vibeAIChat.planStepOf', "Step {0}/{1} — {2}", done, total, title)
				: localize('vibeAIChat.planStepOfShort', "{0}/{1} steps done", done, total);
		}
	}

	/** Phase 71: applies the final per-step results to the card's rows. */
	private applyPlanResults(card: HTMLElement, plan: IVibeAIPlan, results: { stepsDone: number[]; stepsFailed: number[] } | undefined): void {
		if (!results) {
			return;
		}
		for (const step of plan.steps) {
			const row = card.querySelector(`.vibe-ai-plan-step[data-step="${step.id}"]`);
			const isFailed = results.stepsFailed.includes(step.id);
			const isDone = results.stepsDone.includes(step.id);
			if (row) {
				row.classList.toggle('failed', isFailed);
				const icon = row.querySelector('.vibe-ai-plan-step-icon');
				if (icon) {
					icon.className = `codicon vibe-ai-plan-step-icon ${isFailed ? 'codicon-error' : isDone ? 'codicon-check' : 'codicon-circle-large-outline'}`;
				}
			}
		}
	}

	/**
	 * Cursor-style activity cards: a pending card per tool call, inserted
	 * between the user turn and the assistant answer. Every card is kept —
	 * the full history survives for expand; Phase 81: NO compact mode —
	 * every card (file reads included) is visible and STAYS visible while
	 * the agent works; Phase 84.9: the shell never folds mid-turn — it
	 * stays open through intermediate narrations. Phase 84.11: the final
	 * answer folds the shell mid-run (updateTextElement, once the run
	 * outgrows the narration budget) — a shell folded that way reopens
	 * here when tool activity resumes (the misfire path), so live steps
	 * always show while the agent works.
	 */
	private handleToolStart(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const id = data.tool?.id;
		if (!id || !state || !state.currentAssistantRow) {
			return;
		}
		// A repeated id replaces its card (defensive; ids are unique per call).
		state.toolCards.get(id)?.dispose();
		state.toolCards.get(id)?.element.remove();
		const card = new VibeAIToolCard(
			data.tool?.name ?? '',
			data.tool?.arguments,
			this.languageService,
			change => this.restoreChange(change),
			(path, line, endLine) => this.openFile(path, line, endLine),
		);
		state.toolCards.set(id, card);
		// Phase 61: ONE Worked block per turn — the FIRST tool call creates
		// the turn-scoped shell and moves the already-rendered activity
		// (thinking blocks, narration bodies) inside; every card appends
		// into its steps container. Consecutive tool events keep appending.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			// Phase 84.9: no reopen dance — intermediate narrations leave
			// the shell open, so resuming tool activity normally finds it
			// already expanded. Phase 84.11: the ONE exception is the
			// mid-run answer-focus fold — a run that outgrew the narration
			// budget and turned out to be a narration after all (tool
			// activity resumed) folded the shell; reopen it inline so the
			// live steps stay visible while the agent works, and un-freeze
			// the fold duration for the final fold at turn end.
			if (state.workShell && state.workLabel && !state.workShell.open) {
				state.workShell.open = true;
				state.workFoldedMs = undefined;
				state.workLabel.textContent = localize('vibeAIChat.working', "Working…");
			}
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.toolsRunToolIds.push(id);
		state.workAnyTool = true;
		state.workSteps?.appendChild(card.element);
		if (data.tool?.name === 'write_file') {
			state.pendingWriteCardId = id;
		}
		// The shell stays open while streaming — every step is visible and
		// stays (Phase 81, no compact mode); chase the bottom.
		this.scrollBottom(conversation);
	}

	private handleToolResult(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const id = data.tool?.id;
		if (!id || !state) {
			return;
		}
		state.toolCards.get(id)?.setResult(data.tool?.status, data.tool?.result, data.tool?.codeChange, data.tool?.output, data.tool?.read);
		if (data.tool?.codeChange) {
			// Phase 59: the turn keeps only the FINAL result per file — a
			// second write (or delete) to an already-tracked file updates
			// its entry instead of adding a duplicate row to the files
			// summary (see consolidateChanges).
			state.turnChanges = consolidateChanges([...state.turnChanges, data.tool.codeChange]);
			// Phase 57: highlight the modified places in the open editor with
			// the chat diff card's colors (Cursor editor overlay parity).
			this.editorHighlighter?.highlight(data.tool.codeChange, path => this.resolveWorkspacePath(path));
		}
		if (state.pendingWriteCardId === id) {
			state.pendingWriteCardId = undefined;
		}
		// Phase 61: the shell's compact mode always shows the latest step —
		// chase the bottom.
		this.scrollBottom(conversation);
	}

	private handleFileDelta(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		// Streaming write_file content: surface inside the pending card
		// (Cursor-style live preview while the model generates).
		const state = conversation.stream;
		const id = data.tool?.id ?? state?.pendingWriteCardId;
		if (!id || !state) {
			return;
		}
		state.toolCards.get(id)?.appendStreamText(data.delta ?? '');
		// Phase 61: the pending write card is the latest step inside the
		// shell (always visible in compact mode) — chase the bottom.
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 41: the backend compressed (cropped) the conversation history
	 * before running the agent loop — surface a subtle note between turns
	 * (Cursor-style compression transparency).
	 */
	private handleContextCompressed(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		// The note belongs to the streaming conversation's thread.
		const container = conversation.container;
		if (!container) {
			return;
		}
		// Phase 45: remember the compression for the turn record (persisted).
		if (conversation.stream) {
			conversation.stream.contextCompressed = true;
		}
		const note = DOM.append(container, $('.vibe-ai-context-compressed-note'));
		const before = data.before;
		const after = data.after;
		if (before !== undefined && after !== undefined) {
			note.textContent = localize(
				'vibeAIChat.contextCompressed',
				"Conversation history compressed to fit the context limit ({0} → {1} tokens)",
				formatContextTokens(before),
				formatContextTokens(after)
			);
		} else {
			note.textContent = localize('vibeAIChat.contextCompressedGeneric', "Conversation history compressed to fit the context limit");
		}
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 51: the backend round hit its per-round output budget
	 * (finish_reason=length — long reasoning on thinking models squeezes
	 * out the answer/tool arguments). Surface a subtle truncation note
	 * (Cursor-style transparency) instead of a silent "(no response)".
	 */
	private handleOutputTruncated(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		// Remember for the turn record (persisted — restore parity below).
		state.outputTruncated = true;
		// Immediate note below the in-flight answer; an empty answer says it
		// in the finish placeholder instead (no duplicate note).
		if (state.turn.text.length > 0 && state.currentAssistantRow) {
			const note = DOM.append(state.currentAssistantRow, $('.vibe-ai-output-truncated-note'));
			note.textContent = localize(
				'vibeAIChat.outputTruncated',
				"Response truncated — the model hit its per-round output budget (raise backend LLM_AGENT_MAX_TOKENS)"
			);
			this.scrollBottom(conversation);
		}
	}

	/**
	 * Phase 70: the backend's Auto router picked the model for this turn —
	 * intent+complexity routing over the Settings → Models pool (Cursor-
	 * parity underlying-model display, on by default via
	 * `vibeAI.chat.autoReveal`; a deliberate deviation from Cursor's
	 * default-hidden display for single-machine debugging). Renders as a
	 * subtle note at the assistant row end (directly above the footer);
	 * fallback switches update the same note instead of stacking a new
	 * one per model.
	 */
	private handleModelRouted(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const routed = data.modelRouted;
		if (!state || !routed || !routed.model) {
			return;
		}
		// Always recorded on the state (persisted with the turn record);
		// the note itself is opt-out via the setting.
		state.routedModel = routed;
		if (this.configurationService.getValue<boolean>('vibeAI.chat.autoReveal') === false) {
			return;
		}
		const row = state.currentAssistantRow;
		if (!row) {
			return;
		}
		let note = state.modelRoutedNote;
		if (!note) {
			note = DOM.append(row, $('.vibe-ai-model-routed-note'));
			state.modelRoutedNote = note;
		}
		note.textContent = localize(
			'vibeAIChat.modelRouted',
			"Routed to {0} — {1} tier ({2})",
			routed.name,
			routed.tier,
			routed.mode
		);
		note.title = routed.reason;
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 70: the Auto routing pool — every non-disabled imported model
	 * resolved to its provider override (endpoint + key + upstream model
	 * id) plus its tier hint. Same trust model as the single-model
	 * `provider` passthrough: connections configured in Settings → Models
	 * are sent to the local backend only.
	 */
	/**
	 * Whether a request can go out at all: a specific model with a
	 * resolvable provider, or Auto with a non-empty pool. No default-model
	 * fallback — nothing configured means no request (the backend would
	 * 400 with 沒有模型可用; gating here skips the round-trip).
	 */
	private hasUsableModel(
		configured: IVibeAIModelConfig | undefined,
		provider: IVibeAIModelProvider | undefined,
		autoPool: IVibeAIModelProvider[] | undefined,
	): boolean {
		if (this.model === 'Auto') {
			return (autoPool?.length ?? 0) > 0;
		}
		return !!configured && !!provider;
	}

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

	private async restoreChange(change: IVibeAICodeChange): Promise<boolean> {
		if (change.oldContent === undefined || change.oldContent === null) {
			return false;
		}
		return this.vibeAIService.restoreFile(change.filePath, change.oldContent);
	}

	/**
	 * Reverts a list of file changes — updates are restored to their
	 * pre-change content and newly created files are deleted again.
	 * Reverted newest-first so a file written several times in one turn
	 * ends at its original content (Phase 59: turn changes are
	 * consolidated to one entry per file keeping the pre-turn
	 * `oldContent`, so a single restore per file converges). Deletions
	 * are skipped (their
	 * pre-change content is unknown to the client). Shared by the files
	 * summary "Discard", the per-turn restore button and the checkpoint
	 * rollback (Phase 45).
	 */
	private async revertChanges(changes: IVibeAICodeChange[]): Promise<boolean> {
		// The turn's changes are captured at render time — a late Discard
		// click reverts exactly that turn's changes even if a newer turn
		// started since (Phase 44: each turn owns its state).
		let allOk = true;
		for (let i = changes.length - 1; i >= 0; i--) {
			const change = changes[i];
			try {
				let ok: boolean;
				if (change.action === 'delete') {
					ok = true;
				} else if (change.action === 'create' || change.oldContent === undefined || change.oldContent === null) {
					// The file did not exist before this turn — discarding
					// means deleting it again from disk.
					ok = await this.vibeAIService.deleteFile(change.filePath);
				} else {
					ok = await this.restoreChange(change);
				}
				allOk = allOk && ok;
			} catch (err) {
				this.logService.error('[VibeAI] discard change failed', err);
				allOk = false;
			}
		}
		return allOk;
	}

	private renderUserTurn(conversation: VibeAIConversation, text: string, images?: string[]): HTMLElement {
		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-user'));
		// Phase 61: sent images render as a thumbnail strip ABOVE the
		// bubble (the bubble stays text-only — the prompt-edit delegation
		// replaces its content with the edit composer, which is text-only).
		if (images && images.length > 0) {
			const thumbs = DOM.append(row, $('.vibe-ai-user-images'));
			for (const dataUrl of images) {
				const img = DOM.append(thumbs, $('img.vibe-ai-user-image')) as HTMLImageElement;
				img.src = dataUrl;
				img.alt = '';
			}
		}
		const bubble = DOM.append(row, $('.vibe-ai-user-bubble'));
		// An image-only message has no text — skip the empty bubble.
		if (text.length > 0) {
			bubble.textContent = text;
			// Phase 47: Cursor parity — every sent prompt box is clickable and
			// re-editable at any time (the click handler is delegated once on
			// the messages holder, see registerPromptEditDelegation).
			bubble.title = localize('vibeAIChat.editPromptTitle', "Click to edit and re-send");
		}
		// User action — jump to the bottom regardless of follow-latest.
		this.scrollBottom(conversation, true);
		return row;
	}

	// ==================== Phase 47: sent-prompt edit (Cursor parity) ====================

	/**
	 * Phase 47: Cursor-parity sent-prompt editing — a single delegated
	 * click listener on the messages holder covers every conversation
	 * thread and every user bubble (live turns and restored sessions):
	 * clicking a sent prompt box turns it into an in-place editable
	 * textarea; Enter re-sends from that turn, Esc / a click outside
	 * cancels (see {@link enterPromptEdit}).
	 */
	private registerPromptEditDelegation(): void {
		if (!this.messagesContainer) {
			return;
		}
		// Distinguish a real click from a text-selection drag: a drag that
		// moves more than a few pixels keeps the selection (no edit mode).
		let downX = 0;
		let downY = 0;
		this._register(DOM.addDisposableListener(this.messagesContainer, DOM.EventType.MOUSE_DOWN, e => {
			downX = e.clientX;
			downY = e.clientY;
		}));
		this._register(DOM.addDisposableListener(this.messagesContainer, DOM.EventType.CLICK, e => {
			const target = e.target as HTMLElement | null;
			const bubble = target?.closest<HTMLElement>('.vibe-ai-user-bubble');
			if (!bubble) {
				return;
			}
			// A text-selection drag (the pointer moved while selecting) is
			// not an edit click — keep the selection.
			if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) {
				return;
			}
			// Already editing this box — let the textarea handle the click
			// instead of restarting the edit.
			if (this.promptEdit?.bubble === bubble) {
				return;
			}
			const thread = bubble.closest<HTMLElement>('.vibe-ai-chat-thread');
			const conversation = this.conversations.find(candidate => candidate.container === thread);
			if (!conversation) {
				return;
			}
			this.enterPromptEdit(conversation, bubble);
		}));
	}

	/**
	 * Cursor parity: turns a sent prompt box into an in-place editable
	 * composer — the exact clone of the main input box (chips row +
	 * textarea + mode/model toolbar, Phase 48). Enter (no Shift, and
	 * never while an IME is composing) commits — everything after that
	 * turn is discarded and the edited prompt is re-sent as a fresh turn
	 * (see {@link commitPromptEdit}); Esc or a click outside restores the
	 * original text.
	 */
	private enterPromptEdit(conversation: VibeAIConversation, bubble: HTMLElement): void {
		const row = bubble.closest<HTMLElement>('.vibe-ai-turn-user');
		if (!row) {
			return;
		}
		// Only one prompt box edits at a time (Cursor parity).
		this.cancelPromptEdit();
		const originalText = bubble.textContent ?? '';
		bubble.textContent = '';
		bubble.classList.add('vibe-ai-user-editing');
		// Phase 48: the edit box rebuilds the main input's exact composer
		// DOM — chips row + textarea + toolbar inside the same rounded
		// container — so it is pixel-identical to the input below and the
		// mode/model dropdowns stay in sync (shared pane state).
		const shell = DOM.append(bubble, $('.vibe-ai-input-container.vibe-ai-user-edit-shell'));
		const chipsRow = DOM.append(shell, $('.vibe-ai-input-chips'));
		chipsRow.style.display = 'none';
		const textarea = DOM.append(shell, $('textarea.vibe-ai-input.vibe-ai-user-edit')) as HTMLTextAreaElement;
		textarea.rows = 1;
		textarea.wrap = 'soft';
		textarea.spellcheck = false;
		textarea.value = originalText;
		const listeners = new DisposableStore();
		const chipsListeners = new DisposableStore();
		const edit: VibeAIPromptEdit = {
			conversation,
			row,
			bubble,
			textarea,
			originalText,
			committing: false,
			listeners,
			chipsListeners,
			shell,
			chipsRow,
			modeButton: undefined,
			modeIcon: undefined,
			modeLabel: undefined,
			modelButton: undefined,
			modelLabel: undefined,
			ringButton: undefined,
			ringArc: undefined,
			sendButton: undefined,
			stopButton: undefined,
			micButton: undefined,
		};
		this.promptEdit = edit;
		// The toolbar comes from the same builder the main input uses; its
		// refs live on the edit state and die with it (listeners included).
		const toolbar = this.buildInputToolbar(shell, listeners, {
			sendTitle: localize('vibeAIChat.resend', "Re-send (Enter)"),
			onSend: () => this.commitPromptEdit(),
			// Phase 50: no context usage ring on a resent prompt.
			showContextRing: false,
		});
		edit.modeButton = toolbar.modeButton;
		edit.modeIcon = toolbar.modeIcon;
		edit.modeLabel = toolbar.modeLabel;
		edit.modelButton = toolbar.modelButton;
		edit.modelLabel = toolbar.modelLabel;
		edit.ringButton = toolbar.ringButton;
		edit.ringArc = toolbar.ringArc;
		edit.sendButton = toolbar.sendButton;
		edit.stopButton = toolbar.stopButton;
		edit.micButton = toolbar.micButton;
		// Mirror the shared state into the fresh toolbar (mode/model
		// labels, attached chips, action buttons) — identical to the
		// input below at the moment the edit opens.
		this.updateModeLabel();
		this.updateModelLabel();
		this.renderChips();
		this.updateEditToolbarActions();
		this.autoGrowPromptEdit();
		textarea.focus();
		// Caret at the end of the prompt (Cursor parity).
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		listeners.add(DOM.addDisposableListener(textarea, DOM.EventType.KEY_DOWN, e => {
			// Enter re-sends (Shift+Enter inserts a newline); never commit
			// while an IME is composing (keyCode 229 = IME-processed key,
			// Chinese/Japanese/Korean input safety).
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				if (!e.isComposing && e.keyCode !== 229) {
					this.commitPromptEdit();
				}
			} else if (e.key === 'Escape') {
				// Esc cancels — swallow it so no workbench keybinding fires.
				e.preventDefault();
				e.stopPropagation();
				this.cancelPromptEdit();
			}
		}));
		listeners.add(DOM.addDisposableListener(textarea, DOM.EventType.INPUT, () => {
			this.autoGrowPromptEdit();
			this.updateEditToolbarActions();
		}));
		// Phase 50 (final): click-outside is decided ONLY by the
		// document-level capture pointerdown guard below — a press outside
		// the edit shell cancels, a press inside the shell or inside a
		// workbench overlay (the edit's own mode/model context menu, the
		// custom-model quick input) keeps it. The earlier textarea blur
		// listener is gone on purpose: workbench focus choreography (the
		// menu grabbing focus on open, focus restore on hide, focusToReturn
		// being skipped) fires blur with activeElement in unpredictable
		// places (body, workbench root), which wrongly cancelled the edit
		// whenever its own dropdown was used. With no blur listener at all
		// no focus event can ever close the edit.
		listeners.add(DOM.addDisposableListener(textarea.ownerDocument, 'pointerdown', e => {
			const target = e.target as Node | null;
			if (!target) {
				return;
			}
			if (edit.shell.contains(target)) {
				return;
			}
			if (target instanceof Element && target.closest('.context-view, .quick-input-widget')) {
				return;
			}
			this.cancelPromptEdit();
		}, true));
	}

	/** Auto-grows the in-place prompt edit box (same cap as the main input). */
	private autoGrowPromptEdit(): void {
		const textarea = this.promptEdit?.textarea;
		if (!textarea) {
			return;
		}
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, INPUT_MAX_HEIGHT)}px`;
	}

	/** Restores the edited prompt's static text and tears the edit down. */
	private cancelPromptEdit(): void {
		const edit = this.promptEdit;
		if (!edit) {
			return;
		}
		this.promptEdit = undefined;
		edit.listeners.dispose();
		edit.chipsListeners.dispose();
		edit.bubble.classList.remove('vibe-ai-user-editing');
		edit.bubble.textContent = edit.originalText;
	}

	/**
	 * Enter on the in-place prompt edit: discards the edited turn and
	 * everything after it (Cursor parity — a resubmit never appends) and
	 * re-sends the edited prompt as a fresh turn. An empty edit is
	 * treated as a cancel.
	 */
	private commitPromptEdit(): void {
		const edit = this.promptEdit;
		if (!edit) {
			return;
		}
		const text = edit.textarea.value.trim();
		if (text.length === 0) {
			// An empty prompt never sends (main-input parity) — cancel.
			this.cancelPromptEdit();
			return;
		}
		edit.committing = true;
		const { conversation, row, bubble } = edit;
		if (conversation.id !== this.activeConversationId) {
			// Only the active conversation's thread is visible, so this
			// cannot normally happen — guard the mirror-state invariant
			// (dispatchTurn reads the active conversation's mirrors).
			edit.committing = false;
			this.cancelPromptEdit();
			return;
		}
		// Discard this and every later turn from view + state (also aborts
		// the conversation's in-flight stream) — returns the turn's index.
		const turnIndex = this.truncateFromUserTurn(conversation, row);
		if (turnIndex === -1) {
			edit.committing = false;
			this.cancelPromptEdit();
			return;
		}
		this.promptEdit = undefined;
		edit.listeners.dispose();
		edit.chipsListeners.dispose();
		// The row is the thread's last turn again — restore it as a static
		// bubble with the edited text (tears the edit box down).
		bubble.classList.remove('vibe-ai-user-editing');
		bubble.textContent = text;
		// Push the edited prompt as the turn's (new) user message.
		this.history.push({ role: 'user', content: text });
		// Cursor-parity tab title: when the first prompt was edited, the
		// title may still be derived from the old text — re-derive it.
		if (turnIndex === 0) {
			this.sessionTitle = this.deriveSessionTitle(text);
			this.updateTabTitle();
		}
		// Re-send from the edited turn. Discarded turns' already-written
		// disk changes stay (abort semantics, Cursor parity).
		this.dispatchTurn(conversation, text, row);
	}

	/**
	 * Phase 47: discards the turn owning `userRow` and everything after it
	 * (Cursor-parity edit & resubmit): the conversation's in-flight stream
	 * is aborted first, history and turn records are truncated to just
	 * before that turn, and every rendered row after it is removed.
	 * Returns the turn's index among the thread's user turns (-1 when the
	 * row is not part of the thread — defensive).
	 */
	private truncateFromUserTurn(conversation: VibeAIConversation, userRow: HTMLElement): number {
		// The edited turn's index among the thread's user turns — turn
		// records (one per completed user turn) and flat history pairs
		// (user/assistant) both map 1:1 onto these rows.
		const userRows = Array.from(conversation.container.querySelectorAll('.vibe-ai-turn-user'));
		const turnIndex = userRows.indexOf(userRow);
		if (turnIndex === -1) {
			return -1;
		}
		// Abort the conversation's in-flight stream (Cursor parity: editing
		// while streaming = abort) — its late settle no-ops in
		// finishStreaming (requestId guard). Partial file changes already
		// written to disk stay (abort semantics, same as skipCurrentTurn).
		this.abortStream(conversation);
		// Truncate history at the edited turn's user message: drop it and
		// everything after (the caller pushes the edited text back). Flat
		// pairs map 1:1 onto user turns — count user messages forward.
		let cut = conversation.history.length;
		let seen = -1;
		for (let index = 0; index < conversation.history.length; index++) {
			if (conversation.history[index].role === 'user') {
				seen++;
				if (seen === turnIndex) {
					cut = index;
					break;
				}
			}
		}
		conversation.history.length = cut;
		// Truncate the completed-turn records (Phase 45 artifacts) — they
		// map 1:1 onto user turns from the first one.
		conversation.turns.length = Math.min(conversation.turns.length, turnIndex);
		// Remove every rendered row after the edited user row (assistant
		// rows, footers, error / compression notes) — the row itself stays.
		while (userRow.nextSibling) {
			userRow.nextSibling.remove();
		}
		// Phase 56: the truncated turns are gone — the docked review bar
		// re-picks the latest remaining turn with changes (or hides).
		this.renderDockedFilesSummary();
		// Persist the truncated state immediately so a reload (or the
		// resend's save) never resurrects the discarded turns.
		this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)));
		return turnIndex;
	}

	/**
	 * Opens a new assistant turn row. Phase 60: the turn's blocks (Thought
	 * / Worked / narration bodies / inline cards) are built lazily as
	 * their event runs arrive — each run appends its own block at the row
	 * end, so the DOM order is the agent's run order (think → narrate →
	 * tools → think → …), with multiple Thought / Worked blocks per turn.
	 */
	private startAssistantTurn(conversation: VibeAIConversation, requestId: string, userText: string, userRow: HTMLElement | undefined): void {
		// Per-turn listeners (footer / files summary) die with the next
		// turn in THIS conversation — other tabs' turns are untouched.
		conversation.turnDisposables.clear();

		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-assistant'));

		// Phase 60/61: no eager blocks — the turn row starts empty. Each
		// block run appends its own element lazily as it arrives: a
		// thinking run a collapsible "Thinking…" block (ensureThinkingRun),
		// a text run a markdown body (ensureTextRun), the FIRST tool call
		// the turn's ONE Worked shell (ensureWorkShell) that gathers every
		// activity element (thinking sub-blocks, narration bodies, cards)
		// under a single collapsible. The DOM order is therefore the
		// agent's run order, and the whole turn collapses under one
		// "Worked for Xs" row (a thinking-only turn keeps its plain
		// "Thought for Xs" blocks).

		// Phase 44: the turn's live state hangs off its conversation —
		// parallel tabs each keep their own refs, throttle and artifacts.
		conversation.stream = {
			requestId,
			turn: { text: '', thinking: '' },
			thinkingDetails: undefined,
			thinkingLabel: undefined,
			thinkingText: undefined,
			thinkingAutoOpened: false,
			thinkingRunStartedAt: undefined,
			thinkingRunStart: 0,
			// Phase 61: ONE Worked block per turn — created lazily on the
			// first tool_start (a thinking-only turn never creates one).
			workShell: undefined,
			workSteps: undefined,
			workLabel: undefined,
			workAnyTool: false,
			workRunStartedAt: undefined,
			// Phase 84.9: no fold yet — the shell folds ONCE at turn end
			// (finishStreaming), after the final answer completes.
			workFoldedMs: undefined,
			currentBody: undefined,
			currentAssistantRow: row,
			toolCards: new Map<string, VibeAIToolCard>(),
			pendingWriteCardId: undefined,
			turnChanges: [],
			turnStartedAt: Date.now(),
			userText,
			userRow,
			contextCompressed: false,
			outputTruncated: false,
			// Phase 70: the Auto router's pick (set by model_routed events).
			routedModel: undefined,
			modelRoutedNote: undefined,
			lastError: undefined,
			// Phase 71: Plan mode state — no plan is pending yet.
			planPhase: undefined,
			pendingPlan: undefined,
			planResults: undefined,
			planCardRoot: undefined,
			planProgress: undefined,
			planStepRows: undefined,
			// Phase 60: chronological block runs — no run is open yet; the
			// first event of any kind opens one (see handleStreamData).
			lastBlockKind: undefined,
			textRunStart: 0,
			toolsRunToolIds: [],
			timeline: [],
			closedRenders: [],
			// Phase 84: no streamed mermaid blocks yet.
			pendingStreamingMermaid: [],
			streamingMermaidParts: [],
			markdownRenderTimer: undefined,
			lastMarkdownRender: 0,
			renderedMarkdown: undefined,
		};

		// New turn opens from an explicit send — jump to the bottom.
		this.scrollBottom(conversation, true);
	}

	private updateThinkingElement(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.thinkingDetails || !state.thinkingText || !state.thinkingLabel) {
			return;
		}
		// Phase 60: the run's own reasoning renders — closed runs keep
		// their collapsed "Thought for Xs" blocks untouched.
		const runText = state.turn.thinking.slice(state.thinkingRunStart);
		if (runText.length === 0) {
			return;
		}
		state.thinkingDetails.style.display = 'block';
		// Phase 50: the ~10-line-high text window (see
		// .vibe-ai-thinking-text) auto-opens once on the first delta so the
		// latest reasoning is visible while it streams; a manual collapse
		// after that sticks (the flag makes the auto-open one-shot).
		if (!state.thinkingAutoOpened) {
			state.thinkingAutoOpened = true;
			state.thinkingDetails.open = true;
		}
		state.thinkingLabel.textContent = localize('vibeAIChat.thinking', "Thinking…");
		// Read the window's scroll position BEFORE mutating it — setting the
		// text changes scrollHeight and would invalidate the check. The user
		// scrolling up inside the window pauses its follow, scrolling back
		// to its bottom resumes (same rules as the thread follow-latest).
		const windowAtBottom = this.isScrolledToBottom(state.thinkingText);
		state.thinkingText.textContent = runText;
		if (state.thinkingDetails.open) {
			if (windowAtBottom) {
				state.thinkingText.scrollTop = state.thinkingText.scrollHeight;
			}
			// Only chase the thread scroll while the reasoning text is
			// actually visible; when collapsed its growth is invisible and
			// scrolling would yank the user's reading position.
			this.scrollBottom(conversation);
		}
	}

	private updateTextElement(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentBody) {
			return;
		}
		// Phase 84.11: answer-focus fold — a live run longer than the
		// narration budget cannot be an intermediate narration (it would
		// fold into the shell truncated at closeTextRun anyway), so it is
		// the final answer: fold the Worked shell NOW (its steps collapse
		// to the "Worked for Xs" row) and drop the bounded follow window —
		// the answer streams directly at full height with the thread
		// chasing the tail (user: the final output is not a scrollbar, and
		// the Working shell collapses at the answer's first characters —
		// the budget boundary is the earliest reliable signal, since the
		// backend carries no marker at the first delta). Checked before the
		// render throttle so the fold fires on the delta that crosses it.
		if (state.workShell?.open && state.turn.text.length - state.textRunStart > NARRATION_MAX_CHARS) {
			this.foldWorkShell(conversation);
		}
		// Throttled markdown re-render while streaming (full parse per delta
		// would stutter on long answers).
		if (state.markdownRenderTimer !== undefined) {
			return;
		}
		const elapsed = Date.now() - state.lastMarkdownRender;
		const delay = Math.max(0, MARKDOWN_RENDER_THROTTLE_MS - elapsed);
		state.markdownRenderTimer = DOM.getWindow(state.currentBody).setTimeout(() => {
			state.markdownRenderTimer = undefined;
			this.renderMarkdownNow(conversation, true);
		}, delay);
	}

	/**
	 * Phase 83: the markdown render options shared by every assistant render
	 * path. Regular code blocks go through the editor-backed renderer (the
	 * same renderer the workbench installs as the markdown service default);
	 * ```mermaid fences route to the built-in chat output renderer instead —
	 * an inline webview (pan/zoom/theme handling from the mermaid extension).
	 *
	 * The mermaid webview is created in the asyncRenderCallback flush — after
	 * the markdown renderer swapped the block into the placeholder slot —
	 * because moving a mounted webview iframe in the DOM reloads it. While
	 * the answer streams the block stays a placeholder (a per-delta webview
	 * would thrash); it renders on the final render and on history restore.
	 */
	private buildMarkdownRenderOptions(conversation: VibeAIConversation, streaming: boolean): MarkdownRenderOptions & IMarkdownRendererExtraOptions {
		const pendingMermaid: IPendingMermaidPart[] = [];
		// Fence order is stable across re-renders of the same text — the
		// counter maps the i-th mermaid fence of a streaming pass to its
		// reused block (see the renderer below).
		let mermaidBlockIndex = 0;
		return {
			fillInIncompleteTokens: streaming,
			codeBlockHeader: true,
			codeBlockRenderer: (languageId, value, rawInfo) => {
				// Phase 85: streamed mermaid blocks are REUSED across the
				// streaming pass's throttled re-renders — the i-th fence
				// keeps its block element (and its spinner) and only the
				// source updates. Rebuilding the block per render also
				// stacked a stale part in pendingStreamingMermaid per delta.
				// Phase 86: the fence check no longer requires the renderer
				// to be registered — the create call below waits for it, so
				// the fence-order counter advances for every mermaid fence.
				if (streaming && conversation.stream && isMermaidCodeBlock(languageId)) {
					const stream = conversation.stream;
					const streamingParts = stream.streamingMermaidParts;
					const index = mermaidBlockIndex++;
					const existing = streamingParts[index];
					if (existing) {
						existing.updateSource(value);
						return Promise.resolve(existing.element);
					}
					return this.mermaidRenderer.createMermaidBlockWhenReady(languageId, value, streaming).then(pending => {
						if (pending) {
							// The webview still mounts at run close / turn
							// finish (flushStreamingMermaid), NOT per delta.
							stream.streamingMermaidParts[index] = pending;
							stream.pendingStreamingMermaid.push(pending);
							return pending.element;
						}
						// Extension absent — editor-backed fallback.
						return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true }, rawInfo);
					});
				}
				if (isMermaidCodeBlock(languageId)) {
					// Phase 86: final render / history restore — wait for the
					// renderer extension when it is not registered yet (a
					// restore racing extension activation used to see
					// hasCodeBlockRenderer false and silently degrade the
					// fence to a plain code block).
					return this.mermaidRenderer.createMermaidBlockWhenReady(languageId, value, streaming).then(pending => {
						if (pending) {
							// Phase 84: streamed parts register on the
							// conversation stream — their webview mounts at
							// run close / turn finish
							// (flushStreamingMermaid), NOT per delta. Final
							// render / restore parts mount via the callback
							// below, once this render's placeholders swapped
							// (the stream registry is NOT used for them —
							// the teardown drops it before that swap
							// completes).
							if (streaming && conversation.stream) {
								conversation.stream.pendingStreamingMermaid.push(pending);
							} else {
								pendingMermaid.push(pending);
								// Phase 86: deferred flush safety net — the
								// callback above is the normal trigger, but
								// it only fires once EVERY code block of
								// this render settled; a never-settling one
								// used to leave the holder empty (blank
								// final response).
								if (pendingMermaid.length === 1) {
									this.scheduleMermaidPartsFlush(conversation, pendingMermaid);
								}
							}
							return pending.element;
						}
						return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true }, rawInfo);
					});
				}
				return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true }, rawInfo);
			},
			// Fires once every code block of this render resolved and the
			// placeholders swapped — the non-streaming mermaid webviews
			// mount then, already in place, so no iframe is ever moved.
			// (If a code block promise never settles, the callback never
			// fires — the deferred flush safety net below then mounts the
			// parts, and the streamed parts still mount via the registry
			// flush at run close / turn finish.)
			asyncRenderCallback: () => {
				for (const pending of pendingMermaid.splice(0)) {
					pending.flush(conversation.turnRecordDisposables);
				}
			},
		};
	}

	/**
	 * Phase 84: mounts the webview for every mermaid block created while
	 * streaming that has not mounted yet (the stream-state registry) —
	 * called at run close and at turn finish, never per delta. Parts whose
	 * holder is not in the document at flush time (their render is still
	 * swapping placeholders, or a newer render replaced it) are RETAINED
	 * and retried at the next flush — a dropped part would keep its
	 * spinner forever. Idempotent: already-mounted parts report true and
	 * leave the registry.
	 */
	private flushStreamingMermaid(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || state.pendingStreamingMermaid.length === 0) {
			return;
		}
		const remaining: IPendingMermaidPart[] = [];
		for (const pending of state.pendingStreamingMermaid.splice(0)) {
			if (!pending.flush(conversation.turnRecordDisposables)) {
				remaining.push(pending);
			}
		}
		state.pendingStreamingMermaid = remaining;
	}

	/**
	 * Phase 86: bounded safety net for a render pass's mermaid parts. The
	 * asyncRenderCallback is the normal mount trigger, but it only fires
	 * once EVERY code block of the render settled — a single never-settling
	 * promise (tokenizer, extension activation, a hung editor-backed render)
	 * used to leave the diagram's holder empty: the final response rendered
	 * blank. This schedules deferred flush attempts; `flush` is idempotent
	 * (a part the callback already mounted no-ops) and reports false while
	 * its holder is not in the document (its render was replaced or
	 * disposed — retries stop at the cap).
	 */
	private scheduleMermaidPartsFlush(conversation: VibeAIConversation, parts: IPendingMermaidPart[]): void {
		const disposables = conversation.turnRecordDisposables;
		const domWindow = DOM.getWindow(conversation.container);
		let attempt = 0;
		let timer: number | undefined;
		const flushAttempt = () => {
			timer = undefined;
			let stillPending = false;
			for (const pending of parts) {
				if (!pending.flush(disposables)) {
					stillPending = true;
				}
			}
			attempt++;
			if (stillPending && attempt < MERMAID_FLUSH_RETRY_ATTEMPTS) {
				timer = domWindow.setTimeout(flushAttempt, MERMAID_FLUSH_RETRY_DELAY_MS);
			}
		};
		timer = domWindow.setTimeout(flushAttempt, MERMAID_FLUSH_RETRY_DELAY_MS);
		// A pending retry must not fire after Clear Chat disposed the parts'
		// owner — cancel it with the conversation's record store.
		disposables.add(toDisposable(() => {
			if (timer !== undefined) {
				domWindow.clearTimeout(timer);
			}
		}));
	}

	private renderMarkdownNow(conversation: VibeAIConversation, streaming: boolean, textOverride?: string): void {
		const state = conversation.stream;
		if (!state || !state.currentBody) {
			return;
		}
		// Phase 60: only the CURRENT run's slice renders into the active
		// body — closed runs keep their own rendered bodies (multiple
		// Thought/Worked/narration blocks per turn, in run order).
		// Phase 84.4: a folded narration body over the cap renders its
		// capped head instead (textOverride) — the persisted text and the
		// timeline offsets are untouched.
		const text = textOverride ?? state.turn.text.slice(state.textRunStart);
		if (state.renderedMarkdown) {
			state.renderedMarkdown.dispose();
			state.renderedMarkdown = undefined;
		}
		// Phase 84.6: read the streaming window's pin state BEFORE clearing
		// the node — the re-render resets scrollHeight and clamps scrollTop,
		// which would invalidate the check (same rule as the thinking
		// window's pre-mutation read).
		const prevScrollTop = streaming ? state.currentBody.scrollTop : 0;
		const windowAtBottom = streaming ? this.isScrolledToBottom(state.currentBody) : false;
		DOM.clearNode(state.currentBody);
		if (text.length > 0) {
			const markdown = new MarkdownString(text, { isTrusted: true, supportThemeIcons: true, supportHtml: true });
			state.renderedMarkdown = new DisposableStore();
			const rendered = this.markdownRendererService.render(markdown, this.buildMarkdownRenderOptions(conversation, streaming), state.currentBody);
			state.renderedMarkdown.add(rendered);
		}
		state.currentBody.classList.toggle('vibe-ai-streaming', streaming);
		// Phase 84.6: while streaming, the body is a bounded auto-follow
		// window (CSS max-height, thinking-window parity) — the re-render
		// above reset its scroll, so re-pin the tail when the user kept it
		// at the bottom, or restore their reading offset otherwise. The
		// class (and the cap) lifts at run close: the answer renders in
		// full inline; a narration folds into the shell capped (84.4).
		if (streaming) {
			state.currentBody.scrollTop = windowAtBottom
				? state.currentBody.scrollHeight
				: Math.min(prevScrollTop, state.currentBody.scrollHeight);
		}
		state.lastMarkdownRender = Date.now();
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 60: the run-boundary helper — closes every open block run
	 * except the incoming type before a new run of that type opens. At
	 * most one run is open at a time (the lastBlockKind signal); the
	 * already-closed runs' close guards no-op.
	 * Phase 61: the closed text run folds INTO the turn's Worked shell
	 * (intoWork) — an intermediate narration body precedes more activity.
	 */
	private closeRunsBefore(conversation: VibeAIConversation, incoming: 'thinking' | 'text' | 'tools' | 'plan'): void {
		if (incoming !== 'thinking') {
			this.closeThinkingRun(conversation);
		}
		if (incoming !== 'text') {
			this.closeTextRun(conversation, true);
		}
		if (incoming !== 'tools') {
			this.closeToolsRun(conversation);
		}
	}

	/**
	 * Phase 60: opens a new thinking run at the row end — a collapsible
	 * "Thinking…" block (hidden until its first delta auto-opens the
	 * ~10-line window, Phase 50). Contiguous thinking deltas stream into
	 * it; the next non-thinking event closes it (closeThinkingRun) and the
	 * next thinking burst opens a fresh block.
	 */
	private ensureThinkingRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow) {
			return;
		}
		// Phase 61: once the turn's Worked shell exists (a tool already
		// ran), thinking streams INSIDE it as a sub-entry; before that it
		// renders at row level and moves in when the first tool arrives.
		const thinkingDetails = DOM.append(state.workSteps ?? state.currentAssistantRow, $('details.vibe-ai-thinking')) as HTMLDetailsElement;
		thinkingDetails.style.display = 'none';
		const summary = DOM.append(thinkingDetails, $('summary'));
		const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-thinking-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
		const thinkingLabel = DOM.append(summary, $('span'));
		thinkingLabel.textContent = localize('vibeAIChat.thinking', "Thinking…");
		const thinkingText = DOM.append(thinkingDetails, $('.vibe-ai-thinking-text'));
		state.thinkingDetails = thinkingDetails;
		state.thinkingLabel = thinkingLabel;
		state.thinkingText = thinkingText;
		state.thinkingRunStartedAt = Date.now();
		state.thinkingRunStart = state.turn.thinking.length;
		state.thinkingAutoOpened = false;
	}

	/**
	 * Phase 60: opens a new text run at the row end — a markdown body that
	 * only this run's slice of `turn.text` renders into. The next
	 * non-text event closes it (closeTextRun) and the next text burst
	 * opens a fresh body.
	 */
	private ensureTextRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow) {
			return;
		}
		state.currentBody = DOM.append(state.currentAssistantRow, $('.vibe-ai-chat-markdown.vibe-ai-streaming'));
		state.textRunStart = state.turn.text.length;
		state.lastMarkdownRender = 0;
	}

	/**
	 * Phase 61: opens a new tools run — resets the run-scoped tool ids and
	 * timing for the next timeline node. The Worked shell persists for the
	 * whole turn (created once on the first tool call); the run's cards
	 * land in its steps container.
	 */
	private openToolsRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		state.toolsRunToolIds = [];
		state.workRunStartedAt = Date.now();
	}

	/**
	 * Phase 61: builds the turn's ONE collapsible Worked shell — created
	 * lazily on the turn's first tool call. Already-rendered activity
	 * (thinking blocks, narration bodies) moves into the steps container
	 * in DOM order (chronological position preserved), and every later
	 * activity element appends into it. Phase 81: NO compact single-step
	 * mode — every step (narration, file reads, cards) is visible and
	 * STAYS visible while the agent works (user request: reveal what was
	 * answered and which files were read, keep it). Phase 84.9: the shell
	 * stays open through intermediate narrations. Phase 84.11: the final
	 * answer folds it mid-run (updateTextElement, once the run outgrows
	 * the narration budget) and finishStreaming folds it at turn end.
	 * The summary click uses the native <details> toggle (no compact-
	 * toggle listener anymore).
	 */
	private ensureWorkShell(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow || state.workShell) {
			return;
		}
		const row = state.currentAssistantRow;
		const workShell = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
		const workSummary = DOM.append(workShell, $('summary'));
		const workChevron = DOM.append(workSummary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-chevron'));
		workChevron.setAttribute('aria-hidden', 'true');
		const workLabel = DOM.append(workSummary, $('span'));
		workLabel.textContent = localize('vibeAIChat.working', "Working…");
		const workSteps = DOM.append(workShell, $('.vibe-ai-worked-steps'));
		// Move the activity rendered so far (thinking blocks, narration
		// bodies) into the steps container — they all precede the shell in
		// the row, so arrival order is preserved.
		while (row.firstChild && row.firstChild !== workShell) {
			workSteps.appendChild(row.firstChild);
		}
		state.workShell = workShell;
		state.workSteps = workSteps;
		state.workLabel = workLabel;
		// Open while the turn streams — every step shows (no compact mode,
		// Phase 81) and new steps keep appending visibly.
		workShell.style.display = 'block';
		workShell.open = true;
	}

	/**
	 * Phase 84.9: folds the turn's Worked shell to its collapsed "Worked
	 * for Xs" summary row. Phase 84.11: two fold moments — the mid-run
	 * answer-focus fold from updateTextElement (the live run outgrew
	 * NARRATION_MAX_CHARS, so it can only be the final answer) and the
	 * turn-end fold from finishStreaming (short answers, plus tools-only
	 * / abort / error turns without an answer). User request: intermediate
	 * narrations keep the shell open and stream below it; the final
	 * answer collapses the shell as soon as it announces itself. The
	 * fold's duration freezes here (workFoldedMs) so the label and the
	 * persisted record agree.
	 */
	private foldWorkShell(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.workShell || !state.workLabel) {
			return;
		}
		if (state.workFoldedMs === undefined) {
			state.workFoldedMs = Date.now() - (state.turnStartedAt ?? Date.now());
		}
		state.workShell.open = false;
		state.workLabel.textContent = localize('vibeAIChat.worked', "Worked for {0}", getDurationString(state.workFoldedMs));
		// Phase 84.11: a shell folding while the answer still streams
		// drops the bounded follow window — the live body streams at full
		// height from here on and the thread chases the tail (user: the
		// final output is not a scrollbar). At the turn-end fold the run
		// close already toggled the streaming class off, so the modifier
		// is inert on settled bodies; restored bodies never carry either
		// class.
		state.currentBody?.classList.add('vibe-ai-answer-stream');
	}

	/**
	 * Phase 60: closes the current thinking run — records its reasoning
	 * range as a timeline node and folds the block back to its collapsed
	 * "Thought for Xs" row (the run's own duration, not the whole
	 * turn's). The next thinking burst opens a fresh block
	 * (ensureThinkingRun).
	 */
	private closeThinkingRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || state.lastBlockKind !== 'thinking') {
			return;
		}
		const start = state.thinkingRunStart;
		const end = state.turn.thinking.length;
		if (end > start) {
			state.timeline.push({
				kind: 'thinking',
				start,
				end,
				durationMs: Date.now() - (state.thinkingRunStartedAt ?? Date.now()),
			});
		}
		if (state.thinkingDetails && state.thinkingLabel) {
			if (end > start) {
				state.thinkingLabel.textContent = localize('vibeAIChat.thought', "Thought for {0}", getDurationString(Date.now() - (state.thinkingRunStartedAt ?? Date.now())));
				// Phase 84.2: the run is over — the window drops the ~10-line
				// cap so re-expanding it shows the full reasoning in the
				// thread scroll (only the streaming window stays capped).
				state.thinkingText?.classList.add('vibe-ai-thinking-text-settled');
				state.thinkingDetails.open = false;
			} else {
				// A run without deltas (defensive) hides entirely.
				state.thinkingDetails.style.display = 'none';
			}
		}
		state.thinkingDetails = undefined;
		state.thinkingLabel = undefined;
		state.thinkingText = undefined;
		state.thinkingRunStartedAt = undefined;
	}

	/**
	 * Phase 60: closes the current text run — records its text range
	 * (offsets into the full turn text) as a timeline node and finalizes
	 * the body's render (streaming caret removed; the render is handed to
	 * closedRenders so the async code-block swap survives). The next text
	 * burst opens a fresh body at the row end (ensureTextRun).
	 * Phase 61: `intoWork` — an INTERMEDIATE narration body folds into the
	 * turn's Worked shell (more activity follows it); the final text run
	 * (closed at finish) stays outside as the answer body. Phase 84.9:
	 * this close only moves the body / records the range. Phase 84.11:
	 * the shell MAY already be folded here — the answer-focus fold fired
	 * mid-run and the run turned out to be a narration after all (tool
	 * activity resumed); the capped head tucks into the reopened shell.
	 */
	private closeTextRun(conversation: VibeAIConversation, intoWork = false): void {
		const state = conversation.stream;
		if (!state || state.lastBlockKind !== 'text' || !state.currentAssistantRow) {
			return;
		}
		const start = state.textRunStart;
		const end = state.turn.text.length;
		// Phase 84.4: a narration body folding into the Worked shell renders
		// its capped head when over NARRATION_MAX_CHARS — the prompt's
		// brevity rule enforced at the UI layer (model compliance alone
		// proved unreliable). The timeline node below still records the
		// FULL range, so the persisted text and history are unchanged; only
		// the folded body's visible render is trimmed. The final answer run
		// (intoWork=false) never caps.
		const narrationText = intoWork ? capNarrationText(state.turn.text.slice(start, end)) : undefined;
		// Cancel a pending throttled render before the final full render.
		this.clearStreamMarkdownTimer(state);
		this.renderMarkdownNow(conversation, false, narrationText);
		// Phase 85: the streaming pass is over — the final render built
		// the spinner-less block. Drop the pass's reused parts (their
		// holders were replaced by that render; they stay in
		// pendingStreamingMermaid and are retained/dropped by the flushes
		// below).
		state.streamingMermaidParts = [];
		if (state.renderedMarkdown) {
			state.closedRenders.push(state.renderedMarkdown);
			state.renderedMarkdown = undefined;
		}
		if (state.currentBody) {
			if (end > start) {
				state.timeline.push({ kind: 'text', start, end });
				// Phase 61: narration folds into the Worked shell (the
				// body may already have been moved by ensureWorkShell —
				// appendChild is a no-op reorder then).
				if (intoWork && state.workSteps) {
					state.workSteps.appendChild(state.currentBody);
				}
			} else {
				// An empty run (a text event with no text) leaves nothing
				// behind — drop the body element entirely.
				state.currentBody.remove();
			}
		}
		// Phase 84: guaranteed mount point for the streamed mermaid blocks
		// of this run — after the body's final position (the intoWork move
		// above) so no mounted iframe is ever relocated. Parts whose
		// holders were replaced by the final render above report false and
		// are retained for the next flush (turn finish) instead of being
		// dropped.
		this.flushStreamingMermaid(conversation);
		state.currentBody = undefined;
	}

	/**
	 * Phase 60: closes the current tools run — records its tool ids as a
	 * timeline node (per-run duration). Phase 61: the Worked shell is
	 * turn-scoped and persists across runs — only the run-scoped fields
	 * reset here (the next tool burst reuses the same shell); the shell
	 * folds to its summary row at finishStreaming instead.
	 */
	private closeToolsRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || state.lastBlockKind !== 'tools') {
			return;
		}
		if (state.toolsRunToolIds.length > 0) {
			state.timeline.push({
				kind: 'tools',
				toolIds: [...state.toolsRunToolIds],
				durationMs: Date.now() - (state.workRunStartedAt ?? Date.now()),
			});
		}
		state.workRunStartedAt = undefined;
		state.toolsRunToolIds = [];
	}

	private finishStreaming(conversation: VibeAIConversation, requestId?: string): void {
		// Phase 44: double-finish guard — the done event usually wins; a
		// late stream-promise settle (or an abort) finds no live state and
		// no-ops. Other tabs' streams are unaffected. Phase 45: when a
		// requestId is given, only the turn it identifies may finish — a
		// turn skipped mid-stream (send → skip → newer stream) must not
		// tear down its successor.
		const state = conversation.stream;
		if (!state || (requestId !== undefined && state.requestId !== requestId)) {
			return;
		}
		// Phase 71: a plan awaiting approval keeps the turn OPEN — the
		// user builds (the execute phase streams into the same turn and
		// its done finishes it) or cancels it (cancelPlan calls this).
		if (state.planPhase === 'awaiting') {
			// Phase 84: the runs stay open here, but the streamed diagrams
			// mount anyway — the real finish re-renders the run and the new
			// render pass re-mounts through its own callback.
			this.flushStreamingMermaid(conversation);
			return;
		}

		// Persist the assistant text to history (thinking is not sent back).
		conversation.history.push({ role: 'assistant', content: state.turn.text });

		// Phase 60: close the open block run(s) — the Thought/Worked blocks
		// fold to their summary rows with their own durations and the
		// closed runs record their chronological timeline nodes; the open
		// text run's node is what the restore path slices `answer` with.
		// Only the currently open run actually closes (the others' guards
		// no-op) — every earlier run closed when a different event type
		// arrived. closeTextRun (intoWork=false) keeps the final text run's
		// body OUTSIDE the Worked shell as the answer body.
		this.closeThinkingRun(conversation);
		this.closeToolsRun(conversation);
		this.closeTextRun(conversation);

		// Phase 61: fold the turn's ONE Worked shell to its summary row —
		// "Worked for Xs" with the turn's whole activity inside (thinking
		// sub-blocks, narration, cards). A thinking-only turn never created
		// one; its "Thought for Xs" blocks folded in closeThinkingRun.
		// Phase 84.9: this is the ONE fold moment — intermediate narrations
		// streamed below the still-open shell; now the final answer has
		// completed (or the turn aborted / errored without an answer), so
		// the shell collapses and the record persists the fold duration,
		// keeping the restored label in parity with the live fold.
		this.foldWorkShell(conversation);
		const workDurationMs = state.workFoldedMs;

		// Phase 84: guaranteed mount point for every streamed mermaid block
		// that never got its webview — the final render re-renders only the
		// CURRENT run, so a diagram in an already-closed run (or whose
		// render's code block promises never settled) used to keep its
		// spinner forever. The flush is idempotent (mounted parts skip) and
		// runs after every DOM move (the fold above), so no mounted iframe
		// is ever relocated; parts that still cannot mount are dropped by
		// the teardown below with the rest of the stream.
		this.flushStreamingMermaid(conversation);

		// The fenced code blocks of the final render are swapped in
		// asynchronously (the editor-backed code block renderer tokenizes
		// each block in a promise; the base renderer only swaps its
		// placeholder divs while the render is still alive). Disposing the
		// render synchronously in teardownStream below used to flip that
		// guard in the same tick, so the raw placeholder divs (which
		// collapse the code into one inline wall of text) stayed in the
		// DOM. Hand the render to the turn record store — the same owner
		// the restored view uses — so the swap completes; the store is
		// cleared on Clear Chat and disposed with the tab.
		if (state.renderedMarkdown) {
			conversation.turnRecordDisposables.add(state.renderedMarkdown);
			state.renderedMarkdown = undefined;
		}
		// Phase 60: the closed body runs' renders join the record store —
		// same async code-block swap concern as the final render above.
		for (const render of state.closedRenders) {
			conversation.turnRecordDisposables.add(render);
		}
		state.closedRenders = [];

		// Empty response → subtle placeholder instead of nothing. Phase 60:
		// bodies are built lazily per text run — a tools-only turn (or a
		// budget-truncated round whose reasoning ate the whole budget) has
		// no body, so the placeholder's body is created here.
		if (state.turn.text.length === 0 && state.currentAssistantRow) {
			const body = DOM.append(state.currentAssistantRow, $('.vibe-ai-chat-markdown'));
			const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
			// Phase 51: a budget-truncated round with no answer text says so
			// (the reasoning used up the output budget) instead of "(no response)".
			placeholder.textContent = state.outputTruncated
				? localize(
					'vibeAIChat.truncatedNoResponse',
					"(response truncated — the reasoning used up the output budget; raise backend LLM_AGENT_MAX_TOKENS)"
				)
				: localize('vibeAIChat.emptyResponse', "(no response)");
			placeholder.style.color = 'var(--vscode-descriptionForeground)';
			placeholder.style.fontStyle = 'italic';
		}

		// Phase 45: capture the completed turn's artifacts (thinking, tool
		// cards, file changes) — checkpoint rollback and lossless history
		// persistence read from this record. Captured before the footer
		// (so it knows the turn's index) and before teardown.
		// Phase 47: the records keep the 1:1 mapping turns[k] ↔ k-th user
		// turn of the thread. A turn finished in a conversation whose
		// earlier turns have no records (a session saved before Phase 45 —
		// including one being re-run via edit & resubmit) would break the
		// mapping and later lose those earlier turns on restore, so its
		// record (and checkpoint rollback button) is skipped; the per-turn
		// undo keeps working off the captured file changes.
		const userRowIndex = state.userRow ? Array.from(conversation.container.querySelectorAll('.vibe-ai-turn-user')).indexOf(state.userRow) : -1;
		const aligned = userRowIndex !== -1 && conversation.turns.length === userRowIndex;
		const turnRecord: VibeAITurnRecord = {
			userText: state.userText,
			thinking: state.turn.thinking.length > 0 ? state.turn.thinking : undefined,
			thinkingDurationMs: state.turnStartedAt !== undefined ? Date.now() - state.turnStartedAt : undefined,
			workDurationMs,
			tools: [...state.toolCards.entries()].map(([id, card]) => ({ id, ...card.snapshot() })),
			answer: state.turn.text,
			timeline: [...state.timeline],
			turnStartedAt: state.turnStartedAt,
			contextCompressed: state.contextCompressed || undefined,
			outputTruncated: state.outputTruncated || undefined,
			// Phase 70: the Auto router's pick — persisted for restore parity.
			routedModel: state.routedModel,
			// Phase 71: the plan + its final state (Plan mode turns) — the
			// record is captured when the turn finishes, i.e. after the
			// execute phase (executed) or on cancel (cancelled).
			...(state.pendingPlan ? {
				plan: state.pendingPlan,
				planStatus: (state.planPhase === 'executing' ? 'executed' : 'cancelled') as VibeAIPlanCardStatus,
				planResults: state.planResults,
			} : {}),
			error: state.lastError,
			turnChanges: [...state.turnChanges],
			row: state.currentAssistantRow,
		};
		if (aligned) {
			conversation.turns.push(turnRecord);
		}

		// Cursor-parity turn footer: checkpoint restore + rollback + time.
		// The rollback icon only renders when the turn is tracked in the
		// records (alignment above).
		if (state.currentAssistantRow) {
			this.renderTurnFooterInto(conversation, state.currentAssistantRow, state.turnChanges, state.turnStartedAt ?? Date.now(), aligned ? conversation.turns.length - 1 : -1);
		}

		// Cursor-parity files-changed summary — Phase 56: docked directly
		// above the input box (only the active conversation's finished
		// turn updates the bar; a background tab's turn shows when its
		// tab is activated).
		if (state.turnChanges.length > 0 && conversation.id === this.activeConversationId) {
			this.renderDockedFilesSummary(state.turnChanges);
		}

		// Tear the turn's live state down — each conversation finishes
		// independently of other tabs' streams. `turnChanges`/`turnStartedAt`
		// stay on the state so a late Discard/Review click still works.
		this.teardownStream(conversation, state);
		conversation.stream = undefined;

		// The input actions (stop → send/mic swap) and the tab strip MUST
		// refresh before any fallible step below — an exception during
		// persistence used to abort this method first, leaving the stop
		// button stuck in the streaming state for the rest of the session.
		this.renderTabs();
		this.updateInputActions();

		// Persist the conversation (Cursor-parity chat history) — Phase 45:
		// the per-turn artifacts go along so history restores losslessly.
		// Best-effort: a persistence failure must never break the chat UI.
		try {
			this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)));
		} catch (err) {
			this.logService.error('[VibeAI] failed to persist chat session', err);
		}
		// Phase 79: the tab just became non-empty — record it in the open
		// strip even without a later tab switch (restore parity).
		this.persistOpenState();

		// Phase 41: keep the context usage ring/panel fresh after each turn.
		void this.refreshContextUsage(conversation);
	}

	/** Strips runtime-only fields before persisting a completed turn. */
	private toPersistedTurn(turn: VibeAITurnRecord): IVibeAIPersistedTurn {
		return {
			userText: turn.userText,
			thinking: turn.thinking,
			thinkingDurationMs: turn.thinkingDurationMs,
			workDurationMs: turn.workDurationMs,
			tools: turn.tools,
			answer: turn.answer,
			segments: turn.segments,
			timeline: turn.timeline,
			turnStartedAt: turn.turnStartedAt,
			contextCompressed: turn.contextCompressed,
			outputTruncated: turn.outputTruncated,
			// Phase 70: the Auto router's pick (Cursor-parity restore).
			routedModel: turn.routedModel,
			// Phase 71: the plan + its final state (Cursor-parity restore).
			plan: turn.plan,
			planStatus: turn.planStatus,
			planResults: turn.planResults,
			error: turn.error,
			turnChanges: turn.turnChanges,
			rolledBack: turn.rolledBack,
		};
	}

	/**
	 * Cancels a pending throttled markdown render of a turn. Uses the
	 * turn's own markdown body for the window lookup while it is still
	 * attached (falls back to the messages holder).
	 */
	private clearStreamMarkdownTimer(state: VibeAIStreamState): void {
		if (state.markdownRenderTimer === undefined) {
			return;
		}
		const element = state.currentBody ?? this.messagesContainer;
		if (element) {
			DOM.getWindow(element).clearTimeout(state.markdownRenderTimer);
		}
		state.markdownRenderTimer = undefined;
	}

	/**
	 * Disposes the per-turn artifacts of a finished or aborted stream:
	 * pending markdown render and the in-flight turn's DOM refs. The
	 * finished turn's tool cards are handed to the conversation's record
	 * store (they stay rendered — see below). Pure state teardown — no UI
	 * refresh here.
	 */
	private teardownStream(conversation: VibeAIConversation, state: VibeAIStreamState): void {
		this.clearStreamMarkdownTimer(state);
		if (state.renderedMarkdown) {
			state.renderedMarkdown.dispose();
			state.renderedMarkdown = undefined;
		}
		// Phase 58: dispose the closed segments' renders (abort path — the
		// finish path hands them to the record store instead).
		for (const render of state.closedRenders) {
			render.dispose();
		}
		state.closedRenders = [];
		// Phase 84: drop the streamed mermaid parts with the DOM (the
		// abort path — the finish path flushes them before this).
		state.pendingStreamingMermaid = [];
		state.streamingMermaidParts = [];
		// Phase 65 fix (user feedback: clicking a finished turn's card did
		// nothing): the turn's tool cards STAY rendered in the thread ("no
		// UI refresh here") — disposing them here removed their click
		// listeners while the elements remained, so completed turns' cards
		// still showed the clickable header cursor/hover but clicking them
		// was dead. Hand them to the record store instead — they keep
		// working exactly like restored cards and die with the tab.
		for (const card of state.toolCards.values()) {
			conversation.turnRecordDisposables.add(card);
		}
		state.toolCards.clear();
		state.thinkingDetails = undefined;
		state.thinkingLabel = undefined;
		state.thinkingText = undefined;
		state.currentBody = undefined;
		state.currentAssistantRow = undefined;
		state.userRow = undefined;
		state.pendingWriteCardId = undefined;
		// Phase 61: reset the turn-scoped Worked shell refs.
		state.workShell = undefined;
		state.workSteps = undefined;
		state.workLabel = undefined;
		state.workAnyTool = false;
		// Phase 84.9: reset the frozen fold duration with the shell.
		state.workFoldedMs = undefined;
		// Phase 60: reset the chronological block runs with the rest of the
		// stream.
		state.lastBlockKind = undefined;
		state.textRunStart = 0;
		state.thinkingRunStart = 0;
		state.thinkingRunStartedAt = undefined;
		state.workRunStartedAt = undefined;
		state.toolsRunToolIds = [];
		state.timeline = [];
	}

	/**
	 * Cursor-parity turn footer: a checkpoint (undo) button that restores
	 * every file change of this round, a checkpoint button that rolls the
	 * workspace back to this checkpoint (this and all later rounds,
	 * Phase 45), and the relative time of the turn. Rendered from both the
	 * live stream state and a restored turn record.
	 */
	private renderTurnFooterInto(conversation: VibeAIConversation, assistantRow: HTMLElement, changes: IVibeAICodeChange[], turnStartedAt: number, turnIndex: number): void {
		const disposables = conversation.turnRecordDisposables;
		const footer = DOM.append(assistantRow, $('.vibe-ai-turn-footer'));

		const undoBtn = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-discard')) as HTMLButtonElement;
		const restorable = changes.filter(c => c.oldContent !== undefined && c.oldContent !== null);
		undoBtn.title = localize(
			'vibeAIChat.checkpointRestore',
			"Restore checkpoint — undo this round's file changes ({0} file(s))",
			restorable.length
		);
		if (restorable.length === 0) {
			undoBtn.classList.add('disabled');
		} else {
			disposables.add(DOM.addDisposableListener(undoBtn, DOM.EventType.CLICK, () => {
				void this.restoreTurn(restorable, undoBtn);
			}));
		}

		// Phase 45: the checkpoint icon restores the workspace to the state
		// at this checkpoint — this and every later round's changes are
		// reverted (newest-first). Only offered for turns tracked in the
		// conversation's turn records; disabled when nothing to roll back.
		// Phase 47: turns not tracked in the records (a resent turn in a
		// conversation whose earlier turns have no records) get no
		// checkpoint icon — there is nothing to roll back to.
		if (turnIndex >= 0) {
			const rollbackCount = conversation.turns.slice(turnIndex).reduce((count, turn) => count + turn.turnChanges.length, 0);
			const checkpoint = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-history.vibe-ai-checkpoint-icon')) as HTMLButtonElement;
			if (rollbackCount === 0) {
				checkpoint.classList.add('disabled');
				checkpoint.title = localize('vibeAIChat.checkpoint', "Checkpoint");
			} else {
				checkpoint.title = localize(
					'vibeAIChat.checkpointRollback',
					"Restore checkpoint — revert this and all later rounds' file changes ({0} file(s))",
					rollbackCount
				);
				disposables.add(DOM.addDisposableListener(checkpoint, DOM.EventType.CLICK, () => {
					if (checkpoint.classList.contains('disabled')) {
						return;
					}
					void this.restoreCheckpoint(conversation, turnIndex);
				}));
			}
		}

		DOM.append(footer, $('span.spacer'));

		const time = DOM.append(footer, $('span.vibe-ai-turn-footer-time'));
		time.textContent = fromNowByDay(turnStartedAt, true, true);
	}

	private async restoreTurn(changes: IVibeAICodeChange[], button: HTMLButtonElement): Promise<void> {
		button.classList.add('disabled');
		let allOk = true;
		for (const change of changes) {
			try {
				const ok = await this.restoreChange(change);
				allOk = allOk && ok;
			} catch (err) {
				this.logService.error('[VibeAI] checkpoint restore failed', err);
				allOk = false;
			}
		}
		if (!allOk) {
			button.classList.remove('disabled');
		}
	}

	/**
	 * Phase 45: restores the workspace to the state at a checkpoint —
	 * every file change of this turn and all later turns is reverted
	 * newest-first (Cursor-parity checkpoint rollback). The conversation
	 * text is kept. A running stream is aborted first (an in-flight turn
	 * could otherwise clobber the restored files); the affected turns are
	 * marked rolled-back and their checkpoint buttons disabled. The
	 * rollback is persisted so it survives reloads.
	 */
	private async restoreCheckpoint(conversation: VibeAIConversation, turnIndex: number): Promise<void> {
		if (conversation.stream) {
			this.abortStream(conversation);
		}
		const affected = conversation.turns.slice(turnIndex);
		let allOk = true;
		for (let i = affected.length - 1; i >= 0; i--) {
			const record = affected[i];
			if (record.rolledBack) {
				continue;
			}
			try {
				const ok = await this.revertChanges(record.turnChanges);
				allOk = allOk && ok;
				if (ok) {
					record.rolledBack = true;
				}
			} catch (err) {
				this.logService.error('[VibeAI] checkpoint rollback failed', err);
				allOk = false;
			}
		}
		// Disable the checkpoint / per-turn restore buttons of every
		// rolled-back turn and mark their footers.
		for (const record of affected) {
			if (!record.rolledBack || !record.row) {
				continue;
			}
			const checkpoint = record.row.querySelector<HTMLButtonElement>('button.vibe-ai-checkpoint-icon');
			if (checkpoint) {
				checkpoint.classList.add('disabled');
				checkpoint.title = localize('vibeAIChat.checkpointRolledBack', "Checkpoint restored");
			}
			const undoBtn = record.row.querySelector<HTMLButtonElement>('button.codicon-discard');
			if (undoBtn && !undoBtn.classList.contains('disabled')) {
				undoBtn.classList.add('disabled');
			}
		}
		if (!allOk) {
			this.notificationService.warn(localize(
				'vibeAIChat.checkpointRollbackPartial',
				"Checkpoint restore finished with errors — some file changes may not have been reverted."
			));
		}
		// Keep the persisted turns in sync so the rollback survives reloads.
		this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)));
		// Phase 56: rolled-back turns are no longer reviewable — the
		// docked review bar re-picks the latest remaining turn (or hides).
		this.renderDockedFilesSummary();
		this.renderTabs();
		this.updateInputActions();
	}

	/**
	 * Phase 56: Cursor-parity review bar docked directly above the input
	 * box — the "N Files" row always sticks to the top of the input and
	 * never scrolls with the thread (reference parity). Shows the latest
	 * turn's file changes: the explicit `changes` list (a just-finished
	 * turn, tracked in the records or not) wins, otherwise the active
	 * conversation's newest non-rolled-back turn with changes. Hidden
	 * when there is nothing to review.
	 */
	private renderDockedFilesSummary(changes?: IVibeAICodeChange[]): void {
		const dock = this.filesSummaryDock;
		if (!dock) {
			return;
		}
		// The bar's listeners die with the pane; cleared on every
		// re-render so a rebuilt bar starts clean.
		this.filesSummaryDisposables.clear();
		DOM.clearNode(dock);
		let latest = changes && changes.length > 0 ? changes : undefined;
		if (!latest) {
			const active = this.getActiveConversation();
			if (active) {
				for (let i = active.turns.length - 1; i >= 0; i--) {
					if (!active.turns[i].rolledBack && active.turns[i].turnChanges.length > 0) {
						latest = active.turns[i].turnChanges;
						break;
					}
				}
			}
		}
		if (!latest || latest.length === 0) {
			dock.style.display = 'none';
			return;
		}
		dock.style.display = '';
		// Phase 59: render only the FINAL result per file — sessions saved
		// before the per-file collapse still carry one entry per write in
		// their persisted records; consolidating here keeps their bar
		// clean too (one row per file, net diff badge).
		this.renderFilesSummaryInto(consolidateChanges(latest), this.filesSummaryDisposables);
	}

	/**
	 * Cursor-parity files summary: collapsible "N Files" header with
	 * Discard / Keep (Cursor-parity review bar, shown when this turn
	 * modified or created a file) and a Review action (opens the most
	 * recently changed file in the editor). Phase 56: rendered into the
	 * docked review bar above the input box (never into the scrolling
	 * thread), so it always sticks to the top of the input.
	 */
	private renderFilesSummaryInto(changes: IVibeAICodeChange[], disposables: DisposableStore): void {
		const dock = this.filesSummaryDock;
		if (!dock) {
			return;
		}
		const summary = DOM.append(dock, $('.vibe-ai-files-summary'));

		const header = DOM.append(summary, $('.vibe-ai-files-summary-header'));
		const chevron = DOM.append(header, $('span.codicon.codicon-chevron-right'));
		chevron.setAttribute('aria-hidden', 'true');
		const count = DOM.append(header, $('span.vibe-ai-files-summary-count'));
		count.textContent = localize('vibeAIChat.filesCount', "{0} Files", changes.length);

		// Discard / Keep before Review, shown when this turn modified or
		// created at least one file. Discard reverts every change (updates
		// restored to their pre-change content, created files deleted);
		// Keep confirms the on-disk state (agent writes are already
		// applied, Cursor behavior).
		const hasFileEdit = changes.some(change => change.action === 'create' || change.action === 'update');
		if (hasFileEdit) {
			const discard = DOM.append(header, $('button.vibe-ai-files-summary-action.vibe-ai-files-summary-discard')) as HTMLButtonElement;
			discard.textContent = localize('vibeAIChat.discard', "Discard");
			discard.title = localize('vibeAIChat.discardTitle', "Revert every file change of this turn");
			const keep = DOM.append(header, $('button.vibe-ai-files-summary-action.vibe-ai-files-summary-keep')) as HTMLButtonElement;
			keep.textContent = localize('vibeAIChat.keep', "Keep");
			keep.title = localize('vibeAIChat.keepTitle', "Keep every file change of this turn");

			disposables.add(DOM.addDisposableListener(discard, DOM.EventType.CLICK, async e => {
				e.preventDefault();
				e.stopPropagation();
				if (discard.classList.contains('disabled')) {
					return;
				}
				discard.classList.add('disabled');
				keep.classList.add('disabled');
				if (await this.revertChanges(changes)) {
					discard.textContent = localize('vibeAIChat.discarded', "Discarded");
					discard.title = localize('vibeAIChat.discardedTitle', "Changes reverted");
				} else {
					discard.classList.remove('disabled');
					keep.classList.remove('disabled');
				}
			}));
			disposables.add(DOM.addDisposableListener(keep, DOM.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				if (keep.classList.contains('disabled')) {
					return;
				}
				// Keep = accept the new on-disk content (agent writes are
				// already applied, Cursor behavior) — nothing to write.
				keep.classList.add('disabled');
				discard.classList.add('disabled');
				keep.textContent = localize('vibeAIChat.kept', "Kept");
				keep.title = localize('vibeAIChat.keptTitle', "Changes kept");
			}));
		}

		const review = DOM.append(header, $('button.vibe-ai-files-summary-review')) as HTMLButtonElement;
		review.textContent = localize('vibeAIChat.review', "Review");
		review.title = localize('vibeAIChat.reviewTitle', "Open the most recently changed file in the editor");
		disposables.add(DOM.addDisposableListener(review, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			const last = changes[changes.length - 1];
			if (last) {
				this.openFile(last.filePath, this.firstChangeLine(last));
			}
		}));

		const list = DOM.append(summary, $('.vibe-ai-files-list'));
		list.style.display = 'none';
		disposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
			const open = list.style.display !== 'none';
			list.style.display = open ? 'none' : 'block';
			chevron.classList.toggle('codicon-chevron-right', open);
			chevron.classList.toggle('codicon-chevron-down', !open);
		}));

		for (const change of changes) {
			const row = DOM.append(list, $('.vibe-ai-files-list-row'));
			const icon = DOM.append(row, $('span.codicon.codicon-symbol-file'));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(row, $('span.vibe-ai-files-list-name'));
			name.textContent = change.filePath;
			name.title = change.filePath;
			if (change.newContent !== undefined) {
				this.appendFileStats(row, change.oldContent ?? '', change.newContent);
			}
			disposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this.openFile(change.filePath, this.firstChangeLine(change))));
		}
	}

	private appendFileStats(row: HTMLElement, original: string, updated: string): void {
		const { additions, deletions } = computeDiffStats(original, updated);
		if (additions === 0 && deletions === 0) {
			return;
		}
		const badge = DOM.append(row, $('span.vibe-ai-tool-card-stats'));
		if (additions > 0) {
			const added = DOM.append(badge, $('span'));
			added.textContent = `+${additions}`;
			added.style.color = 'var(--vscode-charts-green)';
		}
		if (additions > 0 && deletions > 0) {
			DOM.append(badge, $('span')).textContent = ' ';
		}
		if (deletions > 0) {
			const removed = DOM.append(badge, $('span'));
			removed.textContent = `-${deletions}`;
			removed.style.color = 'var(--vscode-charts-red)';
		}
	}

	/** Opens a workspace-relative (or absolute) file path in the editor. */
	private openFile(path: string, line?: number, endLine?: number): void {
		const uri = this.resolveWorkspacePath(path);
		if (!uri) {
			return;
		}
		// Phase 65: with a line (read range / first changed line) open with
		// a selection so the editor reveals — and selects — that line;
		// `revealIfOpened` reuses an already-open tab instead of duplicating.
		if (line !== undefined && Number.isInteger(line) && line > 0) {
			const end = endLine !== undefined && Number.isInteger(endLine) && endLine >= line ? endLine : line;
			void this.editorService.openEditor({
				resource: uri,
				options: {
					selection: { startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: 1 },
					revealIfOpened: true,
				},
			});
		} else {
			this.openerService.open(uri, { fromUserGesture: true });
		}
		// Phase 57: re-apply the stored live-write highlight once the
		// editor shows the file (no-op without a pending write).
		this.editorHighlighter?.applyForUri(uri);
	}

	/** First changed line of a code change (new-file numbering) — the reveal target for editor jumps. */
	private firstChangeLine(change: IVibeAICodeChange): number | undefined {
		if (change.newContent === undefined) {
			return undefined;
		}
		return computeDiffLines(change.oldContent ?? '', change.newContent)
			.find(line => line.type !== 'same')?.newLine;
	}

	/** Resolves a backend path against the workspace root. */
	private resolveWorkspacePath(path: string): URI | undefined {
		try {
			if (/^([a-zA-Z]:[\\/]|\/)/.test(path)) {
				return URI.file(path);
			}
			const folder = this.workspaceContextService.getWorkspace().folders[0];
			if (!folder) {
				return undefined;
			}
			return URI.joinPath(folder.uri, path.replace(/\\/g, '/'));
		} catch {
			return undefined;
		}
	}

	// ==================== Cursor-style input tools ====================

	private updateModeLabel(): void {
		// Phase 72: each mode carries its own color + icon (Agent blue /
		// Plan purple / Ask green) — the trigger buttons swap the icon per
		// mode and hook a `data-mode` attribute for the colored CSS, so the
		// closed dropdown already tells which mode is active (no checkmark
		// anywhere: the dropdown highlights the selection with a bright
		// pill of the mode's color instead).
		const item = this.modeItems().find(m => m.id === this.mode) ?? this.modeItems()[2];
		if (this.modeLabel) {
			this.modeLabel.textContent = item.label;
		}
		if (this.modeIcon) {
			this.modeIcon.className = `codicon ${item.icon}`;
		}
		if (this.modeButton) {
			this.modeButton.dataset.mode = this.mode;
		}
		// Phase 48: the edit box's dropdown mirrors the main input's.
		if (this.promptEdit?.modeLabel) {
			this.promptEdit.modeLabel.textContent = item.label;
		}
		if (this.promptEdit?.modeIcon) {
			this.promptEdit.modeIcon.className = `codicon ${item.icon}`;
		}
		if (this.promptEdit?.modeButton) {
			this.promptEdit.modeButton.dataset.mode = this.mode;
		}
	}

	/**
	 * Phase 72: the three modes — label, per-mode colored icon and a
	 * one-line description, shared by the trigger buttons (icon swap +
	 * data-mode hook) and the dropdown (rows). Colors live in CSS via the
	 * `mode-<id>` class: Agent = blue, Plan = purple, Ask = green.
	 */
	private modeItems(): Array<{ id: VibeAIChatMode; label: string; icon: string; desc: string }> {
		return [
			{ id: 'agent', label: localize('vibeAIChat.modeAgent', "Agent"), icon: 'codicon-tools', desc: localize('vibeAIChat.modeAgentDesc', "Autonomous tool runs & edits") },
			{ id: 'plan', label: localize('vibeAIChat.modePlan', "Plan"), icon: 'codicon-checklist', desc: localize('vibeAIChat.modePlanDesc', "Plan first — execute after approval") },
			{ id: 'ask', label: localize('vibeAIChat.modeAsk', "Ask"), icon: 'codicon-comment-discussion', desc: localize('vibeAIChat.modeAskDesc', "Read-only answers") },
		];
	}

	private updateModelLabel(): void {
		// Imported models show their display name; ad-hoc/Auto show as-is.
		const configured = this.modelStore.get(this.model);
		const label = configured?.name ?? this.model;
		if (this.modelLabel) {
			this.modelLabel.textContent = label;
		}
		// Phase 48: the edit box's dropdown mirrors the main input's.
		if (this.promptEdit?.modelLabel) {
			this.promptEdit.modelLabel.textContent = label;
		}
	}

	/**
	 * Cursor-parity mode dropdown (Agent / Plan / Ask) anchored to the
	 * button. Phase 72: a custom colored popup instead of the stock
	 * context menu — each mode carries its own color, the selected one is
	 * highlighted with a bright pill of its color (no checkmark), and the
	 * popup anchors above the trigger button (the input sits at the pane
	 * bottom). Dismissed by any outside press or Esc.
	 */
	private showModeMenu(anchor?: HTMLElement): void {
		const anchorElement = anchor ?? this.modeButton;
		if (!anchorElement) {
			return;
		}
		// Clicking the trigger again toggles the popup closed.
		if (this.modeMenuPopup) {
			this.closeModeMenu();
			return;
		}
		const popup = document.createElement('div');
		popup.className = 'vibe-ai-mode-menu';
		popup.setAttribute('role', 'menu');
		for (const item of this.modeItems()) {
			const selected = this.mode === item.id;
			const row = document.createElement('button');
			row.className = `vibe-ai-mode-menu-item mode-${item.id}${selected ? ' selected' : ''}`;
			row.setAttribute('role', 'menuitemradio');
			row.setAttribute('aria-checked', selected ? 'true' : 'false');
			row.setAttribute('aria-label', `${item.label} — ${item.desc}`);
			const icon = document.createElement('span');
			icon.className = `codicon ${item.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			row.append(icon);
			const body = document.createElement('span');
			body.className = 'vibe-ai-mode-menu-body';
			const label = document.createElement('span');
			label.className = 'vibe-ai-mode-menu-label';
			label.textContent = item.label;
			const desc = document.createElement('span');
			desc.className = 'vibe-ai-mode-menu-desc';
			desc.textContent = item.desc;
			body.append(label, desc);
			row.append(body);
			this.modeMenuDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.setMode(item.id);
				this.closeModeMenu();
			}));
			popup.append(row);
		}
		// Fixed positioning above the trigger (the input sits at the pane
		// bottom); flips below when there is no room above (small panes).
		document.body.appendChild(popup);
		const rect = anchorElement.getBoundingClientRect();
		const popupRect = popup.getBoundingClientRect();
		let left = rect.left;
		if (left + popupRect.width > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - 8 - popupRect.width);
		}
		let top = rect.top - popupRect.height - 6;
		if (top < 8) {
			top = rect.bottom + 6;
		}
		popup.style.left = `${Math.round(left)}px`;
		popup.style.top = `${Math.round(top)}px`;
		this.modeMenuPopup = popup;
		// Dismiss on any outside press (capture — beats inner handlers)
		// or Escape; pressing the trigger again is handled by its own
		// click listener (the press is inside the anchor → no close here).
		this.modeMenuDisposables.add(DOM.addDisposableListener(document, 'pointerdown', e => {
			const target = e.target as Node;
			if (!popup.contains(target) && !anchorElement.contains(target)) {
				this.closeModeMenu();
			}
		}, true));
		this.modeMenuDisposables.add(DOM.addDisposableListener(document, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				this.closeModeMenu();
			}
		}, true));
	}

	/** Phase 72: closes the custom mode dropdown (popup + listeners). */
	private closeModeMenu(): void {
		this.modeMenuDisposables.clear();
		this.modeMenuPopup?.remove();
		this.modeMenuPopup = undefined;
	}

	override dispose(): void {
		this.closeModeMenu();
		super.dispose();
	}

	private setMode(mode: VibeAIChatMode): void {
		this.mode = mode;
		this.updateModeLabel();
		// Phase 48: a mode pick from the edit box's dropdown keeps the
		// edit open and returns focus to its textarea (typing continues).
		// Phase 50: deferred so the menu's own focus restore (back to the
		// dropdown button) doesn't override it.
		setTimeout(() => this.refocusPromptEdit(), 0);
	}

	/** Cursor-parity model dropdown: Auto + Optimize For + imported models + ad-hoc custom. */
	private showModelMenu(anchor?: HTMLElement): void {
		const anchorElement = anchor ?? this.modelButton;
		if (!anchorElement) {
			return;
		}
		// IAction[]: the Optimize For entry is a SubmenuAction (nested menu),
		// which implements IAction rather than extending Action.
		const actions: IAction[] = [
			new Action('vibeAI.model.auto', localize('vibeAIChat.modelAuto', "Auto"), undefined, true, () => this.setModel('Auto')),
		];
		// Phase 70: Optimize For submenu (Cursor Router parity) — biases the
		// Auto router's tier choice; persisted as `vibeAI.chat.autoMode`.
		actions.push(new SubmenuAction(
			'vibeAI.model.optimizeFor',
			localize('vibeAIChat.optimizeFor', "Optimize For"),
			[
				new Action('vibeAI.model.optimizeFor.cost', localize('vibeAIChat.optimizeForCost', "Cost"), undefined, true, () => this.setAutoMode('cost')),
				new Action('vibeAI.model.optimizeFor.balance', localize('vibeAIChat.optimizeForBalance', "Balance"), undefined, true, () => this.setAutoMode('balance')),
				new Action('vibeAI.model.optimizeFor.intelligence', localize('vibeAIChat.optimizeForIntelligence', "Intelligence"), undefined, true, () => this.setAutoMode('intelligence')),
			]
		));
		// Imported models (Settings → Models): label = display name, id = registry id.
		// Disabled models (toggled off in settings) stay hidden here.
		for (const model of this.modelStore.list()) {
			if (model.disabled) {
				continue;
			}
			actions.push(new Action(`vibeAI.model.${model.id}`, model.name, undefined, true, () => this.setModel(model.id)));
		}
		actions.push(new Action('vibeAI.model.customPick', localize('vibeAIChat.modelCustom', "Custom model…"), undefined, true, async () => {
			try {
				const value = await this.quickInputService.input({
					title: localize('vibeAIChat.modelCustomTitle', "Custom model name"),
					placeHolder: localize('vibeAIChat.modelCustomPlaceholder', "e.g. my-model (empty = Auto)"),
					value: this.model !== 'Auto' ? this.model : '',
				});
				if (value !== undefined) {
					const trimmed = value.trim();
					this.setModel(trimmed.length > 0 ? trimmed : 'Auto');
				}
			} catch (err) {
				this.logService.debug('[VibeAI] model input cancelled', err);
			}
		}));
		// Reflect default/selection changes from the settings dialog live.
		this.model = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		for (const action of actions) {
			action.checked = action.id === (this.model === 'Auto' ? 'vibeAI.model.auto' : `vibeAI.model.${this.model}`);
		}
		// Phase 70: the Optimize For submenu's checked state (Cursor parity:
		// the current bias shows a checkmark). The parent SubmenuAction is
		// never checked.
		const optimizeFor = actions.find(action => action.id === 'vibeAI.model.optimizeFor') as SubmenuAction | undefined;
		if (optimizeFor) {
			for (const child of optimizeFor.actions) {
				child.checked = child.id === `vibeAI.model.optimizeFor.${this.autoMode}`;
			}
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchorElement,
			getActions: () => actions,
		});
	}

	private setModel(model: string): void {
		this.model = model;
		this.updateModelLabel();
		// Persist the choice (Cursor-parity: the model sticks across restarts).
		void this.configurationService.updateValue('vibeAI.chat.model', model === 'Auto' ? '' : model);
		// Phase 48: a model pick from the edit box's dropdown keeps the
		// edit open and returns focus to its textarea (typing continues).
		// Phase 50: deferred so the menu's own focus restore (back to the
		// dropdown button) doesn't override it.
		setTimeout(() => this.refocusPromptEdit(), 0);
	}

	/**
	 * Phase 70: sets the Auto router's Optimize For bias (Cursor parity:
	 * cost / balance / intelligence). Persisted as `vibeAI.chat.autoMode`
	 * and applied on the next Auto turn (routing is per message).
	 */
	private setAutoMode(mode: string): void {
		this.autoMode = mode;
		// Persist the choice (sticks across restarts, Cursor parity).
		void this.configurationService.updateValue('vibeAI.chat.autoMode', mode);
		// Phase 48/50: same focus handling as the mode/model picks.
		setTimeout(() => this.refocusPromptEdit(), 0);
	}

	/** Phase 48: returns focus to the open edit box's textarea, if any. */
	private refocusPromptEdit(): void {
		const edit = this.promptEdit;
		if (edit && !edit.committing) {
			edit.textarea.focus();
		}
	}

	/**
	 * Cursor-parity @ context: attaches the active editor file (path +
	 * content, clipped) to the next request, surfaced as a removable chip.
	 */
	private attachActiveFile(): void {
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!model) {
			return;
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		const relPath = folder ? relativePath(folder.uri, model.uri) : undefined;
		const displayPath = relPath ?? basename(model.uri);
		if (this.attachedFiles.some(f => f.path === displayPath)) {
			return;
		}
		const content = model.getValue();
		this.attachedFiles.push({
			path: displayPath,
			content: content.length > FILE_CONTEXT_MAX_CHARS ? content.substring(0, FILE_CONTEXT_MAX_CHARS) : content,
		});
		this.renderChips();
	}

	private renderChips(): void {
		// Phase 48: chips render into the main input AND an open edit box
		// — both composers show the same attachedFiles state (Cursor
		// parity: the edit box is the input below).
		this.renderChipsInto(this.chipsRow, this.chipsDisposables);
		const edit = this.promptEdit;
		if (edit?.chipsRow) {
			this.renderChipsInto(edit.chipsRow, edit.chipsListeners);
		}
	}

	/** Renders the attached-file chips into one composer's chips row. */
	private renderChipsInto(row: HTMLElement | undefined, listeners: DisposableStore): void {
		const rowEl = row;
		if (!rowEl) {
			return;
		}
		listeners.clear();
		DOM.clearNode(rowEl);
		rowEl.style.display = (this.attachedFiles.length > 0 || this.attachedImages.length > 0) ? 'flex' : 'none';
		// Phase 61: pasted-image chips — thumbnail + remove.
		this.attachedImages.forEach((dataUrl, index) => {
			const chip = DOM.append(rowEl, $('.vibe-ai-chip.vibe-ai-image-chip'));
			const img = DOM.append(chip, $('img.vibe-ai-image-chip-thumb')) as HTMLImageElement;
			img.src = dataUrl;
			img.alt = '';
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIChat.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				this.attachedImages.splice(index, 1);
				this.renderChips();
				this.updateInputActions();
			}));
		});
		for (const file of this.attachedFiles) {
			const chip = DOM.append(rowEl, $('.vibe-ai-chip'));
			const icon = DOM.append(chip, $('span.codicon.codicon-symbol-file'));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(chip, $('span.vibe-ai-chip-name'));
			name.textContent = file.path;
			name.title = file.path;
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIChat.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				this.attachedFiles = this.attachedFiles.filter(f => f.path !== file.path);
				this.renderChips();
			}));
		}
	}

	// ==================== Context Usage panel (Phase 41: Cursor parity) ====================

	/**
	 * Cursor-parity Context Usage panel: a card above the input showing
	 * the conversation's token breakdown (segmented progress bar + rows)
	 * against the custom context limit. Toggled by the context ring left
	 * of the attach button.
	 */
	private renderContextPanel(container: HTMLElement, beforeNode: HTMLElement): void {
		this.contextPanel = $('.vibe-ai-context-panel');
		this.contextPanel.style.display = 'none';
		container.insertBefore(this.contextPanel, beforeNode);

		const header = DOM.append(this.contextPanel, $('.vibe-ai-context-panel-header'));
		const title = DOM.append(header, $('span.vibe-ai-context-panel-title'));
		title.textContent = localize('vibeAIChat.contextUsage', "Context Usage");
		const close = DOM.append(header, $('button.codicon.codicon-close.vibe-ai-context-panel-close')) as HTMLButtonElement;
		close.setAttribute('aria-label', localize('vibeAIChat.contextUsageClose', "Close"));
		this._register(DOM.addDisposableListener(close, DOM.EventType.CLICK, () => this.toggleContextPanel(false)));

		const usageRow = DOM.append(this.contextPanel, $('.vibe-ai-context-usage-row'));
		this.contextPercentLabel = DOM.append(usageRow, $('span.vibe-ai-context-percent'));
		const totalWrap = DOM.append(usageRow, $('span.vibe-ai-context-total'));
		this.contextTotalLabel = DOM.append(totalWrap, $('span.vibe-ai-context-total-text'));
		DOM.append(totalWrap, $('span.vibe-ai-context-total-suffix')).textContent = localize('vibeAIChat.contextTokens', "Tokens");

		// The usage bar visualizes the row above; the limit control below
		// adjusts the scale it is drawn against.
		this.contextBar = DOM.append(this.contextPanel, $('.vibe-ai-context-bar'));

		// Max-context limit row: a muted "Limit" label, the range control
		// (100K–1M) and the current value at its right end — an editable
		// text field using the same "200K" formatting as the readouts,
		// two-way linked with the slider.
		const sliderRow = DOM.append(this.contextPanel, $('.vibe-ai-context-slider-row'));
		DOM.append(sliderRow, $('span.vibe-ai-context-slider-label')).textContent = localize('vibeAIChat.contextLimitLabel', "Limit");
		this.contextSlider = DOM.append(sliderRow, $('input.vibe-ai-context-slider')) as HTMLInputElement;
		this.contextSlider.type = 'range';
		this.contextSlider.min = `${CONTEXT_LIMIT_MIN}`;
		this.contextSlider.max = `${CONTEXT_LIMIT_MAX}`;
		this.contextSlider.step = '50000';
		this.contextSlider.value = `${this.contextLimit}`;
		this.contextSlider.title = localize('vibeAIChat.contextLimitSlider', "Maximum context (100K–1M tokens)");
		// Dragging updates the limit live (bar/warning/labels re-render);
		// the backend estimate refreshes on release only.
		this._register(DOM.addDisposableListener(this.contextSlider, 'input', () => {
			const parsed = Number.parseInt(this.contextSlider?.value ?? '', 10);
			if (Number.isFinite(parsed)) {
				this.contextLimit = Math.max(CONTEXT_LIMIT_MIN, Math.min(CONTEXT_LIMIT_MAX, parsed));
				this.renderContextUsage();
			}
		}));
		this._register(DOM.addDisposableListener(this.contextSlider, 'change', () => {
			void this.refreshContextUsage();
		}));
		this.contextLimitInput = DOM.append(sliderRow, $('input.vibe-ai-context-limit-input')) as HTMLInputElement;
		this.contextLimitInput.type = 'text';
		this.contextLimitInput.spellcheck = false;
		this.contextLimitInput.value = formatContextTokens(this.contextLimit);
		this.contextLimitInput.title = localize('vibeAIChat.contextLimitEdit', "Edit the context limit (100K–1M tokens)");
		this.contextLimitInput.setAttribute('aria-label', localize('vibeAIChat.contextLimitEdit', "Edit the context limit (100K–1M tokens)"));
		// Select on focus so the formatted value is overwritten cleanly.
		this._register(DOM.addDisposableListener(this.contextLimitInput, 'focus', () => this.contextLimitInput?.select()));
		// Live link while typing: slider, bar and labels follow the typed
		// value ("300000", "300K", "0.3M" all parse). The input's own
		// value is only rewritten on commit so typing is never fought.
		this._register(DOM.addDisposableListener(this.contextLimitInput, 'input', () => {
			const parsed = parseContextTokens(this.contextLimitInput?.value ?? '');
			if (parsed !== undefined) {
				this.contextLimit = Math.max(CONTEXT_LIMIT_MIN, Math.min(CONTEXT_LIMIT_MAX, parsed));
				this.renderContextUsage();
			}
		}));
		// Commit on Enter/blur: normalize the shown value and refresh the
		// backend estimate.
		this._register(DOM.addDisposableListener(this.contextLimitInput, 'change', () => {
			const parsed = parseContextTokens(this.contextLimitInput?.value ?? '');
			if (parsed !== undefined) {
				this.contextLimit = Math.max(CONTEXT_LIMIT_MIN, Math.min(CONTEXT_LIMIT_MAX, parsed));
			}
			if (this.contextLimitInput) {
				this.contextLimitInput.value = formatContextTokens(this.contextLimit);
			}
			this.renderContextUsage();
			void this.refreshContextUsage();
		}));
		this._register(DOM.addDisposableListener(this.contextLimitInput, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				DOM.EventHelper.stop(e, true);
				this.contextLimitInput?.blur();
			} else if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				if (this.contextLimitInput) {
					this.contextLimitInput.value = formatContextTokens(this.contextLimit);
					this.contextLimitInput.blur();
				}
			}
		}));

		this.contextRows = DOM.append(this.contextPanel, $('.vibe-ai-context-rows'));
		this.contextWarning = DOM.append(this.contextPanel, $('.vibe-ai-context-warning'));

		this.renderContextUsage();
	}

	/** Renders percent / total / limit labels, the bar, the rows and the ring. */
	private renderContextUsage(): void {
		// The ring stays live even while the panel is hidden.
		this.renderContextRingState();

		if (!this.contextPercentLabel || !this.contextTotalLabel || !this.contextLimitInput || !this.contextBar || !this.contextRows || !this.contextWarning) {
			return;
		}
		const usage = this.contextUsage;
		const limit = this.contextLimit;
		const percent = usage ? usage.percentFull : 0;
		const total = usage ? usage.totalTokens : 0;

		// Cursor parity: "16% Full" — small shares keep one decimal.
		const percentText = percent >= 10 ? `${Math.round(percent)}` : `${Number(percent.toFixed(1))}`;
		this.contextPercentLabel.textContent = localize('vibeAIChat.contextPercentFull', "{0}% Full", percentText);
		// The editable limit input lives on the slider row now — the usage
		// line shows the full "~used / limit" readout.
		this.contextTotalLabel.textContent = `~${formatContextTokens(total)} / ${formatContextTokens(limit)}`;
		// Keep the slider and the value input in sync (slider drag,
		// conversation switches and backend refreshes all funnel through
		// here). The input is not rewritten while the user is typing.
		if (this.contextSlider) {
			this.contextSlider.value = `${limit}`;
		}
		if (this.contextLimitInput && this.contextLimitInput !== document.activeElement) {
			this.contextLimitInput.value = formatContextTokens(limit);
		}

		DOM.clearNode(this.contextBar);
		DOM.clearNode(this.contextRows);
		for (const part of usage?.parts ?? []) {
			const style = CONTEXT_PART_STYLES[part.key];
			const segment = DOM.append(this.contextBar, $('span.vibe-ai-context-bar-segment'));
			segment.style.width = `${Math.min(100, Math.max(0, part.tokens / limit * 100))}%`;
			segment.style.background = style?.color ?? 'var(--vscode-charts-purple)';
			segment.title = `${style?.label ?? part.key}: ${part.tokens.toLocaleString()}`;

			const row = DOM.append(this.contextRows, $('.vibe-ai-context-row'));
			const dot = DOM.append(row, $('span.vibe-ai-context-row-dot'));
			dot.style.background = style?.color ?? 'var(--vscode-charts-purple)';
			const label = DOM.append(row, $('span.vibe-ai-context-row-label'));
			label.textContent = style?.label ?? part.key;
			const tokens = DOM.append(row, $('span.vibe-ai-context-row-tokens'));
			tokens.textContent = formatContextTokens(part.tokens);
			tokens.title = `${part.tokens.toLocaleString()} tokens`;
		}

		// Over-limit warning banner (Cursor parity).
		DOM.clearNode(this.contextWarning);
		if (usage?.overLimit) {
			this.contextWarning.style.display = 'flex';
			const icon = DOM.append(this.contextWarning, $('span.codicon.codicon-warning'));
			icon.setAttribute('aria-hidden', 'true');
			const text = DOM.append(this.contextWarning, $('span'));
			text.textContent = localize(
				'vibeAIChat.contextOverLimit',
				"Over the {0} token limit — older history will be compressed before the next request",
				formatContextTokens(limit)
			);
		} else {
			this.contextWarning.style.display = 'none';
		}
	}

	/** Shows/hides the Context Usage panel (defaults to toggling). */
	private toggleContextPanel(open?: boolean): void {
		const target = open ?? !this.contextPanelOpen;
		this.contextPanelOpen = target;
		if (this.contextPanel) {
			this.contextPanel.style.display = target ? 'block' : 'none';
		}
		if (target) {
			void this.refreshContextUsage();
			// The conversation area shrinks while the panel is open — keep
			// the latest turns visible above it so nothing sits hidden
			// behind the panel.
			this.scrollBottom(undefined, true);
		}
	}

	// ==================== History (Cursor-parity chat history) ====================

	/**
	 * Fetches the usage estimate for the current conversation from the
	 * backend and re-renders the panel. Best-effort — the last estimate
	 * stays visible when the backend is unreachable.
	 */
	private async refreshContextUsage(target?: VibeAIConversation): Promise<void> {
		const conversation = target ?? this.getActiveConversation();
		if (!conversation) {
			return;
		}
		// Phase 44: sequence guard PER CONVERSATION — only the latest
		// response for this conversation is rendered; a parallel tab's
		// refresh never cancels it.
		const seq = ++conversation.contextUsageSeq;
		const isActive = conversation.id === this.activeConversationId;
		const history = isActive ? this.history : conversation.history;
		const attachedFiles = isActive ? this.attachedFiles : conversation.attachedFiles;
		const contextLimit = isActive ? this.contextLimit : conversation.contextLimit;
		try {
			const usage = await this.vibeAIService.contextUsage({
				messages: [...history],
				...(attachedFiles.length > 0 ? { context: { files: attachedFiles } } : {}),
				contextLimit,
				// Ask mode estimates against the read-only tool subset.
				readonly: this.mode !== 'agent'
			});
			// The ring updates regardless of the panel state.
			if (seq !== conversation.contextUsageSeq) {
				return;
			}
			conversation.contextUsage = usage;
			if (isActive) {
				this.contextUsage = usage;
				this.renderContextUsage();
			}
		} catch (err) {
			this.logService.debug('[VibeAI] context usage request failed', err);
		}
	}

	// ==================== Phase 78: `/` skill completion (Cursor parity) ====================

	/**
	 * A `/token` being typed: the text from the caret back to the last
	 * whitespace (or input start) matching `/<chars>` — `undefined` when no
	 * completion query is active. Paths like `/usr/bin` match this shape
	 * too; the menu only lists actual skills and the backend injects
	 * nothing without an exact skill-name match.
	 */
	private skillCommandToken(): string | undefined {
		const input = this.inputElement;
		if (!input) {
			return undefined;
		}
		const upToCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
		const match = /(?:^|\s)\/([^\s]*)$/.exec(upToCaret);
		return match ? match[1] : undefined;
	}

	/**
	 * Opens/filters/closes the `/` skill completion popup from the current
	 * input state. The skill list lazy-loads once from the backend
	 * (`listSkills`) and refreshes after each send; an empty token (just
	 * `/`) lists every workspace skill, otherwise the typed prefix filters
	 * (case-insensitive startsWith — Cursor parity).
	 */
	private async updateSkillMenu(): Promise<void> {
		const token = this.skillCommandToken();
		if (token === undefined) {
			this.closeSkillMenu();
			return;
		}
		if (!this.skillListLoaded) {
			this.skillListLoaded = true;
			try {
				this.skillList = await this.vibeAIService.listSkills();
			} catch (err) {
				this.skillListLoaded = false;
				this.logService.debug('[VibeAI] skills request failed', err);
				return;
			}
			// The await may have raced an input change — re-read the token.
			if (this.skillCommandToken() === undefined) {
				return;
			}
		}
		const query = token.toLowerCase();
		const matches = this.skillList.filter(skill => !query || skill.name.toLowerCase().startsWith(query));
		if (matches.length === 0) {
			this.closeSkillMenu();
			return;
		}
		if (!this.skillMenu) {
			this.buildSkillMenu();
		}
		this.renderSkillList(matches);
		this.positionSkillMenu();
	}

	/** Builds the empty skill popup (rows re-render on every keystroke). */
	private buildSkillMenu(): void {
		const container = this.viewContainer;
		if (!container) {
			return;
		}
		const menu = $('.vibe-ai-skill-menu');
		menu.setAttribute('role', 'listbox');
		DOM.append(menu, $('.vibe-ai-skill-list'));
		container.appendChild(menu);
		this.skillMenu = menu;
		// Click-outside dismisses (rows are excluded — their click picks).
		this.skillMenuDisposables.add(DOM.addDisposableListener(container.ownerDocument, 'pointerdown', e => {
			const target = e.target as Node | null;
			if (target && menu.contains(target)) {
				return;
			}
			this.closeSkillMenu();
		}, true));
	}

	/** Re-renders the popup rows: `/<name>` + user-only badge + description. */
	private renderSkillList(matches: IVibeAISkill[]): void {
		const menu = this.skillMenu;
		const list = menu?.querySelector('.vibe-ai-skill-list');
		if (!menu || !(list instanceof HTMLElement)) {
			return;
		}
		this.skillRowsDisposables.clear();
		DOM.clearNode(list);
		this.skillMenuIndex = 0;
		matches.forEach((skill, index) => {
			const row = DOM.append(list, $('.vibe-ai-skill-row'));
			row.setAttribute('role', 'option');
			row.classList.toggle('active', index === 0);
			const name = DOM.append(row, $('span.vibe-ai-skill-name'));
			name.textContent = `/${skill.name}`;
			if (skill.disableModelInvocation) {
				const badge = DOM.append(row, $('span.vibe-ai-skill-badge'));
				badge.textContent = localize('vibeAIChat.skillUserOnly', "user only");
			}
			if (skill.description) {
				const desc = DOM.append(row, $('span.vibe-ai-skill-desc'));
				desc.textContent = skill.description;
				row.title = skill.description;
			}
			this.skillRowsDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				this.pickSkill(skill);
			}));
		});
	}

	/** Anchors the popup above the input box (left-aligned, capped at the pane top). */
	private positionSkillMenu(): void {
		const menu = this.skillMenu;
		const input = this.inputElement;
		const container = this.viewContainer;
		if (!menu || !input || !container) {
			return;
		}
		const containerRect = container.getBoundingClientRect();
		const inputRect = input.getBoundingClientRect();
		const top = Math.round(inputRect.top - containerRect.top - menu.offsetHeight - 6);
		menu.style.top = `${Math.max(4, top)}px`;
		menu.style.left = `${Math.round(inputRect.left - containerRect.left)}px`;
	}

	/**
	 * Navigation keys while the popup is open — returns true when consumed:
	 * ArrowUp/Down walk the rows, Enter/Tab pick (the message does NOT send
	 * mid-completion), Esc dismisses.
	 */
	private handleSkillMenuKeys(e: KeyboardEvent): boolean {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			DOM.EventHelper.stop(e, true);
			this.moveSkillFocus(e.key === 'ArrowDown' ? 1 : -1);
			return true;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			DOM.EventHelper.stop(e, true);
			this.pickFocusedSkill();
			return true;
		}
		if (e.key === 'Escape') {
			DOM.EventHelper.stop(e, true);
			this.closeSkillMenu();
			return true;
		}
		return false;
	}

	private moveSkillFocus(delta: number): void {
		const rows = this.skillMenu?.querySelectorAll<HTMLElement>('.vibe-ai-skill-row');
		if (!rows || rows.length === 0) {
			return;
		}
		const count = rows.length;
		const next = (this.skillMenuIndex + delta + count) % count;
		rows[Math.max(0, this.skillMenuIndex)]?.classList.remove('active');
		this.skillMenuIndex = next;
		rows[next].classList.add('active');
		rows[next].scrollIntoView({ block: 'nearest' });
	}

	private pickFocusedSkill(): void {
		const row = this.skillMenu?.querySelectorAll<HTMLElement>('.vibe-ai-skill-row')[this.skillMenuIndex];
		if (row instanceof HTMLElement) {
			const name = row.querySelector('.vibe-ai-skill-name')?.textContent ?? '';
			this.replaceSkillToken(name);
			this.closeSkillMenu();
			this.inputElement?.focus();
		}
	}

	/** Click pick: replace the typed token with the canonical `/name `. */
	private pickSkill(skill: IVibeAISkill): void {
		this.replaceSkillToken(`/${skill.name}`);
		this.closeSkillMenu();
		this.inputElement?.focus();
	}

	/**
	 * Replaces the `/token` at the caret with `replacement` + a trailing
	 * space — the message keeps the slash command so the backend injects
	 * the skill's `<skill_content>` block on send.
	 */
	private replaceSkillToken(replacement: string): void {
		const input = this.inputElement;
		if (!input) {
			return;
		}
		const caret = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, caret);
		const after = input.value.slice(caret);
		const match = /(?:^|\s)\/([^\s]*)$/.exec(before);
		if (!match) {
			return;
		}
		const slashPos = caret - match[1].length - 1;
		input.value = input.value.slice(0, slashPos) + replacement + ' ' + after;
		const nextCaret = slashPos + replacement.length + 1;
		input.setSelectionRange(nextCaret, nextCaret);
		this.autoGrowInput();
		this.updateInputActions();
	}

	/** Closes the `/` skill popup (input keeps focus — Esc dismisses it only). */
	private closeSkillMenu(): void {
		if (!this.skillMenu) {
			return;
		}
		this.skillMenu.remove();
		this.skillMenu = undefined;
		this.skillMenuIndex = -1;
		this.skillMenuDisposables.clear();
		this.skillRowsDisposables.clear();
	}

	/**
	 * Opens the chat history dropdown (Phase 49: Cursor-parity in-pane
	 * menu anchored below the tab bar's clock button). The clock toggles:
	 * an open menu closes instead of reopening.
	 */
	showHistory(): void {
		if (this.historyMenu) {
			this.closeHistoryMenu(true);
			return;
		}
		const anchor = this.historyButton ?? this.tabBar;
		const container = this.viewContainer;
		if (!anchor || !container) {
			return;
		}
		this.openHistoryMenu(anchor, container);
	}

	/**
	 * Builds the history dropdown: search box ("Search Agents…") + recency
	 * groups (Pinned / Today / Previous 7 days / Older) with per-row hover
	 * actions (more / pin / delete), anchored below the clock button and
	 * spanning the pane (Cursor parity).
	 */
	private openHistoryMenu(anchor: HTMLElement, container: HTMLElement): void {
		this.closeHistoryMenu();

		const menu = $('.vibe-ai-history-menu');
		menu.setAttribute('role', 'menu');
		const store = this.historyMenuDisposables;

		// --- search box (Cursor parity: "Search Agents…")
		const search = DOM.append(menu, $('.vibe-ai-history-search'));
		const searchInput = DOM.append(search, $('input.vibe-ai-history-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.spellcheck = false;
		searchInput.placeholder = localize('vibeAIChat.historySearch', "Search Agents...");

		const list = DOM.append(menu, $('.vibe-ai-history-list'));

		// Filter on every keystroke — rows re-render in place.
		store.add(DOM.addDisposableListener(searchInput, DOM.EventType.INPUT, () => {
			this.renderHistoryList(list, searchInput.value);
		}));
		this.renderHistoryList(list, searchInput.value);

		// Keyboard: Esc dismisses (focus returns to the clock), arrows walk
		// the rows from the search box.
		store.add(DOM.addDisposableListener(searchInput, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				this.closeHistoryMenu(true);
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				DOM.EventHelper.stop(e, true);
				this.moveHistoryFocus(list, e.key === 'ArrowDown' ? 1 : -1);
			}
		}));
		// Row-level keyboard: Esc bubbles here, arrows keep walking.
		store.add(DOM.addDisposableListener(list, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				this.closeHistoryMenu(true);
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				DOM.EventHelper.stop(e, true);
				this.moveHistoryFocus(list, e.key === 'ArrowDown' ? 1 : -1);
			}
		}));

		// Click-outside dismisses (the anchor button is excluded — its click
		// toggles; a row's "…" context menu keeps the dropdown alive).
		store.add(DOM.addDisposableListener(container.ownerDocument, 'pointerdown', e => {
			const target = e.target as Node | null;
			if (target && (menu.contains(target) || anchor.contains(target))) {
				return;
			}
			// VS Code context menus render into a `.context-view` block —
			// interacting with one must not dismiss the dropdown under it.
			const path = e.composedPath();
			if (path.some(node => node instanceof HTMLElement && node.classList.contains('context-view'))) {
				return;
			}
			this.closeHistoryMenu();
		}, true));

		// Anchor below the clock button, spanning the pane with a small
		// inset (Cursor parity), capped at the pane's bottom edge.
		container.appendChild(menu);
		const containerRect = container.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const top = Math.round(anchorRect.bottom - containerRect.top + 4);
		menu.style.top = `${top}px`;
		menu.style.maxHeight = `${Math.max(160, Math.round(containerRect.height - top - 8))}px`;
		this.historyMenu = menu;
		searchInput.focus();
	}

	/** Closes the history dropdown (refocus = Esc/toggle: focus returns to the clock). */
	private closeHistoryMenu(refocus = false): void {
		if (!this.historyMenu) {
			return;
		}
		this.historyMenu.remove();
		this.historyMenu = undefined;
		this.historyMenuDisposables.clear();
		this.historyRowsDisposables.clear();
		if (refocus) {
			this.historyButton?.focus();
		}
	}

	/**
	 * Re-renders the dropdown rows: pinned sessions first (Cursor parity),
	 * then the recency groups Today / Previous 7 days / Older.
	 */
	private renderHistoryList(list: HTMLElement, query: string): void {
		this.historyRowsDisposables.clear();
		DOM.clearNode(list);
		const sessions = this.sessionStore.list();
		const needle = query.trim().toLowerCase();
		const filtered = needle.length > 0
			? sessions.filter(session => session.title.toLowerCase().includes(needle))
			: sessions;

		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
		let count = 0;
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyPinned', "Pinned"), filtered.filter(session => session.pinned));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyToday', "Today"), filtered.filter(session => !session.pinned && session.updatedAt >= todayStart));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyPrevious7Days', "Previous 7 days"), filtered.filter(session => !session.pinned && session.updatedAt >= weekStart && session.updatedAt < todayStart));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyOlder', "Older"), filtered.filter(session => !session.pinned && session.updatedAt < weekStart));
		if (count === 0) {
			const empty = DOM.append(list, $('.vibe-ai-history-empty'));
			empty.textContent = needle.length > 0
				? localize('vibeAIChat.historyNoMatches', "No matching chats")
				: localize('vibeAIChat.historyNoChats', "No chats yet");
		}
	}

	/** Renders one recency group (label + rows). Returns the rendered row count. */
	private renderHistoryGroup(list: HTMLElement, label: string, sessions: IVibeAIChatSession[]): number {
		if (sessions.length === 0) {
			return 0;
		}
		const group = DOM.append(list, $('.vibe-ai-history-group'));
		const groupLabel = DOM.append(group, $('.vibe-ai-history-group-label'));
		groupLabel.textContent = label;
		for (const session of sessions) {
			const item = DOM.append(group, $('.vibe-ai-history-item'));
			item.tabIndex = -1;
			item.setAttribute('role', 'menuitem');
			// Status circle: filled check = the conversation is open in a tab.
			const open = this.conversations.some(conversation => conversation.sessionId === session.id);
			const icon = DOM.append(item, open
				? $('span.codicon.codicon-pass-filled.vibe-ai-history-item-icon.open')
				: $('span.codicon.codicon-circle-large-outline.vibe-ai-history-item-icon'));
			icon.setAttribute('aria-hidden', 'true');
			const title = DOM.append(item, $('span.vibe-ai-history-item-title'));
			title.textContent = session.title;
			title.title = `${session.title} · ${fromNowByDay(session.updatedAt, true)}`;

			// --- hover actions: more (…) / pin / delete
			const actions = DOM.append(item, $('.vibe-ai-history-item-actions'));
			const moreButton = DOM.append(actions, $('button.codicon.codicon-ellipsis.vibe-ai-history-item-action')) as HTMLButtonElement;
			moreButton.title = localize('vibeAIChat.historyMore', "More Actions...");
			this.historyRowsDisposables.add(DOM.addDisposableListener(moreButton, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.showHistoryRowMenu(moreButton, session);
			}));

			const pinButton = DOM.append(actions, $('button.codicon.codicon-pinned.vibe-ai-history-item-action')) as HTMLButtonElement;
			pinButton.title = session.pinned
				? localize('vibeAIChat.historyUnpin', "Unpin")
				: localize('vibeAIChat.historyPin', "Pin");
			pinButton.classList.toggle('active', !!session.pinned);
			this.historyRowsDisposables.add(DOM.addDisposableListener(pinButton, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.sessionStore.setPinned(session.id, !session.pinned);
				this.rerenderHistoryList();
			}));

			const deleteButton = DOM.append(actions, $('button.codicon.codicon-trash.vibe-ai-history-item-action')) as HTMLButtonElement;
			deleteButton.title = localize('vibeAIChat.historyDelete', "Delete");
			this.historyRowsDisposables.add(DOM.addDisposableListener(deleteButton, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				this.deleteHistorySession(session.id);
			}));

			// Click / Enter opens the conversation and dismisses the menu.
			const openSession = () => {
				this.loadSession(session);
				this.closeHistoryMenu();
			};
			this.historyRowsDisposables.add(DOM.addDisposableListener(item, DOM.EventType.CLICK, openSession));
			this.historyRowsDisposables.add(DOM.addDisposableListener(item, DOM.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter') {
					DOM.EventHelper.stop(e, true);
					openSession();
				}
			}));
		}
		return sessions.length;
	}

	/**
	 * Re-renders the rows in place (pin / delete), keeping the search
	 * filter and the focus in the search box (Cursor keeps the menu open).
	 */
	private rerenderHistoryList(): void {
		const list = this.historyMenu?.querySelector<HTMLElement>('.vibe-ai-history-list');
		const input = this.historyMenu?.querySelector<HTMLInputElement>('.vibe-ai-history-search-input');
		if (!list || !input) {
			return;
		}
		this.renderHistoryList(list, input.value);
		input.focus();
	}

	/** "…" on a history row: open / pin-unpin / delete (VS Code context menu). */
	private showHistoryRowMenu(anchor: HTMLElement, session: IVibeAIChatSession): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new Action('vibeAI.history.open', localize('vibeAIChat.historyOpen', "Open"), undefined, true, () => {
					this.loadSession(session);
					this.closeHistoryMenu();
				}),
				new Action('vibeAI.history.pin', session.pinned
					? localize('vibeAIChat.historyUnpin', "Unpin")
					: localize('vibeAIChat.historyPin', "Pin"), undefined, true, () => {
					this.sessionStore.setPinned(session.id, !session.pinned);
					this.rerenderHistoryList();
				}),
				new Action('vibeAI.history.delete', localize('vibeAIChat.historyDelete', "Delete"), undefined, true, () => {
					this.deleteHistorySession(session.id);
				}),
			],
		});
	}

	/**
	 * Deletes a persisted conversation from the dropdown. A conversation
	 * open in a tab is closed with it (its stream is aborted, its thread
	 * removed); an emptied dropdown closes.
	 */
	private deleteHistorySession(sessionId: string): void {
		const open = this.conversations.find(conversation => conversation.sessionId === sessionId);
		if (open) {
			this.closeConversation(open.id);
		}
		this.sessionStore.delete(sessionId);
		if (this.sessionStore.list().length === 0) {
			this.closeHistoryMenu();
		} else {
			this.rerenderHistoryList();
		}
	}

	/** Moves the keyboard focus across the visible rows (wraps at the ends). */
	private moveHistoryFocus(list: HTMLElement, direction: 1 | -1): void {
		const rows = Array.from(list.querySelectorAll<HTMLElement>('.vibe-ai-history-item'));
		if (rows.length === 0) {
			return;
		}
		const active = list.ownerDocument.activeElement;
		const index = rows.indexOf(active as HTMLElement);
		const next = index === -1
			? (direction === 1 ? 0 : rows.length - 1)
			: (index + direction + rows.length) % rows.length;
		rows[next].focus();
	}

	/**
	 * Opens a persisted conversation (Cursor-parity chat history) as an
	 * editor-style tab: focuses its tab when already open, replaces the
	 * untouched active tab, or opens a new tab otherwise.
	 */
	loadSession(session: IVibeAIChatSession): void {
		const open = this.conversations.find(conversation => conversation.sessionId === session.id);
		if (open) {
			this.setActiveConversation(open.id);
			return;
		}
		let conversation = this.getActiveConversation();
		if (!conversation || !this.isConversationEmpty(conversation)) {
			conversation = this.createConversation();
		}
		this.activeConversationId = conversation.id;
		conversation.sessionId = session.id;
		conversation.title = session.title;
		// Phase 61: images (data URLs) ride along on user messages — the
		// restored thread shows the sent thumbnails again.
		conversation.history = session.messages.map(m => ({
			role: m.role,
			content: m.content,
			...(m.images && m.images.length > 0 ? { images: m.images } : {}),
		}));
		conversation.attachedFiles = [];
		// Phase 41: restore the per-session context limit.
		conversation.contextLimit = session.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
		conversation.contextUsage = undefined;
		this.syncFromActiveConversation();
		// Phase 47: cancel an open prompt edit before the thread is
		// rebuilt (only the active conversation's thread can be edited).
		this.cancelPromptEdit();
		DOM.clearNode(conversation.container);
		this.showOnlyConversation(conversation.id);
		this.renderTabs();
		this.renderChips();
		this.updateInputActions();
		// Phase 45: restore with full parity — per-turn artifacts (thinking,
		// tool cards, file changes, checkpoint footers) when the session has
		// them; plain pairs otherwise (sessions saved before Phase 45).
		if (session.turns && session.turns.length > 0) {
			// Phase 61: the turns map 1:1 to the session's user messages —
			// the k-th turn's images come from the k-th user message.
			const userMessages = session.messages.filter(m => m.role === 'user');
			conversation.turns = session.turns.map(turn => ({
				userText: turn.userText,
				thinking: turn.thinking,
				thinkingDurationMs: turn.thinkingDurationMs,
				workDurationMs: turn.workDurationMs,
				tools: [...(turn.tools ?? [])],
				answer: turn.answer,
				turnStartedAt: turn.turnStartedAt,
				contextCompressed: turn.contextCompressed,
				outputTruncated: turn.outputTruncated,
				error: turn.error,
				turnChanges: [...(turn.turnChanges ?? [])],
				rolledBack: turn.rolledBack,
				// Phase 58/60: the interleaved narration segments and the
				// chronological timeline nodes ride along (old sessions
				// predate both and restore via the older layouts).
				segments: turn.segments,
				timeline: turn.timeline,
				// Phase 70/71: the Auto router's pick and the Plan-mode
				// card ride along too (Cursor-parity restore).
				routedModel: turn.routedModel,
				plan: turn.plan,
				planStatus: turn.planStatus,
				planResults: turn.planResults,
				row: undefined,
			}));
			for (let index = 0; index < conversation.turns.length; index++) {
				// Phase 61: the k-th turn ↔ the k-th user message — its
				// images (if any) render as the turn's thumbnail strip.
				this.renderUserTurn(conversation, conversation.turns[index].userText, userMessages[index]?.images);
				this.renderAssistantFromTurn(conversation, conversation.turns[index], index);
			}
		} else {
			for (const message of conversation.history) {
				if (message.role === 'user') {
					this.renderUserTurn(conversation, message.content, message.images);
				} else {
					this.renderAssistantFromText(conversation, message.content);
				}
			}
		}
		// Phase 56: the docked review bar shows the restored conversation's
		// latest turn with changes (hidden when none).
		this.renderDockedFilesSummary();
		this.scrollBottom(undefined, true);
		void this.refreshContextUsage();
		// Phase 79: a session opened from history joins the open strip.
		this.persistOpenState();
	}

	/**
	 * Phase 45: renders a completed assistant turn from its persisted
	 * record — full parity to the live view: thinking ("Thought for X"),
	 * tool activity cards, markdown answer and the checkpoint footer
	 * (per-turn restore / checkpoint rollback stay functional after a
	 * reload). Phase 56: the files summary moved to the docked review
	 * bar above the input (renderDockedFilesSummary). Phase 60: with a
	 * recorded `timeline` the turn rebuilds from its chronological nodes
	 * (renderAssistantFromTimeline — multiple Thought/Worked/narration
	 * blocks in agent run order, durations per block); sessions saved
	 * before Phase 60 predate the field and restore via the older
	 * Phase 58 interleaved (or merged) layouts below.
	 */
	private renderAssistantFromTurn(conversation: VibeAIConversation, turn: IVibeAIPersistedTurn, turnIndex: number): void {
		if (turn.contextCompressed) {
			const note = DOM.append(conversation.container, $('.vibe-ai-context-compressed-note'));
			note.textContent = localize('vibeAIChat.contextCompressedGeneric', "Conversation history compressed to fit the context limit");
		}
		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-assistant'));

		// Phase 70: the Auto router's pick (Cursor-parity underlying-model
		// display) — the same note the live stream renders first in the row
		// (model_routed arrives before any block), so the restored position
		// matches; `vibeAI.chat.autoReveal` gates it (default on).
		if (turn.routedModel && turn.routedModel.model
			&& this.configurationService.getValue<boolean>('vibeAI.chat.autoReveal') !== false) {
			const routedNote = DOM.append(row, $('.vibe-ai-model-routed-note'));
			routedNote.textContent = localize(
				'vibeAIChat.modelRouted',
				"Routed to {0} — {1} tier ({2})",
				turn.routedModel.name,
				turn.routedModel.tier,
				turn.routedModel.mode
			);
			routedNote.title = turn.routedModel.reason;
		}

		// --- Phase 60: chronological restore — rebuild the turn's blocks
		//     from the recorded timeline (multiple Thought/Worked/narration
		//     blocks in agent run order, durations per block). Sessions
		//     saved before Phase 60 predate the field and restore via the
		//     older layouts below.
		if (turn.timeline && turn.timeline.length > 0) {
			this.renderAssistantFromTimeline(conversation, row, turn);
			// Phase 71: the plan card of a Plan-mode turn (after the
			// activity blocks, before the footer — live parity).
			this.renderRestoredPlanCard(conversation, row, turn);
			// --- checkpoint footer (fully interactive) — Phase 56: the
			//     files summary no longer renders per turn in the thread.
			this.renderTurnFooterInto(conversation, row, turn.turnChanges ?? [], turn.turnStartedAt ?? Date.now(), turnIndex);
			return;
		}

		// --- collapsible thinking (restored collapsed — parity with the
		//     completed live state, where the turn folds the window back to
		//     its "Thought for Xs" summary row; the summary click expands it)
		if (turn.thinking && turn.thinking.length > 0) {
			const thinkingDetails = DOM.append(row, $('details.vibe-ai-thinking')) as HTMLDetailsElement;
			const summary = DOM.append(thinkingDetails, $('summary'));
			const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-thinking-chevron'));
			chevron.setAttribute('aria-hidden', 'true');
			const label = DOM.append(summary, $('span'));
			label.textContent = turn.thinkingDurationMs !== undefined
				? localize('vibeAIChat.thought', "Thought for {0}", getDurationString(turn.thinkingDurationMs))
				: localize('vibeAIChat.thinking', "Thinking…");
			const thinkingText = DOM.append(thinkingDetails, $('.vibe-ai-thinking-text'));
			// Phase 84.2: restored reasoning is static — no 10-line window
			// (same settled class as the timeline restore path).
			thinkingText.classList.add('vibe-ai-thinking-text-settled');
			thinkingText.textContent = turn.thinking;
		}

		// --- collapsible tool activity with the recorded read-only cards
		//     (Phase 57: mutating tools render inline below instead — live
		//     parity: the Worked activity keeps read-only scans only)
		const tools = turn.tools ?? [];
		const readTools = tools.filter(tool => !isMutatingTool(tool.name));
		if (readTools.length > 0) {
			const workDetails = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
			// Post-turn state (live parity): full history, collapsed to the
			// "Worked for X" summary row — the native <details> toggle
			// expands it.
			const workSummary = DOM.append(workDetails, $('summary'));
			const workChevron = DOM.append(workSummary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-chevron'));
			workChevron.setAttribute('aria-hidden', 'true');
			const workLabel = DOM.append(workSummary, $('span'));
			workLabel.textContent = turn.thinkingDurationMs !== undefined
				? localize('vibeAIChat.worked', "Worked for {0}", getDurationString(turn.thinkingDurationMs))
				: localize('vibeAIChat.working', "Working…");
			const cardsContainer = DOM.append(workDetails, $('.vibe-ai-turn-cards'));
			for (const tool of readTools) {
				cardsContainer.appendChild(this.createRestoredToolCard(conversation, tool).element);
			}
		}

		// --- Phase 58: interleaved narration — `segments` split `answer` at
		//     each mutating-tool boundary with the tool ids below each
		//     segment (live parity). Sessions saved before Phase 58 predate
		//     the field and restore via the merged layout in the else branch.
		const segments = turn.segments ?? [];
		const toolsById = new Map<string, IVibeAIPersistedToolCall>();
		for (const tool of tools) {
			if (tool.id !== undefined) {
				toolsById.set(tool.id, tool);
			}
		}
		if (segments.length > 0) {
			// --- error note (recorded when the turn errored)
			if (turn.error) {
				const errorRow = DOM.append(row, $('.vibe-ai-chat-error'));
				errorRow.textContent = turn.error;
			}
			for (const segment of segments) {
				const segText = turn.answer.slice(segment.textStart, segment.textEnd);
				if (segText.length > 0) {
					const segBody = DOM.append(row, $('.vibe-ai-chat-markdown'));
					const rendered = this.markdownRendererService.render(new MarkdownString(segText, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), segBody);
					conversation.turnRecordDisposables.add(rendered);
				}
				// This segment's mutating cards, kept in tool order (tools
				// without an id — the pre-id era — never reach this branch).
				const segTools = segment.toolIds
					.map(id => toolsById.get(id))
					.filter((tool): tool is IVibeAIPersistedToolCall => tool !== undefined && isMutatingTool(tool.name));
				if (segTools.length > 0) {
					const actionCardsContainer = DOM.append(row, $('.vibe-ai-turn-actions'));
					for (const tool of segTools) {
						const card = this.createRestoredToolCard(conversation, tool);
						// Phase 58 follow-up: restored writes re-arm the editor
						// highlighter so opening the file from the restored chat
						// re-applies the red/green change highlight (live writes
						// register via handleToolResult; a restart forgets them).
						if (tool.codeChange) {
							this.editorHighlighter?.registerRestored(tool.codeChange, path => this.resolveWorkspacePath(path));
						}
						actionCardsContainer.appendChild(card.element);
					}
				}
			}
			// Empty answer → subtle placeholder (parity with the live view).
			if (turn.answer.length === 0) {
				const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
				const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
				placeholder.textContent = turn.outputTruncated
					? localize(
						'vibeAIChat.truncatedNoResponse',
						"(response truncated — the reasoning used up the output budget; raise backend LLM_AGENT_MAX_TOKENS)"
					)
					: localize('vibeAIChat.emptyResponse', "(no response)");
				placeholder.style.color = 'var(--vscode-descriptionForeground)';
				placeholder.style.fontStyle = 'italic';
			}
			// --- truncation note (recorded when the round hit the output budget)
			if (turn.outputTruncated && turn.answer.length > 0) {
				const note = DOM.append(row, $('.vibe-ai-output-truncated-note'));
				note.textContent = localize(
					'vibeAIChat.outputTruncated',
					"Response truncated — the model hit its per-round output budget (raise backend LLM_AGENT_MAX_TOKENS)"
				);
			}
		} else {
			// --- pre-Phase-58 merged layout: every mutating card in one
			//     container above the whole answer body (old sessions).
			const mutatingTools = tools.filter(tool => isMutatingTool(tool.name));
			if (mutatingTools.length > 0) {
				const actionCardsContainer = DOM.append(row, $('.vibe-ai-turn-actions'));
				for (const tool of mutatingTools) {
					const card = this.createRestoredToolCard(conversation, tool);
					// Phase 58 follow-up: restored writes re-arm the editor
					// highlighter so opening the file from the restored chat
					// re-applies the red/green change highlight.
					if (tool.codeChange) {
						this.editorHighlighter?.registerRestored(tool.codeChange, path => this.resolveWorkspacePath(path));
					}
					actionCardsContainer.appendChild(card.element);
				}
			}

			// --- error note (recorded when the turn errored)
			if (turn.error) {
				const errorRow = DOM.append(row, $('.vibe-ai-chat-error'));
				errorRow.textContent = turn.error;
			}

			// --- markdown answer (same renderer as the live view)
			const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
			if (turn.answer.length > 0) {
				const rendered = this.markdownRendererService.render(new MarkdownString(turn.answer, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), body);
				conversation.turnRecordDisposables.add(rendered);
			} else {
				const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
				placeholder.textContent = turn.outputTruncated
					? localize(
						'vibeAIChat.truncatedNoResponse',
						"(response truncated — the reasoning used up the output budget; raise backend LLM_AGENT_MAX_TOKENS)"
					)
					: localize('vibeAIChat.emptyResponse', "(no response)");
				placeholder.style.color = 'var(--vscode-descriptionForeground)';
				placeholder.style.fontStyle = 'italic';
			}

			// --- truncation note (recorded when the round hit the output budget)
			if (turn.outputTruncated && turn.answer.length > 0) {
				const note = DOM.append(row, $('.vibe-ai-output-truncated-note'));
				note.textContent = localize(
					'vibeAIChat.outputTruncated',
					"Response truncated — the model hit its per-round output budget (raise backend LLM_AGENT_MAX_TOKENS)"
				);
			}
		}

		// --- Phase 71: the plan card of a Plan-mode turn (after the
		//     activity blocks, before the footer — live parity).
		this.renderRestoredPlanCard(conversation, row, turn);

		// --- checkpoint footer (fully interactive) — Phase 56: the files
		//     summary no longer renders per turn in the thread; the docked
		//     review bar above the input shows the latest turn's changes.
		this.renderTurnFooterInto(conversation, row, turn.turnChanges ?? [], turn.turnStartedAt ?? Date.now(), turnIndex);
	}

	/**
	 * Phase 60: renders a completed assistant turn from its chronological
	 * timeline. Phase 61 (Cursor parity, reference image): ONE "Worked
	 * for Xs" block per turn — a turn with tool calls collapses its WHOLE
	 * activity (thinking sub-blocks, narration bodies, tool cards) under
	 * a single collapsible in arrival order, and only the final text node
	 * renders outside as the answer body. A thinking-only turn keeps its
	 * row-level "Thought for Xs" blocks (no shell).
	 */
	private renderAssistantFromTimeline(conversation: VibeAIConversation, row: HTMLElement, turn: IVibeAIPersistedTurn): void {
		const tools = turn.tools ?? [];
		const toolsById = new Map<string, IVibeAIPersistedToolCall>();
		for (const tool of tools) {
			if (tool.id !== undefined) {
				toolsById.set(tool.id, tool);
			}
		}
		const nodes = turn.timeline ?? [];
		const hasTools = nodes.some(node => node.kind === 'tools');
		if (!hasTools) {
			// --- thinking-only turn: row-level Thought blocks + bodies
			// (the user's rule: no tool calls → plain "Thought" blocks).
			for (const node of nodes) {
				if (node.kind === 'thinking') {
					this.appendRestoredThinkingBlock(row, turn, node);
				} else if (node.kind === 'text') {
					this.appendRestoredTextBody(conversation, row, turn, node);
				}
			}
		} else {
			// --- tools turn: ONE Worked shell with everything inside
			// except the final text node (the answer). The answer is the
			// last node exactly when it is a text node — no tool node can
			// follow it (any later activity would have closed that text
			// run first, mirroring the live closeRunsBefore order).
			const answerIndex = nodes.length > 0 && nodes[nodes.length - 1].kind === 'text' ? nodes.length - 1 : -1;
			const shell = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
			// Post-turn state (live parity): full history, collapsed to the
			// "Worked for Xs" summary row — the native <details> toggle
			// expands it.
			const summary = DOM.append(shell, $('summary'));
			const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-chevron'));
			chevron.setAttribute('aria-hidden', 'true');
			const label = DOM.append(summary, $('span'));
			// The live shell folds with the turn's total; sessions saved
			// before Phase 61 lack the field — fall back to the sum of the
			// nodes' own durations (runs never overlap).
			const total = turn.workDurationMs ?? nodes.reduce((sum, node) => sum + (node.durationMs ?? 0), 0);
			label.textContent = total > 0
				? localize('vibeAIChat.worked', "Worked for {0}", getDurationString(total))
				: localize('vibeAIChat.working', "Working…");
			const steps = DOM.append(shell, $('.vibe-ai-worked-steps'));
			for (let index = 0; index < nodes.length; index++) {
				if (index === answerIndex) {
					continue;
				}
				const node = nodes[index];
				if (node.kind === 'thinking') {
					this.appendRestoredThinkingBlock(steps, turn, node);
				} else if (node.kind === 'text') {
					// Phase 84.4: narration node inside the shell — capped
					// (the answer node below renders in full).
					this.appendRestoredTextBody(conversation, steps, turn, node, true);
				} else {
					// tools run: every card (mutating and read-only alike)
					// collapses inside the shell, in the run's tool order
					// (tools without an id — the pre-id era — never reach
					// this branch).
					for (const id of node.toolIds ?? []) {
						const tool = toolsById.get(id);
						if (!tool) {
							continue;
						}
						const card = this.createRestoredToolCard(conversation, tool);
						// Phase 58 follow-up: restored writes re-arm the
						// editor highlighter so opening the file from the
						// restored chat re-applies the red/green change
						// highlight (live writes register via
						// handleToolResult; a restart forgets them).
						if (tool.codeChange) {
							this.editorHighlighter?.registerRestored(tool.codeChange, path => this.resolveWorkspacePath(path));
						}
						steps.appendChild(card.element);
					}
				}
			}
			// Phase 61 fix (restored answers vanished): the answer node is
			// skipped by the loop above — render it OUTSIDE the shell as
			// the answer body (live parity: finishStreaming keeps the final
			// text run outside the Worked shell). appendRestoredTextBody
			// no-ops on an empty slice (defensive).
			if (answerIndex !== -1) {
				this.appendRestoredTextBody(conversation, row, turn, nodes[answerIndex]);
			}
		}
		// --- error note (recorded when the turn errored)
		if (turn.error) {
			const errorRow = DOM.append(row, $('.vibe-ai-chat-error'));
			errorRow.textContent = turn.error;
		}
		// Empty answer → subtle placeholder (parity with the live view).
		if (turn.answer.length === 0) {
			const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
			const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
			placeholder.textContent = turn.outputTruncated
				? localize(
					'vibeAIChat.truncatedNoResponse',
					"(response truncated — the reasoning used up the output budget; raise backend LLM_AGENT_MAX_TOKENS)"
				)
				: localize('vibeAIChat.emptyResponse', "(no response)");
			placeholder.style.color = 'var(--vscode-descriptionForeground)';
			placeholder.style.fontStyle = 'italic';
		}
		// --- truncation note (recorded when the round hit the output budget)
		if (turn.outputTruncated && turn.answer.length > 0) {
			const note = DOM.append(row, $('.vibe-ai-output-truncated-note'));
			note.textContent = localize(
				'vibeAIChat.outputTruncated',
				"Response truncated — the model hit its per-round output budget (raise backend LLM_AGENT_MAX_TOKENS)"
			);
		}
	}

	/**
	 * Phase 61: one restored thinking sub-block — a collapsed "Thought for
	 * Xs" details (its reasoning sliced from `turn.thinking`, the label
	 * from the node's own duration). Renders at row level on a
	 * thinking-only turn, inside the Worked shell's steps otherwise.
	 */
	private appendRestoredThinkingBlock(parent: HTMLElement, turn: IVibeAIPersistedTurn, node: IVibeAITurnTimelineNode): void {
		const runText = (turn.thinking ?? '').slice(node.start ?? 0, node.end ?? 0);
		if (runText.length === 0) {
			return;
		}
		const thinkingDetails = DOM.append(parent, $('details.vibe-ai-thinking')) as HTMLDetailsElement;
		const summary = DOM.append(thinkingDetails, $('summary'));
		const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-thinking-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
		const label = DOM.append(summary, $('span'));
		label.textContent = node.durationMs !== undefined
			? localize('vibeAIChat.thought', "Thought for {0}", getDurationString(node.durationMs))
			: localize('vibeAIChat.thinking', "Thinking…");
		const thinkingText = DOM.append(thinkingDetails, $('.vibe-ai-thinking-text'));
		// Phase 84.2: restored reasoning is static — no 10-line window; the
		// full text joins the thread scroll when the block is expanded.
		thinkingText.classList.add('vibe-ai-thinking-text-settled');
		thinkingText.textContent = runText;
	}

	/**
	 * Phase 61: one restored narration/answer body (rendered markdown).
	 * Phase 84.4: `narration` — a body inside the Worked shell caps at the
	 * head (live parity with closeTextRun's intoWork fold); the answer
	 * body (default) renders in full.
	 */
	private appendRestoredTextBody(conversation: VibeAIConversation, parent: HTMLElement, turn: IVibeAIPersistedTurn, node: IVibeAITurnTimelineNode, narration = false): void {
		let segText = turn.answer.slice(node.start ?? 0, node.end ?? 0);
		if (segText.length === 0) {
			return;
		}
		if (narration) {
			segText = capNarrationText(segText);
		}
		const segBody = DOM.append(parent, $('.vibe-ai-chat-markdown'));
		const rendered = this.markdownRendererService.render(new MarkdownString(segText, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), segBody);
		conversation.turnRecordDisposables.add(rendered);
	}

	/**
	 * Phase 58: builds a restored tool card from a persisted record —
	 * shared by the timeline, interleaved and merged restore paths
	 * (read-only activity cards, per-run/per-segment mutating cards,
	 * merged mutating cards).
	 */
	private createRestoredToolCard(conversation: VibeAIConversation, tool: IVibeAIPersistedToolCall): VibeAIToolCard {
		const card = new VibeAIToolCard(
			tool.name,
			tool.args,
			this.languageService,
			change => this.restoreChange(change),
			(path, line, endLine) => this.openFile(path, line, endLine),
		);
		conversation.turnRecordDisposables.add(card);
		if (tool.streamText) {
			card.appendStreamText(tool.streamText);
		}
		card.setResult(tool.status, tool.result, tool.codeChange, tool.output, tool.read);
		return card;
	}

	/** Renders a completed assistant turn from plain text (history restore). */
	private renderAssistantFromText(conversation: VibeAIConversation, text: string): void {
		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-assistant'));
		const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
		if (text.length > 0) {
			const rendered = this.markdownRendererService.render(new MarkdownString(text, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), body);
			conversation.turnDisposables.add(rendered);
		} else {
			body.textContent = localize('vibeAIChat.emptyResponse', "(no response)");
			body.style.color = 'var(--vscode-descriptionForeground)';
			body.style.fontStyle = 'italic';
		}
	}

	// ==================== stream / view state ====================

	private showError(message: string, conversation: VibeAIConversation): void {
		// Errors belong to the streaming conversation's thread.
		const row = DOM.append(conversation.container, $('.vibe-ai-chat-error'));
		row.textContent = message;
		this.scrollBottom(conversation);
	}

	private cancel(): void {
		// Phase 44: the stop button stops the ACTIVE conversation's stream —
		// background streams in other tabs keep running.
		const requestId = this.getActiveConversation()?.stream?.requestId;
		if (requestId) {
			this.vibeAIService.cancel(requestId);
		}
	}

	/**
	 * Phase 45: skips the conversation's in-flight turn — the stream is
	 * aborted, the unfinished user message and the partial answer are
	 * removed from view and history, and the caller sends the new message
	 * directly (Cursor-parity "edit & resubmit": the input box may be used
	 * at any time). No turn record is captured for a skipped turn; file
	 * changes already written to disk stay (abort semantics). The late
	 * settle of the skipped stream's promise no-ops in finishStreaming
	 * (requestId guard).
	 */
	private skipCurrentTurn(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		this.vibeAIService.cancel(state.requestId);
		conversation.stream = undefined;
		state.userRow?.remove();
		state.currentAssistantRow?.remove();
		// Drop a trailing error / compression note of the skipped turn.
		const lastChild = conversation.container.lastElementChild;
		if (lastChild && (lastChild.classList.contains('vibe-ai-chat-error') || lastChild.classList.contains('vibe-ai-context-compressed-note'))) {
			lastChild.remove();
		}
		this.teardownStream(conversation, state);
		state.turnChanges = [];
		state.turnStartedAt = undefined;
		// The in-flight turn's user message is the last history entry —
		// the assistant answer is only pushed when the turn finishes.
		if (conversation.history[conversation.history.length - 1]?.role === 'user') {
			conversation.history.pop();
		}
		this.renderTabs();
		this.updateInputActions();
	}

	/**
	 * Aborts a conversation's running stream and tears its state down
	 * synchronously — used when the conversation is deleted or reset, so
	 * the late `done` event (or stream-promise settle) no-ops in
	 * finishStreaming. Other tabs' streams are unaffected (Phase 44).
	 */
	private abortStream(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		this.vibeAIService.cancel(state.requestId);
		conversation.stream = undefined;
		this.teardownStream(conversation, state);
		state.turnChanges = [];
		state.turnStartedAt = undefined;
		this.renderTabs();
		this.updateInputActions();
	}

	/**
	 * Resets the active conversation (view + history) to a fresh state and
	 * aborts its running stream. Other conversation tabs are untouched.
	 * Exposed for the ViewTitle "Clear Chat" command.
	 */
	clearChat(): void {
		const active = this.getActiveConversation();
		if (!active) {
			return;
		}
		// Phase 47: cancel an open prompt edit before the thread is cleared.
		this.cancelPromptEdit();
		// Phase 44: the active conversation's stream is aborted — other
		// tabs' streams keep running.
		if (active.stream) {
			this.abortStream(active);
		}
		active.history = [];
		active.turns = [];
		active.sessionId = `vibe-${Date.now()}`;
		active.title = 'New Agent';
		active.attachedFiles = [];
		active.contextLimit = DEFAULT_CONTEXT_LIMIT;
		active.contextUsage = undefined;
		this.history = active.history;
		this.sessionId = active.sessionId;
		this.sessionTitle = active.title;
		this.attachedFiles = active.attachedFiles;
		this.contextLimit = active.contextLimit;
		this.contextUsage = active.contextUsage;
		this.renderTabs();
		this.renderChips();
		this.clearView();
		// A reset conversation starts with the default context limit and a
		// closed Context Usage panel (the ring stays hidden until turns
		// render again).
		this.toggleContextPanel(false);
		this.renderContextUsage();
		void this.refreshContextUsage();
	}

	/** Clears the rendered turns without touching conversation state. */
	private clearView(): void {
		// Phase 44: only the ACTIVE conversation's turn state is cleared —
		// other tabs' streams keep rendering into their own threads.
		const active = this.getActiveConversation();
		active?.turnDisposables.clear();
		// Phase 45: the completed turns' footer/files-summary listeners die
		// with the rendered turns they belong to.
		active?.turnRecordDisposables.clear();
		if (active?.stream) {
			this.abortStream(active);
		}

		// Clear only the active conversation's thread (other tabs untouched).
		const container = active?.container;
		if (container) {
			DOM.clearNode(container);
		}
		// Phase 56: the thread is gone — the docked review bar hides
		// (Clear Chat also emptied the turn records above).
		this.renderDockedFilesSummary();
		this.updateEmptyState();
		this.updateInputActions();
	}

	private async refreshBackendStatus(): Promise<void> {
		if (!this.statusDot || !this.statusLabel || !this.statusRow) {
			return;
		}
		this.statusRow.classList.remove('hidden');
		this.statusDot.style.background = 'var(--vscode-charts-yellow)';
		this.statusLabel.textContent = localize('vibeAIChat.checking', "Checking backend…");

		// Phase 84.10: the one-shot check raced the editor-spawned backend —
		// the auto-opened chat (84.8) fires /health while uvicorn is still
		// booting, so a single failure pinned the "Backend offline" pill for
		// the whole session even though the backend (and the AI) came up
		// seconds later. Poll instead: retry every second within the boot
		// window while "Checking backend…" shows and hide the pill the
		// moment the backend answers; only after the budget show the offline
		// pill, still re-checked slowly so a backend started later clears it
		// without a restart.
		const BOOT_BUDGET_MS = 30000;
		const BOOT_POLL_MS = 1000;
		const OFFLINE_RECHECK_MS = 10000;
		// The view may have been disposed while a request or tick was pending.
		const disposed = (): boolean => this._store.isDisposed
			|| !this.statusDot || !this.statusLabel || !this.statusRow;
		const check = async (): Promise<boolean> => {
			try {
				return await this.vibeAIService.healthCheck();
			} catch (err) {
				this.logService.debug('[VibeAI] health check errored', err);
				return false;
			}
		};

		// Boot window: poll every second; a healthy answer hides the pill
		// entirely (Cursor parity: the connected state stays out of the way).
		const deadline = Date.now() + BOOT_BUDGET_MS;
		while (Date.now() < deadline) {
			const ok = await check();
			if (disposed()) {
				return;
			}
			if (ok) {
				this.statusRow.classList.add('hidden');
				return;
			}
			await timeout(BOOT_POLL_MS);
		}

		// The backend never came up within the boot window — show the
		// offline pill, then keep re-checking slowly so a backend started
		// later clears it on its own.
		this.statusDot.style.background = 'var(--vscode-charts-red)';
		this.statusLabel.textContent = localize('vibeAIChat.offline', "Backend offline — start the VibeCoding backend to use VibeAI");
		while (!disposed()) {
			await timeout(OFFLINE_RECHECK_MS);
			if (disposed()) {
				return;
			}
			if (await check()) {
				this.statusRow.classList.add('hidden');
				return;
			}
		}
	}

	/**
	 * Cursor parity: a new (empty) chat keeps the input box pinned at the
	 * top as the tall multi-line composer (`.vibe-ai-chat-view.empty`);
	 * once turns are rendered the input docks to the bottom as a one-line
	 * box. Toggled here (every render path calls scrollBottom) and from
	 * clearView. The idle input height differs between the two layouts,
	 * so recompute it on every transition.
	 */
	private updateEmptyState(): void {
		if (!this.viewContainer || !this.messagesContainer) {
			return;
		}
		// The active conversation's thread decides the layout: an empty
		// (fresh) conversation pins the input at the top; conversations
		// with turns dock the input at the bottom.
		const active = this.getActiveConversation();
		const empty = !active || active.container.children.length === 0;
		// Phase 41: the context ring (and the Context Usage panel) belongs
		// to a conversation with turns — hidden while the input is pinned
		// at the top (fresh empty chat), shown once turns render.
		if (this.contextRingButton) {
			this.contextRingButton.style.display = empty ? 'none' : '';
		}
		if (empty && this.contextPanelOpen) {
			this.toggleContextPanel(false);
		}
		if (this.viewContainer.classList.contains('empty') === empty) {
			return;
		}
		this.viewContainer.classList.toggle('empty', empty);
		this.autoGrowInput();
	}

	/**
	 * Scrolls the message holder to the bottom. `conversation` is the
	 * thread the caller renders into (Phase 44): when it is not the
	 * visible one (a background stream's own thread), the scroll is
	 * skipped so the user's reading position is never yanked.
	 * Phase 50 follow-latest: streaming chases (`force` unset) only scroll
	 * while the user is pinned at the bottom (followThreadBottom, tracked
	 * by a scroll listener) — scrolling up pauses the chase, scrolling back
	 * to the bottom resumes it. Explicit user actions (send, context-panel
	 * open, history load) pass `force` to jump to the bottom regardless.
	 */
	private scrollBottom(conversation?: VibeAIConversation, force = false): void {
		if (!this.messagesContainer) {
			return;
		}
		this.updateEmptyState();
		const target = conversation ?? this.getActiveConversation();
		if (target && target.id !== this.activeConversationId) {
			return;
		}
		if (!force && !this.followThreadBottom) {
			return;
		}
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	/**
	 * Phase 50: true when `el` is scrolled to (within a couple px of) its
	 * bottom — read BEFORE mutating a container's content (setting text
	 * changes scrollHeight and would invalidate the check). Drives the
	 * thinking window's follow-latest: scrolling up inside the window
	 * pauses it, scrolling back to its bottom resumes.
	 */
	private isScrolledToBottom(el: HTMLElement): boolean {
		return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
	}
}

