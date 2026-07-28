/**
 * dashboard_tab.js — one analytics dashboard (a TileGrid of Ecosim PlotTiles),
 * as a workspace tab. The special `_live` dashboard is the unsaved workspace.
 *
 * Everything chart-related is Ecosim's existing infrastructure:
 *   - Widget:  `PlotTile` from ui/js/results/widgets/plot_tile.js
 *              (multi-subplot Plotly grid, all chart types, dual y-axes).
 *   - Config:  `renderPlotConfig` from ui/js/charting/plot_config_panel.js,
 *              hosted in a modal window via `openModal` (ui/js/ecoagent/ui/modal.js).
 *   - Data:    PlotCell shape — `{time: [...], indicators: {var: [...]}}`.
 *              We adapt EcoAgent's per-triple analytics series into that
 *              shape before pushing to tiles.
 *
 * Variable naming convention used by the symbol provider + config panel:
 *   "<source_id>.<property>"                  for sources with no products
 *   "<source_id>.<product>.<property>"        for product-bearing sources
 *
 * The (.) separator matches Ecosim's `Namespace.varName` autocomplete
 * idiom — the namespace is the source id.
 */

import { TileGrid } from '../../results/tile_grid.js';

// Side-effect import: registers Ecosim's PlotTile under TYPE='plot'.
import '../../results/widgets/plot_tile.js';

// Side-effect import (registers ScenarioComparisonTable under
// TYPE='scenario-comparison-table') + the two functions its tiles need:
// a well-formed default config, and its dedicated (non-chart) config panel.
import {
    defaultScenarioComparisonConfig, renderScenarioComparisonConfig,
} from '../../results/widgets/scenario_comparison_table.js';

import { migrateData, makeDefaultSubplot } from '../../notebook/cells/plot_cell.js';
import { renderPlotConfig } from '../../charting/plot_config_panel.js';
import {
    parseBuiltinId, getBuiltinDashboard, BUILTIN_PREFIX,
} from '../analytics/builtin_dashboards.js';
import { openConfirm, openModal } from '../ui/modal.js';

const LIVE_DASHBOARD_ID = '_live';
const PLOT_TILE_TYPE    = 'plot';
const COMPARISON_TABLE_TYPE = 'scenario-comparison-table';


/** Factory registered with WorkspaceTabs for kind `dashboard`. */
export function makeDashboardTab(hostEl, dashId, ctx) {
    return new DashboardTab(hostEl, dashId, ctx);
}


class DashboardTab {
    constructor(hostEl, dashId, { eventBus, logger, workspaceTabs } = {}) {
        this.hostEl = hostEl;
        this.dashId = dashId;
        this.eventBus = eventBus ?? null;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs;

        // scope: null = global (the default); '' = baseline; any other
        // string = a specific scenario id. Round-trips through bridge.
        this._dashboard = { id: dashId, label: dashId, scope: null, charts: [] };
        this._sources = [];       // analytics source tree (live or saved run)
        this._symbols = [];       // flat {name, kind, namespace} list for autocomplete
        this._grid = null;
        this._configTileId = null;
        // Resolves once the analytics symbol tree is loaded (set in mount).
        // Data pushes await it so a tick can't fetch before symbols exist.
        this._metaReady = null;

        // Single-flight guard for _pushDataToTiles. Only one render pass runs
        // at a time; a trigger that arrives mid-pass sets _pushQueued so the
        // current pass re-runs once when it finishes (coalescing). Every
        // buffer mutation happens inside this single flight, so the stateful
        // live cursor-tail below is race-free without any locking.
        this._pushInFlight = false;
        this._pushQueued = false;

        // P2/P3 — per-scenario cursor-tail (docs/LIVE_DATA_ARCHITECTURE.md).
        // Each scenario bucket ('' = the live world, or a batch scenario id)
        // accumulates its series in `_buffers.get(key)` (variable → {ticks,
        // values}); `_cursors.get(key)` is the write-seq up to which we've read
        // that bucket. A snapshot fills a bucket (cursor 0 → full view,
        // downsampled); each later read pulls only `seq > cursor` and appends.
        // A head_seq that goes BACKWARDS (the source was rebuilt → its log
        // restarts at seq 1) or a floor above the cursor (ring eviction) forces
        // a resnapshot — the cursor itself carries identity, so no epoch gate is
        // needed. The live world and every batch scenario use the SAME protocol
        // (read_series with/without scenario_id), so a batch dashboard tails
        // live just like a single run. `_displayedScenarios` is the set the
        // failsafe poll watches; `_livePollTimer` makes correctness independent
        // of run:tick events ever arriving.
        this._buffers = new Map();          // scenarioKey → Map(variable → {ticks, values})
        this._cursors = new Map();          // scenarioKey → write-seq cursor
        this._displayedScenarios = new Set();
        this._livePollTimer = null;
        // True while a run/batch is producing data — empty tiles then read
        // "Collecting data…" instead of the idle "No data" prompt.
        this._runActive = false;

        // Tick-coalescing state. The shell fires `refresh('tick')` on
        // every world tick — at typical run speeds that's 5–20 Hz,
        // and each refresh does N bridge round-trips (one per unique
        // (scenario, variable) bucket). Coalesce bursts into one fetch
        // every TICK_REFRESH_MS so the dashboard feels live without
        // saturating the bridge.
        this._tickRefreshTimer = null;
        this._tickRefreshPending = false;

        // Built-in presets are read-only: edits stay in-session unless the
        // user saves a copy.
        this._builtinKey = parseBuiltinId(dashId);
        this._isBuiltin = this._builtinKey !== null;
        this._builtinDescription = '';
    }

    async mount() {
        // Paint immediately from the in-memory model — the grid + empty
        // tiles need nothing from the bridge for a live/built-in dashboard
        // (one cheap call for a saved one). The analytics symbol tree,
        // scenarios, constants and the first data push then run in the
        // BACKGROUND, so opening a dashboard is instant instead of blocking
        // on sequential round-trips + a fetch. `_metaReady` gates any data
        // push (incl. tick refreshes) so they wait for the symbol tree.
        await this._loadDashboardModel();
        this._renderShell();
        this._loadLayoutIntoGrid();
        this._metaReady = this._loadAnalyticsMeta();
        this._metaReady
            .then(() => { this._refreshScenarioSelect(); return this._pushDataToTiles(); })
            .catch((err) => this.logger.warn?.('initial dashboard load failed', { err }));
        // Arm the failsafe data poll for the LIFETIME of the mount — NOT gated
        // on run events. The whole point of the poll is to keep the dashboard
        // correct when run:tick events are unreliable or absent (throttled, WS
        // down/reconnecting, browser mode); arming it from those same events
        // would defeat it. It's an O(1) data_version probe that only repaints
        // when the cursor advances, so it's idle-cheap.
        this._startLivePoll();
        // Switching scenarios mid-session has to re-fetch any series
        // that doesn't pin itself to a specific scenario — those are
        // "follow active" and the active scenario's world has just been
        // swapped under us. Per-scenario pinned series stay valid.
        this._onScenariosChanged = () => {
            // The active scenario's world was swapped under us. A stateless
            // re-render re-fetches from the new world; the epoch gate drops
            // any fetch still in flight against the old one. Nothing to reset.
            // Also refresh the picker — the scenario list may have changed.
            this._refreshScenariosCache().then(() => {
                this._refreshScenarioSelect();
                return this._pushDataToTiles();
            });
        };
        this.eventBus?.on?.('ecoagent:scenarios:changed', this._onScenariosChanged);
    }

    show() {}
    hide() {}

    async refresh(reason) {
        // Track whether a run is producing data so empty tiles can show
        // "Collecting data…" rather than the idle "No data" prompt. A tick
        // (or run/batch start) means data is on its way; completion stops it.
        if (reason === 'run-started' || reason === 'batch-started' || reason === 'tick') this._runActive = true;
        else if (reason === 'run-completed' || reason === 'batch-completed') this._runActive = false;
        // A fresh run/batch rebuilds the world — its metrics log restarts at
        // seq 1 — so drop the live buffers to snapshot the new world rather
        // than appending its ticks onto the previous run's series. (A backwards
        // head_seq during sync also catches this; the reset here is a latency
        // belt so the chart clears immediately on Run.)
        if (reason === 'run-started' || reason === 'batch-started') {
            this._buffers = new Map();
            this._cursors = new Map();
        }
        // Keep the failsafe poll running (idempotent). It's armed on mount and
        // lives for the whole mount, independent of run events — so the
        // dashboard stays correct even if no run:tick ever arrives.
        this._startLivePoll();
        // Tick-driven refresh: coalesced (see _scheduleTickRefresh) so a fast
        // tick loop doesn't pin the bridge. It still re-fetches
        // analytics_sources there — the schema CAN change mid-run (e.g.
        // kpi:registry doesn't exist until KpiComputer.tick() has run once,
        // which is after 'run-started' fires), and the server rebuilds
        // analytics_tree every tick anyway, so the fetch is a cheap list
        // copy, not a rebuild.
        if (reason === 'tick') {
            this._scheduleTickRefresh();
            return;
        }
        await this._refreshSources();
        // Cancel any pending debounced tick refresh — the full refresh
        // we're about to do covers it.
        if (this._tickRefreshTimer) {
            clearTimeout(this._tickRefreshTimer);
            this._tickRefreshTimer = null;
        }
        this._tickRefreshPending = false;
        // A non-tick refresh means the world/schema may have changed (run
        // (re)start, completion, project/batch change). The render is
        // stateless — it re-fetches the full current view — so there's
        // nothing to invalidate; just re-render. The epoch gate handles a
        // world that swaps while the fetch is in flight.
        await this._pushDataToTiles();
    }

    /** Re-fetch the analytics source tree (symbol table for kpi:/group:/…
     *  variables) and rebuild the derived symbol list. Cheap: the server
     *  rebuilds analytics_tree every tick regardless of whether it's asked. */
    async _refreshSources() {
        try {
            const sources = await window.pywebview?.api?.analytics_sources?.() ?? [];
            this._sources = Array.isArray(sources) ? sources : [];
            this._symbols = analyticsTreeToSymbols(this._sources);
        } catch (err) {
            this.logger.warn?.('analytics refresh failed', { err });
        }
    }

    /** Coalesce burst tick events into one `_pushDataToTiles` call
     *  every TICK_REFRESH_MS. Trailing-edge: the FIRST tick in a
     *  burst arms the timer, ticks during the wait set the pending
     *  flag, the timer fires once at the end (and re-arms if more
     *  ticks landed during the previous fetch). */
    _scheduleTickRefresh() {
        if (this._tickRefreshTimer) {
            this._tickRefreshPending = true;
            return;
        }
        const TICK_REFRESH_MS = 200;
        const fire = async () => {
            this._tickRefreshTimer = null;
            const had = this._tickRefreshPending;
            this._tickRefreshPending = false;
            try {
                await this._refreshSources();
                await this._pushDataToTiles();
            }
            catch (err) { this.logger.warn?.('tick refresh failed', { err }); }
            // More ticks arrived while we were fetching — schedule one
            // more pass so the final frame still reflects the latest.
            if (had && this._grid) {
                this._tickRefreshTimer = setTimeout(fire, TICK_REFRESH_MS);
            }
        };
        this._tickRefreshTimer = setTimeout(fire, TICK_REFRESH_MS);
    }

    dispose() {
        this._stopLivePoll();
        if (this._tickRefreshTimer) {
            clearTimeout(this._tickRefreshTimer);
            this._tickRefreshTimer = null;
        }
        if (this._onConfigRequest) {
            this.eventBus?.off?.('tile:config-request', this._onConfigRequest);
        }
        if (this._onScenariosChanged) {
            this.eventBus?.off?.('ecoagent:scenarios:changed', this._onScenariosChanged);
            this._onScenariosChanged = null;
        }
        this._configTileId = null;
        this._grid = null;
    }

    async _refreshScenariosCache() {
        try {
            const res = await window.pywebview?.api?.scenarios_list?.();
            this._scenariosCache = Array.isArray(res?.scenarios) ? res.scenarios : [];
        } catch { /* keep previous cache */ }
    }

    // --------------------------------------------------------------- data

    /** Symbol tree + scenarios + named constants for the data fetch and the
     *  config panel. Fired in PARALLEL and in the background after first
     *  paint — none of it is needed to render the (empty) grid, so it must
     *  not block the dashboard from appearing (was 3 sequential round-trips
     *  on the mount path). */
    async _loadAnalyticsMeta() {
        const api = window.pywebview?.api;
        const [sources, scenarios, consts] = await Promise.all([
            Promise.resolve(api?.analytics_sources?.()).catch(() => []),
            Promise.resolve(api?.scenarios_list?.()).catch(() => null),
            Promise.resolve(api?.analytics_named_constants?.()).catch(() => []),
        ]);
        this._sources = Array.isArray(sources) ? sources : [];
        this._symbols = analyticsTreeToSymbols(this._sources);
        this._scenariosCache = Array.isArray(scenarios?.scenarios) ? scenarios.scenarios : [];
        this._constantsCache = Array.isArray(consts) ? consts : [];
    }

    /** Load just the dashboard MODEL (layout + compare). In memory for the
     *  live workspace and built-in presets; one bridge call for a saved
     *  dashboard. Separate from the analytics meta so mount() can paint the
     *  grid before the slower loads. */
    async _loadDashboardModel() {
        if (this.dashId === LIVE_DASHBOARD_ID) {
            this._dashboard = {
                id: LIVE_DASHBOARD_ID, label: 'Live workspace',
                scope: null, compare: null, viewScenario: '', charts: [],
            };
            return;
        }
        if (this._isBuiltin) {
            const def = getBuiltinDashboard(this._builtinKey);
            if (def) {
                this._dashboard = {
                    id: this.dashId,
                    label: String(def.label || def.id),
                    scope: null,
                    compare: def.compare ? JSON.parse(JSON.stringify(def.compare)) : null,
                    viewScenario: '',
                    charts: JSON.parse(JSON.stringify(def.charts || [])),
                };
                this._builtinDescription = String(def.description || '');
            } else {
                this._dashboard = {
                    id: this.dashId, label: this.dashId,
                    scope: null, compare: null, viewScenario: '', charts: [],
                };
            }
            return;
        }
        try {
            const saved = await window.pywebview?.api?.analytics_dashboards_list?.() ?? [];
            const d = (Array.isArray(saved) ? saved : []).find((x) => String(x.id) === this.dashId);
            this._dashboard = d
                ? { id: String(d.id), label: String(d.label || d.id),
                    scope: (d.scope == null) ? null : String(d.scope),
                    compare: (d.compare && typeof d.compare === 'object') ? d.compare : null,
                    viewScenario: d.view_scenario ? String(d.view_scenario) : '',
                    charts: Array.isArray(d.charts) ? d.charts : [] }
                : { id: this.dashId, label: this.dashId, scope: null, compare: null, viewScenario: '', charts: [] };
        } catch (err) {
            this.logger.warn?.('analytics dashboard load failed', { err });
        }
    }

    // -------------------------------------------------------------- render

    _renderShell() {
        const subtitle = this._isBuiltin
            ? this._builtinDescription
            : (this._dashboard.id === LIVE_DASHBOARD_ID
                ? 'Unsaved workspace — use "Save dashboard" to keep this layout.'
                : '');
        const badge = this._isBuiltin
            ? `<span class="ea-analytics__badge" title="Preset — edits stay in this session unless saved as a copy">
                   <span class="material-symbols-outlined">bookmark</span>
                   <span>Preset</span>
               </span>`
            : '';
        const saveLabel = this._isBuiltin ? 'Save a copy' : 'Save dashboard';

        this.hostEl.innerHTML = `
            <div class="ea-analytics" style="display:flex;flex-direction:column;position:relative;">
                <header class="ea-analytics__topbar">
                    <div class="ea-analytics__title-row">
                        <h2 class="ea-analytics__title">${escAttr(this._dashboard.label)}</h2>
                        ${badge}
                        ${subtitle
                            ? `<span class="ea-analytics__subtitle">${escAttr(subtitle)}</span>`
                            : ''}
                    </div>
                    <div class="ea-analytics__actions">
                        <label class="ea-analytics__scenario" id="ea-analytics-scenario-wrap"
                               title="Scenario shown on this dashboard (Compare off). “Live” = the current/most-recent run.">
                            <span class="material-symbols-outlined">science</span>
                            <select class="ea-analytics__scenario-select"
                                    id="ea-analytics-scenario"></select>
                        </label>
                        <button type="button" class="ea-btn ea-btn--small ea-analytics__compare"
                                id="ea-analytics-compare"
                                title="Compare scenarios across every plot on this dashboard">
                            <span class="material-symbols-outlined">compare_arrows</span>
                            <span data-role="compare-label">Compare: off</span>
                        </button>
                        <div class="tile-menu-wrapper">
                            <button type="button" class="ea-btn ea-btn--small"
                                    id="ea-analytics-add-btn"
                                    title="Add a tile to this dashboard">
                                <span class="material-symbols-outlined">add_chart</span>
                                <span>Add tile</span>
                            </button>
                            <div class="tile-menu-dropdown" id="ea-analytics-add-menu" hidden>
                                <button class="tile-menu-item" type="button" data-add="plot">
                                    <span class="material-symbols-outlined">show_chart</span>
                                    <span>Plot</span>
                                </button>
                                <button class="tile-menu-item" type="button" data-add="scenario-comparison-table">
                                    <span class="material-symbols-outlined">compare_arrows</span>
                                    <span>Scenario comparison table</span>
                                </button>
                            </div>
                        </div>
                        <button type="button" class="ea-btn ea-btn--small ea-analytics__save"
                                id="ea-analytics-save">
                            <span class="material-symbols-outlined">save</span>
                            <span>${escAttr(saveLabel)}</span>
                        </button>
                    </div>
                </header>
                <div class="ea-analytics__grid-host" id="ea-analytics-grid-host"></div>
            </div>
        `;
        const host = this.hostEl.querySelector('#ea-analytics-grid-host');

        this._grid = new TileGrid({
            container: host,
            columns: 12,
            rowHeight: 56,
            // Dense expert-tool grid: tiles butt up against each
            // other with no gap, sharing borders rather than
            // floating with whitespace between them. Combined with
            // the squared-off tile chrome below, the dashboard reads
            // as a single panel of widgets instead of a card stack.
            gap: 0,
            eventBus: this.eventBus,
            showToolbar: false,
            onLayoutChange: (layout) => this._onLayoutChanged(layout),
        });

        host.addEventListener('tile:remove-request', async (e) => {
            const tileId = e.detail?.tileId;
            if (!tileId) return;
            const tile = this._grid?.tiles?.get(tileId);
            const data = migrateData(tile?.config || {});
            const label = data.subplots?.[0]?.displayName || 'this plot';
            const ok = await openConfirm({
                title: 'Remove plot',
                message: `Remove "${label}" from this dashboard?`,
                confirmLabel: 'Remove', danger: true,
            });
            if (!ok) return;
            this._grid.removeTile(tileId);
            this._dashboard.charts = (this._dashboard.charts || []).filter((c) => c.id !== tileId);
            if (this._configTileId === tileId) {
                this._configTileId = null;
            }
        });

        // Ecosim's PlotTile dispatches `tile:config-request` whenever the
        // user clicks the tile title or content. We route it to the
        // slide-out config panel — same as SimulationRunPage in Ecosim.
        this._onConfigRequest = (info) => {
            if (!this._grid?.tiles?.has(info?.tileId)) return;
            this._openConfigPanelForTile(info.tileId);
        };
        this.eventBus?.on?.('tile:config-request', this._onConfigRequest);

        this._wireAddTileMenu();
        this.hostEl.querySelector('#ea-analytics-save')
            ?.addEventListener('click', () => this._onSaveDashboard());
        this.hostEl.querySelector('#ea-analytics-compare')
            ?.addEventListener('click', () => this._openComparePopover());
        this.hostEl.querySelector('#ea-analytics-scenario')
            ?.addEventListener('change', (e) => this._onViewScenarioChange(e.target.value));
        this._refreshCompareButton();
        this._refreshScenarioSelect();
        // Per-tile config opens on demand as a modal window
        // (`_openConfigPanelForTile`) — no panel to pre-mount.
    }

    /** Populate the scenario picker with LIVE + every scenario, reflect the
     *  current selection (default Live), and show it only when Compare is OFF
     *  (compare owns scenario selection in its own popover) AND scenarios exist
     *  (with none, Live is implicit so the picker is noise). Called on render,
     *  after the scenarios cache loads, and when compare flips. */
    _refreshScenarioSelect() {
        const wrap = this.hostEl.querySelector('#ea-analytics-scenario-wrap');
        const sel = this.hostEl.querySelector('#ea-analytics-scenario');
        if (!wrap || !sel) return;
        const compareOn = this._normalizeCompare(this._dashboard?.compare).mode !== 'none';
        const scenarios = this._scenariosCache || [];
        const show = !compareOn && scenarios.length > 0;
        wrap.style.display = show ? '' : 'none';
        if (!show) return;
        // Options: LIVE (the running/latest world, value '') + every scenario.
        // Default is Live, so follow-active tails the live run; pick a saved
        // scenario to pin the view to a batch result instead.
        const picked = this._dashboard?.viewScenario || '';
        const opts = [{ id: '', label: 'Live' },
            ...scenarios.map((s) => ({ id: String(s.id), label: String(s.label || s.id) }))];
        const valid = new Set(opts.map((o) => o.id));
        const cur = valid.has(picked) ? picked : '';   // default → Live
        sel.innerHTML = opts.map((o) =>
            `<option value="${escAttr(o.id)}"${o.id === cur ? ' selected' : ''}>${escAttr(o.label)}</option>`
        ).join('');
    }

    /** The user picked a scenario to view (Compare off). Pin every
     *  follow-active series to it, persist, and re-render. '' = latest run. */
    _onViewScenarioChange(value) {
        this._dashboard.viewScenario = String(value || '');
        this._scheduleDashboardSave();
        this._pushDataToTiles();
    }

    /** The scenario a non-compare series resolves to: an explicit per-series
     *  pin wins; otherwise the dashboard's picked scenario, defaulting to
     *  '' = the LIVE world (follow active). The default is LIVE — NOT the first
     *  scenario — so a single run tails live even on a project that defines
     *  scenarios; pick a scenario in the toolbar to pin the view to a batch
     *  result instead. The '' read falls back to the latest finished run when
     *  no world is active (see `_renderOnce`), so "batch → empty" stays fixed. */
    _effectiveScenario(s) {
        const pin = _normScenario(s?.scenario);
        if (pin) return pin;
        return this._dashboard?.viewScenario || '';
    }

    _loadLayoutIntoGrid() {
        if (!this._grid) return;
        this._grid.setLayout(this._dashboard.charts || []);
    }

    _onAddTile() {
        if (!this._grid) return;
        const def = { w: 6, h: 4 };
        const pos = this._grid.findNextPosition?.(def.w, def.h) ?? { x: 0, y: 0 };
        // Start with a single empty subplot — the user picks variables
        // in the config panel that auto-opens.
        const initialConfig = migrateData({
            layout: '1x1',
            subplots: [makeDefaultSubplot(0)],
        });
        const tile = this._grid.addTile(
            PLOT_TILE_TYPE, { ...pos, ...def }, initialConfig,
        );
        if (tile) {
            // Auto-open the config panel so the user can immediately
            // pick a variable instead of staring at an empty grid cell.
            this._openConfigPanelForTile(tile.id);
        }
    }

    /** Wire the toolbar's "Add tile" button + its dropdown (Plot /
     *  Scenario comparison table). Mirrors the tile-header "..." menu's
     *  own open/outside-click-to-close pattern (tile_base.js). */
    _wireAddTileMenu() {
        const btn = this.hostEl.querySelector('#ea-analytics-add-btn');
        const menu = this.hostEl.querySelector('#ea-analytics-add-menu');
        if (!btn || !menu) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !menu.hidden;
            menu.hidden = !menu.hidden;
            if (!isOpen) {
                const closeMenu = (ev) => {
                    if (!menu.contains(ev.target) && ev.target !== btn) {
                        menu.hidden = true;
                        document.removeEventListener('pointerdown', closeMenu, true);
                    }
                };
                requestAnimationFrame(() => {
                    document.addEventListener('pointerdown', closeMenu, true);
                });
            }
        });
        menu.querySelectorAll('[data-add]').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.hidden = true;
                const kind = item.dataset.add;
                if (kind === COMPARISON_TABLE_TYPE) this._onAddComparisonTile();
                else this._onAddTile();
            });
        });
    }

    _onAddComparisonTile() {
        if (!this._grid) return;
        const def = { w: 6, h: 4 };
        const pos = this._grid.findNextPosition?.(def.w, def.h) ?? { x: 0, y: 0 };
        const initialConfig = defaultScenarioComparisonConfig();
        const tile = this._grid.addTile(
            COMPARISON_TABLE_TYPE, { ...pos, ...def }, initialConfig,
        );
        if (tile) {
            // Auto-open the config panel so the user can immediately add
            // a KPI row instead of staring at an empty grid cell.
            this._openConfigPanelForTile(tile.id);
        }
    }

    /**
     * Push the latest series for every variable referenced anywhere in
     * any tile's subplots, in the PlotCell-flat shape PlotTile expects:
     *   tile.data = { time: [...], indicators: { var: [...] } }
     *
     * Each series can pin itself to a specific scenario via
     * `series.scenario`:
     *   missing/null/"" → "follow active" — fetched from the live
     *                     world, which is whatever scenario the user
     *                     last activated.
     *   "<id>"          → fetched from the cached batch result for
     *                     that scenario (`_scenario_results[id]`). If
     *                     no batch result exists yet, the bridge
     *                     returns [] and the series shows blank.
     *
     * Per-scenario fetches are batched (one bridge call per distinct
     * scenario id), so an N-series dashboard makes 1–K calls where K
     * is the number of distinct scenarios in use, not N.
     *
     * Important detail: data is stored under the plain `variable` name
     * because PlotTile resolves each series by `s.variable` literally
     * (results/widgets/plot_tile.js:241). If two series in the same
     * subplot reference the same variable but pin different scenarios,
     * the later-fetched one wins — a known corner case; cross-scenario
     * overlay on the *same* chart will require PlotTile changes (Phase
     * 2). Cross-scenario overlay across *different* tiles works today.
     */
    /** Single-flight entry point. Coalesces overlapping triggers into one
     *  render at a time; a trigger arriving mid-render re-runs it once after.
     *  Each render is independent and stateless, so this is an efficiency
     *  coalescer, not a correctness lock — overlapping renders couldn't
     *  corrupt anything even without it. */
    async _pushDataToTiles() {
        if (!this._grid) return;
        if (this._pushInFlight) { this._pushQueued = true; return; }
        this._pushInFlight = true;
        try {
            do {
                this._pushQueued = false;
                await this._renderOnce();
            } while (this._pushQueued && this._grid);
        } finally {
            this._pushInFlight = false;
        }
    }

    /** One stateless render pass: capture the world epoch, fetch the full
     *  current view for every plotted series, then — only if the world
     *  didn't swap under us — assemble the shared time axis and paint. No
     *  series is retained between passes. */
    async _renderOnce() {
        if (!this._grid) return;
        // Wait for the symbol tree before fetching — a tick refresh can fire
        // while the background meta load is still in flight; without this the
        // fetch would resolve no triples and push empty data. Resolves
        // instantly once loaded.
        if (this._metaReady) { try { await this._metaReady; } catch { /* meta load already logged */ } }

        // Self-heal a missing source tree. The schema can appear only AFTER
        // mount: an off-process BATCH exposes its analytics tree once the
        // first scenario produces data, but during a batch the dashboard sees
        // only `tick` refreshes, which reuse the cached tree. Without this, a
        // dashboard opened before the first batch data has an empty tree → no
        // triple resolves → nothing ever renders (data OR placeholder) until
        // the run completes. Re-fetch while empty; cheap and skipped once full.
        if (!this._sources || this._sources.length === 0) {
            try {
                const srcs = await window.pywebview?.api?.analytics_sources?.();
                if (Array.isArray(srcs) && srcs.length) {
                    this._sources = srcs;
                    this._symbols = analyticsTreeToSymbols(srcs);
                }
            } catch { /* keep the cached (empty) tree; retry next render */ }
        }

        // Step 1 — walk every tile's USER config (held on the dashboard
        // model, not on tile.config which may carry the expanded render
        // config) and compute the (variable, scenario) pairs to fetch.
        // For compare modes, the scenario list comes from subplot.compare;
        // for non-compare subplots we keep the legacy per-series.scenario
        // pin behavior.
        const byScenario = new Map();   // scenario id ('' = active world) → Set(variable)
        const fetchPlan = [];           // { tileId, sp, comparedScenarios | null }
        for (const tile of this._grid.tiles.values()) {
            const userCfg = migrateData(this._userConfigFor(tile.id) || tile.config || {});
            for (const sp of userCfg.subplots || []) {
                const cmp = this._compareFor(sp);
                const scenarios = cmp.mode === 'none'
                    ? null
                    : this._scenariosForSubplot(sp);
                fetchPlan.push({ tileId: tile.id, sp, scenarios });
                for (const ax of sp.yAxes || []) {
                    for (const s of ax.series || []) {
                        if (!s.variable) continue;
                        if (cmp.mode === 'none') {
                            const scenario = this._effectiveScenario(s);
                            if (!byScenario.has(scenario)) byScenario.set(scenario, new Set());
                            byScenario.get(scenario).add(s.variable);
                        } else {
                            for (const sid of scenarios) {
                                const backend = this._scenarioBackendId(sid);
                                if (!byScenario.has(backend)) byScenario.set(backend, new Set());
                                byScenario.get(backend).add(s.variable);
                            }
                        }
                    }
                }
            }
        }

        if (byScenario.size === 0) {
            // No series referenced anywhere — push an empty data object
            // so tiles drop any stale no-data placeholders.
            const empty = { time: [], indicators: {} };
            if (this._runActive) empty.noDataMessage = 'Collecting data…';
            for (const tile of this._grid.tiles.values()) {
                try { tile.update(empty, undefined); }
                catch (err) { this.logger.warn?.('tile update failed', { err }); }
            }
            return;
        }

        // Step 2 — read each scenario bucket's series. EVERY bucket tails its
        // metrics log incrementally by write-seq (P2/P3 cursor-tail): '' is the
        // live world (scenario_id=null), any other key is a batch scenario's
        // streamed store (scenario_id=key) — so a batch dashboard fills live the
        // same way a single run does. The cursor carries identity (a backwards
        // head_seq = a rebuilt source → resnapshot), so a source swapped
        // mid-render self-corrects on the next sync, no epoch gate needed. A
        // bucket with no cursor data yet (sync returns null) falls back to the
        // legacy read (latest finished run for '', a scenario's SavedRun
        // otherwise) so nothing is blank. Buckets sync in parallel; each only
        // mutates its OWN entry in `_buffers`/`_cursors`, all inside this
        // single-flight pass.
        this._displayedScenarios = new Set(byScenario.keys());
        const synced = await Promise.all([...byScenario].map(
            async ([k, vars]) => [k, await this._syncScenarioBuffers(k, vars)]));
        const seriesByScenario = new Map();
        const legacyBuckets = new Map();
        for (const [k, series] of synced) {
            if (series === null) legacyBuckets.set(k, byScenario.get(k));
            else seriesByScenario.set(k, series);
        }
        if (legacyBuckets.size) {
            const legacy = await this._fetchAllSeries(legacyBuckets);
            for (const [k, v] of legacy) seriesByScenario.set(k, v);
        }

        // Step 3 — build a shared time axis from the union of every needed
        // series' ticks IN THE CACHE. PlotCell expects data.time and each
        // indicators[v] to share length + index.
        const tickSet = new Set();
        for (const [scenario, variables] of byScenario.entries()) {
            const scen = seriesByScenario.get(scenario);
            if (!scen) continue;
            for (const v of variables) {
                const entry = scen.get(v);
                if (entry) for (const t of entry.ticks) tickSet.add(t);
            }
        }
        const time = [...tickSet].sort((a, b) => a - b);
        const timeIdx = new Map(time.map((t, i) => [t, i]));

        // Step 4 — assemble a per-(scenario, variable) aligned-array
        // lookup from the cache. Compare-mode subplots use these to write
        // composite indicator keys; non-compare subplots write bare-
        // variable keys (legacy behavior).
        const alignedByScenario = new Map();   // scenarioBackendId → Map(variable → number[])
        for (const [scenario, variables] of byScenario.entries()) {
            const scen = seriesByScenario.get(scenario);
            const m = new Map();
            for (const v of variables) {
                const entry = scen?.get(v);
                const aligned = new Array(time.length).fill(null);
                if (entry) {
                    const { ticks, values } = entry;
                    for (let i = 0; i < ticks.length; i++) {
                        const idx = timeIdx.get(ticks[i]);
                        if (idx !== undefined) aligned[idx] = values[i];
                    }
                }
                m.set(v, aligned);
            }
            alignedByScenario.set(scenario || '', m);
        }

        // Step 5 — build indicator buckets per tile by walking each
        // subplot's compare config. Non-compare subplots emit bare
        // variable keys; compare modes emit composite keys; delta
        // mode arithmetic happens here.
        const indicatorsByTile = new Map();
        for (const { tileId, sp, scenarios } of fetchPlan) {
            const ind = indicatorsByTile.get(tileId) || {};
            const cmp = this._compareFor(sp);
            for (const ax of sp.yAxes || []) {
                for (const s of ax.series || []) {
                    if (!s.variable) continue;
                    if (cmp.mode === 'none') {
                        const pinned = this._effectiveScenario(s);
                        const arr = alignedByScenario.get(pinned)?.get(s.variable);
                        if (arr) ind[s.variable] = arr;
                    } else if (cmp.mode === 'overlay') {
                        for (const sid of scenarios) {
                            const backend = this._scenarioBackendId(sid);
                            const arr = alignedByScenario.get(backend)?.get(s.variable);
                            if (arr) ind[_compareKey(s.variable, sid)] = arr;
                        }
                    } else {
                        // delta
                        const baseBackend = this._scenarioBackendId(cmp.baseline);
                        const baseArr = alignedByScenario.get(baseBackend)?.get(s.variable);
                        for (const sid of scenarios) {
                            if (sid === cmp.baseline) continue;
                            const backend = this._scenarioBackendId(sid);
                            const arr = alignedByScenario.get(backend)?.get(s.variable);
                            if (!arr || !baseArr) continue;
                            ind[_compareKey(s.variable, sid)] = _computeDelta(arr, baseArr, cmp.style);
                        }
                    }
                }
            }
            indicatorsByTile.set(tileId, ind);
        }

        // Step 6 — push (data, render-config) per tile. The render
        // config is the user config with compare-mode series expanded
        // to match the composite keys above.
        for (const tile of this._grid.tiles.values()) {
            const ind = indicatorsByTile.get(tile.id) || {};
            const data = { time, indicators: ind };
            // While a run is producing its first ticks (or a batch is still
            // building/streaming), an empty tile means "not yet" — say so
            // instead of the idle "No data — run simulation first." prompt.
            if (this._runActive) data.noDataMessage = 'Collecting data…';
            const userCfg = this._userConfigFor(tile.id) || tile.config;
            const renderCfg = userCfg ? this._expandedRenderConfig(userCfg) : undefined;
            try { tile.update(data, renderCfg); }
            catch (err) { this.logger.warn?.('tile update failed', { err }); }
        }
    }

    // -------------------------------------------------- legacy fallback read
    //
    // The FALLBACK read for buckets that have no cursor store yet — the live
    // world post-batch (served via the latest finished run) and a scenario
    // whose streamed store hasn't started. `_syncScenarioBuffers` returns null
    // for those and `_renderOnce` routes them here. The server LTTB-caps each
    // series at INITIAL_LOAD_POINTS so the read is bounded. Buckets WITH a
    // cursor store take the incremental cursor-tail path instead.

    /** Fetch the full view for every (scenario, variable) in `byScenario` —
     *  only the buckets that fell back (no cursor store); cursor-tailed buckets
     *  are handled by `_syncScenarioBuffers`. Returns `Map(scenario →
     *  Map(variable → {ticks, values}))`. Independent per call; safe under any
     *  concurrency. */
    async _fetchAllSeries(byScenario) {
        const INITIAL_LOAD_POINTS = 4000;   // server-side LTTB cap (full view)
        const out = new Map();
        const tasks = [];
        for (const [scenario, variables] of byScenario.entries()) {
            const dest = new Map();
            out.set(scenario, dest);
            const items = [];
            for (const v of variables) {
                const triple = symbolNameToTriple(v, this._sources);
                if (triple) items.push({ variable: v, triple });
            }
            if (!items.length) continue;
            const triples = items.map((it) => it.triple);
            const keyToVar = new Map(items.map((it) => [
                `${it.triple.source}|${it.triple.product}|${it.triple.property}`,
                it.variable,
            ]));
            tasks.push((async () => {
                let res = {};
                try {
                    res = await window.pywebview?.api
                        ?.analytics_property_series_multi?.(
                            triples,
                            null,                            // run_id
                            scenario ? scenario : null,      // scenario_id ('' active → null)
                            null,                            // since_tick — full view, stateless
                            INITIAL_LOAD_POINTS,             // server-side LTTB cap
                        ) ?? {};
                } catch (err) {
                    this.logger.warn?.('series fetch failed', { scenario, err });
                }
                for (const [tripleKey, arr] of Object.entries(res)) {
                    const v = keyToVar.get(tripleKey);
                    if (!v || !Array.isArray(arr)) continue;
                    // Server returns rows tick-ascending; we keep them as-is —
                    // the shared-axis assembly maps by tick value, not order.
                    const ticks = [], values = [];
                    for (const e of arr) {
                        if (e?.tick == null) continue;
                        ticks.push(e.tick);
                        values.push(e.value ?? null);
                    }
                    dest.set(v, { ticks, values });
                }
            })());
        }
        await Promise.all(tasks);
        return out;
    }

    /** Tail ONE scenario's metrics log by write-sequence (P2/P3 cursor-tail,
     *  docs/LIVE_DATA_ARCHITECTURE.md). `scenarioKey` is '' for the live world
     *  (read with scenario_id=null) or a batch scenario id (read with
     *  scenario_id=key). Either snapshots (cursor 0 → full view, LTTB-capped) or
     *  reads only the rows past THIS bucket's cursor and appends them. A head_seq
     *  that goes backwards (source rebuilt — log restarts at seq 1), a floor
     *  above the cursor (ring eviction), or a newly-referenced variable with no
     *  history all force a resnapshot. Returns `Map(variable → {ticks, values})`,
     *  or NULL when the source has no data yet (head 0) — the caller then falls
     *  this bucket back to the legacy read (latest finished run for the live
     *  world; a scenario's SavedRun otherwise). Stateful per bucket, but every
     *  mutation runs inside the single-flight `_renderOnce`, so no two syncs of
     *  the same bucket overlap. */
    async _syncScenarioBuffers(scenarioKey, vars) {
        const api = window.pywebview?.api;
        const scenarioId = scenarioKey === '' ? null : scenarioKey;
        const items = [];   // { variable, triple, key }
        for (const v of vars) {
            const triple = symbolNameToTriple(v, this._sources);
            if (!triple) continue;
            items.push({ variable: v, triple,
                key: `${triple.source}|${triple.product}|${triple.property}` });
        }
        let buffers = this._buffers.get(scenarioKey);
        if (!buffers) { buffers = new Map(); this._buffers.set(scenarioKey, buffers); }
        let cursor = this._cursors.get(scenarioKey) || 0;
        const result = () => {
            const out = new Map();
            for (const it of items) out.set(it.variable, buffers.get(it.variable) || { ticks: [], values: [] });
            return out;
        };
        if (!items.length || !api?.read_series) return result();

        // O(1) freshness + identity probe. head_seq advances on every metric
        // write and RESETS when the source is rebuilt, so a head below our
        // cursor means a new run → resnapshot.
        let dv = null;
        try { dv = await api.data_version?.(null, scenarioId); } catch { /* treat as no data */ }
        const head = Number(dv?.head_seq || 0);
        const floor = Number(dv?.floor_seq || 0);
        if (head === 0) {
            // No data for this source yet (no live world post-batch; or a
            // scenario not started). Signal the caller (null) to fall this
            // bucket back to the legacy read so the dashboard isn't blank.
            this._buffers.set(scenarioKey, new Map());
            this._cursors.set(scenarioKey, 0);
            return null;
        }
        const missingVar = items.some((it) => !buffers.has(it.variable));
        if (head < cursor || (cursor > 0 && floor > cursor + 1) || (missingVar && cursor > 0)) {
            buffers = new Map();                 // new run / truncated / new series
            this._buffers.set(scenarioKey, buffers);
            cursor = 0;
        }
        if (head === cursor && !missingVar) return result();   // nothing new

        const snapshot = cursor === 0;
        let res = null;
        try {
            res = await api.read_series(
                items.map((it) => it.triple),     // series_keys
                null, scenarioId,                  // run_id, scenario_id (null = live world)
                cursor,                            // since_seq
                snapshot ? 4000 : null,            // LTTB only on a snapshot (deltas raw)
            );
        } catch (err) { this.logger.warn?.('read_series failed', { scenarioKey, err }); return result(); }
        if (!res) return result();
        // A snapshot (or a 'truncated' delta — our cursor fell below the floor
        // mid-flight, so the response IS the fresh snapshot) replaces buffers.
        if (snapshot || res.status === 'truncated') { buffers = new Map(); this._buffers.set(scenarioKey, buffers); }
        const keyToVar = new Map(items.map((it) => [it.key, it.variable]));
        for (const it of items) if (!buffers.has(it.variable)) buffers.set(it.variable, { ticks: [], values: [] });
        const MAX = 12000;   // bound client memory; well above the render cap
        for (const row of res.rows || []) {
            const v = keyToVar.get(`${row.source}|${row.product}|${row.property}`);
            if (!v) continue;
            const buf = buffers.get(v);
            buf.ticks.push(row.tick);
            buf.values.push(row.value ?? null);
            if (buf.ticks.length > MAX) {
                buf.ticks.splice(0, buf.ticks.length - MAX);
                buf.values.splice(0, buf.values.length - MAX);
            }
        }
        this._cursors.set(scenarioKey, Number(res.head_seq || cursor));
        return result();
    }

    /** Failsafe poll (P2/P3): every POLL_MS, check the data cursor of every
     *  displayed bucket (the live world and each shown batch scenario) and
     *  pull+repaint if ANY advanced. This is the CORRECTNESS path and the reason
     *  the dashboard updates live at all — it runs for the whole mount, gated on
     *  neither `_runActive` nor any run:tick / batch:progress event (those are a
     *  lossy latency hint, not a dependency). If every event is dropped the
     *  dashboard still catches up within one interval. O(1) `data_version` probe
     *  per bucket; a render happens only on a real cursor change, idle-cheap. */
    _startLivePoll() {
        if (this._livePollTimer) return;
        const POLL_MS = 750;
        const tick = async () => {
            this._livePollTimer = null;
            try {
                if (this._grid) {
                    const keys = this._displayedScenarios.size ? [...this._displayedScenarios] : [''];
                    let advanced = false;
                    for (const k of keys) {
                        const sid = k === '' ? null : k;
                        let dv = null;
                        try { dv = await window.pywebview?.api?.data_version?.(null, sid); } catch { /* skip */ }
                        if (dv && Number(dv.head_seq || 0) !== (this._cursors.get(k) || 0)) { advanced = true; break; }
                    }
                    if (advanced) await this._pushDataToTiles();
                }
            } catch { /* transient; the next tick retries */ }
            if (this._grid) this._livePollTimer = setTimeout(tick, POLL_MS);   // while mounted
        };
        this._livePollTimer = setTimeout(tick, POLL_MS);
    }

    _stopLivePoll() {
        if (this._livePollTimer) { clearTimeout(this._livePollTimer); this._livePollTimer = null; }
    }

    /** The user-intended (un-expanded) config for a tile, kept on the
     *  dashboard model. Tile.config is overwritten on every push with
     *  the render config; this getter is the source of truth for the
     *  panel + the fetch planner. */
    _userConfigFor(tileId) {
        return (this._dashboard.charts || [])
            .find((x) => x.id === tileId)?.config;
    }

    _onLayoutChanged(layout) {
        // Geometry (x/y/w/h) comes from the grid; the CONFIG must stay the
        // user's un-expanded config held on the model. `layout[i].config`
        // is the tile's LIVE config, which `_renderOnce` overwrites on every
        // push with the compare-EXPANDED render config (series fanned out to
        // one `variable::scenarioId` per scenario). Copying that back would
        // make `_userConfigFor` hand the expanded config to the next
        // `_expandedRenderConfig`, double-expanding it (`var::sidA::sidB`) —
        // which splits every KPI in the scenario-comparison table into one
        // row per scenario. So preserve the existing model config for known
        // tiles; only brand-new tiles (not yet in the model) take their
        // config from the layout.
        const prev = new Map((this._dashboard.charts || []).map((c) => [c.id, c]));
        this._dashboard.charts = (layout || []).map((l) => ({
            id: l.id, type: l.type,
            x: l.x, y: l.y, w: l.w, h: l.h,
            config: prev.get(l.id)?.config ?? l.config ?? {},
        }));
    }

    // --------------------------------------------------------- config panel

    /**
     * Config modal for one PlotTile — Ecosim's renderPlotConfig driven by
     * the live tile config, hosted in a modal window (`openModal`). Every
     * change calls back into applyTileConfig which re-renders the tile and
     * persists the change onto the dashboard layout. Live-apply: there's no
     * separate save step — the modal backdrop blocks the grid while you
     * edit, and the window can be dragged aside to watch the plot update.
     */
    _openConfigPanelForTile(tileId) {
        const tile = this._grid?.tiles?.get(tileId);
        if (!tile) return;

        this._configTileId = tileId;
        // Read the user's *saved* config from the dashboard model — not
        // tile.config, which we now overwrite with the compare-mode
        // expanded render config on every data push. Without this the
        // modal would show the synthesized per-scenario series instead
        // of the user's original series list.
        const saved = (this._dashboard.charts || []).find((x) => x.id === tileId);
        const sourceCfg = saved?.config ?? tile.config ?? {};
        const isComparisonTable = tile.constructor.TYPE === COMPARISON_TABLE_TYPE;
        // migrateData assumes a PlotCell — the comparison table's config is
        // already well-formed PlotCell-shape (see
        // defaultScenarioComparisonConfig), so only run PlotTile's own
        // legacy migration for actual plots.
        const data = isComparisonTable ? sourceCfg : migrateData(sourceCfg);
        const subtitle = data.subplots?.[0]?.displayName
            || (isComparisonTable ? 'Scenario Comparison' : 'Plot');

        // The config panel renders into this host; the modal owns the
        // chrome / backdrop / Esc / focus-trap (the same ManagedWindow
        // every other dialog uses). `data` is mutated in place by
        // renderPlotConfig/renderScenarioComparisonConfig and written back
        // to the tile via onChange.
        //
        // The compact plot-config overrides in ecoagent_extra_modes.css are
        // keyed on the `.slide-out-panel__body` hosting class (that's how
        // the dashboard's config got its EcoAgent-density styling when it
        // lived in a slide-out). Carry the same class here so the modal
        // inherits those overrides verbatim; `ea-plot-config-modal` is a
        // semantic hook for any modal-only tweaks.
        const host = document.createElement('div');
        host.className = 'slide-out-panel__body ea-plot-config-modal';

        if (isComparisonTable) {
            // A dedicated, minimal editor (KPI rows + scenario columns) —
            // NOT renderPlotConfig, whose chart-type/axis/color sections
            // are meaningless for a table.
            renderScenarioComparisonConfig(host, data, {
                onChange: () => this._applyTileConfig(tileId, data),
                symbolProvider: () => this._symbols,
                scenarioProvider: () => this._scenariosCache || [],
            });
        } else {
            renderPlotConfig(host, data, {
                onChange: () => this._applyTileConfig(tileId, data),
                symbolProvider: () => this._symbols,
                // EcoAgent's dashboard tiles don't show the ⓘ docs tooltip,
                // so the Documentation textarea is dead weight here.
                hideDocumentation: true,
                // The world clock is integer ticks, not calendar years —
                // swap calendar-flavored hints + band defaults for tick ones.
                tickContext: true,
                // Dashboard plots are 2D time series — drop the Z-axis
                // section + 3D chart types so they don't clutter the panel.
                hide3d: true,
                // The per-series scenario picker (paper-mode comparison
                // widget) doesn't make sense in a dashboard that plots the
                // live world. Hide it — `scenarioProvider` is still used
                // for the Baseline Scenario picker in Display Options.
                hidePerSeriesScenario: true,
                // Stack group (per-series stacking key) is rarely used and
                // eats row width. Notebook/paper mode keeps it.
                hideStackGroup: true,
                // Hodrick-Prescott filter (Trend / Cycle / Lambda rows) is
                // calibrated against macro calendar frequencies, not the
                // tick-based output a dashboard plots. Hide the section.
                hideHpFilter: true,
                // EcoAgent source IDs carry a "type:" prefix (`group:cap`,
                // `market:goods`) that reads as noise once it's the only
                // shape on the page. Strip it from the visible label only.
                stripNamespacePrefix: true,
                // Dashboards always plot vs simulation time. Skip the
                // "Use simulation time" toggle + variable picker — the
                // data model is forced to useTime=true upstream.
                hideXAxisConfig: true,
                scenarioProvider: () => this._scenarioOptions(),
                // Power the Reference-Lines value autocomplete: numbers
                // stay numbers, but a typed `<archetype>.<param>` resolves
                // to the live value at every push (see
                // _expandedRenderConfig → reference-line resolver below).
                constantsProvider: () => this._constantsCache || [],
            });
        }

        openModal({
            title: `Configure · ${subtitle}`,
            icon: 'monitoring',
            content: host,
            actions: [{ label: 'Done', value: null, primary: true }],
            // Edits live-apply, so keep the plot behind crisp/visible (drag
            // the modal aside to watch it update): no blur, only a faint dim.
            backdropBlur: 0,
            backdropOpacity: 0.15,
            width: 820,
            height: Math.min(760, Math.max(
                420, Math.floor((window.innerHeight || 900) * 0.85))),
        }).finally(() => {
            if (this._configTileId === tileId) this._configTileId = null;
            // The cogwheel highlights the tile (`tile--selected`, added in
            // TileBase._onConfigClick). Closing the modal must clear it —
            // same as results_tile_dashboard._onConfigPanelClosed — or the
            // plot stays visibly selected with no panel open.
            this._grid?.tiles?.get(tileId)?.element
                ?.classList.remove('tile--selected');
        });
    }

    /** Map the bridge's `scenarios_list()` shape onto the
     *  `{ name, path }` shape the shared config panel expects. Baseline
     *  uses the literal id 'baseline' rather than an empty string so it
     *  doesn't collide with the placeholder option's empty value. */
    _scenarioOptions() {
        const base = [{ name: 'Baseline', path: 'baseline' }];
        return base.concat((this._scenariosCache || []).map((s) => ({
            name: s.label || s.id, path: s.id,
        })));
    }

    /** Look up the display label for a scenario id. 'baseline' (and the
     *  empty string, for paranoia) both map to the implicit baseline
     *  scenario. */
    _scenarioLabel(id) {
        if (!id || id === 'baseline') return 'Baseline';
        const s = (this._scenariosCache || []).find((x) => x.id === id);
        return s?.label || s?.id || id;
    }

    /** Convert a UI scenario id ('baseline' / saved-scenario id) into
     *  the backend `scenario_id` argument: empty string for baseline,
     *  the literal id for saved scenarios. */
    _scenarioBackendId(id) {
        if (!id || id === 'baseline') return '';
        return id;
    }

    /** Update the "Compare: …" label in the dashboard toolbar to
     *  reflect the current dashboard-level compare state. */
    _refreshCompareButton() {
        const btn = this.hostEl.querySelector('#ea-analytics-compare');
        const labelEl = btn?.querySelector('[data-role="compare-label"]');
        if (!btn || !labelEl) return;
        const c = this._normalizeCompare(this._dashboard?.compare);
        btn.classList.toggle('ea-analytics__compare--on', c.mode !== 'none');
        if (c.mode === 'none') {
            labelEl.textContent = 'Compare: off';
        } else {
            const n = c.scenarios.length || 0;
            const verb = c.mode === 'delta' ? 'delta' : 'overlay';
            labelEl.textContent = n > 0
                ? `Compare: ${verb} · ${n} scenario${n === 1 ? '' : 's'}`
                : `Compare: ${verb}`;
        }
    }

    /** Anchor a popover under the Compare button with mode select +
     *  scenarios chip-list + (delta-only) baseline picker + style.
     *  Edits write directly to `this._dashboard.compare` and trigger
     *  a re-render + save. */
    _openComparePopover() {
        const trigger = this.hostEl.querySelector('#ea-analytics-compare');
        if (!trigger) return;
        // Close any existing popover before opening a new one.
        document.getElementById('ea-compare-popover')?.remove();

        const c = this._normalizeCompare(this._dashboard?.compare);
        const scenarios = this._scenarioOptions();

        const pop = document.createElement('div');
        pop.id = 'ea-compare-popover';
        pop.className = 'ea-compare-popover';
        pop.innerHTML = `
            <header class="ea-compare-popover__head">
                <span class="material-symbols-outlined">compare_arrows</span>
                <span class="ea-compare-popover__title">Compare scenarios</span>
                <button type="button" class="ea-btn ea-btn--small" data-action="close"
                        title="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </header>
            <p class="ea-compare-popover__hint">
                One control flips every plot on this dashboard. Pick the
                scenarios you want to compare; per-tile overrides take
                priority on tiles that set their own compare mode.
            </p>
            <div class="ea-compare-popover__row">
                <label>Mode</label>
                <select class="config-input" data-field="mode">
                    <option value="none"    ${c.mode === 'none'    ? 'selected' : ''}>Off</option>
                    <option value="overlay" ${c.mode === 'overlay' ? 'selected' : ''}>Overlay scenarios</option>
                    <option value="delta"   ${c.mode === 'delta'   ? 'selected' : ''}>Delta vs baseline</option>
                </select>
            </div>
            <div class="ea-compare-popover__row" data-role="scenarios-row">
                <label>Scenarios</label>
                <div class="plot-compare-chips">
                    ${scenarios.length === 0
                        ? '<span class="config-hint">No saved scenarios yet — run a batch first.</span>'
                        : scenarios.map((sc) => {
                            const val = sc.path ?? sc.id ?? sc.name;
                            const on = c.scenarios.includes(val);
                            // Color swatch on each chip = the scenario's
                            // base hue. Click swatch → picker; click
                            // chip body → toggle inclusion.
                            const color = this._scenarioColor(val);
                            return `<span class="plot-compare-chip${on ? ' plot-compare-chip--on' : ''}"
                                          data-scenario="${escAttr(val)}">
                                <input type="color"
                                       class="plot-compare-chip__swatch"
                                       data-role="color"
                                       data-scenario="${escAttr(val)}"
                                       value="${escAttr(color)}"
                                       title="Color for ${escAttr(sc.name)}">
                                <button type="button"
                                        class="plot-compare-chip__label"
                                        data-role="toggle"
                                        data-scenario="${escAttr(val)}">
                                    ${escAttr(sc.name)}
                                </button>
                            </span>`;
                        }).join('')}
                </div>
            </div>
            <div class="ea-compare-popover__row" data-role="baseline-row">
                <label>Baseline</label>
                <select class="config-input" data-field="baseline">
                    ${scenarios.length === 0
                        ? '<option value="baseline" selected>Baseline</option>'
                        : scenarios.map((sc) => {
                            const val = sc.path ?? sc.id ?? sc.name;
                            return `<option value="${escAttr(val)}" ${val === c.baseline ? 'selected' : ''}>${escAttr(sc.name)}</option>`;
                        }).join('')}
                </select>
            </div>
            <div class="ea-compare-popover__row" data-role="style-row">
                <label>Delta style</label>
                <select class="config-input" data-field="style">
                    <option value="subtract" ${c.style === 'subtract' ? 'selected' : ''}>Subtract (x − baseline)</option>
                    <option value="relative" ${c.style === 'relative' ? 'selected' : ''}>Relative (%Δ baseline)</option>
                    <option value="ratio"    ${c.style === 'ratio'    ? 'selected' : ''}>Ratio (x / baseline)</option>
                </select>
            </div>
        `;
        document.body.appendChild(pop);

        // Position below the trigger, viewport-clamped.
        const place = () => {
            const a = trigger.getBoundingClientRect();
            const r = pop.getBoundingClientRect();
            const gap = 6;
            let top = a.bottom + gap;
            if (top + r.height > window.innerHeight - 8) top = Math.max(8, a.top - r.height - gap);
            let left = a.right - r.width;
            left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
            pop.style.left = `${Math.round(left)}px`;
            pop.style.top  = `${Math.round(top)}px`;
        };
        requestAnimationFrame(() => requestAnimationFrame(place));

        const refreshVisibility = () => {
            const cur = this._normalizeCompare(this._dashboard?.compare);
            pop.querySelector('[data-role="scenarios-row"]').style.display = cur.mode === 'none' ? 'none' : '';
            pop.querySelector('[data-role="baseline-row"]').style.display  = cur.mode === 'delta' ? '' : 'none';
            pop.querySelector('[data-role="style-row"]').style.display     = cur.mode === 'delta' ? '' : 'none';
        };
        refreshVisibility();

        const commit = () => {
            this._refreshCompareButton();
            // Compare flipping changes whether the scenario picker applies.
            this._refreshScenarioSelect();
            this._scheduleDashboardSave();
            // Re-fetch + re-render every tile under the new compare config.
            this._pushDataToTiles();
        };

        pop.querySelector('[data-field="mode"]').addEventListener('change', (e) => {
            this._dashboard.compare = this._normalizeCompare({
                ...(this._dashboard.compare || {}),
                mode: e.target.value,
            });
            refreshVisibility();
            commit();
        });
        pop.querySelector('[data-field="baseline"]')?.addEventListener('change', (e) => {
            this._dashboard.compare = this._normalizeCompare({
                ...(this._dashboard.compare || {}),
                baseline: e.target.value,
            });
            commit();
        });
        pop.querySelector('[data-field="style"]')?.addEventListener('change', (e) => {
            this._dashboard.compare = this._normalizeCompare({
                ...(this._dashboard.compare || {}),
                style: e.target.value,
            });
            commit();
        });
        // Toggle inclusion when the user clicks the chip label.
        pop.querySelectorAll('[data-role="toggle"]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sid = btn.dataset.scenario;
                const cur = this._normalizeCompare(this._dashboard.compare || {});
                const i = cur.scenarios.indexOf(sid);
                if (i >= 0) cur.scenarios.splice(i, 1);
                else cur.scenarios.push(sid);
                this._dashboard.compare = cur;
                btn.closest('.plot-compare-chip')?.classList.toggle('plot-compare-chip--on');
                commit();
            });
        });
        // Color picker — writes into dashboard.compare.colors[sid].
        // Stop propagation so opening the picker doesn't also fire the
        // toggle button next to it.
        pop.querySelectorAll('[data-role="color"]').forEach((sw) => {
            sw.addEventListener('click', (e) => e.stopPropagation());
            sw.addEventListener('input', () => {
                const sid = sw.dataset.scenario;
                const cur = this._normalizeCompare(this._dashboard.compare || {});
                cur.colors = { ...(cur.colors || {}), [sid]: sw.value };
                this._dashboard.compare = cur;
                commit();
            });
        });

        // Dismissal: outside click + escape.
        const onDocDown = (e) => {
            if (pop.contains(e.target) || trigger.contains(e.target)) return;
            close();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const close = () => {
            pop.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey);
        };
        pop.querySelector('[data-action="close"]')?.addEventListener('click', close);
        setTimeout(() => {
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onKey);
        }, 0);
    }

    /** Coalesce dashboard-level changes (e.g. compare config) into a
     *  single bridge save. */
    _scheduleDashboardSave() {
        if (this._dashSaveTimer) clearTimeout(this._dashSaveTimer);
        this._dashSaveTimer = setTimeout(() => {
            this._dashSaveTimer = null;
            this._flushDashboardSave();
        }, 250);
    }

    async _flushDashboardSave() {
        // Built-in presets are read-only — edits stay in-session until
        // the user explicitly saves a copy.
        if (this._isBuiltin || this._dashboard?.id === LIVE_DASHBOARD_ID) return;
        try {
            await window.pywebview?.api?.analytics_dashboard_save?.(
                this._dashboard.id,
                this._dashboard.label,
                this._dashboard.charts || [],
                this._dashboard.scope,
                this._dashboard.compare || null,
                this._dashboard.viewScenario || null,
            );
        } catch (err) {
            this.logger.warn?.('dashboard save failed', { err });
        }
    }

    /** Normalize a compare config object into the stable shape the
     *  fetcher / renderer expect. Defaults: mode='none', no
     *  scenarios, baseline='baseline', style='subtract'. */
    _normalizeCompare(c) {
        if (!c || typeof c !== 'object') {
            return { mode: 'none', scenarios: [], baseline: 'baseline', style: 'subtract', colors: {} };
        }
        const mode = (c.mode === 'overlay' || c.mode === 'delta') ? c.mode : 'none';
        const scenarios = Array.isArray(c.scenarios)
            ? c.scenarios.filter((s) => typeof s === 'string')
            : [];
        const baseline = (typeof c.baseline === 'string' && c.baseline) || 'baseline';
        const style = (c.style === 'relative' || c.style === 'ratio')
            ? c.style : 'subtract';
        const colors = (c.colors && typeof c.colors === 'object') ? { ...c.colors } : {};
        return { mode, scenarios, baseline, style, colors };
    }

    /** Effective color for a scenario in compare mode.
     *
     *  Priority: explicit override in dashboard.compare.colors[id]
     *  → default palette indexed by the scenario's position in the
     *  project's known list ('baseline' is always palette[0]).
     *
     *  Same scenario gets the same color across every tile on the
     *  dashboard, so visual identity is consistent without per-tile
     *  configuration. */
    _scenarioColor(sid) {
        const cmp = this._normalizeCompare(this._dashboard?.compare);
        if (cmp.colors && cmp.colors[sid]) return cmp.colors[sid];
        if (sid === 'baseline') return _SCENARIO_PALETTE[0];
        const ids = (this._scenariosCache || []).map((s) => s.id);
        const idx = ids.indexOf(sid);
        if (idx < 0) return _SCENARIO_PALETTE[0];
        // Reserve slot 0 for baseline; saved scenarios start at 1.
        return _SCENARIO_PALETTE[(idx + 1) % _SCENARIO_PALETTE.length];
    }

    /** Effective compare config for one subplot. Resolution order:
     *    1. subplot-level `sp.compare` (per-tile override) — only used
     *       when its mode is 'overlay' or 'delta';
     *    2. dashboard-level `this._dashboard.compare` (the global
     *       toggle from the dashboard toolbar);
     *    3. `{mode:'none'}` — plot the live world only.
     *
     *  This makes the dashboard toolbar's "Compare scenarios" control
     *  the primary knob (one click, every tile updates), and the
     *  per-tile config a rarely-needed override. */
    _compareFor(sp) {
        const own = this._normalizeCompare(sp?.compare);
        if (own.mode !== 'none') return own;
        return this._normalizeCompare(this._dashboard?.compare);
    }

    /** Scenarios actually rendered for this subplot, in order, given
     *  its compare config. Always non-empty for compare modes — the
     *  baseline is added if the user didn't pick any.
     *
     *  Filters against the project's known scenarios so "ghost" ids
     *  saved by a different project (e.g. the Mosler-flavoured preset
     *  opened in a blank project) silently drop out instead of
     *  rendering empty lines. */
    _scenariosForSubplot(sp) {
        const c = this._compareFor(sp);
        if (c.mode === 'none') return [];
        const known = new Set(['baseline',
            ...((this._scenariosCache || []).map((s) => s.id))]);
        const out = c.scenarios.filter((s) => known.has(s));
        if (c.mode === 'delta' && known.has(c.baseline) && !out.includes(c.baseline)) {
            out.push(c.baseline);
        }
        if (out.length === 0) out.push('baseline');
        return out;
    }

    /** Build a render-config: every subplot with a compare mode gets
     *  its yAxes' series list EXPANDED so there is one entry per
     *  (original-series × rendered-scenario), each pointing at a
     *  composite indicator key the data fetcher emits. The original
     *  user config (kept in `this._dashboard.charts[i].config`) is
     *  untouched — this expansion is purely render-time. */
    _expandedRenderConfig(config) {
        const out = JSON.parse(JSON.stringify(config || {}));
        // Resolve any reference-line value strings (named constants)
        // to the live numeric value via the cached constants map.
        // Unresolved names stay as-is — PlotTile will silently skip a
        // non-numeric value, so the user sees "no line yet" instead of
        // a misleading rendered zero.
        const constMap = new Map(
            (this._constantsCache || []).map((c) => [String(c.name), Number(c.value)]),
        );
        for (const sp of (out.subplots || [])) {
            const refs = Array.isArray(sp.referenceLines) ? sp.referenceLines : [];
            for (const r of refs) {
                if (typeof r.value === 'string' && constMap.has(r.value)) {
                    // Preserve the original name so the editor can read
                    // it back; the runtime field that PlotTile uses is
                    // `value`, which we overwrite with the numeric.
                    r._ref = r.value;
                    r.value = constMap.get(r.value);
                } else if (typeof r.value === 'string') {
                    // Unrecognised string — leave numeric undefined so
                    // PlotTile drops the line instead of plotting NaN.
                    r._ref = r.value;
                    r.value = undefined;
                }
            }
        }
        for (const sp of (out.subplots || [])) {
            const c = this._compareFor(sp);
            if (c.mode === 'none') continue;
            const rendered = this._scenariosForSubplot(sp);
            // Generic (non-PlotTile) metadata: which scenarios got fetched
            // for this subplot, with clean display labels — e.g. the
            // scenario-comparison-table tile reads this to build columns
            // instead of parsing PlotTile's legend-formatted series labels.
            sp._compareMeta = {
                baselineId: c.baseline,
                baselineLabel: this._scenarioLabel(c.baseline),
                scenarios: rendered
                    .filter((sid) => sid !== c.baseline)
                    .map((sid) => ({ id: sid, label: this._scenarioLabel(sid) })),
            };
            const isDelta = c.mode === 'delta';
            // In delta mode the baseline is the reference, not a line.
            const drawn = isDelta ? rendered.filter((s) => s !== c.baseline) : rendered;
            for (const ax of sp.yAxes || []) {
                const orig = ax.series || [];
                const expanded = [];
                for (let oidx = 0; oidx < orig.length; oidx++) {
                    const s = orig[oidx];
                    drawn.forEach((sid, _sidx) => {
                        const scLabel = this._scenarioLabel(sid);
                        const baseLabel = (s.label || s.variable || '').trim() || '(unnamed)';
                        const deltaTag = !isDelta ? scLabel
                            : (c.style === 'relative' ? `%Δ ${scLabel} − ${this._scenarioLabel(c.baseline)}`
                            :  c.style === 'ratio'    ? `${scLabel} / ${this._scenarioLabel(c.baseline)}`
                            :                            `${scLabel} − ${this._scenarioLabel(c.baseline)}`);
                        // Color identity: every line from scenario sid
                        // shares a base hue. Within a scenario, the
                        // original series' index controls a lightness
                        // shade — so a (p10, median, p90) trio under
                        // scenario A reads as light-blue / blue /
                        // dark-blue, and under scenario B as the same
                        // shading on B's hue. Original color choices
                        // from the saved config are overridden.
                        const base = this._scenarioColor(sid);
                        const color = _shadeForIndex(base, oidx, orig.length);
                        expanded.push({
                            ...s,
                            id: `${s.id || s.variable || 'series'}::${sid}`,
                            variable: _compareKey(s.variable, sid),
                            // `label` below is overwritten with the
                            // legend-formatted string below — stash the
                            // user's actual (possibly empty) label first
                            // so non-chart consumers (e.g. the scenario-
                            // comparison-table tile) can still tell "user
                            // set no label" from "user set label X".
                            _origLabel: (s.label || '').trim(),
                            label: `${baseLabel} (${deltaTag})`,
                            color,
                            // Keep the original lineStyle — color is
                            // doing the scenario differentiation now.
                            lineStyle: s.lineStyle || 'solid',
                        });
                    });
                }
                ax.series = expanded;
            }
        }
        return out;
    }

    _applyTileConfig(tileId, config) {
        const tile = this._grid?.tiles?.get(tileId);
        if (!tile) return;
        // Save the user's (un-expanded) config to the dashboard model
        // first — the panel reads from here, so subsequent opens show
        // the original series list, not the compare-mode expansion.
        const c = (this._dashboard.charts || []).find((x) => x.id === tileId);
        if (c) c.config = JSON.parse(JSON.stringify(config));
        // Render with an expanded config so compare mode actually
        // produces N lines per series.
        const renderCfg = this._expandedRenderConfig(config);
        tile.update(undefined, renderCfg);
        this._pushDataToTiles();
    }

    // --------------------------------------------------------- save / copy

    async _onSaveDashboard() {
        let id = this._dashboard.id;
        let label = this._dashboard.label;
        const needsNewId = (id === LIVE_DASHBOARD_ID) || this._isBuiltin;
        if (needsNewId) {
            const proposed = window.prompt?.(
                this._isBuiltin
                    ? `Save a copy of "${label}" as (id):`
                    : 'Save dashboard as (id):',
                this._isBuiltin ? `${this._builtinKey}-copy` : 'corridor',
            );
            if (!proposed) return;
            id = String(proposed).trim().toLowerCase().replace(/\s+/g, '-');
            if (!id) return;
            label = window.prompt?.('Display label:', id) || id;
        }
        try {
            const res = await window.pywebview?.api
                ?.analytics_dashboard_save?.(
                    id, label, this._dashboard.charts,
                    this._dashboard.scope,
                    this._dashboard.compare || null,
                    this._dashboard.viewScenario || null,
                );
            if (!res?.ok) {
                this.logger.warn?.('dashboard save failed', { res });
                return;
            }
            this.eventBus?.emit?.('ecoagent:analytics:dashboards-changed', {});
            this.workspaceTabs?.notifyChanged?.('dashboards');
            if (this._dashboard.id === LIVE_DASHBOARD_ID) {
                this.workspaceTabs?.closeTab(`dashboard:${LIVE_DASHBOARD_ID}`);
                this.workspaceTabs?.openTab({
                    kind: 'dashboard', entityId: id, label, icon: 'monitoring',
                });
            } else if (this._isBuiltin) {
                this.workspaceTabs?.openTab({
                    kind: 'dashboard', entityId: id, label, icon: 'monitoring',
                });
            } else {
                this._dashboard.label = label;
            }
        } catch (err) {
            this.logger.error?.('dashboard save failed', { err });
        }
    }
}


// ─── Symbol / variable-name helpers ─────────────────────────────────────────

/**
 * Walk the analytics_sources tree and produce the flat symbol list
 * Ecosim's plot_config_panel autocomplete expects:
 *   [{ name: "<source>.<product>.<property>", kind: "indicator",
 *      namespace: "<source>" }, ...]
 *
 * Sources with no products have direct properties → name becomes
 * "<source>.<property>". This matches Ecosim's "Namespace.varName"
 * autocomplete idiom.
 */
function analyticsTreeToSymbols(sources) {
    const out = [];
    for (const s of (sources || [])) {
        const sid = s?.meta?.id;
        if (!sid) continue;
        // Direct-on-source properties (used by group:* aggregate sources).
        for (const p of (s.properties || [])) {
            if (!p?.id) continue;
            out.push({
                name: `${sid}.${p.id}`,
                kind: 'indicator',
                namespace: sid,
            });
        }
        // Product-bearing sources (markets).
        for (const prod of (s.products || [])) {
            const pid = prod?.meta?.id;
            if (!pid) continue;
            for (const p of (prod.properties || [])) {
                if (!p?.id) continue;
                out.push({
                    name: `${sid}.${pid}.${p.id}`,
                    kind: 'indicator',
                    namespace: sid,
                });
            }
        }
    }
    return out;
}

/**
 * Inverse of analyticsTreeToSymbols: split a variable name like
 *   "<source>.<product>.<property>"   →  {source, product, property}
 *   "<source>.<property>"             →  {source, product: '', property}
 *
 * Source ids themselves contain `:` and `.` (e.g. `market:goods.sector_a`),
 * so a naive split-on-dot is wrong. We compare against the known source
 * list to find the longest prefix that matches a real source id.
 */
function symbolNameToTriple(name, sources) {
    if (!name) return null;
    const ids = (sources || [])
        .map((s) => s?.meta?.id)
        .filter(Boolean)
        // Longest first so "market:goods.sector_a" beats "market:goods".
        .sort((a, b) => b.length - a.length);
    for (const sid of ids) {
        if (name === sid) return null;             // bare source ref, no property
        const prefix = sid + '.';
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        // For product-bearing sources rest = "product.property",
        // otherwise rest = "property". We resolve by checking the source.
        const src = sources.find((s) => s?.meta?.id === sid);
        const hasProducts = Array.isArray(src?.products) && src.products.length > 0;
        if (hasProducts) {
            const dot = rest.indexOf('.');
            if (dot < 0) return null;
            return {
                source:   sid,
                product:  rest.slice(0, dot),
                property: rest.slice(dot + 1),
            };
        }
        return { source: sid, product: '', property: rest };
    }
    return null;
}


function escAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** Normalise a series.scenario field. `null`, `undefined`, empty string,
 *  or any non-string get mapped to '' ("follow active"). Anything else
 *  is a pinned scenario id we'll pass straight through to the bridge. */
function _normScenario(v) {
    if (v == null) return '';
    return String(v).trim();
}

/** Compose the indicator key used to publish a (variable, scenario)
 *  pair in compare mode. The separator is unlikely to appear in a real
 *  variable name, so the bare-variable namespace stays uncluttered. */
function _compareKey(variable, scenarioId) {
    return `${variable}::${scenarioId || 'baseline'}`;
}

/** Element-wise delta computation aligned to the baseline. `style`:
 *    'subtract' → x - b
 *    'relative' → (x - b) / b  (null when |b| < 1e-12)
 *    'ratio'    → x / b        (null when |b| < 1e-12)
 *  Null in either input propagates to null in the result so missing
 *  ticks stay as gaps instead of pretending to compute a value.
 */
function _computeDelta(arr, baseline, style) {
    const out = new Array(arr.length).fill(null);
    const n = Math.min(arr.length, baseline.length);
    for (let i = 0; i < n; i++) {
        const x = arr[i];
        const b = baseline[i];
        if (x == null || b == null) continue;
        if (style === 'relative') {
            if (Math.abs(b) < 1e-12) continue;
            out[i] = (x - b) / b;
        } else if (style === 'ratio') {
            if (Math.abs(b) < 1e-12) continue;
            out[i] = x / b;
        } else {
            out[i] = x - b;
        }
    }
    return out;
}


// ─── Scenario palette + lightness shading ──────────────────────────────
//
// Each scenario shown in compare mode gets a deterministic base color
// from this palette (indexed by the scenario's position in the
// project's scenarios list — index 0 is reserved for Baseline). Users
// can override per-scenario via dashboard.compare.colors[id].
//
// For multi-series tiles (p10 / median / p90) the within-scenario
// differentiation is done with HSL lightness offsets so every line
// under a scenario reads as the same hue at different intensities.

const _SCENARIO_PALETTE = [
    '#8a8a8a',  // baseline — neutral gray
    '#5fa8d3',  // blue
    '#d36a6a',  // red
    '#7cb46a',  // green
    '#d9a14a',  // orange
    '#a07cb4',  // purple
    '#e2b93d',  // yellow
    '#5fc7c2',  // teal
    '#d4a8b8',  // pink
];

/** Shade one base color by lightness, picking an offset that ranges
 *  from +18% (idx 0, lightest) to −18% (idx N-1, darkest). For a
 *  single-series axis, returns the base color unchanged. */
function _shadeForIndex(baseHex, idx, total) {
    if (total <= 1) return baseHex;
    const range = 36;          // total spread, percent points of lightness
    const step  = range / (total - 1);
    const offset = (range / 2) - idx * step;
    return _adjustLightness(baseHex, offset);
}

/** Return `baseHex` with its HSL lightness shifted by `deltaPct` (in
 *  the [-100, +100] percent-point space). Falls back to `baseHex`
 *  unchanged when the input isn't a parsable #rrggbb. */
function _adjustLightness(baseHex, deltaPct) {
    const rgb = _hexToRgb(baseHex);
    if (!rgb) return baseHex;
    const hsl = _rgbToHsl(rgb);
    hsl.l = Math.max(0, Math.min(100, hsl.l + deltaPct));
    const out = _hslToRgb(hsl);
    return _rgbToHex(out.r, out.g, out.b);
}

function _hexToRgb(hex) {
    const m = String(hex || '').replace('#', '')
        .match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return null;
    return {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
    };
}

function _rgbToHex(r, g, b) {
    const c = (n) => Math.max(0, Math.min(255, Math.round(n)))
        .toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}

function _rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function _hslToRgb({ h, s, l }) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return {
        r: f(h + 1 / 3) * 255,
        g: f(h)         * 255,
        b: f(h - 1 / 3) * 255,
    };
}
