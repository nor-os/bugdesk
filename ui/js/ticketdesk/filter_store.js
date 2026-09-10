/**
 * ticketdesk/filter_store.js — the user's saved filters, for both stores.
 *
 * ONE list, tagged by SCOPE ('bugs' | 'backlog'). Not two stores: the bridge
 * endpoint is a full-list replace (`POST /api/filters` with everything), so two
 * independent stores would each POST their own half and the second write would
 * delete the first one's filters. One list, two views over it.
 *
 * Persistence: `GET`/`POST /api/filters`, per-user since the profile landed
 * (server/UserConfig.cs — two people on a repo have different questions to ask
 * of the same records), with `localStorage['bugdesk.filters']` as an OFFLINE
 * MIRROR. Every successful load/save writes the mirror, and a failed bridge call
 * falls back to it so a stale bridge still leaves the UI usable. The failure is
 * logged, never silently swallowed.
 *
 * A filter is `{ id, scope, label, icon, expr, builtin: false }`.
 *
 * Filters saved before scopes existed have none; they are read as 'bugs', which
 * is what they were — the backlog did not exist when they were written.
 */

const STORAGE_KEY = 'bugdesk.filters';
export const SCOPES = ['bugs', 'backlog'];
const DEFAULT_SCOPE = 'bugs';

let _filters = [];
const _subs = new Set();

function notify() {
    for (const cb of Array.from(_subs)) {
        try { cb(_filters); } catch (err) { console.warn('[bugdesk] filters subscriber failed', err); }
    }
}

function normalize(f, i) {
    const scope = SCOPES.includes(f?.scope) ? f.scope : DEFAULT_SCOPE;
    return {
        id: String(f?.id || `f${Date.now().toString(36)}${i}`),
        scope,
        label: String(f?.label || 'Untitled filter'),
        icon: String(f?.icon || 'filter_alt'),
        expr: f?.expr && typeof f.expr === 'object' ? f.expr : { kind: 'group', op: 'AND', children: [] },
        builtin: false,
    };
}
const normalizeAll = (list) => (Array.isArray(list) ? list.map(normalize) : []);

function readMirror() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        return normalizeAll(JSON.parse(raw));
    } catch (err) {
        // Corrupt mirror: report it and start clean rather than wedging the UI.
        console.warn('[bugdesk] discarding unreadable filter mirror', err);
        localStorage.removeItem(STORAGE_KEY);
        return [];
    }
}
const writeMirror = (list) => localStorage.setItem(STORAGE_KEY, JSON.stringify(list));

/** Fetch the saved filters from the bridge (mirror on failure) and populate the
 *  live store. Safe to call repeatedly — it always ends with a notify(). */
export async function loadFilters() {
    try {
        const res = await fetch('/api/filters', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`GET /api/filters → ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.filters)) throw new Error('bridge returned no filters array');
        _filters = normalizeAll(j.filters);
        writeMirror(_filters);
    } catch (err) {
        console.warn('[bugdesk] filter bridge unavailable, using local mirror:', err.message);
        _filters = readMirror();
    }
    notify();
    return _filters;
}

/** The saved filters of one scope. A fresh array — callers must not mutate the
 *  backing list, and a scope view cannot be the live array anyway. */
export const listFilters = (scope = DEFAULT_SCOPE) => _filters.filter((f) => f.scope === scope);

/** Resolve a saved filter id, or a builtin key from the supplied list. */
export function getFilter(id, builtins = []) {
    if (!id) return undefined;
    return builtins.find((b) => b.key === id) || _filters.find((f) => f.id === id);
}

const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Push the WHOLE list — every scope — to the bridge; the mirror is written
 *  first so an offline save still survives a reload. */
async function persist() {
    writeMirror(_filters);
    try {
        const res = await fetch('/api/filters', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ filters: _filters }),
        });
        if (!res.ok) throw new Error(`POST /api/filters → ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.filters)) throw new Error('bridge returned no filters array');
        _filters = normalizeAll(j.filters);
        writeMirror(_filters);
    } catch (err) {
        console.warn('[bugdesk] filters not persisted to the bridge (local mirror kept):', err.message);
    }
}

/** Create (falsy id) or update a saved filter; returns the stored record. */
export async function saveFilter(filter, scope = DEFAULT_SCOPE) {
    const id = filter?.id || newId();
    const rec = normalize({ ...filter, id, scope: filter?.scope || scope }, 0);
    const at = _filters.findIndex((f) => f.id === id);
    if (at >= 0) _filters[at] = rec; else _filters.push(rec);
    await persist();
    notify();
    return _filters.find((f) => f.id === id) || rec;
}

/** Remove a saved filter (builtin keys are not deletable and are ignored). */
export async function deleteFilter(id) {
    const at = _filters.findIndex((f) => f.id === id);
    if (at < 0) return;
    _filters.splice(at, 1);
    await persist();
    notify();
}

/** In-memory draft copy of a builtin OR a saved filter: deep-cloned expr,
 *  " (copy)" label, NO id — nothing is persisted until saveFilter() is called.
 *  This is the "copy a builtin into one of my own" path. */
export function duplicateFilter(keyOrId, builtins = [], scope = DEFAULT_SCOPE) {
    const src = getFilter(keyOrId, builtins);
    if (!src) return undefined;
    return {
        id: '',
        scope: src.scope || scope,
        label: `${src.label} (copy)`,
        icon: src.icon || 'filter_alt',
        expr: JSON.parse(JSON.stringify(src.expr || { kind: 'group', op: 'AND', children: [] })),
        builtin: false,
    };
}

/** Subscribe to store changes; returns the unsubscribe function. */
export function onFiltersChanged(cb) {
    _subs.add(cb);
    return () => _subs.delete(cb);
}
