/**
 * Model Test DTO
 *
 * Immutable data transfer object for model feedback-loop test cases.
 * Follows the EtlPipelineDTO pattern: non-namespaced, UUID-keyed, frozen.
 *
 * A test case pins one or more stocks to fixed values and asserts conditions
 * on observed stocks after a simulation run.
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

const VALID_OPERATORS = new Set(['>', '<', '>=', '<=', '==', '!=']);
const VALID_TIMEPOINTS = new Set(['final', 'any', 'all']);

export class ModelTestDTO {
    constructor({
        id,
        name = 'Untitled Test',
        description = null,
        enabled = true,
        pins = [],
        assertions = [],
        lastResult = null,
        metadata = {},
        createdAt = Date.now(),
        updatedAt = Date.now(),
    } = {}) {
        this.id = requireUUID(id, 'ModelTestDTO.id');
        this.name = requireString(name, 'ModelTestDTO.name');
        this.description = optionalString(description, 'ModelTestDTO.description');
        this.enabled = !!enabled;

        this.pins = freeze(ModelTestDTO.#validatePins(
            optionalArray(pins, 'ModelTestDTO.pins'),
        ));
        this.assertions = freeze(ModelTestDTO.#validateAssertions(
            optionalArray(assertions, 'ModelTestDTO.assertions'),
        ));

        this.lastResult = lastResult ? freeze(ModelTestDTO.#freezeResult(lastResult)) : null;
        this.metadata = freeze(optionalPlainObject(metadata, 'ModelTestDTO.metadata'));
        this.createdAt = ModelTestDTO.#coerceTimestamp(createdAt, 'ModelTestDTO.createdAt');
        this.updatedAt = ModelTestDTO.#coerceTimestamp(updatedAt, 'ModelTestDTO.updatedAt');

        freeze(this);
    }

    static fromJSON(payload) {
        return new ModelTestDTO(payload);
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            enabled: this.enabled,
            pins: structuredClone(this.pins),
            assertions: structuredClone(this.assertions),
            lastResult: this.lastResult ? structuredClone(this.lastResult) : null,
            metadata: structuredClone(this.metadata),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    withChanges(patch = {}) {
        return new ModelTestDTO({
            ...this.toJSON(),
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
        });
    }

    // ─── Private Validation ──────────────────────────────────────────

    static #validatePins(arr) {
        return arr.map((pin, i) => {
            if (!pin || typeof pin !== 'object') {
                throw new TypeError(`ModelTestDTO.pins[${i}] must be an object`);
            }
            return freeze({
                id: requireString(pin.id, `ModelTestDTO.pins[${i}].id`),
                stockRef: typeof pin.stockRef === 'string' ? pin.stockRef : '',
                value: requireNumber(Number(pin.value), `ModelTestDTO.pins[${i}].value`),
            });
        });
    }

    static #validateAssertions(arr) {
        return arr.map((a, i) => {
            if (!a || typeof a !== 'object') {
                throw new TypeError(`ModelTestDTO.assertions[${i}] must be an object`);
            }
            const op = requireString(a.operator, `ModelTestDTO.assertions[${i}].operator`);
            if (!VALID_OPERATORS.has(op)) {
                throw new TypeError(
                    `ModelTestDTO.assertions[${i}].operator must be one of ${[...VALID_OPERATORS].join(', ')}, got "${op}"`,
                );
            }
            const tp = requireString(a.timePoint ?? 'final', `ModelTestDTO.assertions[${i}].timePoint`);
            if (!VALID_TIMEPOINTS.has(tp)) {
                throw new TypeError(
                    `ModelTestDTO.assertions[${i}].timePoint must be one of ${[...VALID_TIMEPOINTS].join(', ')}, got "${tp}"`,
                );
            }
            return freeze({
                id: requireString(a.id, `ModelTestDTO.assertions[${i}].id`),
                stockRef: typeof a.stockRef === 'string' ? a.stockRef : '',
                operator: op,
                threshold: requireNumber(Number(a.threshold), `ModelTestDTO.assertions[${i}].threshold`),
                timePoint: tp,
            });
        });
    }

    static #freezeResult(result) {
        if (!result || typeof result !== 'object') return null;
        return {
            status: result.status ?? null,
            timestamp: result.timestamp ?? Date.now(),
            error: result.error ?? null,
            assertionResults: freeze(
                (result.assertionResults || []).map(ar => freeze({
                    assertionId: ar.assertionId ?? '',
                    passed: !!ar.passed,
                    actualValue: ar.actualValue ?? null,
                    message: ar.message ?? '',
                })),
            ),
        };
    }

    static #coerceTimestamp(value, field) {
        const coerced = requireNumber(Number(value), field);
        if (!Number.isFinite(coerced)) {
            throw new RangeError(`${field} must be a finite number`);
        }
        return coerced;
    }
}
