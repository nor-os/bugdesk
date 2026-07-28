/**
 * TestFileEditor
 *
 * Definition-only editor for `.test` files within the notebook page.
 * Test execution lives on the Simulation Run Page (Tests tab).
 *
 * This editor handles:
 *   - Breadcrumb showing project context
 *   - Detail header with test name (renameable)
 *   - Scenarios section: assign target scenarios
 *   - Assertions section: define variable assertions with autocomplete
 *   - Last-run status hints (read-only, from simulation page results)
 *   - Empty state for new tests
 *
 * Variable autocomplete uses the AutocompleteField component with
 * namespace select, populated from the NotebookSymbolIndex.
 *
 * Test file format:
 *   { format: "ecosim-test", version: 1, name, scenarios: [...], assertions: [...] }
 *
 * scenarios: array of scenario file paths (a test can target multiple scenarios)
 *
 * Assertions:
 *   { variable, at, op, value, tolerance? }
 */

import { SortableList } from '../ui/components/sortable_list.js';
import { AutocompleteField } from '../ui/components/autocomplete_field.js';
import { ManagedWindow } from '../ui/components/managed_window.js';
import { createDetailHeader } from '../ui/components/detail_header.js';

const OPERATORS = Object.freeze([
    { value: '>',  label: '>' },
    { value: '<',  label: '<' },
    { value: '>=', label: '\u2265' },
    { value: '<=', label: '\u2264' },
    { value: '==', label: '=' },
    { value: '!=', label: '\u2260' },
    { value: '\u2248',  label: '\u2248' },
]);

export class TestFileEditor {
    /** @type {HTMLElement} */
    #container = null;

    /** @type {object} Test file content */
    #data = null;

    /** @type {Function} */
    #onChange = null;

    /** @type {object} ProjectModel */
    #project = null;

    /** @type {import('./notebook_symbol_index.js').NotebookSymbolIndex|null} */
    #symbolIndex = null;

    /** @type {object|null} Last run results: { assertionResults: [{passed, message}], scenario, timestamp } */
    #lastRunResults = null;

    /** @type {SortableList|null} */
    #assertionsList = null;

    /** @type {AutocompleteField[]} Active autocomplete fields (for disposal) */
    #autocompleteFields = [];

    /** @type {HTMLElement|null} */
    #scenarioListEl = null;

    /** @type {ManagedWindow|null} */
    #pickerWindow = null;

    /** @type {Function[]} */
    #disposers = [];

    constructor() {}

    /**
     * @param {HTMLElement} container
     * @param {{
     *   data: object,
     *   project: object,
     *   symbolIndex: object,
     *   filePath?: string,
     *   projectName?: string,
     *   lastRunResults?: object,
     *   onChange: Function,
     * }} opts
     */
    async mount(container, { data, project, symbolIndex, lastRunResults = null, onChange }) {
        this.#container = container;
        this.#data = data ?? { format: 'ecosim-test', version: 1, name: '', scenarios: [], assertions: [] };
        if (!Array.isArray(this.#data.scenarios)) this.#data.scenarios = [];
        this.#project = project;
        this.#symbolIndex = symbolIndex ?? null;
        this.#lastRunResults = lastRunResults ?? null;
        this.#onChange = onChange;

        // Load model cells into the symbol index BEFORE rendering
        await this.#ensureModelSymbols();

        this.#render();
    }

    /** Return current test data (for saving). */
    getData() {
        if (this.#assertionsList) {
            this.#data.assertions = this.#assertionsList.getItems().map(item => {
                const a = { variable: item.variable || '', at: item.at, op: item.op || '>', value: item.value };
                if (item.tolerance != null && item.tolerance !== '') a.tolerance = item.tolerance;
                if (item.scenario) a.scenario = item.scenario;
                return a;
            });
        }
        return { ...this.#data };
    }

    /** Update last-run results (called externally when simulation completes). */
    setLastRunResults(results) {
        this.#lastRunResults = results ?? null;
    }

    dispose() {
        this.#pickerWindow?.close();
        this.#pickerWindow = null;
        this.#disposeAutocompleteFields();
        this.#assertionsList?.dispose();
        this.#assertionsList = null;
        for (const d of this.#disposers) d?.();
        this.#disposers = [];
        this.#container = null;
    }

    #disposeAutocompleteFields() {
        for (const ac of this.#autocompleteFields) ac.dispose?.();
        this.#autocompleteFields = [];
    }

    // ─── Rendering ────────────────────────────────────────────────────────────

    #render() {
        this.#container.innerHTML = '';
        this.#disposeAutocompleteFields();

        const root = document.createElement('div');
        root.className = 'editor-chrome';

        // Header
        root.appendChild(this.#buildHeaderRow());

        // Scrollable content area
        const content = document.createElement('div');
        content.className = 'nb-structured-editor__content';

        content.appendChild(this.#buildScenarioSection());
        content.appendChild(this.#buildAssertionsSection());

        root.appendChild(content);
        this.#container.appendChild(root);
    }

    #buildHeaderRow() {
        const badges = [{ text: 'Test', icon: 'fact_check' }];

        // Show last-run status badge if available
        if (this.#lastRunResults) {
            const lr = this.#lastRunResults;
            const allPassed = lr.assertionResults?.every(r => r.passed);
            const scenarioName = lr.scenario
                ? lr.scenario.split('/').pop().replace('.scenario', '')
                : null;

            badges.push({
                text: allPassed ? 'Passed' : 'Failed',
                icon: allPassed ? 'check_circle' : 'cancel',
                className: allPassed ? 'detail-header__badge--valid' : 'detail-header__badge--invalid',
            });

            if (scenarioName) {
                badges.push({
                    text: scenarioName,
                    icon: 'science',
                });
            }
        }

        return createDetailHeader({
            title: this.#data.name || 'Untitled Test',
            badges,
            renameable: true,
            onRename: async (newName) => {
                this.#data.name = newName;
                this.#emitChange();
                return { success: true, newValue: newName };
            },
        });
    }

    #buildScenarioSection() {
        const section = document.createElement('div');
        section.className = 'nb-structured-editor__section';

        const heading = document.createElement('div');
        heading.className = 'nb-structured-editor__section-title';
        heading.innerHTML = '<span class="material-symbols-outlined">science</span> Scenarios';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'scenario-btn secondary small';
        addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add';
        addBtn.style.marginLeft = 'auto';
        addBtn.addEventListener('click', () => this.#openScenarioPicker());
        heading.appendChild(addBtn);

        section.appendChild(heading);

        this.#scenarioListEl = document.createElement('div');
        this.#scenarioListEl.className = 'nb-structured-editor__scenario-list';
        this.#renderScenarioList();
        section.appendChild(this.#scenarioListEl);

        return section;
    }

    #renderScenarioList() {
        if (!this.#scenarioListEl) return;
        this.#scenarioListEl.innerHTML = '';

        const scenarios = this.#data.scenarios ?? [];

        if (scenarios.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'nb-structured-editor__empty-hint';
            empty.textContent = 'No scenarios assigned. Click Add to assign scenarios.';
            this.#scenarioListEl.appendChild(empty);
            return;
        }

        for (const path of scenarios) {
            const chip = document.createElement('div');
            chip.className = 'nb-structured-editor__scenario-chip';

            const label = document.createElement('span');
            label.className = 'nb-structured-editor__scenario-chip-label';
            label.textContent = path.split('/').pop().replace('.scenario', '');
            label.title = path;
            chip.appendChild(label);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'nb-structured-editor__scenario-chip-remove';
            removeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
            removeBtn.title = 'Remove scenario';
            removeBtn.addEventListener('click', () => {
                this.#data.scenarios = this.#data.scenarios.filter(p => p !== path);
                this.#renderScenarioList();
                this.#emitChange();
            });
            chip.appendChild(removeBtn);

            this.#scenarioListEl.appendChild(chip);
        }
    }

    #openScenarioPicker() {
        if (this.#pickerWindow?.isVisible) {
            this.#pickerWindow.bringToFront();
            return;
        }

        const allScenarios = this.#project?.files?.filter(f => f.type === 'scenario') ?? [];
        const alreadyAdded = new Set(this.#data.scenarios ?? []);
        const available = allScenarios.filter(s => !alreadyAdded.has(s.path));

        if (available.length === 0) return;

        const selected = new Set();

        const root = document.createElement('div');
        root.className = 'nb-scenario-picker';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'nb-scenario-picker__search';
        searchInput.placeholder = 'Search scenarios\u2026';
        root.appendChild(searchInput);

        const listEl = document.createElement('div');
        listEl.className = 'nb-scenario-picker__list';

        const renderList = (filter = '') => {
            listEl.innerHTML = '';
            const filtered = filter
                ? available.filter(s => s.path.toLowerCase().includes(filter.toLowerCase()))
                : available;

            if (filtered.length === 0) {
                const emptyEl = document.createElement('div');
                emptyEl.className = 'nb-scenario-picker__empty';
                emptyEl.textContent = 'No matching scenarios.';
                listEl.appendChild(emptyEl);
                return;
            }

            for (const s of filtered) {
                const row = document.createElement('label');
                row.className = 'nb-scenario-picker__row';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selected.has(s.path);
                cb.addEventListener('change', () => {
                    if (cb.checked) selected.add(s.path);
                    else selected.delete(s.path);
                });
                row.appendChild(cb);

                const name = document.createElement('span');
                name.textContent = s.path.split('/').pop().replace('.scenario', '');
                name.title = s.path;
                row.appendChild(name);

                listEl.appendChild(row);
            }
        };

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        renderList();
        root.appendChild(listEl);

        const footer = document.createElement('div');
        footer.className = 'nb-scenario-picker__footer';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'nb-scenario-picker__btn nb-scenario-picker__btn--cancel';
        cancelBtn.textContent = 'Cancel';
        footer.appendChild(cancelBtn);

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'nb-scenario-picker__btn nb-scenario-picker__btn--add';
        addBtn.textContent = 'Add';
        footer.appendChild(addBtn);

        root.appendChild(footer);

        this.#pickerWindow = new ManagedWindow({
            id: 'test-scenario-picker',
            title: 'Add Scenarios',
            icon: 'science',
            content: root,
            minWidth: 320,
            minHeight: 260,
            defaultWidth: 400,
            defaultHeight: 380,
            canMinimize: false,
            canMaximize: false,
            canResize: true,
            canDrag: true,
            modal: true,
            onClose: () => { this.#pickerWindow = null; },
        });

        this.#pickerWindow.show();

        cancelBtn.addEventListener('click', () => this.#pickerWindow?.close());
        addBtn.addEventListener('click', () => {
            if (selected.size > 0) {
                this.#data.scenarios = [...(this.#data.scenarios ?? []), ...selected];
                this.#renderScenarioList();
                this.#emitChange();
            }
            this.#pickerWindow?.close();
        });

        requestAnimationFrame(() => searchInput.focus());
    }

    #buildAssertionsSection() {
        const section = document.createElement('div');
        section.className = 'nb-structured-editor__section';

        const heading = document.createElement('div');
        heading.className = 'nb-structured-editor__section-title';
        heading.innerHTML = '<span class="material-symbols-outlined">checklist</span> Assertions';
        section.appendChild(heading);

        const items = (this.#data.assertions ?? []).map(a => ({
            id: a.id ?? crypto.randomUUID(),
            variable: a.variable ?? '',
            at: a.at ?? null,
            op: a.op ?? '>',
            value: a.value ?? 0,
            tolerance: a.tolerance ?? undefined,
            scenario: a.scenario ?? '',
        }));

        // If no assertions, show empty state hint
        if (items.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'test-file-editor__empty-state';
            emptyHint.innerHTML = `
                <span class="material-symbols-outlined">checklist</span>
                <p>Add assertions to validate model behavior.<br>Each assertion checks a variable's value at a specific time step.</p>
            `;
            section.appendChild(emptyHint);
        }

        this.#assertionsList?.dispose();
        this.#assertionsList = new SortableList({
            containerId: 'test-editor-assertions',
            items,
            onChange: () => this.#emitChange(),
            createItem: () => ({
                id: crypto.randomUUID(),
                variable: '',
                at: null,
                op: '>',
                value: 0,
                tolerance: undefined,
                scenario: '',
            }),
            renderItem: (container, item, index, callbacks) => {
                this.#renderAssertionRow(container, item, index, callbacks);
            },
            addButtonText: 'Add Assertion',
            minItems: 0,
        });

        section.appendChild(this.#assertionsList.render());
        return section;
    }

    #renderAssertionRow(container, item, index, callbacks) {
        const row = document.createElement('div');
        row.className = 'nb-structured-editor__row';

        // Last-run status hint (read-only)
        const hint = this.#getAssertionHint(index);
        if (hint) {
            row.appendChild(hint);
        }

        // Scenario scope (optional — blank = all scenarios)
        const scenarios = this.#data.scenarios ?? [];
        if (scenarios.length > 1) {
            const scenSelect = document.createElement('select');
            scenSelect.className = 'model-test__operator';
            scenSelect.title = 'Scenario scope (blank = all scenarios)';
            scenSelect.style.maxWidth = '120px';
            const allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'all';
            scenSelect.appendChild(allOpt);
            for (const sp of scenarios) {
                const opt = document.createElement('option');
                opt.value = sp;
                opt.textContent = sp.replace('scenarios/', '').replace('.scenario', '');
                if (sp === item.scenario) opt.selected = true;
                scenSelect.appendChild(opt);
            }
            scenSelect.addEventListener('change', () => {
                callbacks.update({ scenario: scenSelect.value || '' });
            });
            row.appendChild(scenSelect);
        }

        // Variable autocomplete field with namespace select
        const acWrapper = document.createElement('div');
        acWrapper.className = 'nb-structured-editor__autocomplete';
        acWrapper.style.flex = '1';
        acWrapper.style.minWidth = '140px';
        acWrapper.style.maxWidth = '340px';

        const namespaceOptions = this.#getNamespaceOptions();

        const ac = new AutocompleteField({
            fieldId: `test-var-${item.id}`,
            field: {
                placeholder: 'variable_name',
                value: item.variable ?? '',
                helperText: '',
            },
            provider: ({ value, namespace }) => this.#variableProvider(value, namespace),
            onChange: (value) => {
                callbacks.update({ variable: value });
            },
            namespace: '__ALL__',
            namespaceOptions,
            showNamespaceSelect: true,
            variant: 'notebook',
            skipNamespacePrefix: true,
        });

        this.#autocompleteFields.push(ac);
        acWrapper.appendChild(ac.render());
        row.appendChild(acWrapper);

        // "at t =" label
        const atLabel = document.createElement('span');
        atLabel.className = 'nb-structured-editor__accent';
        atLabel.textContent = 'at t\u2009=';
        row.appendChild(atLabel);

        // Time input
        const atInput = document.createElement('input');
        atInput.type = 'number';
        atInput.className = 'model-test__value-input';
        atInput.value = item.at ?? '';
        atInput.step = 'any';
        atInput.placeholder = 'time';
        atInput.addEventListener('change', () => {
            callbacks.update({ at: atInput.value !== '' ? parseFloat(atInput.value) : null });
        });
        row.appendChild(atInput);

        // Operator dropdown
        const opSelect = document.createElement('select');
        opSelect.className = 'model-test__operator';
        for (const op of OPERATORS) {
            const opt = document.createElement('option');
            opt.value = op.value;
            opt.textContent = op.label;
            if (op.value === item.op) opt.selected = true;
            opSelect.appendChild(opt);
        }
        opSelect.addEventListener('change', () => {
            callbacks.update({ op: opSelect.value });
            const tolGroup = row.querySelector('.nb-structured-editor__tolerance-group');
            if (tolGroup) tolGroup.style.display = opSelect.value === '\u2248' ? 'flex' : 'none';
        });
        row.appendChild(opSelect);

        // Expected value
        const valInput = document.createElement('input');
        valInput.type = 'number';
        valInput.className = 'model-test__value-input';
        valInput.value = item.value ?? '';
        valInput.step = 'any';
        valInput.placeholder = 'expected';
        valInput.addEventListener('change', () => {
            callbacks.update({ value: valInput.value !== '' ? parseFloat(valInput.value) : null });
        });
        row.appendChild(valInput);

        // Tolerance (only visible for ≈ operator)
        const tolGroup = document.createElement('span');
        tolGroup.className = 'nb-structured-editor__tolerance-group';
        tolGroup.style.display = item.op === '\u2248' ? 'flex' : 'none';
        tolGroup.style.alignItems = 'center';
        tolGroup.style.gap = '3px';

        const tolLabel = document.createElement('span');
        tolLabel.className = 'nb-structured-editor__accent';
        tolLabel.textContent = '\u00b1';
        tolGroup.appendChild(tolLabel);

        const tolInput = document.createElement('input');
        tolInput.type = 'number';
        tolInput.className = 'model-test__value-input';
        tolInput.style.width = '56px';
        tolInput.value = item.tolerance ?? '';
        tolInput.step = 'any';
        tolInput.min = '0';
        tolInput.placeholder = 'tol';
        tolInput.title = 'Tolerance (fraction, e.g. 0.15 = \u00b115%)';
        tolInput.addEventListener('change', () => {
            callbacks.update({ tolerance: tolInput.value !== '' ? parseFloat(tolInput.value) : undefined });
        });
        tolGroup.appendChild(tolInput);
        row.appendChild(tolGroup);

        container.appendChild(row);
    }

    // ─── Last-run hints ──────────────────────────────────────────────────────

    /**
     * Build a small status hint element for an assertion row.
     * Shows pass/fail dot from the last simulation run, if available.
     */
    #getAssertionHint(index) {
        if (!this.#lastRunResults?.assertionResults) return null;

        const result = this.#lastRunResults.assertionResults[index];
        if (!result) return null;

        const hint = document.createElement('span');
        const passed = result.passed;
        hint.className = `test-assertion__status-hint test-assertion__status-hint--${passed ? 'pass' : 'fail'}`;

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = passed ? 'check_circle' : 'cancel';
        hint.appendChild(icon);

        // Build tooltip with details
        const parts = [];
        if (result.message) parts.push(result.message);
        if (this.#lastRunResults.scenario) {
            const sName = this.#lastRunResults.scenario.split('/').pop().replace('.scenario', '');
            parts.push(`Scenario: ${sName}`);
        }
        if (this.#lastRunResults.timestamp) {
            parts.push(`Run: ${new Date(this.#lastRunResults.timestamp).toLocaleString()}`);
        }
        hint.title = parts.join('\n');

        return hint;
    }

    // ─── Autocomplete ───────────────────────────────────────────────────────

    #getNamespaceOptions() {
        const symbols = this.#symbolIndex?.symbols ?? [];
        const seen = new Set();
        const options = [{ value: '__ALL__', label: 'All' }];

        for (const sym of symbols) {
            if (sym.kind === 'namespace' && !seen.has(sym.name)) {
                seen.add(sym.name);
                options.push({ value: sym.name, label: sym.name, token: sym.name });
            }
        }

        return options;
    }

    #variableProvider(value, namespace) {
        const fragment = (value || '').toLowerCase().trim();
        const items = [];
        const seen = new Set();

        const symbols = this.#symbolIndex?.symbols ?? [];
        let currentNamespace = 'Global';

        for (const sym of symbols) {
            if (sym.kind === 'namespace') {
                currentNamespace = sym.name;
                continue;
            }
            if (sym.kind === 'import') continue;

            const symNs = sym.namespace || currentNamespace;
            if (namespace && namespace !== '__ALL__' && symNs !== namespace) continue;

            const name = sym.name;
            if (seen.has(name)) continue;
            seen.add(name);

            if (fragment && !name.toLowerCase().includes(fragment)) continue;

            items.push({
                label: name,
                insertText: name,
                type: sym.kind === 'stock' ? 'stock'
                    : sym.kind === 'parameter' ? 'constant'
                    : 'variable',
                metadata: {
                    namespace: symNs,
                    namespaceId: symNs,
                },
            });
        }

        return items;
    }

    async #ensureModelSymbols() {
        if (!this.#project?.isOpen || !this.#symbolIndex) return;

        for (const nsPath of (this.#project.namespacePaths ?? [])) {
            if (!this.#project.getOpenFile(nsPath)) {
                try { await this.#project.openFile(nsPath); } catch { continue; }
            }
            const nsFile = this.#project.getOpenFile(nsPath);
            const cells = nsFile?.content?.cells ?? [];
            if (cells.length > 0) {
                this.#symbolIndex.rebuildFile(nsPath, cells);
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    #emitChange() {
        this.#onChange?.(this.getData());
    }
}
