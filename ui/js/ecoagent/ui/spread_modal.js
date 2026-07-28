/**
 * spread_modal.js — drilldown popup for an SFC time-series chart.
 *
 * Computes per-agent series for a given (asset_kind, side) cell by
 * grouping account histories by `agent_id`, then renders one of
 * lines / fan / candle through `renderSpreadChart`. Built on
 * `openModal` so chrome / Esc / focus trap match every other modal.
 *
 * Inputs:
 *   accountsBySector  — Bridge's sfc_accounts_by_sector snapshot.
 *   accountHistories  — Bridge's world_all_accounts_history snapshot.
 *   kind              — asset_kind id (e.g. 'cash').
 *   kindLabel         — display label for kind.
 *   defaultSide       — initial 'Assets' | 'Liabilities' | 'Equity' tab.
 */

import { openModal } from './modal.js';
import { renderSpreadChart } from './spread_chart.js';

const SIDES = ['Assets', 'Liabilities', 'Equity'];


export function openSpreadModal({
    kind, kindLabel, accountsBySector = {}, accountHistories = {},
    defaultSide = 'Assets',
} = {}) {
    // Walk the input data once: for each side, build per-agent series.
    const ticks = _unionTicks(accountHistories);
    const seriesBySide = {};
    const agentCounts = {};
    for (const side of SIDES) {
        seriesBySide[side] = _agentSeriesForKindSide({
            kind, side, ticks, accountsBySector, accountHistories,
        });
        agentCounts[side] = seriesBySide[side].length;
    }
    const sidesWithData = SIDES.filter((s) => agentCounts[s] > 0);
    const initialSide   = sidesWithData.includes(defaultSide)
        ? defaultSide : (sidesWithData[0] || defaultSide);

    const state = { side: initialSide, view: 'lines' };

    // Build content DOM. The modal subtitle, controls, chart host, and
    // legend all live in the body — openModal owns the title strip and
    // the footer action row.
    const content = document.createElement('div');
    content.className = 'ea-spread-modal__body';
    content.innerHTML = `
        <div class="ea-modal__hint" data-role="spread-subtitle"></div>
        <div class="ea-spread-modal__controls">
            <div class="ea-spread-modal__sides" data-role="spread-sides"></div>
            <div class="ea-segmented ea-segmented--small" data-role="spread-views">
                <button type="button" class="ea-segmented__btn ea-segmented__btn--active" data-view="lines">Lines</button>
                <button type="button" class="ea-segmented__btn"                          data-view="fan">Fan</button>
                <button type="button" class="ea-segmented__btn"                          data-view="candle">Candle</button>
            </div>
        </div>
        <div class="ea-spread-modal__host" data-role="spread-host"></div>
        <div class="ea-spread-modal__legend" data-role="spread-legend"></div>
    `;
    const host     = content.querySelector('[data-role="spread-host"]');
    const subtitle = content.querySelector('[data-role="spread-subtitle"]');
    const legend   = content.querySelector('[data-role="spread-legend"]');
    const sidesEl  = content.querySelector('[data-role="spread-sides"]');
    const viewsEl  = content.querySelector('[data-role="spread-views"]');

    sidesEl.innerHTML = sidesWithData.map((s) => `
        <button type="button" class="ea-segmented__btn ${s === state.side ? 'ea-segmented__btn--active' : ''}"
                data-side="${s}">${s}
            <span class="ea-spread-modal__count">${agentCounts[s]}</span>
        </button>
    `).join('');

    const redraw = () => {
        const series = seriesBySide[state.side] || [];
        subtitle.textContent =
            `${state.side} · ${series.length} agent${series.length === 1 ? '' : 's'} `
            + `· ${ticks.length} tick${ticks.length === 1 ? '' : 's'}`;
        legend.innerHTML = (state.view === 'lines' && series.length > 20)
            ? `Showing top-20 agents by max |value|; ${series.length - 20} hidden. `
              + 'Switch to Fan or Candle to see the full distribution.'
            : '';
        renderSpreadChart(host, {
            ticks,
            agentSeries: series.map((s) => ({
                agent_id: s.agent_id, values: s.values,
            })),
            view:  state.view,
            title: '',
        });
    };

    sidesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-side]');
        if (!btn) return;
        state.side = btn.dataset.side;
        sidesEl.querySelectorAll('[data-side]').forEach((b) =>
            b.classList.toggle('ea-segmented__btn--active',
                b.dataset.side === state.side));
        redraw();
    });
    viewsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        state.view = btn.dataset.view;
        viewsEl.querySelectorAll('[data-view]').forEach((b) =>
            b.classList.toggle('ea-segmented__btn--active',
                b.dataset.view === state.view));
        redraw();
    });

    if (sidesWithData.length === 0) {
        host.innerHTML = '<div class="ea-plot__placeholder">'
            + 'No agent-level history for this kind yet.</div>';
    }

    return openModal({
        title:   String(kindLabel || kind || 'Spread'),
        icon:    'multiline_chart',
        content,
        width:   880,
        height:  600,
        actions: [{ label: 'Close', value: null, primary: true }],
        onMount: () => { if (sidesWithData.length > 0) redraw(); },
    });
}


/* --------------------------------------------- aggregation helpers */

function _unionTicks(accountHistories) {
    const set = new Set();
    for (const series of Object.values(accountHistories || {})) {
        for (const p of (series || [])) set.add(Number(p[0]) || 0);
    }
    return [...set].sort((a, b) => a - b);
}


function _agentSeriesForKindSide({
    kind, side, ticks, accountsBySector, accountHistories,
}) {
    // Step 1: map agent_id -> list of account ids that match (kind, side).
    const byAgent = new Map();
    for (const accounts of Object.values(accountsBySector || {})) {
        for (const a of accounts || []) {
            if (a.asset_kind !== kind) continue;
            if (a.type !== side) continue;
            const aid = a.agent_id || '(unowned)';
            if (!byAgent.has(aid)) byAgent.set(aid, []);
            byAgent.get(aid).push(a.account_id);
        }
    }
    if (byAgent.size === 0) return [];

    // Step 2: build a tick-indexed lookup per account.
    const tickIndex = new Map(ticks.map((t, i) => [t, i]));
    const sums = [];
    for (const [agent_id, accountIds] of byAgent) {
        const vals = new Array(ticks.length).fill(0);
        let any = false;
        for (const accId of accountIds) {
            const hist = accountHistories[accId] || [];
            for (const [t, v] of hist) {
                const i = tickIndex.get(Number(t));
                if (i == null) continue;
                vals[i] += Number(v) || 0;
                any = true;
            }
        }
        if (any && _maxAbs(vals) > 0) {
            sums.push({ agent_id, values: vals });
        }
    }
    return sums;
}

function _maxAbs(arr) {
    let m = 0;
    for (const v of arr) { const a = Math.abs(Number(v) || 0); if (a > m) m = a; }
    return m;
}
