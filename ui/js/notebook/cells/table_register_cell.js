/**
 * TableRegisterCell — Auto-generated list of tables.
 *
 * Scans sibling cells for data-table cells with captions and renders a
 * numbered, clickable list. Rebuilds automatically via refreshContent().
 */

import { CellBase } from './cell_base.js';

export class TableRegisterCell extends CellBase {

    /** @type {HTMLElement} */
    #listEl = null;

    _getTabs() {
        return [{ id: 'config', label: 'Tables' }];
    }

    async renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="register-cell__list"></div>';
        this.#listEl = bodyEl.querySelector('.register-cell__list');
        this.#rebuild();
    }

    getData() {
        return {};
    }

    refreshContent() {
        this.#rebuild();
    }

    #rebuild() {
        if (!this.#listEl) return;
        const cells = this._props?.getCells?.() ?? [];
        const numbering = this._props?.getNumbering?.() ?? new Map();

        const items = [];
        for (const cell of cells) {
            if (cell.type === 'data-table' && cell.data?.caption) {
                const num = numbering.get(cell.id);
                items.push({
                    cellId: cell.id,
                    text: `Table ${num?.displayNum ?? '?'}: ${cell.data.caption}`,
                });
            }
        }

        if (items.length === 0) {
            this.#listEl.innerHTML = '<div class="register-cell__empty">No tables with captions</div>';
            return;
        }

        this.#listEl.innerHTML = items.map(item => `
            <div class="register-cell__entry" data-cell-id="${item.cellId}">
                ${item.text}
            </div>
        `).join('');

        this.#listEl.querySelectorAll('.register-cell__entry').forEach(el => {
            el.addEventListener('click', () => {
                this._props?.scrollToCell?.(el.dataset.cellId);
            });
        });
    }

    dispose() {
        this.#listEl = null;
        super.dispose();
    }
}
