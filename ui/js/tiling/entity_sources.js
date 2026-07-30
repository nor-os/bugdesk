/**
 * entity_sources.js — bugdesk's searchable-entity catalog, built via
 * `@flexdesk/wm`'s `createEntityCatalog({ sources, aliases, aggregate })`.
 *
 * This used to hand-roll its own grouped-fetch / aggregate-then-fan-out /
 * flatten-and-shape logic (`loadEntitiesGrouped`, `loadAllEntities`) over a
 * local `ENTITY_SOURCES` array. `createEntityCatalog` is the exact same
 * idea generalized: one-shot `aggregate(api)` preferred, per-source
 * `list(api)` fan-out for whatever the aggregator didn't answer for,
 * `shape(row)` normalizing one raw row, errors-as-empty per source. The
 * only rename is `listFn` -> `list` to match the library's `EntitySource`
 * shape.
 *
 * `ui/js/ecoagent/ui/{row_entry_mask,row_form}.js` are out of scope for
 * this migration (they live under the excluded `ui/js/ecoagent/**` tree)
 * and still import the old free-function names `loadAllEntities` /
 * `loadEntitiesGrouped` — kept below as thin wrappers over the catalog so
 * those two files don't need to change.
 */

import { createEntityCatalog } from '@flexdesk/wm';
import { TICKETS as _TDT } from '../ticketdesk/data.js';

// BugDesk: the palette searches the local bug store — Ctrl+K IS the bug
// quicksearch. `list` may return a plain array; the catalog treats
// non-promises the same way it treats promises. The `ticket` source is
// the only entity kind.
const SOURCES = [
    {
        navKind: 'ticket',
        list:  () => _TDT,
        shape: (t) => ({
            id:    t.id,
            label: `${t.id} — ${t.summary}`,
            hint:  `${t.status} · ${t.assignee}`,
            // The palette opens `ticket` with the display id as the key.
            props: { id: t.id, label: t.id },
        }),
    },
];

/** Friendly type-prefix aliases for the command palette's scoped search.
 *  `ticket:` and `bug:` both scope to the bug list. navKinds also resolve
 *  as themselves automatically. */
const ALIASES = {
    bug:     ['ticket'],
    bugs:    ['ticket'],
    tickets: ['ticket'],
};

/** One-shot bridge aggregator, preferred over the per-source fan-out when
 *  the bridge implements it. Mirrors the pre-extraction `browser_entities`
 *  handling verbatim: absent method or a throw both fall back to the
 *  catalog's normal per-source `list(api)` fan-out. */
async function aggregate(api) {
    if (typeof api?.browser_entities !== 'function') return null;
    const res = await api.browser_entities();
    return (res && typeof res === 'object' && res.kinds && typeof res.kinds === 'object')
        ? res.kinds
        : null;
}

export const entityCatalog = createEntityCatalog({ sources: SOURCES, aliases: ALIASES, aggregate });

// ─── Back-compat free functions for out-of-scope importers ──────────────────
export function loadAllEntities(api) { return entityCatalog.loadAll(api); }
export function loadEntitiesGrouped(api) { return entityCatalog.loadGrouped(api); }
export function resolveTypePrefix(prefix) { return entityCatalog.resolveTypePrefix(prefix); }
