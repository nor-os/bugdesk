/**
 * Shared data validation helpers used by DTOs and serializers.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireString(value, fieldName) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${fieldName} must be a non-empty string`);
    }
    return value.trim();
}

export function optionalString(value, fieldName) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a string when provided`);
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

export function requireUUID(value, fieldName) {
    const str = requireString(value, fieldName);
    if (!UUID_RE.test(str)) {
        throw new TypeError(`${fieldName} must be a valid UUID`);
    }
    return str;
}

export function requireNumber(value, fieldName) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new TypeError(`${fieldName} must be a finite number`);
    }
    return value;
}

export function optionalNumber(value, fieldName) {
    if (value === null || value === undefined) {
        return null;
    }
    return requireNumber(value, fieldName);
}

export function requireBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
        throw new TypeError(`${fieldName} must be a boolean`);
    }
    return value;
}

export function optionalArray(value, fieldName) {
    if (value === null || value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new TypeError(`${fieldName} must be an array when provided`);
    }
    return value.slice();
}

export function requirePlainObject(value, fieldName) {
    if (!isPlainObject(value)) {
        throw new TypeError(`${fieldName} must be a plain object`);
    }
    return { ...value };
}

export function optionalPlainObject(value, fieldName) {
    if (value === null || value === undefined) {
        return {};
    }
    return requirePlainObject(value, fieldName);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function freeze(obj) {
    return Object.freeze(obj);
}
