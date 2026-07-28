/**
 * Workspace Save Controller (js_new)
 *
 * Purpose
 * -------
 * Manage autosave cadence, dirty tracking, and host persistence for the new workspace stack.
 *
 * Responsibilities
 * - Listen for registry/node mutations and mark the workspace dirty.
 * - Run throttled saves through the Serializer + DataManager, delegating IO to the host bridge.
 * - Surface save status events to the UI (status bar, notifications).
 *
 * Source Material
 * - html/js/workspace_manager.js (autosave + export flows).
 * - html/js/main.js (legacy timers) to ensure new implementation eliminates setTimeout hacks.
 */

import { WorkspaceSerializer } from '../data/serializer.js';

const SAVE_EVENTS = Object.freeze({
    DIRTY: 'workspace:save:dirty',
    STARTED: 'workspace:save:started',
    COMPLETED: 'workspace:save:completed',
    FAILED: 'workspace:save:failed',
});

const DEFAULT_DIRTY_EVENTS = Object.freeze([
    'data:namespaces:added',
    'data:namespaces:removed',
    'data:sectors:updated',
    'data:stocks:updated',
    'data:variables:updated',
    'data:flows:updated',
    'data:captions:updated',
    'data:groups:updated',
    'modules:updated',
    'node:snapshot:updated',
    'node:created',
    'node:removed',
    'connection:added',
    'connection:removed',
    'connection:updated',
    'connection:geometry:updated',
    'data:dsl:updated',
    'data:etlPipelines:updated',
    'calibration:setup:changed',
]);

export class WorkspaceSaveController {
    constructor({
        dataManager,
        persistenceAdapter,
        eventBus = null,
        logger = null,
        serializer = WorkspaceSerializer,
        autosaveIntervalMs = 60000,
        debounceMs = 2500,
        dirtyEvents = DEFAULT_DIRTY_EVENTS,
        autoStart = true,
    } = {}) {
        if (!dataManager) {
            throw new Error('WorkspaceSaveController requires a DataManager instance');
        }
        if (!persistenceAdapter || typeof persistenceAdapter.saveWorkspace !== 'function') {
            throw new Error('WorkspaceSaveController requires a persistenceAdapter with saveWorkspace()');
        }

        this.dataManager = dataManager;
        this.persistenceAdapter = persistenceAdapter;
        this.eventBus = eventBus;
        this.logger = logger;
        this.serializer = serializer;
        this.autosaveIntervalMs = autosaveIntervalMs;
        this.debounceMs = debounceMs;
        this.dirtyEvents = [...dirtyEvents];

        this.dirty = false;
        this.saving = false;
        this.lastSaveAt = null;
        this.lastError = null;
        this._listenerDisposers = [];
        this._autosaveTimer = null;
        this._debounceTimer = null;
        this._started = false;

        if (autoStart) {
            this.start();
        }
    }

    start() {
        if (this._started) {
            return;
        }
        console.log('[WorkspaceSaveController] Starting - subscribing to dirty events');
        this._started = true;
        this.#subscribeDirtyEvents();
        this.#scheduleAutosave();
        console.log('[WorkspaceSaveController] Started - listening for:', this.dirtyEvents);
    }

    stop() {
        if (!this._started) {
            return;
        }
        this._started = false;
        this.#clearTimers();
        this.#cleanupListeners();
    }

    dispose() {
        this.stop();
    }

    isDirty() {
        return this.dirty;
    }

    async requestSave({ reason = 'manual', skipIfClean = false } = {}) {
        if (skipIfClean && !this.dirty) {
            return { skipped: true, reason: 'clean' };
        }
        return this.#performSave(reason);
    }

    markDirty(reason = 'unknown') {
        if (!this._started) {
            this.logger?.debug?.('workspace-save', 'markDirty called but controller not started', { reason });
            return;
        }
        this.dirty = true;
        this.lastDirtyReason = reason;
        this.logger?.debug?.('workspace-save', 'Marked dirty', { reason });
        this.#emitBus(SAVE_EVENTS.DIRTY, { reason });
        this.#scheduleDebouncedSave();
    }

    #subscribeDirtyEvents() {
        if (!this.eventBus) {
            return;
        }
        this.dirtyEvents.forEach((eventName) => {
            const disposer = this.eventBus.on(eventName, () => this.markDirty(eventName));
            this._listenerDisposers.push(disposer);
        });
    }

    #cleanupListeners() {
        this._listenerDisposers.forEach((disposer) => {
            try {
                disposer?.dispose();
            } catch (err) {
                this.logger?.warn?.('workspace-save', 'Failed to dispose listener', { error: err });
            }
        });
        this._listenerDisposers = [];
    }

    #scheduleAutosave() {
        if (!Number.isFinite(this.autosaveIntervalMs) || this.autosaveIntervalMs <= 0) {
            return;
        }
        this._autosaveTimer = setInterval(() => {
            if (!this.dirty || this.saving) {
                return;
            }
            this.#performSave('autosave');
        }, this.autosaveIntervalMs);
    }

    #scheduleDebouncedSave() {
        if (!Number.isFinite(this.debounceMs) || this.debounceMs <= 0) {
            return;
        }
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            if (this.dirty && !this.saving) {
                this.#performSave('debounced');
            }
        }, this.debounceMs);
    }

    async #performSave(reason) {
        if (this.saving) {
            return { skipped: true, reason: 'saving' };
        }
        this.saving = true;
        this.lastError = null;
        this.logger?.info?.('workspace-save', 'Starting save', { reason });
        this.#emitBus(SAVE_EVENTS.STARTED, { reason });

        try {
            // serializeWorkspace returns an already-serialized payload object
            const payload = this.dataManager.serializeWorkspace();
            this.logger?.debug?.('workspace-save', 'Serialized workspace', {
                namespaceCount: payload?.namespaces?.length ?? 0,
                nodeCount: payload?.nodes?.length ?? 0,
                moduleCount: payload?.modules?.length ?? 0
            });
            await this.persistenceAdapter.saveWorkspace({ payload, reason });

            this.dirty = false;
            this.lastSaveAt = Date.now();
            this.logger?.info?.('workspace-save', 'Save completed', { reason });
            this.#emitBus(SAVE_EVENTS.COMPLETED, {
                reason,
                timestamp: this.lastSaveAt,
            });
            return { saved: true, timestamp: this.lastSaveAt };
        } catch (error) {
            this.lastError = error;
            this.#emitBus(SAVE_EVENTS.FAILED, { reason, error });
            this.logger?.error?.('workspace-save', 'Workspace save failed', { error, reason });
            throw error;
        } finally {
            this.saving = false;
        }
    }

    #clearTimers() {
        if (this._autosaveTimer) {
            clearInterval(this._autosaveTimer);
            this._autosaveTimer = null;
        }
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    #emitBus(eventName, payload) {
        if (!this.eventBus || !eventName) {
            return;
        }
        try {
            this.eventBus.emit(eventName, payload);
        } catch (err) {
            this.logger?.warn?.('workspace-save', 'Failed to emit save event', {
                eventName,
                error: err,
            });
        }
    }
}

WorkspaceSaveController.EVENTS = SAVE_EVENTS;
WorkspaceSaveController.DEFAULT_DIRTY_EVENTS = DEFAULT_DIRTY_EVENTS;
