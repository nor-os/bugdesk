/**
 * ETL Step Converter
 *
 * Converts between the step-list format (used by pipeline definitions)
 * and the node/connection graph format (used by the backend executor).
 *
 * Pipeline definitions use an ordered `steps` array:
 *   [{ id, type, config, enabled }, ...]
 *
 * The backend executor expects a DAG of nodes + connections:
 *   { nodes: [{ id, type, config, position }], connections: [{ sourceId, targetId, ... }] }
 *
 * This module also provides override application for orchestration items.
 */

// ── Steps → Graph ────────────────────────────────────────────

/**
 * Convert an ordered step list to the node/connection graph format
 * expected by the backend pipeline executor.
 *
 * Disabled steps are excluded.  Each enabled step becomes a node,
 * and adjacent nodes are connected in sequence.
 *
 * @param {Array<object>} steps  Pipeline step list
 * @returns {{ nodes: Array<object>, connections: Array<object> }}
 */
export function stepsToGraph(steps) {
    const enabled = (steps || []).filter(s => s.enabled !== false);

    const nodes = enabled.map((step, i) => ({
        id: step.id,
        type: stepTypeToNodeType(step.type),
        config: step.config || {},
        position: { x: 50 + i * 220, y: 80 },
    }));

    const connections = [];
    for (let i = 1; i < nodes.length; i++) {
        connections.push({
            id: `conn-${nodes[i - 1].id}-${nodes[i].id}`,
            sourceId: nodes[i - 1].id,
            sourcePort: 'out',
            targetId: nodes[i].id,
            targetPort: 'in',
        });
    }

    return { nodes, connections };
}

// ── Graph → Steps ────────────────────────────────────────────

/**
 * Convert a node/connection graph (old format) to an ordered step list.
 *
 * Performs topological sort on the graph to determine step order,
 * then converts each node to a step.
 *
 * @param {Array<object>} nodes       Node array from old pipeline format
 * @param {Array<object>} connections Connection array from old pipeline format
 * @returns {Array<object>}           Ordered step list
 */
export function graphToSteps(nodes, connections) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];

    const ordered = topologicalSort(nodes, connections || []);

    return ordered.map(node => ({
        id: node.id,
        type: nodeTypeToStepType(node.type),
        config: node.config || {},
        enabled: true,
    }));
}

// ── Parameter Resolution ─────────────────────────────────────

/**
 * Resolve `{{key}}` parameter references in step config values.
 *
 * Pipeline parameters declare named inputs with defaults.  Step config
 * values may contain `{{paramKey}}` tokens that are replaced with actual
 * values at execution time.
 *
 * @param {Array<object>} steps       Pipeline step list
 * @param {Array<object>} parameters  Pipeline parameter declarations
 * @param {Object<string, *>} values  Actual parameter values (key → value)
 * @returns {Array<object>}           New step list with tokens resolved
 */
export function resolveParameters(steps, parameters, values) {
    if (!parameters || parameters.length === 0) return steps;

    // Build lookup: key → resolved value (provided or default)
    const resolved = {};
    for (const param of parameters) {
        resolved[param.key] = values?.[param.key] ?? param.defaultValue ?? param.default ?? '';
    }

    return steps.map(step => {
        const config = step.config;
        if (!config) return step;

        const patchedConfig = {};
        let changed = false;
        for (const [k, v] of Object.entries(config)) {
            if (typeof v === 'string' && v.includes('{{')) {
                const replaced = v.replace(/\{\{(\w+)\}\}/g, (_, key) => {
                    if (key in resolved) return String(resolved[key]);
                    return `{{${key}}}`;
                });
                patchedConfig[k] = replaced;
                if (replaced !== v) changed = true;
            } else {
                patchedConfig[k] = v;
            }
        }

        return changed ? { ...step, config: patchedConfig } : step;
    });
}

/**
 * Find all `{{key}}` references in a pipeline's step configs.
 *
 * @param {Array<object>} steps  Pipeline step list
 * @returns {Set<string>}        Set of referenced parameter keys
 */
export function findParameterReferences(steps) {
    const refs = new Set();
    for (const step of (steps || [])) {
        for (const v of Object.values(step.config || {})) {
            if (typeof v !== 'string') continue;
            for (const match of v.matchAll(/\{\{(\w+)\}\}/g)) {
                refs.add(match[1]);
            }
        }
    }
    return refs;
}

// ── Graph Parameter Resolution ───────────────────────────────

/**
 * Resolve `{{key}}` parameter references in graph node config values.
 *
 * Same as `resolveParameters` but operates on graph nodes instead of steps.
 *
 * @param {{ nodes: Array<object>, connections: Array<object> }} graph
 * @param {Array<object>} parameters  Pipeline parameter declarations
 * @param {Object<string, *>} values  Actual parameter values (key → value)
 * @returns {{ nodes: Array<object>, connections: Array<object> }}
 */
export function resolveGraphParameters(graph, parameters, values) {
    if (!parameters || parameters.length === 0) return graph;

    const resolved = {};
    for (const param of parameters) {
        resolved[param.key] = values?.[param.key] ?? param.defaultValue ?? param.default ?? '';
    }

    const nodes = graph.nodes.map(node => {
        const config = node.config;
        if (!config) return node;

        const patchedConfig = {};
        let changed = false;
        for (const [k, v] of Object.entries(config)) {
            if (typeof v === 'string' && v.includes('{{')) {
                const replaced = v.replace(/\{\{(\w+)\}\}/g, (_, key) => {
                    if (key in resolved) return String(resolved[key]);
                    return `{{${key}}}`;
                });
                patchedConfig[k] = replaced;
                if (replaced !== v) changed = true;
            } else {
                patchedConfig[k] = v;
            }
        }

        return changed ? { ...node, config: patchedConfig } : node;
    });

    return { nodes, connections: graph.connections };
}

// ── Output Config Application ────────────────────────────────

/**
 * Apply orchestration output config to the pipeline's sink step.
 *
 * Orchestration items always allow configuring the output dataset name
 * and series name, regardless of pipeline parameters.
 *
 * @param {Array<object>} steps       Pipeline step list
 * @param {object} outputConfig       { datasetName?, seriesName? }
 * @returns {Array<object>}           New step list with sink patched
 */
export function applyOutputConfig(steps, outputConfig) {
    if (!outputConfig) return steps;

    return steps.map(step => {
        const cat = step.type?.startsWith('sink-') ? 'sink' : null;
        if (cat !== 'sink') return step;

        const patch = {};
        if (outputConfig.datasetName !== undefined) patch.datasetName = outputConfig.datasetName;
        if (outputConfig.seriesName !== undefined) patch.seriesName = outputConfig.seriesName;

        if (Object.keys(patch).length === 0) return step;
        return { ...step, config: { ...step.config, ...patch } };
    });
}

// ── Orchestration Payload ────────────────────────────────────

/**
 * Build the batch payload for `etl_run_orchestration`.
 *
 * Resolves parameters and applies output configs for each enabled item,
 * then bundles them into a single request object with shared cache settings.
 *
 * When `options.datasetName` is set (orchestration-level), it cascades to
 * every item whose `outputConfig` doesn't already override `datasetName`.
 *
 * @param {Array<object>} items          Orchestration items
 * @param {Array<object>} allPipelines   All available pipeline definitions
 * @param {object}        [options]
 * @param {number}        [options.cacheTtlDays=1]    Source data cache TTL
 * @param {boolean}       [options.forceRefresh=false] Re-fetch source data
 * @param {string}        [options.datasetName]        Orchestration-level dataset name
 * @returns {{ pipelines: Array<object>, cache_ttl_days: number, force_refresh: boolean }}
 */
export function buildOrchestrationPayload(items, allPipelines, options = {}) {
    const pipelines = [];
    const orchDatasetName = options.datasetName;

    for (const item of (items || []).filter(i => i.enabled !== false)) {
        // Look up by ID first, then fall back to name match (handles stale IDs
        // from when builtins used random UUIDs instead of deterministic ones).
        const pipeline = allPipelines.find(p => p.id === item.pipelineId)
            || (item.pipelineName && allPipelines.find(p => p.name === item.pipelineName));
        const hasSteps = Array.isArray(pipeline?.steps) && pipeline.steps.length > 0;
        const hasGraph = pipeline?.graph?.nodes?.length > 0;
        if (!pipeline) {
            console.warn(
                '[buildOrchestrationPayload] Skipping item — referenced pipeline not found',
                { pipelineId: item.pipelineId, pipelineName: item.pipelineName, itemId: item.id },
            );
            continue;
        }
        if (!hasSteps && !hasGraph) {
            console.warn(
                '[buildOrchestrationPayload] Skipping item — pipeline has no steps or graph nodes',
                { pipelineId: item.pipelineId, pipelineName: item.pipelineName, itemId: item.id },
            );
            continue;
        }

        let graph;
        if (hasGraph) {
            // New graph format — resolve parameters, then apply output config
            const resolved = resolveGraphParameters(
                { nodes: pipeline.graph.nodes, connections: pipeline.graph.connections },
                pipeline.parameters,
                item.parameterValues,
            );
            const clonedNodes = resolved.nodes.map(n => ({ ...n, config: { ...n.config } }));
            const effectiveOutput = { ...item.outputConfig };
            if (orchDatasetName && !effectiveOutput.datasetName) {
                effectiveOutput.datasetName = orchDatasetName;
            }
            if (effectiveOutput.datasetName || effectiveOutput.seriesName) {
                for (const node of clonedNodes) {
                    if (node.type?.startsWith('etl-sink')) {
                        if (effectiveOutput.datasetName !== undefined) node.config.datasetName = effectiveOutput.datasetName;
                        if (effectiveOutput.seriesName !== undefined) node.config.seriesName = effectiveOutput.seriesName;
                    }
                }
            }
            graph = { nodes: clonedNodes, connections: [...pipeline.graph.connections] };
        } else {
            let steps = resolveParameters(
                pipeline.steps,
                pipeline.parameters,
                item.parameterValues,
            );

            // Merge orchestration-level datasetName with per-item outputConfig.
            // Per-item overrides take precedence over orchestration-level.
            const effectiveOutput = { ...item.outputConfig };
            if (orchDatasetName && !effectiveOutput.datasetName) {
                effectiveOutput.datasetName = orchDatasetName;
            }
            steps = applyOutputConfig(steps, effectiveOutput);
            graph = stepsToGraph(steps);
        }

        pipelines.push({
            itemId: item.id,
            id: pipeline.id,
            name: pipeline.name,
            ...graph,
        });
    }

    return {
        pipelines,
        cache_ttl_days: options.cacheTtlDays ?? 1,
        force_refresh: options.forceRefresh ?? false,
    };
}

// ── Pipeline Migration ───────────────────────────────────────

/**
 * Ensure a pipeline object has the current format.
 *
 * Supports three source formats:
 *   1. New graph format: `pipeline.graph = { nodes, connections }`
 *   2. Step-list format: `pipeline.steps = [{ id, type, config, enabled }]`
 *   3. Old node/connection format: `pipeline.nodes` + `pipeline.connections`
 *
 * After migration the pipeline is guaranteed to have `kind` and at least
 * one of `graph` or `steps`.  When `graph` is present it is authoritative;
 * `steps` is kept as a linearized backward-compat copy.
 *
 * @param {object} pipeline  Pipeline object (may be any format)
 * @returns {object}         Same pipeline object, migrated in-place
 */
export function ensurePipelineFormat(pipeline) {
    if (!pipeline) return pipeline;

    // Orchestrations don't need migration
    if (pipeline.kind === 'orchestration') return pipeline;

    // Already has graph format — ensure kind and backward-compat steps
    if (pipeline.graph?.nodes) {
        pipeline.kind = 'pipeline';
        if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
            pipeline.steps = graphToSteps(pipeline.graph.nodes, pipeline.graph.connections || []);
        }
        if (!pipeline.parameters) pipeline.parameters = [];
        return pipeline;
    }

    // Has step-list format — generate graph from steps
    if (pipeline.kind && Array.isArray(pipeline.steps)) {
        if (pipeline.steps.length > 0) {
            pipeline.graph = stepsToGraph(pipeline.steps);
        } else {
            pipeline.graph = { nodes: [], connections: [] };
        }
        if (!pipeline.parameters) pipeline.parameters = [];
        return pipeline;
    }

    // Migrate from old node/connection format
    if (Array.isArray(pipeline.nodes)) {
        pipeline.steps = graphToSteps(pipeline.nodes, pipeline.connections || []);
        pipeline.graph = { nodes: pipeline.nodes, connections: pipeline.connections || [] };
        pipeline.kind = 'pipeline';
    } else {
        // No data — empty pipeline
        pipeline.steps = [];
        pipeline.graph = { nodes: [], connections: [] };
        pipeline.kind = 'pipeline';
    }

    if (!pipeline.parameters) pipeline.parameters = [];

    return pipeline;
}

// ── Type Mapping ─────────────────────────────────────────────

/**
 * Convert step type to node type by adding the `etl-` prefix.
 * e.g. 'source-owid' → 'etl-source-owid'
 */
export function stepTypeToNodeType(stepType) {
    if (!stepType) return stepType;
    if (stepType.startsWith('etl-')) return stepType; // already prefixed
    return `etl-${stepType}`;
}

/**
 * Convert node type to step type by removing the `etl-` prefix.
 * e.g. 'etl-source-owid' → 'source-owid'
 */
export function nodeTypeToStepType(nodeType) {
    if (!nodeType) return nodeType;
    if (nodeType.startsWith('etl-')) return nodeType.slice(4);
    return nodeType;
}

// ── Topological Sort ─────────────────────────────────────────

/**
 * Topological sort for a linear pipeline graph.
 * Finds root nodes (no incoming edges) and follows connections.
 * Unconnected nodes are appended at the end.
 *
 * @param {Array<object>} nodes
 * @param {Array<object>} connections
 * @returns {Array<object>}  Nodes in topological order
 */
function topologicalSort(nodes, connections) {
    if (connections.length === 0) return [...nodes];

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const outgoing = new Map();
    const incoming = new Set();

    for (const conn of connections) {
        outgoing.set(conn.sourceId, conn.targetId);
        incoming.add(conn.targetId);
    }

    // Find roots: nodes with no incoming connections
    const roots = nodes.filter(n => !incoming.has(n.id));
    const ordered = [];
    const visited = new Set();

    for (const root of roots) {
        let current = root.id;
        while (current && !visited.has(current)) {
            visited.add(current);
            const node = nodeMap.get(current);
            if (node) ordered.push(node);
            current = outgoing.get(current);
        }
    }

    // Append any unvisited nodes (disconnected)
    for (const node of nodes) {
        if (!visited.has(node.id)) ordered.push(node);
    }

    return ordered;
}
