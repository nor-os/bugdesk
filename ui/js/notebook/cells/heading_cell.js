/**
 * HeadingCell — chapter/section/subsection heading.
 *
 * Click to edit the heading text. Level selector (H1/H2/H3) inline.
 * No tabs — pure inline edit + preview.
 */

import { CellBase } from './cell_base.js';

const LEVELS = [
    { value: 1, tag: 'h1', label: 'Chapter' },
    { value: 2, tag: 'h2', label: 'Section' },
    { value: 3, tag: 'h3', label: 'Subsection' },
];

export class HeadingCell extends CellBase {
    #data = null;
    #blockEl = null;
    #isEditing = false;

    _getTabs() {
        return [{ id: 'config', label: 'Heading' }];
    }

    _getStandardActions() {
        return new Set();
    }

    async renderBody(bodyEl, cell) {
        this.#data = { level: 1, title: '', ...cell.data };
        bodyEl.innerHTML = `<div class="heading-cell"></div>`;
        this.#blockEl = bodyEl.querySelector('.heading-cell');
        this.#renderView();
    }

    #renderView() {
        if (!this.#blockEl) return;
        this.#isEditing = false;
        this.#blockEl.innerHTML = '';

        const d = this.#data;
        const levelCfg = LEVELS.find(l => l.value === (d.level || 1)) ?? LEVELS[0];

        // Level selector (always visible)
        const ctrl = document.createElement('div');
        ctrl.className = 'heading-cell-controls';
        ctrl.innerHTML = LEVELS.map(l => `
            <button class="heading-lvl-btn ${d.level === l.value ? 'heading-lvl-btn--active' : ''}"
                    data-lvl="${l.value}" title="${l.label}">${l.label}</button>
        `).join('');
        ctrl.querySelectorAll('[data-lvl]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#data.level = parseInt(btn.dataset.lvl, 10);
                this._notifyChange(this.#data);
                this.#renderView();
            });
        });
        this.#blockEl.appendChild(ctrl);

        // The heading itself — click to edit
        const heading = document.createElement(levelCfg.tag);
        heading.className = `heading-cell-text heading-cell-text--${levelCfg.tag}`;
        heading.textContent = d.title || '';
        if (!d.title) {
            heading.dataset.placeholder = `Click to add ${levelCfg.label.toLowerCase()} title…`;
            heading.classList.add('heading-cell-text--empty');
        }
        heading.addEventListener('click', () => this.#enterEdit());
        this.#blockEl.appendChild(heading);

        if (d.level === 1) {
            const hr = document.createElement('hr');
            hr.className = 'heading-cell-divider';
            this.#blockEl.appendChild(hr);
        }
    }

    #enterEdit() {
        if (this.#isEditing || !this.#blockEl) return;
        this.#isEditing = true;

        // Replace heading with input
        const heading = this.#blockEl.querySelector('.heading-cell-text');
        if (!heading) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'heading-cell-input';
        input.value = this.#data.title || '';
        input.placeholder = `Heading text…`;

        heading.replaceWith(input);
        input.focus();
        input.select();

        const save = () => {
            this.#data.title = input.value.trim();
            this._notifyChange(this.#data);
            this.#renderView();
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = this.#data.title || ''; input.blur(); }
        });
    }

    getData() {
        return { ...this.#data };
    }
}
