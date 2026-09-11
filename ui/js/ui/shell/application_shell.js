/**
 * ApplicationShell — BugDesk's window chrome.
 *
 * Two bars, and nothing between them:
 *
 *   global-top-bar     application menu, project chip, panel toggles, and the
 *                      window buttons where this IS the title bar
 *   global-bottom-bar  project identity, the status line, the desktop strip
 *
 * The tiling shell (js/tiling/install.js) puts its WM host between the two and
 * owns everything inside it. Nothing else is built here.
 *
 * WHAT USED TO BE HERE. This is Ecosim's shell, and it used to build Ecosim's
 * whole workspace as well: a `.container` holding the left tool rail, the
 * template sidebar, a left panel with the ETL bottom drawer, a drag resizer and
 * a right panel carrying Notes, Parameters and an "AI Assistant" box — plus the
 * panel state machines, the mode switcher (notebook / simulation-run / database
 * / etl / paper) and the collapsible-section machinery that drove them.
 *
 * BugDesk has none of those pages. The tiling shell deleted the whole
 * `.container` immediately after it was built, which left a visible boot
 * sequence — another application's chrome, right panel and all, for as long as
 * the bridge took to answer, and then the real UI dropped over it. Building it
 * to delete it was also why `installTilingShell` had a teardown step at all.
 *
 * So it is gone rather than hidden, and with it everything that existed only to
 * serve it: the two PanelStateMachines, the fl-bar wiring, `_switchMode` and
 * the modes it persisted, the resizer, the collapsible state store, the Notes
 * load/save, the (never-mounted) AI chat box, the unreachable `#contextMenu`,
 * the `.toast-container` that NotificationCenter ignores in favour of its own
 * body-level root, and the "Model OK" validation indicator BugDesk has no
 * model for.
 */

import { WindowTaskbar } from '../components/window_taskbar.js';
import { usesCustomWindowChrome } from '../controllers/window_chrome_controller.js';
import { getSetting } from '../../core/settings.js';

export class ApplicationShell {
    constructor(options = {}) {
        this.eventBus = options.eventBus || null;
        this.logger = options.logger || console;
        this.onMenuAction = options.onMenuAction || null;
        this.elements = {};
        this._initialized = false;
        this._busSubscriptions = [];
        this._boundHandlers = new Map();
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

        // Wire up event handlers
        this._wireMenuEvents();
        this._wireDebugButton();
        this._syncDebugIndicator();

        // Refresh tooltips for dynamically injected content
        window.LatexTooltip?.refresh();

        // Apply macOS shadows setting reactively
        const applyMacShadows = () => {
            document.body.classList.toggle('mac-shadows', getSetting('window.macShadows', true));
        };
        applyMacShadows();
        this.eventBus?.on('settings:window.macShadows:changed', applyMacShadows);
        this._busSubscriptions.push(['settings:window.macShadows:changed', applyMacShadows]);

        this._initialized = true;

        this.logger.info?.('[ApplicationShell] Initialized');
    }

    /**
     * Mount the shell into the document body.
     *
     * The two bars, in document order, with the space between them left for
     * whoever fills it — the tiling shell inserts its `.twm-host` there.
     */
    mount() {
        // Clear body and build structure
        document.body.innerHTML = '';

        this._buildGlobalTopBar();
        this._buildGlobalBottomBar();

        // Initialize window taskbar for managed windows
        WindowTaskbar.init();
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
                <!-- Menu bar: the brand, and Help. The tiling shell puts a
                     hamburger to the left of the brand and folds these entries
                     into it (see _installHamburgerMenu), then hides the bar
                     itself — the dropdowns stay in the DOM only so their click
                     handlers remain callable from that menu.

                     File / Edit / View / Run used to be built here and deleted
                     again by the tiling shell: BugDesk has no workspace file to
                     save, no canvas to undo, no panels of its own to toggle and
                     nothing to run. They are not built any more. -->
                <nav class="app-menu" aria-label="Application Menu"><span class="ecoagent-brand" style="font-weight:600; padding:0 10px; letter-spacing:0.04em; color:#ddd;">BugDesk</span><div class="menu-item" tabindex="0"><span>Help</span><div class="menu-dropdown"><button class="menu-entry" id="menu-help-topics">Help Topics <span class="menu-shortcut">F1</span></button><hr class="menu-sep" /><button class="menu-entry" id="menu-help-about">About BugDesk</button></div></div></nav>
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
                     for the project actions popover. -->
                <button type="button" class="project-chip" id="project-chip"
                        title="Project actions"></button>
                <!-- The one status line. Written by statusLine() on every page
                     that reports the result of a write. -->
                <div class="sim-status is-info" id="sim-status">BugDesk ready.</div>
            </div>
            <!-- The tiling shell mounts the desktop strip in the centre and the
                 user chip on the right (see _installDesktopBar / _installUserChip).
                 What used to sit here — a world-tick readout and a WebSocket
                 streaming indicator — belonged to a simulation BugDesk does not
                 have, and nothing ever wrote to either. -->
            <div class="bar-center"> &nbsp; </div>
            <div class="bar-right">
                <div class="bar-right-actions" aria-label="Global actions"></div>
            </div>
        `;
        
        document.body.appendChild(bottomBar);
        this.elements.bottomBar = bottomBar;
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


    // ─── Notes persistence ─────────────────────────────────────────────────


}

// Export singleton for convenience
export const applicationShell = new ApplicationShell();
