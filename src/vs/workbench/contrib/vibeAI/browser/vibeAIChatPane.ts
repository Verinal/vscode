/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { MarkdownRenderOptions } from '../../../../base/browser/markdownRenderer.js';
import { Action } from '../../../../base/common/actions.js';
import { timeout } from '../../../../base/common/async.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { UriList } from '../../../../base/common/dataTransfer.js';
import { URI } from '../../../../base/common/uri.js';
import { fromNowByDay, getDurationString } from '../../../../base/common/date.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { getMediaMime, Mimes } from '../../../../base/common/mime.js';
import { basename, extname, relativePath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { getCodeEditor, ICodeEditor, IContentWidget, IOverlayWidget, ContentWidgetPositionPreference, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { containsDragType, extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkdownRendererExtraOptions, IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAIChatRequest, IVibeAICodeChange, IVibeAIContextUsage, IVibeAIDiagnostic, IVibeAIExecutePlanRequest, IVibeAIFileContext, IVibeAIMessage, IVibeAIModelProvider, IVibeAIModelRouting, IVibeAIPlan, IVibeAISkill, IVibeAIStreamData, IVibeAIService, IVibeAISubagent } from '../../../../platform/vibeAI/common/vibeAI.js';
import { VibeAIChatSessionStore, IVibeAIChatSession, IVibeAIChatHandoff, IVibeAIChatScrollPos, IVibeAIChatSearchHit, IVibeAIPersistedToolCall, IVibeAIPersistedTurn, IVibeAIPersistedTurnSegment, IVibeAITurnTimelineNode, VIBE_AI_HANDOFF_STORAGE_KEY, searchConversationContent } from './vibeAIChatSessionStore.js';
import { IVibeAIModelConfig, VIBE_AI_NO_MODEL_MESSAGE, VibeAIModelStore } from './vibeAIModelStore.js';
import { buildModelMenuActions } from './vibeAIModelMenu.js';
import { computeDiffLines, computeDiffStats } from './vibeAIDiff.js';
import { VibeAIToolCard } from './vibeAIToolCard.js';
import { VibeAIEmbeddedDiff, VibeAIDiffModelContentProvider } from './vibeAIEmbeddedDiff.js';
import { regroupWorkedSteps, summarizeWorkedActivity, workedCountsSegments } from './vibeAIWorkedGroups.js';
import { VibeAIEditorHighlighter } from './vibeAIEditorHighlight.js';
import { IPendingMermaidPart, isMermaidCodeBlock, VibeAIMermaidRenderer } from './vibeAIMermaid.js';
import { enhanceFileChips, openChipFileSmart } from './vibeAIFileChips.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import './media/vibeAIChat.css';

const $ = DOM.$;

/** Markdown re-render throttle while a stream is running (ms). */
// r22: smooth streaming — the answer paints through a pump that advances a
// few characters per tick toward the received text, so bursty SSE deltas
// render as a steady typewriter flow instead of clumps. A backlog drains
// proportionally (a whole buffered paragraph lands within ~a quarter
// second, still visibly typed).
const SMOOTH_STREAM_TICK_MS = 40;
const SMOOTH_STREAM_MIN_CHARS = 3;
const SMOOTH_STREAM_CATCHUP_DIVISOR = 6;
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
/**
 * Phase 100: settle delay for the restore landing's second pass — covers
 * the pane's first real layout (window reload) and late block height
 * growth (code-block editors, mermaid, images).
 */
const RESTORE_SCROLL_SETTLE_MS = 200;
/**
 * Phase 101: debounce for persisting the open tabs' scroll positions
 * after the last scroll settles — a restart / project re-import with no
 * tab mutation in between still restores the threads where they were
 * left (each scroll reschedules; the persist runs once, after the user
 * stops scrolling).
 */
const RESTORE_SCROLL_PERSIST_MS = 600;
/**
 * Phase 208: how long the restore chase keeps waiting for further thread
 * growth after the last one. The landing passes (above) finish while the
 * restored thread is still growing (mermaid webviews mount deferred, images
 * decode, code-block editors initialize) — every late growth shoves the
 * landed viewport up and nothing re-lands it (the pending flag is already
 * consumed), which used to leave content-heavy threads near the top. The
 * chase re-pins the bottom on each growth and ends after this much
 * growth-free time (or when the user scrolls up / switches tabs).
 */
const RESTORE_CHASE_IDLE_MS = 1500;
/** Phase 123: how long a search hit's landing highlight stays lit (the CSS animation matches). */
const SEARCH_HIT_FLASH_MS = 1600;
/** Per-file context payload clip (backend clips to 6000 as well). */
const FILE_CONTEXT_MAX_CHARS = 6000;
/**
 * Phase 105: dropped-folder chip content caps — the folder's bounded
 * tree listing (the chip's content) stops at this many lines / depth;
 * junk directories are skipped (they would eat the cap).
 */
const FOLDER_LISTING_MAX_LINES = 150;
const FOLDER_LISTING_MAX_DEPTH = 3;
const FOLDER_LISTING_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
/** Phase 105: image file extensions dropped from the Explorer attach as image chips (same as paste). */
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
/**
 * Phase 171: a dropped FILE larger than this never attaches — the chip's
 * content is clipped to FILE_CONTEXT_MAX_CHARS anyway, so reading beyond
 * this is wasted IO (and multi-hundred-MB reads stall the composer while
 * the spinner chip spins).
 */
const MAX_DROP_FILE_BYTES = 20 * 1024 * 1024;
/**
 * Phase 172: binary DOCUMENTS get a looser byte cap — bytes don't predict
 * content volume for them (a drawing-set PDF is mostly vector/image data
 * with little text), and the parse-time guard is the backend's page cap +
 * the 60s extract timeout, not the byte count. Cursor parity: its web app
 * allows 4MB/file, its IDE silently no-ops at ~8MB — both our caps and
 * our "too large" notice are looser and explicit.
 */
const MAX_DROP_DOCUMENT_BYTES = 50 * 1024 * 1024;
/**
 * Phase 171: binary document extensions the BACKEND parses into text
 * (POST /api/files/extract-document: pypdf / python-docx / openpyxl /
 * python-pptx) — reading them as text would only yield garbage. Legacy
 * .doc/.xls/.ppt are rejected server-side with a "save as" hint.
 */
const DOCUMENT_EXTRACT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);
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
 * Cursor-parity generosity with a storage sanity cap. Phase 173: raised
 * 6→8 so a fully-attached sparse PDF's rendered pages (backend caps at 8)
 * fit alongside nothing else — the cap stays the ceiling for every path.
 */
const MAX_ATTACHED_IMAGES = 8;
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
/**
 * Phase 248: live context tracking cadence — the minimum gap between
 * estimate refreshes scheduled by a streaming turn's events (the burst
 * collapses into one trailing refresh per window).
 */
const LIVE_CONTEXT_REFRESH_MS = 2000;
/**
 * Phase 114: Shift+Enter queue cap (Cursor-parity queue) — messages
 * queued while a turn runs; beyond this the send is rejected (frontend
 * guards the unbounded queue growth).
 */
const VIBE_AI_QUEUE_MAX = 5;
/**
 * Phase 116: Side Chat — the parent-thread reference carries the last N
 * Q&A rounds of the parent conversation (Cursor parity: recent context).
 */
const SIDE_PARENT_TURNS = 6;
/**
 * Phase 116: Side Chat frontend token cap — mirrors the backend's
 * PARENT_CONTEXT_MAX_TOKENS (AGENT_HISTORY_MAX_TOKENS / 2; default
 * 4000/2 = 2000). The backend re-clamps defensively; this is the
 * primary cap so oversized references never reach the request.
 */
const SIDE_PARENT_CONTEXT_MAX_TOKENS = 2000;
/** Phase 116: CJK range aligned with the backend's context_manager._CJK_RE. */
const SIDE_CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Phase 116: heuristic token estimate aligned with the backend's
 * `context_manager.estimate_tokens`: CJK ≈ 1 token/char, everything
 * else ≈ 1 token / 4 chars.
 */
function estimateSideTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let cjk = 0;
	for (const char of text) {
		if (SIDE_CJK_RE.test(char)) {
			cjk++;
		}
	}
	const other = [...text].length - cjk;
	return cjk + Math.ceil(other / 4);
}

/**
 * Phase 116: tail-keeping cap for the parent-thread reference — the
 * frontend sends the parent's RECENT turns (the later, the newer), so
 * an over-budget reference drops its head (line by line; a single line
 * over budget falls back to a character tail at ~4 chars/token). The
 * backend's `_parent_tail_by_tokens` re-clamps with the same semantics.
 */
function capParentContext(text: string, budget = SIDE_PARENT_CONTEXT_MAX_TOKENS): string {
	if (estimateSideTokens(text) <= budget) {
		return text;
	}
	const kept: string[] = [];
	let total = 0;
	const lines = text.split('\n');
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		const size = estimateSideTokens(line);
		if (kept.length > 0 && total + size > budget) {
			break;
		}
		if (kept.length === 0 && size > budget) {
			const charBudget = budget * 4;
			kept.unshift(line.length > charBudget ? line.substring(line.length - charBudget) : line);
			break;
		}
		kept.unshift(line);
		total += size;
	}
	return kept.join('\n');
}

/** Phase 41: label + bar color per context usage category (Cursor parity). */
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
	return name === 'write_file' || name === 'edit_file' || name === 'delete_file' || name === 'run_terminal';
}

/**
 * Phase 192: shell-family fences all tokenize with the shellscript grammar.
 * The official powershell grammar leaves bare dev commands (docker / pip /
 * cd / flags) unscoped — a ```powershell block renders white next to a
 * colored ```bash block — and ```shell / ```console / ```terminal / ```posh
 * resolve to no language at all. shellscript (jeff-hykin) colors all of
 * them. Exported: the Agents Hub's transcript renderer shares it (its
 * hand-rolled markdown options would otherwise keep powershell plain).
 */
export const VIBE_AI_SHELL_LANGUAGE_ALIASES: Record<string, string> = {
	powershell: 'shellscript',
	pwsh: 'shellscript',
	ps: 'shellscript',
	ps1: 'shellscript',
	posh: 'shellscript',
	shell: 'shellscript',
	console: 'shellscript',
	terminal: 'shellscript',
};

/**
 * Phase 61: reads a pasted/dropped image File into a data URL, downscaled
 * to {@link IMAGE_MAX_EDGE} on its longest edge (canvas re-encode; PNG is
 * kept for screenshots, JPEG for photos). Oversized/undecodable images
 * resolve to the raw data URL — the attach path is best-effort.
 * Phase 184: exported — the Agents Hub's composer attach reuses it.
 */
export function readImageAsDataUrl(file: File): Promise<string> {
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
			// Phase 95: per-file review marks survive consolidation — a
			// later write resets the state (the fresh write's flags win
			// verbatim; the first entry's spread carries its own).
			kept: change.kept,
			discarded: change.discarded,
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
	// Phase 93: no auto-open — thinking rows stay COLLAPSED while the run
	// streams (the summary label carries the shimmer; the ~10-line window
	// only shows when the user expands the row mid-run). Phase 102: no
	// exceptions — the final answer never streams inside a thought block
	// (it renders as its own body below the folded run).
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
	// Phase 84.9/89/96: the frozen "Worked for Xs" duration — set when
	// the shell settles (on the backend's round_end final marker via
	// handleStreamData, or the turn-end settle from finishStreaming; the
	// shell stays open through intermediate narrations, so nothing
	// un-freezes it mid-turn). finishStreaming persists it so the
	// restored label matches the live settle moment. Phase 96: the
	// settle does NOT fold — the shell stays expanded after the turn
	// completes (latest turn only); the next send folds it and restored
	// history renders collapsed.
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
	// Phase 103: the agent loop exhausted its tool-call budget (all
	// segments used) or its context window — captured into the turn
	// record at finish and surfaced as a note + Continue chip (Cursor
	// parity loop continuation).
	limitReached: boolean;
	// Phase 70: the model the Auto router picked for this turn (first
	// round + every fallback switch) — captured into the turn record at
	// finish and rendered as a footer-adjacent note (Cursor-parity
	// underlying-model display, `vibeAI.chat.autoReveal`).
	routedModel?: IVibeAIModelRouting;
	modelRoutedNote: HTMLElement | undefined;
	lastError: string | undefined;
	// Phase 134: the transient "Retrying (n/N)…" chip (the `retry` event,
	// Cursor-parity auto retry) — removed when the next real event arrives
	// (handleStreamData) or at turn finish; a second retry replaces it.
	retryRow: HTMLElement | undefined;

	// --- Phase 113: steers (Cursor's "send now")
	// Steered messages the backend injected this turn (the `steered`
	// event, in arrival order) — captured into the turn record at finish
	// so the restored shell renders them.
	steeredMessages: string[];
	// Steers sent to the backend but not yet confirmed injected (the
	// `steered` echo removes them). When the turn ends without a done
	// event's pending_steer (interrupt / abort), these are the leftovers
	// preserved as steered history entries instead of vanishing.
	inflightSteers: string[];
	// The done event's pending_steer — steers the turn ended with (the
	// backend drained them at close; none was injected). The note + the
	// history push at finish use it when present.
	pendingSteer: string[] | undefined;
	// Phase 150: the backend turn state machine's latest `turn_state`
	// announcement (Cursor-parity event-driven lifecycle) — lifecycle
	// truth from the backend; the awaiting-plan guard in finishStreaming
	// reads it alongside planPhase (which stays for restored turns).
	turnState: string | undefined;
	// Phase 245: the backend turn transcript id (the `turn_start` event,
	// the stream's first event) — the resume-from-failed-step retry
	// credential, captured into the turn record at finish.
	turnId: string | undefined;
	// Phase 246: this stream is a resume-from-failed-step retry (Retry on
	// an errored turn whose transcript id is known) — finishStreaming
	// merges the record into the failed turn's record instead of pushing
	// a new one.
	isResume: boolean;
	// Phase 246: the resume divider note ("Retrying from the failed
	// step…") — removed when the resume attempt is torn down
	// (resume_unavailable fallback).
	resumeDivider: HTMLElement | undefined;

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
	// --- Phase 231: per-step activity group (plan execution) — the step's
	// whole activity (narration text, Thought blocks, tool cards) collects
	// in one collapsible <details> inside the Worked shell; a clean
	// plan_step_done settles it to its summary row ("Step N — title ·
	// Worked for Xs · counts") and folds it, so each finished step collapses
	// as ONE row (ask/agent Worked-shell parity, per step). A failed step's
	// group stays open for debugging; the next step_start opens a fresh
	// group (the failed one keeps its expanded activity).
	planStepGroup: {
		root: HTMLDetailsElement;
		steps: HTMLElement;
		icon: HTMLElement;
		label: HTMLElement;
		meta: HTMLElement;
		stepId: number;
		startedAt: number;
	} | undefined;
	// --- Phase 218: plan doc streaming (Cursor-parity plan-as-doc) — the
	// plan phase streams PLAN.md into the editor while the approval waits:
	// the accumulated markdown (chunks join up to exactly the on-disk
	// file), the model reference the edits apply through (resolved async —
	// deltas buffer into `text` until it lands), the open promise so
	// settle waits for it, and the code editor the openEditor call landed
	// (Phase 219 — the approval widget mounts on it).
	planDocStream: {
		path: string;
		// Phase 223: the conversation's project root captured at doc-start —
		// the doc path is workspace-relative, and the Agent Window's neutral
		// workspace has no folder to anchor it (the editor never opened).
		root: string;
		text: string;
		ref: IReference<IResolvedTextEditorModel> | undefined;
		opening: Promise<void> | undefined;
		editor?: ICodeEditor;
	} | undefined;
	// --- Phase 219: the approval lives IN the plan doc's editor — an
	// overlay widget pinned to the editor's top center carries the
	// Build / Cancel actions (the chat bar remains only as the fallback
	// for a turn whose doc never opened). The editor pointer survives the
	// doc-stream settle — the widget outlives the model reference.
	planApproval: {
		editor: ICodeEditor;
		widget: IOverlayWidget;
	} | undefined;

	// --- markdown streaming (smoothed re-render)
	markdownRenderTimer: number | undefined;
	lastMarkdownRender: number;
	// r22: absolute char index into `turn.text` painted so far — the pump
	// (markdownRenderTimer above) advances it toward the received length so
	// bursty delta arrivals paint as a steady typewriter flow; run-close /
	// turn-finish render the full slice and bypass it.
	smoothedLen: number;
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
	// Phase 103: the loop exhausted its rounds/segments or the context
	// window — restore renders the note + Continue chip (Cursor-parity
	// loop continuation).
	limitReached?: boolean;
	// Phase 70: the model the Auto router picked for this turn (Cursor-
	// parity underlying-model display, persisted for restore parity).
	routedModel?: IVibeAIModelRouting;
	// Phase 71: the plan this turn produced (Plan mode) + its lifecycle —
	// persisted so history restores the card with the final states.
	plan?: IVibeAIPlan;
	planStatus?: VibeAIPlanCardStatus;
	planResults?: { stepsDone: number[]; stepsFailed: number[] };
	error?: string;
	// Phase 245: the backend turn transcript id (turn_start event) — the
	// resume-from-failed-step retry credential, persisted so a restored
	// failed turn still resumes after a reload (no id → legacy re-send).
	turnId?: string;
	// Phase 97: the turn was interrupted by the next send — restore renders
	// the interruption note (never set for a normally finished turn).
	interrupted?: boolean;
	// Phase 113: steers injected DURING this turn (the `steered` echoes, in
	// arrival order) — the restored Worked shell renders their bubbles at
	// the end of the steps (chronologically they arrived during the work).
	steered?: string[];
	// Phase 113: steers the turn ended with (queued but never injected) —
	// restore renders the "not delivered" note (never set otherwise).
	steeredPending?: string[];
	turnChanges: IVibeAICodeChange[];
	rolledBack?: boolean;
	// Phase 88: set once the user confirmed (Keep) this turn's file
	// changes — the docked review bar stops offering the turn again and
	// the mark persists so reloads / tab switches never resurrect the
	// bar for a kept turn.
	kept?: boolean;
	// Phase 95: per-file keep/discard marks ride ON this turn's change
	// objects (IVibeAICodeChange.kept/discarded) — the editor keep-bar
	// and the files list rows resolve ONE file at a time; a turn whose
	// every change is resolved is final too (kept flips to true,
	// persisted).
	row: HTMLElement | undefined;
	// Phase 134: the turn's user row (runtime-only, never persisted) — the
	// Retry button (Cursor parity) re-dispatches the failed turn through
	// the prompt-edit resend machinery (truncateFromUserTurn), which needs it.
	userRow?: HTMLElement;
}
/**
 * Phase 117: one Q&A turn of a side chat pulled in by an `@side:` mention —
 * the same [User]/[Assistant] shape buildParentContext assembles (live
 * VibeAITurnRecord and persisted IVibeAIPersistedTurn both carry it).
 */
interface VibeAISideMentionTurn {
	readonly userText: string;
	readonly answer: string;
}

/**
 * Phase 117: one @-mentionable side chat of the CURRENT conversation —
 * the completion pool (`@` trigger) and the send-time resolver share it.
 */
interface VibeAISideMentionEntry {
	readonly sessionId: string;
	readonly title: string;
	readonly turns: readonly VibeAISideMentionTurn[];
}

/**
 * One open conversation tab (editor-tab parity): every conversation owns
 * its history, context state and rendered thread; switching tabs toggles
 * the thread visibility and a conversation is deleted only via its ✕.
 * Phase 44: a conversation additionally owns its live stream state, so
 * every tab streams independently and in parallel.
 */

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
	/**
	 * Phase 227: the AI title summary was already requested for this
	 * conversation (fire-and-forget once per conversation — a failed
	 * summary keeps the raw derived title instead of retrying).
	 */
	titleRequested?: boolean;
	/**
	 * Phase 93: the conversation's own composer mode (ask/agent/plan) —
	 * per conversation so switching tabs never carries one tab's mode
	 * into another (each tab dispatches its turns with its own mode).
	 */
	mode: VibeAIChatMode;
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
	/**
	 * Phase 114: messages queued with Shift+Enter while a turn runs
	 * (Cursor's "queue") — FIFO; the first opens a NEW agent turn when
	 * the running one ends (resumeSteerQueue) and the badge shows the
	 * count. The local queue is the auto-resume source of truth (the
	 * done event's pending_queue merges in content-deduped; a mirror
	 * POST that lost the race only misses its backend copy).
	 */
	steerQueue: string[];
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
	/**
	 * Phase 218: the failed turn's row + prompt stashed the moment a
	 * stream error arrives — retryFailedTurn's fallback for conversations
	 * whose turn record is missing (restored from a turns-less store
	 * before the Phase 218 alignment self-heal ran). Cleared with the
	 * next turn (startAssistantTurn). Phase 246: also stashes the failed
	 * stream's turn transcript id (the resume credential) when the
	 * turn_start event made it through before the error.
	 */
	lastFailedTurn: { userRow: HTMLElement; userText: string; turnId?: string } | undefined;
	/**
	 * Phase 224: the plan doc editor's To-dos block — a Cursor-parity
	 * content widget pinned under the doc's last line (the "N To-dos
	 * [+ New]" checklist rows mirror the plan steps; the "Referenced by
	 * 1 Agent" author row names the creating conversation). Lives on the
	 * CONVERSATION, not the turn stream: the execute turn's plan_step
	 * events keep ticking it after the planning turn ends. Dies with the
	 * doc's tab (editor onDidDispose) or the pane (turnRecordDisposables);
	 * a newer plan's mount replaces it.
	 */
	planTodos: {
		editor: ICodeEditor;
		widget: IContentWidget;
		rows: Map<number, HTMLElement>;
		/**
		 * Phase 241 (living plan): the checklist's list container —
		 * update_plan revisions append/remove rows here after mount (the
		 * rows map alone can't anchor an append once it's empty).
		 */
		list: HTMLElement;
	} | undefined;
	/** Sequence guard for this conversation's context-usage refreshes. */
	contextUsageSeq: number;
	/**
	 * Phase 100: the conversation's latest-turn landing is still pending
	 * — its thread was rendered while the messages holder had no
	 * dimensions (restore paths: the workbench calls layout() after
	 * renderBody, so restore-time scrolls are silent no-ops and the
	 * thread shows the top when the pane appears). Consumed by the
	 * first real layout() / tab activation (false once landed).
	 * Phase 101: the landing target is the tab's recorded scroll
	 * position (recordedScroll) — the very bottom when none / pinned.
	 */
	pendingLatestScroll?: boolean;
	/**
	 * Phase 101: the conversation's recorded scroll position — where its
	 * thread is scrolled (updated on scroll, on tab switches and at
	 * persist time). Tab re-activation restores it and it rides the
	 * open-state persistence (keyed by session id), so restarts and
	 * project re-imports bring the open tabs back where they were left;
	 * pinned-at-bottom tabs restore to the bottom.
	 */
	recordedScroll?: IVibeAIChatScrollPos;
	/**
	 * Phase 116: Side Chat — 'side' marks a `/side <question>` thread
	 * (Ask-only; its parent conversation rides the request as a hidden
	 * reference). Absent/'main' = a regular thread.
	 */
	kind?: 'main' | 'side';
	/** Phase 116: the parent thread's session id (side chats only). */
	parentSessionId?: string;
	/**
	 * Phase 120: the session goal (Cursor parity: a long-lived objective
	 * the conversation works towards) — set via `/goal <objective>`,
	 * carried on EVERY turn's request (the backend injects the hidden
	 * <session goal> block) until the user clears it. Absent = no goal.
	 */
	goal?: string;
	/** Phase 120: the mark_goal_complete confirmation (the banner's done state). */
	goalComplete?: boolean;
	/**
	 * Phase 157: the conversation's agreed plan file (Cursor plan-as-file
	 * parity) — the `.vibe/plans/*.md` relative path captured from the
	 * plan execute phase's plan_start / plan_done. Agent turns and plan
	 * re-executions carry it as planFile so the backend injects the
	 * <agreed plan> block (work off the settled plan, don't re-explore).
	 * Absent = no agreed plan in this conversation.
	 */
	planPath?: string;
	/**
	 * Phase 213: the plan doc's workspace-relative path (PLAN.md at the
	 * project root, captured from the execute phase's plan_start) — the
	 * plan card links to it. Absent on the awaiting card (the doc is
	 * written on Build) and when persistence failed.
	 */
	planDocPath?: string;
	/**
	 * Phase 177 (Agent Window, Cursor parity): the project folder this
	 * conversation is bound to — sent as `workspaceRoot` on every request
	 * so continuing a conversation from the Agent Window (whose neutral
	 * workspace has no folder) still rebinds the backend to the right
	 * project. Set at conversation creation and frozen; absent falls back
	 * to the window's folder (pre-Phase-177 behavior).
	 */
	workspaceRoot?: string;
}

/**
 * Phase 47/48: one open in-place prompt edit. The edit box rebuilds the
 * main input's exact composer DOM (chips row + textarea + toolbar), so
 * it carries its own element refs — label/state updates fan out from
 * the pane-level mode/model/context state to BOTH composers (Cursor
 * parity: the edit box is identical to the input below and the
 * mode/model dropdowns stay in sync).
 */
/**
 * Phase 171: a dropped file's chip entry while its read runs — the pane
 * pushes it into the attachments the moment the drop lands (spinner chip)
 * and the read fills `content` in place. Finalization goes through the
 * object identity (not a path lookup) so a tab switch mid-read can never
 * land the content in the wrong conversation's array.
 */
interface VibeAIFileContextEntry {
	path: string;
	kind?: 'file' | 'folder';
	content?: string;
}

/**
 * Phase 184: one attachment target — the pending set a composer's chips
 * row shows and the whole attach pipeline (paste / drop / paperclip)
 * writes into. The MAIN sink wraps the pane-level fields (mirrored per
 * conversation); an open prompt edit owns its own (seeded from the edited
 * message — the edit box no longer mirrors the input below). Arrays are
 * mutated in place; the tracked-read collections are sink-scoped so
 * send() / commitPromptEdit wait out only the reads that belong to them.
 */
interface VibeAIAttachmentSink {
	readonly files: IVibeAIFileContext[];
	readonly images: string[];
	readonly pendingFileReads: Map<string, Promise<void>>;
	readonly pendingImageReads: Set<Promise<void>>;
	/** Re-renders the owning composer's chips row + action buttons. */
	readonly refresh: () => void;
}

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
	/**
	 * Phase 184: the edit box's OWN attachment set — seeded from the
	 * edited message's attachments (the sent chips/thumbnails), editable
	 * in place (chip ✕ removes, paste/drop/paperclip adds) and consumed
	 * by the re-send. The main input's pending set is never touched.
	 */
	files: IVibeAIFileContext[];
	images: string[];
	/** Phase 184: edit-scoped in-flight attachment reads (send-wait contract). */
	pendingFileReads: Map<string, Promise<void>>;
	pendingImageReads: Set<Promise<void>>;
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
	// --- Phase 114: the queue badge (Shift+Enter queued messages) — the
	//     count reflects the ACTIVE conversation's steerQueue; hidden
	//     when the queue is empty. Updated from updateInputActions.
	private queueBadge: HTMLElement | undefined;
	private queueBadgeLabel: HTMLElement | undefined;
	// --- Phase 56: docked files-summary review bar — the "N Files" row
	//     sticks directly above the input box (Cursor/native parity);
	//     its listeners live on their own store, cleared on re-render.
	private filesSummaryDock: HTMLElement | undefined;
	private readonly filesSummaryDisposables = new DisposableStore();
	// --- Phase 120: the goal banner — the ACTIVE conversation's session
	//     goal (active/done states + clear), docked directly above the
	//     input box. Re-rendered from the active conversation's state.
	private goalBanner: HTMLElement | undefined;
	private readonly goalBannerDisposables = new DisposableStore();

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
	// Phase 101: debounce handle for the open tabs' scroll-position
	// persist (rescheduled on every scroll, fires after the last one).
	private scrollPersistTimer: number | undefined;
	// Phase 208: the active restore chase — a bottom landing keeps
	// re-pinning while the thread still grows (mermaid webviews, images,
	// code-block editors land after the landing passes). One at a time:
	// the newest bottom landing replaces it.
	private restoreChase: {
		readonly conversationId: string;
		readonly observer: ResizeObserver;
		idleTimer: number;
	} | undefined;
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
	// Phase 93: the mode is per conversation — this field mirrors the
	// ACTIVE conversation's (written on every mode pick, synced on tab
	// switch), so changing one tab's mode never changes the others.
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
	// Phase 171: attachment reads still in flight — the chips row shows
	// them as dashed spinner chips the moment the drop lands (instant
	// feedback: the drop never feels missed), content fills in when the
	// read settles. Keyed by display path; images tracked as a promise set
	// (the counter is the set's size). send() waits these out before it
	// captures the attachments.
	private readonly pendingFileReads = new Map<string, Promise<void>>();
	private readonly pendingImageReads = new Set<Promise<void>>();

	// --- Phase 47: Cursor-parity sent-prompt editing — the one open
	//     in-place edit box (click a sent prompt → editable composer →
	//     Enter re-sends from that turn). Only one box edits at a time.
	//     Phase 48: the edit box reuses the main input's exact composer
	//     DOM, so its toolbar/chips/ring refs hang off this state and
	//     every label/state update fans out to both composers.
	private promptEdit: VibeAIPromptEdit | undefined;
	// --- Set by the edit's outside-press cancel (enterPromptEdit's document
	//     pointerdown): the click that closed the edit must not re-open one
	//     — not on the same message's attachment strip, not on another
	//     bubble. Clicking outside means exit; a fresh click edits again.
	//     registerPromptEditDelegation's reset listener clears it on the
	//     next press (it runs before the edit's cancel listener — both are
	//     document-capture, pane-level registered first).
	private promptEditReopenSuppressed = false;
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
	// Phase 248: live context tracking — while a turn streams, its events
	// schedule throttled ring refreshes; the flag collapses every event
	// burst inside the window into ONE trailing refresh (the refresh reads
	// the latest state when it actually runs, so skipped events lose
	// nothing).
	private liveContextRefreshQueued = false;

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
	// Phase 123: the history search's scope — 'all' (cross-session:
	// stored titles + prompts + final answers) or 'session' (the active
	// conversation's live history). Sticks across menu open/close.
	private historySearchScope: 'session' | 'all' = 'all';

	// --- Phase 78: `/` skill completion menu (Cursor-parity slash commands —
	//     a popup above the input lists workspace skills while a `/token` is
	//     being typed; Enter/Tab picks, Esc/click-outside dismisses; skills
	//     hidden from the model (disableModelInvocation) are user-trigger-only)
	private skillMenu: HTMLElement | undefined;
	private skillMenuIndex = -1;
	private skillList: IVibeAISkill[] = [];
	private skillListLoaded = false;
	// Phase 127: workspace file-defined subagents (markdown files under
	// `.vibe/agents/`) for the same `/` completion menu (Agent mode only —
	// the explicit /name dispatch is an agent-mode command; Ask/Plan leave
	// `/name` as a normal message).
	private subagentList: IVibeAISubagent[] = [];
	private readonly skillMenuDisposables = new DisposableStore();
	private readonly skillRowsDisposables = new DisposableStore();
	// Phase 117: the mention entries currently rendered in the popup — set
	// by renderMentionList, cleared by renderSkillList/closeSkillMenu; the
	// keyboard pick routes on it (skill rows read the DOM name instead).
	private mentionEntries: VibeAISideMentionEntry[] | undefined;

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
		@IStorageService private readonly storageService: IStorageService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IVibeAIService private readonly vibeAIService: IVibeAIService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ICommandService private readonly commandService: ICommandService,
		// Phase 218: plan doc streaming — the model reference applies the
		// streamed PLAN.md chunks to the editor's model; the text file
		// service clears the transient dirty flag once the stream lands.
		@ITextModelService private readonly textModelService: ITextModelService,
		@ITextFileService private readonly textFileService: ITextFileService
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
		// Phase 259: the resolver content provider for the embedded diff's
		// pseudo models (scheme vscode-chat-code-block). Registered once per
		// pane — the built-in chat's identical provider only exists after
		// its ChatListRenderer constructs, which this pane never triggers;
		// without it createModelReference rejected and every diff preview
		// silently fell back to the legacy dimmed rows (plus the orphaned
		// embedded toggle: the duplicated "Show all" buttons).
		this._register(instantiationService.createInstance(VibeAIDiffModelContentProvider));
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
		// Phase 95: the editor keep-bar's per-file actions land here — keep
		// resolves the file's overlay and marks it resolved in its turn
		// record (persisted); discard reverts the file on disk first.
		this.editorHighlighter.setFileActions({
			keepFile: change => this.keepFileChange(change),
			discardFile: change => this.discardFileChange(change),
		});
		// Phase 83: the editor-backed code block renderer (the same renderer
		// the workbench installs as the markdown renderer service default) —
		// instantiated here so ```mermaid fences can be routed around it.
		this.editorCodeBlockRenderer = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
		this.mermaidRenderer = this._register(instantiationService.createInstance(VibeAIMermaidRenderer));
		this.sessionStore = new VibeAIChatSessionStore(storageService, this.workspaceContextService);
		this.modelStore = new VibeAIModelStore(storageService, configurationService);
		this.model = configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		// Phase 70: Optimize For bias of the Auto router (Cursor parity).
		this.autoMode = configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
		// Phase 227: the model is now also pickable from the plan doc pane's
		// header (same config keys) — an external pick must land here too,
		// or Build/execute would keep routing with the stale in-memory model.
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeAI.chat.model')) {
				this.model = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
				this.updateModelLabel();
			}
			if (e.affectsConfiguration('vibeAI.chat.autoMode')) {
				this.autoMode = this.configurationService.getValue<string>('vibeAI.chat.autoMode') || 'balance';
			}
		}));
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
				// Phase 101: remember where the active conversation's thread
				// is scrolled — tab re-activation restores it and the
				// debounced persist keeps it across restarts / re-imports.
				const active = this.getActiveConversation();
				if (active) {
					active.recordedScroll = { top: el.scrollTop, atBottom: this.followThreadBottom };
				}
				this.scheduleScrollPersist();
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

		// --- Phase 171: drop overlay — a dashed accent veil across the
		//     composer while a droppable drag hovers over it (the
		//     dragover class toggles it; the veil is pointer-events:none
		//     so the drop still lands on the composer). First child, but
		//     absolutely positioned so it paints over the whole box.
		const dropOverlay = DOM.append(inputContainer, $('.vibe-ai-drop-overlay'));
		const dropOverlayIcon = DOM.append(dropOverlay, $('span.codicon.codicon-files'));
		dropOverlayIcon.setAttribute('aria-hidden', 'true');
		DOM.append(dropOverlay, $('span.vibe-ai-drop-overlay-label')).textContent = localize(
			'vibeAIChat.dropOverlay',
			"Release to attach as context"
		);

		this.chipsRow = DOM.append(inputContainer, $('.vibe-ai-input-chips'));
		this.chipsRow.style.display = 'none';

		// --- Phase 114: the queue badge — Shift+Enter queued messages
		//     (Cursor's "queue"); the count shows above the textarea and
		//     counts down as the queue auto-resumes one message per turn
		//     end. Visibility/count fan out from updateInputActions.
		this.queueBadge = DOM.append(inputContainer, $('.vibe-ai-queue-badge'));
		this.queueBadge.style.display = 'none';
		const queueBadgeIcon = DOM.append(this.queueBadge, $('span.codicon.codicon-list-ordered.vibe-ai-queue-badge-icon'));
		queueBadgeIcon.setAttribute('aria-hidden', 'true');
		this.queueBadgeLabel = DOM.append(this.queueBadge, $('span.vibe-ai-queue-badge-label'));

		this.inputElement = DOM.append(inputContainer, $('textarea.vibe-ai-input')) as HTMLTextAreaElement;
		this.inputElement.rows = 1;
		this.inputElement.wrap = 'soft';
		this.inputElement.spellcheck = false;
		this.inputElement.placeholder = localize(
			'vibeAIChat.inputPlaceholder',
			"Plan, Build, / for skills, @ for context"
		);

		this.renderInputToolbar(inputContainer);
		this.registerInputListeners(inputContainer);
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

		// --- Phase 120: the goal banner — the ACTIVE conversation's
		//     session goal (/goal), docked directly above the input box
		//     (below the files dock). Re-rendered from the active
		//     conversation's state (active/done + clear).
		this.goalBanner = $('.vibe-ai-goal-banner');
		this.goalBanner.style.display = 'none';
		container.insertBefore(this.goalBanner, inputContainer);
		this.renderGoalBanner();

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
	 * Phase 100: the workbench lays the pane out AFTER renderBody — a
	 * restore that ran during construction scrolled while the messages
	 * holder had no dimensions (silent no-op) and left the thread at the
	 * top. The first real layoutBody re-lands the active conversation's
	 * pending landing (Phase 101: its recorded scroll position, the very
	 * bottom when none / pinned at it) — one-shot: once landed, later
	 * layouts must not yank the user away from their own scroll position.
	 */
	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const active = this.getActiveConversation();
		if (active && active.pendingLatestScroll) {
			this.scrollToLatestTurn(active);
		}
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

		// Phase 191: the strip slides instead of squeezing tabs — a vertical
		// wheel over it scrolls horizontally (native horizontal wheel /
		// trackpad pans and Shift+Wheel already map to scrollLeft). The
		// wheel is only hijacked while the strip actually moves, so at
		// either end the gesture falls through to the view below.
		this._register(DOM.addDisposableListener(this.tabsContainer, DOM.EventType.WHEEL, (e: WheelEvent) => {
			if (e.deltaY === 0 || e.deltaX !== 0) {
				return;
			}
			const strip = this.tabsContainer!;
			const before = strip.scrollLeft;
			strip.scrollLeft += e.deltaY;
			if (strip.scrollLeft !== before) {
				e.preventDefault();
			}
		}, { passive: false }));

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
				// Phase 180 (session roaming, Cursor parity): continue this
				// thread in the standalone agent window (or from any IDE
				// window — sessions live in application storage).
				new Action('vibeAI.chat.tab.openAgentWindow', localize('vibeAIChat.openAgentWindow', "Open in Agent Window"), undefined, true, async () => { this.handOffToAgentWindow(); }),
			],
		});
	}

	/**
	 * Phase 180 (session roaming): hands the active conversation to the
	 * standalone agent window — persists the thread NOW (the receiving
	 * window may read it immediately), stamps the one-shot handoff, and
	 * opens the agent window. The hub highlights the thread on restore;
	 * it has no inline thread view, so continuing there hands it right
	 * back into an IDE window on the thread's project.
	 */
	private handOffToAgentWindow(): void {
		const conversation = this.getActiveConversation();
		if (!conversation) {
			return;
		}
		this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)), conversation.mode, conversation.kind === 'side' ? { kind: 'side', parentSessionId: conversation.parentSessionId } : undefined, conversation.workspaceRoot);
		this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
		const handoff: IVibeAIChatHandoff = {
			sessionId: conversation.sessionId,
			workspaceRoot: this.conversationWorkspaceRoot(conversation),
			ts: Date.now(),
		};
		this.storageService.store(VIBE_AI_HANDOFF_STORAGE_KEY, JSON.stringify(handoff), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.commandService.executeCommand('vibeAI.openAgentsWindow');
	}

	// ==================== conversation tabs (editor-tab parity) ====================

	private getActiveConversation(): VibeAIConversation | undefined {
		return this.conversations.find(conversation => conversation.id === this.activeConversationId);
	}

	/** Creates a new conversation (own hidden thread) without switching to it. */
	private createConversation(seedWorkspaceRoot?: string): VibeAIConversation {
		const container = $('.vibe-ai-chat-thread');
		container.style.display = 'none';
		const conversation: VibeAIConversation = {
			id: `vibe-convo-${++this.conversationCounter}`,
			sessionId: `vibe-${Date.now()}`,
			title: 'New Agent',
			// New tabs inherit the composer's current mode (Cursor parity:
			// the mode selection carries into new chats).
			mode: this.mode,
			history: [],
			attachedFiles: [],
			attachedImages: [],
			contextLimit: DEFAULT_CONTEXT_LIMIT,
			contextUsage: undefined,
			container,
			stream: undefined,
			// Phase 114: the conversation's Shift+Enter queue (badge +
			// auto-resume at turn end) — transient, never persisted.
			steerQueue: [],
			turnDisposables: new DisposableStore(),
			turnRecordDisposables: new DisposableStore(),
			lastFailedTurn: undefined,
			planTodos: undefined,
			turns: [],
			contextUsageSeq: 0,
			// Phase 177: the project folder is frozen at creation (the
			// Agent Window seeds it with the project the hub targets; IDE
			// windows freeze their own folder — same value send-time used
			// to produce).
			workspaceRoot: seedWorkspaceRoot ?? this.currentWorkspaceRoot(),
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
		// Phase 93: the mode is per conversation too.
		active.mode = this.mode;
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
		// Phase 93: the mode is per conversation — mirror the tab's own
		// mode and refresh the toolbar labels (main input + edit box).
		this.mode = active.mode;
		this.updateModeLabel();
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
		// Phase 101: the outgoing tab's live holder position belongs to
		// it — remember it before the switch (its thread is about to
		// hide, and streaming growth never fires a scroll event).
		const leaving = this.getActiveConversation();
		if (leaving && leaving.id !== id) {
			leaving.recordedScroll = this.currentScrollPos() ?? leaving.recordedScroll;
		}
		this.activeConversationId = id;
		this.syncFromActiveConversation();
		this.showOnlyConversation(id);
		this.renderTabs();
		// Phase 191: a tab switched to (or newly created) slides into view
		// when the no-shrink strip overflows.
		this.scrollActiveTabIntoView();
		this.renderChips();
		this.renderContextUsage();
		// Phase 120: the goal banner belongs to the active conversation —
		// re-render it for the tab switched to (active/done state).
		this.renderGoalBanner();
		this.updateEmptyState();
		// Phase 56: the docked review bar belongs to the active
		// conversation — re-render it for the tab switched to.
		this.renderDockedFilesSummary();
		// Phase 44 fix: re-derive stop/mic/send from the NEW active
		// conversation — its stream state may differ from the tab we left
		// (a streaming tab switching to a fresh tab must swap the stop
		// button for the mic/send pair, and vice versa).
		this.updateInputActions();
		// Phase 114: a background tab's turn may have finished with queued
		// messages (the finish-time resume skips non-active conversations
		// — dispatchTurn reads the active mirrors). Resume now that the
		// tab is active and idle (deferred one task like the finish-time
		// resume; the guards inside re-check).
		const resumed = this.getActiveConversation();
		if (resumed && !resumed.stream && resumed.steerQueue.length > 0) {
			setTimeout(() => this.resumeSteerQueue(resumed), 0);
		}
		// Phase 100: a restored tab that was never visited yet lands on
		// its pending target on first activation — its restore-time
		// scrolls were no-ops while the messages holder had no dimensions.
		// Phase 101: an opened conversation returns to its recorded scroll
		// position on re-activation (per-tab memory).
		const switchTo = this.conversations.find(candidate => candidate.id === id);
		if (switchTo) {
			// Phase 208: a chase armed for the tab we left must not
			// survive the switch — it would yank the new tab to its
			// bottom on the next thread growth. The pending-landing
			// branch below re-arms it for the tab switching to.
			this.stopRestoreChase();
			if (switchTo.pendingLatestScroll) {
				this.scrollToLatestTurn(switchTo);
			} else if (switchTo.recordedScroll) {
				this.applyRecordedScroll(switchTo);
			}
		}
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
	 * Phase 176: public — the Agents Hub's "New Agent" button calls it
	 * after focusing the chat view. Phase 177: the hub can seed the
	 * conversation's project folder (Agent Window parity).
	 */
	newConversation(seedWorkspaceRoot?: string): void {
		this.setActiveConversation(this.createConversation(seedWorkspaceRoot).id);
	}

	/**
	 * Phase 176: the Agents Hub composer's send handoff — starts a fresh
	 * conversation (mode inherited like every new tab), seeds the shared
	 * composer input and runs the normal send pipeline, so /skills, /goal,
	 * /side and steering behave exactly as if the user typed it in the
	 * chat pane. The hub reveals this pane first (openView focus).
	 * Phase 177: `workspaceRoot` binds the new conversation to the hub's
	 * target project (Agent Window parity — the window itself has no
	 * folder). Phase 184: the hub composer's pending attachment chips ride
	 * along (files + images land in the fresh conversation's main sink
	 * before send() consumes and clears them).
	 */
	async sendFromHub(text: string, workspaceRoot?: string, files?: IVibeAIFileContext[], images?: string[]): Promise<void> {
		this.newConversation(workspaceRoot);
		if (images && images.length > 0) {
			this.attachedImages.push(...images);
		}
		if (files && files.length > 0) {
			this.attachedFiles.push(...files);
		}
		if ((files && files.length > 0) || (images && images.length > 0)) {
			this.renderChips();
			this.updateInputActions();
		}
		if (this.inputElement) {
			this.inputElement.value = text;
		}
		await this.send();
	}

	/**
	 * Phase 79: persists the open-tab strip state — the session ids of
	 * every non-empty conversation in tab order plus the active one — so
	 * the tabs and the current conversation restore on the next window
	 * start (Cursor-parity chat restore). Empty conversations are skipped
	 * (the session store never keeps zero-message sessions either) and an
	 * active empty tab is not recorded — the restore falls back to the
	 * first restored tab. Phase 101: the open tabs' recorded scroll
	 * positions ride along (keyed by session id). Phase 208: the restart
	 * restore no longer consumes them (it lands on the latest turn); the
	 * payload keeps the field for schema compatibility, and the recorded
	 * positions remain the in-session tab-switch memory.
	 */
	private persistOpenState(): void {
		const openIds: string[] = [];
		let activeId: string | undefined;
		const scrollTops: Record<string, IVibeAIChatScrollPos> = {};
		for (const conversation of this.conversations) {
			if (this.isConversationEmpty(conversation)) {
				continue;
			}
			openIds.push(conversation.sessionId);
			if (conversation.id === this.activeConversationId) {
				activeId = conversation.sessionId;
				// The active tab's live holder position is authoritative —
				// streaming grows the thread without firing scroll events.
				conversation.recordedScroll = this.currentScrollPos() ?? conversation.recordedScroll;
			}
			if (conversation.recordedScroll) {
				scrollTops[conversation.sessionId] = conversation.recordedScroll;
			}
		}
		this.sessionStore.saveOpenState({ openIds, activeId, scrollTops });
	}

	/**
	 * Phase 79: reopens the persisted open-tab strip (Cursor-parity chat
	 * restore): every recorded session id that still exists in the store
	 * becomes a tab again (recorded order = previous tab order) and the
	 * recorded active conversation is focused again. Sessions deleted or
	 * evicted (MAX_SESSIONS) since the last window are skipped; when
	 * nothing restores, the pre-Phase-79 behavior applies (one fresh
	 * empty conversation). Phase 208: every restored tab lands on its
	 * latest turn (the very bottom) — the Phase 101 cross-restart scroll
	 * restore is retired (a recorded offset lands mid-thread and drifted
	 * with late-growing blocks; reopening the window must show the
	 * latest conversation). The persisted scrollTops are no longer
	 * consumed (the field stays for schema compatibility).
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
			// Phase 208: the restart restore always lands on the latest
			// turn (the very bottom). Phase 101's cross-restart scroll
			// restore is retired here: a recorded offset lands mid-thread
			// by design, and with late-growing blocks (mermaid webviews,
			// images, code-block editors) it frequently drifted off anyway.
			// The user's expectation is explicit — reopening the window
			// shows the latest conversation. Within a live window the
			// tab-switch memory (setActiveConversation → applyRecordedScroll)
			// still applies; search-hit jumps keep their focusTurn landing.
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
		// Phase 191: the strip slides instead of squeezing tabs — a rebuild
		// (title update, stream dot, tab switch) must not yank an
		// overflowing strip back to its left edge.
		const keepScrollLeft = this.tabsContainer.scrollLeft;
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
			// Phase 116: Side Chat — a side thread's tab carries the Side
			// badge (side chats are visually distinct from mains).
			if (conversation.kind === 'side') {
				const sideBadge = DOM.append(tab, $('span.vibe-ai-tab-side-badge'));
				sideBadge.textContent = localize('vibeAIChat.tabSideBadge', "Side");
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
		if (keepScrollLeft > 0) {
			this.tabsContainer.scrollLeft = keepScrollLeft;
		}
	}

	/** Phase 191: brings the active tab into view when the strip overflows. */
	private scrollActiveTabIntoView(): void {
		this.tabsContainer?.querySelector('.vibe-ai-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

	/**
	 * Phase 227: asks the backend to summarize the conversation title
	 * from the first question (fire-and-forget, once per conversation —
	 * Cursor parity: the history list shows a short AI title instead of
	 * the raw prompt). Same model routing as the dispatched turn. The
	 * raw derived title (deriveSessionTitle) stands in until the summary
	 * lands — and stays forever when the backend returns nothing.
	 */
	private requestAiSessionTitle(conversation: VibeAIConversation, model: string | undefined, provider: IVibeAIModelProvider | undefined, autoPool: IVibeAIModelProvider[] | undefined): void {
		if (conversation.titleRequested) {
			return;
		}
		// A restored conversation whose stored title is already
		// AI-derived never re-requests; one with a raw derived title does
		// (its first question rides history from the restore).
		if (this.sessionStore.list().some(session => session.id === conversation.sessionId && session.titleCustom)) {
			return;
		}
		const firstUser = conversation.history.find(message => message.role === 'user' && !message.steered);
		const question = firstUser?.content.trim();
		if (!question) {
			return;
		}
		conversation.titleRequested = true;
		this.vibeAIService.chatTitle({
			question,
			...(model ? { model } : {}),
			...(provider ? { provider } : {}),
			...(autoPool && autoPool.length > 0 ? { autoPool, autoMode: this.autoMode } : {}),
		}).then(title => {
			const label = title?.trim().replace(/\s+/g, ' ');
			if (!label) {
				return;
			}
			const clipped = label.length > 48 ? `${label.substring(0, 48)}…` : label;
			conversation.title = clipped;
			if (this.getActiveConversation() === conversation) {
				this.sessionTitle = clipped;
			}
			// Persist first (a turn still streaming has no session record
			// yet), then patch — save() sticks titleCustom titles.
			this.persistTurns(conversation);
			this.sessionStore.setSessionTitle(conversation.sessionId, clipped);
			this.renderTabs();
		}).catch(() => { /* the raw derived title stays */ });
	}

	private renderInputToolbar(inputContainer: HTMLElement): void {
		// Phase 48: the toolbar comes from the shared builder (the edit
		// box builds the identical one); the main input keeps its element
		// refs on the pane — dropdown anchors, ring state and the
		// send/stop/mic visibility logic read them.
		const toolbar = this.buildInputToolbar(inputContainer, this.inputToolbarDisposables, {
			sendTitle: localize('vibeAIChat.send', "Send (Enter)"),
			onSend: () => void this.send(),
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
	private buildInputToolbar(parent: HTMLElement, store: DisposableStore, opts: { sendTitle: string; onSend: () => void; showContextRing?: boolean; onAttach?: () => void }): {
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

		// attach (paperclip) — Cursor-parity 📎, attaches the active file.
		// Phase 184: an edit box's toolbar routes the attach into its own
		// per-message set (opts.onAttach); the main input keeps the default.
		const attachButton = DOM.append(toolbar, $('button.vibe-ai-input-tool.codicon.codicon-attach')) as HTMLElement;
		attachButton.title = localize('vibeAIChat.mentionTitle', "Attach the current file to the conversation (@)");
		store.add(DOM.addDisposableListener(attachButton, DOM.EventType.CLICK, () => opts.onAttach ? opts.onAttach() : this.attachActiveFile()));

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

	private registerInputListeners(container: HTMLElement): void {
		if (!this.inputElement || !container) {
			return;
		}
		this._register(DOM.addDisposableListener(this.inputElement, DOM.EventType.KEY_DOWN, e => {
			// Phase 78: while the `/` skill completion menu is open it owns the
			// navigation keys (arrows walk, Enter/Tab pick, Esc dismisses —
			// Enter must NOT send the message mid-completion).
			if (this.skillMenu && this.handleSkillMenuKeys(e)) {
				return;
			}
			// Phase 114 (Cursor's "queue"): while an agent turn runs,
			// Shift+Enter QUEUES the text instead of inserting a newline —
			// it joins the conversation's queue (the badge shows the count)
			// and mirrors into the backend's queue gate (mode=queue); when
			// the running turn ends the queue auto-resumes as new turns
			// (resumeSteerQueue). Any other state (idle, Ask/Plan
			// streaming, empty input, image attached) keeps the standard
			// newline.
			if (e.key === 'Enter' && e.shiftKey) {
				const conversation = this.getActiveConversation();
				if (
					conversation?.stream
					&& conversation.mode === 'agent'
					&& (this.inputElement?.value.trim().length ?? 0) > 0
					&& this.attachedImages.length === 0
				) {
					e.preventDefault();
					this.queueForActiveTurn(conversation);
				}
				return;
			}
			// Enter sends (Ctrl/Cmd+Enter sends too); the newline above is
			// Shift+Enter's native fallback.
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				// An empty input never sends.
				if ((this.inputElement?.value.trim().length ?? 0) > 0) {
					void this.send();
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
		// Phase 105: drag-drop anywhere on the composer (chips row, textarea,
		// toolbar) — a file/folder dragged from the Explorer attaches as a
		// context chip (folder → bounded tree listing), an image file drops
		// like a paste (image chip, same as Ctrl+V), and anything else (e.g.
		// an http URL) keeps the native text insert. The Explorer's drag
		// payload carries no image File objects, and its 'ResourceURLs'
		// transfer excludes folders — see extractDroppedUris.
		this._register(DOM.addDisposableListener(container, 'dragover', e => {
			if (!this.canDropIntoInput(e)) {
				// An Escape-canceled previous drag could leave a stale
				// highlight — a non-attachable dragover always clears it.
				container.classList.remove('vibe-ai-dragover');
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
			container.classList.add('vibe-ai-dragover');
		}));
		this._register(DOM.addDisposableListener(container, 'dragleave', e => {
			// Moving between children inside the composer keeps the highlight.
			if (!container.contains(e.relatedTarget as Node)) {
				container.classList.remove('vibe-ai-dragover');
			}
		}));
		this._register(DOM.addDisposableListener(container, 'drop', e => {
			container.classList.remove('vibe-ai-dragover');
			void this.handleDrop(e);
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
	private handleImagePaste(e: ClipboardEvent, sink: VibeAIAttachmentSink = this.mainAttachmentSink()): void {
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
		// Phase 171: tracked — a slow decode shows spinner tiles first.
		this.trackImageRead(sink, this.attachImageFiles(files, sink));
	}

	/**
	 * Phase 61: attaches image files to the next message — read into
	 * downscaled data URLs (readImageAsDataUrl), surfaced as removable
	 * thumbnail chips, sent with the next turn as `images` on the user
	 * message (the backend builds the multimodal request from them).
	 * Phase 184: routes into the given sink (edit box = its own set).
	 */
	private async attachImageFiles(files: File[], sink: VibeAIAttachmentSink = this.mainAttachmentSink()): Promise<void> {
		let rejected = false;
		for (const file of files) {
			if (sink.images.length >= MAX_ATTACHED_IMAGES) {
				rejected = true;
				break;
			}
			try {
				sink.images.push(await readImageAsDataUrl(file));
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
		sink.refresh();
	}

	/**
	 * Phase 105: whether a drag over the composer carries anything the
	 * input can attach — image file items (OS drags), Explorer/OS resource
	 * payloads ('ResourceURLs' / the internal and standard uri-lists) or
	 * native Files. Mirrors the official chat widget's guessDropType.
	 */
	private canDropIntoInput(e: DragEvent): boolean {
		if (Array.from(e.dataTransfer?.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
			return true;
		}
		return containsDragType(e, DataTransfers.RESOURCES, DataTransfers.INTERNAL_URI_LIST, Mimes.uriList, DataTransfers.FILES);
	}

	/**
	 * Phase 105: the URIs of a drop on the composer — the canonical
	 * extractEditorsDropData first (in-app Explorer file drags via
	 * 'ResourceURLs' and OS file drags via native paths), then the
	 * internal uri-list (the FULL dragged list — Explorer folder drags
	 * never make it into 'ResourceURLs', files only there), then the
	 * standard 'text/uri-list' (external apps, single entry). Deduped.
	 */
	private extractDroppedUris(e: DragEvent): URI[] {
		const uris: URI[] = [];
		for (const editor of extractEditorsDropData(e)) {
			if (editor.resource) {
				uris.push(editor.resource);
			}
		}
		if (uris.length === 0) {
			const lists = [
				e.dataTransfer?.getData(DataTransfers.INTERNAL_URI_LIST) ?? '',
				e.dataTransfer?.getData(Mimes.uriList) ?? '',
			];
			for (const list of lists) {
				for (const value of UriList.parse(list)) {
					try {
						uris.push(URI.parse(value));
					} catch {
						// invalid transfer
					}
				}
			}
		}
		const seen = new Set<string>();
		return uris.filter(uri => {
			const key = uri.toString();
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	/**
	 * Phase 105/170: attaches dropped resources as context — placeholder
	 * chips land the moment the stat comes back (instant feedback: the
	 * drop never feels missed), then the slow reads fill in behind a
	 * spinner chip. A folder becomes a chip whose content is the folder's
	 * bounded tree listing (the model sees the structure without reading
	 * every file), an image file drops like a paste (image chip, data
	 * URL), and any other file reads in (clipped, same as
	 * attachActiveFile). Same-path entries skip (dedup).
	 */
	private async attachDroppedResources(uris: URI[], sink: VibeAIAttachmentSink = this.mainAttachmentSink()): Promise<void> {
		let rejectedImage = false;
		// Phase 171: the drop attaches to the list that was live when it
		// happened — a tab switch mid-stat/mid-read never reroutes the
		// attachments into the other conversation (the live pane mirrors
		// this list until the switch, so the spinner chips still show).
		// Phase 184: the list IS the sink's own array (captured at entry).
		const target = sink.files;
		const targetImages = sink.images;
		// Phase 1 — stat + placeholder chips (metadata only, fast). Each
		// accepted entry starts its tracked read; the spinner chips below
		// resolve as the reads settle (readDroppedFile / readDroppedImage).
		for (const uri of uris) {
			if (!this.fileService.hasProvider(uri)) {
				continue; // e.g. an http(s) URL — keeps the native paste
			}
			try {
				const stat = await this.fileService.stat(uri);
				const displayPath = this.formatDroppedPath(uri);
				if (stat.isDirectory) {
					if (target.some(file => file.path === displayPath)) {
						continue;
					}
					const entry: VibeAIFileContextEntry = { path: displayPath, kind: 'folder', content: '' };
					target.push(entry);
					this.trackFileRead(sink, displayPath, this.readDroppedFile({ uri, kind: 'folder', entry, images: targetImages, sink }));
				} else if (IMAGE_FILE_EXTENSIONS.has(extname(uri).toLowerCase())) {
					if (targetImages.length + sink.pendingImageReads.size >= MAX_ATTACHED_IMAGES) {
						rejectedImage = true;
						continue;
					}
					this.trackImageRead(sink, this.readDroppedImage(uri, targetImages, sink));
				} else {
					if (target.some(file => file.path === displayPath)) {
						continue;
					}
					const entry: VibeAIFileContextEntry = { path: displayPath, kind: 'file', content: '' };
					target.push(entry);
					this.trackFileRead(sink, displayPath, this.readDroppedFile({ uri, kind: 'file', size: stat.size, entry, images: targetImages, sink }));
				}
				sink.refresh();
			} catch (err) {
				this.logService.warn('[VibeAI] failed to attach the dropped resource', err);
				this.notificationService.error(localize('vibeAIChat.dropReadFailed', "Failed to attach the dropped file — it may not be readable."));
			}
		}
		if (rejectedImage) {
			this.notificationService.warn(localize(
				'vibeAIChat.tooManyImages',
				"At most {0} images can be attached per message.",
				MAX_ATTACHED_IMAGES
			));
		}
	}

	/**
	 * Phase 171: the composer's drop — OS image drags attach through the
	 * tracked image pipeline (spinner tiles while the bytes decode), URIs
	 * go through the two-phase resource attach (placeholder chips land on
	 * the drop; content fills in behind a spinner), and anything else
	 * (e.g. a URL drag) keeps the native text insert. Phase 184: routes
	 * into the given sink (the edit shell drops onto its own set).
	 */
	private async handleDrop(e: DragEvent, sink: VibeAIAttachmentSink = this.mainAttachmentSink()): Promise<void> {
		// OS image drag — image chips (same as the paste path).
		const imageFiles = Array.from(e.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'));
		if (imageFiles.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			this.trackImageRead(sink, this.attachImageFiles(imageFiles, sink));
			return;
		}
		const uris = this.extractDroppedUris(e);
		if (uris.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			await this.attachDroppedResources(uris, sink);
		}
	}

	/**
	 * Phase 171: tracks an in-flight file read so the chip shows its
	 * spinner while it runs and send() waits it out before capturing. The
	 * entry's removal is identity-guarded (a removed-then-redropped path's
	 * fresh read is never torn down by the old read's settle).
	 * Phase 184: tracked on the sink's own map (main composer / edit box).
	 */
	private trackFileRead(sink: VibeAIAttachmentSink, displayPath: string, work: Promise<void>): void {
		const tracked = work.finally(() => {
			if (sink.pendingFileReads.get(displayPath) === tracked) {
				sink.pendingFileReads.delete(displayPath);
			}
		});
		sink.pendingFileReads.set(displayPath, tracked);
	}

	/** Phase 171/182: tracked variant for image reads (a promise set — the count is its size). */
	private trackImageRead(sink: VibeAIAttachmentSink, work: Promise<void>): void {
		const tracked = work.finally(() => {
			if (sink.pendingImageReads.delete(tracked)) {
				sink.refresh();
			}
		});
		sink.pendingImageReads.add(tracked);
		// The spinner tile paints immediately, not on settle — the drop is
		// visible while the bytes are still being read.
		sink.refresh();
	}

	/**
	 * Phase 171: a placeholder chip's read — a folder builds its bounded
	 * tree listing, a file reads clipped (oversize and binary files are
	 * rejected with a notice instead of reading megabytes for nothing).
	 * Settles the chip on both paths: content fills in, or the placeholder
	 * comes off with an error.
	 */
	private async readDroppedFile(job: { uri: URI; kind: 'file' | 'folder'; size?: number; entry: VibeAIFileContextEntry; images: string[]; sink: VibeAIAttachmentSink }): Promise<void> {
		try {
			let content: string;
			if (job.kind === 'folder') {
				content = await this.buildFolderListing(job.uri);
			} else {
				// Phase 172: documents get the looser byte cap (bytes don't
				// predict text volume for binary documents; see the constant).
				const isDocument = DOCUMENT_EXTRACT_EXTENSIONS.has(extname(job.uri).toLowerCase());
				const maxBytes = isDocument ? MAX_DROP_DOCUMENT_BYTES : MAX_DROP_FILE_BYTES;
				if ((job.size ?? 0) > maxBytes) {
					this.dropPlaceholderFile(job.entry, job.sink);
					this.notificationService.warn(localize(
						'vibeAIChat.dropFileTooLarge',
						"\"{0}\" is too large to attach as context (limit {1} MB).",
						job.entry.path,
						Math.floor(maxBytes / (1024 * 1024))
					));
					return;
				}
				// Phase 171: binary documents (PDF / Word / Excel / PPT) go
				// to the backend's parser — reading them as text would only
				// yield garbage. The chip keeps spinning while the parse
				// runs; the extracted text (with its [meta] header) lands
				// as the chip content, errors surface with the backend's
				// message (legacy format / encrypted / broken file).
				if (isDocument) {
					const read = await this.fileService.readFile(job.uri);
					try {
						const result = await this.vibeAIService.extractDocument({
							filename: job.entry.path,
							contentBase64: encodeBase64(read.value),
						});
						// Phase 173: sparse-text PDFs (scans / drawing sets) come
						// back with rendered page images — attach them through the
						// image pipeline so the vision model sees the actual pages
						// (the text chip keeps the [meta] note saying pages were
						// converted). Capped by MAX_ATTACHED_IMAGES like any image.
						for (const pageImage of result.pageImages ?? []) {
							if (job.images.length >= MAX_ATTACHED_IMAGES) {
								break;
							}
							job.images.push(pageImage.dataUrl);
						}
						// Phase 174: content is backend-composed and chip-ready
						// (≤ FILE_CONTEXT_MAX_CHARS: [meta] + full text, or — when
						// it won't fit — outline + opening + the read_document
						// hint with the doc_id INSIDE the budget, since the
						// backend re-clips chip content to 6000). Attach as-is.
						this.finalizeDroppedFile(job.entry, result.content, job.sink);
					} catch (err) {
						this.dropPlaceholderFile(job.entry, job.sink);
						this.logService.warn('[VibeAI] failed to extract the dropped document', err);
						const message = err instanceof Error && err.message ? err.message : localize('vibeAIChat.dropParseFailed', "Failed to parse this document.");
						this.notificationService.warn(message);
					}
					return;
				}
				const read = await this.fileService.readFile(job.uri);
				const text = read.value.toString();
				if (text.includes('\u0000')) {
					this.dropPlaceholderFile(job.entry, job.sink);
					this.notificationService.warn(localize(
						'vibeAIChat.dropBinaryFile',
						"\"{0}\" is binary — it can't be attached as text context.",
						job.entry.path
					));
					return;
				}
				content = text.length > FILE_CONTEXT_MAX_CHARS ? text.substring(0, FILE_CONTEXT_MAX_CHARS) : text;
			}
			this.finalizeDroppedFile(job.entry, content, job.sink);
		} catch (err) {
			this.dropPlaceholderFile(job.entry, job.sink);
			this.logService.warn('[VibeAI] failed to attach the dropped resource', err);
			this.notificationService.error(localize('vibeAIChat.dropReadFailed', "Failed to attach the dropped file — it may not be readable."));
		}
	}

	/** Phase 171: a dropped image's read — data URL in, spinner tile off. Phase 184: sink-routed. */
	private async readDroppedImage(uri: URI, targetImages: string[] = this.attachedImages, sink: VibeAIAttachmentSink = this.mainAttachmentSink()): Promise<void> {
		try {
			const content = await this.fileService.readFile(uri);
			targetImages.push(`data:${getMediaMime(uri.path) ?? 'image/png'};base64,${encodeBase64(content.value)}`);
		} catch (err) {
			this.logService.warn('[VibeAI] failed to attach the dropped resource', err);
			this.notificationService.error(localize('vibeAIChat.dropReadFailed', "Failed to attach the dropped file — it may not be readable."));
		} finally {
			sink.refresh();
		}
	}

	/**
	 * Phase 171: fills a placeholder chip's content once its read lands —
	 * written through the entry's object identity, so a tab switch mid-read
	 * lands the content in the entry's own conversation (the live pane just
	 * re-renders it on return), and a chip removed mid-read stays gone (its
	 * detached object is written but never rendered).
	 */
	private finalizeDroppedFile(entry: VibeAIFileContextEntry, content: string, sink: VibeAIAttachmentSink = this.mainAttachmentSink()): void {
		sink.pendingFileReads.delete(entry.path);
		entry.content = content;
		sink.refresh();
	}

	/** Phase 171: takes a placeholder chip off (read failed / rejected). Phase 184: sink-routed. */
	private dropPlaceholderFile(entry: VibeAIFileContextEntry, sink: VibeAIAttachmentSink = this.mainAttachmentSink()): void {
		sink.pendingFileReads.delete(entry.path);
		// Phase 184: in-place splice — the sink holds the live array (a
		// reassignment would orphan the conversation mirror).
		const index = sink.files.indexOf(entry);
		if (index >= 0) {
			sink.files.splice(index, 1);
		}
		// The read may have started on another tab (dropped, then switched
		// mid-read) — sweep the conversation mirrors so the stale chip goes.
		// Main-sink only: an edit box's set is not mirrored anywhere (the
		// pane-level pendingFileReads identity marks the main sink).
		if (sink.pendingFileReads === this.pendingFileReads) {
			for (const conversation of this.conversations) {
				const mirrorIndex = conversation.attachedFiles.indexOf(entry);
				if (mirrorIndex >= 0) {
					conversation.attachedFiles.splice(mirrorIndex, 1);
				}
			}
		}
		sink.refresh();
	}

	/**
	 * Phase 105: the chip label of a dropped resource — workspace-relative
	 * when inside the workspace, the absolute path otherwise (the backend
	 * feeds the label to the model as the context's path).
	 */
	private formatDroppedPath(uri: URI): string {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		const relPath = folder ? relativePath(folder.uri, uri) : undefined;
		return relPath ?? uri.fsPath;
	}

	/**
	 * Phase 105: a dropped folder's bounded tree listing — the chip's
	 * content. Depth/line capped; junk directories are skipped (they would
	 * eat the cap). Unreadable subtrees are skipped.
	 */
	private async buildFolderListing(folderUri: URI): Promise<string> {
		const lines: string[] = [];
		const walk = async (uri: URI, prefix: string, depth: number): Promise<void> => {
			if (depth > FOLDER_LISTING_MAX_DEPTH || lines.length >= FOLDER_LISTING_MAX_LINES) {
				return;
			}
			let stat: IFileStat;
			try {
				stat = await this.fileService.resolve(uri);
			} catch {
				return; // unreadable subtree — skipped
			}
			for (const child of stat.children ?? []) {
				if (lines.length >= FOLDER_LISTING_MAX_LINES) {
					break;
				}
				if (child.isDirectory) {
					if (FOLDER_LISTING_SKIP_DIRS.has(child.name)) {
						continue;
					}
					lines.push(`${prefix}${child.name}/`);
					await walk(child.resource, `${prefix}  `, depth + 1);
				} else if (child.isFile) {
					lines.push(`${prefix}${child.name}`);
				}
			}
		};
		await walk(folderUri, '', 1);
		if (lines.length >= FOLDER_LISTING_MAX_LINES) {
			lines.push('…');
		}
		return lines.join('\n');
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
		const active = this.getActiveConversation();
		const streaming = !!active?.stream;
		if (this.sendButton) {
			this.sendButton.style.display = (hasText || hasImages) ? 'flex' : 'none';
			this.sendButton.classList.toggle('enabled', hasText || hasImages);
			// Phase 113: an Agent-mode stream keeps the input usable —
			// Enter steers the running turn (Cursor's "send now") instead
			// of skipping the answer; Phase 114: Shift+Enter queues the
			// text for after the turn (Cursor's "queue"); other modes keep
			// the skip semantics.
			this.sendButton.title = streaming
				? (active?.mode === 'agent'
					? localize('vibeAIChat.sendSteers', "Steer — injects into the running turn at the next tool boundary (Enter); Shift+Enter queues it for after")
					: localize('vibeAIChat.sendSkips', "Send — skips the running answer (Enter)"))
				: localize('vibeAIChat.send', "Send (Enter)");
		}
		if (this.micButton) {
			this.micButton.style.display = !hasText && !hasImages && !streaming ? 'flex' : 'none';
		}
		if (this.stopButton) {
			this.stopButton.style.display = streaming && !hasText && !hasImages ? 'flex' : 'none';
		}
		// Phase 114: the queue badge reflects the ACTIVE conversation's
		// Shift+Enter queue (Cursor's "queue"); hidden when the queue is
		// empty, the count counts down as turns end and auto-resume it.
		if (this.queueBadge) {
			const queued = active?.steerQueue.length ?? 0;
			this.queueBadge.style.display = queued > 0 ? 'flex' : 'none';
			if (this.queueBadgeLabel) {
				this.queueBadgeLabel.textContent = localize('vibeAIChat.queuedCount', "{0} queued", queued);
			}
			this.queueBadge.title = localize(
				'vibeAIChat.queuedTitle',
				"Queued with Shift+Enter — they auto-send as new turns when the running turn finishes"
			);
		}
		// Phase 114: the dual-mode hint while an agent turn runs — Enter
		// steers (injects at the next tool boundary), Shift+Enter queues
		// (auto-sends after the turn). Other states keep the standard hint.
		if (this.inputElement) {
			this.inputElement.placeholder = streaming && active?.mode === 'agent'
				? localize('vibeAIChat.inputPlaceholderSteer', "Enter to steer · Shift+Enter to queue")
				: localize('vibeAIChat.inputPlaceholder', "Plan, Build, / for skills, @ for context");
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
		// Phase 184: the edit's own attachments enable the re-send too
		// (main-input parity: an image-only / files-only message sends).
		const hasAttachments = edit.images.length > 0 || edit.files.length > 0;
		const streaming = !!edit.conversation.stream;
		if (edit.sendButton) {
			edit.sendButton.style.display = (hasText || hasAttachments) ? 'flex' : 'none';
			edit.sendButton.classList.toggle('enabled', hasText || hasAttachments);
			edit.sendButton.title = streaming
				? localize('vibeAIChat.resendSkips', "Re-send — aborts the running answer (Enter)")
				: localize('vibeAIChat.resend', "Re-send (Enter)");
		}
		if (edit.micButton) {
			edit.micButton.style.display = !hasText && !hasAttachments && !streaming ? 'flex' : 'none';
		}
		if (edit.stopButton) {
			edit.stopButton.style.display = streaming && !hasText && !hasAttachments ? 'flex' : 'none';
		}
	}

	/** Cursor-parity mic button: voice input is not wired up in this build. */
	private showMicUnavailable(): void {
		this.notificationService.info(localize(
			'vibeAIChat.micUnavailable',
			"Voice input is not available in this build of VibeAI — type your message instead."
		));
	}

	private async send(): Promise<void> {
		if (!this.inputElement) {
			return;
		}
		// Phase 47: sending from the main input cancels an open prompt
		// edit (its static text is restored) — the two never interleave.
		this.cancelPromptEdit();
		const conversation = this.getActiveConversation();
		const text = this.inputElement.value.trim();
		// Phase 116: `/side <question>` opens a side chat — checked BEFORE
		// the steering branch (it must never steer a running parent turn)
		// and before the empty-check (a bare /side keeps the text).
		if (/^\/side(?:\s|$)/.test(text)) {
			this.handleSideCommand(text);
			return;
		}
		// Phase 120: `/goal <objective>` sets the session goal — checked
		// after /side and BEFORE the steering branch (a running turn's
		// /goal updates the objective, it never steers) and before the
		// empty-check (a bare /goal keeps the text).
		if (/^\/goal(?:\s|$)/.test(text)) {
			this.handleGoalCommand(text);
			return;
		}
		// Phase 61: an image-only message (no text) sends too. Phase 97:
		// an empty send does nothing — it never interrupts the running
		// turn either (the interrupt below only fires on a real send).
		if (text.length === 0 && this.attachedImages.length === 0) {
			return;
		}
		// Phase 44: only THIS conversation's running stream matters — other
		// tabs' streams run in parallel. Phase 97 (was Phase 45's skip):
		// sending while a stream runs INTERRUPTS the in-flight turn — its
		// progress stays (user message, tool cards, partial answer) and the
		// turn is finalized with an interruption note; the new message is
		// then sent directly.
		// Phase 113 (Cursor's "send now"): an AGENT-mode send while the
		// turn runs STEERS it instead of interrupting — the text queues in
		// the backend's steer gate and injects at the next tool boundary
		// (the turn's `steered` event renders the bubble). The steer gate
		// only exists on the agent streaming path (Ask/Plan sends keep the
		// interrupt semantics) and steers are text-only — an image send
		// still interrupts.
		if (conversation?.stream) {
			if (conversation.mode === 'agent' && text.length > 0 && this.attachedImages.length === 0) {
				const steerText = text;
				this.inputElement.value = '';
				this.autoGrowInput();
				this.updateInputActions();
				// Phase 78: the `/` skill menu closes with the input; the
				// cached skill list refreshes on the next completion.
				this.closeSkillMenu();
				this.skillListLoaded = false;
				// Phase 41: a send closes the Context Usage panel.
				this.toggleContextPanel(false);
				void this.steerActiveTurn(conversation, steerText);
				return;
			}
			this.interruptCurrentTurn(conversation);
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
		// Phase 171: a drop still reading (a spinner chip) settles before
		// the capture below — the file lands on THIS message instead of
		// silently missing it. The wait is the read's own duration (local
		// disk, usually ms).
		if (this.pendingFileReads.size > 0 || this.pendingImageReads.size > 0) {
			await Promise.allSettled([...this.pendingFileReads.values(), ...this.pendingImageReads.values()]);
			this.renderChips();
		}
		// Phase 61: images attach to the user message (data URLs) and the
		// chips clear — the request's history carries them to the backend.
		const images = this.attachedImages.length > 0 ? [...this.attachedImages] : undefined;
		// Phase 138: file/folder chips (drag-drop, @) are consumed with the
		// send too — the captured list rides THIS request (dispatchTurn's
		// files) and the composer clears with the message (Cursor parity:
		// attachments are per-message, the chips no longer linger in the
		// input after sending). Phase 184: the captured list ALSO rides the
		// history message (frontend-only metadata) so the sent bubble shows
		// its chips and the prompt edit can re-edit the attachment set.
		const files = this.attachedFiles.length > 0 ? [...this.attachedFiles] : undefined;
		this.attachedImages = [];
		this.attachedFiles = [];
		this.renderChips();
		this.history.push({
			role: 'user',
			content: text,
			...(images ? { images } : {}),
			...(files ? { files } : {}),
		});
		// Cursor-parity tab title: the first user message names the chat.
		if (this.sessionTitle === 'New Agent' && text.length > 0) {
			this.sessionTitle = this.deriveSessionTitle(text);
			this.updateTabTitle();
		}
		const userRow = this.renderUserTurn(conversation, text, images, files);
		this.dispatchTurn(conversation, text, userRow, files ?? []);
	}

	/**
	 * Phase 116: `/side <question>` — opens a side chat (Cursor parity @
	 * side chats): a NEW tab whose session is kind='side' with the
	 * CURRENT conversation as its parent, then dispatches the question
	 * as the side thread's first turn over the Ask stream (read-only).
	 * The parent thread itself is never touched — its history stays
	 * clean; its recent turns ride the request as the hidden
	 * `<parent_thread reference>` (buildParentContext). A bare `/side`
	 * is a no-op (the text stays in the input); an empty parent (fresh
	 * tab) still opens the side chat, without a parent link.
	 */
	private handleSideCommand(text: string): void {
		if (!this.inputElement) {
			return;
		}
		const question = text.replace(/^\/side\b/, '').trim();
		if (question.length === 0) {
			return;
		}
		// The parent thread = the CURRENT conversation (its completed
		// turns become the hidden reference). Captured BEFORE the switch.
		const parent = this.getActiveConversation();
		const parentSessionId = parent && (parent.turns.length > 0 || parent.history.length > 0)
			? parent.sessionId
			: undefined;
		// Composer hygiene mirrors send(): clear the input, close the
		// `/` menu and the Context Usage panel (the side dispatch runs
		// after the tab switch, which swaps the mirrors to the new tab).
		this.inputElement.value = '';
		this.autoGrowInput();
		this.updateInputActions();
		this.closeSkillMenu();
		this.skillListLoaded = false;
		this.toggleContextPanel(false);
		// The side thread ALWAYS runs Ask (readonly) — side chats answer
		// questions, they never act (overrides the inherited composer mode).
		const conversation = this.createConversation();
		conversation.kind = 'side';
		conversation.parentSessionId = parentSessionId;
		conversation.mode = 'ask';
		// Switching reuses the existing tab-switch logic (mirrors,
		// renderTabs, chips, ring — the side tab behaves like any other).
		this.setActiveConversation(conversation.id);
		this.history.push({ role: 'user', content: question });
		// Cursor-parity tab title: the question names the side chat.
		this.sessionTitle = this.deriveSessionTitle(question);
		this.updateTabTitle();
		const userRow = this.renderUserTurn(conversation, question, undefined);
		this.dispatchTurn(conversation, question, userRow);
	}

	// ==================== Phase 120: /goal session objective (Cursor parity) ====================

	/**
	 * Phase 120: `/goal <objective>` — sets (or replaces) the ACTIVE
	 * conversation's long-lived objective (Cursor parity: give the agent
	 * a long-lived objective to work towards until it's fully complete).
	 * The goal banner renders the active state and every subsequent turn
	 * of this conversation carries the objective as the request's `goal`
	 * (the backend injects the hidden <session goal> block; the model
	 * confirms completion via mark_goal_complete — the `goal_complete`
	 * event flips the banner to its done state).
	 *
	 * An IDLE conversation dispatches the objective text as the kickoff
	 * turn (the objective is the first instruction); a RUNNING one only
	 * updates the goal (it rides the next turn — dispatching mid-stream
	 * would double-fire the thread; a /goal never steers either, the
	 * interception sits before the steer branch). A bare `/goal` is a
	 * no-op (the text stays in the input).
	 */
	private handleGoalCommand(text: string): void {
		if (!this.inputElement) {
			return;
		}
		const goalText = text.replace(/^\/goal\b/, '').trim();
		if (goalText.length === 0) {
			return;
		}
		const conversation = this.getActiveConversation();
		if (!conversation) {
			return;
		}
		// Set / replace: a new objective resets the done state.
		conversation.goal = goalText;
		conversation.goalComplete = false;
		// Composer hygiene mirrors send(): clear the input, close the
		// `/` menu and the Context Usage panel.
		this.inputElement.value = '';
		this.autoGrowInput();
		this.updateInputActions();
		this.closeSkillMenu();
		this.skillListLoaded = false;
		this.toggleContextPanel(false);
		this.renderGoalBanner();
		if (!conversation.stream) {
			// Idle: the objective text kicks the first turn off (the
			// goal itself rides the request as the <session goal> block).
			this.history.push({ role: 'user', content: goalText });
			// Cursor-parity tab title: the first user message names the chat.
			if (this.sessionTitle === 'New Agent') {
				this.sessionTitle = this.deriveSessionTitle(goalText);
				this.updateTabTitle();
			}
			const userRow = this.renderUserTurn(conversation, goalText, undefined);
			this.dispatchTurn(conversation, goalText, userRow);
		} else {
			// Running: the goal rides the NEXT turn (no dispatch).
			this.persistGoal(conversation);
		}
	}

	/**
	 * Phase 120: the `goal_complete` event — the backend's
	 * mark_goal_complete tool call confirmed the session goal is done.
	 * The conversation's goal state flips (idempotent — repeated
	 * declarations stay done) and the banner re-renders to its done
	 * state; persisted so the done state survives restarts.
	 */
	private handleGoalComplete(conversation: VibeAIConversation): void {
		if (!conversation.goal) {
			return;
		}
		conversation.goalComplete = true;
		this.renderGoalBanner();
		this.persistGoal(conversation);
	}

	/**
	 * Phase 120: re-renders the goal banner from the ACTIVE
	 * conversation's session goal: active (target icon, charts-purple)
	 * vs done (pass icon, charts-green) + a clear button. No goal = the
	 * banner hides entirely. Per-conversation state — tab switches
	 * re-render it (like the Context Usage panel).
	 */
	private renderGoalBanner(): void {
		const banner = this.goalBanner;
		if (!banner) {
			return;
		}
		DOM.clearNode(banner);
		this.goalBannerDisposables.clear();
		const conversation = this.getActiveConversation();
		const goal = conversation?.goal;
		if (!goal) {
			banner.style.display = 'none';
			return;
		}
		const done = conversation?.goalComplete === true;
		banner.classList.toggle('done', done);
		banner.style.display = 'flex';
		const icon = DOM.append(banner, $(`span.codicon.codicon-${done ? 'pass-filled' : 'target'}.vibe-ai-goal-icon`));
		icon.setAttribute('aria-hidden', 'true');
		const body = DOM.append(banner, $('.vibe-ai-goal-body'));
		const label = DOM.append(body, $('span.vibe-ai-goal-label'));
		label.textContent = done
			? localize('vibeAIChat.goalCompleteLabel', "Goal · Complete")
			: localize('vibeAIChat.goalLabel', "Goal");
		const text = DOM.append(body, $('span.vibe-ai-goal-text'));
		text.textContent = goal;
		text.title = goal;
		const clear = DOM.append(banner, $('span.codicon.codicon-close.vibe-ai-goal-clear'));
		clear.setAttribute('role', 'button');
		clear.title = localize('vibeAIChat.goalClear', "Clear goal");
		this.goalBannerDisposables.add(DOM.addDisposableListener(clear, DOM.EventType.CLICK, () => {
			const active = this.getActiveConversation();
			if (!active) {
				return;
			}
			// Clearing removes the objective for good — the banner hides
			// and the persisted session drops it (setGoal with no text).
			active.goal = undefined;
			active.goalComplete = false;
			this.renderGoalBanner();
			this.persistGoal(active);
		}));
	}

	/**
	 * Phase 120: persists the given conversation's session goal (set /
	 * done / clear) — setGoal is the store's authoritative goal writer
	 * and the conversation state wins. Best-effort: a fresh conversation
	 * with no stored session no-ops (the goal rides the first
	 * turn-finish save, which re-applies it right after).
	 */
	private persistGoal(conversation: VibeAIConversation): void {
		try {
			this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
		} catch (err) {
			this.logService.error('[VibeAI] failed to persist chat session goal', err);
		}
	}

	/**
	 * Phase 116: assembles the side chat's hidden parent reference — the
	 * parent thread's last SIDE_PARENT_TURNS Q&A rounds as text, capped
	 * to SIDE_PARENT_CONTEXT_MAX_TOKENS (tail-keeping). The parent is
	 * resolved live first (its tab, always fresh), then from the
	 * persisted history (the restart path); no parent = empty string
	 * (the backend injects nothing for an empty context).
	 */
	private buildParentContext(parentSessionId?: string): string {
		if (!parentSessionId) {
			return '';
		}
		const live = this.conversations.find(candidate => candidate.sessionId === parentSessionId);
		const turns = live
			? live.turns
			: this.sessionStore.list().find(session => session.id === parentSessionId)?.turns ?? [];
		const recent = turns.slice(-SIDE_PARENT_TURNS);
		const text = recent.map(turn => `[User] ${turn.userText}\n[Assistant] ${turn.answer}`).join('\n\n');
		return capParentContext(text);
	}

	/**
	 * Phase 117: renders one side chat as a `<side_chat name="...">`
	 * block — the same recent-turns assembly as buildParentContext
	 * (last SIDE_PARENT_TURNS rounds, [User]/[Assistant] text, the
	 * tail-keeping cap). The block rides the message text, so the
	 * backend needs no changes.
	 */
	private buildSideChatBlock(entry: VibeAISideMentionEntry): string {
		const recent = entry.turns.slice(-SIDE_PARENT_TURNS);
		const text = recent.map(turn => `[User] ${turn.userText}\n[Assistant] ${turn.answer}`).join('\n\n');
		return `<side_chat name="${entry.title}">\n${capParentContext(text)}\n</side_chat>`;
	}

	/**
	 * Phase 117: `@side:<name>` mentions pull the side chat back into the
	 * main thread — each mentioned side chat's `<side_chat>` block appends
	 * to the OUTGOING copy of the last user message only. The history (and
	 * the persisted store) keep the clean mention text — the block would
	 * otherwise inflate every later turn's context and the Context Usage
	 * estimate. Resolution matches the literal `@side:` + title of the
	 * current conversation's side chats (the completion inserts exactly
	 * that); a manually typed name with no match stays as plain text.
	 * No mention = the messages pass through unchanged (zero change).
	 */
	private applySideMentions(messages: IVibeAIMessage[]): IVibeAIMessage[] {
		let index = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				index = i;
				break;
			}
		}
		if (index < 0) {
			return messages;
		}
		const content = messages[index].content;
		const mentioned = this.listActiveSideChats().filter(entry => content.includes(`@side:${entry.title}`));
		if (mentioned.length === 0) {
			return messages;
		}
		const blocks = mentioned.map(entry => this.buildSideChatBlock(entry)).join('\n\n');
		const resolved: IVibeAIMessage = { ...messages[index], content: `${content}\n\n${blocks}` };
		return [...messages.slice(0, index), resolved, ...messages.slice(index + 1)];
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
	// Phase 138: files — this turn's attached-file context. send() passes
	// the captured list BEFORE clearing the composer; callers that omit it
	// (/side, /goal, queue resume, Continue chip, edit resend, retry)
	// default to the live chips — their behavior is unchanged.
	private dispatchTurn(
		conversation: VibeAIConversation,
		text: string,
		userRow: HTMLElement,
		// Phase 184: attachments are captured per send (the request's
		// context.files) — no implicit pickup of the main input's pending
		// chips anymore (side/goal/queue-resume/Continue sends are
		// text-only; a resend carries the edit box's own set).
		files: IVibeAIFileContext[] = [],
	): void {
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
			// Phase 117: @side:<name> mentions in the outgoing user message
			// pull the side chat back — <side_chat> blocks append to this
			// outgoing copy only; history/store keep the clean text. No
			// mention = the same array content as before (zero change).
			messages: this.applySideMentions([...this.history]),
			stream: true,
			// Phase 113 (fixed in 114): the conversation's session id — the
			// Agent endpoint opens its steer/queue gate on it so mid-turn
			// Enter (steer) and Shift+Enter (queue) work. Missing in 113:
			// the request never carried it, so the backend gate never
			// opened and every steer 404'd.
			sessionId: conversation.sessionId,
			// Phase 41: custom context length — the backend compresses the
			// history to fit before running the agent loop.
			contextLimit: this.contextLimit,
			// Phase 116: Side Chat — side tabs carry the parent-session id
			// and the capped parent-thread reference on EVERY turn (the
			// backend injects it as the hidden <parent_thread reference>
			// block). Main-thread turns omit both (zero change).
			...(conversation.kind === 'side'
				? { sideOf: conversation.parentSessionId, parentContext: this.buildParentContext(conversation.parentSessionId) }
				: {}),
			// Phase 120: the session goal rides EVERY turn of the
			// conversation that owns it (main- and side-thread alike) —
			// the backend injects the hidden <session goal> block and the
			// model confirms completion via mark_goal_complete. No goal =
			// zero change (backward compatible).
			...(conversation.goal ? { goal: conversation.goal } : {}),
			// Phase 157: the conversation's agreed plan file rides AGENT
			// turns only (Cursor plan-as-file parity) — the backend injects
			// the hidden <agreed plan> block so the turn executes the
			// settled plan instead of re-exploring. Plan-mode research
			// (which creates a NEW plan) and Ask turns omit it. No plan =
			// zero change (backward compatible).
			...(this.mode === 'agent' && conversation.planPath ? { planFile: conversation.planPath } : {}),
			// Phase 139: terminal permission mode (Cursor parity) — read
			// live per turn so a Settings change applies without reload.
			permissionMode: this.permissionMode,
			// Phase 147: the editor's opened folder — the backend rebinds
			// its tools / RAG index / rules / skills to it. Empty = no
			// folder open (the backend refuses tool calls instead of
			// silently binding its own source root). Phase 177: a
			// conversation-bound project folder wins (Agent Window).
			workspaceRoot: this.conversationWorkspaceRoot(conversation),
			...(this.model === 'Auto'
				? {
					model: 'auto',
					...(autoPool && autoPool.length > 0 ? { autoPool, autoMode: this.autoMode } : {}),
				}
				: {
					model: configured?.modelId ?? this.model,
					...(provider ? { provider } : {}),
				}),
			...(files.length > 0 ? { context: { files } } : {}),
		};
		// Phase 227: the first question gets an AI-summarized title
		// (Cursor parity — the history list stops showing the raw prompt).
		// Same model routing as this turn; fire-and-forget, the raw
		// derived title stands in until (or forever when) the summary
		// lands.
		this.requestAiSessionTitle(conversation, request.model, provider, autoPool);
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
			// (Phase 97) so a turn interrupted right after this send no-ops
			// here instead of tearing down its successor.
			this.finishStreaming(conversation, requestId);
		});
		// Phase 248: the dispatched user message (and its attachments) grew
		// the context the running turn pays — refresh the ring NOW instead
		// of holding the pre-send value until the turn settles.
		void this.refreshContextUsage(conversation);
	}

	private handleStreamData(data: IVibeAIStreamData): void {
		// Phase 44: route the event to the conversation that owns this
		// request — several tabs can stream in parallel, each rendering
		// into its own thread.
		const conversation = this.conversations.find(candidate => candidate.stream?.requestId === data.requestId);
		if (!conversation?.stream) {
			return;
		}

		// Phase 134: a real event after a `retry` clears the transient
		// Retrying chip (the wait is over — the re-run is producing again).
		if (data.type !== 'retry') {
			this.clearRetryChip(conversation);
		}

		// Phase 248: the ring tracks the running turn — these events grow
		// what the next LLM round actually pays (narration deltas, tool
		// results landing, rounds closing). Throttled: a burst collapses
		// into one refresh per window.
		if (data.type === 'text' || data.type === 'tool_result' || data.type === 'round_end') {
			this.scheduleLiveContextRefresh(conversation);
		}

		switch (data.type) {
			case 'retry':
				// Phase 134: the backend is retrying the LLM call after a
				// transient failure (Cursor-parity auto retry with
				// exponential backoff) — show the wait instead of a
				// silent hang.
				this.showRetryChip(conversation, data.retry);
				break;
			case 'thinking':
				// Phase 60: contiguous thinking deltas stream into the same
				// Thought block; after any other block run a thinking delta
				// closes it and opens a NEW Thought block at the row end
				// (chronological position — multiple thoughts per turn).
				// Phase 93: the block's content is the model's PROCESS answer
				// (tool-round narration the backend routes here) — native LLM
				// reasoning is no longer forwarded; the row stays collapsed
				// with a shimmering "Thinking…" label while it streams.
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
				// order (the event order is the split signal — Cursor-parity
				// interleaving).
				// Phase 102: the final answer is NOT wrapped in the thinking
				// run anymore (user request: the answer must not live inside
				// the "Thought for Xs" block). The open thinking run folds
				// to its settled "Thought for Xs" summary here
				// (closeRunsBefore → closeThinkingRun; an empty heartbeat/
				// eager run hides entirely) and the answer streams as its
				// own body BELOW it — round-1 / pure-Q&A text included (the
				// eager run from startAssistantTurn is treated the same
				// way).
				if (conversation.stream.lastBlockKind !== 'text') {
					this.closeRunsBefore(conversation, 'text');
					this.ensureTextRun(conversation);
					// Phase 84.9: NO fold at run start — an intermediate
					// narration streams BELOW the still-open Worked shell
					// (user request: only the FINAL answer collapses it).
					// When tool activity resumes, closeTextRun(intoWork)
					// tucks the narration into the shell. Phase 89: the
					// fold rides the backend's explicit round_end final
					// marker — NO length-based mid-run guess here (84.11's
					// budget-boundary trigger folded intermediate narrations
					// too and is removed). Phase 90: the backend holds the
					// post-tool rounds' text until the round boundary, so
					// the final marker arrives BEFORE any answer text and
					// this run only opens after the shell has folded.
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
					// Phase 218: stash the failed turn's row + prompt NOW (the
					// stream state dies at the done event's teardown) — the
					// Retry fallback for a turn whose record never got
					// captured (a conversation restored from a turns-less
					// store). Cleared with the next turn (startAssistantTurn).
					// Phase 246: the stream's turn transcript id rides along —
					// the resume-from-failed-step retry credential.
					if (conversation.stream.userRow) {
						conversation.lastFailedTurn = { userRow: conversation.stream.userRow, userText: conversation.stream.userText, turnId: conversation.stream.turnId };
					}
				}
				// Phase 134: Cursor-parity Retry. Phase 195 (user ruling): ANY
				// stream error terminates a running agent turn — the Retry
				// pill renders unconditionally, not just for the backend's
				// transient-error classification (a final "fetch failed"
				// after auto-retries exhausted used to lose the button).
				this.showError(message, conversation, true);
				break;
			}
			case 'steered':
				// Phase 113: the backend injected a queued mid-turn steer
				// (role=user) at the tool boundary — the Steered bubble
				// renders inside the Working timeline.
				this.handleSteered(conversation, data);
				break;
			case 'goal_complete':
				// Phase 249: the framework's stop gate confirmed the session
				// goal achieved (plan fully ticked / judge verdict complete)
				// — the goal banner flips to its done state. The model has
				// no completion tool (Phase 249 無完成工具派); this event is
				// framework-owned.
				this.handleGoalComplete(conversation);
				break;
			case 'auto_continue':
				// Phase 249: the framework's stop gate detected unfinished
				// work at the model's natural stop (no tool calls) and
				// injected a continuation seed — the turn keeps running
				// (Cursor stop-hook followup parity, user-imperceptible).
				this.handleAutoContinue(conversation, data);
				break;
			case 'turn_state':
				// Phase 150: the backend's explicit turn lifecycle state
				// (Cursor-parity event-driven state machine) — stored so
				// guards read backend state instead of inferred frontend
				// flags. No UI of its own: the Worked shell fold still
				// rides the round_end final marker (Phase 89) — turn
				// states are lifecycle, not layout.
				if (conversation.stream) {
					conversation.stream.turnState = data.turnState;
				}
				break;
			case 'turn_start':
				// Phase 245: the backend turn transcript id (the stream's
				// first event) — the resume-from-failed-step retry
				// credential, captured into the turn record at finish.
				if (conversation.stream) {
					conversation.stream.turnId = data.turnId;
				}
				break;
			case 'resume_unavailable':
				// Phase 246: the resume retry's transcript could not be
				// loaded — tear the attempt down and fall back to the
				// legacy truncate + full re-send (behavior no worse than
				// before this feature).
				this.handleResumeUnavailable(conversation, data);
				break;
			case 'diagnostics':
				// Phase 159: the backend injected the IDE's diagnostics
				// report (<ide_diagnostics> block, role=user) at the tool
				// boundary — explicit no-op (observability parity with
				// turn_state): the injection is the model's input, not a
				// UI step; it shows up as the next round's narration.
				break;
			case 'done':
				// Phase 113: steers queued but never injected (the turn
				// ended without a tool boundary to drain them) ride the
				// done event — finishStreaming preserves them (history +
				// the "not delivered" note).
				if (conversation.stream && data.pendingSteer) {
					conversation.stream.pendingSteer = data.pendingSteer;
				}
				// Phase 114: queue-mode messages the turn ended with
				// (mode=queue never injects mid-turn — the backend reports
				// them at close). Merge into the pane's queue
				// (content-deduped, local entries stay first so the user's
				// queue order is authoritative); finishStreaming resumes
				// the first as a NEW agent turn.
				if (data.pendingQueue) {
					for (const content of data.pendingQueue) {
						if (!conversation.steerQueue.includes(content)) {
							conversation.steerQueue.push(content);
						}
					}
				}
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
			case 'approval_request':
				// Phase 92: the backend intercepted a terminal command and
				// waits at the approval gate — Run / Skip card (Cursor
				// parity command approval). The turn stays open while the
				// gate waits; the result feeds back to the model.
				this.handleApprovalRequest(conversation, data);
				break;
			case 'approval_resolved':
				// Phase 92: the gate decided (user click / timeout) — the
				// card folds to its decided state.
				this.handleApprovalResolved(conversation, data);
				break;
			case 'agent_questions':
				// Phase 121/237: the model asked clarifying questions — a
				// question card with an answer box (Cursor-parity Ask
				// questions tool); since Phase 237 the turn parks at the
				// question gate and the card's answer resolves it.
				this.handleAgentQuestions(conversation, data);
				break;
			case 'agent_question_answered':
				// Phase 237: the gate woke with the user's answer — fold
				// the matching card (by id) to its answered state
				// (idempotent; covers answers sent from another surface).
				this.handleAgentQuestionAnswered(conversation, data);
				break;
			case 'context_compressed':
				this.handleContextCompressed(conversation, data);
				break;
			case 'output_truncated':
				// Phase 51: the round hit its per-round output budget
				// (finish_reason=length) — truncation note (Cursor parity).
				this.handleOutputTruncated(conversation);
				break;
			case 'limit_reached':
				// Phase 103: the agent loop exhausted its tool-call budget
				// (all segments used) or its context window — the turn ends
				// with the backend's forced summary; a Continue chip
				// re-invokes the loop (Cursor parity).
				this.handleLimitReached(conversation, data);
				break;
			case 'model_routed':
				// Phase 70: the Auto router picked the model for this turn
				// (first round + every fallback switch) — footer-adjacent
				// note (Cursor-parity underlying-model display).
				this.handleModelRouted(conversation, data);
				break;
			case 'plan':
				// Phase 71: the research phase produced the structured plan
				// (or failed to — the retry note). Phase 218: opens the slim
				// approval bar (the plan card retired — the plan doc already
				// streamed into the editor); the turn stays open until the
				// user builds or cancels.
				this.handlePlanReady(conversation, data);
				break;
			case 'plan_doc_start':
				// Phase 218: the plan doc's first chunk — the plan phase
				// wrote PLAN.md and the pane opens it in the editor (the
				// document content area), streaming the rest into it.
				this.handlePlanDocStart(conversation, data);
				break;
			case 'plan_doc_delta':
				// Phase 218: the plan doc's next chunk — appended to the
				// editor's model (chunks join up to the on-disk file).
				this.handlePlanDocDelta(conversation, data);
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
			case 'plan_revision':
				// Phase 241 (living plan): the executor revised the remaining
				// steps mid-run (update_plan) — a timeline revision row plus
				// the plan card / To-dos block sync.
				this.handlePlanRevision(conversation, data);
				break;
			case 'round_end':
				// Phase 89: the backend's explicit final-result marker —
				// final=true = this round's text is THE answer (no tool
				// calls follow). Settle the Worked shell on it, replacing
				// 84.11's length-based guess (> NARRATION_MAX_CHARS folded
				// intermediate narrations too). Non-final round boundaries
				// (tool calls follow) carry no renderable payload.
				// Phase 90: the marker arrives BEFORE the answer text (the
				// backend holds the post-tool rounds' text until this
				// boundary and flushes it right after) — the settle lands
				// before any answer text renders.
				// Phase 140: settle folds — the duration freezes, the label
				// settles to "Worked for Xs" and the shell collapses to
				// that summary row (Cursor parity; Phase 96's
				// keep-expanded is reversed). The fold lands before the
				// first answer character (the marker precedes the answer,
				// Phase 90) and the answer streams as its own body BELOW
				// the folded shell (Phase 102).
				if (data.final) {
					this.settleWorkShell(conversation);
				}
				break;
		}
	}

	// ==================== Phase 71: Plan mode (Cursor parity) ====================

	/**
	 * Phase 71: the research phase produced the structured plan (the
	 * `plan` event). Closes the open research runs so what follows lands
	 * after them. Phase 218: the plan CARD is gone — the plan doc (since
	 * 221 under .vibe/plans/) streamed into the editor (the document
	 * content area, plan_doc_* events) BEFORE this point. Phase 220: the
	 * chat shows the closing message as the turn's final answer (it
	 * streamed into the purple-dot run opened at plan_doc_start). Phase
	 * 222: the "Created Plan" decision card (221) lands after the answer
	 * and the turn ENDS here (Cursor parity — the card is a finished-turn
	 * artifact; Build opens a fresh execute turn). A plan-less event = the
	 * backend failed to produce a valid plan — a retry note renders
	 * instead.
	 */
	private handlePlanReady(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow) {
			return;
		}
		// Close the research runs so what follows appends after them (the
		// execute phase's blocks append after it — run order). Phase 220:
		// the closing message streamed as a text run (the final answer) —
		// closed here WITHOUT the narration fold (closeRunsBefore('plan')
		// would intoWork-fold it into the shell); it stays at row level.
		this.closeThinkingRun(conversation);
		this.closeToolsRun(conversation);
		this.closeTextRun(conversation);
		// Reset the open-run signal — a stale kind (the last research run)
		// would swallow the execute phase's first text/thinking deltas
		// (no new block run would open for them).
		state.lastBlockKind = undefined;
		state.pendingPlan = data.plan;
		// Phase 218/221: the doc path arrives WITH the plan (streamed during
		// the plan phase, before the card) — the card links to it. Phase 222:
		// always overwrite — a turn whose doc write failed must not show the
		// PREVIOUS turn's doc link (View Plan pointing at a stale file).
		conversation.planDocPath = data.planDocPath;
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
		// Phase 221: Cursor-parity decision card — a compact "Created Plan"
		// card in the chat (label + title + steps preview + View Plan /
		// Build / Cancel), landing right after the closing answer (user
		// spec: copy Cursor's plan card).
		this.renderPlanApprovalBar(conversation, state.currentAssistantRow, data.plan);
		// Phase 219: the Build / Cancel overlay widget still mounts over the
		// plan doc's editor (Cursor's doc-header Build). The decision card
		// above is always in the chat, so a closed tab / failed open no
		// longer needs a separate chat fallback.
		this.showPlanApprovalWidget(conversation, data.plan);
		// Phase 224: Cursor-parity To-dos block — mounts on the doc's editor
		// the moment the tab is held (the same entry.opening wait the
		// approval uses). The block belongs to the DOCUMENT: it hangs on the
		// conversation (not this turn's stream) so the execute turn's
		// plan_step events keep ticking it after this turn ends.
		const docEntry = state.planDocStream;
		if (docEntry) {
			const plan = data.plan;
			const mountTodos = (editor?: ICodeEditor) => {
				if (editor && plan) {
					this.mountPlanTodosWidget(conversation, plan, editor);
				}
			};
			if (docEntry.opening) {
				void docEntry.opening.then(() => mountTodos(docEntry.editor), () => mountTodos(undefined));
			} else {
				mountTodos(docEntry.editor);
			}
		}
		// The doc finished streaming into the editor — settle it (clear the
		// transient dirty flag; the model content matches the disk now).
		this.settlePlanDocStream(state);
		// Phase 215: research is done — fold the Worked shell (the same
		// collapse moment as ask/agent turns: the activity folds before the
		// next content lands, here the decision card). Phase 222: the turn
		// does NOT stay open — the done event finishes it right after this
		// (the card persists as a finished-turn artifact; Build re-opens a
		// fresh execute turn from it).
		this.settleWorkShell(conversation);
		this.scrollBottom(conversation, true);
	}

	// ==================== Phase 218: plan doc streaming (plan-as-doc) ====================

	/**
	 * Phase 218: the plan doc's first chunk (plan_doc_start) — the backend
	 * created PLAN.md and wrote the chunk before emitting. Opens the doc
	 * in the editor (the document content area) and resolves the model
	 * reference the remaining chunks apply through; the editor binds to
	 * the same model, so edits land in the visible tab.
	 */
	private handlePlanDocStart(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		if (!state || !data.planDocPath) {
			return;
		}
		// A stale stream (interrupted plan turn) never blocks a fresh one.
		if (state.planDocStream) {
			this.settlePlanDocStream(state);
		}
		const entry = {
			path: data.planDocPath,
			// The conversation's project root — the doc path is relative and
			// must anchor somewhere even in the folder-less Agent Window.
			root: this.conversationWorkspaceRoot(conversation),
			text: data.planDocDelta ?? '',
			ref: undefined as IReference<IResolvedTextEditorModel> | undefined,
			opening: undefined as Promise<void> | undefined,
		};
		state.planDocStream = entry;
		entry.opening = this.openPlanDocStreamEditor(entry);
		// Phase 220: the chat keeps only the always-used pulsing purple dot
		// at the plan card's former position while the doc writes — an empty
		// streaming text body (the same caret the answers stream with). The
		// closing message (the turn's final answer) streams into this very
		// run when it arrives after the doc is done.
		if (state.lastBlockKind !== 'text') {
			this.closeRunsBefore(conversation, 'text');
			this.ensureTextRun(conversation);
		}
		state.lastBlockKind = 'text';
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 218: opens the plan doc in the editor and acquires its model
	 * reference (both resolve to the same text model — the reference may
	 * land before or after the editor does). Model load races the stream
	 * (the disk file already holds every written chunk) — the first apply
	 * re-asserts the accumulated SSE truth over whatever the model loaded.
	 */
	private async openPlanDocStreamEditor(entry: { path: string; root: string; text: string; ref: IReference<IResolvedTextEditorModel> | undefined; opening: Promise<void> | undefined; editor?: ICodeEditor; }): Promise<void> {
		const uri = this.resolveWorkspacePath(entry.path, entry.root);
		if (!uri) {
			return;
		}
		// The document content area shows the doc while it streams (a
		// preview-tab open; revealIfOpened reuses an existing tab). The
		// code editor the pane lands is kept — Phase 219's approval widget
		// mounts on it once the plan is ready.
		try {
			// Phase 226: no explicit override — the resolver routes `*.plan.md`
			// to the rendered Plan doc pane (which attaches to the same model
			// and re-renders per chunk). If the plan pane fails to open, fall
			// back to the raw text editor so the Phase 219/224 editor widgets
			// still have a host.
			const pane = await this.editorService.openEditor({ resource: uri, options: { revealIfOpened: true } })
				?? await this.editorService.openEditor({ resource: uri, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, revealIfOpened: true } });
			entry.editor = getCodeEditor(pane?.getControl()) ?? undefined;
		} catch {
			// Editor open failed (uri not openable) — the model reference
			// may still resolve; the approval falls back to the chat bar.
		}
		try {
			entry.ref = await this.textModelService.createModelReference(uri);
			this.applyPlanDocStream(entry);
		} catch {
			// No model for the uri (file gone / not resolvable) — the disk
			// write still happened; the doc link re-opens it later.
		}
	}

	/**
	 * Phase 218: one plan doc chunk (plan_doc_delta) — buffered into the
	 * accumulated text and applied to the editor's model when it's ready.
	 */
	private handlePlanDocDelta(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const entry = conversation.stream?.planDocStream;
		if (!entry || !data.planDocPath || data.planDocPath !== entry.path) {
			return;
		}
		entry.text += data.planDocDelta ?? '';
		if (entry.ref) {
			this.applyPlanDocStream(entry);
		}
	}

	/**
	 * Phase 218: converges the editor's model to the accumulated stream
	 * text — appending the missing tail when the model is a prefix of it
	 * (the normal streaming case), re-asserting the whole text otherwise
	 * (the model loaded more of the disk file than the SSE saw). The tail
	 * reveal keeps the streaming end in view.
	 */
	private applyPlanDocStream(entry: { text: string; ref: IReference<IResolvedTextEditorModel> | undefined; }): void {
		const model = entry.ref?.object.textEditorModel;
		if (!model) {
			return;
		}
		const current = model.getValue();
		if (current !== entry.text) {
			if (entry.text.startsWith(current)) {
				const lastLine = model.getLineCount();
				const lastCol = model.getLineMaxColumn(lastLine);
				model.pushEditOperations(
					[],
					[{ range: new Range(lastLine, lastCol, lastLine, lastCol), text: entry.text.slice(current.length) }],
					() => null
				);
			} else {
				model.setValue(entry.text);
			}
		}
		// Follow the stream: reveal the tail in every editor showing the doc.
		const target = model.uri.toString();
		for (const editor of this.codeEditorService.listCodeEditors()) {
			if (editor.getModel()?.uri.toString() === target) {
				editor.revealLine(model.getLineCount());
			}
		}
	}

	/**
	 * Phase 218: the doc stream is over (the `plan` event, turn finish or
	 * a stale-stream replacement) — clear the transient dirty flag the
	 * model edits left (the content matches the on-disk file, so a force
	 * revert is a no-op reload) and release the reference. A user who
	 * hand-edited the doc mid-stream keeps their edits (dirty stays).
	 */
	private settlePlanDocStream(state: VibeAIStreamState): void {
		const entry = state.planDocStream;
		if (!entry) {
			return;
		}
		state.planDocStream = undefined;
		const finish = () => {
			try {
				entry.ref?.dispose();
			} catch {
				// the reference may already be gone with the editor
			}
		};
		(entry.opening ?? Promise.resolve()).then(() => {
			const model = entry.ref?.object.textEditorModel;
			if (model && model.getValue() === entry.text) {
				const uri = this.resolveWorkspacePath(entry.path, entry.root);
				if (uri) {
					this.textFileService.revert(uri, { force: true }).catch(() => { /* best effort */ });
				}
			}
		}).finally(finish);
	}

	// ==================== Phase 219: approval in the plan doc editor ====================

	/**
	 * Phase 219: shows the plan approval IN the doc's editor — an overlay
	 * widget pinned to the editor's top center with the Build / Cancel
	 * actions (user spec: the plan is a DOCUMENT, the approval happens on
	 * it — no plan card or bar in the chat). Waits for the doc's editor
	 * open when it is still resolving (the widget mounts the moment the
	 * tab lands); falls back to the chat approval bar when no editor ends
	 * up holding the doc (open failed / sentinel root without a doc path /
	 * tab closed mid-approval).
	 */
	private showPlanApprovalWidget(conversation: VibeAIConversation, plan: IVibeAIPlan): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		const mount = (editor: ICodeEditor | undefined) => {
			const live = conversation.stream;
			// The same live turn, still awaiting, nothing mounted yet —
			// anything else (turn resolved / superseded) mounts nothing.
			const awaiting = !!live && live === state && live.planPhase === 'awaiting' && !live.planApproval && !!live.currentAssistantRow;
			if (editor && awaiting && live) {
				try {
					const widget = this.createPlanApprovalWidget(conversation, plan);
					editor.addOverlayWidget(widget);
					live.planApproval = { editor, widget };
					// The doc's tab closes mid-approval — the widget dies
					// with the editor; the chat's decision card (Phase 221,
					// always rendered at plan-ready) keeps Build / Cancel
					// reachable, nothing to re-render here.
					this.conversationPlanDisposables(conversation).add(this.editorService.onDidCloseEditor(e => {
						if (live.planApproval?.editor !== editor) {
							return;
						}
						live.planApproval = undefined;
					}));
					return;
				} catch {
					// The editor is gone already (tab closed / disposed) —
					// the chat decision card takes the approval.
				}
			}
		};
		const entry = state.planDocStream;
		if (entry?.opening) {
			void entry.opening.then(() => mount(entry.editor), () => mount(undefined));
		} else {
			mount(entry?.editor);
		}
	}

	/**
	 * Phase 219: builds the editor overlay widget — plan title + the
	 * summary/steps meta and the shared Build / Cancel actions (same
	 * handlers and wiring as the fallback bar: renderPlanActions keeps
	 * the planCardRoot contract for cancelPlan / executePlanFromCard).
	 */
	private createPlanApprovalWidget(conversation: VibeAIConversation, plan: IVibeAIPlan): IOverlayWidget {
		const dom = $('.vibe-ai-plan-approval-widget');
		const icon = DOM.append(dom, $('span.codicon.codicon-checklist.vibe-ai-plan-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const title = DOM.append(dom, $('span.vibe-ai-plan-approval-title'));
		title.textContent = localize('vibeAIChat.planTitle', "Plan");
		const meta = DOM.append(dom, $('span.vibe-ai-plan-approval-meta'));
		meta.textContent = plan.summary && plan.summary.length > 0
			? plan.summary
			: localize('vibeAIChat.planStepsCount', "{0} steps", plan.steps.length);
		meta.title = meta.textContent ?? '';
		this.renderPlanActions(conversation, dom, plan);
		return {
			getId: () => `vibeAI.planApproval.${conversation.id}`,
			getDomNode: () => dom,
			getPosition: () => ({ preference: OverlayWidgetPositionPreference.TOP_CENTER })
		};
	}

	/**
	 * Phase 219: removes the editor approval widget — every resolution of
	 * the awaiting phase (Build, Cancel, interrupt, execution start,
	 * stream teardown). The editor may be gone already; the remove is
	 * best effort.
	 */
	private disposePlanApprovalWidget(state: VibeAIStreamState | undefined): void {
		const approval = state?.planApproval;
		if (!approval) {
			return;
		}
		state!.planApproval = undefined;
		try {
			approval.editor.removeOverlayWidget(approval.widget);
		} catch {
			// the editor is gone already (tab closed / disposed)
		}
	}

	// ==================== Phase 224: the plan doc's To-dos block ====================

	/**
	 * Phase 224: Cursor-parity To-dos block — a content widget pinned under
	 * the plan doc's last line: the "N To-dos [+ New]" checklist (rows
	 * mirror the plan steps; plan_step events tick them live) and the
	 * "Referenced by 1 Agent" author row (the creating conversation;
	 * + New spawns a fresh agent seeded with the plan reference). The
	 * re-anchor follows the doc's growth (a layout pass per model change);
	 * the block dies with the doc's tab (editor onDidDispose) or the pane
	 * (turnRecordDisposables), and a newer plan's mount replaces it.
	 */
	private mountPlanTodosWidget(conversation: VibeAIConversation, plan: IVibeAIPlan, editor: ICodeEditor): void {
		const model = editor.getModel();
		if (!model) {
			return;
		}
		this.disposePlanTodosWidget(conversation);
		const dom = $('.vibe-ai-plan-todos');
		const header = DOM.append(dom, $('.vibe-ai-plan-todos-header'));
		const count = DOM.append(header, $('span.vibe-ai-plan-todos-count'));
		let todoCount = plan.steps.length;
		count.textContent = localize('vibeAIChat.planTodosCount', "{0} To-dos", todoCount);
		const addNew = DOM.append(header, $('span.vibe-ai-plan-todos-add'));
		addNew.textContent = localize('vibeAIChat.planTodosAdd', "+ New");
		const list = DOM.append(dom, $('.vibe-ai-plan-todos-list'));
		const rows = new Map<number, HTMLElement>();
		for (const step of plan.steps) {
			const row = DOM.append(list, $('.vibe-ai-plan-todos-item'));
			row.dataset['step'] = String(step.id);
			const icon = DOM.append(row, $('span.codicon.vibe-ai-plan-todos-icon'));
			icon.setAttribute('aria-hidden', 'true');
			// Pending until its plan_step_start arrives (same icon set as
			// the chat card's step rows).
			icon.classList.add('codicon-circle-large-outline');
			const label = DOM.append(row, $('span.vibe-ai-plan-todos-label'));
			label.textContent = step.title;
			rows.set(step.id, row);
		}
		// "Referenced by 1 Agent [+ New]" — the creating conversation is the
		// reference; + New spawns a fresh agent (new conversation, project
		// inherited) whose first message works through the plan.
		const refSection = DOM.append(dom, $('.vibe-ai-plan-todos-ref'));
		const refHeader = DOM.append(refSection, $('.vibe-ai-plan-todos-ref-header'));
		refHeader.textContent = localize('vibeAIChat.planTodosReferenced', "Referenced by {0} Agent", 1);
		const refAdd = DOM.append(refHeader, $('span.vibe-ai-plan-todos-add'));
		refAdd.textContent = localize('vibeAIChat.planTodosAdd', "+ New");
		const author = DOM.append(refSection, $('.vibe-ai-plan-todos-author'));
		author.textContent = conversation.title || 'VibeCoding';
		// + New (To-dos): appends an editable checkbox line to the doc —
		// the same `- [ ] N. ` shape the progress helpers read back.
		conversation.turnRecordDisposables.add(DOM.addDisposableListener(addNew, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			todoCount++;
			count.textContent = localize('vibeAIChat.planTodosCount', "{0} To-dos", todoCount);
			const lastLine = model.getLineCount();
			const lastCol = model.getLineMaxColumn(lastLine);
			model.pushEditOperations(
				[],
				[{ range: new Range(lastLine, lastCol, lastLine, lastCol), text: `\n- [ ] ${todoCount}. ` }],
				() => null
			);
			editor.focus();
			const line = model.getLineCount();
			editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
		}));
		// + New (Referenced by): a fresh agent on this plan.
		conversation.turnRecordDisposables.add(DOM.addDisposableListener(refAdd, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			if (!conversation.planDocPath) {
				return;
			}
			void this.sendFromHub(
				localize('vibeAIChat.planTodosSpawn',
					"Execute the plan in {0}: work through its to-dos in order, one at a time.", conversation.planDocPath),
				conversation.workspaceRoot
			);
		}));
		const widget: IContentWidget = {
			getId: () => `vibeAI.planTodos.${conversation.id}`,
			getDomNode: () => dom,
			getPosition: () => {
				const m = editor.getModel();
				if (!m) {
					return null;
				}
				const last = m.getLineCount();
				return {
					position: { lineNumber: last, column: m.getLineMaxColumn(last) },
					preference: [ContentWidgetPositionPreference.BELOW]
				};
			}
		};
		editor.addContentWidget(widget);
		conversation.planTodos = { editor, widget, rows, list };
		// Follow the doc's growth: every content change (stream chunks,
		// hand edits, + New appends) re-anchors the block under the new
		// last line.
		conversation.turnRecordDisposables.add(model.onDidChangeContent(() => {
			try {
				editor.layoutContentWidget(widget);
			} catch {
				// the editor is gone already
			}
		}));
		// The doc's tab closed — the block dies with the editor.
		conversation.turnRecordDisposables.add(editor.onDidDispose(() => {
			conversation.planTodos = undefined;
		}));
	}

	/**
	 * Phase 224: removes the plan doc's To-dos block — a newer plan's
	 * mount replaces it; the block otherwise dies with the doc's editor
	 * (onDidDispose) or the pane (turnRecordDisposables).
	 */
	private disposePlanTodosWidget(conversation: VibeAIConversation): void {
		const todos = conversation.planTodos;
		if (!todos) {
			return;
		}
		conversation.planTodos = undefined;
		try {
			todos.editor.removeContentWidget(todos.widget);
		} catch {
			// the editor is gone already (tab closed / disposed)
		}
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
		// Phase 213: the plan doc link (Cursor-parity plan-as-doc) — the
		// execute phase wrote the plan doc (.vibe/plans since Phase 221) and
		// checks steps off in it; the link opens it in the editor. The
		// awaiting card has no doc yet (written during planning).
		if (status !== 'awaiting' && conversation.planDocPath) {
			const docLink = DOM.append(card, $('a.vibe-ai-plan-doc-link'));
			docLink.textContent = localize('vibeAIChat.planDocLink', "View Plan");
			docLink.title = conversation.planDocPath;
			this.conversationPlanDisposables(conversation).add(DOM.addDisposableListener(docLink, DOM.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.openFile(conversation.planDocPath!);
			}));
		}
		// Executed plans show the recorded per-step results.
		if (status === 'executed') {
			this.applyPlanResults(card, plan, results ?? { stepsDone: [], stepsFailed: [] });
		}
	}

	/**
	 * Phase 221: the Cursor-parity decision card — replaces the 218 slim
	 * bar (user spec: the chat keeps a "Created Plan" card like Cursor's:
	 * small label, the plan title, a steps preview, then a footer with
	 * View Plan + the shared Build / Cancel actions). Reuses the card's
	 * action buttons and the planCardRoot slot, so cancelPlan /
	 * executePlanFromCard / plan_start's card swap keep working on it
	 * unchanged.
	 */
	private renderPlanApprovalBar(conversation: VibeAIConversation, parent: HTMLElement, plan: IVibeAIPlan): void {
		const state = conversation.stream;
		// A re-render replaces the previous card (same slot as the plan card).
		if (state?.planCardRoot) {
			state.planCardRoot.remove();
			state.planCardRoot = undefined;
			state.planProgress = undefined;
			state.planStepRows = undefined;
		}
		const bar = DOM.append(parent, $('.vibe-ai-plan-bar.vibe-ai-created-plan'));
		bar.classList.add('vibe-ai-plan-awaiting');
		const label = DOM.append(bar, $('span.vibe-ai-plan-bar-label'));
		label.textContent = localize('vibeAIChat.createdPlan', "Created Plan");
		const title = DOM.append(bar, $('.vibe-ai-plan-bar-title'));
		title.textContent = plan.summary && plan.summary.length > 0
			? plan.summary
			: localize('vibeAIChat.planStepsCount', "{0} steps", plan.steps.length);
		const preview = plan.steps.slice(0, 3).map(step => `${step.id}. ${step.title}`).join('；');
		if (preview) {
			const desc = DOM.append(bar, $('.vibe-ai-plan-bar-desc'));
			desc.textContent = plan.steps.length > 3 ? `${preview}…` : preview;
			desc.title = desc.textContent ?? '';
		}
		const footer = DOM.append(bar, $('.vibe-ai-plan-bar-footer'));
		// The doc is already on disk (streamed during the plan phase) — the
		// link opens it in the editor (Cursor-parity plan-as-doc).
		if (conversation.planDocPath) {
			const docLink = DOM.append(footer, $('a.vibe-ai-plan-doc-link.vibe-ai-plan-bar-link'));
			docLink.textContent = localize('vibeAIChat.planDocLink', "View Plan");
			docLink.title = conversation.planDocPath;
			this.conversationPlanDisposables(conversation).add(DOM.addDisposableListener(docLink, DOM.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.openFile(conversation.planDocPath!);
			}));
		}
		if (state) {
			state.planCardRoot = bar;
			state.planProgress = undefined;
			state.planStepRows = undefined;
		}
		this.renderPlanActions(conversation, footer, plan);
	}

	/**
	 * Phase 218: folds the awaiting approval bar (or a restored awaiting
	 * card) to its cancelled state — actions removed, dimmed, with a short
	 * note. Shared by the bar's Cancel click (works on a restored card
	 * with no live stream state), cancelPlan and the interrupt path (the
	 * awaiting guard in finishStreaming would otherwise keep it open).
	 */
	private foldPlanAwaitingToCancelled(root: HTMLElement | undefined): void {
		if (!root) {
			return;
		}
		root.classList.remove('vibe-ai-plan-awaiting');
		root.classList.add('vibe-ai-plan-cancelled');
		root.querySelector('.vibe-ai-plan-actions')?.remove();
		if (root.classList.contains('vibe-ai-plan-bar') && !root.querySelector('.vibe-ai-plan-bar-note')) {
			const note = DOM.append(root, $('span.vibe-ai-plan-bar-note'));
			note.textContent = localize('vibeAIChat.planBarCancelled', "Cancelled — the plan doc is kept in .vibe/plans");
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
			// Fold this card/bar to its cancelled state (also works on a
			// restored card, where there is no live turn to close).
			this.foldPlanAwaitingToCancelled(card);
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
	 * Phase 92: the backend intercepted a terminal command (safety check /
	 * hook) and parked it at the approval gate — renders the Run / Skip
	 * card inside the turn's Worked shell (Cursor-parity command approval).
	 * Phase 106: the pending command is a workflow step like any tool
	 * call — the card lands in the Working timeline's steps container,
	 * right after the run's tool cards (arrival order = workflow order)
	 * instead of at row level below the shell. The stream stays open
	 * while the gate waits; the user's decision resolves it via
	 * {@link resolveApprovalFromCard} and the executed (or skipped)
	 * result arrives later as the tool card's result.
	 */
	private handleApprovalRequest(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const approval = data.approval;
		if (!state || !state.currentAssistantRow || !approval) {
			return;
		}
		// Phase 106: the same shell bootstrap as handleToolStart — a turn
		// whose first activity is a blocked command still gets its Worked
		// shell (earlier thinking/narration runs move inside), and a later
		// approval appends after the run's tool cards in event order.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			// Phase 84.9/89: no reopen dance — the shell never folds
			// mid-turn (see handleToolStart).
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.workAnyTool = true;
		// Phase 231: a permission gate mid-step lands in that step's group.
		const card = DOM.append(this.planActivityRoot(state) ?? state.currentAssistantRow, $('.vibe-ai-approval-card'));
		card.dataset['approvalId'] = approval.id;
		const header = DOM.append(card, $('.vibe-ai-approval-header'));
		const icon = DOM.append(header, $('span.codicon.codicon-debug-disconnect.vibe-ai-approval-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const title = DOM.append(header, $('span.vibe-ai-approval-title'));
		title.textContent = localize('vibeAIChat.approvalTitle', "Run command?");
		if (approval.reason.length > 0) {
			const reason = DOM.append(card, $('.vibe-ai-approval-reason'));
			reason.textContent = approval.reason;
		}
		const command = DOM.append(card, $('.vibe-ai-approval-command'));
		command.textContent = approval.command;
		const actions = DOM.append(card, $('.vibe-ai-approval-actions'));
		const run = DOM.append(actions, $('button.vibe-ai-approval-run')) as HTMLButtonElement;
		run.textContent = localize('vibeAIChat.approvalRun', "Run");
		run.type = 'button';
		const skip = DOM.append(actions, $('button.vibe-ai-approval-skip')) as HTMLButtonElement;
		skip.textContent = localize('vibeAIChat.approvalSkip', "Skip");
		skip.type = 'button';
		// Phase 160: approval memory (Cursor auto-run parity) — secondary
		// options that approve AND remember: this turn (loop-local — the
		// same command stops asking until the turn ends) or this project
		// (persisted to <root>/.vibe/approvals.json, the gate hot-reads it).
		// Blacklist commands are never exempted by memory (backend-enforced).
		const allowTurn = DOM.append(actions, $('button.vibe-ai-approval-skip')) as HTMLButtonElement;
		allowTurn.textContent = localize('vibeAIChat.approvalAllowTurn', "Allow for this turn");
		allowTurn.type = 'button';
		const allowProject = DOM.append(actions, $('button.vibe-ai-approval-skip')) as HTMLButtonElement;
		allowProject.textContent = localize('vibeAIChat.approvalAllowProject', "Always allow");
		allowProject.type = 'button';
		const disposables = this.conversationPlanDisposables(conversation);
		disposables.add(DOM.addDisposableListener(run, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.resolveApprovalFromCard(card, approval.id, true);
		}));
		disposables.add(DOM.addDisposableListener(skip, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.resolveApprovalFromCard(card, approval.id, false);
		}));
		disposables.add(DOM.addDisposableListener(allowTurn, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.resolveApprovalFromCard(card, approval.id, true, 'turn', this.conversationWorkspaceRoot(conversation));
		}));
		disposables.add(DOM.addDisposableListener(allowProject, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.resolveApprovalFromCard(card, approval.id, true, 'project', this.conversationWorkspaceRoot(conversation));
		}));
		// Phase 106: the gate BLOCKS the stream until the user decides —
		// surface the Run / Skip buttons regardless of the reading
		// position (forced scroll: a hidden approval reads as a hang).
		// A shell the user collapsed mid-turn re-opens so the buttons are
		// reachable.
		if (state.workShell) {
			state.workShell.open = true;
		}
		this.scrollBottom(conversation, true);
	}

	/**
	 * Phase 92: the gate decided (the backend's approval_resolved event —
	 * timeout, or the click's echo). Phase 111 (user feedback): an
	 * APPROVED command's card goes away entirely the moment Run is
	 * clicked (see {@link resolveApprovalFromCard}) — the command's own
	 * tool card (created at tool_start, right above) carries the run and
	 * its output, so the approval card would only squat below it as a
	 * ghost (user: "點擊運行後下面的塊直接消失，只顯示上面的塊"). The
	 * approved branch below stays as a safety net for a card still live
	 * when the event lands. A skipped / timed-out gate keeps its short
	 * note — the failed tool card leaves the Worked section since
	 * Phase 98, so this note is the attempt's only record.
	 */
	private handleApprovalResolved(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const approval = data.approval;
		if (!state || !state.currentAssistantRow || !approval) {
			return;
		}
		const card = state.currentAssistantRow.querySelector(`.vibe-ai-approval-card[data-approval-id="${approval.id}"]`) as HTMLElement | null;
		if (!card) {
			return;
		}
		if (approval.approved) {
			// The executed tool card above shows the run — the approval
			// card's job is done (its "Running…" note rides the click).
			card.remove();
			return;
		}
		card.classList.add('skipped');
		card.querySelector('.vibe-ai-approval-actions')?.remove();
		const note = DOM.append(card, $('.vibe-ai-approval-note'));
		note.textContent = approval.timedOut
			? localize('vibeAIChat.approvalTimedOutNote', "Timed out — skipped")
			: localize('vibeAIChat.approvalSkippedNote', "Skipped");
	}

	/**
	 * Phase 92: the user picked Run / Skip and the backend gate is
	 * resolved right away. Phase 111 (user feedback: 「點擊運行後下面的塊
	 * 直接消失，只顯示上面的塊」; clarified: the card goes at the CLICK,
	 * not when the run finishes): a Run click removes the card the
	 * moment it lands — the run rides the tool card above (tool_start
	 * already created it; tool_result updates it), so keeping the gate
	 * card up for the whole execution would only squat below the run as
	 * a "Running…" ghost. Skip keeps the card (the failed tool card
	 * leaves the Worked section since Phase 98, so the card carries the
	 * attempt) with its buttons disabled (no double submit); its
	 * decided state rides the approval_resolved event.
	 */
	private resolveApprovalFromCard(card: HTMLElement, id: string, approved: boolean, scope?: 'once' | 'turn' | 'project', projectRoot?: string): void {
		if (approved) {
			card.remove();
			void this.vibeAIService.resolveApproval(id, approved, scope, projectRoot);
			return;
		}
		card.querySelectorAll('button').forEach(button => {
			(button as HTMLButtonElement).disabled = true;
		});
		void this.vibeAIService.resolveApproval(id, approved, scope, projectRoot);
	}

	/**
	 * Phase 121/237: the model asked clarifying questions (ask_questions)
	 * — renders one question card per event inside the turn's Worked
	 * shell (Cursor-parity Ask questions tool). Since Phase 237 the turn
	 * PARKS at the question gate until the card's answer resolves it —
	 * the loop does not continue, and the turn cannot finish with the
	 * question unanswered. The answer (or a picked option) goes out via
	 * {@link sendAgentAnswerFromCard} → `resolveAgentQuestion()` (the
	 * gate's pending id rides the card) and feeds back to the model as
	 * the tool's result; the card then marks itself answered.
	 */
	private handleAgentQuestions(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const questions = data.questions;
		if (!state || !state.currentAssistantRow || !questions || questions.items.length === 0) {
			return;
		}
		// The same shell bootstrap as handleToolStart / handleApprovalRequest —
		// a question card is a workflow step like any tool call.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			// Phase 84.9/89: no reopen dance — the shell never folds
			// mid-turn (see handleToolStart).
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.workAnyTool = true;
		const disposables = this.conversationPlanDisposables(conversation);
		// Phase 231: a questions card mid-step lands in that step's group.
		const card = DOM.append(this.planActivityRoot(state) ?? state.currentAssistantRow, $('.vibe-ai-questions-card'));
		if (questions.id.length > 0) {
			card.dataset['questionsId'] = questions.id;
		}
		const header = DOM.append(card, $('.vibe-ai-questions-header'));
		const icon = DOM.append(header, $('span.codicon.codicon-question.vibe-ai-questions-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const title = DOM.append(header, $('span.vibe-ai-questions-title'));
		title.textContent = localize('vibeAIChat.agentQuestionsTitle', "Agent is asking");
		const list = DOM.append(card, $('.vibe-ai-questions-list'));
		const answerRow = DOM.append(card, $('.vibe-ai-questions-answer'));
		const input = DOM.append(answerRow, $('input.vibe-ai-questions-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('vibeAIChat.agentQuestionsPlaceholder', "Type your answer…");
		const send = DOM.append(answerRow, $('button.vibe-ai-questions-send')) as HTMLButtonElement;
		send.textContent = localize('vibeAIChat.agentQuestionsSend', "Send");
		send.type = 'button';
		// One pick per question (Phase 237): the pick highlights its chip
		// (click a sibling to switch, click again to deselect) and the
		// input box stays free for notes beyond the offered options —
		// Send collects the picks + the notes, either alone sends.
		const picks = questions.items.map(() => '');
		questions.items.forEach((item, index) => {
			const itemEl = DOM.append(list, $('.vibe-ai-questions-item'));
			const text = DOM.append(itemEl, $('.vibe-ai-questions-text'));
			text.textContent = questions.items.length > 1
				? localize('vibeAIChat.agentQuestionsItem', "{0}. {1}", index + 1, item.question)
				: item.question;
			if (item.options && item.options.length > 0) {
				const options = DOM.append(itemEl, $('.vibe-ai-questions-options'));
				for (const option of item.options) {
					const chip = DOM.append(options, $('button.vibe-ai-questions-option')) as HTMLButtonElement;
					chip.textContent = option;
					chip.type = 'button';
					chip.title = option;
					disposables.add(DOM.addDisposableListener(chip, DOM.EventType.CLICK, e => {
						e.preventDefault();
						e.stopPropagation();
						if (input.disabled) {
							return;
						}
						const wasPicked = chip.classList.contains('selected');
						for (const sibling of options.children) {
							(sibling as HTMLElement).classList.remove('selected');
						}
						if (wasPicked) {
							picks[index] = '';
						} else {
							chip.classList.add('selected');
							picks[index] = option;
						}
					}));
				}
			}
		});
		const sendAnswer = (): void => this.sendAgentAnswerFromCard(card, conversation, input, send, picks);
		disposables.add(DOM.addDisposableListener(send, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			sendAnswer();
		}));
		disposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				sendAnswer();
			}
		}));
		// An unanswered question is as reachable as a pending approval —
		// jump to the bottom so it is not missed.
		this.scrollBottom(conversation, true);
	}

	/**
	 * Phase 121/237: sends the card's answer for the parked Agent turn —
	 * the card carries the gate's pending id, so `resolveAgentQuestion()`
	 * wakes the gate directly and the answer feeds back as the tool's
	 * result (the turn continues with it). The answer is the picked
	 * options (per question, `picks`) plus the input's free-text notes
	 * (anything beyond the offered options) — either alone sends. Fallbacks
	 * keep the older paths alive: a gone gate (answered elsewhere, backend
	 * restart, a restored old card) but a still-running turn goes out via
	 * `steer()` (Phase 121 behavior — injects at the next tool boundary,
	 * the `steered` event renders the Steered bubble); a finished turn
	 * shows the not-delivered note so the user can press Enter to send it
	 * as a new message. Failure at either stage restores the input so
	 * nothing is lost.
	 */
	private sendAgentAnswerFromCard(card: HTMLElement, conversation: VibeAIConversation, input: HTMLInputElement, send: HTMLButtonElement, picks: string[]): void {
		const notes = input.value.trim();
		const multi = picks.length > 1;
		const picked = picks
			.map((pick, index) => (pick ? (multi ? `${index + 1}. ${pick}` : pick) : ''))
			.filter(part => part.length > 0)
			.join('；');
		const text = notes.length > 0
			? (picked.length > 0 ? `${picked}——${notes}` : notes)
			: picked;
		if (text.length === 0) {
			return;
		}
		const state = conversation.stream;
		input.disabled = true;
		send.disabled = true;
		// Phase 121 fallback path (the resolve below is the Phase 237
		// primary): same in-flight contract as steerActiveTurn — if the
		// turn ends before the tool boundary injects the answer, done's
		// pending_steer preserves it (the echo removes the entry).
		const steerFallback = (): void => {
			state?.inflightSteers.push(text);
			void this.vibeAIService.steer(conversation.sessionId, text).then(steered => {
				if (steered) {
					// Queued for injection — mark the card answered. The
					// Steered bubble renders the answer in the timeline
					// when it lands at the next tool boundary.
					this.markQuestionCardAnswered(card, text);
					return;
				}
				// Not delivered — restore the card so the user keeps
				// their words.
				const index = state?.inflightSteers.indexOf(text) ?? -1;
				if (index >= 0 && state) {
					state.inflightSteers.splice(index, 1);
				}
				input.disabled = false;
				send.disabled = false;
				input.value = text;
				const note = DOM.append(card, $('.vibe-ai-questions-note'));
				note.classList.add('error');
				note.textContent = localize('vibeAIChat.agentQuestionsNotDelivered', "Not delivered — the turn already finished; press Enter to send as a new message");
			});
		};
		const questionId = card.dataset['questionsId'] ?? '';
		if (questionId.length > 0) {
				// Phase 237 primary: wake the gate the turn parks on. The
				// agent_question_answered event folds the card too — the fold
				// order with this response is a race (the SSE event usually
				// wins), markQuestionCardAnswered itself is idempotent so
				// either order lands exactly one Answered note.
				void this.vibeAIService.resolveAgentQuestion(questionId, text).then(resolved => {
					if (resolved) {
						this.markQuestionCardAnswered(card, text);
					} else {
						steerFallback();
					}
				});
		} else {
			// No gate id on the card (defensive) — Phase 121 steer path.
			steerFallback();
		}
	}

	/**
	 * Phase 237: folds a question card to its answered state — the answer
	 * reached the gate (the turn continues with it as the tool's result).
	 * The sent content (picks + notes) shows under the note so the user
	 * can confirm at a glance what went out; the picked chip keeps its
	 * highlight. Phase 243: idempotent at the SOURCE — the resolve POST's
	 * response and the agent_question_answered SSE event race each other
	 * (either can land first; the event usually wins), so the first fold
	 * claims the card's `answered` class and every later call is a no-op
	 * (the first answer text stays; a duplicate note is never appended).
	 */
	private markQuestionCardAnswered(card: HTMLElement, answer: string): void {
		if (card.classList.contains('answered')) {
			return;
		}
		card.classList.add('answered');
		card.querySelector('.vibe-ai-questions-answer')?.remove();
		const note = DOM.append(card, $('.vibe-ai-questions-note'));
		note.textContent = localize('vibeAIChat.agentQuestionsAnswered', "Answered — the agent continues with your answer");
		if (answer.length > 0) {
			const sent = DOM.append(card, $('.vibe-ai-questions-sent'));
			sent.textContent = answer;
		}
	}

	/**
	 * Phase 237: the gate woke with the user's answer (`agent_question_
	 * answered` event, id = the gate's pending id) — fold the matching
	 * card. Idempotent: the card's own Send already folded it; this
	 * catches answers sent from another surface (Agents Hub / Agent
	 * Window) or a resolve response that lost the race with the event.
	 */
	private handleAgentQuestionAnswered(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const answered = data.questionAnswered;
		if (!state || !state.currentAssistantRow || !answered || answered.id.length === 0) {
			return;
		}
		const card = state.currentAssistantRow.querySelector(`.vibe-ai-questions-card[data-questions-id="${answered.id}"]`) as HTMLElement | null;
		if (!card || card.classList.contains('answered')) {
			return;
		}
		this.markQuestionCardAnswered(card, answered.answer);
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
		// Phase 219: the doc editor's approval widget dies with the pick —
		// the executing plan card in the chat takes the progress over.
		this.disposePlanApprovalWidget(state);
		if (state && state.planPhase === 'awaiting' && state.pendingPlan === plan && state.currentAssistantRow) {
			// The card-to-done window (Phase 222: the plan turn finishes the
			// moment the card lands — this live branch only catches a Build
			// click before the done event arrives): keep streaming the
			// execute phase into it (the identity check binds the card's own
			// plan — a stale restored card's plan opens a fresh turn below).
			const requestId = `vibe-${++this.requestCounter}`;
			state.requestId = requestId;
			state.pendingPlan = plan;
			state.planPhase = 'executing';
			// Phase 151: the awaiting turn state is over once the user
			// acts — the execute stream's own turn_state events take over
			// (a stale awaiting_plan_approval would block the close).
			state.turnState = undefined;
			this.renderPlanCard(conversation, state.currentAssistantRow, plan, 'executing');
			this.updateInputActions();
			this.renderTabs();
			this.dispatchPlanExecute(conversation, requestId, plan);
		} else {
			// Phase 222 (the norm): the plan turn already ended at the card —
			// Build opens a fresh assistant turn rendering the execute phase
			// (same path a restored awaiting card always took).
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
	 * Phase 226: the plan doc pane's Build — executes the plan on its
	 * OWNING agent (the conversation whose plan doc this file is: activate
	 * its tab, then the same fresh-turn path the decision card's Build
	 * takes). A doc without an owning conversation (a plan file opened
	 * standalone) spawns a fresh agent via the hub send path.
	 */
	async buildPlanFromDoc(docPath: string, plan: IVibeAIPlan): Promise<void> {
		const normalized = docPath.replace(/\\/g, '/').toLowerCase();
		const owner = this.conversations.find(c => {
			if (!c.planDocPath) {
				return false;
			}
			const rel = c.planDocPath.replace(/\\/g, '/').toLowerCase();
			return normalized === rel || normalized.endsWith(`/${rel}`);
		});
		if (owner) {
			this.setActiveConversation(owner.id);
			this.executePlanFromCard(owner, plan);
			return;
		}
		await this.sendFromHub(
			localize('vibeAIChat.planTodosSpawn',
				"Execute the plan in {0}: work through its to-dos in order, one at a time.", docPath),
			this.activeWorkspaceRoot()
		);
	}

	/**
	 * Phase 71: renders a restored plan card from a persisted turn record
	 * (history restore): executed plans show the recorded per-step
	 * results, cancelled ones their gray state — an `awaiting` status
	 * (persisted since Phase 222: the plan turn ends at the decision
	 * card) renders the Created Plan decision card so the plan can still
	 * be executed after a reload.
	 */
	private renderRestoredPlanCard(conversation: VibeAIConversation, row: HTMLElement, turn: IVibeAIPersistedTurn): void {
		if (!turn.plan || turn.plan.steps.length === 0) {
			return;
		}
		const status: VibeAIPlanCardStatus = turn.planStatus ?? 'executed';
		if (status === 'awaiting') {
			this.renderPlanApprovalBar(conversation, row, turn.plan);
			return;
		}
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

	// Phase 139: terminal permission mode — read live per turn so a
	// Settings change applies to the next turn without a reload.
	private get permissionMode(): string | undefined {
		return this.configurationService.getValue<string>('vibeAI.agent.permissionMode') || undefined;
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
			// Phase 139: terminal permission mode (Cursor parity) — the
			// Settings → General control, read live per execute phase.
			permissionMode: this.permissionMode,
			// Phase 157: the persisted plan file captured from this plan's
			// execute phase (if any) — a re-execution keeps the backend's
			// plan-file record in sync; the inline plan object still wins.
			...(conversation.planPath ? { planFile: conversation.planPath } : {}),
			// Phase 218: the plan doc streamed to disk during the plan
			// phase — the execute phase skips its approval-time rewrite
			// (a rewrite would wipe checkboxes ticked while awaiting).
			// planFile wins on the backend when both are present.
			...(conversation.planDocPath ? { planDocPath: conversation.planDocPath } : {}),
			// Phase 147: the editor's opened folder (same semantics as the
			// chat request's workspaceRoot). Phase 177: conversation-bound
			// folder wins (Agent Window).
			workspaceRoot: this.conversationWorkspaceRoot(conversation),
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
		// Phase 222: the awaiting hold is retired — a live awaiting state
		// only exists in the card-to-done window; clearing is defensive.
		state.turnState = undefined;
		// Phase 219: the doc editor's approval widget folds with the bar.
		this.disposePlanApprovalWidget(state);
		// Fold the bar/card to its cancelled state (actions removed, note).
		this.foldPlanAwaitingToCancelled(state.planCardRoot);
		this.finishStreaming(conversation, state.requestId);
	}

	/** Phase 71: the execute phase kicked off — the card becomes progress. */
	/**
	 * Phase 231: the container the CURRENT plan step's activity appends
	 * into — the active step group's steps container during plan execution
	 * (narration, Thought blocks, tool cards, steers, approval gates all
	 * land inside their step's group), the Worked shell's steps otherwise.
	 * Undefined with no shell yet (the row stays the fallback — unchanged
	 * for ask/agent turns, which never open a group).
	 */
	private planActivityRoot(state: VibeAIStreamState): HTMLElement | undefined {
		return state.planStepGroup?.steps ?? state.workSteps;
	}

	/**
	 * Phase 231: settles an active step group at a turn boundary — the
	 * spinner would freeze mid-run otherwise. plan_done / finishStreaming
	 * (interrupt, transport death) call this: the icon drops to the
	 * cancelled mark, the duration freezes into the meta span. No fold —
	 * the shell's own settle covers the collapse; the group keeps its
	 * activity for re-expansion.
	 */
	private settleActivePlanStepGroup(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		const group = state?.planStepGroup;
		if (!state || !group) {
			return;
		}
		state.planStepGroup = undefined;
		group.icon.className = 'codicon vibe-ai-plan-step-group-icon codicon-circle-slash';
		group.meta.textContent = localize('vibeAIChat.worked', "Worked for {0}", getDurationString(Date.now() - group.startedAt));
	}

	private handlePlanStart(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const row = state?.currentAssistantRow;
		if (!state || !row) {
			return;
		}
		state.planPhase = 'executing';
		// Phase 219: defensive — an approval widget still up when execution
		// begins folds with the card swap (no approval picks mid-execution).
		this.disposePlanApprovalWidget(state);
		// Phase 157: capture the persisted plan file (Cursor plan-as-file
		// parity) — the conversation keeps carrying it as planFile so
		// later agent turns work off the settled plan (restore parity via
		// the session store's setPlanPath).
		if (data.planPath) {
			conversation.planPath = data.planPath;
			this.sessionStore.setPlanPath(conversation.sessionId, data.planPath);
		}
		// Phase 213: capture the plan doc (PLAN.md at the project root,
		// Cursor-parity plan-as-doc) — the plan card links to it.
		// Phase 232: persist it (like the agreed plan file) so a restored
		// tab keeps ticking progress on the SAME doc after a restart.
		if (data.planDocPath) {
			conversation.planDocPath = data.planDocPath;
			this.sessionStore.setPlanDocPath(conversation.sessionId, data.planDocPath);
		}
		// Phase 215: re-open the Worked shell the research settle folded —
		// the steps' tool cards keep appending into it. Fresh "Working…"
		// label (textContent assignment also drops the research settle's
		// counts suffix); the frozen duration clears so the plan_done
		// settle covers the whole turn (research + execution).
		if (state.workShell && state.workLabel) {
			state.workFoldedMs = undefined;
			state.workLabel.textContent = localize('vibeAIChat.working', "Working…");
			state.workShell.open = true;
		}
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
		// Phase 215: fold the previous step's open tool cards — each step's
		// activity collapses when the next begins (a failed step's cards
		// stay open through its own run for debugging; its row keeps the
		// error mark).
		this.foldOpenToolCards(conversation);
		// Phase 231: the step's activity collects in its own collapsible
		// group inside the Worked shell — plan_step_done folds the whole
		// step to its summary row ("Step N — title · Worked for Xs ·
		// counts"). The shell may not exist yet (the fresh execute turn's
		// first step) — create it; the eager thinking run and the plan card
		// move inside ahead of the group, arrival order kept.
		this.ensureWorkShell(conversation);
		if (state.workSteps) {
			const root = DOM.append(state.workSteps, $('details.vibe-ai-plan-step-group')) as HTMLDetailsElement;
			root.open = true;
			root.classList.add('running');
			const summary = DOM.append(root, $('summary'));
			const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-plan-step-group-chevron'));
			chevron.setAttribute('aria-hidden', 'true');
			// Phase 235：補 codicon-modifier-spin——1.142 基底 codicon CSS 只給
			// 「.codicon-loading.codicon-modifier-spin」配對動畫，裸 codicon-loading
			// 是靜態弧線（plan 卡步驟圈圈從未轉過的根因）；1.145 同步雖補了裸規則，
			// 配對寫法對新舊兩代 CSS 都成立
			const icon = DOM.append(summary, $('span.codicon.codicon-loading.codicon-modifier-spin.vibe-ai-plan-step-group-icon'));
			icon.setAttribute('aria-hidden', 'true');
			const label = DOM.append(summary, $('span.vibe-ai-plan-step-group-label'));
			label.textContent = localize('vibeAIChat.planStepGroupLabel', "Step {0} — {1}", step.step, step.title ?? '');
			const meta = DOM.append(summary, $('span.vibe-ai-plan-step-group-meta'));
			const steps = DOM.append(root, $('.vibe-ai-plan-step-group-steps'));
			state.planStepGroup = { root, steps, icon, label, meta, stepId: step.step, startedAt: Date.now() };
		}
		const row = state.planStepRows?.get(step.step);
		if (row) {
			row.classList.add('running');
			const icon = row.querySelector('.vibe-ai-plan-step-icon');
			if (icon) {
				icon.className = 'codicon codicon-loading codicon-modifier-spin vibe-ai-plan-step-icon';
			}
		}
		// Phase 224: the plan doc's To-dos block mirrors the running state.
		const todoRow = conversation.planTodos?.rows.get(step.step);
		if (todoRow) {
			todoRow.classList.add('running');
			const todoIcon = todoRow.querySelector('.vibe-ai-plan-todos-icon');
			if (todoIcon) {
				todoIcon.className = 'codicon codicon-loading codicon-modifier-spin vibe-ai-plan-todos-icon';
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
		// Phase 224: the plan doc's To-dos block mirrors the final state.
		const todoRow = conversation.planTodos?.rows.get(step.step);
		if (todoRow) {
			todoRow.classList.remove('running');
			todoRow.classList.toggle('failed', failed);
			const todoIcon = todoRow.querySelector('.vibe-ai-plan-todos-icon');
			if (todoIcon) {
				todoIcon.className = `codicon vibe-ai-plan-todos-icon ${failed ? 'codicon-error' : 'codicon-check'}`;
			}
		}
		if (step.total !== undefined) {
			this.updatePlanProgress(conversation, undefined, step.total);
		}
		// Phase 231: the step's activity group settles — a clean step folds
		// to its summary row ("Step N — title · Worked for Xs · Read N
		// files"); a failed step's group stays OPEN (收合不藏答案 — the
		// failed run's cards keep their error state visible until the next
		// step_start folds the cards).
		const group = state.planStepGroup;
		if (group && group.stepId === step.step) {
			state.planStepGroup = undefined;
			group.root.classList.remove('running');
			group.root.classList.toggle('failed', failed);
			group.icon.className = `codicon vibe-ai-plan-step-group-icon ${failed ? 'codicon-error' : 'codicon-check'}`;
			group.meta.textContent = localize('vibeAIChat.worked', "Worked for {0}", getDurationString(Date.now() - group.startedAt));
			this.appendWorkedCountsSuffix(group.meta, group.steps, state.toolCards);
			if (!failed) {
				// The fold is a scroll event (Phase 172's rule) — preserve
				// the thread anchor across the collapse.
				this.preserveScrollAcrossFold(conversation, group.root, group.steps, () => {
					group.root.open = false;
				});
			}
		}
		if (!failed) {
			// Phase 215: a clean step folds its open tool cards (ask/agent
			// parity — activity folds at completion); a failed step keeps
			// them open for debugging, the next step_start folds them.
			this.foldOpenToolCards(conversation);
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
		// Phase 157: defensive planPath capture — plan_start already set it;
		// a pane reload mid-execution would re-enter here without it.
		if (data.planPath && !conversation.planPath) {
			conversation.planPath = data.planPath;
			this.sessionStore.setPlanPath(conversation.sessionId, data.planPath);
		}
		// Phase 232: defensive planDocPath capture (same rationale) — the
		// execute phase ticks progress on this doc, so a restored/reloaded
		// pane must not lose it.
		if (data.planDocPath && !conversation.planDocPath) {
			conversation.planDocPath = data.planDocPath;
			this.sessionStore.setPlanDocPath(conversation.sessionId, data.planDocPath);
		}
		state.planResults = summary
			? { stepsDone: [...summary.stepsDone], stepsFailed: [...summary.stepsFailed] }
			: { stepsDone: [], stepsFailed: [] };
		if (summary && state.planCardRoot && state.pendingPlan) {
			this.applyPlanResults(state.planCardRoot, state.pendingPlan, state.planResults);
		}
		this.updatePlanProgress(conversation, summary?.stepsDone.length, summary?.steps ?? 0);
		// Phase 249: execute mode has no goal_complete emission (the agent
		// loop's stop gate only runs the agent path) — a plan that finished
		// with zero failed steps IS this turn's goal-completion signal:
		// flip the goal banner here (handleGoalComplete guards the no-goal
		// case; idempotent with the agent-path framework event).
		if (summary && summary.stepsFailed.length === 0 && summary.stepsDone.length > 0) {
			this.handleGoalComplete(conversation);
		}
		// Phase 231: defensive — the last step_done normally cleared the
		// group; an anomaly path that lands here with one active settles it
		// before the shell folds (no frozen spinner on re-expansion).
		this.settleActivePlanStepGroup(conversation);
		// Phase 215: execution finished — fold the open tool cards and
		// settle the Worked shell. Phase 236: the settle is plan-specific —
		// the shell stays OPEN with the summary row removed (the plan card
		// plus per-step groups ARE the completed look; the ask/agent
		// collapse-to-one-row no longer applies, user ruling).
		this.foldOpenToolCards(conversation);
		this.settlePlanWorkShell(conversation);
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 241 (living plan, Cursor 邊走邊改 parity): the executor called
	 * update_plan mid-run — the remaining steps were revised (settled
	 * steps are a contiguous prefix, ids/titles intact). Syncs three
	 * surfaces: the Worked timeline gets a slim revision row at shell top
	 * level (the step group's fold never hides it), the plan card's step
	 * list grows/shrinks in place (settled rows keep their check icons,
	 * new steps render pending until their plan_step_start), and the plan
	 * doc's To-dos block gains/loses the matching rows. The doc's checkbox
	 * lines are rewritten by the backend; the doc pane re-renders from the
	 * file on its own (onDidChangeContent).
	 */
	private handlePlanRevision(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const revision = data.planRevision;
		if (!state || !revision || revision.steps.length === 0) {
			return;
		}
		// The pending plan the card re-renders / plan_done roll-up reads —
		// swapped to the revised list (summary carried over).
		if (state.pendingPlan) {
			state.pendingPlan = { summary: state.pendingPlan.summary, steps: revision.steps };
		}
		this.ensureWorkShell(conversation);
		if (state.workSteps) {
			const row = DOM.append(state.workSteps, $('.vibe-ai-plan-revision'));
			const icon = DOM.append(row, $('span.codicon.codicon-sync.vibe-ai-plan-revision-icon'));
			icon.setAttribute('aria-hidden', 'true');
			const label = DOM.append(row, $('span.vibe-ai-plan-revision-label'));
			label.textContent = revision.reason
				? localize('vibeAIChat.planRevisionReason', "Plan revised: {0} ({1} steps)", revision.reason, revision.steps.length)
				: localize('vibeAIChat.planRevision', "Plan revised ({0} steps)", revision.steps.length);
		}
		// Plan card: grow/shrink the step list in place — existing rows keep
		// their live state (the running step's spinner, settled checks);
		// rows for dropped ids go, rows for new ids render pending.
		const stepsRoot = state.planCardRoot?.querySelector<HTMLElement>('.vibe-ai-plan-steps');
		if (stepsRoot && state.planStepRows) {
			const keep = new Set(revision.steps.map(step => step.id));
			for (const [id, row] of Array.from(state.planStepRows)) {
				if (!keep.has(id)) {
					row.remove();
					state.planStepRows.delete(id);
				}
			}
			for (const step of revision.steps) {
				if (state.planStepRows.has(step.id)) {
					continue;
				}
				const stepRow = DOM.append(stepsRoot, $('.vibe-ai-plan-step'));
				stepRow.dataset['step'] = String(step.id);
				const stepIcon = DOM.append(stepRow, $('span.codicon.vibe-ai-plan-step-icon'));
				stepIcon.setAttribute('aria-hidden', 'true');
				const stepTitle = DOM.append(stepRow, $('span.vibe-ai-plan-step-title'));
				stepTitle.textContent = step.title;
				stepIcon.classList.add('codicon-circle-large-outline');
				state.planStepRows.set(step.id, stepRow);
			}
		}
		// Plan doc's To-dos block: same grow/shrink (appended rows render
		// pending; their plan_step_start ticks them like mounted ones).
		const todos = conversation.planTodos;
		if (todos) {
			const todoKeep = new Set(revision.steps.map(step => step.id));
			for (const [id, row] of Array.from(todos.rows)) {
				if (!todoKeep.has(id)) {
					row.remove();
					todos.rows.delete(id);
				}
			}
			for (const step of revision.steps) {
				if (todos.rows.has(step.id)) {
					continue;
				}
				const todoRow = DOM.append(todos.list, $('.vibe-ai-plan-todos-item'));
				todoRow.dataset['step'] = String(step.id);
				const todoIcon = DOM.append(todoRow, $('span.codicon.vibe-ai-plan-todos-icon'));
				todoIcon.setAttribute('aria-hidden', 'true');
				todoIcon.classList.add('codicon-circle-large-outline');
				const todoLabel = DOM.append(todoRow, $('span.vibe-ai-plan-todos-label'));
				todoLabel.textContent = step.title;
				todos.rows.set(step.id, todoRow);
			}
		}
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 215: folds every open tool card inside the Worked shell —
	 * mutating cards keep their body after completion (Phase 148), but at
	 * plan step boundaries the bodies are noise (ask/agent turns fold the
	 * same cards at the same moments, Phase 140/141). A card's own
	 * chevron/header re-opens it.
	 */
	private foldOpenToolCards(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state?.workSteps) {
			return;
		}
		for (const card of Array.from(state.workSteps.querySelectorAll('details.vibe-ai-tool-card[open]'))) {
			(card as HTMLDetailsElement).open = false;
		}
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
	 * the agent works; Phase 84.9/89: the shell never folds mid-turn —
	 * intermediate narrations keep it open and stream below it, and the
	 * final answer folds it only on the backend's explicit round_end
	 * final marker (84.11's length-based mid-run fold and its reopen
	 * dance here are removed — a folded shell can no longer meet live
	 * tool activity).
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
			// Phase 251: the card's diff preview renders in an embedded
			// DiffEditorWidget (real editor colors, theme diff colors).
			(container, original, updated, filePath, firstChangeLine, onBuildFailure) =>
				this.instantiationService.createInstance(VibeAIEmbeddedDiff, container, original, updated, filePath, firstChangeLine, onBuildFailure),
		);
		state.toolCards.set(id, card);
		// Phase 149: the call id rides the element so the Worked grouping
		// can find the card (the restore path mirrors this with the
		// persisted record's id).
		card.element.dataset.vibeToolId = id;
		// Phase 61: ONE Worked block per turn — the FIRST tool call creates
		// the turn-scoped shell and moves the already-rendered activity
		// (thinking blocks, narration bodies) inside; every card appends
		// into its steps container. Consecutive tool events keep appending.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			// Phase 84.9/89: no reopen dance — the shell never folds
			// mid-turn (intermediate narrations keep it open; the final
			// answer folds it on the backend's round_end final marker,
			// after which no tool event can arrive), so resuming tool
			// activity always finds it already expanded.
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.toolsRunToolIds.push(id);
		state.workAnyTool = true;
		// Phase 231: an active plan step's cards append into that step's
		// group container (planActivityRoot).
		this.planActivityRoot(state)?.appendChild(card.element);
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
		// Phase 98: failed reads / failed commands (and any other failed
		// operation) leave the Worked section entirely — the pending card
		// disappears instead of an error card squatting in the list (user
		// request: failed steps take up space for nothing). Display-only:
		// the backend still feeds the error to the model (reflection loop).
		// The id also drops from the run's tool ids so the persisted
		// timeline never references the removed card.
		if (data.tool?.status === 'error') {
			const card = state.toolCards.get(id);
			// Phase 231: consolidate within the card's OWN container (a step
			// group during plan execution) — the shell-level sweep misses
			// group-internal adjacency.
			const thoughtParent = card?.element.parentElement ?? state.workSteps;
			card?.dispose();
			card?.element.remove();
			state.toolCards.delete(id);
			state.toolsRunToolIds = state.toolsRunToolIds.filter(toolId => toolId !== id);
			// Phase 162: the removed card may have sat between two Thought
			// rows — newly adjacent settled blocks merge (the regroup rule).
			if (thoughtParent) {
				this.consolidateThoughtBlocks(thoughtParent);
			}
		} else {
			state.toolCards.get(id)?.setResult(data.tool?.status, data.tool?.result, data.tool?.codeChange, data.tool?.output, data.tool?.read);
			// Phase 137: needs-console commands (interactive REPLs, dev
			// servers, ssh…) can't run in the sandboxed executor — the
			// backend handed them off: run in the editor's integrated
			// terminal (visible + interactive, Cursor parity).
			if (data.tool?.name === 'run_terminal' && data.tool?.editorTerminal) {
				void this.runInEditorTerminal(this.terminalCommandFromArgs(data.tool?.arguments));
			}
			// Phase 149: a completed read-only step may merge into the
			// same-file row or fold into a count group (mutating cards
			// never participate; the shell regroups only here, never on
			// tool start — pending cards do not move while streaming).
			if (data.tool?.name && !isMutatingTool(data.tool.name)) {
				this.regroupWorkedSteps(conversation);
			}
		}
		if (data.tool?.codeChange) {
			// Phase 59: the turn keeps only the FINAL result per file — a
			// second write (or delete) to an already-tracked file updates
			// its entry instead of adding a duplicate row to the files
			// summary (see consolidateChanges).
			const change = data.tool.codeChange;
			state.turnChanges = consolidateChanges([...state.turnChanges, change]);
			// Phase 57: highlight the modified places in the open editor with
			// the chat diff card's colors (Cursor editor overlay parity).
			// Phase 110: the highlight ACCUMULATES the turn's writes — the
			// consolidated entry diffs the pre-turn baseline against the
			// current content, so a second write to a file created this turn
			// keeps the first write's lines green (registering the per-step
			// change alone dropped them — the editor only ever showed the
			// last write's diff). Adds cancel against later deletes the
			// same way, so the overlay is the turn's net change.
			const accumulated = state.turnChanges.find(entry => entry.filePath === change.filePath);
			this.editorHighlighter?.highlight(accumulated ?? change, path => this.resolveWorkspacePath(path));
			// Phase 159: the backend touched a file — sweep the IDE's fresh
			// markers for it (debounced, LSP needs a moment to recompute) and
			// push them to the running turn; deletes leave nothing to diagnose.
			this.scheduleDiagnosticsSweep(conversation, change);
		}
		if (state.pendingWriteCardId === id) {
			state.pendingWriteCardId = undefined;
		}
		// Phase 61: the shell's compact mode always shows the latest step —
		// chase the bottom.
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 137: the raw command argument of a run_terminal hand-off —
	 * tolerant to the parsed object (the tool_result event normally
	 * carries the parsed arguments) and the raw JSON string.
	 */
	private terminalCommandFromArgs(args: unknown): string {
		if (!args) {
			return '';
		}
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch {
				return '';
			}
		}
		if (args && typeof args === 'object' && 'command' in args) {
			return String((args as Record<string, unknown>)['command'] ?? '');
		}
		return '';
	}

	/**
	 * Phase 137: runs a handed-off command in the editor's integrated
	 * terminal — the focused terminal when it's alive (Cursor parity:
	 * commands run in the current terminal), otherwise a new one rooted
	 * at the workspace folder (createAndFocusTerminal reveals the panel).
	 * The live process is visible and interactive there; the chat card
	 * only shows the hand-off note.
	 */
	private async runInEditorTerminal(command: string): Promise<void> {
		if (!command) {
			return;
		}
		try {
			let instance = this.terminalService.activeInstance;
			if (!instance || instance.exitCode !== undefined) {
				// Phase 177: the terminal follows the active conversation's
				// project folder (Agent Window parity — the window itself
				// has no folder); falls back to the window's folder.
				const rootPath = this.activeWorkspaceRoot();
				const cwd = rootPath ? URI.file(rootPath) : this.workspaceContextService.getWorkspace().folders[0]?.uri;
				instance = await this.terminalService.createAndFocusTerminal({ cwd });
			} else {
				instance.focus();
			}
			await instance.sendText(command, true);
		} catch (e) {
			this.logService.error('vibeAI: failed to run command in the editor terminal', e);
		}
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

	// ==================== Phase 113: Steer (Cursor's "send now") ====================

	/**
	 * Phase 113: sends the queued steer for the running Agent turn
	 * (`steer()` → `POST /api/chat/agent/steer`, session id = the
	 * conversation's store session). Success: the input text is already
	 * cleared — the `steered` event echoes the injection and renders the
	 * bubble. Failure (404 — the turn finished between the send() check
	 * and this call, or a network error): the text is restored so nothing
	 * is lost and an error note explains how to send it.
	 */
	private steerActiveTurn(conversation: VibeAIConversation, text: string): void {
		const state = conversation.stream;
		// Track the sent steer until its echo removes it — if the turn
		// ends without a done event's pending_steer (interrupt / abort),
		// the not-yet-injected text is preserved at finish instead of
		// vanishing with the aborted stream.
		state?.inflightSteers.push(text);
		void this.vibeAIService.steer(conversation.sessionId, text).then(steered => {
			if (steered) {
				return;
			}
			// Not delivered — drop the tracking entry and restore the
			// input (only when still empty; the user may have typed on).
			const index = state?.inflightSteers.indexOf(text) ?? -1;
			if (index >= 0 && state) {
				state.inflightSteers.splice(index, 1);
			}
			if (this.inputElement && (this.inputElement.value.trim().length ?? 0) === 0) {
				this.inputElement.value = text;
				this.autoGrowInput();
				this.updateInputActions();
			}
			this.showError(localize(
				'vibeAIChat.steerUnavailable',
				"Steer not delivered — the turn already finished; press Enter to send as a new message"
			), conversation);
		});
	}

	// ===== Phase 159: IDE diagnostics feedback (Cursor lint-feedback parity) =====

	/** Per-conversation sweep debounce timers (sessionId → timer). */
	private diagnosticsSweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Per-conversation changed paths accumulated since the last sweep. */
	private diagnosticsPendingPaths = new Map<string, Set<string>>();

	/**
	 * Phase 159: the backend just wrote/edited a file — schedule a
	 * diagnostics sweep for it. The LSP recomputes only after the file
	 * watcher reloads the model, so the sweep is debounced (1.2s, reset on
	 * every new change); paths accumulate so a burst of writes sweeps once
	 * with the whole batch.
	 */
	private scheduleDiagnosticsSweep(conversation: VibeAIConversation, change: IVibeAICodeChange): void {
		if (change.action === 'delete' || !change.filePath) {
			return;
		}
		let pending = this.diagnosticsPendingPaths.get(conversation.sessionId);
		if (!pending) {
			pending = new Set<string>();
			this.diagnosticsPendingPaths.set(conversation.sessionId, pending);
		}
		pending.add(change.filePath);
		const existing = this.diagnosticsSweepTimers.get(conversation.sessionId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.diagnosticsSweepTimers.delete(conversation.sessionId);
			this.sweepDiagnostics(conversation);
		}, 1200);
		this.diagnosticsSweepTimers.set(conversation.sessionId, timer);
	}

	/**
	 * Phase 159: collect the IDE's markers (errors/warnings only) for the
	 * files the agent just changed and push them to the running turn — the
	 * backend injects them as a user message at the next tool boundary
	 * (<ide_diagnostics> block, Cursor lint-feedback parity). Fire-and-
	 * forget: a finished turn's registry is already closed, so the push
	 * lands queued 0 and resolves false silently. No findings → no push.
	 */
	private sweepDiagnostics(conversation: VibeAIConversation): void {
		const sessionId = conversation.sessionId;
		const paths = [...(this.diagnosticsPendingPaths.get(sessionId) ?? [])];
		this.diagnosticsPendingPaths.delete(sessionId);
		if (!paths.length) {
			return;
		}
		const diagnostics: IVibeAIDiagnostic[] = [];
		for (const path of paths) {
			const uri = this.resolveWorkspacePath(path);
			if (!uri) {
				continue;
			}
			let count = 0;
			for (const marker of this.markerService.read({ resource: uri })) {
				if (count >= 8) {
					break;
				}
				if (marker.severity !== MarkerSeverity.Error && marker.severity !== MarkerSeverity.Warning) {
					continue;
				}
				diagnostics.push({
					path,
					severity: marker.severity === MarkerSeverity.Error ? 'error' : 'warning',
					message: marker.message.slice(0, 200),
					line: marker.startLineNumber,
					source: marker.owner,
				});
				count++;
			}
		}
		if (!diagnostics.length) {
			return;
		}
		void this.vibeAIService.pushDiagnostics(sessionId, diagnostics);
	}

	/**
	 * Phase 113: the backend injected a queued steer (role=user) at the
	 * next tool boundary — the `steered` event confirms it. Mirrors the
	 * approval card's shell bootstrap: the steer is a workflow step like
	 * any tool call, so it renders INSIDE the Working timeline's steps
	 * container (a turn whose first activity is an injected steer still
	 * gets its Worked shell). The message also joins the conversation's
	 * history (steered marker) — the next turn's request carries it, the
	 * backend's own copy was consumed at injection, and the restored
	 * thread keeps the bubble.
	 */
	private handleSteered(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const content = data.steered ?? '';
		if (!state || !state.currentAssistantRow || content.length === 0) {
			return;
		}
		// The same shell bootstrap as handleToolStart / handleApprovalRequest.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			// Phase 84.9/89: no reopen dance — the shell never folds mid-turn.
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.workAnyTool = true;
		// The steer joins the history at injection (the backend consumed
		// its queue entry; role=user mirrors the injected message). The
		// steered marker keeps the turn↔user-turn alignment intact (steers
		// are never dispatched user turns).
		conversation.history.push({ role: 'user', content, steered: true });
		// Phase 248: the injected steer grew the running turn's context —
		// the ring follows (throttled with the other live events).
		this.scheduleLiveContextRefresh(conversation);
		// The echo confirms delivery — remove the tracking entry.
		const index = state.inflightSteers.indexOf(content);
		if (index >= 0) {
			state.inflightSteers.splice(index, 1);
		}
		state.steeredMessages.push(content);
		// The Steered bubble inside the Working timeline (arrival order =
		// workflow order). NOT a .vibe-ai-turn-user row — the truncate /
		// turn-record alignment maps those 1:1 onto dispatched turns.
		// Phase 231: a steer injected mid-step lands in that step's group.
		const row = DOM.append(this.planActivityRoot(state) ?? state.currentAssistantRow, $('.vibe-ai-turn-steered'));
		const meta = DOM.append(row, $('.vibe-ai-steered-meta'));
		const icon = DOM.append(meta, $('span.codicon.codicon-arrow-swap.vibe-ai-steered-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(meta, $('span'));
		label.textContent = localize('vibeAIChat.steeredLabel', "Steered");
		const bubble = DOM.append(row, $('.vibe-ai-steered-bubble'));
		bubble.textContent = content;
		// The user's own message — jump to the bottom (renderUserTurn parity).
		this.scrollBottom(conversation, true);
	}

	/**
	 * Phase 249: the framework's stop gate detected unfinished work at the
	 * model's natural stop (no tool calls — 無完成工具派，Cursor stop-hook
	 * followup parity) and injected a backend-internal continuation seed —
	 * the turn keeps running. The note joins the Working timeline (or the
	 * active plan step's group), reusing the steered-note look (a system
	 * annotation, not a dispatched user turn): no history push, no steer
	 * bookkeeping — the seed never belonged to the user.
	 */
	private handleAutoContinue(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		const detail = data.autoContinue;
		if (!state || !state.currentAssistantRow || !detail) {
			return;
		}
		// The same shell bootstrap as handleSteered — the note lands in the
		// Working timeline; the loop reopens tool runs right after.
		if (state.lastBlockKind !== 'tools') {
			this.ensureWorkShell(conversation);
			this.closeRunsBefore(conversation, 'tools');
			this.openToolsRun(conversation);
			state.lastBlockKind = 'tools';
		}
		state.workAnyTool = true;
		const row = DOM.append(this.planActivityRoot(state) ?? state.currentAssistantRow, $('.vibe-ai-turn-steered'));
		const meta = DOM.append(row, $('.vibe-ai-steered-meta'));
		const icon = DOM.append(meta, $('span.codicon.codicon-refresh.vibe-ai-steered-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(meta, $('span'));
		label.textContent = localize('vibeAIChat.autoContinueLabel', "Auto-continue ({0}/{1})", detail.count, detail.max);
		const bubble = DOM.append(row, $('.vibe-ai-steered-bubble'));
		bubble.textContent = detail.detail
			|| localize('vibeAIChat.autoContinueGeneric', "Unfinished work detected — continuing automatically");
		this.scrollBottom(conversation, true);
	}

	// ==================== Phase 114: Queue (Cursor's queue auto-resume) ====================

	/**
	 * Phase 114: queues the input text for the running Agent turn
	 * (Shift+Enter — Cursor's "queue"). The text joins the conversation's
	 * queue (FIFO, the badge shows the count) and mirrors into the
	 * backend's queue gate (`steer(mode=queue)`) so the turn's done event
	 * reports it as pending_queue. Cap: 5 queued messages — beyond that
	 * the send is REJECTED with an error note and the text stays in the
	 * input (the user keeps their words). The local queue is the
	 * auto-resume source of truth: a mirror POST that lost the race (the
	 * turn ended first) or failed silently only misses its backend copy.
	 */
	private queueForActiveTurn(conversation: VibeAIConversation): void {
		const text = this.inputElement?.value.trim() ?? '';
		if (text.length === 0) {
			return;
		}
		if (conversation.steerQueue.length >= VIBE_AI_QUEUE_MAX) {
			this.showError(localize(
				'vibeAIChat.queueFull',
				"Queue is full ({0} messages max) — wait for the turn to finish, then send",
				VIBE_AI_QUEUE_MAX
			), conversation);
			return;
		}
		if (!this.inputElement) {
			return;
		}
		conversation.steerQueue.push(text);
		// Same composer cleanup as the steer branch of send().
		this.inputElement.value = '';
		this.autoGrowInput();
		this.updateInputActions();
		this.closeSkillMenu();
		this.skillListLoaded = false;
		this.toggleContextPanel(false);
		// Mirror into the backend's queue gate (mode=queue — never
		// injected mid-turn; the done event reports it as pending_queue).
		// Failure is silent: the local queue above is authoritative.
		void this.vibeAIService.steer(conversation.sessionId, text, 'queue');
	}

	/**
	 * Phase 114: the queue's auto-resume — the first queued message opens
	 * a NEW agent turn on the same conversation and session (Cursor
	 * parity: queued messages send when the turn finishes); the rest stay
	 * queued (the badge counts down) and resume one per turn end until
	 * the queue empties. Same dispatch path as send() / the Continue chip
	 * (history push + renderUserTurn + dispatchTurn — the request carries
	 * the conversation's session id, so the new turn opens its own
	 * steer/queue gate). Guards mirror the Continue chip: the active
	 * conversation only (dispatchTurn reads the active mirrors) and no
	 * running turn — an interrupt's newer turn keeps the queue for its
	 * own end; a background tab's queue resumes on activation
	 * (setActiveConversation).
	 */
	private resumeSteerQueue(conversation: VibeAIConversation): void {
		if (conversation.id !== this.activeConversationId) {
			return;
		}
		if (conversation.stream || conversation.steerQueue.length === 0) {
			return;
		}
		// No usable model → the turn would fail fast (dispatchTurn's
		// no-model gate); gate here instead so the queue doesn't drain
		// itself one message per failing turn. The badge keeps the count;
		// the queue resumes at the next turn end / activation.
		const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		const autoPool = this.model === 'Auto' ? this.buildAutoPool() : undefined;
		if (!this.hasUsableModel(configured, provider, autoPool)) {
			this.showError(VIBE_AI_NO_MODEL_MESSAGE, conversation);
			return;
		}
		const next = conversation.steerQueue.shift() ?? '';
		if (next.length === 0) {
			this.updateInputActions();
			return;
		}
		this.history.push({ role: 'user', content: next });
		const userRow = this.renderUserTurn(conversation, next, undefined);
		this.dispatchTurn(conversation, next, userRow);
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
	 * out the answer/tool arguments). Surface a truncation note with a
	 * Continue chip (Phase 201, styled like the limit-reached chip)
	 * instead of a silent "(no response)". Phase 200 makes the backend
	 * auto-continue truncated rounds first — this note now means the
	 * continuation budget is exhausted and the reply really needs help.
	 */
	private handleOutputTruncated(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		// Remember for the turn record (persisted — restore parity below).
		state.outputTruncated = true;
		// Note + chip below the in-flight answer; an empty answer says it
		// in the finish placeholder (with the chip) instead (no duplicate).
		if (state.turn.text.length > 0 && state.currentAssistantRow) {
			this.appendOutputTruncatedNote(conversation, state.currentAssistantRow);
			this.scrollBottom(conversation);
		}
	}

	/**
	 * Phase 201: the truncation note + Continue chip — Phase 202 styles it
	 * exactly like the Phase 193 error card (same shape, rounded border,
	 * warning icon, action pill on the right) but in the warning yellow:
	 * the reply was cut, not an error. The chip lives on the turn-record
	 * disposables — it stays functional across later turns and dies with
	 * the tab / thread rebuild.
	 */
	private appendOutputTruncatedNote(conversation: VibeAIConversation, row: HTMLElement): void {
		const note = DOM.append(row, $('.vibe-ai-output-truncated-note'));
		const icon = DOM.append(note, $('span.codicon.codicon-warning.vibe-ai-truncated-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(note, $('span.vibe-ai-output-truncated-text'));
		label.textContent = localize(
			'vibeAIChat.outputTruncated',
			"Response truncated — the model hit its per-round output budget"
		);
		label.title = localize(
			'vibeAIChat.outputTruncatedTitle',
			"The backend already auto-continued this reply (up to LLM_AGENT_MAX_CONTINUATIONS attempts) and the budget is still exhausted. Continue keeps writing from here; raise backend LLM_AGENT_MAX_TOKENS for a bigger per-round budget."
		);
		this.appendTruncationChip(conversation, note);
	}

	/**
	 * Phase 201: the truncation Continue chip — Phase 202 renders it as
	 * the error card's Retry pill (same shape, yellow tint). Shared by the
	 * note and the empty-answer finish path (pill-only under the
	 * placeholder).
	 */
	private appendTruncationChip(conversation: VibeAIConversation, container: HTMLElement): void {
		const pill = DOM.append(container, $('span.vibe-ai-truncated-continue'));
		pill.setAttribute('role', 'button');
		pill.title = localize('vibeAIChat.truncationContinueTitle', "Continue the reply exactly from where it stopped");
		DOM.append(pill, $('span.codicon.codicon-refresh'));
		const pillLabel = DOM.append(pill, $('span'));
		pillLabel.textContent = localize('vibeAIChat.limitContinue', "Continue");
		// Same store as the limit-reached chip: the record store — the chip
		// must survive turn teardown and keep working after later turns.
		conversation.turnRecordDisposables.add(DOM.addDisposableListener(pill, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.continueAfterTruncation(conversation);
		}));
	}

	/**
	 * Phase 201: the truncation Continue — sends a follow-up that resumes
	 * the reply from where it stopped (same continuation contract as the
	 * backend's Phase 200 seed). Same dispatch path as send(): the
	 * follow-up rides the conversation history the model already sees.
	 */
	private continueAfterTruncation(conversation: VibeAIConversation): void {
		this.continueWithPrompt(conversation, localize(
			'vibeAIChat.truncationContinuePrompt',
			"Continue the previous reply exactly from where it stopped — do not repeat content you already produced; finish the remaining part."
		));
	}

	/**
	 * Phase 103: the agent loop exhausted its tool-call budget (all
	 * segments used) or its context window — the turn ends with the
	 * backend's forced summary. Render a note + Continue chip (Cursor
	 * parity loop continuation) at the assistant row end: the backend
	 * emits limit_reached AFTER the forced summary text, so the chip
	 * lands below the summary (Cursor-parity bottom-of-message spot);
	 * clicking it sends a follow-up that resumes the task from the
	 * progress gathered above.
	 */
	private handleLimitReached(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		// Remember for the turn record (persisted — restore parity below).
		state.limitReached = true;
		const row = state.currentAssistantRow;
		if (!row) {
			return;
		}
		this.appendLimitReachedNote(conversation, row, data.limitReached);
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 103: the limit-reached note + Continue chip. `detail` picks
	 * the label (context window vs tool-call budget vs loop detection,
	 * Phase 239) and carries the budget numbers the live chip displays
	 * ("used/total rounds · segments") so budget exhaustion is tellable
	 * from an early looping stop at a glance. The chip lives on
	 * the turn-record disposables — it stays functional across later
	 * turns (Cursor-parity: old Continue chips keep working) and dies
	 * with the tab / thread rebuild. Restored turns pass no detail and
	 * render the generic labels (the boolean flag is what's persisted).
	 */
	private appendLimitReachedNote(
		conversation: VibeAIConversation,
		row: HTMLElement,
		detail?: IVibeAIStreamData['limitReached']
	): void {
		const note = DOM.append(row, $('.vibe-ai-limit-reached-note'));
		const label = DOM.append(note, $('span.vibe-ai-limit-reached-text'));
		if (detail?.reason === 'context') {
			label.textContent = localize(
				'vibeAIChat.limitReachedContextBudget',
				"Context limit reached ({0} tool rounds across {1} segments) — the task may be incomplete",
				detail.rounds,
				detail.segments
			);
		} else if (detail?.reason === 'looping') {
			label.textContent = localize(
				'vibeAIChat.limitReachedLooping',
				"Agent looping detected — stopped early after {0} of {1} tool rounds to avoid wasting budget",
				detail.rounds,
				detail.budget ?? detail.rounds
			);
		} else if (detail?.reason === 'auto_continue') {
			// Phase 249: the stop gate's auto-continue budget/stall guard
			// ran out — the turn ends honestly with possible unfinished
			// work; the Continue chip stays the manual rescue path.
			label.textContent = localize(
				'vibeAIChat.limitReachedAutoContinue',
				"Auto-continue limit reached ({0}/{1}) — the task may be incomplete",
				detail.count ?? 0,
				detail.max ?? 0
			);
		} else if (detail?.budget) {
			label.textContent = localize(
				'vibeAIChat.limitReachedRoundsBudget',
				"Tool-call limit reached ({0}/{1} tool rounds across {2} segments) — the task may be incomplete",
				detail.rounds,
				detail.budget,
				detail.segments
			);
		} else {
			label.textContent = detail?.reason === 'context'
				? localize('vibeAIChat.limitReachedContext', "Context limit reached — the task may be incomplete")
				: localize('vibeAIChat.limitReachedRounds', "Tool-call limit reached — the task may be incomplete");
		}
		const button = DOM.append(note, $('button.vibe-ai-limit-continue')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('vibeAIChat.limitContinue', "Continue");
		button.title = localize('vibeAIChat.limitContinueTitle', "Send a follow-up that resumes the task from the progress above");
		// Same store choice as the truncation note's neighbors, but always
		// the record store: the chip must survive turn teardown (it renders
		// in the final DOM) and keep working after later turns start.
		conversation.turnRecordDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.continueAfterLimit(conversation);
		}));
	}

	/**
	 * Phase 103: the Continue chip — sends a follow-up that resumes the
	 * task from the progress recorded above (Cursor-parity Continue after
	 * a limit). Same dispatch path as send(): the follow-up rides the
	 * conversation history the model already sees, and the fresh agent
	 * loop picks up where the forced summary left off. Guards mirror the
	 * prompt-edit resend (active conversation only, no running turn).
	 */
	private continueAfterLimit(conversation: VibeAIConversation): void {
		this.continueWithPrompt(conversation, localize(
			'vibeAIChat.limitContinuePrompt',
			"Continue the task from the progress gathered above; complete the remaining work."
		));
	}

	/**
	 * Phase 201: the shared Continue dispatch behind both chips (limit-
	 * reached and output-truncated). Same dispatch path as send(): the
	 * follow-up rides the conversation history the model already sees,
	 * and a fresh agent loop picks up from the progress above. Guards
	 * mirror the prompt-edit resend (active conversation only, no running
	 * turn).
	 */
	private continueWithPrompt(conversation: VibeAIConversation, text: string): void {
		if (conversation.id !== this.activeConversationId) {
			// dispatchTurn reads the ACTIVE conversation's mirrors —
			// non-active chips stay inert (Cursor-parity focus behavior).
			return;
		}
		if (conversation.stream) {
			// A newer turn is already running — nothing to resume.
			return;
		}
		this.history.push({ role: 'user', content: text });
		const userRow = this.renderUserTurn(conversation, text, undefined);
		this.dispatchTurn(conversation, text, userRow);
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
		const ok = await this.vibeAIService.restoreFile(change.filePath, change.oldContent, this.activeWorkspaceRoot());
		if (ok) {
			// Phase 95: the restored file no longer shows a pending change —
			// its red/green overlay clears with the revert (the on-disk
			// content is the original again) and its keep-bar stays up in
			// the discarded state (buttons go, status chip).
			this.resolveChangeOverlays([change], 'discarded');
		}
		return ok;
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
					ok = await this.vibeAIService.deleteFile(change.filePath, this.activeWorkspaceRoot());
					if (ok) {
						// Phase 95: the deleted file's overlay clears with
						// the revert and its keep-bar stays up in the
						// discarded state.
						this.resolveChangeOverlays([change], 'discarded');
					}
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

	private renderUserTurn(conversation: VibeAIConversation, text: string, images?: string[], files?: IVibeAIFileContext[]): HTMLElement {
		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-user'));
		// Phase 61: sent images render as a thumbnail strip ABOVE the
		// bubble (the bubble stays text-only — the prompt-edit delegation
		// replaces its content with the edit composer, which is text-only).
		// Phase 184: file/folder chips join the same strip (unified above
		// the message, Cursor parity) and the strip re-renders from the
		// edited attachment set after a prompt-edit resend.
		this.renderUserAttachmentStrip(row, images, files);
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

	/**
	 * Phase 184: the sent message's attachment strip — image thumbnails +
	 * file/folder chips, unified above the bubble (Cursor parity: the
	 * message carries its attachments; thumbnails shrunk so the thread
	 * stays compact). Display-only: editing happens in the prompt edit
	 * box (chip ✕ there). Renders into the row's existing strip element
	 * when present (post-edit re-render), otherwise prepends a fresh one
	 * before the bubble.
	 */
	private renderUserAttachmentStrip(row: HTMLElement, images?: string[], files?: IVibeAIFileContext[], bubble?: HTMLElement): HTMLElement | undefined {
		const hasImages = !!images && images.length > 0;
		const hasFiles = !!files && files.length > 0;
		let strip = row.querySelector<HTMLElement>(':scope > .vibe-ai-user-attachments') ?? undefined;
		if (!hasImages && !hasFiles) {
			strip?.remove();
			return undefined;
		}
		if (!strip) {
			strip = $('.vibe-ai-user-attachments');
			if (bubble) {
				row.insertBefore(strip, bubble);
			} else {
				const first = row.firstElementChild;
				if (first && first.classList.contains('vibe-ai-user-bubble')) {
					row.insertBefore(strip, first);
				} else {
					row.prepend(strip);
				}
			}
		}
		DOM.clearNode(strip);
		for (const dataUrl of images ?? []) {
			const img = DOM.append(strip, $('img.vibe-ai-user-image')) as HTMLImageElement;
			img.src = dataUrl;
			img.alt = '';
		}
		for (const file of files ?? []) {
			const chip = DOM.append(strip, $('.vibe-ai-user-att-chip'));
			const icon = DOM.append(chip, $('span.codicon' + (file.kind === 'folder' ? '.codicon-symbol-folder' : '.codicon-symbol-file')));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(chip, $('span.vibe-ai-user-att-name'));
			name.textContent = file.path;
			name.title = file.path;
		}
		return strip;
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
		// Pane-lifetime document-capture reset — runs BEFORE any open edit's
		// outside-press cancel (both document-capture, this one registered
		// first): a fresh press clears the suppression, then the cancel
		// re-sets it when the press is outside the edit shell. The click of
		// that same gesture is therefore swallowed exactly once.
		this._register(DOM.addDisposableListener(this.messagesContainer.ownerDocument, 'pointerdown', () => {
			this.promptEditReopenSuppressed = false;
		}, true));
		this._register(DOM.addDisposableListener(this.messagesContainer, DOM.EventType.CLICK, e => {
			// The press that just closed an open edit must not re-open one
			// (Cursor parity: click-outside exits; a fresh click edits again).
			if (this.promptEditReopenSuppressed) {
				return;
			}
			const target = e.target as HTMLElement | null;
			// Phase 184: the attachment strip belongs to the message too —
			// clicking a sent chip/thumbnail opens the same edit box (the
			// image-only message's only target is its strip).
			const hit = target?.closest<HTMLElement>('.vibe-ai-user-bubble, .vibe-ai-user-attachments');
			if (!hit) {
				return;
			}
			// A text-selection drag (the pointer moved while selecting) is
			// not an edit click — keep the selection.
			if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) {
				return;
			}
			const row = hit.closest<HTMLElement>('.vibe-ai-turn-user');
			const bubble = row?.querySelector<HTMLElement>(':scope > .vibe-ai-user-bubble');
			if (!row || !bubble) {
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
	 * Phase 184: the history user message a thread's user-turn row maps
	 * to — the turnIndex'th dispatched (non-steered) user message, the
	 * same counting {@link truncateFromUserTurn} uses for the history cut.
	 * The prompt edit seeds its attachment set from it.
	 */
	private userTurnMessage(conversation: VibeAIConversation, userRow: HTMLElement): IVibeAIMessage | undefined {
		const userRows = Array.from(conversation.container.querySelectorAll('.vibe-ai-turn-user'));
		const turnIndex = userRows.indexOf(userRow);
		if (turnIndex === -1) {
			return undefined;
		}
		let seen = -1;
		for (const message of conversation.history) {
			if (message.role === 'user' && !message.steered) {
				seen++;
				if (seen === turnIndex) {
					return message;
				}
			}
		}
		return undefined;
	}

	/**
	 * Phase 218: the assistant reply text following the k-th dispatched
	 * (non-steered) user message — the plain pair a backfilled placeholder
	 * turn record carries when a session's stored turns are missing (the
	 * size guard's stripping / an alignment-broken save). Steered messages
	 * in between ride the same turn (they were injected mid-turn).
	 */
	private assistantTextAfterUserMessage(messages: IVibeAIMessage[], userOrdinal: number): string {
		let seen = -1;
		const parts: string[] = [];
		for (const message of messages) {
			if (message.role === 'user' && !message.steered) {
				seen++;
				continue;
			}
			if (seen === userOrdinal && message.role === 'assistant') {
				parts.push(message.content);
			}
		}
		return parts.join('\n\n');
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
		// Phase 184: the edit box is a full composer — same drop veil as
		// the main input (toggled by the shell's dragover class below).
		const dropOverlay = DOM.append(shell, $('.vibe-ai-drop-overlay'));
		const dropOverlayIcon = DOM.append(dropOverlay, $('span.codicon.codicon-files'));
		dropOverlayIcon.setAttribute('aria-hidden', 'true');
		DOM.append(dropOverlay, $('span.vibe-ai-drop-overlay-label')).textContent = localize(
			'vibeAIChat.dropOverlayEdit',
			"Release to attach as context"
		);
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
			// Phase 184: the edit box's OWN attachment set — seeded from the
			// edited message's sent attachments (chips/thumbnails above the
			// bubble), never the main input's pending state.
			files: [],
			images: [],
			pendingFileReads: new Map<string, Promise<void>>(),
			pendingImageReads: new Set<Promise<void>>(),
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
		const editedMessage = this.userTurnMessage(conversation, row);
		if (editedMessage?.images) {
			edit.images.push(...editedMessage.images);
		}
		if (editedMessage?.files) {
			edit.files.push(...editedMessage.files);
		}
		this.promptEdit = edit;
		// The toolbar comes from the same builder the main input uses; its
		// refs live on the edit state and die with it (listeners included).
		// Phase 184: the paperclip attaches to the EDIT set (the open
		// message's own attachments), not the input below.
		const toolbar = this.buildInputToolbar(shell, listeners, {
			sendTitle: localize('vibeAIChat.resend', "Re-send (Enter)"),
			onSend: () => void this.commitPromptEdit(),
			// Phase 50: no context usage ring on a resent prompt.
			showContextRing: false,
			onAttach: () => this.attachActiveFile(this.editAttachmentSink(edit)),
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
		// Phase 184: the edit box is a full composer — image paste (same
		// contract as the main input) and drag-drop attach onto the shell,
		// both routing into the edit's own attachment set.
		listeners.add(DOM.addDisposableListener(textarea, DOM.EventType.PASTE, e => {
			this.handleImagePaste(e, this.editAttachmentSink(edit));
		}));
		listeners.add(DOM.addDisposableListener(shell, 'dragover', e => {
			if (!this.canDropIntoInput(e)) {
				shell.classList.remove('vibe-ai-dragover');
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
			shell.classList.add('vibe-ai-dragover');
		}));
		listeners.add(DOM.addDisposableListener(shell, 'dragleave', e => {
			if (!shell.contains(e.relatedTarget as Node)) {
				shell.classList.remove('vibe-ai-dragover');
			}
		}));
		listeners.add(DOM.addDisposableListener(shell, 'drop', e => {
			shell.classList.remove('vibe-ai-dragover');
			void this.handleDrop(e, this.editAttachmentSink(edit));
		}));
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
			// This gesture's click must not re-open an edit (same message's
			// attachment strip / another bubble) — click-outside means exit.
			this.promptEditReopenSuppressed = true;
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
	 * re-sends the edited prompt as a fresh turn. An empty edit with no
	 * attachments is treated as a cancel (Phase 184: an attachment-only
	 * edit sends, main-input parity). Phase 109: the discard first reverts
	 * ALL file changes from the already-executed turns (async disk
	 * restores) and the resend dispatches only after the revert settles.
	 * Phase 184: the edit box's OWN attachment set (seeded from the sent
	 * message, edited in place) rides the resend — images on the history
	 * message, files as the request's context.files — and the turn's
	 * static strip re-renders from the edited set.
	 */
	private async commitPromptEdit(): Promise<void> {
		const edit = this.promptEdit;
		if (!edit || edit.committing) {
			// Re-entry guard: the commit is async now (the revert awaits
			// disk restores) — a second Enter while it runs must not
			// re-truncate.
			return;
		}
		const text = edit.textarea.value.trim();
		if (text.length === 0 && edit.images.length === 0 && edit.files.length === 0) {
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
		// Phase 184: a drop still reading (spinner chip) settles before the
		// capture below — the file lands on THIS resend instead of silently
		// missing it (the main send()'s wait contract, edit-scoped).
		if (edit.pendingFileReads.size > 0 || edit.pendingImageReads.size > 0) {
			await Promise.allSettled([...edit.pendingFileReads.values(), ...edit.pendingImageReads]);
		}
		const images = edit.images.length > 0 ? [...edit.images] : undefined;
		const files = edit.files.length > 0 ? [...edit.files] : undefined;
		void this.truncateFromUserTurn(conversation, row).then(turnIndex => {
			if (turnIndex === -1 || this.promptEdit !== edit) {
				// Not a thread row, or the edit was cancelled / replaced
				// while the revert ran — the truncated thread stays as-is.
				edit.committing = false;
				if (this.promptEdit === edit) {
					this.cancelPromptEdit();
				}
				return;
			}
			this.promptEdit = undefined;
			edit.listeners.dispose();
			edit.chipsListeners.dispose();
			// The row is the thread's last turn again — restore it as a
			// static bubble with the edited text (tears the edit box down).
			bubble.classList.remove('vibe-ai-user-editing');
			bubble.textContent = text;
			// Phase 184: the strip re-renders from the edited attachment set
			// (chips added/removed in the edit box are reflected on the sent
			// message, not just on the re-run).
			this.renderUserAttachmentStrip(row, images, files, bubble);
			// Push the edited prompt as the turn's (new) user message —
			// its (edited) attachments ride along so a later edit of the
			// same message seeds from them again.
			this.history.push({
				role: 'user',
				content: text,
				...(images ? { images } : {}),
				...(files ? { files } : {}),
			});
			// Cursor-parity tab title: when the first prompt was edited, the
			// title may still be derived from the old text — re-derive it.
			if (turnIndex === 0) {
				this.sessionTitle = this.deriveSessionTitle(text);
				// Phase 227: the AI summary (if any) described the old
				// wording — drop it and let the re-dispatched first turn
				// request a fresh one from the edited prompt.
				conversation.titleRequested = false;
				this.sessionStore.resetSessionTitle(conversation.sessionId);
				this.updateTabTitle();
			}
			// Re-send from the edited turn — the discarded turns' file
			// changes were reverted first (Phase 109: a resend defaults to
			// a clean slate, the re-run starts over).
			this.dispatchTurn(conversation, text, row, files ?? []);
		});
	}

	/**
	 * Phase 47: discards the turn owning `userRow` and everything after it
	 * (Cursor-parity edit & resubmit): the conversation's in-flight stream
	 * is aborted first, history and turn records are truncated to just
	 * before that turn, and every rendered row after it is removed.
	 * Phase 109 (user request): a resend defaults to a clean slate — ALL
	 * file changes from the discarded (already-executed) turns are
	 * reverted first, newest-first: created files are deleted again,
	 * modified files restored, and the in-flight turn's partial changes
	 * (never captured into the records) are reverted too. Failures warn
	 * but never block the resend. Returns the turn's index among the
	 * thread's user turns (-1 when the row is not part of the thread —
	 * defensive).
	 */
	private async truncateFromUserTurn(conversation: VibeAIConversation, userRow: HTMLElement): Promise<number> {
		// The edited turn's index among the thread's user turns — turn
		// records (one per completed user turn) and flat history pairs
		// (user/assistant) both map 1:1 onto these rows.
		const userRows = Array.from(conversation.container.querySelectorAll('.vibe-ai-turn-user'));
		const turnIndex = userRows.indexOf(userRow);
		if (turnIndex === -1) {
			return -1;
		}
		// Phase 109: capture the in-flight turn's partial changes BEFORE
		// the abort tears the stream state down — they are the newest
		// changes and revert first below.
		const inFlightChanges = [...(conversation.stream?.turnChanges ?? [])];
		// Abort the conversation's in-flight stream (Cursor parity: editing
		// while streaming = abort) — its late settle no-ops in
		// finishStreaming (requestId guard).
		this.abortStream(conversation);
		// Phase 109 (user request): revert ALL file changes from the
		// already-executed turns being discarded — newest-first
		// (restoreCheckpoint semantics) so cascading writes to the same
		// file roll back correctly. The re-run starts from a clean slate
		// instead of piling onto the previous run's on-disk state. A
		// failed revert warns but never blocks the resend.
		let allOk = true;
		if (inFlightChanges.length > 0) {
			allOk = await this.revertChanges(inFlightChanges) && allOk;
		}
		allOk = await this.revertTurnRecordsNewestFirst(conversation.turns.slice(turnIndex)) && allOk;
		if (!allOk) {
			this.notificationService.warn(localize(
				'vibeAIChat.resendRevertPartial',
				"Some file changes from the previous run could not be reverted."
			));
		}
		// Truncate history at the edited turn's user message: drop it and
		// everything after (the caller pushes the edited text back). Flat
		// pairs map 1:1 onto user turns — count user messages forward.
		// Phase 113: steered messages are NOT dispatched user turns (they
		// were injected mid-turn) — skipped by the count so the alignment
		// holds; steers belonging to the discarded turns sit after the cut
		// point and are dropped with them.
		let cut = conversation.history.length;
		let seen = -1;
		for (let index = 0; index < conversation.history.length; index++) {
			if (conversation.history[index].role === 'user' && !conversation.history[index].steered) {
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
		this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)), conversation.mode, conversation.kind === 'side' ? { kind: 'side', parentSessionId: conversation.parentSessionId } : undefined, conversation.workspaceRoot);
		// Phase 120: re-apply the session goal after the save (setGoal is
		// the goal's authoritative writer — the save's stick covers stored
		// goals, this re-applies the live state, e.g. a goal set mid-turn).
		this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
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
		// Phase 218: the previous turn's failed-turn stash dies with it (a
		// retry credential belongs to the turn that failed; from here on a
		// fresh error re-stashes).
		conversation.lastFailedTurn = undefined;

		// Phase 140: the previous turns' Worked shells collapse here as a
		// backstop — the answer completing already folds the turn's shell
		// (settleWorkShell; Phase 96's keep-expanded reversed), so the
		// sweep only finds shells the user manually re-expanded while
		// reviewing. Restored history renders collapsed and the new
		// turn's shell is created lazily on its first tool call.
		this.foldWorkShell(conversation);

		const row = DOM.append(conversation.container, $('.vibe-ai-turn.vibe-ai-turn-assistant'));

		// Phase 60/61: lazy block runs — Phase 99 exception: the eager
		// thinking run below. Every further block run appends its own
		// element as it arrives: a thinking run keeps streaming into that
		// block (ensureThinkingRun), a text run a markdown body
		// (ensureTextRun), the FIRST tool call the turn's ONE Worked shell
		// (ensureWorkShell) that gathers every activity element (thinking
		// sub-blocks, narration bodies, cards) under a single collapsible.
		// The DOM order is therefore the agent's run order, and the whole
		// turn collapses under one "Worked for Xs" row (a thinking-only
		// turn keeps its plain "Thought for Xs" blocks).

		// Phase 44: the turn's live state hangs off its conversation —
		// parallel tabs each keep their own refs, throttle and artifacts.
		conversation.stream = {
			requestId,
			turn: { text: '', thinking: '' },
			thinkingDetails: undefined,
			thinkingLabel: undefined,
			thinkingText: undefined,
			thinkingRunStartedAt: undefined,
			thinkingRunStart: 0,
			// Phase 61: ONE Worked block per turn — created lazily on the
			// first tool_start (a thinking-only turn never creates one).
			workShell: undefined,
			workSteps: undefined,
			workLabel: undefined,
			workAnyTool: false,
			workRunStartedAt: undefined,
			// Phase 84.9/96: no settle yet — the shell's duration freezes
			// ONCE (round_end final marker, finishStreaming backstop) while
			// the shell stays expanded until the next turn opens.
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
			// Phase 103: set by limit_reached events (note + Continue chip).
			limitReached: false,
			// Phase 70: the Auto router's pick (set by model_routed events).
			routedModel: undefined,
			modelRoutedNote: undefined,
			lastError: undefined,
			// Phase 134: no Retrying chip yet (the `retry` event creates one).
			retryRow: undefined,
			// Phase 113: steers — nothing queued or injected yet.
			steeredMessages: [],
			inflightSteers: [],
			pendingSteer: undefined,
			// Phase 150: no backend turn state announced yet.
			turnState: undefined,
			// Phase 245: no turn transcript id yet (the turn_start event
			// stamps it — the resume-retry credential).
			turnId: undefined,
			// Phase 246: fresh turns are never resumes (the resume dispatch
			// flips this before the stream opens).
			isResume: false,
			resumeDivider: undefined,
			// Phase 71: Plan mode state — no plan is pending yet.
			planPhase: undefined,
			pendingPlan: undefined,
			planResults: undefined,
			planCardRoot: undefined,
			planProgress: undefined,
			planStepRows: undefined,
			// Phase 231: no per-step activity group open yet (plan execution
			// creates one per plan_step_start).
			planStepGroup: undefined,
			// Phase 218: no plan doc streaming into the editor yet.
			planDocStream: undefined,
			// Phase 219: no approval widget in the doc's editor yet.
			planApproval: undefined,
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
			smoothedLen: 0,
			renderedMarkdown: undefined,
		};

		// Phase 99: eager thinking run — the shimmering "Thinking…" block
		// appears the MOMENT the message is sent (user request: no dead time
		// between the send and the first backend event — HTTP + routing +
		// first-token latency used to leave the thread silent for seconds,
		// and round-1 / pure-Q&A got no heartbeat at all). It IS the turn's
		// first thinking run (the flag below says 'thinking'): the backend's
		// round-start heartbeat and narrations stream into it, and when
		// other activity opens first (tool_start → the Worked shell takes
		// over, error / empty done) the empty-run hide in closeThinkingRun
		// removes it. Phase 102: the ANSWER no longer streams inside it —
		// the first text delta folds the run to its settled "Thought for
		// Xs" summary (an empty eager run hides entirely) and the answer
		// streams as its own body below. thinkingRunStartedAt = send
		// time → "Thought for Xs" includes the initial wait.
		this.ensureThinkingRun(conversation);
		conversation.stream.lastBlockKind = 'thinking';

		// New turn opens from an explicit send — jump to the bottom.
		this.scrollBottom(conversation, true);
	}

	private updateThinkingElement(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.thinkingDetails || !state.thinkingText || !state.thinkingLabel) {
			return;
		}
		// Phase 93: the row stays COLLAPSED while the run streams — the
		// summary label shimmers ("Thinking…") and no reasoning text is
		// revealed until the user expands it. An empty-content delta (the
		// backend's heartbeat that opens the shimmer row) leaves the
		// collapsed row untouched. Closed runs keep their collapsed
		// "Thought for Xs" blocks untouched.
		const runText = state.turn.thinking.slice(state.thinkingRunStart);
		if (runText.length === 0) {
			return;
		}
		state.thinkingLabel.textContent = localize('vibeAIChat.thinking', "Thinking…");
		// Read the window's scroll position BEFORE mutating it — setting the
		// text changes scrollHeight and would invalidate the check. The user
		// scrolling up inside the window pauses its follow, scrolling back
		// to its bottom resumes (same rules as the thread follow-latest).
		const windowAtBottom = this.isScrolledToBottom(state.thinkingText);
		state.thinkingText.textContent = runText;
		if (state.thinkingDetails.open) {
			// Manual expansion during the run: the ~10-line window still
			// follows its tail (Phase 50 window rules, no auto-open).
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
		// Phase 89: NO length-based fold here — 84.11's budget-boundary
		// trigger folded intermediate narrations too (any narration longer
		// than the budget was mistaken for the final answer; the shell
		// then reopened on the next tool event). The backend now announces
		// the final answer explicitly on the round_end event (final=true)
		// and handleStreamData folds the shell there. Phase 90: the marker
		// precedes the answer text (post-tool rounds' text is held
		// backend-side), so the shell is already folded when this body
		// opens.
		// r22: the answer paints through the smoothing pump, not a one-shot
		// throttled render — deltas accumulate in `turn.text` and the pump
		// paints a few more characters per tick, so bursty arrivals stream
		// as a steady typewriter flow. closeTextRun / finishStreaming cancel
		// the pump and render the full text directly.
		if (state.markdownRenderTimer !== undefined) {
			return;
		}
		this.pumpSmoothText(conversation);
	}

	/**
	 * r22: the streaming paint pump — one tick advances `smoothedLen`
	 * toward the received text by a proportional step (bounded below) and
	 * re-renders the run's painted slice. The tick coarsens on long runs (a
	 * full markdown re-parse per paint scales with length — keep the pump's
	 * cost at or below the old 120ms throttle's). It stops when it catches
	 * up (the next delta restarts it via updateTextElement) and
	 * clearStreamMarkdownTimer cancels it on run close / turn finish / abort.
	 */
	private pumpSmoothText(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentBody) {
			return;
		}
		const painted = state.smoothedLen - state.textRunStart;
		const delay = painted > 12000 ? SMOOTH_STREAM_TICK_MS * 3 : SMOOTH_STREAM_TICK_MS;
		state.markdownRenderTimer = DOM.getWindow(state.currentBody).setTimeout(() => {
			state.markdownRenderTimer = undefined;
			if (!state.currentBody) {
				return; // the run closed while the tick was pending
			}
			const target = state.turn.text.length;
			if (state.smoothedLen < target) {
				const backlog = target - state.smoothedLen;
				state.smoothedLen = Math.min(
					target,
					state.smoothedLen + Math.max(SMOOTH_STREAM_MIN_CHARS, Math.ceil(backlog / SMOOTH_STREAM_CATCHUP_DIVISOR))
				);
				this.renderMarkdownNow(conversation, true);
			}
			if (state.smoothedLen < state.turn.text.length) {
				this.pumpSmoothText(conversation);
			}
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
			// URL-shaped inline code chips are clickable: click opens the
			// built-in Simple Browser, Ctrl+Click the system default browser.
			inlineCodeLinks: true,
			// Phase 192: shell-family fences (powershell etc.) tokenize with
			// the bash-proven shellscript grammar — see the const for why.
			languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES,
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
						return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true, languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES }, rawInfo);
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
						return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true, languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES }, rawInfo);
					});
				}
				return this.editorCodeBlockRenderer.renderCodeBlock(languageId, value, { codeBlockHeader: true, languageAliases: VIBE_AI_SHELL_LANGUAGE_ALIASES }, rawInfo);
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

	/** r29: inline code naming a real local file opens it in the center editor area. */
	private enhancePaneFileChips(el: HTMLElement): void {
		enhanceFileChips(el, {
			fileService: this.fileService,
			// Phase 255: every workspace root tries — multi-root workspaces
			// must not depend on which folder is first. Media/archive evidence
			// routes to the OS / Explorer; the rest opens in the editor area.
			resolveRoots: () => this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath),
			onOpen: fsPath => openChipFileSmart(this.commandService, this.openerService, fsPath),
			onMissing: (_fsPath, display) => {
				this.notificationService.warn(localize('vibeAIChat.fileChipMissing', "{0} no longer exists on disk — it was deleted or removed by a rollback.", display));
			},
		});
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
		// r22: the pump's painted slice — streaming renders up to the
		// smoothed index (a burst paints progressively); non-streaming
		// renders (run close / turn finish / restore) show everything.
		const text = textOverride ?? state.turn.text.slice(state.textRunStart, streaming ? state.smoothedLen : state.turn.text.length);
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
			if (!streaming) {
				// r29: closed runs get file chips — inline code naming a real
				// local file opens it in the center editor area.
				this.enhancePaneFileChips(state.currentBody);
			}
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
	 * "Thinking…" block. Phase 93: it is visible (and collapsed) from
	 * creation — the summary label carries the shimmer while the run
	 * streams; no window auto-open (the ~10-line view only shows when the
	 * user expands the row mid-run). Contiguous thinking deltas stream
	 * into it; the next non-thinking event closes it (closeThinkingRun)
	 * and the next thinking burst opens a fresh block. Phase 99: also
	 * called EAGERLY at turn open (startAssistantTurn) — the shimmering
	 * row appears the moment the message is sent and covers the dead
	 * time before the first backend event; if no thinking content ever
	 * arrives, the empty-run hide removes it as soon as other activity
	 * opens.
	 */
	private ensureThinkingRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.currentAssistantRow) {
			return;
		}
		// Phase 61: once the turn's Worked shell exists (a tool already
		// ran), thinking streams INSIDE it as a sub-entry; before that it
		// renders at row level and moves in when the first tool arrives.
		// Phase 231: an active plan step's thoughts stream into that step's
		// group container (planActivityRoot).
		const thinkingDetails = DOM.append(this.planActivityRoot(state) ?? state.currentAssistantRow, $('details.vibe-ai-thinking')) as HTMLDetailsElement;
		const summary = DOM.append(thinkingDetails, $('summary'));
		const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-thinking-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
		// Phase 162: the label class is the merge hook —
		// mergeThoughtBlockInto rewrites the surviving block's label via it.
		const thinkingLabel = DOM.append(summary, $('span.vibe-ai-thinking-label'));
		thinkingLabel.textContent = localize('vibeAIChat.thinking', "Thinking…");
		// Phase 93: black-white shimmer while the run streams — the class
		// lifts when the run folds to its "Thought for Xs" summary.
		thinkingLabel.classList.add('vibe-ai-thinking-shimmer');
		const thinkingText = DOM.append(thinkingDetails, $('.vibe-ai-thinking-text'));
		state.thinkingDetails = thinkingDetails;
		state.thinkingLabel = thinkingLabel;
		state.thinkingText = thinkingText;
		state.thinkingRunStartedAt = Date.now();
		state.thinkingRunStart = state.turn.thinking.length;
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
		// Phase 231: a plan step's narration streams INTO its step group
		// (the group is the step's segment — plan_step_done folds it with
		// the narration inside); ask/agent text stays row-level (Phase 102,
		// the answer body lives outside the Worked shell).
		state.currentBody = DOM.append(state.planStepGroup?.steps ?? state.currentAssistantRow, $('.vibe-ai-chat-markdown.vibe-ai-streaming'));
		state.textRunStart = state.turn.text.length;
		// r22: the pump's painted index jumps to the new run's start — chars
		// before it belong to the closed run's body and must not delay this
		// run's first paint.
		state.smoothedLen = Math.max(state.smoothedLen, state.textRunStart);
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
	 * answered and which files were read, keep it). Phase 84.9/89: the
	 * shell stays open through intermediate narrations; the final answer
	 * settles it on the backend's round_end final marker (handleStreamData)
	 * and finishStreaming settles it at turn end as the backstop. Phase 90:
	 * the marker precedes the answer text (post-tool rounds' text is held
	 * backend-side), so the settle-fold lands before the first answer
	 * character. Phase 140: settle folds — the answer completing is the
	 * collapse moment (Cursor parity; Phase 96's keep-expanded is
	 * reversed); only streaming keeps the shell open, the user re-opens
	 * it with the native <details> toggle and restored history renders
	 * collapsed. The summary click uses the native <details> toggle (no
	 * compact-toggle listener anymore).
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
	 * Phase 140: settles the turn's Worked shell by folding it — the
	 * duration freezes (workFoldedMs, first call wins), the label settles
	 * to "Worked for Xs" and the whole activity collapses to that one
	 * summary row (Cursor parity; Phase 96's keep-expanded is reversed —
	 * the answer appearing is the collapse moment, not the next send).
	 * The fold lands before the first answer character: the backend says
	 * the answer is final (round_end final marker) BEFORE any answer
	 * text (Phase 90 held text) and the answer body lives OUTSIDE the
	 * shell (Phase 102), so nothing the user reads is inside the
	 * collapsed block. Intermediate narrations never settle the shell
	 * (84.11's length-based mid-run guess is long gone); turn end
	 * (finishStreaming) settles as the backstop — interrupted turns
	 * (Phase 97) therefore collapse their activity at interrupt time.
	 */
	private settleWorkShell(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || !state.workShell || !state.workLabel) {
			return;
		}
		if (state.workShell.dataset.planSettled) {
			// Phase 236: a completed plan turn's shell — the summary row is
			// already removed and the shell stays open (settlePlanWorkShell);
			// this backstop (the `done` event's finishStreaming) must not
			// re-collapse it or resurrect the removed label.
			return;
		}
		if (state.workFoldedMs === undefined) {
			state.workFoldedMs = Date.now() - (state.turnStartedAt ?? Date.now());
		}
		state.workLabel.textContent = localize('vibeAIChat.worked', "Worked for {0}", getDurationString(state.workFoldedMs));
		// Phase 149: the settled summary carries the step counts (Cursor
		// parity) — "Worked for 53s · Read 5 files · Searched 2 times".
		this.appendWorkedCountsSuffix(state.workLabel, state.workSteps, state.toolCards);
		// Phase 172: the fold is a scroll event — capture the thread's
		// anchor BEFORE the collapse (the mutation changes scrollHeight and
		// would invalidate every check; same rule as the render paths'
		// pre-mutation reads), fold, then restore the anchor.
		const workShell = state.workShell;
		this.preserveScrollAcrossFold(conversation, workShell, state.workSteps, () => {
			// Phase 140: settle folds again — the answer completed, so the
			// activity collapses to its summary row (the user re-opens it
			// with the native <details> toggle; the next send's foldWorkShell
			// sweep remains as the backstop for manually re-expanded shells).
			workShell.open = false;
		});
	}

	/**
	 * Phase 236: the completed plan turn's Worked shell settles DIFFERENTLY
	 * from ask/agent turns (settleWorkShell collapses to one "Worked for
	 * Xs" row) — the plan card plus the per-step groups already ARE the
	 * completed look (user ruling: 完成後不用整個收起、總結列直接去掉).
	 * The shell stays open and the <summary> row is removed entirely.
	 * The marker lives on the DOM (dataset), not the stream state — both
	 * later sweeps reach the shell through the thread's DOM: the
	 * settleWorkShell backstop (the `done` event) must not re-collapse or
	 * resurrect the label, and the next send's foldWorkShell sweep must
	 * skip it — a summary-less <details> folded shut would hide its whole
	 * content (plan card + step groups) permanently. workFoldedMs still
	 * freezes (the turn record's duration stays in parity).
	 */
	private settlePlanWorkShell(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state?.workShell) {
			return;
		}
		const workShell = state.workShell;
		workShell.dataset.planSettled = 'true';
		if (state.workFoldedMs === undefined) {
			state.workFoldedMs = Date.now() - (state.turnStartedAt ?? Date.now());
		}
		workShell.querySelector('summary')?.remove();
		workShell.open = true;
	}

	/**
	 * Phase 172: keeps the thread's scroll anchor across a Worked fold.
	 * The collapse removes the whole activity block from the layout in one
	 * step while scrollTop stays numerically valid — a thread pinned at
	 * the bottom clamps to the new bottom, but any other position lands
	 * one fold-height earlier (the previous turn's content), and the
	 * answer streaming below stops chasing once a late clamp event finds
	 * the viewport off-bottom and flips followThreadBottom. The anchor is
	 * read before `fold()` runs, the restore lands after it. Three rules:
	 *
	 * 1. Pinned at the fold (the follow flag, or within its threshold —
	 *    the OR heals a flag a mid-turn clamp race already flipped while
	 *    the position stayed at the bottom): re-land the bottom
	 *    immediately, on the next frame and after the heights settle
	 *    (scrollToLatestTurn's three-pass pattern — late growth: async
	 *    code-block swaps, the turn footer), every pass only while the
	 *    chase is still on (a user scroll-up between passes cancels the
	 *    rest).
	 * 2. Reading elsewhere with the fold entirely above the viewport:
	 *    compensate the scrollTop by the removed height so the reading
	 *    anchor stays on the same content.
	 * 3. Anything else (the fold crosses the viewport): native behavior.
	 */
	private preserveScrollAcrossFold(conversation: VibeAIConversation, shell: HTMLElement, steps: HTMLElement | undefined, fold: () => void): void {
		const holder = this.messagesContainer;
		if (!holder) {
			fold();
			return;
		}
		const pinned = this.followThreadBottom
			|| holder.scrollTop + holder.clientHeight >= holder.scrollHeight - FOLLOW_LATEST_THRESHOLD_PX;
		let removedHeight = 0;
		if (!pinned && steps) {
			const holderRect = holder.getBoundingClientRect();
			const shellRect = shell.getBoundingClientRect();
			if (shellRect.bottom <= holderRect.top + 1) {
				removedHeight = steps.offsetHeight;
			}
		}
		fold();
		if (pinned) {
			const win = DOM.getWindow(holder);
			this.scrollBottom(conversation, true);
			win.requestAnimationFrame(() => {
				if (!this._store.isDisposed && this.followThreadBottom) {
					this.scrollBottom(conversation, true);
				}
			});
			win.setTimeout(() => {
				if (!this._store.isDisposed && this.followThreadBottom) {
					this.scrollBottom(conversation, true);
				}
			}, RESTORE_SCROLL_SETTLE_MS);
		} else if (removedHeight > 0) {
			holder.scrollTop = Math.max(0, holder.scrollTop - removedHeight);
		}
	}

	/**
	 * Phase 140: folds every still-open Worked shell in this conversation
	 * to its settled "Worked for Xs" summary row — now a BACKSTOP: the
	 * answer completing already folds the turn's shell (settleWorkShell),
	 * so the sweep only catches shells the user manually re-expanded
	 * while reviewing. A DOM sweep over the thread's
	 * `<details class="vibe-ai-worked">` covers every previous turn (with
	 * or without a captured record) and cannot touch anything else: the
	 * answer is a plain markdown body now (Phase 102 — never a thought
	 * block), the new turn's shell is created lazily AFTER this, and
	 * restored history renders collapsed already.
	 */
	private foldWorkShell(conversation: VibeAIConversation): void {
		for (const shell of Array.from(conversation.container.querySelectorAll('details.vibe-ai-worked[open]')) as HTMLDetailsElement[]) {
			// Phase 236: a completed plan turn's shell has no summary —
			// folding it shut would hide the plan card and step groups
			// permanently (no toggle row left to re-open with).
			if (shell.dataset.planSettled) {
				continue;
			}
			shell.open = false;
		}
	}

	/**
	 * Phase 149: regroups the turn's Worked steps — completed read-only
	 * cards merge per file (repeated reads of the same path fold into the
	 * first row with the union range) and fold into count group rows
	 * ("Read 7 files", "Listed 3 directories", "Searched 2 times"). Pure
	 * display: the persisted records keep every individual call, and the
	 * restore path re-derives the same groups. Pending / mutating cards
	 * and every non-card step (thinking, narration, steers, approvals)
	 * never move; runs only on completed read-only results, never on
	 * tool start (no streaming jitter).
	 */
	private regroupWorkedSteps(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state?.workSteps || state.toolCards.size === 0) {
			return;
		}
		// Phase 231: step groups hold their step's cards — regroup within
		// each group (same-file merges / count groups never cross a step
		// boundary), then the shell's top level (pre-group activity).
		regroupWorkedSteps(state.workSteps, state.toolCards);
		for (const steps of Array.from(state.workSteps.querySelectorAll('.vibe-ai-plan-step-group-steps')) as HTMLElement[]) {
			regroupWorkedSteps(steps, state.toolCards);
			// Grouping may pull read-only cards out from between two Thought
			// rows inside the group — newly adjacent settled blocks merge.
			this.consolidateThoughtBlocks(steps);
		}
		// Phase 162: grouping pulls read-only cards out from between two
		// Thought rows (into per-file rows / count groups) — newly adjacent
		// settled blocks merge (durations sum, texts blank-line join).
		this.consolidateThoughtBlocks(state.workSteps);
	}

	/**
	 * Phase 149: appends the settled summary counts to a "Worked for Xs"
	 * label — "· Read 5 files · Searched 2 times" (Cursor-parity collapse
	 * summary, computed from the grouped view). Turns without completed
	 * read-only steps (thinking-only, pure writes) keep the bare label.
	 */
	private appendWorkedCountsSuffix(label: HTMLElement, steps: HTMLElement | undefined, cards: Map<string, VibeAIToolCard> | undefined): void {
		if (!steps || !cards || cards.size === 0) {
			return;
		}
		const segments = workedCountsSegments(summarizeWorkedActivity(steps, cards));
		if (segments.length === 0) {
			return;
		}
		const counts = DOM.append(label, $('span.vibe-ai-worked-summary-counts'));
		counts.textContent = ` · ${segments.join(' · ')}`;
	}

	/**
	 * Phase 60: closes the current thinking run — records its reasoning
	 * range as a timeline node and folds the block back to its collapsed
	 * "Thought for Xs" row (the run's own duration, not the whole
	 * turn's). Phase 93: the label's shimmer lifts here — the row keeps
	 * its settled "Thought for Xs" summary (collapsed). The next thinking
	 * burst opens a fresh block (ensureThinkingRun). Phase 102: the run
	 * folds/hides NO MATTER WHAT — the answer never lives inside the
	 * block (it streams as its own body below, see handleStreamData's
	 * case 'text').
	 */
	private closeThinkingRun(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state || state.lastBlockKind !== 'thinking') {
			return;
		}
		const start = state.thinkingRunStart;
		const end = state.turn.thinking.length;
		// Phase 162: the run's own duration — recorded on the timeline node
		// AND on the block element (data-vibe-thought-ms) so
		// consolidateThoughtBlocks can sum adjacent blocks into the merged
		// label.
		const runMs = Date.now() - (state.thinkingRunStartedAt ?? Date.now());
		if (end > start) {
			state.timeline.push({
				kind: 'thinking',
				start,
				end,
				durationMs: runMs,
			});
		}
		if (state.thinkingDetails && state.thinkingLabel) {
			// Phase 93: the shimmer lifts when the run folds to its
			// "Thought for Xs" summary (empty heartbeat-only runs are
			// hidden below — the class lift is moot there).
			state.thinkingLabel.classList.remove('vibe-ai-thinking-shimmer');
			if (end > start) {
				state.thinkingDetails.dataset.vibeThoughtMs = String(runMs);
				state.thinkingLabel.textContent = localize('vibeAIChat.thought', "Thought for {0}", getDurationString(runMs));
				// Phase 84.2: the run is over — the window drops the ~10-line
				// cap so re-expanding it shows the full reasoning in the
				// thread scroll (only the streaming window stays capped).
				state.thinkingText?.classList.add('vibe-ai-thinking-text-settled');
				state.thinkingDetails.open = false;
			} else {
				// A run without deltas (heartbeat-only) hides entirely — the
				// shimmer row opened as a progress signal and carries no
				// process answer, so it must not leave an empty Thought row.
				// Phase 94: the round-start heartbeat makes these rarer
				// (every post-tool round opens its row), mid-turn
				// narration-less rounds still hide when tools start.
				// Phase 102: the eager run (startAssistantTurn) hides here
				// too when the answer starts without narration — pure Q&A
				// renders the answer as a plain body, no Thought row.
				state.thinkingDetails.style.display = 'none';
			}
		}
		// Phase 162: merge the just-folded block into a preceding adjacent
		// one (and sweep stale hidden empties) — consecutive Thought rows
		// collapse into ONE block. Runs after the refs clear: the folded
		// block is settled and every merge participant is out of state.
		const thoughtParent = state.thinkingDetails?.parentElement;
		state.thinkingDetails = undefined;
		state.thinkingLabel = undefined;
		state.thinkingText = undefined;
		state.thinkingRunStartedAt = undefined;
		if (thoughtParent) {
			this.consolidateThoughtBlocks(thoughtParent);
		}
	}

	/**
	 * Phase 162: merges runs of adjacent settled "Thought for Xs" blocks
	 * in `parent` into their FIRST block — the user rule: consecutive
	 * Thought rows collapse into ONE block, each run's reasoning separated
	 * by a blank line. Adjacency is DOM-level: blocks separated by any
	 * other step (card, group row, narration body) stay separate. Runs at
	 * every thinking-run fold (closeThinkingRun) and after every Worked
	 * regroup (grouping pulls read-only cards out from between two Thought
	 * rows, which makes them adjacent); the restore path runs it after its
	 * node loops so restored history shows the same merged blocks. The
	 * absorbed blocks' durations ride data-vibe-thought-ms (written at
	 * fold / restore) and sum into the surviving block's label; the
	 * reasoning texts join the surviving text element with a blank line
	 * (the element is pre-wrap). Hidden empty rows (heartbeat-only runs)
	 * are removed — left in place they would break their neighbours'
	 * adjacency. Streaming rows (shimmer label) never merge.
	 */
	private consolidateThoughtBlocks(parent: HTMLElement): void {
		let anchor: HTMLDetailsElement | undefined;
		for (const child of Array.from(parent.children)) {
			if (!child.classList.contains('vibe-ai-thinking')) {
				anchor = undefined;
				continue;
			}
			const details = child as HTMLDetailsElement;
			if (details.style.display === 'none') {
				details.remove();
				continue;
			}
			if (details.querySelector('.vibe-ai-thinking-shimmer')) {
				anchor = undefined;
				continue;
			}
			if (!anchor) {
				anchor = details;
				continue;
			}
			this.mergeThoughtBlockInto(anchor, details);
		}
	}

	/**
	 * Phase 162: absorbs `block` into `anchor` — the reasoning texts join
	 * the anchor's LAST text element blank-line separated (one element;
	 * pre-wrap renders the blank line), the durations sum into the
	 * anchor's label, the block element is removed. Blocks without
	 * duration data (defensive restore paths) merge texts only and keep
	 * their labels.
	 */
	private mergeThoughtBlockInto(anchor: HTMLDetailsElement, block: HTMLDetailsElement): void {
		const anchorTexts = anchor.querySelectorAll('.vibe-ai-thinking-text');
		let target = anchorTexts.length > 0 ? anchorTexts[anchorTexts.length - 1] as HTMLElement : undefined;
		let absorbed = '';
		for (const text of Array.from(block.querySelectorAll('.vibe-ai-thinking-text'))) {
			const value = text.textContent ?? '';
			if (value.length === 0) {
				continue;
			}
			absorbed = absorbed.length > 0 ? `${absorbed}\n\n${value}` : value;
		}
		if (absorbed.length > 0) {
			if (!target) {
				target = DOM.append(anchor, $('.vibe-ai-thinking-text'));
				target.classList.add('vibe-ai-thinking-text-settled');
			}
			const existing = target.textContent ?? '';
			target.textContent = existing.length > 0 ? `${existing}\n\n${absorbed}` : absorbed;
		}
		if (anchor.dataset.vibeThoughtMs !== undefined || block.dataset.vibeThoughtMs !== undefined) {
			const total = (parseFloat(anchor.dataset.vibeThoughtMs ?? '') || 0) + (parseFloat(block.dataset.vibeThoughtMs ?? '') || 0);
			anchor.dataset.vibeThoughtMs = String(total);
			const label = anchor.querySelector('.vibe-ai-thinking-label');
			if (label) {
				label.textContent = localize('vibeAIChat.thought', "Thought for {0}", getDurationString(total));
			}
		}
		block.remove();
	}

	/**
	 * Phase 60: closes the current text run — records its text range
	 * (offsets into the full turn text) as a timeline node and finalizes
	 * the body's render (streaming caret removed; the render is handed to
	 * closedRenders so the async code-block swap survives). The next text
	 * burst opens a fresh body at the row end (ensureTextRun).
	 * Phase 61: `intoWork` — an INTERMEDIATE narration body folds into the
	 * turn's Worked shell (more activity follows it); the final text run
	 * (closed at finish) stays outside as the answer body. Phase 84.9/89:
	 * this close only moves the body / records the range — the shell is
	 * open for every narration run (it folds only on the backend's
	 * round_end final marker and at finishStreaming; Phase 90: the marker
	 * precedes the answer text, so the final answer run opens with the
	 * shell already folded and no tool event ever follows).
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
					// appendChild is a no-op reorder then). Phase 231: an
					// active plan step's narration folds into its group.
					if (intoWork) {
						this.planActivityRoot(state)?.appendChild(state.currentBody);
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

	private finishStreaming(conversation: VibeAIConversation, requestId?: string, interrupted = false): void {
		// Phase 44: double-finish guard — the done event usually wins; a
		// late stream-promise settle (or an abort) finds no live state and
		// no-ops. Other tabs' streams are unaffected. Phase 45: when a
		// requestId is given, only the turn it identifies may finish — a
		// turn skipped mid-stream (send → skip → newer stream) must not
		// tear down its successor. Phase 97: the interrupt path finalizes
		// the turn synchronously with `interrupted`; the aborted stream's
		// late settle no-ops on the same guard.
		const state = conversation.stream;
		if (!state || (requestId !== undefined && state.requestId !== requestId)) {
			return;
		}
		// Phase 134: a lingering Retrying chip dies with the turn (the next
		// real event normally clears it; this is the backstop).
		this.clearRetryChip(conversation);
		// Phase 218: a mid-stream death (interrupt / transport error before
		// the `plan` event) settles the doc stream here — the normal path
		// already settled it in handlePlanReady (no-op).
		this.settlePlanDocStream(state);
		// Phase 231: an interrupt mid-step freezes the step group's spinner
		// (cancelled mark + duration) before the shell settles below.
		this.settleActivePlanStepGroup(conversation);
		// Phase 222: the plan turn ENDS at the decision card (user spec:
		// Cursor parity — the card appears when the final answer is done and
		// the conversation is finished; Build on the card opens a fresh
		// turn). Phase 150/151's awaiting hold (turnState /
		// planPhase === 'awaiting' keeping the turn open) is retired — the
		// backend's awaiting_plan_approval turnState stays informational.

		// Persist the assistant text to history (thinking is not sent back).
		// Phase 97: an interrupted turn keeps its partial answer, marked so
		// the model (and the restored history) knows the turn was cut short
		// — with no partial text the marker alone documents the cut.
		if (interrupted) {
			conversation.history.push({
				role: 'assistant',
				content: state.turn.text.length > 0
					? `${state.turn.text}\n\n[interrupted by user]`
					: '[interrupted by user]',
			});
		} else {
			conversation.history.push({ role: 'assistant', content: state.turn.text });
		}

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

		// Phase 61: settle the turn's ONE Worked shell — "Worked for Xs"
		// with the turn's whole activity inside (thinking sub-blocks,
		// narration, cards). A thinking-only turn never created one; its
		// "Thought for Xs" blocks folded in closeThinkingRun.
		// Phase 89: the PRIMARY settle moment is the backend's round_end
		// final marker (handleStreamData); Phase 90: that marker arrives
		// before the answer text (post-tool rounds' text is held
		// backend-side and flushed right after). This is the backstop
		// settle for turns the marker missed (abort / error / no
		// round_end), and it no-ops when the marker already settled
		// (workFoldedMs freeze), keeping the persisted record in parity
		// with the live label.
		// Phase 140: settle folds — interrupted turns (Phase 97, the
		// stream aborted by the next send) collapse their activity at
		// interrupt time too; restored history renders collapsed.
		this.settleWorkShell(conversation);
		const workDurationMs = state.workFoldedMs;

		// Phase 113: steers the turn ended with — queued mid-turn but never
		// injected (the backend drained them at close: the done event's
		// pending_steer; or the stream was aborted before a done event and
		// the not-yet-echoed sends are tracked in inflightSteers). The
		// union of both (content-deduped — an injected steer was removed
		// from inflight on its echo) joins the history AFTER the answer as
		// steered user messages: the model never saw them mid-turn, so the
		// next turn's request carries them unanswered and it addresses them
		// there. The note below explains the not-delivered state (Phase
		// 114 takes over with queue auto-resume).
		const undeliveredSteers = [...state.inflightSteers];
		if (state.pendingSteer) {
			for (const content of state.pendingSteer) {
				if (!undeliveredSteers.includes(content)) {
					undeliveredSteers.push(content);
				}
			}
		}
		for (const content of undeliveredSteers) {
			conversation.history.push({ role: 'user', content, steered: true });
		}

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
		// no body, so the placeholder's body is created here. Phase 97: an
		// interrupted turn skips it — the interruption note below explains
		// the empty answer.
		if (state.turn.text.length === 0 && state.currentAssistantRow && !interrupted) {
			const body = DOM.append(state.currentAssistantRow, $('.vibe-ai-chat-markdown'));
			const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
			// Phase 51: a budget-truncated round with no answer text says so
			// (the reasoning used up the output budget) instead of "(no response)".
			placeholder.textContent = state.outputTruncated
				? localize(
					'vibeAIChat.truncatedNoResponse',
					"(response truncated — the reasoning used up the output budget)"
				)
				: localize('vibeAIChat.emptyResponse', "(no response)");
			placeholder.style.color = 'var(--vscode-descriptionForeground)';
			placeholder.style.fontStyle = 'italic';
			// Phase 201: the truncated reminder carries a Continue chip (same
			// as the note) — the empty answer is no exception.
			if (state.outputTruncated) {
				const chipRow = DOM.append(state.currentAssistantRow, $('.vibe-ai-output-truncated-note'));
				this.appendTruncationChip(conversation, chipRow);
			}
		}

		// Phase 97: the interrupted turn's note — the progress above stays
		// (partial answer, tool cards, file changes) and this explains why
		// the turn has no completion (informational tone — cut short by the
		// next send, not an error).
		if (interrupted && state.currentAssistantRow) {
			const note = DOM.append(state.currentAssistantRow, $('.vibe-ai-turn-interrupted'));
			note.textContent = localize(
				'vibeAIChat.turnInterrupted',
				"Interrupted — a new message was sent before this turn finished"
			);
		}

		// Phase 113: steers the turn ended with (queued but never injected)
		// — the not-delivered note (114 前的暫存顯示; the messages ride the
		// history above, so the next turn addresses them).
		if (undeliveredSteers.length > 0 && state.currentAssistantRow) {
			const note = DOM.append(state.currentAssistantRow, $('.vibe-ai-steer-pending-note'));
			note.textContent = undeliveredSteers.length === 1
				? localize(
					'vibeAIChat.steerPendingOne',
					"Steer not delivered — the turn finished before it could be injected; it rides the next turn"
				)
				: localize(
					'vibeAIChat.steerPendingMany',
					"{0} steers not delivered — the turn finished before they could be injected; they ride the next turn",
					undeliveredSteers.length
				);
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
			// Phase 103: the loop's limit — persisted for restore parity.
			limitReached: state.limitReached || undefined,
			// Phase 70: the Auto router's pick — persisted for restore parity.
			routedModel: state.routedModel,
			// Phase 71: the plan + its final state (Plan mode turns) — the
			// record is captured when the turn finishes, i.e. after the
			// execute phase (executed), on cancel (cancelled), or at the
			// decision card (Phase 222: the turn ends there — 'awaiting'
			// persists so the restored card still offers Build / Cancel).
			...(state.pendingPlan ? {
				plan: state.pendingPlan,
				planStatus: (state.planPhase === 'executing' ? 'executed' : state.planPhase === 'awaiting' ? 'awaiting' : 'cancelled') as VibeAIPlanCardStatus,
				planResults: state.planResults,
			} : {}),
			error: state.lastError,
			// Phase 245: the turn transcript id (the turn_start event) —
			// persisted for the resume-from-failed-step retry (restore
			// parity: a reloaded failed turn still resumes).
			turnId: state.turnId,
			// Phase 97: the turn was interrupted by the next send (persisted
			// — the restore path renders the interruption note).
			interrupted: interrupted || undefined,
			// Phase 113: steers injected during the turn + the ones that
			// missed injection (persisted — the restore path renders them).
			steered: state.steeredMessages.length > 0 ? [...state.steeredMessages] : undefined,
			steeredPending: undeliveredSteers.length > 0 ? [...undeliveredSteers] : undefined,
			turnChanges: [...state.turnChanges],
			row: state.currentAssistantRow,
			// Phase 134: runtime-only user-row ref (never persisted — the
			// Retry button re-dispatches the failed turn through it).
			userRow: state.userRow,
		};
		if (state.isResume) {
			// Phase 246: a resume retry merges into the failed turn's own
			// record (same user row — no second record for the turn); with
			// no matching record (stash-only credential) fall back to the
			// normal capture path.
			if (!this.mergeResumedTurnRecord(conversation, state, turnRecord) && aligned) {
				conversation.turns.push(turnRecord);
			}
		} else if (aligned) {
			conversation.turns.push(turnRecord);
		}

		// Cursor-parity turn footer: checkpoint restore + copy + time. The
		// restore button works for every turn — turns tracked in the
		// records (alignment above) roll back this and all later rounds,
		// untracked ones fall back to this round's captured changes.
		if (state.currentAssistantRow) {
			this.renderTurnFooterInto(conversation, state.currentAssistantRow, state.turnChanges, state.turnStartedAt ?? Date.now(), aligned ? conversation.turns.length - 1 : -1, this.getFinalAnswerText(turnRecord.answer, turnRecord.timeline));
		}

		// Cursor-parity files-changed summary — Phase 56: docked directly
		// above the input box (only the active conversation's finished
		// turn updates the bar; a background tab's turn shows when its
		// tab is activated).
		if (state.turnChanges.length > 0 && conversation.id === this.activeConversationId) {
			// Phase 88: tie the bar to the turn's record index — Keep
			// marks the record (persisted) so the bar never resurrects;
			// an unaligned turn (no record) keeps the in-memory-only hide.
			this.renderDockedFilesSummary(state.turnChanges, aligned ? conversation.turns.length - 1 : -1);
		}

		// Phase 172: the folds above plus the footer just added grew and
		// shrank the thread after the last render — a following tab
		// re-pins so the turn ENDS on the newest content (chase-only:
		// scrollBottom skips a reading position and background tabs).
		this.scrollBottom(conversation);

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
			this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)), conversation.mode, conversation.kind === 'side' ? { kind: 'side', parentSessionId: conversation.parentSessionId } : undefined, conversation.workspaceRoot);
			// Phase 120: re-apply the session goal after the save (setGoal
			// is the goal's authoritative writer — the save's stick covers
			// stored goals, this re-applies the live state, e.g. a goal
			// set mid-turn).
			this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
		} catch (err) {
			this.logService.error('[VibeAI] failed to persist chat session', err);
		}
		// Phase 79: the tab just became non-empty — record it in the open
		// strip even without a later tab switch (restore parity).
		this.persistOpenState();

		// Phase 41: keep the context usage ring/panel fresh after each turn.
		void this.refreshContextUsage(conversation);

		// Phase 114: the queue's auto-resume (Cursor's "queue") — when this
		// turn ended with queued messages (Shift+Enter / the done event's
		// pending_queue), the first one opens a NEW agent turn. Deferred
		// one task so this settle completes first; resumeSteerQueue's
		// guards skip when a newer turn already runs (the interrupt path)
		// or the tab went inactive (the activation hook resumes instead).
		if (conversation.steerQueue.length > 0) {
			setTimeout(() => this.resumeSteerQueue(conversation), 0);
		}
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
			// Phase 103: the loop's limit (Cursor-parity restore).
			limitReached: turn.limitReached,
			// Phase 70: the Auto router's pick (Cursor-parity restore).
			routedModel: turn.routedModel,
			// Phase 71: the plan + its final state (Cursor-parity restore).
			plan: turn.plan,
			planStatus: turn.planStatus,
			planResults: turn.planResults,
			error: turn.error,
			// Phase 245: the turn transcript id rides the record (the
			// restored failed turn's Retry resumes instead of re-sending).
			turnId: turn.turnId,
			// Phase 97: the interrupted marker rides the record (restore
			// renders the interruption note).
			interrupted: turn.interrupted,
			// Phase 113: steers (injected + not-delivered) ride the record
			// (restore renders the bubbles / the note).
			steered: turn.steered,
			steeredPending: turn.steeredPending,
			turnChanges: turn.turnChanges,
			rolledBack: turn.rolledBack,
			kept: turn.kept,
		};
	}

	/**
	 * Cancels a pending smoothing-pump tick of a streaming turn (r22 — the
	 * pump reuses the old throttled-render timer handle). Uses the turn's
	 * own markdown body for the window lookup while it is still attached
	 * (falls back to the messages holder).
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
		// Phase 218: the conversation is being deleted/reset — release the
		// plan doc's model reference if a stream was mid-flight.
		this.settlePlanDocStream(state);
		// Phase 219: the doc editor's approval widget dies with the stream.
		this.disposePlanApprovalWidget(state);
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
	 * The copy button's source text: the turn's FINAL answer body only —
	 * `answer` accumulates EVERY text delta of the turn, including the
	 * interleaved narration runs that fold into the "Worked for" shell
	 * (hidden in the answer body; they used to ride along on copy). The
	 * last `text` timeline node IS the final answer — the restore path
	 * treats it the same way (renderAssistantFromTimeline's answerIndex)
	 * — so its slice is what goes on the clipboard. Records without a
	 * timeline (pre-Phase-60 sessions) copy the whole answer — their
	 * restore renders the full body too.
	 */
	private getFinalAnswerText(answer: string, timeline?: IVibeAITurnTimelineNode[]): string {
		if (timeline) {
			for (let index = timeline.length - 1; index >= 0; index--) {
				const node = timeline[index];
				if (node.kind === 'text' && node.start !== undefined && node.end !== undefined) {
					const slice = answer.slice(node.start, node.end);
					if (slice.length > 0) {
						return slice;
					}
				}
			}
		}
		return answer;
	}

	/**
	 * Cursor-parity turn footer: a checkpoint (undo) button that restores
	 * the workspace to the state at this turn — this and every later
	 * round's file changes are reverted while the conversation is kept
	 * (Cursor semantics), a copy button that puts the turn's final answer
	 * on the clipboard, and the relative time of the turn. Rendered from
	 * both the live stream state and a restored turn record.
	 */
	private renderTurnFooterInto(conversation: VibeAIConversation, assistantRow: HTMLElement, changes: IVibeAICodeChange[], turnStartedAt: number, turnIndex: number, answerText: string, rolledBack?: boolean): void {
		const disposables = conversation.turnRecordDisposables;
		const footer = DOM.append(assistantRow, $('.vibe-ai-turn-footer'));

		// The ↺ IS the checkpoint restore (Cursor parity): this and every
		// later round's changes are reverted (newest-first, `create`s
		// deleted again), the conversation text is kept. Phase 47: turns
		// not tracked in the records (turnIndex -1 — a resent turn in a
		// conversation whose earlier turns have no records) have no later
		// records to roll back through — the button falls back to
		// reverting exactly this round's captured changes.
		const undoBtn = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-discard')) as HTMLButtonElement;
		const rollbackCount = turnIndex >= 0
			? conversation.turns.slice(turnIndex).reduce((count, turn) => count + turn.turnChanges.length, 0)
			: changes.length;
		undoBtn.title = localize(
			'vibeAIChat.checkpointRestore',
			"Restore checkpoint — revert this and all later rounds' file changes ({0} file(s))",
			rollbackCount
		);
		// Phase 247: the click handler attaches UNCONDITIONALLY for tracked
		// turns — the count is a render-time snapshot, and the transcript
		// reconciliation (restoreCheckpoint) may still surface changes the
		// SSE never delivered. A zero-count button dims (`.dim`) instead of
		// hard-disabling so the click explains itself (info notification)
		// instead of silently no-oping — the dead button WAS the original
		// confusion. Only the unaligned no-changes fallback (no turnId to
		// reconcile, nothing captured) stays hard-disabled.
		if (rolledBack) {
			// Phase 247: a RELOADED already-rolled-back turn keeps its
			// restored state — the button renders disabled ("Checkpoint
			// restored") instead of re-arming a finished rollback (the
			// live path applies the same state at restoreCheckpoint).
			undoBtn.classList.add('disabled');
			undoBtn.title = localize('vibeAIChat.checkpointRolledBack', "Checkpoint restored");
		} else if (turnIndex < 0 && rollbackCount === 0) {
			undoBtn.classList.add('disabled');
		} else {
			if (rollbackCount === 0) {
				undoBtn.classList.add('dim');
			}
			disposables.add(DOM.addDisposableListener(undoBtn, DOM.EventType.CLICK, () => {
				if (undoBtn.classList.contains('disabled')) {
					return;
				}
				if (turnIndex >= 0) {
					void this.restoreCheckpoint(conversation, turnIndex);
				} else {
					void this.restoreTurn(changes, undoBtn);
				}
			}));
		}

		// Copy the turn's final answer to the clipboard (sits where the
		// old checkpoint-timeline icon sat). `answerText` is the LAST text
		// run's slice (getFinalAnswerText) — narration runs folded into
		// the Worked shell never ride along; captured at render time, when
		// the footer renders once per turn and the answer is final.
		const copyBtn = DOM.append(footer, $('button.vibe-ai-icon-btn.codicon.codicon-copy')) as HTMLButtonElement;
		copyBtn.title = localize('vibeAIChat.copyAnswer', "Copy response");
		disposables.add(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, () => {
			void this.clipboardService.writeText(answerText);
		}));

		DOM.append(footer, $('span.spacer'));

		const time = DOM.append(footer, $('span.vibe-ai-turn-footer-time'));
		time.textContent = fromNowByDay(turnStartedAt, true, true);
	}

	/**
	 * Restore fallback for turns not tracked in the conversation's turn
	 * records (turnIndex -1): there are no later records to roll back
	 * through, so exactly this round's captured changes are reverted —
	 * updates restored to their pre-turn content, `create`s deleted again
	 * (`revertChanges`). The button is disabled while the restore runs
	 * and re-armed on failure.
	 */
	private async restoreTurn(changes: IVibeAICodeChange[], button: HTMLButtonElement): Promise<void> {
		button.classList.add('disabled');
		let allOk = true;
		try {
			allOk = await this.revertChanges(changes);
		} catch (err) {
			this.logService.error('[VibeAI] checkpoint restore failed', err);
			allOk = false;
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
	 * marked rolled-back and their restore buttons disabled. The
	 * rollback is persisted so it survives reloads.
	 *
	 * Phase 247: before reverting, each affected turn's record is
	 * reconciled against the server-side turn-transcript ledger
	 * (getTurnChanges) — rounds executed after a dead SSE connection
	 * never delivered their tool_result events, and without the merge
	 * the rollback would silently miss their file changes.
	 */
	private async restoreCheckpoint(conversation: VibeAIConversation, turnIndex: number): Promise<void> {
		if (conversation.stream) {
			this.abortStream(conversation);
		}
		const affected = conversation.turns.slice(turnIndex);
		// Phase 247: reconcile each affected turn's captured changes against
		// the server-side transcript ledger before reverting. Tool rounds
		// executed after the SSE connection died (the fetch's "TypeError:
		// terminated") never delivered their tool_result events, so the
		// local record can be incomplete even though the files changed on
		// disk — the transcript (flushed at every tool boundary) holds them.
		// consolidateChanges merges both views keeping the FIRST oldContent
		// (pre-turn baseline) and the LAST action per file; unreliable
		// transcript entries (trimmed old_content) are skipped server-side
		// and null (transcript gone / backend down) keeps the local record.
		for (const record of affected) {
			if (record.rolledBack || !record.turnId) {
				continue;
			}
			try {
				const remote = await this.vibeAIService.getTurnChanges(conversation.sessionId, record.turnId, this.conversationWorkspaceRoot(conversation));
				if (remote && remote.changes.length > 0) {
					record.turnChanges = consolidateChanges([...record.turnChanges, ...remote.changes]);
				}
			} catch (err) {
				this.logService.error('[VibeAI] turn-changes reconciliation failed', err);
			}
		}
		const rolledBackBefore = affected.filter(record => record.rolledBack).length;
		const allOk = await this.revertTurnRecordsNewestFirst(affected);
		// Phase 247: a reconcile-verified empty revert is no longer a silent
		// no-op — nothing was tracked for these turns (a read-only run, or
		// changes made outside write/edit/delete tools, e.g. terminal
		// commands). The dead button LOOK was the original confusion.
		const newlyRolled = affected.filter(record => record.rolledBack).length - rolledBackBefore;
		if (newlyRolled === 0 && allOk) {
			this.notificationService.info(localize(
				'vibeAIChat.checkpointNothingTracked',
				"No tracked file changes to revert for this turn — only write / edit / delete tool calls are tracked (terminal-command side effects are not)."
			));
			return;
		}
		// Disable the restore (↺) button of every rolled-back turn and
		// mark its footer. The copy button stays functional — the
		// conversation text is kept, only the files were reverted.
		for (const record of affected) {
			if (!record.rolledBack || !record.row) {
				continue;
			}
			const undoBtn = record.row.querySelector<HTMLButtonElement>('button.codicon-discard');
			if (undoBtn) {
				undoBtn.classList.add('disabled');
				undoBtn.title = localize('vibeAIChat.checkpointRolledBack', "Checkpoint restored");
			}
		}
		if (!allOk) {
			this.notificationService.warn(localize(
				'vibeAIChat.checkpointRollbackPartial',
				"Checkpoint restore finished with errors — some file changes may not have been reverted."
			));
		}
		// Keep the persisted turns in sync so the rollback survives reloads.
		this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)), conversation.mode, conversation.kind === 'side' ? { kind: 'side', parentSessionId: conversation.parentSessionId } : undefined, conversation.workspaceRoot);
		// Phase 120: re-apply the session goal after the save (setGoal is
		// the goal's authoritative writer — the save's stick covers stored
		// goals, this re-applies the live state, e.g. a goal set mid-turn).
		this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
		// Phase 56: rolled-back turns are no longer reviewable — the
		// docked review bar re-picks the latest remaining turn (or hides).
		this.renderDockedFilesSummary();
		this.renderTabs();
		this.updateInputActions();
	}

	/**
	 * Phase 109: reverts every turn record's file changes newest-first
	 * (restoreCheckpoint semantics) — shared by the checkpoint rollback
	 * and the edit-resend revert. Already-rolled-back records are
	 * skipped. Returns false when any revert failed.
	 */
	private async revertTurnRecordsNewestFirst(records: VibeAITurnRecord[]): Promise<boolean> {
		let allOk = true;
		for (let i = records.length - 1; i >= 0; i--) {
			const record = records[i];
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
		return allOk;
	}

	/**
	 * Phase 56: Cursor-parity review bar docked directly above the input
	 * box — the "N Files" row always sticks to the top of the input and
	 * never scrolls with the thread (reference parity). Shows the latest
	 * turn's file changes: the explicit `changes` list (a just-finished
	 * turn, tracked in the records or not) wins, otherwise the active
	 * conversation's newest non-rolled-back turn with changes. Hidden
	 * when there is nothing to review. Phase 88: kept turns (Keep
	 * clicked) are final — the pick skips them so re-entry (reload / tab
	 * switch) never resurrects the bar; `turnIndex` ties the bar to its
	 * turn record so Keep marks (and persists) the right turn. Phase 95:
	 * fully-resolved turns (every file kept or discarded, per-file marks
	 * on the turn's changes) are final too.
	 */
	private renderDockedFilesSummary(changes?: IVibeAICodeChange[], turnIndex?: number, resolved?: boolean): void {
		const dock = this.filesSummaryDock;
		if (!dock) {
			return;
		}
		// The bar's listeners die with the pane; cleared on every
		// re-render so a rebuilt bar starts clean.
		this.filesSummaryDisposables.clear();
		DOM.clearNode(dock);
		let latest = changes && changes.length > 0 ? changes : undefined;
		let latestIndex = turnIndex;
		if (!latest) {
			latestIndex = -1;
			const active = this.getActiveConversation();
			if (active) {
				for (let i = active.turns.length - 1; i >= 0; i--) {
					// Phase 95: fully-resolved turns (every file kept or
					// discarded) are final too — the bar never resurrects.
					if (!this.isTurnFullyResolved(active.turns[i]) && active.turns[i].turnChanges.length > 0) {
						latest = active.turns[i].turnChanges;
						latestIndex = i;
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
		this.renderFilesSummaryInto(consolidateChanges(latest), this.filesSummaryDisposables, latestIndex, resolved);
	}

	/**
	 * Cursor-parity files summary: collapsible "N Files" header with
	 * Discard / Keep (Cursor-parity review bar, shown when this turn
	 * modified or created a file) and a Review action (opens the most
	 * recently changed file in the editor). Phase 56: rendered into the
	 * docked review bar above the input box (never into the scrolling
	 * thread), so it always sticks to the top of the input. Phase 88:
	 * `turnIndex` ties the bar to its turn record — Keep marks the turn
	 * kept and the bar disappears (Cursor parity); the mark persists so
	 * re-entry never resurrects the bar for a kept turn. Phase 95: each
	 * file row carries its own Keep / Discard (one file at a time) and
	 * the editor keep-bar routes through the same per-file handlers.
	 * Phase 95 follow-up (user feedback): with `resolved` a fully-resolved
	 * bar stays visible — the buttons go, a status chip shows the outcome.
	 */
	private renderFilesSummaryInto(changes: IVibeAICodeChange[], disposables: DisposableStore, turnIndex?: number, resolved = false): void {
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
		// Phase 95 follow-up (user feedback): a fully-resolved bar stays
		// visible — the Discard / Keep buttons go and a status chip shows
		// the outcome (kept / discarded / mixed).
		if (hasFileEdit && resolved) {
			const status = DOM.append(header, $('span.vibe-ai-files-summary-status'));
			const allKept = changes.every(change => change.kept || change.action === 'delete');
			const allDiscarded = changes.every(change => change.discarded || change.action === 'delete');
			status.textContent = allKept
				? localize('vibeAIChat.filesKept', "Kept")
				: allDiscarded
					? localize('vibeAIChat.filesDiscarded', "Discarded")
					: localize('vibeAIChat.filesResolved', "Resolved");
			status.style.color = allKept
				? 'var(--vscode-charts-green)'
				: allDiscarded
					? 'var(--vscode-descriptionForeground, var(--vscode-foreground))'
					: 'var(--vscode-foreground)';
		}
		if (hasFileEdit && !resolved) {
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
					// Phase 95: every file of the turn is resolved — mark the
					// changes discarded (persisted; restored sessions never
					// resurrect their overlays). The per-change fields are
					// readonly — replace the turn's changes instead of
					// mutating them in place.
					const active = this.getActiveConversation();
					let finalChanges = changes;
					if (active && turnIndex !== undefined && turnIndex >= 0 && turnIndex < active.turns.length && !active.turns[turnIndex].kept) {
						const turn = active.turns[turnIndex];
						turn.turnChanges = turn.turnChanges.map(recorded => ({ ...recorded, kept: false, discarded: true }));
						if (this.isTurnFullyResolved(turn)) {
							turn.kept = true;
						}
						finalChanges = turn.turnChanges;
						this.persistTurns(active);
					}
					// Phase 95 follow-up (user feedback): the bar stays after a
					// Discard too — the buttons go, the status chip shows it.
					this.renderDockedFilesSummary(finalChanges, turnIndex, true);
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
				// already applied, Cursor behavior). Phase 95: resolve the
				// editor overlays FIRST — the green additions are the kept
				// content, the red deleted rows disappear and the editor
				// keep-bars stay up resolved (buttons go, status chip) —
				// then mark every change of the turn kept (persisted) so
				// re-entry never resurrects the bar with active buttons.
				this.resolveChangeOverlays(changes);
				const active = this.getActiveConversation();
				let finalChanges = changes;
				if (active && turnIndex !== undefined && turnIndex >= 0 && turnIndex < active.turns.length && !active.turns[turnIndex].kept) {
					const turn = active.turns[turnIndex];
					turn.kept = true;
					turn.turnChanges = turn.turnChanges.map(recorded => ({ ...recorded, kept: true, discarded: false }));
					finalChanges = turn.turnChanges;
					this.persistTurns(active);
				}
				// Phase 95 follow-up (user feedback): the bar stays after a
				// Keep — the Discard / Keep buttons go (a status chip shows
				// the outcome) instead of the whole bar disappearing.
				this.renderDockedFilesSummary(finalChanges, turnIndex, true);
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
			row.dataset['vibeAiFile'] = change.filePath;
			const icon = DOM.append(row, $('span.codicon.codicon-symbol-file'));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(row, $('span.vibe-ai-files-list-name'));
			name.textContent = change.filePath;
			name.title = change.filePath;
			if (change.newContent !== undefined) {
				this.appendFileStats(row, change.oldContent ?? '', change.newContent);
			}
			// Phase 95: per-file Keep / Discard — ONE file at a time. The
			// buttons reflect the change's review state (kept / discarded
			// ride on the turn record's change objects) and drive it: keep
			// resolves the file's editor overlay (green additions stay as
			// the content, red rows disappear), discard reverts the file
			// on disk. Deletions resolve implicitly (nothing to keep or
			// revert from the client).
			if (change.action !== 'delete' && change.newContent !== undefined && resolved) {
				// Phase 95 follow-up (user feedback): a resolved row keeps its
				// outcome as a status chip — no action buttons.
				const status = DOM.append(row, $('span.vibe-ai-files-list-status'));
				status.textContent = change.discarded ? localize('vibeAIChat.fileDiscarded', "Discarded") : localize('vibeAIChat.fileKept', "Kept");
				status.style.color = change.discarded
					? 'var(--vscode-descriptionForeground, var(--vscode-foreground))'
					: 'var(--vscode-charts-green)';
			}
			if (change.action !== 'delete' && change.newContent !== undefined && !resolved) {
				const actions = DOM.append(row, $('span.vibe-ai-files-list-actions'));
				const keepRow = DOM.append(actions, $('button.vibe-ai-files-list-row-action.vibe-ai-files-list-keep')) as HTMLButtonElement;
				keepRow.textContent = change.kept ? localize('vibeAIChat.fileKept', "Kept") : localize('vibeAIChat.fileKeep', "Keep");
				keepRow.title = localize('vibeAIChat.fileKeepTitle', "Keep this file's changes and clear the change marks");
				const discardRow = DOM.append(actions, $('button.vibe-ai-files-list-row-action.vibe-ai-files-list-discard')) as HTMLButtonElement;
				discardRow.textContent = change.discarded ? localize('vibeAIChat.fileDiscarded', "Discarded") : localize('vibeAIChat.fileDiscard', "Discard");
				discardRow.title = localize('vibeAIChat.fileDiscardTitle', "Revert this file to its pre-change content");
				if (change.kept || change.discarded) {
					keepRow.classList.add('disabled');
				}
				if (change.discarded) {
					discardRow.classList.add('disabled');
				}
				disposables.add(DOM.addDisposableListener(keepRow, DOM.EventType.CLICK, e => {
					e.preventDefault();
					e.stopPropagation();
					if (keepRow.classList.contains('disabled')) {
						return;
					}
					keepRow.classList.add('disabled');
					this.keepFileChange(change);
				}));
				disposables.add(DOM.addDisposableListener(discardRow, DOM.EventType.CLICK, e => {
					e.preventDefault();
					e.stopPropagation();
					if (discardRow.classList.contains('disabled')) {
						return;
					}
					discardRow.classList.add('disabled');
					keepRow.classList.add('disabled');
					void this.discardFileChange(change).then(ok => {
						if (!ok) {
							// The revert failed — re-arm the row's buttons
							// (the file keeps its current on-disk state).
							discardRow.classList.remove('disabled');
							if (!change.kept && !change.discarded) {
								keepRow.classList.remove('disabled');
							}
						}
					});
				}));
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
					// Phase 225: a selection jump needs the raw text editor —
					// bypass the markdown Preview default resolver.
					override: DEFAULT_EDITOR_ASSOCIATION.id,
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

	// ==================== Phase 95: per-file Keep / Discard (Cursor parity) ====================

	/**
	 * Phase 95: per-file Keep — ONE file at a time (the editor keep-bar
	 * and the files list rows route here). The file's red/green overlay
	 * resolves FIRST: the green additions ARE the kept on-disk content
	 * (agent writes are already applied), the red deleted rows disappear
	 * and the editor keep-bar stays up resolved (buttons go, a status
	 * chip shows the outcome). Then the file is marked resolved in its
	 * turn record (persisted) — a fully-resolved turn is final, the bar
	 * never resurrects for it.
	 */
	private keepFileChange(change: IVibeAICodeChange): void {
		this.resolveChangeOverlays([change]);
		const marked = this.markFileResolved(change.filePath, 'kept');
		if (marked) {
			this.persistTurns(marked.conversation);
		}
		if (marked && this.isTurnFullyResolved(marked.turn)) {
			// The whole turn is final — the bar STAYS (user feedback: it no
			// longer disappears) in its resolved state: the buttons go, a
			// status chip shows the outcome. A reload still re-picks only
			// unresolved turns, so the resolved bar never resurrects.
			this.renderDockedFilesSummary(marked.turn.turnChanges, undefined, true);
		} else {
			// The row updates in place — a later full re-render picks the
			// flags back up from the turn record.
			this.refreshFilesListRow(change.filePath, true, false);
		}
	}

	/**
	 * Phase 95: per-file Discard — the file reverts FIRST: a failed
	 * revert leaves the row's buttons and the keep-bar re-armed (the
	 * callers re-enable them) and returns false. On success the file is
	 * marked discarded in its turn record (persisted).
	 */
	private async discardFileChange(change: IVibeAICodeChange): Promise<boolean> {
		const ok = await this.revertChanges([change]);
		if (!ok) {
			this.notificationService.warn(localize('vibeAIChat.fileDiscardFailed', "Failed to revert {0}", change.filePath));
			return false;
		}
		// The revert's restore hook already resolved the overlay (the
		// keep-bar stays up in the discarded state).
		const marked = this.markFileResolved(change.filePath, 'discarded');
		if (marked) {
			this.persistTurns(marked.conversation);
		}
		if (marked && this.isTurnFullyResolved(marked.turn)) {
			// Phase 95 follow-up (user feedback): the bar stays resolved —
			// the buttons go, the status chip shows the outcome.
			this.renderDockedFilesSummary(marked.turn.turnChanges, undefined, true);
		} else {
			this.refreshFilesListRow(change.filePath, false, true);
		}
		return true;
	}

	/**
	 * Phase 95: resolves the editor overlays (red/green highlight + the
	 * keep-bar's buttons) of the given changes — the pane-side half of
	 * "finalize the diff view". The state rides along so a resolved
	 * keep-bar shows the right outcome chip (kept / discarded).
	 */
	private resolveChangeOverlays(changes: IVibeAICodeChange[], state: 'kept' | 'discarded' = 'kept'): void {
		for (const change of changes) {
			const uri = this.resolveWorkspacePath(change.filePath);
			if (uri) {
				this.editorHighlighter?.resolveForUri(uri, state);
			}
		}
	}

	/**
	 * Phase 95: marks ONE file resolved (kept / discarded) — the newest
	 * not-yet-final turn touching the file wins and its change object
	 * carries the mark so the persisted turn record rides along. The
	 * active conversation is searched first, then the background tabs
	 * (the editor keep-bar is file-driven — the write may belong to
	 * another tab's turn). Returns the marked turn + its conversation
	 * (undefined when no turn record holds the file).
	 */
	private markFileResolved(filePath: string, state: 'kept' | 'discarded'): { conversation: VibeAIConversation; turn: VibeAITurnRecord } | undefined {
		const active = this.getActiveConversation();
		const marked = active ? this.markFileResolvedIn(active, filePath, state) : undefined;
		if (active && marked) {
			return { conversation: active, turn: marked };
		}
		for (const conversation of this.conversations) {
			if (conversation === active) {
				continue;
			}
			const turn = this.markFileResolvedIn(conversation, filePath, state);
			if (turn) {
				return { conversation, turn };
			}
		}
		return undefined;
	}

	private markFileResolvedIn(conversation: VibeAIConversation, filePath: string, state: 'kept' | 'discarded'): VibeAITurnRecord | undefined {
		for (let i = conversation.turns.length - 1; i >= 0; i--) {
			const turn = conversation.turns[i];
			if (turn.kept || turn.rolledBack) {
				continue;
			}
			const idx = turn.turnChanges.findIndex(candidate => candidate.filePath === filePath);
			if (idx === -1) {
				continue;
			}
			// The per-change fields are readonly — the mark lands as an
			// element replacement riding on the persisted turn record.
			turn.turnChanges[idx] = {
				...turn.turnChanges[idx],
				kept: state === 'kept',
				discarded: state === 'discarded',
			};
			// Every change of the turn resolved → the turn is final (the
			// review bar never resurrects for it).
			if (this.isTurnFullyResolved(turn)) {
				turn.kept = true;
			}
			return turn;
		}
		return undefined;
	}

	/**
	 * Phase 95: a turn is fully resolved when every file change carries a
	 * keep/discard mark — deletions resolve implicitly (nothing to keep
	 * or revert from the client). A fully-resolved turn is final: the
	 * review bar and the editor keep-bar never resurrect for it.
	 */
	private isTurnFullyResolved(turn: VibeAITurnRecord): boolean {
		return turn.kept || turn.rolledBack || (turn.turnChanges.length > 0 && turn.turnChanges.every(change => change.kept || change.discarded || change.action === 'delete'));
	}

	/**
	 * Phase 95: updates ONE files-list row in place after a per-file
	 * keep/discard — the buttons reflect the new state (a kept row keeps
	 * both buttons disabled; a discarded row likewise).
	 */
	private refreshFilesListRow(filePath: string, kept: boolean, discarded: boolean): void {
		const dock = this.filesSummaryDock;
		if (!dock) {
			return;
		}
		for (const row of Array.from(dock.querySelectorAll<HTMLElement>('.vibe-ai-files-list-row'))) {
			if (row.dataset['vibeAiFile'] !== filePath) {
				continue;
			}
			const keepRow = row.querySelector<HTMLButtonElement>('.vibe-ai-files-list-keep');
			const discardRow = row.querySelector<HTMLButtonElement>('.vibe-ai-files-list-discard');
			if (!keepRow || !discardRow) {
				continue;
			}
			keepRow.textContent = kept ? localize('vibeAIChat.fileKept', "Kept") : localize('vibeAIChat.fileKeep', "Keep");
			keepRow.classList.toggle('disabled', kept || discarded);
			discardRow.textContent = discarded ? localize('vibeAIChat.fileDiscarded', "Discarded") : localize('vibeAIChat.fileDiscard', "Discard");
			discardRow.classList.toggle('disabled', discarded);
		}
	}

	/** Phase 95: best-effort persistence of a conversation's turn records. */
	private persistTurns(conversation: VibeAIConversation): void {
		try {
			this.sessionStore.save(conversation.sessionId, conversation.history, conversation.contextLimit, conversation.turns.map(turn => this.toPersistedTurn(turn)), conversation.mode, conversation.kind === 'side' ? { kind: 'side', parentSessionId: conversation.parentSessionId } : undefined, conversation.workspaceRoot);
			// Phase 120: re-apply the session goal after the save (setGoal
			// is the goal's authoritative writer — the save's stick covers
			// stored goals, this re-applies the live state, e.g. a goal
			// set mid-turn).
			this.sessionStore.setGoal(conversation.sessionId, conversation.goal, conversation.goalComplete === true);
		} catch (err) {
			this.logService.error('[VibeAI] failed to persist chat session', err);
		}
	}

	/**
	 * Phase 95: restored writes re-arm the editor highlighter — unless the
	 * change (or its whole turn) was already resolved: the red/green
	 * overlay and keep-bar must never resurrect for a kept / discarded
	 * file after a reload or tab switch. The per-file marks live on the
	 * turn's recorded changes (the tool's own codeChange is a separate
	 * object) — matched by path. Phase 110: the recorded entry is the
	 * turn's consolidated change (pre-turn baseline vs final content) and
	 * is what gets registered — the per-tool codeChange only carries its
	 * own step's diff, which would drop a multi-write turn's earlier
	 * lines; sessions without turn changes fall back to the tool's change.
	 */
	private registerRestoredHighlight(turn: IVibeAIPersistedTurn, change: IVibeAICodeChange): void {
		if (turn.kept || turn.rolledBack) {
			return;
		}
		const recorded = (turn.turnChanges ?? []).find(candidate => candidate.filePath === change.filePath);
		if (recorded && (recorded.kept || recorded.discarded)) {
			return;
		}
		this.editorHighlighter?.registerRestored(recorded ?? change, path => this.resolveWorkspacePath(path));
	}

	/** Resolves a backend path against the workspace root. */
	private resolveWorkspacePath(path: string, root?: string): URI | undefined {
		try {
			if (/^([a-zA-Z]:[\\/]|\/)/.test(path)) {
				return URI.file(path);
			}
			// Phase 223: relative paths anchor to the conversation's project —
			// explicit root first (the plan doc entry pins its conversation's
			// root at doc-start), the active conversation's root otherwise
			// (Agent Window parity: the neutral window workspace has no
			// folders[0], the hub binds every conversation to a project),
			// the window folder as the last resort.
			const base = root ?? this.activeWorkspaceRoot();
			if (!base) {
				return undefined;
			}
			return URI.joinPath(URI.file(base), path.replace(/\\/g, '/'));
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
		this.stopRestoreChase();
		super.dispose();
	}

	private setMode(mode: VibeAIChatMode): void {
		this.mode = mode;
		// Phase 93: the mode is per conversation — write it straight onto
		// the active one too (not just the mirror field), so a background
		// turn finish persists it and a later tab switch restores it.
		const active = this.getActiveConversation();
		if (active) {
			active.mode = mode;
		}
		this.updateModeLabel();
		// Phase 248: the mode changes what the next turn actually sends
		// (Ask's read-only subset / Plan's whitelist vs the agent set) —
		// the estimate follows the pick instead of waiting for the next
		// natural refresh.
		void this.refreshContextUsage();
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
		// Reflect default/selection changes from the settings dialog live.
		this.model = this.configurationService.getValue<string>('vibeAI.chat.model') || 'Auto';
		// Phase 227: the menu shape is shared with the plan doc pane's header
		// dropdown (vibeAIModelMenu.ts) — persistence/focus stay here.
		const actions = buildModelMenuActions({
			modelStore: this.modelStore,
			currentModel: this.model,
			autoMode: this.autoMode,
			setModel: model => this.setModel(model),
			setAutoMode: mode => this.setAutoMode(mode),
			inputCustomModel: async current => {
				try {
					return await this.quickInputService.input({
						title: localize('vibeAIChat.modelCustomTitle', "Custom model name"),
						placeHolder: localize('vibeAIChat.modelCustomPlaceholder', "e.g. my-model (empty = Auto)"),
						value: current !== 'Auto' ? current : '',
					});
				} catch (err) {
					this.logService.debug('[VibeAI] model input cancelled', err);
					return undefined;
				}
			},
		});
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
	 * Phase 184: routes into the given sink (an open edit box attaches to
	 * its own per-message set); defaults to the main composer.
	 */
	private attachActiveFile(sink: VibeAIAttachmentSink = this.mainAttachmentSink()): void {
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!model) {
			return;
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		const relPath = folder ? relativePath(folder.uri, model.uri) : undefined;
		const displayPath = relPath ?? basename(model.uri);
		if (sink.files.some(f => f.path === displayPath)) {
			return;
		}
		const content = model.getValue();
		sink.files.push({
			path: displayPath,
			content: content.length > FILE_CONTEXT_MAX_CHARS ? content.substring(0, FILE_CONTEXT_MAX_CHARS) : content,
		});
		sink.refresh();
	}

	/**
	 * Phase 184: the main composer's attachment sink — wraps the pane-level
	 * pending set (mirrored per conversation). Created per operation so a
	 * tab switch mid-read never reroutes the writes (same contract as the
	 * old `target` capture in attachDroppedResources).
	 */
	private mainAttachmentSink(): VibeAIAttachmentSink {
		return {
			files: this.attachedFiles,
			images: this.attachedImages,
			pendingFileReads: this.pendingFileReads,
			pendingImageReads: this.pendingImageReads,
			refresh: () => {
				this.renderChips();
				this.updateInputActions();
				// Phase 248: pending attachments are part of what the next
				// request carries (context.files) — the ring follows the
				// chips as they land or are removed (edit-box sinks skip
				// this: their per-message set only matters at re-dispatch,
				// which refreshes then).
				void this.refreshContextUsage();
			},
		};
	}

	/** Phase 184: an open prompt edit's own attachment sink (per-message set). */
	private editAttachmentSink(edit: VibeAIPromptEdit): VibeAIAttachmentSink {
		return {
			files: edit.files,
			images: edit.images,
			pendingFileReads: edit.pendingFileReads,
			pendingImageReads: edit.pendingImageReads,
			refresh: () => {
				this.renderChips();
				this.updateEditToolbarActions();
			},
		};
	}

	private renderChips(): void {
		// Phase 48: chips render into the main input AND an open edit box.
		// Phase 184: each composer renders its OWN attachment set — the
		// edit box shows the edited message's attachments (removable,
		// addable) and never mirrors the input below anymore.
		this.renderChipsInto(this.chipsRow, this.chipsDisposables, this.mainAttachmentSink());
		const edit = this.promptEdit;
		if (edit?.chipsRow) {
			this.renderChipsInto(edit.chipsRow, edit.chipsListeners, this.editAttachmentSink(edit));
		}
	}

	/** Renders one composer's attachment chips (its own sink) into its chips row. */
	private renderChipsInto(row: HTMLElement | undefined, listeners: DisposableStore, sink: VibeAIAttachmentSink): void {
		const rowEl = row;
		if (!rowEl) {
			return;
		}
		listeners.clear();
		DOM.clearNode(rowEl);
		rowEl.style.display = (sink.files.length > 0 || sink.images.length > 0 || sink.pendingImageReads.size > 0) ? 'flex' : 'none';
		// Phase 61: pasted-image chips — thumbnail + remove.
		sink.images.forEach((dataUrl, index) => {
			const chip = DOM.append(rowEl, $('.vibe-ai-chip.vibe-ai-image-chip'));
			const img = DOM.append(chip, $('img.vibe-ai-image-chip-thumb')) as HTMLImageElement;
			img.src = dataUrl;
			img.alt = '';
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIChat.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				sink.images.splice(index, 1);
				sink.refresh();
			}));
		});
		// Phase 171: images still decoding render as dashed spinner tiles —
		// the thumbnails replace them as each read settles.
		for (let i = 0; i < sink.pendingImageReads.size; i++) {
			const chip = DOM.append(rowEl, $('.vibe-ai-chip.vibe-ai-image-chip.vibe-ai-image-loading'));
			DOM.append(chip, $('span.codicon.codicon-loading.codicon-modifier-spin.vibe-ai-chip-spinner'));
		}
		for (const file of sink.files) {
			// Phase 171: a read still in flight renders the chip with a
			// spinner in place of the file icon; the content lands when it
			// settles (finalizeDroppedFile) or the chip comes off with an
			// error (dropPlaceholderFile).
			const pending = sink.pendingFileReads.has(file.path);
			const chip = DOM.append(rowEl, $('.vibe-ai-chip' + (pending ? '.vibe-ai-chip-loading' : '')));
			// Phase 105: dropped folders render the folder icon.
			const icon = DOM.append(chip, $('span.codicon' + (pending
				? '.codicon-loading.codicon-modifier-spin.vibe-ai-chip-spinner'
				: (file.kind === 'folder' ? '.codicon-symbol-folder' : '.codicon-symbol-file'))));
			icon.setAttribute('aria-hidden', 'true');
			const name = DOM.append(chip, $('span.vibe-ai-chip-name'));
			name.textContent = file.path;
			name.title = pending ? localize('vibeAIChat.chipReading', "Reading…") : file.path;
			const remove = DOM.append(chip, $('button.codicon.codicon-close.vibe-ai-chip-remove')) as HTMLButtonElement;
			remove.title = localize('vibeAIChat.chipRemove', "Remove from context");
			listeners.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => {
				// Phase 184: in-place splice — the sink holds the live array
				// (a reassignment would orphan the conversation mirror).
				const index = sink.files.indexOf(file);
				if (index >= 0) {
					sink.files.splice(index, 1);
				}
				sink.pendingFileReads.delete(file.path);
				sink.refresh();
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
	/**
	 * Phase 147: the editor's opened folder as an absolute path (Cursor
	 * parity: the agent follows the workspace) — sent as `workspaceRoot`
	 * on every backend request so the backend rebinds its tools / RAG
	 * index / rules / skills to it. Empty string = no folder open (the
	 * backend refuses tool calls instead of silently binding its own
	 * source root).
	 */
	private currentWorkspaceRoot(): string {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
	}

	/**
	 * Phase 177: the workspace root a conversation's requests carry — the
	 * conversation's own project folder when it has one (Agent Window
	 * parity: continue a project-A conversation from a folder-less window
	 * and the backend still rebinds to project A), the window's folder
	 * otherwise.
	 */
	private conversationWorkspaceRoot(conversation: VibeAIConversation): string {
		return conversation.workspaceRoot ?? this.currentWorkspaceRoot();
	}

	/**
	 * Phase 177: workspace root for actions outside a request payload
	 * (checkpoint rollback, skills menu, the agent terminal) — the active
	 * conversation's project folder when present, the window's folder
	 * otherwise (Agent Window parity: the actions keep targeting the
	 * project the conversation belongs to).
	 */
	private activeWorkspaceRoot(): string {
		const active = this.getActiveConversation();
		return active ? this.conversationWorkspaceRoot(active) : this.currentWorkspaceRoot();
	}

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
		// Phase 248: the composer mode is per conversation too — a background
		// tab's refresh used to read the ACTIVE tab's mode here, estimating
		// the wrong static context (Ask's read-only subset vs the agent set).
		const mode = isActive ? this.mode : conversation.mode;
		// Phase 248: a running turn's live activity rides the estimate —
		// the narration and tool results already streamed are on the wire
		// (the backend's next round pays them), so the ring tracks the
		// turn while it works instead of jumping only at settle.
		const stream = conversation.stream;
		const liveTurn = stream
			? {
				text: stream.turn.text,
				tools: [...stream.toolCards.values()].map(card => card.snapshot()),
			}
			: undefined;
		try {
			const usage = await this.vibeAIService.contextUsage({
				messages: [...history],
				...(attachedFiles.length > 0 ? { context: { files: attachedFiles } } : {}),
				contextLimit,
				// Ask mode estimates against the read-only tool subset.
				readonly: mode !== 'agent',
				// Phase 240: plan mode estimates against PLAN prompt + the
				// plan whitelist (ask_questions included) — estimate = sent.
				planMode: mode === 'plan',
				// Phase 116: Side Chat — the `parent` row counts the same
				// capped reference the turns actually send (estimate ≡
				// sent). Main tabs omit it.
				...(conversation.kind === 'side'
					? { parentContext: this.buildParentContext(conversation.parentSessionId) }
					: {}),
				// Phase 120: the `goal` row counts the same objective the
				// turns actually send (estimate = sent). No goal = omitted.
				...(conversation.goal ? { goal: conversation.goal } : {}),
				// Phase 157: the `plan` row counts the same agreed plan file
				// the agent turns actually send (estimate = sent). Ask mode
				// and plan-less conversations omit it.
				...(mode === 'agent' && conversation.planPath ? { planFile: conversation.planPath } : {}),
				// Phase 248: the running turn's live tool activity (omitted
				// when nothing is streaming or the turn has no activity yet).
				...(liveTurn && (liveTurn.text || liveTurn.tools?.length) ? { liveTurn } : {}),
				// Phase 147: estimate against the opened folder (rules /
				// skills / MCP are workspace-scoped) — estimate ≡ sent.
				// Phase 177: conversation-bound folder wins (Agent Window).
				workspaceRoot: this.conversationWorkspaceRoot(conversation),
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

	/**
	 * Phase 248: the ring tracks a RUNNING turn in real time — stream
	 * events that grow what the next LLM round pays (narration deltas,
	 * tool results, closed rounds) schedule ONE throttled refresh per
	 * window instead of hitting the estimate endpoint per event. The
	 * refresh targets the conversation that owns the stream (a background
	 * tab's activity updates its stored usage; the ring re-renders on
	 * activation, whose hook refreshes anyway).
	 */
	private scheduleLiveContextRefresh(conversation: VibeAIConversation): void {
		if (this.liveContextRefreshQueued || this._store.isDisposed) {
			return;
		}
		this.liveContextRefreshQueued = true;
		setTimeout(() => {
			this.liveContextRefreshQueued = false;
			if (this._store.isDisposed) {
				return;
			}
			void this.refreshContextUsage(conversation);
		}, LIVE_CONTEXT_REFRESH_MS);
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
		// Phase 117: an `@side:<name>` mention being typed opens the
		// side-chat completion instead of the `/` skill menu — the two
		// triggers are mutually exclusive (a caret token cannot start with
		// both `@` and `/`).
		const mentionToken = this.mentionQueryToken();
		if (mentionToken !== undefined) {
			this.updateMentionMenu(mentionToken);
			return;
		}
		const token = this.skillCommandToken();
		if (token === undefined) {
			this.closeSkillMenu();
			return;
		}
		if (!this.skillListLoaded) {
			this.skillListLoaded = true;
			try {
				this.skillList = await this.vibeAIService.listSkills(this.activeWorkspaceRoot());
			} catch (err) {
				this.skillListLoaded = false;
				this.logService.debug('[VibeAI] skills request failed', err);
				return;
			}
			// Phase 127: file-defined subagents load alongside the skills
			// (Agent mode only — /name dispatch is an agent-mode command);
			// same lazy-load + refresh-after-send lifecycle as the skills.
			this.subagentList = this.mode === 'agent'
				? await this.vibeAIService.listSubagents(this.activeWorkspaceRoot()).catch(err => {
					this.logService.debug('[VibeAI] subagents request failed', err);
					return [];
				})
				: [];
			// The await may have raced an input change — re-read the token.
			if (this.skillCommandToken() === undefined) {
				return;
			}
		}
		const query = token.toLowerCase();
		// Phase 116: the built-in `/side` entry (frontend-only side-chat
		// command) leads the pool ahead of the workspace skills — picking
		// it fills `/side ` and the question follows; send() strips the
		// prefix and opens the side chat.
		const sideEntry: IVibeAISkill = {
			name: 'side',
			description: localize('vibeAIChat.skillSide', "Side chat — ask in a separate thread with this conversation as read-only reference"),
			disableModelInvocation: false,
			source: 'builtin',
		};
		// Phase 120: the built-in /goal entry (frontend-only session-goal
		// command) leads the pool ahead of /side and the workspace skills
		// — picking it fills `/goal ` and the objective follows;
		// handleGoalCommand strips the prefix, sets the session goal (the
		// banner) and kicks the turn off.
		const goalEntry: IVibeAISkill = {
			name: 'goal',
			description: localize('vibeAIChat.skillGoal', "Goal — set a long-lived objective this conversation works towards until it's complete"),
			disableModelInvocation: false,
			source: 'builtin',
		};
		// Phase 127: subagent entries ride the same pool — picking fills
		// `/name `; send() keeps the message and the backend intercepts it
		// for the explicit single-subagent dispatch (Agent mode).
		const agentEntries: IVibeAISkill[] = this.subagentList.map(a => ({
			name: a.name,
			description: localize('vibeAIChat.skillSubagent', "Subagent — {0}", a.description),
			disableModelInvocation: false,
			source: a.source,
		}));
		const matches = [sideEntry, ...this.skillList, ...agentEntries].filter(skill => !query || skill.name.toLowerCase().startsWith(query));
		if (!query || 'goal'.startsWith(query)) {
			matches.unshift(goalEntry);
		}
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
		// Phase 117: skill rows replace any stale mention state — the
		// keyboard pick routes on this flag.
		this.mentionEntries = undefined;
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
		// Phase 117: mention rows pick through the entry object (the
		// canonical `@side:<title>` insert) — the skill pick below reads
		// the DOM name and only fits `/name` rows.
		const mention = this.mentionEntries?.[this.skillMenuIndex];
		if (mention) {
			this.pickMention(mention);
			return;
		}
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
		this.mentionEntries = undefined;
		this.skillMenuDisposables.clear();
		this.skillRowsDisposables.clear();
	}

	// ==================== Phase 117: `@side:` mention completion (Cursor parity @ side chats) ====================

	/**
	 * An `@token` being typed: the text from the caret back to the last
	 * whitespace (or input start) matching `@<chars>` — `undefined` when
	 * no mention query is active. Mirrors `skillCommandToken`; the two
	 * triggers never fire together (a caret token starts with one of
	 * `@` / `/`, never both).
	 */
	private mentionQueryToken(): string | undefined {
		const input = this.inputElement;
		if (!input) {
			return undefined;
		}
		const upToCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
		const match = /(?:^|\s)@([^\s]*)$/.exec(upToCaret);
		return match ? match[1] : undefined;
	}

	/**
	 * The mention pool: the CURRENT conversation's side chats (Cursor
	 * parity @ side chats) — live tabs first (always fresh turns), then
	 * the persisted store (the restart path), deduped by session id with
	 * the live entry winning. Other conversations' side chats never
	 * appear; a conversation with none (fresh main, any side tab's own
	 * children) lists nothing.
	 */
	private listActiveSideChats(): VibeAISideMentionEntry[] {
		const active = this.getActiveConversation();
		if (!active) {
			return [];
		}
		const entries = new Map<string, VibeAISideMentionEntry>();
		for (const conversation of this.conversations) {
			if (conversation.kind === 'side' && conversation.parentSessionId === active.sessionId) {
				entries.set(conversation.sessionId, {
					sessionId: conversation.sessionId,
					title: conversation.title,
					turns: conversation.turns,
				});
			}
		}
		for (const session of this.sessionStore.list()) {
			if (session.kind === 'side' && session.parentSessionId === active.sessionId && !entries.has(session.id)) {
				entries.set(session.id, {
					sessionId: session.id,
					title: session.title,
					turns: session.turns ?? [],
				});
			}
		}
		return [...entries.values()];
	}

	/**
	 * Opens/filters/closes the `@side:` mention popup from the current
	 * input state — the pool is the current conversation's side chats
	 * (listActiveSideChats); the typed prefix (after the `side:` marker)
	 * filters on the title (case-insensitive includes — CJK titles). No
	 * candidates = no menu.
	 */
	private updateMentionMenu(token: string): void {
		const query = token.replace(/^side:/i, '').toLowerCase();
		const entries = this.listActiveSideChats().filter(entry => query.length === 0 || entry.title.toLowerCase().includes(query));
		if (entries.length === 0) {
			this.closeSkillMenu();
			return;
		}
		if (!this.skillMenu) {
			this.buildSkillMenu();
		}
		this.renderMentionList(entries);
		this.positionSkillMenu();
	}

	/**
	 * Re-renders the popup rows for mentions: `@side:<title>` + a turns
	 * hint. Reuses the skill row classes so the keyboard navigation, the
	 * click-outside dismiss and the CSS all work unchanged.
	 */
	private renderMentionList(entries: VibeAISideMentionEntry[]): void {
		const menu = this.skillMenu;
		const list = menu?.querySelector('.vibe-ai-skill-list');
		if (!menu || !(list instanceof HTMLElement)) {
			return;
		}
		this.mentionEntries = entries;
		this.skillRowsDisposables.clear();
		DOM.clearNode(list);
		this.skillMenuIndex = 0;
		entries.forEach((entry, index) => {
			const row = DOM.append(list, $('.vibe-ai-skill-row'));
			row.setAttribute('role', 'option');
			row.classList.toggle('active', index === 0);
			const name = DOM.append(row, $('span.vibe-ai-skill-name'));
			name.textContent = `@side:${entry.title}`;
			const desc = DOM.append(row, $('span.vibe-ai-skill-desc'));
			desc.textContent = localize('vibeAIChat.mentionDesc', "Side chat — {0} Q&A turns pulled in as read-only reference on send", entry.turns.length);
			row.title = desc.textContent;
			this.skillRowsDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				this.pickMention(entry);
			}));
		});
	}

	/** Click pick: replace the typed `@token` with the canonical `@side:<title> `. */
	private pickMention(entry: VibeAISideMentionEntry): void {
		this.replaceMentionToken(`@side:${entry.title}`);
		this.closeSkillMenu();
		this.inputElement?.focus();
	}

	/**
	 * Replaces the `@token` at the caret with `replacement` + a trailing
	 * space — the message keeps the `@side:<title>` mention so the send
	 * resolver appends the side chat's `<side_chat>` block.
	 */
	private replaceMentionToken(replacement: string): void {
		const input = this.inputElement;
		if (!input) {
			return;
		}
		const caret = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, caret);
		const after = input.value.slice(caret);
		const match = /(?:^|\s)@([^\s]*)$/.exec(before);
		if (!match) {
			return;
		}
		const atPos = caret - match[1].length - 1;
		input.value = input.value.slice(0, atPos) + replacement + ' ' + after;
		const nextCaret = atPos + replacement.length + 1;
		input.setSelectionRange(nextCaret, nextCaret);
		this.autoGrowInput();
		this.updateInputActions();
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
		// --- Phase 123: search scope — "All chats" (cross-session: stored
		// titles + prompts + final answers) / "This chat" (the active
		// conversation's live history). The scope sticks across menu
		// open/close; a click re-renders the list with the current query.
		const scope = DOM.append(search, $('.vibe-ai-history-search-scope'));
		const scopeButtons: Array<{ value: 'session' | 'all'; button: HTMLButtonElement }> = [];
		const syncScope = () => {
			for (const entry of scopeButtons) {
				const active = this.historySearchScope === entry.value;
				entry.button.classList.toggle('active', active);
				entry.button.setAttribute('aria-pressed', String(active));
			}
		};
		for (const option of [
			{ value: 'session' as const, label: localize('vibeAIChat.historyScopeSession', "This chat") },
			{ value: 'all' as const, label: localize('vibeAIChat.historyScopeAll', "All chats") },
		]) {
			const scopeButton = DOM.append(scope, $('button.vibe-ai-history-scope-btn')) as HTMLButtonElement;
			scopeButton.type = 'button';
			scopeButton.textContent = option.label;
			scopeButtons.push({ value: option.value, button: scopeButton });
			store.add(DOM.addDisposableListener(scopeButton, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				if (this.historySearchScope !== option.value) {
					this.historySearchScope = option.value;
					syncScope();
					this.renderHistoryList(list, searchInput.value);
				}
				searchInput.focus();
			}));
		}
		syncScope();

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
	 * then the recency groups Today / Previous 7 days / Older. Phase 123:
	 * a non-empty query searches content instead — cross-session ("All
	 * chats": stored titles + prompts + final answers) or the active
	 * conversation ("This chat"); the plain session list only renders for
	 * an empty query.
	 */
	private renderHistoryList(list: HTMLElement, query: string): void {
		this.historyRowsDisposables.clear();
		DOM.clearNode(list);
		const needle = query.trim().toLowerCase();
		if (needle.length > 0) {
			this.renderHistorySearchHits(list, needle);
			return;
		}
		const sessions = this.sessionStore.list();

		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
		let count = 0;
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyPinned', "Pinned"), sessions.filter(session => session.pinned));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyToday', "Today"), sessions.filter(session => !session.pinned && session.updatedAt >= todayStart));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyPrevious7Days', "Previous 7 days"), sessions.filter(session => !session.pinned && session.updatedAt >= weekStart && session.updatedAt < todayStart));
		count += this.renderHistoryGroup(list, localize('vibeAIChat.historyOlder', "Older"), sessions.filter(session => !session.pinned && session.updatedAt < weekStart));
		if (count === 0) {
			const empty = DOM.append(list, $('.vibe-ai-history-empty'));
			empty.textContent = localize('vibeAIChat.historyNoChats', "No chats yet");
		}
	}

	/**
	 * Phase 123: renders the content-search hit list — grouped by
	 * conversation, one row per hit (kind badge + matched snippet).
	 * "All chats" searches every stored session (title + prompts + final
	 * answers, case-insensitive); "This chat" searches the active
	 * conversation's live history. A hit opens its conversation and lands
	 * on the matched turn. Keyboard nav reuses the row classes (Esc /
	 * ArrowUp / ArrowDown behave like the session list).
	 */
	private renderHistorySearchHits(list: HTMLElement, needle: string): void {
		const hits = this.historySearchScope === 'all'
			? this.sessionStore.searchContent(needle)
			: this.searchActiveConversation(needle);
		if (hits.length === 0) {
			const empty = DOM.append(list, $('.vibe-ai-history-empty'));
			empty.textContent = localize('vibeAIChat.historyNoMatches', "No matching chats");
			return;
		}
		// Group the hits by conversation (store order = recency order;
		// "This chat" yields a single group).
		const groups = new Map<string, { title: string; hits: IVibeAIChatSearchHit[] }>();
		for (const hit of hits) {
			let group = groups.get(hit.sessionId);
			if (!group) {
				group = { title: hit.sessionTitle, hits: [] };
				groups.set(hit.sessionId, group);
			}
			group.hits.push(hit);
		}
		for (const group of groups.values()) {
			const groupEl = DOM.append(list, $('.vibe-ai-history-group'));
			const label = DOM.append(groupEl, $('.vibe-ai-history-group-label'));
			label.textContent = group.title;
			for (const hit of group.hits) {
				const item = DOM.append(groupEl, $('.vibe-ai-history-item.vibe-ai-history-hit'));
				item.tabIndex = -1;
				item.setAttribute('role', 'menuitem');
				const badge = DOM.append(item, $('span.vibe-ai-history-hit-kind'));
				badge.textContent = hit.kind === 'title'
					? localize('vibeAIChat.historyHitTitle', "Title")
					: hit.kind === 'user'
						? localize('vibeAIChat.historyHitPrompt', "Prompt")
						: localize('vibeAIChat.historyHitReply', "Reply");
				const snippet = DOM.append(item, $('span.vibe-ai-history-hit-snippet'));
				snippet.textContent = hit.snippet;
				snippet.title = hit.snippet;
				const open = () => this.openSearchHit(hit);
				this.historyRowsDisposables.add(DOM.addDisposableListener(item, DOM.EventType.CLICK, open));
				this.historyRowsDisposables.add(DOM.addDisposableListener(item, DOM.EventType.KEY_DOWN, e => {
					if (e.key === 'Enter') {
						DOM.EventHelper.stop(e, true);
						open();
					}
				}));
			}
		}
	}

	/**
	 * Phase 123: "This chat" scope — searches the active conversation's
	 * live history (prompts + final answers) with the same hit shape the
	 * store-side cross-session search returns. Fresh (unsaved) threads
	 * are searchable too — the hits carry the conversation's own
	 * sessionId, so a hit jump focuses the very thread it came from.
	 */
	private searchActiveConversation(needle: string): IVibeAIChatSearchHit[] {
		const conversation = this.getActiveConversation();
		if (!conversation) {
			return [];
		}
		return searchConversationContent(
			conversation.sessionId,
			conversation.title,
			conversation.history,
			conversation.turns.map(turn => turn.answer),
			needle,
		);
	}

	/**
	 * Phase 123: jumps to a search hit — focuses (or opens) the hit's
	 * conversation and lands on the matched turn with a brief highlight.
	 * Session-level hits (title matches) land on the latest turn (the
	 * plain history-open path). An already-open conversation is focused;
	 * a closed one is opened via loadSession with the hit's turn.
	 */
	private openSearchHit(hit: IVibeAIChatSearchHit): void {
		this.closeHistoryMenu();
		const open = this.conversations.find(candidate => candidate.sessionId === hit.sessionId);
		if (open) {
			this.setActiveConversation(open.id);
			if (hit.turnIndex >= 0) {
				this.scrollToTurn(open, hit.turnIndex, hit.kind === 'assistant' ? 'assistant' : 'user');
			} else {
				this.scrollToLatestTurn(open);
			}
			return;
		}
		const session = this.sessionStore.list().find(candidate => candidate.id === hit.sessionId);
		if (!session) {
			return;
		}
		if (hit.turnIndex < 0) {
			this.loadSession(session);
			return;
		}
		this.loadSession(session, undefined, { index: hit.turnIndex, kind: hit.kind === 'assistant' ? 'assistant' : 'user' });
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
			// Phase 116: Side Chat — side sessions carry the Side badge.
			if (session.kind === 'side') {
				const sideBadge = DOM.append(item, $('span.vibe-ai-history-item-side-badge'));
				sideBadge.textContent = localize('vibeAIChat.historySideBadge', "Side");
			}

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
	 * untouched active tab, or opens a new tab otherwise. Phase 101: the
	 * restore path passes the tab's recorded scroll position — its thread
	 * lands where it was left (pinned-at-bottom tabs at the bottom);
	 * history-menu opens land on the latest turn (Phase 100). Phase 123:
	 * a search-hit jump (focusTurn) lands on the matched turn instead.
	 */
	loadSession(session: IVibeAIChatSession, recorded?: IVibeAIChatScrollPos, focusTurn?: { index: number; kind: 'user' | 'assistant' }): void {
		const open = this.conversations.find(conversation => conversation.sessionId === session.id);
		if (open) {
			this.setActiveConversation(open.id);
			// Phase 100: entering a historical conversation always lands on
			// its latest turn (the thread's very bottom) — even when the
			// session is already open in a tab. Phase 123: a search-hit
			// jump lands on the matched turn instead.
			if (focusTurn) {
				this.scrollToTurn(open, focusTurn.index, focusTurn.kind);
			} else {
				this.scrollToLatestTurn(open);
			}
			return;
		}
		let conversation = this.getActiveConversation();
		if (!conversation || !this.isConversationEmpty(conversation)) {
			conversation = this.createConversation();
		}
		this.activeConversationId = conversation.id;
		conversation.sessionId = session.id;
		conversation.title = session.title;
		// Phase 93: the session's own composer mode restores per
		// conversation (old sessions predate the field and fall back to
		// the default ask).
		conversation.mode = session.mode === 'agent' || session.mode === 'plan' ? session.mode : 'ask';
		// Phase 116: Side Chat — the side identity rides along so the
		// restored tab keeps the Side badge and keeps carrying the
		// parent reference on its turns.
		conversation.kind = session.kind === 'side' ? 'side' : 'main';
		conversation.parentSessionId = session.parentSessionId;
		// Phase 120: the session goal rides along — the restored tab keeps
		// the banner (active/done state) and keeps carrying the objective
		// on its turns.
		conversation.goal = session.goal;
		conversation.goalComplete = session.goalComplete === true;
		// Phase 157: the agreed plan file rides along — the restored tab
		// keeps carrying it as planFile on agent turns (Cursor plan-as-file
		// parity survives restarts).
		conversation.planPath = session.planPath;
		// Phase 232: the streamed plan doc rides along — the restored tab
		// keeps ticking Build progress on the SAME doc (not a fresh
		// PLAN.md fallback) after a restart.
		conversation.planDocPath = session.planDocPath;
		// Phase 177: the conversation's project folder rides along — the
		// restored tab keeps sending the session's workspaceRoot even from
		// the Agent Window (whose own workspace has no folder).
		conversation.workspaceRoot = session.workspaceRoot;
		// Phase 101: the tab's recorded scroll position rides along —
		// scrollToLatestTurn lands the thread there (the very bottom when
		// none / pinned at it) instead of always the latest turn.
		conversation.recordedScroll = recorded;
		// Phase 61: images (data URLs) ride along on user messages — the
		// restored thread shows the sent thumbnails again. Phase 113: the
		// steered marker rides along too (steered bubbles restore with it).
		// Phase 184: file/folder chips ride along too (sent chips restore).
		conversation.history = session.messages.map(m => ({
			role: m.role,
			content: m.content,
			...(m.images && m.images.length > 0 ? { images: m.images } : {}),
			...(m.files && m.files.length > 0 ? { files: m.files } : {}),
			...(m.steered ? { steered: true } : {}),
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
			// Phase 113: steered messages are NOT dispatched user turns —
			// they were injected mid-turn (the steered marker), so they are
			// excluded to keep the turn↔user-message alignment intact.
			const userMessages = session.messages.filter(m => m.role === 'user' && !m.steered);
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
				// Phase 103: the loop's limit (Cursor-parity restore —
				// the restored turn renders the note + Continue chip).
				limitReached: turn.limitReached,
				error: turn.error,
				// Phase 245: the resume credential rides along — a restored
				// failed turn still retries from the failed step after a
				// reload (the on-disk transcript outlives the app).
				turnId: turn.turnId,
					turnChanges: [...(turn.turnChanges ?? [])],
				rolledBack: turn.rolledBack,
				// Phase 88: kept turns (Keep clicked) restore the mark —
				// the docked review bar never resurrects for them.
				kept: turn.kept,
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
				// Phase 113: steers (injected + not-delivered) ride the
				// record — the restored turn renders their bubbles / note.
				steered: turn.steered,
				steeredPending: turn.steeredPending,
				row: undefined,
			}));
			// Phase 218: alignment self-heal — backfill placeholder records
			// for user turns the stored turns don't cover (the size guard's
			// turns stripping, or a save from an alignment-broken build).
			// Without them the Phase 47 alignment gate (turns.length ===
			// userRowIndex) never holds again for this conversation — no
			// further turn would ever be recorded (Retry / checkpoint
			// restore die permanently). The placeholder carries the plain
			// message pair only; the original record's artifacts (tools /
			// timeline / error) are gone with it.
			for (let index = conversation.turns.length; index < userMessages.length; index++) {
				conversation.turns.push({
					userText: userMessages[index].content,
					tools: [],
					answer: this.assistantTextAfterUserMessage(session.messages, index),
					turnChanges: [],
					row: undefined,
				});
			}
			for (let index = 0; index < conversation.turns.length; index++) {
				// Phase 61: the k-th turn ↔ the k-th user message — its
				// images (if any) render as the turn's thumbnail strip.
				// Phase 184: its file chips render into the same strip.
				// Phase 193: the restored user row rides the record — the
				// Retry pill on a restored failed turn re-dispatches through
				// the same truncate-and-resend machinery as the live path
				// (retryFailedTurn reads record.userRow).
				conversation.turns[index].userRow = this.renderUserTurn(conversation, conversation.turns[index].userText, userMessages[index]?.images, userMessages[index]?.files);
				this.renderAssistantFromTurn(conversation, conversation.turns[index], index);
			}
		} else {
			for (const message of conversation.history) {
				// Phase 218: steered messages are NOT dispatched user turns —
				// same exclusion as the turns branch above; rendering them as
				// user rows would break the turn↔row↔history alignment the
				// truncate / record machinery counts on.
				if (message.role === 'user' && !message.steered) {
					this.renderUserTurn(conversation, message.content, message.images, message.files);
				} else if (message.role !== 'user') {
					this.renderAssistantFromText(conversation, message.content);
				}
			}
			// Phase 218: alignment self-heal (see the turns branch) — a
			// session restored from a turns-less store backfills placeholder
			// records so the next turns record (and Retry works) again.
			// Plain pairs have no row refs to hand out; a retry of an error
			// turn from THIS run rides the lastFailedTurn stash instead.
			conversation.turns = [];
			const plainUserMessages = conversation.history.filter(m => m.role === 'user' && !m.steered);
			for (let index = 0; index < plainUserMessages.length; index++) {
				conversation.turns.push({
					userText: plainUserMessages[index].content,
					tools: [],
					answer: this.assistantTextAfterUserMessage(conversation.history, index),
					turnChanges: [],
					row: undefined,
				});
			}
		}
		// Phase 56: the docked review bar shows the restored conversation's
		// latest turn with changes (hidden when none).
		this.renderDockedFilesSummary();
		// Phase 120: the restored conversation's goal banner (active/done).
		this.renderGoalBanner();
		// Phase 100: the restored conversation lands on its latest turn —
		// the thread's very bottom (scrollToLatestTurn: the bare
		// scrollBottom was a silent no-op during window reload, where the
		// pane has no dimensions until the workbench's first layout()).
		// Phase 123: a search-hit jump lands on the matched turn instead.
		if (focusTurn) {
			this.scrollToTurn(conversation, focusTurn.index, focusTurn.kind);
		} else {
			this.scrollToLatestTurn(conversation);
		}
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
			this.renderAssistantFromTimeline(conversation, row, turn, turnIndex);
			// Phase 71: the plan card of a Plan-mode turn (after the
			// activity blocks, before the footer — live parity).
			this.renderRestoredPlanCard(conversation, row, turn);
			// --- checkpoint footer (fully interactive) — Phase 56: the
			//     files summary no longer renders per turn in the thread.
			this.renderTurnFooterInto(conversation, row, turn.turnChanges ?? [], turn.turnStartedAt ?? Date.now(), turnIndex, this.getFinalAnswerText(turn.answer, turn.timeline), turn.rolledBack);
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
			// Phase 162: same merge hooks as the other creation sites (one
			// block per legacy turn — the dataset is inert here, consistency
			// only).
			const label = DOM.append(summary, $('span.vibe-ai-thinking-label'));
			label.textContent = turn.thinkingDurationMs !== undefined
				? localize('vibeAIChat.thought', "Thought for {0}", getDurationString(turn.thinkingDurationMs))
				: localize('vibeAIChat.thinking', "Thinking…");
			if (turn.thinkingDurationMs !== undefined) {
				thinkingDetails.dataset.vibeThoughtMs = String(turn.thinkingDurationMs);
			}
			const thinkingText = DOM.append(thinkingDetails, $('.vibe-ai-thinking-text'));
			// Phase 84.2: restored reasoning is static — no 10-line window
			// (same settled class as the timeline restore path).
			thinkingText.classList.add('vibe-ai-thinking-text-settled');
			thinkingText.textContent = turn.thinking;
		}

		// --- collapsible tool activity with the recorded read-only cards
		//     (Phase 57: mutating tools render inline below instead — live
		//     parity: the Worked activity keeps read-only scans only)
		//     Phase 98: failed tools (status 'error') never render — the
		//     live path removes them before capture; the filter also drops
		//     error cards recorded by pre-Phase-98 sessions.
		const tools = (turn.tools ?? []).filter(tool => tool.status !== 'error');
		const readTools = tools.filter(tool => !isMutatingTool(tool.name));
		if (readTools.length > 0) {
			const workDetails = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
			// Post-turn state (Phase 96: restored history ALWAYS renders
			// collapsed — restarting / re-importing history collapses every
			// Worked shell): the "Worked for X" summary row — the native
			// <details> toggle expands it.
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
			// --- error note (recorded when the turn errored) — Phase 193
			//     restyles it as the soft red card; Phase 195 (user ruling):
			//     ANY stream error kills a running agent turn, so the Retry
			//     pill re-arms from the error record itself — latest turn
			//     only (earlier ones have later history riding on them).
			if (turn.error) {
				const retry = turnIndex === conversation.turns.length - 1
					? () => this.retryFailedTurn(conversation)
					: undefined;
				this.appendErrorRow(row, turn.error, retry, conversation.turnRecordDisposables);
			}
			// --- interrupted note (Phase 97: the turn was cut short by the
			//     next send — the partial progress above stays, the note
			//     explains why it never completed)
			if (turn.interrupted) {
				const note = DOM.append(row, $('.vibe-ai-turn-interrupted'));
				note.textContent = localize('vibeAIChat.turnInterrupted', "Interrupted — a new message was sent before this turn finished");
			}
			for (const segment of segments) {
					const segText = turn.answer.slice(segment.textStart, segment.textEnd);
					if (segText.length > 0) {
						const segBody = DOM.append(row, $('.vibe-ai-chat-markdown'));
						const rendered = this.markdownRendererService.render(new MarkdownString(segText, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), segBody);
						conversation.turnRecordDisposables.add(rendered);
						this.enhancePaneFileChips(segBody);
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
						// Phase 95: kept / discarded files (or whole turns)
						// never re-arm — the overlay must not resurrect.
						if (tool.codeChange) {
							this.registerRestoredHighlight(turn, tool.codeChange);
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
						"(response truncated — the reasoning used up the output budget)"
					)
					: localize('vibeAIChat.emptyResponse', "(no response)");
				placeholder.style.color = 'var(--vscode-descriptionForeground)';
				placeholder.style.fontStyle = 'italic';
				// Phase 201: the truncated reminder carries a Continue chip
				// (same as the note below the answer) — no exception here.
				if (turn.outputTruncated) {
					const chipRow = DOM.append(row, $('.vibe-ai-output-truncated-note'));
					this.appendTruncationChip(conversation, chipRow);
				}
			}
			// --- truncation note + Continue chip (Phase 201: same shape as
			//     the limit-reached chip; Phase 200's auto-continuation
			//     already ran — this note means the budget is exhausted).
			if (turn.outputTruncated && turn.answer.length > 0) {
				this.appendOutputTruncatedNote(conversation, row);
			}
			// --- limit-reached note + Continue chip (Phase 103: the loop
			//     exhausted its rounds/segments or the context window —
			//     Cursor-parity loop continuation; restores with the turn).
			if (turn.limitReached) {
				this.appendLimitReachedNote(conversation, row);
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
					// Phase 95: kept / discarded files never re-arm.
					if (tool.codeChange) {
						this.registerRestoredHighlight(turn, tool.codeChange);
					}
					actionCardsContainer.appendChild(card.element);
				}
			}

			// --- error note (recorded when the turn errored) — Phase 193
			//     restyles it as the soft red card; Phase 195 (user ruling):
			//     ANY stream error kills a running agent turn, so the Retry
			//     pill re-arms from the error record itself — latest turn
			//     only (earlier ones have later history riding on them).
			if (turn.error) {
				const retry = turnIndex === conversation.turns.length - 1
					? () => this.retryFailedTurn(conversation)
					: undefined;
				this.appendErrorRow(row, turn.error, retry, conversation.turnRecordDisposables);
			}

			// --- interrupted note (Phase 97: the turn was cut short by the
			//     next send — the partial progress above stays, the note
			//     explains why it never completed)
			if (turn.interrupted) {
				const note = DOM.append(row, $('.vibe-ai-turn-interrupted'));
				note.textContent = localize('vibeAIChat.turnInterrupted', "Interrupted — a new message was sent before this turn finished");
			}

			// --- markdown answer (same renderer as the live view)
			const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
			if (turn.answer.length > 0) {
				const rendered = this.markdownRendererService.render(new MarkdownString(turn.answer, { isTrusted: true, supportThemeIcons: true, supportHtml: true }), this.buildMarkdownRenderOptions(conversation, false), body);
				conversation.turnRecordDisposables.add(rendered);
				this.enhancePaneFileChips(body);
			} else if (!turn.interrupted) {
				const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
				placeholder.textContent = turn.outputTruncated
					? localize(
						'vibeAIChat.truncatedNoResponse',
						"(response truncated — the reasoning used up the output budget)"
					)
					: localize('vibeAIChat.emptyResponse', "(no response)");
				placeholder.style.color = 'var(--vscode-descriptionForeground)';
				placeholder.style.fontStyle = 'italic';
				// Phase 201: the truncated reminder carries a Continue chip
				// (same as the note below the answer) — no exception here.
				if (turn.outputTruncated) {
					const chipRow = DOM.append(row, $('.vibe-ai-output-truncated-note'));
					this.appendTruncationChip(conversation, chipRow);
				}
			}

			// --- truncation note + Continue chip (Phase 201: same shape as
			//     the limit-reached chip; Phase 200's auto-continuation
			//     already ran — this note means the budget is exhausted).
			if (turn.outputTruncated && turn.answer.length > 0) {
				this.appendOutputTruncatedNote(conversation, row);
			}
			// --- limit-reached note + Continue chip (Phase 103: the loop
			//     exhausted its rounds/segments or the context window —
			//     Cursor-parity loop continuation; restores with the turn).
			if (turn.limitReached) {
				this.appendLimitReachedNote(conversation, row);
			}
		}

		// --- Phase 71: the plan card of a Plan-mode turn (after the
		//     activity blocks, before the footer — live parity).
		this.renderRestoredPlanCard(conversation, row, turn);

		// --- checkpoint footer (fully interactive) — Phase 56: the files
		//     summary no longer renders per turn in the thread; the docked
		//     review bar above the input shows the latest turn's changes.
		this.renderTurnFooterInto(conversation, row, turn.turnChanges ?? [], turn.turnStartedAt ?? Date.now(), turnIndex, this.getFinalAnswerText(turn.answer, turn.timeline), turn.rolledBack);
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
	private renderAssistantFromTimeline(conversation: VibeAIConversation, row: HTMLElement, turn: IVibeAIPersistedTurn, turnIndex?: number): void {
		// Phase 98: failed tools (status 'error') never render — dropped
		// from the live Worked section before capture (and from pre-98
		// records); timeline nodes referencing them skip on the id lookup.
		const tools = (turn.tools ?? []).filter(tool => tool.status !== 'error');
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
			// Phase 102: the answer is NOT hosted inside the preceding
			// Thought block anymore — every text node renders at row
			// level, below its Thought block (a pre-102 session's
			// hostsAnswer node is ignored; the answer never sits inside
			// the collapsible after a restart either).
			for (const node of nodes) {
				if (node.kind === 'thinking') {
					this.appendRestoredThinkingBlock(row, turn, node);
				} else if (node.kind === 'text') {
					this.appendRestoredTextBody(conversation, row, turn, node);
				}
			}
			// Phase 162: consecutive Thought nodes render as one merged
			// block (durations sum, texts blank-line separated) — live
			// parity with closeThinkingRun's consolidation.
			this.consolidateThoughtBlocks(row);
		} else {
			// --- tools turn: ONE Worked shell with everything inside
			// except the final text node (the answer). The answer is the
			// last node exactly when it is a text node — no tool node can
			// follow it (any later activity would have closed that text
			// run first, mirroring the live closeRunsBefore order).
			const answerIndex = nodes.length > 0 && nodes[nodes.length - 1].kind === 'text' ? nodes.length - 1 : -1;
			// Phase 102: no answer-host block — the final answer renders
			// OUTSIDE the shell as its own body; every thinking node stays
			// inside the shell's steps (a pre-102 session's hostsAnswer
			// node renders as a plain collapsed Thought block like the
			// rest).
			const shell = DOM.append(row, $('details.vibe-ai-worked')) as HTMLDetailsElement;
			// Post-turn state (Phase 96: restored history ALWAYS renders
			// collapsed — restarting / re-importing history collapses every
			// Worked shell; only the live latest turn keeps its shell
			// expanded): the native <details> toggle expands it.
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
			// Phase 149: the restore path's card lookup for the grouping —
			// the persisted records' ids ride their elements (mirrors
			// handleToolStart's dataset assignment).
			const restoredCards = new Map<string, VibeAIToolCard>();
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
						// Phase 149: the persisted record's id rides the
						// element for the grouping (mirrors handleToolStart).
						if (tool.id !== undefined) {
							card.element.dataset.vibeToolId = tool.id;
							restoredCards.set(tool.id, card);
						}
						// Phase 58 follow-up: restored writes re-arm the
						// editor highlighter so opening the file from the
						// restored chat re-applies the red/green change
						// highlight (live writes register via
						// handleToolResult; a restart forgets them).
						// Phase 95: kept / discarded files never re-arm.
						if (tool.codeChange) {
							this.registerRestoredHighlight(turn, tool.codeChange);
						}
						steps.appendChild(card.element);
					}
				}
			}
			// Phase 113: steered messages injected mid-turn — restored at
			// the end of the shell's steps (chronologically they arrived
			// during the work; the live view renders them inside it).
			if (turn.steered && turn.steered.length > 0) {
				for (const content of turn.steered) {
					this.appendRestoredSteeredRow(steps, content);
				}
			}
			// Phase 149: the same grouping as the live view — repeated reads
			// of a file fold into the first row (union range), scans fold
			// into count group rows — then the label carries the counts.
			// Phase 162: after the grouping pulls cards out from between
			// Thought rows, adjacent settled blocks merge (same rule as the
			// live regroup).
			regroupWorkedSteps(steps, restoredCards);
			this.consolidateThoughtBlocks(steps);
			this.appendWorkedCountsSuffix(label, steps, restoredCards);
			// Phase 61 fix (restored answers vanished): the answer node is
			// skipped by the loop above — render it OUTSIDE the shell as
			// the answer body (live parity: finishStreaming keeps the final
			// text run outside the Worked shell). appendRestoredTextBody
			// no-ops on an empty slice (defensive).
			// Phase 102: never inside a Thought block either — the answer
			// renders as its own body, below the shell.
			if (answerIndex !== -1) {
				this.appendRestoredTextBody(conversation, row, turn, nodes[answerIndex]);
			}
		}
		// --- error note (recorded when the turn errored) — Phase 193
		//     restyles it as the soft red card; Phase 195 (user ruling):
		//     ANY stream error kills a running agent turn, so the Retry
		//     pill re-arms from the error record itself — latest turn
		//     only (earlier ones have later history riding on them).
		if (turn.error) {
			const retry = turnIndex === conversation.turns.length - 1
				? () => this.retryFailedTurn(conversation)
				: undefined;
			this.appendErrorRow(row, turn.error, retry, conversation.turnRecordDisposables);
		}
		// --- interrupted note (Phase 97: the turn was cut short by the next
		//     send — the partial progress above stays, the note explains why
		//     it never completed)
		if (turn.interrupted) {
			const note = DOM.append(row, $('.vibe-ai-turn-interrupted'));
			note.textContent = localize('vibeAIChat.turnInterrupted', "Interrupted — a new message was sent before this turn finished");
		}
		// Phase 113: steers the turn ended with (queued but never injected)
		// — the not-delivered note restores with the turn (the messages
		// themselves ride the history as steered user messages).
		if (turn.steeredPending && turn.steeredPending.length > 0) {
			const note = DOM.append(row, $('.vibe-ai-steer-pending-note'));
			note.textContent = turn.steeredPending.length === 1
				? localize(
					'vibeAIChat.steerPendingOne',
					"Steer not delivered — the turn finished before it could be injected; it rides the next turn"
				)
				: localize(
					'vibeAIChat.steerPendingMany',
					"{0} steers not delivered — the turn finished before they could be injected; they ride the next turn",
					turn.steeredPending.length
				);
		}
		// Empty answer → subtle placeholder (parity with the live view).
		// Phase 97: an interrupted turn skips it — the note explains.
		if (turn.answer.length === 0 && !turn.interrupted) {
			const body = DOM.append(row, $('.vibe-ai-chat-markdown'));
			const placeholder = DOM.append(body, $('span.vibe-ai-chat-empty-response'));
			placeholder.textContent = turn.outputTruncated
				? localize(
					'vibeAIChat.truncatedNoResponse',
					"(response truncated — the reasoning used up the output budget)"
				)
				: localize('vibeAIChat.emptyResponse', "(no response)");
			placeholder.style.color = 'var(--vscode-descriptionForeground)';
			placeholder.style.fontStyle = 'italic';
			// Phase 201: the truncated reminder carries a Continue chip
			// (same as the note below the answer) — no exception here.
			if (turn.outputTruncated) {
				const chipRow = DOM.append(row, $('.vibe-ai-output-truncated-note'));
				this.appendTruncationChip(conversation, chipRow);
			}
		}
		// --- truncation note + Continue chip (Phase 201: same shape as
		//     the limit-reached chip; Phase 200's auto-continuation
		//     already ran — this note means the budget is exhausted).
		if (turn.outputTruncated && turn.answer.length > 0) {
			this.appendOutputTruncatedNote(conversation, row);
		}
		// --- limit-reached note + Continue chip (Phase 103: the loop
		//     exhausted its rounds/segments or the context window —
		//     Cursor-parity loop continuation; restores with the turn).
		if (turn.limitReached) {
			this.appendLimitReachedNote(conversation, row);
		}
	}

	/**
	 * Phase 61: one restored thinking sub-block — a collapsed "Thought for
	 * Xs" details (its reasoning sliced from `turn.thinking`, the label
	 * from the node's own duration). Renders at row level on a
	 * thinking-only turn, inside the Worked shell's steps otherwise.
	 * Phase 102: no answer hosting — the block always renders collapsed
	 * (restored-history parity) and the answer body renders outside it
	 * (appendRestoredTextBody); a run without reasoning (a pre-102
	 * heartbeat host block) renders nothing.
	 */
	/**
	 * Phase 113: one restored Steered bubble — the steered message the
	 * backend injected mid-turn (a user bubble with the Steered marker
	 * inside the Worked shell's steps). Steers are never dispatched user
	 * turns (no prompt-edit, no turn-record slot — the truncate mapping
	 * only maps dispatched turns).
	 */
	private appendRestoredSteeredRow(parent: HTMLElement, content: string): void {
		const row = DOM.append(parent, $('.vibe-ai-turn-steered'));
		const meta = DOM.append(row, $('.vibe-ai-steered-meta'));
		const icon = DOM.append(meta, $('span.codicon.codicon-arrow-swap.vibe-ai-steered-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(meta, $('span'));
		label.textContent = localize('vibeAIChat.steeredLabel', "Steered");
		const bubble = DOM.append(row, $('.vibe-ai-steered-bubble'));
		bubble.textContent = content;
	}

	private appendRestoredThinkingBlock(parent: HTMLElement, turn: IVibeAIPersistedTurn, node: IVibeAITurnTimelineNode): void {
		const runText = (turn.thinking ?? '').slice(node.start ?? 0, node.end ?? 0);
		if (runText.length === 0) {
			return;
		}
		const thinkingDetails = DOM.append(parent, $('details.vibe-ai-thinking')) as HTMLDetailsElement;
		const summary = DOM.append(thinkingDetails, $('summary'));
		const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-thinking-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
		// Phase 162: label class + duration dataset — the same merge hooks
		// the live blocks carry (consolidateThoughtBlocks sums them).
		const label = DOM.append(summary, $('span.vibe-ai-thinking-label'));
		label.textContent = node.durationMs !== undefined
			? localize('vibeAIChat.thought', "Thought for {0}", getDurationString(node.durationMs))
			: localize('vibeAIChat.thinking', "Thinking…");
		if (node.durationMs !== undefined) {
			thinkingDetails.dataset.vibeThoughtMs = String(node.durationMs);
		}
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
		this.enhancePaneFileChips(segBody);
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
			// Phase 251: same embedded diff editor as the live path — restored
			// history renders isomorphic (built lazily when the card becomes
			// visible, so a folded Worked shell costs no widgets).
			(container, original, updated, filePath, firstChangeLine, onBuildFailure) =>
				this.instantiationService.createInstance(VibeAIEmbeddedDiff, container, original, updated, filePath, firstChangeLine, onBuildFailure),
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
				this.enhancePaneFileChips(body);
			} else {
			body.textContent = localize('vibeAIChat.emptyResponse', "(no response)");
			body.style.color = 'var(--vscode-descriptionForeground)';
			body.style.fontStyle = 'italic';
		}
	}

	// ==================== stream / view state ====================

	private showError(message: string, conversation: VibeAIConversation, retryable = false): void {
		// Errors belong to the streaming conversation's thread.
		// Phase 134: Cursor-parity Retry — transient provider errors (the
		// backend's `retryable` classification) render a Retry pill that
		// re-sends the failed turn as a fresh turn (retryFailedTurn below).
		// The listener dies with the turn (turnDisposables) like every
		// other per-turn row.
		this.appendErrorRow(conversation.container, message, retryable ? () => this.retryFailedTurn(conversation) : undefined, conversation.turnDisposables);
		this.scrollBottom(conversation);
	}

	/**
	 * Phase 193: the error row, shared by the live stream error and the
	 * restored failed turns (four render sites) — a soft red card: error
	 * icon, the message, and (for retryable provider errors) a right-aligned
	 * Retry pill. `listenerStore` owns the retry listener — turnDisposables
	 * for the live path, turnRecordDisposables for restored turns.
	 */
	private appendErrorRow(parent: HTMLElement, message: string, onRetry: (() => void) | undefined, listenerStore: DisposableStore): HTMLElement {
		const row = DOM.append(parent, $('.vibe-ai-chat-error'));
		const icon = DOM.append(row, $('span.codicon.codicon-error.vibe-ai-chat-error-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const text = DOM.append(row, $('span.vibe-ai-chat-error-text'));
		text.textContent = message;
		if (onRetry) {
			const retryBtn = DOM.append(row, $('span.vibe-ai-chat-error-retry'));
			retryBtn.setAttribute('role', 'button');
			retryBtn.title = localize('vibeAIChat.retryTurnTitle', "Re-send this turn");
			DOM.append(retryBtn, $('span.codicon.codicon-refresh'));
			const retryLabel = DOM.append(retryBtn, $('span.vibe-ai-chat-error-retry-label'));
			retryLabel.textContent = localize('vibeAIChat.retryTurn', "Retry");
			listenerStore.add(DOM.addDisposableListener(retryBtn, DOM.EventType.CLICK, () => {
				onRetry();
			}));
		}
		return row;
	}

	/**
	 * Phase 134: the transient "Retrying (n/N)…" chip (Cursor parity) —
	 * shown while the backend backs off between auto-retry attempts of
	 * the LLM call. One chip per conversation: a second retry event
	 * replaces it; the next real event (or turn finish) clears it.
	 */
	private showRetryChip(conversation: VibeAIConversation, retry?: { attempt: number; max: number; delay: number; reason?: string }): void {
		if (!conversation.stream) {
			return;
		}
		this.clearRetryChip(conversation);
		const row = DOM.append(conversation.container, $('.vibe-ai-chat-retry'));
		DOM.append(row, $('span.codicon.codicon-refresh'));
		const label = DOM.append(row, $('span.vibe-ai-chat-retry-label'));
		const attempt = retry?.attempt ?? 0;
		const max = retry?.max ?? 0;
		label.textContent = attempt > 0 && max > 0
			? localize('vibeAIChat.retryingAttempt', "Retrying ({0}/{1})…", attempt, max)
			: localize('vibeAIChat.retrying', "Retrying…");
		this.scrollBottom(conversation);
		conversation.stream.retryRow = row;
	}

	/** Phase 134: removes the conversation's transient Retrying chip, if any. */
	private clearRetryChip(conversation: VibeAIConversation): void {
		if (conversation.stream?.retryRow) {
			conversation.stream.retryRow.remove();
			conversation.stream.retryRow = undefined;
		}
	}

	/**
	 * Phase 134: Cursor-parity Retry. Phase 246: with the failed turn's
	 * transcript id (the `turn_start` event, persisted on the record) the
	 * retry RESUMES the turn from its last tool boundary — completed tool
	 * rounds and their file changes are kept, only the failed step is
	 * redone (resumeFailedTurn below). Without the id (dispatch-only
	 * paths, pre-245 records, transcript lost) it falls back to the
	 * legacy full re-send: reuses the prompt-edit resend machinery
	 * (truncateFromUserTurn): the failed turn is truncated from view +
	 * state (its partial file changes reverted, Phase 109 clean-slate
	 * semantics), then the original user text re-rides as the turn's user
	 * message and the turn re-dispatches (dispatchTurn expects the prompt
	 * already pushed to history + rendered — same contract as send()).
	 * Only the LATEST failed turn is retryable — earlier ones have later
	 * history riding on them.
	 */
	private retryFailedTurn(conversation: VibeAIConversation, skipResume = false): void {
		if (conversation.stream) {
			// A turn is running — retry only makes sense on a settled thread.
			return;
		}
		if (conversation.id !== this.activeConversationId) {
			// dispatchTurn reads the pane mirrors of the ACTIVE conversation
			// (mode/model/context/limit) — same guard as the edit resend.
			return;
		}
		// Phase 195: the error record is the retry credential (any stream
		// error kills a running agent turn). Phase 218: when the record
		// pipeline is broken — a conversation restored from a turns-less
		// store before the alignment self-heal ran, or any other
		// record-less failure — fall back to the failed turn's row + prompt
		// stashed at stream-error time; the button must never sit there
		// silently no-oping. Phase 246: the record/stash also carries the
		// turn transcript id (resume credential).
		const lastRecord = conversation.turns[conversation.turns.length - 1];
		let userText: string;
		let userRow: HTMLElement;
		let turnId: string | undefined;
		if (lastRecord?.error !== undefined && lastRecord.userText && lastRecord.userRow) {
			userText = lastRecord.userText;
			userRow = lastRecord.userRow;
			turnId = lastRecord.turnId;
		} else {
			const fallback = conversation.lastFailedTurn;
			if (!fallback) {
				// No failed latest turn (or a record without the user-row
				// ref) and no stash — nothing to retry.
				return;
			}
			userText = fallback.userText;
			userRow = fallback.userRow;
			turnId = fallback.turnId;
		}
		// Phase 246: resume from the failed step (Plan mode never produces
		// a transcript — its approval flow restarts the whole turn).
		if (turnId && !skipResume && this.mode !== 'plan') {
			this.resumeFailedTurn(conversation, userText, userRow, turnId);
			return;
		}
		void this.truncateFromUserTurn(conversation, userRow).then(turnIndex => {
			if (turnIndex === -1 || conversation.stream) {
				// Not a thread row (defensive), or a newer turn started
				// while the revert ran — the truncated thread stays as-is.
				return;
			}
			// The user row is the thread's last turn again — its bubble
			// already shows the original prompt (no edit, nothing to
			// restore). Push the prompt back as the turn's user message
			// and re-dispatch (Cursor Retry = re-send the same turn).
			this.history.push({ role: 'user', content: userText });
			this.dispatchTurn(conversation, userText, userRow);
		});
	}

	/**
	 * Phase 246: resume-from-failed-step retry. The failed turn's thread
	 * stays exactly as rendered (no truncate, no revert — the server
	 * transcript's context matches the disk state); the error card is
	 * removed, a divider note marks the continuation, and the same user
	 * row + turn identity re-stream the agent loop from the server-side
	 * transcript (request carries resumeTurnId; the backend reloads the
	 * transcript, appends a resume seed and continues — the model redoes
	 * only the failed step). finishStreaming merges the result into the
	 * failed turn's record.
	 */
	private resumeFailedTurn(conversation: VibeAIConversation, userText: string, userRow: HTMLElement, turnId: string): void {
		const requestId = `vibe-${++this.requestCounter}`;
		// The error card(s) of THIS turn go away — the retry supersedes
		// them. Every error row after the user row belongs to this latest
		// failed turn (retry is latest-turn-only).
		let sibling = userRow.nextElementSibling;
		while (sibling) {
			const next = sibling.nextElementSibling;
			if (sibling.classList.contains('vibe-ai-chat-error')) {
				sibling.remove();
			}
			sibling = next;
		}
		// The divider note lands before the new assistant row (startAssistantTurn
		// appends it at the container end).
		const divider = DOM.append(conversation.container, $('.vibe-ai-resume-divider'));
		const dividerIcon = DOM.append(divider, $('span.codicon.codicon-refresh'));
		dividerIcon.setAttribute('aria-hidden', 'true');
		const dividerLabel = DOM.append(divider, $('span.vibe-ai-resume-divider-label'));
		dividerLabel.textContent = localize('vibeAIChat.resumeRetry', "Retrying from the failed step…");
		this.scrollBottom(conversation);

		// Same turn identity: the user row + prompt are reused (no new
		// bubble, no history push — the server transcript carries the
		// context). The resume flag routes finishStreaming into the
		// record-merge path.
		this.startAssistantTurn(conversation, requestId, userText, userRow);
		if (conversation.stream) {
			conversation.stream.resumeDivider = divider;
			conversation.stream.isResume = true;
			conversation.stream.turnId = turnId;
		}
		this.updateInputActions();
		this.renderTabs();

		// Model routing mirrors dispatchTurn (the ACTIVE conversation's
		// pane mirrors — same guards as retryFailedTurn above).
		const configured = this.model !== 'Auto' ? this.modelStore.get(this.model) : undefined;
		const provider = configured ? this.modelStore.resolveProvider(configured) : undefined;
		const autoPool = this.model === 'Auto' ? this.buildAutoPool() : undefined;
		if (!this.hasUsableModel(configured, provider, autoPool)) {
			this.showError(VIBE_AI_NO_MODEL_MESSAGE, conversation);
			this.finishStreaming(conversation, requestId);
			return;
		}
		const request: IVibeAIChatRequest = {
			// The text history up to and INCLUDING the original user
			// message (the trailing partial answer is dropped) — the
			// transcript carries the real context; this payload only
			// feeds the endpoint's user_input (hooks / logging).
			messages: this.applySideMentions(this.resumeHistory(userText)),
			stream: true,
			sessionId: conversation.sessionId,
			contextLimit: this.contextLimit,
			...(conversation.kind === 'side'
				? { sideOf: conversation.parentSessionId, parentContext: this.buildParentContext(conversation.parentSessionId) }
				: {}),
			...(conversation.goal ? { goal: conversation.goal } : {}),
			...(this.mode === 'agent' && conversation.planPath ? { planFile: conversation.planPath } : {}),
			permissionMode: this.permissionMode,
			workspaceRoot: this.conversationWorkspaceRoot(conversation),
			...(this.model === 'Auto'
				? {
					model: 'auto',
					...(autoPool && autoPool.length > 0 ? { autoPool, autoMode: this.autoMode } : {}),
				}
				: {
					model: configured?.modelId ?? this.model,
					...(provider ? { provider } : {}),
				}),
			// Phase 246: the resume credential — the backend reloads this
			// turn's transcript and continues from the last tool boundary.
			resumeTurnId: turnId,
		};
		const streamPromise = this.mode === 'agent'
			? this.vibeAIService.agentStream(requestId, request)
			: this.vibeAIService.chatStream(requestId, request);
		streamPromise.catch(err => {
			this.logService.error('[VibeAI] resume stream rejected', err);
		}).finally(() => {
			this.finishStreaming(conversation, requestId);
		});
	}

	/**
	 * Phase 246: the text history slice ending at the failed turn's user
	 * message (the trailing partial assistant answer is dropped — the
	 * server transcript carries the real context; the payload only feeds
	 * the endpoint's user_input for hooks / logging). Falls back to the
	 * full history when the prompt is not found (defensive).
	 */
	private resumeHistory(userText: string): IVibeAIMessage[] {
		for (let i = this.history.length - 1; i >= 0; i--) {
			const message = this.history[i];
			if (message.role === 'user' && message.content === userText) {
				return this.history.slice(0, i + 1);
			}
		}
		return [...this.history];
	}

	/**
	 * Phase 246: the resume retry's transcript could not be loaded
	 * (backend restarted into another workspace / pruned file / id
	 * mismatch). The attempt rendered nothing but the divider — tear it
	 * down silently (no record, no history push) and fall back to the
	 * legacy truncate + full re-send. The old stream's done event (it
	 * follows immediately) no-ops: the stream state is gone.
	 */
	private handleResumeUnavailable(conversation: VibeAIConversation, data: IVibeAIStreamData): void {
		const state = conversation.stream;
		if (!state || state.requestId !== data.requestId || !state.isResume) {
			return;
		}
		state.resumeDivider?.remove();
		state.currentAssistantRow?.remove();
		conversation.stream = undefined;
		this.updateInputActions();
		this.renderTabs();
		this.retryFailedTurn(conversation, true);
	}

	/**
	 * Phase 246: a resume retry finishes into the SAME failed turn's
	 * record — the new tool snapshots, answer text, thinking and timeline
	 * merge in (timeline offsets shift by the merged text bases), the
	 * error clears when the resume succeeded and re-sets when it failed
	 * again (the record's turnId stays — the next Retry resumes the
	 * newest transcript). Returns false when no matching record exists
	 * (stash-only credential) — the caller falls back to the normal
	 * capture path.
	 */
	private mergeResumedTurnRecord(conversation: VibeAIConversation, state: VibeAIStreamState, captured: VibeAITurnRecord): boolean {
		const index = conversation.turns.length - 1;
		const record = conversation.turns[index];
		if (!record || record.userRow !== state.userRow) {
			return false;
		}
		const answerSep = record.answer ? '\n\n' : '';
		const answerBase = record.answer ? record.answer.length + answerSep.length : 0;
		const thinkingMerged = [record.thinking, captured.thinking].filter((value): value is string => !!value && value.length > 0).join('\n\n');
		const thinkBase = record.thinking
			? (captured.thinking ? record.thinking.length + 2 : record.thinking.length)
			: 0;
		const shiftedTimeline = (captured.timeline ?? []).map(node => {
			const base = node.kind === 'thinking' ? thinkBase : answerBase;
			return {
				...node,
				start: node.start !== undefined ? base + node.start : undefined,
				end: node.end !== undefined ? base + node.end : undefined,
			};
		});
		conversation.turns[index] = {
			...record,
			tools: [...(record.tools ?? []), ...captured.tools],
			answer: captured.answer ? `${record.answer}${answerSep}${captured.answer}` : record.answer,
			thinking: thinkingMerged || undefined,
			timeline: [...(record.timeline ?? []), ...shiftedTimeline],
			turnChanges: [...record.turnChanges, ...captured.turnChanges],
			routedModel: captured.routedModel ?? record.routedModel,
			contextCompressed: record.contextCompressed || captured.contextCompressed || undefined,
			outputTruncated: record.outputTruncated || captured.outputTruncated || undefined,
			limitReached: record.limitReached || captured.limitReached || undefined,
			steered: record.steered || captured.steered
				? [...(record.steered ?? []), ...(captured.steered ?? [])]
				: undefined,
			steeredPending: record.steeredPending || captured.steeredPending
				? [...(record.steeredPending ?? []), ...(captured.steeredPending ?? [])]
				: undefined,
			// The resumed attempt's outcome: success clears the error,
			// another failure re-sets it (the turn stays retryable).
			error: captured.error,
			interrupted: captured.interrupted,
			turnId: state.turnId ?? record.turnId,
		};
		return true;
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
	 * Phase 97 (was Phase 45's skip): interrupts the conversation's
	 * in-flight turn when the user sends the next message — the turn's
	 * progress STAYS (user message, tool cards, partial answer; abort
	 * semantics for file changes already written to disk) and the turn is
	 * finalized as interrupted with a note explaining why it never
	 * completed (user request: keep the progress, mark it interrupted).
	 * The finalization reuses finishStreaming (close runs, settle — and
	 * since Phase 140 fold — the Worked shell, capture the turn record,
	 * footer, persistence); the
	 * late settle of the aborted stream's promise no-ops in
	 * finishStreaming (requestId guard — the new turn owns
	 * conversation.stream by then).
	 */
	private interruptCurrentTurn(conversation: VibeAIConversation): void {
		const state = conversation.stream;
		if (!state) {
			return;
		}
		this.vibeAIService.cancel(state.requestId);
		// Plan mode (Phase 222): a live awaiting state only exists in the
		// card-to-done window — fold the decision card to its cancelled
		// state so the interrupt finalizes with the plan not executed.
		if (state.planPhase === 'awaiting') {
			state.planPhase = undefined;
			// Phase 219: the doc editor's approval widget folds with the
			// bar/card (same as cancelPlan).
			this.disposePlanApprovalWidget(state);
			this.foldPlanAwaitingToCancelled(state.planCardRoot);
		}
		this.finishStreaming(conversation, state.requestId, true);
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
		// Phase 114: the queued messages die with the reset (the badge
		// clears via updateInputActions below).
		active.steerQueue = [];
		active.sessionId = `vibe-${Date.now()}`;
		active.title = 'New Agent';
		active.attachedFiles = [];
		active.contextLimit = DEFAULT_CONTEXT_LIMIT;
		active.contextUsage = undefined;
		// Phase 120: the goal dies with the reset (the banner hides via
		// renderGoalBanner below).
		active.goal = undefined;
		active.goalComplete = false;
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
		// Phase 120: the reset conversation has no goal — the banner hides.
		this.renderGoalBanner();
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
	 * Phase 123: lands the thread on a search hit's turn — scrolls the
	 * matched row into view with a brief highlight. Mirrors
	 * scrollToLatestTurn's three-pass landing (immediate + next frame +
	 * settle): block heights settle late during window reload, so a
	 * single pass is a silent no-op while the holder has no dimensions.
	 * Only the active tab is ever touched — the messages holder is shared
	 * across threads. A missing row (an ordinal beyond the rendered
	 * turns, e.g. a pending steer saved as a plain prompt) falls back to
	 * the latest-turn landing.
	 */
	private scrollToTurn(conversation: VibeAIConversation, turnIndex: number, kind: 'user' | 'assistant'): void {
		if (!this.messagesContainer || turnIndex < 0) {
			return;
		}
		const selector = kind === 'assistant' ? '.vibe-ai-turn-assistant' : '.vibe-ai-turn-user';
		const row = Array.from(conversation.container.querySelectorAll<HTMLElement>(selector))[turnIndex];
		if (!row) {
			this.scrollToLatestTurn(conversation);
			return;
		}
		const win = DOM.getWindow(this.messagesContainer);
		const land = () => {
			if (!this.messagesContainer || conversation.id !== this.activeConversationId) {
				return;
			}
			const holderRect = this.messagesContainer.getBoundingClientRect();
			const rowRect = row.getBoundingClientRect();
			this.messagesContainer.scrollTop += rowRect.top - holderRect.top - 12;
			row.classList.add('vibe-ai-search-hit-flash');
			win.setTimeout(() => row.classList.remove('vibe-ai-search-hit-flash'), SEARCH_HIT_FLASH_MS);
		};
		land();
		win.requestAnimationFrame(() => {
			if (this._store.isDisposed) {
				return;
			}
			land();
		});
		win.setTimeout(() => {
			if (this._store.isDisposed) {
				return;
			}
			land();
		}, RESTORE_SCROLL_SETTLE_MS);
	}

	/**
	 * Phase 100: a restored conversation lands on its latest turn (the
	 * thread's very bottom), not the top. The bare scrollBottom right
	 * after the render loop is not enough: during restoreOpenConversations
	 * (window reload) the pane has no dimensions yet — the workbench lays
	 * it out after renderBody, so scrollHeight reads 0 and the assignment
	 * is a silent no-op (the thread shows the top when the pane appears).
	 * Late height growth shifts the bottom afterwards too (code-block
	 * editors, mermaid, images). So: scroll now, then again on the next
	 * frame and once more after a settle delay — every pass only while
	 * this conversation is still the active tab (the guards inside
	 * scrollBottom / applyRecordedScroll). When the holder has no
	 * dimensions the landing stays pending (pendingLatestScroll) for the
	 * first real layout() / tab activation to re-land it. Phase 101: the
	 * landing target is the tab's recorded scroll position (recordedScroll)
	 * when it has one and was not pinned at the bottom — the tab comes
	 * back where its thread was left; otherwise the very bottom.
	 */
	private scrollToLatestTurn(conversation: VibeAIConversation): void {
		this.applyRecordedScroll(conversation);
		if (!this.messagesContainer) {
			return;
		}
		const win = DOM.getWindow(this.messagesContainer);
		conversation.pendingLatestScroll = !(this.messagesContainer.clientHeight > 0);
		win.requestAnimationFrame(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.applyRecordedScroll(conversation);
		});
		win.setTimeout(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.applyRecordedScroll(conversation);
			// Landed: the holder shows the pending target — the pending
			// flag is consumed (later tab activations apply the tab's own
			// recorded position instead). A no-op pass (holder still
			// without dimensions) keeps it pending for the first layout().
			if (conversation.id === this.activeConversationId
				&& this.pendingScrollReached(conversation)) {
				conversation.pendingLatestScroll = false;
			}
		}, RESTORE_SCROLL_SETTLE_MS);
		// Phase 208: the landing passes finish while the thread may still
		// be growing (mermaid webviews mount deferred, images decode,
		// code-block editors initialize) — every late growth shoves the
		// landed viewport up with nothing left to re-land it. A bottom
		// landing therefore arms the restore chase: the thread keeps
		// re-pinning to the bottom until the user scrolls up, switches
		// tabs, or the growth settles. A mid-thread (recorded offset)
		// landing must not chase — an armed chase from an earlier
		// bottom landing stops.
		if (this.landingAtBottom(conversation)) {
			this.startRestoreChase(conversation);
		} else {
			this.stopRestoreChase();
		}
	}

	/**
	 * Phase 101: applies the conversation's recorded scroll position —
	 * where its thread was left. A tab pinned at (or without) a recorded
	 * position chases the bottom (scrollBottom's force path); a
	 * mid-thread one jumps to its exact offset. Only the active tab is
	 * ever touched — the messages holder is shared across threads, and a
	 * late pass must not yank a tab the user switched to.
	 */
	private applyRecordedScroll(conversation: VibeAIConversation): void {
		if (!this.messagesContainer || conversation.id !== this.activeConversationId) {
			return;
		}
		const recorded = conversation.recordedScroll;
		if (!recorded || recorded.atBottom) {
			this.scrollBottom(conversation, true);
			return;
		}
		this.messagesContainer.scrollTop = recorded.top;
	}

	/**
	 * Phase 101: true when the messages holder shows the conversation's
	 * pending landing target — the very bottom (no recorded position or
	 * pinned at it) or the recorded offset (within a couple px; a
	 * recorded top beyond the current scroll height counts as the
	 * bottom, block heights drift between windows). Drives the
	 * pending-landing consumption: a pass that actually landed clears
	 * the pending flag, a no-op pass (holder still without dimensions)
	 * keeps it for the first real layout().
	 */
	private pendingScrollReached(conversation: VibeAIConversation): boolean {
		if (!this.messagesContainer) {
			return false;
		}
		const el = this.messagesContainer;
		const recorded = conversation.recordedScroll;
		if (recorded && !recorded.atBottom) {
			if (recorded.top >= el.scrollHeight - el.clientHeight - 2) {
				return this.isScrolledToBottom(el);
			}
			return Math.abs(el.scrollTop - recorded.top) <= 2;
		}
		return this.isScrolledToBottom(el);
	}

	/**
	 * Phase 208: whether a landing targets the very bottom — no recorded
	 * position, or one pinned at the bottom (mirrors applyRecordedScroll's
	 * branch). Only bottom landings arm the restore chase.
	 */
	private landingAtBottom(conversation: VibeAIConversation): boolean {
		const recorded = conversation.recordedScroll;
		return !recorded || recorded.atBottom;
	}

	/**
	 * Phase 208: arms the restore chase for a bottom landing. A
	 * ResizeObserver on the conversation's thread fires on every block
	 * height change; while the conversation is still the active tab and
	 * the user has not scrolled up, each growth re-pins the bottom and
	 * rearms the idle window. The chase ends on the idle timeout (the
	 * thread settled), the user scrolling up (followThreadBottom flips in
	 * the scroll listener), a tab switch (the guard in the callback), or
	 * pane dispose. A user reading mid-thread is never yanked: their
	 * scroll-up is what disarms the chase.
	 */
	private startRestoreChase(conversation: VibeAIConversation): void {
		if (!this.messagesContainer || typeof ResizeObserver === 'undefined') {
			return;
		}
		this.stopRestoreChase();
		const observer = new ResizeObserver(() => {
			if (this._store.isDisposed) {
				this.stopRestoreChase();
				return;
			}
			if (conversation.id !== this.activeConversationId || !this.followThreadBottom) {
				this.stopRestoreChase();
				return;
			}
			this.scrollBottom(conversation, true);
			this.rearmRestoreChase();
		});
		observer.observe(conversation.container);
		const win = DOM.getWindow(this.messagesContainer);
		this.restoreChase = {
			conversationId: conversation.id,
			observer,
			idleTimer: win.setTimeout(() => this.stopRestoreChase(), RESTORE_CHASE_IDLE_MS),
		};
	}

	/**
	 * Phase 208: extends the chase's idle window — each observed growth
	 * means the thread is still settling, so the chase outlives it until
	 * RESTORE_CHASE_IDLE_MS passes without growth.
	 */
	private rearmRestoreChase(): void {
		const chase = this.restoreChase;
		if (!chase || !this.messagesContainer) {
			return;
		}
		const win = DOM.getWindow(this.messagesContainer);
		win.clearTimeout(chase.idleTimer);
		chase.idleTimer = win.setTimeout(() => this.stopRestoreChase(), RESTORE_CHASE_IDLE_MS);
	}

	/**
	 * Phase 208: disarms the restore chase (disconnects the observer,
	 * clears the idle timer). Safe to call repeatedly / when unarmed.
	 */
	private stopRestoreChase(): void {
		const chase = this.restoreChase;
		if (!chase) {
			return;
		}
		this.restoreChase = undefined;
		chase.observer.disconnect();
		if (this.messagesContainer) {
			DOM.getWindow(this.messagesContainer).clearTimeout(chase.idleTimer);
		}
	}

	/**
	 * Phase 101: the messages holder's current position as a recorded
	 * scroll — `atBottom` mirrors the follow-latest threshold, so a tab
	 * parked near the bottom counts as pinned (its restore chases the
	 * bottom, keeping the stream chase alive). Undefined when the holder
	 * is gone.
	 */
	private currentScrollPos(): IVibeAIChatScrollPos | undefined {
		const el = this.messagesContainer;
		if (!el) {
			return undefined;
		}
		return {
			top: el.scrollTop,
			atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_LATEST_THRESHOLD_PX,
		};
	}

	/**
	 * Phase 101: persists the open tabs' scroll positions shortly after
	 * the last scroll settles — a restart / project re-import with no
	 * tab mutation in between still restores the threads where they were
	 * left (each scroll reschedules; the persist runs once, after the
	 * user stops scrolling).
	 */
	private scheduleScrollPersist(): void {
		if (!this.messagesContainer) {
			return;
		}
		const win = DOM.getWindow(this.messagesContainer);
		if (this.scrollPersistTimer !== undefined) {
			win.clearTimeout(this.scrollPersistTimer);
		}
		this.scrollPersistTimer = win.setTimeout(() => {
			this.scrollPersistTimer = undefined;
			if (this._store.isDisposed) {
				return;
			}
			this.persistOpenState();
		}, RESTORE_SCROLL_PERSIST_MS);
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

