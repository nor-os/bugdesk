/**
 * scenario_comparison_table.js
 *
 * Scenario comparison scorecard: one row per configured KPI, one column
 * per compared scenario (baseline first), showing each KPI's latest value
 * and its delta vs baseline.
 *
 * The tile's config is PlotCell-shaped (`subplots[0].yAxes[0].series[]`)
 * purely so it rides dashboard_tab.js's EXISTING data-fetch + "Compare
 * scenarios" pipeline (`_renderOnce` / `_expandedRenderConfig`) for free —
 * nothing here draws a chart. `_expandedRenderConfig` stashes a
 * `subplot._compareMeta` ({ baselineId, baselineLabel, scenarios }) that
 * this widget reads to build columns; the row identity is recovered by
 * stripping the `::scenarioId` suffix dashboard_tab.js's `_compareKey`
 * appends to each expanded series' `variable`.
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';
import { DataTable } from '../../ui/components/data_table.js';
import { AutocompleteField } from '../../ui/components/autocomplete_field.js';
import {
    variableProvider, buildNamespaceOptions, resolveNamespaceForVariable,
} from '../../charting/plot_config_panel.js';
import { uid } from '../../notebook/cells/plot_cell.js';

const CURRENT_COL = '__current__';

/** Default (well-formed) config for a freshly-added tile. Kept as a
 *  function (not a shared literal) so every tile gets its own ids. */
export function defaultScenarioComparisonConfig() {
    return {
        layout: '1x1',
        subplots: [{
            id: uid('sp'),
            displayName: 'Scenario Comparison',
            yAxes: [{ id: uid('y'), series: [] }],
            compare: { mode: 'overlay', scenarios: ['baseline'], baseline: 'baseline' },
        }],
    };
}

export class ScenarioComparisonTable extends TileBase {
    static TYPE = 'scenario-comparison-table';
    static TITLE = 'Scenario Comparison';
    static ICON = 'compare_arrows';
    static DESCRIPTION = 'Latest KPI values side by side across scenarios';
    static DEFAULT_SIZE = { w: 6, h: 4 };
    static SIZE_CONSTRAINTS = { minW: 4, minH: 3, maxW: 12, maxH: 8 };
    static EXPANDABLE = true;

    constructor(options) {
        super(options);
        this._dataTable = null;
    }

    getDefaultConfig() {
        return defaultScenarioComparisonConfig();
    }

    render(data) {
        if (!this.contentElement) return;

        const table = this._computeTable(data);
        if (table.rows.length === 0) {
            this.showEmpty('Add a KPI row via the config button');
            return;
        }

        // Preserve the body scroll position across the full rebuild below — a
        // live data push re-renders the whole DataTable, which otherwise snaps
        // the scorecard back to the top on every tick.
        const prevScroll =
            this.contentElement.querySelector('.preview-table-wrap')?.scrollTop || 0;

        if (this._dataTable) {
            this._dataTable.dispose();
            this._dataTable = null;
        }
        this.contentElement.innerHTML = '';
        const container = document.createElement('div');
        container.style.cssText = 'height: 100%; min-height: 0;';
        this.contentElement.appendChild(container);

        this._dataTable = new DataTable(container, {
            headers: table.headers,
            rows: table.rows,
            pagination: false,
            selectable: false,
            copyable: false,
            sortable: false,
            readonly: true,
            emptyMessage: 'Add a KPI row via the config button',
            formatValue: (value, colIdx) => (colIdx === 0 ? value : this.formatNumber(value)),
            renderCell: (td, value, colIdx, rowIdx, row) => {
                if (colIdx === 0) return false;
                const delta = row._deltas?.[colIdx];
                if (value == null) {
                    td.textContent = '—';
                    return true;
                }
                td.innerHTML = '';
                const valueSpan = document.createElement('span');
                valueSpan.textContent = this.formatNumber(value);
                td.appendChild(valueSpan);
                if (delta != null && Number.isFinite(delta.abs)) {
                    const up = delta.abs > 1e-9;
                    const down = delta.abs < -1e-9;
                    const arrow = up ? '▲' : down ? '▼' : '■';
                    const color = up ? '#2ecc71' : down ? '#e55353' : 'rgba(255,255,255,0.5)';
                    const deltaSpan = document.createElement('span');
                    deltaSpan.style.cssText = `color:${color};font-size:11px;margin-left:6px;white-space:nowrap;`;
                    deltaSpan.textContent = `${arrow}${this.formatNumber(Math.abs(delta.abs))}`;
                    td.appendChild(deltaSpan);
                }
                return true;
            },
        });
        this._dataTable.render();

        // Restore the scroll position the rebuild reset. The DataTable builds
        // its `.preview-table-wrap` synchronously; a rAF pass also covers the
        // async column-width measurement that can change body height.
        const restore = () => {
            const wrap = this.contentElement?.querySelector('.preview-table-wrap');
            if (wrap && prevScroll) wrap.scrollTop = prevScroll;
        };
        restore();
        requestAnimationFrame(restore);
    }

    getExpandData() {
        const table = this._computeTable(this.data);
        if (table.rows.length === 0) return null;
        const tableRows = table.rows.map((r) => r.map((v, i) => (i === 0 ? v : this.formatNumber(v))));
        return {
            title: this.constructor.TITLE, traces: [], layout: {},
            tableHeaders: table.headers, tableRows,
        };
    }

    /** Build {headers, rows} from the current (possibly compare-expanded)
     *  config + the latest pushed data. One row per distinct KPI
     *  (`series[].variable`, stripped of any `::scenarioId` suffix); one
     *  column per entry in `subplot._compareMeta` (baseline first), or a
     *  single "Current" column when compare mode is off.
     * @private
     */
    _computeTable(data) {
        const sp = this.config?.subplots?.[0];
        const series = sp?.yAxes?.[0]?.series || [];
        if (series.length === 0) return { headers: ['KPI'], rows: [] };

        const meta = sp._compareMeta;
        const columns = meta
            ? [{ id: meta.baselineId, label: meta.baselineLabel }, ...meta.scenarios]
            : [{ id: CURRENT_COL, label: 'Current' }];

        // Row identity = the KPI (the user's original `variable`) with EVERY
        // trailing `::<scenarioId>` suffix peeled off. dashboard_tab's compare
        // expansion appends one `::<scenarioId>` per rendered scenario; the
        // column is that suffix. Peeling only KNOWN scenario ids (from the
        // columns above) — never a stray `::` inside a real variable name —
        // collapses each KPI's per-scenario series back into ONE row. Peeling
        // in a loop keeps it one row even if a stale/expanded config was
        // expanded twice (`var::sidA::sidB`), so the table can never split a
        // KPI into per-scenario rows.
        const scenarioIds = new Set(
            columns.map((c) => c.id).filter((id) => id !== CURRENT_COL));
        const rowsByVar = new Map(); // origVar -> { label, cells: Map(colId -> number|null) }
        for (const s of series) {
            const raw = s.variable;
            if (!raw) continue;
            let origVar = raw;
            let colId = CURRENT_COL;
            for (;;) {
                const idx = origVar.lastIndexOf('::');
                if (idx < 0) break;
                const seg = origVar.slice(idx + 2);
                if (!scenarioIds.has(seg)) break;
                if (colId === CURRENT_COL) colId = seg; // outermost suffix = the column
                origVar = origVar.slice(0, idx);
            }
            let row = rowsByVar.get(origVar);
            if (!row) {
                // Compare-mode expansion (dashboard_tab.js) overwrites
                // `s.label` with a legend-formatted string and stashes the
                // real original in `_origLabel`; outside compare mode
                // `s.label` is untouched. Prefer whichever actually holds
                // the user's raw label.
                const rawLabel = (s._origLabel !== undefined ? s._origLabel : s.label) || '';
                row = { label: rawLabel.trim() || this.formatLabel(origVar), cells: new Map() };
                rowsByVar.set(origVar, row);
            }
            row.cells.set(colId, this.#lastFinite(data?.indicators?.[raw]));
        }

        const headers = ['KPI', ...columns.map((c) => c.label)];
        const rows = [];
        for (const row of rowsByVar.values()) {
            const baselineVal = row.cells.get(columns[0].id) ?? null;
            const arr = [row.label];
            const deltas = [null];
            columns.forEach((col, i) => {
                const v = row.cells.get(col.id) ?? null;
                arr.push(v);
                deltas.push(i === 0 || v == null || baselineVal == null ? null : { abs: v - baselineVal });
            });
            arr._deltas = deltas;
            rows.push(arr);
        }
        return { headers, rows };
    }

    #lastFinite(arr) {
        if (!Array.isArray(arr)) return null;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (Number.isFinite(arr[i])) return arr[i];
        }
        return null;
    }

    dispose() {
        if (this._dataTable) {
            this._dataTable.dispose();
            this._dataTable = null;
        }
        super.dispose();
    }
}

registerWidget(ScenarioComparisonTable);

// ─── Lightweight config panel ───────────────────────────────────────────
//
// A dedicated, minimal editor for this tile — NOT the full renderPlotConfig
// (chart type / axes / colors are meaningless for a table). Same contract
// as renderPlotConfig: mutates `config` in place, calls `onChange()` after
// every edit; the host (dashboard_tab.js) re-renders + persists.

let _acUid = 0;

/**
 * @param {HTMLElement} container
 * @param {Object} config - PlotCell-shaped tile config (mutated in place)
 * @param {Object} opts
 * @param {Function} opts.onChange
 * @param {Function} [opts.symbolProvider] - () => Array<{name, kind, namespace?}>
 * @param {Function} [opts.scenarioProvider] - () => Array<{id, label}>
 */
export function renderScenarioComparisonConfig(container, config, opts = {}) {
    const { onChange = () => {}, symbolProvider = null, scenarioProvider = null } = opts;

    const sp = config.subplots[0];
    sp.yAxes[0].series = sp.yAxes[0].series || [];
    sp.compare = sp.compare || { mode: 'overlay', scenarios: [], baseline: 'baseline' };
    if (!Array.isArray(sp.compare.scenarios)) sp.compare.scenarios = [];
    if (!sp.compare.scenarios.includes('baseline')) sp.compare.scenarios.unshift('baseline');

    let liveAutocompletes = [];
    const notify = () => onChange();

    function sectionTitle(text) {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'font-size:12px;font-weight:600;color:rgba(255,255,255,0.7);'
            + 'margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;';
        return el;
    }

    function build() {
        for (const ac of liveAutocompletes) ac.dispose();
        liveAutocompletes = [];
        container.innerHTML = '';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;padding:4px;';

        // --- KPI rows ---
        const kpiSection = document.createElement('div');
        kpiSection.appendChild(sectionTitle('KPI rows'));

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
        sp.yAxes[0].series.forEach((s, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;align-items:center;';

            const ac = _appendKpiVariableInput(row, s, symbolProvider, notify);
            if (ac) liveAutocompletes.push(ac);

            const labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.className = 'config-input';
            labelInput.placeholder = 'Label (optional)';
            labelInput.value = s.label || '';
            labelInput.style.cssText = 'flex:0 0 140px;min-width:0;';
            labelInput.addEventListener('input', () => { s.label = labelInput.value; notify(); });
            row.appendChild(labelInput);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'ea-btn ea-btn--small';
            removeBtn.title = 'Remove';
            removeBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">close</span>';
            removeBtn.addEventListener('click', () => {
                sp.yAxes[0].series.splice(idx, 1);
                notify();
                build();
            });
            row.appendChild(removeBtn);

            list.appendChild(row);
        });
        kpiSection.appendChild(list);

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ea-btn ea-btn--small';
        addBtn.style.marginTop = '8px';
        addBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">add</span><span>Add KPI</span>';
        addBtn.addEventListener('click', () => {
            sp.yAxes[0].series.push({ id: uid('s'), variable: '', label: '' });
            notify();
            build();
        });
        kpiSection.appendChild(addBtn);
        wrap.appendChild(kpiSection);

        // --- Scenario columns ---
        const scenarios = scenarioProvider ? scenarioProvider() : [];
        if (scenarios.length > 0) {
            const scSection = document.createElement('div');
            scSection.appendChild(sectionTitle('Scenario columns'));
            scSection.appendChild((() => {
                const hint = document.createElement('p');
                hint.textContent = 'Baseline is always shown first. Pick which other scenarios appear as columns.';
                hint.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.45);margin:0 0 8px;';
                return hint;
            })());

            const chips = document.createElement('div');
            chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

            const baselineChip = document.createElement('span');
            baselineChip.textContent = 'Baseline';
            baselineChip.style.cssText = 'padding:4px 10px;border:1px solid rgba(255,255,255,0.2);'
                + 'background:rgba(255,255,255,0.08);font-size:12px;opacity:0.6;';
            chips.appendChild(baselineChip);

            for (const scen of scenarios) {
                const on = sp.compare.scenarios.includes(scen.id);
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ea-btn ea-btn--small';
                chip.style.cssText = `padding:4px 10px;font-size:12px;${on
                    ? 'background:rgba(95,168,211,0.25);border-color:#5fa8d3;' : ''}`;
                chip.textContent = scen.label || scen.id;
                chip.addEventListener('click', () => {
                    const i = sp.compare.scenarios.indexOf(scen.id);
                    if (i >= 0) sp.compare.scenarios.splice(i, 1);
                    else sp.compare.scenarios.push(scen.id);
                    notify();
                    build();
                });
                chips.appendChild(chip);
            }
            scSection.appendChild(chips);
            wrap.appendChild(scSection);
        }

        container.appendChild(wrap);
    }

    build();

    return {
        dispose: () => {
            for (const ac of liveAutocompletes) ac.dispose();
            liveAutocompletes = [];
        },
    };
}

/** Append a variable autocomplete bound to `s.variable`. Mirrors
 *  plot_config_panel's appendVariableInput (module-private there) —
 *  trimmed to what a KPI row needs, no per-series scenario/color fields. */
function _appendKpiVariableInput(parent, s, symbolProvider, notify) {
    if (!symbolProvider) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'config-input';
        input.value = s.variable || '';
        input.placeholder = 'KPI variable';
        input.style.cssText = 'flex:1;min-width:0;';
        input.addEventListener('input', () => { s.variable = input.value; notify(); });
        parent.appendChild(input);
        return null;
    }

    const symbols = symbolProvider();
    const namespaceOptions = buildNamespaceOptions(symbols);
    const initialNs = resolveNamespaceForVariable(symbols, s.variable);

    const ac = new AutocompleteField({
        fieldId: `sct-var-ac-${++_acUid}`,
        field: { placeholder: 'KPI variable', value: s.variable || '' },
        namespace: initialNs,
        namespaceOptions,
        showNamespaceSelect: true,
        skipNamespacePrefix: true,
        variant: 'notebook',
        provider: ({ value, namespace: ns }) => variableProvider(symbolProvider(), value, ns),
        onChange: (value, { namespace: ns } = {}) => {
            const qualified = ns && ns !== '__ALL__' && value && !value.includes('.') ? `${ns}.${value}` : value;
            s.variable = qualified;
            notify();
        },
    });
    const el = ac.render();
    el.classList.add('series-autocomplete');
    el.style.flex = '1';
    parent.appendChild(el);
    return ac;
}

export default ScenarioComparisonTable;
