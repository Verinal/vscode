/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IVibeAIAutomation, IVibeAIAutomationCreateData, IVibeAIAutomationPatch, IVibeAIBackgroundAgent, IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAICustomizeResult, IVibeAIChatRequest, IVibeAIChatTitleRequest, IVibeAICompletionRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIDiagnostic, IVibeAIDocumentExtract, IVibeAIExecutePlanRequest, IVibeAIInlineEditRequest, IVibeAIModelProvider, IVibeAIParallelRequest, IVibeAIParallelRun, IVibeAIService, IVibeAISkill, IVibeAIStreamData, IVibeAISubagent, IVibeAITurnChanges, VibeAICustomizeKind, VibeAICustomizeScope } from './vibeAI.js';

/**
 * Main process side of the VibeAI service IPC. Registered on the
 * `mainProcessElectronServer` so that the workbench (browser layer)
 * can talk to the backend via the main process.
 */
export class VibeAIChannel implements IServerChannel {

	private readonly disposables = new DisposableStore();

	constructor(private readonly service: IVibeAIService) { }

	listen(_: unknown, event: string): Event<any> {
		switch (event) {
			case 'onStreamData': return this.service.onStreamData;
		}

		throw new Error(`Event not found: ${event}`);
	}

	call(_: unknown, command: string, arg?: any): Promise<any> {
		switch (command) {
			case 'healthCheck': return this.service.healthCheck();
			case 'restartBackend': return this.service.restartBackend();
			case 'chatStream': {
				const { requestId, request } = arg as { requestId: string; request: IVibeAIChatRequest };
				return this.service.chatStream(requestId, request);
			}
			case 'agentStream': {
				const { requestId, request } = arg as { requestId: string; request: IVibeAIChatRequest };
				return this.service.agentStream(requestId, request);
			}
			case 'planStream': {
				const { requestId, request } = arg as { requestId: string; request: IVibeAIChatRequest };
				return this.service.planStream(requestId, request);
			}
			case 'executePlanStream': {
				const { requestId, request } = arg as { requestId: string; request: IVibeAIExecutePlanRequest };
				return this.service.executePlanStream(requestId, request);
			}
			case 'parallelStream': {
				// Phase 179: N isolated worktree agents on one prompt.
				const { requestId, request } = arg as { requestId: string; request: IVibeAIParallelRequest };
				return this.service.parallelStream(requestId, request);
			}
			case 'listParallelRuns': {
				return this.service.listParallelRuns(typeof arg === 'string' ? arg : undefined);
			}
			case 'mergeParallelRun': {
				const { workspaceRoot, runId, index } = arg as { workspaceRoot?: string; runId: string; index: number };
				return this.service.mergeParallelRun(workspaceRoot, runId, index);
			}
			case 'discardParallelRun': {
				const { workspaceRoot, runId, index } = arg as { workspaceRoot?: string; runId: string; index?: number };
				return this.service.discardParallelRun(workspaceRoot, runId, index);
			}
			case 'listAutomations': {
				// Phase 189: the Agents Hub's Automations page (trigger +
				// prompt rules the backend runs unattended).
				return this.service.listAutomations(typeof arg === 'string' ? arg : undefined);
			}
			case 'createAutomation': {
				const { workspaceRoot, data } = arg as { workspaceRoot?: string; data: IVibeAIAutomationCreateData };
				return this.service.createAutomation(workspaceRoot, data);
			}
			case 'updateAutomation': {
				const { workspaceRoot, id, patch } = arg as { workspaceRoot?: string; id: string; patch: IVibeAIAutomationPatch };
				return this.service.updateAutomation(workspaceRoot, id, patch);
			}
			case 'deleteAutomation': {
				const { workspaceRoot, id } = arg as { workspaceRoot?: string; id: string };
				return this.service.deleteAutomation(workspaceRoot, id);
			}
			case 'runAutomationNow': {
				const { workspaceRoot, id } = arg as { workspaceRoot?: string; id: string };
				return this.service.runAutomationNow(workspaceRoot, id);
			}
			case 'cancel': {
				this.service.cancel(arg as string);
				return Promise.resolve();
			}
			case 'testModel': {
				return this.service.testModel(arg as IVibeAIModelProvider);
			}
			case 'discoverModels': {
				const { baseUrl, apiKey } = arg as { baseUrl: string; apiKey?: string };
				return this.service.discoverModels(baseUrl, apiKey);
			}
			case 'restoreFile': {
				const { path, content, workspaceRoot } = arg as { path: string; content: string; workspaceRoot?: string };
				return this.service.restoreFile(path, content, workspaceRoot);
			}
			case 'deleteFile': {
				const { path, workspaceRoot } = arg as { path: string; workspaceRoot?: string };
				return this.service.deleteFile(path, workspaceRoot);
			}
			case 'getTurnChanges': {
				// Phase 247: transcript-backed change ledger for the
				// rollback reconciliation (null = transcript gone).
				const { sessionId, turnId, workspaceRoot } = arg as { sessionId: string; turnId: string; workspaceRoot?: string };
				return this.service.getTurnChanges(sessionId, turnId, workspaceRoot);
			}
			case 'resolveApproval': {
				// Phase 160: scope/projectRoot extend the approval with
				// memory (once / turn / project, per the interface docs).
				const { id, approved, scope, projectRoot } = arg as { id: string; approved: boolean; scope?: 'once' | 'turn' | 'project'; projectRoot?: string };
				return this.service.resolveApproval(id, approved, scope, projectRoot);
			}
			case 'resolveAgentQuestion': {
				// Phase 237: resolve the blocking question gate the agent
				// turn parks on (the question card's Send).
				const { id, answer } = arg as { id: string; answer: string };
				return this.service.resolveAgentQuestion(id, answer);
			}
			case 'steer': {
				// Phase 113: queue a mid-turn steer for the running Agent
				// Phase 113/114: a mid-turn steer (mode=steer, injects at
				// the next tool boundary) or a queue-mode message
				// (mode=queue, auto-resumes after the turn ends).
				const { sessionId, content, mode } = arg as { sessionId: string; content: string; mode?: 'steer' | 'queue' };
				return this.service.steer(sessionId, content, mode);
			}
			case 'pushDiagnostics': {
				// Phase 159: push the IDE's diagnostics for the files the
				// agent just changed to the running turn (fire-and-forget).
				const { sessionId, diagnostics } = arg as { sessionId: string; diagnostics: IVibeAIDiagnostic[] };
				return this.service.pushDiagnostics(sessionId, diagnostics);
			}
			case 'complete': {
				return this.service.complete(arg as IVibeAICompletionRequest);
			}
			case 'inlineEdit': {
				return this.service.inlineEdit(arg as IVibeAIInlineEditRequest);
			}
			case 'chatTitle': {
				// Phase 227: the conversation title summary (first question in,
				// short LLM title out — the pane fire-and-forgets it).
				return this.service.chatTitle(arg as IVibeAIChatTitleRequest);
			}
			case 'contextUsage': {
				return this.service.contextUsage(arg as IVibeAIContextUsageRequest);
			}
			case 'listSkills': {
				return this.service.listSkills(typeof arg === 'string' ? arg : undefined);
			}
			case 'listSubagents': {
				// Phase 127: workspace file-defined subagents for the chat
				// input `/` completion menu (explicit /name dispatch).
				return this.service.listSubagents(typeof arg === 'string' ? arg : undefined);
			}
			case 'listBackgroundAgents': {
				// Phase 176: every session's background subagents (registry
				// read-only snapshot) for the Agents Hub Background section.
				return this.service.listBackgroundAgents();
			}
			case 'customizeList': {
				// Phase 142: the Settings editor's Rules / Skills / MCP
				// pages — one generic list call (dual-scope merged items).
				const { kind, workspaceRoot } = arg as { kind: string; workspaceRoot?: string };
				return this.service.customizeList(kind as VibeAICustomizeKind, workspaceRoot);
			}
			case 'customizeCreate': {
				const { kind, data, workspaceRoot } = arg as { kind: string; data: IVibeAICustomizeCreateData; workspaceRoot?: string };
				return this.service.customizeCreate(kind as VibeAICustomizeKind, data, workspaceRoot);
			}
			case 'customizeDelete': {
				const { kind, name, scope, workspaceRoot } = arg as { kind: string; name: string; scope: string; workspaceRoot?: string };
				return this.service.customizeDelete(kind as VibeAICustomizeKind, name, scope as VibeAICustomizeScope, workspaceRoot);
			}
			case 'customizeToggle': {
				// MCP servers only (rules/skills have no enabled flag).
				const { kind, name, scope, workspaceRoot } = arg as { kind: string; name: string; scope: string; workspaceRoot?: string };
				return this.service.customizeToggle(kind as VibeAICustomizeKind, name, scope as VibeAICustomizeScope, workspaceRoot);
			}
			case 'reloadMcp': {
				// Phase 142: hot-reload after mcp.json changes.
				return this.service.reloadMcp(typeof arg === 'string' ? arg : undefined);
			}
			case 'extractDocument': {
				// Phase 171: document chip extraction (PDF / Word / Excel /
				// PPT → text) for the chat composer's drop pipeline.
				const { filename, contentBase64 } = arg as { filename: string; contentBase64: string };
				return this.service.extractDocument({ filename, contentBase64 });
			}
		}

		throw new Error(`Call not found: ${command}`);
	}

	dispose() {
		this.disposables.dispose();
	}
}

/**
 * Client side proxy implementing {@link IVibeAIService} on top of an
 * {@link IChannel}. Used in the browser layer of the workbench.
 */
export class VibeAIClient extends Disposable implements IVibeAIService {

	declare readonly _serviceBrand: undefined;

	private readonly _onStreamData = this._register(new Emitter<IVibeAIStreamData>());
	readonly onStreamData = this._onStreamData.event;

	constructor(private readonly channel: IChannel) {
		super();

		this._register(this.channel.listen<IVibeAIStreamData>('onStreamData')(data => this._onStreamData.fire(data)));
	}

	healthCheck(): Promise<boolean> {
		return this.channel.call<boolean>('healthCheck');
	}

	restartBackend(): Promise<boolean> {
		return this.channel.call<boolean>('restartBackend');
	}

	chatStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.channel.call('chatStream', { requestId, request });
	}

	agentStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.channel.call('agentStream', { requestId, request });
	}

	planStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.channel.call('planStream', { requestId, request });
	}

	executePlanStream(requestId: string, request: IVibeAIExecutePlanRequest): Promise<void> {
		return this.channel.call('executePlanStream', { requestId, request });
	}

	parallelStream(requestId: string, request: IVibeAIParallelRequest): Promise<void> {
		// Phase 179: N isolated worktree agents on one prompt; events ride
		// onStreamData stamped with `parallel` (runId / index / total).
		return this.channel.call('parallelStream', { requestId, request });
	}

	listParallelRuns(workspaceRoot?: string): Promise<IVibeAIParallelRun[]> {
		return this.channel.call<IVibeAIParallelRun[]>('listParallelRuns', workspaceRoot);
	}

	mergeParallelRun(workspaceRoot: string | undefined, runId: string, index: number): Promise<{ ok: boolean; error?: string }> {
		return this.channel.call<{ ok: boolean; error?: string }>('mergeParallelRun', { workspaceRoot, runId, index });
	}

	discardParallelRun(workspaceRoot: string | undefined, runId: string, index?: number): Promise<{ ok: boolean; error?: string }> {
		return this.channel.call<{ ok: boolean; error?: string }>('discardParallelRun', { workspaceRoot, runId, index });
	}

	listAutomations(workspaceRoot?: string): Promise<IVibeAIAutomation[]> {
		// Phase 189: Agents Hub Automations page (per-workspace rules).
		return this.channel.call<IVibeAIAutomation[]>('listAutomations', workspaceRoot);
	}

	createAutomation(workspaceRoot?: string, data?: IVibeAIAutomationCreateData): Promise<IVibeAIAutomation> {
		return this.channel.call<IVibeAIAutomation>('createAutomation', { workspaceRoot, data });
	}

	updateAutomation(workspaceRoot?: string, id?: string, patch?: IVibeAIAutomationPatch): Promise<IVibeAIAutomation> {
		return this.channel.call<IVibeAIAutomation>('updateAutomation', { workspaceRoot, id, patch });
	}

	deleteAutomation(workspaceRoot?: string, id?: string): Promise<{ ok: boolean }> {
		return this.channel.call<{ ok: boolean }>('deleteAutomation', { workspaceRoot, id });
	}

	runAutomationNow(workspaceRoot?: string, id?: string): Promise<{ runId: string }> {
		return this.channel.call<{ runId: string }>('runAutomationNow', { workspaceRoot, id });
	}

	cancel(requestId: string): void {
		this.channel.call('cancel', requestId);
	}

	testModel(provider: IVibeAIModelProvider): Promise<string> {
		return this.channel.call<string>('testModel', provider);
	}

	discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
		return this.channel.call<string[]>('discoverModels', { baseUrl, apiKey });
	}

	restoreFile(path: string, content: string, workspaceRoot?: string): Promise<boolean> {
		return this.channel.call<boolean>('restoreFile', { path, content, workspaceRoot });
	}

	deleteFile(path: string, workspaceRoot?: string): Promise<boolean> {
		return this.channel.call<boolean>('deleteFile', { path, workspaceRoot });
	}

	getTurnChanges(sessionId: string, turnId: string, workspaceRoot?: string): Promise<IVibeAITurnChanges | null> {
		// Phase 247: rollback reconciliation source — see IVibeAIService.
		return this.channel.call<IVibeAITurnChanges | null>('getTurnChanges', { sessionId, turnId, workspaceRoot });
	}

	resolveApproval(id: string, approved: boolean, scope?: 'once' | 'turn' | 'project', projectRoot?: string): Promise<boolean> {
		// Phase 160: scope/projectRoot extend the approval with memory.
		return this.channel.call<boolean>('resolveApproval', { id, approved, scope, projectRoot });
	}

	resolveAgentQuestion(id: string, answer: string): Promise<boolean> {
		// Phase 237: resolve the blocking question gate — see IVibeAIService.
		return this.channel.call<boolean>('resolveAgentQuestion', { id, answer });
	}

	steer(sessionId: string, content: string, mode?: 'steer' | 'queue'): Promise<boolean> {
		// Phase 113: queue a mid-turn steer (Cursor's "send now"); Phase
		// 114: mode=queue rides the queue (auto-resume after the turn).
		return this.channel.call<boolean>('steer', { sessionId, content, mode });
	}

	pushDiagnostics(sessionId: string, diagnostics: IVibeAIDiagnostic[]): Promise<boolean> {
		// Phase 159: push the IDE's diagnostics to the running turn — the
		// backend injects them at the next tool boundary (fire-and-forget).
		return this.channel.call<boolean>('pushDiagnostics', { sessionId, diagnostics });
	}

	complete(request: IVibeAICompletionRequest): Promise<string | null> {
		return this.channel.call<string | null>('complete', request);
	}

	inlineEdit(request: IVibeAIInlineEditRequest): Promise<string | null> {
		return this.channel.call<string | null>('inlineEdit', request);
	}

	chatTitle(request: IVibeAIChatTitleRequest): Promise<string | null> {
		return this.channel.call<string | null>('chatTitle', request);
	}

	contextUsage(request: IVibeAIContextUsageRequest): Promise<IVibeAIContextUsage> {
		return this.channel.call<IVibeAIContextUsage>('contextUsage', request);
	}

	listSkills(workspaceRoot?: string): Promise<IVibeAISkill[]> {
		return this.channel.call<IVibeAISkill[]>('listSkills', workspaceRoot);
	}

	listSubagents(workspaceRoot?: string): Promise<IVibeAISubagent[]> {
		return this.channel.call<IVibeAISubagent[]>('listSubagents', workspaceRoot);
	}

	listBackgroundAgents(): Promise<IVibeAIBackgroundAgent[]> {
		// Phase 176: Agents Hub Background section (registry snapshot).
		return this.channel.call<IVibeAIBackgroundAgent[]>('listBackgroundAgents');
	}

	customizeList(kind: VibeAICustomizeKind, workspaceRoot?: string): Promise<IVibeAICustomizeItem[]> {
		return this.channel.call<IVibeAICustomizeItem[]>('customizeList', { kind, workspaceRoot });
	}

	customizeCreate(kind: VibeAICustomizeKind, data: IVibeAICustomizeCreateData, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		return this.channel.call<IVibeAICustomizeResult>('customizeCreate', { kind, data, workspaceRoot });
	}

	customizeDelete(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		return this.channel.call<IVibeAICustomizeResult>('customizeDelete', { kind, name, scope, workspaceRoot });
	}

	customizeToggle(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		return this.channel.call<IVibeAICustomizeResult>('customizeToggle', { kind, name, scope, workspaceRoot });
	}

	reloadMcp(workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		return this.channel.call<IVibeAICustomizeResult>('reloadMcp', workspaceRoot);
	}

	extractDocument(request: { filename: string; contentBase64: string }): Promise<IVibeAIDocumentExtract> {
		return this.channel.call<IVibeAIDocumentExtract>('extractDocument', request);
	}
}

