/**
 * kpis_landing.js — top-level "KPIs" page. Same chrome as the SFC,
 * Markets, and Scenarios landings: detail header, single DataTable,
 * footer action strip.
 *
 * Note: the python bridge currently has no `kpis_list` endpoint. We
 * call it defensively (it returns nothing) and show an empty state.
 * Once the bridge exposes KPIs the table will populate without code
 * changes here.
 */

import { DataTable } from '../ui/components/data_table.js';
import {
    attachLandingTableBehavior,
    actionsCellRenderer,
    attachLandingShell,
    mountLandingActions,
    mountLandingShell,
} from './landing_table.js';
import { openConfirm } from '../ecoagent/ui/modal.js';
import { toastWarn, toastError } from '../ecoagent/ui/toast.js';

function slugify(s) {
    return String(s || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}

export function mountKpisLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'KPIs',
        stats: [{ key: 'count', label: 'count' }],
        pane: {
            key: 'kpis',
            title: 'All KPIs',
            hint:  '↑↓ navigate · Enter open · click row to open',
        },
    });

    let kpis = [];
    let table = null;
    let teardown = () => {};

    const refresh = async () => {
        try {
            const res = await api?.kpis_list?.();
            kpis = Array.isArray(res) ? res
                  : Array.isArray(res?.items) ? res.items
                  : [];
        } catch { kpis = []; }
        _shell.setStat('count', kpis.length);
        renderTable();
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}
        if (kpis.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">No KPIs yet.</div>';
            return;
        }
        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'kpis-landing',
            headers: ['Name', 'Country', 'Expression', ''],
            rows: kpis.map((k) => [
                k.label || k.id,
                k.country || 'global',
                k.expression || k.expr || '',
                '',
            ]),
            pageSize: 50, pagination: true,
            sortable: true, filterable: true,
            selectable: true, copyable: true,
            renderCell: actionsCellRenderer(3, { edit: false, delete: true }),
        });
        table.render();
        teardown = attachLandingTableBehavior(host,
            (idx) => kpis[idx],
            {
                open: (k) => wm.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'origin' }),
                openInTab: (k) => wm.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'origin', newTab: true }),
                openInWindow: (k) => wm.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'window' }),
                delete: async (k) => {
                    const ok = await openConfirm({
                        title: 'Delete KPI',
                        message: `Delete <strong>${(k.label || k.id)}</strong>?`,
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    try { await api?.kpi_delete?.(k.id); }
                    catch (e) { console.warn(e); }
                    await refresh();
                    eventBus?.emit?.('ecoagent:project:changed', { source: 'kpis-landing' });
                },
            });
    };

    const onNewKpi = async () => {
        const { openCreateKpiForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const kpi = await openCreateKpiForm({ api, eventBus });
        if (!kpi) return;
        await refresh();
        wm?.openFromContext(ctx, 'kpi',
            { id: kpi.id, label: kpi.label, autoEditTitle: true });
    };
    const onChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:project:changed', onChanged);
    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => kpis,
                onActivate:         (k) => wm?.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'origin' }),
                onActivateInTab:    (k) => wm?.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'origin', newTab: true }),
                onActivateInWindow: (k) => wm?.navigate('kpi',
                    { id: k.id, label: k.label || k.id }, { ctx, dest: 'window' }),
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            { id: 'new-kpi', label: 'New KPI', icon: 'add',
              shortcut: 'N', title: 'Create a new KPI and open its editor',
              onClick: onNewKpi },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'KPIs',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:project:changed', onChanged);
        },
    };
}
