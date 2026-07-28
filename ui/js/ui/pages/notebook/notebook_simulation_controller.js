/**
 * NotebookSimulationController
 *
 * Notebook-specific simulation adapter. Compiles DSL from notebook cells
 * and delegates the actual run to the global SimulationController.
 *
 * Responsibilities:
 *   - Aggregate cells from all .namespace files
 *   - Compile via NotebookDslCompiler
 *   - Delegate run to SimulationController.runFromDsl()
 *   - Route results to PlotCell renderers (including stored results for tab switches)
 *   - Toggle toolbar run/pause/stop button states
 */

import { ControllerBase } from '../../base/controller_base.js';
import { compileProjectDsl } from '../../../notebook/compile_project_dsl.js';
import { getSetting } from '../../../core/settings.js';

export class NotebookSimulationController extends ControllerBase {
    /** @type {import('../../../data/project_model.js').ProjectModel} */
    #project = null;

    /** @type {HTMLElement} */
    #toolbarEl = null;

    /** @type {{ getEditor: () => NotebookEditor|null, getScenarioEditor: () => ScenarioFileEditor|null, getAllEditors: () => NotebookEditor[], getActiveFilePath: () => string|null, activateTab: (path: string) => Promise, flushAndSaveActive: () => Promise, flushAllEditors: () => void }} */
    #page = null;

    /** @type {Function} */
    #notificationCenter = null;

    /** @type {{ series: object, time: number[] }|null} Last simulation plot data, for pushing to newly-activated tabs. */
    #storedPlotData = null;

    /** @type {import('../../../notebook/notebook_dsl_compiler.js').SourceMapEntry[]|null} */
    #lastSourceMap = null;

    /** @type {object|null} Cached actuals overlay data { seriesId: { years, values } } */
    #actuals = null;

    /** @type {boolean} Guard against concurrent fetchAndPushActuals calls. */
    #fetchingActuals = false;

    initialize({ project, toolbarEl, page, notificationCenter }) {
        this.#project = project;
        this.#toolbarEl = toolbarEl;
        this.#page = page;
        this.#notificationCenter = notificationCenter;

        this.#subscribe();
    }

    #subscribe() {
        const sub = (event, fn) => {
            const h = this.eventBus?.on(event, fn);
            if (h) this.trackDisposer(() => h.dispose?.());
        };
        sub('simulation:run:completed', ({ result }) => this.#onSimulationResults(result));

        // Streaming deltas → live-update plot cells during simulation
        // Only push to the active namespace editor (lightweight). Scenario
        // documentation plots receive results once on simulation:run:completed
        // to avoid re-rendering 15+ charts on every streaming tick.
        sub('streaming:delta', (payload) => {
            if (payload?.data) {
                const plotData = this.#buildStreamingPlotData(payload.data);
                this.#storedPlotData = plotData;
                // Only push to editors when notebook page is visible to avoid
                // wasting CPU on canvas rendering for hidden DOM elements.
                const notebookMain = document.getElementById('notebook-main');
                if (!notebookMain?.offsetParent) return;
                const editor = this.#page.getEditor();
                if (editor) this.#pushPlotDataToEditor(editor, plotData, { streaming: true });
            }
        });

        // Track running state via SimulationController phase changes (reliable
        // for both notebook-initiated and SimulationController-initiated runs)
        sub('simulation:phase:changed', ({ next }) => {
            if (next === 'running' || next === 'starting') {
                this.#setRunningState(true);
            } else if (next === 'complete' || next === 'idle' || next === 'error') {
                this.#setRunningState(false);
            }
        });

        // Global top-bar Run button — route to this controller when notebook is visible
        sub('topbar:run-requested', (payload) => {
            const notebookMain = document.getElementById('notebook-main');
            if (!notebookMain?.offsetParent) return; // not visible
            const scenarioPath = this.#resolveScenarioPath();
            if (scenarioPath) {
                this.run(scenarioPath, payload);
            }
        });
    }

    /** Resolve the scenario path to run — uses the project's default scenario or the first available. */
    #resolveScenarioPath() {
        if (!this.#project?.isOpen) return null;
        const manifest = this.#project.getOpenFile('project.ecosim')?.content;
        const defaultPath = manifest?.settings?.defaultScenario;
        const files = this.#project.files ?? [];
        const scenarios = files.filter(f => f.type === 'scenario');
        if (defaultPath && scenarios.some(f => f.path === defaultPath)) return defaultPath;
        return scenarios[0]?.path ?? null;
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * @param {string} scenarioPath
     * @param {{ solverMethod?: string, t0?: number, t1?: number, dt?: number }} [toolbarOverrides]
     */
    async run(scenarioPath, toolbarOverrides) {
        if (!this.#project.isOpen) return;

        if (!scenarioPath) {
            this.#notificationCenter?.warn?.('No scenario selected.');
            return;
        }

        // Flush ALL open editors to ProjectModel so DSL compilation uses current state
        this.#page.flushAllEditors?.();
        await this.#page.flushAndSaveActive();

        // ── Compile via shared helper (single source of truth) ───────────────
        const {
            dsl, sourceMap, solver, time, monteCarlo, distributions, scenarioType, execution, scenarioContent,
        } = await compileProjectDsl({ project: this.#project, scenarioPath });
        this.#lastSourceMap = sourceMap;

        if (!dsl.trim()) {
            this.#notificationCenter?.warn?.('Model has no DSL content to simulate.');
            return;
        }

        // Toolbar inputs override compiled cell values
        const solverMethod = toolbarOverrides?.solverMethod ?? solver.method;
        const t0 = toolbarOverrides?.t0 ?? time.t0;
        const t1 = toolbarOverrides?.t1 ?? time.t1;
        const dt = toolbarOverrides?.dt ?? time.dt;
        const scenarioName = scenarioContent.name || scenarioPath.split('/').pop().replace('.scenario', '');

        // The notebook DSL → SimulationController run path was retired with
        // the EcoSim run controller. The live Run button drives the world
        // model via runtime_controls → world_run_async (WebSocket). This
        // handler is no longer reachable (its `topbar:run-requested` trigger
        // is owned by runtime_controls), but keep it graceful if invoked.
        void dsl; void solverMethod; void t0; void t1; void dt;
        void monteCarlo; void distributions; void scenarioType; void execution; void scenarioName;
        this.#notificationCenter?.warn?.('Notebook DSL simulation is retired — use the Run button.');
    }

    /**
     * Push stored simulation results to a newly-mounted editor (e.g. after tab switch).
     * Called by NotebookPage when a namespace editor is activated.
     * @param {import('../../../notebook/notebook_editor.js').NotebookEditor} editor
     */
    pushStoredResults(editor) {
        if (!this.#storedPlotData || !editor) return;
        this.#pushPlotDataToEditor(editor, this.#storedPlotData, { cached: true });
    }

    /**
     * Push stored results to a ScenarioFileEditor's documentation cells.
     * Called by NotebookPage when a scenario tab is activated.
     * @param {import('../../../notebook/scenario_file_editor.js').ScenarioFileEditor} scenarioEditor
     */
    pushStoredResultsToScenario(scenarioEditor) {
        if (!this.#storedPlotData || !scenarioEditor) return;
        scenarioEditor.pushResults(this.#storedPlotData);
        if (this.#actuals) scenarioEditor.pushActuals(this.#actuals);
    }

    /**
     * Load cached simulation results from the backend for the active scenario.
     * Called once on project open so that plot cells display previous results
     * without requiring a new simulation run.
     *
     * The backend's sim_get_scenario_result falls back to the active scenario
     * when no explicit ID is given, which matches the scenario used by
     * notebook_run_simulation.
     */
    async loadCachedResults() {
        const api = window.pywebview?.api;
        if (!api?.sim_get_scenario_result) return;

        try {
            // Resolve the default scenario name so the backend can look up
            // results stored under the correct named scenario.
            const scenarioPath = this.#resolveScenarioPath();
            let scenarioName = '';
            if (scenarioPath && this.#project) {
                // Ensure the scenario file is loaded so we can read its name
                if (!this.#project.getOpenFile(scenarioPath)) {
                    try { await this.#project.openFile(scenarioPath); } catch { /* ignore */ }
                }
                const scenarioFile = this.#project.getOpenFile(scenarioPath);
                scenarioName = scenarioFile?.content?.name
                    || scenarioPath.split('/').pop()?.replace('.scenario', '')
                    || '';
            }
            const result = await api.sim_get_scenario_result({ scenarioName });
            if (!result?.ok) return;

            const plotData = this.#transformResultToPlotData(result);
            if (!plotData || Object.keys(plotData.series).length === 0) return;

            this.#storedPlotData = plotData;
        } catch (e) {
            // Non-critical — plots stay empty until next run
        }
    }

    /** Last source map from compilation (for error mapping). */
    get lastSourceMap() { return this.#lastSourceMap; }

    // ─── Result routing ──────────────────────────────────────────────────────

    #onSimulationResults(result) {
        if (!result) return;

        const plotData = this.#buildPlotData(result);

        // Don't overwrite good streaming data with an empty completion result
        // (happens when SimulationController's fetchAndStoreResult has no analytics)
        if (Object.keys(plotData.series).length === 0 && this.#storedPlotData && Object.keys(this.#storedPlotData.series).length > 0) {
            return;
        }

        this.#storedPlotData = plotData;

        // Push to the currently active editor
        const editor = this.#page.getEditor();
        if (editor) {
            this.#pushPlotDataToEditor(editor, plotData);
        }

        // Push to the scenario editor's documentation cells (if active)
        this.#page.getScenarioEditor()?.pushResults(plotData);

        // Fetch and push actuals overlays (non-blocking)
        this.fetchAndPushActuals().catch(() => {});
    }

    /**
     * @param {object} editor
     * @param {object} plotData
     * @param {{ streaming?: boolean, cached?: boolean }} [opts]
     */
    #pushPlotDataToEditor(editor, plotData, { streaming = false, cached = false } = {}) {
        if (typeof editor.setResults !== 'function') return;

        if (streaming) {
            // During streaming, update stored results (so deferred cells pick them up)
            // but only push to non-loops renderers (loops trigger expensive re-analysis).
            editor.setResults(plotData, { skipTypes: ['loops'] });
        } else {
            editor.setResults(plotData, { cached });
        }

        // Actuals overlays are separate — push to currently-mounted plot cells
        if (this.#actuals && typeof editor.getCells === 'function') {
            for (const cell of editor.getCells()) {
                if (cell.type !== 'plot') continue;
                const renderer = editor.getCellRenderer(cell.id);
                renderer?.setActuals?.(this.#actuals);
            }
        }
    }

    /**
     * Fetch actuals for all plot cell overlay specs and push to editors.
     * Called after simulation completes or when overlay config changes.
     *
     * Reads overlay configs directly from raw namespace file data so that
     * ALL namespaces are scanned — not just the 1-2 currently mounted editors.
     */
    async fetchAndPushActuals() {
        if (this.#fetchingActuals) return; // prevent concurrent calls
        const api = window.pywebview?.api;
        if (!api?.get_dashboard_actuals) return;

        // Collect overlay specs from ALL namespace files' raw cell data
        const overlays = await this.#collectOverlaySpecsFromProject();
        if (overlays.length === 0) return;

        this.#fetchingActuals = true;
        try {
            const result = await api.get_dashboard_actuals({ overlays });
            if (result?.ok && result.actuals) {
                this.#actuals = result.actuals;
                const activeEditor = this.#page.getEditor();
                if (activeEditor) this.#pushActualsToEditor(activeEditor);
                this.#page.getScenarioEditor()?.pushActuals(result.actuals);
            }
        } catch (err) {
            this.logger?.warn?.('fetchAndPushActuals failed', err);
        } finally {
            this.#fetchingActuals = false;
        }
    }

    /**
     * Scan all namespace and scenario files' cell data for overlay specs.
     * Opens files via ProjectModel if not already open.
     * Handles both legacy flat format ({ series: [...] }) and
     * multi-layout format ({ subplots: [{ yAxes: [{ series }] }] }).
     */
    async #collectOverlaySpecsFromProject() {
        const overlays = [];
        const seen = new Set();

        const collectFromCells = (cells) => {
            for (const cell of cells) {
                if (cell.type !== 'plot') continue;
                const data = cell.data ?? {};

                const allSeries = [];
                for (const sp of data.subplots ?? []) {
                    for (const axis of sp.yAxes ?? []) {
                        allSeries.push(...(axis.series ?? []));
                    }
                }
                if (allSeries.length === 0 && Array.isArray(data.series)) {
                    allSeries.push(...data.series);
                }

                for (const s of allSeries) {
                    if (s.overlay?.etlKey && s.id && !seen.has(s.id)) {
                        seen.add(s.id);
                        overlays.push({ seriesId: s.id, etlKey: s.overlay.etlKey });
                    }
                }
            }
        };

        // Namespace files
        for (const nsPath of this.#project.namespacePaths) {
            if (!this.#project.getOpenFile(nsPath)) {
                await this.#project.openFile(nsPath);
            }
            const file = this.#project.getOpenFile(nsPath);
            collectFromCells(file?.content?.cells ?? []);
        }

        // Scenario files (documentationCells may contain plot cells)
        const files = this.#project.files ?? [];
        for (const f of files) {
            if (f.type !== 'scenario') continue;
            if (!this.#project.getOpenFile(f.path)) {
                await this.#project.openFile(f.path);
            }
            const file = this.#project.getOpenFile(f.path);
            collectFromCells(file?.content?.documentationCells ?? []);
        }

        return overlays;
    }

    #pushActualsToEditor(editor) {
        if (!this.#actuals || typeof editor.getCells !== 'function') return;
        for (const cell of editor.getCells()) {
            if (cell.type !== 'plot') continue;
            editor.getCellRenderer(cell.id)?.setActuals?.(this.#actuals);
        }
    }

    #buildPlotData(result) {
        const analytics = result?.analytics;
        if (!analytics) return { series: {}, time: [] };

        const series = {};
        for (const bucket of [analytics.stocks, analytics.flows, analytics.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                series[key] = Array.isArray(val) ? val : (val.mean ?? val.p50 ?? []);
                const dotIdx = key.indexOf('.');
                if (dotIdx >= 0) {
                    const bare = key.slice(dotIdx + 1);
                    if (!series[bare]) series[bare] = series[key];
                }
            }
        }
        return { series, time: analytics.time ?? [] };
    }

    /**
     * Transform the tabular result from sim_get_scenario_result into the
     * { series, time } format that PlotCell.renderResults() expects.
     *
     * Backend format: headers[] includes a leading 'time' entry but row.cols[]
     * does NOT contain the time column (time lives in row.tDisp). So column
     * indices into row.cols must be offset by the number of skipped headers.
     */
    #transformResultToPlotData(response) {
        const { headers = [], rows = [] } = response;
        if (!headers.length || !rows.length) return null;

        const time = rows.map(row => {
            const t = parseFloat(row.tDisp);
            return isNaN(t) ? row.tDisp : t;
        });

        const series = {};
        let colOffset = 0;

        for (let h = 0; h < headers.length; h++) {
            const raw = headers[h];
            if (raw.toLowerCase() === 'time') { colOffset++; continue; }

            // Strip "stock:" / "flow:" / "indicator:" prefix
            const colonIdx = raw.indexOf(':');
            const varName = colonIdx >= 0 ? raw.slice(colonIdx + 1).trim() : raw;
            // Strip metric suffix like " (mean)"
            const parenIdx = varName.indexOf(' (');
            const clean = parenIdx >= 0 ? varName.slice(0, parenIdx) : varName;

            const dataColIndex = h - colOffset;
            const values = rows.map(row => {
                const v = row.cols?.[dataColIndex];
                if (v === null || v === undefined || v === '') return null;
                const num = parseFloat(v);
                return isNaN(num) ? null : num;
            });

            series[clean] = values;
            // Also add bare name (without namespace prefix)
            const dotIdx = clean.indexOf('.');
            if (dotIdx >= 0) {
                const bare = clean.slice(dotIdx + 1);
                if (!series[bare]) series[bare] = values;
            }
        }

        return { series, time };
    }

    #buildStreamingPlotData(streamingData) {
        const series = {};
        for (const bucket of [streamingData.stocks, streamingData.flows, streamingData.indicators]) {
            if (!bucket) continue;
            for (const [key, val] of Object.entries(bucket)) {
                series[key] = val;
                const dotIdx = key.indexOf('.');
                if (dotIdx >= 0) {
                    const bare = key.slice(dotIdx + 1);
                    if (!series[bare]) series[bare] = val;
                }
            }
        }
        return { series, time: streamingData.time ?? [] };
    }

    // ─── Toolbar state ───────────────────────────────────────────────────────

    #setRunningState(running) {
        const runBtn   = this.#toolbarEl?.querySelector('[data-action="run"]');
        const pauseBtn = this.#toolbarEl?.querySelector('[data-action="pause"]');
        const stopBtn  = this.#toolbarEl?.querySelector('[data-action="stop"]');

        if (runBtn)   { runBtn.disabled = running;   runBtn.toggleAttribute('hidden', running); }
        if (pauseBtn) { pauseBtn.disabled = !running; pauseBtn.toggleAttribute('hidden', !running); }
        if (stopBtn)  { stopBtn.disabled = !running;  stopBtn.toggleAttribute('hidden', !running); }
    }
}
