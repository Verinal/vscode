/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import { IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAICustomizeResult, IVibeAIChatRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIExecutePlanRequest, IVibeAIParallelRequest, IVibeAIParallelRun, IVibeAIService, IVibeAISkill, IVibeAISubagent, VibeAICustomizeKind, VibeAICustomizeScope } from '../common/vibeAI.js';
import { VibeAIClient } from '../common/vibeAIChannel.js';

/**
 * Browser layer implementation of the {@link IVibeAIService}. Proxies
 * all requests through the main process which performs the actual
 * HTTP calls against the VibeCoding backend (bypasses CORS).
 *
 * Phase 107: every request also carries the editor's opened folder
 * (`workspaceRoot`) so the backend rebinds its agent tools / RAG index
 * / rules / skills to the actual workspace (Cursor parity) — previously
 * the backend always used its own root regardless of which folder the
 * editor had open.
 */
export class VibeAIClientService extends VibeAIClient {

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService
	) {
		super(mainProcessService.getChannel('vibeAI'));
	}

	/** The first folder of the opened workspace, if any (empty window → undefined). */
	private get workspaceRoot(): string | undefined {
		const folder = this.contextService.getWorkspace().folders[0];
		return folder ? folder.uri.fsPath : undefined;
	}

	override chatStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return super.chatStream(requestId, { ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override agentStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return super.agentStream(requestId, { ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override planStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return super.planStream(requestId, { ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override executePlanStream(requestId: string, request: IVibeAIExecutePlanRequest): Promise<void> {
		return super.executePlanStream(requestId, { ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override parallelStream(requestId: string, request: IVibeAIParallelRequest): Promise<void> {
		// Phase 179: worktree isolation only makes sense against the
		// editor's opened folder — stamp it like every other agent call.
		return super.parallelStream(requestId, { ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override listParallelRuns(workspaceRoot?: string): Promise<IVibeAIParallelRun[]> {
		return super.listParallelRuns(workspaceRoot ?? this.workspaceRoot);
	}

	override mergeParallelRun(workspaceRoot: string | undefined, runId: string, index: number): Promise<{ ok: boolean; error?: string; merged?: boolean }> {
		return super.mergeParallelRun(workspaceRoot ?? this.workspaceRoot, runId, index);
	}

	override discardParallelRun(workspaceRoot: string | undefined, runId: string, index?: number): Promise<{ ok: boolean; error?: string; removed?: number }> {
		return super.discardParallelRun(workspaceRoot ?? this.workspaceRoot, runId, index);
	}

	override contextUsage(request: IVibeAIContextUsageRequest): Promise<IVibeAIContextUsage> {
		return super.contextUsage({ ...request, workspaceRoot: request.workspaceRoot ?? this.workspaceRoot });
	}

	override listSkills(): Promise<IVibeAISkill[]> {
		return super.listSkills(this.workspaceRoot);
	}

	override listSubagents(): Promise<IVibeAISubagent[]> {
		return super.listSubagents(this.workspaceRoot);
	}

	override restoreFile(path: string, content: string): Promise<boolean> {
		return super.restoreFile(path, content, this.workspaceRoot);
	}

	override deleteFile(path: string): Promise<boolean> {
		return super.deleteFile(path, this.workspaceRoot);
	}

	override customizeList(kind: VibeAICustomizeKind): Promise<IVibeAICustomizeItem[]> {
		return super.customizeList(kind, this.workspaceRoot);
	}

	override customizeCreate(kind: VibeAICustomizeKind, data: IVibeAICustomizeCreateData): Promise<IVibeAICustomizeResult> {
		return super.customizeCreate(kind, data, this.workspaceRoot);
	}

	override customizeDelete(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope): Promise<IVibeAICustomizeResult> {
		return super.customizeDelete(kind, name, scope, this.workspaceRoot);
	}

	override customizeToggle(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope): Promise<IVibeAICustomizeResult> {
		return super.customizeToggle(kind, name, scope, this.workspaceRoot);
	}

	override reloadMcp(): Promise<IVibeAICustomizeResult> {
		return super.reloadMcp(this.workspaceRoot);
	}
}

registerSingleton(IVibeAIService, VibeAIClientService, InstantiationType.Delayed);
