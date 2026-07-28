/**
 * Generic typed row editor — open as a modal, returns a row dict on
 * submit or `null` on cancel.
 *
 * Driven by a column spec list (`[{name, type, nullable?, default?}, …]`):
 * one input per column with type-appropriate widget. The same modal
 * serves three modes:
 *
 *   - `mode: 'add'`  → all fields empty / default-prefilled
 *   - `mode: 'edit'` → fields prefilled from the existing row; PK
 *                       column is read-only (auto-PK rows can't change
 *                       their id)
 *   - `mode: 'view'` → all fields read-only (no submit button)
 *
 * Column-type → widget map (mirrors typed_table._TYPE_COERCERS):
 *   str      → text input
 *   int      → number input (step=1)
 *   float    → number input (step=any)
 *   tick     → number input (step=1, min=0)
 *   bool     → checkbox
 *   agent_id → text input (could become a search-select later)
 *   json     → textarea, value JSON.parse'd on submit
 *
 * Returns Promise<{rowId?: string, row: object} | null>.
 * `rowId` is echoed in edit mode for the caller's update call.
 */

import { ManagedWindow } from '../../ui/components/managed_window.js';
import { ESCAPE_HTML, widgetFor, collectRow, typeGroup } from './typed_inputs.js';
import { loadEntitiesGrouped } from '../../tiling/entity_sources.js';

let _seq = 0;

// Source id (plural, as used by browser_sources_list) → entity catalog
// navKind (singular). Used by openEntityRef to resolve references into
// relational sources that `browser_query` can't serve.
const _TARGET_NAVKIND = {
    agents: 'agent', sectors: 'sector', markets: 'market',
    market_archetypes: 'market-archetype', archetypes: 'archetype',
    asset_kinds: 'asset_kind', scenarios: 'scenario', kpis: 'kpi',
    countries: 'country', currencies: 'currency',
};

function _colsFromRow(row) {
    return Object.keys(row || {})
        .filter((k) => k !== '_id')
        .map((k) => ({
            name: k,
            type: typeof row[k] === 'number' ? 'float'
                : typeof row[k] === 'boolean' ? 'bool'
                    : (row[k] && typeof row[k] === 'object') ? 'json' : 'str',
        }));
}

/** Follow a reference into the combined entity viewer (read-only). Tries
 *  the queryable backends first (`registry:*` / `table:*` via
 *  `browser_query`), then falls back to the entity catalog for relational
 *  sources (`sectors` / `markets` / `agents` / …) that `browser_query`
 *  can't serve. Returns true when a row was found + opened, false
 *  otherwise (caller decides how to degrade — toast, or switch the
 *  browser view). */
export async function openEntityRef(target, id, opts = {}) {
    const api = opts.api || window.pywebview?.api;
    if (!api || !target || id == null || id === '') return false;
    const t = String(target);
    const want = String(id);

    const sids = t.includes(':') ? [t] : [`registry:${t}`, `table:${t}`];
    for (const sid of sids) {
        try {
            let columns = null;
            let pk = 'auto';
            if (sid.startsWith('registry:')) {
                const sc = await api.world_registry_schema?.(sid.slice('registry:'.length));
                columns = sc?.columns; pk = sc?.primary_key || pk;
            } else if (sid.startsWith('table:')) {
                const sc = await api.table_get?.(sid.slice('table:'.length));
                columns = sc?.columns; pk = sc?.primary_key || pk;
            }
            const res = await api.browser_query?.(sid, {});
            const rows = (res && res.ok !== false && (res.rows || res.entries)) || [];
            const found = rows.find(
                (r) => String(r.id ?? r[pk] ?? r.name ?? '') === want);
            if (found) {
                openEntityWindow({
                    title: `${sid} · ${id}`,
                    columns: (columns && columns.length) ? columns : _colsFromRow(found),
                    row: found, primaryKey: pk, rowId: id, readOnly: true,
                    metaSourceId: sid,
                });
                return true;
            }
        } catch { /* try the next source shape / the catalog */ }
    }

    // Relational entity sources via the catalog (sectors / markets / …).
    try {
        const navKind = _TARGET_NAVKIND[t] || (t.endsWith('s') ? t.slice(0, -1) : t);
        const grouped = await loadEntitiesGrouped(api);
        const rows = grouped[navKind] || [];
        const found = rows.find(
            (r) => String(r.id ?? r.archetype ?? r.name ?? '') === want);
        if (found) {
            openEntityWindow({
                title: `${t} · ${id}`,
                columns: _colsFromRow(found), row: found, rowId: id, readOnly: true,
                metaSourceId: t,
            });
            return true;
        }
    } catch { /* fall through */ }

    return false;
}

/**
 * @param {Object} opts
 * @param {'add'|'edit'|'view'} opts.mode
 * @param {Array<{name, type, nullable?, default?}>} opts.columns
 * @param {Object} [opts.row]        — existing row (edit/view modes)
 * @param {string} [opts.rowId]      — primary key value (edit/view modes)
 * @param {string} [opts.primaryKey] — name of the PK column (or 'auto')
 * @param {string} [opts.title]      — modal title override
 */
export function openRowForm(opts = {}) {
    const mode      = opts.mode || 'add';
    const columns   = Array.isArray(opts.columns) ? opts.columns : [];
    const row       = opts.row || {};
    const primaryKey = opts.primaryKey || 'auto';
    const isEdit    = (mode === 'edit');
    const isView    = (mode === 'view');
    const title     = opts.title || (
        isView ? 'View row'
            : isEdit ? `Edit row · ${opts.rowId ?? ''}`
                : 'Add row'
    );

    return new Promise((resolve) => {
        const body = document.createElement('div');
        body.className = 'ea-modal__body-host ea-row-form';
        body.innerHTML = _markup(columns, row, primaryKey, mode);

        const win = new ManagedWindow({
            id: `ea-row-form-${_seq++}`,
            title,
            icon: isEdit ? 'edit' : (isView ? 'visibility' : 'add'),
            content: body,
            modal: true,
            canMinimize: false,
            canMaximize: false,
            canResize: true,
            canDrag: true,
            defaultWidth: 520,
            defaultHeight: Math.min(640, 180 + columns.length * 56),
            minWidth: 380, minHeight: 240,
            onClose: () => { if (!_resolved) { _resolved = true; resolve(null); } },
        });
        win.show();

        let _resolved = false;
        const close = (result) => {
            if (_resolved) return;
            _resolved = true;
            resolve(result);
            try { win.close({ force: true }); } catch {}
        };

        const errEl = body.querySelector('[data-role="form-error"]');
        const showError = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

        body.querySelector('[data-action="cancel"]')
            ?.addEventListener('click', () => close(null));

        if (!isView) {
            body.querySelector('form')?.addEventListener('submit', (ev) => {
                ev.preventDefault();
                showError('');
                try {
                    const collected = collectRow(body, columns, primaryKey, isEdit);
                    close({ row: collected, rowId: opts.rowId });
                } catch (exc) {
                    showError(String(exc?.message || exc));
                }
            });
        }

        // Focus the first non-PK editable field.
        requestAnimationFrame(() => {
            const first = body.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
            first?.focus();
        });
    });
}


// ── Combined entity viewer / editor ─────────────────────────────────
//
// A NON-MODAL managed window (no blur backdrop) that shows a row's
// fields read-only and offers an "Edit" button to switch into edit mode
// in place. The Edit button is locked for read-only sources. Used by the
// database view (row click / context-menu Open + Edit) and by following
// a reference — NOT the full tiling entity editors.

/**
 * @param {Object} opts
 * @param {Array} opts.columns
 * @param {Object} opts.row
 * @param {string} [opts.primaryKey]
 * @param {string} [opts.rowId]
 * @param {string} [opts.title]
 * @param {boolean} [opts.readOnly]      — no Edit (button shown but locked)
 * @param {'view'|'edit'} [opts.startMode]
 * @param {(collected:Object, prev:Object) => Promise<{ok:boolean,error?:string}>} [opts.onSave]
 * @returns {{ close: () => void }}
 */
export function openEntityWindow(opts = {}) {
    const columns    = Array.isArray(opts.columns) ? opts.columns : [];
    const primaryKey = opts.primaryKey || 'auto';
    const readOnly   = !!opts.readOnly;
    const title      = opts.title || `Entity · ${opts.rowId ?? ''}`;
    let mode = (opts.startMode === 'edit' && !readOnly) ? 'edit' : 'view';
    let curRow = { ...(opts.row || {}) };

    const body = document.createElement('div');
    body.className = 'ea-modal__body-host ea-row-form ea-entity-window';

    const win = new ManagedWindow({
        id: `ea-entity-${_seq++}`,
        title,
        icon: 'table_view',
        content: body,
        modal: false,                 // regular window — no blur backdrop
        canMinimize: true,
        canMaximize: true,
        canResize: true,
        canDrag: true,
        defaultWidth: 520,
        defaultHeight: Math.min(640, 200 + columns.length * 52),
        minWidth: 380, minHeight: 240,
    });
    win.show();

    const showError = (m) => {
        const e = body.querySelector('[data-role="form-error"]');
        if (e) { e.textContent = m || ''; e.hidden = !m; }
    };

    let metaHtml = '';
    const render = () => {
        body.innerHTML = _entityMarkup(columns, curRow, primaryKey, mode, readOnly, metaHtml);
        if (mode === 'view') {
            body.querySelector('[data-action="close"]')
                ?.addEventListener('click', () => { try { win.close({ force: true }); } catch {} });
            const editBtn = body.querySelector('[data-action="edit"]');
            if (editBtn && !readOnly) {
                editBtn.addEventListener('click', () => { mode = 'edit'; render(); });
            }
        } else {
            body.querySelector('[data-action="cancel-edit"]')
                ?.addEventListener('click', () => { mode = 'view'; render(); });
            body.querySelector('form')?.addEventListener('submit', async (ev) => {
                ev.preventDefault();
                showError('');
                let collected;
                try { collected = collectRow(body, columns, primaryKey, true); }
                catch (exc) { showError(String(exc?.message || exc)); return; }
                try {
                    const res = await opts.onSave?.(collected, curRow);
                    if (res && res.ok === false) { showError(res.error || 'save failed'); return; }
                    curRow = collected;
                    mode = 'view';
                    render();
                } catch (exc) { showError(String(exc?.message || exc)); }
            });
        }
    };
    render();
    // Record metadata header (M1) — fetched async; re-renders when it lands.
    if (opts.metaSourceId) {
        _fetchSourceMeta(opts.metaSourceId).then((html) => {
            if (html) { metaHtml = html; render(); }
        });
    }
    return { close: () => { try { win.close({ force: true }); } catch {} } };
}

/** Build the record-metadata header (source file / mtime / count) for the
 *  combined viewer. Returns '' when nothing useful is available. */
async function _fetchSourceMeta(sourceId) {
    try {
        const m = await window.pywebview?.api?.browser_source_meta?.(sourceId);
        if (!m || m.ok === false) return '';
        const item = (icon, text, title) =>
            `<span class="ea-row-form__meta-item"${title ? ` title="${ESCAPE_HTML(title)}"` : ''}>`
            + `<span class="material-symbols-outlined">${icon}</span>${ESCAPE_HTML(text)}</span>`;
        const parts = [];
        const file = m.snapshot_file || m.source_file || m.schema_file;
        if (file) parts.push(item('draft', String(file).split(/[\\/]/).pop(), file));
        if (m.mtime) {
            let when = '';
            try { when = new Date(m.mtime * 1000).toLocaleString(); } catch { when = ''; }
            if (when) parts.push(item('schedule', when, 'last modified'));
        }
        if (m.count != null) parts.push(item('table_rows', `${m.count} rows`, 'row count'));
        if (m.category) parts.push(item('category', String(m.category)));
        if (!parts.length) return '';
        return `<div class="ea-row-form__meta">${parts.join('')}</div>`;
    } catch { return ''; }
}

function _entityMarkup(columns, row, primaryKey, mode, readOnly, metaHtml = '') {
    const isView = (mode === 'view');
    const fields = columns
        .map((c) => _fieldRow(c, row, primaryKey, isView ? 'view' : 'edit'))
        .join('');
    const buttons = isView
        ? `<button type="button" class="ea-btn" data-action="close">Close</button>`
          + `<button type="button" class="ea-btn ea-btn--primary" data-action="edit"`
          + `${readOnly ? ' disabled title="This table is read-only"' : ''}>Edit</button>`
        : `<button type="button" class="ea-btn" data-action="cancel-edit">Cancel</button>`
          + `<button type="submit" class="ea-btn ea-btn--primary">Save</button>`;
    // In view mode the form must not submit, so use a plain <div>.
    const tag = isView ? 'div' : 'form';
    return `
        <${tag} class="ea-modal__form ea-row-form__form">
            ${metaHtml || ''}
            <div class="ea-row-form__fields">
                ${fields || '<div class="ea-modal__hint">No columns on this row.</div>'}
            </div>
            <div class="ea-modal__error" data-role="form-error" hidden></div>
            <div class="ea-modal__actions">${buttons}</div>
        </${tag}>
    `;
}


// ── Markup ──────────────────────────────────────────────────────────

function _markup(columns, row, primaryKey, mode) {
    const isView = mode === 'view';
    const isEdit = mode === 'edit';
    const fields = columns.map((c) => _fieldRow(c, row, primaryKey, mode)).join('');
    const buttons = isView
        ? `<button type="button" class="ea-btn" data-action="cancel">Close</button>`
        : `
            <button type="button" class="ea-btn" data-action="cancel">Cancel</button>
            <button type="submit" class="ea-btn ea-btn--primary">
                ${isEdit ? 'Save' : 'Add'}
            </button>
        `;
    return `
        <form class="ea-modal__form ea-row-form__form">
            <div class="ea-row-form__fields">
                ${fields || '<div class="ea-modal__hint">No editable columns on this row.</div>'}
            </div>
            <div class="ea-modal__error" data-role="form-error" hidden></div>
            <div class="ea-modal__actions">${buttons}</div>
        </form>
    `;
}

function _fieldRow(col, row, primaryKey, mode) {
    const isView = mode === 'view';
    const isEdit = mode === 'edit';
    const name = col.name;
    if (!name) return '';
    // PK is locked in edit/view mode — synthetic auto-PK can't change;
    // named PK is the row's identity, so renaming it is "delete + create"
    // not "update". User can delete + add to re-key.
    const isPk = (name === primaryKey);
    const locked = isView || (isEdit && isPk);
    const value = row[name];
    // View mode: render JSON / object values as a pretty read-only block
    // (a textarea cramps nested structures). Edit mode keeps the textarea.
    const isJson = col.type === 'json' || (value && typeof value === 'object');
    let widget;
    if (isView && isJson) {
        widget = _jsonTreeHtml(value);
    } else {
        widget = widgetFor(col, value, locked);
    }
    const nullableHint = (col.nullable === false && !isView)
        ? '<span class="ea-row-form__required" title="Required (non-nullable)">*</span>'
        : '';
    const typeBadge = `<span class="ea-row-form__type">${ESCAPE_HTML(col.type || 'str')}</span>`;
    return `
        <label class="ea-row-form__row" data-field-row="${ESCAPE_HTML(name)}">
            <span class="ea-row-form__label">
                ${ESCAPE_HTML(name)}${nullableHint} ${typeBadge}
                ${isPk ? '<span class="ea-row-form__pk-tag" title="Primary key">pk</span>' : ''}
            </span>
            ${widget}
        </label>
    `;
}

// ── Collapsible JSON tree (viewer, view mode) ───────────────────────
//
// Native <details>/<summary> so collapse/expand needs no JS. Objects and
// arrays are collapsible nodes (top level open, nested collapsed);
// primitives are leaves. Non-JSON strings fall back to a plain block.

function _jsonTreeHtml(raw) {
    let v = raw;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (s && (s[0] === '{' || s[0] === '[')) {
            try { v = JSON.parse(s); } catch { /* not JSON — show raw below */ }
        }
    }
    if (v === null || typeof v !== 'object') {
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        return `<pre class="ea-row-form__json">${ESCAPE_HTML(String(text))}</pre>`;
    }
    return `<div class="ea-row-form__json ea-jtree-root">${_jsonNode(v, null, 0)}</div>`;
}

function _jsonNode(value, key, depth) {
    const keyHtml = key != null
        ? `<span class="ea-jtree__key">${ESCAPE_HTML(String(key))}</span>` : '';
    if (value === null || typeof value !== 'object') {
        const type = value === null ? 'null' : typeof value;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `<div class="ea-jtree__leaf">${keyHtml}`
            + `<span class="ea-jtree__val ea-jtree__val--${type}">${ESCAPE_HTML(String(text))}</span></div>`;
    }
    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const meta = isArr ? `[${entries.length}]` : `{${entries.length}}`;
    const open = depth < 1 ? ' open' : '';
    const children = entries.map(([k, v]) => _jsonNode(v, k, depth + 1)).join('');
    return `<details class="ea-jtree"${open}>`
        + `<summary class="ea-jtree__sum">${keyHtml}<span class="ea-jtree__meta">${meta}</span></summary>`
        + `<div class="ea-jtree__body">${children}</div></details>`;
}

// ── Inline editor ───────────────────────────────────────────────────
//
// Same typed widgets + coercion as the modal, laid out as a compact
// Godley-style grid (a column-header row above an input row, aligned in
// a grid, type-aware) for in-place "add row" — no ManagedWindow. The
// caller mounts the returned element wherever it wants (e.g. below a
// table) and drives the lifecycle via the callbacks.

/**
 * Build an inline add-row editor element.
 * @param {Object} opts
 * @param {Array<{name, type, nullable?, default?}>} opts.columns
 * @param {string} [opts.primaryKey]
 * @param {(row: object, ctl: {showError: (m: string) => void}) => void} opts.onSubmit
 *        Called with the collected+coerced row. Stays mounted so the
 *        caller can `showError` and keep the inputs on a failed insert;
 *        the caller removes the element on success.
 * @param {() => void} [opts.onCancel]
 * @returns {HTMLElement}
 */
export function buildInlineRowEditor(opts = {}) {
    const columns    = Array.isArray(opts.columns) ? opts.columns : [];
    const primaryKey = opts.primaryKey || 'auto';
    const editable   = columns.filter((c) => c && c.name);

    const wrap = document.createElement('div');
    wrap.className = 'ea-row-inline';

    // Header row (column captions) then the input row — both emitted into
    // one grid so they line up column-for-column (Godley-style).
    const caps = editable.map((c) => {
        const isPk = (c.name === primaryKey);
        const grp  = typeGroup(c.type || 'str');
        return `<div class="ea-row-inline__cap ea-row-inline__cap--${grp}" title="${ESCAPE_HTML(c.type || 'str')}">`
            + `<span class="ea-row-inline__name">${ESCAPE_HTML(c.name)}</span>`
            + (c.nullable === false ? '<span class="ea-row-inline__req" title="required">*</span>' : '')
            + (isPk ? '<span class="ea-row-inline__pk" title="primary key">pk</span>' : '')
            + `</div>`;
    }).join('');
    const inputs = editable.map((c) => {
        const grp = typeGroup(c.type || 'str');
        return `<div class="ea-row-inline__cell ea-row-inline__cell--${grp}">`
            + widgetFor(c, c.default ?? null, false, { placeholder: c.name })
            + `</div>`;
    }).join('');

    wrap.innerHTML = `
        <form class="ea-row-inline__form">
            ${editable.length
                ? `<div class="ea-row-inline__grid" style="grid-template-columns: repeat(${editable.length}, minmax(88px, 1fr));">${caps}${inputs}</div>`
                : '<span class="ea-modal__hint">No editable columns.</span>'}
            <div class="ea-modal__error ea-row-inline__error" data-role="form-error" hidden></div>
            <div class="ea-row-inline__actions">
                <button type="button" class="ea-btn" data-action="cancel">Cancel</button>
                <button type="submit" class="ea-btn ea-btn--primary">Add row</button>
            </div>
        </form>
    `;

    const errEl = wrap.querySelector('[data-role="form-error"]');
    const showError = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };
    const cancel = () => { try { opts.onCancel?.(); } catch {} };

    wrap.querySelector('[data-action="cancel"]')
        ?.addEventListener('click', cancel);
    wrap.querySelector('form')?.addEventListener('submit', (ev) => {
        ev.preventDefault();
        showError('');
        let row;
        try {
            // Add mode (isEdit=false) → PK is collected like any column.
            row = collectRow(wrap, columns, primaryKey, false);
        } catch (exc) {
            showError(String(exc?.message || exc));
            return;
        }
        opts.onSubmit?.(row, { showError });
    });
    // Esc anywhere in the editor cancels.
    wrap.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });

    requestAnimationFrame(() => {
        wrap.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')?.focus();
    });

    return wrap;
}
