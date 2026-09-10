/**
 * ticketdesk/new_item.js — "New item", the one place anything gets filed.
 *
 * BugDesk has two stores, and until this existed the top bar had a button per
 * store: "New Bug" and "New Item". That asks the user to decide which STORE
 * something belongs in before they have said what it is — which is backwards,
 * because the answer is a property of the thing. So there is one dialog, and
 * one Type select spanning both:
 *
 *     Bug · Regression · Chore   →  bugs/BUG-NNNN.md
 *     Epic · Story · Task        →  backlog/{EPIC,STORY,TASK}-NNNN.md
 *
 * Picking the type picks the store.
 *
 * The form FOLLOWS the Type select. A bug is asked for a severity; a story for
 * a parent and an estimate; an epic for the phase its descendants inherit. The
 * fields are all built once and the irrelevant rows hidden, because rebuilding
 * the form on every change would discard whatever had already been typed.
 *
 * The select itself is scoped by the caller: opened from the backlog's "Epic"
 * button it offers Epic/Story/Task and never mentions bugs, since that item is
 * not going to be one. Only the top bar's untyped entry point offers all six.
 *
 * The full-page bug mask still exists and is still richer (markdown editor,
 * link staging) — the Bugs page's own "New Bug" button opens that. This dialog
 * is the quick cross-store affordance, reachable from anywhere.
 */

import { openForm } from '../ecoagent/ui/modal.js';
import { statusLine } from './pages.js';
import { AGENT_AUTHOR, HUMAN_AUTHOR, createBug, loadData } from './data.js';
import { PHASES, createItem, itemRef, loadBacklog, parentOptions } from './backlog_data.js';

/**
 * The Type select. `store` routes the create; `value` is what that store's
 * `type` field ends up holding.
 *
 * "Chore" is a bug whose stored type is `task` — see the note in ./data.js on
 * why the display name differs. It sits in the bug group because that is where
 * the record lives, and putting it next to the backlog's Task is exactly the
 * confusion the rename removed.
 */
export const KINDS = [
    { id: 'bug', label: 'Bug', store: 'bugs', value: 'bug' },
    { id: 'regression', label: 'Regression', store: 'bugs', value: 'regression' },
    { id: 'chore', label: 'Chore', store: 'bugs', value: 'task' },
    { id: 'epic', label: 'Epic', store: 'backlog', value: 'epic' },
    { id: 'story', label: 'Story', store: 'backlog', value: 'story' },
    { id: 'task', label: 'Task', store: 'backlog', value: 'task' },
];
const kindById = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

/** The combobox hands back whatever was typed — "EPIC-0004 — Auth" and "4" must
 *  both resolve to 4. */
function parentId(raw) {
    const s = String(raw || '').trim();
    if (!s) return 0;
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
}

const clean = (v) => String(v ?? '').trim();
const toList = (v) => clean(v) ? clean(v).split(',').map((s) => s.trim()).filter(Boolean) : [];

/**
 * Open the dialog and create whatever it returns.
 *
 * @param {object}  o
 * @param {string}  [o.kind]    preselect a type by its id ('bug', 'story', …).
 *                              When given, the dialog is titled for it ("New
 *                              story"); when omitted it is the generic "New
 *                              item" — the top bar's entry point, where the
 *                              user has not said what they are filing yet.
 * @param {number}  [o.parent]  preselect a backlog parent (the tree's
 *                              "Add child…").
 * @param {string}  [o.phase]   preselect an epic's phase.
 * @returns {Promise<{store: 'bugs'|'backlog', record: object}|null>} null if
 *          cancelled or the create failed (the failure is reported on the
 *          status line, not thrown at the caller).
 */
/**
 * Which fields each kind actually has. The form is built once with the union
 * and rows are shown or hidden from here as the Type select changes — a form
 * rebuilt on every change would throw away whatever the user had already typed.
 */
export const FIELDS_FOR = {
    bug:        { severity: true },
    regression: { severity: true },
    chore:      { severity: true },
    // An epic carries the milestone label its descendants inherit, and has no
    // parent of its own.
    epic:       { phase: true, points: true },
    story:      { parent: true, points: true },
    task:       { parent: true, points: true },
};
const ADAPTIVE = ['severity', 'parent', 'phase', 'points'];

export async function openNewItem({ kind = '', parent = 0, phase = '' } = {}) {
    const preset = kind ? kindById(kind) : null;
    // Scope the TYPE SELECT to the store the preselection implies: a dialog
    // opened from the backlog's "Epic" button has no business offering to file
    // a bug. Only the top bar's untyped entry point offers all six.
    const store = preset ? preset.store : null;
    const kinds = store ? KINDS.filter((k) => k.store === store) : KINDS;
    const parents = parentOptions('task');

    // Headings only earn their place when the form spans both stores; a scoped
    // dialog has nothing to distinguish.
    const sections = !store;

    const result = await openForm({
        title: preset ? `New ${preset.label.toLowerCase()}` : 'New item',
        submitLabel: 'Create',
        fields: [
            { name: 'kind', label: 'Type', type: 'select', required: true,
              options: kinds.map((k) => ({ value: k.id, label: k.label })),
              ...(sections ? { hint: 'Bug, Regression and Chore go to the bug store; Epic, Story and Task to the backlog.' } : {}) },
            { name: 'title', label: 'Title', type: 'text', required: true,
              placeholder: store === 'bugs' ? 'What is wrong?'
                  : store === 'backlog' ? 'What outcome does this deliver?'
                  : 'What is wrong, or what should this deliver?' },
            { name: 'assignee', label: 'Assignee', type: 'select',
              options: ['', HUMAN_AUTHOR, AGENT_AUTHOR] },
            { name: 'subsystem', label: 'Subsystem', type: 'text', placeholder: 'unsorted' },
            { name: 'labels', label: 'Labels', type: 'text', placeholder: 'comma, separated' },

            ...(sections ? [{ section: 'Bug', name: '__sec_bug' }] : []),
            { name: 'severity', label: 'Severity', type: 'select',
              options: ['crash', 'high', 'medium', 'low'] },

            ...(sections ? [{ section: 'Backlog work', name: '__sec_backlog' }] : []),
            { name: 'parent', label: 'Parent', type: 'select', create: true,
              options: parents,
              placeholder: parents.length ? 'pick an item…' : 'no parent available yet',
              hint: 'Leave empty to file it without one.' },
            { name: 'phase', label: 'Phase', type: 'select', create: true,
              options: PHASES, placeholder: 'e.g. foundation',
              hint: 'Stories and tasks inherit it.' },
            { name: 'points', label: 'Estimate', type: 'text', placeholder: 'e.g. 3' },

            { name: 'description', label: 'Description', type: 'textarea', rows: 5 },
        ],
        defaults: {
            kind: preset ? preset.id : kinds[0].id,
            parent: parent ? String(parent) : '',
            phase,
            assignee: '',
            severity: 'medium',
        },
        // The form follows the Type select: a bug is asked for a severity, a
        // story for a parent and an estimate, an epic for a phase. Fired once on
        // open too, so a preselected type is reflected before the first click.
        onFieldChange: (name, value, api) => {
            const chosen = FIELDS_FOR[api.get('kind')] || {};
            for (const f of ADAPTIVE) api.setVisible(f, !!chosen[f]);
            if (sections) {
                api.setVisible('__sec_bug', !!chosen.severity);
                api.setVisible('__sec_backlog', !!(chosen.parent || chosen.phase || chosen.points));
            }
        },
    });
    if (!result || !clean(result.title)) return null;

    const chosen = kindById(result.kind);
    try {
        if (chosen.store === 'bugs') {
            const bug = await createBug({
                title: clean(result.title),
                type: chosen.value,
                severity: clean(result.severity) || 'medium',
                subsystem: clean(result.subsystem) || 'unsorted',
                assignee: clean(result.assignee) || HUMAN_AUTHOR,
                labels: toList(result.labels),
                links: [],
                description: clean(result.description),
            });
            await loadData();
            statusLine(`Bug #${bug.id} created.`);
            return { store: 'bugs', record: bug };
        }

        // An epic has no parent, and a story/task has no authored phase — it
        // inherits one. Sending either anyway is how the two drift.
        const isEpic = chosen.value === 'epic';
        const item = await createItem({
            title: clean(result.title),
            type: chosen.value,
            parent: isEpic ? 0 : parentId(result.parent),
            phase: isEpic ? clean(result.phase) : '',
            points: clean(result.points),
            assignee: clean(result.assignee),
            subsystem: clean(result.subsystem) || 'unsorted',
            labels: toList(result.labels),
            description: clean(result.description),
        });
        await loadBacklog();
        statusLine(`${itemRef(item)} created.`);
        return { store: 'backlog', record: item };
    } catch (err) {
        statusLine(`Create failed: ${err?.message || err}`);
        return null;
    }
}

/**
 * Open the dialog and then open what it made, in the tile the caller came from.
 * The two always go together — you file something in order to work on it — so
 * every call site would otherwise repeat this branch.
 */
export async function createAndOpen(wm, opts = {}, navOpts = {}) {
    const made = await openNewItem(opts);
    if (!made || !wm) return made;
    if (made.store === 'bugs') {
        wm.openInPrimary('ticket', { id: `#${made.record.id}`, label: `#${made.record.id}` });
    } else {
        wm.openInPrimary('item', {
            id: String(made.record.id),
            label: `${itemRef(made.record)} — ${made.record.title}`,
            ...navOpts,
        });
    }
    return made;
}
