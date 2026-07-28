/**
 * recent_files.js — localStorage-backed recent workspace file list.
 *
 * Stores up to MAX_ENTRIES recently opened/saved workspace paths so the
 * File > Open Recent menu can offer quick access.
 */

const STORAGE_KEY = 'ecosim.recentFiles.v1';
const MAX_ENTRIES = 10;

/**
 * @typedef {{ path: string, name: string, openedAt: number }} RecentFileEntry
 */

/** @returns {RecentFileEntry[]} */
export function getRecentFiles() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Add (or promote) a file to the top of the recent list.
 * Deduplicates by path, prepends, and trims to MAX_ENTRIES.
 */
export function addRecentFile(path, name) {
    if (!path) return;
    const list = getRecentFiles().filter((e) => e.path !== path);
    list.unshift({ path, name: name || path.split(/[\\/]/).pop(), openedAt: Date.now() });
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Remove a single entry by path (e.g. when file no longer exists). */
export function removeRecentFile(path) {
    const list = getRecentFiles().filter((e) => e.path !== path);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Clear the entire recent files list. */
export function clearRecentFiles() {
    localStorage.removeItem(STORAGE_KEY);
}
