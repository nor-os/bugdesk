/**
 * EcoLang Built-in Functions, Constants, and Keywords
 *
 * Mutable store populated from function_manifest.json via the Python bridge.
 * SymbolRegistry calls populate() during backend sync at startup.
 *
 * All syntax highlighting, autocomplete, and validation import from here.
 * The data is authoritative only after populate() has been called.
 */

// ============================================================================
// Mutable lookup structures — populated by populate()
// ============================================================================

/** @type {Map<string, {name: string, signature: string, description: string}>} */
export const FUNCTIONS_BY_NAME = new Map();

/** @type {Map<string, {name: string, value: any, description: string}>} */
export const CONSTANTS_BY_NAME = new Map();

/** @type {Map<string, {name: string, reason: string, replacement: string}>} */
export const DEPRECATED_BY_NAME = new Map();

/** @type {Set<string>} */
export const KEYWORDS_SET = new Set();

/** @type {string[]} */
export const DSL_KEYWORDS = [];

// ============================================================================
// Populate from bridge data (called by SymbolRegistry.syncFromBackend)
// ============================================================================

/**
 * Clear and refill all collections from the bridge response.
 * This is called once at startup after get_dsl_builtins() returns.
 *
 * @param {Object} data - Response from bridge.get_dsl_builtins()
 * @param {Array} data.functions - Function definitions
 * @param {Array} data.constants - Constant definitions
 * @param {Array} data.keywords - DSL keywords
 * @param {Array} [data.deprecated] - Deprecated function info
 */
export function populate(data) {
    if (!data || typeof data !== 'object') return;

    // Functions
    FUNCTIONS_BY_NAME.clear();
    if (Array.isArray(data.functions)) {
        for (const fn of data.functions) {
            if (fn?.name) {
                FUNCTIONS_BY_NAME.set(fn.name, {
                    name: fn.name,
                    signature: fn.signature || `${fn.name}(...)`,
                    description: fn.description || '',
                });
            }
        }
    }

    // Constants
    CONSTANTS_BY_NAME.clear();
    if (Array.isArray(data.constants)) {
        for (const c of data.constants) {
            if (c?.name) {
                CONSTANTS_BY_NAME.set(c.name, {
                    name: c.name,
                    value: c.value ?? null,
                    description: c.description || '',
                    isConstant: true,
                });
            }
        }
    }

    // Deprecated
    DEPRECATED_BY_NAME.clear();
    if (Array.isArray(data.deprecated)) {
        for (const d of data.deprecated) {
            if (d?.name) {
                DEPRECATED_BY_NAME.set(d.name, {
                    name: d.name,
                    reason: d.reason || '',
                    replacement: d.replacement || '',
                });
            }
        }
    }

    // Keywords
    DSL_KEYWORDS.length = 0;
    KEYWORDS_SET.clear();
    if (Array.isArray(data.keywords)) {
        for (const kw of data.keywords) {
            if (typeof kw === 'string') {
                DSL_KEYWORDS.push(kw);
                KEYWORDS_SET.add(kw);
            }
        }
    }

    // Update the global reference for signature_help.js and autocomplete.js
    if (typeof window !== 'undefined') {
        window.EcoLangBuiltins = EcoLangBuiltins;
    }
}

// ============================================================================
// Composite object for consumers that need the full bundle
// ============================================================================

export const EcoLangBuiltins = {
    get functions() { return Array.from(FUNCTIONS_BY_NAME.values()); },
    get constants() { return Array.from(CONSTANTS_BY_NAME.values()); },
    get deprecated() { return Array.from(DEPRECATED_BY_NAME.values()); },
    get keywords() { return DSL_KEYWORDS; },
    byName: FUNCTIONS_BY_NAME,
    constantsByName: CONSTANTS_BY_NAME,
    deprecatedByName: DEPRECATED_BY_NAME,
    keywordsSet: KEYWORDS_SET,
};

export default EcoLangBuiltins;
