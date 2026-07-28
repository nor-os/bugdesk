/**
 * markets_landing.js — top-level "Markets" page.
 *
 * Two levels: market (the marketplace itself, e.g. "Consumer goods")
 * and branch (a specialization of that market for a specific class of
 * goods, e.g. "Equity branch under Capital market"). Branches are
 * what runs at simulation time — there is no separate "instance"
 * layer.
 *
 * Layout mirrors `agents_landing`: collapsible tree, parent market
 * rows expand to show their branches, Left/Right collapse via the
 * shell keymap.
 *
 * On disk the entities are still named `market_archetype` / `market`
 * (top-level / branch respectively); only the user-facing terminology
 * has been updated. A deeper bridge-side rename is a follow-up pass.
 */

import { DataTable } from '../ui/components/data_table.js';
import { openConfirm } from '../ecoagent/ui/modal.js';
import {
    actionsCellRenderer,
    attachLandingTableBehavior,
    attachLandingShell,
    mountLandingActions,
    mountLandingShell,
} from './landing_table.js';

export function mountMarketsLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Markets',
        stats: [
            { key: 'hdr-markets',  label: 'markets' },
            { key: 'hdr-branches', label: 'branches' },
        ],
        pane: {
            key: 'markets',
            title: 'Markets & branches',
            hint:  '↑↓ navigate · ←→ collapse / expand · Enter open · Tab next section',
        },
    });

    let markets = [];        // top-level entries (was `archs`).
    let branches = [];       // child entries (was `markets` = instances).
    let table = null;
    let teardown = () => {};
    let rowsLogical = [];    // [{type:'market'|'branch', ...}, ...]
    const expandedMarkets = new Set();

    const refresh = async () => {
        try {
            const [m, b] = await Promise.all([
                _toArr(api?.markets_list?.()),
                _toArr(api?.market_instances_list?.()),
            ]);
            markets = m;
            branches = b;
        } catch (err) {
            console.warn('[markets-landing] refresh failed', err);
        }
        _shell.setStat('hdr-markets', markets.length);
        _shell.setStat('hdr-branches', branches.length);
        renderTable();
    };

    const branchesByMarket = () => {
        const map = new Map();
        for (const b of branches) {
            const dot = String(b.id || '').indexOf('.');
            const key = dot > 0 ? b.id.slice(0, dot) : (b.archetype || '');
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(b);
        }
        return map;
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}

        if (markets.length === 0 && branches.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">No markets yet.</div>';
            return;
        }

        rowsLogical = [];
        const byMarket = branchesByMarket();
        for (const m of markets) {
            const kids = byMarket.get(m.id) || [];
            const expanded = expandedMarkets.has(m.id);
            rowsLogical.push({
                type:  'market',
                id:    m.id,
                label: m.label || m.id,
                // The archetype's base market mechanic lives in `kind_id`
                // (e.g. "BondAuction", "ContinuousDoubleAuction"); there is
                // no `kind` field, so reading `m.kind` left the column blank.
                kind:  m.kind_id || m.kind || '',
                count: kids.length,
                expanded,
                _raw:  m,
            });
            if (expanded) {
                for (const b of kids) {
                    const dot = b.id.indexOf('.');
                    const branchLabel = dot > 0 ? b.id.slice(dot + 1) : b.id;
                    rowsLogical.push({
                        type:   'branch',
                        id:     b.id,
                        label:  branchLabel,
                        parent: m.id,
                        _raw:   b,
                    });
                }
            }
        }
        // Branches whose parent market isn't in the registry (legacy /
        // standalone) — surface them at top level so they don't vanish.
        const marketIds = new Set(markets.map((m) => m.id));
        for (const b of branches) {
            const dot = String(b.id || '').indexOf('.');
            const parentKey = dot > 0 ? b.id.slice(0, dot) : (b.archetype || '');
            if (!marketIds.has(parentKey)) {
                rowsLogical.push({
                    type:   'branch',
                    id:     b.id,
                    label:  b.label || b.id,
                    parent: null,
                    _raw:   b,
                });
            }
        }

        const dtRows = rowsLogical.map((r) => {
            if (r.type === 'market') {
                return [r.label, r.kind, String(r.count), ''];
            }
            return [r.label, '', '', ''];
        });

        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'markets-landing',
            headers: ['Name', 'Kind', 'Branches', ''],
            rows: dtRows,
            pageSize: 50, pagination: true,
            sortable: false,    // sorting would shuffle parents away from children
            filterable: true,
            selectable: true, copyable: true,
            renderCell: (td, value, colIdx, _rowIdx, _rowArr) => {
                const tr = td.parentElement;
                const idx = tr?.__rowIndex ?? _rowIdx;
                const logical = rowsLogical[idx];
                if (!logical) return false;
                if (colIdx === 0) {
                    // Flex lives on an inner div, never on the `<td>`: a
                    // `display:flex` cell drops out of the table's column
                    // model and the body column stops tracking the header
                    // (the old "non-aligned columns" bug).
                    if (logical.type === 'market') {
                        const chev = logical.expanded ? 'expand_more' : 'chevron_right';
                        td.innerHTML = `
                            <div class="twm-market-row twm-market-row--archetype">
                                <button type="button" class="twm-market-chevron"
                                        data-twm-action="toggle"
                                        aria-label="${logical.expanded ? 'Collapse' : 'Expand'}">
                                    <span class="material-symbols-outlined">${chev}</span>
                                </button>
                                <span class="material-symbols-outlined twm-market-row__icon">storefront</span>
                                <span class="twm-market-row__label">${_esc(logical.label)}</span>
                            </div>`;
                        return true;
                    }
                    td.innerHTML = `
                        <div class="twm-market-row twm-market-row--instance">
                            <span class="twm-market-row__indent"></span>
                            <span class="material-symbols-outlined twm-market-row__icon">arrow_right</span>
                            <span class="twm-market-row__label">${_esc(logical.label)}</span>
                        </div>`;
                    return true;
                }
                if (colIdx === 3) {
                    return actionsCellRenderer(3, { edit: false, delete: true })(td, value, colIdx);
                }
                return false;
            },
        });
        table.render();
        teardown = attachLandingTableBehavior(
            host,
            (idx) => rowsLogical[idx],
            {
                open:         (r) => _openRow(r, 'auto'),
                openInTab:    (r) => _openRow(r, 'tab'),
                openInWindow: (r) => _openRow(r, 'window'),
                delete:       (r) => _deleteRow(r),
                toggle:       (r) => _toggleRow(r),
            },
            { buildMenu: _buildRowMenu },
        );
    };

    /** Expand / collapse a market row's branches. Shared by the chevron
     *  button, the right-click menu, and the keyboard shell — all route
     *  here through `attachLandingTableBehavior`. */
    const _toggleRow = (r) => {
        if (r?.type !== 'market') return;
        if (expandedMarkets.has(r.id)) expandedMarkets.delete(r.id);
        else                            expandedMarkets.add(r.id);
        renderTable();
        shell?.refresh?.();
    };

    const _buildRowMenu = (r) => {
        const items = [
            { label: 'Open',               icon: 'open_in_new',  action: 'open' },
            { label: 'Open in new tab',    icon: 'tab',          action: 'open-tab' },
            { label: 'Open in new window', icon: 'open_in_full', action: 'open-window' },
        ];
        if (r.type === 'market') {
            items.push({
                label: r.expanded ? 'Collapse branches' : 'Expand branches',
                icon:  r.expanded ? 'expand_more' : 'chevron_right',
                action: 'toggle',
            });
        }
        items.push({ separator: true });
        items.push({ label: 'Delete', icon: 'delete', action: 'delete', danger: true });
        return items;
    };

    const _openRow = (r, mode = 'auto') => {
        // Routing kinds stay as `market-archetype` / `market` for now —
        // those names are wired into page_stubs and the bridge. The UI
        // rename is presentation-only until a follow-up pass.
        const kind = (r.type === 'market') ? 'market-archetype' : 'market';
        const props = { id: r.id, label: r.label };
        // `mode` maps onto the two-axis nav model: a row opens in the
        // tile it was clicked from (origin), optionally as a new tab, or
        // in a fresh managed window.
        const nav = mode === 'window' ? { dest: 'window' }
                  : mode === 'tab'    ? { dest: 'origin', newTab: true }
                  :                     { dest: 'origin' };
        wm.navigate(kind, props, { ctx, ...nav });
    };

    const _deleteRow = async (r) => {
        const what = r.type === 'market' ? 'market' : 'branch';
        const ok = await openConfirm({
            title: `Delete ${what}`,
            message: `Delete <strong>${_esc(r.label)}</strong>?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            if (r.type === 'market') {
                await api?.market_remove?.(r.id);
            } else {
                // Branch ids are `<market>.<branch>`. Split on the first
                // dot; the bridge endpoint is still called
                // market_instance_remove(market_id, branch_id).
                const dot = String(r.id || '').indexOf('.');
                if (dot < 1) {
                    console.warn('[markets-landing] cannot parse branch id', r.id);
                    return;
                }
                const marketId = r.id.slice(0, dot);
                const branchId = r.id.slice(dot + 1);
                await api?.market_instance_remove?.(marketId, branchId);
            }
        } catch (e) { console.warn(e); }
        await refresh();
        eventBus?.emit?.('ecoagent:project:changed', { source: 'markets-landing' });
    };

    /** Open the unified create form. Gallery picker seeds the initial
     *  shape; the bridge call stays the same (market_add). */
    const onNewMarket = async () => {
        const { openCreateMarketArchetypeForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const ma = await openCreateMarketArchetypeForm({ api, eventBus });
        if (!ma) return;
        await refresh();
    };

    const onNewBranch = async () => {
        const { openCreateMarketInstanceForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const inst = await openCreateMarketInstanceForm({ api, eventBus });
        if (!inst) return;
        await refresh();
    };

    const onProjectChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:project:changed', onProjectChanged);

    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => rowsLogical,
                onActivate:         (r) => _openRow(r, 'auto'),
                onActivateInTab:    (r) => _openRow(r, 'tab'),
                onActivateInWindow: (r) => _openRow(r, 'window'),
                isExpandable: (r) => r?.type === 'market',
                isExpanded:   (r) => r?.type === 'market'
                    && expandedMarkets.has(r.id),
                onExpandToggle: (r, expand) => {
                    if (r?.type !== 'market') return;
                    if (expand) expandedMarkets.add(r.id);
                    else        expandedMarkets.delete(r.id);
                    renderTable();
                    shell?.refresh?.();
                },
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            // Archetype-creation first (the upstream / parent action),
            // branch-creation second (depends on an archetype existing).
            { id: 'new-market', label: 'New market', icon: 'add',
              shortcut: 'N',
              title: 'Define a new market',
              onClick: onNewMarket },
            { id: 'new-branch', label: 'New branch', icon: 'add',
              shortcut: 'B',
              title: 'Add a branch under an existing market',
              onClick: onNewBranch },
            { id: 'market-kinds', label: 'Market kinds', icon: 'category',
              shortcut: 'K',
              title: 'Browse the base market kinds (auction / matching mechanics)',
              onClick: () => wm?.navigate?.('market_kinds', {},
                  { ctx, dest: 'origin' }) },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'Markets',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:project:changed', onProjectChanged);
        },
    };
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function _toArr(p) {
    try {
        const v = await p;
        return Array.isArray(v) ? v : (Array.isArray(v?.items) ? v.items : []);
    } catch { return []; }
}
