/**
 * ApplicationShell - Dynamically creates the full EcoSim UI structure
 *
 * Builds the DOM structure for the notebook-first UI:
 * - global-top-bar (menu, panel toggles, window controls)
 * - container (fixed-left nav, fixed-200 sidebar, workspace shell with top bar + main panel)
 * - global-bottom-bar (status)
 */

import { ValidationStatus } from '../components/validation_status.js';
import { installOverlayScrollbar, installWorkspaceScrollbars, installTabsScrollbars, installCollapsibleScrollbars } from '../utils/overlay_scrollbar.js';
import { SettingsPage } from '../pages/settings_page.js';
import { ETLManagerPage } from '../pages/etl_manager_page.js';
import { WindowTaskbar } from '../components/window_taskbar.js';
import { ManagedWindow } from '../components/managed_window.js';
import { PanelStateMachine } from '../controllers/panel_state_machine.js';
import { usesCustomWindowChrome } from '../controllers/window_chrome_controller.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { openSolverSettingsModal } from '../components/solver_settings_modal.js';

export class ApplicationShell {
    constructor(options = {}) {
        this.root = options.root || null;
        this.eventBus = options.eventBus || null;
        this.logger = options.logger || console;
        this.dataManager = options.dataManager || null;
        this.onNavigate = options.onNavigate || null;
        this.onMenuAction = options.onMenuAction || null;
        this.pageLabels = options.pageLabels || {};
        this.container = null;
        this.elements = {};
        this._initialized = false;
        this.validationStatus = null;
        this.settingsPage = null;
        this.dataHub = options.dataHub || null;
        this._busSubscriptions = [];
        this._bottomPanelFSM = null;
        this._rightPanelFSM = null;
        // Set true once the tiling shell takes over the panel chrome
        // (installTilingShell → retireLegacyPanels). From then on the WM
        // is the single owner of the left/right/bottom toggle buttons and
        // the legacy FSMs must not touch them.
        this._panelsOwnedByWM = false;
        this._welcomeScreenActive = false;
        this._boundHandlers = new Map();
        this._currentMode = 'simulation-run'; // Default mode
    }

    /**
     * Initialize the shell with configuration
     */
    initialize(options = {}) {
        if (this._initialized) {
            this.logger.warn?.('[ApplicationShell] Already initialized');
            return;
        }
        
        // Mount the shell structure
        this.mount();

        // Create panel FSMs and restore persisted state
        this._bottomPanelFSM = this._createBottomPanelFSM();
        this._rightPanelFSM = this._createRightPanelFSM();
        this._bottomPanelFSM.hydrate();
        this._rightPanelFSM.hydrate();

        this._hydrateCollapsibleState();
        this._hydratePersistedModeState();

        // Wire up event handlers
        this._wireToolbarEvents();
        this._wireMenuEvents();
        this._wirePanelEvents();
        this._wireCollapsibleEvents();
        this._wireResizer();
        this._wireDebugButton();
        this._syncDebugIndicator();
        this._wireHistoryEvents();
        // NOTE: _wireSimulationControlButtons() is called externally from bootstrap
        // AFTER simulationController is assigned to the shell.

        // Bottom panel starts disabled; _switchMode() enables for ETL
        this._bottomPanelFSM.supportsCollapse = true;
        this._bottomPanelFSM.enable();

        // Right panel starts disabled; ETL enables it via etl:panels:configure
        this._rightPanelFSM.enable();

        this._wireNotesEvents();

        this._installCustomScrollbars();
        
        // Refresh tooltips for dynamically injected content
        window.LatexTooltip?.refresh();
        
        // Mount validation status indicator
        this.validationStatus = new ValidationStatus({
            eventBus: this.eventBus,
            logger: this.logger,
            dataManager: this.dataManager,
        });
        this.validationStatus.mount();

        // Wire simulation status events to bottom bar
        this._wireSimulationStatusEvents();

        // Listen for mode switch requests (e.g., from global search)
        this._wireModeRequestEvents();

        // Listen for breadcrumb updates from pages
        this.eventBus?.on('topbar:breadcrumb:update', ({ segments, actions }) => {
            this.#renderTopBarBreadcrumb(segments, actions);
        });

        // Apply macOS shadows setting reactively
        const applyMacShadows = () => {
            document.body.classList.toggle('mac-shadows', getSetting('window.macShadows', true));
        };
        applyMacShadows();
        this.eventBus?.on('settings:window.macShadows:changed', applyMacShadows);
        this._busSubscriptions.push(['settings:window.macShadows:changed', applyMacShadows]);

        this._initialized = true;

        this.logger.info?.('[ApplicationShell] Initialized with full UI structure');

        // Listen for workspace hydration to restore the last active UI mode
        // Mode restoration must wait until workspace data is loaded
        if (this._deferredMode && this.eventBus) {
            const handleHydrated = () => {
                // Small delay to ensure all pages are fully initialized
                setTimeout(() => this._applyDeferredModeState(), 50);
            };
            this.eventBus.once?.('app:hydrated', handleHydrated) ||
                this.eventBus.on?.('app:hydrated', () => {
                    handleHydrated();
                    // Manual cleanup if no `once` support
                });
        }
    }

    /**
     * Mount the shell into the document body
     */
    mount() {
        // Clear body and build structure
        document.body.innerHTML = '';
        
        // Build all sections
        this._buildGlobalTopBar();
        this._buildMainContainer();
        this._buildGlobalBottomBar();

        // Initialize window taskbar for managed windows
        WindowTaskbar.init();

        console.log('[ApplicationShell] Mounted with full UI structure');
    }

    setMode(mode) {
        this._switchMode(mode);
    }

    /**
     * Hand panel ownership to the tiling WM.
     *
     * The tiling shell (installTilingShell) re-wires the top-bar toggle
     * buttons to `wm.togglePanel()` and is the single source of truth for
     * their visual state. The legacy panel FSMs must stop driving those
     * buttons — their callbacks no longer write button classes, and we
     * disable them here so they also stop reacting to bus triggers.
     * Idempotent.
     */
    retireLegacyPanels() {
        if (this._panelsOwnedByWM) return;
        this._panelsOwnedByWM = true;
        try { this._bottomPanelFSM?.disable(); } catch { /* ignore */ }
        try { this._rightPanelFSM?.disable(); } catch { /* ignore */ }
    }

    /**
     * Build the top bar with menus, panel toggles, and window controls
     */
    _buildGlobalTopBar() {
        const topBar = document.createElement('div');
        topBar.className = 'global-top-bar';

        // Window min/max/close live in our top bar only when it IS the title
        // bar (native frameless Windows). On Linux/macOS the OS draws its own
        // title bar, and in --browser mode the browser does — there these are a
        // redundant second set, so we omit them at the source. See
        // usesCustomWindowChrome() / WindowChromeController.
        const windowControlsHtml = usesCustomWindowChrome() ? `
                <div class="window-controls no-drag" style="display:flex; gap:6px; margin-left: 8px;">
                    <button class="panel-toggle-btn has-tooltip" id="win-minimize" data-tooltip="Minimize" data-tooltip-placement="bottom" aria-label="Minimize">
                        <span class="material-symbols-outlined">remove</span>
                    </button>
                    <button class="panel-toggle-btn has-tooltip" id="win-maximize" data-tooltip="Maximize" data-tooltip-placement="bottom" aria-label="Maximize">
                        <span class="material-symbols-outlined">check_box_outline_blank</span>
                    </button>
                    <button class="panel-toggle-btn has-tooltip" id="win-close" data-tooltip="Close" data-tooltip-placement="bottom" aria-label="Close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>` : '';

        topBar.innerHTML = `
            <div class="bar-left">
                <nav class="app-menu" aria-label="Application Menu"><span class="ecoagent-brand" style="font-weight:600; padding:0 10px; letter-spacing:0.04em; color:#ddd;">BugDesk</span><div class="menu-item" tabindex="0"><span>File</span><div class="menu-dropdown"><button class="menu-entry" id="menu-file-new">New…</button><button class="menu-entry" id="menu-file-open">Open Project…</button><hr class="menu-sep" /><button class="menu-entry" id="menu-file-save">Save</button><button class="menu-entry" id="menu-file-save-all">Save All</button><hr class="menu-sep" /><button class="menu-entry" id="menu-file-exit">Exit</button></div></div><div class="menu-item" tabindex="0"><span>Edit</span><div class="menu-dropdown"><button class="menu-entry disabled" id="menu-edit-undo" disabled aria-disabled="true">Undo</button><button class="menu-entry disabled" id="menu-edit-redo" disabled aria-disabled="true">Redo</button><hr class="menu-sep" /><button class="menu-entry" id="menu-edit-find">Find <span class="menu-shortcut">Ctrl+F</span></button></div></div><div class="menu-item" tabindex="0"><span>View</span><div class="menu-dropdown"><button class="menu-entry" id="menu-view-toggle-left">Toggle Left Panel</button><button class="menu-entry" id="menu-view-toggle-right">Toggle Right Panel</button><button class="menu-entry" id="menu-view-toggle-bottom">Toggle Bottom Panel</button></div></div><div class="menu-item" tabindex="0"><span>Run</span><div class="menu-dropdown"><button class="menu-entry" id="menu-run-scenario">Run</button><button class="menu-entry" id="menu-run-stop">Stop</button></div></div><div class="menu-item" tabindex="0"><span>Help</span><div class="menu-dropdown"><button class="menu-entry" id="menu-help-topics">Help Topics <span class="menu-shortcut">F1</span></button><hr class="menu-sep" /><button class="menu-entry" id="menu-help-about">About BugDesk</button></div></div></nav>
                <input type="file" id="fileInput" accept=".json">
            </div>
            <div class="bar-center"></div>
            <div class="bar-right">
                <div class="debug-indicator has-tooltip" id="debug-indicator" style="display:none;" data-tooltip="Reload (Debug)" data-tooltip-placement="bottom">
                    <span class="material-symbols-outlined">bug_report</span>
                    <span>Debug</span>
                </div>
                <div class="panel-toggles">
                    <button class="panel-toggle-btn has-tooltip" id="toggle-left-panel" data-tooltip="Toggle Left Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Left Panel">
                        <span class="material-symbols-outlined">dock_to_left</span>
                    </button>
                    <button class="panel-toggle-btn has-tooltip" id="toggle-bottom-panel" data-tooltip="Toggle Bottom Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Bottom Panel">
                        <span class="material-symbols-outlined">dock_to_bottom</span>
                    </button>
                    <button class="panel-toggle-btn has-tooltip" id="toggle-right-panel" data-tooltip="Toggle Right Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Right Panel">
                        <span class="material-symbols-outlined">dock_to_right</span>
                    </button>
                </div>
                ${windowControlsHtml}
            </div>
        `;
        
        document.body.appendChild(topBar);
        this.elements.topBar = topBar;
    }

    /**
     * Build the main container with all panels
     */
    _buildMainContainer() {
        const container = document.createElement('div');
        container.className = 'container';

        // Fixed rails on the left
        container.appendChild(this._buildFixedLeft());
        container.appendChild(this._buildFixed200());

        // Workspace column holds the simulation top bar plus both panels
        const workspaceShell = document.createElement('div');
        workspaceShell.className = 'workspace-shell';

        // Simulation controls bar sits below the global top bar and above both panels
        workspaceShell.appendChild(this._buildWorkspaceTopBar());

        // Main workspace area
        const workspaceMain = document.createElement('div');
        workspaceMain.className = 'workspace-main';
        workspaceMain.appendChild(this._buildPanelLeft());
        workspaceMain.appendChild(this._buildResizer());
        workspaceMain.appendChild(this._buildPanelRight());

        workspaceShell.appendChild(workspaceMain);
        container.appendChild(workspaceShell);

        // Overlay utilities
        container.appendChild(this._buildContextMenu());
        container.appendChild(this._buildToastContainer());

        document.body.appendChild(container);
        this.container = container;
        this.elements.container = container;
    }

    _buildWorkspaceTopBar() {
        const simTopBar = document.createElement('div');
        simTopBar.className = 'top-bar workspace-top-bar';

        simTopBar.innerHTML = `
            <!-- Simulation Controls -->
            <div class="sim-controls">
                <div class="menu-bar" style="font-variation-settings: 'FILL' 0, 'wght' 100, 'GRAD' 0, 'opsz' 48;">
                    <button class="has-tooltip" data-tooltip="Run Simulation" id="start-button"><span class="material-symbols-outlined control-icon control-icon--play">play_arrow</span></button>
                    <button class="has-tooltip" data-tooltip="Pause" id="pause-button"><span class="material-symbols-outlined control-icon control-icon--pause">pause</span></button>
                    <button class="has-tooltip" data-tooltip="Stop" id="stop-button"><span class="material-symbols-outlined control-icon control-icon--stop">stop</span></button>
                    </div></div>

            

            <!-- Time Display -->
            <div class="time-display">
                <span class="time-label">t:</span>
                <span id="current-time-display" class="time-value">—</span>
            </div>
        `;

        // Breadcrumb container (hidden by default — flow mode shows sim controls)
        const breadcrumbContainer = document.createElement('div');
        breadcrumbContainer.className = 'topbar-breadcrumb';
        breadcrumbContainer.style.display = 'none';
        simTopBar.appendChild(breadcrumbContainer);

        // Notebook toolbar slot (hidden by default — shown only in notebook mode)
        const notebookToolbarSlot = document.createElement('div');
        notebookToolbarSlot.id = 'notebook-toolbar-slot';
        notebookToolbarSlot.style.display = 'none';
        notebookToolbarSlot.style.flex = '1';
        simTopBar.appendChild(notebookToolbarSlot);

        this.elements.simTopBar = simTopBar;
        this.elements.topBarBreadcrumb = breadcrumbContainer;
        this.elements.notebookToolbarSlot = notebookToolbarSlot;
        return simTopBar;
    }

    /**
     * Render breadcrumb segments into the top-bar breadcrumb container.
     * @param {Array<{icon: string, label: string, onClick: Function|null}>} segments
     * @param {Array<{icon: string, label: string, tooltip: string, onClick: Function}>} [actions]
     */
    #renderTopBarBreadcrumb(segments, actions) {
        const container = this.elements.topBarBreadcrumb;
        if (!container) return;
        container.innerHTML = '';
        if (!segments?.length) return;

        const ol = document.createElement('ol');
        ol.className = 'topbar-breadcrumb__list';

        segments.forEach((seg, i) => {
            const li = document.createElement('li');
            li.className = 'topbar-breadcrumb__item';
            const isLast = i === segments.length - 1;

            if (isLast) {
                li.classList.add('topbar-breadcrumb__item--current');
                li.innerHTML = `
                    <span class="material-symbols-outlined topbar-breadcrumb__icon">${seg.icon}</span>
                    <span class="topbar-breadcrumb__current">${seg.label}</span>`;
            } else {
                const btn = document.createElement('button');
                btn.className = 'topbar-breadcrumb__link';
                btn.innerHTML = `
                    <span class="material-symbols-outlined topbar-breadcrumb__icon">${seg.icon}</span>
                    ${seg.label}`;
                if (seg.onClick) btn.addEventListener('click', seg.onClick);
                li.appendChild(btn);

                const sep = document.createElement('span');
                sep.className = 'topbar-breadcrumb__separator';
                sep.textContent = '›';
                li.appendChild(sep);
            }
            ol.appendChild(li);
        });
        container.appendChild(ol);

        // Right-floated action buttons
        if (actions?.length) {
            const actionsEl = document.createElement('div');
            actionsEl.className = 'topbar-breadcrumb__actions';
            for (const action of actions) {
                const btn = document.createElement('button');
                btn.className = 'topbar-breadcrumb__action-btn has-tooltip';
                if (action.tooltip) btn.dataset.tooltip = action.tooltip;
                btn.innerHTML = `<span class="material-symbols-outlined">${action.icon}</span>`;
                if (action.label) {
                    const span = document.createElement('span');
                    span.textContent = action.label;
                    btn.appendChild(span);
                }
                if (action.onClick) btn.addEventListener('click', action.onClick);
                actionsEl.appendChild(btn);
            }
            container.appendChild(actionsEl);
        }
    }

    /**
     * Build the left toolbar (flow/scenario/database/settings)
     */
    _buildFixedLeft() {
        const fixedLeft = document.createElement('div');
        fixedLeft.id = 'fixed-left';
        fixedLeft.className = 'panel fixed-left';
        
        fixedLeft.innerHTML = `
            <nav class="fl-bar" aria-label="Left tool bar">
                <button class="fl-item fl-bottom has-tooltip" data-tool="settings" data-tooltip="Settings" data-tooltip-placement="right" aria-label="Settings">
                    <span class="material-symbols-outlined">settings</span>
                </button>
            </nav>
        `;
        
        this.elements.fixedLeft = fixedLeft;
        return fixedLeft;
    }

    /**
     * Build the template gallery panel (fixed-200)
     */
    _buildFixed200() {
        const fixed200 = document.createElement('div');
        fixed200.id = 'fixed-200';
        fixed200.className = 'panel fixed-200';
        fixed200.dataset.activeContent = 'notebook';

        fixed200.innerHTML = `
            <div id="fixed-200-settings" data-panel-content="settings" class="settings-browser-panel" style="display:none;"></div>
            <div id="fixed-200-etl" data-panel-content="etl" class="scenario-browser-panel" style="display:none;"></div>
            <div id="fixed-200-notebook" data-panel-content="notebook" class="notebook-browser-panel"></div>
            <div id="fixed-200-paper" data-panel-content="paper" style="display:none; height:100%; overflow:hidden;"></div>
        `;

        this.elements.fixed200 = fixed200;
        return fixed200;
    }

    /**
     * Build the main left panel (workspace with tabs, canvas, godley)
     */
    _buildPanelLeft() {
        const panelLeft = document.createElement('div');
        panelLeft.className = 'panel left';
        
        panelLeft.innerHTML = `
            <!-- ETL Manager Page (managed by etl_manager_page.js) -->
            <div id="etl-manager-page" class="etl-manager-page" style="display:none"></div>
            <!-- Settings Page (managed by settings_page.js) -->
            <div id="settings-page" class="settings-page" style="display:none"></div>
            <!-- Notebook Page (managed by notebook/notebook_page.js via app_bootstrap.js) -->
            <div id="notebook-main" class="notebook-main"></div>
            <!-- Paper Page (managed by paper/paper_page.js via app_bootstrap.js) -->
            <div id="paper-main" class="paper-main" style="display:none"></div>
            <!-- ETL bottom panel -->
            <div class="vertical-resizer" id="vertical-resizer" style="display:none"></div>
            <div class="left-bottom" style="display:none">
                <div class="bottom-tabs-header">
                    <div class="tabs bottom-tabs" id="sector-tabs"></div>
                    <button class="arrow-toggle" id="bottom-tabs-toggle"><span id="bottom-tabs-arrow" class="collapsible-arrow material-symbols-outlined">expand_more</span></button>
                </div>
                <div id="bottom-tabs-content" class="bottom-tabs-content">
                    <!-- ETL preview container -->
                    <div id="etl-preview-bottom-panel" class="etl-preview-container" style="display:none"></div>
                </div>
            </div>
        `;
        
        this.elements.panelLeft = panelLeft;
        return panelLeft;
    }


    /**
     * Build the horizontal resizer between left and right panels
     */
    _buildResizer() {
        const resizer = document.createElement('div');
        resizer.className = 'resizer';
        resizer.id = 'resizer';
        this.elements.resizer = resizer;
        return resizer;
    }

    /**
     * Build the right panel (AI Assistant only — config panels are now inline slide-outs).
     */
    _buildPanelRight() {
        const panelRight = document.createElement('div');
        panelRight.className = 'panel right';

        panelRight.innerHTML = `
            <div class="right-panel-body">
                    <!-- Notes -->
                    <div class="collapsible-box" id="collapsible-box-notes" data-collapsible-id="notes" data-collapsible-default="collapsed" data-collapsible-group="right-sections">
                        <div class="collapsible-header" id="right-collapsible-header-notes" data-collapsible-header="true">
                            <button class="arrow-toggle" type="button">
                                <span class="collapsible-arrow collapsed material-symbols-outlined" id="right-collapsible-arrow-notes">expand_more</span>
                            </button>
                            <span>Notes</span>
                        </div>
                        <div class="collapsible-content" id="right-collapsible-content-notes" data-collapsible-content="true">
                            <textarea class="right-panel-notes" id="project-notes-textarea" placeholder="Scribble notes here..." spellcheck="false"></textarea>
                        </div>
                    </div>

                    <!-- AI Assistant -->
                    <div class="collapsible-box" id="collapsible-box-ai-chat" data-collapsible-id="ai-chat" data-collapsible-group="right-sections" data-collapsible-exclusive="true" data-collapsible-float="bottom" data-collapsible-fill="true" data-collapsible-default="collapsed">
                        <div class="collapsible-header" id="right-collapsible-header-ai-chat" data-collapsible-header="true">
                            <button class="arrow-toggle" type="button">
                                <span class="collapsible-arrow collapsed material-symbols-outlined" id="right-collapsible-arrow-ai-chat">expand_more</span>
                            </button>
                            <span>AI Assistant</span>
                            <span class="ai-status-dot" id="ai-status-indicator"></span>
                        </div>
                        <div class="collapsible-content" id="right-collapsible-content-ai-chat" data-collapsible-content="true" style="overflow:hidden;"></div>
                    </div>

                    <!-- Parameters (simulation page only, populated by SimulationRunPage) -->
                    <div class="collapsible-box" id="collapsible-box-config" data-collapsible-id="config" data-collapsible-default="expanded" data-collapsible-group="right-sections" style="display:none">
                        <div class="collapsible-header" id="right-collapsible-header-config" data-collapsible-header="true">
                            <button class="arrow-toggle" type="button">
                                <span class="collapsible-arrow material-symbols-outlined" id="right-collapsible-arrow-config">expand_more</span>
                            </button>
                            <span>Parameters</span>
                        </div>
                        <div class="collapsible-content visible" id="right-collapsible-content-config" data-collapsible-content="true"></div>
                    </div>
            </div>
        `;

        this.elements.panelRight = panelRight;
        return panelRight;
    }

    _installCustomScrollbars() {
        try {
            // Auto-discover ALL .tabs elements (existing + dynamically created)
            installTabsScrollbars();

            // Overlay scrollbars on collapsible content inside fixed-200 sidebar
            installCollapsibleScrollbars();

            const workspace = document.querySelector('.workspace');
            if (workspace) {
                workspace.style.overflow = 'auto';
                workspace.style.position = 'relative';
                installWorkspaceScrollbars(workspace, {
                    verticalClass: 'panel-scrollbar',
                    horizontalClass: 'tabs-scrollbar',
                    watchSubtree: true,
                });
            }

            const bottomTabsContent = document.getElementById('bottom-tabs-content');
            if (bottomTabsContent) {
                installOverlayScrollbar(bottomTabsContent, {
                    orientation: 'vertical',
                    className: 'panel-scrollbar',
                    watchSubtree: true,
                });
            }

        } catch (err) {
            this.logger?.warn?.('[ApplicationShell] Failed to install custom scrollbars', err);
        }
    }

    /**
     * Build the context menu
     */
    _buildContextMenu() {
        const contextMenu = document.createElement('div');
        contextMenu.id = 'contextMenu';
        contextMenu.className = 'context-menu';
        
        contextMenu.innerHTML = `
            <div class="context-menu-item hidden" id="deleteConnection">
                <span class="material-symbols-outlined">link_off</span>
                <span class="label">Delete Connection</span>
            </div>
            <div class="context-menu-item hidden" id="renameNode">
                <span class="material-symbols-outlined">edit</span>
                <span class="label">Rename</span>
            </div>
            <div class="context-menu-item hidden" id="editFunctionNode">
                <span class="material-symbols-outlined">edit_note</span>
                <span class="label">Edit Function</span>
            </div>
            <div class="context-menu-item hidden" id="duplicateNode">
                <span class="material-symbols-outlined">content_copy</span>
                <span class="label">Duplicate</span>
            </div>
            <div class="context-menu-item hidden" id="copyNode">
                <span class="material-symbols-outlined">file_copy</span>
                <span class="label">Copy</span>
            </div>
            <div class="context-menu-item hidden" id="cutNode">
                <span class="material-symbols-outlined">content_cut</span>
                <span class="label">Cut</span>
            </div>
            <div class="context-menu-item hidden" id="pasteCanvas">
                <span class="material-symbols-outlined">content_paste</span>
                <span class="label">Paste</span>
            </div>
            <div class="context-menu-item hidden" id="addCaption">
                <span class="material-symbols-outlined">title</span>
                <span class="label">Add Caption</span>
            </div>
            <div class="context-menu-item hidden" id="groupNodes">
                <span class="material-symbols-outlined">group_work</span>
                <span class="label">Group Selection</span>
                <span class="shortcut">Ctrl+G</span>
            </div>
            <div class="context-menu-item hidden" id="ungroupNodes">
                <span class="material-symbols-outlined">workspaces</span>
                <span class="label">Ungroup</span>
                <span class="shortcut">Ctrl+Shift+C</span>
            </div>
            <div class="context-menu-item hidden" id="addToDocumentation">
                <span class="material-symbols-outlined">post_add</span>
                <span class="label">Add to Documentation</span>
            </div>
            <div class="context-menu-item delete-node hidden" id="deleteNode">
                <span class="material-symbols-outlined">delete</span>
                <span class="label">Delete Node</span>
            </div>
        `;
        
        this.elements.contextMenu = contextMenu;
        return contextMenu;
    }

    /**
     * Build the toast container
     */
    _buildToastContainer() {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container';
        toastContainer.setAttribute('aria-live', 'polite');
        toastContainer.setAttribute('aria-atomic', 'true');
        this.elements.toastContainer = toastContainer;
        return toastContainer;
    }

    /**
     * Build the bottom status bar
     */
    _buildGlobalBottomBar() {
        const bottomBar = document.createElement('div');
        bottomBar.className = 'global-bottom-bar';
        
        bottomBar.innerHTML = `
            <div class="bar-left">
                <!-- Persistent project identity. Populated by
                     project_selector on project load; the :empty CSS
                     rule collapses it when no project is open. Click
                     to open the File menu — all project actions stay
                     in one place. -->
                <button type="button" class="project-chip" id="project-chip"
                        title="Project actions (File menu)"></button>
                <!-- Validation status indicator mounted by ValidationStatus component -->
                <div class="sim-status is-info" id="sim-status">BugDesk ready.</div>
                <!-- Current world tick — driven by model_status.js on every
                     ecoagent:run:tick event and the initial run-status fetch.
                     Lives on the LEFT side, next to sim-status, since they
                     describe the same thing (simulation state); the right
                     edge is reserved for the global notification-history
                     bell so that's the only thing the user sees there. -->
                <div class="sim-tick" id="sim-tick" title="Current world tick"></div>
            </div>
            <div class="bar-center"> &nbsp; </div>
            <div class="bar-right">
                <div class="bar-right-actions" aria-label="Global actions">
                    <!-- Streaming Connection Status (debug mode only) -->
                    <div class="streaming-status has-tooltip" id="streaming-status" style="display: none;" data-tooltip="WebSocket streaming disconnected">
                        <span class="streaming-status-label">WS:</span>
                        <span class="streaming-status-dot" id="streaming-status-dot"></span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(bottomBar);
        this.elements.bottomBar = bottomBar;
    }

    /**
     * Wire up left toolbar button events
     */
    _wireToolbarEvents() {
        const toolbar = document.querySelector('#fixed-left .fl-bar');
        if (!toolbar) return;
        
        toolbar.addEventListener('click', (e) => {
            const button = e.target.closest('.fl-item');
            if (!button) return;

            const tool = button.dataset.tool;
            if (!tool) return;

            // Update active state
            toolbar.querySelectorAll('.fl-item').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Switch mode
            this._switchMode(tool);

            // Emit event for other components
            this.eventBus?.emit('shell:mode-changed', { mode: tool });
        });

        toolbar.addEventListener('dblclick', (e) => {
            const button = e.target.closest('.fl-item');
            if (!button) return;
            if (button.dataset.tool === 'settings') return;

            document.getElementById('toggle-left-panel')?.click();
        });
    }

    /**
     * Wire event listener for mode switch requests from other components (e.g., global search)
     */
    _wireModeRequestEvents() {
        if (!this.eventBus || typeof this.eventBus.on !== 'function') return;

        this.eventBus.on('shell:request-mode', ({ mode }) => {
            if (!mode) return;

            // Update toolbar active state
            const toolbar = document.querySelector('.fl-bar');
            if (toolbar) {
                toolbar.querySelectorAll('.fl-item').forEach(btn => btn.classList.remove('active'));
                const targetBtn = toolbar.querySelector(`.fl-item[data-tool="${mode}"]`);
                if (targetBtn) {
                    targetBtn.classList.add('active');
                }
            }

            // Switch mode
            this._switchMode(mode);

            // Emit event for other components
            this.eventBus?.emit('shell:mode-changed', { mode });
        });

    }

    /**
     * Switch the UI mode (flow/scenarios/database/settings)
     */
    async _switchMode(mode) {
        const dataPage = document.getElementById('data-page');
        const fixed200 = document.getElementById('fixed-200');
        const dataContent = document.getElementById('fixed-200-data');
        const settingsPageEl = document.getElementById('settings-page');
        const settingsContent = document.getElementById('fixed-200-settings');
        const etlContent = document.getElementById('fixed-200-etl');
        const etlManagerPageEl = document.getElementById('etl-manager-page');
        const notebookMain = document.getElementById('notebook-main');
        const notebookContent = document.getElementById('fixed-200-notebook');

        // Sync fl-bar active state with current mode
        this._syncFlBarActiveState(mode);

        // Toggle top-bar content: sim controls in simulation-run mode, notebook toolbar in notebook mode
        const showSimControls = (mode === 'simulation-run');
        const showNotebookToolbar = (mode === 'notebook');
        const simControls = this.elements.simTopBar?.querySelector('.sim-controls');
        const solverSettings = this.elements.simTopBar?.querySelector('.solver-settings-compact');
        const cellWidthToggle = document.getElementById('cell-width-toggle-btn');
        const timeDisplay = this.elements.simTopBar?.querySelector('.time-display');
        const breadcrumb = this.elements.topBarBreadcrumb;
        const notebookSlot = this.elements.notebookToolbarSlot;
        const topBar = this.elements.simTopBar;
        if (topBar) topBar.style.display = '';
        if (simControls) simControls.style.display = showSimControls ? '' : 'none';
        if (solverSettings) solverSettings.style.display = showSimControls ? '' : 'none';
        if (cellWidthToggle) cellWidthToggle.style.display = showSimControls ? '' : 'none';
        if (timeDisplay) timeDisplay.style.display = showSimControls ? '' : 'none';
        if (notebookSlot) notebookSlot.style.display = showNotebookToolbar ? '' : 'none';
        if (breadcrumb) {
            breadcrumb.style.display = showSimControls ? 'none' : '';
            breadcrumb.style.flex = showNotebookToolbar ? '0 1 auto' : '';
        }

        // In simulation-run mode, hide loop analysis and model tests buttons
        const loopBtn = document.getElementById('loop-analysis-button');
        const testsBtn = document.getElementById('model-tests-button');
        if (loopBtn) loopBtn.style.display = (mode === 'simulation-run') ? 'none' : '';
        if (testsBtn) testsBtn.style.display = (mode === 'simulation-run') ? 'none' : '';

        // Clean up previous mode if leaving database
        if (this._currentMode === 'database' && mode !== 'database') {
            if (window.DataPage?.hide) {
                window.DataPage.hide();
            }
        }

        // Clean up previous mode if leaving settings
        if (this._currentMode === 'settings' && mode !== 'settings') {
            this.settingsPage?.onDeactivated?.();
            this.settingsPage?.hide?.();
        }

        // Clean up previous mode if leaving etl
        if (this._currentMode === 'etl' && mode !== 'etl') {
            this.etlManagerPage?.onDeactivated?.();
            this.etlManagerPage?.hide?.();

            // Clear inline resizer styles so CSS flex rule takes over on re-entry
            if (etlManagerPageEl) {
                etlManagerPageEl.style.flex = '';
                etlManagerPageEl.style.height = '';
            }

            // Restore bottom panel content
            const etlPanel = document.getElementById('etl-preview-bottom-panel');
            if (etlPanel) { etlPanel.style.display = 'none'; etlPanel.innerHTML = ''; }
        }

        // Clean up previous mode if leaving paper
        if (this._currentMode === 'paper' && mode !== 'paper') {
            this.paperPage?.onDeactivated?.();
        }

        // Clean up previous mode if leaving simulation-run
        if (this._currentMode === 'simulation-run' && mode !== 'simulation-run') {
            this.simulationRunPage?.onDeactivated?.();
        }

        // Hide all pages first
        const simulationRunMain = document.getElementById('simulation-run-main');
        const paperMain = document.getElementById('paper-main');
        if (dataPage) dataPage.style.display = 'none';
        if (settingsPageEl) settingsPageEl.style.display = 'none';
        if (etlManagerPageEl) etlManagerPageEl.style.display = 'none';
        if (notebookMain) notebookMain.style.display = 'none';
        if (simulationRunMain) simulationRunMain.style.display = 'none';
        if (paperMain) paperMain.style.display = 'none';

        // Hide all fixed-200 panel content sections
        if (dataContent) dataContent.style.display = 'none';
        if (settingsContent) settingsContent.style.display = 'none';
        if (etlContent) etlContent.style.display = 'none';
        if (notebookContent) notebookContent.style.display = 'none';
        const paperContent = document.getElementById('fixed-200-paper');
        if (paperContent) paperContent.style.display = 'none';
        const simulationContent = document.getElementById('fixed-200-simulation');
        if (simulationContent) simulationContent.style.display = 'none';

        // ── Set current mode + panel FSM transitions BEFORE page activation ──
        this._currentMode = mode;
        this._persistModeState(mode);

        // Right panel: always available (Notes + AI on all pages, Parameters on simulation-run)
        this._rightPanelFSM.clearTriggers();
        this._rightPanelFSM.enable();

        // Parameters collapsible: only visible on simulation-run page
        const configBox = document.getElementById('collapsible-box-config');
        if (configBox) configBox.style.display = (mode === 'simulation-run') ? '' : 'none';

        // Bottom panel: always enabled, on every mode. It is the global
        // observability surface (EcoAgent's Population / Run Console /
        // InfoBus / Event Log on EcoAgent modes; ETL preview on ETL).
        // Disabling it on Settings / Notebook / Paper / etc. made the
        // toggle button greyed-out and the panel invisible there, which
        // is the opposite of what "global" implies. Modes that need a
        // specific bottom-panel content (ETL) swap their child element
        // in elsewhere in this method; modes that don't just keep
        // showing whatever was last in there.
        this._bottomPanelFSM.supportsCollapse = true;
        this._bottomPanelFSM.enable();
        this._bottomPanelFSM.reapply();

        switch (mode) {
            case 'notebook':
                if (notebookMain) notebookMain.style.display = '';
                if (notebookContent) notebookContent.style.display = '';
                if (fixed200) fixed200.dataset.activeContent = 'notebook';
                this.onNavigate?.('notebook');
                break;

            case 'paper': {
                if (paperMain) paperMain.style.display = '';
                const paperPanel = document.getElementById('fixed-200-paper');
                if (paperPanel) paperPanel.style.display = '';
                if (fixed200) fixed200.dataset.activeContent = 'paper';
                this.onNavigate?.('paper');
                this.paperPage?.show?.();
                this.paperPage?.onActivated?.();
                this.eventBus?.emit?.('view:page:activated', { page: 'paper' });
                break;
            }

            case 'simulation-run': {
                if (simulationRunMain) simulationRunMain.style.display = '';
                const simContent = document.getElementById('fixed-200-simulation');
                if (simContent) simContent.style.display = 'flex';
                if (fixed200) fixed200.dataset.activeContent = 'simulation';
                await this.#ensureSimulationRunPage();
                this.simulationRunPage?.show?.();
                this.simulationRunPage?.onActivated?.();
                this.eventBus?.emit?.('view:page:activated', { page: 'simulation-run' });
                break;
            }

            case 'database':
                if (dataPage) dataPage.style.display = '';
                if (dataContent) dataContent.style.display = 'block';
                if (fixed200) fixed200.dataset.activeContent = 'data';
                if (window.DataPage?.show) {
                    window.DataPage.show();
                }
                break;

            case 'settings': {
                if (settingsPageEl) settingsPageEl.style.display = '';
                if (settingsContent) settingsContent.style.display = 'flex';
                if (fixed200) fixed200.dataset.activeContent = 'settings';
                this._ensureSettingsPage();
                this.settingsPage?.show?.();
                this.settingsPage?.onActivated?.();
                this.eventBus?.emit?.('view:page:activated', { page: 'settings' });
                break;
            }

            case 'etl': {
                if (etlManagerPageEl) etlManagerPageEl.style.display = '';
                if (etlContent) etlContent.style.display = 'flex';
                if (fixed200) fixed200.dataset.activeContent = 'etl';
                this.#ensureETLManagerPage();
                this.etlManagerPage?.show?.();
                this.etlManagerPage?.onActivated?.();
                this.eventBus?.emit?.('view:page:activated', { page: 'etl' });

                // Swap bottom panel content to ETL
                const etlPanel = document.getElementById('etl-preview-bottom-panel');
                if (etlPanel) etlPanel.style.display = '';
                break;
            }
        }

        // Emit mode change event for legacy components
        if (window.eventManager?.emit) {
            window.eventManager.emit('ui:modeChanged', { mode });
        }
    }

    /**
     * Sync the fl-bar active button state with the current mode
     * @param {string} mode - The mode to activate (flow, scenario, database, settings)
     */
    _syncFlBarActiveState(mode) {
        const toolbar = document.querySelector('#fixed-left .fl-bar');
        if (!toolbar) return;

        // Remove active from all buttons
        toolbar.querySelectorAll('.fl-item').forEach(btn => btn.classList.remove('active'));

        const flBarMode = mode;

        // Find and activate the button matching the mode
        const targetButton = toolbar.querySelector(`.fl-item[data-tool="${flBarMode}"]`);
        if (targetButton) {
            targetButton.classList.add('active');
        }
    }

    /**
     * Ensure the Functions page is instantiated and mounted
     */
    /**
     * Ensure the Settings page is instantiated and mounted
     */
    _ensureSettingsPage() {
        if (this.settingsPage) return;

        const container = document.getElementById('settings-page');
        if (!container) {
            this.logger?.warn?.('[ApplicationShell] Settings page container not found');
            return;
        }

        this.settingsPage = new SettingsPage({
            eventBus: this.eventBus,
            dataManager: this.dataManager,
            notificationCenter: window.NotificationCenter || null,
            logger: this.logger,
        });

        this.settingsPage.mount(container);
    }

    /**
     * Ensure the Scenario Manager page is instantiated and mounted
     */
    async #ensureSimulationRunPage() {
        if (this._simulationRunMounted) return;

        const container = document.getElementById('simulation-run-main');
        if (!container || !this.simulationRunPage) return;

        await this.simulationRunPage.mount(container);
        this._simulationRunMounted = true;
    }

    /**
     * Ensure the ETL pipeline editor page is instantiated and mounted.
     */
    #ensureETLManagerPage() {
        if (this.etlManagerPage) return;

        const container = document.getElementById('etl-manager-page');
        if (!container) {
            this.logger?.warn?.('[ApplicationShell] ETL manager page container not found');
            return;
        }

        this.etlManagerPage = new ETLManagerPage({
            eventBus: this.eventBus,
            dataManager: this.dataManager,
            notificationCenter: window.NotificationCenter || null,
            logger: this.logger,
            hostBridge: window.pywebview?.api || null,
            projectModel: this.projectModel || null,
        });

        this.etlManagerPage.mount(container);
    }

    /**
     * Ensure the Notebook page is instantiated and mounted.
     */
    /**
     * Return the visible "top area" element for the current mode.
     * In flow mode this is `.left-top` (canvas + tabs); in ETL mode
     * it is `#etl-manager-page`.  Used by the vertical resizer and
     * the bottom-panel collapse callback so they target the correct element.
     */
    _getActiveTopElement() {
        if (this._currentMode === 'etl') {
            return document.getElementById('etl-manager-page');
        }
        // Extra modes (agents / markets / sfc / analytics / events) each
        // insert a `<div class="ea-mode-page" id="<mode>-main">` BEFORE
        // `.vertical-resizer` in `.panel.left`. Only one is visible at a
        // time. Without this branch the resizer would size `.left-top`
        // (Ecosim's flow-mode top), which is hidden under our modes —
        // resulting in the vertical-splitter "drag offset" bug.
        for (const el of document.querySelectorAll('.ea-mode-page')) {
            if (el.offsetParent !== null) return el;
        }
        return document.querySelector('.left-top');
    }

    /**
     * Create the bottom panel FSM with DOM callbacks.
     * @returns {PanelStateMachine}
     */
    _createBottomPanelFSM() {
        const shell = this;
        return new PanelStateMachine({
            name: 'bottom',
            eventBus: this.eventBus,
            logger: this.logger,
            persistenceKey: 'ecosim.bottomPanel.v3',
            defaultPinned: true,
            callbacks: {
                onShow(_reason) {
                    const leftBottom = document.querySelector('.left-bottom');
                    const vertResizer = document.getElementById('vertical-resizer');
                    if (!leftBottom) return;

                    const h = shell._bottomPanelFSM?.getHeight() || 260;
                    leftBottom.style.display = '';
                    leftBottom.style.flex = `0 0 ${h}px`;
                    leftBottom.style.height = `${h}px`;
                    leftBottom.classList.remove('collapsed');
                    if (vertResizer) vertResizer.style.display = '';
                    // bottom-tabs-content display is managed by onCollapseChanged.
                    // onShow only manages the container.
                },
                onHide(_reason) {
                    const leftBottom = document.querySelector('.left-bottom');
                    const vertResizer = document.getElementById('vertical-resizer');
                    if (leftBottom) leftBottom.style.display = 'none';
                    if (vertResizer) vertResizer.style.display = 'none';
                },
                // NOTE: onDisable/onEnable/onPinChanged/onVisibilityChanged
                // intentionally do NOT touch #toggle-bottom-panel. The tiling
                // WM owns that button's visual state (.panel-toggle-btn--on);
                // the FSM only manages the panel DOM. See retireLegacyPanels().
                onCollapseChanged(collapsed, height) {
                    const leftBottom = document.querySelector('.left-bottom');
                    const topEl = shell._getActiveTopElement();
                    const content = document.getElementById('bottom-tabs-content');
                    const arrow = document.getElementById('bottom-tabs-arrow');
                    const vertResizer = document.getElementById('vertical-resizer');
                    if (!leftBottom) return;

                    if (collapsed) {
                        const currentH = leftBottom.getBoundingClientRect().height;
                        if (currentH > 40) shell._bottomPanelFSM?.setHeight(currentH);
                        leftBottom.classList.add('collapsed');
                        if (content) content.style.display = 'none';
                        // Let CSS sink the panel to exactly the strip's
                        // intrinsic size via `height: auto` + `flex: 0 0
                        // auto`. The previous approach measured the
                        // strip's getBoundingClientRect height and wrote
                        // that as an inline pixel value — which (a)
                        // collided with .left-bottom's min-height: 30px
                        // floor, and (b) included a stale measurement
                        // when the strip's children resized after the
                        // collapse, leaving a few stray pixels of empty
                        // space below the strip's bottom border.
                        leftBottom.style.flex = '0 0 auto';
                        leftBottom.style.height = '';
                        if (vertResizer) vertResizer.style.display = 'none';
                        if (topEl) {
                            topEl.style.flex = '1 1 auto';
                            topEl.style.height = '';
                        }
                    } else {
                        const h = height || leftBottom.getBoundingClientRect().height || 260;
                        leftBottom.style.flex = `0 0 ${h}px`;
                        leftBottom.style.height = `${h}px`;
                        leftBottom.classList.remove('collapsed');
                        if (content) content.style.display = '';
                        if (vertResizer) vertResizer.style.display = '';
                    }
                    if (arrow) {
                        arrow.textContent = collapsed ? 'expand_less' : 'expand_more';
                        arrow.classList.toggle('collapsed', collapsed);
                    }
                },
            },
        });
    }

    /**
     * Create the right panel FSM with DOM callbacks.
     * @returns {PanelStateMachine}
     */
    _createRightPanelFSM() {
        const shell = this;
        return new PanelStateMachine({
            name: 'right',
            eventBus: this.eventBus,
            logger: this.logger,
            persistenceKey: 'ecosim.rightPanel.v3',
            defaultPinned: true,
            callbacks: {
                onShow(_reason) {
                    const container = shell.elements.container;
                    if (container) container.classList.remove('right-panel-hidden');
                },
                onHide(_reason) {
                    const container = shell.elements.container;
                    if (!container) return;
                    const rightPanel = document.querySelector('.panel.right');
                    if (rightPanel) {
                        rightPanel.style.flex = '';
                        rightPanel.style.width = '';
                        rightPanel.style.minWidth = '';
                        rightPanel.style.display = '';
                    }
                    const leftPanel = document.querySelector('.panel.left');
                    if (leftPanel) leftPanel.style.flex = '';
                    container.classList.add('right-panel-hidden');
                },
                // NOTE: no onDisable/onEnable/onPinChanged/onVisibilityChanged
                // button writes — the tiling WM owns #toggle-right-panel's
                // visual state. The FSM only manages the right-panel DOM.
            },
        });
    }

    /**
     * Wire all panel-related events: toggle clicks, ETL panel config,
     * welcome screen, etc.
     */
    _wirePanelEvents() {
        const container = this.elements.container;
        if (!container) return;

        // ── Left panel toggle (simple, no FSM) ─────────────────────────────
        // The tiling shell re-wires this button to wm.togglePanel('left')
        // and owns its visual state, so we neither seed `.active` (it would
        // survive the button clone as a stale highlight) nor toggle it here.
        const leftToggle = document.getElementById('toggle-left-panel');
        if (leftToggle) {
            leftToggle.addEventListener('click', () => {
                if (this._welcomeScreenActive) return;
                container.classList.toggle('left-panel-hidden');
            });
        }

        // ── Right panel toggle ──────────────────────────────────────────────
        const rightToggle = document.getElementById('toggle-right-panel');
        if (rightToggle) {
            rightToggle.addEventListener('click', () => {
                if (this._welcomeScreenActive) return;
                this._rightPanelFSM.togglePin();
            });
        }

        // ── Bottom panel toolbar toggle ──────────────────────────────────────
        // Delegates to FSM.toggle() which picks the right action based on state + config:
        //   flow (pinned + supportsCollapse) → toggleCollapse
        //   etl (on-demand, no collapse)     → togglePin
        const bottomToggle = document.getElementById('toggle-bottom-panel');
        if (bottomToggle) {
            bottomToggle.addEventListener('click', () => {
                if (this._welcomeScreenActive) return;
                this._bottomPanelFSM.toggle();
            });
        }

        // ── Bottom panel collapse/expand arrow ──────────────────────────────
        // Mirrors the topbar #toggle-bottom-panel button so both controls
        // behave identically on every page: FSM.toggle() picks the right
        // action per state (collapse/expand when pinned+supportsCollapse,
        // pin/unpin otherwise). Hard-wiring this arrow to toggleCollapse()
        // made it a no-op in modes without collapse support, which the
        // topbar button still serviced — an inconsistency between the two.
        const bottomTabsToggle = document.getElementById('bottom-tabs-toggle');
        if (bottomTabsToggle) {
            bottomTabsToggle.addEventListener('click', () => {
                if (this._welcomeScreenActive) return;
                this._bottomPanelFSM.toggle();
            });
        }

        // ── EventBus subscriptions ──────────────────────────────────────────
        if (!this.eventBus || typeof this.eventBus.on !== 'function') return;

        const subscribe = (eventName, handler) => {
            const disposer = this.eventBus.on(eventName, handler);
            if (disposer) this._busSubscriptions.push(disposer);
        };

        // ETL page reports its bottom-panel intent. The panel itself is
        // always enabled (set in _switchMode); we just reapply so the
        // panel's chrome resyncs after ETL swaps its preview content.
        subscribe('etl:panels:configure', ({ bottomPanel: _bp }) => {
            if (this._panelsOwnedByWM) return;   // WM owns the panels now
            if (this._currentMode !== 'etl') return;
            this._bottomPanelFSM.supportsCollapse = true;
            this._bottomPanelFSM.enable();
            this._bottomPanelFSM.reapply();
        });

        // Welcome screen — hide all panels and disable toggles
        subscribe('welcome-screen:shown', () => {
            this._welcomeScreenActive = true;
            // Once the WM owns the panels, all the chrome this handler hides
            // (fixed rails, workspace top bar, the toggle button, the FSMs)
            // is WM-owned or removed — leave it alone.
            if (this._panelsOwnedByWM) return;

            this._rightPanelFSM.setOverrideHidden(true);
            this._bottomPanelFSM.setOverrideHidden(true);

            // Hide chrome
            const fixedLeft = document.getElementById('fixed-left');
            const fixed200 = document.getElementById('fixed-200');
            const topBar = document.querySelector('.workspace-top-bar');
            if (fixedLeft) fixedLeft.style.display = 'none';
            if (fixed200) fixed200.style.display = 'none';
            if (topBar) topBar.style.display = 'none';

            // Disable left toggle (not FSM-managed)
            if (leftToggle) {
                leftToggle.classList.remove('active');
                leftToggle.disabled = true;
            }
        });

        subscribe('welcome-screen:hidden', () => {
            this._welcomeScreenActive = false;
            if (this._panelsOwnedByWM) return;   // WM owns the panels + chrome

            // Restore chrome
            const fixedLeft = document.getElementById('fixed-left');
            const fixed200 = document.getElementById('fixed-200');
            const topBar = document.querySelector('.workspace-top-bar');
            if (fixedLeft) fixedLeft.style.display = '';
            if (fixed200) fixed200.style.display = '';
            if (topBar) topBar.style.display = '';

            this._rightPanelFSM.setOverrideHidden(false);
            this._bottomPanelFSM.setOverrideHidden(false);

            // Re-enable left toggle
            if (leftToggle) {
                leftToggle.disabled = false;
                leftToggle.classList.toggle('active', !container?.classList.contains('left-panel-hidden'));
            }
        });
    }

    _wireMenuEvents() {
        const menu = document.querySelector('.app-menu');
        if (!menu) return;

        const handleMenuClick = (event) => {
            const entry = event.target.closest('.menu-entry');
            if (entry) {
                // Submenu trigger — don't close, let hover handle the flyout
                if (entry.classList.contains('menu-entry--has-submenu')) return;
                // Clicked on a menu entry - execute action and close
                event.preventDefault();
                const actionId = entry.id || entry.dataset.action;
                if (actionId) {
                    if (this.eventBus?.emit) {
                        this.eventBus.emit('menu:action', { actionId });
                    }
                    if (typeof this.onMenuAction === 'function') {
                        try {
                            this.onMenuAction(actionId);
                        } catch (error) {
                            this.logger?.warn?.('[ApplicationShell] onMenuAction failed', { actionId, error });
                        }
                    }
                }
                this.#closeMenuDropdowns();
                return;
            }

            // Clicked on a menu item header - toggle dropdown
            const menuItem = event.target.closest('.menu-item');
            if (menuItem) {
                event.stopPropagation();
                const wasOpen = menuItem.classList.contains('open');
                // Close all dropdowns first
                this.#closeMenuDropdowns();
                if (!wasOpen) {
                    // Open this one and lock menu (disable hover on other items)
                    menuItem.classList.add('open');
                    menu.classList.add('menu-locked');
                    // Let listeners refresh just-in-time state (e.g. the undo
                    // bridge re-polls history so Edit▸Undo/Redo enable
                    // correctly — agent edits don't emit project:changed).
                    this.eventBus?.emit?.('menu:opened');
                }
            }
        };

        menu.addEventListener('click', handleMenuClick);
        this._boundHandlers.set('menu-click', handleMenuClick);

        // Hover-to-switch: when a dropdown is open, hovering another header switches to it
        const handleMenuHover = (event) => {
            if (!menu.classList.contains('menu-locked')) return;
            const menuItem = event.target.closest('.menu-item');
            if (menuItem && !menuItem.classList.contains('open')) {
                menu.querySelectorAll('.menu-item.open').forEach((el) => el.classList.remove('open'));
                menuItem.classList.add('open');
            }
        };

        menu.addEventListener('mouseover', handleMenuHover);
        this._boundHandlers.set('menu-hover', handleMenuHover);

        const handleDocumentClick = (event) => {
            const isMenu = event.target.closest('.app-menu');
            if (!isMenu) {
                this.#closeMenuDropdowns();
            }
        };

        document.addEventListener('click', handleDocumentClick);
        this._boundHandlers.set('menu-doc-click', handleDocumentClick);

        // Escape key closes menu
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                const hasOpen = menu.querySelector('.menu-item.open');
                if (hasOpen) {
                    this.#closeMenuDropdowns();
                    event.preventDefault();
                    event.stopPropagation();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        this._boundHandlers.set('menu-keydown', handleKeyDown);
    }

    #closeMenuDropdowns() {
        const menu = document.querySelector('.app-menu');
        if (menu) {
            menu.classList.remove('menu-locked');
        }
        document.querySelectorAll('.menu-item.open').forEach((el) => el.classList.remove('open'));
    }

    /**
     * Render the recent-files flyout submenu content.
     * @param {Array<{path: string, name: string}>} recentFiles
     */
    updateRecentFilesMenu(recentFiles) {
        const submenu = document.getElementById('menu-recent-submenu');
        if (!submenu) return;

        // The active project is shown by the bar-left chip + its
        // popover; filter it out here so it doesn't appear twice in
        // the Open Recent flyout. The chip stores the path on
        // data-path (see project_selector._setProjectChip).
        const currentPath = document.getElementById('project-chip')
            ?.dataset?.path || '';

        const visible = (recentFiles || []).filter(
            (f) => !currentPath || f.path !== currentPath,
        );

        if (visible.length === 0) {
            const msg = (recentFiles?.length && currentPath)
                ? 'No other recent projects'
                : 'No recent projects';
            submenu.innerHTML = `<button class="menu-entry" disabled>${msg}</button>`;
            return;
        }

        // Every entry routes through the project-open dispatcher — the
        // File menu deals exclusively in projects now (workspace.json
        // open/save is no longer wired through the menu).
        const entries = visible.map((f) => `
            <button class="menu-entry menu-entry--recent"
                    data-action="menu-project-recent:${f.path}" title="${f.path}">
                ${f.name}
            </button>
        `).join('');

        submenu.innerHTML = `
            ${entries}
            <hr class="menu-sep" />
            <button class="menu-entry menu-entry--clear-recent" data-action="menu-file-clear-recent">Clear recent projects</button>
        `;
    }


    _wireHistoryEvents() {
        if (!this.eventBus || typeof this.eventBus.on !== 'function') return;
        const handler = ({ canUndo, canRedo } = {}) => {
            const undoBtn = document.getElementById('menu-edit-undo');
            const redoBtn = document.getElementById('menu-edit-redo');
            if (undoBtn) {
                undoBtn.disabled = !canUndo;
                undoBtn.classList.toggle('disabled', !canUndo);
                undoBtn.setAttribute('aria-disabled', canUndo ? 'false' : 'true');
            }
            if (redoBtn) {
                redoBtn.disabled = !canRedo;
                redoBtn.classList.toggle('disabled', !canRedo);
                redoBtn.setAttribute('aria-disabled', canRedo ? 'false' : 'true');
            }
        };
        const disposer = this.eventBus.on('history:state', handler);
        if (typeof disposer === 'function') {
            this._busSubscriptions.push(disposer);
        }

        // Wire streaming delta events to update time display (WebSocket streaming)
        const streamingDeltaHandler = ({ data } = {}) => {
            const timeDisplay = document.getElementById('current-time-display');
            if (!timeDisplay) return;

            // StreamingData has a time array property
            const timeArray = data?.time;
            if (Array.isArray(timeArray) && timeArray.length > 0) {
                const lastTime = timeArray[timeArray.length - 1];
                if (typeof lastTime === 'number' && Number.isFinite(lastTime)) {
                    timeDisplay.textContent = lastTime.toFixed(2);
                }
            }
        };
        const streamingDeltaDisposer = this.eventBus.on('streaming:delta', streamingDeltaHandler);
        if (typeof streamingDeltaDisposer === 'function') {
            this._busSubscriptions.push(streamingDeltaDisposer);
        }

        // Handle streaming completion - show final time
        const streamingCompleteHandler = ({ data } = {}) => {
            const timeDisplay = document.getElementById('current-time-display');
            if (!timeDisplay) return;

            const timeArray = data?.time;
            if (Array.isArray(timeArray) && timeArray.length > 0) {
                const lastTime = timeArray[timeArray.length - 1];
                if (typeof lastTime === 'number' && Number.isFinite(lastTime)) {
                    timeDisplay.textContent = lastTime.toFixed(2);
                }
            }
        };
        const streamingCompleteDisposer = this.eventBus.on('streaming:complete', streamingCompleteHandler);
        if (typeof streamingCompleteDisposer === 'function') {
            this._busSubscriptions.push(streamingCompleteDisposer);
        }

        // Handle Monte Carlo progress - update time display with simulation end time during parallel phase
        // This ensures time display doesn't freeze after first streaming run completes
        const mcProgressHandler = ({ simTimeEnd, firstRunStreaming } = {}) => {
            const timeDisplay = document.getElementById('current-time-display');
            if (!timeDisplay) return;

            // During parallel MC phase (not first run streaming), show the simulation end time
            // The first run already completed to T_end, so that's the effective "current" simulation time
            if (!firstRunStreaming && typeof simTimeEnd === 'number' && Number.isFinite(simTimeEnd)) {
                timeDisplay.textContent = simTimeEnd.toFixed(2);
            }
        };
        const mcProgressDisposer = this.eventBus.on('streaming:mc-progress', mcProgressHandler);
        if (typeof mcProgressDisposer === 'function') {
            this._busSubscriptions.push(mcProgressDisposer);
        }
    }

    /**
     * Wire simulation status events to update the bottom bar status text
     */
    _wireSimulationStatusEvents() {
        if (!this.eventBus || typeof this.eventBus.on !== 'function') return;

        const statusEl = document.getElementById('sim-status');
        if (!statusEl) return;

        const setStatus = (message, tone = 'info') => {
            statusEl.textContent = message;
            const tones = ['info', 'success', 'warn', 'error', 'progress'];
            tones.forEach(t => statusEl.classList.remove(`is-${t}`));
            if (tones.includes(tone)) {
                statusEl.classList.add(`is-${tone}`);
            }
        };

        // Phase changed
        const phaseHandler = ({ next, prev } = {}) => {
            const phase = next || 'idle';
            const messages = {
                idle: 'Ready.',
                starting: 'Starting simulation…',
                running: 'Running…',
                paused: 'Paused.',
                stopping: 'Stopping…',
                complete: 'Complete.',
                error: 'Error.',
            };
            const tones = {
                idle: 'info',
                starting: 'progress',
                running: 'progress',
                paused: 'info',
                stopping: 'progress',
                complete: 'success',
                error: 'error',
            };
            setStatus(messages[phase] || 'Ready.', tones[phase] || 'info');
        };
        const phaseDisposer = this.eventBus.on('simulation:phase:changed', phaseHandler);
        if (typeof phaseDisposer === 'function') {
            this._busSubscriptions.push(phaseDisposer);
        }

        // Run progress - show progress percentage and speed (handles both regular and Monte Carlo)
        const progressHandler = (payload = {}) => {
            const { progress, playback, type, currentRun, totalRuns, parallelWorkers, activeWorkers, firstRunStreaming } = payload;

            // Monte Carlo progress - show run count and overall completion
            if (type === 'monte-carlo' && totalRuns) {
                const percent = Math.round((progress ?? 0) * 100);
                let statusText;

                const completedRuns = currentRun ?? 0;
                statusText = `Monte Carlo: ${completedRuns}/${totalRuns} runs completed`;
                if (parallelWorkers && parallelWorkers > 1 && completedRuns < totalRuns) {
                    const active = activeWorkers ?? parallelWorkers;
                    if (active > 0) {
                        statusText += ` (${active} workers)`;
                    }
                }
                statusText += ` · ${percent}%`;
                setStatus(statusText, 'progress');
                return;
            }

            // Regular simulation progress
            const percent = Math.round((progress ?? 0) * 100);
            let parts = [`${percent}%`];
            if (playback?.mode) {
                const speedLabels = { 1: '¼×', 2: '½×', 3: '1×', 4: 'Max' };
                const speedLabel = speedLabels[playback.mode] || `Mode ${playback.mode}`;
                parts.push(speedLabel);
            }
            setStatus(parts.join(' · '), 'progress');
        };
        const progressDisposer = this.eventBus.on('simulation:run:progress', progressHandler);
        if (typeof progressDisposer === 'function') {
            this._busSubscriptions.push(progressDisposer);
        }

        // Run completed
        const completedHandler = ({ result } = {}) => {
            setStatus('Simulation complete.', 'success');
        };
        const completedDisposer = this.eventBus.on('simulation:run:completed', completedHandler);
        if (typeof completedDisposer === 'function') {
            this._busSubscriptions.push(completedDisposer);
        }

        // Run failed
        const failedHandler = ({ error } = {}) => {
            const msg = error?.message || error || 'Simulation failed.';
            setStatus(typeof msg === 'string' ? msg : 'Simulation failed.', 'error');
        };
        const failedDisposer = this.eventBus.on('simulation:run:failed', failedHandler);
        if (typeof failedDisposer === 'function') {
            this._busSubscriptions.push(failedDisposer);
        }

        // Run stopped
        const stoppedHandler = () => {
            setStatus('Simulation stopped.', 'warn');
        };
        const stoppedDisposer = this.eventBus.on('simulation:run:stopped', stoppedHandler);
        if (typeof stoppedDisposer === 'function') {
            this._busSubscriptions.push(stoppedDisposer);
        }

        // Run paused
        const pausedHandler = () => {
            setStatus('Paused.', 'info');
        };
        const pausedDisposer = this.eventBus.on('simulation:run:paused', pausedHandler);
        if (typeof pausedDisposer === 'function') {
            this._busSubscriptions.push(pausedDisposer);
        }

        // Playback mode updated - update speed display
        const playbackHandler = ({ playback } = {}) => {
            // Only update if we're running
            const statusText = statusEl.textContent || '';
            if (statusText.includes('%') && playback?.mode) {
                const speedLabels = { 1: '¼×', 2: '½×', 3: '1×', 4: 'Max' };
                const speedLabel = speedLabels[playback.mode] || `Mode ${playback.mode}`;
                // Extract progress from current text
                const match = statusText.match(/(\d+)%/);
                if (match) {
                    setStatus(`${match[1]}% · ${speedLabel}`, 'progress');
                }
            }
        };
        const playbackDisposer = this.eventBus.on('simulation:playback:updated', playbackHandler);
        if (typeof playbackDisposer === 'function') {
            this._busSubscriptions.push(playbackDisposer);
        }
    }


    /**
     * Escape HTML entities for safe insertion into HTML attributes/content
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     */
    /**
     * Wire simulation control buttons (play/pause/stop) and solver settings.
     * Manages button enabled/disabled state based on simulation phase.
     */
    _wireSimulationControlButtons() {
        // Run / Pause / Stop are owned by runtime_controls (→ world_run_async
        // over the WebSocket); this wires only the analysis-tool buttons +
        // toolbar inputs.

        // Cache DOM elements
        const steadyStateBtn = document.getElementById('steady-state-button');
        const bifurcationBtn = document.getElementById('bifurcation-button');
        const impulseBtn = document.getElementById('impulse-response-button');
        const calibrationBtn = document.getElementById('calibration-button');
        const policyDesignerBtn = document.getElementById('policy-designer-button');
        const loopAnalysisBtn = document.getElementById('loop-analysis-button');
        const modelTestsBtn = document.getElementById('model-tests-button');
        const cellWidthToggleBtn = document.getElementById('cell-width-toggle-btn');
        const solverSettingsBtn = document.getElementById('solver-settings-btn');
        const scenarioSelect = document.getElementById('sim-scenario-select-top');
        const scenarioConfigBtn = document.getElementById('scenario-config-btn');
        const scenarioSaveBtn = document.getElementById('scenario-save-btn');
        const scenarioSaveAsBtn = document.getElementById('scenario-save-as-btn');
        const solverSelect = document.getElementById('sim-solver-method-top');
        const t0Input = document.getElementById('sim-t0-top');
        const t1Input = document.getElementById('sim-t1-top');
        const dtInput = document.getElementById('sim-dt-top');

        // Solver tolerance state
        let solverSettings = { rtol: 1e-3, atol: 1e-6 };

        // ── Button click handlers ──
        const bind = (btn, handler) => {
            if (!btn) return;
            const wrapped = () => { handler()?.catch?.((err) => this.logger?.warn?.('[SimControlButtons] Action failed', err)); };
            btn.addEventListener('click', wrapped);
        };

        // Tools buttons emit events (handled by bootstrap menu actions or dedicated windows)
        bind(steadyStateBtn, async () => { this.eventBus?.emit?.('tools:steady-state:open'); });
        bind(bifurcationBtn, async () => { this.eventBus?.emit?.('tools:bifurcation:open'); });
        bind(impulseBtn, async () => { this.eventBus?.emit?.('tools:impulse-response:open'); });
        bind(calibrationBtn, () => { this.eventBus?.emit?.('tools:calibration:open'); });
        bind(policyDesignerBtn, () => { this.eventBus?.emit?.('tools:policy-designer:open'); });
        bind(loopAnalysisBtn, async () => { this.eventBus?.emit?.('tools:loop-analysis:open'); });
        bind(modelTestsBtn, async () => { this.eventBus?.emit?.('tools:model-tests:open'); });

        // Cell width toggle
        if (cellWidthToggleBtn) {
            bind(cellWidthToggleBtn, () => {
                const containers = document.querySelectorAll('.notebook-editor-container');
                const current = containers[0]?.dataset.cellWidthMode || 'fixed';
                const next = current === 'fixed' ? 'full' : 'fixed';
                for (const c of containers) c.dataset.cellWidthMode = next;
                const icon = cellWidthToggleBtn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = next === 'full' ? 'width_full' : 'width_normal';
                setSetting('notebook.cellWidthMode', next);
            });
        }

        // Solver settings modal
        if (solverSettingsBtn) {
            solverSettingsBtn.addEventListener('click', () => {
                openSolverSettingsModal({
                    rtol: solverSettings.rtol,
                    atol: solverSettings.atol,
                    onSave: ({ rtol, atol }) => {
                        solverSettings.rtol = rtol;
                        solverSettings.atol = atol;
                    },
                });
            });
        }

        // Scenario select — uses project file paths as option values
        if (scenarioSelect) {
            scenarioSelect.addEventListener('change', async (event) => {
                const scenarioPath = event?.target?.value || '';
                if (!scenarioPath) return;
                this.eventBus?.emit?.('scenario:topbar:selected', { scenarioPath });

                // Sync toolbar solver/time to the selected scenario's settings
                if (pm) {
                    if (!pm.getOpenFile(scenarioPath)) await pm.openFile(scenarioPath);
                    const sf = pm.getOpenFile(scenarioPath)?.content;
                    if (sf) {
                        const solver = sf.solver || {};
                        const time = sf.time || {};
                        const method = solver.method || solver.solverMethod;
                        if (solverSelect && method) solverSelect.value = method;
                        if (t0Input && Number.isFinite(time.t0)) t0Input.value = time.t0;
                        if (t1Input && Number.isFinite(time.t1)) t1Input.value = time.t1;
                        if (dtInput && Number.isFinite(time.dt)) dtInput.value = time.dt;
                        if (Number.isFinite(solver.rtol)) solverSettings.rtol = solver.rtol;
                        if (Number.isFinite(solver.atol)) solverSettings.atol = solver.atol;
                    }
                }
            });
        }

        // Scenario config/save/save-as buttons emit events for the scenario system
        bind(scenarioConfigBtn, () => { this.eventBus?.emit?.('scenario:config:open'); });
        bind(scenarioSaveBtn, () => { this.eventBus?.emit?.('scenario:save:current'); });
        bind(scenarioSaveAsBtn, () => { this.eventBus?.emit?.('scenario:save-as:open'); });

        // Time settings: values are read at run time via collectRunPayload().
        // No active sync needed — the inputs are the source of truth for the next run.

        // ── Populate scenario dropdown from project files ──
        const pm = this.projectModel;

        const populateScenarioDropdown = (selectedPath) => {
            if (!scenarioSelect) return;
            scenarioSelect.replaceChildren();
            const files = pm?.files ?? [];
            const scenarios = files.filter(f => f.type === 'scenario');
            if (scenarios.length === 0) {
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = 'No scenarios available';
                placeholder.disabled = true;
                placeholder.selected = true;
                scenarioSelect.appendChild(placeholder);
                return;
            }
            for (const s of scenarios) {
                const opened = pm.getOpenFile(s.path);
                const label = opened?.content?.name
                    ?? s.path.split('/').pop().replace('.scenario', '')
                        .replace(/[_-]/g, ' ')
                        .replace(/\b\w/g, c => c.toUpperCase());
                const opt = document.createElement('option');
                opt.value = s.path;
                opt.textContent = label;
                scenarioSelect.appendChild(opt);
            }
            const effectivePath = selectedPath
                ?? pm?.manifest?.settings?.defaultScenario
                ?? null;
            if (effectivePath) {
                scenarioSelect.value = effectivePath;
            }
            // Fall back to first option if effectivePath didn't match any option
            if (!scenarioSelect.value && scenarios.length > 0) {
                scenarioSelect.selectedIndex = 0;
            }

            // Sync toolbar solver/time from the selected scenario's settings
            const activePath = scenarioSelect.value;
            if (activePath && pm) {
                const sf = pm.getOpenFile(activePath)?.content;
                if (sf) {
                    const sv = sf.solver || {};
                    const tm = sf.time || {};
                    const method = sv.method || sv.solverMethod;
                    if (solverSelect && method) solverSelect.value = method;
                    if (t0Input && Number.isFinite(tm.t0)) t0Input.value = tm.t0;
                    if (t1Input && Number.isFinite(tm.t1)) t1Input.value = tm.t1;
                    if (dtInput && Number.isFinite(tm.dt)) dtInput.value = tm.dt;
                    if (Number.isFinite(sv.rtol)) solverSettings.rtol = sv.rtol;
                    if (Number.isFinite(sv.atol)) solverSettings.atol = sv.atol;
                }
            }
        };

        // Hydrate from current state
        if (pm?.isOpen) populateScenarioDropdown(null);

        // ── Bus subscriptions for live updates ──
        if (this.eventBus) {
            const subscribe = (name, handler) => {
                const disposer = this.eventBus.on(name, handler);
                if (disposer) this._busSubscriptions.push(disposer);
            };

            // Rebuild dropdown when project opens/closes or files change
            subscribe('project:opened', () => populateScenarioDropdown(null));
            subscribe('project:closed', () => populateScenarioDropdown(null));
            subscribe('project:files:changed', () => {
                const currentPath = scenarioSelect?.value || null;
                populateScenarioDropdown(currentPath);
            });

            // When a run starts, sync the dropdown to show the running scenario
            subscribe('streaming:started', ({ scenarioName }) => {
                if (!scenarioSelect || !scenarioName) return;
                for (const opt of scenarioSelect.options) {
                    if (opt.textContent === scenarioName) {
                        scenarioSelect.value = opt.value;
                        break;
                    }
                }
            });
        }
    }

    _escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Restore persisted UI mode (flow, scenarios, database, functions)
     * Called during initialization to return to the last active page.
     */
    _hydratePersistedModeState() {
        try {
            if (typeof localStorage === 'undefined') return;
            const raw = localStorage.getItem('ecosim.uiMode.v1');
            if (raw == null) return;
            const parsed = JSON.parse(raw);
            const validModes = ['notebook', 'simulation-run', 'database', 'settings', 'etl'];
            const migrated = parsed;
            if (typeof migrated === 'string' && validModes.includes(migrated)) {
                // Defer mode switch to after initialization completes
                if (migrated !== 'notebook') {
                    this._deferredMode = migrated;
                    this.logger?.debug?.('app-shell', 'Will restore UI mode after init', { mode: migrated });
                }
            }
        } catch (err) {
            this.logger?.warn?.('app-shell', 'Failed to restore UI mode state', { error: err });
        }
    }

    /**
     * Apply the deferred mode restoration after the shell is fully initialized.
     * Called at the end of initialize().
     */
    _applyDeferredModeState() {
        if (this._deferredMode) {
            const mode = this._deferredMode;
            this._deferredMode = null;
            this.logger?.debug?.('app-shell', 'Restoring UI mode', { mode });
            this._switchMode(mode);
        }
    }

    /**
     * Persist current UI mode to localStorage for return-after-refresh.
     * @param {string} mode - The mode to persist (flow, scenarios, database, functions, settings)
     */
    _persistModeState(mode) {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem('ecosim.uiMode.v1', JSON.stringify(mode));
        } catch (err) {
            this.logger?.warn?.('app-shell', 'Failed to persist UI mode state', { error: err });
        }
    }

    _readCollapsibleStateStore() {
        try {
            if (typeof localStorage === 'undefined') return {};
            const raw = localStorage.getItem('ecosim.collapsibleState.v1');
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (err) {
            this.logger?.warn?.('app-shell', 'Failed to read collapsible state store', { error: err });
            return {};
        }
    }

    _persistCollapsibleState(id, isExpanded) {
        if (!id) return;
        try {
            if (typeof localStorage === 'undefined') return;
            const store = this._readCollapsibleStateStore();
            store[id] = !!isExpanded;
            localStorage.setItem('ecosim.collapsibleState.v1', JSON.stringify(store));
            this.logger?.debug?.('app-shell', 'Persisted collapsible state', { id, isExpanded });
        } catch (err) {
            this.logger?.warn?.('app-shell', 'Failed to persist collapsible state', { error: err, id });
        }
    }

    _hydrateCollapsibleState() {
        const store = this._readCollapsibleStateStore();
        document.querySelectorAll('[data-collapsible-id]').forEach((box) => {
            const id = box.dataset.collapsibleId;
            if (!id) return;
            const content = box.querySelector('[data-collapsible-content="true"]');
            const arrow = box.querySelector('.collapsible-arrow');
            const defaultState = (box.dataset.collapsibleDefault || 'collapsed').toLowerCase();
            const shouldShow = (id in store) ? !!store[id] : defaultState === 'expanded';
            if (content) {
                content.classList.toggle('visible', shouldShow);
            }
            if (arrow) {
                arrow.classList.toggle('collapsed', !shouldShow);
            }
        });
    }

    async _syncDebugIndicator() {
        const indicator = document.getElementById('debug-indicator');
        if (!indicator) return;

        // First, check Python backend for actual --debug flag
        let backendDebug = false;
        try {
            if (window.pywebview?.api?.is_debug_mode) {
                const res = await window.pywebview.api.is_debug_mode();
                if (res?.ok && res?.debug) {
                    backendDebug = true;
                }
            }
        } catch (err) {
            console.warn('[ApplicationShell] Failed to check debug mode from backend:', err);
        }

        // Store the backend debug mode globally for other components to use
        window.__ECOSIM_BACKEND_DEBUG__ = backendDebug;

        // Only show debug indicator if backend says we're in debug mode
        indicator.style.display = backendDebug ? 'inline-flex' : 'none';
        indicator.setAttribute('aria-hidden', backendDebug ? 'false' : 'true');
    }

    _wireResizer() {
        // Horizontal resizer between left and right panels
        const resizer = document.getElementById('resizer');
        const leftPanel = document.querySelector('.panel.left');
        const rightPanel = document.querySelector('.panel.right');
        if (resizer && leftPanel && rightPanel) {
            let startX = 0;
            let startLeftWidth = 0;

            const MIN_LEFT = 320;
            const MIN_RIGHT = 650;

            const onMouseMove = (e) => {
                const delta = e.clientX - startX;
                const container = leftPanel.parentElement;
                const containerWidth = container ? container.getBoundingClientRect().width : window.innerWidth;
                const resizerWidth = resizer.getBoundingClientRect().width || 6;
                const maxLeft = containerWidth - resizerWidth - MIN_RIGHT;

                const newLeft = Math.min(maxLeft, Math.max(MIN_LEFT, startLeftWidth + delta));
                leftPanel.style.flex = `0 0 ${newLeft}px`;
                rightPanel.style.flex = '1 1 auto';
                // NB: don't write `rightPanel.style.minWidth = '650px'` here.
                // The maxLeft clamp above already keeps the right panel ≥
                // MIN_RIGHT during drag; setting an inline minWidth would
                // *persist* across drags and prevent the user from later
                // shrinking the right panel back below 650px — which read
                // as "first drag locks the min". Inline style is left clean
                // so the CSS-cascade default (no inline min) applies.
            };

            const stop = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', stop);
                document.body.style.cursor = '';
                resizer.classList.remove('dragging');
            };

            resizer.addEventListener('mousedown', (e) => {
                startX = e.clientX;
                startLeftWidth = leftPanel.getBoundingClientRect().width;
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', stop);
                document.body.style.cursor = 'ew-resize';
                resizer.classList.add('dragging');
                e.preventDefault();
            });
        }

        // Vertical splitter between active top area and bottom panel.
        // The top element varies by mode (`.left-top` in flow, `#etl-manager-page`
        // in ETL), so we resolve it dynamically via _getActiveTopElement().
        const vertResizer = document.getElementById('vertical-resizer');
        const leftBottom = document.querySelector('.left-bottom');
        if (vertResizer && leftBottom && leftPanel) {
            let startY = 0;
            let startTopHeight = 0;
            let startBottomHeight = 0;
            let totalAvailable = 0;

            const MIN_TOP = 140;
            const MIN_BOTTOM = 140;

            const applyHeights = (topPx, bottomPx) => {
                const topEl = this._getActiveTopElement();
                if (topEl) {
                    topEl.style.flex = `0 0 ${topPx}px`;
                    topEl.style.height = `${topPx}px`;
                }
                leftBottom.style.flex = `0 0 ${bottomPx}px`;
                leftBottom.style.height = `${bottomPx}px`;
                leftBottom.classList.remove('collapsed');
                this._bottomPanelFSM?.setHeight(bottomPx);
                vertResizer.style.display = '';
            };

            const onVertMove = (e) => {
                const delta = e.clientY - startY;
                let newTop = Math.max(MIN_TOP, startTopHeight + delta);
                let newBottom = totalAvailable - newTop;
                if (newBottom < MIN_BOTTOM) {
                    newBottom = MIN_BOTTOM;
                    newTop = totalAvailable - newBottom;
                }
                applyHeights(newTop, newBottom);
            };

            const stopVert = () => {
                document.removeEventListener('mousemove', onVertMove);
                document.removeEventListener('mouseup', stopVert);
                document.body.style.cursor = '';
                vertResizer.classList.remove('dragging');
                const bottomHeight = leftBottom.getBoundingClientRect().height || MIN_BOTTOM;
                this._bottomPanelFSM?.setHeight(bottomHeight);
            };

            vertResizer.addEventListener('mousedown', (e) => {
                const topEl = this._getActiveTopElement();
                const leftPanelRect = leftPanel.getBoundingClientRect();
                const resizerRect = vertResizer.getBoundingClientRect();
                totalAvailable = leftPanelRect.height - resizerRect.height;
                startY = e.clientY;
                startTopHeight = topEl?.getBoundingClientRect().height || 0;
                startBottomHeight = leftBottom.getBoundingClientRect().height;
                // If panel was collapsed, restore previous height before dragging
                if (leftBottom.classList.contains('collapsed')) {
                    const restore = this._bottomPanelFSM?.getHeight() || startBottomHeight || 240;
                    startBottomHeight = restore;
                    startTopHeight = Math.max(MIN_TOP, totalAvailable - restore);
                    leftBottom.classList.remove('collapsed');
                    applyHeights(startTopHeight, restore);
                }
                document.addEventListener('mousemove', onVertMove);
                document.addEventListener('mouseup', stopVert);
                document.body.style.cursor = 'ns-resize';
                vertResizer.classList.add('dragging');
                e.preventDefault();
            });
        }
    }

    _wireDebugButton() {
        const indicator = document.getElementById('debug-indicator');
        if (!indicator) return;
        indicator.style.cursor = 'pointer';
        indicator.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.location.reload();
        });
    }

    /**
     * Wire up collapsible section events
     */
    _wireCollapsibleEvents() {
        // Handle collapsible headers
        document.querySelectorAll('[data-collapsible-header="true"]').forEach(header => {
            header.addEventListener('click', (e) => {
                // Don't toggle if clicking inside input/button
                if (e.target.closest('input, button:not(.arrow-toggle)')) return;
                
                const box = header.closest('[data-collapsible-id]');
                if (!box) return;
                const collapsibleId = box.dataset.collapsibleId;
                
                const content = box.querySelector('[data-collapsible-content="true"]');
                const arrow = header.querySelector('.collapsible-arrow');
                
                if (content) {
                    const isVisible = content.classList.contains('visible');
                    content.classList.toggle('visible', !isVisible);
                    if (arrow) {
                        arrow.classList.toggle('collapsed', isVisible);
                    }
                    this._persistCollapsibleState(collapsibleId, !isVisible);
                }
            });
        });
    }

    // ─── Notes persistence ─────────────────────────────────────────────────

    _wireNotesEvents() {
        const textarea = document.getElementById('project-notes-textarea');
        if (!textarea) return;

        this._notesSaveTimer = null;

        textarea.addEventListener('input', () => {
            if (this._notesSaveTimer) clearTimeout(this._notesSaveTimer);
            this._notesSaveTimer = setTimeout(() => {
                this._notesSaveTimer = null;
                this._saveNotes(textarea.value);
            }, 1000);
        });

        // Load notes when a project is opened
        this.eventBus?.on('project:opened', () => this._loadNotes());
        // Clear notes when project is closed
        this.eventBus?.on('project:closed', () => {
            textarea.value = '';
        });
    }

    async _loadNotes() {
        const textarea = document.getElementById('project-notes-textarea');
        const pm = this.projectModel;
        if (!textarea || !pm?.isOpen) return;

        try {
            const result = await window.pywebview?.api?.project_read_file({
                projectPath: pm.projectPath,
                filePath: 'notes.txt',
            });
            textarea.value = result?.ok ? (result.content ?? '') : '';
        } catch {
            textarea.value = '';
        }
    }

    async _saveNotes(content) {
        const pm = this.projectModel;
        if (!pm?.isOpen) return;

        try {
            await window.pywebview?.api?.project_write_file({
                projectPath: pm.projectPath,
                filePath: 'notes.txt',
                content,
            });
        } catch (e) {
            this.logger.warn?.('[ApplicationShell] Failed to save notes', e);
        }
    }

    /**
     * Get current mode
     */
    getCurrentMode() {
        return this._currentMode || 'simulation-run';
    }

    /**
     * Get a reference to a shell element
     */
    getElement(name) {
        return this.elements[name] || null;
    }

    /**
     * Get the main container
     */
    getContainer() {
        return this.container;
    }

}

// Export singleton for convenience
export const applicationShell = new ApplicationShell();
