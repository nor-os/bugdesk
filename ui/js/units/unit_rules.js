/**
 * unit_rules.js
 *
 * Loads unitRule definitions from function_manifest.json (synced via bridge)
 * and provides a lookup map for the unit propagator.
 *
 * Rule types:
 *   "sameAs"               — result = unit of param[N]
 *   "power"                — result = unit(param[base])^exponent
 *   "powerParam"           — result = unit(param[base])^param[exponentParam]
 *   "requireDimensionless" — listed params must be dimensionless; result is dimensionless
 *   "dimensionless"        — result is always dimensionless (no param constraints)
 *   "passthrough"          — no constraints, result unit unknown
 */

/** @type {Map<string, Object>} */
let _rulesCache = null;

/**
 * Build the rules map from the manifest functions object.
 * @param {Object} functions - The "functions" section of function_manifest.json
 * @returns {Map<string, Object>}
 */
function buildRulesMap(functions) {
    const map = new Map();
    if (!functions || typeof functions !== 'object') return map;

    for (const [name, def] of Object.entries(functions)) {
        if (def.unitRule) {
            map.set(name, def.unitRule);
        }
    }
    return map;
}

/**
 * Get the unit rules map. Uses cached version if available.
 * @param {Object} [manifest] - Full manifest object. If omitted, tries window.__ECOSIM_MANIFEST__
 * @returns {Map<string, Object>}
 */
export function getUnitRules(manifest) {
    if (_rulesCache) return _rulesCache;

    const src = manifest
        ?? window.__ECOSIM_MANIFEST__
        ?? window.__ECOSIM_JS_NEW__?.manifest;

    if (src?.functions) {
        _rulesCache = buildRulesMap(src.functions);
    } else {
        _rulesCache = new Map();
    }

    return _rulesCache;
}

/**
 * Get the unit rule for a specific function.
 * @param {string} funcName
 * @param {Object} [manifest]
 * @returns {Object|null} Rule object or null
 */
export function getUnitRule(funcName, manifest) {
    return getUnitRules(manifest).get(funcName) ?? null;
}

/**
 * Clear the cached rules (e.g., when manifest is reloaded).
 */
export function clearRulesCache() {
    _rulesCache = null;
}
