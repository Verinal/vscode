/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatOutputRendererService } from '../../chat/browser/chatOutputItemRenderer.js';

const $ = DOM.$;

/**
 * Code block languages routed to the built-in mermaid chat output renderer
 * (the `mermaid-markdown-features` extension contributes the
 * `chatOutputRenderers` extension point with `codeBlockLanguageIdentifiers`).
 */
const MERMAID_LANGUAGE_IDS = new Set(['mermaid', 'mmd']);

/**
 * Spinner rotation cadence: 12° per 50ms tick replicates the codicon spin
 * animation (steps(30) over 1.5s). The rotation is timer-driven instead of
 * CSS (see startSpinnerRotation).
 */
const MERMAID_SPINNER_TICK_MS = 50;
const MERMAID_SPINNER_STEP_DEG = 12;
/** Consecutive disconnected ticks (~300ms) before the rotation timer stops. */
const MERMAID_SPINNER_DISCONNECT_TICKS = 6;

/**
 * Command the built-in mermaid extension contributes for the pop-out editor
 * tab (zoom / pan / copy / theme tracking included). Contributed commands
 * auto-activate on executeCommand, so the pop-out needs no extra activation
 * code.
 */
export const MERMAID_OPEN_IN_EDITOR_COMMAND = '_mermaid-markdown.openInEditor';

/** Whether the fence language routes to the mermaid diagram renderer. */
export function isMermaidCodeBlock(languageId: string | undefined): boolean {
	return !!languageId && MERMAID_LANGUAGE_IDS.has(languageId.toLowerCase());
}

/**
 * The chat output renderer API requires a chat session resource (it wires
 * mouse-wheel scrolling to the owning chat widget). The vibeAI chat pane
 * has no upstream chat session — a synthetic stable URI is passed instead;
 * the widget lookup for it never matches, so the delegation no-ops.
 */
const MERMAID_SESSION_RESOURCE = URI.parse('vibeai:mermaid-block');

/**
 * One pending mermaid block of a markdown render pass — the wrapper element
 * the markdown renderer swaps into the code block placeholder slot, and the
 * flush that creates the webview part once the block reached its final DOM
 * position.
 */
export interface IPendingMermaidPart {
	readonly element: HTMLElement;
	/**
	 * Phase 85 streaming reuse: replaces the block's source (the header's
	 * copy and pop-out handlers read the current one). The element — and
	 * its spinner — is kept, so the spinner is not rebuilt (and its
	 * timer-driven rotation is not restarted) by every throttled re-render
	 * of the streaming pass.
	 */
	updateSource(source: string): void;
	/**
	 * Creates the webview part. Returns whether the mount happened —
	 * `false` when the holder is not in the document (its render is still
	 * swapping placeholders, or a newer render pass replaced it); the
	 * caller retains the part and retries at the next flush instead of
	 * dropping it (a dropped part keeps its placeholder forever).
	 */
	flush(disposables: DisposableStore): boolean;
}

/**
 * Phase 83: inline mermaid diagram rendering in the vibeAI chat pane
 * (Cursor parity). ```mermaid fences route to the built-in chat output
 * renderer (`IChatOutputRendererService.renderCodeBlock`) — the
 * `mermaid-markdown-features` extension renders each block in its own
 * webview (mermaid, pan/zoom, theme tracking and the context-menu
 * open-in-editor / copy actions included).
 *
 * This class builds the block shell (header + webview holder) and defers
 * the webview creation until the block's flush runs: webviews are iframes,
 * and moving a mounted iframe in the DOM reloads it. While the answer
 * streams the block stays a placeholder row (a per-delta webview would
 * thrash); the webview mounts when the run closes / the turn finishes
 * (Phase 84, guaranteed) or on history restore — never per delta.
 */
export class VibeAIMermaidRenderer extends Disposable {

	constructor(
		@IChatOutputRendererService private readonly chatOutputRendererService: IChatOutputRendererService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Builds a mermaid block shell for the markdown render pass, or
	 * undefined when the language is not a mermaid fence or the built-in
	 * mermaid extension (chat output renderer contribution) is absent — the
	 * caller falls back to the regular code block renderer.
	 *
	 * While the answer streams the block shows a placeholder row (a
	 * per-delta webview would thrash); the webview mounts on the block's
	 * flush from either path — the stream-state registry (flushed at run
	 * close / turn finish) or the render pass's asyncRenderCallback (final
	 * render / history restore). Whichever runs first wins.
	 */
	/**
	 * Whether the language routes to the mermaid webview renderer. The
	 * pane checks it before its streaming reuse logic so the fence-order
	 * counter there only advances for mermaid fences.
	 */
	canRender(languageId: string): boolean {
		return isMermaidCodeBlock(languageId) && this.chatOutputRendererService.hasCodeBlockRenderer(languageId);
	}

	/**
	 * Creates the mermaid block, waiting for the renderer extension when it
	 * is not registered yet. A render that races extension activation — a
	 * history restore can run before the `chatOutputRenderers` extension
	 * point handler processed the contributions — used to see
	 * `hasCodeBlockRenderer` false and silently degrade the fence to a
	 * plain code block (after an editor restart only the diagram's source
	 * showed). The markdown renderer accepts async code block renderers, so
	 * the wait only delays that block's placeholder swap; the streaming
	 * path (the renderer is registered long before the first delta) hits
	 * the `canRender` shortcut and resolves immediately.
	 */
	async createMermaidBlockWhenReady(languageId: string, source: string, streaming: boolean): Promise<IPendingMermaidPart | undefined> {
		if (!isMermaidCodeBlock(languageId)) {
			return undefined;
		}
		if (this.canRender(languageId)) {
			return this.createMermaidBlock(languageId, source, streaming);
		}
		this.logService.info(`[vibeAI mermaid] renderer for '${languageId}' not registered yet — waiting for extension activation`);
		const ready = await this.chatOutputRendererService.whenCodeBlockRendererReady(languageId);
		return ready ? this.createMermaidBlock(languageId, source, streaming) : undefined;
	}

	createMermaidBlock(languageId: string, source: string, streaming: boolean): IPendingMermaidPart | undefined {
		if (!this.canRender(languageId)) {
			return undefined;
		}
		// The header's copy/pop-out handlers read the CURRENT source —
		// streaming reuse updates it per render (updateSource below).
		let currentSource = source;
		const element = $('div.vibe-ai-chat-mermaid');
		element.appendChild(this.createBlockHeader(() => currentSource));
		const holder = $('div.vibe-ai-mermaid-holder');
		element.appendChild(holder);

		if (streaming) {
			const pending = $('div.vibe-ai-mermaid-pending');
			// No `codicon-modifier-spin`: the CSS animation restarts on every
			// detach/reattach cycle of the streaming re-renders (see
			// startSpinnerRotation) — the rotation is timer-driven instead.
			const spinner = $('span.codicon.codicon-loading');
			spinner.setAttribute('aria-hidden', 'true');
			pending.appendChild(spinner);
			holder.appendChild(pending);
			this.startSpinnerRotation(spinner);
		}

		// Phase 84: one webview mount per block — the first flush wins,
		// later flushes skip (the flag). A holder that is not in the
		// document (its render is still swapping placeholders, or a newer
		// render pass replaced it) reports false so the caller RETAINS the
		// part and retries at the next flush — a dropped part keeps its
		// placeholder/spinner forever.
		let mounted = false;
		return {
			element,
			updateSource: updated => {
				currentSource = updated;
			},
			flush: disposables => {
				if (mounted) {
					return true;
				}
				if (!holder.isConnected) {
					// Info level: these probes must show up at the default
					// log level to diagnose a blank diagram.
					this.logService.info('[vibeAI mermaid] mount deferred: holder not connected yet');
					return false;
				}
				mounted = true;
				this.logService.info('[vibeAI mermaid] mounting diagram webview');
				void this.renderDiagramWebview(holder, currentSource, disposables);
				return true;
			},
		};
	}

	/**
	 * Drives the streaming spinner with a timer instead of the codicon CSS
	 * animation. Every throttled re-render of the streaming pass detaches
	 * the reused block (the markdown renderer clears the body, reads its
	 * scroll metrics, then swaps the placeholders back in a microtask) —
	 * Chromium restarts CSS animations on a detach/reattach cycle, so the
	 * CSS-animated spinner visibly restarted ~8x/s while the answer
	 * streamed. The element object survives the cycle and the timer keeps
	 * advancing its transform, so the rotation continues from the current
	 * angle.
	 *
	 * The timer stops on its own once the spinner has been out of the
	 * document for a few consecutive ticks: the webview render at mount
	 * clears the placeholder row, and a dropped block (turn teardown, Clear
	 * Chat) leaves it detached. The streaming detach/reattach cycles never
	 * reach the guard — the placeholder swap runs in a microtask, before
	 * this macrotask.
	 */
	private startSpinnerRotation(spinner: HTMLElement): void {
		const domWindow = DOM.getWindow(spinner);
		let angle = 0;
		let disconnectedTicks = 0;
		const timer = domWindow.setInterval(() => {
			if (!spinner.isConnected) {
				disconnectedTicks++;
				if (disconnectedTicks >= MERMAID_SPINNER_DISCONNECT_TICKS) {
					domWindow.clearInterval(timer);
				}
				return;
			}
			disconnectedTicks = 0;
			angle = (angle + MERMAID_SPINNER_STEP_DEG) % 360;
			spinner.style.transform = `rotate(${angle}deg)`;
		}, MERMAID_SPINNER_TICK_MS);
	}

	private async renderDiagramWebview(holder: HTMLElement, source: string, disposables: DisposableStore): Promise<void> {
		DOM.clearNode(holder);
		try {
			const part = await this.chatOutputRendererService.renderCodeBlock(
				'mermaid',
				new TextEncoder().encode(source),
				holder,
				{
					title: localize('vibeAIChat.mermaidTitle', "Mermaid diagram"),
					chatSessionResource: MERMAID_SESSION_RESOURCE,
				},
				CancellationToken.None,
			);
			// Detached while the renderer was activating / rendering (Clear
			// Chat, tab close) — dispose the webview instead of leaking the
			// iframe.
			if (!holder.isConnected) {
				part.dispose();
				return;
			}
			// Diagnostics (Info level — visible without raising the log
			// level): whether the webview mounted its iframe, and how its
			// reported height evolves. A created webview with no height
			// events means the failure is inside the webview content
			// (blank body / zero height), not the mount chain.
			this.logService.info(`[vibeAI mermaid] diagram webview created, iframe in holder: ${!!holder.querySelector('iframe')}`);
			disposables.add(part.onDidChangeHeight(height => {
				this.logService.info(`[vibeAI mermaid] diagram webview height: ${height}`);
			}));
			disposables.add(part);
		} catch (error) {
			this.logService.warn('vibeAI chat: mermaid block render failed', error);
			if (holder.isConnected) {
				DOM.clearNode(holder);
				const errorBox = $('div.vibe-ai-mermaid-error');
				const icon = $('span.codicon.codicon-error');
				icon.setAttribute('aria-hidden', 'true');
				const label = $('span');
				label.textContent = localize('vibeAIChat.mermaidError', "Failed to render the mermaid diagram — use the copy button above for the source.");
				errorBox.append(icon, label);
				holder.appendChild(errorBox);
			}
		}
	}

	/**
	 * The block header: mermaid label + the pop-out button (opens the
	 * built-in mermaid editor tab) + a hover-revealed source copy button.
	 * Reuses the code block header classes so the chat's CSS styles both.
	 */
	private createBlockHeader(getSource: () => string): HTMLElement {
		const header = $('div.vibe-ai-code-block-header');
		header.style.userSelect = 'none';

		const titleGroup = $('span.vibe-ai-code-block-title-group');
		const graphIcon = $('span.codicon.codicon-graph');
		graphIcon.setAttribute('aria-hidden', 'true');
		const title = $('span.vibe-ai-code-block-title');
		title.textContent = localize('vibeAIChat.mermaidTitle', "Mermaid diagram");
		titleGroup.append(graphIcon, title);

		const expandButton = $('button.vibe-ai-code-block-copy.vibe-ai-mermaid-expand') as HTMLButtonElement;
		expandButton.type = 'button';
		expandButton.title = localize('vibeAIChat.mermaidOpenInEditor', "Open diagram in editor");
		expandButton.setAttribute('aria-label', expandButton.title);
		const expandIcon = $('span.codicon.codicon-link-external');
		expandIcon.setAttribute('aria-hidden', 'true');
		expandButton.appendChild(expandIcon);
		expandButton.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.commandService.executeCommand(MERMAID_OPEN_IN_EDITOR_COMMAND, {
				mermaidSource: getSource(),
				title: localize('vibeAIChat.mermaidTitle', "Mermaid diagram"),
			}).catch(error => {
				this.logService.warn('vibeAI chat: failed to open the mermaid editor tab', error);
			});
		});

		const copyButton = $('button.vibe-ai-code-block-copy') as HTMLButtonElement;
		copyButton.type = 'button';
		copyButton.title = localize('copyCodeBlock', "Copy");
		copyButton.setAttribute('aria-label', localize('copyCodeBlock', "Copy"));
		const copyIcon = $('span.codicon.codicon-copy');
		copyIcon.setAttribute('aria-hidden', 'true');
		copyButton.appendChild(copyIcon);
		let copiedResetTimer: number | undefined;
		copyButton.addEventListener('click', async event => {
			event.preventDefault();
			event.stopPropagation();
			const source = getSource();
			if (!source) {
				return;
			}
			try {
				await this.clipboardService.writeText(source);
			} catch {
				return;
			}
			// Brief check-mark feedback, like the built-in copy buttons.
			copyIcon.className = 'codicon codicon-check';
			copyButton.classList.add('copied');
			const blockWindow = DOM.getWindow(copyButton);
			if (copiedResetTimer !== undefined) {
				blockWindow.clearTimeout(copiedResetTimer);
			}
			copiedResetTimer = blockWindow.setTimeout(() => {
				copiedResetTimer = undefined;
				copyIcon.className = 'codicon codicon-copy';
				copyButton.classList.remove('copied');
			}, 1600);
		});

		header.append(titleGroup, expandButton, copyButton);
		return header;
	}
}