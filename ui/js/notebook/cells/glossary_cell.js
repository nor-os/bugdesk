/**
 * GlossaryCell — manually authored glossary of terms and definitions.
 *
 * Two-column editable table: Term | Definition.
 * Supports LaTeX in definitions via KaTeX. Sorted alphabetically by term.
 *
 * Data model:
 *   {
 *     entries: [
 *       { term: 'ICOR', definition: 'Incremental Capital-Output Ratio — ...' },
 *       ...
 *     ]
 *   }
 */

import { CellBase } from './cell_base.js';

export class GlossaryCell extends CellBase {

    /** @type {HTMLElement} */
    #bodyEl = null;

    /** @type {Array<{term: string, definition: string}>} */
    #entries = [];

    _getTabs() {
        return [{ id: 'config', label: 'Glossary' }];
    }

    _getStandardActions() {
        return new Set(['toggle-print', 'open-window']);
    }

    async renderBody(bodyEl) {
        this.#bodyEl = bodyEl;
        this.#entries = (this._cell.data?.entries ?? []).map(e => ({ ...e }));
        this.#render();
    }

    getData() {
        return { entries: this.#entries.map(e => ({ term: e.term, definition: e.definition })) };
    }

    // ─── Rendering ───────────────────────────────────────────────────────────

    #render() {
        if (!this.#bodyEl) return;

        const sorted = [...this.#entries].sort((a, b) =>
            (a.term || '').localeCompare(b.term || '', undefined, { sensitivity: 'base' })
        );

        if (sorted.length === 0) {
            this.#bodyEl.innerHTML = `
                <div class="glossary-cell__empty">
                    No terms defined.
                    <button class="glossary-cell__add-btn" data-action="add">+ Add term</button>
                </div>`;
            this.#bodyEl.querySelector('[data-action="add"]')
                ?.addEventListener('click', () => this.#addEntry());
            return;
        }

        const tableHtml = `
            <table class="glossary-cell__table">
                <thead>
                    <tr>
                        <th class="glossary-cell__th-term">Term</th>
                        <th class="glossary-cell__th-def">Definition</th>
                        <th class="glossary-cell__th-actions"></th>
                    </tr>
                </thead>
                <tbody>
                    ${sorted.map((e, i) => {
                        const idx = this.#entries.indexOf(e);
                        return `
                        <tr data-idx="${idx}">
                            <td class="glossary-cell__term">${this.#esc(e.term || '')}</td>
                            <td class="glossary-cell__definition">${this.#renderDefinition(e.definition || '')}</td>
                            <td class="glossary-cell__row-actions">
                                <button class="glossary-cell__row-btn" data-action="edit" data-idx="${idx}" title="Edit">
                                    <span class="material-symbols-outlined">edit</span>
                                </button>
                                <button class="glossary-cell__row-btn glossary-cell__row-btn--delete" data-action="delete" data-idx="${idx}" title="Remove">
                                    <span class="material-symbols-outlined">close</span>
                                </button>
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            <div class="glossary-cell__footer">
                <button class="glossary-cell__add-btn" data-action="add">+ Add term</button>
            </div>`;

        this.#bodyEl.innerHTML = tableHtml;
        this.#bindEvents();
    }

    #renderDefinition(def) {
        // Render inline LaTeX between $ delimiters
        if (!def) return '';
        if (!window.katex) return this.#esc(def);

        return def.replace(/\$([^$]+)\$/g, (_match, tex) => {
            try {
                return window.katex.renderToString(tex.trim(), {
                    displayMode: false, throwOnError: false, strict: false,
                });
            } catch {
                return this.#esc(`$${tex}$`);
            }
        }).replace(/(?:^|(?<=\]))([^$<]+)/g, (text) => this.#esc(text));
    }

    #bindEvents() {
        if (!this.#bodyEl) return;

        this.#bodyEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            const idx = btn.dataset.idx != null ? parseInt(btn.dataset.idx, 10) : -1;

            switch (action) {
                case 'add':
                    this.#addEntry();
                    break;
                case 'edit':
                    this.#editEntry(idx);
                    break;
                case 'delete':
                    this.#deleteEntry(idx);
                    break;
            }
        });
    }

    // ─── CRUD ────────────────────────────────────────────────────────────────

    #addEntry() {
        this.#showEditor(-1, '', '');
    }

    #editEntry(idx) {
        if (idx < 0 || idx >= this.#entries.length) return;
        const e = this.#entries[idx];
        this.#showEditor(idx, e.term, e.definition);
    }

    #deleteEntry(idx) {
        if (idx < 0 || idx >= this.#entries.length) return;
        this.#entries.splice(idx, 1);
        this.#notify();
        this.#render();
    }

    #showEditor(idx, term, definition) {
        if (!this.#bodyEl) return;

        // Build inline editor overlay
        const overlay = document.createElement('div');
        overlay.className = 'glossary-cell__editor';
        overlay.innerHTML = `
            <div class="glossary-cell__editor-row">
                <label class="glossary-cell__editor-label">Term</label>
                <input class="glossary-cell__editor-input" type="text" value="${this.#escAttr(term)}" placeholder="e.g. ICOR" spellcheck="false" />
            </div>
            <div class="glossary-cell__editor-row">
                <label class="glossary-cell__editor-label">Definition</label>
                <textarea class="glossary-cell__editor-textarea" rows="3" placeholder="e.g. Incremental Capital-Output Ratio — units of capital per unit of output. Use $...$ for LaTeX." spellcheck="true">${this.#esc(definition)}</textarea>
            </div>
            <div class="glossary-cell__editor-buttons">
                <button class="glossary-cell__editor-btn glossary-cell__editor-btn--save">Save</button>
                <button class="glossary-cell__editor-btn glossary-cell__editor-btn--cancel">Cancel</button>
            </div>`;

        // Replace body content with editor
        this.#bodyEl.innerHTML = '';
        this.#bodyEl.appendChild(overlay);

        const input = overlay.querySelector('.glossary-cell__editor-input');
        const textarea = overlay.querySelector('.glossary-cell__editor-textarea');
        const saveBtn = overlay.querySelector('.glossary-cell__editor-btn--save');
        const cancelBtn = overlay.querySelector('.glossary-cell__editor-btn--cancel');

        const save = () => {
            const t = input.value.trim();
            const d = textarea.value.trim();
            if (!t) {
                input.focus();
                return;
            }
            if (idx >= 0 && idx < this.#entries.length) {
                this.#entries[idx] = { term: t, definition: d };
            } else {
                this.#entries.push({ term: t, definition: d });
            }
            this.#notify();
            this.#render();
        };

        const cancel = () => this.#render();

        saveBtn.addEventListener('click', save);
        cancelBtn.addEventListener('click', cancel);

        // Keyboard: Enter in term input moves to definition, Ctrl+Enter saves, Escape cancels
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); textarea.focus(); }
            if (e.key === 'Escape') cancel();
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            if (e.key === 'Escape') cancel();
        });

        input.focus();
        input.select();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    #notify() {
        this._props?.onChange?.(this.getData());
    }

    #esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    #escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    dispose() {
        this.#bodyEl = null;
        super.dispose();
    }
}
