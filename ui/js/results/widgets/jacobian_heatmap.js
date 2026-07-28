/**
 * jacobian_heatmap.js
 *
 * Jacobian/Elasticity Heatmap widget displaying sensitivity of outputs
 * to input parameters as a color-coded matrix.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';

export class JacobianHeatmap extends TileBase {
    static TYPE = 'jacobian-heatmap';
    static TITLE = 'Jacobian Heatmap';
    static ICON = 'grid_view';
    static DESCRIPTION = 'Parameter sensitivity matrix';
    static DEFAULT_SIZE = { w: 6, h: 5 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 10 };
    static REQUIRES_MC = true;
    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            displayMode: 'normalized',  // 'raw' or 'normalized' (elasticity)
            colorScalePositive: '#4CAF50',
            colorScaleNegative: '#F44336',
            colorScaleNeutral: '#1a1a2e',
            showValues: true,
            maxParameters: 10,
            maxOutputs: 10,
            threshold: 0.01  // Hide values below this threshold
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'displayMode',
                    type: 'select',
                    label: 'Display Mode',
                    description: 'Raw Jacobian or normalized elasticity',
                    options: [
                        { value: 'normalized', label: 'Elasticity (% change)' },
                        { value: 'raw', label: 'Raw Jacobian (dY/dX)' }
                    ]
                },
                {
                    key: 'showValues',
                    type: 'checkbox',
                    label: 'Show Values',
                    description: 'Display numeric values in cells'
                },
                {
                    key: 'maxParameters',
                    type: 'number',
                    label: 'Max Parameters',
                    description: 'Maximum number of parameters to show',
                    min: 3,
                    max: 20
                },
                {
                    key: 'maxOutputs',
                    type: 'number',
                    label: 'Max Outputs',
                    description: 'Maximum number of output variables to show',
                    min: 3,
                    max: 20
                },
                {
                    key: 'colorScalePositive',
                    type: 'color',
                    label: 'Positive Color'
                },
                {
                    key: 'colorScaleNegative',
                    type: 'color',
                    label: 'Negative Color'
                }
            ]
        };
    }

    render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Check for jacobian data
        const jacobian = data.jacobian;
        if (!jacobian || !jacobian.matrix || jacobian.matrix.length === 0) {
            this.showEmpty('No Jacobian data available. Run Monte Carlo with parameter distributions to compute sensitivities.');
            return;
        }

        this.setTitle(this.config.displayMode === 'normalized' ? 'Elasticity Heatmap' : 'Jacobian Heatmap');

        // Select matrix based on display mode
        const matrix = this.config.displayMode === 'normalized'
            ? (jacobian.normalized || jacobian.matrix)
            : jacobian.matrix;

        const parameters = jacobian.parameters || [];
        const outputs = jacobian.outputs || [];

        // Filter out duplicate parameters and parameters with all values below threshold
        const { filteredParams, filteredMatrix, paramIndices } = this._filterParameters(
            parameters, matrix, this.config.threshold
        );

        // Limit to configured max
        const displayParams = filteredParams.slice(0, this.config.maxParameters);
        const displayOutputs = outputs.slice(0, this.config.maxOutputs);
        const displayMatrix = filteredMatrix
            .slice(0, this.config.maxOutputs)
            .map(row => row.slice(0, this.config.maxParameters));

        // Build heatmap HTML
        this.contentElement.innerHTML = this._buildHeatmapHtml(
            displayParams,
            displayOutputs,
            displayMatrix,
            jacobian.parameter_ranges || {},
            parameters,
            paramIndices
        );

        // Initialize custom tooltips after rendering
        this._initTooltips();
    }

    getExpandData() {
        if (!this.data) return null;

        const jacobian = this.data.jacobian;
        if (!jacobian?.matrix?.length) return null;

        const matrix = this.config.displayMode === 'normalized'
            ? (jacobian.normalized || jacobian.matrix)
            : jacobian.matrix;

        const parameters = jacobian.parameters || [];
        const outputs = jacobian.outputs || [];

        const { filteredParams, filteredMatrix } = this._filterParameters(
            parameters, matrix, this.config.threshold
        );

        const displayParams = filteredParams.slice(0, this.config.maxParameters);
        const displayOutputs = outputs.slice(0, this.config.maxOutputs);
        const displayMatrix = filteredMatrix
            .slice(0, this.config.maxOutputs)
            .map(row => row.slice(0, this.config.maxParameters));

        const paramLabels = displayParams.map(p => this.formatLabel(p));
        const outputLabels = displayOutputs.map(o => this.formatLabel(o));

        const traces = [{
            type: 'heatmap',
            z: displayMatrix,
            x: paramLabels,
            y: outputLabels,
            colorscale: [
                [0, this.config.colorScaleNegative],
                [0.5, this.config.colorScaleNeutral],
                [1, this.config.colorScalePositive],
            ],
            text: displayMatrix.map((row, i) => row.map((val, j) =>
                `${displayOutputs[i]} ← ${displayParams[j]}: ${this.formatNumber(val)}`
            )),
            hoverinfo: 'text',
            showscale: true,
            colorbar: {
                title: this.config.displayMode === 'normalized' ? 'Elasticity' : 'Jacobian',
                titleside: 'right',
            },
        }];

        const layout = {
            xaxis: { title: 'Parameters', tickangle: -45, automargin: true },
            yaxis: { title: 'Outputs', automargin: true },
            margin: { l: 120, r: 80, t: 40, b: 120 },
        };

        const tableHeaders = ['Output \\ Param', ...paramLabels];
        const tableRows = displayMatrix.map((row, i) => [
            outputLabels[i],
            ...row.map(v => this.formatNumber(v)),
        ]);

        const title = this.config.displayMode === 'normalized'
            ? 'Elasticity Heatmap' : 'Jacobian Heatmap';

        return { title, traces, layout, tableHeaders, tableRows };
    }

    /**
     * Filter out duplicate parameters only.
     * All unique parameters are included regardless of their values.
     * @param {string[]} parameters - Parameter names
     * @param {number[][]} matrix - Original matrix
     * @param {number} threshold - Unused, kept for API compatibility
     * @returns {{ filteredParams: string[], filteredMatrix: number[][], paramIndices: number[] }}
     * @private
     */
    _filterParameters(parameters, matrix, threshold) {
        const seenParams = new Set();
        const validIndices = [];

        // Find indices of unique parameters (skip duplicates only)
        parameters.forEach((param, idx) => {
            // Skip duplicates
            if (seenParams.has(param)) return;
            seenParams.add(param);
            validIndices.push(idx);
        });

        // Build filtered arrays
        const filteredParams = validIndices.map(i => parameters[i]);
        const filteredMatrix = matrix.map(row =>
            validIndices.map(i => row[i] ?? 0)
        );

        return { filteredParams, filteredMatrix, paramIndices: validIndices };
    }

    /**
     * Build HTML for heatmap visualization.
     * @param {string[]} parameters - Parameter names (columns)
     * @param {string[]} outputs - Output variable names (rows)
     * @param {number[][]} matrix - Jacobian/elasticity values
     * @param {Object} paramRanges - Parameter range information
     * @param {string[]} originalParams - Original full parameter names
     * @param {number[]} paramIndices - Indices into original parameters
     * @returns {string} HTML string
     * @private
     */
    _buildHeatmapHtml(parameters, outputs, matrix, paramRanges, originalParams, paramIndices) {
        // Find min/max for color scaling
        let maxAbs = 0;
        matrix.forEach(row => {
            row.forEach(val => {
                maxAbs = Math.max(maxAbs, Math.abs(val));
            });
        });
        maxAbs = maxAbs || 1;  // Prevent division by zero

        // Build header row with custom tooltips
        const headerCells = parameters.map((p, idx) => {
            const shortName = this._shortenName(p);
            const range = paramRanges[p];
            const tooltipLines = [p];
            if (range) {
                tooltipLines.push(`Range: [${this.formatNumber(range.min)}, ${this.formatNumber(range.max)}]`);
                if (range.std !== undefined) {
                    tooltipLines.push(`Std: ${this.formatNumber(range.std)}`);
                }
            }
            const tooltip = this._escapeHtml(tooltipLines.join(' | '));
            return `<th class="param-header has-tooltip" data-tooltip="${tooltip}">${shortName}</th>`;
        }).join('');

        // Build data rows
        const rows = outputs.map((output, i) => {
            const cells = matrix[i].map((val, j) => {
                const color = this._getColor(val, maxAbs);
                const displayVal = val.toFixed(2);  // Always show value rounded to 2 decimals
                const opacity = Math.min(1, Math.abs(val) / maxAbs * 1.5);
                const cellTooltip = this._escapeHtml(`${this._shortenName(output)} ← ${parameters[j]}: ${this.formatNumber(val)}`);

                return `
                    <td class="heatmap-cell has-tooltip"
                        style="background-color: ${color}; opacity: ${0.3 + opacity * 0.7}"
                        data-tooltip="${cellTooltip}">
                        ${this.config.showValues ? `<span class="cell-value">${displayVal}</span>` : ''}
                    </td>
                `;
            }).join('');

            const outputTooltip = this._escapeHtml(output);
            return `
                <tr>
                    <td class="output-label has-tooltip" data-tooltip="${outputTooltip}">${this._shortenName(output)}</td>
                    ${cells}
                </tr>
            `;
        }).join('');

        const helpText = this.config.displayMode === 'normalized'
            ? 'Elasticity measures how sensitive each output is to changes in parameters. A value of 0.5 means a 1% increase in the parameter leads to a 0.5% increase in the output. Green = positive correlation, Red = negative correlation.'
            : 'Jacobian shows the rate of change of outputs with respect to parameters. Larger absolute values indicate stronger sensitivity. Green = positive effect, Red = negative effect.';

        return `
            <div class="jacobian-heatmap-container">
                <div class="jacobian-help-bar">
                    <span class="material-symbols-outlined help-icon has-tooltip" data-tooltip="${this._escapeHtml(helpText)}">help</span>
                    <span class="help-text">Hover over cells for details</span>
                </div>
                <table class="jacobian-heatmap">
                    <thead>
                        <tr>
                            <th class="corner-cell">Output \\ Param</th>
                            ${headerCells}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
                <div class="heatmap-legend">
                    <div class="legend-gradient">
                        <span class="legend-label negative">-${this.formatNumber(maxAbs)}</span>
                        <div class="gradient-bar"></div>
                        <span class="legend-label positive">+${this.formatNumber(maxAbs)}</span>
                    </div>
                    <div class="legend-description">
                        ${this.config.displayMode === 'normalized'
                            ? 'Elasticity: % change in output per % change in parameter'
                            : 'Jacobian: Change in output per unit change in parameter'}
                    </div>
                </div>
            </div>
            <style>
                .jacobian-heatmap-container {
                    height: 100%;
                    overflow: auto;
                    display: flex;
                    flex-direction: column;
                }
                .jacobian-help-bar {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    background: rgba(255, 255, 255, 0.03);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    flex-shrink: 0;
                }
                .jacobian-help-bar .help-icon {
                    font-size: 14px;
                    color: rgba(255, 255, 255, 0.5);
                    cursor: help;
                }
                .jacobian-help-bar .help-icon:hover {
                    color: rgba(255, 255, 255, 0.8);
                }
                .jacobian-help-bar .help-text {
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.4);
                }
                .jacobian-heatmap {
                    display: table;
                    border-collapse: collapse;
                    font-size: 11px;
                    flex: 1;
                    min-width: 100%;
                }
                .jacobian-heatmap thead,
                .jacobian-heatmap tbody {
                    display: table-row-group;
                }
                .jacobian-heatmap tr {
                    display: table-row;
                }
                .jacobian-heatmap th,
                .jacobian-heatmap td {
                    display: table-cell;
                    padding: 6px 8px;
                    text-align: center;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    font-size: 10px;
                    min-height: 20px;
                }
                .jacobian-heatmap thead th {
                    background: #252525;
                    color: rgba(255, 255, 255, 0.85);
                    font-weight: 600;
                    font-size: 10px;
                    position: sticky;
                    top: 0;
                    z-index: 2;
                }
                .jacobian-heatmap .corner-cell {
                    background: #1e1e1e;
                    font-style: italic;
                    font-size: 9px;
                }
                .jacobian-heatmap .param-header {
                    background: #252525;
                    writing-mode: vertical-lr;
                    text-orientation: mixed;
                    transform: rotate(180deg);
                    white-space: nowrap;
                    font-size: 10px;
                    padding: 8px 6px;
                }
                .jacobian-heatmap .output-label {
                    background: #252525;
                    text-align: left;
                    font-weight: 500;
                    font-size: 10px;
                    white-space: nowrap;
                    position: sticky;
                    left: 0;
                    z-index: 1;
                }
                .jacobian-heatmap .heatmap-cell {
                    min-width: 50px;
                    transition: opacity 0.2s;
                    cursor: default;
                }
                .jacobian-heatmap .heatmap-cell:hover {
                    outline: 2px solid white;
                    z-index: 1;
                }
                .jacobian-heatmap .cell-value {
                    color: white;
                    font-size: 9px;
                    font-weight: 500;
                    text-shadow: 0 0 3px rgba(0,0,0,0.8);
                }
                .heatmap-legend {
                    padding: 8px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    flex-shrink: 0;
                }
                .legend-gradient {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    justify-content: center;
                }
                .legend-label {
                    font-size: 10px;
                    font-family: monospace;
                }
                .legend-label.negative { color: ${this.config.colorScaleNegative}; }
                .legend-label.positive { color: ${this.config.colorScalePositive}; }
                .gradient-bar {
                    width: 150px;
                    height: 12px;
                    border-radius: 2px;
                    background: linear-gradient(to right,
                        ${this.config.colorScaleNegative},
                        ${this.config.colorScaleNeutral} 50%,
                        ${this.config.colorScalePositive}
                    );
                }
                .legend-description {
                    text-align: center;
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.5);
                    margin-top: 4px;
                }
            </style>
        `;
    }

    /**
     * Get color for a value based on magnitude and sign.
     * @param {number} value - Jacobian/elasticity value
     * @param {number} maxAbs - Maximum absolute value for scaling
     * @returns {string} CSS color
     * @private
     */
    _getColor(value, maxAbs) {
        const intensity = Math.min(1, Math.abs(value) / maxAbs);

        if (Math.abs(value) < this.config.threshold) {
            return this.config.colorScaleNeutral;
        }

        if (value > 0) {
            return this._interpolateColor(this.config.colorScaleNeutral, this.config.colorScalePositive, intensity);
        } else {
            return this._interpolateColor(this.config.colorScaleNeutral, this.config.colorScaleNegative, intensity);
        }
    }

    /**
     * Interpolate between two hex colors.
     * @param {string} color1 - Start color (hex)
     * @param {string} color2 - End color (hex)
     * @param {number} t - Interpolation factor (0-1)
     * @returns {string} Interpolated hex color
     * @private
     */
    _interpolateColor(color1, color2, t) {
        const r1 = parseInt(color1.slice(1, 3), 16);
        const g1 = parseInt(color1.slice(3, 5), 16);
        const b1 = parseInt(color1.slice(5, 7), 16);

        const r2 = parseInt(color2.slice(1, 3), 16);
        const g2 = parseInt(color2.slice(3, 5), 16);
        const b2 = parseInt(color2.slice(5, 7), 16);

        const r = Math.round(r1 + (r2 - r1) * t);
        const g = Math.round(g1 + (g2 - g1) * t);
        const b = Math.round(b1 + (b2 - b1) * t);

        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    /**
     * Shorten variable/parameter name for display while preserving namespace info.
     * Full name is always available via tooltip.
     * @param {string} name - Full name (e.g., "Tab_2.constant_value" or "Main::Assets[Cash]")
     * @returns {string} Shortened name with namespace context preserved
     * @private
     */
    _shortenName(name) {
        return this.formatLabel(name);
    }

    /**
     * Initialize custom tooltips for elements with has-tooltip class.
     * @private
     */
    _initTooltips() {
        // The tooltip service handles this globally via event delegation
        // Nothing special needed here - the has-tooltip class triggers it
    }

    /**
     * Escape HTML special characters for safe attribute values.
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     * @private
     */
    _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    dispose() {
        super.dispose();
    }
}

// Register the widget
registerWidget(JacobianHeatmap);

export default JacobianHeatmap;
