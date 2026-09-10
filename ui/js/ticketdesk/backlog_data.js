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

/* ── lifecycle ───────────────────────────────────────────────────────
 *
 * draft → refined → in-progress → review → done, plus the off-ladder terminal
 * `dropped`. `stage` is the index in LADDER, or -1 for dropped — the item page
 * checks for < 0 rather than assuming a chevron is lit.
 *
 * REFINED is the pivot the whole backlog skill turns on: an item is refined when
 * somebody has decided what "done" means for it (acceptance criteria), how big it
 * is (points) and where it belongs (a parent). Before that it is a note to self. */

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

/** Stage index, or -1 for anything off the ladder (`dropped`). */
export const stageOf = (status) => LADDER.indexOf(status);

export const TYPES = ['epic', 'story', 'task'];
export const TYPE_LABEL = { epic: 'Epic', story: 'Story', task: 'Task' };
export const TYPE_ICON = { epic: 'workspaces', story: 'article', task: 'check_box_outline_blank' };
export const typeLabelOf = (t) => TYPE_LABEL[t] || 'Task';

/** `EPIC-0007` — how an item is referred to from a bug's `links` and in prose. */
export const itemRef = (item) =>
    `${String(item?.type || 'task').toUpperCase()}-${String(item?.id ?? '').padStart(4, '0')}`;

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
    { key: 'parent', label: 'Sits under a parent (epics are exempt)',
      test: (i) => i.type === 'epic' || Number(i.parent) > 0 },
];

/** Every unmet rule, so the UI can list what is still missing rather than
 *  just disabling a button with no explanation. */
export const refinementGaps = (item) =>
    REFINEMENT_RULES.filter((r) => { try { return !r.test(item); } catch { return true; } });

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

function mapItem(raw, byId) {
    const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
    return {
        ...raw,
        ref: itemRef(raw),
        depth: depthOf(raw, byId),
        statusLabel: humanizeItemStatus(raw.status),
        typeLabel: typeLabelOf(raw.type),
        criteria,
        criteriaDone: criteria.filter((c) => c.done).length,
        criteriaTotal: criteria.length,
        // The phase actually in force, own or inherited — what the rail filters on.
        phaseLabel: raw.effectivePhase || '',
        assignee: raw.assignee || '',
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

/* ── rail views ──────────────────────────────────────────────────────
 *
 * The backlog rail is a fixed set of views, not the bug queue's expression
 * editor. The bug filters exist because a bug queue is something you interrogate
 * from many angles; a backlog is something you walk down. Adding a second AST,
 * a second field catalogue and a second editor to answer "what is not refined
 * yet" would be machinery in search of a question.
 *
 * `match` is a plain predicate over a mapped item. `tree: true` means the view
 * keeps the hierarchy (ancestors of a match are shown as context); `tree: false`
 * renders a flat list, which is what you want when the whole point is "show me
 * the loose ends". */

export const BACKLOG_VIEWS = [
    { key: 'board', label: 'Backlog', icon: 'workspaces', tree: true,
      match: (i) => i.status !== 'done' && i.status !== 'dropped' },
    { key: 'all', label: 'Everything', icon: 'list', tree: true,
      match: () => true },
    { key: 'unrefined', label: 'Needs refinement', icon: 'pending_actions', tree: false,
      match: (i) => i.status === 'draft' },
    { key: 'ready', label: 'Refined', icon: 'task_alt', tree: false,
      match: (i) => i.status === 'refined' },
    { key: 'active', label: 'In progress', icon: 'bolt', tree: false,
      match: (i) => i.status === 'in-progress' },
    { key: 'review', label: 'In review', icon: 'rate_review', tree: false,
      match: (i) => i.status === 'review' },
    { key: 'epics', label: 'Epics', icon: 'workspaces', tree: false,
      match: (i) => i.type === 'epic' },
    { key: 'mine', label: 'On me', icon: 'person', tree: false,
      match: (i) => i.assignee === HUMAN_AUTHOR },
    { key: 'agent', label: `On ${AGENT_AUTHOR}`, icon: 'smart_toy', tree: false,
      match: (i) => i.assignee === AGENT_AUTHOR },
    { key: 'done', label: 'Done', icon: 'check_circle', tree: false,
      match: (i) => i.status === 'done' || i.status === 'dropped' },
];

export const DEFAULT_VIEW = 'board';

/** A view key (and optional phase) → the resolved view. Unknown keys degrade to
 *  the default: a restored tab from a previous release must never throw. */
export function resolveView(key, phase) {
    const v = BACKLOG_VIEWS.find((x) => x.key === key)
        || BACKLOG_VIEWS.find((x) => x.key === DEFAULT_VIEW);
    const inPhase = (i) => !phase || i.phaseLabel === phase;
    return {
        ...v,
        phase: phase || '',
        label: phase ? `${v.label} · ${phase}` : v.label,
        match: (i) => inPhase(i) && v.match(i),
    };
}

/**
 * Rows for a view, in the order they render.
 *
 * A tree view keeps ANCESTORS of every match even when the ancestor itself does
 * not match, flagged `context: true` — an epic that is `in-progress` while all
 * its stories are `draft` would otherwise show its children floating at the root
 * with nothing saying what they belong to. Flat views drop the hierarchy
 * entirely and render at depth 0.
 */
export function rowsFor(view) {
    const byId = new Map(ITEMS.map((i) => [Number(i.id), i]));
    const matched = ITEMS.filter(view.match);
    if (!view.tree) return matched.map((i) => ({ ...i, depth: 0, context: false }));

    const keep = new Set(matched.map((i) => i.id));
    for (const item of matched) {
        let cur = item;
        const seen = new Set([cur.id]);
        while (cur && Number(cur.parent) > 0) {
            const next = byId.get(Number(cur.parent));
            if (!next || seen.has(next.id)) break;
            seen.add(next.id);
            keep.add(next.id);
            cur = next;
        }
    }
    // ITEMS is already in tree order, so filtering it preserves that order.
    return ITEMS.filter((i) => keep.has(i.id)).map((i) => ({ ...i, context: !view.match(i) }));
}
