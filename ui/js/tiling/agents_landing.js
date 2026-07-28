/**
 * agents_landing.js — top-level "Agents" page.
 *
 * Two levels only (was three): agent (blueprint, was "archetype") and
 * variation (inheritor with overrides). Instance management moved off
 * this surface — instances are spawned/edited from the agent's own
 * Population sub-tab, not here.
 *
 * Layout mirrors `markets_landing`: collapsible tree, parent rows
 * expand to show their variations, Left/Right collapse via the shell
 * keymap. Variation rows surface a deviation chip + a "Contract"
 * button that opens a ManagedWindow with the full overrides + contract
 * health breakdown.
 */

import { DataTable } from '../ui/components/data_table.js';
import { openForm, openConfirm, openModal } from '../ecoagent/ui/modal.js';
import { mountGalleryPicker } from '../ui/components/gallery_picker.js';
import { toastError } from '../ecoagent/ui/toast.js';
import { ManagedWindow } from '../ui/components/managed_window.js';
import {
    attachLandingTableBehavior,
    attachLandingShell,
    mountLandingActions,
    mountLandingShell,
} from './landing_table.js';

export function mountAgentsLanding(hostEl, _props, ctx) {
    const wm = ctx?.wm;
    const eventBus = ctx?.eventBus;
    const api = window.pywebview?.api;

    const _shell = mountLandingShell(hostEl, {
        title: 'Agents',
        stats: [
            { key: 'hdr-agents', label: 'kinds' },
            { key: 'hdr-vars',   label: 'agents' },
        ],
        pane: {
            key: 'agents',
            title: 'Agent kinds & agents',
            hint:  '↑↓ navigate · ←→ collapse / expand · Enter open',
        },
    });

    let agents = [];                 // top-level blueprints (was agents_list).
    let variationsByAgent = {};      // agent.id → list of variation entries.
    let rowsLogical = [];            // flat list with .type ('agent' | 'variation').
    let table = null;
    let teardown = () => {};
    let entriesCache = [];           // unified registry list, for parent lookup.
    let implCache = new Map();       // `${kind}:${id}` → implementation_percent dict.
    const expandedAgents = new Set();

    const refresh = async () => {
        try {
            const [allArchs, entries] = await Promise.all([
                _toArr(api?.agents_list?.()),
                _toArr(api?.registry_list?.()),
            ]);
            entriesCache = entries;
            // V1 — variations are archetypes with `parent` set. Split
            // the agents_list into base archetypes (top-level rows)
            // and variations (grouped under their parent).
            agents = [];
            variationsByAgent = {};
            for (const a of (allArchs || [])) {
                const parentKey = String(a?.parent || '').trim();
                if (parentKey) {
                    (variationsByAgent[parentKey]
                        = variationsByAgent[parentKey] || []).push(a);
                } else {
                    agents.push(a);
                }
            }
            // Pre-fetch implementation percentages for variations so the
            // table can render deviation chips synchronously. Cache by
            // (kind, id) — stable until next refresh.
            implCache = new Map();
            const fetches = [];
            for (const list of Object.values(variationsByAgent)) {
                for (const v of list) {
                    fetches.push(
                        api?.implementation_percent?.('archetype', v.archetype)
                            .then((res) => {
                                if (res?.ok !== false) {
                                    implCache.set(`archetype:${v.archetype}`, res);
                                }
                            })
                            .catch(() => {}),
                    );
                }
            }
            await Promise.all(fetches);
        } catch (err) {
            console.warn('[agents-landing] refresh failed', err);
        }
        const totalVars = Object.values(variationsByAgent)
            .reduce((n, list) => n + list.length, 0);
        _shell.setStat('hdr-agents', agents.length);
        _shell.setStat('hdr-vars', totalVars);
        renderTable();
    };

    const renderTable = () => {
        const host = _shell.tableHost;
        if (!host) return;
        try { teardown(); table?.destroy?.(); } catch {}

        if (agents.length === 0) {
            host.innerHTML = '<div class="ea-table__empty">No agents yet.</div>';
            return;
        }

        // Build logical row list — agents followed by their variations
        // when expanded. Matches markets_landing structure 1:1 so the
        // tree-shell behaviour (Left/Right collapse) works the same.
        rowsLogical = [];
        for (const a of agents) {
            const vars = variationsByAgent[a.archetype] || [];
            const expanded = expandedAgents.has(a.archetype);
            rowsLogical.push({
                type: 'agent',
                id: a.archetype,
                label: a.label || a.archetype,
                role: a.role || '',
                sector: a.default_sector || a.sector_id || '',
                vCount: vars.length,
                expanded,
                _raw: a,
            });
            if (expanded) {
                for (const v of vars) {
                    rowsLogical.push({
                        type: 'variation',
                        id: v.archetype,
                        label: v.label || v.archetype,
                        parent: a.archetype,
                        _raw: v,
                    });
                }
            }
        }

        const dtRows = rowsLogical.map((r) => {
            if (r.type === 'agent') {
                return [r.label, r.role, r.sector, ''];
            }
            return [r.label, '', '', ''];
        });

        host.innerHTML = '';
        table = new DataTable(host, {
            persistKey: 'agents-landing',
            headers: ['Name', 'Role', 'Sector', 'Notes'],
            rows: dtRows,
            pageSize: 100, pagination: true,
            sortable: false,    // tree-rows must stay parent → children.
            filterable: true,
            selectable: true, copyable: true,
            renderCell: (td, _value, colIdx, _rowIdx) => {
                const tr = td.parentElement;
                const idx = tr?.__rowIndex ?? _rowIdx;
                const logical = rowsLogical[idx];
                if (!logical) return false;
                if (colIdx === 0) return _renderNameCell(td, logical);
                if (colIdx === 3) return _renderNotesCell(td, logical);
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
                contract:     (r) => _openContractWindow(r),
            },
            { buildMenu: _buildRowMenu },
        );
    };

    // Flex lives on an inner div, never on the `<td>` itself: a
    // `display:flex` cell drops out of the table's column-sizing model
    // and the body column stops tracking the header column (the old
    // "non-aligned columns" bug). The `<td>` stays a plain table-cell.
    const _renderNameCell = (td, logical) => {
        if (logical.type === 'agent') {
            const chev = logical.expanded ? 'expand_more' : 'chevron_right';
            const hasChildren = (logical.vCount || 0) > 0;
            td.innerHTML = `
                <div class="twm-market-row twm-market-row--archetype">
                    <button type="button" class="twm-market-chevron"
                            data-twm-action="toggle"
                            ${hasChildren ? '' : 'disabled'}
                            aria-label="${logical.expanded ? 'Collapse' : 'Expand'}">
                        <span class="material-symbols-outlined">${hasChildren ? chev : 'remove'}</span>
                    </button>
                    <span class="material-symbols-outlined twm-market-row__icon">precision_manufacturing</span>
                    <span class="twm-market-row__label">${_esc(logical.label)}</span>
                    ${logical.vCount > 0
                        ? `<span class="twm-market-row__count">${logical.vCount}</span>`
                        : ''}
                </div>`;
            return true;
        }
        td.innerHTML = `
            <div class="twm-market-row twm-market-row--instance">
                <span class="twm-market-row__indent"></span>
                <span class="material-symbols-outlined twm-market-row__icon">fork_right</span>
                <span class="twm-market-row__label">${_esc(logical.label)}</span>
            </div>`;
        return true;
    };

    const _renderNotesCell = (td, logical) => {
        if (logical.type !== 'variation') {
            // Agents (blueprint rows) — no deviation, no overrides to
            // show. Inline delete only.
            td.innerHTML = `
                <div class="ea-agents-landing__notes">
                    <button type="button" class="ea-icon-btn" data-twm-action="delete"
                            title="Delete agent">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>`;
            return true;
        }
        // Variation — deviation % chip + Contract button (opens managed
        // window with overrides + contract health). Falls back gracefully
        // when implementation_percent didn't return.
        const impl = implCache.get(`archetype:${logical.id}`);
        const pct  = impl?.has_parent ? Number(impl.percent || 0) : null;
        const hue  = pct == null ? 0 : Math.max(0, Math.min(120, Math.round(pct * 1.2)));
        const dev  = pct == null ? '—' : `${100 - pct}%`;
        const colour = pct == null ? 'var(--ea-text-muted)' : `hsl(${hue} 65% 50%)`;
        td.innerHTML = `
            <div class="ea-agents-landing__notes">
                <span class="ea-agents-landing__dev-chip"
                      style="color: ${colour}"
                      title="${impl ? `${impl.attrs_implemented}/${impl.attrs_total} parent attributes carried` : ''}">
                    ${_esc(dev)} <span class="ea-agents-landing__dev-label">deviation</span>
                </span>
                <button type="button" class="ea-icon-btn" data-twm-action="contract"
                        title="Open contract detail (overrides + inheritance)">
                    <span class="material-symbols-outlined">checklist</span>
                </button>
                <button type="button" class="ea-icon-btn" data-twm-action="delete"
                        title="Delete agent">
                    <span class="material-symbols-outlined">delete</span>
                </button>
            </div>`;
        return true;
    };

    /** Expand / collapse an agent (blueprint) row's variations. Shared
     *  by the chevron button, the right-click menu, and the keyboard
     *  shell — all route here through `attachLandingTableBehavior`. */
    const _toggleRow = (r) => {
        if (r?.type !== 'agent') return;
        if (expandedAgents.has(r.id)) expandedAgents.delete(r.id);
        else                          expandedAgents.add(r.id);
        renderTable();
        shell?.refresh?.();
    };

    /** Right-click menu for a row — Open variants, conditional
     *  expand/collapse + contract entries, then Delete. Each item's
     *  `action` is dispatched by the shared helper. */
    const _buildRowMenu = (r) => {
        const items = [
            { label: 'Open',               icon: 'open_in_new',  action: 'open' },
            { label: 'Open in new tab',    icon: 'tab',          action: 'open-tab' },
            { label: 'Open in new window', icon: 'open_in_full', action: 'open-window' },
        ];
        if (r.type === 'agent' && (r.vCount || 0) > 0) {
            items.push({
                label: r.expanded ? 'Collapse agents' : 'Expand agents',
                icon:  r.expanded ? 'expand_more' : 'chevron_right',
                action: 'toggle',
            });
        }
        if (r.type === 'variation') {
            items.push({ label: 'Contract detail', icon: 'checklist',
                         action: 'contract' });
        }
        items.push({ separator: true });
        items.push({ label: 'Delete', icon: 'delete',
                     action: 'delete', danger: true });
        return items;
    };

    const _openRow = (r, target = 'auto') => {
        const props = { id: r.id, label: r.label };
        wm?.navigate?.('agent', props, { ctx, target });
    };

    const _deleteRow = async (r) => {
        if (r.type === 'agent') {
            const ok = await openConfirm({
                title: 'Delete agent',
                message: `Delete <strong>${_esc(r.label)}</strong>?`,
                confirmLabel: 'Delete', danger: true,
            });
            if (!ok) return;
            try { await api?.agent_remove?.(r.id); }
            catch (e) { console.warn(e); }
            await refresh();
            eventBus?.emit?.('ecoagent:project:changed', { source: 'agents-landing' });
            return;
        }
        const ok = await openConfirm({
            title: 'Delete agent',
            message: `Delete agent <strong>${_esc(r.label)}</strong>?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        // V1 — variations are archetypes (with `parent` set), so they
        // delete through the same path as a regular archetype.
        try { await api?.agent_remove?.(r.id); }
        catch (e) { console.warn(e); }
        await refresh();
        eventBus?.emit?.('ecoagent:project:changed', { source: 'agents-landing' });
    };

    /** Variation → ManagedWindow showing the contract diff against its
     *  parent: overrides, inherited attributes, implementation %. This
     *  is the "long-awaited contract managed window" — variations have
     *  a button in the Notes column, instances inherit it via the
     *  Relationships sub-tab on the parent agent. */
    const _openContractWindow = (r) => {
        if (r.type !== 'variation') return;
        // A concrete agent is registry kind `agent` (vocabulary step 2).
        const variation = entriesCache.find(
            (e) => e.entity_kind === 'agent' && e.id === r.id);
        const parentRef = String(variation?.parent || '');
        const [pk, pid] = parentRef.split(':', 2);
        const parent = entriesCache.find(
            (e) => e.entity_kind === pk && e.id === pid);
        const impl = implCache.get(`agent:${r.id}`);

        // Per-attribute breakdown: every name from parent OR child;
        // diff value/type when both sides declare it; flag overrides.
        const names = new Set();
        for (const a of (parent?.attributes  || [])) if (a?.name) names.add(a.name);
        for (const a of (variation?.attributes || [])) if (a?.name) names.add(a.name);
        const rows = [...names].sort().map((name) => {
            const p = (parent?.attributes    || []).find((a) => a.name === name);
            const v = (variation?.attributes || []).find((a) => a.name === name);
            const pVal = p ? ((p.value ?? p.default) ?? null) : null;
            const vVal = v ? ((v.value ?? v.default) ?? null) : null;
            const overridden = !!v
                && (vVal !== null && vVal !== undefined)
                && String(vVal) !== String(pVal ?? '');
            return { name, parent: p, variation: v, pVal, vVal, overridden };
        });
        const overrides = rows.filter((r) => r.overridden);

        const body = document.createElement('div');
        body.className = 'ea-contract-detail';
        body.style.cssText = 'padding: 12px; overflow: auto; height: 100%;';
        const pct  = impl?.has_parent ? Number(impl.percent || 0) : null;
        const hue  = pct == null ? 0 : Math.max(0, Math.min(120, Math.round(pct * 1.2)));
        const summaryLine = impl?.has_parent
            ? `<span style="color: hsl(${hue} 65% 50%)">${pct}%</span> of `
                + `${impl.attrs_total} required parent attribute`
                + `${impl.attrs_total === 1 ? '' : 's'} carried`
                + ` (${overrides.length} overridden, `
                + `${impl.attrs_implemented - overrides.length} pass-through).`
            : 'No parent declared — every attribute is owned by this entry.';

        const attrRowsHtml = rows.map((r) => {
            const cls = !r.parent ? 'is-extra'
                      : !r.variation ? 'is-inherited'
                      : r.overridden ? 'is-mismatch' : 'is-ok';
            const declared = r.parent?.type || '—';
            const pCell = r.parent
                ? `<code>${_esc(String(r.pVal ?? ''))}</code>`
                : '<span class="ea-contract-detail__none">— (own)</span>';
            const vCell = r.overridden
                ? `<code>${_esc(String(r.vVal ?? ''))}</code>`
                : (r.variation
                    ? '<span class="ea-contract-detail__none">— (inherited)</span>'
                    : '<span class="ea-contract-detail__none">— (missing)</span>');
            return `
                <tr class="${cls}">
                    <td><code>${_esc(r.name)}</code>${
                        r.parent?.required ? ' <span class="ea-contract-detail__req">required</span>' : ''
                    }</td>
                    <td><code>${_esc(declared)}</code></td>
                    <td>${pCell}</td>
                    <td>${vCell}</td>
                </tr>`;
        }).join('');

        body.innerHTML = `
            <p class="ea-contract-detail__hint">
                Variation <code>${_esc(r.label)}</code> against
                <code>${_esc(parent?.label || pid || '?')}</code>.
                ${summaryLine}
            </p>
            <table class="ea-contract-detail__table">
                <thead><tr>
                    <th>Attribute</th>
                    <th>Type</th>
                    <th>Kind default</th>
                    <th>Agent value</th>
                </tr></thead>
                <tbody>${attrRowsHtml || '<tr><td colspan="4">'
                    + 'No attributes on either side.</td></tr>'}</tbody>
            </table>
            ${impl?.has_parent && impl.methods_total > 0
                ? `<p class="ea-contract-detail__verdict ${
                    impl.methods_complete
                        ? 'ea-contract-detail__verdict--ok'
                        : 'ea-contract-detail__verdict--fail'}">
                    ${impl.methods_complete ? '✓' : '✗'} Methods:
                    ${impl.methods_implemented}/${impl.methods_total}
                    required signatures present.
                </p>` : ''}
        `;

        const win = new ManagedWindow({
            id: `variation-contract-${r.id}`,
            title: `Contract — ${r.label} (agent of ${parent?.label || pid || '?'})`,
            icon: 'checklist',
            content: body,
            defaultWidth: 760,
            defaultHeight: 560,
            minWidth: 520,
            minHeight: 360,
            canMaximize: true,
            canResize: true,
        });
        win.show();
    };

    /** G2.1 — gallery picker, name field. Renamed from "New archetype"
     *  to "New agent" to match the user's mental model: the top level
     *  on this page IS the agent blueprint, not a separate archetype. */
    const onNewAgent = async () => {
        const { openCreateArchetypeForm } = await import(
            '../ecoagent/ui/entity_create_forms.js');
        const arch = await openCreateArchetypeForm({ api, eventBus });
        if (!arch) return;
        await refresh();
    };

    /** V1 — create a variation of an existing agent. The variation is
     *  an archetype with a `parent` field; the bridge copies the
     *  parent's accounts + loop bodies + params + role + currency, and
     *  the user authors attribute overrides on the resulting editor. */
    const onNewVariation = async () => {
        if (!Array.isArray(agents) || agents.length === 0) {
            toastError('New agent', 'Define an agent kind first.');
            return;
        }
        const archOpts = agents.map((a) => ({
            value: a.archetype, label: a.label || a.archetype,
        }));
        const data = await openForm({
            title: 'New agent',
            submitLabel: 'Create',
            fields: [
                { name: 'archetype', label: 'Of kind', type: 'select',
                  required: true, default: archOpts[0].value,
                  options: archOpts,
                  hint: 'The agent inherits this kind\'s attributes.' },
                { name: 'name', label: 'Name', type: 'text', required: true,
                  placeholder: 'e.g. Frugal household' },
            ],
        });
        if (!data?.name) return;
        const id = String(data.name).trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!id) { toastError('New agent', 'invalid name'); return; }
        try {
            // agent_add(key, label, default_sector, population,
            //               role, home_currency, is_central, template,
            //               parent). Pass null for sector/role/etc to
            //               inherit from parent; the bridge resolves.
            const res = await api?.agent_add?.(
                id, data.name, null, 1, null, null, false, null,
                String(data.archetype),
            );
            if (res?.ok === false) {
                toastError('New agent', res.error || 'add failed');
                return;
            }
        } catch (err) {
            toastError('New agent', String(err?.message || err));
            return;
        }
        // Expand the parent so the new variation is visible in the tree.
        expandedAgents.add(String(data.archetype));
        await refresh();
        eventBus?.emit?.('ecoagent:project:changed', { source: 'agents-landing' });
        wm?.openFromContext?.(ctx, 'agent', { id, label: data.name });
    };

    const onProjectChanged = () => { refresh().then(() => shell?.refresh?.()); };
    eventBus?.on?.('ecoagent:project:changed', onProjectChanged);
    eventBus?.on?.('ecoagent:archetypes:changed', onProjectChanged);

    const shell = attachLandingShell(hostEl, {
        panes: [
            {
                paneEl: _shell.paneEl,
                getRows: () => rowsLogical,
                onActivate:         (r) => _openRow(r, 'auto'),
                onActivateInTab:    (r) => _openRow(r, 'tab'),
                onActivateInWindow: (r) => _openRow(r, 'window'),
                isExpandable: (r) => r?.type === 'agent' && (r.vCount || 0) > 0,
                isExpanded:   (r) => r?.type === 'agent'
                    && expandedAgents.has(r.id),
                onExpandToggle: (r, expand) => {
                    if (r?.type !== 'agent') return;
                    if (expand) expandedAgents.add(r.id);
                    else        expandedAgents.delete(r.id);
                    renderTable();
                    shell?.refresh?.();
                },
            },
        ],
    });
    const actions = mountLandingActions(
        _shell.footerEl,
        [
            { id: 'new-agent',     label: 'New agent kind', icon: 'add',
              shortcut: 'N',
              title: 'Define a new agent kind (abstract blueprint)',
              onClick: onNewAgent },
            { id: 'new-variation', label: 'New agent', icon: 'fork_right',
              shortcut: 'V',
              title: 'Create an agent of an existing kind',
              onClick: onNewVariation },
        ],
        hostEl,
    );
    refresh().then(() => shell.refresh());
    return {
        title: 'Agents',
        destroy: () => {
            try { teardown(); } catch {}
            try { shell.teardown(); } catch {}
            try { actions.teardown(); } catch {}
            eventBus?.off?.('ecoagent:project:changed', onProjectChanged);
            eventBus?.off?.('ecoagent:archetypes:changed', onProjectChanged);
        },
    };
}

async function _toArr(p) {
    try {
        const v = await p;
        return Array.isArray(v) ? v : (Array.isArray(v?.items) ? v.items : []);
    } catch { return []; }
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
