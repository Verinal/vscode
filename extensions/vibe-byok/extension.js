/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Vibe BYOK — registers the VibeCoding backend's LLM models as BYOK
 * language models (`vscode.lm.registerLanguageModelChatProvider`) so the
 * chat view, the agent host's BYOK bridge, and extensions can use them.
 *
 * The provider talks OpenAI `chat/completions` (SSE streaming) against the
 * VibeCoding backend's `/v1` endpoints, which forward to the configured
 * LLM service. The backend URL comes from `VIBE_BACKEND_URL`, falling back
 * to the local dev default.
 */
const vscode = require('vscode');

const VENDOR = 'vibe';
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000';
/** Rough chars-per-token for the token count estimate. */
const CHARS_PER_TOKEN = 4;

const ROLE = vscode.LanguageModelChatMessageRole;

function backendUrl() {
	return (process.env['VIBE_BACKEND_URL'] || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
}

/**
 * Model ids come from the backend and may contain `/` (e.g. `org/model`),
 * which collides with the LM identifier scheme `vendor[/group]/id`. Sanitize
 * them for the LM surface and keep a reverse map for the request bodies.
 */
const upstreamModelIds = new Map();

function toLmModelId(upstreamId) {
	const lmId = String(upstreamId).replace(/\//g, '--');
	upstreamModelIds.set(lmId, String(upstreamId));
	return lmId;
}

function toUpstreamModelId(lmId) {
	return upstreamModelIds.get(lmId) ?? lmId;
}

function modelInfoToChatInformation(model) {
	const lmId = toLmModelId(model.id);
	const contextWindow = typeof model.max_model_len === 'number' ? model.max_model_len : 131072;
	return {
		id: lmId,
		name: model.id,
		family: 'vibe',
		version: String(model.version ?? '1.0.0'),
		tooltip: `LLM via the VibeCoding backend (${backendUrl()})`,
		detail: 'VibeCoding backend',
		maxInputTokens: Math.max(1024, Math.floor(contextWindow * 0.75)),
		maxOutputTokens: Math.max(1024, Math.floor(contextWindow * 0.25)),
		maxContextWindowTokens: contextWindow,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: true,
			imageInput: false,
		},
	};
}

function fallbackChatInformation() {
	return modelInfoToChatInformation({ id: 'default', version: '1.0.0' });
}

async function fetchModelInfos() {
	try {
		const response = await fetch(`${backendUrl()}/v1/models`, {
			headers: { 'Accept': 'application/json' },
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const models = Array.isArray(data?.data) ? data.data : [];
		return models.length ? models : null;
	} catch (err) {
		console.error(`[vibe-byok] failed to fetch models from ${backendUrl()}/v1/models: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/**
 * Converts VS Code LM request messages to OpenAI chat `messages`.
 *
 * Handles the shapes the agent host's BYOK bridge produces: text parts,
 * assistant tool calls, and tool results. Unknown/binary parts are skipped.
 */
function toOpenAiMessages(messages) {
	const out = [];
	for (const message of messages) {
		const role = message.role === ROLE.System
			? 'system'
			: message.role === ROLE.Assistant
				? 'assistant'
				: 'user';

		const texts = [];
		const toolCalls = [];
		const toolResults = [];

		for (const part of (message.content ?? [])) {
			if (typeof part === 'string') {
				texts.push(part);
			} else if (part instanceof vscode.LanguageModelTextPart) {
				texts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const args = typeof part.parameters === 'string'
					? part.parameters
					: JSON.stringify(part.parameters ?? {});
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: args },
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					callId: part.callId,
					content: (part.content ?? [])
						.map(item => (typeof item === 'string'
							? item
							: item instanceof vscode.LanguageModelTextPart ? item.value : ''))
						.join(''),
				});
			}
			// LanguageModelDataPart and other unknown parts are skipped.
		}

		if (role === 'assistant' && toolCalls.length > 0) {
			out.push({
				role: 'assistant',
				content: texts.join('') || null,
				tool_calls: toolCalls,
			});
			for (const result of toolResults) {
				out.push({ role: 'tool', tool_call_id: result.callId, content: result.content });
			}
			continue;
		}

		if (toolResults.length > 0) {
			for (const result of toolResults) {
				out.push({ role: 'tool', tool_call_id: result.callId, content: result.content });
			}
		}

		const text = texts.join('');
		if (text) {
			out.push({ role, content: text });
		}
	}
	return out;
}

class VibeByokProvider {

	constructor() {
		this._onDidChangeLanguageModelChatInformation = new vscode.EventEmitter();
		this.onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;
	}

	provideLanguageModelChatInformation(_options, _token) {
		return (async () => {
			const models = await fetchModelInfos();
			return models ? models.map(modelInfoToChatInformation) : [fallbackChatInformation()];
		})();
	}

	async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
		const body = {
			model: toUpstreamModelId(model.id),
			messages: toOpenAiMessages(messages),
			stream: true,
		};

		const response = await fetch(`${backendUrl()}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			},
		});

		if (!response.ok || !response.body) {
			const detail = response.body ? await response.text().catch(() => '') : '';
			throw new Error(`Vibe backend request failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
		}

		// Aggregate streamed tool calls; OpenAI sends them as index-keyed deltas.
		const toolCalls = new Map();
		let usageEmitted = false;

		const handleChunk = (chunk) => {
			if (chunk?.error) {
				throw new Error(chunk.error.message || 'Vibe backend stream error');
			}
			const delta = chunk?.choices?.[0]?.delta;
			if (delta) {
				if (typeof delta.content === 'string' && delta.content.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(delta.content));
				}
				// LLM thinking models stream reasoning in a non-standard
				// `delta.reasoning` field — surface it as thinking parts.
				if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
					progress.report(new vscode.LanguageModelThinkingPart(delta.reasoning));
				}
				if (Array.isArray(delta.tool_calls)) {
					for (const call of delta.tool_calls) {
						const index = typeof call.index === 'number' ? call.index : 0;
						const entry = toolCalls.get(index) ?? { id: undefined, name: undefined, arguments: '' };
						if (call.id) {
							entry.id = call.id;
						}
						if (call.function?.name) {
							entry.name = call.function.name;
						}
						if (typeof call.function?.arguments === 'string') {
							entry.arguments += call.function.arguments;
						}
						toolCalls.set(index, entry);
					}
				}
			}
			if (chunk?.usage && !usageEmitted) {
				usageEmitted = true;
				try {
					progress.report(vscode.LanguageModelDataPart.json({
						prompt_tokens: chunk.usage.prompt_tokens ?? 0,
						completion_tokens: chunk.usage.completion_tokens ?? 0,
					}, 'usage'));
				} catch {
					// usage reporting is best-effort
				}
			}
		};

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			if (token.isCancellationRequested) {
				try {
					await reader.cancel();
				} catch { /* ignore */ }
				return;
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let separator;
			while ((separator = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, separator).replace(/\r$/, '');
				buffer = buffer.slice(separator + 1);
				if (!line.startsWith('data: ')) {
					continue;
				}
				const data = line.slice(6).trim();
				if (data === '[DONE]') {
					continue;
				}
				try {
					handleChunk(JSON.parse(data));
				} catch (err) {
					if (err instanceof Error && err.message && !err.message.startsWith('Unexpected token')) {
						throw err; // backend error payloads are real failures
					}
					console.error(`[vibe-byok] failed to parse SSE chunk: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// Emit completed tool calls after the stream ends (arguments are complete).
		const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
		let callIndex = 0;
		for (const [, call] of ordered) {
			const callId = call.id ?? `vibe_byok_call_${callIndex++}`;
			if (!call.name) {
				continue;
			}
			let parameters = {};
			try {
				parameters = JSON.parse(call.arguments || '{}');
			} catch {
				parameters = { input: call.arguments ?? '' };
			}
			progress.report(new vscode.LanguageModelToolCallPart(callId, call.name, parameters));
		}
	}

	async provideTokenCount(_model, text, _token) {
		const value = typeof text === 'string'
			? text
			: JSON.stringify(text?.content ?? text ?? '');
		return Math.ceil(value.length / CHARS_PER_TOKEN);
	}
}

function activate(context) {
	const provider = new VibeByokProvider();
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
	// The LM service resolves models lazily — nudge it now that the provider
	// is registered so the LLM models appear without user interaction.
	provider._onDidChangeLanguageModelChatInformation.fire();
	context.subscriptions.push(provider._onDidChangeLanguageModelChatInformation);
	console.log(`[vibe-byok] registered BYOK language model provider (vendor '${VENDOR}', backend ${backendUrl()})`);
}

function deactivate() { }

module.exports = { activate, deactivate };