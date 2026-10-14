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
 *
 * THE TRACKER TOO. A project page that shows the global tracker shows its
 * workflow here as well, under the project's: the tracker's types and its own
 * flows, kept in the tracker's own project.json. Each is a SOURCE — the copy of
 * these modules that serves that store (./instance.js), so a tracker type's
 * statuses, checks and save are the tracker's — and one Save writes each
 * source that changed.
 */

import { showContextMenu } from '@flexdesk/widgets';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { CONFIG, IS_TRACKER_COPY, trackerModule } from './instance.js';
import { attachSelect } from './select_field.js';
import { pageBar, projectFoot } from './page_bar.js';
import * as WF from './workflow.js';
import * as MODEL from './workflow_model.js';
import * as ED from './workflow_editor.js';

const { ANY_STORE, DEFAULT_MASS_ACTIONS, statusStep } = WF;

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
const TONE = { [ANY_STORE]: 'violet', bugs: 'amber', backlog: 'teal' };
const NEW_FLOW = '__new__';

/** Unsaved changes, kept across leaving the page: `{bases, drafts, view, picked}`. */
let _kept = null;

/**
 * The workflows this page edits: this store's, and — on a project page that
 * shows the global tracker — the tracker's, through the tracker's copy of
 * these modules.
 */
async function loadSources() {
    const out = [{ id: 'p', label: null, wf: WF, model: MODEL, ed: ED }];
    if (!IS_TRACKER_COPY && CONFIG.mode !== 'tracker' && typeof window !== 'undefined' && window.__BUGDESK_TRACKER_CONFIG__) {
        try {
            const [wf, model, ed] = await Promise.all(
                ['workflow.js', 'workflow_model.js', 'workflow_editor.js'].map((f) => trackerModule(f)));
            out[0].label = 'This project';
            out.push({ id: 't', label: 'Tracker', wf, model, ed });
        } catch (err) {
            console.error('[workflow] the tracker\'s workflow could not be loaded', err);
        }
    }
    for (const src of out) {
        src.types = src.ed.typesHere();
        src.stores = src.ed.flowStoresHere();
    }
    return out;
}

/**
 * Fill `el` with the workflow page. Returns its cleanup.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 */
export async function mountWorkflowPage(el, { eventBus = null, actions = null } = {}) {
    const sources = await loadSources();
    const ANY = { store: ANY_STORE, label: 'Any record', types: [] };
    for (const src of sources) {
        src.stored = src.wf.workflowConfig();
        src.base = JSON.stringify(src.model.withTypeActions(src.stored, src.types));
        src.draft = JSON.parse(src.base);
    }
    const first = sources.find((x) => x.types.length) || sources[0];
    let view = first.types[0] ? `${first.id}|${first.types[0].store}.${first.types[0].type}` : `${first.id}|flows`;
    const picked = {};                                     // view -> selected action id / flow id
    let query = '';
    let problems = [];
    let note = '';
    if (_kept) {
        if (sources.every((x) => _kept.bases[x.id] === x.base)) {
            for (const x of sources) x.draft = _kept.drafts[x.id];
            view = _kept.view;
            Object.assign(picked, _kept.picked);
        } else note = 'Your unsaved workflow changes were dropped: the workflow was saved elsewhere meanwhile.';
        _kept = null;
    }
    let editor = null;
    let handles = [];

    // The source, store and type a view is about.
    const srcOf = (v = view) => sources.find((x) => x.id === v.split('|')[0]) || sources[0];
    const isFlows = (v = view) => v.endsWith('|flows');
    const keyOf = (src, t) => `${src.id}|${t.store}.${t.type}`;
    const S = () => srcOf();
    const flowsKey = (src = S()) => `${src.id}|flows`;
    const storeChoices = () => (S().stores.length > 1 ? [ANY, ...S().stores] : S().stores);
    const storeOf = (store) => (store === ANY_STORE ? ANY : S().stores.find((x) => x.store === store));
    const storeTypes = (store) => (store === ANY_STORE ? [] : storeOf(store)?.types || []);
    const typeLabel = (store, type) => S().types.find((t) => t.store === store && t.type === type)?.label || S().model.typeWord(store, type);

    el.innerHTML = `
        <div class="bd-wf bd-proj">
            <div data-slot="problems"></div>
            <div class="bd-wf__split bd-surface">
                <nav class="bd-wf__types" data-slot="types" aria-label="Record types"></nav>
                <div class="bd-wf__mid" data-slot="mid"></div>
                <div class="bd-wf__detail" data-slot="detail"></div>
            </div>
            ${projectFoot('Only what differs from the built-in way is saved.')}
        </div>`;
    const $ = (slot) => el.querySelector(`[data-slot="${slot}"]`);
    let saving = false;
    const bar = pageBar(actions, el.firstElementChild, async (act) => {
        if (act === 'discard') { for (const src of sources) src.draft = JSON.parse(src.base); problems = []; note = ''; renderAll(); return; }
        saving = true; renderState();
        try { await save(); } finally { saving = false; renderState(); }
    });

    /* ── reading the draft ─────────────────────────────────────────── */

    const typeOf = (v = view) => { const src = srcOf(v); return src.types.find((t) => keyOf(src, t) === v); };
    const listOf = (t, src = S()) => {
        const d = src.draft;
        d.types = d.types || {};
        d.types[t.store] = d.types[t.store] || {};
        d.types[t.store][t.type] = d.types[t.store][t.type] || [];
        return d.types[t.store][t.type];
    };
    const flowById = (id, src = S()) => (src.draft.flows || []).find((f) => f.id === id) || null;
    const dirtyOf = (src) => JSON.stringify(src.draft) !== src.base;
    const dirty = () => sources.some(dirtyOf);
    const flowUses = (id, src = S()) => src.wf.flowUses(src.draft, id);
    const usersOf = (id) => flowUses(id).map((u) => u.owner);
    const whenWord = (a) => (!Array.isArray(a.when) || !a.when.length || a.when.includes('*') ? 'any status' : a.when.join(', '));
    const flowTypes = (f) => (f.store === ANY_STORE ? [] : (Array.isArray(f.types) && f.types.length ? f.types : storeTypes(f.store)));

    /* ── rendering ─────────────────────────────────────────────────── */

    const renderState = () => bar.sync({ dirty: dirty(), busy: saving, note });

    const renderProblems = () => {
        $('problems').innerHTML = problems.length
            ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${problems.map((p, i) => `<li>${
                p.view ? `<button type="button" class="bd-wf__goto" data-problem="${i}">${esc(p.place || 'Show')}</button>: ` : ''}${esc(p.message)}</li>`).join('')}</ul></div>`
            : '';
    };

    const renderTypes = () => {
        let html = '';
        for (const src of sources) {
            if (src.label) html += `<div class="bd-wf__source">${esc(src.label)}</div>`;
            let last = null;
            for (const t of src.types) {
                // The tracker's store is "Tickets" to itself; under its own heading here.
                const group = src.id === 't' ? '' : t.storeLabel;
                if (group && group !== last) { html += `<div class="bd-wf__group">${esc(group)}</div>`; last = group; }
                const k = keyOf(src, t);
                const bad = problems.some((p) => p.view === k);
                html += `<button type="button" class="bd-wf__type${view === k ? ' is-on' : ''}" data-view="${esc(k)}">
                    <span>${bad ? icon('error') : ''}${esc(t.label)}</span><span class="bd-wf__count">${listOf(t, src).length}</span></button>`;
            }
            const fk = flowsKey(src);
            html += `<button type="button" class="bd-wf__type bd-wf__type--flows${view === fk ? ' is-on' : ''}" data-view="${esc(fk)}">
                <span>${problems.some((p) => p.view === fk) ? icon('error') : icon('account_tree')} ${src.id === 't' ? 'Tracker flows' : 'Flows'}</span>
                <span class="bd-wf__count">${(src.draft.flows || []).length}</span></button>`;
        }
        $('types').innerHTML = html;
    };

    const actionItem = (t, a) => {
        const f = flowById(a.flow);
        const to = statusStep(f?.flow);
        const bad = problems.some((p) => p.view === keyOf(S(), t) && p.pick === a.id);
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
        const list = S().draft.massActions?.[t.store]?.[t.type];
        return Array.isArray(list) ? list : DEFAULT_MASS_ACTIONS;
    };
    const setMass = (t, list) => {
        const same = list.length === DEFAULT_MASS_ACTIONS.length && DEFAULT_MASS_ACTIONS.every((x) => list.includes(x));
        S().draft.massActions = S().draft.massActions || {};
        S().draft.massActions[t.store] = S().draft.massActions[t.store] || {};
        if (same) delete S().draft.massActions[t.store][t.type]; else S().draft.massActions[t.store][t.type] = list;
        if (!Object.keys(S().draft.massActions[t.store]).length) delete S().draft.massActions[t.store];
        if (!Object.keys(S().draft.massActions).length) delete S().draft.massActions;
    };

    const renderMid = () => {
        if (isFlows()) {
            const q = query.trim().toLowerCase();
            const all = S().draft.flows || [];
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
                        const bad = problems.some((p) => p.view === flowsKey() && p.pick === f.id);
                        const forWord = f.store === ANY_STORE ? 'Any record'
                            : `${storeOf(f.store)?.label || f.store}${Array.isArray(f.types) && f.types.length ? ` › ${f.types.map((x) => typeLabel(f.store, x)).join(', ')}` : ''}`;
                        return `<button type="button" class="bd-wf__item${picked[flowsKey()] === f.id ? ' is-selected' : ''}" data-pick="${esc(f.id)}"
                                    data-tone="${TONE[f.store] || 'grey'}" title="Right-click for more">
                            <span class="bd-wf__chip">${icon(bad ? 'error' : 'account_tree')}</span>
                            <span class="bd-wf__text"><span class="bd-wf__name">${esc(f.label || 'Untitled')}</span>
                                <span class="bd-wf__sub">${esc(forWord)} · ${esc(S().ed.stepsWord(f.flow))} · ${uses ? `used by ${uses}` : 'not used'}</span></span>
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
        const inUse = new Set(flowUses(f.id).flatMap((u) => u.types || []));
        return `
            <div class="bd-wf__block">
                <div class="bd-schema__shead"><h4>Flow</h4>${removable ? '' : `<span class="bd-schema__cnt">${esc(f.label || '')}</span>`}
                    ${removable ? `<button type="button" class="ea-btn bd-flowsmgr__rm" data-act="remove-flow" ${uses.length ? 'disabled' : ''}
                        title="${uses.length ? `Used by ${uses.length}: give ${uses.length === 1 ? 'that action' : 'those actions'} another flow first` : 'Remove this flow'}">${icon('delete')} Remove</button>` : ''}</div>
                <div class="bd-wf__form">
                    <span>Name</span>
                    <input type="text" data-k="flow-label" value="${esc(f.label || '')}" placeholder="Close" aria-label="Flow name">
                    ${storeChoices().length > 1 ? '<span>For</span><select data-k="flow-store" aria-label="Which records"></select>' : ''}
                    ${f.store === ANY_STORE ? '' : `<span>Available to</span><div class="bd-wf__pills">${storeTypes(f.store).map((x) => {
                        const on = !Array.isArray(f.types) || !f.types.length || f.types.includes(x);
                        const locked = on && inUse.has(x);
                        return `<label class="bd-wf__chipcheck${on ? ' is-on' : ''}" title="${locked ? 'An action of this type runs it' : ''}">
                            <input type="checkbox" data-avail="${esc(x)}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(typeLabel(f.store, x))}</label>`;
                    }).join('')}</div>`}
                </div>
                <div class="bd-wf__uses td-dim">${uses.length
                    ? `Run by ${esc(uses.join(', '))}${uses.length > 1 ? ' — a change here changes them all' : ''}.`
                    : 'Not run by any action yet.'}</div>
            </div>
            <div class="bd-flowedit__host bd-wf__editor"></div>`;
    };

    const mountFlow = (f) => {
        const sel = $('detail').querySelector('[data-k="flow-store"]');
        if (sel) {
            const used = new Set(flowUses(f.id).map((u) => u.store));
            const allowed = storeChoices().filter((x) => x.store === ANY_STORE || [...used].every((s) => s === x.store));
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
        editor = S().ed.mountFlowEditor($('detail').querySelector('.bd-wf__editor'), {
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
        if (isFlows()) {
            const f = flowById(picked[flowsKey()]);
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
            <div class="bd-wf__block">
                <div class="bd-schema__shead"><h4>Action</h4>
                    <button type="button" class="ea-btn" data-act="remove-action" title="Remove this action">${icon('delete')} Remove</button></div>
                <div class="bd-wf__form">
                <span>Name</span>
                <input type="text" data-k="action-label" value="${esc(a.label || '')}" placeholder="Close" aria-label="Action name">
                <span>Offered in</span>
                <div class="bd-wf__pills">
                    <label class="bd-wf__chipcheck${any ? ' is-on' : ''}"><input type="checkbox" data-when="*" ${any ? 'checked' : ''}> any status</label>
                    ${S().wf.statusesOf(t.store, t.type).map((s) => {
                        const on = !any && a.when.includes(s);
                        return `<label class="bd-wf__chipcheck${on ? ' is-on' : ''}"><input type="checkbox" data-when="${esc(s)}" ${on ? 'checked' : ''}> ${esc(s)}</label>`;
                    }).join('')}
                </div>
                <span>Runs</span>
                <select data-k="action-flow" aria-label="The flow it runs"></select>
                </div>
            </div>
            ${f ? flowPanel(f) : '<p class="td-dim bd-flowsmgr__none">This action runs no flow yet: pick one above, or make one.</p>'}`;
        handles.push(attachSelect($('detail').querySelector('[data-k="action-flow"]'), {
            value: a.flow || '',
            allowNew: true,
            placeholder: 'Find a flow, or name a new one',
            emptyLabel: 'No flow',
            newLabel: (typed) => `New flow “${typed}”`,
            optionsFor: () => [
                ...(S().draft.flows || []).filter((x) => S().model.flowAvailable(x, t.store, t.type))
                    .map((x) => ({ value: x.id, label: x.label || x.id, icon: 'account_tree', hint: S().ed.stepsWord(x.flow) })),
                { value: NEW_FLOW, label: 'New flow…', icon: 'add' },
            ],
            onChange: (v) => {
                if (!v) return;
                if (v !== NEW_FLOW && flowById(v)) a.flow = v;
                else {
                    const nf = S().model.newFlow(S().draft.flows = S().draft.flows || [], { label: v === NEW_FLOW ? (a.label || 'New flow') : v, store: t.store, types: [t.type] });
                    S().draft.flows.push(nf);
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
        if (!isFlows() && !typeOf(view)) view = first.types[0] ? keyOf(first, first.types[0]) : flowsKey(first);
        if (isFlows() && !flowById(picked[flowsKey()])) picked[flowsKey()] = S().draft.flows?.[0]?.id;
        if (!isFlows() && !listOf(typeOf(view)).some((a) => a.id === picked[view])) picked[view] = listOf(typeOf(view))[0]?.id;
        renderTypes(); renderMid(); renderProblems(); renderDetail(); renderState();
    };

    /* ── changing the draft ────────────────────────────────────────── */

    const touch = () => { note = ''; renderState(); };

    const addAction = () => {
        const t = typeOf(view);
        const list = listOf(t);
        const a = S().model.newAction(list);
        // A new action gets a flow of its own to fill in, made for this type.
        const f = S().model.newFlow(S().draft.flows = S().draft.flows || [], { label: a.label, store: t.store, types: [t.type] });
        S().draft.flows.push(f);
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
                const copy = { ...JSON.parse(JSON.stringify(list[i])), ...S().model.newAction(list, `${list[i].label} (copy)`), flow: list[i].flow, when: [...(list[i].when || ['*'])] };
                list.splice(i + 1, 0, copy);
                picked[view] = copy.id;
            } else if (act === 'flow') { const fk = flowsKey(); picked[fk] = list[i].flow; view = fk; }
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
            const flows = S().draft.flows || [];
            const i = flows.findIndex((f) => f.id === id);
            if (i < 0) return;
            if (act === 'open') picked[flowsKey()] = id;
            else if (act === 'rename') { picked[flowsKey()] = id; renderAll(); const n = el.querySelector('[data-k="flow-label"]'); n?.focus(); n?.select(); return; }
            else if (act === 'duplicate') {
                const label = `${flows[i].label || 'Flow'} (copy)`;
                const copy = { ...JSON.parse(JSON.stringify(flows[i])), id: S().wf.newFlowId(label, flows), label };
                flows.splice(i + 1, 0, copy);
                picked[flowsKey()] = copy.id;
            } else if (act === 'delete' && !uses) {
                flows.splice(i, 1);
                picked[flowsKey()] = flows[Math.min(i, flows.length - 1)]?.id;
            }
            note = '';
            renderAll();
        });
    };

    /* ── saving ────────────────────────────────────────────────────── */

    const save = async () => {
        problems = [];
        note = '';
        for (const src of sources) {
            const where = (text) => (src.label && sources.length > 1 ? `${src.label} › ${text}` : text);
            for (const t of src.types) {
                for (const a of listOf(t, src)) {
                    const at = { view: keyOf(src, t), pick: a.id, place: where(`${t.label} › ${a.label || 'untitled'}`) };
                    if (!String(a.label || '').trim()) problems.push({ ...at, message: 'Every action needs a name.' });
                    const f = flowById(a.flow, src);
                    if (a.flow && !f) problems.push({ ...at, message: 'It runs a flow that is gone: pick another.' });
                    else if (f && !src.model.flowAvailable(f, t.store, t.type)) {
                        problems.push({ ...at, message: `It runs “${f.label}”, which is not available to a ${t.label.toLowerCase()}.` });
                    }
                }
            }
            for (const f of src.draft.flows || []) {
                const at = { view: flowsKey(src), pick: f.id, flow: f.id, place: where(f.label || f.id) };
                if (!String(f.label || '').trim()) problems.push({ ...at, message: 'Every flow needs a name.' });
                const types = f.store === ANY_STORE ? [] : (Array.isArray(f.types) && f.types.length ? f.types
                    : src.stores.find((x) => x.store === f.store)?.types || []);
                const found = src.wf.checkFlow(f.flow, f.store, types, { actions: true });
                if (found.length) {
                    problems.push({ ...at, message: `${found.length} thing${found.length === 1 ? '' : 's'} to fix in its steps — see the list above the flow.` });
                }
            }
        }
        if (problems.length) {
            const p0 = problems[0];
            view = p0.view;
            if (p0.pick) picked[view] = p0.pick;
            renderAll();
            return;
        }
        // Each workflow that changed, into its own project.json.
        for (const src of sources.filter(dirtyOf)) {
            const sent = src.model.withoutTypeActions(src.draft, src.stored, src.types);
            try {
                await src.wf.saveWorkflow(sent);
                src.stored = src.wf.workflowConfig();
                src.base = JSON.stringify(src.model.withTypeActions(src.stored, src.types));
                src.draft = JSON.parse(src.base);
            } catch (err) {
                // The bridge names a type's action, or a flow, by its place in what it was sent.
                const where = (text) => (src.label && sources.length > 1 ? `${src.label} › ${text}` : text);
                problems.push(...(err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }]).map((p) => {
                    const ta = /^workflow\.types\.([a-z]+)\.([a-z]+)\[(\d+)\]/.exec(p.where || '');
                    if (ta) {
                        const [, store, type, i] = ta;
                        const t = src.types.find((x) => x.store === store && x.type === type);
                        const a = sent.types?.[store]?.[type]?.[Number(i)];
                        return { ...p, view: t ? keyOf(src, t) : null, pick: a?.id, place: t ? where(`${t.label} › ${a?.label || ''}`) : '',
                                 flow: p.node_id ? a?.flow : undefined };
                    }
                    const fl = /^workflow\.flows\[(\d+)\]/.exec(p.where || '');
                    if (fl) {
                        const f = sent.flows?.[Number(fl[1])];
                        return { ...p, view: flowsKey(src), pick: f?.id, flow: f?.id, place: where(f?.label || '') };
                    }
                    return { ...p, message: where(p.message) };
                }));
            }
        }
        if (problems.length) {
            const p0 = problems.find((p) => p.view);
            if (p0) { view = p0.view; if (p0.pick) picked[view] = p0.pick; }
        } else {
            eventBus?.emit?.('toast:show', { type: 'info', message: `Workflow saved to project.json. Reload ${appName()} for every page to use it.` });
        }
        renderAll();
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
            const saved = JSON.parse(S().base).types?.[t.store]?.[t.type]?.some((x) => x.id === a.id);
            if (!saved) {
                const id = S().model.newActionId(a.label, list.filter((x) => x !== a));
                setMass(t, massOf(t).map((v) => (v === `action:${a.id}` ? `action:${id}` : v)));
                a.id = id;
                picked[view] = id;
                const f = flowById(a.flow);
                if (f && f.label === before && flowUses(f.id).length === 1) {
                    f.label = a.label;
                    if (!JSON.parse(S().base).flows?.some((x) => x.id === f.id)) {
                        f.id = S().wf.newFlowId(f.label, S().draft.flows.filter((x) => x !== f));
                        a.flow = f.id;
                    }
                }
            }
            renderMid(); touch();
            return;
        }
        if (k === 'flow-label') {
            const id = isFlows() ? picked[flowsKey()] : listOf(typeOf(view)).find((x) => x.id === picked[view])?.flow;
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
            const id = isFlows() ? picked[flowsKey()] : listOf(typeOf(view)).find((x) => x.id === picked[view])?.flow;
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
            const f = S().model.newFlow(S().draft.flows = S().draft.flows || [], { label: query.trim() || 'New flow', store: storeChoices()[0].store });
            S().draft.flows.push(f);
            picked[flowsKey()] = f.id;
            query = '';
            note = '';
            renderAll();
            const n = el.querySelector('[data-k="flow-label"]'); n?.focus(); n?.select();
            return;
        }
        if (act === 'remove-action') {
            const t = typeOf(view);
            const list = listOf(t);
            const i = list.findIndex((a) => a.id === picked[view]);
            if (i < 0) return;
            const id = list[i].id;
            list.splice(i, 1);
            setMass(t, massOf(t).filter((v) => v !== `action:${id}`));
            picked[view] = list[Math.min(i, list.length - 1)]?.id;
            note = '';
            renderAll();
            return;
        }
        if (act === 'remove-flow') {
            const flows = S().draft.flows || [];
            const i = flows.findIndex((f) => f.id === picked[flowsKey()]);
            if (i >= 0 && !flowUses(picked[flowsKey()]).length) { flows.splice(i, 1); picked[flowsKey()] = flows[Math.min(i, flows.length - 1)]?.id; }
            note = '';
            renderAll();
            return;
        }
    });

    el.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.bd-wf__item[data-pick]');
        if (!item) return;
        e.preventDefault();
        if (isFlows()) flowMenu(e.clientX, e.clientY, item.dataset.pick);
        else actionMenu(e.clientX, e.clientY, item.dataset.pick);
    });

    renderAll();

    return () => {
        if (dirty()) {
            _kept = { bases: Object.fromEntries(sources.map((x) => [x.id, x.base])),
                      drafts: Object.fromEntries(sources.map((x) => [x.id, x.draft])), view, picked: { ...picked } };
        }
        bar.remove();
        destroyDetail();
    };
}
