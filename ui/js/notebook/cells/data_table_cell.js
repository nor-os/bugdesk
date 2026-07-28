/**
 * DataTableCell — simulation results displayed in tabular form.
 *
 * Config (variable picker, decimal places, caption) is rendered externally
 * in the slide-out panel via getConfigBinding().
 *
 * The cell body shows the rendered HTML table after simulation, or a
 * placeholder when no results are available.
 *
 * Receives results via renderResults() (same contract as PlotCell).
 */

import { CellBase } from './cell_base.js';

const MAX_TIME_COLUMNS = 12;

export class DataTableCell extends CellBase {

    /** @type {object|null} { series: { name: [...] }, time: [...] } */
    #lastResults = null;

    /** @type {HTMLElement} */
    #displayEl = null;

    /** @type {HTMLElement|null} */
    #panelContainer = null;

    _getTabs() {
        return [{ id: 'display', label: 'Display' }];
    }

    async renderBody(bodyEl) {
        bodyEl.innerHTML = `
            <div class="data-table-cell__display">
                <div class="data-table-cell__placeholder">Run simulation to populate table</div>
            </div>
        `;
        this.#displayEl = bodyEl.querySelector('.data-table-cell__display');
    }

    getData() {
        return { ...this._cell.data };
    }

    getLastResults() {
        return this.#lastResults;
    }

    renderResults(results) {
        this.#lastResults = results;
        this.#renderTable();
    }

    // ─── Config panel (slide-out) ────────────────────────────────────────────

    getConfigBinding() {
        return {
            title: 'Data Table Config',
            icon: 'table_chart',
            renderConfig: (container) => this.#renderConfigPanel(container),
        };
    }

    #renderConfigPanel(container) {
        this.#panelContainer = container;
        this.#buildPanelContent();
    }

    #buildPanelContent() {
        const container = this.#panelContainer;
        if (!container) return;

        const data = this._cell.data;
        const vars = data.variables ?? [];

        container.innerHTML = `
            <div class="smooth-cell">
                <div class="smooth-row">
                    <div class="smooth-field smooth-field--full">
                        <label class="smooth-label">Variables</label>
                        <div class="data-table-cell__var-list"></div>
                        <div class="data-table-cell__var-add">
                            <input type="text" class="smooth-input data-table-cell__var-input"
                                   placeholder="Type variable name…" list="dt-var-suggestions-${this._cell.id}">
                            <datalist id="dt-var-suggestions-${this._cell.id}"></datalist>
                            <button class="cell-btn data-table-cell__var-add-btn" type="button">Add</button>
                        </div>
                        <div class="cell-field-help">Select model variables to display as columns</div>
                    </div>
                </div>
                <div class="smooth-row">
                    <div class="smooth-field smooth-field--short">
                        <label class="smooth-label">Decimal places</label>
                        <input type="number" class="smooth-input data-table-cell__decimals"
                               value="${data.decimalPlaces ?? 2}" min="0" max="10" step="1">
                    </div>
                </div>
                <div class="smooth-row">
                    <div class="smooth-field smooth-field--full">
                        <label class="smooth-label">Caption</label>
                        <input type="text" class="smooth-input data-table-cell__caption"
                               value="${this.#esc(data.caption ?? '')}" placeholder="Table caption (optional)">
                    </div>
                </div>
            </div>
        `;

        this.#renderVariableChips();
        this.#populateSuggestions();
        this.#bindPanelEvents();
    }

    #bindPanelEvents() {
        const container = this.#panelContainer;
        if (!container) return;

        const addBtn = container.querySelector('.data-table-cell__var-add-btn');
        const input = container.querySelector('.data-table-cell__var-input');

        addBtn?.addEventListener('click', () => {
            const name = input?.value?.trim();
            if (name && !this._cell.data.variables.includes(name)) {
                this._cell.data.variables.push(name);
                this._notifyChange({ variables: [...this._cell.data.variables] });
                this.#renderVariableChips();
                if (input) input.value = '';
                if (this.#lastResults) this.#renderTable();
            }
        });

        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addBtn?.click(); }
        });

        container.querySelector('.data-table-cell__decimals')?.addEventListener('change', (e) => {
            this._notifyChange({ decimalPlaces: parseInt(e.target.value, 10) || 2 });
            if (this.#lastResults) this.#renderTable();
        });

        container.querySelector('.data-table-cell__caption')?.addEventListener('input', (e) => {
            this._notifyChange({ caption: e.target.value });
        });
    }

    #renderVariableChips() {
        const listEl = this.#panelContainer?.querySelector('.data-table-cell__var-list');
        if (!listEl) return;
        const vars = this._cell.data.variables ?? [];

        listEl.innerHTML = vars.map((v, i) => `
            <span class="data-table-cell__var-chip">
                ${this.#esc(v)}
                <button class="data-table-cell__var-remove" data-index="${i}" title="Remove">&times;</button>
            </span>
        `).join('') || '<span class="data-table-cell__var-empty">No variables selected</span>';

        listEl.querySelectorAll('.data-table-cell__var-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                this._cell.data.variables.splice(idx, 1);
                this._notifyChange({ variables: [...this._cell.data.variables] });
                this.#renderVariableChips();
                if (this.#lastResults) this.#renderTable();
            });
        });
    }

    #populateSuggestions() {
        const datalist = this.#panelContainer?.querySelector('datalist');
        if (!datalist) return;
        const symbols = this._getSymbols();
        datalist.innerHTML = symbols
            .filter(s => s.kind !== 'namespace')
            .map(s => `<option value="${this.#esc(s.name)}">${this.#esc(s.namespace ? `${s.namespace}.${s.name}` : s.name)}</option>`)
            .join('');
    }

    // ─── Table rendering (cell body) ─────────────────────────────────────────

    #renderTable() {
        if (!this.#displayEl) return;
        const results = this.#lastResults;
        const vars = this._cell.data.variables ?? [];
        const decimals = this._cell.data.decimalPlaces ?? 2;
        const caption = this._cell.data.caption ?? '';
        const numbering = this._props?.getNumbering?.() ?? new Map();
        const num = numbering.get(this._cell.id);

        if (!results?.time?.length || vars.length === 0) {
            this.#displayEl.innerHTML = '<div class="data-table-cell__placeholder">No data to display</div>';
            return;
        }

        // Sample time points if too many
        const time = results.time;
        const indices = this.#sampleIndices(time.length, MAX_TIME_COLUMNS);

        const captionHtml = caption
            ? `<caption>Table ${num?.displayNum ?? ''}: ${this.#esc(caption)}</caption>`
            : '';

        const headerRow = `<tr><th>Variable</th>${indices.map(i => `<th>${this.#formatTime(time[i])}</th>`).join('')}</tr>`;

        const bodyRows = vars.map(varName => {
            const series = results.series?.[varName];
            if (!series) {
                return `<tr><td class="data-table-cell__var-name">${this.#esc(varName)}</td>${indices.map(() => '<td>—</td>').join('')}</tr>`;
            }
            const values = Array.isArray(series) ? series : (series.mean ?? series.p50 ?? []);
            return `<tr>
                <td class="data-table-cell__var-name">${this.#esc(varName)}</td>
                ${indices.map(i => `<td>${this.#formatValue(values[i], decimals)}</td>`).join('')}
            </tr>`;
        }).join('');

        this.#displayEl.innerHTML = `
            <div class="data-table-cell__table-wrapper">
                <table class="data-table-cell__table">
                    ${captionHtml}
                    <thead>${headerRow}</thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        `;
    }

    #sampleIndices(totalLen, maxCols) {
        if (totalLen <= maxCols) return Array.from({ length: totalLen }, (_, i) => i);
        const step = (totalLen - 1) / (maxCols - 1);
        return Array.from({ length: maxCols }, (_, i) => Math.round(i * step));
    }

    #formatTime(t) {
        return Number.isInteger(t) ? String(t) : t.toFixed(1);
    }

    #formatValue(v, decimals) {
        if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '—';
        return typeof v === 'number' ? v.toFixed(decimals) : String(v);
    }

    #esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    dispose() {
        this.#lastResults = null;
        this.#displayEl = null;
        this.#panelContainer = null;
        super.dispose();
    }
}
