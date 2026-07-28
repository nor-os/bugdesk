/**
 * Workspace State Machine (js_new)
 *
 * Purpose
 * -------
 * Drive deterministic workspace import/export flows using the shared StateMachine base.
 *
 * Responsibilities
 * - Encode the canonical states (idle → clearing → loading_registries → … → complete).
 * - Emit progress events through the EventBus for UI + diagnostics.
 * - Provide guard helpers (`isImporting`, `canModify`) for other services.
 *
 * Source Material
 * - html/js/workspace_state_machine.js (current implementation needing DI + cleanup).
 */

import { StateMachine } from '../core/state_machine.js';

const STATES = Object.freeze({
    IDLE: 'idle',
    CLEARING: 'clearing',
    LOADING_REGISTRIES: 'loading_registries',
    IMPORTING_TABS: 'importing_tabs',
    DESERIALIZING_NODES: 'deserializing_nodes',
    UPDATING_SNAPSHOTS: 'updating_snapshots',
    COMPLETE: 'complete',
});

const TRANSITIONS = Object.freeze({
    START_IMPORT: 'workspace:start-import',
    CLEARING_DONE: 'workspace:clearing:done',
    REGISTRIES_READY: 'workspace:registries:ready',
    TABS_IMPORTED: 'workspace:tabs:imported',
    NODES_DESERIALIZED: 'workspace:nodes:deserialized',
    SNAPSHOTS_UPDATED: 'workspace:snapshots:updated',
    FINALIZE: 'workspace:finalize',
    ABORT: 'workspace:abort',
});

const BUS_EVENTS = Object.freeze({
    STATE_CHANGED: 'workspace:state:changed',
    PROGRESS: 'workspace:import:progress',
    IMPORT_STARTED: 'workspace:import:started',
    IMPORT_COMPLETED: 'workspace:import:completed',
    IMPORT_ABORTED: 'workspace:import:aborted',
});

const DEFAULT_STATS = Object.freeze({
    stockCount: 0,
    variableCount: 0,
    tabCount: 0,
    nodeCount: 0,
});

export class WorkspaceStateMachine extends StateMachine {
    constructor({ eventBus = null, logger = null, trace = false } = {}) {
        super({
            name: 'workspace-state-machine',
            initialState: STATES.IDLE,
            states: WorkspaceStateMachine.#buildStates(),
            eventBus,
            logger,
            trace,
        });

        this.eventBus = eventBus;
        this.logger = logger;
        this.importStats = WorkspaceStateMachine.#createStats();
        this.activeImportMeta = null;
        this.lastImportSummary = null;
        this.lastError = null;
        this.phaseStartedAt = Date.now();
    }

    static #createStats() {
        return { ...DEFAULT_STATS };
    }

    static #buildStates() {
        const abortTransition = WorkspaceStateMachine.#abortTransitionConfig();
        return {
            [STATES.IDLE]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.IDLE, context),
                transitions: {
                    [TRANSITIONS.START_IMPORT]: { target: STATES.CLEARING },
                },
            },
            [STATES.CLEARING]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.CLEARING, context),
                transitions: {
                    [TRANSITIONS.CLEARING_DONE]: { target: STATES.LOADING_REGISTRIES },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
            [STATES.LOADING_REGISTRIES]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.LOADING_REGISTRIES, context),
                transitions: {
                    [TRANSITIONS.REGISTRIES_READY]: { target: STATES.IMPORTING_TABS },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
            [STATES.IMPORTING_TABS]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.IMPORTING_TABS, context),
                transitions: {
                    [TRANSITIONS.TABS_IMPORTED]: { target: STATES.DESERIALIZING_NODES },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
            [STATES.DESERIALIZING_NODES]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.DESERIALIZING_NODES, context),
                transitions: {
                    [TRANSITIONS.NODES_DESERIALIZED]: { target: STATES.UPDATING_SNAPSHOTS },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
            [STATES.UPDATING_SNAPSHOTS]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.UPDATING_SNAPSHOTS, context),
                transitions: {
                    [TRANSITIONS.SNAPSHOTS_UPDATED]: { target: STATES.COMPLETE },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
            [STATES.COMPLETE]: {
                onEnter: (context) => context.machine.#handleStateEnter(STATES.COMPLETE, context),
                transitions: {
                    [TRANSITIONS.FINALIZE]: { target: STATES.IDLE },
                    [TRANSITIONS.START_IMPORT]: { target: STATES.CLEARING },
                    [TRANSITIONS.ABORT]: abortTransition,
                },
            },
        };
    }

    static #abortTransitionConfig() {
        return {
            target: STATES.IDLE,
            action: ({ machine, payload, fromState }) => machine.#handleAbortTransition({ ...payload, fromState }),
        };
    }

    getPhase() {
        return this.getState();
    }

    isImporting() {
        const state = this.getState();
        return state !== STATES.IDLE && state !== STATES.COMPLETE;
    }

    canModify() {
        const state = this.getState();
        return state === STATES.IDLE || state === STATES.COMPLETE;
    }

    async startImport(meta = {}) {
        if (!this.canModify()) {
            throw new Error('Cannot start workspace import while another import is running');
        }
        this.activeImportMeta = {
            source: meta.source ?? 'manual',
            workspaceId: meta.workspaceId ?? null,
            checksum: meta.checksum ?? null,
            startedAt: Date.now(),
        };
        this.importStats = WorkspaceStateMachine.#createStats();
        this.lastError = null;
        const result = await this.transition(TRANSITIONS.START_IMPORT, { meta: this.activeImportMeta });
        if (result?.transitioned) {
            this.#emitBus(BUS_EVENTS.IMPORT_STARTED, { ...this.activeImportMeta });
        } else {
            this.activeImportMeta = null;
        }
        return result;
    }

    registriesCleared() {
        return this.transition(TRANSITIONS.CLEARING_DONE);
    }

    registriesLoaded({ stockCount = 0, variableCount = 0 } = {}) {
        this.#updateStats({ stockCount, variableCount });
        this.#emitProgress('registries', { stockCount, variableCount });
        return this.transition(TRANSITIONS.REGISTRIES_READY, { stockCount, variableCount });
    }

    tabsImported({ tabCount = 0 } = {}) {
        this.#updateStats({ tabCount });
        this.#emitProgress('tabs', { tabCount });
        return this.transition(TRANSITIONS.TABS_IMPORTED, { tabCount });
    }

    nodesDeserialized({ nodeCount = 0 } = {}) {
        this.#updateStats({ nodeCount });
        this.#emitProgress('nodes', { nodeCount });
        return this.transition(TRANSITIONS.NODES_DESERIALIZED, { nodeCount });
    }

    snapshotsUpdated(additional = {}) {
        this.#emitProgress('snapshots', additional);
        return this.transition(TRANSITIONS.SNAPSHOTS_UPDATED, additional);
    }

    finalize() {
        return this.transition(TRANSITIONS.FINALIZE);
    }

    abort(reason = 'unspecified', error = null) {
        const detail = {
            reason,
            error,
        };
        return this.transition(TRANSITIONS.ABORT, detail);
    }

    #handleStateEnter(stateName, context) {
        this.phaseStartedAt = Date.now();
        this.#emitBus(BUS_EVENTS.STATE_CHANGED, {
            state: stateName,
            fromState: context.fromState ?? null,
            event: context.event,
            payload: context.payload,
            stats: { ...this.importStats },
        });

        if (stateName === STATES.COMPLETE) {
            this.#handleCompleteEnter();
        } else if (stateName === STATES.IDLE && context.fromState !== STATES.IDLE) {
            this.activeImportMeta = null;
            this.importStats = WorkspaceStateMachine.#createStats();
        }
    }

    #handleCompleteEnter() {
        const summary = {
            ...this.importStats,
            durationMs: this.activeImportMeta ? Date.now() - this.activeImportMeta.startedAt : 0,
            meta: this.activeImportMeta ? { ...this.activeImportMeta } : null,
            completedAt: Date.now(),
        };
        this.lastImportSummary = summary;
        this.#emitBus(BUS_EVENTS.IMPORT_COMPLETED, summary);
    }

    #handleAbortTransition(payload = {}) {
        this.lastError = payload.error ?? null;
        this.#emitBus(BUS_EVENTS.IMPORT_ABORTED, {
            reason: payload.reason ?? 'unspecified',
            error: payload.error ?? null,
            fromState: payload.fromState ?? this.getState(),
            stats: { ...this.importStats },
        });
        this.activeImportMeta = null;
        this.importStats = WorkspaceStateMachine.#createStats();
    }

    #updateStats(partial = {}) {
        const next = { ...this.importStats };
        Object.keys(DEFAULT_STATS).forEach((key) => {
            if (key in partial) {
                const value = Number(partial[key]);
                next[key] = Number.isFinite(value) && value >= 0 ? value : next[key];
            }
        });
        this.importStats = next;
    }

    #emitProgress(phase, detail = {}) {
        this.#emitBus(BUS_EVENTS.PROGRESS, {
            phase,
            detail,
            stats: { ...this.importStats },
            meta: this.activeImportMeta ? { ...this.activeImportMeta } : null,
        });
    }

    #emitBus(eventName, payload) {
        if (!this.eventBus) {
            return;
        }
        try {
            this.eventBus.emit(eventName, payload);
        } catch (err) {
            this.logger?.warn?.('workspace-state-machine', 'Failed to emit workspace event', {
                eventName,
                error: err,
            });
        }
    }
}

WorkspaceStateMachine.STATES = STATES;
WorkspaceStateMachine.TRANSITIONS = TRANSITIONS;
WorkspaceStateMachine.EVENTS = BUS_EVENTS;
