/**
 * unit_engine.js
 *
 * Core unit algebra engine for dimensional analysis.
 * Represents units as dimension maps (e.g. { USD: 1, time: -1 } for "USD/yr").
 * Provides parse, multiply, divide, power, equals, compatible, and format operations.
 *
 * Unit representation:
 *   null  = unit not specified (compatible with anything — graceful degradation)
 *   {}    = explicitly dimensionless
 *   { dim: exp, ... } = concrete unit with dimensions
 */

/**
 * @typedef {Object<string, number>|null} Unit
 * A map from dimension name to exponent, or null for "unspecified".
 */

/**
 * Parse a user-facing unit string into a dimension map.
 *
 * Grammar:
 *   unit_string = unit_term (('*' | '/') unit_term)*
 *   unit_term   = identifier ('^' number)?
 *   identifier  = [A-Za-z_][A-Za-z_0-9]*
 *   number      = optional '-', digits, optional '.' digits
 *
 * Examples:
 *   "USD"        -> { USD: 1 }
 *   "USD/year"   -> { USD: 1, year: -1 }
 *   "kg*m/s^2"   -> { kg: 1, m: 1, s: -2 }
 *   "m^2"        -> { m: 2 }
 *   ""           -> {}  (dimensionless)
 *   "1"          -> {}  (dimensionless)
 *
 * @param {string|null|undefined} str - Unit string
 * @returns {Unit} Parsed unit, or null if input is null/undefined
 */
export function parse(str) {
    if (str == null) return null;
    str = str.trim();
    if (str === '' || str === '1' || str === 'dimensionless') return {};

    const dims = {};
    let pos = 0;
    let sign = 1; // Tracks whether we're in numerator (+1) or denominator (-1)

    const skipWhitespace = () => {
        while (pos < str.length && str[pos] === ' ') pos++;
    };

    const parseIdentifier = () => {
        skipWhitespace();
        const start = pos;
        while (pos < str.length && /[A-Za-z_0-9]/.test(str[pos])) pos++;
        if (pos === start) return null;
        return str.slice(start, pos);
    };

    const parseNumber = () => {
        skipWhitespace();
        const start = pos;
        if (pos < str.length && str[pos] === '-') pos++;
        while (pos < str.length && /[0-9.]/.test(str[pos])) pos++;
        if (pos === start) return null;
        return parseFloat(str.slice(start, pos));
    };

    const parseTerm = () => {
        const id = parseIdentifier();
        if (!id) return;

        // Check for ^exponent
        skipWhitespace();
        let exp = 1;
        if (pos < str.length && str[pos] === '^') {
            pos++; // skip ^
            const num = parseNumber();
            if (num != null && !isNaN(num)) {
                exp = num;
            }
        }

        dims[id] = (dims[id] || 0) + exp * sign;
    };

    // Parse first term
    parseTerm();

    // Parse remaining terms with * or /
    while (pos < str.length) {
        skipWhitespace();
        if (pos >= str.length) break;

        const op = str[pos];
        if (op === '*') {
            pos++;
            sign = 1;
            parseTerm();
        } else if (op === '/') {
            pos++;
            sign = -1;
            parseTerm();
        } else {
            // Unknown character — stop parsing
            break;
        }
    }

    // Clean up zero exponents
    for (const key of Object.keys(dims)) {
        if (dims[key] === 0) delete dims[key];
    }

    return dims;
}

/**
 * Multiply two units (add exponents).
 * @param {Unit} a
 * @param {Unit} b
 * @returns {Unit} Product unit
 */
export function multiply(a, b) {
    if (a == null) return b;
    if (b == null) return a;

    const result = { ...a };
    for (const [dim, exp] of Object.entries(b)) {
        result[dim] = (result[dim] || 0) + exp;
        if (result[dim] === 0) delete result[dim];
    }
    return result;
}

/**
 * Divide two units (subtract exponents).
 * @param {Unit} a - Numerator unit
 * @param {Unit} b - Denominator unit
 * @returns {Unit} Quotient unit
 */
export function divide(a, b) {
    if (a == null) return b != null ? negate(b) : null;
    if (b == null) return a;

    const result = { ...a };
    for (const [dim, exp] of Object.entries(b)) {
        result[dim] = (result[dim] || 0) - exp;
        if (result[dim] === 0) delete result[dim];
    }
    return result;
}

/**
 * Negate all exponents (reciprocal unit).
 * @param {Unit} u
 * @returns {Unit}
 */
function negate(u) {
    if (u == null) return null;
    const result = {};
    for (const [dim, exp] of Object.entries(u)) {
        result[dim] = -exp;
    }
    return result;
}

/**
 * Raise a unit to a power (scale exponents).
 * @param {Unit} u - Unit
 * @param {number} n - Power
 * @returns {Unit}
 */
export function power(u, n) {
    if (u == null) return null;
    if (n === 0) return {};
    if (n === 1) return { ...u };

    const result = {};
    for (const [dim, exp] of Object.entries(u)) {
        const newExp = exp * n;
        if (newExp !== 0) {
            result[dim] = newExp;
        }
    }
    return result;
}

/**
 * Check if two units are exactly equal.
 * @param {Unit} a
 * @param {Unit} b
 * @returns {boolean}
 */
export function equals(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    return keysA.every(k => a[k] === b[k]);
}

/**
 * Check if two units are compatible (can be added/subtracted).
 * Compatible means either equal, or one is null (unspecified).
 * @param {Unit} a
 * @param {Unit} b
 * @returns {boolean}
 */
export function compatible(a, b) {
    if (a == null || b == null) return true;
    return equals(a, b);
}

/**
 * Check if a unit is dimensionless (empty dimension map).
 * @param {Unit} u
 * @returns {boolean}
 */
export function isDimensionless(u) {
    if (u == null) return false; // null = unknown, not dimensionless
    return Object.keys(u).length === 0;
}

/**
 * Format a unit back to a human-readable string.
 *
 * Examples:
 *   { USD: 1 }           -> "USD"
 *   { USD: 1, year: -1 } -> "USD/year"
 *   { m: 2 }             -> "m^2"
 *   { kg: 1, m: 1, s: -2 } -> "kg*m/s^2"
 *   {}                    -> "dimensionless"
 *   null                  -> ""
 *
 * @param {Unit} u
 * @returns {string}
 */
export function format(u) {
    if (u == null) return '';
    const entries = Object.entries(u);
    if (entries.length === 0) return 'dimensionless';

    const numerator = entries.filter(([, exp]) => exp > 0);
    const denominator = entries.filter(([, exp]) => exp < 0);

    const formatTerm = ([dim, exp]) => {
        const absExp = Math.abs(exp);
        return absExp === 1 ? dim : `${dim}^${absExp}`;
    };

    let result = '';

    if (numerator.length > 0) {
        result = numerator.map(formatTerm).join('*');
    } else if (denominator.length > 0) {
        result = '1';
    }

    if (denominator.length > 0) {
        result += '/' + denominator.map(formatTerm).join('/');
    }

    return result;
}
