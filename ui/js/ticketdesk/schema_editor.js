/**
 * ticketdesk/schema_editor.js — Settings › Record types: the project's custom
 * fields, hidden built-in fields and custom statuses, per record type.
 *
 * Modelled on Tables' Create table dialog (`../Tables/web/js/dialogs/
 * table_dialog.js`): the record types down the left, and for the chosen one a
 * row per field — name, label, type, required, and a choice field's values.
 * Below them, the built-in fields the type may hide and the statuses it adds.
 *
 * What it edits is `.bugdesk/project.json`'s `schema` (server/RecordSchema.cs),
 * which is committed: everyone who pulls the repo gets the same one. The bridge
 * checks a save strictly and refuses all of it on any problem, listing each;
 * the window stays open with the list so nothing typed is lost. That is why this
 * is its own ManagedWindow rather than `openModal`, whose buttons always close.
 *
 * A saved field or status keeps its NAME: records hold it as a frontmatter key
 * or a status value, and renaming the key would strand every value already
 * written. The label is what a person renames. Removing a field asks first and
 * leaves its values in the files.
 */

import { ManagedWindow } from '@flexdesk/widgets';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { CONFIG } from './instance.js';
import {
    CATEGORY_LABEL, FIELD_TYPE_LABEL, SNOOZE_FIELD, STORE_TYPES,
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

let _seq = 1;

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

/**
 * Open the editor. Resolves `true` once a schema was saved, `false` on cancel.
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {string} [o.store]   preselect a store
 * @param {string} [o.type]    and a type
 */
export function openSchemaEditor({ eventBus = null, store = null, type = null, preset = null } = {}) {
    const stores = storesHere();
    // Every store and type present, so switching types never meets a hole.
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

    /** "Snooze until" on every type of a store that lacks it — unsaved until Save. */
    const addSnooze = (s) => {
        let added = 0;
        for (const [t] of STORE_TYPES[s] || []) {
            const sp = draft[s]?.[t];
            if (!sp || sp.fields.some((f) => f.name === SNOOZE_FIELD.name)) continue;
            sp.fields.push({ ...SNOOZE_FIELD, values: [] });
            added++;
        }
        return added;
    };
    let curStore = stores.includes(store) ? store : stores[0];
    // Opened from the "Snoozed" view's notice: the field is already in place.
    let presetNote = '';
    if (preset === 'snooze' && curStore) {
        const n = addSnooze(curStore);
        presetNote = n ? `“Snooze until” was added to ${n} type${n === 1 ? '' : 's'} — Save to keep it.` : '';
    }
    let curType = type && STORE_TYPES[curStore]?.some(([t]) => t === type) ? type : STORE_TYPES[curStore][0][0];
    let confirmRemove = null;      // `field:<i>` or `status:<i>` awaiting a yes
    let problems = [];
    let selects = [];

    const body = document.createElement('div');
    body.className = 'bd-schema';

    const spec = () => draft[curStore][curType];

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

    const render = () => {
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        selects = [];
        const warnings = schemaWarnings();
        const typeLabel = STORE_TYPES[curStore].find(([t]) => t === curType)?.[1] || curType;
        body.innerHTML = `
            <nav class="bd-schema__nav" aria-label="Record types">${typeNav()}</nav>
            <div class="bd-schema__main">
                ${warnings.length ? `<div class="bd-schema__warn">${icon('warning')}<div>
                    The schema in project.json has problems, and those entries are not in effect:
                    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>` : ''}
                <h3 class="bd-schema__h">${esc(storeLabel(curStore))} › ${esc(typeLabel)}</h3>
                ${presetNote ? `<div class="bd-schema__warn bd-schema__note">${icon('snooze')}<div>${esc(presetNote)}</div></div>` : ''}
                <section>
                    <div class="bd-schema__shead"><h4>Custom fields</h4>
                        <button type="button" class="ea-btn" data-add="snooze"
                                title="A ready-made date: a record is left out of the open views until that day. Added to every ${esc(storeLabel(curStore))} type.">${icon('snooze')} Snooze until</button>
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
                ${problems.length ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${
                    problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
            </div>
            <div class="ea-modal__actions bd-schema__actions">
                <span class="td-dim bd-schema__path">Saved to .bugdesk/project.json — commit it to share it.</span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>`;

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
                    if (kind === 'field' && k === 'type') render();
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
        const k = e.target.dataset?.k;
        const row = k ? rowOf(e.target) : null;
        if (!row) return;
        if (k === 'values') row.values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
        else if (k === 'required') row.required = e.target.checked;
        else if (k === 'name') row.name = e.target.value.trim().toLowerCase();
        else row[k] = e.target.value;
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
        if (t.dataset.add === 'snooze') {
            const n = addSnooze(curStore);
            presetNote = n ? `“Snooze until” was added to ${n} type${n === 1 ? '' : 's'} — Save to keep it.`
                : 'Every type here already has “Snooze until”.';
            render();
            return;
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
        if (t.dataset.act === 'cancel') { close(false); return; }
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

    const save = async () => {
        problems = [];
        const btn = body.querySelector('[data-act="save"]');
        if (btn) btn.disabled = true;
        try {
            await saveSchema(payload());
            eventBus?.emit?.('toast:show', {
                type: 'info',
                message: `Record types saved to project.json. Reload ${appName()} for every page to use them.`,
            });
            close(true);
        } catch (err) {
            problems = err.problems?.length ? err.problems : [err.message || String(err)];
            render();
            body.querySelector('.bd-schema__problems')?.scrollIntoView({ block: 'nearest' });
        }
    };

    let settle = null;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-schema-${_seq++}`,
        title: 'Record types',
        icon: 'schema',
        content: body,
        modal: true,
        canMinimize: false,
        canMaximize: true,
        canResize: true,
        canDrag: true,
        defaultWidth: 900,
        defaultHeight: 620,
        onClose: () => close(false),
    });
    function close(saved) {
        if (closed) return;
        closed = true;
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        try { win.close({ force: true }); } catch { /* already closing */ }
        settle(saved);
    }
    render();
    win.show();
    return done;
}
