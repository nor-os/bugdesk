/**
 * fan_chart.js
 *
 * Fan chart widget displaying time series with confidence bands.
 * Shows mean line with configurable percentile bands for Monte Carlo results.
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

export class FanChart extends TileBase {
    static TYPE = 'fan-chart';
    static TITLE = 'Fan Chart';
    static ICON = 'show_chart';
    static DESCRIPTION = 'Time series with confidence bands';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static SUPPORTS_COMPARISON = true;

    getDefaultConfig() {
        return {
            variable: null,
            showMean: true,
            showMedian: false,
            showBands: true,
            bands: [
                { lower: 'p5', upper: 'p95', opacity: 0.2 },
                { lower: 'p25', upper: 'p75', opacity: 0.3 }
            ],
            color: '#2196F3',
            showMinMax: false,
            yAxisLabel: '',
            xAxisLabel: 'Time'
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
                    key: 'showMean',
                    type: 'checkbox',
                    label: 'Show Mean Line',
                    description: 'Display mean trajectory'
                },
                {
                    key: 'showMedian',
                    type: 'checkbox',
                    label: 'Show Median Line',
                    description: 'Display median (P50) trajectory'
                },
                {
                    key: 'showBands',
                    type: 'checkbox',
                    label: 'Show Confidence Bands',
                    description: 'Display percentile bands'
                },
                {
                    key: 'showMinMax',
                    type: 'checkbox',
                    label: 'Show Min/Max',
                    description: 'Display minimum and maximum bounds'
                },
                {
                    key: 'color',
                    type: 'color',
                    label: 'Color',
                    description: 'Main color for the chart'
                },
                {
                    key: 'yAxisLabel',
                    type: 'text',
                    label: 'Y-Axis Label',
                    description: 'Label for the Y axis'
                }
            ]
        };
    }

    async render(data) {
        if (!data || !data.time) {
            this.showEmpty('No simulation data available');
            return;
        }

        const resolved = this.resolveVariable(data, 'variable');
        if (!resolved) {
            this.showEmpty('No variables available');
            return;
        }
        const varData = resolved.varData;

        // Update title with variable name
        const isStaticRun = Array.isArray(varData);
        this.setTitle(isStaticRun
            ? `Time Series: ${this.formatLabel(this.config.variable)}`
            : `Fan Chart: ${this.formatLabel(this.config.variable)}`);

        // Create container div for Plotly
        this.contentElement.innerHTML = '<div class="fan-chart-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.fan-chart-container');

        // Build Plotly configuration
        const { traces, layout } = this._buildPlotlyConfig(data.time, varData);

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Build Plotly traces and layout.
     * @param {Array} time - Time array
     * @param {Object} varData - Variable data with mean, std, percentiles
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(time, varData) {
        const traces = [];
        const color = this.config.color || '#2196F3';
        const isArray = Array.isArray(varData);

        if (isArray) {
            // Static run - single trajectory line
            traces.push({
                type: 'scatter',
                x: time,
                y: varData,
                mode: 'lines',
                line: { color, width: 2 },
                name: this.formatLabel(this.config.variable) || 'Value',
            });
        } else {
            // Monte Carlo run - bands, percentiles, mean/median
            // Add confidence bands (Plotly fill='tonexty' needs traces in order)
            if (this.config.showBands && this.config.bands) {
                const reversedBands = [...this.config.bands].reverse();

                reversedBands.forEach((band) => {
                    const lowerData = varData[band.lower];
                    const upperData = varData[band.upper];

                    if (lowerData && upperData) {
                        const bandLabel = `${band.lower.toUpperCase()}-${band.upper.toUpperCase()}`;
                        const bandColor = hexToRgba(color, band.opacity || 0.2);

                        traces.push({
                            type: 'scatter',
                            x: time, y: lowerData,
                            mode: 'lines', line: { width: 0 },
                            showlegend: false, hoverinfo: 'skip',
                            name: `_${band.lower}`,
                        });

                        traces.push({
                            type: 'scatter',
                            x: time, y: upperData,
                            mode: 'lines', line: { width: 0 },
                            fill: 'tonexty', fillcolor: bandColor,
                            name: bandLabel, showlegend: true,
                        });
                    }
                });
            }

            // Min/Max lines
            if (this.config.showMinMax && varData.min && varData.max) {
                traces.push({
                    type: 'scatter',
                    x: time, y: varData.max,
                    mode: 'lines',
                    line: { color: hexToRgba(color, 0.3), width: 1, dash: 'dot' },
                    name: 'Max',
                });
                traces.push({
                    type: 'scatter',
                    x: time, y: varData.min,
                    mode: 'lines',
                    line: { color: hexToRgba(color, 0.3), width: 1, dash: 'dot' },
                    name: 'Min',
                });
            }

            // Median line
            if (this.config.showMedian && varData.p50) {
                traces.push({
                    type: 'scatter',
                    x: time, y: varData.p50,
                    mode: 'lines',
                    line: { color: this._adjustColor(color, -20), width: 2, dash: 'dash' },
                    name: 'Median',
                });
            }

            // Mean line (on top)
            if (this.config.showMean && varData.mean) {
                traces.push({
                    type: 'scatter',
                    x: time, y: varData.mean,
                    mode: 'lines',
                    line: { color, width: 2 },
                    name: 'Mean',
                });
            }
        }

        // Comparison scenario overlays
        if (this.comparisonData) {
            for (const [scenarioId, { name, analytics, color }] of this.comparisonData) {
                const compVar = analytics.stocks?.[this.config.variable]
                    || analytics.flows?.[this.config.variable]
                    || analytics.indicators?.[this.config.variable];
                if (!compVar) continue;

                const compTime = analytics.time || time;
                const compIsArray = Array.isArray(compVar);

                // Comparison line (dashed)
                const yData = compIsArray ? compVar : compVar.mean;
                if (yData) {
                    traces.push({
                        type: 'scatter',
                        x: compTime, y: yData,
                        mode: 'lines',
                        line: { color, width: 2, dash: 'dash' },
                        name: compIsArray ? name : `${name} (Mean)`,
                        opacity: 0.7,
                        legendgroup: `compare-${scenarioId}`,
                    });
                }

                // Comparison IQR band (MC only)
                if (!compIsArray && this.config.showBands && compVar.p25 && compVar.p75) {
                    traces.push({
                        type: 'scatter',
                        x: compTime, y: compVar.p25,
                        mode: 'lines', line: { width: 0 },
                        showlegend: false, hoverinfo: 'skip',
                        legendgroup: `compare-${scenarioId}`,
                    });
                    traces.push({
                        type: 'scatter',
                        x: compTime, y: compVar.p75,
                        mode: 'lines', line: { width: 0 },
                        fill: 'tonexty',
                        fillcolor: hexToRgba(color, 0.1),
                        name: `${name} (IQR)`,
                        showlegend: false,
                        legendgroup: `compare-${scenarioId}`,
                    });
                }
            }
        }

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 50 },
            xaxis: {
                title: { text: this.config.xAxisLabel || '' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: this.config.yAxisLabel || this._buildYAxisLabel() },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#ffffff' },
                orientation: 'h',
                y: 1.1,
            },
            hovermode: 'x unified',
        };

        return { traces, layout };
    }

    /**
     * Build Y-axis label from variable unit when no custom label is set.
     * @returns {string}
     * @private
     */
    _buildYAxisLabel() {
        const unit = this.getVariableUnit(this.config.variable);
        return unit ? `(${unit})` : '';
    }

    /**
     * Adjust color brightness.
     * @param {string} hex - Hex color code
     * @param {number} amount - Amount to adjust (-255 to 255)
     * @returns {string} Adjusted hex color
     * @private
     */
    _adjustColor(hex, amount) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
            let r = parseInt(result[1], 16) + amount;
            let g = parseInt(result[2], 16) + amount;
            let b = parseInt(result[3], 16) + amount;

            r = Math.max(0, Math.min(255, r));
            g = Math.max(0, Math.min(255, g));
            b = Math.max(0, Math.min(255, b));

            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }
        return hex;
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

        // Get current plot config
        const { traces, layout } = this._buildPlotlyConfig(this.data.time, varData);

        // Build table data
        const tableHeaders = ['Time'];
        const isArray = Array.isArray(varData);

        if (isArray) {
            tableHeaders.push('Value');
        } else {
            const metrics = [];
            if (varData.mean) { tableHeaders.push('Mean'); metrics.push('mean'); }
            if (varData.p50) { tableHeaders.push('Median (P50)'); metrics.push('p50'); }
            if (varData.p5) { tableHeaders.push('P5'); metrics.push('p5'); }
            if (varData.p25) { tableHeaders.push('P25'); metrics.push('p25'); }
            if (varData.p75) { tableHeaders.push('P75'); metrics.push('p75'); }
            if (varData.p95) { tableHeaders.push('P95'); metrics.push('p95'); }
            if (varData.min) { tableHeaders.push('Min'); metrics.push('min'); }
            if (varData.max) { tableHeaders.push('Max'); metrics.push('max'); }
            // Store for use below
            tableHeaders._metrics = metrics;
        }

        const tableRows = this.data.time.map((t, i) => {
            const row = [t];
            if (isArray) {
                row.push(varData[i] ?? null);
            } else {
                (tableHeaders._metrics || []).forEach(m => {
                    row.push(varData[m]?.[i] ?? null);
                });
            }
            return row;
        });
        delete tableHeaders._metrics;

        return {
            title: isArray
                ? `Time Series: ${this.formatLabel(this.config.variable)}`
                : `Fan Chart: ${this.formatLabel(this.config.variable)}`,
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
registerWidget(FanChart);

export default FanChart;
