const DEFAULT_LIMIT = 200;
const HISTORY_EVENTS = Object.freeze({
    STATE: 'history:state',
    REQUEST_UNDO: 'history:undo:request',
    REQUEST_REDO: 'history:redo:request',
});

export class HistoryService {

    /** @type {Array|null} Collects actions during a batch; null when not batching */
    #batchBuffer = null;

    constructor({
        eventBus,
        dataManager = null,
        logger = null,
        limit = DEFAULT_LIMIT,
    } = {}) {
        this.eventBus = eventBus;
        this.dataManager = dataManager;
        this.logger = logger;
        this.limit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

        this.undoStack = [];
        this.redoStack = [];
        this.isApplying = false;
        this.recordingEnabled = false;
        this._subscriptions = [];
    }

    start() {
        if (!this.eventBus) return;
        this.recordingEnabled = false; // enable after initial hydrate

        this.#subscribe('group:created', (payload) => this.#handleGroupCreated(payload));
        this.#subscribe('group:removed', (payload) => this.#handleGroupRemoved(payload));

        // Reset history after hydration so initial load is not undoable
        this.#subscribe('app:hydrated', () => {
            this.reset();
            this.recordingEnabled = true;
        });

        // Allow external triggers (keyboard/menu) to drive undo/redo
        this.#subscribe(HISTORY_EVENTS.REQUEST_UNDO, () => this.undo());
        this.#subscribe(HISTORY_EVENTS.REQUEST_REDO, () => this.redo());

        this.#emitState();
    }

    dispose() {
        this._subscriptions.forEach((dispose) => {
            try {
                dispose?.dispose?.();
            } catch (err) {
                this.logger?.warn?.('history', 'Failed to dispose subscription', { error: err });
            }
        });
        this._subscriptions = [];
        this.undoStack = [];
        this.redoStack = [];
        this.#batchBuffer = null;
    }

    reset() {
        this.undoStack = [];
        this.redoStack = [];
        this.#batchBuffer = null;
        this.#emitState();
    }

    // ─── Batch API ───────────────────────────────────────────────────────

    /**
     * Begin collecting actions into a batch.
     * While batching, individual #push() calls are buffered instead of
     * going onto the undo stack.
     */
    startBatch() {
        this.#batchBuffer = [];
    }

    /**
     * End batch collection and push a single composite action onto the undo stack.
     * @returns {object|null} The batch action, or null if no actions were collected.
     */
    endBatch() {
        const actions = this.#batchBuffer;
        this.#batchBuffer = null;
        if (!actions || actions.length === 0) return null;

        const batchAction = {
            type: 'batch',
            actions,
        };
        this.#push(batchAction);
        return batchAction;
    }

    /**
     * Apply a specific action directly, outside the undo/redo stack.
     * Used for AI message-level unapply/re-apply.
     * @param {object} action
     * @param {'undo'|'redo'} direction
     * @returns {boolean}
     */
    applyDirect(action, direction) {
        return this.#apply(action, direction);
    }

    // ─── Undo / Redo ─────────────────────────────────────────────────────

    undo() {
        if (!this.undoStack.length) return false;
        const action = this.undoStack.pop();
        const applied = this.#apply(action, 'undo');
        if (applied) {
            this.redoStack.push(action);
        } else {
            this.logger?.warn?.('history', 'Undo failed', { action });
        }
        this.#emitState();
        return applied;
    }

    redo() {
        if (!this.redoStack.length) return false;
        const action = this.redoStack.pop();
        const applied = this.#apply(action, 'redo');
        if (applied) {
            this.undoStack.push(action);
        } else {
            this.logger?.warn?.('history', 'Redo failed', { action });
        }
        this.#emitState();
        return applied;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    #push(action) {
        if (!action) return;
        if (!this.recordingEnabled || this.isApplying) return;

        if (this.#batchBuffer !== null) {
            this.#batchBuffer.push(action);
            return;
        }

        this.undoStack.push(action);
        if (this.undoStack.length > this.limit) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.#emitState(action);
    }

    #apply(action, direction) {
        if (!action) return false;
        this.isApplying = true;
        let result = false;
        try {
            switch (action.type) {
                case 'batch': {
                    const subActions = direction === 'undo'
                        ? [...action.actions].reverse()
                        : action.actions;
                    let allOk = true;
                    for (const sub of subActions) {
                        if (!this.#apply(sub, direction)) allOk = false;
                    }
                    result = allOk;
                    break;
                }
                case 'group:create':
                    result = direction === 'undo'
                        ? this.#removeGroup(action.groupData.id)
                        : this.#restoreGroup(action.groupData);
                    break;
                case 'group:remove':
                    result = direction === 'undo'
                        ? this.#restoreGroup(action.groupData)
                        : this.#removeGroup(action.groupData.id);
                    break;
                default:
                    this.logger?.warn?.('history', 'Unknown action type', { action });
            }
        } catch (err) {
            this.logger?.error?.('history', 'Failed to apply action', { action, direction, error: err });
        } finally {
            this.isApplying = false;
        }
        return result;
    }

    #handleGroupCreated({ groupData } = {}) {
        if (!groupData) return;
        this.#push({ type: 'group:create', groupData });
    }

    #handleGroupRemoved({ groupData } = {}) {
        if (!groupData) return;
        this.#push({ type: 'group:remove', groupData });
    }

    #restoreGroup(groupData) {
        if (!groupData || !this.dataManager) return false;
        try {
            this.dataManager.upsertGroup(groupData);
            return true;
        } catch (err) {
            this.logger?.warn?.('history', 'Failed to restore group', { id: groupData.id, error: err });
            return false;
        }
    }

    #removeGroup(groupId) {
        if (!groupId || !this.dataManager) return false;
        return this.dataManager.removeGroup(groupId);
    }

    #subscribe(eventName, handler) {
        if (!this.eventBus || typeof this.eventBus.on !== 'function') {
            return;
        }
        const disposer = this.eventBus.on(eventName, handler);
        this._subscriptions.push(disposer);
    }

    #emitState(lastAction = null) {
        const payload = {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0,
            lastAction,
        };
        try {
            this.eventBus?.emit?.(HISTORY_EVENTS.STATE, payload);
        } catch (err) {
            this.logger?.warn?.('history', 'Failed to emit state', { error: err });
        }
    }
}

HistoryService.EVENTS = HISTORY_EVENTS;
