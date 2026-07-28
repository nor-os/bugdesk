/**
 * Caption DTO (js_new)
 *
 * Lightweight text annotation on the canvas.
 * Not a node — no connectors, no DSL, no simulation participation.
 */

import {
    requireUUID,
    requireString,
    requireNumber,
    optionalPlainObject,
    freeze,
} from '../validators.js';

export class CaptionDTO {
    constructor({
        id,
        text = 'Caption',
        namespaceId,
        position = { x: 0, y: 0 },
        createdAt = Date.now(),
        updatedAt = Date.now(),
    } = {}) {
        this.id = requireUUID(id, 'CaptionDTO.id');
        this.text = requireString(text, 'CaptionDTO.text');
        this.namespaceId = requireUUID(namespaceId, 'CaptionDTO.namespaceId');
        this.position = CaptionDTO.#coercePosition(position);
        this.createdAt = CaptionDTO.#coerceTimestamp(createdAt, 'CaptionDTO.createdAt');
        this.updatedAt = CaptionDTO.#coerceTimestamp(updatedAt, 'CaptionDTO.updatedAt');

        freeze(this);
    }

    static fromJSON(payload) {
        return new CaptionDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            text: this.text,
            namespaceId: this.namespaceId,
            position: { ...this.position },
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    withChanges(patch = {}) {
        return new CaptionDTO({ ...this.toJSON(), ...patch, updatedAt: patch.updatedAt ?? Date.now() });
    }

    static #coercePosition(value) {
        const pos = optionalPlainObject(value, 'CaptionDTO.position') ?? { x: 0, y: 0 };
        return freeze({
            x: Number.isFinite(pos.x) ? pos.x : 0,
            y: Number.isFinite(pos.y) ? pos.y : 0,
        });
    }

    static #coerceTimestamp(value, field) {
        const coerced = requireNumber(Number(value), field);
        if (!Number.isFinite(coerced)) {
            throw new RangeError(`${field} must be a finite number`);
        }
        return coerced;
    }
}
