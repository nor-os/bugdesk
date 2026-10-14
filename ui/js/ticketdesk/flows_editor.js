/**
 * ticketdesk/flows_editor.js — Settings › Flows: the project's named flows,
 * on their own (STORY-0028).
 *
 * A flow is what a move or a custom action does on the side — ask a question,
 * set a field, add a comment — and since STORY-0028 it is a thing of its own,
 * `{id, label, store, flow}` in `workflow.flows`, that a row in Edit workflow
 * names. This window is where they are listed, renamed, edited, made and
 * removed; Edit workflow is where a row picks one.
 *
 * A flow is for ONE store, because its steps name that store's fields; it is
 * checked against every type of the store, and again (by the bridge, on save)
 * against each row that uses it. A flow something uses is not removed: the row
 * would silently stop doing what it did. The list says what uses it.
 *
 * Saved, like the rest of the workflow, in `.bugdesk/project.json`.
 */

import { ManagedWindow } from '@flexdesk/widgets';

import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { emptyFlow, flowUses, liftInlineFlows, newFlowId, saveWorkflow, workflowConfig } from './workflow.js';
import { flowStoresHere, openFlowEditor, stepsWord } from './workflow_editor.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
let _seq = 1;

/**
 * Open the flows list. Resolves true once saved.
 * @param {object} [o]
 * @param {object} [o.eventBus]
 */
export function openFlowsEditor({ eventBus = null } = {}) {
    const stores = flowStoresHere();
    const draft = workflowConfig();
    liftInlineFlows(draft);
    draft.flows = Array.isArray(draft.flows) ? draft.flows : [];
    let query = '';
    let problems = [];           // from the bridge: {where, message, node_id}

    const body = document.createElement('div');
    body.className = 'bd-flows';

    const storeOf = (store) => stores.find((x) => x.store === store);
    const storeLabel = (store) => storeOf(store)?.label || store;

    const rows = () => {
        const q = query.trim().toLowerCase();
        const shown = draft.flows
            .map((f, i) => ({ f, i, uses: flowUses(draft, f.id) }))
            .filter(({ f }) => storeOf(f.store))
            .filter(({ f }) => !q || String(f.label || f.id).toLowerCase().includes(q));
        if (!draft.flows.length) {
            return `<p class="td-dim bd-flows__empty">No flows yet. A flow is what a move or an action does on the
                side: ask why, set a field, add a comment. Make one here, or from a row in Edit workflow.</p>`;
        }
        if (!shown.length) return '<p class="td-dim bd-flows__empty">No flow matches.</p>';
        return `<div class="bd-flows__hdr"><span>Name</span><span>For</span><span>Steps</span><span>Used by</span><span></span><span></span></div>`
            + shown.map(({ f, i, uses }) => `
            <div class="ea-modal__row bd-flows__row" data-flow="${i}">
                <input type="text" data-k="label" value="${esc(f.label || '')}" placeholder="Name" aria-label="Flow name">
                <span class="td-dim">${esc(storeLabel(f.store))}</span>
                <span class="td-dim">${esc(stepsWord(f.flow))}</span>
                <span class="bd-flows__uses" title="${esc(uses.map((u) => u.owner).join('\n'))}">${uses.length
                    ? esc(uses.map((u) => u.owner).join(', ')) : '<span class="td-dim">nothing yet</span>'}</span>
                <button type="button" class="bd-workflow__flowedit" data-edit="${i}" title="Edit this flow">${icon('edit')}</button>
                <button type="button" class="bd-schema__rm" data-rm="${i}" ${uses.length ? 'disabled' : ''}
                        title="${uses.length ? `Used by ${uses.length}: pick another flow on ${uses.length === 1 ? 'that row' : 'those rows'} in Edit workflow first` : 'Remove this flow'}">${icon('close')}</button>
            </div>`).join('');
    };

    const render = () => {
        const focused = document.activeElement?.dataset?.k === 'query';
        body.innerHTML = `
            <div class="bd-flows__main">
                <div class="bd-flows__bar">
                    <label class="bd-flows__search">${icon('search')}
                        <input type="search" data-k="query" value="${esc(query)}" placeholder="Find a flow" aria-label="Find a flow"></label>
                    ${stores.map((x) => `<button type="button" class="ea-btn" data-new="${x.store}">${icon('add')} New ${
                        stores.length > 1 ? `${esc(x.label.toLowerCase())} ` : ''}flow</button>`).join('')}
                </div>
                <div class="bd-flows__list">${rows()}</div>
                ${problems.length ? `<div class="bd-schema__problems" role="alert">${icon('error')}<ul>${
                    problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul></div>` : ''}
            </div>
            <div class="ea-modal__actions bd-schema__actions">
                <span class="td-dim bd-schema__path">Saved to .bugdesk/project.json — commit it to share it.</span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>`;
        if (focused) {
            const q = body.querySelector('[data-k="query"]');
            q.focus();
            q.setSelectionRange(q.value.length, q.value.length);
        }
    };

    const edit = async (i) => {
        const f = draft.flows[i];
        const s = storeOf(f.store);
        const uses = flowUses(draft, f.id);
        const result = await openFlowEditor({
            name: f.label, store: f.store, types: s.types, graph: f.flow, actions: true,
            serverFindings: problems.filter((p) => p.where === `workflow.flows[${i}]` && p.node_id),
            usedElsewhere: uses.length,
        });
        if (result === undefined) return;
        f.label = result.name;
        f.flow = result.graph;
        render();
    };

    body.addEventListener('input', (e) => {
        if (e.target.dataset.k === 'query') { query = e.target.value; render(); return; }
        const row = e.target.closest('[data-flow]');
        if (row && e.target.dataset.k === 'label') draft.flows[Number(row.dataset.flow)].label = e.target.value;
    });

    body.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        if (b.dataset.new) {
            const s = storeOf(b.dataset.new);
            const result = await openFlowEditor({ name: query.trim() || 'New flow', store: s.store, types: s.types, graph: emptyFlow(), actions: true });
            if (result === undefined) return;
            draft.flows.push({ id: newFlowId(result.name, draft.flows), label: result.name, store: s.store, flow: result.graph });
            query = '';
            render();
            return;
        }
        if (b.dataset.edit) { await edit(Number(b.dataset.edit)); return; }
        if (b.dataset.rm) { draft.flows.splice(Number(b.dataset.rm), 1); render(); return; }
        if (b.dataset.act === 'cancel') { close(false); return; }
        if (b.dataset.act === 'save') await save();
    });

    const save = async () => {
        problems = [];
        const unnamed = draft.flows.findIndex((f) => !String(f.label || '').trim());
        if (unnamed >= 0) {
            problems = [{ where: `workflow.flows[${unnamed}]`, message: 'Every flow needs a name.' }];
            render();
            return;
        }
        try {
            if (!draft.flows.length) delete draft.flows;
            await saveWorkflow(draft);
            eventBus?.emit?.('toast:show', { type: 'info', message: `Flows saved to project.json. Reload ${appName()} for every page to use them.` });
            close(true);
        } catch (err) {
            draft.flows = draft.flows || [];
            problems = err.problems?.length ? err.problems : [{ where: '', message: err.message || String(err) }];
            render();
        }
    };

    let settle;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-flows-${_seq++}`, title: 'Flows', icon: 'account_tree', content: body,
        modal: true, canMinimize: false, canMaximize: true, canResize: true, canDrag: true,
        defaultWidth: 860, defaultHeight: 520, onClose: () => close(false),
    });
    function close(saved) {
        if (closed) return;
        closed = true;
        try { win.close({ force: true }); } catch { /* closing */ }
        settle(saved);
    }
    render();
    win.show();
    return done;
}
