import { NodePlatform } from '../nodes/node_platform.js';
import { ConnectorRouter } from '../nodes/connector_router.js';

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
        nodePlatform,
        connectorRouter,
        nodeRenderer,
        dataManager = null,
        workspaceResolver,
        logger = null,
        limit = DEFAULT_LIMIT,
        mountPlot,
        refreshOutput,
    } = {}) {
        this.eventBus = eventBus;
        this.nodePlatform = nodePlatform;
        this.connectorRouter = connectorRouter;
        this.nodeRenderer = nodeRenderer;
        this.dataManager = dataManager;
        this.workspaceResolver = typeof workspaceResolver === 'function' ? workspaceResolver : null;
        this.logger = logger;
        this.limit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
        this.mountPlot = typeof mountPlot === 'function' ? mountPlot : null;
        this.refreshOutput = typeof refreshOutput === 'function' ? refreshOutput : null;

        this.undoStack = [];
        this.redoStack = [];
        this.isApplying = false;
        this.recordingEnabled = false;
        this._subscriptions = [];
    }

    start() {
        if (!this.eventBus) return;
        this.recordingEnabled = false; // enable after initial hydrate
        this.#subscribe(NodePlatform.EVENTS.CREATED, (payload) => this.#handleNodeCreated(payload));
        this.#subscribe(NodePlatform.EVENTS.REMOVED, (payload) => this.#handleNodeRemoved(payload));
        this.#subscribe(NodePlatform.EVENTS.SNAPSHOT_UPDATED, (payload) => this.#handleSnapshotUpdated(payload));
        this.#subscribe(ConnectorRouter.EVENTS.ADDED, (payload) => this.#handleConnectionAdded(payload));
        this.#subscribe(ConnectorRouter.EVENTS.REMOVED, (payload) => this.#handleConnectionRemoved(payload));
        this.#subscribe(ConnectorRouter.EVENTS.GEOMETRY_UPDATED, (payload) => this.#handleConnectionGeometryUpdated(payload));

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
                case 'node:create':
                    result = direction === 'undo'
                        ? this.#removeNode(action.snapshot.id)
                        : this.#restoreNode(action.snapshot, action.connections);
                    break;
                case 'node:remove':
                    result = direction === 'undo'
                        ? this.#restoreNode(action.snapshot, action.connections)
                        : this.#removeNode(action.snapshot.id);
                    break;
                case 'node:rename':
                    result = this.#applyRename(action, direction);
                    break;
                case 'connection:add':
                    result = direction === 'undo'
                        ? this.#removeConnection(action.connection.id)
                        : this.#restoreConnection(action.connection);
                    break;
                case 'connection:remove':
                    result = direction === 'undo'
                        ? this.#restoreConnection(action.connection)
                        : this.#removeConnection(action.connection.id);
                    break;
                case 'connection:geometry':
                    result = this.#applyConnectionGeometry(action, direction);
                    break;
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

    #applyRename(action, direction) {
        const { nodeId, namespaceId, previousName, nextName } = action;
        const targetName = direction === 'undo' ? previousName : nextName;
        const record = this.nodePlatform?.getNodeSnapshot?.(nodeId);
        if (!record) return false;
        const patch = { config: { ...(record.config || {}), displayName: targetName } };
        this.nodePlatform.updateNodeSnapshot(nodeId, patch, { reason: 'history:rename', silent: false });
        return true;
    }

    #applyConnectionGeometry(action, direction) {
        const { connectionId, previousGeometry, nextGeometry } = action;
        const geometry = direction === 'undo' ? previousGeometry : nextGeometry;
        if (!this.connectorRouter?.updateConnectionGeometry) return false;
        this.connectorRouter.updateConnectionGeometry(connectionId, geometry, { reason: 'history' });
        return true;
    }

    #restoreConnection(connection) {
        if (!connection || !this.connectorRouter?.addConnection) return false;
        const exists = this.connectorRouter.getConnection?.(connection.id);
        if (exists) return true;
        try {
            this.connectorRouter.addConnection({ ...connection }, { skipGuards: true });
            return true;
        } catch (err) {
            this.logger?.warn?.('history', 'Failed to restore connection', { connectionId: connection.id, error: err });
            return false;
        }
    }

    #removeConnection(connectionId) {
        if (!connectionId || !this.connectorRouter?.removeConnection) return false;
        return this.connectorRouter.removeConnection(connectionId, { reason: 'history' });
    }

    #restoreNode(snapshot, connections = []) {
        if (!snapshot || !this.nodePlatform?.createNode || !this.nodeRenderer) return false;
        const existing = this.nodePlatform.getNodeSnapshot?.(snapshot.id);
        if (!existing) {
            const created = this.nodePlatform.createNode({
                type: snapshot.type,
                namespaceId: snapshot.namespaceId,
                snapshot,
            });
            if (!created) return false;
            const workspace = this.workspaceResolver ? this.workspaceResolver(snapshot.namespaceId) : null;
            if (!workspace) {
                this.logger?.warn?.('history', 'Workspace not found for node restore', { namespaceId: snapshot.namespaceId });
            }
            if (workspace) {
                this.nodeRenderer.render(created, workspace);
            }
            this.refreshOutput?.(created.id);
        }
        connections.forEach((conn) => this.#restoreConnection(conn));
        return true;
    }

    #removeNode(nodeId) {
        if (!nodeId || !this.nodePlatform?.removeNode) return false;
        const snapshot = this.nodePlatform.getNodeSnapshot?.(nodeId);
        const removed = this.nodePlatform.removeNode(nodeId, { reason: 'history' });
        if (removed && this.nodeRenderer?.remove) {
            this.nodeRenderer.remove(nodeId);
        }
        if (removed && snapshot) {
            this.refreshOutput?.(nodeId, { forceDownstream: false });
        }
        return Boolean(removed);
    }

    #handleNodeCreated({ snapshot, connections = [] } = {}) {
        if (!snapshot) return;
        this.#push({
            type: 'node:create',
            snapshot,
            connections,
        });
    }

    #handleNodeRemoved({ snapshot, connections = [] } = {}) {
        if (!snapshot) return;
        this.#push({
            type: 'node:remove',
            snapshot,
            connections,
        });
    }

    #handleSnapshotUpdated({ snapshot, previousSnapshot, reason } = {}) {
        if (!snapshot || !previousSnapshot) return;
        // Ignore hydration/import noise
        const reasonText = String(reason || '').toLowerCase();
        if (reasonText.includes('hydrate') || reasonText.includes('import')) return;

        const prevName = previousSnapshot?.config?.displayName
            ?? previousSnapshot?.state?.displayName
            ?? previousSnapshot?.metadata?.title
            ?? '';
        const nextName = snapshot?.config?.displayName
            ?? snapshot?.state?.displayName
            ?? snapshot?.metadata?.title
            ?? '';

        if (prevName !== nextName) {
            this.#push({
                type: 'node:rename',
                nodeId: snapshot.nodeId || snapshot.id,
                namespaceId: snapshot.namespaceId,
                previousName: prevName,
                nextName: nextName,
            });
        }
    }

    #handleConnectionAdded(connection = {}) {
        if (!connection?.id) return;
        this.#push({ type: 'connection:add', connection });
    }

    #handleConnectionRemoved({ connection, reason } = {}) {
        if (reason === 'node-removed') return; // handled as part of node removal action
        if (!connection?.id) return;
        this.#push({ type: 'connection:remove', connection });
    }

    #handleConnectionGeometryUpdated({ id, geometry, previousGeometry } = {}) {
        if (!id || !geometry || !previousGeometry) return;
        this.#push({
            type: 'connection:geometry',
            connectionId: id,
            previousGeometry,
            nextGeometry: geometry,
        });
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
