/**
 * ticketdesk/workflow_editor.js — Settings › Workflow: the moves each status
 * offers, what a move does on the side, and the custom actions.
 *
 * THE MOVES ARE A PLAIN TABLE — from status, label, target, whether it needs a
 * message — because that is a state machine, not a step flow: one table for the
 * bug store, one per backlog type. A store or type with no table moves exactly
 * as it always has; "Customise" starts a table from those built-in moves, so
 * changing one label does not mean retyping the rest.
 *
 * WHAT A MOVE DOES is a flow: one of the project's NAMED flows (STORY-0028),
 * managed in Settings › Flows (./flows_editor.js) and picked on the row from a
 * searchable list — or made there and then, by "New flow" or by typing a name
 * that is not a flow yet. A flow opens in FlexDesk's outline editor
 * (`@flexdesk/flow`), which only edits: the steps, the checks and the runner
 * are ./workflow.js's. A flow is checked as it is edited, and its problems are
 * drawn on the step in the editor's findings strip with Go to it; the bridge
 * checks again on save and refuses the whole workflow on any problem.
 *
 * MASS ACTIONS (STORY-0029) are a third group: per store and type, which of
 * Change assignee, Change status and the type's custom actions a list offers
 * over its ticked rows (./mass_actions.js). Unconfigured, the first two.
 *
 * Saved in `.bugdesk/project.json`'s `workflow`, committed and shared.
 */

import { ManagedWindow } from '@flexdesk/widgets';
import {
    createOutlineEditor, createStepCatalogue, createWidgetRegistry, TEMPLATE_REFERENCES,
} from '@flexdesk/flow';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { CONFIG } from './instance.js';
import { STORE_TYPES } from './schema.js';
import { attachSelect } from './select_field.js';
import {
    BLOCKS, CATEGORIES, DEFAULT_MASS_ACTIONS, builtinMoves, checkFlow, configuredFlows, emptyFlow, fieldChoices,
    liftInlineFlows, newFlowId, saveWorkflow, statusesOf, stepTypes, workflowConfig,
} from './workflow.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
let _seq = 1;

/** The tables this page can configure: `[key, store, types, label, group]` —
 *  the move tables first, then one action list per record type. */
function tablesHere() {
    const store = CONFIG.store || {};
    const moves = [], actions = [], mass = [];
    const bugs = store.hasBugs !== false && CONFIG.mode !== 'tracker';
    const backlog = store.hasBacklog !== false;
    const offered = CONFIG.mode === 'tracker' ? ['project', 'epic', 'story', 'task'] : ['epic', 'story', 'task'];
    const itemsWord = CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog';
    if (bugs) moves.push(['bugs', 'bugs', ['bug', 'regression', 'task'], 'Bugs', 'Moves']);
    if (backlog) {
        for (const [t, label] of STORE_TYPES.backlog) {
            if (offered.includes(t)) moves.push([`backlog.${t}`, 'backlog', [t], `${itemsWord} › ${label}`, 'Moves']);
        }
    }
    if (bugs) for (const [t, label] of STORE_TYPES.bugs) actions.push([`actions.bugs.${t}`, 'bugs', [t], label, 'Actions']);
    if (backlog) {
        for (const [t, label] of STORE_TYPES.backlog) {
            if (offered.includes(t)) actions.push([`actions.backlog.${t}`, 'backlog', [t], label, 'Actions']);
        }
    }
    if (bugs) for (const [t, label] of STORE_TYPES.bugs) mass.push([`mass.bugs.${t}`, 'bugs', [t], label, 'Mass actions']);
    if (backlog) {
        for (const [t, label] of STORE_TYPES.backlog) {
            if (offered.includes(t)) mass.push([`mass.backlog.${t}`, 'backlog', [t], label, 'Mass actions']);
        }
    }
    return [...moves, ...actions, ...mass];
}

/* STORY-0029: `massActions.<store>.<type>`, null while the type offers the defaults. */
const isMass = (key) => key.startsWith('mass.');
const massOf = (draft, key) => {
    const [, store, type] = key.split('.');
    const list = draft.massActions?.[store]?.[type];
    return Array.isArray(list) ? list : null;
};
const setMass = (draft, key, list) => {
    const [, store, type] = key.split('.');
    draft.massActions = draft.massActions || {};
    draft.massActions[store] = draft.massActions[store] || {};
    if (list) draft.massActions[store][type] = list; else delete draft.massActions[store][type];
    if (!Object.keys(draft.massActions[store]).length) delete draft.massActions[store];
    if (!Object.keys(draft.massActions).length) delete draft.massActions;
};
/** What a type's mass actions may be: the two built-ins and its named custom actions. */
const massChoices = (draft, key) => {
    const [, store, type] = key.split('.');
    return [
        ['assignee', 'Change assignee', 'One person, set on every ticked record.'],
        ['status', 'Change status to…', 'Only the statuses every ticked record can move to from where it is; a message the move needs is asked once and saved on each.'],
        ...actionsOf(draft, `actions.${store}.${type}`).filter((a) => a.id && String(a.label || '').trim())
            .map((a) => [`action:${a.id}`, a.label, 'This custom action, run on every ticked record; its questions are asked once.']),
    ];
};

const isActions = (key) => key.startsWith('actions.');
const actionsOf = (draft, key) => {
    const [, store, type] = key.split('.');
    return draft.actions?.[store]?.[type] || [];
};
const setActions = (draft, key, list) => {
    const [, store, type] = key.split('.');
    draft.actions = draft.actions || {};
    draft.actions[store] = draft.actions[store] || {};
    if (list.length) draft.actions[store][type] = list; else delete draft.actions[store][type];
    if (!Object.keys(draft.actions[store]).length) delete draft.actions[store];
    if (!Object.keys(draft.actions).length) delete draft.actions;
};

const tableOf = (draft, key) => {
    if (key === 'bugs') return draft.bugs?.moves || null;
    const t = key.split('.')[1];
    return draft.backlog?.[t]?.moves || null;
};
const setTable = (draft, key, moves) => {
    if (key === 'bugs') {
        if (moves) draft.bugs = { ...(draft.bugs || {}), moves }; else delete draft.bugs;
        return;
    }
    const t = key.split('.')[1];
    draft.backlog = draft.backlog || {};
    if (moves) draft.backlog[t] = { ...(draft.backlog[t] || {}), moves }; else delete draft.backlog[t];
    if (!Object.keys(draft.backlog).length) delete draft.backlog;
};

const statusLabel = (s) => (s === '*' ? 'Any status' : s);
export const stepCount = (flow) => (flow?.nodes || []).filter((n) => n.type !== 'start').length;
export const stepsWord = (flow) => { const n = stepCount(flow); return `${n} step${n === 1 ? '' : 's'}`; };

/** The stores flows can be made for here, `{store, types, label}` — the types a
 *  named flow is checked against are every type of its store offered here. */
export function flowStoresHere() {
    const out = [];
    for (const [key, store, types, label] of tablesHere()) {
        if (isActions(key)) continue;
        const have = out.find((x) => x.store === store);
        if (have) { for (const t of types) if (!have.types.includes(t)) have.types.push(t); continue; }
        out.push({ store, types: [...types], label: store === 'bugs' ? 'Bugs' : label.split(' › ')[0] });
    }
    return out;
}

const NEW_FLOW = '__new__';

/**
 * A row's flow picker: the store's named flows, searchable, plus "New flow" —
 * and typing a name that is no flow yet makes one by that name.
 */
function attachFlowPicker(el, { draft, store, holder, onNew, onPick }) {
    return attachSelect(el, {
        value: typeof holder.flow === 'string' ? holder.flow : '',
        allowNew: true,
        placeholder: 'Find a flow, or name a new one',
        emptyLabel: 'No flow',
        newLabel: (typed) => `New flow “${typed}”`,
        optionsFor: () => [
            { value: '', label: 'No flow', hint: 'the move does nothing more' },
            ...configuredFlows(store, draft.flows).map((f) => ({ value: f.id, label: f.label || f.id, icon: 'account_tree', hint: stepsWord(f.flow) })),
            { value: NEW_FLOW, label: 'New flow…', icon: 'add' },
        ],
        onChange: (v) => {
            if (v === NEW_FLOW) onNew(String(holder.label || '').trim() || 'New flow');
            else if (!v || configuredFlows(store, draft.flows).some((f) => f.id === v)) onPick(v);
            else onNew(v);                                   // a typed name: a new flow called that
        },
    });
}

/**
 * Open the workflow editor. Resolves true once saved.
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {string} [o.start]  open on the first page whose key starts with this ('mass.')
 */
export function openWorkflowEditor({ eventBus = null, start = '' } = {}) {
    const tables = tablesHere();
    const draft = workflowConfig();
    // Flows stored inside a row (before STORY-0028) become named ones in the draft.
    liftInlineFlows(draft);
    draft.flows = Array.isArray(draft.flows) ? draft.flows : [];
    for (const byType of Object.values(draft.actions || {})) {
        for (const list of Object.values(byType || {})) for (const a of list || []) a.saved = true;
    }
    let cur = (start && tables.find(([k]) => k.startsWith(start))?.[0]) || tables[0]?.[0];
    let problems = [];           // from the bridge: {where, message, node_id}
    let selects = [];

    const body = document.createElement('div');
    body.className = 'bd-schema bd-workflow';

    const curSpec = () => tables.find(([k]) => k === cur);

    const nav = () => tables.map(([key, , , label, group], i) => {
        const n = isActions(key) ? actionsOf(draft, key).length : 0;
        const badge = isMass(key) ? (massOf(draft, key) ? '<span class="bd-schema__count">custom</span>' : '')
            : isActions(key) ? (n ? `<span class="bd-schema__count">${n}</span>` : '')
                : (tableOf(draft, key) ? '<span class="bd-schema__count">custom</span>' : '');
        return `${i === 0 || tables[i - 1][4] !== group ? `<div class="bd-schema__group">${esc(group)}</div>` : ''}
        <button type="button" class="bd-schema__type${key === cur ? ' bd-schema__type--on' : ''}" data-table="${key}">
            ${esc(label)}${badge}
        </button>`;
    }).join('');

    /** A row's flow: the picker, and the button that opens the chosen flow. */
    const flowCell = (kind, i, row) => `<span class="bd-workflow__flowcell">
            <select data-flowsel="${kind}:${i}"></select>
            <button type="button" class="bd-workflow__flowedit" data-editflow="${kind}:${i}" ${row.flow ? '' : 'disabled'}
                    title="${row.flow ? 'Edit this flow' : 'Choose or make a flow first'}">${icon('edit')}</button>
        </span>`;

    const holderOf = (kind, i) => (kind === 'action' ? actionsOf(draft, cur) : tableOf(draft, cur))[i];
    const whereOf = (kind, i) => {
        if (kind === 'action') return `workflow.${cur}[${i}]`;
        return cur === 'bugs' ? `workflow.bugs.moves[${i}]` : `workflow.backlog.${cur.split('.')[1]}.moves[${i}]`;
    };

    const flowUseCount = (id) => tables.reduce((n, [key]) => n
        + (isActions(key) ? actionsOf(draft, key) : (tableOf(draft, key) || [])).filter((r) => r.flow === id).length, 0);

    /** Open a row's flow in the outline editor; a new one is added on Done. */
    const editFlow = async (kind, i, { create = null } = {}) => {
        const [, store, types] = curSpec();
        const holder = holderOf(kind, i);
        const entry = create ? null : configuredFlows(store, draft.flows).find((f) => f.id === holder.flow);
        if (!create && !entry) return;
        const fi = entry ? draft.flows.indexOf(entry) : -1;
        const result = await openFlowEditor({
            name: create ?? entry.label, store, types, graph: entry?.flow || null, actions: kind === 'action',
            serverFindings: problems.filter((p) => (p.where === whereOf(kind, i) || p.where === `workflow.flows[${fi}]`) && p.node_id),
            usedElsewhere: entry ? Math.max(0, flowUseCount(entry.id) - 1) : 0,
        });
        if (result === undefined) { render(); return; }      // cancelled: the picker shows what it showed
        if (entry) { entry.flow = result.graph; entry.label = result.name; }
        else {
            const id = newFlowId(result.name, draft.flows);
            draft.flows.push({ id, label: result.name, store, flow: result.graph });
            holder.flow = id;
        }
        render();
    };

    /** One record type's custom actions: a name, where it is offered, a flow. */
    const actionRows = () => {
        const [, store, types] = curSpec();
        const list = actionsOf(draft, cur);
        const head = list.length ? `<div class="bd-workflow__ahdr"><span></span><span>Action</span>
            <span title="The statuses it is offered in, comma-separated; empty means every status">Offered in</span><span title="What the action does: one of the flows in Settings › Flows">Flow</span><span></span></div>` : '';
        return `<p class="td-dim bd-workflow__lede">An action is a button beside the moves — <i>Blocked</i>, say — that runs
                a flow: ask why, add it as a comment, move to a status. Like a move, it is saved once, and
                cancelling a question saves nothing. Statuses here: ${statusesOf(store, types[0]).map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>`
            + head + list.map((a, i) => `
            <div class="ea-modal__row bd-workflow__arow" data-action="${i}">
                <span class="bd-schema__move">
                    <button type="button" data-aup="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow_upward')}</button>
                    <button type="button" data-adown="${i}" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrow_downward')}</button>
                </span>
                <input type="text" data-k="label" value="${esc(a.label || '')}" placeholder="Blocked" aria-label="Action name">
                <input type="text" class="td-mono" data-k="when" value="${esc((a.when || []).join(', '))}" placeholder="every status" aria-label="Offered in">
                ${flowCell('action', i, a)}
                <button type="button" class="bd-schema__rm" data-arm="${i}" title="Remove this action">${icon('close')}</button>
            </div>`).join('')
            + `<div class="bd-workflow__foot"><button type="button" class="ea-btn" data-act="addaction">${icon('add')} Add action</button></div>`;
    };

    /** STORY-0029: one type's mass actions, a checklist. */
    const massRows = () => {
        const list = massOf(draft, cur);
        const on = list || DEFAULT_MASS_ACTIONS;
        return `<p class="td-dim bd-workflow__lede">Press ${icon('checklist')} Select above a list, tick rows,
                and these are offered over them. One is offered only when every ticked record's type
                offers it. ${list ? '' : 'This type offers the defaults.'}</p>`
            + massChoices(draft, cur).map(([value, label, hint]) => `
            <label class="ea-modal__row bd-workflow__mrow">
                <input type="checkbox" data-mass="${esc(value)}" ${on.includes(value) ? 'checked' : ''}>
                <span><b>${esc(label)}</b><br><span class="td-dim">${esc(hint)}</span></span>
            </label>`).join('')
            + (list ? `<div class="bd-workflow__foot"><button type="button" class="ea-btn" data-act="massdefault"
                        title="Offer Change assignee and Change status, as an unconfigured type does">${icon('restart_alt')} Back to the defaults</button></div>` : '');
    };

    const rows = () => {
        const [, store, types] = curSpec();
        const moves = tableOf(draft, cur);
        if (!moves) {
            return `<div class="bd-workflow__builtin">
                <p class="td-dim">These records move the built-in way${store === 'bugs' ? '' : ' along their ladder'}.
                   Customise to change what each status offers, rename a move, decide which need a message,
                   or give a move a flow.</p>
                <button type="button" class="ea-btn ea-btn--primary" data-act="customise">${icon('tune')} Customise the moves</button>
            </div>`;
        }
        const statuses = [...new Set(types.flatMap((t) => statusesOf(store, t)))];
        const head = `<div class="bd-workflow__hdr"><span></span><span>From</span><span>Move</span><span>To</span>
                        <span title="A message is asked for, and saved as the comment on the move">Message</span><span title="What the move does on the side: one of the flows in Settings › Flows">Flow</span><span></span></div>`;
        return head + moves.map((m, i) => `
            <div class="ea-modal__row bd-workflow__row" data-move="${i}">
                <span class="bd-schema__move">
                    <button type="button" data-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow_upward')}</button>
                    <button type="button" data-down="${i}" title="Move down" ${i === moves.length - 1 ? 'disabled' : ''}>${icon('arrow_downward')}</button>
                </span>
                <select data-k="from" data-sel="from:${i}">${['*', ...statuses].map((s) =>
                    `<option value="${esc(s)}"${s === m.from ? ' selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select>
                <input type="text" data-k="label" value="${esc(m.label || '')}" placeholder="Hand to testing" aria-label="Label">
                <select data-k="to" data-sel="to:${i}">${statuses.map((s) =>
                    `<option value="${esc(s)}"${s === m.to ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
                <label class="bd-schema__req"><input type="checkbox" data-k="message" ${m.message ? 'checked' : ''}></label>
                ${flowCell('move', i, m)}
                <button type="button" class="bd-schema__rm" data-rm="${i}" title="Remove this move">${icon('close')}</button>
            </div>`).join('')
            + `<div class="bd-workflow__foot">
                <button type="button" class="ea-btn" data-act="add">${icon('add')} Add move</button>
                <button type="button" class="ea-btn" data-act="builtin" title="Drop this table and move the built-in way again">${icon('restart_alt')} Back to the built-in moves</button>
            </div>`;
    };

    const render = () => {
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        selects = [];
        const [, , , label] = curSpec() || [];
        const prefix = isMass(cur) ? `workflow.massActions.${cur.slice(5)}`
            : isActions(cur) ? `workflow.${cur}` : (cur === 'bugs' ? 'workflow.bugs' : `workflow.backlog.${cur.split('.')[1]}`);
        const mine = problems.filter((p) => p.where.startsWith(prefix));
        body.innerHTML = `
            <nav class="bd-schema__nav" aria-label="Move tables">${nav()}</nav>
            <div class="bd-schema__main">
                <h3 class="bd-schema__h">${isMass(cur) ? 'Mass actions' : isActions(cur) ? 'Actions' : 'Moves'} › ${esc(label || '')}</h3>
                <div class="bd-workflow__moves">${isMass(cur) ? massRows() : isActions(cur) ? actionRows() : rows()}</div>
                ${problems.length ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${
                    (mine.length ? mine : problems).map((p) => `<li>${esc(p.message)}</li>`).join('')}${
                    mine.length && mine.length < problems.length ? `<li class="td-dim">… and ${problems.length - mine.length} on other tables</li>` : ''}</ul></div>` : ''}
            </div>
            <div class="ea-modal__actions bd-schema__actions">
                <span class="td-dim bd-schema__path">Saved to .bugdesk/project.json — commit it to share it.</span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>`;
        for (const el of body.querySelectorAll('select[data-flowsel]')) {
            const [kind, idx] = el.dataset.flowsel.split(':');
            const i = Number(idx);
            const holder = holderOf(kind, i);
            selects.push(attachFlowPicker(el, {
                draft, store: curSpec()[1], holder,
                onNew: (name) => editFlow(kind, i, { create: name }),
                onPick: (id) => { if (id) holder.flow = id; else delete holder.flow; render(); },
            }));
        }
        for (const el of body.querySelectorAll('select[data-sel]')) {
            const [k, idx] = el.dataset.sel.split(':');
            selects.push(attachSelect(el, {
                options: [...el.options].map((o) => ({ value: o.value, label: o.textContent })),
                value: el.value,
                onChange: (v) => { tableOf(draft, cur)[Number(idx)][k] = v; },
            }));
        }
    };

    body.addEventListener('input', (e) => {
        const arow = e.target.closest('[data-action]');
        if (arow) {
            const a = actionsOf(draft, cur)[Number(arow.dataset.action)];
            if (e.target.dataset.k === 'label') {
                a.label = e.target.value;
                if (!a.saved) a.id = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            }
            if (e.target.dataset.k === 'when') a.when = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
            return;
        }
        const row = e.target.closest('[data-move]');
        if (!row) return;
        const m = tableOf(draft, cur)[Number(row.dataset.move)];
        if (e.target.dataset.k === 'label') m.label = e.target.value;
        if (e.target.dataset.k === 'message') m.message = e.target.checked;
    });
    body.addEventListener('change', (e) => {
        if (e.target.dataset.mass !== undefined && isMass(cur)) {
            // In the checklist's order, so the bar's order follows it.
            const on = new Set(massOf(draft, cur) || DEFAULT_MASS_ACTIONS);
            if (e.target.checked) on.add(e.target.dataset.mass); else on.delete(e.target.dataset.mass);
            setMass(draft, cur, massChoices(draft, cur).map(([v]) => v).filter((v) => on.has(v)));
            render();
            return;
        }
        const row = e.target.closest('[data-move]');
        if (row && e.target.dataset.k === 'message') tableOf(draft, cur)[Number(row.dataset.move)].message = e.target.checked;
    });

    body.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const moves = tableOf(draft, cur);
        if (b.dataset.table) { cur = b.dataset.table; render(); return; }
        if (b.dataset.act === 'massdefault') { setMass(draft, cur, null); render(); return; }
        if (b.dataset.editflow) {
            const [kind, idx] = b.dataset.editflow.split(':');
            await editFlow(kind, Number(idx));
            return;
        }
        if (isActions(cur)) {
            const list = actionsOf(draft, cur);
            if (b.dataset.act === 'addaction') {
                list.push({ id: '', label: '', when: [] });
                setActions(draft, cur, list);
                render();
                body.querySelector(`[data-action="${list.length - 1}"] [data-k="label"]`)?.focus();
                return;
            }
            if (b.dataset.aup || b.dataset.adown) {
                const i = Number(b.dataset.aup ?? b.dataset.adown), j = i + (b.dataset.aup ? -1 : 1);
                if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
                render(); return;
            }
            if (b.dataset.arm) { list.splice(Number(b.dataset.arm), 1); setActions(draft, cur, list); render(); return; }
        }
        if (b.dataset.act === 'customise') {
            const [, store, types] = curSpec();
            setTable(draft, cur, builtinMoves(store, types[0]));
            render(); return;
        }
        if (b.dataset.act === 'builtin') { setTable(draft, cur, null); render(); return; }
        if (b.dataset.act === 'add') {
            const [, store, types] = curSpec();
            const st = statusesOf(store, types[0]);
            moves.push({ from: st[0], label: '', to: st[1] || st[0], message: false });
            render();
            body.querySelector(`[data-move="${moves.length - 1}"] [data-k="label"]`)?.focus();
            return;
        }
        if (b.dataset.up || b.dataset.down) {
            const i = Number(b.dataset.up ?? b.dataset.down), j = i + (b.dataset.up ? -1 : 1);
            if (j >= 0 && j < moves.length) [moves[i], moves[j]] = [moves[j], moves[i]];
            render(); return;
        }
        if (b.dataset.rm) { moves.splice(Number(b.dataset.rm), 1); render(); return; }
        if (b.dataset.act === 'cancel') { close(false); return; }
        if (b.dataset.act === 'save') await save();
    });

    const save = async () => {
        problems = [];
        // An unlabelled row is one somebody added and never filled in.
        for (const [key] of tables) {
            if (isActions(key)) {
                setActions(draft, key, actionsOf(draft, key)
                    .filter((a) => String(a.label || '').trim())
                    .map(({ saved, ...a }) => ({ ...a, id: a.id || a.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') })));
                continue;
            }
            if (isMass(key)) continue;
            const m = tableOf(draft, key);
            if (m) setTable(draft, key, m.filter((x) => String(x.label || '').trim()));
        }
        // A mass action naming a custom action removed (or renamed) above.
        for (const [key] of tables) {
            const list = isMass(key) ? massOf(draft, key) : null;
            if (!list) continue;
            const [, store, type] = key.split('.');
            const ids = new Set(actionsOf(draft, `actions.${store}.${type}`).map((a) => `action:${a.id}`));
            setMass(draft, key, list.filter((v) => !v.startsWith('action:') || ids.has(v)));
        }
        try {
            await saveWorkflow(draft);
            eventBus?.emit?.('toast:show', { type: 'info', message: `Workflow saved to project.json. Reload ${appName()} for every page to use it.` });
            close(true);
        } catch (err) {
            problems = err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }];
            render();
        }
    };

    let settle;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-workflow-${_seq++}`, title: 'Workflow', icon: 'account_tree', content: body,
        modal: true, canMinimize: false, canMaximize: true, canResize: true, canDrag: true,
        defaultWidth: 920, defaultHeight: 600, onClose: () => close(false),
    });
    function close(saved) {
        if (closed) return;
        closed = true;
        for (const s of selects) { try { s.destroy(); } catch { /* gone */ } }
        try { win.close({ force: true }); } catch { /* closing */ }
        settle(saved);
    }
    render();
    win.show();
    return done;
}

/** A flow window's title. */
export const flowTitle = (name) => `Flow — ${String(name || '').trim() || 'Untitled'}`;

/**
 * One named flow in FlexDesk's outline editor, in a window of its own, titled
 * "Flow — <name>", with the name editable above the steps. Resolves
 * `{name, graph}`, or `undefined` when cancelled. Done is refused while the
 * flow has problems, or has no name.
 *
 * @param {object} o
 * @param {string} o.name
 * @param {'bugs'|'backlog'} o.store
 * @param {string[]} o.types      what it is checked against: the row's type(s), or every type of the store
 * @param {object} [o.graph]
 * @param {boolean} [o.actions]   "Move to a status" is offered: an action's flow, or one edited on its own
 * @param {Array} [o.serverFindings]  the bridge's problems for this flow
 * @param {number} [o.usedElsewhere]  other rows using it — said in the footer, since an edit changes them too
 */
export function openFlowEditor({ name = '', store, types, graph = null, actions = false, serverFindings = [], usedElsewhere = 0 }) {
    const body = document.createElement('div');
    body.className = 'bd-flowedit';
    const note = usedElsewhere
        ? `Also used by ${usedElsewhere} other move${usedElsewhere === 1 ? '' : 's'} or action${usedElsewhere === 1 ? '' : 's'}: a change here changes ${usedElsewhere === 1 ? 'it' : 'them'} too.`
        : 'Runs in the page when the move is made; nothing is saved until it has finished.';
    body.innerHTML = `
        <label class="bd-flowedit__name"><span>Name</span>
            <input type="text" data-k="name" value="${esc(name)}" placeholder="Ask why it is blocked" aria-label="Flow name"></label>
        <div class="bd-flowedit__host"></div>
        <div class="ea-modal__actions bd-schema__actions">
            <span class="td-dim bd-schema__path" data-slot="note">${esc(note)}</span>
            <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
            <button type="button" class="ea-btn ea-btn--primary" data-act="done">Done</button>
        </div>`;
    const nameInput = body.querySelector('[data-k="name"]');
    const editor = mountFlowEditor(body.querySelector('.bd-flowedit__host'), { store, types, graph, actions, serverFindings });

    let settle;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-flow-${_seq++}`, title: flowTitle(name), icon: 'account_tree', content: body,
        modal: true, canMinimize: false, canMaximize: true, canResize: true, canDrag: true,
        defaultWidth: 860, defaultHeight: 600, onClose: () => close(undefined),
    });
    function close(value) {
        if (closed) return;
        closed = true;
        editor.destroy();
        try { win.close({ force: true }); } catch { /* closing */ }
        settle(value);
    }
    nameInput.addEventListener('input', () => win.setTitle(flowTitle(nameInput.value)));
    body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') close(undefined);
        else if (act === 'done') {
            const slot = body.querySelector('[data-slot="note"]');
            if (!nameInput.value.trim()) { slot.textContent = 'Give the flow a name first.'; nameInput.focus(); return; }
            const findings = editor.check();
            if (findings.length) {
                slot.textContent = `${findings.length} thing${findings.length === 1 ? '' : 's'} to fix first — see the list above the flow.`;
                return;
            }
            close({ name: nameInput.value.trim(), graph: editor.getGraph() });
        }
    });
    win.show();
    return done;
}

/**
 * FlexDesk's outline editor over one flow, mounted into `host` — the window
 * above, and Settings › Flows, which edits a flow on the page itself.
 * Checked as it is edited; `serverFindings` are the bridge's refusals of the
 * last save, drawn on their steps until the next edit.
 * @returns {{getGraph: () => object, check: () => object[], destroy: () => void}}
 */
export function mountFlowEditor(host, { store, types, graph = null, actions = false, serverFindings = [], onChange = null }) {
    const catalogue = createStepCatalogue(stepTypes(store, types, { actions }), { categories: CATEGORIES });

    // Insert a value: what earlier prompts answered, and the record's fields.
    const fieldGroup = {
        id: 'record', label: 'This record', sub: 'its value when the move is made',
        items: [...fieldChoices(store, types, { readable: true }), ['id', 'Id']]
            .map(([n, l]) => ({ label: l, type: 'field', ref: `\${record.${n}}` })),
    };
    let editor = null;
    const values = async ({ before }) => {
        const graphNow = editor?.getGraph() || {};
        const byId = new Map((graphNow.nodes || []).map((n) => [n.id, n]));
        const prompts = (before || []).map((b) => (typeof b === 'string' ? byId.get(b) : b))
            .filter((n) => n && n.type === 'prompt');
        return [
            { id: 'input', label: 'Answers', sub: 'from the questions asked before this step',
              empty: 'No question is asked before this step.',
              items: prompts.map((n) => ({ label: n.label || n.config?.question || n.id, type: 'answer', ref: `\${input.${n.id}}` })) },
            fieldGroup,
        ];
    };

    const check = () => {
        if (!editor) return [];
        const findings = [...checkFlow(editor.getGraph(), store, types, { actions }),
            ...serverFindings.map((p) => ({ code: 'bridge', message: p.message, severity: 'error', node_id: p.node_id }))];
        editor.setFindings(findings);
        return findings;
    };

    editor = createOutlineEditor(host, {
        catalogue, widgets: createWidgetRegistry(), references: { template: TEMPLATE_REFERENCES },
        blocks: BLOCKS, values,
        valuesNote: 'Only questions asked before this step, on every path, are listed.',
        summarise: (node) => summariseStep(node),
        onChange: () => { serverFindings = []; check(); onChange?.(); },
    });
    editor.load({ graph: graph ? JSON.parse(JSON.stringify(graph)) : emptyFlow() });
    check();
    let gone = false;
    return {
        getGraph: () => editor.getGraph(),
        check,
        destroy: () => { if (gone) return; gone = true; try { editor.destroy(); } catch { /* gone */ } },
    };
}

/** A step's one line in the outline. */
function summariseStep(node) {
    const c = node.config || {};
    switch (node.type) {
        case 'condition': return `${c.field || '?'} ${String(c.op || 'is').replace(/_/g, ' ')}${c.value ? ` ${c.value}` : ''}`;
        case 'require-message': return c.prompt || 'Ask for the message';
        case 'prompt': return c.question || 'Ask a question';
        case 'set-field': return `${c.field || '?'} = ${c.value || '(empty)'}`;
        case 'clear-field': return `clear ${c.field || '?'}`;
        case 'add-comment': return String(c.body || '').split('\n')[0] || 'Add a comment';
        case 'set-status': return `→ ${c.status || '?'}`;
        default: return '';
    }
}
