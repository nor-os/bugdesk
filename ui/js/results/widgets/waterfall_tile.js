/**
 * waterfall_tile.js
 *
 * Cumulative waterfall chart — a starting value is progressively eroded (or
 * augmented) through labelled deductions to reach a final value. Designed for
 * the "top 0.1% headline rate -> actual paid" story but generic enough for any
 * cumulative decomposition (revenue build-up, cost stack, etc.).
 *
 * Config:
 *   title          string
 *   snapshotYear   number          Year at which variables are sampled
 *   startLabel     string          Label for starting bar
 *   startVariable  string          Variable supplying the starting value
 *   steps          [{ label, variable, sign? }]
 *                  sign='negative' (default) subtracts, 'positive' adds
 *   endLabel       string          Label for the terminal (net) bar
 *   endVariable    string          Optional — value to force as terminal.
 *                                  If omitted, computed = start + Σ signed steps
 *   format         'percent' | 'rate' | 'number' | 'eur'
 *   decimals       number
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { purge as plotlyPurge } from '../../charting/plotly_wrapper.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

export class WaterfallTile extends TileBase {
    static TYPE = 'waterfall';
    static TITLE = 'Waterfall';
    static ICON = 'stacked_bar_chart';
    static DESCRIPTION = 'Cumulative waterfall: start value minus labelled deductions → end';
    static DEFAULT_SIZE = { w: 4, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 8, maxH: 6 };
    static EXPANDABLE = true;

    #chartDiv = null;
    #resizeObserver = null;

    getDefaultConfig() {
        return {
            title: '',
            snapshotYear: null,
            startLabel: 'Start',
            startVariable: '',
            steps: [],
            endLabel: 'Net',
            endVariable: '',
            format: 'percent',
            decimals: 1,
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
        const startVal = this.#sample(data, cfg.startVariable, idx);
        if (!Number.isFinite(startVal)) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;font-size:11px;">Configure startVariable.</div>';
            return;
        }

        // Build the x/y/measure arrays Plotly's waterfall trace consumes
        const labels = [cfg.startLabel || 'Start'];
        const values = [startVal];
        const measure = ['absolute'];
        const text = [this.#fmt(startVal)];

        let running = startVal;
        for (const step of (cfg.steps || [])) {
            // Step value may come from a model variable OR from a literal `value:`.
            // Literal values cover model constants that the simulation engine
            // optimises out of the indicator set (so they're not addressable
            // via .indicators). The waterfall still needs them for its
            // visual decomposition.
            let raw;
            if (Number.isFinite(step.value)) {
                raw = step.value;
            } else {
                raw = this.#sample(data, step.variable, idx);
            }
            if (!Number.isFinite(raw)) continue;
            const signed = (step.sign === 'positive') ? raw : -raw;
            labels.push(step.label || step.variable || 'Step');
            values.push(signed);
            measure.push('relative');
            text.push((signed >= 0 ? '+' : '') + this.#fmt(Math.abs(signed)));
            running += signed;
        }

        // Terminal bar — either explicit variable or derived running total
        let endVal;
        if (cfg.endVariable) {
            const forced = this.#sample(data, cfg.endVariable, idx);
            endVal = Number.isFinite(forced) ? forced : running;
        } else {
            endVal = running;
        }
        labels.push(cfg.endLabel || 'Net');
        values.push(endVal);
        measure.push('total');
        text.push(this.#fmt(endVal));

        const trace = {
            type: 'waterfall',
            orientation: 'v',
            x: labels,
            y: values,
            measure,
            text,
            textposition: 'outside',
            connector: { line: { color: 'rgba(255,255,255,0.25)', width: 1, dash: 'dot' } },
            increasing: { marker: { color: '#34a853' } },
            decreasing: { marker: { color: '#e55353' } },
            totals:     { marker: { color: '#4aa3ff' } },
            hovertemplate: '%{x}<br>%{text}<extra></extra>',
            textfont: { color: '#cccccc', size: 10 },
        };

        const year = Math.round(time[idx] ?? 0);
        const layout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 30, r: 16, b: 64, l: 48 },
            xaxis: {
                tickangle: -20,
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
            },
            yaxis: {
                gridcolor: 'rgba(255,255,255,0.05)',
                linecolor: 'rgba(255,255,255,0.08)',
                tickcolor: 'rgba(255,255,255,0.3)',
                zeroline: true,
                zerolinecolor: 'rgba(255,255,255,0.15)',
                tickformat: (cfg.format === 'percent' || cfg.format === 'rate') ? '.0%' : undefined,
            },
            annotations: year ? [{
                text: String(year),
                xref: 'paper', yref: 'paper',
                x: 1, y: 1.04, xanchor: 'right', yanchor: 'bottom',
                showarrow: false,
                font: { size: 11, color: 'rgba(255,255,255,0.45)' },
            }] : [],
            showlegend: false,
            hoverlabel: {
                bgcolor: '#1e2228', bordercolor: '#444',
                font: { family: 'Inter, sans-serif', color: '#cccccc' },
            },
        };

        Plotly.react(this.#chartDiv, [trace], layout, { responsive: true, displayModeBar: false });
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

    #timeIndex(time, year) {
        if (year == null || !time?.length) return (time?.length ?? 1) - 1;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < time.length; i++) {
            const d = Math.abs(time[i] - year);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
    }

    #fmt(v) {
        if (!Number.isFinite(v)) return '—';
        const d = this.config.decimals ?? 1;
        switch (this.config.format) {
            case 'percent':
            case 'rate':    return `${(v * 100).toFixed(d)}%`;
            case 'eur':     return `€${v.toFixed(d)} bn`;
            default:        return v.toFixed(d);
        }
    }

    dispose() {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        if (this.#chartDiv) plotlyPurge(this.#chartDiv);
        this.#chartDiv = null;
        super.dispose();
    }
}

registerWidget(WaterfallTile);
