/**
 * TitlePageCell — pinned cell at index 0 of a paper.
 *
 * Renders: documentTitle, subtitle, authors, date.
 * All fields are inline-editable via contenteditable.
 * Cannot be moved or deleted.
 *
 * Reads/writes from paper's documentSettings via props:
 *   props.getDocumentSettings()  → { documentTitle, subtitle, authors, date }
 *   props.onDocumentSettingsChanged(partial) → updates documentSettings
 */

import { CellBase } from './cell_base.js';

export class TitlePageCell extends CellBase {
    #blockEl = null;

    _getTabs() {
        return [{ id: 'config', label: 'Title Page' }];
    }

    _getStandardActions() {
        // No open-window, no print toggle for title page
        return new Set();
    }

    async renderBody(bodyEl, cell, props) {
        bodyEl.innerHTML = `<div class="title-page-cell"></div>`;
        this.#blockEl = bodyEl.querySelector('.title-page-cell');
        this.#render(props);

        // Hide move/delete buttons (title page is pinned)
        const actions = this._container?.querySelector('.cell-actions');
        if (actions) actions.style.display = 'none';

        // Hide drag handle
        const drag = this._container?.querySelector('.notebook-cell-drag-handle');
        if (drag) drag.style.display = 'none';
    }

    #render(props) {
        if (!this.#blockEl) return;
        const settings = props?.getDocumentSettings?.() ?? this._props?.getDocumentSettings?.() ?? {};

        this.#blockEl.innerHTML = `
            <div class="title-page-cell__title" contenteditable="true"
                 data-placeholder="Document title…">${settings.documentTitle || ''}</div>
            <div class="title-page-cell__subtitle" contenteditable="true"
                 data-placeholder="Subtitle…">${settings.subtitle || ''}</div>
            <div class="title-page-cell__authors" contenteditable="true"
                 data-placeholder="Authors…">${settings.authors || ''}</div>
            <div class="title-page-cell__date" contenteditable="true"
                 data-placeholder="Date…">${settings.date || ''}</div>
        `;

        // Wire up inline editing
        const fields = [
            { selector: '.title-page-cell__title', key: 'documentTitle' },
            { selector: '.title-page-cell__subtitle', key: 'subtitle' },
            { selector: '.title-page-cell__authors', key: 'authors' },
            { selector: '.title-page-cell__date', key: 'date' },
        ];

        for (const { selector, key } of fields) {
            const el = this.#blockEl.querySelector(selector);
            if (!el) continue;

            el.addEventListener('blur', () => {
                const value = el.textContent.trim();
                const p = this._props;
                if (p?.onDocumentSettingsChanged) {
                    p.onDocumentSettingsChanged({ [key]: value });
                }
            });

            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    el.blur();
                }
            });
        }
    }

    getData() {
        // Title page has no cell-level data — everything is in documentSettings
        return {};
    }
}
