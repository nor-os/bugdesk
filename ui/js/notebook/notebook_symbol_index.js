/**
 * NotebookSymbolIndex
 *
 * Maintains a full-project symbol table extracted from notebook cells for:
 *   - FileNavigator outline panel (full-project scope)
 *   - Outline navigation (click → file + cell + line)
 *   - Monaco CompletionItemProvider, HoverProvider, DiagnosticsProvider
 *   - Validation (undefined variable detection, duplicate definitions)
 *
 * Parses cell data to extract:
 *   - Namespace declarations (from code cells)
 *   - Variable/parameter assignments (from code + parameter cells)
 *   - Godley table namespaces + stock accounts (from godley cells)
 *   - Generator/smooth/pid/schedule/delay/latch/time names (from special cells)
 *   - Import statements (from code cells)
 *
 * Each symbol carries: name, kind, cellId, fileName, line (1-based within cell).
 *
 * Full-project index: `rebuildProject(project)` indexes ALL namespace files.
 * Single-file update: `rebuildFile(fileName, cells)` updates one file in the cache.
 * Active-editor feedback: `rebuild(cells, fileName)` debounced update for live editing.
 */

const DEBOUNCE_MS = 250;

/**
 * @typedef {{
 *   name: string,
 *   kind: string,
 *   cellId?: string,
 *   fileName?: string,
 *   line?: number,
 *   namespace?: string,
 *   detail?: string,
 *   displayName?: string,
 *   defaultValue?: any,
 *   min?: number,
 *   max?: number,
 *   step?: number,
 * }} NotebookSymbol
 */

export class NotebookSymbolIndex {
    /** @type {Map<string, NotebookSymbol[]>} Per-file symbol cache */
    #symbolsByFile = new Map();

    /** @type {NotebookSymbol[]} Flattened symbols from all files */
    #symbols = [];

    /** @type {number|null} */
    #debounceTimer = null;

    /** @type {((symbols: NotebookSymbol[]) => void)|null} */
    #onChange = null;

    /**
     * @param {{ onChange?: (symbols: NotebookSymbol[]) => void }} options
     */
    constructor({ onChange } = {}) {
        this.#onChange = onChange ?? null;
    }

    /** Current symbols (read-only snapshot) — full project. */
    get symbols() {
        return this.#symbols;
    }

    /**
     * Rebuild the full project symbol index from all namespace files.
     * Call on project open.
     * @param {object} project  ProjectModel instance
     */
    async rebuildProject(project) {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }
        this.#symbolsByFile.clear();

        const namespacePaths = project.namespacePaths ?? [];
        for (const filePath of namespacePaths) {
            // Read content from cache or disk — does not require the file to be open in a tab
            const content = await project.readFileContent(filePath);
            const cells = this.#extractCellsFromContent(content);
            if (cells.length > 0) {
                this.#symbolsByFile.set(filePath, this.#extractFromCells(cells, filePath));
            }
        }

        this.#rebuildFlattened();
        this.#onChange?.(this.#symbols);
    }

    /**
     * Update symbols for a single file (after save or external change).
     * @param {string} fileName  Relative file path
     * @param {Array<{ id: string, type: string, data: object }>} cells
     */
    rebuildFile(fileName, cells) {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }
        if (!cells || cells.length === 0) {
            this.#symbolsByFile.delete(fileName);
        } else {
            this.#symbolsByFile.set(fileName, this.#extractFromCells(cells, fileName));
        }
        this.#rebuildFlattened();
        this.#onChange?.(this.#symbols);
    }

    /**
     * Schedule a debounced rebuild for the active file (live editing feedback).
     * @param {Array<{ id: string, type: string, data: object }>} cells
     * @param {string} [fileName]  File path for the active file
     */
    rebuild(cells, fileName) {
        if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
        this.#debounceTimer = setTimeout(() => {
            this.#debounceTimer = null;
            if (fileName) {
                this.#symbolsByFile.set(fileName, this.#extractFromCells(cells, fileName));
                this.#rebuildFlattened();
            } else {
                // Legacy path: single-file mode (no project context)
                this.#symbols = this.#extractFromCells(cells, null);
            }
            this.#onChange?.(this.#symbols);
        }, DEBOUNCE_MS);
    }

    /**
     * Immediate (non-debounced) rebuild — use on file open / tab switch.
     * @param {Array<{ id: string, type: string, data: object }>} cells
     * @param {string} [fileName]  File path for the active file
     */
    rebuildImmediate(cells, fileName) {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }
        if (fileName) {
            this.#symbolsByFile.set(fileName, this.#extractFromCells(cells, fileName));
            this.#rebuildFlattened();
        } else {
            this.#symbols = this.#extractFromCells(cells, null);
        }
        this.#onChange?.(this.#symbols);
    }

    /**
     * Build a configurables map for the scenario editor.
     * Groups parameters, constants, and stocks by namespace.
     * @returns {{ [namespace: string]: { parameters: Array, constants: Array, stocks: Array } }}
     */
    getConfigurables() {
        const result = {};
        let currentNamespace = 'Global';

        for (const sym of this.#symbols) {
            if (sym.kind === 'namespace') {
                currentNamespace = sym.name;
                continue;
            }

            const ns = sym.namespace || currentNamespace;
            if (!result[ns]) result[ns] = { parameters: [], constants: [], stocks: [] };

            if (sym.kind === 'parameter') {
                result[ns].parameters.push({
                    name: sym.name,
                    displayName: sym.displayName || sym.name,
                    defaultValue: sym.defaultValue ?? 0,
                    min: sym.min ?? null,
                    max: sym.max ?? null,
                    step: sym.step ?? null,
                });
            } else if (sym.kind === 'variable') {
                result[ns].constants.push({
                    name: sym.name,
                    displayName: sym.name,
                    defaultValue: 0,
                });
            } else if (sym.kind === 'stock') {
                result[ns].stocks.push({
                    name: sym.name,
                    displayName: sym.name,
                    defaultValue: 0,
                });
            }
        }

        return result;
    }

    dispose() {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
        }
        this.#symbolsByFile.clear();
        this.#symbols = [];
        this.#onChange = null;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /** Flatten per-file caches into the single #symbols array. */
    #rebuildFlattened() {
        const all = [];
        for (const fileSymbols of this.#symbolsByFile.values()) {
            all.push(...fileSymbols);
        }
        this.#symbols = all;
    }

    /**
     * Extract cells array from file content (handles both array and {cells} wrapper).
     * @param {object|Array|string|null} content
     * @returns {Array}
     */
    #extractCellsFromContent(content) {
        if (!content) return [];
        if (Array.isArray(content)) return content;
        if (typeof content === 'object' && Array.isArray(content.cells)) return content.cells;
        return [];
    }

    // ─── Extraction ──────────────────────────────────────────────────────────

    /**
     * Extract symbols from a cells array.
     * @param {Array<{ id: string, type: string, data: object }>} cells
     * @param {string|null} fileName
     * @returns {NotebookSymbol[]}
     */
    #extractFromCells(cells, fileName) {
        const symbols = [];

        // Emit a file-level namespace symbol for .namespace files
        if (fileName && fileName.endsWith('.namespace')) {
            const nsName = fileName.replace('.namespace', '').split('/').pop();
            symbols.push({ name: nsName, kind: 'namespace', fileName, line: 0 });
        }

        for (const cell of cells) {
            switch (cell.type) {
                case 'code':
                    this.#extractCode(cell, symbols, fileName);
                    break;
                case 'parameter':
                    this.#extractParameter(cell, symbols, fileName);
                    break;
                case 'godley':
                    this.#extractGodley(cell, symbols, fileName);
                    break;
                case 'stock':
                case 'source-sink':
                    this.#extractStockCell(cell, symbols, fileName);
                    break;
                case 'generator':
                case 'smooth':
                case 'pid':
                case 'schedule':
                case 'delay':
                case 'latch':
                case 'conditional-switch':
                case 'time':
                case 'signal-source':
                case 'event-timer':
                case 'event-counter':
                case 'linear-ramp':
                case 'statistics':
                    this.#extractSpecial(cell, symbols, fileName);
                    break;
            }
        }
        return symbols;
    }

    /**
     * Count the 1-based line number at a character offset within a string.
     * @param {string} source
     * @param {number} charIndex
     * @returns {number}
     */
    #lineAtOffset(source, charIndex) {
        let line = 1;
        for (let i = 0; i < charIndex && i < source.length; i++) {
            if (source[i] === '\n') line++;
        }
        return line;
    }

    #extractCode(cell, symbols, fileName) {
        const source = cell.data?.source ?? '';

        // Namespace declarations: `namespace Foo` or `.NAMESPACE Foo`
        for (const m of source.matchAll(/^\.?namespace\s+(\w+)/gim)) {
            symbols.push({
                name: m[1], kind: 'namespace',
                cellId: cell.id, fileName,
                line: this.#lineAtOffset(source, m.index),
            });
        }

        // Import statements: `import Foo` or `from Foo import bar`
        for (const m of source.matchAll(/^(?:import\s+(\w+)|from\s+(\w+)\s+import)/gm)) {
            const name = m[1] || m[2];
            symbols.push({
                name, kind: 'import',
                cellId: cell.id, fileName,
                line: this.#lineAtOffset(source, m.index),
            });
        }

        // Variable assignments (lhs = ...) — single and tuple, including multi-line.
        // Track parenthesis depth across lines so keyword args inside multi-line
        // function calls (e.g. `erosion_rate = erosion_rate,`) are not mistaken
        // for top-level variable definitions.
        const sourceLines = source.split('\n');
        let tuplePending = null; // { names: string[], startLine: number }
        let parenDepth = 0;
        for (let li = 0; li < sourceLines.length; li++) {
            const raw = sourceLines[li];
            const trimmed = raw.trim();
            if (!trimmed || /^[;#]/.test(trimmed)) continue;

            // Update paren depth from previous lines' carry-over
            // (count parens on this line to maintain running depth)
            let lineParenDelta = 0;
            // Strip strings and comments before counting parens
            const stripped = trimmed
                .replace(/"[^"]*"/g, s => ' '.repeat(s.length))
                .replace(/'[^']*'/g, s => ' '.repeat(s.length))
                .replace(/[;#].*$/, '');
            for (const ch of stripped) {
                if (ch === '(') lineParenDelta++;
                else if (ch === ')') lineParenDelta--;
            }

            if (tuplePending) {
                // Continuation of multi-line tuple LHS
                const eqMatch = trimmed.match(/^([\w][\w.]*(?:\s*,\s*[\w][\w.]*)*)\s*(?<![!=<>])=(?!=)/);
                if (eqMatch) {
                    for (const p of eqMatch[1].split(',')) {
                        const n = p.trim();
                        if (n) tuplePending.names.push(n);
                    }
                    for (const n of tuplePending.names) {
                        if (!['namespace', 'return', 'let', 'import'].includes(n)) {
                            symbols.push({ name: n, kind: 'variable', cellId: cell.id, fileName, line: tuplePending.startLine });
                        }
                    }
                    tuplePending = null;
                    parenDepth += lineParenDelta;
                } else {
                    for (const p of trimmed.replace(/,\s*$/, '').split(',')) {
                        const n = p.trim();
                        if (n && /^[\w][\w.]*$/.test(n)) tuplePending.names.push(n);
                    }
                    if (!trimmed.endsWith(',')) tuplePending = null; // invalid continuation
                    parenDepth += lineParenDelta;
                }
                continue;
            }

            // Inside a multi-line function call — skip (these are keyword args, not definitions)
            if (parenDepth > 0) {
                parenDepth += lineParenDelta;
                continue;
            }

            // Multi-line tuple start: comma-separated identifiers ending with comma, no parens
            if (/^[\w][\w.]*(?:\s*,\s*[\w][\w.]*)*\s*,\s*$/.test(trimmed) && !trimmed.includes('(')) {
                tuplePending = { names: [], startLine: li + 1 };
                for (const p of trimmed.replace(/,\s*$/, '').split(',')) {
                    const n = p.trim();
                    if (n) tuplePending.names.push(n);
                }
                parenDepth += lineParenDelta;
                continue;
            }

            // Single-line tuple: a, b, c = expr (2+ names)
            const tupleMatch = trimmed.match(/^([\w][\w.]*(?:\s*,\s*[\w][\w.]*)+)\s*(?<![!=<>])=(?!=)/);
            if (tupleMatch) {
                for (const p of tupleMatch[1].split(',')) {
                    const n = p.trim();
                    if (n && !['namespace', 'return', 'let', 'import'].includes(n)) {
                        symbols.push({ name: n, kind: 'variable', cellId: cell.id, fileName, line: li + 1 });
                    }
                }
                parenDepth += lineParenDelta;
                continue;
            }

            // Single variable: name = expr
            const singleMatch = trimmed.match(/^(\w[\w.]*)\s*(?<![!=<>])=(?!=)/);
            if (singleMatch) {
                const name = singleMatch[1];
                if (!['namespace', 'return', 'let', 'import'].includes(name)) {
                    symbols.push({ name, kind: 'variable', cellId: cell.id, fileName, line: li + 1 });
                }
            }

            parenDepth += lineParenDelta;
        }

        // Stock references: d<Sector>::<AccType>[<Account>]/dt
        for (const m of source.matchAll(/^d(\w+::\w+\[\w+\])\/dt/gm)) {
            symbols.push({
                name: m[1], kind: 'stock',
                cellId: cell.id, fileName,
                line: this.#lineAtOffset(source, m.index),
            });
        }
    }

    #extractParameter(cell, symbols, fileName) {
        const params = cell.data?.parameters ?? (cell.data?.name ? [cell.data] : []);
        const ns = cell.data?.namespace?.trim() || null;
        for (const p of params) {
            if (p.name) {
                symbols.push({
                    name: p.name,
                    kind: 'parameter',
                    cellId: cell.id,
                    fileName,
                    line: 1,
                    namespace: ns,
                    displayName: p.displayName || p.description || p.name,
                    defaultValue: p.value ?? 0,
                    min: p.min ?? null,
                    max: p.max ?? null,
                    step: p.step ?? null,
                });
            }
        }
    }

    #extractGodley(cell, symbols, fileName) {
        if (cell.data?.namespace) {
            symbols.push({
                name: cell.data.namespace,
                kind: 'namespace',
                detail: `Godley: ${cell.data.title || cell.data.namespace}`,
                cellId: cell.id,
                fileName,
                line: 1,
            });
        }

        const ns = cell.data?.namespace;
        const accounts = cell.data?.accounts ?? [];
        for (const acc of accounts) {
            if (acc.name && ns) {
                symbols.push({
                    name: `${ns}::${acc.type ?? 'Assets'}[${acc.name}]`,
                    kind: 'stock',
                    cellId: cell.id,
                    fileName,
                    line: 1,
                });
            }
        }
    }

    #extractStockCell(cell, symbols, fileName) {
        const name = cell.data?.name;
        if (name) {
            symbols.push({
                name,
                kind: 'stock',
                cellId: cell.id,
                fileName,
                line: 1,
            });
        }
    }

    #extractSpecial(cell, symbols, fileName) {
        const name = cell.data?.name;
        if (name) {
            symbols.push({
                name,
                kind: cell.type,
                cellId: cell.id,
                fileName,
                line: 1,
            });
        }
    }
}
