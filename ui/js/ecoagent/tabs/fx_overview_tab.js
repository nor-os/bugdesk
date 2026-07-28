/**
 * fx_overview_tab.js — single-screen rate ticker for every declared
 * FX pair in the world.
 *
 * Opens from the Markets sidebar (pseudo-entry "FX overview" at the
 * top of the list when ≥ 1 FX market exists). Reads
 * `bridge.fx_overview()` on mount and on every world tick push and
 * renders:
 *   * One row per pair with base / quote, country flags (label),
 *     current mid, last clearing volume, and the per-pair peg
 *     corridor with a status pill (inside / breach floor / breach
 *     ceiling) when the pair has a CB peg.
 *   * A header summary: total pairs, % inside corridor, anyone
 *     currently breached.
 *
 * Deliberately read-only — peg config still lives on the CB agent
 * tab; rate quoting still happens on individual market tabs. This
 * surface is the at-a-glance cross-cutting view that was the biggest
 * gap once the multi-currency engine became load-bearing.
 */

import { esc } from './_util.js';

const fmt4 = (v) => (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(4);
const fmt2 = (v) => (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(2);

export function makeFxOverviewTab(hostEl, _entityId, ctx) {
    return new FxOverviewTab(hostEl, ctx);
}

class FxOverviewTab {
    constructor(hostEl, { logger, eventBus } = {}) {
        this.hostEl = hostEl;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.eventBus = eventBus ?? null;
        this._pairs = [];
        this._active = false;
        this._tickHandler = () => this._refresh();
    }

    async mount() {
        this.hostEl.innerHTML = `
            <div class="ea-fx-overview">
                <header class="ea-detail-header"
                        title="Live mid prices for every declared FX pair. Pegged pairs show the CB's target corridor; the status pill flips when the mid breaches floor or ceiling.">
                    <h2>FX overview</h2>
                    <span class="ea-detail-header__spacer"></span>
                    <span class="ea-fx-summary" id="ea-fx-summary"></span>
                </header>
                <div class="ea-fx-overview__body">
                    <section class="ea-card">
                        <div id="ea-fx-table-host">
                            <div class="ea-plot__placeholder">Loading…</div>
                        </div>
                    </section>
                </div>
            </div>
        `;
        // Live refresh on every tick push from the run controller.
        this.eventBus?.on?.('ecoagent:run:tick', this._tickHandler);
        this.eventBus?.on?.('ecoagent:project:changed', this._tickHandler);
        await this._refresh();
    }

    dispose() {
        this.eventBus?.off?.('ecoagent:run:tick', this._tickHandler);
        this.eventBus?.off?.('ecoagent:project:changed', this._tickHandler);
    }

    async _refresh() {
        try {
            const r = await window.pywebview?.api?.fx_overview?.();
            this._active = !!r?.active;
            this._pairs = Array.isArray(r?.pairs) ? r.pairs : [];
        } catch (e) {
            this.logger.warn?.('fx_overview failed', e);
            this._pairs = []; this._active = false;
        }
        this._render();
    }

    _render() {
        const host = this.hostEl.querySelector('#ea-fx-table-host');
        const summary = this.hostEl.querySelector('#ea-fx-summary');
        if (!host || !summary) return;
        if (!this._active) {
            summary.textContent = '';
            host.innerHTML = `<div class="ea-plot__placeholder">No live world — run or step the simulation to see live FX rates.</div>`;
            return;
        }
        if (this._pairs.length === 0) {
            summary.textContent = '';
            host.innerHTML = `<div class="ea-plot__placeholder">No FX markets declared. Add an FX market under Markets to bridge two currencies.</div>`;
            return;
        }
        const pegs = this._pairs.filter((p) => p.peg);
        const breached = pegs.filter((p) => p.peg && p.peg.status && p.peg.status !== 'inside');
        summary.innerHTML = `
            <span>${this._pairs.length} pair${this._pairs.length === 1 ? '' : 's'}</span>
            <span class="ea-badge ea-badge--muted">${pegs.length} pegged</span>
            ${breached.length > 0
                ? `<span class="ea-badge ea-badge--bad">${breached.length} breached</span>`
                : (pegs.length > 0
                    ? `<span class="ea-badge ea-badge--ok">all inside corridor</span>`
                    : '')}
        `;
        const rows = this._pairs.map((p) => this._renderRowHtml(p)).join('');
        host.innerHTML = `
            <table class="ea-table ea-fx-table">
                <thead>
                    <tr>
                        <th>Pair</th>
                        <th>Countries</th>
                        <th class="ea-fx-num">Mid</th>
                        <th>Peg corridor</th>
                        <th class="ea-fx-num">Last volume</th>
                        <th class="ea-fx-num">Orders</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    _renderRowHtml(p) {
        const cbase = p.country_base ? esc(p.country_base) : '<span class="ea-text--muted">—</span>';
        const cquote = p.country_quote ? esc(p.country_quote) : '<span class="ea-text--muted">—</span>';
        const mid = (p.mid == null)
            ? '<span class="ea-text--muted">no quote yet</span>'
            : esc(fmt4(p.mid));
        const pegCell = p.peg ? this._renderPegCellHtml(p.peg) : '<span class="ea-text--muted">free float</span>';
        return `
            <tr>
                <td><b>${esc(p.base)} / ${esc(p.quote)}</b><br><small class="ea-text--muted">${esc(p.market_id)}</small></td>
                <td>${cbase} → ${cquote}</td>
                <td class="ea-fx-num">${mid}</td>
                <td>${pegCell}</td>
                <td class="ea-fx-num">${esc(fmt2(p.last_volume))}</td>
                <td class="ea-fx-num"><span title="Buy orders">${p.n_buys}</span> / <span title="Sell orders">${p.n_sells}</span></td>
            </tr>
        `;
    }

    _renderPegCellHtml(peg) {
        const status = peg.status || 'inside';
        const cls = status === 'inside'
            ? 'ea-badge--ok'
            : 'ea-badge--bad';
        const label = ({
            inside: 'inside corridor',
            below_floor: '↓ below floor',
            above_ceiling: '↑ above ceiling',
        })[status] || status;
        const cb = peg.cb_country ? esc(peg.cb_country) : esc(peg.cb_archetype);
        return `
            <span class="ea-fx-peg">
                <span class="ea-fx-peg__range">[${esc(fmt4(peg.floor))} – <b>${esc(fmt4(peg.target))}</b> – ${esc(fmt4(peg.ceiling))}]</span>
                <span class="ea-badge ${cls}">${label}</span>
                <small class="ea-text--muted">CB: ${cb}</small>
            </span>
        `;
    }
}
