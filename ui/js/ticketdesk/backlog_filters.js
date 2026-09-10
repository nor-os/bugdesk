/**
 * ticketdesk/backlog_filters.js — the BACKLOG's filter vocabulary.
 *
 * The sibling of ./filters.js over the second store, sharing the engine
 * (./filter_engine.js) and the saved-filter list (./filter_store.js, scope
 * 'backlog'). The questions you ask of a backlog are not the questions you ask
 * of a bug queue — there is no severity, and there IS a hierarchy — so the
 * field catalogue is entirely its own.
 *
 * Two fields exist only because of the hierarchy, and they are the ones that
 * make the tree navigable by query rather than only by scrolling:
 *
 *   `epic`   the OWNING epic of any item, however deep. `Epic is EPIC-0001`
 *            selects a whole work package — the epic, its stories and their
 *            tasks — which is what "scope the board to this epic" means.
 *   `project` the same one level up, for tracker mode.
 *   `depth`  how far down the tree a row sits, so "only top-level things" is
 *            expressible without naming types.
 *
 * `dueState` is the other derived field, and the one TRACKER mode turns on:
 * "overdue" as a single clause rather than date arithmetic the user rebuilds
 * every week, computed once on load so every surface means the same thing by it.
 *
 * The BUILTIN VIEWS differ by mode — a manager chasing work does not groom a
 * backlog — but the FIELD CATALOGUE does not: a filter someone saved in one
 * mode has to keep resolving in the other.
 *
 * `phase` and `epic` take their options from the LIVE store: both vocabularies
 * are data, not constants, and a filter editor offering last-reload's phases is
 * worse than one offering none. `options` is a getter for exactly that reason.
 */

import { createFilterModel, emptyExpr } from './filter_engine.js';
import {
    deleteFilter as storeDelete, duplicateFilter as storeDuplicate,
    getFilter as storeGet, listFilters as storeList, saveFilter as storeSave,
} from './filter_store.js';
import { ASSIGNEES, HUMAN_AUTHOR, AGENT_AUTHOR } from './data.js';
import {
    DUE_LABEL, ITEMS, PHASES, STATUSES, TRACKER, TYPES, typeLabelOf,
} from './backlog_data.js';

export const SCOPE = 'backlog';

/** Every item of one type currently in the store, as `{ value: 'EPIC-0001' }`. */
const refOptionsFor = (type) => ITEMS
    .filter((i) => i.type === type)
    .map((i) => ({ value: i.ref, label: `${i.ref} — ${i.title}` }));
const epicOptions = () => refOptionsFor('epic');

export const FILTER_FIELDS = [
    { key: 'ref', label: 'Reference', type: 'text', get: (i) => i.ref || '' },
    {
        key: 'type', label: 'Type', type: 'enum',
        options: TYPES.map((t) => ({ value: t, label: typeLabelOf(t) })),
        get: (i) => i.type || '',
    },
    {
        key: 'status', label: 'Status', type: 'enum',
        options: STATUSES,
        get: (i) => i.status || '',
    },
    { key: 'title', label: 'Title', type: 'text', get: (i) => i.title || '' },
    {
        key: 'phase', label: 'Phase', type: 'enum',
        get options() { return PHASES; },
        get: (i) => i.phaseLabel || '',
    },
    {
        // The whole work package, at any depth — an epic answers for itself.
        key: 'epic', label: 'Epic', type: 'enum',
        get options() { return epicOptions(); },
        get: (i) => i.epicRef || '',
    },
    {
        // The whole project, at any depth — the tracker's equivalent of `epic`
        // one level up, and what "everything I am tracking for this client"
        // resolves to as a single clause.
        key: 'project', label: 'Project', type: 'enum',
        get options() { return refOptionsFor('project'); },
        get: (i) => i.projectRef || '',
    },
    { key: 'parent', label: 'Parent', type: 'text', get: (i) => i.parentRef || '' },
    { key: 'depth', label: 'Depth', type: 'number', get: (i) => i.depth || 0 },
    {
        key: 'assignee', label: 'Assignee', type: 'enum',
        options: [...ASSIGNEES, 'none'],
        get: (i) => i.assignee || 'none',
    },
    {
        // Who is following it up, as opposed to who is doing it. The pair is
        // what makes "what did I hand out" a question with an answer.
        key: 'reporter', label: 'Reporter', type: 'enum',
        options: [...ASSIGNEES, 'none'],
        get: (i) => i.reporter || 'none',
    },
    { key: 'due', label: 'Target date', type: 'date', get: (i) => i.due || '' },
    {
        // The DERIVED standing of that date, so "overdue" is one clause rather
        // than a date arithmetic expression the user has to rebuild each week —
        // and so every surface means the same thing by it. Recomputed on load
        // (see mapItem), not at query time: an item's state must not change
        // under a filter halfway through a session.
        key: 'dueState', label: 'Due', type: 'enum',
        options: Object.entries(DUE_LABEL).map(([value, label]) => ({ value, label })),
        get: (i) => i.dueState || 'none',
    },
    { key: 'points', label: 'Estimate', type: 'number', get: (i) => i.points },
    { key: 'subsystem', label: 'Subsystem', type: 'text', get: (i) => i.subsystem || '' },
    { key: 'labels', label: 'Labels', type: 'set', get: (i) => Array.isArray(i.labels) ? i.labels : [] },
    { key: 'children', label: 'Children', type: 'number', get: (i) => i.children || 0 },
    { key: 'criteriaTotal', label: 'Criteria', type: 'number', get: (i) => i.criteriaTotal || 0 },
    { key: 'criteriaDone', label: 'Criteria met', type: 'number', get: (i) => i.criteriaDone || 0 },
    { key: 'created', label: 'Created', type: 'date', get: (i) => i.created || '' },
    { key: 'updated', label: 'Updated', type: 'date', get: (i) => i.updated || '' },
    { key: 'comments', label: 'Comments', type: 'number', get: (i) => i.comments || 0 },
    {
        key: 'lastCommentAuthor', label: 'Last comment by', type: 'enum',
        options: [...ASSIGNEES, 'none'],
        get: (i) => i.lastCommentAuthor || 'none',
    },
];

export const MODEL = createFilterModel({ fields: FILTER_FIELDS, noun: 'item' });

export const {
    matcherFor, describeFilter, validateFilter, evaluateFilter,
} = MODEL;

const clause = (field, op, value) => ({ kind: 'clause', field, op, value });
const and = (...children) => ({ kind: 'group', op: 'AND', children });

/* ── builtin views ───────────────────────────────────────────────────
 *
 * Rail order IS this order. These were hand-written predicates ("BACKLOG_VIEWS")
 * until the backlog got the same expression editor the bug queue has; expressing
 * them as ASTs is what makes "duplicate this and tweak it" a data operation
 * rather than a feature request. */

const OPEN = clause('status', 'none_of', ['done', 'dropped']);

/**
 * TRACKER views. A different job asks different questions: a manager following
 * up work handed to other people does not groom a backlog, so "Needs
 * refinement" and "Ready to start" are not on this rail — and the two questions
 * a plain backlog cannot ask at all, "what is late" and "what has nobody
 * committed to a date for", lead it.
 *
 * `Unassigned` and `No target date` are deliberately near the top. They are the
 * holes in the tracker itself, and a tool that only reports the work it knows
 * about is most confident exactly where it is least complete.
 */
const TRACKER_FILTERS = [
    {
        key: 'overdue', label: 'Overdue', icon: 'running_with_errors', builtin: true,
        expr: and(clause('dueState', 'is', 'overdue')),
    },
    {
        key: 'duesoon', label: 'Due this week', icon: 'event_upcoming', builtin: true,
        expr: and(clause('dueState', 'one_of', ['today', 'soon'])),
    },
    {
        key: 'active', label: 'In progress', icon: 'bolt', builtin: true,
        expr: and(clause('status', 'is', 'in-progress')),
    },
    {
        key: 'unassigned', label: 'Nobody on it', icon: 'person_off', builtin: true,
        expr: and(OPEN, clause('assignee', 'is', 'none')),
    },
    {
        key: 'undated', label: 'No target date', icon: 'event_busy', builtin: true,
        expr: and(OPEN, clause('dueState', 'is', 'none')),
    },
    {
        key: 'byme', label: 'Assigned by me', icon: 'outbound', builtin: true,
        // Reporter, not assignee: "what I handed out", which is the whole
        // premise of the mode. Items written before `reporter` existed carry
        // none, which is why this is a view rather than a global scope.
        expr: and(OPEN, clause('reporter', 'is', HUMAN_AUTHOR)),
    },
    {
        key: 'mine', label: 'On me', icon: 'person', builtin: true,
        expr: and(OPEN, clause('assignee', 'is', HUMAN_AUTHOR)),
    },
    {
        key: 'projects', label: 'Projects', icon: 'folder_special', builtin: true,
        expr: and(clause('type', 'is', 'project')),
    },
    {
        key: 'board', label: 'Everything open', icon: 'list', builtin: true,
        expr: and(OPEN),
    },
    { key: 'all', label: 'Everything', icon: 'list_alt', builtin: true, expr: emptyExpr() },
    {
        key: 'done', label: 'Closed', icon: 'check_circle', builtin: true,
        expr: and(clause('status', 'one_of', ['done', 'dropped'])),
    },
];

const BACKLOG_FILTERS = [
    {
        key: 'board', label: 'Backlog', icon: 'workspaces', builtin: true,
        expr: and(clause('status', 'none_of', ['done', 'dropped'])),
    },
    { key: 'all', label: 'Everything', icon: 'list', builtin: true, expr: emptyExpr() },
    {
        key: 'unrefined', label: 'Needs refinement', icon: 'pending_actions', builtin: true,
        // Tasks never pass through `refined` (see LADDERS in ./backlog_data.js),
        // so a draft task is not waiting on refinement and does not belong in
        // the queue of things to groom.
        expr: and(clause('status', 'is', 'draft'), clause('type', 'none_of', ['task'])),
    },
    {
        key: 'ready', label: 'Ready to start', icon: 'task_alt', builtin: true,
        expr: and(clause('status', 'one_of', ['refined', 'draft']), clause('type', 'none_of', ['epic'])),
    },
    {
        key: 'active', label: 'In progress', icon: 'bolt', builtin: true,
        expr: and(clause('status', 'is', 'in-progress')),
    },
    {
        key: 'review', label: 'In review', icon: 'rate_review', builtin: true,
        expr: and(clause('status', 'is', 'review')),
    },
    {
        key: 'epics', label: 'Epics', icon: 'workspaces', builtin: true,
        expr: and(clause('type', 'is', 'epic')),
    },
    {
        key: 'mine', label: 'On me', icon: 'person', builtin: true,
        expr: and(clause('assignee', 'is', HUMAN_AUTHOR)),
    },
    {
        key: 'agent', label: `On ${AGENT_AUTHOR}`, icon: 'smart_toy', builtin: true,
        expr: and(clause('assignee', 'is', AGENT_AUTHOR)),
    },
    {
        key: 'done', label: 'Done', icon: 'check_circle', builtin: true,
        expr: and(clause('status', 'one_of', ['done', 'dropped'])),
    },
];

/** The rail's views for this deployment. Rail order IS this order. */
export const BUILTIN_FILTERS = TRACKER ? TRACKER_FILTERS : BACKLOG_FILTERS;

/* `board` is the key both sets share, so a saved tile layout or a restored tab
 * pointing at it resolves in either mode — to "Backlog" or to "Everything
 * open", which are the same question asked of two different stores. */
export const DEFAULT_FILTER = 'board';

/* ── scope-bound store access ────────────────────────────────────── */

export const listFilters = () => storeList(SCOPE);
export const getFilter = (id) => storeGet(id, BUILTIN_FILTERS);
export const saveFilter = (filter) => storeSave(filter, SCOPE);
export const deleteFilter = (id) => storeDelete(id);
export const duplicateFilter = (keyOrId) => storeDuplicate(keyOrId, BUILTIN_FILTERS, SCOPE);

/** Builtin key OR saved id → a renderable view model. An unknown id (deleted
 *  filter, stale restored tab) degrades to the default rather than throwing — a
 *  layout restore must never be able to break the page. */
export function resolveFilter(key) {
    const f = getFilter(key) || getFilter(DEFAULT_FILTER);
    return {
        key: f.key || f.id,
        label: f.label,
        icon: f.icon || 'filter_alt',
        expr: f.expr,
        builtin: !!f.builtin,
        adhoc: false,
        match: matcherFor(f.expr),
    };
}

/** An unsaved expression (a rail epic click, a context-menu "filter by this
 *  cell") dressed up as a view model. No key, so nothing looks it up. */
export function adhocFilter(expr, label) {
    return {
        key: null,
        label: label || describeFilter(expr) || 'Ad-hoc filter',
        icon: 'filter_alt',
        expr, builtin: false, adhoc: true, match: matcherFor(expr),
    };
}

/** The expression that selects one whole work package. */
export const epicExpr = (ref) => and(clause('epic', 'is', ref));

/** The same, one level up: everything under one project, at any depth. */
export const projectExpr = (ref) => and(clause('project', 'is', ref));

/** Everything on one person's plate, open. What a dashboard row navigates to. */
export const assigneeExpr = (name) => and(OPEN, clause('assignee', 'is', name || 'none'));

/** One due standing, e.g. everything overdue. */
export const dueStateExpr = (state) => and(clause('dueState', 'is', state));
