/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IVibeAIService } from '../common/vibeAI.js';
import { VibeAIClient } from '../common/vibeAIChannel.js';

/**
 * Browser layer implementation of the {@link IVibeAIService}. Proxies
 * all requests through the main process which performs the actual
 * HTTP calls against the VibeCoding backend (bypasses CORS).
 */
export class VibeAIClientService extends VibeAIClient {

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel('vibeAI'));
	}
}

registerSingleton(IVibeAIService, VibeAIClientService, InstantiationType.Delayed);
