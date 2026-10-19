/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IVibeAIChatRequest, IVibeAICompletionRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIExecutePlanRequest, IVibeAIInlineEditRequest, IVibeAIModelProvider, IVibeAIService, IVibeAISkill, IVibeAIStreamData } from './vibeAI.js';

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
				const { path, content } = arg as { path: string; content: string };
				return this.service.restoreFile(path, content);
			}
			case 'deleteFile': {
				const { path } = arg as { path: string };
				return this.service.deleteFile(path);
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
				return this.service.listSkills();
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

	restoreFile(path: string, content: string): Promise<boolean> {
		return this.channel.call<boolean>('restoreFile', { path, content });
	}

	deleteFile(path: string): Promise<boolean> {
		return this.channel.call<boolean>('deleteFile', { path });
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

	listSkills(): Promise<IVibeAISkill[]> {
		return this.channel.call<IVibeAISkill[]>('listSkills');
	}
}

