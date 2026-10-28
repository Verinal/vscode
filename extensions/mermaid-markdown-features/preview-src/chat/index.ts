/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { initializeMermaidWebview } from './mermaidWebview';
import { VsCodeApi } from './vscodeApi';

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();


async function main() {
	// Full-size popups mark the body with `data-interactive-canvas`: the
	// diagram renders as an interactive canvas (fitted view, plain drag pans,
	// ctrl+wheel zooms). Inline cards keep the content-sized behavior.
	const interactiveCanvas = document.body.dataset.interactiveCanvas === 'true';
	await initializeMermaidWebview(vscode, interactiveCanvas ? { defaultView: 'fit', plainDragPan: true } : undefined);
}

// Any module-level failure (mermaid init, theme resolution, diagram render)
// used to leave the diagram invisible with no error — the failsafe bootstrap
// in the page head reveals it and shows the message instead.
main().catch(err => {
	const message = err instanceof Error ? err.message : String(err);
	const show = (window as { __showMermaidError?: (kind: string, message: string) => void }).__showMermaidError;
	if (show) {
		show('script error', message);
	} else {
		// Bootstrap missing — reveal the source directly so it is at least copyable.
		const pre = document.querySelector<HTMLElement>('.mermaid');
		if (pre) {
			pre.style.visibility = 'visible';
		}
	}
	vscode.postMessage({ type: 'webviewError', message });
});
