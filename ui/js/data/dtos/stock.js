/**
 * Stock DTO (js_new)
 *
 * Represents a namespaces stock variable entry (sector + account metadata + hard-link info).
 *
 * Fields
 * - namespaceId, sectorId, accountType, accountName (canonical identifiers).
 * - balance metadata, units, annotations.
 * - reference counts / hard-link tracking for lifecycle management.
 *
 * Source Material
 * - html/js/stock_registry*.js fragments (spread throughout nodes/Godley components).
 * - html/js/godley_table_component.js (sector/account schema).
 */

import {
    requireUUID,
    requireString,
    optionalString,
    optionalPlainObject,
    optionalArray,
    requireNumber,
    freeze,
} from '../validators.js';

const MIN_LINKS = 1;

export class StockDTO {
    constructor({
        id,
        namespaceId,
        sectorId,
        accountType,
        accountName,
        displayName = null,
        description = null,
        unit = null,
        currency = null,
        initialValue = 0,
        minValue = null,
        maxValue = null,
        hardLinkCount = MIN_LINKS,
        references = [],
        tags = [],
        metadata = {},
    } = {}) {
        this.id = requireUUID(id, 'StockDTO.id');
        this.namespaceId = requireUUID(namespaceId, 'StockDTO.namespaceId');
        this.sectorId = requireString(sectorId, 'StockDTO.sectorId');
        this.accountType = requireString(accountType, 'StockDTO.accountType');
        this.accountName = requireString(accountName, 'StockDTO.accountName');
        this.displayName = optionalString(displayName, 'StockDTO.displayName');
        this.description = optionalString(description, 'StockDTO.description');
        this.unit = optionalString(unit, 'StockDTO.unit');
        this.currency = optionalString(currency, 'StockDTO.currency');
        this.initialValue = requireNumber(Number(initialValue), 'StockDTO.initialValue');
        this.minValue = minValue === null || minValue === undefined ? null : requireNumber(Number(minValue), 'StockDTO.minValue');
        this.maxValue = maxValue === null || maxValue === undefined ? null : requireNumber(Number(maxValue), 'StockDTO.maxValue');
        this.hardLinkCount = StockDTO.#coerceLinks(hardLinkCount);
        this.references = freeze(StockDTO.#normalizeReferences(references));
        this.tags = freeze(StockDTO.#sanitizeTags(tags));
        this.metadata = freeze(optionalPlainObject(metadata, 'StockDTO.metadata'));

        freeze(this);
    }

    static fromJSON(payload) {
        return new StockDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            namespaceId: this.namespaceId,
            sectorId: this.sectorId,
            accountType: this.accountType,
            accountName: this.accountName,
            displayName: this.displayName,
            description: this.description,
            unit: this.unit,
            currency: this.currency,
            initialValue: this.initialValue,
            minValue: this.minValue,
            maxValue: this.maxValue,
            hardLinkCount: this.hardLinkCount,
            references: [...this.references],
            tags: [...this.tags],
            metadata: { ...this.metadata },
        };
    }

    withChanges(patch = {}) {
        return new StockDTO({ ...this.toJSON(), ...patch });
    }

    static #coerceLinks(value) {
        const num = requireNumber(Number(value), 'StockDTO.hardLinkCount');
        if (!Number.isInteger(num) || num < MIN_LINKS) {
            throw new RangeError(`StockDTO.hardLinkCount must be an integer >= ${MIN_LINKS}`);
        }
        return num;
    }

    static #normalizeReferences(refs) {
        const entries = optionalArray(refs, 'StockDTO.references');
        return entries.map((ref, idx) => requireString(ref, `StockDTO.references[${idx}]`));
    }

    static #sanitizeTags(tags) {
        const list = optionalArray(tags, 'StockDTO.tags');
        const normalized = list.map((tag, idx) => requireString(tag, `StockDTO.tags[${idx}]`).toLowerCase());
        return Array.from(new Set(normalized));
    }
}
