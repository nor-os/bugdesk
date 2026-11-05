/**
 * ticketdesk/filter_engine.js — BugDesk's words on FlexDesk's filter model.
 *
 * The expression language (matching, describing, validating) is FlexDesk's
 * createFilterModel. A FIELD CATALOGUE goes in, a bound MODEL comes out:
 *
 *   const model = createFilterModel({ fields: [...] });
 *   model.matcherFor(expr)(row);
 *   model.describeFilter(expr);   // "Status is investigation AND Severity one of crash, high"
 *
 * A field is `{ key, label, type, get(row), options? }`, where `get` pulls the
 * COMPARABLE value — not always the displayed one (a bug's `status` compares the
 * raw machine status, never the humanised label). A custom field (`custom: true`)
 * has its own group in the editor, and goes by its name, without its `cf.` prefix,
 * when it has gone from the schema.
 */

import { createFilterModel as bindFilterModel } from '@flexdesk/widgets';

/* ── icon palette ────────────────────────────────────────────────────
 * Curated Material Symbols (outlined) names — the editor's icon dropdown.
 * Deliberately a shortlist: the full set is thousands of names and a filter
 * only ever wants "a small glyph that reads at 14px in the rail". */

export const FILTER_ICONS = [
    'inbox', 'filter_alt', 'bug_report', 'science', 'fiber_new', 'check_circle',
    'mark_chat_unread', 'forum', 'person', 'group', 'smart_toy', 'engineering',
    'flag', 'star', 'bolt', 'priority_high', 'warning', 'error', 'report',
    'schedule', 'timer', 'hourglass_empty', 'event', 'calendar_month', 'history',
    'label', 'sell', 'bookmark', 'push_pin', 'folder', 'storage', 'category',
    'task_alt', 'checklist', 'done_all', 'pending', 'block', 'visibility',
    'trending_up', 'trending_down', 'whatshot', 'ac_unit', 'build', 'construction',
    'terminal', 'code', 'memory', 'rocket_launch', 'favorite', 'help',
    'workspaces', 'article', 'account_tree', 'lan', 'pending_actions',
    'rate_review', 'timeline', 'flag_circle', 'stacks',
];

/* The editor's field select: one caption per type, the project's own below them. */
const TYPE_GROUP = {
    text: 'Text',
    enum: 'Choice',
    set: 'Labels',
    number: 'Numbers',
    date: 'Dates',
};

/**
 * @param {object}  o
 * @param {Array}   o.fields  `{ key, label, type, get(row), options?, custom? }[]`.
 *                            Entries are kept, not copied: `options` may be a getter.
 * @param {string}  [o.noun]  what one row is called, for messages ("bug", "item")
 */
export function createFilterModel({ fields, noun }) {
    for (const f of fields) f.group = f.custom ? 'Custom fields' : TYPE_GROUP[f.type];
    return bindFilterModel({ fields, noun, unknownName: (key) => key.replace(/^cf\./, '') });
}
