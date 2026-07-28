/**
 * scenarios_landing.js — top-level "Scenarios" page. Same chrome as the
 * SFC and Markets landings: detail header with counts, single DataTable
 * pane of scenarios, footer action strip.
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

export function mountScenariosLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Scenarios',
        stats: [
            { key: 'active-name', label: 'active', initial: '—' },
            { key: 'count',       label: 'count' },
        ],
        pane: {
            key: 'scenarios',
            title: 'All scenarios',
            hint:  '↑↓ navigate · Enter open · click row to open',
        },
    });

    let scenarios = [];
    let activeId = null;
    let table = null;
    let teardown = () => {};

    const refresh = async () => {
        try {
            const res = await api?.scenarios_list?.();
            scenarios = Array.isArray(res?.scenarios) ? res.scenarios
                       : Array.isArray(res) ? res : [];
            activeId = res?.active_id || res?.active || null;
        } catch (err) {
            console.warn('[scenarios-landing] list failed', err);
            scenarios = [];
        }
        _shell.setStat('count', scenarios.length);
        const active = scenarios.find((s) => s.id === activeId);
        _shell.setStat('active-name', active?.label || active?.id || '—');
        renderTable();
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}
        if (scenarios.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">No scenarios yet.</div>';
            return;
        }
        host.innerHTML = '';
        table = new DataTable(host, {
            // v2: dropped the leading ★ active-marker column (empty unless a
            // non-Baseline scenario is active; the active one is already
            // named in the header stat). Bumped key so old 4-column widths
            // don't misalign onto the 3-column layout.
            persistKey: 'scenarios-landing-v2',
            headers: ['Name', 'Description', ''],
            rows: scenarios.map((s) => [
                s.label || s.id,
                s.description || '',
                '',
            ]),
            pageSize: 50, pagination: true,
            sortable: true, filterable: true,
            selectable: true, copyable: true,
            renderCell: actionsCellRenderer(2, { edit: true, delete: true }),
        });
        table.render();
        teardown = attachLandingTableBehavior(host,
            (idx) => scenarios[idx],
            {
                open: (s) => wm.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'origin' }),
                openInTab: (s) => wm.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'origin', newTab: true }),
                openInWindow: (s) => wm.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'window' }),
                edit: async (s) => {
                    const data = await openForm({
                        title: 'Rename scenario',
                        fields: [
                            { name: 'label', label: 'Name', type: 'text', required: true },
                            { name: 'description', label: 'Description', type: 'text' },
                        ],
                        defaults: { label: s.label || s.id, description: s.description || '' },
                        submitLabel: 'Save',
                    });
                    if (!data?.label) return;
                    try {
                        await api?.scenario_save?.(s.id, data.label, data.description || '', {});
                        eventBus?.emit?.('ecoagent:scenarios:changed', {});
                        eventBus?.emit?.('ecoagent:project:changed', { source: 'scenarios-landing' });
                    } catch (e) { console.warn(e); }
                    await refresh();
                },
                delete: async (s) => {
                    const ok = await openConfirm({
                        title: 'Delete scenario',
                        message: `Delete <strong>${_esc(s.label || s.id)}</strong>?`,
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    try {
                        await api?.scenario_delete?.(s.id);
                        eventBus?.emit?.('ecoagent:scenarios:changed', {});
                        eventBus?.emit?.('ecoagent:project:changed', { source: 'scenarios-landing' });
                    } catch (e) { console.warn(e); }
                    await refresh();
                },
            });
    };

    const onNewScenario = async () => {
        const { openCreateScenarioForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const sc = await openCreateScenarioForm({ api, eventBus });
        if (!sc) return;
        await refresh();
        wm.openFromContext(ctx, 'scenario', { id: sc.id, label: sc.label });
    };

    const onChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:scenarios:changed', onChanged);
    eventBus?.on?.('ecoagent:project:changed', onChanged);

    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => scenarios,
                onActivate:         (s) => wm?.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'origin' }),
                onActivateInTab:    (s) => wm?.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'origin', newTab: true }),
                onActivateInWindow: (s) => wm?.navigate('scenario',
                    { id: s.id, label: s.label || s.id }, { ctx, dest: 'window' }),
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            { id: 'new-scenario', label: 'New scenario', icon: 'add',
              shortcut: 'N', title: 'Create a new scenario',
              onClick: onNewScenario },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'Scenarios',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:scenarios:changed', onChanged);
            eventBus?.off?.('ecoagent:project:changed', onChanged);
        },
    };
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
