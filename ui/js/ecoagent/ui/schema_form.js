/**
 * schema_form.js — structured editor for a TypedTable registry schema.
 *
 * Replaces the old JSON-textarea approach (you typed/edited a literal
 * `[{name, type}, …]` and prayed it parsed). The list of columns is
 * a first-class UI now: per-row name + type dropdown + nullable + default
 * + remove, plus add-column, with the rest of the schema metadata
 * (id, label, primary key, max rows, indexes) above.
 *
 * Used by the bottom-panel Registries tab in two modes:
 *   `new`  — id is editable, defaults to a sensible starter row list.
 *   `edit` — id is readonly (it's the file path); fields prefilled from
 *            the existing TableSpec returned by `world_registry_schema`.
 *
 * The promise resolves with a schema dict matching the bridge contract:
 *   { id, label, columns: [{name, type, nullable, default?}, …],
 *     primary_key, indexes, max_rows }
 * or `null` if the user cancelled.
 *
 * Column-type list mirrors `ecoagent/sim/typed_table.py:_TYPE_COERCERS`.
 * Adding a new type there + this list is two edits; nothing else needs
 * to change to expose it in the editor.
 */

import { ManagedWindow } from '../../ui/components/managed_window.js';
import { DragReorder } from '../../ui/components/drag_reorder.js';

let _seq = 1;
let _rowUid = 0;

/** Canonical column types — matches typed_table._TYPE_COERCERS. The
 *  display label spells out what each one means so users don't have
 *  to guess what "tick" or "agent_id" are. */
const COLUMN_TYPES = [
    { value: 'str',      label: 'str — text' },
    { value: 'int',      label: 'int — whole number' },
    { value: 'float',    label: 'float — decimal' },
    { value: 'bool',     label: 'bool — true / false' },
    { value: 'tick',     label: 'tick — world tick (int)' },
    { value: 'agent_id', label: 'agent_id — agent identifier (str)' },
    { value: 'json',     label: 'json — opaque structured value' },
];
const VALID_TYPES = new Set(COLUMN_TYPES.map((t) => t.value));

const DEFAULT_NEW_COLUMNS = [
    { name: 'tick',     type: 'tick',     nullable: false },
    { name: 'agent_id', type: 'agent_id', nullable: false },
    { name: 'key',      type: 'str',      nullable: false },
    { name: 'value',    type: 'float',    nullable: true },
];


export function openSchemaForm({ mode = 'new', spec = null } = {}) {
    const isEdit = mode === 'edit';
    const initial = _normalizeSpec(spec, isEdit);

    return new Promise((resolve) => {
        const body = document.createElement('div');
        body.className = 'ea-modal__body-host ea-schema-form';
        body.innerHTML = _markup(initial, isEdit);

        const win = new ManagedWindow({
            id: `ea-schema-form-${_seq++}`,
            title: isEdit ? `Edit schema · ${initial.id}` : 'New schema',
            icon: 'database',
            content: body,
            modal: true,
            canMinimize: false,
            canMaximize: false,
            canResize: true,
            canDrag: true,
            defaultWidth: 720,
            defaultHeight: 580,
            minWidth: 540, minHeight: 420,
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

        const rowsHost = body.querySelector('[data-role="columns"]');
        const errEl = body.querySelector('[data-role="form-error"]');
        const showError = (msg) => {
            errEl.textContent = msg || '';
            errEl.hidden = !msg;
        };

        // Append the seed rows.
        for (const c of initial.columns) _appendColumnRow(rowsHost, c);

        // Drag-to-reorder the columns, reusing the shared DragReorder
        // module (same technique as the tab bars + the schema strip).
        // Drag only from the grip handle so the row's inputs stay
        // interactive. `_collect` reads rows in DOM order, so reordering
        // the rows is all that's needed.
        const colDrag = new DragReorder({
            container: rowsHost,
            itemSelector: '.ea-schema-form__col',
            keyAttr: 'rowuid',
            axis: 'y',
            indicatorClass: 'ea-schema-form__drop',
            draggableGuard: (e) => !!e.target.closest('[data-role="col-grip"]'),
        });
        colDrag.attach();

        body.querySelector('[data-action="add-column"]')
            .addEventListener('click', () => {
                _appendColumnRow(rowsHost, {
                    name: '', type: 'str', nullable: true, default: '',
                });
                colDrag.attach();   // wire the new row for dragging
                rowsHost.lastElementChild?.querySelector('[data-col="name"]')
                    ?.focus();
            });
        body.querySelector('[data-action="cancel"]')
            .addEventListener('click', () => close(null));

        body.querySelector('form').addEventListener('submit', (ev) => {
            ev.preventDefault();
            showError('');
            const collected = _collect(body, initial.id, isEdit);
            if (collected.error) { showError(collected.error); return; }
            close(collected.schema);
        });

        requestAnimationFrame(() => {
            body.querySelector('input[name="label"]')?.focus();
        });
    });
}


// ── Markup ──────────────────────────────────────────────────────────

function _markup(initial, isEdit) {
    const idField = isEdit
        ? `
            <label class="ea-modal__row" data-field-row="id">
                <span>Id</span>
                <input name="id" type="text"
                       value="${_esc(initial.id)}" disabled
                       title="The id is the registry's filename; can't be renamed here.">
                <div class="ea-modal__hint--field">Edit the file directly to rename.</div>
            </label>`
        : `
            <label class="ea-modal__row" data-field-row="id">
                <span>Id</span>
                <input name="id" type="text"
                       value="${_esc(initial.id)}"
                       placeholder="e.g. my_metric" required>
                <div class="ea-modal__hint--field">Lowercase letters / digits / underscores; starts with a letter.</div>
            </label>`;

    const primaryKeyOptions = ['auto']
        .concat(initial.columns.map((c) => c.name).filter(Boolean));
    const pkSelect = primaryKeyOptions.map((pk) => {
        const lbl = pk === 'auto' ? 'auto (insertion order)' : pk;
        const sel = pk === initial.primary_key ? ' selected' : '';
        return `<option value="${_esc(pk)}"${sel}>${_esc(lbl)}</option>`;
    }).join('');

    return `
        <form class="ea-modal__form ea-schema-form__form">
            <div class="ea-schema-form__meta">
                ${idField}
                <label class="ea-modal__row" data-field-row="label">
                    <span>Label</span>
                    <input name="label" type="text"
                           value="${_esc(initial.label)}"
                           placeholder="Human-readable description">
                    <div class="ea-modal__hint--field">Shown in the picker and the title bar.</div>
                </label>
            </div>

            <div class="ea-modal__section">Columns</div>
            <div class="ea-schema-form__cols" data-role="columns"></div>
            <div class="ea-schema-form__cols-actions">
                <button type="button" class="ea-btn ea-btn--small"
                        data-action="add-column">
                    <span class="material-symbols-outlined">add</span>
                    Add column
                </button>
                <span class="ea-schema-form__cols-hint">
                    Type one of: str · int · float · bool · tick · agent_id · json.
                </span>
            </div>

            <div class="ea-modal__section">Indexing &amp; storage</div>
            <div class="ea-schema-form__meta">
                <label class="ea-modal__row" data-field-row="primary_key">
                    <span>Primary key</span>
                    <select name="primary_key">${pkSelect}</select>
                    <div class="ea-modal__hint--field">"auto" = framework-assigned ids. Picking a column makes its value the row id (must be unique).</div>
                </label>
                <label class="ea-modal__row" data-field-row="indexes">
                    <span>Indexes</span>
                    <input name="indexes" type="text"
                           value="${_esc(initial.indexes.join(', '))}"
                           placeholder="comma-separated column names">
                    <div class="ea-modal__hint--field">Columns to index for fast lookup (optional).</div>
                </label>
                <label class="ea-modal__row" data-field-row="max_rows">
                    <span>Max rows</span>
                    <input name="max_rows" type="number" min="0"
                           value="${initial.max_rows ?? 50000}">
                    <div class="ea-modal__hint--field">Hard cap. Older rows evicted when reached.</div>
                </label>
            </div>

            <div class="ea-modal__error" data-role="form-error" hidden></div>
            <div class="ea-modal__actions">
                <button type="button" class="ea-btn" data-action="cancel">Cancel</button>
                <button type="submit" class="ea-btn ea-btn--primary">
                    ${isEdit ? 'Save' : 'Create'}
                </button>
            </div>
        </form>
    `;
}


// ── Column-row rendering ────────────────────────────────────────────

function _appendColumnRow(host, col) {
    const row = document.createElement('div');
    row.className = 'ea-schema-form__col';
    row.dataset.rowuid = String(_rowUid++);   // stable key for drag-reorder
    if (col && col.name) row.dataset.origName = col.name;   // for rename diff
    const typeOpts = COLUMN_TYPES.map((t) => {
        const sel = t.value === col.type ? ' selected' : '';
        return `<option value="${_esc(t.value)}"${sel}>${_esc(t.label)}</option>`;
    }).join('');
    const defaultVal = col.default == null ? '' : String(col.default);
    row.innerHTML = `
        <span class="ea-schema-form__col-grip" data-role="col-grip"
              title="Drag to reorder" aria-hidden="true">
            <span class="material-symbols-outlined">drag_indicator</span>
        </span>
        <input class="ea-schema-form__col-name"
               data-col="name" type="text"
               value="${_esc(col.name || '')}"
               placeholder="column name" autocomplete="off">
        <select class="ea-schema-form__col-type" data-col="type">${typeOpts}</select>
        <label class="ea-schema-form__col-nullable"
               title="When checked, the column accepts NULL.">
            <input type="checkbox" data-col="nullable"
                   ${col.nullable ? 'checked' : ''}>
            <span>null</span>
        </label>
        <input class="ea-schema-form__col-default"
               data-col="default" type="text"
               value="${_esc(defaultVal)}"
               placeholder="default (optional)">
        <button type="button" class="ea-schema-form__col-remove"
                title="Remove this column"
                data-action="remove-column">
            <span class="material-symbols-outlined">delete</span>
        </button>
    `;
    row.querySelector('[data-action="remove-column"]')
        .addEventListener('click', () => row.remove());
    host.appendChild(row);
}


// ── Submit collection + validation ──────────────────────────────────

function _collect(body, frozenId, isEdit) {
    const rawId = isEdit
        ? frozenId
        : (body.querySelector('input[name="id"]')?.value || '').trim();
    const label = (body.querySelector('input[name="label"]')?.value || '').trim();
    const primaryKey = body.querySelector('select[name="primary_key"]')?.value || 'auto';
    const indexesText = (body.querySelector('input[name="indexes"]')?.value || '').trim();
    const maxRowsRaw = body.querySelector('input[name="max_rows"]')?.value;
    const maxRows = (maxRowsRaw === '' || maxRowsRaw == null)
        ? 50000 : Number(maxRowsRaw);

    if (!rawId) return { error: 'Id is required.' };
    if (!isEdit && !/^[a-z][a-z0-9_]*$/.test(rawId)) {
        return { error: 'Id must be lowercase letters / digits / underscores, starting with a letter.' };
    }

    const columns = [];
    const seen = new Set();
    const rows = body.querySelectorAll('[data-role="columns"] .ea-schema-form__col');
    for (const row of rows) {
        const name = row.querySelector('[data-col="name"]').value.trim();
        const type = row.querySelector('[data-col="type"]').value;
        const nullable = row.querySelector('[data-col="nullable"]').checked;
        const defaultRaw = row.querySelector('[data-col="default"]').value;
        if (!name) {
            return { error: 'Every column needs a name. (Found a blank row — remove or name it.)' };
        }
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
            return { error: `Column "${name}" — names must be letters / digits / underscores, starting with a letter or underscore.` };
        }
        if (seen.has(name)) {
            return { error: `Duplicate column name "${name}".` };
        }
        seen.add(name);
        if (!VALID_TYPES.has(type)) {
            return { error: `Column "${name}" — unknown type "${type}".` };
        }
        const col = { name, type, nullable };
        if (defaultRaw !== '') {
            const parsed = _coerceDefault(defaultRaw, type);
            if (parsed.error) {
                return { error: `Column "${name}" default: ${parsed.error}` };
            }
            col.default = parsed.value;
        }
        // Original name (when this row came from an existing column) so the
        // caller can diff renames vs add/drop. Non-enumerable-ish: callers
        // that persist the schema strip it.
        const orig = row.dataset.origName;
        if (orig) col._orig = orig;
        columns.push(col);
    }
    if (columns.length === 0) {
        return { error: 'At least one column is required.' };
    }

    if (primaryKey !== 'auto' && !seen.has(primaryKey)) {
        return { error: `Primary key "${primaryKey}" isn't one of the declared columns.` };
    }

    const indexes = indexesText
        ? indexesText.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    for (const idx of indexes) {
        if (!seen.has(idx)) {
            return { error: `Index "${idx}" isn't a declared column.` };
        }
    }

    return {
        schema: {
            id: rawId,
            label: label || rawId,
            columns,
            primary_key: primaryKey,
            indexes,
            max_rows: Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 50000,
        },
    };
}

/** Default values are typed strings in the UI; coerce them to the
 *  column's declared type so the saved schema carries native values
 *  (matches what the Python loader expects). */
function _coerceDefault(raw, type) {
    const s = String(raw).trim();
    if (type === 'int' || type === 'tick') {
        if (!/^-?\d+$/.test(s)) return { error: `expected an integer, got "${raw}"` };
        return { value: parseInt(s, 10) };
    }
    if (type === 'float') {
        const n = Number(s);
        if (!Number.isFinite(n)) return { error: `expected a number, got "${raw}"` };
        return { value: n };
    }
    if (type === 'bool') {
        const low = s.toLowerCase();
        if (low === 'true')  return { value: true };
        if (low === 'false') return { value: false };
        return { error: `expected "true" or "false", got "${raw}"` };
    }
    if (type === 'json') {
        try { return { value: JSON.parse(s) }; }
        catch { return { error: `not valid JSON: ${raw}` }; }
    }
    // str / agent_id pass through.
    return { value: s };
}


// ── Spec normalization ──────────────────────────────────────────────

function _normalizeSpec(spec, isEdit) {
    const cols = Array.isArray(spec?.columns)
        ? spec.columns.map((c) => ({
            name:     String(c?.name || ''),
            type:     VALID_TYPES.has(c?.type) ? c.type : 'str',
            nullable: c?.nullable !== false,
            default:  c?.default,
        }))
        : (isEdit ? [] : DEFAULT_NEW_COLUMNS.slice());
    return {
        id:           String(spec?.id || ''),
        label:        String(spec?.label || ''),
        columns:      cols,
        primary_key:  String(spec?.primary_key || 'auto'),
        indexes:      Array.isArray(spec?.indexes)
            ? spec.indexes.map((s) => String(s)) : [],
        max_rows:     Number.isFinite(Number(spec?.max_rows))
            ? Number(spec.max_rows) : 50000,
    };
}


function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
