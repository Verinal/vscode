/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Side-effect import: registers the browser-layer client implementation of
// IVibeAIService in the workbench DI container. It proxies all requests
// through the main process, which performs the actual HTTP calls against
// the local VibeCoding backend (bypasses CORS).
import '../../../../platform/vibeAI/browser/vibeAIClientService.js';

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import * as DOM from '../../../../base/browser/dom.js';

const $ = DOM.$;
import { IAction } from '../../../../base/common/actions.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext, IsVibeAgentWindowContext } from '../../../common/contextkeys.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IVibeAIService } from '../../../../platform/vibeAI/common/vibeAI.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IVibeAIStats } from './vibeAIStats.js';
import { VibeAIChatPane } from './vibeAIChatPane.js';
import { VibeAISettingsEditorInput, VibeAISettingsEditorPane } from './vibeAISettingsEditor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VibeAIInlineCompletionProvider } from './vibeAIInlineCompletion.js';
import { startVibeAIInlineEdit } from './vibeAIInlineEdit.js';
import { VIBE_AI_NO_MODEL_MESSAGE, VibeAIModelStore } from './vibeAIModelStore.js';
import { AGENT_WINDOW_PROJECT_STORAGE_KEY, VibeAIAgentsHubInput, VibeAIAgentsHubPane } from './vibeAIAgentsHub.js';
import { VIBE_AI_HANDOFF_MAX_AGE_MS, VIBE_AI_HANDOFF_STORAGE_KEY, VibeAIChatSessionStore, parseVibeAIChatHandoff } from './vibeAIChatSessionStore.js';
import './media/vibeAITitleBar.css';
import './media/vibeAIAgentsHub.css';

const CONTAINER_ID = 'workbench.view.vibeAI';
const VIEW_ID = VibeAIChatPane.ID;

const vibeAIChatIcon = registerIcon(
	'vibe-ai-chat-view-icon',
	Codicon.sparkle,
	localize('vibeAIChatViewIcon', "View icon of the VibeAI Chat view."),
);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

// Cursor parity: the VibeAI chat takes over the secondary sidebar (right
// side) as its default container — the same slot the built-in GitHub
// Copilot chat occupies upstream. This fork ships with
// `chat.disableAIFeatures` defaulting to `true` (see
// chat/shared.contribution.ts), which hides the built-in chat view and its
// container (hideIfEmpty), leaving the VibeAI view in this slot.
const container = viewContainersRegistry.registerViewContainer(
	{
		id: CONTAINER_ID,
		title: localize2('vibeAIChatContainer', "VibeAI Chat"),
		icon: vibeAIChatIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: CONTAINER_ID,
		order: 1,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: true },
);

const viewDescriptor: IViewDescriptor = {
	id: VIEW_ID,
	name: localize2('vibeAIChatView', "VibeAI Chat"),
	containerIcon: vibeAIChatIcon,
	ctorDescriptor: new SyncDescriptor(VibeAIChatPane),
	canToggleVisibility: false,
	canMoveView: true,
	// Cursor parity: take over the Ctrl+Alt+I chord previously bound to the
	// built-in chat view. This contribution is imported after the chat
	// contributions, so this binding wins in keybinding resolution.
	openCommandActionDescriptor: {
		id: 'vibeAIChat.focus',
		title: localize2('vibeAIChat.focus', "Focus VibeAI Chat"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
		},
	},
};

viewsRegistry.registerViews([viewDescriptor], container);

// ==================== 開窗即產品 UI：啟動自動展開 VibeAI Chat ====================

class VibeAIAutoOpenChatContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIAutoOpenChat';

	constructor(
		@IViewsService viewsService: IViewsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService logService: ILogService,
	) {
		super();

		// The Agents (sessions) window has its own chat surface, auxiliary
		// windows are floating editor panes, and the standalone agent window
		// lands in the Agents hub instead (Phase 177) — none of them
		// auto-open the chat sidebar view.
		if (contextKeyService.getContextKeyValue<boolean>(IsSessionsWindowContext.key)
			|| contextKeyService.getContextKeyValue<boolean>(IsAuxiliaryWindowContext.key)
			|| contextKeyService.getContextKeyValue<boolean>(IsVibeAgentWindowContext.key)) {
			return;
		}

		// Phase 84.8 (user: 「圖 1 的 UI 徹底刪除，你永遠打開錯」): every main
		// window lands in the product UI — the VibeAI Chat view is opened at
		// startup, so the bare workbench (empty editor watermark, no chat)
		// can never be the resting state, whatever opened the window
		// (double-click launcher / backend auto-launch / throwaway profile /
		// restored scratch window). openView is idempotent and focus=false:
		// an already-visible chat (restored layout) is untouched; a closed
		// auxiliary bar reopens.
		viewsService.openView(VIEW_ID, false).then(
			() => logService.trace('[vibeAI] chat auto-opened at startup'),
			err => logService.warn('[vibeAI] chat auto-open failed', err),
		);
	}
}

registerWorkbenchContribution2(VibeAIAutoOpenChatContribution.ID, VibeAIAutoOpenChatContribution, WorkbenchPhase.AfterRestored);

class ClearVibeAIChatAction extends Action2 {
	static readonly ID = 'vibeAIChat.clear';
	constructor() {
		super({
			id: ClearVibeAIChatAction.ID,
			title: localize2('vibeAIChat.clear', "Clear Chat"),
			icon: Codicon.clearAll,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', VIEW_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId<VibeAIChatPane>(VIEW_ID);
		view?.clearChat();
	}
}

registerAction2(ClearVibeAIChatAction);

class VibeAIChatHistoryAction extends Action2 {
	static readonly ID = 'vibeAIChat.history';
	constructor() {
		super({
			id: VibeAIChatHistoryAction.ID,
			title: localize2('vibeAIChat.history', "Chat History"),
			icon: Codicon.history,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', VIEW_ID),
				group: 'navigation',
				order: 2,
			}],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getActiveViewWithId<VibeAIChatPane>(VIEW_ID);
		view?.showHistory();
	}
}

registerAction2(VibeAIChatHistoryAction);

// ==================== Cursor parity: Tab inline completion (ghost text) ====================

class VibeAIInlineCompletionsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIInlineCompletions';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeAIService vibeAIService: IVibeAIService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IVibeAIStats stats: IVibeAIStats,
		@IStorageService storageService: IStorageService,
	) {
		super();

		// Cursor-style Tab completion: ghost text fetched from the local
		// VibeCoding backend whenever typing pauses.
		this._register(languageFeaturesService.inlineCompletionsProvider.register(
			'*',
			new VibeAIInlineCompletionProvider(vibeAIService, logService, configurationService, stats, storageService)
		));
	}
}

registerWorkbenchContribution2(VibeAIInlineCompletionsContribution.ID, VibeAIInlineCompletionsContribution, WorkbenchPhase.BlockRestore);

// ==================== Cursor parity: Ctrl+K inline edit ====================

class VibeAIInlineEditAction extends Action2 {
	static readonly ID = 'vibeAI.inlineEdit';

	constructor() {
		super({
			id: VibeAIInlineEditAction.ID,
			title: localize2('vibeAIInlineEdit', "VibeAI: Edit with AI"),
			category: 'VibeAI',
			keybinding: {
				weight: KeybindingWeight.EditorContrib + 10,
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: EditorContextKeys.editorTextFocus,
			},
			menu: [{
				id: MenuId.EditorContext,
				group: '9_vibeai',
				order: 1,
				when: EditorContextKeys.writable,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const vibeAIService = accessor.get(IVibeAIService);
		const notificationService = accessor.get(INotificationService);
		const editor = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
		if (!editor || !editor.getModel()) {
			return;
		}
		// Custom models only (no default-model fallback): Ctrl+K goes to the
		// chat pane's selected model (Auto → first pool model). Nothing
		// configured → surface the backend's message instead of opening the
		// widget (the backend would 400 the request).
		const modelStore = new VibeAIModelStore(accessor.get(IStorageService), accessor.get(IConfigurationService));
		const provider = modelStore.resolveEditorModelProvider();
		if (!provider) {
			notificationService.warn(VIBE_AI_NO_MODEL_MESSAGE);
			return;
		}
		startVibeAIInlineEdit(editor, vibeAIService, provider);
	}
}

class VibeAIInlineEditContribution extends Disposable implements IWorkbenchContribution {

	constructor() {
		super();

		// Registering the action here (instantiation phase) puts its Ctrl+K
		// rule AFTER every module-level keybinding registration.
		// KeybindingResolver#_findCommand scans candidates from the END, so
		// while the editor has text focus this single-chord rule is found
		// first → Ctrl+K opens the inline edit immediately (Cursor-style).
		// Outside the editor the `when` clause fails and the default Ctrl+K
		// chords keep working.
		registerAction2(VibeAIInlineEditAction);
	}
}

registerWorkbenchContribution2('workbench.contrib.vibeAIInlineEdit', VibeAIInlineEditContribution, WorkbenchPhase.BlockRestore);

// ==================== Cursor parity: Tab accept tracking (status bar stats) ====================

class VibeAIStatsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIStats';

	constructor(
		@ICommandService commandService: ICommandService,
		@IVibeAIStats stats: IVibeAIStats,
	) {
		super();

		// Tab accepts are observed via command execution (Tab is bound to the
		// inline suggest accept command) — powers "Tab Stats" in the status bar.
		this._register(commandService.onDidExecuteCommand(e => {
			if (e.commandId === 'editor.action.inlineSuggest.accept'
				|| e.commandId === 'editor.action.inlineSuggest.acceptNextWord'
				|| e.commandId === 'editor.action.inlineSuggest.acceptNextLine5') {
				stats.reportAccepted();
			}
		}));
	}
}

registerWorkbenchContribution2(VibeAIStatsContribution.ID, VibeAIStatsContribution, WorkbenchPhase.BlockRestore);

// ==================== Cursor parity: status bar entries ====================

class VibeAIStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIStatusBar';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IVibeAIStats stats: IVibeAIStats,
	) {
		super();

		// "Vibe Tab" entry — click toggles Tab completion (Cursor-parity
		// "Cursor Tab" status item).
		this._register(statusbarService.addEntry(
			{
				name: localize('vibeAI.status.tab', "VibeAI Tab Completion"),
				text: `$(sparkle) Vibe Tab`,
				ariaLabel: localize('vibeAI.status.tab', "VibeAI Tab Completion"),
				tooltip: localize('vibeAI.status.tabTooltip', "Cursor-style Tab completion by VibeAI — click to toggle"),
				command: 'vibeAI.toggleInlineCompletion',
			},
			'status.vibeAI.tab',
			StatusbarAlignment.RIGHT,
			30,
		));

		// "Tab Stats" entry — shown/accepted inline completions.
		const tabStatsAccessor = this._register(statusbarService.addEntry(
			{
				name: localize('vibeAI.status.tabStats', "VibeAI Tab Stats"),
				text: `$(arrow-right) Tab Stats: 0/0 (0%)`,
				ariaLabel: localize('vibeAI.status.tabStats', "VibeAI Tab Stats"),
				tooltip: localize('vibeAI.status.tabStatsTooltip', "Ghost texts shown vs accepted via Tab"),
			},
			'status.vibeAI.tabStats',
			StatusbarAlignment.RIGHT,
			29,
		));

		// "Agent Stats" entry — agent tool calls / rounds.
		const agentStatsAccessor = this._register(statusbarService.addEntry(
			{
				name: localize('vibeAI.status.agentStats', "VibeAI Agent Stats"),
				text: `$(sparkle) Agent Stats: 0/0`,
				ariaLabel: localize('vibeAI.status.agentStats', "VibeAI Agent Stats"),
				tooltip: localize('vibeAI.status.agentStatsTooltip', "Agent tool calls / rounds this session"),
			},
			'status.vibeAI.agentStats',
			StatusbarAlignment.RIGHT,
			28,
		));

		this._register(stats.onDidChange(() => {
			const shown = stats.shownCount;
			const accepted = stats.acceptedCount;
			const pct = shown > 0 ? Math.round((accepted / shown) * 100) : 0;
			tabStatsAccessor.update({
				name: localize('vibeAI.status.tabStats', "VibeAI Tab Stats"),
				text: `$(arrow-right) Tab Stats: ${shown}/${accepted} (${pct}%)`,
				ariaLabel: localize('vibeAI.status.tabStats', "VibeAI Tab Stats"),
				tooltip: localize('vibeAI.status.tabStatsTooltip', "Ghost texts shown vs accepted via Tab"),
			});
			agentStatsAccessor.update({
				name: localize('vibeAI.status.agentStats', "VibeAI Agent Stats"),
				text: `$(sparkle) Agent Stats: ${stats.toolCallCount}/${stats.roundCount}`,
				ariaLabel: localize('vibeAI.status.agentStats', "VibeAI Agent Stats"),
				tooltip: localize('vibeAI.status.agentStatsTooltip', "Agent tool calls / rounds this session"),
			});
		}));
	}
}

registerWorkbenchContribution2(VibeAIStatusBarContribution.ID, VibeAIStatusBarContribution, WorkbenchPhase.BlockRestore);

class VibeAIToggleInlineCompletionAction extends Action2 {
	static readonly ID = 'vibeAI.toggleInlineCompletion';

	constructor() {
		super({
			id: VibeAIToggleInlineCompletionAction.ID,
			title: localize2('vibeAI.toggleInlineCompletion', "VibeAI: Toggle Tab Completion"),
			category: localize2('vibeAI.category', 'VibeAI'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const current = configurationService.getValue<boolean>('vibeAI.inlineCompletion.enabled') !== false;
		await configurationService.updateValue('vibeAI.inlineCompletion.enabled', !current);
	}
}

registerAction2(VibeAIToggleInlineCompletionAction);

// ==================== Cursor parity: settings window ====================

class VibeAIOpenSettingsAction extends Action2 {
	static readonly ID = 'vibeAI.settings.open';

	constructor() {
		super({
			id: VibeAIOpenSettingsAction.ID,
			title: localize2('vibeAI.settings.open', "VibeAI: Open Settings"),
			category: localize2('vibeAI.category', 'VibeAI'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Cursor parity: settings open directly in the editor area as a tab —
		// the title-bar gear runs this command (no modal window, no dropdown).
		await accessor.get(IEditorService).openEditor(VibeAISettingsEditorInput.getOrCreate(), { pinned: true });
	}
}

registerAction2(VibeAIOpenSettingsAction);

// ==================== Settings editor registration ====================

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		VibeAISettingsEditorPane,
		VibeAISettingsEditorPane.ID,
		localize('vibeAISettingsEditor', "VibeAI Settings Editor")
	),
	[
		// Note: Using the class directly since the input is a singleton
		new SyncDescriptor(VibeAISettingsEditorInput as unknown as { new(): VibeAISettingsEditorInput })
	]
);

class VibeAISettingsEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof VibeAISettingsEditorInput;
	}

	serialize(input: VibeAISettingsEditorInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): VibeAISettingsEditorInput {
		return VibeAISettingsEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	VibeAISettingsEditorInput.ID,
	VibeAISettingsEditorInputSerializer
);

// ==================== Agents Hub editor registration (Phase 176) ====================

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		VibeAIAgentsHubPane,
		VibeAIAgentsHubPane.ID,
		localize('vibeAIAgentsHubEditor', "VibeAI Agents Hub")
	),
	[
		// Singleton input, same pattern as the settings editor above.
		new SyncDescriptor(VibeAIAgentsHubInput as unknown as { new(): VibeAIAgentsHubInput })
	]
);

class VibeAIAgentsHubInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof VibeAIAgentsHubInput;
	}

	serialize(input: VibeAIAgentsHubInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): VibeAIAgentsHubInput | undefined {
		// Phase 181 r6: the hub is the agent window's whole UI — it must
		// never restore as an editor tab inside a normal IDE window.
		const environmentService = instantiationService.invokeFunction(accessor => accessor.get(IWorkbenchEnvironmentService));
		if (!environmentService.isVibeAgentWindow) {
			return undefined;
		}
		return VibeAIAgentsHubInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	VibeAIAgentsHubInput.ID,
	VibeAIAgentsHubInputSerializer
);

// ==================== Cursor parity: "Agents" title bar pill ====================

class VibeAIOpenAgentsWindowAction extends Action2 {
	static readonly ID = 'vibeAI.openAgentsWindow';

	constructor() {
		super({
			id: VibeAIOpenAgentsWindowAction.ID,
			title: localize2('vibeAI.openAgentsWindow', "Agents"),
			tooltip: localize('vibeAI.openAgentsWindowTooltip', "Open the Agents hub — parallel agent sessions for this workspace"),
			icon: Codicon.sparkle,
			f1: false,
			menu: [{
				id: MenuId.TitleBar,
				group: 'navigation',
				order: 1,
				// Hidden inside the agent window itself (that window lives in
				// the hub) and in auxiliary windows.
				when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsVibeAgentWindowContext.toNegated()),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);
		const storageService = accessor.get(IStorageService);
		const contextService = accessor.get(IWorkspaceContextService);

		// Phase 176 (Cursor parity): opens the fork's own Agents surface —
		// the multi-session dashboard over the VibeCoding backend (not the
		// upstream Agents Window, whose agent stack is Claude / Codex /
		// Copilot CLI behind a GitHub sign-in gate, entirely separate from
		// this fork's backend).
		//
		// Phase 177 (Cursor parity): it opens as a real standalone agent
		// window — a dedicated neutral workspace whose renderer hides the
		// IDE chrome and lands directly in the Agents hub. The current
		// folder rides along through application storage, because the agent
		// window's workspace context is neutral on purpose (opening the
		// folder itself there would share workspace storage with this IDE
		// window and its layout state).
		const folder = contextService.getWorkspace().folders[0];
		if (folder) {
			storageService.store(AGENT_WINDOW_PROJECT_STORAGE_KEY, folder.uri.fsPath, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		// Phase 181 r6: no in-window fallback — the Agents window is a
		// separate app instance on its own neutral workspace (Cursor
		// parity). Opening the hub as an editor tab inside the IDE would
		// blur the two surfaces into one UI, exactly what must not happen.
		try {
			await nativeHostService.openVibeAgentWindow();
		} catch (error) {
			notificationService.error(localize('vibeAI.openAgentWindowFailed', "Opening the Agents window failed: {0}", String(error)));
		}
	}
}

registerAction2(VibeAIOpenAgentsWindowAction);

// ==================== Agent window: "IDE ↗" jump (Phase 177) ====================

/**
 * The agent window's "IDE ↗" button: opens the hub's resolved project
 * folder in a normal IDE window (native openWindow reuses a window that
 * already shows the folder, mirroring Cursor's IDE jump).
 */
class VibeAIAgentWindowOpenIdeAction extends Action2 {
	static readonly ID = 'vibeAI.agentWindow.openIde';

	constructor() {
		super({
			id: VibeAIAgentWindowOpenIdeAction.ID,
			title: localize2('vibeAI.agentWindow.openIde', "Open in IDE"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, folderUri?: URI): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.openWindow(folderUri ? [{ folderUri }] : []);
	}
}

registerAction2(VibeAIAgentWindowOpenIdeAction);

// ==================== Agent window bootstrap (Phase 177) ====================

/**
 * Sets up the standalone agent window renderer: hide the IDE chrome
 * (activity bar, sidebar, bottom panel — the status bar stays, it carries
 * the VibeAI stats) and land the window directly in the Agents hub editor.
 * The chat sidebar still opens on demand when a conversation is started
 * from the hub composer or a thread row.
 */
class VibeAIAgentWindowBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIAgentWindowBootstrap';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IEditorService editorService: IEditorService,
		@ILogService logService: ILogService,
	) {
		super();

		if (!contextKeyService.getContextKeyValue<boolean>(IsVibeAgentWindowContext.key)) {
			return;
		}

		layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		layoutService.setPartHidden(true, Parts.PANEL_PART);
		// Phase 181 (Cursor shell parity): the agent window has no status
		// bar, no editor tab bar and no centered window title — the workbench
		// reads like a standalone app (CSS side: media/vibeAIAgentsHub.css).
		layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
		// Phase 181 r7 (user: 「右邊是不可能出現對話框的」): the right-hand
		// chat panel is IDE-only — the agent window's single composer is the
		// hub's center one. A restored auxiliary bar would resurrect the
		// "New Agent" chat, so hide it like the other chrome.
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		layoutService.getContainer(window).classList.add('vibe-agent-window');

		editorService.openEditor(VibeAIAgentsHubInput.getOrCreate(), { pinned: true }).then(
			() => {
				logService.trace('[vibeAI] agent window landed in the Agents hub');
				// Phase 181 r2: restored panels re-show themselves after the
				// initial hide — re-assert once the workbench settled.
				setTimeout(() => {
					layoutService.setPartHidden(true, Parts.PANEL_PART);
					layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
				}, 1000);
			},
			err => logService.warn('[vibeAI] agent window hub open failed', err),
		);
	}
}

registerWorkbenchContribution2(VibeAIAgentWindowBootstrapContribution.ID, VibeAIAgentWindowBootstrapContribution, WorkbenchPhase.AfterRestored);

/**
 * Phase 180 (session roaming, Cursor parity): picks up a one-shot
 * conversation handoff (`vibeAI.agentHandoff`) right after this window
 * restored — the agent window (or another IDE surface) queued either an
 * existing thread to open or composer text to send in a fresh
 * conversation. Skipped in the agent window itself (its hub consumes
 * thread handoffs itself, and seeded sends would loop back) and for
 * handoffs aimed at a different project than the one this window opened.
 */
class VibeAIHandoffPickupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIHandoffPickup';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// The agent window's hub consumes thread handoffs itself (highlight
		// in the sidebar) and has no chat view — and seeded sends must not
		// loop back — so it leaves the key untouched here.
		if (contextKeyService.getContextKeyValue<boolean>(IsVibeAgentWindowContext.key)) {
			return;
		}
		const raw = this.storageService.get(VIBE_AI_HANDOFF_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		// One-shot: consume immediately, whoever ends up acting on it.
		this.storageService.remove(VIBE_AI_HANDOFF_STORAGE_KEY, StorageScope.APPLICATION);
		const handoff = parseVibeAIChatHandoff(raw);
		if (!handoff || Date.now() - handoff.ts > VIBE_AI_HANDOFF_MAX_AGE_MS) {
			return;
		}
		const root = this.contextService.getWorkspace().folders[0]?.uri.fsPath;
		if (handoff.workspaceRoot && root && handoff.workspaceRoot.toLowerCase() !== root.toLowerCase()) {
			// Aimed at another project's window (the agent window opens the
			// right one via `vibeAI.agentWindow.openIde`).
			return;
		}
		// Let the workbench finish restoring before opening the chat view.
		setTimeout(() => {
			if (handoff.sessionId) {
				const store = new VibeAIChatSessionStore(this.storageService, this.contextService);
				const session = store.list().find(candidate => candidate.id === handoff.sessionId);
				if (!session) {
					return;
				}
				this.viewsService.openView(VibeAIChatPane.ID, false).then(view => {
					if (view) {
						(view as VibeAIChatPane).loadSession(session);
					}
				});
			} else if (handoff.newMessage) {
				this.viewsService.openView(VibeAIChatPane.ID, true).then(view => {
					if (view) {
						(view as VibeAIChatPane).sendFromHub(handoff.newMessage!, handoff.workspaceRoot ?? root);
					}
				});
			}
		}, 400);
	}
}

registerWorkbenchContribution2(VibeAIHandoffPickupContribution.ID, VibeAIHandoffPickupContribution, WorkbenchPhase.AfterRestored);

/**
 * Renders the "Agents" title bar entry as a Cursor-style blue pill
 * (Phase 177: opens the standalone agent window for the current workspace;
 * falls back to the in-window Agents hub editor tab when window creation
 * is unavailable).
 */
class VibeAITitleBarPill extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('vibe-ai-titlebar-pill');
		container.setAttribute('role', 'button');
		container.setAttribute('tabindex', '0');

		const label = DOM.append(container, $('span.vibe-ai-titlebar-pill-label'));
		label.textContent = localize('vibeAI.openAgentsWindow', "Agents");

		this._register(DOM.addDisposableListener(container, DOM.EventType.CLICK, () => {
			this.actionRunner?.run(this.action);
		}));
		this._register(DOM.addDisposableListener(container, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				this.actionRunner?.run(this.action);
			}
		}));
	}
}

class VibeAITitleBarPillContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAITitleBarPill';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			VibeAIOpenAgentsWindowAction.ID,
			(action, options) => instantiationService.createInstance(VibeAITitleBarPill, action, options),
			undefined,
		));
	}
}

registerWorkbenchContribution2(VibeAITitleBarPillContribution.ID, VibeAITitleBarPillContribution, WorkbenchPhase.BlockRestore);

// ==================== Settings ====================

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeAI',
	title: 'VibeAI',
	type: 'object',
	properties: {
		'vibeAI.inlineCompletion.enabled': {
			type: 'boolean',
			default: true,
			markdownDescription: localize('vibeAI.inlineCompletion.enabled', "Enable Cursor-style Tab completion (ghost text) provided by the local VibeCoding backend."),
		},
		'vibeAI.chat.model': {
			type: 'string',
			default: '',
			markdownDescription: localize('vibeAI.chat.model', "Model requested by the VibeAI chat (empty = backend default). Settable from the chat input's model dropdown."),
		},
		'vibeAI.chat.autoMode': {
			type: 'string',
			enum: ['cost', 'balance', 'intelligence'],
			enumDescriptions: [
				localize('vibeAI.chat.autoMode.cost', "Prefer the fastest cheap models for every turn."),
				localize('vibeAI.chat.autoMode.balance', "Balance cost and capability (default)."),
				localize('vibeAI.chat.autoMode.intelligence', "Prefer the most capable models."),
			],
			default: 'balance',
			markdownDescription: localize('vibeAI.chat.autoMode', "Optimize For bias of the Auto model router (Cursor Router parity): how it trades cost against capability when picking a model from the Settings → Models pool per message. Settable from the chat input's model dropdown."),
		},
		'vibeAI.chat.autoReveal': {
			type: 'boolean',
			default: true,
			markdownDescription: localize('vibeAI.chat.autoReveal', "Show which model the Auto router picked for each turn (Cursor-parity underlying-model display; on by default in this fork for single-machine debugging)."),
		},
		// Phase 139: terminal permission control (Cursor parity) — when the
		// agent's terminal commands need approval. The chat pane reads it
		// live per turn and forwards it as the request's permission_mode;
		// the backend falls back to its own default when absent.
		'vibeAI.agent.permissionMode': {
			type: 'string',
			enum: ['review_all', 'high_risk', 'trusted'],
			enumDescriptions: [
				localize('vibeAI.agent.permissionMode.reviewAll', "Ask before every terminal command the agent runs."),
				localize('vibeAI.agent.permissionMode.highRisk', "Run the terminal whitelist automatically; everything else asks (default)."),
				localize('vibeAI.agent.permissionMode.trusted', "Run every terminal command automatically except deny-listed high-risk ones."),
			],
			default: 'high_risk',
			markdownDescription: localize('vibeAI.agent.permissionMode', "Terminal permission control for the VibeAI agent (Cursor parity): when the agent's terminal commands need your approval. Settable from the Settings → General page."),
		},
	},
});