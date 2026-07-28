/**
 * bottom_panel.js — the global EcoAgent bottom panel.
 *
 * Available on every EcoAgent mode (not just Agents, as the old
 * AgentsBottomPanel was). Hosts three observability tabs, each a
 * distinct concept:
 *
 *   Population   — the agent roster: sampled / live instances of an
 *                  archetype (picker on the right switches archetype).
 *                  Clicking a row opens that instance's dashboard.
 *   Run Console  — diagnostics: errors / notices raised by agent and
 *                  market code while the world runs.
 *   Bus          — the message bus. Live topic snapshot only — click
 *                  a topic row to open the per-topic Bus Inspector
 *                  window, which owns the full event stream, extra
 *                  filters, and the time-travel scrubber.
 *   Store        — the shared key/value store: a live database agents
 *                  coordinate through. No history.
 *
 * Ecosim's shell owns the panel's visibility FSM
 * (`window.__ecoagent.shell._bottomPanelFSM`); we enable it on show()
 * and only own the content inside `#bottom-tabs-content`.
 */

import { openBrainInspector } from './ui/inspector.js';
import { openAgentDashboard } from './ui/agent_dashboard.js';
import { openBusTopicInspector } from './ui/bus_topic_inspector.js';
import { showContextMenu } from './ui/context_menu.js';
import { installOverlayScrollbar } from '../ui/utils/overlay_scrollbar.js';
import { DataTable } from '../ui/components/data_table.js';
import { getSetting } from '../core/settings.js';
import { openForm } from './ui/modal.js';
import { openSchemaForm } from './ui/schema_form.js';
import { openRowForm, openEntityWindow, openEntityRef } from './ui/row_form.js';
import { openColumnForm } from './ui/column_form.js';
import { DragReorder } from '../ui/components/drag_reorder.js';
import { showDeleteConfirmDialog } from '../ui/components/confirm_dialog.js';
import {
    openCreateSectorForm,
    openCreateAssetForm,
    openCreateArchetypeForm,
    openCreateMarketArchetypeForm,
    openCreateScenarioForm,
    openCreateDashboardForm,
    openCreateKpiForm,
} from './ui/entity_create_forms.js';
import { toastError, toastInfo } from './ui/toast.js';
import {
    fetchEvents as fetchEventLog,
    reset as resetEventLog,
    setEventLogStoreLogger,
} from './event_log_store.js';
import {
    PYTHON_HELPERS,
    stringArgContext,
    callContext,
    findHelper,
    parseKwargs,
    HELP_RECIPES,
    WATCH_BREAK_RECIPES,
    substituteRecipeCode,
    proxyShape,
    entityShape,
    receiverAtCaret,
    subscriptIdContext,
    whereKwargContext,
    PROXY_NAMES,
} from './assets/python_query_helpers.js';
import { KNOWN_BUS_TOPICS } from './assets/kpi_templates.js';
import {
    getViewingTick,
    setViewingTick,
    onViewingTickChange,
} from './sfc_view_state.js';

const HOST_ID = 'ea-bottom-host';

// Five tabs, each a distinct concept:
//   SFC          — cross-sector consistency, time series, transaction
//                  flow matrix. Moved here from a workspace tab so the
//                  whole-world view sits alongside the other live
//                  observability panels.
//   Population   — the agent roster (click a row → per-agent dashboard).
//   Run Console  — diagnostics: errors raised by agent / market code.
//   Bus          — message-bus snapshot. Click a topic to open its
//                  Bus Inspector window (full stream + time travel).
//   Store        — the shared key/value store: a live database.
const TABS = [
    { id: 'sfc',         label: 'SFC',         icon: 'account_balance',
      hint: 'World-level SFC views — cross-sector consistency, time series, transaction flow matrix.' },
    { id: 'population',  label: 'Population',  icon: 'groups',
      hint: 'Live instances of an archetype — click a row to open its dashboard.' },
    { id: 'run-console', label: 'Run Console', icon: 'terminal',
      hint: 'Errors and notices raised by agent and market code while the world runs.' },
    { id: 'bus',         label: 'Bus',         icon: 'hub',
      hint: 'The message bus — topics agents publish to. Click a topic row to open the Bus Inspector window for its full event stream, filters, and time-travel scrubber.' },
    { id: 'registries',  label: 'Registries',  icon: 'table_view',
      hint: 'Declared TypedTables — typed rows agents read and mutate (loans, metrics, plus any user-declared tables). Replaces the legacy untyped key/value store.' },
    { id: 'relations',   label: 'Relations',   icon: 'account_tree',
      hint: 'Entity-relationship diagram — every project table and the foreign-key links between them (an agent\u2019s sector, a country\u2019s currency, and so on).' },
    { id: 'watch',       label: 'Watch',       icon: 'visibility',
      hint: 'Population-level watch expressions, evaluated every tick. Same vocabulary as KPIs and the Query tab. Toggle "Break" on a row to pause the world when the expression goes truthy.' },
];

function _getFSM() {
    return window.__ecoagent?.shell?._bottomPanelFSM ?? null;
}


export class BottomPanel {
    constructor({ eventBus, logger, viewState = null, persistState = null } = {}) {
        this.eventBus = eventBus ?? null;
        this.log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };

        // View-state persistence is injectable. The tiling shell passes a
        // per-desktop store (this tile's WM tab props) so each desktop
        // keeps its own active tab + Registries selection. With no adapter
        // (e.g. legacy/standalone callers) it falls back to a single global
        // localStorage key — see _loadBpState / _saveBpState.
        this._injectedView = viewState || null;
        this._persistState = typeof persistState === 'function' ? persistState : null;

        // Run Console is the default — it's synchronously rendered and
        // always has at least the placeholder "no errors yet" message.
        // The SFC tab is async (dynamic import + plotly), so it's
        // available behind a single click but doesn't land the panel
        // in a blank state while the import resolves.
        // Restore the last-opened tab + Registries-browser selection
        // (persisted per-desktop, or to localStorage) so the panel
        // survives reloads. Invalid/stale ids fall back gracefully (the
        // browser re-validates the registry id against the live source
        // list on render).
        const _bp = this._loadBpState();
        const _tabIds = TABS.map((t) => t.id);
        this._activeTabId = _tabIds.includes(_bp.tab) ? _bp.tab : 'run-console';
        // 'graph' is no longer a Registries category (it moved to the
        // Relations tab) — coerce any stale persisted value back to
        // relational so the browser doesn't restore into a dead state.
        this._browserCategory =
            (_bp.category && _bp.category !== 'graph') ? _bp.category : undefined;
        this._activeRegistryId = _bp.registryId || null;
        this._pageActive = false;
        // Lazy-mounted SFC overview instance (lives only while the SFC
        // tab is the active bottom-panel tab — disposed on tab swap).
        this._sfcOverviewTab = null;

        // Population tab.
        this._archetypes = [];
        this._sectors = [];
        this._countries = [];
        this._activeArchetype = null;
        this._countryFilter = '';   // '' = all countries

        // Population tab — track the column signature of the last
        // rendered table so tick refreshes can patch values in place
        // instead of rebuilding the whole table.
        this._popSig = null;

        // Run Console tab (cursor-paginated).
        this._runLog = [];
        this._runLogCursor = 0;
        // Console-style sticky-tail: when true, the runlog page is
        // pinned to the LAST page on every render so new entries are
        // always visible. Toggled off when the user pages backwards
        // through history; re-enabled when they navigate back to the
        // last page (or hit Clear).
        this._runLogStickToTail = true;

        // Bus tab — just a live topic snapshot; clicking a row opens
        // a per-topic inspector window that owns the event stream,
        // extra filters, and the time-travel scrubber.
        this._busState = { active: false, topics: [] };

        // Per-tab pager pages — one entry per paginated surface in the
        // bottom panel. Bus stays unpaginated by design (it's a live
        // snapshot, not a log). Pages reset when their tab repaints.
        this._pages = {
            runlog: 0, registry: 0, query: 0,
            watch: 0,  population: 0,
        };

        setEventLogStoreLogger(this.log);
        // Cross-module activation — any sidebar / tab can ask the
        // bottom panel to surface a specific tab by emitting this
        // event. Replaces the old workspace-tab path for the SFC
        // overview, which now lives down here.
        this._onActivateTab = ({ tabId } = {}) => {
            if (!tabId || !TABS.some((t) => t.id === tabId)) return;
            const fsm = _getFSM();
            try {
                if (fsm?.isHidden?.()) fsm.show?.();
                else if (fsm?.getState?.() === 'on-demand') fsm.pin?.();
            } catch { /* ignore */ }
            this._activateTab(tabId);
        };
        this.eventBus?.on?.('ecoagent:bottom-panel:activate-tab', this._onActivateTab);
    }

    // ------------------------------------------------------------- lifecycle

    show() {
        this._pageActive = true;
        const fsm = _getFSM();
        if (fsm) {
            fsm.supportsCollapse = true;
            try { fsm.enable(); } catch (err) { this.log.warn?.('bottom FSM enable failed', { err }); }
            // Make sure the panel is in a visible state, but don't
            // force-expand — the FSM's persisted #collapsed flag is what
            // makes the toggle remember its state across mode switches.
            // reapply() below fires onShow + onCollapseChanged, which
            // restores the right DOM (display, height, .collapsed class)
            // from the FSM rather than us writing the DOM directly.
            try {
                if (fsm.isHidden?.())                      fsm.show?.();
                else if (fsm.getState?.() === 'on-demand') fsm.pin?.();
            } catch (err) {
                this.log.warn?.('bottom FSM force-show failed', { err });
            }
            try { fsm.reapply(); } catch { /* ignore */ }
        }
        // Install a MutationObserver that re-asserts the FSM's view of
        // the DOM whenever something downstream (Ecosim's _switchMode,
        // stale display:none, etc.) hides the panel or disables the
        // toggle. This is what makes the panel reliably stay visible +
        // selectable across mode transitions on Markets / SFC.
        this._installVisibilityKeeper(fsm);
        // Run once more across the next two frames to win against any
        // rAF-queued re-hide from Ecosim's mode-switch code path.
        requestAnimationFrame(() => {
            this._reassertFsmDom(_getFSM());
            requestAnimationFrame(() => this._reassertFsmDom(_getFSM()));
        });

        this._wireEvents();
        this._loadArchetypes();
        this._paint();
    }

    _installVisibilityKeeper(fsm) {
        if (this._visibilityKeeper) return;
        // The tiling WM owns the bottom panel + its toggle button. Re-asserting
        // legacy FSM DOM here would fight the WM's renderer/sync, so don't.
        if (window.__ecoagent?.shell?._panelsOwnedByWM) return;
        const leftBottom = document.querySelector('.left-bottom');
        if (!leftBottom) return;
        const obs = new MutationObserver(() => {
            if (!this._pageActive) return;
            this._reassertFsmDom(fsm || _getFSM());
        });
        obs.observe(leftBottom, { attributes: true, attributeFilter: ['style', 'class'] });
        const toggle = document.getElementById('toggle-bottom-panel');
        if (toggle) {
            obs.observe(toggle, { attributes: true, attributeFilter: ['disabled', 'class'] });
        }
        this._visibilityKeeper = obs;
    }

    /** Re-drive the FSM so its callbacks restore DOM (display, height,
     *  collapsed class, toggle active state) to whatever the FSM thinks
     *  is correct — including a previously persisted .collapsed value.
     *  No-op unless the panel has been hidden or the toggle disabled
     *  externally, so user-initiated collapse/expand isn't disturbed. */
    _reassertFsmDom(fsm) {
        if (!this._pageActive) return;
        const f = fsm || _getFSM();
        if (!f) return;
        const leftBottom = document.querySelector('.left-bottom');
        const tog = document.getElementById('toggle-bottom-panel');
        const hidden   = leftBottom?.style.display === 'none';
        const disabled = !!tog?.disabled;
        if (!hidden && !disabled) return;
        try { f.reapply(); } catch { /* ignore */ }
        // FSM.reapply() only re-fires the visibility/collapse callbacks;
        // onEnable doesn't re-fire when the FSM was already enabled, so
        // a stale `disabled=true` set by Ecosim outside the FSM would
        // remain. Clear it ourselves when the FSM isn't actually disabled.
        if (tog && !f.isDisabled?.()) tog.disabled = false;
    }

    hide() {
        this._pageActive = false;
        this._unwireEvents();
        // Stop force-reviving the panel — Ecosim now owns its visibility.
        try { this._visibilityKeeper?.disconnect(); } catch { /* ignore */ }
        this._visibilityKeeper = null;
        // Don't touch the FSM — Ecosim's _switchMode disables it when the
        // user leaves the EcoAgent modes entirely.
    }

    _wireEvents() {
        if (this._eventHandlers) return;
        const bus = this.eventBus;
        if (!bus?.on) return;
        this._eventHandlers = {
            // The run log streams UNCONDITIONALLY — a console is a cumulative
            // log, so it must accumulate (and paint, when mounted) on every
            // tick even while another tab is foreground or the legacy
            // visibility FSM mis-reports the tiling panel as hidden. Without
            // this the entries only appeared on the un-gated paint path, i.e.
            // when the user switched tabs. The OTHER tabs stay gated on
            // `_isVisible()` via `_refreshActiveTab` (they needn't render off-
            // screen). See `_refreshActiveTab`.
            'ecoagent:run:tick':       () => { this._fetchRunLog(); this._refreshActiveTab(); },
            'ecoagent:run:completed':  () => { this._fetchRunLog(); this._refreshActiveTab(); },
            // run:error → fetch immediately. The backend appends the abort to
            // the run log BEFORE pushing run:error, so this fetch sees it: an
            // error the user is notified about always lands in the console.
            'ecoagent:run:error':      () => { this._fetchRunLog(); this._refreshActiveTab(); },
            'ecoagent:project:changed': () => {
                this._runLog = []; this._runLogCursor = 0;
                resetEventLog();
                this._activeArchetype = null;
                this._loadArchetypes();
                this._fetchRunLog();        // re-pull / clear the console
                this._refreshActiveTab();
            },
            // A row was inserted via the add-row mask (now a tab in the
            // main content tile). Narrowly refresh the Registries browser —
            // not `project:changed`, which would wipe the run/event logs.
            'ecoagent:rows:changed': () => {
                if (this._activeTabId === 'registries') this._refreshSelectedRegistry();
            },
        };
        for (const [n, fn] of Object.entries(this._eventHandlers)) bus.on(n, fn);
        // Time-series registries reuse the SFC viewing-tick scrubber
        // state so swapping ticks in either place stays in sync.
        if (!this._unsubViewingTick) {
            this._unsubViewingTick = onViewingTickChange(() => {
                if (this._activeTabId !== 'registries') return;
                this._onViewingTickChanged();
            });
        }
    }

    _unwireEvents() {
        const bus = this.eventBus;
        if (bus?.off && this._eventHandlers) {
            for (const [n, fn] of Object.entries(this._eventHandlers)) bus.off(n, fn);
        }
        this._eventHandlers = null;
        if (this._unsubViewingTick) {
            try { this._unsubViewingTick(); } catch { /* ignore */ }
            this._unsubViewingTick = null;
        }
    }

    /** Compute the visible window + pager HTML for a paginated surface.
     *  `key` indexes `this._pages` so each tab keeps its own page state
     *  across re-renders. Returns `{start, end, page, pages, total, html}`.
     *  When there's only one page (`pages <= 1`), `html` is `''` — the
     *  caller doesn't have to special-case that themselves. */
    _renderPager(key, total, pageSize) {
        const t  = Math.max(0, Number(total)    || 0);
        const ps = Math.max(1, Number(pageSize) || 1);
        const pages = Math.max(1, Math.ceil(t / ps));
        const page  = Math.min(Math.max(0, Number(this._pages?.[key]) || 0), pages - 1);
        if (this._pages) this._pages[key] = page;
        if (pages <= 1) {
            return { start: 0, end: t, page, pages, total: t, html: '' };
        }
        return {
            start: page * ps,
            end:   Math.min(t, (page + 1) * ps),
            page, pages, total: t,
            html: `
                <div class="ea-bp-pager">
                    <button type="button" class="ea-btn ea-btn--small"
                            data-pager-action="prev" data-pager-key="${esc(key)}"
                            ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
                    <span class="ea-bp-pager__info">
                        Page ${page + 1} / ${pages} · ${t} ${t === 1 ? 'row' : 'rows'}
                    </span>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-pager-action="next" data-pager-key="${esc(key)}"
                            ${page === pages - 1 ? 'disabled' : ''}>Next ›</button>
                </div>`,
        };
    }

    /** Wire prev/next buttons inside `scope`. On click, bumps the
     *  matching `_pages[key]` and calls `rerender()`. */
    _wirePagers(scope, rerender) {
        if (!scope) return;
        scope.querySelectorAll('[data-pager-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key    = btn.dataset.pagerKey;
                const action = btn.dataset.pagerAction;
                if (!key || !this._pages) return;
                const cur = Number(this._pages[key]) || 0;
                this._pages[key] = Math.max(0, cur + (action === 'next' ? 1 : -1));
                rerender();
            });
        });
    }

    _isVisible() {
        const fsm = _getFSM();
        if (!fsm) return this._pageActive;
        try { return !fsm.isDisabled(); } catch { return this._pageActive; }
    }

    // ----------------------------------------------------------------- paint

    _paint() {
        const tabsEl = document.getElementById('sector-tabs');
        const contentEl = document.getElementById('bottom-tabs-content');
        if (!tabsEl || !contentEl) {
            this.log.warn?.('bottom-panel: containers missing');
            return;
        }
        tabsEl.innerHTML = '';
        for (const t of TABS) {
            const active = t.id === this._activeTabId;
            const el = document.createElement('div');
            el.className = `tab bottom-tab ea-bp-tab${active ? ' active' : ''}`;
            el.dataset.tabId = t.id;
            el.innerHTML = `
                <span class="material-symbols-outlined ea-bp-tab__icon">${t.icon}</span>
                <span class="tab-title">${esc(t.label)}</span>
            `;
            el.addEventListener('click', () => this._activateTab(t.id));
            tabsEl.appendChild(el);
        }

        let host = contentEl.querySelector(`#${HOST_ID}`);
        if (!host) {
            for (const child of Array.from(contentEl.children)) child.style.display = 'none';
            host = document.createElement('div');
            host.id = HOST_ID;
            host.className = 'ea-agents-bottom-host';
            contentEl.appendChild(host);
        } else {
            host.style.display = '';
        }
        this._host = host;
        this._paintActiveTab();
    }

    // ── persisted panel state (last tab + browser selection) ────────
    static _BP_KEY = 'ecoagent:bottompanel';
    _loadBpState() {
        // Per-desktop view-state (injected by the tiling shell) wins; it's
        // this tile's own slice, not a global. Only fall back to the shared
        // localStorage key when no per-tile store was wired.
        if (this._injectedView) return this._injectedView;
        try { return JSON.parse(localStorage.getItem(BottomPanel._BP_KEY) || '{}') || {}; }
        catch { return {}; }
    }
    _saveBpState() {
        const state = {
            tab: this._activeTabId,
            category: this._browserCategory || null,
            registryId: this._activeRegistryId || null,
        };
        if (this._persistState) { this._persistState(state); return; }
        try {
            localStorage.setItem(BottomPanel._BP_KEY, JSON.stringify(state));
        } catch { /* quota / disabled — non-fatal */ }
    }

    _activateTab(tabId) {
        if (this._activeTabId === tabId) return;
        this._activeTabId = tabId;
        this._saveBpState();
        // Reflect the active tab in the tab strip on demand-driven
        // activations (e.g. an external `bottom-panel:activate`); the
        // header buttons own their own active-class swap on click but
        // not on programmatic activation.
        // Repaint also rebuilds the tab strip so the new tab gets the
        // `.active` class — no manual swap needed.
        this._paint();
    }

    /** Public — let other modules switch the active bottom-panel tab
     *  without having to dig into FSM internals. The matching DOM is
     *  in `_activateTab`. */
    activateTab(tabId) { this._activateTab(tabId); }

    _paintActiveTab() {
        const host = this._host;
        if (!host) return;
        // Dispose the previous SFC tab when leaving — it owns Monaco /
        // Plotly instances we don't want piling up across tab swaps.
        if (this._activeTabId !== 'sfc' && this._sfcOverviewTab) {
            try { this._sfcOverviewTab.dispose?.(); } catch { /* ignore */ }
            this._sfcOverviewTab = null;
        }
        // Same idea for the Query tab — Monaco editor + completion
        // provider come down when we leave so they don't bleed into
        // unrelated Python editors elsewhere.
        if (this._activeTabId !== 'watch') this._disposeWatchEditor();
        switch (this._activeTabId) {
            case 'sfc':         this._paintSfcTab(host);         break;
            case 'population':  this._paintPopulationTab(host);  break;
            case 'run-console': this._paintRunConsoleTab(host);  break;
            case 'bus':         this._paintBusTab(host);         break;
            case 'registries':  this._paintRegistriesTab(host);  break;
            case 'relations':   this._paintRelationsTab(host);   break;
            case 'watch':       this._paintWatchTab(host);       break;
        }
    }

    _refreshActiveTab() {
        if (!this._isVisible() || !this._host) return;
        switch (this._activeTabId) {
            case 'sfc':         this._sfcOverviewTab?.refresh?.('tick'); break;
            case 'population':  this._refreshPopulation(); break;
            // run-console is NOT here: it streams unconditionally from the
            // run:tick / run:completed handlers (see `_wireEvents`) so the log
            // accumulates and paints even when this gate would skip it.
            case 'bus':         this._refreshBus();        break;
            case 'registries':  this._refreshRegistries(); break;
            case 'relations':   this._refreshRelations();  break;
            case 'watch':       this._refreshWatch();      break;
            // Query is user-driven: ticks don't auto-rerun the prompt.
        }
    }

    // ============================================================ Population

    async _loadArchetypes() {
        try {
            const [list, sectors, countries] = await Promise.all([
                window.pywebview?.api?.agents_list?.() ?? [],
                window.pywebview?.api?.sectors_list?.() ?? [],
                window.pywebview?.api?.countries_list?.() ?? [],
            ]);
            // Population lists only INSTANTIABLE types — the ones the world
            // build actually creates agents for. The discriminator is
            // `population`: the world only instantiates archetypes with
            // population > 0 (world_model.from_config skips `population <= 0`).
            // A population of 0 marks an abstract agent KIND (e.g. the
            // `worker` / `banker` bases that delegate instantiation to their
            // concrete children) or an opted-out variant — neither produces
            // any instance, so showing them here is misleading (the preview
            // would synthesise sample rows that never exist at runtime).
            this._archetypes = (Array.isArray(list) ? list : [])
                .filter((a) => Number(a.population) !== 0);
            this._sectors = Array.isArray(sectors) ? sectors : [];
            this._countries = Array.isArray(countries) ? countries : [];
        } catch (err) {
            this.log.warn?.('agents_list failed', { err });
            this._archetypes = [];
            this._sectors = [];
            this._countries = [];
        }
        if (!this._archetypes.some((a) => a.archetype === this._activeArchetype)) {
            this._activeArchetype = this._archetypes[0]?.archetype ?? null;
        }
        if (this._activeTabId === 'population' && this._isVisible()) this._paint();
    }

    /** Resolve an archetype's country (via default_sector → sector.country). */
    _archetypeCountry(arch) {
        const sectorId = arch?.default_sector || '';
        if (!sectorId) return '';
        const s = this._sectors.find((s) => s.id === sectorId);
        return s?.country || '';
    }

    // ============================================================ SFC
    //
    // The SFC Overview used to be a workspace tab opened via the SFC
    // sidebar. It now lives in the bottom panel so cross-cutting
    // analytics (consistency tables, time series, transaction flow
    // matrix) sit alongside the other live observability tabs and
    // don't compete with per-entity workspace tabs for the top pane.

    _paintSfcTab(host) {
        host.innerHTML = '';
        // Dynamic import so SfcOverviewTab is only loaded when first
        // viewed (Plotly + DOM-heavy bits). Re-uses the same class
        // that used to live as a workspace tab — its public lifecycle
        // (mount / refresh / dispose) maps cleanly onto how the
        // bottom panel handles tab swaps.
        import('./tabs/sfc_overview_tab.js').then(({ makeSfcOverviewTab }) => {
            // The bottom panel may have swapped tabs between import
            // resolution and now — bail out cleanly if so.
            if (this._activeTabId !== 'sfc' || this._host !== host) return;
            this._sfcOverviewTab = makeSfcOverviewTab(host, 'overview', {
                logger:   this.log,
                eventBus: this.eventBus,
                compact:  true,
            });
            try {
                const ret = this._sfcOverviewTab.mount?.();
                // `mount()` is async; catch its rejection too, otherwise
                // a failure inside the awaited refresh() slips past
                // this sync try/catch and the host stays empty.
                if (ret && typeof ret.catch === 'function') {
                    ret.catch((err) => {
                        this.log.warn?.('sfc tab mount async failed', { err });
                        host.innerHTML = `<div class="ea-table__empty">SFC overview failed: ${err?.message || err}</div>`;
                    });
                }
            } catch (err) {
                this.log.warn?.('sfc tab mount sync failed', { err });
                host.innerHTML = `<div class="ea-table__empty">SFC overview failed: ${err?.message || err}</div>`;
            }
        }).catch((err) => {
            this.log.warn?.('sfc tab import failed', { err });
            host.innerHTML = `<div class="ea-table__empty">Failed to load SFC overview: ${err?.message || err}</div>`;
        });
    }

    // ============================================================ Population

    _paintPopulationTab(host) {
        // Shared header + flows-split body: preview table on the left,
        // an archetype picker on the right. The picker has its own
        // filter input so the user can narrow long archetype lists.
        host.innerHTML = `
            <div class="ea-bp-population">
                <header class="ea-bp__head">
                    <span class="ea-bp__title">Population</span>
                    <div class="ea-bp__actions">
                        <select class="ea-bp__country-filter" data-role="country-filter"
                                title="Show only archetypes whose default sector lives in this country.">
                            <option value="">All countries</option>
                        </select>
                        <input type="search" class="ea-bp__filter" data-role="archetype-filter"
                               placeholder="Filter archetypes…" />
                    </div>
                </header>
                <p class="ea-bp__hint">${esc(_tabHint('population'))}</p>
                <div class="ea-bp-flows-split">
                    <div class="ea-bp-flows-editor" data-role="preview">
                        <div class="ea-table__empty">Pick an archetype on the right.</div>
                    </div>
                    <aside class="ea-bp-flows-picker">
                        <ul class="ea-bp-flows-picker__list" data-role="picker-list"></ul>
                    </aside>
                </div>
            </div>
        `;
        // Replace native scrollbars on these two with Ecosim's hover-only
        // overlay scrollbar.
        //
        // `externalBar: true` is load-bearing: the bar is appended to the
        // container's parent (the split / the aside), not inside the
        // scrollable itself. Without it, _paintPopulationPicker and
        // _refreshPopulation — both of which `innerHTML = …` the list
        // and the editor — would wipe the bar div on every repaint, and
        // the user would only ever see a scrollbar for the brief moment
        // between paint and first re-render (i.e., never).
        const editor = host.querySelector('.ea-bp-flows-editor');
        const list   = host.querySelector('.ea-bp-flows-picker__list');
        if (editor) {
            editor.classList.add('ea-overlay-scroll');
            installOverlayScrollbar(editor, {
                orientation: 'vertical', externalBar: true, watchSubtree: true,
            });
            // Live populations have one column per param + account; on
            // wide archetypes the table easily exceeds the editor pane.
            // `.ea-overlay-scroll` hides BOTH native scrollbars, so we
            // need a horizontal overlay bar too — otherwise content
            // overflows invisibly with no way for the user to scroll
            // sideways.
            installOverlayScrollbar(editor, {
                orientation: 'horizontal', externalBar: true, watchSubtree: true,
            });
        }
        if (list) {
            list.classList.add('ea-overlay-scroll');
            installOverlayScrollbar(list, {
                orientation: 'vertical', externalBar: true, watchSubtree: true,
            });
        }
        // Wire the header's archetype filter input.
        const filt = host.querySelector('[data-role="archetype-filter"]');
        if (filt) {
            filt.value = this._archetypeFilter || '';
            filt.addEventListener('input', () => {
                this._archetypeFilter = filt.value.trim().toLowerCase();
                this._paintPopulationPicker(host);
            });
        }
        // Country filter — only shown when there's more than one country.
        // For single-country (or unconfigured) projects, the dropdown
        // collapses to a single "All countries" entry and is hidden.
        const countrySel = host.querySelector('[data-role="country-filter"]');
        if (countrySel) {
            const multi = (this._countries || []).length > 1;
            countrySel.hidden = !multi;
            if (multi) {
                countrySel.innerHTML = ['<option value="">All countries</option>']
                    .concat((this._countries || []).map((c) =>
                        `<option value="${esc(c.id)}"${c.id === this._countryFilter ? ' selected' : ''}>${esc(c.label || c.id)}</option>`,
                    ))
                    .join('');
                countrySel.value = this._countryFilter || '';
                countrySel.addEventListener('change', () => {
                    this._countryFilter = countrySel.value;
                    this._paintPopulationPicker(host);
                });
            }
        }
        this._paintPopulationPicker(host);
        this._refreshPopulation();
    }

    _paintPopulationPicker(host) {
        const listEl = host.querySelector('[data-role="picker-list"]');
        if (!listEl) return;
        const q = (this._archetypeFilter || '').trim();
        const cfilt = this._countryFilter || '';
        const items = this._archetypes.filter((a) => {
            if (q) {
                const hay = (String(a.archetype || '') + ' ' + String(a.label || ''))
                    .toLowerCase();
                if (!hay.includes(q)) return false;
            }
            if (cfilt && this._archetypeCountry(a) !== cfilt) return false;
            return true;
        });
        if (items.length === 0) {
            listEl.innerHTML = `<li class="ea-bp-flows-picker__empty">${
                this._archetypes.length === 0 ? 'No archetypes.' : 'No matches.'
            }</li>`;
            return;
        }
        listEl.innerHTML = items.map((a) => {
            const active = (a.archetype === this._activeArchetype);
            const label = a.label || a.archetype;
            const cid = this._archetypeCountry(a);
            const country = cid
                ? (this._countries.find((c) => c.id === cid) || { id: cid, label: cid })
                : null;
            const chip = country
                ? `<span class="ea-bp-flows-picker__chip" title="Country">${esc(country.label || country.id)}</span>`
                : '';
            return `
                <li class="ea-bp-flows-picker__item${active ? ' ea-bp-flows-picker__item--active' : ''}"
                    data-archetype="${esc(a.archetype)}" title="${esc(label)}${cid ? ' — ' + esc(cid) : ''}">
                    <span class="material-symbols-outlined ea-bp-flows-picker__icon">group</span>
                    <span class="ea-bp-flows-picker__label">${esc(label)}</span>
                    ${chip}
                </li>
            `;
        }).join('');
        listEl.querySelectorAll('[data-archetype]').forEach((li) => {
            li.addEventListener('click', () => {
                const key = li.dataset.archetype;
                if (key === this._activeArchetype) return;
                this._activeArchetype = key;
                this._paintPopulationPicker(host);
                this._refreshPopulation();
            });
        });
    }

    async _refreshPopulation() {
        const target = this._host?.querySelector('[data-role="preview"]');
        if (!target) return;
        const archetype = this._activeArchetype;
        if (!archetype) {
            this._popSig = null;
            target.innerHTML = '<div class="ea-table__empty">No archetype selected.</div>';
            return;
        }
        // No "Loading…" flash on tick refresh — the table stays visible
        // with the old values until the new ones arrive, then patches in
        // place. The first ever render (no _popSig yet) shows the
        // placeholder normally.
        if (this._popSig == null) {
            target.innerHTML = '<div class="ea-table__empty">Loading…</div>';
        }
        let status = null;
        try { status = await window.pywebview?.api?.world_run_status?.(); }
        catch { /* ignore */ }
        const live = status?.active === true;
        try {
            const n = Math.max(1,
                Math.floor(Number(getSetting('ecoagent.population.sampleSize')) || 5));
            const res = live
                ? await window.pywebview?.api?.world_live_population?.(archetype, n)
                : await window.pywebview?.api?.world_preview_population?.(archetype, n);
            if (!res?.ok) {
                this._popSig = null;
                target.innerHTML = `<div class="ea-table__empty">${esc(res?.error || 'preview failed')}</div>`;
                return;
            }
            this._renderPopulation(target, res.samples, {
                fromRun: !!res.from_run,
                total: res.total ?? res.samples?.length ?? 0,
            });
        } catch (err) {
            this._popSig = null;
            target.innerHTML = `<div class="ea-table__empty">${esc(err?.message || err)}</div>`;
        }
    }

    _renderPopulation(target, samples, opts = {}) {
        if (!samples || samples.length === 0) {
            this._popSig = null;
            target.innerHTML = '<div class="ea-table__empty">No samples — population is 0?</div>';
            return;
        }
        const paramNames    = Object.keys(samples[0].params || {});
        const accountLabels = (samples[0].accounts || []).map((a) => a.label);

        const pager = this._renderPager('population', samples.length, 50);
        const visible = samples.slice(pager.start, pager.end);

        // Signature: archetype + column names + row count + agent ids +
        // fromRun flag + page. If unchanged, we can patch values in
        // place instead of rebuilding the entire table — what keeps
        // tick refreshes from flickering. The page goes into the
        // signature so flipping pages forces a full rebuild.
        const sig = JSON.stringify({
            a: this._activeArchetype,
            p: paramNames,
            c: accountLabels,
            n: visible.length,
            ids: visible.map((s) => s.agent_id),
            run: !!opts.fromRun,
            pg: pager.page,
        });
        if (sig === this._popSig && target.querySelector('.ea-pop-table')) {
            this._patchPopulationCells(target, visible, paramNames, accountLabels);
            return;
        }
        this._popSig = sig;

        const headerCells = [
            '<th>Id</th>',
            ...paramNames.map((n) => `<th class="ea-table__cell">${esc(n)}</th>`),
            ...accountLabels.map((l) =>
                `<th class="ea-table__cell">${esc(l)} <span class="ea-pop-table__tag">init</span></th>`),
            '<th>Brain</th>',
        ].join('');
        const rows = visible.map((s, idx) => {
            const paramCells = paramNames.map((n) =>
                _popCellHtml(s.params?.[n], idx, 'param', n)).join('');
            const accCells = accountLabels.map((l) => {
                const acc = (s.accounts || []).find((a) => a.label === l);
                return _popCellHtml(acc?.initial_value, idx, 'acc', l);
            }).join('');
            return `<tr data-sample-idx="${idx}">
                <td class="ea-pop-table__id"><code>${esc(s.agent_id)}</code></td>
                ${paramCells}
                ${accCells}
                <td data-cell-kind="brain" data-sample-idx="${idx}">
                    <button class="ea-btn ea-inspector-btn" data-sample-idx="${idx}"
                            title="Inspect this instance's brain">
                        <span class="material-symbols-outlined">visibility</span>
                        ${esc(_brainSummary(s.brain))}
                    </button>
                </td>
            </tr>`;
        }).join('');
        const banner = opts.fromRun
            ? `<div class="ea-pop-live-banner">
                 Showing <strong>${samples.length}</strong> of
                 <strong>${opts.total}</strong> running agents
                 — values are live from the ledger.
               </div>`
            : '';
        target.innerHTML = `
            ${banner}
            <table class="ea-table ea-pop-table">
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
            ${pager.html}
        `;
        this._wirePagers(target, () => this._refreshPopulation());
        // Stash the latest VISIBLE samples on the target so the in-place
        // patch path (and the button click handlers) can look up rows by
        // idx without reaching into closure state. `sample-idx` indexes
        // into the visible window, not the full sample set.
        target.__popSamples = visible;
        // Click handlers read the *current* samples from target.__popSamples
        // (set above + refreshed by _patchPopulationCells) rather than the
        // `samples` closure, so clicks after an in-place tick patch see
        // the live values, not whatever was visible when the table was
        // first rendered.
        // Click anywhere on a row → open that instance's dashboard.
        target.querySelectorAll('tr[data-sample-idx]').forEach((tr) => {
            tr.classList.add('ea-pop-table__row--clickable');
            tr.addEventListener('click', () => {
                const idx = Number(tr.dataset.sampleIdx);
                const s = (target.__popSamples || [])[idx];
                if (!s) return;
                openAgentDashboard({ archetype: this._activeArchetype, sample: s });
            });
        });
        // The eye button is a shortcut to the same per-agent dashboard
        // the row click opens — both routes go to one window so users
        // never face two overlapping "agent inspectors".
        target.querySelectorAll('button.ea-inspector-btn[data-sample-idx]').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = Number(btn.dataset.sampleIdx);
                const s = (target.__popSamples || [])[idx];
                if (!s) return;
                openAgentDashboard({ archetype: this._activeArchetype, sample: s });
            });
        });
        // JSON-content cells (list / dict values in params or accounts):
        // open the raw value in a managed window for read + copy.
        target.querySelectorAll('button.ea-pop-json-btn[data-sample-idx]').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = Number(btn.dataset.sampleIdx);
                const s = (target.__popSamples || [])[idx];
                if (!s) return;
                const kind = btn.dataset.cellKind;
                const key = btn.dataset.cellKey;
                let value;
                if (kind === 'param') value = s.params?.[key];
                else if (kind === 'acc') value = (s.accounts || []).find((a) => a.label === key)?.initial_value;
                _openJsonInspector({
                    title: `${kind === 'param' ? 'Param' : 'Account'} · ${key} · ${s.agent_id}`,
                    value,
                });
            });
        });
    }

    /** Streaming-tick fast path. Same row structure, same column layout —
     *  just refresh the value text of every TD in place. Avoids the full
     *  innerHTML rewrite (and the focus / scroll / event-handler loss
     *  that comes with it) on every simulation tick. */
    _patchPopulationCells(target, samples, paramNames, accountLabels) {
        target.__popSamples = samples;
        const tbody = target.querySelector('.ea-pop-table tbody');
        if (!tbody) return;
        const rows = tbody.children;
        for (let idx = 0; idx < samples.length && idx < rows.length; idx++) {
            const s = samples[idx];
            const row = rows[idx];
            for (const name of paramNames) {
                const td = row.querySelector(
                    `td[data-cell-kind="param"][data-cell-key="${cssAttrEsc(name)}"]`);
                if (td) _patchPopCell(td, s.params?.[name]);
            }
            for (const label of accountLabels) {
                const td = row.querySelector(
                    `td[data-cell-kind="acc"][data-cell-key="${cssAttrEsc(label)}"]`);
                if (!td) continue;
                const acc = (s.accounts || []).find((a) => a.label === label);
                _patchPopCell(td, acc?.initial_value);
            }
            // Refresh the brain summary text inside the inspector button
            // without re-wiring the click handler.
            const brainBtn = row.querySelector('td[data-cell-kind="brain"] .ea-inspector-btn');
            if (brainBtn) {
                const sym = brainBtn.querySelector('.material-symbols-outlined');
                const summary = _brainSummary(s.brain);
                brainBtn.textContent = '';
                if (sym) brainBtn.appendChild(sym);
                else {
                    const ic = document.createElement('span');
                    ic.className = 'material-symbols-outlined';
                    ic.textContent = 'visibility';
                    brainBtn.appendChild(ic);
                }
                brainBtn.appendChild(document.createTextNode(' ' + summary));
            }
        }
    }

    // =========================================================== Run Console

    _paintRunConsoleTab(host) {
        if (this._runLogLevelFilter == null) this._runLogLevelFilter = 'all';
        host.innerHTML = `
            <div class="ea-bp-runconsole">
                <header class="ea-bp__head ea-runlog__chrome">
                    <div class="ea-runlog__levels" role="tablist" aria-label="Filter by level">
                        <button type="button" class="ea-runlog__level" data-level="all"
                                title="All entries">
                            <span class="ea-runlog__level-icon material-symbols-outlined">list_alt</span>
                            <span class="ea-runlog__level-label">All</span>
                            <span class="ea-runlog__level-count" data-count="all">0</span>
                        </button>
                        <button type="button" class="ea-runlog__level ea-runlog__level--info" data-level="info"
                                title="Info">
                            <span class="ea-runlog__level-icon material-symbols-outlined">info</span>
                            <span class="ea-runlog__level-label">Info</span>
                            <span class="ea-runlog__level-count" data-count="info">0</span>
                        </button>
                        <button type="button" class="ea-runlog__level ea-runlog__level--warn" data-level="warn"
                                title="Warnings">
                            <span class="ea-runlog__level-icon material-symbols-outlined">warning</span>
                            <span class="ea-runlog__level-label">Warn</span>
                            <span class="ea-runlog__level-count" data-count="warn">0</span>
                        </button>
                        <button type="button" class="ea-runlog__level ea-runlog__level--error" data-level="error"
                                title="Errors">
                            <span class="ea-runlog__level-icon material-symbols-outlined">error</span>
                            <span class="ea-runlog__level-label">Error</span>
                            <span class="ea-runlog__level-count" data-count="error">0</span>
                        </button>
                    </div>
                    <div class="ea-bp__actions">
                        <input type="search" class="ea-bp__filter" data-role="runlog-filter"
                               placeholder="Filter messages…" />
                        <button type="button" class="ea-btn ea-btn--small" data-action="clear-runlog"
                                title="Clear the log">Clear</button>
                    </div>
                </header>
                <div id="ea-bp-runlog" class="ea-runlog">
                    <div class="ea-plot__placeholder">No errors or notices yet — run the world to populate.</div>
                </div>
            </div>
        `;
        host.querySelector('[data-action="clear-runlog"]')
            ?.addEventListener('click', async () => {
                await window.pywebview?.api?.world_run_log_clear?.();
                this._runLog = [];
                this._runLogCursor = 0;
                this._runLogStickToTail = true;
                this._renderRunLog();
            });
        const filt = host.querySelector('[data-role="runlog-filter"]');
        if (filt) {
            filt.value = this._runLogFilter || '';
            filt.addEventListener('input', () => {
                this._runLogFilter = filt.value.trim().toLowerCase();
                this._renderRunLog();
            });
        }
        host.querySelectorAll('.ea-runlog__level').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._runLogLevelFilter = btn.dataset.level || 'all';
                this._renderRunLog();
            });
        });

        // Right-click menu — copy the row under the cursor or the
        // whole log as JSON. Wired at the run-console container level
        // (not the rows) so paginated re-renders don't re-wire it,
        // and in CAPTURE phase so the document-level preventDefault in
        // app_bootstrap doesn't beat us to it. Capture-phase also
        // means we run BEFORE any child handler that might stop
        // propagation.
        const runConsole = host.querySelector('.ea-bp-runconsole');
        if (runConsole) {
            runConsole.addEventListener('contextmenu', (ev) => {
                // Only handle right-clicks inside the actual log area —
                // chrome (chips, filter, Clear button) keeps native menu
                // suppression but doesn't open ours.
                if (!ev.target.closest('#ea-bp-runlog')) return;
                // Inside an expanded traceback's <pre>, let the user
                // use native text-selection copy via the browser menu.
                if (ev.target.closest('.ea-runlog__tb pre')) return;
                ev.preventDefault();
                ev.stopPropagation();
                this._showRunLogContextMenu(ev);
            }, true);
        }

        this._fetchRunLog();
    }

    _showRunLogContextMenu(ev) {
        const row = ev.target?.closest?.('[data-runlog-idx]');
        const idx = row ? Number(row.dataset.runlogIdx) : null;
        const entry = (idx != null && Number.isFinite(idx))
            ? this._runLog[idx] : null;

        // Visible highlight on the right-clicked row so the menu items
        // ("Copy this message") have a clear referent. Cleared when
        // the menu closes (any mousedown that isn't on the menu, or
        // Escape — see context_menu.js's _outsideHandler).
        this._host?.querySelectorAll?.('.ea-runlog__row--active')
            .forEach((el) => el.classList.remove('ea-runlog__row--active'));
        if (row) row.classList.add('ea-runlog__row--active');

        const filtered = this._currentFilteredRunLog();
        const filterActive = filtered.length !== this._runLog.length;
        const items = [];
        if (entry) {
            items.push({
                label: 'Copy this message',
                icon: 'content_copy',
                action: 'copy-one',
            });
            items.push({ separator: true });
        }
        if (filterActive) {
            items.push({
                label: `Copy filtered (${filtered.length})`,
                icon: 'filter_list',
                action: 'copy-filtered',
            });
        }
        items.push({
            label: `Copy all messages (${this._runLog.length})`,
            icon: 'select_all',
            action: 'copy-all',
        });
        if (items.length === 0) return;
        const clearHighlight = () => {
            this._host?.querySelectorAll?.('.ea-runlog__row--active')
                .forEach((el) => el.classList.remove('ea-runlog__row--active'));
        };
        showContextMenu(ev.clientX, ev.clientY, items, async (action) => {
            let payload = null;
            if (action === 'copy-one')      payload = entry;
            if (action === 'copy-filtered') payload = filtered;
            if (action === 'copy-all')      payload = this._runLog;
            clearHighlight();
            if (payload == null) return;
            const text = JSON.stringify(payload, null, 2);
            try {
                await navigator.clipboard.writeText(text);
            } catch (err) {
                this.log?.warn?.('clipboard write failed', { err });
            }
        });
        // Also clear the highlight when the menu is dismissed without
        // choosing an action — the context_menu utility removes the
        // menu element from the DOM on outside-click / Escape; we
        // observe that and drop our row class too.
        const obs = new MutationObserver(() => {
            if (!document.querySelector('.ea-context-menu')) {
                clearHighlight();
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true });
    }

    /** Apply the same level + text filters _renderRunLog uses, so the
     *  "Copy filtered" action copies exactly what the user sees. */
    _currentFilteredRunLog() {
        const lvlFilter = this._runLogLevelFilter || 'all';
        const q = (this._runLogFilter || '').trim();
        return this._runLog.filter((e) => {
            if (lvlFilter !== 'all'
                && String(e.level || 'info').toLowerCase() !== lvlFilter) return false;
            if (!q) return true;
            return String(e.message || '').toLowerCase().includes(q)
                || String(e.source  || '').toLowerCase().includes(q);
        });
    }

    async _fetchRunLog() {
        try {
            const res = await window.pywebview?.api?.world_run_log?.(this._runLogCursor);
            if (!res) return;
            if (Number(res.total) < this._runLogCursor) {
                this._runLog = []; this._runLogCursor = 0;
            }
            const entries = Array.isArray(res.entries) ? res.entries : [];
            if (entries.length > 0) {
                this._runLog.push(...entries);
                this._runLogCursor = Number(res.total) || (this._runLogCursor + entries.length);
            }
        } catch { /* ignore */ }
        this._renderRunLog();
    }

    _renderRunLog() {
        const target = this._host?.querySelector('#ea-bp-runlog');
        if (!target) return;

        // Per-level counts drive both the filter chips and the dim
        // state when a level has zero entries.
        const counts = { all: this._runLog.length, info: 0, warn: 0, error: 0, debug: 0 };
        for (const e of this._runLog) {
            const lvl = String(e.level || 'info').toLowerCase();
            if (counts[lvl] != null) counts[lvl] += 1;
        }
        const host = this._host;
        if (host) {
            host.querySelectorAll('.ea-runlog__level').forEach((btn) => {
                const k = btn.dataset.level || 'all';
                const c = counts[k] ?? 0;
                const badge = btn.querySelector('[data-count]');
                if (badge) badge.textContent = String(c);
                btn.classList.toggle('is-active',
                    (this._runLogLevelFilter || 'all') === k);
                btn.classList.toggle('is-empty', k !== 'all' && c === 0);
            });
        }

        // Filter by level chip + text query (case-insensitive).
        const lvlFilter = this._runLogLevelFilter || 'all';
        const q = (this._runLogFilter || '').trim();
        const log = this._runLog.filter((e) => {
            if (lvlFilter !== 'all'
                && String(e.level || 'info').toLowerCase() !== lvlFilter) return false;
            if (!q) return true;
            return String(e.message || '').toLowerCase().includes(q)
                || String(e.source  || '').toLowerCase().includes(q);
        });

        if (log.length === 0) {
            target.innerHTML = `<div class="ea-plot__placeholder">${
                this._runLog.length === 0
                    ? 'No errors or notices yet — run the world to populate.'
                    : 'No log entries match the filter.'
            }</div>`;
            return;
        }
        // Sticky-tail: pin to the last page so newly-arrived entries
        // are always on-screen. _wirePagers is generic; we run our
        // own click hook below to toggle sticky based on where the
        // user lands.
        const pageSize = 100;
        const pageCount = Math.max(1, Math.ceil(log.length / pageSize));
        if (this._runLogStickToTail && this._pages) {
            this._pages.runlog = pageCount - 1;
        }
        const pager = this._renderPager('runlog', log.length, pageSize);
        const wasAtBottom =
            target.scrollHeight - target.scrollTop - target.clientHeight < 24
            || this._runLogStickToTail;
        // Stamp each row with its index in `this._runLog` (the full
        // unfiltered array) so the contextmenu handler can look up the
        // entry regardless of pagination / filter state.
        const rowsHtml = log.slice(pager.start, pager.end).map((e) => {
            const lvl = String(e.level || 'info').toLowerCase();
            const icon = _runlogIconForLevel(lvl);
            const idx = this._runLog.indexOf(e);
            return `
                <div class="ea-runlog__row ea-runlog__row--${esc(lvl)}"
                     data-runlog-idx="${idx}">
                    <span class="ea-runlog__gutter material-symbols-outlined"
                          aria-hidden="true">${icon}</span>
                    <span class="ea-runlog__tick">t${e.tick}</span>
                    <span class="ea-runlog__source" title="${esc(e.source || '')}">${esc(e.source || '')}</span>
                    <span class="ea-runlog__message">${esc(e.message || '')}</span>
                    ${e.traceback ? `<details class="ea-runlog__tb">
                        <summary><span class="material-symbols-outlined">subdirectory_arrow_right</span> Stack trace</summary>
                        <pre>${esc(e.traceback)}</pre>
                    </details>` : ''}
                </div>
            `;
        }).join('');
        target.innerHTML = rowsHtml + pager.html;
        this._wirePagers(target, () => {
            // After a Prev/Next click _pages.runlog is the user's
            // explicit choice — sticky-tail if they're on the last
            // page, otherwise off so they can read older entries
            // without the next tick yanking them back to the tail.
            const totalNow = Math.max(0,
                Number(this._pages?.runlog) || 0);
            this._runLogStickToTail = totalNow >= (pageCount - 1);
            this._renderRunLog();
        });
        if (wasAtBottom) target.scrollTop = target.scrollHeight;
    }

    // ==================================================================== Bus

    _paintBusTab(host) {
        if (this._busFilterScope == null) this._busFilterScope = 'all';
        host.innerHTML = `
            <div class="ea-bp-busstore">
                <header class="ea-bp__head">
                    <span class="ea-bp__title">Bus</span>
                    <span class="ea-bus__pending" id="ea-bp-bus-pending"></span>
                    <div class="ea-bp__actions">
                        <div class="ea-bp__filter-group">
                            <select class="ea-bp__filter-scope" data-role="bus-filter-scope"
                                    title="Which field to match against">
                                <option value="all">All</option>
                                <option value="topic">Topic</option>
                                <option value="payload">Payload</option>
                                <option value="type">Type</option>
                            </select>
                            <input type="search" class="ea-bp__filter" data-role="bus-filter"
                                   placeholder="Filter…" />
                        </div>
                    </div>
                </header>
                <p class="ea-bp__hint">${esc(_tabHint('bus'))}</p>
                <div class="ea-bp-busstore__body">
                    <div id="ea-bp-bus-state" class="ea-bp-busstore__scroll">
                        <div class="ea-plot__placeholder">No bus activity yet.</div>
                    </div>
                </div>
            </div>
        `;
        const filt = host.querySelector('[data-role="bus-filter"]');
        if (filt) {
            filt.value = this._busFilter || '';
            filt.addEventListener('input', () => {
                this._busFilter = filt.value.trim().toLowerCase();
                this._renderBusState();
            });
        }
        const scope = host.querySelector('[data-role="bus-filter-scope"]');
        if (scope) {
            scope.value = this._busFilterScope || 'all';
            scope.classList.toggle('is-scoped', scope.value !== 'all');
            scope.addEventListener('change', () => {
                this._busFilterScope = scope.value || 'all';
                scope.classList.toggle('is-scoped',
                    this._busFilterScope !== 'all');
                this._renderBusState();
            });
        }
        this._refreshBus();
    }

    _refreshBus() {
        this._refreshBusState();
        // Keep the shared event-log buffer warm — open inspector windows
        // read from it, and we use its max tick on the snapshot badge.
        fetchEventLog();
    }

    async _refreshBusState() {
        try {
            this._busState = await window.pywebview?.api?.world_bus_state?.()
                ?? { active: false, topics: [] };
        } catch { /* ignore */ }
        this._renderBusState();
    }

    _renderBusState() {
        const target = this._host?.querySelector('#ea-bp-bus-state');
        const pendingEl = this._host?.querySelector('#ea-bp-bus-pending');
        if (!target) return;
        const state = this._busState || { active: false, topics: [] };
        if (pendingEl) {
            // The world clock now lives on the bar-right (#sim-tick);
            // only surface a pending-message count here when there is
            // something noteworthy.
            pendingEl.textContent = state.active && state.pending_count
                ? `${state.pending_count} pending` : '';
        }
        const allTopics = Array.isArray(state.topics) ? state.topics : [];
        const q = (this._busFilter || '').trim();
        const scope = this._busFilterScope || 'all';
        const matchTopic = (t) => {
            if (!q) return true;
            const fields = [];
            const p = t.payload || {};
            if (scope === 'topic' || scope === 'all') {
                fields.push(t.topic);
            }
            if (scope === 'payload' || scope === 'all') {
                fields.push(busPayloadSummary(p));
            }
            if (scope === 'type' || scope === 'all') {
                fields.push(p.type, p.kind);
            }
            return fields.some((v) =>
                String(v ?? '').toLowerCase().includes(q));
        };
        const topics = q ? allTopics.filter(matchTopic) : allTopics;
        if (!state.active || allTopics.length === 0) {
            target.innerHTML = '<div class="ea-plot__placeholder">'
                + (state.active
                    ? "No messages delivered yet — agents haven't published."
                    : 'No bus activity yet.') + '</div>';
            return;
        }
        if (topics.length === 0) {
            target.innerHTML =
                '<div class="ea-plot__placeholder">No topics match the filter.</div>';
            return;
        }
        target.innerHTML = `
            <table class="ea-table ea-bus-table">
                <thead><tr>
                    <th>Topic</th>
                    <th>Latest payload</th>
                    <th class="ea-table__cell">Type</th>
                    <th class="ea-table__cell">Δ deliveries</th>
                </tr></thead>
                <tbody>
                    ${topics.map((t, idx) => {
                        const p = t.payload || { kind: 'primitive', value: null };
                        const summary = busPayloadSummary(p);
                        return `
                            <tr class="ea-bus-row" data-bus-idx="${idx}"
                                title="Click to open the Bus Inspector for ${esc(t.topic)}">
                                <td><code class="ea-bus__topic">${esc(t.topic)}</code></td>
                                <td><code class="ea-bus__payload">${esc(summary)}</code></td>
                                <td class="ea-table__cell"><span class="ea-bus__kind">${esc(p.type || p.kind || '?')}</span></td>
                                <td class="ea-table__cell">${t.delivery_count}</td>
                            </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        target.querySelectorAll('tr[data-bus-idx]').forEach((tr) => {
            tr.addEventListener('click', () => {
                const t = topics[Number(tr.dataset.busIdx)];
                if (!t) return;
                openBusTopicInspector({ topic: t.topic, eventBus: this.eventBus });
            });
        });
    }

    // ============================================================ Registries
    //
    // TypedTable explorer. Lists every declared registry on the right, renders
    // the selected one's rows on the left. Replaces the legacy Store tab —
    // schemas are typed and indexed now.

    async _refreshRegistries() {
        // Browser endpoint replaces world_registries_list as the source
        // manifest — it covers archetypes, instances, static data,
        // relations, runtime registries, and documents. The legacy
        // `_registriesState` slot is reused so existing callers stay
        // unchanged; its shape is now { active, sources: [...] }.
        // Spinner up-front so the source-manifest fetch (the first slow gap
        // before any source is even selected) shows progress too; the rows
        // fetch in _refreshSelectedRegistry keeps it up until rows paint.
        this._setRegistryLoading(true);
        try {
            const res = await window.pywebview?.api?.browser_sources_list?.()
                ?? { active: false, sources: [] };
            this._registriesState = res;
        } catch { /* ignore */ }
        this._renderRegistriesShell();
        await this._refreshSelectedRegistry();
    }

    _paintRegistriesTab(host) {
        host.innerHTML = `
            <div class="ea-bp-busstore">
                <header class="ea-bp__head">
                    <div class="ea-bp-browser__cats" data-role="browser-cats">
                        <button type="button"
                                class="ea-bp-browser__cat ea-bp-browser__cat--schema"
                                data-role="schema-toggle"
                                title="Show / hide schema row">Schema</button>
                        <button type="button"
                                class="ea-bp-browser__cat ea-bp-browser__cat--query"
                                data-role="query-toggle"
                                title="Query this source with a Python expression (live world &amp; time-series)">Query</button>
                    </div>
                    <span class="ea-bp__title" data-role="browser-title">—</span>
                    <span class="ea-bus__pending" data-role="reg-count"></span>
                    <!-- Time-series tape deck (M2): input + ±1 + Latest
                         lock. Only visible when category=time_series. -->
                    <div class="ea-time-scrubber ea-time-scrubber--compact ea-time-scrubber--tape"
                         data-role="reg-scrubber" hidden>
                        <span class="ea-time-scrubber__label">Tick</span>
                        <input type="number" min="0" inputmode="numeric"
                               class="ea-time-scrubber__input"
                               data-role="reg-tick-input"
                               title="Show rows up to this tick (≤). Default = current max.">
                        <button type="button" class="ea-icon-btn ea-time-scrubber__step"
                                data-role="reg-tick-back"
                                title="Previous tick">
                            <span class="material-symbols-outlined">chevron_left</span>
                        </button>
                        <button type="button" class="ea-icon-btn ea-time-scrubber__step"
                                data-role="reg-tick-fwd"
                                title="Next tick">
                            <span class="material-symbols-outlined">chevron_right</span>
                        </button>
                        <button type="button"
                                class="ea-bp-browser__cat ea-bp-browser__cat--latest"
                                data-role="reg-tick-latest"
                                aria-pressed="false"
                                title="Pin to the latest tick; auto-streams as the world advances. Click again to unlock.">Latest</button>
                    </div>
                    <!-- Relational slicer: original slider verbatim.
                         Slider position IS the latest indicator —
                         max = latest. Only the filter semantics change
                         (t<= instead of t==), nothing else. -->
                    <div class="ea-time-scrubber ea-time-scrubber--compact"
                         data-role="reg-slicer" hidden>
                        <span class="ea-time-scrubber__label">Tick</span>
                        <input type="range" data-role="reg-slicer-slider"
                               min="0" max="0" value="0">
                        <span class="ea-time-scrubber__value"
                              data-role="reg-slicer-value">0</span>
                    </div>
                    <div class="ea-bp__actions">
                        <div class="ea-bp__filter-group">
                            <select class="ea-bp__filter-scope" data-role="reg-filter-scope"
                                    title="Which column to match against">
                                <option value="all">All</option>
                            </select>
                            <input type="search" class="ea-bp__filter" data-role="reg-filter"
                                   placeholder="Filter…" />
                            <button type="button" class="ea-bp__filter-mode"
                                    data-role="reg-filter-search-across"
                                    title="Search across every source in this category">
                                <span class="material-symbols-outlined">travel_explore</span>
                            </button>
                        </div>
                    </div>
                </header>
                <div class="ea-bp-browser__schema is-collapsed" data-role="schema-strip">
                    <div class="ea-bp-browser__schema-body" data-role="schema-body"></div>
                    <button type="button"
                            class="ea-bp-browser__schema-edit"
                            data-role="schema-edit"
                            title="Edit this schema"
                            hidden>
                        <span class="material-symbols-outlined">edit</span>
                        <span>Edit</span>
                    </button>
                </div>
                <p class="ea-bp__hint">${esc(_tabHint('registries'))}</p>
                <div class="ea-bp-flows-split">
                    <div class="ea-bp-flows-editor" data-role="reg-rows">
                        <div class="ea-table__empty">Pick a source on the right.</div>
                    </div>
                    <aside class="ea-bp-flows-picker">
                        <div class="ea-bp-flows-picker__head">
                            <!-- Compact action buttons. New-entity surfaces only
                                 in the Relational category (where sectors /
                                 agents / etc. live); New-schema only in Time series
                                 (the one category whose rows are user-declarable
                                 TypedTable schemas). Visibility toggled by
                                 _renderRegistriesShell. -->
                            <button type="button"
                                    class="ea-bp-flows-picker__add ea-bp-flows-picker__add--icon"
                                    data-role="browser-new-entity"
                                    title="Create a new entity (sector, agent, KPI…)"
                                    hidden>
                                <span class="material-symbols-outlined">add</span>
                            </button>
                            <button type="button"
                                    class="ea-bp-flows-picker__add ea-bp-flows-picker__add--icon"
                                    data-role="browser-new-schema"
                                    title="Create a new table (relational or time-series). Add a tick column to make it time-series."
                                    hidden>
                                <span class="material-symbols-outlined">post_add</span>
                            </button>
                        </div>
                        <ul class="ea-bp-flows-picker__list" data-role="reg-picker"></ul>
                    </aside>
                </div>
            </div>
        `;
        const filt = host.querySelector('[data-role="reg-filter"]');
        if (filt) {
            filt.value = this._registryFilter || '';
            filt.addEventListener('input', () => {
                this._registryFilter = filt.value.trim().toLowerCase();
                if (this._searchAcrossOn) this._runSearchAcross();
                else this._renderRegistryRows();
            });
        }
        // Search-across toggle — flips the rows pane to a faceted
        // results view that scans every source in the active category.
        const sxBtn = host.querySelector('[data-role="reg-filter-search-across"]');
        if (sxBtn) {
            const syncBtn = () => sxBtn.classList.toggle('is-active',
                !!this._searchAcrossOn);
            syncBtn();
            sxBtn.addEventListener('click', () => {
                this._searchAcrossOn = !this._searchAcrossOn;
                syncBtn();
                if (this._searchAcrossOn) this._runSearchAcross();
                else {
                    this._registryRowsState = this._lastSingleSourceRowsState
                        || this._registryRowsState;
                    this._renderRegistryRows();
                }
            });
        }
        const scope = host.querySelector('[data-role="reg-filter-scope"]');
        if (scope) {
            scope.addEventListener('change', () => {
                this._registryFilterScope = scope.value || 'all';
                scope.classList.toggle('is-scoped',
                    this._registryFilterScope !== 'all');
                this._renderRegistryRows();
            });
        }
        // M2 — tape-deck tick toolbar. Latest is a LOCKING toggle: when
        // on it owns the mode and the manual controls (input, ◀, ▶)
        // are disabled — the user must explicitly click Latest again
        // to unlock before touching them. This mirrors the standard
        // CAPS-LOCK pattern; without it, a typo or stray click would
        // silently break streaming during a live run.
        const tickInput  = host.querySelector('[data-role="reg-tick-input"]');
        const tickBack   = host.querySelector('[data-role="reg-tick-back"]');
        const tickFwd    = host.querySelector('[data-role="reg-tick-fwd"]');
        const tickLatest = host.querySelector('[data-role="reg-tick-latest"]');
        // Latest defaults to locked-on for time series — that's what
        // "show the latest data" means out of the box. The streaming
        // branch in _syncTapeDeck then pins the picker to maxTick on
        // every refresh, so the input reads max from first paint. User
        // toggling off is sticky (only the `== null` init applies).
        if (this._regTickLatest == null) this._regTickLatest = true;

        const _pin = (t) => {
            // Manual pin path — only reachable when Latest is off
            // (handlers below short-circuit otherwise).
            setViewingTick(t == null ? null : Math.max(0, Math.floor(t)));
        };
        tickInput?.addEventListener('change', () => {
            if (this._regTickLatest) return; // locked
            const raw = String(tickInput.value || '').trim();
            if (raw === '') { _pin(null); return; }
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) {
                // Reject garbage; reflect current viewing-tick back.
                this._updateRegistryScrubber();
                return;
            }
            const max = this._maxTickKnown || 0;
            _pin(max > 0 ? Math.min(max, n) : n);
        });
        tickBack?.addEventListener('click', () => {
            if (this._regTickLatest) return; // locked
            const cur = getViewingTick();
            const base = cur == null ? (this._maxTickKnown || 0) : cur;
            _pin(base - 1);
        });
        tickFwd?.addEventListener('click', () => {
            if (this._regTickLatest) return; // locked
            const cur = getViewingTick();
            const max = this._maxTickKnown || 0;
            const base = cur == null ? 0 : cur;
            _pin(max > 0 ? Math.min(max, base + 1) : base + 1);
        });
        tickLatest?.addEventListener('click', () => {
            this._regTickLatest = !this._regTickLatest;
            if (this._regTickLatest) {
                // Lock on — pin to current max; future refreshes bump
                // it as `ecoagent:run:tick` fires.
                setViewingTick(this._maxTickKnown ?? null);
            }
            // Sync the lock state (button highlight + disabled inputs).
            this._updateRegistryScrubber();
        });

        // Relational slicer — restored original slider with t<= filter
        // semantics. Distinct from the tape deck above so each category
        // uses the control that fits its data shape:
        //   • time_series  → tape deck (exact-tick pin + Latest stream)
        //   • relational   → slider (cumulative t<= "as of tick N")
        const slicerSlider = host.querySelector('[data-role="reg-slicer-slider"]');
        const slicerValEl  = host.querySelector('[data-role="reg-slicer-value"]');
        if (this._sliderAutoFollow == null) this._sliderAutoFollow = true;
        if (slicerSlider) {
            const _onSliderMove = (v) => {
                // User drag → opt out of auto-follow UNLESS they're
                // back at the right end (== current max), in which
                // case auto-follow resumes naturally.
                const n = Number(v);
                const max = this._maxTickKnown || 0;
                this._sliderAutoFollow = (n >= max);
                setViewingTick(n);
            };
            slicerSlider.addEventListener('input', () => {
                if (slicerValEl) slicerValEl.textContent = String(slicerSlider.value);
                clearTimeout(this._slicerDebounce);
                this._slicerDebounce = setTimeout(() => {
                    _onSliderMove(slicerSlider.value);
                }, 60);
            });
            slicerSlider.addEventListener('change', () => {
                clearTimeout(this._slicerDebounce);
                _onSliderMove(slicerSlider.value);
            });
        }
        // Schema strip — collapsed by default; the "Schema" toggle
        // lives in the category-pill row so it reads as a peer of the
        // category filters. Toggling on shows the schema row below.
        // The is-active class on the toggle gives it the same accent
        // treatment as an active category pill.
        if (this._browserSchemaCollapsed == null) {
            this._browserSchemaCollapsed = true;
        }
        const stripEl   = host.querySelector('[data-role="schema-strip"]');
        const toggleBtn = host.querySelector('[data-role="schema-toggle"]');
        const syncToggle = () => {
            stripEl?.classList.toggle('is-collapsed',
                this._browserSchemaCollapsed);
            toggleBtn?.classList.toggle('is-active',
                !this._browserSchemaCollapsed);
        };
        syncToggle();
        toggleBtn?.addEventListener('click', () => {
            this._browserSchemaCollapsed = !this._browserSchemaCollapsed;
            syncToggle();
        });
        // "Query" toggle — peer of Schema. On → the rows area becomes a
        // query console (SQL for relational/tables, Python expression for
        // time-series + documents); off → back to the browsed rows.
        const queryBtn = host.querySelector('[data-role="query-toggle"]');
        const syncQuery = () => {
            queryBtn?.classList.toggle('is-active', !!this._browserQueryMode);
            // Schema is irrelevant while querying — disable + collapse it.
            if (toggleBtn) toggleBtn.disabled = !!this._browserQueryMode;
            if (this._browserQueryMode) {
                this._browserSchemaCollapsed = true;
                syncToggle();
            }
        };
        syncQuery();
        queryBtn?.addEventListener('click', () => {
            this._browserQueryMode = !this._browserQueryMode;
            syncQuery();
            if (this._browserQueryMode) {
                this._renderBrowserQuery();
                this._renderRegistriesShell();   // picker → query guidance
            } else {
                this._disposeBrowserQueryEditor();
                this._renderRegistriesShell();   // guidance → source list
                this._refreshSelectedRegistry(); // restore the rows
            }
        });
        // [+ New schema] in the picker chrome — opens a creation form
        // that writes a new registries/<id>.registry.json. Only
        // TypedTable registries have writable schemas; other kinds
        // are owned by their canonical editors.
        host.querySelector('[data-role="browser-new-schema"]')
            ?.addEventListener('click', () => this._openNewSchemaForm());
        // Edit-schema button in the schema strip — appears only when
        // the active source is schema_writable (i.e. registry:*).
        host.querySelector('[data-role="schema-edit"]')
            ?.addEventListener('click', () => this._openEditSchemaForm());
        // New-entity button — opens a kind-picker menu and routes to
        // the matching top-nav landing where the user creates inline.
        host.querySelector('[data-role="browser-new-entity"]')
            ?.addEventListener('click', (ev) => this._openNewEntityMenu(ev));
        this._refreshRegistries();
    }

    /** Tick when only the scrubber changed (no fresh server data needed).
     *  Re-renders rows so the per-tick filter applies, and updates the
     *  scrubber chrome's "all-ticks" mode in case another surface (SFC)
     *  swapped the global viewing tick under us. */
    _onViewingTickChanged() {
        this._updateRegistryScrubber();
        this._renderRegistryRows();
    }

    /** A registry is "time series" iff the bridge manifest says so.
     *  Two redundant signals on the manifest entry — either one
     *  qualifies — plus a defensive fallback to sniff the columns
     *  payload in case a future caller passes a rows response in
     *  instead of a manifest entry. The convention upstream: a TS
     *  registry has a `tick` column (`metrics`, `brain_history`,
     *  `events`); snapshot-shaped tables (`loans`, …) do not. */
    _isTimeSeriesRegistry(spec) {
        if (!spec) return false;
        if (spec.time_series === true) return true;
        if (spec.category === 'time_series') return true;
        const cols = Array.isArray(spec.columns) ? spec.columns : [];
        return cols.some((c) => c && c.name === 'tick');
    }

    _activeRegistrySpec() {
        // Manifest-driven — returns the active source's entry from
        // browser_sources_list. The legacy name is kept; the entry
        // shape carries {id, category, family, label, count, …}.
        const id = this._activeRegistryId;
        const sources = this._registriesState?.sources
            || this._registriesState?.registries || [];
        return sources.find((s) => s.id === id) || null;
    }

    /** Rebuild the registry filter's scope <select> from the active
     *  registry's column list. Each registry has a different schema —
     *  `metrics` has source/product/property, `events` has kind/topic,
     *  `loans` has lender_id/borrower_id, etc. — so the dropdown
     *  options must be data-driven, not hard-coded. Resets the
     *  current scope back to "all" when it isn't valid for the new
     *  schema (so switching registries can't leave a stale filter). */
    _updateRegistryFilterScopeOptions(cols) {
        const sel = this._host?.querySelector(
            '[data-role="reg-filter-scope"]');
        if (!sel) return;
        const names = ['all',
            ...(Array.isArray(cols) ? cols.map((c) => c?.name) : [])
                .filter(Boolean),
        ];
        // Diff first to avoid stomping the dropdown while the user
        // has it open (the <select> would close on innerHTML reset).
        const fingerprint = names.join('|');
        if (sel.dataset.scopeFp === fingerprint) {
            sel.value = this._registryFilterScope || 'all';
            sel.classList.toggle('is-scoped',
                (this._registryFilterScope || 'all') !== 'all');
            return;
        }
        sel.dataset.scopeFp = fingerprint;
        if (!names.includes(this._registryFilterScope)) {
            this._registryFilterScope = 'all';
        }
        sel.innerHTML = names.map((n) => {
            const label = n === 'all' ? 'All' : n;
            const sel_  = n === (this._registryFilterScope || 'all')
                ? ' selected' : '';
            return `<option value="${esc(n)}"${sel_}>${esc(label)}</option>`;
        }).join('');
        sel.classList.toggle('is-scoped',
            (this._registryFilterScope || 'all') !== 'all');
    }

    /** Show / hide + sync the tick toolbars based on the active
     *  registry. Two distinct toolbars share the same `tick` viewing
     *  state but have different filter semantics:
     *
     *    • time_series → tape deck (input + ±1 + Latest lock)
     *                    filter: tick == viewingTick (one specific tick)
     *    • relational  → slider (with "As of" label, All button)
     *                    filter: tick <= viewingTick (cumulative)
     *
     *  Other categories (graph/document) hide both. A relational
     *  source without a `tick` column hides the slider too — t<= is
     *  meaningless without a time axis. */
    _updateRegistryScrubber() {
        const tape   = this._host?.querySelector('[data-role="reg-scrubber"]');
        const slicer = this._host?.querySelector('[data-role="reg-slicer"]');
        if (!tape && !slicer) return;

        const cat = this._browserCategory || 'relational';

        // Source schema (from latest browser_rows payload). A source
        // is "tick-aware" iff it declares a `tick` column. Showing
        // the slider on a source that has no tick column would render
        // it at max=0 (a useless thumb stuck at the left), which the
        // user has explicitly rejected as "slider on all tables".
        const cols = Array.isArray(this._registryRowsState?.columns)
            ? this._registryRowsState.columns
            : [];
        const sourceHasTick = cols.some((c) => c && c.name === 'tick');

        // maxTick from loaded rows' tick values. For tick-less sources
        // it stays 0 (Number(undefined) = NaN, skipped).
        const rows = this._registryRowsState?.entries || [];
        let maxTick = 0;
        for (const r of rows) {
            const t = Number(r?.tick);
            if (Number.isFinite(t) && t > maxTick) maxTick = t;
        }
        this._maxTickKnown = maxTick;

        // Visibility:
        //   time_series → tape deck only (per spec)
        //   relational/document + source has tick → slider only
        //   relational/document + NO tick → nothing
        //   graph → nothing
        const showTape   = (cat === 'time_series');
        const showSlicer = (cat === 'relational' || cat === 'document')
            && sourceHasTick;
        if (tape)   tape.hidden   = !showTape;
        if (slicer) slicer.hidden = !showSlicer;

        if (showTape) this._syncTapeDeck(tape, maxTick);
        if (showSlicer) this._syncSlicer(slicer, maxTick);
    }

    /** Time-series tape deck: input + ±1 + Latest lock. Single-pass:
     *  resolve the effective tick (default to max when null / out of
     *  range / streaming), always write input.value in this call. */
    _syncTapeDeck(tape, maxTick) {
        const input    = tape.querySelector('[data-role="reg-tick-input"]');
        const backEl   = tape.querySelector('[data-role="reg-tick-back"]');
        const fwdEl    = tape.querySelector('[data-role="reg-tick-fwd"]');
        const latestEl = tape.querySelector('[data-role="reg-tick-latest"]');
        if (input) input.max = String(maxTick);

        // Brush ↔ tape-deck mutual exclusion. When a window is set
        // the tape deck makes no sense (you're viewing a range, not
        // a single tick) so we disable the whole row visually and
        // skip the viewing-tick sync below.
        const brushed = !!this._registryWindow;
        tape.classList.toggle('is-disabled', brushed);
        tape.title = brushed ? 'Clear the brush window to use the tape deck' : '';

        // Resolve the effective viewing-tick:
        //  • null / out-of-range → max (default on fresh source)
        //  • locked (Latest)     → always max (streaming follow)
        //  • otherwise           → whatever's pinned
        // Sync to shared state so the row filter agrees, but the DOM
        // update happens unconditionally below — no recursion needed.
        const locked = !!this._regTickLatest;
        let viewing = getViewingTick();
        if (viewing == null || viewing > maxTick || viewing < 0 || locked) {
            viewing = maxTick;
            // Skip the sync while brushed — viewing-tick stays null
            // so the brush owns the row filter without competition.
            if (!brushed) setViewingTick(maxTick);
        }

        // Lock-state visuals + interactivity.
        const disabled = brushed || locked;
        if (input)  { input.disabled  = disabled; }
        if (backEl) { backEl.disabled = disabled; }
        if (fwdEl)  { fwdEl.disabled  = disabled; }
        if (latestEl) {
            latestEl.disabled = brushed;
            latestEl.classList.toggle('is-active', locked && !brushed);
            latestEl.setAttribute('aria-pressed', locked ? 'true' : 'false');
        }
        if (input) input.value = String(viewing);
    }

    /** Relational/document slicer: classic slider with t<= semantics.
     *  Slider position IS the latest indicator — thumb at the very
     *  right means "show everything up to max." Single-pass: pick
     *  the effective tick (default to max when null/out-of-range),
     *  always write slider.value and valEl in this call. No
     *  recursion through setViewingTick — we sync global state
     *  for the row filter, but the DOM update happens unconditionally
     *  here so the thumb lands on the first call without waiting
     *  for a listener round-trip. */
    _syncSlicer(slicer, maxTick) {
        const slider = slicer.querySelector('[data-role="reg-slicer-slider"]');
        const valEl  = slicer.querySelector('[data-role="reg-slicer-value"]');
        if (!slider) return;
        // max BEFORE value — browser clamps value to current max.
        slider.max = String(maxTick);
        let viewing = getViewingTick();
        const autoFollow = !!this._sliderAutoFollow;
        // Auto-follow: thumb tracks max on every refresh (streaming).
        // Out-of-range / null also force to max so a stale shared
        // viewing-tick from elsewhere can't peg the slider mid-range.
        // User drag turns off auto-follow (handled in input handler);
        // dragging back to max re-arms it.
        if (autoFollow || viewing == null || viewing > maxTick || viewing < 0) {
            viewing = maxTick;
            setViewingTick(maxTick);
        }
        slider.value = String(viewing);
        if (valEl) valEl.textContent = String(viewing);
    }

    _renderRegistriesShell() {
        const state = this._registriesState || { active: false, sources: [] };
        const list = this._host?.querySelector('[data-role="reg-picker"]');
        if (!list) return;
        const all = Array.isArray(state.sources)
            ? state.sources
            : (state.registries || []);   // legacy fallback
        // Origin model: show ALL sources grouped into Project / Runtime /
        // Custom sections. No category (relational/graph/time-series/
        // document) tab filter — a source's category only picks its row
        // icon now.
        const inCat = all;

        // Picker-rail action visibility:
        //   New-schema → creates a new TABLE of arbitrary shape. The
        //   schema form lets the user pick column types including
        //   `tick`; presence of a `tick` column is what makes a table
        //   "time series". Visible on RELATIONAL + TIME-SERIES so the
        //   user can create either shape without first navigating to
        //   the category that already hosts that shape.
        //   New-entity → routes to a kind-specific landing for
        //   creating typed instances (agents, KPIs, etc.). Relational
        //   only — those landings own their own creation flow.
        //   Document creation is not yet supported (no `document_create`
        //   bridge endpoint). Hidden on that category for now.
        const newEntityBtn = this._host?.querySelector(
            '[data-role="browser-new-entity"]');
        const newSchemaBtn = this._host?.querySelector(
            '[data-role="browser-new-schema"]');
        // Creation actions are category-independent now — both always
        // available (New-entity → typed landing; New-schema → new table).
        if (newEntityBtn) newEntityBtn.hidden = false;
        if (newSchemaBtn) newSchemaBtn.hidden = false;
        // (Category pills removed from the template — origin model only.)

        // Query mode: the source picker is irrelevant (you reference tables
        // by name in SQL/Python). Show how-to-query guidance instead.
        if (this._browserQueryMode) {
            if (newEntityBtn) newEntityBtn.hidden = true;
            if (newSchemaBtn) newSchemaBtn.hidden = true;
            this._renderQueryGuide(list, inCat);
            return;
        }

        if (inCat.length === 0) {
            list.innerHTML = `<li class="ea-bp-flows-picker__empty">${
                state.active ? 'No sources.' : 'Open a project to see sources.'
            }</li>`;
            this._setBrowserTitle('—');
            return;
        }
        if (!this._activeRegistryId
            || !inCat.some((s) => s.id === this._activeRegistryId)) {
            this._activeRegistryId = inCat[0].id;
        }

        // Group by ORIGIN section, fixed order: Project → Runtime → Custom.
        const byFamily = new Map();
        for (const s of inCat) {
            const fam = s.family || 'project';
            if (!byFamily.has(fam)) byFamily.set(fam, []);
            byFamily.get(fam).push(s);
        }
        const SECTION_ORDER = ['project', 'runtime', 'custom'];
        const familyLabel = (f) => ({
            project: 'Project',
            runtime: 'Runtime',
            custom:  'Custom',
        }[f] || f);
        const orderedFamilies = [
            ...SECTION_ORDER.filter((f) => byFamily.has(f)),
            ...[...byFamily.keys()].filter((f) => !SECTION_ORDER.includes(f)),
        ];

        const parts = [];
        for (const fam of orderedFamilies) {
            const items = byFamily.get(fam);
            parts.push(`
                <li class="ea-bp-browser__group">${esc(familyLabel(fam))}</li>
            `);
            for (const s of items) {
                const active = s.id === this._activeRegistryId;
                const label = s.label || s.id;
                // Time-series → timeline; everything else (incl. the
                // document-backed tables agents/scenarios/kpis) is a table.
                const icon = s.time_series ? 'timeline' : 'table_view';
                const dim = (s.time_series && !s.has_world)
                    ? ' ea-bp-flows-picker__item--dim' : '';
                parts.push(`
                    <li class="ea-bp-flows-picker__item${active ? ' ea-bp-flows-picker__item--active' : ''}${dim}"
                        data-source="${esc(s.id)}" title="${esc(label)}">
                        <span class="material-symbols-outlined ea-bp-flows-picker__icon">${icon}</span>
                        <span class="ea-bp-flows-picker__label">${esc(label)}</span>
                        <span class="ea-bp-flows-picker__chip">${Number(s.count) || 0}</span>
                    </li>
                `);
            }
        }
        list.innerHTML = parts.join('');
        list.querySelectorAll('[data-source]').forEach((li) => {
            li.addEventListener('click', () => {
                const id = li.dataset.source;
                if (id === this._activeRegistryId) return;
                this._activeRegistryId = id;
                // Stale filters from a prior source typically match
                // nothing on the new schema; reset so the user sees
                // the full rowset on click.
                this._resetBrowserFilter();
                this._renderRegistriesShell();
                this._refreshSelectedRegistry();
                this._saveBpState();
            });
        });

        const active = this._activeRegistrySpec();
        this._setBrowserTitle(active ? (active.label || active.id) : '—');
    }

    _setBrowserTitle(s) {
        const el = this._host?.querySelector('[data-role="browser-title"]');
        if (!el) return;
        const text = String(s || '');
        el.textContent = text;
        // Full label in the tooltip — CSS truncates the visible text
        // at 200px with an ellipsis, so the tooltip is the only way
        // to read the full source name when it overflows.
        el.title = text;
    }

    /** Reset the scope dropdown + filter input back to "all" / "". Used
     *  on every source switch so a filter that was useful on the
     *  previous source doesn't silently mask the new one's data.
     *  D2 — also resets the column sort + per-column filters, since
     *  column names differ per source. */
    _resetBrowserFilter() {
        this._registryFilter      = '';
        this._registryFilterScope = 'all';
        const fEl = this._host?.querySelector('[data-role="reg-filter"]');
        const sEl = this._host?.querySelector('[data-role="reg-filter-scope"]');
        if (fEl) fEl.value = '';
        if (sEl) {
            sEl.value = 'all';
            sEl.classList.remove('is-scoped');
        }
    }

    /** Render the schema strip — one chip per column with its type.
     *  Columns whose type starts with `ref:` get a link glyph so the
     *  user can see at a glance which columns drill to another source
     *  (B4 will activate the actual click-through). PK column gets a
     *  small `pk` marker. */
    _renderSchemaStrip(cols, primary_key) {
        const body = this._host?.querySelector('[data-role="schema-body"]');
        if (!body) return;
        // Toggle the Edit button — only shown when the click would
        // actually do something. Today that's `registry:*` (user
        // TypedTable schemas, served by browser_schema_write). The
        // `table:*` mirrors of authoritative bridge state are read-only
        // from the panel — their schema lives in `mirror.py` and edits
        // belong to the canonical editor for the underlying entity.
        const editBtn = this._host?.querySelector('[data-role="schema-edit"]');
        if (editBtn) {
            const sid = this._activeRegistryId || '';
            editBtn.hidden = !sid.startsWith('registry:');
        }
        // W3 — schema is editable in-place for writable sources
        // (registry:* whole-schema via browser_schema_write; writable
        // table:* granular via table_alter). Each column gets hover
        // edit/delete affordances + an "add column" button.
        const writable = this._schemaWritable();
        if (!Array.isArray(cols) || cols.length === 0) {
            body.innerHTML = '<span class="ea-bp-browser__schema-empty">—</span>'
                + (writable ? this._schemaAddColMarkup() : '');
            if (writable) this._wireSchemaEditing(body);
            return;
        }
        const pk = primary_key || null;
        body.innerHTML = cols.map((c) => {
            const name = c?.name || '';
            const type = c?.type || 'str';
            const isPk = pk && name === pk;
            const isRef = String(type).startsWith('ref:');
            const isJson = type === 'json';
            const isNum = type === 'int' || type === 'float' || type === 'tick';
            // D2 — declared foreign key from D1's ColumnSpec.references.
            // Encoded on the wire as `[target_table, target_col]`. When
            // present, the chip surfaces it as `→ target.col` and gets
            // the `is-ref` styling so it visually matches the
            // type-prefix `ref:*` columns.
            const refs = Array.isArray(c?.references) && c.references.length === 2
                ? c.references
                : null;
            // D2 — `nullable: false` is rare in the entity mirrors but
            // worth surfacing because it tells the user the column is
            // load-bearing. Default-true matches the dataclass default
            // so we only flag the negative case.
            const isNotNull = c && c.nullable === false;
            let cls = 'ea-bp-browser__chip';
            if (isPk)            cls += ' is-pk';
            if (isRef || refs)   cls += ' is-ref';
            if (isJson)          cls += ' is-json';
            if (isNum)           cls += ' is-num';
            if (isNotNull)       cls += ' is-required';
            const arrow = (isRef || refs)
                ? '<span class="material-symbols-outlined ea-bp-browser__chip-arrow">arrow_right_alt</span>'
                : '';
            const fkHtml = refs
                ? `<span class="ea-bp-browser__chip-fk"
                         title="references ${esc(refs[0])}.${esc(refs[1])}"
                         >${esc(refs[0])}.${esc(refs[1])}</span>`
                : '';
            const titleParts = [type];
            if (refs)       titleParts.push(`→ ${refs[0]}.${refs[1]}`);
            if (isNotNull)  titleParts.push('NOT NULL');
            if (isPk)       titleParts.push('PRIMARY KEY');
            const actions = writable ? `
                    <span class="ea-bp-browser__chip-actions">
                        <button type="button" class="ea-bp-browser__chip-btn"
                                data-col-edit="${esc(name)}" title="Edit column">
                            <span class="material-symbols-outlined">edit</span>
                        </button>
                        ${isPk ? '' : `<button type="button" class="ea-bp-browser__chip-btn"
                                data-col-del="${esc(name)}" title="Delete column">
                            <span class="material-symbols-outlined">delete</span>
                        </button>`}
                    </span>` : '';
            return `
                <span class="${cls}" data-col="${esc(name)}" title="${esc(titleParts.join(' · '))}">
                    <span class="ea-bp-browser__chip-name">${esc(name)}</span>
                    ${arrow}
                    <span class="ea-bp-browser__chip-type">${esc(type)}</span>
                    ${fkHtml}
                    ${isPk ? '<span class="ea-bp-browser__chip-pk">pk</span>' : ''}
                    ${isNotNull ? '<span class="ea-bp-browser__chip-req">!</span>' : ''}
                    ${actions}
                </span>
            `;
        }).join('') + (writable ? this._schemaAddColMarkup() : '');
        if (writable) this._wireSchemaEditing(body);
    }

    /** True when the active source's schema can be edited from the panel:
     *  registry:* (whole-schema via browser_schema_write) or a writable
     *  table:* (granular via table_alter). */
    _schemaWritable() {
        const sid = this._activeRegistryId || '';
        if (sid.startsWith('registry:')) return true;
        if (sid.startsWith('table:')) return !!this._activeRegistrySpec()?.schema_writable;
        return false;
    }

    _schemaAddColMarkup() {
        return `<button type="button" class="ea-bp-browser__chip ea-bp-browser__chip-add"
                        data-role="schema-add-col" title="Add a column">
                    <span class="material-symbols-outlined">add</span> column
                </button>`;
    }

    /** Delegate clicks on the per-column edit/delete buttons + the
     *  add-column button. Re-attached on each schema render (innerHTML
     *  is rebuilt), so a fresh listener per render is correct. */
    _wireSchemaEditing(body) {
        body.querySelector('[data-role="schema-add-col"]')
            ?.addEventListener('click', () => this._addSchemaColumn());
        body.querySelectorAll('[data-col-edit]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._editSchemaColumn(el.getAttribute('data-col-edit'));
            });
        });
        body.querySelectorAll('[data-col-del]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._deleteSchemaColumn(el.getAttribute('data-col-del'));
            });
        });
        // W4 — drag to reorder columns, reusing the shared tab-bar drag
        // module. Drops commit a reorder_columns schema op. Don't start a
        // drag from the hover edit/delete buttons.
        try { this._schemaDrag?.destroy(); } catch { /* ignore */ }
        this._schemaDrag = new DragReorder({
            container: body,
            itemSelector: '.ea-bp-browser__chip[data-col]',
            keyAttr: 'col',
            axis: 'x',
            indicatorClass: 'ea-col-drop-indicator',
            draggableGuard: (e) => !e.target.closest('.ea-bp-browser__chip-btn'),
            onReorder: (order) => this._runSchemaOps([['reorder_columns', { order }]]),
        });
        this._schemaDrag.attach();
    }

    async _addSchemaColumn() {
        const cols = this._resolveSourceColumns();
        const result = await openColumnForm({
            mode: 'add', existingNames: cols.map((c) => c.name),
        });
        if (!result) return;
        await this._runSchemaOps([['add_column', { column: result }]]);
    }

    async _editSchemaColumn(name) {
        const cols = this._resolveSourceColumns();
        const col = cols.find((c) => c.name === name);
        if (!col) return;
        const pk = this._resolveSourcePrimaryKey();
        const result = await openColumnForm({
            mode: 'edit', column: col,
            existingNames: cols.map((c) => c.name), isPk: name === pk,
        });
        if (!result) return;
        const ops = [];
        if (result.name !== name) {
            ops.push(['rename_column', { old: name, new: result.name }]);
        }
        if (result.type !== (col.type || 'str')) {
            ops.push(['retype_column', { name: result.name, type: result.type }]);
        }
        if (!ops.length) return;            // nullable-only change is a no-op for now
        await this._runSchemaOps(ops);
    }

    async _deleteSchemaColumn(name) {
        const ok = await showDeleteConfirmDialog({
            itemName: name, itemType: 'column',
            additionalMessage: `From ${this._activeRegistryId}.`,
        });
        if (!ok) return;
        await this._runSchemaOps([['drop_column', { name }]]);
    }

    /** Apply a sequence of schema ops to the active source, then refresh.
     *  table:* → granular table_alter (preserves data); registry:* →
     *  fold the ops into the full column list and browser_schema_write. */
    async _runSchemaOps(ops) {
        const api = window.pywebview?.api;
        const sid = this._activeRegistryId || '';
        try {
            if (sid.startsWith('table:')) {
                const tid = sid.slice('table:'.length);
                for (const [op, args] of ops) {
                    const res = await api?.table_alter?.(tid, op, args);
                    if (!res || res.ok === false) {
                        toastError?.('Schema', res?.error || `${op} failed`);
                        return;
                    }
                }
            } else if (sid.startsWith('registry:')) {
                const rid = sid.slice('registry:'.length);
                const base = await api?.world_registry_schema?.(rid);
                if (!base || !base.id) {
                    toastError?.('Schema', `Couldn't load ${rid}`);
                    return;
                }
                let cols = (base.columns || []).map((c) => ({ ...c }));
                for (const [op, args] of ops) cols = this._applyOpToColumns(cols, op, args);
                const res = await api?.browser_schema_write?.(sid, { ...base, id: rid, columns: cols });
                if (!res || res.ok === false) {
                    toastError?.('Schema', res?.error || 'save failed');
                    return;
                }
            } else {
                toastError?.('Schema', 'This source is read-only.');
                return;
            }
        } catch (err) {
            toastError?.('Schema', String(err?.message || err));
            return;
        }
        toastInfo?.('Schema', 'Updated');
        await this._refreshRegistries();
    }

    /** Fold one schema op into a column-spec list (registry whole-schema path). */
    _applyOpToColumns(cols, op, args) {
        if (op === 'add_column') {
            const c = args.column || args;
            return [...cols, { name: c.name, type: c.type || 'str', nullable: c.nullable !== false }];
        }
        if (op === 'drop_column') return cols.filter((c) => c.name !== args.name);
        if (op === 'rename_column') {
            return cols.map((c) => (c.name === args.old ? { ...c, name: args.new } : c));
        }
        if (op === 'retype_column') {
            return cols.map((c) => (c.name === args.name ? { ...c, type: args.type } : c));
        }
        if (op === 'reorder_columns') {
            const m = new Map(cols.map((c) => [c.name, c]));
            return (args.order || []).map((n) => m.get(n)).filter(Boolean);
        }
        return cols;
    }

    /** Spinner overlay on the Registries rows pane while a source's rows
     *  are in flight. Unlike `DataTable.setLoading` (which only works once a
     *  table is already mounted), this also covers the FIRST load and every
     *  source switch — when the pane still shows a placeholder and no table
     *  exists yet — which is the slow gap the user saw ("takes a while to
     *  even load the tables"). Reuses the shared `.data-table__loading` /
     *  `.data-table__spinner` markup so it matches every other spinner. */
    _setRegistryLoading(on) {
        const pane = this._host?.querySelector('[data-role="reg-rows"]');
        if (!pane) return;
        let overlay = pane.querySelector(':scope > .data-table__loading');
        if (on) {
            if (!overlay) {
                if (!pane.style.position) pane.style.position = 'relative';
                overlay = document.createElement('div');
                overlay.className = 'data-table__loading';
                overlay.innerHTML = '<div class="data-table__spinner"></div>';
                pane.appendChild(overlay);
            }
        } else if (overlay) {
            overlay.remove();
        }
    }

    async _refreshSelectedRegistry() {
        // Spinner overlay on the rows pane while the fetch is in flight.
        // Cleared at the top of `_renderRegistryRows` (the choke point every
        // render path funnels through), which runs synchronously once the
        // rows arrive — so the spinner stays up for the whole await, then
        // hands straight off to the painted table with no flash.
        this._setRegistryLoading(true);
        const id = this._activeRegistryId;
        // When the active source actually changes, drop any inherited
        // viewing-tick. Otherwise an in-range value from another panel
        // (SFC scrubber, or this panel's prior source) would survive
        // the switch and land the slider/picker mid-range — the user
        // wants both controls at MAX on a fresh source. Once null,
        // _syncTapeDeck and _syncSlicer pin viewing-tick to maxTick
        // and the controls render at the right end.
        if (id !== this._lastRegistryId) {
            this._lastRegistryId = id;
            // Fresh source → drop any inherited viewing-tick AND
            // re-arm slider auto-follow so it tracks the new source's
            // max on every refresh until the user drags away from it.
            // Also clear the brush window (M3) — a tick range from the
            // previous source has no meaning here.
            setViewingTick(null);
            this._sliderAutoFollow = true;
            this._registryWindow = null;
            // Drop cached histogram counts + per-source max-tick —
            // they belong to the old source. `_loadTickCounts` will
            // repopulate; `_autoExtendBrush` starts fresh.
            if (this._tickCounts)    delete this._tickCounts[id];
            if (this._sourceMaxTick) delete this._sourceMaxTick[id];
            // Aggregation dimension state is per-source (column
            // names differ). Clear it on switch so we don't try to
            // filter the new source by a column it doesn't have.
            // Reset the page cursor too — different source, fresh
            // pagination from row 0.
            this._registryValueCol  = null;
            this._registryDimFilters = {};
            this._registryGroupDims  = new Set();
            this._registryOffset     = 0;
            this._registrySort       = null;
        }
        if (!id) {
            this._registryRowsState = { entries: [], total: 0, start: 0, columns: [] };
            this._renderRegistryRows();
            return;
        }

        try {
            // Counts first: histogram bars + brush auto-extend.
            await this._loadTickCounts(id);
            this._autoExtendBrush(id);

            // Build the canonical query from state. `browser_query`
            // handles `registry:*` + `table:*`; other source types
            // (documents/relational adapters/graph) don't support
            // structured query yet — fall back to `browser_rows`
            // for those so the bottom panel still renders them.
            const q = this._buildRegistryQuery();
            const api = window.pywebview?.api;
            const supportsQuery = id.startsWith('registry:')
                || id.startsWith('table:');
            let res;
            if (supportsQuery) {
                res = await api?.browser_query?.(id, q);
            }
            if (supportsQuery && res?.ok) {
                this._registryRowsState = this._envelopeFromQuery(res, q);
            } else {
                // Fallback path. Honours the brush tick-window via
                // tick_min/tick_max but not other filters / group —
                // those are query-only features. Aggregation also
                // unavailable here, so a non-rows fn on a fallback
                // source falls back to raw rows (UI still shows the
                // toolbar but only the brush narrows the data).
                const winQ = this._registryWindow;
                const offset = Number.isFinite(this._registryOffset)
                    ? this._registryOffset : 0;
                const fb = await api?.browser_rows?.(
                    id, offset, 500,
                    winQ?.start ?? null,
                    winQ?.end   ?? null,
                );
                this._registryRowsState = fb || {
                    entries: [], total: 0, start: 0, columns: [],
                    error: res?.error || 'fetch failed',
                };
            }
            // Self-correcting offset clamp: if a filter narrowed
            // the result set and the page we asked for no longer
            // exists, reset to page 0 and refetch once.
            const t = Number(this._registryRowsState.total) || 0;
            const off = Number(q.offset) || 0;
            if (off > 0 && off >= t) {
                this._registryOffset = 0;
                this._refreshSelectedRegistry();
                return;
            }
        } catch { /* ignore */ }
        this._renderRegistryRows();
    }

    /** Reset the page cursor and trigger a refresh. Use this from
     *  any handler that changes the result-set shape (brush, filter,
     *  group, fn, value column) — otherwise we'd refetch starting
     *  from the previous page offset, which may be past the new
     *  total and yield an empty page. */
    _resetPageAndRefresh() {
        this._registryOffset = 0;
        this._refreshSelectedRegistry();
    }

    /** Streaming auto-extend: if the brush window's right edge was
     *  pinned to the previously-known source max, follow the new
     *  max as data extends right. Otherwise the brush stays put
     *  (and visually shrinks as the strip's x-axis grows past it).
     *  Compares against `_sourceMaxTick[id]` — the LAST known max
     *  from the previous refresh, before the fresh counts came in. */
    _autoExtendBrush(id) {
        const counts = this._tickCounts?.[id];
        if (!counts || counts.size === 0) return;
        const ticks = [...counts.keys()];
        const newMax = Math.max.apply(null, ticks);
        const prevMax = this._sourceMaxTick?.[id];
        this._sourceMaxTick = this._sourceMaxTick || {};
        this._sourceMaxTick[id] = newMax;
        if (prevMax == null) return;
        if (newMax <= prevMax) return;
        const win = this._registryWindow;
        if (!win) return;
        if (win.end !== prevMax) return;  // pinned away from latest
        this._registryWindow = { start: win.start, end: newMax };
    }

    /** Resolve which column holds the magnitude we aggregate over.
     *  Convention: a column literally named `value`; if absent, the
     *  first non-id non-tick column. User can override via the
     *  value-column dropdown (state on `_registryValueCol`). */
    _resolveValueColumn(specCols) {
        const cols = specCols || [];
        const userPick = this._registryValueCol;
        if (userPick && cols.some((c) => c && c.name === userPick)) {
            return userPick;
        }
        if (cols.some((c) => c && c.name === 'value')) return 'value';
        const idLike = (c) => !c || c.name === 'tick' || c.name === '_id'
            || c.name === 'id' || c.type === 'agent_id';
        const first = cols.find((c) => !idLike(c));
        return first ? first.name : null;
    }

    /** Every column the user can filter / group by. That's everything
     *  in the schema except the value column (which is aggregated
     *  over) and `_id` (synthetic — never present in spec.columns
     *  anyway). `tick` is included because the bridge will reject
     *  it from group_by if duplicate (we always group by tick). */
    _dimensionColumns(specCols, valueCol) {
        return (specCols || []).filter((c) => c
            && c.name !== valueCol
            && c.name !== '_id'
            && c.name !== 'tick');
    }

    /** Coerce a string from a text input into the value type the
     *  backend expects. Numeric columns get `Number(...)`, strings
     *  pass through. Empty input → undefined (no filter). */
    _coerceFilterValue(raw, type) {
        const s = String(raw ?? '').trim();
        if (s === '') return undefined;
        if (type === 'int')   return Math.trunc(Number(s));
        if (type === 'float' || type === 'tick') return Number(s);
        return s;
    }

    /** Build the WHERE list contributed by per-dimension filter
     *  inputs. Skips empty / whitespace-only inputs and unknown
     *  columns. Numeric coercion via `_coerceFilterValue`. */
    _buildDimWhere(specCols, valueCol) {
        const filters = this._registryDimFilters || {};
        const dims = this._dimensionColumns(specCols, valueCol);
        const out = [];
        for (const c of dims) {
            const raw = filters[c.name];
            const v = this._coerceFilterValue(raw, c.type);
            if (v === undefined) continue;
            if (typeof v === 'number' && !Number.isFinite(v)) continue;
            out.push({col: c.name, op: '=', value: v});
        }
        return out;
    }

    /** Build the `browser_query` payload from the registry's current
     *  state. Single source of truth for what the table is asking
     *  the bridge for — every interactive control mutates state and
     *  re-runs this builder. Handles:
     *    - rows mode: SELECT every spec column (filtered + paged)
     *    - aggregation mode: SELECT group keys + agg(value), GROUP BY
     *    - brush window → `tick BETWEEN [s, e]`
     *    - dim filters → equality predicates
     *    - sort (column + direction) — server-side, works across pages
     *    - pagination (offset + limit) — server-side
     */
    _buildRegistryQuery(pageSize = 500) {
        // Prefer the source's full schema (from a prior fetch
        // response) over the manifest entry — the manifest only
        // carries id/label/count, not columns. Falls back to spec if
        // a prior response cached columns there.
        const stateCols = Array.isArray(this._registryRowsState?.columns)
            ? this._registryRowsState.columns : [];
        const specCols  = stateCols.length > 0
            ? stateCols
            : (this._activeRegistrySpec()?.columns || []);
        const valueCol = this._resolveValueColumn(specCols);
        const fn       = this._registryAggFn || 'rows';
        const isAgg    = fn !== 'rows';
        const sendAgg  = fn === 'mean' ? 'avg' : fn;

        // ── SELECT / GROUP BY ─────────────────────────────────────
        let select, groupBy;
        if (isAgg) {
            const groupDims = this._registryGroupDims || new Set();
            const extraDims = this._dimensionColumns(specCols, valueCol)
                .filter((c) => groupDims.has(c.name));
            groupBy = ['tick', ...extraDims.map((c) => c.name)];
            select  = groupBy.map((n) => ({col: n}));
            if (fn === 'count' || !valueCol) {
                select.push({agg: 'count', as: 'n'});
            } else {
                select.push({col: valueCol, agg: sendAgg, as: fn});
            }
        } else {
            // Rows mode: omit `select` entirely. The bridge expands
            // an empty select to "all columns from the source spec",
            // so we don't need to know the schema client-side. Sort
            // / filter / pagination still work; the bridge fills in
            // the column list from its own source registration.
            select = [];
        }

        // ── WHERE ─────────────────────────────────────────────────
        const where = [];
        const win = this._registryWindow;
        if (win && Number.isFinite(win.start) && Number.isFinite(win.end)) {
            where.push({col: 'tick', op: 'between',
                        value: [win.start, win.end]});
        }
        for (const w of this._buildDimWhere(specCols, valueCol)) {
            where.push(w);
        }

        // ── ORDER BY ──────────────────────────────────────────────
        // User-picked sort wins; otherwise default to natural order
        // (group keys for agg, `tick` for rows-of-a-time-series).
        let order_by;
        const sort = this._registrySort;
        if (sort?.column) {
            order_by = [{col: sort.column,
                         dir: sort.ascending ? 'asc' : 'desc'}];
        } else if (isAgg) {
            order_by = groupBy.map((n) => ({col: n, dir: 'asc'}));
        } else if (specCols.some((c) => c && c.name === 'tick')) {
            order_by = [{col: 'tick', dir: 'asc'}];
        }

        // ── LIMIT / OFFSET ────────────────────────────────────────
        const offset = Number.isFinite(this._registryOffset)
            ? this._registryOffset : 0;

        const q = { select, where, limit: pageSize, offset };
        if (groupBy)  q.group_by = groupBy;
        if (order_by) q.order_by = order_by;
        return q;
    }

    /** Which source ids accept the generic row-CRUD bridge endpoints.
     *  `registry:*` → world_registry_insert/update/delete;
     *  `table:*`    → table_insert/update/delete. Other sources
     *  (documents, relational adapters, dependency_graph) need their
     *  own canonical editors. */
    _sourceSupportsRowCrud(sid) {
        const s = String(sid || '');
        return s.startsWith('registry:') || s.startsWith('table:');
    }

    /** Pick the right insert/update/delete endpoint pair for a
     *  source. Returns null when the source isn't writable from
     *  the generic editor. */
    _crudForSource(sid) {
        const api = window.pywebview?.api;
        if (!api) return null;
        const s = String(sid || '');
        if (s.startsWith('registry:')) {
            const rid = s.slice('registry:'.length);
            return {
                insert: (row) => api.world_registry_insert(rid, row),
                update: (rowId, set) => api.world_registry_update(rid, rowId, set),
                delete: (rowId) => api.world_registry_delete(rid, rowId),
            };
        }
        if (s.startsWith('table:')) {
            const tid = s.slice('table:'.length);
            return {
                insert: (row) => api.table_insert(tid, row),
                update: (rowId, set) => api.table_update(tid, rowId, set),
                delete: (rowId) => api.table_delete(tid, rowId),
            };
        }
        return null;
    }

    /** Open the row form in 'edit' mode prefilled from the active
     *  row. On submit dispatches to the matching update endpoint
     *  (sending only the columns that actually changed) and
     *  refreshes. */
    /** Open a registry row's combined viewer/editor — a non-modal window
     *  that shows the row read-only with an Edit toggle. The SAME view for
     *  every source (entity or data registry); deliberately NOT the full
     *  tiling entity editor. `startMode` opens straight in 'view' (row
     *  click / "Open") or 'edit' (context-menu "Edit"). */
    _openRowEntity(sourceId, rowId, startMode = 'view') {
        const cols     = this._resolveSourceColumns(sourceId) || [];
        const pk       = this._resolveSourcePrimaryKey(sourceId) || 'auto';
        const row      = this._findRowById(rowId) || {};
        const writable = this._sourceSupportsRowCrud(sourceId);
        const crud     = this._crudForSource(sourceId);
        openEntityWindow({
            title: `${sourceId} · ${rowId}`,
            columns: cols, row, primaryKey: pk, rowId,
            readOnly: !writable || !crud,
            startMode,
            metaSourceId: sourceId,
            onSave: async (collected) => {
                if (!crud) return { ok: false, error: 'source is not writable' };
                const set = {};
                for (const [k, v] of Object.entries(collected)) {
                    if (k === pk) continue;
                    if (row[k] !== v) set[k] = v;
                }
                if (Object.keys(set).length === 0) return { ok: true };
                const res = await crud.update(rowId, set);
                if (res?.ok) this._refreshSelectedRegistry();
                return res || { ok: false, error: 'update failed' };
            },
        });
    }

    async _editRowInSource(sourceId, rowId) {
        const crud = this._crudForSource(sourceId);
        if (!crud) return;
        const cols = this._resolveSourceColumns(sourceId);
        const pk   = this._resolveSourcePrimaryKey(sourceId);
        const row  = this._findRowById(rowId);
        if (!row) {
            toastError?.('Edit row', `Row ${rowId} not in current view`);
            return;
        }
        const result = await openRowForm({
            mode: 'edit', columns: cols, primaryKey: pk,
            row, rowId,
            title: `Edit row · ${sourceId}`,
        });
        if (!result) return;
        // Diff: only send changed columns. Avoids accidentally
        // overwriting a value the user didn't touch.
        const set = {};
        for (const [k, v] of Object.entries(result.row)) {
            if (k === pk) continue;
            if (row[k] !== v) set[k] = v;
        }
        if (Object.keys(set).length === 0) {
            toastInfo?.('Edit row', 'No changes');
            return;
        }
        try {
            const res = await crud.update(rowId, set);
            if (!res?.ok) {
                toastError?.('Edit row', res?.error || 'update failed');
                return;
            }
        } catch (exc) {
            toastError?.('Edit row', String(exc?.message || exc));
            return;
        }
        this._refreshSelectedRegistry();
    }

    /** Confirm + delete a row. */
    async _deleteRowInSource(sourceId, rowId) {
        const crud = this._crudForSource(sourceId);
        if (!crud) return;
        const ok = await showDeleteConfirmDialog({
            itemName: rowId, itemType: 'row',
            additionalMessage: `From source ${sourceId}.`,
        });
        if (!ok) return;
        try {
            const res = await crud.delete(rowId);
            if (!res?.ok) {
                toastError?.('Delete row', res?.error || 'delete failed');
                return;
            }
        } catch (exc) {
            toastError?.('Delete row', String(exc?.message || exc));
            return;
        }
        this._refreshSelectedRegistry();
    }

    /** Find a row in the current `_registryRowsState.entries` by its
     *  `_id` value. Returns the row object or null. */
    _findRowById(rowId) {
        const entries = this._registryRowsState?.entries || [];
        const wanted = String(rowId);
        const pk = this._resolveSourcePrimaryKey() || 'id';
        return entries.find(
            (r) => String(r?.id != null ? r.id : r?.[pk]) === wanted) || null;
    }

    /** Best-effort source column list — prefers the freshest schema
     *  from the last fetch response, falls back to the manifest's
     *  spec entry. Used by the row form. */
    _resolveSourceColumns(/* sourceId */) {
        const stateCols = Array.isArray(this._registryRowsState?.columns)
            ? this._registryRowsState.columns : [];
        if (stateCols.length > 0) return stateCols;
        return this._activeRegistrySpec()?.columns || [];
    }

    /** Primary-key column name for the active source — defaults to
     *  '_id' (the synthetic PK browser_query envelopes use). When
     *  the source spec declares a real PK column, that wins. */
    _resolveSourcePrimaryKey(/* sourceId */) {
        const fromState = this._registryRowsState?.primary_key;
        if (fromState) return fromState;
        return this._activeRegistrySpec()?.primary_key || 'id';
    }

    /** Adapt a `browser_query` response into the envelope the
     *  renderer expects (`{entries, columns, total, start,
     *  primary_key, category, time_series}`). Synthesises `_id`
     *  from the row contents so DataTable has a stable row key. */
    _envelopeFromQuery(res, q) {
        const cols    = res.columns || [];
        // Use the row's REAL `id` as the key when present — otherwise the
        // synthetic `_id` renders as a duplicate column next to `id`.
        // Only synthesise `_id` when the result has no natural id column.
        const hasId   = cols.some((c) => ((c && c.name) || c) === 'id');
        const entries = (res.rows || []).map((r, i) =>
            hasId ? r : ({ id: `q${i}`, ...r }));
        const isAgg   = Array.isArray(q.group_by) && q.group_by.length > 0;
        return {
            entries,
            columns:     cols,
            total:       Number(res.total) || entries.length,
            start:       Number(res.offset) || Number(q.offset) || 0,
            primary_key: 'id',
            category:    isAgg ? 'time_series' : 'time_series',
            time_series: true,
        };
    }

    /** Load (and cache) per-tick row counts for a source via
     *  `browser_query`. Returns the cached Map<tick, count>, or `null`
     *  on failure. Cache key: source id. Cleared on source change in
     *  `_selectRegistry`. */
    async _loadTickCounts(sourceId) {
        if (!sourceId) return null;
        this._tickCounts = this._tickCounts || {};
        // One bridge round-trip returns BOTH the row count per tick
        // and the per-tick average of the value column (when one
        // exists). The strip above the table draws a line of `v`
        // when available, or falls back to `n` (count) for sources
        // without a numeric magnitude (e.g., the events log).
        // Always refetch — values shift on every world tick.
        try {
            const api = window.pywebview?.api;
            const specCols = this._activeRegistrySpec()?.columns || [];
            const valueCol = this._resolveValueColumn(specCols);
            const select = [{col: 'tick'}, {agg: 'count', as: 'n'}];
            if (valueCol) {
                select.push({col: valueCol, agg: 'avg', as: 'v'});
            }
            const res = await api?.browser_query?.(sourceId, {
                select,
                group_by: ['tick'],
                order_by: [{col: 'tick', dir: 'asc'}],
            });
            if (!res?.ok) {
                this._tickCounts[sourceId] = null;
                return null;
            }
            const m = new Map();
            for (const r of (res.rows || [])) {
                const t = Number(r.tick);
                if (!Number.isFinite(t)) continue;
                const n  = Number(r.n) || 0;
                const v  = valueCol ? Number(r.v) : null;
                m.set(t, {
                    n,
                    v: (v != null && Number.isFinite(v)) ? v : null,
                });
            }
            this._tickCounts[sourceId] = m;
            return m;
        } catch {
            this._tickCounts[sourceId] = null;
            return null;
        }
    }

    _renderRegistryRows() {
        // Rows (or the query console) are about to paint — drop the
        // in-flight spinner. Runs before the early query-mode bail so the
        // overlay clears in every render path.
        this._setRegistryLoading(false);
        // Query mode owns the rows area — don't overwrite the console with
        // browsed rows (a source/category change re-seeds the query).
        if (this._browserQueryMode) { this._renderBrowserQuery(); return; }
        const target = this._host?.querySelector('[data-role="reg-rows"]');
        const countEl = this._host?.querySelector('[data-role="reg-count"]');
        if (!target) return;
        const state = this._registryRowsState
            || { entries: [], total: 0, start: 0, columns: [] };
        const rows = Array.isArray(state.entries) ? state.entries : [];
        const cols = Array.isArray(state.columns) ? state.columns : [];
        const total = Number(state.total) || rows.length;
        const start = Number(state.start) || 0;

        // Schema strip — one chip per column with its type. Refresh on
        // every render so source switches pick up the new schema.
        this._renderSchemaStrip(cols, state.primary_key);

        // Graph category swaps the rows pane for an SVG node-link
        // diagram. Title + count still reflect node/edge counts.
        if (state.category === 'graph') {
            this._renderBrowserGraph(state);
            if (countEl) {
                const nNodes = (state.nodes || []).length;
                countEl.textContent = `${nNodes} node${nNodes === 1 ? '' : 's'} · ${total} edge${total === 1 ? '' : 's'}`;
            }
            return;
        }

        // Keep the scope <select>'s options in sync with the active
        // registry's columns — every registry has a different schema.
        // Always include "All" (fulltext) + "_id" (primary key) + every
        // declared column. Source columns from the registry spec
        // (always present) rather than the rows response (omitted
        // when no world is active), so the dropdown is populated
        // even before the world starts running.
        const specCols = this._activeRegistrySpec()?.columns;
        this._updateRegistryFilterScopeOptions(
            Array.isArray(specCols) && specCols.length > 0 ? specCols : cols);

        // Scrubber visibility + range tracks the data — refresh on every
        // row render so a registry switch / fresh fetch updates the
        // slider max + visibility in lockstep with the rows below.
        this._updateRegistryScrubber();

        // Tick filter — always `t <= viewingTick` (cumulative). Both
        // the time-series tape deck and the relational/document slider
        // use the same semantic: "show rows up to this tick." When no
        // pin is set (viewingTick null), no filter is applied, which
        // is identical to `t <= maxTick` since the picker/slider
        // defaults to max in their sync routines. Rows without a tick
        // column pass through unfiltered.
        const activeSpec = this._activeRegistrySpec();
        const sourceHasTick = this._isTimeSeriesRegistry(activeSpec)
            || cols.some((c) => c && c.name === 'tick');
        const viewingTick = sourceHasTick ? getViewingTick() : null;
        // Brush window (M3) takes precedence over the single-tick
        // filter when set — the user explicitly selected a range, so
        // honour it over the implicit tape-deck/slider position.
        const winBrush = sourceHasTick ? this._registryWindow : null;
        const tickFiltered = winBrush
            ? rows.filter((r) => {
                const t = Number(r?.tick);
                if (!Number.isFinite(t)) return true;
                return t >= winBrush.start && t <= winBrush.end;
              })
            : (viewingTick != null
                ? rows.filter((r) => {
                    const t = Number(r?.tick);
                    if (!Number.isFinite(t)) return true;
                    return t <= Number(viewingTick);
                  })
                : rows);

        if (countEl) {
            const visible = tickFiltered.length;
            if (total === 0) {
                countEl.textContent = '';
            } else if (winBrush) {
                countEl.textContent = `tick ∈ [${winBrush.start}, ${winBrush.end}] · ${visible}/${total} row${total === 1 ? '' : 's'}`;
            } else if (viewingTick != null) {
                countEl.textContent = `tick ≤ ${viewingTick} · ${visible}/${total} row${total === 1 ? '' : 's'}`;
            } else {
                countEl.textContent = start > 0
                    ? `Showing latest ${rows.length} of ${total}`
                    : `${total} row${total === 1 ? '' : 's'}`;
            }
        }

        // Source-wide (all-cols / single-col scope) search — stays
        // external to DataTable because the scope dropdown is part of
        // the bottom-panel chrome, not the table itself.
        const q = (this._registryFilter || '').trim();
        const scope = this._registryFilterScope || 'all';
        const matchesScope = (r) => {
            if (!q) return true;
            if (scope === 'all') {
                return Object.values(r).some((v) =>
                    String(v ?? '').toLowerCase().includes(q));
            }
            return String(r[scope] ?? '').toLowerCase().includes(q);
        };
        const view = q ? tickFiltered.filter(matchesScope) : tickFiltered;

        // Empty-state message — pass through to DataTable so the user
        // sees the same chrome (header row + virtual italic row) instead
        // of a plain placeholder div. Context-aware wording: tick-scoped
        // misses get a different message from no-data-at-all.
        const emptyMessage = total === 0
            ? 'No entries.'
            : (viewingTick != null
                ? `No entries at or before tick ${viewingTick}.`
                : 'No entries match the filter.');

        // Single-id model: each row's identity is its `id` (the natural
        // pk; the bridge no longer emits a synthetic `_id`). Col 0 IS the
        // id; drop any `id`/pk column from the rest so it isn't shown twice.
        const pk = this._resolveSourcePrimaryKey() || 'id';
        const colSpecs = (cols.length > 0
            ? cols
            : Object.keys(view[0] || {}).map((n) => ({ name: n, type: 'str' }))
        ).filter((c) => c.name !== 'id' && c.name !== pk && c.name !== '_id');

        // ── DataTable: col 0 = id, then each non-id schema column ─────
        const rowId = (r) => {
            const v = (r && (r.id != null ? r.id : r[pk]));
            return v == null ? '' : String(v);
        };
        const headers = ['id', ...colSpecs.map((c) => c.name)];
        const arrayRows = view.map((r) => [
            rowId(r),
            ...colSpecs.map((c) => r[c.name]),
        ]);

        // Map schema type → DataTable's 'num'/'text' for sort+filter
        // comparators. _id is always text. tick/int/float → numeric.
        const numTypes = new Set(['int', 'float', 'tick']);
        const getColumnType = (colIdx /* , rows */) => {
            if (colIdx === 0) return 'text';
            const c = colSpecs[colIdx - 1];
            return (c && numTypes.has(c.type)) ? 'num' : 'text';
        };

        // Cell renderer — delegates to the schema-aware _renderTypedCell
        // for everything but _id. The td produced by _renderTypedCell
        // is a full `<td>…</td>` string; we extract the inner HTML and
        // any class names onto our pre-existing td.
        const renderCell = (td, value, colIdx /* , rowIdx, row */) => {
            if (colIdx === 0) {
                td.innerHTML = `<code>${esc(String(value || ''))}</code>`;
                return true;
            }
            const c = colSpecs[colIdx - 1];
            if (!c) return false;
            const wrap = document.createElement('template');
            wrap.innerHTML = _renderTypedCell(value, c).trim();
            const innerTd = wrap.content.firstElementChild;
            if (innerTd && innerTd.tagName === 'TD') {
                td.innerHTML = innerTd.innerHTML;
                if (innerTd.className) {
                    td.className = (td.className + ' ' + innerTd.className).trim();
                }
                return true;
            }
            return false;
        };

        const sourceId = this._activeRegistryId;

        // Row click → open the row's combined viewer/editor. Every source
        // is a DuckDB-shaped table now (no special "document" category);
        // a file-referencing column (`ref:file`, e.g. a document's `path`)
        // is a clickable relational link that opens the file in its own
        // window — handled in the ref-click wiring below.
        const onRowClick = (rowIdx, row) => {
            const rid = String(row[0] || '');
            if (rid) this._openRowEntity(sourceId, rid);
        };

        // Row right-click → "Open in editor" / "Edit row" / "Delete row"
        // / "Copy id" menu. Edit + Delete appear only for sources that
        // back to a writable CRUD endpoint (registry:* / table:*).
        // Row right-click → ONE unified menu: Open (combined viewer /
        // editor), Edit / Delete (writable), Copy cell, Copy id. This is
        // also the cell menu — there's no separate per-cell handler, so
        // the row options are always reachable (previously a cell-level
        // "Copy cell" menu fired first and masked them).
        const onRowContextMenu = (rowIdx, row, ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const rid = String(row[0] || '');
            if (!rid) return;
            const writable = this._sourceSupportsRowCrud(sourceId);
            const cellText = (ev.target.closest('td')?.textContent || '').trim();
            const items = [];
            // Every row can be opened in the combined viewer; writable
            // sources also get "Edit" (jumps straight into edit mode) and
            // "Delete".
            items.push({ label: 'Open', icon: 'open_in_new', action: 'open' });
            if (writable) {
                items.push({ label: 'Edit',        icon: 'edit',   action: 'edit' });
                items.push({ label: 'Delete row…', icon: 'delete', action: 'delete' });
            }
            items.push({ separator: true });
            if (cellText) {
                items.push({
                    label: `Copy cell (${cellText.length > 40 ? cellText.slice(0, 37) + '…' : cellText})`,
                    icon: 'content_copy', action: 'copy-cell',
                });
            }
            items.push({ label: `Copy id (${rid})`, icon: 'badge', action: 'copy-id' });
            showContextMenu(ev.clientX, ev.clientY, items, (action) => {
                if (action === 'open') {
                    this._openRowEntity(sourceId, rid, 'view');
                } else if (action === 'edit') {
                    this._openRowEntity(sourceId, rid, 'edit');
                } else if (action === 'delete') {
                    this._deleteRowInSource(sourceId, rid);
                } else if (action === 'copy-cell') {
                    navigator.clipboard?.writeText?.(cellText);
                    toastInfo?.('Copied', cellText);
                } else if (action === 'copy-id') {
                    navigator.clipboard?.writeText?.(rid);
                    toastInfo?.('Copied', rid);
                }
            });
        };

        // Dispose prior DataTable + mount fresh one. Mount-per-render
        // keeps the data path simple (re-fetch → re-render); DataTable's
        // pagination/sort state lives in `this._registryTable._state` so
        // it's reset on each new mount (which matches the source-switch
        // semantics — the user expects a clean slate per source).
        if (this._registryTable) {
            try { this._registryTable.dispose(); } catch {}
            this._registryTable = null;
        }
        target.innerHTML = '';
        // Layout class — makes the host a flex column so the histogram
        // (fixed-height) + DataTable (flex:1) stack correctly and
        // DataTable's inline `height: 100%` resolves to the actual
        // remaining space.
        target.classList.add('ea-bp-flows-editor--datatable');

        // M3 — per-tick bar chart with brush-selectable window for
        // aggregation. Hidden on non-tick sources (no x-axis to bar
        // against). Counts come from `_tickCounts[sourceId]` — a
        // bridge `browser_query` payload (group by tick, count) so
        // the histogram reflects the FULL source even when the row
        // table is narrowed by brush/tape-deck. We do NOT re-bucket
        // the row set client-side.
        const tickCounts = sourceHasTick
            ? this._tickCounts?.[activeSpec?.id] || null
            : null;
        if (sourceHasTick && tickCounts && tickCounts.size > 0) {
            const histoEl = document.createElement('div');
            histoEl.className = 'ea-bp-registry-histogram';
            // Append BEFORE rendering so `clientWidth` is non-zero —
            // the histogram needs that to convert the desired screen-
            // pixel handle width into viewBox logical units.
            target.appendChild(histoEl);
            this._renderTickHistogram(histoEl, tickCounts, colSpecs);
        }

        // DataTable lives inside its own host so the histogram is a
        // sibling above it (both flex children of `target`).
        const tableHost = document.createElement('div');
        tableHost.className = 'ea-bp-registry-table-host';
        target.appendChild(tableHost);
        // Server-side pagination. The bridge fetched a 500-row page
        // starting at `state.start`; `state.total` is the full row
        // count of the source (after filters). DataTable's pager
        // talks to the bridge via `onPageChange`, which updates the
        // cursor on this and re-fires the refresh.
        const pageOffset = Number(state.start) || 0;
        const pageTotal  = Number(state.total) || rows.length;
        this._registryTable = new DataTable(tableHost, {
            headers,
            rows: arrayRows,
            mode: 'compact',
            pageSize: 500,
            offset: pageOffset,
            totalCount: pageTotal,
            pagination: true,
            sortable: true,
            filterable: true,
            selectable: true,
            copyable: true,
            showExportButton: true,
            getColumnType,
            renderCell,
            onRowClick,
            onRowContextMenu,
            emptyMessage,
            onPageChange: (newOffset/*, _limit */) => {
                this._registryOffset = Math.max(0, Number(newOffset) || 0);
                this._refreshSelectedRegistry();
            },
            // Server-side sort: column header click → mutate
            // `_registrySort` + refetch via browser_query's
            // ORDER BY. Sort survives across page boundaries.
            onSort: (colIndex, ascending) => {
                const h = headers[colIndex];
                const col = (h && typeof h === 'object')
                    ? (h.key || h.name || h.label)
                    : h;
                if (!col) return;
                this._registrySort = { column: String(col), ascending };
                this._registryOffset = 0;  // sort resets to page 1
                this._refreshSelectedRegistry();
            },
        });
        this._registryTable.render();

        // ref:* / fk click-through — wired AFTER DataTable renders since
        // DataTable rebuilds DOM on each render. The links are emitted
        // by _renderTypedCell via renderCell above.
        target.querySelectorAll('[data-ref-source]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const sid   = el.getAttribute('data-ref-source');
                const value = el.getAttribute('data-ref-value') || '';
                // A `ref:file` link points at a project file (not a row) —
                // open its content in a new window.
                if (sid === 'file') { _openFileInWindow(value); return; }
                // Open the referenced row in the combined viewer; fall back
                // to re-pointing the browser when the row can't be resolved.
                openEntityRef(sid, value).then((ok) => {
                    if (!ok) this._navigateToRef(sid, value);
                });
            });
        });

        // "Add row" — BELOW the table on writable sources (registry:* /
        // table:*). Opens the entry mask as a transient tab in the MAIN
        // content tile's strip (the Ctrl+Enter tab layout) via the shared
        // tiling navigator — a classic two-column form where reference
        // columns get an entity search. The `#uid` forces a fresh tab per
        // click; the mask signals `ecoagent:rows:changed` on insert so the
        // Registries view re-fetches.
        if (this._sourceSupportsRowCrud(sourceId)) {
            const addStrip = document.createElement('div');
            addStrip.className = 'ea-bp-row-actions ea-bp-row-actions--below';
            addStrip.innerHTML = `
                <button type="button"
                        class="ea-bp-row-actions__add"
                        data-role="add-row"
                        title="Add a new row to this source">
                    <span class="material-symbols-outlined">add</span>
                    Add row
                </button>
            `;
            target.appendChild(addStrip);
            addStrip.querySelector('[data-role="add-row"]')
                ?.addEventListener('click', () => {
                    const uid = `${Date.now().toString(36)}${Math.floor(performance.now()).toString(36)}`;
                    window.__twm?.wm?.navigate(
                        'row-entry',
                        { id: `${sourceId}#${uid}`, label: `Add row · ${sourceId}` },
                        { dest: 'main', newTab: true, transient: true },
                    );
                });
        }
    }

    // ── In-browser query console (M4) ───────────────────────────────
    //
    // Python expression (`shell_eval`) over the live world (config is browsed
    // in the grid; SQL over config was removed — CATALOG_OFF_DUCKDB). Row-shaped
    // results render in a DataTable; a scalar value renders as a repr block.

    _queryIsSql() {
        // SQL over the project config was removed — the console is Python-only
        // (`shell_eval`). Config is browsed in the grid; run data via Python.
        return false;
    }

    _renderBrowserQuery() {
        const target = this._host?.querySelector('[data-role="reg-rows"]');
        if (!target) return;
        this._disposeBrowserQueryEditor();
        // Query console is Python-only. Raw SQL over the project config was
        // removed — config no longer lives in DuckDB; browse it in the grid,
        // and query run data with a Python expression here.
        target.innerHTML = `
            <div class="ea-bp-query2">
                <div class="ea-bp-query2__bar">
                    <span class="ea-bp-query2__lang-label" title="Python expression — no imports, no statements">Python</span>
                    <button type="button" class="ea-btn ea-btn--small ea-btn--primary"
                            data-role="bq-run" title="Run (Shift+Enter or Ctrl/Cmd+Enter)">Run ▶</button>
                    <span class="ea-bp-query2__status" data-role="bq-status"></span>
                </div>
                <div class="ea-bp-query2__editor" data-host="bq-editor"></div>
                <div class="ea-bp-query2__result" data-role="bq-result">
                    <div class="ea-table__empty">Write a Python query and press Run.</div>
                </div>
            </div>`;
        // Same layout class the rows view uses — makes the host a
        // definite-height flex column so the result DataTable's
        // `height:100%` resolves (without it the table collapses to 0
        // even though the query ran and the status shows N rows).
        target.classList.add('ea-bp-flows-editor--datatable');
        target.querySelector('[data-role="bq-run"]')
            ?.addEventListener('click', () => this._runBrowserQuery());
        this._mountBrowserQueryEditor(isSql);
    }

    async _mountBrowserQueryEditor(isSql) {
        const editorHost = this._host?.querySelector('[data-host="bq-editor"]');
        if (!editorHost) return;
        const seed = this._browserQueryText != null
            ? this._browserQueryText : this._defaultQueryText(isSql);
        let factory = null;
        try {
            const mod = await import('../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch { /* fall back to a textarea */ }
        if (!factory) {
            editorHost.innerHTML =
                '<textarea class="ea-bp-query2__fallback" spellcheck="false"></textarea>';
            this._bqFallback = editorHost.querySelector('textarea');
            if (this._bqFallback) {
                this._bqFallback.value = seed;
                this._bqFallback.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        this._runBrowserQuery();
                    }
                });
            }
            return;
        }
        const handle = factory.createEditor(editorHost, seed, {
            language: isSql ? 'sql' : 'python',
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'off',
            folding: false,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'none',
            fontSize: 13,
            // Breathing room — without line numbers the text otherwise
            // hugs the top-left edge of the box.
            padding: { top: 8, bottom: 8 },
            lineDecorationsWidth: 10,
            glyphMargin: false,
            // Respect the fixed 120px editor box (CSS) instead of
            // auto-growing to content height.
            noAutoHeight: true,
        });
        this._browserQueryMonaco = handle?.editor ?? handle;
        const monaco = factory.monaco;
        if (monaco && this._browserQueryMonaco?.addCommand) {
            const run = () => this._runBrowserQuery();
            // Both Ctrl/Cmd+Enter and Shift+Enter run; plain Enter still
            // inserts a newline for multi-line queries.
            this._browserQueryMonaco.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
            this._browserQueryMonaco.addCommand(
                monaco.KeyMod.Shift | monaco.KeyCode.Enter, run);
        }
    }

    _defaultQueryText(isSql) {
        if (!isSql) return 'len(sectors)';
        const name = String(this._activeRegistryId || 'sectors')
            .replace(/^(registry:|table:)/, '');
        return `SELECT * FROM ${name} LIMIT 100`;
    }

    _disposeBrowserQueryEditor() {
        try { this._browserQueryMonaco?.dispose?.(); } catch { /* ignore */ }
        try { this._browserQueryTable?.dispose?.(); } catch { /* ignore */ }
        this._browserQueryMonaco = null;
        this._browserQueryTable = null;
        this._bqFallback = null;
    }

    /** Render how-to-query guidance (Python live-world vocabulary) into the
     *  right rail (replaces the source picker in query mode). Items
     *  click-to-insert into the editor. */

    async _renderQueryGuide(listEl, inCat) {
        if (!listEl) return;
        // Python-only console (SQL over config was removed): the guide shows the
        // live-world vocabulary.
        const chip = (text) =>
            `<button type="button" class="ea-bp-qguide__chip" data-insert="${esc(text)}">${esc(text)}</button>`;
        const ex = (text, label) =>
            `<button type="button" class="ea-bp-qguide__example" data-insert="${esc(text)}"`
            + `${label ? ` title="${esc(label)}"` : ''}>${esc(text)}</button>`;
        const helpers = ['sectors', 'agents()', "balances('worker', 'Deposits')",
            "registries('metrics')", 'mean(…)', 'kpi(…)', 'len(…)'];
        const examples = [
            ex('len(sectors)'),
            ex("mean(balances('worker', 'Deposits'))", "mean(balances(…))"),
            ex("[s.id for s in sectors]", "list sector ids"),
            ex("registries('metrics').series('value', property='gdp')", "a property's (tick, value) series"),
            ex("registries('metrics').latest()", "latest row"),
            ex("sum(a.balance for a in agents())", "sum a field over agents")];
        const body = `
                <div class="ea-bp-qguide__head">Python expression — live world</div>
                <p class="ea-bp-qguide__hint">A single Python expression evaluated against the live world — no imports, no statements (same vocabulary as KPIs). Time-series registries are numpy arrays: <code>registries('&lt;id&gt;')</code> exposes <code>.series()</code> / <code>.latest()</code> / <code>.where()</code>. Click to insert; Ctrl/Cmd+Enter runs.</p>
                <div class="ea-bp-qguide__label">Names &amp; helpers</div>
                <div class="ea-bp-qguide__chips">${helpers.map(chip).join('')}</div>
                <div class="ea-bp-qguide__label">Examples</div>
                ${examples.join('\n')}`;
        listEl.innerHTML = `<div class="ea-bp-qguide">${body}</div>`;
        listEl.querySelectorAll('[data-insert]').forEach((el) =>
            el.addEventListener('click', () => this._insertIntoBrowserQuery(el.dataset.insert || '')));
        this._setBrowserTitle('Query');
    }

    _insertIntoBrowserQuery(text) {
        if (!text) return;
        const ed = this._browserQueryMonaco;
        if (ed?.getSelection && ed?.executeEdits) {
            try {
                ed.executeEdits('guide-insert',
                    [{ range: ed.getSelection(), text, forceMoveMarkers: true }]);
                ed.focus();
                return;
            } catch { /* fall through to the textarea */ }
        }
        const t = this._bqFallback;
        if (t) {
            const s = t.selectionStart ?? t.value.length;
            const e = t.selectionEnd ?? s;
            t.value = t.value.slice(0, s) + text + t.value.slice(e);
            t.focus();
        }
    }

    _readBrowserQueryText() {
        return (this._browserQueryMonaco?.getValue?.()
            ?? this._bqFallback?.value ?? '');
    }

    async _runBrowserQuery() {
        const text = this._readBrowserQueryText().trim();
        this._browserQueryText = text;
        const status = this._host?.querySelector('[data-role="bq-status"]');
        const resultHost = this._host?.querySelector('[data-role="bq-result"]');
        if (!text || !resultHost) return;
        if (status) status.textContent = 'running…';
        const api = window.pywebview?.api;
        try {
            // Python-only console: a Python expression via `shell_eval`
            // (SQL over config was removed).
            const res = await api?.shell_eval?.(text);   // Python expression
            if (!res || res.ok === false) {
                if (status) status.textContent = 'error';
                resultHost.innerHTML =
                    `<div class="ea-bp-query2__error">${esc(res?.error || 'query failed')}</div>`;
                return;
            }
            const n = this._renderQueryResult(resultHost, res);
            if (status) {
                status.textContent = (n == null) ? 'invalid'
                    : `${n} row${n === 1 ? '' : 's'}${res.row_truncated ? ' (truncated)' : ''}`;
            }
        } catch (exc) {
            if (status) status.textContent = 'error';
            resultHost.innerHTML =
                `<div class="ea-bp-query2__error">${esc(String(exc?.message || exc))}</div>`;
        }
    }

    /** Render a query result as a DataTable — always. SQL returns
     *  `{rows, columns}`; a Python expression returns `{table, tabular}`
     *  where `table` is the row/column coercion (null when the value
     *  has no table shape, which we surface as an "invalid query"). */
    _renderQueryResult(host, res) {
        let headers, arrayRows;
        if (res && Object.prototype.hasOwnProperty.call(res, 'table')) {
            // Python expression. A non-tabular value (None, a bare
            // object, a callable) → notify the user instead of guessing.
            if (!res.table) {
                host.innerHTML =
                    `<div class="ea-bp-query2__error">Invalid query — the expression returned `
                    + `<code>${esc(String(res.type || 'a value'))}</code>, which can't be shown as a table. `
                    + `Return rows (e.g. <code>registries('…').where(…)</code>), a list, a dict, or a value.</div>`;
                return null;
            }
            headers = (res.table.columns || []).map(String);
            arrayRows = res.table.rows || [];
        } else {
            const rows = Array.isArray(res.rows) ? res.rows : null;
            if (!rows) {
                host.innerHTML = '<div class="ea-bp-query2__error">No result.</div>';
                return null;
            }
            headers = (Array.isArray(res.columns) && res.columns.length)
                ? res.columns.map(String)
                : (rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])
                    ? Object.keys(rows[0])
                    : (Array.isArray(rows[0]) ? rows[0].map((_, i) => `c${i}`) : []));
            arrayRows = rows.map((r) => Array.isArray(r)
                ? r : headers.map((h) => r?.[h]));
        }
        host.innerHTML = '';
        const tableHost = document.createElement('div');
        tableHost.className = 'ea-bp-registry-table-host';
        host.appendChild(tableHost);
        try { this._browserQueryTable?.dispose?.(); } catch { /* ignore */ }
        this._browserQueryTable = new DataTable(tableHost, {
            headers, rows: arrayRows,
            sortable: true, filterable: true, copyable: true,
            showExportButton: true,
            mode: 'compact', emptyMessage: 'No rows.',
        });
        // The constructor only wires config — nothing renders until
        // render() is called (same as the registries rows view). This
        // was the actual "no table" bug: the host stayed empty.
        this._browserQueryTable.render();
        return arrayRows.length;
    }

    /** M3 — render the density-strip histogram for a time-series
     *  source. One bar per bin, height proportional to rows-in-bin /
     *  max-rows-in-any-bin. Click a bar to jump viewing-tick to the
     *  bin's center. ~60 bins max so the strip stays readable even
     *  for long runs. Pure DOM (no canvas) — bars are flex children
     *  with percentage widths + heights so resizing is automatic. */
    /** M3 — time-series window selector + per-tick bar chart.
     *
     *  Visual:
     *    - One narrow column per tick, tiny gap between columns so each
     *      bar is visually distinct. Height ∝ entries at that tick.
     *      SVG with vertical gradient fill for crisp scaling.
     *
     *  Interaction (when a window is set):
     *    - Drag empty area → create new brush
     *    - Drag inside brush → move it
     *    - Drag left/right edge → resize
     *    - Click outside / double-click brush → clear
     *
     *  Effects of an active brush (`this._registryWindow`):
     *    - Row table filters to `tick ∈ [start, end]` (overrides the
     *      single-tick filter from tape deck / slider while set)
     *    - Aggregation strip shows count · sum · mean · min · max
     *      for each numeric column, computed over the windowed rows.
     */
    _renderTickHistogram(el, counts, colSpecs) {
        // `counts` is Map<tick, {n, v}> from `_loadTickCounts` — the
        // backend already did the group-by-tick + count + avg(value)
        // via browser_query. This is a pure render fn over that
        // payload; we never aggregate client-side.
        if (!counts || counts.size === 0) {
            el.innerHTML = '';
            return;
        }
        const ticks    = [...counts.keys()].sort((a, b) => a - b);
        const minTick  = ticks[0];
        const maxTick  = ticks[ticks.length - 1];
        const range    = Math.max(1, maxTick - minTick + 1);

        // Background-only line of the value column. Use `v` when the
        // backend returned one (source has an aggregatable value);
        // fall back to `n` (row count) for value-less sources like
        // the events log. The plot is decorative context — not a
        // chart — so the line is single-pixel light gray, drawn
        // behind the brush, no axes, no ticks, no labels.
        const usesValue = ticks.some((t) => counts.get(t)?.v != null);
        const yOf = (t) => {
            const c = counts.get(t);
            if (!c) return null;
            return usesValue ? c.v : c.n;
        };
        let yMin = Infinity, yMax = -Infinity;
        for (const t of ticks) {
            const v = yOf(t);
            if (v == null || !Number.isFinite(v)) continue;
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
        if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
        if (yMax === yMin) { yMax = yMin + 1; }

        // SVG fills 100% of its container via viewBox. Per-tick
        // slot width below is a logical unit; scaling is automatic.
        // The slotPx is kept so the brush hit-test and the per-tick
        // x mapping share a single source of truth.
        const slotPx  = 6;
        const totalPx = range * slotPx;
        const VBH = 40;
        const PAD_Y = 2;
        const usableH = VBH - PAD_Y;
        const yScale = (v) => {
            if (v == null || !Number.isFinite(v)) return VBH;
            const norm = (v - yMin) / (yMax - yMin);
            return VBH - (PAD_Y + norm * (usableH - PAD_Y));
        };

        // Build the polyline. Center the x on each tick's slot so
        // the line aligns visually with the brush rectangles. Gaps
        // (ticks with no row) break the line — use a separate path
        // segment for each contiguous run so we don't drag a line
        // across the gap.
        const segments = [];
        let current = [];
        for (let t = minTick; t <= maxTick; t++) {
            const v = yOf(t);
            const x = (t - minTick) * slotPx + slotPx / 2;
            if (v == null || !Number.isFinite(v)) {
                if (current.length) segments.push(current);
                current = [];
                continue;
            }
            current.push(`${x.toFixed(2)},${yScale(v).toFixed(2)}`);
        }
        if (current.length) segments.push(current);
        // Stroke + fill come from CSS so the user can theme later
        // without touching the renderer. `vector-effect` keeps the
        // line at 1 screen pixel regardless of viewBox scale.
        const lines = segments.map((pts) => `
            <polyline class="ea-bp-registry-histogram__line"
                      points="${pts.join(' ')}"
                      fill="none"
                      stroke-width="1.25" vector-effect="non-scaling-stroke"/>
        `).join('');
        // Filled area under the line — even subtler, for shape only.
        const areaPts = segments.length
            ? `${segments[0][0].split(',')[0]},${VBH} `
              + segments.flat().join(' ')
              + ` ${segments[segments.length - 1][segments[segments.length - 1].length - 1].split(',')[0]},${VBH}`
            : '';
        const areaFill = areaPts
            ? `<polygon class="ea-bp-registry-histogram__area"
                        points="${areaPts}"/>`
            : '';
        const bars = areaFill + lines;

        // Active brush overlay — visible body + two distinct edge
        // handles. The handles are rendered as separate SVG <rect>s
        // with their own cursor + class so the user can see (and the
        // pointer signals) that the edges are drag-to-resize zones.
        const win = this._registryWindow;
        let brushOverlay = '';
        let brushLabel = '';
        if (win
            && Number.isFinite(win.start) && Number.isFinite(win.end)
            && win.start <= maxTick && win.end >= minTick) {
            const s = Math.max(minTick, win.start);
            const e = Math.min(maxTick, win.end);
            const x = (s - minTick) * slotPx;
            const w = (e - s + 1) * slotPx;
            // Handle width in viewBox units, computed to render as a
            // constant ~6 screen pixels regardless of how much the
            // viewBox stretches. Fall back to 1.5 logical units (a
            // sliver) when the container hasn't laid out yet.
            const containerW = el.clientWidth || 0;
            const HW = containerW > 0
                ? (6 / containerW) * totalPx
                : 1.5;
            brushOverlay = `
                <g class="ea-bp-registry-histogram__brush">
                    <rect class="ea-bp-registry-histogram__brush-body"
                          x="${x.toFixed(3)}" y="0"
                          width="${w.toFixed(3)}" height="${VBH}"
                          fill="rgba(255, 165, 0, 0.18)" />
                    <rect class="ea-bp-registry-histogram__brush-handle"
                          data-brush-zone="resize-start"
                          x="${x.toFixed(3)}" y="0"
                          width="${HW.toFixed(3)}" height="${VBH}"
                          fill="#ffa500" fill-opacity="0.85" />
                    <rect class="ea-bp-registry-histogram__brush-handle"
                          data-brush-zone="resize-end"
                          x="${(x + w - HW).toFixed(3)}" y="0"
                          width="${HW.toFixed(3)}" height="${VBH}"
                          fill="#ffa500" fill-opacity="0.85" />
                </g>`;
            brushLabel = `<span class="ea-bp-registry-histogram__brush-label"
                                title="Drag edges to resize · drag body to move · double-click to clear">
                            window [${s}, ${e}] · ${e - s + 1} tick${e - s === 0 ? '' : 's'}
                          </span>`;
        }

        // SVG fills 100% of the container. `viewBox` does the scaling
        // so the bar+gap "slot" units are stretched/squished to fit;
        // bars are decorative — exact pixel size doesn't matter.
        // `preserveAspectRatio="none"` lets x and y scale independently.
        el.innerHTML = `
            <svg class="ea-bp-registry-histogram__svg"
                 width="100%" height="${VBH}"
                 viewBox="0 0 ${totalPx} ${VBH}"
                 preserveAspectRatio="none">
                <defs>
                    <linearGradient id="ea-hist-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stop-color="#3aa3e0" stop-opacity="0.95"/>
                        <stop offset="100%" stop-color="#1177b3" stop-opacity="0.85"/>
                    </linearGradient>
                </defs>
                ${bars}
                ${brushOverlay}
            </svg>
            <div class="ea-bp-registry-histogram__axis">
                <span>${minTick}</span>
                <span class="ea-bp-registry-histogram__axis-mid">
                    ${counts.size} tick${counts.size === 1 ? '' : 's'} · ${usesValue ? 'avg(value)' : 'rows/tick'}
                    ${brushLabel}
                </span>
                <span>${maxTick}</span>
            </div>
            ${this._renderWindowAggregations(colSpecs, win, minTick, maxTick)}
        `;

        // ── Brush interactions ────────────────────────────────────────
        // The SVG uses a viewBox so logical units (0..totalPx) stretch
        // to fit the container width. Convert a screen-space clientX
        // to viewBox-space by `(clientX - left) / rect.width * totalPx`.
        const svgEl = () => el.querySelector('.ea-bp-registry-histogram__svg');
        const toViewBoxX = (clientX) => {
            const s = svgEl();
            if (!s) return 0;
            const rect = s.getBoundingClientRect();
            if (rect.width <= 0) return 0;
            const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
            return (x / rect.width) * totalPx;
        };
        const tickAtX = (clientX) => {
            const vx = toViewBoxX(clientX);
            const idx = Math.floor(vx / slotPx);
            return Math.max(minTick, Math.min(maxTick, minTick + idx));
        };
        // Hit-test the current brush. Hit zones are also in viewBox
        // units; we scale a 12-screen-pixel zone into viewBox units so
        // the affordance stays roughly constant on screen across
        // different container widths.
        const HANDLE_PX_SCREEN = 12;
        const brushHitTest = (clientX) => {
            if (!win) return 'empty';
            const s = svgEl();
            if (!s) return 'empty';
            const rect = s.getBoundingClientRect();
            if (rect.width <= 0) return 'empty';
            const handleU = (HANDLE_PX_SCREEN / rect.width) * totalPx;
            const x = toViewBoxX(clientX);
            const startU = (win.start - minTick) * slotPx;
            const endU   = (win.end   - minTick + 1) * slotPx;
            if (x < startU - handleU || x > endU + handleU) return 'outside';
            if (Math.abs(x - startU) <= handleU) return 'resize-start';
            if (Math.abs(x - endU)   <= handleU) return 'resize-end';
            return 'move';
        };

        el.onmousedown = (ev) => {
            ev.preventDefault();
            const mode = brushHitTest(ev.clientX);
            const startTick = tickAtX(ev.clientX);
            let dragOrigin = startTick;
            let originWin = win ? { ...win } : null;
            let didMove = false;

            // During drag the brush is updated LOCALLY only — we mutate
            // SVG `x`/`width` on the existing brush <rect>s + the label
            // span without any DataTable rebuild and without any bridge
            // round-trip. On mouseup we commit by calling
            // `_renderRegistryRows()` once, which triggers a windowed
            // `browser_rows` + the aggregate `browser_query` refetch.
            // This is the difference between buttery dragging and the
            // hundreds-of-ms lag we had before.
            const svgEl    = el.querySelector('.ea-bp-registry-histogram__svg');
            const bodyEl   = el.querySelector('.ea-bp-registry-histogram__brush-body');
            const startHEl = el.querySelector('[data-brush-zone="resize-start"]');
            const endHEl   = el.querySelector('[data-brush-zone="resize-end"]');
            const labelEl  = el.querySelector('.ea-bp-registry-histogram__brush-label');

            const computeWin = (curTick) => {
                if (mode === 'move' && originWin) {
                    const delta = curTick - dragOrigin;
                    let s = originWin.start + delta;
                    let e = originWin.end + delta;
                    if (s < minTick) { e += (minTick - s); s = minTick; }
                    if (e > maxTick) { s -= (e - maxTick); e = maxTick; }
                    return { start: s, end: e };
                }
                if (mode === 'resize-start' && originWin) {
                    return {
                        start: Math.max(minTick, Math.min(originWin.end, curTick)),
                        end:   originWin.end,
                    };
                }
                if (mode === 'resize-end' && originWin) {
                    return {
                        start: originWin.start,
                        end:   Math.min(maxTick, Math.max(originWin.start, curTick)),
                    };
                }
                // empty / outside → new brush from origin to current
                return {
                    start: Math.min(dragOrigin, curTick),
                    end:   Math.max(dragOrigin, curTick),
                };
            };

            const paintLocal = (w) => {
                this._registryWindow = w;
                // Reposition the existing brush rects (no rebuild).
                // Handle width in viewBox units — same conversion as
                // the render path so the on-screen handle stays
                // ~6 px regardless of container width.
                const containerW = el.clientWidth || 0;
                const HW = containerW > 0
                    ? (6 / containerW) * totalPx
                    : 1.5;
                if (bodyEl || startHEl || endHEl) {
                    const x  = (w.start - minTick) * slotPx;
                    const wd = (w.end - w.start + 1) * slotPx;
                    if (bodyEl)   { bodyEl.setAttribute('x', x.toFixed(3));
                                    bodyEl.setAttribute('width', wd.toFixed(3)); }
                    if (startHEl) { startHEl.setAttribute('x', x.toFixed(3));
                                    startHEl.setAttribute('width', HW.toFixed(3)); }
                    if (endHEl)   { endHEl.setAttribute('x', (x + wd - HW).toFixed(3));
                                    endHEl.setAttribute('width', HW.toFixed(3)); }
                } else if (svgEl) {
                    // No existing brush DOM (this is a fresh selection
                    // started from empty area) — fall through to the
                    // full re-render path so the brush appears at all.
                    // Once it's there the next paintLocal stays local.
                    this._renderRegistryRows();
                }
                if (labelEl) {
                    labelEl.textContent =
                        `window [${w.start}, ${w.end}] · `
                        + `${w.end - w.start + 1} `
                        + `tick${w.end - w.start === 0 ? '' : 's'}`;
                }
            };

            paintLocal(computeWin(startTick));

            // rAF throttle the local paint too — `setAttribute`-only
            // is cheap but still benefits from coalescing to one paint
            // per animation frame on rapid drags.
            let rafId = 0;
            let pendingTick = null;
            const flush = () => {
                rafId = 0;
                if (pendingTick == null) return;
                const t = pendingTick;
                pendingTick = null;
                if (t !== dragOrigin) didMove = true;
                paintLocal(computeWin(t));
            };
            const onMove = (e) => {
                pendingTick = tickAtX(e.clientX);
                if (!rafId) rafId = requestAnimationFrame(flush);
            };
            const onUp = () => {
                if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
                if (pendingTick != null) {
                    if (pendingTick !== dragOrigin) didMove = true;
                    paintLocal(computeWin(pendingTick));
                    pendingTick = null;
                }
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                // Click-without-drag outside an existing brush clears it.
                if (!didMove && mode === 'outside') {
                    this._registryWindow = null;
                }
                // Brush ↔ tape-deck mutex: transitioning into the
                // brushed state clears any pinned viewing-tick + re-
                // arms Latest, so when the brush is later cleared the
                // table comes back to "latest" instead of a stale
                // single-tick view from before the brush existed.
                const hadBrushBefore = !!originWin;
                const hasBrushAfter  = !!this._registryWindow;
                if (!hadBrushBefore && hasBrushAfter) {
                    setViewingTick(null);
                    this._regTickLatest = true;
                }
                // Single COMMIT — paginated row refetch +
                // browser_query aggregate fire from here.
                this._refreshSelectedRegistry();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        // Double-click anywhere on the strip clears the brush.
        el.ondblclick = (ev) => {
            ev.preventDefault();
            this._registryWindow = null;
            this._refreshSelectedRegistry();
        };

        // Wire the aggregation toolbar's interactive bits (function
        // picker buttons, precise number inputs, clear-window button).
        const aggEl = el.querySelector('.ea-bp-registry-histogram__agg');
        this._wireAggregationToolbar(aggEl, minTick, maxTick);
        // Kick off the bridge-side aggregate compute when the user
        // has actually picked an aggregation function. In `rows`
        // mode there's no result row to fill — skip the round-trip.
        const aggFn = this._registryAggFn || 'rows';
        if (aggEl && aggFn !== 'rows') {
            this._fetchAndRenderAggregates(
                aggEl, this._registryWindow, minTick, maxTick, colSpecs,
            );
        }
    }

    /** Window aggregation strip. Two rows:
     *    1. Toolbar: precise start/end number inputs + function picker
     *       (count / sum / mean / min / max) + Clear button.
     *    2. Per-numeric-column values for the SELECTED function only.
     *  Empty when no brush is set. */
    _renderWindowAggregations(colSpecs, win, minTick, maxTick) {
        // Synchronous: renders the toolbar (filter row, group row,
        // function picker, value-col picker, window inputs when
        // brushed, clear when brushed) + a "computing…" placeholder
        // for the result row. `_fetchAndRenderAggregates` fires async
        // and replaces the placeholder when `browser_query` returns.
        // The toolbar renders unconditionally so the user can
        // configure filter/group BEFORE picking an aggregation — the
        // brush is just one optional input (the time window).
        if (!this._registryAggFn) this._registryAggFn = 'rows';
        const fn = this._registryAggFn;
        const hasBrush = !!win && Number.isFinite(win?.start)
            && Number.isFinite(win?.end);
        const s = hasBrush ? Math.max(minTick, win.start) : minTick;
        const e = hasBrush ? Math.min(maxTick, win.end)   : maxTick;

        const fns = ['rows', 'count', 'sum', 'mean', 'min', 'max'];
        const fnTitle = {
            rows:  'Raw rows in window (no aggregation)',
            count: 'Count of rows, per tick',
            sum:   'Sum (Σ) per tick, for each numeric column',
            mean:  'Arithmetic mean (x̄) per tick, for each numeric column',
            min:   'Minimum per tick, for each numeric column',
            max:   'Maximum per tick, for each numeric column',
        };
        const fnLabel = { rows: '≡', count: 'n', sum: 'Σ',
                          mean: 'x̄', min: 'min', max: 'max' };
        const fnButtons = fns.map((f) => `
            <button type="button"
                    class="ea-bp-registry-histogram__fn${f === fn ? ' is-active' : ''}"
                    data-agg-fn="${f}"
                    title="${fnTitle[f]}">${fnLabel[f]}</button>
        `).join('');

        // Value-column dropdown — what the aggregation runs over.
        // Default = literal `value`; falls back to first non-id non-
        // tick column. User pick wins (persisted on
        // `_registryValueCol`).
        const valueCol = this._resolveValueColumn(colSpecs);
        const aggCandidates = (colSpecs || []).filter((c) =>
            c && c.name !== 'tick' && c.name !== '_id');
        const valueSelect = aggCandidates.length === 0 ? '' : `
            <span class="ea-bp-registry-histogram__agg-sep">·</span>
            <span class="ea-bp-registry-histogram__agg-label" title="Column aggregated by the selected function">value</span>
            <select class="ea-bp-registry-histogram__agg-input"
                    data-agg-value-col
                    title="Choose which column the aggregation runs over">
                ${aggCandidates.map((c) => `
                    <option value="${esc(c.name)}"
                            ${c.name === valueCol ? 'selected' : ''}>
                        ${esc(c.name)}
                    </option>`).join('')}
            </select>`;

        // Per-dimension filter + group-by row. Every column except
        // the chosen value column qualifies. Filter = exact match
        // text input; group-by = toggle chip that adds the dim to
        // the GROUP BY alongside `tick`.
        const dims = this._dimensionColumns(colSpecs, valueCol);
        const filters = this._registryDimFilters || {};
        const groupDims = this._registryGroupDims || new Set();
        const dimRow = dims.length === 0 ? '' : `
            <div class="ea-bp-registry-histogram__agg-dims">
                <span class="ea-bp-registry-histogram__agg-label">filter</span>
                ${dims.map((c) => `
                    <span class="ea-bp-registry-histogram__agg-dim">
                        <span class="ea-bp-registry-histogram__agg-dim-name"
                              title="${esc(c.name)} (${esc(c.type || 'str')})">
                            ${esc(c.name)}
                        </span>
                        <input type="text"
                               class="ea-bp-registry-histogram__agg-input"
                               data-agg-filter="${esc(c.name)}"
                               value="${esc(filters[c.name] ?? '')}"
                               placeholder="="
                               title="Exact-match filter on ${esc(c.name)} (empty = no filter)">
                    </span>
                `).join('')}
                <span class="ea-bp-registry-histogram__agg-sep">·</span>
                <span class="ea-bp-registry-histogram__agg-label" title="Split aggregation by each selected dimension (always grouped by tick)">group</span>
                <div class="ea-bp-registry-histogram__fns" role="group"
                     aria-label="Group by dimensions">
                    ${dims.map((c) => `
                        <button type="button"
                                class="ea-bp-registry-histogram__fn${groupDims.has(c.name) ? ' is-active' : ''}"
                                data-agg-group="${esc(c.name)}"
                                title="Group by ${esc(c.name)} (splits aggregation per ${esc(c.name)} value)">
                            ${esc(c.name)}
                        </button>
                    `).join('')}
                </div>
            </div>`;

        // Window controls + clear render only when a brush exists.
        // Without a brush, the implicit window is the full source
        // range (no `where: tick between` is sent).
        const windowBlock = hasBrush ? `
            <span class="ea-bp-registry-histogram__agg-label">window</span>
            <input type="number" class="ea-bp-registry-histogram__agg-input"
                   data-agg-start
                   value="${s}" min="${minTick}" max="${maxTick}"
                   title="Window start tick">
            <span class="ea-bp-registry-histogram__agg-sep">→</span>
            <input type="number" class="ea-bp-registry-histogram__agg-input"
                   data-agg-end
                   value="${e}" min="${minTick}" max="${maxTick}"
                   title="Window end tick">
        ` : `
            <span class="ea-bp-registry-histogram__agg-label" title="Drag the slicer above to set a time window">full range</span>
        `;
        const clearBlock = hasBrush ? `
            <button type="button"
                    class="ea-bp-registry-histogram__agg-clear"
                    data-agg-clear
                    title="Clear window">×</button>
        ` : '';
        // The aggregate-result row only makes sense when something is
        // being aggregated. In `rows` mode it's redundant noise.
        const resultBlock = (fn === 'rows') ? '' : `
            <div class="ea-bp-registry-histogram__agg-row"
                 data-role="agg-result">
                <span class="ea-bp-registry-histogram__agg-empty">
                    computing…
                </span>
            </div>
        `;
        return `
            <div class="ea-bp-registry-histogram__agg">
                <div class="ea-bp-registry-histogram__agg-toolbar">
                    ${windowBlock}
                    <div class="ea-bp-registry-histogram__fns" role="group"
                         aria-label="Aggregation function">${fnButtons}</div>
                    ${valueSelect}
                    ${clearBlock}
                </div>
                ${dimRow}
                ${resultBlock}
            </div>
        `;
    }

    /** Async: query the bridge for window aggregates and replace the
     *  placeholder result row in the toolbar. Driven by the active
     *  brush + the selected function. Called from `_renderTickHistogram`
     *  after the synchronous toolbar HTML is in the DOM. */
    async _fetchAndRenderAggregates(el, win, minTick, maxTick, colSpecs) {
        const resultEl = el.querySelector('[data-role="agg-result"]');
        if (!resultEl) return;
        const id = this._activeRegistryId;
        if (!id) return;
        const fn = this._registryAggFn || 'count';
        // No brush → full source range (no tick window clause sent).
        const hasBrush = !!win && Number.isFinite(win?.start)
            && Number.isFinite(win?.end);
        const s = hasBrush ? Math.max(minTick, win.start) : minTick;
        const e = hasBrush ? Math.min(maxTick, win.end)   : maxTick;

        const fnLabel = { rows: 'rows', count: 'n', sum: 'Σ',
                          mean: 'x̄', min: 'min', max: 'max' };
        // The value column is what we aggregate over — `value` by
        // convention, falling back to the first non-id non-tick
        // column on schemas without one, user-overridable via the
        // toolbar dropdown. Sources without an aggregatable column
        // fall back to the row count for the strip.
        const valueCol = this._resolveValueColumn(colSpecs);
        const stripIsCount =
            (fn === 'rows' || fn === 'count' || !valueCol);
        const sendAgg = fn === 'mean' ? 'avg' : fn;
        const select = stripIsCount
            ? [{agg: 'count', as: 'n'}]
            : [{col: valueCol, agg: sendAgg, as: fn}];

        // Tick window only when brushed — without a brush the strip
        // aggregates over the full source.
        const where = hasBrush
            ? [{col: 'tick', op: 'between', value: [s, e]}]
            : [];
        // Apply user's dimension filters to the strip too — the
        // strip is "this aggregate, over this window, with these
        // filters". Without it the strip total would disagree with
        // the table contents.
        for (const w of this._buildDimWhere(colSpecs, valueCol)) {
            where.push(w);
        }
        let res;
        try {
            res = await window.pywebview?.api?.browser_query?.(id, {
                select, where,
            });
        } catch (exc) {
            res = {ok: false, error: String(exc)};
        }
        if (!res?.ok) {
            resultEl.innerHTML = `<span class="ea-bp-registry-histogram__agg-empty">
                error: ${esc(res?.error || 'query failed')}
            </span>`;
            return;
        }
        const row = (res.rows && res.rows[0]) || {};

        const fmt = (n) => {
            if (n == null || !Number.isFinite(Number(n))) return '—';
            const x = Number(n);
            const a = Math.abs(x);
            if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
            if (Number.isInteger(x) && a < 1e6) return String(x);
            return x.toFixed(a >= 100 ? 1 : 3);
        };

        let cellsHtml;
        if (stripIsCount) {
            const n = Number(row.n) || 0;
            cellsHtml = `<span class="ea-bp-registry-histogram__agg-col"
                              title="Rows in window">
                            ${n} row${n === 1 ? '' : 's'}
                        </span>`;
        } else {
            const v = row[fn];
            if (v == null) {
                cellsHtml = `<span class="ea-bp-registry-histogram__agg-empty">
                    No values in window.
                </span>`;
            } else {
                cellsHtml = `<span class="ea-bp-registry-histogram__agg-col"
                                   title="value ${fnLabel[fn]}: ${v}">
                                <b>value</b> ${fmt(v)}
                            </span>`;
            }
        }
        resultEl.innerHTML = cellsHtml;
    }

    /** Wire the aggregation toolbar's interactive bits (function
     *  buttons, precise start/end inputs, clear). Called once per
     *  histogram render so listeners get fresh DOM references. */
    _wireAggregationToolbar(el, minTick, maxTick) {
        if (!el) return;
        el.querySelectorAll('[data-agg-fn]').forEach((b) => {
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._registryAggFn = b.getAttribute('data-agg-fn');
                // Function changed — the TABLE re-renders too: 'rows'
                // shows raw windowed rows, every other function shows
                // a per-tick aggregation. So we go through the full
                // refresh (which dispatches between `browser_rows`
                // and `browser_query` based on fn).
                this._refreshSelectedRegistry();
            });
        });
        const startInput = el.querySelector('[data-agg-start]');
        const endInput   = el.querySelector('[data-agg-end]');
        const updateFromInputs = () => {
            const s = Math.max(minTick, Math.min(maxTick,
                Number(startInput.value)));
            const e = Math.max(minTick, Math.min(maxTick,
                Number(endInput.value)));
            if (Number.isFinite(s) && Number.isFinite(e) && s <= e) {
                this._registryWindow = { start: s, end: e };
                // Window changed — refetch paginated rows AND the
                // aggregate panel from the bridge.
                this._refreshSelectedRegistry();
            }
        };
        startInput?.addEventListener('change', updateFromInputs);
        endInput?.addEventListener('change', updateFromInputs);
        // Stop pointer events inside the toolbar from reaching the
        // SVG's mousedown brush-create handler.
        el.addEventListener('mousedown', (ev) => ev.stopPropagation());
        el.querySelector('[data-agg-clear]')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._registryWindow = null;
            this._refreshSelectedRegistry();
        });

        // Value-column dropdown — fires on every selection change.
        // Picking a new value column also rebuilds the dim row (the
        // newly-chosen value column is no longer a dimension; the
        // old one becomes one), so a full refresh is the cleanest
        // path.
        el.querySelector('[data-agg-value-col]')?.addEventListener('change', (ev) => {
            ev.stopPropagation();
            this._registryValueCol = ev.target.value || null;
            // Drop any filter / group-by targeting the new value
            // column — those become invalid the moment the column
            // is repurposed.
            if (this._registryDimFilters) {
                delete this._registryDimFilters[this._registryValueCol];
            }
            if (this._registryGroupDims) {
                this._registryGroupDims.delete(this._registryValueCol);
            }
            this._refreshSelectedRegistry();
        });

        // Per-dimension filter inputs. Fire on `change` (not
        // `input`) so the user can type without firing a request
        // per keystroke; mode === blur or Enter commits.
        if (!this._registryDimFilters) this._registryDimFilters = {};
        el.querySelectorAll('[data-agg-filter]').forEach((inp) => {
            inp.addEventListener('change', (ev) => {
                ev.stopPropagation();
                const name = inp.getAttribute('data-agg-filter');
                const raw  = String(inp.value || '').trim();
                if (raw === '') {
                    delete this._registryDimFilters[name];
                } else {
                    this._registryDimFilters[name] = raw;
                }
                this._refreshSelectedRegistry();
            });
        });

        // Per-dimension group-by toggle chips. Adds/removes the
        // dim from `_registryGroupDims` and refetches — the
        // aggregation rows fan out into one row per (tick × dim).
        if (!this._registryGroupDims) this._registryGroupDims = new Set();
        el.querySelectorAll('[data-agg-group]').forEach((b) => {
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const name = b.getAttribute('data-agg-group');
                if (this._registryGroupDims.has(name)) {
                    this._registryGroupDims.delete(name);
                } else {
                    this._registryGroupDims.add(name);
                }
                this._refreshSelectedRegistry();
            });
        });
    }

    // ============================================================ Relations
    //
    // The relations graph is a read-only *viewer* over the project's
    // dependency edges (which archetype requires which sector / asset
    // kind / currency …) — it is NOT a graph database and does not
    // belong as a query category. It lives in its own tab and reuses
    // the self-contained `_renderBrowserGraph` renderer, pointed at the
    // tab's own host instead of the Registries rows pane.

    _paintRelationsTab(host) {
        this._relMode = this._relMode || 'relational';
        // Per-mode set of EXCLUDED entity types (right-panel filter).
        this._relExcluded = this._relExcluded
            || { relational: new Set(), contract: new Set() };
        const seg = (m, label) =>
            `<button type="button" class="ea-segmented__btn${this._relMode === m ? ' ea-segmented__btn--active' : ''}" data-mode="${m}">${label}</button>`;
        host.innerHTML = `
            <div class="ea-relations">
                <div class="ea-relations__canvas" data-role="relations-graph">
                    <div class="ea-table__empty">Loading…</div>
                </div>
                <aside class="ea-relations__panel">
                    <div class="ea-relations__label">Show</div>
                    <div class="ea-segmented" data-role="rel-mode">
                        ${seg('relational', 'Relational')}${seg('contract', 'Data contract')}
                    </div>
                    <div class="ea-relations__label">Entity types</div>
                    <div class="ea-relations__filters" data-role="rel-filters"></div>
                </aside>
            </div>`;
        host.querySelector('[data-role="rel-mode"]')
            ?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-mode]');
                if (!btn || btn.dataset.mode === this._relMode) return;
                this._relMode = btn.dataset.mode;
                host.querySelectorAll('[data-mode]').forEach((b) =>
                    b.classList.toggle('ea-segmented__btn--active',
                        b.dataset.mode === this._relMode));
                this._refreshRelations();
            });
        this._refreshRelations();
    }

    /** Render the entity-type checkbox filters in the right panel; toggling
     *  one excludes that type and re-renders. State per mode in
     *  `_relExcluded`. */
    _renderRelFilters(types, labelFn) {
        const host = this._host?.querySelector('[data-role="rel-filters"]');
        if (!host) return;
        const uniq = [...new Set(types.filter(Boolean))];
        const ex = this._relExcluded[this._relMode];
        host.innerHTML = uniq.map((t) => `
            <label class="ea-relations__filter">
                <input type="checkbox" data-rel-type="${esc(t)}" ${ex.has(t) ? '' : 'checked'}>
                <span>${esc(labelFn ? labelFn(t) : t)}</span>
            </label>`).join('') || '<span class="ea-relations__muted">—</span>';
        host.querySelectorAll('[data-rel-type]').forEach((cb) =>
            cb.addEventListener('change', () => {
                if (cb.checked) ex.delete(cb.dataset.relType);
                else ex.add(cb.dataset.relType);
                this._refreshRelations();
            }));
    }

    async _refreshRelations() {
        const target = this._host?.querySelector('[data-role="relations-graph"]');
        if (!target) return;
        try {
            if (this._relMode === 'contract') {
                // Data-contract relations: reads/writes/requires edges.
                const g = await window.pywebview?.api?.browser_rows?.(
                    'dependency_graph', 0, 2000, null, null);
                if (!g || (!g.nodes && !g.entries)) {
                    target.innerHTML = '<div class="ea-table__empty">No data-contract relations.</div>';
                    return;
                }
                this._renderRelFilters(
                    (g.nodes || []).map((n) => n.kind), (k) => k.replace(/_/g, ' '));
                const ex = this._relExcluded.contract;
                const nodes = (g.nodes || []).filter((n) => !ex.has(n.kind));
                const keep = new Set(nodes.map((n) => n.id));
                const entries = (g.entries || []).filter(
                    (e) => keep.has(e.from) && keep.has(e.to));
                this._renderBrowserGraph({ nodes, entries }, target);
            } else {
                // Relational relations: the FK ERD.
                const data = await window.pywebview?.api?.browser_erd?.();
                if (!data || !Array.isArray(data.tables) || !data.tables.length) {
                    target.innerHTML = '<div class="ea-table__empty">No relations — open a project to see its ERD.</div>';
                    return;
                }
                this._renderRelFilters(data.tables.map((t) => t.id), (id) => id);
                const ex = this._relExcluded.relational;
                const tables = data.tables.filter((t) => !ex.has(t.id));
                const keep = new Set(tables.map((t) => t.id));
                const edges = (data.edges || []).filter(
                    (e) => keep.has(e.from) && keep.has(e.to));
                this._renderERD({ tables, edges }, target);
            }
        } catch {
            target.innerHTML =
                '<div class="ea-table__empty">Could not load relations.</div>';
        }
    }

    /** Render an entity-relationship diagram: a table box per mirror
     *  (header + columns, FK columns marked "→ target") laid out in a
     *  flex-wrap grid, with FK edges drawn as Bezier curves on an SVG
     *  overlay. Edges are measured from the rendered box geometry, so a
     *  rAF pass runs after layout settles. */
    _renderERD(data, target) {
        const tables = data.tables || [];
        const edges  = data.edges  || [];
        this._erdEdges = edges;
        // Persisted (in-session) box positions; auto-grid for new tables.
        this._erdPos = this._erdPos || {};
        const COLW = 230, ROWH = 240, PERROW = 4, PAD = 16;
        tables.forEach((t, i) => {
            if (!this._erdPos[t.id]) {
                this._erdPos[t.id] = {
                    x: PAD + (i % PERROW) * COLW,
                    y: PAD + Math.floor(i / PERROW) * ROWH,
                };
            }
        });
        const boxes = tables.map((t) => {
            const p = this._erdPos[t.id];
            return `
            <div class="ea-erd__table" data-erd-table="${esc(t.id)}"
                 style="left:${p.x}px; top:${p.y}px;">
                <div class="ea-erd__th" data-erd-drag title="Drag to reposition">${esc(t.label || t.id)}</div>
                ${(t.columns || []).map((c) => `
                    <div class="ea-erd__col${c.ref ? ' ea-erd__col--fk' : ''}${c.pk ? ' ea-erd__col--pk' : ''}">
                        <span class="ea-erd__cn">${esc(c.name)}</span>
                        <span class="ea-erd__ct">${esc(c.ref ? '→ ' + c.ref : (c.type || ''))}</span>
                    </div>`).join('')}
            </div>`;
        }).join('');
        target.innerHTML = `
            <div class="ea-erd" data-role="erd-canvas">
                <svg class="ea-erd__edges" data-role="erd-edges" aria-hidden="true"></svg>
                <div class="ea-erd__boxes" data-role="erd-boxes">${boxes}</div>
            </div>`;
        this._wireERDDrag(target);
        requestAnimationFrame(() => this._drawERDEdges(target, edges));
    }

    /** Drag a table box by its header to reposition it; redraw edges live. */
    _wireERDDrag(target) {
        const canvas = target.querySelector('[data-role="erd-canvas"]');
        if (!canvas) return;
        let drag = null;
        canvas.querySelectorAll('[data-erd-drag]').forEach((h) => {
            h.addEventListener('pointerdown', (e) => {
                const box = h.closest('[data-erd-table]');
                if (!box) return;
                const tid = box.dataset.erdTable;
                const p = this._erdPos[tid] || { x: 0, y: 0 };
                drag = { tid, box, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
                h.setPointerCapture?.(e.pointerId);
                box.classList.add('ea-erd__table--dragging');
                e.preventDefault();
            });
            h.addEventListener('pointermove', (e) => {
                if (!drag) return;
                const x = Math.max(0, drag.ox + (e.clientX - drag.sx));
                const y = Math.max(0, drag.oy + (e.clientY - drag.sy));
                this._erdPos[drag.tid] = { x, y };
                drag.box.style.left = `${x}px`;
                drag.box.style.top  = `${y}px`;
                this._drawERDEdges(target, this._erdEdges || []);
            });
            const end = () => {
                if (drag) drag.box.classList.remove('ea-erd__table--dragging');
                drag = null;
            };
            h.addEventListener('pointerup', end);
            h.addEventListener('pointercancel', end);
        });
    }

    _drawERDEdges(target, edges) {
        const canvas = target.querySelector('[data-role="erd-canvas"]');
        const svg = target.querySelector('[data-role="erd-edges"]');
        if (!canvas || !svg) return;
        const W = canvas.scrollWidth, H = canvas.scrollHeight;
        svg.setAttribute('width', W);
        svg.setAttribute('height', H);
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const crect = canvas.getBoundingClientRect();
        const esc2 = (s) => (window.CSS?.escape ?? ((x) => x))(s);
        const rectOf = (tid) => {
            const el = canvas.querySelector(`[data-erd-table="${esc2(tid)}"]`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const x = r.left - crect.left + canvas.scrollLeft;
            const y = r.top  - crect.top  + canvas.scrollTop;
            return { cx: x + r.width / 2, cy: y + r.height / 2,
                     hw: r.width / 2, hh: r.height / 2 };
        };
        // Point where the line from rect's centre toward `to` exits rect.
        const border = (rect, to) => {
            const dx = to.cx - rect.cx, dy = to.cy - rect.cy;
            if (!dx && !dy) return { x: rect.cx, y: rect.cy };
            const s = Math.min(dx ? rect.hw / Math.abs(dx) : Infinity,
                               dy ? rect.hh / Math.abs(dy) : Infinity);
            return { x: rect.cx + dx * s, y: rect.cy + dy * s };
        };
        const parts = [];
        for (const e of edges) {
            const ra = rectOf(e.from), rb = rectOf(e.to);
            if (!ra || !rb) continue;
            const a = border(ra, rb);   // leaves the "many" table (FK side)
            const b = border(rb, ra);   // enters the "one" table  (PK side)
            const mx = (a.x + b.x) / 2;
            parts.push(
                `<path d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}" `
                + `class="ea-erd__edge" />`);
            // Cardinality — a FK is many→one: N at the source, 1 at target.
            parts.push(`<text x="${a.x}" y="${a.y}" dx="5" dy="-4" class="ea-erd__card">N</text>`);
            parts.push(`<text x="${b.x}" y="${b.y}" dx="5" dy="-4" class="ea-erd__card">1</text>`);
        }
        svg.innerHTML = parts.join('');
    }

    /** Render a graph source as an SVG node-link diagram. Circular
     *  layout — nodes equally spaced on a circle; edges drawn as
     *  Bezier curves arcing through (but not crossing) the center.
     *  Hovering a node highlights its incident edges + connected
     *  peers; click a node to filter the picker scope to that node's
     *  ego network. Renders into `target` (defaults to the Registries
     *  rows pane for back-compat; the Relations tab passes its own). */
    _renderBrowserGraph(state, target) {
        target = target || this._host?.querySelector('[data-role="reg-rows"]');
        if (!target) return;
        const nodesAll = Array.isArray(state.nodes)   ? state.nodes   : [];
        const edgesAll = Array.isArray(state.entries) ? state.entries : [];

        if (nodesAll.length === 0) {
            target.innerHTML = '<div class="ea-table__empty">No graph nodes.</div>';
            return;
        }

        // ── persistent per-render state ────────────────────────────
        const gs = (this._graphState = this._graphState || {
            kinds:    new Set(['bus_topic', 'registry', 'param', 'brain_key']),
            search:   '',
            selected: null,
        });
        const nodeById = new Map(nodesAll.map((n) => [n.id, n]));

        // Index every edge by its via_kind so the kind filter can be
        // applied without re-walking. The graph data source switched
        // from writes-reads matching to `requires` edges; the new
        // shape uses `via` (== to_kind) while the old shape used
        // `via_kind`. Honor either so a stale browser cache or a
        // partial deploy doesn't break the view.
        const allEdges = edgesAll.map((e, i) => ({
            ...e,
            _idx: i,
            via_kind: e.via_kind || e.via || '',
            via_key:  e.via_key  || e.to  || '',
        }));
        const kindsPresent = Array.from(new Set(allEdges
            .map((e) => e.via_kind).filter(Boolean))).sort();
        // Clean the filter set so toggling never gets out of sync
        // with a graph that's missing kinds we used to support.
        for (const k of Array.from(gs.kinds)) {
            if (!kindsPresent.includes(k)) gs.kinds.delete(k);
        }
        for (const k of kindsPresent) {
            if (!gs.kinds.has(k) && !this._graphKindsTouched) gs.kinds.add(k);
        }

        // ── filter pipeline ────────────────────────────────────────
        const kindOk = (k) => gs.kinds.has(k);
        const edgesK = allEdges.filter((e) => kindOk(e.via_kind || ''));
        // Search applies as ego-network restriction. Match by id
        // contains (case-insensitive); empty string = all nodes.
        const q = gs.search.trim().toLowerCase();
        let visibleNodeIds;
        if (q === '') {
            visibleNodeIds = new Set(nodesAll.map((n) => n.id));
        } else {
            const hits = nodesAll.filter((n) =>
                (n.id || '').toLowerCase().includes(q)
                || (n.label || '').toLowerCase().includes(q));
            const ego = new Set();
            for (const h of hits) {
                ego.add(h.id);
                for (const e of edgesK) {
                    if (e.from === h.id) ego.add(e.to);
                    if (e.to   === h.id) ego.add(e.from);
                }
            }
            visibleNodeIds = ego;
        }
        const visibleEdges = edgesK.filter((e) =>
            visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
        const visibleNodes = nodesAll.filter((n) => visibleNodeIds.has(n.id));

        // ── adjacency for hover + neighbor lookups ────────────────
        const neighbors = new Map();
        visibleEdges.forEach((e) => {
            if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
            if (!neighbors.has(e.to))   neighbors.set(e.to,   new Set());
            neighbors.get(e.from).add(e.to);
            neighbors.get(e.to).add(e.from);
        });

        // ── layout — circular, ordered by degree so well-connected
        //    nodes cluster on one side. Cheap heuristic that surfaces
        //    structure without a force simulation.
        const degree = new Map(visibleNodes.map((n) =>
            [n.id, (neighbors.get(n.id) || new Set()).size]));
        const ordered = [...visibleNodes].sort((a, b) =>
            (degree.get(b.id) - degree.get(a.id))
            || a.id.localeCompare(b.id));
        const N = ordered.length;
        const pos = new Map();
        for (let i = 0; i < N; i++) {
            const angle = N === 0 ? 0 : (i / N) * Math.PI * 2 - Math.PI / 2;
            pos.set(ordered[i].id, { angle, idx: i });
        }

        // ── palette ────────────────────────────────────────────────
        const kindColor = {
            // Legacy data-flow kinds (still honored when present so an
            // older render still has color).
            bus_topic:        '#1177b3',
            registry:         '#d7ba7d',
            param:            '#7f9f7f',
            brain_key:        '#b07faf',
            // Current `requires` kinds — pivoted 2026-05-29.
            archetype:        '#1177b3',  // accent — the from side
            sector:           '#d7ba7d',
            asset_kind:       '#7f9f7f',
            market_archetype: '#b07faf',
            currency:         '#e08e7a',
            country:          '#5fb5b8',
        };
        const edgeColor = (k) => kindColor[k] || '#666';
        const nodeColor = (k) => kindColor[k] || '#1177b3';

        // ── SVG geometry ───────────────────────────────────────────
        const W = 1000, H = 560;
        const cx = W / 2, cy = H / 2;
        const r  = Math.min(W, H) * 0.34;
        const nodeXY = (id) => {
            const p = pos.get(id);
            if (!p) return null;
            return [cx + r * Math.cos(p.angle), cy + r * Math.sin(p.angle)];
        };

        // Arrowhead — share one marker per kind via SVG defs so the
        // arrow tip inherits the edge color.
        const defs = `
            <defs>
                ${kindsPresent.map((k) => `
                    <marker id="ea-bp-graph-arrow-${esc(k)}"
                            viewBox="0 0 10 10" refX="9" refY="5"
                            markerWidth="6" markerHeight="6"
                            orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="${edgeColor(k)}"/>
                    </marker>
                `).join('')}
            </defs>
        `;

        // Edges — quadratic curve pulled toward center; arrow at the
        // `to` endpoint; thin label appears only when the selected
        // node is one of the endpoints. Arrow-aware path shortening
        // keeps the tip from clipping under the destination node.
        const NODE_R = 6;
        const ARROW_PAD = 4;
        const sel = gs.selected;
        const showLabel = (e) =>
            sel && (e.from === sel || e.to === sel);
        const edgeSvg = visibleEdges.map((e) => {
            const a = nodeXY(e.from), b = nodeXY(e.to);
            if (!a || !b) return '';
            // Trim the path's tail by NODE_R + arrow padding so the
            // arrowhead sits on the node's edge, not its center.
            const dxAB = b[0] - a[0], dyAB = b[1] - a[1];
            const dAB  = Math.hypot(dxAB, dyAB) || 1;
            const trim = NODE_R + ARROW_PAD;
            const bx = b[0] - (dxAB / dAB) * trim;
            const by = b[1] - (dyAB / dAB) * trim;
            const ax = a[0] + (dxAB / dAB) * NODE_R;
            const ay = a[1] + (dyAB / dAB) * NODE_R;
            // Quadratic control point pulled toward center.
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            const k  = 0.30;
            const qx = mx + (cx - mx) * k, qy = my + (cy - my) * k;
            const col = edgeColor(e.via_kind);
            const labelHtml = showLabel(e) ? `
                <text class="ea-bp-browser__graph-edge-label"
                      x="${qx}" y="${qy - 4}"
                      text-anchor="middle"
                      fill="${col}">${esc(e.via_key || '')}</text>
            ` : '';
            return `
                <path d="M ${ax} ${ay} Q ${qx} ${qy} ${bx} ${by}"
                      fill="none" stroke="${col}" stroke-width="1.4"
                      stroke-opacity="0.55"
                      marker-end="url(#ea-bp-graph-arrow-${esc(e.via_kind || 'unknown')})"
                      data-edge-from="${esc(e.from)}"
                      data-edge-to="${esc(e.to)}"
                      data-edge-kind="${esc(e.via_kind || '')}"
                      class="ea-bp-browser__graph-edge">
                    <title>${esc(e.from)} → ${esc(e.to)}\n${esc(e.via_kind || '')} : ${esc(e.via_key || '')}</title>
                </path>
                ${labelHtml}
            `;
        }).join('');

        // Nodes — circles + outside-the-ring labels. Selected node
        // gets a halo; dimmed ones (no incident edges in the visible
        // edge set) lose their accent fill.
        const visibleEdgeNodeIds = new Set();
        visibleEdges.forEach((e) => {
            visibleEdgeNodeIds.add(e.from);
            visibleEdgeNodeIds.add(e.to);
        });
        const nodeSvg = ordered.map((n) => {
            const xy = nodeXY(n.id);
            if (!xy) return '';
            const [x, y] = xy;
            const angle = pos.get(n.id).angle;
            const lx = cx + (r + 18) * Math.cos(angle);
            const ly = cy + (r + 18) * Math.sin(angle);
            const anchor = Math.cos(angle) > 0.1
                ? 'start'
                : Math.cos(angle) < -0.1 ? 'end' : 'middle';
            const isolated = !visibleEdgeNodeIds.has(n.id);
            const isSelected = n.id === sel;
            const nodeFill  = nodeColor(n.kind || 'archetype');
            const cls = [
                'ea-bp-browser__graph-node',
                `ea-bp-browser__graph-node--${esc(n.kind || 'archetype')}`,
                isolated   ? 'ea-bp-browser__graph-node--dim' : '',
                isSelected ? 'is-selected' : '',
            ].filter(Boolean).join(' ');
            const kindLabel = n.kind && n.kind !== 'archetype' ? ` · ${n.kind}` : '';
            const tip = isolated
                ? `${n.label || n.id} — no incident edges (after current filters).`
                : `${n.label || n.id} (${n.id})${kindLabel} · ${degree.get(n.id) || 0} connection${(degree.get(n.id) || 0) === 1 ? '' : 's'}`;
            return `
                <g class="${cls}" data-node-id="${esc(n.id)}"
                   style="--node-color:${nodeFill}">
                    <circle cx="${x}" cy="${y}" r="${NODE_R}"></circle>
                    <text x="${lx}" y="${ly}"
                          text-anchor="${anchor}"
                          dominant-baseline="middle">${esc(n.label || n.id)}</text>
                    <title>${esc(tip)}</title>
                </g>
            `;
        }).join('');

        // ── chrome: top toolbar (search + edge-kind filters) +
        //    inspector panel (right) + status ─────────────────────
        const filterChips = kindsPresent.map((k) => `
            <button type="button" class="ea-bp-browser__graph-chip ${gs.kinds.has(k) ? 'is-active' : ''}"
                    data-kind="${esc(k)}" title="Toggle ${esc(k)} edges"
                    style="--chip-color:${edgeColor(k)}">
                <span class="ea-bp-browser__graph-swatch"
                      style="background:${edgeColor(k)}"></span>
                ${esc(k)}
            </button>
        `).join('');

        const inspectorHtml = sel
            ? this._renderGraphInspector(nodeById.get(sel), neighbors)
            : `<div class="ea-bp-browser__graph-inspect-empty">
                 <span class="material-symbols-outlined">touch_app</span>
                 <p>Click a node to see what it reads, writes, and requires.</p>
                 <p class="ea-bp-browser__graph-inspect-meta">
                   ${ordered.length} node${ordered.length === 1 ? '' : 's'} · ${visibleEdges.length} edge${visibleEdges.length === 1 ? '' : 's'} shown
                 </p>
               </div>`;

        target.innerHTML = `
            <div class="ea-bp-browser__graph">
                <header class="ea-bp-browser__graph-toolbar">
                    <input type="search" class="ea-bp-browser__graph-search"
                           placeholder="Focus a node (esc to clear)"
                           data-role="graph-search"
                           value="${esc(gs.search)}">
                    <div class="ea-bp-browser__graph-chips">
                        ${filterChips || '<span class="ea-bp-browser__graph-meta">No edges in this graph.</span>'}
                    </div>
                </header>
                <div class="ea-bp-browser__graph-stage">
                    <svg viewBox="0 0 ${W} ${H}"
                         preserveAspectRatio="xMidYMid meet"
                         class="ea-bp-browser__graph-svg${sel ? ' is-focused' : ''}">
                        ${defs}
                        <g class="ea-bp-browser__graph-edges">${edgeSvg}</g>
                        <g class="ea-bp-browser__graph-nodes">${nodeSvg}</g>
                    </svg>
                    <aside class="ea-bp-browser__graph-inspect"
                           data-role="graph-inspect">${inspectorHtml}</aside>
                </div>
            </div>
        `;

        // ── interactions ───────────────────────────────────────────
        const svg = target.querySelector('svg');
        const rerender = () => this._renderBrowserGraph(state, target);
        // Search input — Esc clears + restores all nodes.
        const searchEl = target.querySelector('[data-role="graph-search"]');
        searchEl?.addEventListener('input', () => {
            gs.search = searchEl.value;
            rerender();
            // Refocus the input across the re-render.
            this._host?.querySelector('[data-role="graph-search"]')?.focus();
        });
        searchEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && searchEl.value !== '') {
                e.preventDefault();
                gs.search = '';
                rerender();
                this._host?.querySelector('[data-role="graph-search"]')?.focus();
            }
        });
        // Edge-kind toggles.
        target.querySelectorAll('[data-kind]').forEach((chip) => {
            chip.addEventListener('click', () => {
                this._graphKindsTouched = true;
                const k = chip.dataset.kind;
                if (gs.kinds.has(k)) gs.kinds.delete(k);
                else gs.kinds.add(k);
                rerender();
            });
        });
        // Node click → select + show inspector. Click empty SVG to
        // clear selection.
        svg?.querySelectorAll('[data-node-id]').forEach((g) => {
            const id = g.getAttribute('data-node-id');
            g.addEventListener('mouseenter', () => {
                if (gs.selected) return;  // selected highlight takes precedence
                svg.classList.add('is-hover');
                _markHighlight(svg, id, neighbors);
            });
            g.addEventListener('mouseleave', () => {
                if (gs.selected) return;
                svg.classList.remove('is-hover');
                _clearHighlight(svg);
            });
            g.addEventListener('click', (ev) => {
                ev.stopPropagation();
                gs.selected = (gs.selected === id) ? null : id;
                rerender();
            });
        });
        svg?.addEventListener('click', (ev) => {
            if (ev.target === svg || ev.target.tagName === 'g') {
                if (gs.selected) {
                    gs.selected = null;
                    rerender();
                }
            }
        });
        // Inspector links — click an edge entry to navigate.
        target.querySelectorAll('[data-inspect-action]').forEach((el) => {
            el.addEventListener('click', () => {
                const action = el.dataset.inspectAction;
                if (action === 'select-peer') {
                    gs.selected = el.dataset.peer || null;
                    rerender();
                } else if (action === 'go-source') {
                    this._navigateToRef(el.dataset.source, el.dataset.value);
                } else if (action === 'clear') {
                    gs.selected = null;
                    rerender();
                }
            });
        });

        // After re-render with a selection, highlight in the SVG too.
        if (gs.selected && svg) {
            svg.classList.add('is-focused');
            _markHighlight(svg, gs.selected, neighbors);
        }
    }

    /** Build the per-node inspector body. Lists reads / writes /
     *  requires grouped by kind; each entry click-targets the
     *  corresponding source (registry, bus, archetype). */
    _renderGraphInspector(node, neighbors) {
        if (!node) return '<div class="ea-bp-browser__graph-inspect-empty">Unknown node.</div>';
        const group = (edges) => {
            const m = new Map();
            for (const e of edges || []) {
                const k = e.kind || 'other';
                if (!m.has(k)) m.set(k, []);
                m.get(k).push(e.key);
            }
            return m;
        };
        const renderGroup = (title, edges, role) => {
            const m = group(edges);
            if (m.size === 0) {
                return `
                    <section class="ea-bp-browser__graph-inspect-section">
                        <header>${esc(title)}</header>
                        <div class="ea-bp-browser__graph-inspect-empty-row">—</div>
                    </section>`;
            }
            let body = '';
            for (const [k, keys] of m) {
                // Pick the drill target by (kind, role):
                //   reads/writes registry X   → registry:X  (TypedTable)
                //   reads/writes bus_topic X  → no source today (could
                //                                pre-filter the Bus tab — later)
                //   reads/writes brain_key X  → no source (intra-agent)
                //   requires <ent_kind>=<id>  → that entity's source
                const drill = (key) => {
                    if (role === 'requires') {
                        const s = _GRAPH_REQ_SOURCE[k];
                        return s ? { source: s, value: key } : null;
                    }
                    if (k === 'registry') {
                        return { source: `registry:${key}`, value: '' };
                    }
                    return null;
                };
                body += `
                    <div class="ea-bp-browser__graph-inspect-kind">
                        <span class="ea-bp-browser__graph-inspect-kind-name">${esc(k)}</span>
                        <span class="ea-bp-browser__graph-inspect-kind-chip">${keys.length}</span>
                    </div>
                    <ul class="ea-bp-browser__graph-inspect-list">
                        ${keys.map((key) => {
                            const d = drill(key);
                            if (d) {
                                return `<li><button type="button"
                                    data-inspect-action="go-source"
                                    data-source="${esc(d.source)}"
                                    data-value="${esc(d.value)}">
                                    ${esc(key)}
                                </button></li>`;
                            }
                            return `<li><span>${esc(key)}</span></li>`;
                        }).join('')}
                    </ul>`;
            }
            return `
                <section class="ea-bp-browser__graph-inspect-section">
                    <header>${esc(title)}</header>
                    ${body}
                </section>`;
        };

        // Neighbor list — its meaning depends on the node's kind.
        // For an archetype, peers are the entities it `requires`.
        // For a non-archetype entity, peers are the archetypes that
        // require it — flip the section title so the user reads the
        // right semantic.
        const isArchetype = (node.kind || 'archetype') === 'archetype';
        const peersTitle  = isArchetype ? 'Requires' : 'Required by';
        const peers = Array.from(neighbors.get(node.id) || []).sort();
        const peersEmptyMsg = isArchetype
            ? 'No declared requires (after current filters).'
            : 'Not required by any archetype (after current filters).';
        const peersHtml = peers.length === 0
            ? `<div class="ea-bp-browser__graph-inspect-empty-row">${esc(peersEmptyMsg)}</div>`
            : `<ul class="ea-bp-browser__graph-inspect-list ea-bp-browser__graph-inspect-list--peers">
                 ${peers.map((p) => `
                    <li><button type="button"
                        data-inspect-action="select-peer"
                        data-peer="${esc(p)}">
                        <span class="material-symbols-outlined">arrow_forward</span>
                        ${esc(p)}
                    </button></li>`).join('')}
               </ul>`;

        const subtitle = (node.kind && node.kind !== 'archetype')
            ? `<span class="ea-bp-browser__graph-inspect-kindtag">${esc(node.kind)}</span>`
            : '';

        return `
            <div class="ea-bp-browser__graph-inspect-head">
                <div class="ea-bp-browser__graph-inspect-title">
                    ${esc(node.label || node.id)}
                    ${subtitle}
                </div>
                <div class="ea-bp-browser__graph-inspect-id">${esc(node.id)}</div>
                <button type="button" class="ea-bp-browser__graph-inspect-clear"
                        data-inspect-action="clear" title="Clear selection (Esc)">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="ea-bp-browser__graph-inspect-body">
                <section class="ea-bp-browser__graph-inspect-section">
                    <header>${esc(peersTitle)}</header>
                    ${peersHtml}
                </section>
            </div>
        `;
    }

    /** Run a search across every source in the active category and
     *  render a faceted result list. Called when the search-across
     *  toggle is on; debounced re-trigger lives in the filter input
     *  handler. */
    async _runSearchAcross() {
        const target = this._host?.querySelector('[data-role="reg-rows"]');
        if (!target) return;
        const q = String(this._registryFilter || '').trim();
        const cat = this._browserCategory || 'relational';
        if (q.length < 2) {
            target.innerHTML = `<div class="ea-table__empty">`
                + `Type at least 2 characters to search across <code>${esc(cat)}</code>.`
                + `</div>`;
            return;
        }
        target.innerHTML = `<div class="ea-table__empty">Searching…</div>`;
        let res = null;
        try {
            res = await window.pywebview?.api?.browser_search_across?.(
                cat, q, 50);
        } catch { /* ignore */ }
        if (!res || res.ok === false) {
            target.innerHTML = `<div class="ea-table__empty">Search failed.</div>`;
            return;
        }
        const facets = res.facets || [];
        if (facets.length === 0) {
            target.innerHTML = `<div class="ea-table__empty">`
                + `No matches for <code>${esc(q)}</code> in ${esc(cat)} sources.`
                + `</div>`;
            return;
        }
        const total = res.total_hits || 0;
        target.innerHTML = `
            <div class="ea-bp-browser__search-across">
                <header class="ea-bp-browser__search-across-head">
                    <span class="material-symbols-outlined">travel_explore</span>
                    <span>${total} hit${total === 1 ? '' : 's'} across ${facets.length} source${facets.length === 1 ? '' : 's'}
                          for <code>${esc(q)}</code></span>
                </header>
                <ul class="ea-bp-browser__search-facets">
                    ${facets.map((f) => this._renderSearchFacet(f, q)).join('')}
                </ul>
            </div>
        `;
        // Wire facet expand + row drill.
        target.querySelectorAll('[data-search-source]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                // Allow clicking inside the table without re-toggling
                // the details element (so internal row buttons work).
                if (ev.target.closest('table')) return;
                const sid = el.dataset.searchSource;
                this._searchAcrossOn = false;
                this._host?.querySelector(
                    '[data-role="reg-filter-search-across"]')
                    ?.classList.remove('is-active');
                this._navigateToRef(sid, '');  // switch source, keep filter
            });
        });
    }

    _renderSearchFacet(f, q) {
        const cols = (f.columns || []).slice(0, 4);
        const colNames = cols.map((c) => c.name);
        const trunc = f.truncated ? ` (top ${f.rows.length})` : '';
        const sample = f.rows.slice(0, 5).map((r) => `
            <tr class="ea-bus-row">
                <td class="ea-table__cell"><code>${esc(r.id || '')}</code></td>
                ${colNames.map((n) =>
                    `<td><code class="ea-bus__payload">${esc(_highlight(String(r[n] ?? ''), q))}</code></td>`
                ).join('')}
            </tr>
        `).join('');
        return `
            <li class="ea-bp-browser__search-facet">
                <div class="ea-bp-browser__search-facet-head"
                     data-search-source="${esc(f.source_id)}">
                    <span class="ea-bp-browser__search-facet-label">${esc(f.label)}</span>
                    <span class="ea-bp-browser__search-facet-count">${f.total}${trunc}</span>
                    <span class="material-symbols-outlined">arrow_forward</span>
                </div>
                <table class="ea-table ea-bus-table ea-bp-browser__search-facet-table">
                    <thead><tr>
                        <th class="ea-table__cell">_id</th>
                        ${colNames.map((n) => `<th>${esc(n)}</th>`).join('')}
                    </tr></thead>
                    <tbody>${sample}</tbody>
                </table>
            </li>
        `;
    }

    /** Fetch a document's body and swap the rows pane to a viewer. */
    /** [+ New entity] menu — pops a kind picker, then opens the
     *  matching creation dialog inline so the user doesn't leave the
     *  Registries tab.
     *
     *  Each kind has a small per-kind form whose fields + submit
     *  endpoint mirror the canonical landing's "+ New X" action.
     *  Centralising every form here means there are two places these
     *  flows live (landing + bottom-panel). Worth lifting into a shared
     *  module if a third surface picks them up. */
    _openNewEntityMenu(ev) {
        const btn = ev?.currentTarget;
        const r = btn?.getBoundingClientRect();
        const x = r ? r.left : (ev?.clientX || 0);
        const y = r ? r.bottom + 2 : (ev?.clientY || 0);
        const items = [
            { label: 'Sector',              icon: 'account_balance', action: 'sector' },
            { label: 'Asset',               icon: 'category',        action: 'asset_kind' },
            { label: 'Agent archetype',     icon: 'group',           action: 'archetype' },
            { label: 'Market',              icon: 'storefront',      action: 'market-archetype' },
            { label: 'Scenario',            icon: 'science',         action: 'scenario' },
            { label: 'Dashboard',           icon: 'monitoring',      action: 'dashboard' },
            { label: 'KPI',                 icon: 'analytics',       action: 'kpi' },
        ];
        showContextMenu(x, y, items, (kind) => {
            if (!kind) return;
            this._createEntity(kind).catch((err) => {
                console.warn('[bp] create entity failed', kind, err);
                toastError?.('New entity', String(err?.message || err));
            });
        });
    }

    /** Dispatch into the shared `entity_create_forms` module — every
     *  surface that creates entities (landings + this bottom panel)
     *  goes through the same per-kind form so a field change lands
     *  in one place. */
    async _createEntity(kind) {
        const api = window.pywebview?.api;
        if (!api) return;
        const opts = { api, eventBus: this.eventBus };
        let created = null;
        switch (kind) {
            case 'sector':           created = await openCreateSectorForm(opts);            break;
            case 'asset_kind':       created = await openCreateAssetForm(opts);         break;
            case 'archetype':        created = await openCreateArchetypeForm(opts);         break;
            case 'market-archetype': created = await openCreateMarketArchetypeForm(opts);   break;
            case 'scenario':         created = await openCreateScenarioForm(opts);          break;
            case 'dashboard':        created = await openCreateDashboardForm(opts);         break;
            case 'kpi':              created = await openCreateKpiForm(opts);               break;
        }
        if (created) {
            // Re-render the picker so the new entity shows up. The
            // `project:changed` bus event already fanned out to landings,
            // sidebars, palette etc.
            await this._refreshRegistries();
        }
    }

    async _openNewSchemaForm() {
        const schema = await openSchemaForm({ mode: 'new' });
        if (!schema) return;
        // DB-refactor Phase 1 exit: route New-schema through the new
        // Tables backend (`table_create`) instead of the legacy
        // `browser_source_create` (which wrote a TypedTable registry
        // JSON). Both still exist; the new path is the canonical one.
        let res = null;
        try {
            res = await window.pywebview?.api?.table_create?.(schema);
        } catch (err) {
            toastError?.('New schema', String(err?.message || err));
            return;
        }
        if (!res || res.ok === false) {
            toastError?.('New schema', res?.error || 'create failed');
            return;
        }
        toastInfo?.('New schema', `Created ${res.id}`);
        // Refresh + auto-select the new table so the user lands on it.
        // The bottom-panel browser uses the `table:<id>` source-id
        // convention (added to browser_sources_list).
        this._activeRegistryId = `table:${res.id}`;
        const cols = Array.isArray(schema.columns) ? schema.columns : [];
        const isTs = cols.some((c) => c?.name === 'tick');
        this._browserCategory  = isTs ? 'time_series' : 'relational';
        await this._refreshRegistries();
    }

    /** Edit-schema flow — only meaningful for TypedTable registry
     *  sources whose JSON file we directly own. Loads the current
     *  schema, opens the structured editor prefilled, writes back via
     *  `browser_schema_write` on submit. */
    async _openEditSchemaForm() {
        const sid = this._activeRegistryId;
        if (!sid) return;
        const isReg   = sid.startsWith('registry:');
        const isTable = sid.startsWith('table:');
        if (!isReg && !isTable) return;
        const api   = window.pywebview?.api;
        const inner = isReg ? sid.slice('registry:'.length) : sid.slice('table:'.length);
        let spec = null;
        try {
            spec = isReg ? await api?.world_registry_schema?.(inner)
                         : await api?.table_get?.(inner);
        } catch { /* ignore */ }
        if (!spec || !spec.id) {
            toastError?.('Edit schema', `Couldn't load ${inner}`);
            return;
        }
        const original = Array.isArray(spec.columns) ? spec.columns.map((c) => ({ ...c })) : [];
        const edited = await openSchemaForm({ mode: 'edit', spec });
        if (!edited) return;
        const strip = (cols) => (cols || []).map(({ _orig, ...rest }) => rest);

        // Registries: rewrite the whole schema spec (the existing path).
        if (isReg) {
            const schema = { ...edited, id: inner, columns: strip(edited.columns) };
            let res = null;
            try { res = await api?.browser_schema_write?.(sid, schema); }
            catch (err) { toastError?.('Edit schema', String(err?.message || err)); return; }
            if (!res || res.ok === false) {
                toastError?.('Edit schema', res?.error || 'save failed');
                return;
            }
            toastInfo?.('Edit schema', `Saved ${res.id}`);
            await this._refreshRegistries();
            return;
        }

        // Tables: apply a column diff via table_alter (add / drop / rename
        // / retype / reorder) so existing rows are migrated, not dropped.
        const ops = this._diffColumnsToOps(original, edited.columns || []);
        if (!ops.length) { toastInfo?.('Edit schema', 'No changes'); return; }
        for (const { op, args } of ops) {
            let res = null;
            try { res = await api?.table_alter?.(inner, op, args); }
            catch (err) {
                toastError?.('Edit schema', String(err?.message || err));
                await this._refreshRegistries();
                return;
            }
            if (res && res.ok === false) {
                toastError?.('Edit schema', res.error || `${op} failed`);
                await this._refreshRegistries();
                return;
            }
        }
        toastInfo?.('Edit schema', `Updated ${inner}`);
        await this._refreshRegistries();
    }

    /** Diff original vs edited columns into ordered table_alter ops. Uses
     *  the form's `_orig` (original column name) to distinguish a rename
     *  from a drop+add. Order: rename → drop → add → retype → reorder. */
    _diffColumnsToOps(original, edited) {
        const ops = [];
        const origByName = new Map(original.map((c) => [c.name, c]));
        const ed = (edited || []).map((c) => ({
            name: c.name, type: c.type, nullable: !!c.nullable,
            default: c.default, orig: c._orig || null,
        }));
        for (const c of ed) {
            if (c.orig && c.orig !== c.name) {
                ops.push({ op: 'rename_column', args: { old: c.orig, new: c.name } });
            }
        }
        const kept = new Set(ed.filter((c) => c.orig).map((c) => c.orig));
        for (const c of original) {
            if (!kept.has(c.name)) ops.push({ op: 'drop_column', args: { name: c.name } });
        }
        for (const c of ed) {
            if (!c.orig) {
                const column = { name: c.name, type: c.type, nullable: c.nullable };
                if (c.default != null) column.default = c.default;
                ops.push({ op: 'add_column', args: { column } });
            }
        }
        for (const c of ed) {
            if (c.orig) {
                const o = origByName.get(c.orig);
                if (o && o.type !== c.type) {
                    ops.push({ op: 'retype_column', args: { name: c.name, type: c.type } });
                }
            }
        }
        ops.push({ op: 'reorder_columns', args: { order: ed.map((c) => c.name) } });
        return ops;
    }

    /** Navigate to a cross-source ref. Switches the active source
     *  (changing category if needed) and seeds the filter to find the
     *  target row. */
    _navigateToRef(source_id, value) {
        if (!source_id) return;
        const sources = this._registriesState?.sources || [];
        const target  = sources.find((s) => s.id === source_id);
        if (!target) {
            // Source unknown — likely a ref to a kind we don't have an
            // adapter for yet. No-op until B-phase grows that source.
            return;
        }
        // Switch category if needed.
        const cat = target.category || 'relational';
        if (this._browserCategory !== cat) {
            this._browserCategory = cat;
            const catsEl = this._host?.querySelector('[data-role="browser-cats"]');
            catsEl?.querySelectorAll('[data-cat]').forEach((b) =>
                b.classList.toggle('ea-segmented__btn--active',
                    b.dataset.cat === cat));
        }
        this._activeRegistryId = source_id;
        // Seed the scope+filter to the target value so the user lands
        // looking at exactly the row they clicked through to.
        this._registryFilter      = String(value || '').toLowerCase();
        this._registryFilterScope = 'all';
        const fEl = this._host?.querySelector('[data-role="reg-filter"]');
        const sEl = this._host?.querySelector('[data-role="reg-filter-scope"]');
        if (fEl) fEl.value = value || '';
        if (sEl) sEl.value = 'all';
        this._renderRegistriesShell();
        this._refreshSelectedRegistry();
        this._saveBpState();
    }

    // ============================================ Python-expression completions
    //
    // The standalone Query REPL was retired (M5) in favour of the
    // in-browser query console (`_renderBrowserQuery`). These completion
    // helpers survive because the Watch tab reuses them — same vocabulary
    // (`shell_eval` safe-globals: sectors / archetypes / markets / kpis…),
    // Python autocomplete over the project's named identifiers.

    async _loadQueryCompletionSources() {
        if (this._queryCompletionLoadedAt &&
            (Date.now() - this._queryCompletionLoadedAt) < 30_000) {
            return;
        }
        const api = window.pywebview?.api;
        try {
            const [
                kinds, archs, mkts, sectors, kpis, countries,
                agents, registries, scopeKeys,
            ] = await Promise.all([
                api?.assets_list?.()         ?? [],
                api?.agents_list?.()          ?? [],
                api?.market_instances_list?.()             ?? [],
                api?.sectors_list?.()             ?? [],
                api?.kpis_list?.()                ?? [],
                api?.countries_list?.()           ?? [],
                api?.agent_instances_list?.()              ?? [],
                api?.world_registries_list?.()    ?? { registries: [] },
                api?.shell_eval_scope_keys?.()    ?? [],
            ]);
            this._queryAssets = Array.isArray(kinds)    ? kinds    : [];
            this._queryArchetypes = Array.isArray(archs)    ? archs    : [];
            this._queryMarkets    = Array.isArray(mkts)     ? mkts     : [];
            this._querySectors    = Array.isArray(sectors)  ? sectors  : [];
            this._queryKpis       = Array.isArray(kpis)     ? kpis     : [];
            this._queryCountries  = Array.isArray(countries) ? countries : [];
            this._queryAgents     = Array.isArray(agents)   ? agents   : [];
            this._queryRegistries = Array.isArray(registries?.registries)
                ? registries.registries : [];
            this._queryScopeKeys  = Array.isArray(scopeKeys) ? scopeKeys : [];
        } catch (err) {
            this.log.warn?.('query: completion sources load failed', { err });
            this._queryAssets = this._queryAssets || [];
            this._queryArchetypes = this._queryArchetypes || [];
            this._queryMarkets    = this._queryMarkets    || [];
            this._querySectors    = this._querySectors    || [];
            this._queryKpis       = this._queryKpis       || [];
            this._queryCountries  = this._queryCountries  || [];
            this._queryAgents     = this._queryAgents     || [];
            this._queryRegistries = this._queryRegistries || [];
            this._queryScopeKeys  = this._queryScopeKeys  || [];
        }
        this._queryCompletionLoadedAt = Date.now();
    }

    /** Map of recipe-template tokens → first concrete id from the live
     *  project. Drives `substituteRecipeCode` in `_renderQueryScope`. */
    _recipeTokenMap() {
        const firstId = (arr, key = 'id') => {
            for (const it of (arr || [])) {
                const v = it?.[key];
                if (v != null && v !== '') return String(v);
            }
            return null;
        };
        const firstAgentId = () => {
            for (const a of (this._queryAgents || [])) {
                const v = a?.agent_id ?? a?.id;
                if (v) return String(v);
            }
            return null;
        };
        const firstBusTopic = () => {
            // KNOWN_BUS_TOPICS is the curated static list — first
            // entry is the canonical policy-rate topic.
            return KNOWN_BUS_TOPICS?.[0]?.topic ?? null;
        };
        // For `account` / `attr`: pick the first declared on the first
        // archetype, since they're per-archetype concepts. Falls back
        // to common defaults when the project hasn't loaded yet.
        const firstArch = (this._queryArchetypes || [])[0];
        const firstAccount = (() => {
            const accs = firstArch?.accounts;
            if (Array.isArray(accs) && accs.length) {
                return String(accs[0]?.label || accs[0]?.id || '');
            }
            return null;
        })();
        const firstAttr = (() => {
            const params = firstArch?.params;
            if (Array.isArray(params) && params.length) {
                return String(params[0]?.name || params[0]?.id || '');
            }
            return null;
        })();
        return {
            country:    firstId(this._queryCountries),
            sector:     firstId(this._querySectors),
            archetype:  firstId(this._queryArchetypes, 'archetype')
                        || firstId(this._queryArchetypes),
            agent:      firstAgentId(),
            market:     firstId(this._queryMarkets),
            kpi:        firstId(this._queryKpis),
            registry:   firstId(this._queryRegistries),
            currency:   firstId(this._queryCountries, 'currency'),
            asset_kind: firstId(this._queryAssets),
            bus_topic:  firstBusTopic(),
            account:    firstAccount,
            attr:       firstAttr,
        };
    }

    _provideQueryCompletions(model, position, monaco) {
        const line = model.getLineContent(position.lineNumber);
        const col  = position.column - 1;
        const head = line.slice(0, col);

        // Subscript id completion: `<proxy>['<here>']` → live ids of
        // that proxy. Takes precedence over the generic helper string
        // completion below since proxies are the canonical surface now.
        const sub = subscriptIdContext(head);
        if (sub) {
            return {
                suggestions: this._queryCompletionsForSubscript(
                    sub.proxy, sub.partial, position, monaco,
                ),
            };
        }

        // String-arg completion: surface concrete project entries for
        // the helper / argument slot the caret is in.
        const strCtx = stringArgContext(head);
        if (strCtx) {
            return {
                suggestions: this._queryCompletionsForArg(
                    strCtx.fnName, strCtx.argIndex, strCtx.partial,
                    position, monaco,
                ),
            };
        }

        // Attribute access after `.` — `<receiver>.<TAB>` should offer
        // the proxy / entity's methods + properties from the shape table.
        const attrAfterDot = head.match(/\.([A-Za-z_][A-Za-z0-9_]*)?$/);
        if (attrAfterDot) {
            const partial   = attrAfterDot[1] || '';
            const dotIdx    = head.lastIndexOf('.', col - 1 - partial.length);
            const upToDot   = head.slice(0, dotIdx + 1);
            const receiver  = receiverAtCaret(upToDot);
            if (receiver) {
                return {
                    suggestions: this._queryCompletionsForAttr(
                        receiver, partial, position, monaco,
                    ),
                };
            }
        }

        // `<proxy>.where(<here>=)` → kwarg completion from the proxy's
        // declared filter fields.
        const whereCtx = whereKwargContext(head);
        if (whereCtx) {
            const wordInfo = model.getWordUntilPosition(position);
            const range = new monaco.Range(
                position.lineNumber, wordInfo.startColumn,
                position.lineNumber, wordInfo.endColumn,
            );
            const sh = proxyShape(whereCtx.proxy);
            const suggestions = (sh?.filters || []).map((f) => ({
                label: `${f.name}=`,
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: `${f.name}=`,
                detail: `${whereCtx.proxy}.where(${f.name}=…)`,
                documentation: f.detail,
                sortText: `0_${f.name}`,
                range,
            }));
            return { suggestions };
        }

        // Identifier completions — proxies + helpers + every bare name
        // visible to shell_eval (sectors, archetypes, markets, kpis, …).
        const wordInfo = model.getWordUntilPosition(position);
        const range = new monaco.Range(
            position.lineNumber, wordInfo.startColumn,
            position.lineNumber, wordInfo.endColumn,
        );
        const suggestions = [];
        // Lead with proxies / domain names (the canonical surface).
        for (const name of PROXY_NAMES) {
            const sh = proxyShape(name);
            const sig = sh?.callable ? sh.callSignature : `${name}.ids · .count · .first · .where(...)`;
            suggestions.push({
                label: name,
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: name,
                detail: 'proxy',
                documentation: sig,
                sortText: `0_${name}`,
                range,
            });
        }
        // Free-function helpers. Current ones (mean, gini, safe_div, …)
        // sort right after proxies; legacy ones (stock, balances, …)
        // sort below project bare-names so the proxy surface is found
        // first. Both stay callable — only the autocomplete priority
        // changes.
        for (const h of PYTHON_HELPERS) {
            const isLegacy = !!h.legacy;
            suggestions.push({
                label: h.name,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: h.snippet,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: isLegacy ? `legacy · ${h.signature}` : h.signature,
                documentation: h.detail,
                sortText: isLegacy ? `3_${h.name}` : `1_${h.name}`,
                range,
            });
        }
        // Bare project identifiers from the server's curated scope.
        // Filtered to avoid double-listing proxies / helpers.
        const helperNames = new Set(PYTHON_HELPERS.map((h) => h.name));
        const proxyNames  = new Set(PROXY_NAMES);
        for (const key of (this._queryScopeKeys || [])) {
            if (helperNames.has(key) || proxyNames.has(key)) continue;
            suggestions.push({
                label: key,
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: key,
                detail: 'in scope',
                sortText: `2_${key}`,
                range,
            });
        }
        // Keyword arguments of the enclosing call — `stock('deposits', ty|`
        // should complete to `type=`. Parsed from the helper's signature
        // string in the shared catalogue.
        const call = callContext(head);
        if (call) {
            const helper = findHelper(call.fnName);
            if (helper) {
                for (const kw of parseKwargs(helper.signature)) {
                    suggestions.push({
                        label: `${kw}=`,
                        kind: monaco.languages.CompletionItemKind.Property,
                        insertText: `${kw}=`,
                        detail: `keyword arg of ${call.fnName}()`,
                        documentation: helper.signature,
                        sortText: `0_${kw}`,
                        range,
                    });
                }
            }
        }
        return { suggestions };
    }

    /** Build the completion list for `<receiver>.<TAB>`. Pulls
     *  properties + methods from the proxy / entity shape table.
     *  Properties first, methods second, sorted within each block. */
    _queryCompletionsForAttr(receiver, partial, position, monaco) {
        const shape = receiver.kind === 'proxy'
            ? proxyShape(receiver.name)
            : entityShape(receiver.name);
        if (!shape) return [];
        const range = new monaco.Range(
            position.lineNumber, position.column - partial.length,
            position.lineNumber, position.column,
        );
        const out = [];
        for (const p of (shape.properties || [])) {
            out.push({
                label: p.name,
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: p.name,
                detail: p.type ? `: ${p.type}` : '',
                documentation: p.detail,
                sortText: `0_${p.name}`,
                range,
            });
        }
        for (const m of (shape.methods || [])) {
            out.push({
                label: m.name,
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: m.snippet || `${m.name}()`,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: m.signature || `${m.name}(...)`,
                documentation: m.detail,
                sortText: `1_${m.name}`,
                range,
            });
        }
        return out;
    }

    /** Build the completion list for `<proxy>['<here>']`. Pulls live
     *  ids of the named proxy from the cached completion sources. */
    _queryCompletionsForSubscript(proxyName, partial, position, monaco) {
        const ids = this._idsForProxy(proxyName);
        const range = new monaco.Range(
            position.lineNumber, position.column - partial.length,
            position.lineNumber, position.column,
        );
        return ids.map((it) => ({
            label: it.id,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: it.id,
            detail: it.detail || `${proxyName}['…']`,
            range,
        }));
    }

    _idsForProxy(name) {
        const pick = (arr, key = 'id', detailKey = 'label') => (arr || [])
            .map((it) => ({
                id: String(it?.[key] ?? ''),
                detail: it?.[detailKey] ? String(it[detailKey]) : '',
            }))
            .filter((x) => x.id);
        switch (name) {
            case 'countries':  return pick(this._queryCountries);
            case 'sectors':    return pick(this._querySectors);
            case 'archetypes': return pick(this._queryArchetypes, 'archetype');
            case 'agents':     return pick(this._queryAgents,    'agent_id');
            case 'markets':    return pick(this._queryMarkets);
            case 'kpis':       return pick(this._queryKpis);
            case 'registries': return pick(this._queryRegistries);
            case 'currencies': return pick(this._queryCountries, 'currency');
            default: return [];
        }
    }

    _queryCompletionsForArg(fnName, argIndex, partial, position, monaco) {
        const helper = findHelper(fnName);
        if (!helper) return [];
        const hint = helper.argHints?.[argIndex];
        if (!hint) return [];
        let entries = [];
        if (hint === 'asset_kind') {
            entries = (this._queryAssets || []).map((k) => ({
                value: k.id, label: k.id,
                detail: k.is_financial ? 'financial' : 'real',
            }));
        } else if (hint === 'market') {
            entries = (this._queryMarkets || []).map((m) => ({
                value: m.id, label: m.id, detail: m.kind || '',
            }));
        } else if (hint === 'archetype') {
            entries = (this._queryArchetypes || []).map((a) => ({
                value: a.archetype, label: a.archetype,
                detail: a.label || '',
            }));
        } else if (hint === 'agent_id') {
            const out = [];
            for (const a of (this._queryArchetypes || [])) {
                const pop = Math.max(0, Number(a.population || 0));
                for (let i = 0; i < pop; i++) {
                    out.push({ value: `${a.archetype}-${i}`,
                               label: `${a.archetype}-${i}`, detail: 'agent' });
                }
            }
            entries = out;
        } else if (hint === 'account_label') {
            const seen = new Set();
            for (const a of (this._queryArchetypes || [])) {
                for (const acc of (a.accounts || [])) {
                    if (!acc?.label || seen.has(acc.label)) continue;
                    seen.add(acc.label);
                    entries.push({
                        value: acc.label, label: acc.label,
                        detail: `${acc.type || ''} · ${acc.asset_kind || ''}`,
                    });
                }
            }
        } else if (hint === 'bus_topic') {
            entries = KNOWN_BUS_TOPICS.map((b) => ({
                value: b.topic, label: b.topic, detail: b.label || '',
            }));
        } else if (hint.startsWith('enum:')) {
            entries = hint.slice('enum:'.length).split('|').map((v) => ({
                value: v, label: v, detail: '',
            }));
        }
        const range = new monaco.Range(
            position.lineNumber, position.column - partial.length,
            position.lineNumber, position.column,
        );
        return entries.map((e) => ({
            label: e.label,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: e.value,
            detail: e.detail,
            range,
        }));
    }

    _paintWatchTab(host) {
        const s = this._watchState || { mode: 'run', watches: [], recent_breaks: [] };
        // Re-paint while already on Watch — dispose the prior Monaco
        // explicitly so the editor + completion provider don't leak
        // when the form DOM is wiped below.
        this._disposeWatchEditor();
        host.innerHTML = `
            <div class="ea-bp-watch">
                <header class="ea-bp__head">
                    <span class="ea-bp__title">Watch</span>
                    <div class="ea-bp__actions">
                        <span class="ea-bp-watch__mode" data-role="mode">${esc(s.mode)}</span>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="watch-toggle-help"
                                title="Show or hide the help panel">Help</button>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="pause">Pause</button>
                        <button type="button" class="ea-btn ea-btn--small"
                                data-action="resume">Resume</button>
                    </div>
                </header>
                <p class="ea-bp__hint">${esc(_tabHint('watch'))}</p>
                <div class="ea-bp-watch__body">
                    <div class="ea-bp-watch__main">
                        <div class="ea-bp-watch__rows" data-role="rows"></div>
                        <form class="ea-bp-watch__add ea-bp-query__form" data-role="add">
                            <div class="ea-bp-query__editor" data-host="watch-editor"></div>
                            <label class="ea-bp-watch__break-toggle"
                                   title="Pause the world when the expression goes truthy">
                                <input type="checkbox" data-role="break"> break on true
                            </label>
                            <button type="submit" class="ea-btn ea-btn--small"
                                    title="Add watch (Enter)">Add</button>
                        </form>
                        <div class="ea-bp-watch__hits" data-role="hits"></div>
                    </div>
                    <aside class="ea-bp-query__scope ea-bp-watch__scope"
                           data-role="watch-help-aside">
                        <header class="ea-bp-query__scope-head">Help — click to insert</header>
                        <div class="ea-bp-query__scope-body"
                             data-role="watch-help-list"></div>
                    </aside>
                </div>
            </div>
        `;
        const aside = host.querySelector('[data-role="watch-help-aside"]');
        if (this._watchHelpCollapsed) aside?.classList.add('is-collapsed');
        host.querySelector('[data-action="watch-toggle-help"]')
            ?.addEventListener('click', () => {
                this._watchHelpCollapsed = !this._watchHelpCollapsed;
                aside?.classList.toggle('is-collapsed', this._watchHelpCollapsed);
            });
        host.querySelector('[data-action="pause"]')
            ?.addEventListener('click', () => this._setWatchMode('paused'));
        host.querySelector('[data-action="resume"]')
            ?.addEventListener('click', () => this._setWatchMode('run'));
        host.querySelector('[data-role="add"]')
            ?.addEventListener('submit', (ev) => {
                ev.preventDefault();
                this._submitWatchAdd();
            });
        this._renderWatchHelp();
        this._refreshWatch();
        // Reuse Query's completion-source loader (same vocabulary) then
        // mount the Watch-scoped Monaco editor.
        this._loadQueryCompletionSources().then(() => {
            // No scope-list to repaint here — the Watch tab has its own
            // help renderer (`_renderWatchHelp`), driven by recipes
            // rather than the live identifier set.
        });
        this._mountWatchEditor();
    }

    async _mountWatchEditor() {
        const editorHost = this._host?.querySelector('[data-host="watch-editor"]');
        if (!editorHost) return;
        let factory = null;
        try {
            const mod = await import('../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.log.warn?.('Monaco unavailable for Watch tab', { err });
        }
        if (!factory) {
            // Plain-input fallback — keep the tab usable when Monaco
            // can't load (offline / blocked vendor path).
            editorHost.innerHTML = `<input type="text"
                class="ea-bp-query__input"
                data-role="watch-input-fallback"
                placeholder="e.g. kpis['inflation'].value > 0.05"
                autocomplete="off" spellcheck="false">`;
            this._watchFallbackInput = editorHost.querySelector('input');
            this._watchFallbackInput?.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    this._submitWatchAdd();
                }
            });
            queueMicrotask(() => this._watchFallbackInput?.focus());
            return;
        }
        const monaco = factory.monaco;
        // Shared completion provider — Watch speaks the same Python
        // vocabulary as Query / KPIs. Disposed when leaving the tab.
        if (monaco?.languages?.registerCompletionItemProvider) {
            this._watchCompletionDisposable?.dispose?.();
            this._watchCompletionDisposable = monaco.languages.registerCompletionItemProvider(
                'python', {
                    triggerCharacters: ["'", '"', '(', ',', '.', ' '],
                    provideCompletionItems: (model, position) =>
                        this._provideQueryCompletions(model, position, monaco),
                });
        }
        const handle = factory.createEditor(editorHost, '', {
            language: 'python',
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            wordWrap: 'off',
            scrollBeyondLastLine: false,
            scrollbar: { vertical: 'hidden', horizontal: 'auto' },
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            noAutoHeight: true,
            lineHeight: 24,
            fontSize: 13,
            padding: { top: 0, bottom: 0 },
        });
        this._watchMonaco = handle?.editor ?? handle;
        const model = this._watchMonaco?.getModel?.();
        if (model && this._watchMonaco?.addCommand) {
            // One-line expression — collapse newlines like the Query
            // tab does; pasted multi-line text gets joined with spaces.
            model.onDidChangeContent(() => {
                let v = model.getValue();
                if (v.includes('\n')) {
                    v = v.replace(/\n+/g, ' ');
                    model.setValue(v);
                }
            });
            // Enter (no suggest popup) → add. With the popup open
            // Monaco's default accept-completion handler wins, matching
            // the Query tab's UX.
            this._watchMonaco.addCommand(
                monaco.KeyCode.Enter,
                () => this._submitWatchAdd(),
                '!suggestWidgetVisible && !inSnippetMode',
            );
        }
        queueMicrotask(() => this._watchMonaco?.focus?.());
    }

    _disposeWatchEditor() {
        try { this._watchCompletionDisposable?.dispose?.(); } catch { /* ignore */ }
        this._watchCompletionDisposable = null;
        try { this._watchMonaco?.dispose?.(); } catch { /* ignore */ }
        this._watchMonaco = null;
        this._watchFallbackInput = null;
    }

    _readWatchExpr() {
        if (this._watchMonaco) return String(this._watchMonaco.getValue?.() ?? '');
        if (this._watchFallbackInput) return String(this._watchFallbackInput.value ?? '');
        return '';
    }

    _clearWatchEditor() {
        try { this._watchMonaco?.setValue?.(''); } catch { /* ignore */ }
        if (this._watchFallbackInput) this._watchFallbackInput.value = '';
    }

    _submitWatchAdd() {
        const expr = this._readWatchExpr().trim();
        if (!expr) return;
        const brkEl = this._host?.querySelector('[data-role="break"]');
        const brk = !!brkEl?.checked;
        this._addWatch(expr, brk).then(() => {
            this._clearWatchEditor();
            if (brkEl) brkEl.checked = false;
        });
    }

    _renderWatchHelp() {
        const list = this._host?.querySelector('[data-role="watch-help-list"]');
        if (!list) return;
        // Same orientation paragraph + grammar reminder as Query —
        // these tabs speak the same Python vocabulary.
        const intro = `
            <div class="ea-bp-query__help-intro">
                <p>
                  Watches are Python expressions evaluated every tick.
                  Hook into anything readable: bus topics, registries,
                  KPIs, an agent's variable, or any reduction across an
                  archetype. Toggle <em>break on true</em> to pause the
                  world when the expression goes truthy.
                </p>
            </div>
        `;
        const recipeGroups = [
            // Break-condition recipes first — they're what's unique to
            // Watch and answer "how do I pause on X".
            {
                label: 'Break conditions (pause on true)',
                hint: "Comparison expressions for the row's 'break on true' toggle.",
                kind: 'recipe',
                items: WATCH_BREAK_RECIPES.map((it) => ({
                    title: it.title, code: it.code,
                    insert: it.code, tooltip: it.code,
                })),
            },
            // Then the same domain recipes as Query — same vocabulary,
            // here used as the value side of an expression.
            ...HELP_RECIPES.map((g) => ({
                label: g.group,
                hint:  g.hint,
                kind:  'recipe',
                items: g.items.map((it) => ({
                    title: it.title, code: it.code,
                    insert: it.code, tooltip: it.code,
                })),
            })),
        ];
        list.innerHTML = intro
            + recipeGroups.map((g) => _renderHelpGroupHTML(g)).join('');
        list.querySelectorAll('button[data-insert]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._insertIntoWatchInput(btn.dataset.insert || '');
            });
        });
    }

    /** Insert the clicked recipe at the caret in the Watch editor and
     *  put focus back on the editor so the user can edit before Enter.
     *  Works for both the Monaco mount and the plain-input fallback. */
    _insertIntoWatchInput(text) {
        if (!text) return;
        // Monaco path — splice at the current selection, then focus.
        if (this._watchMonaco) {
            const ed = this._watchMonaco;
            const sel = ed.getSelection?.();
            try {
                if (sel) {
                    ed.executeEdits?.('watch-insert', [{
                        range: sel, text, forceMoveMarkers: true,
                    }]);
                } else {
                    ed.setValue?.((ed.getValue?.() ?? '') + text);
                }
            } catch { /* ignore */ }
            ed.focus?.();
            return;
        }
        // Plain-input fallback.
        const inp = this._watchFallbackInput
            || this._host?.querySelector('[data-role="watch-input-fallback"]');
        if (!inp) return;
        const start = inp.selectionStart ?? inp.value.length;
        const end   = inp.selectionEnd   ?? inp.value.length;
        inp.value = inp.value.slice(0, start) + text + inp.value.slice(end);
        const caret = start + text.length;
        inp.setSelectionRange(caret, caret);
        inp.focus();
    }

    async _refreshWatch() {
        const api = window.pywebview?.api;
        if (!api?.debug_state) return;
        let snap;
        try {
            snap = await api.debug_state();
        } catch { return; }
        if (!snap || Object.keys(snap).length === 0) {
            this._watchState = { mode: 'run', watches: [], recent_breaks: [] };
            this._renderWatch();
            return;
        }
        this._watchState = snap;
        this._renderWatch();
    }

    _renderWatch() {
        const host = this._host;
        if (!host || this._activeTabId !== 'watch') return;
        const s = this._watchState || { mode: 'run', watches: [], recent_breaks: [] };
        const mode = host.querySelector('[data-role="mode"]');
        if (mode) {
            mode.textContent = s.mode;
            mode.dataset.mode = s.mode;
        }
        const rows = host.querySelector('[data-role="rows"]');
        if (rows) {
            const watches = s.watches || [];
            if (watches.length === 0) {
                rows.innerHTML =
                    '<div class="ea-plot__placeholder">' +
                    'No watches yet — add an expression below.</div>';
            } else {
                const pager = this._renderPager('watch', watches.length, 25);
                const visible = watches.slice(pager.start, pager.end);
                rows.innerHTML = visible.map((w) => this._watchRowHtml(w)).join('')
                    + pager.html;
                rows.querySelectorAll('[data-action="remove"]').forEach((btn) => {
                    btn.addEventListener('click', (ev) => {
                        const row = ev.currentTarget.closest('[data-watch-id]');
                        if (row) this._removeWatch(row.dataset.watchId);
                    });
                });
                rows.querySelectorAll('[data-action="toggle-break"]').forEach((cb) => {
                    cb.addEventListener('change', (ev) => {
                        const row = ev.currentTarget.closest('[data-watch-id]');
                        if (row) this._setBreakOnTrue(row.dataset.watchId,
                                                      !!ev.currentTarget.checked);
                    });
                });
                rows.querySelectorAll('[data-role="spark"]').forEach((el) => {
                    this._drawWatchSpark(el);
                });
                this._wirePagers(rows, () => this._renderWatch());
            }
        }
        const hits = host.querySelector('[data-role="hits"]');
        if (hits) {
            const recent = (s.recent_breaks || []).slice(-5).reverse();
            hits.innerHTML = recent.length === 0 ? '' :
                '<header>Recent breaks</header>' +
                recent.map((h) => `
                    <div class="ea-bp-watch__hit">
                        <span class="ea-bp-watch__hit-tick">@${h.tick}</span>
                        <code class="ea-bp-watch__hit-expr">${esc(h.expr)}</code>
                        <span class="ea-bp-watch__hit-val">${esc(_watchFmt(h.value))}</span>
                    </div>
                `).join('');
        }
    }

    _watchRowHtml(w) {
        const valueCell = w.error
            ? `<span class="ea-bp-watch__error" title="${esc(w.error)}">${esc(w.error)}</span>`
            : `<span class="ea-bp-watch__val">${esc(_watchFmt(w.value))}</span>`;
        const brkBadge = w.break_on_true
            ? `<span class="ea-bp-watch__brk-badge" title="Hits / last tick">
                   ${w.hits || 0}× ${w.last_hit_tick != null ? `@${w.last_hit_tick}` : ''}
               </span>` : '';
        return `
            <div class="ea-bp-watch__row" data-watch-id="${esc(w.id)}">
                <code class="ea-bp-watch__expr">${esc(w.expr)}</code>
                ${valueCell}
                <span class="ea-bp-watch__spark" data-role="spark"
                      data-history='${esc(JSON.stringify(w.history || []))}'></span>
                <label class="ea-bp-watch__brk" title="Pause the world when this expression is truthy">
                    <input type="checkbox" data-action="toggle-break"
                           ${w.break_on_true ? 'checked' : ''}>
                    break
                </label>
                ${brkBadge}
                <button type="button" class="ea-btn ea-btn--small ea-btn--ghost"
                        data-action="remove" title="Remove">×</button>
            </div>
        `;
    }

    /** Inline-SVG sparkline, no charting lib. Same shape as the one
     *  the old debug tab used; cheap enough to repaint every tick. */
    _drawWatchSpark(host) {
        let history;
        try { history = JSON.parse(host.dataset.history || '[]'); }
        catch { history = []; }
        if (!Array.isArray(history) || history.length < 2) {
            host.innerHTML = '';
            return;
        }
        const W = 90, H = 18, PAD = 1;
        const ys = history.map(([, v]) =>
            typeof v === 'number' && Number.isFinite(v) ? v : 0);
        let lo = Math.min(...ys), hi = Math.max(...ys);
        if (lo === hi) { lo -= 1; hi += 1; }
        const pts = history.map(([, v], i) => {
            const x = PAD + (i / (history.length - 1)) * (W - 2 * PAD);
            const yv = typeof v === 'number' && Number.isFinite(v) ? v : 0;
            const y = H - PAD - ((yv - lo) / (hi - lo)) * (H - 2 * PAD);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        host.innerHTML =
            `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
                <polyline fill="none" stroke="currentColor" stroke-width="1"
                          points="${pts}"/>
            </svg>`;
    }

    async _setWatchMode(mode) {
        const resp = await window.pywebview?.api?.debug_set_mode?.(mode);
        if (resp?.ok === false) {
            this.log.warn?.('debug_set_mode failed', { error: resp.error });
        }
        await this._refreshWatch();
    }

    async _addWatch(expr, breakOnTrue) {
        const items = (this._watchState?.watches || []).map((w) => ({
            id: w.id, expr: w.expr, country: w.country,
            enabled: w.enabled, break_on_true: w.break_on_true,
        }));
        items.push({
            id: `w-${Date.now()}`, expr,
            enabled: true, break_on_true: !!breakOnTrue,
        });
        const resp = await window.pywebview?.api?.debug_set_watches?.(items);
        if (resp?.ok === false) {
            this.log.warn?.('debug_set_watches failed', { error: resp.error });
        }
        await this._refreshWatch();
    }

    async _removeWatch(id) {
        const items = (this._watchState?.watches || [])
            .filter((w) => w.id !== id)
            .map((w) => ({
                id: w.id, expr: w.expr, country: w.country,
                enabled: w.enabled, break_on_true: w.break_on_true,
            }));
        await window.pywebview?.api?.debug_set_watches?.(items);
        await this._refreshWatch();
    }

    async _setBreakOnTrue(id, on) {
        const items = (this._watchState?.watches || []).map((w) => ({
            id: w.id, expr: w.expr, country: w.country,
            enabled: w.enabled,
            break_on_true: w.id === id ? !!on : w.break_on_true,
        }));
        await window.pywebview?.api?.debug_set_watches?.(items);
        await this._refreshWatch();
    }

}


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** Wrap every case-insensitive occurrence of `q` in `<mark>` so the
 *  search-across facet rows visually point at the match. `q` is
 *  escaped to be regex-safe; the haystack is HTML-escaped first so
 *  the only allowed markup is the highlight wrapper itself. */
function _highlight(haystack, q) {
    const s = String(haystack ?? '');
    if (!q) return esc(s);
    const re = new RegExp(
        q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const escd = esc(s);
    return escd.replace(re, (m) => `<mark class="ea-bp-browser__hl">${m}</mark>`);
}

/** Graph inspector — map a dependency edge `kind` to the browser
 *  source_id whose row corresponds to that edge's key. Used to make
 *  reads/writes lines clickable.
 *
 *  bus_topic / brain_key / param don't have dedicated sources today
 *  (they're identifier strings, not entities) — kept null so the
 *  inspector renders them as plain text rather than a dead link. */
const _GRAPH_REF_SOURCE = {
    registry: null,   // would be `registry:<key>` — wired below in the click
                      // handler since the prefix isn't part of the ref map
};
/** For `requires` edges, the right-hand `key` is an entity id of
 *  `kind`. Resolve to the browser source so the inspector can drill. */
const _GRAPH_REQ_SOURCE = {
    sector:           'sectors',
    asset_kind:       'asset_kinds',
    archetype:        'archetypes',
    market_archetype: 'market_archetypes',
    market:           'markets',
    currency:         'currencies',
    country:          'countries',
};

/** Add / clear highlight classes on the visible SVG. Pure DOM
 *  mutation — no state. */
function _markHighlight(svg, focusId, neighbors) {
    svg.querySelectorAll('[data-node-id]').forEach((g) => {
        const id = g.getAttribute('data-node-id');
        g.classList.toggle('is-highlight',
            id === focusId || neighbors.get(focusId)?.has(id));
    });
    svg.querySelectorAll('[data-edge-from]').forEach((p) => {
        const from = p.getAttribute('data-edge-from');
        const to   = p.getAttribute('data-edge-to');
        p.classList.toggle('is-highlight',
            from === focusId || to === focusId);
    });
}
function _clearHighlight(svg) {
    svg.querySelectorAll('.is-highlight').forEach((el) =>
        el.classList.remove('is-highlight'));
}

/** Map a browser source_id to the editor tab the row's id should
 *  open in when the user picks "Open in editor". Sources without an
 *  entry don't get the action — currencies/countries are config-level
 *  and edited via the project setup page; runtime registries don't
 *  have a "row editor" concept. */
const _SOURCE_TO_EDITOR_TAB = {
    asset_kinds:       'asset_kind',
    archetypes:        'agent',
    markets:           'market',
    market_archetypes: 'market-archetype',
    sectors:           'sector',
    scenarios:         'scenario',
    kpis:              'kpi',
};

/** Map well-known kind tokens (the right-hand side of `ref:X`) to the
 *  browser source_id they target. Lets the browser turn a cell value
 *  into a click-through. */
const _REF_KIND_TO_SOURCE = {
    sector:             'sectors',
    asset_kind:         'asset_kinds',
    archetype:          'archetypes',
    agent:              'agents',
    market:             'markets',
    market_archetype:   'market_archetypes',
    country:            'countries',
    currency:           'currencies',
    scenario:           'scenarios',
    kpi:                'kpis',
    sector_kind:        'sector_kinds',
    // A `ref:file` value is a project-relative file path; the ref-click
    // wiring opens it in a window rather than resolving a row.
    file:               'file',
};

/** Render a single <td> for a row value given its column spec. Plain
 *  strings stay as <code>; numbers right-align; refs become clickable;
 *  JSON gets a compact {N keys} preview; long text truncates with a
 *  tooltip. */
function _renderTypedCell(value, col) {
    const type = (col && col.type) || 'str';
    const raw  = value == null ? '' : value;

    // D2 — declared foreign key (D1's `ColumnSpec.references`) takes
    // priority over type-based rendering. The wire shape carries it
    // as `[target_table, target_column]`; we use the table id as the
    // browser source id directly (they match for every entity
    // mirror). Empty values render as plain text so NULL FKs don't
    // look like broken links.
    const refs = col && col.references;
    if (Array.isArray(refs) && refs.length === 2 && raw !== '') {
        const targetTable = String(refs[0]);
        return `
            <td>
                <a class="ea-bp-browser__ref"
                   href="#"
                   data-ref-source="${esc(targetTable)}"
                   data-ref-value="${esc(String(raw))}"
                   title="Go to ${esc(targetTable)}.${esc(String(refs[1]))}=${esc(String(raw))}">
                    <span class="material-symbols-outlined ea-bp-browser__ref-icon">link</span>
                    <span>${esc(String(raw))}</span>
                </a>
            </td>`;
    }

    if (typeof type === 'string' && type.startsWith('ref:')) {
        const kind = type.slice(4);
        const sid  = _REF_KIND_TO_SOURCE[kind] || null;
        if (sid && raw !== '') {
            return `
                <td>
                    <a class="ea-bp-browser__ref"
                       href="#"
                       data-ref-source="${esc(sid)}"
                       data-ref-value="${esc(String(raw))}"
                       title="Go to ${esc(kind)}:${esc(String(raw))}">
                        <span class="material-symbols-outlined ea-bp-browser__ref-icon">link</span>
                        <span>${esc(String(raw))}</span>
                    </a>
                </td>`;
        }
        return `<td><code class="ea-bus__payload">${esc(String(raw))}</code></td>`;
    }
    if (type === 'int' || type === 'float' || type === 'tick') {
        return `<td class="ea-bp-browser__td-num"><code>${esc(String(raw))}</code></td>`;
    }
    if (type === 'json') {
        // Structured value: too rich for the grid. Show a `<record>`
        // affordance — the full value opens in the per-entity view (the
        // JSON tree viewer). Empty/null shows a muted dot.
        if (raw === '' || raw == null) {
            return '<td><code class="ea-bp-browser__td-json ea-bp-browser__td-json--empty">·</code></td>';
        }
        let count = '';
        try {
            const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (Array.isArray(parsed)) {
                count = `${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
            } else if (parsed && typeof parsed === 'object') {
                const n = Object.keys(parsed).length;
                count = `${n} key${n === 1 ? '' : 's'}`;
            }
        } catch { /* leave count empty */ }
        const hint = count ? `${count} — open the row to view` : 'open the row to view';
        return `<td><code class="ea-bp-browser__td-json"
                       title="${esc(hint)}">&lt;record&gt;</code></td>`;
    }
    if (type === 'bool') {
        const truthy = raw === true || raw === 'true' || raw === 1;
        return `<td><code class="ea-bp-browser__td-bool${truthy ? ' is-true' : ''}"
                       >${truthy ? '✓' : '·'}</code></td>`;
    }
    if (type === 'text') {
        const s = String(raw);
        const truncated = s.length > 80 ? s.slice(0, 77) + '…' : s;
        return `<td><code class="ea-bp-browser__td-text"
                       title="${esc(s)}">${esc(truncated)}</code></td>`;
    }
    return `<td><code class="ea-bus__payload">${esc(String(raw))}</code></td>`;
}

/** One-line subtitle for a tab — the explanatory hint shown under its
 *  title so each tab declares what it is. */
function _tabHint(id) {
    return TABS.find((t) => t.id === id)?.hint || '';
}

/** Material-symbol name for a run-log level. Keep one icon per level
 *  (no fallbacks) so the visual language stays consistent with the
 *  filter chips. */
function _runlogIconForLevel(lvl) {
    switch (lvl) {
        case 'error': return 'error';
        case 'warn':  return 'warning';
        case 'debug': return 'bug_report';
        default:      return 'info';   // 'info' + anything unrecognised
    }
}

/** Render one group from the Query / Watch help panels.
 *
 *  `kind === 'recipe'` renders each item as a two-line entry — plain
 *  text title (what it does) above a monospace code snippet (the
 *  expression). Click inserts the snippet into the editor.
 *
 *  `kind === 'chip'` renders compact single-line buttons for the
 *  project-specific quick-insert entries below the recipes. */
function _renderHelpGroupHTML(g) {
    const head = `<header>${esc(g.label)}</header>`
        + (g.hint ? `<p class="ea-bp-query__help-hint">${esc(g.hint)}</p>` : '');
    const groupClass = `ea-bp-query__scope-group ea-bp-query__scope-group--${g.kind || 'chip'}`;
    if (g.kind === 'recipe') {
        return `
            <div class="${groupClass}">
                ${head}
                <ul>
                    ${g.items.map((it) => `
                        <li${it.dim ? ' class="ea-bp-query__recipe--dim"' : ''}>
                            <button type="button" data-insert="${esc(it.insert)}"
                                    title="${esc(it.tooltip || it.code || it.title)}">
                                <span class="ea-bp-query__recipe-title">${esc(it.title)}</span>
                                <code class="ea-bp-query__recipe-code">${esc(it.code)}</code>
                            </button>
                        </li>`).join('')}
                </ul>
            </div>`;
    }
    return `
        <div class="${groupClass}">
            ${head}
            <ul>
                ${g.items.map((it) => `
                    <li>
                        <button type="button" data-insert="${esc(it.insert)}"
                                title="${esc(it.tooltip || it.insert)}">
                            ${esc(it.title)}
                        </button>
                    </li>`).join('')}
            </ul>
        </div>`;
}

/** Population table cell: scalar → formatted text, JSON-like → inspect button.
 *  The TD carries data-sample-idx / data-cell-kind / data-cell-key so the
 *  in-place patcher in _patchPopulationCells can update the value text
 *  without touching the row structure. */
function _popCellHtml(value, sampleIdx, kind, key) {
    if (value != null && typeof value === 'object') {
        return `<td class="ea-table__cell"
                    data-sample-idx="${sampleIdx}"
                    data-cell-kind="${esc(kind)}"
                    data-cell-key="${esc(key)}">
            <button type="button" class="ea-btn ea-btn--small ea-pop-json-btn"
                    data-sample-idx="${sampleIdx}"
                    data-cell-kind="${esc(kind)}"
                    data-cell-key="${esc(key)}"
                    title="Open in window">
                <span class="material-symbols-outlined">open_in_new</span>
                ${esc(_jsonSummary(value))}
            </button>
        </td>`;
    }
    return `<td class="ea-table__cell"
                data-sample-idx="${sampleIdx}"
                data-cell-kind="${esc(kind)}"
                data-cell-key="${esc(key)}">${fmtNum(value)}</td>`;
}

function _jsonSummary(v) {
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).length} keys}`;
    return String(v);
}

/** Pop the raw value of a JSON-like cell into a managed window. */
async function _openJsonInspector({ title, value }) {
    const { ManagedWindow } = await import('../ui/components/managed_window.js');
    const winId = `ea-json-inspector:${title}`;
    const existing = ManagedWindow.get?.(winId);
    if (existing?.isVisible) { existing.show(); return; }
    let pretty;
    try { pretty = JSON.stringify(value, null, 2); }
    catch { pretty = String(value); }
    const host = document.createElement('div');
    host.style.cssText =
        'width:100%; height:100%; overflow:auto; padding:12px;'
        + ' background:#1e1e1e; color:#d4d4d4;'
        + ' font-family:ui-monospace,"SF Mono",Consolas,monospace;'
        + ' font-size:12px; line-height:1.55;';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap; margin:0; user-select:text;';
    pre.textContent = pretty;
    host.appendChild(pre);
    new ManagedWindow({
        id: winId, title, icon: 'data_object',
        content: host,
        minWidth: 480, minHeight: 240,
        defaultWidth: 720, defaultHeight: 420,
    }).show();
}

/** Open a project file's content read-only in a managed window. Target of
 *  a `ref:file` relational link (a document row's `path`, etc.). */
async function _openFileInWindow(path) {
    if (!path) return;
    const { ManagedWindow } = await import('../ui/components/managed_window.js');
    const winId = `ea-file:${path}`;
    const existing = ManagedWindow.get?.(winId);
    if (existing?.isVisible) { existing.show(); return; }
    let content = '', err = null;
    try { content = await window.pywebview?.api?.read_file_by_path?.(path); }
    catch (e) { err = String(e?.message || e); }
    const host = document.createElement('div');
    host.style.cssText =
        'width:100%; height:100%; overflow:auto; padding:12px;'
        + ' background:#1e1e1e; color:#d4d4d4;'
        + ' font-family:ui-monospace,"SF Mono",Consolas,monospace;'
        + ' font-size:12px; line-height:1.55;';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre; margin:0; user-select:text;';
    pre.textContent = err
        ? `Could not read ${path}: ${err}`
        : String(content ?? '');
    host.appendChild(pre);
    new ManagedWindow({
        id: winId,
        title: String(path).split(/[\\/]/).pop() || path,
        icon: 'description',
        content: host,
        minWidth: 480, minHeight: 240,
        defaultWidth: 760, defaultHeight: 520,
    }).show();
}

function fmtNum(v) {
    if (v == null) return '—';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '—';
        return Number(v.toFixed(4)).toString();
    }
    return esc(String(v));
}

/** Watch-row value renderer — slightly more permissive than `fmtNum`
 *  because watches can return strings, lists, dicts, booleans. Numbers
 *  get a decimal cap; objects render via JSON.stringify so the user
 *  sees structure rather than `[object Object]`. */
function _watchFmt(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return String(v);
        return Number.isInteger(v) ? String(v)
            : v.toFixed(Math.abs(v) >= 1000 ? 0 : 4);
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') {
        try { return JSON.stringify(v); }
        catch { return '<obj>'; }
    }
    return String(v);
}

function _brainSummary(brain) {
    if (!brain) return 'empty';
    if (brain.kind === 'dict') {
        const n = brain.length || 0;
        if (n === 0) return 'empty';
        const keys = Object.keys(brain.items || {}).slice(0, 3);
        const more = n > keys.length ? `, +${n - keys.length}` : '';
        return `${n} keys${keys.length ? ` · ${keys.join(', ')}${more}` : ''}`;
    }
    if (brain.kind === 'primitive') return String(brain.value);
    return brain.kind;
}

function busPayloadSummary(node) {
    if (!node) return '—';
    if (node.kind === 'primitive') {
        if (node.value === null || node.value === undefined) return 'null';
        if (typeof node.value === 'string') return JSON.stringify(node.value);
        return String(node.value);
    }
    if (node.kind === 'list')   return `[${node.length} items]`;
    if (node.kind === 'dict')   return `{${node.length} keys}`;
    if (node.kind === 'object') return `<${node.type}>`;
    if (node.kind === 'repr')   return node.repr || '';
    if (node.kind === 'elided') return '…';
    return '';
}

/** Escape a string so it's safe inside an attribute-selector `[k="..."]`. */
function cssAttrEsc(s) {
    return String(s ?? '').replace(/["\\]/g, (c) => `\\${c}`);
}

/** In-place value patch for a population-table cell. Preserves the
 *  inspect-button DOM (so its click handler keeps working) for JSON
 *  values, and replaces only the trailing text for scalar values. */
function _patchPopCell(td, value) {
    if (value != null && typeof value === 'object') {
        const btn = td.querySelector('.ea-pop-json-btn');
        if (!btn) {
            // Cell shape changed (scalar → object) — full rewrite.
            const idx = td.dataset.sampleIdx, kind = td.dataset.cellKind, key = td.dataset.cellKey;
            td.outerHTML = _popCellHtml(value, idx, kind, key);
            return;
        }
        const sym = btn.querySelector('.material-symbols-outlined');
        btn.textContent = '';
        if (sym) btn.appendChild(sym);
        else {
            const ic = document.createElement('span');
            ic.className = 'material-symbols-outlined';
            ic.textContent = 'open_in_new';
            btn.appendChild(ic);
        }
        btn.appendChild(document.createTextNode(' ' + _jsonSummary(value)));
        return;
    }
    if (td.querySelector('.ea-pop-json-btn')) {
        // Cell shape changed (object → scalar) — full rewrite.
        const idx = td.dataset.sampleIdx, kind = td.dataset.cellKind, key = td.dataset.cellKey;
        td.outerHTML = _popCellHtml(value, idx, kind, key);
        return;
    }
    td.textContent = fmtNum(value);
}
