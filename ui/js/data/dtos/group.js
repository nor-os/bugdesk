/**
 * Group DTO (js_new)
 *
 * Visual grouping of nodes on the canvas.
 * Not a node — no connectors, no DSL, no simulation participation.
 * Groups move together when dragged and share a visual overlay.
 */

import {
    requireUUID,
    requireString,
    requireNumber,
    optionalArray,
    freeze,
} from '../validators.js';

export class GroupDTO {
    constructor({
        id,
        name = 'Group',
        namespaceId,
        nodeIds = [],
        color = '#888888',
        createdAt = Date.now(),
        updatedAt = Date.now(),
    } = {}) {
        this.id = requireUUID(id, 'GroupDTO.id');
        this.name = requireString(name, 'GroupDTO.name');
        this.namespaceId = requireUUID(namespaceId, 'GroupDTO.namespaceId');
        this.nodeIds = freeze(GroupDTO.#coerceNodeIds(nodeIds));
        this.color = GroupDTO.#coerceColor(color);
        this.createdAt = GroupDTO.#coerceTimestamp(createdAt, 'GroupDTO.createdAt');
        this.updatedAt = GroupDTO.#coerceTimestamp(updatedAt, 'GroupDTO.updatedAt');

        freeze(this);
    }

    static fromJSON(payload) {
        return new GroupDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            namespaceId: this.namespaceId,
            nodeIds: [...this.nodeIds],
            color: this.color,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    withChanges(patch = {}) {
        return new GroupDTO({ ...this.toJSON(), ...patch, updatedAt: patch.updatedAt ?? Date.now() });
    }

    static #coerceNodeIds(value) {
        const arr = optionalArray(value, 'GroupDTO.nodeIds');
        return arr.filter((id) => typeof id === 'string' && id.trim().length > 0);
    }

    static #coerceColor(value) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
        return '#888888';
    }

    static #coerceTimestamp(value, field) {
        const coerced = requireNumber(Number(value), field);
        if (!Number.isFinite(coerced)) {
            throw new RangeError(`${field} must be a finite number`);
        }
        return coerced;
    }
}
