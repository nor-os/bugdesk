/**
 * sankey.js — thin Plotly Sankey wrapper.
 *
 * Standalone so the SFC page can render fund-flow diagrams without
 * pulling in Ecosim's full TileBase / SankeyTile machinery (those are
 * tied to the results-dashboard registry).
 */

import { ensurePlotly, DARK_THEME_LAYOUT } from '../../charting/plotly_wrapper.js';


// Categorical palette: tuned for dark backgrounds, picked to be
// distinguishable from each other (different hues, not just shades).
// Nodes cycle through this when the caller doesn't pass an explicit
// `color` — that gives each sector / category its own hue so the
// flows are visually traceable instead of all the same teal.
const NODE_PALETTE = [
    '#4ec9b0',  // teal
    '#9cdcfe',  // light blue
    '#dcdcaa',  // wheat
    '#c586c0',  // pink
    '#ce9178',  // orange
    '#b5cea8',  // sage
    '#569cd6',  // blue
    '#d16969',  // salmon
    '#608b4e',  // green
    '#d9886a',  // terracotta
    '#9b59b6',  // purple
    '#e6a23c',  // amber
];

function pickPaletteColor(i) {
    return NODE_PALETTE[i % NODE_PALETTE.length];
}

/** "#rrggbb" → "rgba(r, g, b, alpha)" for translucent link colors. */
function withAlpha(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


/**
 * Render a Sankey diagram into `host`.
 *
 * @param {HTMLElement} host
 * @param {Object} opts
 * @param {Array<{id: string, label?: string, color?: string}>} opts.nodes
 *        When a node has no `color`, one is auto-assigned from a
 *        categorical palette so each sector gets a distinct hue.
 * @param {Array<{source: number, target: number, value: number, color?: string, label?: string}>} opts.links
 *        Source/target are indices into `nodes`. When a link has no
 *        `color`, a translucent version of the source node's color is
 *        used so flows are easy to follow visually.
 * @param {string} [opts.title]
 * @param {number} [opts.height=320]
 */
export function buildSankey({ nodes = [], links = [], title = '', height = 320 } = {}) {
    const nodeColors = nodes.map((n, i) => n.color || pickPaletteColor(i));
    const trace = {
        type: 'sankey',
        orientation: 'h',
        valueformat: ',.2f',
        node: {
            label:     nodes.map((n) => n.label || n.id),
            color:     nodeColors,
            pad:       14,
            thickness: 18,
            line:      { color: 'rgba(255, 255, 255, 0.15)', width: 0.5 },
        },
        link: {
            source: links.map((l) => l.source),
            target: links.map((l) => l.target),
            value:  links.map((l) => Math.max(0, Number(l.value) || 0)),
            color:  links.map((l) => l.color
                || withAlpha(nodeColors[l.source] || '#4ec9b0', 0.45)),
            label:  links.map((l) => l.label || ''),
        },
    };
    const layout = {
        ...DARK_THEME_LAYOUT,
        margin:        { t: title ? 28 : 10, r: 8, b: 10, l: 8 },
        title:         title ? { text: title, font: { size: 12, color: '#aaa' }, y: 0.98 } : undefined,
        paper_bgcolor: 'transparent',
        plot_bgcolor:  'transparent',
        height,
    };
    return { trace, layout };
}


export async function renderSankey(host, opts = {}) {
    if (!host) return;
    const { nodes = [], links = [] } = opts;
    if (!Array.isArray(nodes) || !Array.isArray(links) || links.length === 0) {
        host.innerHTML = '<div class="ea-plot__placeholder">No flows to draw.</div>';
        return;
    }
    let Plotly;
    try {
        Plotly = await ensurePlotly();
    } catch (err) {
        host.innerHTML = '<div class="ea-plot__placeholder">Plotly failed to load.</div>';
        return;
    }
    const { trace, layout } = buildSankey(opts);
    await Plotly.react(host, [trace], layout, {
        responsive: true,
        displayModeBar: false,
    });
}
