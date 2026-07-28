/**
 * asset_kinds_landing.js — top-level "Asset Kinds" page.
 *
 * Same chrome as the SFC / Markets / Scenarios landings: detail
 * header, single DataTable, footer action strip. Row click opens
 * the per-kind editor (Layer 7.1b).
 */

import { DataTable } from '../ui/components/data_table.js';
import {
    attachLandingTableBehavior,
    actionsCellRenderer,
    attachLandingShell,
    mountLandingActions,
    mountLandingShell,
} from './landing_table.js';
import { openConfirm, openForm, openModal } from '../ecoagent/ui/modal.js';
import { toastError } from '../ecoagent/ui/toast.js';
import { mountGalleryPicker } from '../ui/components/gallery_picker.js';


function slugify(s) {
    return String(s || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}


export function mountAssetsLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Assets',
        stats: [{ key: 'count', label: 'count' }],
        pane: {
            key: 'kinds',
            title: 'All asset kinds',
            hint:  '↑↓ navigate · Enter open · click row to open',
        },
    });
    // Inject the kind-filter dropdown after the static stats. The select
    // is bespoke to this landing (per-template grouping with counts),
    // so it stays bespoke — only the surrounding chrome is shared.
    {
        const spacer = _shell.headerEl.querySelector('.ea-detail-header__spacer');
        const wrap = document.createElement('span');
        wrap.className = 'ea-detail-header__field';
        wrap.innerHTML = '<span>kind</span>'
            + '<select data-role="kind-filter"><option value="">all</option></select>';
        _shell.headerEl.insertBefore(wrap, spacer);
    }

    let kinds = [];
    let visible = [];
    let templates = [];
    let kindFilter = '';
    let table = null;
    let teardown = () => {};

    const refresh = async () => {
        try {
            const [k, t] = await Promise.all([
                api?.assets_list?.(),
                api?.asset_templates_list?.(),
            ]);
            kinds = Array.isArray(k) ? k : (Array.isArray(k?.items) ? k.items : []);
            templates = Array.isArray(t) ? t : [];
        } catch { kinds = []; templates = []; }
        rebuildKindFilter();
        applyFilter();
    };

    const rebuildKindFilter = () => {
        const sel = hostEl.querySelector('[data-role="kind-filter"]');
        if (!sel) return;
        // Group by template id; include "(no template)" bucket for kinds
        // without one. Counts come from the unfiltered list.
        const counts = new Map();
        for (const k of kinds) {
            const id = k.template || '';
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        const opts = [`<option value="">all (${kinds.length})</option>`];
        // Templates first (in declared order), then any non-template
        // ids that crept in via legacy data.
        const seen = new Set();
        for (const t of templates) {
            const n = counts.get(t.id) || 0;
            if (n === 0) continue;
            seen.add(t.id);
            opts.push(
                `<option value="${t.id}" ${t.id === kindFilter ? 'selected' : ''}>`
                + `${t.label || t.id} (${n})</option>`,
            );
        }
        for (const [id, n] of counts) {
            if (seen.has(id) || !id) continue;
            opts.push(
                `<option value="${id}" ${id === kindFilter ? 'selected' : ''}>`
                + `${id} (${n})</option>`,
            );
        }
        if (counts.has('')) {
            opts.push(
                `<option value="__none__" ${kindFilter === '__none__' ? 'selected' : ''}>`
                + `(no template) (${counts.get('')})</option>`,
            );
        }
        sel.innerHTML = opts.join('');
    };

    const applyFilter = () => {
        if (!kindFilter) {
            visible = kinds.slice();
        } else if (kindFilter === '__none__') {
            visible = kinds.filter((k) => !k.template);
        } else {
            visible = kinds.filter((k) => k.template === kindFilter);
        }
        _shell.setStat('count', visible.length);
        renderTable();
        shell?.refresh?.();
    };

    const tplLabel = (id) =>
        (templates.find((t) => t.id === id)?.label) || id || '—';

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}
        if (visible.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">'
                + (kinds.length === 0 ? 'No asset kinds yet.'
                                      : 'No asset kinds match this filter.')
                + '</div>';
            return;
        }
        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'asset-kinds-landing',
            headers: ['Name', 'Type', 'Currency', 'Financial',
                      '# props', 'Description', ''],
            rows: visible.map((k) => [
                k.name || k.id,
                tplLabel(k.template),
                k.currency || '(unitless)',
                k.is_financial ? 'yes' : 'no',
                String((k.properties || []).length),
                k.description || '',
                '',
            ]),
            pageSize: 50, pagination: true,
            sortable: true, filterable: true,
            selectable: true, copyable: true,
            renderCell: actionsCellRenderer(6, { edit: false, delete: true }),
        });
        table.render();
        teardown = attachLandingTableBehavior(host,
            (idx) => visible[idx],
            {
                open: (k) => wm.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'origin' }),
                openInTab: (k) => wm.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'origin', newTab: true }),
                openInWindow: (k) => wm.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'window' }),
                delete: async (k) => {
                    const ok = await openConfirm({
                        title: 'Delete asset kind',
                        message: `Delete <strong>${k.name || k.id}</strong>?`
                            + ' Accounts referencing it will become invalid.',
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    try { await api?.asset_remove?.(k.id); }
                    catch (e) { console.warn(e); }
                    await refresh();
                    eventBus?.emit?.('ecoagent:asset_kinds:changed');
                    eventBus?.emit?.('ecoagent:project:changed', { source: 'asset-kinds-landing' });
                },
            });
    };

    /** G2.2 — Asset kinds landing "New asset archetype" flow.
     *
     *  Mirrors the agents landing G2.1 layout: name + description
     *  inputs on top, gallery-picker card grid below. Picking copies
     *  the starter's payload via the `template` kwarg on
     *  asset_add — same path that used to read the legacy
     *  asset_templates list, now sourced from the unified
     *  gallery catalog. */
    const onNewKind = async () => {
        const { openCreateAssetForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const ak = await openCreateAssetForm({ api, eventBus });
        if (!ak) return;
        await refresh();
        wm?.openFromContext(ctx, 'asset_kind', { id: ak.id, label: ak.label });
    };
    hostEl.querySelector('[data-role="kind-filter"]')
        ?.addEventListener('change', (ev) => {
            kindFilter = ev.target.value || '';
            applyFilter();
        });

    const onChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:project:changed', onChanged);
    eventBus?.on?.('ecoagent:asset_kinds:changed', onChanged);

    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows:    () => visible,
                onActivate:         (k) => wm?.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'origin' }),
                onActivateInTab:    (k) => wm?.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'origin', newTab: true }),
                onActivateInWindow: (k) => wm?.navigate('asset_kind',
                    { id: k.id, label: k.name || k.id }, { ctx, dest: 'window' }),
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            { id: 'new-kind', label: 'New asset kind', icon: 'add',
              shortcut: 'N',
              title: 'Create a new asset kind and open its editor',
              onClick: onNewKind },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'Assets',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:project:changed', onChanged);
            eventBus?.off?.('ecoagent:asset_kinds:changed', onChanged);
        },
    };
}
