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
}

export interface IVibeAIFileContext {
	readonly path: string;
	readonly content?: string;
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

export type VibeAIStreamEventType = 'text' | 'thinking' | 'tool_start' | 'tool_result' | 'file_delta' | 'round_end' | 'context_compressed' | 'output_truncated' | 'model_routed' | 'plan' | 'plan_start' | 'plan_step_start' | 'plan_step_done' | 'plan_done' | 'done' | 'error' | 'unknown';

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
	};
	readonly filePath?: string;
	readonly delta?: string;
	readonly rounds?: number;
	readonly message?: string;
	/**
	 * `context_compressed` (Phase 41): conversation tokens before/after
	 * the backend cropped the history to fit the context limit, and the
	 * limit that triggered the compression.
	 */
	readonly before?: number;
	readonly after?: number;
	readonly contextLimit?: number;
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
	 * Relative paths are resolved against the backend's workspace root.
	 * Returns true when the backend confirmed the write.
	 */
	restoreFile(path: string, content: string): Promise<boolean>;

	/**
	 * Deletes a file on disk (`DELETE /api/files/{path}`). Used by the
	 * chat pane's files summary "Discard" to remove a file the agent
	 * created this turn. Relative paths are resolved against the
	 * backend's workspace root. Returns true when the backend confirmed
	 * the deletion.
	 */
	deleteFile(path: string): Promise<boolean>;

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
	 * `disableModelInvocation` skills (user-trigger-only).
	 */
	listSkills(): Promise<IVibeAISkill[]>;
}

export const IVibeAIService = createDecorator<IVibeAIService>('vibeAI');
