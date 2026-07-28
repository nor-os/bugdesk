/**
 * table_state_store.js — persist DataTable view-state (sort, filters,
 * column widths) per project, keyed by a caller-supplied `persistKey`.
 *
 * Mirrors the tiling shell's desktop-layout persistence: a single JSON
 * blob written through the pywebview `workspace_state` bridge under
 * `<project>/.ecoagent/datatable_state.json`. One file holds a map of
 * `{ [persistKey]: state }` for every persisted table in the project.
 *
 * The in-memory cache must be dropped when the project changes (the app
 * swaps projects in-place without a page reload) — `resetTableStore()`
 * is wired to the `project:opened` event in app_bootstrap.
 */

const FILE = '.ecoagent/datatable_state.json';

let _cache = null;        // { [key]: state } — null until first load
let _loadPromise = null;
let _saveTimer = null;

function _api() {
    // Same bridge handle the rest of the UI uses (see memory: the UI
    // bridge is always `window.pywebview?.api`).
    return window.pywebview?.api || null;
}

/** Resolve once the on-disk blob has been read into the cache. Safe to
 *  call repeatedly — the read happens at most once per project. */
export function tableStoreReady() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        const api = _api();
        if (!api?.workspace_state_read) { _cache = {}; return _cache; }
        try {
            const blob = await api.workspace_state_read({ path: FILE });
            _cache = blob
                ? (typeof blob === 'string' ? JSON.parse(blob) : blob)
                : {};
        } catch (err) {
            console.warn('[table-state] load failed', err);
            _cache = {};
        }
        return _cache;
    })();
    return _loadPromise;
}

/** Synchronous read of a table's persisted state. Returns null until
 *  the cache is loaded (await `tableStoreReady()` first to be sure). */
export function getTableState(key) {
    if (!key || !_cache) return null;
    return _cache[key] || null;
}

/** Merge-and-persist a table's state (debounced). Pass null to forget a
 *  key. Writes the whole map back atomically via the bridge. */
export function setTableState(key, state) {
    if (!key) return;
    if (!_cache) _cache = {};
    if (state == null) delete _cache[key];
    else _cache[key] = state;
    _scheduleSave();
}

/** Drop the cache + pending read so the next access reloads from the
 *  newly-opened project. Cancels any in-flight save for the old one. */
export function resetTableStore() {
    _cache = null;
    _loadPromise = null;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}

function _scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
        _saveTimer = null;
        const api = _api();
        if (!api?.workspace_state_write || !_cache) return;
        try {
            await api.workspace_state_write({
                path: FILE,
                data: JSON.stringify(_cache),
            });
        } catch (err) {
            console.warn('[table-state] save failed', err);
        }
    }, 500);
}
