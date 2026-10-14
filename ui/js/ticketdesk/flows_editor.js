/**
 * ticketdesk/flows_editor.js — Settings › Flows: the project's named flows,
 * on their own (STORY-0028), managed on the page itself.
 *
 * A flow is what a move or a custom action does on the side — ask a question,
 * set a field, add a comment — and since STORY-0028 it is a thing of its own,
 * `{id, label, store, flow}` in `workflow.flows`, that a row in Edit workflow
 * names. This page is where they are listed, renamed, edited, made and
 * removed; Edit workflow is where a row picks one.
 *
 * NO WINDOWS: the list is on the left, the selected flow's name and steps on
 * the right, in FlexDesk's outline editor (mountFlowEditor), and one Save
 * writes the lot. Leave the page with changes unsaved and they are still there
 * when you come back — unless the workflow was saved elsewhere meanwhile, which
 * the page then says.
 *
 * WHICH RECORDS A FLOW IS FOR is a setting of the flow: any record (the
 * default), or bugs or backlog items only, when its steps need that store's own
 * fields. It is checked against those records as it is edited, and again (by
 * the bridge, on save) against each row that uses it; the setting only offers
 * what every row using the flow can take. A flow something uses is not removed:
 * the row would silently stop doing what it did. The page says what uses it.
 *
 * Right-click a flow in the list to open, rename, duplicate or delete it.
 *
 * EVERY TRANSITION HAS A FLOW, the built-in ones included: a move that asks
 * for a message has a flow that asks it, with the same question, and the rest
 * an empty one to extend (workflow.js's withBuiltinFlows). They are listed
 * like any other; what is still exactly built-in is left out when the page
 * saves (withoutBuiltinFlows), so a change is what reaches project.json.
 *
 * Saved, like the rest of the workflow, in `.bugdesk/project.json`.
 */

import { showContextMenu } from '@flexdesk/widgets';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { attachSelect } from './select_field.js';
import {
    ANY_STORE, checkFlow, emptyFlow, flowSlots, flowUses, newFlowId, saveWorkflow, withBuiltinFlows, withoutBuiltinFlows,
    workflowConfig,
} from './workflow.js';
import { flowStoresHere, mountFlowEditor, moveTablesHere, stepsWord } from './workflow_editor.js';

/** Each "for" its tone (FlexDesk's flow tones) — the list's chips. */
const TONE = { [ANY_STORE]: 'violet', bugs: 'amber', backlog: 'teal' };

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** Unsaved changes, kept across leaving the page: `{base, draft, selected}`. */
let _kept = null;

/**
 * Fill `el` with the flows manager. Returns its cleanup.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 */
export function mountFlowsManager(el, { eventBus = null } = {}) {
    const stores = flowStoresHere();
    const tables = moveTablesHere();
    const ANY = { store: ANY_STORE, label: 'Any record', types: [] };
    // "Any record" only means something where there are two kinds of record.
    const choices = stores.length > 1 ? [ANY, ...stores] : stores;
    const storeOf = (store) => (store === ANY_STORE ? ANY : stores.find((x) => x.store === store));
    const storeLabel = (store) => storeOf(store)?.label || store;
    const forWord = (store) => (store === ANY_STORE ? 'any record' : storeLabel(store).toLowerCase());

    // What "no changes" means: the stored workflow, every transition with its flow.
    let stored = workflowConfig();
    let base = JSON.stringify(withBuiltinFlows(stored, tables));
    let draft = JSON.parse(base);
    let selected = null;         // the selected flow's id
    let query = '';
    let problems = [];           // from the bridge, or the page's own: {id?, node_id?, message}
    let note = '';
    if (_kept) {
        if (_kept.base === base) ({ draft, selected } = _kept);
        else note = 'Your unsaved flow changes were dropped: the workflow was saved elsewhere meanwhile.';
        _kept = null;
    }
    let editor = null;
    let forSelect = null;

    el.innerHTML = `
        <div class="bd-flowsmgr">
            <div class="bd-flowsmgr__bar">
                <label class="bd-flows__search">${icon('search')}
                    <input type="search" data-k="query" placeholder="Find a flow" aria-label="Find a flow"></label>
                <button type="button" class="ea-btn" data-new="1">${icon('add')} New flow</button>
                <span class="bd-flowsmgr__state td-dim" data-slot="state" aria-live="polite"></span>
                <button type="button" class="ea-btn" data-act="discard">Discard changes</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>
            <div data-slot="problems"></div>
            <div class="bd-flowsmgr__split">
                <div class="bd-flowsmgr__list" data-slot="list" aria-label="Flows"></div>
                <div class="bd-flowsmgr__detail" data-slot="detail"></div>
            </div>
            <div class="td-dim bd-flowsmgr__foot">Saved to .bugdesk/project.json — commit it to share it.</div>
        </div>`;
    const $ = (slot) => el.querySelector(`[data-slot="${slot}"]`);

    const shown = () => draft.flows.filter((f) => storeOf(f.store));
    const current = () => draft.flows.find((f) => f.id === selected) || null;
    const dirty = () => JSON.stringify(draft) !== base;
    const usersOf = (id) => flowUses(draft, id).map((u) => u.owner);

    const renderState = () => {
        const changed = dirty();
        $('state').textContent = note || (changed ? 'Unsaved changes' : '');
        el.querySelector('[data-act="save"]').disabled = !changed;
        el.querySelector('[data-act="discard"]').disabled = !changed;
    };

    const renderProblems = () => {
        $('problems').innerHTML = problems.length
            ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${
                problems.map((p) => `<li>${p.id && p.id !== selected
                    ? `<button type="button" class="bd-flowsmgr__goto" data-pick="${esc(p.id)}">${
                        esc(draft.flows.find((f) => f.id === p.id)?.label || p.id)}</button>: ` : ''}${esc(p.message)}</li>`).join('')}</ul></div>`
            : '';
    };

    const renderList = () => {
        const q = query.trim().toLowerCase();
        const all = shown();
        const list = all.filter((f) => !q || String(f.label || f.id).toLowerCase().includes(q));
        if (!all.length) {
            $('list').innerHTML = `<p class="td-dim bd-flows__empty">No flows yet. A flow is what a move or an action
                does on the side: ask why, set a field, add a comment. Make one with New flow above, or from a row in
                Edit workflow.</p>`;
            return;
        }
        if (!list.length) { $('list').innerHTML = '<p class="td-dim bd-flows__empty">No flow matches.</p>'; return; }
        $('list').innerHTML = list.map((f) => {
            const uses = usersOf(f.id);
            const bad = problems.some((p) => p.id === f.id);
            return `<button type="button" class="bd-flowsmgr__item${f.id === selected ? ' is-selected' : ''}" data-pick="${esc(f.id)}"
                        data-tone="${TONE[f.store] || 'grey'}" ${f.id === selected ? 'aria-current="true"' : ''}
                        title="Right-click for more">
                <span class="bd-flowsmgr__chip">${icon(bad ? 'error' : 'account_tree')}</span>
                <span class="bd-flowsmgr__text">
                    <span class="bd-flowsmgr__name">${esc(f.label || 'Untitled')}</span>
                    <span class="bd-flowsmgr__sub">${esc(stores.length > 1 ? `For ${forWord(f.store)} · ` : '')}${esc(stepsWord(f.flow))} · ${
                        uses.length ? `used by ${uses.length}` : 'not used yet'}</span>
                </span>
            </button>`;
        }).join('');
    };

    /** What the "for" setting may be: whatever every row using the flow can take. */
    const forChoices = (f) => {
        const used = new Set(flowUses(draft, f.id).map((u) => u.store));
        return choices.filter((x) => x.store === ANY_STORE || [...used].every((s) => s === x.store));
    };

    const renderDetail = () => {
        editor?.destroy();
        editor = null;
        forSelect?.destroy();
        forSelect = null;
        const f = current();
        if (!f) {
            $('detail').innerHTML = `<p class="td-dim bd-flowsmgr__none">${shown().length
                ? 'Pick a flow on the left to edit its name and steps.' : ''}</p>`;
            return;
        }
        const uses = usersOf(f.id);
        $('detail').innerHTML = `
            <div class="bd-flowsmgr__head">
                <label class="bd-flowedit__name"><span>Name</span>
                    <input type="text" data-k="label" value="${esc(f.label || '')}" placeholder="Ask why it is blocked" aria-label="Flow name"></label>
                ${stores.length > 1 ? `<label class="bd-flowsmgr__for"><span>For</span><select data-k="store"></select></label>` : ''}
                <button type="button" class="ea-btn bd-flowsmgr__rm" data-act="remove" ${uses.length ? 'disabled' : ''}
                        title="${uses.length ? `Used by ${uses.length}: pick another flow on ${uses.length === 1 ? 'that row' : 'those rows'} in Edit workflow first` : 'Remove this flow'}">${icon('delete')} Remove</button>
            </div>
            <div class="bd-flowsmgr__uses td-dim" title="${esc(uses.join('\n'))}">${uses.length
                ? `Used by ${esc(uses.join(', '))} — a change here changes ${uses.length === 1 ? 'it' : 'them'} too.`
                : 'Not used yet: pick it on a move or an action in Edit workflow.'}</div>
            <div class="bd-flowedit__host bd-flowsmgr__editor"></div>`;
        const sel = $('detail').querySelector('[data-k="store"]');
        if (sel) {
            const allowed = forChoices(f);
            forSelect = attachSelect(sel, {
                value: f.store,
                options: allowed.map((x) => ({ value: x.store, label: x.label,
                    hint: x.store === ANY_STORE ? 'bugs and backlog items: the fields both have' : `its own fields too` })),
                onChange: (v) => {
                    if (!v || v === f.store || !allowed.some((x) => x.store === v)) return;
                    f.store = v;
                    note = '';
                    renderList(); renderDetail(); renderState();
                },
            });
        }
        editor = mountFlowEditor($('detail').querySelector('.bd-flowsmgr__editor'), {
            store: f.store, types: storeOf(f.store).types, graph: f.flow, actions: true,
            serverFindings: problems.filter((p) => p.id === f.id && p.node_id),
            onChange: () => {
                f.flow = editor.getGraph();
                problems = problems.filter((p) => p.id !== f.id);
                note = '';
                renderList(); renderProblems(); renderState();
            },
        });
    };

    const pick = (id) => {
        selected = id;
        renderList(); renderProblems(); renderDetail();
    };

    const renderAll = () => {
        if (!current()) selected = shown()[0]?.id ?? null;
        renderList(); renderProblems(); renderDetail(); renderState();
    };

    const save = async () => {
        problems = [];
        note = '';
        for (const f of shown()) {
            if (!String(f.label || '').trim()) problems.push({ id: f.id, message: 'Every flow needs a name.' });
            const findings = checkFlow(f.flow, f.store, storeOf(f.store).types, { actions: true });
            if (findings.length) {
                problems.push({ id: f.id, message: `${findings.length} thing${findings.length === 1 ? '' : 's'} to fix in its steps — see the list above the flow.` });
            }
        }
        if (problems.length) {
            if (!problems.some((p) => p.id === selected)) selected = problems[0].id;
            renderAll();
            return;
        }
        const sent = withoutBuiltinFlows(draft, stored, tables);
        const btn = el.querySelector('[data-act="save"]');
        btn.disabled = true;
        try {
            await saveWorkflow(sent);
            stored = workflowConfig();
            base = JSON.stringify(withBuiltinFlows(stored, tables));
            draft = JSON.parse(base);
            renderAll();
            eventBus?.emit?.('toast:show', { type: 'info', message: `Flows saved to project.json. Reload ${appName()} for every page to use them.` });
        } catch (err) {
            // The bridge names a flow by its place in the list it was sent, and
            // a row by its own place — whose flow is the one to look at.
            const slots = flowSlots(sent);
            problems = (err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }]).map((p) => {
                const m = /^workflow\.flows\[(\d+)\]/.exec(p.where || '');
                const ref = slots.find((x) => x.where === p.where)?.ref;
                return { ...p, id: m ? sent.flows?.[Number(m[1])]?.id : (typeof ref === 'string' ? ref : undefined) };
            });
            const first = problems.find((p) => p.id);
            if (first && !problems.some((p) => p.id === selected)) selected = first.id;
            renderAll();
        }
    };

    const remove = (id) => {
        const i = draft.flows.findIndex((f) => f.id === id);
        if (i < 0 || flowUses(draft, id).length) return;
        draft.flows.splice(i, 1);
        problems = problems.filter((p) => p.id !== id);
        if (selected === id) {
            const left = shown();
            selected = (left[Math.min(i, left.length - 1)] || null)?.id ?? null;
        }
        renderAll();
    };

    const duplicate = (id) => {
        const f = draft.flows.find((x) => x.id === id);
        if (!f) return;
        const label = `${f.label || 'Flow'} (copy)`;
        const copy = { id: newFlowId(label, draft.flows), label, store: f.store, flow: JSON.parse(JSON.stringify(f.flow || emptyFlow())) };
        draft.flows.splice(draft.flows.indexOf(f) + 1, 0, copy);
        note = '';
        pick(copy.id);
        renderState();
    };

    const rename = (id) => {
        if (selected !== id) pick(id);
        const name = el.querySelector('[data-k="label"]');
        name?.focus();
        name?.select();
    };

    // Right-click a flow: what the page does with one, in one place.
    el.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.bd-flowsmgr__item[data-pick]');
        if (!item) return;
        e.preventDefault();
        const id = item.dataset.pick;
        const uses = flowUses(draft, id).length;
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Open', icon: 'open_in_new', action: 'open' },
            { label: 'Rename', icon: 'edit', action: 'rename' },
            { label: 'Duplicate', icon: 'content_copy', action: 'duplicate' },
            { separator: true },
            { label: uses ? `Delete — used by ${uses}` : 'Delete', icon: 'delete', action: 'delete', danger: true, disabled: !!uses },
        ], (action) => {
            if (action === 'open') pick(id);
            else if (action === 'rename') rename(id);
            else if (action === 'duplicate') duplicate(id);
            else if (action === 'delete') remove(id);
        });
    });

    el.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (k === 'query') { query = e.target.value; renderList(); return; }
        if (k === 'label' && current()) {
            const f = current();
            f.label = e.target.value;
            // Never saved and used by nothing: its id still follows its name.
            if (!JSON.parse(base).flows.some((x) => x.id === f.id) && !flowUses(draft, f.id).length) {
                f.id = newFlowId(f.label, draft.flows.filter((x) => x !== f));
                selected = f.id;
            }
            note = '';
            renderList(); renderState();
        }
    });

    el.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        if (b.dataset.pick) { pick(b.dataset.pick); return; }
        if (b.dataset.new) {
            const label = query.trim() || 'New flow';
            const f = { id: newFlowId(label, draft.flows), label, store: choices[0].store, flow: emptyFlow() };
            draft.flows.push(f);
            query = '';
            el.querySelector('[data-k="query"]').value = '';
            note = '';
            pick(f.id);
            renderState();
            const name = el.querySelector('[data-k="label"]');
            name?.focus();
            name?.select();
            return;
        }
        if (b.dataset.act === 'remove') { remove(selected); return; }
        if (b.dataset.act === 'discard') {
            draft = JSON.parse(base);
            problems = [];
            note = '';
            renderAll();
            return;
        }
        if (b.dataset.act === 'save') await save();
    });

    renderAll();

    return () => {
        if (dirty()) _kept = { base, draft, selected };
        editor?.destroy();
        editor = null;
        forSelect?.destroy();
        forSelect = null;
    };
}
