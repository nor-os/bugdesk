/**
 * ticketdesk/embed.js — one project's BugDesk, for another FlexDesk application.
 *
 * The convenience entry of the embedding contract (README, "Embedding BugDesk",
 * EPIC-0051). A host imports it from the project's own URL —
 * `<bugdesk>/p/<name>/js/ticketdesk/embed.js` — and gets that project's pages,
 * talking to that project's API, under kind names of the host's choosing. It
 * adds nothing a host could not do with pages.js, backlog_pages.js and
 * new_item.js directly; it does the same steps BugDesk's own shell does
 * (tiling/install.js), in the same order, for a shell that is not BugDesk's:
 *
 *   1. the copy's config is already loaded — importing this module waits for
 *      core/page_config.js to fetch it from `<root>/api/config`
 *   2. both stores are loaded, so the first mount draws real rows
 *   3. the content kinds are built, namespaced by `kindPrefix`
 *   4. `start({ wm })`, once the host's WM exists, opens the live-update
 *      stream and the document-level record-link and drop handlers
 *
 * Import it once per project: each project prefix is a separate module graph,
 * with its own records, config, filters and event stream.
 */

import { API_BASE, COPY_ROOT, EMBEDDED, kindPrefix as currentPrefix, nsKind, setKindPrefix } from '../core/page_config.js';
import { storeHas } from '../core/app_identity.js';
import { embedKinds, namespaceWm } from '../tiling/kind_taxonomy.js';
import { CONFIG, apiUrl, busEvent } from './instance.js';
import { createTicketDeskContent, statusLine } from './pages.js';
import { createBacklogContent } from './backlog_pages.js';
import { createNewItemContent } from './new_item.js';
import { TICKETS, loadData } from './data.js';
import { ITEMS, loadBacklog } from './backlog_data.js';
import * as bugFilters from './filters.js';
import * as backlogFilters from './backlog_filters.js';

/**
 * Load this project's stores and build its content kinds for a host.
 *
 * @param {object} o
 * @param {object} o.eventBus       the host's bus (@flexdesk/core EventBus)
 * @param {string} [o.kindPrefix]   e.g. `'bugdesk:alpha/'` — REQUIRED in practice
 *        once two projects share a shell: it namespaces the kinds and the store
 *        events, and must be the same on every load, since saved layouts name it
 * @param {object} [o.logger]
 * @returns {Promise<object>} see README, "Embedding BugDesk"
 */
export async function createBugDeskEmbed({ eventBus, kindPrefix = '', logger } = {}) {
    const log = logger ?? console;
    setKindPrefix(kindPrefix);

    // The stores this project has: the other's endpoints answer 404 by design.
    const [bugs, backlog] = await Promise.allSettled([
        storeHas('bugs') ? loadData() : Promise.resolve({ count: 0 }),
        storeHas('backlog') ? loadBacklog() : Promise.resolve({ count: 0 }),
    ]);
    if (bugs.status === 'rejected') log.warn?.(`[bugdesk] ${COPY_ROOT}: bugs could not be loaded`, bugs.reason);
    if (backlog.status === 'rejected') log.warn?.(`[bugdesk] ${COPY_ROOT}: backlog could not be loaded`, backlog.reason);

    const content = {
        ...createTicketDeskContent({ eventBus, kindPrefix }),
        ...createBacklogContent({ eventBus, kindPrefix }),
        ...createNewItemContent({ eventBus, kindPrefix }),
    };

    let started = null;
    return {
        /** `<bugdesk>/p/<name>/` — where this copy came from. */
        root: COPY_ROOT,
        /** Its API: `<root>api`, absolute when embedded. */
        apiBase: API_BASE,
        apiUrl,
        embedded: EMBEDDED,
        /** The copy's own config (the shape of window.__BUGDESK_CONFIG__ on
         *  BugDesk's page): `store.name`, `humanAuthor`, `numbering`, … */
        config: CONFIG,
        kindPrefix: currentPrefix(),
        /** `{ [prefix+kind]: factory }`, for the host's createContentRegistry. */
        content,
        /** Entries for the host's createTaxonomy({ kinds }). */
        kinds: embedKinds(),
        /** A BugDesk kind (`'queues'`, `'ticket'`, `'backlog'`, `'item'`,
         *  `'new-item'`) as the host's WM knows it. */
        kind: nsKind,
        /** A store event as it appears on the host's bus: `'bugs:changed'`,
         *  `'backlog:changed'`, `'store:changed'`, `'git:changed'`. */
        event: busEvent,
        /** The rail's filters with their counts now, per store — for a host
         *  that draws its own rail. Recount on `event('bugs:changed')` and
         *  `event('backlog:changed')`. */
        filters: () => ({
            bugs: storeHas('bugs') ? counted(bugFilters, TICKETS) : [],
            backlog: storeHas('backlog') ? counted(backlogFilters, ITEMS) : [],
        }),
        /**
         * Once the host's WindowManager exists: the live-update stream
         * (`<root>api/events`), record links in descriptions and comments, and
         * records dropped on a tile. Idempotent.
         */
        async start({ wm } = {}) {
            if (started) return started;
            const [live, links, dnd] = await Promise.all([
                import('./live.js'), import('./ref_autolink.js'), import('./record_dnd.js'),
            ]);
            const stream = live.installLiveUpdates({ eventBus, logger: log });
            const clicks = wm ? links.installRecordLinkClicks({ wm: namespaceWm(wm), onStatus: statusLine }) : null;
            const drops = wm ? dnd.installRecordDropTargets({ wm }) : null;
            started = {
                stop: () => {
                    stream?.close?.();
                    clicks?.dispose?.();
                    drops?.destroy?.();
                    started = null;
                },
            };
            return started;
        },
        /** Re-read both stores (the live stream does this by itself). */
        reload: () => Promise.allSettled([
            storeHas('bugs') ? loadData() : null, storeHas('backlog') ? loadBacklog() : null,
        ]),
    };
}

/** Builtins, then the person's own, each with how many rows it matches. */
function counted(filters, rows) {
    const all = [...filters.BUILTIN_FILTERS, ...filters.listFilters()];
    return all.map((f) => {
        let count = null;
        try { count = rows.filter(filters.matcherFor(f.expr)).length; } catch { /* a broken filter counts nothing */ }
        return { key: f.builtin ? f.key : f.id, label: f.label, icon: f.icon || 'filter_alt', builtin: !!f.builtin, count };
    });
}
