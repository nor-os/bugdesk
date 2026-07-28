/**
 * entity_create_forms.js — single source of truth for every
 * "+ New X" creation dialog in the project.
 *
 * Each `openCreateXForm({ api, eventBus })` function:
 *   1. Checks prerequisites (e.g. New sector needs a country first).
 *   2. Pre-fetches dropdown options (countries, sector kinds, …).
 *   3. Opens the canonical `openForm` modal with the kind-specific fields.
 *   4. Slugs the id from the name, validates.
 *   5. Calls the matching bridge endpoint.
 *   6. Emits `ecoagent:project:changed` (and any kind-specific bus
 *      events) so every other surface (landings, palette, hamburger
 *      menu, object explorer) picks up the new entity.
 *   7. Toasts on success / failure.
 *
 * Returns the created entity record (`{ id, label, … }`) on success,
 * `null` on cancel / validation failure / bridge error. The caller
 * decides what to do with the result — refresh local state, open the
 * new entity in a tab, navigate to it, etc.
 *
 * All callers (the SFC / Agents / Assets / Scenarios / Analytics /
 * KPIs / Markets landings AND the bottom-panel Registries tab's "+ New
 * entity" menu) consume this module so a field change lands in one
 * place. If you find yourself adding a creation dialog elsewhere,
 * extend this module first.
 */

import { openForm, openModal } from './modal.js';
import { toastError, toastInfo } from './toast.js';
import { mountGalleryPicker } from '../../ui/components/gallery_picker.js';


const SECTOR_KIND_FALLBACK = [
    { value: 'firm',         label: 'Firm' },
    { value: 'household',    label: 'Household' },
    { value: 'bank',         label: 'Commercial bank' },
    { value: 'central_bank', label: 'Central bank' },
    { value: 'government',   label: 'Government' },
    { value: 'foreign',      label: 'Foreign' },
    { value: 'non_profit',   label: 'Non-profit' },
];

// ── helpers ──────────────────────────────────────────────────────────

const slug = (s, sep = '_') => String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    .slice(0, 64);

const fire = (eventBus, name, payload) => {
    try { eventBus?.emit?.(name, payload || {}); } catch { /* ignore */ }
};

const projectChanged = (eventBus, domain) =>
    fire(eventBus, 'ecoagent:project:changed',
         { source: 'entity-create-forms', domain });


// ── Sector ───────────────────────────────────────────────────────────

export async function openCreateSectorForm({ api, eventBus } = {}) {
    if (!api) return null;
    let countries = [];
    let kinds = [];
    try { countries = (await api.countries_list?.()) || []; } catch { /* ignore */ }
    try { kinds     = (await api.sector_kinds_list?.()) || []; } catch { /* ignore */ }
    if (countries.length === 0) {
        toastError?.('New sector',
            'Declare a country first (Home → Country setup).');
        return null;
    }
    const kindOpts = (kinds.length ? kinds : SECTOR_KIND_FALLBACK).map((k) =>
        ({ value: k.id ?? k.value, label: k.label || k.id || k.value }));
    const data = await openForm({
        title: 'New sector',
        submitLabel: 'Create',
        fields: [
            { name: 'name', label: 'Name', type: 'text', required: true,
              placeholder: 'e.g. Industrial firms' },
            { name: 'country', label: 'Country', type: 'select',
              default: countries[0].id,
              options: countries.map((c) =>
                  ({ value: c.id, label: c.label || c.id })) },
            { name: 'kind', label: 'Kind', type: 'select',
              default: kindOpts[0]?.value || 'firm', options: kindOpts },
        ],
    });
    if (!data?.name) return null;
    const id = slug(data.name);
    if (!id) { toastError?.('New sector', 'invalid name'); return null; }
    try {
        const res = await api.sector_add?.(id, data.name,
            String(data.kind || 'firm'));
        if (res?.ok === false) {
            toastError?.('New sector', res.error || 'add failed');
            return null;
        }
    } catch (err) {
        toastError?.('New sector', String(err?.message || err));
        return null;
    }
    if (data.country) {
        try {
            await api.sector_update?.(id, null, null, null, null,
                String(data.country));
        } catch (err) { console.warn('sector_update country failed', err); }
    }
    projectChanged(eventBus, 'sector');
    toastInfo?.('New sector', data.name);
    return { id, label: data.name, name: data.name,
             kind: String(data.kind || ''), country: String(data.country || '') };
}


// ── Asset kind ───────────────────────────────────────────────────────
// Gallery-picker creation — same UX as the Assets landing.

export async function openCreateAssetForm({ api, eventBus } = {}) {
    if (!api) return null;
    const picked = await _openGalleryCreateModal({
        kind: 'asset_kind',
        title: 'New asset kind',
        icon:  'category',
        hint:  'Pick a template to seed properties + currency defaults.',
        descriptionField: true,
    });
    if (!picked) return null;
    const { name, description, starter } = picked;
    const starterId = starter?.id || 'generic_financial';
    try {
        const res = await api.asset_add?.({
            name,
            description: description || '',
            template:    starterId,
        });
        if (res?.ok === false) {
            toastError?.('New asset kind', res.error || 'add failed');
            return null;
        }
        projectChanged(eventBus, 'asset_kind');
        fire(eventBus, 'ecoagent:asset_kinds:changed');
        toastInfo?.('New asset kind', name);
        const id = res?.id || slug(name);
        return { id, label: name, name, template: starterId };
    } catch (err) {
        toastError?.('New asset kind', String(err?.message || err));
        return null;
    }
}


// ── Agent archetype ──────────────────────────────────────────────────
// Gallery-picker creation — same UX as the Agents landing.

export async function openCreateArchetypeForm({ api, eventBus } = {}) {
    if (!api) return null;
    const picked = await _openGalleryCreateModal({
        kind: 'agent',
        title: 'New agent archetype',
        icon:  'group',
        hint:  'Pick a starter to seed accounts, attributes, and loop bodies. '
             + 'Blank agent creates an empty shape.',
    });
    if (!picked) return null;
    const { name, starter } = picked;
    const id = slug(name);
    if (!id) { toastError?.('New archetype', 'invalid name'); return null; }
    const starterId = starter?.id || 'blank';
    try {
        // agent_add positional: (key, label, default_sector,
        // population, role, home_currency, is_central, template).
        // The landing's existing call passes nulls for the policy
        // fields and lets the starter define them.
        const res = await api.agent_add?.(
            id, name, null, 1, null, null, false, starterId);
        if (res?.ok === false) {
            toastError?.('New archetype', res.error || 'add failed');
            return null;
        }
    } catch (err) {
        toastError?.('New archetype', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'archetype');
    fire(eventBus, 'ecoagent:archetypes:changed');
    toastInfo?.('New archetype', name);
    return { id, archetype: id, label: name,
             starter: starterId };
}


// ── Market archetype ─────────────────────────────────────────────────
// G2.4 — picks a kind via the unified gallery picker; entries come
// from `starter_gallery.json` (kind="market_kind"), seeded from
// market_kinds.json one-to-one.

export async function openCreateMarketArchetypeForm({ api, eventBus } = {}) {
    if (!api) return null;
    const picked = await _openGalleryCreateModal({
        kind: 'market_kind',
        title: 'New market archetype',
        icon:  'storefront',
        hint:  'Pick a clearing mechanism. Each kind ships its class ' +
               'file under the project’s market_kinds/ directory.',
    });
    if (!picked) return null;
    const { name, starter } = picked;
    const id   = name;
    const kind = starter?.id || 'ContinuousDoubleAuction';
    try {
        const res = await api.market_add?.(id, kind);
        if (res?.ok === false) {
            toastError?.('New market archetype', res.error || 'add failed');
            return null;
        }
    } catch (err) {
        toastError?.('New market archetype', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'market-archetype');
    toastInfo?.('New market archetype', id);
    return { id, label: id, kind };
}


// ── Market instance ──────────────────────────────────────────────────

export async function openCreateMarketInstanceForm({ api, eventBus } = {}) {
    if (!api) return null;
    let archs = [];
    try { archs = (await api.markets_list?.()) || []; }
    catch { /* ignore */ }
    if (!Array.isArray(archs) || archs.length === 0) {
        toastError?.('New market',
            'Declare a market archetype first.');
        return null;
    }
    const archOpts = archs.map((a) =>
        ({ value: a.id, label: a.label || a.id }));
    const data = await openForm({
        title: 'New market instance',
        submitLabel: 'Create',
        fields: [
            { name: 'archetype', label: 'Archetype', type: 'select',
              default: archOpts[0].value, options: archOpts },
            { name: 'instance_id', label: 'Instance id', type: 'text',
              required: true, placeholder: 'e.g. de' },
        ],
    });
    if (!data?.instance_id) return null;
    const instanceId = String(data.instance_id).trim();
    try {
        const res = await api.market_instance_add?.(
            String(data.archetype), instanceId);
        if (res?.ok === false) {
            toastError?.('New market', res.error || 'add failed');
            return null;
        }
    } catch (err) {
        toastError?.('New market', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'market');
    const id = `${data.archetype}.${instanceId}`;
    toastInfo?.('New market', id);
    return { id, label: id, archetype: String(data.archetype),
             instance: instanceId };
}


// ── Scenario ─────────────────────────────────────────────────────────

export async function openCreateScenarioForm({ api, eventBus } = {}) {
    if (!api) return null;
    const data = await openForm({
        title: 'New scenario',
        submitLabel: 'Create',
        fields: [
            { name: 'label', label: 'Name', type: 'text', required: true,
              placeholder: 'e.g. Fiscal stimulus' },
            { name: 'description', label: 'Description (optional)', type: 'text' },
        ],
    });
    if (!data?.label) return null;
    const id = slug(data.label, '-');
    if (!id) { toastError?.('New scenario', 'invalid name'); return null; }
    try {
        await api.scenario_save?.(id, data.label, data.description || '', {});
    } catch (err) {
        toastError?.('New scenario', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'scenario');
    fire(eventBus, 'ecoagent:scenarios:changed');
    toastInfo?.('New scenario', data.label);
    return { id, label: data.label,
             description: data.description || '' };
}


// ── Dashboard ────────────────────────────────────────────────────────

export async function openCreateDashboardForm({ api, eventBus } = {}) {
    if (!api) return null;
    const data = await openForm({
        title: 'New dashboard',
        submitLabel: 'Create',
        fields: [
            { name: 'label', label: 'Name', type: 'text', required: true,
              placeholder: 'e.g. Macro overview' },
        ],
    });
    if (!data?.label) return null;
    const id = slug(data.label, '-');
    if (!id) { toastError?.('New dashboard', 'invalid name'); return null; }
    try {
        await api.analytics_dashboard_save?.(id, data.label, [], null);
    } catch (err) {
        toastError?.('New dashboard', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'dashboard');
    toastInfo?.('New dashboard', data.label);
    return { id, label: data.label };
}


// ── Gallery-picker modal (shared by asset_kind / archetype) ──

/** Open a name + (optional) description + gallery-picker modal and
 *  return `{ name, description, starter }` on Create, `null` on
 *  cancel. The gallery picker is mounted as a child of the modal
 *  body; `kind` keys into the gallery catalogue (`asset_kind`,
 *  `agent`). */
async function _openGalleryCreateModal({
    kind, title, icon, hint, descriptionField = false,
}) {
    const body = document.createElement('div');
    body.className = 'ea-new-archetype__body';
    body.innerHTML = `
        <label class="ea-new-archetype__name">
            <span>Name</span>
            <input type="text" data-role="name"
                   placeholder="e.g. Wind farm operator">
        </label>
        ${descriptionField ? `
            <label class="ea-new-archetype__name">
                <span>Description</span>
                <textarea data-role="description" rows="2"
                          placeholder="What does this represent? (optional)"></textarea>
            </label>
        ` : ''}
        <p class="ea-new-archetype__hint">${_esc(hint || '')}</p>
        <div class="ea-new-archetype__picker" data-role="picker"></div>
    `;
    let picked = null;
    const pickerHost = body.querySelector('[data-role="picker"]');
    const handle = await mountGalleryPicker(pickerHost, {
        kind,
        selectedId: 'blank',
        onChange: (entry) => { picked = entry; },
    });
    requestAnimationFrame(() => {
        body.querySelector('[data-role="name"]')?.focus();
    });
    const action = await openModal({
        title, icon, content: body,
        width: 560, height: 520,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Create', value: 'create', primary: true },
        ],
    });
    try { handle.dispose(); } catch { /* ignore */ }
    if (action !== 'create') return null;
    const name = String(body.querySelector('[data-role="name"]').value || '').trim();
    if (!name) {
        toastError?.(title, 'Name is required.');
        return null;
    }
    const description = descriptionField
        ? String(body.querySelector('[data-role="description"]')?.value || '').trim()
        : '';
    return { name, description, starter: picked };
}


function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}


// ── KPI ──────────────────────────────────────────────────────────────

export async function openCreateKpiForm({ api, eventBus } = {}) {
    if (!api) return null;
    if (typeof api.kpi_save !== 'function') {
        toastError?.('KPI creation unavailable',
            'The python bridge has no `kpi_save` endpoint.');
        return null;
    }
    let existing = [];
    try { existing = (await api.kpis_list?.()) || []; } catch { /* ignore */ }
    const used = new Set(existing.map((k) => k.id));
    const data = await openForm({
        title: 'New KPI',
        submitLabel: 'Create',
        fields: [
            { name: 'label', label: 'Name', type: 'text', required: true,
              placeholder: 'e.g. Inflation rate' },
            { name: 'expression', label: 'Expression', type: 'text',
              placeholder: 'e.g. cpi.change(1)',
              hint: 'Evaluated each tick. Edit later in the KPI editor.' },
        ],
    });
    if (!data?.label) return null;
    let id = slug(data.label);
    if (!id) { id = 'kpi'; }
    if (used.has(id)) {
        // Disambiguate with a numeric suffix rather than failing.
        let n = 2;
        while (used.has(`${id}_${n}`) && n < 999) n++;
        id = `${id}_${n}`;
    }
    try {
        const res = await api.kpi_save?.(id, data.label, null, 'ratio',
            '', String(data.expression || '0.0'), null, '');
        if (res?.ok === false) {
            toastError?.('New KPI', res.error || 'add failed');
            return null;
        }
    } catch (err) {
        toastError?.('New KPI', String(err?.message || err));
        return null;
    }
    projectChanged(eventBus, 'kpi');
    toastInfo?.('New KPI', data.label);
    return { id, label: data.label,
             expression: String(data.expression || '') };
}
