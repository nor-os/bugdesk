/**
 * transaction_flow_matrix.js
 *
 * Transaction Flow Matrix (TFM) widget showing inter-sector monetary flows
 * in the Godley & Lavoie SFC convention. Supports a styled CSS matrix table
 * and an alternative Plotly Sankey diagram view.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import {
    hasPlot,
    purge as plotlyPurge,
    DARK_THEME_LAYOUT,
    createChartDeferred,
} from '../../charting/plotly_wrapper.js';

const SECTOR_COLORS = [
    '#2196F3', '#FF9800', '#4CAF50', '#E91E63',
    '#9C27B0', '#00BCD4', '#FF5722', '#8BC34A',
];

export class TransactionFlowMatrix extends TileBase {
    static TYPE = 'transaction-flow-matrix';
    static TITLE = 'Transaction Flow Matrix';
    static ICON = 'grid_on';
    static DESCRIPTION = 'Sector transactions as matrix table or Sankey diagram';
    static DEFAULT_SIZE = { w: 8, h: 5 };
    static SIZE_CONSTRAINTS = { minW: 5, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;

    getDefaultConfig() {
        return {
            mode: 'table',
            timePoint: 'final',
            showRowTotals: true,
            showColumnTotals: true,
            highlightImbalances: true,
        };
    }

    getConfigSchema() {
        return {
            fields: [
                {
                    key: 'mode',
                    type: 'select',
                    label: 'View Mode',
                    options: [
                        { value: 'table', label: 'Matrix Table' },
                        { value: 'sankey', label: 'Sankey Diagram' },
                    ],
                },
                {
                    key: 'timePoint',
                    type: 'select',
                    label: 'Time Point',
                    options: [
                        { value: 'final', label: 'Final' },
                        { value: 'initial', label: 'Initial' },
                        { value: 'mid', label: 'Midpoint' },
                    ],
                },
                {
                    key: 'showRowTotals',
                    type: 'checkbox',
                    label: 'Show Row Totals',
                    description: 'Display sum across sectors for each transaction',
                },
                {
                    key: 'showColumnTotals',
                    type: 'checkbox',
                    label: 'Show Column Totals',
                    description: 'Display net change per sector',
                },
                {
                    key: 'highlightImbalances',
                    type: 'checkbox',
                    label: 'Highlight Imbalances',
                    description: 'Flag rows that do not sum to zero',
                },
            ],
        };
    }

    async render(data) {
        if (!data || !data.time) {
            this.showEmpty('No simulation data available');
            return;
        }

        if (!data.flows || Object.keys(data.flows).length === 0) {
            this.showEmpty('No flow data available. Re-run simulation to record flows.');
            return;
        }

        const { matrix, sectors, transactions } = this._buildMatrix(data);

        if (transactions.length === 0 || sectors.length === 0) {
            this.showEmpty('No transaction flow data found');
            return;
        }

        this.setTitle('Transaction Flow Matrix');

        if (this.config.mode === 'sankey') {
            await this._renderSankey(matrix, sectors, transactions, data);
        } else {
            this._renderTable(matrix, sectors, transactions);
        }
    }

    /**
     * Build the transaction × sector matrix from flow data.
     * @returns {{ matrix: Map<string, Map<string, number>>, sectors: string[], transactions: string[] }}
     * @private
     */
    _buildMatrix(data) {
        const timeIdx = this._getTimeIndex(data.time);
        const sectorSet = new Set();
        const txnSet = new Set();

        // matrix[transaction][sector] = value
        const matrix = new Map();

        // Parse flow keys: "Namespace.Transaction[Sector]"
        for (const [flowKey, flowData] of Object.entries(data.flows)) {
            const parsed = this._parseFlowKey(flowKey);
            if (!parsed) continue;

            const { transaction, sector } = parsed;
            const values = flowData.mean || flowData;
            const value = Array.isArray(values) ? (values[timeIdx] ?? 0) : 0;

            sectorSet.add(sector);
            txnSet.add(transaction);

            if (!matrix.has(transaction)) matrix.set(transaction, new Map());
            matrix.get(transaction).set(sector, value);
        }

        return {
            matrix,
            sectors: [...sectorSet].sort(),
            transactions: [...txnSet].sort(),
        };
    }

    /**
     * Parse a flow key into transaction and sector components.
     * Format: "Namespace.Transaction[Sector]"
     * @private
     */
    _parseFlowKey(key) {
        const dotIdx = key.indexOf('.');
        if (dotIdx < 0) return null;

        const afterDot = key.slice(dotIdx + 1);
        const bracketOpen = afterDot.indexOf('[');
        const bracketClose = afterDot.indexOf(']');
        if (bracketOpen < 0 || bracketClose < 0) return null;

        return {
            namespace: key.slice(0, dotIdx),
            transaction: afterDot.slice(0, bracketOpen),
            sector: afterDot.slice(bracketOpen + 1, bracketClose),
        };
    }

    /**
     * Get time index for the configured time point.
     * @private
     */
    _getTimeIndex(time) {
        if (!time || time.length === 0) return 0;
        switch (this.config.timePoint) {
            case 'initial': return 0;
            case 'mid': return Math.floor(time.length / 2);
            case 'final':
            default: return time.length - 1;
        }
    }

    /**
     * Render the CSS matrix table.
     * @private
     */
    _renderTable(matrix, sectors, transactions) {
        // Clean up any previous Plotly chart
        if (this.plotContainer && hasPlot(this.plotContainer)) {
            plotlyPurge(this.plotContainer);
            this.plotContainer = null;
        }

        const table = document.createElement('table');
        table.className = 'tfm-table';

        // Header row
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = '<th class="tfm-header tfm-header--label">Transaction</th>';
        sectors.forEach(s => {
            const th = document.createElement('th');
            th.className = 'tfm-header';
            th.textContent = s;
            headerRow.appendChild(th);
        });
        if (this.config.showRowTotals) {
            const th = document.createElement('th');
            th.className = 'tfm-header tfm-header--total';
            th.textContent = 'Row Total';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Data rows
        const tbody = document.createElement('tbody');
        const colTotals = new Map(sectors.map(s => [s, 0]));

        transactions.forEach(txn => {
            const row = document.createElement('tr');
            const labelCell = document.createElement('td');
            labelCell.className = 'tfm-cell tfm-cell--label';
            labelCell.textContent = txn;
            row.appendChild(labelCell);

            let rowTotal = 0;
            sectors.forEach(sector => {
                const value = matrix.get(txn)?.get(sector) ?? 0;
                rowTotal += value;
                colTotals.set(sector, colTotals.get(sector) + value);

                const cell = document.createElement('td');
                cell.className = 'tfm-cell';
                if (value > 0.001) cell.classList.add('tfm-cell--positive');
                else if (value < -0.001) cell.classList.add('tfm-cell--negative');
                cell.textContent = this._formatValue(value);
                row.appendChild(cell);
            });

            if (this.config.showRowTotals) {
                const totalCell = document.createElement('td');
                totalCell.className = 'tfm-cell tfm-cell--total';
                totalCell.textContent = this._formatValue(rowTotal);
                if (this.config.highlightImbalances && Math.abs(rowTotal) > 0.01) {
                    totalCell.classList.add('tfm-cell--imbalanced');
                    row.classList.add('tfm-row--imbalanced');
                }
                row.appendChild(totalCell);
            }

            tbody.appendChild(row);
        });

        // Column totals row
        if (this.config.showColumnTotals) {
            const totalRow = document.createElement('tr');
            totalRow.className = 'tfm-row--totals';
            const label = document.createElement('td');
            label.className = 'tfm-cell tfm-cell--label tfm-cell--total';
            label.textContent = 'Column Total';
            totalRow.appendChild(label);

            sectors.forEach(sector => {
                const val = colTotals.get(sector) ?? 0;
                const cell = document.createElement('td');
                cell.className = 'tfm-cell tfm-cell--total';
                if (val > 0.001) cell.classList.add('tfm-cell--positive');
                else if (val < -0.001) cell.classList.add('tfm-cell--negative');
                cell.textContent = this._formatValue(val);
                totalRow.appendChild(cell);
            });

            if (this.config.showRowTotals) {
                const corner = document.createElement('td');
                corner.className = 'tfm-cell tfm-cell--total';
                totalRow.appendChild(corner);
            }

            tbody.appendChild(totalRow);
        }

        table.appendChild(tbody);

        this.contentElement.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'tfm-wrapper';
        wrapper.appendChild(table);
        this.contentElement.appendChild(wrapper);
    }

    /**
     * Render the Sankey diagram.
     * @private
     */
    async _renderSankey(matrix, sectors, transactions, data) {
        this.contentElement.innerHTML = '<div class="tfm-sankey-container" style="width:100%;height:100%;"></div>';
        const container = this.contentElement.querySelector('.tfm-sankey-container');

        // Build Sankey nodes and links
        const nodeLabels = [...sectors];
        const nodeColors = sectors.map((_, i) => SECTOR_COLORS[i % SECTOR_COLORS.length]);
        const links = { source: [], target: [], value: [], label: [], color: [] };

        for (const txn of transactions) {
            const txnData = matrix.get(txn);
            if (!txnData) continue;

            // Find source (negative value = outflow) and target (positive value = inflow)
            const sources = [];
            const targets = [];

            for (const [sector, value] of txnData.entries()) {
                const sectorIdx = nodeLabels.indexOf(sector);
                if (sectorIdx < 0) continue;
                if (value < -0.001) sources.push({ idx: sectorIdx, value: Math.abs(value) });
                else if (value > 0.001) targets.push({ idx: sectorIdx, value });
            }

            // Create links from each source to each target
            for (const src of sources) {
                for (const tgt of targets) {
                    const linkValue = Math.min(src.value, tgt.value);
                    if (linkValue <= 0) continue;
                    links.source.push(src.idx);
                    links.target.push(tgt.idx);
                    links.value.push(linkValue);
                    links.label.push(txn);
                    links.color.push(`rgba(150, 150, 150, 0.4)`);
                }
            }
        }

        if (links.source.length === 0) {
            this.showEmpty('No inter-sector flows to display as Sankey');
            return;
        }

        const traces = [{
            type: 'sankey',
            orientation: 'h',
            node: {
                label: nodeLabels,
                color: nodeColors,
                pad: 15,
                thickness: 20,
                line: { color: '#444', width: 1 },
            },
            link: links,
        }];

        const layout = {
            ...DARK_THEME_LAYOUT,
            margin: { l: 20, r: 20, t: 30, b: 20 },
        };

        const result = await createChartDeferred(container, traces, layout);
        this.plotContainer = container;
        this._chartCleanup = result.cleanup;
    }

    /**
     * Format a numeric value for display.
     * @private
     */
    _formatValue(value) {
        if (Math.abs(value) < 0.001) return '—';
        return value.toFixed(2);
    }

    getExpandData() {
        if (!this.data || !this.data.time || !this.data.flows) return null;

        const { matrix, sectors, transactions } = this._buildMatrix(this.data);
        if (transactions.length === 0) return null;

        // For table mode, build a table representation
        // For sankey mode, reuse the Sankey traces
        if (this.config.mode === 'sankey') {
            // Can't easily convert Sankey to table; provide the matrix as table instead
        }

        const tableHeaders = ['Transaction', ...sectors];
        if (this.config.showRowTotals) tableHeaders.push('Row Total');

        const tableRows = transactions.map(txn => {
            const row = [txn];
            let total = 0;
            sectors.forEach(sector => {
                const val = matrix.get(txn)?.get(sector) ?? 0;
                total += val;
                row.push(val);
            });
            if (this.config.showRowTotals) row.push(total);
            return row;
        });

        return {
            title: 'Transaction Flow Matrix',
            traces: [],
            layout: {},
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

registerWidget(TransactionFlowMatrix);

export default TransactionFlowMatrix;
