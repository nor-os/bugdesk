/**
 * sector_balance_sheet.js
 *
 * Sector Balance Sheet widget displaying aggregated Assets/Liabilities/Equity
 * per sector as stacked horizontal bars. Shows all sectors side-by-side using
 * mean values from Monte Carlo results.
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
    getSeriesColor,
} from '../../charting/plotly_wrapper.js';

export class SectorBalanceSheet extends TileBase {
    static TYPE = 'sector-balance-sheet';
    static TITLE = 'Sector Balance Sheet';
    static ICON = 'account_balance';
    static DESCRIPTION = 'Assets/Liabilities/Equity by sector';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };

    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            viewMode: 'snapshot',
            evolutionMetric: 'all',
            timePoint: 'final',  // 'final' or index number
            showValues: true,
            colorAssets: '#4CAF50',
            colorLiabilities: '#F44336',
            colorEquity: '#2196F3',
            orientation: 'horizontal'
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'viewMode',
                    type: 'select',
                    label: 'View Mode',
                    description: 'Snapshot bar chart or evolution line chart',
                    options: [
                        { value: 'snapshot', label: 'Snapshot (Bar Chart)' },
                        { value: 'evolution', label: 'Evolution (Line Chart)' },
                    ],
                },
                {
                    key: 'evolutionMetric',
                    type: 'select',
                    label: 'Evolution Metric',
                    description: 'Which metric to show in evolution mode',
                    options: [
                        { value: 'all', label: 'All (per sector)' },
                        { value: 'assets', label: 'Total Assets' },
                        { value: 'liabilities', label: 'Total Liabilities' },
                        { value: 'equity', label: 'Equity' },
                    ],
                },
                {
                    key: 'timePoint',
                    type: 'select',
                    label: 'Time Point',
                    description: 'Which time point to display (snapshot mode)',
                    options: [
                        { value: 'final', label: 'Final (T)' },
                        { value: 'initial', label: 'Initial (T=0)' },
                        { value: 'mid', label: 'Midpoint' }
                    ]
                },
                {
                    key: 'showValues',
                    type: 'checkbox',
                    label: 'Show Values',
                    description: 'Display numeric values on bars'
                },
                {
                    key: 'colorAssets',
                    type: 'color',
                    label: 'Assets Color'
                },
                {
                    key: 'colorLiabilities',
                    type: 'color',
                    label: 'Liabilities Color'
                },
                {
                    key: 'colorEquity',
                    type: 'color',
                    label: 'Equity Color'
                }
            ]
        };
    }

    async render(data) {
        if (!data || !data.stocks) {
            this.showEmpty('No simulation data available');
            return;
        }

        if (this.config.viewMode === 'evolution') {
            return this._renderEvolution(data);
        }

        // Extract sector data from stocks (snapshot mode)
        const sectorData = this._extractSectorData(data);

        if (Object.keys(sectorData).length === 0) {
            this.showEmpty('No sector data found. Stock names should include sector info (e.g., "Sector::Assets[Account]")');
            return;
        }

        this.setTitle('Sector Balance Sheet');

        // Create container div for Plotly
        this.contentElement.innerHTML = '<div class="sector-balance-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.sector-balance-container');

        // Build Plotly configuration
        const { traces, layout } = this._buildPlotlyConfig(sectorData);

        // Create Plotly chart with deferred rendering (handles zero-dimension containers)
        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Render evolution line chart showing account aggregates over time.
     * @private
     */
    async _renderEvolution(data) {
        const time = data.time;
        if (!time || time.length === 0) {
            this.showEmpty('No time data available');
            return;
        }

        // Build time series for each sector: { sector: { assets: [...], liabilities: [...], equity: [...] } }
        const sectorTimeSeries = {};

        Object.entries(data.stocks || {}).forEach(([name, varData]) => {
            const values = varData.mean || varData;
            if (!Array.isArray(values) || values.length === 0) return;

            const parsed = this._parseStockName(name);
            if (!parsed.sector) return;

            if (!sectorTimeSeries[parsed.sector]) {
                sectorTimeSeries[parsed.sector] = {
                    assets: new Array(time.length).fill(0),
                    liabilities: new Array(time.length).fill(0),
                    equity: new Array(time.length).fill(0),
                };
            }

            const type = parsed.accountType?.toLowerCase() || '';
            let bucket = null;
            if (type.includes('asset')) bucket = 'assets';
            else if (type.includes('liabilit')) bucket = 'liabilities';
            else if (type.includes('equity') || type.includes('capital') || type.includes('net')) bucket = 'equity';

            if (bucket) {
                for (let i = 0; i < Math.min(time.length, values.length); i++) {
                    const val = bucket === 'liabilities' ? Math.abs(values[i] || 0) : (values[i] || 0);
                    sectorTimeSeries[parsed.sector][bucket][i] += val;
                }
            }
        });

        const sectors = Object.keys(sectorTimeSeries).sort();
        if (sectors.length === 0) {
            this.showEmpty('No sector data found');
            return;
        }

        this.setTitle('Balance Sheet Evolution');

        this.contentElement.innerHTML = '<div class="sector-balance-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.sector-balance-container');

        const traces = [];
        const metric = this.config.evolutionMetric || 'all';
        const SECTOR_COLORS = ['#2196F3', '#FF9800', '#4CAF50', '#E91E63', '#9C27B0', '#00BCD4'];
        const DASH_MAP = { assets: 'solid', liabilities: 'dash', equity: 'dot' };

        sectors.forEach((sector, sIdx) => {
            const color = SECTOR_COLORS[sIdx % SECTOR_COLORS.length];
            const seriesData = sectorTimeSeries[sector];

            if (metric === 'all') {
                // Three lines per sector with different dash styles
                for (const [bucket, dash] of Object.entries(DASH_MAP)) {
                    traces.push({
                        type: 'scatter',
                        x: time,
                        y: seriesData[bucket],
                        mode: 'lines',
                        name: `${sector} ${bucket.charAt(0).toUpperCase() + bucket.slice(1)}`,
                        line: { color, width: 2, dash },
                        legendgroup: sector,
                    });
                }
            } else {
                traces.push({
                    type: 'scatter',
                    x: time,
                    y: seriesData[metric] || [],
                    mode: 'lines',
                    name: sector,
                    line: { color, width: 2 },
                });
            }
        });

        const metricLabel = metric === 'all' ? 'Value' : metric.charAt(0).toUpperCase() + metric.slice(1);
        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 60, r: 20, t: 30, b: 50 },
            xaxis: {
                title: { text: 'Time' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                title: { text: metricLabel },
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

        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Extract sector aggregates from stock data.
     * Stock names are expected in format: "Sector::AccountType[AccountName]"
     * or we try to infer from variable naming patterns.
     * @param {Object} data - Analytics data
     * @returns {Object} { sectorName: { assets: number, liabilities: number, equity: number } }
     * @private
     */
    _extractSectorData(data) {
        const sectors = {};
        const timeIndex = this._getTimeIndex(data);

        // Process all stocks
        Object.entries(data.stocks || {}).forEach(([name, varData]) => {
            const values = Array.isArray(varData) ? varData : varData?.mean;
            if (!values || values.length === 0) return;

            const value = values[timeIndex] || 0;
            const parsed = this._parseStockName(name);

            if (!parsed.sector) return;

            if (!sectors[parsed.sector]) {
                sectors[parsed.sector] = { assets: 0, liabilities: 0, equity: 0 };
            }

            // Aggregate by account type
            const type = parsed.accountType?.toLowerCase() || '';
            if (type.includes('asset')) {
                sectors[parsed.sector].assets += value;
            } else if (type.includes('liabilit')) {
                sectors[parsed.sector].liabilities += Math.abs(value);
            } else if (type.includes('equity') || type.includes('capital') || type.includes('net')) {
                sectors[parsed.sector].equity += value;
            }
        });

        return sectors;
    }

    /**
     * Parse stock variable name to extract sector and account type.
     * Supports formats:
     * - "Sector::AccountType[AccountName]"
     * - "AccountType[AccountName]_Sector"
     * - "Sector_AccountType_AccountName"
     * @param {string} name - Stock variable name
     * @returns {{ sector: string|null, accountType: string|null, accountName: string|null }}
     * @private
     */
    _parseStockName(name) {
        // Format: "Sector::AccountType[AccountName]"
        let match = name.match(/^([^:]+)::([^[]+)\[([^\]]+)\]$/);
        if (match) {
            return { sector: match[1], accountType: match[2], accountName: match[3] };
        }

        // Format: "AccountType[AccountName]_Sector"
        match = name.match(/^([^[]+)\[([^\]]+)\]_(.+)$/);
        if (match) {
            return { sector: match[3], accountType: match[1], accountName: match[2] };
        }

        // Format: "Sector_AccountType_AccountName" or similar
        match = name.match(/^([^_]+)_([^_]+)_(.+)$/);
        if (match) {
            return { sector: match[1], accountType: match[2], accountName: match[3] };
        }

        // Format: Variable with suffix like "_Banks", "_Households"
        const sectorSuffixes = ['Banks', 'Households', 'Firms', 'Government', 'Central_Bank', 'Foreign'];
        for (const suffix of sectorSuffixes) {
            if (name.endsWith(`_${suffix}`)) {
                const baseName = name.slice(0, -suffix.length - 1);
                const accountType = this._inferAccountType(baseName);
                return { sector: suffix, accountType, accountName: baseName };
            }
        }

        return { sector: null, accountType: null, accountName: null };
    }

    /**
     * Infer account type from variable name.
     * @param {string} name - Variable name
     * @returns {string|null}
     * @private
     */
    _inferAccountType(name) {
        const lower = name.toLowerCase();
        if (lower.includes('asset') || lower.includes('cash') || lower.includes('loan') ||
            lower.includes('deposit') || lower.includes('bond') || lower.includes('reserve')) {
            return 'Assets';
        }
        if (lower.includes('liabilit') || lower.includes('debt') || lower.includes('borrow')) {
            return 'Liabilities';
        }
        if (lower.includes('equity') || lower.includes('capital') || lower.includes('net_worth')) {
            return 'Equity';
        }
        return null;
    }

    /**
     * Get time index based on config.
     * @param {Object} data - Analytics data
     * @returns {number}
     * @private
     */
    _getTimeIndex(data) {
        const timeLength = data.time?.length || 1;
        switch (this.config.timePoint) {
            case 'initial': return 0;
            case 'mid': return Math.floor(timeLength / 2);
            case 'final':
            default: return timeLength - 1;
        }
    }

    /**
     * Build Plotly traces and layout for horizontal stacked bar chart.
     * @param {Object} sectorData - Sector aggregates
     * @returns {{ traces: Array, layout: Object }}
     * @private
     */
    _buildPlotlyConfig(sectorData) {
        const sectors = Object.keys(sectorData).sort();
        const assetsData = sectors.map(s => sectorData[s].assets);
        const liabilitiesData = sectors.map(s => sectorData[s].liabilities);
        const equityData = sectors.map(s => sectorData[s].equity);

        const traces = [
            {
                type: 'bar',
                y: sectors,
                x: assetsData,
                orientation: 'h',
                name: 'Assets',
                marker: { color: this.config.colorAssets || '#4CAF50' },
                text: this.config.showValues ? assetsData.map(v => v > 0.01 ? this.formatNumber(v) : '') : [],
                textposition: 'inside',
                textfont: { color: '#ffffff', size: 10 },
                hovertemplate: '%{y}<br>Assets: %{x}<extra></extra>',
            },
            {
                type: 'bar',
                y: sectors,
                x: liabilitiesData,
                orientation: 'h',
                name: 'Liabilities',
                marker: { color: this.config.colorLiabilities || '#F44336' },
                text: this.config.showValues ? liabilitiesData.map(v => v > 0.01 ? this.formatNumber(v) : '') : [],
                textposition: 'inside',
                textfont: { color: '#ffffff', size: 10 },
                hovertemplate: '%{y}<br>Liabilities: %{x}<extra></extra>',
            },
            {
                type: 'bar',
                y: sectors,
                x: equityData,
                orientation: 'h',
                name: 'Equity',
                marker: { color: this.config.colorEquity || '#2196F3' },
                text: this.config.showValues ? equityData.map(v => v > 0.01 ? this.formatNumber(v) : '') : [],
                textposition: 'inside',
                textfont: { color: '#ffffff', size: 10 },
                hovertemplate: '%{y}<br>Equity: %{x}<extra></extra>',
            }
        ];

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 100, r: 20, t: 30, b: 50 },
            barmode: 'stack',
            xaxis: {
                title: { text: 'Value' },
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            yaxis: {
                gridcolor: '#333333',
                linecolor: '#444444',
                tickcolor: '#666666',
            },
            legend: {
                bgcolor: 'rgba(0,0,0,0)',
                font: { color: '#cccccc' },
                orientation: 'h',
                y: 1.1,
            },
        };

        return { traces, layout };
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
registerWidget(SectorBalanceSheet);

export default SectorBalanceSheet;
