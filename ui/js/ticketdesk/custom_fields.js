/**
 * ticketdesk/custom_fields.js — a record type's custom fields, as a form section.
 *
 * ONE control, mounted by every place a record is read or written: the bug page,
 * the backlog item page and the New item page. The fields come from the
 * project's schema (./schema.js) for the record's store and type, and the
 * section redraws when the type changes, because a Regression may carry fields a
 * Bug does not.
 *
 * Each field gets the control its type wants: a date picker, a number box, the
 * app's own dropdown for a choice, and Yes / No for a yes/no field (with an
 * empty choice, because "not answered" is different from "no").
 *
 * WHAT IS SENT is only what CHANGED. A record written before a field existed
 * opens with the field empty and saves without gaining a key nobody typed — the
 * same rule the Reporter field follows. A value whose field the schema no longer
 * names is shown read-only and marked, and is never sent, so a save keeps it.
 */

import { esc } from './data.js';
import { customFields, displayValue } from './schema.js';
import { attachSelect, setRowVisible } from './select_field.js';

let _seq = 1;

/**
 * @param {HTMLElement} slot   where the section goes (its content is replaced)
 * @param {object}  o
 * @param {string}  o.store    'bugs' | 'backlog'
 * @param {string}  o.type     the record type, as the store writes it
 * @param {object}  [o.values] the record's `fields` map
 * @param {boolean} [o.creating]  a new record: every required field is asked for
 * @param {Function} [o.onChange] called after any edit (to mark the page dirty)
 * @returns {{ setType(type: string): void, set(values: object): void,
 *            collect(): object, validate(): string|null, destroy(): void }}
 */
export function mountCustomFields(slot, { store, type, values = {}, creating = false, onChange = null } = {}) {
    let curType = type;
    let initial = { ...(values || {}) };
    let current = { ...initial };
    let selects = [];
    const uid = `cf${_seq++}`;

    const control = (f, v) => {
        const id = `${uid}-${f.name}`;
        const val = v == null ? '' : String(v);
        switch (f.type) {
            case 'number':
                return `<input class="ea-tin" id="${id}" data-cf="${esc(f.name)}" type="number" step="any" value="${esc(val)}">`;
            case 'date':
                return `<input class="ea-tin" id="${id}" data-cf="${esc(f.name)}" type="date" value="${esc(val)}">`;
            case 'bool':
            case 'choice':
                return `<select class="ea-tin" id="${id}" data-cf="${esc(f.name)}" data-cftype="${f.type}"></select>`;
            default:
                return `<input class="ea-tin" id="${id}" data-cf="${esc(f.name)}" value="${esc(val)}">`;
        }
    };

    const render = () => {
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        selects = [];
        const fields = customFields(store, curType);
        const known = new Set(fields.map((f) => f.name));
        const orphans = Object.entries(current).filter(([k, v]) => !known.has(k) && String(v ?? '') !== '');
        setRowVisible(slot, fields.length > 0 || orphans.length > 0);
        if (!fields.length && !orphans.length) { slot.innerHTML = ''; return; }
        slot.innerHTML = `
            <div class="td-group__title">Fields</div>
            <div class="td-group__body td-grid2">
                ${fields.map((f) => `
                <div class="td-field" data-cfrow="${esc(f.name)}">
                    <label for="${uid}-${esc(f.name)}" class="${f.required ? 'td-req' : ''}">${esc(f.label || f.name)}</label>
                    ${control(f, current[f.name])}
                </div>`).join('')}
                ${orphans.map(([k, v]) => `
                <div class="td-field td-cf-orphan" title="This record has a '${esc(k)}' value, but the schema for this type has no such field. It is kept as it is.">
                    <label>${esc(k)} <span class="td-chip td-chip--warn">not in the schema</span></label>
                    <input class="ea-tin" value="${esc(v)}" readonly>
                </div>`).join('')}
            </div>`;
        for (const el of slot.querySelectorAll('select[data-cf]')) {
            const f = fields.find((x) => x.name === el.dataset.cf);
            const options = f.type === 'bool'
                ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
                : f.values.map((v) => ({ value: v, label: v }));
            const name = f.name;
            selects.push(attachSelect(el, {
                options: [{ value: '', label: '—' }, ...options],
                value: normaliseForControl(f, current[name]),
                emptyLabel: '—',
                onChange: (v) => { current[name] = v; onChange?.(name, v); },
            }));
        }
    };

    const onInput = (e) => {
        const name = e.target.dataset?.cf;
        if (!name || e.target.tagName === 'SELECT') return;
        current[name] = e.target.value;
        onChange?.(name, e.target.value);
    };
    slot.addEventListener('input', onInput);
    render();

    return {
        setType(next) {
            if (next === curType) return;
            curType = next;
            render();
        },
        /** Reload from a saved record: what it now holds is the new baseline. */
        set(next) {
            initial = { ...(next || {}) };
            current = { ...initial };
            render();
        },
        /** `{ name: value }` for every schema field whose value changed. */
        collect() {
            const out = {};
            for (const f of customFields(store, curType)) {
                const was = normaliseForControl(f, initial[f.name]);
                const now = String(current[f.name] ?? '').trim();
                if (now !== was) out[f.name] = now;
            }
            return out;
        },
        /** The first problem, naming the field, or null. The bridge checks again. */
        validate() {
            for (const f of customFields(store, curType)) {
                const now = String(current[f.name] ?? '').trim();
                const was = normaliseForControl(f, initial[f.name]);
                // A new record is asked for every required field; an existing one
                // only refuses CLEARING one, so a record written before the field
                // existed still saves.
                if (f.required && !now && (creating || was !== '' || now !== was)) {
                    return `${f.label || f.name} is required.`;
                }
                if (now && f.type === 'number' && !Number.isFinite(Number(now))) return `${f.label || f.name} must be a number.`;
                if (now && f.type === 'choice' && !f.values.includes(now)) {
                    return `${f.label || f.name} must be one of ${f.values.join(', ')}.`;
                }
            }
            return null;
        },
        destroy() {
            slot.removeEventListener('input', onInput);
            for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        },
    };
}

/** A stored value as its control holds it: a yes/no is `true`/`false`, a
 *  choice matches its configured spelling. */
function normaliseForControl(f, raw) {
    const v = String(raw ?? '').trim();
    if (!v) return '';
    if (f.type === 'bool') return /^(true|yes|1)$/i.test(v) ? 'true' : 'false';
    if (f.type === 'choice') return f.values.find((x) => x.toLowerCase() === v.toLowerCase()) || v;
    return v;
}

/** A record's custom values as `[label, text]` pairs, for a read-only summary. */
export function customFieldPairs(store, type, values = {}) {
    return customFields(store, type)
        .filter((f) => String(values?.[f.name] ?? '') !== '')
        .map((f) => [f.label || f.name, displayValue(f, values[f.name])]);
}
