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

export const taxonomy = createTaxonomy({
    root: 'home',
    kinds: {
        // BugDesk taxonomy — two top-navs, one per store. `home` maps to the
        // Queues landing (WM default leaf); `ticket` is a sub-page of Queues,
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

        // The second store: epics → stories → tasks. `item` covers all three
        // types rather than getting a kind each — they share one page, one
        // route and one id space, and three kinds would only make the
        // breadcrumb and the palette pick between synonyms.
        backlog: {
            label: 'Backlog', icon: 'workspaces',
            isTopNav: true, order: 30,
        },
        item: { label: 'Item', icon: 'article', topNav: 'backlog' },

        // Settings reachable from the hamburger; no top-nav slot. App-global
        // (localStorage-backed, openable with no project loaded), so its
        // breadcrumb omits the project ancestor — `appGlobal` flags that.
        settings: {
            label: 'Settings', icon: 'settings',
            topNav: 'home', appGlobal: true,
        },
    },
});
