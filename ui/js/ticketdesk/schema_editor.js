/**
 * ticketdesk/schema_editor.js — Settings › Record types: the project's custom
 * fields, hidden built-in fields and custom statuses, per record type, and how
 * new records of each type are named and numbered.
 *
 * Modelled on Tables' Create table dialog (`../Tables/web/js/dialogs/
 * table_dialog.js`): the record types down the left, and for the chosen one a
 * row per field — name, label, type, required, and a choice field's values.
 * Below them, the built-in fields the type may hide and the statuses it adds.
 *
 * What it edits is `.bugdesk/project.json`'s `schema` (server/RecordSchema.cs)
 * and `numbering` (server/Numbering.cs), which are committed: everyone who pulls
 * the repo gets the same ones. It is drawn on the Settings page itself
 * (STORY-0032), like the workflow, with one Save for both. The bridge checks a
 * save strictly and refuses all of it on any problem, listing each; the list is
 * shown on the page and nothing typed is lost. Unsaved changes are still there
 * when you come back to the page.
 *
 * NUMBERING used to be an editor of its own, but a prefix belongs to a type:
 * each backlog type has one, and the bug types share one. The padding, first
 * number and increment belong to a store (a backlog's types share one number
 * sequence), so they are shown on every type of that store and edit the same
 * value. Nothing is renamed by a change: records keep the names they were
 * written under, and a prefix the save replaces stays readable, so links and
 * typed references to old records still resolve.
 *
 * A saved field or status keeps its NAME: records hold it as a frontmatter key
 * or a status value, and renaming the key would strand every value already
 * written. The label is what a person renames. Removing a field asks first and
 * leaves its values in the files.
 */

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { CONFIG, apiUrl } from './instance.js';
import {
    CATEGORY_LABEL, FIELD_TYPE_LABEL, STORE_TYPES,
    fieldTypes, hideableFields, saveSchema, schemaTypes, schemaWarnings, statusCategories,
} from './schema.js';
import { attachSelect } from './select_field.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

const BUILTIN_STATUS = {
    bugs: ['open', 'investigation', 'testing', 'closed'],
    backlog: ['draft', 'refined', 'in-progress', 'review', 'done', 'dropped'],
};

const FIELD_LABEL = {
    severity: 'Severity', subsystem: 'Subsystem', labels: 'Labels', links: 'Links',
    phase: 'Phase', due: 'Due', points: 'Points',
};

/** What hiding each built-in also switches off, said where the box is ticked. */
const HIDE_EFFECT = {
    due: 'also turns off overdue highlighting',
    points: 'also turns off the estimate check in refinement',
    severity: 'the queue then sorts by status and date instead',
    phase: 'phase grouping on the board is turned off',
};

/** Numbering when project.json sets none — the server's defaults (Numbering.cs). */
const NUMBERING_DEFAULT = {
    bugs: { prefix: 'BUG', pad: 4, start: 1, step: 1 },
    backlog: { prefix: { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' }, pad: 4, start: 1, step: 1 },
};

/** Unsaved changes, kept across leaving the page: `{base, draft, num, curStore, curType}`. */
let _kept = null;

/** The stores this page can configure, with the types it offers for each. */
function storesHere() {
    const store = CONFIG.store || {};
    const out = [];
    if (store.hasBugs !== false && CONFIG.mode !== 'tracker') out.push('bugs');
    if (store.hasBacklog !== false) out.push('backlog');
    return out;
}

const STORE_LABEL = { bugs: 'Bugs', backlog: () => (CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog') };
const storeLabel = (s) => (typeof STORE_LABEL[s] === 'function' ? STORE_LABEL[s]() : STORE_LABEL[s]);

/** The schema as this page edits it: every store and type present, so switching
 *  types never meets a hole, and saved rows marked (their names are fixed). */
function schemaDraft(stores) {
    const draft = schemaTypes();
    for (const s of stores) {
        draft[s] = draft[s] || {};
        for (const [t] of STORE_TYPES[s]) {
            const spec = draft[s][t] || {};
            draft[s][t] = {
                fields: (spec.fields || []).map((f) => ({ ...f, values: [...(f.values || [])], saved: true })),
                hidden: [...(spec.hidden || [])],
                statuses: (spec.statuses || []).map((x) => ({ ...x, saved: true })),
            };
        }
    }
    return draft;
}

/** The numbering as this page edits it: numbers as strings, as typed. */
function numberingDraft() {
    const cur = CONFIG.numbering || NUMBERING_DEFAULT;
    const bugs = { ...NUMBERING_DEFAULT.bugs, ...(cur.bugs || {}) };
    const back = { ...NUMBERING_DEFAULT.backlog, ...(cur.backlog || {}),
        prefix: { ...NUMBERING_DEFAULT.backlog.prefix, ...(cur.backlog?.prefix || {}) } };
    const nums = (x) => ({ pad: String(x.pad), start: String(x.start), step: String(x.step) });
    return {
        bugs: { prefix: bugs.prefix, ...nums(bugs) },
        backlog: { prefix: { ...back.prefix }, ...nums(back) },
    };
}

/**
 * Fill `el` with the Record types page. Returns its cleanup.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {string} [o.store]   preselect a store
 * @param {string} [o.type]    and a type
 */
export function mountRecordTypes(el, { eventBus = null, store = null, type = null } = {}) {
    const stores = storesHere();
    let draft = schemaDraft(stores);
    let num = numberingDraft();
    let base = JSON.stringify({ draft, num });

    let curStore = stores.includes(store) ? store : stores[0];
    let curType = type && STORE_TYPES[curStore]?.some(([t]) => t === type) ? type : STORE_TYPES[curStore][0][0];
    let note = '';
    if (_kept) {
        if (_kept.base === base) {
            ({ draft, num } = _kept);
            if (!store) ({ curStore, curType } = _kept);
        } else note = 'Your unsaved changes to record types were dropped: they were saved elsewhere meanwhile.';
        _kept = null;
    }
    let confirmRemove = null;      // `field:<i>` or `status:<i>` awaiting a yes
    let problems = [];
    let selects = [];
    let saving = false;

    const body = document.createElement('div');
    body.className = 'bd-schema bd-schema--page';

    const spec = () => draft[curStore][curType];
    const dirty = () => JSON.stringify({ draft, num }) !== base;

    /** The bar's state and Save/Discard, without redrawing the page under the caret. */
    const syncBar = () => {
        const changed = dirty();
        const state = body.querySelector('[data-slot="state"]');
        if (state) state.textContent = note || (changed ? 'Unsaved changes' : '');
        for (const b of body.querySelectorAll('[data-act]')) b.disabled = saving || !changed;
    };

    const typeNav = () => stores.map((s) => `
        <div class="bd-schema__group">${esc(storeLabel(s))}</div>
        ${STORE_TYPES[s].map(([t, label]) => {
            const sp = draft[s][t];
            const n = sp.fields.length + sp.statuses.length + sp.hidden.length;
            const on = s === curStore && t === curType;
            return `<button type="button" class="bd-schema__type${on ? ' bd-schema__type--on' : ''}"
                        data-store="${s}" data-type="${t}" aria-pressed="${on}">
                        ${esc(label)}${n ? `<span class="bd-schema__count">${n}</span>` : ''}
                    </button>`;
        }).join('')}`).join('');

    const fieldRows = () => {
        const fields = spec().fields;
        if (!fields.length) return '<div class="td-dim bd-schema__empty">No custom fields on this type.</div>';
        return `<div class="bd-schema__fhdr"><span></span><span>Name</span><span>Label</span><span>Type</span>
                    <span>Required</span><span></span></div>`
            + fields.map((f, i) => {
                if (confirmRemove === `field:${i}`) {
                    return `<div class="bd-schema__confirm">
                        Remove <b>${esc(f.label || f.name)}</b>? Values already in records stay in the files.
                        <button type="button" class="ea-btn ea-btn--danger" data-yes="field:${i}">Remove</button>
                        <button type="button" class="ea-btn" data-no="1">Keep</button>
                    </div>`;
                }
                return `<div class="ea-modal__row bd-schema__frow" data-field="${i}">
                    <span class="bd-schema__move">
                        <button type="button" data-up="field:${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow_upward')}</button>
                        <button type="button" data-down="field:${i}" title="Move down" ${i === fields.length - 1 ? 'disabled' : ''}>${icon('arrow_downward')}</button>
                    </span>
                    <input type="text" class="td-mono" data-k="name" value="${esc(f.name)}" ${f.saved ? 'readonly title="A saved field keeps its name: records hold it as a key. Rename the label."' : ''}
                           placeholder="not_before" aria-label="Field name">
                    <input type="text" data-k="label" value="${esc(f.label || '')}" placeholder="Not before" aria-label="Label">
                    <select data-k="type" data-sel="field:${i}">${fieldTypes().map((t) =>
                        `<option value="${t}"${t === f.type ? ' selected' : ''}>${esc(FIELD_TYPE_LABEL[t] || t)}</option>`).join('')}</select>
                    <label class="bd-schema__req"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}></label>
                    <button type="button" class="bd-schema__rm" data-rm="field:${i}" title="Remove this field">${icon('close')}</button>
                    ${f.type === 'choice' ? `
                    <div class="bd-schema__values">
                        <span class="td-dim">Values</span>
                        <input type="text" data-k="values" value="${esc((f.values || []).join(', '))}"
                               placeholder="low, medium, high" aria-label="Choice values, comma-separated">
                    </div>` : ''}
                </div>`;
            }).join('');
    };

    const hiddenRows = () => {
        const list = hideableFields(curStore);
        return list.map((name) => `
            <label class="bd-schema__hide">
                <input type="checkbox" data-hide="${name}" ${spec().hidden.includes(name) ? '' : 'checked'}>
                <span>${esc(FIELD_LABEL[name] || name)}</span>
                ${HIDE_EFFECT[name] ? `<span class="td-dim">— hiding it ${esc(HIDE_EFFECT[name])}</span>` : ''}
            </label>`).join('');
    };

    const statusRows = () => {
        const sts = spec().statuses;
        const builtins = BUILTIN_STATUS[curStore];
        const head = `<div class="td-dim bd-schema__builtin">Built in: ${builtins.map((b) => `<code>${esc(b)}</code>`).join(' ')}</div>`;
        if (!sts.length) return head + '<div class="td-dim bd-schema__empty">No custom statuses on this type.</div>';
        return head + `<div class="bd-schema__shdr"><span></span><span>Name</span><span>Label</span><span>Counts as</span>
                    <span>After</span><span></span></div>`
            + sts.map((st, i) => {
                if (confirmRemove === `status:${i}`) {
                    return `<div class="bd-schema__confirm">
                        Remove the status <b>${esc(st.label || st.name)}</b>? It is refused while records still hold it.
                        <button type="button" class="ea-btn ea-btn--danger" data-yes="status:${i}">Remove</button>
                        <button type="button" class="ea-btn" data-no="1">Keep</button>
                    </div>`;
                }
                const afterOpts = ['', ...builtins, ...sts.filter((_, j) => j !== i).map((x) => x.name).filter(Boolean)];
                return `<div class="ea-modal__row bd-schema__srow" data-status="${i}">
                    <span class="bd-schema__move">
                        <button type="button" data-up="status:${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow_upward')}</button>
                        <button type="button" data-down="status:${i}" title="Move down" ${i === sts.length - 1 ? 'disabled' : ''}>${icon('arrow_downward')}</button>
                    </span>
                    <input type="text" class="td-mono" data-k="name" value="${esc(st.name)}" ${st.saved ? 'readonly title="A saved status keeps its name: records hold it. Rename the label."' : ''}
                           placeholder="blocked" aria-label="Status name">
                    <input type="text" data-k="label" value="${esc(st.label || '')}" placeholder="Blocked" aria-label="Label">
                    <select data-k="category" data-sel="status:${i}">${statusCategories().map((c) =>
                        `<option value="${c}"${c === st.category ? ' selected' : ''}>${esc(CATEGORY_LABEL[c] || c)}</option>`).join('')}</select>
                    <select data-k="after" data-sel="after:${i}">${afterOpts.map((a) =>
                        `<option value="${esc(a)}"${a === (st.after || '') ? ' selected' : ''}>${a ? esc(a) : 'Before the finished ones'}</option>`).join('')}</select>
                    <button type="button" class="bd-schema__rm" data-rm="status:${i}" title="Remove this status">${icon('close')}</button>
                </div>`;
            }).join('');
    };

    /** Name and number: the type's prefix, and its store's number sequence. */
    const numberingRows = () => {
        const n = num[curStore];
        const isBugs = curStore === 'bugs';
        const prefix = isBugs ? n.prefix : n.prefix[curType];
        const sample = `${String(prefix || '').toUpperCase() || 'PREFIX'}-${String(Number(n.start) || 1).padStart(Number(n.pad) || 0, '0')}`;
        const shared = isBugs ? 'every bug type' : `every ${storeLabel(curStore).toLowerCase()} type — one number sequence`;
        const row = (k, label, value, hint) => `
            <label class="ea-modal__row bd-schema__num">
                <span>${esc(label)}</span>
                <input type="text" class="td-mono" data-num="${k}" value="${esc(value)}" aria-label="${esc(label)}">
                <span class="td-dim">${esc(hint)}</span>
            </label>`;
        return row('prefix', 'Prefix', prefix, isBugs
                ? 'Letters only. Shared by every bug type.'
                : 'Letters only, and not one another type uses.')
            + `<div class="td-dim bd-schema__hint">Shared by ${esc(shared)}:</div>`
            + row('pad', 'Zero-padding', n.pad, 'Digits the number is padded to; 0 for none.')
            + row('start', 'First number', n.start, 'No new record is numbered below this.')
            + row('step', 'Increment', n.step, 'How far each new number is above the highest ever used.')
            + `<div class="td-dim bd-schema__hint">The next new one is named like <code data-slot="sample">${esc(sample)}</code>. Existing records keep their names, and references to them keep working.</div>`;
    };

    const render = () => {
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        selects = [];
        const warnings = schemaWarnings();
        const typeLabel = STORE_TYPES[curStore].find(([t]) => t === curType)?.[1] || curType;
        body.innerHTML = `
            <div class="bd-schema__bar">
                <span class="bd-schema__state td-dim" data-slot="state" aria-live="polite"></span>
                <button type="button" class="ea-btn" data-act="discard">Discard changes</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>
            <nav class="bd-schema__nav" aria-label="Record types">${typeNav()}</nav>
            <div class="bd-schema__main">
                ${warnings.length ? `<div class="bd-schema__warn">${icon('warning')}<div>
                    The schema in project.json has problems, and those entries are not in effect:
                    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>` : ''}
                ${problems.length ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${
                    problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
                <h3 class="bd-schema__h">${esc(storeLabel(curStore))} › ${esc(typeLabel)}</h3>
                <section>
                    <div class="bd-schema__shead"><h4>Name and number</h4></div>
                    <div class="bd-schema__nums">${numberingRows()}</div>
                </section>
                <section>
                    <div class="bd-schema__shead"><h4>Custom fields</h4>
                        <button type="button" class="ea-btn" data-add="field">${icon('add')} Add field</button></div>
                    <div class="bd-schema__fields">${fieldRows()}</div>
                </section>
                <section>
                    <div class="bd-schema__shead"><h4>Built-in fields shown</h4></div>
                    <div class="td-dim bd-schema__hint">Hiding a field only hides it. Its values stay in the records and come back when it is shown again.</div>
                    <div class="bd-schema__hides">${hiddenRows()}</div>
                </section>
                <section>
                    <div class="bd-schema__shead"><h4>Custom statuses</h4>
                        <button type="button" class="ea-btn" data-add="status">${icon('add')} Add status</button></div>
                    <div class="bd-schema__statuses">${statusRows()}</div>
                </section>
            </div>
            <div class="td-dim bd-schema__foot">Saved to .bugdesk/project.json — commit it to share it.</div>`;
        syncBar();

        for (const el of body.querySelectorAll('select[data-sel]')) {
            const [kind, idx] = el.dataset.sel.split(':');
            const k = el.dataset.k;
            const opts = [...el.options].map((o) => ({ value: o.value, label: o.textContent }));
            selects.push(attachSelect(el, {
                options: opts, value: el.value,
                onChange: (v) => {
                    const row = kind === 'field' ? spec().fields[Number(idx)] : spec().statuses[Number(idx)];
                    row[k] = v;
                    // A choice field gets its values row; any other loses it.
                    if (kind === 'field' && k === 'type') render(); else syncBar();
                },
            }));
        }
    };

    const rowOf = (el) => {
        const f = el.closest('[data-field]');
        if (f) return spec().fields[Number(f.dataset.field)];
        const s = el.closest('[data-status]');
        if (s) return spec().statuses[Number(s.dataset.status)];
        return null;
    };

    body.addEventListener('input', (e) => {
        const nk = e.target.dataset?.num;
        if (nk) {
            const n = num[curStore];
            if (nk === 'prefix' && curStore !== 'bugs') n.prefix[curType] = e.target.value.trim();
            else n[nk] = e.target.value.trim();
            const sample = body.querySelector('[data-slot="sample"]');
            const prefix = curStore === 'bugs' ? n.prefix : n.prefix[curType];
            if (sample) sample.textContent = `${String(prefix || '').toUpperCase() || 'PREFIX'}-${String(Number(n.start) || 1).padStart(Number(n.pad) || 0, '0')}`;
            syncBar();
            return;
        }
        const k = e.target.dataset?.k;
        const row = k ? rowOf(e.target) : null;
        if (!row) return;
        if (k === 'values') row.values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
        else if (k === 'required') row.required = e.target.checked;
        else if (k === 'name') row.name = e.target.value.trim().toLowerCase();
        else row[k] = e.target.value;
        syncBar();
    });

    body.addEventListener('change', (e) => {
        if (e.target.dataset?.k === 'required') { const row = rowOf(e.target); if (row) row.required = e.target.checked; }
        const hide = e.target.dataset?.hide;
        if (hide) {
            const h = spec().hidden;
            const at = h.indexOf(hide);
            if (e.target.checked && at >= 0) h.splice(at, 1);
            if (!e.target.checked && at < 0) h.push(hide);
            renderNavOnly();
        }
        syncBar();
    });

    const renderNavOnly = () => {
        const nav = body.querySelector('.bd-schema__nav');
        if (nav) nav.innerHTML = typeNav();
    };

    const move = (ref, by) => {
        const [kind, idx] = ref.split(':');
        const list = kind === 'field' ? spec().fields : spec().statuses;
        const i = Number(idx), j = i + by;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        render();
    };

    body.addEventListener('click', async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.store) {
            curStore = t.dataset.store; curType = t.dataset.type; confirmRemove = null; render(); return;
        }
        if (t.dataset.add === 'field') {
            spec().fields.push({ name: '', label: '', type: 'text', required: false, values: [] });
            render();
            body.querySelector(`[data-field="${spec().fields.length - 1}"] [data-k="name"]`)?.focus();
            return;
        }
        if (t.dataset.add === 'status') {
            spec().statuses.push({ name: '', label: '', category: 'waiting', after: '' });
            render();
            body.querySelector(`[data-status="${spec().statuses.length - 1}"] [data-k="name"]`)?.focus();
            return;
        }
        if (t.dataset.up) { move(t.dataset.up, -1); return; }
        if (t.dataset.down) { move(t.dataset.down, 1); return; }
        if (t.dataset.rm) {
            const [kind, idx] = t.dataset.rm.split(':');
            const list = kind === 'field' ? spec().fields : spec().statuses;
            // An unsaved row was never in any file: remove it outright.
            if (!list[Number(idx)].saved) { list.splice(Number(idx), 1); render(); return; }
            confirmRemove = t.dataset.rm; render(); return;
        }
        if (t.dataset.yes) {
            const [kind, idx] = t.dataset.yes.split(':');
            (kind === 'field' ? spec().fields : spec().statuses).splice(Number(idx), 1);
            confirmRemove = null; render(); return;
        }
        if (t.dataset.no) { confirmRemove = null; render(); return; }
        if (t.dataset.act === 'discard') {
            ({ draft, num } = JSON.parse(base));
            problems = []; note = ''; confirmRemove = null;
            render();
            return;
        }
        if (t.dataset.act === 'save') await save();
    });

    /** The draft as the bridge wants it: no `saved` markers, no empty rows. */
    const payload = () => {
        const out = {};
        for (const s of stores) {
            for (const [t] of STORE_TYPES[s]) {
                const sp = draft[s][t];
                const fields = sp.fields
                    .filter((f) => f.name || f.label)
                    .map(({ name, label, type: ft, required, values }) => ({
                        name: name || String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
                        label, type: ft, required: !!required, values: ft === 'choice' ? values : [],
                    }));
                const statuses = sp.statuses
                    .filter((x) => x.name || x.label)
                    .map(({ name, label, category, after }) => ({
                        name: name || String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                        label, category, after: after || '',
                    }));
                if (!fields.length && !statuses.length && !sp.hidden.length) continue;
                out[s] = out[s] || {};
                out[s][t] = { fields, hidden: sp.hidden, statuses };
            }
        }
        // Keep what this page cannot show (a tracker's own types, say) as it was.
        const before = schemaTypes();
        for (const [s, types] of Object.entries(before)) if (!stores.includes(s)) out[s] = types;
        return out;
    };

    /** The numbering as the bridge wants it, with the prefixes it still reads. */
    const numberingPayload = () => {
        const cur = CONFIG.numbering || {};
        const int = (v) => (String(v).trim() === '' ? NaN : Number(v));
        return {
            bugs: { prefix: num.bugs.prefix, pad: int(num.bugs.pad), start: int(num.bugs.start), step: int(num.bugs.step),
                    previous: cur.bugs?.previous || [] },
            backlog: { prefix: { ...num.backlog.prefix },
                       pad: int(num.backlog.pad), start: int(num.backlog.start), step: int(num.backlog.step),
                       previous: cur.backlog?.previous || {} },
        };
    };

    const saveNumbering = async () => {
        const res = await fetch(apiUrl('/project/numbering'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ numbering: numberingPayload() }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) {
            const err = new Error(`Numbering not saved: ${String(j?.error || `HTTP ${res.status}`).replace(/\n/g, ' · ')}`);
            throw err;
        }
        CONFIG.numbering = j.numbering;
    };

    /** Each half is sent only if it changed: the schema, then the numbering. */
    const save = async () => {
        problems = []; note = '';
        saving = true;
        syncBar();
        const was = JSON.parse(base);
        const saved = [];
        try {
            if (JSON.stringify(draft) !== JSON.stringify(was.draft)) {
                await saveSchema(payload());
                saved.push('Record types');
                draft = schemaDraft(stores);
            }
            if (JSON.stringify(num) !== JSON.stringify(was.num)) {
                await saveNumbering();
                saved.push('numbering');
                num = numberingDraft();
            }
        } catch (err) {
            problems = err.problems?.length ? err.problems : [err.message || String(err)];
        }
        saving = false;
        // What did save is the new base, so a half that failed stays unsaved.
        if (saved.includes('Record types')) was.draft = schemaDraft(stores);
        if (saved.includes('numbering')) was.num = numberingDraft();
        base = JSON.stringify(was);
        if (saved.length) {
            eventBus?.emit?.('toast:show', {
                type: 'info',
                message: `${saved.join(' and ').replace(/^./, (c) => c.toUpperCase())} saved to project.json. Reload ${appName()} for every page to use ${saved.length > 1 ? 'them' : 'it'}.`,
            });
        }
        render();
        if (problems.length) body.querySelector('.bd-schema__problems')?.scrollIntoView({ block: 'nearest' });
    };

    render();
    el.replaceChildren(body);
    return () => {
        if (dirty()) _kept = { base, draft, num, curStore, curType };
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
    };
}
