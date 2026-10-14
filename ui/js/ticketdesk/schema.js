/**
 * ticketdesk/schema.js — the project's record schema, as every page reads it.
 *
 * `.bugdesk/project.json`'s `schema` (see server/RecordSchema.cs) gives each
 * record type its own fields, hides optional built-in fields and adds statuses.
 * The bridge sends it with the config, before any page module is evaluated, so
 * it is read here once at load — the same way the roster is — and a saved
 * change takes effect on the next reload. `setSchema` updates the live copy for
 * the page that saved it.
 *
 * TYPES ARE KEYED BY STORE: the bug store's `task` (shown as Chore) and the
 * backlog's `task` are different records with different fields. Every function
 * here takes the store as well as the type.
 *
 * A custom field's value lives in the record as one more frontmatter line, and
 * the bridge hands it over as `record.fields[name]` — a string, whatever the
 * type. Nothing here rewrites a record: hiding or removing a field changes what
 * is shown, and the values stay in the files.
 */

import { CONFIG, apiUrl } from './instance.js';

const EMPTY = { types: {}, warnings: [], hideable: {}, builtinStatuses: {}, fieldTypes: [], categories: [] };

let S = normalise(CONFIG.schema);

function normalise(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        types: s.types && typeof s.types === 'object' ? s.types : {},
        warnings: Array.isArray(s.warnings) ? s.warnings : [],
        hideable: s.hideable || { bugs: ['severity', 'subsystem', 'labels', 'links'],
            backlog: ['phase', 'due', 'points', 'subsystem', 'labels', 'links'] },
        builtinStatuses: s.builtinStatuses || {},
        fieldTypes: s.fieldTypes?.length ? s.fieldTypes : ['text', 'number', 'date', 'bool', 'choice'],
        categories: s.categories?.length ? s.categories : ['active', 'waiting', 'finished'],
    };
}

/** What a field type is called in the UI. */
export const FIELD_TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', bool: 'Yes/no', choice: 'Choice' };
export const CATEGORY_LABEL = { active: 'Active', waiting: 'Waiting', finished: 'Finished' };

/** The record types of a store, as `[type, label]`. */
export const STORE_TYPES = {
    bugs: [['bug', 'Bug'], ['regression', 'Regression'], ['task', 'Chore']],
    backlog: [['project', 'Project'], ['epic', 'Epic'], ['story', 'Story'], ['task', 'Task']],
};

export const schemaWarnings = () => S.warnings;
export const hideableFields = (store) => S.hideable[store] || [];
export const fieldTypes = () => S.fieldTypes;
export const statusCategories = () => S.categories;

/** The whole `types` object, for the editor to start from. A deep copy. */
export const schemaTypes = () => JSON.parse(JSON.stringify(S.types || {}));

/** One type's spec, always with all three lists. */
export function typeSpec(store, type) {
    const t = S.types?.[store]?.[type] || {};
    return {
        fields: Array.isArray(t.fields) ? t.fields : [],
        hidden: Array.isArray(t.hidden) ? t.hidden : [],
        statuses: Array.isArray(t.statuses) ? t.statuses : [],
    };
}

/** A type's custom fields, in their configured order. */
export const customFields = (store, type) => typeSpec(store, type).fields;

/**
 * The custom fields of every type in `types` (all of the store's when omitted),
 * one entry per field NAME, with the types that carry it. What a list showing
 * several types at once offers as columns and filter conditions.
 */
export function storeFields(store, types = null) {
    const wanted = types || (STORE_TYPES[store] || []).map(([t]) => t);
    const byName = new Map();
    for (const t of wanted) {
        for (const f of customFields(store, t)) {
            const have = byName.get(f.name);
            if (have) { have.types.push(t); continue; }
            byName.set(f.name, { ...f, types: [t] });
        }
    }
    return [...byName.values()];
}

/** Is this built-in field hidden for this type? */
export const isHidden = (store, type, field) => typeSpec(store, type).hidden.includes(field);

/**
 * Hidden for EVERY type in view — the rule for a list, a column chooser or a
 * filter that shows several types at once: a field hidden on bugs but used on
 * regressions is still a column worth offering.
 */
export function hiddenForAll(store, field, types = null) {
    const wanted = types || (STORE_TYPES[store] || []).map(([t]) => t);
    return wanted.length > 0 && wanted.every((t) => isHidden(store, t, field));
}

/* ── statuses ──────────────────────────────────────────────────────── */

const builtinCategory = (store, status) =>
    (S.builtinStatuses?.[store] || []).find((s) => s.name === status)?.category
    ?? ({ closed: 'finished', done: 'finished', dropped: 'finished' }[status] || (status ? 'active' : null));

/** A type's custom statuses, in their configured order. */
export const customStatuses = (store, type) => typeSpec(store, type).statuses;

/** The custom status entry, or null for a built-in or unknown one. */
export const customStatus = (store, type, status) =>
    customStatuses(store, type).find((s) => s.name === status) || null;

/** Every custom status of the store, across types, one per name. */
export function storeStatuses(store) {
    const seen = new Map();
    for (const [t] of STORE_TYPES[store] || []) {
        for (const s of customStatuses(store, t)) if (!seen.has(s.name)) seen.set(s.name, s);
    }
    return [...seen.values()];
}

const BUILTIN_STATUS_NAMES = {
    bugs: ['open', 'investigation', 'testing', 'closed'],
    backlog: ['draft', 'refined', 'in-progress', 'review', 'done', 'dropped'],
};

/** Is `status` known for this type — built in, or configured? A record can hold
 *  one that is neither (a status removed from the schema, a hand edit); it opens
 *  normally and the page marks the value. */
export const statusKnown = (store, type, status) =>
    (BUILTIN_STATUS_NAMES[store] || []).includes(status) || !!customStatus(store, type, status);

/**
 * What a status counts as: `active`, `waiting` or `finished`. A custom status
 * says so itself; a built-in one by its fixed category. An unknown status — a
 * value in a file the schema no longer names — counts as active, so the record
 * stays in the open queues where somebody will see it and fix it.
 */
export function statusCategory(store, type, status) {
    const c = customStatus(store, type, status);
    if (c) return c.category;
    if (!status) return 'active';
    return builtinCategory(store, status) || 'active';
}

export const isFinished = (store, type, status) => statusCategory(store, type, status) === 'finished';

/** A custom status's label, or null for any other. */
export const customStatusLabel = (store, type, status) => customStatus(store, type, status)?.label || null;

/**
 * A type's statuses in order: `base` (the built-in ladder) with each custom
 * status placed after the one it names in `after`, or at the end of the active
 * ones when it names none. That order is what chevrons, status menus and a sort
 * by status use.
 */
export function withCustomStatuses(store, type, base) {
    const out = [...base];
    const finishedAt = () => {
        const i = out.findIndex((s) => isFinished(store, type, s));
        return i < 0 ? out.length : i;
    };
    for (const s of customStatuses(store, type)) {
        if (out.includes(s.name)) continue;
        const at = s.after ? out.indexOf(s.after) : -1;
        if (at >= 0) out.splice(at + 1, 0, s.name);
        else if (s.category === 'finished') out.push(s.name);
        else out.splice(finishedAt(), 0, s.name);
    }
    return out;
}

/* ── values ───────────────────────────────────────────────────────── */

/** A field's value as text for a cell or a read-only view. */
export function displayValue(field, raw) {
    const v = raw == null ? '' : String(raw);
    if (!v) return '';
    if (field?.type === 'bool') return /^(true|yes|1)$/i.test(v) ? 'Yes' : 'No';
    return v;
}

/** A value as the thing it sorts by: dates and numbers as themselves. */
export function sortValue(field, raw) {
    const v = raw == null ? '' : String(raw).trim();
    if (!v) return null;
    if (field?.type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : null; }
    if (field?.type === 'bool') return /^(true|yes|1)$/i.test(v) ? 1 : 0;
    return v.toLowerCase();
}

/* ── saving ───────────────────────────────────────────────────────── */

/**
 * Save the schema. Resolves to the saved schema, which also becomes this page's
 * live copy; rejects with the bridge's message (every problem, one per line).
 */
export async function saveSchema(types) {
    const res = await fetch(apiUrl('/project/schema'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ schema: types }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
        const err = new Error(j?.error || `saving the schema failed (${res.status})`);
        err.problems = j?.problems || [];
        throw err;
    }
    setSchema(j.schema);
    return S;
}

/** Replace the live copy — after a save, or in a test. */
export function setSchema(raw) {
    S = raw ? normalise(raw) : { ...EMPTY };
    if (CONFIG && typeof CONFIG === 'object') CONFIG.schema = raw;
}

/* ── filters ──────────────────────────────────────────────────────── */

/** Where a custom field lives in a filter clause: `cf.<name>`, so it can never
 *  collide with a built-in key, today's or a future one. */
export const CF_PREFIX = 'cf.';

const YES_NO = [{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }];

/**
 * The store's custom fields as filter-catalogue entries (filter_engine.js's
 * `{ key, label, type, get, options }`), with the operators that suit each type:
 * contains for text, comparisons for number and date, one-of for choice, is /
 * is not for yes/no. `get` reads `row.fields[name]`, which both stores' rows
 * carry.
 */
export function customFilterFields(store) {
    return storeFields(store).map((f) => {
        const raw = (row) => row?.fields?.[f.name];
        const base = { key: CF_PREFIX + f.name, label: f.label || f.name, custom: true };
        switch (f.type) {
            case 'number':
                return { ...base, type: 'number', get: (r) => { const n = Number(raw(r)); return raw(r) === undefined || raw(r) === '' || !Number.isFinite(n) ? null : n; } };
            case 'date':
                return { ...base, type: 'date', get: (r) => String(raw(r) ?? '') };
            case 'choice':
                return { ...base, type: 'enum', options: f.values, get: (r) => String(raw(r) ?? '') };
            case 'bool':
                return { ...base, type: 'enum', options: YES_NO,
                    get: (r) => { const v = String(raw(r) ?? ''); return v ? (/^(true|yes|1)$/i.test(v) ? 'true' : 'false') : ''; } };
            default:
                return { ...base, type: 'text', get: (r) => String(raw(r) ?? '') };
        }
    });
}

/**
 * Mark the built-in catalogue entries a project hides on every type of the
 * store (Settings › Record types). A hidden entry stays in the catalogue — a
 * saved filter on it keeps working — but the editor no longer offers it.
 */
export function markHiddenFilterFields(store, fields) {
    for (const f of fields) {
        if (hideableFields(store).includes(f.key) && hiddenForAll(store, f.key)) f.hidden = true;
    }
    return fields;
}

/* ── "Snooze until" — the default example field (TASK-0004) ────────────
 * A date before which a record is left out of the open views: "don't show me
 * this until the 3rd". Not built in — it is a custom field like any other, which
 * every type has until the project configures its store (server/RecordSchema.cs)
 * — and the rail's "Snoozed" view is built on it. A store whose types no longer
 * carry it behaves as if snoozing did not exist. */

export const SNOOZE_FIELD = Object.freeze({ name: 'not_before', label: 'Snooze until', type: 'date', required: false, values: [] });

/** Does any type of this store carry the snooze field? */
export const snoozeConfigured = (store) => storeFields(store).some((f) => f.name === SNOOZE_FIELD.name && f.type === 'date');

const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Is this record snoozed — its type carries the field, and the date is still ahead? */
export function isSnoozed(store, type, fields) {
    if (!customFields(store, type).some((f) => f.name === SNOOZE_FIELD.name)) return false;
    const v = String(fields?.[SNOOZE_FIELD.name] ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) && v > todayISO();
}

/**
 * The notice the "Snoozed" view shows where no type carries the field (it was
 * removed in Settings), with the button that opens Record types to add it back —
 * rather than an empty list that says nothing.
 * Returns the element, or null when the field is there.
 */
export function snoozeNotice(store, eventBus = null) {
    if (snoozeConfigured(store) || typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'td-snooze-notice';
    el.innerHTML = `<span class="material-symbols-outlined">snooze</span>
        <span>Snoozing a record needs a <b>Snooze until</b> date field (named <code>not_before</code>) on its type. No type here has one.</span>
        <button type="button" class="ea-btn ea-btn--primary"><span class="material-symbols-outlined">tune</span> Record types</button>`;
    el.querySelector('button').addEventListener('click', async () => {
        const { openSchemaEditor } = await import('./schema_editor.js');
        openSchemaEditor({ eventBus, store });
    });
    return el;
}
