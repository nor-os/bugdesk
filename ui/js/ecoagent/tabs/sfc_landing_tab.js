/**
 * sfc_landing_tab.js — SFC mode overview ("landing page").
 *
 * Dense layout matching the rest of EcoAgent's tabs (sector / market /
 * agent): a thin detail-header strip with summary stats, then the
 * Sectors DataTable. The table is keyboard-navigable (↑/↓ move the
 * cursor row, Enter opens the entity). Clicking a row opens its
 * dedicated tab.
 *
 * Every card on this page (and on other mode-overview pages) subscribes
 * to whatever events it cares about — there is no central polling loop.
 * v1 wires:
 *   ecoagent:run:tick        → refresh header stats
 *   ecoagent:run:completed   → ditto
 *   ecoagent:project:changed → full rebuild
 *   ecoagent:entity:renamed  → patch the affected row in place
 */

import { DataTable } from '../../ui/components/data_table.js';
import { esc } from './_util.js';
import { openForm, openConfirm, openModal } from '../ui/modal.js';
import {
    openCreateSectorForm,
} from '../ui/entity_create_forms.js';
import { toastError } from '../ui/toast.js';
import { mountGalleryPicker } from '../../ui/components/gallery_picker.js';
import {
    attachLandingTableBehavior,
    actionsCellRenderer,
    attachLandingShell,
    mountLandingActions,
} from '../../tiling/landing_table.js';

// Layer 8.A1: SectorKinds now come from the registry. The fallback
// here keeps the create modal usable in headless test contexts where
// the bridge isn't available; production paths read from
// `pywebview.api.sector_kinds_list()` and pass that into openForm.
const SECTOR_KINDS_FALLBACK = [
    { value: 'household',    label: 'Household' },
    { value: 'firm',         label: 'Firm' },
    { value: 'bank',         label: 'Commercial bank' },
    { value: 'central_bank', label: 'Central bank' },
    { value: 'government',   label: 'Government' },
    { value: 'foreign',      label: 'Foreign' },
    { value: 'non_profit',   label: 'Non-profit' },
];


export function makeSfcLandingTab(hostEl, _entityId, ctx) {
    return new SfcLandingTab(hostEl, ctx);
}


class SfcLandingTab {
    constructor(hostEl, { logger, eventBus, workspaceTabs } = {}) {
        this.hostEl = hostEl;
        this.log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.eventBus = eventBus ?? null;
        this.workspaceTabs = workspaceTabs ?? null;

        this._sectors = [];
        this._consistency = null;    // {tick, total_assets, total_liab, total_eq, residual}

        this._sectorsTable = null;
        // The landing-shell (attachLandingShell) owns pane focus +
        // per-pane row cursor + ↑↓/Tab/Enter/Home/End/←→ — bookkeeping
        // we used to do by hand here. mountLandingActions owns the
        // action footer and its [N]/[F] shortcuts.
        this._shell    = null;
        this._actions  = null;

        this._handlers = {
            'ecoagent:run:tick':        () => this._refreshHeader(),
            'ecoagent:run:completed':   () => this._refreshHeader(),
            'ecoagent:project:changed': () => this._fullRefresh(),
            'ecoagent:entity:renamed':  (p) => this._onRename(p),
        };
    }

    async mount() {
        this.hostEl.classList.add('ea-sfc-landing');
        this.hostEl.innerHTML = `
            <header class="ea-detail-header" data-role="header">
                    <h2>SFC overview</h2>
                    <span class="ea-detail-header__field"
                          title="Latest world tick">
                        <span>tick</span>
                        <strong data-role="hdr-tick">—</strong>
                    </span>
                    <span class="ea-detail-header__field"
                          title="Stock-flow consistency residual; should sum to zero.">
                        <span>residual</span>
                        <strong data-role="hdr-residual">—</strong>
                    </span>
                    <span class="ea-detail-header__field"
                          title="Sum of every asset on every ledger.">
                        <span>assets</span>
                        <strong data-role="hdr-assets">—</strong>
                    </span>
                    <span class="ea-detail-header__spacer"></span>
                    <span class="ea-detail-header__field">
                        <span>sectors</span>
                        <strong data-role="hdr-sectors">0</strong>
                    </span>
                </header>
                <div class="ea-sfc-landing__split">
                    <section class="ea-sfc-landing__pane" data-pane="sectors">
                        <div class="ea-sfc-landing__pane-head">
                            <span class="ea-sfc-landing__pane-title">Sectors</span>
                            <span class="ea-sfc-landing__pane-hint">↑↓ navigate · Enter open · click row to open</span>
                        </div>
                        <div class="ea-sfc-landing__table" data-role="sectors-host"></div>
                    </section>
                </div>
                <footer class="ea-sfc-landing__actions" data-role="actions"></footer>
        `;

        // Subscribe.
        for (const [evt, fn] of Object.entries(this._handlers)) {
            this.eventBus?.on?.(evt, fn);
        }

        // Pane focus + per-table cursor + Enter to open + Home/End —
        // all delegated to the shared shell.
        const sectorsPane = this.hostEl.querySelector('[data-pane="sectors"]');
        this._shell = attachLandingShell(this.hostEl, {
            panes: [
                {
                    paneEl: sectorsPane,
                    getRows:    () => this._sectors,
                    onActivate:         (r) => this._openEntity('sector', r),
                    onActivateInTab:    (r) => this._openEntityInTab('sector', r),
                    onActivateInWindow: (r) => this._openEntityInWindow('sector', r),
                },
            ],
        });

        // Action footer with [N] shortcut chip.
        const actionsHost = this.hostEl.querySelector('[data-role="actions"]');
        this._actions = mountLandingActions(actionsHost, [
            { id: 'new-sector', label: 'New sector', icon: 'add',
              shortcut: 'N',
              title: 'Add a sector to the chart of accounts',
              onClick: () => this._runAction('new-sector') },
            { id: 'open-analytics', label: 'Open analytics', icon: 'monitoring',
              title: 'Open the SFC analytics tab (consistency, time series, transaction-flow matrix)',
              onClick: () => this._runAction('open-analytics') },
        ], this.hostEl);

        await this._fullRefresh();
    }

    dispose() {
        for (const [evt, fn] of Object.entries(this._handlers)) {
            this.eventBus?.off?.(evt, fn);
        }
        try { this._shell?.teardown?.(); }   catch { /* ignore */ }
        try { this._actions?.teardown?.(); } catch { /* ignore */ }
        try { this._sectorsTable?.destroy?.(); } catch { /* ignore */ }
    }

    _openEntity(kind, r) {
        if (!r) return;
        this.workspaceTabs?.openTab?.({
            kind, entityId: r.id,
            label: r.label || r.name || r.id,
        });
    }

    _openEntityInTab(kind, r) {
        if (!r) return;
        const shim = this.workspaceTabs;
        const open = shim?.openInTab ?? shim?.openTab;
        open?.({
            kind, entityId: r.id,
            label: r.label || r.name || r.id,
        });
    }

    _openEntityInWindow(kind, r) {
        if (!r) return;
        const shim = this.workspaceTabs;
        const open = shim?.openInWindow ?? shim?.openTab;
        open?.({
            kind, entityId: r.id,
            label: r.label || r.name || r.id,
        });
    }

    // ───────────────────────────────────────────────────────── data

    async _fullRefresh() {
        const api = window.pywebview?.api;
        if (!api) return;
        try {
            const sectors = await (api.sectors_list?.() ?? []);
            this._sectors = Array.isArray(sectors) ? sectors : [];
        } catch (e) {
            this.log.warn?.('sfc_landing: list fetch failed', e);
            this._sectors = [];
        }
        await this._refreshConsistency();
        this._paintHeader();
        this._renderSectorsTable();
    }

    async _refreshConsistency() {
        const api = window.pywebview?.api;
        if (!api) return;
        try {
            const hist = await api.world_history_aggregates?.() ?? [];
            if (Array.isArray(hist) && hist.length) {
                const last = hist[hist.length - 1] || {};
                this._consistency = {
                    tick:         last.tick ?? null,
                    total_assets: Number(last.total_assets ?? 0),
                    total_liab:   Number(last.total_liabilities ?? last.total_liab ?? 0),
                    total_eq:     Number(last.total_equity ?? 0),
                    residual:     Number(last.residual ?? 0),
                };
            } else {
                this._consistency = null;
            }
        } catch (e) {
            this.log.warn?.('sfc_landing: history fetch failed', e);
            this._consistency = null;
        }
    }

    async _refreshHeader() {
        await this._refreshConsistency();
        this._paintHeader();
    }

    _paintHeader() {
        const $ = (sel) => this.hostEl.querySelector(sel);
        const c = this._consistency;
        $('[data-role="hdr-tick"]').textContent =
            c?.tick != null ? `t${c.tick}` : '—';
        $('[data-role="hdr-assets"]').textContent =
            c ? _fmtMoney(c.total_assets) : '—';
        const resEl = $('[data-role="hdr-residual"]');
        if (c) {
            const ok = Math.abs(c.residual) < 1e-6;
            resEl.textContent = _fmtSigned(c.residual);
            resEl.classList.toggle('ea-stat-ok',   ok);
            resEl.classList.toggle('ea-stat-warn', !ok);
        } else {
            resEl.textContent = '—';
            resEl.classList.remove('ea-stat-ok', 'ea-stat-warn');
        }
        $('[data-role="hdr-sectors"]').textContent = String(this._sectors.length);
    }

    _onRename({ kind, entityId, label } = {}) {
        if (kind === 'sector' && entityId && label) {
            const s = this._sectors.find((x) => x.id === entityId);
            if (s) { s.label = label; this._renderSectorsTable(); return; }
        }
        this._fullRefresh();
    }

    // ───────────────────────────────────────────────────────── tables

    _renderSectorsTable() {
        const host = this.hostEl.querySelector('[data-role="sectors-host"]');
        if (!host) return;
        const rows = this._sectors;
        try { this._sectorsTable?.destroy?.(); } catch { /* ignore */ }
        if (rows.length === 0) {
            host.innerHTML = `<div class="ea-table__empty">No sectors yet.</div>`;
            return;
        }
        // IDs are an implementation detail — the user never types or
        // sees them; we identify a sector by its display label. Sector
        // doesn't carry account_templates / params in `to_dict()`, so
        // we don't show columns that would always read "0".
        const headers = ['Name', 'Country', 'Kind', ''];
        const data = rows.map((r) => [
            r.label || r.id,
            r.country || '',
            r.kind || r.role || '',
            '',
        ]);
        this._sectorsTable = new DataTable(host, {
            headers, rows: data,
            pageSize: 50,
            pagination: true,
            sortable: true,
            filterable: true,
            selectable: true,
            copyable: true,
            renderCell: actionsCellRenderer(3, { edit: true, delete: true }),
        });
        this._sectorsTable.render();
        try { this._sectorsTeardown?.(); } catch {}
        this._sectorsTeardown = attachLandingTableBehavior(host,
            (idx) => rows[idx],
            {
                open: (r) => this.workspaceTabs?.openTab({
                    kind: 'sector', entityId: r.id,
                    label: r.label || r.id, icon: 'category',
                }),
                openInTab: (r) => this.workspaceTabs?.openInTab?.({
                    kind: 'sector', entityId: r.id,
                    label: r.label || r.id, icon: 'category',
                }),
                openInWindow: (r) => this.workspaceTabs?.openInWindow?.({
                    kind: 'sector', entityId: r.id,
                    label: r.label || r.id, icon: 'category',
                }),
                edit: async (r) => {
                    const data = await openForm({
                        title: 'Rename sector',
                        fields: [{ name: 'label', label: 'Name', type: 'text', required: true }],
                        defaults: { label: r.label || r.id },
                        submitLabel: 'Save',
                    });
                    if (!data?.label) return;
                    try {
                        await window.pywebview?.api?.sector_update?.(
                            r.id, data.label, r.kind || 'real', null, null,
                            r.country || null);
                    } catch (e) { toastError('Rename failed', e?.message || String(e)); }
                    await this._fullRefresh();
                },
                delete: async (r) => {
                    const ok = await openConfirm({
                        title: 'Delete sector',
                        message: `Delete <strong>${esc(r.label || r.id)}</strong>?`,
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    try { await window.pywebview?.api?.sector_remove?.(r.id); }
                    catch (e) { toastError('Delete failed', e?.message || String(e)); }
                    await this._fullRefresh();
                },
            });
        this._installRowClick(host, rows, 'sector');
        this._shell?.refresh?.();
    }

    /** Bind row click → open the entity tab. We attach on the rendered
     *  tbody (after DataTable.render) and translate `tr.__rowIndex`
     *  (DataTable's JS-property index) back into our `rows` array. */
    _installRowClick(host, rows, kind) {
        const tbody = host.querySelector('tbody');
        if (!tbody) return;
        tbody.addEventListener('click', (ev) => {
            const tr = ev.target.closest('tr');
            if (!tr || !tbody.contains(tr)) return;
            const idx = tr.__rowIndex;
            const r = rows[idx];
            if (!r) return;
            // Single-click is also DataTable's selection click; we
            // additionally open. (A second click on the same row still
            // re-activates the tab, idempotently.)
            this.workspaceTabs?.openTab?.({
                kind, entityId: r.id,
                label: r.label || r.id,
            });
        });
        // Inline hover cursor so the user sees rows are interactive.
        tbody.querySelectorAll('tr').forEach((tr) => {
            tr.style.cursor = 'pointer';
        });
    }

    // Keyboard (↑↓/Enter/Home/End/←→) and the [N] action shortcut
    // are owned by attachLandingShell + mountLandingActions —
    // no per-tab keydown handler here anymore.

    // ───────────────────────────────────────────────────────── actions

    async _runAction(action) {
        if (action === 'new-sector')        await this._actionNewSector();
        else if (action === 'open-analytics') {
            this.workspaceTabs?.openTab?.({
                kind: 'sfc-overview', entityId: 'overview',
                label: 'SFC analytics', icon: 'monitoring',
            });
        }
    }

    async _actionNewSector() {
        const sector = await openCreateSectorForm({
            api: window.pywebview?.api,
            eventBus: this.eventBus,
        });
        if (!sector) return;
        await this._fullRefresh();
        this.workspaceTabs?.notifyChanged?.('sectors');
        this.workspaceTabs?.openTab?.({
            kind: 'sector', entityId: sector.id,
            label: sector.label, icon: 'account_balance',
        });
    }

}


function _fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (abs >= 1e9)  return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6)  return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3)  return `${(v / 1e3).toFixed(2)}k`;
    return v.toFixed(2);
}

function _fmtSigned(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const s = _fmtMoney(Math.abs(v));
    return v >= 0 ? `+${s}` : `−${s}`;
}

// `esc` is intentionally imported but never used in the rewritten body —
// every value lands in DataTable's text path (which escapes already) or
// in a static template string. Keep the import: callers that derive from
// this module may add inline HTML and need it.
void esc;
