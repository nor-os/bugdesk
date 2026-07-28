/**
 * ReferenceCell — Read-only embedded view of model or scenario content.
 *
 * Config is rendered externally in the slide-out panel via getConfigBinding().
 * The cell body shows the referenced content directly:
 *   - Model source: heading, documentation, parameter cells from a .namespace file
 *   - Scenario source: heading, documentation, plot cells from a .scenario file
 *
 * Data:
 *   {
 *     sourceType: 'model' | 'scenario',
 *     namespace:  string,           // model source — namespace name
 *     scenario:   string,           // scenario source — scenario name
 *     cellId:     string | null,    // specific cell ID (for 'cell' mode)
 *     mode:       'cell' | 'all'    // 'all' = show all doc cells, 'cell' = single cell
 *   }
 *
 * When referencing scenario plot cells, embeds a PlotCell instance via mountBodyOnly()
 * and exposes renderResults() / setScenarioProvider() so PaperPage can push simulation
 * results to the embedded chart.
 */

import { CellBase } from './cell_base.js';
import { markdownToHtml } from './markdown_preview.js';
import { ParameterCell } from './parameter_cell.js';
import { PlotCell } from './plot_cell.js';
import { renderReferenceConfig } from '../../charting/reference_config_panel.js';

/** Cell types shown in 'all' mode per source type. */
const ALL_MODEL_TYPES    = new Set(['heading', 'documentation', 'parameter']);
const ALL_SCENARIO_TYPES = new Set(['heading', 'documentation', 'plot']);

export class ReferenceCell extends CellBase {
    #previewEl = null;
    #sourceType = 'model';
    #namespace = '';
    #scenario = '';
    #cellId = '';
    #mode = 'all';

    /** @type {PlotCell[]} Embedded PlotCell instances for scenario plot references */
    #embeddedPlots = [];

    /** @type {Function|null} Scenario provider from PaperPage */
    #scenarioProvider = null;

    /** Escape HTML entities for safe interpolation. */
    #esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    _getTabs() {
        return [{ id: 'display', label: 'Display' }];
    }

    _getStandardActions() {
        return new Set(['toggle-print']);
    }

    _getExtraActions() {
        return [
            { action: 'open-source', icon: 'open_in_new', title: 'Go to source' },
            { action: 'show-in-dashboard', icon: 'dashboard', title: 'Show in Dashboard' },
        ];
    }

    _onExtraAction(action) {
        if (action === 'open-source') {
            const path = this.#getSourcePath();
            if (path) {
                const opts = this.#mode === 'cell' && this.#cellId ? { cellId: this.#cellId } : {};
                this._props?.onOpenFile?.(path, opts);
            }
        } else if (action === 'show-in-dashboard') {
            this.eventBus?.emit?.('cell:show-in-dashboard', {
                cellId: this._cell.id,
            });
        }
    }

    async renderBody(bodyEl, cell) {
        this.#sourceType = cell.data.sourceType ?? 'model';
        this.#namespace  = cell.data.namespace  ?? '';
        this.#scenario   = cell.data.scenario   ?? '';
        this.#cellId     = cell.data.cellId     ?? '';
        this.#mode       = cell.data.mode       ?? 'all';

        bodyEl.innerHTML = '<div class="reference-cell__preview"></div>';
        this.#previewEl = bodyEl.querySelector('.reference-cell__preview');

        await this.#renderPreview();
    }

    getData() {
        return {
            sourceType: this.#sourceType,
            namespace:  this.#sourceType === 'model'    ? this.#namespace : '',
            scenario:   this.#sourceType === 'scenario' ? this.#scenario  : '',
            cellId:     this.#cellId,
            mode:       this.#mode,
        };
    }

    refreshContent() {
        this.#renderPreview();
    }

    // ─── Plot result integration (paper mode) ─────────────────────────────

    /**
     * Set the scenario provider callback — delegated to embedded PlotCells.
     * Called by PaperPage when the cell is mounted.
     * @param {Function|null} fn — () => Array<{path, name, status}>
     */
    setScenarioProvider(fn) {
        this.#scenarioProvider = fn;
        for (const plot of this.#embeddedPlots) {
            plot.setScenarioProvider(fn);
        }
    }

    /**
     * Push simulation results to all embedded PlotCell instances.
     * Called by PaperPage when results arrive.
     * @param {object} results — merged { series, time } from PaperResultManager
     */
    renderResults(results) {
        for (const plot of this.#embeddedPlots) {
            plot.renderResults(results);
        }
    }

    /**
     * Collect plot cell data from all embedded plots for scenario discovery.
     * Each plot's series has `scenario` injected so PaperResultManager can discover it.
     * @returns {Array<object>} array of plot cell data objects (with scenario field set)
     */
    getEmbeddedPlotData() {
        return this.#embeddedPlots.map(p => p.getData());
    }

    /**
     * Return embedded PlotCell renderer instances for export (image capture).
     * @returns {PlotCell[]}
     */
    getEmbeddedPlotRenderers() {
        return [...this.#embeddedPlots];
    }

    /**
     * Whether this reference cell contains embedded plot cells.
     * Used by PaperPage to decide whether to push results here.
     */
    hasEmbeddedPlots() {
        return this.#embeddedPlots.length > 0;
    }

    // ─── Config binding (for slide-out panel) ────────────────────────────

    getConfigBinding() {
        const binding = {
            sourceType: this.#sourceType,
            namespace:  this.#namespace,
            scenario:   this.#scenario,
            cellId:     this.#cellId,
            mode:       this.#mode,
            project:    this._props?.project ?? null,
            onChange: ({ sourceType, namespace, scenario, cellId, mode }) => {
                this.#sourceType = sourceType;
                this.#namespace  = namespace;
                this.#scenario   = scenario;
                this.#cellId     = cellId;
                this.#mode       = mode;
                this._notifyChange(this.getData());
                this.#renderPreview();
            },
            title: 'Reference Config',
            icon: 'link',
        };
        binding.renderConfig = (container) => {
            renderReferenceConfig(container, binding);
        };
        return binding;
    }

    // ─── Preview rendering ───────────────────────────────────────────────

    async #renderPreview() {
        if (!this.#previewEl) return;

        // Dispose any previous embedded plots
        this.#disposeEmbeddedPlots();

        const sourceName = this.#sourceType === 'model' ? this.#namespace : this.#scenario;
        if (!sourceName) {
            const label = this.#sourceType === 'model' ? 'namespace' : 'scenario';
            this.#previewEl.innerHTML =
                `<div class="reference-cell__empty">Select a ${label} to reference</div>`;
            return;
        }

        const cells = await this.#loadSourceCells();
        if (!cells) {
            const label = this.#sourceType === 'model' ? 'Namespace' : 'Scenario';
            this.#previewEl.innerHTML =
                `<div class="reference-cell__empty">${label} not found</div>`;
            return;
        }

        const docCells = this.#mode === 'all'
            ? this.#extractAllCells(cells)
            : this.#extractSingleCell(cells, this.#cellId);

        if (docCells.length === 0) {
            const target = this.#mode === 'all'
                ? (this.#sourceType === 'model' ? 'namespace' : 'scenario')
                : 'selected cell';
            this.#previewEl.innerHTML =
                `<div class="reference-cell__empty">No documentation found in ${target}</div>`;
            return;
        }

        // Separate plot cells (need embedded PlotCell) from text cells (inline HTML)
        const textCells = docCells.filter(c => c.type !== 'plot');
        const plotCells = docCells.filter(c => c.type === 'plot');

        // Build provenance header
        const suffix = this.#sourceType === 'model' ? '.namespace' : '.scenario';
        const provenanceHtml = `
            <div class="reference-cell__provenance">
                <span class="reference-cell__provenance-label">From</span>
                <span class="reference-cell__provenance-file">${this.#esc(sourceName)}${suffix}</span>
                ${this.#mode === 'cell' && this.#cellId ? '<span class="reference-cell__provenance-label">\u2014 cell</span>' : ''}
            </div>
        `;

        // Build text content
        const textHtml = textCells.map(c => this.#renderTextCell(c)).join('');

        // Create DOM
        this.#previewEl.innerHTML = `
            ${provenanceHtml}
            <div class="reference-cell__content doc-cell-preview">${textHtml}</div>
        `;

        // Mount embedded plot cells
        if (plotCells.length > 0) {
            const contentEl = this.#previewEl.querySelector('.reference-cell__content');
            for (const plotCell of plotCells) {
                await this.#mountEmbeddedPlot(contentEl, plotCell);
            }
        }
    }

    // ─── Embedded PlotCell management ────────────────────────────────────

    async #mountEmbeddedPlot(parentEl, plotCellData) {
        const scenarioPath = this.#getSourcePath();

        // Deep clone the plot data and inject scenario path into every series
        const clonedData = JSON.parse(JSON.stringify(plotCellData.data));
        for (const sp of clonedData.subplots ?? []) {
            for (const axis of sp.yAxes ?? []) {
                for (const s of axis.series ?? []) {
                    if (!s.scenario) s.scenario = scenarioPath;
                }
            }
        }

        // Create container
        const plotContainer = document.createElement('div');
        plotContainer.className = 'reference-cell__embedded-plot';
        parentEl.appendChild(plotContainer);

        // Instantiate and mount PlotCell body-only (no chrome)
        const plotInstance = new PlotCell({
            eventBus: this.eventBus,
            logger:   { createScope: () => console },
            editorFactory: this._editorFactory,
            symbolProvider: this._symbolProvider,
        });

        const fakeCell = {
            id:   `ref-plot-${plotCellData.id}`,
            type: 'plot',
            data: clonedData,
        };

        await plotInstance.mountBodyOnly(plotContainer, {
            cell: fakeCell,
            fileType: 'paper',
            project: this._props?.project ?? null,
        });

        if (this.#scenarioProvider) {
            plotInstance.setScenarioProvider(this.#scenarioProvider);
        }

        this.#embeddedPlots.push(plotInstance);
    }

    #disposeEmbeddedPlots() {
        for (const plot of this.#embeddedPlots) {
            plot.dispose();
        }
        this.#embeddedPlots = [];
    }

    // ─── Source data access ──────────────────────────────────────────────

    async #loadSourceCells() {
        const project = this._props?.project;
        if (!project) return null;

        const path = this.#getSourcePath();
        if (!path) return null;

        let openFile = project.getOpenFile(path);
        if (!openFile) {
            try {
                await project.openFile(path);
                openFile = project.getOpenFile(path);
            } catch {
                return null;
            }
        }

        // Namespace files use `cells`, scenario files use `documentationCells`
        const content = openFile?.content;
        return content?.cells ?? content?.documentationCells ?? null;
    }

    // ─── Cell extraction ─────────────────────────────────────────────────

    #extractAllCells(cells) {
        const allowed = this.#sourceType === 'model' ? ALL_MODEL_TYPES : ALL_SCENARIO_TYPES;
        return cells.filter(c => allowed.has(c.type));
    }

    #extractSingleCell(cells, cellId) {
        if (!cellId) return [];
        const cell = cells.find(c => c.id === cellId);
        return cell ? [cell] : [];
    }

    #renderTextCell(cell) {
        if (cell.type === 'heading') {
            const level = Math.min(cell.data?.level ?? 1, 3);
            const title = cell.data?.title ?? '';
            return `<h${level}>${this.#esc(title)}</h${level}>`;
        }
        if (cell.type === 'documentation') {
            const source = cell.data?.source ?? '';
            return markdownToHtml(source);
        }
        if (cell.type === 'parameter') {
            const parameters = cell.data?.parameters ?? [];
            if (!parameters.length) return '';
            const scenarioCtx = this._props?.getScenarioContext?.() ?? {};
            const isMC = (scenarioCtx.monteCarlo?.runs ?? 0) > 0;
            return ParameterCell.renderAsTable(parameters, { showDistribution: isMC });
        }
        return '';
    }

    // ─── Path helpers ────────────────────────────────────────────────────

    #getSourcePath() {
        if (this.#sourceType === 'model') {
            const paths = this._props?.project?.namespacePaths ?? [];
            const name = this.#namespace;
            return paths.find(p => this.#pathToName(p, '.namespace') === name) ?? `${name}.namespace`;
        }
        const paths = this._props?.project?.scenarioPaths ?? [];
        const name = this.#scenario;
        return paths.find(p => this.#pathToName(p, '.scenario') === name) ?? `scenarios/${name}.scenario`;
    }

    #pathToName(path, suffix) {
        const filename = path.split('/').pop();
        return filename.replace(new RegExp(`\\${suffix}$`), '');
    }

    dispose() {
        this.#disposeEmbeddedPlots();
        this.#previewEl = null;
        super.dispose();
    }
}
