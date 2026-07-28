/**
 * StockViewerCell — read-only stock display for a namespace/sector.
 *
 * Two modes:
 *   - Godley stocks (Sector::AccountType[Account]) → balance sheet view
 *   - Simple stocks (plain names) → flat list with values
 *
 * Pure visualization cell — does NOT generate DSL.
 * Configuration (namespace, sector) lives in the slide-out config panel
 * via getConfigBinding().
 *
 * Data model:
 *   { namespace, sector, showZeroBalances }
 */

import { CellBase } from './cell_base.js';
import { renderStockViewerConfig } from '../../charting/stock_viewer_config_panel.js';

/** Regex for godley-style stock names: Sector::AccountType[Account] */
const GODLEY_RE = /^([^:]+)::(\w+)\[(\w+)\]/;

export class StockViewerCell extends CellBase {
    #data = null;
    #bodyEl = null;
    #lastResults = null;

    _getStandardActions() {
        return new Set(['toggle-print']);
    }

    async renderBody(bodyEl, cell) {
        this.#bodyEl = bodyEl;
        this.#data = {
            namespace:        '',
            sector:           '',
            showZeroBalances: false,
            ...cell.data,
        };
        this.#render();
    }

    #render() {
        const bodyEl = this.#bodyEl;
        if (!bodyEl) return;
        const d = this.#data;

        if (!d.namespace && !d.sector) {
            bodyEl.innerHTML = `
                <div class="stock-viewer-cell">
                    <div class="stock-viewer-cell__empty">
                        Click this cell and configure namespace &amp; sector in the config panel.
                    </div>
                </div>
            `;
            return;
        }

        const contentHtml = d.sector
            ? this.#renderGodleySheet()
            : this.#renderSimpleStocks();

        const nsLabel = d.namespace || 'All';
        const sectorLabel = d.sector ? ` / ${d.sector}` : '';

        bodyEl.innerHTML = `
            <div class="stock-viewer-cell">
                <div class="stock-viewer-cell__title">${this.#esc(nsLabel)}${this.#esc(sectorLabel)}</div>
                <div class="stock-viewer-cell__sheet">${contentHtml}</div>
            </div>
        `;
    }

    /** Render simple (non-godley) stocks for the selected namespace. */
    #renderSimpleStocks() {
        const symbols = this._getSymbols();
        const namespace = this.#data.namespace;
        const stocks = [];

        for (const sym of symbols) {
            if (sym.kind !== 'stock') continue;
            if (GODLEY_RE.test(sym.name)) continue; // skip godley stocks
            if (namespace) {
                const ns = sym.fileName?.replace('.namespace', '').split('/').pop();
                if (ns !== namespace) continue;
            }
            const value = this.#getLatestValue(sym.name, namespace);
            stocks.push({ name: sym.name, value });
        }

        if (stocks.length === 0) {
            return '<div class="stock-viewer-cell__empty">No stocks found in this namespace.</div>';
        }

        const showZero = this.#data.showZeroBalances;
        const filtered = showZero ? stocks : stocks.filter(s => s.value !== 0);

        if (filtered.length === 0) {
            return '<div class="stock-viewer-cell__empty">All stocks are zero. Enable "Show zero balances" to see them.</div>';
        }

        return `
            <div class="stock-viewer-cell__section">
                <div class="stock-viewer-cell__section-title">Stocks</div>
                ${filtered.map(s => `
                    <div class="stock-viewer-cell__row">
                        <span class="stock-viewer-cell__account">${s.name}</span>
                        <span class="stock-viewer-cell__value ${s.value < 0 ? 'stock-viewer-cell__value--negative' : ''}">${this.#formatValue(s.value)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    /** Render godley-style balance sheet for the selected sector. */
    #renderGodleySheet() {
        const { namespace, sector } = this.#data;
        if (!sector) return '';

        const symbols = this._getSymbols();
        const accounts = { Assets: [], Liabilities: [], Equity: [] };

        for (const sym of symbols) {
            if (sym.kind !== 'stock') continue;
            if (namespace) {
                const ns = sym.fileName?.replace('.namespace', '').split('/').pop();
                if (ns !== namespace) continue;
            }
            const match = sym.name?.match(GODLEY_RE);
            if (!match || match[1] !== sector) continue;
            const accountType = match[2];
            const accountName = match[3];
            if (accounts[accountType]) {
                const value = this.#getLatestValue(sym.name, namespace);
                accounts[accountType].push({ name: accountName, value });
            }
        }

        const showZero = this.#data.showZeroBalances;

        const renderSection = (title, items) => {
            const filtered = showZero ? items : items.filter(a => a.value !== 0);
            if (filtered.length === 0 && !showZero) return '';
            const total = items.reduce((s, a) => s + a.value, 0);
            return `
                <div class="stock-viewer-cell__section">
                    <div class="stock-viewer-cell__section-title">${title}</div>
                    ${filtered.length > 0 ? filtered.map(a => `
                        <div class="stock-viewer-cell__row">
                            <span class="stock-viewer-cell__account">${a.name}</span>
                            <span class="stock-viewer-cell__value ${a.value < 0 ? 'stock-viewer-cell__value--negative' : ''}">${this.#formatValue(a.value)}</span>
                        </div>
                    `).join('') : '<div class="stock-viewer-cell__row stock-viewer-cell__row--empty">No accounts</div>'}
                    <div class="stock-viewer-cell__row stock-viewer-cell__row--total">
                        <span class="stock-viewer-cell__account">Total</span>
                        <span class="stock-viewer-cell__value">${this.#formatValue(total)}</span>
                    </div>
                </div>
            `;
        };

        const hasAny = Object.values(accounts).some(a => a.length > 0);
        if (!hasAny) {
            return '<div class="stock-viewer-cell__empty">No stock accounts found for this sector.</div>';
        }

        return `
            ${renderSection('Assets', accounts.Assets)}
            ${renderSection('Liabilities', accounts.Liabilities)}
            ${renderSection('Equity', accounts.Equity)}
        `;
    }

    #getLatestValue(stockName, namespace) {
        if (!this.#lastResults?.series) return 0;
        // Try namespace-qualified key first (e.g. "Capital.Banks::Assets[Cash]" or "Capital.industrial_capital")
        if (namespace) {
            const qualified = `${namespace}.${stockName}`;
            const qSeries = this.#lastResults.series[qualified];
            if (qSeries?.length > 0) return qSeries[qSeries.length - 1];
        }
        // Fall back to bare key
        const series = this.#lastResults.series[stockName];
        if (!series || series.length === 0) return 0;
        return series[series.length - 1];
    }

    /** Called by NotebookEditor when simulation results arrive. */
    renderResults(results) {
        this.#lastResults = results;
        this.#render();
    }

    /**
     * Config binding for the slide-out config panel.
     * @returns {{ data: object, onChange: Function, symbolProvider: Function }}
     */
    getConfigBinding() {
        const binding = {
            data: this.#data,
            onChange: () => {
                this._notifyChange(this.#data);
                this.#render();
            },
            symbolProvider: () => this._getSymbols(),
            title: 'Stock Viewer',
            icon: 'account_balance_wallet',
        };
        binding.renderConfig = (container) => {
            renderStockViewerConfig(container, binding);
        };
        return binding;
    }

    // No DSL output — pure visualization cell
    getGeneratedDsl() { return null; }

    getData() { return { ...this.#data }; }

    dispose() {
        this.#bodyEl = null;
        this.#lastResults = null;
        super.dispose();
    }

    #esc(s)   { return String(s ?? '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c])); }
    #formatValue(n) {
        if (n == null || isNaN(n)) return '—';
        if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
        return n.toFixed(2);
    }
}
