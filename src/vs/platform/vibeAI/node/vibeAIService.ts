/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { timeout } from '../../../base/common/async.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IVibeAIChatRequest, IVibeAICompletionRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIExecutePlanRequest, IVibeAIInlineEditRequest, IVibeAIModelProvider, IVibeAIPlan, IVibeAIPlanStep, IVibeAIService, IVibeAISkill, IVibeAIStreamData, VIBE_AI_DEFAULT_BACKEND_URL } from '../common/vibeAI.js';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Node (main process) implementation of the {@link IVibeAIService}.
 *
 * Performs the HTTP requests against the local VibeCoding backend
 * (FastAPI) and parses the SSE stream into {@link IVibeAIStreamData}
 * events. Running in the main process means the requests bypass the
 * CORS restrictions of the browser layer.
 */
export class VibeAIService extends Disposable implements IVibeAIService {

	declare readonly _serviceBrand: undefined;

	private readonly _onStreamData = this._register(new Emitter<IVibeAIStreamData>());
	readonly onStreamData = this._onStreamData.event;

	private readonly activeStreams = new Map<string, AbortController>();

	// Cursor-style backend ownership: the editor is the entry point and owns
	// its local AI backend as a child of its process tree (spawn/reuse, killed on quit).
	private backendChild: ChildProcess | null = null;

	constructor(
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		// Fire-and-forget: startup must never block on the backend coming up.
		this._ensureBackend();
	}

	get backendUrl(): string {
		return this.productService.vibeAI?.backendUrl ?? process.env['VIBE_BACKEND_URL'] ?? VIBE_AI_DEFAULT_BACKEND_URL;
	}

	/**
	 * Root directory of the local VibeCoding backend (contains `app/main.py`
	 * and `venv/`). Configured via product.json `vibeAI.backendRoot`, with an
	 * environment override for local development.
	 */
	get backendRoot(): string {
		return this.productService.vibeAI?.backendRoot ?? process.env['VIBE_BACKEND_ROOT'] ?? '';
	}

	/**
	 * Cursor-style backend ownership (the editor is the entry point): make
	 * sure a healthy backend is listening on `backendUrl`. One that is already
	 * running (started manually) is reused, never duplicated; otherwise a
	 * local uvicorn instance is spawned from `backendRoot` as a child of this
	 * process and killed again on app quit ("follows the editor's lifecycle").
	 * Set `VIBE_BACKEND_SPAWN=0` to skip spawning (editor without backend).
	 */
	private async _ensureBackend(): Promise<void> {
		if (process.env['VIBE_BACKEND_SPAWN'] === '0') {
			this.logService.info('[VibeAI] VIBE_BACKEND_SPAWN=0, not spawning backend');
			return;
		}
		if (await this.healthCheck()) {
			this.logService.info(`[VibeAI] backend already running at ${this.backendUrl}, reusing it`);
			return;
		}

		const root = this.backendRoot;
		if (!root || !existsSync(join(root, 'app', 'main.py'))) {
			this.logService.warn(`[VibeAI] backend root not found (${root || 'unset'}), not spawning backend`);
			return;
		}
		const python = join(root, 'venv', 'Scripts', 'python.exe');
		if (!existsSync(python)) {
			this.logService.warn(`[VibeAI] backend venv python not found (${python}), not spawning backend`);
			return;
		}

		let host = '127.0.0.1';
		let port = '80';
		try {
			const url = new URL(this.backendUrl);
			host = url.hostname || host;
			port = url.port || port;
		} catch (error) {
			this.logService.warn(`[VibeAI] invalid backend URL (${this.backendUrl}), not spawning backend`, error);
			return;
		}

		this.logService.info(`[VibeAI] spawning local backend (uvicorn app.main:app --host ${host} --port ${port})`);
		const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', host, '--port', port], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		this.backendChild = child;
		child.stdout?.on('data', (chunk: Buffer) => this.logService.debug(`[VibeAI backend] ${String(chunk).trim()}`));
		child.stderr?.on('data', (chunk: Buffer) => this.logService.debug(`[VibeAI backend] ${String(chunk).trim()}`));
		child.on('error', error => {
			this.logService.error('[VibeAI] backend spawn failed', error);
			if (this.backendChild === child) {
				this.backendChild = null;
			}
		});
		child.on('exit', code => {
			this.logService.warn(`[VibeAI] backend process exited (code ${code})`);
			if (this.backendChild === child) {
				this.backendChild = null;
			}
		});

		// Readiness: uvicorn plus the app's imports (chromadb, ...) can take a
		// while - poll /health in the background, never block startup.
		for (let attempt = 0; attempt < 120; attempt++) {
			await timeout(500);
			if (child.exitCode !== null) {
				this.logService.error(`[VibeAI] backend exited during startup (code ${child.exitCode})`);
				return;
			}
			if (await this.healthCheck()) {
				this.logService.info(`[VibeAI] local backend ready at ${this.backendUrl} (pid ${child.pid})`);
				return;
			}
		}
		this.logService.warn('[VibeAI] backend did not become healthy within 60s');
	}

	override dispose(): void {
		if (this.backendChild?.pid) {
			// Tree-kill: uvicorn may own grandchildren, and child.kill() on
			// Windows only takes down the direct process.
			spawn('taskkill', ['/PID', String(this.backendChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			this.backendChild = null;
		}
		super.dispose();
	}

	async healthCheck(): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2500);
		try {
			const response = await fetch(`${this.backendUrl}/health`, { signal: controller.signal });
			return response.ok;
		} catch (error) {
			this.logService.debug('[VibeAI] health check failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async chatStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		// Note: the backend route is registered as `/api/chat/` (trailing slash,
		// `@router.post("/")` under prefix `/api/chat`) — calling it without the
		// slash would trigger an HTTP 307 redirect first.
		return this.doStream(requestId, `${this.backendUrl}/api/chat/`, request);
	}

	async agentStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent`, request);
	}

	/**
	 * Phase 71 (Plan mode): the research phase — read-only exploration
	 * followed by a structured plan (`POST /api/chat/agent/plan`).
	 */
	async planStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent/plan`, request);
	}

	/**
	 * Phase 71 (Plan mode): the execute phase of a user-approved plan
	 * (`POST /api/chat/agent/execute`).
	 */
	async executePlanStream(requestId: string, request: IVibeAIExecutePlanRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent/execute`, request);
	}

	cancel(requestId: string): void {
		this.activeStreams.get(requestId)?.abort();
	}

	/**
	 * Tests a custom model provider's connectivity with a 1-token ping
	 * (Settings → Models "Test" button). Runs directly against the
	 * provider's OpenAI-compatible endpoint — no backend involvement —
	 * and resolves to '' on success or a human-readable error message.
	 */
	async testModel(provider: IVibeAIModelProvider): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const base = provider.baseUrl.replace(/\/+$/, '');
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (provider.apiKey) {
				headers['Authorization'] = `Bearer ${provider.apiKey}`;
			}
			const response = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model: provider.model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: false,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}`;
			}
			return '';
		} catch (error) {
			if (controller.signal.aborted) {
				return 'Timed out after 15s';
			}
			return String(error);
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Scans a custom provider for the models it exposes (`GET {baseUrl}/models`,
	 * Settings → Models "Scan models" action). Runs directly against the
	 * provider's OpenAI-compatible endpoint — no backend involvement — and
	 * resolves to the de-duplicated, sorted model ids the provider reports.
	 */
	async discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const base = baseUrl.replace(/\/+$/, '');
			const headers: Record<string, string> = {};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const response = await fetch(`${base}/models`, {
				headers,
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}`);
			}
			// OpenAI-compatible shape: `{ "data": [{ "id": "gpt-4o" }, ...] }`.
			// Some servers answer with a bare `models` array instead.
			const body = await response.json() as { data?: unknown; models?: unknown };
			const entries: unknown[] = Array.isArray(body.data)
				? body.data
				: Array.isArray(body.models)
					? body.models
					: [];
			const ids = entries
				.map((entry: unknown) => typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id)
				.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
			this.logService.debug(`[VibeAI] discovered ${ids.length} models at ${base}/models`);
			return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error('Timed out after 15s');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	async restoreFile(path: string, content: string): Promise<boolean> {
		// The files router registers `@router.put("/")` under prefix `/api/files`
		// — the URL needs the trailing slash to avoid an HTTP 307 redirect.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/files/`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content }),
				signal: controller.signal
			});
			return response.ok;
		} catch (error) {
			this.logService.error('[VibeAI] restore file failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async deleteFile(path: string): Promise<boolean> {
		// The files router registers `@router.delete("/{path:path}")` under
		// prefix `/api/files` — the path param arrives percent-decoded, so
		// encodeURIComponent keeps nested paths intact (uvicorn unquotes
		// the raw path). Relative paths are resolved against PROJECT_ROOT
		// server-side (same as PUT).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/files/${encodeURIComponent(path)}`, {
				method: 'DELETE',
				signal: controller.signal
			});
			return response.ok;
		} catch (error) {
			this.logService.error('[VibeAI] delete file failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async complete(request: IVibeAICompletionRequest): Promise<string | null> {
		// `@router.post("")` under prefix `/api/completion` — unlike the chat
		// and files routes above, this URL has NO trailing slash.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/completion`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prefix: request.prefix,
					suffix: request.suffix ?? '',
					language: request.language,
					max_tokens: request.maxTokens ?? 60,
					// Custom-model routing: Tab completion goes to the editor's
					// resolved model provider (backend 400s 沒有模型可用
					// without one — surfaces as null and skips silently).
					provider: request.provider
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				this.logService.debug(`[VibeAI] completion request failed: HTTP ${response.status}`);
				return null;
			}
			const payload = await response.json() as { data?: { completion?: string } };
			return payload?.data?.completion ?? null;
		} catch (error) {
			this.logService.debug('[VibeAI] completion failed', error);
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}

	async inlineEdit(request: IVibeAIInlineEditRequest): Promise<string | null> {
		// `@router.post("/edit")` under prefix `/api/chat` — the URL has no
		// trailing slash. Rewrites can take a while (large max_tokens), hence
		// the generous timeout.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/edit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					instruction: request.instruction,
					code: request.code,
					language: request.language,
					// Custom-model routing: Ctrl+K goes to the editor's
					// resolved model provider (gated in the widget).
					provider: request.provider
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				this.logService.warn(`[VibeAI] inline edit request failed: HTTP ${response.status}`);
				return null;
			}
			const payload = await response.json() as { data?: { code?: string } };
			return payload?.data?.code ?? null;
		} catch (error) {
			this.logService.error('[VibeAI] inline edit failed', error);
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}

	async contextUsage(request: IVibeAIContextUsageRequest): Promise<IVibeAIContextUsage> {
		// `@router.post("/agent/context-usage")` under prefix `/api/chat` —
		// token usage breakdown for the context usage panel (Phase 41).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/context-usage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: request.messages,
					input: request.input ?? '',
					context: request.context,
					contextLimit: request.contextLimit,
					// Ask-mode estimate: read-only tool subset + Ask system prompt.
					readonly: request.readonly
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend context usage request failed (HTTP ${response.status})`);
			}
			return await response.json() as IVibeAIContextUsage;
		} finally {
			clearTimeout(timeout);
		}
	}

	async listSkills(): Promise<IVibeAISkill[]> {
		// `@router.get("/agent/skills")` under prefix `/api/chat` —
		// workspace skills for the chat input `/` completion menu (Phase 78).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/skills`, {
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend skills request failed (HTTP ${response.status})`);
			}
			const data = await response.json() as { skills?: IVibeAISkill[] };
			return Array.isArray(data.skills) ? data.skills : [];
		} finally {
			clearTimeout(timeout);
		}
	}

	private async doStream(requestId: string, url: string, request: IVibeAIChatRequest | IVibeAIExecutePlanRequest): Promise<void> {
		// A new stream with the same request id cancels the previous one
		this.activeStreams.get(requestId)?.abort();

		// Phase 71: the execute request carries the plan (the chat request
		// carries the Auto-routing fields) — narrow per field group.
		const chat = request as IVibeAIChatRequest;
		const execute = request as IVibeAIExecutePlanRequest;
		const controller = new AbortController();
		this.activeStreams.set(requestId, controller);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: request.messages,
					stream: true,
					model: request.model,
					context: request.context,
					// Custom-model routing (Settings → Models): provider
					// override {baseUrl, apiKey, model} for OpenAI-compatible
					// endpoints other than the backend's default model.
					provider: request.provider,
					// Phase 41: custom context-window length (100K–1M) — the
					// backend compresses (crops) the history to fit before
					// running the agent loop.
					contextLimit: request.contextLimit,
					// Phase 70 Auto routing: the pseudo-model 'auto' plus the
					// non-disabled Settings → Models pool (resolved provider
					// overrides + tier hints) and the Optimize For mode — the
					// backend's router picks one per turn and falls back down
					// the list on provider failures.
					autoPool: chat.autoPool,
					autoMode: chat.autoMode,
					// Phase 71 Plan mode execute phase: the user-approved plan.
					plan: execute.plan
				}),
				signal: controller.signal
			});
			if (!response.ok || !response.body) {
				// FastAPI errors carry a JSON `detail` (e.g. 400 沒有模型
				// 可用 when no custom model is configured) — surface it so
				// the pane shows the actionable message, not the bare status.
				let detail = '';
				try {
					const body = await response.json() as { detail?: unknown };
					if (typeof body?.detail === 'string' && body.detail.length > 0) {
						detail = body.detail;
					}
				} catch {
					// Non-JSON error body — fall back to the status line.
				}
				const message = detail.length > 0
					? detail
					: `VibeAI backend request failed (HTTP ${response.status})`;
				this.logService.warn(`[VibeAI] ${message}`);
				this._onStreamData.fire({ requestId, type: 'error', message });
				this._onStreamData.fire({ requestId, type: 'done' });
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder('utf-8');
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });

				let separatorIndex: number;
				while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.substring(0, separatorIndex);
					buffer = buffer.substring(separatorIndex + 2);
					this.handleSSEFrame(requestId, frame);
				}
			}
			buffer += decoder.decode();
			if (buffer.trim().length > 0) {
				this.handleSSEFrame(requestId, buffer);
			}
			this._onStreamData.fire({ requestId, type: 'done' });
		} catch (error) {
			if (controller.signal.aborted) {
				this._onStreamData.fire({ requestId, type: 'done' });
			} else {
				this.logService.error('[VibeAI] stream failed', error);
				this._onStreamData.fire({ requestId, type: 'error', message: String(error) });
				this._onStreamData.fire({ requestId, type: 'done' });
			}
		} finally {
			this.activeStreams.delete(requestId);
		}
	}

	private handleSSEFrame(requestId: string, frame: string): void {
		for (const line of frame.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data: ')) {
				continue;
			}
			const payload = trimmed.substring('data: '.length).trim();
			if (payload === '[DONE]') {
				// Terminal SSE marker — `doStream` fires the done event exactly
				// once when the response body ends, so nothing to emit here.
				continue;
			}
			try {
				const event = JSON.parse(payload);
				for (const data of this.normalizeEvent(requestId, event)) {
					this._onStreamData.fire(data);
				}
			} catch {
				this.logService.debug(`[VibeAI] failed to parse SSE payload: ${payload}`);
			}
		}
	}

	/**
	 * Phase 71: defensive plan normalization — the backend's plan object
	 * (`{summary, steps}`) must carry a non-empty steps array of
	 * `{id, title}` objects; anything else returns undefined so the pane
	 * renders the retry note instead of a broken card.
	 */
	private normalizePlan(plan: unknown): IVibeAIPlan | undefined {
		if (!plan || typeof plan !== 'object' || !Array.isArray((plan as { steps?: unknown }).steps)) {
			return undefined;
		}
		const steps: IVibeAIPlanStep[] = [];
		for (const step of (plan as { steps: unknown[] }).steps) {
			if (!step || typeof step !== 'object') {
				continue;
			}
			const candidate = step as { id?: unknown; title?: unknown; detail?: unknown; files?: unknown };
			if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
				continue;
			}
			steps.push({
				id: typeof candidate.id === 'number' ? candidate.id : steps.length + 1,
				title: candidate.title,
				detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
				files: Array.isArray(candidate.files) ? candidate.files.filter((file): file is string => typeof file === 'string') : undefined,
			});
		}
		if (steps.length === 0) {
			return undefined;
		}
		const summary = (plan as { summary?: unknown }).summary;
		return {
			summary: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
			steps,
		};
	}

	private normalizeEvent(requestId: string, event: any): IVibeAIStreamData[] {
		// Backend error payload: { "error": string }
		if (typeof event?.error === 'string') {
			return [{ requestId, type: 'error', message: event.error }];
		}

		// POST /api/chat: OpenAI-compatible chat chunk
		// (Thinking models emit `reasoning` deltas in addition to `content`)
		const delta = event?.choices?.[0]?.delta;
		if (delta || event?.choices) {
			const result: IVibeAIStreamData[] = [];
			if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
				result.push({ requestId, type: 'thinking', text: delta.reasoning });
			}
			if (typeof delta?.content === 'string' && delta.content.length > 0) {
				result.push({ requestId, type: 'text', text: delta.content });
			}
			return result;
		}

		// POST /api/chat/agent: typed agent events
		switch (event?.type) {
			case 'thinking':
				return [{ requestId, type: 'thinking', text: event.content ?? '', raw: event }];
			case 'text':
				return [{ requestId, type: 'text', text: event.content ?? '', raw: event }];
			case 'tool_start':
				return [{ requestId, type: 'tool_start', tool: { id: event.id, name: event.name, arguments: event.arguments }, raw: event }];
			case 'tool_result': {
				// The backend sends `result` as a `{ summary: string }` object
				// (orchestrator._summarize_tool_result) while the type contract
				// (vibeAI.ts) declares `string`. Normalize to the plain text the
				// tool card header and the persisted record expect — a non-string
				// used to crash clipText ("text.substring is not a function") on
				// turn finish, which aborted finishStreaming and left the input's
				// stop button stuck in the streaming state.
				const rawResult = event.result;
				const result = typeof rawResult === 'string'
					? rawResult
					: (rawResult && typeof rawResult === 'object' && typeof rawResult.summary === 'string' ? rawResult.summary : undefined);
				// Phase 58: run_terminal results carry the raw command output
				// (stdout + stderr) for the card's collapsible output preview.
				const output = rawResult && typeof rawResult === 'object' && typeof rawResult.output === 'string'
					? rawResult.output
					: undefined;
				// Phase 63: read_file results carry the actual line range read
				// (start/end + total/symbol) for the card's args summary.
				const read = rawResult && typeof rawResult === 'object'
					&& rawResult.read && typeof rawResult.read === 'object'
					? rawResult.read
					: undefined;
				return [{ requestId, type: 'tool_result', tool: { id: event.id, name: event.name, arguments: event.arguments, result, status: event.status, codeChange: event.code_change, output, read }, raw: event }];
			}
			case 'file_delta':
				// `id` ties streaming write content to its pending tool card.
				return [{
					requestId,
					type: 'file_delta',
					filePath: event.path,
					delta: event.delta,
					tool: typeof event.id === 'string' && event.id.length > 0 ? { id: event.id } : undefined,
					raw: event
				}];
			case 'context_compressed':
				// Phase 41: the backend cropped the conversation history to
				// fit the context limit before running the agent loop.
				return [{
					requestId,
					type: 'context_compressed',
					before: event.before,
					after: event.after,
					contextLimit: event.limit,
					raw: event
				}];
			case 'output_truncated':
				// Phase 51: the round hit its per-round output token budget
				// (finish_reason=length) — the pane renders a truncation note.
				return [{ requestId, type: 'output_truncated', raw: event }];
			case 'model_routed':
				// Phase 70: the Auto router picked this model for the turn
				// (intent+complexity routing over the Settings → Models pool;
				// emitted again on every fallback switch).
				return [{
					requestId,
					type: 'model_routed',
					modelRouted: {
						model: typeof event.model === 'string' ? event.model : '',
						name: typeof event.name === 'string' && event.name.length > 0 ? event.name : event.model,
						tier: typeof event.tier === 'string' ? event.tier : '',
						mode: typeof event.mode === 'string' ? event.mode : '',
						reason: typeof event.reason === 'string' ? event.reason : '',
					},
					raw: event
				}];
			case 'plan':
				// Phase 71 Plan mode: the research phase's structured plan.
				// A null/invalid plan = the backend failed to produce one —
				// still emitted so the pane can render the retry note.
				return [{
					requestId,
					type: 'plan',
					plan: this.normalizePlan(event?.plan),
					raw: event
				}];
			case 'plan_start':
				// Phase 71: the execute phase kicked off for the approved
				// plan (steps count + the plan again for the progress card).
				return [{
					requestId,
					type: 'plan_start',
					plan: this.normalizePlan(event?.plan),
					raw: event
				}];
			case 'plan_step_start':
				// Phase 71: one plan step began (its agent events follow).
				return [{
					requestId,
					type: 'plan_step_start',
					planStep: {
						step: typeof event.step === 'number' ? event.step : 0,
						title: typeof event.title === 'string' ? event.title : undefined,
						index: typeof event.index === 'number' ? event.index : undefined,
						total: typeof event.total === 'number' ? event.total : undefined,
					},
					raw: event
				}];
			case 'plan_step_done':
				// Phase 71: one plan step finished (status done /
				// done_with_errors + failed tool count).
				return [{
					requestId,
					type: 'plan_step_done',
					planStep: {
						step: typeof event.step === 'number' ? event.step : 0,
						title: typeof event.title === 'string' ? event.title : undefined,
						rounds: typeof event.rounds === 'number' ? event.rounds : undefined,
						failedTools: typeof event.failedTools === 'number' ? event.failedTools : undefined,
						status: typeof event.status === 'string' ? event.status : undefined,
					},
					raw: event
				}];
			case 'plan_done':
				// Phase 71: the whole plan executed — done/failed step ids.
				return [{
					requestId,
					type: 'plan_done',
					planSummary: {
						steps: typeof event.steps === 'number' ? event.steps : 0,
						stepsDone: Array.isArray(event.stepsDone) ? event.stepsDone.filter((s: unknown): s is number => typeof s === 'number') : [],
						stepsFailed: Array.isArray(event.stepsFailed) ? event.stepsFailed.filter((s: unknown): s is number => typeof s === 'number') : [],
					},
					raw: event
				}];
			case '_round_end':
				return [{ requestId, type: 'round_end', raw: event }];
			case 'done':
				return [{ requestId, type: 'done', rounds: event.rounds, raw: event }];
			default:
				return [{ requestId, type: 'unknown', raw: event }];
		}
	}
}

