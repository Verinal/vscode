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
	 * copy and zoom-popup handlers read the current one). The element — and
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
 * copy/reset actions included). The header's zoom button opens the
 * large-diagram popup instead of the old editor tab.
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
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** The currently open zoom popup (one at a time), or undefined. */
	private activeZoomModalDisposables: DisposableStore | undefined;

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
		// The header's copy/zoom-popup handlers read the CURRENT source —
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

	private async renderDiagramWebview(holder: HTMLElement, source: string, disposables: DisposableStore, options?: { readonly interactiveCanvas?: boolean }): Promise<void> {
		DOM.clearNode(holder);
		try {
			const part = await this.chatOutputRendererService.renderCodeBlock(
				'mermaid',
				new TextEncoder().encode(source),
				holder,
				{
					title: localize('vibeAIChat.mermaidTitle', "Mermaid diagram"),
					chatSessionResource: MERMAID_SESSION_RESOURCE,
					// The popup renders as a fixed interactive canvas: the webview
					// fills the modal body (no content-driven height) and the page
					// enables pan/zoom (fitted view, plain drag, clamped wheel).
					interactiveCanvas: options?.interactiveCanvas,
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
	 * The block header: mermaid label + the zoom button (opens the
	 * large-diagram popup) + a hover-revealed source copy button.
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
		expandButton.title = localize('vibeAIChat.mermaidViewLarger', "View larger");
		expandButton.setAttribute('aria-label', expandButton.title);
		const expandIcon = $('span.codicon.codicon-screen-full');
		expandIcon.setAttribute('aria-hidden', 'true');
		expandButton.appendChild(expandIcon);
		expandButton.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.openZoomModal(getSource, expandButton);
		});

		header.append(titleGroup, expandButton, this.createCopyButton(getSource));
		return header;
	}

	/**
	 * The source copy button (block header + zoom popup titlebar): writes
	 * the current source and flashes a check mark, like the built-in copy
	 * buttons.
	 */
	private createCopyButton(getSource: () => string): HTMLButtonElement {
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
		return copyButton;
	}

	/**
	 * The zoom popup: a workbench-level overlay hosting a second diagram
	 * webview with the same source at full size. The inline card keeps its
	 * bounded height; the popup shows the whole diagram: the webview renders as an
	 * interactive canvas on a gray background (fitted view, ctrl+wheel
	 * zoom, drag pan).
	 *
	 * Appended to the workbench root so the theme variables cascade (they
	 * are scoped to `.monaco-workbench`; a body-level child would not
	 * inherit them), with a z-index below the context-view layer so
	 * right-click menus still open above the popup. One popup at a time:
	 * opening again closes the previous one first.
	 */
	private openZoomModal(getSource: () => string, anchor: HTMLElement): void {
		const source = getSource();
		if (!source) {
			return;
		}
		this.closeZoomModal();
		const disposables = new DisposableStore();
		this.activeZoomModalDisposables = disposables;

		const domWindow = DOM.getWindow(anchor);
		const container = domWindow.document.querySelector('.monaco-workbench') ?? domWindow.document.body;

		const backdrop = $('div.vibe-ai-mermaid-modal-backdrop');
		const modal = $('div.vibe-ai-mermaid-modal');
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-label', localize('vibeAIChat.mermaidTitle', "Mermaid diagram"));

		const titlebar = $('div.vibe-ai-mermaid-modal-titlebar');
		const graphIcon = $('span.codicon.codicon-graph');
		graphIcon.setAttribute('aria-hidden', 'true');
		const title = $('span.vibe-ai-mermaid-modal-title');
		title.textContent = localize('vibeAIChat.mermaidTitle', "Mermaid diagram");
		const copyButton = this.createCopyButton(getSource);
		const closeButton = $('button.vibe-ai-mermaid-modal-close') as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.title = localize('vibeAIChat.mermaidModalClose', "Close");
		closeButton.setAttribute('aria-label', localize('vibeAIChat.mermaidModalClose', "Close"));
		const closeIcon = $('span.codicon.codicon-close');
		closeIcon.setAttribute('aria-hidden', 'true');
		closeButton.appendChild(closeIcon);
		titlebar.append(graphIcon, title, copyButton, closeButton);

		const body = $('div.vibe-ai-mermaid-modal-body');
		const holder = $('div.vibe-ai-mermaid-modal-holder');
		body.appendChild(holder);
		modal.append(titlebar, body);
		backdrop.appendChild(modal);
		container.appendChild(backdrop);

		const close = () => {
			if (this.activeZoomModalDisposables === disposables) {
				this.activeZoomModalDisposables = undefined;
			}
			disposables.dispose();
		};
		// Disposes last (LIFO): the backdrop leaves the DOM only after the
		// listeners and the webview part are gone.
		disposables.add({ dispose: () => backdrop.remove() });
		disposables.add(DOM.addDisposableListener(closeButton, DOM.EventType.CLICK, () => close()));
		disposables.add(DOM.addDisposableListener(backdrop, DOM.EventType.CLICK, event => {
			// Clicks on the dialog itself must not close the popup.
			if (event.target === backdrop) {
				close();
			}
		}));
		disposables.add(DOM.addDisposableListener(domWindow.document, DOM.EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				close();
			}
		}));

		// The holder must be in the document before the webview mounts
		// (iframes reload when moved) - the backdrop is already appended.
		void this.renderDiagramWebview(holder, source, disposables, { interactiveCanvas: true });
	}

	private closeZoomModal(): void {
		this.activeZoomModalDisposables?.dispose();
		this.activeZoomModalDisposables = undefined;
	}

	override dispose(): void {
		this.closeZoomModal();
		super.dispose();
	}
}