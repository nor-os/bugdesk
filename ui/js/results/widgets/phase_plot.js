/**
 * phase_plot.js
 *
 * Phase plot widget displaying one variable against another as a trajectory.
 * Supports direction arrows, time-coloring, and start/end markers.
 * Uses Plotly.js for rendering.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    hexToRgba,
    createChartDeferred,
} from '../../charting/plotly_wrapper.js';

export class PhasePlot extends TileBase {
    static TYPE = 'phase-plot';
    static TITLE = 'Phase Plot';
    static ICON = 'timeline';
    static DESCRIPTION = 'Plot one variable against another (trajectory)';
    static DEFAULT_SIZE = { w: 5, h: 5 };
    static SIZE_CONSTRAINTS = { minW: 3, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            xVariable: null,
            yVariable: null,
            showArrows: true,
            colorByTime: false,
            arrowDensity: 10,
            lineWidth: 2,
            color: '#268bd2',
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'xVariable',
                    type: 'select',
                    label: 'X Variable',
                    description: 'Variable for horizontal axis',
                    options: 'variables',
                    required: true,
                },
                {
                    key: 'yVariable',
                    type: 'select',
                    label: 'Y Variable',
                    description: 'Variable for vertical axis',
                    options: 'variables',
                    required: true,
                },
                {
                    key: 'showArrows',
                    type: 'checkbox',
                    label: 'Show Direction Arrows',
                    description: 'Display arrows along the trajectory',
                },
                {
                    key: 'colorByTime',
                    type: 'checkbox',
                    label: 'Color by Time',
                    description: 'Color the trajectory by time progression',
                },
                {
                    key: 'arrowDensity',
                    type: 'range',
                    label: 'Arrow Density',
                    description: 'Number of arrows along trajectory',
                    min: 3,
                    max: 30,
                    step: 1,
                },
                {
                    key: 'color',
                    type: 'color',
                    label: 'Trajectory Color',
                    description: 'Color when not using time coloring',
                },
            ],
        };
    }

    async render(data) {
        if (!data || !data.time) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Auto-select first two variables if not set
        const allVars = [
            ...Object.keys(data.stocks || {}),
            ...Object.keys(data.flows || {}),
            ...Object.keys(data.indicators || {}),
        ];
        if (!this.config.xVariable && allVars.length >= 1) {
            this.config.xVariable = allVars[0];
        }
        if (!this.config.yVariable && allVars.length >= 2) {
            this.config.yVariable = allVars[1];
        }
        if (!this.config.xVariable || !this.config.yVariable) {
            this.showEmpty('Select X and Y variables');
            return;
        }

        const resolvedX = this.resolveVariable(data, 'xVariable');
        if (!resolvedX) {
            this.showEmpty('No variables available for X axis');
            return;
        }
        const resolvedY = this.resolveVariable(data, 'yVariable');
        if (!resolvedY) {
            this.showEmpty('No variables available for Y axis');
            return;
        }
        const xVarData = resolvedX.varData;
        const yVarData = resolvedY.varData;

        // Extract mean values (or raw values for non-MC)
        const xValues = xVarData.mean || xVarData;
        const yValues = yVarData.mean || yVarData;

        if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length === 0) {
            this.showEmpty('Insufficient data for phase plot');
            return;
        }

        this.setTitle(`Phase: ${this._shortName(this.config.xVariable)} vs ${this._shortName(this.config.yVariable)}`);

        this.contentElement.innerHTML = '<div class="phase-plot-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.phase-plot-container');

        const { traces, layout } = this._buildPlotlyConfig(xValues, yValues, data.time);

        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Extract a short display name from a fully-qualified variable name.
     * @private
     */
    _shortName(name) {
        return this.formatLabel(name);
    }

    /**
     * Build Plotly traces and layout for the phase plot.
     * @param {Array<number>} xValues
     * @param {Array<number>} yValues
     * @param {Array<number>} time
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(xValues, yValues, time) {
        const traces = [];
        const color = this.config.color || '#268bd2';
        const colorByTime = this.config.colorByTime;

        // Main trajectory trace
        const trace = {
            type: 'scatter',
            x: xValues,
            y: yValues,
            mode: 'lines+markers',
            marker: {
                size: 3,
                color: colorByTime ? time : color,
                colorscale: colorByTime ? 'Viridis' : undefined,
                showscale: colorByTime,
                colorbar: colorByTime ? { title: { text: 'Time', font: { color: '#ccc' } }, tickfont: { color: '#aaa' } } : undefined,
            },
            line: {
                color: colorByTime ? undefined : color,
                width: this.config.lineWidth || 2,
            },
            text: time.map(t => `t = ${t.toFixed(2)}`),
            hovertemplate: `X: %{x:.4f}<br>Y: %{y:.4f}<br>%{text}<extra></extra>`,
            name: 'Trajectory',
            showlegend: false,
        };
        traces.push(trace);

        // Start marker (green circle)
        traces.push({
            type: 'scatter',
            x: [xValues[0]],
            y: [yValues[0]],
            mode: 'markers',
            marker: { size: 10, color: '#2ecc71', symbol: 'circle', line: { width: 1, color: '#fff' } },
            name: `Start (t=${time[0].toFixed(1)})`,
            hovertemplate: `Start<br>X: %{x:.4f}<br>Y: %{y:.4f}<extra></extra>`,
        });

        // End marker (red square)
        const lastIdx = xValues.length - 1;
        traces.push({
            type: 'scatter',
            x: [xValues[lastIdx]],
            y: [yValues[lastIdx]],
            mode: 'markers',
            marker: { size: 10, color: '#e74c3c', symbol: 'square', line: { width: 1, color: '#fff' } },
            name: `End (t=${time[Math.min(lastIdx, time.length - 1)].toFixed(1)})`,
            hovertemplate: `End<br>X: %{x:.4f}<br>Y: %{y:.4f}<extra></extra>`,
        });

        // Build arrow annotations
        const annotations = this.config.showArrows
            ? this._buildArrowAnnotations(xValues, yValues, color)
            : [];

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: colorByTime ? 80 : 20, t: 30, b: 50 },
            xaxis: {
                title: { text: this._labelWithUnit(this.config.xVariable) },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: this._labelWithUnit(this.config.yVariable) },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#ffffff', size: 10 },
                orientation: 'h',
                y: 1.1,
            },
            hovermode: 'closest',
            annotations,
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
        const label = this._shortName(varName);
        const unit = this.getVariableUnit(varName);
        return unit ? `${label} (${unit})` : label;
    }

    /**
     * Build arrow annotations at evenly spaced intervals along the trajectory.
     * @param {Array<number>} xValues
     * @param {Array<number>} yValues
     * @param {string} color
     * @returns {Array<Object>} Plotly annotation objects
     * @private
     */
    _buildArrowAnnotations(xValues, yValues, color) {
        const density = this.config.arrowDensity || 10;
        const step = Math.max(1, Math.floor(xValues.length / density));
        const annotations = [];

        for (let i = step; i < xValues.length; i += step) {
            const dx = xValues[i] - xValues[i - 1];
            const dy = yValues[i] - yValues[i - 1];
            if (dx === 0 && dy === 0) continue;

            annotations.push({
                x: xValues[i],
                y: yValues[i],
                ax: xValues[i - 1],
                ay: yValues[i - 1],
                xref: 'x',
                yref: 'y',
                axref: 'x',
                ayref: 'y',
                showarrow: true,
                arrowhead: 2,
                arrowsize: 1.5,
                arrowwidth: 1.5,
                arrowcolor: this.config.colorByTime ? '#aaaaaa' : color,
            });
        }

        return annotations;
    }

    getExpandData() {
        if (!this.data || !this.data.time) return null;

        const resolvedX = this.resolveVariable(this.data, 'xVariable');
        const resolvedY = this.resolveVariable(this.data, 'yVariable');
        if (!resolvedX || !resolvedY) return null;
        const xVarData = resolvedX.varData;
        const yVarData = resolvedY.varData;

        const xValues = xVarData.mean || xVarData;
        const yValues = yVarData.mean || yVarData;

        const { traces, layout } = this._buildPlotlyConfig(xValues, yValues, this.data.time);

        const xName = this._shortName(this.config.xVariable);
        const yName = this._shortName(this.config.yVariable);

        const tableHeaders = ['Time', xName, yName];
        const tableRows = this.data.time.map((t, i) => [
            t,
            xValues[i] ?? null,
            yValues[i] ?? null,
        ]);

        return {
            title: `Phase Plot: ${xName} vs ${yName}`,
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

registerWidget(PhasePlot);

export default PhasePlot;
