/**
 * spectral_density.js
 *
 * Power spectral density (PSD) widget for simulation output.
 * Reveals dominant frequencies and periodicities in model dynamics.
 * Uses Welch's method (scipy.signal.welch) via backend computation.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    createChartDeferred,
} from '../../charting/plotly_wrapper.js';

export class SpectralDensity extends TileBase {
    static TYPE = 'spectral-density';
    static TITLE = 'Spectral Density';
    static ICON = 'equalizer';
    static DESCRIPTION = 'Power spectral density (PSD) of simulation output';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static SUPPORTS_COMPARISON = false;

    getDefaultConfig() {
        return {
            variable: null,
            method: 'welch',
            windowType: 'hann',
            detrend: 'linear',
            logScale: true,
            showPeaks: true,
            color: '#FF9800',
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
                    key: 'method',
                    type: 'select',
                    label: 'Method',
                    description: 'PSD estimation method',
                    options: [
                        { value: 'welch', label: "Welch's Method" },
                        { value: 'periodogram', label: 'Periodogram' },
                    ],
                },
                {
                    key: 'windowType',
                    type: 'select',
                    label: 'Window',
                    description: 'Spectral window function',
                    options: [
                        { value: 'hann', label: 'Hann' },
                        { value: 'hamming', label: 'Hamming' },
                        { value: 'blackman', label: 'Blackman' },
                    ],
                },
                {
                    key: 'detrend',
                    type: 'select',
                    label: 'Detrend',
                    description: 'Remove trend before analysis',
                    options: [
                        { value: 'linear', label: 'Linear' },
                        { value: 'constant', label: 'Mean' },
                        { value: 'none', label: 'None' },
                    ],
                },
                {
                    key: 'logScale',
                    type: 'checkbox',
                    label: 'Log Scale (Y-axis)',
                    description: 'Use logarithmic scale for power',
                },
                {
                    key: 'showPeaks',
                    type: 'checkbox',
                    label: 'Annotate Peaks',
                    description: 'Label dominant frequency peaks',
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
        if (!values || values.length < 8) {
            this.showEmpty('Insufficient data for spectral analysis (need at least 8 points)');
            return;
        }

        const dt = data.time.length >= 2 ? data.time[1] - data.time[0] : 1;

        this.showLoading();

        const api = window.pywebview?.api;
        if (!api?.compute_spectral_density) {
            this.showError('Spectral density API not available');
            return;
        }

        const result = await api.compute_spectral_density({
            values,
            dt,
            method: this.config.method,
            windowType: this.config.windowType,
            detrend: this.config.detrend,
        });

        if (!result?.ok) {
            this.showError(result?.error || 'PSD computation failed');
            return;
        }

        this._lastResult = result.data;
        this.setTitle(`PSD: ${this.formatLabel(this.config.variable)}`);

        const { traces, layout } = this._buildPlotlyConfig(result.data);

        this.contentElement.innerHTML = '<div style="width:100%;height:100%;"></div>';
        const container = this.contentElement.firstChild;

        const chartResult = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = chartResult.cleanup;
    }

    /**
     * Build Plotly traces and layout from PSD result.
     * @param {Object} psdData - Backend result data
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(psdData) {
        const { frequencies, psd, dominantPeaks, stats } = psdData;
        const color = this.config.color || '#FF9800';
        const traces = [];

        // Main PSD line
        traces.push({
            type: 'scatter',
            x: frequencies,
            y: psd,
            mode: 'lines',
            line: { color, width: 2 },
            name: 'PSD',
            fill: 'tozeroy',
            fillcolor: `${color}22`,
        });

        // Peak markers with annotations
        if (this.config.showPeaks && dominantPeaks && dominantPeaks.length > 0) {
            const peakFreqs = dominantPeaks.map(p => p.frequency);
            const peakPowers = dominantPeaks.map(p => p.power);
            const peakLabels = dominantPeaks.map(p => {
                if (p.period != null && Number.isFinite(p.period)) {
                    return `T=${this._formatPeriod(p.period)}`;
                }
                return `f=${p.frequency.toFixed(4)}`;
            });

            traces.push({
                type: 'scatter',
                x: peakFreqs,
                y: peakPowers,
                mode: 'markers+text',
                marker: { color: '#FF5252', size: 8, symbol: 'diamond' },
                text: peakLabels,
                textposition: 'top center',
                textfont: { color: '#cccccc', size: 10 },
                name: 'Peaks',
                showlegend: true,
            });
        }

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Frequency' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: 'Power Spectral Density' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                type: this.config.logScale ? 'log' : 'linear',
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
     * Format period value for display.
     * @param {number} period
     * @returns {string}
     * @private
     */
    _formatPeriod(period) {
        if (period >= 100) return period.toFixed(0);
        if (period >= 10) return period.toFixed(1);
        if (period >= 1) return period.toFixed(2);
        return period.toFixed(4);
    }

    getExpandData() {
        if (!this._lastResult) return null;

        const { traces, layout } = this._buildPlotlyConfig(this._lastResult);
        const { frequencies, psd, dominantPeaks } = this._lastResult;

        const tableHeaders = ['Frequency', 'Power'];
        const tableRows = frequencies.map((f, i) => [f, psd[i]]);

        return {
            title: `Spectral Density: ${this.formatLabel(this.config.variable)}`,
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
        this._lastResult = null;
        super.dispose();
    }
}

registerWidget(SpectralDensity);

export default SpectralDensity;
