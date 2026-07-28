/**
 * market_archetype_tab.js — workspace tab for editing a market archetype.
 *
 * Phase M2 of the markets UX plan (see docs/MARKETS_UX_PLAN.md).
 * Until now the only way to interact with a market archetype was to
 * add an instance via the sidebar (`market_instance_add`).
 * Seven other archetype API verbs went unused; rule edits had to be
 * applied to every instance individually. This tab exposes the whole
 * archetype lifecycle (kind, template rules, instance list, per-
 * instance overrides) on one page.
 *
 * Bridge API used:
 *   markets_list                  — fetch all archetypes
 *   market_set_kind(id, kind)     — switch kind
 *   market_set_rules(id, rules)   — edit template
 *   market_instance_add(id, iid)  — add instance
 *   market_instance_remove(id, iid)
 *   market_instance_set_rules(id, iid, rules)
 *   market_remove(id)             — delete (cascades instances)
 *
 * Data shape (returned by markets_list):
 *   { id, kind, rules: {...}, instances: [{ id, rules: {...}, schedule: [] }] }
 */

import { esc } from './_util.js';
import { loadRefContext } from '../markets/refs.js';
import {
    KIND_LABEL,
    ALL_KINDS,
    kindOptionLabel,
    RULES_SCHEMA,
} from '../markets/schema.js';
import { attrSpecsToFields } from '../markets/rules_schema_adapter.js';
import { openConfirm, openForm } from '../ui/modal.js';
import { toastError } from '../ui/toast.js';
import { DataTable } from '../../ui/components/data_table.js';
import { attachLandingKeyboardNav } from '../../tiling/landing_table.js';


// Market parent sub-tabs. Branches first (it's the landing surface).
// No standalone Signature sub-tab — the signature panel embeds inside
// Code. No Implementation tab — a market IS the contract, it doesn't
// implement anything else. No Settings tab — the only fields were
// branch count (meaningless config) and id (per user rule, ids are
// never a user concern). No Booking-rules tab — the underlying
// `fires_flows` field is documentation-only (not consumed by the sim)
// and the model itself is questionable (flows fire from agent code,
// not from market kinds). No Godley tab (removed 2026-07-02) — the
// market-clear `_flow_rows` editor (Godley P5) never had a live engine
// hook after #160 deleted `_fire_market_flow_rows` as dead code; real
// market settlement is `payment_engine.pay(...)` in a market's Code.
const ARCHETYPE_SUBTABS = [
    { id: 'instances',      label: 'Branches',       icon: 'view_list' },
    { id: 'attributes',     label: 'Attributes',     icon: 'data_object' },
    { id: 'relationships',  label: 'Relationships',  icon: 'hub' },
    { id: 'code',           label: 'Code',           icon: 'code' },
];

/** Factory registered with WorkspaceTabs for kind `market-archetype`. */
export function makeMarketArchetypeTab(hostEl, archetypeId, ctx) {
    return new MarketArchetypeTab(hostEl, archetypeId, ctx);
}


class MarketArchetypeTab {
    constructor(hostEl, archetypeId, { logger, workspaceTabs, tabId, eventBus, baseKind } = {}) {
        this.hostEl = hostEl;
        this.archetypeId = archetypeId;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        this.eventBus = eventBus ?? null;
        // 'base' mode: this is a market KIND (markets/_kinds/<snake>.py), not a
        // concrete archetype — the same editor, but loaded from market_kind_get,
        // with no Branches (kinds have no instances) and the form-saves (rules /
        // attributes) skipped (a kind is edited through its Code; the snake id
        // also collides with a concrete market id, so form-saves must NOT route
        // to markets_*). Reuse the normal editor for base kinds.
        this._isBase = !!baseKind;
        this._archetype = null;
        this._refCtx = { currencies: [], assetKinds: [], markets: [] };
        this._root = null;
        this._table = null;          // DataTable instance for the instance list
        this._lastInstances = [];    // sorted snapshot used by renderCell callbacks
        this._activeSubTab = baseKind ? 'attributes' : 'instances';   // landing surface
    }

    async mount(props = {}) {
        // Restore the user's last sub-tab when re-entering via Backspace.
        // The WM tab props carry `subTab` because `_switchSubTab` writes
        // it back via the workspaceTabs shim — see _switchSubTab below.
        const known = new Set(ARCHETYPE_SUBTABS.map((t) => t.id));
        if (props?.subTab && known.has(props.subTab)) {
            this._activeSubTab = props.subTab;
        }
        // The outer wrapper carries BOTH `.ea-market-archetype-tab`
        // (archetype-specific styles) AND `.ea-market-tab` so the
        // sub-tab strip + header + content padding co-listed rules
        // in ecoagent_extra_modes.css (shared with agent / sector /
        // flow / market tabs) apply here too. Without `.ea-market-tab`
        // the strip would fall back to the bare notebook defaults and
        // read as a visually different page.
        this.hostEl.innerHTML = `
            <div class="ea-market-archetype-tab ea-market-tab">
                <header class="ea-detail-header" data-role="header"></header>
                <div class="nb-structured-editor__tabs" data-role="subtabs"></div>
                <div class="nb-structured-editor__content" data-role="content"></div>
            </div>
        `;
        this._root = this.hostEl.querySelector('.ea-market-archetype-tab');
        await this._load();
        this._render();
    }

    show() {}
    hide() {}

    async refresh() {
        // Live tick events fire this; we re-load only the archetype state
        // (cheap — single bridge call) but skip the full re-render unless
        // something structural changed. Archetypes don't carry live data
        // (price/volume) so there's nothing else to refresh.
        const prevKind = this._archetype?.kind ?? this._archetype?.kind_id;
        const prevInstanceIds = (this._archetype?.instances || [])
            .map((i) => i.id).join(',');
        await this._load();
        if (!this._archetype) {
            this._render();
            return;
        }
        const newInstanceIds = (this._archetype.instances || [])
            .map((i) => i.id).join(',');
        const newKind = this._archetype.kind ?? this._archetype.kind_id;
        if (newKind !== prevKind || newInstanceIds !== prevInstanceIds) {
            this._render();
        }
    }

    dispose() {
        try { this._table?.destroy?.(); } catch { /* ignore */ }
        this._table = null;
    }


    /* ── data ─────────────────────────────────────────────────────── */

    async _load() {
        this._archetype = null;
        try {
            if (this._isBase) {
                const r = await window.pywebview?.api?.market_kind_get?.(this.archetypeId);
                this._archetype = r?.ok ? r : null;
            } else {
                const list = await window.pywebview?.api?.markets_list?.();
                this._archetype = (Array.isArray(list) ? list : [])
                    .find((a) => a.id === this.archetypeId) || null;
            }
        } catch (err) {
            this.logger.warn?.('market load failed', { err });
        }
        try {
            this._refCtx = await loadRefContext(window.pywebview?.api);
        } catch (err) {
            this.logger.warn?.('loadRefContext failed', { err });
        }
    }


    /* ── render ───────────────────────────────────────────────────── */

    _render() {
        const a = this._archetype;
        const header  = this._root.querySelector('[data-role="header"]');
        const subtabs = this._root.querySelector('[data-role="subtabs"]');
        const content = this._root.querySelector('[data-role="content"]');
        if (!a) {
            header.innerHTML = '';
            subtabs.innerHTML = '';
            content.innerHTML = '<div class="ea-markets__empty">'
                + 'Market not found — it may have been removed.</div>';
            return;
        }
        const nInstances = (a.instances || []).length;
        // Header: identity + branch count + actions. The protocol/kind
        // badge + open-parent link came from the archetype model and
        // were inherently wrong here — markets don't have a parent,
        // and the market's clearing kind is defined by its code, not
        // by a typed enum.
        header.innerHTML = `
            <h2>${esc(a.id)}</h2>
            <span class="ea-badge ea-badge--muted">${nInstances}× ${nInstances === 1 ? 'branch' : 'branches'}</span>
            <span class="ea-detail-header__spacer"></span>
            <button class="ea-btn ea-btn--small" data-action="add-instance"
                    title="Add a new branch">
                <span class="material-symbols-outlined">add</span>
                Add branch
            </button>
            <button class="ea-btn ea-btn--small ea-btn--danger" data-action="delete"
                    title="Delete this market and all its branches">
                <span class="material-symbols-outlined">delete</span>
                Delete
            </button>
        `;
        header.querySelector('[data-action="add-instance"]')
            ?.addEventListener('click', () => this._onAddInstance());
        header.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDeleteArchetype());

        // Sub-tab strip — mirrors AGENT_SUBTABS pattern. A base kind has no
        // Branches: a kind can't have branches (only a concrete market can).
        subtabs.innerHTML = '';
        for (const t of ARCHETYPE_SUBTABS) {
            if (this._isBase && t.id === 'instances') continue;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nb-structured-editor__tab'
                + (t.id === this._activeSubTab ? ' active' : '');
            btn.dataset.tab = t.id;
            btn.innerHTML = `<span class="material-symbols-outlined">${t.icon}</span> ${t.label}`;
            btn.addEventListener('click', () => this._switchSubTab(t.id));
            subtabs.appendChild(btn);
        }

        this._renderActiveSubTab();
    }

    _switchSubTab(id) {
        if (id === this._activeSubTab) return;
        this._activeSubTab = id;
        // Persist into WM tab props so Backspace lands the user back
        // on the sub-tab they were on, not the default Branches view.
        try { this.workspaceTabs?.updateProps?.({ subTab: id }); }
        catch (err) { this.logger.warn?.('updateProps failed', { err }); }
        const subtabs = this._root.querySelector('[data-role="subtabs"]');
        subtabs?.querySelectorAll('.nb-structured-editor__tab').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === id);
        });
        this._renderActiveSubTab();
    }

    _renderActiveSubTab() {
        const content = this._root.querySelector('[data-role="content"]');
        const a = this._archetype;
        if (!content || !a) return;
        // Tear down any DataTable from a previous sub-tab — it carries
        // event listeners and re-creating it via _renderInstanceTable
        // below allocates a fresh instance.
        try { this._table?.destroy?.(); } catch { /* ignore */ }
        this._table = null;
        // Detach the branches-table keyboard nav. The helper installs
        // a document-level keydown listener; without teardown the
        // listener stays after the user switches off Branches and
        // keeps re-painting `.ea-row-cursor` on a stale tbody.
        try { this._instancesKbd?.teardown?.(); } catch { /* ignore */ }
        this._instancesKbd = null;
        // The Code sub-tab flips `content` to flex-column so Monaco
        // can claim leftover height. Drop the class for every other
        // tab so cards layout normally; the Code branch re-adds it.
        content.classList.remove('ea-agent-tab-content--code');

        if (this._activeSubTab === 'instances') {
            content.innerHTML = `
                <div class="ea-archetype-instances" data-role="instance-table"></div>
            `;
            this._renderInstanceTable(
                content.querySelector('[data-role="instance-table"]'), a);
            return;
        }

        if (this._activeSubTab === 'code') {
            // Monaco-mounted view of the market kind's .py file. Same
            // shell branches use (`.ea-agent-tab--code` flex column
            // inside an `ea-agent-tab-content--code` content). The
            // parent has no inherited-toggle (no parent to inherit
            // from); everything else lines up with the branch Code
            // tab so the chrome reads identically.
            content.classList.add('ea-agent-tab-content--code');
            content.innerHTML = `
                <div class="ea-agent-tab ea-agent-tab--code">
                    <div data-role="live-signature"></div>
                    <div data-role="path-bar" class="ea-agent-code__bar">
                        <span data-role="path-label"
                              class="ea-agent-code__path">Loading…</span>
                    </div>
                    <div data-role="code-host"
                         class="ea-monaco-host ea-agent-code__host"></div>
                </div>
            `;
            this._renderCodeSubTab(content, a.kind ?? a.kind_id).then(() => {
                // Mount the live signature panel after the editor is
                // live so it can hook into the editor's change events.
                const sigHost = content.querySelector('[data-role="live-signature"]');
                if (!sigHost) return;
                try { this._liveSigCtl?.destroy?.(); } catch { /* ignore */ }
                import('./live_signature_panel.js').then(({ mountLiveSignaturePanel }) => {
                    this._liveSigCtl = mountLiveSignaturePanel(sigHost, {
                        kind: 'market_archetype',
                        id: a.id,
                        editor: this._codeEditor?.editor || null,
                        vantage: 'inbound',
                        getSource: () => this._codeEditor?.getValue?.() || '',
                        logger: this.logger,
                    });
                });
            });
            return;
        }

        if (this._activeSubTab === 'relationships') {
            content.innerHTML = `
                <section class="ea-card">
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Requires</h3>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="add-requires"
                                title="Add a declared dependency on another entity">
                            <span class="material-symbols-outlined">add</span>
                            Add
                        </button>
                    </div>
                    <p class="ea-card__hint">
                        Entities this market depends on (asset_kinds it trades,
                        sectors it touches, …). Stored on the market's JSON and
                        rolled into the project-wide dependency graph.
                    </p>
                    <div data-role="requires-host"></div>
                </section>
                <div data-role="relationships-host"></div>
                <section class="ea-card">
                    <h3 class="ea-card__title">Computed dependencies</h3>
                    <p class="ea-card__hint">
                        Data-flow edges declared by this market's code
                        (bus_topic / brain_key / registry / account / param)
                        plus the requires entries from above.
                    </p>
                    <div data-role="deps-host"></div>
                </section>
            `;
            this._renderRequiresEditor(
                content.querySelector('[data-role="requires-host"]'), a);
            content.querySelector('[data-action="add-requires"]')
                ?.addEventListener('click', () => this._onAddRequires(a));
            const host = content.querySelector('[data-role="relationships-host"]');
            import('./_relationships.js').then(({ mountRelationshipsTab }) => {
                mountRelationshipsTab(host, {
                    entity_kind: 'market',
                    id: a.id,
                    workspaceTabs: this.workspaceTabs,
                });
            }).catch((err) => {
                this.logger.warn?.('relationships tab load failed', { err });
                host.innerHTML = '<div class="ea-bp-placeholder__hint">'
                    + 'Relationships view failed to load.</div>';
            });
            // Dependency rows — fetched from the unified registry.
            (async () => {
                const api = window.pywebview?.api;
                const depsHost = content.querySelector('[data-role="deps-host"]');
                if (!depsHost) return;
                let edges = [];
                try {
                    edges = (await api?.dependency_manifest?.(
                        { entity_kind: 'market', id: a.id })) || [];
                } catch (err) {
                    this.logger.warn?.('dependency_manifest failed', { err });
                }
                if (edges.length === 0) {
                    depsHost.innerHTML = '<div class="ea-bp-placeholder__hint">'
                        + 'No dependencies declared on this market.'
                        + '</div>';
                    return;
                }
                const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
                    (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                depsHost.innerHTML = `
                    <table class="ea-table ea-archetype-viewer__attrs">
                        <thead><tr>
                            <th>Direction</th><th>Kind</th><th>Target</th>
                        </tr></thead>
                        <tbody>
                            ${edges.map((e) => `
                                <tr>
                                    <td>${esc(e.direction)}</td>
                                    <td><code>${esc(e.kind || '?')}</code></td>
                                    <td><code>${esc(e.key || e.id || '?')}</code></td>
                                </tr>`).join('')}
                        </tbody>
                    </table>`;
            })();
            return;
        }

        if (this._activeSubTab === 'attributes') {
            // Reuse the shared attribute_list_editor — the same widget
            // every other entity uses for declaring typed attributes
            // (sectors, agents, asset kinds). Rules folded in: there's
            // no separate Rules concept on markets — rules ARE
            // attributes branches override.
            content.innerHTML = `<section class="ea-card">
                <h3 class="ea-card__title">Attributes</h3>
                <p class="ea-card__hint">
                    The market's attribute schema. Branches inherit every
                    row and may override values on their own Attributes
                    tab.
                </p>
                <div data-role="attrs-host"></div>
            </section>`;
            this._renderMarketAttributesEditor(
                content.querySelector('[data-role="attrs-host"]'), a);
            return;
        }

        // Unknown sub-tab id (e.g. a stale `settings` from a persisted
        // tab spec) — silently fall back to Branches rather than
        // showing an empty surface.
        this._activeSubTab = 'instances';
        this._render();
    }

    /** Diff of an instance's rules against the template rules. Returns
     *  a list of `{name, instanceValue, templateValue}` objects for
     *  every key whose value differs (key in instance but not template,
     *  or value differs). Used to render the overrides column. */
    _instanceOverrides(instanceRules, templateRules) {
        const diffs = [];
        const iRules = instanceRules || {};
        const tRules = templateRules || {};
        const keys = new Set([...Object.keys(iRules), ...Object.keys(tRules)]);
        for (const k of keys) {
            // `asset_kind` and `attr:<name>` are branch-level data
            // owned by the Resource kind + Attributes editor on the
            // branch detail page — not clearing-rule overrides — so
            // they don't show up in this column.
            if (k === 'asset_kind' || k.startsWith('attr:')) continue;
            const iv = iRules[k];
            const tv = tRules[k];
            const iHas = Object.prototype.hasOwnProperty.call(iRules, k);
            if (!iHas) continue;  // template-only keys aren't overrides
            if (iv === tv) continue;
            diffs.push({ name: k, instanceValue: iv, templateValue: tv });
        }
        return diffs;
    }

    /** Read-only instance overview. Three columns:
     *    - Instance id
     *    - Overrides (chips summarising the diff against the template)
     *    - Actions (remove icon)
     *  Override EDITING is intentionally NOT here — it lives on the
     *  market instance's own Settings sub-tab (open via row click or
     *  the Open icon). */
    /** Attributes editor for the market parent. Same widget every
     *  other entity uses (sectors, agents, asset_kinds, archetypes).
     *  Rules folded in — there is no separate "rules" concept on
     *  markets; what the user used to call rules are just attributes
     *  branches may override on their own Attributes tab. */
    async _renderMarketAttributesEditor(host, a) {
        if (!host) return;
        const { mountAttributeListEditor } = await import(
            '../../ui/components/attribute_list_editor.js');
        // Combine existing `attributes` AND the legacy `rules` map so
        // markets that still carry rule-style data show every row in
        // one table. Rule keys become attribute rows with type derived
        // from the value (best-effort; user can re-type inline).
        const items = [];
        for (const a0 of (a.attributes || [])) {
            items.push({ ...a0 });
        }
        for (const [k, v] of Object.entries(a.rules || {})) {
            if (items.some((x) => x.name === k)) continue;
            items.push({
                name: k,
                type: (typeof v === 'number') ? 'float'
                    : (typeof v === 'boolean') ? 'bool'
                    : 'string',
                default: v,
                required: false,
                description: '(migrated from market rules)',
            });
        }
        try { this._attrEditor?.dispose?.(); } catch { /* ignore */ }
        this._attrEditor = mountAttributeListEditor(host, {
            items,
            showColumns: ['name', 'type', 'default', 'required', 'description'],
            allowReorder: true,
            allowRemove:  true,
            // Without `addButtonText` the SortableList omits the
            // add button entirely — that was the regression the user
            // flagged. Match the asset_kind / sector_kind editors.
            addButtonText: 'Add attribute',
            createItem: () => ({
                name: '', type: 'string', default: null, required: false,
                description: '',
            }),
            onChange: (next) => {
                items.length = 0;
                for (const it of next) items.push(it);
            },
            onFlush: async () => {
                // Base kind: its snake id collides with a concrete market id, so
                // market_set_attributes would hit the wrong entity. Edit the
                // kind's attributes through its Code for now.
                if (this._isBase) return;
                try {
                    await window.pywebview?.api?.market_set_attributes?.(
                        a.id, items);
                } catch (err) {
                    this.logger.warn?.('save market attributes failed', { err });
                }
            },
        });
    }

    _renderInstanceTable(host, archetype) {
        if (!host) return;
        const instances = archetype.instances || [];
        this._lastInstances = instances
            .slice()
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));

        try { this._table?.destroy?.(); } catch { /* ignore */ }
        this._table = null;

        if (this._lastInstances.length === 0) {
            host.innerHTML = '<p class="ea-card__hint ea-card__hint--show">'
                + 'No branches yet. Use the <em>Add branch</em> button above to create one.</p>';
            return;
        }

        const headers = ['Branch', 'Resource', 'Overrides', ''];
        const rows = this._lastInstances.map((inst) => {
            const diffs = this._instanceOverrides(inst.rules, archetype.rules);
            const overridesText = diffs.length === 0
                ? '— inherits market —'
                : diffs.map((d) => `${d.name}=${d.instanceValue}`).join(', ');
            const resource = (inst.rules && inst.rules.asset_kind) || '';
            return [inst.id, resource || '—', overridesText, ''];
        });

        this._table = new DataTable(host, {
            headers, rows,
            pageSize: 1000,
            pagination: false,
            sortable: true,
            filterable: false,
            selectable: true,
            copyable: true,
            readonly: true,
            emptyMessage: 'No branches.',
            getColumnType: () => 'text',
            renderCell: (td, _value, colIdx, rowIdx) => {
                const inst = this._lastInstances[rowIdx];
                if (!inst) return false;
                if (colIdx === 0) {
                    td.classList.add('ea-arch-table__id-cell');
                    td.textContent = inst.id;
                    return true;
                }
                if (colIdx === 1) {
                    const resource = (inst.rules && inst.rules.asset_kind) || '';
                    td.innerHTML = resource
                        ? `<code>${esc(resource)}</code>`
                        : '<span class="ea-arch-table__no-overrides">—</span>';
                    return true;
                }
                if (colIdx === 2) {
                    const diffs = this._instanceOverrides(inst.rules, archetype.rules);
                    if (diffs.length === 0) {
                        td.innerHTML = '<span class="ea-arch-table__no-overrides">— inherits market —</span>';
                    } else {
                        td.innerHTML = diffs.map((d) => `
                            <span class="ea-arch-table__override"
                                  title="Market: ${esc(String(d.templateValue ?? '∅'))}">
                                <code>${esc(d.name)}</code> = <code>${esc(String(d.instanceValue ?? '∅'))}</code>
                            </span>
                        `).join('');
                    }
                    return true;
                }
                if (colIdx === 3) {
                    td.classList.add('twm-row-actions-cell');
                    td.innerHTML = `
                        <button type="button"
                                class="twm-row-action twm-row-action--danger"
                                data-twm-action="remove"
                                title="Remove branch"
                                aria-label="Remove branch">
                            <span class="material-symbols-outlined">delete</span>
                        </button>`;
                    td.querySelector('[data-twm-action="remove"]')
                      .addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        this._onRemoveInstance(inst.id);
                    });
                    return true;
                }
                return false;
            },
        });
        this._table.render();

        // Single click → open the instance's market tab (where the
        // overrides editor now lives).
        const tbody = host.querySelector('tbody');
        tbody?.addEventListener('click', (ev) => {
            if (ev.target.closest('button, a, input, select, textarea')) return;
            const tr = ev.target.closest('tr');
            if (!tr || !tbody.contains(tr)) return;
            const inst = this._lastInstances[tr.__rowIndex];
            if (inst) this._openInstanceTab(inst.id);
        });

        // Arrow-key navigation — same UX as the landing tables. The
        // helper installs ArrowUp/Down + Home/End cursor movement and
        // routes Enter to `onActivate`, repainting `.ea-row-cursor`
        // on the focused `<tr>`. Disposed in `_destroy` (the WM tears
        // the tab down via that path).
        try { this._instancesKbd?.teardown?.(); } catch { /* ignore */ }
        this._instancesKbd = attachLandingKeyboardNav(
            host,
            () => this._lastInstances,
            (inst) => { if (inst) this._openInstanceTab(inst.id); },
        );
    }

    // _kindOptions / _setKind removed — the market's kind is defined
    // by its code, not a typed enum selection.

    /** T4.2 — Monaco editor for the market kind's .py source. Built-in
     *  kinds load read-only from the engine class file; user-defined
     *  kinds save back to `<project>/market_kinds/<id>.py` on blur. */
    async _renderCodeSubTab(content, marketKind) {
        // `path-label` is the canonical slot used by both market parent
        // and branch code tabs after #117 unified the shell.
        const pathbar = content.querySelector('[data-role="path-label"]');
        const host    = content.querySelector('[data-role="code-host"]');
        if (!host || !pathbar) return;
        // Dispose any previously-mounted editor so the host is clean.
        try { this._codeEditor?.dispose?.(); } catch { /* ignore */ }
        this._codeEditor = null;
        const api = window.pywebview?.api;
        let res = null;
        try {
            // A concrete market shows its OWN class (class Commodity(CommodityBase));
            // a base kind shows the kind's behaviour (class CommodityBase(MarketBase)).
            res = await (this._isBase
                ? api?.market_kind_code_get?.(marketKind)
                : api?.market_code_get?.(this.archetypeId));
        } catch (err) {
            this.logger?.warn?.('code fetch failed', { err });
        }
        if (!res?.ok) {
            pathbar.textContent = res?.error || 'no source available';
            host.innerHTML = '';
            return;
        }
        // The bridge auto-seeds <project>/market_kinds/<id>.py from
        // the bundled starter on first open; the file is always a
        // project copy. The previous "gallery default / Revert to
        // gallery" affordances were removed alongside the engine
        // gallery purge — there's nothing distinct to revert to.
        pathbar.innerHTML = `<span>${esc(res.path || '')}</span>`;
        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger?.warn?.('Monaco unavailable for code view', { err });
        }
        if (!factory) {
            // Plain textarea fallback when Monaco can't load.
            host.innerHTML = `<textarea class="ea-asset-kind-tab__code-fallback"
                                        spellcheck="false"
                                        rows="20">${esc(res.source || '')}</textarea>`;
            const ta = host.querySelector('textarea');
            ta.addEventListener('blur', () =>
                this._saveCodeSource(marketKind, ta.value));
            return;
        }
        this._codeEditor = factory.createEditor(host, res.source || '', {
            language: 'python',
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            // Auto-size to source so the page (`.ea-agent-tab-content--code`)
            // handles the scroll, not the editor — the user asked for
            // full-height code with the page scrolling.
            noAutoHeight: false,
            scrollbar: { handleMouseWheel: false, alwaysConsumeMouseWheel: false },
        });
        if (this._codeEditor?.editor) {
            this._codeEditor.editor.onDidBlurEditorText(() => {
                const next = this._codeEditor.editor.getValue();
                this._saveCodeSource(marketKind, next);
            });
        }
    }

    async _saveCodeSource(marketKind, source) {
        try {
            const res = await (this._isBase
                ? window.pywebview?.api?.market_kind_code_set?.(marketKind, source)
                : window.pywebview?.api?.market_code_set?.(this.archetypeId, source));
            if (res?.ok === false) {
                toastError('Save code', res.error || 'save failed');
            }
        } catch (err) {
            toastError('Save code', String(err?.message || err));
        }
    }

    /** Mount the unified attribute-table editor for the kind's rules.
     *  Replaces the older bespoke form (_renderRulesFields + _renderField
     *  + _wireTemplateForm). Refs (currencies, asset kinds, …) are
     *  resolved into enum options at adapter time; dependsOn-driven
     *  changes trigger a refresh so dependent dropdowns repopulate. */
    /* ── mutations ────────────────────────────────────────────────── */

    async _onAddInstance() {
        const api = window.pywebview?.api;
        const a = this._archetype;
        if (!a) return;
        const usedIds = new Set((a.instances || []).map((i) => i.id));
        let n = 1;
        let iid = `branch_${n}`;
        while (usedIds.has(iid)) {
            n++;
            iid = `branch_${n}`;
            if (n > 999) break;
        }
        const res = await api?.market_instance_add?.(this.archetypeId, iid);
        if (res && res.ok === false) {
            toastError('Add branch failed', res.error);
            return;
        }
        await this._load();
        this._render();
        this.workspaceTabs?.notifyChanged?.('markets');
        this._openInstanceTab(iid);
    }

    async _onRemoveInstance(instanceId) {
        const ok = await openConfirm({
            title: 'Remove branch',
            message: `Remove branch <code>${esc(instanceId)}</code> from <code>${esc(this.archetypeId)}</code>?`,
            confirmLabel: 'Remove', danger: true,
        });
        if (!ok) return;
        const res = await window.pywebview?.api
            ?.market_instance_remove?.(this.archetypeId, instanceId);
        if (res && res.ok === false) {
            toastError('Remove branch failed', res.error);
            return;
        }
        this.workspaceTabs?.closeTab?.(`market:${this.archetypeId}.${instanceId}`);
        await this._load();
        this._render();
        this.workspaceTabs?.notifyChanged?.('markets');
    }

    async _onDeleteArchetype() {
        // A base kind isn't deletable through here (and its snake id collides
        // with a concrete market) — kinds are managed via the default library.
        if (this._isBase) return;
        const a = this._archetype;
        if (!a) return;
        const api = window.pywebview?.api;
        const nBranches = (a.instances || []).length;
        const msg = nBranches === 0
            ? `Delete market <code>${esc(a.id)}</code>?`
            : `Delete market <code>${esc(a.id)}</code> and its ${nBranches} ${nBranches === 1 ? 'branch' : 'branches'}? This cannot be undone.`;
        const ok = await openConfirm({
            title: 'Delete market', message: msg,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        const res = await api?.market_remove?.(this.archetypeId);
        if (res && res.ok === false) {
            toastError('Delete market failed', res.error);
            return;
        }
        for (const inst of (a.instances || [])) {
            this.workspaceTabs?.closeTab?.(`market:${a.id}.${inst.id}`);
        }
        if (this.tabId) this.workspaceTabs?.closeTab?.(this.tabId);
    }

    _openInstanceTab(instanceId) {
        const fullId = `${this.archetypeId}.${instanceId}`;
        this.workspaceTabs?.openTab({
            kind: 'market', entityId: fullId, label: fullId,
            icon: 'storefront', preview: true, from: 'market-archetype-tab',
        });
    }

    // ─── Requires editor ─────────────────────────────────────────────

    _renderRequiresEditor(host, a) {
        if (!host) return;
        const requires = Array.isArray(a.requires) ? a.requires : [];
        if (requires.length === 0) {
            host.innerHTML = '<div class="ea-bp-placeholder__hint">'
                + 'Nothing declared yet. Use <em>Add</em> to declare a dependency.'
                + '</div>';
            return;
        }
        host.innerHTML = `
            <table class="ea-table ea-archetype-viewer__attrs">
                <thead><tr>
                    <th>Entity kind</th>
                    <th>Id</th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${requires.map((r, i) => `
                        <tr data-row-idx="${i}">
                            <td><code>${esc(r.kind || '?')}</code></td>
                            <td><code>${esc(r.id || '?')}</code></td>
                            <td class="twm-row-actions-cell">
                                <button type="button"
                                        class="twm-row-action twm-row-action--danger"
                                        data-action="remove-requires"
                                        data-idx="${i}"
                                        title="Remove this dependency"
                                        aria-label="Remove">
                                    <span class="material-symbols-outlined">delete</span>
                                </button>
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>`;
        host.querySelectorAll('[data-action="remove-requires"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.idx);
                this._onRemoveRequires(a, idx);
            });
        });
    }

    async _onAddRequires(a) {
        const KIND_OPTIONS = [
            'asset_kind', 'sub_sector', 'sector', 'market', 'market_kind',
            'archetype', 'agent', 'kpi',
        ];
        const result = await openForm({
            title: 'Add required dependency',
            fields: [
                { id: 'kind', label: 'Entity kind', type: 'select',
                  options: KIND_OPTIONS.map((k) => ({ value: k, label: k })),
                  default: 'asset_kind' },
                { id: 'id',   label: 'Id', type: 'text',
                  placeholder: 'e.g. deposits, banks, …' },
            ],
            submitLabel: 'Add',
        });
        if (!result) return;
        const kind = String(result.kind || '').trim();
        const id   = String(result.id   || '').trim();
        if (!kind || !id) return;
        const next = [...(a.requires || []), { kind, id }];
        await this._saveRequires(next);
    }

    async _onRemoveRequires(a, idx) {
        const requires = Array.isArray(a.requires) ? a.requires : [];
        if (idx < 0 || idx >= requires.length) return;
        const next = requires.filter((_, i) => i !== idx);
        await this._saveRequires(next);
    }

    async _saveRequires(next) {
        const api = window.pywebview?.api;
        try {
            const res = await api?.market_set_requires?.(
                this.archetypeId, next);
            if (res && res.ok === false) {
                toastError('Save requires failed', res.error);
                return;
            }
        } catch (err) {
            toastError('Save requires failed', err?.message || String(err));
            return;
        }
        await this._load();
        this._render();
    }
}
