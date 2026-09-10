/**
 * Settings Page
 * Location: ui/pages/settings_page.js
 *
 * Full-page settings editor accessible via the cogwheel icon in the left toolbar.
 * Renders a category sidebar (in fixed-200) and a scrollable settings form.
 * Changes apply immediately and persist to localStorage.
 */

import { PageBase } from '../base/page_base.js';
import {
    getSetting,
    setSetting,
    getCategories,
    getSettingsByCategory,
    getSchema,
    getDefaultValue,
    resetCategory,
    resetAllSettings,
} from '../../core/settings.js';
import { VISIBLE_SETTINGS } from '../../core/settings.js';
import { installOverlayScrollbar } from '../utils/overlay_scrollbar.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 400;

// ─── SettingsPage ────────────────────────────────────────────────────────────

export class SettingsPage extends PageBase {
    constructor({ eventBus, dataManager, notificationCenter, logger,
                  embedded = false, categories = null, bridgeApi = null } = {}) {
        super({ eventBus, dataManager, notificationCenter, logger });
        this.container = null;
        this._mounted = false;
        this._busSubscriptions = [];
        // `embedded` renders the sidebar + content as a self-contained
        // two-pane layout inside `container` (a WM tile content slot)
        // instead of the legacy global #fixed-200-settings / #settings-page
        // elements. `categories` is an optional allow-list of category ids
        // (preserves order) so a host can surface a curated subset without
        // mutating the shared schema. `bridgeApi` backs the handful of
        // settings that live in the project store (config/app_settings.json)
        // rather than localStorage — see _bridgeDefs.
        this._embedded = !!embedded;
        this._categoryFilter = Array.isArray(categories) ? categories : null;
        this._bridgeApi = bridgeApi;
        this._sidebarHost = null;
        this._contentHost = null;
        this._activeCategory = (this._categoryFilter && this._categoryFilter[0]) || 'general';
        this._controlRefs = new Map();       // path -> { el, type }
        this._debounceTimers = new Map();     // path -> timerId
        this._sidebarEl = null;
        this._contentEl = null;
        this._searchQuery = '';
    }

    /** Categories to show — the allow-list (in its given order) or all. */
    /**
     * Rows this application actually honours.
     *
     * The inherited schema describes a different app; BugDesk reads a fraction
     * of it. Everything else is a control that changes nothing, and there is no
     * way for the user to tell which is which by looking. See VISIBLE_SETTINGS
     * in core/settings.js, and the test that keeps it honest.
     */
    _visibleSettings(categoryId) {
        return getSettingsByCategory(categoryId).filter((d) => VISIBLE_SETTINGS.has(d.path));
    }

    _visibleCategories() {
        const all = getCategories();
        const scoped = this._categoryFilter
            ? this._categoryFilter.map(id => all.find(c => c.id === id)).filter(Boolean)
            : all;
        // A category whose every row was inherited-and-unread is an empty page
        // with a heading — worse than not offering it, because the user goes
        // looking for what must be in there.
        return scoped.filter((c) => this._visibleSettings(c.id).length > 0);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    mount(container) {
        this.container = container || document.getElementById('settings-page');
        this._initPromise = this.init();
        this._mounted = true;
    }

    async init() {
        if (this._embedded) this._buildEmbeddedScaffold();
        this._buildSidebar();
        this._buildContent();
        this._wireEvents();
    }

    /** Embedded mode: split the single host into a sidebar pane + a
     *  content pane so the page is fully self-contained (no dependency
     *  on the legacy global settings DOM). */
    _buildEmbeddedScaffold() {
        if (!this.container) return;
        this.container.classList.add('settings-page', 'settings-page--embedded');
        this.container.innerHTML = `
            <aside class="settings-page__sidebar"></aside>
            <div class="settings-page__pane"></div>`;
        this._sidebarHost = this.container.querySelector('.settings-page__sidebar');
        this._contentHost = this.container.querySelector('.settings-page__pane');
    }

    show() {
        if (this.container) this.container.style.display = '';
        this._refreshControls();
    }

    hide() {
        if (this.container) this.container.style.display = 'none';
    }

    onActivated() {
        this.show();
        this.#emitBreadcrumb();
    }

    onDeactivated() {
        this.hide();
    }

    dispose() {
        // attachSelect appends its popup to <body>; without this it outlives
        // the page that opened it.
        for (const h of this._selectHandles || []) { try { h.destroy(); } catch { /* gone */ } }
        this._selectHandles = [];
        for (const unsub of this._busSubscriptions) unsub();
        this._busSubscriptions = [];
        for (const timerId of this._debounceTimers.values()) clearTimeout(timerId);
        this._debounceTimers.clear();
        this._controlRefs.clear();
        super.dispose();
    }

    // ── Sidebar (rendered into #fixed-200-settings) ──────────────────────────

    _buildSidebar() {
        this._sidebarEl = this._sidebarHost || document.getElementById('fixed-200-settings');
        if (!this._sidebarEl) return;

        const categories = this._visibleCategories();
        const navItems = categories.map(cat => {
            const selectedClass = cat.id === this._activeCategory ? ' selected' : '';
            return `<div class="tree-item${selectedClass}" data-category="${cat.id}">
                <span class="tree-item__icon"><span class="material-symbols-outlined">${cat.icon}</span></span>
                <span class="tree-item__label">${cat.label}</span>
            </div>`;
        }).join('');

        this._sidebarEl.innerHTML = `
            <header class="fixed-panel-header">
                <span class="material-symbols-outlined">settings</span>
                <span>Settings</span>
            </header>
            <div class="sidebar-controls">
                <span class="material-symbols-outlined sidebar-search-icon">search</span>
                <input type="search" class="data-page__search"
                       placeholder="Filter settings\u2026" autocomplete="off" spellcheck="false" />
            </div>
            <div class="sidebar-body">
                <div class="tree-view">
                    ${navItems}
                </div>
            </div>`;

        // Overlay scrollbar on sidebar body
        const sidebarBody = this._sidebarEl.querySelector('.sidebar-body');
        if (sidebarBody) installOverlayScrollbar(sidebarBody, { orientation: 'vertical', watchSubtree: true });
    }

    // ── Main content area ────────────────────────────────────────────────────

    _buildContent() {
        const host = this._contentHost || this.container;
        if (!host) return;
        // Embedded mode keeps the wrapper's flex-row class set by the
        // scaffold; only the legacy single-host path owns the wrapper class.
        if (!this._embedded) host.className = 'settings-page';
        host.innerHTML = '<div class="settings-page__content"><div class="settings-page__content-inner"></div></div>';
        this._contentEl = host.querySelector('.settings-page__content-inner');
        this._renderCategory(this._activeCategory);
    }

    // ── Render a category ────────────────────────────────────────────────────

    _renderCategory(categoryId) {
        if (!this._contentEl) return;
        this._controlRefs.clear();

        const categories = this._visibleCategories();
        const cat = categories.find(c => c.id === categoryId);
        if (!cat) return;

        const settings = this._visibleSettings(categoryId);

        // Group settings by their group field
        const groups = new Map();
        for (const def of settings) {
            const groupName = def.group || 'General';
            if (!groups.has(groupName)) groups.set(groupName, []);
            groups.get(groupName).push(def);
        }

        let html = `
            <div class="settings-page__header">
                <div class="settings-page__header-info">
                    <h2 class="settings-page__title">${cat.label}</h2>
                    <p class="settings-page__description">${cat.description}</p>
                </div>
                <button class="settings-page__reset-btn" data-action="reset-category" data-category="${categoryId}" type="button">
                    <span class="material-symbols-outlined">restart_alt</span>
                    <span>Reset</span>
                </button>
            </div>`;

        for (const [groupName, groupSettings] of groups) {
            html += `<div class="settings-page__group">
                <h3 class="settings-page__group-title">${groupName}</h3>`;
            for (const def of groupSettings) {
                html += this._renderSettingRow(def);
            }
            html += '</div>';
        }

        // Project-store (bridge-backed) settings for this category, if any.
        html += this._renderBridgeGroups(categoryId);

        this._contentEl.innerHTML = html;
        this._hydrateControls();
        this._hydrateBridgeControls(categoryId);
    }

    // ── Render search results ────────────────────────────────────────────────

    _renderSearchResults(query) {
        if (!this._contentEl) return;
        this._controlRefs.clear();

        const schema = getSchema();
        const categories = this._visibleCategories();
        const catMap = new Map(categories.map(c => [c.id, c]));
        const visibleIds = new Set(categories.map(c => c.id));
        const lowerQuery = query.toLowerCase();

        // Filter matching settings — only within the visible categories so
        // an allow-list host never surfaces hidden (e.g. legacy) settings.
        const matches = [];
        for (const [path, def] of Object.entries(schema)) {
            if (!visibleIds.has(def.category)) continue;
            if (!VISIBLE_SETTINGS.has(path)) continue;
            const searchable = `${def.label} ${def.description} ${def.group} ${path}`.toLowerCase();
            if (searchable.includes(lowerQuery)) {
                matches.push({ path, ...def });
            }
        }

        if (matches.length === 0) {
            this._contentEl.innerHTML = `
                <div class="settings-page__no-results">
                    <span class="material-symbols-outlined">search_off</span>
                    <p>No settings matching "${query}"</p>
                </div>`;
            return;
        }

        let html = `<div class="settings-page__search-results">
            <p class="settings-page__search-header">${matches.length} result${matches.length !== 1 ? 's' : ''} for "${query}"</p>`;

        // Group results by category for readability
        const grouped = new Map();
        for (const def of matches) {
            if (!grouped.has(def.category)) grouped.set(def.category, []);
            grouped.get(def.category).push(def);
        }

        for (const [catId, defs] of grouped) {
            const cat = catMap.get(catId);
            html += `<div class="settings-page__group">
                <h3 class="settings-page__group-title">${cat?.label || catId}</h3>`;
            for (const def of defs) {
                html += this._renderSettingRow(def);
            }
            html += '</div>';
        }

        html += '</div>';
        this._contentEl.innerHTML = html;
        this._hydrateControls();
    }

    // ── Render a single setting row ──────────────────────────────────────────

    _renderSettingRow(def) {
        const currentValue = getSetting(def.path);
        const isModified = !this._isDefault(def.path, currentValue);
        const modifiedClass = isModified ? ' settings-page__setting--modified' : '';
        const isColorList = def.type === 'colorList';
        const extraClass = isColorList ? ' settings-page__setting--color-list' : '';

        return `<div class="settings-page__setting${modifiedClass}${extraClass}" data-path="${def.path}">
            <div class="settings-page__setting-info">
                <label class="settings-page__setting-label">${def.label}</label>
                <span class="settings-page__setting-desc">${def.description}</span>
            </div>
            <div class="settings-page__setting-control">
                ${this._renderControl(def, currentValue)}
            </div>
        </div>`;
    }

    // ── Render individual control by type ─────────────────────────────────────

    _renderControl(def, value) {
        switch (def.type) {
            case 'boolean':
                return this._renderToggle(def.path, value);
            case 'select':
                return this._renderSelect(def.path, value, def.options);
            case 'number':
                return this._renderNumber(def.path, value, def);
            case 'text':
                return this._renderText(def.path, value, def);
            case 'colorList':
                return this._renderColorList(def.path, value);
            case 'action':
                return this._renderAction(def);
            default:
                return `<span>${String(value)}</span>`;
        }
    }

    /**
     * A settings row that is a BUTTON, not a value.
     *
     * Some settings are lists of records rather than a scalar — a roster of
     * collaborators, say — and no scalar control can edit one. Rather than teach
     * this page every such shape, the row opens the editor that owns it:
     * `{ type: 'action', buttonLabel, onClick }`. The schema entry keeps the
     * label, description and category so it is still findable by search and
     * still sits under the right heading.
     */
    _renderAction(def) {
        return `<button class="ea-btn settings-action" data-action="setting-action"
                        data-path="${def.path}" type="button">${
            def.icon ? `<span class="material-symbols-outlined">${def.icon}</span> ` : ''
        }${def.buttonLabel || 'Open…'}</button>`;
    }

    _renderToggle(path, value) {
        const onClass = value ? ' settings-toggle--on' : '';
        return `<button class="settings-toggle${onClass}" data-control="toggle" data-path="${path}"
                    role="switch" aria-checked="${!!value}" tabindex="0" type="button"></button>`;
    }

    /**
     * A choice control, replaced after render by the app's own (see
     * ticketdesk/select_field.js's `attachSelect`).
     *
     * A bare `<select>` is drawn by the BROWSER, so it ignores the app's tokens
     * entirely — a light popup over a dark UI on most platforms — and it was the
     * one control on this page that did not look like the app it is part of.
     * The `<select>` is still what gets rendered, because attachSelect keeps it
     * as the value carrier: `data-control`/`data-path` survive onto a hidden
     * input, so `_hydrateControls` and the change wiring below need no
     * knowledge of any of this.
     */
    _renderSelect(path, value, options) {
        const opts = (options || []).map(opt => {
            const selected = opt.value === value ? ' selected' : '';
            return `<option value="${opt.value}"${selected}>${opt.label}</option>`;
        }).join('');
        return `<select class="settings-select" data-control="select" data-path="${path}"
                        data-enhance="select">${opts}</select>`;
    }

    _renderNumber(path, value, def) {
        const min = def.min !== undefined ? ` min="${def.min}"` : '';
        const max = def.max !== undefined ? ` max="${def.max}"` : '';
        const step = def.step !== undefined ? ` step="${def.step}"` : '';
        return `<input type="number" class="settings-number" data-control="number" data-path="${path}"
                    value="${value ?? ''}"${min}${max}${step} />`;
    }

    _renderText(path, value, def) {
        const displayValue = value === null || value === undefined ? '' : value;
        const placeholder = def.placeholder ? ` placeholder="${def.placeholder}"` : '';
        return `<input type="text" class="settings-text-input" data-control="text" data-path="${path}"
                    value="${displayValue}"${placeholder} />`;
    }

    _renderColorList(path, value) {
        const colors = Array.isArray(value) ? value : [];
        const swatches = colors.map((color, idx) =>
            `<div class="settings-color-swatch" style="background:${color}" data-control="color" data-path="${path}" data-index="${idx}">
                <input type="color" class="settings-color-swatch__input" value="${color}" tabindex="-1" />
                <button class="settings-color-swatch__remove" data-action="remove-color" data-path="${path}" data-index="${idx}" type="button">&times;</button>
            </div>`
        ).join('');

        return `<div class="settings-color-list" data-control="colorList" data-path="${path}">
            <div class="settings-color-list__swatches">
                ${swatches}
                <button class="settings-color-list__add-btn" data-action="add-color" data-path="${path}" type="button">+</button>
            </div>
        </div>`;
    }

    // ── Hydrate controls (store refs after innerHTML) ─────────────────────────

    _hydrateControls() {
        if (!this._contentEl) return;
        this._enhanceSelects();

        // Store refs for all localStorage-backed controls. Bridge-backed
        // controls (data-control="bridge-*") manage their own value and
        // must not be driven through get/setSetting.
        this._contentEl.querySelectorAll('[data-control]:not([data-control^="bridge"])').forEach(el => {
            const path = el.dataset.path;
            if (path) {
                this._controlRefs.set(path, { el, type: el.dataset.control });
            }
        });
    }

    /**
     * Swap every `<select>` on the page for the app's own choice control.
     *
     * Loaded lazily and failing soft: a settings page that will not render
     * because a cosmetic upgrade threw is a worse outcome than a native
     * dropdown. The handles are kept so a re-render can dispose them —
     * attachSelect appends its popup to <body>, which would otherwise outlive
     * the page that opened it.
     */
    _enhanceSelects() {
        for (const h of this._selectHandles || []) { try { h.destroy(); } catch { /* gone */ } }
        this._selectHandles = [];
        const targets = [...this._contentEl.querySelectorAll('select[data-enhance="select"]')];
        if (!targets.length) return;
        import('../../ticketdesk/select_field.js').then(({ attachSelect }) => {
            for (const el of targets) {
                if (!el.isConnected) continue;
                const options = [...el.options].map((o) => ({ value: o.value, label: o.textContent }));
                this._selectHandles.push(attachSelect(el, { options, value: el.value }));
            }
        }).catch((err) => console.warn('[settings] custom dropdowns unavailable', err));
    }

    // ── Bridge-backed settings (project store, not localStorage) ──────────────
    // A settings row can be read/written through the pywebview bridge
    // (`bridgeApi.get_setting`/`set_setting`) instead of localStorage's
    // get/setSetting — for a value the BACKEND owns, not the browser. It
    // renders as an ordinary row within its category but is wired
    // separately (`data-control="bridge-*"`, see `_wireEvents`).
    //
    // Currently empty: the one entry this used to carry (`query_row_cap`,
    // "Max rows from a Python generator" under a Data → Query console
    // group) governed the row cap for the Python query terminal that lived
    // in the legacy BottomPanel's Registries browser. That panel was
    // deleted as dead code (permanently shadowed by ticketdesk's own
    // Console — see ui/js/tiling/page_stubs.js's doc comment), BugDesk's
    // C# backend never implemented the `get_setting`/`set_setting` bridge
    // methods the row depended on, and nothing else in the codebase reads
    // `query_row_cap` — so it was a settings row with no real effect,
    // confusing for a bug tracker with no Python query surface. Removed
    // rather than left in place; the mechanism itself stays (still a
    // reasonable extension point for a future bridge-backed setting) and
    // every call site below already handles zero defs gracefully.
    _bridgeDefs(categoryId) {
        if (!this._bridgeApi) return [];
        const ALL = [];
        return ALL.filter(d => d.category === categoryId);
    }

    _renderBridgeGroups(categoryId) {
        const defs = this._bridgeDefs(categoryId);
        if (!defs.length) return '';
        const groups = new Map();
        for (const d of defs) {
            const g = d.group || 'General';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(d);
        }
        let html = '';
        for (const [groupName, rows] of groups) {
            html += `<div class="settings-page__group"><h3 class="settings-page__group-title">${groupName}</h3>`;
            for (const d of rows) {
                const min = d.min !== undefined ? ` min="${d.min}"` : '';
                const step = d.step !== undefined ? ` step="${d.step}"` : '';
                html += `<div class="settings-page__setting" data-bridge-path="${d.path}">
                    <div class="settings-page__setting-info">
                        <label class="settings-page__setting-label">${d.label}</label>
                        <span class="settings-page__setting-desc">${d.description}</span>
                    </div>
                    <div class="settings-page__setting-control">
                        <input type="number" class="settings-number" data-control="bridge-number" data-path="${d.path}"${min}${step} />
                    </div>
                </div>`;
            }
            html += '</div>';
        }
        return html;
    }

    async _hydrateBridgeControls(categoryId) {
        const defs = this._bridgeDefs(categoryId);
        for (const d of defs) {
            const input = this._contentEl?.querySelector(
                `[data-control="bridge-number"][data-path="${d.path}"]`);
            if (!input) continue;
            let v = d.default;
            try {
                const got = await this._bridgeApi?.get_setting?.(d.path, d.default);
                if (got != null && Number.isFinite(Number(got))) v = Number(got);
            } catch { /* fall back to default */ }
            input.value = v;
        }
    }

    _saveBridgeSetting(def, input) {
        let n = parseInt(input.value, 10);
        if (!Number.isFinite(n) || (def.min != null && n < def.min)) n = def.default;
        input.value = n;
        try { this._bridgeApi?.set_setting?.(def.path, n); } catch { /* best-effort */ }
    }

    // ── Refresh all controls to current values ───────────────────────────────

    _refreshControls() {
        for (const [path, ref] of this._controlRefs) {
            const value = getSetting(path);
            this._updateControl(path, ref, value);
        }
        // Also update modified indicators
        if (this._contentEl) {
            this._contentEl.querySelectorAll('.settings-page__setting').forEach(row => {
                const path = row.dataset.path;
                if (!path) return;
                const value = getSetting(path);
                const isModified = !this._isDefault(path, value);
                row.classList.toggle('settings-page__setting--modified', isModified);
            });
        }
    }

    _updateControl(path, ref, value) {
        const { el, type } = ref;
        switch (type) {
            case 'toggle':
                el.classList.toggle('settings-toggle--on', !!value);
                el.setAttribute('aria-checked', String(!!value));
                break;
            case 'select':
                el.value = value;
                break;
            case 'number':
                el.value = value ?? '';
                break;
            case 'text':
                el.value = value === null || value === undefined ? '' : value;
                break;
            case 'colorList':
                // Rebuild the color list
                this._rebuildColorList(path, value);
                break;
        }
    }

    _rebuildColorList(path, value) {
        if (!this._contentEl) return;
        const container = this._contentEl.querySelector(`.settings-color-list[data-path="${path}"]`);
        if (!container) return;

        const colors = Array.isArray(value) ? value : [];
        const swatchesEl = container.querySelector('.settings-color-list__swatches');
        if (!swatchesEl) return;

        const swatchesHtml = colors.map((color, idx) =>
            `<div class="settings-color-swatch" style="background:${color}" data-control="color" data-path="${path}" data-index="${idx}">
                <input type="color" class="settings-color-swatch__input" value="${color}" tabindex="-1" />
                <button class="settings-color-swatch__remove" data-action="remove-color" data-path="${path}" data-index="${idx}" type="button">&times;</button>
            </div>`
        ).join('');

        swatchesEl.innerHTML = swatchesHtml +
            `<button class="settings-color-list__add-btn" data-action="add-color" data-path="${path}" type="button">+</button>`;
    }

    // ── Event wiring ─────────────────────────────────────────────────────────

    _wireEvents() {
        // Sidebar: category nav clicks
        if (this._sidebarEl) {
            this._sidebarEl.addEventListener('click', (e) => {
                const navItem = e.target.closest('.tree-item');
                if (navItem) {
                    const category = navItem.dataset.category;
                    if (category) this._switchCategory(category);
                    return;
                }

            });

            // Search input
            const searchInput = this._sidebarEl.querySelector('.data-page__search');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    this._handleSearch(e.target.value.trim());
                });
            }
        }

        // Main content: delegated event handling
        if (this.container) {
            this.container.addEventListener('click', (e) => {
                // Toggle switches
                const toggle = e.target.closest('[data-control="toggle"]');
                if (toggle) {
                    const path = toggle.dataset.path;
                    const current = getSetting(path);
                    this._applyChange(path, !current);
                    return;
                }

                // Reset category button
                const resetBtn = e.target.closest('[data-action="reset-category"]');
                if (resetBtn) {
                    this._handleResetCategory(resetBtn.dataset.category);
                    return;
                }

                // Add color button
                const addColorBtn = e.target.closest('[data-action="add-color"]');
                if (addColorBtn) {
                    this._handleAddColor(addColorBtn.dataset.path);
                    return;
                }

                // Remove color button
                const removeColorBtn = e.target.closest('[data-action="remove-color"]');
                if (removeColorBtn) {
                    this._handleRemoveColor(removeColorBtn.dataset.path, parseInt(removeColorBtn.dataset.index, 10));
                    return;
                }

                // A `type: 'action'` row — hand off to whatever owns that
                // setting's editor. Errors are reported, not swallowed: a button
                // that silently does nothing is the worst possible outcome here.
                const actionBtn = e.target.closest('[data-action="setting-action"]');
                if (actionBtn) {
                    const def = getSchema()[actionBtn.dataset.path];
                    if (typeof def?.onClick === 'function') {
                        Promise.resolve(def.onClick()).catch((err) =>
                            console.error('[settings] action failed', actionBtn.dataset.path, err));
                    } else {
                        console.warn('[settings] no onClick for action', actionBtn.dataset.path);
                    }
                    return;
                }
            });

            // Select changes
            this.container.addEventListener('change', (e) => {
                const select = e.target.closest('[data-control="select"]');
                if (select) {
                    this._applyChange(select.dataset.path, select.value);
                    return;
                }

                // Color picker change
                const colorInput = e.target.closest('.settings-color-swatch__input');
                if (colorInput) {
                    const swatch = colorInput.closest('.settings-color-swatch');
                    if (swatch) {
                        this._handleColorChange(swatch.dataset.path, parseInt(swatch.dataset.index, 10), colorInput.value);
                    }
                    return;
                }
            });

            // Number/text inputs (debounced)
            this.container.addEventListener('input', (e) => {
                const numberInput = e.target.closest('[data-control="number"]');
                if (numberInput) {
                    this._debouncedApply(numberInput.dataset.path, () => {
                        const val = parseFloat(numberInput.value);
                        return Number.isFinite(val) ? val : null;
                    });
                    return;
                }

                const textInput = e.target.closest('[data-control="text"]');
                if (textInput) {
                    this._debouncedApply(textInput.dataset.path, () => {
                        const val = textInput.value.trim();
                        return val === '' ? null : val;
                    });
                    return;
                }

                // Bridge-backed number (project store) — debounced save
                // straight through the bridge, never localStorage.
                const bridgeNum = e.target.closest('[data-control="bridge-number"]');
                if (bridgeNum) {
                    const path = bridgeNum.dataset.path;
                    const def = this._bridgeDefs(this._activeCategory).find(d => d.path === path);
                    if (!def) return;
                    const key = `bridge:${path}`;
                    const existing = this._debounceTimers.get(key);
                    if (existing) clearTimeout(existing);
                    this._debounceTimers.set(key, setTimeout(() => {
                        this._debounceTimers.delete(key);
                        this._saveBridgeSetting(def, bridgeNum);
                    }, DEBOUNCE_MS));
                    return;
                }
            });

            // Keyboard: toggle on Enter/Space
            this.container.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    const toggle = e.target.closest('[data-control="toggle"]');
                    if (toggle) {
                        e.preventDefault();
                        const path = toggle.dataset.path;
                        const current = getSetting(path);
                        this._applyChange(path, !current);
                    }
                }
            });
        }

        // Listen for external settings changes (e.g., from other code)
        if (this.eventBus) {
            this._busSubscriptions.push(
                this.eventBus.on('settings:changed', () => {
                    this._refreshControls();
                })
            );
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    _switchCategory(categoryId) {
        if (categoryId === this._activeCategory && !this._searchQuery) return;
        this._activeCategory = categoryId;
        this._searchQuery = '';

        // Clear search input
        if (this._sidebarEl) {
            const searchInput = this._sidebarEl.querySelector('.data-page__search');
            if (searchInput) searchInput.value = '';
        }

        // Update sidebar active state
        this._syncSidebarActive(categoryId);
        this._renderCategory(categoryId);
        this.#emitBreadcrumb();
    }

    /**
     * Emit breadcrumb segments to the top bar via EventBus.
     */
    #emitBreadcrumb() {
        // Embedded in a WM tile? The tile renders its own breadcrumb strip;
        // don't drive the legacy global top-bar breadcrumb.
        if (this._embedded) return;

        const segments = [{ icon: 'settings', label: 'Settings', onClick: null }];

        if (this._activeCategory) {
            const categories = getCategories();
            const cat = categories.find(c => c.id === this._activeCategory);
            if (cat) {
                segments.push({
                    icon: cat.icon || 'category',
                    label: cat.label,
                    onClick: null,
                });
            }
        }

        const actions = [
            {
                icon: 'restart_alt',
                label: 'Reset all to defaults',
                tooltip: 'Reset all settings to defaults',
                onClick: () => this._handleResetAll(),
            },
        ];

        this.eventBus?.emit('topbar:breadcrumb:update', { segments, actions });
    }

    _syncSidebarActive(categoryId) {
        if (!this._sidebarEl) return;
        this._sidebarEl.querySelectorAll('.tree-item').forEach(el => {
            el.classList.toggle('selected', el.dataset.category === categoryId);
        });
    }

    _handleSearch(query) {
        this._searchQuery = query;
        if (!query) {
            // Return to category view
            this._syncSidebarActive(this._activeCategory);
            this._renderCategory(this._activeCategory);
            return;
        }
        // Deselect sidebar
        if (this._sidebarEl) {
            this._sidebarEl.querySelectorAll('.tree-item').forEach(el => {
                el.classList.remove('selected');
            });
        }
        this._renderSearchResults(query);
    }

    _applyChange(path, value) {
        if (value === null && getSetting(path) === null) return;
        setSetting(path, value);
        this._refreshControls();
        this._maybeShowReloadHint(path);
    }

    /** A handful of settings (e.g. `bugdesk.humanName`/`agentName`) are read
     *  once at module-load time by their consumer, so a change here won't
     *  take effect until the next reload — see core/settings.js's doc
     *  comment. Rather than hardcoding those paths here, the schema entry
     *  itself carries `reloadHint: true`; this just surfaces it through the
     *  same `toast:show` event-bus convention every other async-feedback
     *  message in this codebase already uses. */
    _maybeShowReloadHint(path) {
        const def = getSchema()[path];
        if (!def?.reloadHint) return;
        this.eventBus?.emit?.('toast:show', {
            title: 'Reload to apply',
            message: `${def.label} is saved — reload BugDesk for it to take effect.`,
            severity: 'info',
            durationMs: 3000,
        });
    }

    _debouncedApply(path, getValue) {
        const existing = this._debounceTimers.get(path);
        if (existing) clearTimeout(existing);
        this._debounceTimers.set(path, setTimeout(() => {
            this._debounceTimers.delete(path);
            const value = getValue();
            if (value !== null) {
                this._applyChange(path, value);
            }
        }, DEBOUNCE_MS));
    }

    _handleResetCategory(categoryId) {
        if (!categoryId) return;
        resetCategory(categoryId);
        this._renderCategory(categoryId);
    }

    _handleResetAll() {
        resetAllSettings();
        // Re-render current view
        if (this._searchQuery) {
            this._renderSearchResults(this._searchQuery);
        } else {
            this._renderCategory(this._activeCategory);
        }
    }

    _handleAddColor(path) {
        const current = getSetting(path);
        const colors = Array.isArray(current) ? [...current] : [];
        colors.push('#808080');
        this._applyChange(path, colors);
    }

    _handleRemoveColor(path, index) {
        const current = getSetting(path);
        if (!Array.isArray(current) || current.length <= 1) return;
        const colors = [...current];
        colors.splice(index, 1);
        this._applyChange(path, colors);
    }

    _handleColorChange(path, index, newColor) {
        const current = getSetting(path);
        if (!Array.isArray(current)) return;
        const colors = [...current];
        colors[index] = newColor;
        this._applyChange(path, colors);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _isDefault(path, value) {
        const def = getDefaultValue(path);
        if (def === value) return true;
        if (def === null && value === null) return true;
        if (Array.isArray(def) && Array.isArray(value)) {
            return def.length === value.length && def.every((v, i) => v === value[i]);
        }
        return false;
    }
}
