/**
 * NotebookValidation
 *
 * Validates the full notebook project after file saves, producing diagnostics
 * that map back to specific files, cells, and lines.
 *
 * Validation pipeline:
 *   1. Compile all namespace cells to DSL (via NotebookDslCompiler)
 *   2. Send DSL to backend `validate_dsl()` for parse + apply checks
 *   3. Map backend errors back to cells via source map
 *   4. Run frontend-only checks: duplicate definitions
 *   5. Emit `notebook:validation:updated` with structured diagnostics
 *
 * Diagnostics are routed to:
 *   - Status indicator (bottom bar)
 *   - Monaco markers (inline squiggles in code cells)
 *   - Error popover (clickable list navigating to source)
 */

import { NotebookDslCompiler } from './notebook_dsl_compiler.js';

/**
 * @typedef {{
 *   fileName: string|null,
 *   cellId: string|null,
 *   cellLine: number,
 *   message: string,
 *   severity: 'error'|'warning',
 * }} ValidationDiagnostic
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   errors: ValidationDiagnostic[],
 *   warnings: ValidationDiagnostic[],
 *   all: ValidationDiagnostic[],
 * }} ValidationStatus
 */

export class NotebookValidation {

    /** @type {import('../core/event_bus.js').EventBus} */
    #eventBus = null;

    /** @type {import('../data/project_model.js').ProjectModel} */
    #project = null;

    /** @type {import('./notebook_symbol_index.js').NotebookSymbolIndex} */
    #symbolIndex = null;

    /** @type {NotebookDslCompiler} */
    #compiler = new NotebookDslCompiler();

    /** @type {ValidationStatus} */
    #status = { ok: true, errors: [], warnings: [], all: [] };

    /** @type {import('./notebook_dsl_compiler.js').SourceMapEntry[]} */
    #lastSourceMap = [];

    /** @type {boolean} */
    #validating = false;

    /** @type {number|null} */
    #debounceTimer = null;

    /**
     * @param {{
     *   eventBus: object,
     *   project: object,
     *   symbolIndex: object,
     * }} deps
     */
    constructor({ eventBus, project, symbolIndex }) {
        this.#eventBus = eventBus;
        this.#project = project;
        this.#symbolIndex = symbolIndex;
    }

    /** Current validation status. */
    get status() { return this.#status; }

    /** All diagnostics (errors + warnings). */
    get diagnostics() { return this.#status.all; }

    /** Last compiled source map. */
    get lastSourceMap() { return this.#lastSourceMap; }

    /**
     * Run a full validation pass. Call after file save.
     * @returns {Promise<ValidationStatus>}
     */
    async validate() {
        if (this.#validating || !this.#project) return this.#status;
        this.#validating = true;

        try {
            const errors = [];
            const warnings = [];

            // ── 1. Compile DSL ────────────────────────────────────────────
            const namespaceCells = await this.#gatherNamespaceCells();
            if (!this.#project) return this.#status;   // disposed while awaiting
            const moduleSources = await this.#gatherModuleSources();
            if (!this.#project) return this.#status;   // disposed while awaiting
            let dsl = '';
            let sourceMap = [];

            try {
                const result = this.#compiler.compile({ namespaceCells, moduleSources });
                dsl = result.dsl;
                sourceMap = result.sourceMap;
                this.#lastSourceMap = sourceMap;
            } catch (compileErr) {
                errors.push({
                    fileName: null, cellId: null, cellLine: 0,
                    message: `Compilation error: ${compileErr.message}`,
                    severity: 'error',
                });
                this.#emitStatus(errors, warnings);
                return this.#status;
            }

            if (!dsl.trim()) {
                this.#emitStatus(errors, warnings);
                return this.#status;
            }

            // ── 2. Backend DSL validation ─────────────────────────────────
            const api = window.pywebview?.api;
            if (api?.validate_dsl) {
                try {
                    const result = await api.validate_dsl({ dsl });
                    if (!result.ok && Array.isArray(result.errors)) {
                        for (const err of result.errors) {
                            const mapped = this.#mapDslLineToSource(sourceMap, err.line);
                            errors.push({
                                fileName: mapped?.fileName ?? null,
                                cellId: mapped?.cellId ?? null,
                                cellLine: mapped?.cellLine ?? 0,
                                message: err.message,
                                severity: 'error',
                            });
                        }
                    }
                } catch (backendErr) {
                    // Backend unavailable — skip backend validation
                }
            }

            // ── 3. Frontend-only checks ───────────────────────────────────
            this.#checkDuplicateDefinitions(warnings);
            this.#checkGodleyBalance(namespaceCells, errors);

            this.#emitStatus(errors, warnings);
            return this.#status;

        } finally {
            this.#validating = false;
        }
    }

    /**
     * Schedule a debounced validation pass. Call on cell edits for live feedback.
     * @param {number} [delay=600] Debounce delay in ms
     */
    validateDebounced(delay = 600) {
        if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
        this.#debounceTimer = setTimeout(() => {
            this.#debounceTimer = null;
            this.validate();
        }, delay);
    }

    dispose() {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }
        this.#eventBus = null;
        this.#project = null;
        this.#symbolIndex = null;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    async #gatherNamespaceCells() {
        const namespacePaths = this.#project?.namespacePaths ?? [];
        const result = [];
        for (const nsPath of namespacePaths) {
            if (!this.#project) break;
            const content = await this.#project.readFileContent(nsPath);
            const cells = content?.cells ?? (Array.isArray(content) ? content : []);
            const nsName = nsPath.replace('.namespace', '').split('/').pop();
            result.push({ namespace: nsName, fileName: nsPath, cells });
        }
        return result;
    }

    async #gatherModuleSources() {
        const modulePaths = this.#project?.modulePaths ?? [];
        const result = [];
        for (const modPath of modulePaths) {
            if (!this.#project) break;
            const content = await this.#project.readFileContent(modPath);
            if (content) {
                result.push({ fileName: modPath, source: typeof content === 'string' ? content : '' });
            }
        }
        return result;
    }

    /**
     * Map a DSL line number back to a source cell location.
     * @param {import('./notebook_dsl_compiler.js').SourceMapEntry[]} sourceMap
     * @param {number|null} dslLine
     * @returns {import('./notebook_dsl_compiler.js').SourceMapEntry|null}
     */
    #mapDslLineToSource(sourceMap, dslLine) {
        if (dslLine == null) return null;
        return NotebookDslCompiler.lookupLine(sourceMap, dslLine);
    }

    /**
     * Check for duplicate symbol definitions across the project.
     * Same name defined in multiple cells → warning.
     */
    #checkDuplicateDefinitions(warnings) {
        if (!this.#symbolIndex) return;
        const symbols = this.#symbolIndex.symbols;
        /** @type {Map<string, { fileName: string, cellId: string }[]>} */
        const seen = new Map();

        for (const sym of symbols) {
            if (sym.kind === 'namespace' || sym.kind === 'import') continue;
            // Scope by namespace: use explicit namespace, or derive from file name
            const ns = sym.namespace
                || (sym.fileName?.endsWith('.namespace')
                    ? sym.fileName.replace('.namespace', '').split('/').pop()
                    : null);
            const key = ns ? `${ns}.${sym.name}` : sym.name;
            if (!seen.has(key)) {
                seen.set(key, []);
            }
            seen.get(key).push({ fileName: sym.fileName, cellId: sym.cellId, line: sym.line });
        }

        for (const [name, locations] of seen) {
            if (locations.length > 1) {
                for (const loc of locations) {
                    warnings.push({
                        fileName: loc.fileName ?? null,
                        cellId: loc.cellId ?? null,
                        cellLine: loc.line ?? 0,
                        message: `Duplicate definition: '${name}' is defined ${locations.length} times`,
                        severity: 'warning',
                    });
                }
            }
        }
    }

    /**
     * Check Godley table flows for accounting balance and expression validity.
     *
     * Checks per flow row:
     *   1. Has at least one non-empty entry
     *   2. Has entries on both sides (Assets AND Liabilities/Equity)
     *   3. Individual expressions are syntactically valid
     *   4. A - L - E = 0 (evaluated with all variables = 1)
     */
    #checkGodleyBalance(namespaceCells, errors) {
        for (const { fileName, cells } of namespaceCells) {
            for (const cell of cells) {
                if (cell.type !== 'godley') continue;
                const data = cell.data ?? {};
                const accounts = data.accounts;
                const flows = data.flows;
                if (!Array.isArray(accounts) || !Array.isArray(flows)) continue;

                const sector = data.sector || data.title || 'Unknown';

                // Build account-id → type lookup
                const accTypeById = new Map();
                for (const acc of accounts) {
                    accTypeById.set(acc.id, acc.type); // 'Assets', 'Liabilities', 'Equity'
                }

                const hasLiabilitiesOrEquity = accounts.some(
                    a => a.type === 'Liabilities' || a.type === 'Equity'
                );

                for (const flow of flows) {
                    const entries = flow.entries ?? {};
                    const flowLabel = flow.name || '(unnamed)';

                    // Collect entry expressions with A-L-E sign
                    const terms = [];
                    let hasAnyEntry = false;
                    const typesPresent = new Set();

                    for (const [accId, expr] of Object.entries(entries)) {
                        if (typeof expr !== 'string' || !expr.trim()) continue;
                        hasAnyEntry = true;
                        const type = accTypeById.get(accId);
                        if (!type) continue;
                        typesPresent.add(type);
                        const sign = type === 'Assets' ? +1 : -1;
                        terms.push({ expr: expr.trim(), sign, accId });
                    }

                    // 1. No entries at all
                    if (!hasAnyEntry) {
                        errors.push({
                            fileName: fileName ?? null,
                            cellId: cell.id ?? null,
                            cellLine: 0,
                            message: `Godley table "${sector}": flow "${flowLabel}" has no entries`,
                            severity: 'error',
                        });
                        continue;
                    }

                    // 2. Missing balance sides — entries only on one side
                    if (hasLiabilitiesOrEquity && typesPresent.size === 1) {
                        const side = [...typesPresent][0];
                        errors.push({
                            fileName: fileName ?? null,
                            cellId: cell.id ?? null,
                            cellLine: 0,
                            message: `Godley table "${sector}": flow "${flowLabel}" has entries only in ${side} — add counter-entries`,
                            severity: 'error',
                        });
                        continue;
                    }

                    // 3. Check individual expression syntax
                    let hasExprError = false;
                    for (const { expr, accId } of terms) {
                        const accName = accounts.find(a => a.id === accId)?.name ?? accId;
                        const syntaxErr = this.#checkExpressionSyntax(expr);
                        if (syntaxErr) {
                            hasExprError = true;
                            errors.push({
                                fileName: fileName ?? null,
                                cellId: cell.id ?? null,
                                cellLine: 0,
                                message: `Godley table "${sector}": flow "${flowLabel}", account "${accName}": ${syntaxErr}`,
                                severity: 'error',
                            });
                        }
                    }
                    if (hasExprError) continue;

                    // 4. Evaluate A - L - E with all variables = 1
                    const balance = this.#evaluateBalanceAtOne(terms);
                    if (balance !== null && Math.abs(balance) > 1e-10) {
                        errors.push({
                            fileName: fileName ?? null,
                            cellId: cell.id ?? null,
                            cellLine: 0,
                            message: `Godley table "${sector}": flow "${flowLabel}" is imbalanced (A − L − E ≠ 0)`,
                            severity: 'error',
                        });
                    }
                }
            }
        }
    }

    /**
     * Evaluate A - L - E balance by substituting all variables with 1.
     * @param {{ expr: string, sign: number }[]} terms
     * @returns {number|null} Balance value, or null if expressions can't be evaluated.
     */
    #evaluateBalanceAtOne(terms) {
        let total = 0;
        for (const { expr, sign } of terms) {
            const val = this.#safeEvalWithOnes(expr);
            if (val === null) return null;
            total += sign * val;
        }
        return total;
    }

    /**
     * Safely evaluate an expression with all identifiers replaced by 1.0.
     * Handles stock references (Sector::Type[Name]) and simple identifiers.
     * Returns null if the expression contains unsupported constructs.
     */
    #safeEvalWithOnes(expr) {
        // Replace stock references like Firms::Assets[Capital]
        let simplified = expr.replace(/\w+::\w+\[\w+\]/g, '1');
        // Replace identifiers (variable names)
        simplified = simplified.replace(/[a-zA-Z_]\w*/g, '1');
        // Only allow safe arithmetic: digits, operators, parens, whitespace, decimal points
        if (!/^[\d.+\-*/() \t]+$/.test(simplified)) return null;
        try {
            return new Function('"use strict"; return (' + simplified + ')')();
        } catch {
            return null;
        }
    }

    /**
     * Check an expression for basic syntax errors.
     * Returns an error message string, or null if the expression looks OK.
     * @param {string} expr
     * @returns {string|null}
     */
    #checkExpressionSyntax(expr) {
        if (!expr || !expr.trim()) return null;
        const s = expr.trim();

        // Check balanced parentheses
        let depth = 0;
        for (const ch of s) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (depth < 0) return 'unmatched closing parenthesis';
        }
        if (depth > 0) return 'unmatched opening parenthesis';

        // Check for trailing/leading operators (but allow leading minus for negation)
        if (/[+*/]$/.test(s)) return 'expression ends with an operator';
        if (/^[+*/]/.test(s)) return 'expression starts with an operator';

        // Check for consecutive operators (e.g. "a + * b")
        if (/[+\-*/]{2,}/.test(s.replace(/[+\-]\s*[+\-]/g, '--'))) {
            // Allow -- (double negation) but not others like +*, */, etc.
            if (/[*/]\s*[*/]|[+]\s*[*/]|[*/]\s*[+]/.test(s)) {
                return 'consecutive operators';
            }
        }

        // Check for empty parentheses (but allow function calls with no args)
        if (/\(\s*\)/.test(s) && !/[a-zA-Z_]\w*\s*\(\s*\)/.test(s)) {
            return 'empty parentheses';
        }

        return null;
    }

    #emitStatus(errors, warnings) {
        const all = [...errors, ...warnings];
        this.#status = {
            ok: errors.length === 0,
            errors,
            warnings,
            all,
        };
        this.#eventBus?.emit('notebook:validation:updated', this.#status);
    }
}
