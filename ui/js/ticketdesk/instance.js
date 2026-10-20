/**
 * instance.js — which STORE this copy of the ticketdesk modules serves.
 *
 * A project page shows the global TRACKER beside its own bugs and backlog. The
 * tracker is a second backlog-shaped store with its own records, its own ids
 * (its STORY-0002 is not the project's), its own saved filters and its own live
 * updates — and every module in this directory keeps that kind of state at
 * module level: `ITEMS`, the filter list, the SSE connection.
 *
 * So the page loads this directory TWICE. The second time from an alias,
 * `js/ticketdesk@t/`, which the bridge serves from the same files (see the
 * routing in server/Program.cs). A different URL is a different module
 * instance, so the tracker's copy has its own `ITEMS` and everything else, while
 * the modules OUTSIDE this directory — the window manager, the taxonomy,
 * settings, dialogs — are imported by relative paths that resolve to the same
 * URLs from both copies and stay shared.
 *
 * This file is how a copy knows which one it is: from its own URL.
 *
 *   the page's copy     the store the page was opened on (/p/<name>/, or /t/ for
 *                       standalone TicketDesk) — config from the page, API
 *                       relative to it, the page kinds the app has always had
 *   the tracker's copy  the global tracker inside a project page — config and
 *                       API at /t/, and page kinds of its own so its tabs and
 *                       its breadcrumbs never collide with the backlog's
 *
 * EMBEDDED in another FlexDesk application (EPIC-0051) the page is not
 * BugDesk's, so neither the page's config nor a relative API is this copy's:
 * both come from the copy's own URL instead, through core/page_config.js — the
 * API at `<root>/api` (the tracker's at `/t/api` of the same server) and the
 * config fetched from there before any module that imports this one runs.
 */

import {
    EMBEDDED, API_BASE, TRACKER_API_BASE, fetchConfig, kindPrefix, pageConfig, shapeTrackerConfig,
} from '../core/page_config.js';

export const IS_TRACKER_COPY = /\/ticketdesk@t\//.test(import.meta.url);

/** This copy's API. The page's own is RELATIVE on BugDesk's page, so it follows
 *  whatever prefix the page was served under, and absolute when embedded; the
 *  tracker's is always at /t/. */
const API = IS_TRACKER_COPY ? TRACKER_API_BASE : API_BASE;
export const apiUrl = (path) => `${API}${String(path).startsWith('/') ? '' : '/'}${path}`;

/** The config this copy reads: the page's own, or the tracker's, which the page
 *  fetched before loading this copy (see tiling/install.js) — or, embedded, the
 *  one this copy fetched from its own API. */
export const CONFIG = (typeof window === 'undefined' ? null
    : !IS_TRACKER_COPY ? pageConfig()
    : EMBEDDED ? shapeTrackerConfig(await fetchConfig(apiUrl('/config')))
    : window.__BUGDESK_TRACKER_CONFIG__) || {};

/**
 * The page kinds this copy registers and opens. The page's copy keeps the names
 * saved layouts and links already use; the tracker's are distinct so that a
 * tracker ticket and a backlog item are never the same kind — they would share
 * a tab, a breadcrumb and a section, and open each other's records.
 */
export const KIND = IS_TRACKER_COPY
    ? { list: 'tracker-tickets', item: 'tracker-item', newItem: 'tracker-new', dashboard: 'tracker' }
    : { list: 'backlog', item: 'item', newItem: 'new-item', dashboard: 'tracker' };

/** An event name on the SHARED bus, scoped to this PROJECT: what the host's
 *  kind prefix makes of it (see core/page_config.js), so two projects mounted in
 *  one shell do not reload each other's lists or claim each other's records.
 *  On BugDesk's own page the prefix is '' and the name is unchanged. */
export const busEvent = (name) => `${kindPrefix()}${name}`;

/** An event name on the SHARED bus, scoped to this copy — the tracker's
 *  "backlog changed" must not make the project's backlog reload, and vice versa. */
export const ev = (name) => busEvent(IS_TRACKER_COPY ? `tracker/${name}` : name);

/** Which copy rendered a record link (markdown.js), so only that copy's click
 *  handler opens it (ref_autolink.js): '' for the page's copy on BugDesk's own
 *  page, as it always was. */
export const copyId = () => `${kindPrefix()}${IS_TRACKER_COPY ? 'tracker' : ''}`;

/** Whether THIS copy's store has its bugs or its backlog half — the copy-local
 *  counterpart of core/app_identity.js's storeHas, which answers for the page. */
export function has(half) {
    const store = CONFIG.store;
    if (!store) return true;
    return half === 'bugs' ? store.hasBugs !== false : store.hasBacklog !== false;
}

/** Load a module of the tracker's copy — for the page's copy, which owns the
 *  side panels and has to show the tracker's rail and team when the Tracker
 *  section is in front. */
export const trackerModule = (file) => import(new URL(`../ticketdesk@t/${file}`, import.meta.url).href);

/** What a half of THIS copy's store is called where several stores share a
 *  list (the bottom panel's Changes and Alerts): the tracker's copy is the
 *  Tracker, standalone TicketDesk's records are Tickets. */
export function storeLabelOf(store) {
    if (IS_TRACKER_COPY) return 'Tracker';
    if (store === 'bugs') return 'Bugs';
    return CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog';
}
