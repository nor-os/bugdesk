/**
 * AI Project Applier — EcoAgent.
 *
 * Takes the ordered op list emitted by the backend agent runner
 * (mutating ProjectSnapshot in `ecoagent/ai/project_snapshot.py`) and
 * replays each op against the live project through pywebview bridge
 * calls. After a batch, refresh events fire so the sidebars and tabs
 * re-fetch from the bridge.
 *
 * Operation types recorded by the snapshot:
 *
 *   sector.add / sector.update / sector.remove
 *   currency.add / currency.update / currency.remove / currency.set_domestic
 *   asset_kind.add
 *   archetype.add / archetype.update
 *   archetype.update_param
 *   archetype.set_loop
 *   market.add
 *   scenario.save
 *
 * Calls are awaited internally; the public `apply` / `applyIncremental`
 * methods are intentionally fire-and-forget (the controller treats them
 * synchronously). Errors are toasted; the apply log is appended to
 * `this.errors` for the caller to inspect.
 *
 * @module ai/ai_project_applier
 */

import { toastError } from '../ecoagent/ui/toast.js';


export class AiProjectApplier {

    /** @type {object|null} */
    #projectModel;

    /** @type {import('../core/event_bus.js').default} */
    #eventBus;

    /** @type {object} */
    #logger;

    /**
     * @param {object} deps
     * @param {object} [deps.projectModel]  Kept for interface compat.
     * @param {import('../core/event_bus.js').default} deps.eventBus
     * @param {object} [deps.logger]
     */
    constructor({ projectModel, eventBus, logger }) {
        this.#projectModel = projectModel ?? null;
        this.#eventBus = eventBus;
        this.#logger = logger || console;
    }

    /** Drop any per-batch state. No-op since the flow placeholder-id
     *  map was removed; kept for interface compat. */
    resetIdMap() {}

    /**
     * Apply an ordered list of operations to the project. Fire-and-forget;
     * errors are toasted as they happen.
     *
     * @param {Array<{type: string, params: object}>} operations
     * @returns {{ ok: boolean, applied: number, errors: string[] }}
     */
    apply(operations) {
        return this.applyIncremental(operations);
    }

    /**
     * Same as apply — both paths share the same fire-and-forget flow.
     * Operations are sent in order; each bridge call is awaited
     * internally.
     */
    applyIncremental(operations) {
        if (!operations?.length) {
            return { ok: true, applied: 0, errors: [] };
        }
        // Fire-and-forget: kick off the async chain. The caller doesn't
        // await, but ordering is preserved within this batch.
        this._runBatch(operations).catch((err) => {
            this.#logger.warn?.('[AiProjectApplier] batch failed:', err);
        });
        // Synchronous result mirrors the caller's expectations; real
        // outcomes surface via toasts and the refresh events below.
        return { ok: true, applied: operations.length, errors: [] };
    }

    async _runBatch(operations) {
        const touched = new Set();
        for (const op of operations) {
            try {
                const kind = await this._applyOne(op);
                if (kind) touched.add(kind);
            } catch (err) {
                const msg = `Operation ${op.type} failed: ${err?.message || err}`;
                this.#logger.warn?.('[AiProjectApplier]', msg);
                toastError('AI operation failed', msg);
            }
        }
        // Tell affected sidebars / tabs to re-fetch.
        this._emitRefreshFor(touched);
    }

    _emitRefreshFor(touched) {
        if (touched.has('sector')
            || touched.has('asset_kind') || touched.has('currency')) {
            this.#eventBus?.emit?.('ecoagent:project:changed', { source: 'ai' });
        }
        if (touched.has('archetype')) {
            this.#eventBus?.emit?.('ecoagent:archetypes:changed', { source: 'ai' });
        }
        if (touched.has('scenario')) {
            this.#eventBus?.emit?.('ecoagent:scenarios:changed', { source: 'ai' });
        }
        if (touched.has('market')) {
            this.#eventBus?.emit?.('ecoagent:markets:changed', { source: 'ai' });
        }
    }

    /**
     * Reverse a previously-applied operation list. Only `add` operations
     * have a clean inverse without storing before-state — `update` / `set`
     * skip with a warning.
     *
     * @param {Array<{type: string, params: object}>} operations
     */
    unapply(operations) {
        if (!operations?.length) return;
        this._runUnapply(operations).catch((err) => {
            this.#logger.warn?.('[AiProjectApplier] unapply failed:', err);
        });
    }

    async _runUnapply(operations) {
        const api = window.pywebview?.api;
        const touched = new Set();
        for (let i = operations.length - 1; i >= 0; i--) {
            const op = operations[i];
            const params = _extractParams(op);
            try {
                switch (op.type) {
                    case 'sector.add':
                        await api?.sector_remove?.(params.id);
                        touched.add('sector'); break;
                    case 'currency.add':
                        await api?.currency_remove?.({ id: params.id });
                        touched.add('currency'); break;
                    case 'archetype.add':
                        await api?.agent_unlink?.({ key: params.key, ref: 'agents' });
                        touched.add('archetype'); break;
                    case 'market.add':
                        await api?.market_remove?.(params.id);
                        touched.add('market'); break;
                    case 'scenario.save':
                        await api?.scenario_delete?.(params.id);
                        touched.add('scenario'); break;
                    // sector.update, archetype.update, archetype.set_loop,
                    // archetype.update_param — no clean inverse.
                    default:
                        // skip silently
                }
            } catch (err) {
                this.#logger.warn?.('[AiProjectApplier]',
                    `Unapply ${op.type} failed: ${err?.message || err}`);
            }
        }
        this._emitRefreshFor(touched);
    }

    /**
     * Human-readable label for an operation, shown in the chat UI's
     * operation list. Static so callers don't need an instance.
     */
    static describeOperation(op) {
        const p = _extractParams(op);
        switch (op.type) {
            case 'sector.add':       return { iconClass: 'add',    label: `Add sector "${p.id}"` };
            case 'sector.update':    return { iconClass: 'modify', label: `Update sector "${p.id}"` };
            case 'sector.remove':    return { iconClass: 'remove', label: `Remove sector "${p.id}"` };
            case 'currency.add':     return { iconClass: 'add',    label: `Add currency "${p.id}"` };
            case 'currency.update':  return { iconClass: 'modify', label: `Update currency "${p.id}"${p.new_id && p.new_id !== p.id ? ` → ${p.new_id}` : ''}` };
            case 'currency.remove':  return { iconClass: 'remove', label: `Remove currency "${p.id}"` };
            case 'currency.set_domestic':
                return { iconClass: 'modify', label: `Set "${p.id}" as domestic currency` };
            case 'asset_kind.add':   return { iconClass: 'add',    label: `Add asset kind "${p.id}"${p.currency ? ` (${p.currency})` : ''}` };
            case 'archetype.add':    return { iconClass: 'add',    label: `Add archetype "${p.key}"` };
            case 'archetype.update': return { iconClass: 'modify', label: `Update archetype "${p.key}"` };
            case 'archetype.update_param':
                return { iconClass: 'modify',
                         label: `Update ${p.key}.${p.name}${p.new_name && p.new_name !== p.name ? ` → ${p.new_name}` : ''}` };
            case 'archetype.set_loop':
                return { iconClass: 'modify', label: `Edit ${p.key}.${p.loop}` };
            case 'market.add':       return { iconClass: 'add',    label: `Add market "${p.id}" (${p.kind || 'CDA'})` };
            case 'scenario.save':    return { iconClass: 'modify', label: `Save scenario "${p.id}"` };
            default:                 return { iconClass: 'modify', label: op.type.replace(/[._]/g, ' ') };
        }
    }

    // ─── per-op dispatch ─────────────────────────────────────────────────

    async _applyOne(op) {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview bridge unavailable');
        const params = _extractParams(op);

        switch (op.type) {
            case 'sector.add': {
                const res = await api.sector_add?.(
                    params.id, params.label || params.id,
                    params.kind || 'real', params.currency ?? null,
                );
                _throwOnError(res, op.type);
                return 'sector';
            }
            case 'sector.update': {
                const res = await api.sector_update?.(
                    params.id, params.label ?? null, params.kind ?? null,
                    params.currency ?? null,
                );
                _throwOnError(res, op.type);
                return 'sector';
            }
            case 'sector.remove': {
                const res = await api.sector_remove?.(params.id);
                _throwOnError(res, op.type);
                return 'sector';
            }
            case 'asset_kind.add': {
                const res = await api.asset_add?.({
                    id: params.id,
                    description:  params.description ?? '',
                    is_financial: params.is_financial ?? true,
                    currency:     params.currency ?? null,
                });
                _throwOnError(res, op.type);
                return 'asset_kind';
            }
            case 'currency.add': {
                const res = await api.currency_add?.(
                    params.id,
                    params.label ?? params.id,
                    params.symbol ?? '',
                    !!params.is_domestic,
                    params.issuer_sector ?? null,
                );
                _throwOnError(res, op.type);
                return 'currency';
            }
            case 'currency.update': {
                const res = await api.currency_update?.(
                    params.id,
                    params.new_id ?? null,
                    params.label  ?? null,
                    params.symbol ?? null,
                    params.issuer_sector ?? null,
                );
                _throwOnError(res, op.type);
                return 'currency';
            }
            case 'currency.remove': {
                const res = await api.currency_remove?.(params.id);
                _throwOnError(res, op.type);
                return 'currency';
            }
            case 'currency.set_domestic': {
                const res = await api.currency_set_domestic?.(params.id);
                _throwOnError(res, op.type);
                return 'currency';
            }
            case 'archetype.add': {
                const res = await api.agent_add?.(
                    params.key, params.label, params.default_sector, params.population ?? 1,
                );
                _throwOnError(res, op.type);
                return 'archetype';
            }
            case 'archetype.update': {
                const res = await api.agent_update?.(
                    params.key, params.label ?? null,
                    params.default_sector ?? null, params.population ?? null,
                );
                _throwOnError(res, op.type);
                return 'archetype';
            }
            case 'archetype.update_param': {
                // Bridge's agent_param_update is positional and rich;
                // a partial-update RPC isn't there yet, so we read the
                // current param first to keep unchanged fields stable.
                const list = (await api.agents_list?.()) || [];
                const arch = list.find((a) => a.archetype === params.key);
                const cur  = (arch?.params || []).find((p) => p.name === params.name);
                const newName = params.new_name ?? cur?.name ?? params.name;
                const newType = params.type ?? cur?.type ?? 'float';
                const newDef  = params.default !== undefined ? params.default : cur?.default;
                const res = await api.agent_param_update?.(
                    params.key, params.name,
                    newName, newType, newDef,
                    null,  // description (untouched)
                    cur?.min ?? null, cur?.max ?? null,
                    cur?.choices ?? null,
                );
                _throwOnError(res, op.type);
                return 'archetype';
            }
            case 'archetype.set_loop': {
                const v = await api.agent_loop_validate?.(params.loop, params.source);
                if (v && v.ok === false) {
                    throw new Error(v.error || `Invalid ${params.loop} body`);
                }
                const res = await api.agent_loop_set?.(params.key, params.loop, params.source);
                _throwOnError(res, op.type);
                return 'archetype';
            }
            case 'market.add': {
                // Every market is an archetype with one or more instances.
                // AI ops adding a "market" land as a 1-instance archetype.
                const res = await api.market_add?.(
                    params.id,
                    params.kind || 'ContinuousDoubleAuction',
                    params.rules || {},
                    params.instances || ['default'],
                );
                _throwOnError(res, op.type);
                return 'market';
            }
            case 'scenario.save': {
                const res = await api.scenario_save?.(
                    params.id, params.label || params.id,
                    params.description || '', params.overrides || {},
                );
                _throwOnError(res, op.type);
                return 'scenario';
            }
            default:
                this.#logger.warn?.('[AiProjectApplier]', `Unknown operation type: ${op.type}`);
                return null;
        }
    }
}


// ─── helpers ────────────────────────────────────────────────────────────

/**
 * The snapshot records `params` nested under `op.params`. A few legacy
 * paths emit flat {type, ...} dicts — handle both.
 */
function _extractParams(op) {
    if (op?.params && typeof op.params === 'object' && !Array.isArray(op.params)) {
        return op.params;
    }
    return op;
}

/** Throw a meaningful error when the bridge response carries `ok:false`. */
function _throwOnError(res, opType) {
    if (res && res.ok === false) {
        throw new Error(res.error || `${opType} refused by bridge`);
    }
}
