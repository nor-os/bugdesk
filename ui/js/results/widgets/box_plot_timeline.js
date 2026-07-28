/**
 * box_plot_timeline.js
 *
 * Box Plot Timeline widget displaying distribution evolution over time.
 * Shows p5/p25/p50/p75/p95 percentiles as proper box-and-whisker plots
 * across simulation time steps.
 * Uses Plotly.js for rendering.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    DEFAULT_CONFIG,
    hexToRgba,
    createChartDeferred,
} from '../../charting/plotly_wrapper.js';

export class BoxPlotTimeline extends TileBase {
    static TYPE = 'box-plot-timeline';
    static TITLE = 'Box Plot Timeline';
    static ICON = 'candlestick_chart';
    static DESCRIPTION = 'Distribution evolution over time';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static REQUIRES_MC = true;
    static SUPPORTS_COMPARISON = true;

    getDefaultConfig() {
        return {
            selectedVariable: null,
            showMean: true,
            colorBox: '#3498db',
            colorMedian: '#e74c3c',
            colorMean: '#2ecc71',
            colorWhisker: '#95a5a6',
            maxTimePoints: 20
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'selectedVariable',
                    type: 'variable-select',
                    label: 'Variable',
                    description: 'Variable to display',
                    filter: (varName, varData) => varData.p50 && varData.p50.length > 0
                },
                {
                    key: 'showMean',
                    type: 'checkbox',
                    label: 'Show Mean Line',
                    description: 'Overlay mean values as a line'
                },
                {
                    key: 'maxTimePoints',
                    type: 'number',
                    label: 'Max Time Points',
                    description: 'Maximum number of box plots to show',
                    min: 5,
                    max: 50
                },
                {
                    key: 'colorBox',
                    type: 'color',
                    label: 'Box Color'
                },
                {
                    key: 'colorMedian',
                    type: 'color',
                    label: 'Median Color'
                },
                {
                    key: 'colorMean',
                    type: 'color',
                    label: 'Mean Line Color'
                }
            ]
        };
    }

    async render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Get available variables with percentile data
        const variables = this._getVariablesWithPercentiles(data);

        if (variables.length === 0) {
            this.showEmpty('No variables with percentile data found');
            return;
        }

        // Auto-select first variable if none selected
        const selectedVar = this.config.selectedVariable || variables[0];
        const varData = this._getVariableData(data, selectedVar);

        if (!varData || !varData.p50) {
            this.showEmpty(`No percentile data for ${selectedVar}`);
            return;
        }

        this.setTitle(`Box Plot: ${this._shortenName(selectedVar)}`);

        // Create container div for Plotly
        this.contentElement.innerHTML = '<div class="box-plot-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.box-plot-container');

        // Build Plotly configuration
        const { traces, layout } = this._buildPlotlyConfig(data, varData, selectedVar);

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Get list of variables that have percentile data.
     * @param {Object} data - Analytics data
     * @returns {string[]}
     * @private
     */
    _getVariablesWithPercentiles(data) {
        const variables = [];

        Object.entries(data.stocks || {}).forEach(([name, varData]) => {
            if (varData.p50 && varData.p50.length > 0) {
                variables.push(name);
            }
        });

        Object.entries(data.indicators || {}).forEach(([name, varData]) => {
            if (varData.p50 && varData.p50.length > 0) {
                variables.push(name);
            }
        });

        return variables.sort();
    }

    /**
     * Get variable data from either stocks or indicators.
     * Uses TileBase.findVariable for namespace-aware lookup.
     * @param {Object} data - Analytics data
     * @param {string} varName - Variable name
     * @returns {Object|null}
     * @private
     */
    _getVariableData(data, varName) {
        const resolved = TileBase.findVariable(data, varName);
        return resolved?.varData ?? null;
    }

    /**
     * Build Plotly traces and layout for box plot timeline.
     * @param {Object} data - Full analytics data
     * @param {Object} varData - Variable data with percentiles
     * @param {string} varName - Variable name
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(data, varData, varName) {
        const traces = [];
        const time = data.time || [];
        const n = time.length;
        const maxPoints = this.config.maxTimePoints || 20;
        const step = Math.max(1, Math.ceil(n / maxPoints));

        // Sample time points
        const indices = [];
        for (let i = 0; i < n; i += step) {
            indices.push(i);
        }
        if (n > 0 && indices[indices.length - 1] !== n - 1) {
            indices.push(n - 1);
        }

        // For Plotly box plots, we need to create one trace per time point
        // Using lowerfence/upperfence for whiskers, q1/median/q3 for box
        indices.forEach((idx, i) => {
            const t = time[idx] || idx;
            const p5 = varData.p5?.[idx] ?? varData.p25?.[idx] ?? 0;
            const p25 = varData.p25?.[idx] ?? 0;
            const p50 = varData.p50?.[idx] ?? 0;
            const p75 = varData.p75?.[idx] ?? 0;
            const p95 = varData.p95?.[idx] ?? varData.p75?.[idx] ?? 0;

            traces.push({
                type: 'box',
                x: [t.toFixed(1)],
                lowerfence: [p5],
                q1: [p25],
                median: [p50],
                q3: [p75],
                upperfence: [p95],
                marker: {
                    color: this.config.colorBox || '#3498db',
                },
                line: {
                    color: this.config.colorBox || '#3498db',
                },
                fillcolor: hexToRgba(this.config.colorBox || '#3498db', 0.6),
                showlegend: i === 0,
                name: 'IQR (25-75%)',
                boxpoints: false,
            });
        });

        // Add mean line if enabled
        if (this.config.showMean && varData.mean) {
            const meanX = [];
            const meanY = [];

            indices.forEach(idx => {
                meanX.push((time[idx] || idx).toFixed(1));
                meanY.push(varData.mean[idx] ?? varData.p50[idx] ?? 0);
            });

            traces.push({
                type: 'scatter',
                x: meanX,
                y: meanY,
                mode: 'lines',
                line: {
                    color: this.config.colorMean || '#2ecc71',
                    width: 2,
                    dash: 'dash',
                },
                name: 'Mean',
            });
        }

        // Comparison scenario overlays — dashed mean lines
        if (this.comparisonData) {
            for (const [scenarioId, { name, analytics, color }] of this.comparisonData) {
                const compVar = analytics.stocks?.[varName]
                    || analytics.flows?.[varName]
                    || analytics.indicators?.[varName];
                if (!compVar?.mean) continue;

                const compTime = analytics.time || time;
                const compMeanX = [];
                const compMeanY = [];

                indices.forEach(idx => {
                    const t = compTime[idx] ?? time[idx] ?? idx;
                    compMeanX.push(t.toFixed(1));
                    compMeanY.push(compVar.mean[idx] ?? null);
                });

                traces.push({
                    type: 'scatter',
                    x: compMeanX,
                    y: compMeanY,
                    mode: 'lines',
                    line: { color, width: 2, dash: 'dash' },
                    name: `${name} (Mean)`,
                    opacity: 0.7,
                    legendgroup: `compare-${scenarioId}`,
                });
            }
        }

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Time' },
                type: 'category',
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: this._labelWithUnit(varName) },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#cccccc', size: 10 },
                orientation: 'h',
                y: 1.1,
            },
            boxmode: 'group',
        };

        return { traces, layout };
    }

    /**
     * Build axis label with optional unit suffix.
     * @param {string} varName - Variable name
     * @returns {string}
     * @private
     */
    _labelWithUnit(varName) {
        const label = this._shortenName(varName);
        const unit = this.getVariableUnit(varName);
        return unit ? `${label} (${unit})` : label;
    }

    /**
     * Format variable name for display using shared formatter.
     * @param {string} name - Full name
     * @returns {string}
     * @private
     */
    _shortenName(name) {
        return this.formatLabel(name);
    }

    /**
     * Get data for the expanded window.
     * @returns {Object|null} { title, traces, layout, tableHeaders, tableRows }
     */
    getExpandData() {
        if (!this.data) return null;

        const variables = this._getVariablesWithPercentiles(this.data);
        if (variables.length === 0) return null;

        const selectedVar = this.config.selectedVariable || variables[0];
        const varData = this._getVariableData(this.data, selectedVar);
        if (!varData || !varData.p50) return null;

        // Get current plot config
        const { traces, layout } = this._buildPlotlyConfig(this.data, varData, selectedVar);

        // Build table data
        const tableHeaders = ['Time', 'P5', 'P25', 'Median (P50)', 'P75', 'P95'];
        if (varData.mean) tableHeaders.push('Mean');

        const time = this.data.time || [];
        const tableRows = time.map((t, i) => {
            const row = [
                t,
                varData.p5?.[i] ?? null,
                varData.p25?.[i] ?? null,
                varData.p50?.[i] ?? null,
                varData.p75?.[i] ?? null,
                varData.p95?.[i] ?? null,
            ];
            if (varData.mean) row.push(varData.mean[i] ?? null);
            return row;
        });

        return {
            title: `Box Plot: ${selectedVar}`,
            traces,
            layout,
            tableHeaders,
            tableRows,
        };
    }

    dispose() {
        if (this._chartCleanup) {
            this._chartCleanup();
            this._chartCleanup = null;
        }
        if (this.plotContainer && hasPlot(this.plotContainer)) {
            plotlyPurge(this.plotContainer);
        }
        this.plotContainer = null;
        super.dispose();
    }
}

// Register the widget
registerWidget(BoxPlotTimeline);

export default BoxPlotTimeline;
