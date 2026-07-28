/**
 * AssumptionsCell — read-only display of parameter groups and their values.
 *
 * Data model:
 *   {
 *     groups: [
 *       {
 *         name: 'Population',
 *         parameters: [
 *           { name: 'birth_rate', value: 0.03, latex: '\\beta', min: 0.01, max: 0.05,
 *             distribution: { type: 'normal', mean: 0.03, std: 0.005 } },
 *           { name: 'death_rate', value: 0.02 }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Columns: Notation (LaTeX + code name) | Value | Range | Distribution
 *
 * The cell can be manually configured (edit groups) or auto-populated from
 * the model's parameter cells via refreshContent().
 */

import { CellBase } from './cell_base.js';

export class AssumptionsCell extends CellBase {

    /** @type {HTMLElement} */
    #bodyEl = null;

    /** @type {boolean} */
    #autoPopulate = false;

    _getTabs() {
        return [{ id: 'config', label: 'Assumptions' }];
    }

    async renderBody(bodyEl) {
        this.#bodyEl = bodyEl;
        this.#autoPopulate = (this._cell.data.groups ?? []).length === 0;
        this.#render();
    }

    getData() {
        return { ...this._cell.data };
    }

    refreshContent() {
        if (this.#autoPopulate) {
            this.#populateFromCells();
        }
        this.#render();
    }

    /**
     * Auto-populate groups from sibling parameter cells.
     * Groups are organized by namespace.
     */
    #populateFromCells() {
        const cells = this._props?.getCells?.() ?? [];
        const nsMap = new Map();

        for (const cell of cells) {
            if (cell.type !== 'parameter') continue;
            const params = cell.data?.parameters ?? [];
            // Legacy single-param format
            if (params.length === 0 && cell.data?.name) {
                const ns = cell.data.namespace || 'Global';
                if (!nsMap.has(ns)) nsMap.set(ns, []);
                nsMap.get(ns).push({
                    name: cell.data.name,
                    value: cell.data.value,
                    latex: cell.data.latex,
                    min: cell.data.min,
                    max: cell.data.max,
                    distribution: cell.data.distribution,
                });
            }
            // Multi-param format
            for (const p of params) {
                const ns = p.namespace || 'Global';
                if (!nsMap.has(ns)) nsMap.set(ns, []);
                nsMap.get(ns).push({
                    name: p.name,
                    value: p.value,
                    latex: p.latex,
                    min: p.min,
                    max: p.max,
                    distribution: p.distribution,
                });
            }
        }

        const groups = [];
        for (const [name, parameters] of nsMap) {
            groups.push({ name, parameters });
        }

        this._cell.data.groups = groups;
    }

    #render() {
        if (!this.#bodyEl) return;
        const groups = this._cell.data.groups ?? [];

        if (groups.length === 0) {
            this.#bodyEl.innerHTML = `
                <div class="assumptions-cell__empty">
                    No parameter groups.
                    ${this.#autoPopulate ? 'Add parameter cells to populate automatically.' : ''}
                </div>`;
            return;
        }

        this.#bodyEl.innerHTML = groups.map(g => `
            <div class="assumptions-cell__group">
                <div class="assumptions-cell__group-header">${this.#esc(g.name)}</div>
                <table class="assumptions-cell__table">
                    <thead>
                        <tr>
                            <th>Notation</th>
                            <th>Value</th>
                            <th>Range</th>
                            <th>Distribution</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(g.parameters ?? []).map(p => `
                            <tr>
                                <td class="assumptions-cell__notation">${this.#formatNotation(p)}</td>
                                <td class="assumptions-cell__value">${this.#esc(String(p.value ?? ''))}</td>
                                <td class="assumptions-cell__range">${this.#formatRange(p.min, p.max)}</td>
                                <td class="assumptions-cell__dist">${this.#formatDist(p.distribution)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `).join('');
    }

    #formatNotation(p) {
        const tex = (p.latex ?? '').trim();
        const name = this.#esc(p.name ?? '');
        if (tex && window.katex) {
            try {
                const rendered = window.katex.renderToString(tex, {
                    displayMode: false, throwOnError: false, strict: false,
                });
                return `<span class="assumptions-cell__latex">${rendered}</span>`
                     + `<span class="assumptions-cell__code-name">${name}</span>`;
            } catch { /* fall through */ }
        }
        return `<span class="assumptions-cell__code-name">${name}</span>`;
    }

    #formatRange(min, max) {
        if (min == null && max == null) return '<span class="assumptions-cell__dist-none">—</span>';
        const lo = min != null ? String(min) : '−∞';
        const hi = max != null ? String(max) : '∞';
        return `[${this.#esc(lo)},\u2009${this.#esc(hi)}]`;
    }

    #formatDist(dist) {
        if (!dist || dist.type === 'none') return '<span class="assumptions-cell__dist-none">—</span>';
        switch (dist.type) {
            case 'normal':    return `Normal(\u03bc=${dist.mean}, \u03c3=${dist.std})`;
            case 'uniform':   return `Uniform(${dist.min}, ${dist.max})`;
            case 'triangular': return `Triangular(${dist.min}, ${dist.mode}, ${dist.max})`;
            case 'lognormal': return `LogNormal(\u03bc=${dist.mean}, \u03c3=${dist.std})`;
            default:          return this.#esc(dist.type);
        }
    }

    #esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    dispose() {
        this.#bodyEl = null;
        super.dispose();
    }
}
