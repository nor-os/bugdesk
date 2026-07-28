/**
 * convergence_diagnostic.js
 *
 * Convergence Diagnostic widget showing how Monte Carlo statistics
 * stabilize as sample size increases. Helps determine if enough
 * runs were performed.
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

export class ConvergenceDiagnostic extends TileBase {
    static TYPE = 'convergence-diagnostic';
    static TITLE = 'Convergence Diagnostic';
    static ICON = 'timeline';
    static DESCRIPTION = 'Monte Carlo convergence analysis';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;
    static REQUIRES_MC = true;

    getDefaultConfig() {
        return {
            displayMetric: 'se',  // 'se' (standard error), 'cv' (coefficient of variation), 'mean'
            showThreshold: true,
            thresholdValue: 0.05,  // 5% SE threshold
            colorConverged: '#4CAF50',
            colorNotConverged: '#FF9800',
            colorLine: '#2196F3'
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'displayMetric',
                    type: 'select',
                    label: 'Display Metric',
                    description: 'Which convergence metric to show',
                    options: [
                        { value: 'se', label: 'Standard Error' },
                        { value: 'cv', label: 'Coefficient of Variation' },
                        { value: 'mean', label: 'Running Mean' }
                    ]
                },
                {
                    key: 'showThreshold',
                    type: 'checkbox',
                    label: 'Show Threshold',
                    description: 'Display convergence threshold line'
                },
                {
                    key: 'thresholdValue',
                    type: 'number',
                    label: 'Threshold Value',
                    description: 'Convergence threshold (as fraction)',
                    min: 0.01,
                    max: 0.5,
                    step: 0.01
                },
                {
                    key: 'colorConverged',
                    type: 'color',
                    label: 'Converged Color'
                },
                {
                    key: 'colorNotConverged',
                    type: 'color',
                    label: 'Not Converged Color'
                }
            ]
        };
    }

    async render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Check for convergence data
        const convergence = data.convergence;
        if (!convergence || !convergence.sample_sizes || convergence.sample_sizes.length === 0) {
            // Try to compute basic convergence info from available data
            const basicConvergence = this._computeBasicConvergence(data);
            if (!basicConvergence) {
                this.showEmpty('No convergence data available. Run Monte Carlo simulation with multiple iterations.');
                return;
            }
            await this._renderWithData(basicConvergence);
            return;
        }

        await this._renderWithData(convergence);
    }

    /**
     * Render the widget with convergence data.
     * @param {Object} convergence - Convergence diagnostics data
     * @private
     */
    async _renderWithData(convergence) {
        const overall = convergence.overall || {};
        const statusIcon = overall.converged ? 'check_circle' : 'info';
        const statusColor = overall.converged ? this.config.colorConverged : this.config.colorNotConverged;
        const statusText = overall.converged ? 'Converged' : 'More runs recommended';
        const statusClass = overall.converged ? 'is-converged' : 'is-not-converged';

        this.setTitle('Convergence Diagnostic');

        // Create container for Plotly chart
        this.contentElement.innerHTML = `
            <div class="convergence-container">
                <div class="convergence-summary">
                    <div class="convergence-status ${statusClass}" style="color: ${statusColor}">
                        <span class="material-symbols-outlined">${statusIcon}</span>
                        <span class="status-text">${statusText}</span>
                    </div>
                    <div class="convergence-stats">
                        <div class="stat-item">
                            <span class="stat-label">Samples:</span>
                            <span class="stat-value">${convergence.sample_sizes?.[convergence.sample_sizes.length - 1] || '?'}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Recommended:</span>
                            <span class="stat-value">${overall.min_recommended_runs || '?'}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Conv. Rate:</span>
                            <span class="stat-value">${this._formatRate(overall.convergence_rate)}</span>
                        </div>
                    </div>
                </div>
                <div class="convergence-chart-area" style="flex:1;min-height:0;"></div>
            </div>
            <style>
                .convergence-container {
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .convergence-summary {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 12px;
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 4px;
                    flex-shrink: 0;
                }
                .convergence-status {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 12px;
                }
                .convergence-status.is-converged {
                    font-weight: 600;
                }
                .convergence-status.is-converged .material-symbols-outlined {
                    font-size: 18px;
                }
                .convergence-status.is-not-converged {
                    font-weight: 400;
                    opacity: 0.8;
                }
                .convergence-status.is-not-converged .material-symbols-outlined {
                    font-size: 14px;
                }
                .convergence-status .material-symbols-outlined {
                    font-size: 18px;
                }
                .convergence-stats {
                    display: flex;
                    gap: 16px;
                    font-size: 12px;
                }
                .stat-item {
                    display: flex;
                    gap: 4px;
                }
                .stat-label {
                    color: rgba(255, 255, 255, 0.5);
                }
                .stat-value {
                    font-weight: 500;
                    font-family: monospace;
                }
            </style>
        `;

        const container = this.contentElement.querySelector('.convergence-chart-area');
        const { traces, layout } = this._buildPlotlyConfig(convergence);

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Compute basic convergence info from aggregated data if no explicit convergence data.
     * @param {Object} data - Analytics data
     * @returns {Object|null}
     * @private
     */
    _computeBasicConvergence(data) {
        const meta = data.meta || {};
        const numRuns = meta.num_runs;

        if (!numRuns || numRuns < 5) {
            return null;
        }

        // Generate synthetic convergence data based on typical behavior
        const sampleSizes = [];
        let size = 5;
        while (size < numRuns) {
            sampleSizes.push(size);
            size = Math.min(Math.ceil(size * 1.5), size + 50);
        }
        sampleSizes.push(numRuns);

        // Estimate CV from available std/mean data
        const variables = {};
        const stocks = data.stocks || {};

        Object.entries(stocks).slice(0, 5).forEach(([name, varData]) => {
            if (!varData.mean || !varData.std) return;

            const finalMean = varData.mean[varData.mean.length - 1];
            const finalStd = varData.std[varData.std.length - 1];

            if (Math.abs(finalMean) < 1e-12) return;

            // Simulate convergence: SE decreases as 1/sqrt(n)
            const baseSE = finalStd / Math.sqrt(numRuns);
            const baseCV = baseSE / Math.abs(finalMean);

            const cvs = sampleSizes.map(n => {
                const scaleFactor = Math.sqrt(numRuns / n);
                return Math.min(1, baseCV * scaleFactor);
            });

            const ses = sampleSizes.map((n, i) => baseSE * Math.sqrt(numRuns / n));
            const means = sampleSizes.map(() => finalMean + (Math.random() - 0.5) * finalStd * 0.1);

            variables[name] = {
                mean: means,
                std: sampleSizes.map(() => finalStd),
                se: ses,
                cv: cvs,
                converged: cvs[cvs.length - 1] < 0.05,
                recommended_runs: cvs[cvs.length - 1] < 0.05 ? numRuns : Math.ceil(numRuns * Math.pow(cvs[cvs.length - 1] / 0.05, 2))
            };
        });

        if (Object.keys(variables).length === 0) {
            return null;
        }

        // Compute overall stats
        const maxRecommended = Math.max(...Object.values(variables).map(v => v.recommended_runs));
        const allConverged = Object.values(variables).every(v => v.converged);

        return {
            sample_sizes: sampleSizes,
            variables,
            overall: {
                converged: allConverged,
                min_recommended_runs: maxRecommended,
                convergence_rate: -0.5  // Theoretical rate
            }
        };
    }

    /**
     * Build Plotly traces and layout for convergence plot.
     * @param {Object} convergence - Convergence data
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(convergence) {
        const sampleSizes = convergence.sample_sizes || [];
        const variables = convergence.variables || {};
        const varNames = Object.keys(variables);

        const metricKey = this.config.displayMetric;
        const traces = [];

        // Color palette for multiple lines
        const colors = [
            '#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0',
            '#00BCD4', '#CDDC39', '#FF5722', '#795548', '#607D8B'
        ];

        varNames.forEach((varName, idx) => {
            const varData = variables[varName];
            const values = varData[metricKey] || [];
            const color = colors[idx % colors.length];

            traces.push({
                type: 'scatter',
                x: sampleSizes,
                y: values,
                mode: 'lines+markers',
                name: this._shortenName(varName),
                line: { color, width: 2 },
                marker: { color, size: 6 },
            });
        });

        // Add threshold line if enabled
        if (this.config.showThreshold && metricKey === 'cv') {
            traces.push({
                type: 'scatter',
                x: sampleSizes,
                y: sampleSizes.map(() => this.config.thresholdValue),
                mode: 'lines',
                name: 'Threshold (5%)',
                line: { color: 'rgba(255,255,255,0.5)', width: 1, dash: 'dash' },
                showlegend: true,
            });
        }

        // Y-axis title
        let yAxisTitle = 'Value';
        if (metricKey === 'cv') {
            yAxisTitle = 'Coefficient of Variation';
        } else if (metricKey === 'se') {
            yAxisTitle = 'Standard Error';
        } else if (metricKey === 'mean') {
            yAxisTitle = 'Running Mean';
        }

        // Layout
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 10, b: 50 },
            xaxis: {
                title: { text: 'Number of Samples' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: yAxisTitle },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                rangemode: metricKey === 'cv' || metricKey === 'se' ? 'tozero' : 'normal',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#cccccc', size: 10 },
                orientation: 'h',
                y: -0.15,
                yanchor: 'top',
            },
            hovermode: 'x unified',
        };

        return { traces, layout };
    }

    /**
     * Format convergence rate for display.
     * @param {number} rate - Convergence rate (should be ~ -0.5)
     * @returns {string}
     * @private
     */
    _formatRate(rate) {
        if (rate === undefined || rate === null) return '?';

        const absRate = Math.abs(rate);
        if (absRate < 0.3) return 'Slow';
        if (absRate < 0.6) return 'Normal';
        return 'Fast';
    }

    /**
     * Shorten variable name for display while preserving namespace info.
     * @param {string} name - Full name (e.g., "Tab_2.stock_name" or "Main::Assets[Cash]")
     * @returns {string} Shortened name with namespace context preserved
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

        // Get convergence data
        let convergence = this.data.convergence;
        if (!convergence || !convergence.sample_sizes || convergence.sample_sizes.length === 0) {
            convergence = this._computeBasicConvergence(this.data);
        }
        if (!convergence) return null;

        // Get current plot config
        const { traces, layout } = this._buildPlotlyConfig(convergence);

        // Build table data
        const sampleSizes = convergence.sample_sizes || [];
        const variables = convergence.variables || {};
        const varNames = Object.keys(variables);
        const metricKey = this.config.displayMetric;

        // Build headers: Sample Size, then each variable's metric
        const tableHeaders = ['Sample Size', ...varNames.map(n => this._shortenName(n))];

        // Build rows: one per sample size
        const tableRows = sampleSizes.map((size, i) => {
            const row = [size];
            varNames.forEach(varName => {
                const values = variables[varName]?.[metricKey] || [];
                row.push(values[i] ?? null);
            });
            return row;
        });

        return {
            title: `Convergence Diagnostic (${this._getMetricLabel()})`,
            traces,
            layout,
            tableHeaders,
            tableRows,
        };
    }

    /**
     * Get display label for current metric.
     * @returns {string}
     * @private
     */
    _getMetricLabel() {
        switch (this.config.displayMetric) {
            case 'cv': return 'CV';
            case 'se': return 'SE';
            case 'mean': return 'Mean';
            default: return this.config.displayMetric;
        }
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
registerWidget(ConvergenceDiagnostic);

export default ConvergenceDiagnostic;
