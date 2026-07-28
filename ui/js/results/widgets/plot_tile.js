/**
 * plot_tile.js
 *
 * Dashboard tile that renders multi-subplot Plotly charts using the same
 * data model as PlotCell (notebook).  Supports multi-axis, multi-series,
 * dual Y-axes, stacked areas, streaming live-update, and all chart types.
 *
 * Config is the PlotCell data format:
 *   { layout, subplots: [{ id, displayName, chartType, yAxes, legendPosition, ... }] }
 *
 * Configuration is handled by the side-panel in SimulationDashboardTab,
 * so getConfigSchema() returns null.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';
import {
    purge as plotlyPurge,
} from '../../charting/plotly_wrapper.js';
import {
    buildTrace,
    buildYAxisLayout,
    buildLegendLayout,
    buildOverlayShapes,
} from '../../charting/chart_types.js';
import {
    PLOT_LAYOUTS,
    makeDefaultSubplot,
    migrateData,
    applyNanHandling,
} from '../../notebook/cells/plot_cell.js';
import { openPlotPopoutWindow } from '../../ui/components/plot_popout_window.js';
import { strideDownsampleShared } from '../../charting/downsample.js';

/** Max points fed to Plotly per series. A long live run accumulates
 *  thousands of points; redrawing all of them every refresh is what makes
 *  a running dashboard stutter. Decimating to this cap (shared indices
 *  across the time axis + every series, so alignment/gaps survive) bounds
 *  Plotly.react() cost regardless of run length. The full-resolution data
 *  stays in #flatResults for pop-out / export. */
const RENDER_MAX_POINTS = 2000;

export class PlotTile extends TileBase {
    static TYPE = 'plot';
    static TITLE = 'Plot';
    static ICON = 'monitoring';
    static DESCRIPTION = 'Multi-series chart with subplots and dual Y-axes';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static SUPPORTS_COMPARISON = true;

    /** @type {HTMLElement[]} One chart div per subplot slot */
    #chartDivs = [];

    /** @type {{ series: object, time: number[] }|null} Flat series dict for rendering */
    #flatResults = null;

    /** @type {object|null} Actuals overlay data { varName: { years, values } } */
    #actuals = null;

    /** @type {ResizeObserver|null} */
    #resizeObserver = null;

    getDefaultConfig() {
        return migrateData({
            layout: '1x1',
            subplots: [makeDefaultSubplot(0)],
        });
    }

    /** Config handled by side panel, not schema modal */
    getConfigSchema() {
        return { fields: [] };
    }

    // ─── Mount override: build grid layout inside tile content ────────────────

    mount(container) {
        super.mount(container);

        // Show display name from first subplot (or fall back to "Plot")
        this.#syncTitle();

        // Double-click on content → expand to new window
        this.contentElement?.addEventListener('dblclick', (e) => {
            if (e.target.closest('.modebar, .js-plotly-plot .nsewdrag, .js-plotly-plot .drag')) return;
            e.stopPropagation();
            this._onExpandClick();
        });

        this.#buildGrid();
        this.#observeResize();
    }

    /** Sync tile header title with the first subplot displayName. */
    #syncTitle() {
        const data = migrateData(this.config);
        const name = data.subplots?.[0]?.displayName;
        this.setTitle(name || 'Plot');
    }

    #buildGrid() {
        if (!this.contentElement) return;
        this.contentElement.innerHTML = '';
        this.#chartDivs = [];

        const data = migrateData(this.config);
        const tmpl = PLOT_LAYOUTS[data.layout] || PLOT_LAYOUTS['1x1'];

        const grid = document.createElement('div');
        grid.className = 'plot-tile-grid';
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = tmpl.grid.columns;
        grid.style.gridTemplateRows = tmpl.grid.rows;
        grid.style.gap = '2px';
        grid.style.height = '100%';
        grid.style.width = '100%';

        for (let i = 0; i < tmpl.slots; i++) {
            const div = document.createElement('div');
            div.className = 'plot-tile-chart';
            div.style.gridArea = tmpl.areas[i].gridArea;
            div.style.minHeight = '0';
            grid.appendChild(div);
            this.#chartDivs.push(div);
        }

        this.contentElement.appendChild(grid);
    }

    #observeResize() {
        if (this.#resizeObserver) this.#resizeObserver.disconnect();
        this.#resizeObserver = createRafResizeObserver(() => this.#resizePlots());
        if (this.contentElement) this.#resizeObserver.observe(this.contentElement);
    }

    #resizePlots() {
        if (!window.Plotly) return;
        for (const div of this.#chartDivs) {
            if (!div.offsetParent && !div.getClientRects().length) continue;
            Plotly.Plots.resize(div).catch(() => {});
        }
    }

    // ─── Render from analytics data ──────────────────────────────────────────

    render(analyticsData) {
        if (!analyticsData) return;
        this.#flatResults = this.#analyticsToFlat(analyticsData);
        this.#renderAllCharts();
    }

    update(data, config) {
        if (config) {
            const migrated = migrateData(config);
            this.config = migrated;
            this.#syncTitle();
            // Rebuild grid if layout changed
            this.#buildGrid();
        }
        if (data !== undefined) this.data = data;
        if (this.data) {
            this.#flatResults = this.#analyticsToFlat(this.data);
        }
        if (this.#flatResults) this.#renderAllCharts();
    }

    /**
     * Set actuals/observed overlay data and re-render.
     * @param {object} actuals  { varName: { years: number[], values: number[] } }
     */
    setActuals(actuals) {
        this.#actuals = actuals;
        if (this.#flatResults) this.#renderAllCharts();
    }

    // ─── Streaming live-update ───────────────────────────────────────────────

    /**
     * Accept streaming delta data for live chart updates.
     * @param {{ time: number[], stocks: Object, indicators: Object }} streamingData
     */
    renderStreaming(streamingData) {
        if (!streamingData) return;
        const series = {};
        for (const bucket of [streamingData.stocks, streamingData.flows, streamingData.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                series[key] = val;
                // Add bare-name alias for namespace-prefixed keys (e.g. "Population.population" → "population")
                const dotIdx = key.indexOf('.');
                if (dotIdx >= 0) {
                    const bare = key.slice(dotIdx + 1);
                    if (!series[bare]) series[bare] = val;
                }
            }
        }
        this.#flatResults = { series, time: streamingData.time ?? [] };
        this.#renderAllCharts();
    }

    // ─── Chart rendering (mirrors PlotCell logic) ────────────────────────────

    #renderAllCharts() {
        if (!this.#flatResults || !window.Plotly) return;

        const data = migrateData(this.config);
        const subplots = data.subplots ?? [];

        // Decimate once for the whole tile (all subplots share #flatResults)
        // so every series is drawn at the same, bounded resolution.
        const full = this.#flatResults;
        const view = (full.time && full.time.length > RENDER_MAX_POINTS)
            ? strideDownsampleShared(full.time, full.series, RENDER_MAX_POINTS)
            : full;

        for (let i = 0; i < this.#chartDivs.length; i++) {
            const chartDiv = this.#chartDivs[i];
            const sp = subplots[i];
            if (!chartDiv) continue;
            if (!sp) {
                chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:16px;">No subplot configured.</div>';
                continue;
            }
            this.#renderSubplotChart(chartDiv, sp, view);
        }
    }

    #renderSubplotChart(chartDiv, sp, flat = this.#flatResults) {
        const { time, series } = flat;
        const traces = [];
        const layoutAxes = {};
        const yRefByAxisId = {};
        let axisCount = 0;

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
                showGrid: sp.yAxes.length === 1,
                axisPosition: axisCount > 1 ? (axis.position === 'right' ? 1 : 0) : null,
            });

            for (const s of axis.series) {
                if (!s.variable) continue;
                // Try exact variable name, then bare (without namespace prefix)
                let rawY = series?.[s.variable];
                if (!rawY) {
                    const dotIdx = s.variable.indexOf('.');
                    if (dotIdx >= 0) {
                        rawY = series?.[s.variable.slice(dotIdx + 1)];
                    }
                }
                if (!rawY) continue;

                // Scenario-delta mode: subtract / normalise vs a baseline scenario in
                // comparisonData.  Config:
                //   sp.deltaMode: 'off' | 'subtract' | 'relative' | 'ratio'
                //   sp.deltaBaselineScenarioId: id in comparisonData (optional; defaults to first)
                rawY = this.#applyDelta(rawY, s.variable, sp);

                // Rebase mode: divide by value at sp.rebaseYear and multiply by 100
                // → indexed view (rebaseYear = 100).  Useful for like-for-like growth.
                rawY = this.#applyRebase(rawY, time, sp.rebaseYear);

                const y = Array.isArray(rawY) ? applyNanHandling(rawY, sp.nanHandling ?? 'gap', time) : rawY;
                traces.push(buildTrace({
                    chartType: sp.chartType || 'line',
                    x: time,
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
            // Callers may override the empty-state text (e.g. the live
            // dashboard shows "Collecting data\u2026" while a run is producing its
            // first ticks). Falls back to the static prompt otherwise.
            const msg = this.data?.noDataMessage || 'No data \u2014 run simulation first.';
            chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:16px;font-size:11px;"></div>';
            chartDiv.firstChild.textContent = msg;
            return;
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
            margin: { t: 8, r: 20, b: 30, l: 50 },
            hoverlabel: {
                bgcolor: '#1e2228',
                bordercolor: '#444444',
                font: { family: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', color: '#cccccc' },
            },
        };

        Plotly.react(chartDiv, traces, layout, { responsive: true, displayModeBar: false });
    }

    // ─── Expand to new window ───────────────────────────────────────────────

    _onExpandClick() {
        if (!this.#flatResults) return;

        const data = migrateData(this.config);
        const title = data.subplots?.[0]?.displayName || 'Plot';

        openPlotPopoutWindow({
            id: `tile-${this.id}`,
            title,
            plotConfig: data,
            getResults: () => this.#flatResults,
            services: { eventBus: this.eventBus, logger: null },
            actuals: this.#actuals,
        });
    }

    // ─── Scenario-delta helpers ──────────────────────────────────────────────

    /**
     * Apply delta mode to a series by subtracting / relativising against a
     * baseline scenario loaded into this.comparisonData.
     *
     * Modes:
     *   'off'       → no change
     *   'subtract'  → series - baseline
     *   'relative'  → (series - baseline) / baseline   (fraction change)
     *   'ratio'     → series / baseline                (1 = identical)
     */
    #applyDelta(rawY, variable, sp) {
        const mode = sp.deltaMode;
        if (!mode || mode === 'off' || !this.comparisonData || this.comparisonData.size === 0) return rawY;
        if (!Array.isArray(rawY)) return rawY;

        const baseline = this.#findBaselineSeries(variable, sp.deltaBaselineScenarioId);
        if (!baseline) return rawY;

        const n = Math.min(rawY.length, baseline.length);
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            const a = rawY[i], b = baseline[i];
            if (!Number.isFinite(a) || !Number.isFinite(b)) { out[i] = NaN; continue; }
            switch (mode) {
                case 'subtract': out[i] = a - b; break;
                case 'relative': out[i] = Math.abs(b) < 1e-12 ? NaN : (a - b) / b; break;
                case 'ratio':    out[i] = Math.abs(b) < 1e-12 ? NaN : a / b; break;
                default:         out[i] = a;
            }
        }
        return out;
    }

    #applyRebase(rawY, time, rebaseYear) {
        if (rebaseYear == null || !Array.isArray(rawY) || !time?.length) return rawY;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < time.length; i++) {
            const d = Math.abs(time[i] - rebaseYear);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        const ref = rawY[best];
        if (!Number.isFinite(ref) || Math.abs(ref) < 1e-12) return rawY;
        return rawY.map(v => Number.isFinite(v) ? 100 * v / ref : NaN);
    }

    #findBaselineSeries(variable, baselineId) {
        if (!this.comparisonData) return null;
        let entry = null;
        if (baselineId && this.comparisonData.has(baselineId)) {
            entry = this.comparisonData.get(baselineId);
        } else {
            entry = this.comparisonData.values().next().value;
        }
        if (!entry?.analytics) return null;
        const a = entry.analytics;
        const look = (k) => {
            const src = a.stocks?.[k] ?? a.indicators?.[k] ?? a.flows?.[k];
            if (!src) return null;
            return Array.isArray(src) ? src : (src.mean ?? src.p50 ?? null);
        };
        let s = look(variable);
        if (!s && variable.includes('.')) s = look(variable.slice(variable.indexOf('.') + 1));
        return s;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Convert analytics { time, stocks, flows, indicators } to flat { series, time }.
     */
    #analyticsToFlat(analytics) {
        const series = {};
        for (const bucket of [analytics.stocks, analytics.flows, analytics.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                const resolved = Array.isArray(val) ? val : (val.mean ?? val.p50 ?? []);
                series[key] = resolved;
                // Add bare-name alias for namespace-prefixed keys
                const dotIdx = key.indexOf('.');
                if (dotIdx >= 0) {
                    const bare = key.slice(dotIdx + 1);
                    if (!series[bare]) series[bare] = resolved;
                }
            }
        }
        return { series, time: analytics.time ?? [] };
    }

    // ─── Cleanup ─────────────────────────────────────────────────────────────

    dispose() {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        for (const div of this.#chartDivs) {
            if (div) plotlyPurge(div);
        }
        this.#chartDivs = [];
        this.#flatResults = null;
        super.dispose();
    }
}

// Auto-register
registerWidget(PlotTile);
