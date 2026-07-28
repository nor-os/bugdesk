/**
 * correlation_matrix.js
 *
 * Correlation matrix widget displaying a heatmap of variable correlations.
 * Shows Pearson correlation coefficients between all stock/indicator variables.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';

export class CorrelationMatrix extends TileBase {
    static TYPE = 'correlation-matrix';
    static TITLE = 'Correlation Matrix';
    static ICON = 'grid_view';
    static DESCRIPTION = 'Heatmap of variable correlations';
    static DEFAULT_SIZE = { w: 6, h: 5 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 4, maxW: 12, maxH: 10 };
    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            showLabels: true,
            showValues: true,
            colorScale: 'diverging',  // 'diverging' (red-white-blue) or 'sequential'
            variables: []  // Empty = all variables
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'showLabels',
                    type: 'checkbox',
                    label: 'Show Labels',
                    description: 'Display variable names on axes'
                },
                {
                    key: 'showValues',
                    type: 'checkbox',
                    label: 'Show Values',
                    description: 'Display correlation values in cells'
                },
                {
                    key: 'colorScale',
                    type: 'select',
                    label: 'Color Scale',
                    options: [
                        { value: 'diverging', label: 'Diverging (Red-White-Blue)' },
                        { value: 'sequential', label: 'Sequential (Blue)' }
                    ]
                },
                {
                    key: 'variables',
                    type: 'multiselect',
                    label: 'Variables',
                    description: 'Select specific variables (empty = all)',
                    options: 'variables'
                }
            ]
        };
    }

    render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Compute correlation matrix from data
        const correlation = this._computeCorrelation(data);

        if (!correlation || correlation.variables.length < 2) {
            this.showEmpty('Need at least 2 variables for correlation matrix');
            return;
        }

        // Render heatmap
        this._renderHeatmap(correlation);
    }

    getExpandData() {
        if (!this.data) return null;

        const correlation = this._computeCorrelation(this.data);
        if (!correlation || correlation.variables.length < 2) return null;

        const { variables, matrix } = correlation;
        const labels = variables.map(v => this.formatLabel(v));

        // Plotly heatmap trace
        const colorscale = this.config.colorScale === 'sequential'
            ? [[0, '#2a2a2a'], [1, '#4a9eff']]
            : [[0, '#e65100'], [0.5, '#3a3a3a'], [1, '#00bcd4']];

        const traces = [{
            type: 'heatmap',
            z: matrix,
            x: labels,
            y: labels,
            colorscale,
            zmin: -1,
            zmax: 1,
            text: matrix.map((row, i) => row.map((val, j) =>
                `${variables[i]} × ${variables[j]}: ${val.toFixed(3)}`
            )),
            hoverinfo: 'text',
            showscale: true,
            colorbar: { title: 'Correlation', titleside: 'right' },
        }];

        const layout = {
            xaxis: { tickangle: -45, automargin: true },
            yaxis: { autorange: 'reversed', automargin: true },
            margin: { l: 120, r: 80, t: 40, b: 120 },
        };

        // Table data
        const tableHeaders = ['Variable', ...labels];
        const tableRows = matrix.map((row, i) => [labels[i], ...row.map(v => v.toFixed(3))]);

        return { title: 'Correlation Matrix', traces, layout, tableHeaders, tableRows };
    }

    /**
     * Compute correlation matrix from aggregated data.
     *
     * For Monte Carlo runs, uses pre-computed cross-run correlations from the
     * backend (correlates final values of each variable pair across MC runs).
     * For static runs, falls back to temporal Pearson correlation.
     *
     * @param {Object} data - Analytics data
     * @returns {Object} {variables: string[], matrix: number[][]}
     * @private
     */
    /**
     * Check if a variable name matches any of the selected variable names.
     * Supports exact match and suffix match (bare "population" matches "Population.population").
     * @param {string} name - Data key to check
     * @param {Set<string>|null} selectedVars - Set of configured variable names, or null for all
     * @returns {boolean}
     * @private
     */
    _matchesSelected(name, selectedVars) {
        if (!selectedVars) return true;
        if (selectedVars.has(name)) return true;
        // Check suffix: data key "Population.population" matches config "population"
        const dot = name.lastIndexOf('.');
        if (dot >= 0 && selectedVars.has(name.slice(dot + 1))) return true;
        // Check reverse: config "population" matches data key ending with ".population"
        for (const sel of selectedVars) {
            if (sel.indexOf('.') < 0 && name.endsWith(`.${sel}`)) return true;
        }
        return false;
    }

    _computeCorrelation(data) {
        // Prefer backend cross-run correlations for MC results
        const crossRun = data.cross_run_correlations;
        if (crossRun?.variables?.length >= 2 && crossRun.matrix?.length >= 2) {
            const selectedVars = this.config.variables?.length > 0
                ? new Set(this.config.variables)
                : null;
            if (!selectedVars) return crossRun;
            // Filter to selected variables (namespace-aware)
            const indices = [];
            const filteredVars = [];
            for (let i = 0; i < crossRun.variables.length; i++) {
                if (this._matchesSelected(crossRun.variables[i], selectedVars)) {
                    indices.push(i);
                    filteredVars.push(crossRun.variables[i]);
                }
            }
            if (filteredVars.length < 2) return crossRun;
            const filteredMatrix = indices.map(i => indices.map(j => crossRun.matrix[i][j]));
            return { variables: filteredVars, matrix: filteredMatrix };
        }

        // Fallback: temporal correlation from time series
        const variables = [];
        const timeSeries = [];

        const selectedVars = this.config.variables?.length > 0
            ? new Set(this.config.variables)
            : null;

        for (const category of ['stocks', 'flows', 'indicators']) {
            const bucket = data[category];
            if (!bucket) continue;
            for (const [name, varData] of Object.entries(bucket)) {
                if (!this._matchesSelected(name, selectedVars)) continue;
                const series = Array.isArray(varData) ? varData : varData?.mean;
                if (series && series.length > 1) {
                    variables.push(name);
                    timeSeries.push(series);
                }
            }
        }

        if (variables.length < 2) return null;

        const n = variables.length;
        const matrix = [];
        for (let i = 0; i < n; i++) {
            const row = [];
            for (let j = 0; j < n; j++) {
                row.push(i === j ? 1.0 : this._pearsonCorrelation(timeSeries[i], timeSeries[j]));
            }
            matrix.push(row);
        }
        return { variables, matrix };
    }

    /**
     * Compute Pearson correlation between two arrays.
     * @param {number[]} x - First array
     * @param {number[]} y - Second array
     * @returns {number} Correlation coefficient
     * @private
     */
    _pearsonCorrelation(x, y) {
        const n = Math.min(x.length, y.length);
        if (n < 2) return 0;

        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

        for (let i = 0; i < n; i++) {
            const xi = x[i];
            const yi = y[i];
            if (!isFinite(xi) || !isFinite(yi)) continue;

            sumX += xi;
            sumY += yi;
            sumXY += xi * yi;
            sumX2 += xi * xi;
            sumY2 += yi * yi;
        }

        const num = n * sumXY - sumX * sumY;
        const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

        if (den === 0) return 0;
        return num / den;
    }

    /**
     * Render the correlation heatmap.
     * @param {Object} correlation - {variables, matrix}
     * @private
     */
    _renderHeatmap(correlation) {
        const { variables, matrix } = correlation;
        const n = variables.length;

        const cols = this.config.showLabels ? n + 1 : n;
        const labelCol = this.config.showLabels ? 'auto' : '';
        const dataCols = `repeat(${n}, minmax(40px, 1fr))`;
        const gridCols = labelCol ? `${labelCol} ${dataCols}` : dataCols;
        let html = `<div class="correlation-heatmap" style="grid-template-columns: ${gridCols}">`;

        // Header row cells (flat, no row wrapper)
        if (this.config.showLabels) {
            html += '<div class="heatmap-cell corner"></div>';
            variables.forEach(name => {
                const shortName = this.formatLabel(name);
                html += `<div class="heatmap-cell header has-tooltip" data-tooltip="${name}">${shortName}</div>`;
            });
        }

        // Data rows (flat cells, grid wraps automatically)
        for (let i = 0; i < n; i++) {
            // Row label
            if (this.config.showLabels) {
                const shortName = this.formatLabel(variables[i]);
                html += `<div class="heatmap-cell row-label has-tooltip" data-tooltip="${variables[i]}">${shortName}</div>`;
            }

            // Data cells
            for (let j = 0; j < n; j++) {
                const value = matrix[i][j];
                const color = this._getCorrelationColor(value);

                html += `<div class="heatmap-cell data"
                         style="background-color: ${color}; color: #fff"
                         data-var-row="${variables[i]}"
                         data-var-col="${variables[j]}"
                         data-value="${value.toFixed(3)}">
                        ${this.config.showValues ? value.toFixed(2) : ''}
                    </div>`;
            }
        }

        html += '</div>';

        // Add color scale legend
        html += this._renderLegend();

        this.contentElement.innerHTML = html;

        // Set up custom tooltips for all data cells
        this._setupTooltips();
    }

    /**
     * Set up custom tooltips for data cells using LatexTooltip.
     * @private
     */
    _setupTooltips() {
        const cells = this.contentElement.querySelectorAll('.heatmap-cell.data');
        cells.forEach(cell => {
            const varRow = cell.dataset.varRow;
            const varCol = cell.dataset.varCol;
            const value = cell.dataset.value;

            if (window.LatexTooltip) {
                // Use the established tooltip system
                window.LatexTooltip.set(cell, `${varRow} × ${varCol}: ${value}`);
            } else {
                // Fallback to native title if LatexTooltip not available
                cell.title = `${varRow} × ${varCol}: ${value}`;
            }
        });
    }

    /**
     * Get color for a correlation value.
     * Uses app-themed colors: orange for negative, neutral for zero, cyan/blue for positive.
     * @param {number} value - Correlation (-1 to 1)
     * @returns {string} CSS color
     * @private
     */
    _getCorrelationColor(value) {
        if (this.config.colorScale === 'sequential') {
            // Sequential: dark neutral -> app blue
            const intensity = Math.abs(value);
            // Interpolate from #2a2a2a (42,42,42) to #4a9eff (74,158,255)
            const r = Math.round(42 + intensity * (74 - 42));
            const g = Math.round(42 + intensity * (158 - 42));
            const b = Math.round(42 + intensity * (255 - 42));
            return `rgb(${r}, ${g}, ${b})`;
        }

        // Diverging: orange -> neutral -> cyan/blue
        if (value < 0) {
            // Orange for negative correlation
            // Interpolate from #3a3a3a (58,58,58) at 0 to #e65100 (230,81,0) at -1
            const intensity = Math.abs(value);
            const r = Math.round(58 + intensity * (230 - 58));
            const g = Math.round(58 + intensity * (81 - 58));
            const b = Math.round(58 - intensity * 58);
            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // Cyan/Blue for positive correlation
            // Interpolate from #3a3a3a (58,58,58) at 0 to #00bcd4 (0,188,212) at +1
            const intensity = value;
            const r = Math.round(58 - intensity * 58);
            const g = Math.round(58 + intensity * (188 - 58));
            const b = Math.round(58 + intensity * (212 - 58));
            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    /**
     * Render the color scale legend.
     * @returns {string} HTML string
     * @private
     */
    _renderLegend() {
        return `
            <div class="correlation-legend">
                <span class="legend-label">-1</span>
                <div class="legend-gradient ${this.config.colorScale}"></div>
                <span class="legend-label">+1</span>
            </div>
        `;
    }

    /**
     * Render the correlation heatmap to a Canvas for PDF export.
     * Uses a white background with print-friendly colors for readability.
     * @param {Object} data - Analytics data (same format as render())
     * @param {number} [width=1200] - Canvas width in pixels
     * @param {number} [height=800] - Canvas height in pixels
     * @returns {string} data:image/png base64 URL, or '' on failure
     */
    toCanvas(data, width = 1200, height = 800) {
        const correlation = this._computeCorrelation(data);
        if (!correlation || correlation.variables.length < 2) return '';

        const { variables, matrix } = correlation;
        const n = variables.length;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // White background for print
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        // Layout constants — generous header space for rotated labels
        const showLabels = this.config.showLabels !== false;
        const showValues = this.config.showValues !== false;
        const labelFontSize = Math.max(10, Math.min(13, width / (n * 3)));
        const maxLabelLen = Math.max(...variables.map(v => v.length));
        const headerHeight = showLabels ? Math.min(160, maxLabelLen * labelFontSize * 0.5 + 20) : 10;
        const rowLabelWidth = showLabels ? Math.min(160, maxLabelLen * labelFontSize * 0.55 + 20) : 10;
        const legendHeight = 44;
        const padding = 14;

        const gridLeft = rowLabelWidth;
        const gridTop = headerHeight;
        const gridWidth = width - gridLeft - padding;
        const gridHeight = height - gridTop - legendHeight - padding;
        const cellW = gridWidth / n;
        const cellH = gridHeight / n;

        // Column headers (rotated)
        if (showLabels) {
            ctx.save();
            ctx.fillStyle = '#222';
            ctx.font = `bold ${labelFontSize}px sans-serif`;
            ctx.textAlign = 'left';
            for (let j = 0; j < n; j++) {
                const cx = gridLeft + j * cellW + cellW / 2;
                ctx.save();
                ctx.translate(cx, gridTop - 8);
                ctx.rotate(-Math.PI / 4);
                ctx.fillText(this._truncateLabel(variables[j], 18), 0, 0);
                ctx.restore();
            }
            ctx.restore();
        }

        // Row labels
        if (showLabels) {
            ctx.fillStyle = '#222';
            ctx.font = `bold ${labelFontSize}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (let i = 0; i < n; i++) {
                const cy = gridTop + i * cellH + cellH / 2;
                ctx.fillText(this._truncateLabel(variables[i], 18), rowLabelWidth - 8, cy);
            }
        }

        // Heatmap cells with print-friendly colors
        const valueFontSize = Math.max(9, Math.min(13, cellW * 0.35, cellH * 0.4));
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const value = matrix[i][j];
                const x = gridLeft + j * cellW;
                const y = gridTop + i * cellH;

                // Cell background (print-friendly palette)
                ctx.fillStyle = this._getPrintColor(value);
                ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

                // Cell border
                ctx.strokeStyle = '#ccc';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

                // Value text — dark on light cells, white on saturated cells
                if (showValues) {
                    ctx.fillStyle = Math.abs(value) > 0.6 ? '#fff' : '#222';
                    ctx.font = `${valueFontSize}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(value.toFixed(2), x + cellW / 2, y + cellH / 2);
                }
            }
        }

        // Legend bar
        const legendY = height - legendHeight;
        const legendBarW = Math.min(240, width * 0.3);
        const legendBarH = 14;
        const legendX = (width - legendBarW) / 2;
        const legendBarY = legendY + (legendHeight - legendBarH) / 2;

        // Draw gradient
        const steps = 60;
        for (let s = 0; s < steps; s++) {
            const t = s / (steps - 1);
            const val = -1 + 2 * t;
            ctx.fillStyle = this._getPrintColor(val);
            ctx.fillRect(legendX + (legendBarW * s / steps), legendBarY, legendBarW / steps + 1, legendBarH);
        }
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(legendX, legendBarY, legendBarW, legendBarH);

        // Legend labels
        ctx.fillStyle = '#222';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('-1', legendX - 8, legendBarY + legendBarH / 2);
        ctx.textAlign = 'left';
        ctx.fillText('+1', legendX + legendBarW + 8, legendBarY + legendBarH / 2);

        return canvas.toDataURL('image/png');
    }

    /**
     * Print-friendly color for a correlation value.
     * Red for negative, white for zero, blue for positive.
     * @param {number} value
     * @returns {string}
     * @private
     */
    _getPrintColor(value) {
        if (value < 0) {
            // White → Red: (255,255,255) → (198,40,40)
            const t = Math.abs(value);
            const r = Math.round(255 - t * (255 - 198));
            const g = Math.round(255 - t * (255 - 40));
            const b = Math.round(255 - t * (255 - 40));
            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // White → Blue: (255,255,255) → (21,101,192)
            const t = value;
            const r = Math.round(255 - t * (255 - 21));
            const g = Math.round(255 - t * (255 - 101));
            const b = Math.round(255 - t * (255 - 192));
            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    _truncateLabel(name, maxLen) {
        return name.length > maxLen ? name.substring(0, maxLen - 1) + '\u2026' : name;
    }
}

// Register the widget
registerWidget(CorrelationMatrix);

export default CorrelationMatrix;
