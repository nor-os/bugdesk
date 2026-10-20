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
 * `labelOf`, `sourcesFor`). BugDesk uses `ancestors` and `labelOf` for a
 * backlog item's parent chain; see `registerRecordHierarchy` below.
 *
 * Every importer now receives the built `taxonomy` object and calls its
 * methods (`taxonomy.meta(kind)`, `taxonomy.topNavFor(kind)`,
 * `taxonomy.parentKindFor(kind)`, `taxonomy.topNavEntries()`) instead of
 * importing free functions from this file — see install.js,
 * tile_tab_menu.js, command_palette.js and FlexDesk's breadcrumb and wm.
 */

import { createTaxonomy } from '@flexdesk/wm';
import { storeHas } from '../core/app_identity.js';
import { EMBEDDED, kindPrefix, localKind, nsKind, pageConfig } from '../core/page_config.js';

/* ── mode ────────────────────────────────────────────────────────────
 *
 * BugDesk runs as a bug tracker (default) or as a TRACKER — a manager's record
 * of work handed to other people. The bridge decides at launch and reports it
 * through /api/config, which ui/index.html resolves BEFORE this module is
 * evaluated (or, embedded in another application, which this copy fetched from
 * its own API — core/page_config.js). Read here rather than imported from
 * ticketdesk/backlog_data.js so
 * the tiling shell keeps no dependency on the ticketdesk modules (the arrow
 * runs the other way — see install.js's lazy imports).
 *
 * The taxonomy is built ONCE, at module load, because the WM bakes it into
 * saved layouts and the top bar. That is fine precisely because the mode cannot
 * change without restarting the bridge.
 */
const CFG = pageConfig();
const TRACKER = CFG.mode === 'tracker';

/* A project need not have both stores (see storeHas). The kinds of the missing
 * one stay DEFINED — saved layouts and links name them, and an unknown kind is a
 * boot error — but lose their chip, and the landing page is the store that is
 * there. */
const HAS_BUGS = !TRACKER && storeHas('bugs');
const HAS_BACKLOG = storeHas('backlog');
const LANDING = TRACKER ? 'tracker' : HAS_BUGS ? 'bugs-home' : 'backlog-home';

/* The global TRACKER as a section of a project page, beside Bugs and Backlog.
 * Its records come from the tracker's own copy of the ticketdesk modules (see
 * ticketdesk/instance.js), under kinds of their own — a tracker ticket and a
 * backlog item must never share a tab, a breadcrumb or a section. Standalone
 * TicketDesk has the tracker as its only section and keeps the kinds it always
 * had. */
export const MERGED_TRACKER = !TRACKER && !!CFG.tracker?.available;

/* A tracker that is there but SWITCHED OFF, for this person (Settings › You,
 * STORY-0043) or for the machine (`[tracker] enabled = false`). Its kinds stay
 * defined, as a missing store's do, so a tracker tab saved in a layout (the
 * Tracker page's own tabs, or one in another page's tile) stays in it: shown,
 * it says the Tracker is switched off (tiling/install.js), and it is all there
 * again when the Tracker is switched back on. They only lose the chip. */
const TRACKER_SWITCHED_OFF = !TRACKER && !MERGED_TRACKER
    && !!CFG.tracker?.path
    && !!(CFG.tracker.switchedOff || CFG.tracker.machineOff);

/* ── record hierarchy, supplied by the store ────────────────────────
 *
 * FlexDesk's breadcrumb builds a record's path from `taxonomy.ancestors` and
 * names it with `taxonomy.labelOf`. A backlog item's ancestors live in the
 * backlog store, and this module must not import the ticketdesk modules (the
 * arrow runs the other way), so the store registers the two answers when it
 * loads. Until it has, an item's breadcrumb is simply its section and its own
 * label.
 */
const _recordHooks = {};

/** Called by ticketdesk/backlog_data.js: `ancestors(props)` returns
 *  `[{ kind, id, label }]` root-most first; `labelOf(props)` names one record. */
export function registerRecordHierarchy(kind, { ancestors, labelOf } = {}) {
    _recordHooks[kind] = { ancestors, labelOf };
}

/* The kinds, as data: built into BugDesk's own taxonomy below, and handed to a
 * host that embeds BugDesk under its own names (`embedKinds`). */
const KINDS = {
    // BugDesk taxonomy — one top-nav per store, plus the Tracker dashboard
    // in tracker mode. `home` is the WM default leaf and maps to the Bugs
    // home (the Backlog home in a project with no bug store, the Tracker
    // home in tracker mode — see dashboards/homes.js). `queues` and `ticket`
    // are pages of Bugs, `backlog` and `item` pages of Backlog.
    // `home` is the WM's default leaf, and it RENDERS the landing page of a
    // section — the Bugs home normally, the Tracker home in tracker
    // mode. So it has to SAY which section that is. It declared none, which
    // made every openInPrimary(...) from the landing tile a cross-page swap:
    // the WM archived the tile's tabs, restored the target page's, and
    // dropped the props it was given. That is the same fault as `item`
    // below, and between them they are why "show me this person's work"
    // looked like a click that did nothing.
    home: { label: 'Home', icon: 'home', topNav: LANDING },

    // ── the BUG store, and its top-nav chip ──────────────────────
    //
    // NO shortLabel on a top-nav entry. FlexDesk renders the chip as
    // `shortLabel || label` (see createTaxonomy's topNavEntries), so the
    // abbreviations this used to carry put "QUE" and "BKL" in the top bar —
    // two cryptic three-letter codes where the whole job of the strip is to
    // say which of the two stores you are looking at.
    //
    // `queues` was the Bugs chip until STORY-0048 and keeps its id now that
    // it is the bug list under the home: the id is baked into every
    // `props.filter` route, and renaming it would strand them for a
    // cosmetic gain. (Saved layouts naming it as a PAGE are renamed when
    // read, see `migrateLayout` below.)
    //
    // ABSENT ENTIRELY IN TRACKER MODE, along with `ticket`. A tracker has no
    // bug store — it does not live in a code repo at all (see
    // ResolveTrackerRoot in server/Program.cs) — so a Bugs chip there leads
    // to a queue over a directory that does not exist. Removed rather than
    // emptied: a top-nav entry that can only ever show "nothing here" is
    // chrome that costs a glance every time and never repays it. Nothing is
    // stranded by the removal, because tracker mode keeps its layouts in its
    // own config directory, so no saved bugs-mode tile can be restored into
    // it.
    //
    // THE CHIP IS THE SECTION'S HOME (STORY-0048), not the queue: `bugs-home`
    // is the Bugs home dashboard (dashboards/homes.js), and `queues` is a
    // page under it, as `tracker-tickets` is under `tracker`. So the chip,
    // its F-key and a click on it while already on the page all land on the
    // home, and the queue is one rail click away. `queues` keeps its id and
    // its props for the reason above; `ticket` points at the chip kind
    // because the WM groups a tile's tabs by a single `topNav` hop.
    //
    // `overview` tells the WM the home SUMS the section up rather than
    // listing it: Back or the Bugs crumb from a bug closes onto an open bug
    // list before an open home, whichever sits nearer (FlexDesk C32).
    ...(TRACKER ? {} : {
        'bugs-home': HAS_BUGS
            ? { label: 'Bugs', icon: 'bug_report', isTopNav: true, order: 20, overview: true }
            : { label: 'Bugs', icon: 'bug_report', topNav: 'home' },
        queues: { label: 'Bug list', icon: 'list', topNav: 'bugs-home' },
        ticket: { label: 'Bug', icon: 'bug_report', topNav: 'bugs-home' },
    }),

    // TRACKER MODE's landing page: what is late, and whose it is. In tracker
    // mode it is the ONLY top-nav entry — everything else is reached from
    // it, which is the point of a dashboard.
    //
    // Absent entirely in the default mode rather than present-and-empty: a
    // chip that leads to a dashboard over a store with no target dates in it
    // says nothing, every time you look at it.
    ...(TRACKER ? {
        tracker: {
            label: 'Tracker', icon: 'space_dashboard',
            isTopNav: true, order: 10, overview: true,
        },
    } : {}),

    // The record store: [projects →] epics → stories → tasks. `item` covers
    // every type rather than getting a kind each — they share one page, one
    // route and one id space, and four kinds would only make the breadcrumb
    // and the palette pick between synonyms.
    //
    // The kind id stays `backlog` in both modes, for the same reason
    // `queues` keeps its id: it is baked into every `props.filter` route.
    // It shows the board or, opened with a filter, a flat list of items, so
    // it is labelled "Items", not "Board": the crumb above "Open as a list"
    // must not call that list the board.
    //
    // In tracker mode it is NOT a top-nav entry — it sits UNDER Tracker.
    // That is what keeps the chip lit and the left rail in place when you
    // open a ticket from the dashboard: the section you are in has not
    // changed, you have only gone deeper into it. As its own chip it read as
    // a second, competing place to be, and clicking any row on the dashboard
    // moved the user out of the section they were working in.
    // After Backlog, and tinted in the top bar (see tiling/nav.css): it
    // belongs to no project, and switching projects does not change it.
    ...(MERGED_TRACKER ? {
        tracker: {
            label: 'Tracker', icon: 'space_dashboard',
            isTopNav: true, order: 40, overview: true,
        },
        'tracker-tickets': { label: 'Tickets', icon: 'workspaces', topNav: 'tracker' },
        'tracker-item': {
            label: 'Ticket', icon: 'article', topNav: 'tracker',
            ancestors: (props) => _recordHooks['tracker-item']?.ancestors?.(props) || [],
            labelOf: (props) => _recordHooks['tracker-item']?.labelOf?.(props) || props.label || props.id,
        },
        'tracker-new': { label: 'New ticket', icon: 'add_circle', topNav: 'tracker' },
    } : {}),
    ...(TRACKER_SWITCHED_OFF ? {
        tracker: { label: 'Tracker', icon: 'space_dashboard', topNav: 'home' },
        'tracker-tickets': { label: 'Tickets', icon: 'workspaces', topNav: 'home' },
        'tracker-item': { label: 'Ticket', icon: 'article', topNav: 'home' },
        'tracker-new': { label: 'New ticket', icon: 'add_circle', topNav: 'home' },
    } : {}),

    // EPIC-0033, STORY-0046. A dashboard is a page OF A SECTION, not a
    // section of its own: no chip, no F-key. Each section's rail lists its
    // dashboards (dashboards/rail.js), and the page they open sits under
    // that section's chip, one kind per section, because the WM groups a
    // tile's tabs by `topNavFor(kind)` and a single dashboards kind would
    // make every open from the Backlog rail a swap to the Bugs page.
    // `dashboards` keeps its id, since saved layouts name it, and is the
    // landing section's (Bugs; Tracker in tracker mode). Which dashboard is
    // open is `props.dashboard`, not a sub-kind.
    dashboards: { label: 'Dashboards', icon: 'monitoring', topNav: LANDING },
    ...(TRACKER ? {} : {
        'backlog-dashboard': { label: 'Dashboards', icon: 'monitoring', topNav: 'backlog-home' },
    }),
    ...(MERGED_TRACKER || TRACKER_SWITCHED_OFF ? {
        'tracker-dashboard': { label: 'Dashboards', icon: 'monitoring', topNav: MERGED_TRACKER ? 'tracker' : 'home' },
    } : {}),

    // The Backlog chip is its home too (STORY-0048, as `bugs-home` above),
    // and the board is a page under it. In tracker mode there is no Backlog
    // section: the board is the Tracker's Tickets.
    ...(TRACKER ? {} : {
        'backlog-home': HAS_BACKLOG
            ? { label: 'Backlog', icon: 'workspaces', isTopNav: true, order: 30, overview: true }
            : { label: 'Backlog', icon: 'workspaces', topNav: 'home' },
    }),
    backlog: TRACKER
        ? { label: 'Tickets', icon: 'workspaces', topNav: 'tracker' }
        : { label: 'Items', icon: 'account_tree', topNav: 'backlog-home' },

    // `item` points at whatever SECTION its list is in, not at the list.
    //
    // FlexDesk's `topNavFor` is a SINGLE hop — it returns `meta.topNav`
    // verbatim — and the WM groups a tile's tabs by it (see `swapToPage` in
    // wm.js). Pointing `item` at `backlog` while `backlog` itself points at
    // `tracker` therefore put two kinds of the SAME section in two different
    // page groups, and every `openInPrimary('backlog', …)` from a tile
    // showing an item was treated as a cross-page swap: it archived the
    // tabs, restored the other page's, and dropped the props it was handed.
    // The Inspector's "show me this person's work" did exactly that and
    // looked, from the outside, like a click that did nothing.
    //
    // The cost is one breadcrumb level in tracker mode — `Tracker ›
    // STORY-0007` rather than `Tracker › Tickets › STORY-0007` — which is
    // a fair price for the two kinds agreeing about where they live.
    item: {
        label: 'Item', icon: 'article', topNav: TRACKER ? 'tracker' : 'backlog-home',
        ancestors: (props) => _recordHooks.item?.ancestors?.(props) || [],
        labelOf: (props) => _recordHooks.item?.labelOf?.(props) || props.label || props.id,
    },

    // The create mask. Its breadcrumb sits under whichever section this
    // deployment files INTO by default — Bugs normally, Tracker in tracker
    // mode, where there is no bug queue for anything to start from. The Type
    // select inside it is what actually decides which store the record lands
    // in, and the page is reachable from every section either way.
    'new-item': {
        label: 'New item', icon: 'add_circle',
        topNav: LANDING,
    },

    // Settings reachable from the hamburger; no top-nav slot. App-global
    // (localStorage-backed, openable with no project loaded), so its
    // breadcrumb omits the project ancestor — `appGlobal` flags that.
    settings: {
        label: 'Settings', icon: 'settings',
        topNav: 'home', appGlobal: true,
    },
};

export const taxonomy = createTaxonomy({ root: 'home', kinds: KINDS });

/* ── embedded, under the host's names (EPIC-0051) ────────────────────
 *
 * Inside another FlexDesk application this copy's kinds are registered as
 * `<prefix><kind>` (core/page_config.js), but every module here goes on opening
 * them by their plain names — `openInTabFromContext(ctx, 'ticket', …)` from a
 * queue row, `navigateUp('bugs-home')` from a breadcrumb. So the content a host
 * mounts is handed a window manager that puts the prefix on every kind it is
 * asked to open, and BugDesk's own taxonomy, whose names its breadcrumbs are
 * built from. With no prefix and on BugDesk's own page, both are the real thing.
 */

/** Which argument of each FlexDesk WindowManager method (@flexdesk/wm 0.16)
 *  names the kind to open. */
const KIND_ARG = Object.freeze({
    openInPrimary: 0, openInTabInPrimary: 0, navigate: 0, navigateUp: 0,
    openFromContext: 1, openInTabFromContext: 1, openInLeaf: 1, openInWindow: 1, navigateActiveTab: 1,
    splitLeafWith: 2,
});
const _namespaced = new WeakMap();

/** The host's window manager, opening this copy's kinds under their
 *  namespaced names. Everything else passes straight through. */
export function namespaceWm(wm) {
    if (!wm || typeof wm !== 'object' || !kindPrefix()) return wm;
    if (!_namespaced.has(wm)) {
        _namespaced.set(wm, new Proxy(wm, {
            get(target, prop) {
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') return value;
                const at = KIND_ARG[prop];
                if (at === undefined) return value.bind(target);
                return (...args) => {
                    if (args.length > at) args[at] = nsKind(args[at]);
                    return value.apply(target, args);
                };
            },
        }));
    }
    return _namespaced.get(wm);
}

/** A `{ kind: factory }` map as a host registers it: keys namespaced, and each
 *  mount handed the namespacing window manager and BugDesk's own taxonomy. The
 *  map itself on BugDesk's own page. */
export function namespaceContent(content) {
    if (!kindPrefix() && !EMBEDDED) return content;
    return Object.fromEntries(Object.entries(content).map(([kind, factory]) => [nsKind(kind),
        (host, props, ctx = {}) => factory(host, props, { ...ctx, wm: namespaceWm(ctx.wm), taxonomy })]));
}

/**
 * This copy's kinds as entries for the HOST's `createTaxonomy({ kinds })`:
 * namespaced, with their `topNav` pointers and record ancestors namespaced the
 * same way, so the host's WM groups a project's tabs by that project's sections
 * and its breadcrumbs walk that project's records. A host is free to re-point
 * the top-level sections (`<prefix>bugs-home`, `<prefix>backlog-home`, the
 * root `<prefix>home`) at sections of its own.
 */
export function embedKinds() {
    const ns = (k) => (k ? nsKind(k) : k);
    return Object.fromEntries(Object.entries(KINDS).map(([kind, meta]) => {
        const out = { ...meta, ...(meta.topNav ? { topNav: ns(meta.topNav) } : {}) };
        if (meta.ancestors) {
            out.ancestors = (props) => (meta.ancestors(props) || []).map((a) => ({ ...a, kind: ns(a.kind) }));
        }
        return [ns(kind), out];
    }));
}

/* ── dashboards, per section (STORY-0046) ───────────────────────────
 *
 * The section a dashboard is listed in (its `section` field, dashboards/model.js)
 * and the kind of the page that shows it there. Standalone TicketDesk has one
 * section, the tracker, and its dashboards open under `dashboards`.
 */
export const DASHBOARD_KIND = Object.freeze({
    bugs: 'dashboards',
    backlog: TRACKER ? 'dashboards' : 'backlog-dashboard',
    tracker: TRACKER ? 'dashboards' : 'tracker-dashboard',
});

/* ── section homes (STORY-0047, STORY-0048) ──────────────────────────
 *
 * The kind of each section's home: the page its chip opens, a dashboard
 * (dashboards/homes.js). Only the sections this page has.
 */
export const HOME_KIND = Object.freeze(TRACKER ? { tracker: 'tracker' } : {
    ...(HAS_BUGS ? { bugs: 'bugs-home' } : {}),
    ...(HAS_BACKLOG ? { backlog: 'backlog-home' } : {}),
    ...(MERGED_TRACKER ? { tracker: 'tracker' } : {}),
});

/** The section whose home is the landing page (`home`, the WM's default leaf). */
export const LANDING_SECTION = TRACKER ? 'tracker' : HAS_BUGS ? 'bugs' : HAS_BACKLOG ? 'backlog' : null;

/* Before STORY-0048 the Bugs and Backlog chips were the queue and the board
 * themselves, so a saved layout keeps a tile's other pages under `queues` and
 * `backlog` (a leaf's `pageTabs`, and the section a back-entry returns to).
 * Their chips are the homes now; renamed on read, those tabs come back when
 * the chip is clicked instead of being left in an archive nothing opens. */
const RENAMED_PAGES = TRACKER ? {} : { queues: 'bugs-home', backlog: 'backlog-home' };

/** A saved layout (the WM's `desktops` blob) with the old page names renamed.
 *  The blob is changed in place and returned; anything else is returned as is. */
export function migrateLayout(blob) {
    const seen = new Set();
    const walk = (v) => {
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v.pageTabs && typeof v.pageTabs === 'object' && !Array.isArray(v.pageTabs)) {
            for (const [from, to] of Object.entries(RENAMED_PAGES)) {
                if (!(from in v.pageTabs)) continue;
                if (!(to in v.pageTabs)) v.pageTabs[to] = v.pageTabs[from];
                delete v.pageTabs[from];
            }
        }
        if (typeof v.topNav === 'string' && RENAMED_PAGES[v.topNav]) v.topNav = RENAMED_PAGES[v.topNav];
        Object.values(v).forEach(walk);
    };
    walk(blob);
    return blob;
}

/** The sections this page has, in rail order: where a dashboard can be listed. */
export const DASHBOARD_SECTIONS = Object.freeze(TRACKER ? ['tracker']
    : [HAS_BUGS && 'bugs', HAS_BACKLOG && 'backlog', MERGED_TRACKER && 'tracker'].filter(Boolean));

/** The section a dashboards kind belongs to: `bugs`, `backlog` or `tracker`. */
export function dashboardSectionOf(kind) {
    if (TRACKER) return 'tracker';
    if (kind === 'backlog-dashboard') return 'backlog';
    if (kind === 'tracker-dashboard') return 'tracker';
    return HAS_BUGS ? 'bugs' : 'backlog';
}

/** Per tile tree, the last content leaf that had focus. Weak, so a closed
 *  desktop's tree is not kept alive by having once been asked about. */
const lastContentLeaf = new WeakMap();

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
 * landing there — BugDesk's Home is the landing section's home dashboard — so
 * it resolves to the FIRST top-nav entry rather than matching nothing.
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

    // A host's tile, or another project's, is not a section of THIS copy:
    // localKind answers null for it (core/page_config.js).
    const usableKind = (id) => {
        const kind = localKind(id ? tree.get(id)?.content?.kind : null);
        return kind && !String(kind).startsWith('panel:') && kind !== 'window-placeholder' ? kind : null;
    };

    // A panel in focus means "the content tile I was just in", NOT the primary.
    // Pressing a rail row focuses the rail on MOUSEDOWN; answering with the
    // primary leaf flipped the section whenever the user worked in any other
    // tile (Bugs in a split beside a Backlog primary), the rail swapped stores
    // between press and release, and the click opened a filter of the OTHER
    // store under the pointer.
    const focusedId = tree.focusedLeafId;
    let activeKind = usableKind(focusedId);
    if (activeKind) lastContentLeaf.set(tree, focusedId);
    else activeKind = usableKind(lastContentLeaf.get(tree)) || usableKind(tree.primaryLeafId?.());
    if (!activeKind) return null;

    // WALK UP to the nearest kind that actually has a chip. FlexDesk's own
    // `topNavFor` is a SINGLE hop — it returns `meta.topNav` verbatim — which is
    // enough only while every kind points straight at a top-nav entry. Tracker
    // mode nests them two deep (`item` → `backlog` → `tracker`, because Tickets
    // is not its own section there), and one hop lands on `backlog`, which
    // matches no chip: nothing lit, and the left rail with no section to follow.
    const seen = new Set();
    let kind = activeKind;
    while (kind && !seen.has(kind)) {
        seen.add(kind);
        const meta = taxonomy.meta(kind);
        if (meta?.isTopNav) return kind;
        kind = meta?.topNav;
    }

    return (activeKind === 'home' ? taxonomy.topNavEntries()[0]?.kind : null)
        || activeKind
        || null;
}
