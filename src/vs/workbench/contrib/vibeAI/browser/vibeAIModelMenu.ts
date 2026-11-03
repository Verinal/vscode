/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 228: the Cursor-parity model dropdown menu, built once and shared —
 * the chat pane's input toolbar (Phase 70) and the plan doc pane header
 * populate the same shape: Auto / Optimize For (Auto-router bias) / imported
 * models / Custom model…, with ✓ on the active entries.
 *
 * The builder only assembles IAction[]; persistence and post-pick behavior
 * (focus restore, label refresh) stay with the caller via the delegate.
 */

import { Action, IAction, SubmenuAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { VibeAIModelStore } from './vibeAIModelStore.js';

export interface IModelMenuDelegate {
	/** Model registry (Settings → Models); shared storage across panes. */
	readonly modelStore: VibeAIModelStore;
	/** Current selection: 'Auto' or a model registry id / ad-hoc name. */
	readonly currentModel: string;
	/** Auto router bias: 'cost' | 'balance' | 'intelligence'. */
	readonly autoMode: string;
	setModel(model: string): void;
	setAutoMode(mode: string): void;
	/** Prompt for an ad-hoc model name; resolve undefined = cancelled. */
	inputCustomModel(current: string): Promise<string | undefined>;
}

/** Builds the model dropdown's actions with the ✓ state of the delegate's current selection. */
export function buildModelMenuActions(delegate: IModelMenuDelegate): IAction[] {
	const actions: IAction[] = [
		new Action('vibeAI.model.auto', localize('vibeAIModelMenu.auto', "Auto"), undefined, true, () => delegate.setModel('Auto')),
	];
	// Optimize For submenu (Cursor Router parity) — biases the Auto router's
	// tier choice; persisted as `vibeAI.chat.autoMode`.
	actions.push(new SubmenuAction(
		'vibeAI.model.optimizeFor',
		localize('vibeAIModelMenu.optimizeFor', "Optimize For"),
		[
			new Action('vibeAI.model.optimizeFor.cost', localize('vibeAIModelMenu.optimizeForCost', "Cost"), undefined, true, () => delegate.setAutoMode('cost')),
			new Action('vibeAI.model.optimizeFor.balance', localize('vibeAIModelMenu.optimizeForBalance', "Balance"), undefined, true, () => delegate.setAutoMode('balance')),
			new Action('vibeAI.model.optimizeFor.intelligence', localize('vibeAIModelMenu.optimizeForIntelligence', "Intelligence"), undefined, true, () => delegate.setAutoMode('intelligence')),
		]
	));
	// Imported models (Settings → Models): label = display name, id = registry id.
	// Disabled models (toggled off in settings) stay hidden here.
	for (const model of delegate.modelStore.list()) {
		if (model.disabled) {
			continue;
		}
		actions.push(new Action(`vibeAI.model.${model.id}`, model.name, undefined, true, () => delegate.setModel(model.id)));
	}
	actions.push(new Action('vibeAI.model.customPick', localize('vibeAIModelMenu.custom', "Custom model…"), undefined, true, async () => {
		try {
			const value = await delegate.inputCustomModel(delegate.currentModel);
			if (value !== undefined) {
				const trimmed = value.trim();
				delegate.setModel(trimmed.length > 0 ? trimmed : 'Auto');
			}
		} catch (err) {
			// Cancelled / unavailable input — keep the current selection.
		}
	}));
	// ✓ on the active model (checked state read live from the delegate).
	const current = delegate.currentModel;
	for (const action of actions) {
		action.checked = action.id === (current === 'Auto' ? 'vibeAI.model.auto' : `vibeAI.model.${current}`);
	}
	// The Optimize For submenu's checked state (Cursor parity: the current
	// bias shows a checkmark). The parent SubmenuAction is never checked.
	const optimizeFor = actions.find(action => action.id === 'vibeAI.model.optimizeFor') as SubmenuAction | undefined;
	if (optimizeFor) {
		for (const child of optimizeFor.actions) {
			child.checked = child.id === `vibeAI.model.optimizeFor.${delegate.autoMode}`;
		}
	}
	return actions;
}
