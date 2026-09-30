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
 */

export const IS_TRACKER_COPY = /\/ticketdesk@t\//.test(import.meta.url);

/** The config this copy reads: the page's own, or the tracker's, which the page
 *  fetched before loading this copy (see tiling/install.js). */
export const CONFIG = (typeof window === 'undefined' ? null
    : IS_TRACKER_COPY ? window.__BUGDESK_TRACKER_CONFIG__ : window.__BUGDESK_CONFIG__) || {};

/** This copy's API. The page's own is RELATIVE, so it follows whatever prefix
 *  the page was served under; the tracker's is always at /t/. */
const API = IS_TRACKER_COPY ? '/t/api' : 'api';
export const apiUrl = (path) => `${API}${String(path).startsWith('/') ? '' : '/'}${path}`;

/**
 * The page kinds this copy registers and opens. The page's copy keeps the names
 * saved layouts and links already use; the tracker's are distinct so that a
 * tracker ticket and a backlog item are never the same kind — they would share
 * a tab, a breadcrumb and a section, and open each other's records.
 */
export const KIND = IS_TRACKER_COPY
    ? { list: 'tracker-tickets', item: 'tracker-item', newItem: 'tracker-new', dashboard: 'tracker' }
    : { list: 'backlog', item: 'item', newItem: 'new-item', dashboard: 'tracker' };

/** An event name on the SHARED bus, scoped to this copy — the tracker's
 *  "backlog changed" must not make the project's backlog reload, and vice versa. */
export const ev = (name) => (IS_TRACKER_COPY ? `tracker/${name}` : name);

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
