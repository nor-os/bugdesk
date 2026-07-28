/**
 * distribution_histogram.js
 *
 * Distribution histogram widget displaying the distribution of final values.
 * Shows histogram with percentile markers and optional normal curve overlay.
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

export class DistributionHistogram extends TileBase {
    static TYPE = 'distribution-histogram';
    static TITLE = 'Distribution';
    static ICON = 'bar_chart';
    static DESCRIPTION = 'Histogram of final value distribution';
    static DEFAULT_SIZE = { w: 4, h: 3 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static REQUIRES_MC = true;

    getDefaultConfig() {
        return {
            variable: null,
            timePoint: 'final',  // 'final', 'initial', or specific index
            bins: 20,
            showPercentileMarkers: true,
            showMeanMarker: true,
            showNormalCurve: false,
            color: '#4CAF50',
            percentileMarkers: [5, 50, 95]
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'variable',
                    type: 'select',
                    label: 'Variable',
                    description: 'Select variable to display',
                    options: 'variables',
                    required: true
                },
                {
                    key: 'timePoint',
                    type: 'select',
                    label: 'Time Point',
                    options: [
                        { value: 'final', label: 'Final Value' },
                        { value: 'initial', label: 'Initial Value' }
                    ]
                },
                {
                    key: 'bins',
                    type: 'number',
                    label: 'Number of Bins',
                    min: 5,
                    max: 100,
                    step: 5
                },
                {
                    key: 'showPercentileMarkers',
                    type: 'checkbox',
                    label: 'Show Percentile Markers',
                    description: 'Display vertical lines at percentiles'
                },
                {
                    key: 'showMeanMarker',
                    type: 'checkbox',
                    label: 'Show Mean Marker',
                    description: 'Display vertical line at mean'
                },
                {
                    key: 'showNormalCurve',
                    type: 'checkbox',
                    label: 'Show Normal Curve',
                    description: 'Overlay normal distribution curve'
                },
                {
                    key: 'color',
                    type: 'color',
                    label: 'Bar Color'
                }
            ]
        };
    }

    async render(data) {
        if (!data || !data.time) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Check if we have MC data with raw runs
        if (data.meta?.type !== 'monte-carlo') {
            this.showEmpty('Distribution requires Monte Carlo data');
            return;
        }

        const resolved = this.resolveVariable(data, 'variable');
        if (!resolved) {
            this.showEmpty('No variables available');
            return;
        }
        const varData = resolved.varData;

        // Update title with variable name
        this.setTitle(`Distribution: ${this.formatLabel(this.config.variable)}`);

        // Get time index
        const timeIndex = this._getTimeIndex(data);

        // Extract values at the specified time point
        const histogramData = this._computeHistogramData(varData, timeIndex);

        if (!histogramData) {
            this.showEmpty('Insufficient data for histogram');
            return;
        }

        // Create container div for Plotly
        this.contentElement.innerHTML = '<div class="histogram-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.histogram-container');

        // Build Plotly configuration
        const { traces, layout } = this._buildPlotlyConfig(histogramData, varData, timeIndex);

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Get the time index to use.
     * @param {Object} data - Analytics data
     * @returns {number} Time index
     * @private
     */
    _getTimeIndex(data) {
        if (!data.time || data.time.length === 0) return 0;

        if (this.config.timePoint === 'initial') {
            return 0;
        } else if (this.config.timePoint === 'final') {
            return data.time.length - 1;
        } else {
            const idx = parseInt(this.config.timePoint, 10);
            return Math.min(Math.max(0, idx), data.time.length - 1);
        }
    }

    /**
     * Compute histogram data from variable data.
     * @param {Object} varData - Variable statistics
     * @param {number} timeIndex - Time point index
     * @returns {Object} Histogram data
     * @private
     */
    _computeHistogramData(varData, timeIndex) {
        // Get range from min/max
        const min = varData.min?.[timeIndex];
        const max = varData.max?.[timeIndex];
        const mean = varData.mean?.[timeIndex];
        const std = varData.std?.[timeIndex];

        if (min == null || max == null || min === max) {
            return null;
        }

        let values = null;

        // If we have raw runs data, use actual values
        if (varData.raw_runs && Array.isArray(varData.raw_runs)) {
            values = varData.raw_runs.map(run => run[timeIndex]).filter(v => v != null);
        } else {
            // Generate synthetic distribution based on percentiles
            values = this._generateSyntheticValues(varData, timeIndex, mean, std);
        }

        return {
            values,
            min,
            max,
            mean,
            std
        };
    }

    /**
     * Generate synthetic values from percentile data.
     * @private
     */
    _generateSyntheticValues(varData, timeIndex, mean, std) {
        const values = [];
        const sampleCount = 1000;

        if (mean != null && std != null && std > 0) {
            // Generate normal distribution samples
            for (let i = 0; i < sampleCount; i++) {
                // Box-Muller transform for normal distribution
                const u1 = Math.random();
                const u2 = Math.random();
                const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
                values.push(mean + std * z);
            }
        } else {
            // Uniform fallback
            const min = varData.min?.[timeIndex] || 0;
            const max = varData.max?.[timeIndex] || 1;
            for (let i = 0; i < sampleCount; i++) {
                values.push(min + Math.random() * (max - min));
            }
        }

        return values;
    }

    /**
     * Build Plotly traces and layout for histogram.
     * @param {Object} histogramData - Computed histogram data
     * @param {Object} varData - Original variable data
     * @param {number} timeIndex - Time point index
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(histogramData, varData, timeIndex) {
        const color = this.config.color || '#4CAF50';
        const traces = [];

        // Main histogram trace (Plotly does binning automatically)
        traces.push({
            type: 'histogram',
            x: histogramData.values,
            nbinsx: this.config.bins || 20,
            marker: {
                color: hexToRgba(color, 0.7),
                line: { color: color, width: 1 }
            },
            name: this.formatLabel(this.config.variable),
            showlegend: false,
        });

        // Prepare vertical line shapes for markers
        const shapes = [];
        const annotations = [];

        // Add mean marker
        if (this.config.showMeanMarker && histogramData.mean != null) {
            shapes.push({
                type: 'line',
                x0: histogramData.mean,
                x1: histogramData.mean,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: { color: '#FF5722', width: 2, dash: 'dash' }
            });
            annotations.push({
                x: histogramData.mean,
                y: 1,
                yref: 'paper',
                text: `Mean: ${this.formatNumber(histogramData.mean)}`,
                showarrow: true,
                arrowhead: 0,
                ax: 30,
                ay: -20,
                font: { color: '#FF5722', size: 10 },
                bgcolor: 'rgba(0,0,0,0.7)',
            });
        }

        // Add percentile markers
        if (this.config.showPercentileMarkers) {
            const percentileColors = {
                5: '#9C27B0',
                25: '#3F51B5',
                50: '#009688',
                75: '#3F51B5',
                95: '#9C27B0'
            };

            this.config.percentileMarkers.forEach(p => {
                const pKey = `p${p}`;
                const pValue = varData[pKey]?.[timeIndex];

                if (pValue != null) {
                    const pColor = percentileColors[p] || '#666';
                    shapes.push({
                        type: 'line',
                        x0: pValue,
                        x1: pValue,
                        y0: 0,
                        y1: 1,
                        yref: 'paper',
                        line: { color: pColor, width: 1.5, dash: 'dot' }
                    });
                    annotations.push({
                        x: pValue,
                        y: 0.95 - (p % 50 === 0 ? 0 : 0.1),
                        yref: 'paper',
                        text: `P${p}`,
                        showarrow: false,
                        font: { color: pColor, size: 9 },
                        bgcolor: 'rgba(0,0,0,0.5)',
                    });
                }
            });
        }

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 50 },
            xaxis: {
                title: { text: this.formatLabel(this.config.variable) },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: 'Count' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            bargap: 0.05,
            shapes,
            annotations,
        };

        return { traces, layout };
    }

    /**
     * Get data for the expanded window.
     * @returns {Object|null} { title, traces, layout, tableHeaders, tableRows }
     */
    getExpandData() {
        if (!this.data || !this.data.time) return null;

        const resolved = this.resolveVariable(this.data, 'variable');
        if (!resolved) return null;
        const varData = resolved.varData;

        const timeIndex = this._getTimeIndex(this.data);
        const histogramData = this._computeHistogramData(varData, timeIndex);
        if (!histogramData) return null;

        // Get current plot config
        const { traces, layout } = this._buildPlotlyConfig(histogramData, varData, timeIndex);

        // Build table data - show histogram bins and their counts
        // For the data tab, show the raw values if available, otherwise summary stats
        const tableHeaders = ['Value'];
        const tableRows = histogramData.values.map(v => [v]);

        // Add summary statistics as the first few rows
        const summaryHeaders = ['Statistic', 'Value'];
        const summaryRows = [
            ['Count', histogramData.values.length],
            ['Mean', histogramData.mean],
            ['Std Dev', histogramData.std],
            ['Min', histogramData.min],
            ['Max', histogramData.max],
        ];

        // Add percentiles if available
        [5, 25, 50, 75, 95].forEach(p => {
            const pKey = `p${p}`;
            if (varData[pKey]?.[timeIndex] != null) {
                summaryRows.push([`P${p}`, varData[pKey][timeIndex]]);
            }
        });

        return {
            title: `Distribution: ${this.formatLabel(this.config.variable)}`,
            traces,
            layout,
            tableHeaders: summaryHeaders,
            tableRows: summaryRows,
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
registerWidget(DistributionHistogram);

export default DistributionHistogram;
