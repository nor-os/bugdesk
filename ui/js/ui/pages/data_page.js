/**
 * Data Page (js_new)
 * Location: ui/pages/data_page.js
 *
 * Purpose
 * -------
 * Host the dataset explorer and import wizard experience separate from the node workspace.
 *
 * Responsibilities
 * - Render dataset trees filtered by namespace using DataManager APIs.
 * - Drive import workflows (file picker → preview → refinement) via backend events.
 * - Display dataset previews/series details with pagination + streaming updates.
 *
 * Source Material
 * - html/js/data_page.js (UI) + html/js/data_manager.js (API wiring) + data_cache.js (caching logic).
 */
import { PageBase } from '../base/page_base.js';
import { installOverlayScrollbar } from '../utils/overlay_scrollbar.js';
import { createTreeNode, createTreeItem, toggleNode } from '../components/tree_view.js';
import { ManagedWindow } from '../components/managed_window.js';
import { showDeleteConfirmDialog } from '../components/confirm_dialog.js';
import { DataTable } from '../components/data_table.js';
import { openDataSeriesPlotWindow } from '../components/data_series_plot_window.js';
import { updateDetailHeader } from '../components/detail_header.js';

const VIEW_EVENTS = Object.freeze({
    READY: 'view:data:ready',
    ACTIVATED: 'view:data:activated',
    DEACTIVATED: 'view:data:deactivated',
    DATASETS_REFRESHED: 'view:data:datasets-refreshed',
    SERIES_SELECTED: 'view:data:series-selected',
    IMPORT_OPENED: 'view:data:import-opened',
    IMPORT_CLOSED: 'view:data:import-closed',
    IMPORT_SAVED: 'view:data:import-saved',
});

const DEFAULT_PAGINATION = Object.freeze({
    limit: 500,
    offset: 0,
});

const WIZARD_STEPS = Object.freeze(['source', 'preview', 'refine', 'save']);

const TIME_MODE_OPTIONS = Object.freeze(['relative', 'integer', 'explicit']);

const REQUIRED_DATA_HUB_METHODS = Object.freeze([
    'listDatasets',
    'fetchSeriesById',
    'requestCsvPreview',
    'requestRefinePreview',
    'saveSeries',
]);

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? null));

import { getHeaderKind, getIconForKind, stripHeaderPrefix } from '../utils/header_utils.js';

const DEFAULT_WIZARD_STATE = Object.freeze({
    open: false,
    step: 'source',
    file: null,
    fileName: '',
    csvBase64: '',
    encoding: 'utf-8',
    separator: ',',
    hasHeader: true,
    headers: [],
    timeMode: 'explicit',
    timeFormat: 'auto',
    timeColumns: [],
    integerColumnIndex: null,
    selectedDataColumns: [],
    columnsTouched: false,
    preview: { headers: [], rows: [] },
    refine: {
        enableTrim: false,
        trimStart: 1,
        trimEnd: 0,  // 0 means "not set" - will be initialized to rowCount when enabled
        enableMissing: false,
        missingMethod: 'ffill',
        enableResample: false,
        resampleUnit: 'month',
        resampleStep: 1,
        resampleMethod: 'mean',
        resampleFillMethod: 'linear',
    },
    targetDatasetId: null,
    newDatasetName: '',
    seriesName: '',
    saving: false,
    refinePreview: null,
});

export class DataPage extends PageBase {
    constructor({
        eventBus,
        dataManager,
        notificationCenter,
        logger,
        dataHub = null,
        datasetPageSize = DEFAULT_PAGINATION.limit,
        sidebarContainer = null,
    } = {}) {
        super({ eventBus, dataManager, notificationCenter, logger });

        this.dataHub = null;
        this.datasetPageSize = Number.isFinite(datasetPageSize) && datasetPageSize > 0 ? datasetPageSize : DEFAULT_PAGINATION.limit;
        this.sidebarHost = sidebarContainer || null;

        this.datasets = [];
        this.datasetFilter = '';
        this.selectedDatasetId = null;
        this.selectedSeriesId = null;
        this.seriesPreview = null;
        this.seriesMeta = null;
        this.seriesPagination = { ...DEFAULT_PAGINATION, limit: this.datasetPageSize };
        this.datasetsById = new Map();
        this.activeNamespaceId = null;
        this._activeNamespaceFilter = null; // Namespace name for filtering data table columns
        this._activeTypeFilters = { stock: true, indicator: true }; // Type filters for data table columns

        this._seriesDataTable = null; // DataTable instance for series preview

        this.rootEl = null;
        this.sidebarEl = null;
        this.datasetListEl = null;
        this.datasetSearchInputEl = null;
        this.refreshButtonEl = null;
        this.seriesHeaderEl = null;
        this.seriesSummaryEl = null;
        this.seriesEmptyEl = null;
        this.wizardOverlayEl = null;
        this.wizardContainerEl = null;
        this.importWizardWindow = null;  // ManagedWindow instance for import wizard
        this._refinePreviewDebounceTimer = null;  // Debounce timer for refine preview updates
        this._refinePreviewRequestId = 0;  // Counter to track and ignore stale responses
        this._refinePreviewLoading = false;  // Loading state for preview updates

        this.wizardState = this.#createWizardState();

        this._refreshing = false; // re-entrancy guard for refreshDatasets
        this._busSubscriptions = [];
        this._uiDisposers = [];

        // Context menu state
        this._contextMenuEl = null;
        this._contextMenuTarget = null; // { type: 'dataset'|'series', dataset, series? }
        this._boundHideContextMenu = (e) => this.#hideContextMenu(e);

        if (dataHub) {
            this.setDataHub(dataHub);
        }
    }

    setDataHub(dataHub) {
        if (dataHub === null) {
            this.dataHub = null;
            return;
        }
        if (typeof dataHub !== 'object') {
            throw new Error('DataPage.setDataHub requires a service instance');
        }
        REQUIRED_DATA_HUB_METHODS.forEach((method) => {
            if (typeof dataHub[method] !== 'function') {
                throw new Error(`Data hub instance missing method ${method}()`);
            }
        });
        this.dataHub = dataHub;
        this.logger?.info?.('data-page', 'Data hub attached to DataPage');
    }

    mount(container) {
        if (!container || typeof container.appendChild !== 'function') {
            throw new TypeError('DataPage.mount requires a DOM container');
        }

        if (this._mounted) {
            this.dispose();
        }

        this.#buildShell(container);
        this.#installScrollbars();
        this.#bindUiHandlers();
        this.#wireBusSubscriptions();
        this.refreshDatasets();

        this._mounted = true;
        this.#emitViewEvent(VIEW_EVENTS.READY, {});
    }

    show() {
        this.#ensureSidebarAttached();
        if (this.rootEl) this.rootEl.style.display = '';
        if (this.sidebarHost) this.sidebarHost.style.display = '';
        // Re-render highlights if already mounted
        if (this._mounted) {
            this.#renderDatasetList();
            // Auto-select the latest scenario run if nothing is selected
            if (!this.selectedSeriesId) {
                this.#autoSelectLatestScenarioRun();
            }
            // Always render series preview to reflect current state
            // (shows onboarding if no datasets, select prompt if no series, or data if series loaded)
            this.#renderSeriesPreview();
        }
        this.#emitBreadcrumb();
    }

    /**
     * Emit breadcrumb segments to the top bar via EventBus.
     */
    #emitBreadcrumb() {
        const segments = [{ icon: 'database', label: 'Data', onClick: null }];

        if (this.selectedDatasetId) {
            const ds = this.datasetsById.get(this.selectedDatasetId);
            if (ds) {
                if (this.selectedSeriesId) {
                    segments.push({
                        icon: 'dataset',
                        label: ds.name,
                        onClick: null,
                    });
                    const seriesName = this.seriesMeta?.seriesName
                        || this.#getSeriesName(this.selectedSeriesId);
                    segments.push({
                        icon: 'show_chart',
                        label: seriesName || this.selectedSeriesId,
                        onClick: null,
                    });
                } else {
                    segments.push({
                        icon: 'dataset',
                        label: ds.name,
                        onClick: null,
                    });
                }
            }
        }

        const actions = [
            {
                icon: 'add',
                label: 'Import data',
                tooltip: 'Import CSV or Excel file',
                onClick: () => this.#openImportWizard(),
            },
        ];

        this.eventBus?.emit('topbar:breadcrumb:update', { segments, actions });
    }

    /**
     * Auto-select the first series from the latest scenario run dataset.
     * Scenario datasets are marked with isScenario: true.
     */
    #autoSelectLatestScenarioRun() {
        // Find the first scenario dataset (datasets are sorted by runAt descending)
        const scenarioDataset = this.datasets.find(d => d.isScenario || d.readOnly);
        if (!scenarioDataset) {
            this.logger?.debug?.('data-page', 'No scenario datasets found for auto-select');
            return;
        }
        
        // Find the first series in that dataset
        const series = scenarioDataset.series;
        if (!series || !series.length) {
            this.logger?.debug?.('data-page', 'No series in scenario dataset for auto-select');
            return;
        }
        
        const firstSeries = series[0];
        this.logger?.debug?.('data-page', 'Auto-selecting latest scenario series:', firstSeries.id);
        
        // Select the dataset and series (silent mode to avoid error flooding if series doesn't exist)
        this.selectedDatasetId = scenarioDataset.id;
        this.#loadSeriesPreview(firstSeries.id, { dataset: scenarioDataset, silent: true });
        
        // Update UI highlighting
        this.#updateSeriesHighlighting(null, firstSeries.id);
    }

    #installScrollbars() {
        try {
            if (this.seriesPaginationEl) {
                installOverlayScrollbar(this.seriesPaginationEl, {
                    orientation: 'horizontal',
                    className: 'pagination-scrollbar',
                    watchSubtree: false,
                });
            }
            // Note: Scrollbars for the data table are installed in #renderSeriesPreview()
            // after DataTable creates its .preview-table-wrap element
        } catch (err) {
            this.logger?.warn?.('data-page', 'Failed to install custom scrollbars', { err });
        }
    }

    hide() {
        if (this.rootEl) this.rootEl.style.display = 'none';
        if (this.sidebarHost) this.sidebarHost.style.display = 'none';
    }

    #ensureSidebarAttached(fallbackContainer = null) {
        if (!this.sidebarEl) {
            return;
        }

        if (this.sidebarHost) {
            if (!this.sidebarHost.contains(this.sidebarEl)) {
                try {
                    this.sidebarHost.innerHTML = '';
                    this.sidebarHost.appendChild(this.sidebarEl);
                    // Refresh collapsible manager so it picks up the new collapsible box
                    this.#refreshCollapsibleManager();
                } catch (error) {
                    this.logger?.warn?.('data-page', 'Failed to attach sidebar to host', { error });
                    if (fallbackContainer && !fallbackContainer.contains(this.sidebarEl)) {
                        fallbackContainer.appendChild(this.sidebarEl);
                    }
                }
            }
        } else if (fallbackContainer && !fallbackContainer.contains(this.sidebarEl)) {
            fallbackContainer.appendChild(this.sidebarEl);
        }
    }

    #refreshCollapsibleManager() {
        // Refresh the UIManager's left collapsible manager to pick up our new collapsible box
        try {
            const uiManager = window.uiManager || window.UIManager;
            if (uiManager?.collapsibleLeft?.refresh) {
                uiManager.collapsibleLeft.refresh();
            }
        } catch (err) {
            this.logger?.debug?.('data-page', 'Collapsible refresh skipped', { error: err });
        }
    }

    hydrate() {
        if (!this._mounted) {
            return;
        }
        this.#ensureSidebarAttached();
        this.#renderDatasetList();
        if (this.selectedSeriesId) {
            this.#renderSeriesPreview();
        }
    }

    onActivated(context = {}) {
        this.#emitViewEvent(VIEW_EVENTS.ACTIVATED, { context });
    }

    onDeactivated(context = {}) {
        this.#emitViewEvent(VIEW_EVENTS.DEACTIVATED, { context });
    }

    setActiveNamespace(namespaceId) {
        this.activeNamespaceId = namespaceId || null;
    }

    dispose() {
        this.#teardownBusSubscriptions();
        this.#teardownUiHandlers();

        // Dispose DataTable
        if (this._seriesDataTable) {
            this._seriesDataTable.dispose();
            this._seriesDataTable = null;
        }

        // Dispose context menu
        if (this._contextMenuEl) {
            this._contextMenuEl.remove();
            this._contextMenuEl = null;
        }
        document.removeEventListener('mousedown', this._boundHideContextMenu, true);
        document.removeEventListener('keydown', this._boundHideContextMenu, true);

        if (this.rootEl?.parentNode) {
            this.rootEl.parentNode.removeChild(this.rootEl);
        }

        this.rootEl = null;
        this.sidebarEl = null;
        this.datasetListEl = null;
        this.datasetSearchInputEl = null;
        this.refreshButtonEl = null;
        this.sidebarImportBtn = null;
        this.seriesHeaderEl = null;
        this.seriesSummaryEl = null;
        this.seriesEmptyEl = null;
        this.wizardOverlayEl = null;
        this.wizardContainerEl = null;

        this._mounted = false;
        super.dispose();
    }

    async refreshDatasets({ silent = false, force = !silent } = {}) {
        if (this._refreshing) return;
        if (!this.#ensureDataHubReady({ silent })) {
            return;
        }
        this._refreshing = true;
        this.#setBusy(true);
        try {
            const response = await this.dataHub.listDatasets({ force });
            if (!response?.ok) {
                throw new Error(response?.error || 'Failed to list datasets');
            }
            this.datasets = this.#normalizeDatasets(Array.isArray(response.datasets) ? response.datasets : []);
            this.datasetsById = new Map(this.datasets.map((d) => [d.id, d]));

            // Clear stale selection if the selected dataset no longer exists
            if (this.selectedDatasetId && !this.datasetsById.has(this.selectedDatasetId)) {
                this.selectedDatasetId = null;
                this.selectedSeriesId = null;
                this.seriesPreview = null;
                this.seriesMeta = null;
            }

            if (this.datasets.length && !this.selectedDatasetId) {
                this.selectedDatasetId = this.datasets[0].id;
            }
            this.#renderDatasetList();
            this.#renderSeriesPreview();
            this.#emitViewEvent(VIEW_EVENTS.DATASETS_REFRESHED, {
                count: this.datasets.length,
            });
            if (this.selectedDatasetId && this.selectedSeriesId) {
                this.#loadSeriesPreview(this.selectedSeriesId, { refresh: true });
            }
        } catch (error) {
            this.#reportError('Dataset refresh failed', error);
        } finally {
            this._refreshing = false;
            this.#setBusy(false);
        }
    }

    async #loadSeriesPreview(seriesId, { refresh = false, dataset = null, silent = false } = {}) {
        if (!seriesId || !this.#ensureDataHubReady()) {
            return;
        }
        if (!refresh && this.seriesPreview && this.selectedSeriesId === seriesId) {
            return;
        }
        const previousSeriesId = this.selectedSeriesId;
        this.selectedSeriesId = seriesId;
        
        // Update list highlighting immediately (before async fetch)
        if (previousSeriesId !== seriesId) {
            this.#updateSeriesHighlighting(previousSeriesId, seriesId);
        }
        
        const datasetMeta = dataset || this.datasetsById.get(this.selectedDatasetId) || null;
        // Find series info from dataset (contains source, scenarioId, etc.)
        const seriesInfo = datasetMeta?.series?.find((s) => s.id === seriesId) || null;
        this.#toggleSeriesBusy(true);
        try {
            const response = await this.dataHub.fetchSeriesById(seriesId, { limit: null, offset: 0 });
            if (!response?.ok) {
                // Handle "not_found" gracefully - series may have been deleted
                if (response?.error === 'not_found') {
                    console.warn('[DataPage] Series not found:', seriesId, 'datasetId:', this.selectedDatasetId);
                    this.selectedSeriesId = null;
                    this.seriesPreview = null;
                    this.seriesMeta = null;
                    this.#renderSeriesPreview(); // Will show empty state
                    return;
                }
                throw new Error(response?.error || 'Failed to load series');
            }
            this.seriesPreview = {
                headers: Array.isArray(response.headers) ? response.headers : [],
                rows: Array.isArray(response.rows) ? response.rows : [],
            };
            this.seriesMeta = {
                datasetId: datasetMeta?.id || this.selectedDatasetId,
                datasetName: response.datasetName || datasetMeta?.name || this.#getDatasetNameBySeries(seriesId),
                seriesId,
                seriesName: response.seriesName || seriesInfo?.name || this.#getSeriesName(seriesId),
                totalCount: response.totalCount ?? response.count ?? this.seriesPreview.rows.length,
                startTime: response.startTime || null,
                endTime: response.endTime || null,
                summary: response.summary || null,
                scenarioId: response.scenarioId || seriesInfo?.scenarioId || datasetMeta?.meta?.scenarioId || null,
                runId: response.runId || seriesInfo?.runId || datasetMeta?.meta?.runId || null,
                kind: response.kind || datasetMeta?.meta?.kind || null,
                createdAt: response.createdAt || seriesInfo?.createdAt || datasetMeta?.meta?.createdAt || null,
                source: response.source || seriesInfo?.source || null,
                readonly: Boolean(datasetMeta?.readOnly),
            };
            this.#renderSeriesPreview();
            this.#emitBreadcrumb();
            this.#emitViewEvent(VIEW_EVENTS.SERIES_SELECTED, {
                datasetId: this.selectedDatasetId,
                seriesId: this.selectedSeriesId,
            });
        } catch (error) {
            // Only report error if not in silent mode (e.g., auto-select operations)
            if (!silent) {
                this.#reportError('Series preview failed', error);
            } else {
                this.logger?.debug?.('data-page', 'Series preview failed (silent)', { seriesId, error });
            }
            // Clear preview so the placeholder shows rather than stuck busy state
            this.seriesPreview = null;
            this.seriesMeta = null;
            this.#renderSeriesPreview();
        } finally {
            this.#toggleSeriesBusy(false);
        }
    }

    #buildShell(container) {
        container.innerHTML = '';
        this.rootEl = document.createElement('section');
        this.rootEl.className = 'data-page';

        // No header - controls moved to sidebar

        const body = document.createElement('div');
        body.className = 'data-page__body';

        // Build sidebar wrapper for fixed-200 panel
        this.sidebarEl = document.createElement('div');
        this.sidebarEl.className = 'data-browser-panel';

        // Fixed header at the top
        const fixedHeader = document.createElement('header');
        fixedHeader.className = 'fixed-panel-header';
        fixedHeader.innerHTML = `
            <span class="material-symbols-outlined">database</span>
            <span>Data</span>
        `;
        this.sidebarEl.appendChild(fixedHeader);

        // Top controls row (filter + icons) - uses CSS class for styling
        const sidebarControls = document.createElement('div');
        sidebarControls.className = 'sidebar-controls';

        this.datasetSearchInputEl = document.createElement('input');
        this.datasetSearchInputEl.type = 'search';
        this.datasetSearchInputEl.placeholder = 'Filter…';
        this.datasetSearchInputEl.className = 'data-page__search';

        const searchIcon = document.createElement('span');
        searchIcon.className = 'material-symbols-outlined sidebar-search-icon';
        searchIcon.textContent = 'search';

        sidebarControls.appendChild(searchIcon);
        sidebarControls.appendChild(this.datasetSearchInputEl);
        this.sidebarEl.appendChild(sidebarControls);

        // --- Sidebar body (accordion layout) ---
        const sidebarBody = document.createElement('div');
        sidebarBody.className = 'sidebar-body sidebar-body--accordion';
        this.sidebarEl.appendChild(sidebarBody);

        // --- Managed Datasets collapsible box ---
        const managedBox = document.createElement('div');
        managedBox.className = 'tree-category dynamic-sheet-section';
        managedBox.dataset.collapsibleId = 'managed-datasets';
        managedBox.dataset.collapsibleDefault = 'expanded';

        const managedHeader = document.createElement('div');
        managedHeader.className = 'collapsible-header';
        managedHeader.id = 'collapsible-header-managed-datasets';
        managedHeader.dataset.collapsibleHeader = 'true';

        const managedArrowToggle = document.createElement('button');
        managedArrowToggle.className = 'arrow-toggle';
        managedArrowToggle.type = 'button';

        const managedArrowIcon = document.createElement('span');
        managedArrowIcon.className = 'collapsible-arrow material-symbols-outlined';
        managedArrowIcon.id = 'collapsible-arrow-managed-datasets';
        managedArrowIcon.textContent = 'expand_more';
        managedArrowToggle.appendChild(managedArrowIcon);

        const managedLabel = document.createElement('span');
        managedLabel.textContent = 'Managed Datasets';

        // Refresh button (visible on hover over header)
        this.refreshButtonEl = document.createElement('button');
        this.refreshButtonEl.type = 'button';
        this.refreshButtonEl.className = 'collapsible-header__action has-tooltip';
        this.refreshButtonEl.setAttribute('data-tooltip', 'Refresh datasets');
        this.refreshButtonEl.innerHTML = '<span class="material-symbols-outlined">refresh</span>';

        managedHeader.appendChild(managedArrowToggle);
        managedHeader.appendChild(managedLabel);
        managedHeader.appendChild(this.refreshButtonEl);
        managedBox.appendChild(managedHeader);

        const managedContent = document.createElement('div');
        managedContent.className = 'collapsible-content visible';
        managedContent.id = 'collapsible-content-managed-datasets';
        managedContent.dataset.collapsibleContent = 'true';

        this.managedDatasetListEl = document.createElement('ul');
        this.managedDatasetListEl.className = 'tree-view';
        this.managedDatasetListEl.dataset.role = 'managed-dataset-list';
        managedContent.appendChild(this.managedDatasetListEl);

        managedBox.appendChild(managedContent);
        sidebarBody.appendChild(managedBox);

        // --- Scenario Runs collapsible box ---
        const scenarioBox = document.createElement('div');
        scenarioBox.className = 'tree-category dynamic-sheet-section';
        scenarioBox.dataset.collapsibleId = 'scenario-runs';
        scenarioBox.dataset.collapsibleDefault = 'expanded';

        const scenarioHeader = document.createElement('div');
        scenarioHeader.className = 'collapsible-header';
        scenarioHeader.id = 'collapsible-header-scenario-runs';
        scenarioHeader.dataset.collapsibleHeader = 'true';

        const scenarioArrowToggle = document.createElement('button');
        scenarioArrowToggle.className = 'arrow-toggle';
        scenarioArrowToggle.type = 'button';

        const scenarioArrowIcon = document.createElement('span');
        scenarioArrowIcon.className = 'collapsible-arrow material-symbols-outlined';
        scenarioArrowIcon.id = 'collapsible-arrow-scenario-runs';
        scenarioArrowIcon.textContent = 'expand_more';
        scenarioArrowToggle.appendChild(scenarioArrowIcon);

        const scenarioLabel = document.createElement('span');
        scenarioLabel.textContent = 'Scenario Runs';

        scenarioHeader.appendChild(scenarioArrowToggle);
        scenarioHeader.appendChild(scenarioLabel);
        scenarioBox.appendChild(scenarioHeader);

        const scenarioContent = document.createElement('div');
        scenarioContent.className = 'collapsible-content visible';
        scenarioContent.id = 'collapsible-content-scenario-runs';
        scenarioContent.dataset.collapsibleContent = 'true';

        this.scenarioDatasetListEl = document.createElement('ul');
        this.scenarioDatasetListEl.className = 'tree-view';
        this.scenarioDatasetListEl.dataset.role = 'scenario-dataset-list';
        scenarioContent.appendChild(this.scenarioDatasetListEl);

        scenarioBox.appendChild(scenarioContent);
        sidebarBody.appendChild(scenarioBox);

        // Overlay scrollbar on sidebar body
        installOverlayScrollbar(sidebarBody, { orientation: 'vertical', watchSubtree: true });

        // Legacy alias for compatibility
        this.datasetListEl = this.managedDatasetListEl;

        // Content area - use original class names for styling
        const content = document.createElement('section');
        content.className = 'data-series-view';
        content.id = 'data-series-view';

        this.seriesHeaderEl = document.createElement('header');
        this.seriesHeaderEl.className = 'detail-header';

        this.seriesSummaryEl = document.createElement('div');
        this.seriesSummaryEl.className = 'series-meta';

        // Container for DataTable - pagination is built into DataTable
        const tableContainer = document.createElement('div');
        tableContainer.className = 'series-table-container';

        this.seriesEmptyEl = document.createElement('div');
        this.seriesEmptyEl.className = 'placeholder-message';
        tableContainer.appendChild(this.seriesEmptyEl);
        this.#updateEmptyState();

        content.appendChild(this.seriesHeaderEl);
        content.appendChild(this.seriesSummaryEl);
        content.appendChild(tableContainer);

        // Store table container reference (replaces tableWrapperEl)
        this.tableWrapperEl = tableContainer;

        // Sidebar can be rendered into an external host (fixed-200)
        this.#ensureSidebarAttached(body);
        body.appendChild(content);

        // Wizard container element (content for ManagedWindow)
        this.wizardContainerEl = document.createElement('div');
        this.wizardContainerEl.className = 'data-page__wizard-content';

        this.rootEl.appendChild(body);
        container.appendChild(this.rootEl);
    }

    #bindUiHandlers() {
        if (!this.rootEl) {
            return;
        }
        const bind = (element, eventName, handler) => {
            if (!element || typeof element.addEventListener !== 'function') {
                return;
            }
            element.addEventListener(eventName, handler);
            this._uiDisposers.push(() => element.removeEventListener(eventName, handler));
        };

        bind(this.datasetSearchInputEl, 'input', (event) => {
            this.datasetFilter = event.target.value?.trim().toLowerCase() || '';
            this.#renderDatasetList();
        });

        bind(this.refreshButtonEl, 'click', (e) => {
            e.stopPropagation(); // Don't toggle the collapsible
            this.refreshDatasets();
        });

        // Bind collapsible header toggle (for manual control if CollapsibleManager isn't available)
        this.#bindCollapsibleToggle();
    }

    // Track bound collapsible headers to avoid duplicate bindings
    static #boundCollapsibleHeaders = new WeakSet();

    // Track bound dataset lists to avoid duplicate tree node handlers
    static #boundDatasetLists = new WeakSet();

    #bindCollapsibleToggle() {
        if (!this.sidebarEl) return;

        // Bind all collapsible boxes in the sidebar
        const collapsibleBoxes = this.sidebarEl.querySelectorAll('.tree-category[data-collapsible-id]');
        collapsibleBoxes.forEach(box => {
            const header = box.querySelector('.collapsible-header');
            const content = box.querySelector('.collapsible-content');
            const arrow = box.querySelector('.collapsible-arrow');

            if (!header || !content) return;

            // Only bind if not already bound
            if (DataPage.#boundCollapsibleHeaders.has(header)) return;
            DataPage.#boundCollapsibleHeaders.add(header);

            const toggle = () => {
                const isExpanded = content.classList.contains('visible');
                content.classList.toggle('visible', !isExpanded);
                if (arrow) {
                    arrow.classList.toggle('collapsed', isExpanded);
                }
            };

            const clickHandler = (e) => {
                // Don't toggle if clicking inside content
                if (e.target.closest('[data-collapsible-content]')) return;
                toggle();
            };

            header.addEventListener('click', clickHandler);

            this._uiDisposers.push(() => {
                header.removeEventListener('click', clickHandler);
                DataPage.#boundCollapsibleHeaders.delete(header);
            });
        });
    }

    #updateSeriesHighlighting(previousSeriesId, newSeriesId) {
        // Efficiently update highlighting without full re-render
        const lists = [this.managedDatasetListEl, this.scenarioDatasetListEl].filter(Boolean);
        if (lists.length === 0) return;

        // Remove active from previous
        if (previousSeriesId) {
            lists.forEach(list => {
                const prevItem = list.querySelector(`[data-series-id="${previousSeriesId}"]`);
                if (prevItem) {
                    prevItem.classList.remove('active');
                }
            });
        }

        // Add active to new
        if (newSeriesId) {
            lists.forEach(list => {
                const newItem = list.querySelector(`[data-series-id="${newSeriesId}"]`);
                if (newItem) {
                    newItem.classList.add('active');
                }
            });
        }
    }

    #wireBusSubscriptions() {
        if (!this.eventBus) {
            return;
        }
        const subscribe = (eventName, handler) => {
            const disposer = this.eventBus.on(eventName, handler);
            this._busSubscriptions.push(disposer);
        };

        subscribe('data:hydrated', () => this.refreshDatasets({ silent: true }));
        subscribe('data:datasets:updated', () => this.refreshDatasets({ silent: true, force: true }));
        subscribe('shell:mode-changed', ({ mode }) => {
            if (mode === 'database') {
                this.#ensureSidebarAttached();
                this.refreshDatasets({ silent: true, force: true });
            }
        });

        // Global search / cross-page navigation: scroll to and highlight dataset
        subscribe('search:dataset:selected', ({ datasetId, datasetName }) => {
            // Resolve by ID or fall back to name lookup
            const resolvedId = datasetId
                || (datasetName && this.datasets.find(d => d.name === datasetName)?.id);
            if (resolvedId && this.datasets.some(d => d.id === resolvedId)) {
                const datasetEl = this.managedDatasetListEl?.querySelector(`[data-dataset-id="${resolvedId}"]`)
                    || this.scenarioDatasetListEl?.querySelector(`[data-dataset-id="${resolvedId}"]`);
                if (datasetEl) {
                    datasetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    datasetEl.classList.add('search-highlight');
                    setTimeout(() => datasetEl.classList.remove('search-highlight'), 2000);
                }
            }
        });
    }

    #teardownBusSubscriptions() {
        this._busSubscriptions.forEach((ticket) => {
            try {
                ticket?.dispose?.();
            } catch (err) {
                this.logger?.warn?.('data-page', 'Failed to dispose bus subscription', { error: err });
            }
        });
        this._busSubscriptions = [];
    }

    #teardownUiHandlers() {
        this._uiDisposers.forEach((dispose) => {
            try {
                dispose?.();
            } catch (err) {
                this.logger?.warn?.('data-page', 'Failed to remove UI handler', { error: err });
            }
        });
        this._uiDisposers = [];
    }

    #renderDatasetList() {
        // Render into two separate list elements
        if (!this.managedDatasetListEl || !this.scenarioDatasetListEl) {
            return;
        }

        this.managedDatasetListEl.innerHTML = '';
        this.scenarioDatasetListEl.innerHTML = '';
        const filter = this.datasetFilter;

        // Separate datasets into managed vs scenario runs
        const managedDatasets = [];
        const scenarioDatasets = [];

        this.datasets.forEach((dataset) => {
            const seriesList = dataset.series || [];

            // Filter series by name
            const matchingSeries = filter
                ? seriesList.filter((s) => s.name?.toLowerCase().includes(filter))
                : seriesList;

            if (matchingSeries.length > 0) {
                const isScenarioDataset = dataset.id === 'scenarios-dataset' || dataset.isScenario;
                const entry = { dataset, matchingSeries, isScenario: isScenarioDataset };
                if (isScenarioDataset) {
                    scenarioDatasets.push(entry);
                } else {
                    managedDatasets.push(entry);
                }
            }
        });

        // Render managed datasets
        if (managedDatasets.length > 0) {
            const fragment = document.createDocumentFragment();
            managedDatasets.forEach(({ dataset, matchingSeries }) => {
                const datasetNode = this.#createDatasetTreeNode(dataset, matchingSeries, false);
                fragment.appendChild(datasetNode);
            });
            this.managedDatasetListEl.appendChild(fragment);
        } else {
            const empty = document.createElement('div');
            empty.className = 'tree-empty-message';
            empty.textContent = filter ? 'No matching series.' : 'No datasets yet.';
            this.managedDatasetListEl.appendChild(empty);
        }

        // Render scenario datasets - grouped by scenario with collapsible headers
        if (scenarioDatasets.length > 0) {
            const fragment = document.createDocumentFragment();
            scenarioDatasets.forEach(({ dataset, matchingSeries }) => {
                // Strip "Scenario Runs · " prefix since the parent section already says "Scenario Runs"
                const displayDataset = dataset.name?.startsWith('Scenario Runs \u00b7 ')
                    ? { ...dataset, name: dataset.name.replace('Scenario Runs \u00b7 ', '') }
                    : dataset;
                const datasetNode = this.#createDatasetTreeNode(displayDataset, matchingSeries, true);
                fragment.appendChild(datasetNode);
            });
            this.scenarioDatasetListEl.appendChild(fragment);
        } else {
            const empty = document.createElement('div');
            empty.className = 'tree-empty-message';
            empty.textContent = 'No simulation runs yet.';
            this.scenarioDatasetListEl.appendChild(empty);
        }

        // Bind click handlers for tree nodes
        this.#bindTreeNodeHandlers();

        // Update the main-area empty state to reflect whether datasets exist
        this.#updateEmptyState();
    }

    #createDatasetTreeNode(dataset, seriesList, readonly = false) {
        const node = createTreeNode({
            id: dataset.id,
            label: dataset.name,
            icon: readonly ? 'history' : 'folder',
            count: seriesList.length,
            expanded: true, // Start expanded by default
            readonly,
            actions: readonly ? null : {
                rename: {
                    icon: 'edit',
                    title: 'Rename dataset',
                    onClick: (id) => {
                        const nodeEl = this.datasetListEl.querySelector(`.tree-node[data-node-id="${id}"]`);
                        if (nodeEl) this.#startDatasetInlineRename(nodeEl, dataset);
                    }
                },
                delete: {
                    icon: 'delete',
                    title: 'Delete dataset',
                    onClick: (id) => {
                        const nodeEl = this.datasetListEl.querySelector(`.tree-node[data-node-id="${id}"]`);
                        if (nodeEl) this.#confirmDeleteDataset(nodeEl, dataset);
                    }
                }
            }
        });

        // Store dataset reference
        node._dataset = dataset;
        node.dataset.datasetId = dataset.id;

        // Get children container and add series items
        const childrenEl = node.querySelector('.tree-node__children');
        if (childrenEl) {
            seriesList.forEach((series) => {
                const item = this.#createSeriesTreeItem(dataset, series);
                childrenEl.appendChild(item);
            });
        }

        return node;
    }

    #createSeriesTreeItem(dataset, series) {
        const isSelected = this.selectedSeriesId === series.id;
        const item = createTreeItem({
            id: series.id,
            label: series.name || series.id,
            icon: 'insights',
            isMaterialIcon: true,
            selected: isSelected,
            data: {
                seriesId: series.id,
                datasetId: dataset.id
            }
        });

        // Store references
        item._series = series;
        item._dataset = dataset;

        return item;
    }

    #bindTreeNodeHandlers() {
        // Bind handlers to both list elements
        const lists = [this.managedDatasetListEl, this.scenarioDatasetListEl].filter(Boolean);
        if (lists.length === 0) return;

        // Handle node header clicks (expand/collapse)
        const clickHandler = (e) => {
            // Handle tree node toggle
            const nodeHeader = e.target.closest('.tree-node__header');
            if (nodeHeader && !e.target.closest('.tree-node__action-btn')) {
                const node = nodeHeader.closest('.tree-node');
                if (node) {
                    toggleNode(node);
                    e.stopPropagation();
                    return;
                }
            }

            // Handle series item click
            const item = e.target.closest('.tree-item');
            if (item) {
                const seriesId = item.dataset.seriesId;
                const datasetId = item.dataset.datasetId;
                if (seriesId) {
                    this.selectedDatasetId = datasetId;
                    this.#loadSeriesPreview(seriesId, { dataset: item._dataset });

                    // Update selection highlighting in both lists
                    this.managedDatasetListEl?.querySelectorAll('.tree-item.selected').forEach(el => {
                        el.classList.remove('selected');
                    });
                    this.scenarioDatasetListEl?.querySelectorAll('.tree-item.selected').forEach(el => {
                        el.classList.remove('selected');
                    });
                    item.classList.add('selected');
                }
            }
        };

        // Handle double-click for rename on dataset label
        const dblClickHandler = (e) => {
            const label = e.target.closest('.tree-node__label');
            if (label) {
                const node = label.closest('.tree-node');
                if (node && !node.dataset.readonly) {
                    const dataset = node._dataset;
                    if (dataset && !dataset.isScenario) {
                        this.#startDatasetInlineRename(node, dataset);
                    }
                }
            }
        };

        // Handle right-click context menu on datasets and series
        const contextHandler = (e) => {
            // Check for dataset node header
            const nodeHeader = e.target.closest('.tree-node__header');
            if (nodeHeader) {
                const node = nodeHeader.closest('.tree-node');
                if (node?._dataset) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.#showContextMenu(e.clientX, e.clientY, {
                        type: 'dataset',
                        dataset: node._dataset,
                    });
                    return;
                }
            }
            // Check for series/run item
            const item = e.target.closest('.tree-item');
            if (item?._series && item?._dataset) {
                e.preventDefault();
                e.stopPropagation();
                this.#showContextMenu(e.clientX, e.clientY, {
                    type: 'series',
                    dataset: item._dataset,
                    series: item._series,
                });
            }
        };

        lists.forEach(listEl => {
            // Only bind if not already bound
            if (DataPage.#boundDatasetLists.has(listEl)) return;
            DataPage.#boundDatasetLists.add(listEl);

            listEl.addEventListener('click', clickHandler);
            listEl.addEventListener('dblclick', dblClickHandler);
            listEl.addEventListener('contextmenu', contextHandler);

            // Register cleanup
            this._uiDisposers.push(() => {
                listEl.removeEventListener('click', clickHandler);
                listEl.removeEventListener('dblclick', dblClickHandler);
                listEl.removeEventListener('contextmenu', contextHandler);
                DataPage.#boundDatasetLists.delete(listEl);
            });
        });
    }

    #createDatasetHeaderItem(dataset) {
        // Dataset header (non-clickable label)
        const item = document.createElement('li');
        item.className = 'series-item dataset-header-item';
        item.dataset.datasetId = dataset.id;

        const row = document.createElement('div');
        row.className = 'scenario-item-row';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined series-icon';
        icon.textContent = 'folder';

        const name = document.createElement('span');
        name.className = 'series-name dataset-name-label';
        name.title = dataset.name;
        name.textContent = dataset.name;

        // Actions container (visible on hover via CSS)
        const actions = document.createElement('span');
        actions.className = 'dataset-actions';

        // Only show actions for user datasets, not scenario datasets
        const isScenarioDataset = dataset.id === 'scenarios-dataset' || dataset.isScenario;
        if (!isScenarioDataset) {
            const renameBtn = document.createElement('button');
            renameBtn.className = 'dataset-action-btn';
            renameBtn.title = 'Rename dataset';
            renameBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#startDatasetInlineRename(item, dataset);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'dataset-action-btn dataset-delete-btn';
            deleteBtn.title = 'Delete dataset';
            deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#confirmDeleteDataset(item, dataset);
            });

            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);

            // Double-click to rename
            name.title = 'Double-click to rename';
            name.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.#startDatasetInlineRename(item, dataset);
            });
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(actions);
        item.appendChild(row);

        return item;
    }

    #startDatasetInlineRename(itemEl, dataset) {
        // Support both tree-view structure and legacy structure
        const nameEl = itemEl.querySelector('.tree-node__label') || itemEl.querySelector('.dataset-name-label');
        if (!nameEl) return;

        // Remember original class to restore on cancel/commit
        const originalClass = nameEl.className;
        const isTreeView = nameEl.classList.contains('tree-node__label');

        const current = dataset.name || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current;
        input.className = isTreeView ? 'tree-node__label tree-node__label--editing' : 'dataset-inline-input';
        input.style.cssText = 'flex:1; min-width:0; background:var(--config-input-bg,#3c3c3c); border:1px solid var(--config-primary,#0e639c); border-radius:3px; padding:2px 6px; color:inherit; font:inherit;';
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const cancel = () => {
            const span = document.createElement('span');
            span.className = originalClass;
            span.title = isTreeView ? '' : 'Double-click to rename';
            span.textContent = current;
            if (!isTreeView) {
                span.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this.#startDatasetInlineRename(itemEl, dataset);
                });
            }
            input.replaceWith(span);
        };

        let committed = false;
        const commit = async () => {
            if (committed) return; // Prevent double commit from Enter + blur
            committed = true;

            const trimmed = String(input.value || '').trim();
            if (!trimmed || trimmed === current) {
                cancel();
                return;
            }
            try {
                const actionsHost = this.dataHub?.hostBridge;
                if (!actionsHost?.rename_dataset) {
                    this.logger?.warn?.('data-page', 'rename_dataset not available on host bridge');
                    cancel();
                    return;
                }
                const res = await actionsHost.rename_dataset(dataset.id, trimmed);
                if (res?.ok) {
                    const span = document.createElement('span');
                    span.className = originalClass;
                    span.title = isTreeView ? '' : 'Double-click to rename';
                    span.textContent = trimmed;
                    if (!isTreeView) {
                        span.addEventListener('dblclick', (e) => {
                            e.stopPropagation();
                            dataset.name = trimmed; // Update local ref
                            this.#startDatasetInlineRename(itemEl, dataset);
                        });
                    }
                    input.replaceWith(span);
                    // Update local cache
                    dataset.name = trimmed;
                    const cached = this.datasetsById.get(dataset.id);
                    if (cached) cached.name = trimmed;
                    // Refresh to ensure consistency across UI
                    await this.refreshDatasets({ silent: true, force: true });
                } else {
                    this.logger?.warn?.('data-page', 'Dataset rename returned error', { error: res?.error });
                    cancel();
                }
            } catch (err) {
                this.logger?.warn?.('data-page', 'Dataset rename failed', { error: err });
                cancel();
            }
        };

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
    }

    async #confirmDeleteDataset(anchorEl, dataset) {
        const confirmed = await showDeleteConfirmDialog({
            itemName: dataset.name,
            itemType: 'dataset',
            additionalMessage: 'All series in this dataset will also be deleted.',
        });
        if (!confirmed) return;

        try {
            const actionsHost = this.dataHub?.hostBridge;
            if (!actionsHost?.delete_dataset) return;

            const res = await actionsHost.delete_dataset(dataset.id);
            if (res?.ok) {
                // Clear selection if deleted dataset was selected
                if (this.selectedDatasetId === dataset.id) {
                    this.selectedDatasetId = null;
                    this.selectedSeriesId = null;
                    this.seriesPreview = null;
                    this.seriesMeta = null;
                    this.#renderSeriesPreview(); // Show empty state
                }
                await this.refreshDatasets({ silent: true, force: true });
            }
        } catch (err) {
            this.logger?.warn?.('data-page', 'Dataset delete failed', { error: err });
        }
    }

    // ── Context menu ────────────────────────────────────────────────────

    #createContextMenu() {
        if (this._contextMenuEl) return;
        this._contextMenuEl = document.createElement('div');
        this._contextMenuEl.className = 'context-menu';
        this._contextMenuEl.setAttribute('role', 'menu');
        // Items are populated dynamically in #showContextMenu
        this._contextMenuEl.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu__item');
            if (!item || item.hasAttribute('disabled')) return;
            this.#handleContextMenuAction(item.dataset.action);
        });
        document.body.appendChild(this._contextMenuEl);
    }

    #showContextMenu(x, y, target) {
        this.#createContextMenu();
        if (!this._contextMenuEl) return;
        this._contextMenuTarget = target;

        // Build menu items based on target type
        const items = [];
        if (target.type === 'dataset') {
            const isScenario = target.dataset.isScenario || target.dataset.id === 'scenarios-dataset';
            if (!isScenario) {
                items.push({ action: 'rename', icon: 'edit', label: 'Rename' });
            }
            if (isScenario) {
                items.push({ action: 'save-as-dataset', icon: 'save', label: 'Save as Dataset' });
            }
            items.push({ action: 'delete', icon: 'delete', label: 'Delete', danger: true });
        } else if (target.type === 'series') {
            const isScenario = target.dataset?.isScenario || target.dataset?.id === 'scenarios-dataset';
            items.push({ action: 'download', icon: 'download', label: 'Download as CSV' });
            if (isScenario) {
                items.push({ action: 'save-as-dataset', icon: 'save', label: 'Save as Dataset' });
            }
            if (!isScenario) {
                items.push({ action: 'rename-series', icon: 'edit', label: 'Rename' });
            }
            items.push({ separator: true });
            items.push({ action: 'delete', icon: 'delete', label: 'Delete', danger: true });
        }

        this._contextMenuEl.innerHTML = items.map(item => {
            if (item.separator) {
                return '<div class="context-menu__separator"></div>';
            }
            const cls = `context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`;
            return `<div class="${cls}" data-action="${item.action}">
                <span class="material-symbols-outlined">${item.icon}</span>
                <span>${item.label}</span>
            </div>`;
        }).join('');

        this._contextMenuEl.style.display = 'block';

        // Viewport bounds
        const rect = this._contextMenuEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let fx = x, fy = y;
        if (x + rect.width > vw) fx = vw - rect.width - 8;
        if (y + rect.height > vh) fy = vh - rect.height - 8;
        if (fx < 0) fx = 8;
        if (fy < 0) fy = 8;
        this._contextMenuEl.style.left = `${fx}px`;
        this._contextMenuEl.style.top = `${fy}px`;

        document.addEventListener('mousedown', this._boundHideContextMenu, true);
        document.addEventListener('keydown', this._boundHideContextMenu, true);
    }

    #hideContextMenu(e) {
        if (!this._contextMenuEl) return;
        if (e?.type === 'keydown' && e.key !== 'Escape') return;
        if (e?.type === 'mousedown' && this._contextMenuEl.contains(e.target)) return;
        this._contextMenuEl.style.display = 'none';
        this._contextMenuTarget = null;
        document.removeEventListener('mousedown', this._boundHideContextMenu, true);
        document.removeEventListener('keydown', this._boundHideContextMenu, true);
    }

    #handleContextMenuAction(action) {
        const target = this._contextMenuTarget;
        this.#hideContextMenu();
        if (!target) return;

        switch (action) {
            case 'delete': {
                if (target.type === 'dataset') {
                    const nodeEl = this.datasetListEl?.querySelector(`.tree-node[data-node-id="${target.dataset.id}"]`);
                    this.#confirmDeleteDataset(nodeEl, target.dataset);
                } else if (target.type === 'series') {
                    // Select the series first, then delete
                    this.selectedSeriesId = target.series.id;
                    this.selectedDatasetId = target.dataset.id;
                    this.seriesMeta = {
                        ...this.seriesMeta,
                        source: target.series.source || (target.dataset.isScenario ? 'scenario-run' : 'dataset'),
                        scenarioId: target.series.scenarioId || (target.dataset.isScenario ? target.dataset.id : null),
                        runId: target.series.runId || (target.dataset.isScenario ? target.series.id : null),
                    };
                    this.#handleDeleteSeries();
                }
                break;
            }
            case 'rename': {
                if (target.type === 'dataset') {
                    const nodeEl = this.datasetListEl?.querySelector(`.tree-node[data-node-id="${target.dataset.id}"]`);
                    if (nodeEl) this.#startDatasetInlineRename(nodeEl, target.dataset);
                }
                break;
            }
            case 'rename-series': {
                // Select the series and trigger rename via header
                this.selectedDatasetId = target.dataset.id;
                this.#loadSeriesPreview(target.series.id, { dataset: target.dataset }).then(() => {
                    const nameEl = this.seriesHeaderEl?.querySelector('.detail-header__name');
                    if (nameEl) nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                });
                break;
            }
            case 'download': {
                this.selectedDatasetId = target.dataset.id;
                this.#loadSeriesPreview(target.series.id, { dataset: target.dataset }).then(() => {
                    this.#downloadSeriesAsCsv();
                });
                break;
            }
            case 'save-as-dataset': {
                if (target.type === 'series' && target.series) {
                    this.#saveRunAsDataset(target.series.id);
                } else if (target.type === 'dataset' && target.dataset.isScenario) {
                    // For scenario datasets, save the first series/run
                    const firstSeries = target.dataset.series?.[0];
                    if (firstSeries) {
                        this.#saveRunAsDataset(firstSeries.id);
                    }
                }
                break;
            }
        }
    }

    async #saveRunAsDataset(runId) {
        try {
            const actionsHost = this.dataHub?.hostBridge;
            if (!actionsHost?.save_run_as_dataset) {
                this.#notify('Data', 'Save as dataset not available', 'error');
                return;
            }
            const res = await actionsHost.save_run_as_dataset(runId);
            if (res?.ok) {
                this.#notify('Data', `Saved as "${res.name}"`, 'success');
                await this.refreshDatasets({ silent: true, force: true });
            } else {
                this.#notify('Data', res?.error || 'Failed to save as dataset', 'error');
            }
        } catch (err) {
            this.logger?.error?.('data-page', 'Save run as dataset failed', { error: err });
            this.#notify('Data', 'Failed to save as dataset', 'error');
        }
    }

    #createSeriesItem(dataset, series) {
        // Series item (matches scenario-item structure)
        const item = document.createElement('li');
        item.className = 'series-item';
        item.dataset.seriesId = series.id;
        item.dataset.datasetId = dataset.id;
        item.tabIndex = 0;

        if (series.id === this.selectedSeriesId) {
            item.classList.add('active');
        }

        const row = document.createElement('div');
        row.className = 'scenario-item-row';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined series-icon';
        icon.textContent = 'table_chart';

        const name = document.createElement('span');
        name.className = 'series-name';
        name.title = series.name || series.id;
        name.textContent = series.name || series.id;

        row.appendChild(icon);
        row.appendChild(name);
        item.appendChild(row);

        // Optional meta row (like scenario meta)
        if (series.rowCount !== undefined || series.updatedAt) {
            const meta = document.createElement('div');
            meta.className = 'scenario-meta';
            const parts = [];
            if (series.rowCount !== undefined) {
                parts.push(`${series.rowCount} rows`);
            }
            if (series.updatedAt) {
                const date = new Date(series.updatedAt);
                parts.push(`Updated ${date.toLocaleDateString()}`);
            }
            meta.textContent = parts.join(' · ');
            item.appendChild(meta);
        }

        item.addEventListener('click', () => {
            this.selectedDatasetId = dataset.id;
            this.seriesPagination.offset = 0;
            this.#loadSeriesPreview(series.id, { dataset });
        });

        return item;
    }

    #createDatasetEntry(dataset) {
        // Legacy method - redirects to new structure
        const fragment = document.createDocumentFragment();
        fragment.appendChild(this.#createDatasetHeaderItem(dataset));
        (dataset.series || []).forEach((series) => {
            fragment.appendChild(this.#createSeriesItem(dataset, series));
        });
        return fragment;
    }

    #createAddDatasetEntry() {
        const wrapper = document.createElement('div');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'data-page__series-button';
        button.textContent = 'Add Dataset';
        button.addEventListener('click', async () => {
            await this.#createDataset();
        });
        wrapper.appendChild(button);
        return wrapper;
    }

    #renderSeriesPreview() {
        if (!this.tableWrapperEl || !this.seriesSummaryEl || !this.seriesEmptyEl) {
            return;
        }

        // Remove loading indicator if present
        const contentEl = this.rootEl?.querySelector('.data-series-view');
        const loader = contentEl?.querySelector('.series-loading');
        if (loader) {
            loader.remove();
        }

        // Clear previous DataTable
        if (this._seriesDataTable) {
            this._seriesDataTable.dispose();
            this._seriesDataTable = null;
        }

        this.seriesHeaderEl.innerHTML = '';
        this.seriesSummaryEl.innerHTML = '';

        // Always re-show the table container (busy toggle hides it)
        this.tableWrapperEl.style.display = '';

        if (!this.seriesPreview || !this.seriesPreview.rows.length) {
            // Distinguish "no selection" from "selected series has 0 rows"
            const isEmptySeries = this.seriesPreview && this.selectedSeriesId;
            this.#updateEmptyState(isEmptySeries);
            this.seriesEmptyEl.style.display = '';
            this.seriesHeaderEl.style.display = 'none';
            this.seriesSummaryEl.style.display = 'none';
            // Remove any leftover data-table-container DOM
            const staleTable = this.tableWrapperEl.querySelector('.data-table-container');
            if (staleTable) staleTable.remove();
            return;
        }

        // Hide empty state, show data elements
        this.seriesEmptyEl.style.display = 'none';
        this.seriesHeaderEl.style.display = '';
        this.seriesSummaryEl.style.display = '';

        const meta = this.seriesMeta || {};
        const count = meta.totalCount ?? this.seriesPreview.rows.length;
        const datasetName = meta.datasetName || this.#getDatasetNameBySeries(this.selectedSeriesId);
        const seriesName = meta.seriesName || this.#getSeriesName(this.selectedSeriesId);
        const readonly = Boolean(meta.readonly || meta.scenarioId);
        const showDelete = !readonly || meta.source === 'scenario-run';
        const showRename = !readonly || meta.source === 'scenario-run';

        // Build header matching original structure
        this.#renderSeriesHeader({
            datasetName,
            seriesName,
            seriesId: this.selectedSeriesId,
            datasetId: this.selectedDatasetId,
            scenarioId: meta.scenarioId,
            source: meta.source || 'dataset',
            showRename,
            showDelete,
        });

        // Render metadata section
        this.#renderSeriesMetadata(meta);

        // Bind filter handlers
        this.#bindNamespaceFilter();
        this.#bindTypeFilterButtons();

        // Prepare headers and rows for DataTable
        const allHeaders = this.seriesPreview.headers.length ? this.seriesPreview.headers : ['time'];

        // Apply namespace filter to determine visible columns
        const visibleColumns = this.#getVisibleColumns(allHeaders);

        // Filter headers and create display names
        const displayHeaders = allHeaders
            .filter((_, idx) => visibleColumns[idx])
            .map(h => stripHeaderPrefix(h));
        const originalHeaders = allHeaders.filter((_, idx) => visibleColumns[idx]);

        // Normalize and filter rows
        const tableRows = this.seriesPreview.rows.map(row => {
            const normalized = this.#normalizeRow(allHeaders, row);
            return normalized.filter((_, idx) => visibleColumns[idx]);
        });

        // Create container for DataTable (inside tableWrapperEl, after emptyEl)
        let dataTableContainer = this.tableWrapperEl.querySelector('.data-table-container');
        if (!dataTableContainer) {
            dataTableContainer = document.createElement('div');
            dataTableContainer.className = 'data-table-container';
            dataTableContainer.style.cssText = 'flex:1; min-height:0; display:flex; flex-direction:column;';
            this.tableWrapperEl.appendChild(dataTableContainer);
        } else {
            dataTableContainer.innerHTML = '';
        }

        // Create DataTable with client-side pagination, sorting, and filtering
        this._seriesDataTable = new DataTable(dataTableContainer, {
            headers: displayHeaders,
            rows: tableRows,
            pageSize: this.seriesPagination.limit,
            pagination: true,
            selectable: true,
            copyable: true,
            sortable: true,
            filterable: true,
            readonly: false,
            emptyMessage: 'No data available',
            services: { eventBus: this.eventBus, logger: this.logger },
            formatValue: (value, colIdx) => this.#formatValue(value),
            getHeaderIcon: (header, colIdx) => {
                const originalHeader = originalHeaders[colIdx];
                const kind = getHeaderKind(originalHeader);
                return { icon: getIconForKind(kind), title: kind };
            },
        });

        this._seriesDataTable.render();

        // Install overlay scrollbars on the preview-table-wrap created by DataTable
        // This must happen AFTER render() creates the DOM element
        const tableWrap = dataTableContainer.querySelector('.preview-table-wrap');
        if (tableWrap) {
            installOverlayScrollbar(tableWrap, {
                orientation: 'vertical',
                className: 'panel-scrollbar',
                watchSubtree: true,
            });
            installOverlayScrollbar(tableWrap, {
                orientation: 'horizontal',
                className: 'panel-scrollbar',
                watchSubtree: true,
            });
        }
    }

    /**
     * Populate the empty-state placeholder based on whether datasets exist.
     * When no datasets are loaded, shows a full onboarding screen explaining the page.
     * When datasets exist but no series is selected, shows a brief prompt.
     */
    #updateEmptyState(isEmptySeries = false) {
        if (!this.seriesEmptyEl) return;

        const hasData = this.datasets.length > 0;

        if (isEmptySeries) {
            const seriesName = this.seriesMeta?.seriesName
                || this.#getSeriesName(this.selectedSeriesId)
                || 'This series';
            this.seriesEmptyEl.className = 'placeholder-message';
            this.seriesEmptyEl.innerHTML = `
                <span class="material-symbols-outlined">info</span>
                <h3>No Data</h3>
                <p><strong>${seriesName}</strong> contains no rows. The data source may have returned empty results &mdash; check the ETL pipeline filters (country, date range).</p>
            `;
        } else if (hasData) {
            this.seriesEmptyEl.className = 'placeholder-message';
            this.seriesEmptyEl.innerHTML = `
                <span class="material-symbols-outlined">touch_app</span>
                <h3>Select a Series</h3>
                <p>Choose a dataset or scenario run from the sidebar to preview its data.</p>
            `;
        } else {
            this.seriesEmptyEl.className = 'placeholder-message data-page__onboarding';
            this.seriesEmptyEl.innerHTML = `
                <span class="material-symbols-outlined">database</span>
                <h3>Data Explorer</h3>
                <p>Browse and inspect time-series data used in your models.</p>
                <div class="data-page__onboarding-features">
                    <div class="data-page__onboarding-feature">
                        <span class="material-symbols-outlined">folder_open</span>
                        <div>
                            <strong>Managed Datasets</strong>
                            <span>Import CSV or Excel files as model inputs or reference data</span>
                        </div>
                    </div>
                    <div class="data-page__onboarding-feature">
                        <span class="material-symbols-outlined">history</span>
                        <div>
                            <strong>Scenario Runs</strong>
                            <span>Simulation results appear here automatically after each run</span>
                        </div>
                    </div>
                </div>
                <p class="data-page__onboarding-hint">Import a dataset using the <strong>Import data</strong> button in the top bar, or run a simulation to get started.</p>
            `;
        }
    }

    /**
     * Get visible columns based on namespace and type filters.
     * Also deduplicates simple stocks (hides __SimpleStocks__:: format, keeps friendly format).
     * @param {string[]} headers - All headers
     * @returns {boolean[]} Array indicating which columns are visible
     */
    #getVisibleColumns(headers) {
        // Build a set of friendly simple stock names that exist
        // If we have both "Namespace.__SimpleStocks__::x[State]" and "Namespace.x",
        // we want to hide the former and show the latter
        const friendlySimpleStockNames = new Set();
        const longSimpleStockNames = new Set();

        for (const header of headers) {
            let stripped = header;
            const prefixMatch = header.match(/^(stock|flow|indicator|constant|parameter|const|param):/i);
            if (prefixMatch) {
                stripped = header.substring(prefixMatch[0].length);
            }

            // Check if this is a long-form simple stock: Namespace.__SimpleStocks__::varName[...]
            if (stripped.includes('.__SimpleStocks__::')) {
                longSimpleStockNames.add(stripped);
                // Extract the friendly name: Namespace.varName (without __SimpleStocks__:: and bracket part)
                const match = stripped.match(/^([^.]+)\.__SimpleStocks__::([^[]+)/);
                if (match) {
                    const friendlyName = `${match[1]}.${match[2]}`;
                    friendlySimpleStockNames.add(friendlyName);
                }
            }
        }

        const sanitizedFilter = this._activeNamespaceFilter
            ? this._activeNamespaceFilter.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
            : null;

        return headers.map((header) => {
            // Time column is always visible
            const lower = header.toLowerCase();
            if (lower === 't' || lower === 'time' || lower === 'step' || lower === 'period') {
                return true;
            }

            // Strip type prefix for analysis
            let stripped = header;
            const prefixMatch = header.match(/^(stock|flow|indicator|constant|parameter|const|param):/i);
            if (prefixMatch) {
                stripped = header.substring(prefixMatch[0].length);
            }

            // Deduplicate simple stocks: hide long form if friendly form exists
            if (stripped.includes('.__SimpleStocks__::')) {
                // Check if friendly version exists in headers
                const match = stripped.match(/^([^.]+)\.__SimpleStocks__::([^[]+)/);
                if (match) {
                    const friendlyName = `${match[1]}.${match[2]}`;
                    // Check if the friendly name exists (with any prefix)
                    const friendlyExists = headers.some(h => {
                        let s = h;
                        const pm = h.match(/^(stock|flow|indicator|constant|parameter|const|param):/i);
                        if (pm) s = h.substring(pm[0].length);
                        return s === friendlyName;
                    });
                    if (friendlyExists) {
                        return false; // Hide the long form
                    }
                }
            }

            // Get header kind for type filtering
            let kind = getHeaderKind(header);

            // Check if this is a friendly simple stock name (e.g., "Equilibrium.x")
            // These should be treated as stocks, not indicators
            if (friendlySimpleStockNames.has(stripped)) {
                kind = 'stock';
            }

            // Apply type filter (flows are grouped with indicators)
            if (kind === 'stock' && !this._activeTypeFilters.stock) return false;
            if ((kind === 'flow' || kind === 'indicator') && !this._activeTypeFilters.indicator) return false;

            // Apply namespace filter
            if (sanitizedFilter) {
                const dotIdx = stripped.indexOf('.');
                if (dotIdx === -1) return true; // No namespace prefix - show it

                const headerNs = stripped.substring(0, dotIdx);
                if (headerNs !== sanitizedFilter) return false;
            }

            return true;
        });
    }

    #renderSeriesHeader({ datasetName, seriesName, seriesId, datasetId, scenarioId, source, showRename, showDelete }) {
        const displayDataset = datasetName || (source === 'scenario' || source === 'scenario-series' ? 'Scenario' : 'Dataset');
        const titleText = `${displayDataset} \u00b7 ${seriesName || ''}`;

        const isScenarioSource = source === 'scenario-run' || source === 'scenario-series' || Boolean(scenarioId);

        // Store metadata on the header for downstream lookups
        this.seriesHeaderEl._seriesId = seriesId;
        this.seriesHeaderEl._datasetId = datasetId;
        this.seriesHeaderEl._scenarioId = scenarioId || '';
        this.seriesHeaderEl._source = source;

        const actions = [
            { key: 'plot', label: 'Plot', icon: 'monitoring', variant: 'secondary', handler: () => this.#openSeriesPlot() },
            { key: 'download', label: 'Download', icon: 'download', variant: 'secondary', handler: () => this.#downloadSeriesAsCsv() },
        ];

        if (isScenarioSource) {
            actions.push({ key: 'save-as-dataset', label: 'Save', icon: 'save', variant: 'secondary', title: 'Save as managed dataset', handler: () => this.#saveRunAsDataset(seriesId) });
        }

        if (showRename) {
            actions.push({ key: 'rename', label: 'Rename', icon: 'edit', variant: 'secondary', handler: () => {
                // Trigger inline rename on the header name
                const nameEl = this.seriesHeaderEl.querySelector('.detail-header__name');
                if (nameEl) nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            }});
        }

        if (showDelete) {
            actions.push({ key: 'delete', label: 'Delete', icon: 'delete', variant: 'danger', handler: () => this.#handleDeleteSeries() });
        }

        updateDetailHeader(this.seriesHeaderEl, {
            title: titleText,
            renameable: showRename,
            onRename: showRename ? async (newName) => {
                try {
                    const actionsHost = this.dataHub?.hostBridge;
                    const sid = seriesId || this.selectedSeriesId;

                    let res;
                    if ((source === 'scenario-run') && actionsHost?.rename_scenario_run) {
                        res = await actionsHost.rename_scenario_run(sid, newName);
                    } else {
                        res = await actionsHost?.rename_series?.(sid, newName);
                    }

                    if (res?.ok !== false) {
                        await this.refreshDatasets({ silent: true, force: true });
                        return { success: true, newValue: `${displayDataset} \u00b7 ${newName}` };
                    }
                    return { success: false };
                } catch (err) {
                    this.logger?.error?.('data', 'Rename failed', err);
                    return { success: false };
                }
            } : undefined,
            actions,
        });
    }

    #renderSeriesMetadata(meta) {
        const summary = this.seriesSummaryEl;
        summary.className = 'series-meta';

        const parts = [];

        // Namespace filter for scenario runs (added at the end, positioned right via CSS)
        const isScenarioRun = meta.source === 'scenario-run' || meta.source === 'scenario-series' || meta.scenarioId;
        let namespaceFilterHtml = '';
        if (isScenarioRun && this.dataManager) {
            const namespaces = this.dataManager.listNamespaces?.() || [];
            if (namespaces.length > 0) {
                // Use namespace displayName as value since headers use display names (e.g., "stock:Main.variable")
                const options = namespaces.map(ns => {
                    const nsName = ns.displayName || ns.id;
                    return `<option value="${this.#escapeHtml(nsName)}"${nsName === this._activeNamespaceFilter ? ' selected' : ''}>${this.#escapeHtml(nsName)}</option>`;
                }).join('');
                namespaceFilterHtml = `<div class="meta-section meta-namespace-section"><span class="meta-label">Namespace</span><select class="meta-namespace-filter" id="namespace-filter-select"><option value="">All</option>${options}</select></div>`;
            }
        }

        // Type filter toggle buttons (stocks, indicators)
        let typeFilterHtml = '';
        if (isScenarioRun) {
            const stockActive = this._activeTypeFilters.stock ? ' active' : '';
            const indicatorActive = this._activeTypeFilters.indicator ? ' active' : '';
            typeFilterHtml = `
                <div class="meta-section meta-type-filter-section">
                    <div class="type-filter-group">
                        <button class="type-filter-btn${stockActive}" data-type="stock" title="Show/hide stocks">
                            <span class="material-symbols-outlined">inventory_2</span>
                            <span class="type-filter-label">Stocks</span>
                        </button>
                        <button class="type-filter-btn${indicatorActive}" data-type="indicator" title="Show/hide indicators">
                            <span class="material-symbols-outlined">insights</span>
                            <span class="type-filter-label">Indicators</span>
                        </button>
                    </div>
                </div>
            `;
        }

        // Variable kind for scenario series
        if (meta.kind) {
            const label = meta.kind.charAt(0).toUpperCase() + meta.kind.slice(1);
            parts.push(`<div class="meta-section"><span class="meta-label">Kind</span><span class="meta-val">${this.#escapeHtml(label)}</span></div>`);
        }

        // Steps
        if (meta.summary?.steps != null) {
            parts.push(`<div class="meta-section"><span class="meta-label">Steps</span><span class="meta-val">${this.#escapeHtml(meta.summary.steps)}</span></div>`);
        }

        // Time range
        if (meta.summary?.timeStart != null && meta.summary?.timeEnd != null) {
            parts.push(`<div class="meta-section"><span class="meta-label">Time Range</span><span class="meta-val">${this.#escapeHtml(meta.summary.timeStart)} → ${this.#escapeHtml(meta.summary.timeEnd)}</span></div>`);
        }

        // Counts
        const countRows = [];
        if (typeof meta.summary?.stockCount === 'number') countRows.push(`Stocks: ${meta.summary.stockCount}`);
        if (typeof meta.summary?.flowCount === 'number') countRows.push(`Flows: ${meta.summary.flowCount}`);
        if (typeof meta.summary?.indicatorCount === 'number') countRows.push(`Indicators: ${meta.summary.indicatorCount}`);
        if (countRows.length) {
            parts.push(`<div class="meta-section meta-multi"><span class="meta-label">Series</span><div class="meta-rows">${countRows.map(r => `<div class="meta-row">${this.#escapeHtml(r)}</div>`).join('')}</div></div>`);
        }

        // Run ID
        if (meta.runId) {
            const shortRun = meta.runId.length > 10 ? `${meta.runId.slice(0, 8)}…` : meta.runId;
            parts.push(`<div class="meta-section"><span class="meta-label">Run ID</span><span class="meta-val has-tooltip" data-tooltip="${this.#escapeHtml(meta.runId)}">${this.#escapeHtml(shortRun)}</span></div>`);
        }

        // Timestamp
        if (meta.createdAt) {
            const ts = new Date(meta.createdAt).toLocaleString();
            parts.push(`<div class="meta-section"><span class="meta-label">Run At</span><span class="meta-val">${this.#escapeHtml(ts)}</span></div>`);
        }

        if (parts.length || namespaceFilterHtml || typeFilterHtml) {
            summary.innerHTML = parts.join('') + typeFilterHtml + namespaceFilterHtml;
        }
    }

    #bindNamespaceFilter() {
        const select = this.seriesSummaryEl?.querySelector('#namespace-filter-select');
        if (!select) return;

        select.addEventListener('change', (e) => {
            const namespaceName = e.target.value || null;
            this._activeNamespaceFilter = namespaceName;
            this.#applyFilters();
        });
    }

    #bindTypeFilterButtons() {
        const buttons = this.seriesSummaryEl?.querySelectorAll('.type-filter-btn');
        if (!buttons) return;

        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = btn.dataset.type;
                if (type && this._activeTypeFilters.hasOwnProperty(type)) {
                    this._activeTypeFilters[type] = !this._activeTypeFilters[type];
                    btn.classList.toggle('active', this._activeTypeFilters[type]);
                    this.#applyFilters();
                }
            });
        });
    }

    #applyFilters() {
        // Re-render the DataTable with filtered columns
        // The #renderSeriesPreview method uses #getVisibleColumns to filter
        if (this.seriesPreview && this.seriesPreview.rows.length > 0) {
            this.#renderSeriesPreview();
        }
    }

    async #handleDeleteSeries() {
        const meta = this.seriesMeta || {};
        const seriesName = meta.seriesName || this.#getSeriesName(this.selectedSeriesId);
        const ok = await showDeleteConfirmDialog({
            itemName: seriesName,
            itemType: 'series',
        });
        if (!ok) return;

        try {
            const actionsHost = this.dataHub?.hostBridge;
            const sid = this.selectedSeriesId;

            // Detect scenario runs by scenarioId/runId presence (source can be
            // "scenario-run", "memory", or "disk" depending on the backend path)
            const isScenarioRun = Boolean(meta.scenarioId || meta.runId);

            if (isScenarioRun && actionsHost?.delete_scenario_run) {
                const res = await actionsHost.delete_scenario_run(sid);
                if (res?.ok) {
                    this.#notify('Data', 'Run deleted', 'success');
                } else {
                    this.#notify('Data', res?.error || 'Failed to delete run', 'error');
                    return;
                }
            } else if (actionsHost?.delete_series) {
                const res = await actionsHost.delete_series(sid);
                if (!res?.ok) {
                    this.#notify('Data', 'Failed to delete series', 'error');
                    return;
                }
            }

            this.selectedSeriesId = null;
            this.seriesPreview = null;
            this.seriesMeta = null;
            await this.refreshDatasets({ silent: true, force: true });
            this.#renderSeriesPreview();
        } catch (err) {
            this.logger?.error?.('data-page', 'Delete failed', { error: err });
            this.#notify('Data', 'Delete failed', 'error');
        }
    }

    #isColumnNumeric(colIndex) {
        if (!this.seriesPreview?.rows?.length) return false;
        // Check first few rows to determine if column is numeric
        const samples = this.seriesPreview.rows.slice(0, 20);
        const headers = this.seriesPreview.headers || ['time'];
        const TIME_NAMES = new Set(['time', 'tDisp', 'year', 'date', 'timestamp']);
        const firstIsTime = TIME_NAMES.has(headers[0]);
        const colOffset = firstIsTime ? 1 : 0;
        return samples.every((row) => {
            let value;
            if (Array.isArray(row)) {
                value = row[colIndex];
            } else if (row && typeof row === 'object') {
                if (TIME_NAMES.has(headers[colIndex])) {
                    value = row.tDisp ?? row.time ?? '';
                } else if (Array.isArray(row.cols)) {
                    value = row.cols[colIndex - colOffset];
                } else {
                    value = row[headers[colIndex]] ?? '';
                }
            }
            if (value === null || value === undefined || value === '') return true;
            return typeof value === 'number' || !isNaN(Number(value));
        });
    }

    #escapeHtml(str) {
        const s = String(str ?? '');
        return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    #normalizeRow(headers, row) {
        if (Array.isArray(row)) {
            const values = headers.map((_, idx) => (idx < row.length ? row[idx] : ''));
            return values;
        }
        if (row && typeof row === 'object') {
            // Detect whether the first header is the time column so we
            // know how to index into row.cols (which excludes time).
            const TIME_NAMES = new Set(['time', 'tDisp', 'year', 'date', 'timestamp']);
            const firstIsTime = TIME_NAMES.has(headers[0]);
            const colOffset = firstIsTime ? 1 : 0;

            const values = [];
            headers.forEach((header, idx) => {
                // Time column: read from tDisp / time property
                if (TIME_NAMES.has(header)) {
                    if (Object.prototype.hasOwnProperty.call(row, 'tDisp')) {
                        values[idx] = row.tDisp;
                        return;
                    }
                    if (Object.prototype.hasOwnProperty.call(row, 'time')) {
                        values[idx] = row.time;
                        return;
                    }
                }
                if (Array.isArray(row.cols)) {
                    const colIdx = idx - colOffset;
                    values[idx] = row.cols[colIdx] ?? '';
                } else {
                    values[idx] = row[header] ?? '';
                }
            });
            return values;
        }
        return headers.map(() => '');
    }

    #csvEscape(value) {
        if (value == null) return '';
        const str = String(value);
        if (/[",\n]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    async #openSeriesPlot() {
        if (!this.selectedSeriesId || !this.seriesPreview) {
            this.#notify('Plot', 'No series selected.', 'warn');
            return;
        }

        const headers = this.seriesPreview.headers || [];
        const seriesId = this.selectedSeriesId;
        const seriesName = this.seriesMeta?.seriesName || '';
        const datasetName = this.seriesMeta?.datasetName || '';

        await openDataSeriesPlotWindow({
            seriesId,
            seriesName,
            datasetName,
            headers,
            dataHub: this.dataHub,
            services: {
                eventBus: this.eventBus,
                logger: this.logger,
            },
            getPlotConfig: (id) => this.#getSeriesPlotConfig(id),
            savePlotConfig: (id, config) => this.#saveSeriesPlotConfig(id, config),
        });
    }

    #getSeriesPlotConfig(seriesId) {
        return this.dataManager?.metadata?.seriesPlotConfigs?.[seriesId] ?? null;
    }

    #saveSeriesPlotConfig(seriesId, config) {
        if (!this.dataManager) return;
        if (!this.dataManager.metadata.seriesPlotConfigs) {
            this.dataManager.metadata.seriesPlotConfigs = {};
        }
        this.dataManager.metadata.seriesPlotConfigs[seriesId] = config;
        this.dataManager.updatedAt = Date.now();
    }

    async #downloadSeriesAsCsv() {
        if (!this.selectedSeriesId || !this.seriesPreview) {
            this.#notify('Download', 'No series data to download.', 'warn');
            return;
        }

        try {
            // Fetch all data for the series (no pagination limit)
            // Note: limit: null means "no limit" - limit: 0 would return 0 rows
            const response = await this.dataHub.fetchSeriesById(this.selectedSeriesId, { limit: null, offset: 0 });
            if (!response?.ok) {
                throw new Error(response?.error || 'Failed to fetch series data');
            }

            const headers = Array.isArray(response.headers) ? response.headers : (this.seriesPreview.headers || ['time']);
            const rows = Array.isArray(response.rows) ? response.rows : [];

            // Build CSV content
            const matrix = [headers];
            rows.forEach((row) => {
                const normalized = this.#normalizeRow(headers, row);
                matrix.push(normalized);
            });

            const csvContent = matrix
                .map((row) => row.map((cell) => this.#csvEscape(cell)).join(','))
                .join('\n');

            // Create and trigger download via native save dialog
            const seriesName = this.seriesMeta?.seriesName || this.#getSeriesName(this.selectedSeriesId) || 'series';
            const safeName = seriesName.replace(/[^a-z0-9_-]/gi, '_');
            const filename = `${safeName}.csv`;

            const result = await window.pywebview.api.save_file_dialog(csvContent, filename, 'csv');

            if (result?.ok) {
                this.#notify('Download', `Saved ${rows.length} rows to ${result.path}`, 'info');
            } else if (result?.cancelled) {
                // User cancelled - no notification needed
            } else {
                throw new Error(result?.error || 'Save failed');
            }
        } catch (error) {
            this.#reportError('Download failed', error);
        }
    }

    #openImportWizard() {
        this.wizardState = this.#createWizardState({
            open: true,
            targetDatasetId: this.selectedDatasetId || (this.datasets[0]?.id ?? null),
        });

        // Create ManagedWindow if not exists
        if (!this.importWizardWindow) {
            // Default to 85% of viewport
            const defaultWidth = Math.round(window.innerWidth * 0.85);
            const defaultHeight = Math.round(window.innerHeight * 0.85);
            this.importWizardWindow = new ManagedWindow({
                id: 'import-wizard',
                title: 'Import Data',
                icon: 'upload_file',
                content: this.wizardContainerEl,
                minWidth: 800,
                minHeight: 600,
                defaultWidth,
                defaultHeight,
                canMaximize: false,
                modal: false, // No backdrop - import wizard should not blur content
                onClose: () => this.#closeImportWizard(),
            });
        }

        this.#renderWizard();
        this.importWizardWindow.show();
        this.#emitViewEvent(VIEW_EVENTS.IMPORT_OPENED, {});
    }

    #openImportWizardForDataset(datasetId) {
        this.selectedDatasetId = datasetId;
        this.#openImportWizard();
    }

    #closeImportWizard() {
        // Clean up debounce timer and invalidate pending requests
        if (this._refinePreviewDebounceTimer) {
            clearTimeout(this._refinePreviewDebounceTimer);
            this._refinePreviewDebounceTimer = null;
        }
        this._refinePreviewRequestId++;  // Invalidate any pending requests
        this._refinePreviewLoading = false;
        this.wizardState = this.#createWizardState();
        if (this.wizardContainerEl) {
            this.wizardContainerEl.innerHTML = '';
        }
        // Close window if open (but don't trigger onClose recursively)
        if (this.importWizardWindow && this.importWizardWindow.isVisible) {
            // Temporarily remove onClose to prevent recursion
            const onClose = this.importWizardWindow.onClose;
            this.importWizardWindow.onClose = null;
            this.importWizardWindow.close();
            this.importWizardWindow.onClose = onClose;
        }
        this.#emitViewEvent(VIEW_EVENTS.IMPORT_CLOSED, {});
    }

    #renderWizard() {
        if (!this.wizardContainerEl) {
            return;
        }
        this.wizardContainerEl.innerHTML = '';

        // Stepper (ManagedWindow provides the title bar, so no header needed)
        const stepper = document.createElement('ol');
        stepper.className = 'data-page__wizard-steps';
        WIZARD_STEPS.forEach((step) => {
            const li = document.createElement('li');
            li.textContent = step.toUpperCase();
            if (step === this.wizardState.step) {
                li.classList.add('is-active');
            }
            stepper.appendChild(li);
        });

        const body = document.createElement('div');
        body.className = 'data-page__wizard-body';
        body.appendChild(this.#renderWizardStep());

        const footer = document.createElement('footer');
        footer.className = 'data-page__wizard-footer';
        footer.appendChild(this.#renderWizardFooter());
        this.wizardFooterEl = footer;

        this.wizardContainerEl.appendChild(stepper);
        this.wizardContainerEl.appendChild(body);
        this.wizardContainerEl.appendChild(footer);
    }

    #renderWizardStep() {
        const stepContainer = document.createElement('div');
        stepContainer.className = 'data-page__wizard-step';
        const step = this.wizardState.step;

        if (step === 'source') {
            stepContainer.appendChild(this.#buildWizardSourceStep());
        } else if (step === 'preview') {
            stepContainer.appendChild(this.#buildWizardPreviewStep());
        } else if (step === 'refine') {
            stepContainer.appendChild(this.#buildWizardRefineStep());
        } else if (step === 'save') {
            stepContainer.appendChild(this.#buildWizardSaveStep());
        }

        return stepContainer;
    }

    #renderWizardFooter() {
        const footerContainer = document.createElement('div');
        footerContainer.className = 'data-page__wizard-footer-inner';
        const currentIndex = WIZARD_STEPS.indexOf(this.wizardState.step);

        const backButton = this.#createButton('Back', 'secondary');
        backButton.disabled = currentIndex === 0 || this.wizardState.saving;
        backButton.addEventListener('click', () => this.#setWizardStep(currentIndex - 1));

        const nextButton = this.#createButton(currentIndex === WIZARD_STEPS.length - 1 ? 'Save' : 'Next', 'primary');
        nextButton.disabled = this.#isWizardNextDisabled();
        this.wizardNextButtonEl = nextButton; // Store reference for dynamic updates
        nextButton.addEventListener('click', () => {
            if (currentIndex === WIZARD_STEPS.length - 1) {
                this.#saveImport();
            } else {
                this.#setWizardStep(currentIndex + 1);
            }
        });

        footerContainer.appendChild(backButton);
        footerContainer.appendChild(nextButton);
        return footerContainer;
    }

    #setWizardStep(index) {
        if (index < 0 || index >= WIZARD_STEPS.length) {
            return;
        }
        this.wizardState.step = WIZARD_STEPS[index];
        this.#renderWizard();
    }

    #isWizardNextDisabled() {
        const step = this.wizardState.step;
        const hasPreviewRows = Array.isArray(this.wizardState.preview?.rows) && this.wizardState.preview.rows.length > 0;
        const hasDataColumns = this.#getSelectedDataColumns().length > 0;
        if (step === 'source') {
            return !this.wizardState.csvBase64;
        }
        if (step === 'preview') {
            return !hasPreviewRows || !hasDataColumns;
        }
        if (step === 'refine') {
            return !hasPreviewRows || !hasDataColumns;
        }
        if (step === 'save') {
            const hasValidDataset = this.wizardState.targetDatasetId && this.wizardState.targetDatasetId !== '__new__';
            const hasNewDatasetName = this.wizardState.targetDatasetId === '__new__' && (this.wizardState.newDatasetName || '').trim();
            const hasSeriesName = (this.wizardState.seriesName || '').trim().length > 0;
            const isSaving = this.wizardState.saving;
            // Button enabled when: (valid dataset OR new dataset name) AND series name AND not currently saving
            const canSave = (hasValidDataset || hasNewDatasetName) && hasSeriesName && !isSaving;
            return !canSave;
        }
        return false;
    }

    #updateWizardButtonState() {
        if (this.wizardNextButtonEl) {
            this.wizardNextButtonEl.disabled = this.#isWizardNextDisabled();
        }
    }

    #buildWizardSourceStep() {
        const container = document.createElement('div');
        container.className = 'data-page__wizard-step-content';

        const dropZone = document.createElement('div');
        dropZone.className = 'data-page__drop-zone';
        dropZone.textContent = this.wizardState.fileName || 'Drop CSV file here or click to browse.';

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,text/csv';
        input.hidden = true;

        dropZone.addEventListener('click', () => input.click());
        dropZone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropZone.classList.add('is-drag-over');
        });
        dropZone.addEventListener('dragleave', (event) => {
            event.preventDefault();
            dropZone.classList.remove('is-drag-over');
        });
        dropZone.addEventListener('drop', (event) => {
            event.preventDefault();
            dropZone.classList.remove('is-drag-over');
            const file = event.dataTransfer?.files?.[0];
            if (file) {
                this.#handleWizardFileSelected(file);
            }
        });

        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) {
                this.#handleWizardFileSelected(file);
            }
        });

        container.appendChild(dropZone);
        container.appendChild(input);
        return container;
    }

    #buildWizardPreviewStep() {
        const container = document.createElement('div');
        container.className = 'data-page__wizard-step-content data-page__wizard-preview-step';

        // LEFT: Preview table pane
        const previewPane = document.createElement('div');
        previewPane.className = 'data-page__wizard-preview';

        const previewTitle = document.createElement('h4');
        previewTitle.textContent = 'Preview';
        previewPane.appendChild(previewTitle);

        if (!this.wizardState.preview?.rows?.length) {
            const hint = document.createElement('p');
            hint.className = 'data-page__wizard-hint';
            hint.textContent = 'Upload a CSV file to generate a preview.';
            previewPane.appendChild(hint);
        } else {
            // Build preview with selected columns applied
            const headers = this.#buildSelectionHeaders();
            const dataColumns = this.#getSelectedDataColumns();
            if (dataColumns.length > 0) {
                const rows = this.wizardState.preview.rows.slice(0, 30).map((row, rowIndex) => {
                    const timeValue = this.#computeTimeValueForRow(row, rowIndex);
                    return [timeValue, ...dataColumns.map((idx) => row[idx] ?? '')];
                });
                previewPane.appendChild(this.#buildSimpleTable(headers, rows));
            } else {
                previewPane.appendChild(this.#buildSimpleTable(this.wizardState.preview.headers, this.wizardState.preview.rows.slice(0, 30)));
            }
        }
        // Build settings pane first (will be appended before preview for top position)

        // Settings pane (CSV options + column mapping)
        const settingsPane = document.createElement('div');
        settingsPane.className = 'data-page__wizard-column-pane';

        // CSV parsing settings section - collapsible
        const { section: csvSection, content: csvContent } = this.#createCollapsibleSection('CSV Settings');

        csvContent.appendChild(this.#createConfigRow('Encoding', this.#createConfigSelect(['utf-8', 'latin1', 'utf-16le'], this.wizardState.encoding, (value) => {
            this.wizardState.encoding = value;
            this.wizardState.columnsTouched = false;
            if (this.wizardState.csvBase64) {
                this.#requestCsvPreview();
            }
        })));

        const separatorOptions = [
            { value: ',', label: 'Comma (,)' },
            { value: ';', label: 'Semicolon (;)' },
            { value: '\t', label: 'Tab' },
            { value: '|', label: 'Pipe (|)' },
        ];
        csvContent.appendChild(this.#createConfigRow('Separator', this.#createConfigSelect(separatorOptions, this.wizardState.separator || ',', (value) => {
            this.wizardState.separator = value || ',';
            this.wizardState.columnsTouched = false;
            if (this.wizardState.csvBase64) {
                this.#requestCsvPreview();
            }
        })));

        csvContent.appendChild(this.#createConfigRow('Header row', this.#createConfigCheckbox(this.wizardState.hasHeader, (checked) => {
            this.wizardState.hasHeader = checked;
            this.wizardState.columnsTouched = false;
            if (this.wizardState.csvBase64) {
                this.#requestCsvPreview();
            }
        })));

        settingsPane.appendChild(csvSection);

        // Column mapping section (only if we have preview data)
        if (this.wizardState.preview?.rows?.length) {
            const { section: mappingSection, content: mappingContent } = this.#createCollapsibleSection('Column Mapping');
            mappingContent.appendChild(this.#buildColumnMappingContent());
            settingsPane.appendChild(mappingSection);
        }

        // Append: preview (left), settings (right)
        container.appendChild(previewPane);
        container.appendChild(settingsPane);
        return container;
    }

    #buildWizardRefineStep() {
        const container = document.createElement('div');
        container.className = 'data-page__wizard-step-content data-page__wizard-refine';

        // Helper to trigger auto-refresh after setting change (debounced for number inputs)
        const autoRefresh = (immediate = false) => {
            // Clear any pending debounce timer
            if (this._refinePreviewDebounceTimer) {
                clearTimeout(this._refinePreviewDebounceTimer);
                this._refinePreviewDebounceTimer = null;
            }

            const doRefresh = () => {
                // Only call backend if any refinement option is enabled
                const hasRefinement = this.wizardState.refine.enableTrim ||
                                      this.wizardState.refine.enableMissing ||
                                      this.wizardState.refine.enableResample;
                if (hasRefinement) {
                    this.#requestRefinePreview();
                } else {
                    // Clear refined preview - use local preview instead
                    this.wizardState.refinePreview = null;
                    this.#renderWizard();
                }
            };

            if (immediate) {
                doRefresh();
            } else {
                // Debounce: wait 300ms after last change before refreshing
                this._refinePreviewDebounceTimer = setTimeout(doRefresh, 300);
            }
        };

        // RIGHT: Settings pane
        const settingsPane = document.createElement('div');
        settingsPane.className = 'data-page__wizard-settings';

        // Section 1: Trimming (applied first in the pipeline: trim -> missing data -> resample)
        const rowCount = this.wizardState.preview?.totalCount || this.wizardState.preview?.rows?.length || 0;
        const { section: trimSection, content: trimContent } = this.#createToggleSection('Trimming', this.wizardState.refine.enableTrim, (checked) => {
            this.wizardState.refine.enableTrim = checked;
            // Initialize trim values when enabling
            if (checked && rowCount > 0) {
                if (this.wizardState.refine.trimStart < 1) this.wizardState.refine.trimStart = 1;
                if (this.wizardState.refine.trimEnd < 1 || this.wizardState.refine.trimEnd > rowCount) {
                    this.wizardState.refine.trimEnd = rowCount;
                }
            }
            autoRefresh(true);  // Immediate refresh for toggle
        });
        if (this.wizardState.refine.enableTrim) {
            trimContent.appendChild(this.#createNumberField('Start row', this.wizardState.refine.trimStart, (value) => {
                this.wizardState.refine.trimStart = value;
                autoRefresh();
            }, {
                min: 1,
                getMax: () => this.wizardState.refine.trimEnd || rowCount,
            }));
            trimContent.appendChild(this.#createNumberField('End row', this.wizardState.refine.trimEnd, (value) => {
                this.wizardState.refine.trimEnd = value;
                autoRefresh();
            }, {
                getMin: () => this.wizardState.refine.trimStart || 1,
                max: rowCount,
            }));
        }
        settingsPane.appendChild(trimSection);

        // Section 2: Missing data
        const { section: missingSection, content: missingContent } = this.#createToggleSection('Missing Data', this.wizardState.refine.enableMissing, (checked) => {
            this.wizardState.refine.enableMissing = checked;
            autoRefresh(true);  // Immediate refresh for toggle
        });
        if (this.wizardState.refine.enableMissing) {
            const methodOptions = [
                { value: 'ffill', label: 'Forward fill' },
                { value: 'bfill', label: 'Backward fill' },
                { value: 'linear', label: 'Linear interpolation' },
                { value: 'zero', label: 'Fill with zero' },
            ];
            missingContent.appendChild(this.#createSelectField('Method', 'missing', methodOptions, this.wizardState.refine.missingMethod, (value) => {
                this.wizardState.refine.missingMethod = value;
                autoRefresh(true);  // Immediate refresh for select
            }));
        }
        settingsPane.appendChild(missingSection);

        // Section 3: Resample
        // Determine effective time mode: use 'explicit' only if we have valid parsed timestamps
        const configuredMode = this.wizardState.timeMode;
        const parsedTimes = this.wizardState.parsedTimePreview;
        const hasValidDatetimes = parsedTimes && parsedTimes.some(p => p && !p.error && p.timestamp);
        // Use datetime mode only if configured AND we have valid timestamps
        const effectiveTimeMode = (configuredMode === 'explicit' && hasValidDatetimes) ? 'datetime' : 'numeric';

        const { section: resampleSection, content: resampleContent } = this.#createToggleSection('Resample', this.wizardState.refine.enableResample, (checked) => {
            this.wizardState.refine.enableResample = checked;
            autoRefresh(true);  // Immediate refresh for toggle
        });
        if (this.wizardState.refine.enableResample) {
            // Detect current step size from data
            const currentStep = this.#detectCurrentStepSize();

            // Show detected frequency
            if (currentStep.detected) {
                const infoDiv = document.createElement('div');
                infoDiv.className = 'data-page__wizard-hint';
                infoDiv.textContent = `Detected frequency: ${currentStep.label}`;
                resampleContent.appendChild(infoDiv);
            }

            // Variables for up/downsampling detection
            let isDownsampling = false;
            let isUpsampling = false;
            let ratioText = '';

            if (effectiveTimeMode === 'datetime') {
                // Datetime-based resampling: user picks target period + count
                const unitOptions = [
                    { value: 'year', label: 'Year' },
                    { value: 'quarter', label: 'Quarter' },
                    { value: 'month', label: 'Month' },
                    { value: 'week', label: 'Week' },
                    { value: 'day', label: 'Day' },
                    { value: 'hour', label: 'Hour' },
                    { value: 'minute', label: 'Minute' },
                    { value: 'second', label: 'Second' },
                ];
                resampleContent.appendChild(this.#createSelectField('Target period', 'resampleUnit', unitOptions, this.wizardState.refine.resampleUnit, (value) => {
                    this.wizardState.refine.resampleUnit = value;
                    autoRefresh(true);  // Immediate refresh for select
                }));

                resampleContent.appendChild(this.#createNumberField('Every N periods', this.wizardState.refine.resampleStep, (value) => {
                    this.wizardState.refine.resampleStep = Math.max(1, Math.round(value) || 1);
                    autoRefresh();
                }));

                // Calculate target in milliseconds for comparison
                const targetMs = this.#periodToMs(this.wizardState.refine.resampleUnit, this.wizardState.refine.resampleStep || 1);
                const currentMs = currentStep.ms || 0;

                if (currentStep.detected && currentMs > 0) {
                    const ratio = targetMs / currentMs;
                    isDownsampling = ratio > 1.1; // 10% tolerance
                    isUpsampling = ratio < 0.9;
                    if (isDownsampling) {
                        const rowsPerBucket = Math.round(ratio);
                        ratioText = rowsPerBucket > 1
                            ? `aggregating ~${rowsPerBucket} rows into 1`
                            : 'regrouping rows (1:1 ratio)';
                    } else if (isUpsampling) {
                        ratioText = `interpolating ~${Math.round(1 / ratio)} values between rows`;
                    }
                }
            } else {
                // Integer/relative mode: user picks target step size
                // Allow decimals, minimum is 0.001 to support fractional step data
                resampleContent.appendChild(this.#createNumberField('Target step size', this.wizardState.refine.resampleStep, (value) => {
                    this.wizardState.refine.resampleStep = Math.max(0.001, parseFloat(value) || 1);
                    autoRefresh();
                }));

                const targetStep = this.wizardState.refine.resampleStep || 1;
                const currentStepValue = currentStep.value || 1;

                if (currentStep.detected) {
                    const ratio = targetStep / currentStepValue;
                    isDownsampling = ratio > 1.1;  // 10% tolerance for floating point
                    isUpsampling = ratio < 0.9;
                    if (isDownsampling) {
                        const rowsPerBucket = Math.round(ratio);
                        ratioText = rowsPerBucket > 1
                            ? `aggregating ~${rowsPerBucket} rows into 1`
                            : 'regrouping rows (1:1 ratio)';
                    } else if (isUpsampling) {
                        ratioText = `interpolating ~${Math.round(1 / ratio)} values between rows`;
                    }
                }
            }

            // Show appropriate method based on direction
            if (!currentStep.detected || isDownsampling) {
                const aggOptions = [
                    { value: 'mean', label: 'Mean (arithmetic)' },
                    { value: 'median', label: 'Median' },
                    { value: 'sum', label: 'Sum' },
                    { value: 'first', label: 'First value' },
                    { value: 'last', label: 'Last value' },
                    { value: 'max', label: 'Maximum' },
                    { value: 'min', label: 'Minimum' },
                ];
                resampleContent.appendChild(this.#createSelectField('Aggregation method', 'resampleMethod', aggOptions, this.wizardState.refine.resampleMethod, (value) => {
                    this.wizardState.refine.resampleMethod = value;
                    autoRefresh(true);  // Immediate refresh for select
                }));
            }

            if (!currentStep.detected || isUpsampling) {
                const fillOptions = [
                    { value: 'linear', label: 'Linear interpolation' },
                    { value: 'ffill', label: 'Forward fill (hold)' },
                    { value: 'bfill', label: 'Backward fill' },
                    { value: 'zero', label: 'Fill with zero' },
                ];
                resampleContent.appendChild(this.#createSelectField('Interpolation method', 'resampleFill', fillOptions, this.wizardState.refine.resampleFillMethod, (value) => {
                    this.wizardState.refine.resampleFillMethod = value;
                    autoRefresh(true);  // Immediate refresh for select
                }));
            }

            // Show what will happen
            if (currentStep.detected) {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'data-page__wizard-hint';
                if (isDownsampling) {
                    // Check if meaningful aggregation will occur (more than 1 row per bucket)
                    if (ratioText.includes('1:1') || ratioText.includes('regrouping')) {
                        actionDiv.textContent = '→ No aggregation (target ≈ current step)';
                        actionDiv.style.color = '#f0ad4e';  // Warning color
                    } else {
                        actionDiv.textContent = `→ Downsampling: ${ratioText}`;
                    }
                } else if (isUpsampling) {
                    actionDiv.textContent = `→ Upsampling: ${ratioText}`;
                } else {
                    actionDiv.textContent = '→ No change (target ≈ current frequency)';
                    actionDiv.style.color = '#f0ad4e';  // Warning color
                }
                resampleContent.appendChild(actionDiv);
            }
        }
        settingsPane.appendChild(resampleSection);

        // Preview table (bottom section)
        const previewPane = document.createElement('div');
        previewPane.className = 'data-page__wizard-preview';

        const previewTitle = document.createElement('h4');
        previewTitle.textContent = 'Preview';
        previewPane.appendChild(previewTitle);

        // Use refined preview if available, otherwise build preview from raw data with selected columns
        if (this.wizardState.refinePreview?.rows?.length) {
            previewPane.appendChild(this.#buildSimpleTable(this.wizardState.refinePreview.headers, this.wizardState.refinePreview.rows.slice(0, 30)));
        } else if (this.wizardState.preview?.rows?.length) {
            // Build preview from raw data using selected columns (same format as refined output)
            const headers = this.#buildSelectionHeaders();
            const dataColumns = this.#getSelectedDataColumns();
            if (dataColumns.length > 0) {
                const rows = this.wizardState.preview.rows.slice(0, 30).map((row) => {
                    // First column is time (from time columns or row index)
                    const timeValue = this.#computeTimeValueForRow(row, this.wizardState.preview.rows.indexOf(row));
                    return [timeValue, ...dataColumns.map((idx) => row[idx] ?? '')];
                });
                previewPane.appendChild(this.#buildSimpleTable(headers, rows));
            } else {
                const hint = document.createElement('p');
                hint.className = 'data-page__wizard-hint';
                hint.textContent = 'Select data columns to see preview.';
                previewPane.appendChild(hint);
            }
        } else {
            const hint = document.createElement('p');
            hint.className = 'data-page__wizard-hint';
            hint.textContent = 'No data to preview.';
            previewPane.appendChild(hint);
        }

        // Append: preview (left), settings (right)
        container.appendChild(previewPane);
        container.appendChild(settingsPane);

        return container;
    }

    /**
     * Create a collapsible section in fn-config-section style.
     * @param {string} title - Section title
     * @param {boolean} [collapsed=false] - Initial collapsed state
     * @returns {{section: HTMLElement, content: HTMLElement}} Section element and its content container
     */
    #createCollapsibleSection(title, collapsed = false) {
        const section = document.createElement('div');
        section.className = 'data-page__settings-section' + (collapsed ? ' collapsed' : '');

        const header = document.createElement('div');
        header.className = 'data-page__settings-section__header';

        const toggle = document.createElement('span');
        toggle.className = 'data-page__settings-section__toggle';
        toggle.innerHTML = '<span class="material-symbols-outlined">expand_more</span>';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'data-page__settings-section__title';
        titleSpan.textContent = title;

        header.appendChild(toggle);
        header.appendChild(titleSpan);

        header.addEventListener('click', () => {
            section.classList.toggle('collapsed');
        });

        const content = document.createElement('div');
        content.className = 'data-page__settings-section__content';

        section.appendChild(header);
        section.appendChild(content);

        return { section, content };
    }

    /**
     * Create a collapsible section with a checkbox toggle in the header.
     * @param {string} title - Section title
     * @param {boolean} checked - Initial checkbox state
     * @param {function} onChange - Callback when checkbox changes
     * @returns {{section: HTMLElement, content: HTMLElement}} Section element and its content container
     */
    #createToggleSection(title, checked, onChange) {
        const section = document.createElement('div');
        section.className = 'data-page__settings-section';

        const header = document.createElement('div');
        header.className = 'data-page__settings-section__header';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.style.cssText = 'width: 14px; height: 14px; margin: 0;';
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            onChange(checkbox.checked);
        });
        checkbox.addEventListener('click', (e) => e.stopPropagation());

        const titleSpan = document.createElement('span');
        titleSpan.className = 'data-page__settings-section__title';
        titleSpan.textContent = title;

        header.appendChild(checkbox);
        header.appendChild(titleSpan);

        const content = document.createElement('div');
        content.className = 'data-page__settings-section__content';

        section.appendChild(header);
        section.appendChild(content);

        return { section, content };
    }

    #buildWizardSaveStep() {
        const container = document.createElement('div');
        container.className = 'data-page__wizard-step-content data-page__wizard-save';

        // === LEFT: Import Summary ===
        const summaryPane = document.createElement('div');
        summaryPane.className = 'data-page__save-summary';

        const summaryTitle = document.createElement('h3');
        summaryTitle.className = 'data-page__save-section-title';
        summaryTitle.textContent = 'Import Summary';
        summaryPane.appendChild(summaryTitle);

        // File info card
        const fileCard = document.createElement('div');
        fileCard.className = 'data-page__save-card';
        fileCard.innerHTML = `
            <div class="data-page__save-card-icon"><span class="material-symbols-outlined">description</span></div>
            <div class="data-page__save-card-content">
                <div class="data-page__save-card-label">Source File</div>
                <div class="data-page__save-card-value">${this.#escapeHtml(this.wizardState.fileName || 'Unknown')}</div>
            </div>
        `;
        summaryPane.appendChild(fileCard);

        // Data columns card
        const dataColumns = this.#getSelectedDataColumns();
        const columnsCard = document.createElement('div');
        columnsCard.className = 'data-page__save-card';
        columnsCard.innerHTML = `
            <div class="data-page__save-card-icon"><span class="material-symbols-outlined">view_column</span></div>
            <div class="data-page__save-card-content">
                <div class="data-page__save-card-label">Data Columns</div>
                <div class="data-page__save-card-value">${dataColumns.length} column${dataColumns.length !== 1 ? 's' : ''} selected</div>
            </div>
        `;
        summaryPane.appendChild(columnsCard);

        // Row count card - use totalCount from original file, show trimming/resampling info
        const totalRowCount = this.wizardState.preview?.totalCount || this.wizardState.preview?.rows?.length || 0;
        let rowCountDisplay = `${totalRowCount.toLocaleString()} rows`;
        const modifications = [];

        // Calculate trimming effect
        if (this.wizardState.refine.enableTrim && totalRowCount > 0) {
            const trimStart = this.wizardState.refine.trimStart || 1;
            const trimEnd = this.wizardState.refine.trimEnd || totalRowCount;
            const trimmedFromStart = Math.max(0, trimStart - 1);
            const trimmedFromEnd = Math.max(0, totalRowCount - trimEnd);
            const totalTrimmed = trimmedFromStart + trimmedFromEnd;
            if (totalTrimmed > 0) {
                const rowsAfterTrim = totalRowCount - totalTrimmed;
                rowCountDisplay = `${rowsAfterTrim.toLocaleString()} rows`;
                modifications.push(`${totalTrimmed.toLocaleString()} trimmed`);
            }
        }

        // Indicate resampling will affect count
        if (this.wizardState.refine.enableResample) {
            modifications.push('resampled');
        }

        if (modifications.length > 0) {
            rowCountDisplay += ` (${modifications.join(', ')})`;
        }
        const rowsCard = document.createElement('div');
        rowsCard.className = 'data-page__save-card';
        rowsCard.innerHTML = `
            <div class="data-page__save-card-icon"><span class="material-symbols-outlined">table_rows</span></div>
            <div class="data-page__save-card-content">
                <div class="data-page__save-card-label">Data Rows</div>
                <div class="data-page__save-card-value">${rowCountDisplay}</div>
            </div>
        `;
        summaryPane.appendChild(rowsCard);

        // Refinements card
        const refinements = [];
        if (this.wizardState.refine.enableTrim) refinements.push('Trimmed');
        if (this.wizardState.refine.enableMissing) refinements.push('Missing data handled');
        if (this.wizardState.refine.enableResample) refinements.push('Resampled');
        const refineCard = document.createElement('div');
        refineCard.className = 'data-page__save-card';
        refineCard.innerHTML = `
            <div class="data-page__save-card-icon"><span class="material-symbols-outlined">tune</span></div>
            <div class="data-page__save-card-content">
                <div class="data-page__save-card-label">Refinements</div>
                <div class="data-page__save-card-value">${refinements.length > 0 ? refinements.join(', ') : 'None'}</div>
            </div>
        `;
        summaryPane.appendChild(refineCard);

        container.appendChild(summaryPane);

        // === RIGHT: Save Options ===
        const optionsPane = document.createElement('div');
        optionsPane.className = 'data-page__save-options';

        const optionsTitle = document.createElement('h3');
        optionsTitle.className = 'data-page__save-section-title';
        optionsTitle.textContent = 'Save Location';
        optionsPane.appendChild(optionsTitle);

        const form = document.createElement('form');
        form.className = 'data-page__wizard-form';
        form.addEventListener('submit', (event) => event.preventDefault());

        // Filter out scenario datasets and add "Create new" option
        const userDatasets = this.datasets.filter((d) => d.id !== 'scenarios-dataset' && !d.isScenario);
        const datasetOptions = [
            { value: '__new__', label: '+ Create new dataset…' },
            ...userDatasets.map((dataset) => ({ value: dataset.id, label: dataset.name })),
        ];

        // If no target set yet, default to first user dataset or __new__
        if (!this.wizardState.targetDatasetId || this.wizardState.targetDatasetId === 'scenarios-dataset') {
            this.wizardState.targetDatasetId = userDatasets[0]?.id || '__new__';
        }

        const datasetSelect = this.#createSelectField('Target dataset', 'targetDataset', datasetOptions, this.wizardState.targetDatasetId, (value) => {
            this.wizardState.targetDatasetId = value;
            this.#renderWizard(); // Re-render to show/hide new dataset name field
        });
        form.appendChild(datasetSelect);

        // Show new dataset name field when "Create new" is selected
        if (this.wizardState.targetDatasetId === '__new__') {
            form.appendChild(this.#createTextField('New dataset name', this.wizardState.newDatasetName || '', (value) => {
                this.wizardState.newDatasetName = value;
                this.#updateWizardButtonState();
            }));
        }

        // Default series name from file name
        if (!this.wizardState.seriesName && this.wizardState.fileName) {
            this.wizardState.seriesName = this.wizardState.fileName.replace(/\.[^.]+$/, '');
        }

        form.appendChild(this.#createTextField('Series name', this.wizardState.seriesName, (value) => {
            this.wizardState.seriesName = value;
            this.#updateWizardButtonState();
        }));

        const hint = document.createElement('p');
        hint.className = 'data-page__wizard-hint';
        hint.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">info</span> The data will be saved as a time series that can be used as a data source in your models.';
        form.appendChild(hint);

        optionsPane.appendChild(form);
        container.appendChild(optionsPane);

        return container;
    }

    async #handleWizardFileSelected(file) {
        this.wizardState.file = file;
        this.wizardState.fileName = file.name;
        this.wizardState.preview = { headers: [], rows: [] };
        this.wizardState.refinePreview = null;
        this.wizardState.timeColumns = [];
        this.wizardState.selectedDataColumns = [];
        this.wizardState.columnsTouched = false;
        this.wizardState.timeMode = 'explicit';
        this.wizardState.timeFormat = 'auto';
        this.wizardState.integerColumnIndex = null;
        try {
            const base64 = await this.#readFileAsBase64(file);
            this.wizardState.csvBase64 = base64;
            this.#renderWizard();
            await this.#requestCsvPreview();
            this.#setWizardStep(1);
        } catch (error) {
            this.#reportError('Failed to read file', error);
        }
    }

    async #requestCsvPreview() {
        if (!this.#ensureDataHubReady({ silent: true }) || !this.wizardState.csvBase64) {
            return;
        }
        try {
            const response = await this.dataHub.requestCsvPreview({
                csv: {
                    content_b64: this.wizardState.csvBase64,
                    encoding: this.wizardState.encoding,
                    sep: this.#getSeparatorValue(),
                    header: this.wizardState.hasHeader,
                },
                limit: 100,
            });
            if (!response || !Array.isArray(response.rows)) {
                throw new Error(response?.error || 'CSV preview failed');
            }
            this.wizardState.preview = {
                headers: Array.isArray(response.headers) ? response.headers : [],
                rows: response.rows,
                totalCount: response.totalCount ?? response.rows.length,
            };
            this.wizardState.columnsTouched = false;
            this.#ensureColumnDefaults();
            this.#renderWizard();
        } catch (error) {
            this.#reportError('CSV preview failed', error);
        }
    }

    /**
     * Compute the effective time mode based on configured mode and actual data.
     * If configured as 'explicit' but no valid datetime timestamps found, returns 'relative'.
     * @returns {'explicit'|'integer'|'relative'} Effective time mode for backend
     */
    #getEffectiveTimeMode() {
        const configuredMode = this.wizardState.timeMode;
        if (configuredMode !== 'explicit') {
            return configuredMode;
        }
        // Check if we have valid datetime timestamps
        const parsedTimes = this.wizardState.parsedTimePreview;
        const hasValidDatetimes = parsedTimes && parsedTimes.some(p => p && !p.error && p.timestamp);
        // Use explicit only if we have valid timestamps, otherwise fall back to relative (numeric)
        return hasValidDatetimes ? 'explicit' : 'relative';
    }

    async #requestRefinePreview() {
        if (!this.#ensureDataHubReady({ silent: true }) || !this.wizardState.csvBase64) {
            return;
        }
        const dataColumns = this.#getSelectedDataColumns();
        if (!dataColumns.length) {
            // Silently skip - no columns selected yet
            return;
        }

        // Track this request with an ID to ignore stale responses
        const requestId = ++this._refinePreviewRequestId;

        // Show loading indicator
        this._refinePreviewLoading = true;
        this.#updatePreviewLoadingState();

        try {
            // Convert 1-based UI indices to 0-based backend indices for trimming
            const refinePayload = { ...this.wizardState.refine };
            if (refinePayload.enableTrim) {
                refinePayload.trimStart = Math.max(0, (refinePayload.trimStart || 1) - 1);
                refinePayload.trimEnd = Math.max(0, (refinePayload.trimEnd || 1) - 1);
            }
            // Use effective time mode: if configured as 'explicit' but no valid datetimes, use 'relative'
            const effectiveTimeMode = this.#getEffectiveTimeMode();
            // Always send time_columns if selected - backend uses them for numeric time values too
            const response = await this.dataHub.requestRefinePreview({
                csv: {
                    content_b64: this.wizardState.csvBase64,
                    encoding: this.wizardState.encoding,
                    sep: this.#getSeparatorValue(),
                    header: this.wizardState.hasHeader,
                },
                time_mode: effectiveTimeMode,
                time_format: this.wizardState.timeFormat,
                integer_col_index: effectiveTimeMode === 'integer' ? this.wizardState.integerColumnIndex : null,
                time_columns: this.wizardState.timeColumns || [],
                other_columns: dataColumns,
                headers: this.#buildSelectionHeaders(),
                refine: refinePayload,
            });

            // Ignore stale response if a newer request was made
            if (requestId !== this._refinePreviewRequestId) {
                return;
            }

            if (!response || !Array.isArray(response.rows)) {
                throw new Error(response?.error || 'Refine preview failed');
            }
            this.wizardState.refinePreview = {
                headers: Array.isArray(response.headers) && response.headers.length ? response.headers : this.#buildSelectionHeaders(),
                rows: response.rows,
            };
            this._refinePreviewLoading = false;
            this.#renderWizard();
        } catch (error) {
            // Ignore errors from stale requests
            if (requestId !== this._refinePreviewRequestId) {
                return;
            }
            // Log and show error to user
            this._refinePreviewLoading = false;
            this.#updatePreviewLoadingState();
            this.logger?.warn?.('data-page', 'Refine preview failed', { error });
        }
    }

    #updatePreviewLoadingState() {
        // Update loading indicator on preview pane without full re-render
        const previewPane = this.wizardContainerEl?.querySelector('.data-page__wizard-preview');
        if (!previewPane) return;

        const existingIndicator = previewPane.querySelector('.data-page__preview-loading');
        if (this._refinePreviewLoading) {
            if (!existingIndicator) {
                const indicator = document.createElement('div');
                indicator.className = 'data-page__preview-loading';
                indicator.textContent = 'Updating preview...';
                previewPane.insertBefore(indicator, previewPane.firstChild?.nextSibling);
            }
        } else if (existingIndicator) {
            existingIndicator.remove();
        }
    }

    async #saveImport() {
        if (!this.#ensureDataHubReady()) {
            return;
        }
        
        // Handle "create new dataset" option
        let targetDatasetId = this.wizardState.targetDatasetId;
        if (targetDatasetId === '__new__') {
            const newName = (this.wizardState.newDatasetName || '').trim();
            if (!newName) {
                this.#notify('Import incomplete', 'Enter a name for the new dataset.', 'warning');
                return;
            }
            // Create new dataset first
            try {
                const actionsHost = this.dataHub?.hostBridge;
                if (!actionsHost?.create_dataset) {
                    this.#notify('Error', 'Cannot create dataset - API not available.', 'error');
                    return;
                }
                const createRes = await actionsHost.create_dataset(newName);
                if (!createRes?.ok) {
                    throw new Error(createRes?.error || 'Failed to create dataset');
                }
                targetDatasetId = createRes.id;
            } catch (err) {
                this.#reportError('Failed to create dataset', err);
                return;
            }
        }
        
        if (!targetDatasetId || !this.wizardState.seriesName) {
            this.#notify('Import incomplete', 'Select a dataset and provide a series name.', 'warning');
            return;
        }
        if (!this.wizardState.csvBase64) {
            this.#notify('Missing source', 'Choose a CSV file to import.', 'warning');
            return;
        }
        const dataColumns = this.#getSelectedDataColumns();
        if (!dataColumns.length) {
            this.#notify('Select data columns', 'Choose at least one data column before saving.', 'warning');
            return;
        }
        this.wizardState.saving = true;
        this.#renderWizard();
        try {
            // Convert 1-based UI indices to 0-based backend indices for trimming
            const refinePayload = { ...this.wizardState.refine };
            if (refinePayload.enableTrim) {
                refinePayload.trimStart = Math.max(0, (refinePayload.trimStart || 1) - 1);
                refinePayload.trimEnd = Math.max(0, (refinePayload.trimEnd || 1) - 1);
            }
            // Use effective time mode: if configured as 'explicit' but no valid datetimes, use 'relative'
            const effectiveTimeMode = this.#getEffectiveTimeMode();
            const payload = {
                csv: {
                    content_b64: this.wizardState.csvBase64,
                    encoding: this.wizardState.encoding,
                    sep: this.#getSeparatorValue(),
                    header: this.wizardState.hasHeader,
                },
                time_mode: effectiveTimeMode,
                time_format: this.wizardState.timeFormat,
                integer_col_index: effectiveTimeMode === 'integer' ? this.wizardState.integerColumnIndex : null,
                time_columns: this.wizardState.timeColumns || [],
                other_columns: dataColumns,
                headers: this.#buildSelectionHeaders(),
                refine: refinePayload,
                save: {
                    datasetId: targetDatasetId,
                    seriesName: this.wizardState.seriesName,
                },
            };
            const response = await this.dataHub.saveSeries(payload);
            if (!response?.ok) {
                const errorMsg = response?.error || 'Failed to save dataset';
                // Handle duplicate series name error with user-friendly message
                if (errorMsg.includes('UNIQUE constraint') && errorMsg.includes('series')) {
                    this.#notify('Duplicate series name', `A series named "${this.wizardState.seriesName}" already exists in this dataset. Please choose a different name.`, 'warning');
                    return;
                }
                throw new Error(errorMsg);
            }
            this.#notify('Import complete', 'Dataset imported successfully.', 'success');
            this.#emitViewEvent(VIEW_EVENTS.IMPORT_SAVED, {
                datasetId: response.datasetId,
                seriesId: response.seriesId,
            });
            await this.refreshDatasets({ silent: true, force: true });
            this.#closeImportWizard();
            // Auto-display the newly saved series
            if (response.datasetId && response.seriesId) {
                this.selectedDatasetId = response.datasetId;
                this.#loadSeriesPreview(response.seriesId, { refresh: true });
            }
        } catch (error) {
            this.#reportError('Import failed', error);
        } finally {
            this.wizardState.saving = false;
            this.#renderWizard();
        }
    }

    #createWizardState(overrides = {}) {
        const base = cloneJson(DEFAULT_WIZARD_STATE);
        const state = {
            ...base,
            ...overrides,
        };
        state.refine = {
            ...cloneJson(DEFAULT_WIZARD_STATE.refine),
            ...(overrides.refine || {}),
        };
        state.preview = overrides.preview ? cloneJson(overrides.preview) : { headers: [], rows: [] };
        state.timeColumns = Array.isArray(state.timeColumns) ? [...state.timeColumns] : [];
        state.selectedDataColumns = Array.isArray(state.selectedDataColumns) ? [...state.selectedDataColumns] : [];
        state.columnsTouched = Boolean(state.columnsTouched);
        return state;
    }

    #createButton(label, variant = 'secondary') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `data-page__button data-page__button--${variant}`;
        button.textContent = label;
        return button;
    }

    #createIconButton(icon, title = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'data-page__icon-button';
        button.title = title;
        const iconEl = document.createElement('span');
        iconEl.className = 'material-symbols-outlined';
        iconEl.textContent = icon;
        button.appendChild(iconEl);
        return button;
    }

    #normalizeDatasets(datasets) {
        const filtered = datasets.filter((d) => {
            if (!d) return false;
            const name = String(d.name || '').trim().toLowerCase();
            if (name === 'scenarios' && d.id === '__scenarios__') return false;
            return true;
        });
        const sorted = filtered.slice().sort((a, b) => {
            const aTime = a?.meta?.runAt || a?.meta?.createdAt || a?.createdAt || 0;
            const bTime = b?.meta?.runAt || b?.meta?.createdAt || b?.createdAt || 0;
            return bTime - aTime;
        });
        return sorted.map((d) => ({
            ...d,
            series: Array.isArray(d.series) ? d.series : [],
        }));
    }

    async #createDataset() {
        const host = this.dataHub?.hostBridge;
        if (!host || typeof host.create_dataset !== 'function') {
            this.#reportError('Host bridge cannot create datasets');
            return;
        }
        try {
            const res = await host.create_dataset();
            if (res?.ok) {
                await this.refreshDatasets({ force: true });
                if (res.id) {
                    this.selectedDatasetId = res.id;
                }
                this.#renderDatasetList();
            }
        } catch (error) {
            this.#reportError('Failed to create dataset', error);
        }
    }

    #createSelectField(label, name, options, value, onChange) {
        const wrapper = document.createElement('label');
        wrapper.className = 'data-page__field';
        wrapper.textContent = label;
        const select = document.createElement('select');
        select.name = name;
        options.forEach((option) => {
            const opt = document.createElement('option');
            const optionValue = typeof option === 'string' ? option : option.value;
            const optionLabel = typeof option === 'string' ? option : option.label;
            opt.value = optionValue;
            opt.textContent = optionLabel;
            if (optionValue === value) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
        select.addEventListener('change', (event) => onChange(event.target.value));
        wrapper.appendChild(select);
        return wrapper;
    }

    #createCheckboxField(label, checked, onChange) {
        const wrapper = document.createElement('label');
        wrapper.className = 'data-page__field data-page__field--checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.addEventListener('change', (event) => onChange(event.target.checked));
        wrapper.appendChild(input);
        const text = document.createElement('span');
        text.textContent = label;
        wrapper.appendChild(text);
        return wrapper;
    }

    #createNumberField(label, value, onChange, { min = null, max = null, getMin = null, getMax = null } = {}) {
        const wrapper = document.createElement('label');
        wrapper.className = 'data-page__field';
        wrapper.textContent = label;

        const input = document.createElement('input');
        input.type = 'number';
        input.value = value;

        const validateAndApply = () => {
            const rawValue = Number(input.value);
            // Get dynamic min/max if provided, otherwise use static values
            const effectiveMin = getMin ? getMin() : min;
            const effectiveMax = getMax ? getMax() : max;

            let clampedValue = rawValue;

            if (effectiveMin !== null && rawValue < effectiveMin) {
                clampedValue = effectiveMin;
                this.#notify('Invalid value', `${label} must be at least ${effectiveMin.toLocaleString()}`, 'warning');
                input.value = clampedValue;
            } else if (effectiveMax !== null && rawValue > effectiveMax) {
                clampedValue = effectiveMax;
                this.#notify('Invalid value', `${label} must be at most ${effectiveMax.toLocaleString()}`, 'warning');
                input.value = clampedValue;
            }

            onChange(clampedValue);
        };

        // Trigger onChange on blur or Enter key, not on every keystroke
        input.addEventListener('blur', validateAndApply);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                validateAndApply();
                input.blur();
            }
        });

        wrapper.appendChild(input);
        return wrapper;
    }

    #createTextField(label, value, onChange, { placeholder = '' } = {}) {
        const wrapper = document.createElement('label');
        wrapper.className = 'data-page__field';
        wrapper.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        if (placeholder) {
            input.placeholder = placeholder;
        }
        input.addEventListener('input', (event) => onChange(event.target.value));
        wrapper.appendChild(input);
        return wrapper;
    }

    // Config-style helpers (matching panel-right styling)
    #createConfigRow(label, inputElement) {
        const row = document.createElement('div');
        row.className = 'config-row';
        const labelEl = document.createElement('label');
        labelEl.className = 'config-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        row.appendChild(inputElement);
        return row;
    }

    #createConfigSelect(options, value, onChange) {
        const select = document.createElement('select');
        select.className = 'config-input';
        options.forEach((option) => {
            const opt = document.createElement('option');
            const optionValue = typeof option === 'string' ? option : option.value;
            const optionLabel = typeof option === 'string' ? option : option.label;
            opt.value = optionValue;
            opt.textContent = optionLabel;
            if (optionValue === value) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
        select.addEventListener('change', (event) => onChange(event.target.value));
        return select;
    }

    #createConfigCheckbox(checked, onChange) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'config-checkbox';
        input.checked = checked;
        input.addEventListener('change', (event) => onChange(event.target.checked));
        return input;
    }

    #buildSimpleTable(headers = [], rows = []) {
        // Normalize rows - handle both array and object formats
        const normalizedRows = rows.map(row => {
            if (Array.isArray(row)) {
                return row;
            }
            if (row && typeof row === 'object') {
                const cells = [];
                if (Object.prototype.hasOwnProperty.call(row, 'tDisp')) {
                    cells.push(row.tDisp);
                } else if (Object.prototype.hasOwnProperty.call(row, 'time')) {
                    cells.push(row.time);
                }
                if (Array.isArray(row.cols)) {
                    cells.push(...row.cols);
                }
                return cells;
            }
            return [];
        });

        // Strip prefixes from headers for display
        const displayHeaders = headers.map(h => stripHeaderPrefix(h));

        // Create container for DataTable
        const container = document.createElement('div');
        container.style.cssText = 'height: 100%; min-height: 200px;';

        // Create DataTable with wizard-specific options
        const dataTable = new DataTable(container, {
            headers: displayHeaders,
            rows: normalizedRows,
            pagination: false,
            selectable: false,
            copyable: false,
            readonly: true,
            emptyMessage: 'No preview data available',
            formatValue: (value, colIdx) => this.#formatValue(value),
            getHeaderIcon: (header, colIdx) => {
                const originalHeader = headers[colIdx];
                const kind = getHeaderKind(originalHeader);
                return { icon: getIconForKind(kind), title: kind };
            },
        });
        dataTable.render();

        return container;
    }

    #getSeparatorValue() {
        return this.wizardState.separator || ',';
    }

    /**
     * Validate datetime parsing for the selected time columns.
     * Calls the backend to parse datetime values and stores results.
     */
    async #validateDatetimeParsing() {
        // Only validate in explicit datetime mode
        if (this.wizardState.timeMode !== 'explicit') {
            this.wizardState.datetimeParseError = null;
            this.wizardState.parsedTimePreview = null;
            return;
        }

        // Need CSV data and time columns
        if (!this.wizardState.csvBase64 || !this.wizardState.timeColumns?.length) {
            return;
        }

        if (!this.#ensureDataHubReady({ silent: true })) {
            return;
        }

        try {
            // Use all non-time columns as data columns for validation
            const headers = this.#getPreviewHeaders();
            const dataColumns = headers
                .map((_, idx) => idx)
                .filter((idx) => !this.wizardState.timeColumns.includes(idx));

            const response = await this.dataHub.requestRefinePreview({
                csv: {
                    content_b64: this.wizardState.csvBase64,
                    encoding: this.wizardState.encoding,
                    sep: this.#getSeparatorValue(),
                    header: this.wizardState.hasHeader,
                },
                time_mode: 'explicit',
                time_format: this.wizardState.timeFormat,
                time_columns: this.wizardState.timeColumns,
                other_columns: dataColumns,
                headers: this.#buildSelectionHeaders(),
                refine: {
                    enableTrim: false,
                    enableMissing: false,
                    enableResample: false,
                },
            });

            if (!response || !Array.isArray(response.rows)) {
                throw new Error(response?.error || 'Datetime validation failed');
            }

            // Check for parse errors (null time values)
            const parsedTimes = [];
            let errorCount = 0;
            for (const row of response.rows) {
                const tRaw = row.tRaw ?? row.time;
                if (tRaw == null || tRaw === '') {
                    errorCount++;
                    parsedTimes.push({ error: true, value: null });
                } else {
                    parsedTimes.push({ error: false, value: tRaw });
                }
            }

            this.wizardState.parsedTimePreview = parsedTimes;

            if (errorCount > 0) {
                const totalRows = response.rows.length;
                this.wizardState.datetimeParseError = `Failed to parse ${errorCount} of ${totalRows} datetime values`;
            } else {
                this.wizardState.datetimeParseError = null;
            }

            this.#renderWizard();
        } catch (error) {
            this.wizardState.datetimeParseError = `Datetime parsing error: ${error.message || error}`;
            this.wizardState.parsedTimePreview = null;
            this.#renderWizard();
        }
    }

    #buildColumnMappingContent() {
        const container = document.createElement('div');
        container.className = 'data-page__column-config';
        const headers = this.#getPreviewHeaders();
        if (!headers.length) {
            const hint = document.createElement('p');
            hint.className = 'data-page__wizard-hint';
            hint.textContent = 'Generate a preview before configuring column mappings.';
            container.appendChild(hint);
            return container;
        }
        this.#ensureColumnDefaults();
        const modeOptions = [
            { value: 'explicit', label: 'Datetime columns' },
            { value: 'integer', label: 'Integer column (steps)' },
            { value: 'relative', label: 'Row index (no time column)' },
        ];
        const timeModeField = this.#createSelectField('Time index', 'time-mode', modeOptions, this.wizardState.timeMode, (value) => {
            this.#handleTimeModeChanged(value);
        });
        container.appendChild(timeModeField);

        if (this.wizardState.timeMode === 'explicit') {
            container.appendChild(this.#createTextField(
                'Time format',
                this.wizardState.timeFormat === 'auto' ? '' : this.wizardState.timeFormat,
                (value) => {
                    const trimmed = (value || '').trim();
                    this.wizardState.timeFormat = trimmed || 'auto';
                    // Trigger datetime validation when format changes
                    this.#validateDatetimeParsing();
                },
                { placeholder: 'auto (default)' },
            ));

            // Show datetime parse error if any
            if (this.wizardState.datetimeParseError) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'data-page__datetime-error';
                errorDiv.innerHTML = `<span class="material-symbols-outlined">error</span> ${this.wizardState.datetimeParseError}`;
                container.appendChild(errorDiv);
            }
        }

        container.appendChild(this.#buildColumnMappingTable(headers));
        return container;
    }

    #buildColumnMappingTable(headers) {
        const wrapper = document.createElement('div');
        wrapper.className = 'data-page__column-table-wrapper';
        const table = document.createElement('table');
        table.className = 'data-page__column-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Column', 'Time', 'Data'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const dataSelection = new Set(this.#getSelectedDataColumns());
        headers.forEach((header, index) => {
            const row = document.createElement('tr');

            const labelCell = document.createElement('td');
            labelCell.textContent = `${index + 1}. ${header}`;
            row.appendChild(labelCell);

            const timeCell = document.createElement('td');
            if (this.wizardState.timeMode === 'explicit') {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = this.wizardState.timeColumns.includes(index);
                checkbox.addEventListener('change', (event) => {
                    this.#toggleTimeColumn(index, event.target.checked);
                    this.#renderWizard();
                });
                timeCell.appendChild(checkbox);
            } else if (this.wizardState.timeMode === 'integer') {
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'data-page-integer-column';
                radio.checked = this.wizardState.integerColumnIndex === index;
                radio.addEventListener('change', () => {
                    this.#handleIntegerColumnSelected(index);
                    this.#renderWizard();
                });
                timeCell.appendChild(radio);
            } else {
                timeCell.textContent = index === 0 ? 'Row index' : '—';
            }
            row.appendChild(timeCell);

            const dataCell = document.createElement('td');
            const dataCheckbox = document.createElement('input');
            dataCheckbox.type = 'checkbox';
            dataCheckbox.checked = dataSelection.has(index);
            dataCheckbox.disabled = this.#isIndexUsedForTime(index);
            dataCheckbox.addEventListener('change', (event) => {
                this.#toggleDataColumn(index, event.target.checked);
                this.#renderWizard();
            });
            dataCell.appendChild(dataCheckbox);
            row.appendChild(dataCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    #getPreviewHeaders() {
        const previewHeaders = this.wizardState.preview?.headers;
        if (Array.isArray(previewHeaders) && previewHeaders.length) {
            return previewHeaders.map((header, index) => {
                const text = typeof header === 'string' ? header.trim() : '';
                return text || `Column ${index + 1}`;
            });
        }
        const sampleRow = this.wizardState.preview?.rows?.[0];
        if (Array.isArray(sampleRow)) {
            return sampleRow.map((_, index) => `Column ${index + 1}`);
        }
        return [];
    }

    #ensureColumnDefaults() {
        const headers = this.#getPreviewHeaders();
        if (!headers.length) {
            return;
        }

        if (this.wizardState.timeMode === 'integer') {
            if (!Number.isInteger(this.wizardState.integerColumnIndex) || this.wizardState.integerColumnIndex >= headers.length) {
                this.wizardState.integerColumnIndex = 0;
            }
        } else {
            this.wizardState.integerColumnIndex = null;
        }

        if (this.wizardState.timeMode === 'explicit') {
            const sanitized = Array.isArray(this.wizardState.timeColumns)
                ? this.wizardState.timeColumns.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < headers.length)
                : [];
            this.wizardState.timeColumns = sanitized.length ? sanitized : [0];
        } else {
            this.wizardState.timeColumns = [];
        }

        const rawSelection = Array.isArray(this.wizardState.selectedDataColumns)
            ? this.wizardState.selectedDataColumns.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < headers.length && !this.#isIndexUsedForTime(idx))
            : [];
        if (rawSelection.length) {
            this.wizardState.selectedDataColumns = rawSelection;
            return;
        }
        if (!this.wizardState.columnsTouched) {
            const fallback = headers.map((_, idx) => idx).filter((idx) => !this.#isIndexUsedForTime(idx));
            this.wizardState.selectedDataColumns = fallback;
        } else {
            this.wizardState.selectedDataColumns = rawSelection;
        }
    }

    #handleTimeModeChanged(mode) {
        if (!TIME_MODE_OPTIONS.includes(mode) || this.wizardState.timeMode === mode) {
            return;
        }
        this.wizardState.timeMode = mode;
        this.wizardState.columnsTouched = false;
        // Clear any previous datetime validation
        this.wizardState.datetimeParseError = null;
        this.wizardState.parsedTimePreview = null;
        this.#ensureColumnDefaults();
        this.#renderWizard();
        // Trigger datetime validation if in explicit mode
        if (mode === 'explicit') {
            this.#validateDatetimeParsing();
        }
    }

    #toggleTimeColumn(index, enabled) {
        if (!Number.isInteger(index) || index < 0) {
            return;
        }
        const headers = this.#getPreviewHeaders();
        const set = new Set(this.wizardState.timeColumns || []);
        if (enabled) {
            set.add(index);
        } else {
            set.delete(index);
        }
        let next = Array.from(set).filter((idx) => idx >= 0 && idx < headers.length);
        if (!next.length && headers.length) {
            next = [Math.min(index, headers.length - 1)];
        }
        this.wizardState.timeColumns = next.sort((a, b) => a - b);
        this.wizardState.selectedDataColumns = (this.wizardState.selectedDataColumns || []).filter((idx) => !this.wizardState.timeColumns.includes(idx));
        this.wizardState.columnsTouched = true;
        // Trigger datetime validation
        this.#validateDatetimeParsing();
    }

    #handleIntegerColumnSelected(index) {
        if (!Number.isInteger(index) || index < 0) {
            return;
        }
        this.wizardState.integerColumnIndex = index;
        this.wizardState.selectedDataColumns = (this.wizardState.selectedDataColumns || []).filter((idx) => idx !== index);
        this.wizardState.columnsTouched = true;
    }

    #toggleDataColumn(index, enabled) {
        if (!Number.isInteger(index) || index < 0) {
            return;
        }
        const set = new Set(this.wizardState.selectedDataColumns || []);
        if (enabled) {
            set.add(index);
        } else {
            set.delete(index);
        }
        this.wizardState.selectedDataColumns = Array.from(set)
            .filter((idx) => Number.isInteger(idx) && idx >= 0 && !this.#isIndexUsedForTime(idx))
            .sort((a, b) => a - b);
        this.wizardState.columnsTouched = true;
    }

    #isIndexUsedForTime(index) {
        if (this.wizardState.timeMode === 'explicit') {
            return (this.wizardState.timeColumns || []).includes(index);
        }
        if (this.wizardState.timeMode === 'integer') {
            return this.wizardState.integerColumnIndex === index;
        }
        return false;
    }

    #getSelectedDataColumns() {
        this.#ensureColumnDefaults();
        const raw = Array.isArray(this.wizardState.selectedDataColumns) ? this.wizardState.selectedDataColumns : [];
        return raw.filter((idx) => Number.isInteger(idx) && idx >= 0 && !this.#isIndexUsedForTime(idx)).sort((a, b) => a - b);
    }

    #buildSelectionHeaders() {
        const headers = this.#getPreviewHeaders();
        const dataColumns = this.#getSelectedDataColumns();
        const result = ['time'];
        dataColumns.forEach((idx) => {
            const label = headers[idx] || `Column ${idx + 1}`;
            result.push(label);
        });
        return result;
    }

    #computeTimeValueForRow(row, rowIndex) {
        const timeMode = this.wizardState.timeMode;
        if (timeMode === 'relative') {
            return rowIndex;
        }
        if (timeMode === 'integer') {
            const idx = this.wizardState.integerColumnIndex;
            if (idx != null && row[idx] != null) {
                return row[idx];
            }
            return rowIndex;
        }
        // explicit time columns - use parsed values if available
        if (timeMode === 'explicit') {
            const parsedTimes = this.wizardState.parsedTimePreview;
            if (parsedTimes && parsedTimes[rowIndex]) {
                const parsed = parsedTimes[rowIndex];
                if (parsed.error) {
                    // Show error indicator for unparseable datetime
                    return '⚠ Parse error';
                }
                return parsed.value;
            }
            // Fall back to raw value if no parsed preview
            const timeCols = this.wizardState.timeColumns || [];
            if (timeCols.length > 0) {
                const parts = timeCols.map((i) => row[i] ?? '').filter((s) => String(s).length > 0);
                return parts.join(' ') || rowIndex;
            }
        }
        return rowIndex;
    }

    /**
     * Detect the current step size from the data.
     * @returns {{detected: boolean, value: number, label: string}}
     */
    #detectCurrentStepSize() {
        const rows = this.wizardState.preview?.rows;
        if (!rows || rows.length < 2) {
            return { detected: false, value: 1, label: 'Unknown' };
        }

        const timeMode = this.wizardState.timeMode;

        if (timeMode === 'relative') {
            // Row index mode: step is always 1
            return { detected: true, value: 1, label: '1 (row index)' };
        }

        if (timeMode === 'integer') {
            // Integer column mode: detect step from column values
            const idx = this.wizardState.integerColumnIndex;
            if (idx == null) {
                return { detected: false, value: 1, label: 'Unknown' };
            }

            // Sample first few rows to detect step
            const values = [];
            for (let i = 0; i < Math.min(10, rows.length); i++) {
                const val = parseFloat(rows[i][idx]);
                if (!isNaN(val)) {
                    values.push(val);
                }
            }

            if (values.length < 2) {
                return { detected: false, value: 1, label: 'Unknown' };
            }

            // Calculate differences between consecutive values
            const diffs = [];
            for (let i = 1; i < values.length; i++) {
                diffs.push(Math.abs(values[i] - values[i - 1]));
            }

            // Use median difference as step size
            diffs.sort((a, b) => a - b);
            const medianStep = diffs[Math.floor(diffs.length / 2)] || 1;

            return {
                detected: true,
                value: medianStep,
                label: String(medianStep),
            };
        }

        if (timeMode === 'explicit') {
            // Datetime mode: try to detect from parsed values
            const parsedTimes = this.wizardState.parsedTimePreview;
            if (!parsedTimes || parsedTimes.length < 2) {
                // No parsed times - try to detect from raw column values as numbers
                return this.#detectStepFromTimeColumns(rows);
            }

            // Get first few valid parsed timestamps
            const timestamps = [];
            for (let i = 0; i < Math.min(10, parsedTimes.length); i++) {
                const p = parsedTimes[i];
                if (p && !p.error && p.timestamp) {
                    timestamps.push(p.timestamp);
                }
            }

            if (timestamps.length < 2) {
                // Not enough valid timestamps - try to detect as numeric steps
                return this.#detectStepFromTimeColumns(rows);
            }

            // Calculate differences in milliseconds
            const diffs = [];
            for (let i = 1; i < timestamps.length; i++) {
                diffs.push(Math.abs(timestamps[i] - timestamps[i - 1]));
            }

            diffs.sort((a, b) => a - b);
            const medianDiffMs = diffs[Math.floor(diffs.length / 2)] || 0;

            // Convert to human-readable frequency
            const SECOND = 1000;
            const MINUTE = 60 * SECOND;
            const HOUR = 60 * MINUTE;
            const DAY = 24 * HOUR;
            const WEEK = 7 * DAY;
            const MONTH = 30 * DAY;
            const QUARTER = 91 * DAY;
            const YEAR = 365 * DAY;

            let label = 'Unknown';
            let value = 1;

            if (medianDiffMs >= YEAR * 0.9) {
                label = `~${Math.round(medianDiffMs / YEAR)} year(s)`;
                value = Math.round(medianDiffMs / YEAR);
            } else if (medianDiffMs >= QUARTER * 0.9) {
                label = `~${Math.round(medianDiffMs / QUARTER)} quarter(s)`;
                value = Math.round(medianDiffMs / QUARTER);
            } else if (medianDiffMs >= MONTH * 0.9) {
                label = `~${Math.round(medianDiffMs / MONTH)} month(s)`;
                value = Math.round(medianDiffMs / MONTH);
            } else if (medianDiffMs >= WEEK * 0.9) {
                label = `~${Math.round(medianDiffMs / WEEK)} week(s)`;
                value = Math.round(medianDiffMs / WEEK);
            } else if (medianDiffMs >= DAY * 0.9) {
                label = `~${Math.round(medianDiffMs / DAY)} day(s)`;
                value = Math.round(medianDiffMs / DAY);
            } else if (medianDiffMs >= HOUR * 0.9) {
                label = `~${Math.round(medianDiffMs / HOUR)} hour(s)`;
                value = Math.round(medianDiffMs / HOUR);
            } else if (medianDiffMs >= MINUTE * 0.9) {
                label = `~${Math.round(medianDiffMs / MINUTE)} minute(s)`;
                value = Math.round(medianDiffMs / MINUTE);
            } else {
                label = `~${Math.round(medianDiffMs / SECOND)} second(s)`;
                value = Math.round(medianDiffMs / SECOND);
            }

            return { detected: true, value, label, ms: medianDiffMs };
        }

        return { detected: false, value: 1, label: 'Unknown', ms: 0 };
    }

    /**
     * Fallback detection: try to detect step size from time column values as numbers.
     * Used when datetime parsing fails or isn't available.
     * @param {Array} rows - Data rows
     * @returns {{detected: boolean, value: number, label: string, ms: number}}
     */
    #detectStepFromTimeColumns(rows) {
        // Try to detect from the first time column or integer column
        const timeColumns = this.wizardState.timeColumns || [];
        const integerCol = this.wizardState.integerColumnIndex;
        const colIdx = timeColumns[0] ?? integerCol ?? 0;

        if (colIdx == null || !rows || rows.length < 2) {
            return { detected: false, value: 1, label: 'Unknown', ms: 0 };
        }

        // Sample first few rows and try to parse as numbers
        const values = [];
        for (let i = 0; i < Math.min(10, rows.length); i++) {
            const val = parseFloat(rows[i][colIdx]);
            if (!isNaN(val)) {
                values.push(val);
            }
        }

        if (values.length < 2) {
            return { detected: false, value: 1, label: 'Unknown', ms: 0 };
        }

        // Calculate differences between consecutive values
        const diffs = [];
        for (let i = 1; i < values.length; i++) {
            diffs.push(Math.abs(values[i] - values[i - 1]));
        }

        // Use median difference as step size
        diffs.sort((a, b) => a - b);
        const medianStep = diffs[Math.floor(diffs.length / 2)] || 1;

        // Round for display to avoid floating point artifacts like 0.09999999999999998
        const displayValue = Math.round(medianStep * 1000000) / 1000000;

        return {
            detected: true,
            value: medianStep,
            label: `${displayValue} (numeric)`,
            ms: 0, // Not applicable for numeric mode
        };
    }

    /**
     * Convert a period unit and count to milliseconds.
     * @param {string} unit - Period unit (year, quarter, month, week, day, hour, minute, second)
     * @param {number} count - Number of periods
     * @returns {number} Duration in milliseconds
     */
    #periodToMs(unit, count) {
        const SECOND = 1000;
        const MINUTE = 60 * SECOND;
        const HOUR = 60 * MINUTE;
        const DAY = 24 * HOUR;
        const WEEK = 7 * DAY;
        const MONTH = 30 * DAY;
        const QUARTER = 91 * DAY;
        const YEAR = 365 * DAY;

        const unitMs = {
            second: SECOND,
            minute: MINUTE,
            hour: HOUR,
            day: DAY,
            week: WEEK,
            month: MONTH,
            quarter: QUARTER,
            year: YEAR,
        };

        return (unitMs[unit] || DAY) * (count || 1);
    }

    async #readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const arrayBuffer = reader.result;
                const bytes = new Uint8Array(arrayBuffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i += 1) {
                    binary += String.fromCharCode(bytes[i]);
                }
                resolve(btoa(binary));
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    #ensureDataHubReady({ silent = false } = {}) {
        if (!this.dataHub) {
            if (!silent) {
                this.#reportError('Data service unavailable', new Error('Data hub not attached'));
            } else {
                this.logger?.warn?.('data-page', 'Data hub missing');
            }
            return false;
        }
        if (typeof this.dataHub.hasHostBridge === 'function' && !this.dataHub.hasHostBridge()) {
            if (!silent) {
                this.#reportError('Data service offline', new Error('Host bridge not connected'));
            } else {
                // Silent probe at startup: the data-hub host bridge is expected
                // to be absent in EcoAgent, so don't toast — debug only.
                this.logger?.debug?.('data-page', 'Data hub host bridge not ready');
            }
            return false;
        }
        return true;
    }

    #getDatasetNameBySeries(seriesId) {
        if (!seriesId) {
            return null;
        }
        for (const dataset of this.datasets) {
            if (dataset.series?.some((series) => series.id === seriesId)) {
                return dataset.name;
            }
        }
        return null;
    }

    #getSeriesName(seriesId) {
        if (!seriesId) {
            return null;
        }
        for (const dataset of this.datasets) {
            const match = dataset.series?.find((series) => series.id === seriesId);
            if (match) {
                return match.name;
            }
        }
        return null;
    }

    #formatValue(value) {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value.toLocaleString() : String(value);
        }
        return String(value);
    }

    #setBusy(isBusy) {
        if (!this.rootEl) {
            return;
        }
        this.rootEl.classList.toggle('is-busy', Boolean(isBusy));
    }

    #toggleSeriesBusy(isBusy) {
        // Show/hide loading indicator in the content area
        const contentEl = this.rootEl?.querySelector('.data-series-view');
        if (!contentEl) {
            return;
        }
        
        // Remove existing loading indicator
        const existingLoader = contentEl.querySelector('.series-loading');
        if (existingLoader) {
            existingLoader.remove();
        }
        
        if (isBusy) {
            // Create and show loading indicator
            const loader = document.createElement('div');
            loader.className = 'series-loading';
            loader.innerHTML = '<div class="spinner"></div><span>Loading…</span>';
            
            // Hide other content while loading
            if (this.seriesHeaderEl) this.seriesHeaderEl.style.display = 'none';
            if (this.seriesSummaryEl) this.seriesSummaryEl.style.display = 'none';
            if (this.seriesPaginationEl) this.seriesPaginationEl.style.display = 'none';
            if (this.tableWrapperEl) this.tableWrapperEl.style.display = 'none';
            if (this.seriesEmptyEl) this.seriesEmptyEl.style.display = 'none';
            
            contentEl.appendChild(loader);
        }
        // When not busy, #renderSeriesPreview will handle showing the correct elements
    }

    #reportError(message, error) {
        this.logger?.error?.('data-page', message, { error });
        const detail = error?.message || error || 'Unknown error';
        this.notificationCenter?.show?.({
            title: 'Data',
            message: `${message}: ${detail}`,
            severity: 'error',
            namespace: 'data',
        });
    }

    #notify(title, message, severity = 'info') {
        this.notificationCenter?.show?.({
            title,
            message,
            severity,
            namespace: 'data',
        });
    }

    #emitViewEvent(eventName, payload = {}) {
        if (!this.eventBus) {
            return;
        }
        this.eventBus.emit(eventName, {
            page: 'data',
            namespaceId: this.activeNamespaceId,
            ...payload,
        });
    }
}

DataPage.VIEW_EVENTS = VIEW_EVENTS;
