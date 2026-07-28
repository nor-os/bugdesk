/**
 * Host Bridge Helpers
 * -------------------
 * Centralizes pywebview host bridge discovery, subscription, and persistence helpers so
 * the bootstrap (and tests) share a single path for interacting with the desktop host.
 *
 * Exports:
 * - DEFAULT_HOST_TIMEOUT_MS: shared timeout used when waiting for the pywebview bridge.
 * - DEFAULT_AUTOSAVE_KEY: legacy localStorage key (used for one-time migration).
 * - resolveHostBridge(): await an initial host bridge instance.
 * - setupHostBridgeListener(): subscribe for future bridge availability changes.
 * - createPersistenceAdapter(): create the persistence adapter that prefers host saves but
 *   gracefully falls back to IndexedDB storage when necessary.
 */

export const DEFAULT_HOST_TIMEOUT_MS = 8000;
export const DEFAULT_AUTOSAVE_KEY = 'ecosim.workspace.autosave.v1';

const IDB_NAME = 'ecosim-autosave';
const IDB_STORE = 'workspace';
const IDB_KEY = 'current';

function openAutosaveDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbPut(db, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const request = store.put(value, IDB_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function idbGet(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const request = store.get(IDB_KEY);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });
}

export async function resolveHostBridge({ provided, waitForReady, timeoutMs, logger }) {
    if (provided) {
        return provided;
    }
    if (typeof window === 'undefined') {
        return null;
    }
    if (window.pywebview?.api) {
        return window.pywebview.api;
    }
    if (!waitForReady) {
        return null;
    }

    return new Promise((resolve) => {
        const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HOST_TIMEOUT_MS;
        let settled = false;

        const cleanup = () => {
            window.removeEventListener('pywebviewready', onReady);
        };

        const onReady = () => {
            settled = true;
            cleanup();
            resolve(window.pywebview?.api ?? null);
        };

        window.addEventListener('pywebviewready', onReady, { once: true });
        if (timeout) {
            setTimeout(() => {
                if (settled) {
                    return;
                }
                cleanup();
                logger?.warn?.('host-bridge', 'Timed out waiting for pywebview bridge');
                resolve(window.pywebview?.api ?? null);
            }, timeout);
        }
    });
}

export function setupHostBridgeListener({ hostBridgeRef, onResolved, logger }) {
    if (typeof window === 'undefined') {
        return null;
    }
    const handler = () => {
        const bridge = window.pywebview?.api ?? null;
        if (!bridge || bridge === hostBridgeRef.current) {
            return;
        }
        try {
            onResolved(bridge);
        } catch (error) {
            logger?.warn?.('host-bridge', 'Host bridge listener failed', { error });
        }
    };
    window.addEventListener('pywebviewready', handler);
    return () => window.removeEventListener('pywebviewready', handler);
}

export function createPersistenceAdapter({ hostBridgeRef, storageKey = DEFAULT_AUTOSAVE_KEY, logger }) {
    const memoryStore = { snapshot: null };
    let dbPromise = null;

    function getDB() {
        if (!dbPromise && typeof indexedDB !== 'undefined') {
            dbPromise = openAutosaveDB().catch((err) => {
                logger?.warn?.('workspace-save', 'Failed to open IndexedDB', { error: err });
                dbPromise = null;
                return null;
            });
        }
        return dbPromise;
    }

    return {
        async saveWorkspace({ payload, reason }) {
            const preferHost = reason === 'manual' || reason === 'export';
            let hostResult = null;

            if (preferHost && hostBridgeRef.current && typeof hostBridgeRef.current.save_workspace_to_file === 'function') {
                try {
                    const response = await hostBridgeRef.current.save_workspace_to_file(payload);
                    if (response?.ok) {
                        hostResult = { ok: true, storage: 'host', path: response.path ?? null };
                    } else {
                        logger?.warn?.('workspace-save', 'Host save reported failure', { reason, response });
                    }
                } catch (error) {
                    logger?.warn?.('workspace-save', 'Host save threw error', { error, reason });
                }
            }

            let localResult = null;
            const db = await getDB();
            if (db) {
                try {
                    await idbPut(db, payload);
                    localResult = { ok: true, storage: 'indexeddb' };
                } catch (error) {
                    logger?.warn?.('workspace-save', 'Failed to persist to IndexedDB', { error });
                }
            }

            if (!localResult) {
                memoryStore.snapshot = payload;
                localResult = { ok: true, storage: 'memory' };
            }

            if (hostResult?.ok) {
                return { ...hostResult, fallback: localResult?.storage };
            }

            return localResult;
        },

        async getLastSnapshot() {
            // Try IndexedDB first
            const db = await getDB();
            if (db) {
                try {
                    const stored = await idbGet(db);
                    if (stored) {
                        return stored;
                    }
                } catch (error) {
                    logger?.warn?.('workspace-save', 'Failed to read IndexedDB snapshot', { error });
                }

                // One-time migration: move localStorage data to IndexedDB
                if (typeof window !== 'undefined' && window.localStorage) {
                    try {
                        const legacy = window.localStorage.getItem(storageKey);
                        if (legacy) {
                            const parsed = JSON.parse(legacy);
                            await idbPut(db, parsed);
                            window.localStorage.removeItem(storageKey);
                            logger?.info?.('workspace-save', 'Migrated autosave from localStorage to IndexedDB');
                            return parsed;
                        }
                    } catch (error) {
                        logger?.warn?.('workspace-save', 'Failed to migrate localStorage snapshot', { error });
                    }
                }
            }

            // Memory fallback
            if (memoryStore.snapshot) {
                return memoryStore.snapshot;
            }
            return null;
        },
    };
}
