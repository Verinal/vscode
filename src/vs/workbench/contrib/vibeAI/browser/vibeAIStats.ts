/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Cursor-parity usage counters surfaced in the status bar ("Tab Stats",
 * "Agent Stats"). The data source is this project's own events: ghost-text
 * shows reported by the inline completion provider, Tab accepts observed via
 * command execution, and tool calls / rounds reported by the chat pane.
 */
export interface IVibeAIStats {
	readonly _serviceBrand: undefined;

	/** Fired whenever any counter changed. */
	readonly onDidChange: Event<void>;

	/** Inline completions whose ghost text was shown. */
	readonly shownCount: number;
	/** Inline completions accepted (Tab). */
	readonly acceptedCount: number;
	/** Agent tool calls started. */
	readonly toolCallCount: number;
	/** Agent rounds completed. */
	readonly roundCount: number;

	reportShown(): void;
	reportAccepted(): void;
	reportToolCall(): void;
	reportRound(): void;
}

export const IVibeAIStats = createDecorator<IVibeAIStats>('vibeAIStats');

class VibeAIStatsService implements IVibeAIStats {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _shownCount = 0;
	private _acceptedCount = 0;
	private _toolCallCount = 0;
	private _roundCount = 0;

	get shownCount(): number {
		return this._shownCount;
	}

	get acceptedCount(): number {
		return this._acceptedCount;
	}

	get toolCallCount(): number {
		return this._toolCallCount;
	}

	get roundCount(): number {
		return this._roundCount;
	}

	reportShown(): void {
		this._shownCount++;
		this._onDidChange.fire();
	}

	reportAccepted(): void {
		this._acceptedCount++;
		this._onDidChange.fire();
	}

	reportToolCall(): void {
		this._toolCallCount++;
		this._onDidChange.fire();
	}

	reportRound(): void {
		this._roundCount++;
		this._onDidChange.fire();
	}
}

registerSingleton(IVibeAIStats, VibeAIStatsService, InstantiationType.Delayed);
