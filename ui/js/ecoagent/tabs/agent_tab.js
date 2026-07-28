/**
 * agent_tab.js — the archetype editor, as a workspace tab.
 *
 * Refactored out of agents_page.js: everything from the old
 * `_renderArchetypeEditor` down — the Settings / Brain / Observe /
 * Execute / Adjust sub-tab bar — scoped to one archetype. The sidebar
 * and the bottom panel are no longer this class's concern; the
 * population preview moved to the global bottom panel.
 *
 * Autosave everywhere — every field persists on change/blur via a
 * Bridge call. No explicit Save buttons.
 */

import { openForm, openConfirm } from '../ui/modal.js';
import { showContextMenu } from '../ui/context_menu.js';
import { openDistributionModal, distSummary as _distSummary } from '../ui/distribution_modal.js';
import {
    openMapEditor, openScheduleEditor, openStringListEditor,
    structuredSummary,
} from '../ui/typed_param_modal.js';
import { SlideOutPanel } from '../../ui/components/slide_out_panel.js';
import { AGENT_API_CHEATSHEET_HTML } from '../ui/agent_api_cheatsheet.js';
import { makeLoadingOverlay } from '../../tiling/loading_overlay.js';
import { esc, mountEditableTitle } from './_util.js';
import { openAgentDashboard } from '../ui/agent_dashboard.js';
import { ManagedWindow } from '../../ui/components/managed_window.js';

// Types the param table understands. Scalars are inline-editable;
// structured types (`map`, `schedule`, `string_list`) open a modal grid
// editor — the Default cell renders a summary button instead of a text
// field.
const PARAM_TYPES   = ['float', 'int', 'str', 'bool', 'choice',
                       'map', 'schedule', 'string_list'];
// Min / Max and the (continuous) distribution editor only apply to
// numeric scalars — everything else gets blank cells.
const PARAM_NUMERIC = (t) => t === 'float' || t === 'int';
// Structured (non-scalar) types — Default cell is a modal button.
const PARAM_STRUCTURED = (t) =>
    t === 'map' || t === 'schedule' || t === 'string_list';
// Empty-value seed used when the user flips a param's type to a
// structured one (or first creates one).
const _emptyStructured = (t) => {
    if (t === 'map') return {};
    if (t === 'schedule') return [];
    if (t === 'string_list') return [];
    return null;
};

// The archetype editor is split across these sub-tabs. The four
// loop sub-tabs map 1:1 onto the agent's loop bodies; `attributes`
// is the user-editable schema of typed slots (ref:asset, etc.)
// the loop bodies read via `self.attrs['name']`.
const AGENT_SUBTABS = [
    { id: 'settings',      label: 'Settings',      icon: 'tune' },
    // Attributes folds parameters + attributes into one row list.
    { id: 'attributes',    label: 'Attributes',    icon: 'data_object' },
    // Relationships now also surfaces the implementation verdict
    // (impl-% + method drift) inline at the top — there's no
    // separate Implementation sub-tab anymore.
    { id: 'relationships', label: 'Relationships', icon: 'hub' },
    // Godley P4 — the standalone read-only Godley sub-tab (#142) was
    // removed: the agent's declarative flow rows now live INTERLEAVED in
    // the Code sub-tab (§ pre-exec / post-exec Godley sections), where
    // they're editable. No separate Godley tab on agents (per spec).
    { id: 'population',    label: 'Instances',     icon: 'groups' },
    // Unified Code sub-tab — the live signature panel above the editor
    // tracks method drift as the user types. The standalone Signature
    // sub-tab was retired; the panel inside Code shows the same data
    // in a properly-styled surface.
    { id: 'code',          label: 'Code',          icon: 'code' },
];

// LOOP_HINTS removed alongside the per-loop sub-tabs. The unified Code
// editor shows the full agent .py file; per-body hints live in the
// help slide-out panel.


/** Factory registered with WorkspaceTabs for kind `agent`. */
export function makeAgentTab(hostEl, archetypeKey, ctx) {
    return new AgentArchetypeEditor(hostEl, archetypeKey, ctx);
}

class AgentArchetypeEditor {
    constructor(hostEl, archetypeKey, { logger, workspaceTabs, tabId, wm, leafId, windowId } = {}) {
        this.hostEl = hostEl;
        this.archetypeKey = archetypeKey;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        // WM handle + this tab's mount context — used to open a Code-tab pane
        // (Signature / Code / Godley) in a new tab or window via wm.navigate
        // without dismounting the source pane.
        this._wm = wm ?? null;
        this._leafId = leafId ?? null;
        this._windowId = windowId ?? null;
        this._archetype = null;
        this._sectors = [];
        this._currencies = [];
        this._countries = [];
        this._activeTab = this._loadSubTab();
        // Lazily-mounted Agent API help panel — same SlideOutPanel
        // control the dashboard tab uses for plot config, so the look
        // and dismissal (Esc, backdrop) match across the workspace.
        this._helpPanel = null;
    }

    async mount() {
        await this._loadData();
        this._render();
    }

    show() {}
    hide() {}

    /** WorkspaceTabs run-event fan-out — kept lightweight. */
    async refresh(reason) {
        if (reason === 'tick') {
            // Archetype config (params, accounts, loop bodies, Monaco
            // editors) is static — never rebuild that on tick. Two
            // surfaces genuinely change per tick:
            //  - Population sub-tab's "Live instances" host;
            //  - Settings tab's Archetype dashboard live-state slots.
            const content = this.hostEl?.querySelector('#ea-agent-tab-content');
            if (!content) return;
            if (content.contains(document.activeElement)) return;
            if (this._activeTab === 'population') {
                try { await this._renderLiveInstances(content); }
                catch (err) { this.logger.warn?.('live instances refresh failed', { err }); }
            } else if (this._activeTab === 'settings') {
                const tab = content.querySelector('.ea-agent-tab--settings');
                if (tab) {
                    try { await this._refreshArchetypeDashboard(tab); }
                    catch { /* ignore — dashboard is best-effort */ }
                }
            }
            return;
        }
        await this._loadData();
        if (!this._archetype) return;
        // Code tabs hold live Monaco editors and loop bodies only change
        // via the editor itself — never auto-re-render those. Re-render
        // the lightweight Settings tab only when nothing here is focused.
        if (this._activeTab === 'settings'
            && !this.hostEl.contains(document.activeElement)) {
            this._renderActiveTab();
        }
        const h2 = this.hostEl.querySelector('.ea-detail-header h2');
        if (h2) h2.textContent = this._archetype.label || this._archetype.archetype;
    }

    /** Jump to a sub-tab (used by the sidebar's expandable archetype nav). */
    focusSubTab(tabId) {
        if (AGENT_SUBTABS.some((t) => t.id === tabId)) this._switchTab(tabId);
    }

    dispose() {
        try { this._codeEditor?.dispose?.(); } catch { /* ignore */ }
        this._codeEditor = null;
        for (const k of Object.keys(this._loopEditors || {})) {
            try { this._loopEditors[k]?.dispose?.(); } catch { /* ignore */ }
        }
        this._loopEditors = {};
        try { this._liveSigCtl?.destroy?.(); } catch { /* ignore */ }
        this._liveSigCtl = null;
        try { this._codeToggleCtl?.destroy?.(); } catch { /* ignore */ }
        this._codeToggleCtl = null;
        try { this._attrsEditor?.dispose?.(); } catch { /* ignore */ }
        this._attrsEditor = null;
        try { this._relationsEditor?.dispose?.(); } catch { /* ignore */ }
        this._relationsEditor = null;
        try { this._helpPanel?.dispose?.(); } catch { /* ignore */ }
        this._helpPanel = null;
        try { this._variationsTeardown?.(); } catch { /* ignore */ }
        this._variationsTeardown = null;
        try { this._variationsKbd?.teardown?.(); } catch { /* ignore */ }
        this._variationsKbd = null;
        // Close any per-instance dashboard/param windows this tab opened —
        // their action buttons are wired to this (now-disposed) editor.
        for (const win of (this._instWins?.values?.() || [])) {
            try { win.close?.({ force: true }); } catch { /* ignore */ }
        }
        try { this._instWins?.clear?.(); } catch { /* ignore */ }
    }

    // --------------------------------------------------------------- data flow

    async _loadData() {
        try {
            const [archetypes, sectors, currencies, countries]
                = await Promise.all([
                    window.pywebview?.api?.agents_list?.()  ?? [],
                    window.pywebview?.api?.sectors_list?.()     ?? [],
                    window.pywebview?.api?.currencies_list?.()  ?? [],
                    window.pywebview?.api?.countries_list?.()   ?? [],
                ]);
            this._allArchetypes = Array.isArray(archetypes) ? archetypes : [];
            this._archetype = this._allArchetypes
                .find((a) => a.archetype === this.archetypeKey) || null;
            this._sectors = Array.isArray(sectors) ? sectors : [];
            this._currencies = Array.isArray(currencies) ? currencies : [];
            this._countries = Array.isArray(countries) ? countries : [];
        } catch (err) {
            this.logger.warn?.('agent tab fetch failed', { err });
        }
    }

    /** V1 — variations whose `parent` field matches this agent's id.
     *  Returns [] when this entity has no children. */
    _variationsOfThis() {
        const list = this._allArchetypes || [];
        return list.filter((a) => String(a?.parent || '') === this.archetypeKey);
    }

    /** T6.1 / R1 — implementation-% chip in the archetype header.
     *  Shows how much of the parent archetype's required contract this
     *  archetype implements. Colour scales red → amber → green; the
     *  chip also calls out missing required methods (which are
     *  100%-or-nothing per R1, separate signal from attribute %). */
    async _updateImplBadge() {
        const el = this.hostEl?.querySelector('[data-role="impl-badge"]');
        if (!el) return;
        try {
            const res = await window.pywebview?.api?.implementation_percent?.(
                'archetype', this.archetypeKey,
            );
            if (!res?.ok || !res.has_parent) {
                el.hidden = true; el.innerHTML = '';
                return;
            }
            const pct  = Number(res.percent || 0);
            const hue  = Math.max(0, Math.min(120, Math.round(pct * 1.2)));
            const okM  = !!res.methods_complete;
            el.hidden = false;
            el.innerHTML = `
                <span class="material-symbols-outlined ea-impl-badge__icon">checklist</span>
                <span class="ea-impl-badge__label">Contract</span>
                <span class="ea-impl-badge__pct"
                      style="color: hsl(${hue} 65% 50%)"
                      title="${res.attrs_implemented}/${res.attrs_total} required attributes implemented">
                    ${pct}%
                </span>
                ${okM ? '' : `
                    <span class="ea-impl-badge__methods"
                          title="${res.methods_implemented}/${res.methods_total} required methods implemented">
                        ⚠ ${res.methods_total - res.methods_implemented} method${
                            (res.methods_total - res.methods_implemented) === 1 ? '' : 's'
                        }
                    </span>`}
            `;
        } catch (err) {
            el.hidden = true;
        }
    }

    /** Inline hint under the Identity form — shows the derived
     *  country / currency / CB status (read-only; managed on the
     *  country, not the agent). Empty when the agent has no sector. */
    _renderCountryHintHtml() {
        const ctx = this._resolveCountryContext();
        if (!ctx) return '';
        const { sector, country, currency, isCB } = ctx;
        if (!sector) return '';
        if (!country) {
            return `
                <p class="ea-card__hint ea-card__hint--warning">
                    Sector <code>${esc(sector.id)}</code> is not assigned to
                    a country. Currency context cannot resolve — edit the
                    sector in the SFC sidebar to bind it to one.
                </p>
            `;
        }
        const ccyLabel = currency
            ? `${esc(currency.id)}${currency.symbol ? ' ' + esc(currency.symbol) : ''}`
            : esc(country.currency);
        const cbBadge = isCB
            ? ' <span class="ea-badge ea-badge--ok">central bank for this country</span>'
            : '';
        return `
            <p class="ea-card__hint">
                <b>Country:</b> ${esc(country.label || country.id)}
                &nbsp;·&nbsp; <b>Currency:</b> ${ccyLabel}${cbBadge}
                <br><small>Derived from sector → country. Edit on the
                country, not here.</small>
            </p>
        `;
    }

    /** Resolve "what country / currency does this archetype operate in?"
     *  from sector → country → currency. Banks may additionally be the
     *  central bank for their country (when country.central_bank ==
     *  this archetype). Returns a small dict the Settings tab renders
     *  as a derived hint. */
    _resolveCountryContext() {
        const a = this._archetype;
        if (!a || !a.default_sector) return null;
        const sector = (this._sectors || []).find((s) => s.id === a.default_sector);
        if (!sector || !sector.country) return { sector };
        const country = (this._countries || []).find((c) => c.id === sector.country);
        if (!country) return { sector };
        const currency = (this._currencies || []).find((c) => c.id === country.currency);
        const isCB = (a.role === 'bank') && (country.central_bank === a.archetype);
        return { sector, country, currency, isCB };
    }

    /** Re-fetch + full re-render (used after an autosave on the Settings tab). */
    async _reloadAndRender() {
        await this._loadData();
        this._render();
    }

    // ------------------------------------------------------------------ render

    _render() {
        try { this._codeEditor?.dispose?.(); } catch { /* ignore */ }
        this._codeEditor = null;
        try { this._liveSigCtl?.destroy?.(); } catch { /* ignore */ }
        this._liveSigCtl = null;
        const a = this._archetype;
        if (!a) {
            this.hostEl.innerHTML = `
                <div class="ea-agent-editor">
                    <div class="ea-agents__empty">
                        Archetype not found — it may have been removed.
                    </div>
                </div>
            `;
            return;
        }

        const variationCount = this._variationsOfThis().length;
        const parentKey = String(a.parent || '').trim();
        // Type chip + parent link. A kind is abstract; a concrete agent
        // inherits one:
        //   • agent kind (no parent) → "agent kind · N agents"
        //   • concrete agent (parent) → "agent · inherits <kind>"
        const typeBadgeHtml = parentKey
            ? `<span class="ea-badge ea-badge--variation"
                     title="An agent that inherits the ${esc(parentKey)} kind">
                   agent · inherits
                   <a href="#" data-action="open-parent"
                      data-parent-id="${esc(parentKey)}">${esc(parentKey)}</a>
               </span>`
            : `<span class="ea-badge ea-badge--agent"
                     title="An agent kind — agents inherit from it">
                   agent kind${variationCount > 0
                       ? ` · ${variationCount} agent${variationCount === 1 ? '' : 's'}`
                       : ''}
               </span>`;

        this.hostEl.innerHTML = `
            <div class="ea-agent-editor">
                <header class="ea-detail-header">
                    <div data-role="title-slot"></div>
                    <span class="ea-badge">${esc(a.archetype)}</span>
                    ${typeBadgeHtml}
                    ${a.builtin ? '<span class="ea-badge ea-badge--muted">built-in</span>' : ''}
                    <span class="ea-impl-badge" data-role="impl-badge" hidden></span>
                    <span class="ea-detail-header__spacer"></span>
                    <button type="button" class="ea-btn ea-btn--small"
                            id="ea-archetype-api-help"
                            title="Agent API reference (Esc to close)">
                        <span class="material-symbols-outlined">help</span>
                        API help
                    </button>
                    <button type="button" class="ea-btn ea-btn--small"
                            id="ea-archetype-popout"
                            title="Pop this agent tab out into a floating window">
                        <span class="material-symbols-outlined">open_in_new</span>
                        Pop out
                    </button>
                    <button type="button" class="ea-btn ea-btn--small ea-btn--danger"
                            data-action="delete"
                            title="Delete this archetype">
                        <span class="material-symbols-outlined">delete</span>
                        Delete
                    </button>
                </header>
                <div class="nb-structured-editor__tabs" id="ea-agent-tabs"></div>
                <div class="nb-structured-editor__content" id="ea-agent-tab-content"></div>
            </div>
        `;

        const tabBar = this.hostEl.querySelector('#ea-agent-tabs');
        // V1 — base agents get a "Variations" sub-tab that lists
        // child variations of this agent. Variations themselves don't
        // (they can't have children — registered architecture is
        // single-level inheritance; nesting is allowed by the resolver
        // but never exposed in the UI to keep the mental model simple).
        // Variations sub-tab is parent-only — variants don't fork
        // further. The signature surface lives inside the Code tab's
        // live-signature panel; there is no separate Signature sub-tab.
        const subTabs = parentKey
            ? AGENT_SUBTABS
            : [
                ...AGENT_SUBTABS.slice(0, 3),    // Settings, Attributes, Relationships
                { id: 'variations',
                  label: variationCount > 0
                    ? `Agents (${variationCount})`
                    : 'Agents',
                  icon: 'fork_right' },
                ...AGENT_SUBTABS.slice(3),       // Instances, Code
            ];
        // The restored sub-tab may not exist for this agent — fall back.
        if (!subTabs.some((t) => t.id === this._activeTab)) this._activeTab = 'settings';
        for (const tab of subTabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nb-structured-editor__tab'
                + (tab.id === this._activeTab ? ' active' : '');
            btn.dataset.tab = tab.id;
            btn.innerHTML = `<span class="material-symbols-outlined">${tab.icon}</span> ${tab.label}`;
            btn.addEventListener('click', () => this._switchTab(tab.id));
            tabBar.appendChild(btn);
        }
        // Parent link in the header badge → navigate to the parent
        // agent's editor inside the same tile (records back-history).
        this.hostEl.querySelector('[data-action="open-parent"]')
            ?.addEventListener('click', (e) => {
                e.preventDefault();
                const pid = e.currentTarget?.dataset?.parentId;
                if (!pid) return;
                this.workspaceTabs?.openTab?.({
                    kind: 'agent', entityId: pid, label: pid,
                });
            });

        this.hostEl.querySelector('#ea-archetype-popout')
            ?.addEventListener('click', () => {
                if (this.tabId) this.workspaceTabs?.popOutTab?.(this.tabId);
            });
        this.hostEl.querySelector('#ea-archetype-api-help')
            ?.addEventListener('click', () => this._openApiHelp());
        this.hostEl.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDeleteArchetype());

        // Editable header title — double-click or pencil button.
        // Syncs to the Identity card's Label input so the existing
        // autosave path persists the rename without duplicating logic.
        const titleSlot = this.hostEl.querySelector('[data-role="title-slot"]');
        this._titleCtl?.dispose?.();
        this._titleCtl = mountEditableTitle(titleSlot, {
            value: a.label || a.archetype,
            placeholder: a.archetype,
            tag: 'h2',
            onCommit: (next) => {
                const labelInput = this.hostEl.querySelector('[data-field="label"]');
                if (labelInput) {
                    labelInput.value = next;
                    // Re-use the Identity card's autosave path.
                    labelInput.dispatchEvent(new Event('change', { bubbles: true }));
                    labelInput.dispatchEvent(new Event('blur', { bubbles: true }));
                }
            },
        });

        this._renderActiveTab();
        // Impl-% badge is the contract surface for variants.
        this._updateImplBadge();
    }

    _subTabKey() { return `ea-agent-subtab:${this.archetypeKey}`; }

    /** Last-open sub-tab (persisted per agent), default Settings. */
    _loadSubTab() {
        try { return localStorage.getItem(this._subTabKey()) || 'settings'; }
        catch { return 'settings'; }
    }

    _switchTab(tabId) {
        if (tabId === this._activeTab) return;
        this._activeTab = tabId;
        try { localStorage.setItem(this._subTabKey(), tabId); } catch { /* ignore */ }
        const tabBar = this.hostEl.querySelector('#ea-agent-tabs');
        tabBar?.querySelectorAll('.nb-structured-editor__tab').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        this._renderActiveTab();
    }

    _renderActiveTab() {
        const content = this.hostEl.querySelector('#ea-agent-tab-content');
        if (!content) return;
        try { this._codeEditor?.dispose?.(); } catch {}
        this._codeEditor = null;
        for (const k of Object.keys(this._loopEditors || {})) {
            try { this._loopEditors[k]?.dispose?.(); } catch {}
        }
        this._loopEditors = {};
        try { this._liveSigCtl?.destroy?.(); } catch {}
        this._liveSigCtl = null;
        try { this._codeToggleCtl?.destroy?.(); } catch {}
        this._codeToggleCtl = null;
        try { this._attrsEditor?.dispose?.(); } catch {}
        this._attrsEditor = null;
        try { this._relationsEditor?.dispose?.(); } catch {}
        this._relationsEditor = null;

        const isCode = (this._activeTab === 'code');
        content.classList.toggle('ea-agent-tab-content--code', isCode);
        // Instances sub-tab fills the panel: turn the scroll body into a
        // flex column so the instances table stretches to the bottom and
        // scrolls internally (see instances.css). Toggled off for every
        // other sub-tab, which keep the default page-scroll body.
        content.classList.toggle('ea-agent-tab-content--instances',
            this._activeTab === 'population');
        content.innerHTML = '';

        if (this._activeTab === 'code')                this._renderCodeTab(content);
        else if (this._activeTab === 'attributes')     this._renderAttributesTab(content);
        else if (this._activeTab === 'relationships')  this._renderRelationshipsTab(content);
        else if (this._activeTab === 'population')     this._renderPopulationTab(content);
        else if (this._activeTab === 'variations')     this._renderVariationsTab(content);
        else                                            this._renderSettingsTab(content);
    }

    /** Parameters sub-tab — the sampled-once knobs that materialise as
     *  per-instance `self.<name>` at world start. Same bespoke table
     *  the Settings tab used to host; lifted into its own sub-tab so
     *  the surface matches the rest of the agent editor's chrome
     *  (Identity / Attributes / Parameters / Relationships / …)
     *  rather than burying the parameter editor under Settings. The
     *  table renderer (`_renderParamsTable`) is unchanged and keeps
     *  every existing affordance (distribution modal, structured-type
     *  editors, choice list, min/max). */
    /** Insert a blank param row inline + persist on first valid name.
     *  Replaces the modal-based `_onAddParam`. Matches the asset_kind
     *  attribute editor's pattern: + button → blank row → user types
     *  → on blur, commit. */
    async _onAddParamInline() {
        // Synthesise an empty ParamSpec dict and append it to the
        // archetype's in-memory params list. Re-render to mount the
        // new row through mountAttributeListEditor (which carries the
        // inheritance grammar + custom cells). The bridge sees the new
        // param only when the user fills in a name and blurs; an empty
        // row gets discarded by the next render if nothing's typed.
        const a = this._archetype;
        if (!a) return;
        // The bridge expects an explicit add — create a placeholder
        // with a generated name so the row is real. The user can then
        // rename in place.
        const used = new Set((a.params || []).map((p) => p.name));
        let n = (a.params || []).length + 1;
        let name = `param_${n}`;
        while (used.has(name)) { n += 1; name = `param_${n}`; }
        const res = await window.pywebview?.api?.agent_param_add?.(
            this.archetypeKey, name, 'float', 0,
        );
        if (res?.ok === false) {
            this.logger.warn?.(res.error);
            return;
        }
        await this._reloadAndRender();
        // Focus the new row's name cell so the user can rename
        // immediately. The unified editor renders the last row last,
        // so query for it after the re-render lands.
        requestAnimationFrame(() => {
            const rows = this.hostEl.querySelectorAll(
                '#ea-param-table .ea-attr-editor__row');
            const last = rows[rows.length - 1];
            const nameInput = last?.querySelector('input[type="text"]');
            nameInput?.focus();
            nameInput?.select();
        });
    }

    /** Mount the shared Relationships helper so every entity editor
     *  renders the same Inherits / Out-refs / Dependencies / Used-by
     *  cards. The earlier bespoke implementation here drifted from the
     *  others; the shared helper now handles parent inheritance +
     *  origin column natively, so there's nothing agent-specific to
     *  fold in. */
    async _renderRelationshipsTab(content) {
        const a = this._archetype;
        // Stack: an implementation-verdict card at the top (impl-% +
        // method drift) followed by the shared Relationships widget.
        // The Implementation sub-tab was retired; this one tab now
        // surfaces both contract health AND the dependency graph.
        content.innerHTML = `
            <section data-role="impl-verdict-host">
                <p class="ea-card__hint ea-card__hint--show">
                    Loading implementation status…
                </p>
            </section>
            <div data-role="relationships-host"></div>
        `;
        // Mount the relationships widget right away (it doesn't depend
        // on the verdict).
        const relHost = content.querySelector('[data-role="relationships-host"]');
        const { mountRelationshipsTab } = await import('./_relationships.js');
        await mountRelationshipsTab(relHost, {
            entity_kind:    'archetype',
            id:             this.archetypeKey,
            workspaceTabs:  this.workspaceTabs,
        });
        // Fetch + render the implementation verdict.
        const verdictHost = content.querySelector('[data-role="impl-verdict-host"]');
        if (!a || !verdictHost) return;
        try {
            const [impl, scan] = await Promise.all([
                window.pywebview?.api?.implementation_percent?.(
                    'archetype', a.archetype),
                window.pywebview?.api?.entity_scan_methods?.(
                    'agent', a.archetype),
            ]);
            const parentId = (a.parent || '').trim();
            const parentEntry = parentId
                ? (this._allArchetypes || []).find(
                    (x) => (x.archetype || x.id) === parentId)
                : null;
            const { renderImplementationVerdict } = await import(
                './parent_child_detail.js');
            verdictHost.innerHTML = renderImplementationVerdict({
                child:  a,
                parent: parentEntry,
                impl:   impl,
                scan:   scan,
                parentKindLabel: 'agent',
            });
        } catch (err) {
            this.logger.warn?.('implementation render failed', { err });
            verdictHost.innerHTML = `
                <p class="ea-card__hint ea-card__hint--show">
                    Failed to load implementation status.
                </p>`;
        }
    }

    /** V1 — Variations sub-tab. Only mounts on a base agent (the
     *  parent-key branch in `_render` decides whether to even show
     *  this tab). Lists variations of this agent in a DataTable; each
     *  row opens the variation's editor on click. The "New variation"
     *  button delegates to the same agent_add(parent=…) bridge
     *  path the agents-landing uses, then refreshes. */
    async _renderVariationsTab(content) {
        const { DataTable } = await import('../../ui/components/data_table.js');
        const { openForm } = await import('../ui/modal.js');
        const { toastError } = await import('../ui/toast.js');
        const { attachLandingTableBehavior, attachLandingKeyboardNav } =
            await import('../../tiling/landing_table.js');
        content.innerHTML = `
            <section class="ea-card">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">Agents of this kind</h3>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-role="new-variation"
                            title="Create a new agent of this kind">
                        <span class="material-symbols-outlined">fork_right</span>
                        New agent
                    </button>
                </div>
                <p class="ea-card__hint">
                    Agents inherit this kind's accounts, loop bodies, and
                    parameter shape. They override individual attributes
                    (e.g. <code>marginal_cost</code> or <code>capacity</code>)
                    and carry the population. Click a row to edit one.
                </p>
                <div data-role="variations-host"></div>
            </section>
        `;
        const host = content.querySelector('[data-role="variations-host"]');
        const variations = this._variationsOfThis();
        if (variations.length === 0) {
            host.innerHTML =
                '<div class="ea-table__empty">'
                + 'No agents yet — use the button below to add one.'
                + '</div>';
        } else {
            const table = new DataTable(host, {
                headers: ['Name', 'Id', 'Sector', 'Population'],
                rows: variations.map((v) => [
                    v.label || v.archetype,
                    v.archetype,
                    v.default_sector || '',
                    String(v.population ?? ''),
                ]),
                pageSize: 200, pagination: false,
                sortable: true, filterable: true,
                selectable: true, copyable: true,
            });
            table.render();
            // Plain row click → open the agent's editor. Use the shared
            // landing helper rather than a hand-rolled tbody listener:
            // this table is `sortable` + `filterable`, so DataTable rebuilds
            // its <tbody> on the first sort / filter / page change and a
            // listener bound to that tbody goes silently dead (the exact
            // failure landing_table.js documents). attachLandingTableBehavior
            // binds on the stable host and resolves the row at event time,
            // so it survives any number of re-renders — and gives us the
            // right-click Open menu for free.
            const openVariation = (v) => {
                if (!v) return;
                this.workspaceTabs?.openTab?.({
                    kind: 'agent',
                    entityId: v.archetype,
                    label: v.label || v.archetype,
                });
            };
            try { this._variationsTeardown?.(); } catch { /* ignore */ }
            this._variationsTeardown = attachLandingTableBehavior(
                host,
                (idx) => variations[idx],
                { open: openVariation },
            );
            // Arrow-key navigation — same UX as the landing tables and the
            // market-kind instances table. Installs ArrowUp/Down + Home/End
            // cursor movement and routes Enter to open the row, painting
            // `.ea-row-cursor` on the focused `<tr>`. Routed through the
            // panel-key router so it only fires when this tab's leaf is
            // focused. Torn down in `dispose()`.
            try { this._variationsKbd?.teardown?.(); } catch { /* ignore */ }
            this._variationsKbd = attachLandingKeyboardNav(
                host,
                () => variations,
                openVariation,
            );
            this._variationsTable = table;
        }
        content.querySelector('[data-role="new-variation"]')
            ?.addEventListener('click', async () => {
                const data = await openForm({
                    title: 'New agent',
                    submitLabel: 'Create',
                    fields: [
                        { name: 'name', label: 'Name', type: 'text',
                          required: true,
                          placeholder: 'e.g. State energy producer' },
                    ],
                });
                if (!data?.name) return;
                const id = String(data.name).trim().toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
                if (!id) {
                    toastError('New agent', 'invalid name');
                    return;
                }
                try {
                    const res = await window.pywebview?.api?.agent_add?.(
                        id, data.name, null, 1, null, null, false, null,
                        this.archetypeKey,
                    );
                    if (res?.ok === false) {
                        toastError('New agent', res.error || 'add failed');
                        return;
                    }
                } catch (err) {
                    toastError('New agent',
                        String(err?.message || err));
                    return;
                }
                await this._reloadAndRender();
                this.workspaceTabs?.openTab?.({
                    kind: 'agent', entityId: id, label: data.name,
                });
            });
    }

    // -------------------------------------------------------- Instances tab
    //
    // The materialized-population surface (docs/AGENT_INSTANCES_CONTROL.md): a
    // LIST of the variant's sampled instances; selecting one opens an inline
    // override editor — the same param-row "override grid" that markets and
    // scenarios use (`.ea-scen-*`) — where you pin a parameter, exclude the
    // instance, or re-roll it. Pins are durable (committed to the variant
    // `.py`); the draw is a pure function of (variant spec, seed), so Shuffle
    // re-rolls a new seed for the un-pinned instances.

    async _renderPopulationTab(content) {
        content.innerHTML = `
            <section class="ea-card ea-inst">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">Instances</h3>
                    <span class="ea-card__head-aside" data-role="pop-count">…</span>
                </div>
                <p class="ea-card__hint">
                    Each instance is a draw from this variant's parameter
                    distributions. Select one to open its dashboard and edit
                    its parameters in a window — pin a parameter, exclude it, or
                    re-roll its draw. <strong>Shuffle</strong> re-draws every
                    un-pinned instance.
                </p>
                <div class="ea-inst__toolbar" data-role="inst-toolbar"></div>
                <div class="ea-inst__list" data-role="inst-list">Loading…</div>
            </section>`;
        await this._loadInstances(content);
    }

    /** Design-time surface, not a per-tick monitor, so the tick refresh is a
     *  no-op (rebuilding on tick would also eat in-flight clicks). Live per-tick
     *  state is in the per-instance dashboard window. */
    async _renderLiveInstances() { /* intentionally empty */ }

    get _instContentEl() {
        return this.hostEl?.querySelector('#ea-agent-tab-content');
    }

    async _loadInstances(content) {
        const api = window.pywebview?.api;
        const listHost = content.querySelector('[data-role="inst-list"]');
        const bar = content.querySelector('[data-role="inst-toolbar"]');
        const count = content.querySelector('[data-role="pop-count"]');
        if (!listHost) return;
        let view = null;
        try { view = await api?.agent_variant_instances_view?.(this.archetypeKey); }
        catch (err) { this.logger.warn?.('instances view failed', { err }); }
        if (!view || view.ok === false) {
            bar.innerHTML = '';
            listHost.innerHTML = `<div class="ea-bp-placeholder"><p>${
                esc(view?.error || 'Could not load instances.')}</p></div>`;
            count.textContent = ''; return;
        }
        if (!view.is_variant) {
            bar.innerHTML = '';
            listHost.innerHTML = `<div class="ea-bp-placeholder"><p>This is an
                abstract agent <em>kind</em> — open one of its variants to
                materialize and control instances.</p></div>`;
            count.textContent = ''; return;
        }
        this._instView = view;
        const rows = this._instRows(view);
        const nExcl = rows.filter((r) => r.excluded).length;
        count.textContent = `${view.population} instance${view.population === 1 ? '' : 's'}`
            + (nExcl ? ` · ${nExcl} excluded` : '');
        bar.innerHTML = this._instToolbarHtml(view);
        this._wireInstToolbar(content);
        await this._renderInstanceList(listHost, rows);
        // The per-instance editor now lives in a window (see
        // `_openInstanceWindow`), not below the list. Just forget the
        // selection if its slot no longer exists — mutation handlers refresh
        // any open instance windows themselves.
        if (!(this._instSelectedSlot != null && this._instSelectedSlot < view.population)) {
            this._instSelectedSlot = null;
        }
    }

    /** The full slot list 0..N-1 (materialized rows + excluded gaps), each with
     *  its override status. */
    _instRows(view) {
        const byId = {};
        for (const r of view.instances) byId[r.id] = r;
        const ovBySlot = {};
        for (const o of view.overrides) ovBySlot[o.index] = o;
        const rows = [];
        for (let slot = 0; slot < view.population; slot++) {
            const id = `${view.archetype}-${slot}`;
            const ov = ovBySlot[slot];
            rows.push({
                slot, id,
                inst: byId[id] || null,
                excluded: !!(ov && ov.excluded),
                pinned: !!(ov && ov.params && Object.keys(ov.params).length),
                reroll: !!(ov && (ov.reroll_nonce | 0) > 0),
            });
        }
        return rows;
    }

    _instToolbarHtml() {
        return `
            <div class="ea-inst__tb-group">
                <button class="ea-btn ea-btn--sm" data-act="shuffle"
                        title="Re-roll every un-pinned instance from a new seed">
                    <span class="material-symbols-outlined">casino</span>Shuffle</button>
            </div>
            <div class="ea-inst__tb-group ea-inst__tb-right">
                <button class="ea-btn ea-btn--sm" data-act="import-csv"
                        title="Import pins / exclusions from CSV">
                    <span class="material-symbols-outlined">upload</span></button>
                <button class="ea-btn ea-btn--sm" data-act="export-csv"
                        title="Export the population to CSV">
                    <span class="material-symbols-outlined">download</span></button>
            </div>`;
    }

    _wireInstToolbar(content) {
        const api = window.pywebview?.api;
        content.querySelector('[data-role="inst-toolbar"]')
            ?.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const act = btn.dataset.act;
                if (act === 'shuffle') {
                    await this._instDo(api?.agent_variant_shuffle?.(this.archetypeKey));
                    await this._refreshAllOpenInstanceWindows();
                } else if (act === 'export-csv') this._instExportCsv();
                else if (act === 'import-csv') this._instImportCsv();
            });
        });
    }

    async _renderInstanceList(host, rows) {
        const { DataTable } = await import('../../ui/components/data_table.js');
        const { attachLandingTableBehavior } =
            await import('../../tiling/landing_table.js');
        const statusOf = (r) => {
            const s = [];
            if (r.excluded) s.push('excluded');
            if (r.pinned) s.push('pinned');
            if (r.reroll) s.push('rerolled');
            return s.join(' · ') || '—';
        };
        host.innerHTML = '';
        const table = new DataTable(host, {
            headers: ['#', 'Id', 'Status'],
            rows: rows.map((r) => [String(r.slot), r.id, statusOf(r)]),
            pageSize: 500, pagination: false,
            sortable: true, filterable: rows.length > 12, copyable: true,
        });
        table.render();
        try { this._instListTeardown?.(); } catch { /* ignore */ }
        this._instListTeardown = attachLandingTableBehavior(
            host, (idx) => rows[idx],
            { open: (r) => { if (r) this._selectInstance(r.slot); } },
        );
    }

    /** Selecting an instance opens (or refocuses) a single window that
     *  unifies the instance dashboard with its editable parameter overrides —
     *  the editor no longer renders inline below the table (docs
     *  AGENT_INSTANCES_CONTROL.md). */
    _selectInstance(slot) {
        this._instSelectedSlot = slot;
        this._openInstanceWindow(slot);
    }

    /** Window id `openAgentDashboard` mints for one instance (agent id is
     *  `<archetype>-<slot>`); used to check whether it's currently open. */
    _instWinId(slot) { return `ea-agent-dashboard:${this.archetypeKey}-${slot}`; }

    /** Build the sample the dashboard renders — the live-run snapshot when a
     *  world is running, else the design-time draw from the instances view. */
    async _instSampleForSlot(slot) {
        const id = `${this.archetypeKey}-${slot}`;
        const api = window.pywebview?.api;
        let sample = null;
        try {
            const live = await api?.world_live_population?.(this.archetypeKey, 1000);
            sample = (live?.samples || []).find((s) => s.agent_id === id) || null;
        } catch { /* not running */ }
        if (!sample) {
            const r = (this._instView?.instances || []).find((x) => x.id === id);
            sample = { agent_id: id, params: r?.params || {},
                       accounts: r?.accounts || [], brain: null };
        }
        return sample;
    }

    /** Open / refresh the unified dashboard-and-parameter-editor window for a
     *  slot. Reuses `openAgentDashboard`'s ManagedWindow (composed, not
     *  duplicated) and injects the editable override editor as its Parameters
     *  section. Tracked so `dispose()` can close it. */
    async _openInstanceWindow(slot) {
        if (!this._instView) return null;
        const editorEl = this._buildInstanceEditorEl(slot);
        const sample = await this._instSampleForSlot(slot);
        const win = await openAgentDashboard({
            archetype: this.archetypeKey, sample, editorEl,
        });
        if (win) (this._instWins ||= new Map()).set(slot, win);
        return win;
    }

    /** Re-open (rebuild the content of) a slot's window only if it's currently
     *  open — used after a mutation so the draw / overrides shown stay live. */
    async _refreshInstanceWindowIfOpen(slot) {
        const win = ManagedWindow.get?.(this._instWinId(slot));
        if (win && win.isVisible) await this._openInstanceWindow(slot);
    }

    /** Refresh every open instance window (after a bulk mutation — Shuffle,
     *  CSV import — that re-rolls or repins many slots at once). */
    async _refreshAllOpenInstanceWindows() {
        const pop = this._instView?.population || 0;
        for (let slot = 0; slot < pop; slot++) {
            const win = ManagedWindow.get?.(this._instWinId(slot));
            // eslint-disable-next-line no-await-in-loop
            if (win && win.isVisible) await this._openInstanceWindow(slot);
        }
    }

    /** Build the editable per-instance override surface — the `.ea-scen-*`
     *  param-row grid (blank override = use the draw; a value pins it) plus
     *  the reroll / exclude / reset actions. Returned as a detached element so
     *  it can be mounted inside the dashboard window's Parameters section. */
    _buildInstanceEditorEl(slot) {
        const view = this._instView;
        if (!view) return null;
        const id = `${view.archetype}-${slot}`;
        const inst = view.instances.find((r) => r.id === id) || null;
        const ov = view.overrides.find((o) => o.index === slot) || null;
        const excluded = !!(ov && ov.excluded);
        const pins = (ov && ov.params) || {};
        const hasOverrides = Object.keys(pins).length > 0 || excluded
            || (ov && (ov.reroll_nonce | 0) > 0);

        const paramRows = view.param_specs.map((p) => {
            const drawn = inst ? inst.params?.[p.name] : undefined;
            const pinned = Object.prototype.hasOwnProperty.call(pins, p.name);
            const numeric = p.type === 'float' || p.type === 'int';
            return `
                <tr class="ea-scen-row${pinned ? ' ea-scen-row--overridden' : ''}">
                    <td class="ea-scen-row__name"><code>${esc(p.name)}</code></td>
                    <td class="ea-scen-row__type">${esc(p.type || '')}</td>
                    <td class="ea-scen-row__baseline">${esc(_fmtVal(drawn))}</td>
                    <td class="ea-scen-row__override">
                        <input class="ea-scen-input" data-param-input="${esc(p.name)}"
                               type="${numeric ? 'number' : 'text'}"
                               ${numeric && p.min != null ? `min="${esc(p.min)}"` : ''}
                               ${numeric && p.max != null ? `max="${esc(p.max)}"` : ''}
                               value="${pinned ? esc(pins[p.name]) : ''}"
                               placeholder="draw"></td>
                </tr>`;
        }).join('');

        const el = document.createElement('div');
        el.className = 'ea-inst__editor ea-inst__editor--windowed';
        el.innerHTML = `
            <div class="ea-inst__editor-head">
                <div class="ea-inst__editor-actions">
                    <button class="ea-btn ea-btn--sm" data-eact="watch">Watch</button>
                    <button class="ea-btn ea-btn--sm" data-eact="reroll">Reroll</button>
                    <button class="ea-btn ea-btn--sm" data-eact="${excluded ? 'restore' : 'exclude'}">
                        ${excluded ? 'Restore' : 'Exclude'}</button>
                    <button class="ea-btn ea-btn--sm" data-eact="reset" ${hasOverrides ? '' : 'disabled'}>
                        Reset</button>
                </div>
                ${excluded ? '<span class="ea-inst__chip ea-inst__chip--excl">excluded</span>' : ''}
            </div>
            ${excluded
                ? '<p class="ea-inst__editor-note">Excluded from the next run — Restore to bring it back.</p>'
                : `<table class="ea-table ea-scen-table ea-inst__override-table">
                     <thead><tr><th>Parameter</th><th>Type</th><th>Draw</th><th>Override</th></tr></thead>
                     <tbody>${paramRows}</tbody>
                   </table>`}`;
        this._wireInstanceEditor(el, slot);
        return el;
    }

    /** Wire the override inputs + action buttons of an instance editor element
     *  (mounted inside the dashboard window). */
    _wireInstanceEditor(editor, slot) {
        if (!editor) return;
        const api = window.pywebview?.api;
        const arch = this.archetypeKey;
        // On any input change, rebuild this slot's whole param pin from the
        // non-empty overrides (merge keeps excluded / reroll intact).
        const commit = async () => {
            const params = {};
            editor.querySelectorAll('[data-param-input]').forEach((inp) => {
                const raw = inp.value.trim();
                if (raw === '') return;
                const name = inp.dataset.paramInput;
                const p = (this._instView?.param_specs || []).find((x) => x.name === name);
                let v = raw;
                if (p && (p.type === 'float' || p.type === 'int')) {
                    const num = Number(raw);
                    if (!Number.isFinite(num)) return;
                    v = p.type === 'int' ? Math.round(num) : num;
                    if (p.min != null) v = Math.max(Number(p.min), v);
                    if (p.max != null) v = Math.min(Number(p.max), v);
                } else if (p && p.type === 'bool') {
                    v = /^(true|1|yes)$/i.test(raw);
                }
                params[name] = v;
            });
            // Pinning doesn't change the draw or the dashboard readouts, so
            // don't rebuild the whole window (that flickers + refetches) — just
            // persist, refresh the list Status/count, and re-sync Reset.
            await this._instDo(api?.agent_instance_override_set?.(arch, slot, params));
            this._syncInstResetBtn(editor, slot);
        };
        editor.querySelectorAll('[data-param-input]')
            .forEach((inp) => inp.addEventListener('change', commit));
        editor.querySelectorAll('button[data-eact]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const a = btn.dataset.eact;
                if (a === 'watch') { this._instWatchSlots([slot]); return; }
                // Structural mutations change the draw / excluded state, so
                // rebuild the window's editor + dashboard once they land.
                if (a === 'reroll')       await this._instDo(api?.agent_instances_reroll?.(arch, [slot]));
                else if (a === 'exclude') await this._instDo(api?.agent_instances_exclude?.(arch, [slot], true));
                else if (a === 'restore') await this._instDo(api?.agent_instances_exclude?.(arch, [slot], false));
                else if (a === 'reset')   await this._instDo(api?.agent_instance_override_remove?.(arch, slot));
                await this._refreshInstanceWindowIfOpen(slot);
            });
        });
    }

    /** Enable/disable the Reset button from the freshly-reloaded overrides. */
    _syncInstResetBtn(editor, slot) {
        const ov = (this._instView?.overrides || []).find((o) => o.index === slot);
        const has = !!(ov && ((ov.params && Object.keys(ov.params).length)
            || ov.excluded || (ov.reroll_nonce | 0) > 0));
        const btn = editor.querySelector('button[data-eact="reset"]');
        if (btn) btn.disabled = !has;
    }

    /** Re-fetch the instances view + re-render the list (after a mutation).
     *  When the Instances sub-tab isn't showing (the user navigated the
     *  underlying tab away while an instance window stays open), still refresh
     *  `_instView` so any window rebuild reflects the mutation. */
    async _instReload() {
        const content = this._instContentEl;
        if (content && content.querySelector('[data-role="inst-list"]')) {
            await this._loadInstances(content);
            return;
        }
        try {
            const view = await window.pywebview?.api
                ?.agent_variant_instances_view?.(this.archetypeKey);
            if (view && view.ok !== false && view.is_variant) this._instView = view;
        } catch { /* ignore — window rebuild will use the last view */ }
    }

    /** Call a Bridge mutation, surface its error, then reload. */
    async _instDo(promise) {
        try {
            const r = await promise;
            if (r && r.ok === false) this.logger.warn?.('instances action failed', { error: r.error });
        } catch (err) {
            this.logger.error?.('instances action threw', { err });
        }
        await this._instReload();
    }

    /** Back-compat alias — opens the unified dashboard + parameter window. */
    async _instOpenDashboard(slot) {
        await this._openInstanceWindow(slot);
    }

    /** Append a watch row for the instance (World Debugger; needs a run). */
    async _instWatchSlots(slots) {
        const api = window.pywebview?.api;
        let state = {};
        try { state = (await api?.debug_state?.()) || {}; } catch { /* none */ }
        if (!state.watches && !state.mode) {
            this.logger.warn?.('watch needs an active world');
            return;
        }
        const items = (state.watches || []).map((w) => ({
            id: w.id, expr: w.expr, country: w.country,
            enabled: w.enabled, break_on_true: w.break_on_true,
        }));
        let i = 0;
        for (const slot of slots) {
            const id = `${this.archetypeKey}-${slot}`;
            const param = (this._instView?.param_specs?.[0]?.name) || null;
            const expr = param ? `agent_attr('${id}', '${param}')`
                               : `agent_balance('${id}', 'Deposits')`;
            items.push({ id: `w-inst-${Date.now()}-${i++}`, expr,
                         enabled: true, break_on_true: false });
        }
        try { await api?.debug_set_watches?.(items); }
        catch (err) { this.logger.warn?.('debug_set_watches failed', { err }); }
    }

    _instExportCsv() {
        const view = this._instView;
        if (!view) return;
        const params = view.param_specs.map((p) => p.name);
        const byId = {};
        for (const r of view.instances) byId[r.id] = r;
        const ovBySlot = {};
        for (const o of view.overrides) ovBySlot[o.index] = o;
        const esc2 = (v) => {
            const s = v == null ? '' : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [['slot', 'id', 'excluded', 'pinned', ...params].join(',')];
        for (let slot = 0; slot < view.population; slot++) {
            const id = `${view.archetype}-${slot}`;
            const inst = byId[id];
            const ov = ovBySlot[slot];
            const excl = !!(ov && ov.excluded);
            const pinned = ov && ov.params ? Object.keys(ov.params).join(' ') : '';
            const cells = params.map((n) => {
                if (excl || !inst) return '';
                const v = (ov && ov.params && (n in ov.params)) ? ov.params[n] : inst.params?.[n];
                return esc2(v);
            });
            lines.push([slot, id, excl ? 'yes' : '', esc2(pinned), ...cells].join(','));
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${view.archetype}-instances.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Import pins/exclusions from a CSV (the export format) in one bulk call. */
    _instImportCsv() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,text/csv';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            let overrides = [];
            try { overrides = this._parseInstancesCsv(await file.text()); }
            catch (err) { this.logger.warn?.('CSV parse failed', { err }); return; }
            await this._instDo(window.pywebview?.api
                ?.agent_instance_overrides_set_all?.(this.archetypeKey, overrides));
            await this._refreshAllOpenInstanceWindows();
        });
        input.click();
    }

    _parseInstancesCsv(text) {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) return [];
        const header = this._csvSplit(lines[0]);
        const iSlot = header.indexOf('slot');
        const iExcl = header.indexOf('excluded');
        const iPinned = header.indexOf('pinned');
        if (iSlot < 0) return [];
        const meta = new Set(['slot', 'id', 'excluded', 'pinned']);
        const paramCol = {};
        header.forEach((h, i) => { if (!meta.has(h)) paramCol[h] = i; });
        const specs = this._instView?.param_specs || [];
        const typeOf = (n) => (specs.find((p) => p.name === n) || {}).type || 'float';
        const out = [];
        for (let r = 1; r < lines.length; r++) {
            const cells = this._csvSplit(lines[r]);
            const slot = parseInt(cells[iSlot], 10);
            if (!Number.isFinite(slot)) continue;
            const excluded = iExcl >= 0 && /^(yes|true|1)$/i.test((cells[iExcl] || '').trim());
            const pinned = iPinned >= 0
                ? (cells[iPinned] || '').trim().split(/\s+/).filter(Boolean) : [];
            const params = {};
            for (const name of pinned) {
                const ci = paramCol[name];
                if (ci == null) continue;
                const raw = (cells[ci] || '').trim();
                if (raw === '') continue;
                const t = typeOf(name);
                params[name] = (t === 'float' || t === 'int') ? Number(raw)
                    : (t === 'bool' ? /^(true|1|yes)$/i.test(raw) : raw);
            }
            if (excluded || Object.keys(params).length) out.push({ index: slot, excluded, params });
        }
        return out;
    }

    _csvSplit(line) {
        const out = [];
        let cur = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (q) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (c === '"') q = false;
                else cur += c;
            } else if (c === '"') { q = true; }
            else if (c === ',') { out.push(cur); cur = ''; }
            else { cur += c; }
        }
        out.push(cur);
        return out;
    }

    // -------------------------------------------------------- attributes tab
    //
    // Layer 8.H — the Attributes sub-tab splits into two cards: a
    // **Relationships** section (typed-ref attributes pointing at other
    // entities) above an **Attributes** section (scalars + expressions).
    // Same underlying data list — `self._archetype.attributes` — just
    // partitioned by type for clearer authoring. Both cards share the
    // same onChange writer so re-ordering / editing in either card
    // round-trips through the bridge with the full merged list.

    async _renderAttributesTab(content) {
        const a = this._archetype || {};

        // Variations get an inheritance card on top — same widget the
        // market branches use (parent_child_detail.renderInheritanceTable).
        // Rows tagged inherited / own / overridden so the user sees
        // what came from the parent vs what's local.
        let inheritanceCard = '';
        const parentId = String(a.parent || '').trim();
        if (parentId) {
            const parentEntry = (this._allArchetypes || [])
                .find((x) => (x.archetype || x.id) === parentId);
            if (parentEntry) {
                const {
                    computeInheritanceRows, renderInheritanceTable,
                } = await import('./parent_child_detail.js');
                const rows = computeInheritanceRows(
                    parentEntry.attributes || [],
                    a.attributes || [],
                );
                inheritanceCard = renderInheritanceTable({
                    rows,
                    title: 'Attribute inheritance',
                });
            }
        }

        content.innerHTML = `
            ${inheritanceCard}
            <section class="ea-card">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">${parentId ? 'Edit (own + overrides)' : 'Attributes'}</h3>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-action="add-attr"
                            title="Declare a new attribute">
                        <span class="material-symbols-outlined">add</span>
                        Add attribute
                    </button>
                </div>
                <p class="ea-card__hint">
                    Every per-instance knob. Numeric / choice rows with
                    a distribution sample once at world start and
                    materialise as <code>self.&lt;name&gt;</code>;
                    scalar / expression rows read via
                    <code>self.attrs['name']</code>. Typed
                    <code>ref:*</code> slots live on the
                    <strong>Relationships</strong> sub-tab.
                </p>
                <div data-role="attrs-host"></div>
            </section>
        `;
        this._renderParamsTable();

        // Add-attribute hook routes through the same _onAddParamInline
        // path the legacy + Parameter button used. New rows default
        // to param origin; the user can switch the row's type/role
        // through inline cells once it lands in the table.
        content.querySelector('[data-action="add-attr"]')
            ?.addEventListener('click', () => this._onAddParamInline());
    }

    // ----------------------------------------------------------- settings tab

    _renderSettingsTab(content) {
        const a = this._archetype;
        // Resolve current sector → country so the Country selector
        // shows the right value. Empty (unassigned) sector means
        // both selectors fall back to "(unassigned)".
        const currentSector = (this._sectors || []).find(
            (s) => s.id === a.default_sector,
        );
        const currentCountryId = currentSector?.country || '';
        const unassigned = !a.default_sector;

        // Country dropdown — every declared country plus "(unassigned)".
        const countryOptions =
            `<option value=""${currentCountryId ? '' : ' selected'}>(unassigned)</option>`
            + (this._countries || []).map((c) =>
                `<option value="${esc(c.id)}" ${c.id === currentCountryId ? 'selected' : ''}>${esc(c.label || c.id)}</option>`
            ).join('');

        // Sector dropdown — filtered to sectors in the currently-picked
        // country. Changing the country re-renders this list. When
        // currentCountryId is empty (unassigned), show every sector.
        const sectorsInCountry = currentCountryId
            ? this._sectors.filter((s) => s.country === currentCountryId)
            : this._sectors;
        const sectorOptions =
            `<option value=""${unassigned ? ' selected' : ''}>(unassigned)</option>`
            + sectorsInCountry.map((s) =>
                `<option value="${esc(s.id)}" ${s.id === a.default_sector ? 'selected' : ''}>${esc(s.label)}</option>`
            ).join('');

        const role = a.role || 'non_bank';
        const roleOptions = [
            `<option value="non_bank"${role === 'non_bank' ? ' selected' : ''}>non-bank</option>`,
            `<option value="bank"${role === 'bank' ? ' selected' : ''}>bank</option>`,
        ].join('');

        content.innerHTML = `
            <div class="ea-agent-tab ea-agent-tab--settings">
                <section class="ea-card">
                    <h3 class="ea-card__title">Identity</h3>
                    <div class="ea-form-grid">
                        <label class="ea-row">
                            <span>Label</span>
                            <input type="text" data-field="label" value="${esc(a.label || '')}"
                                   placeholder="${esc(a.archetype)}">
                        </label>
                        <label class="ea-row" title="Country this archetype's agents live in. Changing it filters the Sector list to sectors that belong to the chosen country.">
                            <span>Country</span>
                            <select data-field="country">${countryOptions}</select>
                        </label>
                        <label class="ea-row" title="Specific sector within the chosen country. Currency context resolves via sector → country → country.currency.">
                            <span>Sector</span>
                            <select data-field="default_sector">${sectorOptions}</select>
                        </label>
                        <label class="ea-row">
                            <span>Population</span>
                            <input type="number" data-field="population" min="0" step="1"
                                   value="${a.population}">
                        </label>
                        <label class="ea-row" title="Engine role. 'bank' agents issue deposits + hold reserves; 'non_bank' is the catch-all for everything else.">
                            <span>Role</span>
                            <select data-field="role">${roleOptions}</select>
                        </label>
                    </div>
                    ${this._renderCountryHintHtml()}
                    <p class="ea-card__hint">
                        Population is how many instances are sampled from this
                        archetype's parameter distributions at run start.
                        Inspect sampled / live instances on the bottom panel's
                        Population tab.
                    </p>
                </section>

                ${this._renderArchetypeDashboardHtml()}
            </div>
        `;

        const tab = content.querySelector('.ea-agent-tab--settings');
        // All identity fields autosave on change. The legacy template
        // (parent archetype) dropdown was removed in G4.1 — archetypes
        // have no parent to switch to anymore (R5).
        tab.querySelectorAll('[data-field]').forEach((el) => {
            const handler = () => this._saveIdentity(tab);
            el.addEventListener('change', handler);
            el.addEventListener('blur',   handler);
        });
        // Hydrate the live-state slot if a world is running. Quiet on
        // failure — the dashboard's static-state slots stay populated.
        this._refreshArchetypeDashboard(tab);
    }

    /** Layer 8.J5 — small read-only dashboard below Identity. Surfaces
     *  static facts derived from the archetype (population spec, params
     *  by sampling kind, accounts) plus a live-state slot that fills
     *  with instance counts when a world is running.
     *
     *  Intentionally lightweight + scope-bounded: this is a "what does
     *  this archetype look like across all its instances" overview,
     *  not a per-instance inspector (that lives on the bottom panel's
     *  Population tab + this tab's Population sub-tab). */
    _renderArchetypeDashboardHtml() {
        const a = this._archetype;
        if (!a) return '';
        const params = a.params || [];
        const accounts = a.accounts || [];
        // Bucket params by sampling kind so the user sees at a glance
        // which knobs vary per-instance vs which are constants.
        let dists = 0, choices = 0, constants = 0, refs = 0;
        for (const p of params) {
            const t = String(p.type || '');
            if (t === 'choice')                      choices += 1;
            else if (p.distribution
                && typeof p.distribution === 'object'
                && p.distribution.type
                && p.distribution.type !== 'none')   dists += 1;
            else if (t.startsWith('ref:'))           refs += 1;
            else                                     constants += 1;
        }
        return `
            <section class="ea-card">
                <h3 class="ea-card__title">Archetype dashboard</h3>
                <p class="ea-card__hint">
                    Read-only summary of what every instance of this
                    archetype gets at world start. Live counts appear
                    here once a world is running.
                </p>
                <div class="ea-form-grid ea-archetype-dashboard">
                    <label class="ea-row" title="Number of instances sampled from this archetype at world start.">
                        <span>Population</span>
                        <strong>${a.population}</strong>
                    </label>
                    <label class="ea-row" title="Params with a fixed default and no distribution.">
                        <span>Constant params</span>
                        <strong>${constants}</strong>
                    </label>
                    <label class="ea-row" title="Params sampled per-instance from a distribution.">
                        <span>Distributed params</span>
                        <strong>${dists}</strong>
                    </label>
                    <label class="ea-row" title="Choice-typed params (categorical / discrete).">
                        <span>Choice params</span>
                        <strong>${choices}</strong>
                    </label>
                    <label class="ea-row" title="Typed references this archetype declares.">
                        <span>Typed references</span>
                        <strong>${refs}</strong>
                    </label>
                    <label class="ea-row" title="Account templates each instance starts with.">
                        <span>Accounts</span>
                        <strong>${accounts.length}</strong>
                    </label>
                    <label class="ea-row" title="Live instances of this archetype in the running world.">
                        <span>Live instances</span>
                        <strong data-role="dash-live">—</strong>
                    </label>
                    <label class="ea-row" title="Latest tick observed by the running world.">
                        <span>Live tick</span>
                        <strong data-role="dash-tick">—</strong>
                    </label>
                </div>
            </section>`;
    }

    /** Live-state slot hydration. Queries the bridge for run status +
     *  the population snapshot. Silent if no world is running. */
    async _refreshArchetypeDashboard(tab) {
        const api = window.pywebview?.api;
        const liveEl = tab.querySelector('[data-role="dash-live"]');
        const tickEl = tab.querySelector('[data-role="dash-tick"]');
        if (!liveEl || !tickEl) return;
        let status = null;
        try { status = await api?.world_run_status?.(); }
        catch { /* ignore */ }
        if (!status?.active) {
            liveEl.textContent = '—';
            tickEl.textContent = '—';
            return;
        }
        tickEl.textContent = String(status.tick ?? '—');
        try {
            const pop = await api?.world_live_population?.(this.archetypeKey, 1);
            const n = pop?.total ?? (pop?.samples?.length ?? 0);
            liveEl.textContent = String(n);
        } catch {
            liveEl.textContent = '?';
        }
    }


    // --------------------------------------------------------------- code tab

    // Godley (godley-declarative) — the Code sub-tab interleaves the Python
    // loop bodies and a read-only Godley reflection of the agent's
    // declarative `_flow_rows`. You author the rows in Python (the loop
    // editors below); the Godley table mirrors them, read-only, via
    // `agent_godley_matrix`. A view toggle switches between Interleaved
    // (collapsible sections) and Split (whole-file Monaco + one Godley
    // table). The old pre/post-exec phase split is retired: under the
    // declarative model every row fires in one ACT pass after execute, so
    // there is a single Godley section.
    //
    // The interleaved sections, in lifecycle order:
    //   § observe   — Python (per-loop Monaco)
    //   § adjust    — Python
    //   § execute   — Python
    //   § Godley    — read-only reflection of every declarative row
    static get CODE_SECTIONS() {
        return [
            // API v2: a single `run()` loop. Rendered when the agent defines it;
            // otherwise the legacy observe/adjust/execute triad is shown (the
            // interleaved view picks one set — see `_renderInterleavedView`).
            { id: 'run',      kind: 'py',     title: 'run',     loop: 'run' },
            { id: 'observe',  kind: 'py',     title: 'observe', loop: 'observe' },
            { id: 'adjust',   kind: 'py',     title: 'adjust',  loop: 'adjust' },
            { id: 'execute',  kind: 'py',     title: 'execute', loop: 'execute' },
            { id: 'post',     kind: 'godley', title: 'Godley',  phase: 'post_exec' },
        ];
    }

    _loadCodeView() {
        try {
            const v = localStorage.getItem(`ea-code-view:${this.archetypeKey}`);
            return (v === 'split') ? 'split' : 'interleaved';
        } catch { return 'interleaved'; }
    }

    _saveCodeView(v) {
        try { localStorage.setItem(`ea-code-view:${this.archetypeKey}`, v); }
        catch { /* ignore */ }
    }

    _collapseKey(sectionId) {
        return `ea-code-collapse:${this.archetypeKey}:${sectionId}`;
    }

    _isSectionCollapsed(sectionId) {
        try { return localStorage.getItem(this._collapseKey(sectionId)) === '1'; }
        catch { return false; }
    }

    _setSectionCollapsed(sectionId, collapsed) {
        try {
            localStorage.setItem(
                this._collapseKey(sectionId), collapsed ? '1' : '0');
        } catch { /* ignore */ }
    }

    /** A variant always has its OWN real, editable code file from creation
     *  (`agent_add` writes `class V(Parent): label=...` immediately — see
     *  `entity_code_path`); there's no separate "inherited vs forked" file
     *  state to resolve, only an informational "variation of X" label —
     *  same as a market branch's Code tab (`market_tab.js`'s
     *  `_renderBranchCodeTab`, `canFork: false`). */
    _variantInfo() {
        const a = this._archetype;
        const parentId = (a?.parent || '').trim();
        const parentEntry = parentId
            ? (this._allArchetypes || []).find(
                (x) => (x.archetype || x.id) === parentId)
            : null;
        return {
            isVariant: !!parentId, parentId,
            parentLabel: parentEntry?.label || parentId || '',
        };
    }

    async _renderCodeTab(content) {
        const a = this._archetype;
        if (!a) return;
        this._codeView = this._loadCodeView();
        this._variant = this._variantInfo();

        content.innerHTML = `
            <div class="ea-agent-tab ea-agent-tab--code">
                <div class="ea-agent-code__toolbar">
                    <div data-role="inherited-toggle"></div>
                    <span class="ea-detail-header__spacer"></span>
                    <span class="ea-validate-status" data-role="save-status"></span>
                </div>
                <div data-role="code-body" class="ea-agent-code__body"></div>
            </div>
        `;

        // Single layout: whole-file editor + the Godley table (the
        // interleaved observe/adjust/execute split is retired).
        this._codeView = 'split';

        // Informational "variation of X" label only — always unlocked,
        // matching the market branch Code tab.
        if (this._variant.isVariant) {
            const togHost = content.querySelector('[data-role="inherited-toggle"]');
            const { mountInheritedToggle } = await import('./parent_child_detail.js');
            this._codeToggleCtl = mountInheritedToggle(togHost, {
                parentLabel: this._variant.parentLabel,
                parentKindLabel: 'agent',
            });
        }

        await this._renderCodeBody();
    }

    _disposeCodeEditors() {
        try { this._codeEditor?.dispose?.(); } catch {}
        this._codeEditor = null;
        for (const k of Object.keys(this._loopEditors || {})) {
            try { this._loopEditors[k]?.dispose?.(); } catch {}
        }
        this._loopEditors = {};
        try { this._liveSigCtl?.destroy?.(); } catch {}
        this._liveSigCtl = null;
    }

    async _renderCodeBody() {
        const content = this.hostEl.querySelector('#ea-agent-tab-content');
        const host = content?.querySelector('[data-role="code-body"]');
        if (!host) return;
        this._disposeCodeEditors();
        host.innerHTML = '';
        await this._renderSplitView(host);
    }

    // ---------------------------------------------------------- interleaved

    async _renderInterleavedView(host) {
        const wrap = document.createElement('div');
        wrap.className = 'ea-code-interleaved';
        host.appendChild(wrap);

        // Load the flow rows once for both Godley sections.
        await this._loadFlowRows();

        // API v2: an agent defines EITHER a single `run()` (we show that) OR
        // the legacy observe/adjust/execute triad (we show those). Detect by
        // whether a `run` body exists, then render only the matching py set.
        const srcId = this._fork?.srcAgentId || this.archetypeKey;
        let hasRun = false;
        try {
            const r = await window.pywebview?.api?.agent_loop_get?.(srcId, 'run');
            hasRun = !!(r?.ok && String(r.source || '').trim());
        } catch { /* default to the legacy triad */ }

        for (const def of AgentArchetypeEditor.CODE_SECTIONS) {
            if (def.kind === 'py') {
                if (hasRun && def.loop !== 'run') continue;
                if (!hasRun && def.loop === 'run') continue;
            }
            const { section, body } = this._buildSection(def);
            wrap.appendChild(section);
            if (def.kind === 'py') {
                const ed = document.createElement('div');
                ed.className = 'ea-code-section__monaco';
                body.appendChild(ed);
                // eslint-disable-next-line no-await-in-loop
                await this._mountLoopEditor(ed, def.loop);
            } else {
                this._mountPhaseGodley(body, def);
            }
        }
    }

    /** Build a collapsible section shell; returns {section, body, head}.
     *  Collapse state persists per-agent + per-section in localStorage. */
    _buildSection(def) {
        const collapsed = this._isSectionCollapsed(def.id);
        const section = document.createElement('section');
        section.className =
            `ea-code-section ea-code-section--${def.kind === 'godley' ? 'godley' : def.id}`
            + (def.kind === 'godley' ? ` ea-code-section--g-${def.id}` : '')
            + (collapsed ? ' ea-code-section--collapsed' : '');
        section.dataset.sectionId = def.id;

        const head = document.createElement('div');
        head.className = 'ea-code-section__head';
        head.innerHTML = `
            <span class="material-symbols-outlined ea-code-section__chevron"
                  >expand_more</span>
            <span class="ea-code-section__title">${esc(def.title)}</span>
            <span class="ea-code-section__kind">${
                def.kind === 'godley' ? 'godley' : 'python'}</span>
            <span class="ea-code-section__spacer"></span>
        `;
        // (Godley sections no longer carry a header "+ Add row" button — the
        // Godley matrix editor mounted in the body owns adding rows.)
        const body = document.createElement('div');
        body.className = 'ea-code-section__body';

        // Collapse toggles on header click (but not when the click came
        // from the add-row button — handled by stopPropagation above).
        head.addEventListener('click', () => {
            const nowCollapsed = !section.classList.contains('ea-code-section--collapsed');
            section.classList.toggle('ea-code-section--collapsed', nowCollapsed);
            this._setSectionCollapsed(def.id, nowCollapsed);
        });

        section.appendChild(head);
        section.appendChild(body);
        return { section, body, head };
    }

    async _mountLoopEditor(host, loop) {
        this._loopEditors = this._loopEditors || {};
        const readOnly = !!this._fork?.readOnly;
        const srcId = this._fork?.srcAgentId || this.archetypeKey;
        let source = '';
        try {
            const res = await window.pywebview?.api?.agent_loop_get?.(
                srcId, loop);
            source = (res?.ok ? res.source : '') || '';
        } catch (err) {
            this.logger.warn?.('loop get failed', { loop, err });
        }
        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger.warn?.('Monaco unavailable', { err });
        }
        const onSave = this._debounce((src) => this._saveLoopBody(loop, src), 700);
        if (factory) {
            const handle = factory.createEditor(host, source, {
                language: 'python',
                readOnly,
                noAutoHeight: true,
                automaticLayout: true,
                minimap: { enabled: false },
                scrollbar: { alwaysConsumeMouseWheel: false },
            });
            this._loopEditors[loop] = handle;
            handle.onDidChange(() => {
                if (!readOnly) onSave(handle.getValue());
            });
            try { handle.editor?.onDidBlurEditorWidget?.(() => onSave.flush()); }
            catch { /* non-Monaco handle */ }
            try { this._attachCompletions(handle.editor, factory.monaco); }
            catch { /* ignore */ }
        } else {
            const ta = document.createElement('textarea');
            ta.className = 'ea-code-editor';
            ta.spellcheck = false;
            ta.value = source;
            ta.readOnly = readOnly;
            host.appendChild(ta);
            this._loopEditors[loop] = {
                getValue: () => ta.value, setValue: (v) => { ta.value = v; },
                editor: null, dispose: () => ta.remove(), onDidChange: () => {},
            };
            if (!readOnly) {
                ta.addEventListener('input', () => onSave(ta.value));
                ta.addEventListener('blur', () => onSave.flush());
            }
        }
    }

    async _saveLoopBody(loop, source) {
        const statusEl = this.hostEl.querySelector('[data-role="save-status"]');
        const set = (kind, msg) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = 'ea-validate-status'
                + (kind === 'ok' ? ' ea-validate-status--ok' : '')
                + (kind === 'error' ? ' ea-validate-status--err' : '');
        };
        try {
            const res = await window.pywebview?.api?.agent_loop_set?.(
                this.archetypeKey, loop, source);
            if (res?.ok) set('ok', `✓ ${loop} saved`);
            else set('error', res?.error || 'save failed');
        } catch (err) {
            set('error', String(err?.message || err));
        }
    }

    // ------------------------------------------------------------- flow rows

    async _loadFlowRows() {
        this._flowRows = [];
        this._flowAccounts = { Assets: [], Liabilities: [], Equity: [] };
        this._flowInitial = {};
        this._godleyRows = [];
        this._flowKinds = [];
        this._flowRowsError = null;
        // The Godley section shows two faces of the same declarative rows:
        //   • the EDITOR (leg-level rows) — agent_godley_rows_get / _set
        //   • a read-only balance-sheet PROJECTION — agent_godley_matrix
        try {
            const api = window.pywebview?.api;
            const [mx, rg] = await Promise.all([
                api?.agent_godley_matrix?.(this.archetypeKey),
                api?.agent_godley_rows_get?.(this.archetypeKey),
            ]);
            if (mx && mx.ok !== false) {
                this._flowAccounts = mx.accounts || this._flowAccounts;
                this._flowInitial = mx.initial_conditions || {};
                this._flowRows = (mx.flows || []).map((f, i) => ({
                    ...f, template: f.flow_id, phase: 'post_exec', _uid: `r${i}`,
                }));
                this._flowKinds = this._kindsFromAccounts(this._flowAccounts);
            }
            if (rg && rg.ok !== false) {
                this._godleyRows = rg.rows || [];
            }
            if ((!mx || mx.ok === false) && (!rg || rg.ok === false)) {
                this._flowRowsError =
                    mx?.error || rg?.error || 'could not load flow rows';
            }
        } catch (err) {
            this._flowRowsError = String(err?.message || err);
        }
    }

    _kindsFromAccounts(accounts) {
        const out = new Set();
        for (const t of ['Assets', 'Liabilities', 'Equity']) {
            for (const a of (accounts?.[t] || [])) {
                if (a.asset_kind) out.add(a.asset_kind);
            }
        }
        return [...out];
    }

    _mountPhaseGodley(body, _def) {
        const host = document.createElement('div');
        host.className = 'ea-code-section__godley';
        body.appendChild(host);
        this._mountFlowsEditor(host);
    }

    /** Load the agent's booking RULES (<agent>.ledger.json) + SFC linter
     *  findings — the SFC-by-construction model (docs/SFC_AUTHORING.md). */
    async _loadLedgerRules() {
        this._ledgerRules = [];
        this._ledgerAccounts = { Assets: [], Liabilities: [], Equity: [] };
        this._ledgerInitial = {};
        this._ledgerFindings = [];
        this._ledgerPartners = [];
        this._ledgerError = null;
        try {
            const api = window.pywebview?.api;
            const [rg, lint] = await Promise.all([
                api?.agent_ledger_rules_get?.(this.archetypeKey),
                api?.agent_sfc_lint?.(this.archetypeKey),
            ]);
            if (rg && rg.ok !== false) {
                this._ledgerAccounts = rg.accounts || this._ledgerAccounts;
                this._ledgerInitial = rg.initial_conditions || {};
                this._ledgerRules = rg.rules || [];
                this._ledgerPartners = rg.partners || [];
            } else {
                this._ledgerError = rg?.error || 'could not load booking rules';
            }
            if (lint && lint.ok !== false) this._ledgerFindings = lint.findings || [];
        } catch (err) {
            this._ledgerError = String(err?.message || err);
        }
    }

    /** Mount the per-agent Godley pane: booking rules over the chart + the SFC
     *  linter findings (docs/SFC_AUTHORING.md). Shared by the split view and the
     *  pop-out pane. Read-only unless the agent is editable. */
    _mountFlowsEditor(host) {
        host.innerHTML = '';
        if (this._ledgerError) {
            host.innerHTML =
                `<div class="ea-bp-placeholder__hint">${esc(this._ledgerError)}</div>`;
            return;
        }
        const api = window.pywebview?.api;
        const key = this.archetypeKey;
        import('../ui/ledger_rules_editor.js').then(({ LedgerRulesEditor }) => {
            const ed = new LedgerRulesEditor({
                accounts: this._ledgerAccounts,
                initial_conditions: this._ledgerInitial,
                rules: this._ledgerRules,
                partners: this._ledgerPartners,
                findings: this._ledgerFindings,
                // agent_ledger_rules_set returns {ok, path, findings} — exactly
                // what the editor re-renders from.
                onSave: (rules) => api?.agent_ledger_rules_set?.(key, rules),
            });
            // Stash the instance so the pane header's add/collapse/expand
            // buttons (ea-pane__head) can drive it — like the Signature pane.
            this._flowsEd = ed;
            ed.mount(host);
        });
    }

    /** Read-only balance-sheet projection of the current rows (the accounting
     *  view of what the editor's rows book). */
    _mountGodleyPreview(host) {
        host.innerHTML = '';
        if (!this._flowRows.length) return;
        const label = document.createElement('div');
        label.className = 'ea-godley-preview__label';
        label.textContent = 'Balance-sheet projection';
        host.appendChild(label);
        const tableHost = document.createElement('div');
        host.appendChild(tableHost);
        import('../ui/godley_table.js').then(({ GodleyTable }) => {
            new GodleyTable({
                accounts:           this._flowAccounts,
                initial_conditions: this._flowInitial,
                rows:               this._flowRows,
                readonly:           true,
                showInitial:        false,
            }).mount(tableHost);
        });
    }

    /** Persist edited rows via the bridge; on success refresh the
     *  balance-sheet projection. Returns the bridge result so the editor can
     *  surface `{ok, error, abort}`. */
    async _saveGodleyRows(rows, previewHost) {
        const res = await window.pywebview?.api?.agent_godley_rows_set?.(
            this.archetypeKey, rows);
        if (res && res.ok) {
            this._godleyRows = rows;
            try {
                const mx = await window.pywebview?.api?.agent_godley_matrix?.(
                    this.archetypeKey);
                if (mx && mx.ok !== false) {
                    this._flowAccounts = mx.accounts || this._flowAccounts;
                    this._flowInitial = mx.initial_conditions || {};
                    this._flowRows = (mx.flows || []).map((f, i) => ({
                        ...f, template: f.flow_id, phase: 'post_exec', _uid: `r${i}`,
                    }));
                    if (previewHost) this._mountGodleyPreview(previewHost);
                }
            } catch { /* preview refresh is best-effort */ }
        }
        return res || { ok: false, error: 'no response from bridge' };
    }

    // ------------------------------------------------------------- split view

    /** The Code tab is three full-height panes — Signature / Code / Godley —
     *  each pop-out-able into a floating ManagedWindow (the app-wide window
     *  mechanic; we move the live DOM out and back so editor state survives).
     */
    async _renderSplitView(host) {
        const a = this._archetype;
        const wrap = document.createElement('div');
        wrap.className = 'ea-code-panes';
        wrap.innerHTML = `
            <section class="ea-pane ea-pane--signature" data-pane="signature">
                <header class="ea-pane__head">
                    <span class="ea-pane__title">Signature</span>
                    <span class="ea-pane__spacer"></span>
                    <button type="button" class="ea-pane__act" data-role="open-tab"
                            title="Open in a new tab">
                        <span class="material-symbols-outlined">tab</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="open-window"
                            title="Open in a new window">
                        <span class="material-symbols-outlined">open_in_new</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-h"
                            title="Open in a horizontal split (Alt+Shift+H)">
                        <span class="material-symbols-outlined">splitscreen_vertical_add</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-v"
                            title="Open in a vertical split (Alt+Shift+V)">
                        <span class="material-symbols-outlined">splitscreen_add</span>
                    </button>
                </header>
                <div class="ea-pane__body">
                    <div data-role="live-signature"></div>
                </div>
            </section>
            <section class="ea-pane ea-pane--flows" data-pane="flows">
                <header class="ea-pane__head">
                    <span class="ea-pane__title">Flows</span>
                    <span class="ea-pane__kind">booking</span>
                    <span class="ea-pane__spacer"></span>
                    <button type="button" class="ea-pane__act" data-role="flow-add"
                            title="Add a flow">
                        <span class="material-symbols-outlined">add</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="flow-collapse"
                            title="Collapse all flows">
                        <span class="material-symbols-outlined">unfold_less</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="flow-expand"
                            title="Expand all flows">
                        <span class="material-symbols-outlined">unfold_more</span>
                    </button>
                    <span class="ea-pane__act-sep"></span>
                    <button type="button" class="ea-pane__act" data-role="open-tab"
                            title="Open in a new tab">
                        <span class="material-symbols-outlined">tab</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="open-window"
                            title="Open in a new window">
                        <span class="material-symbols-outlined">open_in_new</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-h"
                            title="Open in a horizontal split (Alt+Shift+H)">
                        <span class="material-symbols-outlined">splitscreen_vertical_add</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-v"
                            title="Open in a vertical split (Alt+Shift+V)">
                        <span class="material-symbols-outlined">splitscreen_add</span>
                    </button>
                </header>
                <div class="ea-pane__body">
                    <div data-role="split-flows" class="ea-flows-host"></div>
                </div>
            </section>
            <section class="ea-pane ea-pane--code" data-pane="code">
                <header class="ea-pane__head">
                    <span class="ea-pane__title">Code</span>
                    <span class="ea-pane__kind">python</span>
                    <span data-role="path-label" class="ea-agent-code__path"></span>
                    <span class="ea-ro-badge" data-role="ro-badge" hidden></span>
                    <span class="ea-pane__spacer"></span>
                    <button type="button" class="ea-pane__act" data-role="open-tab"
                            title="Open in a new tab">
                        <span class="material-symbols-outlined">tab</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="open-window"
                            title="Open in a new window">
                        <span class="material-symbols-outlined">open_in_new</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-h"
                            title="Open in a horizontal split (Alt+Shift+H)">
                        <span class="material-symbols-outlined">splitscreen_vertical_add</span>
                    </button>
                    <button type="button" class="ea-pane__act" data-role="split-v"
                            title="Open in a vertical split (Alt+Shift+V)">
                        <span class="material-symbols-outlined">splitscreen_add</span>
                    </button>
                </header>
                <div class="ea-pane__body">
                    <div data-role="code-host"
                         class="ea-monaco-host ea-agent-code__host"></div>
                </div>
            </section>
        `;
        host.appendChild(wrap);

        // Spinner over the split view while Monaco + the panels load — Code
        // sub-tab switches don't go through the WM page-stub overlay, so
        // there was no feedback. The 80ms grace keeps warm re-opens from
        // strobing a spinner.
        if (!host.style.position) host.style.position = 'relative';
        const doneLoading = makeLoadingOverlay(host);
        // The ledger fetch is independent of the editor — start it now so its
        // bridge round-trip overlaps the Monaco load instead of trailing it.
        const ledgerReady = this._loadLedgerRules();
        try {
            // Whole-file Monaco (reuses the unified editor path) — always
            // this agent's OWN file (a variant is never read-only; see
            // `_variantInfo`).
            const editorHost = wrap.querySelector('[data-role="code-host"]');
            await this._mountUnifiedCodeEditor(editorHost, {
                agentId:  this.archetypeKey,
                readOnly: false,
            });
            const sigHost = wrap.querySelector('[data-role="live-signature"]');
            const { mountLiveSignaturePanel } = await import('./live_signature_panel.js');
            try { this._liveSigCtl?.destroy?.(); } catch {}
            this._liveSigCtl = mountLiveSignaturePanel(sigHost, {
                kind: 'agent', id: a.archetype,
                editor: this._codeEditor?.editor, vantage: 'inbound',
                getSource: () => this._codeEditor?.getValue?.() || '',
                logger: this.logger,
            });

            await ledgerReady;
            const gHost = wrap.querySelector('[data-role="split-flows"]');
            this._mountSplitGodley(gHost);
        } finally {
            doneLoading();
        }

        // Open-in-tab / open-in-window / open-in-split wiring. Each pane is a
        // registered WM content kind, so wm.navigate mounts a FRESH instance
        // in the tab / window / split — the source pane here stays mounted
        // (no dismount). Right-clicking the pane header surfaces the same
        // four destinations as a context menu.
        const kinds = { signature: 'agent_signature', code: 'agent_code', flows: 'agent_flows' };
        wrap.querySelectorAll('.ea-pane').forEach((pane) => {
            const kind = kinds[pane.dataset.pane];
            pane.querySelector('[data-role="open-tab"]')?.addEventListener(
                'click', () => this._openPaneIn(kind, 'tab'));
            pane.querySelector('[data-role="open-window"]')?.addEventListener(
                'click', () => this._openPaneIn(kind, 'window'));
            pane.querySelector('[data-role="split-h"]')?.addEventListener(
                'click', () => this._openPaneIn(kind, 'split-h'));
            pane.querySelector('[data-role="split-v"]')?.addEventListener(
                'click', () => this._openPaneIn(kind, 'split-v'));
            pane.querySelector('.ea-pane__head')?.addEventListener(
                'contextmenu', (e) => this._paneHeaderMenu(e, kind));
        });

        // Flows pane header actions drive the mounted editor (ea-pane__head,
        // like the Signature pane — no in-body toolbar).
        const flowsPane = wrap.querySelector('.ea-pane--flows');
        flowsPane?.querySelector('[data-role="flow-add"]')?.addEventListener(
            'click', () => this._flowsEd?.addFlow());
        flowsPane?.querySelector('[data-role="flow-collapse"]')?.addEventListener(
            'click', () => this._flowsEd?.collapseAll());
        flowsPane?.querySelector('[data-role="flow-expand"]')?.addEventListener(
            'click', () => this._flowsEd?.expandAll());
    }

    /** Open a Code-tab pane (Signature / Code / Godley) in a new tab, a
     *  managed window, or a horizontal/vertical split via the WM. A fresh
     *  instance is mounted there, so the source pane in this tab is never
     *  dismounted. `target` is one of 'tab' | 'window' | 'split-h' | 'split-v'. */
    _openPaneIn(kind, target) {
        const wm = this._wm || window.__twm?.wm;
        if (!wm?.navigate) { this.logger.warn?.('no wm to open pane'); return; }
        const label = { agent_signature: 'Signature', agent_code: 'Code', agent_flows: 'Flows' }[kind] || 'Pane';
        wm.navigate(kind,
            { id: this.archetypeKey, label: `${this.archetypeKey} · ${label}` },
            { ctx: { leafId: this._leafId, windowId: this._windowId }, target });
    }

    /** Right-click menu on a code-pane header — same four destinations as
     *  the header buttons, so the affordance is discoverable both ways. */
    _paneHeaderMenu(e, kind) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Open in new tab',         icon: 'tab',                     action: 'tab' },
            { label: 'Open in new window',      icon: 'open_in_new',             action: 'window' },
            { separator: true },
            { label: 'Open in horizontal split', icon: 'splitscreen_vertical_add', action: 'split-h' },
            { label: 'Open in vertical split',   icon: 'splitscreen_add',          action: 'split-v' },
        ], (action) => this._openPaneIn(kind, action));
    }

    _mountSplitGodley(host) {
        // The hybrid Godley matrix editor.
        this._mountFlowsEditor(host);
    }

    /** Collapse the `#region declarative contract …` block on Code-editor
     *  open, so the view lands on the loop methods rather than the
     *  archetype-owned accounts/params (authored via the Accounts / Signature
     *  editors). Pure folding — the model is unchanged. Runs twice (next frame
     *  + a short delay) since Monaco computes folding ranges asynchronously. */
    _collapseDeclRegion(handle) {
        const ed = handle?.editor;
        if (!ed?.getAction) return;
        const fold = () => {
            try { ed.getAction('editor.foldAllMarkerRegions')?.run(); }
            catch (err) { this.logger?.warn?.('fold decl region failed', { err }); }
        };
        requestAnimationFrame(fold);
        setTimeout(fold, 180);
    }

    async _mountUnifiedCodeEditor(host, { agentId, readOnly }) {
        if (!host) return;
        try { this._codeEditor?.dispose?.(); } catch { /* ignore */ }
        this._codeEditor = null;

        const res = await window.pywebview?.api?.project_file_source?.(
            'archetype', agentId);
        const source = (res?.ok ? res.source : '') || '';
        const path   = res?.path || `agents/${agentId}.py`;

        const pathLabel = this.hostEl.querySelector('[data-role="path-label"]');
        if (pathLabel) pathLabel.textContent = path;

        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger.warn?.('Monaco unavailable for Code tab', { err });
        }

        if (factory) {
            const handle = factory.createEditor(host, source, {
                language: 'python',
                readOnly: !!readOnly,
                noAutoHeight: true,
                automaticLayout: true,
                minimap: { enabled: false },
                scrollbar: { alwaysConsumeMouseWheel: false },
            });
            this._codeEditor = handle;
            const debouncedSave = this._debounce(
                (src) => this._saveAgentSource(src), 700);
            handle.onDidChange(() => {
                if (this._codeEditor && !readOnly) {
                    debouncedSave(handle.getValue());
                }
            });
            try { handle.editor?.onDidBlurEditorWidget?.(() => debouncedSave.flush()); }
            catch { /* non-Monaco handle */ }
            // Reuse the project-aware Python autocomplete the per-loop
            // editors had — same provider, attached to the unified
            // editor's model.
            try { this._attachCompletions(handle.editor, factory.monaco); }
            catch (err) { this.logger.warn?.('completions attach failed', { err }); }
            this._applyReadOnlyChrome(!!readOnly);
            this._collapseDeclRegion(handle);
            return;
        }
        // Fallback — textarea when Monaco can't load.
        const ta = document.createElement('textarea');
        ta.className = 'ea-code-editor';
        ta.spellcheck = false;
        ta.value = source;
        ta.readOnly = !!readOnly;
        host.innerHTML = '';
        host.appendChild(ta);
        this._codeEditor = {
            getValue: () => ta.value,
            setValue: (v) => { ta.value = v; },
            editor:   null,
            dispose: () => ta.remove(),
            onDidChange: () => {},
        };
        const debouncedSave = this._debounce(
            (src) => this._saveAgentSource(src), 700);
        if (!readOnly) {
            ta.addEventListener('input', () => debouncedSave(ta.value));
            ta.addEventListener('blur', () => debouncedSave.flush());
        }
        this._applyReadOnlyChrome(!!readOnly);
    }

    _setCodeEditorReadOnly(ro) {
        const ed = this._codeEditor?.editor;
        if (ed && typeof ed.updateOptions === 'function') {
            ed.updateOptions({ readOnly: !!ro });
        }
        this._applyReadOnlyChrome(!!ro);
    }

    /** Reflect read-only state in the editor chrome: a top-right badge
     *  (with the reason — here a variant inherits its parent's source)
     *  and a `--readonly` class on the host that tints the Monaco
     *  background a dark grayish-green (see CSS). */
    _applyReadOnlyChrome(ro, reason = 'inherited') {
        const host = this.hostEl?.querySelector('[data-role="code-host"]');
        if (host) host.classList.toggle('ea-monaco-host--readonly', !!ro);
        const badge = this.hostEl?.querySelector('[data-role="ro-badge"]');
        if (badge) {
            badge.hidden = !ro;
            badge.textContent = ro
                ? (reason ? `Read-only · ${reason}` : 'Read-only')
                : '';
        }
    }

    async _loadAgentSourceIntoEditor(agentId) {
        if (!this._codeEditor) return;
        const res = await window.pywebview?.api?.project_file_source?.(
            'archetype', agentId);
        const source = (res?.ok ? res.source : '') || '';
        try { this._codeEditor.setValue?.(source); } catch { /* ignore */ }
        const pathLabel = this.hostEl.querySelector('[data-role="path-label"]');
        if (pathLabel) pathLabel.textContent = res?.path || `agents/${agentId}.py`;
        // Re-trigger the live signature panel rescan with new source.
        try { this._liveSigCtl?.rescan?.(source); } catch { /* ignore */ }
    }

    async _saveAgentSource(source) {
        const a = this._archetype;
        if (!a) return;
        const statusEl = this.hostEl.querySelector('[data-role="save-status"]');
        const setStatus = (kind, msg) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = 'ea-validate-status'
                + (kind === 'ok'    ? ' ea-validate-status--ok'  : '')
                + (kind === 'error' ? ' ea-validate-status--err' : '');
        };
        try {
            const res = await window.pywebview?.api?.project_file_save?.(
                'archetype', a.archetype, source);
            if (res?.ok) {
                setStatus('ok', '✓ saved');
            } else {
                setStatus('error', res?.error || 'save failed');
            }
        } catch (err) {
            setStatus('error', String(err?.message || err));
        }
    }

    /** Slide-out Agent API reference. Reuses the same SlideOutPanel
     *  control as the dashboard's plot-config panel so the agent page
     *  matches the rest of the workspace. The panel is created lazily
     *  on first open and lives until dispose(). */
    _openApiHelp() {
        if (!this._helpPanel) {
            // Mount onto the closest `.ea-tab-content` ancestor (which
            // already has `position: relative` set for this purpose);
            // fall back to hostEl if for some reason that's missing.
            const tabHost = this.hostEl.closest('.ea-tab-content') || this.hostEl;
            this._helpPanel = new SlideOutPanel({ width: 560 });
            this._helpPanel.mount(tabHost);
        }
        if (this._helpPanel.isOpen) { this._helpPanel.close(); return; }
        const body = this._helpPanel.open('Agent API', 'help');
        if (body) {
            body.classList.add('ea-cheatsheet');
            body.innerHTML = AGENT_API_CHEATSHEET_HTML;
        }
    }

    // ----------------------------------------------------------- identity ----

    async _saveIdentity(detail) {
        const label = detail.querySelector('[data-field="label"]').value;
        const popRaw = detail.querySelector('[data-field="population"]').value;
        const population = popRaw === '' ? null : Number(popRaw);
        const roleEl = detail.querySelector('[data-field="role"]');
        const role = roleEl ? roleEl.value : null;

        // Country-driven sector selection. If the user changed the
        // Country dropdown, we need to either keep the current sector
        // (if it's still in the new country) or default to the first
        // sector in that country. The Sector dropdown is filtered at
        // render time, but the in-form selected value can be stale
        // for one tick — reconcile here.
        const countryEl = detail.querySelector('[data-field="country"]');
        const sectorEl  = detail.querySelector('[data-field="default_sector"]');
        const newCountry = countryEl ? countryEl.value : null;
        let sector = sectorEl ? sectorEl.value : null;
        if (newCountry !== null) {
            const sectorObj = (this._sectors || []).find((s) => s.id === sector);
            const sectorInNewCountry = sectorObj && sectorObj.country === newCountry;
            if (!sectorInNewCountry) {
                // Pick the first sector in the new country (or empty
                // when none exist yet — agent ends up unassigned).
                const first = (this._sectors || []).find((s) => s.country === newCountry);
                sector = first ? first.id : '';
            }
        }
        const res = await window.pywebview?.api?.agent_update?.({
            key:            this.archetypeKey,
            label,
            default_sector: sector,
            population:     (population != null && Number.isFinite(population)) ? population : null,
            role,
        });
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this._reloadAndRender();
        this.workspaceTabs?.notifyChanged?.('archetypes');
    }


    // ----------------------------------------------------------- params ----

    async _renderParamsTable() {
        const a = this._archetype;
        const target = this.hostEl.querySelector('[data-role="attrs-host"]');
        if (!target) return;
        const params = a.params || [];
        const attrs  = (a.attributes || [])
            .filter((x) => {
                const t = String(x?.type || '');
                return !t.startsWith('ref:') && !t.startsWith('list[ref:');
            });
        if (params.length === 0 && attrs.length === 0) {
            target.innerHTML = '<div class="ea-table__empty">'
                + 'No attributes yet — click + Attribute to add one.</div>';
            this.hostEl.querySelector('[data-action="add-attr"]')
                ?.addEventListener('click', () => this._onAddParamInline());
            return;
        }
        const { mountAttributeListEditor } =
            await import('../../ui/components/attribute_list_editor.js');
        // Layer N3 — unified attribute editor renders the params table
        // so agents share the same chrome as asset_kind/sector/flow.
        // Custom cell renderers preserve the bespoke behaviours that
        // the bespoke table had: distribution-dict modal, structured-
        // type editor (map/schedule/string_list), choice list inline
        // input. Type vocabulary uses the engine's PARAM_TYPES
        // (float/int/str/bool/choice/map/schedule/string_list) since
        // ParamSpec is still the engine-side wire shape.
        try { this._paramListEditor?.dispose?.(); } catch {}
        this._paramListEditor = null;
        // Combine params + attributes into ONE list, tagged with origin
        // so saves route to the right bridge endpoint. The user sees a
        // single "Attributes" table — params are just rows whose
        // sampling shape (min/max/distribution/choices) is populated.
        const trackedItems = [
            ...params.map((p) => ({ ...p, __oldName: p.name, __origin: 'param' })),
            ...attrs.map((x) => ({ ...x, __oldName: x.name, __origin: 'attribute' })),
        ];

        const numCellOverride = (item, callbacks) => {
            // Min / Max only apply to numeric scalars; everything else
            // gets a disabled placeholder so the column line stays
            // aligned across rows.
            if (!PARAM_NUMERIC(item.type)) {
                const el = document.createElement('span');
                el.className = 'ea-attr-editor__cell ea-param-na';
                el.textContent = '—';
                return el;
            }
            return null;  // fall through to default numeric cell
        };

        this._paramListEditor = mountAttributeListEditor(target, {
            items: trackedItems,
            // Engine's PARAM_TYPES vocabulary — the editor's type cell
            // groups any non-scalar/non-ref entries into an "other"
            // optgroup automatically.
            types: PARAM_TYPES,
            // Distribution (sampling shape for numeric scalars) and
            // Choices (selection set for `choice` params) are distinct
            // concepts — they get their own columns instead of being
            // crammed into one ambiguous DIST cell.
            showColumns: ['name', 'type', 'default', 'min', 'max', 'choices', 'distribution'],
            parentAttributes: [],
            allowReorder: false,
            allowRemove: true,
            cellOverrides: {
                // Default cell — open the structured-type modal for
                // map / schedule / string_list; choice picks from the
                // declared options; bool renders a true/false select.
                default: (item, callbacks, ctx) => {
                    if (PARAM_STRUCTURED(item.type)) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'ea-btn ea-typed-cell-btn';
                        btn.title = `Open ${item.type} editor`;
                        btn.innerHTML =
                            '<span class="material-symbols-outlined">edit_note</span>'
                            + `<span class="ea-typed-cell-btn__summary">${
                                esc(structuredSummary(item.type, item.default))
                            }</span>`;
                        btn.addEventListener('click',
                            () => this._onEditStructuredDefault(item.__oldName));
                        return btn;
                    }
                    if (item.type === 'choice') {
                        const sel = document.createElement('select');
                        sel.className = 'ea-attr-editor__cell';
                        for (const c of (item.choices || [])) {
                            const o = document.createElement('option');
                            o.value = c; o.textContent = c;
                            if (c === item.default) o.selected = true;
                            sel.appendChild(o);
                        }
                        sel.addEventListener('change', () => {
                            callbacks.update({ default: sel.value });
                            this._saveParamRow(item);
                        });
                        return sel;
                    }
                    if (item.type === 'bool') {
                        const sel = document.createElement('select');
                        sel.className = 'ea-attr-editor__cell';
                        const cur = (item.default === true
                            || item.default === 'true' || item.default === 1);
                        for (const v of ['true', 'false']) {
                            const o = document.createElement('option');
                            o.value = v; o.textContent = v;
                            if ((v === 'true') === cur) o.selected = true;
                            sel.appendChild(o);
                        }
                        sel.addEventListener('change', () => {
                            callbacks.update({ default: sel.value === 'true' });
                            this._saveParamRow(item);
                        });
                        return sel;
                    }
                    if (PARAM_NUMERIC(item.type)) {
                        const el = document.createElement('input');
                        el.type = 'number'; el.step = 'any';
                        el.className = 'sortable-list__input ea-attr-editor__cell';
                        el.value = (item.default === null || item.default === undefined)
                            ? '' : String(item.default);
                        el.addEventListener('input', () => {
                            const n = el.value === '' ? null : Number(el.value);
                            const v = (item.type === 'int' && n != null)
                                ? Math.trunc(n) : n;
                            callbacks.update({ default: v });
                        });
                        el.addEventListener('blur', () => this._saveParamRow(item));
                        return el;
                    }
                    // str fallback
                    const el = document.createElement('input');
                    el.type = 'text';
                    el.className = 'sortable-list__input ea-attr-editor__cell';
                    el.value = item.default ?? '';
                    el.addEventListener('input',
                        () => callbacks.update({ default: el.value }));
                    el.addEventListener('blur', () => this._saveParamRow(item));
                    return el;
                },
                min: numCellOverride,
                max: numCellOverride,
                // Distribution column — numeric scalars only (continuous
                // sampling shape). Opens the existing distribution-dict
                // modal. Everything else gets a placeholder so the
                // column lines stay aligned across rows.
                distribution: (item, callbacks, ctx) => {
                    if (PARAM_NUMERIC(item.type)) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'ea-btn ea-dist-btn';
                        btn.textContent = _distSummary(item.distribution);
                        btn.addEventListener('click',
                            () => this._onEditParamDistribution(item.__oldName));
                        return btn;
                    }
                    const span = document.createElement('span');
                    span.className = 'ea-param-na';
                    span.textContent = '—';
                    return span;
                },
                // Choices column — the *selection set* for choice params.
                // A separate concept from distribution; the bespoke
                // table conflated them in one cell which was wrong.
                choices: (item, callbacks, ctx) => {
                    if (item.type !== 'choice') {
                        const span = document.createElement('span');
                        span.className = 'ea-param-na';
                        span.textContent = '—';
                        return span;
                    }
                    const el = document.createElement('input');
                    el.type = 'text';
                    el.className = 'sortable-list__input ea-attr-editor__cell';
                    el.value = (item.choices || []).join(', ');
                    el.placeholder = 'a, b, c';
                    el.title = 'Comma-separated option set this param picks from';
                    el.addEventListener('input', () => {
                        const choices = el.value.split(',')
                            .map((s) => s.trim()).filter(Boolean);
                        callbacks.update({ choices });
                    });
                    el.addEventListener('blur', () => this._saveParamRow(item));
                    return el;
                },
                // Name + type cells go through the default renderer
                // but we hook flushes back to agent_param_update.
                name: (item, callbacks) => {
                    const el = document.createElement('input');
                    el.type = 'text';
                    el.className = 'sortable-list__input ea-attr-editor__cell';
                    el.value = item.name ?? '';
                    el.addEventListener('input',
                        () => callbacks.update({ name: el.value }));
                    el.addEventListener('blur', () => this._saveParamRow(item));
                    return el;
                },
                type: (item, callbacks, ctx) => {
                    const sel = document.createElement('select');
                    sel.className = 'ea-attr-editor__cell';
                    for (const t of PARAM_TYPES) {
                        const o = document.createElement('option');
                        o.value = t; o.textContent = t;
                        if (t === item.type) o.selected = true;
                        sel.appendChild(o);
                    }
                    sel.addEventListener('change', () => {
                        callbacks.update({ type: sel.value });
                        // Numeric → choice / structured: seed sensible
                        // defaults so the new cell renders without
                        // NaN/undefined surprises.
                        if (PARAM_STRUCTURED(sel.value)) {
                            callbacks.update({ default: _emptyStructured(sel.value) });
                        }
                        this._saveParamRow(item).then(() => ctx.refreshRow());
                    });
                    return sel;
                },
            },
            onChange: () => {},
            onFlush: () => {},
        });
    }

    /** Persist one param row via agent_param_update. Accepts the
     *  whole item (with `__oldName` carrying the prior name so the
     *  bridge can route the update across a rename). */
    async _saveParamRow(item) {
        if (item.__origin === 'attribute') {
            return this._saveAttributeRow(item);
        }
        const minVal = item.min === null || item.min === undefined ? null
                     : Number(item.min);
        const maxVal = item.max === null || item.max === undefined ? null
                     : Number(item.max);
        const choices = (item.type === 'choice' && Array.isArray(item.choices))
            ? item.choices : null;
        const res = await window.pywebview?.api?.agent_param_update?.(
            this.archetypeKey, item.__oldName,
            item.name, item.type, item.default,
            null, minVal, maxVal, choices,
        );
        if (res?.ok === false) {
            this.logger.warn?.(res.error);
            return;
        }
        item.__oldName = item.name;
        await this._loadData();
    }

    /** Save an attribute row through `agent_update({attributes})`.
     *  Sibling to `_saveParamRow` — the unified editor calls this when
     *  __origin === 'attribute'. Walks the live attribute list,
     *  replaces the matching row by old name, and persists the whole
     *  array (the bridge expects the full list, not a patch). */
    async _saveAttributeRow(item) {
        const arr = (this._archetype?.attributes || []).slice();
        const idx = arr.findIndex((x) => x.name === item.__oldName);
        const patched = {
            name:        item.name,
            type:        item.type,
            default:     item.default,
            value:       item.value,
            description: item.description,
        };
        if (idx >= 0) arr[idx] = { ...arr[idx], ...patched };
        else          arr.push(patched);
        try {
            await window.pywebview?.api?.agent_update?.({
                key:        this.archetypeKey,
                attributes: arr,
            });
        } catch (err) {
            this.logger.warn?.('attribute save failed', { err });
            return;
        }
        item.__oldName = item.name;
        await this._loadData();
    }

    /** Open the grid modal that matches the param's structured type
     *  (map / schedule / string_list), persist the result through
     *  agent_param_update, and refresh the table so the summary
     *  button updates. */
    async _onEditStructuredDefault(paramName) {
        const p = (this._archetype?.params || []).find((x) => x.name === paramName);
        if (!p || !PARAM_STRUCTURED(p.type)) return;
        let edited;
        const title = `${p.name} · ${p.type}`;
        if (p.type === 'map') {
            edited = await openMapEditor(p.default || {}, { title });
        } else if (p.type === 'schedule') {
            edited = await openScheduleEditor(p.default || [], { title });
        } else if (p.type === 'string_list') {
            // Pull the live bus-topic snapshot for autocomplete — handy
            // for `subscribed_topics`-style params that point at the
            // InfoBus. Best-effort: an empty / failed fetch falls
            // through to a plain text field.
            let topics = [];
            try {
                const bus = await window.pywebview?.api?.world_bus_state?.();
                if (bus?.topics) topics = bus.topics.map((t) => t.topic).filter(Boolean);
            } catch { /* ignore */ }
            edited = await openStringListEditor(p.default || [], {
                title, suggestions: topics,
                placeholder: topics.length ? 'pick a topic or type a new one' : 'type and press Enter',
            });
        }
        if (edited == null) return;          // user cancelled
        const res = await window.pywebview?.api?.agent_param_update?.(
            this.archetypeKey, paramName,
            /*name*/ null, /*type*/ null,
            /*default*/ edited,
            /*step*/ null, /*min*/ null, /*max*/ null, /*choices*/ null,
        );
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this._reloadAndRender();
    }

    async _onEditParamDistribution(paramName) {
        const p = (this._archetype?.params || []).find((x) => x.name === paramName);
        if (!p) return;
        const distribution = await openDistributionModal(p.distribution);
        if (distribution === undefined) return;        // user cancelled
        await window.pywebview?.api?.agent_param_set_distribution?.(
            this.archetypeKey, paramName, distribution,
        );
        await this._reloadAndRender();
    }

    async _onAddParam() {
        const data = await openForm({
            title: 'Add parameter',
            fields: [
                { name: 'name',    label: 'Name', type: 'text', required: true,
                  placeholder: 'e.g. risk_aversion' },
                { name: 'type',    label: 'Type', type: 'select',
                  options: PARAM_TYPES.map((t) => ({ value: t, label: t })),
                  default: 'float' },
                { name: 'default', label: 'Default', type: 'text', default: '0' },
                { name: 'choices', label: 'Choices (comma-separated — for "choice" type)',
                  type: 'text', default: '' },
            ],
            submitLabel: 'Add',
        });
        if (!data) return;
        const choices = data.choices
            ? data.choices.split(',').map((s) => s.trim()).filter(Boolean)
            : null;
        let def = data.default;
        if (data.type === 'float' || data.type === 'int') {
            const n = Number(def);
            def = Number.isFinite(n) ? (data.type === 'int' ? Math.trunc(n) : n) : 0;
        } else if (data.type === 'bool') {
            def = (def === 'true' || def === '1');
        } else if (data.type === 'choice' && choices && !choices.includes(def)) {
            def = choices[0] ?? '';
        } else if (PARAM_STRUCTURED(data.type)) {
            // Add-form's plain text Default doesn't apply to structured
            // types — seed empty and let the user open the editor.
            def = _emptyStructured(data.type);
        }
        const res = await window.pywebview?.api?.agent_param_add?.(
            this.archetypeKey, data.name, data.type, def, null, null, null, null, choices,
        );
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this._reloadAndRender();
    }

    async _onDeleteArchetype() {
        const label = this._archetype?.label || this.archetypeKey;
        const ok = await openConfirm({
            title: 'Delete archetype',
            message: `Delete archetype <strong>${label}</strong> and all its instances?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await window.pywebview?.api?.agent_remove?.(this.archetypeKey);
        } catch (err) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Delete archetype failed', err?.message || String(err));
            return;
        }
        this.workspaceTabs?.closeTab?.(this.tabId || `agent:${this.archetypeKey}`);
    }

    async _onRemoveParam(name) {
        const ok = await openConfirm({
            title: 'Delete parameter',
            message: `Remove parameter "${name}"?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        await window.pywebview?.api?.agent_param_remove?.(this.archetypeKey, name);
        await this._reloadAndRender();
    }

    // ------------------------------------------------------------- code ----

    async _attachCompletions(editor, monaco) {
        try {
            const mod = await import('../agent_completions.js');
            mod.registerAgentCompletions(monaco);
            const model = editor?.getModel?.();
            if (!model) return;
            // Brain keys come from scanning the four loop bodies on this
            // archetype for `self.brain.<name> =` assignments. Cheap and
            // covers everything the user has actually declared.
            const a = this._archetype || {};
            const brainKeys = mod.brainKeysFromSources([
                a.init_brain_body, a.observe_body, a.execute_body, a.adjust_body,
            ]);
            mod.attachAgentContext(model, {
                params: a.params || [],
                accounts: a.accounts || [],
                brainKeys,
            });
        } catch (err) {
            this.logger.warn?.('completions attach failed', { err });
        }
    }

    // Debounce a save. `.flush()` commits a pending write immediately — editors
    // call it on blur, so an app-level undo (whose Ctrl+Z only reaches the
    // journal when focus is OUTSIDE the editor) can't be clobbered by a still-
    // pending autosave landing after the restore.
    _debounce(fn, ms) {
        let t = null;
        let lastArgs = null;
        const fire = () => {
            t = null;
            const a = lastArgs; lastArgs = null;
            return a ? fn(...a) : undefined;
        };
        const run = (...args) => {
            lastArgs = args;
            clearTimeout(t);
            t = setTimeout(fire, ms);
        };
        run.flush = () => (t !== null ? (clearTimeout(t), fire()) : undefined);
        return run;
    }

}


// ─── format helpers (population tab) ─────────────────────────────────

function _fmtNum(v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (abs >= 1)    return n.toFixed(2);
    if (abs === 0)   return '0';
    return n.toFixed(4);
}

function _fmtVal(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number')         return _fmtNum(v);
    if (typeof v === 'boolean')        return v ? 'true' : 'false';
    if (typeof v === 'string')         return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}
