/**
 * Expression Services (js_new)
 *
 * Purpose
 * -------
 * Provide deterministic helpers for expression validation, formatting, and autocomplete without
 * touching the DOM or legacy global registries. All symbol discovery flows through DataManager and
 * EcoLang built-ins synced from the Python backend via SymbolRegistry at startup.
 */

import { parseExpression } from '../units/expression_parser.js';
import { propagate } from '../units/unit_propagator.js';
import * as UnitEngine from '../units/unit_engine.js';

// Accepts simple identifiers and dotted paths (e.g. instance.output, Namespace.var)
const IDENTIFIER_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// Identifier extractor: matches dotted paths (Namespace.var, instance.output) and simple identifiers
const IDENTIFIER_EXTRACTOR = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/g;
const STOCK_LITERAL_PATTERN = /(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\[[^\]]+\]/g;
// Allow '=' for declarations, '#' for comments, '|' '<' '>' for match/when syntax,
// '"' and "'" for string literal parameters (e.g. mode="linear")
const ILLEGAL_CHAR_PATTERN = /[^\sA-Za-z0-9_=#()+\-*/^,.:\[\]|<>"']/;
const AUTOCOMPLETE_OPERATORS = Object.freeze([
    { label: '+', insertText: ' + ', type: 'operator', description: 'Addition' },
    { label: '-', insertText: ' - ', type: 'operator', description: 'Subtraction' },
    { label: '*', insertText: ' * ', type: 'operator', description: 'Multiplication' },
    { label: '/', insertText: ' / ', type: 'operator', description: 'Division' },
    { label: '^', insertText: '^', type: 'operator', description: 'Exponentiation' },
    { label: '(', insertText: '(', type: 'operator', description: 'Open parenthesis' },
    { label: ')', insertText: ')', type: 'operator', description: 'Close parenthesis' },
    { label: ',', insertText: ', ', type: 'operator', description: 'Argument separator' },
]);
const STOCK_SNIPPET_ENTRY = Object.freeze({
    label: 'Sector::Type[Account]',
    insertText: 'Sector::Type[Account]',
    type: 'snippet',
    description: 'Stock variable reference literal',
    iconType: 'stock',
});

export class ExpressionServices {
    constructor({ dataManager, logger = null, builtins = null, moduleRegistry = null } = {}) {
        if (!dataManager) {
            throw new Error('ExpressionServices requires a dataManager instance');
        }
        this.dataManager = dataManager;
        this.logger = logger;
        this.moduleRegistry = moduleRegistry;
        // Builtins are synced from backend via SymbolRegistry.linkExpressionServices()
        this.setBuiltins(builtins);
    }

    setBuiltins(builtins) {
        this.builtins = ExpressionServices.#normalizeBuiltins(builtins);
    }

    setModuleRegistry(moduleRegistry) {
        this.moduleRegistry = moduleRegistry;
    }

    getBuiltins() {
        return {
            functions: this.builtins.functions.map((fn) => ({ ...fn })),
            constants: this.builtins.constants.map((constant) => ({ ...constant })),
            deprecated: this.builtins.deprecated.map((entry) => ({ ...entry })),
            keywords: [...this.builtins.keywords],
            expressionKeywords: [...this.builtins.expressionKeywords],
            literals: [...this.builtins.literals],
        };
    }

    collectSymbols({
        namespaceId = null,
        includeCrossNamespace = true,
        includeDisplayNames = true,
        includeStocks = true,
    } = {}) {
        const namespaceIndex = this.#buildNamespaceIndex();
        const variableMetadata = this.#collectVariableMetadata({
            namespaceId,
            namespaceIndex,
            includeCrossNamespace,
            includeDisplayNames,
        });
        const stocks = includeStocks ? this.#collectStockMetadata(namespaceId) : [];

        return {
            namespaceId,
            localVariables: variableMetadata.localVariables,
            qualifiedVariables: variableMetadata.qualifiedVariables,
            stocks,
            builtins: this.getBuiltins(),
        };
    }

    buildAutocompleteEntries({
        namespaceId = null,
        includeCrossNamespace = true,
        includeDisplayNames = true,
        includeStocks = true,
        includeOperators = true,
        includeSnippets = true,
        includeConstants = true,
        includeNamespaces = false,
        includeModuleFunctions = true,
    } = {}) {
        const namespaceIndex = this.#buildNamespaceIndex();
        const symbols = this.collectSymbols({
            namespaceId,
            includeCrossNamespace,
            includeDisplayNames,
            includeStocks,
        });
        const entries = [];
        const seen = new Set();
        const pushEntry = (entry) => {
            if (!entry || !entry.label) {
                return;
            }
            const key = `${entry.type || 'value'}:${entry.label}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            entries.push(entry);
        };

        symbols.localVariables.forEach((variable) => {
            // Build a helpful description from available metadata
            const parts = [];
            if (variable.valueType) parts.push(variable.valueType);
            if (variable.namespaceName) parts.push(`in ${variable.namespaceName}`);
            const desc = parts.length > 0 ? parts.join(' ') : '';
            pushEntry({
                label: variable.name,
                insertText: variable.name,
                type: 'variable',
                iconType: variable.alias ? 'alias' : 'variable',
                description: desc,
                metadata: { ...variable },
            });
        });

        symbols.qualifiedVariables.forEach((variable) => {
            // Build a helpful description from available metadata
            const parts = [];
            if (variable.valueType) parts.push(variable.valueType);
            if (variable.namespaceName) parts.push(`from ${variable.namespaceName}`);
            const desc = parts.length > 0 ? parts.join(' ') : '';
            pushEntry({
                label: variable.name,
                insertText: variable.name,
                type: 'variable',
                iconType: 'variable-qualified',
                description: desc,
                metadata: { ...variable },
            });
        });

        if (includeStocks) {
            symbols.stocks.forEach((stock) => {
                pushEntry({
                    label: stock.literal,
                    insertText: stock.literal,
                    type: 'stock',
                    iconType: 'stock',
                    metadata: { ...stock },
                });
            });
        }

        // Add namespace names for cross-namespace references (e.g., "Main.")
        if (includeNamespaces) {
            namespaceIndex.forEach((ns, nsId) => {
                // Skip current namespace - user doesn't need to qualify local variables
                if (nsId === namespaceId) return;
                const token = ns.token;
                if (token) {
                    pushEntry({
                        label: `${token}.`,
                        insertText: `${token}.`,
                        type: 'namespace',
                        iconType: 'namespace',
                        description: `Variables from ${ns.displayName || ns.name}`,
                        metadata: { namespaceId: nsId, namespaceName: ns.name },
                    });
                }
            });
        }

        this.builtins.functions.forEach((fn) => {
            // Always add '(' for functions to trigger signature help
            const insertText = `${fn.name}(`;
            pushEntry({
                label: insertText,
                insertText,
                type: 'fn',
                signature: fn.signature ?? null,
                description: fn.description ?? null,
                iconType: 'function',
            });
        });

        // Add module functions (from ModuleRegistry - builtin, addon, project)
        if (includeModuleFunctions && this.moduleRegistry) {
            const allModules = this.moduleRegistry.getAllModules?.() || new Map();
            for (const [moduleName, mod] of allModules) {
                const exported = this.moduleRegistry.getExportedFunctions?.(moduleName) || {};
                for (const [funcName, fn] of Object.entries(exported)) {
                    const qualifiedName = `${moduleName}.${funcName}`;
                    const insertText = `${qualifiedName}(`;
                    pushEntry({
                        label: insertText,
                        insertText,
                        type: 'fn',
                        signature: fn.signature ?? `${funcName}(${(fn.params || []).join(', ')})`,
                        description: fn.description ?? `Function from ${moduleName}`,
                        iconType: 'function',
                        metadata: {
                            moduleName,
                            functionName: funcName,
                            params: fn.params,
                            source: mod.source,
                        },
                    });
                }
            }
        }

        if (includeConstants) {
            const constantDescriptions = new Map(
                this.builtins.constants.map((constant) => [constant.name, constant.description ?? '']),
            );
            const constants = new Set(constantDescriptions.keys());
            constants.forEach((name) => {
                pushEntry({
                    label: name,
                    insertText: name,
                    type: 'constant',
                    description: constantDescriptions.get(name) ?? '',
                    iconType: 'constant',
                });
            });
        }

        if (includeOperators) {
            AUTOCOMPLETE_OPERATORS.forEach((entry) => pushEntry({ ...entry }));
        }

        if (includeSnippets) {
            pushEntry({ ...STOCK_SNIPPET_ENTRY });
        }

        // Add DSL keywords (return, match, let, lambda, etc.)
        this.builtins.keywords.forEach((keyword) => {
            pushEntry({
                label: keyword,
                insertText: keyword,
                type: 'keyword',
                iconType: 'keyword',
                description: 'keyword',
            });
        });

        return entries;
    }

    formatExpression(expression, { collapseWhitespace = true, trim = true } = {}) {
        let normalized = ExpressionServices.#coerceExpression(expression);
        if (collapseWhitespace && normalized) {
            normalized = normalized.replace(/\s+/g, ' ');
        }
        if (trim) {
            normalized = normalized.trim();
        }
        return normalized;
    }

    validate(expression, {
        namespaceId = null,
        allowedNames = null,
        extraAllowed = null,
        restrictToAllowed = false,
        includeCrossNamespace = true,
        includeAllowedSnapshot = false,
        allowDeclarations = false,
        unknownAsWarnings = false,
        reservedNamesAdditional = null,
    } = {}) {
        const errors = [];
        const warnings = [];
        const raw = ExpressionServices.#coerceExpression(expression);
        const tokens = {
            identifiers: [],
            stockLiterals: ExpressionServices.#extractStockLiterals(raw),
        };

        if (!raw) {
            return {
                expression: '',
                normalized: '',
                errors,
                warnings,
                unknown: [],
                tokens,
                isValid: true,
                ...(includeAllowedSnapshot ? { allowedNames: [] } : {}),
            };
        }

        // Fast path: pure numeric expressions (e.g., "1/2", "3.14", "2^3") are always valid
        // These contain only digits, operators, parentheses, and whitespace - no identifiers
        if (ExpressionServices.#isPureNumericExpression(raw)) {
            // Still check for balanced delimiters and basic operator issues
            const quickErrors = [];
            if (!ExpressionServices.#balancedDelimiters(raw)) {
                quickErrors.push('Unbalanced parentheses or brackets');
            }
            ExpressionServices.#detectOperatorIssues(raw).forEach((msg) => quickErrors.push(msg));
            ExpressionServices.#detectSemanticIssues(raw).forEach((msg) => quickErrors.push(msg));

            return {
                expression: raw,
                normalized: raw,
                errors: quickErrors,
                warnings,
                unknown: [],
                tokens,
                isValid: quickErrors.length === 0,
                ...(includeAllowedSnapshot ? { allowedNames: [] } : {}),
            };
        }

        const allowed = this.#resolveAllowedNamesSet({
            namespaceId,
            allowedNames,
            extraAllowed,
            restrictToAllowed,
            includeCrossNamespace,
        });
        const reserved = this.#buildReservedNamesSet(reservedNamesAdditional);
        const declared = allowDeclarations
            ? ExpressionServices.#detectDeclarations(raw)
            : new Set();

        // Prevent declarations of reserved names
        declared.forEach((name) => {
            if (reserved.has(name)) {
                errors.push(`Reserved name cannot be declared: ${name}`);
                declared.delete(name);
            }
        });

        // Add declared locals to the allowed set so they do not trigger "unknown" warnings
        declared.forEach((name) => allowed.add(name));
        const unknown = new Set();

        if (ILLEGAL_CHAR_PATTERN.test(raw)) {
            errors.push('Expression contains invalid characters');
        }
        if (!ExpressionServices.#balancedDelimiters(raw)) {
            errors.push('Unbalanced parentheses or brackets');
        }

        const stripped = ExpressionServices.#stripStockLiterals(raw);
        const clean = ExpressionServices.#stripDifferentialNotation(stripped);
        ExpressionServices.#detectDeprecatedFunctions(clean, this.builtins.deprecated).forEach((msg) => errors.push(msg));

        const identifiers = ExpressionServices.#tokenizeIdentifiers(clean);
        tokens.identifiers = identifiers;
        identifiers.forEach((identifier) => {
            if (identifier === 'STOCK_LITERAL') {
                return;
            }
            if (this.builtins.keywords.includes(identifier.toLowerCase()) ||
                this.builtins.expressionKeywords.includes(identifier.toLowerCase())) {
                return;
            }
            if (!allowed.has(identifier)) {
                unknown.add(identifier);
            }
        });

        // Check for self-qualified references: if X.Y is unknown but Y is allowed
        // AND X is a namespace name, the user is unnecessarily qualifying a local variable.
        // Skip when X is a module instance name (e.g. pol.ppolx, industrial.output).
        const nsTokens = new Set();
        for (const desc of this.#buildNamespaceIndex().values()) {
            if (desc.token) nsTokens.add(desc.token);
        }
        for (const name of unknown) {
            const dotIndex = name.indexOf('.');
            if (dotIndex > 0) {
                const prefix = name.slice(0, dotIndex);
                const bareName = name.slice(dotIndex + 1);
                if (nsTokens.has(prefix) && (allowed.has(bareName) || declared.has(bareName))) {
                    warnings.push(`Unnecessary namespace qualifier: use '${bareName}' instead of '${name}'`);
                    unknown.delete(name);
                }
            }
        }

        if (unknown.size && !unknownAsWarnings) {
            errors.push(`Unknown names: ${Array.from(unknown).join(', ')}`);
        }

        ExpressionServices.#detectOperatorIssues(clean).forEach((msg) => errors.push(msg));
        ExpressionServices.#detectSemanticIssues(clean).forEach((msg) => errors.push(msg));

        // Detect unreachable code after return statement (multiline expressions)
        ExpressionServices.#detectUnreachableCode(raw).forEach((msg) => warnings.push(msg));

        return {
            expression: raw,
            normalized: clean,
            errors,
            warnings,
            unknown: Array.from(unknown),
            tokens,
            isValid: errors.length === 0,
            ...(includeAllowedSnapshot ? { allowedNames: Array.from(allowed) } : {}),
        };
    }

    /**
     * Check units/dimensions in an expression.
     * Returns diagnostics (warnings only — units are advisory, never blocking).
     *
     * @param {string} expression
     * @param {{ namespaceId?: string, manifest?: Object }} options
     * @returns {{ unit: Object|null, diagnostics: Array<{ message: string, severity: string }> }}
     */
    checkUnits(expression, { namespaceId = null, manifest = null } = {}) {
        const raw = ExpressionServices.#coerceExpression(expression);
        if (!raw) {
            return { unit: null, diagnostics: [] };
        }

        const ast = parseExpression(raw);

        const resolveVariable = (name) => {
            // Look up the variable in DataManager to find its unit
            if (!this.dataManager?.listVariables) return null;

            const variables = this.dataManager.listVariables();
            // Try exact key match first (local namespace)
            for (const v of variables) {
                if (!v) continue;
                const isLocal = !namespaceId || v.namespaceId === namespaceId;
                if (isLocal && (v.key === name || v.displayName === name)) {
                    return v.unit ? UnitEngine.parse(v.unit) : null;
                }
            }
            // Try qualified name (Namespace.var)
            for (const v of variables) {
                if (!v) continue;
                const ns = v.namespaceId;
                if (ns && (name === `${ns}.${v.key}` || name === `${ns}.${v.displayName}`)) {
                    return v.unit ? UnitEngine.parse(v.unit) : null;
                }
            }
            // Try stock lookup
            if (this.dataManager.listStocks) {
                const stocks = this.dataManager.listStocks();
                for (const s of stocks) {
                    if (!s) continue;
                    const literal = `${s.sectorId}::${s.accountType}[${s.accountName}]`;
                    if (name === literal) {
                        return s.unit ? UnitEngine.parse(s.unit) : null;
                    }
                }
            }
            return null;
        };

        return propagate(ast, { resolveVariable, manifest });
    }

    #collectVariableMetadata({
        namespaceId,
        namespaceIndex,
        includeCrossNamespace,
        includeDisplayNames,
    }) {
        const variables = typeof this.dataManager.listVariables === 'function'
            ? this.dataManager.listVariables()
            : [];

        const localVariables = [];
        const qualifiedVariables = [];
        const seenLocal = new Set();
        const seenQualified = new Set();

        // Normalize namespace ID for case-insensitive matching
        const normalizedNsId = namespaceId?.toLowerCase?.() ?? null;

        variables.forEach((variable) => {
            if (!variable || typeof variable !== 'object') {
                return;
            }
            // Skip variables that are stock-bound (they appear as stocks instead)
            if (variable.bindings?.sourceType === 'stock') {
                return;
            }
            const canonical = ExpressionServices.#normalizeIdentifierToken(variable.key);
            if (!canonical) {
                return;
            }
            const nsDescriptor = namespaceIndex.get(variable.namespaceId) ?? null;
            // Match namespace case-insensitively, or include all if no namespace specified
            const varNsNormalized = variable.namespaceId?.toLowerCase?.() ?? '';
            const isLocal = !normalizedNsId || varNsNormalized === normalizedNsId;

            if (isLocal && !seenLocal.has(canonical)) {
                localVariables.push(ExpressionServices.#toVariableEntry(variable, nsDescriptor, canonical, { qualified: false }));
                seenLocal.add(canonical);
            }

            if (includeDisplayNames && isLocal && variable.displayName) {
                const alias = ExpressionServices.#normalizeIdentifierToken(variable.displayName);
                if (alias && !seenLocal.has(alias)) {
                    localVariables.push(ExpressionServices.#toVariableEntry(variable, nsDescriptor, alias, { qualified: false, alias: true }));
                    seenLocal.add(alias);
                }
            }

            // Only add cross-namespace variables with their qualified names
            // Local variables are already accessible by their unqualified names
            if (includeCrossNamespace && !isLocal) {
                const qualifiedName = ExpressionServices.#buildQualifiedName(nsDescriptor, canonical);
                if (qualifiedName && !seenQualified.has(qualifiedName)) {
                    qualifiedVariables.push(ExpressionServices.#toVariableEntry(variable, nsDescriptor, qualifiedName, { qualified: true }));
                    seenQualified.add(qualifiedName);
                }
            }
        });

        return { localVariables, qualifiedVariables };
    }

    #collectStockMetadata(namespaceId) {
        if (typeof this.dataManager.listStocks !== 'function') {
            return [];
        }
        const stocks = this.dataManager.listStocks((stock) => !namespaceId || stock.namespaceId === namespaceId);
        return stocks
            .map((stock) => {
                const literal = ExpressionServices.#formatStockLiteral(stock);
                if (!literal) {
                    return null;
                }
                return {
                    literal,
                    stockId: stock.id,
                    namespaceId: stock.namespaceId,
                    sectorId: stock.sectorId,
                    accountType: stock.accountType,
                    accountName: stock.accountName,
                    displayName: stock.displayName ?? null,
                    metadata: stock.metadata ?? {},
                };
            })
            .filter(Boolean);
    }

    #buildNamespaceIndex() {
        const namespaces = typeof this.dataManager.listNamespaces === 'function'
            ? this.dataManager.listNamespaces()
            : [];
        const index = new Map();
        namespaces.forEach((ns) => {
            if (!ns || !ns.id) {
                return;
            }
            const descriptor = {
                id: ns.id,
                name: ns.displayName || ns.slug || ns.id,
                displayName: ns.displayName || null,
                slug: ns.slug || null,
            };
            descriptor.token = ExpressionServices.#resolveNamespaceToken(descriptor);
            index.set(ns.id, descriptor);
        });
        return index;
    }

    #resolveAllowedNamesSet({
        namespaceId,
        allowedNames,
        extraAllowed,
        restrictToAllowed,
        includeCrossNamespace,
    }) {
        const names = new Set();
        ExpressionServices.#ingestNames(names, allowedNames);
        ExpressionServices.#ingestNames(names, extraAllowed);

        if (!restrictToAllowed) {
            // When not restricted, add all local and cross-namespace variables
            this.#collectVariableNames(namespaceId, { includeCrossNamespace }).forEach((name) => names.add(name));
        } else if (includeCrossNamespace) {
            // When restricted to allowed names, still allow cross-namespace qualified references
            // (e.g., "Lorentz.beta") since these are explicit references to other namespaces.
            // Only local unqualified names are restricted.
            this.#collectCrossNamespaceNames(namespaceId).forEach((name) => names.add(name));
        }

        this.builtins.functions.forEach((fn) => names.add(fn.name));
        this.builtins.constants.forEach((constant) => names.add(constant.name));
        this.builtins.keywords.forEach((keyword) => names.add(keyword));
        this.builtins.expressionKeywords.forEach((kw) => names.add(kw));
        this.builtins.literals.forEach((lit) => names.add(lit));
        names.add('STOCK_LITERAL');

        // Add module functions (both qualified and unqualified names)
        if (this.moduleRegistry) {
            const allModules = this.moduleRegistry.getAllModules?.() || new Map();
            for (const [moduleName, mod] of allModules) {
                // Add module name as valid identifier for qualified access
                names.add(moduleName);
                const exported = this.moduleRegistry.getExportedFunctions?.(moduleName) || {};
                for (const funcName of Object.keys(exported)) {
                    // Add qualified name (e.g., Demographics.maturation)
                    names.add(`${moduleName}.${funcName}`);
                    // Add unqualified name (e.g., maturation) for imported functions
                    names.add(funcName);
                }
            }
        }

        return names;
    }

    #collectVariableNames(namespaceId, { includeCrossNamespace = true } = {}) {
        const namespaceIndex = this.#buildNamespaceIndex();
        const variables = typeof this.dataManager.listVariables === 'function'
            ? this.dataManager.listVariables()
            : [];
        const names = new Set();

        // Normalize namespace ID for case-insensitive matching
        const normalizedNsId = namespaceId?.toLowerCase?.() ?? null;

        variables.forEach((variable) => {
            if (!variable || typeof variable !== 'object') {
                return;
            }
            const canonical = ExpressionServices.#normalizeIdentifierToken(variable.key);
            if (!canonical) {
                return;
            }
            const nsDescriptor = namespaceIndex.get(variable.namespaceId) ?? null;
            // Match namespace case-insensitively
            const varNsNormalized = variable.namespaceId?.toLowerCase?.() ?? '';
            const isLocal = !normalizedNsId || varNsNormalized === normalizedNsId;

            if (isLocal) {
                names.add(canonical);
                if (variable.displayName) {
                    const alias = ExpressionServices.#normalizeIdentifierToken(variable.displayName);
                    if (alias) {
                        names.add(alias);
                    }
                }
            }

            if (includeCrossNamespace) {
                // Add qualified canonical name (e.g., Main.variable_key)
                const qualified = ExpressionServices.#buildQualifiedName(nsDescriptor, canonical);
                if (qualified) {
                    names.add(qualified);
                }
                // Add qualified display name (e.g., Main.text when displayName is "text")
                if (variable.displayName) {
                    const alias = ExpressionServices.#normalizeIdentifierToken(variable.displayName);
                    if (alias) {
                        const qualifiedAlias = ExpressionServices.#buildQualifiedName(nsDescriptor, alias);
                        if (qualifiedAlias) {
                            names.add(qualifiedAlias);
                        }
                    }
                }
                // Also add the namespace token itself so "Main" in "Main.x" is recognized
                if (nsDescriptor?.token) {
                    names.add(nsDescriptor.token);
                }
            }
        });

        // Add all namespace tokens as valid identifiers (for qualified name prefixes)
        namespaceIndex.forEach((ns) => {
            if (ns.token) {
                names.add(ns.token);
            }
        });

        return names;
    }

    /**
     * Collect only cross-namespace qualified names and namespace tokens.
     * Used when restrictToAllowed is true but we still want to allow explicit
     * cross-namespace references like "Lorentz.beta".
     */
    #collectCrossNamespaceNames(currentNamespaceId) {
        const namespaceIndex = this.#buildNamespaceIndex();
        const variables = typeof this.dataManager.listVariables === 'function'
            ? this.dataManager.listVariables()
            : [];
        const names = new Set();

        // Normalize current namespace ID for comparison
        const normalizedCurrentNsId = currentNamespaceId?.toLowerCase?.() ?? null;

        variables.forEach((variable) => {
            if (!variable || typeof variable !== 'object') {
                return;
            }
            const canonical = ExpressionServices.#normalizeIdentifierToken(variable.key);
            if (!canonical) {
                return;
            }
            const nsDescriptor = namespaceIndex.get(variable.namespaceId) ?? null;
            const varNsNormalized = variable.namespaceId?.toLowerCase?.() ?? '';

            // Only add qualified names for variables NOT in current namespace
            const isLocal = normalizedCurrentNsId && varNsNormalized === normalizedCurrentNsId;
            if (!isLocal) {
                // Add qualified canonical name (e.g., Lorentz.beta)
                const qualified = ExpressionServices.#buildQualifiedName(nsDescriptor, canonical);
                if (qualified) {
                    names.add(qualified);
                }
                // Add qualified display name if available
                if (variable.displayName) {
                    const alias = ExpressionServices.#normalizeIdentifierToken(variable.displayName);
                    if (alias) {
                        const qualifiedAlias = ExpressionServices.#buildQualifiedName(nsDescriptor, alias);
                        if (qualifiedAlias) {
                            names.add(qualifiedAlias);
                        }
                    }
                }
            }
        });

        // Add all namespace tokens as valid identifiers (for qualified name prefixes)
        namespaceIndex.forEach((ns) => {
            if (ns.token) {
                names.add(ns.token);
            }
        });

        return names;
    }

    #buildReservedNamesSet(additional = null) {
        const reserved = new Set();
        this.builtins.functions.forEach((fn) => reserved.add(fn.name));
        this.builtins.constants.forEach((c) => reserved.add(c.name));
        this.builtins.keywords.forEach((k) => reserved.add(k));
        if (Array.isArray(additional)) {
            additional.forEach((name) => {
                if (name) reserved.add(ExpressionServices.#normalizeIdentifierToken(name));
            });
        }
        return reserved;
    }

    static #detectDeclarations(raw) {
        const declared = new Set();
        if (!raw) return declared;
        // Handle both \n and \r\n line endings, and also handle semicolon separators
        const lines = raw.split(/[\r\n;]+/);
        lines.forEach((line) => {
            // Match assignment: identifier = ...
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            if (match) {
                const name = ExpressionServices.#normalizeIdentifierToken(match[1]);
                if (name) {
                    declared.add(name);
                }
            }
        });
        return declared;
    }

    static #normalizeIdentifierToken(value) {
        if (!value || typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        if (!IDENTIFIER_TOKEN.test(trimmed)) {
            return null;
        }
        return trimmed;
    }

    static #toVariableEntry(variable, namespaceDescriptor, name, { qualified = false, alias = false } = {}) {
        return {
            name,
            variableId: variable.id,
            namespaceId: variable.namespaceId,
            namespaceName: namespaceDescriptor?.name ?? null,
            namespaceToken: namespaceDescriptor?.token ?? null,
            nodeId: variable.nodeId ?? null,
            valueType: variable.valueType ?? null,
            dataType: variable.dataType ?? null,
            qualified,
            alias,
        };
    }

    static #formatStockLiteral(stock) {
        if (!stock) {
            return null;
        }
        const sector = typeof stock.sectorId === 'string' ? stock.sectorId.trim() : '';
        const accountType = typeof stock.accountType === 'string' ? stock.accountType.trim() : '';
        const accountName = typeof stock.accountName === 'string' ? stock.accountName.trim() : '';
        if (!sector || !accountType || !accountName) {
            return null;
        }
        return `${sector}::${accountType}[${accountName}]`;
    }

    static #resolveNamespaceToken(namespace) {
        if (!namespace) {
            return null;
        }
        const candidates = [namespace.slug, namespace.displayName, namespace.name];
        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }
            if (IDENTIFIER_TOKEN.test(candidate)) {
                return candidate;
            }
            const sanitized = ExpressionServices.#sanitizeNamespaceCandidate(candidate);
            if (IDENTIFIER_TOKEN.test(sanitized)) {
                return sanitized;
            }
        }
        return null;
    }

    static #sanitizeNamespaceCandidate(value) {
        const source = typeof value === 'string' ? value : String(value ?? '');
        const trimmed = source.trim();
        if (!trimmed) {
            return '';
        }
        let sanitized = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_]/.test(sanitized)) {
            sanitized = `N_${sanitized}`;
        }
        return sanitized;
    }

    static #buildQualifiedName(namespaceDescriptor, identifier) {
        if (!namespaceDescriptor || !identifier) {
            return null;
        }
        const token = namespaceDescriptor.token;
        if (!token) {
            return null;
        }
        return `${token}.${identifier}`;
    }

    static #ingestNames(target, source) {
        if (!source) {
            return;
        }
        if (typeof source === 'string') {
            target.add(source);
            return;
        }
        const iterable = Array.isArray(source) || source instanceof Set ? source : [];
        iterable.forEach((value) => {
            if (typeof value === 'string' && value.trim()) {
                target.add(value.trim());
            }
        });
    }

    static #coerceExpression(expression) {
        if (expression === null || expression === undefined) {
            return '';
        }
        return typeof expression === 'string' ? expression.trim() : String(expression).trim();
    }

    static #stripStockLiterals(text) {
        if (!text) {
            return '';
        }
        return text.replace(STOCK_LITERAL_PATTERN, 'STOCK_LITERAL');
    }

    static #stripDifferentialNotation(text) {
        if (!text) {
            return '';
        }
        // d(something)/dt -> something (unwrap differential wrapper so d and dt aren't tokenized)
        return text.replace(/\bd\s*\(\s*([^)]*?)\s*\)\s*\/\s*dt\b/gi, '$1');
    }

    static #extractStockLiterals(text) {
        if (!text) {
            return [];
        }
        return (text.match(STOCK_LITERAL_PATTERN) || []).map((literal) => literal.trim()).filter(Boolean);
    }

    static #balancedDelimiters(text) {
        const stack = [];
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (char === '(' || char === '[') {
                stack.push(char);
            } else if (char === ')' || char === ']') {
                const match = stack.pop();
                if ((char === ')' && match !== '(') || (char === ']' && match !== '[')) {
                    return false;
                }
            }
        }
        return stack.length === 0;
    }

    static #tokenizeIdentifiers(text) {
        if (!text) {
            return [];
        }
        // Strip string literals so their contents aren't tokenized as identifiers.
        // e.g. mode="linear" → mode= (and "linear" is removed)
        const cleaned = text.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
        const results = [];
        const matcher = cleaned.matchAll(IDENTIFIER_EXTRACTOR);
        for (const match of matcher) {
            if (match && match[0]) {
                // Skip named parameters: identifier followed by = (but not ==)
                // e.g. in BufferStockConsumption(expected_income=value), skip "expected_income"
                const afterIdx = match.index + match[0].length;
                const rest = text.slice(afterIdx).trimStart();
                if (rest.startsWith('=') && !rest.startsWith('==')) {
                    continue;
                }
                results.push(match[0]);
            }
        }
        return results;
    }

    static #detectDeprecatedFunctions(text, deprecatedList) {
        if (!Array.isArray(deprecatedList) || !text) {
            return [];
        }
        const issues = [];
        deprecatedList.forEach((entry) => {
            if (!entry?.name) {
                return;
            }
            const regex = new RegExp(`(?:^|[^A-Za-z0-9_.])${entry.name}\\s*\\(`, 'g');
            if (regex.test(text)) {
                const replacement = entry.replacement ? ` Use ${entry.replacement} instead.` : '';
                issues.push(`${entry.name}(...) is deprecated${entry.reason ? `: ${entry.reason}.` : '.'}${replacement}`.trim());
            }
        });
        return issues;
    }

    static #detectOperatorIssues(text) {
        if (!text) {
            return [];
        }
        const errors = [];
        // Detect Python-style exponentiation ** and suggest EcoLang alternatives
        if (/\*\*/.test(text)) {
            errors.push('`**` is not valid EcoLang syntax. Use `pow(base, exponent)` or `base ^ exponent` instead.');
        }
        if (/[+\-*/^,]\s*$/.test(text)) {
            errors.push('Expression ends with an operator');
        }
        if (/^[*/^,]/.test(text)) {
            errors.push('Expression starts with an invalid operator');
        }
        if (/[*/^]\s*[*/^,]/.test(text) || /,\s*[*/^,]/.test(text) || /[+\-]\s*[*/^,]/.test(text)) {
            errors.push('Two operators in a row');
        }
        if (/[+\-*/^,]\s*[)\]]/.test(text)) {
            errors.push('Operator before closing delimiter');
        }
        return errors;
    }

    static #detectUnreachableCode(text) {
        if (!text) {
            return [];
        }
        const warnings = [];
        // Handle both \n and \r\n line endings
        const lines = text.split(/\r?\n/);
        let foundReturn = false;
        let returnLineIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Skip empty lines and comments
            if (!line || line.startsWith('#')) {
                continue;
            }

            // Check if this line starts with 'return' keyword
            if (/^\s*return\b/i.test(lines[i])) {
                foundReturn = true;
                returnLineIndex = i;
                continue;
            }

            // If we've seen a return and this is a non-empty, non-comment line
            if (foundReturn && line) {
                warnings.push(`Unreachable code after return statement (line ${returnLineIndex + 1})`);
                break; // Only warn once
            }
        }

        return warnings;
    }

    static #detectSemanticIssues(text) {
        if (!text) {
            return [];
        }
        const errors = [];
        const divZero = /\/\s*\(?\s*[+\-]?0+(?:\.0+)?\s*\)?(?![0-9A-Za-z_.])/g;
        if (divZero.test(text)) {
            errors.push('Division by zero (constant denominator)');
        }

        const powOperator = /(^|[^A-Za-z0-9_.])([+\-]?\d+(?:\.\d+)?)\s*\^\s*([+\-]?\d+(?:\.\d+)?)/g;
        let match;
        while ((match = powOperator.exec(text)) !== null) {
            const base = Number(match[2]);
            const exponent = Number(match[3]);
            if (!Number.isFinite(base) || !Number.isFinite(exponent)) {
                continue;
            }
            if (base === 0 && exponent === 0) {
                errors.push('0^0 is undefined');
            } else if (base === 0 && exponent < 0) {
                errors.push('0 raised to a negative exponent is undefined');
            } else if (base < 0 && !Number.isInteger(exponent)) {
                errors.push('Negative base with non-integer exponent is invalid (real numbers)');
            }
        }

        const powFn = /\bpow\s*\(([^)]*)\)/gi;
        let fnMatch;
        while ((fnMatch = powFn.exec(text)) !== null) {
            const args = ExpressionServices.#splitArgs(fnMatch[1] || '');
            if (args.length < 2) {
                continue;
            }
            const [baseToken, exponentToken] = args;
            if (!ExpressionServices.#isNumericLiteral(baseToken) || !ExpressionServices.#isNumericLiteral(exponentToken)) {
                continue;
            }
            const base = Number(baseToken);
            const exponent = Number(exponentToken);
            if (base === 0 && exponent === 0) {
                errors.push('pow(0, 0) is undefined');
            } else if (base === 0 && exponent < 0) {
                errors.push('pow(0, negative) is undefined');
            } else if (base < 0 && !Number.isInteger(exponent)) {
                errors.push('pow(negative, non-integer) is invalid (real numbers)');
            }
        }

        const logFn = /\blog\s*\(([^)]*)\)/gi;
        let logMatch;
        while ((logMatch = logFn.exec(text)) !== null) {
            const args = ExpressionServices.#splitArgs(logMatch[1] || '');
            if (args.length >= 1 && ExpressionServices.#isNumericLiteral(args[0])) {
                const value = Number(args[0]);
                if (!(value > 0)) {
                    errors.push('log argument must be > 0');
                }
            }
            if (args.length >= 2 && ExpressionServices.#isNumericLiteral(args[1])) {
                const base = Number(args[1]);
                if (!(base > 0) || base === 1) {
                    errors.push('log base must be > 0 and != 1');
                }
            }
        }

        const rootFn = /\^\s*\(\s*1\s*\/\s*\(?\s*([+\-]?\d+(?:\.\d+)?)\s*\)?\s*\)/g;
        let rootMatch;
        while ((rootMatch = rootFn.exec(text)) !== null) {
            const index = Number(rootMatch[1]);
            if (index === 0) {
                errors.push('Root index n must be non-zero');
            }
        }

        return errors;
    }

    static #splitArgs(argumentString) {
        if (!argumentString) {
            return [];
        }
        const args = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < argumentString.length; i += 1) {
            const char = argumentString[i];
            if (char === '(' || char === '[') {
                depth += 1;
            } else if (char === ')' || char === ']') {
                depth = Math.max(0, depth - 1);
            } else if (char === ',' && depth === 0) {
                args.push(argumentString.slice(start, i).trim());
                start = i + 1;
            }
        }
        args.push(argumentString.slice(start).trim());
        return args.filter((arg) => arg.length > 0);
    }

    static #isNumericLiteral(token) {
        if (!token) {
            return false;
        }
        const normalized = String(token).trim();
        return /^[-+]?\d*(?:\.\d+)?$/.test(normalized) && Number.isFinite(Number(normalized));
    }

    /**
     * Check if expression contains only numeric literals and math operators
     * Examples: "1/2", "3.14 * 2", "(1 + 2) / 3", "2^8"
     * This allows fast-path validation without name resolution.
     */
    static #isPureNumericExpression(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }
        const trimmed = text.trim();
        if (!trimmed) {
            return false;
        }
        // Pattern: only digits, decimal points, operators (+, -, *, /, ^), parentheses, and whitespace
        // Must contain at least one digit
        const pureNumericPattern = /^[\s\d.+\-*/^()]+$/;
        const hasDigit = /\d/.test(trimmed);
        return pureNumericPattern.test(trimmed) && hasDigit;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Public Static Utilities — Token Replacement
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Escape a string for safe use inside a RegExp.
     */
    static escapeRegExp(value) {
        return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Replace a variable token in an expression using word-boundary-aware matching.
     * Ensures only whole identifiers are replaced (e.g. "rate" won't match inside "growth_rate").
     *
     * @param {string} text    - The expression text.
     * @param {string} from    - The token to find (e.g. old variable key).
     * @param {string} to      - The replacement token (e.g. new variable key).
     * @returns {string} The expression with all occurrences replaced.
     */
    static replaceToken(text, from, to) {
        if (!text || !from) return text;
        const escaped = ExpressionServices.escapeRegExp(from);
        const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g');
        return text.replace(pattern, to);
    }

    /**
     * Parse a return statement from a function body.
     *
     * Classifies the return into one of three types:
     *   - **single**: `return expr`  — one value
     *   - **tuple**:  `return (name1, name2, ...)`  — multiple named outputs
     *   - **record**: `return { key1 = expr1; key2 = expr2 }`  — named outputs with renaming
     *
     * @param {string} body - Full function body text (may be multi-line).
     * @returns {{ type: 'single'|'tuple'|'record'|null, outputs: string[]|null,
     *             bodyWithoutReturn: string, returnExpr: string|null,
     *             recordEntries: Object<string,string>|null }}
     */
    static parseReturnStatement(body) {
        const result = {
            type: null,
            outputs: null,
            bodyWithoutReturn: (body || '').trim(),
            returnExpr: null,
            recordEntries: null,
        };

        if (!body || typeof body !== 'string') return result;

        const trimmed = body.trim();
        const lines = trimmed.split('\n');

        // Find the last return line
        let returnLineIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            const stripped = lines[i].trim();
            if (stripped.startsWith('return ') || stripped === 'return') {
                returnLineIdx = i;
                break;
            }
        }

        if (returnLineIdx < 0) return result;

        const returnLine = lines[returnLineIdx].trim();
        const returnExpr = returnLine.length > 7 ? returnLine.slice(7).trim() : '';

        // Body without the return line
        const bodyLines = lines.filter((_, idx) => idx !== returnLineIdx);
        result.bodyWithoutReturn = bodyLines.join('\n').trim();
        result.returnExpr = returnExpr;

        const IDENT_RE = /^[A-Za-z_]\w*$/;

        // --- Record: return { key1 = expr1; key2 = expr2 } ---
        if (returnExpr.startsWith('{') && returnExpr.endsWith('}')) {
            const inner = returnExpr.slice(1, -1).trim();
            const entries = inner.split(';').map((e) => e.trim()).filter(Boolean);
            const recordEntries = {};
            const outputs = [];
            let valid = true;

            for (const entry of entries) {
                if (!entry.includes('=')) { valid = false; break; }
                const eqIdx = entry.indexOf('=');
                const key = entry.slice(0, eqIdx).trim();
                const val = entry.slice(eqIdx + 1).trim();
                if (!key || !IDENT_RE.test(key)) { valid = false; break; }
                recordEntries[key] = val;
                outputs.push(key);
            }

            if (valid && outputs.length > 0) {
                result.type = 'record';
                result.outputs = outputs;
                result.recordEntries = recordEntries;
                return result;
            }
        }

        // --- Tuple: return (name1, name2, ...) ---
        if (returnExpr.startsWith('(') && returnExpr.endsWith(')')) {
            const inner = returnExpr.slice(1, -1).trim();
            const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
            if (parts.length >= 1 && parts.every((p) => IDENT_RE.test(p))) {
                result.type = 'tuple';
                result.outputs = parts;
                return result;
            }
        }

        // --- Single: return <expression> ---
        if (returnExpr) {
            result.type = 'single';
            result.outputs = null;
            return result;
        }

        return result;
    }

    static #normalizeBuiltins(builtins) {
        const empty = {
            functions: [],
            constants: [],
            deprecated: [],
            keywords: [],
            expressionKeywords: [],
            literals: [],
        };
        if (!builtins || typeof builtins !== 'object') {
            return empty;
        }
        const normalizeList = (list) => (Array.isArray(list) ? list.filter((item) => item && item.name) : []);
        const normalizeStringList = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
        return {
            functions: normalizeList(builtins.functions),
            constants: normalizeList(builtins.constants),
            deprecated: normalizeList(builtins.deprecated),
            keywords: normalizeStringList(builtins.keywords),
            expressionKeywords: normalizeStringList(builtins.expressionKeywords),
            literals: normalizeStringList(builtins.literals),
        };
    }
}

