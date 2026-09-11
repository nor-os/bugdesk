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

import {
    getSetting, registerSettings, registerSettingsEventBus, BUGDESK_SETTINGS_SLICE,
} from '../core/settings.js';

import { EventBus, LoggingService, StateGuardService } from '@flexdesk/core';
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
import { ProjectModel } from '../data/project_model.js';
import { showAboutDialog } from '../ui/components/about_dialog.js';
import { ApplicationShell } from '../ui/shell/application_shell.js';
import { WindowChromeController } from '../ui/controllers/window_chrome_controller.js';
import { mergeLoggingLevels } from '../config/logging_levels.js';
// Tooltip service - initializes on import, sets up window.LatexTooltip
import '../ui/utils/tooltip_service.js';

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

const extractFileName = (path) => path.split(/[\\/]/).pop() || path;

export async function bootstrapApplication(options = {}) {
    assertDomEnvironment('bootstrapApplication');

    // Push bugdesk's own settings namespace (ecoagent.*, modules.*) into the
    // @flexdesk/core shell store BEFORE any getSetting/setSetting call —
    // required so persistence round-trips correctly (see registerSettings's
    // doc comment in core/settings.js / @flexdesk/core).
    registerSettings(BUGDESK_SETTINGS_SLICE);

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
    });
    applicationShell.initialize();

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

    // Shared ProjectModel — used across menu actions, Notes, and AI chat
    const projectModel = new ProjectModel({
        eventBus,
        logger: loggingService.scoped('project-model'),
    });

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

    const disposers = [];

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
        dataManager,
        projectModel,
        hostBridgeRef,
        updateRecentMenu,
        log: loggingService.scoped('menu'),
    });
    if (menuDisposer) {
        disposers.push(menuDisposer);
    }

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

    // The shell has no page modes any more — the tiling WM owns what is on
    // screen — so opening a project only refreshes the menu and drops cached
    // table state.
    eventBus.on('project:opened', async () => {
        updateRecentMenu();
        // Drop cached DataTable view-state so the next project loads its
        // own persisted sort/filters/column-widths, not the old one's.
        resetTableStore();
    });

    // Restore the last project early so that every page starts with the
    // project already open. Must come AFTER the project:opened handler above
    // so that its handler fires.
    if (!projectModel.isOpen) {
        await projectModel.restoreLastProject();
    }

    // Initialize window chrome (resize handles, window buttons, drag)
    const windowChromeController = new WindowChromeController({
        eventBus,
        logger: loggingService.scoped('window-chrome'),
    });
    windowChromeController.initialize();

    const hostBridgeDisposer = setupHostBridgeListener({
        hostBridgeRef,
        onResolved: (bridge) => attachHostBridge({
            bridge,
            hostBridgeRef,
            dataHub,
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
            notificationCenter,
            log: loggingService.scoped('host-bridge'),
            symbolRegistry,
            eventBus,
            dataManager,
            applicationShell,
        });
    }

    eventBus.emit(APP_EVENTS.READY, {
        timestamp: Date.now(),
    });

    await hydrateInitialWorkspace({
        workspaceImportController,
        config,
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
        shell: applicationShell,
        mounts,
        hydrateWorkspace: (source) => hydrateWorkspace({
            workspaceImportController,
            source,
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
            windowChromeController?.dispose?.();
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
        projectModel?.close?.();
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
    // (An `if (false)` block hydrating an empty workspace payload stood here.
    // It was disabled when TicketDesk dropped the Ecosim graph workspace — the
    // `!source` branch above returns before it could ever matter — so it was
    // dead in two independent ways. Removed rather than left as a decoy.)

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
    const notifications = document.querySelector('.toast-container') || document.getElementById('toast-container');

    return {
        notifications: overrides.notifications || notifications,
    };
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
