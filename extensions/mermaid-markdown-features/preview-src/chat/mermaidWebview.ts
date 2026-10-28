/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import mermaid, { MermaidConfig } from 'mermaid';
import { buildMermaidConfig, createMermaidErrorElement, loadExtensionConfig, markVsCodeContextAsError } from '../shared';
import { VsCodeMermaidThemeTracker } from '../shared/vsCodeTheme';
import { VsCodeApi } from './vscodeApi';

interface PanZoomState {
	readonly scale: number;
	readonly translateX: number;
	readonly translateY: number;
}

interface PanZoomOptions {
	readonly defaultView?: 'center' | 'fit';
	/**
	 * Plain mouse drag pans (no Alt modifier). Interactive canvases (the
	 * full-size popup) set it; inline cards keep the Alt requirement so
	 * drags stay inert inside the chat thread.
	 */
	readonly plainDragPan?: boolean;
}

interface Size {
	readonly width: number;
	readonly height: number;
}

/**
 * Upper bound of the per-event zoom step (~10%). A mouse wheel notch emits
 * one large delta (~100px) while pinch gestures emit many small ones - the
 * pinch multiplier applied to a notch used to double the scale in a single
 * Ctrl+wheel step.
 */
const MAX_WHEEL_ZOOM_STEP = 0.1;

export class PanZoomHandler {
	private scale = 1;
	private fitScale = 1;
	private translateX = 0;
	private translateY = 0;
	private readonly resizeObserver: ResizeObserver;

	private isPanning = false;
	private hasDragged = false;
	private hasInteracted = false;
	private panModeEnabled = false;
	private startX = 0;
	private startY = 0;

	private readonly minScale = 0.1;
	private readonly maxScale = 5;
	private readonly zoomFactor = 0.002;
	private readonly fitPadding = 16;

	constructor(
		private readonly container: HTMLElement,
		private readonly content: HTMLElement,
		private readonly vscode: VsCodeApi,
		private readonly options: PanZoomOptions = {}
	) {
		this.container = container;
		this.content = content;
		this.content.style.transformOrigin = '0 0';
		this.container.style.overflow = 'hidden';
		this.container.style.cursor = this.options.plainDragPan ? 'grab' : 'default';
		this.setupEventListeners();

		// Chat output containers can resize without triggering a window resize event.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);
		window.addEventListener('pagehide', () => this.resizeObserver.disconnect(), { once: true });
	}

	/**
	 * Initializes the pan/zoom state - either restores from saved state or applies the default view.
	 */
	public initialize(): void {
		if (!this.restoreState()) {
			// Use requestAnimationFrame to ensure layout is updated before resetting the view
			requestAnimationFrame(() => {
				this.resetView();
			});
		}
	}

	private setupEventListeners(): void {
		// Pan with mouse drag
		this.container.addEventListener('mousedown', e => this.handleMouseDown(e));
		document.addEventListener('mousemove', e => this.handleMouseMove(e));
		document.addEventListener('mouseup', () => this.handleMouseUp());

		// Click to zoom (Alt+click = zoom in, Alt+Shift+click = zoom out)
		this.container.addEventListener('click', e => this.handleClick(e));

		// Trackpad: pinch = zoom, Alt + two-finger scroll = zoom
		this.container.addEventListener('wheel', e => this.handleWheel(e), { passive: false });

		// Update cursor when Alt/Option key is pressed
		this.container.addEventListener('mousemove', e => this.updateCursorFromModifier(e));
		this.container.addEventListener('mouseenter', e => this.updateCursorFromModifier(e));
		window.addEventListener('keydown', e => this.handleKeyChange(e));
		window.addEventListener('keyup', e => this.handleKeyChange(e));
	}

	private handleKeyChange(e: KeyboardEvent): void {
		if ((e.key === 'Alt' || e.key === 'Shift') && !this.isPanning) {
			e.preventDefault();
			this.setCursor(e.altKey, e.shiftKey);
		}
	}

	private updateCursorFromModifier(e: MouseEvent): void {
		if (this.isPanning) {
			return;
		}
		this.setCursor(e.altKey, e.shiftKey);
	}

	private setCursor(altKey: boolean, shiftKey: boolean): void {
		if (this.panModeEnabled || this.options.plainDragPan) {
			this.container.style.cursor = 'grab';
			return;
		}

		if (altKey && !shiftKey) {
			this.container.style.cursor = 'grab';
		} else if (altKey && shiftKey) {
			this.container.style.cursor = 'zoom-out';
		} else {
			this.container.style.cursor = 'default';
		}
	}

	private handleClick(e: MouseEvent): void {
		// Only zoom on click if Alt is held and we didn't drag
		if (!e.altKey || this.hasDragged) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		const rect = this.container.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		// Alt+Shift+click = zoom out, Alt+click = zoom in
		const factor = e.shiftKey ? 0.8 : 1.25;
		this.zoomAtPoint(factor, x, y);
	}

	private handleWheel(e: WheelEvent): void {
		// Only zoom when Alt is held (or ctrlKey for pinch-to-zoom gestures)
		// ctrlKey is set by browsers for pinch-to-zoom gestures
		const isPinchZoom = e.ctrlKey;

		if (!e.altKey && !isPinchZoom) {
			// Allow normal scrolling when Alt is not held
			return;
		}

		if (isPinchZoom || e.altKey) {
			// Pinch gesture or Alt + two-finger drag = zoom
			e.preventDefault();
			e.stopPropagation();

			const rect = this.container.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			// Calculate zoom (scroll up = zoom in, scroll down = zoom out)
			// Pinch gestures have smaller deltaY values, so use a higher factor.
			// A mouse wheel notch emits one large delta (~100px) while a pinch
			// emits many small ones - the pinch multiplier applied to a notch
			// used to double the scale in a single step, so line-mode deltas are
			// normalized and the per-event step is clamped.
			const deltaY = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const effectiveZoomFactor = isPinchZoom ? this.zoomFactor * 5 : this.zoomFactor;
			const delta = Math.max(-MAX_WHEEL_ZOOM_STEP, Math.min(MAX_WHEEL_ZOOM_STEP, -deltaY * effectiveZoomFactor));
			// Mirror zoomAtPoint's floor so zooming out of a diagram whose
			// fitted scale is below minScale does not snap the scale back up.
			const minAllowedScale = Math.min(this.minScale, this.fitScale, this.scale);
			const newScale = Math.min(this.maxScale, Math.max(minAllowedScale, this.scale * (1 + delta)));

			// Zoom toward mouse position
			const scaleFactor = newScale / this.scale;
			this.translateX = mouseX - (mouseX - this.translateX) * scaleFactor;
			this.translateY = mouseY - (mouseY - this.translateY) * scaleFactor;
			this.scale = newScale;

			this.applyTransform();
			this.saveState();
		}
	}

	private handleMouseDown(e: MouseEvent): void {
		if (e.button !== 0 || (!this.panModeEnabled && !e.altKey && !this.options.plainDragPan)) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.isPanning = true;
		this.hasDragged = false;
		this.startX = e.clientX - this.translateX;
		this.startY = e.clientY - this.translateY;
		this.container.style.cursor = 'grabbing';
	}

	private handleMouseMove(e: MouseEvent): void {
		if (!this.isPanning) {
			return;
		}

		// Handle case where mouse was released outside the webview
		if (e.buttons === 0) {
			this.handleMouseUp();
			return;
		}

		const dx = e.clientX - this.startX - this.translateX;
		const dy = e.clientY - this.startY - this.translateY;
		if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
			this.hasDragged = true;
		}
		this.translateX = e.clientX - this.startX;
		this.translateY = e.clientY - this.startY;
		this.applyTransform();
	}

	private handleMouseUp(): void {
		if (this.isPanning) {
			this.isPanning = false;
			this.setCursor(false, false);
			this.saveState();
		}
	}

	private applyTransform(): void {
		this.content.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
	}

	private saveState(): void {
		this.hasInteracted = true;
		const currentState = this.vscode.getState() || {};
		this.vscode.setState({
			...currentState,
			panZoom: {
				scale: this.scale,
				translateX: this.translateX,
				translateY: this.translateY
			}
		});
	}

	private restoreState(): boolean {
		const state = this.vscode.getState();
		if (state?.panZoom) {
			const panZoom = state.panZoom as PanZoomState;
			this.updateFitScale();
			this.scale = panZoom.scale ?? 1;
			this.translateX = panZoom.translateX ?? 0;
			this.translateY = panZoom.translateY ?? 0;
			this.hasInteracted = true;
			this.applyTransform();
			return true;
		}
		return false;
	}

	private handleResize(): void {
		this.updateFitScale();
		if (!this.hasInteracted) {
			this.resetView();
		}
	}

	private updateFitScale(): void {
		if (this.options.defaultView !== 'fit') {
			this.fitScale = 1;
			return;
		}

		const scale = this.getScaleToFitContainer();
		if (scale !== undefined) {
			this.fitScale = scale;
		}
	}

	private getSvgSize(): Size | undefined {
		// Get the SVG element inside the content - mermaid renders to an SVG
		const svg = this.content.querySelector('svg');
		if (!svg) {
			return;
		}

		const oldTransform = this.content.style.transform;
		this.content.style.transform = 'none';
		const svgRect = svg.getBoundingClientRect();
		this.content.style.transform = oldTransform;

		if (svgRect.width <= 0 || svgRect.height <= 0) {
			return;
		}

		return { width: svgRect.width, height: svgRect.height };
	}

	private resetView(): void {
		if (this.options.defaultView === 'fit') {
			this.fitContentToContainer();
		} else {
			this.centerContent();
		}
	}

	private centerContent(): void {
		const containerRect = this.container.getBoundingClientRect();
		const svgSize = this.getSvgSize();
		if (!svgSize) {
			return;
		}

		this.scale = 1;
		this.fitScale = 1;
		this.translateX = (containerRect.width - svgSize.width) / 2;
		this.translateY = (containerRect.height - svgSize.height) / 2;

		this.applyTransform();
	}

	private fitContentToContainer(): void {
		const svgSize = this.getSvgSize();
		if (!svgSize) {
			return;
		}

		const containerRect = this.container.getBoundingClientRect();
		this.scale = this.getScaleToFitContainer(svgSize, containerRect) ?? 1;
		this.fitScale = this.scale;
		this.translateX = (containerRect.width - (svgSize.width * this.scale)) / 2;
		this.translateY = (containerRect.height - (svgSize.height * this.scale)) / 2;

		this.applyTransform();
	}

	private getScaleToFitContainer(svgSize = this.getSvgSize(), containerRect = this.container.getBoundingClientRect()): number | undefined {
		if (!svgSize) {
			return;
		}

		const availableWidth = Math.max(1, containerRect.width - (this.fitPadding * 2));
		const availableHeight = Math.max(1, containerRect.height - (this.fitPadding * 2));
		const scale = Math.min(1, availableWidth / svgSize.width, availableHeight / svgSize.height);
		return Number.isFinite(scale) && scale > 0 ? scale : undefined;
	}

	public reset(): void {
		this.scale = 1;
		this.translateX = 0;
		this.hasInteracted = false;
		this.applyTransform(); // Apply scale first so content size is correct

		// Clear the saved pan/zoom state
		const currentState = this.vscode.getState() || {};
		delete currentState.panZoom;
		this.vscode.setState(currentState);

		// Use requestAnimationFrame to ensure layout is updated before resetting the view
		requestAnimationFrame(() => {
			this.resetView();
		});
	}

	public zoomIn(): void {
		const rect = this.container.getBoundingClientRect();
		this.zoomAtPoint(1.25, rect.width / 2, rect.height / 2);
	}

	public zoomOut(): void {
		const rect = this.container.getBoundingClientRect();
		this.zoomAtPoint(0.8, rect.width / 2, rect.height / 2);
	}

	public togglePanMode(): boolean {
		this.panModeEnabled = !this.panModeEnabled;
		this.setCursor(false, false);
		return this.panModeEnabled;
	}

	private zoomAtPoint(factor: number, x: number, y: number): void {
		const minAllowedScale = Math.min(this.minScale, this.fitScale, this.scale);
		const newScale = Math.min(this.maxScale, Math.max(minAllowedScale, this.scale * factor));
		const scaleFactor = newScale / this.scale;
		this.translateX = x - (x - this.translateX) * scaleFactor;
		this.translateY = y - (y - this.translateY) * scaleFactor;
		this.scale = newScale;
		this.applyTransform();
		this.saveState();
	}
}

/**
 * Unpersisted state
 */
interface LocalState {
	readonly mermaidSource: string;
}

interface PersistedState {
	readonly mermaidSource: string;
	readonly panZoom?: PanZoomState;
}

/**
 * mermaid.run() 在渲染卡死時 promise 可能永不 settle——圖會永遠停在
 * visibility: hidden（空白卡且無任何錯誤）。逾時收斂成 rejection，讓呼叫端
 * 走與渲染失敗相同的錯誤呈現。泛型參數是為了接受 mermaid.run 的
 * Promise<RenderResult[]> 回傳值，結果本身不需要。
 */
function withRenderTimeout<T>(render: Promise<T>, timeoutMs = 15000): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Mermaid rendering timed out after ${timeoutMs}ms`)),
			timeoutMs
		);
		render.then(
			() => { clearTimeout(timer); resolve(); },
			err => { clearTimeout(timer); reject(err); }
		);
	});
}

/**
 * 渲染失敗的統一呈現：顯示錯誤訊息、標記 vscode context、隱藏縮放控制，
 * 並 reveal 圖卡——任何失敗都不該停在 visibility: hidden 的空白卡。
 */
function showRenderError(diagram: HTMLElement, err: unknown): void {
	diagram.replaceChildren(createMermaidErrorElement(err));
	markVsCodeContextAsError(document.body);
	for (const el of document.querySelectorAll<HTMLElement>('.zoom-controls')) {
		el.style.display = 'none';
	}
	diagram.classList.add('rendered');
}

/**
 * Re-renders the mermaid diagram when theme changes
 */
async function rerenderMermaidDiagram(
	diagramElement: HTMLElement,
	diagramText: string,
	themeTracker: VsCodeMermaidThemeTracker,
): Promise<void> {
	diagramElement.textContent = diagramText;
	delete diagramElement.dataset.processed;

	mermaid.initialize(buildMermaidConfig(loadExtensionConfig(), themeTracker));
	await withRenderTimeout(mermaid.run({
		nodes: [diagramElement]
	}));
}

export async function initializeMermaidWebview(vscode: VsCodeApi, options?: PanZoomOptions): Promise<PanZoomHandler | undefined> {
	const diagram = document.querySelector<HTMLElement>('.mermaid');
	if (!diagram) {
		// 沒有 .mermaid 代表頁面結構與預期不符。舊行為是直接 return，圖卡會
		// 永遠停在 visibility: hidden——空白卡且無任何錯誤。必須拋出，讓進入點
		// 的 catch 顯示錯誤並回報 webviewError。
		throw new Error('Mermaid webview initialized without a .mermaid element');
	}

	// Capture diagram state
	const diagramText = diagram.textContent ?? '';
	if (!diagramText.trim()) {
		// 空來源：mermaid.run 對空節點既不輸出也不報錯，圖會永遠隱形。
		// 以錯誤呈現收斂，至少讓使用者看到原因而不是空白卡。
		showRenderError(diagram, new Error('Mermaid diagram source is empty'));
		vscode.postMessage({ type: 'webviewError', message: 'Mermaid diagram source is empty' });
		return;
	}
	const themeTracker = new VsCodeMermaidThemeTracker();
	const state: LocalState = {
		mermaidSource: diagramText,
	};

	// Save the mermaid source in the webview state
	const currentState: PersistedState = vscode.getState() || {};
	vscode.setState({
		...currentState,
		mermaidSource: diagramText
	});

	// Wrap the diagram for pan/zoom support
	const wrapper = document.createElement('div');
	wrapper.className = 'mermaid-wrapper';
	wrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

	const content = document.createElement('div');
	content.className = 'mermaid-content';

	// Move the diagram into the content wrapper
	diagram.parentNode?.insertBefore(wrapper, diagram);
	content.appendChild(diagram);
	wrapper.appendChild(content);

	// Run mermaid using the selected VS Code-themed config
	const config: MermaidConfig = buildMermaidConfig(loadExtensionConfig(), themeTracker);
	mermaid.initialize(config);
	try {
		// mermaid.run 卡死時 promise 永不 settle，圖會永遠停在 visibility: hidden；
		// 逾時收斂成錯誤呈現，不再無聲空白。
		await withRenderTimeout(mermaid.run({ nodes: [diagram] }));
	} catch (err) {
		showRenderError(diagram, err);
		vscode.postMessage({ type: 'webviewError', message: err instanceof Error ? err.message : String(err) });
		return;
	}

	// Show the diagram now that it's rendered
	diagram.classList.add('rendered');

	// 告知擴充端模組已執行且圖已渲染——擴充端的看門狗以此區分
	// 「腳本從未執行」與「渲染較慢」。
	vscode.postMessage({ type: 'webviewReady' });

	const panZoomHandler = new PanZoomHandler(wrapper, content, vscode, options);
	panZoomHandler.initialize();

	// Listen for messages from the extension
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'resetPanZoom') {
			panZoomHandler.reset();
		}
	});

	// Re-render when the active VS Code theme changes. The tracker watches DOM mutations on the
	// body (theme class / data attributes) and the document element (inline CSS variable updates
	// from `workbench.colorCustomizations`), and only fires when the resolved colors actually
	// change.
	themeTracker.onDidChange(() => {
		const diagramNode = document.querySelector('.mermaid');
		if (!(diagramNode instanceof HTMLElement)) {
			return;
		}
		// 主題切換的重繪失敗不能變成未處理的 rejection——沿用渲染失敗的錯誤呈現。
		rerenderMermaidDiagram(diagramNode, state.mermaidSource, themeTracker).catch(err => {
			showRenderError(diagramNode, err);
		});
	});
	themeTracker.observeDomChanges();

	return panZoomHandler;
}
