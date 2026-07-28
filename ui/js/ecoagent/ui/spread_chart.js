/**
 * spread_chart.js — three views of "value over time across N agents":
 *
 *   - lines:  one line per agent (top-N by max |value|), discrete colors.
 *   - fan:    median + interquartile + p10/p90 filled bands.
 *   - candle: per-tick min/max as error bars + p25/p75 box + median dot.
 *
 * Backed by Plotly (already vendored). Input shape:
 *
 *   renderSpreadChart(host, {
 *     ticks:       [0, 1, 2, ...],
 *     agentSeries: [{ agent_id, values: [v0, v1, ...] }, ...],  // aligned with ticks
 *     view:        'lines' | 'fan' | 'candle',
 *     title:       'Cash · Assets',
 *   });
 */

import { ensurePlotly, DARK_THEME_LAYOUT } from '../../charting/plotly_wrapper.js';


const PALETTE = [
    '#4ec9b0', '#9cdcfe', '#d9886a', '#dcdcaa', '#c586c0', '#569cd6',
    '#b5cea8', '#ce9178', '#646695', '#e8a87c', '#85c1c8', '#f0a5d6',
];

const LINES_TOP_N = 20;


export async function renderSpreadChart(host, {
    ticks = [], agentSeries = [], view = 'lines', title = '',
} = {}) {
    if (!host) return;
    if (!Array.isArray(ticks) || ticks.length === 0
        || !Array.isArray(agentSeries) || agentSeries.length === 0) {
        host.innerHTML = '<div class="ea-plot__placeholder">No data in this slice.</div>';
        return;
    }

    let Plotly;
    try {
        Plotly = await ensurePlotly();
    } catch {
        host.innerHTML = '<div class="ea-plot__placeholder">Plotly failed to load.</div>';
        return;
    }

    const layoutBase = {
        ...DARK_THEME_LAYOUT,
        paper_bgcolor: 'transparent',
        plot_bgcolor:  'transparent',
        margin:        { t: title ? 32 : 12, r: 16, b: 32, l: 48 },
        title:         title ? { text: title, font: { size: 12, color: '#aaa' }, y: 0.98 } : undefined,
        height:        360,
        xaxis: {
            title: { text: 'tick', font: { size: 11, color: '#888' } },
            color: '#888',
            gridcolor: '#232323',
        },
        yaxis: {
            color: '#888',
            gridcolor: '#232323',
        },
        legend: {
            font: { color: '#ccc', size: 11 },
            bgcolor: 'transparent',
        },
    };

    let traces;
    if (view === 'lines')      traces = _linesTraces(ticks, agentSeries);
    else if (view === 'fan')   traces = _fanTraces(ticks, agentSeries);
    else if (view === 'candle') traces = _candleTraces(ticks, agentSeries);
    else                       traces = _linesTraces(ticks, agentSeries);

    await Plotly.react(host, traces, layoutBase, {
        responsive: true,
        displayModeBar: false,
    });
}


/* ----------------------------------------------------------- lines */

function _linesTraces(ticks, agentSeries) {
    // Pick the top-N agents by max |value| so the legend stays readable
    // with very large populations.
    const ranked = agentSeries
        .map((s) => ({ s, score: _maxAbs(s.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, LINES_TOP_N);
    return ranked.map(({ s }, i) => ({
        type: 'scatter',
        mode: 'lines',
        name: s.agent_id,
        x:    ticks,
        y:    s.values,
        line: { color: PALETTE[i % PALETTE.length], width: 1.3 },
        hovertemplate: `${s.agent_id}<br>tick %{x}: %{y:.2f}<extra></extra>`,
    }));
}

function _maxAbs(values) {
    let m = 0;
    for (const v of values) {
        const a = Math.abs(Number(v) || 0);
        if (a > m) m = a;
    }
    return m;
}


/* ------------------------------------------------------------- fan */

function _fanTraces(ticks, agentSeries) {
    const { p10, p25, p50, p75, p90 } = _percentilesPerTick(ticks.length, agentSeries);
    const COLOR = '#4ec9b0';
    return [
        // Outer band — p10..p90, light fill. Lower bound first (no fill),
        // upper bound with fill='tonexty'.
        {
            type: 'scatter', mode: 'lines', name: 'p10', x: ticks, y: p10,
            line: { color: 'transparent' }, hoverinfo: 'skip', showlegend: false,
        },
        {
            type: 'scatter', mode: 'lines', name: 'p10–p90', x: ticks, y: p90,
            line: { color: 'transparent' },
            fill: 'tonexty', fillcolor: 'rgba(78, 201, 176, 0.12)',
            hovertemplate: 'tick %{x}<br>p10..p90<extra></extra>',
        },
        // Inner band — p25..p75.
        {
            type: 'scatter', mode: 'lines', name: 'p25', x: ticks, y: p25,
            line: { color: 'transparent' }, hoverinfo: 'skip', showlegend: false,
        },
        {
            type: 'scatter', mode: 'lines', name: 'p25–p75', x: ticks, y: p75,
            line: { color: 'transparent' },
            fill: 'tonexty', fillcolor: 'rgba(78, 201, 176, 0.30)',
            hovertemplate: 'tick %{x}<br>p25..p75<extra></extra>',
        },
        // Median line on top.
        {
            type: 'scatter', mode: 'lines', name: 'median', x: ticks, y: p50,
            line: { color: COLOR, width: 1.8 },
            hovertemplate: 'tick %{x}<br>median %{y:.2f}<extra></extra>',
        },
    ];
}


/* ---------------------------------------------------------- candle */

function _candleTraces(ticks, agentSeries) {
    const { p10, p25, p50, p75, p90 } = _percentilesPerTick(ticks.length, agentSeries);
    const COLOR = '#9cdcfe';
    // Two error-bar traces: one for min-max (thin), one for IQR (thick).
    // Each is a scatter at the median with custom asymmetric error.
    const errLow_full = p50.map((m, i) => m - p10[i]);
    const errHi_full  = p50.map((m, i) => p90[i] - m);
    const errLow_iqr  = p50.map((m, i) => m - p25[i]);
    const errHi_iqr   = p50.map((m, i) => p75[i] - m);
    return [
        {
            type: 'scatter', mode: 'markers', name: 'p10–p90',
            x: ticks, y: p50,
            marker: { size: 1, color: 'rgba(0,0,0,0)' },
            error_y: {
                type: 'data', symmetric: false,
                array: errHi_full, arrayminus: errLow_full,
                color: 'rgba(156, 220, 254, 0.45)',
                thickness: 1, width: 3,
            },
            hovertemplate: 'tick %{x}<br>p10..p90<extra></extra>',
        },
        {
            type: 'scatter', mode: 'markers', name: 'p25–p75',
            x: ticks, y: p50,
            marker: { size: 1, color: 'rgba(0,0,0,0)' },
            error_y: {
                type: 'data', symmetric: false,
                array: errHi_iqr, arrayminus: errLow_iqr,
                color: 'rgba(156, 220, 254, 0.85)',
                thickness: 4, width: 5,
            },
            hovertemplate: 'tick %{x}<br>p25..p75<extra></extra>',
        },
        {
            type: 'scatter', mode: 'markers', name: 'median',
            x: ticks, y: p50,
            marker: { size: 4, color: COLOR },
            hovertemplate: 'tick %{x}<br>median %{y:.2f}<extra></extra>',
        },
    ];
}


/* ------------------------------------------------------ percentiles */

function _percentilesPerTick(nTicks, agentSeries) {
    const p10 = new Array(nTicks);
    const p25 = new Array(nTicks);
    const p50 = new Array(nTicks);
    const p75 = new Array(nTicks);
    const p90 = new Array(nTicks);
    for (let t = 0; t < nTicks; t++) {
        const col = [];
        for (const s of agentSeries) {
            const v = s.values[t];
            if (Number.isFinite(v)) col.push(v);
        }
        col.sort((a, b) => a - b);
        p10[t] = _quantile(col, 0.10);
        p25[t] = _quantile(col, 0.25);
        p50[t] = _quantile(col, 0.50);
        p75[t] = _quantile(col, 0.75);
        p90[t] = _quantile(col, 0.90);
    }
    return { p10, p25, p50, p75, p90 };
}

function _quantile(sortedArr, q) {
    if (sortedArr.length === 0) return 0;
    if (sortedArr.length === 1) return sortedArr[0];
    const pos = (sortedArr.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sortedArr[lo];
    const frac = pos - lo;
    return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}
