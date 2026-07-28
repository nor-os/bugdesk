/**
 * plot_config_panel.js
 *
 * Standalone config panel for PlotCell-format chart data.
 * Renders layout picker, subplot tabs, X axis, chart type, Y-axes, Z axis (3D),
 * series (with stack group), and display options into any container element.
 *
 * Uses the same CSS classes as the original canvas PlotNode config panel
 * (from plot.css and main_new.css) for visual parity.
 *
 * Used by:
 *   - SimulationRunPage (right panel for selected dashboard plot tile)
 *   - PlotCell (inline config tab — delegates here)
 */

import { getSeriesColor } from './plotly_wrapper.js';
import { CHART_TYPES_2D, CHART_TYPES_3D } from './chart_types.js';
import {
    PLOT_LAYOUTS,
    makeDefaultSubplot,
    uid,
    esc,
} from '../notebook/cells/plot_cell.js';
import { AutocompleteField } from '../ui/components/autocomplete_field.js';

// ─── Symbol helpers (shared across all autocomplete instances) ───────────────

export const PLOTTABLE_KINDS = new Set([
    'variable', 'parameter', 'stock', 'generator', 'smooth', 'pid',
    'schedule', 'delay', 'latch', 'conditional-switch', 'time',
    // EcoAgent analytics emits indicators (and agent-scoped variables)
    // — add them so the axis dropdown actually surfaces them. Without
    // these, the agent/source picker was empty even though symbols
    // were flowing through.
    'indicator', 'agent',
]);

/**
 * Build namespace options from raw symbols.
 * @param {Array<{name:string, kind:string}>} symbols
 * @returns {Array<{value:string, label:string, token:string}>}
 */
export function buildNamespaceOptions(symbols) {
    const options = [{ value: '__ALL__', label: 'All', token: 'All' }];
    const seen = new Set();
    for (const sym of symbols) {
        // Two emission styles supported:
        //   1. Ecosim model-stream: discrete `kind: 'namespace'` markers
        //      that delimit a namespace block (Global, Foo, Bar…).
        //   2. EcoAgent analytics-stream: indicator/agent/stock symbols
        //      that each carry a `namespace` field (the source id).
        // The axis dropdown was previously empty in mode (2) because
        // we only looked at (1). Collect from both so every host
        // populates a usable namespace picker.
        const nsName = sym.kind === 'namespace' ? sym.name : sym.namespace;
        if (!nsName || seen.has(nsName)) continue;
        seen.add(nsName);
        options.push({ value: nsName, label: nsName, token: nsName });
    }
    return options;
}

/**
 * Resolve the namespace a variable belongs to by scanning symbols.
 * Returns the namespace name or '__ALL__' if not found / ambiguous.
 */
export function resolveNamespaceForVariable(symbols, varName) {
    if (!varName) return '__ALL__';

    // Same dual-emission story as buildNamespaceOptions: a namespace
    // can show up as either a `kind:'namespace'` marker (Ecosim) or
    // the `.namespace` field on an indicator (EcoAgent analytics).
    const nsOf = (sym) => sym.kind === 'namespace' ? sym.name : sym.namespace;

    // Handle namespace-qualified names: "Namespace.variable"
    const dotIdx = varName.indexOf('.');
    if (dotIdx > 0) {
        const nsCandidate = varName.slice(0, dotIdx);
        const bareName = varName.slice(dotIdx + 1);
        // Verify the namespace exists in symbols
        for (const sym of symbols) {
            const ns = nsOf(sym);
            if (ns && ns.toLowerCase() === nsCandidate.toLowerCase()) {
                return ns;
            }
        }
        // Namespace not found in symbols — try resolving the bare variable name
        return resolveNamespaceForVariable(symbols, bareName);
    }

    const lower = varName.toLowerCase();
    let currentNamespace = 'Global';
    for (const sym of symbols) {
        if (sym.kind === 'namespace') { currentNamespace = sym.name; continue; }
        if (sym.name.toLowerCase() === lower && PLOTTABLE_KINDS.has(sym.kind)) {
            return sym.namespace || currentNamespace;
        }
    }
    return '__ALL__';
}

/**
 * Autocomplete provider matching the test_file_editor pattern.
 * Filters symbols by namespace and search fragment, returns items
 * in the shape AutocompleteField expects.
 *
 * @param {Array<{name:string, kind:string}>} symbols — raw symbols from symbolProvider
 * @param {string} value   — search fragment typed by user
 * @param {string} namespace — selected namespace or '__ALL__'
 * @returns {Array<{label:string, insertText:string, type:string, metadata:Object}>}
 */
export function variableProvider(symbols, value, namespace) {
    const fragment = (value || '').toLowerCase().trim();
    const items = [];
    const seen = new Set();
    let currentNamespace = 'Global';

    for (const sym of symbols) {
        if (sym.kind === 'namespace') {
            currentNamespace = sym.name;
            continue;
        }
        if (sym.kind === 'import') continue;
        if (!PLOTTABLE_KINDS.has(sym.kind)) continue;

        const symNs = sym.namespace || currentNamespace;
        if (namespace && namespace !== '__ALL__' && symNs !== namespace) continue;

        const name = sym.name;
        const dedup = `${symNs}.${name}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);

        if (fragment && !name.toLowerCase().includes(fragment)) continue;

        items.push({
            label: name,
            insertText: name,
            type: sym.kind === 'stock' ? 'stock'
                : sym.kind === 'parameter' ? 'constant'
                : 'variable',
            metadata: { namespace: symNs, namespaceId: symNs },
        });
    }

    return items;
}


/**
 * Render a full plot config panel into a container.
 *
 * @param {HTMLElement} container — DOM element to render into (cleared first)
 * @param {Object} data — PlotCell data model (mutated in place)
 * @param {Object} opts
 * @param {Function} opts.onChange — called after any config change
 * @param {Function} [opts.symbolProvider] — () => Array<{name, kind, namespace?}> raw symbols
 * @param {boolean} [opts.showCaptionDescription=false] — show caption + description fields (paper/notebook)
 * @param {Function} [opts.onLayoutChange] — called when layout changes (receives layout key)
 * @param {boolean} [opts.hideDocumentation=false] — drop the Documentation section
 *   entirely. EcoAgent's dashboard tiles don't surface the ⓘ tooltip so the
 *   field is dead weight there; notebook/paper mode keeps it.
 * @param {Object} [opts.tickContext] — opt-in defaults for tick-based timelines
 *   (EcoAgent's world clock is integer ticks, not calendar years). When set,
 *   the HP-Lambda hint drops calendar-frequency advice and Shaded-Bands
 *   defaults use small integers instead of year-2000s.
 * @returns {{ rerender: Function, getActiveSubplotIdx: Function, dispose: Function }}
 */
export function renderPlotConfig(container, data, opts = {}) {
    const {
        onChange, symbolProvider,
        showCaption: showCaptionDescription = false,
        onLayoutChange, overlaySourceProvider, scenarioProvider,
        hideDocumentation = false,
        tickContext = null,
        // EcoAgent's dashboards are 2D time series only — 3D charts
        // add clutter (Z-axis section, surface/scatter3d/line3d
        // options) and no value here. Notebook/paper mode keeps the
        // 3D path; dashboard mode passes hide3d:true to drop it.
        hide3d = false,
        // Per-series scenario picker is paper/notebook-mode only —
        // it pins each series to a different saved scenario for
        // cross-scenario comparison. The EcoAgent dashboard plots
        // off the live world (or the active scenario via the
        // top-bar scenario switch), so this picker is dead weight
        // in the per-row width budget. The Baseline Scenario picker
        // in Display Options still uses `scenarioProvider`.
        hidePerSeriesScenario = false,
        // Per-series stack-group input — sets the stacking key for
        // stacked bar/area charts. Rarely used and the dashboard's
        // narrow row can do without it; notebook/paper keeps it.
        hideStackGroup = false,
        // Hodrick-Prescott trend / cycle filter rows + lambda
        // smoothing input. Useful for macroeconomic calendar-time
        // series; less so for tick-based ABM output (the recommended
        // lambda values are calibrated against quarterly/annual
        // frequencies). EcoAgent dashboards opt out by default.
        hideHpFilter = false,
        // Cosmetic: strip a leading "type:" prefix from namespace
        // *labels* in the variable autocomplete (EcoAgent source IDs
        // like `group:cap`, `market:goods` carry a type tag that
        // reads as noise once it's the only kind of source on the
        // page). The stored value is unaffected.
        stripNamespacePrefix = false,
        // Drop the X-axis section entirely and force every subplot
        // to plot against simulation time. EcoAgent dashboards almost
        // always plot vs ticks, so the "Use simulation time" toggle
        // is dead chrome.
        hideXAxisConfig = false,
        // () => [{name, value, source, label}] — names recognised in
        // the Reference Lines value column. When the user types a
        // matching name the line tracks that constant; raw numbers
        // still work as before.
        constantsProvider = null,
    } = opts;
    let activeSubplotIdx = 0;
    /** @type {AutocompleteField[]} */
    let liveAutocompletes = [];

    function notify() { onChange?.(); }

    function disposeAutocompletes() {
        for (const ac of liveAutocompletes) ac.dispose();
        liveAutocompletes = [];
    }

    function render() {
        disposeAutocompletes();
        container.innerHTML = '';

        const stack = document.createElement('div');
        stack.className = 'plot-config-stack';

        // Documentation (shown as an ⓘ hover-tooltip on the tile header).
        // Hidden in contexts where the tooltip isn't surfaced.
        if (!hideDocumentation) {
            stack.appendChild(renderSection('Documentation', renderDocsField(data, notify)));
        }

        // Layout picker
        stack.appendChild(renderSection('Layout', renderLayoutPicker(data, () => {
            activeSubplotIdx = 0;
            ensureSubplots(data, PLOT_LAYOUTS[data.layout]?.slots ?? 1);
            onLayoutChange?.(data.layout);
            notify();
            render();
        })));

        // Caption + Description fields (optional — paper/notebook mode)
        if (showCaptionDescription) {
            stack.appendChild(renderSection('Caption', renderCaptionField(data, notify)));
            stack.appendChild(renderSection('Description', renderDescriptionField(data, notify)));
        }

        // Subplot tabs (if more than 1 slot)
        const tmpl = PLOT_LAYOUTS[data.layout] || PLOT_LAYOUTS['1x1'];
        if (tmpl.slots > 1) {
            stack.appendChild(renderSubplotTabs(tmpl.slots, activeSubplotIdx, (idx) => {
                activeSubplotIdx = idx;
                render();
            }));
        }

        // Active subplot config
        ensureSubplots(data, tmpl.slots);
        const sp = data.subplots[activeSubplotIdx];
        if (sp) {
            renderSubplotConfig(stack, sp, notify, () => render(),
                symbolProvider, liveAutocompletes,
                overlaySourceProvider, scenarioProvider, tickContext,
                {
                    hide3d, hidePerSeriesScenario,
                    hideStackGroup, hideHpFilter,
                    stripNamespacePrefix, hideXAxisConfig,
                    constantsProvider,
                });
        }

        container.appendChild(stack);
    }

    render();

    return {
        rerender: render,
        getActiveSubplotIdx: () => activeSubplotIdx,
        dispose: disposeAutocompletes,
    };
}


// ─── Section wrapper ────────────────────────────────────────────────────────

function renderSection(title, content) {
    const section = document.createElement('div');
    section.className = 'config-section config-section-wide';

    const header = document.createElement('h4');
    header.className = 'config-section-header';
    header.textContent = title;
    section.appendChild(header);

    if (content instanceof HTMLElement) {
        section.appendChild(content);
    }
    return section;
}


// ─── Layout Picker ──────────────────────────────────────────────────────────

function renderLayoutPicker(data, onLayoutChange) {
    const picker = document.createElement('div');
    picker.className = 'plot-layout-picker';

    for (const [key, tmpl] of Object.entries(PLOT_LAYOUTS)) {
        const btn = document.createElement('button');
        btn.className = `plot-layout-btn${key === data.layout ? ' plot-layout-btn--active' : ''}`;
        btn.textContent = tmpl.label;
        btn.title = tmpl.label;
        btn.addEventListener('click', () => {
            if (key === data.layout) return;
            data.layout = key;
            ensureSubplots(data, PLOT_LAYOUTS[key].slots);
            onLayoutChange();
        });
        picker.appendChild(btn);
    }
    return picker;
}


// ─── Caption Field (plot-level title, rendered above chart) ─────────────────

function renderCaptionField(data, notify) {
    const row = document.createElement('div');
    row.className = 'config-row';
    row.innerHTML = `
        <label class="config-label">Caption</label>
        <input type="text" class="config-input"
               value="${esc(data.caption ?? '')}"
               placeholder="Plot title (optional)">
    `;
    row.querySelector('.config-input').addEventListener('input', (e) => {
        data.caption = e.target.value;
        notify();
    });
    return row;
}


// ─── Description Field (rendered below chart with "Figure N:" prefix) ───────

function renderDocsField(data, notify) {
    const row = document.createElement('div');
    row.className = 'config-row';
    const current = (data.docs ?? '');
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.5);margin:0 0 4px;';
    hint.textContent = 'Plain-text description shown as an ⓘ hover tooltip on the tile header.';
    row.appendChild(hint);
    const ta = document.createElement('textarea');
    ta.className = 'config-input';
    ta.rows = 5;
    ta.style.cssText = 'resize:vertical;font-family:inherit;font-size:12px;line-height:1.4;';
    ta.placeholder = 'e.g. "Share of total tax revenue from labor. Germany ~58%."';
    ta.value = current;
    ta.addEventListener('input', () => {
        data.docs = ta.value;
        notify();
    });
    row.appendChild(ta);
    return row;
}

function renderDescriptionField(data, notify) {
    const row = document.createElement('div');
    row.className = 'config-row';
    row.innerHTML = `
        <label class="config-label">Description</label>
        <input type="text" class="config-input"
               value="${esc(data.description ?? '')}"
               placeholder="Figure description (optional)">
    `;
    row.querySelector('.config-input').addEventListener('input', (e) => {
        data.description = e.target.value;
        notify();
    });
    return row;
}


// ─── Subplot Tabs ───────────────────────────────────────────────────────────

function renderSubplotTabs(slotCount, activeIdx, onSelect) {
    const bar = document.createElement('div');
    bar.className = 'plot-subplot-tabs';
    for (let i = 0; i < slotCount; i++) {
        const btn = document.createElement('button');
        btn.className = `plot-subplot-tab${i === activeIdx ? ' plot-subplot-tab--active' : ''}`;
        btn.textContent = `Subplot ${i + 1}`;
        btn.addEventListener('click', () => onSelect(i));
        bar.appendChild(btn);
    }
    return bar;
}


// ─── Subplot Config ─────────────────────────────────────────────────────────

function renderSubplotConfig(stack, sp, notify, rerender, symbolProvider, liveAutocompletes, overlaySourceProvider, scenarioProvider, tickContext, flags = {}) {
    const {
        hide3d = false,
        hidePerSeriesScenario = false,
        hideStackGroup = false,
        hideHpFilter = false,
        stripNamespacePrefix = false,
        hideXAxisConfig = false,
        constantsProvider = null,
    } = flags;
    // Ensure xAxis defaults. When the X-axis section is hidden, force
    // useTime so the data model agrees with the only available option.
    if (!sp.xAxis) sp.xAxis = { useTime: true, variable: '' };
    if (hideXAxisConfig) {
        sp.xAxis.useTime = true;
        sp.xAxis.variable = '';
    }

    // 3D mode is opt-out for EcoAgent — when hidden we always force 2D.
    const hasZAxis = hide3d ? false : !!(sp.zAxis?.variable);

    // Display name
    {
        const section = renderSection('Metadata', null);
        const row = document.createElement('div');
        row.className = 'config-row';
        row.innerHTML = `
            <label class="config-label">Display Name</label>
            <input type="text" class="config-input" value="${esc(sp.displayName)}" placeholder="Chart title"/>
        `;
        row.querySelector('.config-input').addEventListener('input', e => {
            sp.displayName = e.target.value;
            notify();
        });
        section.appendChild(row);
        stack.appendChild(section);
    }

    // X Axis config — entirely hidden when hideXAxisConfig is set
    // (dashboard mode always plots vs simulation time).
    if (!hideXAxisConfig) {
        stack.appendChild(renderSection('X Axis', renderXAxisConfig(sp, notify, symbolProvider, liveAutocompletes, { stripNamespacePrefix })));
    }

    // Y Axes
    {
        const section = renderSection('Y Axes', null);
        const list = document.createElement('div');
        list.className = 'plot-y-axes-list';
        for (const axis of sp.yAxes) {
            list.appendChild(renderYAxis(axis, sp, notify, rerender, symbolProvider, liveAutocompletes, overlaySourceProvider, scenarioProvider, { hidePerSeriesScenario, hideStackGroup, stripNamespacePrefix }));
        }
        section.appendChild(list);

        // Add Y Axis button
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-axis';
        addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add Y Axis';
        if (hasZAxis) {
            addBtn.disabled = true;
            addBtn.title = 'Remove Z axis to add more Y axes';
        }
        addBtn.addEventListener('click', () => {
            if (addBtn.disabled) return;
            sp.yAxes.push({
                id: uid('y'),
                label: `Y ${sp.yAxes.length + 1}`,
                scale: 'linear',
                position: sp.yAxes.length % 2 === 0 ? 'left' : 'right',
                min: null, max: null, step: null,
                series: [],
            });
            rerender();
            notify();
        });
        section.appendChild(addBtn);
        stack.appendChild(section);
    }

    // Z Axis (3D) — hidden entirely when hide3d is set (EcoAgent dashboard).
    if (!hide3d) {
        stack.appendChild(renderSection('Z Axis (3D)', renderZAxisConfig(sp, notify, rerender, symbolProvider, liveAutocompletes)));
    }

    // Display options (chart type + toggles + selects)
    stack.appendChild(renderSection('Display Options', renderDisplayOptions(sp, hasZAxis, notify, scenarioProvider, tickContext, { hide3d, hideHpFilter, constantsProvider })));
}


// ─── X Axis Config ──────────────────────────────────────────────────────────

function renderXAxisConfig(sp, notify, symbolProvider, liveAutocompletes, flags = {}) {
    const frag = document.createElement('div');
    frag.className = 'config-custom-section';

    // "Use simulation time" checkbox
    const checkRow = document.createElement('div');
    checkRow.className = 'config-checkbox-row';
    checkRow.innerHTML = `
        <input type="checkbox" id="x-axis-time-toggle" ${sp.xAxis.useTime ? 'checked' : ''}/>
        <label for="x-axis-time-toggle">Use simulation time</label>
    `;
    const timeCheck = checkRow.querySelector('input');
    frag.appendChild(checkRow);

    // Variable picker (shown when useTime is off)
    const varContainer = document.createElement('div');
    varContainer.className = 'x-axis-variable-container';
    varContainer.style.display = sp.xAxis.useTime ? 'none' : 'block';

    const varRow = document.createElement('div');
    varRow.className = 'config-row';

    const varLabel = document.createElement('label');
    varLabel.className = 'config-label';
    varLabel.textContent = 'Variable';
    varRow.appendChild(varLabel);

    appendVariableInput(varRow, sp.xAxis, 'variable', 'X axis variable', notify, symbolProvider, liveAutocompletes, undefined, flags);

    varContainer.appendChild(varRow);
    frag.appendChild(varContainer);

    timeCheck.addEventListener('change', () => {
        sp.xAxis.useTime = timeCheck.checked;
        varContainer.style.display = timeCheck.checked ? 'none' : 'block';
        notify();
    });

    return frag;
}


// ─── Z Axis (3D) Config ─────────────────────────────────────────────────────

function renderZAxisConfig(sp, notify, rerender, symbolProvider, liveAutocompletes) {
    const frag = document.createElement('div');
    frag.className = 'config-custom-section';

    if (!sp.zAxis) {
        // Show "Add Z Axis" button — only when exactly 1 Y axis
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-axis';
        addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add Z Axis';
        if (sp.yAxes.length !== 1) {
            addBtn.disabled = true;
            addBtn.title = '3D charts require exactly 1 Y axis';
        }
        addBtn.addEventListener('click', () => {
            if (addBtn.disabled) return;
            sp.zAxis = {
                label: 'Z',
                scale: 'linear',
                min: null,
                max: null,
                step: null,
                variable: '',
            };
            rerender();
            notify();
        });
        frag.appendChild(addBtn);
        return frag;
    }

    // Z axis is configured — show as axis group
    const group = document.createElement('div');
    group.className = 'plot-axis-group';

    const header = document.createElement('div');
    header.className = 'plot-axis-header';
    header.innerHTML = `
        <span class="axis-label">${esc(sp.zAxis.label || 'Z Axis')}</span>
        <div class="axis-header-actions">
            <button class="btn-icon btn-remove" data-action="remove-z" title="Remove Z axis">
                <span class="material-symbols-outlined">close</span>
            </button>
        </div>
    `;
    header.querySelector('[data-action="remove-z"]').addEventListener('click', () => {
        sp.zAxis = null;
        // Reset to 2D chart type if currently 3D
        if (['scatter3d', 'line3d', 'surface'].includes(sp.chartType)) {
            sp.chartType = 'line';
        }
        rerender();
        notify();
    });
    group.appendChild(header);

    // Axis config fields
    const configRow = document.createElement('div');
    configRow.className = 'plot-axis-config';
    configRow.innerHTML = `
        <div class="axis-config-field">
            <label>Label</label>
            <input type="text" data-field="label" value="${esc(sp.zAxis.label)}" placeholder="Z label"/>
        </div>
        <div class="axis-config-field">
            <label>Scale</label>
            <select data-field="scale">
                <option value="linear" ${sp.zAxis.scale === 'linear' ? 'selected' : ''}>Linear</option>
                <option value="log" ${sp.zAxis.scale === 'log' ? 'selected' : ''}>Log</option>
            </select>
        </div>
        <div class="axis-config-field">
            <label>Min</label>
            <input type="number" data-field="min" step="any" value="${sp.zAxis.min ?? ''}" placeholder="Auto"/>
        </div>
        <div class="axis-config-field">
            <label>Max</label>
            <input type="number" data-field="max" step="any" value="${sp.zAxis.max ?? ''}" placeholder="Auto"/>
        </div>
        <div class="axis-config-field">
            <label>Step</label>
            <input type="number" data-field="step" step="any" value="${sp.zAxis.step ?? ''}" placeholder="Auto"/>
        </div>
    `;

    configRow.querySelectorAll('[data-field]').forEach(input => {
        const evt = input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(evt, () => {
            const f = input.dataset.field;
            if (['min', 'max', 'step'].includes(f)) {
                sp.zAxis[f] = input.value === '' ? null : parseFloat(input.value);
            } else {
                sp.zAxis[f] = input.value;
            }
            if (f === 'label') {
                const labelEl = group.querySelector('.axis-label');
                if (labelEl) labelEl.textContent = input.value || 'Z Axis';
            }
            notify();
        });
    });
    group.appendChild(configRow);

    // Z variable picker
    const varItem = document.createElement('div');
    varItem.className = 'plot-z-series-item';
    appendVariableInput(varItem, sp.zAxis, 'variable', 'Z axis variable', notify, symbolProvider, liveAutocompletes);
    group.appendChild(varItem);

    frag.appendChild(group);
    return frag;
}


// ─── Y Axis ─────────────────────────────────────────────────────────────────

function renderYAxis(axis, sp, notify, rerender, symbolProvider, liveAutocompletes, overlaySourceProvider, scenarioProvider, flags = {}) {
    const group = document.createElement('div');
    group.className = 'plot-y-axis-group';

    const header = document.createElement('div');
    header.className = 'plot-y-axis-header';
    header.innerHTML = `
        <span class="axis-label">${esc(axis.label || 'Y Axis')}</span>
        <div class="axis-header-actions">
            <button class="btn-icon" data-action="add-series" title="Add series">
                <span class="material-symbols-outlined">add</span>
            </button>
            ${sp.yAxes.length > 1 ? `
                <button class="btn-icon btn-remove" data-action="remove-axis" title="Remove axis">
                    <span class="material-symbols-outlined">close</span>
                </button>
            ` : ''}
        </div>
    `;

    header.querySelector('[data-action="add-series"]')?.addEventListener('click', () => {
        const idx = axis.series.length;
        axis.series.push({
            id: uid('s'),
            variable: '', label: '',
            color: getSeriesColor(idx),
            lineWidth: 2, lineStyle: 'solid', stackGroup: '',
        });
        rerender();
        notify();
    });

    header.querySelector('[data-action="remove-axis"]')?.addEventListener('click', () => {
        const idx = sp.yAxes.indexOf(axis);
        if (idx >= 0) sp.yAxes.splice(idx, 1);
        rerender();
        notify();
    });

    group.appendChild(header);

    // Axis config row
    const configRow = document.createElement('div');
    configRow.className = 'plot-axis-config';
    configRow.innerHTML = `
        <div class="axis-config-field">
            <label>Scale</label>
            <select data-field="scale">
                <option value="linear" ${axis.scale === 'linear' ? 'selected' : ''}>Linear</option>
                <option value="log" ${axis.scale === 'log' ? 'selected' : ''}>Log</option>
            </select>
        </div>
        <div class="axis-config-field">
            <label>Position</label>
            <select data-field="position">
                <option value="left" ${axis.position === 'left' ? 'selected' : ''}>Left</option>
                <option value="right" ${axis.position === 'right' ? 'selected' : ''}>Right</option>
            </select>
        </div>
        <div class="axis-config-field">
            <label>Min</label>
            <input type="number" data-field="min" step="any" value="${axis.min ?? ''}" placeholder="Auto"/>
        </div>
        <div class="axis-config-field">
            <label>Max</label>
            <input type="number" data-field="max" step="any" value="${axis.max ?? ''}" placeholder="Auto"/>
        </div>
        <div class="axis-config-field">
            <label>Step</label>
            <input type="number" data-field="step" step="any" value="${axis.step ?? ''}" placeholder="Auto"/>
        </div>
    `;

    configRow.querySelectorAll('[data-field]').forEach(input => {
        const evt = input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(evt, () => {
            const f = input.dataset.field;
            if (['min', 'max', 'step'].includes(f)) {
                axis[f] = input.value === '' ? null : parseFloat(input.value);
            } else {
                axis[f] = input.value;
            }
            notify();
        });
    });

    group.appendChild(configRow);

    // Series list
    const seriesList = document.createElement('div');
    seriesList.className = 'plot-series-list';
    if (axis.series.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'no-series';
        empty.textContent = 'No series \u2014 click + to add';
        seriesList.appendChild(empty);
    }
    for (const s of axis.series) {
        seriesList.appendChild(renderSeriesItem(s, axis, notify, rerender, symbolProvider, liveAutocompletes, overlaySourceProvider, scenarioProvider, flags));
    }
    group.appendChild(seriesList);

    return group;
}


// ─── Series Item ────────────────────────────────────────────────────────────

function renderSeriesItem(s, axis, notify, rerender, symbolProvider, liveAutocompletes, overlaySourceProvider, scenarioProvider, flags = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'plot-series-wrapper';

    const row = document.createElement('div');
    row.className = 'plot-series-item';

    // Scenario selector (paper/notebook mode only — hidden in
    // EcoAgent's dashboard mode where it's dead weight and crowds
    // the per-row width budget).
    if (scenarioProvider && !flags.hidePerSeriesScenario) {
        const scenarioSelect = document.createElement('select');
        scenarioSelect.className = 'series-scenario';
        scenarioSelect.title = 'Source scenario for this series';
        const scenarios = scenarioProvider();
        scenarioSelect.innerHTML = `
            <option value="">— scenario —</option>
            ${scenarios.map(sc => `<option value="${sc.path}" ${s.scenario === sc.path ? 'selected' : ''}>${sc.name}</option>`).join('')}
        `;
        scenarioSelect.addEventListener('change', () => { s.scenario = scenarioSelect.value || null; notify(); });
        row.appendChild(scenarioSelect);
    }

    // Variable autocomplete (with namespace select)
    appendVariableInput(row, s, 'variable', 'variable name', notify, symbolProvider, liveAutocompletes, (name) => {
        // Auto-fill legend label from variable name when label is empty
        if (!s.label) {
            s.label = name;
            const labelInput = row.querySelector('.series-label');
            if (labelInput) labelInput.value = name;
        }
    }, flags);

    // Legend label
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'series-label';
    labelInput.value = s.label || '';
    labelInput.placeholder = 'Legend label';
    labelInput.title = 'Legend label (defaults to variable name)';
    labelInput.addEventListener('input', () => { s.label = labelInput.value; notify(); });
    row.appendChild(labelInput);

    // Color
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'series-color';
    colorInput.value = s.color || getSeriesColor(0);
    colorInput.addEventListener('input', () => { s.color = colorInput.value; notify(); });
    row.appendChild(colorInput);

    // Width
    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.className = 'series-width';
    widthInput.value = s.lineWidth ?? 2;
    widthInput.min = '1';
    widthInput.max = '10';
    widthInput.title = 'Line width';
    widthInput.addEventListener('input', () => { s.lineWidth = parseInt(widthInput.value, 10) || 2; notify(); });
    row.appendChild(widthInput);

    // Style
    const styleSelect = document.createElement('select');
    styleSelect.className = 'series-style';
    styleSelect.title = 'Line style';
    styleSelect.innerHTML = `
        <option value="solid" ${s.lineStyle === 'solid' ? 'selected' : ''}>Solid</option>
        <option value="dashed" ${s.lineStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
        <option value="dotted" ${s.lineStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
    `;
    styleSelect.addEventListener('change', () => { s.lineStyle = styleSelect.value; notify(); });
    row.appendChild(styleSelect);

    // Stack group — rarely used; the dashboard mode drops it to keep
    // the row narrow. Notebook/paper mode keeps the field.
    if (!flags.hideStackGroup) {
        const stackInput = document.createElement('input');
        stackInput.type = 'text';
        stackInput.className = 'series-stack-group';
        stackInput.value = s.stackGroup ?? '';
        stackInput.placeholder = 'Stack';
        stackInput.title = 'Stack group (series with same group are stacked)';
        stackInput.addEventListener('input', () => { s.stackGroup = stackInput.value || null; notify(); });
        row.appendChild(stackInput);
    }

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon btn-remove';
    removeBtn.title = 'Remove series';
    removeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
    removeBtn.addEventListener('click', () => {
        const idx = axis.series.indexOf(s);
        if (idx >= 0) axis.series.splice(idx, 1);
        rerender();
        notify();
    });
    row.appendChild(removeBtn);

    wrapper.appendChild(row);

    // ── Overlay (ETL actuals) section ─────────────────────────────
    if (overlaySourceProvider) {
        wrapper.appendChild(renderOverlaySection(s, notify, overlaySourceProvider));
    }

    return wrapper;
}


// ─── Overlay section per series ──────────────────────────────────────────────

function renderOverlaySection(s, notify, overlaySourceProvider) {
    const section = document.createElement('div');
    section.className = 'plot-overlay-section';

    const hasOverlay = !!s.overlay?.etlKey;

    // Toggle header
    const toggle = document.createElement('div');
    toggle.className = 'plot-overlay-toggle';
    toggle.innerHTML = `
        <span class="material-symbols-outlined plot-overlay-chevron">${hasOverlay ? 'expand_more' : 'chevron_right'}</span>
        <span class="plot-overlay-toggle-label">${hasOverlay ? `Overlay: ${s.overlay.label || s.overlay.etlKey}` : 'Overlay'}</span>
    `;

    const fields = document.createElement('div');
    fields.className = 'plot-overlay-fields';
    fields.style.display = hasOverlay ? '' : 'none';

    toggle.addEventListener('click', () => {
        const open = fields.style.display !== 'none';
        fields.style.display = open ? 'none' : '';
        toggle.querySelector('.plot-overlay-chevron').textContent = open ? 'chevron_right' : 'expand_more';
    });

    section.appendChild(toggle);

    // Populate overlay fields
    const populateFields = (sources) => {
        fields.innerHTML = '';

        // ETL Source select
        const sourceRow = document.createElement('div');
        sourceRow.className = 'plot-overlay-row';
        const sourceLabel = document.createElement('label');
        sourceLabel.textContent = 'ETL Source';
        sourceRow.appendChild(sourceLabel);
        const sourceSelect = document.createElement('select');
        sourceSelect.className = 'plot-overlay-input';
        sourceSelect.innerHTML = '<option value="">(None)</option>';
        // Group by category
        const byCategory = {};
        for (const src of sources) {
            const cat = src.category || 'other';
            (byCategory[cat] ??= []).push(src);
        }
        for (const [cat, items] of Object.entries(byCategory).sort()) {
            const group = document.createElement('optgroup');
            group.label = cat.charAt(0).toUpperCase() + cat.slice(1);
            for (const item of items) {
                const opt = document.createElement('option');
                opt.value = item.etlKey;
                opt.textContent = item.label;
                if (s.overlay?.etlKey === item.etlKey) opt.selected = true;
                group.appendChild(opt);
            }
            sourceSelect.appendChild(group);
        }
        sourceSelect.addEventListener('change', () => {
            if (!sourceSelect.value) {
                s.overlay = null;
                toggle.querySelector('.plot-overlay-toggle-label').textContent = 'Overlay';
                fields.style.display = 'none';
                toggle.querySelector('.plot-overlay-chevron').textContent = 'chevron_right';
            } else {
                const src = sources.find(x => x.etlKey === sourceSelect.value);
                s.overlay = {
                    etlKey: sourceSelect.value,
                    label: `${s.label || s.variable} (actual)`,
                    color: lightenColor(s.color || '#888888'),
                    lineStyle: 'dashed',
                    lineWidth: 2,
                    mode: 'markers+lines',
                };
                toggle.querySelector('.plot-overlay-toggle-label').textContent =
                    `Overlay: ${src?.label || sourceSelect.value}`;
                // Re-populate to show detail fields
                populateFields(sources);
                fields.style.display = '';
                toggle.querySelector('.plot-overlay-chevron').textContent = 'expand_more';
            }
            notify();
        });
        sourceRow.appendChild(sourceSelect);
        fields.appendChild(sourceRow);

        // Detail fields (only when overlay is active)
        if (s.overlay?.etlKey) {
            // Label
            const labelRow = document.createElement('div');
            labelRow.className = 'plot-overlay-row';
            labelRow.innerHTML = '<label>Label</label>';
            const ovLabel = document.createElement('input');
            ovLabel.type = 'text';
            ovLabel.className = 'plot-overlay-input';
            ovLabel.value = s.overlay.label || '';
            ovLabel.placeholder = 'Overlay legend label';
            ovLabel.addEventListener('input', () => { s.overlay.label = ovLabel.value; notify(); });
            labelRow.appendChild(ovLabel);
            fields.appendChild(labelRow);

            // Color
            const colorRow = document.createElement('div');
            colorRow.className = 'plot-overlay-row';
            colorRow.innerHTML = '<label>Color</label>';
            const ovColor = document.createElement('input');
            ovColor.type = 'color';
            ovColor.className = 'plot-overlay-color';
            ovColor.value = s.overlay.color || '#888888';
            ovColor.addEventListener('input', () => { s.overlay.color = ovColor.value; notify(); });
            colorRow.appendChild(ovColor);
            fields.appendChild(colorRow);

            // Line Style
            const styleRow = document.createElement('div');
            styleRow.className = 'plot-overlay-row';
            styleRow.innerHTML = '<label>Style</label>';
            const ovStyle = document.createElement('select');
            ovStyle.className = 'plot-overlay-input';
            ovStyle.innerHTML = `
                <option value="solid" ${s.overlay.lineStyle === 'solid' ? 'selected' : ''}>Solid</option>
                <option value="dashed" ${s.overlay.lineStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
                <option value="dotted" ${s.overlay.lineStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
            `;
            ovStyle.addEventListener('change', () => { s.overlay.lineStyle = ovStyle.value; notify(); });
            styleRow.appendChild(ovStyle);
            fields.appendChild(styleRow);

            // Line Width
            const widthRow = document.createElement('div');
            widthRow.className = 'plot-overlay-row';
            widthRow.innerHTML = '<label>Width</label>';
            const ovWidth = document.createElement('input');
            ovWidth.type = 'number';
            ovWidth.className = 'plot-overlay-input';
            ovWidth.value = s.overlay.lineWidth ?? 2;
            ovWidth.min = '1';
            ovWidth.max = '10';
            ovWidth.addEventListener('input', () => { s.overlay.lineWidth = parseInt(ovWidth.value, 10) || 2; notify(); });
            widthRow.appendChild(ovWidth);
            fields.appendChild(widthRow);

            // Mode
            const modeRow = document.createElement('div');
            modeRow.className = 'plot-overlay-row';
            modeRow.innerHTML = '<label>Mode</label>';
            const ovMode = document.createElement('select');
            ovMode.className = 'plot-overlay-input';
            ovMode.innerHTML = `
                <option value="markers+lines" ${s.overlay.mode === 'markers+lines' ? 'selected' : ''}>Markers + Lines</option>
                <option value="markers" ${s.overlay.mode === 'markers' ? 'selected' : ''}>Markers</option>
                <option value="lines" ${s.overlay.mode === 'lines' ? 'selected' : ''}>Lines</option>
            `;
            ovMode.addEventListener('change', () => { s.overlay.mode = ovMode.value; notify(); });
            modeRow.appendChild(ovMode);
            fields.appendChild(modeRow);

            // Clear button
            const clearBtn = document.createElement('button');
            clearBtn.className = 'btn-overlay-clear';
            clearBtn.textContent = 'Remove overlay';
            clearBtn.addEventListener('click', () => {
                s.overlay = null;
                toggle.querySelector('.plot-overlay-toggle-label').textContent = 'Overlay';
                fields.style.display = 'none';
                toggle.querySelector('.plot-overlay-chevron').textContent = 'chevron_right';
                notify();
            });
            fields.appendChild(clearBtn);
        }
    };

    // Load sources async, populate when ready
    Promise.resolve(overlaySourceProvider()).then(sources => {
        populateFields(sources ?? []);
    }).catch(() => {
        fields.innerHTML = '<div class="plot-overlay-error">Could not load ETL sources</div>';
    });

    section.appendChild(fields);
    return section;
}


/**
 * Lighten a hex color for overlay defaults.
 * @param {string} hex
 * @returns {string}
 */
function lightenColor(hex) {
    const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return hex;
    const lighten = (v) => Math.min(255, Math.round(v + (255 - v) * 0.4));
    const r = lighten(parseInt(m[1], 16));
    const g = lighten(parseInt(m[2], 16));
    const b = lighten(parseInt(m[3], 16));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}


// ─── Variable input helper ──────────────────────────────────────────────────

let _acUid = 0;

// ─── Number-or-named-constant combobox ──────────────────────────────────
//
// Typeahead input + drop-down panel of named numeric constants.
// Stores the typed value as:
//   - the literal name string if it matches a known constant
//     (resolved to its live value by the dashboard at render time);
//   - a number if the user typed digits;
//   - the raw string otherwise (covers half-typed names).
//
// Panel is position-aware (drop-up when close to the viewport bottom)
// and groups options by `source` so a long flat list reads as
// "central_bank / banker / government / worker / capitalist …".
function _buildNumberOrNameCombobox(col, item, notify) {
    const root = document.createElement('div');
    root.className = 'config-num-or-name';
    const constants = (typeof col.constantsProvider === 'function'
        ? col.constantsProvider() : null) || [];
    const byName = new Map(constants.map((c) => [String(c.name), Number(c.value)]));

    const inputWrap = document.createElement('div');
    inputWrap.className = 'config-num-or-name__inputwrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'config-input';
    input.placeholder = '0 or constant name';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = (item[col.field] == null) ? '' : String(item[col.field]);

    const caret = document.createElement('span');
    caret.className = 'config-num-or-name__caret material-symbols-outlined';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = 'expand_more';

    const panel = document.createElement('div');
    panel.className = 'config-num-or-name__panel';
    panel.hidden = true;
    panel.setAttribute('role', 'listbox');

    inputWrap.appendChild(input);
    inputWrap.appendChild(caret);
    inputWrap.appendChild(panel);
    root.appendChild(inputWrap);

    const hint = document.createElement('span');
    hint.className = 'config-num-or-name__hint';
    root.appendChild(hint);

    let activeIndex = -1;
    let renderedItems = [];

    const refreshHint = () => {
        const v = input.value;
        if (v && byName.has(v)) {
            hint.textContent = `= ${byName.get(v)}`;
            hint.classList.add('config-num-or-name__hint--match');
        } else {
            hint.textContent = '';
            hint.classList.remove('config-num-or-name__hint--match');
        }
    };
    refreshHint();

    const buildPanel = (filter) => {
        const q = String(filter || '').trim().toLowerCase();
        const grouped = new Map();    // source → [constant]
        for (const c of constants) {
            if (q && !c.name.toLowerCase().includes(q)) continue;
            const key = c.source || c.name.split('.')[0] || 'other';
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(c);
        }
        const ordered = [];
        const sources = [...grouped.keys()].sort();
        const html = sources.map((src) => {
            const items = grouped.get(src);
            const header = `<div class="config-num-or-name__group">${esc(src)}</div>`;
            const opts = items.map((c) => {
                const i = ordered.length;
                ordered.push(c);
                return `<button type="button"
                                class="config-num-or-name__opt"
                                role="option"
                                data-idx="${i}"
                                data-name="${esc(c.name)}">
                            <span class="config-num-or-name__opt-name">${esc(c.label || c.name)}</span>
                            <span class="config-num-or-name__opt-value">= ${esc(String(c.value))}</span>
                        </button>`;
            }).join('');
            return header + opts;
        }).join('');
        renderedItems = ordered;
        panel.innerHTML = ordered.length === 0
            ? '<div class="config-num-or-name__empty">No matching constants.</div>'
            : html;
        // Pre-select an option matching the input's current value if any,
        // else the first option, so Enter without arrowing is sensible.
        const cur = input.value;
        const curIdx = renderedItems.findIndex((c) => c.name === cur);
        activeIndex = curIdx >= 0 ? curIdx
                    : (renderedItems.length ? 0 : -1);
        paintActive();
    };

    const paintActive = () => {
        panel.querySelectorAll('.config-num-or-name__opt').forEach((btn) => {
            const on = Number(btn.dataset.idx) === activeIndex;
            btn.classList.toggle('config-num-or-name__opt--active', on);
            if (on) btn.scrollIntoView({ block: 'nearest' });
        });
    };

    const positionPanel = () => {
        // Drop-up when there isn't room below. We don't need to be as fancy
        // about max-height here — the panel caps via CSS — but we do
        // need to anchor relative to the input so the panel stays
        // pinned during scroll.
        const r = input.getBoundingClientRect();
        const vh = window.innerHeight;
        const spaceBelow = vh - r.bottom - 6;
        const spaceAbove = r.top - 6;
        const natural = Math.min(panel.scrollHeight, 280);
        const dropUp = natural > spaceBelow && spaceAbove > spaceBelow;
        root.classList.toggle('config-num-or-name--drop-up', dropUp);
        panel.style.maxHeight = `${Math.max(120, Math.min(280, dropUp ? spaceAbove : spaceBelow))}px`;
    };

    const open = () => {
        buildPanel(input.value);
        panel.hidden = false;
        root.classList.add('config-num-or-name--open');
        positionPanel();
    };
    const close = () => {
        panel.hidden = true;
        root.classList.remove('config-num-or-name--open');
    };

    const commitRaw = () => {
        const raw = input.value.trim();
        if (raw === '') {
            item[col.field] = undefined;
        } else if (byName.has(raw)) {
            item[col.field] = raw;
        } else {
            const n = parseFloat(raw);
            item[col.field] = Number.isFinite(n) ? n : raw;
        }
        refreshHint();
        notify();
    };

    const commitName = (name) => {
        input.value = name;
        item[col.field] = name;
        refreshHint();
        close();
        notify();
    };

    input.addEventListener('focus', open);
    caret.addEventListener('mousedown', (e) => {
        e.preventDefault();   // keep focus on the input
        if (panel.hidden) { input.focus(); open(); } else { close(); }
    });
    input.addEventListener('input', () => {
        if (panel.hidden) open();
        else buildPanel(input.value);
        refreshHint();
    });
    input.addEventListener('keydown', (e) => {
        if (panel.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) {
            open();
            e.preventDefault();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (renderedItems.length) {
                activeIndex = (activeIndex + 1) % renderedItems.length;
                paintActive();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (renderedItems.length) {
                activeIndex = (activeIndex - 1 + renderedItems.length)
                              % renderedItems.length;
                paintActive();
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const o = renderedItems[activeIndex];
            if (o) commitName(o.name);
            else commitRaw();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    panel.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.config-num-or-name__opt');
        if (!btn) return;
        e.preventDefault();
        const o = renderedItems[Number(btn.dataset.idx)];
        if (o) commitName(o.name);
    });
    input.addEventListener('blur', () => {
        // Defer so a panel mousedown can commit before we close.
        setTimeout(() => {
            if (document.activeElement === input) return;
            if (!panel.hidden) close();
            // Persist whatever the user left in the input.
            commitRaw();
        }, 0);
    });

    return root;
}


/**
 * Append an AutocompleteField for variable selection with namespace support.
 *
 * @param {HTMLElement} parent
 * @param {Object} obj — data object whose [key] holds the variable name
 * @param {string} key — property name on obj (e.g. 'variable')
 * @param {string} placeholder
 * @param {Function} notify — change callback
 * @param {Function|null} symbolProvider — () => Array<{name, kind, namespace?}>
 * @param {AutocompleteField[]} liveAutocompletes — tracker for disposal
 * @param {Function} [onVariableSelected] — called with bare variable name on autocomplete selection
 */
function appendVariableInput(parent, obj, key, placeholder, notify, symbolProvider, liveAutocompletes, onVariableSelected, flags = {}) {
    if (!symbolProvider) {
        // Fallback: plain text input when no symbol provider is available
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'config-input';
        input.value = obj[key] || '';
        input.placeholder = placeholder;
        input.style.flex = '1';
        input.style.minWidth = '0';
        input.addEventListener('input', () => { obj[key] = input.value; notify(); });
        parent.appendChild(input);
        return;
    }

    const symbols = symbolProvider();
    const namespaceOptions = buildNamespaceOptions(symbols);
    let initialNs = resolveNamespaceForVariable(symbols, obj[key]);

    // Optional cosmetic: when the source ID encodes a type via a
    // leading "type:" prefix (EcoAgent uses `group:cap`, `market:goods`
    // etc.), strip the prefix from the *visible label* only — the
    // underlying value stays intact so saved plots still resolve.
    const labelFor = (value) =>
        flags.stripNamespacePrefix ? String(value || '').replace(/^[a-z_]+:/i, '') : value;

    // If resolveNamespaceForVariable couldn't find the namespace (e.g. symbols not yet
    // indexed) but the value has a "Namespace.variable" prefix, parse it directly and
    // ensure the namespace option exists.
    const rawVal = obj[key] || '';
    const dotIdx = rawVal.indexOf('.');
    if (initialNs === '__ALL__' && dotIdx > 0) {
        const nsFromValue = rawVal.slice(0, dotIdx);
        if (nsFromValue && !namespaceOptions.some(o => o.value === nsFromValue)) {
            namespaceOptions.push({ value: nsFromValue, label: labelFor(nsFromValue), token: labelFor(nsFromValue) });
        }
        initialNs = nsFromValue;
    }
    // Re-label any namespace options that already exist with the
    // stripped form (e.g. real namespace symbols emitted by the
    // provider). Value stays as the canonical id.
    if (flags.stripNamespacePrefix) {
        for (const o of namespaceOptions) {
            if (o.value && o.value !== '__ALL__') {
                o.label = labelFor(o.value);
                o.token = labelFor(o.value);
            }
        }
    }

    const ac = new AutocompleteField({
        fieldId: `plot-var-ac-${++_acUid}`,
        field: { placeholder, value: obj[key] || '' },
        namespace: initialNs,
        namespaceOptions,
        showNamespaceSelect: true,
        skipNamespacePrefix: true,
        variant: 'notebook',
        provider: ({ value, namespace: ns }) => {
            // Re-fetch symbols each time (they may change as user edits the model)
            const fresh = symbolProvider();
            return variableProvider(fresh, value, ns);
        },
        onChange: (value, { namespace: ns } = {}) => {
            // Store namespace-qualified value so the reference survives across
            // files/namespaces (the namespace select tracks the active namespace)
            const qualifiedValue = ns && ns !== '__ALL__' && value && !value.includes('.')
                ? `${ns}.${value}`
                : value;
            obj[key] = qualifiedValue;
            notify();
            if (value) onVariableSelected?.(value);
        },
    });

    const el = ac.render();
    el.classList.add('series-autocomplete');
    parent.appendChild(el);
    liveAutocompletes.push(ac);
}


// ─── Display Options ────────────────────────────────────────────────────────

function renderDisplayOptions(sp, hasZAxis, notify, scenarioProvider, tickContext, flags = {}) {
    const { hide3d = false, constantsProvider = null } = flags;
    const el = document.createElement('div');
    el.className = 'config-custom-section';

    // Chart type
    {
        const row = document.createElement('div');
        row.className = 'config-row';
        const label = document.createElement('label');
        label.className = 'config-label';
        label.textContent = 'Chart Type';
        row.appendChild(label);

        const select = document.createElement('select');
        select.className = 'config-input';

        // 3D chart types are skipped entirely when hide3d is set; the
        // dashboard mode has no Z-axis editor to make them usable.
        const allTypes = hide3d
            ? [...CHART_TYPES_2D]
            : [...CHART_TYPES_2D, ...CHART_TYPES_3D];
        for (const ct of allTypes) {
            const is3D = CHART_TYPES_3D.some(t => t.value === ct.value);
            const opt = document.createElement('option');
            opt.value = ct.value;
            opt.textContent = is3D && !hasZAxis ? `${ct.label} (requires Z axis)` : ct.label;
            opt.selected = sp.chartType === ct.value;
            opt.disabled = is3D && !hasZAxis;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            sp.chartType = select.value;
            notify();
        });
        row.appendChild(select);
        el.appendChild(row);
    }

    // Interpolation
    el.appendChild(renderConfigSelect('Interpolation', 'interpolation', sp, notify,
        [['auto', 'Auto'], ['linear', 'Linear'], ['step', 'Step'], ['cubic', 'Cubic Spline']]));

    // NaN handling
    el.appendChild(renderConfigSelect('NaN Handling', 'nanHandling', sp, notify,
        [['gap', 'Gap (not displayed)'], ['zero', 'Zero'], ['hold', 'Hold (last valid)'], ['interpolate', 'Interpolate (linear)']]));

    // Legend position
    el.appendChild(renderConfigSelect('Legend Position', 'legendPosition', sp, notify,
        [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['hidden', 'Hidden']]));

    // Show Data Points toggle
    el.appendChild(renderConfigToggle('Show Data Points', 'showDataPoints', sp, notify));

    // HP filter rows (trend + cycle + lambda). Macro-econometrics
    // tool calibrated against calendar frequencies; rarely meaningful
    // for ABM tick-based series, so the dashboard hides them.
    if (!flags.hideHpFilter) {
        el.appendChild(renderConfigToggle('Show HP Trend', 'showHpTrend', sp, notify, 'Overlay Hodrick-Prescott filter trend line', () => {
            updateHpLambdaState(el, sp);
        }));
        el.appendChild(renderConfigToggle('Show HP Cycle', 'showHpCycle', sp, notify, 'Overlay Hodrick-Prescott filter cyclical component', () => {
            updateHpLambdaState(el, sp);
        }));
        const hpEnabled = sp.showHpTrend || sp.showHpCycle;
        const row = document.createElement('div');
        row.className = 'config-row';
        row.innerHTML = `
            <label class="config-label">HP Lambda</label>
            <input type="number" class="config-input hp-lambda-input"
                   value="${sp.hpLambda ?? 1600}" min="1" step="100"
                   ${hpEnabled ? '' : 'disabled'}/>
        `;
        const hint = document.createElement('div');
        hint.className = 'config-hint';
        hint.textContent = tickContext
            ? 'Smoothing parameter — higher λ = smoother trend. Defaults to 1600; ticks are abstract so calibrate against your run length.'
            : 'Smoothing parameter (1600 for quarterly, 100 for annual, 6.25 for monthly)';
        row.appendChild(hint);
        row.querySelector('.hp-lambda-input').addEventListener('change', () => {
            sp.hpLambda = parseFloat(row.querySelector('.hp-lambda-input').value) || 1600;
            notify();
        });
        el.appendChild(row);
    }

    // Scenario comparison block. Replaces the older Delta+Baseline
    // pair with a single "Compare Mode" select that drives the
    // dashboard's data fetcher (see dashboard_tab._pushDataToTiles):
    //
    //   none     — plot the active world only (default).
    //   overlay  — plot each picked scenario as its own line; one
    //              line per (variable × scenario).
    //   delta    — plot each picked scenario as the delta against
    //              the chosen baseline; subtract / %Δ / ratio.
    //
    // The Scenarios chip-list shows the project's saved scenarios
    // (sourced via scenarioProvider). Picking none in overlay/delta
    // falls back to plotting the baseline scenario so the panel
    // never renders an empty chart silently.
    if (scenarioProvider) {
        renderCompareModeBlock(el, sp, notify, scenarioProvider);
    }

    // Reference lines (typed row editor)
    el.appendChild(renderReferenceLinesEditor(sp, notify, constantsProvider));

    // Shaded bands (typed row editor)
    el.appendChild(renderShadedBandsEditor(sp, notify, tickContext));

    return el;
}

// ─── Scenario comparison block ──────────────────────────────────────
//
// Compose three rows that share a single `sp.compare` object:
//
//   { mode:'none'|'overlay'|'delta',
//     scenarios:string[]            — scenarios to include (chip list)
//     baseline:string               — delta mode reference scenario
//     style:'subtract'|'relative'|'ratio'  — delta math }
//
// `scenarioProvider()` is expected to return [{name, path}] where
// `path` is the scenario id (or 'baseline' for the implicit no-
// overrides scenario). The block degrades gracefully when no
// scenarios are available — Compare Mode is still selectable but
// the scenarios chip-list is empty and warns the user.

function renderCompareModeBlock(el, sp, notify, scenarioProvider) {
    // Normalize compare object in-place so subsequent reads see a
    // consistent shape.
    if (!sp.compare || typeof sp.compare !== 'object') sp.compare = {};
    const cmp = sp.compare;
    if (cmp.mode !== 'overlay' && cmp.mode !== 'delta') cmp.mode = 'none';
    if (!Array.isArray(cmp.scenarios)) cmp.scenarios = [];
    if (typeof cmp.baseline !== 'string' || !cmp.baseline) cmp.baseline = 'baseline';
    if (cmp.style !== 'relative' && cmp.style !== 'ratio') cmp.style = 'subtract';

    const scenarios = scenarioProvider() || [];

    // ── Row: Compare Mode select ───────────────────────────────────
    const modeRow = document.createElement('div');
    modeRow.className = 'config-row';
    modeRow.innerHTML = `
        <label class="config-label">Compare Mode</label>
        <select class="config-input" data-field="mode">
            <option value="none"    ${cmp.mode === 'none'    ? 'selected' : ''}>None</option>
            <option value="overlay" ${cmp.mode === 'overlay' ? 'selected' : ''}>Overlay scenarios</option>
            <option value="delta"   ${cmp.mode === 'delta'   ? 'selected' : ''}>Delta vs baseline</option>
        </select>
    `;
    const modeHint = document.createElement('div');
    modeHint.className = 'config-hint';
    modeHint.textContent =
        cmp.mode === 'none'
            ? 'Plot the active world only.'
            : cmp.mode === 'overlay'
                ? 'Plot every picked scenario as its own line.'
                : 'Plot every picked scenario as a delta against the chosen baseline.';
    modeRow.appendChild(modeHint);
    el.appendChild(modeRow);

    // Hide the scenario/baseline/style rows when mode === 'none'.
    const compareDetail = document.createElement('div');
    compareDetail.className = 'plot-compare-detail';
    if (cmp.mode === 'none') compareDetail.style.display = 'none';
    el.appendChild(compareDetail);

    // ── Row: Scenarios chip-list (multi-select) ────────────────────
    {
        const row = document.createElement('div');
        row.className = 'config-row';
        row.innerHTML = `<label class="config-label">Scenarios</label>`;

        const chips = document.createElement('div');
        chips.className = 'plot-compare-chips';
        if (scenarios.length === 0) {
            chips.innerHTML = '<span class="config-hint">No saved scenarios yet — run a batch first.</span>';
        }
        for (const sc of scenarios) {
            const val = sc.path ?? sc.id ?? sc.name;
            const on = cmp.scenarios.includes(val);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `plot-compare-chip${on ? ' plot-compare-chip--on' : ''}`;
            chip.dataset.scenarioId = String(val);
            chip.textContent = sc.name;
            chip.addEventListener('click', () => {
                const i = cmp.scenarios.indexOf(val);
                if (i >= 0) cmp.scenarios.splice(i, 1);
                else cmp.scenarios.push(val);
                chip.classList.toggle('plot-compare-chip--on');
                notify();
            });
            chips.appendChild(chip);
        }
        row.appendChild(chips);
        compareDetail.appendChild(row);
    }

    // ── Row: Baseline scenario (delta only) ────────────────────────
    const baselineRow = document.createElement('div');
    baselineRow.className = 'config-row';
    baselineRow.innerHTML = `<label class="config-label">Baseline</label>`;
    {
        const select = document.createElement('select');
        select.className = 'config-input';
        select.innerHTML = scenarios
            .map((sc) => {
                const val = sc.path ?? sc.id ?? sc.name;
                return `<option value="${val}" ${val === cmp.baseline ? 'selected' : ''}>${sc.name}</option>`;
            }).join('') || '<option value="baseline" selected>Baseline</option>';
        select.addEventListener('change', () => { cmp.baseline = select.value; notify(); });
        baselineRow.appendChild(select);
    }
    compareDetail.appendChild(baselineRow);

    // ── Row: Style (delta only) ────────────────────────────────────
    const styleRow = document.createElement('div');
    styleRow.className = 'config-row';
    styleRow.innerHTML = `
        <label class="config-label">Delta style</label>
        <select class="config-input" data-field="style">
            <option value="subtract" ${cmp.style === 'subtract' ? 'selected' : ''}>Subtract (x − baseline)</option>
            <option value="relative" ${cmp.style === 'relative' ? 'selected' : ''}>Relative (%Δ baseline)</option>
            <option value="ratio"    ${cmp.style === 'ratio'    ? 'selected' : ''}>Ratio (x / baseline)</option>
        </select>
    `;
    styleRow.querySelector('select').addEventListener('change', (e) => {
        cmp.style = e.target.value;
        notify();
    });
    compareDetail.appendChild(styleRow);

    // Show/hide delta-specific rows based on mode.
    const refreshVisibility = () => {
        const deltaOnly = cmp.mode === 'delta';
        baselineRow.style.display = deltaOnly ? '' : 'none';
        styleRow.style.display    = deltaOnly ? '' : 'none';
    };
    refreshVisibility();

    modeRow.querySelector('select').addEventListener('change', (e) => {
        cmp.mode = e.target.value;
        compareDetail.style.display = cmp.mode === 'none' ? 'none' : '';
        modeHint.textContent =
            cmp.mode === 'none'
                ? 'Plot the active world only.'
                : cmp.mode === 'overlay'
                    ? 'Plot every picked scenario as its own line.'
                    : 'Plot every picked scenario as a delta against the chosen baseline.';
        refreshVisibility();
        notify();
    });
}


/**
 * Structured editor for shaded bands. Each row edits one band with
 * typed inputs for x0/x1/label/color/opacity plus a remove button.
 */
function renderShadedBandsEditor(sp, notify, tickContext) {
    // EcoAgent's world clock is integer ticks starting at 0, so band
    // defaults open at a small interval. EcoSim's calendar-year world
    // keeps the year-2000s default for muscle memory.
    const tickDefault = tickContext
        ? { x0: 0,    x1: 10,   label: '', color: '#ffcc3a', opacity: 0.12 }
        : { x0: 2000, x1: 2005, label: '', color: '#ffcc3a', opacity: 0.12 };
    return renderArrayRowEditor({
        label: 'Shaded Bands',
        key: 'shadedBands',
        sp,
        notify,
        hint: tickContext
            ? 'Vertical stripes over a tick interval. Useful for marking policy events or regime windows.'
            : 'Vertical policy/recession stripes. Add one row per interval.',
        defaultItem: () => ({ ...tickDefault }),
        columns: [
            { field: 'x0',      label: 'From',    type: 'number', step: 'any', width: '70px' },
            { field: 'x1',      label: 'To',      type: 'number', step: 'any', width: '70px' },
            { field: 'label',   label: 'Label',   type: 'text',                width: '1fr'   },
            { field: 'color',   label: 'Color',   type: 'color',               width: '50px'  },
            { field: 'opacity', label: 'Opacity', type: 'number', step: '0.01', min: 0, max: 1, width: '70px' },
        ],
    });
}

/**
 * Structured editor for reference lines. Each row edits one line with
 * typed inputs including an axis selector and a line-style dropdown.
 */
function renderReferenceLinesEditor(sp, notify, constantsProvider = null) {
    const axisOptions = Array.isArray(sp?.yAxes) && sp.yAxes.length > 0
        ? sp.yAxes.map(a => ({ value: a.id, label: a.label ? `${a.id} (${a.label})` : a.id }))
        : [{ value: 'y1', label: 'y1' }];
    return renderArrayRowEditor({
        label: 'Reference Lines',
        key: 'referenceLines',
        sp,
        notify,
        hint: constantsProvider
            ? 'Horizontal threshold lines. Type a number or a named '
              + 'constant (e.g. central_bank.policy_rate) — named '
              + 'constants stay in sync with the project as you retune.'
            : 'Horizontal threshold lines. Add one row per line.',
        defaultItem: () => ({ yAxisId: axisOptions[0].value, value: 0, label: '', color: '#ffcc3a', lineStyle: 'dashed' }),
        columns: [
            { field: 'yAxisId',   label: 'Axis',  type: 'select', options: axisOptions,                                        width: '100px' },
            { field: 'value',     label: 'Value', type: 'number-or-name', constantsProvider,                                   width: '160px' },
            { field: 'label',     label: 'Label', type: 'text',                                                                width: '1fr'   },
            { field: 'color',     label: 'Color', type: 'color',                                                               width: '50px'  },
            { field: 'lineStyle', label: 'Style', type: 'select', options: [
                { value: 'solid',  label: 'solid'  },
                { value: 'dashed', label: 'dashed' },
                { value: 'dotted', label: 'dotted' },
            ], width: '80px' },
        ],
    });
}

/**
 * Generic array-of-objects editor: renders one row per item with typed
 * inputs per column + [remove] button, plus an "Add row" button.
 */
function renderArrayRowEditor({ label, key, sp, notify, hint, columns, defaultItem }) {
    const row = document.createElement('div');
    row.className = 'config-row config-row--array';

    const labelEl = document.createElement('label');
    labelEl.className = 'config-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const wrap = document.createElement('div');
    wrap.className = 'config-array-wrap';
    row.appendChild(wrap);

    if (!Array.isArray(sp[key])) sp[key] = [];
    const items = sp[key];

    // Column grid-template-columns expression (tail = remove-button column)
    const gridCols = columns.map(c => c.width).join(' ') + ' 28px';

    function buildInput(col, item) {
        let input;
        if (col.type === 'number-or-name') {
            // Real combobox: typeahead input + drop-down panel grouped
            // by the constant's `source` (the archetype it belongs to).
            // Native <datalist> needs the user to start typing before
            // anything shows up — for a 100+ constants pool that's a
            // discoverability dead-end. This widget opens the full list
            // on focus, filters by substring as the user types, and
            // commits either a typed number or a clicked constant name.
            return _buildNumberOrNameCombobox(col, item, notify);
        }
        if (col.type === 'select') {
            input = document.createElement('select');
            input.className = 'config-input';
            for (const opt of col.options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                if (item[col.field] === opt.value) o.selected = true;
                input.appendChild(o);
            }
            input.addEventListener('change', () => {
                item[col.field] = input.value;
                notify();
            });
        } else if (col.type === 'color') {
            input = document.createElement('input');
            input.type = 'color';
            input.className = 'config-input config-color-input';
            // Normalize rgba() -> hex if possible, otherwise fall back to default
            const hex = toHexColor(item[col.field]) || '#ffcc3a';
            input.value = hex;
            if (item[col.field] === undefined) item[col.field] = hex;
            input.addEventListener('change', () => {
                item[col.field] = input.value;
                notify();
            });
        } else {
            input = document.createElement('input');
            input.type = col.type || 'text';
            input.className = 'config-input';
            if (col.step !== undefined) input.step = col.step;
            if (col.min !== undefined) input.min = col.min;
            if (col.max !== undefined) input.max = col.max;
            input.value = item[col.field] ?? '';
            input.addEventListener('change', () => {
                if (col.type === 'number') {
                    const n = parseFloat(input.value);
                    item[col.field] = isNaN(n) ? undefined : n;
                } else {
                    item[col.field] = input.value;
                }
                notify();
            });
        }
        return input;
    }

    function renderRows() {
        wrap.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.className = 'config-array-row config-array-row--header';
        header.style.gridTemplateColumns = gridCols;
        for (const col of columns) {
            const h = document.createElement('span');
            h.className = 'config-array-header-cell';
            h.textContent = col.label;
            header.appendChild(h);
        }
        header.appendChild(document.createElement('span')); // removes column
        wrap.appendChild(header);

        // Rows
        items.forEach((item, i) => {
            const r = document.createElement('div');
            r.className = 'config-array-row';
            r.style.gridTemplateColumns = gridCols;
            for (const col of columns) {
                r.appendChild(buildInput(col, item));
            }
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'config-array-remove';
            rm.title = 'Remove row';
            rm.innerHTML = '<span class="material-symbols-outlined">close</span>';
            rm.addEventListener('click', () => {
                items.splice(i, 1);
                renderRows();
                notify();
            });
            r.appendChild(rm);
            wrap.appendChild(r);
        });

        // Add button
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'config-array-add';
        addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add row';
        addBtn.addEventListener('click', () => {
            items.push(defaultItem());
            renderRows();
            notify();
        });
        wrap.appendChild(addBtn);

        if (hint) {
            const h = document.createElement('div');
            h.className = 'config-hint';
            h.textContent = hint;
            wrap.appendChild(h);
        }
    }

    renderRows();
    return row;
}

/** Convert rgba()/hsl()/named to hex for native <input type="color">. */
function toHexColor(c) {
    if (!c) return null;
    if (typeof c === 'string' && c.startsWith('#') && (c.length === 7 || c.length === 4)) {
        return c.length === 7 ? c : '#' + c.slice(1).split('').map(ch => ch + ch).join('');
    }
    // Try via a temporary DOM element (browser computes a normalized form)
    try {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.appendChild(el);
        const rgb = getComputedStyle(el).color;
        document.body.removeChild(el);
        const m = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
            const [r, g, b] = [+m[1], +m[2], +m[3]];
            return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        }
    } catch (_) { /* ignore */ }
    return null;
}

function renderJsonArrayEditor(label, key, sp, notify, placeholder, hint) {
    const row = document.createElement('div');
    row.className = 'config-row';
    const current = Array.isArray(sp[key]) ? JSON.stringify(sp[key], null, 0) : '';
    row.innerHTML = `
        <label class="config-label">${label}</label>
        <textarea class="config-input" rows="3" placeholder='${placeholder}' style="font-family:monospace;font-size:11px;">${current}</textarea>
        <div class="config-hint">${hint}</div>
    `;
    const ta = row.querySelector('textarea');
    ta.addEventListener('change', () => {
        const raw = ta.value.trim();
        if (!raw) { sp[key] = []; notify(); return; }
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) { sp[key] = parsed; notify(); }
            else { ta.style.borderColor = '#e55353'; }
        } catch (_) {
            ta.style.borderColor = '#e55353';
        }
    });
    return row;
}

function updateHpLambdaState(container, sp) {
    const lambdaInput = container.querySelector('.hp-lambda-input');
    if (lambdaInput) lambdaInput.disabled = !(sp.showHpTrend || sp.showHpCycle);
}


// ─── Config row helpers (match main_new.css patterns) ───────────────────────

function renderConfigSelect(label, key, sp, notify, options) {
    const row = document.createElement('div');
    row.className = 'config-row';
    row.innerHTML = `
        <label class="config-label">${label}</label>
        <select class="config-input">
            ${options.map(([v, l]) =>
                `<option value="${v}" ${sp[key] === v ? 'selected' : ''}>${l}</option>`
            ).join('')}
        </select>
    `;
    row.querySelector('select').addEventListener('change', (e) => {
        sp[key] = e.target.value;
        notify();
    });
    return row;
}

function renderConfigToggle(label, key, sp, notify, hint = null, afterChange = null) {
    const row = document.createElement('div');
    row.className = 'config-row';

    const lbl = document.createElement('label');
    lbl.className = 'config-label';
    lbl.textContent = label;
    row.appendChild(lbl);

    const toggleField = document.createElement('div');
    toggleField.className = 'toggle-field config-input';
    const toggle = document.createElement('div');
    toggle.className = `toggle-switch${sp[key] ? ' toggle-switch--checked' : ''}`;
    toggle.addEventListener('click', () => {
        sp[key] = !sp[key];
        toggle.classList.toggle('toggle-switch--checked', sp[key]);
        notify();
        afterChange?.();
    });
    toggleField.appendChild(toggle);
    row.appendChild(toggleField);

    if (hint) {
        const hintEl = document.createElement('div');
        hintEl.className = 'config-hint';
        hintEl.textContent = hint;
        row.appendChild(hintEl);
    }

    return row;
}


// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureSubplots(data, count) {
    if (!data.subplots) data.subplots = [];
    while (data.subplots.length < count) {
        data.subplots.push(makeDefaultSubplot(data.subplots.length));
    }
}
