/**
 * ParameterCell — hosts multiple named model parameters, each with value,
 * range, and optional Monte Carlo distribution.
 *
 * Data model:
 *   cell.data.parameters = [
 *     { name, value, min, max, description, distribution: { type, ...params } },
 *     ...
 *   ]
 *
 * Legacy single-parameter format ({ name, value, ... } without .parameters)
 * is automatically migrated on load.
 *
 * Layout per parameter (settings-group style):
 *   Row 1:  name = value  [min–max]  MC:[dropdown] [dist params...]  [×]
 *   Row 2:  description (rendered markdown preview; click to edit)
 *
 * DSL tab: read-only generated DSL for all parameters.
 */

import { CellBase } from './cell_base.js';
import { markdownToHtml } from './markdown_preview.js';
import { DocumentationEditorWindow } from '../documentation_editor_window.js';

const DISTRIBUTIONS = [
    { id: 'none',        label: 'Fixed value' },
    { id: 'uniform',     label: 'Uniform',       params: [{ key: 'min', label: 'Min' }, { key: 'max', label: 'Max' }] },
    { id: 'normal',      label: 'Normal',        params: [{ key: 'mean', label: 'Mean' }, { key: 'std', label: 'Std dev' }] },
    { id: 'lognormal',   label: 'Log-normal',    params: [{ key: 'mu', label: 'μ' }, { key: 'sigma', label: 'σ' }] },
    { id: 'triangular',  label: 'Triangular',    params: [{ key: 'low', label: 'Low' }, { key: 'mode', label: 'Mode' }, { key: 'high', label: 'High' }] },
    { id: 'beta',        label: 'Beta',          params: [{ key: 'alpha', label: 'α' }, { key: 'beta', label: 'β' }] },
];

/** Migrate legacy single-parameter data to multi-parameter array format. */
function migrateData(data) {
    if (Array.isArray(data?.parameters)) return data;
    // Legacy: { name, value, min, max, description, distribution }
    const p = { name: data?.name ?? '', value: data?.value ?? '', min: data?.min, max: data?.max, description: data?.description, distribution: data?.distribution };
    return { parameters: [p] };
}

export class ParameterCell extends CellBase {
    #dslHandle = null;
    /** @type {Array<{name,value,min,max,description,distribution}>} */
    #params = [];
    /** @type {HTMLElement} */
    #listEl = null;
    /** @type {Map<number, object>} Monaco editor handles for description fields */
    #descEditors = new Map();
    /** @type {Set<number>} indices currently in edit mode */
    #descEditing = new Set();
    /** @type {Map<number, DocumentationEditorWindow>} open desc editor windows */
    #descWindows = new Map();

    _getTabs() {
        return [
            { id: 'config', label: 'Parameters' },
            { id: 'dsl',    label: 'DSL' },
        ];
    }

    async renderBody(bodyEl, cell) {
        const migrated = migrateData(cell.data);
        this.#params = migrated.parameters.map(p => ({ ...p }));

        bodyEl.innerHTML = `
            <div class="param-cell-config" data-panel="config">
                <div class="param-cell-list"></div>
                <button class="param-cell-add" title="Add parameter">
                    <span class="material-symbols-outlined">add</span> Add parameter
                </button>
            </div>
            <div class="param-cell-dsl" data-panel="dsl" hidden>
                <div class="param-cell-dsl-editor"></div>
            </div>
        `;

        this.#listEl = bodyEl.querySelector('.param-cell-list');
        this.#renderAllRows();

        bodyEl.querySelector('.param-cell-add').addEventListener('click', () => {
            this.#params.push({ name: '', value: '', description: '', latex: '' });
            this.#appendRow(this.#params.length - 1);
            this._notifyChange(this.#buildData());
            const rows = this.#listEl.querySelectorAll('.param-group');
            const last = rows[rows.length - 1];
            last?.querySelector('.param-row-name')?.focus();
        });
    }

    #renderAllRows() {
        // Dispose existing description editors
        for (const handle of this.#descEditors.values()) handle.dispose?.();
        this.#descEditors.clear();
        this.#descEditing.clear();
        this.#listEl.innerHTML = '';
        for (let i = 0; i < this.#params.length; i++) {
            this.#appendRow(i);
        }
    }

    #appendRow(index) {
        const p = this.#params[index];
        const row = document.createElement('div');
        row.className = 'param-group';
        row.dataset.index = index;

        const hasDesc = !!(p.description?.trim());
        const hasLatex = !!(p.latex?.trim());

        row.innerHTML = `
            <div class="param-group-main">
                <input type="text" class="param-row-name" value="${this.#esc(p.name ?? '')}" placeholder="name" spellcheck="false"/>
                <div class="param-row-latex">
                    <input type="text" class="param-latex-input" value="${this.#esc(p.latex ?? '')}" placeholder="TeX" spellcheck="false"/>
                    <span class="param-latex-preview" title="LaTeX formula"></span>
                </div>
                <span class="param-row-eq">=</span>
                <input type="text" class="param-row-value" value="${this.#esc(p.value ?? '')}" placeholder="expression" spellcheck="false"/>
                <div class="param-row-range">
                    <input type="text" class="param-row-min" value="${this.#esc(p.min ?? '')}" placeholder="min" spellcheck="false"/>
                    <span class="param-row-dash">–</span>
                    <input type="text" class="param-row-max" value="${this.#esc(p.max ?? '')}" placeholder="max" spellcheck="false"/>
                </div>
                <select class="param-row-dist-select" title="MC distribution">
                    ${DISTRIBUTIONS.map(dd => `<option value="${dd.id}" ${(p.distribution?.type ?? 'none') === dd.id ? 'selected' : ''}>${dd.label}</option>`).join('')}
                </select>
                <div class="param-row-dist-params">${this.#renderDistParamsHtml(p)}</div>
                ${this.#renderSliderHtml(p)}
                <div class="param-row-actions">
                    <button class="param-row-delete" title="Remove parameter">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
            </div>
            <div class="param-group-desc" ${hasDesc ? '' : 'hidden'}>
                <div class="param-desc-preview"></div>
                <div class="param-desc-editor" hidden></div>
            </div>
        `;

        this.#bindRowEvents(row, index);
        this.#bindSlider(row, index);
        this.#listEl.appendChild(row);

        // Render LaTeX preview
        if (hasLatex) {
            this.#renderLatexPreview(row, index);
        }

        // Render markdown preview for description
        if (hasDesc) {
            this.#renderDescPreview(row, index);
        }
    }

    #renderLatexPreview(row, index) {
        const preview = row.querySelector('.param-latex-preview');
        if (!preview) return;
        const tex = this.#params[index].latex ?? '';
        if (tex.trim() && window.katex) {
            try {
                preview.innerHTML = window.katex.renderToString(tex.trim(), {
                    displayMode: false, throwOnError: false, strict: false,
                });
            } catch {
                preview.textContent = tex;
            }
        } else {
            preview.innerHTML = '';
        }
    }

    #renderDescPreview(row, index) {
        const preview = row.querySelector('.param-desc-preview');
        if (!preview) return;
        const desc = this.#params[index].description ?? '';
        if (desc.trim()) {
            preview.innerHTML = markdownToHtml(desc);
        } else {
            preview.innerHTML = '<span class="param-desc-placeholder">Click to add description…</span>';
        }
    }

    #enterDescEdit(row, index) {
        if (this.#descEditing.has(index)) return;
        this.#descEditing.add(index);

        const preview = row.querySelector('.param-desc-preview');
        const editorContainer = row.querySelector('.param-desc-editor');
        if (!preview || !editorContainer) return;

        preview.hidden = true;
        editorContainer.hidden = false;

        if (!this.#descEditors.has(index)) {
            const handle = this._editorFactory.createMarkdownEditor(
                editorContainer,
                this.#params[index].description ?? '',
            );

            this._disposers.push(
                handle.onDidChange(() => {
                    this.#params[index].description = handle.getValue();
                    this._notifyChange(this.#buildData());
                }),
            );

            this.#descEditors.set(index, handle);
        } else {
            this.#descEditors.get(index).setValue(this.#params[index].description ?? '');
        }

        this.#descEditors.get(index).focus?.();

        // Blur detection
        const onFocusOut = () => {
            requestAnimationFrame(() => {
                if (!editorContainer.contains(document.activeElement)) {
                    editorContainer.removeEventListener('focusout', onFocusOut);
                    this.#exitDescEdit(row, index);
                }
            });
        };
        editorContainer.addEventListener('focusout', onFocusOut);
    }

    #exitDescEdit(row, index) {
        if (!this.#descEditing.has(index)) return;
        this.#descEditing.delete(index);

        const handle = this.#descEditors.get(index);
        if (handle) {
            this.#params[index].description = handle.getValue?.() ?? '';
        }

        const preview = row.querySelector('.param-desc-preview');
        const editorContainer = row.querySelector('.param-desc-editor');

        if (editorContainer) editorContainer.hidden = true;
        if (preview) {
            preview.hidden = false;
            this.#renderDescPreview(row, index);
        }

    }

    #openDescInWindow(row, index) {
        const existing = this.#descWindows.get(index);
        if (existing) { existing.focus(); return; }

        // Exit inline edit if active
        this.#exitDescEdit(row, index);

        const paramName = this.#params[index].name || `Parameter ${index + 1}`;
        const cellId = this._cell?.id ?? 'param';

        const win = new DocumentationEditorWindow({
            cellId: `${cellId}-desc-${index}`,
            title: paramName,
            source: this.#params[index].description ?? '',
            editorFactory: this._editorFactory,
            onChange: (source) => {
                this.#params[index].description = source;
                this.#renderDescPreview(row, index);
                this._notifyChange(this.#buildData());
            },
            onClose: () => this.#descWindows.delete(index),
        });
        this.#descWindows.set(index, win);
        win.show();
    }

    #bindRowEvents(row, index) {
        const nameInput    = row.querySelector('.param-row-name');
        const valueInput   = row.querySelector('.param-row-value');
        const minInput     = row.querySelector('.param-row-min');
        const maxInput     = row.querySelector('.param-row-max');
        const distSelect   = row.querySelector('.param-row-dist-select');
        const distParams   = row.querySelector('.param-row-dist-params');
        const deleteBtn    = row.querySelector('.param-row-delete');
        const latexInput   = row.querySelector('.param-latex-input');
        const descSection  = row.querySelector('.param-group-desc');
        const descPreview  = row.querySelector('.param-desc-preview');

        const update = () => this._notifyChange(this.#buildData());

        nameInput.addEventListener('input', () => { this.#params[index].name = nameInput.value; update(); });
        valueInput.addEventListener('input', () => { this.#params[index].value = valueInput.value; this.#updateSlider(row, index); update(); });
        minInput.addEventListener('input', () => { this.#params[index].min = minInput.value; this.#updateSlider(row, index); update(); });
        maxInput.addEventListener('input', () => { this.#params[index].max = maxInput.value; this.#updateSlider(row, index); update(); });

        distSelect.addEventListener('change', () => {
            this.#params[index].distribution = { type: distSelect.value };
            distParams.innerHTML = this.#renderDistParamsHtml(this.#params[index]);
            this.#bindDistParamInputs(distParams, index);
            update();
        });
        this.#bindDistParamInputs(distParams, index);

        // Click preview → enter edit mode
        descPreview.addEventListener('click', () => this.#enterDescEdit(row, index));

        // Double-click description area → open in popout window
        descSection.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.#openDescInWindow(row, index);
        }, true);

        latexInput.addEventListener('input', () => {
            this.#params[index].latex = latexInput.value;
            this.#renderLatexPreview(row, index);
            update();
        });

        deleteBtn.addEventListener('click', () => {
            const handle = this.#descEditors.get(index);
            handle?.dispose?.();
            this.#descEditors.delete(index);
            this.#descEditing.delete(index);
            this.#params.splice(index, 1);
            this.#renderAllRows();
            update();
        });
    }

    #bindDistParamInputs(container, paramIndex) {
        container.querySelectorAll('.param-dist-param-input').forEach(input => {
            input.addEventListener('input', () => {
                this.#params[paramIndex].distribution = {
                    ...this.#params[paramIndex].distribution,
                    [input.dataset.key]: input.value,
                };
                this._notifyChange(this.#buildData());
            });
        });
    }

    #renderSliderHtml(p) {
        const min = parseFloat(p.min);
        const max = parseFloat(p.max);
        if (isNaN(min) || isNaN(max) || min >= max) return '';
        const val = parseFloat(p.value);
        const clamped = isNaN(val) ? min : Math.max(min, Math.min(max, val));
        const step = (max - min) <= 10 ? 0.01 : (max - min) <= 1000 ? 0.1 : 1;
        return `
            <div class="param-group-slider">
                <input type="range" class="param-slider-input"
                       min="${min}" max="${max}" step="${step}" value="${clamped}"/>
                <span class="param-slider-value">${clamped}</span>
            </div>
        `;
    }

    #bindSlider(row, index) {
        const slider = row.querySelector('.param-slider-input');
        if (!slider) return;

        const valueDisplay = row.querySelector('.param-slider-value');
        const valueInput = row.querySelector('.param-row-value');

        slider.addEventListener('input', () => {
            this.#params[index].value = slider.value;
            if (valueDisplay) valueDisplay.textContent = slider.value;
            if (valueInput) valueInput.value = slider.value;
            this._notifyChange(this.#buildData());
        });
    }

    #updateSlider(row, index) {
        const p = this.#params[index];
        const sliderSection = row.querySelector('.param-group-slider');
        const min = parseFloat(p.min);
        const max = parseFloat(p.max);
        const hasRange = !isNaN(min) && !isNaN(max) && min < max;

        if (hasRange) {
            if (!sliderSection) {
                // Insert slider right before the actions div
                const actionsDiv = row.querySelector('.param-row-actions');
                const tmp = document.createElement('div');
                tmp.innerHTML = this.#renderSliderHtml(p);
                const newSlider = tmp.firstElementChild;
                if (newSlider && actionsDiv) {
                    actionsDiv.insertAdjacentElement('beforebegin', newSlider);
                    this.#bindSlider(row, index);
                }
            } else {
                const slider = sliderSection.querySelector('.param-slider-input');
                const valueDisplay = sliderSection.querySelector('.param-slider-value');
                if (slider) {
                    const step = (max - min) <= 10 ? 0.01 : (max - min) <= 1000 ? 0.1 : 1;
                    slider.min = min;
                    slider.max = max;
                    slider.step = step;
                    const val = parseFloat(p.value);
                    const clamped = isNaN(val) ? min : Math.max(min, Math.min(max, val));
                    slider.value = clamped;
                    if (valueDisplay) valueDisplay.textContent = clamped;
                }
            }
        } else if (sliderSection) {
            sliderSection.remove();
        }
    }

    #renderDistParamsHtml(p) {
        const distDef = DISTRIBUTIONS.find(d => d.id === (p.distribution?.type ?? 'none'));
        if (!distDef?.params) return '';
        const existing = p.distribution ?? {};
        return distDef.params.map(dp => `
            <label class="param-dist-param">
                <span>${dp.label}</span>
                <input type="text" class="param-dist-param-input" data-key="${dp.key}" value="${this.#esc(String(existing[dp.key] ?? ''))}"/>
            </label>
        `).join('');
    }

    #buildData() {
        // Flush description editors back to params
        for (const [idx, handle] of this.#descEditors) {
            if (this.#params[idx]) {
                this.#params[idx].description = handle.getValue?.() ?? '';
            }
        }
        return { parameters: this.#params.map(p => ({ ...p })) };
    }

    _onTabChanged(tabId) {
        const bodyEl = this._container.querySelector('.cell-body');
        if (!bodyEl) return;

        bodyEl.querySelector('[data-panel="config"]')?.toggleAttribute('hidden', tabId !== 'config');
        const dslPanel = bodyEl.querySelector('[data-panel="dsl"]');
        if (dslPanel) {
            dslPanel.toggleAttribute('hidden', tabId !== 'dsl');
            if (tabId === 'dsl') {
                if (!this.#dslHandle) {
                    const editorContainer = dslPanel.querySelector('.param-cell-dsl-editor');
                    this.#dslHandle = this._editorFactory.createDslViewer(editorContainer, this.getGeneratedDsl());
                } else {
                    this.#dslHandle.setValue(this.getGeneratedDsl());
                }
            }
        }
    }

    getGeneratedDsl() {
        return this.#params
            .filter(p => p.name?.trim())
            .map(p => this.#paramToDsl(p))
            .join('\n');
    }

    #paramToDsl(p) {
        const name = p.name.trim();
        const value = p.value || '0';
        const comment = p.description ? `  ; ${p.description}` : '';
        let dsl = `${name} = ${value}${comment}`;

        if (p.distribution?.type && p.distribution.type !== 'none') {
            const dist = p.distribution;
            const params = Object.entries(dist)
                .filter(([k]) => k !== 'type')
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            dsl += `\n; MC: ${dist.type}(${params})`;
        }

        if (p.min !== undefined && p.min !== '') {
            dsl += `\n; range: [${p.min}, ${p.max ?? ''}]`;
        }

        return dsl;
    }

    getData() {
        return this.#buildData();
    }

    focus() {
        const first = this.#listEl?.querySelector('.param-row-name');
        first?.focus();
    }

    dispose() {
        this.#dslHandle?.dispose();
        this.#dslHandle = null;
        for (const handle of this.#descEditors.values()) handle.dispose?.();
        this.#descEditors.clear();
        this.#descEditing.clear();
        for (const win of this.#descWindows.values()) win.close();
        this.#descWindows.clear();
        super.dispose();
    }

    #esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ─── Static table rendering (for embedding in documentation) ─────────

    /**
     * Format a numeric value in scientific notation using LaTeX, or return
     * the raw value string if it isn't a plain number.
     * @param {string} value
     * @returns {string} HTML string (KaTeX-rendered or escaped text)
     */
    static formatValueScientific(value) {
        const s = String(value ?? '').trim();
        if (!s) return '<span class="param-table__empty">—</span>';

        const num = Number(s);
        if (!isFinite(num)) {
            // Not a number — return as variable name
            const el = document.createElement('span');
            el.textContent = s;
            return `<span class="param-table__var-name">${el.innerHTML}</span>`;
        }

        // Small enough to display plainly
        if (Math.abs(num) < 1e4 && Math.abs(num) >= 0.01 || num === 0) {
            return `<span class="param-table__value">${s}</span>`;
        }

        // Scientific notation via KaTeX
        const exp = Math.floor(Math.log10(Math.abs(num)));
        const mantissa = num / Math.pow(10, exp);
        // Round mantissa to reasonable precision
        const m = Math.abs(mantissa - Math.round(mantissa)) < 1e-10
            ? Math.round(mantissa)
            : parseFloat(mantissa.toPrecision(4));

        const tex = m === 1
            ? `10^{${exp}}`
            : `${m} \\times 10^{${exp}}`;

        if (window.katex) {
            try {
                return window.katex.renderToString(tex, {
                    displayMode: false, throwOnError: false, strict: false,
                });
            } catch { /* fall through */ }
        }
        return `<span class="param-table__value">${s}</span>`;
    }

    /**
     * Format the notation column: LaTeX symbol (if available) or variable name.
     * @param {{ name?: string, latex?: string }} p
     * @returns {string} HTML
     */
    static formatNotation(p) {
        const tex = (p.latex ?? '').trim();
        const name = p.name ?? '';
        const nameEsc = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        if (tex && window.katex) {
            try {
                const rendered = window.katex.renderToString(tex, {
                    displayMode: false, throwOnError: false, strict: false,
                });
                return `<span class="param-table__latex">${rendered}</span>`
                     + `<span class="param-table__code-name">${nameEsc}</span>`;
            } catch { /* fall through */ }
        }
        return `<span class="param-table__code-name">${nameEsc}</span>`;
    }

    /**
     * Format a distribution for table display.
     * @param {object|null} dist
     * @returns {string} HTML
     */
    static formatDistribution(dist) {
        if (!dist || dist.type === 'none') return '<span class="param-table__empty">—</span>';
        switch (dist.type) {
            case 'normal':     return `Normal(\u03bc=${dist.mean}, \u03c3=${dist.std})`;
            case 'uniform':    return `Uniform(${dist.min}, ${dist.max})`;
            case 'triangular': return `Tri(${dist.low}, ${dist.mode}, ${dist.high})`;
            case 'lognormal':  return `LogN(\u03bc=${dist.mu}, \u03c3=${dist.sigma})`;
            case 'beta':       return `Beta(\u03b1=${dist.alpha}, \u03b2=${dist.beta})`;
            default:           return dist.type;
        }
    }

    /**
     * Render an array of parameters as an HTML table suitable for embedding
     * in documentation previews.
     *
     * @param {Array<{name, value, latex?, description?, min?, max?, distribution?}>} parameters
     * @param {{ showDistribution?: boolean }} options
     * @returns {string} HTML table
     */
    static renderAsTable(parameters, { showDistribution = false } = {}) {
        if (!parameters?.length) return '';

        const distCol = showDistribution;
        const esc = (s) => {
            const el = document.createElement('span');
            el.textContent = String(s ?? '');
            return el.innerHTML;
        };

        const headerCells = [
            '<th class="param-table__th">Symbol</th>',
            '<th class="param-table__th param-table__th--value">Value</th>',
            '<th class="param-table__th param-table__th--desc">Description</th>',
        ];
        if (distCol) {
            headerCells.push('<th class="param-table__th param-table__th--dist">Distribution</th>');
        }

        const rows = parameters.filter(p => p.name?.trim()).map(p => {
            const cells = [
                `<td class="param-table__td param-table__td--symbol">${ParameterCell.formatNotation(p)}</td>`,
                `<td class="param-table__td param-table__td--value">${ParameterCell.formatValueScientific(p.value)}</td>`,
                `<td class="param-table__td param-table__td--desc">${markdownToHtml(p.description ?? '')}</td>`,
            ];
            if (distCol) {
                cells.push(`<td class="param-table__td param-table__td--dist">${ParameterCell.formatDistribution(p.distribution)}</td>`);
            }
            return `<tr>${cells.join('')}</tr>`;
        });

        return `<table class="param-table">`
             + `<thead><tr>${headerCells.join('')}</tr></thead>`
             + `<tbody>${rows.join('')}</tbody>`
             + `</table>`;
    }
}
