/**
 * statistics_table.js
 *
 * Statistics table widget displaying detailed statistics for simulation variables.
 * Shows mean, std, min, max, and percentiles in a sortable table format.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { DataTable } from '../../ui/components/data_table.js';

export class StatisticsTable extends TileBase {
    static TYPE = 'statistics-table';
    static TITLE = 'Statistics Table';
    static ICON = 'table_chart';
    static DESCRIPTION = 'Detailed statistics table for all variables';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static SUPPORTS_COMPARISON = true;
    static EXPANDABLE = true;

    constructor(options) {
        super(options);
        this._sortColumn = 0; // Column index
        this._sortAscending = true;
        this._dataTable = null;
        this._currentData = null;
        this._currentRows = null;
    }

    getDefaultConfig() {
        return {
            showStocks: true,
            showFlows: false,
            showIndicators: true,
            showPercentiles: true
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'showStocks',
                    type: 'checkbox',
                    label: 'Show Stocks',
                    description: 'Include stock variables'
                },
                {
                    key: 'showFlows',
                    type: 'checkbox',
                    label: 'Show Flows',
                    description: 'Include flow variables'
                },
                {
                    key: 'showIndicators',
                    type: 'checkbox',
                    label: 'Show Indicators',
                    description: 'Include indicator variables'
                },
                {
                    key: 'showPercentiles',
                    type: 'checkbox',
                    label: 'Show Percentiles',
                    description: 'Show P5, P50, P95 columns (Monte Carlo only)'
                }
            ]
        };
    }

    render(data) {
        if (!data) {
            this.showEmpty('No simulation data available');
            return;
        }

        // Collect all variables
        const collectedRows = this._collectVariables(data);

        if (collectedRows.length === 0) {
            this.showEmpty('No variables to display');
            return;
        }

        // Store current data for sorting
        this._currentData = data;

        // Determine run type and which columns to show
        const isMonteCarlo = data.meta?.type === 'monte-carlo';
        const showPercentiles = this.config.showPercentiles && isMonteCarlo;

        // Build headers - different columns for static vs MC runs
        const headers = isMonteCarlo
            ? ['Variable', 'Mean', 'Std', 'Min', 'Max']
            : ['Variable', 'First', 'Last', 'Change', 'Change %', 'Mean', 'Std', 'Min', 'Max'];
        if (showPercentiles) {
            headers.push('P5', 'P50', 'P95');
        }

        // Collect comparison scenario info for extra columns
        const comparisonScenarios = [];
        if (this.comparisonData) {
            for (const [scenarioId, { name }] of this.comparisonData) {
                comparisonScenarios.push({ id: scenarioId, name });
                headers.push(`${name}`);
            }
        }
        /** @type {number} First comparison column index */
        const comparisonColStart = headers.length - comparisonScenarios.length;

        // Convert collected rows to array format for DataTable
        const timeIndex = data.time?.length > 0 ? data.time.length - 1 : 0;

        const tableRows = collectedRows.map(row => {
            const arr = isMonteCarlo
                ? [row.name, row.mean, row.std, row.min, row.max]
                : [row.name, row.first, row.last, row.change, row.changePct, row.mean, row.std, row.min, row.max];
            if (showPercentiles) {
                arr.push(row.p5, row.p50, row.p95);
            }
            // Add comparison scenario mean values
            for (const cs of comparisonScenarios) {
                const compData = this.comparisonData.get(cs.id);
                if (compData) {
                    const compVar = compData.analytics.stocks?.[row.name]
                        || compData.analytics.flows?.[row.name]
                        || compData.analytics.indicators?.[row.name];
                    if (compVar) {
                        const val = Array.isArray(compVar)
                            ? compVar[timeIndex]
                            : compVar.mean?.[timeIndex];
                        arr.push(val ?? null);
                    } else {
                        arr.push(null);
                    }
                } else {
                    arr.push(null);
                }
            }
            // Store category for cell rendering
            arr._category = row.category;
            return arr;
        });

        // Sort rows
        this._sortTableRows(tableRows);
        this._currentRows = tableRows;

        // Dispose previous DataTable instance
        if (this._dataTable) {
            this._dataTable.dispose();
            this._dataTable = null;
        }

        // Create container
        this.contentElement.innerHTML = '';
        const container = document.createElement('div');
        container.style.cssText = 'height: 100%; min-height: 0;';
        this.contentElement.appendChild(container);

        // Create DataTable
        this._dataTable = new DataTable(container, {
            headers,
            rows: tableRows,
            pagination: false,
            selectable: false,
            copyable: false,
            sortable: true,
            readonly: true,
            emptyMessage: 'No variables to display',
            formatValue: (value, colIdx) => {
                if (colIdx === 0) return value;
                // Format Change% with % suffix for static runs
                if (!isMonteCarlo && colIdx === 4 && value != null) {
                    return this.formatNumber(value) + '%';
                }
                return this.formatNumber(value);
            },
            onSort: (colIdx, ascending) => {
                this._sortColumn = colIdx;
                this._sortAscending = ascending;
                this._sortTableRows(tableRows);
                this._dataTable.setData({ rows: tableRows });
            },
            renderCell: (td, value, colIdx, rowIdx, row) => {
                if (colIdx === 0) {
                    // Variable name cell - add category icon
                    const category = row._category || 'indicator';
                    const categoryIcon = category === 'stock' ? 'inventory_2'
                        : category === 'flow' ? 'waterfall_chart'
                        : 'insights';

                    const icon = document.createElement('span');
                    icon.className = 'material-symbols-outlined header-icon has-tooltip';
                    icon.setAttribute('data-tooltip', category);
                    icon.style.cssText = 'font-size:16px; vertical-align:middle; margin-right:4px; opacity:0.7;';
                    icon.textContent = categoryIcon;

                    td.appendChild(icon);
                    td.appendChild(document.createTextNode(this.formatLabel(value) || ''));
                    return true; // Handled
                }
                // Highlight comparison columns with subtle background
                if (comparisonScenarios.length > 0 && colIdx >= comparisonColStart) {
                    td.style.backgroundColor = 'rgba(255, 255, 255, 0.03)';
                    td.style.fontStyle = 'italic';
                }
                return false; // Use default formatting
            },
        });

        this._dataTable.render();
    }

    getExpandData() {
        if (!this.data) return null;

        const collectedRows = this._collectVariables(this.data);
        if (collectedRows.length === 0) return null;

        const isMonteCarlo = this.data.meta?.type === 'monte-carlo';
        const showPercentiles = this.config.showPercentiles && isMonteCarlo;

        const tableHeaders = isMonteCarlo
            ? ['Variable', 'Mean', 'Std', 'Min', 'Max']
            : ['Variable', 'First', 'Last', 'Change', 'Change %', 'Mean', 'Std', 'Min', 'Max'];
        if (showPercentiles) tableHeaders.push('P5', 'P50', 'P95');

        const tableRows = collectedRows.map(row => {
            const arr = isMonteCarlo
                ? [this.formatLabel(row.name), row.mean, row.std, row.min, row.max]
                : [this.formatLabel(row.name), row.first, row.last, row.change,
                   row.changePct != null ? row.changePct.toFixed(2) + '%' : null,
                   row.mean, row.std, row.min, row.max];
            if (showPercentiles) arr.push(row.p5, row.p50, row.p95);
            return arr;
        });

        return { title: 'Statistics Table', traces: [], layout: {}, tableHeaders, tableRows };
    }

    /**
     * Collect variable data into rows.
     * @param {Object} data - Analytics data
     * @returns {Array} Array of row objects
     * @private
     */
    _collectVariables(data) {
        const rows = [];
        // Always use final time point for statistics
        const timeIndex = data.time?.length > 0 ? data.time.length - 1 : 0;

        // Helper to extract row data from variable
        const extractRow = (name, varData, category) => {
            // Handle both Monte Carlo (object with mean/std/etc) and static (array) formats
            if (Array.isArray(varData)) {
                // Static run - compute temporal statistics across the full time series
                const first = varData[0] ?? null;
                const last = varData[timeIndex] ?? null;
                const change = (first != null && last != null) ? last - first : null;
                const changePct = (first != null && last != null && first !== 0)
                    ? ((last - first) / Math.abs(first)) * 100
                    : null;

                // Temporal statistics over all time steps
                let sum = 0, count = 0, tMin = Infinity, tMax = -Infinity;
                for (let i = 0; i <= timeIndex; i++) {
                    const v = varData[i];
                    if (v != null && Number.isFinite(v)) {
                        sum += v;
                        count++;
                        if (v < tMin) tMin = v;
                        if (v > tMax) tMax = v;
                    }
                }
                const mean = count > 0 ? sum / count : null;

                let variance = 0;
                if (count > 1 && mean != null) {
                    for (let i = 0; i <= timeIndex; i++) {
                        const v = varData[i];
                        if (v != null && Number.isFinite(v)) {
                            variance += (v - mean) ** 2;
                        }
                    }
                    variance /= count;
                }
                const std = count > 1 ? Math.sqrt(variance) : null;

                return {
                    name, category, first, last, change, changePct,
                    mean,
                    std,
                    min: count > 0 ? tMin : null,
                    max: count > 0 ? tMax : null,
                    p5: null, p50: null, p95: null,
                };
            } else {
                // Monte Carlo run - object with statistics at final time point
                return {
                    name, category,
                    first: null, last: null, change: null, changePct: null,
                    mean: varData.mean?.[timeIndex],
                    std: varData.std?.[timeIndex],
                    min: varData.min?.[timeIndex],
                    max: varData.max?.[timeIndex],
                    p5: varData.p5?.[timeIndex],
                    p50: varData.p50?.[timeIndex],
                    p95: varData.p95?.[timeIndex],
                };
            }
        };

        // Collect stocks
        if (this.config.showStocks && data.stocks) {
            Object.entries(data.stocks).forEach(([name, varData]) => {
                rows.push(extractRow(name, varData, 'stock'));
            });
        }

        // Collect flows
        if (this.config.showFlows && data.flows) {
            Object.entries(data.flows).forEach(([name, varData]) => {
                rows.push(extractRow(name, varData, 'flow'));
            });
        }

        // Collect indicators
        if (this.config.showIndicators && data.indicators) {
            Object.entries(data.indicators).forEach(([name, varData]) => {
                rows.push(extractRow(name, varData, 'indicator'));
            });
        }

        return rows;
    }

    /**
     * Sort table rows by current sort settings.
     * @param {Array} rows - Array of row arrays (with _category property)
     * @private
     */
    _sortTableRows(rows) {
        const colIdx = this._sortColumn;
        const asc = this._sortAscending;

        rows.sort((a, b) => {
            let valA = a[colIdx];
            let valB = b[colIdx];

            // Handle null/undefined
            if (valA == null && valB == null) return 0;
            if (valA == null) return 1;
            if (valB == null) return -1;

            // String comparison for name column (index 0)
            if (colIdx === 0) {
                valA = String(valA).toLowerCase();
                valB = String(valB).toLowerCase();
            }

            let cmp = 0;
            if (valA < valB) cmp = -1;
            else if (valA > valB) cmp = 1;

            return asc ? cmp : -cmp;
        });
    }

    /**
     * Dispose of resources.
     */
    dispose() {
        if (this._dataTable) {
            this._dataTable.dispose();
            this._dataTable = null;
        }
        this._currentData = null;
        this._currentRows = null;
        super.dispose();
    }
}

// Register the widget
registerWidget(StatisticsTable);

export default StatisticsTable;
