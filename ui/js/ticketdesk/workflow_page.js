/**
 * ticketdesk/workflow_page.js — Settings › Workflow: one page, no windows
 * (STORY-0030).
 *
 * A record type has ACTIONS; an action runs a FLOW; a flow's "Change the
 * status" step is the move. So the page reads left to right:
 *
 *   record types  →  the selected type's actions  →  the selected action's
 *                     (and its mass actions)          name, where it is offered,
 *                                                     its flow — edited in place
 *
 * and "Flows", under the types, lists every flow on its own: what it is for
 * (its records, and which of their types it is available to), and what uses it.
 * A flow is shared: change it here and every action that runs it changes too.
 *
 * Every type is shown this way whatever is stored for it — the built-in moves
 * and a move table stored the older way are grouped into actions with flows
 * that do what they did (./workflow_model.js) — and one Save writes back only
 * the types that differ, into `.bugdesk/project.json`. Changes left unsaved
 * are still there when you come back to the page.
 *
 * Right-click an action or a flow for what else can be done with it.
 */

import { showContextMenu } from '@flexdesk/widgets';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { attachSelect } from './select_field.js';
import {
    ANY_STORE, DEFAULT_MASS_ACTIONS, checkFlow, flowUses, newFlowId, saveWorkflow, statusStep, statusesOf, workflowConfig,
} from './workflow.js';
import { flowAvailable, newAction, newActionId, newFlow, typeWord, withTypeActions, withoutTypeActions } from './workflow_model.js';
import { flowStoresHere, mountFlowEditor, stepsWord, typesHere } from './workflow_editor.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
const TONE = { [ANY_STORE]: 'violet', bugs: 'amber', backlog: 'teal' };
const NEW_FLOW = '__new__';
const keyOf = (t) => `${t.store}.${t.type}`;

/** Unsaved changes, kept across leaving the page: `{base, draft, view, picked}`. */
let _kept = null;

/**
 * Fill `el` with the workflow page. Returns its cleanup.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 */
export function mountWorkflowPage(el, { eventBus = null } = {}) {
    const types = typesHere();
    const stores = flowStoresHere();
    const ANY = { store: ANY_STORE, label: 'Any record', types: [] };
    const storeChoices = stores.length > 1 ? [ANY, ...stores] : stores;
    const storeOf = (store) => (store === ANY_STORE ? ANY : stores.find((x) => x.store === store));
    const storeTypes = (store) => (store === ANY_STORE ? [] : storeOf(store)?.types || []);
    const typeLabel = (store, type) => types.find((t) => t.store === store && t.type === type)?.label || typeWord(store, type);

    let stored = workflowConfig();
    let base = JSON.stringify(withTypeActions(stored, types));
    let draft = JSON.parse(base);
    let view = types[0] ? keyOf(types[0]) : 'flows';     // a type's key, or 'flows'
    const picked = {};                                     // view -> selected action id / flow id
    let query = '';
    let problems = [];
    let note = '';
    if (_kept) {
        if (_kept.base === base) {
            ({ draft, view } = _kept);
            Object.assign(picked, _kept.picked);
        } else note = 'Your unsaved workflow changes were dropped: the workflow was saved elsewhere meanwhile.';
        _kept = null;
    }
    let editor = null;
    let handles = [];

    el.innerHTML = `
        <div class="bd-wf">
            <div class="bd-wf__bar">
                <span class="bd-wf__state td-dim" data-slot="state" aria-live="polite"></span>
                <button type="button" class="ea-btn" data-act="discard">Discard changes</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>
            <div data-slot="problems"></div>
            <div class="bd-wf__split">
                <nav class="bd-wf__types" data-slot="types" aria-label="Record types"></nav>
                <div class="bd-wf__mid" data-slot="mid"></div>
                <div class="bd-wf__detail" data-slot="detail"></div>
            </div>
            <div class="td-dim bd-wf__foot">Saved to .bugdesk/project.json — commit it to share it. Only what differs from the built-in way is saved.</div>
        </div>`;
    const $ = (slot) => el.querySelector(`[data-slot="${slot}"]`);

    /* ── reading the draft ─────────────────────────────────────────── */

    const typeOf = (key) => types.find((t) => keyOf(t) === key);
    const listOf = (t) => {
        draft.types = draft.types || {};
        draft.types[t.store] = draft.types[t.store] || {};
        draft.types[t.store][t.type] = draft.types[t.store][t.type] || [];
        return draft.types[t.store][t.type];
    };
    const flowById = (id) => (draft.flows || []).find((f) => f.id === id) || null;
    const dirty = () => JSON.stringify(draft) !== base;
    const usersOf = (id) => flowUses(draft, id).map((u) => u.owner);
    const whenWord = (a) => (!Array.isArray(a.when) || !a.when.length || a.when.includes('*') ? 'any status' : a.when.join(', '));
    const flowTypes = (f) => (f.store === ANY_STORE ? [] : (Array.isArray(f.types) && f.types.length ? f.types : storeTypes(f.store)));

    /* ── rendering ─────────────────────────────────────────────────── */

    const renderState = () => {
        const changed = dirty();
        $('state').textContent = note || (changed ? 'Unsaved changes' : '');
        el.querySelector('[data-act="save"]').disabled = !changed;
        el.querySelector('[data-act="discard"]').disabled = !changed;
    };

    const renderProblems = () => {
        $('problems').innerHTML = problems.length
            ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${problems.map((p, i) => `<li>${
                p.view ? `<button type="button" class="bd-wf__goto" data-problem="${i}">${esc(p.place || 'Show')}</button>: ` : ''}${esc(p.message)}</li>`).join('')}</ul></div>`
            : '';
    };

    const renderTypes = () => {
        let html = '';
        let last = null;
        for (const t of types) {
            if (t.storeLabel !== last) { html += `<div class="bd-wf__group">${esc(t.storeLabel)}</div>`; last = t.storeLabel; }
            const n = listOf(t).length;
            const bad = problems.some((p) => p.view === keyOf(t));
            html += `<button type="button" class="bd-wf__type${view === keyOf(t) ? ' is-on' : ''}" data-view="${keyOf(t)}">
                <span>${bad ? icon('error') : ''}${esc(t.label)}</span><span class="bd-wf__count">${n}</span></button>`;
        }
        const nf = (draft.flows || []).length;
        html += `<div class="bd-wf__group">All flows</div>
            <button type="button" class="bd-wf__type${view === 'flows' ? ' is-on' : ''}" data-view="flows">
                <span>${problems.some((p) => p.view === 'flows') ? icon('error') : ''}${icon('account_tree')} Flows</span><span class="bd-wf__count">${nf}</span></button>`;
        $('types').innerHTML = html;
    };

    const actionItem = (t, a) => {
        const f = flowById(a.flow);
        const to = statusStep(f?.flow);
        const bad = problems.some((p) => p.view === keyOf(t) && p.pick === a.id);
        return `<button type="button" class="bd-wf__item${picked[view] === a.id ? ' is-selected' : ''}" data-pick="${esc(a.id)}"
                    data-tone="${to ? 'teal' : 'violet'}" title="Right-click for more">
            <span class="bd-wf__chip">${icon(bad ? 'error' : to ? 'swap_horiz' : 'bolt')}</span>
            <span class="bd-wf__text">
                <span class="bd-wf__name">${esc(a.label || 'Untitled')}</span>
                <span class="bd-wf__sub">In ${esc(whenWord(a))}${to ? ` → ${esc(to)}` : ' · no status change'}${
                    !f ? ' · no flow' : (f.label || f.id) !== a.label ? ` · runs ${esc(f.label || f.id)}` : ''}</span>
            </span>
        </button>`;
    };

    const massChoices = (t) => [
        ['assignee', 'Change assignee'],
        ['status', 'Change status to…'],
        ...listOf(t).filter((a) => a.id && !statusStep(flowById(a.flow)?.flow)).map((a) => [`action:${a.id}`, a.label || a.id]),
    ];
    const massOf = (t) => {
        const list = draft.massActions?.[t.store]?.[t.type];
        return Array.isArray(list) ? list : DEFAULT_MASS_ACTIONS;
    };
    const setMass = (t, list) => {
        const same = list.length === DEFAULT_MASS_ACTIONS.length && DEFAULT_MASS_ACTIONS.every((x) => list.includes(x));
        draft.massActions = draft.massActions || {};
        draft.massActions[t.store] = draft.massActions[t.store] || {};
        if (same) delete draft.massActions[t.store][t.type]; else draft.massActions[t.store][t.type] = list;
        if (!Object.keys(draft.massActions[t.store]).length) delete draft.massActions[t.store];
        if (!Object.keys(draft.massActions).length) delete draft.massActions;
    };

    const renderMid = () => {
        if (view === 'flows') {
            const q = query.trim().toLowerCase();
            const all = draft.flows || [];
            const shown = all.filter((f) => !q || String(f.label || f.id).toLowerCase().includes(q));
            $('mid').innerHTML = `
                <div class="bd-wf__head"><h3>Flows</h3>
                    <button type="button" class="ea-btn" data-act="new-flow">${icon('add')} New flow</button></div>
                <label class="bd-flows__search">${icon('search')}
                    <input type="search" data-k="query" value="${esc(query)}" placeholder="Find a flow" aria-label="Find a flow"></label>
                <div class="bd-wf__list">${!all.length ? '<p class="td-dim bd-flows__empty">No flows yet.</p>'
                    : !shown.length ? '<p class="td-dim bd-flows__empty">No flow matches.</p>'
                    : shown.map((f) => {
                        const uses = usersOf(f.id).length;
                        const bad = problems.some((p) => p.view === 'flows' && p.pick === f.id);
                        const forWord = f.store === ANY_STORE ? 'Any record'
                            : `${storeOf(f.store)?.label || f.store}${Array.isArray(f.types) && f.types.length ? ` › ${f.types.map((x) => typeLabel(f.store, x)).join(', ')}` : ''}`;
                        return `<button type="button" class="bd-wf__item${picked.flows === f.id ? ' is-selected' : ''}" data-pick="${esc(f.id)}"
                                    data-tone="${TONE[f.store] || 'grey'}" title="Right-click for more">
                            <span class="bd-wf__chip">${icon(bad ? 'error' : 'account_tree')}</span>
                            <span class="bd-wf__text"><span class="bd-wf__name">${esc(f.label || 'Untitled')}</span>
                                <span class="bd-wf__sub">${esc(forWord)} · ${esc(stepsWord(f.flow))} · ${uses ? `used by ${uses}` : 'not used'}</span></span>
                        </button>`;
                    }).join('')}</div>`;
            return;
        }
        const t = typeOf(view);
        const list = listOf(t);
        const mass = massOf(t);
        $('mid').innerHTML = `
            <div class="bd-wf__head"><h3>Actions on a ${esc(t.label)}</h3>
                <button type="button" class="ea-btn" data-act="new-action">${icon('add')} Add action</button></div>
            <div class="bd-wf__list">${list.length ? list.map((a) => actionItem(t, a)).join('')
                : `<p class="td-dim bd-flows__empty">No actions: a ${esc(t.label.toLowerCase())} cannot be moved or acted on.</p>`}</div>
            <div class="bd-wf__mass">
                <div class="bd-wf__subhead">Mass actions <span class="td-dim">— offered when several ${esc(t.label.toLowerCase())}s are ticked</span></div>
                ${massChoices(t).map(([v, label]) => `<label class="bd-wf__check"><input type="checkbox" data-mass="${esc(v)}" ${mass.includes(v) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
            </div>`;
    };

    const destroyDetail = () => {
        editor?.destroy();
        editor = null;
        for (const h of handles) { try { h.destroy(); } catch { /* gone */ } }
        handles = [];
    };

    /** The flow part of the detail: name, what it is for, what uses it, its steps. */
    const flowPanel = (f, { removable = false } = {}) => {
        const uses = usersOf(f.id);
        const inUse = new Set(flowUses(draft, f.id).flatMap((u) => u.types || []));
        return `
            <div class="bd-wf__flowhead">
                <label class="bd-flowedit__name"><span>Flow</span>
                    <input type="text" data-k="flow-label" value="${esc(f.label || '')}" placeholder="Close" aria-label="Flow name"></label>
                ${storeChoices.length > 1 ? `<label class="bd-flowsmgr__for"><span>For</span><select data-k="flow-store"></select></label>` : ''}
                ${removable ? `<button type="button" class="ea-btn bd-flowsmgr__rm" data-act="remove-flow" ${uses.length ? 'disabled' : ''}
                    title="${uses.length ? `Used by ${uses.length}: give ${uses.length === 1 ? 'that action' : 'those actions'} another flow first` : 'Remove this flow'}">${icon('delete')} Remove</button>` : ''}
            </div>
            ${f.store === ANY_STORE ? '' : `<div class="bd-wf__avail"><span class="td-dim">Available to</span>${storeTypes(f.store).map((x) => {
                const on = !Array.isArray(f.types) || !f.types.length || f.types.includes(x);
                const locked = on && inUse.has(x);
                return `<label class="bd-wf__chipcheck${on ? ' is-on' : ''}" title="${locked ? 'An action of this type runs it' : ''}">
                    <input type="checkbox" data-avail="${esc(x)}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(typeLabel(f.store, x))}</label>`;
            }).join('')}</div>`}
            <div class="bd-flowsmgr__uses td-dim" title="${esc(uses.join('\n'))}">${uses.length
                ? `Run by ${esc(uses.join(', '))}${uses.length > 1 ? ' — a change here changes them all' : ''}.`
                : 'Not run by any action yet.'}</div>
            <div class="bd-flowedit__host bd-wf__editor"></div>`;
    };

    const mountFlow = (f) => {
        const sel = $('detail').querySelector('[data-k="flow-store"]');
        if (sel) {
            const used = new Set(flowUses(draft, f.id).map((u) => u.store));
            const allowed = storeChoices.filter((x) => x.store === ANY_STORE || [...used].every((s) => s === x.store));
            handles.push(attachSelect(sel, {
                value: f.store,
                options: allowed.map((x) => ({ value: x.store, label: x.label,
                    hint: x.store === ANY_STORE ? 'the fields every record has' : 'its own fields and statuses too' })),
                onChange: (v) => {
                    if (!v || v === f.store || !allowed.some((x) => x.store === v)) return;
                    f.store = v;
                    delete f.types;
                    note = '';
                    renderAll();
                },
            }));
        }
        editor = mountFlowEditor($('detail').querySelector('.bd-wf__editor'), {
            store: f.store, types: flowTypes(f), graph: f.flow, actions: true,
            serverFindings: problems.filter((p) => p.flow === f.id && p.node_id),
            onChange: () => {
                f.flow = editor.getGraph();
                problems = problems.filter((p) => p.flow !== f.id);
                note = '';
                renderMid(); renderProblems(); renderState();
            },
        });
    };

    const renderDetail = () => {
        destroyDetail();
        if (view === 'flows') {
            const f = flowById(picked.flows);
            if (!f) { $('detail').innerHTML = '<p class="td-dim bd-flowsmgr__none">Pick a flow to edit its name, what it is for, and its steps.</p>'; return; }
            $('detail').innerHTML = flowPanel(f, { removable: true });
            mountFlow(f);
            return;
        }
        const t = typeOf(view);
        const a = listOf(t).find((x) => x.id === picked[view]);
        if (!a) { $('detail').innerHTML = `<p class="td-dim bd-flowsmgr__none">Pick an action to edit it and its flow.</p>`; return; }
        const any = !Array.isArray(a.when) || !a.when.length || a.when.includes('*');
        const f = flowById(a.flow);
        $('detail').innerHTML = `
            <div class="bd-wf__action">
                <label class="bd-flowedit__name"><span>Action</span>
                    <input type="text" data-k="action-label" value="${esc(a.label || '')}" placeholder="Close" aria-label="Action name"></label>
                <div class="bd-wf__when"><span class="td-dim">Offered in</span>
                    <label class="bd-wf__chipcheck${any ? ' is-on' : ''}"><input type="checkbox" data-when="*" ${any ? 'checked' : ''}> any status</label>
                    ${statusesOf(t.store, t.type).map((s) => {
                        const on = !any && a.when.includes(s);
                        return `<label class="bd-wf__chipcheck${on ? ' is-on' : ''}"><input type="checkbox" data-when="${esc(s)}" ${on ? 'checked' : ''}> ${esc(s)}</label>`;
                    }).join('')}
                </div>
                <label class="bd-wf__flowpick"><span class="td-dim">Runs</span><select data-k="action-flow"></select></label>
            </div>
            ${f ? flowPanel(f) : '<p class="td-dim bd-flowsmgr__none">This action runs no flow yet: pick one above, or make one.</p>'}`;
        handles.push(attachSelect($('detail').querySelector('[data-k="action-flow"]'), {
            value: a.flow || '',
            allowNew: true,
            placeholder: 'Find a flow, or name a new one',
            emptyLabel: 'No flow',
            newLabel: (typed) => `New flow “${typed}”`,
            optionsFor: () => [
                ...(draft.flows || []).filter((x) => flowAvailable(x, t.store, t.type))
                    .map((x) => ({ value: x.id, label: x.label || x.id, icon: 'account_tree', hint: stepsWord(x.flow) })),
                { value: NEW_FLOW, label: 'New flow…', icon: 'add' },
            ],
            onChange: (v) => {
                if (!v) return;
                if (v !== NEW_FLOW && flowById(v)) a.flow = v;
                else {
                    const nf = newFlow(draft.flows = draft.flows || [], { label: v === NEW_FLOW ? (a.label || 'New flow') : v, store: t.store, types: [t.type] });
                    draft.flows.push(nf);
                    a.flow = nf.id;
                }
                note = '';
                renderAll();
            },
        }));
        if (f) mountFlow(f);
    };

    const renderAll = () => {
        destroyDetail();
        if (view !== 'flows' && !typeOf(view)) view = types[0] ? keyOf(types[0]) : 'flows';
        if (view === 'flows' && !flowById(picked.flows)) picked.flows = draft.flows?.[0]?.id;
        if (view !== 'flows' && !listOf(typeOf(view)).some((a) => a.id === picked[view])) picked[view] = listOf(typeOf(view))[0]?.id;
        renderTypes(); renderMid(); renderProblems(); renderDetail(); renderState();
    };

    /* ── changing the draft ────────────────────────────────────────── */

    const touch = () => { note = ''; renderState(); };

    const addAction = () => {
        const t = typeOf(view);
        const list = listOf(t);
        const a = newAction(list);
        // A new action gets a flow of its own to fill in, made for this type.
        const f = newFlow(draft.flows = draft.flows || [], { label: a.label, store: t.store, types: [t.type] });
        draft.flows.push(f);
        a.flow = f.id;
        list.push(a);
        picked[view] = a.id;
        note = '';
        renderAll();
        const name = el.querySelector('[data-k="action-label"]');
        name?.focus(); name?.select();
    };

    const actionMenu = (x, y, id) => {
        const t = typeOf(view);
        const list = listOf(t);
        const i = list.findIndex((a) => a.id === id);
        showContextMenu(x, y, [
            { label: 'Open', icon: 'open_in_new', action: 'open' },
            { label: 'Move up', icon: 'arrow_upward', action: 'up', disabled: i <= 0 },
            { label: 'Move down', icon: 'arrow_downward', action: 'down', disabled: i >= list.length - 1 },
            { label: 'Duplicate', icon: 'content_copy', action: 'duplicate' },
            { label: 'Edit its flow in Flows', icon: 'account_tree', action: 'flow', disabled: !list[i]?.flow },
            { separator: true },
            { label: 'Delete', icon: 'delete', action: 'delete', danger: true },
        ], (act) => {
            if (act === 'open') picked[view] = id;
            else if (act === 'up' || act === 'down') {
                const j = i + (act === 'up' ? -1 : 1);
                if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
            } else if (act === 'duplicate') {
                const copy = { ...JSON.parse(JSON.stringify(list[i])), ...newAction(list, `${list[i].label} (copy)`), flow: list[i].flow, when: [...(list[i].when || ['*'])] };
                list.splice(i + 1, 0, copy);
                picked[view] = copy.id;
            } else if (act === 'flow') { picked.flows = list[i].flow; view = 'flows'; }
            else if (act === 'delete') {
                list.splice(i, 1);
                // A mass action naming it goes with it.
                setMass(t, massOf(t).filter((v) => v !== `action:${id}`));
                picked[view] = list[Math.min(i, list.length - 1)]?.id;
            }
            note = '';
            renderAll();
        });
    };

    const flowMenu = (x, y, id) => {
        const uses = usersOf(id).length;
        showContextMenu(x, y, [
            { label: 'Open', icon: 'open_in_new', action: 'open' },
            { label: 'Rename', icon: 'edit', action: 'rename' },
            { label: 'Duplicate', icon: 'content_copy', action: 'duplicate' },
            { separator: true },
            { label: uses ? `Delete — used by ${uses}` : 'Delete', icon: 'delete', action: 'delete', danger: true, disabled: !!uses },
        ], (act) => {
            const flows = draft.flows || [];
            const i = flows.findIndex((f) => f.id === id);
            if (i < 0) return;
            if (act === 'open') picked.flows = id;
            else if (act === 'rename') { picked.flows = id; renderAll(); const n = el.querySelector('[data-k="flow-label"]'); n?.focus(); n?.select(); return; }
            else if (act === 'duplicate') {
                const label = `${flows[i].label || 'Flow'} (copy)`;
                const copy = { ...JSON.parse(JSON.stringify(flows[i])), id: newFlowId(label, flows), label };
                flows.splice(i + 1, 0, copy);
                picked.flows = copy.id;
            } else if (act === 'delete' && !uses) {
                flows.splice(i, 1);
                picked.flows = flows[Math.min(i, flows.length - 1)]?.id;
            }
            note = '';
            renderAll();
        });
    };

    /* ── saving ────────────────────────────────────────────────────── */

    const save = async () => {
        problems = [];
        note = '';
        for (const t of types) {
            for (const a of listOf(t)) {
                const place = `${t.label} › ${a.label || 'untitled'}`;
                if (!String(a.label || '').trim()) problems.push({ view: keyOf(t), pick: a.id, place, message: 'Every action needs a name.' });
                const f = flowById(a.flow);
                if (a.flow && !f) problems.push({ view: keyOf(t), pick: a.id, place, message: 'It runs a flow that is gone: pick another.' });
                else if (f && !flowAvailable(f, t.store, t.type)) {
                    problems.push({ view: keyOf(t), pick: a.id, place, message: `It runs “${f.label}”, which is not available to a ${t.label.toLowerCase()}.` });
                }
            }
        }
        for (const f of draft.flows || []) {
            const place = f.label || f.id;
            if (!String(f.label || '').trim()) problems.push({ view: 'flows', pick: f.id, flow: f.id, place, message: 'Every flow needs a name.' });
            const found = checkFlow(f.flow, f.store, flowTypes(f), { actions: true });
            if (found.length) {
                problems.push({ view: 'flows', pick: f.id, flow: f.id, place,
                    message: `${found.length} thing${found.length === 1 ? '' : 's'} to fix in its steps — see the list above the flow.` });
            }
        }
        if (problems.length) {
            const first = problems[0];
            view = first.view;
            if (first.pick) picked[view] = first.pick;
            renderAll();
            return;
        }
        const sent = withoutTypeActions(draft, stored, types);
        el.querySelector('[data-act="save"]').disabled = true;
        try {
            await saveWorkflow(sent);
            stored = workflowConfig();
            base = JSON.stringify(withTypeActions(stored, types));
            draft = JSON.parse(base);
            renderAll();
            eventBus?.emit?.('toast:show', { type: 'info', message: `Workflow saved to project.json. Reload ${appName()} for every page to use it.` });
        } catch (err) {
            // The bridge names a type's action, or a flow, by its place in what it was sent.
            problems = (err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }]).map((p) => {
                const ta = /^workflow\.types\.([a-z]+)\.([a-z]+)\[(\d+)\]/.exec(p.where || '');
                if (ta) {
                    const [, store, type, i] = ta;
                    const t = types.find((x) => x.store === store && x.type === type);
                    const a = sent.types?.[store]?.[type]?.[Number(i)];
                    return { ...p, view: t ? keyOf(t) : null, pick: a?.id, place: t ? `${t.label} › ${a?.label || ''}` : '', flow: p.node_id ? a?.flow : undefined };
                }
                const fl = /^workflow\.flows\[(\d+)\]/.exec(p.where || '');
                if (fl) {
                    const f = sent.flows?.[Number(fl[1])];
                    return { ...p, view: 'flows', pick: f?.id, flow: f?.id, place: f?.label || '' };
                }
                return p;
            });
            const first = problems.find((p) => p.view);
            if (first) { view = first.view; if (first.pick) picked[view] = first.pick; }
            renderAll();
        }
    };

    /* ── events ────────────────────────────────────────────────────── */

    el.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (k === 'query') {
            query = e.target.value;
            renderMid();
            const q = el.querySelector('[data-k="query"]');
            q?.focus(); q?.setSelectionRange(q.value.length, q.value.length);
            return;
        }
        if (k === 'action-label') {
            const t = typeOf(view);
            const list = listOf(t);
            const a = list.find((x) => x.id === picked[view]);
            if (!a) return;
            const before = a.label;
            a.label = e.target.value;
            // Not saved yet: its id follows its name, and so does a flow of its
            // own that still has its name (the one Add action made for it).
            const saved = JSON.parse(base).types?.[t.store]?.[t.type]?.some((x) => x.id === a.id);
            if (!saved) {
                const id = newActionId(a.label, list.filter((x) => x !== a));
                setMass(t, massOf(t).map((v) => (v === `action:${a.id}` ? `action:${id}` : v)));
                a.id = id;
                picked[view] = id;
                const f = flowById(a.flow);
                if (f && f.label === before && flowUses(draft, f.id).length === 1) {
                    f.label = a.label;
                    if (!JSON.parse(base).flows?.some((x) => x.id === f.id)) {
                        f.id = newFlowId(f.label, draft.flows.filter((x) => x !== f));
                        a.flow = f.id;
                    }
                }
            }
            renderMid(); touch();
            return;
        }
        if (k === 'flow-label') {
            const id = view === 'flows' ? picked.flows : listOf(typeOf(view)).find((x) => x.id === picked[view])?.flow;
            const f = flowById(id);
            if (f) { f.label = e.target.value; renderMid(); touch(); }
        }
    });

    el.addEventListener('change', (e) => {
        const tgt = e.target;
        if (tgt.dataset.when !== undefined) {
            const a = listOf(typeOf(view)).find((x) => x.id === picked[view]);
            if (!a) return;
            const s = tgt.dataset.when;
            const now = Array.isArray(a.when) && a.when.length && !a.when.includes('*') ? a.when : [];
            a.when = s === '*' ? (tgt.checked ? ['*'] : []) : tgt.checked ? [...now, s] : now.filter((x) => x !== s);
            if (!a.when.length) a.when = ['*'];
            note = '';
            renderAll();
            return;
        }
        if (tgt.dataset.avail !== undefined) {
            const id = view === 'flows' ? picked.flows : listOf(typeOf(view)).find((x) => x.id === picked[view])?.flow;
            const f = flowById(id);
            if (!f) return;
            const all = storeTypes(f.store);
            const now = Array.isArray(f.types) && f.types.length ? f.types : all;
            const next = tgt.checked ? [...new Set([...now, tgt.dataset.avail])] : now.filter((x) => x !== tgt.dataset.avail);
            if (!next.length) { tgt.checked = true; return; }          // available to nothing is no flow at all
            if (next.length === all.length) delete f.types; else f.types = all.filter((x) => next.includes(x));
            note = '';
            renderAll();
            return;
        }
        if (tgt.dataset.mass !== undefined) {
            const t = typeOf(view);
            const v = tgt.dataset.mass;
            const now = massOf(t);
            setMass(t, tgt.checked ? [...now.filter((x) => x !== v), v] : now.filter((x) => x !== v));
            touch();
        }
    });

    el.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        if (b.dataset.view) { view = b.dataset.view; renderAll(); return; }
        if (b.dataset.pick) { picked[view] = b.dataset.pick; renderAll(); return; }
        if (b.dataset.problem) {
            const p = problems[Number(b.dataset.problem)];
            if (p?.view) { view = p.view; if (p.pick) picked[view] = p.pick; renderAll(); }
            return;
        }
        const act = b.dataset.act;
        if (act === 'new-action') { addAction(); return; }
        if (act === 'new-flow') {
            const f = newFlow(draft.flows = draft.flows || [], { label: query.trim() || 'New flow', store: storeChoices[0].store });
            draft.flows.push(f);
            picked.flows = f.id;
            query = '';
            note = '';
            renderAll();
            const n = el.querySelector('[data-k="flow-label"]'); n?.focus(); n?.select();
            return;
        }
        if (act === 'remove-flow') {
            const flows = draft.flows || [];
            const i = flows.findIndex((f) => f.id === picked.flows);
            if (i >= 0 && !flowUses(draft, picked.flows).length) { flows.splice(i, 1); picked.flows = flows[Math.min(i, flows.length - 1)]?.id; }
            note = '';
            renderAll();
            return;
        }
        if (act === 'discard') { draft = JSON.parse(base); problems = []; note = ''; renderAll(); return; }
        if (act === 'save') await save();
    });

    el.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.bd-wf__item[data-pick]');
        if (!item) return;
        e.preventDefault();
        if (view === 'flows') flowMenu(e.clientX, e.clientY, item.dataset.pick);
        else actionMenu(e.clientX, e.clientY, item.dataset.pick);
    });

    renderAll();

    return () => {
        if (dirty()) _kept = { base, draft, view, picked: { ...picked } };
        destroyDetail();
    };
}
