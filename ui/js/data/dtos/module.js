/**
 * Module DTO (js_new)
 *
 * Represents a project-level module for serialization.
 * Modules contain user-defined functions that can be used across the project.
 *
 * Fields:
 * - name: Module name (PascalCase)
 * - description: Optional module description
 * - functions: Array of ModuleFunctionDTO
 * - exports: Optional array of exported function names (null = export all)
 */

import {
    requireString,
    optionalString,
    optionalArray,
    freeze,
} from '../validators.js';
import { ExpressionServices } from '../../utils/expression_services.js';

/**
 * DTO for a single function within a module.
 *
 * Outputs are derived from the return statement in the function body —
 * never stored explicitly.
 */
export class ModuleFunctionDTO {
    constructor({
        name,
        params = [],
        expression,
        description = null,
        paramDescriptions = null,
        outputDescriptions = null,
        paramUnits = null,
    } = {}) {
        this.name = requireString(name, 'ModuleFunctionDTO.name');
        this.params = optionalArray(params, 'ModuleFunctionDTO.params') ?? [];
        this.expression = requireString(expression, 'ModuleFunctionDTO.expression');
        this.description = optionalString(description, 'ModuleFunctionDTO.description');
        this.paramDescriptions = paramDescriptions ? Object.freeze({ ...paramDescriptions }) : null;
        this.outputDescriptions = outputDescriptions ? Object.freeze({ ...outputDescriptions }) : null;
        this.paramUnits = paramUnits ? Object.freeze({ ...paramUnits }) : null;

        // Derive outputs and return type from the return statement
        const returnInfo = ExpressionServices.parseReturnStatement(this.expression);
        this.outputs = returnInfo.outputs;
        this.returnType = returnInfo.type;

        freeze(this);
    }

    /**
     * Create DTO from plain object.
     * Handles migration from old format where outputs were stored explicitly.
     * @param {Object} data
     * @returns {ModuleFunctionDTO}
     */
    static fromPlain(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('ModuleFunctionDTO.fromPlain requires an object');
        }

        let expression = data.expression || '';

        // Migration: old format had explicit outputs but no return statement
        const oldOutputs = data.outputs;
        if (Array.isArray(oldOutputs) && oldOutputs.length > 0) {
            const parsed = ExpressionServices.parseReturnStatement(expression);
            if (parsed.type === null) {
                const retLine = `return (${oldOutputs.join(', ')})`;
                expression = expression.trim() ? `${expression}\n${retLine}` : retLine;
            }
        }

        return new ModuleFunctionDTO({
            name: data.name,
            params: data.params,
            expression,
            description: data.description,
            paramDescriptions: data.paramDescriptions || null,
            outputDescriptions: data.outputDescriptions || null,
            paramUnits: data.paramUnits || null,
        });
    }

    /**
     * Convert to plain object for serialization.
     * Outputs are NOT serialized — they are derived from the return statement.
     * @returns {Object}
     */
    toPlain() {
        const plain = {
            name: this.name,
            params: [...this.params],
            expression: this.expression,
        };
        if (this.description) {
            plain.description = this.description;
        }
        if (this.paramDescriptions && Object.keys(this.paramDescriptions).length > 0) {
            plain.paramDescriptions = { ...this.paramDescriptions };
        }
        if (this.outputDescriptions && Object.keys(this.outputDescriptions).length > 0) {
            plain.outputDescriptions = { ...this.outputDescriptions };
        }
        if (this.paramUnits && Object.keys(this.paramUnits).length > 0) {
            plain.paramUnits = { ...this.paramUnits };
        }
        return plain;
    }
}

/**
 * DTO for a project-level module.
 *
 * Every module can be instantiated as a canvas node. Inputs and outputs are
 * derived from function signatures and return statements:
 * - inputs: union of all function params minus params matching internal function names
 * - outputs: derived from the entry function's return statement, falling back
 *   to public (non-__ prefixed) function names
 */
export class ModuleDTO {
    constructor({
        name,
        description = null,
        functions = [],
        exports = null,
    } = {}) {
        this.name = requireString(name, 'ModuleDTO.name');
        this.description = optionalString(description, 'ModuleDTO.description');
        this.functions = (optionalArray(functions, 'ModuleDTO.functions') ?? [])
            .map((fn) => fn instanceof ModuleFunctionDTO ? fn : ModuleFunctionDTO.fromPlain(fn));
        this.exports = exports === null ? null : (optionalArray(exports, 'ModuleDTO.exports') ?? null);

        // Derive inputs from function params
        const funcNames = new Set(this.functions.map((fn) => fn.name));
        const allParams = new Map();
        for (const fn of this.functions) {
            for (const p of fn.params) {
                if (!allParams.has(p)) allParams.set(p, true);
            }
        }
        this.inputs = [...allParams.keys()].filter((p) => !funcNames.has(p));

        // Derive outputs from function return statements.
        // Find first function with multi-output return (tuple/record).
        let derivedOutputs = null;
        for (const fn of this.functions) {
            if (fn.outputs !== null) {
                derivedOutputs = fn.outputs;
                break;
            }
        }
        if (derivedOutputs === null) {
            derivedOutputs = this.functions
                .filter((fn) => !fn.name.startsWith('__'))
                .map((fn) => fn.name);
        }
        this.outputs = derivedOutputs;

        freeze(this);
    }

    /**
     * Create DTO from plain object.
     * @param {Object} data
     * @returns {ModuleDTO}
     */
    static fromPlain(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('ModuleDTO.fromPlain requires an object');
        }
        return new ModuleDTO({
            name: data.name,
            description: data.description,
            functions: data.functions,
            exports: data.exports,
        });
    }

    /**
     * Convert to plain object for serialization.
     * Outputs are NOT serialized — they are derived from function return statements.
     * @returns {Object}
     */
    toPlain() {
        const plain = {
            name: this.name,
            functions: this.functions.map((fn) => fn.toPlain()),
        };
        if (this.description) {
            plain.description = this.description;
        }
        if (this.exports !== null) {
            plain.exports = [...this.exports];
        }
        return plain;
    }

    /**
     * Get function by name.
     * @param {string} funcName
     * @returns {ModuleFunctionDTO|null}
     */
    getFunction(funcName) {
        return this.functions.find((fn) => fn.name === funcName) ?? null;
    }

    /**
     * Check if a function is exported.
     * @param {string} funcName
     * @returns {boolean}
     */
    isExported(funcName) {
        if (this.exports === null) {
            // null means export all
            return true;
        }
        return this.exports.includes(funcName);
    }
}

export default ModuleDTO;
