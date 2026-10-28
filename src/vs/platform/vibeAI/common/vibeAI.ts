/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Default URL of the local VibeCoding backend (FastAPI).
 * Can be overridden via `product.json#vibeAI.backendUrl` or the `VIBE_BACKEND_URL` environment variable.
 */
export const VIBE_AI_DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000';

export interface IVibeAIMessage {
	readonly role: string;
	readonly content: string;
	/**
	 * Phase 61: images attached to a user message as data URLs
	 * (`data:image/png;base64,...` — Ctrl+V paste / drag-drop). Only the
	 * CURRENT turn's images reach the model (the backend keeps history
	 * string-based); the history carries them so the thread restores the
	 * sent thumbnails.
	 */
	readonly images?: string[];
	/**
	 * Phase 113: the message is a mid-turn steer (Cursor's "send now" —
	 * sent while an Agent turn ran, injected at the next tool boundary).
	 * Frontend-only metadata: it marks the thread's steered bubbles and
	 * keeps the turn↔user-message alignment (steers never count as
	 * dispatched user turns). The backend's Message models ignore the
	 * extra field when the history is forwarded.
	 */
	readonly steered?: boolean;
}

export interface IVibeAIFileContext {
	readonly path: string;
	readonly content?: string;
	/**
	 * Phase 105: whether this entry is a dropped FILE or FOLDER (the
	 * chip's icon). The backend treats `context` as a free-form dict and
	 * ignores it.
	 */
	readonly kind?: 'file' | 'folder';
}

export interface IVibeAIRetrievedContext {
	readonly path: string;
	readonly snippet?: string;
	readonly score?: number;
}

export interface IVibeAIChatContext {
	readonly filePath?: string;
	readonly fileContent?: string;
	readonly files?: IVibeAIFileContext[];
	readonly retrieved?: IVibeAIRetrievedContext[];
}

/**
 * Provider override for a custom model registered in the chat pane's
 * settings ("Models" section): routes a chat request to an
 * OpenAI-compatible endpoint instead of the backend's default model.
 */
export interface IVibeAIModelProvider {
	readonly name?: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly model: string;
	/**
	 * Phase 70: tier hint for the Auto router ('fast' | 'mid' | 'strong';
	 * absent/'auto' = infer from the model id keywords in the backend).
	 */
	readonly tier?: string;
}

/**
 * Phase 70 (`model_routed`): the backend's Auto router picked this model
 * for the current turn — intent+complexity routing over the Settings →
 * Models pool (Cursor-parity underlying-model display).
 */
export interface IVibeAIModelRouting {
	readonly model: string;
	readonly name: string;
	readonly tier: string;
	readonly mode: string;
	readonly reason: string;
}

export interface IVibeAIChatRequest {
	readonly messages: IVibeAIMessage[];
	readonly model?: string;
	readonly stream?: boolean;
	readonly context?: IVibeAIChatContext;
	/**
	 * Custom-model routing (Settings → Models): when present the backend
	 * calls this OpenAI-compatible endpoint instead of its default model.
	 */
	readonly provider?: IVibeAIModelProvider;
	/**
	 * Custom context-window length in tokens (Phase 41, clamped to
	 * 100K–1M by the backend). When a request would exceed it the
	 * backend compresses (crops) the conversation history to fit
	 * before running the agent loop ("compress before agent").
	 */
	readonly contextLimit?: number;
	/**
	 * Phase 70 Auto routing: the non-disabled Settings → Models pool
	 * (resolved provider overrides + tier hints) sent when `model` is
	 * the pseudo-model 'auto' — the backend's router picks one per
	 * intent+complexity and falls back down the list on provider
	 * failures. An empty pool fails the turn with 400 (沒有模型可用)
	 * — no default-model fallback.
	 */
	readonly autoPool?: IVibeAIModelProvider[];
	/** Phase 70 Auto routing "Optimize For" mode: cost | balance | intelligence. */
	readonly autoMode?: string;
	/**
	 * Phase 107: the editor's opened folder, forwarded per request so the
	 * backend rebinds its tools / RAG index / rules / skills to it
	 * (Cursor parity: the agent follows the workspace). Absent/empty =
	 * the backend's own root (backward compatible).
	 */
	readonly workspaceRoot?: string;
	/**
	 * Phase 113: the conversation's session id (the chat pane's store
	 * session). Only the Agent streaming endpoint uses it — the request
	 * opens the backend's steer gate so mid-turn sends can queue as
	 * steers (`POST /api/chat/agent/steer`). Absent = no gate (backward
	 * compatible; the Plan research / execute phases and plain chat
	 * ignore it).
	 */
	readonly sessionId?: string;
	/**
	 * Phase 116: Side Chat — the parent session's id (the side tab's
	 * `parentSessionId`). Forwarded as `side_of` so the backend logs the
	 * side round against its parent. Absent = a main-thread turn
	 * (backward compatible).
	 */
	readonly sideOf?: string;
	/**
	 * Phase 116: Side Chat — the parent thread's recent turns as text
	 * (frontend-capped to AGENT_HISTORY_MAX_TOKENS / 2 tokens; the
	 * backend re-clamps defensively). Injected as a hidden
	 * `<parent_thread reference>` system-prompt block (after rules/
	 * skills); empty/absent = zero change.
	 */
	readonly parentContext?: string;
	/**
	 * Phase 120: the session goal (Cursor parity: give the agent a
	 * long-lived objective to work towards until it's fully complete) —
	 * set via `/goal` in the chat pane and carried on EVERY turn of the
	 * conversation that owns it. The backend injects it as the hidden
	 * `<session goal>` system-prompt block; the model confirms
	 * completion via the mark_goal_complete tool (the `goal_complete`
	 * event flips the goal banner to its done state). Absent = zero
	 * change (backward compatible).
	 */
	readonly goal?: string;
	/**
	 * Phase 139: terminal permission mode (Cursor parity: the Settings →
	 * General permission control) — when the agent's terminal commands
	 * need your approval. 'review_all' = ask before every terminal
	 * command; 'high_risk' (backend default) = the backend whitelist
	 * runs automatically, everything else asks; 'trusted' = everything
	 * runs automatically except deny-listed high-risk commands. Absent
	 * = the backend's default (high_risk).
	 */
	readonly permissionMode?: string;
	/**
	 * Phase 157: the conversation's agreed plan file (Cursor plan-as-file
	 * parity) — the `.vibe/plans/*.md` relative path captured from the
	 * plan execute phase's `planPath`. Agent turns of the conversation
	 * that owns the plan carry it; the backend loads the plan file and
	 * injects the hidden `<agreed plan>` system-prompt block so the turn
	 * works off the settled plan instead of re-exploring. Absent = no
	 * agreed plan (backward compatible).
	 */
	readonly planFile?: string;
}

/**
 * Phase 113: queues a mid-turn message for a running Agent turn
 * (`POST /api/chat/agent/steer`). mode="steer" (default) injects it
 * (role=user) at the next tool boundary; mode="queue" (Phase 114,
 * Cursor's queue) never injects mid-turn — the done event reports it
 * as pending_queue and the pane auto-resumes it as a new turn.
 */
export interface IVibeAISteerRequest {
	/** The running Agent request's session id (its steer gate). */
	readonly sessionId: string;
	/** The message text to inject / queue. */
	readonly content: string;
	/**
	 * Phase 114: "steer" (default) = inject at the next tool boundary
	 * (work uninterrupted); "queue" = hold for after the turn (the done
	 * event's pending_queue, auto-resumed as new turns).
	 */
	readonly mode?: 'steer' | 'queue';
}

/** Phase 113: the steer endpoint's acknowledgment. */
export interface IVibeAISteerResponse {
	readonly success: boolean;
	readonly sessionId?: string;
}

/**
 * Phase 71 (Plan mode execute phase): executes a user-approved plan
 * (`POST /api/chat/agent/execute`). `plan` is the object from the plan
 * event (surfaced for approval first), `messages` the conversation so
 * far — the last message is the plan turn's user request.
 */
export interface IVibeAIExecutePlanRequest {
	readonly plan: IVibeAIPlan;
	readonly messages: IVibeAIMessage[];
	readonly model?: string;
	readonly stream?: boolean;
	readonly context?: IVibeAIChatContext;
	readonly provider?: IVibeAIModelProvider;
	readonly contextLimit?: number;
	/**
	 * Phase 70 Auto routing for the execute phase: the non-disabled
	 * Settings → Models pool (resolved provider overrides + tier hints)
	 * sent when `model` is 'auto' — each step's agent routes over it.
	 * An empty pool fails with 400 (沒有模型可用) — no default fallback.
	 */
	readonly autoPool?: IVibeAIModelProvider[];
	/** Phase 70 Auto routing "Optimize For" mode: cost | balance | intelligence. */
	readonly autoMode?: string;
	/**
	 * Phase 107: the editor's opened folder, forwarded per request so the
	 * backend rebinds its tools / RAG index / rules / skills to it
	 * (same semantics as {@link IVibeAIChatRequest.workspaceRoot}).
	 */
	readonly workspaceRoot?: string;
	/**
	 * Phase 139: terminal permission mode for the execute phase's
	 * terminal commands (same semantics as
	 * {@link IVibeAIChatRequest.permissionMode}). Absent = the
	 * backend's default (high_risk).
	 */
	readonly permissionMode?: string;
	/**
	 * Phase 157: the persisted plan file (`.vibe/plans/*.md` relative
	 * path) captured when this plan was last executed — rides along so a
	 * re-execution (restored tab, Build again) keeps the backend's
	 * plan-file persistence in sync. The inline `plan` object still wins
	 * on the backend when both are present.
	 */
	readonly planFile?: string;
}

/**
 * Request for the context usage estimate of the current conversation
 * (`POST /api/chat/agent/context-usage`, Phase 41): `messages` is the
 * conversation so far, `input` an optional pending user message, and
 * `contextLimit` the custom context-window length (100K–1M).
 */
export interface IVibeAIContextUsageRequest {
	readonly messages: IVibeAIMessage[];
	readonly input?: string;
	readonly context?: IVibeAIChatContext;
	readonly contextLimit?: number;
	/**
	 * Ask-mode estimate: when true the backend counts the Ask system
	 * prompt and the read-only tool subset (read_file / list_files /
	 * search_codebase) instead of the full agent tool set, matching
	 * what an Ask-mode turn actually sends.
	 */
	readonly readonly?: boolean;
	/**
	 * Phase 107: the editor's opened folder — rules / skills / MCP are
	 * estimated against it (same semantics as
	 * {@link IVibeAIChatRequest.workspaceRoot}).
	 */
	readonly workspaceRoot?: string;
	/**
	 * Phase 116: Side Chat — the parent thread's recent turns (the side
	 * tab's parent reference, the same text the chat request carries) —
	 * the `parent` breakdown row is assembled by the same function as
	 * the actual injection (estimate ≡ sent).
	 */
	readonly parentContext?: string;
	/**
	 * Phase 120: the session goal (the same objective the chat request
	 * carries) — the `goal` breakdown row is assembled by the same
	 * function as the actual injection (estimate = sent).
	 */
	readonly goal?: string;
	/**
	 * Phase 157: the agreed plan file (the same planFile the agent turns
	 * actually send) — the `plan` breakdown row is assembled by the same
	 * function as the actual injection (estimate = sent).
	 */
	readonly planFile?: string;
}

/**
 * Phase 78: one workspace agent skill for the chat input `/` completion
 * menu (`GET /api/chat/agent/skills`). `disableModelInvocation` skills
 * are hidden from the model but user-trigger-only (`/name` in the input).
 */
export interface IVibeAISkill {
	readonly name: string;
	readonly description: string;
	readonly disableModelInvocation: boolean;
	readonly source: string;
}

/**
 * Phase 127: one workspace file-defined subagent for the chat input `/`
 * completion menu (`GET /api/chat/agent/subagents`; markdown files under
 * `.vibe/agents/`). Picking one fills `/name ` — sending triggers the
 * explicit single-subagent dispatch (Agent mode). `readonly`/`isBackground`
 * are the definition flags (informational; execution stays depth-1 readonly).
 */
export interface IVibeAISubagent {
	readonly name: string;
	readonly description: string;
	readonly readonly: boolean;
	readonly isBackground: boolean;
	readonly source: string;
}

/**
 * Phase 142: the Settings editor's Customize kinds (Cursor parity: Rules /
 * Skills / MCP pages). `VibeAICustomizeScope` picks the layer — project
 * (<workspace>/.vibe) or global (~/.vibe, overridable via VIBE_HOME).
 */
export type VibeAICustomizeKind = 'rules' | 'skills' | 'mcp';
export type VibeAICustomizeScope = 'project' | 'global';

/**
 * Phase 142: one entry of the merged dual-scope customize list
 * (`GET /api/customize/{kind}`). `origin` carries the layer ("workspace" |
 * "global") for the scope badge; the rest are kind-specific — rules:
 * alwaysApply/globs, skills: disableModelInvocation, mcp: command/enabled/
 * status/toolCount. `path` is the absolute definition file (Open file).
 */
export interface IVibeAICustomizeItem {
	readonly name: string;
	readonly description: string;
	readonly source: string;
	readonly origin: string;
	readonly path: string;
	readonly alwaysApply?: boolean;
	readonly globs?: string[];
	readonly disableModelInvocation?: boolean;
	readonly command?: string;
	readonly args?: string[];
	readonly enabled?: boolean;
	readonly status?: string;
	readonly error?: string;
	readonly toolCount?: number;
}

/**
 * Phase 142: payload of `customizeCreate` — kind-specific fields merged
 * into one loose shape (rules: description/alwaysApply/globs/content,
 * skills: description/disableModelInvocation/content, mcp: command/args/
 * env/cwd/disabled).
 */
export interface IVibeAICustomizeCreateData {
	readonly name: string;
	readonly scope: VibeAICustomizeScope;
	readonly description?: string;
	readonly content?: string;
	readonly alwaysApply?: boolean;
	readonly globs?: string[];
	readonly disableModelInvocation?: boolean;
	readonly command?: string;
	readonly args?: string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly disabled?: boolean;
}

/**
 * Phase 142: result of the customize write/toggle/reload calls — `items`
 * is the fresh merged list so the caller re-renders from one response.
 */
export interface IVibeAICustomizeResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly items?: IVibeAICustomizeItem[];
}

/**
 * One breakdown row of the context usage panel. `key` is a stable id
 * the pane renders with a label + color: `systemPrompt` /
 * `toolDefinitions` / `mcpDynamicTools` / `filesContext` / `conversation`.
 */
export interface IVibeAIContextUsagePart {
	readonly key: string;
	readonly tokens: number;
}

/**
 * Context usage estimate for the context usage panel (Cursor parity):
 * token breakdown of the current conversation against the custom
 * context-window limit.
 */
export interface IVibeAIContextUsage {
	readonly limit: number;
	readonly totalTokens: number;
	readonly percentFull: number;
	readonly overLimit: boolean;
	readonly parts: IVibeAIContextUsagePart[];
}

/**
 * Tab completion request (`POST /api/completion`, FIM-style): `prefix`
 * is the text before the cursor, `suffix` the text after it.
 */
export interface IVibeAICompletionRequest {
	readonly prefix: string;
	readonly suffix?: string;
	readonly language?: string;
	readonly maxTokens?: number;
	/**
	 * Custom-model routing (Settings → Models): the editor's resolved
	 * model provider. Tab completion requires a configured custom model —
	 * without one the backend 400s (沒有模型可用) and the provider
	 * silently skips (no ghost text, no upstream request).
	 */
	readonly provider?: IVibeAIModelProvider;
}

/**
 * Inline edit request (`POST /api/chat/edit`): `code` is the selected
 * text (or the whole file) to rewrite according to `instruction`.
 */
export interface IVibeAIInlineEditRequest {
	readonly instruction: string;
	readonly code: string;
	readonly language?: string;
	/**
	 * Custom-model routing (Settings → Models): the editor's resolved
	 * model provider. Requests without a usable model fail with 400
	 * (沒有模型可用) — the Ctrl+K widget gates on it before sending.
	 */
	readonly provider?: IVibeAIModelProvider;
}

/**
 * A file change performed by an agent tool call (`write_file` /
 * `delete_file`), as surfaced in `tool_result` events. `oldContent`
 * is the on-disk content before the change (absent for creates) —
 * the chat pane's tool card offers restoring it.
 */
export interface IVibeAICodeChange {
	readonly filePath: string;
	readonly oldContent?: string | null;
	readonly newContent?: string;
	readonly action?: 'create' | 'update' | 'delete';
	/**
	 * Phase 95: per-file review marks — the editor keep-bar and the files
	 * list rows resolve ONE file at a time. `kept` = the user confirmed
	 * this file's change (the red/green overlay is resolved); `discarded`
	 * = the file was reverted on disk. Both ride on the persisted turn
	 * records (`turnChanges`); optional so sessions saved before Phase 95
	 * simply predate the fields.
	 */
	readonly kept?: boolean;
	readonly discarded?: boolean;
}

/**
 * Actual line range read by a `read_file` tool call (Phase 63), as
 * surfaced in `tool_result` events — the chat pane's tool card shows it
 * in the header ("x.py L10-L20"). `symbol` is the resolved function /
 * class name for symbol-based reads; `total` is the file's full line
 * count; `truncated` marks a clipped (paginated) read.
 */
export interface IVibeAIReadRange {
	readonly start: number;
	readonly end: number;
	readonly total?: number;
	readonly symbol?: string;
	readonly truncated?: boolean;
}

/**
 * Phase 71 (Plan mode, Cursor parity): one step of a structured plan
 * (the `plan` event of `POST /api/chat/agent/plan`). `id` is the step's
 * 1-based number, `files` the paths the step plans to touch.
 */
export interface IVibeAIPlanStep {
	readonly id: number;
	readonly title: string;
	readonly detail?: string;
	readonly files?: string[];
}

/** Phase 71 (Plan mode): a structured plan — summary + ordered steps. */
export interface IVibeAIPlan {
	readonly summary?: string;
	readonly steps: IVibeAIPlanStep[];
}

/** Phase 121 (ask_questions): one question the agent asked mid-turn. */
export interface IVibeAIQuestion {
	readonly question: string;
	readonly options?: string[];
}

/**
 * Phase 159 (IDE diagnostics feedback, Cursor lint-feedback parity): one
 * problem the IDE's language services reported for a file the agent just
 * changed — collected by the chat pane from the marker service and pushed
 * to the running turn (`pushDiagnostics`); the backend injects them as a
 * user message at the next tool boundary.
 */
export interface IVibeAIDiagnostic {
	readonly path: string;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly line?: number;
	readonly source?: string;
}

export type VibeAIStreamEventType = 'text' | 'thinking' | 'tool_start' | 'tool_result' | 'file_delta' | 'round_end' | 'context_compressed' | 'output_truncated' | 'limit_reached' | 'model_routed' | 'plan' | 'plan_start' | 'plan_step_start' | 'plan_step_done' | 'plan_done' | 'agent_questions' | 'approval_request' | 'approval_resolved' | 'steered' | 'diagnostics' | 'done' | 'goal_complete' | 'turn_state' | 'error' | 'retry' | 'unknown';

export interface IVibeAIStreamData {
	readonly requestId: string;
	readonly type: VibeAIStreamEventType;
	readonly text?: string;
	readonly tool?: {
		readonly id?: string;
		readonly name?: string;
		readonly arguments?: string;
		readonly result?: string;
		/** Phase 58: run_terminal raw output (stdout + stderr) for the card's output preview. */
		readonly output?: string;
		readonly status?: string;
		readonly codeChange?: IVibeAICodeChange;
		/** Phase 63: read_file actual line range for the card's args summary. */
		readonly read?: IVibeAIReadRange;
		/** Phase 137: needs-console command handed off to the editor's integrated terminal. */
		readonly editorTerminal?: boolean;
	};
	readonly filePath?: string;
	readonly delta?: string;
	readonly rounds?: number;
	readonly message?: string;
	/**
	 * `error` (Phase 134): the backend classified the failure as a transient
	 * provider error (connection refused / timeout / 429 / 5xx) — the pane
	 * renders a Retry button on the error row (Cursor parity).
	 * `error` (Phase 154): client-side transport failures are ALWAYS
	 * retryable — `doStream`'s catch (fetch threw: timeout, flaky network,
	 * "TypeError: terminated" when the connection dropped mid-stream) and
	 * HTTP 5xx responses fire the error with this flag set, so ANY
	 * interrupted answer offers Retry instead of a retype.
	 */
	readonly retryable?: boolean;
	/**
	 * `retry` (Phase 134): the backend is retrying the LLM call after a
	 * transient failure (Cursor-parity auto retry with exponential backoff)
	 * — the pane renders a transient "Retrying (n/N)…" chip so the wait is
	 * visible instead of a silent hang.
	 */
	readonly retry?: {
		readonly attempt: number;
		readonly max: number;
		readonly delay: number;
		readonly reason?: string;
	};
	/**
	 * `context_compressed` (Phase 41): conversation tokens before/after
	 * the backend cropped the history to fit the context limit, and the
	 * limit that triggered the compression.
	 */
	readonly before?: number;
	readonly after?: number;
	readonly contextLimit?: number;
	/**
	 * `limit_reached` (Phase 103): the agent loop exhausted its tool-call
	 * budget (all segments used) or its context window — the turn ends
	 * with the backend's forced summary; the pane renders a Continue chip
	 * (Cursor parity) wired to a follow-up send.
	 */
	readonly limitReached?: {
		readonly rounds: number;
		readonly segments: number;
		readonly reason: 'rounds' | 'context' | string;
	};
	/** Phase 51: `output_truncated` — the backend round hit its per-round
	 *  output token budget (finish_reason=length); on thinking models long
	 *  reasoning squeezed out the answer (and tool-call arguments). */
	/**
	 * `model_routed` (Phase 70): the backend's Auto router picked this
	 * model for the turn (Cursor-parity underlying-model display). Emitted
	 * on the turn's first round and again on every fallback switch.
	 */
	readonly modelRouted?: IVibeAIModelRouting;
	/**
	 * `turn_state` (Phase 150): the backend turn state machine's explicit
	 * lifecycle announcement (Cursor-parity event-driven design) —
	 * thinking / executing_tools / waiting_approval / awaiting_plan_approval /
	 * compacting / finalizing, then a terminal completed | failed |
	 * interrupted. Stored on the stream state; the awaiting-plan guard
	 * reads it instead of only frontend-inferred flags.
	 */
	readonly turnState?: string;
	/**
	 * Phase 71 (Plan mode): the structured plan of `plan` / `plan_start`
	 * events. A `plan` event without a plan object = the backend failed
	 * to produce a valid plan (the pane renders a retry note).
	 */
	readonly plan?: IVibeAIPlan;
	/** Phase 71 (`plan_step_start` / `plan_step_done`): the step's live state. */
	readonly planStep?: {
		readonly step: number;
		readonly title?: string;
		readonly index?: number;
		readonly total?: number;
		readonly rounds?: number;
		readonly failedTools?: number;
		readonly status?: string;
	};
	/** Phase 71 (`plan_done`): the execution roll-up. */
	readonly planSummary?: {
		readonly steps: number;
		readonly stepsDone: number[];
		readonly stepsFailed: number[];
	};
	/**
	 * Phase 157 (`plan_start` / `plan_done`): the persisted plan file's
	 * workspace-relative path (.vibe/plans/*.md) — the pane captures it
	 * on the conversation so subsequent agent turns carry it as
	 * `planFile` (the backend injects the <agreed plan> block). Absent
	 * when persistence was skipped.
	 */
	readonly planPath?: string;
	/**
	 * Phase 92 (`approval_request` / `approval_resolved`): a terminal
	 * command the backend intercepted (whitelist/hook) and parked at the
	 * approval gate — the pane renders a Run / Skip card and resolves
	 * the gate via {@link IVibeAIService.resolveApproval}.
	 */
	readonly approval?: {
		readonly id: string;
		readonly command: string;
		readonly reason: string;
		readonly approved?: boolean;
		readonly timedOut?: boolean;
	};
	/**
	 * Phase 113 (`steered`): a mid-turn steer the backend just injected
	 * (role=user, at the next tool boundary after the user queued it) —
	 * the pane renders the thread's Steered bubble with it.
	 */
	readonly steered?: string;
	/**
	 * Phase 159 (`diagnostics`): the backend just injected the IDE's
	 * diagnostics report (<ide_diagnostics> block, role=user) for the
	 * files the agent changed — count of the entries injected. The pane
	 * acknowledges it without layout changes (observability parity with
	 * the turn_state precedent).
	 */
	readonly diagnosticsCount?: number;
	/**
	 * Phase 113 (`done`): steers that were queued but never injected —
	 * the turn ended (natural finish / forced summary) before a tool
	 * boundary could drain them. The pane preserves them as steered
	 * history entries with a "not delivered" note (Cursor-parity queue
	 * keep; Phase 114 takes over with auto-resume). Absent = no leftover.
	 */
	readonly pendingSteer?: string[];
	/**
	 * Phase 114 (`done`): messages queued with mode="queue" — they never
	 * inject mid-turn, so the turn close reports them back. The pane
	 * merges them into its queue (content-deduped) and auto-resumes the
	 * first as a NEW agent turn (the rest ride later turn ends). Absent
	 * = no queued leftover.
	 */
	readonly pendingQueue?: string[];
	/**
	 * Phase 121 (`agent_questions`): the questions the agent asked
	 * without stopping work (ask_questions) — the pane renders one
	 * question card per event; the answer is sent via
	 * {@link IVibeAIService.steer} and injects at the next tool
	 * boundary (the loop never waits). Each card has its own id.
	 */
	readonly questions?: {
		readonly id: string;
		readonly items: IVibeAIQuestion[];
	};
	/**
	 * Phase 120 (`goal_complete`): the model declared the session goal
	 * complete via the mark_goal_complete tool — the pane flips the goal
	 * banner to its done state (idempotent on repeated declarations).
	 */
	readonly goalComplete?: boolean;
	/**
	 * Phase 89 (`round_end`): the backend's explicit final-result marker —
	 * true = this round's text is THE answer (the model requested no
	 * tools); the pane folds the Worked shell on it. false = tool calls
	 * follow this round's text (intermediate narration boundary).
	 */
	readonly final?: boolean;
	readonly raw?: unknown;
}

export interface IVibeAIService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired for every chunk received from the backend while a
	 * stream started via {@link IVibeAIService.chatStream} or
	 * {@link IVibeAIService.agentStream} is running.
	 */
	readonly onStreamData: Event<IVibeAIStreamData>;

	/**
	 * Checks whether the VibeCoding backend is reachable.
	 */
	healthCheck(): Promise<boolean>;

	/**
	 * Starts a streaming chat request (`POST /api/chat`) against the
	 * backend. Chunks are reported via {@link IVibeAIService.onStreamData}
	 * and the promise resolves when the stream finished.
	 */
	chatStream(requestId: string, request: IVibeAIChatRequest): Promise<void>;

	/**
	 * Starts a streaming agent request (`POST /api/chat/agent`) against the
	 * backend. Events (thinking / tool_start / tool_result / text / done)
	 * are reported via {@link IVibeAIService.onStreamData}.
	 */
	agentStream(requestId: string, request: IVibeAIChatRequest): Promise<void>;

	/**
	 * Starts the Plan-mode research phase (`POST /api/chat/agent/plan`,
	 * Phase 71 — Cursor-parity Plan Mode): read-only exploration followed
	 * by a structured plan. Events (thinking / tool_start / tool_result /
	 * text / plan / done) are reported via
	 * {@link IVibeAIService.onStreamData}.
	 */
	planStream(requestId: string, request: IVibeAIChatRequest): Promise<void>;

	/**
	 * Starts the Plan-mode execute phase for a user-approved plan
	 * (`POST /api/chat/agent/execute`, Phase 71). Events (plan_start /
	 * plan_step_start / step agent events / plan_step_done / plan_done /
	 * done) are reported via {@link IVibeAIService.onStreamData}.
	 */
	executePlanStream(requestId: string, request: IVibeAIExecutePlanRequest): Promise<void>;

	/**
	 * Aborts a running stream previously started with the given request id.
	 */
	cancel(requestId: string): void;

	/**
	 * Tests a custom model provider's connectivity (`POST {baseUrl}/chat/completions`
	 * with a 1-token ping). Resolves to an empty string on success, or a
	 * human-readable error message. Used by the settings dialog's Models page.
	 */
	testModel(provider: IVibeAIModelProvider): Promise<string>;

	/**
	 * Discovers the models a custom provider exposes (`GET {baseUrl}/models`,
	 * OpenAI-compatible: `{ "data": [{ "id": "..." }, ...] }`). Resolves to
	 * the de-duplicated, sorted model ids; rejects with a human-readable
	 * error. Used by the settings dialog's Models page "Scan models" action.
	 */
	discoverModels(baseUrl: string, apiKey?: string): Promise<string[]>;

	/**
	 * Restores a file on disk to the given content (`PUT /api/files/`).
	 * Used by the chat pane's tool card to undo an agent's write_file.
	 * Relative paths are resolved against `workspaceRoot` when given
	 * (the editor's opened folder, Phase 107), otherwise against the
	 * backend's default root. Returns true when the backend confirmed
	 * the write.
	 */
	restoreFile(path: string, content: string, workspaceRoot?: string): Promise<boolean>;

	/**
	 * Deletes a file on disk (`DELETE /api/files/{path}`). Used by the
	 * chat pane's files summary "Discard" to remove a file the agent
	 * created this turn. Relative paths are resolved against
	 * `workspaceRoot` when given (Phase 107), otherwise against the
	 * backend's default root. Returns true when the backend confirmed
	 * the deletion.
	 */
	deleteFile(path: string, workspaceRoot?: string): Promise<boolean>;

	/**
	 * Phase 92: resolves a command approval gate (`POST
	 * /api/chat/agent/approvals/resolve`). Called by the chat pane's
	 * Run / Skip card while the backend's agent loop waits at the gate.
	 * Returns true when the backend confirmed the resolution.
	 *
	 * Phase 160 (approval memory, Cursor auto-run parity): `scope`
	 * extends an approval with memory — "once" (default, plain Run),
	 * "turn" (the same command stops asking until the turn ends), or
	 * "project" (persisted to `<projectRoot>/.vibe/approvals.json`,
	 * the gate hot-reads it). `projectRoot` is the opened folder's
	 * path (`currentWorkspaceRoot()`); empty/invalid → the backend
	 * downgrades to once silently. Blacklist commands are never
	 * exempted by memory (backend-enforced).
	 */
	resolveApproval(id: string, approved: boolean, scope?: 'once' | 'turn' | 'project', projectRoot?: string): Promise<boolean>;

	/**
	 * Phase 113: queues a mid-turn steer for the running Agent turn
	 * (`POST /api/chat/agent/steer`, session_id = the request's session).
	 * mode="steer" (default): the backend's loop injects it at the next
	 * tool boundary and the `steered` event confirms it. mode="queue"
	 * (Phase 114, Cursor's queue): never injects mid-turn — the done
	 * event reports it as pending_queue and the pane auto-resumes the
	 * queue as new turns. Returns true when the backend accepted the
	 * message; false when there is no running turn for the session (404)
	 * or the request failed — the caller keeps the text.
	 */
	steer(sessionId: string, content: string, mode?: 'steer' | 'queue'): Promise<boolean>;

	/**
	 * Phase 159: pushes the IDE's diagnostics (errors/warnings) for the
	 * files the agent just changed to the running Agent turn (`POST
	 * /api/chat/agent/diagnostics`, session_id = the request's session).
	 * The backend's loop injects them as a user message at the next tool
	 * boundary. Fire-and-forget: resolves false when the turn already
	 * finished (the backend drops the push silently — queued 0) or the
	 * request failed; the caller never surfaces an error.
	 */
	pushDiagnostics(sessionId: string, diagnostics: IVibeAIDiagnostic[]): Promise<boolean>;

	/**
	 * Fetches a Tab completion for the given cursor context
	 * (`POST /api/completion`). Returns the text to insert at the
	 * cursor position, or null when the backend produced nothing.
	 */
	complete(request: IVibeAICompletionRequest): Promise<string | null>;

	/**
	 * Rewrites code according to a natural-language instruction
	 * (`POST /api/chat/edit`). Returns the rewritten code, or null
	 * when the backend produced nothing.
	 */
	inlineEdit(request: IVibeAIInlineEditRequest): Promise<string | null>;

	/**
	 * Estimates the current conversation's token usage breakdown for
	 * the context usage panel (`POST /api/chat/agent/context-usage`,
	 * Phase 41).
	 */
	contextUsage(request: IVibeAIContextUsageRequest): Promise<IVibeAIContextUsage>;

	/**
	 * Lists the workspace agent skills for the chat input `/` completion
	 * menu (`GET /api/chat/agent/skills`, Phase 78). Includes
	 * `disableModelInvocation` skills (user-trigger-only). When
	 * `workspaceRoot` is given the opened folder's skills are listed
	 * (Phase 107).
	 */
	listSkills(workspaceRoot?: string): Promise<IVibeAISkill[]>;

	/**
	 * Lists the workspace file-defined subagents for the chat input `/`
	 * completion menu (`GET /api/chat/agent/subagents`, Phase 127).
	 * Picking one fills `/name ` — sending triggers the explicit
	 * single-subagent dispatch (Agent mode). When `workspaceRoot` is
	 * given the opened folder's agents are listed (Phase 107).
	 */
	listSubagents(workspaceRoot?: string): Promise<IVibeAISubagent[]>;

	/**
	 * Phase 142: lists the merged dual-scope customize items for the
	 * Settings → Rules / Skills / MCP pages (`GET /api/customize/{kind}`).
	 * When `workspaceRoot` is given the list is resolved against that
	 * folder's project layer (Phase 107).
	 */
	customizeList(kind: VibeAICustomizeKind, workspaceRoot?: string): Promise<IVibeAICustomizeItem[]>;

	/**
	 * Phase 142: creates a customize entry (`POST /api/customize/{kind}`).
	 * `scope` picks the layer: project (<workspace>/.vibe) or global
	 * (~/.vibe). Resolves to the fresh merged list on success.
	 */
	customizeCreate(kind: VibeAICustomizeKind, data: IVibeAICustomizeCreateData, workspaceRoot?: string): Promise<IVibeAICustomizeResult>;

	/**
	 * Phase 142: deletes a customize entry from the given scope
	 * (`DELETE /api/customize/{kind}?name=&scope=`). Resolves to the fresh
	 * merged list on success.
	 */
	customizeDelete(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult>;

	/**
	 * Phase 142: toggles an MCP server's enabled flag in the given scope
	 * (`POST /api/customize/mcp/toggle`) and hot-reloads the config. MCP
	 * servers only — other kinds resolve to { ok: false }.
	 */
	customizeToggle(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult>;

	/**
	 * Phase 142: hot-reloads the MCP configuration after mcp.json changes
	 * (`POST /api/chat/agent/mcp/reload`) — rebuilds the connection table,
	 * reconnects and returns the fresh server statuses.
	 */
	reloadMcp(workspaceRoot?: string): Promise<IVibeAICustomizeResult>;
}

export const IVibeAIService = createDecorator<IVibeAIService>('vibeAI');
