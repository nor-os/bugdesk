/**
 * market_tab.js — the market detail editor, as a workspace tab.
 *
 * Ported from markets_page.js (`_renderMarketDetail`, `_refreshLive`,
 * order book + chart rendering, the live popout, the rules form),
 * scoped to a single market id.
 */

import { renderMarketChart, renderDepthChart } from '../ui/market_chart.js';
import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';
import { esc } from './_util.js';
import { openConfirm, openForm } from '../ui/modal.js';
import { loadRefContext } from '../markets/refs.js';
import {
    KIND_LABEL,
    ALL_KINDS,
    kindOptionLabel,
    RULES_SCHEMA,
} from '../markets/schema.js';
import { attrSpecsToFields } from '../markets/rules_schema_adapter.js';

// Branch sub-tabs — branches inherit the parent market's signature
// and code (no fork), so neither Code nor Signature appears here. The
// branch surfaces only what's truly branch-specific: live order book,
// branch identity + resource kind, and the inherited attribute grid.
const MARKET_SUBTABS = [
    { id: 'live',          label: 'Live',          icon: 'show_chart' },
    // Settings holds identity-only fields: id, label, asset_kind
    // (the FK that distinguishes this branch from siblings on the same
    // market). Inheritance lives on the Attributes tab.
    { id: 'settings',      label: 'Settings',      icon: 'tune' },
    // Attributes — single inheritance grid combining parent attribute
    // schema, clearing-rule schema, and branch-level overrides into
    // one widget (replaces the old separate Overrides tab).
    { id: 'attributes',    label: 'Attributes',    icon: 'data_object' },
    // Aggregated contract view — parent market's edges (inherited) plus
    // anything pointing at this branch directly. Mirrors the parent
    // Relationships tab via the shared `_relationships.js` component;
    // entity_kind = 'branch' post-#126 (legacy `market_instance` is
    // accepted by readers for back-compat).
    { id: 'relationships', label: 'Relationships', icon: 'hub' },
    // Read-only inherited Code view + live signature panel above.
    // Branches cannot fork; the inherited-from toggle is locked on.
    { id: 'code',          label: 'Code',          icon: 'code' },
];

/** Factory registered with WorkspaceTabs for kind `market`. */
export function makeMarketTab(hostEl, marketId, ctx) {
    return new MarketTab(hostEl, marketId, ctx);
}

class MarketTab {
    constructor(hostEl, marketId, { logger, workspaceTabs, tabId } = {}) {
        this.hostEl = hostEl;
        this.marketId = marketId;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        this._market = null;
        // Typed-reference vocabulary (currencies, asset kinds, markets).
        this._refCtx = { currencies: [], assetKinds: [], markets: [] };
        this._root = null;
        this._activeSubTab = 'live';
        // Equity-only: per-firm book filter (Phase M5). null = aggregate.
        this._equityFirmFilter = null;
        // Live chart view: 'price' (candles+MA+volume) or 'depth' (cumulative
        // bid/ask book snapshot).
        this._chartView = 'price';
        this._lastBook = null;
    }

    async mount() {
        this.hostEl.innerHTML = `
            <div class="ea-market-tab">
                <header class="ea-detail-header" data-role="header"></header>
                <div class="nb-structured-editor__tabs" data-role="subtabs" hidden></div>
                <div class="nb-structured-editor__content" data-role="content"></div>
            </div>
        `;
        this._root = this.hostEl.querySelector('.ea-market-tab');
        await this._load();
        this._renderDetail();
    }

    show() {}
    hide() {}

    async refresh() {
        // Tick events fire this every step during a run. Re-rendering the
        // whole tab via _renderDetail() blows away the form, chart state,
        // focus, scroll, and every event handler — the entire page
        // visibly flashes on each tick. Stream the live data instead:
        // _refreshLive() updates only the orderbook table and chart.
        //
        // We only need a full re-render when the market's STRUCTURE
        // changes (kind switched, or the market itself was removed).
        // Kind/rule edits already trigger _renderDetail() locally from
        // their own handlers, so we don't need to detect that here.
        const prevId   = this._market?.id;
        const prevKind = this._market?.kind_id;
        await this._load();
        if (!this._market) {
            // Market was deleted out from under the tab — show the empty
            // state once. WorkspaceTabs will prune the tab on the next
            // markets-changed event.
            if (prevId) this._renderDetail();
            return;
        }
        if (this._market.kind_id !== prevKind) {
            // Structural change → form schema differs → must re-render.
            this._renderDetail();
            return;
        }
        this._refreshLive();
    }

    dispose() {
        // Tear down chart ResizeObservers so they don't keep firing
        // after the tab is gone. Targets carry the observer in
        // __chartResizeObserver (set by _initChartSizeCache).
        for (const el of this._root?.querySelectorAll('.ea-market-chart') || []) {
            try { el.__chartResizeObserver?.disconnect?.(); } catch { /* ignore */ }
            el.__chartResizeObserver = null;
            el.__chartSize = null;
        }
    }

    async _load() {
        try {
            const [list, archList] = await Promise.all([
                window.pywebview?.api?.market_instances_list?.()           ?? [],
                window.pywebview?.api?.markets_list?.() ?? [],
            ]);
            this._market = (Array.isArray(list) ? list : [])
                .find((m) => m.id === this.marketId) || null;
            // Stash the owning archetype so the Settings sub-tab can show
            // template-vs-override semantics (the merged `m.rules` from
            // market_instances_list hides which fields are inherited).
            const archetypeId = this._market?.archetype || null;
            this._archetype = archetypeId
                ? ((Array.isArray(archList) ? archList : [])
                    .find((a) => a.id === archetypeId) || null)
                : null;
        } catch (err) {
            this.logger.warn?.('market_instances_list / markets_list failed', { err });
        }
        // Load typed-reference vocabulary in one round-trip — used by
        // every ref field in the rules form (Phase M1) and the
        // references-strip chips (Phase M4).
        try {
            this._refCtx = await loadRefContext(window.pywebview?.api);
        } catch (err) {
            this.logger.warn?.('loadRefContext failed', { err });
        }
    }

    /** Render the Code sub-tab on a branch. Shows an informational
     *  "variation of X" label above the branch's own class source. The
     *  actual source is the market kind's Python class — fetched via
     *  `market_kind_code_get(kind)`. */
    async _renderBranchCodeTab(content, m) {
        const parentMarketId = m?.archetype || '';
        const marketKind = m?.kind || this._archetype?.kind_id || '';
        const togHost  = content.querySelector('[data-role="inherited-toggle"]');
        const pathLab  = content.querySelector('[data-role="path-label"]');
        const codeHost = content.querySelector('[data-role="code-host"]');
        if (!codeHost) return;

        try { this._codeToggleCtl?.destroy?.(); } catch { /* ignore */ }
        const { mountInheritedToggle } = await import(
            './parent_child_detail.js');
        this._codeToggleCtl = mountInheritedToggle(togHost, {
            parentLabel: parentMarketId,
            parentKindLabel: 'market',
        });

        // Fetch + mount the market kind's clearing source.
        if (!marketKind) {
            codeHost.innerHTML = `<div class="ea-table__empty">
                Parent market has no kind declared yet.
            </div>`;
            return;
        }
        try {
            // The branch shows its OWN class (class Oil(Commodity)) — its real
            // file — so the inheritance chain is visible, not the kind's code.
            const branchId = this.marketId || m?.id || '';
            const res = await window.pywebview?.api?.market_code_get?.(branchId);
            const source = (res?.source || res?.code || '') || '';
            if (pathLab) {
                const path = res?.path || `markets/${branchId}.py`;
                pathLab.textContent = `${path}`;
            }
            try { this._codeEditor?.dispose?.(); } catch { /* ignore */ }
            let factory = null;
            try {
                const mod = await import('../../notebook/monaco_editor_factory.js');
                factory = await mod.getEditorFactory();
            } catch (err) {
                this.logger.warn?.('Monaco unavailable for branch Code tab', { err });
            }
            if (factory) {
                this._codeEditor = factory.createEditor(codeHost, source, {
                    language: 'python',
                    readOnly: false,
                    // Auto-size to source so the outer page scrolls
                    // (matches the parent's Code tab — see #117/#122).
                    noAutoHeight: false,
                    automaticLayout: true,
                    minimap: { enabled: false },
                });
                this._codeEditor?.editor?.onDidBlurEditorText?.(() => {
                    const next = this._codeEditor.editor.getValue();
                    window.pywebview?.api?.market_code_set?.(branchId, next);
                });
            } else {
                codeHost.innerHTML = `<pre class="ea-agent-source__fallback">${
                    (source || '').replace(/[&<>]/g, (c) => ({
                        '&': '&amp;', '<': '&lt;', '>': '&gt;',
                    }[c]))
                }</pre>`;
            }
        } catch (err) {
            this.logger.warn?.('branch code load failed', { err });
            codeHost.innerHTML = `<div class="ea-table__empty">
                ${err?.message || 'failed to load'}
            </div>`;
        }
        // Mount the live signature panel above the editor. Branches
        // can't fork code so the editor never changes — the panel just
        // shows the static framework contract + inbound dependencies
        // for the parent market kind. Same widget agents use.
        const sigHost = content.querySelector('[data-role="live-signature"]');
        if (sigHost) {
            try { this._liveSigCtl?.destroy?.(); } catch { /* ignore */ }
            const { mountLiveSignaturePanel } = await import(
                './live_signature_panel.js');
            this._liveSigCtl = mountLiveSignaturePanel(sigHost, {
                kind: 'market_archetype',
                id: parentMarketId,
                editor: this._codeEditor?.editor || null,
                vantage: 'inbound',
                getSource: () => this._codeEditor?.getValue?.() || '',
                logger: this.logger,
            });
        }
    }

    /** Write a single key into the branch's per-instance `rules` dict.
     *  Used by the Resource kind picker and branch attribute editors —
     *  both store data in the same overrides bag. Empty string clears
     *  the key (returns to inherit). */
    async _setBranchRulesKey(key, value) {
        const m = this._market;
        if (!m?.archetype || !m?.instance) return;
        const inst = (this._archetype?.instances || [])
            .find((i) => i.id === m.instance);
        const next = Object.assign({}, inst?.rules || {});
        if (value == null || value === '') delete next[key];
        else next[key] = value;
        try {
            await window.pywebview?.api?.market_instance_set_rules?.(
                m.archetype, m.instance, next);
        } catch (err) {
            this.logger.warn?.('set branch rules failed', { err, key });
        }
        await this._load();
        this._renderDetail();
    }

    /** Wire the native `<input list="…">` resource kind picker.
     *  Datalist gives native browser autocomplete with zero JS layout —
     *  inherits font / sizing from the `.ea-row input` rules so the
     *  field matches every other settings input. The constraint
     *  resolution panel (Requirements card body) re-renders on each
     *  change against the current selection. */
    async _mountResourceKindPicker(content) {
        const input = content.querySelector('#ea-branch-resource-kind');
        if (!input) return;
        const api = window.pywebview?.api;
        const marketKind = this._market?.kind_id
                        || this._archetype?.kind_id
                        || '';
        let contractAttrs = [];
        let contractMethods = [];
        let supportsAssets = [];
        try {
            const res = marketKind
                ? await api?.registry_get?.('market_kind', marketKind)
                : null;
            const entry = res?.entry || null;
            contractAttrs   = Array.isArray(entry?.attributes) ? entry.attributes : [];
            contractMethods = Array.isArray(entry?.methods)    ? entry.methods    : [];
            // `supports_assets` is the curated allow-list for the
            // asset_kind picker — the market_kind declares which
            // asset_kind ids it can actually clear. Drives both the
            // datalist filter AND the empty-value preselection below.
            supportsAssets = Array.isArray(entry?.metadata?.supports_assets)
                ? entry.metadata.supports_assets
                : [];
        } catch (err) {
            this.logger.warn?.('market_kind contract fetch failed', { err });
        }
        const assetKinds = this._refCtx?.assetKinds || [];
        const ctx = { contractAttrs, contractMethods, supportsAssets };

        // Filter the datalist down to asset_kinds the parent market
        // actually supports. This is the bigger half of fix #122 — for
        // housing.default the parent's supports_assets is
        // ['real_estate'], so the picker is no longer a free-for-all
        // over every asset_kind in the project.
        const allowed = supportsAssets.length
            ? assetKinds.filter((k) => supportsAssets.includes(String(k.id)))
            : assetKinds;
        const datalist = content.querySelector(
            `datalist#${CSS.escape(input.getAttribute('list') || '')}`);
        if (datalist) {
            datalist.innerHTML = allowed.map((k) => {
                const label = String(k.label || k.id);
                const id    = String(k.id);
                return `<option value="${esc(id)}"${
                    label !== id ? ` label="${esc(label)}"` : ''
                }></option>`;
            }).join('');
        }

        // If the branch's stored asset_kind is empty AND the
        // market_kind declares supported assets, preselect the first
        // supported one that actually exists in the project. Persist
        // it (don't show an empty field where the data has a single
        // obvious default — that was the housing.default symptom).
        if (!input.value && allowed.length === 1) {
            input.value = String(allowed[0].id);
            this._setBranchRulesKey('asset_kind', allowed[0].id);
        }

        // Resolve user input → canonical asset_kind id. Datalist binds
        // option.value to id, but the user can also free-type a label.
        const resolve = (raw) => {
            const v = String(raw || '').trim();
            if (!v) return '';
            const byId = assetKinds.find((k) => String(k.id) === v);
            if (byId) return byId.id;
            const byLabel = assetKinds.find(
                (k) => String(k.label || '').toLowerCase() === v.toLowerCase());
            if (byLabel) return byLabel.id;
            return v;
        };
        const flush = () => {
            const id = resolve(input.value);
            this._setBranchRulesKey('asset_kind', id);
            this._renderResourceRequirements(content, id, ctx);
        };
        // 'change' fires when the user picks from the datalist or
        // blurs; 'input' fires per keystroke. We rerun the requirements
        // panel on every input so the user sees verdict updates while
        // typing, but only persist on change to avoid spamming the
        // bridge.
        input.addEventListener('change', flush);
        input.addEventListener('input', () => {
            const id = resolve(input.value);
            this._renderResourceRequirements(content, id, ctx);
        });
        // Initial paint of the requirements panel against the
        // currently-stored asset_kind.
        this._renderResourceRequirements(content, resolve(input.value), ctx);
    }

    /** Paint the live "Requirements" panel into the inline slot inside
     *  the Resource kind card. One row per required attribute / method,
     *  ticked when the currently-selected asset_kind satisfies it. */
    _renderResourceRequirements(content, selectedId, ctx) {
        const panel = content.querySelector('[data-role="resource-requirements"]');
        if (!panel) return;
        const { contractAttrs, contractMethods } = ctx;
        if (!contractAttrs.length && !contractMethods.length) {
            panel.innerHTML = '';
            return;
        }
        const assetKinds = this._refCtx?.assetKinds || [];
        const selected = assetKinds.find((k) => String(k.id) === selectedId);
        const have = new Set(
            (Array.isArray(selected?.attributes) ? selected.attributes : [])
                .map((a) => String(a?.name || '').trim())
                .filter(Boolean));
        const pill = (kind, label) =>
            `<span class="ea-pill ea-pill--${kind}">${esc(label)}</span>`;
        const attrRow = (a) => {
            const name = String(a?.name || '');
            const ok   = have.has(name);
            const req  = a?.required !== false;
            const status = ok
                ? pill('ok', 'satisfies')
                : (req ? pill('err', 'missing')
                       : pill('warn', 'optional, missing'));
            return `
                <tr>
                    <td><code>${esc(name)}</code></td>
                    <td class="ea-resource-req__type">${esc(a?.type || '')}</td>
                    <td>${status}</td>
                    <td class="ea-resource-req__desc">${esc(a?.description || '')}</td>
                </tr>`;
        };
        const methodRow = (m) => `
            <tr>
                <td><code>${esc(m?.name || '')}()</code></td>
                <td class="ea-resource-req__type">method</td>
                <td>${pill('warn', 'unchecked')}</td>
                <td class="ea-resource-req__desc">${esc(m?.description || '')}</td>
            </tr>`;
        const rows = [
            ...contractAttrs.map(attrRow),
            ...contractMethods.map(methodRow),
        ].join('');
        const selLabel = selected ? (selected.label || selected.id) : '(none selected)';
        // No `ea-card__subtitle` here — that class adds a top border
        // + uppercase tracking designed to separate sections inside a
        // card, and it read as a malformed full-width strip when used
        // standalone above the Requirements table. Plain header line.
        panel.innerHTML = `
            <p class="ea-resource-req__intro">
                <strong>Required asset-kind attributes</strong>
                <span class="ea-card__hint">
                    Imposed by parent kind
                    <code>${esc(this._market?.kind_id || '')}</code>;
                    checked against
                    <code>${esc(selLabel)}</code>.
                </span>
            </p>
            <table class="ea-table ea-resource-req__table">
                <thead><tr>
                    <th>Attribute</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Description</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    /** Render the branch Relationships sub-tab.
     *
     *  Branches sit at the leaf of the inheritance tree — they don't
     *  have their own implementers (they ARE the implementers of the
     *  parent market kind), and their identity bindings (parent
     *  market, resource kind) already live in Settings. So this tab
     *  surfaces a single useful thing: **who uses this branch** —
     *  agents whose code points at `market:<archetype.branch>`,
     *  sectors that depend on it, etc. The shared
     *  `_relationships.js` component handles the discovery; we
     *  mount it with the branch's own id and tell it to filter the
     *  branch itself out of any inbound row set (so the branch never
     *  shows up as its own implementer / consumer). */
    async _renderBranchRelationships(content, m) {
        const host = content.querySelector('[data-role="branch-rel-host"]');
        if (!host) return;
        try { this._branchRelCtl?.destroy?.(); } catch { /* ignore */ }
        try {
            const { mountRelationshipsTab } = await import('./_relationships.js');
            this._branchRelCtl = mountRelationshipsTab(host, {
                // Branches are registered under `branch` post-#126
                // (see `entry_from_market_instance` in registry_loader);
                // mounting at this kind surfaces edges that point at
                // this specific branch rather than the parent kind.
                entity_kind: 'branch',
                id:          m.id,
                workspaceTabs: this.workspaceTabs,
                // Skip the parent market entry so the inbound rows
                // don't list the parent (which IS itself a relationship,
                // but it's already obvious from the breadcrumb and the
                // Settings tab — listing it again is noise).
                skipIds: [
                    { entity_kind: 'market',           id: m.archetype || '' },
                    { entity_kind: 'market_archetype', id: m.archetype || '' },
                ],
            });
        } catch (err) {
            this.logger.warn?.('branch relationships mount failed', { err });
            host.innerHTML = '<div class="ea-bp-placeholder__hint">'
                + 'Relationships view failed to load.</div>';
        }
    }

    /** Open the change-parent-market dialog. Lists every other market
     *  archetype; on confirm, calls the bridge move endpoint and
     *  re-routes this tab to the new <to>.<branch> id. Overrides ride
     *  along verbatim — any that don't match the target schema will
     *  surface as drift on the Attributes tab (no silent migration). */
    async _openChangeParentDialog() {
        const m = this._market;
        if (!m?.archetype || !m?.instance) return;
        const api = window.pywebview?.api;
        let archs = [];
        try { archs = (await api?.markets_list?.()) || []; }
        catch (err) { this.logger.warn?.('agents_list failed', { err }); }
        const candidates = (Array.isArray(archs) ? archs : [])
            .filter((a) => a?.id && a.id !== m.archetype)
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (candidates.length === 0) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Change parent market',
                'No other market available to move to.');
            return;
        }
        const result = await openForm({
            title: `Move branch ${m.instance}`,
            submitLabel: 'Move',
            fields: [
                {
                    name: 'to',
                    label: 'New parent market',
                    type: 'select',
                    options: candidates.map((a) => ({
                        value: a.id,
                        // Show kind so the user can tell labour from FX
                        // even when the archetype ids overlap.
                        label: a.kind_id ? `${a.id} (${a.kind_id})` : a.id,
                    })),
                    default: candidates[0].id,
                    required: true,
                    hint: 'Overrides ride along verbatim. Anything that '
                        + "doesn't match the target's schema will show "
                        + 'as drift on the Attributes tab.',
                },
            ],
        });
        if (!result || !result.to) return;
        const targetId = String(result.to);
        let res = null;
        try {
            res = await api?.market_instance_move?.(
                m.archetype, m.instance, targetId);
        } catch (err) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Move branch', err?.message || String(err));
            return;
        }
        if (!res?.ok) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Move branch', res?.error || 'move failed');
            return;
        }
        const newFullId = res.new_id || `${targetId}.${m.instance}`;
        // Re-route: close this branch tab, open the moved branch at its
        // new id. The shim's notifyChanged broadcasts so landings and
        // sidebars refresh against the new state.
        this.workspaceTabs?.notifyChanged?.('markets');
        this.workspaceTabs?.openTab?.({
            kind: 'market', entityId: newFullId, label: newFullId,
        });
        if (this.tabId) this.workspaceTabs?.closeTab?.(this.tabId);
    }

    /** Fetch entity_signature for the parent market and cache the
     *  rendered HTML. The Signature sub-tab renders the cached
     *  string; first paint shows a loading placeholder. */
    async _loadSignature() {
        const m = this._market;
        if (!m?.archetype) return;
        if (this._signatureLoading) return this._signatureLoading;
        this._signatureLoading = (async () => {
            try {
                const sig = await window.pywebview?.api?.entity_signature?.(
                    'market_archetype', m.archetype);
                const { renderSignatureTable } = await import(
                    './parent_child_detail.js');
                this._signatureRender = renderSignatureTable({ signature: sig });
            } catch (err) {
                this.logger.warn?.('entity_signature failed', { err });
                this._signatureRender =
                    '<p class="ea-card__hint ea-card__hint--show">Failed to load signature.</p>';
            } finally {
                this._signatureLoading = null;
            }
        })();
        return this._signatureLoading;
    }

    // -------------------------------------------------------------- render

    _renderDetail() {
        const m = this._market;
        const header  = this._root.querySelector('[data-role="header"]');
        const subtabs = this._root.querySelector('[data-role="subtabs"]');
        const content = this._root.querySelector('[data-role="content"]');
        if (!m) {
            header.innerHTML = '';
            subtabs.hidden = true;
            content.dataset.subtab = '';
            content.innerHTML = '<div class="ea-markets__empty">'
                + 'Market not found — it may have been removed.</div>';
            return;
        }
        // References strip — typed relationships rendered as chips
        // next to the kind badge (Phase M4). Replaces the FX-only pair
        // badge with a general per-kind pattern.
        const refsStrip = this._renderReferencesStrip(m);
        header.innerHTML = `
            <h2>${esc(m.id)}</h2>
            <span class="ea-badge">${esc(KIND_LABEL[m.kind_id] || m.kind_id)}</span>
            ${refsStrip}
            <span class="ea-detail-header__spacer"></span>
            <button class="ea-btn ea-btn--small" data-action="popout"
                    title="Pop this branch tab out into a floating window">
                <span class="material-symbols-outlined">open_in_new</span>
                Pop out
            </button>
            <button class="ea-btn ea-btn--small ea-btn--danger" data-action="delete"
                    title="Delete this branch">
                <span class="material-symbols-outlined">delete</span>
                Delete
            </button>
        `;
        header.querySelector('[data-action="popout"]')
            ?.addEventListener('click', () => this._openPopout());
        header.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDeleteMarket());
        header.querySelectorAll('[data-nav-to-market]').forEach((el) => {
            el.addEventListener('click', () => this._navigateToMarket(el.dataset.navToMarket));
        });
        header.querySelectorAll('[data-nav-to-archetype]').forEach((el) => {
            el.addEventListener('click', () => this._navigateToArchetype(el.dataset.navToArchetype));
        });

        subtabs.hidden = false;
        if (!subtabs.dataset.built) {
            for (const t of MARKET_SUBTABS) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nb-structured-editor__tab'
                    + (t.id === this._activeSubTab ? ' active' : '');
                btn.dataset.subtab = t.id;
                btn.innerHTML = `<span class="material-symbols-outlined">${t.icon}</span> ${t.label}`;
                btn.addEventListener('click', () => this._switchSubTab(t.id));
                subtabs.appendChild(btn);
            }
            subtabs.dataset.built = '1';
        }
        // Force a content rebuild — a kind switch re-shapes the Rules form.
        content.dataset.subtab = '';
        this._renderActiveSubTab();
    }

    _switchSubTab(id) {
        if (id === this._activeSubTab) return;
        this._activeSubTab = id;
        this._root.querySelectorAll('[data-role="subtabs"] .nb-structured-editor__tab')
            .forEach((b) => b.classList.toggle('active', b.dataset.subtab === id));
        this._renderActiveSubTab();
    }

    _renderActiveSubTab() {
        const content = this._root.querySelector('[data-role="content"]');
        const m = this._market;
        if (!content || !m) return;
        const sub = this._activeSubTab;
        // Code: render the locked inherited-from toggle + read-only
        // editor with the parent market's clearing source. Branches
        // never fork code, so the editor stays read-only.
        // The `ea-agent-tab-content--code` class flips `content` into a
        // flex column so the Monaco host can claim leftover height —
        // without it the editor mounts at ~0px and reads as broken.
        if (sub === 'code') {
            content.dataset.subtab = 'code';
            content.classList.add('ea-agent-tab-content--code');
            content.innerHTML = `
                <div class="ea-agent-tab ea-agent-tab--code">
                    <div data-role="inherited-toggle"></div>
                    <div data-role="live-signature"></div>
                    <div data-role="path-bar" class="ea-agent-code__bar">
                        <span data-role="path-label" class="ea-agent-code__path"></span>
                    </div>
                    <div data-role="code-host" class="ea-monaco-host ea-agent-code__host"></div>
                </div>`;
            this._renderBranchCodeTab(content, m);
            return;
        }
        // Any non-Code sub-tab — make sure the flex-column class from a
        // prior Code render is dropped, otherwise cards layout breaks.
        content.classList.remove('ea-agent-tab-content--code');
        // Signature: lazy fetch then re-render. The first switch shows
        // a placeholder; the second renders the cached payload.
        if (sub === 'signature') {
            this._loadSignature().then(() => {
                if (this._activeSubTab !== 'signature') return;
                content.dataset.subtab = '';
                content.innerHTML = this._subTabShell('signature', m);
            });
        }
        if (content.dataset.subtab !== sub) {
            content.dataset.subtab = sub;
            content.innerHTML = this._subTabShell(sub, m);
            if (sub === 'settings') {
                // Resource kind picker — autocomplete-search over the
                // asset_kinds list. No "None" — every branch MUST trade
                // an asset; clearing the field reverts to the inherited
                // default (which is also non-empty in practice). Mount
                // is async because AutocompleteField is a code-split
                // import — see _mountResourceKindPicker.
                this._mountResourceKindPicker(content);
                // Change-parent-market dialog. Branches carry overrides
                // tied to the parent's schema; the dialog hands off to a
                // bridge move and re-routes the tab to the new id.
                content.querySelector('[data-action="change-parent"]')
                    ?.addEventListener('click', () => this._openChangeParentDialog());
            }
            if (sub === 'attributes') {
                // Lift the placeholder into the unified inheritance
                // grid (parent attrs + rule schema + branch overrides).
                this._renderBranchAttrInheritance(content, m);
            }
            if (sub === 'relationships') {
                this._renderBranchRelationships(content, m);
            }
            if (sub === 'live' && m.kind_id === 'Equity') {
                // Wire Equity firm picker (Phase M5).
                const picker = content.querySelector('[data-role="equity-firm-select"]');
                picker?.addEventListener('change', () => {
                    const v = picker.value || '';
                    this._equityFirmFilter = v === '' ? null : v;
                    this._refreshLive();
                });
            }
            if (sub === 'live') {
                // Price/Depth chart-view switcher.
                const viewGroup = content.querySelector('[data-role="chart-view"]');
                viewGroup?.addEventListener('click', (ev) => {
                    const btn = ev.target.closest('[data-view]');
                    if (!btn || !viewGroup.contains(btn)) return;
                    const view = btn.dataset.view;
                    if (view === this._chartView) return;
                    this._chartView = view;
                    for (const b of viewGroup.querySelectorAll('[data-view]')) {
                        b.classList.toggle('ea-segmented__btn--active', b === btn);
                    }
                    this._renderMarketChart(this._lastHistory || []);
                });
                this._initLiveLayoutObserver(content.querySelector('.ea-market-live'));
            }
        }
        if (sub === 'live') this._refreshLive();
    }

    // Below this width the ladder (min 150px) + a usable chart (needs
    // ~320px, see _initChartSizeCache) no longer both fit the grid row —
    // stack instead of squeezing. Matches the chart's own 320px floor
    // plus the ladder's min-content plus the grid gap.
    _LIVE_STACK_BREAKPOINT = 520;

    _initLiveLayoutObserver(liveEl) {
        if (!liveEl || liveEl.__layoutResizeObserver) return;
        const apply = (width) => {
            liveEl.classList.toggle('ea-market-live--stacked', width < this._LIVE_STACK_BREAKPOINT);
        };
        apply(liveEl.getBoundingClientRect().width);
        try {
            const ro = createRafResizeObserver((entries) => {
                const w = entries?.[0]?.contentRect?.width ?? liveEl.getBoundingClientRect().width;
                apply(w);
            });
            ro.observe(liveEl);
            liveEl.__layoutResizeObserver = ro;
        } catch { /* ResizeObserver unavailable */ }
    }

    _subTabShell(sub, m) {
        if (sub === 'signature') {
            return this._signatureRender || `
                <p class="ea-card__hint ea-card__hint--show">
                    Loading signature…
                </p>`;
        }
        if (sub === 'live') {
            // Equity markets get a firm picker above the order book
            // (Phase M5). Persistent across tick refreshes.
            const equityControls = (m.kind_id === 'Equity') ? `
                <div class="ea-equity-controls" data-role="equity-controls">
                    <label class="ea-equity-controls__label">
                        <span>Firm</span>
                        <select class="field__select" data-role="equity-firm-select">
                            <option value="">All firms (aggregate)</option>
                        </select>
                    </label>
                </div>
            ` : '';
            return `
                <section class="ea-card ea-card--market-live">
                    <h3 class="ea-card__title">Order book &amp; price</h3>
                    ${equityControls}
                    <div class="ea-market-live-scope" data-market-id="${esc(m.id)}">
                    <div class="ea-market-ticker" data-role="ticker"></div>
                    <div class="ea-market-live">
                        <div class="ea-orderbook" data-role="orderbook"></div>
                        <div class="ea-market-chart-col">
                            <div class="ea-segmented ea-segmented--small ea-market-chart-view" role="tablist" data-role="chart-view">
                                <button type="button" class="ea-segmented__btn ea-segmented__btn--active" data-view="price">Price</button>
                                <button type="button" class="ea-segmented__btn" data-view="depth">Depth</button>
                            </div>
                            <div class="ea-market-chart" data-role="chart"></div>
                        </div>
                    </div>
                    </div>
                </section>`;
        }
        const overrideRules = this._archetype
            ? ((this._archetype.instances || [])
                .find((i) => i.id === m.instance)?.rules || {})
            : (m.rules || {});

        if (sub === 'attributes') {
            // Inheritance grid only — Resource kind lives on Settings.
            return `<section class="ea-card" data-role="branch-attrs-host">
                <p class="ea-card__hint">Loading attribute inheritance…</p>
            </section>`;
        }
        if (sub === 'relationships') {
            // Mounted lazily — _renderBranchRelationships fills the host.
            return `<div data-role="branch-rel-host"></div>`;
        }

        // settings — id, label (read-only here; the header is the
        // edit surface) + the Resource kind picker. Attributes lives
        // on the Attributes sub-tab.
        const resourceKindId = String(overrideRules.asset_kind || '');
        const assetKinds = this._refCtx?.assetKinds || [];
        const datalistId = `ea-branch-resource-kinds-${esc(m.id || '')}`;
        const datalistOpts = assetKinds.map((k) => {
            const label = String(k.label || k.id);
            const id    = String(k.id);
            // value=id (canonical), label=human label. Browser displays
            // the label in the dropdown and stores id on selection.
            return `<option value="${esc(id)}"${
                label !== id ? ` label="${esc(label)}"` : ''
            }></option>`;
        }).join('');
        return `
            <section class="ea-card">
                ${m.archetype ? `
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Identity</h3>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="change-parent"
                                title="Move this branch under a different parent market">
                            <span class="material-symbols-outlined">swap_horiz</span>
                            Change parent
                        </button>
                    </div>` : `
                    <h3 class="ea-card__title">Identity</h3>`}
                <div class="ea-row">
                    <span>Branch id</span>
                    <code>${esc(m.id)}</code>
                </div>
                ${m.archetype ? `
                    <div class="ea-row">
                        <span>Parent market</span>
                        <code>${esc(m.archetype)}</code>
                    </div>` : ''}
            </section>
            <section class="ea-card">
                <h3 class="ea-card__title">Resource kind</h3>
                <div class="ea-row">
                    <span>Asset traded on this branch</span>
                    <input type="text"
                           id="ea-branch-resource-kind"
                           list="${datalistId}"
                           value="${esc(resourceKindId)}"
                           placeholder="Search asset kinds…"
                           autocomplete="off"
                           spellcheck="false">
                </div>
                <datalist id="${datalistId}">${datalistOpts}</datalist>
                <p class="ea-card__hint ea-card__hint--show">
                    The resource kind is the characteristic element of
                    the branch — every branch on a market trades a
                    different asset.
                </p>
                <div data-role="resource-requirements"></div>
            </section>`;
    }

    /** Lift the Attributes section's placeholder into the shared
     *  inheritance widget. Folds together:
     *    - parent-market attributes (`<archetype>.attributes`)
     *    - clearing-rule schema fields (RULES_SCHEMA[kind])
     *    - branch-level overrides (`attr:<name>` and bare rule keys
     *      under the branch's per-instance `rules`)
     *  Everything appears in ONE grid — no separate Overrides tab. */
    async _renderBranchAttrInheritance(content, m) {
        const host = content.querySelector('[data-role="branch-attrs-host"]');
        if (!host) return;
        const templateRules = this._archetype?.rules || {};
        const overrideRules = this._archetype
            ? ((this._archetype.instances || [])
                .find((i) => i.id === m.instance)?.rules || {})
            : (m.rules || {});

        // Parent baseline: market attributes (typed schema) + clearing-
        // rule schema fields treated as inherited rows the branch can
        // override. `_origin` tags each row so the flush step knows
        // whether to write `attr:<name>` (parent-attr override) or the
        // bare key (clearing-rule override).
        const parentAttributes = [
            ...(this._archetype?.attributes || []).map((a) => ({
                name:        a.name,
                type:        a.type || 'string',
                default:     a.default ?? null,
                description: a.description || '',
                _origin:     'attr',
            })),
            ...((RULES_SCHEMA[m.kind_id] || [])
                // `asset_kind` is the branch's traded-asset, owned by the
                // Resource kind picker on the Settings tab — don't surface
                // it here too (it would be editable in two places).
                .filter((f) => f.name !== 'asset_kind')
                .map((f) => ({
                    name:        f.name,
                    type:        f.type || 'string',
                    default:     Object.prototype.hasOwnProperty.call(templateRules, f.name)
                                    ? templateRules[f.name]
                                    : (f.default ?? null),
                    description: f.description || '',
                    _origin:     'rule',
                }))),
        ];

        // Branch-side items mirror the parent rows, with `value` filled
        // from the override map (null = inherit). `asset_kind` is
        // owned by the Settings tab and excluded here.
        const items = parentAttributes.map((p) => {
            const key = (p._origin === 'attr') ? `attr:${p.name}` : p.name;
            const hasOverride = Object.prototype.hasOwnProperty.call(
                overrideRules, key);
            return {
                name:        p.name,
                type:        p.type,
                default:     p.default,
                value:       hasOverride ? overrideRules[key] : null,
                description: p.description,
                _origin:     p._origin,
            };
        });

        // Append any branch-only attributes (those stored as
        // `attr:<name>` on the branch's rules but NOT present on the
        // parent's schema). These were declared at the branch level,
        // not as overrides — surface them in the same editor so the
        // user can see + manage them in one place.
        const parentNames = new Set(parentAttributes.map((p) => p.name));
        for (const [k, v] of Object.entries(overrideRules)) {
            if (!k.startsWith('attr:')) continue;
            const nm = k.slice(5);
            if (parentNames.has(nm)) continue;
            items.push({
                name: nm, type: 'string', default: null, value: v,
                description: '', _origin: 'attr',
            });
        }

        const { mountAttributeListEditor } = await import(
            '../../ui/components/attribute_list_editor.js');
        try { this._branchAttrEditor?.dispose?.(); } catch { /* ignore */ }

        const flushOverrides = async () => {
            const next = {};
            // Preserve asset_kind — it's owned by the Settings tab,
            // not by this editor.
            if (overrideRules.asset_kind != null) {
                next.asset_kind = overrideRules.asset_kind;
            }
            for (const it of items) {
                const v = it.value;
                if (v == null || v === '') continue;  // inherited
                if (!it.name) continue;
                const key = (it._origin === 'rule')
                    ? it.name
                    : `attr:${it.name}`;
                next[key] = v;
            }
            try {
                await window.pywebview?.api?.market_instance_set_rules?.(
                    m.archetype, m.instance, next);
            } catch (err) {
                this.logger.warn?.('branch override save failed', { err });
            }
        };

        this._branchAttrEditor = mountAttributeListEditor(host, {
            items,
            parentAttributes,
            showColumns:  ['name', 'type', 'default', 'value', 'description'],
            // Branch CAN declare its own attributes (not just override
            // parent rows). Adding gives a `attr:` row that persists
            // into the branch's `rules` map on flush. Reorder stays
            // off — order is parent-driven for inherited rows.
            allowReorder: false,
            allowRemove:  true,
            addButtonText: 'Add branch attribute',
            createItem: () => ({
                name: '', type: 'string', default: null, value: null,
                description: '', _origin: 'attr',
            }),
            onChange: (next) => {
                items.length = 0;
                for (const it of next) items.push(it);
            },
            onFlush:      flushOverrides,
        });
    }

    _renderOverrideRow(field, templateRules, instanceRules) {
        const isOverridden = Object.prototype.hasOwnProperty.call(instanceRules, field.name);
        const templateValue = Object.prototype.hasOwnProperty.call(templateRules, field.name)
            ? templateRules[field.name]
            : (field.default ?? '');
        const overrideValue = isOverridden ? instanceRules[field.name] : '';
        return `
            <tr data-field="${esc(field.name)}"
                ${isOverridden ? 'class="ea-scen-row--overridden"' : ''}>
                <td class="ea-scen-row__name"><code>${esc(field.name)}</code></td>
                <td class="ea-scen-row__type">${esc(field.type)}</td>
                <td class="ea-scen-row__baseline">${esc(String(templateValue ?? ''))}</td>
                <td class="ea-scen-row__override">
                    ${this._renderOverrideInput(field, overrideValue)}
                </td>
            </tr>
        `;
    }

    _renderOverrideInput(field, value) {
        const v = (value === undefined || value === null) ? '' : value;
        const cur = String(v);
        if (field.type === 'select') {
            const opts = (field.options || []).map((o) =>
                `<option value="${esc(String(o.value))}"${String(o.value) === cur ? ' selected' : ''}>${esc(o.label || String(o.value))}</option>`
            ).join('');
            return `<select class="ea-scen-input" data-field-input>
                <option value=""${cur === '' ? ' selected' : ''}>(inherit)</option>
                ${opts}
            </select>`;
        }
        if (field.type === 'ref') {
            const options = (field.refQuery ? field.refQuery({}, this._refCtx) : []) || [];
            const opts = options.map((o) =>
                `<option value="${esc(String(o.value))}"${String(o.value) === cur ? ' selected' : ''}>${esc(o.label || String(o.value))}</option>`
            ).join('');
            return `<select class="ea-scen-input" data-field-input>
                <option value=""${cur === '' ? ' selected' : ''}>(inherit)</option>
                ${opts}
            </select>`;
        }
        const type = field.type === 'number' ? 'number' : 'text';
        const step = field.step ? `step="${esc(field.step)}"` : '';
        return `<input class="ea-scen-input" type="${type}" ${step}
                       data-field-input
                       value="${esc(cur)}"
                       placeholder="(leave blank to inherit)">`;
    }

    _renderRulesFields(kind, values) {
        // T4.3 — schema lives in the registry; JS RULES_SCHEMA is now
        // the offline fallback. _fetchRulesSchema warms the cache and
        // triggers a re-render when the registry returns something
        // different from the fallback.
        const cached = this._rulesSchemaCache?.[kind];
        const schema = cached || RULES_SCHEMA[kind] || [];
        if (schema.length === 0) {
            this._fetchRulesSchema(kind);
            return '<p class="ea-card__hint">No configurable rules for this kind.</p>';
        }
        this._fetchRulesSchema(kind);
        return schema.map((f) => this._renderField(f, values)).join('');
    }

    async _fetchRulesSchema(kind) {
        this._rulesSchemaCache = this._rulesSchemaCache || {};
        if (this._rulesSchemaInflight?.[kind]) return;
        this._rulesSchemaInflight = this._rulesSchemaInflight || {};
        this._rulesSchemaInflight[kind] = true;
        try {
            const api = window.pywebview?.api;
            const res = await api?.market_kind_rules_schema?.(kind);
            if (res?.ok && Array.isArray(res.rules_schema)) {
                const next = attrSpecsToFields(res.rules_schema);
                const prev = this._rulesSchemaCache[kind] || [];
                this._rulesSchemaCache[kind] = next;
                if (JSON.stringify(prev) !== JSON.stringify(next)) {
                    this._render?.();
                }
            }
        } catch (err) {
            this.log?.warn?.('rules_schema fetch failed', { err });
        } finally {
            this._rulesSchemaInflight[kind] = false;
        }
    }

    /** Render one field. Types: select, ref, number, text. */
    _renderField(f, values) {
        const v = values[f.name];
        const display = (v == null) ? (f.default ?? '') : v;
        const tip = f.help ? `title="${f.help.replace(/"/g, '&quot;')}"` : '';

        if (f.type === 'select') {
            const opts = (f.options || []).map((o) =>
                `<option value="${esc(String(o.value))}"${o.value === display ? ' selected' : ''}>${esc(o.label || String(o.value))}</option>`
            ).join('');
            const dep = (f.dependsOn || []).join(',');
            return `
                <label class="ea-row" ${tip}>
                    <span>${f.label}</span>
                    <select name="${f.name}" ${dep ? `data-controls="${dep}"` : ''}>${opts}</select>
                </label>
            `;
        }

        if (f.type === 'ref') {
            const options = (f.refQuery ? f.refQuery(values, this._refCtx) : []) || [];
            const currentVal = String(display ?? '');
            const known = options.some((o) => String(o.value) === currentVal);
            const stale = currentVal !== '' && !known;
            const optionTags = options.map((o) =>
                `<option value="${esc(String(o.value))}"${String(o.value) === currentVal ? ' selected' : ''}>${esc(o.label || String(o.value))}</option>`
            ).join('');
            const placeholder = `<option value="">${options.length === 0 ? '— none available —' : '— pick —'}</option>`;
            const staleClass = stale ? ' ea-row--stale' : '';
            const staleAnnotation = stale ? `
                <span class="ea-row__error" title="This reference no longer resolves to a declared ${f.refKind}.">
                    Unknown ${esc(f.refKind || 'reference')}: <code>${esc(currentVal)}</code>
                    <button type="button" class="ea-row__clear" data-clear-ref="${f.name}">× clear</button>
                </span>
            ` : '';
            return `
                <label class="ea-row${staleClass}" ${tip} data-ref-field="${f.name}">
                    <span>${f.label}</span>
                    <select name="${f.name}" data-ref-kind="${esc(f.refKind || '')}">
                        ${placeholder}
                        ${stale ? `<option value="${esc(currentVal)}" selected>${esc(currentVal)} (unknown)</option>` : ''}
                        ${optionTags}
                    </select>
                    ${staleAnnotation}
                </label>
            `;
        }

        const step = f.step ? `step="${f.step}"` : '';
        const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '';
        return `
            <label class="ea-row" ${tip}>
                <span>${f.label}</span>
                <input name="${f.name}" type="${f.type}" ${step} ${ph} value="${esc(String(display))}">
            </label>
        `;
    }

    _wireRulesForm(form) {
        if (!form) return;
        form.querySelectorAll('input, select').forEach((inp) => {
            inp.addEventListener('change', async () => {
                await this._saveRules(form);
                if (inp.dataset.controls) this._rerenderDependentRefs(form, inp.dataset.controls);
            });
            inp.addEventListener('blur', () => this._saveRules(form));
        });
        form.querySelectorAll('[data-clear-ref]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const name = btn.dataset.clearRef;
                const el = form.elements[name];
                if (el) el.value = '';
                await this._saveRules(form);
                await this._load();
                this._renderDetail();
            });
        });
    }

    _rerenderDependentRefs(form, controllerNames) {
        const controllers = String(controllerNames || '').split(',').filter(Boolean);
        if (controllers.length === 0) return;
        const m = this._market;
        if (!m) return;
        const schema = RULES_SCHEMA[m.kind_id] || [];
        const values = this._readFormValues(form, schema);
        for (const f of schema) {
            if (f.type !== 'ref') continue;
            if (!(f.dependsOn || []).some((c) => controllers.includes(c))) continue;
            const node = form.querySelector(`[data-ref-field="${f.name}"]`);
            if (!node) continue;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = this._renderField(f, values);
            const replacement = wrapper.firstElementChild;
            node.replaceWith(replacement);
            replacement.querySelectorAll('input, select').forEach((inp) => {
                inp.addEventListener('change', () => this._saveRules(form));
                inp.addEventListener('blur',   () => this._saveRules(form));
            });
            replacement.querySelectorAll('[data-clear-ref]').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const el = form.elements[f.name];
                    if (el) el.value = '';
                    await this._saveRules(form);
                    await this._load();
                    this._renderDetail();
                });
            });
        }
    }

    _readFormValues(form, schema) {
        const out = {};
        for (const f of schema) {
            const el = form.elements[f.name];
            if (!el) continue;
            let v = el.value;
            if (f.type === 'number') v = (v === '' ? null : Number(v));
            out[f.name] = v;
        }
        return out;
    }

    /** Render the relationships chip strip (Phase M4). */
    _renderReferencesStrip(m) {
        const chips = [];
        const rules = m.rules || {};
        const knownMarketIds = new Set((this._refCtx?.markets || []).map((x) => x.id));

        if (m.archetype) {
            chips.push(this._navChip({
                label: `market: ${m.archetype}`, icon: 'category', kind: 'archetype',
                target: m.archetype,
                title: `This branch belongs to the "${m.archetype}" market.`,
            }));
        }
        if (m.kind_id === 'FX') {
            const base = rules.base_currency;
            const quote = rules.quote_currency;
            if (base && quote) {
                chips.push(this._infoChip({ label: `pair: ${base} / ${quote}`, title: 'BASE / QUOTE.' }));
            } else {
                chips.push(this._warningChip({
                    label: base ? `pair: ${base} / ?` : (quote ? `pair: ? / ${quote}` : 'no pair'),
                    title: 'FX needs base and quote currencies.',
                }));
            }
        }
        if (m.kind_id === 'Futures') {
            const ukind = rules.underlying_kind || 'fx';
            if (rules.underlying) {
                chips.push(this._infoChip({ label: `underlying: ${ukind}:${rules.underlying}`, title: `MtM draws from the ${ukind} market for "${rules.underlying}".` }));
            }
            if (rules.spot_market_id) {
                const known = knownMarketIds.has(rules.spot_market_id);
                chips.push(known
                    ? this._navChip({ label: `spot: ${rules.spot_market_id}`, icon: 'storefront', kind: 'market', target: rules.spot_market_id, title: `Spot pinned to "${rules.spot_market_id}".` })
                    : this._warningChip({ label: `spot: ${rules.spot_market_id} (unknown)`, title: 'Stale spot market reference.' }));
            }
            if (rules.tenor_ticks != null && rules.tenor_ticks !== '') {
                chips.push(this._infoChip({ label: `tenor: ${rules.tenor_ticks}t`, title: 'Ticks until cash settlement.' }));
            }
        }
        if (m.kind_id === 'Commodity' && rules.asset_kind) {
            chips.push(this._infoChip({ label: `trades: ${rules.asset_kind}`, title: `Trades the "${rules.asset_kind}" asset kind.` }));
        }
        if (m.kind_id === 'BondAuction') {
            const mech = rules.mechanism || 'discriminatory';
            chips.push(this._infoChip({ label: `mechanism: ${mech}`, title: mech === 'uniform' ? 'Uniform clearing price.' : 'Each winner pays own bid.' }));
        }
        if (m.kind_id === 'Interbank' && rules.tenor_ticks != null && rules.tenor_ticks !== '') {
            chips.push(this._infoChip({ label: `tenor: ${rules.tenor_ticks}t`, title: 'Ticks per loan.' }));
        }
        return chips.join('');
    }

    _navChip({ label, icon, kind, target, title }) {
        const dataAttr = kind === 'archetype' ? 'data-nav-to-archetype' : 'data-nav-to-market';
        const iconHtml = icon ? `<span class="material-symbols-outlined">${esc(icon)}</span>` : '';
        return `<button type="button" class="ea-badge ea-badge--link"
                ${dataAttr}="${esc(target)}" title="${esc(title || '')}">${iconHtml}${esc(label)}</button>`;
    }
    _infoChip({ label, title }) {
        return `<span class="ea-badge ea-badge--muted" title="${esc(title || '')}">${esc(label)}</span>`;
    }
    _warningChip({ label, title }) {
        return `<span class="ea-badge ea-badge--warning" title="${esc(title || '')}">${esc(label)}</span>`;
    }

    _navigateToMarket(marketId) {
        if (!marketId) return;
        this.workspaceTabs?.openTab({
            kind: 'market', entityId: marketId, label: marketId,
            icon: 'storefront', preview: true, from: 'market-tab-ref-chip',
        });
    }
    _navigateToArchetype(archetypeId) {
        if (!archetypeId) return;
        this.workspaceTabs?.openTab({
            kind: 'market-archetype', entityId: archetypeId, label: archetypeId,
            icon: 'category', preview: true, from: 'market-tab-ref-chip',
        });
    }


    // ------------------------------------------------------------- live view

    async _refreshLive() {
        // Equity markets get a per-firm endpoint that also returns the
        // firm vocabulary (Phase M5). Other kinds use the generic
        // aggregate reader.
        const isEquity = this._market?.kind_id === 'Equity';
        const api = window.pywebview?.api;
        const histPromise = api?.market_history?.(this.marketId) ?? [];
        const bookPromise = isEquity
            ? (api?.market_equity_book?.(this.marketId, this._equityFirmFilter)
               ?? { active: false, scope: 'all', firms: [], book: { buys: [], sells: [] } })
            : (api?.market_orderbook?.(this.marketId)
               ?? { active: false, buys: [], sells: [] });
        const [hist, payload] = await Promise.all([histPromise, bookPromise]);
        let book;
        if (isEquity) {
            this._updateFirmPicker(payload.firms || []);
            book = {
                active: payload.active,
                buys:   payload.book?.buys  || [],
                sells:  payload.book?.sells || [],
            };
        } else {
            book = payload || { active: false, buys: [], sells: [] };
        }
        this._renderOrderbook(book);
        this._lastBook = book;
        this._lastHistory = Array.isArray(hist) ? hist : [];
        this._renderTickerHeader(this._lastHistory);
        this._renderMarketChart(this._lastHistory);
    }

    _computeTickerStats(history, windowSize = 30) {
        const finite = (history || []).filter((p) => Number.isFinite(Number(p.price)));
        if (finite.length === 0) return null;
        const windowSlice = finite.slice(-windowSize);
        const first = windowSlice[0];
        const last  = windowSlice[windowSlice.length - 1];
        const prices = windowSlice.map((p) => Number(p.price));
        const high = Math.max(...prices);
        const low  = Math.min(...prices);
        const lastTick = last.tick;
        const volume = (history || [])
            .filter((p) => windowSlice.some((w) => w.tick === p.tick))
            .reduce((sum, p) => sum + (Number(p.volume) || 0), 0);
        const changeAbs = Number(last.price) - Number(first.price);
        const changePct = first.price ? (changeAbs / Number(first.price)) * 100 : 0;
        return {
            lastPrice: Number(last.price), lastTick,
            changeAbs, changePct, high, low, volume,
            windowTicks: windowSlice.length,
        };
    }

    _renderTickerHeader(history) {
        const targets = this._liveTargets('ticker');
        if (targets.length === 0) return;
        const stats = this._computeTickerStats(history);
        if (!stats) {
            const empty = '<div class="ea-market-ticker__empty">No trades cleared yet.</div>';
            for (const t of targets) t.innerHTML = empty;
            return;
        }
        const dir  = stats.changeAbs > 0 ? 'up' : (stats.changeAbs < 0 ? 'down' : 'flat');
        const sign = stats.changeAbs > 0 ? '+' : '';
        const html = `
            <div class="ea-market-ticker__price ea-market-ticker__price--${dir}">
                ${stats.lastPrice.toFixed(2)}
            </div>
            <div class="ea-market-ticker__stat">
                <span class="ea-market-ticker__label">&Delta; (${stats.windowTicks}t)</span>
                <span class="ea-market-ticker__value ea-market-ticker__value--${dir}">
                    ${sign}${stats.changeAbs.toFixed(2)} (${sign}${stats.changePct.toFixed(2)}%)
                </span>
            </div>
            <div class="ea-market-ticker__stat">
                <span class="ea-market-ticker__label">High</span>
                <span class="ea-market-ticker__value">${stats.high.toFixed(2)}</span>
            </div>
            <div class="ea-market-ticker__stat">
                <span class="ea-market-ticker__label">Low</span>
                <span class="ea-market-ticker__value">${stats.low.toFixed(2)}</span>
            </div>
            <div class="ea-market-ticker__stat">
                <span class="ea-market-ticker__label">Vol (${stats.windowTicks}t)</span>
                <span class="ea-market-ticker__value">${stats.volume.toFixed(0)}</span>
            </div>
        `;
        for (const t of targets) t.innerHTML = html;
    }

    _updateFirmPicker(firms) {
        const picker = this._root?.querySelector('[data-role="equity-firm-select"]');
        if (!picker) return;
        const currentValue = picker.value;
        const seen = new Set();
        const opts = ['<option value="">All firms (aggregate)</option>'];
        for (const f of firms) {
            const id = String(f?.id || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const lp = (f.last_price != null) ? `  ${Number(f.last_price).toFixed(2)}` : '';
            opts.push(`<option value="${esc(id)}">${esc(id)}${lp}</option>`);
        }
        picker.innerHTML = opts.join('');
        if (currentValue && seen.has(currentValue)) {
            picker.value = currentValue;
        } else {
            picker.value = '';
            this._equityFirmFilter = null;
        }
    }

    _liveTargets(role) {
        const sel = `.ea-market-live-scope[data-market-id="${this.marketId}"] [data-role="${role}"]`;
        const el = this._root?.querySelector(sel);
        return el ? [el] : [];
    }

    _renderOrderbook(book) {
        const targets = this._liveTargets('orderbook');
        if (targets.length === 0) return;
        const b = book || { active: false, buys: [], sells: [] };
        if (!b.active) {
            const empty = '<div class="ea-plot__placeholder">'
                + 'No active world. Run one to see the order book.</div>';
            for (const target of targets) target.innerHTML = empty;
            return;
        }
        const bestBuy  = b.buys?.[0]?.price;
        const bestSell = b.sells?.[0]?.price;
        const spread = (Number.isFinite(bestBuy) && Number.isFinite(bestSell))
            ? bestSell - bestBuy : null;

        // Aggregate resting orders into price levels — the standard ladder
        // shape (real order books show depth per price, never one row per
        // order; a market with a dozen agents bidding the same price used
        // to render a dozen near-identical rows and starve the column of
        // width). Preserves best-first ordering since `orders` already
        // arrives sorted that way.
        const aggregateByPrice = (orders) => {
            const levels = [];
            const byPrice = new Map();
            for (const o of orders) {
                const price = Number(o.price);
                let level = byPrice.get(price);
                if (!level) {
                    level = { price, volume: 0, agents: [] };
                    byPrice.set(price, level);
                    levels.push(level);
                }
                const vol = Number(o.volume) || 0;
                level.volume += vol;
                level.agents.push({ agent_id: o.agent_id, volume: vol });
            }
            return levels;
        };
        const buyLevelsAll  = aggregateByPrice(b.buys  || []);
        const sellLevelsAll = aggregateByPrice(b.sells || []);
        const buyLevels     = buyLevelsAll.slice(0, 12);
        const sellLevelsAsc = sellLevelsAll.slice(0, 12);
        const sellLevels    = sellLevelsAsc.slice().reverse();

        // Depth bars: cumulative volume from the touch outward, across
        // price LEVELS now rather than raw orders — same "how much size
        // sits between here and the touch" shading.
        const cumulate = (levels) => {
            const out = new Map();
            let running = 0;
            for (const lvl of levels) {
                running += lvl.volume;
                out.set(lvl, running);
            }
            return { cum: out, max: running || 1 };
        };
        const { cum: sellCum, max: sellMax } = cumulate(sellLevelsAsc);
        const { cum: buyCum,  max: buyMax  } = cumulate(buyLevels);
        const depthPct = (lvl, cum, max) => {
            const v = cum.get(lvl);
            return v == null ? 0 : Math.min(100, (v / max) * 100);
        };
        // Per-agent breakdown lives in a hover tooltip rather than a
        // permanent column — the transparency EcoAgent uniquely offers
        // (which agent is behind each order) shouldn't cost every row its
        // width budget.
        const agentTitle = (agents) => agents
            .slice().sort((a, c) => c.volume - a.volume)
            .map((a) => `${a.agent_id || '?'}: ${a.volume.toFixed(0)}`)
            .join('\n');
        const row = (lvl, side, pct) => `
            <tr class="ea-orderbook__row ea-orderbook__row--${side}" style="--depth: ${pct.toFixed(1)}%"
                title="${esc(agentTitle(lvl.agents))}">
                <td class="ea-orderbook__price">${lvl.price.toFixed(2)}</td>
                <td class="ea-orderbook__volume">${lvl.volume.toFixed(0)}</td>
                <td class="ea-orderbook__count">${lvl.agents.length > 1 ? `×${lvl.agents.length}` : ''}</td>
            </tr>`;
        const html = `
            <table class="ea-orderbook__table">
                <thead><tr><th>Price</th><th>Vol</th><th title="Resting orders at this price">N</th></tr></thead>
                <tbody class="ea-orderbook__asks">
                    ${sellLevels.length === 0
                        ? '<tr><td colspan="3" class="ea-orderbook__empty">— no asks —</td></tr>'
                        : sellLevels.map((lvl) => row(lvl, 'sell', depthPct(lvl, sellCum, sellMax))).join('')}
                </tbody>
                <tbody class="ea-orderbook__mid">
                    <tr><td colspan="3" class="ea-orderbook__mid-cell">
                        ${spread != null
                            ? `spread ${spread.toFixed(2)}`
                            : (bestBuy != null
                                ? `bid ${bestBuy.toFixed(2)}`
                                : (bestSell != null
                                    ? `ask ${bestSell.toFixed(2)}`
                                    : 'empty book'))}
                    </td></tr>
                </tbody>
                <tbody class="ea-orderbook__bids">
                    ${buyLevels.length === 0
                        ? '<tr><td colspan="3" class="ea-orderbook__empty">— no bids —</td></tr>'
                        : buyLevels.map((lvl) => row(lvl, 'buy', depthPct(lvl, buyCum, buyMax))).join('')}
                </tbody>
            </table>
        `;
        for (const target of targets) target.innerHTML = html;
    }

    _renderMarketChart(history) {
        const targets = this._liveTargets('chart');
        const series = Array.isArray(history) ? history : [];
        for (const target of targets) {
            // Size is CACHED across tick refreshes — without this every
            // refresh reads getBoundingClientRect(), which jitters as
            // the page lays out (scrollbar toggles, tile widths
            // settling, etc.), and the SVG visibly resizes on every
            // tick during a run. We compute dimensions once, then a
            // ResizeObserver bumps the cache only on real geometry
            // changes (window resize, panel toggle).
            if (!target.__chartSize) {
                this._initChartSizeCache(target);
            }
            const { width, height } = target.__chartSize;
            if (this._chartView === 'depth') {
                const book = this._lastBook || { buys: [], sells: [] };
                renderDepthChart(target, { buys: book.buys || [], sells: book.sells || [], width, height });
            } else {
                renderMarketChart(target, { series, width, height });
            }
        }
    }

    _initChartSizeCache(target) {
        const measure = () => {
            // Measure the inner content area, not the border-box: the
            // SVG renders with explicit pixel width/height attributes,
            // and if we hand it the full border-box size it would
            // overflow the container's padding+border (which `overflow:
            // hidden` would then clip). Subtracting padding+border lets
            // the SVG sit cleanly inside.
            const rect = target.getBoundingClientRect();
            const cs   = getComputedStyle(target);
            const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
            const padY = parseFloat(cs.paddingTop)  + parseFloat(cs.paddingBottom);
            const bdX  = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
            const bdY  = parseFloat(cs.borderTopWidth)  + parseFloat(cs.borderBottomWidth);
            const w = Math.max(320, Math.floor((rect.width  - padX - bdX) || 520));
            const h = Math.max(180, Math.floor((rect.height - padY - bdY) || 240));
            const prev = target.__chartSize;
            target.__chartSize = { width: w, height: h };
            // Trigger a re-render only if the size actually changed —
            // ResizeObserver fires once on observe() too.
            if (prev && (prev.width !== w || prev.height !== h)) {
                this._renderMarketChart(this._lastHistory || []);
            }
        };
        measure();
        try {
            const ro = createRafResizeObserver(() => measure());
            ro.observe(target);
            target.__chartResizeObserver = ro;
        } catch { /* ResizeObserver unavailable */ }
    }

    _openPopout() {
        if (this.tabId) this.workspaceTabs?.popOutTab?.(this.tabId);
    }

    async _onDeleteMarket() {
        const m = this._market;
        if (!m?.archetype || !m?.instance) return;
        const ok = await openConfirm({
            title: 'Delete market instance',
            message: `Delete market instance <strong>${esc(m.id || m.instance)}</strong>?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await window.pywebview?.api?.market_instance_remove?.(
                m.archetype, m.instance,
            );
        } catch (err) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Delete market failed', err?.message || String(err));
            return;
        }
        this.workspaceTabs?.closeTab?.(this.tabId || `market:${this.marketId}`);
    }

    // ------------------------------------------------------------- mutations

    async _setMarketKind(kind) {
        // Kind is an archetype-wide property — every instance shares it.
        const m = this._market;
        if (!m?.archetype) return;
        await window.pywebview?.api?.market_set_kind?.(m.archetype, kind);
        await this._load();
        this._renderDetail();
        this.workspaceTabs?.notifyChanged?.('markets');
    }

    _wireOverrideRows(table) {
        if (!table) return;
        table.querySelectorAll('tr[data-field]').forEach((tr) => {
            const fieldName = tr.dataset.field;
            const input = tr.querySelector('[data-field-input]');
            if (!input) return;
            const save = () => this._saveOverride(fieldName, input, tr);
            input.addEventListener('change', save);
            input.addEventListener('blur',   save);
        });
    }

    async _saveOverride(fieldName, inputEl, rowEl) {
        const m = this._market;
        if (!m?.archetype || !m?.instance) return;
        const schema = RULES_SCHEMA[m.kind_id] || [];
        const field = schema.find((f) => f.name === fieldName);
        // Read the current instance overrides off the cached archetype
        // so we never accidentally promote inherited template values
        // into the override set.
        const currentOverrides = (this._archetype
            ? ((this._archetype.instances || [])
                .find((i) => i.id === m.instance)?.rules || {})
            : {});
        const raw = String(inputEl.value ?? '').trim();
        const next = { ...currentOverrides };
        if (raw === '') {
            delete next[fieldName];
        } else if (field?.type === 'number') {
            const n = Number(raw);
            if (Number.isFinite(n)) next[fieldName] = n;
            else delete next[fieldName];
        } else {
            next[fieldName] = raw;
        }
        if (JSON.stringify(next) === JSON.stringify(currentOverrides)) return;
        const res = await window.pywebview?.api
            ?.market_instance_set_rules?.(m.archetype, m.instance, next);
        if (res && res.ok === false) {
            const { toastError } = await import('../ui/toast.js');
            toastError('Save override failed', res.error);
            return;
        }
        // Optimistic local update so subsequent edits in the same render
        // see the new state. Re-render the whole tab on next refresh.
        if (this._archetype) {
            const inst = (this._archetype.instances || [])
                .find((i) => i.id === m.instance);
            if (inst) inst.rules = next;
        }
        if (rowEl) rowEl.classList.toggle('ea-scen-row--overridden',
            Object.prototype.hasOwnProperty.call(next, fieldName));
        // Update the head-row count without re-rendering the whole tab.
        const countEl = this._root?.querySelector('[data-role="overrides-count"]');
        if (countEl) {
            const cnt = schema.filter((f) => f.name in next).length;
            countEl.textContent = `${cnt}/${schema.length} overridden`;
        }
    }
}
