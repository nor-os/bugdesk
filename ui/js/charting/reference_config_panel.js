/**
 * Reference cell configuration panel — rendered in the slide-out panel.
 *
 * Two-level source selection:
 *   1. Source type: Model (namespace) or Scenario
 *   2. Model → namespace picker; Scenario → scenario picker
 *   3. Mode: all / single cell
 *   4. Cell picker (single mode only)
 *
 * Model sources expose: heading, documentation, parameter cells.
 * Scenario sources expose: heading, documentation, plot cells.
 *
 * Changes propagate via onChange callback to the ReferenceCell.
 */

/** Allowed cell types for the single-cell picker, per source type. */
const PICKABLE_MODEL_TYPES    = new Set(['heading', 'documentation']);
const PICKABLE_SCENARIO_TYPES = new Set(['heading', 'documentation', 'plot']);

/** Cell types included in "all" mode rendering, per source type. */
const ALL_MODEL_TYPES    = new Set(['heading', 'documentation', 'parameter']);
const ALL_SCENARIO_TYPES = new Set(['heading', 'documentation', 'plot']);

/**
 * @param {HTMLElement} container
 * @param {object} binding — from ReferenceCell.getConfigBinding()
 */
export function renderReferenceConfig(container, binding) {
    const { sourceType, namespace, scenario, cellId, mode, project, onChange } = binding;

    container.innerHTML = '';

    const namespacePaths = project?.namespacePaths ?? [];
    const scenarioPaths  = project?.scenarioPaths  ?? [];

    let currentSourceType = sourceType || 'model';
    let currentNamespace  = namespace  || '';
    let currentScenario   = scenario   || '';
    let currentCellId     = cellId     || '';
    let currentMode       = mode       || 'all';

    // ── Source type selector ─────────────────────────────────────────────
    const sourceSection = _section(container, 'Source Type');
    const sourceSelect  = _select(sourceSection, [
        { value: 'model',    label: 'Model (namespace)' },
        { value: 'scenario', label: 'Scenario' },
    ], currentSourceType);

    // ── Namespace selector (model) ───────────────────────────────────────
    const nsSection = _section(container, 'Namespace');
    const nsSelect  = _selectFromPaths(nsSection, namespacePaths, '.namespace', currentNamespace);
    nsSection.style.display = currentSourceType === 'model' ? '' : 'none';

    // ── Scenario selector (scenario) ─────────────────────────────────────
    const scSection = _section(container, 'Scenario');
    const scSelect  = _selectFromPaths(scSection, scenarioPaths, '.scenario', currentScenario);
    scSection.style.display = currentSourceType === 'scenario' ? '' : 'none';

    // ── Mode selector ────────────────────────────────────────────────────
    const modeSection = _section(container, 'Reference Mode');
    const modeSelect  = _select(modeSection, [
        { value: 'cell', label: 'Single cell' },
        { value: 'all',  label: currentSourceType === 'model' ? 'Entire namespace' : 'All documentation' },
    ], currentMode);

    // ── Cell selector (single mode) ──────────────────────────────────────
    const cellSection = _section(container, 'Cell');
    const cellHelp    = document.createElement('div');
    cellHelp.className = 'config-help-text';
    cellHelp.textContent = _cellHelpText(currentSourceType);
    cellSection.appendChild(cellHelp);

    const cellSelect = document.createElement('select');
    cellSelect.className = 'loop-analysis__namespace-select';
    cellSection.appendChild(cellSelect);
    cellSection.style.display = currentMode === 'cell' ? '' : 'none';

    // ── Populate cell picker ─────────────────────────────────────────────
    async function refreshCells() {
        cellSelect.innerHTML = '';
        _placeholder(cellSelect, '— select cell —');

        const sourceName = currentSourceType === 'model' ? currentNamespace : currentScenario;
        if (!sourceName || !project) return;

        const cells = currentSourceType === 'model'
            ? await _loadCells(project, namespacePaths, sourceName, '.namespace')
            : await _loadCells(project, scenarioPaths,  sourceName, '.scenario');
        if (!cells) return;

        const pickable = currentSourceType === 'model' ? PICKABLE_MODEL_TYPES : PICKABLE_SCENARIO_TYPES;
        const filtered = cells.filter(c => pickable.has(c.type));

        for (const c of filtered) {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = _cellLabel(c);
            if (c.id === currentCellId) opt.selected = true;
            cellSelect.appendChild(opt);
        }
    }

    const sourceName = currentSourceType === 'model' ? currentNamespace : currentScenario;
    if (sourceName) refreshCells();

    // ── Emit changes ─────────────────────────────────────────────────────
    function emit() {
        onChange({
            sourceType: currentSourceType,
            namespace:  currentSourceType === 'model'    ? currentNamespace : '',
            scenario:   currentSourceType === 'scenario' ? currentScenario  : '',
            cellId:     currentCellId,
            mode:       currentMode,
        });
    }

    // ── Event bindings ───────────────────────────────────────────────────
    sourceSelect.addEventListener('change', () => {
        currentSourceType = sourceSelect.value;
        nsSection.style.display = currentSourceType === 'model'    ? '' : 'none';
        scSection.style.display = currentSourceType === 'scenario' ? '' : 'none';
        // Update "all" mode label
        const allOpt = modeSelect.querySelector('option[value="all"]');
        if (allOpt) allOpt.textContent = currentSourceType === 'model' ? 'Entire namespace' : 'All documentation';
        cellHelp.textContent = _cellHelpText(currentSourceType);
        currentCellId = '';
        refreshCells();
        emit();
    });

    nsSelect.addEventListener('change', () => {
        currentNamespace = nsSelect.value;
        currentCellId = '';
        refreshCells();
        emit();
    });

    scSelect.addEventListener('change', () => {
        currentScenario = scSelect.value;
        currentCellId = '';
        refreshCells();
        emit();
    });

    modeSelect.addEventListener('change', () => {
        currentMode = modeSelect.value;
        cellSection.style.display = currentMode === 'cell' ? '' : 'none';
        emit();
    });

    cellSelect.addEventListener('change', () => {
        currentCellId = cellSelect.value;
        emit();
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _section(parent, title) {
    const section = document.createElement('div');
    section.className = 'config-section';

    const header = document.createElement('div');
    header.className = 'config-section-header';
    header.textContent = title;
    section.appendChild(header);

    parent.appendChild(section);
    return section;
}

function _placeholder(selectEl, text) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = text;
    selectEl.appendChild(opt);
}

function _select(parent, options, currentValue) {
    const select = document.createElement('select');
    select.className = 'loop-analysis__namespace-select';
    for (const { value, label } of options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (value === currentValue) opt.selected = true;
        select.appendChild(opt);
    }
    parent.appendChild(select);
    return select;
}

/** Build a <select> from file paths, extracting the display name by stripping a suffix. */
function _selectFromPaths(parent, paths, suffix, currentName) {
    const select = document.createElement('select');
    select.className = 'loop-analysis__namespace-select';

    _placeholder(select, `— select ${suffix.replace('.', '')} —`);

    for (const p of paths) {
        const name = _pathToName(p, suffix);
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === currentName) opt.selected = true;
        select.appendChild(opt);
    }
    parent.appendChild(select);
    return select;
}

function _pathToName(path, suffix) {
    const filename = path.split('/').pop();
    return filename.replace(new RegExp(`\\${suffix}$`), '');
}

async function _loadCells(project, paths, name, suffix) {
    const path = paths.find(p => p.endsWith(`${name}${suffix}`)) ?? `${name}${suffix}`;

    let openFile = project.getOpenFile(path);
    if (!openFile) {
        try {
            await project.openFile(path);
            openFile = project.getOpenFile(path);
        } catch {
            return null;
        }
    }

    // Namespace files use `cells`, scenario files use `documentationCells`
    const content = openFile?.content;
    return content?.cells ?? content?.documentationCells ?? null;
}

function _cellLabel(cell) {
    if (cell.type === 'heading') {
        const indent = '\u00A0\u00A0'.repeat((cell.data?.level ?? 1) - 1);
        return `${indent}[H${cell.data?.level ?? 1}] ${cell.data?.title ?? ''}`;
    }
    if (cell.type === 'documentation') {
        const preview = (cell.data?.source ?? '').slice(0, 60).replace(/\n/g, ' ');
        return `\uD83D\uDCC4 ${preview || '(empty)'}`;
    }
    if (cell.type === 'plot') {
        const name = cell.data?.subplots?.[0]?.displayName
            || cell.data?.displayName
            || '(untitled plot)';
        return `\uD83D\uDCC8 ${name}`;
    }
    return `${cell.type}: ${cell.id}`;
}

function _cellHelpText(sourceType) {
    return sourceType === 'model'
        ? 'Select a heading or documentation cell from the namespace'
        : 'Select a heading, documentation, or plot cell from the scenario';
}
