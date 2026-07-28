/**
 * home_page.js — merged home/project-settings page used as the default
 * primary-tile content.
 *
 * Top:  a detail-header strip with project stats (sectors / agents /
 *       markets / scenarios / dashboards counts) — same chrome
 *       the SFC landing uses, for visual consistency.
 *
 * Body: the existing ProjectSetupTab (currencies, countries, FX, MtM)
 *       mounted unchanged into a host inside this page.
 *
 * Below: a compact entity overview — the same dense table as the
 *       legacy home tab, scoped to top-level entities. Lets the user
 *       jump straight from "what's in the project" into editing.
 */

import { makeProjectSetupTab } from '../ecoagent/tabs/project_setup_tab.js';

export function mountHomePage(hostEl, _props, ctx) {
    hostEl.classList.add('twm-home-page');
    hostEl.innerHTML = `
        <header class="ea-detail-header twm-home-page__header" data-role="header">
            <h2>Home</h2>
            <span class="ea-detail-header__field">
                <span>sectors</span><strong data-stat="sectors">—</strong>
            </span>
            <span class="ea-detail-header__field">
                <span>agents</span><strong data-stat="agents">—</strong>
            </span>
            <span class="ea-detail-header__field">
                <span>markets</span><strong data-stat="markets">—</strong>
            </span>
            <span class="ea-detail-header__field">
                <span>scenarios</span><strong data-stat="scenarios">—</strong>
            </span>
            <span class="ea-detail-header__field">
                <span>dashboards</span><strong data-stat="dashboards">—</strong>
            </span>
            <span class="ea-detail-header__spacer"></span>
            <small class="ea-text--muted">project settings</small>
        </header>
        <div class="twm-home-page__body" data-role="setup-host"></div>
    `;

    const setupHost = hostEl.querySelector('[data-role="setup-host"]');
    const shim = {
        openTab: ({ kind, entityId, label, icon, subTab }) =>
            ctx?.wm?.openInPrimary(kind, { id: entityId, label, icon, subTab }),
        closeTab: () => {},
        registerProvider: () => {},
        getActiveTab: () => null,
    };
    let setup = null;
    try {
        setup = makeProjectSetupTab(setupHost, null, {
            logger: null, eventBus: ctx?.eventBus, workspaceTabs: shim,
        });
        setup?.mount?.();
    } catch (err) {
        console.error('[home_page] project-setup mount failed', err);
    }

    const api = window.pywebview?.api;
    const setStat = (key, n) => {
        const el = hostEl.querySelector(`[data-stat="${key}"]`);
        if (el) el.textContent = String(n);
    };
    const refresh = async () => {
        if (!api) return;
        try {
            const [sectors, archs, markets, scenariosRes, dashboards] =
                await Promise.all([
                    _toArr(api.sectors_list?.()),
                    _toArr(api.agents_list?.()),
                    _toArr(api.market_instances_list?.()),
                    api.scenarios_list?.(),
                    _toArr(api.analytics_dashboards_list?.()),
                ]);
            setStat('sectors',    sectors.length);
            setStat('agents',     archs.length);
            setStat('markets',    markets.length);
            const scenList = Array.isArray(scenariosRes?.scenarios) ? scenariosRes.scenarios
                          : Array.isArray(scenariosRes) ? scenariosRes : [];
            setStat('scenarios',  scenList.length);
            setStat('dashboards', dashboards.length);
        } catch (err) {
            console.warn('[home_page] stats refresh failed', err);
        }
    };
    refresh();
    const onProjectChanged = () => refresh();
    ctx?.eventBus?.on?.('ecoagent:project:changed', onProjectChanged);
    ctx?.eventBus?.on?.('ecoagent:archetypes:changed', onProjectChanged);

    return {
        title: 'Home',
        destroy: () => {
            try { setup?.dispose?.(); } catch {}
            ctx?.eventBus?.off?.('ecoagent:project:changed', onProjectChanged);
            ctx?.eventBus?.off?.('ecoagent:archetypes:changed', onProjectChanged);
        },
    };
}

async function _toArr(p) {
    try {
        const v = await p;
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}
