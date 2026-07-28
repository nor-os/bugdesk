/**
 * Variable DTO (js_new)
 *
 * Contains serialized details for node outputs, parameters, and derived variables.
 *
 * Fields
 * - namespaceId + owning nodeId.
 * - canonical key, display label, unit metadata.
 * - bindings to stocks/flows or DSL expressions.
 *
 * Source Material
 * - html/js/variable_registry.js and variable_manifest.js.
 * - html/js/nodes/* serialization blocks (constant/function/parameter nodes especially).
 */

import {
    requireUUID,
    requireString,
    optionalString,
    optionalPlainObject,
    optionalArray,
    freeze,
} from '../validators.js';

const VALUE_TYPES = new Set(['output', 'parameter', 'derived', 'interop']);

export class VariableDTO {
    constructor({
        id,
        namespaceId,
        nodeId,
        key,
        displayName = null,
        description = null,
        valueType = 'derived',
        dataType = 'scalar',
        unit = null,
        expression = null,
        defaultValue = null,
        bindings = {},
        tags = [],
        metadata = {},
    } = {}) {
        this.id = requireUUID(id, 'VariableDTO.id');
        this.namespaceId = requireUUID(namespaceId, 'VariableDTO.namespaceId');
        this.nodeId = requireString(nodeId, 'VariableDTO.nodeId');
        this.key = requireString(key, 'VariableDTO.key');
        this.displayName = optionalString(displayName, 'VariableDTO.displayName');
        this.description = optionalString(description, 'VariableDTO.description');
        this.valueType = VariableDTO.#normalizeValueType(valueType);
        this.dataType = requireString(dataType, 'VariableDTO.dataType');
        this.unit = optionalString(unit, 'VariableDTO.unit');
        this.expression = optionalString(expression, 'VariableDTO.expression');
        this.defaultValue = defaultValue ?? null;
        this.bindings = freeze(optionalPlainObject(bindings, 'VariableDTO.bindings'));
        this.tags = freeze(VariableDTO.#sanitizeTags(tags));
        this.metadata = freeze(optionalPlainObject(metadata, 'VariableDTO.metadata'));

        freeze(this);
    }

    static fromJSON(payload) {
        return new VariableDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            namespaceId: this.namespaceId,
            nodeId: this.nodeId,
            key: this.key,
            displayName: this.displayName,
            description: this.description,
            valueType: this.valueType,
            dataType: this.dataType,
            unit: this.unit,
            expression: this.expression,
            defaultValue: this.defaultValue,
            bindings: { ...this.bindings },
            tags: [...this.tags],
            metadata: { ...this.metadata },
        };
    }

    withChanges(patch = {}) {
        return new VariableDTO({ ...this.toJSON(), ...patch });
    }

    static #normalizeValueType(value) {
        const normalized = requireString(value, 'VariableDTO.valueType').toLowerCase();
        if (!VALUE_TYPES.has(normalized)) {
            throw new RangeError(`VariableDTO.valueType must be one of: ${Array.from(VALUE_TYPES).join(', ')}`);
        }
        return normalized;
    }

    static #sanitizeTags(tags) {
        const list = optionalArray(tags, 'VariableDTO.tags');
        const normalized = list.map((tag, idx) => requireString(tag, `VariableDTO.tags[${idx}]`).toLowerCase());
        return Array.from(new Set(normalized));
    }
}
