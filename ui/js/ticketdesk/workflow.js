/**
 * ticketdesk/workflow.js — what a move offers and does, and the custom actions.
 *
 * A project may configure, in `.bugdesk/project.json`'s `workflow`
 * (server/RecordWorkflow.cs), the MOVES each status offers — a plain table of
 * from status, label and target, per store (bugs) or per type (backlog) — and
 * what each move does on the side, as a FLOW: a graph of steps edited in
 * FlexDesk's outline editor (`@flexdesk/flow`). STORY-0007's custom actions are
 * flows too, offered beside the moves. With nothing configured, every move is
 * exactly the built-in one.
 *
 * FLOWS ARE NAMED, AND SHARED (STORY-0028). They live in `workflow.flows` —
 * `{id, label, store, flow}` — managed in Settings › Flows, and a move or an
 * action names one by its id. A flow stored INSIDE a move or action (before
 * STORY-0028) still runs; the editors lift it out into a named flow, so the next
 * save stores it the new way.
 *
 * THE EDITOR ONLY EDITS. This module supplies what it edits with — the step
 * catalogue — and runs what it made:
 *
 *   require a message · ask for input (text or a choice) · set a field ·
 *   clear a field · add a comment · move to a status (actions only) ·
 *   If … otherwise on a condition over the record's fields
 *
 * No loops and no parallel blocks: a move is one decision, made in one save.
 *
 * ALL OR NOTHING. A flow runs in the page, where its prompts are, and only
 * COLLECTS what it would change. The move is then one write — the status, the
 * fields and the comment together — so a cancelled prompt or a step that cannot
 * run leaves the record exactly as it was. Nothing is written half-way.
 *
 * Values from earlier prompts reach later steps through the editor's template
 * references: `${input.<step id>}`, and `${record.<field>}` for the record.
 */

import { CONFIG, apiUrl } from './instance.js';
import { STORE_TYPES, customFields, customStatuses, isFinished, withCustomStatuses } from './schema.js';

/* ── the configuration ──────────────────────────────────────────────── */

let W = (CONFIG.workflow && typeof CONFIG.workflow === 'object') ? CONFIG.workflow : {};

/** The whole stored workflow, as a deep copy for an editor. */
export const workflowConfig = () => JSON.parse(JSON.stringify(W || {}));

/** Replace the live copy — after a save, or in a test. */
export function setWorkflow(next) {
    W = next && typeof next === 'object' ? next : {};
    if (CONFIG && typeof CONFIG === 'object') CONFIG.workflow = W;
}

/** The configured move table of a store (bugs) or a backlog type, or null. */
export function configuredMoves(store, type) {
    const t = store === 'bugs' ? W.bugs : W.backlog?.[type];
    return Array.isArray(t?.moves) ? t.moves : null;
}

/** The project's named flows, of one store or of all (STORY-0028). */
export const configuredFlows = (store = null, flows = W.flows) =>
    (Array.isArray(flows) ? flows : []).filter((f) => f && (!store || f.store === store || f.store === ANY_STORE));

/**
 * A flow FOR ANY RECORD — a bug or a backlog item. Which records a flow is for
 * is a setting of the flow, not a kind of flow: "any" offers only what both
 * stores have (assignee, labels, title, a question, a comment …), and is
 * offered to every move and action; one for a store may use that store's own
 * fields too. Either way it is checked again against each row that uses it.
 */
export const ANY_STORE = 'any';
const ALL_TYPES = { bugs: STORE_TYPES.bugs.map(([t]) => t), backlog: STORE_TYPES.backlog.map(([t]) => t) };

/**
 * A move's or an action's `flow` as a graph: the named flow its id names, or —
 * stored before flows had names — the graph itself. `null` when there is none,
 * or the name is not (or no longer) a flow.
 */
export function flowGraph(ref, flows = W.flows) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref;
    return configuredFlows(null, flows).find((f) => f.id === ref)?.flow || null;
}

/** An id for a new flow named `label`, unique among `flows`. */
export function newFlowId(label, flows = []) {
    const base = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'flow';
    const taken = new Set(configuredFlows(null, flows).map((f) => f.id));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
}

/**
 * Every place in a workflow that has a flow: the move tables' rows and the
 * actions, as `{ref, store, types, actions, owner, where, holder}` — `holder` is
 * the row itself, so a caller can rewrite its `flow`.
 */
export function flowSlots(wf) {
    const out = [];
    const typeLabel = (store, t) => (store === 'bugs' ? { bug: 'Bug', regression: 'Regression', task: 'Chore' } : {})[t]
        || t.charAt(0).toUpperCase() + t.slice(1);
    for (const [i, m] of (wf?.bugs?.moves || []).entries()) {
        out.push({ holder: m, store: 'bugs', types: ['bug', 'regression', 'task'], actions: false,
            owner: `Bugs › ${m.label || 'move'}`, where: `workflow.bugs.moves[${i}]` });
    }
    for (const [t, spec] of Object.entries(wf?.backlog || {})) {
        for (const [i, m] of (spec?.moves || []).entries()) {
            out.push({ holder: m, store: 'backlog', types: [t], actions: false,
                owner: `${typeLabel('backlog', t)} › ${m.label || 'move'}`, where: `workflow.backlog.${t}.moves[${i}]` });
        }
    }
    for (const [store, byType] of Object.entries(wf?.actions || {})) {
        for (const [t, list] of Object.entries(byType || {})) {
            for (const [i, a] of (list || []).entries()) {
                out.push({ holder: a, store, types: [t], actions: true,
                    owner: `${typeLabel(store, t)} › ${a.label || 'action'} (action)`, where: `workflow.actions.${store}.${t}[${i}]` });
            }
        }
    }
    return out.map((x) => ({ ...x, ref: x.holder.flow || null }));
}

/** What uses the named flow `id`: the slots that name it. */
export const flowUses = (wf, id) => flowSlots(wf).filter((x) => x.ref === id);

/**
 * Lift every flow stored inside a move or action out into a named flow, in
 * place — an editor's draft, so a cancel changes nothing. Named after the row.
 * Returns how many were lifted.
 */
export function liftInlineFlows(wf) {
    let n = 0;
    for (const slot of flowSlots(wf)) {
        if (!slot.ref || typeof slot.ref !== 'object') continue;
        wf.flows = Array.isArray(wf.flows) ? wf.flows : [];
        // The same steps on several rows — one action on three bug types, say —
        // are ONE flow they share, not three copies to keep in step.
        const same = JSON.stringify(slot.ref);
        const twin = wf.flows.find((f) => f.store === slot.store && JSON.stringify(f.flow) === same);
        if (twin) { slot.holder.flow = twin.id; n++; continue; }
        const label = String(slot.holder.label || '').trim() || 'Flow';
        const id = newFlowId(label, wf.flows);
        wf.flows.push({ id, label, store: slot.store, flow: slot.ref });
        slot.holder.flow = id;
        n++;
    }
    return n;
}

/** A move's flow that asks for its message — what "needs a message" did. */
export const askFlow = (prompt = '') => ({
    nodes: [{ id: 'start', type: 'start', label: 'Start', config: {}, position: { x: 0, y: 0 } },
            { id: 'message', type: 'require-message', label: 'Ask for the message', config: prompt ? { prompt } : {}, position: { x: 0, y: 0 } }],
    connections: [{ source: 'start', sourcePort: 'out', target: 'message', targetPort: 'in' }],
});

/** The move table a `{store, type}` holds in a workflow, or null. */
const movesOf = (wf, store, type) => (store === 'bugs' ? wf?.bugs?.moves : wf?.backlog?.[type]?.moves);

/** How many of these tables' moves have no flow: every built-in one, and the
 *  configured rows without a flow. */
export function movesWithoutFlow(wf, tables) {
    return tables.reduce((n, { store, type, builtin }) => {
        const moves = movesOf(wf, store, type);
        return n + (Array.isArray(moves) ? moves.filter((m) => !m.flow).length : builtin.length);
    }, 0);
}

/**
 * Give every move a flow, in place (an editor's draft): a table that moves the
 * built-in way is written down first, from `builtin`; then each move without a
 * flow gets one named after it that does what the move did — asks for its
 * message, with the move's own question, or nothing yet. The asking moves INTO
 * the flow, so it is asked once, there. The same steps under the same name are
 * one flow every such move shares; they name no field, so they are for any
 * record. Returns how many moves got a flow.
 *
 * @param {object} wf
 * @param {Array<{store: string, type?: string, builtin: Array}>} tables
 */
export function seedMoveFlows(wf, tables) {
    let n = 0;
    wf.flows = Array.isArray(wf.flows) ? wf.flows : [];
    for (const { store, type, builtin, label: where = '' } of tables) {
        let moves = movesOf(wf, store, type);
        if (!Array.isArray(moves)) {
            moves = builtin.map((m) => ({ ...m }));
            if (store === 'bugs') wf.bugs = { ...(wf.bugs || {}), moves };
            else { wf.backlog = wf.backlog || {}; wf.backlog[type] = { ...(wf.backlog[type] || {}), moves }; }
        }
        for (const m of moves) {
            const { prompt = '' } = m;
            delete m.prompt;
            if (m.flow) continue;
            const graph = m.message ? askFlow(prompt) : emptyFlow();
            const label = String(m.label || '').trim() || 'Move';
            const same = JSON.stringify(graph);
            const twin = wf.flows.find((f) => (f.label || '') === label && JSON.stringify(f.flow) === same
                && (f.store === ANY_STORE || f.store === store));
            // Two that share a name but not their steps (a bug's Reopen asks
            // why, an item's does not) are told apart by where they are from.
            const named = !twin && wf.flows.some((f) => (f.label || '') === label)
                ? `${label} — ${String(where).split(' › ')[0] || store}` : label;
            const twin2 = twin || wf.flows.find((f) => (f.label || '') === named && JSON.stringify(f.flow) === same);
            const id = twin2 ? twin2.id : newFlowId(named, wf.flows);
            if (!twin2) wf.flows.push({ id, label: named, store: ANY_STORE, flow: graph });
            m.flow = id;
            m.message = false;
            n++;
        }
    }
    return n;
}

/** The custom actions of a store and type (STORY-0007). */
export const configuredActions = (store, type) => {
    const list = W.actions?.[store]?.[type];
    return Array.isArray(list) ? list : [];
};

/* ── the built-in moves, as data ──────────────────────────────────────
 * What a store moves like with no table configured. The editor starts a table
 * from these, so "change one label" does not mean retyping the other eleven. */

const BUG_BUILTIN = [
    { from: 'open', label: 'Start investigation', to: 'investigation', message: false },
    { from: 'open', label: 'Close', to: 'closed', message: true },
    { from: 'investigation', label: 'Hand to testing', to: 'testing', message: true },
    { from: 'investigation', label: 'Close', to: 'closed', message: true },
    { from: 'investigation', label: 'Back to open', to: 'open', message: true },
    { from: 'testing', label: 'Back to investigation', to: 'investigation', message: true },
    { from: 'testing', label: 'Close', to: 'closed', message: true },
    { from: 'testing', label: 'Back to open', to: 'open', message: true },
    { from: 'closed', label: 'Reopen', to: 'open', message: true },
];

const ITEM_LADDERS = {
    project: ['draft', 'in-progress', 'done'],
    epic: ['draft', 'refined', 'in-progress', 'done'],
    story: ['draft', 'refined', 'in-progress', 'review', 'done'],
    task: ['draft', 'in-progress', 'done'],
};
const ADVANCE = { refined: 'Mark refined', 'in-progress': 'Start work', review: 'Send to review', done: 'Mark done' };
const BACK = { draft: 'Back to draft', refined: 'Back to refined', 'in-progress': 'Back to in progress', review: 'Back to review' };

/** The built-in move table of a store or type — what the editor starts from. */
export function builtinMoves(store, type) {
    if (store === 'bugs') return BUG_BUILTIN.map((m) => ({ ...m }));
    const ladder = ITEM_LADDERS[type] || ITEM_LADDERS.story;
    const out = [];
    ladder.forEach((s, i) => {
        if (i + 1 < ladder.length) out.push({ from: s, label: ADVANCE[ladder[i + 1]] || `Move to ${ladder[i + 1]}`, to: ladder[i + 1], message: false });
        if (i > 0) out.push({ from: s, label: i === ladder.length - 1 ? 'Reopen' : (BACK[ladder[i - 1]] || `Back to ${ladder[i - 1]}`), to: ladder[i - 1], message: false });
        if (s !== 'done') out.push({ from: s, label: 'Drop', to: 'dropped', message: false });
    });
    out.push({ from: 'dropped', label: 'Restore to draft', to: 'draft', message: false });
    return out;
}

/** Every status a record of this store and type may hold, in order. */
export function statusesOf(store, type) {
    if (store === 'bugs') {
        const types = type ? [type] : ['bug', 'regression', 'task'];
        const seen = new Set(['open', 'investigation', 'testing', 'closed']);
        const out = withCustomStatuses('bugs', types[0], ['open', 'investigation', 'testing', 'closed']);
        for (const t of types) for (const s of customStatuses('bugs', t)) if (!seen.has(s.name) && !out.includes(s.name)) out.push(s.name);
        return out;
    }
    return withCustomStatuses('backlog', type, [...(ITEM_LADDERS[type] || ITEM_LADDERS.story), 'dropped']);
}

/**
 * The moves on offer for one record, as `{label, to, message, flow, configured}`.
 * `builtin` is the store's own list (`[label, target]` pairs), used when the
 * project configured nothing — so an unconfigured project moves exactly as
 * before, custom statuses included.
 */
export function movesFor(store, type, status, builtin = []) {
    const table = configuredMoves(store, type);
    if (!table) {
        return builtin.map(([label, to]) => ({
            label, to, configured: false,
            // A bug's built-in rule: every move but starting work takes a message.
            message: store === 'bugs' ? !(status === 'open' && to === 'investigation') : false,
            flow: null,
        }));
    }
    return table
        .filter((m) => m.from === status || (m.from === '*' && m.to !== status))
        .map((m) => ({ label: m.label, to: m.to, message: !!m.message, flow: m.flow || null, configured: true }));
}

/** The custom actions offered in a status (STORY-0007). */
export const actionsFor = (store, type, status) => configuredActions(store, type)
    .filter((a) => !Array.isArray(a.when) || !a.when.length || a.when.includes('*') || a.when.includes(status));

/* ── the step catalogue ────────────────────────────────────────────── */

const F = (name, direction, extra = {}) => ({ name, direction, port_type: 'FLOW', label: name, ...extra });
const IN = F('in', 'input', { multiple: true });
const OUT = F('out', 'output');

/** Built-in fields a step may set or clear (mirrors RecordWorkflow.SettableBuiltins). */
export const SETTABLE = {
    bugs: [['assignee', 'Assignee'], ['severity', 'Severity'], ['subsystem', 'Subsystem'], ['labels', 'Labels'], ['title', 'Title']],
    backlog: [['assignee', 'Assignee'], ['phase', 'Phase'], ['due', 'Target date'], ['points', 'Estimate'],
              ['subsystem', 'Subsystem'], ['labels', 'Labels'], ['title', 'Title']],
};
const READABLE = [['status', 'Status'], ['type', 'Type'], ['reporter', 'Reporter']];

/** The fields of a store's types, `[name, label]`, built-ins first. A flow
 *  for any record gets the fields both stores have. */
export function fieldChoices(store, types, { readable = false } = {}) {
    if (store === ANY_STORE) {
        const backlog = new Set(fieldChoices('backlog', ALL_TYPES.backlog, { readable }).map(([n]) => n));
        return fieldChoices('bugs', ALL_TYPES.bugs, { readable }).filter(([n]) => backlog.has(n));
    }
    const out = [...SETTABLE[store]];
    if (readable) for (const r of READABLE) if (!out.some(([n]) => n === r[0])) out.push(r);
    for (const t of types) {
        for (const f of customFields(store, t)) if (!out.some(([n]) => n === f.name)) out.push([f.name, f.label || f.name]);
    }
    return out;
}

/** Every status the records may hold — for any record, the ones both stores have. */
function statusesFor(store, types) {
    if (store === ANY_STORE) {
        const backlog = new Set(statusesFor('backlog', ALL_TYPES.backlog));
        return statusesFor('bugs', ALL_TYPES.bugs).filter((x) => backlog.has(x));
    }
    return [...new Set(types.flatMap((t) => statusesOf(store, t)))];
}

const enumOf = (pairs, title, extra = {}) => ({
    type: 'string', title, enum: pairs.map(([v]) => v),
    'x-ui-enum-labels': Object.fromEntries(pairs.map(([v, l]) => [v, l])), ...extra,
});

export const CATEGORIES = [
    { id: 'control', label: 'Flow', tone: 'violet' },
    { id: 'ask', label: 'Ask', tone: 'amber' },
    { id: 'record', label: 'Record', tone: 'teal' },
];

/**
 * The step types for a flow over one store and its types. `actions: true` adds
 * "Move to a status", which a move does not need — the move IS the status change.
 */
export function stepTypes(store, types, { actions = false } = {}) {
    const fields = fieldChoices(store, types);
    const readable = fieldChoices(store, types, { readable: true });
    const statuses = statusesFor(store, types);
    return [
        { type_id: 'start', label: 'Start', category: 'control', role: 'start', icon: 'play_arrow', ports: [OUT] },
        { type_id: 'end', label: 'End', category: 'control', role: 'end', icon: 'flag', ports: [IN],
          description: 'Stops here; everything collected so far is saved.',
          config_schema: { type: 'object', properties: {} } },
        { type_id: 'condition', label: 'If … otherwise', category: 'control', role: 'branch', icon: 'call_split',
          description: 'Runs the steps under Then when the record matches, the steps under Otherwise when it does not.',
          ports: [IN, F('true', 'output', { label: 'Then' }), F('false', 'output', { label: 'Otherwise' })],
          config_schema: { type: 'object', required: ['field', 'op'], properties: {
              field: enumOf(readable, 'Field'),
              op: enumOf([['is', 'is'], ['is_not', 'is not'], ['contains', 'contains'],
                          ['is_empty', 'is empty'], ['is_not_empty', 'is not empty']], 'Test', { default: 'is' }),
              value: { type: 'string', title: 'Value', 'x-ui-widget': 'template',
                       'x-ui-when': { field: 'op', in: ['is', 'is_not', 'contains'] } } } } },
        { type_id: 'require-message', label: 'Require a message', category: 'ask', icon: 'chat',
          description: 'Asks for the message the move is saved with. A comment you wrote in the last five minutes counts.',
          ports: [IN, OUT],
          config_schema: { type: 'object', properties: {
              prompt: { type: 'string', title: 'Question', 'x-ui-placeholder': 'Why is it moving?' } } } },
        { type_id: 'prompt', label: 'Ask for input', category: 'ask', icon: 'help',
          description: 'Asks a question. Later steps use the answer as ${input.<this step>}.',
          ports: [IN, OUT],
          config_schema: { type: 'object', required: ['question'], properties: {
              question: { type: 'string', minLength: 1, title: 'Question' },
              kind: enumOf([['text', 'Text'], ['choice', 'A choice']], 'Answer', { default: 'text' }),
              choices: { type: 'array', title: 'Choices', 'x-ui-widget': 'string-list', items: { type: 'string' },
                         'x-ui-when': { field: 'kind', in: ['choice'] } },
              required: { type: 'boolean', title: 'An answer is required', default: true } } } },
        { type_id: 'set-field', label: 'Set a field', category: 'record', icon: 'edit',
          ports: [IN, OUT],
          config_schema: { type: 'object', required: ['field'], properties: {
              field: enumOf(fields, 'Field'),
              value: { type: 'string', title: 'Value', 'x-ui-widget': 'template',
                       'x-ui-placeholder': 'A value, or insert one' } } } },
        { type_id: 'clear-field', label: 'Clear a field', category: 'record', icon: 'backspace',
          ports: [IN, OUT],
          config_schema: { type: 'object', required: ['field'], properties: { field: enumOf(fields, 'Field') } } },
        { type_id: 'add-comment', label: 'Add a comment', category: 'record', icon: 'add_comment',
          ports: [IN, OUT],
          config_schema: { type: 'object', required: ['body'], properties: {
              body: { type: 'string', minLength: 1, title: 'Comment', 'x-ui-widget': 'template', 'x-ui-multiline': true },
              tag: { type: 'string', title: 'Tag', 'x-ui-placeholder': 'e.g. blocked — shown on the comment' } } } },
        ...(actions ? [{ type_id: 'set-status', label: 'Move to a status', category: 'record', icon: 'swap_horiz',
          ports: [IN, OUT],
          config_schema: { type: 'object', required: ['status'], properties: { status: enumOf(statuses.map((s) => [s, s]), 'Status') } } }] : []),
    ];
}

/** The block mapping the outline editor draws with: an If and an End, no loops. */
export const BLOCKS = {
    start: { role: 'start', label: 'When the move is made' },
    end: { role: 'end', entry: { label: 'Stop here', sub: 'End', description: 'Save what was collected, and do nothing more.' } },
    step: { input: 'in', continue: 'out' },
    branch: { role: 'branch', arms: { true: 'Then', false: 'Otherwise' }, unconnected: 'stop',
              entry: { label: 'If … otherwise', sub: 'Condition', description: 'Check a field of the record.' },
              note: 'Either arm may be empty; the flow carries on after the block.' },
    arms: {},
};

/** A new flow: just its start. */
export const emptyFlow = () => ({ nodes: [{ id: 'start', type: 'start', label: 'Start', config: {}, position: { x: 0, y: 0 } }], connections: [] });

/* ── checking a flow ───────────────────────────────────────────────── */

const REF = /\$\{\s*([^}]+?)\s*\}/g;

/**
 * Problems in a flow, as the outline editor's findings: `{code, message,
 * severity, node_id, field?}`. The bridge checks the same things on save; this
 * is what lets the editor point at the step before anything is sent.
 */
export function checkFlow(graph, store, types, { actions = false } = {}) {
    const out = [];
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const known = new Set(stepTypes(store, types, { actions }).map((t) => t.type_id));
    const settable = new Set(fieldChoices(store, types).map(([n]) => n));
    const readable = new Set(fieldChoices(store, types, { readable: true }).map(([n]) => n));
    const statuses = new Set(statusesFor(store, types));
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
        const c = n.config || {};
        const err = (code, message, field) => out.push({ code, message, severity: 'error', node_id: n.id, ...(field ? { field } : {}) });
        if (!known.has(n.type)) { err('unknown_step', `“${n.label || n.id}” is a ${n.type} step, which BugDesk cannot run here.`); continue; }
        if ((n.type === 'set-field' || n.type === 'clear-field') && !settable.has(c.field)) {
            err('unknown_field', c.field ? `“${c.field}” is not a field a flow can set on these records.` : 'Choose the field.', 'field');
        }
        if (n.type === 'condition' && !readable.has(c.field)) {
            err('unknown_field', c.field ? `“${c.field}” is not a field of these records.` : 'Choose the field to check.', 'field');
        }
        if (n.type === 'set-status' && !statuses.has(c.status)) {
            err('unknown_status', c.status ? `“${c.status}” is not a status of these records.` : 'Choose the status.', 'status');
        }
        if (n.type === 'prompt' && c.kind === 'choice' && !(Array.isArray(c.choices) && c.choices.length)) {
            err('no_choices', 'A choice needs something to choose from.', 'choices');
        }
        // A reference to a step that is not in the flow, or to a field the records lack.
        for (const [key, val] of Object.entries(c)) {
            if (typeof val !== 'string') continue;
            for (const m of val.matchAll(REF)) {
                const [scope, name] = m[1].split('.');
                if (scope === 'input' && !ids.has(name)) err('unknown_reference', `\${${m[1]}} names a step that is not in this flow.`, key);
                if (scope === 'record' && !readable.has(name) && name !== 'id') err('unknown_reference', `\${${m[1]}} names a field these records do not have.`, key);
            }
        }
    }
    return out;
}

/* ── running a flow ────────────────────────────────────────────────── */

/** A record's value for a field, built-in or custom, as text. */
function valueOf(record, name) {
    if (!record) return '';
    if (Object.prototype.hasOwnProperty.call(record.fields || {}, name)) return String(record.fields[name] ?? '');
    const v = record[name];
    return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}

/** `${input.x}` and `${record.y}` in a text, filled from what was collected. */
export function renderTemplate(text, { record, inputs }) {
    return String(text ?? '').replace(REF, (_, path) => {
        const [scope, ...rest] = String(path).split('.');
        const name = rest.join('.');
        if (scope === 'input') return String(inputs?.[name] ?? '');
        if (scope === 'record') return valueOf(record, name);
        return '';
    });
}

function test(record, { field, op, value }, ctx) {
    const have = valueOf(record, field).trim();
    const want = renderTemplate(value, ctx).trim();
    switch (op) {
        case 'is_empty': return have === '';
        case 'is_not_empty': return have !== '';
        case 'is_not': return have.toLowerCase() !== want.toLowerCase();
        case 'contains': return have.toLowerCase().includes(want.toLowerCase());
        default: return have.toLowerCase() === want.toLowerCase();
    }
}

/**
 * Run one flow over a record. Resolves what it would change —
 * `{ status, set: {field: value}, fields: {name: value}, comments: [text],
 *    tag, message }` — or `null` when a prompt was cancelled. Writes nothing.
 *
 * @param {object} graph   the outline graph
 * @param {object} o
 * @param {'bugs'|'backlog'} o.store
 * @param {object} o.record   the record as the bridge sends it (`fields` included)
 * @param {Function} o.ask    `(form) => Promise<object|null>` — openForm's shape
 * @param {Function} [o.message]  `(prompt) => Promise<string|null>` for "Require a message"
 */
export async function runFlow(graph, { store, record, ask, message }) {
    const nodes = new Map((graph?.nodes || []).map((n) => [n.id, n]));
    const next = (id, port = 'out') => (graph?.connections || [])
        .find((c) => c.source === id && (c.sourcePort || 'out') === port)?.target;
    const out = { status: null, set: {}, fields: {}, comments: [], tag: '', message: null };
    const inputs = {};
    const custom = (name) => !SETTABLE[store].some(([n]) => n === name);
    // The record as the flow has changed it so far, so a later condition sees an
    // earlier step's work.
    const view = () => ({ ...record, ...out.set, fields: { ...(record?.fields || {}), ...out.fields },
                          status: out.status || record?.status });
    let at = [...nodes.values()].find((n) => n.type === 'start')?.id;
    const seen = new Set();
    while (at && nodes.has(at)) {
        if (seen.has(at)) throw new Error('This flow loops back on itself, which a move cannot run.');
        seen.add(at);
        const n = nodes.get(at);
        const c = n.config || {};
        const ctx = { record: view(), inputs };
        let port = 'out';
        switch (n.type) {
            case 'end': return out;
            case 'condition': port = test(view(), c, ctx) ? 'true' : 'false'; break;
            case 'require-message': {
                // The move already asked (its table row says it needs a message):
                // one message per move, not two.
                if (!message) break;
                const text = await message(c.prompt || '');
                if (text == null) return null;
                out.message = text;
                break;
            }
            case 'prompt': {
                const choice = c.kind === 'choice';
                const result = await ask({
                    title: n.label || c.question,
                    fields: [{
                        name: 'answer', label: c.question || 'Answer',
                        type: choice ? 'select' : 'textarea', rows: 4,
                        options: choice ? (c.choices || []) : undefined,
                        required: c.required !== false,
                    }],
                    submitLabel: 'Continue',
                });
                if (!result) return null;
                inputs[n.id] = String(result.answer ?? '').trim();
                break;
            }
            case 'set-field': {
                const value = renderTemplate(c.value, ctx);
                if (custom(c.field)) out.fields[c.field] = value; else out.set[c.field] = value;
                break;
            }
            case 'clear-field':
                if (custom(c.field)) out.fields[c.field] = ''; else out.set[c.field] = '';
                break;
            case 'add-comment': {
                const body = renderTemplate(c.body, ctx).trim();
                if (body) out.comments.push(body);
                if (c.tag) out.tag = String(c.tag).trim();
                break;
            }
            case 'set-status': out.status = c.status; break;
            default: break;
        }
        at = next(at, port);
    }
    return out;
}

/**
 * The patch a move (or an action) saves: the status, what its flow collected
 * and its message, as ONE write. `null` when anything was cancelled.
 *
 * @param {object} o
 * @param {'bugs'|'backlog'} o.store
 * @param {object} o.record     the full record (fetched fresh by the caller)
 * @param {object} o.move       `{to?, message, flow}` — an action has no `to`;
 *                              `flow` is a named flow's id, or a graph
 * @param {Function} o.ask      openForm
 * @param {Function} o.askMessage  `(prompt) => Promise<{comment}|{tagRecentComment}|null>`
 */
export async function planMove({ store, record, move, ask, askMessage }) {
    let msg = null;              // {comment} | {tagRecentComment: true}
    const message = async (prompt) => {
        const r = await askMessage(prompt);
        if (!r) return null;
        msg = r;
        return r.comment || '';
    };
    if (move.message) {
        if ((await message('')) == null) return null;
    }
    // A named flow (STORY-0028), or one stored inside the move the old way.
    const graph = flowGraph(move.flow);
    const run = graph ? await runFlow(graph, { store, record, ask, message: msg ? null : message }) : null;
    if (graph && !run) return null;
    const patch = {};
    const status = run?.status || move.to;
    if (status && status !== record.status) patch.status = status;
    for (const [k, v] of Object.entries(run?.set || {})) {
        patch[k] = k === 'labels' ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : v;
    }
    if (run && Object.keys(run.fields).length) patch.fields = run.fields;
    const parts = [msg?.comment, ...(run?.comments || [])].filter((s) => String(s || '').trim());
    if (parts.length) patch.comment = parts.join('\n\n');
    else if (msg?.tagRecentComment) patch.tagRecentComment = true;
    if (run?.tag) patch.commentNote = run.tag;
    return patch;
}

/** Is this record finished with — so a move's "from: *" never offers itself on it? */
export const finished = (store, type, status) => isFinished(store, type, status);

/* ── saving ───────────────────────────────────────────────────────── */

/** Save the whole workflow. Rejects with `err.problems` (`{where, message, node_id}`). */
export async function saveWorkflow(next) {
    const res = await fetch(apiUrl('/project/workflow'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ workflow: next }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
        const err = new Error(j?.error || `saving the workflow failed (${res.status})`);
        err.problems = j?.problems || [];
        throw err;
    }
    setWorkflow(j.workflow);
    return j.workflow;
}

/* ── mass actions (STORY-0029) ─────────────────────────────────────── */

/** What every type offers on a multi-row selection when nothing is configured. */
export const DEFAULT_MASS_ACTIONS = ['assignee', 'status'];

/**
 * The mass actions a store's type offers: `workflow.massActions.<store>.<type>`,
 * a list of `"assignee"`, `"status"` and `"action:<custom action id>"`, else
 * the defaults. See ./mass_actions.js.
 */
export function massActionsOf(store, type) {
    const list = W.massActions?.[store]?.[type];
    return Array.isArray(list) ? list.map(String) : [...DEFAULT_MASS_ACTIONS];
}
