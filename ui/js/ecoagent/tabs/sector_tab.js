/**
 * sector_tab.js — sector-centric SFC view, hosting everything that used
 * to live on the SFC Overview tab as well as the per-sector balance
 * sheet.
 *
 * Layout:
 *   - Time scrubber (drives the global viewingTick state).
 *   - Balance sheet for this sector (grouped Assets/Liabilities/Equity).
 *   - When an asset kind is selected (via the sidebar Asset Kinds list):
 *       * Cross-sector consistency row for THIS kind (this sector
 *         highlighted, sister sectors shown for comparison).
 *       * Time series for THIS kind.
 *       * Transactions matrix row + column for this sector, scoped to
 *         this kind. Clicking a non-zero cell opens the transaction
 *         drill-down modal.
 *   - "Pick an asset kind in the sidebar" placeholder when nothing is
 *     selected — keeps the page calm.
 */

import { renderSparkline, renderLineChart } from '../ui/charts.js';
import { openChartModal } from '../ui/chart_modal.js';
import { openForm, openConfirm } from '../ui/modal.js';
import { openDistributionModal, distSummary } from '../ui/distribution_modal.js';
import {
    getViewingTick, onViewingTickChange, setViewingTick,
} from '../sfc_view_state.js';
import { esc, fmt, mountEditableTitle } from './_util.js';

const ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity'];
const SIDE_COLORS = {
    Assets:      '#4ec9b0',
    Liabilities: '#d9886a',
    Equity:      '#9cdcfe',
};

// Sub-tabs of the sector editor — same nb-structured-editor tab chrome
// the Agents page uses, for layout consistency across the tab kinds.
const SECTOR_SUBTABS = [
    { id: 'balance',       label: 'Balance sheet',     icon: 'account_balance' },
    { id: 'accounts',      label: 'Chart of accounts', icon: 'table_rows' },
    { id: 'slice',         label: 'Slice by kind',     icon: 'category' },
    { id: 'relationships', label: 'Relationships',     icon: 'hub' },
];

/** Factory registered with WorkspaceTabs for kind `sector`. */
export function makeSectorTab(hostEl, sectorId, ctx) {
    return new SectorTab(hostEl, sectorId, ctx);
}

class SectorTab {
    constructor(hostEl, sectorId, { logger, workspaceTabs, tabId } = {}) {
        this.hostEl = hostEl;
        this.sectorId = sectorId;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        this._sector = null;
        this._sectors = [];
        this._assetKinds = [];
        this._archetypes = [];          // every archetype (for the Accounts editor)
        this._accounts = [];
        this._accountsBySector = {};
        this._balanceSheet = {};
        this._histories = {};
        this._historyAggregates = [];
        this._historyLastTick = 0;
        this._flowMatrix = {};
        this._expandedGroups = new Set();
        this._unsubTick = null;
        this._root = null;
        // Refresh-race guard. Every refresh() bumps this token; when an
        // in-flight refresh resolves with a stale token (because the
        // user has scrubbed past it or a streaming tick fired since),
        // we drop its result rather than blow away newer state. Without
        // this, fast scrubbing left the page showing the data of
        // whichever fetch happened to finish last (often an earlier
        // tick), so the panel "didn't update" relative to the slider.
        this._refreshSeq = 0;
        // Coalesce scrubber drag events. `input` fires on every pixel
        // of thumb movement; without coalescing we kicked off a dozen
        // overlapping refreshes per drag.
        this._scrubDebounce = null;
        // Currencies — pulled at refresh + rendered in the header's
        // currency selector. Lets the user re-tag a sector's monetary
        // zone inline without opening the sidebar edit modal.
        this._currencies = [];
        this._countries = [];
        // Per-tab selected asset kind — drives the slice card below the
        // balance sheet. Local state, not global, because two open
        // sector tabs may be focused on different kinds at once.
        this._selectedKindId = null;
        this._activeSubTab = 'balance';
    }

    async mount() {
        this.hostEl.innerHTML = `
            <div class="ea-sector-tab">
                <header class="ea-detail-header">
                    <h2 id="ea-sector-title">Sector</h2>
                    <label class="ea-detail-header__field"
                           title="Country this sector belongs to. The country's currency is what this sector operates in.">
                        <span>Country</span>
                        <select id="ea-sector-country" class="ea-detail-header__select"></select>
                    </label>
                    <span class="ea-detail-header__currency" id="ea-sector-currency-display"
                          title="Currency derived from the sector's country."></span>
                    <span class="ea-detail-header__spacer"></span>
                    <button class="ea-btn ea-btn--small" id="ea-sector-popout"
                            title="Pop this sector tab out into a floating window">
                        <span class="material-symbols-outlined">open_in_new</span>
                        Pop out
                    </button>
                    <button type="button" class="ea-btn ea-btn--small ea-btn--danger"
                            data-action="delete"
                            title="Delete this sector">
                        <span class="material-symbols-outlined">delete</span>
                        Delete
                    </button>
                </header>

                <div class="nb-structured-editor__tabs" id="ea-sector-subtabs"></div>
                <div class="nb-structured-editor__content" id="ea-sector-subtab-content"></div>
            </div>
        `;
        this._root = this.hostEl.querySelector('.ea-sector-tab');
        this._root.querySelector('#ea-sector-popout')
            ?.addEventListener('click', () => this._openPopout());
        this._root.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDeleteSector());
        // Build the sub-tab bar.
        const bar = this._root.querySelector('#ea-sector-subtabs');
        for (const t of SECTOR_SUBTABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nb-structured-editor__tab'
                + (t.id === this._activeSubTab ? ' active' : '');
            btn.dataset.subtab = t.id;
            btn.innerHTML = `<span class="material-symbols-outlined">${t.icon}</span> ${t.label}`;
            btn.addEventListener('click', () => this._switchSubTab(t.id));
            bar.appendChild(btn);
        }
        this._unsubTick = onViewingTickChange(() => this.refresh());
        await this.refresh();
    }

    _switchSubTab(id) {
        if (id === this._activeSubTab) return;
        this._activeSubTab = id;
        this._root.querySelectorAll('#ea-sector-subtabs .nb-structured-editor__tab')
            .forEach((b) => b.classList.toggle('active', b.dataset.subtab === id));
        this._renderActiveSubTab();
    }

    show() { /* WorkspaceTabs refreshes dirty tabs before show — nothing to do */ }
    hide() {}

    async refresh() {
        const at = getViewingTick();
        const seq = ++this._refreshSeq;
        try {
            const [
                sectors, kinds, archetypes, accsBySector, bs,
                accHist, summary, aggs, flowMatrix, currencies, countries,
            ] = await Promise.all([
                window.pywebview?.api?.sectors_list?.()                      ?? [],
                window.pywebview?.api?.assets_list?.()                  ?? [],
                window.pywebview?.api?.agents_list?.()                   ?? [],
                at != null
                    ? window.pywebview?.api?.sfc_accounts_by_sector?.(at)    ?? {}
                    : window.pywebview?.api?.sfc_accounts_by_sector?.()      ?? {},
                at != null
                    ? window.pywebview?.api?.sfc_balance_sheet?.(at)         ?? {}
                    : window.pywebview?.api?.sfc_balance_sheet?.()           ?? {},
                window.pywebview?.api?.world_all_accounts_history?.()        ?? {},
                window.pywebview?.api?.world_history_summary?.()             ?? null,
                window.pywebview?.api?.world_history_aggregates?.()          ?? [],
                window.pywebview?.api?.world_transaction_flow_matrix?.()     ?? {},
                window.pywebview?.api?.currencies_list?.()                   ?? [],
                window.pywebview?.api?.countries_list?.()                    ?? [],
            ]);
            // Drop the result if a newer refresh started while we were
            // awaiting — without this guard, a slow earlier fetch can
            // overwrite the fresh state with stale snapshot data and
            // the page reads "frozen" relative to the slider.
            if (seq !== this._refreshSeq) return;
            this._sectors = Array.isArray(sectors) ? sectors : [];
            this._sector = this._sectors.find((s) => s.id === this.sectorId) || null;
            this._assetKinds = Array.isArray(kinds) ? kinds : [];
            this._currencies = Array.isArray(currencies) ? currencies : [];
            this._countries = Array.isArray(countries) ? countries : [];
            this._archetypes = Array.isArray(archetypes) ? archetypes : [];
            this._accountsBySector = (accsBySector && typeof accsBySector === 'object') ? accsBySector : {};
            this._accounts = this._accountsBySector[this.sectorId] || [];
            this._balanceSheet = (bs && typeof bs === 'object') ? bs : {};
            this._histories = (accHist && typeof accHist === 'object') ? accHist : {};
            this._historyAggregates = Array.isArray(aggs) ? aggs : [];
            this._flowMatrix = (flowMatrix && typeof flowMatrix === 'object') ? flowMatrix : {};
            if (summary && typeof summary === 'object') {
                this._historyLastTick = Number(summary.last_tick) || 0;
            }
        } catch (err) {
            this.logger.warn?.('sector tab refresh failed', { err });
        }
        this._render();
    }

    // -------------------------------------------------- viewing-tick scrubber

    _renderScrubber() {
        const wrap   = this._root?.querySelector('#ea-time-scrubber');
        const slider = this._root?.querySelector('#ea-scrubber-slider');
        const valEl  = this._root?.querySelector('#ea-scrubber-value');
        if (!wrap || !slider || !valEl) return;
        if (this._historyLastTick <= 0) { wrap.hidden = true; return; }
        wrap.hidden = false;
        slider.max = String(this._historyLastTick);
        const viewing = getViewingTick();
        const tick = viewing == null ? this._historyLastTick : viewing;
        slider.value = String(tick);
        valEl.textContent = String(tick);
    }

    // -------------------------------------------------------------- render

    _render() {
        // Editable header title — display-only by default, enters edit
        // mode on double-click or pencil-button click. Commit calls
        // `sector_update` so the on-disk file (project.json) reflects
        // the rename immediately and the file tree updates.
        const titleHost = this._root.querySelector('#ea-sector-title');
        if (titleHost) {
            const current = this._sector
                ? (this._sector.label || this._sector.id)
                : this.sectorId;
            if (!this._titleCtl) {
                titleHost.innerHTML = '';
                this._titleCtl = mountEditableTitle(titleHost, {
                    value: current,
                    placeholder: this.sectorId,
                    tag: 'span',
                    onCommit: async (next) => {
                        if (!this._sector || !next) return;
                        const res = await window.pywebview?.api?.sector_update?.(
                            this.sectorId, next,
                            this._sector.kind || 'real',
                            null, null,
                            this._sector.country || null,
                        );
                        if (res?.ok === false) this.logger.warn?.(res.error);
                        await this.refresh();
                        this.workspaceTabs?.notifyChanged?.('sectors');
                    },
                });
            } else {
                this._titleCtl.setValue(current);
            }
        }
        this._renderCurrencySelector();
        this._renderActiveSubTab();
    }

    _renderCurrencySelector() {
        // Country dropdown. The sector belongs to a country; the
        // country owns the currency. So the editable selector at
        // sector-tab level is COUNTRY, not currency — currency
        // displays read-only beside it (derived).
        const sel = this._root.querySelector('#ea-sector-country');
        if (sel) {
            const current = this._sector?.country || '';
            sel.innerHTML = [
                `<option value=""${current ? '' : ' selected'}>(unassigned)</option>`,
                ...(this._countries || []).map((c) =>
                    `<option value="${c.id}"${c.id === current ? ' selected' : ''}>${c.label || c.id}</option>`
                ),
                `<option value="__manage__">Manage currencies…</option>`,
            ].join('');
            sel.onchange = () => this._onCountryChange(sel.value);
        }
        // Derived currency display beside the country selector.
        const disp = this._root.querySelector('#ea-sector-currency-display');
        if (disp) {
            const country = (this._countries || []).find(
                (c) => c.id === this._sector?.country,
            );
            if (!country) {
                disp.textContent = '';
            } else {
                const ccy = (this._currencies || []).find(
                    (x) => x.id === country.currency,
                );
                const sym = ccy?.symbol ? ' ' + ccy.symbol : '';
                disp.textContent = country.currency + sym;
            }
        }
    }

    async _onCountryChange(value) {
        if (!this._sector) return;
        if (value === '__manage__') {
            const { openCurrencyManager } = await import('../ui/currency_manager.js');
            await openCurrencyManager();
            await this.refresh();
            return;
        }
        const res = await window.pywebview?.api?.sector_update?.(
            this.sectorId,
            this._sector.label || this.sectorId,
            this._sector.kind || 'real',
            null,                  // currency (legacy) — leave alone
            null,                  // new_id
            String(value || ''),   // country
        );
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this.refresh();
        this.workspaceTabs?.notifyChanged?.('sectors');
    }

    async _openAddCurrencyInline() {
        const { openForm } = await import('../ui/modal.js');
        const data = await openForm({
            title: 'Add currency',
            fields: [
                { name: 'id', label: 'Id', type: 'text', required: true,
                  placeholder: 'e.g. USD' },
                { name: 'label', label: 'Label', type: 'text',
                  placeholder: 'US Dollar' },
                { name: 'symbol', label: 'Symbol', type: 'text', placeholder: '$' },
            ],
            submitLabel: 'Add',
        });
        if (!data) return null;
        const cid = String(data.id || '').trim();
        if (!cid) return null;
        const res = await window.pywebview?.api?.currency_add?.(
            cid, String(data.label || '').trim() || cid,
            String(data.symbol || '').trim(),
            /* is_domestic */ false, /* issuer_sector */ null,
        );
        if (res?.ok === false) {
            this.logger.warn?.('add currency failed', { err: res.error });
            return null;
        }
        return cid;
    }

    /** Inject the active sub-tab's section shell (once) and (re)render its
     *  content. The viewing-tick scrubber lives inside the Balance sheet
     *  and Slice sub-tabs — the only views that read the ledger at a tick
     *  (Chart of accounts is the static config and ignores it). */
    _renderActiveSubTab() {
        const content = this._root.querySelector('#ea-sector-subtab-content');
        if (!content) return;
        const sub = this._activeSubTab;
        if (content.dataset.subtab !== sub) {
            content.dataset.subtab = sub;
            content.innerHTML = this._subTabShell(sub);
            if (sub === 'accounts') {
                content.querySelector('#ea-add-archetype')
                    ?.addEventListener('click', () => this._onAddArchetypeHere());
            } else if (sub === 'slice') {
                content.querySelector('#ea-add-kind')
                    ?.addEventListener('click', () => this._onAddAsset());
                this._wireScrubber();
            } else if (sub === 'balance') {
                this._wireScrubber();
            } else if (sub === 'relationships') {
                this._mountRelationshipsSubTab(content);
            }
        }
        if (sub === 'balance')  { this._renderScrubber(); this._renderBalanceSheet(); }
        if (sub === 'accounts') this._renderAccountsEditor();
        if (sub === 'slice')  { this._renderScrubber(); this._renderKindList(); this._renderKindSlice(); }
    }

    /** Mount the shared Relationships helper, with this sector's
     *  entry_kind + id. The helper reads the unified registry, so it
     *  surfaces out-references (kind / country) and inverse references
     *  (archetypes whose default_sector points here, attributes that
     *  cite this sector via ref:sector, …). */
    _mountRelationshipsSubTab(content) {
        const host = document.createElement('div');
        host.setAttribute('data-role', 'relationships-host');
        content.appendChild(host);
        import('./_relationships.js').then(({ mountRelationshipsTab }) => {
            mountRelationshipsTab(host, {
                entity_kind: 'sector',
                id: this.sectorId,
                workspaceTabs: this.workspaceTabs,
            });
        }).catch((err) => {
            this.log?.warn?.('relationships tab load failed', { err });
            host.innerHTML = '<div class="ea-bp-placeholder__hint">'
                + 'Relationships view failed to load.</div>';
        });
    }

    _scrubberHtml() {
        return `
            <div class="ea-time-scrubber" id="ea-time-scrubber" hidden>
                <span class="ea-time-scrubber__label">Viewing tick</span>
                <input type="range" id="ea-scrubber-slider" min="0" max="0" value="0">
                <span class="ea-time-scrubber__value" id="ea-scrubber-value">0</span>
                <button class="ea-btn ea-time-scrubber__latest" id="ea-scrubber-latest"
                        title="Snap to the latest tick">Latest</button>
            </div>`;
    }

    _wireScrubber() {
        const slider = this._root.querySelector('#ea-scrubber-slider');
        const valEl  = this._root?.querySelector('#ea-scrubber-value');
        // `input` fires every pixel of drag — update the visible value
        // immediately so the readout tracks the thumb, but defer the
        // (heavy) viewing-tick + refresh dispatch until the drag
        // quiets for ~60 ms. `change` fires on thumb release and
        // commits immediately, so a quick click still feels instant.
        const commit = (raw) => {
            const v = Math.max(0, Math.min(this._historyLastTick, Number(raw)));
            setViewingTick(v);
        };
        slider?.addEventListener('input', () => {
            if (valEl) valEl.textContent = String(slider.value);
            clearTimeout(this._scrubDebounce);
            this._scrubDebounce = setTimeout(() => commit(slider.value), 60);
        });
        slider?.addEventListener('change', () => {
            clearTimeout(this._scrubDebounce);
            commit(slider.value);
        });
        this._root.querySelector('#ea-scrubber-latest')
            ?.addEventListener('click', () => {
                clearTimeout(this._scrubDebounce);
                setViewingTick(null);
                this.refresh();
            });
    }

    _subTabShell(sub) {
        if (sub === 'balance') return `
            ${this._scrubberHtml()}
            <section class="ea-card">
                <h3 class="ea-card__title">Balance sheet</h3>
                <p class="ea-card__hint">
                    Pre-run: sum of initial values from the chart of
                    accounts. During a run: live ledger at the viewing
                    tick. Click an account row to chart its history.
                </p>
                <div id="ea-balance-sheets">
                    <div class="ea-plot__placeholder">Loading…</div>
                </div>
            </section>`;
        if (sub === 'accounts') return `
            <section class="ea-card">
                <header class="ea-card__head-row">
                    <h3 class="ea-card__title">Chart of accounts</h3>
                    <button class="ea-btn ea-btn--small" id="ea-add-archetype"
                            title="Add an archetype to this sector — pick an existing one or type a new name">
                        + archetype
                    </button>
                </header>
                <p class="ea-card__hint">
                    Each archetype assigned to this sector and the
                    account templates its instances start with.
                    Initial values seed the ledger at <code>t=0</code>.
                    Behavior (loops, brain) is edited on the Agents page.
                </p>
                <div id="ea-accounts-editor">
                    <div class="ea-plot__placeholder">Loading…</div>
                </div>
            </section>`;
        if (sub === 'slice') return `
            ${this._scrubberHtml()}
            <section class="ea-card">
                <h3 class="ea-card__title">Slice by asset kind</h3>
                <div class="ea-kind-split">
                    <aside class="ea-kind-split__list">
                        <ul id="ea-kind-list" class="ea-kind-list"></ul>
                        <button type="button" class="ea-kind-list__add"
                                id="ea-add-kind" title="Define a new asset kind">
                            <span class="material-symbols-outlined">add</span>
                            asset kind
                        </button>
                    </aside>
                    <div class="ea-kind-split__content" id="ea-kind-slice"
                         data-kind-slice></div>
                </div>
            </section>`;
        // `relationships` mounts its own content via
        // `_mountRelationshipsSubTab`; the shell stays empty so the
        // helper isn't competing with leftover HTML from another
        // sub-tab. Unknown sub-tabs also fall through to empty.
        return '';
    }

    // ------------------------------------------- chart of accounts editor

    /** Archetypes whose default sector is this one — they're what an
     *  agent of this sector instantiates. */
    _archetypesHere() {
        return (this._archetypes || [])
            .filter((a) => a.default_sector === this.sectorId);
    }

    _renderAccountsEditor() {
        const host = this._root.querySelector('#ea-accounts-editor');
        if (!host) return;
        const archs = this._archetypesHere();
        if (archs.length === 0) {
            host.innerHTML = '<div class="ea-plot__placeholder">'
                + 'No archetypes are assigned to this sector yet — '
                + 'click + archetype above to create one here.</div>';
            return;
        }
        host.innerHTML = archs.map((a) => `
            <div class="ea-acc-arch" data-archetype="${esc(a.archetype)}">
                <div class="ea-card__head-row">
                    <h4 class="ea-acc-arch__title">${esc(a.label || a.archetype)}</h4>
                    <button type="button" class="tree-node__action-btn" data-action="add-account"
                            title="Add account">
                        <span class="material-symbols-outlined">add</span>
                    </button>
                    <button type="button" class="tree-node__action-btn" data-action="rename"
                            title="Rename archetype">
                        <span class="material-symbols-outlined">edit</span>
                    </button>
                    <button type="button" class="tree-node__action-btn" data-action="unlink"
                            title="Remove from this sector">
                        <span class="material-symbols-outlined">link_off</span>
                    </button>
                </div>
                <div data-role="acc-table"></div>
            </div>
        `).join('');
        host.querySelectorAll('.ea-acc-arch').forEach((block) => {
            const key = block.dataset.archetype;
            block.querySelector('[data-action="add-account"]')
                ?.addEventListener('click', () => this._onAddAccount(key));
            block.querySelector('[data-action="rename"]')
                ?.addEventListener('click', () => this._onRenameArchetype(key));
            block.querySelector('[data-action="unlink"]')
                ?.addEventListener('click', () => this._onUnlinkArchetype(key));
            this._renderArchAccountsTable(key, block.querySelector('[data-role="acc-table"]'));
        });
    }


    async _onRenameArchetype(archetypeKey) {
        const a = this._archetypes.find((x) => x.archetype === archetypeKey);
        if (!a) return;
        const data = await openForm({
            title: `Rename "${archetypeKey}"`,
            fields: [
                { name: 'label', label: 'Label', type: 'text', required: true,
                  default: a.label || archetypeKey },
            ],
            submitLabel: 'Save',
        });
        if (!data) return;
        const res = await window.pywebview?.api?.agent_update?.({
            key: archetypeKey, label: String(data.label).trim() || a.label,
        });
        if (res && res.ok === false) this.logger.warn?.(res.error);
        await this.refresh();
    }

    async _onDeleteSector() {
        const label = this._sector?.label || this.sectorId;
        const ok = await openConfirm({
            title: 'Delete sector',
            message: `Delete sector <strong>${label}</strong>? `
                + 'Archetypes linked here will be unlinked.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await window.pywebview?.api?.sector_remove?.(this.sectorId);
        } catch (err) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Delete sector failed', err?.message || String(err));
            return;
        }
        this.workspaceTabs?.closeTab?.(this.tabId || `sector:${this.sectorId}`);
    }

    async _onUnlinkArchetype(archetypeKey) {
        // SFC "delete" is hard-link semantics: it only drops the sector
        // link. The archetype survives if it's still linked on the
        // Agents page; if this was its last link it's destroyed.
        const ok = await openConfirm({
            title: 'Remove from sector',
            message: `Remove "${archetypeKey}" from this sector? It keeps `
                + 'existing on the Agents page; if it isn’t linked there '
                + 'either, it will be deleted entirely.',
            confirmLabel: 'Remove', danger: true,
        });
        if (!ok) return;
        const res = await window.pywebview?.api?.agent_unlink?.({
            key: archetypeKey, ref: 'sfc',
        });
        if (res && res.ok === false) { this.logger.warn?.(res.error); return; }
        await this.refresh();
    }

    async _onAddArchetypeHere() {
        // One pick-or-create combobox unifies "assign an existing
        // unassigned archetype" and "create a new one": pick a
        // sector-less archetype from the list, or type a new name to
        // create it here. Either way the archetype ends up in this
        // sector.
        const free = (this._archetypes || []).filter((a) => !a.default_sector);
        const data = await openForm({
            title: `Add archetype to ${this._sector?.label || this.sectorId}`,
            fields: [
                { name: 'archetype', label: 'Archetype', type: 'select',
                  options: free.map((a) => a.archetype),
                  required: true,
                  placeholder: 'pick an unassigned archetype, or type a new name…',
                  create: {
                      hint: 'archetype',
                      onCreate: async (typed) => {
                          const label = String(typed).trim();
                          const key = label.toLowerCase()
                              .replace(/[^a-z0-9]+/g, '_')
                              .replace(/^_+|_+$/g, '')
                              .slice(0, 64);
                          if (!key) return null;
                          const res = await window.pywebview?.api?.agent_add?.({
                              key, label, default_sector: this.sectorId,
                              population: 1,
                          });
                          if (res && res.ok === false) {
                              this.logger.warn?.(res.error);
                              return null;
                          }
                          return key;
                      },
                  } },
            ],
            submitLabel: 'Add',
        });
        if (!data || !data.archetype) return;
        // A picked existing archetype still needs assigning to this
        // sector; a just-created one was already placed here by onCreate
        // (so it won't be in the stale `_archetypes` list).
        const existing = this._archetypes.find((a) => a.archetype === data.archetype);
        if (existing) {
            const res = await window.pywebview?.api?.agent_update?.({
                key: data.archetype, default_sector: this.sectorId,
            });
            if (res && res.ok === false) { this.logger.warn?.(res.error); return; }
        }
        await this.refresh();
    }


    _renderArchAccountsTable(archetypeKey, target) {
        if (!target) return;
        const arch = this._archetypes.find((a) => a.archetype === archetypeKey);
        const accs = (arch && arch.accounts) || [];
        if (accs.length === 0) {
            target.innerHTML = '<div class="ea-table__empty">'
                + 'No account templates — click + account to add one.</div>';
            return;
        }
        const kindOptions = (currentId) => this._assetKinds.map((k) =>
            `<option value="${esc(k.id)}"${k.id === currentId ? ' selected' : ''}>${esc(k.id)}</option>`
        ).join('');
        const typeOptions = (currentT) => ACCOUNT_TYPES.map((t) =>
            `<option value="${esc(t)}"${t === currentT ? ' selected' : ''}>${esc(t)}</option>`
        ).join('');
        target.innerHTML = `
            <table class="ea-table ea-acc-table">
                <thead><tr>
                    <th>Label</th>
                    <th>Asset kind</th>
                    <th>Side</th>
                    <th class="ea-table__cell">Initial</th>
                    <th>Distribution</th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${accs.map((acc) => `
                        <tr data-account-label="${esc(acc.label)}">
                            <td><input type="text" data-field="label"
                                       value="${esc(acc.label)}"></td>
                            <td><select data-field="asset_kind">${kindOptions(acc.asset_kind)}</select></td>
                            <td><select data-field="type">${typeOptions(acc.type)}</select></td>
                            <td><input type="number" step="0.01" data-field="initial_value"
                                       value="${acc.initial_value}" class="ea-table__cell"></td>
                            <td>
                                <button class="ea-btn ea-dist-btn" data-action="dist">
                                    ${esc(distSummary(acc.distribution))}
                                </button>
                            </td>
                            <td class="ea-row-actions">
                                <button class="tree-node__action-btn" data-action="remove"
                                        title="Delete account">
                                    <span class="material-symbols-outlined">delete</span>
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        target.querySelectorAll('tr[data-account-label]').forEach((tr) => {
            const oldLabel = tr.dataset.accountLabel;
            tr.querySelectorAll('input,select').forEach((inp) => {
                inp.addEventListener('change', () => this._saveAccountRow(archetypeKey, oldLabel, tr));
                inp.addEventListener('blur',   () => this._saveAccountRow(archetypeKey, oldLabel, tr));
            });
            tr.querySelector('[data-action="dist"]')?.addEventListener('click',
                () => this._onEditAccountDist(archetypeKey, oldLabel));
            tr.querySelector('[data-action="remove"]')?.addEventListener('click',
                () => this._onRemoveAccount(archetypeKey, oldLabel));
        });
    }

    async _saveAccountRow(archetypeKey, oldLabel, tr) {
        const label   = tr.querySelector('[data-field="label"]').value;
        const kind    = tr.querySelector('[data-field="asset_kind"]').value;
        const type    = tr.querySelector('[data-field="type"]').value;
        const ivRaw   = tr.querySelector('[data-field="initial_value"]').value;
        const initial = ivRaw === '' ? 0 : Number(ivRaw);
        const res = await window.pywebview?.api?.agent_account_template_update?.(
            archetypeKey, oldLabel, label, kind, type, initial,
        );
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this.refresh();
    }

    async _onAddAccount(archetypeKey) {
        // Layer 8.C — minimal create modal: pick the kind + side, name
        // it. `initial_value` + `distribution` get edited inline on the
        // row in the accounts table afterwards (so the modal stays
        // friction-light and doesn't pretend a single dialog can cover
        // all the configuration this row will eventually need).
        const data = await openForm({
            title: 'Add account',
            submitLabel: 'Add',
            fields: [
                { name: 'label', label: 'Label', type: 'text', required: true,
                  placeholder: 'e.g. Reserves' },
                { name: 'asset_kind', label: 'Asset kind', type: 'select',
                  required: true,
                  options: this._assetKinds.map((k) => ({
                      value: k.id, label: k.name || k.id,
                  })),
                  default: this._assetKinds[0]?.id,
                  placeholder: 'pick a kind…',
                  create: {
                      hint: 'asset kind',
                      onCreate: async (typed) => {
                          const name = String(typed).trim();
                          if (!name) return null;
                          const res = await window.pywebview?.api?.asset_add?.({ name });
                          if (res && res.ok === false) {
                              this.logger.warn?.(res.error);
                              return null;
                          }
                          return res?.asset_kind?.id || name;
                      },
                  } },
                { name: 'type', label: 'Side', type: 'select',
                  options: ACCOUNT_TYPES.map((t) => ({ value: t, label: t })),
                  default: 'Assets' },
            ],
        });
        if (!data) return;
        const res = await window.pywebview?.api?.agent_account_template_add?.(
            archetypeKey, data.label, data.asset_kind, data.type, 0.0,
        );
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this.refresh();
    }

    async _onRemoveAccount(archetypeKey, label) {
        const ok = await openConfirm({
            title: 'Delete account',
            message: `Remove "${label}" from ${archetypeKey}'s chart of accounts?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        await window.pywebview?.api?.agent_account_template_remove?.(archetypeKey, label);
        await this.refresh();
    }

    async _onEditAccountDist(archetypeKey, label) {
        const arch = this._archetypes.find((a) => a.archetype === archetypeKey);
        const acc = (arch?.accounts || []).find((x) => x.label === label);
        if (!acc) return;
        const distribution = await openDistributionModal(acc.distribution);
        if (distribution === undefined) return;
        await window.pywebview?.api?.agent_account_template_set_distribution?.(
            archetypeKey, label, distribution,
        );
        await this.refresh();
    }

    // ---------------------------------------- asset-kind chips + CRUD

    /** Which kinds this sector actually USES (derived from its accounts). */
    _kindsUsedHere() {
        const seen = new Set();
        for (const a of (this._accounts || [])) {
            if (a.asset_kind) seen.add(a.asset_kind);
        }
        // Preserve _assetKinds ordering so the UI is stable across loads.
        return (this._assetKinds || []).filter((k) => seen.has(k.id));
    }

    _renderKindList() {
        const host = this._root.querySelector('#ea-kind-list');
        if (!host) return;
        const kinds = this._kindsUsedHere();
        // Drop the per-tab selection if the kind no longer exists here.
        if (this._selectedKindId
            && !kinds.some((k) => k.id === this._selectedKindId)) {
            this._selectedKindId = null;
        }
        if (kinds.length === 0) {
            host.innerHTML = '<li class="ea-kind-list__empty">'
                + 'No asset kinds on this sector’s accounts yet.</li>';
            return;
        }
        host.innerHTML = kinds.map((k) => {
            const active = (k.id === this._selectedKindId);
            return `
                <li class="ea-kind-list__item${active ? ' ea-kind-list__item--active' : ''}"
                    data-kind-id="${esc(k.id)}">
                    <button class="ea-kind-list__row" data-action="select">
                        <span class="material-symbols-outlined">category</span>
                        <span class="ea-kind-list__name">${esc(k.id)}</span>
                    </button>
                    <span class="ea-kind-list__actions">
                        <button class="tree-node__action-btn" data-action="rename"
                                title="Rename this kind">
                            <span class="material-symbols-outlined">edit</span>
                        </button>
                        <button class="tree-node__action-btn" data-action="delete"
                                title="Delete this asset kind globally">
                            <span class="material-symbols-outlined">delete</span>
                        </button>
                    </span>
                </li>
            `;
        }).join('');
        host.querySelectorAll('[data-kind-id]').forEach((el) => {
            const id = el.dataset.kindId;
            el.querySelector('[data-action="select"]')?.addEventListener('click', () => {
                this._selectedKindId = (this._selectedKindId === id) ? null : id;
                this._renderKindList();
                this._renderKindSlice();
            });
            el.querySelector('[data-action="rename"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this._onRenameAsset(id);
            });
            el.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this._onRemoveAsset(id);
            });
        });
    }

    async _onAddAsset() {
        // A kind is just a name — there's no separate id/label.
        const data = await openForm({
            title: 'Add asset kind',
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true,
                  placeholder: 'e.g. deposits' },
            ],
            submitLabel: 'Add',
        });
        if (!data) return;
        const name = String(data.name).trim();
        if (!name) return;
        const res = await window.pywebview?.api?.asset_add?.({ id: name });
        if (res && res.ok === false) { this.logger.warn?.(res.error); return; }
        await this.refresh();
    }

    async _onRenameAsset(id) {
        const data = await openForm({
            title: `Rename "${id}"`,
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true,
                  default: id },
            ],
            submitLabel: 'Save',
        });
        if (!data) return;
        const name = String(data.name).trim();
        if (!name || name === id) return;
        // Renaming a kind cascades to every account that references it
        // (the bridge does this) — `id` is the kind's only identity.
        const res = await window.pywebview?.api?.asset_update?.({
            id, new_id: name,
        });
        if (res && res.ok === false) { this.logger.warn?.(res.error); return; }
        if (this._selectedKindId === id) this._selectedKindId = name;
        await this.refresh();
    }

    async _onRemoveAsset(id) {
        const ok = await openConfirm({
            title: 'Delete asset kind',
            message: `Delete "${id}" globally? All accounts of this kind must `
                + 'be removed from every archetype first, or the deletion will be refused.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        const res = await window.pywebview?.api?.asset_remove?.(id);
        if (res && res.ok === false) { this.logger.warn?.(res.error); return; }
        if (this._selectedKindId === id) this._selectedKindId = null;
        await this.refresh();
    }

    _renderBalanceSheet() {
        const targets = [
            this._root.querySelector('#ea-balance-sheets'),
        ].filter(Boolean);
        if (targets.length === 0) return;
        const html = this._sector
            ? this._sectorSheetHtml(this._sector)
            : '<div class="ea-plot__placeholder">Sector not found — it may have been removed.</div>';
        for (const target of targets) {
            target.innerHTML = html;
            target.querySelectorAll('.ea-sheet__row[data-account-id]').forEach((row) => {
                row.addEventListener('click', () => this._onInspectAccount({
                    id:    row.dataset.accountId,
                    label: row.dataset.accountLabel,
                    agent: row.dataset.accountAgent,
                }));
            });
            target.querySelectorAll('.ea-sheet__row[data-toggle-group]').forEach((row) => {
                row.addEventListener('click', () => {
                    const key = row.dataset.toggleGroup;
                    if (this._expandedGroups.has(key)) this._expandedGroups.delete(key);
                    else this._expandedGroups.add(key);
                    this._renderBalanceSheet();
                });
            });
        }
    }

    _sectorSheetHtml(s) {
        const accounts = this._accounts || [];
        const viewingTick = getViewingTick();
        const buckets = { Assets: [], Liabilities: [], Equity: [] };
        for (const a of accounts) {
            if (buckets[a.type]) buckets[a.type].push(a);
        }
        const totals = ACCOUNT_TYPES.map((t) =>
            buckets[t].reduce((sum, a) => sum + (Number(a.balance) || 0), 0));
        const net = totals[0] - totals[1] - totals[2];
        const balanced = Math.abs(net) < 1e-6;

        const sparkFor = (history, type) => history.length > 1
            ? renderSparkline(history, {
                width: 60, height: 16,
                color: SIDE_COLORS[type] || '#888',
                viewingTick,
              })
            : '';

        const singleRow = (a, type) => `
            <button type="button" class="ea-sheet__row"
                    data-account-id="${esc(a.account_id)}"
                    data-account-label="${esc(a.label)}"
                    data-account-agent="${esc(a.agent_id || '')}"
                    title="Click to chart this account's history">
                <span class="ea-sheet__row-label">
                    ${esc(a.label)}
                    <span class="ea-sheet__row-sub">${esc(a.agent_id || '')} · ${esc(a.asset_kind)}</span>
                </span>
                <span class="ea-sheet__row-spark">${sparkFor(this._histories[a.account_id] || [], type)}</span>
                <span class="ea-sheet__row-amount">${fmt(a.balance)}</span>
            </button>`;

        const childRow = (a, type) => `
            <button type="button" class="ea-sheet__row ea-sheet__row--child"
                    data-account-id="${esc(a.account_id)}"
                    data-account-label="${esc(a.label)}"
                    data-account-agent="${esc(a.agent_id || '')}"
                    title="Click to chart this account's history">
                <span class="ea-sheet__row-label">
                    <span class="ea-sheet__row-sub">${esc(a.agent_id || '(unowned)')}</span>
                </span>
                <span class="ea-sheet__row-spark">${sparkFor(this._histories[a.account_id] || [], type)}</span>
                <span class="ea-sheet__row-amount">${fmt(a.balance)}</span>
            </button>`;

        const groupRow = (g, type) => {
            const total = g.accounts.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
            const combined = aggregateHistory(g.accounts, this._histories);
            const expanded = this._expandedGroups.has(g.key);
            const childrenHtml = expanded
                ? g.accounts.slice()
                    .sort((a, b) => String(a.agent_id || '').localeCompare(String(b.agent_id || '')))
                    .map((a) => childRow(a, type)).join('')
                : '';
            return `
                <div class="ea-sheet__group${expanded ? ' ea-sheet__group--expanded' : ''}">
                    <button type="button" class="ea-sheet__row ea-sheet__row--group${expanded ? ' ea-sheet__row--expanded' : ''}"
                            data-toggle-group="${esc(g.key)}"
                            title="${expanded ? 'Collapse' : 'Expand'} aggregate">
                        <span class="ea-sheet__chevron material-symbols-outlined">chevron_right</span>
                        <span class="ea-sheet__row-label">
                            ${esc(g.label)}
                            <span class="ea-sheet__row-sub">${esc(g.asset_kind)} · ${g.accounts.length} agents</span>
                        </span>
                        <span class="ea-sheet__row-spark">${sparkFor(combined, type)}</span>
                        <span class="ea-sheet__row-amount">${fmt(total)}</span>
                    </button>
                    ${childrenHtml}
                </div>`;
        };

        const colHtml = (type) => {
            const rows = buckets[type];
            if (rows.length === 0) return '<div class="ea-sheet__col-empty">—</div>';
            const groups = new Map();
            for (const a of rows) {
                const key = `${a.label}::${a.asset_kind}`;
                if (!groups.has(key)) {
                    groups.set(key, { key, label: a.label, asset_kind: a.asset_kind, accounts: [] });
                }
                groups.get(key).accounts.push(a);
            }
            return [...groups.values()]
                .sort((x, y) =>
                    x.asset_kind.localeCompare(y.asset_kind)
                    || x.label.localeCompare(y.label))
                .map((g) => g.accounts.length === 1
                    ? singleRow(g.accounts[0], type)
                    : groupRow(g, type))
                .join('');
        };
        return `
            <article class="ea-sheet" data-sector-id="${esc(s.id)}">
                <header class="ea-sheet__head">
                    <h4 class="ea-sheet__title">${esc(s.label)}</h4>
                    <span class="ea-sheet__sub">${esc(s.id)} · ${esc(s.kind || 'real')}
                        · ${accounts.length} account${accounts.length === 1 ? '' : 's'}</span>
                </header>
                <div class="ea-sheet__cols">
                    <section class="ea-sheet__col">
                        <h5 class="ea-sheet__col-head">Assets</h5>
                        <div class="ea-sheet__col-body">${colHtml('Assets')}</div>
                        <footer class="ea-sheet__col-foot">Σ ${fmt(totals[0])}</footer>
                    </section>
                    <section class="ea-sheet__col">
                        <h5 class="ea-sheet__col-head">Liabilities</h5>
                        <div class="ea-sheet__col-body">${colHtml('Liabilities')}</div>
                        <footer class="ea-sheet__col-foot">Σ ${fmt(totals[1])}</footer>
                    </section>
                    <section class="ea-sheet__col">
                        <h5 class="ea-sheet__col-head">Equity</h5>
                        <div class="ea-sheet__col-body">${colHtml('Equity')}</div>
                        <footer class="ea-sheet__col-foot">Σ ${fmt(totals[2])}</footer>
                    </section>
                </div>
                <footer class="ea-sheet__check">
                    A − L − E =
                    ${balanced
                        ? `<span class="ea-check ea-check--ok">${fmt(net)} ✓</span>`
                        : `<span class="ea-check ea-check--leak">${fmt(net)} ⚠ leak</span>`}
                </footer>
            </article>
        `;
    }

    // ------------------------------------------------ asset-kind slice card

    _renderKindSlice() {
        const host = this._root?.querySelector('[data-kind-slice]');
        if (!host) return;
        const kindId = this._selectedKindId;
        if (!kindId) {
            host.innerHTML = '<div class="ea-plot__placeholder">'
                + 'Pick an asset kind from the list to see cross-sector '
                + 'totals, the time series, and the transactions involving '
                + 'this sector — all scoped to that kind.</div>';
            return;
        }
        const label = kindId;   // the kind's name IS its id
        // Sub-blocks (not nested .ea-card — the split already lives
        // inside one card).
        host.innerHTML = `
            <div class="ea-kind-slice__block">
                <h4 class="ea-kind-slice__heading">Cross-sector consistency · ${esc(label)}</h4>
                <div id="ea-kind-cross"></div>
            </div>
            <div class="ea-kind-slice__block">
                <h4 class="ea-kind-slice__heading">Time series · ${esc(label)}</h4>
                <div id="ea-kind-series"></div>
            </div>
            <div class="ea-kind-slice__block">
                <h4 class="ea-kind-slice__heading">Transactions involving this sector · ${esc(label)}</h4>
                <div id="ea-kind-matrix"></div>
            </div>
        `;
        this._renderKindCross(kindId);
        this._renderKindSeries(kindId);
        this._renderKindMatrix(kindId);
    }

    _renderKindCross(kindId) {
        const target = this._root.querySelector('#ea-kind-cross');
        if (!target) return;
        const sectors = this._sectors || [];
        if (sectors.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">No sectors configured.</div>';
            return;
        }
        const rows = sectors.map((s) => {
            const r = (this._balanceSheet[s.id]?.[kindId]) || {};
            const a = Number(r.Assets) || 0;
            const l = Number(r.Liabilities) || 0;
            const e = Number(r.Equity) || 0;
            return { id: s.id, label: s.label || s.id, a, l, e, n: a - l - e };
        });
        const sigma = (key) => rows.reduce((s, r) => s + r[key], 0);
        const totA = sigma('a'), totL = sigma('l'), totE = sigma('e');
        const totNet = totA - totL - totE;
        target.innerHTML = `
            <table class="ea-table ea-table--sheet">
                <thead><tr>
                    <th>Sector</th>
                    <th class="ea-table__cell">Assets</th>
                    <th class="ea-table__cell">Liabilities</th>
                    <th class="ea-table__cell">Equity</th>
                    <th class="ea-table__cell">A − L − E</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r) => `
                        <tr class="${r.id === this.sectorId ? 'ea-row-highlight' : ''}">
                            <th class="ea-table__row-head">${esc(r.label)}</th>
                            <td class="ea-table__cell">${fmt(r.a)}</td>
                            <td class="ea-table__cell">${fmt(r.l)}</td>
                            <td class="ea-table__cell">${fmt(r.e)}</td>
                            <td class="ea-table__cell">
                                ${Math.abs(r.n) < 1e-6
                                    ? '<span class="ea-check ea-check--ok">✓</span>'
                                    : `<span class="ea-check ea-check--leak">${fmt(r.n)}</span>`}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot><tr>
                    <th class="ea-table__row-head">Σ</th>
                    <td class="ea-table__cell">${fmt(totA)}</td>
                    <td class="ea-table__cell">${fmt(totL)}</td>
                    <td class="ea-table__cell">${fmt(totE)}</td>
                    <td class="ea-table__cell">
                        ${Math.abs(totNet) < 1e-6
                            ? '<span class="ea-check ea-check--ok">✓</span>'
                            : `<span class="ea-check ea-check--leak">${fmt(totNet)}</span>`}
                    </td>
                </tr></tfoot>
            </table>
        `;
    }

    _renderKindSeries(kindId) {
        const target = this._root.querySelector('#ea-kind-series');
        if (!target) return;
        const aggs = this._historyAggregates || [];
        const interesting = aggs.some((e) => {
            const r = e.kinds?.[kindId] || {};
            return Math.abs(r.Assets || 0) + Math.abs(r.Liabilities || 0)
                 + Math.abs(r.Equity || 0) > 1e-9;
        });
        if (aggs.length === 0 || !interesting) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + 'No history for this kind yet — run the world to populate.</div>';
            return;
        }
        const viewingTick = getViewingTick();
        const series = ['Assets', 'Liabilities', 'Equity'].map((side) => ({
            name: side,
            color: SIDE_COLORS[side],
            points: aggs.map((e) => [e.tick, Number((e.kinds?.[kindId]?.[side]) ?? 0)]),
        }));
        renderLineChart(target, {
            series, width: 560, height: 200,
            viewingTick,
            onClickTick: (t) => {
                const clamped = Math.max(0, Math.min(this._historyLastTick, t));
                setViewingTick(clamped);
            },
        });
    }

    _renderKindMatrix(kindId) {
        const target = this._root.querySelector('#ea-kind-matrix');
        if (!target) return;
        const fm = this._flowMatrix || {};
        const sectors = this._sectors || [];
        if (sectors.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">No sectors configured.</div>';
            return;
        }
        const others = sectors.filter((s) => s.id !== this.sectorId);
        const rowsOut = others.map((s) => ({
            id: s.id, label: s.label || s.id,
            value: Number(fm[this.sectorId]?.[s.id]?.[kindId] ?? 0),
        }));
        const rowsIn = others.map((s) => ({
            id: s.id, label: s.label || s.id,
            value: Number(fm[s.id]?.[this.sectorId]?.[kindId] ?? 0),
        }));
        const sumOut = rowsOut.reduce((s, r) => s + r.value, 0);
        const sumIn  = rowsIn.reduce((s, r) => s + r.value, 0);
        if (sumOut === 0 && sumIn === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + 'No transactions of this kind involve this sector.</div>';
            return;
        }
        const renderHalf = (heading, rows, total, direction) => `
            <div class="ea-kind-matrix__half">
                <h4 class="ea-kind-matrix__heading">${esc(heading)}</h4>
                <table class="ea-table ea-flow-matrix__table">
                    <thead><tr>
                        <th>Counterparty</th>
                        <th class="ea-table__cell">Amount</th>
                    </tr></thead>
                    <tbody>
                        ${rows.filter((r) => r.value > 0).map((r) => `
                            <tr>
                                <th class="ea-flow-matrix__row-head">${esc(r.label)}</th>
                                <td class="ea-flow-matrix__cell ea-flow-matrix__cell--nonzero"
                                    data-counterparty="${esc(r.id)}"
                                    data-direction="${direction}"
                                    title="Click for transaction list">
                                    ${fmt(r.value)}
                                </td>
                            </tr>
                        `).join('') || '<tr><td colspan="2" class="ea-flow-matrix__cell">—</td></tr>'}
                    </tbody>
                    <tfoot><tr>
                        <th class="ea-flow-matrix__row-head">Σ</th>
                        <td class="ea-flow-matrix__cell ea-flow-matrix__cell--total">${fmt(total)}</td>
                    </tr></tfoot>
                </table>
            </div>
        `;
        target.innerHTML = `
            <div class="ea-kind-matrix">
                ${renderHalf(`Out: ${this._sector?.label || this.sectorId} →`, rowsOut, sumOut, 'out')}
                ${renderHalf(`In: → ${this._sector?.label || this.sectorId}`, rowsIn, sumIn, 'in')}
            </div>
        `;
        target.querySelectorAll('.ea-flow-matrix__cell--nonzero[data-counterparty]')
            .forEach((td) => {
                td.addEventListener('click', () =>
                    this._onInspectFlowCell(td.dataset.counterparty, td.dataset.direction, kindId));
            });
    }

    async _onInspectFlowCell(counterpartyId, direction, kindId) {
        const [from, to] = direction === 'out'
            ? [this.sectorId, counterpartyId]
            : [counterpartyId, this.sectorId];
        let txns = [];
        try {
            txns = await window.pywebview?.api?.world_transactions_between?.(from, to, kindId) ?? [];
        } catch (err) {
            this.logger.warn?.('world_transactions_between failed', { err });
        }
        const fromLabel = this._sectors.find((s) => s.id === from)?.label || from;
        const toLabel   = this._sectors.find((s) => s.id === to)?.label   || to;
        const kindLabel = kindId;
        const { openTransactionListModal } = await import('../ui/transaction_list_modal.js');
        await openTransactionListModal({
            title:    `${fromLabel} → ${toLabel}`,
            subtitle: `${kindLabel} · cumulative`,
            transactions: Array.isArray(txns) ? txns : [],
        });
    }

    // -------------------------------------------------------- account drill

    async _onInspectAccount({ id, label, agent }) {
        let history = [];
        try {
            history = await window.pywebview?.api?.world_account_history?.(id) ?? [];
        } catch (err) {
            this.logger.warn?.('world_account_history failed', { err });
        }
        if (!Array.isArray(history) || history.length === 0) {
            this.logger.warn?.(`No history for ${id} — start a run first.`);
            return;
        }
        await openChartModal({
            title:    `${label} · ${agent || '(unowned)'}`,
            subtitle: `Account history (id: ${id})`,
            series: [{ name: 'Balance', color: '#4ec9b0', points: history }],
        });
    }

    // ------------------------------------------------------------- popout

    _openPopout() {
        if (this.tabId) this.workspaceTabs?.popOutTab?.(this.tabId);
    }

    dispose() {
        this._unsubTick?.(); this._unsubTick = null;
        clearTimeout(this._scrubDebounce); this._scrubDebounce = null;
        // Bump the seq so any in-flight refresh discards its result
        // when it resolves into a disposed tab.
        this._refreshSeq++;
    }
}


/** Sum per-account histories into one [tick, balance] timeseries. */
function aggregateHistory(accounts, histories) {
    const byTick = new Map();
    for (const a of accounts) {
        const h = histories?.[a.account_id] || [];
        for (const [t, v] of h) {
            byTick.set(t, (byTick.get(t) || 0) + (Number(v) || 0));
        }
    }
    return [...byTick.entries()].sort((a, b) => a[0] - b[0]);
}
