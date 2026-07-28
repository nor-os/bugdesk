/**
 * Module Registry (js_new)
 *
 * Central registry for EcoSim function modules.
 * Provides module lookup, function resolution, and autocomplete entries
 * for the module system.
 *
 * Module sources:
 *   - builtin: Shipped with EcoSim (read-only)
 *   - addon: User-installed from external directories (read-only)
 *   - project: Embedded in project files (editable)
 */

import { ExpressionServices } from './expression_services.js';

/**
 * @typedef {Object} ModuleFunction
 * @property {string} name - Function name (unqualified)
 * @property {string[]} params - Parameter names
 * @property {string} expression - Function body expression (includes return statement)
 * @property {string} moduleName - Parent module name
 * @property {string} [signature] - Function signature for display
 * @property {string} [description] - Function documentation
 * @property {string[]|null} outputs - Derived output names from return statement
 * @property {string|null} returnType - 'single'|'tuple'|'record'|null
 */

/**
 * @typedef {Object} Module
 * @property {string} name - Module name
 * @property {string} source - 'builtin' | 'addon' | 'project'
 * @property {string} [description] - Module documentation
 * @property {Object.<string, ModuleFunction>} functions - Functions by name
 * @property {string[]} [exports] - Explicit exports (null = all)
 * @property {string[]} inputs - Module inputs (derived from function params)
 * @property {string[]} outputs - Module outputs (derived from function return statements)
 * @property {boolean} [readonly] - If true, module cannot be edited
 */

export class ModuleRegistry {
    /**
     * @param {Object} options
     * @param {Object} [options.dataManager] - DataManager for project modules
     * @param {Object} [options.logger] - Logger instance
     */
    constructor({ dataManager = null, logger = null } = {}) {
        this.dataManager = dataManager;
        this.logger = logger;

        /** @type {Map<string, Module>} */
        this._modules = new Map();

        /** @type {string[]} */
        this._loadOrder = [];

        // Initialize built-in modules
        this._initializeBuiltinModules();

        // Initialize default project module
        this._initializeDefaultProjectModule();
    }

    /**
     * Register a default empty project module for user functions.
     */
    _initializeDefaultProjectModule() {
        this.registerModule({
            name: 'UserFunctions',
            source: 'project',
            description: 'User-defined functions for this project',
            functions: {},
        });
    }

    /**
     * Register built-in function modules.
     *
     * NOTE: Built-in modules (Math, Smooth, Time, Statistics) have been removed.
     * All built-in functions are now accessed directly without namespace prefix
     * (e.g., use `pow(x, y)` not `Math.pow(x, y)`).
     *
     * This matches the Python backend which registers all functions as bare names
     * in function_registry.py. The single source of truth for builtin functions
     * is now ecolang_builtins.js.
     *
     * The ModuleRegistry is now only used for:
     * - User-defined project modules (UserFunctions)
     * - Addon modules loaded from external sources
     */
    _initializeBuiltinModules() {
        // No builtin modules - all functions are direct builtins in ecolang_builtins.js
        // This method is kept for potential future addon module initialization
    }

    /**
     * Register a module in the registry.
     * @param {Module} module
     */
    registerModule(module) {
        if (!module || !module.name) {
            this.logger?.warn?.('[ModuleRegistry] Cannot register module without name');
            return;
        }

        const existing = this._modules.get(module.name);

        // Project modules always win
        if (module.source === 'project') {
            this._modules.set(module.name, this._normalizeModule(module));
            if (!this._loadOrder.includes(module.name)) {
                this._loadOrder.push(module.name);
            }
            this.logger?.debug?.(`[ModuleRegistry] Registered project module: ${module.name}`);
            return;
        }

        // Don't override project modules with addon/builtin
        if (existing && existing.source === 'project') {
            this.logger?.debug?.(`[ModuleRegistry] Skipping ${module.source} module ${module.name} - project module exists`);
            return;
        }

        // Addon overrides builtin
        if (module.source === 'addon' || !existing) {
            this._modules.set(module.name, this._normalizeModule(module));
            if (!this._loadOrder.includes(module.name)) {
                this._loadOrder.push(module.name);
            }
            this.logger?.debug?.(`[ModuleRegistry] Registered ${module.source} module: ${module.name}`);
        }
    }

    /**
     * Normalize a module definition.
     * @param {Object} module
     * @returns {Module}
     */
    _normalizeModule(module) {
        const functions = {};
        const rawFunctions = module.functions || {};

        for (const [name, fn] of Object.entries(rawFunctions)) {
            const expression = fn.expression || '';
            const returnInfo = ExpressionServices.parseReturnStatement(expression);

            functions[name] = {
                name: fn.name || name,
                params: Array.isArray(fn.params) ? fn.params : [],
                expression,
                moduleName: module.name,
                signature: fn.signature || `${fn.name || name}(${(fn.params || []).join(', ')})`,
                description: fn.description || null,
                paramDescriptions: fn.paramDescriptions || null,
                outputDescriptions: fn.outputDescriptions || null,
                paramUnits: fn.paramUnits || null,
                outputs: returnInfo.outputs,
                returnType: returnInfo.type,
            };
        }

        // Derive inputs from function params (union of all params minus internal function names)
        const funcNames = new Set(Object.keys(functions));
        const allParams = new Map(); // preserves insertion order
        for (const fn of Object.values(functions)) {
            for (const p of fn.params) {
                if (!allParams.has(p)) allParams.set(p, true);
            }
        }
        const derivedInputs = [...allParams.keys()].filter((p) => !funcNames.has(p));

        // Derive outputs from function return statements.
        // Find first function with multi-output return (tuple/record).
        let derivedOutputs = null;
        for (const fn of Object.values(functions)) {
            if (fn.outputs !== null) {
                derivedOutputs = fn.outputs;
                break;
            }
        }
        if (derivedOutputs === null) {
            derivedOutputs = Object.keys(functions).filter((n) => !n.startsWith('__'));
        }

        return {
            name: module.name,
            source: module.source || 'project',
            description: module.description || null,
            functions,
            exports: module.exports || null,
            inputs: derivedInputs,
            outputs: derivedOutputs,
            readonly: Boolean(module.readonly),
        };
    }

    /**
     * Unregister a module by name.
     * @param {string} name
     * @returns {boolean}
     */
    unregisterModule(name) {
        if (this._modules.has(name)) {
            this._modules.delete(name);
            const idx = this._loadOrder.indexOf(name);
            if (idx >= 0) {
                this._loadOrder.splice(idx, 1);
            }
            return true;
        }
        return false;
    }

    /**
     * Get a module by name.
     * @param {string} name
     * @returns {Module|null}
     */
    getModule(name) {
        return this._modules.get(name) || null;
    }

    /**
     * Get a function by qualified name (ModuleName.functionName).
     * @param {string} qualifiedName
     * @returns {ModuleFunction|null}
     */
    getFunction(qualifiedName) {
        if (!qualifiedName || !qualifiedName.includes('.')) {
            return null;
        }
        const [moduleName, funcName] = qualifiedName.split('.', 2);
        const module = this._modules.get(moduleName);
        if (module) {
            return module.functions[funcName] || null;
        }
        return null;
    }

    /**
     * Resolve a function call like Module.func().
     * @param {string} moduleName
     * @param {string} funcName
     * @returns {ModuleFunction|null}
     */
    resolveFunctionCall(moduleName, funcName) {
        const module = this._modules.get(moduleName);
        if (module) {
            const exported = this.getExportedFunctions(moduleName);
            return exported[funcName] || null;
        }
        return null;
    }

    /**
     * Get exported functions from a module.
     * @param {string} moduleName
     * @returns {Object.<string, ModuleFunction>}
     */
    getExportedFunctions(moduleName) {
        const module = this._modules.get(moduleName);
        if (!module) {
            return {};
        }
        if (!module.exports) {
            return { ...module.functions };
        }
        const exported = {};
        for (const name of module.exports) {
            if (module.functions[name]) {
                exported[name] = module.functions[name];
            }
        }
        return exported;
    }

    /**
     * Get all registered modules.
     * @returns {Map<string, Module>}
     */
    getAllModules() {
        return new Map(this._modules);
    }

    /**
     * Get modules by source type.
     * @param {string} source - 'builtin' | 'addon' | 'project'
     * @returns {Module[]}
     */
    getModulesBySource(source) {
        return Array.from(this._modules.values()).filter((m) => m.source === source);
    }

    /**
     * Get all module names.
     * @returns {string[]}
     */
    getModuleNames() {
        return Array.from(this._modules.keys());
    }

    /**
     * List all modules with basic info.
     * @returns {Array<{name: string, source: string, description: string|null, functionCount: number}>}
     */
    listModules() {
        return Array.from(this._modules.values()).map((module) => ({
            name: module.name,
            source: module.source,
            description: module.description,
            functionCount: Object.keys(module.functions).length,
        }));
    }

    /**
     * Get all exported functions from all modules, fully qualified.
     * @returns {Object.<string, ModuleFunction>}
     */
    getAllExportedFunctions() {
        const result = {};
        for (const [moduleName, module] of this._modules) {
            const exported = this.getExportedFunctions(moduleName);
            for (const [funcName, func] of Object.entries(exported)) {
                const qualifiedName = `${moduleName}.${funcName}`;
                result[qualifiedName] = func;
            }
        }
        return result;
    }

    /**
     * Build autocomplete entries for specified modules.
     * @param {Object} options
     * @param {string[]} [options.moduleIds] - Module IDs to include (empty = all)
     * @returns {Array<{label: string, insertText: string, type: string, description: string}>}
     */
    buildAutocompleteEntries({ moduleIds = [] } = {}) {
        const entries = [];
        const seen = new Set();

        const modulesToInclude = moduleIds.length > 0
            ? moduleIds.map((id) => this._modules.get(id)).filter(Boolean)
            : Array.from(this._modules.values());

        for (const module of modulesToInclude) {
            const exported = this.getExportedFunctions(module.name);

            for (const [funcName, func] of Object.entries(exported)) {
                const qualifiedName = `${module.name}.${funcName}`;
                if (seen.has(qualifiedName)) continue;
                seen.add(qualifiedName);

                entries.push({
                    label: qualifiedName,
                    insertText: `${qualifiedName}(`,
                    type: 'function',
                    signature: func.signature,
                    description: func.description || `Function from ${module.name}`,
                    iconType: 'function',
                    metadata: {
                        moduleName: module.name,
                        functionName: funcName,
                        params: func.params,
                    },
                });
            }

        }

        return entries;
    }

    /**
     * Load project modules from workspace data.
     * @param {Array<Object>} modulesData
     * @returns {number} Number of modules loaded
     */
    loadProjectModules(modulesData) {
        // Clear previous project modules
        this.clearProjectModules();

        if (!Array.isArray(modulesData)) {
            return 0;
        }

        let loaded = 0;
        for (const modData of modulesData) {
            if (!modData || !modData.name) continue;

            const functions = {};
            for (const funcData of modData.functions || []) {
                if (!funcData.name) continue;

                let expression = funcData.expression || '';

                // Migration: old format had explicit outputs but no return statement
                const oldOutputs = funcData.outputs;
                if (Array.isArray(oldOutputs) && oldOutputs.length > 0) {
                    const parsed = ExpressionServices.parseReturnStatement(expression);
                    if (parsed.type === null) {
                        const retLine = `return (${oldOutputs.join(', ')})`;
                        expression = expression.trim() ? `${expression}\n${retLine}` : retLine;
                    }
                }

                functions[funcData.name] = {
                    name: funcData.name,
                    params: funcData.params || [],
                    outputs: funcData.outputs || [],
                    expression,
                    moduleName: modData.name,
                    signature: `${funcData.name}(${(funcData.params || []).join(', ')})`,
                    description: funcData.description || null,
                    paramDescriptions: funcData.paramDescriptions || null,
                    outputDescriptions: funcData.outputDescriptions || null,
                    paramUnits: funcData.paramUnits || null,
                };
            }

            this.registerModule({
                name: modData.name,
                source: 'project',
                description: modData.description || null,
                functions,
                exports: modData.exports || null,
            });
            loaded++;
        }

        this.logger?.info?.(`[ModuleRegistry] Loaded ${loaded} project modules`);
        return loaded;
    }

    /**
     * Clear all project-level modules.
     */
    clearProjectModules() {
        const toRemove = [];
        for (const [name, module] of this._modules) {
            if (module.source === 'project') {
                toRemove.push(name);
            }
        }
        for (const name of toRemove) {
            this.unregisterModule(name);
        }
        this.logger?.debug?.(`[ModuleRegistry] Cleared ${toRemove.length} project modules`);
    }

    /**
     * Clear all modules from the registry.
     */
    clearAll() {
        this._modules.clear();
        this._loadOrder = [];
        this.logger?.debug?.('[ModuleRegistry] Cleared all modules');
    }

    /**
     * Serialize project modules for persistence.
     * @returns {Array<Object>}
     */
    serializeProjectModules() {
        const projectModules = this.getModulesBySource('project');
        return projectModules.map((module) => ({
            name: module.name,
            description: module.description,
            functions: Object.values(module.functions).map((fn) => ({
                name: fn.name,
                params: fn.params,
                expression: fn.expression,
                description: fn.description,
                paramDescriptions: fn.paramDescriptions || null,
                outputDescriptions: fn.outputDescriptions || null,
                paramUnits: fn.paramUnits || null,
            })),
            exports: module.exports,
        }));
    }
}

// Global singleton instance
let _moduleRegistry = null;

/**
 * Get the global ModuleRegistry instance.
 * @param {Object} [options] - Options for creating the registry if it doesn't exist
 * @returns {ModuleRegistry}
 */
export function getModuleRegistry(options = {}) {
    if (!_moduleRegistry) {
        _moduleRegistry = new ModuleRegistry(options);
    }
    return _moduleRegistry;
}

/**
 * Reset the global ModuleRegistry (for testing).
 */
export function resetModuleRegistry() {
    _moduleRegistry = null;
}
