/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVibeAIModelProvider } from '../../../../platform/vibeAI/common/vibeAI.js';

/**
 * Message surfaced when no custom model is configured (Cursor parity:
 * no silent default fallback — the backend 400s with the same message).
 */
export const VIBE_AI_NO_MODEL_MESSAGE = '沒有模型可用：請先在 Settings → Models 匯入自定義模型';

/**
 * A provider connection configured in the settings editor's Models page
 * (Cursor-parity): first pick the connection type (OpenAI / Anthropic /
 * ...), then enter the base URL and API key. Model names are imported
 * separately ({@link IVibeAIModelConfig}) and route through one of these
 * connections.
 */
export interface IVibeAIConnectionConfig {

	readonly id: string;
	/** Connection type — one of {@link VIBE_AI_PROVIDER_PRESETS} ids. */
	readonly provider: string;
	/** OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`). */
	readonly baseUrl: string;
	/** Bearer key for the provider (absent for local servers). */
	readonly apiKey?: string;
	readonly createdAt: number;
}

/**
 * A model name imported on top of a connection (Cursor-parity: the
 * connection is configured first, then the model names to use over it).
 * Chat requests route to `modelId` via the connection's endpoint using the
 * `provider` override on the chat request.
 */
export interface IVibeAIModelConfig {

	readonly id: string;
	/** Connection this model routes through ({@link IVibeAIConnectionConfig.id}). */
	readonly connectionId: string;
	/** Display name shown in the model dropdown and settings list. */
	readonly name: string;
	/** Upstream model id sent to the provider (e.g. `deepseek-chat`). */
	readonly modelId: string;
	/**
	 * Disabled models (Cursor-parity toggle) stay in the list but are
	 * hidden from the chat's model dropdown. Undefined = enabled.
	 */
	readonly disabled?: boolean;
	/**
	 * Phase 70: tier hint for the Auto router ('fast' | 'mid' | 'strong').
	 * Undefined/'auto' = infer from the model id keywords in the backend.
	 */
	readonly tier?: string;
	readonly createdAt: number;
}

/** A known connection type with its default base URL. */
export interface IVibeAIProviderPreset {

	readonly id: string;
	readonly label: string;
	/** Default base URL filled in by the Models page (empty = user-entered). */
	readonly baseUrl: string;
	/** Whether the provider typically requires an API key. */
	readonly needsKey: boolean;
}

/**
 * Connection types offered by the Models page. All of them are routed
 * through the OpenAI-compatible `chat/completions` protocol (Anthropic
 * exposes one under `/v1`, Gemini under `/v1beta/openai`), so a preset
 * only fills the default base URL — the request shape stays the same.
 */
export const VIBE_AI_PROVIDER_PRESETS: readonly IVibeAIProviderPreset[] = [
	{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
	{ id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
	{ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
	{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
	{ id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
	{ id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
	{ id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', needsKey: false },
];

/** Display label of a connection type (falls back to the raw id). */
export function providerLabel(provider: string): string {
	return VIBE_AI_PROVIDER_PRESETS.find(preset => preset.id === provider)?.label ?? provider;
}

const CONNECTIONS_STORAGE_KEY = 'vibeAI.connections';
const MODELS_STORAGE_KEY = 'vibeAI.models';
const MAX_CONNECTIONS = 20;
const MAX_MODELS = 50;

/** Persisted model shape — current entries, plus the legacy (pre-connections) fields. */
interface IPersistedModelConfig {
	readonly id: string;
	readonly connectionId?: string;
	readonly name?: string;
	readonly modelId?: string;
	/** Legacy: the endpoint was stored inline before connections existed. */
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly createdAt?: number;
}

/**
 * Persists provider connections and imported models in global (user-scoped)
 * state so the chat pane's model dropdown and the settings editor share one
 * registry. Models reference a connection by id; {@link resolveProvider}
 * turns a model into the chat request's `provider` override.
 *
 * Note: API keys are stored in the fork's user-data storage in plaintext
 * — acceptable for this local-only fork (no login, local backend).
 */
export class VibeAIModelStore {

	constructor(
		private readonly storageService: IStorageService,
		private readonly configurationService: IConfigurationService,
	) { }

	// ==================== connections ====================

	listConnections(): IVibeAIConnectionConfig[] {
		try {
			const raw = this.storageService.get(CONNECTIONS_STORAGE_KEY, StorageScope.APPLICATION);
			const connections = raw ? JSON.parse(raw) as IVibeAIConnectionConfig[] : [];
			return Array.isArray(connections)
				? connections.filter(c => c && typeof c.id === 'string' && typeof c.baseUrl === 'string')
				: [];
		} catch {
			return [];
		}
	}

	getConnection(id: string): IVibeAIConnectionConfig | undefined {
		return this.listConnections().find(c => c.id === id);
	}

	/** Inserts or updates the connection (same id = same entry, updated in place). */
	upsertConnection(connection: IVibeAIConnectionConfig): void {
		const connections = this.listConnections().filter(c => c.id !== connection.id);
		connections.unshift(connection);
		this.writeConnections(connections.slice(0, MAX_CONNECTIONS));
	}

	/**
	 * Deletes a connection together with the models routed through it (they
	 * would be unusable). Returns the removed model configs so the caller
	 * can reset the chat's default-model selection when needed.
	 */
	deleteConnection(id: string): IVibeAIModelConfig[] {
		const removed = this.list().filter(m => m.connectionId === id);
		this.writeModels(this.list().filter(m => m.connectionId !== id));
		this.writeConnections(this.listConnections().filter(c => c.id !== id));
		return removed;
	}

	// ==================== models ====================

	list(): IVibeAIModelConfig[] {
		try {
			const raw = this.storageService.get(MODELS_STORAGE_KEY, StorageScope.APPLICATION);
			const models: IPersistedModelConfig[] = raw ? JSON.parse(raw) : [];
			if (!Array.isArray(models)) {
				return [];
			}
			// Legacy entries (pre-connections) carried the endpoint inline —
			// synthesize one connection per entry so they keep working.
			if (models.some(m => m && !m.connectionId && m.baseUrl)) {
				return this.migrateLegacyModels(models);
			}
			return models.filter(isModelConfig);
		} catch {
			return [];
		}
	}

	get(id: string): IVibeAIModelConfig | undefined {
		return this.list().find(m => m.id === id);
	}

	/** Inserts or updates the model (same id = same entry, updated in place). */
	upsert(model: IVibeAIModelConfig): void {
		const models = this.list().filter(m => m.id !== model.id);
		models.unshift(model);
		this.writeModels(models.slice(0, MAX_MODELS));
	}

	/** Toggles a model's enabled state without reordering the list. */
	setEnabled(id: string, enabled: boolean): void {
		const models = this.list().map(model => model.id === id
			? { ...model, disabled: enabled ? undefined : true }
			: model);
		this.writeModels(models);
	}

	/**
	 * Phase 70: sets a model's Auto-routing tier ('fast' | 'mid' | 'strong';
	 * 'auto'/'' = infer from the model id keywords in the backend) without
	 * reordering the list. Used by the settings editor's Models page.
	 */
	setTier(id: string, tier: string): void {
		const normalized = (tier || '').trim().toLowerCase();
		const models = this.list().map(model => model.id === id
			? { ...model, tier: normalized === 'fast' || normalized === 'mid' || normalized === 'strong' ? normalized : undefined }
			: model);
		this.writeModels(models);
	}

	/**
	 * Imports model ids discovered by scanning a connection's `/models`
	 * endpoint (Cursor-parity "scan models"). Ids already imported on this
	 * connection are kept as-is (their enabled state is preserved); new
	 * ones are appended enabled by default. Returns the number of newly
	 * imported models.
	 */
	importDiscovered(connectionId: string, modelIds: readonly string[]): number {
		if (modelIds.length === 0) {
			return 0;
		}
		const models = this.list();
		const known = new Set(models.filter(m => m.connectionId === connectionId).map(m => m.modelId));
		let added = 0;
		for (const modelId of modelIds) {
			if (known.has(modelId)) {
				continue;
			}
			known.add(modelId);
			models.push({
				id: `model-${Date.now()}-${added}`,
				connectionId,
				name: modelId,
				modelId,
				createdAt: Date.now(),
			});
			added++;
		}
		if (added > 0) {
			this.writeModels(models.slice(0, MAX_MODELS));
		}
		return added;
	}

	delete(id: string): void {
		this.writeModels(this.list().filter(m => m.id !== id));
	}

	/**
	 * Resolves the chat-request `provider` override for an imported model:
	 * its connection's endpoint plus the upstream model id. Undefined when
	 * the connection is gone (the chat pane then falls back to the plain
	 * model name against the backend's default provider).
	 */
	resolveProvider(model: IVibeAIModelConfig): IVibeAIModelProvider | undefined {
		const connection = this.getConnection(model.connectionId);
		if (!connection) {
			return undefined;
		}
		return {
			name: model.name,
			baseUrl: connection.baseUrl,
			apiKey: connection.apiKey,
			model: model.modelId,
		};
	}

	/**
	 * Resolves the model provider the non-chat surfaces (Tab completion,
	 * Ctrl+K inline edit) should use: the chat pane's `vibeAI.chat.model`
	 * selection — Auto picks the first non-disabled pool model, a named
	 * selection resolves through its connection. Undefined when no usable
	 * model is configured (the caller skips / surfaces 沒有模型可用) —
	 * no default-model fallback.
	 */
	resolveEditorModelProvider(): IVibeAIModelProvider | undefined {
		const selection = (this.configurationService.getValue<string>('vibeAI.chat.model') || '').trim();
		if (selection && selection !== 'Auto') {
			const configured = this.get(selection) ?? this.list().find(m => m.name === selection);
			return configured ? this.resolveProvider(configured) : undefined;
		}
		for (const model of this.list()) {
			if (model.disabled) {
				continue;
			}
			const provider = this.resolveProvider(model);
			if (provider) {
				return provider;
			}
		}
		return undefined;
	}

	// ==================== storage + legacy migration ====================

	private migrateLegacyModels(models: IPersistedModelConfig[]): IVibeAIModelConfig[] {
		const connections = this.listConnections();
		const migrated: IVibeAIModelConfig[] = [];
		for (const model of models) {
			if (isModelConfig(model)) {
				migrated.push(model);
				continue;
			}
			if (!model?.modelId || !model.baseUrl) {
				continue; // unusable entry — drop it
			}
			const connection: IVibeAIConnectionConfig = {
				id: `conn-${model.id}`,
				provider: 'custom',
				baseUrl: model.baseUrl,
				apiKey: model.apiKey,
				createdAt: model.createdAt ?? Date.now(),
			};
			if (!connections.some(c => c.id === connection.id)) {
				connections.unshift(connection);
			}
			migrated.push({
				id: model.id,
				connectionId: connection.id,
				name: model.name ?? model.modelId,
				modelId: model.modelId,
				createdAt: model.createdAt ?? Date.now(),
			});
		}
		this.writeConnections(connections.slice(0, MAX_CONNECTIONS));
		this.writeModels(migrated.slice(0, MAX_MODELS));
		return migrated;
	}

	private writeConnections(connections: IVibeAIConnectionConfig[]): void {
		try {
			this.storageService.store(
				CONNECTIONS_STORAGE_KEY,
				JSON.stringify(connections),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
		} catch {
			// Persistence is best-effort — never break the settings on storage errors.
		}
	}

	private writeModels(models: IVibeAIModelConfig[]): void {
		try {
			this.storageService.store(
				MODELS_STORAGE_KEY,
				JSON.stringify(models),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
		} catch {
			// Persistence is best-effort — never break the settings on storage errors.
		}
	}
}

/** Type guard for a persisted (post-migration) model config. */
function isModelConfig(model: IPersistedModelConfig | undefined): model is IVibeAIModelConfig {
	return !!model
		&& typeof model.id === 'string'
		&& typeof model.connectionId === 'string'
		&& typeof model.name === 'string'
		&& typeof model.modelId === 'string';
}