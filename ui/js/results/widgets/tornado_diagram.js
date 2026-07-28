/**
 * tornado_diagram.js
 *
 * Tornado diagram widget displaying sensitivity analysis results.
 * Shows horizontal bar chart of parameter sensitivity rankings.
 * Uses Plotly.js for rendering.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    DEFAULT_CONFIG,
    createChartDeferred,
} from '../../charting/plotly_wrapper.js';

export class TornadoDiagram extends TileBase {
    static TYPE = 'tornado-diagram';
    static TITLE = 'Tornado Diagram';
    static ICON = 'tornado';
    static DESCRIPTION = 'Sensitivity analysis bar chart';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static REQUIRES_MC = true;

    getDefaultConfig() {
        return {
            outputVariable: null,
            maxBars: 10,
            showValues: true,
            colorPositive: '#4CAF50',
            colorNegative: '#F44336'
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'outputVariable',
                    type: 'select',
                    label: 'Output Variable',
                    description: 'Variable to analyze sensitivity for',
                    options: 'variables',
                    required: true
                },
                {
                    key: 'maxBars',
                    type: 'number',
                    label: 'Maximum Bars',
                    min: 3,
                    max: 20,
                    description: 'Maximum number of parameters to display'
                },
                {
                    key: 'showValues',
                    type: 'checkbox',
                    label: 'Show Values',
                    description: 'Display sensitivity values on bars'
                },
                {
                    key: 'colorPositive',
                    type: 'color',
                    label: 'Positive Color'
                },
                {
                    key: 'colorNegative',
                    type: 'color',
                    label: 'Negative Color'
                }
            ]
        };
    }

    async render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Auto-select first variable if none selected
        if (!this.config.outputVariable) {
            const firstVar = Object.keys(data.stocks || {})[0];
            if (firstVar) {
                this.config.outputVariable = firstVar;
            } else {
                this.showEmpty('No variables available');
                return;
            }
        }

        // Update title with variable name
        this.setTitle(`Sensitivity: ${this.formatLabel(this.config.outputVariable)}`);

        // Compute sensitivity data
        const sensitivities = this._computeSensitivity(data);

        if (!sensitivities || sensitivities.length === 0) {
            this.showEmpty('No sensitivity data available');
            return;
        }

        // Render using Plotly horizontal bar chart
        await this._renderChart(sensitivities);
    }

    /**
     * Compute sensitivity indices from data.
     *
     * Prefers the backend-computed Jacobian (normalized elasticity) when
     * available — this captures true parameter-to-output sensitivity
     * across MC runs.  Falls back to time-series correlation proxy.
     *
     * @param {Object} data - Analytics data
     * @returns {Array<{param: string, value: number, direction: number}>}
     * @private
     */
    _computeSensitivity(data) {
        const outputVar = this.config.outputVariable;
        const maxBars = this.config.maxBars || 10;

        // Resolve the actual variable name (handles bare → namespace-prefixed)
        const resolved = TileBase.findVariable(data, outputVar);
        const resolvedName = resolved?.varName ?? outputVar;

        // ── Prefer backend jacobian ──────────────────────────────────────
        const jac = data.jacobian;
        if (jac?.outputs?.length && jac.parameters?.length && jac.normalized?.length) {
            // Try exact match, then suffix match against jacobian outputs
            let outIdx = jac.outputs.indexOf(resolvedName);
            if (outIdx < 0) outIdx = jac.outputs.indexOf(outputVar);
            if (outIdx < 0) {
                const suffix = `.${outputVar}`;
                outIdx = jac.outputs.findIndex(o => o.endsWith(suffix));
            }
            if (outIdx >= 0) {
                const row = jac.normalized[outIdx];
                const sensitivities = [];
                for (let j = 0; j < jac.parameters.length; j++) {
                    const val = row[j];
                    if (isFinite(val) && Math.abs(val) > 1e-6) {
                        sensitivities.push({
                            param: jac.parameters[j],
                            value: Math.abs(val),
                            direction: val > 0 ? 1 : -1,
                        });
                    }
                }
                sensitivities.sort((a, b) => b.value - a.value);
                if (sensitivities.length > 0) {
                    return sensitivities.slice(0, maxBars);
                }
            }
        }

        // ── Fallback: time-series correlation proxy ──────────────────────
        const varData = resolved?.varData;
        if (!varData) return null;
        const outputSeries = Array.isArray(varData) ? varData : varData?.mean;
        if (!outputSeries || outputSeries.length < 2) return null;

        const sensitivities = [];
        const allVars = { ...data.stocks, ...data.indicators };

        for (const [name, vData] of Object.entries(allVars)) {
            if (name === outputVar) continue;
            const series = Array.isArray(vData) ? vData : vData?.mean;
            if (!series || series.length < 2) continue;

            const corr = this._pearsonCorrelation(series, outputSeries);
            if (isFinite(corr) && Math.abs(corr) > 0.01) {
                sensitivities.push({
                    param: name,
                    value: Math.abs(corr),
                    direction: corr > 0 ? 1 : -1,
                });
            }
        }

        sensitivities.sort((a, b) => b.value - a.value);
        return sensitivities.slice(0, maxBars);
    }

    /**
     * Compute Pearson correlation between two arrays.
     * @private
     */
    _pearsonCorrelation(x, y) {
        const n = Math.min(x.length, y.length);
        if (n < 2) return 0;

        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, count = 0;
        for (let i = 0; i < n; i++) {
            const xi = x[i], yi = y[i];
            if (!isFinite(xi) || !isFinite(yi)) continue;
            sumX += xi; sumY += yi; sumXY += xi * yi;
            sumX2 += xi * xi; sumY2 += yi * yi;
            count++;
        }
        if (count < 2) return 0;
        const num = count * sumXY - sumX * sumY;
        const den = Math.sqrt((count * sumX2 - sumX * sumX) * (count * sumY2 - sumY * sumY));
        return den === 0 ? 0 : num / den;
    }

    /**
     * Render the tornado chart using Plotly.
     * @param {Array} sensitivities - Sensitivity data
     * @private
     */
    async _renderChart(sensitivities) {
        this.contentElement.innerHTML = '<div class="tornado-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.tornado-container');

        // Prepare data for horizontal bar chart (reverse order so highest is at top)
        const reversed = [...sensitivities].reverse();
        const labels = reversed.map(s => this.formatLabel(s.param));
        const values = reversed.map(s => s.value * s.direction);
        const colors = reversed.map(s =>
            s.direction > 0 ? this.config.colorPositive : this.config.colorNegative
        );

        // Build Plotly trace
        const traces = [{
            type: 'bar',
            x: values,
            y: labels,
            orientation: 'h',
            marker: {
                color: colors,
            },
            text: this.config.showValues ? values.map(v => v.toFixed(3)) : [],
            textposition: 'outside',
            textfont: { color: '#cccccc', size: 10 },
            hovertemplate: '%{y}: %{x:.3f}<extra></extra>',
        }];

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 150, r: 50, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Correlation with Output' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                range: [-1, 1],
                zeroline: true,
                zerolinecolor: '#666666',
                zerolinewidth: 1,
            },
            yaxis: {
                gridcolor: 'transparent',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            showlegend: false,
        };

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Get data for the expanded window.
     * @returns {Object|null} { title, traces, layout, tableHeaders, tableRows }
     */
    getExpandData() {
        if (!this.data) return null;

        const sensitivities = this._computeSensitivity(this.data);
        if (!sensitivities || sensitivities.length === 0) return null;

        // Prepare data for horizontal bar chart (reverse order so highest is at top)
        const reversed = [...sensitivities].reverse();
        const labels = reversed.map(s => this.formatLabel(s.param));
        const values = reversed.map(s => s.value * s.direction);
        const colors = reversed.map(s =>
            s.direction > 0 ? this.config.colorPositive : this.config.colorNegative
        );

        // Build Plotly traces
        const traces = [{
            type: 'bar',
            x: values,
            y: labels,
            orientation: 'h',
            marker: { color: colors },
            text: this.config.showValues ? values.map(v => v.toFixed(3)) : [],
            textposition: 'outside',
            textfont: { color: '#cccccc', size: 10 },
            hovertemplate: '%{y}: %{x:.3f}<extra></extra>',
        }];

        const layout = {
            margin: { l: 150, r: 50, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Correlation with Output' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                range: [-1, 1],
                zeroline: true,
                zerolinecolor: '#666666',
                zerolinewidth: 1,
            },
            yaxis: {
                gridcolor: 'transparent',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            showlegend: false,
        };

        // Build table data
        const tableHeaders = ['Parameter', 'Correlation', 'Direction'];
        const tableRows = sensitivities.map(s => [
            s.param,
            s.value.toFixed(4),
            s.direction > 0 ? 'Positive' : 'Negative',
        ]);

        return {
            title: `Sensitivity: ${this.formatLabel(this.config.outputVariable)}`,
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
registerWidget(TornadoDiagram);

export default TornadoDiagram;
