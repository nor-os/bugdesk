/**
 * CellBase — abstract base class for all notebook cell renderers.
 *
 * Each cell renderer is responsible for:
 *   - Rendering its own HTML into the provided container element
 *   - Building a standard cell chrome (toolbar, drag handle, action buttons)
 *   - Exposing getData() to return current cell data
 *   - Cleaning up editors/listeners on dispose()
 *
 * Subclasses implement:
 *   - renderBody(bodyEl, cell, props)  →  async, builds the interactive cell UI
 *   - getData()                        →  returns current cell.data object
 *   - getGeneratedDsl()                →  (optional) returns DSL string for DSL tab
 */

import { markdownToHtml } from './markdown_preview.js';

/**
 * Per-cell-type visual identity — solarized-inspired color palette.
 * Each entry: { icon, primary, bg, border, text }
 */
const CELL_THEMES = {
    'code':              { icon: 'code',               primary: '#268bd2', bg: '#1a2530', border: '#2a5a80', text: '#8ec8f0' },
    'documentation':     { icon: 'article',            primary: '#93a1a1', bg: '#1e1e1e', border: '#4a5456', text: '#b0bec5' },
    'parameter':         { icon: 'tune',               primary: '#e07850', bg: '#2a1e1a', border: '#a05838', text: '#f0b898' },
    'godley':            { icon: 'account_balance',    primary: '#859900', bg: '#1e2515', border: '#607000', text: '#c0d860' },
    'plot':              { icon: 'monitoring',          primary: '#6c71c4', bg: '#1e1e30', border: '#4a4e96', text: '#b0b4e8' },
    'smooth':            { icon: 'show_chart',          primary: '#2aa198', bg: '#1a2928', border: '#2a7a74', text: '#88dcd6' },
    'generator':         { icon: 'waves',              primary: '#cb4b16', bg: '#2c1e15', border: '#9a3a12', text: '#f0a880' },
    'schedule':          { icon: 'calendar_view_week', primary: '#d33682', bg: '#2a1a24', border: '#9a2860', text: '#f088b8' },
    'pid':               { icon: 'speed',              primary: '#6a5acd', bg: '#1e1a30', border: '#4a3fa3', text: '#b0a8e8' },
    'delay':             { icon: 'hourglass_top',      primary: '#26a69a', bg: '#1a2625', border: '#207a72', text: '#80d8d0' },
    'latch':             { icon: 'toggle_on',          primary: '#dc322f', bg: '#2c1a1a', border: '#a02020', text: '#f08080' },
    'time':              { icon: 'schedule',           primary: '#839496', bg: '#1e2122', border: '#4a5052', text: '#b0b8ba' },
    'conditional-switch':{ icon: 'call_split',         primary: '#d4a017', bg: '#2a2415', border: '#a07810', text: '#e8c860' },
    'heading':           { icon: 'title',              primary: '#586e75', bg: 'transparent', border: '#3a4a50', text: '#93a1a1' },
    'model-settings':    { icon: 'settings',           primary: '#5a7d9a', bg: '#1a2028', border: '#3a5570', text: '#90b8d0' },
    'toc':               { icon: 'toc',                primary: '#78909c', bg: '#1c2226', border: '#405a66', text: '#a8c0cc' },
    'data-table':        { icon: 'table_chart',        primary: '#4db6ac', bg: '#1a2826', border: '#2a7a72', text: '#90d8d0' },
    'assumptions':       { icon: 'fact_check',         primary: '#a1887f', bg: '#241e1c', border: '#6a5a52', text: '#c8b8b0' },
    'figure-register':   { icon: 'format_list_numbered', primary: '#7986cb', bg: '#1c1e2c', border: '#4a5090', text: '#b0b8e0' },
    'table-register':    { icon: 'format_list_numbered', primary: '#4fc3f7', bg: '#1a2430', border: '#2a6a90', text: '#90d0f0' },
    'literature':        { icon: 'menu_book',          primary: '#ba68c8', bg: '#241a28', border: '#7a4888', text: '#d8a8e0' },
    'loops':             { icon: 'hub',                primary: '#ff9800', bg: '#2a2215', border: '#a06010', text: '#f0c878' },
    'signal-source':     { icon: 'ssid_chart',         primary: '#4db6ac', bg: '#1a2826', border: '#2a7a72', text: '#90d8d0' },
    'event-timer':       { icon: 'timer',              primary: '#ff7043', bg: '#2a1e18', border: '#a04828', text: '#f0b090' },
    'event-counter':     { icon: 'pin',                primary: '#ab47bc', bg: '#241a28', border: '#7a3488', text: '#d8a0e0' },
    'linear-ramp':       { icon: 'trending_up',        primary: '#66bb6a', bg: '#1a2818', border: '#3a8038', text: '#a8d8a0' },
    'statistics':        { icon: 'query_stats',        primary: '#42a5f5', bg: '#1a2430', border: '#2a6a98', text: '#90c8f0' },
    'stock-viewer':      { icon: 'account_balance_wallet', primary: '#8d6e63', bg: '#252220', border: '#6a4e44', text: '#c8b0a0' },
    'reference':         { icon: 'link',                   primary: '#78909c', bg: '#1c2228', border: '#40565e', text: '#a8c0cc' },
    'stock':             { icon: 'inventory_2',            primary: '#4caf50', bg: '#1a2518', border: '#2e7d32', text: '#a5d6a7' },
    'source-sink':       { icon: 'swap_vert',              primary: '#00897b', bg: '#1a2625', border: '#00695c', text: '#80cbc4' },
    'title-page':        { icon: 'badge',                  primary: '#b58900', bg: '#2a2415', border: '#8a6a10', text: '#e8c860' },
    'glossary':          { icon: 'spellcheck',             primary: '#7e9a6e', bg: '#1c241a', border: '#5a7a4a', text: '#b0d0a0' },
    'dashboard-ref':     { icon: 'dashboard_customize',    primary: '#7c4dff', bg: '#1e1a30', border: '#5a3ab0', text: '#c0a8f0' },
};

/** Get the visual theme for a cell type. Falls back to a neutral gray. */
export function getCellTheme(cellType) {
    return CELL_THEMES[cellType] ?? { icon: 'widgets', primary: '#858585', bg: '#1e1e1e', border: '#3c3c3c', text: '#cccccc' };
}

export class CellBase {
    /** @type {HTMLElement} */
    _container = null;

    /** @type {object} */
    _cell = null;

    /** @type {object} props (callbacks, fileType) */
    _props = null;

    /** @type {object|null} */
    _editorFactory = null;

    /** @type {string} active tab: 'config'|'dsl'|'doc' */
    _activeTab = 'config';

    /** @type {Array<Function>} cleanup disposers */
    _disposers = [];

    /** @type {Function|null} Returns current workspace symbols [{ name, kind, namespace, detail }] */
    _symbolProvider = null;

    /** @type {object|null} Reference to subclass data object for compact doc editing */
    _compactDataRef = null;
    /** @type {boolean} Whether the compact doc editor is active */
    _compactDocEditing = false;
    /** @type {object|null} Monaco markdown editor handle for compact doc */
    _compactDocHandle = null;

    constructor({ eventBus, logger, editorFactory, symbolProvider } = {}) {
        if (new.target === CellBase) throw new Error('CellBase is abstract');
        this.eventBus = eventBus;
        this.log = logger?.createScope?.(this.constructor.name) ?? console;
        this._editorFactory = editorFactory;
        this._symbolProvider = symbolProvider ?? null;
    }

    /**
     * @param {HTMLElement} container
     * @param {{ cell, fileType, onFocus, onChange, onMoveUp, onMoveDown, onDelete, onAddBelow }} props
     */
    async mount(container, props) {
        this._container = container;
        this._cell = props.cell;
        this._props = props;

        // Propagate cell theme CSS variables to the outer .notebook-cell wrapper
        const theme = getCellTheme(props.cell.type);
        container.style.setProperty('--cell-primary', theme.primary);
        container.style.setProperty('--cell-bg', theme.bg);
        container.style.setProperty('--cell-border', theme.border);
        container.style.setProperty('--cell-text', theme.text);

        container.spellcheck = false;
        container.innerHTML = this._buildChrome();
        this._bindChromeEvents();

        // Apply persisted visual states
        if (this._cell.collapsed) this._applyCollapsed(true);
        if (this._cell.excludeFromPrint) this._applyExcludeFromPrint(true);

        const bodyEl = container.querySelector('.cell-body');
        await this.renderBody(bodyEl, props.cell, props);
    }

    /**
     * Mount only the cell body into a container — no chrome, no gutter,
     * no action buttons. Used when opening a cell in a dedicated window.
     */
    async mountBodyOnly(container, props) {
        this._container = container;
        this._cell = props.cell;
        this._props = props;

        const theme = getCellTheme(props.cell.type);
        container.style.setProperty('--cell-primary', theme.primary);
        container.style.setProperty('--cell-bg', theme.bg);
        container.style.setProperty('--cell-border', theme.border);
        container.style.setProperty('--cell-text', theme.text);

        await this.renderBody(container, props.cell, props);
    }

    dispose() {
        this._compactDocHandle?.dispose?.();
        this._compactDocHandle = null;
        this._compactDataRef = null;
        for (const d of this._disposers) {
            if (typeof d === 'function') d();
            else d?.dispose?.();
        }
        this._disposers = [];
    }

    focus() {}

    /** Subclasses must implement */
    async renderBody(bodyEl, cell, props) {
        throw new Error(`${this.constructor.name}.renderBody() not implemented`);
    }

    getData() {
        return { ...this._cell.data };
    }

    getGeneratedDsl() {
        return null; // override in cells that generate DSL
    }

    // ─── Search support ──────────────────────────────────────────────────────

    /**
     * Return plain text content for global notebook search.
     * Default: recursively extract all string values from getData().
     * Override in cells with Monaco editors to return editor content directly.
     * @returns {string}
     */
    getSearchableText() {
        return CellBase._extractStrings(this.getData());
    }

    /**
     * Highlight search matches within this cell.
     * Default implementation uses TreeWalker + <mark> wrapping on .cell-body.
     * Monaco-based cells override to use editor decorations.
     *
     * @param {RegExp|null} query  — compiled regex, or null to clear
     * @param {number} activeOffset — character offset of the "current" match (-1 = none)
     */
    applySearchHighlights(query, activeOffset = -1) {
        this.clearSearchHighlights();
        if (!query) return;

        const body = this._container?.querySelector('.cell-body');
        if (!body) return;

        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
            // Skip nodes inside Monaco editors — those are handled by subclass overrides
            if (walker.currentNode.parentElement?.closest('.monaco-editor')) continue;
            textNodes.push(walker.currentNode);
        }

        // Walk text nodes and wrap matches in <mark>
        let charOffset = 0;
        for (const node of textNodes) {
            const text = node.nodeValue;
            const parts = [];
            let lastIndex = 0;
            query.lastIndex = 0;
            let m;
            while ((m = query.exec(text)) !== null) {
                if (m.index > lastIndex) parts.push(document.createTextNode(text.slice(lastIndex, m.index)));
                const mark = document.createElement('mark');
                mark.className = 'nb-search-match';
                if (charOffset + m.index === activeOffset) mark.classList.add('nb-search-match--active');
                mark.textContent = m[0];
                parts.push(mark);
                lastIndex = m.index + m[0].length;
                if (!query.global) break;
            }
            charOffset += text.length;
            if (parts.length > 0) {
                if (lastIndex < text.length) parts.push(document.createTextNode(text.slice(lastIndex)));
                const frag = document.createDocumentFragment();
                parts.forEach(p => frag.appendChild(p));
                node.parentNode.replaceChild(frag, node);
            } else {
                charOffset += 0; // no change
            }
        }
    }

    /** Remove all search highlight marks from this cell. */
    clearSearchHighlights() {
        const marks = this._container?.querySelectorAll('mark.nb-search-match');
        if (!marks) return;
        for (const mark of marks) {
            const parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize(); // merge adjacent text nodes
        }
    }

    /**
     * Replace text at a specific match within this cell.
     * @param {RegExp} query
     * @param {number} matchIndex — which match (0-based) within this cell to replace
     * @param {string} replacement
     * @returns {boolean} true if replaced
     */
    replaceMatch(query, matchIndex, replacement) {
        return false; // default: not replaceable
    }

    /**
     * Replace all matches within this cell.
     * @param {RegExp} query
     * @param {string} replacement
     * @returns {number} number of replacements made
     */
    replaceAll(query, replacement) {
        return 0; // default: not replaceable
    }

    /** @private */
    static _extractStrings(obj) {
        if (typeof obj === 'string') return obj;
        if (typeof obj === 'number') return String(obj);
        if (Array.isArray(obj)) return obj.map(v => CellBase._extractStrings(v)).filter(Boolean).join('\n');
        if (obj && typeof obj === 'object') return Object.values(obj).map(v => CellBase._extractStrings(v)).filter(Boolean).join('\n');
        return '';
    }

    /**
     * Called after any cell in the notebook changes (add/delete/move/edit).
     * Override in derived cells (TOC, registers, literature) that need to
     * rebuild their content based on sibling cells.
     */
    refreshContent() {}

    /**
     * Called to inject simulation results into visualization cells.
     * Override in PlotCell, DataTableCell, etc.
     * @param {object} results  — { series: { varName: [...] }, time: [...] }
     * @param {{ cached?: boolean }} [opts] — { cached: true } when restoring from disk on startup
     */
    renderResults(results, opts) {}

    // ─── Chrome template ───────────────────────────────────────────────────────

    /**
     * Override to provide tabs for this cell: [{ id, label }]
     * If only one tab (or none), tab bar is hidden.
     */
    _getTabs() {
        return [{ id: 'config', label: 'Config' }];
    }

    /**
     * Override to provide extra action buttons before the standard move/delete buttons.
     * Returns an array of { action, icon, title } descriptors.
     */
    _getExtraActions() {
        return [];
    }

    /**
     * Override to hide standard action buttons.
     * Returns a Set of action names to include: 'open-window', 'toggle-print'.
     * By default all are shown.
     */
    _getStandardActions() {
        return new Set(['open-window', 'toggle-print']);
    }

    _buildChrome() {
        const tabs = this._getTabs();
        const showTabs = tabs.length > 1;
        const typeLabel = this._cell.type.replace(/-/g, ' ');
        const theme = getCellTheme(this._cell.type);
        const cssType = this._cell.type; // e.g. 'smooth', 'generator'

        const tabsHtml = showTabs ? `
            <div class="cell-tabs">
                ${tabs.map(t => `
                    <button class="cell-tab ${t.id === this._activeTab ? 'cell-tab--active' : ''}"
                            data-tab="${t.id}">${t.label}</button>
                `).join('')}
            </div>
        ` : '';

        const extraActionsHtml = this._getExtraActions().map(a => `
            <button class="cell-action" data-action="${a.action}" title="${a.title}">
                <span class="material-symbols-outlined">${a.icon}</span>
            </button>
        `).join('');

        const collapseIcon = this._cell.collapsed ? 'expand_more' : 'expand_less';
        const collapseTitle = this._cell.collapsed ? 'Expand cell' : 'Collapse cell';
        const printIcon = this._cell.excludeFromPrint ? 'print_disabled' : 'print';
        const printTitle = this._cell.excludeFromPrint
            ? 'Include in print/export'
            : 'Exclude from print/export';
        const printActiveClass = this._cell.excludeFromPrint ? ' cell-action--active' : '';

        const stdActions = this._getStandardActions();

        const openWindowHtml = stdActions.has('open-window') ? `
                    <button class="cell-action" data-action="open-window" title="Open in window">
                        <span class="material-symbols-outlined">open_in_new</span>
                    </button>` : '';

        const togglePrintHtml = stdActions.has('toggle-print') ? `
                    <button class="cell-action${printActiveClass}" data-action="toggle-print" title="${printTitle}">
                        <span class="material-symbols-outlined">${printIcon}</span>
                    </button>` : '';

        return `
            <div class="cell-chrome cell-chrome--${cssType}"
                 style="--cell-primary:${theme.primary};--cell-bg:${theme.bg};--cell-border:${theme.border};--cell-text:${theme.text}">
                <div class="cell-gutter">
                    <button class="cell-collapse-toggle" data-action="toggle-collapse" title="${collapseTitle}">
                        <span class="material-symbols-outlined">${collapseIcon}</span>
                    </button>
                    <span class="notebook-cell-drag-handle material-symbols-outlined" title="Drag to reorder">drag_indicator</span>
                    <span class="cell-type-icon material-symbols-outlined">${theme.icon}</span>
                    <span class="cell-type-label">${typeLabel}</span>
                </div>
                <div class="cell-main">
                    ${tabsHtml}
                    <div class="cell-body" data-active-tab="${this._activeTab}"></div>
                </div>
                <div class="cell-actions">
                    ${openWindowHtml}
                    ${togglePrintHtml}
                    ${extraActionsHtml}
                    <button class="cell-action" data-action="move-up"   title="Move up">
                        <span class="material-symbols-outlined">arrow_upward</span>
                    </button>
                    <button class="cell-action" data-action="move-down" title="Move down">
                        <span class="material-symbols-outlined">arrow_downward</span>
                    </button>
                    <button class="cell-action" data-action="delete"    title="Delete cell">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>
            </div>
        `;
    }

    _bindChromeEvents() {
        // Collapse toggle (in gutter)
        const collapseBtn = this._container.querySelector('.cell-collapse-toggle');
        collapseBtn?.addEventListener('mousedown', (e) => e.preventDefault());
        collapseBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleCollapsed();
        });

        // Action buttons
        this._container.querySelectorAll('.cell-action').forEach(btn => {
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                switch (btn.dataset.action) {
                    case 'move-up':      this._props.onMoveUp?.();  break;
                    case 'move-down':    this._props.onMoveDown?.(); break;
                    case 'delete':       this._props.onDelete?.();   break;
                    case 'open-window':  this._props.onOpenInWindow?.(); break;
                    case 'toggle-print': this._toggleExcludeFromPrint(); break;
                    default:             this._onExtraAction?.(btn.dataset.action); break;
                }
            });
        });

        // Tab switching
        this._container.querySelectorAll('.cell-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this._container.querySelectorAll('.cell-tab').forEach(t => t.classList.remove('cell-tab--active'));
                tab.classList.add('cell-tab--active');
                this._setActiveTab(tab.dataset.tab);
            });
        });

        // Focus tracking — focusin for keyboard/tab, click for mouse
        this._container.addEventListener('focusin', () => {
            this._props.onFocus?.();
        });
        this._container.addEventListener('click', () => {
            this._props.onFocus?.();
        });
    }

    _setActiveTab(tabId) {
        this._activeTab = tabId;
        const bodyEl = this._container.querySelector('.cell-body');
        if (bodyEl) bodyEl.dataset.activeTab = tabId;
        this._onTabChanged(tabId);
    }

    /** Override in subclasses to handle tab visibility changes. */
    _onTabChanged(tabId) {}

    /** Public API: switch this cell to a specific tab (if it has it). */
    switchTab(tabId) {
        const tabs = this._getTabs();
        const hasTab = tabs.some(t => t.id === tabId);
        if (!hasTab) return;
        // Update chrome tab UI
        this._container?.querySelectorAll('.cell-tab').forEach(t => {
            t.classList.toggle('cell-tab--active', t.dataset.tab === tabId);
        });
        this._setActiveTab(tabId);
    }

    // ─── Collapse / Print-exclude toggles ──────────────────────────────────────

    _toggleCollapsed() {
        const collapsed = !this._cell.collapsed;
        this._cell.collapsed = collapsed;
        this._applyCollapsed(collapsed);
        this._props?.onChange?.({ ...this._cell.data });
    }

    _applyCollapsed(collapsed) {
        this._container?.classList.toggle('notebook-cell--collapsed', collapsed);
        const btn = this._container?.querySelector('.cell-collapse-toggle');
        if (btn) {
            btn.querySelector('.material-symbols-outlined').textContent =
                collapsed ? 'expand_more' : 'expand_less';
            btn.title = collapsed ? 'Expand cell' : 'Collapse cell';
        }
    }

    _toggleExcludeFromPrint() {
        const excluded = !this._cell.excludeFromPrint;
        this._cell.excludeFromPrint = excluded;
        this._applyExcludeFromPrint(excluded);
        this._props?.onChange?.({ ...this._cell.data });
    }

    _applyExcludeFromPrint(excluded) {
        this._container?.classList.toggle('notebook-cell--no-print', excluded);
        const btn = this._container?.querySelector('[data-action="toggle-print"]');
        if (btn) {
            btn.querySelector('.material-symbols-outlined').textContent =
                excluded ? 'print_disabled' : 'print';
            btn.title = excluded
                ? 'Include in print/export'
                : 'Exclude from print/export';
            btn.classList.toggle('cell-action--active', excluded);
        }
    }

    // ─── Helper: notify parent of data change ─────────────────────────────────
    _notifyChange(data) {
        if (this._cell) this._cell.data = { ...this._cell.data, ...data };
        this._props?.onChange?.({ ...this._cell.data });
    }

    // ─── Helper: create a labeled field row ───────────────────────────────────
    _fieldRow(label, inputHtml, helpText = '') {
        return `
            <div class="cell-field">
                <label class="cell-field-label">${label}</label>
                <div class="cell-field-input">${inputHtml}</div>
                ${helpText ? `<div class="cell-field-help">${helpText}</div>` : ''}
            </div>
        `;
    }

    // ─── Helper: mount inline Monaco editor in a container element ──────────

    /**
     * Create a single-line inline Monaco editor for expression/variable input.
     * Tracks the handle in _disposers automatically.
     *
     * @param {HTMLElement} container  — the container element
     * @param {string} initialValue
     * @param {(value: string) => void} onChange
     * @param {object} [overrides]  — Monaco editor options
     * @returns {{ getValue, setValue, dispose, editor }} editor handle, or null
     */
    _createInlineExpressionEditor(container, initialValue, onChange, overrides = {}) {
        if (!this._editorFactory?.createInlineEditor) return null;

        const handle = this._editorFactory.createInlineEditor(container, initialValue, overrides);
        this._disposers.push(handle.onDidChange(() => onChange(handle.getValue())));
        this._disposers.push(handle);

        this._attachExpressionDblClick(handle, container, onChange);

        return handle;
    }

    /**
     * Attach double-click → expression modal to an inline Monaco editor.
     * Can be called on any editor handle (not just those from _createInlineExpressionEditor).
     *
     * @param {{ getValue, setValue, editor }} handle — editor handle
     * @param {HTMLElement} container — the container element (used for field name & DOM)
     * @param {(value: string) => void} onChange — called when value changes from modal
     * @param {string} [fieldLabel] — explicit label for the modal title
     */
    _attachExpressionDblClick(handle, container, onChange, fieldLabel) {
        const editorDom = handle.editor?.getDomNode?.() ?? container;
        const fieldName = fieldLabel ?? container.dataset?.editorField ?? 'expression';
        const cellId = this._cell?.id ?? '';
        const windowId = `cell-expr-${cellId}-${fieldName}`;

        const onDblClick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const { openExpressionModal } = await import('../../ui/components/expression_modal.js');
            const label = fieldName.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
            const title = `Edit Expression — ${label.charAt(0).toUpperCase() + label.slice(1)}`;
            openExpressionModal({
                windowId,
                initialValue: handle.getValue(),
                title,
                preventMultiline: true,
                onChange: (value) => {
                    if (handle.getValue() !== value) {
                        handle.setValue(value);
                        onChange(value);
                    }
                },
                onAutoSave: (value) => {
                    if (handle.getValue() !== value) {
                        handle.setValue(value);
                        onChange(value);
                    }
                },
                onClose: (value) => {
                    if (handle.getValue() !== value) {
                        handle.setValue(value);
                        onChange(value);
                    }
                },
            });
        };
        editorDom.addEventListener('dblclick', onDblClick);
        this._disposers.push(() => editorDom.removeEventListener('dblclick', onDblClick));
    }

    /**
     * Get flat list of variable names from the symbol provider
     * (for autocomplete dropdowns, NOT for Monaco — Monaco uses its own global provider).
     * @returns {Array<{ name: string, kind: string, namespace?: string, detail?: string }>}
     */
    _getSymbols() {
        return this._symbolProvider?.() ?? [];
    }

    // ─── Compact body helpers ────────────────────────────────────────────────

    /**
     * Build a compact summary view in the cell body.
     * Used by cells that render their full config in the slide-out panel.
     *
     * @param {HTMLElement} bodyEl
     * @param {string} summaryHtml — key-data HTML for the summary line
     * @param {boolean} [withPreview=false] — whether to include a mini preview canvas container
     * @returns {HTMLElement|null} the preview container element, or null
     */
    _buildCompactSummary(bodyEl, summaryHtml, withPreview = false, dataRef = null) {
        this._compactDataRef = dataRef;
        bodyEl.innerHTML = `
            <div data-panel="config" class="cell-compact-body">
                <div class="cell-compact-summary">${summaryHtml}</div>
                ${withPreview ? '<div class="cell-compact-preview"></div>' : ''}
            </div>
            <div data-panel="dsl" hidden>
                <div class="cell-dsl-editor"></div>
            </div>
            ${dataRef ? `<div class="cell-doc-section">
                <div class="cell-doc-preview"></div>
                <div class="cell-doc-editor" hidden></div>
            </div>` : ''}
        `;
        if (dataRef) {
            const docPreview = bodyEl.querySelector('.cell-doc-preview');
            docPreview.addEventListener('click', () => this._enterCompactDocEdit());
            this._renderCompactDocPreview();
        }
        return withPreview ? bodyEl.querySelector('.cell-compact-preview') : null;
    }

    /**
     * Update just the summary HTML inside an existing compact body.
     * @param {string} html
     */
    _updateCompactSummary(html) {
        const el = this._container?.querySelector('.cell-compact-summary');
        if (el) el.innerHTML = html;
    }

    // ─── Compact doc (inline documentation below summary) ──────────────────

    _renderCompactDocPreview() {
        const preview = this._container?.querySelector('.cell-doc-preview');
        if (!preview) return;
        const doc = this._compactDataRef?.doc ?? '';
        if (doc.trim()) {
            preview.innerHTML = markdownToHtml(doc);
        } else {
            preview.innerHTML = '<span class="cell-doc-placeholder">Click to add documentation\u2026</span>';
        }
    }

    _enterCompactDocEdit() {
        if (this._compactDocEditing || !this._compactDataRef) return;
        this._compactDocEditing = true;

        const preview = this._container?.querySelector('.cell-doc-preview');
        const editorContainer = this._container?.querySelector('.cell-doc-editor');
        if (!preview || !editorContainer) return;

        preview.hidden = true;
        editorContainer.hidden = false;

        if (!this._compactDocHandle) {
            this._compactDocHandle = this._editorFactory?.createMarkdownEditor?.(
                editorContainer, this._compactDataRef.doc ?? '');
            if (this._compactDocHandle) {
                this._disposers.push(this._compactDocHandle.onDidChange(() => {
                    this._compactDataRef.doc = this._compactDocHandle.getValue();
                    this._notifyChange({ doc: this._compactDataRef.doc });
                }));
            }
        } else {
            this._compactDocHandle.setValue(this._compactDataRef.doc ?? '');
        }

        this._compactDocHandle?.focus?.();

        const onFocusOut = () => {
            requestAnimationFrame(() => {
                if (!editorContainer.contains(document.activeElement)) {
                    editorContainer.removeEventListener('focusout', onFocusOut);
                    this._exitCompactDocEdit();
                }
            });
        };
        editorContainer.addEventListener('focusout', onFocusOut);
    }

    _exitCompactDocEdit() {
        if (!this._compactDocEditing) return;
        this._compactDocEditing = false;

        if (this._compactDocHandle) {
            this._compactDataRef.doc = this._compactDocHandle.getValue?.() ?? '';
        }

        const preview = this._container?.querySelector('.cell-doc-preview');
        const editorContainer = this._container?.querySelector('.cell-doc-editor');

        if (editorContainer) editorContainer.hidden = true;
        if (preview) {
            preview.hidden = false;
            this._renderCompactDocPreview();
        }
    }

    /**
     * Standard _onTabChanged for compact cells with a DSL tab.
     * Shows/hides panels by data-panel attribute, lazy-mounts DSL viewer.
     * Cells using this must store their DSL handle in this._compactDslHandle.
     */
    _onCompactTabChanged(tabId) {
        const bodyEl = this._container?.querySelector('.cell-body');
        if (!bodyEl) return;
        bodyEl.querySelectorAll('[data-panel]').forEach(p => {
            p.toggleAttribute('hidden', p.dataset.panel !== tabId);
        });
        if (tabId === 'dsl') {
            const container = bodyEl.querySelector('.cell-dsl-editor');
            if (!container) return;
            const dsl = this.getGeneratedDsl();
            if (!this._compactDslHandle) {
                this._compactDslHandle = this._editorFactory?.createDslViewer?.(container, dsl);
            } else {
                this._compactDslHandle.setValue(dsl);
            }
        }
    }
}
