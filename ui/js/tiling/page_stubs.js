/**
 * page_stubs.js — content factories for the tiling shell.
 *
 * Real page modules (`sfc`, `markets`, `agents`, `analytics`, `settings`)
 * lift the existing workspace-tab factories so we don't reimplement them.
 * Entity-level kinds (`sector`, `agent`, `market`, …) mount the matching
 * detail tab. Anything we haven't ported yet falls back to a stub.
 *
 * `home`, `panel:left`, `panel:right` and `panel:bottom` are NOT registered
 * here anymore — ticketdesk/pages.js owns all four (queue list, filter
 * rail, Team inspector, Console), and install.js merges ticketdesk's map
 * in AFTER this one, so a registration here for any of those four kinds
 * would only ever be shadowed. `settings` is the one kind of the original
 * five that ticketdesk does NOT register, so it's the only one still real.
 *
 * Used to call a module-level `register(kind, factory)` (content_registry.js's
 * old side-effecting pattern). content_registry.js is gone — replaced by
 * `@flexdesk/wm`'s `createContentRegistry(map)`, a per-shell instance built
 * from a plain object handed to it up-front — so this module now BUILDS and
 * returns that `{ kind: factory }` map instead of registering into a
 * singleton. install.js merges this with ticketdesk/pages.js's map and
 * passes the result to `createContentRegistry(...)`.
 */

import { makeLoadingOverlay } from './loading_overlay.js';
import { mountMarketsLanding } from './markets_landing.js';
import { mountScenariosLanding } from './scenarios_landing.js';
import { mountKpisLanding } from './kpis_landing.js';
import { mountAssetsLanding } from './asset_kinds_landing.js';
import { mountMarketKindsLanding } from './market_kinds_landing.js';
// archetypes_landing.js removed (G4.3).
import { mountAnalyticsLanding } from './analytics_landing.js';
import { mountAgentsLanding } from './agents_landing.js';
import { mountTileBreadcrumb } from './tile_breadcrumb.js';
import { SettingsPage } from '../ui/pages/settings_page.js';

import { makeHomeTab }            from '../ecoagent/tabs/home_tab.js';
import { makeSfcLandingTab }      from '../ecoagent/tabs/sfc_landing_tab.js';
import { makeSfcOverviewTab }     from '../ecoagent/tabs/sfc_overview_tab.js';
import { makeSectorTab }          from '../ecoagent/tabs/sector_tab.js';
import { makeAgentTab }           from '../ecoagent/tabs/agent_tab.js';
import { makeAgentSignaturePane, makeAgentCodePane, makeAgentFlowsPane }
    from '../ecoagent/tabs/agent_pane_content.js';
import { makeCodeFilePane }       from '../ecoagent/tabs/code_file_pane.js';
import { mountRowEntryMask }      from '../ecoagent/ui/row_entry_mask.js';
import { makeMarketTab }          from '../ecoagent/tabs/market_tab.js';
import { makeMarketArchetypeTab } from '../ecoagent/tabs/market_archetype_tab.js';
import { makeScenarioTab }        from '../ecoagent/tabs/scenario_tab.js';
import { makeDashboardTab }       from '../ecoagent/tabs/dashboard_tab.js';
import { makeFxOverviewTab }      from '../ecoagent/tabs/fx_overview_tab.js';
import { makeKpiTab }             from '../ecoagent/tabs/kpi_tab.js';
import { makeAssetTab }       from '../ecoagent/tabs/asset_kind_tab.js';
import { makeEventsTab }      from '../ecoagent/tabs/events_tab.js';
import { makeArchetypeViewerTab } from '../ecoagent/tabs/archetype_viewer_tab.js';
import { makeCalibrationTab }     from '../ecoagent/tabs/calibration_tab.js';

// ─── Settings page ────────────────────────────────────────────────────
// The full SettingsPage (category sidebar + search + typed controls) is
// mounted embedded in the tile content slot. The category set is now the
// curated EcoAgent list in core/settings.js (the EcoSim ODE-solver /
// node-graph / charting leftovers were removed from the schema), so no
// allow-list is needed here. Most settings persist to localStorage; the
// backend-read query row cap (config/app_settings.json) is preserved as a
// bridge-backed row under Data.
function mountSettings(content, api, eventBus) {
    const page = new SettingsPage({
        eventBus,
        embedded: true,
        bridgeApi: api || window.pywebview?.api,
    });
    page.mount(content);
    return {
        title: 'Settings',
        ready: page._initPromise,
        destroy: () => { try { page.dispose(); } catch { /* ignore */ } },
    };
}

/**
 * Build bugdesk's page-content map: `{ kind: factory }`, merged by
 * install.js (with ticketdesk/pages.js's map) and handed to
 * `@flexdesk/wm`'s `createContentRegistry(...)`.
 *
 * Internally this still reads as a series of `register(kind, factory)`
 * calls — unchanged from before the content_registry.js extraction — but
 * `register` is now a local closure writing into `content` instead of a
 * side-effecting call into a deleted module-level singleton Map.
 */
export function createPageStubsContent({ api, eventBus }) {
    const content = {};
    const register = (kind, factory) => { content[kind] = factory; };

    // Workspace-tab factories all take (hostEl, entityId, ctx). The ctx
    // wants { logger, workspaceTabs, eventBus }; we route their openTab
    // calls into the WM via a shim built from the surrounding ctx.
    // Wraps the page in a breadcrumb-then-content shell so every tile
    // has its own breadcrumb strip (Project › Mode › Kind › Entity).
    /** Wrap a workspace-tab factory in a "page shell" — breadcrumb strip
     *  at the top, content fills the rest. `kind` is captured at
     *  register time so the breadcrumb knows which crumbs to build. */
    // The loading overlay shown over a page's content slot while its async
    // `mount()` is in flight now lives in `loading_overlay.js` (shared with
    // the agent Code tab's split view).

    // The legacy `workspaceTabs` API tile content calls to open/close
    // tabs + broadcast mutations. Shared by breadcrumbed and bare tabs.
    const makeShim = (ctx) => ({
        // Route through openFromContext so navigation triggered from a
        // split tile / window stays in that container.
        openTab: ({ kind: k, entityId, label, icon, subTab }) =>
            ctx.wm?.openFromContext(ctx, k, { id: entityId, label, icon, subTab }),
        // Open the same content as a NEW TAB in the current tile.
        openInTab: ({ kind: k, entityId, label, icon, subTab }) =>
            ctx.wm?.openInTabFromContext(ctx, k, { id: entityId, label, icon, subTab }),
        // Open the same content in a fresh managed window.
        openInWindow: ({ kind: k, entityId, label, icon, subTab }) =>
            ctx.wm?.navigate(k, { id: entityId, label, icon, subTab }, { ctx, dest: 'window' }),
        // Persist editor sub-state into this tile's WM tab props.
        updateProps: (patch) => {
            try { ctx.wm?.updateActiveTabProps?.(ctx.leafId, patch); }
            catch (err) { console.warn('[shim] updateProps failed', err); }
        },
        // Close just THIS tab (not the whole tile); falls back to closing
        // the tile when it's the last tab. Also broadcasts so sidebars /
        // landings / nav refresh against the mutated project state.
        closeTab: (_id) => {
            try { eventBus?.emit?.('ecoagent:project:changed', { source: 'tab-close' }); } catch {}
            try { ctx.wm?.closeActiveTab?.(ctx.leafId); } catch (err) {
                console.warn('[shim] closeTab failed', err);
            }
        },
        // Non-closing mutations (Save/New/Rename) broadcast so listeners refresh.
        notifyChanged: (domain) => {
            try {
                eventBus?.emit?.('ecoagent:project:changed',
                    { source: 'tab-mutation', domain: domain || null });
            } catch {}
        },
        registerProvider: () => {},
        getActiveTab: () => null,
    });

    // Run a content factory inside a content slot: build the shim, mount
    // the tab, drive the loading overlay, and fan run events into the
    // tab's refresh(reason) hook (tabs that don't self-subscribe to
    // `ecoagent:run:tick` would otherwise freeze mid-run). Returns a
    // teardown that removes listeners + disposes the tab.
    const mountTabBody = (factory, contentSlot, props, ctx) => {
        const shim = makeShim(ctx);
        const tab = factory(contentSlot, props?.id ?? props?.entityId ?? null, {
            logger: null, eventBus, workspaceTabs: shim,
            wm: ctx.wm, leafId: ctx.leafId, windowId: ctx.windowId,
        });
        const hideLoading = makeLoadingOverlay(contentSlot);
        try {
            const ret = tab?.mount?.(props);
            if (ret && typeof ret.then === 'function') {
                ret.then(hideLoading, (err) => {
                    console.error('[page] mount failed', err);
                    hideLoading();
                });
            } else {
                requestAnimationFrame(hideLoading);
            }
        } catch (err) {
            console.error('[page] mount failed', err);
            hideLoading();
        }
        const tickListeners = {};
        if (typeof tab?.refresh === 'function' && eventBus?.on) {
            tickListeners['ecoagent:run:tick']      = () => {
                try { tab.refresh('tick'); }
                catch (err) { console.warn('[page] tick refresh failed', err); }
            };
            tickListeners['ecoagent:run:completed'] = () => {
                try { tab.refresh('run-completed'); }
                catch (err) { console.warn('[page] run-completed refresh failed', err); }
            };
            tickListeners['ecoagent:run:started']   = () => {
                try { tab.refresh('run-started'); }
                catch (err) { console.warn('[page] run-started refresh failed', err); }
            };
            tickListeners['ecoagent:batch:progress']  = () => {
                try { tab.refresh('tick'); }
                catch (err) { console.warn('[page] batch refresh failed', err); }
            };
            // A project mutation (notably an undo/redo restore) changed files on
            // disk; let an open editor tab re-read them. agent_tab honours this
            // (re-loads + re-renders the Settings tab when unfocused, leaves
            // Monaco alone); tabs with a no-op refresh ignore it.
            tickListeners['ecoagent:project:changed'] = () => {
                try { tab.refresh('project-changed'); }
                catch (err) { console.warn('[page] project-changed refresh failed', err); }
            };
            for (const [n, fn] of Object.entries(tickListeners)) {
                eventBus.on(n, fn);
            }
        }
        return () => {
            for (const [n, fn] of Object.entries(tickListeners)) {
                try { eventBus?.off?.(n, fn); } catch {}
            }
            try { tab?.dispose?.(); tab?.unmount?.(); } catch {}
        };
    };

    const tabFactory = (kind, factory) => (host, props, ctx) => {
        host.classList.add('twm-page-shell');
        host.innerHTML = '';
        const contentSlot = document.createElement('div');
        contentSlot.className = 'twm-page-shell__content';
        // Focusable via JS so `document.activeElement` lands inside the
        // page when the tile is activated.
        contentSlot.tabIndex = -1;

        // A breadcrumb navigates the host TILE — meaningless for an entity
        // opened in a standalone managed window, where we want only the
        // entity view. Skip the crumb when mounted in a window.
        let crumb = null;
        if (!ctx?.windowId) {
            const breadcrumbSlot = document.createElement('div');
            breadcrumbSlot.className = 'twm-page-shell__breadcrumb';
            host.appendChild(breadcrumbSlot);
            crumb = mountTileBreadcrumb(kind, props, { ...ctx, eventBus });
            breadcrumbSlot.appendChild(crumb.el);
        }
        host.appendChild(contentSlot);

        const teardown = mountTabBody(factory, contentSlot, props, ctx);
        return {
            destroy: () => {
                teardown();
                try { crumb?.destroy(); } catch {}
            },
        };
    };

    // Like tabFactory but with NO breadcrumb chrome — for transient /
    // form content (e.g. the add-row entry mask) that isn't an entity
    // view. Content still gets the full ctx (wm/leafId) + shim, so it
    // can self-close via wm.closeActiveTab.
    const bareTabFactory = (kind, factory) => (host, props, ctx) => {
        host.classList.add('twm-page-shell');
        host.innerHTML = '';
        const contentSlot = document.createElement('div');
        contentSlot.className = 'twm-page-shell__content';
        contentSlot.tabIndex = -1;
        host.appendChild(contentSlot);
        return { destroy: mountTabBody(factory, contentSlot, props, ctx) };
    };

    /** Stub page with a breadcrumb at the top. Used for kinds that
     *  don't have a workspace-tab factory yet but still want the same
     *  chrome around their placeholder content. */
    const stubPageFactory = (kind, render) => (host, props, ctx) => {
        host.classList.add('twm-page-shell');
        host.innerHTML = '';
        const breadcrumbSlot = document.createElement('div');
        breadcrumbSlot.className = 'twm-page-shell__breadcrumb';
        const contentSlot = document.createElement('div');
        contentSlot.className = 'twm-page-shell__content';
        contentSlot.tabIndex = -1;
        host.appendChild(breadcrumbSlot);
        host.appendChild(contentSlot);
        const crumb = mountTileBreadcrumb(kind, props, { ...ctx, eventBus });
        breadcrumbSlot.appendChild(crumb.el);
        const hideLoading = makeLoadingOverlay(contentSlot);
        const ret = render(contentSlot, props, ctx) || {};
        // Most landings kick off their own async refresh after the
        // synchronous render returns. If render exposes a `ready`
        // promise we await it; otherwise hide on the next frame.
        if (ret.ready && typeof ret.ready.then === 'function') {
            ret.ready.then(hideLoading, hideLoading);
        } else {
            requestAnimationFrame(hideLoading);
        }
        return {
            title: ret.title,
            destroy: () => { try { crumb.destroy(); } catch {} ret.destroy?.(); },
        };
    };

    // 'home' is NOT registered here — ticketdesk/pages.js's queue-list
    // factory owns it (see file doc comment). The dense entity-table from
    // the legacy home is still reachable as the 'entities' kind via the palette.
    register('entities', tabFactory('entities', makeHomeTab));

    register('sfc',           tabFactory('sfc',          makeSfcLandingTab));
    register('sfc-overview',  tabFactory('sfc-overview', makeSfcOverviewTab));
    register('sfc-landing',   tabFactory('sfc',          makeSfcLandingTab));
    register('sector',        tabFactory('sector',       makeSectorTab));

    register('markets', (host, props, ctx) => {
        if (props?.id) return tabFactory('market', makeMarketTab)(host, props, ctx);
        // Top-level Markets landing — mirrors SFC landing layout.
        return stubPageFactory('markets', (content, p, c) =>
            mountMarketsLanding(content, p, c))(host, props, ctx);
    });
    register('market',           tabFactory('market',           makeMarketTab));
    register('market-archetype', tabFactory('market-archetype', makeMarketArchetypeTab));
    // Base market kind (auction mechanic) — `market/kinds/<snake>.py`. Opened
    // from the file tree leaf and the Market-kinds overview. `market-kind` is
    // the file-tree route kind; `market_kind` the kind_taxonomy alias.
    // Base market kind: opens in the SAME editor as a concrete market, in
    // 'base' mode (Attributes/Godley/Code; no Branches), via baseKind.
    const makeMarketKindBaseTab = (h, id, ctx) =>
        makeMarketArchetypeTab(h, id, { ...ctx, baseKind: true });
    register('market-kind', tabFactory('market-kind', makeMarketKindBaseTab));
    register('market_kind', tabFactory('market_kind', makeMarketKindBaseTab));

    register('agents', (host, props, ctx) => {
        if (props?.id) return tabFactory('agent', makeAgentTab)(host, props, ctx);
        return stubPageFactory('agents', (content, p, c) =>
            mountAgentsLanding(content, p, c))(host, props, ctx);
    });
    register('agent',       tabFactory('agent',     makeAgentTab));
    // Agent Code-tab panes as first-class content kinds, so each can open in a
    // new tab or window (via wm.navigate) without dismounting the source pane.
    register('agent_signature', tabFactory('agent_signature', makeAgentSignaturePane));
    register('agent_code',      tabFactory('agent_code',      makeAgentCodePane));
    register('agent_flows',     tabFactory('agent_flows',     makeAgentFlowsPane));
    // Raw project code files — a shared helper module like `lib/economics.py`
    // opens by path in the Monaco editor and autosaves via `code_file_save`.
    register('code',        tabFactory('code',      makeCodeFilePane));
    register('scenario',    tabFactory('scenario',  makeScenarioTab));
    register('dashboard',   tabFactory('dashboard', makeDashboardTab));
    register('fx-overview', tabFactory('fx-overview', makeFxOverviewTab));
    register('kpi',         tabFactory('kpi',         makeKpiTab));
    // Calibration: the tab handles both the landing (no id → list of
    // *.calibration.json configs + reference series) and a selected
    // calibration's run/monitor/apply surface.
    register('calibration', tabFactory('calibration', makeCalibrationTab));
    register('asset_kind',  tabFactory('asset_kind',  makeAssetTab));
    register('events',      tabFactory('events',      makeEventsTab));
    // Asset kind (assets/_kinds/<template>.py) — opens in the SAME
    // editor as a concrete asset kind, in 'base' mode (Settings/Attributes/
    // Code), via AssetTab's asset_kind_base_* fallback.
    register('asset-kind-base', tabFactory('asset-kind-base', makeAssetTab));

    // Top-level Scenarios + KPIs landings (mirror SFC / Markets layout).
    register('scenarios', stubPageFactory('scenarios', (content, p, c) =>
        mountScenariosLanding(content, p, c)));
    register('kpis',      stubPageFactory('kpis', (content, p, c) =>
        mountKpisLanding(content, p, c)));
    register('asset_kinds', stubPageFactory('asset_kinds', (content, p, c) =>
        mountAssetsLanding(content, p, c)));
    // Market kinds overview (auction / matching mechanics). nav entry already
    // declared in kind_taxonomy (`market_kinds`, topNav: markets).
    register('market_kinds', stubPageFactory('market_kinds', (content, p, c) =>
        mountMarketKindsLanding(content, p, c)));

    // Layer 8.B1: Archetypes top-level landing — distinct from the
    // Agents page (runtime-instance view) by being the *schema* view.
    // The standalone "archetypes" landing was removed; per-id routes
    // still resolve to the agent editor for deep-link back-compat.
    // No-id route lands the user on Home rather than a dead surface.
    register('archetypes', (host, props, ctx) => {
        if (props?.id) {
            return tabFactory('archetype', makeAgentTab)(host, props, ctx);
        }
        host.innerHTML =
            '<div class="ea-bp-placeholder">'
            + '<p>This page has moved. Open <strong>Agents</strong> '
            + 'or <strong>Markets</strong> to find what you were looking for.</p>'
            + '</div>';
        return { title: 'Agents' };
    });
    register('archetype', tabFactory('archetype', makeAgentTab));

    // Layer 8.J4 / N1 — read-only viewer for registry entries that
    // don't yet have a dedicated editor (asset_kind_template,
    // archetype_template, market_kind, sector_kind). Routed to from
    // the Archetypes landing when the user clicks one of those rows.
    register('archetype_viewer',
        tabFactory('archetype_viewer', makeArchetypeViewerTab));

    // "Add row" entry mask — opened (target:'tab', transient:true) into
    // the active content tile's tab strip from the bottom-panel browser.
    // No breadcrumb; closes its own tab via wm.closeActiveTab.
    register('row-entry', bareTabFactory('row-entry', (contentSlot, id, tabCtx) => {
        let mask = null;
        return {
            mount: (props) => {
                const sourceId = String(props?.id ?? id ?? '').split('#')[0];
                mask = mountRowEntryMask(contentSlot, {
                    sourceId,
                    onClose: () => tabCtx.wm?.closeActiveTab?.(tabCtx.leafId),
                    onInserted: (sid) =>
                        tabCtx.eventBus?.emit?.('ecoagent:rows:changed', { sourceId: sid }),
                });
            },
            dispose: () => { try { mask?.dispose?.(); } catch { /* ignore */ } },
        };
    }));

    register('analytics', stubPageFactory('analytics', (content, p, c) =>
        mountAnalyticsLanding(content, p, c)));
    register('settings', stubPageFactory('settings', (content) =>
        mountSettings(content, api, eventBus)));

    // Kinds without a dedicated factory yet — leave a JSON-dump stub
    // so clicks from the navigator don't crash.
    for (const k of ['file', 'git-file', 'country', 'currency']) {
        register(k, (host, props) => {
            host.innerHTML = `
                <section class="page-stub">
                    <h1 class="page-stub__title">${_esc(k)} · ${_esc(props.id || '')}</h1>
                    <pre class="page-stub__data">${_esc(JSON.stringify(props, null, 2))}</pre>
                </section>
            `;
            return { title: `${k}: ${props.id || ''}` };
        });
    }

    // Window-placeholder — shown in a tile while its content is mounted
    // in a managed window. Clicking the button brings the window back.
    register('window-placeholder', (host, props, ctx) => {
        host.innerHTML = `
            <div class="twm-window-placeholder">
                <span class="material-symbols-outlined twm-window-placeholder__icon">open_in_new</span>
                <div class="twm-window-placeholder__title">${_esc(props.originalTitle || props.originalKind || 'content')}</div>
                <div class="twm-window-placeholder__hint">is open in a managed window</div>
                <button class="twm-window-placeholder__btn" data-action="bring-back">
                    Bring back to this tile
                </button>
            </div>
        `;
        host.querySelector('[data-action="bring-back"]')?.addEventListener('click', () => {
            ctx.wm?.bringBackWindow?.(props.windowId);
        });
        return { title: `${props.originalTitle || props.originalKind} (window)` };
    });

    // panel:left / panel:right / panel:bottom are NOT registered here —
    // ticketdesk/pages.js owns all three (filter rail, Team inspector,
    // Console) and install.js's merge always prefers its versions (see
    // file doc comment). The legacy nav panel, right-panel salvage, and
    // rich BottomPanel wrapper that used to live here were dead code
    // (permanently shadowed) and have been removed.

    return content;
}
