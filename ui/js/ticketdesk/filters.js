/**
 * ticketdesk/filters.js — the BUG queue's filter vocabulary.
 *
 * The expression language, the compiler, the describer and the validator used
 * to live here. They now live in ./filter_engine.js, and the saved-filter store
 * in ./filter_store.js, because the backlog needs both over a completely
 * different set of fields (see ./backlog_filters.js). What is left here is the
 * part that is genuinely about BUGS: which fields you can ask about, and the
 * builtin filters the rail offers.
 *
 * Every export the rest of the bug UI used to import from this file is still
 * exported from it — bound to the bug model and the 'bugs' store scope — so
 * pages.js and filter_editor.js did not have to learn about the split.
 */

import {
    RESOLUTIONS, customFilterFields, isFinished, isSnoozed, markHiddenFilterFields, snoozeConfigured, storeStatuses,
} from './schema.js';
import { createFilterModel, FILTER_ICONS, emptyExpr } from './filter_engine.js';
import {
    deleteFilter as storeDelete, duplicateFilter as storeDuplicate,
    getFilter as storeGet, listFilters as storeList,
    loadFilters, onFiltersChanged, saveFilter as storeSave,
} from './filter_store.js';
import { ASSIGNEES, HUMAN_AUTHOR, AGENT_AUTHOR } from './data.js';

export { FILTER_ICONS, emptyExpr, loadFilters, onFiltersChanged };

export const SCOPE = 'bugs';

/* ── field catalogue ─────────────────────────────────────────────────
 *
 * One entry per comparable field of a mapped ticket. `get(t)` pulls the
 * COMPARABLE value, which is not always the display value: `status` reads the
 * raw machine status (open/investigation/testing/closed) rather than the
 * humanised label, `updated` reads t.sla (BugDesk has no SLA — that column
 * carries `updated`), and lastCommentAuthor collapses null to the sentinel
 * 'none' so "nobody has commented" is a selectable enum option. */

export const FILTER_FIELDS = [
    { key: 'id', label: 'Bug', type: 'text', get: (t) => t.id || '' },
    { key: 'pri', label: 'Priority', type: 'number', get: (t) => t.pri },
    {
        key: 'severity', label: 'Severity', type: 'enum',
        options: ['crash', 'high', 'medium', 'low'],
        get: (t) => t.severity || '',
    },
    {
        key: 'status', label: 'Status', type: 'enum',
        // The project's own statuses (Settings › Record types) join the four.
        options: ['open', 'investigation', 'testing', 'closed', ...storeStatuses('bugs').map((s) => s.name)],
        get: (t) => t.rawStatus || '',
    },
    {
        // CHORE, not TASK: the word "task" belongs to the backlog store now
        // (epic → story → task), and one vocabulary meaning two things across
        // two stores is exactly the confusion this rename removes. The value on
        // disk is still `task`, so no existing bug file had to be rewritten —
        // see typeCode/typeLabelOf in ./data.js.
        key: 'type', label: 'Type', type: 'enum',
        options: ['BUG', 'REG', 'CHORE'],
        get: (t) => t.type || '',
    },
    {
        // Closed, or in a custom status whose category is finished (Settings ›
        // Record types). What the open views are built on, so a project's own
        // `wontfix` leaves them the way `closed` does.
        key: 'finished', label: 'Finished', type: 'enum',
        options: [{ value: 'no', label: 'no' }, { value: 'yes', label: 'yes' }],
        get: (t) => (isFinished('bugs', t.rawType || 'bug', t.rawStatus) ? 'yes' : 'no'),
    },
    {
        // "Snooze until" still ahead (TASK-0004). Always 'no' for a type that
        // does not carry the field, so it narrows nothing there.
        key: 'snoozed', label: 'Snoozed', type: 'enum',
        options: [{ value: 'no', label: 'no' }, { value: 'yes', label: 'yes' }],
        get: (t) => (isSnoozed('bugs', t.rawType || 'bug', t.fields) ? 'yes' : 'no'),
    },
    {
        // How it ended (STORY-0050): '' — "none" — while it has not.
        key: 'resolution', label: 'Resolution', type: 'enum',
        options: [...RESOLUTIONS.map(([value, label]) => ({ value, label })), { value: 'none', label: 'none' }],
        get: (r) => r.resolution || 'none',
    },
    { key: 'summary', label: 'Summary', type: 'text', get: (t) => t.summary || '' },
    { key: 'subsystem', label: 'Subsystem', type: 'text', get: (t) => t.subsystem || '' },
    {
        key: 'assignee', label: 'Assignee', type: 'enum',
        options: ASSIGNEES,
        get: (t) => t.assignee || '',
    },
    { key: 'labels', label: 'Labels', type: 'set', get: (t) => Array.isArray(t.labels) ? t.labels : [] },
    { key: 'created', label: 'Created', type: 'date', get: (t) => t.created || '' },
    { key: 'updated', label: 'Updated', type: 'date', get: (t) => t.sla || '' },
    { key: 'comments', label: 'Comments', type: 'number', get: (t) => t.comments || 0 },
    {
        key: 'lastCommentAuthor', label: 'Last comment by', type: 'enum',
        options: [...ASSIGNEES, 'none'],
        get: (t) => t.lastCommentAuthor || 'none',
    },
    { key: 'lastCommentDate', label: 'Last comment', type: 'date', get: (t) => t.lastCommentDate || '' },
    // The project's own fields — see ./schema.js.
    ...customFilterFields('bugs'),
];
markHiddenFilterFields('bugs', FILTER_FIELDS);

export const MODEL = createFilterModel({ fields: FILTER_FIELDS, noun: 'bug' });

export const {
    matcherFor, describeFilter, validateFilter, evaluateFilter,
} = MODEL;

/* ── builtin filters ─────────────────────────────────────────────────
 *
 * The rail order IS this order. `key` is what routing props carry
 * (props.filter), and getFilter() resolves builtin keys as well as saved ids. */

export const BUILTIN_FILTERS = [
    {
        key: 'needs-reply', label: 'Needs my reply', icon: 'mark_chat_unread', builtin: true,
        expr: {
            kind: 'group', op: 'AND', children: [
                { kind: 'clause', field: 'lastCommentAuthor', op: 'is', value: AGENT_AUTHOR },
                { kind: 'clause', field: 'finished', op: 'is', value: 'no' },
            ],
        },
    },
    // The DEFAULT view (see DEFAULT_FILTER in pages.js). A closed bug is done
    // with — it should not be in the way of the queue you actually work from.
    // "All Bugs" below still means all, closed included.
    {
        key: 'active', label: 'Active', icon: 'pending', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [
            { kind: 'clause', field: 'finished', op: 'is', value: 'no' },
            // A snoozed bug stays out until its day — only where the project
            // has the field, so a project without it sees the same view as ever.
            ...(snoozeConfigured('bugs') ? [{ kind: 'clause', field: 'snoozed', op: 'is', value: 'no' }] : []),
        ] },
    },
    { key: 'all', label: 'All Bugs', icon: 'inbox', builtin: true, expr: emptyExpr() },
    {
        key: 'open', label: 'Open', icon: 'fiber_new', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'open' }] },
    },
    {
        key: 'investigation', label: 'Investigation', icon: 'science', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'investigation' }] },
    },
    {
        key: 'testing', label: 'Testing', icon: 'bug_report', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'testing' }] },
    },
    // One view per custom status (Settings › Record types), beside the built-in ones.
    ...storeStatuses('bugs').map((st) => ({
        key: `status-${st.name}`, label: st.label || st.name, builtin: true,
        icon: { waiting: 'hourglass_top', finished: 'do_not_disturb_on' }[st.category] || 'radio_button_checked',
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: st.name }] },
    })),
    {
        key: 'snoozed', label: 'Snoozed', icon: 'snooze', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'snoozed', op: 'is', value: 'yes' }] },
    },
    {
        key: 'closed', label: 'Closed', icon: 'check_circle', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'closed' }] },
    },
    {
        key: 'on-me', label: 'On me', icon: 'person', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'assignee', op: 'is', value: HUMAN_AUTHOR }] },
    },
    {
        key: 'on-agent', label: `On ${AGENT_AUTHOR}`, icon: 'smart_toy', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'assignee', op: 'is', value: AGENT_AUTHOR }] },
    },
];

/* ── scope-bound store access ────────────────────────────────────────
 * Thin bindings so nothing in the bug UI has to pass 'bugs' around, or know
 * that the backlog's filters share the same list underneath. */

/** Everything still open on one person. What the Inspector's rows navigate to:
 *  a name is only useful if clicking it shows you the work behind the number. */
export const assigneeExpr = (name) => ({
    kind: 'group', op: 'AND', children: [
        { kind: 'clause', field: 'finished', op: 'is', value: 'no' },
        { kind: 'clause', field: 'assignee', op: 'is', value: name || '' },
    ],
});

export const listFilters = () => storeList(SCOPE);
export const getFilter = (id) => storeGet(id, BUILTIN_FILTERS);
export const saveFilter = (filter) => storeSave(filter, SCOPE);
export const deleteFilter = (id) => storeDelete(id);
export const duplicateFilter = (keyOrId) => storeDuplicate(keyOrId, BUILTIN_FILTERS, SCOPE);
