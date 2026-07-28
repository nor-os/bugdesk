/**
 * scenario_assumption_renderer.js
 *
 * Reusable assumption group rendering for scenario editors.
 * Pure view functions — no DataManager or SimulationController dependency.
 * Receives data and callbacks.
 *
 * Extracted from ScenarioManagerPage for reuse in ScenarioFileEditor.
 */

import { renderLatexText } from './scenario_param_renderer.js';
import { ManagedWindow } from '../ui/components/managed_window.js';

// ═══════════════════════════════════════════════════════════════════
// Assumptions Panel
// ═══════════════════════════════════════════════════════════════════

/**
 * Render the Assumptions tab — collapsible group cards with parameter sliders/inputs.
 * @param {HTMLElement} container
 * @param {object} data — scenario data (has .assumptionGroups, .overrides)
 * @param {object} configurables — { [namespaceName]: { parameters: [], constants: [], stocks: [] } }
 * @param {{ onChanged: () => void }} callbacks
 * @returns {{ reRender: () => void }}
 */
export function renderAssumptionsTab(container, data, configurables, { onChanged }) {
    container.innerHTML = '';

    if (!data.assumptionGroups) data.assumptionGroups = [];

    const section = document.createElement('section');
    section.className = 'scenario-detail__section';

    // Header row: title + "New Group" button
    const headerRow = document.createElement('div');
    headerRow.className = 'assumptions-header';
    headerRow.innerHTML = `
        <h3 class="scenario-detail__section-title">
            <span class="material-symbols-outlined">tune</span> Assumptions
        </h3>
    `;
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'scenario-btn secondary small';
    addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> New Group';
    addBtn.addEventListener('click', () => openGroupEditor(null, configurables, data, { onChanged, reRender }));
    headerRow.appendChild(addBtn);
    section.appendChild(headerRow);

    const cardsEl = document.createElement('div');
    cardsEl.className = 'assumption-cards';
    section.appendChild(cardsEl);
    container.appendChild(section);

    const reRender = () => {
        cardsEl.innerHTML = '';
        const groups = data.assumptionGroups || [];
        if (groups.length === 0) {
            cardsEl.innerHTML = '<p class="assumption-card__empty" style="padding:16px 0">No assumption groups yet. Click "New Group" to create one.</p>';
        } else {
            for (let i = 0; i < groups.length; i++) {
                renderGroupCard(cardsEl, groups[i], i, data, configurables, { onChanged, reRender });
            }
        }
    };

    reRender();
    return { reRender };
}

// ═══════════════════════════════════════════════════════════════════
// Assumption Group Card
// ═══════════════════════════════════════════════════════════════════

function renderGroupCard(container, group, index, data, configurables, { onChanged, reRender }) {
    const items = group.items || [];

    // Resolve each item against configurables for metadata (defaultValue, min, max, step)
    const resolved = items.map(item => {
        const nsConfig = configurables[item.namespace];
        if (!nsConfig) return { ...item, defaultValue: 0 };
        const bucket = item.nodeType === 'constant' ? nsConfig.constants : nsConfig.parameters;
        const found = bucket?.find(p => p.name === item.name);
        return {
            ...item,
            displayName: found?.displayName || item.name,
            defaultValue: found?.defaultValue ?? 0,
            min: found?.min ?? null,
            max: found?.max ?? null,
            step: found?.step ?? null,
        };
    });

    const card = document.createElement('div');
    card.className = 'assumption-card';
    if (group.collapsed) card.classList.add('assumption-card--collapsed');

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'assumption-card__header';
    headerEl.innerHTML = `
        <div class="assumption-card__title">
            <button class="assumption-card__toggle" type="button">
                <span class="material-symbols-outlined assumption-card__arrow">${group.collapsed ? 'chevron_right' : 'expand_more'}</span>
            </button>
            <span class="assumption-card__name">${escHtml(group.name)}</span>
            <span class="assumption-card__count">${resolved.length}</span>
        </div>
        <div class="assumption-card__actions">
            <button class="assumption-card__action" data-action="edit" title="Edit group">
                <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="assumption-card__action" data-action="delete" title="Delete group">
                <span class="material-symbols-outlined">delete</span>
            </button>
        </div>
    `;
    card.appendChild(headerEl);

    // Group description
    const groupDescEl = document.createElement('div');
    groupDescEl.className = 'assumption-card__group-desc';
    if (group.description) {
        renderLatexText(group.description, groupDescEl);
    } else {
        groupDescEl.classList.add('assumption-card__group-desc--empty');
    }
    groupDescEl.addEventListener('dblclick', () => startDescriptionEdit(groupDescEl, group, 'Group description (supports $LaTeX$)...', onChanged));
    card.appendChild(groupDescEl);

    // Body — parameter rows
    const body = document.createElement('div');
    body.className = 'assumption-card__body';

    if (resolved.length === 0) {
        body.innerHTML = '<p class="assumption-card__empty">No parameters in this group.</p>';
    } else {
        for (let j = 0; j < resolved.length; j++) {
            body.appendChild(renderParamRow(resolved[j], items[j], data, onChanged));
        }
    }
    card.appendChild(body);

    // Events
    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        const collapsed = card.classList.toggle('assumption-card--collapsed');
        group.collapsed = collapsed;
        const arrow = card.querySelector('.assumption-card__arrow');
        if (arrow) arrow.textContent = collapsed ? 'chevron_right' : 'expand_more';
        onChanged();
    });
    headerEl.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupEditor(index, configurables, data, { onChanged, reRender });
    });
    headerEl.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete group "${group.name}"?`)) return;
        data.assumptionGroups.splice(index, 1);
        onChanged();
        reRender();
    });

    container.appendChild(card);
}

// ═══════════════════════════════════════════════════════════════════
// Parameter Row (slider or number input)
// ═══════════════════════════════════════════════════════════════════

function renderParamRow(item, editableItem, data, onChanged) {
    const nsName = item.namespace;
    const bucketKey = item.nodeType === 'constant' ? 'constants' : 'parameters';
    const overrides = data.overrides?.[nsName]?.[bucketKey] || {};
    const overrideValue = overrides[item.name];
    const hasOverride = overrideValue !== undefined;
    const defaultValue = item.defaultValue ?? 0;
    const currentValue = hasOverride ? overrideValue : defaultValue;

    const row = document.createElement('div');
    row.className = 'assumption-row';
    if (hasOverride) row.classList.add('has-override');

    // Label
    const label = document.createElement('label');
    label.className = 'assumption-row__label';
    label.textContent = item.displayName || item.name;
    row.appendChild(label);

    // Input container
    const inputContainer = document.createElement('div');
    inputContainer.className = 'assumption-row__input';

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'assumption-row__value';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'param-clear-btn plain-icon-btn';
    clearBtn.title = 'Reset to default';
    clearBtn.innerHTML = '<span class="material-symbols-outlined">restart_alt</span>';
    clearBtn.style.visibility = hasOverride ? 'visible' : 'hidden';

    const updateState = (isOverride) => {
        row.classList.toggle('has-override', isOverride);
        clearBtn.style.visibility = isOverride ? 'visible' : 'hidden';
    };

    const setOverride = (value) => {
        if (!data.overrides) data.overrides = {};
        if (!data.overrides[nsName]) data.overrides[nsName] = {};
        if (!data.overrides[nsName][bucketKey]) data.overrides[nsName][bucketKey] = {};
        if (value === undefined) {
            delete data.overrides[nsName][bucketKey][item.name];
            if (Object.keys(data.overrides[nsName][bucketKey]).length === 0) delete data.overrides[nsName][bucketKey];
            if (Object.keys(data.overrides[nsName]).length === 0) delete data.overrides[nsName];
        } else {
            data.overrides[nsName][bucketKey][item.name] = value;
        }
        onChanged();
    };

    if (item.min != null && item.max != null) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'assumption-slider';
        slider.min = item.min;
        slider.max = item.max;
        slider.step = item.step || 'any';
        slider.value = currentValue;
        valueDisplay.textContent = currentValue;

        slider.addEventListener('input', () => { valueDisplay.textContent = parseFloat(slider.value); });
        slider.addEventListener('change', () => {
            const num = parseFloat(slider.value);
            if (num === defaultValue) { setOverride(undefined); updateState(false); }
            else { setOverride(num); updateState(true); }
        });
        inputContainer.appendChild(slider);
    } else {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'assumption-number-input';
        input.value = currentValue;
        input.step = item.step || 'any';
        valueDisplay.textContent = currentValue;

        input.addEventListener('change', () => {
            const num = parseFloat(input.value);
            if (Number.isFinite(num)) {
                if (num === defaultValue) { setOverride(undefined); updateState(false); }
                else { setOverride(num); updateState(true); }
                valueDisplay.textContent = num;
            }
        });
        inputContainer.appendChild(input);
    }

    inputContainer.appendChild(valueDisplay);

    const hint = document.createElement('span');
    hint.className = 'assumption-row__default';
    hint.textContent = `default: ${defaultValue}`;
    inputContainer.appendChild(hint);

    clearBtn.addEventListener('click', () => {
        setOverride(undefined);
        const slider = inputContainer.querySelector('.assumption-slider');
        const numInput = inputContainer.querySelector('.assumption-number-input');
        if (slider) slider.value = defaultValue;
        if (numInput) numInput.value = defaultValue;
        valueDisplay.textContent = defaultValue;
        updateState(false);
    });
    inputContainer.appendChild(clearBtn);
    row.appendChild(inputContainer);

    // Description column
    if (editableItem) {
        const descEl = document.createElement('div');
        descEl.className = 'assumption-row__desc';
        if (item.description) renderLatexText(item.description, descEl);
        descEl.addEventListener('dblclick', () => startDescriptionEdit(descEl, editableItem, 'Parameter rationale (supports $LaTeX$)...', onChanged));
        row.appendChild(descEl);
    }

    return row;
}

// ═══════════════════════════════════════════════════════════════════
// Group Editor (ManagedWindow)
// ═══════════════════════════════════════════════════════════════════

let _groupEditorWindow = null;

function openGroupEditor(groupIndex, configurables, data, { onChanged, reRender }) {
    const isEdit = groupIndex !== null && groupIndex !== undefined;
    const existingGroup = isEdit ? data.assumptionGroups?.[groupIndex] : null;
    const namespaces = Object.keys(configurables);

    const content = document.createElement('div');
    content.className = 'group-editor';

    // Name field
    const nameLabel = document.createElement('label');
    nameLabel.className = 'group-editor__field-label';
    nameLabel.textContent = 'Group Name';
    content.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'group-editor__name-field';
    nameInput.placeholder = 'e.g., Energy Policy';
    nameInput.value = existingGroup?.name || '';
    content.appendChild(nameInput);

    // Description field
    const descLabel = document.createElement('label');
    descLabel.className = 'group-editor__field-label';
    descLabel.textContent = 'Description';
    descLabel.style.marginTop = '8px';
    content.appendChild(descLabel);

    const descInput = document.createElement('textarea');
    descInput.className = 'group-editor__name-field';
    descInput.placeholder = 'Group description (supports $LaTeX$)...';
    descInput.value = existingGroup?.description || '';
    descInput.rows = 2;
    descInput.style.resize = 'vertical';
    descInput.style.fontFamily = 'inherit';
    content.appendChild(descInput);

    // Parameter selector
    const selectorLabel = document.createElement('label');
    selectorLabel.className = 'group-editor__field-label';
    selectorLabel.textContent = 'Parameters';
    selectorLabel.style.marginTop = '12px';
    content.appendChild(selectorLabel);

    // Namespace tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'group-editor__ns-tabs';
    let activeNs = namespaces[0] || null;

    for (const ns of namespaces) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'group-editor__ns-tab';
        tab.textContent = ns;
        tab.dataset.ns = ns;
        if (ns === activeNs) tab.classList.add('active');
        tab.addEventListener('click', () => {
            tabBar.querySelectorAll('.group-editor__ns-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeNs = ns;
            renderParamList(ns);
        });
        tabBar.appendChild(tab);
    }
    content.appendChild(tabBar);

    const listContainer = document.createElement('div');
    listContainer.className = 'group-editor__items';
    content.appendChild(listContainer);

    // Track selected items
    const selectedSet = new Set();
    if (existingGroup) {
        for (const item of existingGroup.items || []) {
            selectedSet.add(`${item.namespace}::${item.name}`);
        }
    }

    const renderParamList = (nsName) => {
        listContainer.innerHTML = '';
        const nsConfig = configurables[nsName];
        if (!nsConfig) { listContainer.innerHTML = '<p class="group-editor__empty">No parameters.</p>'; return; }
        const allItems = [
            ...nsConfig.parameters.map(p => ({ ...p, nodeType: 'parameter' })),
            ...nsConfig.constants.map(c => ({ ...c, nodeType: 'constant' })),
        ];
        if (allItems.length === 0) { listContainer.innerHTML = '<p class="group-editor__empty">No configurable parameters in this namespace.</p>'; return; }
        for (const item of allItems) {
            const key = `${nsName}::${item.name}`;
            const row = document.createElement('label');
            row.className = 'group-editor__item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedSet.has(key);
            cb.addEventListener('change', () => { if (cb.checked) selectedSet.add(key); else selectedSet.delete(key); });
            row.appendChild(cb);
            const nameSpan = document.createElement('span');
            nameSpan.className = 'group-editor__item-name';
            nameSpan.textContent = item.displayName || item.name;
            row.appendChild(nameSpan);
            const defSpan = document.createElement('span');
            defSpan.className = 'group-editor__item-default';
            defSpan.textContent = `${item.defaultValue ?? 0}`;
            row.appendChild(defSpan);
            listContainer.appendChild(row);
        }
    };

    if (activeNs) renderParamList(activeNs);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'group-editor__footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'scenario-btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { _groupEditorWindow?.close(); _groupEditorWindow = null; });
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'scenario-btn primary';
    saveBtn.textContent = isEdit ? 'Save' : 'Create';
    saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const description = descInput.value.trim();
        const items = [...selectedSet].map(key => {
            const [ns, paramName] = key.split('::');
            const nsConfig = configurables[ns];
            const isConst = nsConfig?.constants?.some(c => c.name === paramName);
            return { namespace: ns, name: paramName, nodeType: isConst ? 'constant' : 'parameter' };
        });

        if (!data.assumptionGroups) data.assumptionGroups = [];
        if (isEdit && data.assumptionGroups[groupIndex]) {
            data.assumptionGroups[groupIndex].name = name;
            data.assumptionGroups[groupIndex].description = description;
            data.assumptionGroups[groupIndex].items = items;
        } else {
            data.assumptionGroups.push({ id: `ag-${Date.now()}`, name, description, collapsed: false, items });
        }
        onChanged();
        reRender();
        _groupEditorWindow?.close();
        _groupEditorWindow = null;
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    content.appendChild(footer);

    _groupEditorWindow?.close();
    _groupEditorWindow = new ManagedWindow({
        id: 'group-editor',
        title: isEdit ? 'Edit Group' : 'New Group',
        content,
        modal: true,
        defaultWidth: 440,
        defaultHeight: 480,
        canMinimize: false,
        canMaximize: false,
        canResize: false,
    });
    _groupEditorWindow.show();
    nameInput.focus();
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function startDescriptionEdit(element, target, placeholder, onChanged) {
    if (element.querySelector('textarea')) return;
    const currentText = target.description || '';
    element.innerHTML = '';
    element.classList.remove('assumption-card__group-desc--empty');
    const textarea = document.createElement('textarea');
    textarea.className = 'assumption-desc__textarea';
    textarea.value = currentText;
    textarea.placeholder = placeholder;
    element.appendChild(textarea);
    textarea.focus();
    const save = () => {
        const newText = textarea.value.trim();
        target.description = newText || '';
        element.innerHTML = '';
        if (newText) renderLatexText(newText, element);
        else element.classList.add('assumption-card__group-desc--empty');
        onChanged();
    };
    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') { textarea.value = currentText; save(); } });
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
