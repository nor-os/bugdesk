/**
 * Namespace DTO (js_new)
 *
 * Captures the persisted representation of a workspace namespace/tab.
 *
 * Fields (planned)
 * - id: canonical namespace UUID.
 * - displayName / alias metadata.
 * - slug: filesystem-friendly identifier (optional).
 * - tabIndex/layout hints and chrome styling.
 * - audit fields (created, updated) for host synchronization.
 *
 * Source Material
 * - html/js/namespace_directory.js (alias + tab metadata).
 * - html/js/ui_manager.js tabs implementation.
 */

/**
 * Implementation notes
 * - DTOs are immutable; call `withChanges` to derive new instances.
 */

import {
    requireUUID,
    requireString,
    optionalString,
    optionalPlainObject,
    requireBoolean,
    requireNumber,
    freeze,
} from '../validators.js';

export class NamespaceDTO {
    constructor({
        id,
        displayName,
        slug = null,
        tabIndex = 0,
        color = null,
        isLocked = false,
        isArchived = false,
        createdAt = Date.now(),
        updatedAt = Date.now(),
        metadata = {},
    } = {}) {
        this.id = requireUUID(id, 'NamespaceDTO.id');
        this.displayName = requireString(displayName, 'NamespaceDTO.displayName');
        this.slug = optionalString(slug, 'NamespaceDTO.slug');
        this.tabIndex = NamespaceDTO.#coerceIndex(tabIndex);
        this.color = optionalString(color, 'NamespaceDTO.color');
        this.isLocked = requireBoolean(Boolean(isLocked), 'NamespaceDTO.isLocked');
        this.isArchived = requireBoolean(Boolean(isArchived), 'NamespaceDTO.isArchived');
        this.createdAt = NamespaceDTO.#coerceTimestamp(createdAt, 'NamespaceDTO.createdAt');
        this.updatedAt = NamespaceDTO.#coerceTimestamp(updatedAt, 'NamespaceDTO.updatedAt');
        this.metadata = freeze(optionalPlainObject(metadata, 'NamespaceDTO.metadata'));

        freeze(this);
    }

    static fromJSON(payload) {
        return new NamespaceDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            displayName: this.displayName,
            slug: this.slug,
            tabIndex: this.tabIndex,
            color: this.color,
            isLocked: this.isLocked,
            isArchived: this.isArchived,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            metadata: { ...this.metadata },
        };
    }

    withChanges(patch = {}) {
        return new NamespaceDTO({ ...this.toJSON(), ...patch, updatedAt: patch.updatedAt ?? Date.now() });
    }

    static #coerceIndex(value) {
        const num = requireNumber(Number(value), 'NamespaceDTO.tabIndex');
        if (!Number.isInteger(num) || num < 0) {
            throw new RangeError('NamespaceDTO.tabIndex must be a non-negative integer');
        }
        return num;
    }

    static #coerceTimestamp(value, field) {
        const coerced = requireNumber(Number(value), field);
        if (!Number.isFinite(coerced)) {
            throw new RangeError(`${field} must be a finite number`);
        }
        return coerced;
    }
}
