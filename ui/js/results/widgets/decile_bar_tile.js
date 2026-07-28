/**
 * decile_bar_tile.js
 *
 * Categorical bar chart for percentile / decile breakdowns. Samples N model
 * variables (typically one per population bucket) at a snapshot year and
 * renders them as bars. Supports a secondary series for side-by-side
 * comparisons and works for any N — not just 10 deciles. Use with 12
 * points to render D1..D10 + Top 1% + Top 0.1%.
 *
 * Config:
 *   title           string
 *   snapshotYear    number              Year used to sample each series
 *   seriesA         { label, variables: [N], color? }
 *   seriesB         { label, variables: [N], color? }    // optional
 *   variablePrefix  string              If given and `count` set, builds variables [prefix+'1', ..., prefix+count]
 *   count           number              Number of buckets (default 10). Only used with variablePrefix.
 *   layout          'grouped' | 'twin-bars' | 'single'    Rendering mode
 *   format          'percent' | 'rate' | 'number'         Y-axis formatting
 *   highlight       [d1..dN | index]    Optional list of buckets to highlight
 *   decileLabels    [N]                 Override labels (defaults to D1, D2, ..., DN)
 *   referenceLine   number              Optional horizontal line (e.g. 0.10 for "fair share")
 *   referenceLabel  string              Label for reference line
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { purge as plotlyPurge } from '../../charting/plotly_wrapper.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

const DEFAULT_LABELS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'];

export class DecileBarTile extends TileBase {
    static TYPE = 'decile-bar';
    static TITLE = 'Per-decile Bars';
    static ICON = 'bar_chart';
    static DESCRIPTION = 'Per-decile bar chart (grouped or single series) at a snapshot year';
    static DEFAULT_SIZE = { w: 4, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 8, maxH: 6 };
    static EXPANDABLE = true;

    #chartDiv = null;
    #resizeObserver = null;

    getDefaultConfig() {
        return {
            title: '',
            snapshotYear: null,
            seriesA: { label: 'A', variables: [], color: '#4aa3ff' },
            seriesB: null,
            variablePrefix: '',
            count: 10,
            layout: 'single',
            format: 'percent',
            highlight: [],
            decileLabels: null,
            referenceLine: null,
            referenceLabel: '',
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
        if (!data) { this.showEmpty('No data'); return; }
        const cfg = this.config;
        const time = data.time ?? [];
        if (!time.length) { this.showEmpty('No time axis'); return; }

        const idx = this.#timeIndex(time, cfg.snapshotYear);

        const seriesA = this.#resolveSeries(cfg.seriesA, cfg.variablePrefix, cfg.count);
        const n = seriesA.variables.length;
        const labels = (Array.isArray(cfg.decileLabels) && cfg.decileLabels.length === n)
            ? cfg.decileLabels
            : (n === 10 ? DEFAULT_LABELS : Array.from({ length: n }, (_, i) => `D${i + 1}`));
        const valuesA = this.#sampleAll(data, seriesA.variables, idx);

        const traces = [];
        traces.push({
            type: 'bar',
            x: labels,
            y: valuesA,
            name: seriesA.label || 'Series A',
            marker: {
                color: this.#barColors(valuesA, seriesA.color, cfg.highlight),
                line: { color: 'rgba(0,0,0,0.15)', width: 1 },
            },
            hovertemplate: '%{x}<br>%{y}<extra>%{fullData.name}</extra>',
            texttemplate: cfg.format === 'percent' || cfg.format === 'rate' ? '%{y:.1%}' : '%{y:.2f}',
            textposition: 'outside',
            textfont: { color: '#cccccc', size: 9 },
        });

        // Secondary series — only when layout permits comparison
        if (cfg.seriesB && cfg.layout !== 'single') {
            const seriesB = this.#resolveSeries(cfg.seriesB, cfg.variablePrefix, cfg.count);
            const valuesB = this.#sampleAll(data, seriesB.variables, idx);
            traces.push({
                type: 'bar',
                x: labels,
                y: valuesB,
                name: seriesB.label || 'Series B',
                marker: {
                    color: seriesB.color || '#ff8c42',
                    line: { color: 'rgba(0,0,0,0.15)', width: 1 },
                },
                hovertemplate: '%{x}<br>%{y}<extra>%{fullData.name}</extra>',
                texttemplate: cfg.format === 'percent' || cfg.format === 'rate' ? '%{y:.1%}' : '%{y:.2f}',
                textposition: 'outside',
                textfont: { color: '#cccccc', size: 9 },
            });
        }

        const year = Math.round(time[idx] ?? 0);
        const shapes = [];
        if (Number.isFinite(cfg.referenceLine)) {
            shapes.push({
                type: 'line', xref: 'paper', x0: 0, x1: 1, y0: cfg.referenceLine, y1: cfg.referenceLine,
                line: { color: 'rgba(255,255,255,0.45)', width: 1, dash: 'dot' },
            });
        }
        const annotations = year ? [{
            text: String(year), xref: 'paper', yref: 'paper',
            x: 1, y: 1.04, xanchor: 'right', yanchor: 'bottom',
            showarrow: false,
            font: { size: 11, color: 'rgba(255,255,255,0.45)' },
        }] : [];
        if (Number.isFinite(cfg.referenceLine) && cfg.referenceLabel) {
            annotations.push({
                text: cfg.referenceLabel, xref: 'paper', yref: 'y',
                x: 1, y: cfg.referenceLine, xanchor: 'right', yanchor: 'bottom',
                showarrow: false,
                font: { size: 10, color: 'rgba(255,255,255,0.55)' },
            });
        }

        const layout = {
            barmode: cfg.layout === 'twin-bars' ? 'group' : 'group',
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 30, r: 12, b: 46, l: 52 },
            xaxis: {
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zeroline: false,
            },
            yaxis: {
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zeroline: true,
                zerolinecolor: 'rgba(255,255,255,0.15)',
                tickformat: (cfg.format === 'percent' || cfg.format === 'rate') ? '.0%' : undefined,
            },
            showlegend: cfg.seriesB && cfg.layout !== 'single',
            legend: {
                orientation: 'h', y: -0.18, yanchor: 'top',
                x: 0.5, xanchor: 'center',
                font: { color: '#cccccc', size: 10 },
                bgcolor: 'rgba(0,0,0,0)',
            },
            shapes,
            annotations,
            hoverlabel: {
                bgcolor: '#1e2228', bordercolor: '#444',
                font: { family: 'Inter, sans-serif', color: '#cccccc' },
            },
        };

        Plotly.react(this.#chartDiv, traces, layout, { responsive: true, displayModeBar: false });
    }

    #resolveSeries(series, prefix, count) {
        const clone = { ...(series || {}) };
        if ((!clone.variables || clone.variables.length === 0) && prefix) {
            const n = Number.isFinite(count) && count > 0 ? count : 10;
            clone.variables = Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
        }
        if (!Array.isArray(clone.variables)) clone.variables = [];
        return clone;
    }

    #sampleAll(data, variables, idx) {
        if (!Array.isArray(variables) || variables.length === 0) return new Array(10).fill(0);
        const out = new Array(variables.length);
        for (let i = 0; i < variables.length; i++) {
            out[i] = this.#sample(data, variables[i], idx);
            if (!Number.isFinite(out[i])) out[i] = 0;
        }
        return out;
    }

    #sample(data, variable, idx) {
        if (!variable) return NaN;
        const look = (k) => data.stocks?.[k] ?? data.indicators?.[k] ?? data.flows?.[k];
        let raw = look(variable);
        if (!raw && variable.includes('.')) raw = look(variable.slice(variable.indexOf('.') + 1));
        if (!raw) return NaN;
        const series = Array.isArray(raw) ? raw : (raw.mean ?? raw.p50 ?? null);
        return Array.isArray(series) ? series[idx] : NaN;
    }

    #barColors(values, base, highlight) {
        const n = values.length;
        const hlSet = new Set((highlight || []).map(h => {
            if (typeof h === 'number') return h - 1;
            if (typeof h === 'string') {
                const m = /(\d+)/.exec(h);
                return m ? parseInt(m[1], 10) - 1 : -1;
            }
            return -1;
        }));
        return values.map((_, i) => {
            if (hlSet.has(i)) return '#ffcc3a';
            // Gentle gradient — bottom darker, top lighter — to emphasise the tail
            const t = i / Math.max(1, n - 1);
            return this.#mix(base || '#4aa3ff', '#ffffff', t * 0.35);
        });
    }

    #mix(a, b, t) {
        const pa = this.#hex(a);
        const pb = this.#hex(b);
        if (!pa || !pb) return a;
        const r = Math.round(pa.r + (pb.r - pa.r) * t);
        const g = Math.round(pa.g + (pb.g - pa.g) * t);
        const bl = Math.round(pa.b + (pb.b - pa.b) * t);
        return `rgb(${r}, ${g}, ${bl})`;
    }

    #hex(s) {
        const m = /^#?([0-9a-f]{6})$/i.exec(s);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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

registerWidget(DecileBarTile);
