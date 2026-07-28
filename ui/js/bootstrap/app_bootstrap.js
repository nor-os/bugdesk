/**
 * App Bootstrap (js_new)
 *
 * Purpose
 * -------
 * Central entry point that composes the event bus, logging, data manager, UI controllers,
 * and workspace lifecycle services for the notebook-based architecture.
 *
 * Responsibilities
 * - Instantiate core services (event bus, logging/state machine helpers).
 * - Create the data manager singleton and inject it into workspace/UI layers.
 * - Wire host integrations (pywebview bridge, window chrome events) deterministically without DOM probing.
 * - Emit `app:ready` / `app:hydrated` events once subsystems report readiness.
 */

import { getSetting, registerSettingsEventBus } from '../core/settings.js';

import { EventBus } from '../core/event_bus.js';
import { LoggingService } from '../core/logging.js';
import { StateGuardService } from '../core/state_guard.js';
import { DEFAULT_STATE_GUARD_CONFIG } from '../core/state_guard_config.js';
import { DataManager } from '../data/data_manager.js';
import { DataHubService } from '../data/data_hub.js';
import { WorkspaceStateMachine } from '../workspace/workspace_state_machine.js';
import { WorkspaceImportController } from '../workspace/import_controller.js';
import { WorkspaceSaveController } from '../workspace/save_controller.js';
import { getRecentFiles, addRecentFile, removeRecentFile, clearRecentFiles } from '../workspace/recent_files.js';
import { getRecentProjects, clearRecentProjects } from '../data/recent_projects.js';
import {
    openProjectFromFolderPicker as eaOpenProject,
    openProjectByPath as eaOpenProjectByPath,
    newProjectDialog as eaNewProject,
    closeCurrentProject as eaCloseProject,
} from '../ecoagent/project_selector.js';
import { HistoryService } from '../workspace/history_service.js';
import { installUndoRedoBridge } from '../workspace/undo_redo_bridge.js';
import { ExpressionServices } from '../utils/expression_services.js';
import { SymbolRegistry } from '../utils/symbol_registry.js';
import { getModuleRegistry } from '../utils/module_registry.js';
import { loadUserModules } from '../utils/module_loader.js';
import { NotificationCenter } from '../ui/notification_center.js';
import { NotificationHistory } from '../ui/components/notification_history.js';
import { resetTableStore } from '../ui/components/table_state_store.js';
import { HelpModal } from '../help/help_modal.js';
import { NotebookPage } from '../ui/pages/notebook/notebook_page.js';
import { ProjectModel } from '../data/project_model.js';
import { DataPage } from '../ui/pages/data_page.js';
import { CalibrationPage } from '../ui/pages/calibration_page.js';
import { PaperPage } from '../ui/pages/paper/paper_page.js';
import { openCalibrationModal } from '../ui/components/calibration_modal.js';
import { openPolicyDesigner } from '../ui/pages/policy_designer/policy_designer_window.js';
import { openModuleEditorWindow } from '../ui/components/module_editor_window.js';
import { openModelCodeWindow } from '../ui/components/model_code_window.js';
import { showAboutDialog } from '../ui/components/about_dialog.js';
import { SimulationErrorHandler } from '../simulation/error_handler.js';
import { getStreamingClient } from '../simulation/streaming_client.js';
import { ApplicationShell } from '../ui/shell/application_shell.js';
import { WindowChromeController } from '../ui/controllers/window_chrome_controller.js';
import { loadEtlPlugins } from '../etl/etl_plugin_registry.js';
import { LOGGING_LEVEL_OVERRIDES, mergeLoggingLevels } from '../config/logging_levels.js';
import '../ui/components/inline_renamer.js';
// Tooltip service - initializes on import, sets up window.LatexTooltip
import '../ui/utils/tooltip_service.js';
// Results tile dashboard - auto-registers on import
import '../results/index.js';
import { GlobalSearchService } from '../search/global_search_service.js';
import { GlobalSearchController } from '../search/global_search_controller.js';
import { AiChatController } from '../ai/ai_chat_controller.js';

import {
    DEFAULT_AUTOSAVE_KEY,
    DEFAULT_HOST_TIMEOUT_MS,
    resolveHostBridge,
    setupHostBridgeListener,
    createPersistenceAdapter,
} from './host_bridge_helpers.js';

const APP_EVENTS = Object.freeze({
    INITIALIZING: 'app:initializing',
    READY: 'app:ready',
    HYDRATED: 'app:hydrated',
    DESTROYED: 'app:destroyed',
});

// LocalStorage key for remembering last active page
const ACTIVE_PAGE_STORAGE_KEY = 'ecosim.ui.activePage';

const extractFileName = (path) => path.split(/[\\/]/).pop() || path;

/**
 * Get the stored active page from localStorage.
 * @returns {string|null} Stored page key or null if not available
 */
function getStoredActivePage() {
    try {
        return localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY);
    } catch (e) {
        // localStorage may be unavailable (private browsing, etc.)
        return null;
    }
}

const PAGE_KEYS = Object.freeze({
    NOTEBOOK: 'notebook',
    PAPER: 'paper',
    DATA: 'data',
    CALIBRATION: 'calibration',
});

const DEFAULT_MOUNT_CLASSES = Object.freeze({
    data: 'ecosim-data',
    notifications: 'ecosim-notifications',
});

const VALID_PAGE_KEYS = new Set(Object.values(PAGE_KEYS));
const PAGE_LABELS = Object.freeze({
    [PAGE_KEYS.NOTEBOOK]: 'Notebook',
    [PAGE_KEYS.PAPER]: 'Paper',
    [PAGE_KEYS.DATA]: 'Data',
    [PAGE_KEYS.CALIBRATION]: 'Calibration',
});

export async function bootstrapApplication(options = {}) {
    assertDomEnvironment('bootstrapApplication');

    const config = normalizeOptions(options);

    const root = resolveRootElement(config.root);
    // Create event bus - use provided, or window.eventManager if exists, or create new
    const eventBus = config.eventBus ?? window.eventManager ?? new EventBus();
    // Expose globally for components that need it
    if (!window.eventManager) {
        window.eventManager = eventBus;
    }
    // Register EventBus with settings module for change notifications
    registerSettingsEventBus(eventBus);

    const loggingService = config.loggingService ?? new LoggingService({
        name: config.loggingName,
        eventBus,
        enableConsole: config.enableConsoleLogging,
        // Keep debug logs visible when debug mode is on so series/header diagnostics show up
        minLevel: config.loggingLevel,
        namespaceLevels: config.namespaceLoggingLevels,
    });
    const log = loggingService.scoped('bootstrap');

    const stateGuard = config.stateGuard ?? new StateGuardService({
        eventBus,
        logger: loggingService.scoped('state-guard'),
        config: config.stateGuardConfig ?? DEFAULT_STATE_GUARD_CONFIG,
    });

    // Expose stateGuard globally for components that need to bypass it for DOM identification attributes
    window.stateGuard = stateGuard;

    eventBus.emit(APP_EVENTS.INITIALIZING, { timestamp: Date.now() });

    const hostBridge = await resolveHostBridge({
        provided: config.hostBridge,
        waitForReady: config.waitForHostBridge,
        timeoutMs: config.hostBridgeTimeoutMs,
        logger: loggingService.scoped('host-bridge'),
    });
    const hostBridgeRef = { current: hostBridge };

    const dataManager = config.dataManager ?? new DataManager({
        eventBus,
        logger: loggingService.scoped('data-manager'),
    });

    // Builtins are synced from backend via SymbolRegistry.linkExpressionServices()
    const expressionServices = config.expressionServices ?? new ExpressionServices({
        dataManager,
        logger: loggingService.scoped('expression-services'),
    });

    // Module registry for user-defined functions
    const moduleRegistry = getModuleRegistry({
        dataManager,
        logger: loggingService.scoped('module-registry'),
    });

    // Load project modules from DataManager into registry (for global search to work immediately)
    if (dataManager?.listModules) {
        try {
            const modules = dataManager.listModules() || [];
            if (modules.length > 0) {
                const modulesData = modules.map((mod) => ({
                    name: mod.name,
                    description: mod.description,
                    functions: (mod.functions || []).map((fn) => ({
                        name: fn.name,
                        params: fn.params || [],
                        outputs: fn.outputs || [],
                        expression: fn.expression || '',
                        description: fn.description,
                        paramDescriptions: fn.paramDescriptions || null,
                        outputDescriptions: fn.outputDescriptions || null,
                    })),
                    exports: mod.exports,
                    inputs: mod.inputs ?? null,
                    outputs: mod.outputs ?? null,
                }));
                moduleRegistry.loadProjectModules(modulesData);
                loggingService.info('bootstrap', `Loaded ${modules.length} project modules into registry`);
            }
        } catch (err) {
            loggingService.warn('bootstrap', 'Failed to load project modules during bootstrap', err);
        }
    }

    // Symbol registry - unified DSL symbol lookup
    const symbolRegistry = new SymbolRegistry({
        dataManager,
        moduleRegistry,
        eventBus,
        logger: loggingService.scoped('symbol-registry'),
    });

    // Link ExpressionServices to receive builtin updates from SymbolRegistry
    // Note: Sync from backend happens in attachHostBridge when Python bridge is available
    symbolRegistry.linkExpressionServices(expressionServices);

    // Link ModuleRegistry to ExpressionServices for module function autocomplete
    expressionServices.setModuleRegistry(moduleRegistry);

    const dataHub = config.dataHub ?? new DataHubService({
        eventBus,
        logger: loggingService.scoped('data-hub'),
        hostBridge: hostBridgeRef.current ?? undefined,
    });

    const isEditableTarget = (el) => {
        if (!el) return false;
        return Boolean(el.closest?.('input, textarea, select, [contenteditable="true"]'));
    };

    // App-level undo/redo → backend file-journal. Subscribes to
    // `ecoagent:history:undo`/`redo` on the bus; the Ctrl+Z handler below and the
    // Edit-menu action handler (different scope) both emit those events.
    installUndoRedoBridge({
        eventBus,
        logger: loggingService.scoped('undo-redo'),
    });

    const handleGlobalKeydown = (event) => {
        if (!event) return;
        if (event.defaultPrevented) return;
        const key = (event.key || '').toLowerCase();
        const hasModifier = event.ctrlKey || event.metaKey;
        if (!hasModifier) return;
        if (isEditableTarget(event.target)) return;

        if (key === 'z') {
            event.preventDefault();
            eventBus.emit(event.shiftKey ? 'ecoagent:history:redo' : 'ecoagent:history:undo');
        } else if (key === 'y') {
            event.preventDefault();
            eventBus.emit('ecoagent:history:redo');
        }
    };

    document.addEventListener('keydown', handleGlobalKeydown, true);

    const workspaceStateMachine = config.workspaceStateMachine ?? new WorkspaceStateMachine({
        eventBus,
        logger: loggingService.scoped('workspace-sm'),
    });

    const workspaceImportController = config.workspaceImportController ?? new WorkspaceImportController({
        dataManager,
        stateMachine: workspaceStateMachine,
        hostBridgeRef,
        eventBus,
        logger: loggingService.scoped('workspace-import'),
    });

    const persistenceAdapter = config.persistenceAdapter ?? createPersistenceAdapter({
        hostBridgeRef,
        storageKey: config.autosaveStorageKey,
        logger: loggingService.scoped('workspace-save'),
    });

    const workspaceSaveController = config.workspaceSaveController ?? new WorkspaceSaveController({
        dataManager,
        persistenceAdapter,
        eventBus,
        logger: loggingService.scoped('workspace-save'),
        autosaveIntervalMs: config.autosaveIntervalMs,
        debounceMs: config.autosaveDebounceMs,
        autoStart: config.autosaveEnabled,
    });

    const notificationCenter = config.notificationCenter ?? new NotificationCenter({
        eventBus,
        logger: loggingService.scoped('notifications'),
    });

    // Expose notificationCenter globally for components created outside app_bootstrap
    // (e.g., FunctionsPage created in ApplicationShell)
    window.NotificationCenter = notificationCenter;

    // IMPORTANT: Initialize ApplicationShell FIRST - it clears body and rebuilds DOM
    // All mounts must be resolved AFTER shell initialization
    const applicationShell = new ApplicationShell({
        root,
        eventBus,
        logger: loggingService.scoped('app-shell'),
        dataManager,
        onNavigate: null, // Will be set after pageRegistry is created
        pageLabels: PAGE_LABELS,
    });
    applicationShell.initialize({
        mounts: {}, // Will be updated after pages are mounted
        initialPage: config.initialPage,
        pages: [],
    });

    // Now resolve mounts from shell-created DOM elements
    const mounts = resolveShellMounts(config.mounts);
    if (mounts.notifications) {
        notificationCenter.mount(mounts.notifications);
    }

    const notificationHistory = new NotificationHistory({
        notificationCenter,
        eventBus,
        logger: loggingService.scoped('notification-history'),
    });
    notificationHistory.mount();

    const sharedPageDeps = {
        eventBus,
        dataManager,
        notificationCenter,
    };

    const dataPage = new DataPage({
        ...sharedPageDeps,
        logger: loggingService.scoped('page-data'),
        dataHub,
        sidebarContainer: document.getElementById('fixed-200-data'),
    });

    // Shared ProjectModel — used by both NotebookPage and SimulationRunPage
    const projectModel = new ProjectModel({
        eventBus,
        logger: loggingService.scoped('project-model'),
    });

    // Initialize WebSocket streaming client for real-time run/batch events.
    // It re-dispatches each frame to window.__ecoagentPush — the live run
    // transport (see streaming_client.js).
    try {
        const wsPort = (() => {
            const p = parseInt(new URLSearchParams(window.location.search).get('wsPort'), 10);
            return (p > 0 && p < 65536) ? p : 23988;
        })();
        const streamingClient = getStreamingClient({ eventBus, port: wsPort });
        streamingClient.connect();
        loggingService.scoped('bootstrap')?.info?.('Streaming client initialized');
    } catch (err) {
        console.error('[Bootstrap] Streaming client init failed:', err);
        loggingService.scoped('bootstrap')?.warn?.('Failed to initialize streaming client', { err });
    }

    // Notebook page mounts into #notebook-main (shell's .panel.left slot for notebook mode).
    // File navigator mounts into #fixed-200-notebook (shell's sidebar slot for notebook mode).
    // Both containers are created by ApplicationShell. Mount is deferred to first navigation
    // so Monaco does not load at startup.
    const notebookPage = new NotebookPage({
        ...sharedPageDeps,
        logger: loggingService.scoped('page-notebook'),
        project: projectModel,
    });
    // Do NOT call notebookPage.mount() here — deferred to first navigation below.

    const paperPage = new PaperPage({
        ...sharedPageDeps,
        logger: loggingService.scoped('page-paper'),
        project: projectModel,
    });

    // Batch progress UI is owned solely by the BatchWorkersWindow
    // (ui/js/ecoagent/ui/batch_workers_window.js), installed via the tiling
    // install step. It listens directly to the `ecoagent:batch:*` bus events
    // and is opened synchronously from the Run click. The old
    // BatchProgressTracker (an EcoSim-imported toast + modal that consumed a
    // separate `streaming:batch-progress` contract) was a SECOND, redundant
    // owner of the same events — it produced a duplicate progress window plus
    // a mangled modal. Removed so there is exactly one batch surface.

    // Clear dataHub series cache when a run completes to ensure fresh data.
    // (Was wired to the dead `streaming:complete`; the live run-complete
    // signal is `ecoagent:run:completed` over the WebSocket.)
    eventBus.on('ecoagent:run:completed', () => {
        dataHub.clearSeriesCache();
    });

    // Sync modules from DataManager to moduleRegistry and refresh config panel
    eventBus.on('modules:registry:changed', () => {
        // Re-sync project modules so linter, function nodes, and DSL generator see them
        try {
            const modules = dataManager.listModules() || [];
            moduleRegistry.loadProjectModules(modules);
        } catch (err) {
            loggingService.warn('bootstrap', 'Failed to sync project modules on registry change', err);
        }
    });

    // Simulation Error Handler - translates backend errors to user-friendly messages and auto-selects nodes
    const simulationErrorHandler = new SimulationErrorHandler({
        eventBus,
        notificationCenter,
        logger: loggingService.scoped('simulation-error'),
    });

    const calibrationPage = new CalibrationPage({
        ...sharedPageDeps,
        logger: loggingService.scoped('page-calibration'),
        hostBridge: hostBridgeRef.current ?? undefined,
        dataHub,
        project: projectModel,
    });

    const disposers = [];

    registerPage(dataPage, mounts.data, PAGE_KEYS.DATA, { log });

    const pageRegistry = createPageRegistry({
        eventBus,
        log: loggingService.scoped('pages'),
    });
    pageRegistry.add(PAGE_KEYS.NOTEBOOK, notebookPage, mounts.notebookMain);
    pageRegistry.add(PAGE_KEYS.PAPER, paperPage, mounts.paperMain);
    pageRegistry.add(PAGE_KEYS.DATA, dataPage, mounts.data);

    // Wire up navigation callback now that pageRegistry exists.
    // Notebook page is mounted lazily on first navigation so Monaco does not load at startup.
    let notebookMounted = false;
    let paperMounted = false;
    applicationShell.onNavigate = (pageKey) => {
        if (pageKey === PAGE_KEYS.NOTEBOOK && !notebookMounted) {
            notebookPage.mount(mounts.notebookMain, {
                fileNavContainer: mounts.notebookFileNav,
            });
            notebookMounted = true;
        }
        if (pageKey === PAGE_KEYS.PAPER && !paperMounted) {
            paperPage.mount(mounts.paperMain, {
                tocContainer: mounts.paperToc,
            });
            paperMounted = true;
        }
        pageRegistry.activate(pageKey);
    };
    // Pass dataHub, expressionServices so shell can lazy-init ScenarioManagerPage
    applicationShell.dataHub = dataHub;
    applicationShell.expressionServices = expressionServices;
    // Pass PaperPage instance for lazy mounting by shell
    applicationShell.paperPage = paperPage;
    // Pass ProjectModel so ETLManagerPage can persist project pipelines
    applicationShell.projectModel = projectModel;

    // Wire the analysis-tool buttons + toolbar inputs in the top bar.
    applicationShell._wireSimulationControlButtons();

    // Mount notebook page eagerly if it's the initial page, so that
    // pageRegistry.activate → onActivated → show() has a fully built layout.
    // (onNavigate only fires from toolbar clicks, not from pageRegistry.activate)
    if (config.initialPage === PAGE_KEYS.NOTEBOOK && !notebookMounted) {
        notebookPage.mount(mounts.notebookMain, {
            fileNavContainer: mounts.notebookFileNav,
        });
        notebookMounted = true;
    }

    pageRegistry.activate(config.initialPage);

    const updateRecentMenu = async () => {
        // EcoAgent's File menu surfaces projects only — workspace.json
        // recents are no longer wired through this menu (the Ecosim
        // save/open workspace flow doesn't apply to EcoAgent projects).
        // Prefer the bridge's authoritative list when available, falling
        // back to the localStorage mirror.
        let recents;
        try {
            recents = await window.pywebview?.api?.projects_recent?.();
        } catch { /* fall through to local copy */ }
        if (!Array.isArray(recents) || recents.length === 0) {
            recents = getRecentProjects();
        }
        applicationShell.updateRecentFilesMenu(recents.map((r) => ({
            path: r.path,
            name: r.name,
        })));
    };

    const menuDisposer = setupMenuActions({
        applicationShell,
        eventBus,
        workspaceSaveController,
        workspaceImportController,
        dataPage,
        calibrationPage,
        dataManager,
        projectModel,
        hostBridgeRef,
        updateRecentMenu,
        log: loggingService.scoped('menu'),
    });
    if (menuDisposer) {
        disposers.push(menuDisposer);
    }

    // Handle calibration window open requests (uses ManagedWindow)
    eventBus.on('tools:calibration:open', (payload) => {
        openCalibrationModal({ calibrationPage, eventBus, prePopulate: payload?.prePopulate });
    });

    // Handle policy designer window open requests
    eventBus.on('tools:policy-designer:open', () => {
        openPolicyDesigner({
            eventBus,
            project: projectModel,
            notificationCenter,
            dataManager,
        });
    });

    // ── Analysis tools (steady state, bifurcation, impulse response, loop analysis) ──
    // These were previously in the dead SimulationTopBarController; now wired here
    // using the notebook page's symbol index + DSL sync.
    wireAnalysisToolEvents({ eventBus, notebookPage });

    const historyService = new HistoryService({
        eventBus,
        dataManager,
        logger: loggingService.scoped('history'),
    });
    historyService.start();

    // Wire workspace import - reload project modules into registry after workspace load
    // This ensures modules saved in the workspace file are available in the ModuleRegistry
    eventBus.on('workspace:import:registries-loaded', () => {
        try {
            const modules = dataManager.listModules() || [];
            if (modules.length > 0) {
                const modulesData = modules.map((mod) => ({
                    name: mod.name,
                    description: mod.description,
                    functions: (mod.functions || []).map((fn) => ({
                        name: fn.name,
                        params: fn.params || [],
                        outputs: fn.outputs || [],
                        expression: fn.expression || '',
                        description: fn.description,
                        paramDescriptions: fn.paramDescriptions || null,
                        outputDescriptions: fn.outputDescriptions || null,
                    })),
                    exports: mod.exports,
                    inputs: mod.inputs ?? null,
                    outputs: mod.outputs ?? null,
                }));
                moduleRegistry.loadProjectModules(modulesData);
                log?.info?.('workspace-hydrate', `Reloaded ${modules.length} project modules into registry`);
            }
        } catch (err) {
            log?.warn?.('Failed to reload project modules after import', err);
        }
    });

    // Wire workspace import - node hydration complete event
    eventBus.on('workspace:import:nodes-hydrated', ({ nodeCount }) => {
        log?.info?.('workspace-hydrate', 'Nodes hydrated (rendering deferred to namespace selection)', { nodeCount });
    });

    // ===== Namespace/Tab Management =====
    // Handle namespace creation (add tab button)
    eventBus.on('tabs:namespace:add-requested', () => {
        log?.info?.('namespace', 'Creating new namespace from tab add request');

        // Generate next tab index based on existing namespaces
        const existingNamespaces = dataManager.listNamespaces();
        const nextIndex = existingNamespaces.length + 1;

        const newNamespaceId = generateUUID();
        const newNamespace = {
            id: newNamespaceId,
            displayName: `Tab_${nextIndex}`,
            tabIndex: nextIndex,
            color: null,
            isLocked: false,
            isArchived: false,
        };

        // Register in data manager (triggers data:namespaces:added which re-renders tabs)
        dataManager.upsertNamespace(newNamespace);

        // Emit selection event to activate the new tab
        eventBus.emit('tabs:namespace:selected', { namespaceId: newNamespaceId, source: 'bootstrap' });

        log?.info?.('namespace', 'New namespace created', { newNamespaceId, displayName: newNamespace.displayName });
    });

    // Handle namespace selection (tab click)
    eventBus.on('tabs:namespace:selected', ({ namespaceId, source }) => {
        if (!namespaceId) return;
        log?.debug?.('namespace', 'Namespace selected', { namespaceId });

        // Persist last active namespace for restore
        if (!source || source === 'bootstrap' || source === 'tab-controller') {
            try {
                window?.localStorage?.setItem('ecosim.activeNamespace', namespaceId);
            } catch (_) {
                /* ignore */
            }
        }
    });

    // Handle namespace close (tab close)
    eventBus.on('tabs:namespace:close-requested', ({ namespaceId }) => {
        if (!namespaceId) return;

        dataManager.removeNamespace(namespaceId);

        // Pick next active namespace if any remain; otherwise welcome screen shows
        const remaining = dataManager.listNamespaces().slice().sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0));
        const next = remaining[0];
        if (next) {
            eventBus.emit('tabs:namespace:selected', { namespaceId: next.id });
        }
    });

    // Prevent browser context menu app-wide (except in inputs/textareas and selectable text)
    document.addEventListener('contextmenu', (e) => {
        const target = e.target;
        const tagName = target?.tagName?.toLowerCase();
        // Allow context menu on input fields and textareas for native copy/paste
        if (tagName === 'input' || tagName === 'textarea') {
            return;
        }
        // Allow context menu on elements with user-select: text (e.g. ai chat messages)
        if (target?.closest('.ai-chat__messages')) {
            return;
        }
        // Prevent default browser context menu everywhere else
        e.preventDefault();
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Don't handle shortcuts when typing in inputs/textareas
        const target = e.target;
        const tagName = target?.tagName?.toLowerCase();
        const isEditing = tagName === 'input' || tagName === 'textarea' || target?.isContentEditable;

        // Suppress native find overlays. Ctrl/Cmd+F is the advertised
        // "Find" shortcut (see the Edit menu) — route it to the command
        // palette instead of the browser's in-page find. F3 just gets
        // swallowed.
        if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F'))) {
            e.preventDefault();
            if (e.key === 'f' || e.key === 'F') {
                window.__twm?.palette?.open?.();
            }
            return;
        }

        // Ctrl+Shift+N - New Window (global, works even when editing)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
            e.preventDefault();
            window.pywebview?.api?.window_spawn_new?.();
            return;
        }

        // Escape
        if (e.key === 'Escape') {
            return;
        }

        // Skip other shortcuts if editing
        if (isEditing) {
            return;
        }
    });

    // Keep shell mode in sync with page activation so fixed-200 shows correct content
    eventBus.on('view:page:activated', ({ page }) => {
        if (!applicationShell?.setMode) return;
        if (page === PAGE_KEYS.DATA) {
            applicationShell.setMode('database');
        }
    });

    // Keep page activation in sync when shell mode changes (toolbar clicks)
    eventBus.on('shell:mode-changed', ({ mode }) => {
        let target = null;
        if (mode === 'database') target = PAGE_KEYS.DATA;

        if (target && pageRegistry.getActive?.() !== target) {
            try {
                pageRegistry.activate(target, { source: 'shell' });
            } catch (error) {
                log?.warn?.('Failed to sync shell mode to page', { error, mode, target });
            }
        }
    });

    // Generic page navigation event (used by SimulationSettingsTab "View in Data page", etc.)
    eventBus.on('app:navigate', ({ page, context }) => {
        const key = normalizePageKey(page);
        if (!key) return;
        // Data page requires shell mode switch
        if (key === PAGE_KEYS.DATA) {
            applicationShell.setMode('database');
        }
        if (pageRegistry.getActive?.() !== key) {
            pageRegistry.activate(key, context);
        }
    });

    // Switch to simulation-run mode when a project is opened
    eventBus.on('project:opened', async () => {
        applicationShell.setMode('simulation-run');
        updateRecentMenu();
        // Drop cached DataTable view-state so the next project loads its
        // own persisted sort/filters/column-widths, not the old one's.
        resetTableStore();

        // Clear stale ETL pipelines from previous workspace snapshot, then
        // load project ETL files (.orchestration + .pipeline) into DataManager.
        for (const dto of dataManager.listEtlPipelines()) {
            dataManager.removeEtlPipeline(dto.id);
        }
        const etlPaths = [
            ...projectModel.orchestrationPaths,
            ...projectModel.pipelinePaths,
        ];
        if (etlPaths.length > 0) {
            const api = window.pywebview?.api;
            for (const filePath of etlPaths) {
                try {
                    const result = await api.project_read_file({
                        projectPath: projectModel.projectPath,
                        filePath,
                    });
                    if (!result?.ok) continue;
                    const data = typeof result.content === 'string'
                        ? JSON.parse(result.content) : result.content;
                    // Tag with project file path so ETL page can save back
                    data._filePath = filePath;
                    dataManager.upsertEtlPipeline(data);
                } catch (err) {
                    log?.warn?.(`Failed to load ETL file ${filePath}`, err);
                }
            }
        }

        // Clear stale calibration configs from previous workspace/project,
        // then load this project's .calibration files (if any).
        dataManager.calibrationConfigs = [];
        const calibrationPaths = projectModel.calibrationPaths;
        if (calibrationPaths.length > 0) {
            const calibConfigs = [];
            const api = window.pywebview?.api;
            for (const filePath of calibrationPaths) {
                try {
                    const result = await api.project_read_file({
                        projectPath: projectModel.projectPath,
                        filePath,
                    });
                    if (!result?.ok) continue;
                    const data = typeof result.content === 'string'
                        ? JSON.parse(result.content) : result.content;
                    calibConfigs.push(data);
                } catch (err) {
                    log?.warn?.(`Failed to load calibration file ${filePath}`, err);
                }
            }
            if (calibConfigs.length > 0) {
                dataManager.calibrationConfigs = calibConfigs;
            }
        }
    });

    // Restore the last project early so that every page — including ones that
    // don't call restoreLastProject themselves (e.g. Paper) — starts with the
    // project already open.  Must come AFTER the project:opened handler above
    // so that setMode('simulation-run') and ETL/calibration loading fire.
    if (!projectModel.isOpen) {
        await projectModel.restoreLastProject();
    }

    // Mount data page into main data-page container and render sidebar into fixed-200
    const dataPageContainer = document.getElementById('data-page');
    const dataSidebarHost = document.getElementById('fixed-200-data');
    if (dataSidebarHost) {
        // Ensure sidebar renders into the fixed-200 rail (not inside main content)
        dataPage.sidebarHost = dataSidebarHost;
    }
    if (dataPageContainer) {
        try {
            dataPage.mount(dataPageContainer);
            dataPage.hydrate();
            window.DataPage = dataPage;
        } catch (error) {
            log?.error?.('Failed to mount data page', { error });
        }
    }

    // Initialize window chrome (resize handles, window buttons, drag)
    const windowChromeController = new WindowChromeController({
        eventBus,
        logger: loggingService.scoped('window-chrome'),
    });
    windowChromeController.initialize();

    // Initialize global search - queries project model and symbol index
    // symbolIndex is a lazy getter because NotebookPage.mount() is deferred
    const globalSearchService = new GlobalSearchService({
        projectModel,
        symbolIndex: { get symbols() { return notebookPage.symbolIndex?.symbols || []; } },
        logger: loggingService.scoped('global-search'),
    });

    // Invalidate scenario cache when project or scenario files change
    const invalidateScenarios = () => globalSearchService.invalidateScenarioCache();
    eventBus.on('project:opened', invalidateScenarios);
    eventBus.on('project:file:created', invalidateScenarios);
    eventBus.on('project:file:deleted', invalidateScenarios);
    eventBus.on('project:file:renamed', invalidateScenarios);
    eventBus.on('project:file:saved', (e) => {
        if (e?.filePath?.endsWith('.scenario')) invalidateScenarios();
    });

    const globalSearchController = new GlobalSearchController({
        eventBus,
        searchService: globalSearchService,
        logger: loggingService.scoped('global-search-ui'),
    });

    // Mount global search to bar-center in top bar
    const barCenter = document.querySelector('.global-top-bar .bar-center');
    if (barCenter) {
        globalSearchController.mount(barCenter);
    } else {
        console.warn('[Bootstrap] Could not find .global-top-bar .bar-center for global search');
    }

    const hostBridgeDisposer = setupHostBridgeListener({
        hostBridgeRef,
        onResolved: (bridge) => attachHostBridge({
            bridge,
            hostBridgeRef,
            dataHub,
            dataPage,
            notificationCenter,
            log: loggingService.scoped('host-bridge'),
            symbolRegistry,
            eventBus,
            dataManager,
            applicationShell,
        }),
        logger: loggingService.scoped('host-bridge'),
    });
    if (hostBridgeDisposer) {
        disposers.push(hostBridgeDisposer);
    }

    if (hostBridgeRef.current) {
        await attachHostBridge({
            bridge: hostBridgeRef.current,
            hostBridgeRef,
            dataHub,
            dataPage,
            notificationCenter,
            log: loggingService.scoped('host-bridge'),
            symbolRegistry,
            eventBus,
            dataManager,
            applicationShell,
        });
    }

    // AI Chat Controller
    const aiChatController = new AiChatController({
        eventBus,
        projectModel,
        historyService,
        logger: loggingService.scoped('ai-chat'),
    });
    aiChatController.initialize();

    // Load ETL plugin definitions from backend and auto-generate config panels
    await loadEtlPlugins({ logger: loggingService.scoped('etl-plugins') });

    eventBus.emit(APP_EVENTS.READY, {
        pages: pageRegistry.list(),
        timestamp: Date.now(),
    });

    await hydrateInitialWorkspace({
        workspaceImportController,
        config,
        dataPage,
        calibrationPage,
        eventBus,
        log,
        dataManager,
        persistenceAdapter,
        hostBridgeRef,
        projectModel,
    });

    const runtime = {
        eventBus,
        loggingService,
        dataManager,
        moduleRegistry,
        symbolRegistry,
        dataHub,
        expressionServices,
        stateGuard,
        notificationCenter,
        workspaceStateMachine,
        workspaceImportController,
        workspaceSaveController,
        windowChromeController,
        globalSearchService,
        globalSearchController,
        aiChatController,
        pages: Object.freeze({
            [PAGE_KEYS.DATA]: dataPage,
            [PAGE_KEYS.CALIBRATION]: calibrationPage,
        }),
        shell: applicationShell,
        mounts,
        setActivePage: (key, context) => pageRegistry.activate(key, context),
        getActivePage: () => pageRegistry.getActive(),
        hydrateWorkspace: (source) => hydrateWorkspace({
            workspaceImportController,
            source,
            dataPage,
            calibrationPage,
            eventBus,
            log,
            hostBridgeRef,
            dataManager,
            projectModel,
        }),
        setHostBridge: (bridge) => {
            return attachHostBridge({
                bridge,
                hostBridgeRef,
                dataHub,
                dataPage,
                notificationCenter,
                log: loggingService.scoped('host-bridge'),
                symbolRegistry,
                eventBus,
                dataManager,
                applicationShell,
            });
        },
        destroy: () => {
            disposers.forEach((dispose) => {
                try {
                    dispose?.();
                } catch (error) {
                    log.warn('Disposer failed', { error });
                }
            });
            workspaceSaveController?.dispose?.();
            notificationCenter?.dispose?.();
            dataPage?.dispose?.();
            simulationErrorHandler?.dispose?.();
            windowChromeController?.dispose?.();
            globalSearchController?.dispose?.();
            applicationShell?.dispose?.();
            eventBus.emit(APP_EVENTS.DESTROYED, { timestamp: Date.now() });
        },
    };

    if (typeof window !== 'undefined') {
        window.__ECOSIM_JS_NEW__ = runtime;
        // Provide legacy-compatible event bus alias for utilities
        window.eventManager = window.eventManager || eventBus;
    }

    // Expose runtime for debugging (accessible via window.__ECOSIM_RUNTIME__)
    if (typeof window !== 'undefined') {
        window.__ECOSIM_RUNTIME__ = runtime;
    }

    // Register IPC bridge for external MCP server access.
    // This provides getProjectSnapshot/applyProjectOperations independently
    // of the AI chat panel (which may not be open).
    if (typeof window !== 'undefined') {
        const { AiProjectApplier } = await import('../ai/ai_project_applier.js');
        const ipcApplier = new AiProjectApplier({
            projectModel,
            eventBus, logger: log,
        });

        window.__ecosim_ipc = {
            getProjectSnapshot() {
                try {
                    if (!projectModel?.isOpen) return null;
                    const files = {};
                    for (const f of projectModel.files || []) {
                        const openFile = projectModel.getOpenFile?.(f.path);
                        if (openFile?.content != null) {
                            files[f.path] = openFile.content;
                        }
                    }
                    return {
                        manifest: projectModel.manifest,
                        files,
                        activeFilePath: projectModel.activeFilePath,
                        projectPath: projectModel.projectPath,
                    };
                } catch (e) {
                    console.error('[IPC] Failed to serialize project:', e);
                    return null;
                }
            },
            applyProjectOperations(payload) {
                const { operations } = payload || {};
                if (!operations?.length) return;
                ipcApplier.apply(operations);
            },
        };
    }

    return runtime;
}

function setupMenuActions({
    applicationShell,
    eventBus,
    workspaceSaveController,
    workspaceImportController,
    dataPage,
    calibrationPage,
    dataManager,
    projectModel,
    hostBridgeRef = null,
    updateRecentMenu,
    log,
}) {
    if (!applicationShell || !eventBus) {
        return null;
    }

    const logger = log ?? console;
    const fileInput = document.getElementById('fileInput');

    const handleSave = async () => {
        // Get the workspace data from autosave/dataManager
        let workspacePayload = null;

        // Try to get from workspaceSaveController's dataManager first
        if (workspaceSaveController?.dataManager?.serializeWorkspace) {
            try {
                workspacePayload = workspaceSaveController.dataManager.serializeWorkspace();
            } catch (err) {
                logger?.warn?.('menu', 'Failed to serialize workspace from dataManager', err);
            }
        }

        // Fall back to autosave in localStorage
        if (!workspacePayload) {
            try {
                const autosaveKey = 'ecosim.workspace.autosave.v1';
                const raw = window.localStorage?.getItem(autosaveKey);
                if (raw) {
                    workspacePayload = JSON.parse(raw);
                }
            } catch (err) {
                logger?.warn?.('menu', 'Failed to get workspace from localStorage', err);
            }
        }

        if (!workspacePayload) {
            eventBus.emit('toast:show', {
                title: 'Save Failed',
                message: 'No workspace data available to save',
                severity: 'error',
                durationMs: 3000,
            });
            return;
        }

        // Use native save dialog via pywebview
        if (window.pywebview?.api?.save_file_dialog) {
            try {
                const json = JSON.stringify(workspacePayload, null, 2);
                const defaultFilename = 'workspace.json';
                const result = await window.pywebview.api.save_file_dialog(json, defaultFilename, 'json');

                if (result?.ok) {
                    addRecentFile(result.path, extractFileName(result.path));
                    updateRecentMenu();
                    eventBus.emit('toast:show', {
                        title: 'Workspace Saved',
                        message: `Saved to ${result.path}`,
                        severity: 'success',
                        durationMs: 2500,
                    });
                } else if (!result?.cancelled) {
                    eventBus.emit('toast:show', {
                        title: 'Save Failed',
                        message: result?.error || 'Unknown error',
                        severity: 'error',
                        durationMs: 3000,
                    });
                }
                // If cancelled, do nothing silently
            } catch (err) {
                logger?.error?.('menu', 'Save dialog failed', err);
                eventBus.emit('toast:show', {
                    title: 'Save Failed',
                    message: 'Could not open save dialog',
                    severity: 'error',
                    durationMs: 3000,
                });
            }
        } else {
            // Browser fallback - trigger download
            try {
                const json = JSON.stringify(workspacePayload, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'workspace.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                eventBus.emit('toast:show', {
                    title: 'Workspace Saved',
                    message: 'Download started',
                    severity: 'success',
                    durationMs: 2000,
                });
            } catch (err) {
                logger?.error?.('menu', 'Browser save fallback failed', err);
                eventBus.emit('toast:show', {
                    title: 'Save Failed',
                    message: 'Could not save workspace',
                    severity: 'error',
                    durationMs: 3000,
                });
            }
        }
    };

    const handleNew = async () => {
        clearWorkspacePersistedState();
        // Close the notebook project — NotebookPage reacts to project:closed
        // and shows its "No project open" empty state
        projectModel?.close?.();
        applicationShell.setMode('notebook');
    };

    const handleOpenDialog = async (path) => {
        try {
            await projectModel.open(path);
        } catch (err) {
            logger?.error?.('menu', 'Failed to open project', err);
            eventBus.emit('toast:show', {
                title: 'Open Failed',
                message: err.message,
                severity: 'error',
                durationMs: 4000,
            });
        }
    };

    const importFromFile = async (file) => {
        const json = await file.text();
        await hydrateWorkspace({
            workspaceImportController,
            source: { json, meta: { source: 'menu-open', fileName: file.name } },
            dataPage,
            calibrationPage,
            eventBus,
            log: logger,
            hostBridgeRef,
            dataManager,
            projectModel,
        });
        eventBus.emit('toast:show', {
            title: 'Workspace Loaded',
            message: `Loaded ${file.name}`,
            severity: 'success',
            durationMs: 2500,
        });
    };

    const handleOpenRecentFile = async (filePath) => {
        const result = await window.pywebview.api.read_file_by_path(filePath);
        if (result?.ok) {
            const name = extractFileName(result.path);
            addRecentFile(result.path, name);
            updateRecentMenu();
            await hydrateWorkspace({
                workspaceImportController,
                source: { json: result.content, meta: { source: 'menu-recent', fileName: name, filePath: result.path } },
                dataPage,
                calibrationPage,
                eventBus,
                log: logger,
                hostBridgeRef,
                dataManager,
                projectModel,
            });
            eventBus.emit('toast:show', {
                title: 'Workspace Loaded',
                message: `Loaded ${name}`,
                severity: 'success',
                durationMs: 2500,
            });
        } else if (result?.notFound) {
            removeRecentFile(filePath);
            updateRecentMenu();
            eventBus.emit('toast:show', {
                title: 'File Not Found',
                message: `${extractFileName(filePath)} no longer exists`,
                severity: 'warning',
                durationMs: 3000,
            });
        } else {
            eventBus.emit('toast:show', {
                title: 'Open Failed',
                message: result?.error || 'Could not read file',
                severity: 'error',
                durationMs: 3000,
            });
        }
    };

    const handleMenuAction = async (actionId) => {
        try {
            if (!actionId) {
                return;
            }
            if (actionId.startsWith('menu-file-recent:')) {
                await eaOpenProjectByPath(actionId.slice('menu-file-recent:'.length));
                return;
            }
            if (actionId.startsWith('menu-project-recent:')) {
                await eaOpenProjectByPath(actionId.slice('menu-project-recent:'.length));
                return;
            }
            if (actionId === 'menu-file-clear-recent') {
                // Local cache + the bridge's list both feed the menu;
                // clear both so the user's choice sticks across reloads.
                clearRecentFiles();
                clearRecentProjects();
                try { await window.pywebview?.api?.projects_recent_clear?.(); }
                catch { /* bridge may not implement; localStorage clear is enough */ }
                updateRecentMenu();
                return;
            }
            if (actionId === 'menu-file-open') {
                await eaOpenProject();
                return;
            }
            if (actionId === 'menu-file-new') {
                // File > New… → with an open project, pop the same
                // dropdown the project sidebar's (+) button shows
                // (sector / agent / market / flow / scenario /
                // dashboard). With no project, fall back to the
                // legacy "new project" flow.
                const current = await window.pywebview?.api?.project_current?.();
                if (!current?.path) {
                    await eaNewProject();
                    return;
                }
                try {
                    const { ProjectSidebar } = await import('../ecoagent/project_sidebar.js');
                    const btn = document.getElementById(actionId);
                    ProjectSidebar.openNewEntityMenuAt?.(btn, eventBus);
                } catch (err) {
                    logger?.warn?.('menu', 'Failed to open new-entity menu', err);
                }
                return;
            }
            if (actionId === 'menu-file-close-project') {
                await eaCloseProject();
                return;
            }
            // menu-file-reveal / menu-file-copy-path used to live in the
            // File menu but moved to the bar-left chip's popover (see
            // project_selector.js _openProjectPopover) — the popover
            // handles those actions itself, no menu wiring needed here.
            if (actionId === 'menu-file-new-window') {
                try {
                    await window.pywebview?.api?.window_spawn_new?.();
                } catch (err) {
                    logger?.error?.('menu', 'Failed to spawn new window', err);
                }
                return;
            }
            if (actionId === 'menu-file-export') {
                try {
                    const res = await projectModel.exportProject();
                    if (res) {
                        eventBus.emit('toast:show', {
                            title: 'Project Exported',
                            message: `Saved to ${res.path.split(/[\\/]/).pop()}`,
                            severity: 'success',
                            durationMs: 3000,
                        });
                    }
                } catch (err) {
                    logger?.error?.('menu', 'Export failed', err);
                    eventBus.emit('toast:show', {
                        title: 'Export Failed',
                        message: err?.message || 'Could not export project',
                        severity: 'error',
                        durationMs: 4000,
                    });
                }
                return;
            }
            if (actionId === 'menu-file-import') {
                try {
                    const manifest = await projectModel.importProject();
                    if (manifest) {
                        eventBus.emit('toast:show', {
                            title: 'Project Imported',
                            message: `Opened "${manifest.name}"`,
                            severity: 'success',
                            durationMs: 3000,
                        });
                    }
                } catch (err) {
                    logger?.error?.('menu', 'Import failed', err);
                    eventBus.emit('toast:show', {
                        title: 'Import Failed',
                        message: err?.message || 'Could not import project',
                        severity: 'error',
                        durationMs: 4000,
                    });
                }
                return;
            }
            if (actionId === 'menu-file-reset-settings') {
                try {
                    const keys = Object.keys(window.localStorage);
                    const ecosimKeys = keys.filter((k) => k.startsWith('ecosim'));
                    ecosimKeys.forEach((k) => window.localStorage.removeItem(k));
                    eventBus.emit('toast:show', {
                        title: 'Settings Reset',
                        message: `Cleared ${ecosimKeys.length} stored settings. Reloading…`,
                        severity: 'info',
                        durationMs: 2000,
                    });
                    setTimeout(() => window.location.reload(), 1500);
                } catch (err) {
                    logger?.error?.('menu', 'Failed to reset settings', err);
                    eventBus.emit('toast:show', {
                        title: 'Reset Failed',
                        message: err?.message || 'Could not clear settings',
                        severity: 'error',
                        durationMs: 3000,
                    });
                }
                return;
            }
            if (actionId === 'menu-file-exit') {
                window.pywebview?.api?.window_close?.();
                return;
            }
            if (actionId === 'menu-edit-undo') {
                eventBus.emit('ecoagent:history:undo');
                return;
            }
            if (actionId === 'menu-edit-redo') {
                eventBus.emit('ecoagent:history:redo');
                return;
            }
            if (actionId === 'menu-edit-find') {
                // "Find" surfaces the Ctrl+K command palette (entity
                // search + panel toggles). The palette is installed by
                // the tiling shell and exposed at window.__twm.palette.
                window.__twm?.palette?.open?.();
                return;
            }
            // View menu actions — delegate to toggle buttons
            if (actionId === 'menu-view-toggle-left') {
                document.getElementById('toggle-left-panel')?.click();
                return;
            }
            if (actionId === 'menu-view-toggle-right') {
                document.getElementById('toggle-right-panel')?.click();
                return;
            }
            if (actionId === 'menu-view-toggle-bottom') {
                document.getElementById('toggle-bottom-panel')?.click();
                return;
            }
            // Help menu actions
            if (actionId === 'menu-help-topics') {
                HelpModal.open();
                return;
            }
            if (actionId === 'menu-help-expressions') {
                HelpModal.open('expressions-syntax');
                return;
            }
            if (actionId === 'menu-help-nodes') {
                HelpModal.open('nodes-overview');
                return;
            }
            if (actionId === 'menu-help-shortcuts') {
                HelpModal.open('keyboard-shortcuts');
                return;
            }
            if (actionId === 'menu-help-about') {
                showAboutDialog();
                return;
            }
            // Tools menu actions
            if (actionId === 'menu-tools-steady-state') {
                eventBus.emit('tools:steady-state:open');
                return;
            }
            if (actionId === 'menu-tools-bifurcation') {
                eventBus.emit('tools:bifurcation:open');
                return;
            }
            if (actionId === 'menu-tools-impulse-response') {
                eventBus.emit('tools:impulse-response:open');
                return;
            }
            if (actionId === 'menu-tools-loop-analysis') {
                eventBus.emit('tools:loop-analysis:open');
                return;
            }
            if (actionId === 'menu-tools-calibration') {
                eventBus.emit('tools:calibration:open');
                return;
            }
            if (actionId === 'menu-tools-policy-designer') {
                eventBus.emit('tools:policy-designer:open');
                return;
            }
            if (actionId === 'menu-tools-model-tests') {
                eventBus.emit('tools:model-tests:open');
                return;
            }
            if (actionId === 'menu-tools-show-model-code') {
                openModelCodeWindow({ project: projectModel });
                return;
            }
            logger?.debug?.('menu', 'Unhandled menu action', { actionId });
        } catch (error) {
            logger?.error?.('menu', 'Menu action failed', { actionId, error });
            eventBus.emit('toast:show', {
                title: 'Menu Action Failed',
                message: error?.message || 'Request could not be completed',
                severity: 'error',
                persistent: true,
            });
        }
    };

    const busSub = eventBus.on('menu:action', ({ actionId }) => {
        // Ignore missing or duplicate payloads; ApplicationShell already emits this per click
        if (!actionId) {
            return;
        }
        handleMenuAction(actionId);
    });

    const handleFileChange = async (event) => {
        const file = event?.target?.files?.[0];
        if (!file) {
            return;
        }
        try {
            await importFromFile(file);
        } catch (error) {
            logger?.error?.('menu', 'Workspace import failed', { error, fileName: file.name });
            eventBus.emit('toast:show', {
                title: 'Import Failed',
                message: error?.message || 'Unable to import workspace',
                severity: 'error',
                persistent: true,
            });
        } finally {
            if (fileInput) {
                fileInput.value = '';
            }
        }
    };

    if (fileInput) {
        fileInput.addEventListener('change', handleFileChange);
    }

    // Populate the recent files menu on startup
    updateRecentMenu();

    return () => {
        busSub?.dispose?.();
        if (fileInput) {
            fileInput.removeEventListener('change', handleFileChange);
        }
    };
}

function buildEmptyWorkspacePayload() {
    const timestamp = Date.now();
    return {
        format: 'ecosim-workspace',
        version: 4,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: { sectors: {} },
        namespaces: [],
        stocks: [],
        variables: [],
        flows: [],
        nodes: [],
        connections: [],
    };
}

function clearWorkspacePersistedState() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }
    const keys = [
        'ecosim.workspace.autosave.v1',
        'ecosim.tabOrder',
        'ecosim.activeNamespace',
    ];
    keys.forEach((key) => {
        try {
            window.localStorage.removeItem(key);
        } catch (error) {
            console.warn('[Bootstrap] Failed to clear persisted key', { key, error });
        }
    });
}

async function hydrateInitialWorkspace({
    workspaceImportController,
    config,
    dataPage,
    calibrationPage,
    eventBus,
    log,
    dataManager,
    persistenceAdapter,
    hostBridgeRef = null,
    projectModel = null,
}) {
    let source = config.workspacePayload || config.workspaceJSON;

    // If no explicit payload, try persistence adapter (localStorage/memory fallback)
    if (!source && persistenceAdapter?.getLastSnapshot) {
        try {
            const snapshot = await persistenceAdapter.getLastSnapshot();
            if (snapshot) {
                source = snapshot;
                log.info('Restored workspace from persistence adapter snapshot');
            }
        } catch (e) {
            log.warn('Failed to restore workspace from persistence adapter', { error: e });
        }
    }

    if (!source) {
        // TicketDesk: no Ecosim graph workspace — skip hydration entirely
        // instead of importing an empty payload (whose missing arrays used
        // to crash the importer and toast "Workspace Import Failed").
        log.info('TicketDesk: skipping Ecosim workspace hydration');
        return null;
    }
    if (false) {
        const emptyPayload = buildEmptyWorkspacePayload();
        return hydrateWorkspace({
            workspaceImportController,
            source: { payload: emptyPayload, meta: { source: 'empty-startup' } },
            dataPage,
            calibrationPage,
            eventBus,
            log,
            initialNamespaceId: null,
            hostBridgeRef,
            dataManager,
            projectModel,
        });
    }

    // Check if source is in legacy format and convert
    if (isLegacyWorkspaceFormat(source)) {
        log.info('Converting legacy workspace format to new format');
        source = convertLegacyToNewFormat(source);
    }

    const payloadSource = config.workspacePayload
        ? { payload: config.workspacePayload, meta: { source: 'bootstrap' } }
        : { payload: source, meta: { source: 'localStorage' } };

    return hydrateWorkspace({
        workspaceImportController,
        source: payloadSource,
        dataPage,
        calibrationPage,
        eventBus,
        log,
        initialNamespaceId: config.initialNamespaceId,
        hostBridgeRef,
        dataManager,
        projectModel,
    });
}

async function hydrateWorkspace({
    workspaceImportController,
    source,
    dataPage,
    calibrationPage,
    eventBus,
    log,
    initialNamespaceId = null,
    hostBridgeRef = null,
    dataManager = null,
    projectModel = null,
}) {
    if (!workspaceImportController) {
        throw new Error('workspaceImportController is required to hydrate workspace');
    }
    if (!source) {
        eventBus.emit(APP_EVENTS.HYDRATED, { empty: true });
        return null;
    }

    try {
        const summary = source.payload
            ? await workspaceImportController.importFromPayload(source.payload, source.meta)
            : await workspaceImportController.importFromJSON(source.json, source.meta);

        // Sync workspace identity to backend so scenario/dataset queries are scoped.
        // When a project is open, its path is the authoritative workspace identity
        // (already set by project_open → set_active_workspace).  Do NOT override it
        // with the legacy UUID from dataManager.workspaceId — that causes cross-project
        // data contamination where scenario runs from one project appear in another.
        const bridge = hostBridgeRef?.current;
        const workspaceId = projectModel?.isOpen
            ? projectModel.projectPath
            : dataManager?.workspaceId;
        if (bridge?.set_active_workspace && workspaceId) {
            try {
                await bridge.set_active_workspace({ workspaceId });
            } catch (err) {
                log?.warn?.('Failed to set active workspace on backend', { error: err });
            }
        }

        dataPage.hydrate();
        calibrationPage?.hydrate?.();
        eventBus.emit(APP_EVENTS.HYDRATED, { summary, source: source.meta?.source ?? 'runtime' });
        return summary;
    } catch (error) {
        log.error('Workspace hydration failed', { error });
        eventBus.emit(APP_EVENTS.HYDRATED, { error, source: source.meta?.source ?? 'runtime' });
        throw error;
    }
}

async function attachHostBridge({
    bridge,
    hostBridgeRef,
    dataHub,
    dataPage,
    notificationCenter,
    log,
    symbolRegistry,
    eventBus,
    dataManager,
    applicationShell,
}) {
    hostBridgeRef.current = bridge ?? null;
    try {
        dataHub?.setHostBridge?.(bridge ?? null);
    } catch (error) {
        // EcoAgent's bridge doesn't implement the data-hub host methods, so
        // validateHostBridge() rejects it — an expected absence, not a fault
        // to surface as a startup toast. Keep it at debug for diagnostics.
        log?.debug?.('Data hub host bridge not attached (data-hub methods absent)', { error });
    }
    if (!bridge) {
        log.warn('Host bridge cleared or unavailable');
        return null;
    }

    // Sync DSL builtins from Python backend now that bridge is available
    if (symbolRegistry && bridge.get_dsl_builtins) {
        symbolRegistry.syncFromBackend(bridge)
            .then(() => {
                log?.info?.('host-bridge', 'DSL builtins synced from backend');
            })
            .catch((err) => {
                log?.error?.('Failed to sync DSL builtins from backend', { error: err });
            });
    }

    // Load user modules from modules directory (includes default Economy module)
    if (bridge.module_list_all) {
        loadUserModules({ logger: log, eventBus })
            .then((result) => {
                if (result.loaded.length > 0) {
                    log?.info?.('host-bridge', `Loaded ${result.loaded.length} module(s): ${result.loaded.join(', ')}`);
                }
                if (result.errors.length > 0) {
                    log?.warn?.(`Module loading errors: ${result.errors.join('; ')}`);
                }
            })
            .catch((err) => {
                log?.error?.('Failed to load modules', { error: err });
            });
    }



    if (typeof dataPage?.refreshDatasets === 'function') {
        try {
            dataPage.refreshDatasets({ silent: true, force: true });
        } catch (error) {
            log.warn('Failed to refresh datasets after host attach', { error });
        }
    }


    // Only show toast if enabled in settings
    if (getSetting('host.showConnectedToast', false)) {
        notificationCenter?.show?.({
            id: `host-bridge-${Date.now()}`,
            title: 'Host Connected',
            message: 'Desktop bridge is ready.',
            severity: 'info',
        });
    }

    return bridge;
}

function resolveRootElement(target) {
    if (typeof Element !== 'undefined' && target instanceof Element) {
        return target;
    }
    if (typeof target === 'string' && target.trim()) {
        const el = document.querySelector(target);
        if (!el) {
            throw new Error(`Root selector "${target}" did not match any element`);
        }
        return el;
    }
    const root = document.createElement('div');
    root.className = 'ecosim-js-new-root';
    document.body.appendChild(root);
    return root;
}

function normalizeOptions(options = {}) {
    // Persistable debug + logging level, so reloads keep verbose logs without retyping
    const hasLocalStorage = typeof localStorage !== 'undefined';
    const persistedDebugFlag = hasLocalStorage ? localStorage.getItem('ecosim.debug') === 'true' : false;
    const persistedLoggingLevel = hasLocalStorage ? localStorage.getItem('ecosim.logging.level') : null;
    const debugEnabled = typeof window !== 'undefined'
        ? Boolean(window.__ECOSIM_DEBUG__) || persistedDebugFlag
        : persistedDebugFlag;
    // If a persisted debug flag exists, reflect it on window so other modules can inspect it
    if (typeof window !== 'undefined' && persistedDebugFlag) {
        window.__ECOSIM_DEBUG__ = true;
    }
    const loggingLevel = options.loggingLevel ?? persistedLoggingLevel ?? (debugEnabled ? 'debug' : 'info');

    // Persist derived debug + logging level so verbose diagnostics survive reloads
    if (hasLocalStorage) {
        if (debugEnabled) {
            localStorage.setItem('ecosim.debug', 'true');
        }
        localStorage.setItem('ecosim.logging.level', loggingLevel);
    }
    return {
        root: options.root ?? null,
        mounts: { ...options.mounts },
        eventBus: options.eventBus ?? null,
        loggingService: options.loggingService ?? null,
        loggingName: options.loggingName ?? 'ecosim-js-new',
        loggingLevel,
        namespaceLoggingLevels: mergeLoggingLevels(options.namespaceLoggingLevels),
        enableConsoleLogging: options.enableConsoleLogging ?? debugEnabled,
        dataManager: options.dataManager ?? null,
        hostBridge: options.hostBridge ?? null,
        waitForHostBridge: options.waitForHostBridge !== false,
        hostBridgeTimeoutMs: Number.isFinite(options.hostBridgeTimeoutMs)
            ? options.hostBridgeTimeoutMs
            : DEFAULT_HOST_TIMEOUT_MS,
        dataHub: options.dataHub ?? null,
        workspaceStateMachine: options.workspaceStateMachine ?? null,
        workspaceImportController: options.workspaceImportController ?? null,
        workspaceSaveController: options.workspaceSaveController ?? null,
        persistenceAdapter: options.persistenceAdapter ?? null,
        notificationCenter: options.notificationCenter ?? null,
        hostWindow: options.hostWindow ?? null,
        stateGuard: options.stateGuard ?? null,
        stateGuardConfig: options.stateGuardConfig ?? null,
        autosaveEnabled: options.autosave !== false,
        autosaveIntervalMs: Number.isFinite(options.autosaveIntervalMs)
            ? options.autosaveIntervalMs
            : 60000,
        autosaveDebounceMs: Number.isFinite(options.autosaveDebounceMs)
            ? options.autosaveDebounceMs
            : 2500,
        autosaveStorageKey: options.autosaveStorageKey ?? DEFAULT_AUTOSAVE_KEY,
        // Restore last active page from localStorage, or use option, or default to notebook.
        initialPage: normalizePageKey(
            options.initialPage ?? getStoredActivePage(),
            PAGE_KEYS.NOTEBOOK
        ),
        initialNamespaceId: options.initialNamespaceId ?? null,
        workspacePayload: options.workspacePayload ?? null,
        workspaceJSON: options.workspaceJSON ?? null,
    };
}

/**
 * Resolve mount points from shell-created DOM elements.
 * This must be called AFTER ApplicationShell.initialize() since shell clears body.
 */
function resolveShellMounts(overrides = {}) {
    // Shell creates these elements during mount():
    // - #data-page for data page content
    // - #notebook-main for the notebook editor area
    // - #fixed-200-notebook for the notebook file navigator sidebar
    // - .toast-container for notifications

    const dataPage = document.getElementById('data-page');
    const notebookMain = document.getElementById('notebook-main');
    const notebookFileNav = document.getElementById('fixed-200-notebook');
    const paperMain = document.getElementById('paper-main');
    const paperToc = document.getElementById('fixed-200-paper');
    const notifications = document.querySelector('.toast-container') || document.getElementById('toast-container');

    return {
        data: overrides.data || dataPage,
        notebookMain: overrides.notebookMain || notebookMain,
        notebookFileNav: overrides.notebookFileNav || notebookFileNav,
        paperMain: overrides.paperMain || paperMain,
        paperToc: overrides.paperToc || paperToc,
        notifications: overrides.notifications || notifications,
    };
}

function createPageRegistry({ eventBus, log }) {
    const entries = new Map();
    let activeKey = null;

    return {
        add(key, page, mount) {
            const normalizedKey = normalizePageKey(key);
            if (!page || !mount) {
                // EcoAgent post-copy patches DELETE some Ecosim
                // page containers; silently skip those registrations.
                log?.info?.(`pageRegistry.add: skipping ${normalizedKey} (no container)`);
                return;
            }
            setElementVisibility(mount, false);
            if (!entries.has(normalizedKey)) {
                entries.set(normalizedKey, { page, mount });
            }
        },
        activate(key, context = {}) {
            const normalizedKey = normalizePageKey(key);
            if (!entries.has(normalizedKey)) {
                // EcoAgent removed some Ecosim pages — silently
                // skip activations of those keys (e.g. an initial
                // page="data" when data is gone) instead of crashing
                // the bootstrap. The shell defaults to whichever
                // EcoAgent mode the fl-bar selects next.
                log?.info?.(`pageRegistry.activate: skipping ${normalizedKey} (not registered)`);
                return null;
            }
            if (activeKey === normalizedKey) {
                return normalizedKey;
            }

            const nextEntry = entries.get(normalizedKey);
            const previousEntry = activeKey ? entries.get(activeKey) : null;

            if (previousEntry) {
                setElementVisibility(previousEntry.mount, false);
                previousEntry.page?.onDeactivated?.({ next: normalizedKey, ...context });
            }

            setElementVisibility(nextEntry.mount, true);
            nextEntry.page?.onActivated?.({ previous: activeKey, ...context });
            const previousKey = activeKey;
            activeKey = normalizedKey;

            // Persist active page to localStorage for restore on reload.
            try {
                localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, normalizedKey);
            } catch (e) {
                // localStorage may be unavailable (private browsing, etc.)
            }

            try {
                eventBus?.emit?.('view:page:activated', {
                    page: normalizedKey,
                    previous: previousKey,
                });
            } catch (error) {
                log?.warn?.('Failed to emit activation event', { error });
            }
            return normalizedKey;
        },
        list() {
            return Array.from(entries.keys());
        },
        getActive() {
            return activeKey;
        },
    };
}

function registerPage(page, mount, key, { log }) {
    if (!page || !mount) {
        // EcoAgent post-copy patches remove some Ecosim page
        // containers (data, simulation-run). Treat missing
        // mount as "this page is absent in this product" and
        // skip silently rather than aborting bootstrap.
        log?.info?.(`registerPage: skipping ${key} (no container)`);
        return;
    }
    try {
        page.mount(mount);
    } catch (error) {
        log?.error?.(`Failed to mount page ${key}`, { error });
        throw error;
    }
    setElementVisibility(mount, false);
}

function setElementVisibility(element, visible) {
    if (!element) {
        return;
    }
    if (visible) {
        element.removeAttribute('hidden');
        element.setAttribute('aria-hidden', 'false');
        element.classList.remove('is-hidden');
        element.classList.add('active');
    } else {
        element.setAttribute('hidden', 'hidden');
        element.setAttribute('aria-hidden', 'true');
        element.classList.add('is-hidden');
        element.classList.remove('active');
    }
}

function normalizePageKey(value, fallback = PAGE_KEYS.NOTEBOOK) {
    if (!value) {
        return fallback;
    }
    const normalized = String(value).toLowerCase();
    if (normalized === 'data' || normalized === 'datasets') {
        return PAGE_KEYS.DATA;
    }
    if (!VALID_PAGE_KEYS.has(normalized)) {
        return fallback;
    }
    return normalized;
}

function assertDomEnvironment(label) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error(`${label} requires a browser-like DOM environment`);
    }
}

/**
 * Check if workspace data is in legacy format (v2.0.0 with tabs object)
 */
function isLegacyWorkspaceFormat(data) {
    if (!data || typeof data !== 'object') return false;
    // Legacy format has: version string, tabs object, and no 'format' field
    return (
        typeof data.version === 'string' &&
        data.tabs && typeof data.tabs === 'object' &&
        !data.format
    );
}

/**
 * Generate a UUID v4
 */
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Convert legacy workspace format to new architecture format
 */
function convertLegacyToNewFormat(legacy) {
    const nodes = [];
    const namespaces = [];
    const stocks = [];
    const variables = [];
    const flows = [];
    const connections = [];

    // Map old tab IDs to new UUIDs
    const tabIdMap = new Map();

    // Extract namespaces from tabs
    const tabEntries = Object.entries(legacy.tabs || {});
    tabEntries.forEach(([tabId, tabData], index) => {
        const newId = generateUUID();
        tabIdMap.set(tabId, newId);

        const displayName = tabData?.name || tabData?.displayName || tabId;
        namespaces.push({
            id: newId,
            displayName,
            tabIndex: index,
            color: tabData?.color || null,
            isLocked: tabData?.isLocked || false,
            isArchived: tabData?.isArchived || false,
        });

        // Extract nodes from tab
        const tabNodes = tabData?.nodes || [];
        tabNodes.forEach(node => {
            if (!node || !node.id) return;

            // Ensure node has a valid UUID
            const nodeId = node.id.includes('-') && node.id.length > 30 ? node.id : generateUUID();

            nodes.push({
                id: nodeId,
                type: node.type || 'function',
                namespaceId: newId,
                position: node.position || { x: node.left || 100, y: node.top || 100 },
                config: node.config || {},
                state: node.state || {},
                metadata: node.metadata || {},
                connectors: node.connectors || [],
                createdAt: node.createdAt || Date.now(),
                updatedAt: node.updatedAt || Date.now(),
            });
        });

        // Extract connections from tab
        const tabConnections = tabData?.connections || [];
        tabConnections.forEach(conn => {
            if (!conn) return;
            const sourceNodeId = conn.fromNodeId || conn.sourceNodeId;
            const targetNodeId = conn.toNodeId || conn.targetNodeId;
            if (!sourceNodeId || !targetNodeId) {
                return;
            }
            connections.push({
                id: conn.id || generateUUID(),
                namespaceId: newId,
                source: {
                    nodeId: sourceNodeId,
                    connectorId: conn.fromHandle || conn.sourceConnector || null,
                    role: 'output',
                },
                target: {
                    nodeId: targetNodeId,
                    connectorId: conn.toHandle || conn.targetConnector || null,
                    role: 'input',
                },
                metadata: {},
                geometry: conn.geometry || null,
                tags: conn.tags || [],
            });
        });
    });

    // Extract variables from runtime
    const runtime = legacy.runtime || {};
    const runtimeNamespaces = runtime.registries?.namespaces || {};
    Object.entries(runtimeNamespaces).forEach(([nsId, nsData]) => {
        const newNsId = tabIdMap.get(nsId) || nsId;

        // Constants
        Object.entries(nsData?.constants || {}).forEach(([key, value]) => {
            variables.push({
                id: generateUUID(),
                namespaceId: newNsId,
                type: 'constant',
                key,
                value,
            });
        });

        // Parameters
        Object.entries(nsData?.parameters || {}).forEach(([key, param]) => {
            variables.push({
                id: generateUUID(),
                namespaceId: newNsId,
                type: 'parameter',
                key,
                ...param,
            });
        });

        // Stock variables
        const stockVars = nsData?.stockVariables?.sectors || {};
        Object.entries(stockVars).forEach(([sectorName, sector]) => {
            Object.entries(sector?.accountTypes || {}).forEach(([accountTypeName, accountType]) => {
                Object.entries(accountType?.accounts || {}).forEach(([accountName, account]) => {
                    stocks.push({
                        id: generateUUID(),
                        namespaceId: newNsId,
                        sector: sectorName,
                        accountType: accountTypeName,
                        accountName,
                        initialValue: account?.initialValue || 0,
                        expression: account?.expression || '',
                    });
                });
            });
        });
    });

    // Extract flows from globalData
    const globalFlows = legacy.globalData?.flows || [];
    globalFlows.forEach(flow => {
        if (!flow) return;
        const legacyNsId = flow.tabId || flow.namespaceId || 'tab1';
        const newNsId = tabIdMap.get(legacyNsId) || legacyNsId;

        flows.push({
            id: flow.id || flow.uuid || generateUUID(),
            namespaceId: newNsId,
            nodeId: flow.nodeId,
            entries: flow.entries || [],
        });
    });

    // Get the first namespace ID for active
    const firstNamespaceId = namespaces[0]?.id || generateUUID();

    return {
        format: 'ecosim-workspace',
        version: 1,
        createdAt: legacy.timestamp ? new Date(legacy.timestamp).getTime() : Date.now(),
        updatedAt: Date.now(),
        namespaces,
        nodes,
        connections,
        stocks,
        variables,
        flows,
        metadata: {
            source: 'legacy-conversion',
            legacyVersion: legacy.version,
            activeNamespaceId: firstNamespaceId,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis tool event wiring (steady state, bifurcation, impulse response,
// loop analysis)
// ═══════════════════════════════════════════════════════════════════════════

function wireAnalysisToolEvents({ eventBus, notebookPage }) {
    /**
     * Extract namespaces, parameters, and stocks from the notebook symbol index.
     * Returns the data shape expected by the analysis config modals.
     */
    function gatherModelInfo() {
        const symbolIndex = notebookPage?.symbolIndex;
        if (!symbolIndex) return null;

        const configurables = symbolIndex.getConfigurables();
        const namespaces = [];
        const parameters = [];
        const stocks = [];
        const observeVariables = [];

        for (const [nsName, group] of Object.entries(configurables)) {
            const nsId = nsName;
            namespaces.push({ id: nsId, label: nsName });

            for (const p of (group.parameters || [])) {
                parameters.push({
                    name: p.displayName || p.name,
                    key: p.name,
                    namespace: nsName,
                    namespaceId: nsId,
                    fullName: `${nsName}.${p.name}`,
                    value: p.defaultValue ?? 0,
                });
            }

            for (const s of (group.stocks || [])) {
                stocks.push({
                    name: s.displayName || s.name,
                    key: s.name,
                    namespace: nsName,
                    namespaceId: nsId,
                    fullName: `${nsName}.${s.name}`,
                    value: s.defaultValue ?? 0,
                });
                // Stocks are also observable
                observeVariables.push({
                    name: s.displayName || s.name,
                    key: s.name,
                    namespace: nsName,
                    namespaceId: nsId,
                    fullName: `${nsName}.${s.name}`,
                });
            }

            for (const c of (group.constants || [])) {
                // Constants (variables) are observable
                observeVariables.push({
                    name: c.displayName || c.name,
                    key: c.name,
                    namespace: nsName,
                    namespaceId: nsId,
                    fullName: `${nsName}.${c.name}`,
                });
            }
        }

        return { namespaces, parameters, stocks, observeVariables };
    }

    /**
     * Ensure notebook DSL is compiled and synced to backend.
     * Must be called before any analysis API.
     */
    async function ensureDslSynced() {
        return notebookPage?.syncDslToBackend?.() ?? { ok: false, error: 'Notebook page not available' };
    }

    function checkNotRunning() {
        const phase = 'idle';
        if (phase !== 'idle' && phase !== 'complete' && phase !== 'error') {
            eventBus.emit('toast:show', {
                message: 'Cannot run analysis while simulation is running',
                type: 'warning',
                duration: 3000,
            });
            return false;
        }
        return true;
    }

    // ── Steady State ──────────────────────────────────────────────────────
    eventBus.on('tools:steady-state:open', async () => {
        if (!checkNotRunning()) return;

        const info = gatherModelInfo();
        if (!info || info.namespaces.length === 0) {
            eventBus.emit('toast:show', { message: 'No namespaces found. Open a project first.', type: 'warning', duration: 3000 });
            return;
        }

        const { openSteadyStateConfigModal } = await import('../ui/components/steady_state_config_modal.js');
        openSteadyStateConfigModal({
            namespaces: info.namespaces,
            activeNamespaceId: info.namespaces[0]?.id,
            onRun: async (namespaceId) => {
                eventBus.emit('toast:show', { message: 'Finding steady state...', type: 'info', duration: 2000 });

                try {
                    const syncResult = await ensureDslSynced();
                    if (!syncResult.ok) {
                        eventBus.emit('toast:show', { message: syncResult.error || 'DSL sync failed', type: 'error', duration: 5000 });
                        return;
                    }

                    const namespaceName = info.namespaces.find(ns => ns.id === namespaceId)?.label || namespaceId;
                    const api = window.pywebview?.api;
                    const result = await api?.find_steady_state?.({ namespaceId, namespaceName });

                    if (!result?.ok) {
                        eventBus.emit('toast:show', { message: result?.error || 'Failed to find steady state', type: 'error', duration: 5000 });
                        return;
                    }

                    const { openSteadyStateModal } = await import('../ui/components/steady_state_modal.js');
                    openSteadyStateModal({
                        result: result.data,
                        parameters: info.parameters,
                        onSetParameter: () => {},
                        onApply: () => {
                            eventBus.emit('toast:show', { message: 'Apply from steady state not yet supported in notebook mode', type: 'info', duration: 3000 });
                        },
                        onRunFromSteady: () => {
                            eventBus.emit('toast:show', { message: 'Run from steady state not yet supported in notebook mode', type: 'info', duration: 3000 });
                        },
                    });
                } catch (err) {
                    console.error('[SteadyState] Analysis failed', err);
                    eventBus.emit('toast:show', { message: 'Steady state solver error', type: 'error', duration: 3000 });
                }
            },
            onCancel: () => {},
        });
    });

    // ── Bifurcation Diagram ───────────────────────────────────────────────
    eventBus.on('tools:bifurcation:open', async () => {
        if (!checkNotRunning()) return;

        const info = gatherModelInfo();
        if (!info || (info.parameters.length === 0 && info.stocks.length === 0)) {
            eventBus.emit('toast:show', { message: 'No parameters or stocks found. Open a project first.', type: 'warning', duration: 4000 });
            return;
        }

        const { openBifurcationConfigModal } = await import('../ui/components/bifurcation_config_modal.js');
        openBifurcationConfigModal({
            namespaces: info.namespaces,
            activeNamespaceId: info.namespaces[0]?.id,
            parameters: info.parameters,
            stocks: info.stocks,
            onRun: async (config) => {
                const typeLabels = {
                    one_param: 'one-parameter', two_param: 'two-parameter',
                    orbit: 'orbit', basin: 'basin of attraction', hysteresis: 'hysteresis',
                };
                const typeLabel = typeLabels[config.type] || config.type;

                const api = window.pywebview?.api;
                const { showComputingWindow } = await import('../ui/components/computing_status_window.js');
                const status = showComputingWindow({
                    title: 'Bifurcation Analysis',
                    message: `Computing ${typeLabel} diagram...`,
                    icon: 'call_split',
                    onCancel: () => api?.cancel_analysis?.(),
                });

                try {
                    const syncResult = await ensureDslSynced();
                    if (!syncResult.ok) {
                        status.close();
                        eventBus.emit('toast:show', { message: syncResult.error || 'DSL sync failed', type: 'error', duration: 5000 });
                        return;
                    }

                    const result = await api?.compute_bifurcation_diagram?.(config);
                    status.close();

                    if (!result?.ok) {
                        if (result?.error === 'Cancelled') return;
                        eventBus.emit('toast:show', { message: result?.error || 'Bifurcation analysis failed', type: 'error', duration: 5000 });
                        return;
                    }

                    const { openBifurcationResultsModal } = await import('../ui/components/bifurcation_results_modal.js');
                    openBifurcationResultsModal({
                        result: result.data,
                        onClose: () => eventBus.emit('tools:bifurcation:open'),
                    });

                    eventBus.emit('toast:show', {
                        message: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} analysis complete`,
                        type: 'success', duration: 3000,
                    });
                } catch (err) {
                    status.close();
                    console.error('[Bifurcation] Analysis failed', err);
                    eventBus.emit('toast:show', { message: 'Bifurcation analysis error', type: 'error', duration: 3000 });
                }
            },
            onCancel: () => {},
        });
    });

    // ── Impulse Response ──────────────────────────────────────────────────
    eventBus.on('tools:impulse-response:open', async () => {
        if (!checkNotRunning()) return;

        const info = gatherModelInfo();
        if (!info || (info.parameters.length === 0 && info.stocks.length === 0 && info.observeVariables.length === 0)) {
            eventBus.emit('toast:show', { message: 'No parameters or variables found. Open a project first.', type: 'warning', duration: 4000 });
            return;
        }

        const { openImpulseResponseConfigModal } = await import('../ui/components/impulse_response_config_modal.js');
        openImpulseResponseConfigModal({
            namespaces: info.namespaces,
            activeNamespaceId: info.namespaces[0]?.id,
            parameters: info.parameters,
            stocks: info.stocks,
            observeVariables: info.observeVariables,
            onRun: async (config) => {
                const api = window.pywebview?.api;
                const { showComputingWindow } = await import('../ui/components/computing_status_window.js');
                const status = showComputingWindow({
                    title: 'Impulse Response',
                    message: 'Running baseline + perturbed simulations...',
                    icon: 'pulse_alert',
                    onCancel: () => api?.cancel_analysis?.(),
                });

                try {
                    const syncResult = await ensureDslSynced();
                    if (!syncResult.ok) {
                        status.close();
                        eventBus.emit('toast:show', { message: syncResult.error || 'DSL sync failed', type: 'error', duration: 5000 });
                        return;
                    }

                    const result = await api?.compute_impulse_response?.(config);
                    status.close();

                    if (!result?.ok) {
                        if (result?.error === 'Cancelled') return;
                        eventBus.emit('toast:show', { message: result?.error || 'Impulse response analysis failed', type: 'error', duration: 5000 });
                        return;
                    }

                    const { openImpulseResponseResultsModal } = await import('../ui/components/impulse_response_results_modal.js');
                    openImpulseResponseResultsModal({
                        result: result.data,
                        onClose: () => eventBus.emit('tools:impulse-response:open'),
                    });
                } catch (err) {
                    status.close();
                    console.error('[ImpulseResponse] Analysis failed', err);
                    eventBus.emit('toast:show', { message: 'Impulse response analysis error', type: 'error', duration: 3000 });
                }
            },
            onCancel: () => {},
        });
    });

    // ── Loop Analysis ─────────────────────────────────────────────────────
    eventBus.on('tools:loop-analysis:open', async () => {
        if (!checkNotRunning()) return;

        const info = gatherModelInfo();
        if (!info || info.namespaces.length === 0) {
            eventBus.emit('toast:show', { message: 'No namespaces found. Open a project first.', type: 'warning', duration: 3000 });
            return;
        }

        eventBus.emit('toast:show', { message: 'Analyzing feedback loops...', type: 'info', duration: 30000 });

        try {
            const syncResult = await ensureDslSynced();
            if (!syncResult.ok) {
                eventBus.emit('toast:show', { message: syncResult.error || 'DSL sync failed', type: 'error', duration: 5000 });
                return;
            }

            const namespaceName = info.namespaces[0]?.label || 'Main';
            const api = window.pywebview?.api;
            const result = await api?.analyze_feedback_loops?.({ namespaceName });

            if (!result?.ok) {
                eventBus.emit('toast:show', { message: result?.error || 'Loop analysis failed', type: 'error', duration: 5000 });
                return;
            }

            const { openLoopAnalysisWindow } = await import('../ui/components/loop_analysis_window.js');
            openLoopAnalysisWindow({
                analysisData: result.data,
                namespaces: info.namespaces,
                activeNamespaceId: info.namespaces[0]?.id,
                onNamespaceChange: async (nsId) => {
                    const nsName = nsId === '__all__'
                        ? '__all__'
                        : (info.namespaces.find(n => n.id === nsId)?.label || 'Main');
                    await ensureDslSynced();
                    const res = await api?.analyze_feedback_loops?.({ namespaceName: nsName });
                    return res?.ok ? res.data : null;
                },
            });

            const loopCount = result.data?.loops?.length || 0;
            const hasGains = result.data?.dominance?.time?.length > 0;
            eventBus.emit('toast:show', {
                message: hasGains
                    ? `Found ${loopCount} feedback loops`
                    : `Found ${loopCount} feedback loops (structural view — run simulation for gains)`,
                type: 'success',
                duration: hasGains ? 3000 : 5000,
            });
        } catch (err) {
            console.error('[LoopAnalysis] Failed', err);
            eventBus.emit('toast:show', { message: 'Loop analysis error', type: 'error', duration: 3000 });
        }
    });
}
