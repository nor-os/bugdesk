/**
 * ticketdesk/backlog_data.js — BugDesk's backlog domain data.
 *
 * The sibling of ./data.js, over the second store:
 *
 *   GET  /api/backlog             -> summaries, already in TREE ORDER
 *   GET  /api/backlog/{id}        -> one item + ancestors + children + comments
 *   POST /api/backlog             -> create (id assigned server-side)
 *   POST /api/backlog/{id}        -> patch frontmatter / description / acceptance
 *   POST /api/backlog/{id}/comments
 *   GET  /api/backlog/meta        -> counts, and the phase vocabulary
 *
 * ITEMS is exported with `let` and REASSIGNED by loadBacklog(); ES-module live
 * bindings mean every importer sees the populated array as long as it reads it
 * at call time. Same contract as TICKETS in ./data.js, for the same reason.
 *
 * WHY THE SERVER ORDERS THE TREE: an epic's stories and their tasks have to
 * render in one flat, indented list, and the depth of a node is a function of
 * the WHOLE store (walk `parent` to the root), not of the row. Doing that walk
 * in the client means every consumer — the table, the palette, a future export —
 * re-derives the same order and gets to disagree about orphans and cycles. The
 * bridge does it once; the client indents what it is handed.
 */

import { AGENT_AUTHOR, HUMAN_AUTHOR } from './data.js';

/* ── mode ────────────────────────────────────────────────────────────
 *
 * BugDesk runs as a bug tracker (default) or as a TRACKER: work handed to other
 * people, who may have no access to this checkout at all. The bridge decides at
 * launch (`--tracker`, or BUGDESK_MODE) and reports it through /api/config,
 * which ui/index.html resolves BEFORE any of these modules are evaluated —
 * exactly as it already does for the two author names.
 *
 * Read once, at module load, like HUMAN_AUTHOR: the mode cannot change without
 * restarting the bridge, so a getter would only invite the belief that it can.
 */
const _cfg = (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__) || {};
export const MODE = _cfg.mode === 'tracker' ? 'tracker' : 'bugs';
export const TRACKER = MODE === 'tracker';

/* ── lifecycle ───────────────────────────────────────────────────────
 *
 * draft → refined → in-progress → review → done, plus the off-ladder terminal
 * `dropped`. `stage` is the index in LADDER, or -1 for dropped — the item page
 * checks for < 0 rather than assuming a chevron is lit.
 *
 * REFINED is the pivot the whole backlog skill turns on: an item is refined when
 * somebody has decided what "done" means for it (acceptance criteria), how big it
 * is (points) and where it belongs (a parent). Before that it is a note to self. */

/**
 * The status VOCABULARY is shared by every type; the LADDER each type walks is
 * not. An epic is never "in review" — its stories are, and an epic reviewed as
 * a unit is just a status nobody can act on. A task inherits its story's
 * acceptance criteria, so it has nothing of its own to refine and nothing
 * separate to review.
 *
 * Sharing the vocabulary is what keeps ONE status enum in the filter editor,
 * ONE set of pills in the CSS and one thing for the skill to explain; varying
 * the ladder is what stops the UI offering transitions that mean nothing.
 *
 * `dropped` is off every ladder: it is reachable from anywhere and returns to
 * `draft`.
 */
export const STATUSES = ['draft', 'refined', 'in-progress', 'review', 'done', 'dropped'];

export const LADDERS = {
    // A project is a container, not a unit of work: nothing about it is refined
    // (it has no acceptance criteria of its own) and nothing about it is
    // reviewed — its epics and stories are, one at a time.
    project: ['draft', 'in-progress', 'done'],
    epic:  ['draft', 'refined', 'in-progress', 'done'],
    story: ['draft', 'refined', 'in-progress', 'review', 'done'],
    task:  ['draft', 'in-progress', 'done'],
};

/** A type's ladder; an unknown type is treated as a story (the full ladder), so
 *  a hand-edited file with a bad `type` still renders every transition rather
 *  than none. */
export const ladderFor = (type) => LADDERS[type] || LADDERS.story;

/** The union ladder, for anything that needs a canonical ORDER across types —
 *  clamping a status when an item is retyped, and sorting. */
export const LADDER = ['draft', 'refined', 'in-progress', 'review', 'done'];

export const STATUS_LABEL = {
    'draft': 'Draft',
    'refined': 'Refined',
    'in-progress': 'In progress',
    'review': 'Review',
    'done': 'Done',
    'dropped': 'Dropped',
};
const STATUS_MACHINE = Object.fromEntries(
    Object.entries(STATUS_LABEL).map(([k, v]) => [v, k]));

export const humanizeItemStatus = (s) => STATUS_LABEL[s]
    || String(s || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const machineItemStatus = (label) => STATUS_MACHINE[label]
    || String(label || '').toLowerCase().replace(/\s+/g, '-');

/** Index of a status within its OWN type's ladder, or -1 for anything off it
 *  (`dropped`, or a status the type never uses). */
export const stageOf = (item) => ladderFor(item?.type).indexOf(item?.status);

/* Button text per TARGET status. Deriving the actions from the ladder means a
 * type that skips `review` simply never offers "Send to review" — there is no
 * second table of transitions to keep in step with the first. */
const ADVANCE_LABEL = {
    refined: 'Mark refined',
    'in-progress': 'Start work',
    review: 'Send to review',
    done: 'Mark done',
};
const BACK_LABEL = {
    draft: 'Back to draft',
    refined: 'Back to refined',
    'in-progress': 'Back to in progress',
    review: 'Back to review',
};

/**
 * The lifecycle buttons for one item: advance, step back, and drop.
 * @returns {Array<[label, targetStatus]>} first entry is the primary action.
 */
export function stageActions(item) {
    if (item?.status === 'dropped') return [['Restore to draft', 'draft']];

    const ladder = ladderFor(item?.type);
    const i = ladder.indexOf(item?.status);
    // A status this type does not use (left behind by a hand edit, or by a
    // retype the server could not clamp) — offer the way back onto the ladder.
    if (i < 0) return [[`Move to ${humanizeItemStatus(ladder[0])}`, ladder[0]], ['Drop', 'dropped']];

    const out = [];
    if (i + 1 < ladder.length) {
        const next = ladder[i + 1];
        out.push([ADVANCE_LABEL[next] || `Move to ${humanizeItemStatus(next)}`, next]);
    }
    if (i > 0) {
        const prev = ladder[i - 1];
        // From the terminal state this reads as reopening, not stepping back.
        out.push([i === ladder.length - 1 ? 'Reopen' : (BACK_LABEL[prev] || `Back to ${humanizeItemStatus(prev)}`), prev]);
    }
    if (item?.status !== 'done') out.push(['Drop', 'dropped']);
    return out;
}

/** The one transition with a precondition — and only for the types that have
 *  it. A task never passes through `refined`, so nothing gates a task. */
export const isGated = (target) => target === 'refined';

/**
 * Every type the STORE can hold, in hierarchy order. Anything that has to
 * RENDER a record it found on disk reads this — a PROJ- file written by a
 * tracker still has to draw with the right glyph and label when the same store
 * is opened as a plain backlog.
 */
export const ALL_TYPES = ['project', 'epic', 'story', 'task'];

/**
 * The types this deployment OFFERS. Tracker mode adds `project` as the level
 * above epics; a plain backlog does not, because a Type select carrying a level
 * the store never uses is a menu entry that only ever files the wrong thing.
 *
 * Offering and rendering are deliberately different lists: a store is shared and
 * may have been written in the other mode, so nothing may refuse to draw a type
 * merely because this deployment would not create one.
 */
export const TYPES = TRACKER ? ALL_TYPES : ['epic', 'story', 'task'];

export const TYPE_LABEL = { project: 'Project', epic: 'Epic', story: 'Story', task: 'Task' };
export const TYPE_ICON = {
    project: 'folder_special', epic: 'workspaces',
    story: 'article', task: 'check_box_outline_blank',
};

/**
 * File prefix per type — the SAME table as BacklogItem.Prefixes on the bridge.
 *
 * A project is `PROJ`, not `PROJECT`, so nothing may derive a reference by
 * upper-casing the type. This used to do exactly that, which was correct only
 * for as long as every prefix happened to be the type in capitals.
 */
export const TYPE_PREFIX = { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' };

export const typeLabelOf = (t) => TYPE_LABEL[t] || 'Task';

/** `EPIC-0007` — how an item is referred to from a bug's `links` and in prose. */
export const itemRef = (item) =>
    `${TYPE_PREFIX[item?.type] || 'TASK'}-${String(item?.id ?? '').padStart(4, '0')}`;

/** Tab / tile label. The bare id says nothing about which item you left open. */
export const itemLabel = (item) =>
    item ? `${itemRef(item)} — ${item.title || ''}`.trim().replace(/—$/, '').trim() : 'Item';

/* ── refinement ──────────────────────────────────────────────────────
 *
 * ONE definition of "refined enough", shared by the UI's Mark refined button and
 * documented verbatim in skills/backlog/SKILL.md. Both surfaces have to agree —
 * an agent that refines an item the UI still shows as unready is worse than no
 * check at all — so the rule lives here and the skill quotes it. */

export const REFINEMENT_RULES = [
    { key: 'title', label: 'Has a title that names the outcome',
      test: (i) => String(i.title || '').trim().length >= 8 },
    { key: 'description', label: 'Has a description',
      test: (i) => String(i.description || '').replace(/_\(.*?\)_/g, '').trim().length > 0 },
    { key: 'criteria', label: 'Has at least one acceptance criterion',
      test: (i) => (i.criteria || []).length > 0 },
    { key: 'points', label: 'Has an estimate',
      test: (i) => String(i.points || '').trim().length > 0 },
    { key: 'parent', label: 'Sits under a parent (top-level items are exempt)',
      test: (i) => i.type === 'epic' || i.type === 'project' || Number(i.parent) > 0 },
];

/** Every unmet rule, so the UI can list what is still missing rather than
 *  just disabling a button with no explanation. */
export const refinementGaps = (item) =>
    REFINEMENT_RULES.filter((r) => { try { return !r.test(item); } catch { return true; } });

/* ── target dates ────────────────────────────────────────────────────
 *
 * A target date is the axis TRACKER mode turns on: the question a follow-up
 * tracker exists to answer is "what is late", and everything else on the
 * dashboard is a way of grouping that answer.
 *
 * Derived HERE rather than on the bridge, once, so the dashboard, the filter
 * catalogue and the board's Due column cannot disagree about what "overdue"
 * means. The bridge stores the plain `YYYY-MM-DD` string and nothing else — a
 * server that computed "overdue" would be answering with ITS today, which is
 * the wrong one the moment a browser is left open past midnight or sits in
 * another timezone.
 */

/** Today as `YYYY-MM-DD`, in the reader's own timezone. */
export function todayISO(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. Negative means `b` is past. */
export function daysBetween(a, b) {
    const [ay, am, ad] = String(a).split('-').map(Number);
    const [by, bm, bd] = String(b).split('-').map(Number);
    if (!ay || !by) return null;
    // UTC on both sides: local midnights differ in length across a DST change,
    // so "3 days" would come out 2.958 twice a year and floor to 2.
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** What "due soon" means, in days. One week: the horizon of the weekly
 *  check-in the dashboard is read in. */
export const DUE_SOON_DAYS = 7;

/**
 * Where a target date stands, as one word the UI can style and filter on.
 *
 * `none` and `done` are separate from the schedule on purpose. An item nobody
 * has dated is not "on time" — it is unanswerable, and a tracker that reports
 * it as fine is hiding exactly the thing it exists to surface. A finished item
 * has no schedule left to be late for, so a date that passed after the work was
 * delivered must not go on burning red forever.
 *
 * @returns {'done'|'none'|'overdue'|'today'|'soon'|'later'}
 */
export function dueState(item, today = todayISO()) {
    if (item?.status === 'done' || item?.status === 'dropped') return 'done';
    const due = String(item?.due || '').trim();
    if (!due) return 'none';
    const days = daysBetween(today, due);
    if (days === null) return 'none';
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    return days <= DUE_SOON_DAYS ? 'soon' : 'later';
}

export const DUE_LABEL = {
    overdue: 'Overdue', today: 'Due today', soon: 'Due soon',
    later: 'Scheduled', none: 'No date', done: 'Closed',
};

/** "3 days late" / "in 5 days" — the phrase, not the date, because the number
 *  of days is the part you act on. */
export function duePhrase(item, today = todayISO()) {
    const state = dueState(item, today);
    if (state === 'none') return 'no target date';
    if (state === 'done') return item?.due ? `target was ${item.due}` : 'no target date';
    const days = daysBetween(today, item.due);
    if (days === 0) return 'due today';
    if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
    return `in ${days} day${days === 1 ? '' : 's'}`;
}

/* ── bridge client ───────────────────────────────────────────────── */

async function apiGet(path) {
    const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}
async function apiPost(path, body) {
    const res = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    // The bridge answers a rejected edit with { ok:false, error } and a 4xx —
    // surface ITS message, which names the actual problem ("#3 is already below
    // #1"), instead of a bare status code.
    if (!res.ok || !j || j.ok === false) {
        throw new Error(j?.error || `POST ${path} → ${res.status}`);
    }
    return j;
}

export async function fetchItem(id) {
    const j = await apiGet(`/backlog/${id}`);
    if (!j.ok) throw new Error(j.error || 'not found');
    return j.item;
}
export async function patchItem(id, patch) {
    return (await apiPost(`/backlog/${id}`, patch)).item;
}
export async function createItem(fields) {
    return (await apiPost('/backlog', fields)).item;
}
export async function postItemComment(id, body, author = HUMAN_AUTHOR) {
    return (await apiPost(`/backlog/${id}/comments`, { author, body })).item;
}

/* ── live store ──────────────────────────────────────────────────── */

export let ITEMS = [];
export let PHASES = [];

/** Depth in the tree, resolved against the loaded store. The bridge orders the
 *  list; the client only has to know how far to indent each row. */
function depthOf(item, byId) {
    let depth = 0;
    let cur = item;
    const seen = new Set([cur.id]);
    while (cur && Number(cur.parent) > 0) {
        const next = byId.get(Number(cur.parent));
        if (!next || seen.has(next.id)) break;   // orphan or a cycle in a hand-edited file
        seen.add(next.id);
        cur = next;
        depth++;
    }
    return depth;
}

/** The owning epic's reference — the item's own when it IS an epic, else the
 *  nearest ancestor epic's. This is what makes "show me this whole work
 *  package" one clause instead of a recursive walk in every consumer. */
function epicRefOf(item, byId) {
    let cur = item;
    const seen = new Set([cur.id]);
    while (cur) {
        if (cur.type === 'epic') return itemRef(cur);
        const next = byId.get(Number(cur.parent));
        if (!next || seen.has(next.id)) return '';
        seen.add(next.id);
        cur = next;
    }
    return '';
}

/**
 * The owning PROJECT's reference — the item's own when it IS a project, else the
 * nearest ancestor project's. The exact mirror of epicRefOf one level up, and
 * what makes "everything I am tracking under PROJ-0003" a single filter clause
 * however deep the row sits.
 */
function projectRefOf(item, byId) {
    let cur = item;
    const seen = new Set([cur.id]);
    while (cur) {
        if (cur.type === 'project') return itemRef(cur);
        const next = byId.get(Number(cur.parent));
        if (!next || seen.has(next.id)) return '';
        seen.add(next.id);
        cur = next;
    }
    return '';
}

function mapItem(raw, byId) {
    const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
    const parent = byId.get(Number(raw.parent));
    return {
        ...raw,
        ref: itemRef(raw),
        parentRef: parent ? itemRef(parent) : '',
        epicRef: epicRefOf(raw, byId),
        projectRef: projectRefOf(raw, byId),
        depth: depthOf(raw, byId),
        ladder: ladderFor(raw.type),
        statusLabel: humanizeItemStatus(raw.status),
        typeLabel: typeLabelOf(raw.type),
        criteria,
        criteriaDone: criteria.filter((c) => c.done).length,
        criteriaTotal: criteria.length,
        // The phase actually in force, own or inherited — what the rail filters on.
        phaseLabel: raw.effectivePhase || '',
        assignee: raw.assignee || '',
        reporter: raw.reporter || '',
        due: raw.due || '',
        dueState: dueState(raw),
        duePhrase: duePhrase(raw),
        updated: raw.updated || '',
    };
}

/** Fetch /api/backlog + /api/backlog/meta and (re)populate the live store. */
export async function loadBacklog() {
    const [listRes, metaRes] = await Promise.all([apiGet('/backlog'), apiGet('/backlog/meta')]);
    const raw = Array.isArray(listRes.items) ? listRes.items : [];
    const byId = new Map(raw.map((i) => [Number(i.id), i]));
    ITEMS = raw.map((i) => mapItem(i, byId));
    PHASES = Array.isArray(metaRes.phases) ? metaRes.phases : [];
    return { count: ITEMS.length };
}

/* ── the tree ────────────────────────────────────────────────────────
 *
 * A filtered backlog still has to READ as a hierarchy: a story that matches is
 * meaningless floating at the root with nothing saying which epic it belongs
 * to. So every view keeps the ANCESTORS of every match, flagged `context` —
 * they are shown so the matches have something to hang from, not because they
 * matched.
 *
 * This replaced a `tree: true/false` flag per view. A flat mode existed for the
 * "show me the loose ends" views, but hierarchy is the thing that makes a
 * backlog a backlog: an unparented story reads as a problem precisely BECAUSE
 * every other row sits under something. */

/** Ancestor ids of one item, nearest first. Guards a cycle from a hand edit. */
function ancestorIds(item, byId) {
    const out = [];
    let cur = item;
    const seen = new Set([cur.id]);
    while (cur && Number(cur.parent) > 0) {
        const next = byId.get(Number(cur.parent));
        if (!next || seen.has(next.id)) break;
        seen.add(next.id);
        out.push(next.id);
        cur = next;
    }
    return out;
}

/**
 * Rows to render, in display order, with everything the tree drawing needs.
 *
 * @param {(item) => boolean} match      the compiled filter predicate
 * @param {Set<number>}       collapsed  ids whose children are folded away
 * @returns {Array} rows carrying:
 *    depth          how far to indent
 *    ancestorsLast  per ancestor level, whether it was the last of its siblings
 *                   (false there means a vertical guide line continues)
 *    isLast         last of its own siblings — picks └ over ├
 *    hasChildren    within THIS view, so a caret never promises an empty fold
 *    isCollapsed    folded right now
 *    hidden         descendants folded away, for the "(3 hidden)" hint
 *    context        kept as an ancestor, did not match
 */
export function treeRows(match, collapsed = new Set()) {
    const byId = new Map(ITEMS.map((i) => [Number(i.id), i]));
    const matched = ITEMS.filter(match);

    const keep = new Set(matched.map((i) => i.id));
    for (const item of matched) {
        for (const id of ancestorIds(item, byId)) keep.add(id);
    }

    // ITEMS arrives in tree order from the bridge, so grouping preserves it.
    const kept = ITEMS.filter((i) => keep.has(i.id));
    const byParent = new Map();
    const roots = [];
    for (const item of kept) {
        const parent = Number(item.parent);
        if (parent > 0 && keep.has(parent)) {
            if (!byParent.has(parent)) byParent.set(parent, []);
            byParent.get(parent).push(item);
        } else {
            // Either a genuine root, or an orphan whose parent is filtered out /
            // deleted. Both render at the top level; neither may vanish.
            roots.push(item);
        }
    }

    const descendantCount = (id) => {
        let n = 0;
        for (const kid of byParent.get(id) || []) n += 1 + descendantCount(kid.id);
        return n;
    };

    const rows = [];
    const walk = (list, ancestorsLast) => {
        list.forEach((item, idx) => {
            const isLast = idx === list.length - 1;
            const kids = byParent.get(item.id) || [];
            const isCollapsed = collapsed.has(item.id) && kids.length > 0;
            rows.push({
                ...item,
                depth: ancestorsLast.length,
                ancestorsLast: [...ancestorsLast],
                isLast,
                hasChildren: kids.length > 0,
                isCollapsed,
                hidden: isCollapsed ? descendantCount(item.id) : 0,
                context: !match(item),
            });
            if (kids.length && !isCollapsed) walk(kids, [...ancestorsLast, isLast]);
        });
    };
    walk(roots, []);
    return rows;
}

/**
 * Which types may legally HOLD an item of `childType`, conventional level first.
 *
 * ONE definition, here rather than in the picker, because three surfaces read it
 * — the picker's type chips, the New item form deciding whether to show a Parent
 * row at all, and the item page's Parent control — and three copies would be
 * three chances to disagree about whether a task may hang off an epic.
 *
 * A flat `parentOptions(type)` list used to live here as well, for the dropdowns
 * these controls replaced. It is gone rather than kept: a second answer to
 * "what may hold this" is the duplication this function exists to prevent, and
 * an unused one drifts silently.
 *
 * A level may always be SKIPPED: a story directly under a project, a task
 * directly under an epic. The intermediate record is often ceremony, and the
 * bridge does not enforce type pairs either (it enforces existence and
 * acyclicity, the two failures that actually break the tree).
 */
export const parentTypesFor = (childType) =>
    childType === 'epic' ? ['project']
    : childType === 'story' ? ['epic', 'project']
    : childType === 'task' ? ['story', 'epic', 'project']
    : [];

/**
 * The mirror: types that may hang UNDER `parentType`, which is what the picker
 * preselects when attaching an existing item as a child.
 *
 * A project offers all three — "a story and a task can be added straight to a
 * project" is the arrangement a follow-up tracker is mostly made of, where an
 * epic in between would be an empty ceremony record.
 */
export const childTypesFor = (parentType) =>
    parentType === 'project' ? ['epic', 'story', 'task']
    : parentType === 'epic' ? ['story']
    : parentType === 'story' ? ['task']
    : [];

/** Every id in the current store that could be collapsed — what "collapse all"
 *  needs, without the caller walking the tree itself. */
export const collapsibleIds = () => {
    const parents = new Set(ITEMS.map((i) => Number(i.parent)).filter((p) => p > 0));
    return ITEMS.filter((i) => parents.has(Number(i.id))).map((i) => Number(i.id));
};
