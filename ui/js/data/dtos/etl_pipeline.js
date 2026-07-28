/**
 * ETL Pipeline DTO
 *
 * Immutable data transfer object for ETL pipelines and orchestrations.
 * Follows the GroupDTO pattern: non-namespaced, UUID-keyed, frozen.
 *
 * kind:
 *   - "pipeline": source -> transform -> sink chain (has steps, parameters)
 *   - "orchestration": multi-pipeline runner (has items, cacheTtlDays)
 */

import {
    requireUUID,
    requireString,
    optionalString,
    optionalArray,
    optionalPlainObject,
    requireNumber,
    freeze,
} from '../validators.js';

const VALID_KINDS = new Set(['pipeline', 'orchestration']);

export class EtlPipelineDTO {
    constructor({
        id,
        kind = 'pipeline',
        name = 'Pipeline',
        description = null,
        parameters = [],
        steps = [],
        graph = null,
        items = [],
        runs = [],
        cacheTtlDays = 1,
        datasetName = null,
        metadata = {},
        createdAt = Date.now(),
        updatedAt = Date.now(),
        _filePath = null,
    } = {}) {
        this.id = requireUUID(id, 'EtlPipelineDTO.id');
        this.kind = EtlPipelineDTO.#coerceKind(kind);
        this.name = requireString(name, 'EtlPipelineDTO.name');
        this.description = optionalString(description, 'EtlPipelineDTO.description');
        // Pipeline-specific
        this.parameters = freeze(EtlPipelineDTO.#deepFreezeArray(
            optionalArray(parameters, 'EtlPipelineDTO.parameters'),
        ));
        this.steps = freeze(EtlPipelineDTO.#deepFreezeArray(
            optionalArray(steps, 'EtlPipelineDTO.steps'),
        ));
        this.graph = graph ? freeze(structuredClone(graph)) : null;

        // Orchestration-specific
        this.items = freeze(EtlPipelineDTO.#deepFreezeArray(
            optionalArray(items, 'EtlPipelineDTO.items'),
        ));
        this.cacheTtlDays = EtlPipelineDTO.#coerceNumber(cacheTtlDays, 1);
        this.datasetName = optionalString(datasetName, 'EtlPipelineDTO.datasetName');

        // Shared
        this.runs = freeze(optionalArray(runs, 'EtlPipelineDTO.runs'));
        this.metadata = freeze(optionalPlainObject(metadata, 'EtlPipelineDTO.metadata'));
        this.createdAt = EtlPipelineDTO.#coerceTimestamp(createdAt, 'EtlPipelineDTO.createdAt');
        this.updatedAt = EtlPipelineDTO.#coerceTimestamp(updatedAt, 'EtlPipelineDTO.updatedAt');
        this._filePath = _filePath ?? null;

        freeze(this);
    }

    static fromJSON(payload) {
        return new EtlPipelineDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            kind: this.kind,
            name: this.name,
            description: this.description,
            parameters: structuredClone(this.parameters),
            steps: structuredClone(this.steps),
            graph: this.graph ? structuredClone(this.graph) : null,
            items: structuredClone(this.items),
            runs: structuredClone(this.runs),
            cacheTtlDays: this.cacheTtlDays,
            datasetName: this.datasetName,
            metadata: structuredClone(this.metadata),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            _filePath: this._filePath,
        };
    }

    withChanges(patch = {}) {
        return new EtlPipelineDTO({
            ...this.toJSON(),
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
        });
    }

    static #coerceKind(value) {
        const str = typeof value === 'string' ? value.trim().toLowerCase() : 'pipeline';
        if (!VALID_KINDS.has(str)) {
            throw new TypeError(
                `EtlPipelineDTO.kind must be one of ${[...VALID_KINDS].join(', ')}, got ${value}`,
            );
        }
        return str;
    }

    static #coerceNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    static #coerceTimestamp(value, field) {
        const coerced = requireNumber(Number(value), field);
        if (!Number.isFinite(coerced)) {
            throw new RangeError(`${field} must be a finite number`);
        }
        return coerced;
    }

    static #deepFreezeArray(arr) {
        return arr.map(item => {
            if (item && typeof item === 'object') {
                return freeze(structuredClone(item));
            }
            return item;
        });
    }
}
