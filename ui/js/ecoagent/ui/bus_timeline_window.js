/**
 * bus_timeline_window.js — drill-in for an InfoBus topic.
 *
 * Opens a ManagedWindow showing the full publish history of one topic
 * (`world_bus_topic_history`) and renders an intelligent visualization
 * picked from the payload shape:
 *
 *   - all numbers (int/float)  → line chart over tick
 *   - all booleans             → step plot (0/1) over tick
 *   - all strings              → categorical step plot, one Y row per distinct value
 *   - dict with numeric leaves → multi-line chart, one trace per leaf key
 *   - list of numbers (same N) → fan plot (median + p10/p90 band, ±max range)
 *   - anything else            → table view: tick · summary · Inspect…
 *
 * Reuses the inspector window for per-tick deep-dives on heterogeneous
 * payloads so the user can always fall through to the raw tree.
 */

import { ensurePlotly, DARK_THEME_LAYOUT, COLOR_PALETTE } from '../../charting/plotly_wrapper.js';
import { openBrainInspector } from './inspector.js';


export async function openBusTimelineWindow({ topic } = {}) {
    if (!topic) return;
    const { ManagedWindow } = await import('../../ui/components/managed_window.js');
    const winId = `ea-bus-timeline:${topic}`;
    const existing = ManagedWindow.get?.(winId);
    if (existing?.isVisible) {
        existing.show();
        return;
    }

    const host = document.createElement('div');
    host.className = 'ea-bus-timeline';
    host.innerHTML = `
        <div class="ea-bus-timeline__subtitle" data-role="subtitle">Loading…</div>
        <div class="ea-bus-timeline__body" data-role="body">
            <div class="ea-plot__placeholder">Loading topic history…</div>
        </div>
    `;

    const win = new ManagedWindow({
        id:            winId,
        title:         `Topic · ${topic}`,
        icon:          'timeline',
        content:       host,
        minWidth:      560,
        minHeight:     360,
        defaultWidth:  780,
        defaultHeight: 480,
        modal:         false,
    });
    win.show();

    // Kick off the data load + render. We resolve immediately so the
    // caller doesn't await the window's lifecycle.
    _loadAndRender(host, topic).catch((err) => {
        host.querySelector('[data-role="body"]').innerHTML =
            `<div class="ea-plot__placeholder">Failed to load topic history: ${esc(String(err))}</div>`;
    });
}


async function _loadAndRender(host, topic) {
    const subtitle = host.querySelector('[data-role="subtitle"]');
    const body = host.querySelector('[data-role="body"]');

    const data = await window.pywebview?.api?.world_bus_topic_history?.(topic, 500)
        ?? { entries: [] };
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) {
        subtitle.textContent = 'No deliveries recorded for this topic yet.';
        body.innerHTML = '<div class="ea-plot__placeholder">'
            + 'Empty timeline — once the topic is delivered, history will appear here.</div>';
        return;
    }
    const trunc = data.truncated ? ' (truncated to last 500)' : '';
    subtitle.textContent = `${entries.length} deliveries${trunc} · ticks ${entries[0].tick} → ${entries[entries.length - 1].tick}`;

    const shape = _classifyShape(entries);
    switch (shape.kind) {
        case 'numeric':     return _renderNumericLine(body, topic, entries, shape);
        case 'boolean':     return _renderStep(body, topic, entries);
        case 'categorical': return _renderCategorical(body, topic, entries, shape);
        case 'dict':        return _renderDictMultiline(body, topic, entries, shape);
        case 'list-numeric':return _renderListFan(body, topic, entries, shape);
        default:            return _renderTable(body, topic, entries);
    }
}


/* ─── shape classification ──────────────────────────────────────────── */

function _classifyShape(entries) {
    // Each entry.payload is an inspector node:
    //   {kind: 'primitive', type: 'int'|'float'|'bool'|'str'|'NoneType', value}
    //   {kind: 'list', items: [...], length, truncated}
    //   {kind: 'dict', items: {k: node, ...}, length, truncated}
    //   {kind: 'object'|'repr'|'elided', ...}
    let allNumeric = true;
    let allBoolean = true;
    let allStringPrim = true;
    let allDict = true;
    let allListNumeric = true;
    let listLen = null;
    const dictKeysSet = new Set();
    let dictKeysFrozen = null;        // first observed key set; tolerate missing keys

    for (const e of entries) {
        const p = e?.payload;
        const isPrim = p && p.kind === 'primitive';
        const t = isPrim ? p.type : null;

        if (!isPrim || !(t === 'int' || t === 'float')) allNumeric = false;
        if (!isPrim || t !== 'bool') allBoolean = false;
        if (!isPrim || t !== 'str')  allStringPrim = false;

        if (!p || p.kind !== 'dict')  allDict = false;
        else {
            if (dictKeysFrozen === null) {
                dictKeysFrozen = Object.keys(p.items || {});
                for (const k of dictKeysFrozen) dictKeysSet.add(k);
            } else {
                for (const k of Object.keys(p.items || {})) dictKeysSet.add(k);
            }
        }

        if (!p || p.kind !== 'list') allListNumeric = false;
        else {
            const items = p.items || [];
            if (listLen === null) listLen = items.length;
            if (items.length !== listLen) allListNumeric = false;
            for (const it of items) {
                if (!it || it.kind !== 'primitive' || !(it.type === 'int' || it.type === 'float')) {
                    allListNumeric = false;
                    break;
                }
            }
        }
    }

    if (allNumeric)     return { kind: 'numeric' };
    if (allBoolean)     return { kind: 'boolean' };
    if (allStringPrim)  return { kind: 'categorical' };
    if (allDict) {
        // Verify every dict's values are numeric for the union of keys.
        // We allow missing keys per tick (filled with null = gap in plotly).
        const keys = [...dictKeysSet];
        let anyNumericLeaf = false;
        let allNumericLeaf = true;
        for (const e of entries) {
            const items = e.payload.items || {};
            for (const k of keys) {
                const v = items[k];
                if (v === undefined) continue;          // missing — gap
                if (!v || v.kind !== 'primitive') { allNumericLeaf = false; break; }
                if (v.type === 'int' || v.type === 'float') anyNumericLeaf = true;
                else if (v.type !== 'NoneType') { allNumericLeaf = false; break; }
            }
            if (!allNumericLeaf) break;
        }
        if (allNumericLeaf && anyNumericLeaf) return { kind: 'dict', keys };
    }
    if (allListNumeric && listLen != null && listLen > 0) {
        return { kind: 'list-numeric', length: listLen };
    }
    return { kind: 'mixed' };
}


/* ─── renderers ─────────────────────────────────────────────────────── */

async function _renderNumericLine(body, topic, entries) {
    const Plotly = await _plotlyOrFail(body);
    if (!Plotly) return;
    const xs = entries.map((e) => e.tick);
    const ys = entries.map((e) => Number(e.payload.value));
    Plotly.newPlot(body, [{
        x: xs, y: ys, type: 'scattergl', mode: 'lines+markers',
        line: { color: COLOR_PALETTE[0], width: 2 },
        marker: { size: 4, color: COLOR_PALETTE[0] },
        hovertemplate: 'tick %{x}: %{y}<extra></extra>',
        name: topic,
    }], {
        ..._layout(`${topic} — value over tick`),
    }, { responsive: true, displayModeBar: false });
}

async function _renderStep(body, topic, entries) {
    const Plotly = await _plotlyOrFail(body);
    if (!Plotly) return;
    const xs = entries.map((e) => e.tick);
    const ys = entries.map((e) => (e.payload.value ? 1 : 0));
    Plotly.newPlot(body, [{
        x: xs, y: ys, type: 'scatter', mode: 'lines+markers',
        line: { shape: 'hv', color: COLOR_PALETTE[1], width: 2 },
        marker: { size: 6, color: COLOR_PALETTE[1] },
        hovertemplate: 'tick %{x}: %{y}<extra></extra>',
        name: topic,
    }], {
        ..._layout(`${topic} — boolean over tick`),
        yaxis: { ...DARK_THEME_LAYOUT.yaxis, tickvals: [0, 1], ticktext: ['false', 'true'], range: [-0.2, 1.2] },
    }, { responsive: true, displayModeBar: false });
}

async function _renderCategorical(body, topic, entries) {
    const Plotly = await _plotlyOrFail(body);
    if (!Plotly) return;
    // Map distinct strings to row indices so we can lay them out vertically.
    const distinct = [];
    const rowFor = new Map();
    for (const e of entries) {
        const v = String(e.payload.value);
        if (!rowFor.has(v)) {
            rowFor.set(v, distinct.length);
            distinct.push(v);
        }
    }
    const xs = entries.map((e) => e.tick);
    const ys = entries.map((e) => rowFor.get(String(e.payload.value)));
    Plotly.newPlot(body, [{
        x: xs, y: ys, type: 'scatter', mode: 'lines+markers',
        line: { shape: 'hv', color: COLOR_PALETTE[2], width: 1.5 },
        marker: { size: 6, color: COLOR_PALETTE[2] },
        text: entries.map((e) => String(e.payload.value)),
        hovertemplate: 'tick %{x}: %{text}<extra></extra>',
        name: topic,
    }], {
        ..._layout(`${topic} — value over tick`),
        yaxis: {
            ...DARK_THEME_LAYOUT.yaxis,
            tickvals: distinct.map((_, i) => i),
            ticktext: distinct,
            range:    [-0.5, distinct.length - 0.5],
        },
    }, { responsive: true, displayModeBar: false });
}

async function _renderDictMultiline(body, topic, entries, shape) {
    const Plotly = await _plotlyOrFail(body);
    if (!Plotly) return;
    const keys = shape.keys || [];
    const xs = entries.map((e) => e.tick);
    const traces = keys.map((k, i) => {
        const ys = entries.map((e) => {
            const node = e.payload.items?.[k];
            if (!node || node.kind !== 'primitive') return null;
            if (node.value === null || node.value === undefined) return null;
            return Number(node.value);
        });
        const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
        return {
            x: xs, y: ys, type: 'scattergl', mode: 'lines',
            line: { color, width: 1.5 },
            name: k,
            connectgaps: false,
            hovertemplate: `tick %{x} · ${k}: %{y}<extra></extra>`,
        };
    });
    Plotly.newPlot(body, traces, {
        ..._layout(`${topic} — one line per key`),
        showlegend: true,
    }, { responsive: true, displayModeBar: false });
}

async function _renderListFan(body, topic, entries, shape) {
    const Plotly = await _plotlyOrFail(body);
    if (!Plotly) return;
    const xs = entries.map((e) => e.tick);
    // Per-tick min/p10/median/p90/max across the list items.
    const stats = entries.map((e) => {
        const vals = (e.payload.items || []).map((it) => Number(it.value)).filter(Number.isFinite);
        return _stats(vals);
    });
    const min = stats.map((s) => s.min);
    const p10 = stats.map((s) => s.p10);
    const med = stats.map((s) => s.median);
    const p90 = stats.map((s) => s.p90);
    const max = stats.map((s) => s.max);

    const base = COLOR_PALETTE[0];
    const traces = [
        // outer min/max envelope (lighter)
        { x: xs, y: max, type: 'scatter', mode: 'lines', name: 'max',
          line: { color: 'rgba(78,201,176,0.0)' }, showlegend: false, hoverinfo: 'skip' },
        { x: xs, y: min, type: 'scatter', mode: 'lines', name: 'min · max band',
          line: { color: 'rgba(78,201,176,0.0)' }, fill: 'tonexty',
          fillcolor: 'rgba(78,201,176,0.10)', hoverinfo: 'skip' },
        // p10/p90 band (denser)
        { x: xs, y: p90, type: 'scatter', mode: 'lines', name: 'p90',
          line: { color: 'rgba(78,201,176,0.0)' }, showlegend: false, hoverinfo: 'skip' },
        { x: xs, y: p10, type: 'scatter', mode: 'lines', name: 'p10 · p90 band',
          line: { color: 'rgba(78,201,176,0.0)' }, fill: 'tonexty',
          fillcolor: 'rgba(78,201,176,0.25)', hoverinfo: 'skip' },
        // median line
        { x: xs, y: med, type: 'scattergl', mode: 'lines+markers', name: 'median',
          line: { color: base, width: 2 }, marker: { size: 4, color: base },
          hovertemplate: 'tick %{x}: median %{y}<extra></extra>' },
    ];
    Plotly.newPlot(body, traces, {
        ..._layout(`${topic} — distribution across list items (n=${shape.length})`),
        showlegend: true,
    }, { responsive: true, displayModeBar: false });
}

function _renderTable(body, topic, entries) {
    // Heterogeneous / complex payloads → table with Inspect button per row.
    const rows = entries.slice().reverse().map((e, idx) => {
        const summary = _shortSummary(e.payload);
        return `<tr>
            <td class="ea-table__cell"><code>${e.tick}</code></td>
            <td><code class="ea-bus__payload">${esc(summary)}</code></td>
            <td><button class="ea-btn ea-bus-timeline__inspect" data-idx="${idx}">Inspect</button></td>
        </tr>`;
    }).join('');
    body.innerHTML = `
        <div class="ea-bus-timeline__table-wrap">
            <table class="ea-table ea-bus-table">
                <thead><tr>
                    <th class="ea-table__cell">Tick</th>
                    <th>Payload</th>
                    <th></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    const reversed = entries.slice().reverse();
    body.querySelectorAll('.ea-bus-timeline__inspect').forEach((btn) => {
        btn.addEventListener('click', () => {
            const i = Number(btn.dataset.idx);
            const e = reversed[i];
            if (!e) return;
            openBrainInspector({
                title: `${topic} @ tick ${e.tick}`,
                node:  e.payload,
            });
        });
    });
}


/* ─── helpers ───────────────────────────────────────────────────────── */

async function _plotlyOrFail(body) {
    try {
        return await ensurePlotly();
    } catch {
        body.innerHTML = '<div class="ea-plot__placeholder">Plotly failed to load.</div>';
        return null;
    }
}

function _layout(title) {
    return {
        ...DARK_THEME_LAYOUT,
        title: { text: title, font: { color: '#cccccc', size: 12 }, x: 0, xanchor: 'left' },
        margin: { l: 60, r: 16, t: 36, b: 40 },
        autosize: true,
        xaxis: { ...DARK_THEME_LAYOUT.xaxis, title: { text: 'tick', font: { size: 11 } } },
    };
}

function _stats(vals) {
    if (vals.length === 0) return { min: null, p10: null, median: null, p90: null, max: null };
    const sorted = vals.slice().sort((a, b) => a - b);
    const at = (q) => {
        const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
        return sorted[i];
    };
    return { min: sorted[0], p10: at(0.10), median: at(0.50), p90: at(0.90), max: sorted[sorted.length - 1] };
}

function _shortSummary(node) {
    if (!node) return '—';
    if (node.kind === 'primitive') {
        const v = node.value;
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'string') return JSON.stringify(v).slice(0, 80);
        return String(v);
    }
    if (node.kind === 'list') return `[${node.length} items]`;
    if (node.kind === 'dict') {
        const keys = Object.keys(node.items || {}).slice(0, 4).join(', ');
        return `{${node.length} keys${keys ? ': ' + keys : ''}}`;
    }
    if (node.kind === 'object') return `<${node.type}>`;
    if (node.kind === 'repr') return node.repr || '';
    if (node.kind === 'elided') return '…';
    return node.kind || '?';
}

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
