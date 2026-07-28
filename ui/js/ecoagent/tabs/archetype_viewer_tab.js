/**
 * archetype_viewer_tab.js — read-only viewer for any registry entry.
 *
 * Layer 8.J4 / 8.N1 — when the user clicks a row in the Archetypes
 * landing for an entity_kind that doesn't have a dedicated editor
 * (asset_kind_template, archetype_template, market_kind, sector_kind),
 * route here. Surfaces:
 *
 *   - Definition: About / Inherits from / Attributes / Required methods
 *   - Relationships: out-refs + inverse refs as a DataTable, each
 *     inverse row carries a contract-OK check (does the child entry
 *     declare every attribute the parent does?).
 *
 * Currently read-only — built-ins stay built-in. Editable per-kind
 * surfaces (set parent, edit supports_*) land in a follow-up phase.
 */

import { DataTable } from '../../ui/components/data_table.js';
import { mountAttributeListEditor } from '../../ui/components/attribute_list_editor.js';
import { toastError, toastInfo } from '../ui/toast.js';
import { openForm } from '../ui/modal.js';

const KIND_TITLE = {
    asset_kind_template:  'Asset archetype',
    archetype_template:   'Agent archetype',
    market_kind:          'Market archetype',
    sector:               'Sector archetype',
};

// Which parent entity_kind(s) a child can inherit from. Used to scope
// the Parent dropdown so the user only sees plausible candidates.
const PARENT_KINDS = {
    asset_kind:          ['asset_kind_template', 'asset_kind'],
    archetype:           ['archetype_template'],
    market:              ['market_kind'],
    sub_sector:          ['sector'],
    asset_kind_template: ['asset_kind_template'],
    archetype_template:  ['archetype_template'],
    market_kind:         ['market_kind'],
    sector:              ['sector'],
};

// Editable "Extras" — fields where the bridge round-trips simple
// scalar / string-array values. We render bespoke controls for these
// so the user can write contracts (e.g. supports_assets on a
// market archetype) without dropping into raw JSON. Anything not in
// this list stays read-only.
const EXTRAS_SCHEMA = {
    market_kind: [
        { key: 'clearing_module',          type: 'text',
          label: 'Clearing module' },
        { key: 'supports_assets',     type: 'string_list',
          label: 'Supported asset kinds',
          hint: 'Asset kind ids this market accepts. Use * for wildcard.' },
        { key: 'supports_instrument_kinds', type: 'string_list',
          label: 'Supported instrument kinds' },
        { key: 'requires_methods',         type: 'string_list',
          label: 'Required public methods',
          hint: 'Method names every instrument must implement (e.g. price, cashflows_at).' },
    ],
    sector_kind:   [{ key: 'country', type: 'text', label: 'Country' }],
    sector:        [{ key: 'country', type: 'text', label: 'Country' }],
    asset_kind_template: [],
    archetype_template:  [],
    asset_kind:    [],
    archetype:     [],
    market:        [],
    flow:          [],
    // KPIs intentionally absent — they're standalone (own editor),
    // not contracts, so the viewer never opens for them.
};

const VIEWER_SUBTABS = [
    { id: 'definition',    label: 'Definition',    icon: 'description' },
    { id: 'relationships', label: 'Relationships', icon: 'hub' },
];


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}


export function makeArchetypeViewerTab(hostEl, entryId, ctx) {
    return new ArchetypeViewerTab(hostEl, entryId, ctx);
}


class ArchetypeViewerTab {
    constructor(hostEl, entryId, { logger, eventBus, workspaceTabs, wm, tabId, props } = {}) {
        this.hostEl = hostEl;
        // entry_kind is encoded in the props.id as `<kind>:<id>` so we
        // can route through one tab factory; fallback to props if the
        // workspace passes them separately.
        this.entryKey = String(entryId || props?.id || '').trim();
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.wm = wm ?? null;
        this.tabId = tabId ?? null;
        this.eventBus = eventBus ?? null;
        this._entry = null;
        this._related = [];
        this._allEntries = [];
        this._activeSubTab = 'definition';
        this._relTable = null;
    }

    async mount() {
        const [entity_kind, id] = this.entryKey.split(':', 2);
        this._entity_kind = entity_kind;
        this._id = id;
        await this._load();
        this._render();
    }

    show() {}
    hide() {}
    async refresh() { /* read-only */ }
    dispose() {}

    async _load() {
        const api = window.pywebview?.api;
        try {
            const res = await api?.registry_get?.(this._entity_kind, this._id);
            this._entry = res?.ok ? res.entry : null;
        } catch (err) {
            this.logger.warn?.('registry_get failed', { err });
            this._entry = null;
        }
        try {
            this._allEntries = (await api?.registry_list?.()) || [];
        } catch { this._allEntries = []; }
        await this._loadInverseRelationships();
    }

    async _loadInverseRelationships() {
        this._related = [];
        const api = window.pywebview?.api;
        if (!this._entry) return;

        // For an asset_kind_template / market_kind: walk asset_kinds in
        // the registry and list those whose parent points here (asset
        // archetype) or those that satisfy this market archetype's
        // contract. For a sector_kind: list sectors whose kind points
        // here.
        let candidates = [];
        try {
            candidates = await api?.registry_list?.() || [];
        } catch { candidates = []; }

        const ek = this._entity_kind;
        const id = this._id;

        if (ek === 'asset_kind_template' || ek === 'archetype_template') {
            const parentRef = `${ek}:${id}`;
            this._related = candidates
                .filter((e) => e.parent === parentRef)
                .map((e) => ({
                    why: 'inherits from',
                    entry: e,
                }));
        } else if (ek === 'sector') {
            const parentRef = `sector:${id}`;
            this._related = candidates
                .filter((e) => e.parent === parentRef)
                .map((e) => ({
                    why: 'sector = ' + id,
                    entry: e,
                }));
        } else if (ek === 'market_kind') {
            // Markets of this kind, plus asset kinds the market would
            // accept (via supports_assets / supports_instrument_kinds).
            const supports = this._entry.metadata?.supports_assets || [];
            const instrumentSupports =
                this._entry.metadata?.supports_instrument_kinds || [];
            const markets = candidates
                .filter((e) => e.entity_kind === 'market'
                    && e.parent === `market_kind:${id}`)
                .map((e) => ({
                    why: 'uses this clearing protocol',
                    entry: e,
                }));
            const assets = candidates
                .filter((e) => e.entity_kind === 'asset_kind' && (
                    supports.includes('*') ||
                    supports.includes(e.id) ||
                    instrumentSupports.includes(
                        (e.parent || '').split(':')[1])
                ))
                .map((e) => ({
                    why: supports.includes('*')
                        ? 'wildcard support'
                        : (supports.includes(e.id)
                           ? `directly supported (${e.id})`
                           : `inherits from ${e.parent}`),
                    entry: e,
                }));
            this._related = markets.concat(assets);
        }
    }

    _render() {
        const host = this.hostEl;
        host.classList.add('ea-archetype-viewer');
        if (!this._entry) {
            host.innerHTML = `
                <header class="ea-detail-header">
                    <h2>Not found</h2>
                    <span class="ea-detail-header__spacer"></span>
                </header>
                <div class="nb-structured-editor__content">
                    <div class="ea-bp-placeholder">
                        <p>Registry entry <code>${esc(this.entryKey)}</code>
                           not found.</p>
                    </div>
                </div>`;
            return;
        }

        const e = this._entry;
        const kindLabel = KIND_TITLE[e.entity_kind]
            || e.entity_kind.replace(/_/g, ' ');

        host.innerHTML = `
            <header class="ea-detail-header">
                <h2>${esc(e.label || e.id)}</h2>
                <span class="ea-badge">${esc(e.id)}</span>
                <span class="ea-archetype-viewer__kind">${esc(kindLabel)}</span>
                ${e.builtin ? `
                    <span class="ea-archetype-viewer__builtin"
                          title="Shipped with EcoAgent; read-only">
                      <span class="material-symbols-outlined">lock</span>
                      built-in
                    </span>` : ''}
                <span class="ea-detail-header__spacer"></span>
            </header>
            <div class="nb-structured-editor__tabs" data-role="subtabs"></div>
            <div class="nb-structured-editor__content" data-role="content"></div>
        `;

        const tabBar = host.querySelector('[data-role="subtabs"]');
        for (const t of VIEWER_SUBTABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nb-structured-editor__tab'
                + (t.id === this._activeSubTab ? ' active' : '');
            btn.dataset.tab = t.id;
            btn.innerHTML =
                `<span class="material-symbols-outlined">${t.icon}</span> ${t.label}`;
            btn.addEventListener('click', () => this._switchSubTab(t.id));
            tabBar.appendChild(btn);
        }
        this._renderActiveSubTab();
    }

    _switchSubTab(id) {
        if (id === this._activeSubTab) return;
        this._activeSubTab = id;
        this.hostEl.querySelectorAll('[data-role="subtabs"] button')
            .forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
        this._renderActiveSubTab();
    }

    _renderActiveSubTab() {
        const content = this.hostEl.querySelector('[data-role="content"]');
        if (!content) return;
        try { this._relTable?.destroy?.(); } catch { /* ignore */ }
        this._relTable = null;
        try { this._relHandle?.destroy?.(); } catch { /* ignore */ }
        this._relHandle = null;

        if (this._activeSubTab === 'relationships') {
            this._renderRelationships(content);
        } else {
            this._renderDefinition(content);
        }
        // Common click-through for "Open parent" buttons.
        content.querySelectorAll('[data-action="open-parent"]')
            .forEach((el) => el.addEventListener('click', (ev) => {
                const ek = ev.currentTarget.dataset.entityKind;
                const eid = ev.currentTarget.dataset.entityId;
                this._openInline(ek, eid);
            }));
    }

    _renderDefinition(content) {
        const e = this._entry;
        if (e.builtin) {
            this._renderDefinitionReadOnly(content);
        } else {
            this._renderDefinitionEditable(content);
        }
    }

    _renderDefinitionReadOnly(content) {
        const e = this._entry;
        const parent = e.parent_entry;
        content.innerHTML = `
            <section class="ea-card ea-archetype-viewer__builtin-banner">
                <div class="ea-archetype-viewer__builtin-banner-row">
                    <span class="material-symbols-outlined">lock</span>
                    <strong>Built-in archetype</strong>
                    <span class="ea-card__hint" style="margin-left:auto">
                        Built-ins ship with EcoAgent and are read-only.
                        Extend this archetype to define a custom contract
                        that overrides its declarations.
                    </span>
                    <button type="button" class="ea-btn"
                            data-action="extend-builtin">
                        <span class="material-symbols-outlined">subdirectory_arrow_right</span>
                        Extend to customize
                    </button>
                </div>
            </section>

            ${e.description ? `
                <section class="ea-card">
                    <h3 class="ea-card__title">About</h3>
                    <p class="ea-archetype-viewer__desc">${esc(e.description)}</p>
                </section>` : `
                <section class="ea-card">
                    <h3 class="ea-card__title">About</h3>
                    <p class="ea-card__hint">
                        No description set. Built-in archetypes are
                        documented in their source.
                    </p>
                </section>`}

            ${parent ? `
                <section class="ea-card">
                    <h3 class="ea-card__title">Inherits from</h3>
                    <div class="ea-archetype-viewer__parent">
                        <code>${esc(parent.entity_kind)}:${esc(parent.id)}</code>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="open-parent"
                                data-entity-kind="${esc(parent.entity_kind)}"
                                data-entity-id="${esc(parent.id)}">
                            <span class="material-symbols-outlined">open_in_new</span>
                            Open ${esc(parent.label || parent.id)}
                        </button>
                    </div>
                </section>` : ''}

            ${this._renderAttributes(e.attributes)}
            ${this._renderMethods(e.methods)}
            ${this._renderMetadata(e.metadata)}
        `;
        content.querySelector('[data-action="extend-builtin"]')
            ?.addEventListener('click', () => this._onExtend());
    }

    _renderDefinitionEditable(content) {
        const e = this._entry;
        const parentKinds = PARENT_KINDS[e.entity_kind] || [];
        // Build parent dropdown options scoped to the valid kinds.
        const parentOpts = [
            `<option value="">(no parent)</option>`,
        ];
        for (const pk of parentKinds) {
            const inKind = this._allEntries
                .filter((x) => x.entity_kind === pk
                    && !(x.entity_kind === e.entity_kind && x.id === e.id));
            if (inKind.length === 0) continue;
            parentOpts.push(`<optgroup label="${esc(pk)}">`);
            for (const x of inKind) {
                const v = `${x.entity_kind}:${x.id}`;
                const sel = v === e.parent ? ' selected' : '';
                parentOpts.push(
                    `<option value="${esc(v)}"${sel}>`
                    + `${esc(x.label || x.id)} (${esc(x.id)})</option>`,
                );
            }
            parentOpts.push(`</optgroup>`);
        }

        content.innerHTML = `
            <section class="ea-card">
                <h3 class="ea-card__title">About</h3>
                <p class="ea-card__hint">
                    Short prose describing what this archetype is for.
                    Appears in tooltips + the Used-by table.
                </p>
                <textarea data-field="description"
                          class="ea-archetype-viewer__edit-desc"
                          rows="3"
                          placeholder="e.g. Fixed-coupon government / corporate debt instrument…"
                          >${esc(e.description || '')}</textarea>
            </section>

            <section class="ea-card">
                <h3 class="ea-card__title">Inherits from</h3>
                <p class="ea-card__hint">
                    Parent archetype this entry refines. Attributes
                    declared by the parent are inherited; you only need
                    to override the ones that differ.
                </p>
                <select data-field="parent"
                        class="ea-archetype-viewer__edit-parent">
                    ${parentOpts.join('')}
                </select>
            </section>

            <section class="ea-card">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">Attributes</h3>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-action="attr-add">
                        <span class="material-symbols-outlined">add</span>
                        Add attribute
                    </button>
                </div>
                <p class="ea-card__hint">
                    Typed slots child entries inherit. Mark as
                    <code>required</code> to enforce that every child
                    declares them — the Used-by table's Contract column
                    fails when a child is missing a required attribute.
                </p>
                <div data-role="attrs-editor"></div>
            </section>

            ${this._renderEditableExtras(e)}

            ${this._renderMethods(e.methods)}
        `;

        // ── Description autosave ─────────────────────────────────
        const descEl = content.querySelector('[data-field="description"]');
        descEl?.addEventListener('blur', () => {
            const v = descEl.value;
            if (v === (e.description || '')) return;
            this._persist({ description: v });
        });

        // ── Parent autosave ──────────────────────────────────────
        const parentEl = content.querySelector('[data-field="parent"]');
        parentEl?.addEventListener('change', () => {
            this._persist({ parent: parentEl.value || null });
        });

        // ── Attributes editor (reuses attribute_list_editor) ─────
        const attrsHost = content.querySelector('[data-role="attrs-editor"]');
        const attrItems = (e.attributes || []).map((a) => ({ ...a }));
        const attrEditor = mountAttributeListEditor(attrsHost, {
            items: attrItems,
            showColumns: ['name', 'type', 'default', 'required', 'description'],
            allowReorder: true,
            allowRemove:  true,
            createItem: () => ({
                name: '', type: 'string', default: null, required: false,
                description: '',
            }),
            onFlush: () => {
                this._persist({ attributes: attrItems });
            },
        });
        this._attrEditor = attrEditor;
        content.querySelector('[data-action="attr-add"]')
            ?.addEventListener('click', () => {
                attrEditor.addItem({
                    name: '', type: 'string', default: null,
                    required: false, description: '',
                });
                this._persist({ attributes: attrItems });
            });

        // ── Extras (per-kind known fields) ───────────────────────
        content.querySelectorAll('[data-extras-key]').forEach((el) => {
            el.addEventListener('change', () => this._persistExtras(content));
            el.addEventListener('blur',   () => this._persistExtras(content));
        });
    }

    _renderEditableExtras(e) {
        const schema = EXTRAS_SCHEMA[e.entity_kind] || [];
        if (schema.length === 0) return '';
        const meta = e.metadata || {};
        const inputs = schema.map((f) => {
            const cur = meta[f.key];
            if (f.type === 'string_list') {
                const val = Array.isArray(cur) ? cur.join(', ') : '';
                return `
                    <label class="ea-row" title="${esc(f.hint || '')}">
                        <span>${esc(f.label)}</span>
                        <input type="text"
                               data-extras-key="${esc(f.key)}"
                               data-extras-type="string_list"
                               value="${esc(val)}"
                               placeholder="comma-separated">
                    </label>`;
            }
            const v = (cur !== null && cur !== undefined) ? String(cur) : '';
            return `
                <label class="ea-row" title="${esc(f.hint || '')}">
                    <span>${esc(f.label)}</span>
                    <input type="text"
                           data-extras-key="${esc(f.key)}"
                           data-extras-type="text"
                           value="${esc(v)}">
                </label>`;
        }).join('');
        return `
            <section class="ea-card">
                <h3 class="ea-card__title">Extras</h3>
                <p class="ea-card__hint">
                    Contract fields specific to <code>${esc(e.entity_kind)}</code>.
                    These declare the compatibility surface other entries
                    must satisfy (e.g. asset-kind ids a market accepts,
                    method names instruments must implement).
                </p>
                <div class="ea-form-grid">${inputs}</div>
            </section>`;
    }

    async _persistExtras(content) {
        const e = this._entry;
        const next = { ...(e.metadata || {}) };
        content.querySelectorAll('[data-extras-key]').forEach((el) => {
            const k = el.dataset.extrasKey;
            const t = el.dataset.extrasType;
            const v = el.value;
            if (t === 'string_list') {
                next[k] = v
                    .split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            } else {
                next[k] = v;
            }
        });
        await this._persist({ metadata: next });
    }

    async _persist(patch) {
        const api = window.pywebview?.api;
        try {
            const res = await api?.registry_save?.({
                entity_kind: this._entity_kind,
                id:          this._id,
                ...patch,
            });
            if (res?.ok === false) {
                toastError('Save', res.error || 'registry_save failed');
                return;
            }
            // Refresh local cache (parent_entry / resolved_attributes)
            // without re-rendering the whole card stack — that would
            // steal focus mid-typing.
            this._entry = { ...this._entry, ...(res?.entry || patch) };
            this.eventBus?.emit?.('ecoagent:project:changed',
                { source: 'archetype-viewer' });
        } catch (err) {
            toastError('Save', String(err?.message || err));
        }
    }

    async _onExtend() {
        const e = this._entry;
        const data = await openForm({
            title: `Extend ${e.label || e.id}`,
            submitLabel: 'Create',
            fields: [
                { name: 'id', label: 'New id', type: 'text', required: true,
                  placeholder: `my_${e.id}` },
                { name: 'label', label: 'Label', type: 'text',
                  placeholder: `My ${e.label || e.id}` },
            ],
        });
        if (!data?.id) return;
        const api = window.pywebview?.api;
        try {
            const res = await api?.registry_save?.({
                entity_kind: this._entity_kind,
                id: String(data.id).trim(),
                label: data.label || data.id,
                parent: `${this._entity_kind}:${this._id}`,
            });
            if (res?.ok === false) {
                toastError('Extend', res.error || 'registry_save failed');
                return;
            }
            toastInfo('Extend', `Created ${this._entity_kind}:${data.id}`);
            this.eventBus?.emit?.('ecoagent:project:changed',
                { source: 'archetype-viewer-extend' });
            // Open the new entry inline so the user can edit it.
            this._openInline(this._entity_kind, String(data.id).trim());
        } catch (err) {
            toastError('Extend', String(err?.message || err));
        }
    }

    /** Mount the shared Relationships helper so the viewer renders the
     *  exact same Inherits / Out-refs / Dependencies / Used-by surface
     *  as every other entity editor. Editable for non-builtin entries
     *  via the `onAddDependency` / `onRemoveDependency` hooks. */
    async _renderRelationships(content) {
        const e = this._entry;
        const { mountRelationshipsTab } = await import('./_relationships.js');
        content.innerHTML = '';
        const host = document.createElement('div');
        content.appendChild(host);
        this._relHandle = await mountRelationshipsTab(host, {
            entity_kind:    this._entity_kind,
            id:             this._id,
            workspaceTabs:  this.workspaceTabs,
            onAddDependency:    e.builtin
                ? null
                : () => this._onAddDependency().then(() => this._relHandle?.refresh?.()),
            onRemoveDependency: e.builtin
                ? null
                : (edge) => this._onRemoveDependencyEdge(edge)
                              .then(() => this._relHandle?.refresh?.()),
        });
    }

    async _onAddDependency() {
        const data = await openForm({
            title: 'Add dependency edge',
            submitLabel: 'Add',
            fields: [
                { name: 'direction', label: 'Direction', type: 'select',
                  required: true,
                  options: [
                      { value: 'read',     label: 'read (consumes)' },
                      { value: 'write',    label: 'write (produces)' },
                      { value: 'requires', label: 'requires (entity ref)' },
                  ] },
                { name: 'kind', label: 'Edge kind', type: 'select',
                  required: true,
                  options: [
                      { value: 'bus_topic', label: 'bus_topic' },
                      { value: 'brain_key', label: 'brain_key' },
                      { value: 'registry',  label: 'registry' },
                      { value: 'account',   label: 'account' },
                      { value: 'param',     label: 'param' },
                      { value: 'asset_kind',        label: 'requires: asset_kind' },
                      { value: 'sector',            label: 'requires: sector' },
                      { value: 'market_archetype',  label: 'requires: market_archetype' },
                      { value: 'currency',          label: 'requires: currency' },
                      { value: 'country',           label: 'requires: country' },
                  ] },
                { name: 'target', label: 'Target (key/id)', type: 'text',
                  required: true,
                  placeholder: 'e.g. prices.bonds.de  OR  loans  OR  bobl_5y' },
            ],
        });
        if (!data) return;
        const e = this._entry;
        const arr = data.direction === 'read'  ? (e.reads    || []).slice()
                  : data.direction === 'write' ? (e.writes   || []).slice()
                  :                              (e.requires || []).slice();
        if (data.direction === 'requires') {
            arr.push({ kind: data.kind, id: String(data.target).trim() });
        } else {
            arr.push({ kind: data.kind, key: String(data.target).trim() });
        }
        const patch = {};
        if (data.direction === 'read')     patch.reads    = arr;
        if (data.direction === 'write')    patch.writes   = arr;
        if (data.direction === 'requires') patch.requires = arr;
        await this._persist(patch);
        if (data.direction === 'read')     this._entry.reads    = arr;
        if (data.direction === 'write')    this._entry.writes   = arr;
        if (data.direction === 'requires') this._entry.requires = arr;
    }

    async _onRemoveDependencyEdge(edge) {
        if (!edge) return;
        const e = this._entry;
        const match = (a, b) => a.kind === b.kind
            && (a.key === b.key || a.id === b.id);
        const patch = {};
        if (edge.direction === 'read') {
            patch.reads = (e.reads || []).filter((x) => !match(x, edge));
            e.reads = patch.reads;
        } else if (edge.direction === 'write') {
            patch.writes = (e.writes || []).filter((x) => !match(x, edge));
            e.writes = patch.writes;
        } else {
            patch.requires = (e.requires || []).filter((x) => !match(x, edge));
            e.requires = patch.requires;
        }
        await this._persist(patch);
    }

    _openInline(entity_kind, id) {
        // Pick the right tab kind based on the entity_kind. The
        // workspace-tabs API expects `{kind, entityId, label}` — the
        // same shape the shared _relationships helper uses.
        const RTAB = {
            asset_kind: 'asset_kind',
            archetype:  'archetype',
        };
        const tab = RTAB[entity_kind] || 'archetype_viewer';
        if (tab === 'archetype_viewer') {
            this.workspaceTabs?.openTab?.({
                kind: 'archetype_viewer',
                entityId: `${entity_kind}:${id}`,
                label: id,
            });
        } else {
            this.workspaceTabs?.openTab?.({
                kind: tab, entityId: id, label: id,
            });
        }
    }

    _renderAttributes(attrs) {
        attrs = attrs || [];
        if (attrs.length === 0) {
            return `
                <section class="ea-card">
                    <h3 class="ea-card__title">Attributes</h3>
                    <p class="ea-card__hint">
                        No attribute slots declared.
                    </p>
                </section>`;
        }
        return `
            <section class="ea-card">
                <h3 class="ea-card__title">Attributes</h3>
                <p class="ea-card__hint">
                    The schema this archetype declares. Children inherit
                    these slots and may override the values.
                </p>
                <table class="ea-table ea-archetype-viewer__attrs">
                    <thead><tr>
                        <th>Name</th><th>Type</th><th>Default</th>
                        <th>Required</th><th>Description</th>
                    </tr></thead>
                    <tbody>
                        ${attrs.map((a) => `
                            <tr>
                                <td><code>${esc(a.name)}</code></td>
                                <td><code>${esc(a.type)}</code></td>
                                <td>${esc(a.default ?? '—')}</td>
                                <td>${a.required ? '✓' : ''}</td>
                                <td>${esc(a.description || '')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </section>`;
    }

    _renderMethods(methods) {
        methods = methods || [];
        if (methods.length === 0) {
            return '';
        }
        return `
            <section class="ea-card">
                <h3 class="ea-card__title">Required methods</h3>
                <p class="ea-card__hint">
                    Public method signatures the archetype declares.
                    Children must implement these (compatible signatures
                    in the .py source).
                </p>
                <ul class="ea-archetype-viewer__methods">
                    ${methods.map((m) => {
                        const sig = m.name + '('
                            + (m.params || []).map((p) =>
                                p.name + (p.type ? ': ' + p.type : '')).join(', ')
                            + ')' + (m.returns ? ' -> ' + m.returns : '');
                        return `
                            <li>
                                <code>${esc(sig)}</code>
                                ${m.required ? '<span class="ea-required-badge">required</span>' : ''}
                                ${m.description
                                    ? `<span class="ea-archetype-viewer__method-desc">${esc(m.description)}</span>`
                                    : ''}
                            </li>`;
                    }).join('')}
                </ul>
            </section>`;
    }

    _renderMetadata(meta) {
        meta = meta || {};
        const keys = Object.keys(meta).filter((k) =>
            meta[k] !== null && meta[k] !== undefined && meta[k] !== '');
        if (keys.length === 0) return '';
        // Pretty-print known metadata fields with explanatory captions
        // rather than dumping raw JSON. Fields the archetype types use
        // today: clearing_module (market_kind), supports_assets
        // (market_kind), supports_instrument_kinds (market_kind),
        // requires_methods (market_kind), country (sector),
        // postings (flow). KPIs are standalone (not archetypes) and
        // never reach this renderer.
        const labels = {
            clearing_module:          'Clearing module',
            supports_assets:     'Supported asset kinds',
            supports_instrument_kinds:'Supported instrument kinds',
            requires_methods:         'Required public methods',
            country:                  'Country',
            unit:                     'Unit',
            expr:                     'Expression',
            postings:                 'Posting recipe',
            is_financial_default:     'Financial by default',
            template:                 'Template id (legacy)',
        };
        const fmt = (v) => {
            if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
            if (typeof v === 'object') return JSON.stringify(v, null, 2);
            return String(v);
        };
        return `
            <section class="ea-card">
                <h3 class="ea-card__title">Extras</h3>
                <p class="ea-card__hint">
                    Entity-kind-specific extras that don't fit the
                    common attribute/method shape — for example a
                    Market archetype's clearing module, the set of
                    asset kinds it accepts, or the public methods it
                    requires its instruments to implement.
                </p>
                <table class="ea-table ea-archetype-viewer__attrs">
                    <thead><tr><th>Field</th><th>Value</th></tr></thead>
                    <tbody>
                        ${keys.map((k) => `
                            <tr>
                                <td><code>${esc(k)}</code>
                                    ${labels[k]
                                        ? `<div class="ea-archetype-viewer__meta-label">${esc(labels[k])}</div>`
                                        : ''}
                                </td>
                                <td>${esc(fmt(meta[k]))}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </section>`;
    }
}
