/**
 * Workspace Serializer (js_new)
 *
 * Purpose
 * -------
 * Shared serialization/deserialization helpers used by the DataManager and workspace controllers.
 *
 * Responsibilities
 * - Convert in-memory DTO instances to persisted workspace payloads (tabs, registries, nodes).
 * - Rehydrate DTOs and instruct the DataManager/node platform how to rebuild state deterministically.
 * - Enforce schema/version guards so imports fail fast instead of auto-migrating at runtime.
 *
 * Source Material
 * - html/js/workspace_manager.js (export/import logic).
 * - html/js/nodes.js & node_oop_helpers.js (node snapshot + hydration routines).
 * - html/js/dsl_generator.js (namespace-qualified identifiers needed for persistence).
 *
 */

import { NamespaceDTO } from './dtos/namespace.js';
import { StockDTO } from './dtos/stock.js';
import { VariableDTO } from './dtos/variable.js';
import { ConnectionDTO } from './dtos/connection.js';
import { ModuleDTO } from './dtos/module.js';
import { CaptionDTO } from './dtos/caption.js';
import { GroupDTO } from './dtos/group.js';
import { EtlPipelineDTO } from './dtos/etl_pipeline.js';
import { ModelTestDTO } from './dtos/model_test.js';
import {
    requireNumber,
    optionalPlainObject,
    optionalArray,
    requireString,
    freeze,
} from './validators.js';

const FORMAT = 'ecosim-workspace';
const CURRENT_VERSION = 4;

export class WorkspaceSerializer {
    static get CURRENT_VERSION() {
        return CURRENT_VERSION;
    }

    static serializeWorkspace({
        version = CURRENT_VERSION,
        workspaceId = '',
        namespaces = [],
        stocks = [],
        variables = [],
        nodes = [],
        connections = [],
        modules = [],
        captions = [],
        groups = [],
        metadata = {},
        dslTexts = {},
        scenarioPresets = [],
        etlPipelines = [],
        modelTests = [],
        calibrationConfigs = [],
        createdAt = Date.now(),
        updatedAt = Date.now(),
    } = {}) {
        const payload = {
            format: FORMAT,
            version: WorkspaceSerializer.#coerceVersion(version),
            workspaceId: workspaceId || '',
            createdAt: WorkspaceSerializer.#coerceTimestamp(createdAt, 'createdAt'),
            updatedAt: WorkspaceSerializer.#coerceTimestamp(updatedAt, 'updatedAt'),
            metadata: optionalPlainObject(metadata, 'metadata'),
            namespaces: WorkspaceSerializer.#serializeDtoArray(namespaces, NamespaceDTO, 'namespaces', (dto) => dto.toJSON()),
            stocks: WorkspaceSerializer.#serializeDtoArray(stocks, StockDTO, 'stocks', (dto) => dto.toJSON()),
            variables: WorkspaceSerializer.#serializeDtoArray(variables, VariableDTO, 'variables', (dto) => dto.toJSON()),
            nodes: WorkspaceSerializer.#serializeNodes(nodes),
            connections: WorkspaceSerializer.#serializeDtoArray(connections, ConnectionDTO, 'connections', (dto) => dto.toJSON()),
            modules: WorkspaceSerializer.#serializeModules(modules),
            captions: WorkspaceSerializer.#serializeDtoArray(captions, CaptionDTO, 'captions', (dto) => dto.toJSON()),
            groups: WorkspaceSerializer.#serializeDtoArray(groups, GroupDTO, 'groups', (dto) => dto.toJSON()),
            dslTexts: optionalPlainObject(dslTexts, 'dslTexts'),
            scenarioPresets: optionalArray(scenarioPresets, 'scenarioPresets'),
            etlPipelines: WorkspaceSerializer.#serializeDtoArray(etlPipelines, EtlPipelineDTO, 'etlPipelines', (dto) => dto.toJSON()),
            modelTests: WorkspaceSerializer.#serializeDtoArray(modelTests, ModelTestDTO, 'modelTests', (dto) => dto.toJSON()),
            calibrationConfigs: optionalArray(calibrationConfigs, 'calibrationConfigs'),
        };

        return payload;
    }

    static deserializeWorkspace(payload = {}) {
        const normalized = WorkspaceSerializer.#validatePayload(payload);
        return {
            format: normalized.format,
            version: normalized.version,
            workspaceId: normalized.workspaceId || '',
            createdAt: normalized.createdAt,
            updatedAt: normalized.updatedAt,
            metadata: normalized.metadata,
            namespaces: normalized.namespaces.map((ns) => NamespaceDTO.fromJSON(ns)),
            stocks: normalized.stocks.map((stock) => StockDTO.fromJSON(stock)),
            variables: normalized.variables.map((variable) => VariableDTO.fromJSON(variable)),
            nodes: normalized.nodes.map((node) => freeze({ ...node })),
            connections: normalized.connections.map((connection) => ConnectionDTO.fromJSON(connection)),
            modules: normalized.modules.map((mod) => ModuleDTO.fromPlain(mod)),
            captions: (normalized.captions ?? []).map((c) => CaptionDTO.fromJSON(c)),
            groups: (normalized.groups ?? []).map((g) => GroupDTO.fromJSON(g)),
            dslTexts: normalized.dslTexts,
            scenarioPresets: normalized.scenarioPresets,
            etlPipelines: WorkspaceSerializer.#safeMapDtos(normalized.etlPipelines ?? [], EtlPipelineDTO.fromJSON, 'etlPipelines'),
            modelTests: WorkspaceSerializer.#safeMapDtos(normalized.modelTests ?? [], ModelTestDTO.fromJSON, 'modelTests'),
            calibrationConfigs: normalized.calibrationConfigs,
        };
    }

    static exportToJSON(workspace) {
        return JSON.stringify(WorkspaceSerializer.serializeWorkspace(workspace), null, 2);
    }

    static importFromJSON(json) {
        const payload = JSON.parse(requireString(json, 'workspace JSON'));
        return WorkspaceSerializer.deserializeWorkspace(payload);
    }

    static #coerceVersion(value) {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 1) {
            throw new RangeError('Workspace version must be a positive integer');
        }
        return num;
    }

    static #coerceTimestamp(value, field) {
        const timestamp = requireNumber(Number(value), `workspace.${field}`);
        if (!Number.isFinite(timestamp)) {
            throw new RangeError(`${field} must be finite`);
        }
        return timestamp;
    }

    static #serializeDtoArray(items, Type, label, mapper) {
        if (!Array.isArray(items)) {
            throw new TypeError(`Expected ${label} to be an array`);
        }
        return items.map((item, idx) => {
            if (item instanceof Type) {
                return mapper(item);
            }
            if (typeof item?.toJSON === 'function') {
                return item.toJSON();
            }
            throw new TypeError(`Item ${idx} inside ${label} is not a ${Type.name}`);
        });
    }

    static #safeMapDtos(items, factory, label) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
            try {
                results.push(factory(items[i]));
            } catch (err) {
                console.warn(`[Serializer] Skipped ${label}[${i}]: ${err.message}`, items[i]);
            }
        }
        return results;
    }

    static #serializeNodes(nodes) {
        const list = optionalArray(nodes, 'nodes');
        return list.map((node, idx) => WorkspaceSerializer.#serializeNode(node, idx));
    }

    static #serializeNode(node, idx) {
        if (!node || typeof node !== 'object') {
            throw new TypeError(`Node entry ${idx} must be an object`);
        }
        const snapshot = { ...node };
        if (!snapshot.id) {
            throw new Error(`Node entry ${idx} is missing id`);
        }
        if (!snapshot.type) {
            throw new Error(`Node entry ${idx} is missing type`);
        }
        snapshot.namespaceId = snapshot.namespaceId ?? null;
        return snapshot;
    }

    static #serializeModules(modules) {
        const list = optionalArray(modules, 'modules') ?? [];
        return list.map((mod, idx) => {
            if (mod instanceof ModuleDTO) {
                return mod.toPlain();
            }
            if (typeof mod?.toPlain === 'function') {
                return mod.toPlain();
            }
            if (mod && typeof mod === 'object' && mod.name) {
                // Plain object - validate and pass through
                const plain = {
                    name: mod.name,
                    description: mod.description ?? null,
                    functions: Array.isArray(mod.functions) ? mod.functions : [],
                    exports: mod.exports ?? null,
                };
                if (mod.inputs != null) plain.inputs = mod.inputs;
                if (mod.outputs != null) plain.outputs = mod.outputs;
                return plain;
            }
            throw new TypeError(`Module entry ${idx} is invalid`);
        });
    }

    static #validatePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new TypeError('Workspace payload must be an object');
        }
        if (payload.format !== FORMAT) {
            throw new Error(`Unsupported workspace format: ${payload.format}`);
        }
        if (!Number.isInteger(payload.version)) {
            throw new Error('Workspace payload missing numeric version');
        }
        if (payload.version > CURRENT_VERSION) {
            throw new Error(`Workspace version ${payload.version} is newer than supported version ${CURRENT_VERSION}`);
        }

        const namespaces = WorkspaceSerializer.#validateArray(payload.namespaces, 'namespaces');
        const stocks = WorkspaceSerializer.#validateArray(payload.stocks, 'stocks');
        const variables = WorkspaceSerializer.#validateArray(payload.variables, 'variables');
        const nodes = WorkspaceSerializer.#validateArray(payload.nodes, 'nodes');
        const connections = WorkspaceSerializer.#validateArray(payload.connections ?? [], 'connections');
        const modules = WorkspaceSerializer.#validateArray(payload.modules ?? [], 'modules');
        const captions = WorkspaceSerializer.#validateArray(payload.captions ?? [], 'captions');
        const groups = WorkspaceSerializer.#validateArray(payload.groups ?? [], 'groups');

        return {
            format: payload.format,
            version: payload.version,
            workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : '',
            createdAt: WorkspaceSerializer.#coerceTimestamp(payload.createdAt ?? Date.now(), 'createdAt'),
            updatedAt: WorkspaceSerializer.#coerceTimestamp(payload.updatedAt ?? Date.now(), 'updatedAt'),
            metadata: optionalPlainObject(payload.metadata ?? {}, 'metadata'),
            namespaces,
            stocks,
            variables,
            nodes,
            connections,
            modules,
            captions,
            groups,
            dslTexts: optionalPlainObject(payload.dslTexts ?? {}, 'dslTexts'),
            scenarioPresets: Array.isArray(payload.scenarioPresets) ? payload.scenarioPresets : [],
            etlPipelines: Array.isArray(payload.etlPipelines) ? payload.etlPipelines : [],
            modelTests: Array.isArray(payload.modelTests) ? payload.modelTests : [],
            calibrationConfigs: WorkspaceSerializer.#migrateCalibrationConfigs(payload),
        };
    }

    static #validateArray(value, field) {
        if (!Array.isArray(value)) {
            throw new TypeError(`Workspace payload field "${field}" must be an array`);
        }
        return value;
    }

    static #migrateCalibrationConfigs(payload) {
        if (Array.isArray(payload.calibrationConfigs) && payload.calibrationConfigs.length > 0) {
            return payload.calibrationConfigs;
        }
        // Migrate legacy single calibrationSetup → calibrationConfigs array
        const legacy = payload.calibrationSetup;
        if (legacy && typeof legacy === 'object') {
            const now = Date.now();
            return [{
                id: crypto.randomUUID(),
                name: 'Default',
                description: null,
                parameters: Array.isArray(legacy.parameters) ? legacy.parameters : [],
                targets: Array.isArray(legacy.targets) ? legacy.targets : [],
                settings: legacy.settings ?? {},
                lastResult: null,
                createdAt: now,
                updatedAt: now,
            }];
        }
        return [];
    }
}
