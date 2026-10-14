/**
 * ticketdesk/workflow_model.js — the workflow as ONE thing (STORY-0030):
 * record types have actions, an action runs a flow, and a flow's "Change the
 * status" step is the move.
 *
 * What is stored did not start that way, and need not end that way for a type
 * nobody changed. A type is one of:
 *
 *   - BUILT-IN: nothing stored; it moves the way the pages always did
 *     (./builtin_moves.js), custom statuses included;
 *   - THE OLDER WAY: a move table (`workflow.bugs.moves`, shared by every bug
 *     type, or `workflow.backlog.<type>.moves`) and custom actions
 *     (`workflow.actions.<store>.<type>`), each still read as it always was;
 *   - ITS OWN LIST: `workflow.types.<store>.<type>`, every action of the type.
 *
 * withTypeActions shows any of them as the third — built-in and older moves
 * grouped into actions ("Close", offered in open, investigation and testing),
 * each with a flow that asks for the move's message, if it took one, and
 * changes the status — and withoutTypeActions saves back only the types that
 * differ from that, so an untouched type keeps following whatever it followed.
 * Pure: no DOM, no fetch.
 */

import { builtinTable } from './builtin_moves.js';
import { ANY_STORE, emptyFlow, flowUses, liftInlineFlows, newFlowId, statusStep, transitionFlow } from './workflow.js';

const clone = (x) => JSON.parse(JSON.stringify(x ?? null));
const TYPE_WORD = { bugs: { bug: 'Bug', regression: 'Regression', task: 'Chore' } };
export const typeWord = (store, t) => TYPE_WORD[store]?.[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'action';
const uniqueId = (base, taken) => {
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    return id;
};

/** The older move table that applies to a type, or null. */
const legacyMoves = (wf, store, type) => {
    const t = store === 'bugs' ? wf?.bugs : wf?.backlog?.[type];
    return Array.isArray(t?.moves) ? t.moves : null;
};

/**
 * A graph that changes the status: `graph` as it is when it already does,
 * else with "Ask for the comment" (when `message`) and "Change status to …"
 * put right after its start — a move's older flow ran beside the move, and
 * the move did both of those.
 */
function withMove(graph, { to, message, prompt }) {
    if (!graph) return transitionFlow({ to, message, prompt });
    if (statusStep(graph)) return clone(graph);
    const g = clone(graph);
    const start = g.nodes.find((n) => n.type === 'start');
    if (!start) return transitionFlow({ to, message, prompt });
    const added = transitionFlow({ to, message, prompt }).nodes.slice(1)
        .map((n) => ({ ...n, id: g.nodes.some((m) => m.id === n.id) ? `${n.id}-move` : n.id }));
    const first = g.connections.find((c) => c.source === start.id && (c.sourcePort || 'out') === 'out');
    g.connections = g.connections.filter((c) => c !== first);
    let at = start.id;
    for (const n of added) {
        g.nodes.push(n);
        g.connections.push({ source: at, sourcePort: 'out', target: n.id, targetPort: 'in' });
        at = n.id;
    }
    if (first) g.connections.push({ source: at, sourcePort: 'out', target: first.target, targetPort: first.targetPort || 'in' });
    return g;
}

/**
 * The workflow as types → actions → flows: every type in `types` (`[{store,
 * type, storeLabel?}]`) gets its whole action list under `types.<store>.<type>`, and the
 * older keys are gone from the result. A flow made here is shared by every
 * action whose steps and name are the same, and is available to the types
 * that use it.
 */
export function withTypeActions(stored, types) {
    const wf = clone(stored || {});
    liftInlineFlows(wf);
    const flows = Array.isArray(wf.flows) ? wf.flows : [];
    const made = new Map();                  // flow id -> Set of types using it, for flows made here
    const storeWord = (store) => types.find((t) => t.store === store)?.storeLabel || typeWord(null, store);
    const flowFor = (store, type, label, graph, to) => {
        // One flow per name and steps. A name another flow already has is told
        // apart by where it goes ("Reopen (→ review)"), then by its store.
        const same = JSON.stringify(graph);
        const names = [label, `${label} (→ ${to})`, `${label} (→ ${to}) — ${storeWord(store)}`];
        let f = flows.find((x) => x.store === store && names.includes(x.label || '') && JSON.stringify(x.flow) === same);
        if (!f) {
            const named = names.find((n) => !flows.some((x) => (x.label || '') === n)) || names[2];
            f = { id: newFlowId(named, flows), label: named, store, flow: graph };
            flows.push(f);
            made.set(f.id, new Set());
        }
        made.get(f.id)?.add(type);
        return f.id;
    };

    const out = { ...wf, flows, types: {} };
    for (const { store, type } of types) {
        out.types[store] = out.types[store] || {};
        const own = wf.types?.[store]?.[type];
        if (Array.isArray(own)) { out.types[store][type] = clone(own); continue; }

        // Moves, grouped: one action per name, target and what it did.
        const rows = legacyMoves(wf, store, type) || builtinTable(store, [type]);
        const groups = [];
        for (const r of rows) {
            const key = JSON.stringify([r.label || '', r.to, !!r.message, r.prompt || '', r.flow || '']);
            const g = groups.find((x) => x.key === key);
            if (g) { if (!g.when.includes(r.from)) g.when.push(r.from); continue; }
            groups.push({ key, label: String(r.label || '').trim() || `Move to ${r.to}`, to: r.to, message: !!r.message,
                          prompt: r.prompt || '', flow: r.flow || null, when: [r.from] });
        }
        const taken = new Set();
        const list = groups.map((g) => {
            const older = g.flow ? flows.find((x) => x.id === g.flow)?.flow : null;
            const graph = withMove(older, g);
            const id = older && JSON.stringify(older) === JSON.stringify(graph) ? g.flow : flowFor(store, type, g.label, graph, g.to);
            return { id: uniqueId(slug(g.label), taken), label: g.label, when: g.when, flow: id };
        });
        // Then the custom actions, as they were.
        for (const a of wf.actions?.[store]?.[type] || []) {
            list.push({ id: uniqueId(slug(a.id || a.label), taken), label: a.label || '', when: Array.isArray(a.when) ? [...a.when] : ['*'],
                        flow: a.flow || null });
        }
        out.types[store][type] = list;
    }
    // A flow made here is available to the types that use it — all of its
    // store's, when every one does.
    const storeTypes = (store) => types.filter((t) => t.store === store).map((t) => t.type);
    for (const [id, used] of made) {
        const f = flows.find((x) => x.id === id);
        const all = storeTypes(f.store);
        if (used.size && used.size < all.length) f.types = all.filter((t) => used.has(t));
    }
    delete out.bugs;
    delete out.backlog;
    delete out.actions;
    return out;
}

/** Whether a type of `draft` is as withTypeActions made it from `stored`. */
export function isUnchangedType(draft, pristine, { store, type }) {
    const mine = draft.types?.[store]?.[type];
    const theirs = pristine.types?.[store]?.[type];
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) return false;
    const flowOf = (wf, id) => JSON.stringify((wf.flows || []).find((f) => f.id === id) || null);
    return (mine || []).every((a) => !a.flow || flowOf(draft, a.flow) === flowOf(pristine, a.flow));
}

/**
 * `draft` (as withTypeActions shows it) as it is saved: a type that differs is
 * written as its own list, and a type that does not keeps what `stored` had
 * for it — nothing (built-in), its older keys, or its own list. A flow made
 * for the view that nothing saved uses is left out; one the project made,
 * kept, or changed stays.
 */
export function withoutTypeActions(draft, stored, types) {
    const pristine = withTypeActions(stored, types);
    const out = clone(draft);
    const mine = new Set(types.filter((t) => Array.isArray(stored?.types?.[t.store]?.[t.type])
        || !isUnchangedType(draft, pristine, t)).map((t) => `${t.store}.${t.type}`));
    out.types = {};
    for (const { store, type } of types) {
        if (!mine.has(`${store}.${type}`)) continue;
        out.types[store] = out.types[store] || {};
        out.types[store][type] = draft.types?.[store]?.[type] || [];
    }
    if (!Object.keys(out.types).length) delete out.types;

    // The older keys of the types still on them.
    const keep = (store, type) => !mine.has(`${store}.${type}`);
    const s = clone(stored || {});
    liftInlineFlows(s);
    if (s.bugs && types.some((t) => t.store === 'bugs' && keep('bugs', t.type))) out.bugs = s.bugs;
    for (const [t, spec] of Object.entries(s.backlog || {})) {
        if (keep('backlog', t)) (out.backlog = out.backlog || {})[t] = spec;
    }
    for (const [store, byType] of Object.entries(s.actions || {})) {
        for (const [t, list] of Object.entries(byType || {})) {
            if (keep(store, t)) ((out.actions = out.actions || {})[store] = out.actions[store] || {})[t] = list;
        }
    }

    const kept = new Set((stored?.flows || []).map((f) => f.id));
    const same = (f) => JSON.stringify(f) === JSON.stringify((pristine.flows || []).find((x) => x.id === f.id) || null);
    out.flows = (out.flows || []).filter((f) => kept.has(f.id) || !same(f) || flowUses(out, f.id).length);
    if (!out.flows.length) delete out.flows;
    return out;
}

/** An action id for `label`, free among `list`'s. */
export const newActionId = (label, list) => uniqueId(slug(label), new Set((list || []).map((a) => a.id)));

/** A new action for a type: offered everywhere, with no flow yet. */
export function newAction(list, label = 'New action') {
    return { id: newActionId(label, list), label, when: ['*'], flow: null };
}

/** A new flow for a type: just its start; or one that moves to `to`. */
export function newFlow(flows, { label = 'New flow', store = ANY_STORE, types: only = null, to = null } = {}) {
    const f = { id: newFlowId(label, flows), label, store, flow: to ? transitionFlow({ to }) : emptyFlow() };
    if (Array.isArray(only) && only.length) f.types = [...only];
    return f;
}

/** Whether a flow may be picked for an action of `store`/`type`. */
export const flowAvailable = (f, store, type) =>
    !!f && (f.store === ANY_STORE || f.store === store) && (!Array.isArray(f.types) || !f.types.length || f.types.includes(type));
