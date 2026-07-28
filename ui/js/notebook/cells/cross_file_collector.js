/**
 * Cross-file cell collector — shared utility for aggregate cells that need
 * to load content from other project files (namespaces, scenarios).
 *
 * Follows the ReferenceCell pattern: uses project.getOpenFile() for cached
 * files, falls back to project.openFile() for lazy loading.
 */

/**
 * Load and filter cells from all namespace files in the project.
 * @param {object} project — ProjectModel instance
 * @param {(cell: object) => boolean} filterFn — predicate to select cells
 * @returns {Promise<Array<{ name: string, fileName: string, cells: object[] }>>}
 */
export async function collectFromNamespaces(project, filterFn) {
    if (!project) return [];
    const paths = project.namespacePaths ?? [];
    const results = [];

    for (const filePath of paths) {
        const content = await _loadFileContent(project, filePath);
        if (!content) continue;

        const cells = (content.cells ?? []).filter(filterFn);
        if (cells.length === 0) continue;

        results.push({
            name: _pathToName(filePath, '.namespace'),
            fileName: filePath,
            cells,
        });
    }

    return results;
}

/**
 * Load and filter cells from all scenario files in the project.
 * @param {object} project — ProjectModel instance
 * @param {(cell: object) => boolean} filterFn — predicate to select cells
 * @returns {Promise<Array<{ name: string, fileName: string, cells: object[] }>>}
 */
export async function collectFromScenarios(project, filterFn) {
    if (!project) return [];
    const paths = project.scenarioPaths ?? [];
    const results = [];

    for (const filePath of paths) {
        const content = await _loadFileContent(project, filePath);
        if (!content) continue;

        const cells = (content.documentationCells ?? []).filter(filterFn);
        if (cells.length === 0) continue;

        results.push({
            name: content.name ?? _pathToName(filePath, '.scenario'),
            fileName: filePath,
            cells,
        });
    }

    return results;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _loadFileContent(project, filePath) {
    let openFile = project.getOpenFile(filePath);
    if (!openFile) {
        try {
            await project.openFile(filePath);
            openFile = project.getOpenFile(filePath);
        } catch {
            return null;
        }
    }
    return openFile?.content ?? null;
}

function _pathToName(filePath, ext) {
    const filename = filePath.split('/').pop();
    return filename.replace(new RegExp(`\\${ext}$`), '');
}
