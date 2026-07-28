/**
 * Global Search Service
 *
 * Queries project model, symbol index, and file content to find
 * symbols, files, scenarios, and cells across the notebook workspace.
 */

/**
 * GlobalSearchService - searches symbols, files, scenarios, and cells
 */
export class GlobalSearchService {
    /** @type {import('../data/project_model.js').ProjectModel|null} */
    #project;
    /** @type {import('../notebook/notebook_symbol_index.js').NotebookSymbolIndex|null} */
    #symbolIndex;
    #logger;

    /** @type {Map<string, {name:string, description:string, tags:string[], type:string}>} */
    #scenarioCache = new Map();
    #scenarioCacheDirty = true;

    constructor({ projectModel = null, symbolIndex = null, logger = null } = {}) {
        this.#project = projectModel;
        this.#symbolIndex = symbolIndex;
        this.#logger = logger;
    }

    /** Call when project changes to invalidate cached scenario metadata. */
    invalidateScenarioCache() {
        this.#scenarioCacheDirty = true;
        this.#scenarioCache.clear();
    }

    /**
     * Search across all categories.
     * @param {string} query - Search query (case-insensitive substring match)
     * @param {Object} options
     * @param {number} options.maxResults - Max results per category (default 5)
     * @returns {Promise<{ symbols: Array, files: Array, scenarios: Array, cells: Array }>}
     */
    async search(query, { maxResults = 5 } = {}) {
        const q = (query || '').trim().toLowerCase();

        if (!q) {
            return { symbols: [], files: [], scenarios: [], cells: [] };
        }

        const symbols = this.#searchSymbols(q, maxResults);
        const files = this.#searchFiles(q, maxResults);
        const scenarios = await this.#searchScenarios(q, maxResults);
        const cells = await this.#searchCells(q, maxResults);

        return { symbols, files, scenarios, cells };
    }

    /**
     * Search symbols (variables, parameters, stocks, namespaces, etc.)
     * from the NotebookSymbolIndex.
     */
    #searchSymbols(query, maxResults) {
        const allSymbols = this.#symbolIndex?.symbols || [];
        const results = [];

        for (const sym of allSymbols) {
            const name = sym.name || '';
            const displayName = sym.displayName || '';
            const namespace = sym.namespace || '';
            const kind = sym.kind || '';

            const score = this.#scoreMatch(query, [
                { text: name, weight: 3 },
                { text: displayName, weight: 2 },
                { text: namespace, weight: 1 },
                { text: kind, weight: 0.5 },
            ]);

            if (score > 0) {
                results.push({
                    id: `sym:${sym.fileName}:${sym.cellId}:${name}`,
                    name,
                    displayName,
                    namespace,
                    kind,
                    fileName: sym.fileName,
                    cellId: sym.cellId,
                    line: sym.line,
                    detail: sym.detail || '',
                    score,
                    category: 'symbol',
                });
            }
        }

        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.name.localeCompare(b.name);
        });

        return results.slice(0, maxResults);
    }

    /**
     * Search project files by name and type.
     */
    #searchFiles(query, maxResults) {
        const allFiles = this.#project?.files || [];
        const results = [];

        for (const file of allFiles) {
            const path = file.path || '';
            const fileType = file.type || '';
            // Extract basename without extension
            const basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';

            const score = this.#scoreMatch(query, [
                { text: basename, weight: 3 },
                { text: fileType, weight: 1 },
            ]);

            if (score > 0) {
                results.push({
                    id: `file:${path}`,
                    name: basename,
                    path,
                    fileType,
                    score,
                    category: 'file',
                });
            }
        }

        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.name.localeCompare(b.name);
        });

        return results.slice(0, maxResults);
    }

    /**
     * Search scenarios by name, description, and tags.
     * Caches scenario metadata for performance.
     */
    async #searchScenarios(query, maxResults) {
        if (this.#scenarioCacheDirty) {
            await this.#rebuildScenarioCache();
        }

        const results = [];

        for (const [path, meta] of this.#scenarioCache) {
            const tagsStr = (meta.tags || []).join(' ');

            const score = this.#scoreMatch(query, [
                { text: meta.name, weight: 3 },
                { text: meta.description, weight: 1 },
                { text: tagsStr, weight: 1.5 },
            ]);

            if (score > 0) {
                results.push({
                    id: `scenario:${path}`,
                    name: meta.name,
                    description: meta.description,
                    type: meta.type,
                    path,
                    score,
                    category: 'scenario',
                });
            }
        }

        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.name.localeCompare(b.name);
        });

        return results.slice(0, maxResults);
    }

    async #rebuildScenarioCache() {
        this.#scenarioCache.clear();
        this.#scenarioCacheDirty = false;

        const paths = this.#project?.scenarioPaths || [];
        for (const path of paths) {
            try {
                const content = await this.#project.readFileContent(path);
                if (content && typeof content === 'object') {
                    this.#scenarioCache.set(path, {
                        name: content.name || path.split('/').pop()?.replace(/\.scenario$/, '') || '',
                        description: content.description || '',
                        tags: content.metadata?.tags || [],
                        type: content.type || 'static',
                    });
                }
            } catch (e) {
                this.#logger?.warn?.('global-search', `Failed to read scenario ${path}`, e);
            }
        }
    }

    /**
     * Search cells (headings, godley titles, documentation snippets)
     * across all namespace files.
     */
    async #searchCells(query, maxResults) {
        const results = [];
        const namespacePaths = this.#project?.namespacePaths || [];

        for (const filePath of namespacePaths) {
            let content;
            try {
                content = await this.#project.readFileContent(filePath);
            } catch {
                continue;
            }
            if (!content?.cells) continue;

            const fileName = filePath;
            for (const cell of content.cells) {
                const cellId = cell.id;
                const cellType = cell.type;
                const data = cell.data || {};
                let searchText = '';
                let displayText = '';
                let cellKind = '';

                if (cellType === 'heading') {
                    searchText = data.label || data.text || '';
                    displayText = searchText;
                    cellKind = 'heading';
                } else if (cellType === 'godley') {
                    searchText = data.title || data.namespace || '';
                    displayText = searchText;
                    cellKind = 'godley';
                } else if (cellType === 'documentation') {
                    const src = data.source || '';
                    searchText = src.slice(0, 200);
                    // Show first line as display text
                    displayText = src.split('\n')[0]?.slice(0, 80) || '';
                    cellKind = 'documentation';
                } else {
                    continue;
                }

                const fileBasename = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
                const score = this.#scoreMatch(query, [
                    { text: searchText, weight: cellKind === 'heading' ? 3 : cellKind === 'godley' ? 2 : 1 },
                    { text: fileBasename, weight: 0.5 },
                ]);

                if (score > 0) {
                    results.push({
                        id: `cell:${fileName}:${cellId}`,
                        name: displayText,
                        fileName,
                        cellId,
                        cellKind,
                        fileBasename,
                        score,
                        category: 'cell',
                    });
                }
            }
        }

        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.name.localeCompare(b.name);
        });

        return results.slice(0, maxResults);
    }

    /**
     * Score a match based on substring matching with weights.
     * Higher score for matches at the start of the string.
     * @param {string} query - Lowercase query
     * @param {Array<{text: string, weight: number}>} fields - Fields to search
     * @returns {number} Match score (0 = no match)
     */
    #scoreMatch(query, fields) {
        let totalScore = 0;

        for (const { text, weight } of fields) {
            const lower = (text || '').toLowerCase();
            if (!lower) continue;

            const index = lower.indexOf(query);
            if (index === -1) continue;

            let fieldScore = weight;

            if (index === 0) {
                fieldScore *= 2;
            }

            if (lower === query) {
                fieldScore *= 1.5;
            }

            totalScore += fieldScore;
        }

        return totalScore;
    }
}
