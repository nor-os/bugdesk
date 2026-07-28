/**
 * home_tab.js — project landing surface: one dense table of every entity
 * declared in the project. Keyboard-navigable (arrow keys move the
 * selected row, Enter opens it, `/` focuses the search box, Esc clears
 * it). Reuses ui/js/ui/components/data_table.js for sort + per-column
 * filter + selection + copy semantics — every other table in the app
 * already speaks DataTable, so the home view inherits that vocabulary
 * for free.
 *
 * Rows are pulled from the bridge in parallel:
 *
 *     sectors_list, agents_list,
 *     scenarios_list, market_instances_list, markets_list,
 *     kpis_list, analytics_dashboards_list
 *
 * Each row carries an `open` descriptor (kind + entityId + label) so the
 * "Open" action — or Enter on the selected row — hands directly off to
 * `workspaceTabs.openTab()`.
 */

import { DataTable } from '../../ui/components/data_table.js';
import { esc } from './_util.js';

const KIND_ICONS = {
    sector:             'category',
    'agent':            'group',
    'scenario':         'tune',
    'market':           'storefront',
    'market-archetype': 'storefront',
    'kpi':              'analytics',
    'dashboard':        'monitoring',
};

const KIND_LABEL = {
    sector:             'Sector',
    'agent':            'Archetype',
    'scenario':         'Scenario',
    'market':           'Market',
    'market-archetype': 'Market archetype',
    'kpi':              'KPI',
    'dashboard':        'Dashboard',
};

// Quick-filter chips on the table header. Clicking flips that kind on/off;
// the row is shown if any active chip matches. None active = show all.
const QUICK_FILTERS = [
    { key: 'sector',            label: 'Sectors',     icon: 'category' },
    { key: 'agent',             label: 'Agents',      icon: 'group' },
    { key: 'scenario',          label: 'Scenarios',   icon: 'tune' },
    { key: 'market',            label: 'Markets',     icon: 'storefront' },
    { key: 'market-archetype',  label: 'Markets', icon: 'storefront' },
    { key: 'kpi',               label: 'KPIs',        icon: 'analytics' },
    { key: 'dashboard',         label: 'Dashboards',  icon: 'monitoring' },
];


export function makeHomeTab(hostEl, _entityId, ctx) {
    return new HomeTab(hostEl, ctx);
}

class HomeTab {
    constructor(hostEl, { logger, eventBus, workspaceTabs } = {}) {
        this.hostEl = hostEl;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.eventBus = eventBus ?? null;
        this.workspaceTabs = workspaceTabs ?? null;

        this._rows = [];          // raw rows (all entities)
        this._activeKinds = new Set();  // empty = no quick filter
        this._search = '';        // free-text query
        this._table = null;       // DataTable instance
        this._selectedIdx = 0;    // index into the currently visible rows

        this._refreshHandler = () => this._refresh();
    }

    async mount() {
        this.hostEl.innerHTML = `
            <div class="ea-home-tab">
                <header class="ea-home-tab__head">
                    <h2 class="ea-home-tab__title">
                        <span class="material-symbols-outlined">table_view</span>
                        Project home
                    </h2>
                    <div class="ea-home-tab__search">
                        <span class="material-symbols-outlined">search</span>
                        <input type="search"
                               class="ea-home-tab__search-input"
                               placeholder="Search every entity… ( / to focus, Esc to clear )"
                               autocomplete="off"
                               spellcheck="false" />
                        <span class="ea-home-tab__count" data-role="count"></span>
                    </div>
                </header>
                <div class="ea-home-tab__chips" data-role="chips"></div>
                <div class="ea-home-tab__table" data-role="table"></div>
                <footer class="ea-home-tab__foot">
                    <span class="ea-home-tab__hint">
                        <kbd>↑</kbd><kbd>↓</kbd> navigate ·
                        <kbd>Enter</kbd> open ·
                        <kbd>/</kbd> search ·
                        <kbd>Esc</kbd> clear
                    </span>
                </footer>
            </div>
        `;
        this._renderChips();
        this._wireSearch();
        this._wireKeyboard();
        this.eventBus?.on?.('ecoagent:project:changed', this._refreshHandler);
        this.eventBus?.on?.('ecoagent:entity:renamed', this._refreshHandler);
        this.eventBus?.on?.('workspace:tabs:closed', this._refreshHandler);
        await this._refresh();
    }

    dispose() {
        this.eventBus?.off?.('ecoagent:project:changed', this._refreshHandler);
        this.eventBus?.off?.('ecoagent:entity:renamed', this._refreshHandler);
        this.eventBus?.off?.('workspace:tabs:closed', this._refreshHandler);
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        try { this._table?.destroy?.(); } catch { /* ignore */ }
    }

    show() {
        // Re-focus search so / + type-ahead keeps working when revisiting.
        queueMicrotask(() => this._focusSearch());
    }

    async _refresh() {
        const api = window.pywebview?.api;
        if (!api) { this._rows = []; this._render(); return; }
        try {
            const [sectors, archetypes, scenariosResp,
                   markets, marketArchetypes, kpis, dashboards] = await Promise.all([
                api.sectors_list?.()           ?? [],
                api.agents_list?.()        ?? [],
                api.scenarios_list?.()         ?? { scenarios: [] },
                api.market_instances_list?.()           ?? [],
                api.markets_list?.() ?? [],
                api.kpis_list?.()              ?? [],
                api.analytics_dashboards_list?.() ?? [],
            ]);
            const rows = [];
            for (const s of sectors || []) {
                rows.push({
                    kind: 'sector', name: s.label || s.id, id: s.id,
                    country: s.country || '', detail: s.role || '',
                    open: { kind: 'sector', entityId: s.id, label: s.label || s.id },
                });
            }
            for (const a of archetypes || []) {
                rows.push({
                    kind: 'agent', name: a.label || a.archetype, id: a.archetype,
                    country: this._archetypeCountry(a, sectors), detail: a.default_sector || '',
                    open: { kind: 'agent', entityId: a.archetype, label: a.label || a.archetype },
                });
            }
            const scenarios = scenariosResp?.scenarios || scenariosResp || [];
            for (const s of scenarios || []) {
                rows.push({
                    kind: 'scenario', name: s.label || s.id, id: s.id,
                    country: '', detail: s.description || '',
                    open: { kind: 'scenario', entityId: s.id, label: s.label || s.id },
                });
            }
            for (const m of markets || []) {
                rows.push({
                    kind: 'market', name: m.label || m.id, id: m.id,
                    country: m.country || '', detail: m.kind || '',
                    open: { kind: 'market', entityId: m.id, label: m.label || m.id },
                });
            }
            for (const a of marketArchetypes || []) {
                rows.push({
                    kind: 'market-archetype', name: a.label || a.id, id: a.id,
                    country: '', detail: a.kind || '',
                    open: { kind: 'market-archetype', entityId: a.id, label: a.label || a.id },
                });
            }
            for (const k of kpis || []) {
                rows.push({
                    kind: 'kpi', name: k.label || k.id, id: k.id,
                    country: k.country || '', detail: k.unit || k.kind || '',
                    open: { kind: 'kpi', entityId: k.id, label: k.label || k.id },
                });
            }
            for (const d of dashboards || []) {
                rows.push({
                    kind: 'dashboard', name: d.label || d.id, id: d.id,
                    country: '', detail: d.description || '',
                    open: { kind: 'dashboard', entityId: d.id, label: d.label || d.id },
                });
            }
            rows.sort((a, b) =>
                (a.kind === b.kind ? 0 : a.kind.localeCompare(b.kind))
                || String(a.name).localeCompare(String(b.name)));
            this._rows = rows;
        } catch (err) {
            this.logger.warn?.('home_tab refresh failed', err);
            this._rows = [];
        }
        this._render();
    }

    _archetypeCountry(arch, sectors) {
        const sid = arch?.default_sector;
        if (!sid) return '';
        const s = (sectors || []).find((x) => x.id === sid);
        return s?.country || '';
    }

    _renderChips() {
        const chips = this.hostEl.querySelector('[data-role="chips"]');
        if (!chips) return;
        chips.innerHTML = QUICK_FILTERS.map((f) => `
            <button type="button" class="ea-home-tab__chip"
                    data-kind="${esc(f.key)}"
                    title="Toggle: show only ${esc(f.label)}.">
                <span class="material-symbols-outlined">${esc(f.icon)}</span>
                ${esc(f.label)}
            </button>
        `).join('');
        chips.querySelectorAll('[data-kind]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const k = btn.dataset.kind;
                if (this._activeKinds.has(k)) this._activeKinds.delete(k);
                else this._activeKinds.add(k);
                this._render();
            });
        });
        this._paintChipState();
    }

    _paintChipState() {
        const chips = this.hostEl.querySelectorAll('[data-role="chips"] [data-kind]');
        chips.forEach((c) => {
            c.classList.toggle('ea-home-tab__chip--active',
                this._activeKinds.has(c.dataset.kind));
        });
    }

    _wireSearch() {
        const input = this.hostEl.querySelector('.ea-home-tab__search-input');
        if (!input) return;
        input.addEventListener('input', () => {
            this._search = input.value.trim().toLowerCase();
            this._render();
        });
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                if (input.value) {
                    input.value = '';
                    this._search = '';
                    this._render();
                    ev.preventDefault();
                    ev.stopPropagation();
                } else {
                    input.blur();
                }
            } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                input.blur();
                this._moveSelection(ev.key === 'ArrowDown' ? 1 : -1);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                this._openSelected();
            }
        });
    }

    _wireKeyboard() {
        // Tab-scoped: only fire while this tab is the active workspace tab
        // *and* the host is in the DOM. Focus is taken from search inputs
        // by ArrowDown above; from the table we read native keydowns.
        this._keyHandler = (ev) => {
            if (!this.hostEl.isConnected) return;
            const active = this.hostEl.contains(document.activeElement);
            const inEditable = isEditableTarget(ev.target);
            if (ev.key === '/' && !inEditable) {
                ev.preventDefault();
                this._focusSearch();
                return;
            }
            if (!active) return;
            if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                this._moveSelection(1);
            } else if (ev.key === 'ArrowUp') {
                ev.preventDefault();
                this._moveSelection(-1);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                this._openSelected();
            }
        };
        document.addEventListener('keydown', this._keyHandler);
    }

    _focusSearch() {
        const input = this.hostEl.querySelector('.ea-home-tab__search-input');
        input?.focus();
        input?.select?.();
    }

    _visibleRows() {
        const q = this._search;
        const kinds = this._activeKinds;
        return this._rows.filter((r) => {
            if (kinds.size && !kinds.has(r.kind)) return false;
            if (!q) return true;
            const hay = `${r.name} ${r.id} ${r.kind} ${r.country} ${r.detail}`
                .toLowerCase();
            return hay.includes(q);
        });
    }

    _render() {
        this._paintChipState();
        const host = this.hostEl.querySelector('[data-role="table"]');
        const countEl = this.hostEl.querySelector('[data-role="count"]');
        if (!host) return;
        const visible = this._visibleRows();
        if (countEl) {
            const total = this._rows.length;
            countEl.textContent = visible.length === total
                ? `${total}`
                : `${visible.length}/${total}`;
        }
        if (this._selectedIdx >= visible.length) {
            this._selectedIdx = Math.max(0, visible.length - 1);
        }
        if (visible.length === 0) {
            host.innerHTML =
                `<div class="ea-home-tab__empty">No entities match — ${
                    this._search || this._activeKinds.size
                        ? 'try clearing the filter.'
                        : 'add sectors, archetypes, or KPIs to get started.'
                }</div>`;
            try { this._table?.destroy?.(); } catch { /* ignore */ }
            this._table = null;
            return;
        }
        const headers = ['Name', 'Kind', 'Country', 'Detail', ''];
        const rows = visible.map((r) => [
            r.name,
            r.kind,
            r.country,
            r.detail,
            '',
        ]);
        try { this._table?.destroy?.(); } catch { /* ignore */ }
        // DataTable doesn't paint on construction — its constructor only
        // captures config. Call `render()` after so the table actually
        // appears. (Skipping this gave the empty-workspace bug where the
        // count badge said "114" but the table host stayed blank.)
        this._table = new DataTable(host, {
            headers, rows,
            pageSize:   1000,         // pagination off below; this caps the page
            pagination: false,
            sortable:   true,
            filterable: false,   // free-text search box above is the filter
            selectable: true,
            copyable:   true,
            readonly:   false,
            emptyMessage: 'No entities.',
            getColumnType: (i) => i === 0 ? 'text' : i === 4 ? 'text' : 'text',
            getHeaderIcon: (h, i) => i === 1 ? { icon: 'category', title: 'Kind' } : null,
            renderCell: (td, value, colIdx, rowIdx /* sortedIndex */) => {
                if (colIdx === 1) {
                    const k = visible[rowIdx]?.kind;
                    const meta = { icon: KIND_ICONS[k] || 'circle', label: KIND_LABEL[k] || k };
                    td.innerHTML = `
                        <span class="ea-home-tab__kind">
                            <span class="material-symbols-outlined">${esc(meta.icon)}</span>
                            ${esc(meta.label)}
                        </span>`;
                    return true;
                }
                if (colIdx === 4) {
                    const r = visible[rowIdx];
                    td.innerHTML = `
                        <button type="button"
                                class="ea-btn ea-btn--small ea-home-tab__open"
                                data-row-idx="${rowIdx}"
                                title="Open ${esc(r?.name || '')}">
                            <span class="material-symbols-outlined">open_in_new</span>
                        </button>`;
                    const btn = td.querySelector('button');
                    btn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        this._openRow(r);
                    });
                    return true;
                }
                return false;   // let DataTable render scalars
            },
            onSelectionChange: (idxs) => {
                if (idxs?.size) {
                    this._selectedIdx = Math.min(...idxs);
                }
            },
        });
        this._table.render();
        // Single-click a row → open. DataTable stashes the original index
        // on `tr.__rowIndex` (a JS property, not a DOM attribute) so we
        // read it via DOM traversal rather than an attribute selector.
        const tbody = host.querySelector('tbody');
        tbody?.addEventListener('click', (ev) => {
            // Ignore clicks that target an action button inside the row
            // (e.g. the open icon) — those have their own stopPropagation
            // handlers.
            if (ev.target.closest('button, a, input, select, textarea')) return;
            const tr = ev.target.closest('tr');
            if (!tr || !tbody.contains(tr)) return;
            const idx = tr.__rowIndex;
            const r = visible[idx];
            if (r) this._openRow(r);
        });
        // Reflect the JS selection on the DOM.
        this._highlightSelected(host, this._selectedIdx);
    }

    _highlightSelected(host, idx) {
        let cursor = null;
        const trs = host.querySelectorAll('tbody tr');
        trs.forEach((tr) => {
            tr.classList.remove('ea-home-tab__row--cursor');
            if (tr.__rowIndex === idx) cursor = tr;
        });
        if (cursor) {
            cursor.classList.add('ea-home-tab__row--cursor');
            cursor.scrollIntoView({ block: 'nearest' });
        }
    }

    _moveSelection(delta) {
        const visible = this._visibleRows();
        if (visible.length === 0) return;
        this._selectedIdx = Math.max(0,
            Math.min(visible.length - 1, this._selectedIdx + delta));
        const host = this.hostEl.querySelector('[data-role="table"]');
        if (host) this._highlightSelected(host, this._selectedIdx);
    }

    _openSelected() {
        const visible = this._visibleRows();
        const r = visible[this._selectedIdx];
        if (r) this._openRow(r);
    }

    _openRow(row) {
        if (!row?.open || !this.workspaceTabs) return;
        this.workspaceTabs.openTab({
            kind: row.open.kind,
            entityId: row.open.entityId,
            label: row.open.label,
        });
    }
}


function isEditableTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
}
