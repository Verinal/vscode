/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAICustomizeResult, IVibeAIChatRequest, IVibeAICompletionRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIExecutePlanRequest, IVibeAIInlineEditRequest, IVibeAIModelProvider, IVibeAIService, IVibeAISkill, IVibeAIStreamData, IVibeAISubagent, VibeAICustomizeKind, VibeAICustomizeScope } from './vibeAI.js';

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
			case 'resolveApproval': {
				const { id, approved } = arg as { id: string; approved: boolean };
				return this.service.resolveApproval(id, approved);
			}
			case 'steer': {
				// Phase 113: queue a mid-turn steer for the running Agent
				// Phase 113/114: a mid-turn steer (mode=steer, injects at
				// the next tool boundary) or a queue-mode message
				// (mode=queue, auto-resumes after the turn ends).
				const { sessionId, content, mode } = arg as { sessionId: string; content: string; mode?: 'steer' | 'queue' };
				return this.service.steer(sessionId, content, mode);
			}
			case 'complete': {
				return this.service.complete(arg as IVibeAICompletionRequest);
			}
			case 'inlineEdit': {
				return this.service.inlineEdit(arg as IVibeAIInlineEditRequest);
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

	resolveApproval(id: string, approved: boolean): Promise<boolean> {
		return this.channel.call<boolean>('resolveApproval', { id, approved });
	}

	steer(sessionId: string, content: string, mode?: 'steer' | 'queue'): Promise<boolean> {
		// Phase 113: queue a mid-turn steer (Cursor's "send now"); Phase
		// 114: mode=queue rides the queue (auto-resume after the turn).
		return this.channel.call<boolean>('steer', { sessionId, content, mode });
	}

	complete(request: IVibeAICompletionRequest): Promise<string | null> {
		return this.channel.call<string | null>('complete', request);
	}

	inlineEdit(request: IVibeAIInlineEditRequest): Promise<string | null> {
		return this.channel.call<string | null>('inlineEdit', request);
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
}

