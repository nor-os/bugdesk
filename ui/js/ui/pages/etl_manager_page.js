/**
 * ETL Manager Page
 *
 * Pipeline management page following the ScenarioManagerPage pattern.
 * Lists pipelines, provides CRUD, opens the designer window for editing,
 * and executes pipeline runs.
 *
 * Left sidebar: pipeline list in fixed-200-etl
 * Main content: pipeline detail (nodes summary, run history, actions)
 */

import { PageBase } from '../base/page_base.js';
import { StateMachine } from '../../core/state_machine.js';
import { createTreeItem, createTreeCategory, createTreeNode, toggleCategory, toggleNode, filterTree, selectItem } from '../components/tree_view.js';
import { PipelineStepEditor } from '../components/pipeline_step_editor.js';
import { OrchestrationEditor } from '../components/orchestration_editor.js';
import { ensurePipelineFormat, stepsToGraph, resolveParameters, resolveGraphParameters, buildOrchestrationPayload } from '../../etl/etl_step_converter.js';
import { DataTable } from '../components/data_table.js';
import { getSetting } from '../../core/settings.js';
import { createDetailHeader } from '../components/detail_header.js';
import { installOverlayScrollbar } from '../utils/overlay_scrollbar.js';
import { SlideOutPanel } from '../components/slide_out_panel.js';

const PAGE_STATES = {
    idle: { transitions: { init: { target: 'initializing' } } },
    initializing: { transitions: { ready: { target: 'ready' }, error: { target: 'error' } } },
    ready: { transitions: { refresh: { target: 'ready' }, error: { target: 'error' } } },
    error: { transitions: { retry: { target: 'initializing' } } },
};

export class ETLManagerPage extends PageBase {
    constructor({ eventBus, dataManager, notificationCenter, logger, hostBridge, projectModel } = {}) {
        super({ eventBus, dataManager, notificationCenter, logger });
        this.hostBridge = hostBridge;
        this._projectModel = projectModel || null;

        // DOM
        this.container = null;
        this.leftPanelRoot = null;
        this.pipelineListEl = null;
        this.mainContent = null;

        // State
        this.pipelines = [];
        this._builtinPipelines = [];
        this.selectedPipelineId = null;
        this._busSubscriptions = [];
        this._isRefreshing = false;
        this._stepEditor = null;
        this._orchEditor = null;
        this._runPreviewTable = null;
        /** @type {Map<string, object>} pipeline ID -> last successful run result */
        this._lastResults = new Map();
        /** @type {string|null} Currently selected pipeline ID in orchestration run detail */
        this._selectedOrchPipelineId = null;

        /** @type {SlideOutPanel|null} */
        this._slideOutPanel = null;

        /** @type {Array<{type: string, id: string, name: string}>} Breadcrumb ancestor stack */
        this._navStack = [];
        /** @type {{datasetName: string, seriesName: string, pipelineId: string, pipelineName: string}|null} */
        this._datasetContext = null;

        this.stateMachine = new StateMachine({
            name: 'ETLManagerPage',
            initialState: 'idle',
            states: PAGE_STATES,
            eventBus: this.eventBus,
            logger: this.logger,
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════════════

    mount(container) {
        this.container = container || document.getElementById('etl-manager-page');
        this.#buildUI();
        this._initPromise = this.#init();
        this._mounted = true;
    }

    async hydrate() {
        await this.waitForReady();
        this.#refresh();
    }

    onActivated() {
        // Rebuild sidebar if it was replaced
        if (this.leftPanelRoot && (!this.pipelineListEl || !this.leftPanelRoot.contains(this.pipelineListEl))) {
            this.leftPanelRoot.innerHTML = this.#buildLeftPanelHTML();
            this.#wireLeftPanelEvents();
        }
        this.#refresh();
        this.#emitBreadcrumb();
        this.#emitPanelConfig();
    }

    onDeactivated() {
        // Nothing to clean up for now
    }

    show() {
        if (this.container) this.container.style.display = '';
    }

    hide() {
        if (this.container) this.container.style.display = 'none';
    }

    dispose() {
        for (const d of (this._stepEditorDisposers ?? [])) d();
        this._stepEditorDisposers = [];
        this._stepEditor?.dispose();
        this._stepEditor = null;
        this._slideOutPanel?.dispose();
        this._slideOutPanel = null;
        this._orchEditor?.dispose();
        this._orchEditor = null;
        this.#clearRunPreview();
        this.#destroyPipelineContextMenu();
        for (const unsub of this._busSubscriptions) {
            try { unsub?.dispose?.() ?? unsub?.(); } catch (_) { /* ignore */ }
        }
        this._busSubscriptions = [];
        super.dispose();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Init
    // ═══════════════════════════════════════════════════════════════════

    async #init() {
        await this.stateMachine._ready;
        if (this.stateMachine.getState() !== 'idle') return;
        await this.stateMachine.transition('init');

        if (!this.container) {
            this.logger?.error?.('etl', '[ETLManagerPage] Container not found');
            await this.stateMachine.transition('error');
            return;
        }

        this.#wireBusSubscriptions();

        // Load built-in pipelines from AppData (or initialize from assumptions.json on first load).
        // Must await so builtins are available before #refresh() merges them into this.pipelines.
        // Orchestration items reference built-in pipeline IDs — a race here causes "not found" errors.
        await this.#loadOrInitializeBuiltins().catch(err => {
            this.logger?.warn?.('etl', '[ETLManagerPage] Failed to load built-in pipelines', err);
        });

        await this.stateMachine.transition('ready');
        this.#refresh();
    }

    #buildUI() {
        this.leftPanelRoot = document.getElementById('fixed-200-etl');
        if (this.leftPanelRoot) {
            this.leftPanelRoot.innerHTML = this.#buildLeftPanelHTML();
            this.#wireLeftPanelEvents();
        }

        this.container.innerHTML = '';
        this.container.classList.add('scenario-manager-shell');
        const main = document.createElement('section');
        main.className = 'scenario-manager-main';
        this.container.appendChild(main);
        this.mainContent = main;

        this.#renderPlaceholder('Select or create a pipeline');
    }

    #buildLeftPanelHTML() {
        return `
            <header class="fixed-panel-header">
                <span class="material-symbols-outlined">conversion_path</span>
                <span>Pipelines</span>
            </header>
            <div class="sidebar-controls">
                <span class="material-symbols-outlined sidebar-search-icon">search</span>
                <input type="search" class="data-page__search" placeholder="Filter\u2026" />
            </div>
            <div class="sidebar-body sidebar-body--accordion">
                <ul class="tree-view" data-role="pipeline-list"></ul>
            </div>`;
    }

    #wireLeftPanelEvents() {
        if (!this.leftPanelRoot) return;

        const searchInput = this.leftPanelRoot.querySelector('.data-page__search');
        searchInput?.addEventListener('input', (e) => this.#filterPipelineList(e.target.value));

        this.pipelineListEl = this.leftPanelRoot.querySelector('[data-role="pipeline-list"]');
        this._pipelineListWired = false;

        // Overlay scrollbar on sidebar body
        const sidebarBody = this.leftPanelRoot.querySelector('.sidebar-body');
        if (sidebarBody) installOverlayScrollbar(sidebarBody, { orientation: 'vertical', watchSubtree: true });
    }

    #wireBusSubscriptions() {
        if (!this.eventBus) return;
        this.#subscribe('data:etlPipelines:updated', () => this.#refresh());
        this.#subscribe('etl:pipeline:complete', () => this.#refresh());
        this.#subscribe('workspace:import:completed', () => this.#refresh());
    }

    #subscribe(eventName, handler) {
        if (!this.eventBus) return;
        const disposer = this.eventBus.on(eventName, handler);
        this._busSubscriptions.push(disposer);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Refresh / Data Loading
    // ═══════════════════════════════════════════════════════════════════

    #refresh() {
        if (this._isRefreshing) return;
        this._isRefreshing = true;
        try {
            this.#loadPipelines();

            if (!this.selectedPipelineId || !this.pipelines.find(p => p.id === this.selectedPipelineId)) {
                // Selected item no longer exists — clear drill-down context
                this._navStack = [];
                this._datasetContext = null;
                const saved = this.#loadPersistedSelection();
                if (saved && this.pipelines.find(p => p.id === saved)) {
                    this.selectedPipelineId = saved;
                } else if (this.pipelines.length > 0) {
                    this.selectedPipelineId = this.pipelines[0].id;
                } else {
                    this.selectedPipelineId = null;
                }
            }

            this.#renderPipelineList();

            if (this.selectedPipelineId) {
                this.#renderPipelineDetail(this.selectedPipelineId);
            } else {
                this.#renderPlaceholder('Create a pipeline to get started');
            }
        } catch (err) {
            this.logger?.error?.('etl', '[ETLManagerPage] Refresh failed', err);
        } finally {
            this._isRefreshing = false;
        }
    }

    #loadPipelines() {
        // Read from DataManager Map, converting frozen DTOs to mutable working copies
        const project = this.dataManager?.listEtlPipelines?.()?.map(dto => dto.toJSON()) ?? [];

        // Auto-migrate project pipelines from old node/connection format to step-list format
        for (const p of project) {
            ensurePipelineFormat(p);
        }

        // Merge built-in pipelines (persisted in AppData) after project pipelines.
        // Mark builtins so UI can distinguish them.
        // Project files take precedence — if a project pipeline shares an ID with
        // a built-in (e.g. project copied/customized a built-in), keep the project
        // version which has the full graph definition.
        const projectIds = new Set(project.map(p => p.id));
        const builtins = this._builtinPipelines
            .filter(p => !projectIds.has(p.id))
            .map(p => ({ ...p, _builtin: true }));

        this.pipelines = [...project, ...builtins];

        // Reconcile stale pipelineId references in orchestrations. Built-in pipeline
        // IDs changed from random UUIDs to deterministic IDs — orchestration items
        // that still reference old IDs are remapped by pipeline name.
        this.#reconcileOrchestrationRefs();
    }

    /**
     * Fix stale pipelineId references in orchestration items by matching on
     * pipeline name when the ID isn't found. Persists fixes to DataManager.
     */
    #reconcileOrchestrationRefs() {
        const pipelineById = new Map(this.pipelines.map(p => [p.id, p]));
        const pipelineByName = new Map(
            this.pipelines.filter(p => p.kind !== 'orchestration').map(p => [p.name, p]),
        );

        for (const orch of this.pipelines.filter(p => p.kind === 'orchestration')) {
            let patched = false;
            for (const item of (orch.items || [])) {
                if (pipelineById.has(item.pipelineId)) continue;

                // ID not found — try name match
                const match = item.pipelineName && pipelineByName.get(item.pipelineName);
                if (match) {
                    console.info(
                        `[ETLManagerPage] Remapped stale pipelineId: "${item.pipelineName}" ${item.pipelineId} → ${match.id}`,
                    );
                    item.pipelineId = match.id;
                    patched = true;
                }
            }

            if (patched) {
                this.dataManager.upsertEtlPipeline(orch);
                this.#persistToProjectFile(orch);
            }
        }
    }

    /**
     * Load built-in pipelines from the backend.  The backend generates
     * definitions from builtin_pipelines.json and overlays any user edits
     * stored in AppData.
     */
    async #loadOrInitializeBuiltins() {
        const api = window.pywebview?.api;
        if (!api?.etl_load_builtin_pipelines) return;

        const result = await api.etl_load_builtin_pipelines();
        if (!result?.ok) return;

        this._builtinPipelines = result.pipelines;
        this.#refresh();
    }

    /**
     * Reset a built-in pipeline to its original definition from the registry.
     */
    async #resetBuiltinPipeline(pipelineId) {
        const api = window.pywebview?.api;
        if (!api?.etl_reset_builtin_pipeline) return;

        const result = await api.etl_reset_builtin_pipeline(pipelineId);
        if (!result?.ok || !result.pipeline) {
            this.eventBus?.emit?.('toast:show', {
                title: 'Cannot reset',
                message: 'Original built-in pipeline definition not found',
                severity: 'warning',
                durationMs: 3000,
            });
            return;
        }

        const fresh = result.pipeline;

        // Replace in the builtins array
        const idx = this._builtinPipelines.findIndex(p => p.id === pipelineId);
        if (idx >= 0) {
            this._builtinPipelines[idx] = fresh;
        } else {
            this._builtinPipelines.push(fresh);
        }

        // Clear cached results
        this._lastResults.delete(pipelineId);

        this.#refresh();
        this.eventBus?.emit?.('toast:show', {
            title: 'Pipeline reset',
            message: `"${fresh.name}" restored to default definition`,
            severity: 'info',
            durationMs: 3000,
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Left Panel — Pipeline List
    // ═══════════════════════════════════════════════════════════════════

    // ── Category metadata for built-in pipeline grouping ──────────
    static #BUILTIN_CATEGORIES = {
        social:      { label: 'Social',      icon: 'people',          order: 1 },
        economy:     { label: 'Economy',     icon: 'trending_up',     order: 2 },
        financial:   { label: 'Financial',   icon: 'account_balance', order: 3 },
        fiscal:      { label: 'Fiscal',      icon: 'receipt_long',    order: 4 },
        environment: { label: 'Environment', icon: 'eco',             order: 5 },
        energy:      { label: 'Energy',      icon: 'bolt',            order: 6 },
    };

    #renderPipelineList() {
        const listEl = this.pipelineListEl;
        if (!listEl) return;
        listEl.innerHTML = '';

        const userPipelines = this.pipelines.filter(p => !p._builtin && p.kind !== 'orchestration');
        const orchestrations = this.pipelines.filter(p => p.kind === 'orchestration');
        const builtinPipelines = this.pipelines.filter(p => p._builtin && p.kind !== 'orchestration');

        if (this.pipelines.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'scenario-library-empty';
            empty.textContent = 'No pipelines yet';
            listEl.appendChild(empty);
            return;
        }

        // ── Orchestrations section ──
        if (orchestrations.length > 0) {
            const orchSection = createTreeCategory({
                id: 'orchestrations',
                label: 'Orchestrations',
                icon: 'playlist_play',
                count: orchestrations.length,
                expanded: true,
            });

            const orchContent = orchSection.querySelector('.collapsible-content');
            for (const orch of orchestrations) {
                if (!orch?.id) continue;
                const itemCount = (orch.items || []).length;
                const subtitle = itemCount > 0
                    ? `${itemCount} pipeline${itemCount !== 1 ? 's' : ''}`
                    : null;

                const item = createTreeItem({
                    id: orch.id,
                    label: orch.name || 'Unnamed Orchestration',
                    icon: 'playlist_play',
                    selected: orch.id === this.selectedPipelineId,
                    subtitle,
                });
                orchContent.appendChild(item);
            }

            listEl.appendChild(orchSection);
        }

        // ── User pipelines section ──
        if (userPipelines.length > 0) {
            const userSection = createTreeCategory({
                id: 'user-pipelines',
                label: 'Pipelines',
                icon: 'conversion_path',
                count: userPipelines.length,
                expanded: true,
            });

            const content = userSection.querySelector('.collapsible-content');
            for (const pipeline of userPipelines) {
                if (!pipeline?.id) continue;
                const runs = pipeline.runs || [];
                const subtitle = runs.length > 0
                    ? `${runs.length} run${runs.length !== 1 ? 's' : ''}`
                    : null;

                const item = createTreeItem({
                    id: pipeline.id,
                    label: pipeline.name || 'Unnamed Pipeline',
                    icon: 'conversion_path',
                    selected: pipeline.id === this.selectedPipelineId,
                    subtitle,
                });
                content.appendChild(item);
            }

            listEl.appendChild(userSection);
        }

        // ── Built-in pipelines section (grouped by category) ──
        if (builtinPipelines.length > 0) {
            const builtinSection = createTreeCategory({
                id: 'builtin-pipelines',
                label: 'Built-in',
                icon: 'auto_awesome',
                iconClass: 'tree-category__icon--builtin',
                count: builtinPipelines.length,
                expanded: true,
                readonly: true,
            });

            const builtinContent = builtinSection.querySelector('.collapsible-content');

            // Group by category
            const groups = new Map();
            for (const pipeline of builtinPipelines) {
                const cat = pipeline.category || 'other';
                if (!groups.has(cat)) groups.set(cat, []);
                groups.get(cat).push(pipeline);
            }

            // Sort categories by defined order
            const sortedCategories = [...groups.entries()].sort((a, b) => {
                const orderA = ETLManagerPage.#BUILTIN_CATEGORIES[a[0]]?.order ?? 99;
                const orderB = ETLManagerPage.#BUILTIN_CATEGORIES[b[0]]?.order ?? 99;
                return orderA - orderB;
            });

            for (const [cat, pipelines] of sortedCategories) {
                const meta = ETLManagerPage.#BUILTIN_CATEGORIES[cat] || { label: cat, icon: 'folder' };
                const catNode = createTreeNode({
                    id: `builtin-cat-${cat}`,
                    label: meta.label,
                    icon: meta.icon,
                    count: pipelines.length,
                    expanded: false,
                });

                const children = catNode.querySelector('.tree-node__children');
                for (const pipeline of pipelines) {
                    if (!pipeline?.id) continue;
                    const item = createTreeItem({
                        id: pipeline.id,
                        label: pipeline.name || 'Unnamed Pipeline',
                        icon: 'auto_awesome',
                        selected: pipeline.id === this.selectedPipelineId,
                    });
                    children.appendChild(item);
                }

                builtinContent.appendChild(catNode);
            }

            listEl.appendChild(builtinSection);
        }

        // Wire click delegation (once)
        if (!this._pipelineListWired) {
            this.#wirePipelineListClicks(listEl);
            this._pipelineListWired = true;
        }

        // Expand parents of the selected item so it's visible
        if (this.selectedPipelineId) {
            selectItem(listEl, this.selectedPipelineId, { scrollIntoView: false });
        }
    }

    #wirePipelineListClicks(listEl) {
        listEl.addEventListener('click', (e) => {
            // Collapsible category header toggle
            const header = e.target.closest('.collapsible-header');
            if (header) {
                const category = header.closest('.tree-category');
                if (category) toggleCategory(category);
                return;
            }

            // Tree node header toggle
            const nodeHeader = e.target.closest('.tree-node__header');
            if (nodeHeader) {
                const node = nodeHeader.closest('.tree-node');
                if (node) toggleNode(node);
                return;
            }

            // Pipeline item selection
            const item = e.target.closest('.tree-item');
            if (item?.dataset?.itemId) {
                e.stopPropagation();
                this.#selectPipeline(item.dataset.itemId);
            }
        });

        listEl.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item?.dataset?.itemId) return;
            e.preventDefault();
            e.stopPropagation();
            this.#selectPipeline(item.dataset.itemId);

            if (item.classList.contains('readonly')) return;
            this.#showPipelineContextMenu(e.clientX, e.clientY, item.dataset.itemId);
        });
    }

    // ── Pipeline context menu ────────────────────────────────────────

    #createPipelineContextMenu() {
        if (this._contextMenuEl) return;

        this._contextMenuEl = document.createElement('div');
        this._contextMenuEl.className = 'tab-context-menu';
        this._contextMenuEl.setAttribute('role', 'menu');
        this._contextMenuEl.innerHTML = `
            <div class="context-menu__item" data-action="rename">
                <span class="material-symbols-outlined">edit</span>
                <span>Rename</span>
            </div>
            <div class="context-menu__item" data-action="clone">
                <span class="material-symbols-outlined">content_copy</span>
                <span>Clone</span>
            </div>
            <div class="context-menu__item" data-action="export">
                <span class="material-symbols-outlined">file_download</span>
                <span>Export</span>
            </div>
            <div class="context-menu__separator"></div>
            <div class="context-menu__item context-menu__item--danger" data-action="delete">
                <span class="material-symbols-outlined">delete</span>
                <span>Delete</span>
            </div>
        `;

        this._contextMenuEl.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu__item');
            if (!item || item.hasAttribute('disabled')) return;
            this.#handlePipelineContextAction(item.dataset.action);
        });

        this._boundHideContextMenu = (e) => this.#hidePipelineContextMenu(e);
        document.body.appendChild(this._contextMenuEl);
    }

    #showPipelineContextMenu(x, y, pipelineId) {
        this.#createPipelineContextMenu();
        if (!this._contextMenuEl) return;

        this._contextMenuTargetId = pipelineId;
        this._contextMenuEl.style.display = 'block';

        const rect = this._contextMenuEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let finalX = x;
        let finalY = y;
        if (x + rect.width > vw) finalX = vw - rect.width - 8;
        if (y + rect.height > vh) finalY = vh - rect.height - 8;
        if (finalX < 0) finalX = 8;
        if (finalY < 0) finalY = 8;

        this._contextMenuEl.style.left = `${finalX}px`;
        this._contextMenuEl.style.top = `${finalY}px`;

        document.addEventListener('mousedown', this._boundHideContextMenu, true);
        document.addEventListener('keydown', this._boundHideContextMenu, true);
    }

    #hidePipelineContextMenu(e) {
        if (!this._contextMenuEl) return;
        if (e?.type === 'keydown' && e.key !== 'Escape') return;
        if (e?.type === 'mousedown' && this._contextMenuEl.contains(e.target)) return;

        this._contextMenuEl.style.display = 'none';
        this._contextMenuTargetId = null;
        document.removeEventListener('mousedown', this._boundHideContextMenu, true);
        document.removeEventListener('keydown', this._boundHideContextMenu, true);
    }

    #handlePipelineContextAction(action) {
        const pipelineId = this._contextMenuTargetId;
        this.#hidePipelineContextMenu();
        if (!pipelineId) return;

        switch (action) {
            case 'rename':
                this.#startSidebarRename(pipelineId);
                break;
            case 'clone':
                this.#duplicatePipeline(pipelineId);
                break;
            case 'export':
                this.#exportPipeline(pipelineId);
                break;
            case 'delete':
                this.#deletePipeline(pipelineId);
                break;
        }
    }

    #destroyPipelineContextMenu() {
        if (this._contextMenuEl) {
            document.removeEventListener('mousedown', this._boundHideContextMenu, true);
            document.removeEventListener('keydown', this._boundHideContextMenu, true);
            this._contextMenuEl.remove();
            this._contextMenuEl = null;
        }
        if (this._errorMenuEl) {
            document.removeEventListener('mousedown', this._boundHideErrorMenu, true);
            document.removeEventListener('keydown', this._boundHideErrorMenu, true);
            this._errorMenuEl.remove();
            this._errorMenuEl = null;
        }
    }

    // ── Error context menu (Copy Error) ─────────────────────────────

    #createErrorContextMenu() {
        if (this._errorMenuEl) return;

        this._errorMenuEl = document.createElement('div');
        this._errorMenuEl.className = 'tab-context-menu';
        this._errorMenuEl.setAttribute('role', 'menu');
        this._errorMenuEl.innerHTML = `
            <div class="context-menu__item" data-action="copy-error">
                <span class="material-symbols-outlined">content_copy</span>
                <span>Copy Error Message</span>
            </div>
            <div class="context-menu__item" data-action="copy-pipeline">
                <span class="material-symbols-outlined">content_copy</span>
                <span>Copy Pipeline Name</span>
            </div>
        `;

        this._errorMenuEl.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu__item');
            if (!item) return;
            if (item.dataset.action === 'copy-error' && this._errorMenuText) {
                navigator.clipboard.writeText(this._errorMenuText);
            } else if (item.dataset.action === 'copy-pipeline' && this._errorMenuPipelineName) {
                navigator.clipboard.writeText(this._errorMenuPipelineName);
            }
            this.#hideErrorContextMenu();
        });

        this._boundHideErrorMenu = (e) => this.#hideErrorContextMenu(e);
        document.body.appendChild(this._errorMenuEl);
    }

    #showErrorContextMenu(x, y, errorText, pipelineName) {
        this.#createErrorContextMenu();
        if (!this._errorMenuEl) return;

        this._errorMenuText = errorText;
        this._errorMenuPipelineName = pipelineName;

        // Show/hide the error item based on whether there's an error
        const errorItem = this._errorMenuEl.querySelector('[data-action="copy-error"]');
        errorItem.style.display = errorText ? '' : 'none';

        this._errorMenuEl.style.display = 'block';

        const rect = this._errorMenuEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let finalX = x;
        let finalY = y;
        if (x + rect.width > vw) finalX = vw - rect.width - 8;
        if (y + rect.height > vh) finalY = vh - rect.height - 8;
        if (finalX < 0) finalX = 8;
        if (finalY < 0) finalY = 8;

        this._errorMenuEl.style.left = `${finalX}px`;
        this._errorMenuEl.style.top = `${finalY}px`;

        document.addEventListener('mousedown', this._boundHideErrorMenu, true);
        document.addEventListener('keydown', this._boundHideErrorMenu, true);
    }

    #hideErrorContextMenu(e) {
        if (!this._errorMenuEl) return;
        if (e?.type === 'keydown' && e.key !== 'Escape') return;
        if (e?.type === 'mousedown' && this._errorMenuEl.contains(e.target)) return;

        this._errorMenuEl.style.display = 'none';
        this._errorMenuText = null;
        this._errorMenuPipelineName = null;
        document.removeEventListener('mousedown', this._boundHideErrorMenu, true);
        document.removeEventListener('keydown', this._boundHideErrorMenu, true);
    }

    /**
     * Start inline rename on a pipeline's sidebar tree item label.
     */
    #startSidebarRename(pipelineId) {
        const listEl = this.pipelineListEl;
        if (!listEl) return;
        const item = listEl.querySelector(`.tree-item[data-item-id="${pipelineId}"]`);
        const labelEl = item?.querySelector('.tree-item__label');
        if (!labelEl) return;

        const pipeline = this.pipelines.find(p => p.id === pipelineId);
        if (!pipeline) return;

        const originalText = pipeline.name || 'Unnamed Pipeline';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sm-field__input';
        input.value = originalText;
        input.style.cssText = 'font-size:12px;padding:0 4px;width:100%;box-sizing:border-box;';

        labelEl.textContent = '';
        labelEl.appendChild(input);
        input.focus();
        input.select();

        const commit = () => {
            const newName = input.value.trim();
            if (input.parentNode === labelEl) input.remove();
            if (!newName || newName === originalText) {
                labelEl.textContent = originalText;
                return;
            }
            this.#renamePipeline(pipelineId, newName);
            labelEl.textContent = newName;
            // Update header if this pipeline is currently displayed
            if (this.selectedPipelineId === pipelineId) {
                const headerName = this.mainContent?.querySelector('.detail-header__name');
                if (headerName) headerName.textContent = newName;
            }
        };

        const onBlur = () => commit();
        const onKeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') { input.value = originalText; input.blur(); }
        };

        input.addEventListener('blur', onBlur);
        input.addEventListener('keydown', onKeydown);
        // Prevent click from bubbling to item selection
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    #filterPipelineList(query) {
        const listEl = this.pipelineListEl;
        if (!listEl) return;
        filterTree(listEl, query);
    }

    #selectPipeline(id) {
        const hasContext = this._navStack.length > 0 || this._datasetContext;
        if (!id || (id === this.selectedPipelineId && !hasContext)) return;

        // Flat navigation from sidebar — clear drill-down context
        this._navStack = [];
        this._datasetContext = null;

        this.selectedPipelineId = id;
        this.#persistSelection(id);

        const listEl = this.pipelineListEl;
        if (listEl) {
            // Deselect all, select target, expand parents if needed
            for (const item of listEl.querySelectorAll('.tree-item.selected')) {
                item.classList.remove('selected');
            }
            const target = listEl.querySelector(`.tree-item[data-item-id="${id}"]`);
            if (target) {
                target.classList.add('selected');
                // Expand parent tree-node and tree-category if collapsed
                const parentNode = target.closest('.tree-node');
                if (parentNode) toggleNode(parentNode, true);
                const parentCategory = target.closest('.tree-category');
                if (parentCategory) toggleCategory(parentCategory, true);
            }
        }

        this.#renderPipelineDetail(id);
        this.#emitBreadcrumb();
        this.#emitPanelConfig();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Breadcrumb Navigation
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Drill down into a pipeline/orchestration from a parent context.
     * Pushes the parent onto the navigation stack so the breadcrumb trail
     * shows the path back. Does NOT update sidebar selection or persist.
     */
    #drillDown(targetId, fromContext) {
        if (!targetId) return;
        this._navStack.push(fromContext);
        this._datasetContext = null;
        this.selectedPipelineId = targetId;
        this.#renderPipelineDetail(targetId);
        this.#emitBreadcrumb();
        this.#emitPanelConfig();
    }

    /**
     * Drill into an inline dataset view from a pipeline in drill-down context.
     * Pushes the current pipeline onto the nav stack and renders a dataset detail.
     */
    #drillIntoDataset(datasetName, seriesName, pipeline) {
        if (!datasetName || !pipeline) return;
        this._navStack.push({
            type: 'pipeline',
            id: pipeline.id,
            name: pipeline.name || 'Unnamed Pipeline',
        });
        this._datasetContext = {
            datasetName,
            seriesName: seriesName || '',
            pipelineId: pipeline.id,
            pipelineName: pipeline.name || 'Unnamed Pipeline',
        };
        this.#renderDatasetDetail();
        this.#emitBreadcrumb();
        this.#emitPanelConfig();
    }

    /**
     * Navigate back to a breadcrumb ancestor entry.
     * Truncates the stack and renders the target.
     */
    #navigateToBreadcrumb(index) {
        if (index < 0 || index >= this._navStack.length) return;
        const target = this._navStack[index];
        this._navStack = this._navStack.slice(0, index);
        this._datasetContext = null;
        this.selectedPipelineId = target.id;
        this.#renderPipelineDetail(target.id);
        this.#emitBreadcrumb();
        this.#emitPanelConfig();
    }

    /**
     * Emit breadcrumb segments to the top bar via EventBus.
     * Called whenever navigation context changes.
     */
    #emitBreadcrumb() {
        const actions = [
            { icon: 'conversion_path', label: 'New Pipeline', tooltip: 'Create a new pipeline', onClick: () => this.#createPipeline() },
            { icon: 'playlist_play', label: 'New Orchestration', tooltip: 'Create a new orchestration', onClick: () => this.#createOrchestration() },
            { icon: 'file_upload', tooltip: 'Import pipeline or orchestration (.json)', onClick: () => this.#importPipeline() },
        ];

        if (this._navStack.length === 0 && !this._datasetContext) {
            // Flat selection — show page label + current selection
            const segments = [{ icon: 'conversion_path', label: 'Data Pipelines', onClick: null }];
            if (this.selectedPipelineId) {
                const p = this.pipelines?.find(p => p.id === this.selectedPipelineId);
                if (p) {
                    const isOrch = p.kind === 'orchestration';
                    segments.push({
                        icon: isOrch ? 'playlist_play' : 'route',
                        label: p.name || 'Unnamed',
                        onClick: null,
                    });
                }
            }
            this.eventBus?.emit('topbar:breadcrumb:update', { segments, actions });
            return;
        }

        // Drill-down — build ancestor trail from _navStack
        const segments = [];
        for (let i = 0; i < this._navStack.length; i++) {
            const entry = this._navStack[i];
            const livePipeline = this.pipelines?.find(p => p.id === entry.id);
            const displayName = livePipeline?.name || entry.name;
            const icon = entry.type === 'orchestration' ? 'playlist_play' : 'route';
            const idx = i;
            segments.push({
                icon,
                label: displayName,
                onClick: () => this.#navigateToBreadcrumb(idx),
            });
        }

        // Current segment
        if (this._datasetContext) {
            segments.push({ icon: 'dataset', label: this._datasetContext.datasetName, onClick: null });
        } else {
            const p = this.pipelines?.find(p => p.id === this.selectedPipelineId);
            segments.push({
                icon: p?.kind === 'orchestration' ? 'playlist_play' : 'route',
                label: p?.name || this.selectedPipelineId || 'Unknown',
                onClick: null,
            });
        }

        this.eventBus?.emit('topbar:breadcrumb:update', { segments, actions });
    }

    /**
     * Emit panel configuration to the shell based on current ETL sub-view.
     *
     * - Right panel: only enabled when the pipeline step editor is open
     *   (it uses the right panel for node configuration).
     * - Bottom panel: disabled when showing the inline dataset detail view.
     */
    #emitPanelConfig() {
        this.eventBus?.emit('etl:panels:configure', {
            bottomPanel: !this._datasetContext,
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Main Content — Pipeline Detail
    // ═══════════════════════════════════════════════════════════════════

    #renderPlaceholder(message) {
        if (!this.mainContent) return;
        this._datasetDetailEl?.remove();
        this._datasetDetailEl = null;
        this.mainContent.style.display = '';
        this.mainContent.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.className = 'scenario-manager-placeholder';
        placeholder.innerHTML = `
            <span class="material-symbols-outlined">conversion_path</span>
            <p>${message}</p>
        `;
        this.mainContent.appendChild(placeholder);
    }

    #renderPipelineDetail(pipelineId) {
        // If a dataset context is active, render the dataset detail instead
        if (this._datasetContext) {
            this.#renderDatasetDetail();
            return;
        }

        const pipeline = this.pipelines.find(p => p.id === pipelineId);
        if (!pipeline || !this.mainContent) return;
        // Restore mainContent if it was hidden for dataset detail view
        this._datasetDetailEl?.remove();
        this._datasetDetailEl = null;
        this.mainContent.style.display = '';
        this.mainContent.style.overflow = '';
        this.mainContent.style.position = '';
        this.mainContent.innerHTML = '';

        if (pipeline.kind === 'orchestration') {
            this.#renderOrchestrationDetail(pipeline);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'scenario-detail';

        wrapper.appendChild(this.#renderHeader(pipeline));
        wrapper.appendChild(this.#renderPipelineFlow(pipeline));
        wrapper.appendChild(this.#renderSourcesSinksSection(pipeline));
        wrapper.appendChild(this.#renderDescriptionSection(pipeline));
        wrapper.appendChild(this.#renderRunHistory(pipeline));
        wrapper.appendChild(this.#renderDataPreview(pipeline));

        this.mainContent.appendChild(wrapper);

        // Show cached preview data in the bottom panel
        const lastResult = this._lastResults.get(pipelineId);
        if (lastResult) {
            this.#showRunPreviewInBottomPanel(lastResult, pipeline);
        } else {
            this.#loadCachedPreviews(pipeline);
        }
    }

    #renderOrchestrationDetail(orchestration) {
        const wrapper = document.createElement('div');
        wrapper.className = 'scenario-detail';

        // Header with orchestration-specific actions
        const badges = [];
        if (orchestration.datasetName) {
            badges.push({ text: orchestration.datasetName, icon: 'dataset' });
        }

        const header = createDetailHeader({
            title: orchestration.name || 'Unnamed Orchestration',
            badges,
            renameable: true,
            onRename: async (newName) => {
                this.#renamePipeline(orchestration.id, newName);
                this.#renderPipelineList();
                return { success: true, newValue: newName };
            },
            actions: [
                { key: 'edit', label: 'Edit', icon: 'edit', variant: 'secondary', handler: () => this.#openOrchestrationEditor(orchestration.id) },
                { key: 'run', label: 'Run All', icon: 'play_arrow', variant: 'primary', handler: () => this.#runOrchestration(orchestration.id) },
                { key: 'run-reset', label: 'Reset & Run', icon: 'restart_alt', variant: 'secondary', title: 'Invalidate cached data and re-fetch all pipelines from source', handler: () => this.#runOrchestration(orchestration.id, { forceRefresh: true }) },
                { key: 'export', label: 'Export', icon: 'file_download', variant: 'secondary', handler: () => this.#exportPipeline(orchestration.id) },
                { key: 'duplicate', label: 'Clone', icon: 'content_copy', variant: 'secondary', handler: () => this.#duplicatePipeline(orchestration.id) },
                { key: 'delete', label: 'Delete', icon: 'delete', variant: 'danger', handler: () => this.#deletePipeline(orchestration.id) },
            ],
        });

        wrapper.appendChild(header);

        // Pipeline items summary
        const items = orchestration.items || [];
        const summarySection = document.createElement('section');
        summarySection.className = 'scenario-detail__section';
        const summaryHeader = document.createElement('h3');
        summaryHeader.className = 'scenario-detail__section-title';
        summaryHeader.innerHTML = `<span class="material-symbols-outlined">playlist_play</span> Pipeline Calls (${items.length})`;
        summarySection.appendChild(summaryHeader);

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            empty.textContent = 'No pipelines added yet \u2014 click Edit to configure';
            summarySection.appendChild(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'etl-overview-table';
            table.innerHTML = `<thead><tr><th>Pipeline</th><th>Configuration</th><th>Status</th><th></th></tr></thead>`;
            const tbody = document.createElement('tbody');
            for (const item of items) {
                const paramCount = Object.keys(item.parameterValues || {}).length;
                const hasOutput = item.outputConfig?.datasetName || item.outputConfig?.seriesName;
                const configParts = [];
                if (paramCount > 0) configParts.push(`${paramCount} param${paramCount !== 1 ? 's' : ''}`);
                if (hasOutput) configParts.push('custom output');
                const configText = configParts.length > 0 ? configParts.join(', ') : '\u2014';
                const pipelineExists = this.pipelines.some(p => p.id === item.pipelineId);
                const openCell = pipelineExists
                    ? `<td><button type="button" class="scenario-btn scenario-btn--xs" data-action="open-pipeline" title="Open pipeline definition"><span class="material-symbols-outlined" style="font-size:14px">open_in_new</span></button></td>`
                    : '<td></td>';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${this.#escapeHTML(item.pipelineName || 'Unknown')}</td>
                    <td>${configText}</td>
                    <td>${item.enabled === false ? '<span style="color:var(--text-muted)">Disabled</span>' : '<span style="color:#4caf50">Enabled</span>'}</td>
                    ${openCell}
                `;
                tr.querySelector('[data-action="open-pipeline"]')?.addEventListener('click', () => {
                    this.#drillDown(item.pipelineId, {
                        type: 'orchestration',
                        id: orchestration.id,
                        name: orchestration.name || 'Unnamed Orchestration',
                    });
                });
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            summarySection.appendChild(table);
        }

        wrapper.appendChild(summarySection);
        wrapper.appendChild(this.#renderDescriptionSection(orchestration));
        wrapper.appendChild(this.#renderRunHistory(orchestration));

        this.mainContent.appendChild(wrapper);

        // Show per-pipeline overview tabs in bottom panel
        this._selectedOrchPipelineId = null;
        this.#showOrchestrationOverviewInBottomPanel(orchestration);
        this.#loadOrchestrationCachedPreviews(orchestration);
    }

    /**
     * Render an inline dataset detail view when drilling into a dataset
     * from a pipeline's Sinks table. Shows cached pipeline output data.
     */
    #renderDatasetDetail() {
        const ctx = this._datasetContext;
        if (!ctx) return;

        this.mainContent.style.display = 'none';
        this._datasetDetailEl?.remove();

        // Absolute-positioned overlay fills the page container
        this.container.style.position = 'relative';
        const root = document.createElement('div');
        root.style.cssText = 'position:absolute; inset:0; padding:20px 24px; display:flex; flex-direction:column; overflow:hidden;';
        this._datasetDetailEl = root;

        // Header
        const subtitleParts = [`Output from <strong>${this.#escapeHTML(ctx.pipelineName)}</strong>`];
        if (ctx.seriesName) subtitleParts.push(` \u2014 series: ${this.#escapeHTML(ctx.seriesName)}`);

        const header = createDetailHeader({
            title: ctx.datasetName,
            icon: 'dataset',
            subtitle: subtitleParts.join(''),
        });
        root.appendChild(header);

        // Data preview
        const cachedResult = this._lastResults.get(ctx.pipelineId);

        if (cachedResult?.results) {
            const pipeline = this.pipelines.find(p => p.id === ctx.pipelineId);
            const nodes = Array.isArray(pipeline?.steps) && pipeline.steps.length > 0
                ? pipeline.steps.map(s => ({ id: s.id, type: `etl-${s.type}`, config: s.config || {} }))
                : pipeline?.nodes || [];
            const sinkNode = nodes.find(n =>
                n.type?.includes('sink') && n.config?.datasetName === ctx.datasetName,
            ) || nodes.find(n => n.type?.includes('sink-dataset'));
            const sinkId = sinkNode?.id;
            let nr = sinkId && cachedResult.results[sinkId];
            if (!nr?.preview?.headers) {
                for (const val of Object.values(cachedResult.results)) {
                    if (val?.preview?.headers && val.preview.rows?.length) { nr = val; break; }
                }
            }

            if (nr?.preview?.headers && nr.preview.rows?.length) {
                const tableContainer = document.createElement('div');
                tableContainer.style.cssText = 'flex:1; min-height:0; display:flex; flex-direction:column;';
                root.appendChild(tableContainer);

                this._runPreviewTable?.dispose?.();
                this._runPreviewTable = new DataTable(tableContainer, {
                    headers: nr.preview.headers,
                    rows: nr.preview.rows,
                    readonly: true,
                    pagination: true,
                    pageSize: 50,
                    services: { eventBus: this.eventBus },
                });
                this._runPreviewTable.render();
            } else {
                root.innerHTML += `<div class="etl-preview__empty"><span class="material-symbols-outlined">table_chart</span><p>No preview data available for this output</p></div>`;
            }
        } else {
            root.innerHTML += `<div class="etl-preview__empty"><span class="material-symbols-outlined">play_arrow</span><p>Run the pipeline to preview dataset content</p></div>`;
        }

        this.container.appendChild(root);
    }

    #openOrchestrationEditor(orchestrationId) {
        const dto = this.dataManager.getEtlPipeline(orchestrationId);
        const orchestration = dto?.toJSON() ?? this.pipelines?.find(p => p.id === orchestrationId);
        if (!orchestration) return;

        this._orchEditor?.dispose();

        this.mainContent.innerHTML = '';
        this._orchEditor = new OrchestrationEditor({
            orchestration,
            container: this.mainContent,
            tabsContainer: document.getElementById('sector-tabs'),
            previewContainer: document.getElementById('etl-preview-bottom-panel'),
            eventBus: this.eventBus,
            dataManager: this.dataManager,
            logger: this.logger,
            onDone: (updated) => this.#closeOrchestrationEditor(updated),
            onOpenPipeline: (pipelineId) => this.#drillDown(pipelineId, {
                type: 'orchestration',
                id: orchestration.id,
                name: orchestration.name || 'Unnamed Orchestration',
            }),
            getPipelines: () => this.pipelines,
        });

        this.eventBus?.emit?.('etl:editor:opened');
        this.#emitPanelConfig();
    }

    #closeOrchestrationEditor(updatedOrchestration) {
        this._orchEditor?.dispose();
        this._orchEditor = null;

        this.eventBus?.emit?.('etl:editor:closed');

        // Clear drill-down context (back at orchestration level)
        this._navStack = [];
        this._datasetContext = null;

        // Clear standard bottom panel containers
        const sectorTabs = document.getElementById('sector-tabs');
        const etlPanel = document.getElementById('etl-preview-bottom-panel');
        if (sectorTabs) sectorTabs.innerHTML = '';
        if (etlPanel) etlPanel.innerHTML = '';

        if (updatedOrchestration) {
            this.dataManager.upsertEtlPipeline(updatedOrchestration);
            this.#persistToProjectFile(updatedOrchestration);
        }

        const id = updatedOrchestration?.id ?? this.selectedPipelineId;
        this.selectedPipelineId = id;
        this.#refresh();
        this.#emitPanelConfig();
    }

    async #runOrchestration(orchestrationId, { forceRefresh = false } = {}) {
        const orchestration = this.pipelines?.find(p => p.id === orchestrationId);
        if (!orchestration) return;

        // Diagnostic: log pipeline state so we can verify builtins loaded
        const projectCount = (this.dataManager?.listEtlPipelines?.() ?? []).length;
        const builtinCount = this._builtinPipelines.length;
        const totalCount = this.pipelines.length;
        console.info(
            `[ETLManagerPage] #runOrchestration: ${totalCount} pipelines available (${projectCount} project, ${builtinCount} builtin)`,
        );

        const items = (orchestration.items || []).filter(i => i.enabled !== false);
        if (items.length === 0) {
            this.eventBus?.emit?.('toast:show', {
                title: 'Nothing to run', message: 'No enabled pipeline items', severity: 'warning', durationMs: 3000,
            });
            return;
        }

        const startTime = Date.now();
        const runId = crypto.randomUUID();

        try {
            const api = window.pywebview?.api;
            if (!api?.etl_run_orchestration) throw new Error('ETL orchestration API not available');

            const payload = buildOrchestrationPayload(
                orchestration.items,
                this.pipelines,
                {
                    cacheTtlDays: orchestration.cacheTtlDays ?? 1,
                    datasetName: orchestration.datasetName,
                    forceRefresh,
                },
            );
            payload.parallel_workers = getSetting('etl.parallelWorkers') || 1;
            payload.run_id = runId;

            // Progress is tracked via WebSocket → ETLProgressTracker toast
            const response = await api.etl_run_orchestration(payload);

            if (response?.cancelled) {
                this.eventBus?.emit?.('etl:run:complete', { runId });
                this.eventBus?.emit?.('toast:show', {
                    title: 'Orchestration cancelled',
                    message: `${orchestration.name} was cancelled`,
                    severity: 'info',
                    durationMs: 3000,
                });
                this.#refresh();
                return;
            }

            let successCount = 0;
            const itemResults = response?.results || {};
            for (const item of items) {
                if (itemResults[item.id]?.ok) successCount++;
            }

            // Cache individual pipeline results for bottom panel previews
            for (const item of items) {
                const pipelineResult = itemResults[item.id];
                if (pipelineResult) {
                    this._lastResults.set(item.pipelineId, pipelineResult);
                }
            }

            const runRecord = {
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                duration: Date.now() - startTime,
                status: successCount === items.length ? 'ok' : (successCount > 0 ? 'partial' : 'error'),
                itemCount: items.length,
                successCount,
                itemResults: items.map(item => {
                    const result = itemResults[item.id];
                    const errors = result?.errors || [];
                    // If no result exists for this item, the pipeline was skipped (not found)
                    if (!result && !errors.length) {
                        errors.push('Referenced pipeline not found');
                    }
                    return {
                        itemId: item.id,
                        pipelineId: item.pipelineId,
                        pipelineName: item.pipelineName || this.pipelines?.find(p => p.id === item.pipelineId)?.name || 'Unknown',
                        ok: result?.ok ?? false,
                        errors,
                        stepCount: Object.keys(result?.results || {}).length,
                    };
                }),
            };
            const existingRuns = Array.isArray(orchestration.runs) ? orchestration.runs : [];
            const updatedOrch = {
                ...orchestration,
                runs: [runRecord, ...existingRuns],
            };
            this.dataManager.upsertEtlPipeline(updatedOrch);
            this.#persistToProjectFile(updatedOrch);

            const allOk = successCount === items.length;
            const failedCount = items.length - successCount;
            this.eventBus?.emit?.('etl:run:complete', { runId });
            this.eventBus?.emit?.('toast:show', {
                title: allOk ? 'Orchestration complete' : 'Orchestration finished with errors',
                message: allOk
                    ? `All ${items.length} pipelines succeeded`
                    : `${successCount}/${items.length} succeeded, ${failedCount} failed`,
                severity: allOk ? 'success' : 'warning',
                durationMs: allOk ? 4000 : 6000,
            });

            // Notify the Data page to refresh when any sink wrote data
            if (response?.datasets_changed) {
                this.eventBus?.emit?.('data:datasets:updated', { source: 'etl' });
            }

            this.#refresh();
        } catch (err) {
            this.eventBus?.emit?.('etl:run:error', { runId });
            this.eventBus?.emit?.('toast:show', {
                title: 'Orchestration failed', message: err.message, severity: 'error', durationMs: 5000,
            });
        }
    }

    #renderHeader(pipeline) {
        const actions = [
            { key: 'edit', label: 'Edit', icon: 'edit', variant: 'secondary', handler: () => this.#openStepEditor(pipeline.id) },
            { key: 'run', label: 'Run', icon: 'play_arrow', variant: 'primary', handler: () => this.#runPipeline(pipeline.id) },
            { key: 'export', label: 'Export', icon: 'file_download', variant: 'secondary', handler: () => this.#exportPipeline(pipeline.id) },
            { key: 'duplicate', label: 'Clone', icon: 'content_copy', variant: 'secondary', handler: () => this.#duplicatePipeline(pipeline.id) },
            { key: 'delete', label: 'Delete', icon: 'delete', variant: 'danger', handler: () => this.#deletePipeline(pipeline.id) },
        ];

        if (pipeline._builtin) {
            actions.push({ key: 'reset', label: 'Reset', icon: 'restart_alt', variant: 'secondary', title: 'Reset to original definition from assumptions', handler: () => this.#resetBuiltinPipeline(pipeline.id) });
        }

        return createDetailHeader({
            title: pipeline.name || 'Unnamed Pipeline',
            renameable: true,
            onRename: async (newName) => {
                this.#renamePipeline(pipeline.id, newName);
                this.#renderPipelineList();
                return { success: true, newValue: newName };
            },
            actions,
        });
    }

    // ─── Source / Sink type metadata ─────────────────────────────────

    static #SOURCE_TYPES = {
        'etl-source-csv':   { label: 'CSV',   icon: 'description',    field: 'url' },
        'etl-source-json':  { label: 'JSON',  icon: 'data_object',    field: 'url' },
        'etl-source-odata': { label: 'OData', icon: 'cloud_download', field: 'serviceUrl' },
    };

    static #SINK_TYPES = {
        'etl-sink-dataset':   { label: 'Dataset',   icon: 'dataset',  nameField: 'datasetName', navigable: true },
        'etl-sink-parameter': { label: 'Parameter',  icon: 'tune',    nameField: 'parameterName', navigable: false },
    };

    // ─── Node type metadata for flow diagram ────────────────────────

    static #NODE_META = {
        'etl-source-csv':          { label: 'CSV Source',     icon: 'csv',            category: 'source' },
        'etl-source-json':         { label: 'JSON Source',    icon: 'data_object',    category: 'source' },
        'etl-source-odata':        { label: 'OData Source',   icon: 'cloud_download', category: 'source' },
        'etl-transform-filter':    { label: 'Filter',         icon: 'filter_alt',     category: 'transform' },
        'etl-transform-unit':      { label: 'Unit Conversion',icon: 'straighten',     category: 'transform' },
        'etl-transform-temporal':  { label: 'Temporal',       icon: 'schedule',       category: 'transform' },
        'etl-transform-aggregate': { label: 'Aggregate',      icon: 'join',           category: 'transform' },
        'etl-transform-normalize':    { label: 'Normalize',      icon: 'equalizer',      category: 'transform' },
        'etl-transform-interpolate':  { label: 'Interpolate',    icon: 'show_chart',     category: 'transform' },
        'etl-transform-trim':         { label: 'Trim',            icon: 'content_cut',    category: 'transform' },
        'etl-transform-parse':        { label: 'Parse',           icon: 'text_format',    category: 'transform' },
        'etl-transform-join':         { label: 'Join',            icon: 'join_inner',     category: 'operation' },
        'etl-transform-union':        { label: 'Union',           icon: 'merge',          category: 'operation' },
        'etl-transform-expression':   { label: 'Expression',      icon: 'calculate',      category: 'transform' },
        'etl-transform-cumsum':       { label: 'Cumulative Sum',  icon: 'trending_up',    category: 'transform' },
        'etl-sink-dataset':        { label: 'Dataset Sink',   icon: 'dataset',        category: 'sink' },
        'etl-sink-parameter':      { label: 'Parameter Sink', icon: 'tune',           category: 'sink' },
        'etl-preview':             { label: 'Preview',        icon: 'visibility',     category: 'utility' },
        'etl-validate':            { label: 'Validate',       icon: 'check_circle',   category: 'utility' },
    };

    /**
     * Resolve node metadata for the flow diagram, falling back to
     * the NodePlatform definition for dynamically loaded provider nodes.
     */
    #getNodeMeta(nodeType) {
        const staticMeta = ETLManagerPage.#NODE_META[nodeType];
        if (staticMeta) return staticMeta;

        const def = this.#resolvePlatformDefinition(nodeType);
        if (def) {
            const isOp = nodeType === 'etl-transform-join' || nodeType === 'etl-transform-union';
            const category = isOp ? 'operation'
                : nodeType.startsWith('etl-source-') ? 'source'
                : nodeType.startsWith('etl-transform-') ? 'transform'
                : nodeType.startsWith('etl-sink-') ? 'sink' : 'utility';
            return {
                label: def.title || nodeType,
                icon: def.appearance?.icon?.content || 'cloud_download',
                category,
            };
        }
        return { label: nodeType, icon: 'help', category: 'utility' };
    }

    /**
     * Resolve source type metadata, falling back for provider sources.
     */
    #getSourceMeta(nodeType) {
        const staticMeta = ETLManagerPage.#SOURCE_TYPES[nodeType];
        if (staticMeta) return staticMeta;

        if (nodeType.startsWith('etl-source-')) {
            const def = this.#resolvePlatformDefinition(nodeType);
            return {
                label: def?.title || nodeType.replace('etl-source-', ''),
                icon: def?.appearance?.icon?.content || 'cloud_download',
                field: 'dataset',
            };
        }
        return null;
    }

    #resolvePlatformDefinition(nodeType) {
        return window.__ECOSIM_JS_NEW__?.nodePlatform?.getDefinition?.(nodeType) ?? null;
    }

    // ─── Pipeline Flow Diagram ──────────────────────────────────────

    #renderPipelineFlow(pipeline) {
        const section = document.createElement('section');
        section.className = 'scenario-detail__section';

        const header = document.createElement('h3');
        header.className = 'scenario-detail__section-title';
        header.innerHTML = '<span class="material-symbols-outlined">account_tree</span> Pipeline Flow';
        section.appendChild(header);

        // Resolve graph (nodes + connections) from any pipeline format
        let graphNodes = [];
        let graphConns = [];

        if (pipeline.graph?.nodes?.length > 0) {
            graphNodes = pipeline.graph.nodes;
            graphConns = pipeline.graph.connections || [];
        } else if (Array.isArray(pipeline.steps) && pipeline.steps.length > 0) {
            graphNodes = pipeline.steps
                .filter(s => s.enabled !== false)
                .map(s => ({ id: s.id, type: `etl-${s.type}`, config: s.config || {} }));
            // Linear chain: connect sequentially
            for (let i = 1; i < graphNodes.length; i++) {
                graphConns.push({
                    sourceId: graphNodes[i - 1].id,
                    targetId: graphNodes[i].id,
                });
            }
        } else if (Array.isArray(pipeline.nodes) && pipeline.nodes.length > 0) {
            graphNodes = pipeline.nodes;
            graphConns = pipeline.connections || [];
        }

        if (graphNodes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-flow__empty';
            empty.textContent = 'No steps \u2014 click Edit to build the pipeline';
            section.appendChild(empty);
            return section;
        }

        // Build lanes from graph
        const lanes = this.#buildFlowLanes(graphNodes, graphConns);

        const flow = document.createElement('div');
        flow.className = 'etl-flow etl-flow--multi-lane';

        for (const lane of lanes) {
            const laneEl = document.createElement('div');
            laneEl.className = 'etl-flow__lane';

            for (let i = 0; i < lane.length; i++) {
                if (i > 0) {
                    const gap = document.createElement('div');
                    gap.className = 'etl-flow__lane-gap';
                    laneEl.appendChild(gap);
                }
                const node = lane[i];
                const nodeEl = this.#renderFlowNode(node);
                nodeEl.dataset.nodeId = node.id;
                laneEl.appendChild(nodeEl);
            }

            flow.appendChild(laneEl);
        }

        section.appendChild(flow);

        // Draw ALL connectors as uniform SVG overlay after DOM is attached
        requestAnimationFrame(() => this.#drawFlowConnectors(flow, graphConns));

        return section;
    }

    /**
     * Build lanes from a DAG of nodes + connections for the detail view.
     * Each lane is an array of node objects representing a horizontal path.
     * The first lane to reach a merge node (join/union) claims it and
     * continues downstream; other upstream lanes stop before the merge.
     */
    #buildFlowLanes(nodes, connections) {
        if (nodes.length === 0) return [];

        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const outgoing = new Map();
        const incoming = new Map();

        for (const conn of connections) {
            if (!outgoing.has(conn.sourceId)) outgoing.set(conn.sourceId, []);
            outgoing.get(conn.sourceId).push(conn.targetId);
            if (!incoming.has(conn.targetId)) incoming.set(conn.targetId, []);
            incoming.get(conn.targetId).push(conn.sourceId);
        }

        const sources = nodes.filter(n => !incoming.has(n.id) || incoming.get(n.id).length === 0);
        if (sources.length === 0) sources.push(nodes[0]);

        const lanes = [];
        const visited = new Set();

        for (const source of sources) {
            const lane = [];
            let current = source.id;
            while (current && !visited.has(current)) {
                visited.add(current);
                lane.push(nodeMap.get(current));
                const targets = outgoing.get(current) || [];
                current = targets.find(t => !visited.has(t)) ?? null;
            }
            if (lane.length > 0) lanes.push(lane);
        }

        for (const node of nodes) {
            if (!visited.has(node.id)) lanes.push([node]);
        }

        return lanes;
    }

    #renderFlowNode(nodeData) {
        const meta = this.#getNodeMeta(nodeData.type);
        const cfg = nodeData.config || {};
        const displayName = cfg.displayName || meta.label;

        const el = document.createElement('div');
        el.className = `etl-flow-node etl-flow-node--${meta.category}`;
        el.title = displayName;

        // Icon zone
        const iconZone = document.createElement('div');
        iconZone.className = 'etl-flow-node__icon-zone';
        const icon = document.createElement('span');
        icon.className = 'etl-flow-node__icon material-symbols-outlined';
        icon.textContent = meta.icon;
        iconZone.appendChild(icon);

        // Separator
        const sep = document.createElement('div');
        sep.className = 'etl-flow-node__separator';

        // Text zone
        const textZone = document.createElement('div');
        textZone.className = 'etl-flow-node__text-zone';
        const nameEl = document.createElement('span');
        nameEl.className = 'etl-flow-node__name';
        nameEl.textContent = displayName;
        const typeEl = document.createElement('span');
        typeEl.className = 'etl-flow-node__type';
        typeEl.textContent = meta.label;
        textZone.appendChild(nameEl);
        textZone.appendChild(typeEl);

        el.appendChild(iconZone);
        el.appendChild(sep);
        el.appendChild(textZone);

        return el;
    }

    /**
     * Draw SVG connector lines for ALL connections (in-lane and cross-lane)
     * as a single uniform SVG overlay.
     */
    #drawFlowConnectors(flowEl, connections) {
        flowEl.querySelector('.etl-flow__connectors')?.remove();
        if (!connections.length) return;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('etl-flow__connectors');
        svg.setAttribute('width', flowEl.scrollWidth);
        svg.setAttribute('height', flowEl.scrollHeight);

        const flowRect = flowEl.getBoundingClientRect();
        const sx = flowEl.scrollLeft;
        const sy = flowEl.scrollTop;
        const r = 6;

        for (const conn of connections) {
            const sourceEl = flowEl.querySelector(`[data-node-id="${conn.sourceId}"]`);
            const targetEl = flowEl.querySelector(`[data-node-id="${conn.targetId}"]`);
            if (!sourceEl || !targetEl) continue;

            const sr = sourceEl.getBoundingClientRect();
            const tr = targetEl.getBoundingClientRect();

            const x1 = sr.right - flowRect.left + sx;
            const y1 = sr.top + sr.height / 2 - flowRect.top + sy;
            const x2 = tr.left - flowRect.left + sx;
            const y2 = tr.top + tr.height / 2 - flowRect.top + sy;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.classList.add('etl-flow__connector-path');

            const dy = y2 - y1;
            if (Math.abs(dy) < 2) {
                path.setAttribute('d', `M ${x1},${y1} L ${x2},${y2}`);
            } else {
                const midX = x2 - 14;
                const dir = dy > 0 ? 1 : -1;
                path.setAttribute('d', [
                    `M ${x1},${y1}`,
                    `L ${midX - r},${y1}`,
                    `Q ${midX},${y1} ${midX},${y1 + dir * r}`,
                    `L ${midX},${y2 - dir * r}`,
                    `Q ${midX},${y2} ${midX + r},${y2}`,
                    `L ${x2},${y2}`,
                ].join(' '));
            }
            svg.appendChild(path);
        }

        flowEl.appendChild(svg);
    }

    // ─── Sources & Sinks overview ─────────────────────────────────────

    #renderSourcesSinksSection(pipeline) {
        // Normalize to node-like objects with etl- prefixed types
        const nodes = Array.isArray(pipeline.steps) && pipeline.steps.length > 0
            ? pipeline.steps.map(s => ({ id: s.id, type: `etl-${s.type}`, config: s.config || {} }))
            : pipeline.nodes || [];

        const sources = nodes
            .filter(n => this.#getSourceMeta(n.type))
            .map(n => {
                const meta = this.#getSourceMeta(n.type);
                const cfg = n.config || {};
                return { type: meta.label, icon: meta.icon, name: cfg.displayName || '', location: cfg[meta.field] || '' };
            });

        const sinks = nodes
            .filter(n => ETLManagerPage.#SINK_TYPES[n.type])
            .map(n => {
                const meta = ETLManagerPage.#SINK_TYPES[n.type];
                const cfg = n.config || {};
                return {
                    type: meta.label, icon: meta.icon,
                    name: cfg.displayName || cfg[meta.nameField] || '',
                    dataset: cfg.datasetName || '',
                    series: cfg.seriesName || '',
                    navigable: meta.navigable,
                };
            });

        const section = document.createElement('section');
        section.className = 'scenario-detail__section';

        // ── Sources table ──
        const srcHeader = document.createElement('h3');
        srcHeader.className = 'scenario-detail__section-title';
        srcHeader.innerHTML = '<span class="material-symbols-outlined">cloud_download</span> Sources';
        section.appendChild(srcHeader);

        if (sources.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            empty.textContent = 'No source nodes';
            section.appendChild(empty);
        } else {
            section.appendChild(this.#buildSourcesTable(sources));
        }

        // ── Sinks table ──
        const sinkHeader = document.createElement('h3');
        sinkHeader.className = 'scenario-detail__section-title';
        sinkHeader.style.marginTop = '12px';
        sinkHeader.innerHTML = '<span class="material-symbols-outlined">output</span> Outputs';
        section.appendChild(sinkHeader);

        if (sinks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            empty.textContent = 'No output nodes';
            section.appendChild(empty);
        } else {
            section.appendChild(this.#buildSinksTable(sinks, pipeline));
        }

        return section;
    }

    #buildSourcesTable(sources) {
        const table = document.createElement('table');
        table.className = 'etl-overview-table';
        table.innerHTML = `<thead><tr><th>Type</th><th>Name</th><th>Location</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        for (const src of sources) {
            const tr = document.createElement('tr');
            const urlText = this.#truncateUrl(src.location);
            tr.innerHTML = `
                <td><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">${src.icon}</span> ${this.#escapeHTML(src.type)}</td>
                <td>${this.#escapeHTML(src.name)}</td>
                <td class="etl-overview-table__url" title="${this.#escapeHTML(src.location)}">${this.#escapeHTML(urlText)}</td>
            `;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
    }

    #buildSinksTable(sinks, pipeline) {
        const table = document.createElement('table');
        table.className = 'etl-overview-table';
        table.innerHTML = `<thead><tr><th>Type</th><th>Dataset</th><th>Series</th><th></th></tr></thead>`;
        const tbody = document.createElement('tbody');
        for (const sink of sinks) {
            const tr = document.createElement('tr');
            const nameCell = `<td>${this.#escapeHTML(sink.name || sink.dataset)}</td>`;
            const seriesCell = `<td>${this.#escapeHTML(sink.series)}</td>`;
            let actionCell = '<td></td>';
            if (sink.navigable && sink.dataset) {
                actionCell = `<td><button type="button" class="scenario-btn scenario-btn--xs" data-action="goto-dataset" data-dataset="${this.#escapeHTML(sink.dataset)}"><span class="material-symbols-outlined" style="font-size:14px">open_in_new</span></button></td>`;
            }
            tr.innerHTML = `
                <td><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">${sink.icon}</span> ${this.#escapeHTML(sink.type)}</td>
                ${nameCell}${seriesCell}${actionCell}
            `;
            // Wire navigation button
            const navBtn = tr.querySelector('[data-action="goto-dataset"]');
            navBtn?.addEventListener('click', () => {
                if (this._navStack.length > 0 && pipeline) {
                    // Already in drill-down context — show inline dataset detail
                    this.#drillIntoDataset(sink.dataset, sink.series, pipeline);
                } else {
                    // Direct selection — navigate to Data page
                    this.eventBus?.emit?.('shell:request-mode', { mode: 'database' });
                    setTimeout(() => {
                        this.eventBus?.emit?.('search:dataset:selected', { datasetName: sink.dataset });
                    }, 100);
                }
            });
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
    }

    #truncateUrl(url) {
        if (!url || url.length <= 60) return url;
        try {
            const u = new URL(url);
            const path = u.pathname;
            const lastSeg = path.split('/').filter(Boolean).pop() || '';
            return `${u.hostname}/\u2026/${lastSeg}${u.search ? '?' + '\u2026' : ''}`;
        } catch {
            return url.slice(0, 30) + '\u2026' + url.slice(-25);
        }
    }

    #renderDescriptionSection(pipeline) {
        const section = document.createElement('section');
        section.className = 'scenario-detail__section';

        const header = document.createElement('h3');
        header.className = 'scenario-detail__section-title';
        header.innerHTML = '<span class="material-symbols-outlined">description</span> Description';
        section.appendChild(header);

        const textarea = document.createElement('textarea');
        textarea.className = 'sm-field__input';
        textarea.rows = 3;
        textarea.placeholder = 'Add a description\u2026';
        textarea.value = pipeline.description || '';
        textarea.style.cssText = 'resize:vertical;font-family:inherit;width:100%;';
        textarea.addEventListener('blur', () => this.#updatePipeline(pipeline.id, { description: textarea.value }));
        section.appendChild(textarea);

        return section;
    }

    #renderRunHistory(pipeline) {
        const runs = pipeline.runs || [];

        const section = document.createElement('section');
        section.className = 'scenario-detail__section';
        section.dataset.section = 'run-history';

        const header = document.createElement('h3');
        header.className = 'scenario-detail__section-title';
        header.innerHTML = `<span class="material-symbols-outlined">history</span> Run History <span class="etl-run-count">(${runs.length})</span>`;
        section.appendChild(header);

        if (runs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            const hasCached = this._lastResults.has(pipeline.id);
            empty.textContent = hasCached
                ? 'Showing cached data from a previous run'
                : 'No runs yet \u2014 click Run to execute the pipeline';
            section.appendChild(empty);
            return section;
        }

        const table = document.createElement('table');
        table.className = 'etl-overview-table';
        table.innerHTML = '<thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead>';
        const tbody = document.createElement('tbody');

        for (const run of runs.slice(-20).reverse()) {
            const isOrchestration = Array.isArray(run.itemResults);
            const tr = document.createElement('tr');
            const timestamp = new Date(run.timestamp || 0).toLocaleString();
            const duration = run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '\u2014';
            const statusIcon = run.status === 'ok' ? 'check_circle' : (run.status === 'partial' ? 'warning' : 'error');
            const statusClass = run.status === 'ok'
                ? 'etl-run-status--ok'
                : (run.status === 'partial' ? 'etl-run-status--partial' : 'etl-run-status--error');

            if (isOrchestration) {
                tr.className = 'etl-run-row--expandable';
                const summary = `${run.successCount}/${run.itemCount} succeeded`;
                tr.innerHTML = `
                    <td>${timestamp}</td>
                    <td class="${statusClass}"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">${statusIcon}</span> ${run.status || 'unknown'}</td>
                    <td>${duration}</td>
                    <td class="etl-run-row__summary">
                        ${this.#escapeHTML(summary)}
                        <span class="material-symbols-outlined etl-run-row__chevron" style="font-size:16px;vertical-align:middle;margin-left:4px">expand_more</span>
                    </td>
                `;

                // Expandable detail row
                const detailTr = document.createElement('tr');
                detailTr.className = 'etl-run-detail';
                detailTr.style.display = 'none';
                const detailTd = document.createElement('td');
                detailTd.colSpan = 4;
                detailTd.appendChild(this.#renderOrchestrationRunResults(run.itemResults, pipeline));
                detailTr.appendChild(detailTd);

                tr.addEventListener('click', () => {
                    const visible = detailTr.style.display !== 'none';
                    detailTr.style.display = visible ? 'none' : 'table-row';
                    tr.classList.toggle('etl-run-row--expanded', !visible);

                    // On collapse, clear pipeline drill-down and restore overview
                    if (visible && this._selectedOrchPipelineId) {
                        this._selectedOrchPipelineId = null;
                        const orchestration = this.pipelines.find(p => p.id === this.selectedPipelineId);
                        if (orchestration) this.#showOrchestrationOverviewInBottomPanel(orchestration);
                    }
                });

                tbody.appendChild(tr);
                tbody.appendChild(detailTr);
            } else {
                const errorText = run.error ? this.#escapeHTML(run.error) : '';
                tr.innerHTML = `
                    <td>${timestamp}</td>
                    <td class="${statusClass}"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">${statusIcon}</span> ${run.status || 'unknown'}</td>
                    <td>${duration}</td>
                    <td class="etl-overview-table__url" title="${errorText}">${errorText || '\u2014'}</td>
                `;
                if (run.error) {
                    tr.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.#showErrorContextMenu(e.clientX, e.clientY, run.error, pipeline.name);
                    });
                }
                tbody.appendChild(tr);
            }
        }

        table.appendChild(tbody);
        section.appendChild(table);
        return section;
    }

    #renderOrchestrationRunResults(itemResults, orchestration) {
        const container = document.createElement('div');
        container.className = 'etl-run-detail__content';

        const subTable = document.createElement('table');
        subTable.className = 'etl-run-detail__table';
        subTable.innerHTML = '<thead><tr><th>Pipeline</th><th>Status</th><th>Steps</th><th>Errors</th><th></th></tr></thead>';
        const subBody = document.createElement('tbody');

        // Build a lookup from itemId → pipelineId using orchestration items
        const orchItems = orchestration?.items || [];
        const itemToPipeline = new Map();
        for (const oi of orchItems) {
            itemToPipeline.set(oi.id, oi.pipelineId);
        }

        for (const item of itemResults) {
            const pipelineId = item.pipelineId || itemToPipeline.get(item.itemId) || null;
            const row = document.createElement('tr');
            row.className = 'etl-run-detail__pipeline-row';
            if (pipelineId) row.dataset.pipelineId = pipelineId;

            const statusIcon = item.ok ? 'check_circle' : 'error';
            const statusClass = item.ok ? 'etl-run-detail__status--ok' : 'etl-run-detail__status--error';
            // Show only root-cause errors — filter out "Skipped" / "Upstream node … failed" cascade noise
            const rootErrors = (item.errors || []).filter(e => !/\bupstream node\b/i.test(e) && !/\bSkipped\b/.test(e));
            const displayErrors = rootErrors.length > 0 ? rootErrors : (item.errors || []).slice(0, 1);
            const errorText = displayErrors.length > 0 ? this.#escapeHTML(displayErrors.join('; ')) : '\u2014';

            row.innerHTML = `
                <td class="etl-run-detail__pipeline-name">${this.#escapeHTML(item.pipelineName)}</td>
                <td class="${statusClass}"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">${statusIcon}</span> ${item.ok ? 'ok' : 'error'}</td>
                <td>${item.stepCount || '\u2014'}</td>
                <td class="etl-run-detail__errors" title="${errorText}">${errorText}</td>
                <td></td>
            `;

            // Click handler for pipeline drill-down
            if (pipelineId) {
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#toggleOrchPipelineSelection(pipelineId, subBody);
                });
            }

            // Context menu for all rows (copy error / copy pipeline name)
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const errorMsg = item.errors?.length > 0 ? item.errors.join('\n') : null;
                this.#showErrorContextMenu(e.clientX, e.clientY, errorMsg, item.pipelineName);
            });

            // Add re-run button for failed pipelines
            if (!item.ok) {
                const actionTd = row.querySelector('td:last-child');
                const rerunBtn = document.createElement('button');
                rerunBtn.type = 'button';
                rerunBtn.className = 'etl-run-detail__rerun-btn';
                rerunBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px">replay</span> Re-run';
                rerunBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#rerunPipeline(item.pipelineName);
                });
                actionTd.appendChild(rerunBtn);
            }

            subBody.appendChild(row);
        }

        subTable.appendChild(subBody);
        container.appendChild(subTable);
        return container;
    }

    #renderDataPreview(pipeline) {
        const section = document.createElement('section');
        section.className = 'scenario-detail__section';
        section.dataset.section = 'data-preview';

        const header = document.createElement('h3');
        header.className = 'scenario-detail__section-title';
        header.innerHTML = '<span class="material-symbols-outlined">table_chart</span> Data Preview';
        section.appendChild(header);

        // Try run history first, then fall back to cached result data
        const runs = pipeline.runs || [];
        const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

        let inputPreview = null;
        let outputPreview = null;

        if (lastRun?.status === 'ok') {
            inputPreview = lastRun.inputPreview;
            outputPreview = lastRun.outputPreview;
        } else {
            // Extract from cached result (disk cache or in-memory)
            const cached = this._lastResults.get(pipeline.id);
            if (cached?.results) {
                ({ inputPreview, outputPreview } = this.#extractPreviews(cached, pipeline.steps || []));
            }
        }

        if (!inputPreview && !outputPreview) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            if (lastRun && lastRun.status !== 'ok') {
                const errorDetail = lastRun.error ? `: ${lastRun.error}` : '';
                empty.textContent = `Last run failed${errorDetail}`;
            } else {
                empty.textContent = 'Run the pipeline to preview input and output data';
            }
            section.appendChild(empty);
            return section;
        }

        if (inputPreview) {
            section.appendChild(this.#buildPreviewSubsection('Input Data', inputPreview));
        }
        if (outputPreview) {
            section.appendChild(this.#buildPreviewSubsection('Output Data', outputPreview));
        }

        return section;
    }

    /**
     * Replace the inline Data Preview section in the detail view with fresh data.
     */
    #refreshDataPreviewSection(pipeline) {
        const existing = this.mainContent?.querySelector('[data-section="data-preview"]');
        if (!existing) return;
        existing.replaceWith(this.#renderDataPreview(pipeline));
    }

    #refreshRunHistorySection(pipeline) {
        const existing = this.mainContent?.querySelector('[data-section="run-history"]');
        if (!existing) return;
        existing.replaceWith(this.#renderRunHistory(pipeline));
    }

    #buildPreviewSubsection(title, preview) {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '10px';

        const subheader = document.createElement('h4');
        subheader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);margin:6px 0 4px;';
        subheader.textContent = title;
        wrapper.appendChild(subheader);

        if (!preview.columns || !preview.rows || preview.rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'etl-table-empty';
            empty.textContent = 'No data';
            wrapper.appendChild(empty);
            return wrapper;
        }

        const table = document.createElement('table');
        table.className = 'etl-overview-table etl-preview-table';

        // Header row
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const col of preview.columns.slice(0, 8)) {
            const th = document.createElement('th');
            th.textContent = col;
            headerRow.appendChild(th);
        }
        if (preview.columns.length > 8) {
            const th = document.createElement('th');
            th.textContent = `\u2026+${preview.columns.length - 8}`;
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Data rows (first 5)
        const tbody = document.createElement('tbody');
        for (const row of preview.rows.slice(0, 5)) {
            const tr = document.createElement('tr');
            for (const col of preview.columns.slice(0, 8)) {
                const td = document.createElement('td');
                const val = row[col];
                td.textContent = val == null ? '' : String(val);
                td.title = td.textContent;
                tr.appendChild(td);
            }
            if (preview.columns.length > 8) {
                const td = document.createElement('td');
                td.textContent = '\u2026';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrapper.appendChild(table);

        // Row count summary
        if (preview.totalRows > 5) {
            const summary = document.createElement('div');
            summary.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:2px;';
            summary.textContent = `Showing 5 of ${preview.totalRows.toLocaleString()} rows`;
            wrapper.appendChild(summary);
        }

        return wrapper;
    }

    // ═══════════════════════════════════════════════════════════════════
    // CRUD Operations
    // ═══════════════════════════════════════════════════════════════════

    async #createPipeline() {
        const id = crypto.randomUUID();
        const name = `Pipeline ${this.pipelines.filter(p => p.kind !== 'orchestration').length + 1}`;
        const data = {
            id,
            kind: 'pipeline',
            name,
            description: '',
            parameters: [],
            steps: [],
            runs: [],
        };

        // Create as project file if a project is open
        const filePath = await this.#createProjectFile(data, 'pipeline');
        if (filePath) data._filePath = filePath;

        this.dataManager.upsertEtlPipeline(data);
        this.selectedPipelineId = id;
        this.#refresh();

        // Open the new pipeline in rename mode
        requestAnimationFrame(() => this.#startSidebarRename(id));
    }

    async #createOrchestration() {
        const id = crypto.randomUUID();
        const name = `Orchestration ${this.pipelines.filter(p => p.kind === 'orchestration').length + 1}`;
        const data = {
            id,
            kind: 'orchestration',
            name,
            description: '',
            items: [],
            runs: [],
            cacheTtlDays: 1,
        };

        const filePath = await this.#createProjectFile(data, 'orchestration');
        if (filePath) data._filePath = filePath;

        this.dataManager.upsertEtlPipeline(data);
        this.selectedPipelineId = id;
        this.#refresh();

        requestAnimationFrame(() => this.#startSidebarRename(id));
    }

    #renamePipeline(id, newName) {
        const existing = this.dataManager.getEtlPipeline(id);
        if (!existing || !newName || existing.name === newName) return;
        const updated = existing.withChanges({ name: newName });
        this.dataManager.upsertEtlPipeline(updated);
        this.#persistToProjectFile(updated);
    }

    #updatePipeline(id, patch) {
        const existing = this.dataManager.getEtlPipeline(id);
        if (!existing) return;
        const updated = existing.withChanges(patch);
        this.dataManager.upsertEtlPipeline(updated);
        this.#persistToProjectFile(updated);
    }

    #duplicatePipeline(id) {
        const source = this.pipelines.find(p => p.id === id);
        if (!source) return;

        const newId = crypto.randomUUID();
        const data = {
            ...structuredClone(source),
            id: newId,
            name: `${source.name} (copy)`,
            runs: [],
            _filePath: undefined,
        };

        // Create a new project file for the copy if project is open
        this.#createProjectFile(data, source.kind === 'orchestration' ? 'orchestration' : 'pipeline')
            .then(filePath => {
                if (filePath) {
                    const dto = this.dataManager.getEtlPipeline(newId);
                    if (dto) this.dataManager.upsertEtlPipeline(dto.withChanges({ _filePath: filePath }));
                }
            });

        this.dataManager.upsertEtlPipeline(data);
        this.selectedPipelineId = newId;
        this.#refresh();
    }

    async #deletePipeline(id) {
        const existing = this.dataManager.getEtlPipeline(id);
        const removed = this.dataManager.removeEtlPipeline(id);
        if (!removed) return;

        // Delete project file if applicable
        if (existing?._filePath && this._projectModel?.isOpen) {
            try {
                await this._projectModel.deleteFile(existing._filePath);
            } catch (err) {
                this.logger?.warn?.('[ETLManagerPage] Failed to delete project file', err);
            }
        }

        if (this.selectedPipelineId === id) {
            const remaining = this.dataManager.listEtlPipelines();
            this.selectedPipelineId = remaining[0]?.id || null;
        }
        this.#refresh();
    }

    // ─── Project file persistence helpers ────────────────────────────

    /**
     * Persist a pipeline/orchestration DTO to its project file.
     * No-op if the pipeline has no _filePath (e.g., builtins).
     */
    async #persistToProjectFile(dto) {
        if (!dto?._filePath || !this._projectModel?.isOpen) return;
        try {
            const json = typeof dto.toJSON === 'function' ? dto.toJSON() : { ...dto };
            delete json._filePath; // Don't persist the meta field
            const api = window.pywebview?.api;
            await api?.project_write_file({
                projectPath: this._projectModel.projectPath,
                filePath: dto._filePath,
                content: JSON.stringify(json, null, 2),
            });
        } catch (err) {
            this.logger?.warn?.('[ETLManagerPage] Failed to persist pipeline to project file', err);
        }
    }

    /**
     * Create a new project file for a pipeline/orchestration.
     * Returns the file path if created, null otherwise.
     */
    async #createProjectFile(data, fileType) {
        if (!this._projectModel?.isOpen) return null;
        try {
            const ext = fileType === 'orchestration' ? '.orchestration' : '.pipeline';
            const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const filePath = `etl/${slug}${ext}`;
            const json = { ...data };
            delete json._filePath;
            await this._projectModel.createFile(filePath, fileType, JSON.stringify(json, null, 2));
            return filePath;
        } catch (err) {
            this.logger?.warn?.('[ETLManagerPage] Failed to create project file', err);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export / Import
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Strip a pipeline/orchestration down to its portable definition.
     * Removes all instance-specific and runtime state so the export
     * contains only what is needed to reconstruct the definition.
     */
    #stripForExport(pipeline) {
        const out = { kind: pipeline.kind, name: pipeline.name };

        if (pipeline.description) out.description = pipeline.description;

        // Pipeline-specific
        if (pipeline.kind !== 'orchestration') {
            if (pipeline.parameters?.length) out.parameters = structuredClone(pipeline.parameters);
            if (pipeline.steps?.length) {
                out.steps = pipeline.steps.map(({ type, config }) => ({ type, config: structuredClone(config) }));
            }
        }

        // Orchestration-specific
        if (pipeline.kind === 'orchestration') {
            if (pipeline.cacheTtlDays != null && pipeline.cacheTtlDays !== 1) out.cacheTtlDays = pipeline.cacheTtlDays;
            if (pipeline.datasetName) out.datasetName = pipeline.datasetName;
            if (pipeline.items?.length) {
                out.items = pipeline.items.map(({ pipelineId, pipelineName, parameterValues, outputConfig }) => {
                    const entry = { pipelineId, pipelineName };
                    if (parameterValues && Object.keys(parameterValues).length) entry.parameterValues = structuredClone(parameterValues);
                    if (outputConfig && (outputConfig.datasetName || outputConfig.seriesName)) entry.outputConfig = structuredClone(outputConfig);
                    return entry;
                });
            }
        }

        return out;
    }

    async #exportPipeline(pipelineId) {
        const pipeline = this.pipelines.find(p => p.id === pipelineId);
        if (!pipeline) return;

        const items = [];

        // If orchestration, bundle referenced pipelines first (makes export self-contained)
        if (pipeline.kind === 'orchestration') {
            const referencedIds = new Set(
                (pipeline.items || []).map(item => item.pipelineId).filter(Boolean),
            );
            for (const refId of referencedIds) {
                const refPipeline = this.pipelines.find(p => p.id === refId);
                if (refPipeline) items.push(this.#stripForExport(refPipeline));
            }
        }

        items.push(this.#stripForExport(pipeline));

        const envelope = {
            format: 'ecosim-etl-export',
            version: 1,
            exportedAt: Date.now(),
            items,
        };

        const json = JSON.stringify(envelope, null, 2);
        const defaultFilename = `${pipeline.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

        const api = window.pywebview?.api;
        if (api?.save_file_dialog) {
            try {
                const result = await api.save_file_dialog(json, defaultFilename, 'json');
                if (result?.ok) {
                    this.logger?.info?.('etl', `[ETLManagerPage] Exported to: ${result.path}`);
                } else if (!result?.cancelled) {
                    alert(`Export failed: ${result?.error || 'Unknown error'}`);
                }
            } catch (err) {
                this.logger?.error?.('etl', '[ETLManagerPage] Export failed', err);
                alert(`Export failed: ${err.message}`);
            }
        } else {
            // Browser fallback
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultFilename;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    async #importPipeline() {
        const api = window.pywebview?.api;
        let content = null;

        if (api?.open_file_dialog) {
            try {
                const result = await api.open_file_dialog('json');
                if (!result?.ok) return; // cancelled or error
                content = result.content;
            } catch (err) {
                this.logger?.error?.('etl', '[ETLManagerPage] Import dialog failed', err);
                alert(`Import failed: ${err.message}`);
                return;
            }
        } else {
            // Browser fallback
            content = await new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async (e) => {
                    const file = e.target.files?.[0];
                    resolve(file ? await file.text() : null);
                });
                input.click();
            });
            if (!content) return;
        }

        this.#parseAndImportETL(content);
    }

    #parseAndImportETL(content) {
        let envelope;
        try {
            envelope = JSON.parse(content);
        } catch {
            alert('Import failed: invalid JSON file.');
            return;
        }

        if (envelope.format !== 'ecosim-etl-export' || !Array.isArray(envelope.items) || envelope.items.length === 0) {
            alert('Import failed: not a valid ETL export file.');
            return;
        }

        // Exported items carry pipelineId references by old IDs.
        // Assign new IDs per exported name so orchestration refs can be remapped.
        const nameToNewId = new Map();
        for (const item of envelope.items) {
            if (item.kind !== 'orchestration' && item.name) {
                nameToNewId.set(item.name, crypto.randomUUID());
            }
        }

        let importedCount = 0;
        let lastImportedId = null;

        // Import pipelines first (orchestrations reference them)
        const pipelines = envelope.items.filter(item => item.kind !== 'orchestration');
        const orchestrations = envelope.items.filter(item => item.kind === 'orchestration');

        for (const item of [...pipelines, ...orchestrations]) {
            try {
                const newId = nameToNewId.get(item.name) || crypto.randomUUID();
                const now = Date.now();

                const imported = {
                    id: newId,
                    kind: item.kind || 'pipeline',
                    name: `${item.name} (imported)`,
                    description: item.description || null,
                    runs: [],
                    metadata: {},
                    createdAt: now,
                    updatedAt: now,
                };

                // Pipeline-specific: generate fresh step IDs
                if (item.kind !== 'orchestration') {
                    imported.parameters = item.parameters || [];
                    imported.steps = (item.steps || []).map(step => ({
                        id: crypto.randomUUID(),
                        type: step.type,
                        config: step.config || {},
                        enabled: true,
                    }));
                }

                // Orchestration-specific: generate fresh item IDs, remap pipelineId by name
                if (item.kind === 'orchestration') {
                    imported.cacheTtlDays = item.cacheTtlDays ?? 1;
                    imported.datasetName = item.datasetName || null;
                    imported.items = (item.items || []).map(orchItem => ({
                        id: crypto.randomUUID(),
                        pipelineId: nameToNewId.get(orchItem.pipelineName) || orchItem.pipelineId,
                        pipelineName: orchItem.pipelineName,
                        enabled: true,
                        parameterValues: orchItem.parameterValues || {},
                        outputConfig: orchItem.outputConfig || {},
                    }));
                }

                this.dataManager.upsertEtlPipeline(imported);
                importedCount++;
                lastImportedId = newId;
            } catch (err) {
                this.logger?.warn?.('etl', `[ETLManagerPage] Failed to import item: ${item.name}`, err);
            }
        }

        if (importedCount > 0) {
            this.selectedPipelineId = lastImportedId;
            this.#refresh();
            this.logger?.info?.('etl', `[ETLManagerPage] Imported ${importedCount} item(s)`);
        } else {
            alert('Import failed: no valid items found in the file.');
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Step Editor
    // ═══════════════════════════════════════════════════════════════════

    #openStepEditor(pipelineId) {
        const dto = this.dataManager.getEtlPipeline(pipelineId);
        const pipeline = dto?.toJSON() ?? this.pipelines?.find(p => p.id === pipelineId);
        if (!pipeline) return;

        // Teardown any existing editor
        this._stepEditor?.dispose();

        // Ensure pipeline has step format
        ensurePipelineFormat(pipeline);

        // Show editor in main content area
        this.mainContent.innerHTML = '';
        this.mainContent.style.position = 'relative';
        this.mainContent.style.overflow = 'hidden';

        // Create a sub-container for the step editor (editor clears its container)
        const editorContainer = document.createElement('div');
        editorContainer.className = 'etl-step-editor-container';
        this.mainContent.appendChild(editorContainer);

        this.eventBus?.emit?.('etl:editor:opened');
        this.eventBus?.emit('etl:panels:configure', {
            bottomPanel: !this._datasetContext,
        });

        // Create the step editor with a temporary config container
        // (PanelController requires a valid DOM element at init time)
        const tempConfigContainer = document.createElement('div');
        this._stepEditor = new PipelineStepEditor({
            pipeline,
            container: editorContainer,
            configContainer: tempConfigContainer,
            tabsContainer: document.getElementById('sector-tabs'),
            previewContainer: document.getElementById('etl-preview-bottom-panel'),
            eventBus: this.eventBus,
            dataManager: this.dataManager,
            logger: this.logger,
            onDone: (updatedPipeline) => this.#closeStepEditor(updatedPipeline),
            lastRunResults: this._lastResults.get(pipelineId) || null,
        });

        // Mount slide-out panel on mainContent AFTER editor renders
        // (so the panel DOM doesn't get destroyed by editor's innerHTML clearing)
        this._slideOutPanel?.dispose();
        this._slideOutPanel = new SlideOutPanel({ width: 700 });
        this._slideOutPanel.mount(this.mainContent);

        // Wire the panel's contentEl into the step editor's panel controller
        this._stepEditor.setConfigContainer(this._slideOutPanel.contentEl);

        // Auto-open if there are nodes (editor already auto-selected first node)
        const hasNodes = pipeline.steps?.length > 0 || pipeline.graph?.nodes?.length > 0;
        if (hasNodes) {
            this._slideOutPanel.open('Node Config', 'settings');
            // Re-render config for the already-selected node
            this._stepEditor.refreshSelectedNodeConfig();
        }

        // Listen for node selection/deselection to open/close the panel
        const onNodeSelected = () => {
            if (!this._slideOutPanel?.isOpen) {
                this._slideOutPanel?.open('Node Config', 'settings');
            }
        };
        const onNodeDeselected = () => {
            this._slideOutPanel?.close();
        };
        this.eventBus?.on?.('etl:node:selected', onNodeSelected);
        this.eventBus?.on?.('etl:node:deselected', onNodeDeselected);
        this._stepEditorDisposers = [
            () => this.eventBus?.off?.('etl:node:selected', onNodeSelected),
            () => this.eventBus?.off?.('etl:node:deselected', onNodeDeselected),
        ];

        // Expose on runtime so autocomplete providers can access lastRunResults
        const runtime = window.__ECOSIM_JS_NEW__;
        if (runtime) runtime.etlStepEditor = this._stepEditor;
    }

    #closeStepEditor(updatedPipeline) {
        // Clean up node selection listeners
        for (const d of (this._stepEditorDisposers ?? [])) d();
        this._stepEditorDisposers = [];

        this._stepEditor?.dispose();
        this._stepEditor = null;
        this._slideOutPanel?.dispose();
        this._slideOutPanel = null;

        this.eventBus?.emit?.('etl:editor:closed');

        // Clear standard bottom panel containers
        const sectorTabs = document.getElementById('sector-tabs');
        const etlPanel = document.getElementById('etl-preview-bottom-panel');
        if (sectorTabs) sectorTabs.innerHTML = '';
        if (etlPanel) etlPanel.innerHTML = '';

        if (updatedPipeline) {
            // Check if this is a built-in pipeline
            const isBuiltin = this._builtinPipelines.some(p => p.id === updatedPipeline.id);

            if (isBuiltin) {
                // Persist built-in changes to AppData
                const builtinIdx = this._builtinPipelines.findIndex(p => p.id === updatedPipeline.id);
                if (builtinIdx >= 0) this._builtinPipelines[builtinIdx] = updatedPipeline;

                const api = window.pywebview?.api;
                api?.etl_save_builtin_pipeline?.(updatedPipeline)?.catch?.(err => {
                    this.logger?.warn?.('etl', '[ETLManagerPage] Failed to save built-in pipeline to AppData', err);
                });
            } else {
                // Persist changes via DataManager
                this.dataManager.upsertEtlPipeline(updatedPipeline);
                this.#persistToProjectFile(updatedPipeline);
            }
        }

        // Re-render the detail view
        const id = updatedPipeline?.id ?? this.selectedPipelineId;
        this.selectedPipelineId = id;
        this.#refresh();
        this.#emitPanelConfig();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Pipeline Execution
    // ═══════════════════════════════════════════════════════════════════

    async #runPipeline(pipelineId, { forceRefresh = false } = {}) {
        const pipeline = this.pipelines?.find(p => p.id === pipelineId);
        const hasGraph = pipeline?.graph?.nodes?.length > 0;
        const hasSteps = Array.isArray(pipeline?.steps) && pipeline.steps.length > 0;
        const hasNodes = Array.isArray(pipeline?.nodes) && pipeline.nodes.length > 0;
        if (!pipeline || (!hasGraph && !hasSteps && !hasNodes)) {
            this.eventBus?.emit?.('toast:show', {
                title: 'Empty pipeline',
                message: 'Add steps to the pipeline before running',
                severity: 'warning',
                durationMs: 3000,
            });
            return;
        }

        const startTime = Date.now();
        const runId = crypto.randomUUID();

        try {
            const api = window.pywebview?.api;
            if (!api?.etl_run_pipeline) {
                throw new Error('ETL pipeline API not available');
            }

            // Resolve parameter tokens and convert to graph for backend
            let graph;
            if (hasGraph) {
                // New graph format — resolve parameters before sending
                graph = resolveGraphParameters(
                    pipeline.graph,
                    pipeline.parameters,
                    null, // Use defaults when running from detail view
                );
            } else if (hasSteps) {
                const resolved = resolveParameters(
                    pipeline.steps,
                    pipeline.parameters,
                    null, // Use defaults when running from detail view
                );
                graph = stepsToGraph(resolved);
            } else {
                graph = { nodes: pipeline.nodes, connections: pipeline.connections };
            }

            const config = {
                id: pipeline.id,
                name: pipeline.name,
                ...graph,
                run_id: runId,
                force_refresh: forceRefresh,
            };

            // Progress is tracked via WebSocket → ETLProgressTracker toast
            const result = await api.etl_run_pipeline(config);

            if (result?.cancelled) {
                this.eventBus?.emit?.('etl:run:complete', { runId });
                this.eventBus?.emit?.('toast:show', {
                    title: 'Pipeline cancelled',
                    message: `${pipeline.name} was cancelled`,
                    severity: 'info',
                    durationMs: 3000,
                });
                this.#refresh();
                return;
            }

            // Determine success: check both ok flag and errors array
            const errors = result?.errors || [];
            const succeeded = result?.ok && errors.length === 0;

            // Extract input/output previews from per-node results
            const { inputPreview, outputPreview } = this.#extractPreviews(
                result, pipeline.steps || [],
            );

            const run = {
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                status: succeeded ? 'ok' : 'error',
                duration: Date.now() - startTime,
                error: succeeded ? null : (result?.error || errors.join('; ') || 'Unknown error'),
                inputPreview,
                outputPreview,
            };

            const existingRuns = Array.isArray(pipeline.runs) ? pipeline.runs : [];
            this.#persistRunHistory(pipeline, [...existingRuns, run]);

            // Store the raw result so the bottom panel can show it on re-select
            if (succeeded) {
                this._lastResults.set(pipelineId, result);
            }

            this.eventBus?.emit?.('etl:run:complete', { runId });

            if (succeeded) {
                this.eventBus?.emit?.('toast:show', {
                    title: 'Pipeline complete',
                    message: `${pipeline.name} executed successfully`,
                    severity: 'success',
                    durationMs: 4000,
                });
            } else {
                const errMsg = result?.error || errors[0] || 'Pipeline execution failed';
                this.eventBus?.emit?.('toast:show', {
                    title: 'Pipeline finished with errors',
                    message: errMsg,
                    severity: 'warning',
                    durationMs: 5000,
                });
            }

            this.eventBus?.emit?.('etl:pipeline:complete', { pipelineId, result });

            // Notify the Data page to refresh when a sink wrote data
            if (result?.datasets_changed) {
                this.eventBus?.emit?.('data:datasets:updated', { source: 'etl' });
            }

            this.#refresh();
        } catch (err) {
            this.logger?.error?.('etl', 'Pipeline execution failed', { err });

            const run = {
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                status: 'error',
                duration: Date.now() - startTime,
                error: err.message,
            };

            const existingRuns = Array.isArray(pipeline.runs) ? pipeline.runs : [];
            this.#persistRunHistory(pipeline, [...existingRuns, run]);

            this.eventBus?.emit?.('etl:run:error', { runId });
            this.eventBus?.emit?.('toast:show', {
                title: 'Pipeline failed', message: err.message, severity: 'error', durationMs: 5000,
            });

            this.eventBus?.emit?.('etl:pipeline:error', { pipelineId, error: err.message });
            this.#refresh();
        }
    }

    #rerunPipeline(pipelineName) {
        const pipeline = this.pipelines?.find(p => p.name === pipelineName);
        if (!pipeline) {
            this.eventBus?.emit?.('toast:show', {
                title: 'Pipeline not found',
                message: `Could not find pipeline "${pipelineName}"`,
                severity: 'warning',
                durationMs: 3000,
            });
            return;
        }
        this.#runPipeline(pipeline.id, { forceRefresh: true });
    }

    /**
     * Persist run history to the correct store: AppData for built-ins,
     * DataManager (workspace) for user pipelines.
     */
    #persistRunHistory(pipeline, runs) {
        const updated = { ...pipeline, runs };

        if (pipeline._builtin) {
            const idx = this._builtinPipelines.findIndex(p => p.id === pipeline.id);
            if (idx >= 0) this._builtinPipelines[idx] = updated;
            const api = window.pywebview?.api;
            api?.etl_save_builtin_pipeline?.(updated)?.catch?.(err => {
                this.logger?.warn?.('etl', '[ETLManagerPage] Failed to save built-in run history', err);
            });
        } else {
            this.dataManager.upsertEtlPipeline(updated);
            this.#persistToProjectFile(updated);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Persistence Helpers
    // ═══════════════════════════════════════════════════════════════════

    #persistSelection(id) {
        try { localStorage.setItem('ecosim.etl.selectedPipeline', id || ''); } catch (_) { /* ignore */ }
    }

    #loadPersistedSelection() {
        try { return localStorage.getItem('ecosim.etl.selectedPipeline') || null; } catch (_) { return null; }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Utilities
    // ═══════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════
    // Bottom Panel Preview (detail view run)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Show per-step preview data in the bottom panel after a detail-view run.
     * Enables the bottom panel FSM, populates step tabs and renders a DataTable.
     */
    #showRunPreviewInBottomPanel(result, pipeline) {
        if (!result?.results) return;

        const sectorTabs = document.getElementById('sector-tabs');
        const etlPanel = document.getElementById('etl-preview-bottom-panel');
        if (!sectorTabs || !etlPanel) return;

        // Build preview entries directly from result keys (backend node IDs).
        // Match each result node back to a step for display name / category.
        const stepMap = new Map(
            (pipeline.steps || []).map(s => [s.id, s]),
        );
        const previewEntries = [];
        for (const [nodeId, nodeResult] of Object.entries(result.results)) {
            if (!nodeResult?.preview?.headers || !nodeResult.preview.rows?.length) continue;
            const step = stepMap.get(nodeId);
            const nodeType = step?.type || nodeId;
            const category = nodeType.startsWith('source-') ? 'source'
                : nodeType.startsWith('sink-') ? 'sink'
                : nodeType.startsWith('transform-') ? 'transform' : 'utility';
            previewEntries.push({
                nodeId,
                displayName: step?.config?.displayName || nodeType,
                category,
            });
        }
        if (previewEntries.length === 0) return;

        // Swap bottom panel content: hide Godley, show ETL preview
        const godleyPanel = document.getElementById('godley-table-bottom-panel');
        if (godleyPanel) godleyPanel.style.display = 'none';
        etlPanel.style.display = '';

        // Ensure the bottom panel is expanded (not collapsed)
        const leftBottom = document.querySelector('.left-bottom');
        if (leftBottom?.classList.contains('collapsed')) {
            leftBottom.classList.remove('collapsed');
        }

        // Render step tabs
        sectorTabs.innerHTML = '';
        const lastEntry = previewEntries[previewEntries.length - 1];
        for (const entry of previewEntries) {
            const isActive = entry.nodeId === lastEntry.nodeId;
            const tab = document.createElement('div');
            tab.className = `tab bottom-tab${isActive ? ' active' : ''}`;
            tab.dataset.stepId = entry.nodeId;
            tab.innerHTML = `
                <span class="step-editor__tab-indicator step-editor__tab-indicator--${entry.category}"></span>
                <span class="tab-title">${this.#escapeHTML(entry.displayName)}</span>
            `;
            tab.addEventListener('click', () => {
                for (const t of sectorTabs.querySelectorAll('.tab.bottom-tab')) {
                    t.classList.toggle('active', t.dataset.stepId === entry.nodeId);
                }
                this.#renderRunPreviewForStep(result, entry.nodeId, etlPanel);
            });
            sectorTabs.appendChild(tab);
        }

        // Render the last entry's preview by default (output data)
        this.#renderRunPreviewForStep(result, lastEntry.nodeId, etlPanel);
    }

    /**
     * Render a single step's preview DataTable into the bottom panel.
     */
    #renderRunPreviewForStep(result, stepId, container) {
        this._runPreviewTable?.dispose?.();
        this._runPreviewTable = null;
        container.innerHTML = '';

        const nr = result.results?.[stepId];
        if (!nr?.preview?.headers || !nr.preview.rows?.length) {
            container.innerHTML = `
                <div class="etl-preview__empty">
                    <span class="material-symbols-outlined">table_chart</span>
                    <p>No preview data for this step</p>
                </div>
            `;
            return;
        }

        const tableContainer = document.createElement('div');
        tableContainer.className = 'etl-preview__table';
        container.appendChild(tableContainer);

        this._runPreviewTable = new DataTable(tableContainer, {
            headers: nr.preview.headers,
            rows: nr.preview.rows,
            readonly: true,
            pagination: true,
            pageSize: 50,
            services: { eventBus: this.eventBus },
        });
        this._runPreviewTable.render();
    }

    /**
     * Load cached preview data from the backend disk cache and show in bottom panel.
     * Called when selecting a pipeline that has no in-memory result.
     */
    async #loadCachedPreviews(pipeline) {
        const api = window.pywebview?.api;
        if (!api?.etl_get_cached_previews || !pipeline.steps?.length) {
            this.#clearRunPreview();
            return;
        }

        try {
            const resolved = resolveParameters(pipeline.steps, pipeline.parameters);
            const graph = stepsToGraph(resolved);
            const result = await api.etl_get_cached_previews(graph);

            // Guard: user may have selected a different pipeline while we awaited
            if (this.selectedPipelineId !== pipeline.id) return;

            if (result?.ok && result.results && Object.keys(result.results).length > 0) {
                this._lastResults.set(pipeline.id, result);
                this.#showRunPreviewInBottomPanel(result, pipeline);

                // Update the inline sections in the detail view
                this.#refreshRunHistorySection(pipeline);
                this.#refreshDataPreviewSection(pipeline);
            } else {
                this.#clearRunPreview();
            }
        } catch {
            this.#clearRunPreview();
        }
    }

    /**
     * Clear any active run preview from the bottom panel.
     */
    #clearRunPreview() {
        this._runPreviewTable?.dispose?.();
        this._runPreviewTable = null;

        const sectorTabs = document.getElementById('sector-tabs');
        const etlPanel = document.getElementById('etl-preview-bottom-panel');
        if (sectorTabs) sectorTabs.innerHTML = '';
        if (etlPanel) {
            etlPanel.innerHTML = `
                <div class="etl-preview__empty">
                    <span class="material-symbols-outlined">table_chart</span>
                    <p>Run the pipeline to preview data</p>
                </div>
            `;
        }
    }

    // ── Orchestration bottom panel: overview + drill-down ──────────

    /**
     * Show orchestration overview in the bottom panel: one tab per pipeline item,
     * each showing the pipeline's final output data (sink step preview).
     */
    #showOrchestrationOverviewInBottomPanel(orchestration) {
        const items = (orchestration.items || []).filter(i => i.enabled !== false);
        if (items.length === 0) {
            this.#clearRunPreview();
            return;
        }

        const sectorTabs = document.getElementById('sector-tabs');
        const etlPanel = document.getElementById('etl-preview-bottom-panel');
        if (!sectorTabs || !etlPanel) return;

        // Swap bottom panel to ETL mode
        const godleyPanel = document.getElementById('godley-table-bottom-panel');
        if (godleyPanel) godleyPanel.style.display = 'none';
        etlPanel.style.display = '';

        const leftBottom = document.querySelector('.left-bottom');
        if (leftBottom?.classList.contains('collapsed')) {
            leftBottom.classList.remove('collapsed');
        }

        // Build tab entries from orchestration items
        const tabEntries = [];
        for (const item of items) {
            const result = this._lastResults.get(item.pipelineId);
            const pipeline = this.pipelines.find(p => p.id === item.pipelineId);
            const displayName = item.pipelineName || pipeline?.name || 'Unknown';

            // Find the last step's nodeId that has preview data
            let lastStepId = null;
            if (result?.results) {
                const steps = pipeline?.steps || [];
                for (let i = steps.length - 1; i >= 0; i--) {
                    const nr = result.results[steps[i].id];
                    if (nr?.preview?.headers && nr.preview.rows?.length) {
                        lastStepId = steps[i].id;
                        break;
                    }
                }
                // Fallback: walk result keys backwards
                if (!lastStepId) {
                    const keys = Object.keys(result.results);
                    for (let i = keys.length - 1; i >= 0; i--) {
                        const nr = result.results[keys[i]];
                        if (nr?.preview?.headers && nr.preview.rows?.length) {
                            lastStepId = keys[i];
                            break;
                        }
                    }
                }
            }

            tabEntries.push({
                pipelineId: item.pipelineId,
                displayName,
                lastStepId,
                result,
                hasData: !!lastStepId,
            });
        }

        if (tabEntries.length === 0) {
            this.#clearRunPreview();
            return;
        }

        // Render tabs
        sectorTabs.innerHTML = '';
        const firstWithData = tabEntries.find(e => e.hasData);
        const activeEntry = firstWithData || tabEntries[0];

        for (const entry of tabEntries) {
            const isActive = entry === activeEntry;
            const tab = document.createElement('div');
            tab.className = `tab bottom-tab${isActive ? ' active' : ''}`;
            tab.dataset.pipelineId = entry.pipelineId;
            tab.innerHTML = `
                <span class="step-editor__tab-indicator step-editor__tab-indicator--${entry.hasData ? 'sink' : 'utility'}"></span>
                <span class="tab-title">${this.#escapeHTML(entry.displayName)}</span>
            `;
            tab.addEventListener('click', () => {
                for (const t of sectorTabs.querySelectorAll('.tab.bottom-tab')) {
                    t.classList.toggle('active', t.dataset.pipelineId === entry.pipelineId);
                }
                if (entry.hasData) {
                    this.#renderRunPreviewForStep(entry.result, entry.lastStepId, etlPanel);
                } else {
                    this._runPreviewTable?.dispose?.();
                    this._runPreviewTable = null;
                    etlPanel.innerHTML = `
                        <div class="etl-preview__empty">
                            <span class="material-symbols-outlined">table_chart</span>
                            <p>No data yet \u2014 run the orchestration to preview</p>
                        </div>
                    `;
                }
            });
            sectorTabs.appendChild(tab);
        }

        // Render the active entry's preview
        if (activeEntry.hasData) {
            this.#renderRunPreviewForStep(activeEntry.result, activeEntry.lastStepId, etlPanel);
        } else {
            etlPanel.innerHTML = `
                <div class="etl-preview__empty">
                    <span class="material-symbols-outlined">table_chart</span>
                    <p>No data yet \u2014 run the orchestration to preview</p>
                </div>
            `;
        }
    }

    /**
     * Toggle pipeline selection in the orchestration run detail sub-table.
     * When selected, shows that pipeline's per-step tabs in the bottom panel.
     * When deselected, returns to the overview tabs.
     */
    #toggleOrchPipelineSelection(pipelineId, tbody) {
        if (this._selectedOrchPipelineId === pipelineId) {
            // Deselect: return to overview
            this._selectedOrchPipelineId = null;
            for (const row of tbody.querySelectorAll('.etl-run-detail__pipeline-row')) {
                row.classList.remove('etl-run-detail__pipeline-row--selected');
            }
            const orchestration = this.pipelines.find(p => p.id === this.selectedPipelineId);
            if (orchestration) {
                this.#showOrchestrationOverviewInBottomPanel(orchestration);
            }
        } else {
            // Select: show this pipeline's per-step tabs
            this._selectedOrchPipelineId = pipelineId;
            for (const row of tbody.querySelectorAll('.etl-run-detail__pipeline-row')) {
                row.classList.toggle(
                    'etl-run-detail__pipeline-row--selected',
                    row.dataset.pipelineId === pipelineId,
                );
            }
            const result = this._lastResults.get(pipelineId);
            const pipeline = this.pipelines.find(p => p.id === pipelineId);
            if (result && pipeline) {
                this.#showRunPreviewInBottomPanel(result, pipeline);
            }
        }
    }

    /**
     * Load cached preview data from the backend for each pipeline in an orchestration.
     */
    async #loadOrchestrationCachedPreviews(orchestration) {
        const api = window.pywebview?.api;
        if (!api?.etl_get_cached_previews) return;

        const items = (orchestration.items || []).filter(i => i.enabled !== false);
        let anyLoaded = false;

        for (const item of items) {
            if (this._lastResults.has(item.pipelineId)) continue;

            const pipeline = this.pipelines.find(p => p.id === item.pipelineId);
            if (!pipeline?.steps?.length) continue;

            try {
                const resolved = resolveParameters(pipeline.steps, pipeline.parameters);
                const graph = stepsToGraph(resolved);
                const result = await api.etl_get_cached_previews(graph);

                // Guard: user may have navigated away
                if (this.selectedPipelineId !== orchestration.id) return;

                if (result?.ok && result.results && Object.keys(result.results).length > 0) {
                    this._lastResults.set(item.pipelineId, result);
                    anyLoaded = true;
                }
            } catch {
                // Silently skip — this pipeline just won't have cached data
            }
        }

        // Re-render the overview tabs if any new data was loaded
        if (anyLoaded && this.selectedPipelineId === orchestration.id && !this._selectedOrchPipelineId) {
            this.#showOrchestrationOverviewInBottomPanel(orchestration);
        }
    }

    /**
     * Extract input/output preview data from per-node pipeline results.
     *
     * The backend returns `results[nodeId].preview = { headers, rows: [[...]] }`.
     * The detail view expects `{ columns, rows: [{col: val}], totalRows }`.
     */
    #extractPreviews(result, steps) {
        let inputPreview = null;
        let outputPreview = null;

        if (!result?.ok || !result.results) return { inputPreview, outputPreview };

        const nodeResults = result.results;

        // Input: first source step with preview data
        for (const step of steps) {
            if (!step.type?.startsWith('source-')) continue;
            const nr = nodeResults[step.id];
            if (nr?.preview?.headers) {
                inputPreview = this.#convertPreviewFormat(nr.preview, nr.rows);
                break;
            }
        }

        // Output: last step with preview data (prefer sinks, fall back to any)
        for (let i = steps.length - 1; i >= 0; i--) {
            const nr = nodeResults[steps[i].id];
            if (nr?.preview?.headers) {
                outputPreview = this.#convertPreviewFormat(nr.preview, nr.rows);
                break;
            }
        }

        return { inputPreview, outputPreview };
    }

    /**
     * Convert backend preview format `{ headers, rows: [[...]] }` to the
     * detail view format `{ columns, rows: [{col: val}], totalRows }`.
     */
    #convertPreviewFormat(preview, totalRows) {
        const columns = preview.headers;
        const rows = preview.rows.map(row => {
            const obj = {};
            for (let i = 0; i < columns.length; i++) {
                obj[columns[i]] = row[i];
            }
            return obj;
        });
        return { columns, rows, totalRows: totalRows ?? rows.length };
    }

    #escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
