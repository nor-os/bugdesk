/**
 * settings_content.js — the `settings` content kind: BugDesk's Settings page in
 * a tile, with the breadcrumb strip every other page has.
 *
 * It used to be registered by `tiling/page_stubs.js`, which was the content map
 * of the application BugDesk was built out of: one `settings` entry BugDesk used,
 * sitting among two dozen it did not — SFC landings, markets, agents, scenarios,
 * KPIs, calibration — each importing its own tab module, so a bug tracker loaded
 * the whole of an economic simulator's page set to show a Settings screen. The
 * one kind that was ours now lives with the rest of ours.
 *
 * The page chrome is FlexDesk's (`mountTileBreadcrumb`, `makeLoadingOverlay`),
 * not a local copy of it. The window placeholder that `page_stubs` also
 * registered is not carried over: FlexDesk's content registry supplies one
 * itself whenever an embedder does not.
 */

import { makeLoadingOverlay, mountTileBreadcrumb } from '@flexdesk/wm';
import { SettingsPage } from '../ui/pages/settings_page.js';

/**
 * @param {object} deps
 * @param {object} [deps.eventBus]
 * @param {object} [deps.api]  the bridge handle; the page reads one bridge-backed row
 * @returns {{settings: Function}}
 */
export function createSettingsContent({ eventBus, api } = {}) {
    return {
        settings: (host, props, ctx) => {
            host.classList.add('twm-page-shell');
            host.innerHTML = '';
            const breadcrumbSlot = document.createElement('div');
            breadcrumbSlot.className = 'twm-page-shell__breadcrumb';
            const contentSlot = document.createElement('div');
            contentSlot.className = 'twm-page-shell__content';
            contentSlot.tabIndex = -1;
            host.append(breadcrumbSlot, contentSlot);

            const crumb = mountTileBreadcrumb('settings', props, { ...ctx, eventBus });
            breadcrumbSlot.appendChild(crumb.el);

            // The page loads its bridge-backed rows asynchronously; the overlay
            // stays until they have, rather than showing a form that fills in
            // underneath the user a moment later.
            const hideLoading = makeLoadingOverlay(contentSlot);
            const page = new SettingsPage({
                eventBus,
                embedded: true,
                bridgeApi: api || window.pywebview?.api,
            });
            page.mount(contentSlot);
            Promise.resolve(page._initPromise).then(hideLoading, hideLoading);

            return {
                title: 'Settings',
                destroy: () => {
                    try { crumb.destroy(); } catch { /* already gone */ }
                    try { page.dispose(); } catch { /* already gone */ }
                },
            };
        },
    };
}
