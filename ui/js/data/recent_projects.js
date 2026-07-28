/**
 * RecentProjects — localStorage-backed list of recently opened projects.
 *
 * Stores up to MAX_ENTRIES entries, deduplicated by path, sorted by most
 * recently opened first.
 *
 * Entry shape: { path: string, name: string, openedAt: number }
 */

const STORAGE_KEY = 'ecosim.recentProjects.v1';
const MAX_ENTRIES = 10;

function _load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function _save(entries) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch { /* quota exceeded — silently drop */ }
}

/**
 * Get the recent projects list, most recent first.
 * @returns {Array<{path: string, name: string, openedAt: number}>}
 */
export function getRecentProjects() {
    return _load();
}

/**
 * Add or bump a project to the top of the recent list.
 * Deduplicates by normalized path and caps at MAX_ENTRIES.
 * @param {string} path  Absolute path to the project directory
 * @param {string} name  Display name
 */
export function addRecentProject(path, name) {
    const normalized = path.replace(/\\/g, '/');
    let entries = _load().filter(e => e.path.replace(/\\/g, '/') !== normalized);
    entries.unshift({ path, name, openedAt: Date.now() });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
    _save(entries);
}

/**
 * Remove a project from the recent list.
 * @param {string} path
 */
export function removeRecentProject(path) {
    const normalized = path.replace(/\\/g, '/');
    const entries = _load().filter(e => e.path.replace(/\\/g, '/') !== normalized);
    _save(entries);
}

/**
 * Clear all recent projects.
 */
export function clearRecentProjects() {
    localStorage.removeItem(STORAGE_KEY);
}
