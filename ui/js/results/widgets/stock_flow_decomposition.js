/**
 * stock_flow_decomposition.js
 *
 * Visualization widget showing how individual inflows/outflows contribute
 * to a stock's level over time. Supports stacked area and waterfall modes.
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
    getSeriesColor,
} from '../../charting/plotly_wrapper.js';

/**
 * Palette for flow series — distinct, readable on dark background.
 */
const FLOW_COLORS = [
    '#2196F3', '#FF9800', '#4CAF50', '#E91E63',
    '#9C27B0', '#00BCD4', '#FF5722', '#8BC34A',
    '#3F51B5', '#FFC107', '#009688', '#F44336',
];

export class StockFlowDecomposition extends TileBase {
    static TYPE = 'stock-flow-decomposition';
    static TITLE = 'Stock/Flow Decomposition';
    static ICON = 'waterfall_chart';
    static DESCRIPTION = 'How inflows/outflows contribute to a stock over time';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            stock: null,
            mode: 'stacked',
            showNetFlow: true,
            showStockLevel: true,
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'stock',
                    type: 'select',
                    label: 'Stock',
                    description: 'Select stock to decompose into flows',
                    options: 'variables',
                    required: true,
                },
                {
                    key: 'mode',
                    type: 'select',
                    label: 'View Mode',
                    description: 'Chart visualization type',
                    options: [
                        { value: 'stacked', label: 'Stacked Area' },
                        { value: 'waterfall', label: 'Waterfall' },
                    ],
                },
                {
                    key: 'showNetFlow',
                    type: 'checkbox',
                    label: 'Show Net Flow',
                    description: 'Overlay dashed net-flow line',
                },
                {
                    key: 'showStockLevel',
                    type: 'checkbox',
                    label: 'Show Stock Level',
                    description: 'Show stock value on secondary Y-axis',
                },
            ],
        };
    }

    async render(data) {
        if (!data || !data.time) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Use full (unfiltered) data when available so cross-namespace stocks/flows resolve
        const lookupData = this.fullData || data;

        // Check flow data exists
        if (!lookupData.flows || Object.keys(lookupData.flows).length === 0) {
            this.showEmpty('No flow data available. Re-run simulation to record flows.');
            return;
        }

        // Resolve stock — try exact key, then suffix match, then fall back to indicators
        let stockData = lookupData.stocks?.[this.config.stock];
        if (!stockData) {
            const stockKeys = Object.keys(lookupData.stocks || {});
            const suffix = '.' + this.config.stock;
            const matched = stockKeys.find(k => k.endsWith(suffix));
            if (matched) {
                this.config.stock = matched;
                stockData = lookupData.stocks[matched];
            }
        }
        // Fall back to indicators (e.g., "population" is a calculated aggregate, not a stock)
        if (!stockData && lookupData.indicators) {
            stockData = lookupData.indicators[this.config.stock];
            if (!stockData) {
                const indKeys = Object.keys(lookupData.indicators);
                const suffix = '.' + this.config.stock;
                const matched = indKeys.find(k => k.endsWith(suffix));
                if (matched) {
                    this.config.stock = matched;
                    stockData = lookupData.indicators[matched];
                }
            }
        }
        if (!stockData) {
            this.showEmpty(`Variable "${this.config.stock}" not found in results`);
            return;
        }

        // Find contributing flows for this stock
        const contributingFlows = this._findContributingFlows(
            this.config.stock, lookupData.flows, lookupData.godley_structure
        );

        if (contributingFlows.length === 0) {
            this.showEmpty(`No flows found for stock "${this._shortName(this.config.stock)}"`);
            return;
        }

        this.setTitle(`Decomposition: ${this._shortName(this.config.stock)}`);

        this.contentElement.innerHTML = '<div class="decomp-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.decomp-container');

        // Resolve pre-computed smooth net rate (d(stock)/dt) from backend
        const stockRateData = lookupData.stock_rates?.[this.config.stock];

        const { traces, layout } = this.config.mode === 'waterfall'
            ? this._buildWaterfallConfig(lookupData.time, stockData, contributingFlows, lookupData.flows)
            : this._buildStackedConfig(lookupData.time, stockData, contributingFlows, lookupData.flows, stockRateData);

        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Find flows that contribute to a given stock.
     * Uses godley_structure metadata if available, falls back to name-based heuristic.
     * @returns {Array<{key: string, label: string, sign: number}>}
     * @private
     */
    _findContributingFlows(stockName, flowsData, godleyStructure) {
        const results = [];

        // Extract namespace and sector from stock name
        // e.g., "Main.Banks::Assets[Cash]" -> ns="Main", sector="Banks"
        const dotIdx = stockName.indexOf('.');
        const stockNs = dotIdx >= 0 ? stockName.slice(0, dotIdx) : '';
        const afterDot = dotIdx >= 0 ? stockName.slice(dotIdx + 1) : stockName;

        // Parse sector from the qualified portion
        const colonIdx = afterDot.indexOf('::');
        const stockSector = colonIdx >= 0 ? afterDot.slice(0, colonIdx) : '';

        // Extract account name: "Assets[Cash]" -> "Cash"
        const bracketOpen = afterDot.indexOf('[');
        const bracketClose = afterDot.indexOf(']');
        const stockAccount = (bracketOpen >= 0 && bracketClose >= 0)
            ? afterDot.slice(bracketOpen + 1, bracketClose)
            : afterDot;

        // Strategy 1: Use godley_structure metadata if available
        if (Array.isArray(godleyStructure) && godleyStructure.length > 0) {
            for (const entry of godleyStructure) {
                if (entry.namespace !== stockNs) continue;
                const coeffs = entry.coeffs || {};
                const coeff = coeffs[stockAccount] ?? null;
                if (coeff !== null) {
                    const flowKey = `${entry.namespace}.${entry.transaction}[${entry.sector}]`;
                    if (flowKey in flowsData) {
                        const label = entry.transaction;
                        const isRelevant = coeff !== 0;
                        results.push({
                            key: flowKey,
                            label,
                            sign: isRelevant ? (Math.sign(coeff) || 1) : 1,
                            relevant: isRelevant,
                        });
                    }
                }
            }
        }

        // Strategy 2: Fallback — match flows by namespace + sector name
        if (results.length === 0 && stockNs && stockSector) {
            const prefix = `${stockNs}.`;
            const sectorPattern = `[${stockSector}]`;
            for (const flowKey of Object.keys(flowsData)) {
                if (flowKey.startsWith(prefix) && flowKey.includes(sectorPattern)) {
                    const label = flowKey.slice(prefix.length);
                    results.push({ key: flowKey, label, sign: 1 });
                }
            }
        }

        // Strategy 3: Last resort — all flows in same namespace
        if (results.length === 0 && stockNs) {
            const prefix = `${stockNs}.`;
            for (const flowKey of Object.keys(flowsData)) {
                if (flowKey.startsWith(prefix)) {
                    const label = flowKey.slice(prefix.length);
                    results.push({ key: flowKey, label, sign: 1 });
                }
            }
        }

        return results;
    }

    /**
     * Build stacked area chart: positive flows above zero, negative below.
     * @private
     */
    _buildStackedConfig(time, stockData, contributingFlows, flowsData, stockRateData) {
        const traces = [];
        const stockValues = stockData.mean || stockData;

        // Split flows into relevant (non-zero Godley coefficient for this stock)
        // and context (other namespace flows shown for reference).
        // Only relevant flows participate in stacked areas; context flows are
        // shown as thin non-stacked lines so they don't amplify numerical noise.
        const relevant = [];
        const context = [];
        contributingFlows.forEach((flow, idx) => {
            const rawValues = flowsData[flow.key]?.mean || flowsData[flow.key] || [];
            const signedValues = rawValues.map(v => v * flow.sign);
            const color = FLOW_COLORS[idx % FLOW_COLORS.length];
            const entry = { label: flow.label, values: signedValues, color };
            if (flow.relevant !== false) {
                relevant.push(entry);
            } else {
                context.push(entry);
            }
        });

        // Separate relevant flows into positive and negative groups for stacking
        const positiveFlows = [];
        const negativeFlows = [];
        relevant.forEach(flow => {
            const isPositive = flow.values.reduce((sum, v) => sum + v, 0) >= 0;
            (isPositive ? positiveFlows : negativeFlows).push(flow);
        });

        // Build stacked area traces for positive relevant flows
        positiveFlows.forEach((flow) => {
            traces.push({
                type: 'scatter',
                x: time,
                y: flow.values,
                mode: 'lines',
                name: flow.label,
                stackgroup: 'positive',
                fillcolor: hexToRgba(flow.color, 0.5),
                line: { width: 0.5, color: flow.color },
            });
        });

        // Build stacked area traces for negative relevant flows
        negativeFlows.forEach((flow) => {
            traces.push({
                type: 'scatter',
                x: time,
                y: flow.values,
                mode: 'lines',
                name: flow.label,
                stackgroup: 'negative',
                fillcolor: hexToRgba(flow.color, 0.5),
                line: { width: 0.5, color: flow.color },
            });
        });

        // Context flows: thin non-stacked lines for visual reference
        context.forEach((flow) => {
            traces.push({
                type: 'scatter',
                x: time,
                y: flow.values,
                mode: 'lines',
                name: flow.label,
                line: { width: 1, color: hexToRgba(flow.color, 0.4), dash: 'dot' },
            });
        });

        // Net flow overlay — uses backend-computed d(stock)/dt from finite
        // differences on the dense-output stock trajectory.  Guaranteed smooth
        // because stock values come from the solver's continuous interpolation.
        if (this.config.showNetFlow && Array.isArray(stockRateData) && stockRateData.length > 0) {
            traces.push({
                type: 'scatter',
                x: time,
                y: stockRateData,
                mode: 'lines',
                name: 'Net Flow (dS/dt)',
                line: { color: '#ffffff', width: 2, dash: 'dash' },
            });
        }

        // Stock level on secondary axis
        if (this.config.showStockLevel && Array.isArray(stockValues)) {
            traces.push({
                type: 'scatter',
                x: time,
                y: stockValues,
                mode: 'lines',
                name: 'Stock Level',
                yaxis: 'y2',
                line: { color: '#FFD700', width: 2, dash: 'dot' },
            });
        }

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: this.config.showStockLevel ? 60 : 20, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Time' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: this._flowRateLabel() },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#ffffff', size: 10 },
                orientation: 'h',
                y: 1.12,
            },
            hovermode: 'x unified',
        };

        if (this.config.showStockLevel) {
            layout.yaxis2 = {
                title: { text: this._stockLevelLabel() },
                overlaying: 'y',
                side: 'right',
                gridcolor: 'transparent',
                linecolor: '#444444',
                tickcolor: '#666666',
            };
        }

        return { traces, layout };
    }

    /**
     * Build waterfall chart: period-by-period incremental flow contributions.
     * @private
     */
    _buildWaterfallConfig(time, stockData, contributingFlows, flowsData) {
        // Waterfall shows net contribution per flow aggregated across all time
        // Use Plotly's waterfall chart type
        const flowNames = [];
        const flowValues = [];
        const flowColors = [];
        const stockValues = stockData.mean || stockData;

        // Initial stock value
        const initialValue = Array.isArray(stockValues) ? (stockValues[0] || 0) : 0;
        const finalValue = Array.isArray(stockValues) ? (stockValues[stockValues.length - 1] || 0) : 0;

        // Calculate total contribution of each flow over the simulation
        contributingFlows.forEach((flow, idx) => {
            const rawValues = flowsData[flow.key]?.mean || flowsData[flow.key] || [];
            // Sum the flow values (approximate integral: sum * dt)
            const dt = time.length > 1 ? (time[time.length - 1] - time[0]) / (time.length - 1) : 1;
            const totalContribution = rawValues.reduce((sum, v) => sum + (v * flow.sign), 0) * dt;

            flowNames.push(flow.label);
            flowValues.push(totalContribution);
            flowColors.push(FLOW_COLORS[idx % FLOW_COLORS.length]);
        });

        const measures = flowNames.map(() => 'relative');

        const traces = [{
            type: 'waterfall',
            orientation: 'v',
            x: ['Initial', ...flowNames, 'Final'],
            y: [initialValue, ...flowValues, 0],
            measure: ['absolute', ...measures, 'total'],
            connector: { line: { color: '#555', width: 1 } },
            increasing: { marker: { color: '#4CAF50' } },
            decreasing: { marker: { color: '#F44336' } },
            totals: { marker: { color: '#2196F3' } },
            textposition: 'outside',
            name: 'Contribution',
        }];

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 80 },
            xaxis: {
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
                tickangle: -45,
            },
            yaxis: {
                title: { text: this._stockLevelLabel() || 'Value' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            showlegend: false,
            hovermode: 'closest',
        };

        return { traces, layout };
    }

    /**
     * Build flow rate axis label, appending unit/time if stock has a unit.
     * @returns {string}
     * @private
     */
    _flowRateLabel() {
        const unit = this.getVariableUnit(this.config.stock);
        return unit ? `Flow Rate (${unit}/t)` : 'Flow Rate';
    }

    /**
     * Build stock level axis label with unit if available.
     * @returns {string}
     * @private
     */
    _stockLevelLabel() {
        const unit = this.getVariableUnit(this.config.stock);
        return unit ? `Stock Level (${unit})` : 'Stock Level';
    }

    /**
     * Extract short name from qualified variable name.
     * @private
     */
    _shortName(name) {
        return this.formatLabel(name);
    }

    getExpandData() {
        const d = this.fullData || this.data;
        if (!d || !d.time || !d.flows) return null;

        const stockData = d.stocks?.[this.config.stock]
            || d.indicators?.[this.config.stock];
        if (!stockData) return null;

        const contributingFlows = this._findContributingFlows(
            this.config.stock, d.flows, d.godley_structure
        );
        if (contributingFlows.length === 0) return null;

        const stockRateData = d.stock_rates?.[this.config.stock];
        const { traces, layout } = this.config.mode === 'waterfall'
            ? this._buildWaterfallConfig(d.time, stockData, contributingFlows, d.flows)
            : this._buildStackedConfig(d.time, stockData, contributingFlows, d.flows, stockRateData);

        const stockValues = stockData.mean || stockData;
        const tableHeaders = ['Time', 'Stock Level', ...contributingFlows.map(f => f.label)];
        const tableRows = d.time.map((t, i) => {
            const row = [t, Array.isArray(stockValues) ? (stockValues[i] ?? null) : null];
            contributingFlows.forEach(flow => {
                const vals = d.flows[flow.key]?.mean || d.flows[flow.key] || [];
                row.push((vals[i] ?? 0) * flow.sign);
            });
            return row;
        });

        return {
            title: `Decomposition: ${this._shortName(this.config.stock)}`,
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

registerWidget(StockFlowDecomposition);

export default StockFlowDecomposition;
