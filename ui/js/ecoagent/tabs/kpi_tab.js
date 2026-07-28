/**
 * kpi_tab.js — the per-country KPI editor, as a workspace tab.
 *
 * The TAB is the authoring surface — there is no separate create
 * dialog. The sidebar's `+ KPI` action creates a placeholder
 * (Untitled-N) and opens this tab; the user does everything in
 * place: rename, pick a template, map its parameters, write the
 * expression in Monaco, set kind / unit / description, delete.
 *
 * Layout (top to bottom):
 *   - Chrome strip: editable title + save-status pill + delete
 *   - Identity card: country / kind / unit / description
 *   - Template card:
 *       "Apply template…" dropdown (grouped by category)
 *       When a template is picked → mapping rows for each parameter
 *       (archetype / market / asset_kind / bus_topic / kpi pickers).
 *       Picking a template fills Monaco with its resolved expression.
 *   - Expression card: single-line Monaco + scope helper sidebar
 */

import { openConfirm } from '../ui/modal.js';
import { toastError } from '../ui/toast.js';
import { esc, mountEditableTitle } from './_util.js';
import { SortableList } from '../../ui/components/sortable_list.js';
import { DEFAULT_KPI_TEMPLATES, KNOWN_BUS_TOPICS } from '../assets/kpi_templates.js';
import {
    PYTHON_HELPERS as KPI_HELPERS,
    stringArgContext as _stringArgContext,
    callContext as _callContext,
    findHelper as _findHelper,
    parseKwargs as _parseKwargs,
} from '../assets/python_query_helpers.js';

export function makeKpiTab(hostEl, kpiId, ctx) {
    return new KpiTab(hostEl, kpiId, ctx);
}

const KPI_KINDS = [
    'rate', 'price', 'volume', 'count',
    'stock', 'flow', 'ratio', 'boolean',
];

/** Substitute `{param}` placeholders in `expr` with the matching
 *  parameter values from `params`. Mirrors `_resolve_params` in
 *  `ecoagent/sim/kpis.py` exactly — kpi-typed params insert bare;
 *  everything else inserts as a single-quoted string literal.
 *  Unmapped placeholders pass through verbatim so the author can see
 *  which binding is missing. */
function resolveParams(expr, params) {
    if (!expr || !params || params.length === 0 || !expr.includes('{')) return String(expr || '');
    const byName = new Map();
    for (const p of params) {
        if (p?.name) byName.set(p.name, p);
    }
    return String(expr).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
        const p = byName.get(name);
        if (!p) return m;
        const v = (p.value != null && p.value !== '') ? p.value : p.default;
        if (v == null || v === '') return m;
        if (p.type === 'kpi') return String(v);
        return "'" + String(v).replace(/'/g, "\\'") + "'";
    });
}

class KpiTab {
    constructor(hostEl, kpiId, { eventBus, logger, workspaceTabs, tabId, autoEditTitle = false } = {}) {
        this.hostEl = hostEl;
        this.kpiId = kpiId;
        this.eventBus = eventBus ?? null;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;
        // One-shot: pop the title widget into edit mode right after
        // first render. The sidebar's `+ KPI` action mints a
        // placeholder ("Untitled KPI") and passes this flag so the
        // user lands on the title input immediately.
        this._autoEditTitle = !!autoEditTitle;

        this._kpi = null;
        this._countries = [];
        this._assetKinds = [];
        this._archetypes = [];
        this._markets = [];
        this._otherKpis = [];
        this._templates = [];

        this._monaco = null;
        this._monacoFallback = null;

        this._saveTimer = null;
        this._saveSeq = 0;
        this._titleCtl = null;
    }

    async mount() {
        await this._load();
        this._render();
        // Commit a pending debounced save the moment focus leaves the editor —
        // an app-level Ctrl+Z (which only reaches the journal when focus is
        // outside) then can't be clobbered by a still-pending autosave. One
        // host-level listener covers every edit surface (fields, params, expr).
        this.hostEl?.addEventListener?.('focusout', (e) => {
            if (!this.hostEl.contains(e.relatedTarget)) this._flushSave();
        });
    }

    show() {}
    hide() {}
    // Live KPI value is read-only on run ticks (no-op). But a project change
    // (undo/redo restoring this KPI, or an edit elsewhere) re-reads + re-renders,
    // unless the user is editing here (pending edits flushed before an undo).
    async refresh(reason) {
        if (reason !== 'project-changed') return;
        if (this.hostEl?.contains?.(document.activeElement)) return;
        await this._load();
        this._render();
    }
    dispose() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        try { this._completionDisposable?.dispose?.(); } catch { /* ignore */ }
        this._completionDisposable = null;
        try { this._monaco?.dispose?.(); } catch { /* ignore */ }
        this._monaco = null;
        try { this._paramsList?.dispose?.(); } catch {}
        this._paramsList = null;
        this._saveSeq++;
    }

    async _load() {
        const api = window.pywebview?.api;
        try {
            const [getRes, listKpis, countries, kinds, archs, mkts, tpls] = await Promise.all([
                api?.kpi_get?.(this.kpiId)        ?? null,
                api?.kpis_list?.()                ?? [],
                api?.countries_list?.()           ?? [],
                api?.assets_list?.()         ?? [],
                api?.agents_list?.()          ?? [],
                api?.market_instances_list?.()             ?? [],
                api?.kpi_templates_list?.()       ?? [],
            ]);
            this._kpi = (getRes && getRes.ok) ? getRes.kpi : null;
            const allKpis = Array.isArray(listKpis) ? listKpis : [];
            this._otherKpis = allKpis.filter((k) => k && k.id !== this.kpiId);
            this._countries  = Array.isArray(countries) ? countries : [];
            this._assetKinds = Array.isArray(kinds)     ? kinds     : [];
            this._archetypes = Array.isArray(archs)     ? archs     : [];
            this._markets    = Array.isArray(mkts)      ? mkts      : [];
            // Bundled fallback: when the bridge endpoint comes back
            // empty (older pywebview proxy didn't expose
            // kpi_templates_list at startup), use the local copy of
            // the library. Keeps the tab usable without a restart.
            const fromBridge = Array.isArray(tpls) ? tpls : [];
            this._templates = fromBridge.length > 0
                ? fromBridge
                : DEFAULT_KPI_TEMPLATES.slice();
        } catch (err) {
            this.logger.warn?.('kpi tab load failed', { err });
            // Pure-bundle fallback if Promise.all rejected outright.
            this._templates = DEFAULT_KPI_TEMPLATES.slice();
        }
    }

    /** Expand every archetype's population into agent ids
     *  (`<archetype>-<i>`) — used by autocomplete inside the
     *  `agent_balance(...)` / `agent_attr(...)` first arg. */
    _allAgentIds() {
        const out = [];
        for (const a of (this._archetypes || [])) {
            const arch = a.archetype;
            const pop = Math.max(0, Number(a.population || 0));
            for (let i = 0; i < pop; i++) out.push(`${arch}-${i}`);
        }
        return out;
    }

    _render() {
        if (!this._kpi) {
            this.hostEl.innerHTML = `
                <div class="ea-kpi-tab">
                    <header class="ea-detail-header">
                        <h2>KPI not found</h2>
                    </header>
                    <div class="ea-kpi-tab__body">
                        <p class="ea-plot__placeholder">
                            No KPI with id <code>${esc(this.kpiId)}</code>.
                            It may have been deleted on disk — close this tab.
                        </p>
                    </div>
                </div>`;
            return;
        }
        const k = this._kpi;

        const countryOpts = [
            `<option value=""${!k.country ? ' selected' : ''}>(global)</option>`,
            ...this._countries.map((c) => {
                const sel = c.id === k.country ? ' selected' : '';
                return `<option value="${esc(c.id)}"${sel}>${esc(c.label || c.id)}</option>`;
            }),
        ].join('');

        const kindOpts = KPI_KINDS.map((kd) =>
            `<option value="${kd}"${kd === k.kind ? ' selected' : ''}>${kd}</option>`).join('');

        // Templates grouped by category for the "Apply template" select.
        const byCat = new Map();
        for (const t of this._templates) {
            const cat = String(t.category || 'Misc');
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(t);
        }
        const templateOpts = [
            '<option value="">— pick a template —</option>',
            ...[...byCat.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([group, list]) => `
                    <optgroup label="${esc(group)}">
                        ${list
                            .slice()
                            .sort((a, b) => String(a.label || a.id)
                                .localeCompare(String(b.label || b.id)))
                            .map((t) =>
                                `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`)
                            .join('')}
                    </optgroup>`),
        ].join('');

        this.hostEl.innerHTML = `
            <div class="ea-kpi-tab">
                <header class="ea-detail-header">
                    <div data-role="title-slot"></div>
                    <span class="ea-save-status" data-role="save-status"></span>
                    <span class="ea-detail-header__spacer"></span>
                    <button type="button"
                            class="ea-btn ea-btn--small ea-btn--danger"
                            data-action="delete"
                            title="Delete this KPI">
                        <span class="material-symbols-outlined">delete</span>
                        Delete
                    </button>
                </header>
                <div class="ea-kpi-tab__body">

                    <section class="ea-card">
                        <h3 class="ea-card__title">Identity</h3>
                        <div class="ea-form-grid">
                            <label class="ea-row" title="Country this KPI is scoped to. Use (global) for cross-country indicators.">
                                <span>Country</span>
                                <select data-field="country">${countryOpts}</select>
                            </label>
                            <label class="ea-row" title="PropertyKind drives the dashboard's axis grouping.">
                                <span>Kind</span>
                                <select data-field="kind">${kindOpts}</select>
                            </label>
                            <label class="ea-row">
                                <span>Unit</span>
                                <input type="text" data-field="unit"
                                       value="${esc(k.unit || '')}"
                                       placeholder="e.g. frac/yr">
                            </label>
                            <label class="ea-row ea-row--wide">
                                <span>Description</span>
                                <textarea data-field="description"
                                          rows="2"
                                          placeholder="What this KPI measures.">${esc(k.description || '')}</textarea>
                            </label>
                        </div>
                    </section>

                    <section class="ea-card" data-card="template">
                        <div class="ea-card__head-row">
                            <h3 class="ea-card__title">Apply template</h3>
                            <select data-field="template" class="ea-kpi-tpl-select">
                                ${templateOpts}
                            </select>
                        </div>
                        <p class="ea-card__hint">
                            Pick a template from the standard library. The
                            template's expression is copied into the
                            Expression card below and its parameters into
                            the Parameters card; you bind each parameter
                            to a concrete entity in your project. Re-pick
                            a template at any time to start over.
                        </p>
                    </section>

                    <section class="ea-card">
                        <h3 class="ea-card__title">Expression</h3>
                        <p class="ea-card__hint">
                            Single-line Python expression — evaluated each
                            tick. References to parameters use
                            <code>{param_name}</code> placeholders;
                            substitution happens at compile time using the
                            values bound in the Parameters card below.
                            Use the scope panel on the right (click to
                            insert). <code>&lt;id&gt;_prev</code> is bound
                            to last tick's value for every KPI in scope.
                        </p>
                        <div class="ea-kpi-expr">
                            <div class="ea-kpi-expr__editor" data-host="expr"></div>
                            <aside class="ea-kpi-expr__scope">
                                <header class="ea-kpi-expr__scope-head">In scope</header>
                                <div class="ea-kpi-expr__scope-body" data-role="scope-list"></div>
                            </aside>
                        </div>
                    </section>

                    <section class="ea-card" data-card="params">
                        <div class="ea-card__head-row">
                            <h3 class="ea-card__title">Parameters</h3>
                            <button type="button" class="ea-btn ea-btn--small"
                                    data-action="add-param"
                                    title="Add a parameter">
                                <span class="material-symbols-outlined">add</span>
                                Add parameter
                            </button>
                        </div>
                        <p class="ea-card__hint" data-role="params-hint">
                            Bind each <code>{name}</code> placeholder used
                            in the expression above. Editing a binding
                            saves immediately and the engine recompiles
                            on the next tick.
                        </p>
                        <div class="ea-kpi-tpl-params" data-role="params-host"></div>
                        <pre class="ea-kpi-resolved" data-role="resolved" hidden></pre>
                    </section>
                </div>
            </div>
        `;

        // Title widget — editable label, autosaves. `autoFocus`
        // starts in edit mode for newly-created KPIs (set via the
        // sidebar's "+ KPI" action) so the user lands on the title
        // input directly. After commit we emit the project-wide
        // `ecoagent:entity:renamed` event so the workspace tab strip,
        // sidebars, and any other surfaces holding the KPI's label
        // refresh in lockstep.
        const titleHost = this.hostEl.querySelector('[data-role="title-slot"]');
        this._titleCtl = mountEditableTitle(titleHost, {
            value: k.label || k.id,
            placeholder: k.id,
            tag: 'h2',
            autoFocus: this._autoEditTitle,
            onCommit: (next) => {
                if (!next) return;
                this._kpi.label = String(next).trim();
                this._scheduleSave();
                this.eventBus?.emit?.('ecoagent:entity:renamed', {
                    kind: 'kpi', entityId: this.kpiId, label: this._kpi.label,
                });
            },
        });
        // One-shot consumed — re-renders during this tab's life
        // shouldn't reopen the title editor.
        this._autoEditTitle = false;

        // Wire identity fields.
        this.hostEl.querySelectorAll('[data-field]').forEach((el) => {
            const f = el.dataset.field;
            if (f === 'template') return;        // template select handled below
            const commit = () => {
                this._kpi[f] = el.value;
                if (f === 'country') {
                    // The KPI-typed param dropdowns filter by scope —
                    // rerender so they reflect the new country.
                    this._renderParams();
                    this._renderScopeList();
                }
                this._scheduleSave();
            };
            el.addEventListener('change', commit);
            el.addEventListener('blur',   commit);
        });
        this.hostEl.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDelete());
        this.hostEl.querySelector('[data-action="add-param"]')
            ?.addEventListener('click', () => this._paramsList?.addItem());

        // Wire template select.
        const tplSel = this.hostEl.querySelector('[data-field="template"]');
        tplSel?.addEventListener('change', () => {
            const tplId = tplSel.value;
            if (!tplId) return;
            const tpl = this._templates.find((t) => t.id === tplId);
            if (!tpl) return;
            // Adopt the template's expression verbatim — `{name}`
            // placeholders stay intact and get resolved at compile
            // time against the params we install below.
            this._kpi.expr = String(tpl.expr || '');
            this._kpi.params = (tpl.params || []).map((p) => ({
                name:    p.name,
                type:    p.type || 'text',
                label:   p.label || p.name,
                hint:    p.hint || '',
                default: p.default ?? '',
                value:   p.default ?? '',
            }));
            // Adopt kind / unit / description from the template.
            if (tpl.kind && KPI_KINDS.includes(tpl.kind)) {
                this._kpi.kind = tpl.kind;
                this.hostEl.querySelector('[data-field="kind"]').value = tpl.kind;
            }
            if (tpl.unit != null) {
                this._kpi.unit = tpl.unit;
                this.hostEl.querySelector('[data-field="unit"]').value = tpl.unit;
            }
            if (tpl.description) {
                this._kpi.description = tpl.description;
                this.hostEl.querySelector('[data-field="description"]').value = tpl.description;
            }
            this._renderParams();
            this._pushExprToEditor();
            this._renderResolvedPreview();
            this._scheduleSave();
            // Reset the select so the user can re-apply the same
            // template (idempotent button feel rather than a sticky
            // selection that's already been consumed).
            tplSel.value = '';
        });

        this._renderParams();
        this._renderScopeList();
        this._mountExpressionEditor();
    }

    /** Render one row per declared parameter on the KPI spec via SortableList.
     *  Drag to reorder, ✕ to remove, +Add parameter in the card head-row.
     *  Each row: name (kbd) · type (select) · value (typed control). */
    _renderParams() {
        const host = this.hostEl.querySelector('[data-role="params-host"]');
        const hint = this.hostEl.querySelector('[data-role="params-hint"]');
        if (!host) return;
        const params = (Array.isArray(this._kpi.params) ? this._kpi.params : [])
            .map((p) => ({ ...p }));

        if (hint) {
            hint.innerHTML = params.length
                ? 'Bind each <code>{name}</code> placeholder used in the '
                  + 'expression above. Drag to reorder, ✕ to remove.'
                : 'No parameters declared. Apply a template above, '
                  + 'or click "Add parameter" to declare one.';
        }

        if (!this._paramsList || !host.contains(this._paramsList.root)) {
            try { this._paramsList?.dispose?.(); } catch {}
            host.innerHTML = '';
            this._paramsList = new SortableList({
                containerId: `kpi-${this.kpiId}-params`,
                items: params,
                allowReorder: true,
                allowRemove: true,
                minItems: 0,
                emptyMessage: 'No parameters — use "Add parameter" above.',
                addButtonText: '',
                createItem: () => ({
                    name: '', type: 'text', label: '', value: '', hint: '',
                }),
                renderItem: (contentEl, item, _i, callbacks) =>
                    this._renderKpiParamRow(contentEl, item, callbacks),
                onChange: (next) => {
                    this._kpi.params = next.map((p) => ({
                        name:        String(p.name || '').trim(),
                        type:        p.type || 'text',
                        label:       p.label || '',
                        hint:        p.hint || '',
                        default:     p.default,
                        placeholder: p.placeholder,
                        value:       p.value ?? '',
                    }));
                    this._renderResolvedPreview();
                    this._scheduleSave();
                },
            });
            host.appendChild(this._paramsList.render());
        } else {
            this._paramsList.setItems(params);
        }
        this._renderResolvedPreview();
    }

    /** One SortableList row for a KPI param. The value control is the
     *  same typed picker built by `_buildParamControl` — archetype /
     *  market / asset_kind / kpi / bus_topic / text. */
    _renderKpiParamRow(contentEl, item, callbacks) {
        contentEl.classList.add('ea-kpi-param-row');

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'sortable-list__input ea-kpi-param-row__name';
        nameInput.value = item.name || '';
        nameInput.placeholder = 'name';
        nameInput.addEventListener('input', () => {
            callbacks.update({ name: nameInput.value });
        });
        nameInput.addEventListener('blur', () => this._flushNow?.());
        contentEl.appendChild(nameInput);

        const typeSel = document.createElement('select');
        typeSel.className = 'ea-kpi-param-row__type';
        for (const t of ['archetype', 'market', 'asset_kind', 'kpi', 'bus_topic', 'text']) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            if (t === (item.type || 'text')) opt.selected = true;
            typeSel.appendChild(opt);
        }
        typeSel.addEventListener('change', () => {
            callbacks.update({ type: typeSel.value, value: '' });
            // Type change rebuilds the value control — re-render via
            // setItems to swap the picker for the new type.
            this._paramsList?.setItems(this._kpi.params || []);
        });
        contentEl.appendChild(typeSel);

        const valueCtl = this._buildParamControl(item, item.value);
        valueCtl.classList.add('ea-kpi-param-row__value');
        valueCtl.addEventListener('change', () => {
            callbacks.update({ value: valueCtl.value });
        });
        contentEl.appendChild(valueCtl);
    }

    /** Show the live resolved-expression preview under the params
     *  card so the author can see what actually goes through `eval`.
     *  Hidden when there are no params or the expression contains no
     *  `{}` placeholders (preview would equal the expression). */
    _renderResolvedPreview() {
        const el = this.hostEl.querySelector('[data-role="resolved"]');
        if (!el) return;
        const expr = String(this._kpi.expr || '');
        const params = Array.isArray(this._kpi.params) ? this._kpi.params : [];
        if (!expr.includes('{') || params.length === 0) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        const resolved = resolveParams(expr, params);
        if (resolved === expr) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = 'Resolved: ' + resolved;
    }

    /** Push the current `_kpi.expr` into Monaco / the fallback input.
     *  Used after a template pick so the editor shows the parameterised
     *  expression the user just installed. */
    _pushExprToEditor() {
        const text = String(this._kpi.expr || '');
        if (this._monaco) {
            const model = this._monaco.getModel?.();
            if (model && model.getValue() !== text) model.setValue(text);
        } else if (this._monacoFallback) {
            if (this._monacoFallback.value !== text) this._monacoFallback.value = text;
        }
    }

    _buildParamControl(p, currentValue) {
        const def = currentValue != null ? currentValue : (p.default ?? '');
        const mkSelect = (entries) => {
            const sel = document.createElement('select');
            const seen = new Set();
            const opts = entries.map((e) => {
                seen.add(e.value);
                const s = e.value === def ? ' selected' : '';
                return `<option value="${esc(e.value)}"${s}>${esc(e.label)}</option>`;
            });
            if (def && !seen.has(def)) {
                opts.unshift(`<option value="${esc(def)}" selected>${esc(def)} (not declared yet)</option>`);
            }
            if (entries.length === 0 && !def) {
                opts.push(`<option value="">— none declared —</option>`);
            }
            sel.innerHTML = opts.join('');
            return sel;
        };
        if (p.type === 'archetype') {
            return mkSelect(this._archetypes.map((a) => ({
                value: a.archetype, label: a.label || a.archetype,
            })));
        }
        if (p.type === 'market') {
            return mkSelect(this._markets.map((m) => ({
                value: m.id, label: m.id,
            })));
        }
        if (p.type === 'asset_kind') {
            return mkSelect(this._assetKinds.map((k) => ({
                value: k.id, label: k.id,
            })));
        }
        if (p.type === 'kpi') {
            const myCountry = this._kpi.country || null;
            const inScope = this._otherKpis.filter((k) =>
                k.country == null || k.country === myCountry);
            return mkSelect(inScope.map((k) => ({
                value: k.id, label: k.label || k.id,
            })));
        }
        // bus_topic / text
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = def;
        inp.placeholder = p.placeholder || p.default || '';
        return inp;
    }

    /** Rebuild the "In scope" sidebar.
     *
     *  Categories are organised by data source — clicking a row
     *  inserts a runnable snippet at the cursor:
     *
     *    Helpers           — every callable in scope, with its full
     *                        signature in the row's title (hover).
     *    Per-agent         — explicit examples of how to read one
     *                        specific agent's balance / attribute.
     *    Asset kinds       — every declared asset_kind; inserts as
     *                        `stock('id')`.
     *    Markets           — every declared market; inserts as
     *                        `market_price('id', 0)`.
     *    Bus topics        — curated InfoBus topics the engine
     *                        publishes; inserts as `bus('topic', 0)`.
     *    Country aggregates — auto-bound names (per-country KPIs).
     *    Other KPIs        — sibling KPIs in scope, inserted as
     *                        `<id>_prev` (prior-tick read).
     *
     *  Math (abs, min, max, …) is intentionally omitted — they
     *  always work and clutter the panel. */
    _renderScopeList() {
        const host = this.hostEl.querySelector('[data-role="scope-list"]');
        if (!host) return;
        const country = this._kpi.country || null;
        const groups = [];

        // Helpers — show signature + detail in the title.
        groups.push({
            label: 'Helpers',
            items: KPI_HELPERS.map((h) => ({
                id: h.signature,
                insert: h.snippet
                    .replace(/\$\{\d+:([^}]*)\}/g, '$1')   // strip ${1:foo} markers
                    .replace(/\$\d+/g, ''),
                hint: h.detail,
            })),
        });

        // Per-agent examples — concrete invocations the user can
        // tweak. Picks the first archetype with a non-zero
        // population so the example agent id actually exists.
        const firstAgent = this._allAgentIds()[0];
        if (firstAgent) {
            const perAgent = [
                {
                    id: `agent_balance('${firstAgent}', 'Reserves', 0)`,
                    insert: `agent_balance('${firstAgent}', 'Reserves', 0)`,
                    hint: 'Read one agent\'s balance for one account.',
                },
                {
                    id: `agent_attr('${firstAgent}', 'policy_rate', 0)`,
                    insert: `agent_attr('${firstAgent}', 'policy_rate', 0)`,
                    hint: 'Read a scalar attribute (param or brain field).',
                },
            ];
            groups.push({ label: 'Per-agent reads', items: perAgent });
        }

        // Per-archetype aggregates — one click for each declared
        // archetype, mirroring how `_renderScopeList` already does
        // per-instance examples above. Inserts the most common
        // shorthand (sum of a Deposits account) which the user can
        // then swap to another account / attr.
        const firstArchetype = (this._archetypes || [])[0]?.archetype || null;
        if (firstArchetype) {
            groups.push({
                label: 'Per-archetype aggregates',
                items: [
                    {
                        id: `archetype_balance_sum('${firstArchetype}', 'Deposits')`,
                        insert: `archetype_balance_sum('${firstArchetype}', 'Deposits')`,
                        hint: 'Sum of an account across every agent of an archetype.',
                    },
                    {
                        id: `archetype_balance_mean('${firstArchetype}', 'Deposits')`,
                        insert: `archetype_balance_mean('${firstArchetype}', 'Deposits')`,
                        hint: 'Mean of an account across every agent of an archetype.',
                    },
                    {
                        id: `archetype_stock('${firstArchetype}', 'deposits')`,
                        insert: `archetype_stock('${firstArchetype}', 'deposits')`,
                        hint: 'Sum of one asset_kind across every agent of an archetype.',
                    },
                    {
                        id: `archetype_attr_mean('${firstArchetype}', 'c_intent')`,
                        insert: `archetype_attr_mean('${firstArchetype}', 'c_intent')`,
                        hint: 'Mean of a scalar attr / brain field across an archetype.',
                    },
                ],
            });

            // Functional composition idioms — for aggregations the
            // pre-baked archetype_* helpers can't express. Each
            // snippet pairs a list-returning primitive with a reducer
            // or comprehension so the user sees the full shape.
            groups.push({
                label: 'Functional composition',
                items: [
                    {
                        id: `mean(balances('${firstArchetype}', 'Deposits'))`,
                        insert: `mean(balances('${firstArchetype}', 'Deposits'))`,
                        hint: 'mean / median / std / var compose with balances(...) / attrs(...).',
                    },
                    {
                        id: `median(attrs('${firstArchetype}', 'c_intent'))`,
                        insert: `median(attrs('${firstArchetype}', 'c_intent'))`,
                        hint: 'Distribution stat over an attr (param / brain field).',
                    },
                    {
                        id: `sum(b for b in balances('${firstArchetype}', 'Deposits') if b > 0)`,
                        insert: `sum(b for b in balances('${firstArchetype}', 'Deposits') if b > 0)`,
                        hint: 'Filtered sum via generator expression.',
                    },
                    {
                        id: `len([b for b in balances('${firstArchetype}', 'Deposits') if b < 0])`,
                        insert: `len([b for b in balances('${firstArchetype}', 'Deposits') if b < 0])`,
                        hint: 'Count via list comprehension.',
                    },
                    {
                        id: `max(attrs('${firstArchetype}', 'wage')) - min(attrs('${firstArchetype}', 'wage'))`,
                        insert: `max(attrs('${firstArchetype}', 'wage')) - min(attrs('${firstArchetype}', 'wage'))`,
                        hint: 'Range of a distribution.',
                    },
                    {
                        id: `sum(map(lambda x: x*x, attrs('${firstArchetype}', 'wage')))`,
                        insert: `sum(map(lambda x: x*x, attrs('${firstArchetype}', 'wage')))`,
                        hint: 'map() + lambda — transform before reducing.',
                    },
                ],
            });
        }

        // Asset kinds.
        const kinds = (this._assetKinds || [])
            .map((k) => k.id).filter(Boolean);
        if (kinds.length > 0) {
            groups.push({
                label: 'Assets',
                items: kinds.map((id) => ({
                    id, insert: `stock('${id}')`,
                    hint: `stock('${id}') — Assets-side total in scope`,
                })),
            });
        }

        // Markets.
        const markets = (this._markets || [])
            .map((m) => m.id).filter(Boolean);
        if (markets.length > 0) {
            groups.push({
                label: 'Markets',
                items: markets.map((id) => ({
                    id, insert: `market_price('${id}', 0)`,
                    hint: `market_price('${id}', 0) — last-cleared mid`,
                })),
            });
        }

        // Bus topics.
        groups.push({
            label: 'Bus topics',
            items: KNOWN_BUS_TOPICS.map((b) => ({
                id: b.topic, insert: `bus('${b.topic}', 0)`,
                hint: b.label,
            })),
        });

        // Country aggregates — bare identifiers auto-bound for
        // per-country KPIs.
        if (country !== null && kinds.length > 0) {
            groups.push({
                label: `Country aggregates (${country})`,
                items: [
                    ...kinds.map((id) => ({
                        id, insert: id,
                        hint: `auto-bound to stock('${id}') for this country`,
                    })),
                    { id: 'equity', insert: 'equity',
                      hint: 'Sum of Equity-type balances inside the country.' },
                ],
            });
        }

        // Sibling KPIs in scope.
        const inScope = this._otherKpis.filter((k) =>
            k.country === country || k.country == null);
        if (inScope.length > 0) {
            groups.push({
                label: 'Other KPIs (prior tick)',
                items: inScope.map((k) => ({
                    id: `${k.id}_prev`, insert: `${k.id}_prev`,
                    hint: k.label
                        ? `${k.label} (${k.country || 'global'})`
                        : `prior tick — ${k.country || 'global'}`,
                })),
            });
        }

        host.innerHTML = groups.map((g) => `
            <div class="ea-kpi-scope-group">
                <header>${esc(g.label)}</header>
                <ul>
                    ${g.items.map((it) => `
                        <li>
                            <button type="button" data-insert="${esc(it.insert)}"
                                    title="${esc(it.hint || it.insert)}">
                                ${esc(it.id)}
                            </button>
                        </li>`).join('')}
                </ul>
            </div>`).join('');
        host.querySelectorAll('button[data-insert]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const text = btn.dataset.insert || '';
                if (!text) return;
                this._insertAtCursor(text);
            });
        });
    }

    async _mountExpressionEditor() {
        const editorHost = this.hostEl.querySelector('[data-host="expr"]');
        if (!editorHost) return;
        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger.warn?.('Monaco unavailable for KPI expr', { err });
        }
        if (!factory) {
            // Plain-input fallback so the user can still author an
            // expression when Monaco is missing.
            editorHost.innerHTML = `<input type="text" class="ea-kpi-expr__fallback"
                placeholder="Python expression — use the scope panel on the right"
                value="${esc(this._kpi.expr || '')}">`;
            this._monacoFallback = editorHost.querySelector('input');
            this._monacoFallback?.addEventListener('input', () => {
                this._kpi.expr = this._monacoFallback.value;
                this._renderResolvedPreview();
                this._scheduleSave();
            });
            return;
        }
        // Register a KPI-scoped completion provider for the Python
        // language. Disposed on tab dispose so it doesn't bleed into
        // other Python editors after this tab closes.
        const monaco = factory.monaco;
        if (monaco?.languages?.registerCompletionItemProvider) {
            this._completionDisposable?.dispose?.();
            this._completionDisposable = monaco.languages.registerCompletionItemProvider(
                'python', {
                    triggerCharacters: ["'", '"', '(', ',', '.', ' '],
                    provideCompletionItems: (model, position) =>
                        this._provideCompletions(model, position, monaco),
                });
        }
        const handle = factory.createEditor(editorHost, this._kpi.expr || '', {
            language: 'python',
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            wordWrap: 'off',
            scrollBeyondLastLine: false,
            scrollbar: { vertical: 'hidden', horizontal: 'auto' },
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            noAutoHeight: true,
            // Inherit the normal Monaco padding (`baseOptions` →
            // `{top:8, bottom:8}`) so the expression isn't flush
            // against the top edge of the 320 px host.
        });
        this._monaco = handle?.editor ?? handle;
        const model = this._monaco?.getModel?.();
        if (!model) return;
        model.onDidChangeContent(() => {
            let v = model.getValue();
            if (v.includes('\n')) { v = v.replace(/\n+/g, ' '); model.setValue(v); }
            this._kpi.expr = v;
            this._renderResolvedPreview();
            this._scheduleSave();
        });
    }

    /** Monaco completion provider. Two layers:
     *
     *  1. *Identifier* completions — when the caret is on a bare word
     *     (no enclosing string), suggest helpers + country aggregates
     *     + sibling KPI `_prev` names.
     *
     *  2. *String-arg* completions — when the caret is inside a string
     *     literal AND that literal is the Nth argument of a known
     *     helper (e.g. `stock('|`), surface the project's actual
     *     identifiers for that arg slot (asset_kinds / markets /
     *     archetypes / agent_ids / bus topics).
     *
     *  The provider's lookup tables are rebuilt every call so adding
     *  an asset_kind in a different tab is immediately reflected. */
    _provideCompletions(model, position, monaco) {
        const line = model.getLineContent(position.lineNumber);
        const col  = position.column - 1;          // 0-indexed end of typed prefix
        const head = line.slice(0, col);

        // --- detect "inside string" + which helper / arg slot ---
        const strCtx = _stringArgContext(head);
        if (strCtx) {
            return {
                suggestions: this._completionsForArg(
                    strCtx.fnName, strCtx.argIndex, strCtx.partial,
                    position, monaco,
                ),
            };
        }

        // --- identifier completions ---
        // Word range Monaco will replace.
        const wordInfo = model.getWordUntilPosition(position);
        const range = new monaco.Range(
            position.lineNumber, wordInfo.startColumn,
            position.lineNumber, wordInfo.endColumn,
        );
        const suggestions = [];
        // Helpers (insert as snippet so the user lands on the first arg).
        for (const h of KPI_HELPERS) {
            suggestions.push({
                label: h.name,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: h.snippet,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: h.signature,
                documentation: h.detail,
                range,
            });
        }
        // Country aggregates (only when this KPI is scoped to a country).
        const country = this._kpi?.country || null;
        if (country !== null) {
            for (const ak of (this._assetKinds || [])) {
                if (!ak?.id) continue;
                suggestions.push({
                    label: ak.id,
                    kind: monaco.languages.CompletionItemKind.Variable,
                    insertText: ak.id,
                    detail: `country aggregate · ${country}`,
                    documentation: 'Sum of this asset kind\'s Assets-side balances inside the country.',
                    range,
                });
            }
            suggestions.push({
                label: 'equity',
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: 'equity',
                detail: `country aggregate · ${country}`,
                documentation: 'Sum of Equity-type balances inside the country.',
                range,
            });
        }
        // Sibling KPIs (prior-tick reads — same scope).
        for (const k of (this._otherKpis || [])) {
            if (!k?.id) continue;
            const sameScope = k.country === country || k.country == null;
            if (!sameScope) continue;
            suggestions.push({
                label: `${k.id}_prev`,
                kind: monaco.languages.CompletionItemKind.Reference,
                insertText: `${k.id}_prev`,
                detail: `prior tick · ${k.country || 'global'}`,
                documentation: k.label || k.id,
                range,
            });
        }
        // Keyword arguments of the enclosing helper call — so
        // `stock('deposits', ty|` completes to `type=` rather than
        // matching nothing.
        const call = _callContext(head);
        if (call) {
            const helper = _findHelper(call.fnName);
            if (helper) {
                for (const kw of _parseKwargs(helper.signature)) {
                    suggestions.push({
                        label: `${kw}=`,
                        kind: monaco.languages.CompletionItemKind.Property,
                        insertText: `${kw}=`,
                        detail: `keyword arg of ${call.fnName}()`,
                        documentation: helper.signature,
                        sortText: `0_${kw}`,
                        range,
                    });
                }
            }
        }
        return { suggestions };
    }

    /** Resolve string-arg completion candidates for a given helper +
     *  argument slot. The lookup tables are project-derived: asset
     *  kinds come from `assets_list`, markets from
     *  `market_instances_list`, etc. Returned suggestions slot into Monaco's
     *  completion shape including the `range` that replaces the
     *  partial inside the string. */
    _completionsForArg(fnName, argIndex, partial, position, monaco) {
        const helper = KPI_HELPERS.find((h) => h.name === fnName);
        if (!helper) return [];
        const hint = helper.argHints?.[argIndex];
        if (!hint) return [];
        let entries = [];
        if (hint === 'asset_kind') {
            entries = (this._assetKinds || []).map((k) => ({
                value: k.id, label: k.id,
                detail: k.is_financial ? 'financial' : 'real',
            }));
        } else if (hint === 'market') {
            entries = (this._markets || []).map((m) => ({
                value: m.id, label: m.id, detail: m.kind || '',
            }));
        } else if (hint === 'archetype') {
            entries = (this._archetypes || []).map((a) => ({
                value: a.archetype, label: a.archetype,
                detail: a.label || '',
            }));
        } else if (hint === 'agent_id') {
            entries = this._allAgentIds().map((id) => ({
                value: id, label: id, detail: 'agent',
            }));
        } else if (hint === 'account_label') {
            // Surface every distinct account label across all
            // archetypes — gives users a quick pick rather than
            // having to remember the exact wording.
            const seen = new Set();
            for (const a of (this._archetypes || [])) {
                for (const acc of (a.accounts || [])) {
                    if (!acc?.label || seen.has(acc.label)) continue;
                    seen.add(acc.label);
                    entries.push({
                        value: acc.label, label: acc.label,
                        detail: `${acc.type || ''} · ${acc.asset_kind || ''}`,
                    });
                }
            }
        } else if (hint === 'bus_topic') {
            entries = KNOWN_BUS_TOPICS.map((b) => ({
                value: b.topic, label: b.topic, detail: b.label || '',
            }));
        } else if (hint.startsWith('enum:')) {
            entries = hint.slice('enum:'.length).split('|').map((v) => ({
                value: v, label: v, detail: '',
            }));
        }
        // Range = the partial string fragment Monaco should replace.
        const range = new monaco.Range(
            position.lineNumber, position.column - partial.length,
            position.lineNumber, position.column,
        );
        return entries.map((e) => ({
            label: e.label,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: e.value,
            detail: e.detail,
            range,
        }));
    }

    _insertAtCursor(text) {
        if (this._monaco?.getSelection) {
            const sel = this._monaco.getSelection();
            this._monaco.executeEdits('kpi-scope-insert', [{
                range: sel, text: String(text), forceMoveMarkers: true,
            }]);
            this._monaco.focus();
            return;
        }
        if (this._monacoFallback) {
            const inp = this._monacoFallback;
            const start = inp.selectionStart ?? inp.value.length;
            const end = inp.selectionEnd ?? inp.value.length;
            inp.value = inp.value.slice(0, start) + text + inp.value.slice(end);
            inp.dispatchEvent(new Event('input'));
            inp.focus();
        }
    }

    // ---- delete ----

    async _onDelete() {
        const ok = await openConfirm({
            title: 'Delete KPI',
            message: `Permanently delete KPI "${this._kpi?.label || this.kpiId}"?`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        const res = await window.pywebview?.api?.kpi_delete?.(this.kpiId);
        if (res?.ok === false) {
            toastError('Delete failed', res.error || 'unknown error');
            return;
        }
        try { this.workspaceTabs?.closeTab?.(this.tabId); } catch { /* ignore */ }
    }

    // ---- save ----

    _setSaveStatus(cls, txt, title = '') {
        const el = this.hostEl.querySelector('[data-role="save-status"]');
        if (!el) return;
        el.className = `ea-save-status ${cls}`;
        el.textContent = txt;
        el.title = title || '';
    }

    _scheduleSave() {
        this._setSaveStatus('ea-save-status--pending', 'editing…');
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flushSave(), 400);
    }

    // The actual write — callable from the debounce timer OR a blur flush.
    // Reads the in-memory `this._kpi` (edit handlers keep it current), so it's
    // safe to fire immediately. No-op when nothing is pending (so a plain
    // focus-out doesn't spam redundant saves).
    async _flushSave() {
        if (this._saveTimer === null) return;
        clearTimeout(this._saveTimer); this._saveTimer = null;
        this._setSaveStatus('ea-save-status--pending', 'saving…');
        const seq = ++this._saveSeq;
        const k = this._kpi;
        const country = k.country === '' ? null : (k.country ?? null);
        let resp;
        try {
            resp = await window.pywebview?.api?.kpi_save?.(
                k.id, k.label || k.id, country, k.kind || 'ratio',
                k.unit || '', k.expr || '0.0', k.description || '',
                Array.isArray(k.params) ? k.params : [],
            );
        } catch (err) {
            resp = { ok: false, error: String(err?.message || err) };
        }
        if (seq !== this._saveSeq) return;
        if (resp?.ok) {
            this._setSaveStatus('ea-save-status--saved', 'saved');
            this.workspaceTabs?.notifyChanged?.('kpis');
        } else {
            const msg = resp?.error || 'save failed';
            this._setSaveStatus('ea-save-status--error', 'not saved — ' + msg, msg);
        }
    }

}
