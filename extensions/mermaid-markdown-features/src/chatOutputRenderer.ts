/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { MermaidEditorManager } from './editorManager';
import { MermaidCommandContext, MermaidWebviewManager } from './webviewManager';
import { escapeHtmlText } from './util/html';
import { generateUuid } from './util/uuid';
import { disposeAll } from './util/dispose';
import { renderMermaidConfigSpan } from './markdownMermaid/config';

/**
 * Mime type used to identify Mermaid diagram data in chat output.
 */
const mime = 'text/vnd.mermaid';

/**
 * View type that uniquely identifies the Mermaid chat output renderer.
 */
const viewType = 'vscode.mermaid-markdown-features.chatOutputItem';

class MermaidChatOutputRenderer implements vscode.ChatOutputRenderer {

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _webviewManager: MermaidWebviewManager
	) { }

	async renderChatOutput({ value }: vscode.ChatOutputDataItem, chatOutputWebview: vscode.ChatOutputWebview, ctx: vscode.ChatOutputRenderContext, _token: vscode.CancellationToken): Promise<void> {
		const webview = chatOutputWebview.webview;
		// Full-size popups render as interactive canvases: the page fills the
		// viewport, paints a canvas background, and enables pan/zoom (plain
		// drag pans, ctrl+wheel zooms with a clamped step).
		const interactiveCanvas = ctx.interactiveCanvas === true;
		const decoded = decodeMermaidData(value);
		const mermaidSource = decoded.source;
		const title = decoded.title;

		// Generate unique ID for this webview
		const webviewId = generateUuid();

		// Diagnostic: proves the renderer was invoked at all — its absence
		// means the extension never activated or the data output never arrived.
		console.info(`[mermaid-markdown-features] chat diagram renderer invoked (id ${webviewId})`);

		const disposables: vscode.Disposable[] = [];

		// Set once the page reports ready or an error; the watchdog below uses
		// it to tell "scripts never ran" apart from a slow render.
		let webviewSignalled = false;

		// Register and set as active
		disposables.push(this._webviewManager.registerWebview(webviewId, webview, mermaidSource, title, 'chat'));

		// Listen for messages from the webview
		disposables.push(webview.onDidReceiveMessage(message => {
			if (message.type === 'webviewReady') {
				webviewSignalled = true;
			} else if (message.type === 'webviewError') {
				webviewSignalled = true;
				// The page's failsafe bootstrap / renderer module surfaced a
				// load or runtime failure — log it where the Extension Host
				// output channel shows it.
				console.error(`[mermaid-markdown-features] chat diagram webview failed: ${message.message}`);
			}
		}));

		// Dispose resources when webview is disposed
		chatOutputWebview.onDidDispose(() => {
			disposeAll(disposables);
		});

		// Set the options for the webview
		const mediaRoot = vscode.Uri.joinPath(this._extensionUri, 'chat-webview-out');
		webview.options = {
			enableScripts: true,
			localResourceRoots: [mediaRoot],
		};

		// Set the HTML content for the webview
		const nonce = generateUuid();
		const mermaidScript = vscode.Uri.joinPath(mediaRoot, 'index.js');
		const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'));

		webview.html = `
			<!DOCTYPE html>
			<html lang="en"${interactiveCanvas ? ' style="height: 100%;"' : ''}>

			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Mermaid Diagram</title>
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:;" />
				<link rel="stylesheet" type="text/css" href="${codiconsUri}">

				<style>
					body {
						padding: 0;
					}
					body[data-interactive-canvas="true"] {
						width: 100%;
						height: 100%;
						margin: 0;
						overflow: hidden;
						background: var(--vscode-editorWidget-background, #252526);
						background: color-mix(in srgb, var(--vscode-foreground) 8%, var(--vscode-editor-background));
					}
					.mermaid {
						visibility: hidden;
					}
					.mermaid.rendered {
						visibility: visible;
					}
					.mermaid-failsafe-error {
						margin: 0 0 6px;
						padding: 6px 10px;
						font-family: var(--vscode-editor-font-family, monospace);
						font-size: 12px;
						color: var(--vscode-errorForeground, #f66);
						white-space: pre-wrap;
						word-break: break-all;
					}
				</style>

				<script nonce="${nonce}">
					// Failsafe: the renderer module only reveals the diagram once mermaid
					// has rendered it — any load/runtime failure below that point used to
					// leave an invisible, empty-looking diagram with no error at all.
					// Surface every failure instead. The capture phase also catches
					// module/resource load failures, whose error events do not bubble.
					(function () {
						var shown = false;
						var reveal = function (kind, message) {
							if (shown) { return; }
							shown = true;
							try {
								var pre = document.querySelector('.mermaid');
								if (pre) { pre.style.visibility = 'visible'; }
								var note = document.createElement('div');
								note.className = 'mermaid-failsafe-error';
								note.textContent = 'Mermaid webview ' + kind + ': ' + message;
								if (pre && pre.parentNode) { pre.parentNode.insertBefore(note, pre); }
								else if (document.body) { document.body.appendChild(note); }
							} catch (e) { /* nothing more we can do */ }
						};
						window.__showMermaidError = reveal;
						window.addEventListener('error', function (event) {
							var target = event && event.target;
							if (target && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
								reveal('resource load failed', target.getAttribute('src') || target.getAttribute('href') || 'unknown resource');
								return;
							}
							reveal('script error', (event && event.message) || 'unknown error');
						}, true);
						window.addEventListener('unhandledrejection', function (event) {
							reveal('unhandled rejection', String((event && event.reason) || 'unknown rejection'));
						});
					})();
				</script>
			</head>

			<body${interactiveCanvas ? ' data-interactive-canvas="true"' : ''} data-vscode-context='${JSON.stringify({ preventDefaultContextMenuItems: true, mermaidWebviewId: webviewId })}' data-vscode-mermaid-webview-id="${webviewId}">
				${renderMermaidConfigSpan()}
				<pre class="mermaid">
					${escapeHtmlText(mermaidSource)}
				</pre>

				<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(mermaidScript)}"></script>
			</body>
			</html>`;

		// Watchdog: if the page never reports ready or an error, its scripts
		// were blocked or the module never ran — the in-page failsafe cannot
		// fire in that case. Fall back to a script-free view of the source so
		// the card is never a silent blank.
		const webviewSignalWatchdog = setTimeout(() => {
			if (webviewSignalled) {
				return;
			}
			console.warn(`[mermaid-markdown-features] chat diagram webview sent no ready/error signal within 15s (id ${webviewId}) — falling back to plain source`);
			try {
				webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${interactiveCanvas ? 'html{height:100%;}body{width:100%;height:100%;background:color-mix(in srgb, var(--vscode-foreground) 8%, var(--vscode-editor-background));}' : ''}body{padding:8px;}pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;margin:0;}</style></head><body><pre>${escapeHtmlText(mermaidSource)}</pre></body></html>`;
			} catch {
				// webview already disposed — nothing to recover
			}
		}, 15000);
		disposables.push({ dispose: () => clearTimeout(webviewSignalWatchdog) });
	}
}


export function registerChatSupport(
	context: vscode.ExtensionContext,
	webviewManager: MermaidWebviewManager,
	editorManager: MermaidEditorManager
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand('_mermaid-markdown.openInEditor', (ctx?: MermaidCommandContext) => {
			if (typeof ctx?.mermaidSource === 'string') {
				editorManager.openPreview(ctx.mermaidSource, typeof ctx.title === 'string' ? ctx.title : undefined);
				return;
			}

			const webviewInfo = ctx?.mermaidWebviewId ? webviewManager.getWebview(ctx.mermaidWebviewId) : webviewManager.activeWebview;
			if (webviewInfo) {
				editorManager.openPreview(webviewInfo.mermaidSource, webviewInfo.title);
			}
		})
	);

	// Register lm tools
	disposables.push(
		vscode.lm.registerTool<{ markup: string; title?: string }>('renderMermaidDiagram', {
			invoke: async (options, _token) => {
				const sourceCode = options.input.markup;
				const title = options.input.title;
				return writeMermaidToolOutput(sourceCode, title);
			},
		})
	);

	// Register the chat output renderer for Mermaid diagrams.
	// This will be invoked with the data generated by the tools.
	// It can also be invoked when rendering old Mermaid diagrams in the chat history.
	const renderer = new MermaidChatOutputRenderer(context.extensionUri, webviewManager);
	disposables.push(vscode.chat.registerChatOutputRenderer(viewType, renderer));

	return vscode.Disposable.from(...disposables);
}

function writeMermaidToolOutput(sourceCode: string, title: string | undefined): vscode.LanguageModelToolResult {
	// Expose the source code as a markdown mermaid code block
	const fence = getFenceForContent(sourceCode);
	const result = new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(`${fence}mermaid\n${sourceCode}\n${fence}`)
	]);

	// And store custom data in the tool result details to indicate that a custom renderer should be used for it.
	// Encode source and optional title as JSON.
	const data = JSON.stringify({ source: sourceCode, title });
	// Add cast to use proposed API
	(result as vscode.ExtendedLanguageModelToolResult2).toolResultDetails2 = {
		mime,
		value: new TextEncoder().encode(data),
	};

	return result;
}

function getFenceForContent(content: string): string {
	const backtickMatch = content.matchAll(/`+/g);
	if (!backtickMatch) {
		return '```';
	}

	const maxBackticks = Math.max(...Array.from(backtickMatch, s => s[0].length));
	return '`'.repeat(Math.max(3, maxBackticks + 1));
}

interface MermaidData {
	readonly title: string | undefined;
	readonly source: string;
}

function decodeMermaidData(value: Uint8Array): MermaidData {
	const text = new TextDecoder().decode(value);

	// Try to parse as JSON (new format with title), fall back to plain text (legacy format)
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === 'object' && typeof parsed.source === 'string') {
			return { title: parsed.title, source: parsed.source };
		}
	} catch {
		// Not JSON, treat as legacy plain text format
	}

	return { title: undefined, source: text };
}
