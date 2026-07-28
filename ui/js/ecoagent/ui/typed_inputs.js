/**
 * Typed input widgets + value coercion — the single source of truth for
 * the column-type → input-widget mapping and the submit-time parse /
 * validate. Shared by the row editors (modal `openRowForm` and inline
 * `buildInlineRowEditor` in `row_form.js`) and, later, the schema column
 * editor. Mirrors the coercers in `ecoagent/sim/typed_table.py`.
 *
 * Column-type → widget:
 *   str / agent_id → text input
 *   int / tick     → number input (step 1; tick clamps min 0)
 *   float          → number input (step any)
 *   bool           → checkbox
 *   json           → textarea (JSON.parse'd on submit)
 *
 * Every widget carries an `ea-tin ea-tin--<group>` class so callers can
 * style type-aware (numbers right-aligned, json monospace, etc.) from
 * one place.
 */

export const ESCAPE_HTML = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Coarse styling group for a column type. */
export function typeGroup(type) {
    switch (type) {
        case 'int': case 'tick': case 'float': return 'num';
        case 'bool': return 'bool';
        case 'json': return 'json';
        default:     return 'text';
    }
}

/**
 * HTML for one column's input widget.
 * @param {{name:string,type?:string}} col
 * @param {*} value            current value (or null/undefined)
 * @param {boolean} locked     render disabled
 * @param {{placeholder?:string}} [opts]
 * @returns {string}
 */
export function widgetFor(col, value, locked, opts = {}) {
    const name = ESCAPE_HTML(col.name);
    const dis  = locked ? 'disabled' : '';
    const type = col.type || 'str';
    const cls  = `ea-tin ea-tin--${typeGroup(type)}`;
    const ph   = opts.placeholder ? ` placeholder="${ESCAPE_HTML(opts.placeholder)}"` : '';
    switch (type) {
        case 'bool': {
            const checked = (value === true || value === 'true' || value === 1)
                ? 'checked' : '';
            return `<input type="checkbox" class="${cls}" name="${name}" ${checked} ${dis}>`;
        }
        case 'int':
        case 'tick': {
            const v = (value == null) ? '' : ESCAPE_HTML(value);
            const min = (type === 'tick') ? 'min="0"' : '';
            return `<input type="number" step="1" ${min} class="${cls}" name="${name}" value="${v}"${ph} ${dis}>`;
        }
        case 'float': {
            const v = (value == null) ? '' : ESCAPE_HTML(value);
            return `<input type="number" step="any" class="${cls}" name="${name}" value="${v}"${ph} ${dis}>`;
        }
        case 'json': {
            const v = (value == null) ? '' : ESCAPE_HTML(
                typeof value === 'string' ? value : JSON.stringify(value, null, 2));
            const placeholder = opts.placeholder ? ESCAPE_HTML(opts.placeholder) : '{}';
            return `<textarea class="${cls}" name="${name}" rows="3" ${dis} placeholder="${placeholder}">${v}</textarea>`;
        }
        case 'str':
        case 'agent_id':
        default: {
            const v = (value == null) ? '' : ESCAPE_HTML(value);
            return `<input type="text" class="${cls}" name="${name}" value="${v}"${ph} ${dis}>`;
        }
    }
}

/**
 * Collect + coerce every column's value from a container holding the
 * widgets (each addressable by `[name="<col>"]`). Throws on a
 * required-but-empty (`nullable === false`) or an invalid value.
 * `isEdit` skips the primary-key column (PK is the row's identity).
 * @returns {Object}
 */
export function collectRow(container, columns, primaryKey, isEdit) {
    const out = {};
    for (const col of columns) {
        const name = col.name;
        if (!name) continue;
        const isPk = (name === primaryKey);
        if (isEdit && isPk) continue;
        const el = container.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!el) continue;
        const raw = el.type === 'checkbox' ? el.checked : el.value;
        if (raw === '' || raw == null) {
            if (col.nullable === false && col.type !== 'bool') {
                throw new Error(`column "${name}" is required`);
            }
            out[name] = null;
            continue;
        }
        out[name] = coerceValue(raw, col.type);
    }
    return out;
}

/** Coerce a raw input value into the column's value type (throws on bad input). */
export function coerceValue(raw, type) {
    switch (type) {
        case 'bool':
            return Boolean(raw);
        case 'int':
        case 'tick': {
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a valid integer`);
            return Math.trunc(n);
        }
        case 'float': {
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a valid number`);
            return n;
        }
        case 'json': {
            try { return JSON.parse(String(raw)); }
            catch (e) { throw new Error(`invalid JSON: ${e.message}`); }
        }
        case 'str':
        case 'agent_id':
        default:
            return String(raw);
    }
}
