/**
 * sfc_overview_tab.js — world-level SFC views, as a single workspace tab.
 *
 * Holds the three views that have no per-entity home: Cross-sector
 * consistency (+ asset-kind CRUD), Time series, and the Transaction Flow
 * Matrix — plus the time scrubber, which it owns and writes into the
 * shared sfc_view_state (Sector tabs read it).
 *
 * Run Console and InfoBus, which used to sit on the SFC page, now live
 * in the global bottom panel — they are intentionally NOT here.
 *
 * Ported from sfc_page.js.
 */

import { renderLineChart } from '../ui/charts.js';
import { getViewingTick, setViewingTick } from '../sfc_view_state.js';
import { esc, fmt } from './_util.js';

/** Factory registered with WorkspaceTabs for kind `sfc-overview`. */
export function makeSfcOverviewTab(hostEl, _entityId, ctx) {
    return new SfcOverviewTab(hostEl, ctx);
}

class SfcOverviewTab {
    constructor(hostEl, { logger, eventBus, compact = false } = {}) {
        this.hostEl = hostEl;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.eventBus = eventBus ?? null;
        // Compact mode strips the per-card hint paragraphs + tightens
        // padding so the overview fits the bottom-panel form factor.
        // The bottom panel hosts the only live mount today; the
        // workspace-tab provider stays registered for restored legacy
        // tabs but renders the same compact shell.
        this.compact = !!compact;

        this._sectors = [];
        this._countries = [];
        this._assetKinds = [];
        this._balanceSheet = {};
        this._accountsBySector = {};
        this._historyAggregates = [];
        this._flowMatrix = {};
        this._tfm = {};
        this._accountHistories = {};
        this._historyLastTick = 0;
        this._flowAtTick = false;
        this._flowView = 'matrix';   // 'matrix' | 'diagram'
        this._crossByCountry = false;
        // Same race-guard pattern as sector_tab: every refresh bumps
        // this token; a stale one drops its result on the floor so a
        // slow earlier fetch can't overwrite the page with snapshot
        // data the user has already scrubbed past.
        this._refreshSeq = 0;
        this._scrubDebounce = null;
    }

    async mount() {
        // Single-line scrubber + segmented section pager. Cards lose
        // their hint paragraphs — the section titles are descriptive
        // enough for the bottom-panel form factor (full prose lives
        // in the help service / project setup tab).
        this.hostEl.innerHTML = `
            <div class="ea-sfc-overview ea-sfc-overview--compact">
                <div class="ea-sfc__bar">
                    <div class="ea-segmented ea-segmented--small" role="tablist" data-role="section-pager">
                        <button type="button" class="ea-segmented__btn ea-segmented__btn--active"
                                data-section="consistency">Consistency</button>
                        <button type="button" class="ea-segmented__btn"
                                data-section="country" data-host-id="ea-country-rollup-card">By country</button>
                        <button type="button" class="ea-segmented__btn"
                                data-section="series">Time series</button>
                        <button type="button" class="ea-segmented__btn"
                                data-section="flow">Flow matrix</button>
                        <button type="button" class="ea-segmented__btn"
                                data-section="tfm">Godley TFM</button>
                    </div>
                    <div class="ea-time-scrubber ea-time-scrubber--compact" id="ea-time-scrubber" hidden>
                        <span class="ea-time-scrubber__label">Tick</span>
                        <input type="range" id="ea-scrubber-slider" min="0" max="0" value="0">
                        <span class="ea-time-scrubber__value" id="ea-scrubber-value">0</span>
                        <button class="ea-btn ea-btn--small ea-time-scrubber__latest" id="ea-scrubber-latest"
                                title="Snap to the latest tick">Latest</button>
                    </div>
                </div>

                <section class="ea-card ea-sfc__pane" data-pane="consistency">
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Cross-sector consistency</h3>
                        <label class="ea-row ea-card__head-toggle" id="ea-cross-grp-label" hidden>
                            <input type="checkbox" id="ea-cross-by-country">
                            Group by country
                        </label>
                    </div>
                    <div id="ea-cross-sector"></div>
                </section>

                <section class="ea-card ea-sfc__pane" data-pane="country" id="ea-country-rollup-card" hidden>
                    <h3 class="ea-card__title">By country</h3>
                    <div id="ea-by-country"></div>
                </section>

                <section class="ea-card ea-sfc__pane" data-pane="series" hidden>
                    <h3 class="ea-card__title">Time series</h3>
                    <div id="ea-history-charts">
                        <div class="ea-plot__placeholder">Run the world to populate the time series.</div>
                    </div>
                </section>

                <section class="ea-card ea-sfc__pane" data-pane="flow" hidden>
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Transaction Flow Matrix</h3>
                        <div class="ea-flow-matrix__controls">
                            <div class="ea-segmented ea-segmented--small" role="tablist">
                                <button type="button" class="ea-segmented__btn ea-segmented__btn--active"
                                        data-flow-view="matrix">Matrix</button>
                                <button type="button" class="ea-segmented__btn"
                                        data-flow-view="diagram">Diagram</button>
                            </div>
                            <label>
                                <input type="checkbox" id="ea-flow-at-tick">
                                Only viewing tick
                            </label>
                            <button type="button" class="ea-btn ea-btn--icon"
                                    data-role="flow-popout" title="Open in window"
                                    hidden>
                                <span class="material-symbols-outlined">open_in_new</span>
                            </button>
                        </div>
                    </div>
                    <div id="ea-flow-matrix">
                        <div class="ea-plot__placeholder">No transactions yet.</div>
                    </div>
                </section>

                <section class="ea-card ea-sfc__pane" data-pane="tfm" hidden>
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Transactions Flow Matrix</h3>
                        <span class="ea-text--muted ea-tfm__hint">
                            Declarative flow rows · each flow row must sum to zero
                        </span>
                    </div>
                    <div id="ea-tfm-matrix">
                        <div class="ea-plot__placeholder">No declarative flows yet.</div>
                    </div>
                </section>
            </div>
        `;

        const $ = (id) => this.hostEl.querySelector(id);
        // Section pager — one card visible at a time; the pane buttons
        // swap which one. Keeps the bottom-panel mount short instead
        // of stacking four full cards vertically. "By country" is
        // disabled until at least one country is declared (handled by
        // _renderByCountry, which toggles the button's --disabled
        // class via the hidden state of #ea-country-rollup-card).
        this._activePane = 'consistency';
        this._showPane = (paneId) => {
            this._activePane = paneId;
            this.hostEl.querySelectorAll('[data-pane]').forEach((el) => {
                el.hidden = el.dataset.pane !== paneId;
            });
            this.hostEl.querySelectorAll('[data-section]').forEach((btn) => {
                btn.classList.toggle('ea-segmented__btn--active',
                    btn.dataset.section === paneId);
            });
            // Re-render the now-visible pane so Plotly charts size
            // themselves to the (newly non-hidden) container.
            if (paneId === 'series')      this._renderHistoryCharts();
            else if (paneId === 'flow')   this._renderFlowMatrix();
            else if (paneId === 'tfm')    this._renderTfm();
        };
        this.hostEl.querySelectorAll('[data-section]').forEach((btn) => {
            btn.addEventListener('click', () => this._showPane(btn.dataset.section));
        });
        const slider = $('#ea-scrubber-slider');
        const valEl  = this.hostEl.querySelector('#ea-scrubber-value');
        // Same debounce pattern as sector_tab — update the readout
        // immediately on every drag pixel, but defer the heavy
        // refresh until the drag quiets.
        slider.addEventListener('input',  () => {
            if (valEl) valEl.textContent = String(slider.value);
            clearTimeout(this._scrubDebounce);
            this._scrubDebounce = setTimeout(
                () => this._onScrub(Number(slider.value)), 60,
            );
        });
        slider.addEventListener('change', () => {
            clearTimeout(this._scrubDebounce);
            this._onScrub(Number(slider.value));
        });
        $('#ea-scrubber-latest').addEventListener('click', () => {
            clearTimeout(this._scrubDebounce);
            setViewingTick(null);
            this.refresh();
        });
        $('#ea-cross-by-country')?.addEventListener('change', (e) => {
            this._crossByCountry = !!e.target.checked;
            this._renderCrossSector();
        });
        $('#ea-flow-at-tick')?.addEventListener('change', (e) => {
            this._flowAtTick = !!e.target.checked;
            this.refresh();
        });
        this.hostEl.querySelectorAll('[data-flow-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._flowView = btn.dataset.flowView;
                this.hostEl.querySelectorAll('[data-flow-view]').forEach((b) => {
                    b.classList.toggle('ea-segmented__btn--active',
                        b.dataset.flowView === this._flowView);
                });
                this._syncFlowPopoutBtn();
                this._renderFlowMatrix();
            });
        });
        this.hostEl.querySelector('[data-role="flow-popout"]')
            ?.addEventListener('click', () => this._openFlowPopout());
        this._syncFlowPopoutBtn();
        await this.refresh();
    }

    _syncFlowPopoutBtn() {
        // Pop-out only makes sense for the diagram — the matrix view is
        // already a table; the popout's data tab would just duplicate it.
        const btn = this.hostEl?.querySelector('[data-role="flow-popout"]');
        if (btn) btn.hidden = this._flowView !== 'diagram';
    }

    show() {}
    hide() {}
    dispose() {
        clearTimeout(this._scrubDebounce); this._scrubDebounce = null;
        // Bump the seq so an in-flight refresh discards its result
        // when it resolves into a disposed tab.
        this._refreshSeq++;
    }

    // ------------------------------------------------------------- data flow

    async refresh() {
        const at = getViewingTick();
        const flowAt = this._flowAtTick && at != null ? at : null;
        const seq = ++this._refreshSeq;
        try {
            const [sectors, countries, kinds, bs, accs, summary, aggs, fm, accHist, tfm] = await Promise.all([
                window.pywebview?.api?.sectors_list?.()                  ?? [],
                window.pywebview?.api?.countries_list?.()                ?? [],
                window.pywebview?.api?.assets_list?.()              ?? [],
                at != null
                    ? window.pywebview?.api?.sfc_balance_sheet?.(at)      ?? {}
                    : window.pywebview?.api?.sfc_balance_sheet?.()        ?? {},
                at != null
                    ? window.pywebview?.api?.sfc_accounts_by_sector?.(at) ?? {}
                    : window.pywebview?.api?.sfc_accounts_by_sector?.()   ?? {},
                window.pywebview?.api?.world_history_summary?.()         ?? null,
                window.pywebview?.api?.world_history_aggregates?.()      ?? [],
                flowAt != null
                    ? window.pywebview?.api?.world_transaction_flow_matrix?.(flowAt) ?? {}
                    : window.pywebview?.api?.world_transaction_flow_matrix?.()        ?? {},
                window.pywebview?.api?.world_all_accounts_history?.()    ?? {},
                window.pywebview?.api?.sfc_tfm_matrix?.()                ?? null,
            ]);
            // Drop stale completions — see _refreshSeq init for why.
            if (seq !== this._refreshSeq) return;
            this._sectors = Array.isArray(sectors) ? sectors : [];
            this._countries = Array.isArray(countries) ? countries : [];
            this._assetKinds = Array.isArray(kinds) ? kinds : [];
            this._balanceSheet = (bs && typeof bs === 'object') ? bs : {};
            this._accountsBySector = (accs && typeof accs === 'object') ? accs : {};
            this._historyAggregates = Array.isArray(aggs) ? aggs : [];
            this._flowMatrix = (fm && typeof fm === 'object') ? fm : {};
            this._accountHistories = (accHist && typeof accHist === 'object') ? accHist : {};
            // sfc_tfm_matrix returns {ok, matrix}; stash the matrix (or {}
            // when no world is running / the endpoint errored).
            this._tfm = (tfm && tfm.ok && typeof tfm.matrix === 'object') ? tfm.matrix : {};
            if (summary && typeof summary === 'object') {
                this._historyLastTick = Number(summary.last_tick) || 0;
            }
        } catch (err) {
            this.logger.warn?.('SFC overview refresh failed', { err });
        }
        this._renderCrossSector();
        this._renderByCountry();
        this._renderHistoryCharts();
        this._renderFlowMatrix();
        this._renderTfm();
        this._updateScrubber();
    }

    // ----------------------------------------------------------- scrubber

    async _onScrub(tick) {
        const clamped = Math.max(0, Math.min(this._historyLastTick, Number(tick)));
        const valEl = this.hostEl?.querySelector('#ea-scrubber-value');
        if (valEl) valEl.textContent = String(clamped);
        // setViewingTick notifies the rest of the app (open sector
        // tabs, etc.). It only fires listeners when the value actually
        // changes — `refresh()` is called unconditionally so the local
        // scrubber click ("Latest"/identical value) still updates the
        // visible panes when nothing else triggers it.
        setViewingTick(clamped);
        await this.refresh();
    }

    _updateScrubber() {
        const wrap   = this.hostEl?.querySelector('#ea-time-scrubber');
        const slider = this.hostEl?.querySelector('#ea-scrubber-slider');
        const valEl  = this.hostEl?.querySelector('#ea-scrubber-value');
        if (!wrap || !slider || !valEl) return;
        if (this._historyLastTick <= 0) { wrap.hidden = true; return; }
        wrap.hidden = false;
        slider.max = String(this._historyLastTick);
        const viewing = getViewingTick();
        const tick = viewing == null ? this._historyLastTick : viewing;
        slider.value = String(tick);
        valEl.textContent = String(tick);
    }

    // ------------------------------------------------------- by country
    //
    // Hidden when no countries are declared (single-country / legacy
    // projects). Otherwise: one row per country with Σ Assets,
    // Σ Liabilities, Σ Equity, and net worth — summed across every
    // asset kind. Sectors not assigned to any country are bucketed
    // under "(unassigned)" so they don't silently disappear.

    _renderByCountry() {
        const target = this.hostEl?.querySelector('#ea-by-country');
        const card   = this.hostEl?.querySelector('#ea-country-rollup-card');
        if (!target || !card) return;
        // Pager visibility (hide the section button when there are no
        // countries — keeps the segmented row clean for legacy / not-
        // yet-configured projects).
        const pagerBtn = this.hostEl?.querySelector('[data-section="country"]');
        const hasCountries = !!(this._countries && this._countries.length > 0);
        if (pagerBtn) pagerBtn.hidden = !hasCountries;
        if (!hasCountries) {
            // Active pane fallback: if the user was viewing By Country
            // and all countries vanished (rare), bounce back to
            // consistency so they're not staring at an empty pane.
            if (this._activePane === 'country') this._showPane?.('consistency');
            target.innerHTML = '';
            return;
        }
        // Card visibility is now owned by `_showPane` — don't override
        // `hidden` here just because the data is present.
        // Bucket sectors by country (with an "(unassigned)" overflow).
        const bySector = new Map(this._sectors.map((s) => [s.id, s]));
        const buckets = new Map();
        for (const c of this._countries) {
            buckets.set(c.id, { country: c, sectors: [] });
        }
        const unassigned = { country: { id: '(unassigned)', label: '(unassigned)', currency: '' }, sectors: [] };
        for (const s of this._sectors) {
            const cid = s.country || '';
            if (cid && buckets.has(cid)) buckets.get(cid).sectors.push(s);
            else unassigned.sectors.push(s);
        }
        const all = [...buckets.values()];
        if (unassigned.sectors.length > 0) all.push(unassigned);
        const rows = all.map((b) => {
            let assets = 0, liab = 0, eq = 0;
            for (const s of b.sectors) {
                const perKind = this._balanceSheet[s.id] || {};
                for (const k of this._assetKinds) {
                    const r = perKind[k.id] || {};
                    if (typeof r.Assets === 'number')      assets += r.Assets;
                    if (typeof r.Liabilities === 'number') liab += r.Liabilities;
                    if (typeof r.Equity === 'number')      eq += r.Equity;
                }
            }
            const net = assets - liab;
            return `
                <tr>
                    <th class="ea-table__row-head">
                        ${esc(b.country.label || b.country.id)}
                        ${b.country.currency ? `<span class="ea-badge ea-badge--muted" style="margin-left:8px;">${esc(b.country.currency)}</span>` : ''}
                    </th>
                    <td class="ea-table__cell">${b.sectors.length}</td>
                    <td class="ea-table__cell">${fmt(assets)}</td>
                    <td class="ea-table__cell">${fmt(liab)}</td>
                    <td class="ea-table__cell">${fmt(eq)}</td>
                    <td class="ea-table__cell"><b>${fmt(net)}</b></td>
                </tr>`;
        }).join('');
        target.innerHTML = `
            <table class="ea-table ea-table--sheet">
                <thead><tr>
                    <th>Country</th>
                    <th class="ea-table__cell">Sectors</th>
                    <th class="ea-table__cell">Σ Assets</th>
                    <th class="ea-table__cell">Σ Liabilities</th>
                    <th class="ea-table__cell">Σ Equity</th>
                    <th class="ea-table__cell">Net worth</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    // -------------------------------------------------- cross-sector card

    _renderCrossSector() {
        const target = this.hostEl?.querySelector('#ea-cross-sector');
        if (!target) return;
        // Show/hide the group-by-country toggle. Hidden when there are
        // no countries (legacy single-country / unconfigured projects).
        const grpLabel = this.hostEl?.querySelector('#ea-cross-grp-label');
        if (grpLabel) grpLabel.hidden = !(this._countries && this._countries.length > 1);
        const kinds = this._assetKinds;
        if (kinds.length === 0 || this._sectors.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + 'Configure sectors and asset kinds first.</div>';
            return;
        }
        const sumOver = (sectors) => kinds.map((k) => {
            let assets = 0, liab = 0, eq = 0;
            for (const s of sectors) {
                const r = this._balanceSheet[s.id]?.[k.id] || {};
                if (typeof r.Assets === 'number')      assets += r.Assets;
                if (typeof r.Liabilities === 'number') liab += r.Liabilities;
                if (typeof r.Equity === 'number')      eq += r.Equity;
            }
            return { k, assets, liab, eq };
        });
        const rowHtml = ({ k, assets, liab, eq }, { showCheck = true } = {}) => {
            const net = assets - liab - eq;
            const ok = Math.abs(net) < 1e-6;
            const check = showCheck
                ? (ok ? '<span class="ea-check ea-check--ok">✓</span>'
                      : `<span class="ea-check ea-check--leak">${fmt(net)}</span>`)
                : `<span class="ea-text--muted">${fmt(net)}</span>`;
            // assets_list() returns `name`, not `label`. Fall back
            // through name → id so the row-head is never empty.
            const kindLabel = k.label || k.name || k.id || '';
            return `
                <tr>
                    <th class="ea-table__row-head">${esc(kindLabel)}</th>
                    <td class="ea-table__cell">${fmt(assets)}</td>
                    <td class="ea-table__cell">${fmt(liab)}</td>
                    <td class="ea-table__cell">${fmt(eq)}</td>
                    <td class="ea-table__cell">${check}</td>
                </tr>`;
        };
        const tableHtml = (rows) => `
            <table class="ea-table ea-table--sheet">
                <thead><tr>
                    <th>Asset kind</th>
                    <th class="ea-table__cell">Σ Assets</th>
                    <th class="ea-table__cell">Σ Liabilities</th>
                    <th class="ea-table__cell">Σ Equity</th>
                    <th class="ea-table__cell">A − L − E</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        if (!this._crossByCountry) {
            const rows = sumOver(this._sectors).map((r) => rowHtml(r)).join('');
            target.innerHTML = tableHtml(rows);
            return;
        }
        // Grouped mode — one block per country + a World totals block.
        const buckets = new Map();
        for (const c of this._countries) buckets.set(c.id, { country: c, sectors: [] });
        const unassigned = { country: { id: '__unassigned', label: '(unassigned)', currency: '' }, sectors: [] };
        for (const s of this._sectors) {
            if (s.country && buckets.has(s.country)) buckets.get(s.country).sectors.push(s);
            else unassigned.sectors.push(s);
        }
        const blocks = [...buckets.values()];
        if (unassigned.sectors.length) blocks.push(unassigned);
        const blockHtml = blocks.map((b) => {
            const rows = sumOver(b.sectors).map(
                (r) => rowHtml(r, { showCheck: false }),
            ).join('');
            const ccyChip = b.country.currency
                ? `<span class="ea-badge ea-badge--muted">${esc(b.country.currency)}</span>`
                : '';
            return `
                <div class="ea-cross-block">
                    <h4 class="ea-cross-block__title">
                        ${esc(b.country.label || b.country.id)} ${ccyChip}
                        <span class="ea-text--muted">— ${b.sectors.length} sector${b.sectors.length === 1 ? '' : 's'}</span>
                    </h4>
                    ${tableHtml(rows)}
                </div>`;
        }).join('');
        const worldRows = sumOver(this._sectors).map((r) => rowHtml(r)).join('');
        target.innerHTML = `
            ${blockHtml}
            <div class="ea-cross-block ea-cross-block--world">
                <h4 class="ea-cross-block__title">World — must balance</h4>
                ${tableHtml(worldRows)}
            </div>
        `;
    }

    // --------------------------------------------------- time-series card

    _renderHistoryCharts() {
        const target = this.hostEl?.querySelector('#ea-history-charts');
        if (!target) return;
        const aggs = this._historyAggregates || [];
        if (aggs.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + 'Run the world to populate the time series.</div>';
            return;
        }
        const allKinds = new Set();
        for (const e of aggs) for (const k of Object.keys(e.kinds || {})) allKinds.add(k);
        const interesting = [...allKinds].filter((k) =>
            aggs.some((e) => {
                const r = e.kinds[k] || {};
                return Math.abs(r.Assets || 0) + Math.abs(r.Liabilities || 0)
                     + Math.abs(r.Equity || 0) > 1e-9;
            }));
        if (interesting.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">No non-zero balances yet.</div>';
            return;
        }
        target.innerHTML = '';
        const viewingTick = getViewingTick();
        for (const kind of interesting) {
            const card = document.createElement('div');
            card.className = 'ea-chart-card';
            card.innerHTML = `
                <div class="ea-chart-card__head">
                    <button type="button" class="tree-node__action-btn ea-chart-card__drill"
                            data-kind="${esc(kind)}" title="Open agent-level spread">
                        <span class="material-symbols-outlined">more_horiz</span>
                    </button>
                </div>
                <div class="ea-chart-card__body"></div>
            `;
            target.appendChild(card);
            const chartHost = card.querySelector('.ea-chart-card__body');
            const series = ['Assets', 'Liabilities', 'Equity'].map((side) => ({
                name: side,
                color: SIDE_COLORS[side],
                points: aggs.map((e) => [e.tick, Number((e.kinds?.[kind]?.[side]) ?? 0)]),
            }));
            // Width is intentionally compact — `#ea-history-charts` is a
            // 4-column grid (see ecoagent_extra_modes.css). Charts wrap
            // to the next row beyond 4 per row.
            renderLineChart(chartHost, {
                title: kindLabel(this._assetKinds, kind),
                series, width: 260, height: 140,
                viewingTick,
                onClickTick: (t) => {
                    const clamped = Math.max(0, Math.min(this._historyLastTick, t));
                    setViewingTick(clamped);
                    this.refresh();
                },
            });
            card.querySelector('.ea-chart-card__drill')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._onOpenSpread(kind);
                });
        }
    }

    async _onOpenSpread(kind) {
        const { openSpreadModal } = await import('../ui/spread_modal.js');
        await openSpreadModal({
            kind,
            kindLabel:        kindLabel(this._assetKinds, kind),
            accountsBySector: this._accountsBySector || {},
            accountHistories: this._accountHistories || {},
            defaultSide:      'Assets',
        });
    }

    // ------------------------------------------------- transaction matrix

    _renderFlowMatrix() {
        const target = this.hostEl?.querySelector('#ea-flow-matrix');
        if (!target) return;
        const fm = this._flowMatrix || {};
        const rowSecs = Object.keys(fm);
        if (rowSecs.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + (this._flowAtTick ? 'No flows fired at this tick.'
                                    : 'No transactions yet.') + '</div>';
            return;
        }
        const allSecs = new Set(rowSecs);
        const allKinds = new Set();
        for (const from of rowSecs) {
            for (const to of Object.keys(fm[from] || {})) {
                allSecs.add(to);
                for (const k of Object.keys(fm[from][to] || {})) allKinds.add(k);
            }
        }
        const secIds = [...allSecs].sort();
        const kindIds = [...allKinds].sort();
        if (this._flowView === 'diagram') {
            this._renderFlowDiagram(target, fm, secIds, kindIds);
            return;
        }
        const blocks = kindIds.map((kind) => {
            const headerCells = secIds.map((s) =>
                `<th class="ea-flow-matrix__col">${esc(this._sectorLabel(s))}</th>`).join('');
            const rows = secIds.map((from) => {
                let rowTotal = 0;
                const cells = secIds.map((to) => {
                    const v = (fm[from]?.[to]?.[kind]) ?? 0;
                    rowTotal += Number(v) || 0;
                    if ((Number(v) || 0) === 0) {
                        return `<td class="ea-flow-matrix__cell">·</td>`;
                    }
                    return `<td class="ea-flow-matrix__cell ea-flow-matrix__cell--nonzero"
                              data-from="${esc(from)}" data-to="${esc(to)}"
                              data-kind="${esc(kind)}" title="Show transactions">
                              ${fmt(v)}
                           </td>`;
                }).join('');
                return `
                    <tr>
                        <th class="ea-flow-matrix__row-head">${esc(this._sectorLabel(from))}</th>
                        ${cells}
                        <td class="ea-flow-matrix__cell ea-flow-matrix__cell--total">${fmt(rowTotal)}</td>
                    </tr>`;
            }).join('');
            const colTotals = secIds.map((to) => {
                let s = 0;
                for (const from of secIds) s += Number(fm[from]?.[to]?.[kind] ?? 0) || 0;
                return s;
            });
            const grand = colTotals.reduce((a, b) => a + b, 0);
            return `
                <div class="ea-flow-matrix__block">
                    <h4 class="ea-flow-matrix__title">${esc(kindLabel(this._assetKinds, kind))}</h4>
                    <table class="ea-table ea-flow-matrix__table">
                        <thead><tr>
                            <th class="ea-flow-matrix__corner">From → To</th>
                            ${headerCells}
                            <th class="ea-flow-matrix__col">Σ</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr>
                            <th class="ea-flow-matrix__row-head">Σ</th>
                            ${colTotals.map((v) =>
                                `<td class="ea-flow-matrix__cell ea-flow-matrix__cell--total">${fmt(v)}</td>`).join('')}
                            <td class="ea-flow-matrix__cell ea-flow-matrix__cell--total ea-flow-matrix__cell--grand">${fmt(grand)}</td>
                        </tr></tfoot>
                    </table>
                </div>`;
        }).join('');
        target.innerHTML = blocks;
        target.querySelectorAll('.ea-flow-matrix__cell--nonzero[data-from]')
            .forEach((td) => {
                td.addEventListener('click',
                    () => this._onInspectFlowCell(td.dataset.from, td.dataset.to, td.dataset.kind));
            });
    }

    // ----------------------------------------- Godley TFM (declarative)
    //
    // Distinct from the transaction Flow matrix above: this is the
    // canonical SFC Transactions Flow Matrix derived from the declarative
    // `_flow_rows` (owned + P6-propagated mirrors), flows (rows) ×
    // sub_sectors (columns). The load-bearing invariant is per-FLOW: each
    // flow's row sums to zero when its firer declares a counterparty (the
    // mirror supplies the offsetting leg). A non-zero row Σ is flagged RED
    // — it means a flow books into a sector with no counterpart elsewhere
    // (a missing/ambiguous counterparty). The footer shows per-sub_sector
    // column sums, which are each sector's net financial balance and are
    // informational only (NOT a conservation check).

    _renderTfm() {
        const target = this.hostEl?.querySelector('#ea-tfm-matrix');
        if (!target) return;
        const m = this._tfm || {};
        const flows = Array.isArray(m.flows) ? m.flows : [];
        const subs  = Array.isArray(m.sub_sectors) ? m.sub_sectors : [];
        if (flows.length === 0 || subs.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + 'No declarative flow rows yet — agents fire imperatively '
                + 'today. As <code>_flow_rows</code> are declared (with '
                + 'counterparties), each flow appears here and its row must '
                + 'sum to zero.</div>';
            return;
        }
        const cells = (m.cells && typeof m.cells === 'object') ? m.cells : {};
        const rowSums = (m.row_sums && typeof m.row_sums === 'object') ? m.row_sums : {};
        const colSums = (m.column_sums && typeof m.column_sums === 'object') ? m.column_sums : {};

        const headerCells = subs.map((s) =>
            `<th class="ea-flow-matrix__col">${esc(this._sectorLabel(s))}</th>`).join('');
        const body = flows.map((fid) => {
            const row = cells[fid] || {};
            const dataCells = subs.map((s) => {
                const v = Number(row[s] ?? 0);
                if (v === 0) return `<td class="ea-flow-matrix__cell">·</td>`;
                return `<td class="ea-flow-matrix__cell ea-flow-matrix__cell--nonzero">${fmt(v)}</td>`;
            }).join('');
            const sum = Number(rowSums[fid] ?? 0);
            const leak = Math.abs(sum) > 1e-6;
            const sumCls = leak
                ? 'ea-flow-matrix__cell ea-flow-matrix__cell--total ea-flow-matrix__cell--leak'
                : 'ea-flow-matrix__cell ea-flow-matrix__cell--total';
            const sumTitle = leak
                ? 'Conservation violation — this flow does not net to zero '
                  + 'across sectors (missing or ambiguous counterparty).'
                : 'Conserved — debits and credits net to zero across sectors.';
            return `
                <tr>
                    <th class="ea-flow-matrix__row-head">${esc(fid)}</th>
                    ${dataCells}
                    <td class="${sumCls}" title="${esc(sumTitle)}">${fmt(sum)}</td>
                </tr>`;
        }).join('');
        const footCells = subs.map((s) =>
            `<td class="ea-flow-matrix__cell ea-flow-matrix__cell--total">${fmt(Number(colSums[s] ?? 0))}</td>`).join('');
        target.innerHTML = `
            <div class="ea-flow-matrix__block">
                <table class="ea-table ea-flow-matrix__table">
                    <thead><tr>
                        <th class="ea-flow-matrix__corner">Flow ↓ / Sub-sector →</th>
                        ${headerCells}
                        <th class="ea-flow-matrix__col" title="Per-flow row sum — must be zero">Σ row</th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                    <tfoot><tr>
                        <th class="ea-flow-matrix__row-head" title="Per-sub_sector net financial balance (informational)">Σ col</th>
                        ${footCells}
                        <td class="ea-flow-matrix__cell ea-flow-matrix__cell--total ea-flow-matrix__cell--grand"></td>
                    </tr></tfoot>
                </table>
            </div>`;
    }

    async _renderFlowDiagram(target, fm, secIds, kindIds) {
        // Three-column sankey: sector(out) → asset kind → sector(in).
        // The matrix view already covers per-kind from/to detail; the
        // diagram's job is the bird's-eye picture of who issues what
        // and who receives what, with kind as the middle layer.
        const { buildSankey } = await import('../ui/sankey.js');
        const { ensurePlotly } = await import('../../charting/plotly_wrapper.js');
        target.innerHTML = `
            <div class="ea-flow-matrix__block">
                <h4 class="ea-flow-matrix__title">Sector → kind → sector</h4>
                <div class="ea-sankey-host" data-role="flow-sankey"></div>
            </div>`;
        const host = target.querySelector('[data-role="flow-sankey"]');
        if (!host) return;
        const colorFor = (i) => SECTOR_PALETTE[i % SECTOR_PALETTE.length];
        const KIND_PALETTE = [
            '#6a8caf', '#a8804a', '#7aa874', '#a86a8c',
            '#c2a25c', '#5c9aa8', '#8a6ec2', '#c26e6e',
        ];
        const kindColor = (i) => KIND_PALETTE[i % KIND_PALETTE.length];
        const nodes = [
            ...secIds.map((s, i) => ({
                id: `${s}.out`,
                label: `${this._sectorLabel(s)} (out)`,
                color: colorFor(i),
            })),
            ...kindIds.map((k, i) => ({
                id: `kind.${k}`,
                label: kindLabel(this._assetKinds, k),
                color: kindColor(i),
            })),
            ...secIds.map((s, i) => ({
                id: `${s}.in`,
                label: `${this._sectorLabel(s)} (in)`,
                color: colorFor(i),
            })),
        ];
        const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
        // Aggregate at the kind layer — left links sum outgoing flows of
        // each kind per sector, right links sum incoming flows per sector.
        const outAgg = new Map();  // `${from}|${kind}` -> value
        const inAgg  = new Map();  // `${kind}|${to}`   -> value
        for (const from of secIds) {
            for (const to of secIds) {
                for (const kind of kindIds) {
                    const v = Number(fm[from]?.[to]?.[kind] ?? 0);
                    if (v <= 0) continue;
                    const oKey = `${from}|${kind}`;
                    const iKey = `${kind}|${to}`;
                    outAgg.set(oKey, (outAgg.get(oKey) || 0) + v);
                    inAgg.set(iKey,  (inAgg.get(iKey)  || 0) + v);
                }
            }
        }
        const links = [];
        for (const [key, v] of outAgg) {
            const [from, kind] = key.split('|');
            links.push({
                source: indexOf.get(`${from}.out`),
                target: indexOf.get(`kind.${kind}`),
                value:  v,
            });
        }
        for (const [key, v] of inAgg) {
            const [kind, to] = key.split('|');
            links.push({
                source: indexOf.get(`kind.${kind}`),
                target: indexOf.get(`${to}.in`),
                value:  v,
            });
        }
        if (!links.length) {
            host.innerHTML = '<div class="ea-plot__placeholder">No flows to draw.</div>';
            this._lastFlowDiagram = null;
            return;
        }
        const built = buildSankey({ nodes, links, height: 360 });
        const Plotly = await ensurePlotly();
        await Plotly.react(host, [built.trace], built.layout,
            { responsive: true, displayModeBar: false });
        // Cache trace + layout + atomic (from, kind, to, value) rows so
        // the pop-out can show the same diagram alongside a data tab.
        const tableRows = [];
        for (const from of secIds) {
            for (const to of secIds) {
                for (const kind of kindIds) {
                    const v = Number(fm[from]?.[to]?.[kind] ?? 0);
                    if (v <= 0) continue;
                    tableRows.push([
                        this._sectorLabel(from),
                        kindLabel(this._assetKinds, kind),
                        this._sectorLabel(to),
                        v,
                    ]);
                }
            }
        }
        this._lastFlowDiagram = {
            trace:        built.trace,
            layout:       built.layout,
            tableHeaders: ['From', 'Asset kind', 'To', 'Value'],
            tableRows,
        };
    }

    async _openFlowPopout() {
        const snap = this._lastFlowDiagram;
        if (!snap) return;
        const { openRawTracesWindow } = await import(
            '../../ui/components/plot_popout_window.js');
        const tickLabel = this._flowAtTick && getViewingTick() != null
            ? ` · tick ${getViewingTick()}` : ' · cumulative';
        await openRawTracesWindow({
            id:    'sfc-flow-sankey',
            title: `Transaction flow${tickLabel}`,
            traces:       [snap.trace],
            layout:       { ...snap.layout, height: undefined },
            tableHeaders: snap.tableHeaders,
            tableRows:    snap.tableRows,
            services:     { logger: this.logger },
        });
    }

    async _onInspectFlowCell(fromSec, toSec, kind) {
        const at = this._flowAtTick && getViewingTick() != null ? getViewingTick() : null;
        let txns = [];
        try {
            txns = at != null
                ? await window.pywebview?.api?.world_transactions_between?.(fromSec, toSec, kind, at) ?? []
                : await window.pywebview?.api?.world_transactions_between?.(fromSec, toSec, kind) ?? [];
        } catch (err) {
            this.logger.warn?.('world_transactions_between failed', { err });
        }
        const scopeLabel = at != null ? `at tick ${at}` : 'cumulative';
        const { openTransactionListModal } = await import('../ui/transaction_list_modal.js');
        await openTransactionListModal({
            title:    `${this._sectorLabel(fromSec)} → ${this._sectorLabel(toSec)}`,
            subtitle: `${kindLabel(this._assetKinds, kind)} · ${scopeLabel}`,
            transactions: Array.isArray(txns) ? txns : [],
        });
    }

    _sectorLabel(id) {
        const s = (this._sectors || []).find((x) => x.id === id);
        return s ? s.label : id;
    }
}


const SIDE_COLORS = {
    Assets:      '#4ec9b0',
    Liabilities: '#d9886a',
    Equity:      '#9cdcfe',
};

// Distinct hue per sector in the Sankey diagram. Mirrors the wrapper's
// internal palette so the (out) and (in) halves of the same sector
// read as one entity when a self-loop exists.
const SECTOR_PALETTE = [
    '#4ec9b0', '#9cdcfe', '#dcdcaa', '#c586c0',
    '#ce9178', '#b5cea8', '#569cd6', '#d16969',
    '#608b4e', '#d9886a', '#9b59b6', '#e6a23c',
];

function kindLabel(kinds, id) {
    const k = (kinds || []).find((x) => x.id === id);
    if (!k) return id;
    const label = k.label || k.name || k.id || id;
    return `${label} (${id})`;
}
