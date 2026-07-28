/**
 * sankey_tile.js
 *
 * Sankey-flow widget with a **year slider** so the user can time-travel the
 * diagram (e.g. to watch Target2 build up or the tax mix shift after Hartz).
 * Also updates live while a simulation is streaming.
 *
 * Config:
 *   snapshotYear  number   (initial year; slider overrides this)
 *   nodes         [{id, label, color?, column?}]
 *   links         [{source, target, variable, scale?, label?, color?}]
 *   title         string
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { purge as plotlyPurge } from '../../charting/plotly_wrapper.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

export class SankeyTile extends TileBase {
    static TYPE = 'sankey';
    static TITLE = 'Flow Sankey';
    static ICON = 'account_tree';
    static DESCRIPTION = 'Sankey flow diagram with year slider; updates live while streaming';
    static DEFAULT_SIZE = { w: 8, h: 5 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 4, maxW: 12, maxH: 10 };
    static EXPANDABLE = true;

    #chartDiv = null;
    #sliderEl = null;
    #yearLabel = null;
    #playBtn = null;
    #speedSelect = null;
    #resizeObserver = null;
    /** @type {{series:object, time:number[]}|null} */
    #flatResults = null;
    /** @type {number|null} currently displayed year (null → latest) */
    #activeYear = null;
    /** @type {boolean} has the user manually dragged the slider? */
    #userPinned = false;
    /** @type {number|null} setInterval handle while playing */
    #playTimer = null;
    /** @type {number} years-per-second when animating */
    #playSpeed = 5;

    getDefaultConfig() {
        return { snapshotYear: null, nodes: [], links: [], title: '' };
    }

    getConfigSchema() {
        return {
            fields: [
                { key: 'title', type: 'text', label: 'Title' },
                { key: 'snapshotYear', type: 'number', label: 'Default snapshot year',
                  hint: 'Year shown on first open; the slider below the diagram lets viewers time-travel.' },
                { key: 'nodes', type: 'json', label: 'Nodes (JSON)', rows: 8,
                  hint: 'Array of {id, label, color?}. Each id must be unique and referenced by links. Color is optional (hex or rgba).' },
                { key: 'links', type: 'json', label: 'Links (JSON)', rows: 14,
                  hint: 'Array of {source, target, variable, scale?, label?, color?}. source/target = node id; variable is evaluated at the current slider year; scale defaults to 1.' },
                { key: '_summary', type: 'readonly', label: 'Summary',
                  compute: (c) => {
                    const n = Array.isArray(c.nodes) ? c.nodes.length : 0;
                    const l = Array.isArray(c.links) ? c.links.length : 0;
                    return `${n} nodes · ${l} links`;
                  } },
            ],
        };
    }

    mount(container) {
        super.mount(container);
        if (!this.contentElement) return;

        // Layout: chart div + slider strip below
        this.contentElement.style.display = 'flex';
        this.contentElement.style.flexDirection = 'column';

        this.#chartDiv = document.createElement('div');
        this.#chartDiv.style.flex = '1 1 auto';
        this.#chartDiv.style.minHeight = '0';
        this.contentElement.appendChild(this.#chartDiv);

        this.#buildSliderStrip();

        // Allow double-click on chart area to expand (consistent with plot tile)
        this.#chartDiv.addEventListener('dblclick', (e) => {
            if (e.target.closest('.modebar, .js-plotly-plot .nsewdrag, .js-plotly-plot .drag')) return;
            e.stopPropagation();
            this._onExpandClick();
        });

        this.#resizeObserver = createRafResizeObserver(() => {
            if (window.Plotly && this.#chartDiv?.offsetParent) {
                Plotly.Plots.resize(this.#chartDiv).catch(() => {});
            }
        });
        this.#resizeObserver.observe(this.contentElement);
        if (this.config.title) this.setTitle(this.config.title);
    }

    #buildSliderStrip() {
        const strip = document.createElement('div');
        strip.className = 'sankey-slider-strip';
        strip.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px 4px;background:rgba(255,255,255,0.02);border-top:1px solid rgba(255,255,255,0.06);';

        // Suppress the TileBase "click content → open config panel" behaviour
        // so dragging the slider or tapping the step buttons doesn't pop the
        // config side-panel.
        for (const evName of ['click', 'mousedown', 'pointerdown']) {
            strip.addEventListener(evName, (e) => e.stopPropagation());
        }

        const leftBtn = document.createElement('button');
        leftBtn.className = 'sankey-step-btn';
        leftBtn.textContent = '◀';
        leftBtn.title = 'Step back 1 year';
        leftBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.15);color:#ccc;cursor:pointer;padding:2px 8px;border-radius:3px;font-size:11px;';

        const rightBtn = document.createElement('button');
        rightBtn.className = 'sankey-step-btn';
        rightBtn.textContent = '▶';
        rightBtn.title = 'Step forward 1 year';
        rightBtn.style.cssText = leftBtn.style.cssText;

        const liveBtn = document.createElement('button');
        liveBtn.className = 'sankey-live-btn';
        liveBtn.textContent = '⟲ Latest';
        liveBtn.title = 'Jump to the latest year; auto-follow during streaming';
        liveBtn.style.cssText = leftBtn.style.cssText;

        this.#playBtn = document.createElement('button');
        this.#playBtn.className = 'sankey-play-btn';
        this.#playBtn.textContent = '▶';
        this.#playBtn.title = 'Play / Pause animation';
        this.#playBtn.style.cssText = leftBtn.style.cssText + 'min-width:28px;';

        this.#speedSelect = document.createElement('select');
        this.#speedSelect.title = 'Animation speed (years per second)';
        this.#speedSelect.style.cssText = 'background:transparent;color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:3px;font-size:11px;padding:2px 4px;cursor:pointer;';
        for (const v of [1, 2, 5, 10, 20]) {
            const opt = document.createElement('option');
            opt.value = String(v);
            opt.textContent = `${v}×`;
            if (v === this.#playSpeed) opt.selected = true;
            this.#speedSelect.appendChild(opt);
        }
        this.#speedSelect.addEventListener('change', () => {
            this.#playSpeed = parseInt(this.#speedSelect.value, 10) || 5;
            if (this.#playTimer != null) { this.#stopPlaying(); this.#startPlaying(); }
        });

        this.#sliderEl = document.createElement('input');
        this.#sliderEl.type = 'range';
        this.#sliderEl.min = '0';
        this.#sliderEl.max = '0';
        this.#sliderEl.step = '1';
        this.#sliderEl.value = '0';
        this.#sliderEl.style.cssText = 'flex:1 1 auto;accent-color:#4aa3ff;';

        this.#yearLabel = document.createElement('span');
        this.#yearLabel.style.cssText = 'min-width:64px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:#cccccc;font-weight:600;';
        this.#yearLabel.textContent = '—';

        strip.append(
            liveBtn, this.#playBtn, this.#speedSelect,
            leftBtn, this.#sliderEl, rightBtn, this.#yearLabel,
        );
        this.contentElement.appendChild(strip);

        const step = (delta) => {
            if (!this.#flatResults) return;
            const max = this.#flatResults.time.length - 1;
            let idx = Math.max(0, Math.min(max, parseInt(this.#sliderEl.value, 10) + delta));
            this.#sliderEl.value = String(idx);
            this.#userPinned = idx < max;
            this.#applySliderPosition(idx);
        };
        leftBtn.addEventListener('click', () => { this.#stopPlaying(); step(-1); });
        rightBtn.addEventListener('click', () => { this.#stopPlaying(); step(+1); });
        liveBtn.addEventListener('click', () => {
            this.#stopPlaying();
            this.#userPinned = false;
            if (this.#flatResults) {
                const last = this.#flatResults.time.length - 1;
                this.#sliderEl.value = String(last);
                this.#applySliderPosition(last);
            }
        });
        this.#sliderEl.addEventListener('input', () => {
            this.#stopPlaying();
            const idx = parseInt(this.#sliderEl.value, 10);
            const max = this.#flatResults ? this.#flatResults.time.length - 1 : 0;
            this.#userPinned = idx < max;
            this.#applySliderPosition(idx);
        });
        this.#playBtn.addEventListener('click', () => {
            if (this.#playTimer != null) this.#stopPlaying();
            else this.#startPlaying();
        });
    }

    #startPlaying() {
        if (!this.#flatResults || !this.#sliderEl) return;
        const max = this.#flatResults.time.length - 1;
        if (max <= 0) return;
        // Restart from beginning if we're already at the end
        if (parseInt(this.#sliderEl.value, 10) >= max) {
            this.#sliderEl.value = '0';
            this.#applySliderPosition(0);
        }
        this.#userPinned = true;  // don't auto-follow latest while playing
        if (this.#playBtn) this.#playBtn.textContent = '❚❚';
        const intervalMs = Math.max(20, Math.round(1000 / this.#playSpeed));
        this.#playTimer = setInterval(() => {
            if (!this.#flatResults || !this.#sliderEl) { this.#stopPlaying(); return; }
            const curr = parseInt(this.#sliderEl.value, 10);
            const last = this.#flatResults.time.length - 1;
            if (curr >= last) { this.#stopPlaying(); return; }
            const next = curr + 1;
            this.#sliderEl.value = String(next);
            this.#applySliderPosition(next);
        }, intervalMs);
    }

    #stopPlaying() {
        if (this.#playTimer != null) {
            clearInterval(this.#playTimer);
            this.#playTimer = null;
        }
        if (this.#playBtn) this.#playBtn.textContent = '▶';
    }

    #applySliderPosition(idx) {
        if (!this.#flatResults) return;
        const t = this.#flatResults.time[idx];
        this.#activeYear = Number.isFinite(t) ? t : null;
        if (this.#yearLabel) this.#yearLabel.textContent = Number.isFinite(t) ? String(Math.round(t)) : '—';
        this.#renderAtIndex(idx);
    }

    // ── Public render entry points ──────────────────────────────────────────

    render(analyticsData) {
        if (!analyticsData) return;
        this.#flatResults = this.#analyticsToFlat(analyticsData);
        this.#updateSliderBounds();
        this.#autoFollowLatest();
    }

    update(data, config) {
        if (config) this.config = { ...this.config, ...config };
        if (data !== undefined) this.data = data;
        if (this.data) this.#flatResults = this.#analyticsToFlat(this.data);
        this.#updateSliderBounds();
        this.#autoFollowLatest();
    }

    renderStreaming(streamingData) {
        if (!streamingData) return;
        const series = {};
        for (const bucket of [streamingData.stocks, streamingData.flows, streamingData.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                series[key] = val;
                const dot = key.indexOf('.');
                if (dot >= 0 && !series[key.slice(dot + 1)]) series[key.slice(dot + 1)] = val;
            }
        }
        this.#flatResults = { series, time: streamingData.time ?? [] };
        this.#updateSliderBounds();
        this.#autoFollowLatest();
    }

    #updateSliderBounds() {
        if (!this.#sliderEl || !this.#flatResults) return;
        const n = this.#flatResults.time.length;
        if (n === 0) return;
        this.#sliderEl.max = String(n - 1);
    }

    #autoFollowLatest() {
        if (!this.#flatResults) return;
        const n = this.#flatResults.time.length;
        if (n === 0) return;

        let idx;
        if (this.#userPinned && this.config.snapshotYear == null) {
            idx = Math.min(parseInt(this.#sliderEl?.value || '0', 10), n - 1);
        } else if (this.config.snapshotYear != null && !this.#userPinned) {
            idx = this.#timeIndex(this.#flatResults.time, this.config.snapshotYear);
        } else {
            idx = n - 1;
        }
        if (this.#sliderEl) this.#sliderEl.value = String(idx);
        this.#applySliderPosition(idx);
    }

    // ── Core rendering ─────────────────────────────────────────────────────

    #renderAtIndex(idx) {
        if (!this.#chartDiv || !window.Plotly) return;
        const cfg = this.config;
        const nodes = cfg.nodes ?? [];
        const links = cfg.links ?? [];
        if (nodes.length === 0 || links.length === 0) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;font-size:11px;">Sankey needs nodes and links configured.</div>';
            return;
        }
        if (!this.#flatResults) { this.showEmpty('No data'); return; }
        const { series, time } = this.#flatResults;
        if (!time?.length) { this.showEmpty('No time axis'); return; }

        const idx_of = new Map(nodes.map((n, i) => [n.id, i]));
        const sources = [], targets = [], values = [], linkColors = [], linkLabels = [];
        for (const l of links) {
            const si = idx_of.get(l.source), ti = idx_of.get(l.target);
            if (si == null || ti == null) continue;
            const s = this.#resolveSeries(series, l.variable);
            let v = s?.[idx];
            if (!Number.isFinite(v)) continue;
            v = v * (l.scale ?? 1);
            if (v <= 0) continue;
            sources.push(si);
            targets.push(ti);
            values.push(v);
            linkColors.push(l.color || this.#alphaOf(nodes[si].color, 0.25));
            linkLabels.push(l.label || '');
        }
        if (values.length === 0) {
            this.#chartDiv.innerHTML = '<div class="plot-no-data" style="color:rgba(255,255,255,0.3);text-align:center;padding:20px;font-size:11px;">No positive flows at this year.</div>';
            return;
        }

        const trace = {
            type: 'sankey',
            orientation: 'h',
            valueformat: ',.1f',
            node: {
                label: nodes.map(n => n.label || n.id),
                color: nodes.map(n => n.color || '#4aa3ff'),
                pad: 14,
                thickness: 18,
                line: { color: 'rgba(255,255,255,0.15)', width: 0.5 },
            },
            link: {
                source: sources, target: targets, value: values,
                color: linkColors, label: linkLabels,
            },
        };

        const year = Math.round(time[idx]);
        const layout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            font: { family: 'Inter, sans-serif', color: '#cccccc', size: 11 },
            margin: { t: 22, r: 10, b: 10, l: 10 },
            title: {
                text: `${cfg.title || 'Flow'} — ${year}`,
                font: { size: 12, color: 'rgba(255,255,255,0.75)' },
                y: 0.98,
            },
        };

        Plotly.react(this.#chartDiv, [trace], layout, { responsive: true, displayModeBar: false });
    }

    // ── Expand to popout window ────────────────────────────────────────────

    getExpandData() {
        if (!this.#flatResults) return null;
        const cfg = this.config;
        const { series, time } = this.#flatResults;
        if (!time?.length) return null;

        const nodes = cfg.nodes ?? [];
        const links = cfg.links ?? [];
        const idx_of = new Map(nodes.map((n, i) => [n.id, i]));

        // Build one Plotly frame per year so the popout can time-travel via
        // the native Plotly slider (no dependency on the parent DOM slider).
        const buildTraceForIdx = (idx) => {
            const sources = [], targets = [], values = [], linkColors = [];
            for (const l of links) {
                const si = idx_of.get(l.source), ti = idx_of.get(l.target);
                if (si == null || ti == null) continue;
                const s = this.#resolveSeries(series, l.variable);
                let v = s?.[idx];
                if (!Number.isFinite(v)) continue;
                v = v * (l.scale ?? 1);
                if (v <= 0) continue;
                sources.push(si); targets.push(ti); values.push(v);
                linkColors.push(l.color || this.#alphaOf(nodes[si].color, 0.25));
            }
            return {
                type: 'sankey',
                orientation: 'h',
                valueformat: ',.1f',
                node: {
                    label: nodes.map(n => n.label || n.id),
                    color: nodes.map(n => n.color || '#4aa3ff'),
                    pad: 18, thickness: 20,
                    line: { color: 'rgba(255,255,255,0.2)', width: 0.5 },
                },
                link: { source: sources, target: targets, value: values, color: linkColors },
            };
        };

        // Current slider position determines initial frame
        const startIdx = Math.min(
            parseInt(this.#sliderEl?.value || '0', 10),
            time.length - 1,
        );
        const initialTrace = buildTraceForIdx(startIdx);

        // One frame per year for the Plotly slider
        const frames = time.map((t, i) => {
            const name = String(Math.round(t));
            return { name, data: [buildTraceForIdx(i)] };
        });

        const sliderSteps = time.map((t) => {
            const name = String(Math.round(t));
            return {
                label: name,
                method: 'animate',
                args: [[name], {
                    mode: 'immediate',
                    frame: { duration: 0, redraw: true },
                    transition: { duration: 0 },
                }],
            };
        });

        const layout = {
            paper_bgcolor: '#14161a',
            plot_bgcolor: '#14161a',
            font: { family: 'Inter, sans-serif', color: '#dddddd', size: 12 },
            // extra top margin makes room for Play/Pause above the chart;
            // extra bottom margin leaves room for the slider below
            margin: { t: 64, r: 20, b: 70, l: 20 },
            title: {
                text: cfg.title || 'Flow',
                font: { size: 14, color: '#ffffff' },
                y: 0.97,
            },
            sliders: [{
                active: startIdx,
                x: 0.02, xanchor: 'left',
                y: -0.02, yanchor: 'top',
                len: 0.96,
                pad: { t: 14, b: 6 },
                currentvalue: {
                    visible: true,
                    prefix: 'Year: ',
                    xanchor: 'right',
                    font: { size: 12, color: '#ffffff' },
                },
                transition: { duration: 0 },
                steps: sliderSteps,
                bgcolor: 'rgba(255,255,255,0.06)',
                bordercolor: 'rgba(255,255,255,0.15)',
                tickcolor: 'rgba(255,255,255,0.4)',
                font: { size: 10, color: '#cccccc' },
            }],
            // Play / Pause placed ABOVE the chart area in the top-left so they
            // never overlap the slider below.
            updatemenus: [{
                type: 'buttons',
                direction: 'right',
                showactive: false,
                x: 0.0, xanchor: 'left',
                y: 1.10, yanchor: 'top',
                pad: { r: 6, t: 0, b: 0, l: 0 },
                bgcolor: 'rgba(255,255,255,0.08)',
                bordercolor: 'rgba(255,255,255,0.15)',
                font: { size: 11, color: '#cccccc' },
                buttons: [
                    { label: '▶ Play', method: 'animate', args: [null, {
                        mode: 'immediate',
                        fromcurrent: true,
                        frame: { duration: 300, redraw: true },
                        transition: { duration: 0 },
                    }]},
                    { label: '❚❚ Pause', method: 'animate', args: [[null], {
                        mode: 'immediate',
                        frame: { duration: 0, redraw: false },
                        transition: { duration: 0 },
                    }]},
                ],
            }],
        };

        // Build a full flow table at the current year (for the Data tab)
        const tableRows = [];
        for (const l of links) {
            const s = this.#resolveSeries(series, l.variable);
            const v = Number.isFinite(s?.[startIdx])
                ? (s[startIdx] * (l.scale ?? 1)).toFixed(2)
                : 'NaN';
            tableRows.push([l.source, l.target, l.variable, v]);
        }

        const year = Math.round(time[startIdx]);
        return {
            title: `${cfg.title || 'Flow'} — ${year}`,
            traces: [initialTrace],
            layout,
            frames,
            tableHeaders: ['Source', 'Target', 'Variable', `Value @ ${year}`],
            tableRows,
        };
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    #analyticsToFlat(analytics) {
        const series = {};
        for (const bucket of [analytics.stocks, analytics.flows, analytics.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                const resolved = Array.isArray(val) ? val : (val.mean ?? val.p50 ?? []);
                series[key] = resolved;
                const dot = key.indexOf('.');
                if (dot >= 0 && !series[key.slice(dot + 1)]) series[key.slice(dot + 1)] = resolved;
            }
        }
        return { series, time: analytics.time ?? [] };
    }

    #resolveSeries(series, variable) {
        if (!variable) return null;
        let s = series?.[variable];
        if (!s && variable.includes('.')) s = series?.[variable.slice(variable.indexOf('.') + 1)];
        return s;
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

    #alphaOf(hex, a) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#4aa3ff');
        if (!m) return `rgba(74,163,255,${a})`;
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r},${g},${b},${a})`;
    }

    dispose() {
        this.#stopPlaying();
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        if (this.#chartDiv) plotlyPurge(this.#chartDiv);
        this.#chartDiv = null;
        this.#sliderEl = null;
        this.#yearLabel = null;
        this.#playBtn = null;
        this.#speedSelect = null;
        this.#flatResults = null;
        super.dispose();
    }
}

registerWidget(SankeyTile);
