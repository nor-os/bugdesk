/**
 * scenario_param_renderer.js
 *
 * Reusable parameter override and distribution rendering for scenario editors.
 * Pure view functions — no DataManager or SimulationController dependency.
 * Receives data and callbacks.
 *
 * Extracted from ScenarioManagerPage for reuse in ScenarioFileEditor.
 */

import { renderMarkdown } from '../ai/ai_markdown.js';

const SOLVER_METHODS = Object.freeze([
    { value: 'RK45', label: 'RK45 (Runge-Kutta 4/5)' },
    { value: 'RK23', label: 'RK23 (Runge-Kutta 2/3)' },
    { value: 'DOP853', label: 'DOP853 (Dormand-Prince 8)' },
    { value: 'RADAU', label: 'Radau IIA (implicit)' },
    { value: 'BDF', label: 'BDF (stiff)' },
    { value: 'LSODA', label: 'LSODA (auto-switch)' },
]);

// ═══════════════════════════════════════════════════════════════════
// Settings Tab
// ═══════════════════════════════════════════════════════════════════

/**
 * Render the Settings tab content: name, description, solver, time, MC config.
 * @param {HTMLElement} container
 * @param {object} data — scenario data { name, description, solver, time, monteCarlo }
 * @param {{ onChanged: () => void }} callbacks
 */
export function renderSettingsTab(container, data, { onChanged }) {
    const solver = data.solver ?? {};
    const time = data.time ?? {};
    const mc = data.monteCarlo ?? {};
    const isMC = mc.runs > 0;

    container.innerHTML = `
        <div class="scenario-settings-tab">
            <section class="scenario-detail__section">
                <h3 class="scenario-detail__section-title">
                    <span class="material-symbols-outlined">info</span> Scenario Info
                </h3>
                <div class="config-section">
                    <div class="config-row">
                        <label class="config-field config-field--wide">
                            <span>Description</span>
                            <input type="text" class="assumption-number-input" data-config="description"
                                   value="${esc(data.description)}" placeholder="Brief description"/>
                        </label>
                    </div>
                </div>
            </section>

            <section class="scenario-detail__section">
                <h3 class="scenario-detail__section-title">
                    <span class="material-symbols-outlined">settings</span> Simulation Settings
                </h3>
                <div class="config-section">
                    <div class="config-section-heading">Time</div>
                    <div class="config-row">
                        <label class="config-field">
                            <span>Start (t\u2080)</span>
                            <input type="number" class="assumption-number-input" data-config="time.t0"
                                   value="${time.t0 ?? ''}" step="0.1" placeholder=""/>
                        </label>
                        <label class="config-field">
                            <span>End (t\u2081)</span>
                            <input type="number" class="assumption-number-input" data-config="time.t1"
                                   value="${time.t1 ?? ''}" step="0.1" placeholder=""/>
                        </label>
                        <label class="config-field">
                            <span>Step (\u0394t)</span>
                            <input type="number" class="assumption-number-input" data-config="time.dt"
                                   value="${time.dt ?? ''}" step="0.01" min="0.001" placeholder=""/>
                        </label>
                    </div>
                    <div class="config-section-heading">Solver</div>
                    <div class="config-row">
                        <label class="config-field">
                            <span>Method</span>
                            <select class="assumption-dist-select" data-config="solver.method">
                                ${SOLVER_METHODS.map(m => `<option value="${m.value}" ${(solver.method || 'RK45') === m.value ? 'selected' : ''}>${m.label}</option>`).join('')}
                            </select>
                        </label>
                        <label class="config-field">
                            <span>Rel. Tolerance</span>
                            <input type="number" class="assumption-number-input" data-config="solver.rtol"
                                   value="${solver.rtol ?? ''}" step="any" placeholder=""/>
                        </label>
                        <label class="config-field">
                            <span>Abs. Tolerance</span>
                            <input type="number" class="assumption-number-input" data-config="solver.atol"
                                   value="${solver.atol ?? ''}" step="any" placeholder=""/>
                        </label>
                    </div>
                    <div class="config-section-heading">Monte Carlo</div>
                    <div class="config-row">
                        <label class="config-field">
                            <span>Runs</span>
                            <input type="number" class="assumption-number-input" data-config="monteCarlo.runs"
                                   value="${mc.runs ?? ''}" min="0" placeholder="off"/>
                        </label>
                        <label class="config-field">
                            <span>Seed</span>
                            <input type="number" class="assumption-number-input" data-config="monteCarlo.seed"
                                   value="${mc.seed ?? ''}" placeholder="random"/>
                        </label>
                    </div>
                </div>
            </section>
        </div>
    `;

    // Wire all [data-config] fields
    wireConfigFields(container, data, onChanged);

    // ── Metadata section (authors, tags, notes) — imperative because tags need add/remove ──
    if (!data.metadata) data.metadata = { authors: [], tags: [], notes: '' };
    const metaSection = document.createElement('section');
    metaSection.className = 'scenario-detail__section';
    metaSection.innerHTML = `<h3 class="scenario-detail__section-title"><span class="material-symbols-outlined">badge</span> Metadata</h3>`;

    const metaGrid = document.createElement('div');
    metaGrid.className = 'simrun-settings__metadata-grid';
    metaGrid.appendChild(buildTagField('Authors', data.metadata.authors ?? [], (tags) => { data.metadata.authors = tags; onChanged(); }));
    metaGrid.appendChild(buildTagField('Tags', data.metadata.tags ?? [], (tags) => { data.metadata.tags = tags; onChanged(); }));
    metaSection.appendChild(metaGrid);

    const notesField = document.createElement('div');
    notesField.className = 'config-row';
    const notesLabel = document.createElement('label');
    notesLabel.className = 'config-field config-field--wide';
    notesLabel.innerHTML = '<span>Notes</span>';
    const notesInput = document.createElement('textarea');
    notesInput.className = 'assumption-number-input';
    notesInput.rows = 2;
    notesInput.placeholder = 'Additional notes\u2026';
    notesInput.value = data.metadata.notes || '';
    notesInput.style.resize = 'vertical';
    notesInput.addEventListener('change', () => { data.metadata.notes = notesInput.value; onChanged(); });
    notesLabel.appendChild(notesInput);
    notesField.appendChild(notesLabel);
    metaSection.appendChild(notesField);

    container.querySelector('.scenario-settings-tab').appendChild(metaSection);

    // ── Export section ──
    const exportSection = document.createElement('section');
    exportSection.className = 'scenario-detail__section';
    exportSection.innerHTML = `
        <h3 class="scenario-detail__section-title">
            <span class="material-symbols-outlined">print</span> Export
        </h3>
        <div class="config-section">
            <div class="config-row">
                <label class="config-field config-field--checkbox">
                    <input type="checkbox" class="scenario-checkbox" data-export="includeModelOverview"
                           ${data.includeModelOverview !== false ? 'checked' : ''} />
                    <span>Include Model Overview in export</span>
                </label>
            </div>
            <div class="config-field-help">
                Appends unreferenced namespace documentation as a "Model Overview" chapter when exporting to LaTeX/PDF.
            </div>
        </div>
    `;
    exportSection.querySelector('[data-export="includeModelOverview"]')
        .addEventListener('change', (e) => {
            data.includeModelOverview = e.target.checked;
            onChanged();
        });
    container.querySelector('.scenario-settings-tab').appendChild(exportSection);
}

/**
 * Build a tag input field with add/remove chips.
 * @param {string} label
 * @param {string[]} tags - mutable array
 * @param {(tags: string[]) => void} onChange
 * @returns {HTMLElement}
 */
function buildTagField(label, tags, onChange) {
    const field = document.createElement('div');
    field.className = 'simrun-settings__field simrun-settings__field--tags';

    const lbl = document.createElement('label');
    lbl.className = 'simrun-settings__label';
    lbl.textContent = label;
    field.appendChild(lbl);

    const wrapper = document.createElement('div');
    wrapper.className = 'simrun-settings__tag-wrapper';

    const tagList = document.createElement('div');
    tagList.className = 'simrun-settings__tag-list';

    const renderTags = () => {
        tagList.innerHTML = '';
        for (let i = 0; i < tags.length; i++) {
            const chip = document.createElement('span');
            chip.className = 'simrun-settings__tag-chip';
            chip.textContent = tags[i];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'simrun-settings__tag-remove';
            btn.innerHTML = '&times;';
            btn.addEventListener('click', () => { tags.splice(i, 1); renderTags(); onChange(tags); });
            chip.appendChild(btn);
            tagList.appendChild(chip);
        }
    };
    renderTags();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'simrun-settings__tag-input';
    input.placeholder = `Add ${label.toLowerCase()}\u2026`;
    const commitInput = () => {
        const val = input.value.trim();
        if (val && !tags.includes(val)) { tags.push(val); renderTags(); onChange(tags); }
        input.value = '';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitInput(); } });
    input.addEventListener('blur', commitInput);

    wrapper.appendChild(tagList);
    wrapper.appendChild(input);
    field.appendChild(wrapper);
    return field;
}

// ═══════════════════════════════════════════════════════════════════
// Parameters / Distributions Tab
// ═══════════════════════════════════════════════════════════════════

/**
 * Render the Parameters tab — namespace-tabbed overrides (static) or distributions (MC).
 * @param {HTMLElement} container
 * @param {object} data — scenario data
 * @param {object} configurables — { [namespaceName]: { parameters: [], constants: [], stocks: [] } }
 * @param {{ onChanged: () => void }} callbacks
 */
export function renderParametersTab(container, data, configurables, { onChanged }) {
    container.innerHTML = '';
    const isMC = (data.monteCarlo?.runs ?? 0) > 0;
    const namespaces = Object.keys(configurables);

    if (namespaces.length === 0) {
        container.innerHTML = '<p class="scenario-detail__empty-hint">No configurable parameters found. Add parameter or constant cells to your model.</p>';
        return;
    }

    const section = document.createElement('section');
    section.className = 'scenario-detail__section';

    const header = document.createElement('h3');
    header.className = 'scenario-detail__section-title';
    header.innerHTML = `<span class="material-symbols-outlined">tune</span> ${isMC ? 'Distributions' : 'Parameter Overrides'}`;
    section.appendChild(header);

    // Namespace tabs
    const tabsWrapper = document.createElement('div');
    tabsWrapper.className = 'params-namespace-tabs bottom-tabs';
    const tabsHeader = document.createElement('div');
    tabsHeader.className = 'bottom-tabs-header';
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    let activeNs = namespaces[0];

    for (const ns of namespaces) {
        const tab = document.createElement('div');
        tab.className = `tab${ns === activeNs ? ' active' : ''}`;
        tab.dataset.namespace = ns;
        tab.innerHTML = `<span class="tab-title">${escHtml(ns)}</span>`;
        tabs.appendChild(tab);
    }
    tabsHeader.appendChild(tabs);
    tabsWrapper.appendChild(tabsHeader);
    section.appendChild(tabsWrapper);

    const tabContent = document.createElement('div');
    tabContent.className = 'namespace-override-content';
    section.appendChild(tabContent);

    const renderNs = (nsName) => {
        tabContent.innerHTML = '';
        const nsConfig = configurables[nsName];
        if (!nsConfig) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'scenario-namespace-settings';

        if (isMC) {
            if (nsConfig.parameters.length > 0) renderDistributionSection(wrapper, nsName, 'Parameters', 'parameters', nsConfig.parameters, data, onChanged);
            if (nsConfig.constants.length > 0) renderDistributionSection(wrapper, nsName, 'Constants', 'constants', nsConfig.constants, data, onChanged);
            if (nsConfig.stocks.length > 0) renderDistributionSection(wrapper, nsName, 'Stock Initial Values', 'stocks', nsConfig.stocks, data, onChanged);
        } else {
            if (nsConfig.parameters.length > 0) renderOverrideSection(wrapper, nsName, 'Parameters', 'parameters', nsConfig.parameters, data, onChanged);
            if (nsConfig.constants.length > 0) renderOverrideSection(wrapper, nsName, 'Constants', 'constants', nsConfig.constants, data, onChanged);
            if (nsConfig.stocks.length > 0) renderOverrideSection(wrapper, nsName, 'Stock Initial Values', 'stocks', nsConfig.stocks, data, onChanged);
        }

        tabContent.appendChild(wrapper);
    };

    renderNs(activeNs);

    tabs.addEventListener('click', (e) => {
        const tabEl = e.target.closest('.tab');
        if (!tabEl) return;
        const ns = tabEl.dataset.namespace;
        if (!ns || ns === activeNs) return;
        tabs.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
        tabEl.classList.add('active');
        activeNs = ns;
        renderNs(ns);
    });

    container.appendChild(section);
}

// ── Static overrides ──

/**
 * Read an override entry, handling both legacy (plain number) and extended
 * ({ value?, min?, max?, distribution? }) formats.
 */
function readOverride(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') return { value: raw };
    if (typeof raw === 'object') return raw;
    const num = parseFloat(raw);
    return Number.isFinite(num) ? { value: num } : null;
}

function renderOverrideSection(container, nsName, title, bucketKey, items, data, onChanged) {
    if (!data.overrides) data.overrides = {};
    if (!data.overrides[nsName]) data.overrides[nsName] = {};
    if (!data.overrides[nsName][bucketKey]) data.overrides[nsName][bucketKey] = {};

    const overrides = data.overrides[nsName][bucketKey];

    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'override-section';

    const sectionHeader = document.createElement('h5');
    sectionHeader.className = 'override-section-title';
    sectionHeader.textContent = title;
    sectionDiv.appendChild(sectionHeader);

    const list = document.createElement('div');
    list.className = 'namespace-params-list';

    for (const item of items) {
        const parsed = readOverride(overrides[item.name]);
        const hasOverride = parsed !== null;
        const defaultValue = item.defaultValue ?? 0;
        const displayValue = hasOverride && parsed.value !== undefined ? parsed.value : defaultValue;

        const row = document.createElement('div');
        row.className = 'param-override-row';
        if (hasOverride) row.classList.add('has-override');

        const label = document.createElement('div');
        label.className = 'param-label';
        label.innerHTML = `
            <span class="param-name">${escHtml(item.displayName || item.name)}</span>
            <span class="param-default">Default: ${defaultValue}</span>
        `;

        // ── Value input ──
        const input = document.createElement('input');
        input.type = 'number';
        input.step = item.step ?? 'any';
        input.placeholder = 'Enter value...';
        input.value = displayValue;

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'param-clear-btn plain-icon-btn';
        clearBtn.title = 'Reset to default';
        clearBtn.innerHTML = '<span class="material-symbols-outlined">restart_alt</span>';
        clearBtn.style.visibility = hasOverride ? 'visible' : 'hidden';

        // ── MC expand toggle ──
        const mcToggle = document.createElement('button');
        mcToggle.type = 'button';
        mcToggle.className = 'param-mc-toggle plain-icon-btn';
        mcToggle.title = 'Override min/max/distribution';
        mcToggle.innerHTML = '<span class="material-symbols-outlined">casino</span>';

        // ── MC details panel (min, max, distribution) ──
        const mcPanel = document.createElement('div');
        mcPanel.className = 'param-mc-panel';
        const hasMcOverride = hasOverride && (parsed.min !== undefined || parsed.max !== undefined || parsed.distribution);
        mcPanel.style.display = hasMcOverride ? 'flex' : 'none';
        if (hasMcOverride) mcToggle.classList.add('active');

        const buildMcPanel = () => {
            mcPanel.innerHTML = '';
            const cur = readOverride(overrides[item.name]) ?? {};

            // Min / Max
            const minField = document.createElement('label');
            minField.className = 'param-mc-field';
            minField.innerHTML = `<span>Min</span>`;
            const minInput = document.createElement('input');
            minInput.type = 'number';
            minInput.step = 'any';
            minInput.placeholder = item.min ?? '';
            minInput.value = cur.min ?? '';
            minInput.addEventListener('change', () => {
                const entry = ensureOverrideObject(data, nsName, bucketKey, item.name, defaultValue);
                const v = parseFloat(minInput.value);
                if (Number.isFinite(v)) entry.min = v; else delete entry.min;
                onChanged();
            });
            minField.appendChild(minInput);

            const maxField = document.createElement('label');
            maxField.className = 'param-mc-field';
            maxField.innerHTML = `<span>Max</span>`;
            const maxInput = document.createElement('input');
            maxInput.type = 'number';
            maxInput.step = 'any';
            maxInput.placeholder = item.max ?? '';
            maxInput.value = cur.max ?? '';
            maxInput.addEventListener('change', () => {
                const entry = ensureOverrideObject(data, nsName, bucketKey, item.name, defaultValue);
                const v = parseFloat(maxInput.value);
                if (Number.isFinite(v)) entry.max = v; else delete entry.max;
                onChanged();
            });
            maxField.appendChild(maxInput);

            // Distribution type
            const distField = document.createElement('label');
            distField.className = 'param-mc-field';
            distField.innerHTML = `<span>Distribution</span>`;
            const distSelect = document.createElement('select');
            distSelect.className = 'param-mc-dist-select';
            const curDist = cur.distribution ?? { type: 'none' };
            for (const type of ['none', 'uniform', 'normal', 'lognormal', 'triangular', 'beta', 'discrete']) {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = { none: 'Default', uniform: 'Uniform', normal: 'Normal', lognormal: 'Log-normal', triangular: 'Triangular', beta: 'Beta', discrete: 'Discrete' }[type];
                if (curDist.type === type) option.selected = true;
                distSelect.appendChild(option);
            }
            distField.appendChild(distSelect);

            // Distribution params container
            const distParams = document.createElement('div');
            distParams.className = 'param-mc-dist-params';

            const populateDistParams = (dist) => {
                distParams.innerHTML = '';
                const addDistField = (lbl, key, opts = {}) => {
                    const f = document.createElement('label');
                    f.className = 'param-mc-field';
                    f.innerHTML = `<span>${lbl}</span>`;
                    const inp = document.createElement('input');
                    inp.type = opts.type || 'number';
                    inp.step = opts.step ?? 'any';
                    inp.value = dist[key] ?? '';
                    inp.addEventListener('change', () => {
                        const entry = ensureOverrideObject(data, nsName, bucketKey, item.name, defaultValue);
                        if (!entry.distribution) entry.distribution = { type: dist.type };
                        if (opts.type === 'text') {
                            entry.distribution[key] = inp.value.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
                        } else {
                            const num = parseFloat(inp.value);
                            if (Number.isFinite(num)) entry.distribution[key] = num;
                        }
                        onChanged();
                    });
                    f.appendChild(inp);
                    distParams.appendChild(f);
                };
                switch (dist.type) {
                    case 'uniform': addDistField('Min', 'min'); addDistField('Max', 'max'); break;
                    case 'normal': addDistField('Mean', 'mean'); addDistField('StdDev', 'stddev'); break;
                    case 'lognormal': addDistField('μ (mean)', 'mu'); addDistField('σ (sigma)', 'sigma'); break;
                    case 'triangular': addDistField('Min', 'min'); addDistField('Mode', 'mode'); addDistField('Max', 'max'); break;
                    case 'beta': addDistField('α (alpha)', 'alpha'); addDistField('β (beta)', 'beta'); break;
                    case 'discrete': addDistField('Values', 'values', { type: 'text' }); break;
                }
            };

            distSelect.addEventListener('change', () => {
                const entry = ensureOverrideObject(data, nsName, bucketKey, item.name, defaultValue);
                const nextType = distSelect.value;
                if (nextType === 'none') {
                    delete entry.distribution;
                } else {
                    const val = entry.value ?? defaultValue;
                    entry.distribution = { type: nextType };
                    resetDistributionForType(entry.distribution, val, nextType);
                }
                populateDistParams(entry.distribution ?? { type: 'none' });
                onChanged();
            });

            populateDistParams(curDist);

            mcPanel.appendChild(minField);
            mcPanel.appendChild(maxField);
            mcPanel.appendChild(distField);
            mcPanel.appendChild(distParams);
        };

        buildMcPanel();

        mcToggle.addEventListener('click', () => {
            const isOpen = mcPanel.style.display !== 'none';
            mcPanel.style.display = isOpen ? 'none' : 'flex';
            mcToggle.classList.toggle('active', !isOpen);
        });

        const updateState = (isOverride) => {
            row.classList.toggle('has-override', isOverride);
            clearBtn.style.visibility = isOverride ? 'visible' : 'hidden';
        };

        input.addEventListener('change', () => {
            const raw = input.value.trim();
            if (raw === '') {
                input.value = defaultValue;
                // If no MC overrides either, remove entirely
                const cur = readOverride(overrides[item.name]);
                if (!cur || (!cur.min && !cur.max && !cur.distribution)) {
                    setOverride(data, nsName, bucketKey, item.name, undefined);
                    updateState(false);
                } else {
                    // Keep MC overrides, remove value
                    delete cur.value;
                    overrides[item.name] = cur;
                    updateState(true);
                }
            } else {
                const num = parseFloat(raw);
                if (Number.isFinite(num)) {
                    const cur = readOverride(overrides[item.name]);
                    if (num === defaultValue && (!cur || (!cur.min && !cur.max && !cur.distribution))) {
                        setOverride(data, nsName, bucketKey, item.name, undefined);
                        updateState(false);
                    } else {
                        const entry = ensureOverrideObject(data, nsName, bucketKey, item.name, defaultValue);
                        entry.value = num;
                        updateState(true);
                    }
                }
            }
            onChanged();
        });

        clearBtn.addEventListener('click', () => {
            setOverride(data, nsName, bucketKey, item.name, undefined);
            input.value = defaultValue;
            mcPanel.style.display = 'none';
            mcToggle.classList.remove('active');
            buildMcPanel();
            updateState(false);
            onChanged();
        });

        const mainRow = document.createElement('div');
        mainRow.className = 'param-override-main-row';
        mainRow.appendChild(label);
        mainRow.appendChild(input);
        mainRow.appendChild(mcToggle);
        mainRow.appendChild(clearBtn);

        row.appendChild(mainRow);
        row.appendChild(mcPanel);
        list.appendChild(row);
    }

    sectionDiv.appendChild(list);
    container.appendChild(sectionDiv);
}

/**
 * Ensure the override entry for a parameter is an object (not a plain number).
 * Returns the mutable object reference.
 */
function ensureOverrideObject(data, nsName, bucketKey, itemName, defaultValue) {
    if (!data.overrides) data.overrides = {};
    if (!data.overrides[nsName]) data.overrides[nsName] = {};
    if (!data.overrides[nsName][bucketKey]) data.overrides[nsName][bucketKey] = {};

    let entry = data.overrides[nsName][bucketKey][itemName];
    if (entry === undefined || entry === null) {
        entry = {};
        data.overrides[nsName][bucketKey][itemName] = entry;
    } else if (typeof entry === 'number') {
        entry = { value: entry };
        data.overrides[nsName][bucketKey][itemName] = entry;
    }
    return entry;
}

// ── MC distributions ──

function renderDistributionSection(container, nsName, title, bucketKey, items, data, onChanged) {
    if (!data.distributions) data.distributions = {};
    if (!data.distributions[nsName]) data.distributions[nsName] = {};
    if (!data.distributions[nsName][bucketKey]) data.distributions[nsName][bucketKey] = {};

    const distributions = data.distributions[nsName][bucketKey];

    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'distribution-section';

    const sectionHeader = document.createElement('h5');
    sectionHeader.className = 'distribution-section-title';
    sectionHeader.textContent = title;
    sectionDiv.appendChild(sectionHeader);

    const list = document.createElement('div');
    list.className = 'namespace-distribution-list';

    for (const item of items) {
        let dist = distributions[item.name];
        if (!dist) {
            dist = createDefaultDistribution(item.defaultValue);
            distributions[item.name] = dist;
        }

        const row = document.createElement('div');
        row.className = 'distribution-row';

        const labelCol = document.createElement('div');
        labelCol.className = 'distribution-label';
        labelCol.innerHTML = `
            <span class="distribution-name">${escHtml(item.displayName || item.name)}</span>
            <span class="distribution-baseline">Default: ${item.defaultValue ?? 0}</span>
        `;
        row.appendChild(labelCol);

        const controlsCol = document.createElement('div');
        controlsCol.className = 'distribution-controls';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'distribution-type';
        for (const type of ['uniform', 'normal', 'lognormal', 'triangular', 'beta', 'discrete']) {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = { uniform: 'Uniform', normal: 'Normal', lognormal: 'Log-normal', triangular: 'Triangular', beta: 'Beta', discrete: 'Discrete' }[type];
            if (dist.type === type) option.selected = true;
            typeSelect.appendChild(option);
        }

        const fieldsContainer = document.createElement('div');
        fieldsContainer.className = 'distribution-fields';

        typeSelect.addEventListener('change', () => {
            resetDistributionForType(dist, item.defaultValue, typeSelect.value);
            fieldsContainer.innerHTML = '';
            populateDistributionFields(fieldsContainer, dist, () => { distributions[item.name] = dist; onChanged(); });
            distributions[item.name] = dist;
            onChanged();
        });

        controlsCol.appendChild(typeSelect);
        populateDistributionFields(fieldsContainer, dist, () => { distributions[item.name] = dist; onChanged(); });
        controlsCol.appendChild(fieldsContainer);
        row.appendChild(controlsCol);
        list.appendChild(row);
    }

    sectionDiv.appendChild(list);
    container.appendChild(sectionDiv);
}

/**
 * Create a default distribution for a parameter baseline.
 */
export function createDefaultDistribution(baseline) {
    const val = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0;
    const magnitude = Math.abs(val);
    const spread = Math.max(magnitude * 0.15, 0.25);
    let min = val - spread;
    let max = val + spread;
    if (val >= 0 && min < 0) { min = 0; max = Math.max(max, spread); }
    return { type: 'uniform', min, max, enabled: true };
}

function resetDistributionForType(dist, baseline, nextType) {
    const val = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0;
    const defaults = createDefaultDistribution(val);
    dist.type = nextType;
    // Clean all type-specific keys first
    delete dist.min; delete dist.max; delete dist.mean; delete dist.stddev;
    delete dist.mode; delete dist.values; delete dist.mu; delete dist.sigma;
    delete dist.alpha; delete dist.beta;
    switch (nextType) {
        case 'uniform':
            dist.min = defaults.min; dist.max = defaults.max;
            break;
        case 'normal':
            dist.mean = val; dist.stddev = Math.max(Math.abs(val) * 0.1, 0.01);
            break;
        case 'lognormal':
            dist.mu = val > 0 ? Math.log(val) : 0;
            dist.sigma = 0.1;
            break;
        case 'triangular':
            dist.min = defaults.min; dist.max = defaults.max;
            dist.mode = Math.min(Math.max(val, dist.min), dist.max);
            break;
        case 'beta':
            dist.alpha = 2; dist.beta = 2;
            break;
        case 'discrete':
            dist.values = [val];
            break;
    }
}

function populateDistributionFields(container, dist, onChange) {
    container.innerHTML = '';
    const addField = (label, key, options = {}) => {
        const field = document.createElement('div');
        field.className = 'distribution-field';
        const caption = document.createElement('span');
        caption.className = 'distribution-field-label';
        caption.textContent = label + ':';
        field.appendChild(caption);
        const input = document.createElement('input');
        input.type = options.type || 'number';
        input.step = options.step ?? 'any';
        if (options.min !== undefined) input.min = options.min;
        input.value = dist[key] != null ? dist[key] : '';
        input.addEventListener('change', () => {
            if (options.type === 'text') {
                dist[key] = input.value.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
            } else {
                const num = parseFloat(input.value);
                if (Number.isFinite(num)) dist[key] = num;
            }
            onChange();
        });
        field.appendChild(input);
        container.appendChild(field);
    };
    switch (dist.type) {
        case 'uniform': addField('Min', 'min'); addField('Max', 'max'); break;
        case 'normal': addField('Mean', 'mean'); addField('StdDev', 'stddev', { min: 0 }); break;
        case 'lognormal': addField('μ (mean)', 'mu'); addField('σ (sigma)', 'sigma', { min: 0 }); break;
        case 'triangular': addField('Min', 'min'); addField('Mode', 'mode'); addField('Max', 'max'); break;
        case 'beta': addField('α (alpha)', 'alpha', { min: 0 }); addField('β (beta)', 'beta', { min: 0 }); break;
        case 'discrete': {
            const field = document.createElement('div');
            field.className = 'distribution-field distribution-field-wide';
            const caption = document.createElement('span');
            caption.className = 'distribution-field-label';
            caption.textContent = 'Values:';
            field.appendChild(caption);
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'e.g. 1, 2, 3';
            input.value = Array.isArray(dist.values) ? dist.values.join(', ') : '';
            input.addEventListener('change', () => {
                dist.values = input.value.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
                onChange();
            });
            field.appendChild(input);
            container.appendChild(field);
            break;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function setOverride(data, nsName, bucketKey, itemName, value) {
    if (!data.overrides) data.overrides = {};
    if (!data.overrides[nsName]) data.overrides[nsName] = {};
    if (!data.overrides[nsName][bucketKey]) data.overrides[nsName][bucketKey] = {};

    if (value === undefined) {
        delete data.overrides[nsName][bucketKey][itemName];
        if (Object.keys(data.overrides[nsName][bucketKey]).length === 0) delete data.overrides[nsName][bucketKey];
        if (Object.keys(data.overrides[nsName]).length === 0) delete data.overrides[nsName];
    } else {
        data.overrides[nsName][bucketKey][itemName] = value;
    }
}

/**
 * Wire all [data-config] fields in a container to set nested values on data.
 */
function wireConfigFields(container, data, onChanged) {
    for (const input of container.querySelectorAll('[data-config]')) {
        const handler = () => {
            const path = input.dataset.config.split('.');
            let target = data;
            for (let i = 0; i < path.length - 1; i++) {
                if (!target[path[i]]) target[path[i]] = {};
                target = target[path[i]];
            }
            const key = path[path.length - 1];
            if (input.tagName === 'SELECT') {
                target[key] = input.value || null;
            } else if (input.type === 'text') {
                target[key] = input.value;
            } else {
                const raw = input.value.trim();
                target[key] = raw === '' ? null : parseFloat(raw);
            }
            // Clean up empty nested objects
            if (path.length === 2) {
                const parentKey = path[0];
                const parent = data[parentKey];
                if (parent && typeof parent === 'object') {
                    const allNull = Object.values(parent).every(v => v === null || v === undefined);
                    if (allNull) data[parentKey] = null;
                }
            }
            // Keep scenario type in sync with monteCarlo.runs
            if (path[0] === 'monteCarlo') {
                const mcRuns = data.monteCarlo?.runs ?? 0;
                data.type = mcRuns > 0 ? 'monte-carlo' : 'static';
            }
            onChanged();
        };
        input.addEventListener('change', handler);
        if (input.tagName !== 'SELECT' && input.type === 'text') {
            input.addEventListener('input', handler);
        }
    }
}

function esc(s) { return String(s ?? '').replace(/"/g, '&quot;'); }
function escHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/**
 * Render mixed markdown + LaTeX text.
 */
export function renderLatexText(text, element) {
    element.innerHTML = text ? renderMarkdown(text) : '';
}
