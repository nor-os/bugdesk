/**
 * settings_content.js — BugDesk's Settings page: in a modal dialog
 * (`openSettings`, how it is opened since STORY-0044), and still as the
 * `settings` content kind in a tile, so a desktop layout saved with a Settings
 * tab in it opens as it did.
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
import { openModal } from '@flexdesk/widgets';
import { SettingsPage } from '../ui/pages/settings_page.js';

/**
 * Open Settings in a modal dialog over the workspace, on one of its pages
 * (STORY-0044): from the menu, and from every button that sends you to a
 * Settings page ("Record types" on the snooze notice, say). Like Help, but
 * larger, because Record types, Workflow and Team are wide.
 *
 * The dialog is FlexDesk's `openModal`, so its backdrop runs between the top bar
 * and the status bar: both stay clickable and unblurred while it is open (and
 * the top bar still drags the desktop window). Asked again while it is open, it
 * switches to the page asked for rather than opening a second one.
 *
 * @param {string} [category]  a settings category id: 'recordTypes', 'team', …
 * @param {object} [panelProps] for that page's editor: `{ store }` on Record types
 */
let openDialog = null;

export function openSettings(category = null, panelProps = null) {
    if (openDialog) {
        if (category) {
            if (panelProps) openDialog.page._panelProps = { ...openDialog.page._panelProps, [category]: panelProps };
            // Forced: the same page asked for again redraws it with the new props.
            openDialog.page._activeCategory = null;
            openDialog.page._switchCategory(category);
        }
        return openDialog.done;
    }

    const content = document.createElement('div');
    content.className = 'bd-settings-dialog twm-page-shell__content';
    const page = new SettingsPage({
        eventBus: window.__bugdesk?.eventBus,
        embedded: true,
        bridgeApi: window.pywebview?.api,
        category,
        panelProps,
    });
    // Larger than Help (1000×700 at most), and never more than ~92% of the window.
    const width = Math.max(640, Math.min(1280, Math.round(window.innerWidth * 0.92)));
    const height = Math.max(480, Math.min(860, Math.round((window.innerHeight - 55) * 0.92)));
    const done = openModal({
        title: 'Settings',
        icon: 'settings',
        content,
        width,
        height,
        maximizable: true,
        onMount: () => {
            const hideLoading = makeLoadingOverlay(content);
            page.mount(content);
            Promise.resolve(page._initPromise).then(hideLoading, hideLoading);
        },
    }).finally(() => {
        try { page.dispose(); } catch { /* already gone */ }
        openDialog = null;
    });
    openDialog = { page, done };
    return done;
}

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
                category: props?.category || null,
                panelProps: props?.panelProps || null,
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
