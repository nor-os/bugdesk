/**
 * Workspace Import Controller (js_new)
 *
 * Purpose
 * -------
 * Execute the deterministic workspace import pipeline using the data manager, node platform,
 * and workspace state machine.
 *
 * Responsibilities
 * - Validate incoming payloads via Serializer + DTOs.
 * - Rehydrate registries and nodes namespace-by-namespace without DOM scraping.
 * - Coordinate state transitions (`clearing` → `complete`) and emit progress metrics.
 *
 * Source Material
 * - html/js/workspace_manager.js (import/export blocks).
 * - html/js/nodes.js (node hydration helpers) and canvas/node wiring.
 */

import { WorkspaceSerializer } from '../data/serializer.js';
import { WorkspaceStateMachine } from './workspace_state_machine.js';
import { VariableDTO } from '../data/dtos/variable.js';
import { ConnectionDTO } from '../data/dtos/connection.js';
import { TemplateRegistry } from '../results/templates/template_registry.js';

const BUS_EVENTS = Object.freeze({
    REQUESTED: 'workspace:import:requested',
    REGISTRIES_CLEARED: 'workspace:import:registries-cleared',
    REGISTRIES_LOADED: 'workspace:import:registries-loaded',
    TABS_PREPARED: 'workspace:import:tabs-prepared',
    NODES_HYDRATED: 'workspace:import:nodes-hydrated',
    CONNECTIONS_HYDRATED: 'workspace:import:connections-hydrated',
    SNAPSHOTS_COMMITTED: 'workspace:import:snapshots-committed',
    FAILED: 'workspace:import:failed',
});

const REQUIRED_PLATFORM_METHODS = ['resetWorkspace', 'hydrateFromSnapshots', 'finalizeWorkspaceImport'];

export class WorkspaceImportController {
    constructor({
        dataManager,
        stateMachine,
        nodePlatform,
        connectorRouter,
        hostBridgeRef = null,
        eventBus = null,
        logger = null,
        serializer = WorkspaceSerializer,
    } = {}) {
        if (!dataManager) {
            throw new Error('WorkspaceImportController requires a DataManager instance');
        }
        if (!(stateMachine instanceof WorkspaceStateMachine)) {
            throw new Error('WorkspaceImportController requires a WorkspaceStateMachine');
        }
        // nodePlatform and connectorRouter are optional in notebook mode
        // (only needed for canvas workspace hydration)

        this.dataManager = dataManager;
        this.stateMachine = stateMachine;
        this.nodePlatform = nodePlatform;
        this.connectorRouter = connectorRouter;
        this.hostBridgeRef = hostBridgeRef;
        this.eventBus = eventBus;
        this.logger = logger;
        this.serializer = serializer;
        this.lastResult = null;
    }

    async importFromJSON(json, options = {}) {
        const snapshot = this.serializer.importFromJSON(json);
        return this.#runImport(snapshot, options);
    }

    async importFromPayload(payload, options = {}) {
        const snapshot = this.serializer.deserializeWorkspace(payload);
        return this.#runImport(snapshot, options);
    }

    getLastResult() {
        return this.lastResult ? { ...this.lastResult } : null;
    }

    async #runImport(snapshot, options) {
        const meta = this.#buildImportMeta(snapshot, options);
        this.#emitBus(BUS_EVENTS.REQUESTED, meta);
        const connectionCount = Array.isArray(snapshot.connections) ? snapshot.connections.length : 0;

        try {
            await this.stateMachine.startImport(meta);
            await this.#clearWorkspace();
            await this.stateMachine.registriesCleared();

            this.#reconcileModuleInputs(snapshot);

            await this.#loadRegistries(snapshot);
            await this.stateMachine.registriesLoaded({
                stockCount: snapshot.stocks.length,
                variableCount: snapshot.variables.length,
            });

            await this.#prepareTabs(snapshot);
            await this.stateMachine.tabsImported({ tabCount: snapshot.namespaces.length });

            await this.#hydrateNodes(snapshot);
            await this.stateMachine.nodesDeserialized({ nodeCount: snapshot.nodes.length });

            await this.#hydrateConnections(snapshot);

            await this.#commitSnapshots(snapshot);
            await this.stateMachine.snapshotsUpdated();

            const defaultScenarioId = await this.#hydrateScenarios(snapshot);

            await this.stateMachine.finalize();

            const result = {
                version: snapshot.version,
                tabCount: snapshot.namespaces.length,
                stockCount: snapshot.stocks.length,
                variableCount: snapshot.variables.length,
                flowCount: snapshot.flows.length,
                nodeCount: snapshot.nodes.length,
                connectionCount,
                defaultScenarioId,
                metadata: { ...snapshot.metadata },
            };
            this.lastResult = result;
            return result;
        } catch (error) {
            await this.stateMachine.abort('import-error', error);
            this.#emitBus(BUS_EVENTS.FAILED, { error, meta });
            this.logger?.error?.('workspace-import', 'Workspace import failed', { error });
            throw error;
        }
    }

    async #clearWorkspace() {
        this.dataManager.reset();
        TemplateRegistry.deregisterWorkspaceTemplates();
        await Promise.resolve(this.nodePlatform?.resetWorkspace?.());
        this.#emitBus(BUS_EVENTS.REGISTRIES_CLEARED, {});
    }

    async #loadRegistries(snapshot) {
        this.dataManager.loadWorkspaceSnapshot(snapshot);
        const connectionCount = Array.isArray(snapshot.connections) ? snapshot.connections.length : 0;
        this.#emitBus(BUS_EVENTS.REGISTRIES_LOADED, {
            namespaces: snapshot.namespaces.map((ns) => ({ id: ns.id, displayName: ns.displayName, tabIndex: ns.tabIndex })),
            stockCount: snapshot.stocks.length,
            variableCount: snapshot.variables.length,
            flowCount: snapshot.flows.length,
            connectionCount,
        });

        // Sync modules to moduleRegistry so linter/DSL generator see them
        if (snapshot.modules?.length) {
            this.eventBus?.emit?.('modules:registry:changed');
        }
    }

    async #prepareTabs(snapshot) {
        this.#emitBus(BUS_EVENTS.TABS_PREPARED, {
            namespaces: snapshot.namespaces.map((ns) => ({
                id: ns.id,
                displayName: ns.displayName,
                color: ns.color,
                tabIndex: ns.tabIndex,
                isLocked: ns.isLocked,
                isArchived: ns.isArchived,
            })),
        });
    }

    async #hydrateNodes(snapshot) {
        await Promise.resolve(this.nodePlatform?.hydrateFromSnapshots?.(snapshot.nodes, {
            namespaces: snapshot.namespaces,
            variables: snapshot.variables,
            flows: snapshot.flows,
            stocks: snapshot.stocks,
            metadata: snapshot.metadata,
        }));

        this.#emitBus(BUS_EVENTS.NODES_HYDRATED, { nodeCount: snapshot.nodes.length });
    }

    async #hydrateConnections(snapshot) {
        const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];

        await Promise.resolve(this.connectorRouter?.hydrateConnections?.(connections, {
            namespaceId: null,
        }));

        this.#emitBus(BUS_EVENTS.CONNECTIONS_HYDRATED, { connectionCount: connections.length });
    }

    async #commitSnapshots(snapshot) {
        await Promise.resolve(this.nodePlatform?.finalizeWorkspaceImport?.({
            metadata: snapshot.metadata,
            summary: {
                tabCount: snapshot.namespaces.length,
                nodeCount: snapshot.nodes.length,
            },
        }));
        this.#emitBus(BUS_EVENTS.SNAPSHOTS_COMMITTED, { updatedAt: snapshot.updatedAt });
    }

    async #hydrateScenarios(snapshot) {
        const presets = Array.isArray(snapshot.scenarioPresets) ? snapshot.scenarioPresets : [];
        if (presets.length === 0) return null;

        const bridge = this.hostBridgeRef?.current;
        if (!bridge || typeof bridge.sim_create_scenario !== 'function') {
            this.logger?.warn?.('workspace-import',
                `Skipping ${presets.length} scenario presets — no host bridge available`);
            return null;
        }

        let created = 0;
        let skipped = 0;
        let defaultScenarioId = null;
        for (const preset of presets) {
            try {
                const result = await bridge.sim_create_scenario({
                    name: preset.name,
                    type: preset.type ?? 'static',
                    config: preset.config ?? {},
                    workspaceId: this.dataManager?.workspaceId,
                });
                if (result?.skipped) {
                    skipped++;
                    if (preset.isDefault) {
                        defaultScenarioId = result.scenario?.id;
                    }
                } else if (result?.ok) {
                    created++;
                    if (preset.isDefault) {
                        defaultScenarioId = result.scenario?.id;
                    }
                } else {
                    this.logger?.warn?.('workspace-import',
                        `Failed to create scenario preset "${preset.name}": ${result?.error}`);
                }
            } catch (err) {
                this.logger?.warn?.('workspace-import',
                    `Error creating scenario preset "${preset.name}"`, { error: err });
            }
        }

        this.logger?.info?.('workspace-import',
            `Scenario presets: ${created} created, ${skipped} skipped (already exist)`);
        this.#emitBus('workspace:import:scenarios-hydrated', { created, skipped, total: presets.length });
        return defaultScenarioId;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Module Input Reconciliation
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Scan reference-mode module instance nodes for unwired argumentExpressions.
     * Auto-generate constant nodes for literal values and auto-wire variable references.
     * Mutates the snapshot in-place (adds nodes, variables, connections).
     */
    #reconcileModuleInputs(snapshot) {
        // Index: "targetNodeId:connectorId" → true
        const wiredTargets = new Set();
        for (const conn of snapshot.connections) {
            const tgt = conn.target;
            if (tgt?.nodeId && tgt?.connectorId) {
                wiredTargets.add(`${tgt.nodeId}:${tgt.connectorId}`);
            }
        }

        // Variable lookup: "namespaceId:key" → variable DTO
        const varByNsKey = new Map();
        for (const v of snapshot.variables) {
            varByNsKey.set(`${v.namespaceId}:${v.key}`, v);
        }

        // Namespace name lookup for log messages
        const nsNameById = new Map();
        for (const ns of snapshot.namespaces) {
            nsNameById.set(ns.id, ns.displayName ?? ns.slug ?? ns.id);
        }

        const ts = Date.now();
        let generated = 0;
        let autoWired = 0;

        // Iterate a snapshot copy — we'll push new nodes during the loop
        const existingNodes = [...snapshot.nodes];

        for (const node of existingNodes) {
            const config = node.config ?? {};
            if (node.type !== 'function' || config.mode !== 'reference') continue;

            const argExprs = config.argumentExpressions;
            if (!argExprs || typeof argExprs !== 'object') continue;

            const nodeName = config.variableKey ?? node.id;
            const nsName = nsNameById.get(node.namespaceId) ?? '';

            // Determine port ordering for position offsets
            const inputPorts = (node.connectors ?? [])
                .filter(c => c.role === 'input' || c.direction === 'in')
                .sort((a, b) => (a.portIndex ?? 0) - (b.portIndex ?? 0));

            for (const [paramName, exprValue] of Object.entries(argExprs)) {
                const connectorId = `in-${paramName}`;

                // Skip if already wired via a connection
                if (wiredTargets.has(`${node.id}:${connectorId}`)) continue;

                const trimmed = (typeof exprValue === 'string' ? exprValue : String(exprValue)).trim();
                if (!trimmed) continue;

                if (this.#isNumericLiteral(trimmed)) {
                    // ── Auto-generate constant node for literal value ──
                    const numValue = Number(trimmed);
                    const constNodeId = crypto.randomUUID();
                    const constVarId = crypto.randomUUID();

                    // Position: to the left of module instance, stacked by port index
                    const portIdx = inputPorts.findIndex(p => p.id === connectorId);
                    const pos = {
                        x: (node.position?.x ?? 200) - 250,
                        y: (node.position?.y ?? 100) + (portIdx >= 0 ? portIdx * 80 : generated * 80),
                    };

                    snapshot.nodes.push(Object.freeze({
                        id: constNodeId,
                        type: 'constant',
                        namespaceId: node.namespaceId,
                        config: { variableKey: paramName, displayName: paramName, value: numValue },
                        state: { variableId: constVarId },
                        metadata: { autoGenerated: true },
                        position: pos,
                        connectors: [{ id: 'out', role: 'output', side: 'right', label: 'Value' }],
                        createdAt: ts,
                        updatedAt: ts,
                    }));

                    snapshot.variables.push(VariableDTO.fromJSON({
                        id: constVarId,
                        namespaceId: node.namespaceId,
                        nodeId: constNodeId,
                        key: paramName,
                        displayName: paramName,
                        valueType: 'parameter',
                        dataType: 'scalar',
                        defaultValue: numValue,
                        metadata: { nodeType: 'constant', autoGenerated: true },
                    }));

                    snapshot.connections.push(ConnectionDTO.fromJSON({
                        id: crypto.randomUUID(),
                        namespaceId: node.namespaceId,
                        source: { nodeId: constNodeId, connectorId: 'out' },
                        target: { nodeId: node.id, connectorId },
                        createdAt: ts,
                        updatedAt: ts,
                    }));

                    wiredTargets.add(`${node.id}:${connectorId}`);
                    generated++;

                    this.logger?.warn?.('workspace-import',
                        `[Reconcile] Auto-generated constant '${paramName}' (value=${numValue}) for ${nsName}/${nodeName}.${connectorId}`);

                } else if (!trimmed.includes('.')) {
                    // ── Variable reference (same namespace) — auto-wire ──
                    // Skip cross-namespace refs (contain dot) and module output refs
                    const srcVar = varByNsKey.get(`${node.namespaceId}:${trimmed}`);
                    if (srcVar?.nodeId) {
                        const srcNode = existingNodes.find(n => n.id === srcVar.nodeId);
                        const srcConnectorId = this.#resolveOutputConnector(srcNode);

                        snapshot.connections.push(ConnectionDTO.fromJSON({
                            id: crypto.randomUUID(),
                            namespaceId: node.namespaceId,
                            source: { nodeId: srcVar.nodeId, connectorId: srcConnectorId },
                            target: { nodeId: node.id, connectorId },
                            createdAt: ts,
                            updatedAt: ts,
                        }));

                        wiredTargets.add(`${node.id}:${connectorId}`);
                        autoWired++;

                        this.logger?.warn?.('workspace-import',
                            `[Reconcile] Auto-wired '${trimmed}' → ${nsName}/${nodeName}.${connectorId}`);
                    }
                }
            }
        }

        if (generated > 0 || autoWired > 0) {
            this.logger?.info?.('workspace-import',
                `[Reconcile] Generated ${generated} constant nodes, auto-wired ${autoWired} connections`);
        }

        return { generated, autoWired };
    }

    /**
     * Find the primary output connector ID for a node.
     */
    #resolveOutputConnector(node) {
        if (!node) return 'out';
        const outputs = (node.connectors ?? []).filter(c =>
            c.role === 'output' || c.direction === 'out' || c.direction === 'output',
        );
        return outputs[0]?.id ?? 'out';
    }

    /**
     * Check if a string represents a numeric literal (integer, float, or scientific notation).
     */
    #isNumericLiteral(value) {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (trimmed === '') return false;
        const num = Number(trimmed);
        return !isNaN(num) && isFinite(num);
    }

    // ─────────────────────────────────────────────────────────────────────────────

    #buildImportMeta(snapshot, options) {
        return {
            source: options.source ?? 'manual',
            workspaceId: options.workspaceId ?? snapshot.metadata?.workspaceId ?? null,
            checksum: options.checksum ?? null,
            version: snapshot.version,
        };
    }

    #emitBus(eventName, payload) {
        if (!this.eventBus || !eventName) {
            return;
        }
        try {
            this.eventBus.emit(eventName, payload);
        } catch (err) {
            this.logger?.warn?.('workspace-import', 'Failed to emit workspace import event', {
                eventName,
                error: err,
            });
        }
    }
}

WorkspaceImportController.BUS_EVENTS = BUS_EVENTS;
