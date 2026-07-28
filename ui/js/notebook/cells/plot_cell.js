/**
 * PlotCell — inline plot cell with multi-layout subplot support.
 *
 * Config is rendered externally in the application right panel via
 * getConfigBinding() — called by the parent (SimulationDocTab, ScenarioFileEditor)
 * when this cell is selected.
 *
 * Display — inline Plotly chart grid (rendered after simulation)
 *
 * Data model:
 *   {
 *     layout: '1x1'|'1x2'|'2x1'|'2x2'|'1x3'|'wide-top'|'wide-bottom'
 *     caption:     string          — plot-level title (rendered above the chart grid)
 *     description: string          — figure description (rendered below, with "Figure N:" prefix)
 *     subplots: [{
 *       id:             string
 *       displayName:    string     — subplot caption (rendered above each subplot chart)
 *       chartType:      'line'|'area'|'scatter'|'bar'|'phase'|'area-stacked'
 *       legendPosition: 'hidden'|'bottom'|'top'|'left'|'right'
 *       yAxes: [{ id, label, scale, position, min, max, series: [{
 *         id, variable, label, color, lineWidth, lineStyle, stackGroup,
 *         overlay?: { etlKey, label, color, lineStyle, lineWidth, mode }
 *       }] }]
 *       interpolation:  'auto'|'linear'|'step'|'cubic'
 *       nanHandling:    'gap'|'zero'|'hold'|'interpolate'
 *       showDataPoints: boolean
 *     }]
 *   }
 */

import { CellBase } from './cell_base.js';
import { getSeriesColor } from '../../charting/plotly_wrapper.js';
import { buildTrace, buildYAxisLayout, buildLegendLayout, buildOverlayShapes } from '../../charting/chart_types.js';
import { markdownToHtml } from './markdown_preview.js';
import { renderPlotConfig } from '../../charting/plot_config_panel.js';

let _uid = 0;
function uid(prefix = 'p') { return `${prefix}-${++_uid}-${Date.now().toString(36)}`; }

/**
 * Apply NaN handling strategy to a data array.
 * @param {number[]} data
 * @param {'gap'|'zero'|'hold'|'interpolate'} strategy
 * @param {number[]} xData  — for interpolation
 * @returns {Array}
 */
function applyNanHandling(data, strategy, xData) {
    const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));

    if (strategy === 'zero') return data.map(v => isMissing(v) ? 0 : v);

    if (strategy === 'hold') {
        const result = [];
        let last = null;
        for (const v of data) {
            if (isMissing(v)) result.push(last);
            else { last = v; result.push(v); }
        }
        return result;
    }

    if (strategy === 'interpolate') {
        const result = [...data];
        for (let i = 0; i < result.length; i++) {
            if (!isMissing(result[i])) continue;
            let left = -1, right = -1;
            for (let j = i - 1; j >= 0; j--) { if (!isMissing(result[j])) { left = j; break; } }
            for (let j = i + 1; j < result.length; j++) { if (!isMissing(result[j])) { right = j; break; } }
            if (left >= 0 && right >= 0 && xData) {
                const frac = (xData[i] - xData[left]) / (xData[right] - xData[left]);
                result[i] = result[left] + frac * (result[right] - result[left]);
            } else if (left >= 0) {
                result[i] = result[left];
            } else if (right >= 0) {
                result[i] = result[right];
            } else {
                result[i] = null;
            }
        }
        return result;
    }

    // 'gap' (default) — replace with null for Plotly gap rendering
    return data.map(v => isMissing(v) ? null : v);
}

// ─── Layout templates (matching figure_cell.js) ─────────────────────────────

const PLOT_LAYOUTS = Object.freeze({
    '1x1':         { label: 'Single',        slots: 1, grid: { columns: '1fr',       rows: '1fr'     }, areas: [{ slot: 0, gridArea: '1/1/2/2' }] },
    '1x2':         { label: 'Side by side',   slots: 2, grid: { columns: '1fr 1fr',   rows: '1fr'     }, areas: [{ slot: 0, gridArea: '1/1/2/2' }, { slot: 1, gridArea: '1/2/2/3' }] },
    '2x1':         { label: 'Stacked',        slots: 2, grid: { columns: '1fr',       rows: '1fr 1fr' }, areas: [{ slot: 0, gridArea: '1/1/2/2' }, { slot: 1, gridArea: '2/1/3/2' }] },
    '2x2':         { label: '2\u00d72 Grid',  slots: 4, grid: { columns: '1fr 1fr',   rows: '1fr 1fr' }, areas: [{ slot: 0, gridArea: '1/1/2/2' }, { slot: 1, gridArea: '1/2/2/3' }, { slot: 2, gridArea: '2/1/3/2' }, { slot: 3, gridArea: '2/2/3/3' }] },
    '1x3':         { label: 'Three columns',  slots: 3, grid: { columns: '1fr 1fr 1fr', rows: '1fr'   }, areas: [{ slot: 0, gridArea: '1/1/2/2' }, { slot: 1, gridArea: '1/2/2/3' }, { slot: 2, gridArea: '1/3/2/4' }] },
    'wide-top':    { label: '1 + 2',          slots: 3, grid: { columns: '1fr 1fr',   rows: '1fr 1fr' }, areas: [{ slot: 0, gridArea: '1/1/2/3' }, { slot: 1, gridArea: '2/1/3/2' }, { slot: 2, gridArea: '2/2/3/3' }] },
    'wide-bottom': { label: '2 + 1',          slots: 3, grid: { columns: '1fr 1fr',   rows: '1fr 1fr' }, areas: [{ slot: 0, gridArea: '1/1/2/2' }, { slot: 1, gridArea: '1/2/2/3' }, { slot: 2, gridArea: '2/1/3/3' }] },
});

function makeDefaultSubplot(index) {
    return {
        id: uid('sp'),
        displayName: '',
        chartType: 'line',
        legendPosition: 'hidden',
        interpolation: 'linear',
        nanHandling: 'gap',
        showDataPoints: false,
        showHpTrend: false,
        showHpCycle: false,
        hpLambda: 1600,
        xAxis: { useTime: true, variable: '' },
        zAxis: null,
        yAxes: [{
            id: uid('y'),
            label: '',
            scale: 'linear',
            position: 'left',
            min: null,
            max: null,
            step: null,
            series: [],
        }],
    };
}

function migrateData(data) {
    // Already in multi-layout format
    if (data?.layout && Array.isArray(data?.subplots)) {
        // Migrate caption → description (old field name)
        if ('caption' in data && !('description' in data)) {
            data.description = data.caption;
            data.caption = '';
        }
        return data;
    }

    // Migrate legacy single-chart format → multi-layout with one subplot
    const legacySingle = migrateSingleChart(data);
    return {
        layout: '1x1',
        subplots: [{ id: uid('sp'), ...legacySingle }],
        caption: '',
        description: data?.caption ?? data?.description ?? '',
        doc: data?.doc ?? '',
    };
}

/** Migrate legacy flat series[]/variables[] to yAxes[] single-chart format. */
function migrateSingleChart(data) {
    if (data?.yAxes) {
        return {
            displayName:    data.displayName ?? '',
            chartType:      data.chartType ?? 'line',
            legendPosition: data.legendPosition ?? 'hidden',
            interpolation:  data.interpolation ?? 'linear',
            nanHandling:    data.nanHandling ?? 'gap',
            showDataPoints: data.showDataPoints ?? false,
            yAxes: data.yAxes,
        };
    }

    const series = data?.series ?? data?.variables?.map((v, i) => ({
        variable: v, label: '', color: getSeriesColor(i),
    })) ?? [];

    return {
        displayName:    data?.title ?? data?.displayName ?? '',
        chartType:      data?.chartType ?? data?.widgetType ?? 'line',
        legendPosition: data?.legendPosition ?? 'hidden',
        interpolation:  data?.interpolation ?? 'linear',
        nanHandling:    data?.nanHandling ?? 'gap',
        showDataPoints: data?.showDataPoints ?? false,
        yAxes: [{
            id: uid('y'),
            label: data?.yLabel ?? '',
            scale: 'linear',
            position: 'left',
            min: null,
            max: null,
            series: series.map((s, i) => ({
                id: s.id ?? uid('s'),
                variable: s.variable ?? '',
                label: s.label ?? '',
                color: s.color ?? getSeriesColor(i),
                lineWidth: s.lineWidth ?? 2,
                lineStyle: s.lineStyle ?? 'solid',
                stackGroup: s.stackGroup ?? null,
                ...(s.overlay ? { overlay: s.overlay } : {}),
            })),
        }],
    };
}

export class PlotCell extends CellBase {
    _activeTab = 'display';
    #data = null;
    /** @type {HTMLElement[]} One chart div per subplot slot */
    #chartDivs = [];
    #lastResults = null;
    /** @type {object|null} Actuals overlay data { seriesId: { years, values } } */
    #actuals = null;
    /** @type {Array|null} Cached overlay sources from ETL */
    #overlaySources = null;
    #docHandle = null;
    #docEditing = false;

    /** @type {Function|null} Paper-mode scenario provider for per-series scenario selector */
    #scenarioProvider = null;

    /** @type {{ dashboardPath: string, tileIndex: number }|null} Dashboard link (shared config) */
    #linked = null;

    getLastResults() { return this.#lastResults; }
    getActuals() { return this.#actuals; }

    refreshContent() {
        this.#updateCaptionDisplay();
        this.#updateDescriptionDisplay();
        this.#updateSubplotCaptions();
    }

    _getTabs() {
        return [{ id: 'display', label: 'Display' }];
    }

    _getExtraActions() {
        // Check cell data directly — this runs before renderBody sets #linked
        const data = this.#linked ?? this._cell?.data;
        if (data?.dashboardPath) {
            return [
                { action: 'open-dashboard', icon: 'dashboard_customize', title: 'Open source dashboard' },
            ];
        }
        // Unlinked dashboard-ref cells cannot be added to a dashboard — nothing to add
        if (this._cell?.type === 'dashboard-ref') return [];
        return [
            { action: 'add-to-dashboard', icon: 'dashboard_customize', title: 'Add to Dashboard' },
        ];
    }

    _onExtraAction(action) {
        if (action === 'open-dashboard') {
            const path = this.#linked?.dashboardPath ?? this._cell?.data?.dashboardPath;
            if (path) {
                this.eventBus?.emit?.('scenario:request-open-dashboard', { dashboardPath: path });
            }
        } else if (action === 'add-to-dashboard') {
            this.eventBus?.emit?.('cell:add-to-dashboard', {
                cellType: 'plot',
                cellId: this._cell.id,
                config: this.getData(),
            });
        }
    }

    async renderBody(bodyEl, cell) {
        // Linked mode: config lives in a dashboard tile, cell stores only the pointer
        if (cell.data?.dashboardPath && cell.data?.tileIndex >= 0) {
            this.#linked = { dashboardPath: cell.data.dashboardPath, tileIndex: cell.data.tileIndex };
            const tileConfig = await this.#resolveDashboardConfig();
            this.#data = migrateData({
                ...tileConfig,
                caption: cell.data.caption ?? '',
                description: cell.data.description ?? cell.data.caption ?? '',
                doc: cell.data.doc ?? '',
            });
        } else {
            this.#linked = null;
            this.#data = migrateData(cell.data);
        }

        // Unlinked dashboard-ref cell — render picker empty state, no plot grid
        if (cell.type === 'dashboard-ref' && !this.#linked) {
            bodyEl.tabIndex = -1;
            bodyEl.style.outline = 'none';
            bodyEl.innerHTML = `
                <div class="dashboard-ref-cell__empty">
                    <span class="material-symbols-outlined">dashboard_customize</span>
                    <div class="dashboard-ref-cell__empty-title">Link a dashboard tile</div>
                    <div class="dashboard-ref-cell__empty-hint">Select a dashboard and tile in the right panel to embed it here.</div>
                </div>
            `;
            return;
        }

        // Make body focusable so clicking the chart area triggers focusin → cell selection
        bodyEl.tabIndex = -1;
        bodyEl.style.outline = 'none';

        bodyEl.innerHTML = `
            <div class="plot-cell-output" data-panel="display">
                <div class="plot-cell-caption"></div>
                <div class="plot-cell-grid"></div>
                <div class="plot-cell-empty">Click to configure in the right panel</div>
                <div class="plot-cell-description"></div>
                <div class="plot-doc-section">
                    <div class="plot-doc-preview"></div>
                    <div class="plot-doc-editor" hidden></div>
                </div>
            </div>
        `;

        // Doc preview click → enter edit mode
        const docPreview = bodyEl.querySelector('.plot-doc-preview');
        docPreview.addEventListener('click', () => this.#enterDocEdit());

        this.#renderDocPreview();
        this.#updateCaptionDisplay();
        this.#updateDescriptionDisplay();
        this.#buildDisplayGrid(bodyEl.querySelector('.plot-cell-grid'));

        // Hide empty hint if the cell already has series configured
        const hasSeries = this.#data.subplots?.some(sp =>
            sp.yAxes?.some(ax => ax.series?.length > 0));
        if (hasSeries) this.#hideEmptyHint();
    }

    #hideEmptyHint() {
        const emptyEl = this._container?.querySelector('.plot-cell-empty');
        if (emptyEl) emptyEl.style.display = 'none';
    }

    /**
     * Returns a binding object for rendering the plot config externally
     * (e.g. in the application right panel).
     * @returns {{ data: object, symbolProvider: Function, onChange: Function, onLayoutChange: Function }}
     */
    getConfigBinding() {
        // Unlinked dashboard-ref cell — show a dashboard/tile picker
        if (this._cell?.type === 'dashboard-ref' && !this.#linked) {
            return {
                title: 'Dashboard Reference',
                icon: 'dashboard_customize',
                renderConfig: (container) => this.#renderPickerConfig(container),
            };
        }
        if (this.#linked) {
            return {
                data: this.#data,
                title: 'Dashboard Plot',
                icon: 'dashboard_customize',
                linked: this.#linked,
                renderConfig: (container) => {
                    // Dashboard link banner
                    this.#renderLinkedBanner(container);
                    // Reuse the standard plot config panel (read-only — no onChange)
                    renderPlotConfig(container, this.#data, {
                        symbolProvider: () => this._getSymbols(),
                        showCaption: true,
                        overlaySourceProvider: () => this.#fetchOverlaySources(),
                        scenarioProvider: this.#scenarioProvider,
                    });
                },
            };
        }
        return {
            data: this.#data,
            symbolProvider: () => this._getSymbols(),
            onChange: () => {
                this.#updateCaptionDisplay();
                this.#updateDescriptionDisplay();
                this.#updateSubplotCaptions();
                this.#hideEmptyHint();
                this.#notify();
            },
            onLayoutChange: () => {
                const gridEl = this._container?.querySelector('.plot-cell-grid');
                if (gridEl) this.#buildDisplayGrid(gridEl);
            },
            title: 'Plot Config',
            icon: 'monitoring',
            renderConfig: (container) => {
                renderPlotConfig(container, this.#data, {
                    onChange: () => {
                        this.#updateCaptionDisplay();
                        this.#updateDescriptionDisplay();
                        this.#updateSubplotCaptions();
                        this.#hideEmptyHint();
                        this.#notify();
                    },
                    onLayoutChange: () => {
                        const gridEl = this._container?.querySelector('.plot-cell-grid');
                        if (gridEl) this.#buildDisplayGrid(gridEl);
                    },
                    symbolProvider: () => this._getSymbols(),
                    showCaption: true,
                    overlaySourceProvider: () => this.#fetchOverlaySources(),
                    scenarioProvider: this.#scenarioProvider,
                });
            },
        };
    }

    /**
     * Set the scenario provider callback (paper mode only).
     * When set, the plot config panel shows a per-series scenario dropdown.
     * @param {Function|null} fn — () => Array<{path, name, status}>
     */
    setScenarioProvider(fn) {
        this.#scenarioProvider = fn;
    }

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

    // ─── Display grid ──────────────────────────────────────────────────────────

    #buildDisplayGrid(gridEl) {
        gridEl.innerHTML = '';
        this.#chartDivs = [];

        const tmpl = PLOT_LAYOUTS[this.#data.layout] || PLOT_LAYOUTS['1x1'];
        gridEl.style.display = 'grid';
        gridEl.style.gridTemplateColumns = tmpl.grid.columns;
        gridEl.style.gridTemplateRows = tmpl.grid.rows;
        gridEl.style.gap = '4px';
        gridEl.style.height = '100%';
        gridEl.style.minHeight = '300px';

        for (let i = 0; i < tmpl.slots; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'plot-cell-subplot-wrapper';
            wrapper.style.gridArea = tmpl.areas[i].gridArea;

            // Subplot caption (displayName)
            const capEl = document.createElement('div');
            capEl.className = 'plot-cell-subplot-caption';
            const sp = this.#data.subplots?.[i];
            const name = sp?.displayName ?? '';
            capEl.textContent = name;
            capEl.style.display = name ? '' : 'none';
            wrapper.appendChild(capEl);

            const div = document.createElement('div');
            div.className = 'plot-cell-chart';
            wrapper.appendChild(div);

            gridEl.appendChild(wrapper);
            this.#chartDivs.push(div);
        }
    }

    #updateCaptionDisplay() {
        const captionEl = this._container?.querySelector('.plot-cell-caption');
        if (!captionEl) return;
        const caption = this.#data.caption ?? '';
        if (!caption) {
            captionEl.textContent = '';
            captionEl.style.display = 'none';
            return;
        }
        captionEl.textContent = caption;
        captionEl.style.display = '';
    }

    #updateSubplotCaptions() {
        const wrappers = this._container?.querySelectorAll('.plot-cell-subplot-wrapper') ?? [];
        wrappers.forEach((wrapper, i) => {
            const capEl = wrapper.querySelector('.plot-cell-subplot-caption');
            if (!capEl) return;
            const name = this.#data.subplots?.[i]?.displayName ?? '';
            capEl.textContent = name;
            capEl.style.display = name ? '' : 'none';
        });
    }

    #updateDescriptionDisplay() {
        const descEl = this._container?.querySelector('.plot-cell-description');
        if (!descEl) return;
        const description = this.#data.description ?? '';
        if (!description) {
            descEl.textContent = '';
            descEl.style.display = 'none';
            return;
        }
        const numbering = this._props?.getNumbering?.() ?? new Map();
        const num = numbering.get(this._cell.id);
        descEl.textContent = num?.displayNum
            ? `Figure ${num.displayNum}: ${description}`
            : description;
        descEl.style.display = '';
    }

    // ─── Documentation (inline below chart) ───────────────────────────────────

    #renderDocPreview() {
        const preview = this._container?.querySelector('.plot-doc-preview');
        if (!preview) return;
        const doc = this.#data.doc ?? '';
        if (doc.trim()) {
            preview.innerHTML = markdownToHtml(doc);
        } else {
            preview.innerHTML = '<span class="plot-doc-placeholder">Click to add documentation\u2026</span>';
        }
    }

    #enterDocEdit() {
        if (this.#docEditing) return;
        this.#docEditing = true;

        const preview = this._container?.querySelector('.plot-doc-preview');
        const editorContainer = this._container?.querySelector('.plot-doc-editor');
        if (!preview || !editorContainer) return;

        preview.hidden = true;
        editorContainer.hidden = false;

        if (!this.#docHandle) {
            this.#docHandle = this._editorFactory?.createMarkdownEditor?.(editorContainer, this.#data.doc ?? '');
            if (this.#docHandle) {
                this._disposers.push(this.#docHandle.onDidChange(() => {
                    this.#data.doc = this.#docHandle.getValue();
                    this.#notify();
                }));
            }
        } else {
            this.#docHandle.setValue(this.#data.doc ?? '');
        }

        this.#docHandle?.focus?.();

        // Blur detection
        const onFocusOut = () => {
            requestAnimationFrame(() => {
                if (!editorContainer.contains(document.activeElement)) {
                    editorContainer.removeEventListener('focusout', onFocusOut);
                    this.#exitDocEdit();
                }
            });
        };
        editorContainer.addEventListener('focusout', onFocusOut);
    }

    #exitDocEdit() {
        if (!this.#docEditing) return;
        this.#docEditing = false;

        if (this.#docHandle) {
            this.#data.doc = this.#docHandle.getValue?.() ?? '';
        }

        const preview = this._container?.querySelector('.plot-doc-preview');
        const editorContainer = this._container?.querySelector('.plot-doc-editor');

        if (editorContainer) editorContainer.hidden = true;
        if (preview) {
            preview.hidden = false;
            this.#renderDocPreview();
        }
    }

    // ─── Tab switching ─────────────────────────────────────────────────────────

    _onTabChanged(tabId) {
        if (tabId === 'display' && this.#lastResults) {
            this.#renderAllCharts();
        }
    }

    // ─── Simulation results ────────────────────────────────────────────────────

    renderResults(results) {
        this.#lastResults = results;
        this.#hideEmptyHint();
        this.#renderAllCharts();
        this.#updateCaptionDisplay();
        this.#updateDescriptionDisplay();
    }

    /**
     * Set actuals/observed overlay data and re-render.
     * @param {object} actuals  { seriesId: { years: number[], values: number[] } }
     */
    setActuals(actuals) {
        this.#actuals = actuals;
        if (this.#lastResults) this.#renderAllCharts();
    }

    /**
     * Collect overlay specs from all series for actuals fetching.
     * @returns {Array<{seriesId: string, etlKey: string}>}
     */
    getOverlaySpecs() {
        const specs = [];
        for (const sp of this.#data?.subplots ?? []) {
            for (const axis of sp.yAxes ?? []) {
                for (const s of axis.series ?? []) {
                    if (s.overlay?.etlKey && s.id) {
                        specs.push({ seriesId: s.id, etlKey: s.overlay.etlKey });
                    }
                }
            }
        }
        return specs;
    }

    #renderAllCharts() {
        if (!this.#lastResults || !window.Plotly) return;

        const subplots = this.#data.subplots ?? [];
        for (let i = 0; i < this.#chartDivs.length; i++) {
            const chartDiv = this.#chartDivs[i];
            const sp = subplots[i];
            if (!chartDiv) continue;
            if (!sp) {
                chartDiv.innerHTML = '<div class="plot-no-data">No subplot configured.</div>';
                continue;
            }
            this.#renderSubplotChart(chartDiv, sp);
        }
    }

    async #renderSubplotChart(chartDiv, sp) {
        const { time, series } = this.#lastResults;
        const traces = [];
        const layoutAxes = {};
        const yRefByAxisId = {};
        let axisCount = 0;

        // Resolve custom x-axis variable (for phase plots)
        let xData = time;
        if (sp.xAxis && !sp.xAxis.useTime && sp.xAxis.variable) {
            const xVar = sp.xAxis.variable;
            xData = series?.[xVar];
            if (!xData) {
                const dotIdx = xVar.indexOf('.');
                if (dotIdx >= 0) xData = series?.[xVar.slice(dotIdx + 1)];
            }
            if (!xData) xData = time; // fallback
        }

        for (const axis of sp.yAxes) {
            axisCount++;
            const yAxisKey = axisCount === 1 ? 'yaxis' : `yaxis${axisCount}`;
            const yRef = axisCount === 1 ? 'y' : `y${axisCount}`;
            if (axis.id) yRefByAxisId[axis.id] = yRef;

            layoutAxes[yAxisKey] = buildYAxisLayout({
                axisId: yAxisKey,
                title: axis.label || '',
                position: axis.position || 'left',
                scaleType: axis.scale || 'linear',
                min: axis.min,
                max: axis.max,
                showGrid: axisCount === 1,
                axisPosition: axisCount > 1 ? (axis.position === 'right' ? 1 : 0) : null,
            });

            for (const s of axis.series) {
                if (!s.variable) continue;
                // Try result key (paper multi-scenario), exact variable, then bare (without namespace prefix)
                let rawY = series?.[s._resultKey ?? s.variable];
                if (!rawY && s._resultKey) {
                    rawY = series?.[s.variable];
                }
                if (!rawY) {
                    const dotIdx = s.variable.indexOf('.');
                    if (dotIdx >= 0) {
                        rawY = series?.[s.variable.slice(dotIdx + 1)];
                    }
                }
                if (!rawY) continue;

                // rebaseYear transform — index to 100 at that year
                if (sp.rebaseYear != null && Array.isArray(rawY) && time?.length) {
                    let best = 0, bestDiff = Infinity;
                    for (let i = 0; i < time.length; i++) {
                        const d = Math.abs(time[i] - sp.rebaseYear);
                        if (d < bestDiff) { bestDiff = d; best = i; }
                    }
                    const ref = rawY[best];
                    if (Number.isFinite(ref) && Math.abs(ref) > 1e-12) {
                        rawY = rawY.map(v => Number.isFinite(v) ? 100 * v / ref : NaN);
                    }
                }

                const y = Array.isArray(rawY) ? applyNanHandling(rawY, sp.nanHandling ?? 'gap', time) : rawY;
                const seriesTime = s._resultTime ?? xData;
                traces.push(buildTrace({
                    chartType: sp.chartType || 'line',
                    x: seriesTime,
                    y,
                    name: s.label || s.variable,
                    color: s.color,
                    lineWidth: s.lineWidth ?? 2,
                    lineStyle: s.lineStyle ?? 'solid',
                    interpolation: sp.interpolation ?? 'linear',
                    yAxisId: yRef,
                    showMarkers: sp.showDataPoints ?? false,
                    stackGroup: s.stackGroup ?? null,
                }));

                // Per-series overlay trace (ETL actuals)
                if (s.overlay?.etlKey && this.#actuals?.[s.id]) {
                    const act = this.#actuals[s.id];
                    if (act?.years?.length) {
                        const ov = s.overlay;
                        const dashMap = { dashed: 'dash', dotted: 'dot', solid: 'solid' };
                        const isStacked = (sp.chartType || 'line') === 'area-stacked';
                        const ovTrace = {
                            type: 'scatter',
                            mode: ov.mode || 'markers+lines',
                            x: act.years,
                            y: act.values,
                            name: ov.label || `${s.label || s.variable} (actual)`,
                            yaxis: yRef === 'y' ? undefined : yRef,
                            line: {
                                color: ov.color || s.color,
                                width: ov.lineWidth ?? 2,
                                dash: dashMap[ov.lineStyle] || 'dash',
                            },
                            marker: {
                                color: ov.color || s.color,
                                size: 4,
                                symbol: 'circle',
                            },
                            showlegend: true,
                        };
                        // For stacked area charts, overlay traces must also be
                        // stacked (in a separate group) so they align correctly.
                        if (isStacked) {
                            ovTrace.stackgroup = `overlay-${yRef}`;
                            ovTrace.groupnorm = 'fraction';
                            ovTrace.fill = 'none';
                            ovTrace.mode = 'lines';
                        }
                        traces.push(ovTrace);
                    }
                }
            }
        }

        if (traces.length === 0) {
            chartDiv.innerHTML = '<div class="plot-no-data">No data — check variable names or run simulation first.</div>';
            return;
        }

        // HP filter traces (async — calls backend API)
        if ((sp.showHpTrend || sp.showHpCycle) && window.pywebview?.api?.hp_filter) {
            const hpLambda = sp.hpLambda ?? 1600;
            for (const trace of [...traces]) {
                if (trace.type && trace.type !== 'scatter' && trace.type !== 'scattergl') continue;
                try {
                    const hpResult = await window.pywebview.api.hp_filter({
                        data: trace.y,
                        lambda: hpLambda,
                    });
                    if (!hpResult?.ok) continue;
                    const { trend, cycle } = hpResult;
                    const origColor = trace.line?.color || trace.marker?.color || getSeriesColor(0);
                    if (sp.showHpTrend && trend) {
                        traces.push({
                            x: trace.x, y: trend, type: 'scatter', mode: 'lines',
                            name: `${trace.name} (HP Trend)`,
                            yaxis: trace.yaxis || 'y',
                            line: { color: origColor, width: 2, dash: 'dash' },
                            showlegend: true,
                        });
                    }
                    if (sp.showHpCycle && cycle) {
                        traces.push({
                            x: trace.x, y: cycle, type: 'scatter', mode: 'lines',
                            name: `${trace.name} (HP Cycle)`,
                            yaxis: trace.yaxis || 'y',
                            line: { color: origColor, width: 1, dash: 'dot' },
                            showlegend: true,
                        });
                    }
                } catch (_) { /* ignore HP filter failures */ }
            }
        }

        const legend = buildLegendLayout(sp.legendPosition ?? 'hidden');

        // Clip x-axis to simulation time range so overlays don't extend beyond model t0–t1
        const xRange = time?.length >= 2 ? [time[0], time[time.length - 1]] : undefined;

        const { shapes, annotations } = buildOverlayShapes({
            referenceLines: sp.referenceLines,
            shadedBands: sp.shadedBands,
            yRefByAxisId,
        });

        const layout = {
            ...layoutAxes,
            ...(shapes.length ? { shapes } : {}),
            ...(annotations.length ? { annotations } : {}),
            xaxis: {
                title: (sp.xAxis && !sp.xAxis.useTime && sp.xAxis.variable)
                    ? { text: sp.xAxis.variable.replace(/_/g, ' '), font: { size: 11 } }
                    : undefined,
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zerolinecolor: 'rgba(255,255,255,0.06)',
                automargin: true,
                ...(xRange ? { range: xRange } : {}),
            },
            ...legend,
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 10, r: 20, b: 40, l: 50 },
            hoverlabel: {
                bgcolor: '#1e2228',
                bordercolor: '#444444',
                font: { family: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', color: '#cccccc' },
            },
        };

        // Guard: skip if the div is detached or has no dimensions (e.g. during tab switch)
        if (!chartDiv.isConnected || chartDiv.offsetWidth === 0) return;

        try {
            await Plotly.react(chartDiv, traces, layout, { responsive: true, displayModeBar: false });
        } catch (_) {
            // Plotly can throw if the div is removed mid-render (race during tab switch)
        }
    }

    // ─── Data access ───────────────────────────────────────────────────────────

    getData() {
        if (this.#linked) {
            return {
                dashboardPath: this.#linked.dashboardPath,
                tileIndex: this.#linked.tileIndex,
                caption: this.#data.caption ?? '',
                description: this.#data.description ?? '',
                doc: this.#data.doc ?? '',
            };
        }
        return {
            layout: this.#data.layout,
            subplots: this.#data.subplots?.map(sp => ({ ...sp })) ?? [],
            caption: this.#data.caption ?? '',
            description: this.#data.description ?? '',
            doc: this.#data.doc ?? '',
        };
    }

    #notify() { this._notifyChange(this.getData()); }

    dispose() {
        for (const div of this.#chartDivs) {
            if (div && window.Plotly) {
                try { window.Plotly.purge(div); } catch (_) {}
            }
        }
        this.#chartDivs = [];
        this.#docHandle?.dispose();
        this.#docHandle = null;
        super.dispose();
    }

    // ─── Picker panel (unlinked dashboard-ref cells) ───────────────────────

    #renderPickerConfig(container) {
        container.innerHTML = '';

        const project = this._props?.project;
        const paths = project?.dashboardPaths ?? [];

        const wrap = document.createElement('div');
        wrap.className = 'dashboard-ref-cell__picker';

        if (paths.length === 0) {
            wrap.innerHTML = `
                <div class="config-field">
                    <div class="config-field__value">No dashboards in this project. Create one first.</div>
                </div>
            `;
            container.appendChild(wrap);
            return;
        }

        // State: currently selected dashboard + tile (picker-local, committed on "Link")
        let selectedPath = paths[0];
        let selectedIndex = -1;
        let tiles = [];

        const dashField = document.createElement('div');
        dashField.className = 'config-field';
        dashField.innerHTML = `
            <label class="config-field__label">Dashboard</label>
            <select class="config-field__input" data-role="dashboard-select"></select>
        `;
        const dashSel = dashField.querySelector('select');
        for (const p of paths) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p.split('/').pop().replace(/\.dashboard$/, '');
            dashSel.appendChild(opt);
        }

        const tileField = document.createElement('div');
        tileField.className = 'config-field';
        tileField.innerHTML = `
            <label class="config-field__label">Tile</label>
            <select class="config-field__input" data-role="tile-select"><option>Loading…</option></select>
        `;
        const tileSel = tileField.querySelector('select');

        const linkBtn = document.createElement('button');
        linkBtn.className = 'dashboard-ref-cell__config-btn';
        linkBtn.disabled = true;
        linkBtn.innerHTML = '<span class="material-symbols-outlined">link</span> Link';

        wrap.appendChild(dashField);
        wrap.appendChild(tileField);
        wrap.appendChild(linkBtn);
        container.appendChild(wrap);

        const loadTiles = async () => {
            tileSel.innerHTML = '<option>Loading…</option>';
            tileSel.disabled = true;
            linkBtn.disabled = true;
            selectedIndex = -1;

            const content = await project.readFileContent(selectedPath);
            tiles = Array.isArray(content?.tiles) ? content.tiles : [];

            tileSel.innerHTML = '';
            if (tiles.length === 0) {
                tileSel.appendChild(new Option('(dashboard has no tiles)', ''));
                return;
            }
            tiles.forEach((t, i) => {
                const caption = t?.config?.caption || t?.config?.description || t?.config?.stock || t?.config?.variable || '';
                const label = caption
                    ? `#${i} · ${t.type} · ${caption}`
                    : `#${i} · ${t.type}`;
                tileSel.appendChild(new Option(label, String(i)));
            });
            tileSel.disabled = false;
            selectedIndex = 0;
            tileSel.value = '0';
            linkBtn.disabled = false;
        };

        dashSel.addEventListener('change', () => {
            selectedPath = dashSel.value;
            loadTiles();
        });
        tileSel.addEventListener('change', () => {
            const v = parseInt(tileSel.value, 10);
            selectedIndex = Number.isFinite(v) ? v : -1;
            linkBtn.disabled = selectedIndex < 0;
        });
        linkBtn.addEventListener('click', () => {
            if (selectedIndex < 0) return;
            this.#linkToTile(selectedPath, selectedIndex, container);
        });

        loadTiles();
    }

    async #linkToTile(dashboardPath, tileIndex, panelContainer) {
        // Persist link into cell data
        this._notifyChange({
            dashboardPath,
            tileIndex,
            caption: this._cell.data?.caption ?? '',
            description: this._cell.data?.description ?? '',
            doc: this._cell.data?.doc ?? '',
        });

        // Re-render body (now takes the linked branch)
        const bodyEl = this._container?.querySelector('.cell-body');
        if (bodyEl) {
            await this.renderBody(bodyEl, this._cell);
        }

        // Re-bind the right-panel config to the now-linked binding
        if (panelContainer) {
            panelContainer.innerHTML = '';
            const binding = this.getConfigBinding();
            binding?.renderConfig?.(panelContainer);
        }
    }

    // ─── Linked config panel (right panel for dashboard-ref cells) ─────────

    #renderLinkedBanner(container) {
        const dashName = this.#linked.dashboardPath.split('/').pop().replace('.dashboard', '');

        const banner = document.createElement('div');
        banner.className = 'dashboard-ref-cell__config-section';
        banner.innerHTML = `
            <div class="config-field">
                <label class="config-field__label">Linked to</label>
                <div class="config-field__value">${escHtml(dashName)} #${this.#linked.tileIndex}</div>
            </div>
        `;
        container.appendChild(banner);

        const btn = document.createElement('button');
        btn.className = 'dashboard-ref-cell__config-btn';
        btn.innerHTML = '<span class="material-symbols-outlined">open_in_new</span> Open in Dashboard';
        btn.addEventListener('click', () => {
            this.eventBus?.emit?.('scenario:request-open-dashboard', { dashboardPath: this.#linked.dashboardPath });
        });
        container.appendChild(btn);
    }

    // ─── Dashboard link resolution ──────────────────────────────────────────

    /** Whether this cell is linked to a dashboard tile. */
    get isLinked() { return !!this.#linked; }

    /**
     * Resolve plot config from the linked dashboard tile.
     * Returns the tile's config object (same format as PlotCell data), or
     * a fallback empty config if resolution fails.
     */
    async #resolveDashboardConfig() {
        const project = this._props?.project;
        if (!project || !this.#linked) return {};

        try {
            const content = await project.readFileContent(this.#linked.dashboardPath);
            const tile = content?.tiles?.[this.#linked.tileIndex];
            if (!tile) return {};

            // Plot tiles share the exact same config format
            if (tile.type === 'plot') {
                return tile.config ?? {};
            }

            // Non-plot tile types — synthesize a compatible plot config
            return this.#synthesizePlotConfig(tile);
        } catch {
            return {};
        }
    }

    /**
     * Synthesize a PlotCell-compatible config from a non-plot dashboard tile.
     */
    #synthesizePlotConfig(tile) {
        if (tile.type === 'phase-plot') {
            const cfg = tile.config ?? {};
            return {
                layout: '1x1',
                subplots: [{
                    id: uid('sp'),
                    displayName: `${cfg.xVariable ?? '?'} vs ${cfg.yVariable ?? '?'}`,
                    chartType: 'phase',
                    legendPosition: 'hidden',
                    interpolation: 'linear',
                    nanHandling: 'gap',
                    showDataPoints: false,
                    xAxis: { useTime: false, variable: cfg.xVariable ?? '' },
                    yAxes: [{
                        id: uid('y'),
                        label: cfg.yVariable ?? '',
                        scale: 'linear',
                        position: 'left',
                        min: null, max: null,
                        series: [{
                            id: uid('s'),
                            variable: cfg.yVariable ?? '',
                            label: cfg.yVariable?.replace(/_/g, ' ') ?? '',
                            color: getSeriesColor(0),
                            lineWidth: cfg.lineWidth ?? 2,
                            lineStyle: 'solid',
                            stackGroup: null,
                        }],
                    }],
                }],
            };
        }

        if (tile.type === 'stock-flow-decomposition') {
            const cfg = tile.config ?? {};
            const stock = cfg.stock ?? '';
            return {
                layout: '1x1',
                subplots: [{
                    id: uid('sp'),
                    displayName: stock.replace(/_/g, ' '),
                    chartType: 'line',
                    legendPosition: 'top',
                    interpolation: 'linear',
                    nanHandling: 'gap',
                    showDataPoints: false,
                    yAxes: [{
                        id: uid('y'),
                        label: stock.replace(/_/g, ' '),
                        scale: 'linear',
                        position: 'left',
                        min: null, max: null,
                        series: [{
                            id: uid('s'),
                            variable: stock,
                            label: stock.replace(/_/g, ' '),
                            color: getSeriesColor(0),
                            lineWidth: 2,
                            lineStyle: 'solid',
                            stackGroup: null,
                        }],
                    }],
                }],
            };
        }

        // Unknown tile type — empty config
        return {};
    }
}

function esc(s) { return String(s ?? '').replace(/"/g, '&quot;'); }
function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── Shared exports for PlotTile and other consumers ────────────────────────
export { PLOT_LAYOUTS, makeDefaultSubplot, migrateData, applyNanHandling, uid, esc, escHtml };
