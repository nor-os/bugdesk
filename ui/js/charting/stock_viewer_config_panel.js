/**
 * Stock viewer cell configuration panel — rendered in the slide-out panel.
 *
 * Provides namespace picker, sector picker, and zero-balance toggle.
 * Changes propagate via onChange callback to the StockViewerCell.
 */

/**
 * @param {HTMLElement} container
 * @param {object} binding — from StockViewerCell.getConfigBinding()
 * @param {object} binding.data — mutable cell data { namespace, sector, showZeroBalances }
 * @param {Function} binding.onChange — called after any change
 * @param {Function} binding.symbolProvider — returns current symbol list
 */
export function renderStockViewerConfig(container, binding) {
    const { data, onChange, symbolProvider } = binding;
    container.innerHTML = '';

    const symbols = symbolProvider?.() ?? [];

    // ── Namespace selector ──────────────────────────────────────────────
    const nsSection = _section(container, 'Namespace');

    const namespaces = _getNamespaces(symbols);
    const nsSelect = document.createElement('select');
    nsSelect.className = 'loop-analysis__namespace-select';

    const nsPlaceholder = document.createElement('option');
    nsPlaceholder.value = '';
    nsPlaceholder.textContent = '— all namespaces —';
    nsSelect.appendChild(nsPlaceholder);

    for (const ns of namespaces) {
        const opt = document.createElement('option');
        opt.value = ns;
        opt.textContent = ns;
        if (ns === data.namespace) opt.selected = true;
        nsSelect.appendChild(opt);
    }
    nsSection.appendChild(nsSelect);

    // ── Sector selector (only for godley-style stocks) ─────────────────
    const sectorSection = _section(container, 'Sector (Godley)');

    const sectorSelect = document.createElement('select');
    sectorSelect.className = 'loop-analysis__namespace-select';
    sectorSection.appendChild(sectorSelect);

    const sectorHelp = document.createElement('div');
    sectorHelp.className = 'config-help-text';
    sectorHelp.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;';
    sectorSection.appendChild(sectorHelp);

    function refreshSectors() {
        sectorSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— all stocks (flat list) —';
        sectorSelect.appendChild(placeholder);

        const sectors = _getSectorsForNamespace(symbols, data.namespace);
        for (const s of sectors) {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            if (s === data.sector) opt.selected = true;
            sectorSelect.appendChild(opt);
        }

        const hasSectors = sectors.length > 0;
        sectorSelect.disabled = !hasSectors;
        sectorHelp.textContent = hasSectors
            ? 'Select a Godley sector for balance sheet view'
            : 'No Godley tables — showing simple stocks';
    }

    refreshSectors();

    // ── Zero balances toggle ────────────────────────────────────────────
    const toggleSection = _section(container, 'Display');
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'stock-viewer-config__toggle';
    toggleLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;';

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = data.showZeroBalances;

    const toggleText = document.createElement('span');
    toggleText.textContent = 'Show zero balances';

    toggleLabel.append(toggleInput, toggleText);
    toggleSection.appendChild(toggleLabel);

    // ── Event bindings ──────────────────────────────────────────────────
    nsSelect.addEventListener('change', () => {
        data.namespace = nsSelect.value;
        data.sector = '';
        refreshSectors();
        onChange();
    });

    sectorSelect.addEventListener('change', () => {
        data.sector = sectorSelect.value;
        onChange();
    });

    toggleInput.addEventListener('change', () => {
        data.showZeroBalances = toggleInput.checked;
        onChange();
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

function _getNamespaces(symbols) {
    const nsSet = new Set();
    for (const sym of symbols) {
        if (sym.kind === 'stock' && sym.fileName) {
            const ns = sym.fileName.replace('.namespace', '').split('/').pop();
            if (ns) nsSet.add(ns);
        }
    }
    return [...nsSet].sort();
}

function _getSectorsForNamespace(symbols, namespace) {
    const sectorSet = new Set();
    for (const sym of symbols) {
        if (sym.kind !== 'stock') continue;
        if (namespace) {
            const ns = sym.fileName?.replace('.namespace', '').split('/').pop();
            if (ns !== namespace) continue;
        }
        const match = sym.name?.match(/^([^:]+)::/);
        if (match) sectorSet.add(match[1]);
    }
    return [...sectorSet].sort();
}
