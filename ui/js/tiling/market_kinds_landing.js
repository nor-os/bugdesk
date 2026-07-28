/**
 * market_kinds_landing.js — top-level "Market kinds" page.
 *
 * The base market types (auction / matching mechanics) the project offers —
 * one per `market/kinds/<snake>.py` (`<Kind>Base(MarketBase)`). Read-only
 * overview so the mechanics are discoverable, not just files; a row opens the
 * kind's class in the editor (same path the file tree uses for a
 * `market/kinds/*.py` leaf — the `market-kind` tab).
 *
 * Same chrome as the Assets / Markets landings (detail header + DataTable).
 */

import { DataTable } from '../ui/components/data_table.js';
import {
    attachLandingTableBehavior,
    attachLandingShell,
    mountLandingShell,
} from './landing_table.js';


export function mountMarketKindsLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Market kinds',
        stats: [{ key: 'count', label: 'count' }],
        pane: {
            key: 'kinds',
            title: 'Auction / matching mechanics',
            hint:  '↑↓ navigate · Enter open · click row to open the class',
        },
    });

    let kinds = [];
    let table = null;
    let teardown = () => {};

    // Open a kind's class file via the same route the file tree uses for a
    // `market/kinds/*.py` leaf (kind `market-kind`, entityId = snake stem).
    const openKind = (k, opts = {}) => {
        const tabs = ctx?.workspaceTabs || wm?.workspaceTabs;
        if (tabs?.openTab) {
            tabs.openTab({
                kind: 'market-kind', entityId: k.snake,
                label: k.label || k.id, icon: 'category',
                preview: !opts.newTab, from: 'market-kinds-landing',
                ...opts,
            });
        } else {
            wm?.navigate?.('market-kind',
                { entityId: k.snake, label: k.label || k.id },
                { ctx, dest: opts.dest || 'origin', newTab: !!opts.newTab });
        }
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch { /* ignore */ }
        if (kinds.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">'
                + 'No market kinds in this project.</div>';
            return;
        }
        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'market-kinds-landing',
            headers: ['Kind', 'Mechanic', 'File'],
            rows: kinds.map((k) => [k.label || k.id, k.mechanic || '', k.path || '']),
            pageSize: 50, pagination: true,
            sortable: true, filterable: true,
            selectable: true, copyable: true,
        });
        table.render();
        teardown = attachLandingTableBehavior(host, (idx) => kinds[idx], {
            open:         (k) => openKind(k),
            openInTab:    (k) => openKind(k, { newTab: true }),
            openInWindow: (k) => openKind(k, { dest: 'window' }),
        });
    };

    const refresh = async () => {
        try {
            const k = await api?.market_kinds_list?.();
            kinds = Array.isArray(k) ? k : (Array.isArray(k?.items) ? k.items : []);
        } catch { kinds = []; }
        _shell.setStat('count', kinds.length);
        renderTable();
        shell?.refresh?.();
    };

    const onChanged = () => { refresh(); };
    eventBus?.on?.('ecoagent:project:changed', onChanged);
    eventBus?.on?.('ecoagent:markets:changed', onChanged);

    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => kinds,
                onActivate:         (k) => openKind(k),
                onActivateInTab:    (k) => openKind(k, { newTab: true }),
                onActivateInWindow: (k) => openKind(k, { dest: 'window' }),
            },
        ],
    });
    refresh().then(() => shell.refresh());

    return {
        destroy() {
            try { teardown(); table?.destroy?.(); } catch { /* ignore */ }
            eventBus?.off?.('ecoagent:project:changed', onChanged);
            eventBus?.off?.('ecoagent:markets:changed', onChanged);
        },
    };
}
