/**
 * NotebookEditor
 *
 * Renders a notebook file (model.notebook or *.scenario) as an ordered list of
 * cells.  Handles:
 *   - Rendering all cell types via their CellRenderer classes
 *   - Adding new cells (toolbar or keyboard shortcut)
 *   - Removing cells
 *   - Drag-to-reorder cells
 *   - Marking the notebook dirty on any cell change
 *   - Focus management
 *   - Undo/redo for structural operations (add, delete, move)
 *
 * Does NOT know about file I/O — that is ProjectModel's job.
 *
 * Cell types:
 *   code              — EcoLang DSL (Monaco, multi-line, auto-height)
 *   documentation     — Markdown text (Monaco markdown mode)
 *   godley            — Interactive Godley table + DSL/doc tabs
 *   parameter         — Named parameter with value, range, MC distribution
 *   plot              — Inline chart/widget cell
 */

import { ComponentBase } from '../ui/base/component_base.js';
import { getEditorFactory } from './monaco_editor_factory.js';
// Monaco language services are registered globally in ecolang_monaco.js
// and query the symbol provider callback dynamically — no per-editor update needed.
import { NotebookUndoManager } from './notebook_undo_manager.js';
import { ManagedWindow } from '../ui/components/managed_window.js';
import { NotebookSearchBar } from './notebook_search.js';
import { getCellTheme } from './cells/cell_base.js';
import { CodeCell } from './cells/code_cell.js';
import { DocumentationCell } from './cells/documentation_cell.js';
import { ParameterCell } from './cells/parameter_cell.js';
import { GodleyCell } from './cells/godley_cell.js';
import { PlotCell } from './cells/plot_cell.js';
import { GeneratorCell } from './cells/generator_cell.js';
import { SmoothCell } from './cells/smooth_cell.js';
import { PidCell } from './cells/pid_cell.js';
import { ScheduleCell } from './cells/schedule_cell.js';
import { HeadingCell } from './cells/heading_cell.js';
import { DelayCell } from './cells/delay_cell.js';
import { LatchCell } from './cells/latch_cell.js';
import { ConditionalSwitchCell } from './cells/conditional_switch_cell.js';
import { TimeCell } from './cells/time_cell.js';
import { TocCell } from './cells/toc_cell.js';
import { DataTableCell } from './cells/data_table_cell.js';
import { AssumptionsCell } from './cells/assumptions_cell.js';
import { FigureRegisterCell } from './cells/figure_register_cell.js';
import { TableRegisterCell } from './cells/table_register_cell.js';
import { LiteratureCell } from './cells/literature_cell.js';
import { LoopsCell } from './cells/loops_cell.js';
import { SignalSourceCell } from './cells/signal_source_cell.js';
import { EventTimerCell } from './cells/event_timer_cell.js';
import { EventCounterCell } from './cells/event_counter_cell.js';
import { LinearRampCell } from './cells/linear_ramp_cell.js';
import { StatisticsCell } from './cells/statistics_cell.js';
import { StockViewerCell } from './cells/stock_viewer_cell.js';
import { ReferenceCell } from './cells/reference_cell.js';
import { StockCell } from './cells/stock_cell.js';
import { SourceSinkCell } from './cells/source_sink_cell.js';
import { TitlePageCell } from './cells/title_page_cell.js';
import { GlossaryCell } from './cells/glossary_cell.js';
// dashboard-ref cells use PlotCell with linked config (no separate class)
import { DocumentationEditorWindow } from './documentation_editor_window.js';
import { openPlotPopoutWindow } from '../ui/components/plot_popout_window.js';
import { openModelCodeWindow } from '../ui/components/model_code_window.js';

const CELL_RENDERERS = {
    'code':                 CodeCell,
    'documentation':        DocumentationCell,
    'heading':              HeadingCell,
    'parameter':            ParameterCell,
    'godley':               GodleyCell,
    'plot':                 PlotCell,
    'generator':            GeneratorCell,
    'smooth':               SmoothCell,
    'delay':                DelayCell,
    'latch':                LatchCell,
    'conditional-switch':   ConditionalSwitchCell,
    'time':                 TimeCell,
    'pid':                  PidCell,
    'schedule':             ScheduleCell,
    'toc':                  TocCell,
    'data-table':           DataTableCell,
    'assumptions':          AssumptionsCell,
    'figure-register':      FigureRegisterCell,
    'table-register':       TableRegisterCell,
    'literature':           LiteratureCell,
    'loops':                LoopsCell,
    'signal-source':        SignalSourceCell,
    'event-timer':          EventTimerCell,
    'event-counter':        EventCounterCell,
    'linear-ramp':          LinearRampCell,
    'statistics':           StatisticsCell,
    'stock-viewer':         StockViewerCell,
    'reference':            ReferenceCell,
    'stock':                StockCell,
    'source-sink':          SourceSinkCell,
    'title-page':           TitlePageCell,
    'glossary':             GlossaryCell,
    'dashboard-ref':        PlotCell,
};

/** Cell types removed in earlier refactors — silently skip, never warn. */
const DEFUNCT_CELL_TYPES = new Set(['metadata', 'scenario-settings', 'data-source']);

/** Cell types that only make sense in scenarios/dashboards — silently stripped from namespace files. */
const NAMESPACE_EXCLUDED_TYPES = new Set(['plot', 'data-table', 'loops', 'stock-viewer', 'assumptions', 'reference', 'dashboard-ref']);

// Full set of namespace cell types
const NAMESPACE_CELL_TYPES_FULL = [
    { type: 'heading',             label: 'Heading',             icon: 'title',                    desc: 'Section heading' },
    { type: 'code',                label: 'Code cell',           icon: 'code',                     desc: 'EcoLang DSL equations' },
    { type: 'documentation',       label: 'Documentation',       icon: 'article',                  desc: 'Markdown & LaTeX text' },
    { type: 'parameter',           label: 'Parameter',           icon: 'tune',                     desc: 'Named value with range' },
    { type: 'godley',              label: 'Godley table',        icon: 'table_chart',              desc: 'Double-entry accounting' },
    { type: 'stock',               label: 'Stock',               icon: 'inventory_2',              desc: 'Single stock with rate equation' },
    { type: 'source-sink',         label: 'Source / Sink',       icon: 'swap_vert',                desc: 'Stock with inflow and outflow' },
    { type: 'plot',                label: 'Plot / Widget',       icon: 'area_chart',               desc: 'Inline simulation chart' },
    { type: 'generator',           label: 'Generator',           icon: 'waves',                    desc: 'Signal generator' },
    { type: 'smooth',              label: 'Smooth function',     icon: 'blur_on',                  desc: 'Shape function (logistic, erf, hill…)' },
    { type: 'delay',               label: 'Delay / Lag',         icon: 'history',                  desc: 'Temporal lag — lag(x, dt)' },
    { type: 'latch',               label: 'Event latch',         icon: 'bolt',                     desc: 'One-shot trigger — latch(condition)' },
    { type: 'conditional-switch',  label: 'Conditional switch',  icon: 'device_hub',               desc: 'Smooth match expression' },
    { type: 'time',                label: 'Time expression',     icon: 'schedule',                 desc: 'Named time-based variable' },
    { type: 'pid',                 label: 'PID Controller',      icon: 'settings_input_component', desc: 'Proportional-integral-derivative' },
    { type: 'schedule',            label: 'Schedule table',      icon: 'table_rows',               desc: 'Piecewise lookup table' },
    { type: 'signal-source',       label: 'Signal source',       icon: 'ssid_chart',               desc: 'External data series' },
    { type: 'event-timer',         label: 'Event timer',         icon: 'timer',                    desc: 'Duration-based trigger' },
    { type: 'event-counter',       label: 'Event counter',       icon: 'pin',                      desc: 'Rising-edge crossing counter' },
    { type: 'linear-ramp',         label: 'Linear ramp',         icon: 'trending_up',              desc: 'Ramp / random generator' },
    { type: 'statistics',          label: 'Statistics',           icon: 'query_stats',              desc: 'Rolling stats / EMA / cumsum' },
    { type: 'literature',          label: 'Bibliography',         icon: 'menu_book',                desc: 'Literature references' },
];

const DOC_CELL_TYPES = [
    { type: 'heading',           label: 'Heading',           icon: 'title',                  desc: 'Section heading' },
    { type: 'documentation',     label: 'Documentation',     icon: 'article',                desc: 'Markdown & LaTeX text' },
    { type: 'plot',              label: 'Plot / Widget',     icon: 'area_chart',             desc: 'Inline simulation chart' },
    { type: 'data-table',        label: 'Data table',        icon: 'table_chart',            desc: 'Simulation results table' },
    { type: 'assumptions',       label: 'Assumptions',       icon: 'fact_check',             desc: 'Parameter group display' },
    { type: 'toc',               label: 'Table of contents', icon: 'toc',                    desc: 'Auto-generated TOC' },
    { type: 'figure-register',   label: 'List of figures',   icon: 'format_list_numbered',   desc: 'Auto-generated figure list' },
    { type: 'table-register',    label: 'List of tables',    icon: 'format_list_numbered',   desc: 'Auto-generated table list' },
    { type: 'literature',        label: 'Bibliography',      icon: 'menu_book',              desc: 'Literature references' },
    { type: 'loops',             label: 'Loop Analysis',     icon: 'hub',                    desc: 'Causal loop diagram' },
    { type: 'stock-viewer',      label: 'Stock viewer',      icon: 'account_balance_wallet', desc: 'Balance sheet display' },
    { type: 'reference',         label: 'Reference',         icon: 'link',                   desc: 'Embed model or scenario content' },
    { type: 'glossary',          label: 'Glossary',          icon: 'spellcheck',             desc: 'Terms and definitions' },
    { type: 'dashboard-ref',     label: 'Dashboard widget',  icon: 'dashboard_customize',    desc: 'Reference a dashboard tile' },
];

// Namespace files: exclude visualization-only cells (plots, tables, etc. belong in scenarios)
const NAMESPACE_CELL_TYPES = NAMESPACE_CELL_TYPES_FULL.filter(c => !NAMESPACE_EXCLUDED_TYPES.has(c.type));

// Cell types available via "Add cell" menu, keyed by fileType
const ADDABLE_CELLS = {
    namespace:      NAMESPACE_CELL_TYPES,
    scenario: [
        { type: 'documentation', label: 'Documentation',    icon: 'article',    desc: 'Markdown & LaTeX text' },
        { type: 'plot',          label: 'Plot / Widget',    icon: 'area_chart', desc: 'Inline simulation chart' },
        { type: 'data-table',    label: 'Data table',       icon: 'table_chart', desc: 'Simulation results table' },
        { type: 'assumptions',   label: 'Assumptions',      icon: 'fact_check',  desc: 'Parameter group display' },
        { type: 'loops',         label: 'Loop Analysis',    icon: 'hub',        desc: 'Causal loop diagram' },
        { type: 'stock-viewer',  label: 'Stock viewer',     icon: 'account_balance_wallet', desc: 'Balance sheet display' },
        { type: 'reference',     label: 'Reference',        icon: 'link',                   desc: 'Embed model or scenario content' },
        { type: 'dashboard-ref', label: 'Dashboard widget', icon: 'dashboard_customize',    desc: 'Reference a dashboard tile' },
    ],
    'scenario-docs': DOC_CELL_TYPES,
    'paper': DOC_CELL_TYPES,
    test: [
        { type: 'code',          label: 'Assertion',        icon: 'check_circle', desc: 'EcoLang assertion' },
        { type: 'documentation', label: 'Documentation',    icon: 'article',      desc: 'Markdown & LaTeX text' },
    ],
};

// ─── Default cell data factories ──────────────────────────────────────────────

function defaultCellData(type) {
    const id = `cell-${Math.random().toString(36).slice(2, 10)}`;
    switch (type) {
        case 'code':
            return { id, type, data: { source: '' } };
        case 'documentation':
            return { id, type, data: { source: '' } };
        case 'heading':
            return { id, type, data: { level: 1, title: '' } };
        case 'parameter':
            return { id, type, data: { name: '', value: '', min: '', max: '', description: '', distribution: { type: 'none' } } };
        case 'godley':
            return { id, type, data: { title: '', namespace: '', rows: [], cols: [] } };
        case 'plot':
            return { id, type, data: { chartType: 'line', series: [], legendPosition: 'hidden' } };
        case 'smooth':
            return { id, type, data: { name: '', namespace: '', func: 'logistic', input: '', logisticL: '1', logisticK: '1', logisticX0: '0' } };
        case 'delay':
            return { id, type, data: { name: '', namespace: '', input: '', lagAmount: '5', defaultVal: '', initVal: '' } };
        case 'latch':
            return { id, type, data: { name: '', namespace: '', condition: '', resetCondition: '', initial: '0' } };
        case 'conditional-switch':
            return { id, type, data: { name: '', namespace: '', steepness: '20', rules: [{ condition: '', value: '' }], elseValue: '0' } };
        case 'time':
            return { id, type, data: { name: '', namespace: '', expression: 't' } };
        case 'toc':
            return { id, type, data: {} };
        case 'data-table':
            return { id, type, data: { variables: [], caption: '', decimalPlaces: 2 } };
        case 'assumptions':
            return { id, type, data: { groups: [] } };
        case 'figure-register':
            return { id, type, data: {} };
        case 'table-register':
            return { id, type, data: {} };
        case 'literature':
            return { id, type, data: { entries: [] } };
        case 'loops':
            return { id, type, data: { namespace: '', selectedLoopId: '', maxLoops: 20, showConstants: false, showPolarity: true, caption: '' } };
        case 'signal-source':
            return { id, type, data: { name: '', namespace: '', datasetName: '', datasetId: '', seriesId: '', seriesName: '', timeColumn: '', valueColumn: '', interpolation: 'linear', extrapolation: 'hold', timeOffset: '0', timeMapping: 'numeric' } };
        case 'event-timer':
            return { id, type, data: { name: '', namespace: '', condition: '', duration: '5', mode: 'sustain' } };
        case 'event-counter':
            return { id, type, data: { name: '', namespace: '', condition: '', threshold: '0', resetCondition: '' } };
        case 'linear-ramp':
            return { id, type, data: { name: '', namespace: '', generatorType: 'ramp', startValue: '0', endValue: '1', startTime: '0', riseTime: '10', randomDistribution: 'uniform', randomMin: '0', randomMax: '1', randomMean: '0', randomStdDev: '1', randomSeed: '42' } };
        case 'statistics':
            return { id, type, data: { name: '', namespace: '', input: '', functionType: 'rolling_mean', windowSize: '5', alpha: '0.3' } };
        case 'stock-viewer':
            return { id, type, data: { namespace: '', sector: '', showZeroBalances: false } };
        case 'reference':
            return { id, type, data: { sourceType: 'model', namespace: '', scenario: '', cellId: '', mode: 'all' } };
        case 'title-page':
            return { id, type, data: {} };
        case 'glossary':
            return { id, type, data: { entries: [] } };
        case 'dashboard-ref':
            return { id, type, data: { dashboardPath: '', tileIndex: -1, caption: '', doc: '' } };
        default:
            return { id, type, data: {} };
    }
}

export class NotebookEditor extends ComponentBase {
    /** @type {Array<object>} */
    #cells = [];

    /** @type {Map<string, { cell: object, renderer: object, el: HTMLElement }>} */
    #renderers = new Map();

    /** @type {HTMLElement} */
    #container = null;

    /** @type {HTMLElement} */
    #cellListEl = null;

    /** @type {string|null} */
    #activeCellId = null;

    /** @type {string} fileType for this notebook: 'model'|'scenario'|'test' */
    #fileType = 'model';

    /** @type {string|null} file path this editor is showing (for breadcrumbs) */
    #filePath = null;

    /** @type {boolean} */
    #dirty = false;

    /** @type {Function|null} */
    #onChangeCallback = null;

    /** @type {object|null} */
    #editorFactory = null;

    /** @type {object|null} Drag state */
    #drag = null;

    /** @type {Set<string>|null} Cell types to hide from rendering */
    #hiddenCellTypes = null;

    /** @type {NotebookUndoManager} */
    #undoManager = new NotebookUndoManager();

    /** @type {Function|null} Bound keydown handler for cleanup */
    #keyHandler = null;

    /** @type {Map<string, ManagedWindow>} open cell windows keyed by cell id */
    #cellWindows = new Map();

    /** @type {Function|null} called when a cell is selected: (cellId, cellType) => void */
    #onCellSelected = null;

    /** @type {Function|null} Cleanup for the currently open type-picker outside-click handler */
    #activePickerCleanup = null;

    /** @type {object|null} NotebookSymbolIndex — shared symbol table for cell autocomplete */
    #symbolIndex = null;

    /** @type {Map<string, object>} numbering map: cellId → { displayNum } */
    #numbering = new Map();

    /** @type {import('../data/project_model.js').ProjectModel|null} */
    #project = null;

    /** @type {number|null} debounce timer for derived cell refresh */
    #refreshTimer = null;

    /** @type {AbortController|null} Cancels background cell mounting */
    #backgroundMountCtrl = null;

    /** @type {object|null} Current simulation results ({ series, time }) — pushed to cells as they mount */
    #currentResults = null;

    /** @type {NotebookSearchBar|null} */
    #searchBar = null;

    /** @type {Function|null} Called after a deferred cell renderer is mounted: (cellId, cellType, renderer) */
    #onCellMounted = null;

    constructor({ eventBus, logger, onCellSelected, onCellMounted } = {}) {
        super({ eventBus, logger });
        this.#onCellSelected = onCellSelected ?? null;
        this.#onCellMounted = onCellMounted ?? null;
    }

    /**
     * @param {HTMLElement} container
     * @param {{ cells: object[], fileType: string, onChange?: Function }} props
     */
    /** @type {Function|null} Paper page: returns documentSettings */
    #getDocumentSettings = null;

    /** @type {Function|null} Paper page: updates documentSettings */
    #onDocumentSettingsChanged = null;

    /** @type {Function|null} Returns scenario context { monteCarlo } for MC-aware rendering */
    #getScenarioContext = null;

    async mount(container, { cells = [], fileType = 'model', filePath = null, onChange, hiddenCellTypes, project, getDocumentSettings, onDocumentSettingsChanged, getScenarioContext } = {}) {
        this.#container = container;
        this.#fileType = fileType;
        this.#filePath = filePath;
        this.#onChangeCallback = onChange ?? null;
        this.#hiddenCellTypes = hiddenCellTypes ?? null;
        this.#project = project ?? null;
        this.#getDocumentSettings = getDocumentSettings ?? null;
        this.#onDocumentSettingsChanged = onDocumentSettingsChanged ?? null;
        this.#getScenarioContext = getScenarioContext ?? null;
        this.#cells = cells.filter(c => {
            if (DEFUNCT_CELL_TYPES.has(c.type)) return false;
            if (fileType === 'namespace' && NAMESPACE_EXCLUDED_TYPES.has(c.type)) return false;
            return true;
        }).map(c => ({ ...c }));

        // Deduplicate cell IDs — assign deterministic suffixed IDs to duplicates.
        // Must match the same logic in simulation_run_page.js #extractDocHeadings.
        const seenIds = new Set();
        for (const cell of this.#cells) {
            if (seenIds.has(cell.id)) {
                let n = 2;
                while (seenIds.has(`${cell.id}-${n}`)) n++;
                cell.id = `${cell.id}-${n}`;
            }
            seenIds.add(cell.id);
        }
        this._mounted = true;

        // Load Monaco editor factory
        this.#editorFactory = await getEditorFactory();

        // Guard: if disposed during the await (e.g. concurrent mount replaced this editor), bail out
        if (!this._mounted) return;

        this.#render();

        // Create all cell wrapper elements upfront (lightweight DOM nodes)
        const cellEntries = [];
        for (const cell of this.#cells) {
            if (this.#hiddenCellTypes?.has(cell.type)) continue;
            if (DEFUNCT_CELL_TYPES.has(cell.type)) continue;

            const el = document.createElement('div');
            el.className = `notebook-cell notebook-cell--${cell.type}`;
            el.dataset.cellId = cell.id;
            el.dataset.cellType = cell.type;
            this.#cellListEl.appendChild(el);

            // Register in #renderers with null renderer so #syncAdders can find the element
            this.#renderers.set(cell.id, { cell, renderer: null, el });
            cellEntries.push({ cell, el });
        }

        // Mount visible cells immediately, mark the rest as deferred placeholders
        const scrollRoot = this.#container;
        const viewportBottom = scrollRoot.getBoundingClientRect().bottom + 200;
        const deferred = [];

        for (const { cell, el } of cellEntries) {
            if (el.getBoundingClientRect().top < viewportBottom) {
                await this.#mountCellRenderer(cell, el);
                if (!this._mounted) return;
                const entry = this.#renderers.get(cell.id);
                if (entry?.renderer && this.#onCellMounted) {
                    this.#onCellMounted(cell.id, cell.type, entry.renderer);
                }
            } else {
                el.classList.add('notebook-cell--deferred');
                deferred.push({ cell, el });
            }
        }

        // Mount remaining cells top-to-bottom in the background
        if (deferred.length > 0) {
            this.#mountCellsInBackground(deferred);
        }

        this.#syncAdders();

        // Keyboard undo/redo + global search — only fires when Monaco is NOT focused (Monaco handles its own)
        this.#keyHandler = (e) => this.#onKeyDown(e);
        this.#container.addEventListener('keydown', this.#keyHandler);

        // Global notebook search bar
        this.#searchBar = new NotebookSearchBar(this.#container, {
            getCells:        () => this.#cells.map(c => ({ id: c.id, type: c.type })),
            getCellRenderer: (id) => this.getCellRenderer(id),
            getCellElement:  (id) => this.#renderers.get(id)?.el ?? null,
            scrollToCell:    (id) => this.scrollToCell(id),
        });

        this.#refreshDerivedCellsSync();
    }

    /** Replace cell list with new content (e.g., after file reload). */
    async update({ cells, fileType } = {}) {
        if (fileType !== undefined) this.#fileType = fileType;
        if (cells !== undefined) {
            // Cancel background mount + existing renderers
            this.#cancelBackgroundMount();
            for (const { renderer } of this.#renderers.values()) {
                renderer?.dispose?.();
            }
            this.#renderers.clear();
            this.#cells = cells.filter(c => {
                if (DEFUNCT_CELL_TYPES.has(c.type)) return false;
                if (this.#fileType === 'namespace' && NAMESPACE_EXCLUDED_TYPES.has(c.type)) return false;
                return true;
            }).map(c => ({ ...c }));
            this.#activeCellId = null;

            if (this.#cellListEl) {
                this.#cellListEl.innerHTML = '';
            }

            // Create all cell wrappers, mount visible, defer off-screen
            const cellEntries = [];
            for (const cell of this.#cells) {
                if (this.#hiddenCellTypes?.has(cell.type)) continue;
                if (DEFUNCT_CELL_TYPES.has(cell.type)) continue;

                const el = document.createElement('div');
                el.className = `notebook-cell notebook-cell--${cell.type}`;
                el.dataset.cellId = cell.id;
                el.dataset.cellType = cell.type;
                this.#cellListEl.appendChild(el);
                this.#renderers.set(cell.id, { cell, renderer: null, el });
                cellEntries.push({ cell, el });
            }

            const scrollRoot = this.#container;
            const viewportBottom = scrollRoot.getBoundingClientRect().bottom + 200;
            const deferred = [];

            for (const { cell, el } of cellEntries) {
                if (el.getBoundingClientRect().top < viewportBottom) {
                    await this.#mountCellRenderer(cell, el);
                    const entry = this.#renderers.get(cell.id);
                    if (entry?.renderer && this.#onCellMounted) {
                        this.#onCellMounted(cell.id, cell.type, entry.renderer);
                    }
                } else {
                    el.classList.add('notebook-cell--deferred');
                    deferred.push({ cell, el });
                }
            }

            if (deferred.length > 0) {
                this.#mountCellsInBackground(deferred);
            }

            this.#syncAdders();
            this.#refreshDerivedCellsSync();
        }
    }

    /** Return current cells data (serializable). */
    getCells() {
        // Flush any in-progress edits from renderers back to cell data
        for (const [id, { renderer }] of this.#renderers) {
            const cell = this.#cells.find(c => c.id === id);
            if (cell && renderer?.getData) {
                cell.data = renderer.getData();
            }
        }
        return this.#cells.map(c => ({ ...c, data: { ...c.data } }));
    }

    get isDirty() { return this.#dirty; }
    get fileType() { return this.#fileType; }

    /** Get a cell renderer by cell id (for external access like result injection). */
    getCellRenderer(cellId) {
        return this.#renderers.get(cellId)?.renderer ?? null;
    }

    /**
     * Programmatically add a cell with pre-set data (e.g. from dashboard "Add to Documentation").
     * @param {string} type  — cell type (e.g. 'plot')
     * @param {object} data  — cell data to use instead of defaults
     */
    async addCellWithData(type, data) {
        const before = this.getCells();
        const id = `cell-${Math.random().toString(36).slice(2, 10)}`;
        const newCell = { id, type, data: { ...data } };
        this.#cells.push(newCell);
        await this.#mountCell(newCell);

        const after = this.getCells();
        this.#undoManager.push({
            description: `Add ${type} cell`,
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#syncAdders();
        this.#markDirty();
        this.#scheduleRefreshDerivedCells();
        this.#setActiveCell(newCell.id);
        this.#renderers.get(newCell.id)?.renderer?.focus?.();
    }

    /**
     * Insert a cell with pre-built data at a specific position.
     * Unlike addCellWithData (which always appends), this supports
     * inserting after a given cell.
     *
     * @param {string} type  Cell type.
     * @param {object} data  Cell data.
     * @param {string} cellId  Pre-generated cell ID.
     * @param {string|null} afterCellId  Insert after this cell, or null to append.
     */
    async insertCellWithId(type, data, cellId, afterCellId = null) {
        const before = this.getCells();
        const newCell = { id: cellId, type, data: { ...data } };

        if (afterCellId) {
            const idx = this.#cells.findIndex(c => c.id === afterCellId);
            if (idx >= 0) {
                this.#cells.splice(idx + 1, 0, newCell);
            } else {
                this.#cells.push(newCell);
            }
        } else {
            this.#cells.push(newCell);
        }

        await this.#mountCell(newCell);
        if (afterCellId) this.#syncDomOrder();

        const after = this.getCells();
        this.#undoManager.push({
            description: `Add ${type} cell (AI)`,
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#syncAdders();
        this.#markDirty();
        this.#scheduleRefreshDerivedCells();
    }

    /**
     * Update a cell's data programmatically (e.g. from AI operations).
     * Remounts the cell renderer with the new data.
     *
     * @param {string} cellId  Cell ID to update.
     * @param {object} newData  Replacement data object.
     */
    async updateCellData(cellId, newData) {
        const cell = this.#cells.find(c => c.id === cellId);
        if (!cell) return;

        const before = this.getCells();
        cell.data = { ...newData };

        // Remount the renderer with new data
        const entry = this.#renderers.get(cellId);
        if (entry) {
            entry.renderer?.dispose?.();
            entry.el?.remove();
            this.#renderers.delete(cellId);
            await this.#mountCell(cell);
            this.#syncDomOrder();
        }

        const after = this.getCells();
        this.#undoManager.push({
            description: `Update cell (AI)`,
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#markDirty();
        this.#scheduleRefreshDerivedCells();
    }

    /**
     * Delete a cell programmatically (e.g. from AI operations).
     * @param {string} cellId  Cell ID to remove.
     */
    removeCellById(cellId) {
        this.#deleteCell(cellId);
    }

    /**
     * Move a cell up or down programmatically (e.g. from AI operations).
     * @param {string} cellId  Cell ID to move.
     * @param {'up'|'down'} direction  Direction to move.
     */
    moveCellById(cellId, direction) {
        this.#moveCell(cellId, direction === 'up' ? -1 : 1);
    }

    /**
     * Store simulation results and push to all currently-mounted renderers.
     * Deferred cells receive results automatically when they mount.
     * @param {object|null} results  { series, time }
     * @param {{ skipTypes?: string[] }} [opts]
     */
    setResults(results, { skipTypes, cached = false } = {}) {
        this.#currentResults = results ?? null;
        if (!results) return;
        for (const [, { cell, renderer }] of this.#renderers) {
            if (skipTypes?.includes(cell.type)) continue;
            renderer?.renderResults?.(results, { cached });
        }
    }

    /** Scroll to and activate a cell by its id. */
    scrollToCell(cellId) {
        const entry = this.#renderers.get(cellId);
        if (!entry) return;
        this.#setActiveCell(cellId);
        this.#scrollCellIntoView(entry.el);
    }

    /**
     * Scroll to a specific heading within a documentation cell.
     * Falls back to scrollToCell if the heading element is not found.
     * @param {string} cellId
     * @param {number} headingIndex  0-based index matching data-heading-index on rendered <h> tags
     */
    scrollToCellHeading(cellId, headingIndex) {
        const entry = this.#renderers.get(cellId);
        if (!entry) return;
        this.#setActiveCell(cellId);
        const hEl = entry.el.querySelector(`[data-heading-index="${headingIndex}"]`);
        this.#scrollCellIntoView(hEl ?? entry.el);
    }

    /**
     * Scroll to a cell and optionally reveal a specific line within it.
     * @param {string} cellId
     * @param {number|null} [line]  1-based line number within the cell
     */
    scrollToCellLine(cellId, line) {
        const entry = this.#renderers.get(cellId);
        if (!entry) return;
        this.#setActiveCell(cellId);
        this.#scrollCellIntoView(entry.el);
        if (line && entry.renderer?.revealLine) {
            entry.renderer.revealLine(line);
        }
    }

    /**
     * Set Monaco diagnostics (markers) on a specific cell.
     * @param {string} cellId
     * @param {Array<{ startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number, message: string, severity: number }>} markers
     */
    setDiagnostics(cellId, markers) {
        const entry = this.#renderers.get(cellId);
        if (!entry) return;
        entry.renderer?.setDiagnostics?.(markers);
    }

    /** Clear all diagnostics from all cells. */
    clearAllDiagnostics() {
        for (const { renderer } of this.#renderers.values()) {
            renderer?.setDiagnostics?.([]);
        }
    }

    /** Switch all cell renderers to the given tab (config/display/dsl). */
    switchAllCellTabs(tabId) {
        for (const { renderer } of this.#renderers.values()) {
            renderer?.switchTab?.(tabId);
        }
    }

    /** Set the active theme on all Monaco editors. */
    setTheme(theme) {
        this.#editorFactory?.setTheme(theme);
    }

    /** Set the symbol index for cell-level autocomplete (variable pickers, etc.). */
    setSymbolIndex(symbolIndex) {
        this.#symbolIndex = symbolIndex;
    }

    /** Get the current numbering map (cellId → { displayNum, kind }). */
    getNumbering() {
        return new Map(this.#numbering);
    }

    /** Reset undo history (call after file save or load). */
    clearHistory() {
        this.#undoManager.clear();
    }

    // ─── Numbering & derived-cell refresh ────────────────────────────────────

    /**
     * Compute chapter/figure/table numbering across all cells.
     * Heading cells get chapter numbers (1, 1.1, 1.1.1).
     * Plot cells with descriptions get figure numbers (Figure 1, Figure 2).
     * Data-table cells with captions get table numbers (Table 1, Table 2).
     */
    #computeNumbering() {
        this.#numbering.clear();
        const counters = [0, 0, 0]; // H1, H2, H3
        let figNum = 0;
        let tblNum = 0;

        for (const cell of this.#cells) {
            if (cell.type === 'heading') {
                const level = cell.data?.level ?? 1;
                const idx = Math.min(Math.max(level, 1), 3) - 1;
                counters[idx]++;
                // Reset deeper levels
                for (let i = idx + 1; i < 3; i++) counters[i] = 0;
                const displayNum = counters.slice(0, idx + 1).join('.');
                this.#numbering.set(cell.id, { displayNum, kind: 'heading' });
            } else if ((cell.type === 'plot' || cell.type === 'loops' || cell.type === 'dashboard-ref') && (cell.data?.description || cell.data?.caption)) {
                figNum++;
                this.#numbering.set(cell.id, { displayNum: String(figNum), kind: 'figure' });
            } else if (cell.type === 'data-table' && cell.data?.caption) {
                tblNum++;
                this.#numbering.set(cell.id, { displayNum: String(tblNum), kind: 'table' });
            }
        }
    }

    /**
     * Recompute numbering and notify derived cells (TOC, registers, literature)
     * to rebuild. Debounced to avoid excessive re-renders during rapid edits.
     */
    #scheduleRefreshDerivedCells() {
        if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = null;
            this.#computeNumbering();
            for (const { renderer } of this.#renderers.values()) {
                renderer?.refreshContent?.();
            }
        }, 300);
    }

    /** Synchronous refresh (used after mount/update when all cells are ready). */
    #refreshDerivedCellsSync() {
        this.#computeNumbering();
        for (const { renderer } of this.#renderers.values()) {
            renderer?.refreshContent?.();
        }
    }

    dispose() {
        if (this.#refreshTimer) { clearTimeout(this.#refreshTimer); this.#refreshTimer = null; }
        this.#cancelBackgroundMount();
        this.#activePickerCleanup?.();
        this.#activePickerCleanup = null;
        this.#searchBar?.dispose();
        this.#searchBar = null;
        if (this.#keyHandler && this.#container) {
            this.#container.removeEventListener('keydown', this.#keyHandler);
            this.#keyHandler = null;
        }
        for (const win of this.#cellWindows.values()) win.close?.();
        this.#cellWindows.clear();
        for (const { renderer } of this.#renderers.values()) {
            renderer?.dispose?.();
        }
        this.#renderers.clear();
        this.#currentResults = null;
        this.#container = null;
        this._mounted = false;
    }

    /** Cancel any in-progress background cell mounting. */
    #cancelBackgroundMount() {
        this.#backgroundMountCtrl?.abort();
        this.#backgroundMountCtrl = null;
    }

    /**
     * Mount deferred cells sequentially in the background, yielding to the
     * browser between each cell so the UI stays responsive.
     * @param {{ cell: object, el: HTMLElement }[]} queue
     */
    #mountCellsInBackground(queue) {
        this.#cancelBackgroundMount();
        const ctrl = new AbortController();
        this.#backgroundMountCtrl = ctrl;

        let idx = 0;
        const mountNext = async () => {
            if (ctrl.signal.aborted) return;
            if (idx >= queue.length) {
                this.#backgroundMountCtrl = null;
                return;
            }
            const { cell, el } = queue[idx++];
            el.classList.remove('notebook-cell--deferred');
            await this.#mountCellRenderer(cell, el);
            // Notify listener (e.g. PaperPage pushes per-cell results)
            const entry = this.#renderers.get(cell.id);
            if (entry?.renderer && this.#onCellMounted) {
                this.#onCellMounted(cell.id, cell.type, entry.renderer);
            }
            // Yield to the browser, then mount the next cell
            requestAnimationFrame(() => mountNext());
        };
        requestAnimationFrame(() => mountNext());
    }

    // ─── Rendering ────────────────────────────────────────────────────────────

    #render() {
        this.#container.innerHTML = '';
        // Make the container focusable so keyboard shortcuts (Ctrl+F, Ctrl+Z, etc.)
        // work even when clicking on the notebook background outside any cell.
        this.#container.tabIndex = -1;
        // Do NOT overwrite container class — it's owned by NotebookPage (notebook-editor-container).
        // Create a notebook-editor wrapper inside for max-width centering.
        const wrapper = document.createElement('div');
        wrapper.className = 'notebook-editor';
        this.#container.appendChild(wrapper);

        // Cell list
        this.#cellListEl = document.createElement('div');
        this.#cellListEl.className = 'notebook-cell-list';
        wrapper.appendChild(this.#cellListEl);

        // Add-cell footer
        const footer = this.#buildAddCellFooter();
        wrapper.appendChild(footer);
    }

    #buildAddCellFooter() {
        const footer = document.createElement('div');
        footer.className = 'notebook-add-cell-footer';

        const addable = ADDABLE_CELLS[this.#fileType] ?? [];
        for (const { type, label, icon } of addable) {
            const btn = document.createElement('button');
            btn.className = 'notebook-add-cell-btn';
            btn.title = label;
            btn.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${label}</span>`;
            btn.addEventListener('click', () => this.#addCell(type));
            footer.appendChild(btn);
        }

        return footer;
    }

    // ─── Cell lifecycle ───────────────────────────────────────────────────────

    /**
     * Mount a cell renderer into an existing wrapper element.
     * Updates the #renderers entry (which must already exist with renderer: null).
     */
    async #mountCellRenderer(cell, el) {
        const RendererClass = CELL_RENDERERS[cell.type];
        if (!RendererClass) {
            this.logger?.warn?.(`Unknown cell type: ${cell.type}`);
            return;
        }

        const renderer = new RendererClass({
            eventBus: this.eventBus,
            logger: this.logger,
            editorFactory: this.#editorFactory,
            symbolProvider: () => this.#symbolIndex?.symbols ?? [],
        });

        await renderer.mount(el, {
            cell,
            fileType: this.#fileType,
            onFocus: () => this.#setActiveCell(cell.id),
            onChange: (data) => this.#onCellChanged(cell.id, data),
            onMoveUp: () => this.#moveCell(cell.id, -1),
            onMoveDown: () => this.#moveCell(cell.id, 1),
            onDelete: () => this.#deleteCell(cell.id),
            onAddBelow: (type) => this.#addCell(type, cell.id),
            onOpenInWindow: () => this.#openCellInWindow(cell.id),
            getCells: () => this.#cells.map(c => ({ id: c.id, type: c.type, data: { ...c.data } })),
            getNumbering: () => this.#numbering,
            project: this.#project,
            onOpenFile: (path, opts) => this.#project?.eventBus?.emit('project:file:request-open', { filePath: path, ...opts }),
            scrollToCell: (cellId) => this.scrollToCell(cellId),
            scrollToCellHeading: (cellId, headingIndex) => this.scrollToCellHeading(cellId, headingIndex),
            getDocumentSettings: this.#getDocumentSettings,
            onDocumentSettingsChanged: this.#onDocumentSettingsChanged,
            getScenarioContext: this.#getScenarioContext,
        });

        this.#renderers.set(cell.id, { cell, renderer, el });

        // Push current results to the newly-mounted cell
        if (this.#currentResults) {
            renderer.renderResults(this.#currentResults);
        }

        // Double-click: uncollapse if collapsed, otherwise open in window
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('input, textarea, select, button, .monaco-editor, .cm-editor, .godley-table-wrap')) return;
            if (cell.collapsed) {
                cell.collapsed = false;
                renderer._applyCollapsed(false);
                this.#markDirty();
            } else if (cell.type === 'reference') {
                // Reference cells navigate to the source namespace instead of opening a window
                renderer._onExtraAction('open-source');
            } else {
                this.#openCellInWindow(cell.id);
            }
        });

        this.#enableDrag(el, cell.id);
    }

    /**
     * Create a cell wrapper element, append to the cell list, and mount its renderer.
     * Used by #addCell for newly inserted cells.
     */
    async #mountCell(cell) {
        if (this.#hiddenCellTypes?.has(cell.type)) return;
        if (DEFUNCT_CELL_TYPES.has(cell.type)) return;

        const el = document.createElement('div');
        el.className = `notebook-cell notebook-cell--${cell.type}`;
        el.dataset.cellId = cell.id;
        el.dataset.cellType = cell.type;

        this.#cellListEl.appendChild(el);
        this.#renderers.set(cell.id, { cell, renderer: null, el });

        await this.#mountCellRenderer(cell, el);
        const entry = this.#renderers.get(cell.id);
        if (entry?.renderer && this.#onCellMounted) {
            this.#onCellMounted(cell.id, cell.type, entry.renderer);
        }
    }

    #onCellChanged(cellId, data) {
        const entry = this.#renderers.get(cellId);
        if (entry) entry.cell.data = data;

        const idx = this.#cells.findIndex(c => c.id === cellId);
        if (idx !== -1) this.#cells[idx].data = data;

        this.#markDirty();
        this.#scheduleRefreshDerivedCells();
    }

    #setActiveCell(cellId) {
        const changed = this.#activeCellId !== cellId;
        if (changed) {
            if (this.#activeCellId) {
                this.#renderers.get(this.#activeCellId)?.el?.classList.remove('notebook-cell--active');
            }
            this.#activeCellId = cellId;
            this.#renderers.get(cellId)?.el?.classList.add('notebook-cell--active');
        }

        const entry = this.#renderers.get(cellId);
        if (entry) {
            this.#onCellSelected?.(cellId, entry.cell.type);
        }
    }

    /**
     * Scroll a cell element into view within this editor's container only,
     * without affecting any ancestor scroll positions (prevents layout shifts).
     */
    #scrollCellIntoView(el) {
        // this.#container is the .notebook-editor-container (overflow-y: auto)
        const scrollParent = this.#container;
        if (!scrollParent) return;
        const parentRect = scrollParent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const offsetTop = elRect.top - parentRect.top + scrollParent.scrollTop;
        const targetScroll = offsetTop - (parentRect.height - elRect.height) / 2;
        scrollParent.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
    }

    async #openCellInWindow(cellId) {
        // If already open, bring to front
        const existing = this.#cellWindows.get(cellId);
        if (existing) { existing.focus?.(); return; }

        const entry = this.#renderers.get(cellId);
        if (!entry) return;

        const { cell, renderer } = entry;

        // Reference cells navigate to the source namespace
        if (cell.type === 'reference') {
            renderer._onExtraAction('open-source');
            return;
        }

        // Plot cells (including dashboard-ref) open in a PlotPopoutWindow
        if (cell.type === 'plot' || cell.type === 'dashboard-ref') {
            const plotData = renderer.getData?.() ?? cell.data;
            const title = plotData?.subplots?.[0]?.displayName || 'Plot';
            const binding = renderer.getConfigBinding?.();
            openPlotPopoutWindow({
                id: `nb-${cellId}`,
                title,
                plotConfig: plotData,
                getResults: () => renderer.getLastResults?.() ?? null,
                actuals: renderer.getActuals?.() ?? null,
                services: { eventBus: this.eventBus, logger: this.logger },
                configRenderer: binding?.renderConfig ? (el) => binding.renderConfig(el) : null,
            });
            return;
        }

        // Documentation cells use a dedicated editor window
        if (cell.type === 'documentation') {
            const docWin = new DocumentationEditorWindow({
                cellId,
                source: renderer.getData?.()?.source ?? cell.data.source ?? '',
                editorFactory: this.#editorFactory,
                onChange: (source) => this.#onCellChanged(cellId, { source }),
                onClose: () => this.#cellWindows.delete(cellId),
            });
            this.#cellWindows.set(cellId, docWin);
            docWin.show();
            return;
        }

        // Code cells use the model code window in editable cell mode
        if (cell.type === 'code') {
            const source = renderer.getData?.()?.source ?? cell.data.source ?? '';
            const fileName = this.#filePath?.split('/').pop() ?? null;
            const cellName = cell.data.name || source.split('\n')[0]?.trim().slice(0, 40) || 'Code';
            const handle = await openModelCodeWindow({
                cellId,
                source,
                fileName,
                cellName,
                onChange: (newSource) => this.#onCellChanged(cellId, { source: newSource }),
                onClose: () => this.#cellWindows.delete(cellId),
            });
            if (handle) this.#cellWindows.set(cellId, handle);
            return;
        }

        const RendererClass = CELL_RENDERERS[cell.type];
        if (!RendererClass) return;

        const typeLabel = cell.type.replace(/-/g, ' ');
        const detail = cell.data?.name || cell.data?.title || cell.data?.source?.slice(0, 40)?.trim() || '';
        const fileName = this.#filePath?.split('/').pop() ?? null;
        const theme = getCellTheme(cell.type);
        const hasConfig = typeof RendererClass.prototype.getConfigBinding === 'function';

        // ── Header: breadcrumbs + tabs ───────────────────────────────────
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 10px; border-bottom:1px solid #3e3e42; flex-shrink:0;';

        const nav = document.createElement('nav');
        nav.className = 'topbar-breadcrumb';
        nav.style.cssText = 'flex:0; padding:0;';
        const ol = document.createElement('ol');
        ol.className = 'topbar-breadcrumb__list';

        if (fileName) {
            const fileLi = document.createElement('li');
            fileLi.className = 'topbar-breadcrumb__item';
            fileLi.innerHTML = `
                <span class="topbar-breadcrumb__link" style="cursor:default;">
                    <span class="material-symbols-outlined topbar-breadcrumb__icon">description</span>
                    ${fileName}
                </span>
                <span class="topbar-breadcrumb__separator">›</span>`;
            ol.appendChild(fileLi);
        }

        const cellLi = document.createElement('li');
        cellLi.className = 'topbar-breadcrumb__item topbar-breadcrumb__item--current';
        cellLi.innerHTML = `
            <span class="material-symbols-outlined topbar-breadcrumb__icon" style="color:${theme.primary}">${theme.icon}</span>
            <span class="topbar-breadcrumb__current">${detail || typeLabel}</span>`;
        ol.appendChild(cellLi);
        nav.appendChild(ol);
        header.appendChild(nav);

        // Tab buttons (only if cell has config binding)
        let tabsEl = null;
        if (hasConfig) {
            tabsEl = document.createElement('div');
            tabsEl.className = 'code-tabs';
            tabsEl.style.marginLeft = 'auto';
            tabsEl.innerHTML = `
                <button class="code-tab active" data-tab="preview">Preview</button>
                <button class="code-tab" data-tab="config">Config</button>`;
            header.appendChild(tabsEl);
        }

        // ── Content shell ──────────────────────────────────────────────────
        const contentEl = document.createElement('div');
        contentEl.style.cssText = 'display:flex; flex-direction:column; height:100%;';
        contentEl.appendChild(header);

        // Preview panel (cell face: compact summary + schematic)
        const previewPanel = document.createElement('div');
        previewPanel.className = 'nb-cell-window-body';
        previewPanel.style.cssText = 'flex:1; min-height:0; overflow:auto; padding:8px 12px;';
        contentEl.appendChild(previewPanel);

        // Config panel (slide-out panel content)
        let configPanel = null;
        if (hasConfig) {
            configPanel = document.createElement('div');
            configPanel.className = 'nb-cell-window-body';
            configPanel.style.cssText = 'flex:1; min-height:0; overflow:auto; padding:8px 12px;';
            configPanel.hidden = true;
            contentEl.appendChild(configPanel);
        }

        // ── Renderer (body only, no chrome) ────────────────────────────────
        const winRenderer = new RendererClass({
            eventBus: this.eventBus,
            logger: this.logger,
            editorFactory: this.#editorFactory,
            symbolProvider: () => this.#symbolIndex?.symbols ?? [],
        });

        await winRenderer.mountBodyOnly(previewPanel, {
            cell: { ...cell, data: { ...cell.data } },
            fileType: this.#fileType,
            onFocus: () => {},
            onChange: (data) => this.#onCellChanged(cellId, data),
            getCells: () => this.#cells.map(c => ({ id: c.id, type: c.type, data: { ...c.data } })),
            getScenarioContext: this.#getScenarioContext,
        });

        // Mount config panel content
        if (hasConfig && configPanel) {
            const binding = winRenderer.getConfigBinding();
            binding?.renderConfig?.(configPanel);
        }

        // Tab switching
        if (tabsEl) {
            tabsEl.addEventListener('click', (e) => {
                const btn = e.target.closest('.code-tab');
                if (!btn) return;
                const tab = btn.dataset.tab;
                tabsEl.querySelectorAll('.code-tab').forEach(t =>
                    t.classList.toggle('active', t.dataset.tab === tab));
                previewPanel.hidden = tab !== 'preview';
                if (configPanel) configPanel.hidden = tab !== 'config';
            });
        }

        const win = new ManagedWindow({
            id: `cell-editor-${cellId}`,
            title: detail ? `${typeLabel} — ${detail}` : typeLabel,
            icon: theme.icon,
            content: contentEl,
            defaultWidth: 820,
            defaultHeight: 580,
            minWidth: 400,
            minHeight: 300,
            canMaximize: true,
            onClose: () => {
                winRenderer.dispose();
                this.#cellWindows.delete(cellId);
            },
        });

        this.#cellWindows.set(cellId, win);
        win.show();
    }

    async #addCell(type, afterCellId = null) {
        const before = this.getCells();
        const newCell = defaultCellData(type);

        if (afterCellId === '__before_all__') {
            this.#cells.splice(0, 0, newCell);
        } else if (afterCellId) {
            const idx = this.#cells.findIndex(c => c.id === afterCellId);
            this.#cells.splice(idx + 1, 0, newCell);
        } else {
            this.#cells.push(newCell);
        }

        await this.#mountCell(newCell);

        // If inserted above last, reorder DOM to match array order
        if (afterCellId) {
            this.#syncDomOrder();
        }

        const after = this.getCells();
        this.#undoManager.push({
            description: `Add ${type} cell`,
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#syncAdders();
        this.#markDirty();
        this.#scheduleRefreshDerivedCells();
        this.#setActiveCell(newCell.id);
        this.#renderers.get(newCell.id)?.renderer?.focus?.();
    }

    #deleteCell(cellId) {
        const cell = this.#cells.find(c => c.id === cellId);
        if (!cell) return;

        const before = this.getCells();

        const { renderer, el } = this.#renderers.get(cellId) ?? {};
        renderer?.dispose?.();
        el?.remove();
        this.#renderers.delete(cellId);

        this.#cells = this.#cells.filter(c => c.id !== cellId);

        if (this.#activeCellId === cellId) {
            this.#activeCellId = null;
        }

        this.#syncAdders();
        this.#scheduleRefreshDerivedCells();

        const after = this.getCells();
        this.#undoManager.push({
            description: `Delete ${cell.type} cell`,
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#markDirty();
    }

    #moveCell(cellId, direction) {
        const idx = this.#cells.findIndex(c => c.id === cellId);
        if (idx === -1) return;

        const targetIdx = idx + direction;
        if (targetIdx < 0 || targetIdx >= this.#cells.length) return;

        const before = this.getCells();

        [this.#cells[idx], this.#cells[targetIdx]] = [this.#cells[targetIdx], this.#cells[idx]];
        this.#syncDomOrder();

        const after = this.getCells();
        this.#undoManager.push({
            description: 'Move cell',
            undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
            redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
        });

        this.#markDirty();
    }

    /** Re-order DOM elements to match this.#cells array. */
    #syncDomOrder() {
        for (const cell of this.#cells) {
            const { el } = this.#renderers.get(cell.id) ?? {};
            if (el) this.#cellListEl.appendChild(el); // move-to-end trick preserves order
        }
        this.#syncAdders();
    }

    /** Insert/refresh between-cell dividers. */
    #syncAdders() {
        this.#cellListEl.querySelectorAll('.doc-notebook__divider').forEach(el => el.remove());

        if (this.#cells.length === 0) return;

        // Divider before the first cell
        const firstEl = this.#renderers.get(this.#cells[0].id)?.el;
        if (firstEl) {
            firstEl.insertAdjacentElement('beforebegin', this.#buildDivider('__before_all__'));
        }

        // Divider after each cell
        for (const cell of this.#cells) {
            const el = this.#renderers.get(cell.id)?.el;
            if (el) el.insertAdjacentElement('afterend', this.#buildDivider(cell.id));
        }
    }

    /** Open the type picker at the active cell's divider (or last divider). Triggered by '+' shortcut. */
    #openPickerAtActiveCell() {
        // If a picker is already open, close it
        if (this.#activePickerCleanup) {
            this.#activePickerCleanup();
            this.#activePickerCleanup = null;
            return;
        }

        let dividerEl = null;
        let afterCellId = null;

        if (this.#activeCellId) {
            // Find the divider right after the active cell
            const cellEl = this.#renderers.get(this.#activeCellId)?.el;
            if (cellEl) {
                const next = cellEl.nextElementSibling;
                if (next?.classList.contains('doc-notebook__divider')) {
                    dividerEl = next;
                    afterCellId = this.#activeCellId;
                }
            }
        }

        // Fallback: use the last divider in the list
        if (!dividerEl) {
            const dividers = this.#cellListEl.querySelectorAll('.doc-notebook__divider');
            if (dividers.length) {
                dividerEl = dividers[dividers.length - 1];
                afterCellId = this.#cells.length ? this.#cells[this.#cells.length - 1].id : '__before_all__';
            }
        }

        if (dividerEl) {
            this.#toggleTypePicker(dividerEl, afterCellId);
        }
    }

    /** Build a doc-notebook__divider that inserts a new cell after afterCellId when used. */
    #buildDivider(afterCellId) {
        const divider = document.createElement('div');
        divider.className = 'doc-notebook__divider';

        const line = document.createElement('div');
        line.className = 'doc-notebook__divider-line';
        divider.appendChild(line);

        const btn = document.createElement('button');
        btn.className = 'doc-notebook__divider-btn';
        btn.type = 'button';
        btn.innerHTML = '<span class="material-symbols-outlined">add</span>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#toggleTypePicker(divider, afterCellId);
        });
        divider.appendChild(btn);

        return divider;
    }

    /** Toggle the type-picker dropdown on a divider element. */
    #toggleTypePicker(dividerEl, afterCellId) {
        // If a picker is already open, close it
        if (this.#activePickerCleanup) {
            this.#activePickerCleanup();
            this.#activePickerCleanup = null;
            return;
        }

        const addable = ADDABLE_CELLS[this.#fileType] ?? [];
        const picker = document.createElement('div');
        picker.className = 'doc-type-picker';

        // Search input (shown when there are enough items to warrant filtering)
        const showSearch = addable.length > 6;
        let searchInput = null;
        if (showSearch) {
            const searchWrap = document.createElement('div');
            searchWrap.className = 'doc-type-picker__search';
            searchWrap.innerHTML = `<span class="material-symbols-outlined">search</span>`;
            searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = 'Filter cell types…';
            searchInput.className = 'doc-type-picker__search-input';
            searchWrap.appendChild(searchInput);
            picker.appendChild(searchWrap);
        }

        const options = [];
        for (const { type, label, icon, desc = '' } of addable) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'doc-type-picker__option';
            option.innerHTML = `
                <span class="material-symbols-outlined">${icon}</span>
                <span class="doc-type-picker__option-label">${label}</span>
                <span class="doc-type-picker__option-desc">${desc}</span>
            `;
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#activePickerCleanup?.();
                this.#activePickerCleanup = null;
                this.#addCell(type, afterCellId);
            });
            picker.appendChild(option);
            options.push({ el: option, label: label.toLowerCase(), desc: desc.toLowerCase(), type: type.toLowerCase() });
        }

        // Helper: get visible options in DOM order
        const getVisibleOptions = () => options.filter(o => o.el.style.display !== 'none');

        // Helper: move focus by delta (+1 = down, -1 = up), wrapping around
        const moveFocus = (delta) => {
            const visible = getVisibleOptions();
            if (!visible.length) return;
            const currentIdx = visible.findIndex(o => o.el.classList.contains('doc-type-picker__option--focused'));
            for (const o of options) o.el.classList.remove('doc-type-picker__option--focused');
            let nextIdx;
            if (currentIdx < 0) {
                nextIdx = delta > 0 ? 0 : visible.length - 1;
            } else {
                nextIdx = (currentIdx + delta + visible.length) % visible.length;
            }
            visible[nextIdx].el.classList.add('doc-type-picker__option--focused');
            visible[nextIdx].el.scrollIntoView({ block: 'nearest' });
        };

        // Keyboard handler for the picker (arrow nav, enter, escape)
        const pickerKeyHandler = (e) => {
            if (e.key === 'Escape') {
                this.#activePickerCleanup?.();
                this.#activePickerCleanup = null;
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveFocus(1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveFocus(-1);
                return;
            }
            if (e.key === 'Enter') {
                const focused = picker.querySelector('.doc-type-picker__option--focused');
                if (focused) focused.click();
            }
        };

        // Wire up filtering
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase().trim();
                let firstVisible = null;
                for (const opt of options) {
                    const match = !q || opt.label.includes(q) || opt.desc.includes(q) || opt.type.includes(q);
                    opt.el.style.display = match ? '' : 'none';
                    opt.el.classList.remove('doc-type-picker__option--focused');
                    if (match && !firstVisible) firstVisible = opt.el;
                }
                if (firstVisible) firstVisible.classList.add('doc-type-picker__option--focused');
            });
            // Prevent clicks in search from closing the picker
            searchInput.addEventListener('click', (e) => e.stopPropagation());
        }

        // Document-level capture listener — guarantees arrow/enter/escape reach
        // the picker before any other handler can consume them
        const docKeyHandler = (e) => {
            if (!document.body.contains(picker)) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
                pickerKeyHandler(e);
            }
        };
        document.addEventListener('keydown', docKeyHandler, true);

        // Append to body off-screen for measurement, then position
        picker.style.position = 'fixed';
        picker.style.visibility = 'hidden';
        document.body.appendChild(picker);

        // Force layout so getBoundingClientRect returns real dimensions
        picker.getBoundingClientRect();
        this.#positionPicker(picker, dividerEl);
        picker.style.visibility = '';

        // Set initial focus on first option
        if (options.length) options[0].el.classList.add('doc-type-picker__option--focused');

        requestAnimationFrame(() => {
            if (searchInput) searchInput.focus();
            else picker.focus();

            const closeHandler = (e) => {
                if (!picker.contains(e.target) && !dividerEl.contains(e.target)) {
                    this.#activePickerCleanup?.();
                    this.#activePickerCleanup = null;
                }
            };
            this.#activePickerCleanup = () => {
                picker.remove();
                document.removeEventListener('click', closeHandler, { capture: true });
                document.removeEventListener('keydown', docKeyHandler, true);
            };
            document.addEventListener('click', closeHandler, { capture: true });
        });
    }

    /**
     * Position the type-picker centered on the divider button,
     * flipping above/below based on available viewport space.
     */
    #positionPicker(picker, dividerEl) {
        const EDGE = 8;
        const GAP = 6;

        const btn = dividerEl.querySelector('.doc-notebook__divider-btn');
        const btnRect = btn.getBoundingClientRect();
        const pickerRect = picker.getBoundingClientRect();
        const vh = window.innerHeight;
        const vw = window.innerWidth;

        const spaceBelow = vh - btnRect.bottom - GAP - EDGE;
        const spaceAbove = btnRect.top - GAP - EDGE;

        let top, maxHeight;

        if (pickerRect.height <= spaceBelow) {
            top = btnRect.bottom + GAP;
            maxHeight = spaceBelow;
        } else if (pickerRect.height <= spaceAbove) {
            top = btnRect.top - GAP - pickerRect.height;
            maxHeight = spaceAbove;
        } else if (spaceBelow >= spaceAbove) {
            top = btnRect.bottom + GAP;
            maxHeight = spaceBelow;
        } else {
            maxHeight = spaceAbove;
            top = EDGE;
        }

        // Center horizontally on the button, clamp to viewport
        const btnCenter = btnRect.left + btnRect.width / 2;
        let left = btnCenter - pickerRect.width / 2;
        left = Math.max(EDGE, Math.min(left, vw - pickerRect.width - EDGE));

        Object.assign(picker.style, {
            position: 'fixed',
            top: `${Math.round(top)}px`,
            left: `${Math.round(left)}px`,
            maxHeight: `${Math.round(maxHeight)}px`,
            overflowY: 'auto',
        });
    }

    #markDirty() {
        this.#dirty = true;
        this.#onChangeCallback?.();
    }

    // ─── Keyboard shortcuts ─────────────────────────────────────────────────

    #onKeyDown(e) {
        // Ctrl+F / Ctrl+H — global search (only when NOT inside a Monaco editor)
        const active = document.activeElement;
        const inMonaco = active && (active.classList.contains('monaco-editor') || active.closest('.monaco-editor'));
        const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        if (e.ctrlKey && e.key === 'f' && !inMonaco) {
            e.preventDefault();
            this.#searchBar?.open(false);
            return;
        }
        if (e.ctrlKey && e.key === 'h' && !inMonaco) {
            e.preventDefault();
            this.#searchBar?.open(true);
            return;
        }

        // '+' opens the type picker (only when not typing in an editor/input and no text is selected)
        if (e.key === '+' && !e.ctrlKey && !e.altKey && !e.metaKey && !inMonaco && !inInput) {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) {
                e.preventDefault();
                this.#openPickerAtActiveCell();
                return;
            }
        }

        // Undo/redo
        const isUndo = e.ctrlKey && !e.shiftKey && e.key === 'z';
        const isRedo = (e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z');

        if (!isUndo && !isRedo) return;

        // Let Monaco handle its own undo/redo when it owns focus
        if (inMonaco) return;

        e.preventDefault();
        if (isUndo) {
            this.#undoManager.undo();
        } else {
            this.#undoManager.redo();
        }
    }

    // ─── Drag to reorder ──────────────────────────────────────────────────────

    #enableDrag(el, cellId) {
        const handle = el.querySelector('.notebook-cell-drag-handle');
        if (!handle) return;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();

            const before = this.getCells();

            const listRect = this.#cellListEl.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const offsetY = e.clientY - elRect.top;

            el.classList.add('notebook-cell--dragging');

            const placeholder = document.createElement('div');
            placeholder.className = 'notebook-cell-placeholder';
            placeholder.style.height = `${elRect.height}px`;
            placeholder.style.width  = `${elRect.width}px`;
            el.parentNode.insertBefore(placeholder, el.nextSibling);

            const onMouseMove = (ev) => {
                el.style.top = `${ev.clientY - offsetY}px`;
                el.style.left = `${elRect.left}px`;
                el.style.width = `${elRect.width}px`;

                // Find where to insert placeholder (skip adders and the placeholder itself)
                const siblings = [...this.#cellListEl.children].filter(c =>
                    c !== el &&
                    !c.classList.contains('notebook-cell-placeholder') &&
                    !c.classList.contains('doc-notebook__divider')
                );
                for (const sibling of siblings) {
                    const sr = sibling.getBoundingClientRect();
                    if (ev.clientY < sr.top + sr.height / 2) {
                        this.#cellListEl.insertBefore(placeholder, sibling);
                        return;
                    }
                }
                this.#cellListEl.appendChild(placeholder);
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                el.classList.remove('notebook-cell--dragging');
                el.style.top = '';
                el.style.left = '';
                el.style.width = '';

                this.#cellListEl.insertBefore(el, placeholder);
                placeholder.remove();

                // Rebuild cells array from DOM order
                const newOrder = [];
                for (const child of this.#cellListEl.children) {
                    const id = child.dataset?.cellId;
                    if (id) {
                        const cell = this.#cells.find(c => c.id === id);
                        if (cell) newOrder.push(cell);
                    }
                }

                const orderChanged = newOrder.some((c, i) => c.id !== before[i]?.id);
                if (orderChanged) {
                    this.#cells = newOrder;
                    const after = this.getCells();
                    this.#undoManager.push({
                        description: 'Reorder cells',
                        undo: async () => { await this.update({ cells: before }); this.#markDirty(); },
                        redo: async () => { await this.update({ cells: after }); this.#markDirty(); },
                    });
                    this.#markDirty();
                }
                this.#syncAdders();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
}
