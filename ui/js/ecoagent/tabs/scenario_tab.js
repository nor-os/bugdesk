/**
 * scenario_tab.js — the scenario editor, as a workspace tab.
 *
 * A scenario is a parameter-override preset: every archetype's declared
 * params get a per-scenario value input. An empty input ⇒ no override for
 * that param (the baseline default is used at world-build time). Save
 * persists via `scenario_save`; Delete removes the scenario and closes the
 * tab. Ported from the old scenario_editor.js modal — scenarios are now
 * edited in a workspace tab like every other entity.
 *
 * Setting a scenario *active* is a separate concern (the topbar scenario
 * widget) — opening this tab never changes the active scenario.
 */

import { openConfirm } from '../ui/modal.js';
import { toastError } from '../ui/toast.js';
import { esc, mountEditableTitle } from './_util.js';

/** Factory registered with WorkspaceTabs for kind `scenario`. */
export function makeScenarioTab(hostEl, scenarioId, ctx) {
    return new ScenarioTab(hostEl, scenarioId, ctx);
}

class ScenarioTab {
    constructor(hostEl, scenarioId, { eventBus, logger, workspaceTabs, tabId } = {}) {
        this.hostEl = hostEl;
        this.scenarioId = scenarioId;
        this.eventBus = eventBus ?? null;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        this._scenario = null;
        this._archetypes = [];
        this._marketArchetypes = [];
        this._activeId = null;
        this._filterText = '';
        this._filterCategory = 'all';   // 'all' | 'agents' | 'markets'
        // Coalesced autosave — input bursts collapse into one bridge call.
        this._saveTimer = null;
    }

    async mount() {
        await this._load();
        this._render();
    }

    show() {}
    hide() {}
    dispose() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    }

    // A scenario is static config — it does not change on run ticks, so
    // run-driven refreshes stay a no-op. But a `project-changed` (an undo/redo
    // restoring this scenario, or an edit from elsewhere) should re-read +
    // re-render — unless the user is editing here (a pending edit is flushed on
    // blur, so it has already landed by the time focus is outside for a Ctrl+Z).
    async refresh(reason) {
        if (reason !== 'project-changed') return;
        if (this.hostEl?.contains?.(document.activeElement)) return;
        await this._load();
        this._render();
    }

    async _load() {
        try {
            const [list, archs, markets, ccys] = await Promise.all([
                window.pywebview?.api?.scenarios_list?.()         ?? { scenarios: [] },
                window.pywebview?.api?.agents_list?.()        ?? [],
                window.pywebview?.api?.markets_list?.() ?? [],
                window.pywebview?.api?.currencies_list?.() ?? [],
            ]);
            this._scenario = (list?.scenarios || [])
                .find((s) => s.id === this.scenarioId) || null;
            this._activeId = list?.active || null;
            this._archetypes = Array.isArray(archs) ? archs : [];
            this._marketArchetypes = Array.isArray(markets) ? markets : [];
            this._currencies = Array.isArray(ccys) ? ccys : (ccys?.currencies || []);
        } catch (err) {
            this.logger.warn?.('scenario tab load failed', { err });
        }
    }

    _render() {
        if (!this._scenario) {
            this.hostEl.innerHTML = `
                <div class="ea-scenario-tab">
                    <div class="ea-plot__placeholder">Scenario not found.</div>
                </div>`;
            return;
        }
        const s = this._scenario;
        this.hostEl.innerHTML = `
            <div class="ea-scenario-tab">
                <header class="ea-detail-header">
                    <div data-role="title-slot"></div>
                    <span class="ea-save-status" data-role="save-status"></span>
                    <span class="ea-detail-header__spacer"></span>
                    <button type="button" class="ea-btn ea-btn--small" data-action="activate"
                            ${this._activeId === s.id ? 'disabled' : ''}
                            title="Make this the active scenario">
                        <span class="material-symbols-outlined">check_circle</span>
                        ${this._activeId === s.id ? 'Active' : 'Set active'}
                    </button>
                    <button type="button" class="ea-btn ea-btn--small" data-action="popout"
                            title="Pop this scenario tab out into a floating window">
                        <span class="material-symbols-outlined">open_in_new</span>
                        Pop out
                    </button>
                    <button type="button" class="ea-btn ea-btn--small ea-btn--danger" data-action="delete">
                        <span class="material-symbols-outlined">delete</span> Delete
                    </button>
                </header>
                <div class="ea-scenario-tab__body">
                    <section class="ea-scenario-tab__meta">
                        <label class="ea-row">
                            <span>Id</span>
                            <input type="text" data-field="id" value="${esc(s.id)}" disabled>
                        </label>
                        <label class="ea-row">
                            <span>Label</span>
                            <input type="text" data-field="label" value="${esc(s.label || '')}">
                        </label>
                        <label class="ea-row">
                            <span>Description</span>
                            <input type="text" data-field="description"
                                   value="${esc(s.description || '')}"
                                   placeholder="What does this scenario test?">
                        </label>
                        <label class="ea-row" title="Re-denominate the domestic economy for this scenario (e.g. the D-Mark). Leave as project default unless the scenario changes the home currency.">
                            <span>Home currency</span>
                            <select data-field="home_currency">
                                <option value=""${!s.home_currency ? ' selected' : ''}>Use project default</option>
                                ${(this._currencies || []).map((c) => {
                                    const id = esc(c.id);
                                    const lbl = esc(c.label || c.id);
                                    const sel = s.home_currency === c.id ? ' selected' : '';
                                    return `<option value="${id}"${sel}>${id} — ${lbl}</option>`;
                                }).join('')}
                            </select>
                        </label>
                    </section>
                    <section class="ea-scenario-tab__filter"
                             data-role="scen-filter">
                        <input type="search"
                               class="ea-scenario-tab__filter-text"
                               data-role="filter-text"
                               value="${esc(this._filterText || '')}"
                               placeholder="Filter agents / markets / rows…">
                        <div class="ea-scenario-tab__filter-cats"
                             data-role="filter-cats">
                            <button type="button"
                                    class="ea-scenario-tab__filter-cat ${this._filterCategory === 'all' ? 'is-active' : ''}"
                                    data-cat="all">All</button>
                            <button type="button"
                                    class="ea-scenario-tab__filter-cat ${this._filterCategory === 'agents' ? 'is-active' : ''}"
                                    data-cat="agents">Agents</button>
                            <button type="button"
                                    class="ea-scenario-tab__filter-cat ${this._filterCategory === 'markets' ? 'is-active' : ''}"
                                    data-cat="markets">Markets</button>
                        </div>
                    </section>
                    <div class="ea-scenario-tab__sections"
                         title="Each row is one declared param/rule. A non-empty value overrides the baseline default. Blank keeps the baseline.">
                        <h3 class="ea-scenario-tab__section-title"
                            data-section="agents">Agent archetypes</h3>
                        <div class="ea-scenario-tab__archetypes"
                             data-section-body="agents">
                            ${this._archetypes.map((a) =>
                                renderArchetypeSection(a, s.overrides || {})).join('')}
                        </div>
                        <h3 class="ea-scenario-tab__section-title"
                            data-section="markets">Market archetypes</h3>
                        <div class="ea-scenario-tab__markets"
                             data-section-body="markets">
                            ${this._marketArchetypes.map((m) =>
                                renderMarketSection(m, s.market_overrides || {})).join('')
                                || '<div class="ea-plot__placeholder">No market archetypes declared.</div>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.hostEl.querySelector('[data-action="activate"]')
            ?.addEventListener('click', () => this._activate());
        this.hostEl.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._delete());
        this.hostEl.querySelector('[data-action="popout"]')
            ?.addEventListener('click', () => {
                if (this.tabId) this.workspaceTabs?.popOutTab?.(this.tabId);
            });
        // Editable header title — double-click to edit, or click the
        // pencil. Keeps the body's `data-field="label"` input in sync
        // on commit so a save fires through the standard path.
        const titleSlot = this.hostEl.querySelector('[data-role="title-slot"]');
        this._titleCtl?.dispose?.();
        this._titleCtl = mountEditableTitle(titleSlot, {
            value: s.label || s.id,
            placeholder: s.id,
            tag: 'h2',
            onCommit: (next) => {
                const bodyInput = this.hostEl.querySelector('[data-field="label"]');
                if (bodyInput) bodyInput.value = next;
                this._flush();
            },
        });
        this._wireAutosave();
        this._wireFilter();
        // Apply the current filter immediately so a re-render after
        // a save preserves the user's filter state.
        this._applyFilter();
    }

    _wireFilter() {
        const root = this.hostEl;
        const textEl = root.querySelector('[data-role="filter-text"]');
        textEl?.addEventListener('input', () => {
            this._filterText = (textEl.value || '').trim().toLowerCase();
            this._applyFilter();
        });
        root.querySelectorAll('[data-cat]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._filterCategory = btn.dataset.cat || 'all';
                root.querySelectorAll('[data-cat]').forEach((b) =>
                    b.classList.toggle('is-active',
                        b.dataset.cat === this._filterCategory));
                this._applyFilter();
            });
        });
    }

    /** Hide sections that don't match the active category, and within
     *  the visible sections hide rows that don't match the freetext
     *  filter. The freetext matches against the section header (label
     *  + id) AND the per-row param/rule name + baseline value. */
    _applyFilter() {
        const root = this.hostEl;
        const cat = this._filterCategory;
        const q   = this._filterText;
        // Section visibility — category filter.
        root.querySelectorAll('[data-section]').forEach((h) => {
            h.hidden = (cat !== 'all' && cat !== h.dataset.section);
        });
        root.querySelectorAll('[data-section-body]').forEach((b) => {
            b.hidden = (cat !== 'all' && cat !== b.dataset.sectionBody);
        });
        // Per-section + per-row freetext filter.
        const sections = root.querySelectorAll(
            'details.ea-scen-arch, details.ea-scen-market');
        sections.forEach((sec) => {
            // Header haystack — label + id chunks live in summary text.
            const headerText = (sec.querySelector('summary')?.textContent || '')
                .toLowerCase();
            let visibleRowCount = 0;
            sec.querySelectorAll('tbody tr').forEach((tr) => {
                const rowText = tr.textContent.toLowerCase();
                const match = !q || rowText.includes(q) || headerText.includes(q);
                tr.hidden = !match;
                if (match) visibleRowCount += 1;
            });
            // Section visibility — if no rows match and the header
            // doesn't match either, hide the whole archetype.
            const sectionMatch = !q
                || headerText.includes(q)
                || visibleRowCount > 0;
            sec.hidden = !sectionMatch;
        });
    }

    _wireAutosave() {
        const root = this.hostEl;
        // Every editable field — meta inputs + per-archetype param inputs —
        // schedules a save on input and flushes on blur.
        root.querySelectorAll('[data-field], [data-field="value"]').forEach((el) => {
            if (el.disabled) return;
            el.addEventListener('input',  () => this._scheduleSave());
            el.addEventListener('change', () => this._scheduleSave());
            el.addEventListener('blur',   () => this._flush());
        });
    }

    _scheduleSave() {
        this._setSaveStatus('pending');
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flush(), 350);
    }

    async _flush() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        const root = this.hostEl;
        const label = root.querySelector('[data-field="label"]')?.value.trim() || '';
        const description =
            root.querySelector('[data-field="description"]')?.value.trim() || '';
        const home_currency =
            root.querySelector('[data-field="home_currency"]')?.value.trim() || '';
        const overrides        = collectOverrides(root, this._archetypes);
        const market_overrides = collectMarketOverrides(root, this._marketArchetypes);
        try {
            const res = await window.pywebview?.api?.scenario_save?.(
                this.scenarioId, label, description, overrides, market_overrides,
                home_currency,
            );
            if (res?.ok === false) {
                toastError('Save scenario failed', res.error);
                this._setSaveStatus('error');
                return;
            }
        } catch (err) {
            toastError('Save scenario failed', err?.message || String(err));
            this._setSaveStatus('error');
            return;
        }
        this._scenario.label = label;
        this._scenario.description = description;
        this._scenario.overrides = overrides;
        this._scenario.market_overrides = market_overrides;
        this._scenario.home_currency = home_currency || undefined;
        if (label && this.tabId) this.workspaceTabs?.updateTabLabel(this.tabId, label);
        this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        this.workspaceTabs?.notifyChanged?.('scenarios');
        this._setSaveStatus('saved');
    }

    _setSaveStatus(kind) {
        const el = this.hostEl.querySelector('[data-role="save-status"]');
        if (!el) return;
        el.classList.remove('ea-save-status--saved', 'ea-save-status--pending', 'ea-save-status--error');
        if (kind === 'pending') {
            el.textContent = 'Saving…';
            el.classList.add('ea-save-status--pending');
        } else if (kind === 'saved') {
            el.textContent = '✓ Saved';
            el.classList.add('ea-save-status--saved');
        } else if (kind === 'error') {
            el.textContent = '⚠ Save failed';
            el.classList.add('ea-save-status--error');
        } else {
            el.textContent = '';
        }
    }

    async _activate() {
        try {
            const res = await window.pywebview?.api?.scenario_set_active?.(this.scenarioId);
            if (res?.ok === false) {
                toastError('Set active failed', res.error);
                return;
            }
        } catch (err) {
            toastError('Set active failed', err?.message || String(err));
            return;
        }
        this._activeId = this.scenarioId;
        this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        this.workspaceTabs?.notifyChanged?.('scenarios');
        this._render();
    }

    async _delete() {
        const s = this._scenario;
        const ok = await openConfirm({
            title: 'Delete scenario',
            message: `Delete "${s.label || s.id}"? This cannot be undone.`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await window.pywebview?.api?.scenario_delete?.(this.scenarioId);
        } catch (err) {
            toastError('Delete scenario failed', err?.message || String(err));
            return;
        }
        this.eventBus?.emit?.('ecoagent:scenarios:changed', {});
        if (this.tabId) this.workspaceTabs?.closeTab(this.tabId);
    }
}


// ── Per-archetype section ──────────────────────────────────────────────────

function renderArchetypeSection(a, overrides) {
    const archOverrides = overrides[a.archetype] || {};
    const params = a.params || [];
    if (params.length === 0) {
        return `
            <details class="ea-scen-arch" data-archetype="${esc(a.archetype)}">
                <summary class="ea-scen-arch__header">
                    <span class="material-symbols-outlined">group</span>
                    <span class="ea-scen-arch__label">${esc(a.label || a.archetype)}</span>
                    <span class="ea-scen-arch__sub">${esc(a.archetype)}</span>
                    <span class="ea-scen-arch__count">no params</span>
                </summary>
            </details>
        `;
    }
    const overrideCount = params.filter((p) => p.name in archOverrides).length;
    const rows = params
        .map((p) => renderParamRow(a.archetype, p, archOverrides[p.name]))
        .join('');
    return `
        <details class="ea-scen-arch" data-archetype="${esc(a.archetype)}"
                 ${overrideCount > 0 ? 'open' : ''}>
            <summary class="ea-scen-arch__header">
                <span class="material-symbols-outlined">group</span>
                <span class="ea-scen-arch__label">${esc(a.label || a.archetype)}</span>
                <span class="ea-scen-arch__sub">${esc(a.archetype)}</span>
                <span class="ea-scen-arch__count">
                    ${overrideCount}/${params.length} overridden
                </span>
            </summary>
            <table class="ea-scen-arch__params">
                <thead>
                    <tr>
                        <th>Param</th>
                        <th>Type</th>
                        <th>Baseline</th>
                        <th>Override</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </details>
    `;
}

function renderParamRow(archetype, p, overrideValue) {
    const isOverridden = (overrideValue !== undefined);
    const baseline = formatBaseline(p.default);
    const inputCell = paramInput(p, isOverridden ? overrideValue : '');
    return `
        <tr data-archetype="${esc(archetype)}" data-param="${esc(p.name)}"
            ${isOverridden ? 'class="ea-scen-row--overridden"' : ''}>
            <td class="ea-scen-row__name"><code>${esc(p.name)}</code></td>
            <td class="ea-scen-row__type">${esc(p.type || 'any')}</td>
            <td class="ea-scen-row__baseline">${esc(baseline)}</td>
            <td class="ea-scen-row__override">${inputCell}</td>
        </tr>
    `;
}

function paramInput(p, value) {
    const v = (value === undefined || value === null) ? '' : value;
    const placeholder = `(baseline: ${formatBaseline(p.default)})`;
    if (p.type === 'bool') {
        const cur = String(v);
        return `<select class="ea-scen-input" data-field="value">
            <option value=""      ${cur === '' ? 'selected' : ''}>(use baseline)</option>
            <option value="true"  ${(cur === 'true' || v === true) ? 'selected' : ''}>true</option>
            <option value="false" ${(cur === 'false' || v === false) ? 'selected' : ''}>false</option>
        </select>`;
    }
    if (p.type === 'choice') {
        const opts = (p.choices || []).map((c) =>
            `<option value="${esc(c)}" ${v === c ? 'selected' : ''}>${esc(c)}</option>`
        ).join('');
        return `<select class="ea-scen-input" data-field="value">
            <option value="" ${v === '' ? 'selected' : ''}>(use baseline)</option>
            ${opts}
        </select>`;
    }
    const type = (p.type === 'float' || p.type === 'int') ? 'number' : 'text';
    const step = p.type === 'int' ? '1' : (p.step || 'any');
    return `<input class="ea-scen-input" type="${type}" step="${esc(step)}"
                   data-field="value" value="${esc(String(v))}"
                   placeholder="${esc(placeholder)}">`;
}

function formatBaseline(v) {
    if (v == null) return 'None';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
}


// ── Collect overrides from the form ───────────────────────────────────────

function collectOverrides(root, archetypes) {
    const out = {};
    archetypes.forEach((a) => {
        const rows = root.querySelectorAll(
            `tr[data-archetype="${cssEsc(a.archetype)}"][data-param]`);
        const overrides = {};
        rows.forEach((tr) => {
            const pname = tr.dataset.param;
            const input = tr.querySelector('[data-field="value"]');
            if (!input) return;
            const raw = String(input.value ?? '').trim();
            if (raw === '') return;            // empty ⇒ no override
            const p = (a.params || []).find((x) => x.name === pname);
            const coerced = coerceForType(p?.type, raw);
            if (coerced !== undefined) overrides[pname] = coerced;
        });
        if (Object.keys(overrides).length > 0) out[a.archetype] = overrides;
    });
    return out;
}

function coerceForType(t, raw) {
    const s = String(raw).trim();
    if (s === '') return undefined;
    switch (String(t || '').toLowerCase()) {
        case 'float': { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
        case 'int':   { const n = Number(s); return Number.isFinite(n) ? Math.trunc(n) : undefined; }
        case 'bool':  return (s === 'true' || s === '1');
        case 'str':
        case 'choice':
        default:      return s;
    }
}

function cssEsc(s) {
    return (window.CSS?.escape ? window.CSS.escape(String(s)) : String(s).replace(/"/g, '\\"'));
}


// ── Per-market-archetype section ───────────────────────────────────────────

/** Render one collapsible section for a market archetype. Each row
 *  is one rule key declared on the archetype's baseline rules dict.
 *  Override values replace the baseline at world build (via
 *  `_apply_active_scenario_to_markets` on the bridge). */
function renderMarketSection(m, market_overrides) {
    const archOverrides = (market_overrides[m.id] || {}).rules || {};
    const baseRules = (m.rules && typeof m.rules === 'object') ? m.rules : {};
    const ruleKeys = Object.keys(baseRules).sort();
    const instanceCount = Array.isArray(m.instances) ? m.instances.length : 0;
    const overrideCount = Object.keys(archOverrides).length;
    const kindLabel = m.kind || m.market_kind || '';
    if (ruleKeys.length === 0) {
        return `
            <details class="ea-scen-arch ea-scen-market" data-market="${esc(m.id)}">
                <summary class="ea-scen-arch__header">
                    <span class="material-symbols-outlined">storefront</span>
                    <span class="ea-scen-arch__label">${esc(m.label || m.id)}</span>
                    <span class="ea-scen-arch__sub">${esc(m.id)} · ${esc(kindLabel)}</span>
                    <span class="ea-scen-arch__count">no rules declared</span>
                </summary>
            </details>
        `;
    }
    const rows = ruleKeys
        .map((k) => renderRuleRow(m.id, k, baseRules[k], archOverrides[k]))
        .join('');
    return `
        <details class="ea-scen-arch ea-scen-market" data-market="${esc(m.id)}"
                 ${overrideCount > 0 ? 'open' : ''}>
            <summary class="ea-scen-arch__header">
                <span class="material-symbols-outlined">storefront</span>
                <span class="ea-scen-arch__label">${esc(m.label || m.id)}</span>
                <span class="ea-scen-arch__sub">${esc(m.id)} · ${esc(kindLabel)}
                    ${instanceCount > 0 ? ` · ${instanceCount} inst.` : ''}
                </span>
                <span class="ea-scen-arch__count">
                    ${overrideCount}/${ruleKeys.length} overridden
                </span>
            </summary>
            <table class="ea-scen-arch__params">
                <thead>
                    <tr>
                        <th>Rule</th>
                        <th>Type</th>
                        <th>Baseline</th>
                        <th>Override</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </details>
    `;
}

function renderRuleRow(marketId, key, baseline, overrideValue) {
    const isOverridden = (overrideValue !== undefined);
    const type = jsonTypeOf(baseline);
    const baselineText = formatBaseline(baseline);
    const inputCell = ruleInput(type, isOverridden ? overrideValue : '');
    return `
        <tr data-market="${esc(marketId)}" data-rule="${esc(key)}"
            data-rule-type="${esc(type)}"
            ${isOverridden ? 'class="ea-scen-row--overridden"' : ''}>
            <td class="ea-scen-row__name"><code>${esc(key)}</code></td>
            <td class="ea-scen-row__type">${esc(type)}</td>
            <td class="ea-scen-row__baseline">${esc(baselineText)}</td>
            <td class="ea-scen-row__override">${inputCell}</td>
        </tr>
    `;
}

function ruleInput(type, value) {
    const v = (value === undefined || value === null) ? '' : value;
    const display = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    if (type === 'bool') {
        const cur = String(v);
        return `<select class="ea-scen-input" data-field="value">
            <option value=""      ${cur === '' ? 'selected' : ''}>(use baseline)</option>
            <option value="true"  ${(cur === 'true' || v === true) ? 'selected' : ''}>true</option>
            <option value="false" ${(cur === 'false' || v === false) ? 'selected' : ''}>false</option>
        </select>`;
    }
    if (type === 'int' || type === 'float') {
        const step = type === 'int' ? '1' : 'any';
        return `<input class="ea-scen-input" type="number" step="${step}"
                       data-field="value" value="${esc(display)}"
                       placeholder="(use baseline)">`;
    }
    // text + json + everything else as plain text. JSON values get
    // round-tripped through the collector.
    return `<input class="ea-scen-input" type="text"
                   data-field="value" value="${esc(display)}"
                   placeholder="(use baseline)">`;
}

function jsonTypeOf(v) {
    if (v === null || v === undefined) return 'any';
    if (typeof v === 'boolean')        return 'bool';
    if (typeof v === 'number')         return Number.isInteger(v) ? 'int' : 'float';
    if (typeof v === 'string')         return 'str';
    if (Array.isArray(v))              return 'json';
    if (typeof v === 'object')         return 'json';
    return 'any';
}


// ── Collect market overrides from the form ────────────────────────────────

function collectMarketOverrides(root, marketArchetypes) {
    const out = {};
    (marketArchetypes || []).forEach((m) => {
        const rows = root.querySelectorAll(
            `tr[data-market="${cssEsc(m.id)}"][data-rule]`);
        const rules = {};
        rows.forEach((tr) => {
            const key   = tr.dataset.rule;
            const type  = tr.dataset.ruleType || 'str';
            const input = tr.querySelector('[data-field="value"]');
            if (!input) return;
            const raw = String(input.value ?? '').trim();
            if (raw === '') return;        // empty ⇒ no override
            const coerced = coerceRuleValue(type, raw);
            if (coerced !== undefined) rules[key] = coerced;
        });
        if (Object.keys(rules).length > 0) out[m.id] = { rules };
    });
    return out;
}

function coerceRuleValue(type, raw) {
    const s = String(raw).trim();
    if (s === '') return undefined;
    switch (type) {
        case 'float': { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
        case 'int':   { const n = Number(s); return Number.isFinite(n) ? Math.trunc(n) : undefined; }
        case 'bool':  return (s === 'true' || s === '1');
        case 'json': {
            try { return JSON.parse(s); }
            catch { return s; }   // fall back to string
        }
        case 'str':
        default:      return s;
    }
}
