/**
 * TocCell — Auto-generated table of contents.
 *
 * Scans sibling cells for headings (HeadingCell + documentation cells with
 * markdown `#` prefixes) and renders a clickable, numbered list.
 * Rebuilds automatically via refreshContent() when any cell changes.
 */

import { CellBase } from './cell_base.js';

export class TocCell extends CellBase {

    /** @type {HTMLElement} */
    #listEl = null;

    _getTabs() {
        return [{ id: 'config', label: 'Contents' }];
    }

    async renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="toc-cell__list"></div>';
        this.#listEl = bodyEl.querySelector('.toc-cell__list');
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
            if (cell.type === 'heading') {
                const level = cell.data?.level ?? 1;
                const title = cell.data?.title || '(untitled)';
                const num = numbering.get(cell.id);
                const displayNum = num?.displayNum ?? '';
                items.push({ cellId: cell.id, level, text: `${displayNum} ${title}`.trim() });
            } else if (cell.type === 'documentation') {
                // Extract markdown headings from documentation cells
                const src = cell.data?.source ?? '';
                const lines = src.split('\n');
                let headingIndex = 0;
                for (const line of lines) {
                    const m = line.match(/^(#{1,3})\s+(.+)/);
                    if (m) {
                        items.push({ cellId: cell.id, level: m[1].length, text: m[2].trim(), headingIndex });
                        headingIndex++;
                    }
                }
            }
        }

        if (items.length === 0) {
            this.#listEl.innerHTML = '<div class="toc-cell__empty">No headings found</div>';
            return;
        }

        this.#listEl.innerHTML = items.map(item => `
            <div class="toc-cell__entry toc-cell__entry--level-${item.level}"
                 data-cell-id="${item.cellId}"
                 ${item.headingIndex != null ? `data-heading-index="${item.headingIndex}"` : ''}>
                ${item.text}
            </div>
        `).join('');

        this.#listEl.querySelectorAll('.toc-cell__entry').forEach(el => {
            el.addEventListener('click', () => {
                const cellId = el.dataset.cellId;
                const headingIdx = el.dataset.headingIndex;
                if (headingIdx != null) {
                    this._props?.scrollToCellHeading?.(cellId, parseInt(headingIdx, 10));
                } else {
                    this._props?.scrollToCell?.(cellId);
                }
            });
        });
    }

    dispose() {
        this.#listEl = null;
        super.dispose();
    }
}
