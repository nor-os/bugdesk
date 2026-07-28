/**
 * radar_tile.js
 *
 * Radar/spider chart widget. Renders multi-axis snapshots of composite
 * indicators at one or more epoch years, letting viewers compare "shapes"
 * across time rather than reading stacked time-series.
 *
 * Config:
 *   axes        [{ variable, label?, max?, invert? }]  Axes (at least 3)
 *   snapshots   [{ year, label?, color? }]             Epoch snapshots to draw
 *   fill        boolean                                Fill polygon interior
 *   normalize   'axisMax' | 'globalMax' | 'none'       Scaling across snapshots
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { purge as plotlyPurge } from '../../charting/plotly_wrapper.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

const DEFAULT_COLORS = ['#4aa3ff', '#ff8c42', '#2ecc71', '#e55353', '#b58cff', '#ffcc3a'];

export class RadarTile extends TileBase {
    static TYPE = 'radar';
    static TITLE = 'Radar';
    static ICON = 'radar';
    static DESCRIPTION = 'Radar/spider chart for composite indicators across epoch snapshots';
    static DEFAULT_SIZE = { w: 4, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 8, maxH: 6 };
    static EXPANDABLE = true;

    #chartDiv = null;
    #resizeObserver = null;

    getDefaultConfig() {
        return {
            axes: [],
            snapshots: [],
            fill: true,
            normalize: 'axisMax',
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
    }

    render(data) {
        if (!this.#chartDiv || !window.Plotly) return;
        if (!data) { this.showEmpty('No data'); return; }

        const axes = this.config.axes ?? [];
        const snapshots = this.config.snapshots ?? [];
        if (axes.length < 3 || snapshots.length === 0) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;font-size:11px;">Radar needs ≥3 axes and ≥1 snapshot.</div>';
            return;
        }

        const time = data.time ?? [];
        if (!time.length) { this.showEmpty('No time axis'); return; }

        // Resolve each (axis, snapshot) value from series
        const seriesByAxis = axes.map(ax => this.#resolveSeries(data, ax.variable));

        const axisMax = axes.map((ax, i) => {
            if (Number.isFinite(ax.max)) return ax.max;
            const s = seriesByAxis[i];
            if (!s) return 1;
            let mx = 0;
            for (const v of s) if (Number.isFinite(v) && Math.abs(v) > mx) mx = Math.abs(v);
            return mx > 0 ? mx : 1;
        });

        const theta = [...axes.map(a => a.label || a.variable), axes[0].label || axes[0].variable];

        const traces = snapshots.map((snap, si) => {
            const idx = this.#timeIndex(time, snap.year);
            const r = axes.map((ax, ai) => {
                const series = seriesByAxis[ai];
                const raw = series?.[idx];
                if (!Number.isFinite(raw)) return 0;
                let v = raw / (axisMax[ai] || 1);
                if (ax.invert) v = 1 - v;
                return Math.max(0, Math.min(1.2, v));
            });
            r.push(r[0]); // close polygon
            const color = snap.color || DEFAULT_COLORS[si % DEFAULT_COLORS.length];
            return {
                type: 'scatterpolar',
                r,
                theta,
                name: snap.label || String(snap.year),
                fill: this.config.fill ? 'toself' : 'none',
                line: { color, width: 2 },
                fillcolor: this.#alpha(color, 0.2),
                hovertemplate: '%{theta}: %{r:.2f}<extra>%{fullData.name}</extra>',
            };
        });

        const layout = {
            polar: {
                bgcolor: 'transparent',
                radialaxis: {
                    visible: true,
                    range: [0, 1],
                    gridcolor: 'rgba(255,255,255,0.08)',
                    tickfont: { size: 9, color: 'rgba(255,255,255,0.45)' },
                },
                angularaxis: {
                    gridcolor: 'rgba(255,255,255,0.08)',
                    tickfont: { size: 10, color: '#cccccc' },
                },
            },
            showlegend: true,
            legend: {
                orientation: 'h',
                y: -0.1, yanchor: 'top',
                x: 0.5, xanchor: 'center',
                font: { color: '#cccccc', size: 10 },
                bgcolor: 'rgba(0,0,0,0)',
            },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 12, r: 20, b: 40, l: 20 },
        };

        Plotly.react(this.#chartDiv, traces, layout, { responsive: true, displayModeBar: false });
    }

    #resolveSeries(data, variable) {
        if (!variable) return null;
        const look = (key) => {
            return data.stocks?.[key] ?? data.indicators?.[key] ?? data.flows?.[key];
        };
        let raw = look(variable);
        if (!raw && variable.includes('.')) raw = look(variable.slice(variable.indexOf('.') + 1));
        if (!raw) return null;
        return Array.isArray(raw) ? raw : (raw.mean ?? raw.p50 ?? null);
    }

    #timeIndex(time, year) {
        if (year == null) return time.length - 1;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < time.length; i++) {
            const d = Math.abs(time[i] - year);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
    }

    #alpha(hex, a) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (!m) return hex;
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r},${g},${b},${a})`;
    }

    dispose() {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        if (this.#chartDiv) plotlyPurge(this.#chartDiv);
        this.#chartDiv = null;
        super.dispose();
    }
}

registerWidget(RadarTile);
