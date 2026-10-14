/**
 * ticketdesk/workflow_editor.js — what Settings › Workflow (./workflow_page.js)
 * is built from: the record types it lists, and FlexDesk's outline editor
 * (`@flexdesk/flow`) over one flow, mounted in the page.
 *
 * The outline editor only edits: the steps, the checks and the runner are
 * ./workflow.js's. A flow is checked as it is edited, and its problems are
 * drawn on the step in the editor's findings strip with Go to it; the bridge
 * checks again on save and refuses the whole workflow on any problem.
 */

import {
    createOutlineEditor, createStepCatalogue, createWidgetRegistry, TEMPLATE_REFERENCES,
} from '@flexdesk/flow';

import { CONFIG } from './instance.js';
import { STORE_TYPES } from './schema.js';
import { BLOCKS, CATEGORIES, checkFlow, emptyFlow, fieldChoices, stepTypes } from './workflow.js';

export const stepCount = (flow) => (flow?.nodes || []).filter((n) => n.type !== 'start').length;
export const stepsWord = (flow) => { const n = stepCount(flow); return `${n} step${n === 1 ? '' : 's'}`; };

/**
 * The record types this instance has, `{store, type, label, storeLabel}`, in
 * the order the page lists them: the bug types, then the backlog's (a
 * tracker's, with its projects, as Tickets).
 */
export function typesHere() {
    const store = CONFIG.store || {};
    const out = [];
    const tracker = CONFIG.mode === 'tracker';
    if (store.hasBugs !== false && !tracker) {
        for (const [type, label] of STORE_TYPES.bugs) out.push({ store: 'bugs', type, label, storeLabel: 'Bugs' });
    }
    if (store.hasBacklog !== false) {
        const offered = tracker ? ['project', 'epic', 'story', 'task'] : ['epic', 'story', 'task'];
        for (const [type, label] of STORE_TYPES.backlog) {
            if (offered.includes(type)) out.push({ store: 'backlog', type, label, storeLabel: tracker ? 'Tickets' : 'Backlog' });
        }
    }
    return out;
}

/** The stores here, `{store, types, label}` — what a flow can be for. */
export function flowStoresHere() {
    const out = [];
    for (const { store, type, storeLabel } of typesHere()) {
        const have = out.find((x) => x.store === store);
        if (have) have.types.push(type);
        else out.push({ store, types: [type], label: storeLabel });
    }
    return out;
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
        id: 'record', label: 'This record', sub: 'its value when the action runs',
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
