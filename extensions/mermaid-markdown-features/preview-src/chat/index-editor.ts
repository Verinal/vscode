/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { initializeMermaidWebview } from './mermaidWebview';
import { VsCodeApi } from './vscodeApi';

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

initializeMermaidWebview(vscode, { defaultView: 'fit' }).then(panZoomHandler => {
	if (!panZoomHandler) {
		return;
	}

	const stopClickForEditMode = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
	};

	// Wire up zoom controls
	const panModeBtn = document.querySelector<HTMLButtonElement>('.pan-mode-btn');
	const zoomInBtn = document.querySelector('.zoom-in-btn');
	const zoomOutBtn = document.querySelector('.zoom-out-btn');
	const zoomResetBtn = document.querySelector('.zoom-reset-btn');

	panModeBtn?.addEventListener('click', e => {
		stopClickForEditMode(e);
		const enabled = panZoomHandler.togglePanMode();
		panModeBtn.classList.toggle('active', enabled);
		panModeBtn.setAttribute('aria-pressed', String(enabled));
	});
	zoomInBtn?.addEventListener('click', e => {
		stopClickForEditMode(e);
		panZoomHandler.zoomIn();
	});
	zoomOutBtn?.addEventListener('click', e => {
		stopClickForEditMode(e);
		panZoomHandler.zoomOut();
	});
	zoomResetBtn?.addEventListener('click', e => {
		stopClickForEditMode(e);
		panZoomHandler.reset();
	});

	for (const btn of [panModeBtn, zoomInBtn, zoomOutBtn, zoomResetBtn]) {
		btn?.addEventListener('dblclick', stopClickForEditMode);
	}
}).catch(err => {
	// 編輯器預覽頁同樣以 visibility: hidden 起始；初始化失敗（找不到 .mermaid、
	// mermaid.initialize 拋錯等）不能無聲空白——直接顯示原始碼，至少可讀可複製。
	console.error('[mermaid-markdown-features] diagram preview failed:', err);
	const pre = document.querySelector<HTMLElement>('.mermaid');
	if (pre) {
		pre.style.visibility = 'visible';
	}
});
