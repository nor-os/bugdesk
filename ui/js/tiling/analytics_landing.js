/**
 * analytics_landing.js — top-level "Analytics" page. Same SFC-landing
 * chrome: detail header with stats, single DataTable of dashboards,
 * footer action strip. Currently the backend only exposes dashboards
 * via `analytics_dashboards_list`; KPIs / runs are reachable from
 * their own top-bar shortcuts.
 */

import { DataTable } from '../ui/components/data_table.js';
import { openForm, openConfirm } from '../ecoagent/ui/modal.js';
import {
    attachLandingTableBehavior,
    actionsCellRenderer,
    attachLandingShell,
    mountLandingActions,
    mountLandingShell,
} from './landing_table.js';

export function mountAnalyticsLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Analytics',
        stats: [
            { key: 'hdr-dashboards', label: 'dashboards' },
            { key: 'hdr-runs',       label: 'runs' },
        ],
        pane: {
            key: 'dashboards',
            title: 'Dashboards',
            hint:  '↑↓ navigate · Enter open · click row to open',
        },
    });

    let dashboards = [];
    let table = null;
    let teardown = () => {};

    const setStat = (key, n) => _shell.setStat(`hdr-${key}`, n);

    const refresh = async () => {
        try {
            const [d, runs] = await Promise.all([
                _toArr(api?.analytics_dashboards_list?.()),
                _toArr(api?.analytics_runs_list?.()),
            ]);
            dashboards = d;
            setStat('dashboards', dashboards.length);
            setStat('runs', runs.length);
        } catch (err) {
            console.warn('[analytics-landing] refresh failed', err);
        }
        renderTable();
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}
        if (dashboards.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">No dashboards yet.</div>';
            return;
        }
        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'analytics-landing',
            headers: ['Name', 'Description', ''],
            rows: dashboards.map((d) => [
                d.label || d.id,
                d.description || '',
                '',
            ]),
            pageSize: 50, pagination: true,
            sortable: true, filterable: true,
            selectable: true, copyable: true,
            renderCell: actionsCellRenderer(2, { edit: true, delete: true }),
        });
        table.render();
        teardown = attachLandingTableBehavior(host,
            (idx) => dashboards[idx],
            {
                open: (d) => wm.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'origin' }),
                openInTab: (d) => wm.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'origin', newTab: true }),
                openInWindow: (d) => wm.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'window' }),
                edit: async (d) => {
                    const data = await openForm({
                        title: 'Rename dashboard',
                        fields: [
                            { name: 'label', label: 'Name', type: 'text', required: true },
                            { name: 'description', label: 'Description', type: 'text' },
                        ],
                        defaults: { label: d.label || d.id, description: d.description || '' },
                        submitLabel: 'Save',
                    });
                    if (!data?.label) return;
                    try {
                        await api?.analytics_dashboard_save?.(
                            d.id, data.label, [], data.description || null);
                    } catch (e) { console.warn(e); }
                    await refresh();
                    eventBus?.emit?.('ecoagent:project:changed', { source: 'analytics-landing' });
                },
                delete: async (d) => {
                    const ok = await openConfirm({
                        title: 'Delete dashboard',
                        message: `Delete <strong>${(d.label || d.id)}</strong>?`,
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    try { await api?.analytics_dashboard_delete?.(d.id); }
                    catch (e) { console.warn(e); }
                    await refresh();
                    eventBus?.emit?.('ecoagent:project:changed', { source: 'analytics-landing' });
                },
            });
    };

    const onNewDashboard = async () => {
        const { openCreateDashboardForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const dash = await openCreateDashboardForm({ api, eventBus });
        if (!dash) return;
        await refresh();
        wm.openFromContext(ctx, 'dashboard', { id: dash.id, label: dash.label });
    };

    const onChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:project:changed', onChanged);
    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => dashboards,
                onActivate:         (d) => wm?.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'origin' }),
                onActivateInTab:    (d) => wm?.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'origin', newTab: true }),
                onActivateInWindow: (d) => wm?.navigate('dashboard',
                    { id: d.id, label: d.label || d.id }, { ctx, dest: 'window' }),
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            { id: 'new-dashboard', label: 'New dashboard', icon: 'add',
              shortcut: 'N', title: 'Create a new dashboard',
              onClick: onNewDashboard },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'Analytics',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:project:changed', onChanged);
        },
    };
}

async function _toArr(p) {
    try {
        const v = await p;
        return Array.isArray(v) ? v : (Array.isArray(v?.items) ? v.items : []);
    } catch { return []; }
}
