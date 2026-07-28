/**
 * autocorrelation.js
 *
 * Autocorrelation function (ACF) and partial autocorrelation (PACF) widget.
 * Computes ACF/PACF from simulation output and displays as bar chart
 * with 95% confidence bounds. Useful for validating model dynamics
 * against real-world patterns and detecting periodicity.
 *
 * All computation is frontend-only (no backend call needed).
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    createChartDeferred,
    hexToRgba,
} from '../../charting/plotly_wrapper.js';

export class Autocorrelation extends TileBase {
    static TYPE = 'autocorrelation';
    static TITLE = 'Autocorrelation';
    static ICON = 'signal_cellular_alt';
    static DESCRIPTION = 'Autocorrelation function (ACF/PACF) of simulation output';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static SUPPORTS_COMPARISON = false;

    getDefaultConfig() {
        return {
            variable: null,
            maxLag: 50,
            showPartial: false,
            showBounds: true,
            color: '#2196F3',
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'variable',
                    type: 'select',
                    label: 'Variable',
                    description: 'Select variable to analyze',
                    options: 'variables',
                    required: true,
                },
                {
                    key: 'maxLag',
                    type: 'number',
                    label: 'Maximum Lag',
                    description: 'Maximum number of lags to compute',
                    min: 5,
                    max: 500,
                    default: 50,
                },
                {
                    key: 'showPartial',
                    type: 'checkbox',
                    label: 'Show Partial ACF',
                    description: 'Display partial autocorrelation alongside ACF',
                },
                {
                    key: 'showBounds',
                    type: 'checkbox',
                    label: 'Show Confidence Bounds',
                    description: 'Display 95% confidence interval',
                },
                {
                    key: 'color',
                    type: 'color',
                    label: 'Color',
                },
            ],
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

        const values = Array.isArray(varData) ? varData : varData.mean;
        if (!values || values.length < 4) {
            this.showEmpty('Insufficient data for autocorrelation (need at least 4 points)');
            return;
        }

        const titlePrefix = this.config.showPartial ? 'ACF/PACF' : 'ACF';
        this.setTitle(`${titlePrefix}: ${this.formatLabel(this.config.variable)}`);

        const { traces, layout } = this._buildPlotlyConfig(values);

        this.contentElement.innerHTML = '<div style="width:100%;height:100%;"></div>';
        const container = this.contentElement.firstChild;

        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Build Plotly traces and layout for ACF (and optionally PACF).
     * @param {Array<number>} values - Time series values
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(values) {
        const n = values.length;
        const maxLag = Math.min(this.config.maxLag || 50, n - 1);
        const color = this.config.color || '#2196F3';
        const bound = 1.96 / Math.sqrt(n);

        const acf = this._computeACF(values, maxLag);
        const lags = Array.from({ length: maxLag }, (_, i) => i + 1);
        const acfValues = acf.slice(1); // skip lag 0 (always 1)

        const traces = [];
        const useSubplots = this.config.showPartial;

        // ACF bars
        traces.push({
            type: 'bar',
            x: lags,
            y: acfValues,
            marker: { color },
            name: 'ACF',
            width: 0.6,
            xaxis: 'x',
            yaxis: useSubplots ? 'y2' : 'y',
        });

        // ACF confidence bounds
        if (this.config.showBounds) {
            const boundColor = 'rgba(255, 82, 82, 0.6)';
            traces.push({
                type: 'scatter',
                x: [lags[0], lags[lags.length - 1]],
                y: [bound, bound],
                mode: 'lines',
                line: { color: boundColor, width: 1, dash: 'dash' },
                showlegend: false,
                hoverinfo: 'skip',
                xaxis: 'x',
                yaxis: useSubplots ? 'y2' : 'y',
            });
            traces.push({
                type: 'scatter',
                x: [lags[0], lags[lags.length - 1]],
                y: [-bound, -bound],
                mode: 'lines',
                line: { color: boundColor, width: 1, dash: 'dash' },
                showlegend: false,
                hoverinfo: 'skip',
                xaxis: 'x',
                yaxis: useSubplots ? 'y2' : 'y',
            });
        }

        // Zero line for ACF
        traces.push({
            type: 'scatter',
            x: [lags[0], lags[lags.length - 1]],
            y: [0, 0],
            mode: 'lines',
            line: { color: '#666666', width: 0.5 },
            showlegend: false,
            hoverinfo: 'skip',
            xaxis: 'x',
            yaxis: useSubplots ? 'y2' : 'y',
        });

        // PACF subplot
        if (useSubplots) {
            const pacf = this._computePACF(values, maxLag);
            const pacfValues = pacf.slice(1);

            traces.push({
                type: 'bar',
                x: lags,
                y: pacfValues,
                marker: { color: '#FF9800' },
                name: 'PACF',
                width: 0.6,
                xaxis: 'x2',
                yaxis: 'y',
            });

            if (this.config.showBounds) {
                const boundColor = 'rgba(255, 82, 82, 0.6)';
                traces.push({
                    type: 'scatter',
                    x: [lags[0], lags[lags.length - 1]],
                    y: [bound, bound],
                    mode: 'lines',
                    line: { color: boundColor, width: 1, dash: 'dash' },
                    showlegend: false,
                    hoverinfo: 'skip',
                    xaxis: 'x2',
                    yaxis: 'y',
                });
                traces.push({
                    type: 'scatter',
                    x: [lags[0], lags[lags.length - 1]],
                    y: [-bound, -bound],
                    mode: 'lines',
                    line: { color: boundColor, width: 1, dash: 'dash' },
                    showlegend: false,
                    hoverinfo: 'skip',
                    xaxis: 'x2',
                    yaxis: 'y',
                });
            }

            // Zero line for PACF
            traces.push({
                type: 'scatter',
                x: [lags[0], lags[lags.length - 1]],
                y: [0, 0],
                mode: 'lines',
                line: { color: '#666666', width: 0.5 },
                showlegend: false,
                hoverinfo: 'skip',
                xaxis: 'x2',
                yaxis: 'y',
            });
        }

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 50, r: 20, t: 30, b: 50 },
            bargap: 0,
            showlegend: useSubplots,
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#ffffff' },
                orientation: 'h',
                y: 1.1,
            },
        };

        if (useSubplots) {
            // Two rows: PACF on top, ACF on bottom
            layout.grid = { rows: 2, columns: 1, pattern: 'independent', roworder: 'bottom to top' };
            layout.xaxis = {
                title: { text: '' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                anchor: 'y',
            };
            layout.xaxis2 = {
                title: { text: 'Lag' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                anchor: 'y2',
            };
            layout.yaxis = {
                title: { text: 'PACF' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                domain: [0, 0.45],
            };
            layout.yaxis2 = {
                title: { text: 'ACF' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                domain: [0.55, 1],
            };
        } else {
            layout.xaxis = {
                title: { text: 'Lag' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            };
            layout.yaxis = {
                title: { text: 'Autocorrelation' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            };
        }

        return { traces, layout };
    }

    /**
     * Compute autocorrelation function.
     * @param {Array<number>} values - Time series values
     * @param {number} maxLag - Maximum lag
     * @returns {Array<number>} ACF values for lags 0..maxLag
     * @private
     */
    _computeACF(values, maxLag) {
        const n = values.length;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += values[i];
        const mean = sum / n;

        let variance = 0;
        for (let i = 0; i < n; i++) {
            const d = values[i] - mean;
            variance += d * d;
        }
        variance /= n;

        if (variance === 0) return new Array(maxLag + 1).fill(0);

        const acf = new Array(maxLag + 1);
        for (let lag = 0; lag <= maxLag; lag++) {
            let cross = 0;
            for (let i = 0; i < n - lag; i++) {
                cross += (values[i] - mean) * (values[i + lag] - mean);
            }
            acf[lag] = cross / (n * variance);
        }
        return acf;
    }

    /**
     * Compute partial autocorrelation via Durbin-Levinson recursion.
     * @param {Array<number>} values - Time series values
     * @param {number} maxLag - Maximum lag
     * @returns {Array<number>} PACF values for lags 0..maxLag
     * @private
     */
    _computePACF(values, maxLag) {
        const acf = this._computeACF(values, maxLag);
        const pacf = [1.0]; // lag 0

        if (maxLag < 1 || acf.length < 2) return pacf;

        // Durbin-Levinson algorithm
        let prevPhi = [acf[1]];
        pacf.push(acf[1]);

        for (let k = 1; k < maxLag; k++) {
            // Compute phi_{k+1, k+1}
            let num = acf[k + 1];
            for (let j = 0; j < k; j++) {
                num -= prevPhi[j] * acf[k - j];
            }

            let den = 1;
            for (let j = 0; j < k; j++) {
                den -= prevPhi[j] * acf[j + 1];
            }

            const phiKK = den !== 0 ? num / den : 0;
            pacf.push(phiKK);

            // Update phi coefficients for next iteration
            const newPhi = new Array(k + 1);
            for (let j = 0; j < k; j++) {
                newPhi[j] = prevPhi[j] - phiKK * prevPhi[k - 1 - j];
            }
            newPhi[k] = phiKK;
            prevPhi = newPhi;
        }

        return pacf;
    }

    getExpandData() {
        if (!this.data || !this.data.time) return null;

        const resolved = this.resolveVariable(this.data, 'variable');
        if (!resolved) return null;
        const varData = resolved.varData;

        const values = Array.isArray(varData) ? varData : varData.mean;
        if (!values || values.length < 4) return null;

        const n = values.length;
        const maxLag = Math.min(this.config.maxLag || 50, n - 1);
        const acf = this._computeACF(values, maxLag);

        const { traces, layout } = this._buildPlotlyConfig(values);

        // Build table data
        const tableHeaders = ['Lag', 'ACF'];
        if (this.config.showPartial) {
            tableHeaders.push('PACF');
            const pacf = this._computePACF(values, maxLag);
            const tableRows = [];
            for (let i = 1; i <= maxLag; i++) {
                tableRows.push([i, acf[i], pacf[i]]);
            }
            return {
                title: `Autocorrelation: ${this.formatLabel(this.config.variable)}`,
                traces,
                layout,
                tableHeaders,
                tableRows,
            };
        }

        const tableRows = [];
        for (let i = 1; i <= maxLag; i++) {
            tableRows.push([i, acf[i]]);
        }

        return {
            title: `Autocorrelation: ${this.formatLabel(this.config.variable)}`,
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

registerWidget(Autocorrelation);

export default Autocorrelation;
