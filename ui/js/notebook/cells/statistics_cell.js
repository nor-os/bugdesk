/**
 * StatisticsCell — rolling statistics / time-series aggregation.
 *
 * DSL functions:
 *   `name = rolling_mean(input, window)`
 *   `name = rolling_std(input, window)`
 *   `name = rolling_min(input, window)`
 *   `name = rolling_max(input, window)`
 *   `name = ema(input, alpha)`
 *   `name = cumsum(input)`
 *
 * Tabs: Config | DSL
 *
 * Data model:
 *   { name, input, functionType, windowSize, alpha }
 */

import { CellBase, getCellTheme } from './cell_base.js';
import { CellPreviewCanvas } from './cell_preview_canvas.js';

const STAT_FUNCTIONS = [
    { id: 'rolling_mean', label: 'Rolling Mean',     group: 'window', icon: 'show_chart' },
    { id: 'rolling_std',  label: 'Rolling Std Dev',  group: 'window', icon: 'ssid_chart' },
    { id: 'rolling_min',  label: 'Rolling Min',      group: 'window', icon: 'vertical_align_bottom' },
    { id: 'rolling_max',  label: 'Rolling Max',      group: 'window', icon: 'vertical_align_top' },
    { id: 'ema',          label: 'EMA',              group: 'ema',    icon: 'trending_flat' },
    { id: 'cumsum',       label: 'Cumulative Sum',   group: 'none',   icon: 'stacked_line_chart' },
];

const FUNC_BY_ID = Object.fromEntries(STAT_FUNCTIONS.map(f => [f.id, f]));

export class StatisticsCell extends CellBase {
    #dslHandle = null;
    #data = null;
    #preview = null;

    _getTabs() {
        return [
            { id: 'config', label: 'Config' },
            { id: 'dsl',    label: 'DSL' },
        ];
    }

    async renderBody(bodyEl, cell) {
        this.#data = {
            name:         '',
            input:        '',
            functionType: 'rolling_mean',
            windowSize:   '5',
            alpha:        '0.3',
            ...cell.data,
        };
        this.#rebuildBody(bodyEl);
    }

    #rebuildBody(bodyEl) {
        this.#preview?.dispose();
        this.#preview = null;

        const d = this.#data;
        const func = FUNC_BY_ID[d.functionType] ?? STAT_FUNCTIONS[0];

        bodyEl.innerHTML = `
            <div data-panel="config" class="smooth-cell">
                <div class="smooth-row">
                    <div class="smooth-field">
                        <label class="smooth-label">Output name</label>
                        <input class="smooth-input" data-field="name"
                               value="${this.#esc(d.name)}" placeholder="e.g. avg_price"/>
                    </div>
                </div>
                <div class="gen-waveform-picker">
                    ${STAT_FUNCTIONS.map(f => `
                        <button class="gen-wave-btn ${f.id === d.functionType ? 'gen-wave-btn--active' : ''}"
                                data-fn="${f.id}" title="${f.label}">
                            <span class="material-symbols-outlined">${f.icon}</span>
                            <span>${f.label}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="smooth-row">
                    <div class="smooth-field">
                        <label class="smooth-label">Input expression</label>
                        <div class="stats-inline-editor" data-editor-field="input"></div>
                    </div>
                    ${func.group === 'window' ? `
                        <div class="smooth-field smooth-field--short">
                            <label class="smooth-label">Window size</label>
                            <input class="smooth-input" data-field="windowSize"
                                   value="${this.#esc(d.windowSize)}" placeholder="5"/>
                        </div>
                    ` : ''}
                    ${func.group === 'ema' ? `
                        <div class="smooth-field smooth-field--short">
                            <label class="smooth-label">Alpha <span class="smooth-hint">(0, 1)</span></label>
                            <input class="smooth-input" data-field="alpha"
                                   value="${this.#esc(d.alpha)}" placeholder="0.3"/>
                        </div>
                    ` : ''}
                </div>
                <div class="stats-schematic-container"></div>
            </div>
            <div data-panel="dsl" hidden>
                <div class="smooth-dsl-editor"></div>
            </div>
        `;

        // Function picker
        bodyEl.querySelectorAll('[data-fn]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.#data.functionType = btn.dataset.fn;
                this.#rebuildBody(bodyEl);
                this._notifyChange(this.#data);
            });
        });

        // Param inputs
        bodyEl.querySelectorAll('[data-field]').forEach(el => {
            el.addEventListener('input', () => {
                this.#data[el.dataset.field] = el.value;
                this._notifyChange(this.#data);
            });
        });

        // Mount inline Monaco editor for input
        bodyEl.querySelectorAll('[data-editor-field]').forEach(container => {
            const field = container.dataset.editorField;
            this._createInlineExpressionEditor(container, d[field] || '', (val) => {
                this.#data[field] = val;
                this._notifyChange(this.#data);
            });
        });

        // Mount schematic
        const schematicContainer = bodyEl.querySelector('.stats-schematic-container');
        const theme = getCellTheme('statistics');
        this.#preview = new CellPreviewCanvas(schematicContainer, { color: theme.primary });
        this.#drawSchematic();
    }

    #drawSchematic() {
        if (!this.#preview) return;
        const funcType = this.#data.functionType;
        const func = FUNC_BY_ID[funcType] ?? STAT_FUNCTIONS[0];

        this.#preview.plotSchematic((svg, w, h, color) => {
            const cy = h / 2;
            const boxW = 110, boxH = 36, r = 4;
            const boxX = (w - boxW) / 2;

            // Input arrow + label
            svg.line(12, cy, boxX, cy, { stroke: color + '80', width: 1.5 });
            svg.text('x(t)', 12, cy - 10, { fill: color + '80', font: '9px "Segoe UI", system-ui, sans-serif' });

            // Box + label
            svg.rect(boxX, cy - boxH / 2, boxW, boxH, { fill: color + '18', stroke: color, strokeWidth: 1.5, r });
            svg.text(func.label, boxX + boxW / 2, cy, { fill: color, font: 'bold 10px "Consolas", monospace', anchor: 'middle', baseline: 'central' });

            // Output arrow
            svg.line(boxX + boxW, cy, w - 12, cy, { stroke: color + '80', width: 1.5 });
            svg.polygon([[w - 12, cy], [w - 18, cy - 4], [w - 18, cy + 4]], { fill: color + '80' });
            svg.text('y(t)', w - 12, cy - 10, { fill: color + '80', font: '9px "Segoe UI", system-ui, sans-serif', anchor: 'end' });
        });
    }

    _onTabChanged(tabId) {
        const bodyEl = this._container?.querySelector('.cell-body');
        if (!bodyEl) return;
        bodyEl.querySelectorAll('[data-panel]').forEach(p => {
            p.toggleAttribute('hidden', p.dataset.panel !== tabId);
        });
        if (tabId === 'dsl') {
            const container = bodyEl.querySelector('.smooth-dsl-editor');
            const dsl = this.getGeneratedDsl();
            if (!this.#dslHandle) {
                this.#dslHandle = this._editorFactory?.createDslViewer?.(container, dsl);
            } else {
                this.#dslHandle.setValue(dsl);
            }
        }
    }

    getGeneratedDsl() {
        const d = this.#data;
        const name   = d.name?.trim()  || 'stat_output';
        const input  = d.input?.trim() || 'x';
        const fn     = d.functionType || 'rolling_mean';

        switch (fn) {
            case 'rolling_mean':
            case 'rolling_std':
            case 'rolling_min':
            case 'rolling_max':
                return `${name} = ${fn}(${input}, ${d.windowSize || '5'})`;
            case 'ema':
                return `${name} = ema(${input}, ${d.alpha || '0.3'})`;
            case 'cumsum':
                return `${name} = cumsum(${input})`;
            default:
                return `${name} = ${fn}(${input})`;
        }
    }

    getData() { return { ...this.#data }; }

    dispose() {
        this.#preview?.dispose();
        this.#preview = null;
        this.#dslHandle?.dispose();
        this.#dslHandle = null;
        super.dispose();
    }

    #esc(s) { return String(s ?? '').replace(/"/g, '&quot;'); }
}
