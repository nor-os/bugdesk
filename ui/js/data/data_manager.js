/**
 * Data Manager Singleton (js_new)
 *
 * Purpose
 * -------
 * Authoritative gateway for namespace, stock, and variable registries plus persistence APIs.
 *
 * Responsibilities
 * - Own all registry instances and expose namespace-scoped CRUD operations.
 * - Coordinate serialization/deserialization via the co-located serializer module.
 * - Provide query APIs consumed by nodes, UI, and simulation without exposing internal maps.
 * - Emit registry change events and enforce single-path behaviors (no fallbacks).
 *
 * Source Material
 * - html/js/workspace_manager.js (persistence + registry hydration, minus DOM scraping).
 * - html/js/variable_registry.js & variable_manifest.js (variable + flow param logic).
 * - html/js/flow_store.js, namespace_directory.js, stock registry helpers inside nodes/Godley components.
 *
 */

import { WorkspaceSerializer } from './serializer.js';
import { NamespaceDTO } from './dtos/namespace.js';
import { StockDTO } from './dtos/stock.js';
import { VariableDTO } from './dtos/variable.js';
import { ConnectionDTO } from './dtos/connection.js';
import { ModuleDTO } from './dtos/module.js';
import { CaptionDTO } from './dtos/caption.js';
import { GroupDTO } from './dtos/group.js';
import { EtlPipelineDTO } from './dtos/etl_pipeline.js';
import { ModelTestDTO } from './dtos/model_test.js';

const EVENTS = Object.freeze({
    NAMESPACE_ADDED: 'data:namespaces:added',
    NAMESPACE_REMOVED: 'data:namespaces:removed',
    STOCK_UPDATED: 'data:stocks:updated',
    STOCK_RENAMED: 'data:stocks:renamed',
    SECTORS_UPDATED: 'data:sectors:updated',
    SECTOR_RENAMED: 'data:sectors:renamed',
    SECTOR_DELETED: 'data:sectors:deleted',
    VARIABLE_UPDATED: 'data:variables:updated',
    VARIABLE_RENAMED: 'data:variables:renamed',
    CAPTION_UPDATED: 'data:captions:updated',
    GROUP_UPDATED: 'data:groups:updated',
    ETL_PIPELINE_UPDATED: 'data:etlPipelines:updated',
    MODEL_TEST_UPDATED: 'data:modelTests:updated',
    HYDRATED: 'data:hydrated',
    DSL_TEXT_UPDATED: 'data:dsl:updated',
    REGISTRY_DIAGNOSTIC: 'registry:diagnostic',
});

const REGISTRY_KINDS = Object.freeze(['namespaces', 'sectors', 'stocks', 'variables', 'nodes', 'connections', 'modules', 'etlPipelines', 'modelTests']);

export class DataManager {
    /** @type {Map<string, string>} Stored DSL text per namespace (survives editor close/reopen) */
    #dslTexts = new Map();

    constructor({ eventBus, logger } = {}) {
        this.eventBus = eventBus;
        this.logger = logger;
        this.serializer = WorkspaceSerializer;

        this.namespaces = new Map();
        this.sectors = new Map();
        this.stocks = new Map();
        this.variables = new Map();
        this.nodes = new Map();
        this.connections = new Map();
        this.modules = new Map();
        this.captions = new Map();
        this.groups = new Map();
        this.etlPipelines = new Map();
        this.modelTests = new Map();
        this.scenarioPresets = [];
        this.calibrationConfigs = [];
        this.workspaceId = crypto.randomUUID();
        this.metadata = {};
        this.createdAt = Date.now();
        this.updatedAt = Date.now();
        this.registryMetrics = this.#createRegistryMetrics();
    }

    reset() {
        this.#reset();
        this.workspaceId = crypto.randomUUID();
        this.metadata = {};
        this.createdAt = Date.now();
        this.updatedAt = Date.now();
        this.#resetRegistryMetrics();
    }

    getNamespace(id) {
        return this.namespaces.get(id) ?? null;
    }

    listNamespaces() {
        return [...this.namespaces.values()];
    }

    upsertNamespace(payload) {
        const dto = payload instanceof NamespaceDTO ? payload : new NamespaceDTO(payload);
        this.namespaces.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.NAMESPACE_ADDED, dto);
        this.#recordRegistryMutation('namespaces', 'upsert', { id: dto.id });
        return dto;
    }

    removeNamespace(id) {
        const existed = this.namespaces.delete(id);
        if (existed) {
            this.#cascadeDeleteNamespaceData(id);
            this.updatedAt = Date.now();
            this.#emit(EVENTS.NAMESPACE_REMOVED, { id });
            this.#recordRegistryMutation('namespaces', 'remove', { id });
        }
        return existed;
    }

    // ─── DSL Text Store ──────────────────────────────────────────────

    /**
     * Store raw DSL text for a namespace.
     * Emits a lightweight event (no validation cascade).
     */
    setDslText(namespaceId, text) {
        if (!namespaceId || typeof text !== 'string') return;
        this.#dslTexts.set(namespaceId, text);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.DSL_TEXT_UPDATED, { namespaceId });
    }

    /** Get stored DSL text for a namespace, or null if none stored. */
    getDslText(namespaceId) {
        return this.#dslTexts.get(namespaceId) ?? null;
    }

    /** Clear stored DSL text for a namespace (e.g., canvas changed since last save). */
    clearDslText(namespaceId) {
        this.#dslTexts.delete(namespaceId);
    }

    // ──────────────────────────────────────────────────────────────────

    /**
     * Cascade-delete all registry data scoped to a namespace.
     * Called before the namespace-removed event so the save captures a clean state.
     * Items already removed by external cleanup (node platform, bootstrap) are harmless no-ops.
     */
    #cascadeDeleteNamespaceData(namespaceId) {
        for (const [id, stock] of this.stocks.entries()) {
            if (stock?.namespaceId === namespaceId) {
                this.stocks.delete(id);
                this.#recordRegistryMutation('stocks', 'remove', { id, namespaceId });
            }
        }
        for (const [id, variable] of this.variables.entries()) {
            if (variable?.namespaceId === namespaceId) {
                this.variables.delete(id);
                this.#recordRegistryMutation('variables', 'remove', { id, namespaceId });
            }
        }
        for (const [id, node] of this.nodes.entries()) {
            if (node?.namespaceId === namespaceId) {
                this.nodes.delete(id);
                this.#recordRegistryMutation('nodes', 'remove', { id, namespaceId });
            }
        }
        for (const [id, conn] of this.connections.entries()) {
            if (conn?.namespaceId === namespaceId) {
                this.connections.delete(id);
                this.#recordRegistryMutation('connections', 'remove', { id, namespaceId });
            }
        }
        for (const [id, caption] of this.captions.entries()) {
            if (caption?.namespaceId === namespaceId) {
                this.captions.delete(id);
                this.#recordRegistryMutation('captions', 'remove', { id, namespaceId });
            }
        }
        for (const [id, group] of this.groups.entries()) {
            if (group?.namespaceId === namespaceId) {
                this.groups.delete(id);
                this.#recordRegistryMutation('groups', 'remove', { id, namespaceId });
            }
        }
        this.sectors.delete(namespaceId);
        this.#dslTexts.delete(namespaceId);
    }

    upsertStock(payload) {
        const dto = payload instanceof StockDTO ? payload : new StockDTO(payload);
        const existing = this.stocks.get(dto.id);
        
        // Detect renames
        if (existing) {
            const changes = {};
            if (existing.accountName !== dto.accountName) {
                changes.oldAccountName = existing.accountName;
                changes.newAccountName = dto.accountName;
            }
            if (existing.sectorId !== dto.sectorId) {
                changes.oldSector = existing.sectorId;
                changes.newSector = dto.sectorId;
            }
            if (existing.accountType !== dto.accountType) {
                changes.oldAccountType = existing.accountType;
                changes.newAccountType = dto.accountType;
            }
            
            if (Object.keys(changes).length > 0) {
                this.#emit(EVENTS.STOCK_RENAMED, {
                    stockId: dto.id,
                    namespaceId: dto.namespaceId,
                    changes,
                });
            }
        }
        
        this.stocks.set(dto.id, dto);
        this.#addSectorToIndex(dto.namespaceId, dto.sectorId || dto.sector, { emit: true });
        this.updatedAt = Date.now();
        this.#emit(EVENTS.STOCK_UPDATED, dto);
        this.#recordRegistryMutation('stocks', 'upsert', { id: dto.id, namespaceId: dto.namespaceId });
        return dto;
    }

    getStock(id) {
        return this.stocks.get(id) ?? null;
    }

    /**
     * Resolve a plot series reference to its canonical simulation result keys.
     *
     * Returns the exact strings the backend uses in streaming data and result headers:
     *   streamingKey:  "Getting_Started.Firms::Assets[Deposits]"
     *   resultHeader:  "stock:Getting_Started.Firms::Assets[Deposits]"
     *
     * @param {{ refType: string, stockId?: string, key?: string, namespaceId?: string }} ref
     * @param {string} [fallbackNamespaceId] - Namespace to use if ref has none (e.g. the plot node's own namespace)
     * @returns {{ streamingKey: string, resultHeader: string }|null}
     */
    resolveHeaderKey(ref, fallbackNamespaceId = null) {
        if (!ref) return null;

        if (ref.refType === 'stock' && ref.stockId) {
            return this.#resolveStockHeaderKey(ref.stockId);
        }
        if (ref.refType === 'variable' && ref.key) {
            const nsId = ref.namespaceId || fallbackNamespaceId;
            return this.#resolveVariableHeaderKey(ref.key, nsId);
        }
        return null;
    }

    #resolveStockHeaderKey(stockId) {
        // UUID lookup
        let stock = this.stocks.get(stockId);

        // Non-UUID: stockId is already a stock path like "Firms::Assets[Deposits]"
        if (!stock && stockId.includes('::') && stockId.includes('[')) {
            for (const s of this.stocks.values()) {
                if (`${s.sectorId}::${s.accountType}[${s.accountName}]` === stockId) {
                    stock = s;
                    break;
                }
            }
        }
        if (!stock) return null;

        const nsName = this.#canonicalizeNamespaceName(stock.namespaceId);
        if (!nsName) return null;

        const stockPath = `${stock.sectorId}::${stock.accountType}[${stock.accountName}]`;
        const streamingKey = `${nsName}.${stockPath}`;
        return { streamingKey, resultHeader: `stock:${streamingKey}` };
    }

    #resolveVariableHeaderKey(key, namespaceId) {
        if (!key || !namespaceId) return null;
        const nsName = this.#canonicalizeNamespaceName(namespaceId);
        if (!nsName) return null;

        const streamingKey = `${nsName}.${key}`;
        return { streamingKey, resultHeader: `indicator:${streamingKey}` };
    }

    /** Canonicalize namespace name — must match dsl_generator.js #canonicalizeNamespaceName. */
    #canonicalizeNamespaceName(namespaceId) {
        const ns = this.namespaces.get(namespaceId);
        if (!ns) return null;
        const raw = ns.displayName || ns.slug || null;
        if (!raw) return null;
        return raw.trim().replace(/\s+/g, '_');
    }

    removeStock(id) {
        const existed = this.stocks.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#emit(EVENTS.STOCK_UPDATED, { id, removed: true });
            this.#recordRegistryMutation('stocks', 'remove', { id });
            this.#pruneSectorsForStockRemoval();
        }
        return existed;
    }

    upsertVariable(payload) {
        // All variable creation funnels through the central key requestor to keep dedup logic in one place.
        let normalizedPayload = payload;
        try {
            const enforced = this.requestVariableKey(payload?.namespaceId, payload?.key, {
                nodeId: payload?.nodeId,
                variableId: payload?.id,
                kind: payload?.valueType,
            });
            if (enforced?.key) {
                normalizedPayload = { ...payload, key: enforced.key };
            }
        } catch (err) {
            this.logger?.warn?.('data-manager', 'Failed to enforce variable key uniqueness', { error: err });
        }

        // Check if this is an update to an existing variable (rename detection)
        const existing = payload?.id ? this.variables.get(payload.id) : null;
        const oldKey = existing?.key;
        const newKey = normalizedPayload?.key;

        const dto = normalizedPayload instanceof VariableDTO ? normalizedPayload : new VariableDTO(normalizedPayload);
        this.variables.set(dto.id, dto);
        this.updatedAt = Date.now();

        // Emit rename event if key changed (for cascading updates to expressions/references)
        if (existing && oldKey && newKey && oldKey !== newKey) {
            const renamePayload = {
                variableId: dto.id,
                namespaceId: dto.namespaceId,
                oldKey,
                newKey,
                nodeId: dto.nodeId,
            };
            this.#emit(EVENTS.VARIABLE_RENAMED, renamePayload);
            this.#recordRegistryMutation('variables', 'rename', { id: dto.id, namespaceId: dto.namespaceId, oldKey, newKey });
        }

        this.#emit(EVENTS.VARIABLE_UPDATED, dto);
        this.#recordRegistryMutation('variables', 'upsert', { id: dto.id, namespaceId: dto.namespaceId });
        return dto;
    }

    renameVariable({ id, namespaceId, newKey, nodeId = null }) {
        if (!id) {
            throw new Error('renameVariable requires id');
        }
        const existing = this.variables.get(id);
        if (!existing) {
            throw new Error('Variable not found');
        }
        if (namespaceId && existing.namespaceId !== namespaceId) {
            throw new Error('Namespace mismatch for variable rename');
        }

        const enforced = this.requestVariableKey(existing.namespaceId, newKey, {
            nodeId: nodeId || existing.nodeId,
            variableId: id,
            kind: existing.valueType,
        });
        const finalKey = enforced.key || newKey;
        const changed = finalKey !== existing.key;
        if (!changed) {
            return { key: existing.key, changed: false, oldKey: existing.key };
        }

        const dto = existing instanceof VariableDTO ? existing.withChanges({ key: finalKey }) : new VariableDTO({ ...existing, key: finalKey });
        this.variables.set(dto.id, dto);
        this.updatedAt = Date.now();
        const payload = { variableId: dto.id, namespaceId: dto.namespaceId, oldKey: existing.key, newKey: finalKey, nodeId: dto.nodeId };
        this.#emit(EVENTS.VARIABLE_RENAMED, payload);
        this.#recordRegistryMutation('variables', 'rename', { id: dto.id, namespaceId: dto.namespaceId });
        return { key: finalKey, changed: true, oldKey: existing.key };
    }

    removeVariable(id) {
        const existed = this.variables.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#recordRegistryMutation('variables', 'remove', { id });
        }
        return existed;
    }

    removeVariablesForNode(nodeId) {
        if (!nodeId) return 0;
        let removed = 0;
        for (const [id, variable] of this.variables.entries()) {
            if (variable?.nodeId === nodeId) {
                this.variables.delete(id);
                removed += 1;
                this.#recordRegistryMutation('variables', 'remove', { id, nodeId });
            }
        }
        if (removed > 0) {
            this.updatedAt = Date.now();
        }
        return removed;
    }

    removeStocksForNode(nodeId) {
        if (!nodeId) return 0;
        let removed = 0;
        let updated = 0;
        for (const [id, stock] of this.stocks.entries()) {
            const refs = Array.isArray(stock?.references) ? stock.references.filter((ref) => ref !== nodeId) : [];
            const hadRef = refs.length !== (stock?.references?.length ?? 0);
            if (!hadRef) {
                continue;
            }
            if (refs.length === 0) {
                this.stocks.delete(id);
                removed += 1;
                this.#recordRegistryMutation('stocks', 'remove', { id, nodeId });
                continue;
            }
            try {
                const dto = stock instanceof StockDTO
                    ? stock.withChanges({ references: refs, hardLinkCount: Math.max(refs.length, 1) })
                    : new StockDTO({ ...stock, references: refs, hardLinkCount: Math.max(refs.length, 1) });
                this.stocks.set(id, dto);
                updated += 1;
                this.#recordRegistryMutation('stocks', 'upsert', { id, nodeId, hardLinkCount: dto.hardLinkCount });
            } catch (error) {
                this.logger?.warn?.('data-manager', 'Failed to update stock references during node removal', { id, nodeId, error });
            }
        }
        if (removed > 0 || updated > 0) {
            this.updatedAt = Date.now();
            this.#pruneSectorsForStockRemoval();
        }
        return removed + updated;
    }

    registerConnectionSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            throw new TypeError('Connection snapshot must be an object');
        }
        if (!snapshot.id) {
            throw new Error('Connection snapshot missing id');
        }
        const dto = snapshot instanceof ConnectionDTO ? snapshot : new ConnectionDTO(snapshot);
        this.connections.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#recordRegistryMutation('connections', 'upsert', { id: dto.id, namespaceId: dto.namespaceId });
        return dto;
    }

    removeConnection(id) {
        const existed = this.connections.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#recordRegistryMutation('connections', 'remove', { id });
        }
        return existed;
    }

    listStocks(predicate = () => true) {
        return [...this.stocks.values()].filter(predicate);
    }

    listSectors(namespaceId) {
        if (!namespaceId) {
            return [];
        }
        const set = this.sectors.get(namespaceId);
        if (!set) {
            return [];
        }
        // Return in insertion order (Set preserves insertion order)
        return [...set];
    }

    registerSector(namespaceId, sectorName) {
        return this.#addSectorToIndex(namespaceId, sectorName, { emit: true });
    }

    renameSector(namespaceId, oldName, newName) {
        const ns = this.#normalizeNamespace(namespaceId);
        const oldNormalized = this.#normalizeSectorName(oldName);
        const newNormalized = this.#normalizeSectorName(newName);
        
        if (!ns || !oldNormalized || !newNormalized || oldNormalized === newNormalized) {
            return { success: false, reason: 'invalid-params', affectedStocks: [] };
        }
        
        const set = this.sectors.get(ns);
        if (!set || !set.has(oldNormalized)) {
            return { success: false, reason: 'sector-not-found', affectedStocks: [] };
        }
        
        // Check if target sector already exists
        if (set.has(newNormalized)) {
            return { success: false, reason: 'target-exists', affectedStocks: [] };
        }
        
        // === ATOMIC TRANSACTION START ===
        
        // 1. Update sector index (preserving insertion order)
        const newSet = new Set();
        set.forEach((sector) => {
            newSet.add(sector === oldNormalized ? newNormalized : sector);
        });
        this.sectors.set(ns, newSet);
        
        // 2. Update all stocks in this sector
        const affectedStocks = [];
        for (const [id, stock] of this.stocks.entries()) {
            if (stock.namespaceId === ns && stock.sectorId === oldNormalized) {
                const updated = stock instanceof StockDTO 
                    ? stock.withChanges({ sectorId: newNormalized })
                    : new StockDTO({ ...stock, sectorId: newNormalized });
                this.stocks.set(id, updated);
                affectedStocks.push({ id, oldSector: oldNormalized, newSector: newNormalized });
            }
        }
        
        // 3. Update metadata
        this.#syncMetadataSectors();
        this.updatedAt = Date.now();
        
        // === ATOMIC TRANSACTION END ===
        
        // 5. Emit events
        this.#emit(EVENTS.SECTOR_RENAMED, {
            namespaceId: ns,
            oldName: oldNormalized,
            newName: newNormalized,
            affectedStocks,
        });
        
        this.#emit(EVENTS.SECTORS_UPDATED, { 
            namespaceId: ns, 
            sectors: this.listSectors(ns) 
        });
        
        this.#recordRegistryMutation('sectors', 'rename', { 
            namespaceId: ns, 
            oldName: oldNormalized, 
            newName: newNormalized,
            stockCount: affectedStocks.length,
        });

        return {
            success: true,
            affectedStocks
        };
    }

    removeSector(namespaceId, sectorName, { deletedStockIds = null } = {}) {
        const ns = this.#normalizeNamespace(namespaceId);
        const sector = this.#normalizeSectorName(sectorName);
        const set = this.sectors.get(ns);
        if (!ns || !sector || !set || !set.has(sector)) {
            return false;
        }

        set.delete(sector);
        if (set.size === 0) {
            this.sectors.delete(ns);
        } else {
            this.sectors.set(ns, set);
        }
        this.#syncMetadataSectors();
        this.updatedAt = Date.now();

        // Only include actually-deleted stock IDs so stock-variable nodes
        // whose stocks survive are not invalidated by this event
        this.#emit(EVENTS.SECTOR_DELETED, {
            namespaceId: ns,
            sectorName: sector,
            affectedStocks: deletedStockIds ?? []
        });

        this.#emit(EVENTS.SECTORS_UPDATED, { namespaceId: ns, sectors: this.listSectors(ns) });
        this.#recordRegistryMutation('sectors', 'remove', { namespaceId: ns, sector });
        return true;
    }

    listVariables(predicate = () => true) {
        return [...this.variables.values()].filter(predicate);
    }

    listConnections(predicate = () => true) {
        return [...this.connections.values()].filter(predicate).map((conn) => (conn instanceof ConnectionDTO ? conn : new ConnectionDTO(conn)));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Module Registry Methods
    // ─────────────────────────────────────────────────────────────────────────────

    getModule(name) {
        return this.modules.get(name) ?? null;
    }

    listModules(predicate = () => true) {
        return [...this.modules.values()].filter(predicate);
    }

    upsertModule(payload) {
        const dto = payload instanceof ModuleDTO ? payload : ModuleDTO.fromPlain(payload);
        this.modules.set(dto.name, dto);
        this.updatedAt = Date.now();
        this.#recordRegistryMutation('modules', 'upsert', { name: dto.name });
        return dto;
    }

    removeModule(name) {
        const existed = this.modules.delete(name);
        if (existed) {
            this.updatedAt = Date.now();
            this.#recordRegistryMutation('modules', 'remove', { name });
        }
        return existed;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Captions
    // ═══════════════════════════════════════════════════════════════════

    listCaptions(predicate = () => true) {
        return [...this.captions.values()].filter(predicate);
    }

    upsertCaption(payload) {
        const dto = payload instanceof CaptionDTO ? payload : new CaptionDTO(payload);
        this.captions.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.CAPTION_UPDATED, dto);
        this.#recordRegistryMutation('captions', 'upsert', { id: dto.id });
        return dto;
    }

    removeCaption(id) {
        const existed = this.captions.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#emit(EVENTS.CAPTION_UPDATED, { id, removed: true });
            this.#recordRegistryMutation('captions', 'remove', { id });
        }
        return existed;
    }

    getCaption(id) {
        return this.captions.get(id) ?? null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Groups
    // ═══════════════════════════════════════════════════════════════════

    listGroups(predicate = () => true) {
        return [...this.groups.values()].filter(predicate);
    }

    upsertGroup(payload) {
        const dto = payload instanceof GroupDTO ? payload : new GroupDTO(payload);
        this.groups.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.GROUP_UPDATED, dto);
        this.#recordRegistryMutation('groups', 'upsert', { id: dto.id });
        return dto;
    }

    removeGroup(id) {
        const existed = this.groups.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#emit(EVENTS.GROUP_UPDATED, { id, removed: true });
            this.#recordRegistryMutation('groups', 'remove', { id });
        }
        return existed;
    }

    getGroup(id) {
        return this.groups.get(id) ?? null;
    }

    getGroupForNode(nodeId) {
        for (const group of this.groups.values()) {
            if (group.nodeIds.includes(nodeId)) {
                return group;
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ETL Pipelines
    // ═══════════════════════════════════════════════════════════════════

    getEtlPipeline(id) {
        return this.etlPipelines.get(id) ?? null;
    }

    listEtlPipelines(predicate = () => true) {
        return [...this.etlPipelines.values()].filter(predicate);
    }

    upsertEtlPipeline(payload) {
        const dto = payload instanceof EtlPipelineDTO ? payload : EtlPipelineDTO.fromJSON(payload);
        this.etlPipelines.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.ETL_PIPELINE_UPDATED, dto);
        this.#recordRegistryMutation('etlPipelines', 'upsert', { id: dto.id });
        return dto;
    }

    removeEtlPipeline(id) {
        const existed = this.etlPipelines.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#emit(EVENTS.ETL_PIPELINE_UPDATED, { id, removed: true });
            this.#recordRegistryMutation('etlPipelines', 'remove', { id });
        }
        return existed;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Model Tests
    // ═══════════════════════════════════════════════════════════════════

    getModelTest(id) {
        return this.modelTests.get(id) ?? null;
    }

    listModelTests(predicate = () => true) {
        return [...this.modelTests.values()].filter(predicate);
    }

    upsertModelTest(payload) {
        const dto = payload instanceof ModelTestDTO ? payload : ModelTestDTO.fromJSON(payload);
        this.modelTests.set(dto.id, dto);
        this.updatedAt = Date.now();
        this.#emit(EVENTS.MODEL_TEST_UPDATED, dto);
        this.#recordRegistryMutation('modelTests', 'upsert', { id: dto.id });
        return dto;
    }

    removeModelTest(id) {
        const existed = this.modelTests.delete(id);
        if (existed) {
            this.updatedAt = Date.now();
            this.#emit(EVENTS.MODEL_TEST_UPDATED, { id, removed: true });
            this.#recordRegistryMutation('modelTests', 'remove', { id });
        }
        return existed;
    }

    registerNodeSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            throw new TypeError('Node snapshot must be an object');
        }
        if (!snapshot.id) {
            throw new Error('Node snapshot missing id');
        }
        this.nodes.set(snapshot.id, { ...snapshot });
        this.updatedAt = Date.now();
        this.#recordRegistryMutation('nodes', 'upsert', { id: snapshot.id, type: snapshot.type });
    }

    getNodeSnapshot(id) {
        const snapshot = this.nodes.get(id);
        return snapshot ? { ...snapshot } : null;
    }

    loadWorkspaceSnapshot(snapshot = {}) {
        const normalized = this.#ensureSnapshotNormalized(snapshot);
        this.#reset();

        normalized.namespaces.forEach((ns) => {
            const dto = ns instanceof NamespaceDTO ? ns : NamespaceDTO.fromJSON(ns);
            this.namespaces.set(dto.id, dto);
        });
        normalized.stocks.forEach((stock) => {
            const dto = stock instanceof StockDTO ? stock : StockDTO.fromJSON(stock);
            this.stocks.set(dto.id, dto);
        });
        normalized.variables.forEach((variable) => {
            const dto = variable instanceof VariableDTO ? variable : VariableDTO.fromJSON(variable);
            this.variables.set(dto.id, dto);
        });
        normalized.nodes.forEach((node) => {
            if (!node || typeof node !== 'object' || !node.id) {
                throw new TypeError('Workspace snapshot node entries must be objects with id');
            }
            this.nodes.set(node.id, { ...node });
        });
        normalized.connections.forEach((connection) => {
            const dto = connection instanceof ConnectionDTO ? connection : ConnectionDTO.fromJSON(connection);
            this.connections.set(dto.id, dto);
        });
        (normalized.modules ?? []).forEach((mod) => {
            const dto = mod instanceof ModuleDTO ? mod : ModuleDTO.fromPlain(mod);
            this.modules.set(dto.name, dto);
        });
        (normalized.captions ?? []).forEach((caption) => {
            const dto = caption instanceof CaptionDTO ? caption : CaptionDTO.fromJSON(caption);
            this.captions.set(dto.id, dto);
        });
        (normalized.groups ?? []).forEach((group) => {
            const dto = group instanceof GroupDTO ? group : GroupDTO.fromJSON(group);
            this.groups.set(dto.id, dto);
        });

        // Hydrate stored DSL texts
        if (normalized.dslTexts && typeof normalized.dslTexts === 'object') {
            for (const [nsId, text] of Object.entries(normalized.dslTexts)) {
                if (typeof text === 'string' && text.length > 0) {
                    this.#dslTexts.set(nsId, text);
                }
            }
        }

        this.scenarioPresets = Array.isArray(normalized.scenarioPresets)
            ? normalized.scenarioPresets
            : [];
        (normalized.etlPipelines ?? []).forEach((pipeline, i) => {
            try {
                const dto = pipeline instanceof EtlPipelineDTO ? pipeline : EtlPipelineDTO.fromJSON(pipeline);
                this.etlPipelines.set(dto.id, dto);
            } catch (err) {
                console.warn(`[DataManager] Skipped etlPipelines[${i}]: ${err.message}`, pipeline);
            }
        });
        (normalized.modelTests ?? []).forEach((test, i) => {
            try {
                const dto = test instanceof ModelTestDTO ? test : ModelTestDTO.fromJSON(test);
                this.modelTests.set(dto.id, dto);
            } catch (err) {
                console.warn(`[DataManager] Skipped modelTests[${i}]: ${err.message}`, test);
            }
        });
        this.calibrationConfigs = Array.isArray(normalized.calibrationConfigs) ? normalized.calibrationConfigs : [];
        this.workspaceId = normalized.workspaceId || crypto.randomUUID();
        this.metadata = { ...(normalized.metadata ?? {}) };
        this.createdAt = normalized.createdAt ?? Date.now();
        this.updatedAt = normalized.updatedAt ?? Date.now();

        this.#rebuildSectorIndex({
            stocks: normalized.stocks,
            metadata: normalized.metadata,
        });

        this.#recordRegistryMutation('namespaces', 'hydrate', { count: this.namespaces.size });
        this.#recordRegistryMutation('stocks', 'hydrate', { count: this.stocks.size });
        this.#recordRegistryMutation('variables', 'hydrate', { count: this.variables.size });
        this.#recordRegistryMutation('nodes', 'hydrate', { count: this.nodes.size });
        this.#recordRegistryMutation('connections', 'hydrate', { count: this.connections.size });
        this.#recordRegistryMutation('sectors', 'hydrate', { count: this.sectors.size });
        this.#recordRegistryMutation('modules', 'hydrate', { count: this.modules.size });
    }

    serializeWorkspace() {
        // Drop variables whose owning node no longer exists to keep exports consistent
        this.#pruneDanglingVariables();

        // Exclude system namespaces (e.g. ETL pipeline) — they are serialized separately
        const systemNsIds = new Set(
            this.listNamespaces().filter(ns => ns.metadata?.isSystem).map(ns => ns.id)
        );
        const isUserScoped = item => !systemNsIds.has(item.namespaceId);

        return this.serializer.serializeWorkspace({
            version: WorkspaceSerializer.CURRENT_VERSION,
            workspaceId: this.workspaceId,
            namespaces: this.listNamespaces().filter(ns => !ns.metadata?.isSystem),
            stocks: this.listStocks().filter(isUserScoped),
            variables: this.listVariables().filter(isUserScoped),
            nodes: [...this.nodes.values()].filter(isUserScoped),
            connections: this.listConnections().filter(isUserScoped),
            modules: this.listModules(),
            captions: this.listCaptions().filter(isUserScoped),
            groups: this.listGroups(),
            metadata: { ...this.metadata, sectors: this.#exportSectorsMetadata() },
            dslTexts: Object.fromEntries(this.#dslTexts),
            scenarioPresets: this.scenarioPresets,
            etlPipelines: this.listEtlPipelines(),
            modelTests: this.listModelTests(),
            calibrationConfigs: this.calibrationConfigs,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        });
    }

    #pruneDanglingVariables() {
        const nodes = this.nodes;
        if (!(nodes instanceof Map) || !(this.variables instanceof Map)) {
            return;
        }
        let removed = 0;
        for (const [id, variable] of this.variables.entries()) {
            const nodeId = variable?.nodeId;
            if (!nodeId || !nodes.has(nodeId)) {
                this.variables.delete(id);
                removed += 1;
                this.#recordRegistryMutation('variables', 'remove', { id, nodeId });
            }
        }
        if (removed > 0) {
            this.updatedAt = Date.now();
            this.logger?.info?.('data-manager', `Pruned ${removed} dangling variables without nodes`);
        }
    }

    exportToJSON() {
        return this.serializer.exportToJSON(this.serializeWorkspace());
    }

    async hydrateFromPayload(payload) {
        const data = this.serializer.deserializeWorkspace(payload);
        this.loadWorkspaceSnapshot(data);

        this.#emit(EVENTS.HYDRATED, { version: data.version });
    }

    async hydrateFromJSON(json) {
        const payload = this.serializer.importFromJSON(json);
        return this.hydrateFromPayload(payload);
    }

    #reset() {
        this.namespaces.clear();
        this.sectors.clear();
        this.stocks.clear();
        this.variables.clear();
        this.nodes.clear();
        this.connections.clear();
        this.modules.clear();
        this.captions.clear();
        this.groups.clear();
        this.etlPipelines.clear();
        this.modelTests.clear();
        this.scenarioPresets = [];
        this.calibrationConfigs = [];
        this.#dslTexts.clear();
        this.#recordRegistryMutation('namespaces', 'reset');
        this.#recordRegistryMutation('sectors', 'reset');
        this.#recordRegistryMutation('stocks', 'reset');
        this.#recordRegistryMutation('variables', 'reset');
        this.#recordRegistryMutation('nodes', 'reset');
        this.#recordRegistryMutation('connections', 'reset');
        this.#recordRegistryMutation('modules', 'reset');
    }

    #ensureSnapshotNormalized(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            throw new TypeError('Workspace snapshot must be an object');
        }

        const namespaces = snapshot.namespaces ?? [];
        const stocks = snapshot.stocks ?? [];
        const variables = snapshot.variables ?? [];
        const connections = snapshot.connections ?? [];

        const arraysAlreadyDtos = (
            namespaces.every((item) => item instanceof NamespaceDTO) &&
            stocks.every((item) => item instanceof StockDTO) &&
            variables.every((item) => item instanceof VariableDTO) &&
            connections.every((item) => item instanceof ConnectionDTO)
        );

        if (arraysAlreadyDtos) {
            return snapshot;
        }

        if (snapshot.format) {
            return this.serializer.deserializeWorkspace(snapshot);
        }

        return {
            namespaces: namespaces.map((item) => (item instanceof NamespaceDTO ? item : new NamespaceDTO(item))),
            stocks: stocks.map((item) => (item instanceof StockDTO ? item : new StockDTO(item))),
            variables: variables.map((item) => (item instanceof VariableDTO ? item : new VariableDTO(item))),
            nodes: (snapshot.nodes ?? []).map((node) => ({ ...node })),
            connections: connections.map((item) => (item instanceof ConnectionDTO ? item : new ConnectionDTO(item))),
            modules: snapshot.modules ?? [],
            captions: snapshot.captions ?? [],
            groups: snapshot.groups ?? [],
            dslTexts: snapshot.dslTexts ?? {},
            scenarioPresets: snapshot.scenarioPresets ?? [],
            etlPipelines: snapshot.etlPipelines ?? [],
            modelTests: snapshot.modelTests ?? [],
            calibrationConfigs: snapshot.calibrationConfigs ?? [],
            metadata: snapshot.metadata ?? {},
            createdAt: snapshot.createdAt ?? Date.now(),
            updatedAt: snapshot.updatedAt ?? Date.now(),
            version: snapshot.version ?? WorkspaceSerializer.CURRENT_VERSION,
            format: snapshot.format ?? 'ecosim-workspace',
        };
    }

    #emit(eventName, payload) {
        if (!this.eventBus) {
            return;
        }
        try {
            this.eventBus.emit(eventName, payload);
        } catch (err) {
            this.logger?.warn?.('data-manager', 'Failed to emit data event', { eventName, error: err });
        }
    }

    getRegistryMetrics() {
        return REGISTRY_KINDS.reduce((acc, kind) => {
            const bucket = this.registryMetrics[kind];
            acc[kind] = this.#cloneMetricsBucket(bucket);
            return acc;
        }, {});
    }

    #createRegistryMetrics() {
        return REGISTRY_KINDS.reduce((acc, kind) => {
            acc[kind] = this.#createMetricsBucket(kind);
            return acc;
        }, {});
    }

    #resetRegistryMetrics() {
        this.registryMetrics = this.#createRegistryMetrics();
        this.#emit(EVENTS.REGISTRY_DIAGNOSTIC, {
            kind: 'all',
            action: 'metrics:reset',
            total: 0,
            actionCount: 0,
            detail: null,
            timestamp: Date.now(),
        });
    }

    #createMetricsBucket(kind) {
        return {
            kind,
            total: 0,
            actions: Object.create(null),
            lastAction: null,
            lastUpdatedAt: null,
        };
    }

    #cloneMetricsBucket(bucket) {
        if (!bucket) {
            return null;
        }
        return {
            kind: bucket.kind,
            total: bucket.total,
            actions: { ...bucket.actions },
            lastAction: bucket.lastAction,
            lastUpdatedAt: bucket.lastUpdatedAt,
        };
    }

    #recordRegistryMutation(kind, action, detail = null) {
        if (!REGISTRY_KINDS.includes(kind)) {
            return;
        }
        if (!this.registryMetrics[kind]) {
            this.registryMetrics[kind] = this.#createMetricsBucket(kind);
        }
        const bucket = this.registryMetrics[kind];
        const timestamp = Date.now();
        bucket.total += 1;
        bucket.lastAction = action;
        bucket.lastUpdatedAt = timestamp;
        bucket.actions[action] = (bucket.actions[action] ?? 0) + 1;

        const payload = {
            kind,
            action,
            total: bucket.total,
            actionCount: bucket.actions[action],
            detail,
            timestamp,
        };

        this.logger?.debug?.('Registry mutation', payload);
        this.#emit(EVENTS.REGISTRY_DIAGNOSTIC, payload);
    }

    #rebuildSectorIndex({ stocks = [], metadata = {} } = {}) {
        this.sectors.clear();
        const metaSectors = metadata?.sectors && typeof metadata.sectors === 'object' ? metadata.sectors : {};
        Object.entries(metaSectors).forEach(([namespaceId, sectors]) => {
            if (!Array.isArray(sectors)) return;
            sectors.forEach((sector) => this.#addSectorToIndex(namespaceId, sector, { emit: false }));
        });

        (stocks || []).forEach((stock) => {
            this.#addSectorToIndex(stock.namespaceId, stock.sectorId || stock.sector, { emit: false });
        });

        this.#syncMetadataSectors();
    }

    #addSectorToIndex(namespaceId, sectorName, { emit = false } = {}) {
        const ns = this.#normalizeNamespace(namespaceId);
        const sector = this.#normalizeSectorName(sectorName);
        if (!ns || !sector) {
            return false;
        }
        const set = this.sectors.get(ns) ?? new Set();
        const before = set.size;
        set.add(sector);
        this.sectors.set(ns, set);
        if (set.size === before) {
            return false;
        }
        if (emit) {
            this.updatedAt = Date.now();
            this.#syncMetadataSectors();
            this.#emit(EVENTS.SECTORS_UPDATED, { namespaceId: ns, sectors: this.listSectors(ns) });
            this.#recordRegistryMutation('sectors', 'upsert', { namespaceId: ns, sector });
        }
        return sector;
    }

    #pruneSectorsForStockRemoval() {
        // Only prune sectors that were derived from stocks, not explicitly registered ones.
        // Since we sync metadata after each sector registration, sectors in the current index
        // that are also in metadata.sectors are considered explicitly registered and should persist.
        // We only remove sectors that have NO stocks AND are NOT in metadata.sectors.
        this.namespaces.forEach((_, namespaceId) => {
            const stockSectors = new Set(
                this.listStocks((stock) => stock.namespaceId === namespaceId)
                    .map((stock) => this.#normalizeSectorName(stock.sectorId || stock.sector))
                    .filter(Boolean)
            );
            // Sectors explicitly in metadata are preserved
            const metaSectors = new Set(
                (this.metadata?.sectors?.[namespaceId] || [])
                    .map((name) => this.#normalizeSectorName(name))
                    .filter(Boolean)
            );
            const set = this.sectors.get(namespaceId);
            if (!set) return;
            // Only prune sectors that are NEITHER in stocks NOR in metadata
            set.forEach((sector) => {
                if (stockSectors.has(sector) || metaSectors.has(sector)) return;
                set.delete(sector);
            });
            if (set.size === 0) {
                this.sectors.delete(namespaceId);
            } else {
                this.sectors.set(namespaceId, set);
            }
        });
        this.#syncMetadataSectors();
    }

    #exportSectorsMetadata() {
        const result = {};
        this.sectors.forEach((set, namespaceId) => {
            if (!set || set.size === 0) return;
            // Preserve insertion order instead of alphabetical
            result[namespaceId] = [...set];
        });
        return result;
    }

    #syncMetadataSectors() {
        const sectors = this.#exportSectorsMetadata();
        this.metadata = { ...(this.metadata ?? {}), sectors };
    }

    #normalizeSectorName(name) {
        if (typeof name !== 'string') {
            return null;
        }
        const trimmed = name.trim();
        return trimmed ? trimmed : null;
    }

    #normalizeNamespace(namespaceId) {
        if (typeof namespaceId !== 'string') {
            return null;
        }
        const trimmed = namespaceId.trim();
        return trimmed ? trimmed : null;
    }

    /**
     * Ensure a variable key is unique within a namespace by auto-suffixing (_1, _2, ...).
     * Returns the final key and whether it was changed.
     */
    requestVariableKey(namespaceId, desiredKey, { nodeId = null, variableId = null } = {}) {
        const ns = this.#normalizeNamespace(namespaceId);
        if (!ns) {
            return { key: desiredKey || '', changed: false };
        }
        const base = (desiredKey || '').trim();
        const safeBase = base || 'var';
        let candidate = safeBase;
        let suffix = 1;

        const conflicts = () => {
            for (const variable of this.variables.values()) {
                if (!variable || variable.namespaceId !== ns) continue;
                if (variable.key !== candidate) continue;
                const sameOwner = (nodeId && variable.nodeId === nodeId) || (variableId && variable.id === variableId);
                if (!sameOwner) return true;
            }
            return false;
        };

        while (conflicts()) {
            candidate = `${safeBase}_${suffix++}`;
        }

        return { key: candidate, changed: candidate !== safeBase };
    }

    // Backward-compatible alias
    ensureUniqueVariableKey(namespaceId, desiredKey, opts) {
        return this.requestVariableKey(namespaceId, desiredKey, opts);
    }

    /**
     * Ensure a variable display name is unique within a namespace by auto-suffixing (_1, _2, ...).
     * Returns the final name and whether it was changed.
     * @param {string} namespaceId - The namespace to check uniqueness within
     * @param {string} desiredName - The desired display name
     * @param {Object} options
     * @param {string} [options.nodeId] - Node ID to exclude from conflict check (for updates)
     * @param {string} [options.variableId] - Variable ID to exclude from conflict check
     * @returns {{ name: string, changed: boolean }}
     */
    requestDisplayName(namespaceId, desiredName, { nodeId = null, variableId = null } = {}) {
        const ns = this.#normalizeNamespace(namespaceId);
        if (!ns) {
            return { name: desiredName || '', changed: false };
        }
        const base = (desiredName || '').trim();
        const safeBase = base || 'Variable';
        let candidate = safeBase;
        let suffix = 1;

        const conflicts = () => {
            for (const variable of this.variables.values()) {
                if (!variable || variable.namespaceId !== ns) continue;
                if (variable.displayName !== candidate) continue;
                const sameOwner = (nodeId && variable.nodeId === nodeId) || (variableId && variable.id === variableId);
                if (!sameOwner) return true;
            }
            // Also check stocks for display name conflicts
            for (const stock of this.stocks.values()) {
                if (!stock || stock.namespaceId !== ns) continue;
                if (stock.displayName !== candidate) continue;
                const sameOwner = nodeId && stock.nodeId === nodeId;
                if (!sameOwner) return true;
            }
            return false;
        };

        while (conflicts()) {
            candidate = `${safeBase}_${suffix++}`;
        }

        return { name: candidate, changed: candidate !== safeBase };
    }
}

DataManager.EVENTS = EVENTS;
