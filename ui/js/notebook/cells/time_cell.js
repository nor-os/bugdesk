/**
 * TimeCell — named time-based expression.
 *
 * Creates a named variable from a time-based expression.
 * Built-in time variables available in all expressions: t, t0, t1, dt
 *
 * DSL: `name = expression`   (default expression: t)
 *
 * Compact body shows: name = expression
 * Full config in slide-out panel.
 */

import { CellBase } from './cell_base.js';

const TIME_PRESETS = [
    { label: 'Current time',    expr: 't' },
    { label: 'Start time',      expr: 't0' },
    { label: 'End time',        expr: 't1' },
    { label: 'Step size',       expr: 'dt' },
    { label: 'Elapsed time',    expr: 't - t0' },
    { label: 'Progress (0–1)',  expr: '(t - t0) / (t1 - t0)' },
];

export class TimeCell extends CellBase {
    #data = null;
    /** @type {object|null} panel container ref for cleanup */
    #panelDisposers = [];

    _getTabs() {
        return [
            { id: 'config', label: 'Summary' },
            { id: 'dsl',    label: 'DSL' },
        ];
    }

    async renderBody(bodyEl, cell) {
        this.#data = {
            name:       '',
            expression: 't',
            ...cell.data,
        };
        this._buildCompactSummary(bodyEl, this.#summaryHtml(), false, this.#data);
    }

    #summaryHtml() {
        const name = this.#data.name?.trim() || 'time_var';
        const expr = this.#data.expression?.trim() || 't';
        return `<span class="compact-name">${this.#esc(name)}</span>` +
               ` <span class="compact-dim">=</span> ${this.#esc(expr)}`;
    }

    // ─── Config binding (slide-out panel) ────────────────────────────────

    getConfigBinding() {
        return {
            title: 'Time Config',
            icon: 'schedule',
            renderConfig: (container) => this.#renderConfigPanel(container),
        };
    }

    #renderConfigPanel(container) {
        // Clean up previous panel editors
        for (const d of this.#panelDisposers) d?.dispose?.();
        this.#panelDisposers = [];

        const d = this.#data;
        const presetOpts = TIME_PRESETS.map(p =>
            `<option value="${this.#esc(p.expr)}">${p.label} (${p.expr})</option>`
        ).join('');

        container.innerHTML = `
            <div class="smooth-cell">
                <div class="smooth-row">
                    <div class="smooth-field">
                        <label class="smooth-label">Output name</label>
                        <input class="smooth-input" data-field="name"
                               value="${this.#esc(d.name)}" placeholder="e.g. elapsed"/>
                    </div>
                </div>
                <div class="smooth-row">
                    <div class="smooth-field smooth-field--func">
                        <label class="smooth-label">Expression</label>
                        <input class="smooth-input" data-field="expression"
                               value="${this.#esc(d.expression)}" placeholder="t"/>
                    </div>
                </div>
                <div class="smooth-row">
                    <div class="smooth-field smooth-field--func">
                        <label class="smooth-label">Preset <span class="smooth-hint">available: t, t0, t1, dt</span></label>
                        <select class="smooth-select" id="time-preset-select">
                            <option value="">— pick a preset —</option>
                            ${presetOpts}
                        </select>
                    </div>
                </div>
            </div>
        `;

        container.querySelectorAll('[data-field]').forEach(el => {
            el.addEventListener('input', () => {
                this.#data[el.dataset.field] = el.value;
                this._updateCompactSummary(this.#summaryHtml());
                this._notifyChange(this.#data);
            });
        });

        const presetSel = container.querySelector('#time-preset-select');
        const exprInput = container.querySelector('[data-field="expression"]');
        presetSel.addEventListener('change', () => {
            if (!presetSel.value) return;
            exprInput.value = presetSel.value;
            this.#data.expression = presetSel.value;
            presetSel.value = '';
            this._updateCompactSummary(this.#summaryHtml());
            this._notifyChange(this.#data);
        });
    }

    // ─── Tab switching ───────────────────────────────────────────────────

    _onTabChanged(tabId) {
        this._onCompactTabChanged(tabId);
    }

    getGeneratedDsl() {
        const d = this.#data;
        const name  = d.name?.trim()      || 'time_var';
        const expr  = d.expression?.trim() || 't';
        return `${name} = ${expr}`;
    }

    getData() { return { ...this.#data }; }

    dispose() {
        for (const d of this.#panelDisposers) d?.dispose?.();
        this.#panelDisposers = [];
        this._compactDslHandle?.dispose();
        this._compactDslHandle = null;
        super.dispose();
    }

    #esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
}
