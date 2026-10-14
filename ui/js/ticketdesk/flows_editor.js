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
 * A flow is for ONE store, because its steps name that store's fields; it is
 * checked against every type of the store, and again (by the bridge, on save)
 * against each row that uses it. A flow something uses is not removed: the row
 * would silently stop doing what it did. The page says what uses it.
 *
 * Saved, like the rest of the workflow, in `.bugdesk/project.json`.
 */

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { checkFlow, emptyFlow, flowUses, liftInlineFlows, newFlowId, saveWorkflow, workflowConfig } from './workflow.js';
import { flowStoresHere, mountFlowEditor, stepsWord } from './workflow_editor.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** Unsaved changes, kept across leaving the page: `{base, draft, selected}`. */
let _kept = null;

/** The stored workflow with its inline flows lifted — what "no changes" means. */
function baseline() {
    const wf = workflowConfig();
    liftInlineFlows(wf);
    wf.flows = Array.isArray(wf.flows) ? wf.flows : [];
    return wf;
}

/**
 * Fill `el` with the flows manager. Returns its cleanup.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 */
export function mountFlowsManager(el, { eventBus = null } = {}) {
    const stores = flowStoresHere();
    const storeOf = (store) => stores.find((x) => x.store === store);
    const storeLabel = (store) => storeOf(store)?.label || store;

    let base = JSON.stringify(baseline());
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

    el.innerHTML = `
        <div class="bd-flowsmgr">
            <div class="bd-flowsmgr__bar">
                <label class="bd-flows__search">${icon('search')}
                    <input type="search" data-k="query" placeholder="Find a flow" aria-label="Find a flow"></label>
                ${stores.map((x) => `<button type="button" class="ea-btn" data-new="${x.store}">${icon('add')} New ${
                    stores.length > 1 ? `${esc(x.label.toLowerCase())} ` : ''}flow</button>`).join('')}
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
                        ${f.id === selected ? 'aria-current="true"' : ''}>
                <span class="bd-flowsmgr__name">${bad ? icon('error') : ''}${esc(f.label || 'Untitled')}</span>
                <span class="bd-flowsmgr__sub td-dim">${esc(stores.length > 1 ? `${storeLabel(f.store)} · ` : '')}${esc(stepsWord(f.flow))} · ${
                    uses.length ? `used by ${uses.length}` : 'not used yet'}</span>
            </button>`;
        }).join('');
    };

    const renderDetail = () => {
        editor?.destroy();
        editor = null;
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
                ${stores.length > 1 ? `<span class="td-dim">For ${esc(storeLabel(f.store).toLowerCase())}</span>` : ''}
                <button type="button" class="ea-btn bd-flowsmgr__rm" data-act="remove" ${uses.length ? 'disabled' : ''}
                        title="${uses.length ? `Used by ${uses.length}: pick another flow on ${uses.length === 1 ? 'that row' : 'those rows'} in Edit workflow first` : 'Remove this flow'}">${icon('delete')} Remove</button>
            </div>
            <div class="bd-flowsmgr__uses td-dim" title="${esc(uses.join('\n'))}">${uses.length
                ? `Used by ${esc(uses.join(', '))} — a change here changes ${uses.length === 1 ? 'it' : 'them'} too.`
                : 'Not used yet: pick it on a move or an action in Edit workflow.'}</div>
            <div class="bd-flowedit__host bd-flowsmgr__editor"></div>`;
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
        const sent = JSON.parse(JSON.stringify(draft));
        if (!sent.flows.length) delete sent.flows;
        const btn = el.querySelector('[data-act="save"]');
        btn.disabled = true;
        try {
            await saveWorkflow(sent);
            base = JSON.stringify(baseline());
            draft = JSON.parse(base);
            renderAll();
            eventBus?.emit?.('toast:show', { type: 'info', message: `Flows saved to project.json. Reload ${appName()} for every page to use them.` });
        } catch (err) {
            // The bridge names a flow by its place in the list it was sent.
            problems = (err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }]).map((p) => {
                const m = /^workflow\.flows\[(\d+)\]/.exec(p.where || '');
                return { ...p, id: m ? sent.flows?.[Number(m[1])]?.id : undefined };
            });
            const first = problems.find((p) => p.id);
            if (first && !problems.some((p) => p.id === selected)) selected = first.id;
            renderAll();
        }
    };

    el.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (k === 'query') { query = e.target.value; renderList(); return; }
        if (k === 'label' && current()) {
            current().label = e.target.value;
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
            const f = { id: newFlowId(label, draft.flows), label, store: b.dataset.new, flow: emptyFlow() };
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
        if (b.dataset.act === 'remove') {
            const i = draft.flows.findIndex((f) => f.id === selected);
            if (i < 0) return;
            draft.flows.splice(i, 1);
            problems = problems.filter((p) => p.id !== selected);
            const left = shown();
            selected = (left[Math.min(i, left.length - 1)] || null)?.id ?? null;
            renderAll();
            return;
        }
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
    };
}
