/**
 * SymbolRegistry - Unified symbol lookup for EcoSim
 *
 * Aggregates symbols from:
 * - Backend DSL builtins (synced at startup via hostBridge)
 * - DataManager (variables, stocks, namespaces)
 * - ModuleRegistry (user-defined functions)
 *
 * Provides a single, filterable API for autocomplete, validation, and browsing.
 */

import { populate as populateBuiltins } from './ecolang_builtins.js';

/**
 * @typedef {Object} Symbol
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} qualifiedName - Full qualified name (e.g., "Math.sin")
 * @property {'function'|'constant'|'variable'|'stock'|'namespace'} type
 * @property {'builtin'|'project'|'workspace'} source
 * @property {string} [signature] - Function signature
 * @property {string} [description] - Description text
 * @property {string} [namespaceId] - Associated namespace
 * @property {string} [moduleId] - Associated module
 * @property {string} [valueType] - Value type for variables/stocks
 * @property {boolean} [deprecated] - Whether deprecated
 * @property {string} insertText - Text to insert for autocomplete
 * @property {string} iconType - Icon type for UI
 */

/**
 * @typedef {Object} FilterOptions
 * @property {string[]} [types] - Filter by symbol types
 * @property {string} [source] - Filter by source
 * @property {string} [namespaceId] - Filter by namespace
 * @property {string} [moduleId] - Filter by module
 * @property {string} [search] - Text search filter
 * @property {boolean} [includeDeprecated] - Include deprecated symbols
 */

export class SymbolRegistry {
    /**
     * @param {Object} options
     * @param {Object} [options.dataManager] - DataManager instance
     * @param {Object} [options.moduleRegistry] - ModuleRegistry instance
     * @param {Object} [options.eventBus] - EventBus for change notifications
     * @param {Object} [options.logger] - Logger instance
     */
    constructor({ dataManager = null, moduleRegistry = null, eventBus = null, logger = null } = {}) {
        this.dataManager = dataManager;
        this.moduleRegistry = moduleRegistry;
        this.eventBus = eventBus;
        this.logger = logger;

        /** @type {Map<string, Symbol>} */
        this._builtinFunctions = new Map();

        /** @type {Map<string, Symbol>} */
        this._builtinConstants = new Map();

        /** @type {string[]} */
        this._builtinKeywords = [];

        /** @type {string[]} */
        this._expressionKeywords = [];

        /** @type {string[]} */
        this._literals = [];

        /** @type {Array<{name: string, reason: string, replacement: string}>} */
        this._deprecated = [];

        /** @type {boolean} */
        this._syncedFromBackend = false;

        /** @type {Array<Function>} */
        this._listeners = [];

        /** @type {Object|null} - ExpressionServices to update when builtins sync */
        this._expressionServices = null;

        // Subscribe to data changes
        this._subscribeToChanges();
    }

    /**
     * Link ExpressionServices so it receives builtin updates.
     * @param {Object} expressionServices - ExpressionServices instance
     */
    linkExpressionServices(expressionServices) {
        this._expressionServices = expressionServices;
        // If already synced, immediately update
        if (this._syncedFromBackend) {
            this._updateExpressionServices();
        }
    }

    // =========================================================================
    // Backend Sync
    // =========================================================================

    /**
     * Sync DSL builtins from the Python backend.
     * This should be called once at startup.
     * @param {Object} hostBridge - pywebview bridge with get_dsl_builtins method
     * @returns {Promise<void>}
     */
    async syncFromBackend(hostBridge) {
        if (!hostBridge?.get_dsl_builtins) {
            throw new Error('SymbolRegistry: Backend hostBridge with get_dsl_builtins is required');
        }

        try {
            this.logger?.info?.('symbol-registry', 'Syncing DSL builtins from backend...');
            const result = await hostBridge.get_dsl_builtins();

            if (!result || typeof result !== 'object') {
                throw new Error('Invalid response from get_dsl_builtins');
            }

            // Clear existing builtins
            this._builtinFunctions.clear();
            this._builtinConstants.clear();
            this._builtinKeywords = [];

            // Load functions
            const functions = result.functions || [];
            for (const fn of functions) {
                const symbol = this._createBuiltinFunctionSymbol(fn);
                this._builtinFunctions.set(symbol.id, symbol);
            }

            // Load constants
            const constants = result.constants || [];
            for (const c of constants) {
                const symbol = this._createBuiltinConstantSymbol(c);
                this._builtinConstants.set(symbol.id, symbol);
            }

            // Load keywords (if backend provides them)
            if (Array.isArray(result.keywords)) {
                this._builtinKeywords = result.keywords.filter(k => typeof k === 'string');
            }

            // Load expression keywords, literals, deprecated from manifest
            if (Array.isArray(result.expressionKeywords)) {
                this._expressionKeywords = result.expressionKeywords.filter(k => typeof k === 'string');
            }
            if (Array.isArray(result.literals)) {
                this._literals = result.literals.filter(k => typeof k === 'string');
            }
            if (Array.isArray(result.deprecated)) {
                this._deprecated = result.deprecated.filter(d => d && d.name);
            }

            this._syncedFromBackend = true;
            this.logger?.info?.('symbol-registry', 'DSL builtins synced', {
                functions: this._builtinFunctions.size,
                constants: this._builtinConstants.size,
                keywords: this._builtinKeywords.length,
            });

            // Populate the shared ecolang_builtins store so that
            // language.js, autocomplete.js, and signature_help.js
            // all see the same manifest-derived data.
            populateBuiltins(result);

            this._notifyChange('builtins:synced');

            // Update ExpressionServices if linked
            this._updateExpressionServices();
        } catch (error) {
            this.logger?.error?.('symbol-registry', 'Failed to sync DSL builtins from backend', { error });
            throw error;
        }
    }

    /**
     * Update linked ExpressionServices with current builtins.
     * Converts SymbolRegistry format to ExpressionServices format.
     */
    _updateExpressionServices() {
        if (!this._expressionServices?.setBuiltins) return;

        try {
            const builtins = {
                functions: Array.from(this._builtinFunctions.values()).map(sym => ({
                    name: sym.name,
                    signature: sym.signature,
                    description: sym.description,
                })),
                constants: Array.from(this._builtinConstants.values()).map(sym => ({
                    name: sym.name,
                    description: sym.description,
                    value: null,
                })),
                keywords: [...this._builtinKeywords],
                expressionKeywords: [...this._expressionKeywords],
                literals: [...this._literals],
                deprecated: this._deprecated.map(d => ({ ...d })),
            };

            this._expressionServices.setBuiltins(builtins);
            this.logger?.debug?.('symbol-registry', 'Updated ExpressionServices builtins', {
                functions: builtins.functions.length,
                constants: builtins.constants.length,
            });
        } catch (error) {
            this.logger?.warn?.('symbol-registry', 'Failed to update ExpressionServices', { error });
        }
    }

    /**
     * Check if builtins have been synced from backend.
     * @returns {boolean}
     */
    isSynced() {
        return this._syncedFromBackend;
    }

    // =========================================================================
    // Symbol Creation Helpers
    // =========================================================================

    /**
     * @param {Object} fn - Function data from backend
     * @returns {Symbol}
     */
    _createBuiltinFunctionSymbol(fn) {
        return {
            id: `builtin:fn:${fn.name}`,
            name: fn.name,
            qualifiedName: fn.name,
            type: 'function',
            source: 'builtin',
            signature: fn.signature || `${fn.name}(...)`,
            description: fn.description || '',
            insertText: `${fn.name}(`,
            iconType: 'function',
            deprecated: false,
        };
    }

    /**
     * @param {Object} c - Constant data from backend
     * @returns {Symbol}
     */
    _createBuiltinConstantSymbol(c) {
        const desc = c.value !== null && c.value !== undefined
            ? `${c.description || c.name} = ${c.value}`
            : c.description || c.name;

        return {
            id: `builtin:const:${c.name}`,
            name: c.name,
            qualifiedName: c.name,
            type: 'constant',
            source: 'builtin',
            description: desc,
            insertText: c.name,
            iconType: 'constant',
            deprecated: false,
        };
    }

    /**
     * @param {Object} variable - Variable from DataManager
     * @param {string} namespaceId
     * @returns {Symbol}
     */
    _createVariableSymbol(variable, namespaceId) {
        const displayName = variable.displayName || variable.key;
        return {
            id: `workspace:var:${variable.id}`,
            name: variable.key,
            qualifiedName: variable.key,
            type: 'variable',
            source: 'workspace',
            namespaceId,
            description: displayName !== variable.key ? `Alias: ${displayName}` : '',
            valueType: variable.valueType || 'number',
            insertText: variable.key,
            iconType: 'variable',
            deprecated: false,
        };
    }

    /**
     * @param {Object} stock - Stock from DataManager
     * @param {string} namespaceId
     * @returns {Symbol}
     */
    _createStockSymbol(stock, namespaceId) {
        const literal = `${stock.sectorId}::${stock.accountType}[${stock.accountName}]`;
        return {
            id: `workspace:stock:${stock.id}`,
            name: literal,
            qualifiedName: literal,
            type: 'stock',
            source: 'workspace',
            namespaceId,
            description: stock.displayName || literal,
            insertText: literal,
            iconType: 'stock',
            deprecated: false,
        };
    }

    /**
     * @param {Object} fn - Function from ModuleRegistry
     * @param {string} moduleId
     * @param {string} [source='project'] - Module source (builtin, addon, project)
     * @returns {Symbol}
     */
    _createModuleFunctionSymbol(fn, moduleId, source = 'project') {
        const qualifiedName = `${moduleId}.${fn.name}`;
        const params = Array.isArray(fn.params) ? fn.params.join(', ') : '';
        return {
            id: `${source}:fn:${qualifiedName}`,
            name: fn.name,
            qualifiedName,
            type: 'function',
            source,
            moduleId,
            signature: fn.signature || `${fn.name}(${params})`,
            description: fn.description || `Function from ${moduleId}`,
            insertText: `${qualifiedName}(`,
            iconType: 'function',
            deprecated: false,
        };
    }

    /**
     * @param {Object} ns - Namespace from DataManager
     * @returns {Symbol}
     */
    _createNamespaceSymbol(ns) {
        const token = ns.displayName || ns.slug || ns.id.slice(0, 8);
        return {
            id: `workspace:ns:${ns.id}`,
            name: token,
            qualifiedName: token,
            type: 'namespace',
            source: 'workspace',
            namespaceId: ns.id,
            description: `Namespace: ${token}`,
            insertText: `${token}.`,
            iconType: 'namespace',
            deprecated: false,
        };
    }

    // =========================================================================
    // Unified Queries
    // =========================================================================

    /**
     * Get all symbols matching the filter options.
     * @param {FilterOptions} [options]
     * @returns {Symbol[]}
     */
    getAllSymbols(options = {}) {
        const symbols = [];

        // Collect from all sources
        symbols.push(...this._collectBuiltinSymbols(options));
        symbols.push(...this._collectWorkspaceSymbols(options));
        symbols.push(...this._collectModuleFunctionSymbols(options));

        // Apply filters
        return this._applyFilters(symbols, options);
    }

    /**
     * Get symbols by type.
     * @param {'function'|'constant'|'variable'|'stock'|'namespace'} type
     * @returns {Symbol[]}
     */
    getSymbolsByType(type) {
        return this.getAllSymbols({ types: [type] });
    }

    /**
     * Find a symbol by name.
     * @param {string} name - Symbol name (can be qualified like "Math.sin")
     * @param {Object} [options]
     * @param {string} [options.namespaceId] - Namespace context for resolution
     * @returns {Symbol|null}
     */
    findSymbol(name, options = {}) {
        const all = this.getAllSymbols();
        // Exact match on name or qualifiedName
        return all.find(s => s.name === name || s.qualifiedName === name) || null;
    }

    // =========================================================================
    // Type-Specific Queries
    // =========================================================================

    /**
     * Get built-in functions.
     * @returns {Symbol[]}
     */
    getBuiltinFunctions() {
        return Array.from(this._builtinFunctions.values());
    }

    /**
     * Get built-in constants.
     * @returns {Symbol[]}
     */
    getBuiltinConstants() {
        return Array.from(this._builtinConstants.values());
    }

    /**
     * Get DSL keywords (synced from backend).
     * Returns empty array if backend hasn't provided keywords yet.
     * @returns {string[]}
     */
    getKeywords() {
        return [...this._builtinKeywords];
    }

    /**
     * Get workspace variables.
     * @param {string} [namespaceId] - Filter by namespace
     * @returns {Symbol[]}
     */
    getVariables(namespaceId) {
        return this.getAllSymbols({
            types: ['variable'],
            namespaceId,
        });
    }

    /**
     * Get workspace stocks.
     * @param {string} [namespaceId] - Filter by namespace
     * @returns {Symbol[]}
     */
    getStocks(namespaceId) {
        return this.getAllSymbols({
            types: ['stock'],
            namespaceId,
        });
    }

    /**
     * Get user-defined functions.
     * @param {string} [moduleId] - Filter by module
     * @returns {Symbol[]}
     */
    getUserFunctions(moduleId) {
        return this.getAllSymbols({
            types: ['function'],
            source: 'project',
            moduleId,
        });
    }

    /**
     * Get namespaces.
     * @returns {Symbol[]}
     */
    getNamespaces() {
        return this.getAllSymbols({ types: ['namespace'] });
    }

    // =========================================================================
    // Autocomplete Support
    // =========================================================================

    /**
     * Build autocomplete entries for expression fields.
     * @param {Object} [options]
     * @param {string} [options.namespaceId] - Current namespace context
     * @param {boolean} [options.includeCrossNamespace] - Include other namespaces
     * @param {boolean} [options.includeBuiltins] - Include builtin functions/constants
     * @param {boolean} [options.includeUserFunctions] - Include user module functions
     * @param {boolean} [options.includeStocks] - Include stocks
     * @param {boolean} [options.includeNamespaces] - Include namespace tokens
     * @returns {Array<{label: string, insertText: string, type: string, description: string, iconType: string}>}
     */
    buildAutocompleteEntries(options = {}) {
        const {
            namespaceId = null,
            includeCrossNamespace = true,
            includeBuiltins = true,
            includeUserFunctions = true,
            includeStocks = true,
            includeNamespaces = false,
        } = options;

        const entries = [];
        const seen = new Set();

        // Add builtin functions and constants
        if (includeBuiltins) {
            for (const sym of this._builtinFunctions.values()) {
                if (seen.has(sym.name)) continue;
                seen.add(sym.name);
                entries.push(this._symbolToAutocompleteEntry(sym));
            }
            for (const sym of this._builtinConstants.values()) {
                if (seen.has(sym.name)) continue;
                seen.add(sym.name);
                entries.push(this._symbolToAutocompleteEntry(sym));
            }
        }

        // Add workspace variables
        if (this.dataManager?.listVariables) {
            const variables = this.dataManager.listVariables() || [];
            for (const v of variables) {
                if (!includeCrossNamespace && namespaceId && v.namespaceId !== namespaceId) continue;
                const sym = this._createVariableSymbol(v, v.namespaceId);
                if (seen.has(sym.name)) continue;
                seen.add(sym.name);
                entries.push(this._symbolToAutocompleteEntry(sym));
            }
        }

        // Add stocks
        if (includeStocks && this.dataManager?.listStocks) {
            const stocks = this.dataManager.listStocks() || [];
            for (const s of stocks) {
                if (!includeCrossNamespace && namespaceId && s.namespaceId !== namespaceId) continue;
                const sym = this._createStockSymbol(s, s.namespaceId);
                if (seen.has(sym.name)) continue;
                seen.add(sym.name);
                entries.push(this._symbolToAutocompleteEntry(sym));
            }
        }

        // Add functions from all modules (builtin, addon, project)
        if (includeUserFunctions && this.moduleRegistry) {
            const allModules = this.moduleRegistry.getAllModules?.() || new Map();
            for (const [moduleName, mod] of allModules) {
                const functions = mod.functions || {};
                for (const fn of Object.values(functions)) {
                    const sym = this._createModuleFunctionSymbol(fn, mod.name, mod.source);
                    if (seen.has(sym.qualifiedName)) continue;
                    seen.add(sym.qualifiedName);
                    entries.push(this._symbolToAutocompleteEntry(sym));
                }
            }
        }

        // Add namespaces
        if (includeNamespaces && this.dataManager?.listNamespaces) {
            const namespaces = this.dataManager.listNamespaces() || [];
            for (const ns of namespaces) {
                const sym = this._createNamespaceSymbol(ns);
                if (seen.has(sym.name)) continue;
                seen.add(sym.name);
                entries.push(this._symbolToAutocompleteEntry(sym));
            }
        }

        return entries;
    }

    /**
     * Convert symbol to autocomplete entry format.
     * @param {Symbol} sym
     * @returns {Object}
     */
    _symbolToAutocompleteEntry(sym) {
        return {
            label: sym.type === 'function' ? `${sym.qualifiedName}(` : sym.qualifiedName,
            insertText: sym.insertText,
            type: sym.type === 'function' ? 'fn' : sym.type,
            signature: sym.signature || '',
            description: sym.description || '',
            iconType: sym.iconType,
        };
    }

    // =========================================================================
    // Validation Helpers
    // =========================================================================

    /**
     * Check if an identifier is a valid/known symbol.
     * @param {string} name
     * @param {string} [namespaceId]
     * @returns {boolean}
     */
    isValidIdentifier(name, namespaceId) {
        const symbol = this.findSymbol(name, { namespaceId });
        return symbol !== null;
    }

    /**
     * Get all reserved names (builtins that can't be overwritten).
     * @returns {Set<string>}
     */
    getReservedNames() {
        const reserved = new Set();
        for (const sym of this._builtinFunctions.values()) {
            reserved.add(sym.name);
        }
        for (const sym of this._builtinConstants.values()) {
            reserved.add(sym.name);
        }
        return reserved;
    }

    // =========================================================================
    // Internal Collection Methods
    // =========================================================================

    _collectBuiltinSymbols(options) {
        const symbols = [];

        // Functions
        if (!options.types || options.types.includes('function')) {
            if (!options.source || options.source === 'builtin') {
                symbols.push(...this._builtinFunctions.values());
            }
        }

        // Constants
        if (!options.types || options.types.includes('constant')) {
            if (!options.source || options.source === 'builtin') {
                symbols.push(...this._builtinConstants.values());
            }
        }

        return symbols;
    }

    _collectWorkspaceSymbols(options) {
        const symbols = [];

        if (!this.dataManager) return symbols;
        if (options.source && options.source !== 'workspace') return symbols;

        // Variables
        if (!options.types || options.types.includes('variable')) {
            const variables = this.dataManager.listVariables?.() || [];
            for (const v of variables) {
                if (options.namespaceId && v.namespaceId !== options.namespaceId) continue;
                symbols.push(this._createVariableSymbol(v, v.namespaceId));
            }
        }

        // Stocks
        if (!options.types || options.types.includes('stock')) {
            const stocks = this.dataManager.listStocks?.() || [];
            for (const s of stocks) {
                if (options.namespaceId && s.namespaceId !== options.namespaceId) continue;
                symbols.push(this._createStockSymbol(s, s.namespaceId));
            }
        }

        // Namespaces
        if (!options.types || options.types.includes('namespace')) {
            const namespaces = this.dataManager.listNamespaces?.() || [];
            for (const ns of namespaces) {
                symbols.push(this._createNamespaceSymbol(ns));
            }
        }

        return symbols;
    }

    _collectModuleFunctionSymbols(options) {
        const symbols = [];

        if (!this.moduleRegistry) return symbols;
        if (options.types && !options.types.includes('function')) return symbols;

        const allModules = this.moduleRegistry.getAllModules?.() || new Map();
        for (const [moduleName, mod] of allModules) {
            // Filter by source if specified
            if (options.source) {
                // Map 'project' to module source, allow 'builtin' and 'addon' as well
                if (options.source !== mod.source) continue;
            }
            if (options.moduleId && mod.name !== options.moduleId) continue;

            const functions = mod.functions || {};
            for (const fn of Object.values(functions)) {
                symbols.push(this._createModuleFunctionSymbol(fn, mod.name, mod.source));
            }
        }

        return symbols;
    }

    _applyFilters(symbols, options) {
        let result = symbols;

        // Type filter
        if (options.types?.length > 0) {
            result = result.filter(s => options.types.includes(s.type));
        }

        // Source filter
        if (options.source) {
            result = result.filter(s => s.source === options.source);
        }

        // Namespace filter
        if (options.namespaceId) {
            result = result.filter(s => !s.namespaceId || s.namespaceId === options.namespaceId);
        }

        // Module filter
        if (options.moduleId) {
            result = result.filter(s => !s.moduleId || s.moduleId === options.moduleId);
        }

        // Text search
        if (options.search) {
            const search = options.search.toLowerCase();
            result = result.filter(s =>
                s.name.toLowerCase().includes(search) ||
                s.qualifiedName.toLowerCase().includes(search) ||
                (s.description || '').toLowerCase().includes(search)
            );
        }

        // Deprecated filter
        if (!options.includeDeprecated) {
            result = result.filter(s => !s.deprecated);
        }

        return result;
    }

    // =========================================================================
    // Event Subscriptions
    // =========================================================================

    _subscribeToChanges() {
        if (!this.eventBus) return;

        // Listen for data changes that affect symbols
        const events = [
            'data:variables:changed',
            'data:stocks:changed',
            'data:namespaces:changed',
            'modules:updated',
        ];

        for (const event of events) {
            this.eventBus.on?.(event, () => this._notifyChange(event));
        }
    }

    /**
     * Subscribe to symbol changes.
     * @param {'symbols:updated'} event
     * @param {Function} callback
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (event === 'symbols:updated') {
            this._listeners.push(callback);
            return () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            };
        }
        return () => {};
    }

    _notifyChange(reason) {
        for (const listener of this._listeners) {
            try {
                listener({ reason });
            } catch (err) {
                this.logger?.warn?.('symbol-registry', 'Listener error', { error: err });
            }
        }
    }

    // =========================================================================
    // Disposal
    // =========================================================================

    dispose() {
        this._listeners = [];
        this._builtinFunctions.clear();
        this._builtinConstants.clear();
        this._builtinKeywords = [];
        this._expressionKeywords = [];
        this._literals = [];
        this._deprecated = [];
        this._syncedFromBackend = false;
    }
}

// Singleton instance
let _symbolRegistry = null;

/**
 * Get or create the global SymbolRegistry instance.
 * @param {Object} [options] - Options for creating the registry
 * @returns {SymbolRegistry}
 */
export function getSymbolRegistry(options = {}) {
    if (!_symbolRegistry) {
        _symbolRegistry = new SymbolRegistry(options);
    }
    return _symbolRegistry;
}

/**
 * Reset the global SymbolRegistry (for testing).
 */
export function resetSymbolRegistry() {
    if (_symbolRegistry) {
        _symbolRegistry.dispose();
        _symbolRegistry = null;
    }
}

export default SymbolRegistry;
