/**
 * entity_sources.js — declarative registry of every searchable entity.
 *
 * The command palette + tile-tabs hamburger menu + object explorer all
 * iterate `ENTITY_SOURCES` and concatenate the shaped results. Adding
 * a new entity type = one entry here; no hand-edits in the palette,
 * no per-kind branches duplicated across the chrome.
 *
 * ## Registry topology (post-consolidation)
 *
 *   Python `RegistryEntry` store (sim/sfc/registry.py)
 *     Unified archetype-world store. Surfaced via the bridge as
 *     `registry_list()`. Narrow scope: archetype/asset_kind/sector_kind/
 *     market_kind + their templates. Used by archetypes_landing.
 *
 *   Bridge `browser_entities()`     ← single source of truth for THIS file
 *     One-shot aggregator that returns every navigable entity-kind
 *     list keyed by navKind. `loadEntitiesGrouped` prefers this so the
 *     palette / hamburger menu / object explorer make ONE bridge call
 *     instead of fanning out 13. Falls back to per-source `listFn`
 *     calls for backward compat with older bridges that don't ship
 *     the aggregator yet.
 *
 *   Bridge `browser_sources_list()`
 *     Manifest the bottom-panel Registries tab uses. Distinct from the
 *     above because it ALSO catalogues runtime registries (metrics,
 *     brain_history, events) + categorises sources (graph / document /
 *     time_series). Different consumer, different scope.
 *
 * ## Per-source fields
 *
 *   navKind   The content kind used to open a row via `wm.navigate`.
 *             The taxonomy in `kind_taxonomy.js` resolves icon + label.
 *
 *   listFn    `(api) => Promise<rawList>` — per-source fetcher used by
 *             the legacy fan-out path. Kept so the loader can fall
 *             back when the consolidated bridge endpoint isn't
 *             present, and so adding a new source remains a
 *             one-frontend-file change even if the bridge lags.
 *
 *   pluck?    `(raw) => Array` — extract the actual list when the
 *             endpoint wraps it (e.g. scenarios_list returns
 *             `{ scenarios: [...] }`). Defaults to "raw is array,
 *             else raw.items if array, else []".
 *
 *   shape     `(row) => { id, label, hint? } | null` — normalize one
 *             raw row to the palette's record shape. Return `null` to
 *             skip the row (e.g. system rows the user can't open).
 *
 * Errors from any single source are logged and treated as "empty" so
 * one broken endpoint doesn't blank the entire palette.
 */

// BugDesk: the palette searches the local bug store — Ctrl+K IS the bug
// quicksearch. `listFn` may return a plain array; the loader treats
// non-promises the same way. The `bug` source is the only entity kind.
import { TICKETS as _TDT } from '../ticketdesk/data.js';

export const ENTITY_SOURCES = [
    {
        navKind: 'ticket',
        listFn:  () => _TDT,
        shape:   (t) => ({
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
 *  as themselves automatically (see `resolveTypePrefix`). */
const TYPE_ALIASES = {
    bug:     ['ticket'],
    bugs:    ['ticket'],
    tickets: ['ticket'],
};


/** Resolve a user-typed type prefix to a list of canonical navKinds.
 *  Accepts: explicit aliases (`asset` → `asset_kind`), navKinds
 *  verbatim (`asset_kind`), and underscore variants of hyphenated
 *  kinds (`market_archetype` → `market-archetype`). Returns an array
 *  of navKinds on hit, `null` otherwise. */
export function resolveTypePrefix(prefix) {
    const p = String(prefix || '').toLowerCase().trim();
    if (!p) return null;
    if (TYPE_ALIASES[p]) return TYPE_ALIASES[p];
    for (const src of ENTITY_SOURCES) {
        if (src.navKind === p) return [src.navKind];
        if (src.navKind.replace(/-/g, '_') === p) return [src.navKind];
    }
    return null;
}


/** Fetch every source's raw rows, grouped by `navKind`.
 *
 *  Preferred path: one round-trip through the bridge's
 *  `browser_entities()` aggregator. The fan-out fallback (per-source
 *  `listFn` calls in parallel) only fires when:
 *
 *    - the bridge predates the aggregator (no `api.browser_entities`),
 *    - the aggregator threw, OR
 *    - the aggregator returned a payload that's missing keys (newly-
 *      added navKinds the bridge doesn't know about yet — we fan out
 *      only for the missing ones, not for the whole set).
 *
 *  Shape: `{ [navKind]: rawRow[] }` — every navKind in ENTITY_SOURCES
 *  is always present (empty array on fetch failure) so consumers can
 *  destructure safely. */
export async function loadEntitiesGrouped(api) {
    const out = {};
    for (const src of ENTITY_SOURCES) out[src.navKind] = [];
    if (!api) return out;

    // 1. Try the consolidated endpoint first.
    let consolidated = null;
    if (typeof api.browser_entities === 'function') {
        try {
            const res = await api.browser_entities();
            if (res && typeof res === 'object' && res.kinds
                && typeof res.kinds === 'object') {
                consolidated = res.kinds;
            }
        } catch (err) {
            console.warn(
                '[entity-sources] browser_entities failed, '
                + 'falling back to per-source fetches', err);
        }
    }

    // 2. Distribute consolidated payload + identify any missing
    //    navKinds the bridge didn't ship (new frontend source, older
    //    bridge). Those get the legacy fetch.
    const missing = [];
    for (const src of ENTITY_SOURCES) {
        const raw = consolidated ? consolidated[src.navKind] : undefined;
        if (raw == null && consolidated) {
            // Aggregator answered but doesn't know about this navKind.
            missing.push(src);
            continue;
        }
        if (raw == null) {
            // No aggregator at all — fall back for every source.
            missing.push(src);
            continue;
        }
        const list = src.pluck
            ? src.pluck(raw)
            : (Array.isArray(raw) ? raw
              : Array.isArray(raw?.items) ? raw.items
              : []);
        out[src.navKind] = Array.isArray(list) ? list : [];
    }
    if (missing.length === 0) return out;

    // 3. Legacy fan-out — for sources the aggregator didn't cover.
    await Promise.all(missing.map(async (src) => {
        let raw;
        try { raw = await src.listFn(api); }
        catch (err) {
            console.warn('[entity-sources]', src.navKind, 'fetch failed', err);
            return;
        }
        const list = src.pluck
            ? src.pluck(raw)
            : (Array.isArray(raw) ? raw
              : Array.isArray(raw?.items) ? raw.items
              : []);
        out[src.navKind] = Array.isArray(list) ? list : [];
    }));
    return out;
}

/** Flat-and-shaped form for search surfaces (command palette, any
 *  future global "go to entity"). Builds on `loadEntitiesGrouped` so
 *  there's a single fetch path and the palette / explorer can't drift
 *  apart in coverage. */
export async function loadAllEntities(api) {
    const grouped = await loadEntitiesGrouped(api);
    const out = [];
    for (const src of ENTITY_SOURCES) {
        for (const row of grouped[src.navKind] || []) {
            let shaped;
            try { shaped = src.shape(row); }
            catch (err) {
                console.warn('[entity-sources]', src.navKind, 'shape failed', err, row);
                continue;
            }
            if (!shaped || !shaped.id) continue;
            out.push({ kind: src.navKind, ...shaped });
        }
    }
    return out;
}
