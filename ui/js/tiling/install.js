/**
 * install.js — tiling-shell post-bootstrap glue.
 *
 * Flow:
 *
 *   1. The shell mounts its two bars (global-top-bar, global-bottom-bar)
 *      with the space between them left empty for us.
 *   2. installProjectSelector resolves the active project.
 *   3. Fill the top bar: page shortcuts in the centre, the menu folded
 *      into a hamburger beside the brand.
 *   4. Insert the WM host between the two bars and mount the window
 *      manager in it, with the palette, the keymap and the desktop strip.
 *
 * THERE IS NO TEARDOWN STEP ANY MORE. This used to begin by deleting the
 * Ecosim workspace the shell had just built — the `.container` with its tool
 * rail, template sidebar, resizer and right-hand "AI Assistant" panel, the
 * workspace top bar, the "Model OK" indicator, the File/Edit/View/Run menus —
 * all of it built during boot and removed a few hundred milliseconds later,
 * which is exactly how long it was visible for. None of it is built any more;
 * the two bars come from ui/js/bootstrap/boot.js.
 */

import { createCommandPalette } from './command_palette.js';
import { installHistoryBack } from './history_nav.js';
import { taxonomy, activeTopNavKind } from './kind_taxonomy.js';
import { createSettingsContent } from '../ticketdesk/settings_content.js';

import { HelpModal } from '../help/help_modal.js';

import {
    WindowManager, createContentRegistry, installKeymap, mountZoomControl, openTileTabMenu,
} from '@flexdesk/wm';
import { createPywebviewHost } from '@flexdesk/host';
import { createTableStateStore, openForm, showContextMenu } from '@flexdesk/widgets';

export async function installTilingShell({ eventBus, logger } = {}) {
    const log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };

    // The dialogs the hamburger opens are handed the bus through this rather than
    // through a captured argument, because the menu is built before the shell
    // exists and its callbacks run long after.
    window.__bugdesk = { eventBus };

    // There is no "open a project first" gate any more. It was the simulator's:
    // it asked the bridge for `project_current`, and BugDesk only ever passed it
    // because that call fell through to the server's permissive catch-all and
    // came back `{ok:true}`, which read as a project. BugDesk has one store, named
    // by the server at launch, and nothing to choose.

    // 1. Fill the top bar: page shortcuts in the centre, and the menu
    //    collapsed into a single hamburger button beside the brand.
    _installPageShortcuts();
    _installHamburgerMenu();

    // 2. Make body a 3-row flex column: top bar / WM host / bottom bar.
    document.body.classList.add('twm-body');
    const top = document.querySelector('.global-top-bar');
    const bottom = document.querySelector('.global-bottom-bar');
    const wmHost = document.createElement('div');
    wmHost.className = 'twm-host';
    if (top && bottom) document.body.insertBefore(wmHost, bottom);
    else document.body.appendChild(wmHost);

    // 3. Build the content registry, then the WM + palette + keymap.
    //
    // Content is a plain { kind: factory } map handed to @flexdesk/wm's
    // createContentRegistry(...) up front. Every kind in it is BugDesk's own; the
    // registry supplies the window placeholder itself.
    const settingsContent = createSettingsContent({ eventBus, api: window.pywebview?.api });
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
        ...settingsContent, ...ticketDeskContent, ...backlogContent, ...trackerContent,
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

    // WHY A SORT DID NOT SURVIVE OPENING A BUG. FlexDesk keeps only a tile's
    // ACTIVE tab mounted: open a bug in a new tab and the queue's table is
    // destroyed; switch back and a brand-new table is built with the default
    // sort, no column filters and auto-fit widths. Nothing was kept anywhere to
    // put back. This is FlexDesk's standard table store, persisting through the
    // same host port as the tile layout (so it lands in the user's own state
    // directory and survives a reload, not just a tab switch); pages hand it to
    // their tables with a key per view.
    const tableStore = createTableStateStore({ host, key: 'tables', logger: log });

    // FLEXDESK'S WINDOW MANAGER, not a copy of it.
    //
    // BugDesk used to run its own `tiling/wm.js`: a fork of FlexDesk's taken
    // long enough ago that it was 1631 lines against upstream's 3630, and never
    // received any of what came after — so every floating window BugDesk opened
    // was the fork's, and passing `snap: true` to it did nothing, because the
    // fork's ManagedWindow had no snapping at all. The windows looked like
    // FlexDesk's windows and behaved like last year's.
    //
    // Constructed directly rather than through `createShell`, for one reason:
    // `createShell` always builds FlexDesk's own command palette and binds Ctrl+K
    // to it, and in BugDesk Ctrl+K is GLOBAL FULLTEXT SEARCH over both stores
    // (`command_palette.js`, and the commit that made it so). Adopting
    // `createShell` would quietly put back the title-matching entity picker that
    // could find neither a phrase from a comment nor anything in the backlog. The
    // window manager, the keymap, the tab menu and the zoom are FlexDesk's; the
    // palette is BugDesk's, on purpose.
    const wm = new WindowManager({
        rootEl: wmHost,
        api: window.pywebview?.api,
        host,
        content,
        eventBus,
        taxonomy,
        // C15. Drag a floating window to an edge of a tile and it snaps; drop it
        // on a tile and it DOCKS back into the tree — as that tile's content, a
        // split of it, or one of its tabs. FlexDesk implements all of it; this is
        // the switch. Off by default upstream because it changes what a drag to
        // an edge means.
        snapPromotion: true,
        // C21. A window floated out of a tile stays inside that tile's pane, the
        // way Tables does it — so "float this pane" gives a window over its own
        // pane, not one hovering over the rail and the inspector beside it. It
        // is also what keeps every window under `wmHost`, which is the element
        // the content zoom below scales.
        promoteInPlace: true,
        // C32. A bug opened from the queue arrives in a new tab; Backspace in it
        // closes it and puts you back on the queue that is already open, instead
        // of rewriting the bug's tab into a second copy of that queue. A bug with
        // no list of its own section open still walks up in place, so Back never
        // closes a tile into nothing. BugDesk's old tiling fork did the first half
        // with tab-opener links that did not survive the move to FlexDesk; this
        // is the same promise made upstream, by section rather than by link.
        backToOpenList: true,
        // C34. Floating a tile takes the bug or item you are reading, not the
        // queue tab beside it too. A tile's tabs here are separate records, so
        // the window gets one tab and no strip. Backspace inside a floating
        // record then closes it onto the open list, like it does in a tile.
        floatActiveTab: true,
        // The Console panel starts hidden, as it always has here; FlexDesk's own
        // default opens all three. The user can still toggle it, and a desktop
        // keeps whatever state it was left in.
        panelDefaults: { bottom: false },
        ctx: { api: window.pywebview?.api, eventBus, host, taxonomy, tableStore,
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
    // FlexDesk's keymap driving BugDesk's palette — the palette exposes the same
    // open/close/toggle/isOpen the keymap calls, so nothing is adapted. The
    // selector is passed because FlexDesk's default names its own top bar's
    // classes, and without it F1..F8 would silently match no button.
    installKeymap({ wm, palette, navSelector: '.global-top-bar .bar-center.twm-top-nav .twm-top-nav__btn' });
    // The browser's Back gesture walks up exactly like Backspace does,
    // instead of abandoning the app and its tile layout.
    installHistoryBack({ wm });

    // 6. Wire the top-bar panel toggles to the WM (nothing else drives them
    //    any more — the legacy panel state machines are gone), then add the
    //    palette button and the desktop bar.
    _rewirePanelToggles(wm);
    _installPaletteButton(palette);
    _installTopBarResponsive();
    // Desktops (views) feature: install the bottom-bar desktop chip strip
    // with its add / switch / rename / delete controls. BugDesk boots with
    // a single desktop labeled "WORK" (below), but the bar lets the user
    // add and switch between multiple desktops again.
    _installDesktopBar(wm);
    _installUserChip(wm, eventBus);
    // C31. FlexDesk's content zoom, in the bottom bar. It scales tile bodies and
    // window content under `wmHost` and nothing a window is dragged across, which
    // is what keeps the snapping above working at any zoom — see FlexDesk's
    // zoom.js. The saved value comes through the same host port the desktops are
    // persisted through, and it is AWAITED before the first mount so the tiles
    // paint at the user's zoom rather than at 100% and then jumping.
    const zoomHost = document.querySelector('#global-bottom-bar .bar-right')
                  ?? document.querySelector('.global-bottom-bar .bar-right');
    const zoom = mountZoomControl(zoomHost, { root: wmHost, host });
    // Both read before the first mount, for the same reason: a queue that paints
    // unsorted and then jumps to your sort a moment later looks broken.
    await Promise.all([zoom?.ready, tableStore.ready()]);
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
    _installTicketActions(wm, trackerMode);

    _syncPanelToggleButtons(wm);
    _syncDesktopBar(wm);
    _syncPageShortcuts(wm);

    window.__twm = { wm, palette };

    // Drag a record from any list onto any tile to display it there. One
    // document-level listener pair rather than per-tile wiring: tiles are
    // created, destroyed and repainted constantly, and a drop target bound to a
    // tile element stops working the first time that tile repaints.
    try {
        const { installRecordDropTargets } = await import('../ticketdesk/record_dnd.js');
        installRecordDropTargets({ wm });
    } catch (err) {
        log.warn?.('record drop targets failed to install', { err });
    }

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

    log.info?.('tiling shell installed');
    window.__bugdesk = { eventBus, wm, palette };
    return { wm, palette };
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
function _installTicketActions(wm, trackerMode = false) {
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
        // TRACKER MODE has no bug store and therefore no `ticket` kind — the
        // search page IS the bug mask in search mode. The shared item picker is
        // the right search there anyway: type any part of a reference or title,
        // filter by type, open it. It is transient by nature, so unlike the bug
        // search it does not need a tab of its own.
        if (trackerMode) {
            const [{ openItemPicker }, { itemLabel }] = await Promise.all([
                import('../ticketdesk/item_picker.js'),
                import('../ticketdesk/backlog_data.js'),
            ]);
            const picked = await openItemPicker({ title: 'Find a ticket' });
            if (picked?.id) {
                wm.navigate('item',
                    { id: String(picked.id), label: itemLabel(picked) || `#${picked.id}` },
                    { dest: 'main', newTab: true });
            }
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
                    .then((m) => m.openCollaborators({ eventBus: window.__bugdesk?.eventBus }))
                    .catch((err) => console.error('[bugdesk] collaborators dialog failed', err));
                return;
            }
            if (action === 'twm-change-name') {
                // A dialog, not the Settings page: opened in the primary tile
                // from a focused side tile, the page change happened somewhere
                // the user was not looking and read as "nothing happened".
                import('../ticketdesk/first_run.js')
                    .then((m) => m.openIdentityDialog({ eventBus: window.__bugdesk?.eventBus }))
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
        { label: 'Float this tab as a window', icon: 'open_in_new',
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
            .then((m) => m.openIdentityDialog({ eventBus: eventBus ?? window.__bugdesk?.eventBus }))
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
