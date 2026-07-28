/**
 * lorenz_tile.js
 *
 * Distribution-snapshot chart. Renders any combination of:
 *
 *   - static decile shares (typed in, e.g. Bundesbank HFCS wealth deciles), or
 *   - model-class shares (variables evaluated at a snapshot year, e.g.
 *     worker_income_share / capitalist_income_share), or
 *   - **one or more Lorenz curves**, each built from 10 decile-share variables
 *     (e.g. pre-tax / post-tax / post-transfer overlaid on the same axes).
 *
 * Config:
 *   title              string
 *   snapshotYear       number                 Year for model-variable evaluation
 *   mode               'deciles' | 'classes' | 'both' | 'lorenz'
 *   deciles            [number x 10]          Shares summing to 1 (e.g. HFCS)
 *   decilesLabel       string                 Legend label (e.g. "HFCS 2021")
 *   classes            [{ label, variable, color }]
 *                                            Model variables evaluated at snapshotYear
 *   orientation        'horizontal' | 'vertical'
 *   showLorenzCurve    boolean                Overlay cumulative Lorenz curve
 *   curves             [{ label, color, variables: [10] }]
 *                                            Multi-curve Lorenz mode (each curve
 *                                            built from 10 decile-share variables).
 *                                            When present, rendered as a full-pane
 *                                            Lorenz plot with a 45° equality line.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { purge as plotlyPurge } from '../../charting/plotly_wrapper.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

export class LorenzTile extends TileBase {
    static TYPE = 'lorenz';
    static TITLE = 'Distribution Snapshot';
    static ICON = 'bar_chart';
    static DESCRIPTION = 'Decile/class distribution bars (static or from model variables)';
    static DEFAULT_SIZE = { w: 4, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 8, maxH: 6 };
    static EXPANDABLE = true;

    #chartDiv = null;
    #resizeObserver = null;

    getDefaultConfig() {
        return {
            title: '',
            snapshotYear: null,
            mode: 'deciles',
            deciles: [],
            decilesLabel: '',
            classes: [],
            orientation: 'vertical',
            showLorenzCurve: false,
            curves: [],
        };
    }

    getConfigSchema() {
        return { fields: [] };
    }

    mount(container) {
        super.mount(container);
        if (!this.contentElement) return;
        this.#chartDiv = document.createElement('div');
        this.#chartDiv.style.width = '100%';
        this.#chartDiv.style.height = '100%';
        this.contentElement.appendChild(this.#chartDiv);
        this.#resizeObserver = createRafResizeObserver(() => {
            if (window.Plotly && this.#chartDiv?.offsetParent) {
                Plotly.Plots.resize(this.#chartDiv).catch(() => {});
            }
        });
        this.#resizeObserver.observe(this.contentElement);
        if (this.config.title) this.setTitle(this.config.title);
    }

    render(data) {
        if (!this.#chartDiv || !window.Plotly) return;
        const cfg = this.config;

        // Multi-curve Lorenz mode — dedicated full-pane rendering
        if ((cfg.mode === 'lorenz') || (Array.isArray(cfg.curves) && cfg.curves.length > 0 && cfg.mode !== 'both')) {
            this.#renderMultiLorenz(data);
            return;
        }

        const traces = [];

        // Mode 1: decile shares (static from config)
        if ((cfg.mode === 'deciles' || cfg.mode === 'both') && Array.isArray(cfg.deciles) && cfg.deciles.length === 10) {
            const categories = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10'];
            const values = cfg.deciles.map(v => (Number.isFinite(v) ? v : 0));
            traces.push({
                type: 'bar',
                x: cfg.orientation === 'horizontal' ? values : categories,
                y: cfg.orientation === 'horizontal' ? categories : values,
                orientation: cfg.orientation === 'horizontal' ? 'h' : 'v',
                name: cfg.decilesLabel || 'Deciles',
                marker: { color: this.#gradient(values) },
                hovertemplate: '%{x}: %{y:.1%}<extra>%{fullData.name}</extra>',
            });

            if (cfg.showLorenzCurve) {
                const cumulative = this.#cumulative(values);
                cumulative.unshift(0);
                const xs = cumulative.map((_, i) => i * 10);
                traces.push({
                    type: 'scatter', mode: 'lines', name: 'Lorenz curve',
                    x: xs, y: cumulative,
                    line: { color: '#ffcc3a', width: 2 },
                    xaxis: 'x2', yaxis: 'y2',
                });
                // Diagonal reference
                traces.push({
                    type: 'scatter', mode: 'lines', name: 'Equality',
                    x: [0, 100], y: [0, 1],
                    line: { color: 'rgba(255,255,255,0.3)', width: 1, dash: 'dash' },
                    xaxis: 'x2', yaxis: 'y2', showlegend: false,
                });
            }
        }

        // Mode 2: model classes (variables evaluated at snapshotYear)
        if ((cfg.mode === 'classes' || cfg.mode === 'both') && Array.isArray(cfg.classes) && data) {
            const time = data.time ?? [];
            const idx = this.#timeIndex(time, cfg.snapshotYear);
            const labels = [];
            const values = [];
            const colors = [];
            for (const cls of cfg.classes) {
                const series = this.#resolveSeries(data, cls.variable);
                const v = series?.[idx];
                if (!Number.isFinite(v)) continue;
                labels.push(cls.label || cls.variable);
                values.push(v);
                colors.push(cls.color || '#4aa3ff');
            }
            if (labels.length) {
                traces.push({
                    type: 'bar',
                    x: cfg.orientation === 'horizontal' ? values : labels,
                    y: cfg.orientation === 'horizontal' ? labels : values,
                    orientation: cfg.orientation === 'horizontal' ? 'h' : 'v',
                    name: `Model ${Math.round(time[idx] ?? 0) || ''}`.trim(),
                    marker: { color: colors },
                    hovertemplate: '%{x}: %{y:.1%}<extra>%{fullData.name}</extra>',
                });
            }
        }

        if (traces.length === 0) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:16px;font-size:11px;">No distribution data — configure deciles or classes.</div>';
            return;
        }

        const lorenz = cfg.showLorenzCurve && (cfg.mode === 'deciles' || cfg.mode === 'both');
        const layout = {
            barmode: 'group',
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 10, r: 20, b: 40, l: 60 },
            xaxis: {
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zeroline: false,
                domain: lorenz ? [0, 0.58] : [0, 1],
            },
            yaxis: {
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zeroline: false,
                tickformat: cfg.orientation === 'horizontal' ? undefined : '.0%',
            },
            showlegend: true,
            legend: {
                orientation: 'h', y: -0.2, yanchor: 'top',
                x: 0.5, xanchor: 'center',
                font: { color: '#cccccc', size: 10 },
                bgcolor: 'rgba(0,0,0,0)',
            },
            hoverlabel: {
                bgcolor: '#1e2228', bordercolor: '#444',
                font: { family: 'Inter, sans-serif', color: '#cccccc' },
            },
            ...(lorenz ? {
                xaxis2: { domain: [0.65, 1], gridcolor: 'rgba(255,255,255,0.05)', title: { text: 'Population %', font: { size: 9 } } },
                yaxis2: { anchor: 'x2', tickformat: '.0%', gridcolor: 'rgba(255,255,255,0.05)', title: { text: 'Cumulative share', font: { size: 9 } } },
            } : {}),
        };

        Plotly.react(this.#chartDiv, traces, layout, { responsive: true, displayModeBar: false });
    }

    #renderMultiLorenz(data) {
        const cfg = this.config;
        if (!data) { this.showEmpty('No data'); return; }
        const time = data.time ?? [];
        if (!time.length) { this.showEmpty('No time axis'); return; }

        const idx = this.#timeIndex(time, cfg.snapshotYear);
        const curves = Array.isArray(cfg.curves) ? cfg.curves : [];
        if (curves.length === 0) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;font-size:11px;">Configure curves: [{ label, color, variables: [10] }].</div>';
            return;
        }

        const traces = [];

        // 45° equality reference line
        traces.push({
            type: 'scatter', mode: 'lines',
            x: [0, 1], y: [0, 1],
            name: 'Equality',
            line: { color: 'rgba(255,255,255,0.3)', width: 1, dash: 'dash' },
            hoverinfo: 'skip',
        });

        const xs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

        for (const curve of curves) {
            const vars = Array.isArray(curve.variables) ? curve.variables : [];
            if (vars.length !== 10) continue;
            const shares = vars.map(v => {
                const series = this.#resolveSeries(data, v);
                const raw = series?.[idx];
                return Number.isFinite(raw) ? Math.max(0, raw) : 0;
            });
            // Renormalise to sum to 1 defensively (should already sum via Pareto closed-form)
            const total = shares.reduce((a, b) => a + b, 0) || 1;
            const normalized = shares.map(s => s / total);
            const cum = [0];
            let acc = 0;
            for (const s of normalized) { acc += s; cum.push(acc); }
            traces.push({
                type: 'scatter', mode: 'lines+markers',
                x: xs, y: cum,
                name: curve.label || 'Curve',
                line: { color: curve.color || '#4aa3ff', width: 2.5 },
                marker: { size: 5, color: curve.color || '#4aa3ff' },
                hovertemplate: 'Bottom %{x:.0%}<br>owns %{y:.1%}<extra>%{fullData.name}</extra>',
            });
        }

        const year = Math.round(time[idx] ?? 0);
        const layout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 28, r: 16, b: 48, l: 56 },
            xaxis: {
                title: { text: 'Cumulative population share', font: { size: 10 } },
                tickformat: '.0%',
                range: [0, 1],
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                zeroline: false,
            },
            yaxis: {
                title: { text: 'Cumulative income/wealth share', font: { size: 10 } },
                tickformat: '.0%',
                range: [0, 1],
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                zeroline: false,
            },
            annotations: year ? [{
                text: String(year),
                xref: 'paper', yref: 'paper',
                x: 0.02, y: 0.98, xanchor: 'left', yanchor: 'top',
                showarrow: false,
                font: { size: 11, color: 'rgba(255,255,255,0.55)' },
            }] : [],
            legend: {
                orientation: 'v', x: 0.98, xanchor: 'right',
                y: 0.02, yanchor: 'bottom',
                font: { color: '#cccccc', size: 10 },
                bgcolor: 'rgba(0,0,0,0.35)',
                bordercolor: 'rgba(255,255,255,0.15)',
                borderwidth: 1,
            },
            showlegend: true,
            hoverlabel: {
                bgcolor: '#1e2228', bordercolor: '#444',
                font: { family: 'Inter, sans-serif', color: '#cccccc' },
            },
        };

        Plotly.react(this.#chartDiv, traces, layout, { responsive: true, displayModeBar: false });
    }

    #cumulative(arr) {
        const out = [];
        let s = 0;
        for (const v of arr) { s += v; out.push(s); }
        return out;
    }

    #gradient(values) {
        // Darker → lighter to emphasise the tail
        const hi = '#4aa3ff';
        return values.map((_, i) => {
            const t = i / Math.max(1, values.length - 1);
            const light = Math.round(120 + t * 100);
            return `rgb(${Math.round(74 + t * 40)}, ${Math.round(163 - t * 30)}, ${light})`;
        });
    }

    #resolveSeries(data, variable) {
        if (!variable) return null;
        const look = (k) => data.stocks?.[k] ?? data.indicators?.[k] ?? data.flows?.[k];
        let raw = look(variable);
        if (!raw && variable.includes('.')) raw = look(variable.slice(variable.indexOf('.') + 1));
        if (!raw) return null;
        return Array.isArray(raw) ? raw : (raw.mean ?? raw.p50 ?? null);
    }

    #timeIndex(time, year) {
        if (year == null || !time?.length) return (time?.length ?? 1) - 1;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < time.length; i++) {
            const d = Math.abs(time[i] - year);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
    }

    dispose() {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        if (this.#chartDiv) plotlyPurge(this.#chartDiv);
        this.#chartDiv = null;
        super.dispose();
    }
}

registerWidget(LorenzTile);
