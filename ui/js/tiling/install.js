/**
 * install.js — tiling-shell post-bootstrap glue.
 *
 * Flow:
 *
 *   1. Ecosim shell mounts (global-top-bar, .container with workspace
 *      shell + panels, global-bottom-bar).
 *   2. installProjectSelector resolves the active project.
 *      (BugDesk drops the "Model OK" status indicator entirely; there
 *      never was a sim-controls topbar to decorate, so that step is gone.)
 *   4. We RELOCATE the populated `.sim-controls` (Run cluster, Step,
 *      Pause, Stop, batch toggle) from `.workspace-top-bar` up into
 *      `.global-top-bar .bar-right`. Sim controls now live in the
 *      very top bar, next to the panel-toggle buttons.
 *   5. We DELETE — not hide — the entire workspace container
 *      (`.container`, `.workspace-top-bar`, the global search input)
 *      and everything inside it. No leftover invisible DOM.
 *   6. Restructure body: top bar → tiling WM host → bottom bar.
 *   7. Mount the WM in the middle, install palette + keymap, add
 *      the desktop selector to the bottom bar.
 */

import { installProjectSelector } from '../ecoagent/project_selector.js';

import { WindowManager } from './wm.js';
import { createCommandPalette } from './command_palette.js';
import { installKeymap } from './keymap.js';
import { installHistoryBack } from './history_nav.js';
import { createPageStubsContent } from './page_stubs.js';
import { showContextMenu } from '../ecoagent/ui/context_menu.js';
import { openForm } from '../ecoagent/ui/modal.js';
import { taxonomy, activeTopNavKind } from './kind_taxonomy.js';
import { openTileTabMenu } from './tile_tab_menu.js';
import { HelpModal } from '../help/help_modal.js';

import { createContentRegistry } from '@flexdesk/wm';
import { createPywebviewHost } from '@flexdesk/host';

export async function installTilingShell({ eventBus, logger, runtime } = {}) {
    const log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };

    // 1. Project must be open before we tear down the workspace area.
    let project;
    try { project = await installProjectSelector({ eventBus, logger }); }
    catch (err) { console.error('[tiling-shell] project selector threw', err); return null; }
    if (!project) { log.info?.('tiling-shell: no project active, deferring install'); return null; }

    // 2. BugDesk: no model/simulation health. Remove the bottom-left status
    // indicator ("Model OK") entirely rather than decorating it.
    document.getElementById('status-indicator')?.remove();

    // 2b. Dispose the GlobalSearchController — it owns the .bar-center
    //     search input AND a global Ctrl+K keydown listener that hijacks
    //     the chord. Removing just its DOM leaves the keydown listener
    //     stealing Ctrl+K and the controller is unreachable from here.
    try { runtime?.globalSearchController?.dispose?.(); } catch (err) {
        console.warn('[tiling-shell] could not dispose globalSearchController', err);
    }

    // 3. TicketDesk: no simulation — drop the sim-controls cluster and
    //    skip the Ecosim scenario picker entirely.
    document.querySelector('.workspace-top-bar .sim-controls')?.remove();
    const scenarioTabsShim = {
        openTab: ({ kind, entityId, label, icon, subTab }) => null,
        registerProvider: () => {},
        getActiveTab: () => null,
    };

    // 4. Replace the global search bar (.bar-center) with the page
    //    shortcuts: home / sfc / markets / agents / analytics / settings.
    _installPageShortcuts();

    // 4b. Trim the menu bar — View and Run aren't needed (panel toggles
    //    live next door; Run is in the sim controls cluster), then
    //    collapse the remaining File/Edit/Help into a single hamburger
    //    button mounted to the left of the EcoAgent brand.
    _trimMenuBar();
    _installHamburgerMenu();

    // 5. Delete the entire workspace shell (sidebars, panels, resizers,
    //    bottom panel, fl-bar, fixed-200). Don't hide — remove.
    document.querySelector('.container')?.remove();
    document.querySelector('.workspace-top-bar')?.remove();
    document.querySelector('.workspace-shell')?.remove();

    // 6. Make body a 3-row flex column: top bar / WM host / bottom bar.
    document.body.classList.add('twm-body');
    const top = document.querySelector('.global-top-bar');
    const bottom = document.querySelector('.global-bottom-bar');
    const wmHost = document.createElement('div');
    wmHost.className = 'twm-host';
    if (top && bottom) document.body.insertBefore(wmHost, bottom);
    else document.body.appendChild(wmHost);

    // 7. Build the content registry, then the WM + palette + keymap.
    //
    // Content is built as a plain { kind: factory } map and handed to
    // @flexdesk/wm's createContentRegistry(...) up front — content_registry.js
    // (the old module-level Map + register() side effect) is gone; see
    // page_stubs.js / ticketdesk/pages.js for why. BugDesk's own pages are
    // merged AFTER the stubs so shared kinds ('home', the panel:* kinds)
    // resolve to the BugDesk factories, exactly as `register()` order used
    // to guarantee.
    const pageStubsContent = createPageStubsContent({ api: window.pywebview?.api, eventBus });
    let ticketDeskContent = {};
    let backlogContent = {};
    let trackerContent = {};
    const trackerMode = window.__BUGDESK_CONFIG__?.mode === 'tracker';
    // loadData()/loadBacklog() fetch both stores from the bridge and populate
    // the live stores BEFORE the first page renders (wm.load() below) so
    // queues/backlog/team start with real data rather than empty arrays.
    //
    // The two loads are independent, so they run together and each reports its
    // own failure: a broken backlog store must not leave the bug queue empty,
    // and vice versa — that is precisely what a shared try/catch would do.
    try {
        const { createTicketDeskContent } = await import('../ticketdesk/pages.js');
        const { createBacklogContent } = await import('../ticketdesk/backlog_pages.js');
        const { createNewItemContent } = await import('../ticketdesk/new_item.js');
        const { loadData } = await import('../ticketdesk/data.js');
        const { loadBacklog } = await import('../ticketdesk/backlog_data.js');
        const [bugs, backlog] = await Promise.allSettled([loadData(), loadBacklog()]);
        if (bugs.status === 'fulfilled') log.info?.('bugdesk: loaded', { bugs: bugs.value.count });
        else console.error('[bugdesk] loadData failed — the queue will render empty', bugs.reason);
        if (backlog.status === 'fulfilled') log.info?.('bugdesk: loaded', { backlog: backlog.value.count });
        else console.error('[bugdesk] loadBacklog failed — the backlog will render empty', backlog.reason);

        ticketDeskContent = createTicketDeskContent({ eventBus });
        backlogContent = { ...createBacklogContent({ eventBus }), ...createNewItemContent({ eventBus }) };
        // Tracker mode only, and imported only then: the dashboard is dead
        // weight in a deployment whose taxonomy has no chip pointing at it.
        if (trackerMode) {
            const { createTrackerContent } = await import('../ticketdesk/tracker_pages.js');
            trackerContent = createTrackerContent({ eventBus });
        }
    } catch (err) {
        console.error('[bugdesk] page registration failed', err);
    }
    // Order is the override order. Tracker last: it deliberately re-points
    // `home` at the dashboard (see createTrackerContent).
    const content = createContentRegistry({
        ...pageStubsContent, ...ticketDeskContent, ...backlogContent, ...trackerContent,
    });

    // The host port (see @flexdesk/host's createPywebviewHost doc comment —
    // "the adapter a standalone consumer copies"). The bridge implements
    // workspace_state_read/write against the CURRENT USER's profile directory
    // (server/UserConfig.cs), so a tile layout follows the person rather than
    // the checkout — and, unlike before, actually survives a reload: these two
    // calls used to fall through to the permissive catch-all, which answered a
    // read with `{ok:true}` and lost every layout ever saved.
    const host = createPywebviewHost({
        resolvePath: (key) => `${key}.json`,
        logger: log,
    });

    const wm = new WindowManager({
        rootEl: wmHost,
        api: window.pywebview?.api,
        host,
        content,
        eventBus,
        ctx: { api: window.pywebview?.api, eventBus,
               onTileContextMenu: (leafId, x, y) => _tileContextMenu(wm, leafId, x, y),
               onTileTabMenu:     (leafId, x, y) => _tileTabMenu(wm, leafId, x, y) },
        onChange: () => { _syncPanelToggleButtons(wm); _syncDesktopBar(wm); _syncPageShortcuts(wm); },
    });

    // Subscribe to the bus too (belt-and-braces): any other module that
    // mutates the WM state will fan out to the chrome sync calls.
    eventBus?.on?.('wm:changed', () => {
        _syncPanelToggleButtons(wm);
        _syncDesktopBar(wm);
        _syncPageShortcuts(wm);
    });
    const palette = createCommandPalette({ wm, api: window.pywebview?.api });
    installKeymap({ wm, palette });
    // The browser's Back gesture walks up exactly like Backspace does,
    // instead of abandoning the app and its tile layout.
    installHistoryBack({ wm });

    // Late-bind the scenario widget's "open scenario tab" path through
    // the WM. The widget was installed earlier (before `wm` existed)
    // with a no-op openTab; patch it now that the WM is built.
    scenarioTabsShim.openTab = ({ kind, entityId, label, icon, subTab }) =>
        wm.openInPrimary(kind, { id: entityId, label, icon, subTab });

    // 8. Take panel ownership away from the legacy shell FSMs (they would
    //    otherwise keep writing .active/.pinned/disabled to the same toggle
    //    buttons the WM owns), then rewire the top-bar toggles to the WM,
    //    add the palette button and the desktop bar.
    runtime?.shell?.retireLegacyPanels?.();
    _rewirePanelToggles(wm);
    _installPaletteButton(palette);
    _installTopBarResponsive();
    // Desktops (views) feature: install the bottom-bar desktop chip strip
    // with its add / switch / rename / delete controls. BugDesk boots with
    // a single desktop labeled "WORK" (below), but the bar lets the user
    // add and switch between multiple desktops again.
    _installDesktopBar(wm);
    _installUserChip(wm, eventBus);
    _wirePageShortcuts(wm);

    await wm.load();

    // BugDesk: a single desktop named "WORK". No multi-desktop seeding.
    try {
        if (wm.desktops.desktops[0]) wm.desktops.desktops[0].label = 'WORK';
    } catch (err) {
        log.warn?.('bugdesk desktop labeling failed', { err });
    }

    // TicketDesk: real Search + New Ticket actions in the top bar. Both
    // lead to the SAME mask page — mode decides whether the entered data
    // creates a ticket or searches for one.
    _installTicketActions(wm);

    _syncPanelToggleButtons(wm);
    _syncDesktopBar(wm);
    _syncPageShortcuts(wm);

    window.__twm = { wm, palette };

    // Live updates: the bridge watches the store directories and pushes changes
    // that BugDesk did not make. Installed after wm.load() so the pages that
    // react to the events are already mounted and subscribed.
    try {
        const { installLiveUpdates } = await import('../ticketdesk/live.js');
        installLiveUpdates({ eventBus, logger: log });
    } catch (err) {
        log.warn?.('live updates failed to install', { err });
    }

    // Settings › General › Authorship writes through to the per-user profile,
    // so the name the UI signs comments with and the name GET /api/config
    // reports to the skills can never disagree. See first_run.js.
    try {
        const [{ installAuthorshipWriteThrough }, { getSetting }] = await Promise.all([
            import('../ticketdesk/first_run.js'),
            import('../core/settings.js'),
        ]);
        installAuthorshipWriteThrough({ eventBus, getSetting });
    } catch (err) {
        log.warn?.('authorship write-through failed to install', { err });
    }

    // Watch for external project-file edits (text editor, git pull,
    // etc.) and surface them as a top-of-page banner with [Reload].
    // The bridge mirror won't update on its own otherwise.
    try {
        const { installExternalChangesBanner } = await import(
            '../ecoagent/ui/external_changes_banner.js');
        installExternalChangesBanner({ api: window.pywebview?.api, eventBus });
    } catch (err) {
        log.warn?.('external-changes banner failed to install', { err });
    }

    // If the last run ended abnormally, `<project>/.ecoagent/current.run/`
    // still has its manifest + log on disk. Surface a banner with
    // Resume / Save as / Discard so the user can act on it.
    try {
        const { checkAndShowOrphanedRun } = await import(
            '../ecoagent/ui/orphaned_run_banner.js');
        checkAndShowOrphanedRun({ api: window.pywebview?.api, eventBus });
    } catch (err) {
        log.warn?.('orphaned-run banner check failed', { err });
    }

    log.info?.('tiling shell installed', { project: project.path || project.name });
    return { wm, palette };
}

/** Move `.workspace-top-bar > .sim-controls` (+ batch toggle, step btn,
 *  time-display etc. that runtime_controls inserts there) into
 *  `.global-top-bar .bar-right`, before the existing panel-toggles. */
function _relocateSimControls() {
    const sim = document.querySelector('.workspace-top-bar .sim-controls');
    if (!sim) return;
    const barRight = document.querySelector('.global-top-bar .bar-right');
    if (!barRight) return;
    sim.classList.add('twm-sim-controls');
    const togglesGroup = barRight.querySelector('.panel-toggles');
    if (togglesGroup) barRight.insertBefore(sim, togglesGroup);
    else barRight.insertBefore(sim, barRight.firstChild);
}

/* The old search bar's DOM home was `.global-top-bar .bar-center`;
 * its container is now repurposed by _installPageShortcuts as the page-
 * shortcut row. The GlobalSearchController is disposed at the top of
 * installTilingShell so its keydown listener no longer steals Ctrl+K. */

/** Replace the .bar-center contents with home/sfc/markets/agents/...
 *  top-nav buttons. Rename the leftover legacy class so the element
 *  reads as what it actually does now. */
function _installPageShortcuts() {
    const host = document.querySelector('.global-top-bar .bar-center');
    if (!host) return;
    host.innerHTML = '';
    host.classList.remove('global-search-container');
    host.classList.add('twm-top-nav');
    for (const k of taxonomy.topNavEntries()) {
        const btn = document.createElement('button');
        btn.className = 'twm-top-nav__btn has-tooltip';
        btn.dataset.kind = k.kind;
        btn.dataset.tooltip = k.label;
        btn.dataset.tooltipPlacement = 'bottom';
        btn.setAttribute('aria-label', k.label);
        btn.innerHTML = `
            <span class="material-symbols-outlined twm-top-nav__icon">${k.icon}</span>
            <span class="twm-top-nav__label">${k.label}</span>
        `;
        host.appendChild(btn);
    }
}

function _wirePageShortcuts(wm) {
    const host = document.querySelector('.global-top-bar .bar-center.twm-top-nav');
    if (!host) return;
    host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-kind]');
        if (!btn) return;
        wm.openInPrimary(btn.dataset.kind);
    });
}

function _syncPageShortcuts(wm) {
    const host = document.querySelector('.global-top-bar .bar-center.twm-top-nav');
    if (!host) return;
    // Shared with the left rail (see kind_taxonomy.js's activeTopNavKind) so the
    // lit chip and the rail below it can never disagree about which store the
    // user is in.
    const topNavKind = activeTopNavKind(wm);
    host.querySelectorAll('[data-kind]').forEach((b) => {
        b.classList.toggle('twm-top-nav__btn--on', b.dataset.kind === topNavKind);
    });
}

/** Search + New Item in the top bar, left of the panel toggles.
 *
 *  There is NO "New Bug" button here any more. Two per-store buttons asked the
 *  user to choose a store before saying what they were filing, which is
 *  backwards — the store is a property of the thing. One "New item" dialog now
 *  covers both (see ticketdesk/new_item.js), and the full-page bug mask, which
 *  is still richer, is reached from the Bugs page's own New Bug button. */
function _installTicketActions(wm) {
    const barRight = document.querySelector('.global-top-bar .bar-right');
    if (!barRight || barRight.querySelector('.td-topbar-actions')) return;
    const wrap = document.createElement('div');
    wrap.className = 'td-topbar-actions';
    wrap.innerHTML = `
        <button class="ea-btn" data-td="search" title="Search">
            <span class="material-symbols-outlined">search</span> Search</button>
        <button class="ea-btn ea-btn--primary" data-td="item" title="New item">
            <span class="material-symbols-outlined">add</span> New Item</button>`;
    wrap.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-td]');
        if (!btn) return;
        if (btn.dataset.td === 'item') {
            // A tab, not a dialog: filing something means writing a description
            // and looking a parent up, which a modal makes hostile.
            const { openNewItem } = await import('../ticketdesk/new_item.js');
            openNewItem(wm);
            return;
        }
        // Search always opens as a NEW TAB, never in place. openInPrimary swaps the primary tile's
        // page, so hitting Search would take over whatever you were reading - and searching is
        // something you do while looking at something else, so it has to arrive alongside it.
        // openInTabFromContext with an empty context appends a tab to the primary tile.
        wm.openInTabFromContext({}, 'ticket', { mode: 'search', label: 'Bug Search' });
    });
    const togglesGroup = barRight.querySelector('.panel-toggles');
    if (togglesGroup) barRight.insertBefore(wrap, togglesGroup);
    else barRight.insertBefore(wrap, barRight.firstChild);
}

/**
 * Strip the menus that mean nothing in BugDesk, leaving only Help for the
 * hamburger to collect.
 *
 *   View  — the panel toggles next door do this, visibly and in one click.
 *   Run   — there is no simulation.
 *   File  — New…, Open Project…, Save, Save All, Exit. BugDesk has no project
 *           to open and nothing to save: the store is a directory of markdown
 *           files and every edit is written the moment it is made. A Save that
 *           does nothing is worse than no Save, because it implies the rest of
 *           the app might not have saved.
 *   Edit  — Undo and Redo ship permanently disabled, and Find duplicates the
 *           per-column filters and Ctrl+K.
 */
function _trimMenuBar() {
    const drop = new Set(['view', 'run', 'file', 'edit']);
    const menu = document.querySelector('.global-top-bar .app-menu');
    if (!menu) return;
    for (const item of menu.querySelectorAll('.menu-item')) {
        const label = item.querySelector('span')?.textContent?.trim().toLowerCase();
        if (drop.has(label)) item.remove();
    }
}

/** Insert a hamburger button to the LEFT of the EcoAgent brand. Clicking
 *  it opens a unified context menu listing the entries of every
 *  remaining .menu-item dropdown (File / Edit / Help). Their `.menu-entry`
 *  buttons are kept in the DOM (just hidden) so we can trigger their
 *  existing handlers via .click() — no need to re-implement file/save/
 *  about logic here. */
function _installHamburgerMenu() {
    const menu = document.querySelector('.global-top-bar .app-menu');
    if (!menu) return;
    const brand = menu.querySelector('.ecoagent-brand');
    if (!brand) return;

    const ham = document.createElement('button');
    ham.type = 'button';
    ham.id = 'twm-hamburger-btn';
    ham.className = 'twm-hamburger-btn has-tooltip';
    ham.dataset.tooltip = 'Menu';
    ham.dataset.tooltipPlacement = 'bottom';
    ham.setAttribute('aria-label', 'Open menu');
    ham.innerHTML = '<span class="material-symbols-outlined">menu</span>';

    ham.addEventListener('click', (e) => {
        e.stopPropagation();
        const items = [];
        const menuItems = menu.querySelectorAll('.menu-item');
        menuItems.forEach((mi, idx) => {
            if (idx > 0 && items.length > 0) items.push({ separator: true });
            for (const child of mi.querySelectorAll('.menu-dropdown > *')) {
                if (child.tagName === 'HR') {
                    items.push({ separator: true });
                    continue;
                }
                if (child.classList?.contains?.('menu-entry')) {
                    if (!child.id) continue;
                    const disabled = child.disabled
                                  || child.classList.contains('disabled')
                                  || child.getAttribute('aria-disabled') === 'true';
                    // Extract label without the shortcut hint span.
                    const label = (child.firstChild?.textContent
                                ?? child.textContent
                                ?? child.id).trim();
                    items.push({
                        label,
                        action: child.id,
                        disabled,
                    });
                }
            }
        });
        // Settings: not a top-bar shortcut anymore, so we surface it
        // here. The hidden DOM id `twm-open-settings` is a virtual
        // action handled at the callback below — no real menu-entry
        // button needs to exist.
        // The collapsed Help dropdown only exposes "Help Topics" + "About",
        // so surface a direct jump to the keyboard-shortcuts topic of the
        // existing Help modal (a virtual action, like Settings below).
        if (items.length > 0) items.push({ separator: true });
        items.push({
            label: 'Keyboard shortcuts',
            icon: 'keyboard',
            action: 'twm-open-shortcuts',
        });
        items.push({
            label: 'Settings',
            icon: 'settings',
            action: 'twm-open-settings',
        });
        items.push({
            label: 'Change your name…',
            icon: 'badge',
            action: 'twm-change-name',
        });
        // Also in Settings › General › Authorship. Here too because "who can I
        // assign this to" is a question you have while looking at a record, not
        // while browsing settings.
        items.push({
            label: 'Collaborators…',
            icon: 'group',
            action: 'twm-collaborators',
        });
        const rect = ham.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom, items, (action) => {
            if (action === 'twm-open-shortcuts') {
                HelpModal.open('keyboard-shortcuts');
                return;
            }
            if (action === 'twm-open-settings') {
                window.__twm?.wm?.openInPrimary?.('settings');
                return;
            }
            if (action === 'twm-collaborators') {
                import('../ticketdesk/collaborators.js')
                    .then((m) => m.openCollaborators({ eventBus: window.__ecoagent?.eventBus }))
                    .catch((err) => console.error('[bugdesk] collaborators dialog failed', err));
                return;
            }
            if (action === 'twm-change-name') {
                // A dialog, not the Settings page: opened in the primary tile
                // from a focused side tile, the page change happened somewhere
                // the user was not looking and read as "nothing happened".
                import('../ticketdesk/first_run.js')
                    .then((m) => m.openIdentityDialog({ eventBus: window.__ecoagent?.eventBus }))
                    .catch((err) => console.error('[bugdesk] identity dialog failed', err));
                return;
            }
            document.getElementById(action)?.click();
        });
    });

    menu.insertBefore(ham, brand);
    // Hide the now-redundant File/Edit/Help dropdowns. The .menu-entry
    // buttons inside stay in the DOM (just unreachable visually) so
    // their existing click handlers remain callable.
    menu.querySelectorAll('.menu-item').forEach((mi) => {
        mi.classList.add('twm-hidden-menu-item');
    });
}

/** Hamburger button in a tile's bottom tab bar opens this menu — a
 *  compact list of the OPEN TABS in that leaf, anchored to the button, so
 *  the user can pick / switch to a tab when the strip overflows. Selecting
 *  an entry activates that tab on the originating leaf (leaf-id captured at
 *  click time, so a focus change between click and pick doesn't reroute
 *  the switch). */
function _tileTabMenu(wm, leafId, x, y) {
    const tree = wm.desktops.active().tree;
    const leaf = tree.get(leafId);
    if (!leaf || leaf.kind !== 'leaf') return;
    const tabs = Array.isArray(leaf.tabs) ? leaf.tabs : [];
    if (tabs.length === 0) return;
    const activeIdx = Math.max(0, Math.min(tabs.length - 1, leaf.activeTabIdx || 0));
    openTileTabMenu({
        x, y,
        tabs: tabs.map((t) => ({ kind: t.kind, title: t.title })),
        activeIdx,
        onPick: (idx) => {
            tree.setActiveLeafTab(leafId, idx);
            tree.focus(leafId);
            wm.renderer.render();
            wm._persist?.();
            wm._notifyChange?.('tab-switch-from-menu');
        },
    });
}

/** Open a context menu over a tile leaf with structural actions. */

function _tileContextMenu(wm, leafId, x, y) {
    const tree = wm.desktops.active().tree;
    const leaf = tree.get(leafId);
    if (!leaf) return;
    const isPanel = String(leaf.content?.kind || '').startsWith('panel:');
    tree.focus(leafId);
    wm.renderer._updateFocusClasses();

    const items = [
        { label: 'Split horizontally', icon: 'splitscreen_vertical_add', action: 'split-h' },
        { label: 'Split vertically',   icon: 'splitscreen_add',          action: 'split-v' },
        { separator: true },
        { label: 'Open in new tab',    icon: 'tab',
          action: 'open-tab',    disabled: isPanel || !leaf.content },
        { label: 'Open in new window', icon: 'open_in_full',
          action: 'open-window', disabled: isPanel || !leaf.content },
        { label: 'Promote to window', icon: 'open_in_new',
          action: 'promote', disabled: isPanel || !leaf.content },
    ];
    if (wm.desktops.desktops.length > 1 && !isPanel) {
        for (const [i, d] of wm.desktops.desktops.entries()) {
            if (i === wm.desktops.activeIdx) continue;
            items.push({ label: `Move to desktop ${d.label}`, icon: 'sweep',
                         action: `move:${i}` });
        }
    }
    items.push({ separator: true });
    items.push({ label: 'Close tile', icon: 'close', action: 'close',
                 danger: true, disabled: isPanel });

    showContextMenu(x, y, items, (action) => {
        if (action === 'split-h') wm.split('h');
        else if (action === 'split-v') wm.split('v');
        else if (action === 'open-tab') {
            const c = leaf.content;
            if (c) wm.openInTabFromContext({ leafId }, c.kind, c.props || {});
        }
        else if (action === 'open-window') {
            const c = leaf.content;
            if (c) wm.navigate(c.kind, c.props || {}, { target: 'window' });
        }
        else if (action === 'promote') wm.toggleManagedFocused();
        else if (action === 'close')   wm.closeFocused();
        else if (action?.startsWith?.('move:')) {
            wm.moveFocusedToDesktop(Number(action.slice(5)));
        }
    });
}

function _rewirePanelToggles(wm) {
    const map = {
        'toggle-left-panel': 'left',
        'toggle-right-panel': 'right',
        'toggle-bottom-panel': 'bottom',
    };
    for (const [id, which] of Object.entries(map)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        const fresh = btn.cloneNode(true);
        // cloneNode copies any legacy state the shell/FSM left on the button
        // (.active/.pinned/.disabled, the disabled attr, aria-pressed). Strip
        // it so the WM is the sole, clean source of truth — _syncPanelToggle-
        // Buttons manages only .panel-toggle-btn--on from here on.
        fresh.classList.remove('active', 'pinned', 'disabled');
        fresh.disabled = false;
        fresh.removeAttribute('aria-disabled');
        fresh.removeAttribute('aria-pressed');
        btn.replaceWith(fresh);
        fresh.addEventListener('click', () => wm.togglePanel(which));
    }
}

function _syncPanelToggleButtons(wm) {
    const map = {
        'toggle-left-panel': 'left',
        'toggle-right-panel': 'right',
        'toggle-bottom-panel': 'bottom',
    };
    for (const [id, which] of Object.entries(map)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.classList.toggle('panel-toggle-btn--on', wm.isPanelOpen(which));
    }
}

function _installPaletteButton(palette) {
    const host = document.querySelector('.global-top-bar .panel-toggles');
    if (!host) return;
    if (host.querySelector('#twm-palette-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'twm-palette-btn';
    btn.className = 'panel-toggle-btn has-tooltip';
    btn.dataset.tooltip = 'Command palette (Ctrl+K)';
    btn.dataset.tooltipPlacement = 'bottom';
    btn.setAttribute('aria-label', 'Open command palette');
    btn.innerHTML = '<span class="material-symbols-outlined">menu_open</span>';
    btn.addEventListener('click', () => palette.toggle());
    host.insertBefore(btn, host.firstChild);
}

/**
 * Collapse low-priority top-bar chrome when the window is too narrow for
 * everything to fit. The top bar is `justify-content: space-between` with an
 * empty center, so the content fits iff (left section + center + right section)
 * width ≤ the bar's width. When it doesn't, drop items in priority order:
 *   1. the command-palette button (#twm-palette-btn) — still reachable via Ctrl+K
 *   2. the "EcoAgent" brand wordmark (.ecoagent-brand) — purely decorative
 * Driven by a ResizeObserver on the bar so it reacts live to window resizing.
 */
function _installTopBarResponsive() {
    const topBar = document.querySelector('.global-top-bar');
    if (!topBar) return;
    const appMenu = topBar.querySelector('.app-menu');
    const barCenter = topBar.querySelector('.bar-center');
    const barRight = topBar.querySelector('.bar-right');
    if (!appMenu || !barRight) return;

    // Re-query the collapsible targets on each pass: the palette button is
    // inserted just before this runs, and the brand lives in the shell markup.
    const overflows = () => {
        const need = appMenu.scrollWidth
            + (barCenter ? barCenter.scrollWidth : 0)
            + barRight.scrollWidth;
        return need > topBar.clientWidth + 1; // 1px slack for sub-pixel rounding
    };

    const apply = () => {
        const paletteBtn = topBar.querySelector('#twm-palette-btn');
        const brand = topBar.querySelector('.ecoagent-brand');
        // Reveal both first so the measurement reflects the full natural width,
        // then hide in priority order until the bar fits. Reading scrollWidth
        // after each style change forces a synchronous reflow, so the next
        // measurement already accounts for the item we just hid.
        if (paletteBtn) paletteBtn.style.display = '';
        if (brand) brand.style.display = '';
        if (!overflows()) return;
        if (paletteBtn) {
            paletteBtn.style.display = 'none';
            if (!overflows()) return;
        }
        if (brand) brand.style.display = 'none';
    };

    apply();
    // Fonts (Material Symbols) can load after first paint and change widths.
    if (document.fonts?.ready) document.fonts.ready.then(apply).catch(() => {});
    try {
        new ResizeObserver(apply).observe(topBar);
    } catch (_) {
        window.addEventListener('resize', apply);
    }
}

/**
 * Who you are, in the bottom bar, always visible.
 *
 * The name already lived in Settings › General › Authorship, but nothing on
 * screen said which of several people BugDesk currently thinks you are — and in
 * a repo two people share, that is the one piece of state you most need to be
 * able to check at a glance before you comment as somebody else. Clicking it
 * opens the setting that changes it.
 */
function _installUserChip(wm, eventBus) {
    const host = document.querySelector('#global-bottom-bar .bar-left')
              ?? document.querySelector('.global-bottom-bar .bar-left')
              ?? document.querySelector('#global-bottom-bar .bar-right')
              ?? document.querySelector('.global-bottom-bar');
    if (!host || host.querySelector('#twm-user-chip')) return;

    const btn = document.createElement('button');
    btn.id = 'twm-user-chip';
    btn.className = 'twm-user-chip has-tooltip';
    btn.type = 'button';
    btn.dataset.tooltipPlacement = 'top';

    // Painted from the LIVE config rather than from a value captured at boot.
    // This chip is the one thing on screen that always claims to say who you
    // are, so it is the first place a name change has to show up — and it used
    // to be the last, because it read a snapshot nobody refreshed. Changing
    // your name left the corner saying the old one, which is what "does not
    // take effect" looked like.
    const paint = () => {
        const name = (window.__BUGDESK_CONFIG__ || {}).humanAuthor || 'reviewer';
        btn.dataset.tooltip = `Signed in as ${name} — click to change who you are`;
        btn.setAttribute('aria-label', `Signed in as ${name}. Change your name.`);
        btn.innerHTML = `<span class="material-symbols-outlined">person</span><span>${
            String(name).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
        }</span>`;
    };
    paint();

    btn.addEventListener('click', () => {
        import('../ticketdesk/first_run.js')
            .then((m) => m.openIdentityDialog({ eventBus: eventBus ?? window.__ecoagent?.eventBus }))
            .catch((err) => console.error('[bugdesk] identity dialog failed', err));
    });
    // Emitted by first_run.js's applyIdentity, whichever surface made the change
    // — the dialog, or the Settings row's write-through.
    eventBus?.on?.('bugdesk:identity-changed', paint);
    host.insertBefore(btn, host.firstChild);
}

function _installDesktopBar(wm) {
    const host = document.querySelector('#global-bottom-bar .bar-right')
              ?? document.querySelector('.global-bottom-bar .bar-right')
              ?? document.querySelector('.global-bottom-bar');
    if (!host) return;
    let el = document.getElementById('twm-desktops');
    if (!el) {
        el = document.createElement('div');
        el.id = 'twm-desktops';
        el.className = 'twm-desktops';
        host.appendChild(el);
    }
    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-desktop]');
        if (!btn) return;
        const v = btn.dataset.desktop;
        if (v === '+') { wm.addDesktop(); _syncDesktopBar(wm); return; }
        wm.switchDesktop(Number(v));
    });
    // Double-click a desktop chip → inline rename. Faster than the
    // context menu's Rename… for the common case of "I just want to
    // call this 'analytics' instead of '3'". Persists via wm._persist
    // → bridge workspace_state_write so the new label survives restart.
    el.addEventListener('dblclick', async (e) => {
        const btn = e.target.closest('[data-desktop]');
        if (!btn || btn.dataset.desktop === '+') return;
        e.preventDefault();
        const idx = Number(btn.dataset.desktop);
        const d = wm.desktops.desktops[idx];
        if (!d) return;
        const result = await openForm({
            title: 'Rename desktop',
            fields: [{ name: 'label', label: 'Name', type: 'text', required: true,
                       hint: 'Up to 24 characters. Shown in the bottom-bar chip and the Alt+N tooltip.' }],
            defaults: { label: d.label },
            submitLabel: 'Rename',
        });
        if (!result || !result.label) return;
        d.label = String(result.label).slice(0, 24);
        _syncDesktopBar(wm);
        wm._persist();
    });
    el.addEventListener('contextmenu', (e) => {
        const btn = e.target.closest('[data-desktop]');
        if (!btn || btn.dataset.desktop === '+') return;
        e.preventDefault();
        const idx = Number(btn.dataset.desktop);
        const m = wm.desktops;
        const d = m.desktops[idx];
        const canDelete = m.desktops.length > 1;
        showContextMenu(e.clientX, e.clientY, [
            { label: `Switch to ${d.label}`, icon: 'desktop_windows',
              action: 'switch', disabled: idx === m.activeIdx },
            { label: 'Rename…',      icon: 'edit', action: 'rename' },
            { separator: true },
            { label: 'New desktop',  icon: 'add',  action: 'add' },
            { label: 'Delete desktop', icon: 'delete', action: 'delete',
              danger: true, disabled: !canDelete },
        ], async (action) => {
            if (action === 'switch') wm.switchDesktop(idx);
            else if (action === 'rename') {
                const result = await openForm({
                    title: 'Rename desktop',
                    fields: [{ name: 'label', label: 'Name', type: 'text', required: true }],
                    defaults: { label: d.label },
                    submitLabel: 'Rename',
                });
                if (!result || !result.label) return;
                d.label = String(result.label).slice(0, 24);
                _syncDesktopBar(wm);
                wm._persist();
            }
            else if (action === 'add')    { wm.addDesktop(); _syncDesktopBar(wm); }
            else if (action === 'delete') { wm.removeDesktop(idx); _syncDesktopBar(wm); }
        });
    });
}

function _syncDesktopBar(wm) {
    const el = document.getElementById('twm-desktops');
    if (!el) return;
    const m = wm.desktops;
    el.innerHTML =
        m.desktops.map((d, i) => `
            <button class="twm-desk__btn${i === m.activeIdx ? ' twm-desk__btn--on' : ''}"
                    data-desktop="${i}"
                    title="Desktop ${d.label} (Alt+${i + 1}) · right-click to delete">
                ${d.label}
            </button>`).join('')
        + `<button class="twm-desk__btn twm-desk__btn--add"
                  data-desktop="+" title="Add desktop">+</button>`;
}
