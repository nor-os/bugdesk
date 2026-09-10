/**
 * kind_taxonomy.js — bugdesk's ontology, injected into `@flexdesk/wm`'s
 * `createTaxonomy()` factory.
 *
 * This used to be a hand-rolled module of free functions (`getKindMeta`,
 * `topNavFor`, `parentKindFor`, `topNavEntries`) over a local
 * `KIND_TAXONOMY` object. FlexDesk's `createTaxonomy({ kinds, root })`
 * (see `@flexdesk/wm`) is the exact same data shape — `label`,
 * `shortLabel`, `icon`, `topNav`, `isTopNav`, `order`, `appGlobal` all mean
 * what they meant here — wrapped in eager validation (a typo in a
 * `topNav` pointer is a boot error now, not a chrome surface that
 * silently renders nothing) plus the extra methods (`ancestors`,
 * `labelOf`, `sourcesFor`) other embedders need and bugdesk doesn't
 * (single entity source, no id-encoded ancestry).
 *
 * Every importer now receives the built `taxonomy` object and calls its
 * methods (`taxonomy.meta(kind)`, `taxonomy.topNavFor(kind)`,
 * `taxonomy.parentKindFor(kind)`, `taxonomy.topNavEntries()`) instead of
 * importing free functions from this file — see install.js,
 * tile_breadcrumb.js, tile_tab_menu.js, command_palette.js and wm.js.
 */

import { createTaxonomy } from '@flexdesk/wm';

/* ── mode ────────────────────────────────────────────────────────────
 *
 * BugDesk runs as a bug tracker (default) or as a TRACKER — a manager's record
 * of work handed to other people. The bridge decides at launch and reports it
 * through /api/config, which ui/index.html resolves BEFORE this module is
 * evaluated. Read here rather than imported from ticketdesk/backlog_data.js so
 * the tiling shell keeps no dependency on the ticketdesk modules (the arrow
 * runs the other way — see install.js's lazy imports).
 *
 * The taxonomy is built ONCE, at module load, because the WM bakes it into
 * saved layouts and the top bar. That is fine precisely because the mode cannot
 * change without restarting the bridge.
 */
const TRACKER = (typeof window !== 'undefined'
    && window.__BUGDESK_CONFIG__?.mode) === 'tracker';

export const taxonomy = createTaxonomy({
    root: 'home',
    kinds: {
        // BugDesk taxonomy — one top-nav per store, plus the Tracker dashboard
        // in tracker mode. `home` is the WM default leaf and maps to the Queues
        // landing (in tracker mode, to the dashboard — see
        // ticketdesk/tracker_pages.js). `ticket` is a sub-page of Queues,
        // `item` a sub-page of Backlog.
        home: { label: 'Home', icon: 'home' },

        // NO shortLabel on either top-nav entry. FlexDesk renders the chip as
        // `shortLabel || label` (see createTaxonomy's topNavEntries), so the
        // abbreviations this used to carry put "QUE" and "BKL" in the top bar —
        // two cryptic three-letter codes where the whole job of the strip is to
        // say which of the two stores you are looking at.
        //
        // The kind id stays `queues` while the label reads "Bugs": the id is
        // baked into saved tile layouts and every `props.filter` route, and
        // renaming it would strand both for a cosmetic gain.
        queues: {
            label: 'Bugs', icon: 'bug_report',
            isTopNav: true, order: 20,
        },
        ticket: { label: 'Bug', icon: 'bug_report', topNav: 'queues' },

        // TRACKER MODE's landing page: what is late, and whose it is. First in
        // the strip and therefore the WM's default leaf, because it is the
        // question the mode exists to answer — you open a tracker to find out
        // what needs chasing, not to browse a tree.
        //
        // Absent entirely in the default mode rather than present-and-empty: a
        // chip that leads to a dashboard over a store with no target dates in it
        // says nothing, every time you look at it.
        ...(TRACKER ? {
            tracker: {
                label: 'Tracker', icon: 'space_dashboard',
                isTopNav: true, order: 10,
            },
        } : {}),

        // The second store: [projects →] epics → stories → tasks. `item` covers
        // every type rather than getting a kind each — they share one page, one
        // route and one id space, and four kinds would only make the breadcrumb
        // and the palette pick between synonyms.
        //
        // The kind id stays `backlog` in both modes, for the same reason
        // `queues` stays `queues` while reading "Bugs": it is baked into saved
        // tile layouts and every `props.filter` route. Only the LABEL changes —
        // "backlog" is a word about work you plan for yourself, and a tracker is
        // a list of things other people owe you.
        backlog: {
            label: TRACKER ? 'Tickets' : 'Backlog',
            icon: 'workspaces',
            isTopNav: true, order: 30,
        },
        item: { label: 'Item', icon: 'article', topNav: 'backlog' },

        // The create mask. Its breadcrumb sits under whichever section this
        // deployment files INTO by default — Bugs normally, Tickets in tracker
        // mode, where the bug queue is not where anything starts. The Type
        // select inside it is what actually decides which store the record lands
        // in, and the page is reachable from every section either way.
        'new-item': {
            label: 'New item', icon: 'add_circle',
            topNav: TRACKER ? 'backlog' : 'queues',
        },

        // Settings reachable from the hamburger; no top-nav slot. App-global
        // (localStorage-backed, openable with no project loaded), so its
        // breadcrumb omits the project ancestor — `appGlobal` flags that.
        settings: {
            label: 'Settings', icon: 'settings',
            topNav: 'home', appGlobal: true,
        },
    },
});

/**
 * Which TOP-NAV section the user is currently in — the lit chip in the top bar,
 * and therefore which store everything else should be talking about.
 *
 * The FOCUSED content tile is what the user is looking at; the primary leaf is
 * only a fallback. Reading the primary alone is why the chip went dark when the
 * user moved between tiles — the tile they were in was not the one being asked.
 * Panels are skipped: the left rail asking "which section am I in" must not get
 * the answer "the left rail".
 *
 * `home` is seeded by the WM as its own kind, but a shell is free to render a
 * landing there — BugDesk's Home IS the bug queue — so it resolves to the FIRST
 * top-nav entry rather than matching nothing.
 *
 * Lives here, taking the WM as a parameter, because two callers need to agree on
 * it exactly: install.js lights the chip, and the left rail decides which body
 * to show. A second copy of this derivation is a rail that contradicts the chip
 * above it.
 *
 * @returns {string|null} a top-nav kind, or null when nothing is resolvable yet.
 */
export function activeTopNavKind(wm) {
    const tree = wm?.desktops?.active?.()?.tree;
    if (!tree) return null;

    const focusedId = tree.focusedLeafId;
    const focusedKind = focusedId ? tree.get(focusedId)?.content?.kind : null;
    const usable = focusedKind
        && !String(focusedKind).startsWith('panel:')
        && focusedKind !== 'window-placeholder';

    const primaryId = tree.primaryLeafId?.();
    const activeKind = usable ? focusedKind : (primaryId ? tree.get(primaryId)?.content?.kind : null);
    if (!activeKind) return null;

    return taxonomy.topNavFor(activeKind)
        || (activeKind === 'home' ? taxonomy.topNavEntries()[0]?.kind : null)
        || activeKind
        || null;
}
