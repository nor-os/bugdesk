/**
 * ScenarioFileEditor
 *
 * Dedicated editor for .scenario files. Renders a tabbed view similar to
 * ScenarioManagerPage rather than a cell-based notebook.
 *
 * Tabs:
 *   Settings       — name, description, solver, time, MC config
 *   Parameters     — namespace-tabbed overrides (static) or distributions (MC)
 *   Assumptions    — collapsible assumption group cards with sliders
 *   Documentation  — NotebookEditor with doc/plot/heading cells only
 *
 * Dashboard layout is stored inline in scenario data (dashboard.tiles)
 * and edited via the SimulationDashboardTab on the Simulation Run Page.
 *
 * Data format (structured JSON, NOT cell-based):
 *   {
 *     name, description, type,
 *     solver: { method, rtol, atol } | null,
 *     time: { t0, t1, dt } | null,
 *     monteCarlo: { runs, seed } | null,
 *     metadata: { authors: [], tags: [], notes: '' },
 *     overrides: { [namespace]: { parameters: {}, constants: {}, stocks: {} } },
 *     distributions: { [namespace]: { parameters: {}, constants: {}, stocks: {} } },
 *     assumptionGroups: [{ id, name, description, collapsed, items: [] }],
 *     documentationCells: [{ id, type, data }]
 *   }
 */

import { renderSettingsTab, renderParametersTab } from './scenario_param_renderer.js';
import { renderAssumptionsTab } from './scenario_assumption_renderer.js';
import { NotebookEditor } from './notebook_editor.js';
import { createDetailHeader } from '../ui/components/detail_header.js';
import { SlideOutPanel } from '../ui/components/slide_out_panel.js';

const TABS = [
    { id: 'settings',      label: 'Settings',       icon: 'dashboard_customize' },
    { id: 'parameters',    label: 'Parameters',     icon: 'tune' },
    { id: 'assumptions',   label: 'Assumptions',    icon: 'category' },
    { id: 'documentation', label: 'Documentation',  icon: 'description' },
];

/**
 * Default empty scenario data.
 */
export function defaultScenarioData() {
    return {
        name: '',
        description: '',
        type: 'static',
        solver: { method: 'RK45', rtol: 1e-3, atol: 1e-6 },
        time: { t0: 0, t1: 100, dt: 0.25 },
        monteCarlo: null,
        metadata: { authors: [], tags: [], notes: '' },
        overrides: {},
        distributions: {},
        assumptionGroups: [],
        documentationCells: [],
        includeModelOverview: true,
        dashboard: { tiles: [] },
        documentationLayout: null,
    };
}

export class ScenarioFileEditor {
    /** @type {HTMLElement} */
    #container = null;

    /** @type {object} Structured scenario data (mutable). */
    #data = null;

    /** @type {string} */
    #activeTab = 'settings';

    /** @type {HTMLElement} */
    #tabBarEl = null;

    /** @type {HTMLElement} */
    #tabContentEl = null;

    /** @type {HTMLElement} Inner container for tab content (cleared on tab switch). */
    #tabContentInner = null;

    /** @type {NotebookEditor|null} Documentation tab editor */
    #docEditor = null;

    /** @type {Function|null} */
    #onChangeCallback = null;

    /** @type {object|null} Symbol index reference for parameter discovery */
    #symbolIndex = null;

    /** @type {object|null} */
    #eventBus = null;

    /** @type {object|null} */
    #logger = null;

    /** @type {import('../data/project_model.js').ProjectModel|null} */
    #project = null;

    /** @type {SlideOutPanel|null} */
    #slideOutPanel = null;

    /** @type {Array|null} Cached ETL overlay sources. */
    #overlaySources = null;

    /** @type {object|null} Stored plot data for deferred push to doc editor. */
    #pendingPlotData = null;

    /** @type {object|null} Stored actuals for deferred push to doc editor. */
    #pendingActuals = null;

    constructor({ eventBus, logger } = {}) {
        this.#eventBus = eventBus ?? null;
        this.#logger = logger ?? null;
    }

    /**
     * Mount the scenario editor.
     * @param {HTMLElement} container
     * @param {{ data: object, onChange?: Function, symbolIndex?: object, project?: object }} props
     */
    async mount(container, { data, onChange, symbolIndex, project } = {}) {
        this.#container = container;
        this.#onChangeCallback = onChange ?? null;
        this.#symbolIndex = symbolIndex ?? null;
        this.#project = project ?? null;

        this.#data = { ...defaultScenarioData(), ...data };

        this.#render();
        this.#renderActiveTab();
    }

    /** Switch to a named tab programmatically (e.g. from a cell action). */
    switchToTab(tabId) {
        this.#switchTab(tabId);
    }

    /** Return current data for serialization. */
    getData() {
        this.#flushDocEditor();
        return { ...this.#data };
    }

    /** Update symbol index (call when model cells change). */
    setSymbolIndex(symbolIndex) {
        this.#symbolIndex = symbolIndex;
        this.#docEditor?.setSymbolIndex(symbolIndex);
        // If currently on parameters or assumptions tab, re-render
        if (this.#activeTab === 'parameters' || this.#activeTab === 'assumptions') {
            this.#renderActiveTab();
        }
    }

    get isDirty() { return false; /* managed by parent */ }

    /**
     * Push simulation results to documentation plot/loops cells.
     * Called by NotebookSimulationController after a run completes or on tab switch.
     * If the doc editor is not yet mounted (lazy), stores data for replay.
     * @param {object} plotData  — { series: Record<string, number[]>, time: number[] }
     */
    pushResults(plotData) {
        if (!plotData) return;
        this.#pendingPlotData = plotData;
        if (!this.#docEditor) return;
        this.#docEditor.setResults(plotData);
    }

    /**
     * Push actuals overlay data to documentation plot cells.
     * If the doc editor is not yet mounted, stores for replay.
     * @param {object} actuals — { seriesId: { years, values } }
     */
    pushActuals(actuals) {
        if (!actuals) return;
        this.#pendingActuals = actuals;
        if (!this.#docEditor) return;
        for (const cell of this.#docEditor.getCells()) {
            if (cell.type !== 'plot') continue;
            this.#docEditor.getCellRenderer(cell.id)?.setActuals?.(actuals);
        }
    }

    /** Return the inner doc editor (for result routing when documentation tab is active). */
    get docEditor() { return this.#docEditor; }

    /**
     * Add a cell with data to the documentation (works even when doc tab is inactive).
     * If the doc editor is live, delegates to it. Otherwise, appends directly to data.
     * @param {string} type  — cell type (e.g. 'plot')
     * @param {object} data  — cell data
     */
    async addDocCell(type, data) {
        if (this.#docEditor) {
            await this.#docEditor.addCellWithData(type, data);
        } else {
            const id = `cell-${Math.random().toString(36).slice(2, 10)}`;
            if (!this.#data.documentationCells) this.#data.documentationCells = [];
            this.#data.documentationCells.push({ id, type, data: { ...data } });
            this.#notifyChange();
        }
    }

    dispose() {
        this.#docEditor?.dispose();
        this.#docEditor = null;
        this.#slideOutPanel?.dispose();
        this.#slideOutPanel = null;
        this.#container = null;
    }

    // ─── Rendering ────────────────────────────────────────────────────────────

    #render() {
        this.#container.innerHTML = '';

        const root = document.createElement('div');
        root.className = 'editor-chrome';

        const inner = document.createElement('div');
        inner.className = 'nb-structured-editor';
        inner.style.flex = '1';
        inner.style.minHeight = '0';

        // Header row: name input + type pill
        inner.appendChild(this.#buildHeaderRow());

        // Tab bar
        this.#tabBarEl = document.createElement('div');
        this.#tabBarEl.className = 'nb-structured-editor__tabs';

        for (const tab of TABS) {
            const btn = document.createElement('button');
            btn.className = `nb-structured-editor__tab${tab.id === this.#activeTab ? ' active' : ''}`;
            btn.dataset.tab = tab.id;
            btn.innerHTML = `<span class="material-symbols-outlined">${tab.icon}</span> ${tab.label}`;
            btn.addEventListener('click', () => this.#switchTab(tab.id));
            this.#tabBarEl.appendChild(btn);
        }
        inner.appendChild(this.#tabBarEl);

        // Tab content
        this.#tabContentEl = document.createElement('div');
        this.#tabContentEl.className = 'nb-structured-editor__content';
        this.#tabContentEl.style.position = 'relative';
        this.#tabContentEl.style.overflow = 'hidden';
        inner.appendChild(this.#tabContentEl);

        // Inner container for tab content (cleared on tab switch without destroying slide-out)
        this.#tabContentInner = document.createElement('div');
        this.#tabContentInner.className = 'nb-structured-editor__content-inner';
        this.#tabContentInner.style.flex = '1';
        this.#tabContentInner.style.minHeight = '0';
        this.#tabContentInner.style.overflowY = 'auto';
        this.#tabContentEl.appendChild(this.#tabContentInner);

        // Slide-out config panel (overlays tab content)
        this.#slideOutPanel = new SlideOutPanel({ width: 700 });
        this.#slideOutPanel.mount(this.#tabContentEl);

        root.appendChild(inner);
        this.#container.appendChild(root);
    }

    #buildHeaderRow() {
        const isMC = (this.#data.monteCarlo?.runs ?? 0) > 0;

        return createDetailHeader({
            title: this.#data.name || 'Untitled Scenario',
            badges: [
                { text: isMC ? 'Monte Carlo' : 'Static', className: isMC ? 'detail-header__badge--mc' : '' },
            ],
            renameable: true,
            onRename: async (newName) => {
                this.#data.name = newName;
                this.#notifyChange();
                return { success: true, newValue: newName };
            },
        });
    }

    #switchTab(tabId) {
        if (tabId === this.#activeTab) return;

        // Flush doc editor before leaving documentation tab
        if (this.#activeTab === 'documentation') {
            this.#flushDocEditor();
        }

        this.#activeTab = tabId;

        // Update tab bar active state
        this.#tabBarEl.querySelectorAll('.nb-structured-editor__tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Refresh header pill + Parameters tab label based on MC mode
        const isMC = (this.#data.monteCarlo?.runs ?? 0) > 0;
        const pill = this.#container.querySelector('.config-type-pill');
        if (pill) {
            pill.className = `config-type-pill${isMC ? ' is-monte-carlo' : ''}`;
            pill.textContent = isMC ? 'Monte Carlo' : 'Static';
        }
        const paramsBtn = this.#tabBarEl.querySelector('[data-tab="parameters"]');
        if (paramsBtn) {
            paramsBtn.innerHTML = `<span class="material-symbols-outlined">tune</span> ${isMC ? 'Distributions' : 'Parameters'}`;
        }

        this.#renderActiveTab();
    }

    #renderActiveTab() {
        // Dispose doc editor before clearing
        if (this.#activeTab !== 'documentation') {
            this.#docEditor?.dispose();
            this.#docEditor = null;
            this.#slideOutPanel?.close();
        }
        this.#tabContentInner.innerHTML = '';

        const onChanged = () => this.#notifyChange();

        switch (this.#activeTab) {
            case 'settings':
                renderSettingsTab(this.#tabContentInner, this.#data, { onChanged });
                break;

            case 'parameters':
                renderParametersTab(this.#tabContentInner, this.#data, this.#getConfigurables(), { onChanged });
                break;

            case 'assumptions':
                renderAssumptionsTab(this.#tabContentInner, this.#data, this.#getConfigurables(), { onChanged });
                break;

            case 'documentation':
                this.#renderDocumentationTab();
                break;
        }
    }

    async #renderDocumentationTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'scenario-doc-editor-wrapper notebook-editor-container';
        this.#tabContentInner.appendChild(wrapper);

        this.#docEditor = new NotebookEditor({
            eventBus: this.#eventBus,
            logger: this.#logger,
            onCellSelected: (cellId, _cellType) => {
                this.#showConfigPanel(cellId);
            },
        });

        if (this.#symbolIndex) {
            this.#docEditor.setSymbolIndex(this.#symbolIndex);
        }

        const cells = this.#data.documentationCells || [];
        await this.#docEditor.mount(wrapper, {
            cells,
            fileType: 'scenario-docs',
            project: this.#project,
            getScenarioContext: () => ({ monteCarlo: this.#data.monteCarlo }),
            onChange: () => {
                this.#data.documentationCells = this.#docEditor.getCells();
                this.#notifyChange();
            },
        });

        // Replay stored simulation results into newly mounted doc cells
        if (this.#pendingPlotData) this.pushResults(this.#pendingPlotData);
        if (this.#pendingActuals) this.pushActuals(this.#pendingActuals);
    }

    #flushDocEditor() {
        if (this.#docEditor) {
            this.#data.documentationCells = this.#docEditor.getCells();
        }
    }

    // ─── Slide-out config panel (generic dispatch) ─────────────────────────

    #showConfigPanel(cellId) {
        const renderer = this.#docEditor?.getCellRenderer(cellId);
        const binding = renderer?.getConfigBinding?.();
        if (!binding?.renderConfig || !this.#slideOutPanel) {
            this.#slideOutPanel?.close();
            return;
        }

        this.#slideOutPanel.open(binding.title ?? 'Config', binding.icon ?? 'settings');

        const body = document.createElement('div');
        body.className = 'simrun-dashboard__param-body';
        body.spellcheck = false;
        this.#slideOutPanel.contentEl.appendChild(body);

        binding.renderConfig(body);
    }

    /**
     * Fetch available ETL overlay sources (cached for session).
     * @returns {Promise<Array<{etlKey:string, label:string, category:string}>>}
     */
    async #fetchOverlaySources() {
        if (this.#overlaySources) return this.#overlaySources;
        const api = window.pywebview?.api;
        if (!api?.etl_list_overlay_sources) return [];
        try {
            const result = await api.etl_list_overlay_sources();
            if (result?.ok) {
                this.#overlaySources = result.sources;
                return result.sources;
            }
        } catch { /* ignore */ }
        return [];
    }

    // ─── Parameter discovery ──────────────────────────────────────────────────

    /**
     * Build configurables map from symbol index.
     * @returns {{ [namespace]: { parameters: [], constants: [], stocks: [] } }}
     */
    #getConfigurables() {
        if (!this.#symbolIndex) return {};

        // Use getConfigurables() if available (Phase 2 enhancement)
        if (this.#symbolIndex.getConfigurables) {
            return this.#symbolIndex.getConfigurables();
        }

        // Fallback: build from raw symbols
        const symbols = this.#symbolIndex.symbols ?? [];
        const result = {};

        let currentNamespace = 'Global';
        for (const sym of symbols) {
            if (sym.kind === 'namespace') {
                currentNamespace = sym.name;
                continue;
            }

            const ns = sym.namespace || currentNamespace;
            if (!result[ns]) result[ns] = { parameters: [], constants: [], stocks: [] };

            if (sym.kind === 'parameter') {
                result[ns].parameters.push({
                    name: sym.name,
                    displayName: sym.displayName || sym.name,
                    defaultValue: sym.defaultValue ?? 0,
                    min: sym.min ?? null,
                    max: sym.max ?? null,
                    step: sym.step ?? null,
                });
            } else if (sym.kind === 'constant') {
                result[ns].constants.push({
                    name: sym.name,
                    displayName: sym.displayName || sym.name,
                    defaultValue: sym.defaultValue ?? 0,
                });
            } else if (sym.kind === 'stock') {
                result[ns].stocks.push({
                    name: sym.name,
                    displayName: sym.displayName || sym.name,
                    defaultValue: sym.defaultValue ?? 0,
                });
            }
        }

        return result;
    }

    // ─── Change notification ──────────────────────────────────────────────────

    #notifyChange() {
        this.#onChangeCallback?.();
    }
}
