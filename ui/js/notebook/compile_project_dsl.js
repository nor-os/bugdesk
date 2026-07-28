/**
 * compile_project_dsl.js
 *
 * Single source of truth for compiling a project's namespaces + modules
 * against a scenario into DSL. Used by notebook runs, paper runs, and
 * calibration — so all three share identical compilation semantics.
 */
import { notebookDslCompiler } from './notebook_dsl_compiler.js';

/**
 * Compile the given scenario against all namespaces + modules in the project.
 *
 * @param {Object} args
 * @param {Object} args.project        - ProjectModel instance
 * @param {string} args.scenarioPath   - scenario file path (e.g. "scenarios/foo.scenario")
 * @returns {Promise<Object>} { dsl, sourceMap, solver, time, monteCarlo,
 *                              distributions, scenarioType, execution, scenarioContent }
 */
export async function compileProjectDsl({ project, scenarioPath }) {
    if (!project?.isOpen) {
        throw new Error('compileProjectDsl: project is not open');
    }
    if (!scenarioPath) {
        throw new Error('compileProjectDsl: scenarioPath is required');
    }

    // ── Open ALL namespace files ──────────────────────────────────────────
    const namespacePaths = project.namespacePaths ?? [];
    const namespaceCells = [];
    for (const nsPath of namespacePaths) {
        if (!project.getOpenFile(nsPath)) {
            await project.openFile(nsPath);
        }
        const nsFile = project.getOpenFile(nsPath);
        const cells = nsFile?.content?.cells ?? [];
        const nsName = nsPath.replace('.namespace', '').split('/').pop();
        namespaceCells.push({ namespace: nsName, fileName: nsPath, cells });
    }

    // ── Open ALL module files (.edf) ──────────────────────────────────────
    const modulePaths = project.modulePaths ?? [];
    const moduleSources = [];
    for (const modPath of modulePaths) {
        if (!project.getOpenFile(modPath)) {
            await project.openFile(modPath);
        }
        const modFile = project.getOpenFile(modPath);
        if (modFile?.content) {
            moduleSources.push({ fileName: modPath, source: modFile.content });
        }
    }

    // ── Open scenario ─────────────────────────────────────────────────────
    if (!project.getOpenFile(scenarioPath)) {
        await project.openFile(scenarioPath);
    }
    const scenarioFile = project.getOpenFile(scenarioPath);
    const scenarioContent = scenarioFile?.content ?? {};

    const compiled = notebookDslCompiler.compile({
        namespaceCells,
        scenarioData: scenarioContent,
        moduleSources,
    });

    return { ...compiled, scenarioContent };
}
