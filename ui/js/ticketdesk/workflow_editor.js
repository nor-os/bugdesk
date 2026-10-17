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
    createOutlineEditor, createReferenceSyntax, createStepCatalogue, createWidgetRegistry, TEMPLATE_REFERENCES,
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
        items: [...fieldChoices(store, types, { readable: true }), ['id', 'Id'], ['ref', 'Reference']]
            .map(([n, l]) => ({ label: l, type: 'field', ref: `\${record.${n}}` })),
    };
    let editor = null;
    const stepsById = () => new Map((editor?.getGraph()?.nodes || []).map((n) => [n.id, n]));
    const values = async ({ before }) => {
        const byId = stepsById();
        const asked = (before || []).map((b) => (typeof b === 'string' ? byId.get(b) : b))
            .filter((n) => n && ASKS.has(n.type));
        return [
            { id: 'input', label: 'Answers', sub: 'from the questions asked before this step',
              empty: 'No question is asked before this step.',
              // A record question answers with a reference, and the record's title beside it.
              items: asked.flatMap((n) => [{ label: answerName(n), type: 'answer', ref: `\${input.${n.id}}` },
                  ...(n.type === 'prompt' && n.config?.kind === 'record'
                      ? [{ label: `${answerName(n)} — its title`, type: 'answer', ref: `\${input.${n.id}.title}` }] : [])]) },
            fieldGroup,
        ];
    };

    // A reference reads as what it stands for — "Answer: Why?", "Severity" —
    // not as the step id it is stored by, which the editor never shows.
    const fieldLabels = new Map([...fieldChoices(store, types, { readable: true }), ['id', 'Id'], ['ref', 'Reference']]);
    const references = createReferenceSyntax({
        name: TEMPLATE_REFERENCES.name, pattern: TEMPLATE_REFERENCES.pattern, format: TEMPLATE_REFERENCES.format,
        stepScope: 'input',
        describe: (match) => {
            const [scope, name, part] = String(match.path || '').split('.');
            if (scope === 'input') {
                const n = stepsById().get(name);
                // Before the editor has its graph, every step is still unknown.
                if (!editor) return { label: 'Answer', tone: 'amber' };
                if (part === 'title' && n) return { label: `Title: ${answerName(n)}`, tone: 'amber' };
                return n && ASKS.has(n.type) ? { label: `Answer: ${answerName(n)}`, tone: 'amber' }
                    : { label: `Answer: ${name}`, tone: 'amber', known: false };
            }
            if (scope === 'record') {
                return fieldLabels.has(name) ? { label: fieldLabels.get(name) } : { label: name, known: false };
            }
            return null;
        },
    });

    const check = () => {
        if (!editor) return [];
        const findings = [...checkFlow(editor.getGraph(), store, types, { actions }),
            ...serverFindings.map((p) => ({ code: 'bridge', message: p.message, severity: 'error', node_id: p.node_id }))];
        editor.setFindings(findings);
        return findings;
    };

    editor = createOutlineEditor(host, {
        catalogue, widgets: createWidgetRegistry(), references: { template: references },
        blocks: BLOCKS, values,
        valuesNote: 'Only questions asked before this step, on every path, are listed.',
        // The outline's one line reads its references as the chips do.
        summarise: (node) => summariseStep(node).replace(references.pattern, (text, path) => {
            const d = references.describe({ text, path });
            return d ? `‹${d.label}›` : text;
        }),
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

/** The steps whose answer later steps may use: a question, and the move's comment. */
const ASKS = new Set(['prompt', 'require-message']);

/** What an answer is called in the { } list and on its chip. */
function answerName(n) {
    const c = n.config || {};
    if (n.type === 'require-message') return c.prompt || 'the comment';
    return c.question || n.label || n.id;
}

/** A step's one line in the outline. */
function summariseStep(node) {
    const c = node.config || {};
    switch (node.type) {
        case 'condition': return `${c.field || '?'} ${String(c.op || 'is').replace(/_/g, ' ')}${c.value ? ` ${c.value}` : ''}`;
        case 'require-message': return `${c.prompt || 'Ask for a comment'} — saved as the move's comment`;
        case 'prompt': return c.question || 'Ask a question';
        case 'set-field': return `${c.field || '?'} = ${c.value || '(empty)'}`;
        case 'clear-field': return `clear ${c.field || '?'}`;
        case 'add-comment': return String(c.body || '').split('\n')[0] || 'Add a comment';
        case 'set-status': return `→ ${c.status || '?'}`;
        case 'add-link': return `${c.verb || '?'} ${c.target || '?'}${c.note ? ' — and a comment there' : ''}`;
        default: return '';
    }
}
