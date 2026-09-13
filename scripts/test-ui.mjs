/**
 * test-ui.mjs — the UI logic that a browser would otherwise be the only way to
 * exercise: the filter engine, the backlog tree builder, the per-type lifecycle
 * ladders, and the top-nav derivation that both the lit chip and the left rail
 * read.
 *
 * Run with `npm test` (which also runs check-graph.mjs and eslint).
 *
 * MODULE RESOLUTION. `ui/js` imports `@flexdesk/core` and `@flexdesk/wm` — bare
 * specifiers that `ui/index.html` maps to `ui/vendor/flexdesk/*.js` through an
 * import map. Node has no import map, so this file writes the equivalent as two
 * tiny alias packages into node_modules before importing anything. Same target
 * files, same bytes; only the resolution mechanism differs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BARE_KEY_RECORD, BARE_KEY_VALUES,
    COMMENT_HEADERS, HISTORY_APPEND_CHANGES, HISTORY_APPEND_EXPECTED, HISTORY_LINES,
    REF_TOKENS, REF_TOKENS_REJECTED_AFTER_MATCH,
} from './record-fixtures.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'ui', 'js', 'ticketdesk') + '/';
const TILING = join(ROOT, 'ui', 'js', 'tiling') + '/';

for (const name of ['core', 'wm']) {
    const dir = join(ROOT, 'node_modules', '@flexdesk', name);
    if (existsSync(join(dir, 'index.js'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'),
        JSON.stringify({ name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
    writeFileSync(join(dir, 'index.js'),
        `export * from '${join(ROOT, 'ui', 'vendor', 'flexdesk', `${name}.js`)}';\n`);
}

// The modules touch `localStorage` and `window` at import time.
const _store = new Map();
globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
};
globalThis.window = { __BUGDESK_CONFIG__: { humanAuthor: 'alice', agentAuthor: 'claude' } };

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

const { createFilterModel } = await import(UI + 'filter_engine.js');
const data = await import(UI + 'backlog_data.js');
const { activeTopNavKind, taxonomy: taxonomyDefault } = await import(TILING + 'kind_taxonomy.js');
const newItem = await import(UI + 'new_item.js');
const live = await import(UI + 'live.js');

/* ── the engine ──────────────────────────────────────────────────── */

console.log('\nfilter_engine');

const rows = [
    { id: 1, type: 'epic', status: 'in-progress', pts: 21, tags: ['core'], when: '2026-09-01' },
    { id: 2, type: 'story', status: 'draft', pts: 5, tags: ['core', 'ui'], when: '2026-09-05' },
    { id: 3, type: 'task', status: 'done', pts: 0, tags: [], when: '2026-09-09' },
];
const model = createFilterModel({
    noun: 'item',
    fields: [
        { key: 'type', label: 'Type', type: 'enum', options: ['epic', 'story', 'task'], get: (r) => r.type },
        { key: 'status', label: 'Status', type: 'enum', options: ['draft', 'in-progress', 'done'], get: (r) => r.status },
        { key: 'pts', label: 'Estimate', type: 'number', get: (r) => r.pts },
        { key: 'tags', label: 'Labels', type: 'set', get: (r) => r.tags },
        { key: 'when', label: 'Updated', type: 'date', get: (r) => r.when },
    ],
});
const clause = (field, op, value) => ({ kind: 'clause', field, op, value });
const and = (...c) => ({ kind: 'group', op: 'AND', children: c });
const or = (...c) => ({ kind: 'group', op: 'OR', children: c });
const sel = (expr) => rows.filter(model.matcherFor(expr)).map((r) => r.id);

t('empty group matches everything', () => assert.deepEqual(sel(model.emptyExpr()), [1, 2, 3]));
t('enum is', () => assert.deepEqual(sel(and(clause('type', 'is', 'story'))), [2]));
t('enum none_of', () => assert.deepEqual(sel(and(clause('status', 'none_of', ['done', 'draft']))), [1]));
t('number gt', () => assert.deepEqual(sel(and(clause('pts', 'gt', 4))), [1, 2]));
t('number between', () => assert.deepEqual(sel(and(clause('pts', 'between', [1, 10]))), [2]));
t('set contains', () => assert.deepEqual(sel(and(clause('tags', 'contains', 'ui'))), [2]));
t('set is_empty', () => assert.deepEqual(sel(and(clause('tags', 'is_empty'))), [3]));
t('date after', () => assert.deepEqual(sel(and(clause('when', 'after', '2026-09-04'))), [2, 3]));
t('OR group', () => assert.deepEqual(sel(or(clause('type', 'is', 'epic'), clause('type', 'is', 'task'))), [1, 3]));
t('negated group', () => {
    const e = and(clause('type', 'is', 'epic'));
    e.negate = true;
    assert.deepEqual(sel(e), [2, 3]);
});
t('describe reads as a sentence', () => assert.equal(
    model.describeFilter(and(clause('type', 'is', 'story'), clause('pts', 'gt', 3))),
    'Type is story AND Estimate > 3'));
t('validate rejects an unknown field', () => {
    const v = model.validateFilter(and(clause('nope', 'is', 'x')));
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /unknown field/);
});
t('validate rejects a missing value', () => {
    const v = model.validateFilter(and(clause('pts', 'gt', '')));
    assert.equal(v.ok, false);
});
t('two models do not share a matcher cache', () => {
    // Same expression JSON, different `get` — the cache key includes the model
    // id precisely so this cannot collide.
    const other = createFilterModel({
        fields: [{ key: 'type', label: 'Type', type: 'enum', get: () => 'task' }],
    });
    const expr = and(clause('type', 'is', 'task'));
    assert.deepEqual(rows.filter(model.matcherFor(expr)).map((r) => r.id), [3]);
    assert.deepEqual(rows.filter(other.matcherFor(expr)).map((r) => r.id), [1, 2, 3]);
});

/* ── the tree ────────────────────────────────────────────────────── */

console.log('\nbacklog_data.treeRows');

// Shape mirrors what the bridge returns, in tree order.
const raw = [
    { id: 1, type: 'epic', parent: 0, title: 'Epic A', status: 'in-progress', effectivePhase: 'p1', criteria: [] },
    { id: 2, type: 'story', parent: 1, title: 'Story A1', status: 'draft', effectivePhase: 'p1', criteria: [] },
    { id: 3, type: 'task', parent: 2, title: 'Task A1a', status: 'draft', effectivePhase: 'p1', criteria: [] },
    { id: 4, type: 'task', parent: 2, title: 'Task A1b', status: 'done', effectivePhase: 'p1', criteria: [] },
    { id: 5, type: 'story', parent: 1, title: 'Story A2', status: 'done', effectivePhase: 'p1', criteria: [] },
    { id: 6, type: 'epic', parent: 0, title: 'Epic B', status: 'draft', effectivePhase: 'p2', criteria: [] },
];
// loadBacklog() is what normally populates ITEMS; drive the mapper the same way
// by stubbing fetch, so the test exercises the real path.
globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/meta')
        ? { ok: true, phases: ['p1', 'p2'] }
        : { ok: true, items: raw }),
});
await data.loadBacklog();

const ids = (rs) => rs.map((r) => r.id);
const all = () => data.treeRows(() => true);

t('tree order is preserved', () => assert.deepEqual(ids(all()), [1, 2, 3, 4, 5, 6]));
t('depth is the nesting level', () => assert.deepEqual(all().map((r) => r.depth), [0, 1, 2, 2, 1, 0]));
t('isLast marks the last of each sibling set', () =>
    assert.deepEqual(all().map((r) => r.isLast), [false, false, false, true, true, true]));
t('hasChildren is true only for parents', () =>
    assert.deepEqual(all().map((r) => r.hasChildren), [true, true, false, false, false, false]));
t('epicRef resolves through the chain', () =>
    assert.deepEqual(all().map((r) => r.epicRef), ['EPIC-0001', 'EPIC-0001', 'EPIC-0001', 'EPIC-0001', 'EPIC-0001', 'EPIC-0006']));

t('a filtered tree keeps ancestors as context', () => {
    const rs = data.treeRows((i) => i.status === 'done');
    // Tasks 4 and story 5 match; epic 1 and story 2 are kept to hang them on.
    assert.deepEqual(ids(rs), [1, 2, 4, 5]);
    assert.deepEqual(rs.map((r) => r.context), [true, true, false, false]);
});

t('collapsing hides descendants and counts them', () => {
    const rs = data.treeRows(() => true, new Set([2]));
    assert.deepEqual(ids(rs), [1, 2, 5, 6]);
    const story = rs.find((r) => r.id === 2);
    assert.equal(story.isCollapsed, true);
    assert.equal(story.hidden, 2);
});

t('collapsing an epic hides the whole subtree', () => {
    const rs = data.treeRows(() => true, new Set([1]));
    assert.deepEqual(ids(rs), [1, 6]);
    assert.equal(rs.find((r) => r.id === 1).hidden, 4);
});

t('collapsing a leaf is a no-op', () => {
    assert.deepEqual(ids(data.treeRows(() => true, new Set([3]))), [1, 2, 3, 4, 5, 6]);
});

t('collapsibleIds lists only parents', () =>
    assert.deepEqual(data.collapsibleIds().sort((a, b) => a - b), [1, 2]));

/* ── per-type lifecycle ──────────────────────────────────────────── */

console.log('\nbacklog_data lifecycle');

t('each type walks its own ladder', () => {
    assert.deepEqual(data.ladderFor('epic'), ['draft', 'refined', 'in-progress', 'done']);
    assert.deepEqual(data.ladderFor('task'), ['draft', 'in-progress', 'done']);
    assert.deepEqual(data.ladderFor('story'), ['draft', 'refined', 'in-progress', 'review', 'done']);
});
t('an unknown type falls back to the full ladder', () =>
    assert.deepEqual(data.ladderFor('saga'), data.LADDERS.story));
t('stage indexes within the item\'s own ladder', () => {
    // in-progress is index 2 for a story but index 1 for a task.
    assert.equal(data.stageOf({ type: 'story', status: 'in-progress' }), 2);
    assert.equal(data.stageOf({ type: 'task', status: 'in-progress' }), 1);
});
t('a task is never offered "refined"', () => {
    const targets = data.stageActions({ type: 'task', status: 'draft' }).map(([, s]) => s);
    assert.ok(!targets.includes('refined'), `got ${targets}`);
    assert.ok(targets.includes('in-progress'));
});
t('an epic is never offered "review"', () => {
    const targets = data.stageActions({ type: 'epic', status: 'in-progress' }).map(([, s]) => s);
    assert.ok(!targets.includes('review'), `got ${targets}`);
    assert.ok(targets.includes('done'));
});
t('a story is', () => {
    const targets = data.stageActions({ type: 'story', status: 'in-progress' }).map(([, s]) => s);
    assert.ok(targets.includes('review'));
});
t('the terminal state offers Reopen, not "back to"', () => {
    const [[label]] = [data.stageActions({ type: 'task', status: 'done' })[0]];
    assert.equal(label, 'Reopen');
});
t('dropped offers only a way back', () =>
    assert.deepEqual(data.stageActions({ type: 'story', status: 'dropped' }), [['Restore to draft', 'draft']]));
t('a status off the type\'s ladder still offers a way back on', () => {
    // What a hand-edited file can produce: a task sitting in `review`.
    const targets = data.stageActions({ type: 'task', status: 'review' }).map(([, s]) => s);
    assert.ok(targets.includes('draft'), `got ${targets}`);
});


/** Minimal stand-in for the WM's desktop tree. */
const wmWith = ({ focused = null, primary = null, leaves = {} }) => ({
    desktops: {
        active: () => ({
            tree: {
                focusedLeafId: focused,
                primaryLeafId: () => primary,
                get: (id) => (leaves[id] ? { content: { kind: leaves[id] } } : null),
            },
        }),
    },
});

console.log('\nactiveTopNavKind');

t('a bug page resolves to the Bugs section', () =>
    assert.equal(activeTopNavKind(wmWith({ focused: 'a', leaves: { a: 'ticket' } })), 'queues'));
t('the queue itself resolves to Bugs', () =>
    assert.equal(activeTopNavKind(wmWith({ focused: 'a', leaves: { a: 'queues' } })), 'queues'));
t('a backlog item resolves to the Backlog section', () =>
    assert.equal(activeTopNavKind(wmWith({ focused: 'a', leaves: { a: 'item' } })), 'backlog'));
t('the backlog board itself resolves to Backlog', () =>
    assert.equal(activeTopNavKind(wmWith({ focused: 'a', leaves: { a: 'backlog' } })), 'backlog'));
t('home resolves to the first top-nav entry, not nothing', () =>
    assert.equal(activeTopNavKind(wmWith({ focused: 'a', leaves: { a: 'home' } })), 'queues'));

t('a focused PANEL is ignored in favour of the primary leaf', () => {
    // Otherwise the left rail asking "which section am I in" gets the answer
    // "the left rail" the moment it takes focus.
    const wm = wmWith({ focused: 'p', primary: 'm', leaves: { p: 'panel:left', m: 'item' } });
    assert.equal(activeTopNavKind(wm), 'backlog');
});
t('a window-placeholder is ignored the same way', () =>
    assert.equal(activeTopNavKind(wmWith({
        focused: 'w', primary: 'm', leaves: { w: 'window-placeholder', m: 'ticket' },
    })), 'queues'));
t('focus wins over the primary leaf', () => {
    const wm = wmWith({ focused: 'f', primary: 'm', leaves: { f: 'item', m: 'ticket' } });
    assert.equal(activeTopNavKind(wm), 'backlog');
});
t('nothing resolvable yields null, not a wrong guess', () => {
    assert.equal(activeTopNavKind(null), null);
    assert.equal(activeTopNavKind(wmWith({})), null);
});


/* ── the New item dialog's adaptive fields ───────────────────────── */

console.log('\nnew_item field adaptation');

// `fieldsFor`, not the raw FIELDS_FOR table: `parent` is DERIVED from the
// hierarchy rules rather than listed per kind, so the table alone no longer
// says what the form draws.
const ORDER = ['severity', 'parent', 'phase', 'points', 'due', 'acceptance'];
const visible = (kindId) => {
    const f = newItem.fieldsFor(kindId);
    return ORDER.filter((k) => f[k]);
};

t('a bug is asked for a severity and nothing backlog-shaped', () =>
    assert.deepEqual(visible('bug'), ['severity']));
t('regression and chore match bug', () => {
    assert.deepEqual(visible('regression'), ['severity']);
    assert.deepEqual(visible('chore'), ['severity']);
});
t('an epic is asked for a phase, and for no parent outside tracker mode', () =>
    assert.deepEqual(visible('epic'), ['phase', 'points', 'due', 'acceptance']));
t('a story is asked for a parent, never a phase', () =>
    assert.deepEqual(visible('story'), ['parent', 'points', 'due', 'acceptance']));
t('a task matches a story', () =>
    assert.deepEqual(visible('task'), ['parent', 'points', 'due', 'acceptance']));
t('every backlog kind that has acceptance criteria is asked for them', () => {
    // A task does NOT inherit its parent's, so it is asked like anything else.
    for (const k of ['epic', 'story', 'task']) {
        assert.ok(visible(k).includes('acceptance'), `${k} cannot be given criteria`);
    }
    // A project is the exception: it is a container, and what "done" means for
    // it is that the work inside it is done.
    for (const k of ['bug', 'regression', 'chore']) {
        assert.ok(!visible(k).includes('acceptance'), `${k} offers acceptance criteria`);
    }
});
t('every backlog kind can carry a target date', () => {
    for (const k of ['epic', 'story', 'task']) {
        assert.ok(visible(k).includes('due'), `${k} cannot be given a target date`);
    }
});
t('no bug kind is offered a target date', () => {
    // `due` lives on backlog records only — Bug.cs has no such field, so a
    // date entered here would be silently dropped on save.
    for (const k of ['bug', 'regression', 'chore']) {
        assert.ok(!visible(k).includes('due'), `${k} offers a target date`);
    }
});
t('no backlog kind is ever asked for a severity', () => {
    for (const k of ['epic', 'story', 'task']) {
        assert.ok(!visible(k).includes('severity'), `${k} offers severity`);
    }
});
t('no bug kind is ever asked for a parent, phase or estimate', () => {
    for (const k of ['bug', 'regression', 'chore']) {
        assert.deepEqual(visible(k), ['severity'], `${k} offers backlog fields`);
    }
});
t('every kind in the Type select has a field map', () => {
    for (const k of newItem.KINDS) {
        assert.ok(newItem.FIELDS_FOR[k.id], `${k.id} has no FIELDS_FOR entry`);
    }
});
t('the kinds route to the two stores', () => {
    const byStore = {};
    for (const k of newItem.KINDS) (byStore[k.store] ??= []).push(k.id);
    assert.deepEqual(byStore.bugs, ['bug', 'regression', 'chore']);
    assert.deepEqual(byStore.backlog, ['epic', 'story', 'task']);
});
t('the default kind is one this deployment actually offers', () =>
    // openNewItem() with no kind opens on KINDS[0]; a hardcoded 'bug' would
    // open the tracker's mask on a type that is not in its own select.
    assert.ok(newItem.KINDS.some((k) => k.id === newItem.KINDS[0].id)));
t('Project is not offered outside tracker mode', () =>
    assert.equal(newItem.KINDS.some((k) => k.id === 'project'), false));
t('Chore is stored as the bug type `task`', () =>
    assert.equal(newItem.KINDS.find((k) => k.id === 'chore').value, 'task'));

/* ── target dates ────────────────────────────────────────────────────
 *
 * The axis tracker mode turns on. `dueState` is read by the dashboard, by the
 * board's Due column and by the `dueState` filter field, so getting it wrong is
 * wrong in three places at once — and the two states that are NOT about the
 * schedule (`none`, `done`) are the ones a naive date comparison gets wrong. */

console.log('\ntarget dates');

const TODAY = '2026-09-10';
const withDue = (due, status = 'in-progress') => ({ due, status });

t('a date in the past is overdue', () =>
    assert.equal(data.dueState(withDue('2026-09-01'), TODAY), 'overdue'));
t('today is its own state', () =>
    assert.equal(data.dueState(withDue(TODAY), TODAY), 'today'));
t('inside a week is due soon', () =>
    assert.equal(data.dueState(withDue('2026-09-16'), TODAY), 'soon'));
t('the seventh day is still soon, the eighth is not', () => {
    assert.equal(data.dueState(withDue('2026-09-17'), TODAY), 'soon');
    assert.equal(data.dueState(withDue('2026-09-18'), TODAY), 'later');
});
t('no date is `none`, never "on time"', () => {
    // The whole point: an undated item must not read as healthy. It is the gap
    // the dashboard has a section for.
    assert.equal(data.dueState(withDue(''), TODAY), 'none');
    assert.equal(data.dueState({ status: 'draft' }, TODAY), 'none');
});
t('a malformed date reads as no date rather than as overdue', () =>
    assert.equal(data.dueState(withDue('next tuesday'), TODAY), 'none'));
t('a closed item is off the schedule however old its date', () => {
    // A date that passed AFTER the work was delivered must not burn red forever.
    assert.equal(data.dueState(withDue('2020-01-01', 'done'), TODAY), 'done');
    assert.equal(data.dueState(withDue('2020-01-01', 'dropped'), TODAY), 'done');
});
t('lateness is counted in whole days', () => {
    assert.equal(data.daysBetween(TODAY, '2026-09-13'), 3);
    assert.equal(data.daysBetween(TODAY, '2026-09-07'), -3);
    assert.equal(data.daysBetween(TODAY, TODAY), 0);
});
t('a day count survives a DST boundary', () => {
    // Local midnights are 23 or 25 hours apart twice a year; a naive
    // (b - a) / 86400000 on local dates floors those to the wrong day.
    assert.equal(data.daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(data.daysBetween('2026-10-24', '2026-10-26'), 2);
});
t('the phrase names the number of days, not the date', () => {
    assert.equal(data.duePhrase(withDue('2026-09-07'), TODAY), '3 days late');
    assert.equal(data.duePhrase(withDue('2026-09-11'), TODAY), 'in 1 day');
    assert.equal(data.duePhrase(withDue(TODAY), TODAY), 'due today');
    assert.equal(data.duePhrase(withDue(''), TODAY), 'no target date');
});
t('todayISO is the local date, zero-padded', () =>
    assert.equal(data.todayISO(new Date(2026, 8, 3, 23, 30)), '2026-09-03'));

/* ── inherited target dates ──────────────────────────────────────── */

console.log('\ninherited target dates');

t('an own date beats an inherited one', () => {
    assert.equal(data.dueOf({ due: '2026-09-10', effectiveDue: '2026-09-20' }), '2026-09-10');
});
t('an empty date falls back to the inherited one', () => {
    // A task under a story due on the 14th IS due on the 14th; reporting it as
    // undated puts it in the "needs a date" pile when somebody has said when.
    assert.equal(data.dueOf({ due: '', effectiveDue: '2026-09-14' }), '2026-09-14');
    assert.equal(data.dueState({ due: '', effectiveDue: '2026-09-14', status: 'draft' }, TODAY), 'soon');
});
t('neither is still `none`', () =>
    assert.equal(data.dueState({ due: '', effectiveDue: '', status: 'draft' }, TODAY), 'none'));

/* ── a sub-item that overruns its parent ─────────────────────────── */

console.log('\ndue overruns');

const tree = (rows) => new Map(rows.map((r) => [Number(r.id), r]));
const PARENTED = tree([
    { id: 1, parent: 0, due: '2026-09-14', status: 'in-progress' },
    { id: 2, parent: 1, due: '2026-09-20', status: 'in-progress' },   // overruns #1
    { id: 3, parent: 1, due: '', effectiveDue: '2026-09-14', status: 'draft' },
    { id: 4, parent: 2, due: '2026-09-25', status: 'draft' },         // overruns #1 via #2
    { id: 5, parent: 1, due: '2026-09-30', status: 'done' },          // closed
    { id: 6, parent: 1, due: '2026-09-14', status: 'draft' },         // equal, not after
]);
const over = (id) => data.dueOverrun(PARENTED.get(id), PARENTED);

t('a child dated after its parent is flagged', () =>
    assert.equal(over(2)?.id, 1));
t('the NEAREST overrun ancestor is the one named', () =>
    // #4 is after both #2 (the 20th) and #1 (the 14th); #2 is what to go and fix.
    assert.equal(over(4)?.id, 2));
t('an inherited date never overruns — it IS the ancestor\'s', () =>
    assert.equal(over(3), null));
t('a closed item is not flagged; its date is history', () =>
    assert.equal(over(5), null));
t('the same date is not "after" it', () =>
    assert.equal(over(6), null));
t('a top-level item has nothing to overrun', () =>
    assert.equal(over(1), null));

/* ── the project level ───────────────────────────────────────────── */

console.log('\nproject type');

t('a project file is PROJ-, not PROJECT-', () => {
    // The reference is derived from a TABLE, not by upper-casing the type —
    // it has to match the filename the bridge writes (BacklogItem.Prefixes).
    assert.equal(data.itemRef({ type: 'project', id: 4 }), 'PROJ-0004');
    assert.equal(data.itemRef({ type: 'epic', id: 4 }), 'EPIC-0004');
    assert.equal(data.itemRef({ type: 'story', id: 12 }), 'STORY-0012');
    assert.equal(data.itemRef({ type: 'task', id: 7 }), 'TASK-0007');
});
t('a project is never refined and never reviewed', () => {
    // It is a container: no acceptance criteria of its own to refine, and its
    // stories are what get reviewed, one at a time.
    assert.deepEqual(data.ladderFor('project'), ['draft', 'in-progress', 'done']);
    assert.ok(!data.ladderFor('project').includes('refined'));
    assert.ok(!data.ladderFor('project').includes('review'));
});
t('a project never offers a refinement transition', () => {
    const targets = data.stageActions({ type: 'project', status: 'draft' }).map(([, s]) => s);
    assert.ok(!targets.includes('refined'), `project offered ${targets.join(', ')}`);
});
t('a project is exempt from the parent refinement rule', () => {
    const rule = data.REFINEMENT_RULES.find((r) => r.key === 'parent');
    assert.equal(rule.test({ type: 'project', parent: 0 }), true);
    assert.equal(rule.test({ type: 'epic', parent: 0 }), true);
    assert.equal(rule.test({ type: 'story', parent: 0 }), false);
});
t('every type the store can hold has a ladder, a label and a prefix', () => {
    for (const type of data.ALL_TYPES) {
        assert.ok(data.LADDERS[type], `${type} has no ladder`);
        assert.ok(data.TYPE_LABEL[type], `${type} has no label`);
        assert.ok(data.TYPE_PREFIX[type], `${type} has no file prefix`);
        assert.ok(data.TYPE_ICON[type], `${type} has no icon`);
    }
});
t('a plain backlog offers three types; the store still knows four', () => {
    assert.deepEqual(data.TYPES, ['epic', 'story', 'task']);
    assert.deepEqual(data.ALL_TYPES, ['project', 'epic', 'story', 'task']);
    assert.equal(data.TRACKER, false);
});
t('every page declares the section it lives in', () => {
    // The WM groups a tile's tabs by `topNavFor(kind)`, a SINGLE hop. A kind
    // that returns undefined — or one that disagrees with the page it sits
    // beside — makes openInPrimary a cross-page swap, which archives the tabs
    // and DROPS the props it was handed. That is invisible until something
    // routes by props, and then it looks like a click doing nothing.
    for (const kind of ['home', 'queues', 'ticket', 'backlog', 'item', 'new-item']) {
        assert.ok(taxonomyDefault.topNavFor(kind), `${kind} declares no section`);
    }
    assert.equal(taxonomyDefault.topNavFor('home'), 'queues', 'home is not with the page it renders');
    assert.equal(taxonomyDefault.topNavFor('item'), taxonomyDefault.topNavFor('backlog'));
    assert.equal(taxonomyDefault.topNavFor('ticket'), taxonomyDefault.topNavFor('queues'));
});
t('the default mode has no Tracker chip', () =>
    // The tracker-mode counterpart of this lives in test-tracker.mjs, which
    // runs in its own process — the mode is read once, at module load.
    assert.deepEqual(taxonomyDefault.topNavEntries().map((e) => e.kind), ['queues', 'backlog']));

/* ── the comment-header regex ────────────────────────────────────────
 *
 * The pattern lives in C# and nothing in this harness can execute C#, so it is
 * read OUT of `server/Markdown.cs` and run here as a JS `RegExp`. Node supports
 * `(?<name>…)` verbatim and only `RegexOptions.Multiline` has to be mapped, so
 * the two engines agree on everything these fixtures exercise.
 *
 * THE BUG THIS PINS. `_` was in the author's negated character class, so
 * `hans_agent` — exactly the shape `ProjectConfig.AgentNameFor` generates —
 * matched as far as `hans` and then the header matched NOTHING at all. The
 * comment did not render as a bad comment; it vanished, its text absorbed into
 * the previous comment's body, the count wrong, and the record silently dropped
 * out of "Needs my reply". It shipped because a stated rule had no runner.
 */

console.log('\nthe comment-header regex');

const cs = (file) => readFileSync(join(ROOT, 'server', file), 'utf8');
/** Lift one `Name = new(@"…")` pattern out of a C# source file. §3.1 of the spec
 *  binds that declaration layout — and bans `"` inside the pattern — for exactly
 *  this reason. */
const lift = (src, name, flags = '') =>
    new RegExp(new RegExp(`(?:^|\\s)${name}\\s*=\\s*\\n?\\s*new\\(@"([^"]+)"`).exec(src)[1], flags);
// `Fields` is a string[], not a Regex, so it needs the SECOND extractor. Without
// it the history section below would have to hardcode the field names and would
// stop being a drift test at all.
const liftFields = (src) =>
    /Fields\s*=\s*\{([^}]*)\}/.exec(src)[1]
        .split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);

const HDR = lift(cs('Markdown.cs'), 'CommentHdr', 'm');

for (const [input, expected] of COMMENT_HEADERS) {
    t(`header: ${JSON.stringify(input)}`, () => {
        const m = HDR.exec(input);
        if (expected === null) {
            assert.equal(m, null, `matched, and should not have: ${JSON.stringify(m?.groups)}`);
            return;
        }
        assert.ok(m, 'did not match at all — the comment would VANISH into the one above it');
        assert.equal(m.groups.author, expected);
    });
}

/* ── the history line grammar ────────────────────────────────────────
 *
 * `RecordHistory.Parse`'s decision, re-implemented over patterns lifted from
 * `server/RecordHistory.cs` — same inputs on both sides of the language line.
 *
 * The rule worth stating out loud: a line that does not fit the grammar becomes
 * a NOTE, never nothing. Dropping a line a person can read is the same failure
 * class as the comment-header bug above.
 */

console.log('\nthe history line grammar');

const HIST_SRC = cs('RecordHistory.cs');
const ENTRY = lift(HIST_SRC, 'EntryLine');
const CHANGE = lift(HIST_SRC, 'Change');
const PLACEHOLDER = lift(HIST_SRC, 'Placeholder');
const BULLET = lift(HIST_SRC, 'Bullet');
const FIELDS = liftFields(HIST_SRC);

const hide = (v) => { const s = String(v ?? '').trim(); return s === '(unset)' ? '' : s; };
const row = (o) => ({ date: '', actor: '', field: '', from: '', to: '', note: '', ...o });

/** One line of a `## History` section, as `RecordHistory.Parse` reads it.
 *  `null` where Parse emits no row at all. */
const parseHistoryLine = (raw) => {
    const line = String(raw).trim();
    if (line.length === 0) return null;
    if (line.startsWith('#')) return null;                  // a heading
    if (PLACEHOLDER.test(line)) return null;                // "_(nothing yet)_"
    const m = ENTRY.exec(line);
    if (!m) return row({ note: line.replace(BULLET, '').trim() });
    const { date, actor, rest } = m.groups;
    const c = CHANGE.exec(rest.trim());
    const field = c ? c.groups.field.toLowerCase() : '';
    return c && FIELDS.includes(field)
        ? row({ date, actor: actor.trim(), field, from: hide(c.groups.from), to: hide(c.groups.to) })
        : row({ date, actor: actor.trim(), note: rest.trim() });
};

t('`Fields` is the only definition of what a history records', () =>
    // Invariant 6, and also the guard that the lift worked at all: a silently
    // empty lift would make every assertion below vacuous.
    assert.deepEqual(FIELDS, ['status', 'assignee', 'reporter']));

console.log('\nreading one frontmatter value');

/* `Md.GetFrontmatter` builds its pattern by interpolating the key, so it cannot
 * be lifted by name like the standalone regexes above. Lift the FORMAT STRING and
 * substitute the key, which exercises the real pattern rather than a copy of it. */
const gfTemplate = /GetFrontmatter[\s\S]*?new Regex\(\$@"([^"]+)"\)/.exec(cs('Markdown.cs'))[1];
const getFrontmatter = (text, key) => {
    const src = gfTemplate.replace('{Regex.Escape(key)}', key).replace(/^\(\?m\)/, '');
    const m = new RegExp(src, 'm').exec(text);
    return m ? m[1].trim().replace(/^"|"$/g, '') : null;
};

for (const [key, expected] of BARE_KEY_VALUES) {
    t(`frontmatter: ${key} on a hand-written record`, () =>
        // An empty key must read as "", never as the NEXT line. When it read the
        // next line, `## History` recorded "assignee: reporter: -> hans_agent" and
        // a duplicate-of merge wrote "created: 2026-09-01" into the record's links.
        assert.equal(getFrontmatter(BARE_KEY_RECORD, key), expected));
}

t('the frontmatter gap never crosses a line', () =>
    // The rule behind every assertion above, stated where a future edit will see it.
    assert.ok(!/:\\s\*/.test(gfTemplate),
        `GetFrontmatter uses \\s* after the colon, which matches a newline: ${gfTemplate}`));

t('every lifted pattern is free of double-quote characters', () => {
    // §3.1's declaration rule. A `"` inside any of these patterns truncates the
    // lift above, and the drift tests then run a DIFFERENT regex than the server.
    for (const [name, re] of [['EntryLine', ENTRY], ['Change', CHANGE],
                              ['CommentHdr', HDR], ['Token', lift(cs('RecordRef.cs'), 'Token')]]) {
        assert.ok(!re.source.includes('"'), `${name} carries a quote character`);
    }
});

t('a flush-left `status:` line is NOT an entry — that is what the bullet prevents', () => {
    // `Md.GetFrontmatter` and `Md.SetFrontmatter` both match `(?m)^key:` over the
    // WHOLE document, so a history line written without its `- ` would be read as
    // the record's real status and then overwritten by the next patch.
    assert.equal(ENTRY.test('status: open -> investigation'), false);
    assert.equal(/^status:.*$/m.test('status: open -> investigation'), true);
});

for (const [input, expected] of HISTORY_LINES) {
    t(`history line: ${JSON.stringify(input)}`, () =>
        assert.deepEqual(parseHistoryLine(input), expected === null ? null : row(expected)));
}

/* ── appending history is idempotent in layout ───────────────────────
 *
 * Invariant 8, which nothing else in this change set asserts.
 *
 * This is a PORT of `RecordHistory.Append`'s control flow, not a lift of a
 * pattern: the layout rule is branching, not a regex, and nothing here can
 * execute C#. That makes the port drifting from `RecordHistory.cs` this test's
 * one real weakness, which is why both are kept short enough to read side by
 * side. The regression it pins — an extra blank line accumulating per append —
 * is invisible until the write AFTER the one that introduced it.
 */

console.log('\nappending history');

const HEADING = '## History';
const show = (v) => (String(v ?? '').trim() === '' ? '(unset)' : String(v).trim());
const historyLine = (date, actor, c) =>
    `- ${date} · ${actor.trim()} · ${c.field}: ${show(c.from)} -> ${show(c.to)}`;
const fieldOrder = (f) => Math.max(0, FIELDS.indexOf(f));

/** `Md.NextH2Index`. The sticky `g` with `m` is what makes `^` anchor against the
 *  WHOLE string from an offset, the way .NET's `Regex.Match(text, from)` does;
 *  slicing first would let `^` match mid-line. */
const nextH2Index = (text, from) => {
    const re = /^##\s/gm;
    re.lastIndex = from;
    const m = re.exec(text);
    return m ? m.index : -1;
};

const appendHistory = (text, date, actor, changes) => {
    const rows = changes.filter((c) => String(c.from ?? '').trim() !== String(c.to ?? '').trim())
        .slice().sort((a, b) => fieldOrder(a.field) - fieldOrder(b.field));
    if (rows.length === 0) return text;
    const added = rows.map((c) => historyLine(date, actor, c) + '\n').join('');

    const ci = text.indexOf('## Comments');
    const head = ci < 0 ? text : text.slice(0, ci);
    const at = head.toLowerCase().indexOf(HEADING.toLowerCase());

    if (at < 0) {
        const block = HEADING + '\n\n' + added;
        return ci >= 0 ? text.slice(0, ci) + block + '\n' + text.slice(ci)
                       : text.replace(/\s+$/, '') + '\n\n' + block;
    }

    const bodyStart = at + HEADING.length;
    const next = nextH2Index(text, bodyStart);
    const bodyEnd = next < 0 ? text.length : next;
    let body = text.slice(bodyStart, bodyEnd).trim();
    if (PLACEHOLDER.test(body)) body = '';
    const kept = body.length === 0 ? '' : body + '\n';
    return text.slice(0, bodyStart) + '\n\n' + kept + added + (next < 0 ? '' : '\n') + text.slice(bodyEnd);
};

const RECORD_HEAD = '---\nid: 42\nstatus: open\n---\n\n## Description\n\nSomething broke.\n\n';
const RECORD_TAIL = '## Comments\n\n### 2026-09-12 · a\n\nTaking this on.\n';
const RECORD = RECORD_HEAD + RECORD_TAIL;
const DATE = '2026-09-12';

const oneAtATime = HISTORY_APPEND_CHANGES.reduce(
    (text, c) => appendHistory(text, DATE, 'a', [c]), RECORD);
const allAtOnce = appendHistory(RECORD, DATE, 'a', HISTORY_APPEND_CHANGES);

t('four appends, one change each, land exactly the expected section', () =>
    assert.equal(oneAtATime, RECORD_HEAD + HISTORY_APPEND_EXPECTED + '\n\n' + RECORD_TAIL));
t('one append of all four changes is byte-identical', () =>
    assert.equal(allAtOnce, oneAtATime));
t('a fifth entry lands the same on both', () => {
    // The accumulating blank line only shows up on the write AFTER the one that
    // introduced it, so comparing the two documents once is not enough.
    const fifth = [{ field: 'status', from: 'testing', to: 'closed' }];
    assert.equal(appendHistory(oneAtATime, DATE, 'a', fifth),
        appendHistory(allAtOnce, DATE, 'a', fifth));
});
t('a change that changes nothing writes no line', () =>
    // A history of no-ops hides the real changes in the noise.
    assert.equal(appendHistory(RECORD, DATE, 'a', [{ field: 'status', from: 'open', to: 'open' }]),
        RECORD));

/* ── references ──────────────────────────────────────────────────────
 *
 * One reference grammar, written twice — `Refs.Token` in C# and `REF_RE` in
 * refs.js — because the server resolves a link target and the browser renders
 * one. Both halves run over the same fixture list.
 */

console.log('\nreferences');

const refs = await import(UI + 'refs.js');
const records = await import(UI + 'records.js');
const links = await import(UI + 'links.js');
const history = await import(UI + 'history.js');

const TOKEN = lift(cs('RecordRef.cs'), 'Token');

for (const [token, selfStore, expected] of REF_TOKENS) {
    t(`ref: ${JSON.stringify(token)} in ${selfStore}`, () => {
        const got = refs.parseRef(token, selfStore);
        if (expected === null) {
            assert.equal(got, null, `resolved to ${JSON.stringify(got)}`);
            return;
        }
        assert.ok(got, 'did not parse');
        assert.equal(got.store, expected.store);
        assert.equal(got.id, expected.id);
    });
}

t('the C# token pattern agrees with the JS twin on every fixture', () => {
    for (const [token, , expected] of REF_TOKENS) {
        const m = TOKEN.exec(token);
        if (expected === null) {
            // Three of the rejected tokens MATCH the pattern and are rejected
            // afterwards, by a lookup the pattern cannot express — see below.
            if (REF_TOKENS_REJECTED_AFTER_MATCH.includes(token)) continue;
            assert.equal(m, null, `${JSON.stringify(token)} matched and should not have`);
            continue;
        }
        assert.ok(m, `${JSON.stringify(token)} did not match`);
        assert.equal(Number(m.groups.n ?? m.groups.pn), expected.id);
    }
});

t('an unknown prefix and a zero id are rejected by the LOOKUP, not the pattern', () => {
    // Stated explicitly so nobody "fixes" the regex: `WIDGET-1` is well-formed and
    // names no store, which is a 400 the caller can be told about, while `STORY-9`
    // parses and 404s. `BacklogItem.Prefixes` stays the single definition of what a
    // prefix means.
    for (const token of REF_TOKENS_REJECTED_AFTER_MATCH) {
        assert.ok(TOKEN.test(token), `${token} no longer matches the pattern`);
        assert.equal(refs.parseRef(token, 'bugs'), null, `${token} resolved to something`);
    }
});

t('the stored form is bare in its own store and prefixed when it crosses', () => {
    assert.equal(refs.formatRef(refs.bugRef(47), 'bugs'), '47');
    assert.equal(refs.formatRef({ store: 'backlog', id: 7, type: 'story' }, 'bugs'), 'STORY-0007');
    assert.equal(refs.formatRef({ store: 'bugs', id: 7 }, 'backlog'), 'BUG-0007');
});
t('the displayed form is how each store names itself', () => {
    assert.equal(refs.displayRef(refs.bugRef(42)), '#42');
    assert.equal(refs.displayRef({ store: 'backlog', id: 7, type: 'epic' }), 'EPIC-0007');
});
t('identity is store AND id', () => {
    // Ids collide across the two stores by design — BUG-0007 and STORY-0007 both
    // exist — so matching on the number alone points at the wrong record.
    assert.equal(refs.sameRef({ store: 'bugs', id: 7 }, { store: 'backlog', id: 7 }), false);
    assert.equal(refs.sameRef({ store: 'bugs', id: 7 }, { store: 'bugs', id: 7 }), true);
});
t('a ref round-trips through its key', () => {
    assert.equal(refs.refKey(refs.bugRef(7)), 'bugs:7');
    const back = refs.parseKey('backlog:7');
    assert.equal(back.store, 'backlog');
    assert.equal(back.id, 7);
    assert.equal(refs.parseKey('nonsense'), null);
});

/* ── links ───────────────────────────────────────────────────────────
 *
 * A link target is a REF, not a number. The four legacy tokens in the shipped
 * sample store — `blocked-by 3`, `blocked-by 7`, `related 5`, `related 10` —
 * parsed as nothing and rendered as nothing before this vocabulary existed, with
 * nothing anywhere reporting a problem.
 */

console.log('\nlinks');

const targetOf = (l) => (l ? { store: l.target.store, id: l.target.id } : null);

t('a bare target is store-relative', () => {
    assert.deepEqual(targetOf(links.parseLink('blocks 47')), { store: 'bugs', id: 47 });
    assert.deepEqual(targetOf(links.parseLink('blocks 12', 'backlog')), { store: 'backlog', id: 12 });
});
t('padded and unpadded cross-store targets are the same record', () => {
    assert.deepEqual(targetOf(links.parseLink('implements STORY-7')), { store: 'backlog', id: 7 });
    assert.deepEqual(targetOf(links.parseLink('implements STORY-0007')), { store: 'backlog', id: 7 });
    assert.deepEqual(targetOf(links.parseLink('relates-to BUG-0042', 'backlog')), { store: 'bugs', id: 42 });
});
t('the four legacy tokens on disk parse', () => {
    // This is the drift check that would have caught them being dropped on read.
    assert.deepEqual(links.parseLink('related 10'),
        { type: 'relates-to', target: refs.parseRef('10', 'bugs') });
    assert.deepEqual(links.parseLink('related 5').type, 'relates-to');
    assert.equal(links.parseLink('blocked-by 3').type, 'blocked-by');
    assert.equal(links.parseLink('blocked-by 7').type, 'blocked-by');
});
t('an unparseable token is skipped, never guessed at', () => {
    assert.equal(links.parseLink('blocks WIDGET-3'), null);
    assert.equal(links.parseLink('frobnicates 3'), null);
    assert.equal(links.parseLink('STORY-7'), null);          // no verb
});
t('formatting writes the canonical token', () => {
    assert.equal(links.formatLink('blocks', refs.bugRef(47), 'bugs'), 'blocks 47');
    assert.equal(links.formatLink('implements', { store: 'backlog', id: 7, type: 'story' }, 'bugs'),
        'implements STORY-0007');
    // The legacy two-argument numeric call still works.
    assert.equal(links.formatLink('blocks', 47), 'blocks 47');
});
t('outgoing links carry the token EXACTLY as stored', () => {
    // `[data-unlink]` addresses a link by its raw token: `related 5` does not
    // round-trip through formatLink, so a re-formatted token would make Remove a
    // silent no-op on precisely the legacy records this vocabulary rescues.
    const out = links.outgoingLinks({ links: ['related 5', 'blocks #47'] }, 'bugs');
    assert.deepEqual(out.map((l) => l.raw), ['related 5', 'blocks #47']);
    assert.deepEqual(out.map((l) => l.type), ['relates-to', 'blocks']);
});

const rowFor = (store, id, linkTokens) => (store === 'bugs'
    ? records.bugRow({ bugId: id, summary: `bug ${id}`, status: 'Open', rawStatus: 'open', links: linkTokens })
    : records.itemRow({ id, type: 'story', title: `story ${id}`, status: 'draft', links: linkTokens }));

t('an inbound link does not cross the store line by accident', () => {
    // The collision test, mirroring live.eventTouches: a backlog item saying
    // `blocks 3` means backlog item 3, never bug #3.
    const rows = [rowFor('backlog', 9, ['blocks 3']), rowFor('bugs', 3, [])];
    assert.deepEqual(links.incomingLinks(refs.bugRef(3), rows), []);
    assert.equal(links.incomingLinks({ store: 'backlog', id: 3 }, rows).length, 1);
});
t('a pair this record already asserts is not drawn twice', () => {
    // BUG-0003 says `blocks 6` and BUG-0006 says `blocked-by 3`: both directions
    // are on disk, so the derived row has to yield to the authored one.
    const rows = [rowFor('bugs', 3, ['blocks 6']), rowFor('bugs', 6, ['blocked-by 3'])];
    const { outgoing, incoming } = links.linkRows(
        { links: ['blocked-by 3'] }, refs.bugRef(6), 'bugs', rows);
    assert.equal(outgoing.length, 1);
    assert.deepEqual(incoming, []);
});
t('a DIFFERENT relationship with the same record is still drawn', () => {
    // The mirror check keys on the STATEMENT, not just the target. Keying on the
    // target alone meant one authored link to a record hid every derived row from
    // that record — so adding `implements STORY-0008` to a bug silently erased the
    // "is blocked by STORY-0008" row, and since only the authored direction is ever
    // stored, the blocking relationship then showed nowhere on the blocked record.
    const rows = [rowFor('backlog', 8, ['blocks BUG-0006'])];
    const { incoming } = links.linkRows(
        { links: ['implements STORY-0008'] }, refs.bugRef(6), 'bugs', rows);
    assert.deepEqual(incoming.map((l) => l.type), ['is-blocked-by']);
});
t('removing a link removes every spelling of it', () => {
    // Two tokens naming one relationship collapse into ONE row, so removing only
    // the exact string the row was labelled with left the other behind and the
    // click read as a no-op.
    assert.deepEqual(links.withoutLink(['related 5', 'relates-to 5', 'blocks 9'], 'related 5', 'bugs'),
        ['blocks 9']);
    // A token nothing can parse is compared as text, so it stays removable.
    assert.deepEqual(links.withoutLink(['nonsense here', 'blocks 9'], 'nonsense here', 'bugs'),
        ['blocks 9']);
});
t('a new link is validated before it is written', () => {
    const record = { links: ['blocks 47'] };
    const self = refs.bugRef(42);
    assert.match(links.validateNewLink(record, self, 'frobnicates', refs.bugRef(9), 'bugs'),
        /Unknown relationship/);
    assert.equal(links.validateNewLink(record, self, 'blocks', null, 'bugs'),
        'Pick a ticket to link to.');
    assert.match(links.validateNewLink(record, self, 'blocks', refs.bugRef(42), 'bugs'),
        /cannot be linked to itself/);
    assert.match(links.validateNewLink(record, self, 'blocks', refs.bugRef(47), 'bugs'),
        /already exists/);
    // The same id in the OTHER store names a different record and is accepted.
    assert.equal(links.validateNewLink(record, self,
        'blocks', { store: 'backlog', id: 42, type: 'story' }, 'bugs'), null);
});

/* ── the history pane ────────────────────────────────────────────────
 *
 * Newest first, the same direction the Comments pane it shares a section with
 * reads. The "filed" row is DERIVED from `created` and `reporter` and never
 * stored: the file already says both, and a second copy can disagree with the
 * first.
 */

console.log('\nthe history pane');

const entry = (date, field, from, to) => ({ date, actor: 'a', field, from, to, note: '' });

t('the stored rows read newest first, with the derived "filed" row last', () => {
    const rows = history.historyRows({
        created: '2026-09-01',
        reporter: 'norman',
        history: [entry('2026-09-02', 'status', 'open', 'investigation'),
                  entry('2026-09-03', 'assignee', '', 'priya'),
                  entry('2026-09-04', 'status', 'investigation', 'testing')],
    });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.date),
        ['2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01']);
    assert.equal(rows.at(-1).synthetic, true);
    assert.equal(rows.slice(0, 3).every((r) => r.synthetic === false), true);
});
t('a record with nothing recorded says so, rather than drawing an empty box', () => {
    assert.deepEqual(history.historyRows({ history: [], created: '' }), []);
    assert.match(history.historyHTML([]), /td-empty/);
});
t('a note renders as prose, with no arrow pair', () => {
    const html = history.historyHTML(history.historyRows({
        history: [{ date: '2026-09-02', actor: 'a', field: '', from: '', to: '', note: 'reopened by hand' }],
    }));
    assert.match(html, /reopened by hand/);
    assert.ok(!/<b>/.test(html), `a note rendered as a transition: ${html}`);
});
t('an unrecorded reporter is said, not guessed', () =>
    assert.match(history.historyHTML(history.historyRows({ created: '2026-09-01', history: [] })),
        /reporter unrecorded/));
t('every interpolated value is escaped', () => {
    // A history line is text somebody typed into a .md file by hand.
    const html = history.historyHTML(history.historyRows({
        history: [{ date: 'x', actor: '<img src=x>', field: '', from: '', to: '', note: 'n' }],
    }));
    assert.ok(!html.includes('<img'), `unescaped markup: ${html}`);
    assert.match(html, /&lt;img/);
});

/* ── prefix vocabulary ───────────────────────────────────────────────
 *
 * One table, three copies: `BacklogItem.Prefixes` writes the filenames,
 * `backlog_data.TYPE_PREFIX` labels the UI, and `refs.BACKLOG_PREFIXES` resolves
 * a typed reference with no store imports at all. This is what stops
 * `project → PROJECT` being reintroduced, and what justifies refs.js keeping its
 * own copy.
 */

console.log('\nprefix vocabulary');

t('the three prefix tables are the same table', () => {
    const block = /Prefixes\s*=\s*new\(\)\s*\{([^}]*)\}/.exec(cs('BacklogItem.cs'))[1];
    const fromCs = {};
    for (const m of block.matchAll(/\["(\w+)"\]\s*=\s*"(\w+)"/g)) fromCs[m[1]] = m[2];
    assert.deepEqual(fromCs, { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' });
    assert.deepEqual(data.TYPE_PREFIX, fromCs);
    assert.deepEqual(refs.BACKLOG_PREFIXES, fromCs);
});

/* ── the sample corpus parses ────────────────────────────────────────
 *
 * The seeded store is what a new deployment starts from, so a token nobody can
 * read there is a demonstration of the feature failing. Four of the six link
 * tokens in the shipped corpus were being dropped on read before this release,
 * and nothing said so.
 */

console.log('\nthe sample corpus');

/** Every example record, with the store its bare link targets are relative to. */
const CORPUS = ['bugs', 'backlog', 'tracker'].flatMap((dir) => {
    const at = join(ROOT, 'examples', dir);
    // A tracker IS a backlog store — same records, same parser, no bug store
    // beside it — so a bare number in one names an item.
    const store = dir === 'bugs' ? 'bugs' : 'backlog';
    return readdirSync(at).filter((f) => f.endsWith('.md'))
        .map((f) => ({ name: `examples/${dir}/${f}`, store, text: readFileSync(join(at, f), 'utf8') }));
});

t('every example record carries link tokens that resolve', () => {
    assert.ok(CORPUS.length >= 20, `only ${CORPUS.length} example records found`);
    for (const { name, store, text } of CORPUS) {
        const line = /^links:\s*\[(.*)\]\s*$/m.exec(text);
        if (!line) continue;
        for (const token of line[1].split(',').map((s) => s.trim()).filter(Boolean)) {
            assert.ok(links.parseLink(token, store),
                `${name}: '${token}' resolves to nothing and would be dropped on read`);
        }
    }
});
t('a record that has moved carries a history, and one that has not does not', () => {
    for (const { name, text } of CORPUS) {
        const status = /^status:\s*(\S+)\s*$/m.exec(text)?.[1] || '';
        const has = /^## History\s*$/m.test(text);
        const moved = status !== 'open' && status !== 'draft';
        assert.equal(has, moved,
            `${name} is '${status}' and ${has ? 'has' : 'has no'} ## History section`);
    }
});
t('no example record puts ## History below ## Comments', () => {
    // Below the thread, `Md.ContentBlock` cuts the section off entirely and
    // `Md.Comments` folds the whole block into the last comment's body — the
    // section silently becomes comment text.
    for (const { name, text } of CORPUS) {
        const h = text.indexOf('\n## History');
        const c = text.indexOf('\n## Comments');
        if (h < 0 || c < 0) continue;
        assert.ok(h < c, `${name}: ## History sits below ## Comments`);
    }
});

/* ── the docs against the code ───────────────────────────────────────
 *
 * The skills are what an agent reads INSTEAD of this code — they exist so the
 * markdown files can be driven with no server running — so a lifecycle that
 * drifts between the two is not a stale doc, it is an agent confidently making
 * transitions the bridge rejects, or refusing ones it would accept.
 *
 * The ASCII ladder diagram in each skill is parsed and compared to LADDERS
 * here. Same reasoning as REFINEMENT_RULES living in one place and the skill
 * quoting it: one definition, and something that fails when a copy wanders.
 */

console.log('\ndocs match the lifecycles');

const skillText = (...parts) => readFileSync(join(ROOT, 'skills', ...parts), 'utf8');

/** Parse "STORY  draft ──▶ refined ──▶ ..." into ['draft','refined',...]. */
const ladderFromDiagram = (text, label) => {
    const line = text.split('\n').find((l) => l.startsWith(label + ' '));
    if (!line) return null;
    return line.slice(label.length).split(/[^a-z-]+/).filter(Boolean);
};

const backlogSkill = skillText('backlog', 'SKILL.md');

t('every backlog type\'s diagram matches its real ladder', () => {
    for (const type of data.ALL_TYPES) {
        const drawn = ladderFromDiagram(backlogSkill, type.toUpperCase());
        assert.ok(drawn, `skills/backlog/SKILL.md draws no ladder for ${type}`);
        assert.deepEqual(drawn, data.LADDERS[type],
            `the ${type} ladder in skills/backlog/SKILL.md has drifted`);
    }
});

t('the handback states the skill names are legal for their types', () => {
    // "story -> review", "task -> done": the sequence tells an agent exactly
    // where to leave something, and a state its type does not have would be
    // rejected by the bridge at the moment the work is finished.
    for (const [type, status] of [['story', 'review'], ['task', 'done'], ['epic', 'done']]) {
        assert.ok(data.LADDERS[type].includes(status),
            `the skill hands a ${type} back as '${status}', which is not on its ladder`);
    }
});

t('no doc still claims a task inherits its parent\'s criteria', () => {
    // It never did — nothing anywhere copied or resolved them — and saying so
    // left tasks looking covered by a list describing something else.
    for (const [name, text] of [['backlog/SKILL.md', backlogSkill],
                                ['backlog/REFINEMENT.md', skillText('backlog', 'REFINEMENT.md')]]) {
        assert.ok(!/inherits its (parent|story)/i.test(text.replace(/inherits it from|inherit it from/gi, '')),
            `skills/${name} still says a task inherits acceptance criteria`);
    }
});
t('the skill still says a task is never refined and a project never reviewed', () => {
    assert.ok(!data.LADDERS.task.includes('refined'));
    assert.ok(!data.LADDERS.project.includes('refined'));
    assert.ok(!data.LADDERS.project.includes('review'));
    assert.ok(!data.LADDERS.epic.includes('review'));
    assert.match(backlogSkill, /A task is never `refined`/);
    assert.match(backlogSkill, /An epic is never `review`/);
});

t('every file prefix the skills name matches the code', () => {
    for (const [type, prefix] of Object.entries(data.TYPE_PREFIX)) {
        assert.match(backlogSkill, new RegExp(`\\b${prefix}-`),
            `skills/backlog/SKILL.md never mentions the ${type} prefix ${prefix}-`);
    }
});

t('both working skills carry the claim-first sequence', () => {
    // The user asked for one protocol across both stores. Two skills that
    // describe it differently is the same drift as two ladders.
    for (const [name, text] of [['bugs', skillText('bugs', 'SKILL.md')],
                                ['backlog', backlogSkill]]) {
        assert.match(text, /Working on an? (bug|item) — the sequence/,
            `skills/${name}/SKILL.md has no working sequence`);
        assert.match(text, /COMMIT AND PUSH/, `skills/${name}/SKILL.md never says to push`);
        assert.match(text, /CLAIM/, `skills/${name}/SKILL.md never says to claim`);
    }
});

t('the backlog skill gates work on refinement', () => {
    assert.match(backlogSkill, /REFINE FIRST/);
    assert.match(backlogSkill, /does not get worked on/);
});

const bugsSkill = skillText('bugs', 'SKILL.md');

t('the history line the skill prints is the one the server writes', () => {
    // Built with the implementation's own spacing rules rather than typed out
    // here: a skill teaching a grammar the writer does not produce is an agent
    // hand-editing files the parser then reads as notes.
    assert.ok(bugsSkill.includes(
        historyLine('2026-09-12', 'norman_agent',
            { field: 'status', from: 'investigation', to: 'testing' })),
    'skills/bugs/SKILL.md does not print the canonical history line');
    for (const field of FIELDS) {
        assert.match(bugsSkill, new RegExp(`\`${field}\``),
            `skills/bugs/SKILL.md never names the tracked field ${field}`);
    }
});

t('the skill teaches the whole link vocabulary, and no more', () => {
    for (const { type } of links.LINK_TYPES) {
        assert.match(bugsSkill, new RegExp(`\`${type}\``),
            `skills/bugs/SKILL.md never names the verb ${type}`);
    }
    for (const alias of Object.keys(links.LINK_ALIASES)) {
        // `[\s\S]{0,40}` rather than a line-local match: the sentence wraps.
        assert.match(bugsSkill, new RegExp(`\`${alias}\`[\\s\\S]{0,40}old spelling`),
            `skills/bugs/SKILL.md does not describe ${alias} as an old spelling`);
    }
});

t('the handback goes to the reporter, and the store is swept before a claim', () => {
    assert.match(bugsSkill, /reporter/);
    assert.match(bugsSkill, /assignee: <the reporter>/);
    assert.match(bugsSkill, /committed and pushed/);
    assert.match(bugsSkill, /git status/);
    // The roster is open-ended the moment a reporter exists, and the sentence
    // was already contradicted by the collaborator-roster section beside it.
    assert.ok(!/exactly two configured roles/.test(bugsSkill),
        'skills/bugs/SKILL.md still claims exactly two configured roles');
});

t('a refinement pass records the transition it makes', () => {
    const refinement = skillText('backlog', 'REFINEMENT.md');
    assert.match(refinement, /## History/);
    assert.ok(!/### 2026-09-10 · agent$/m.test(refinement),
        'REFINEMENT.md still signs its example as the bare `agent`');
});

t('a tracker is excluded from the commit-and-push rule', () =>
    // A tracker store is deliberately not in a repo, so the rule has to be
    // excluded explicitly or it leaks in through the /backlog delegation.
    assert.match(skillText('tracker', 'SKILL.md'), /nothing here is committed or pushed/));

t('no skill still writes the non-verb `relates`', () => {
    for (const parts of [['bugs', 'SKILL.md'], ['backlog', 'SKILL.md'],
                         ['backlog', 'REFINEMENT.md'], ['tracker', 'SKILL.md']]) {
        assert.ok(!/relates (STORY|BUG)-/.test(skillText(...parts)),
            `skills/${parts.join('/')} writes \`relates\`, which is not a verb in any vocabulary`);
    }
});

/* ── URLs in prose ───────────────────────────────────────────────────
 *
 * Records are full of pasted links, and pasted links are long enough to be
 * wider than the tile they sit in. These check the two halves: that a bare URL
 * becomes clickable at all, and that what it SHOWS is readable — without the
 * rule reaching into places it must not, which is where an inline renderer of
 * this shape usually goes wrong.
 */

console.log('\nURLs');

const markdown = await import(UI + 'markdown.js');
const { renderMarkdown, shortenUrl } = markdown;

t('a bare URL becomes a link', () => {
    const html = renderMarkdown('See https://example.com/docs for more.');
    assert.match(html, /<a href="https:\/\/example\.com\/docs"/);
    assert.match(html, /rel="noopener noreferrer"/);
});
t('what it SHOWS drops the scheme and the www', () => {
    assert.equal(shortenUrl('https://www.example.com/docs'), 'example.com/docs');
    assert.equal(shortenUrl('https://example.com'), 'example.com');
});
t('a long path keeps the ends and elides the middle', () => {
    // The first segment says what KIND of thing it is, the last says which one.
    assert.equal(
        shortenUrl('https://build.example.com/jobs/nightly/2026/09/10/artifacts/report.html'),
        'build.example.com/jobs/…/report.html');
});
t('one ellipsis, ever', () => {
    const label = shortenUrl('https://build.example.com/jobs/a/b/c/d/e/report.html?run=1#step-7');
    assert.equal((label.match(/…/g) || []).length, 1, `two ellipses in "${label}"`);
});
t('a query is signalled when nothing else was elided', () => {
    assert.equal(shortenUrl('https://example.com/search?q=cats'), 'example.com/search…');
    assert.equal(shortenUrl('https://example.com/search'), 'example.com/search');
});
t('the full URL survives in the title, so nothing is actually lost', () => {
    const html = renderMarkdown('https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n.html?x=1');
    assert.match(html, /title="https:\/\/example\.com\/a\/b\/c\/d\/e\/f\/g\/h\/i\/j\/k\/l\/m\/n\.html\?x=1"/);
});
t('a labelled link keeps its label', () => {
    const html = renderMarkdown('[the PR](https://example.com/pull/1) landed.');
    assert.match(html, />the PR</);
    assert.ok(!/example\.com\/pull\/1</.test(html), 'the label was replaced by the URL');
});
t('the rule does not reach inside the href it just wrote', () => {
    // The failure mode this guards: autolinking runs over output that already
    // contains <a href="https://…">, finds that URL, and links the inside of
    // its own anchor.
    const html = renderMarkdown('[x](https://example.com/a)');
    assert.equal((html.match(/<a /g) || []).length, 1, `nested anchors: ${html}`);
});
t('a URL inside code stays literal', () => {
    const html = renderMarkdown('run `curl https://example.com/a`');
    assert.match(html, /<code>curl https:\/\/example\.com\/a<\/code>/);
    assert.ok(!/<a /.test(html), 'a link was made inside a code span');
});
t('sentence punctuation is not part of the URL', () => {
    assert.match(renderMarkdown('see https://example.com/a.'), /href="https:\/\/example\.com\/a"/);
    assert.match(renderMarkdown('(see https://example.com/a)'), /href="https:\/\/example\.com\/a"/);
});
t('a dangerous scheme is not linked at all', () => {
    const html = renderMarkdown('javascript:alert(1) and data:text/html,x');
    assert.ok(!/<a /.test(html), `linked something unsafe: ${html}`);
});

/* ── swapToPage: honouring the props a caller asked for ──────────────
 *
 * The tile tree, exercised directly. This is where "clicking a name in the
 * Inspector does nothing" actually lived, and no mock of the window manager
 * could have found it — the click, the handler and the call were all correct,
 * and the request was discarded two layers below them.
 */

console.log('\nswapToPage');

const { TileTree, makeLeaf } = await import(TILING + 'tile_tree.js');

/** A leaf that has been on the Backlog page before and left a ticket open. */
const leafOnBacklog = () => {
    const t = new TileTree();
    const root = makeLeaf({ content: { kind: 'queues', props: {} }, title: 'Bugs' });
    t.setRoot(root);
    const id = root.id;
    t.focusedLeafId = id;
    // Archive a Backlog page whose active tab is an ITEM, not the board — the
    // ordinary state after reading a ticket and clicking away.
    const leaf = t.get(id);
    leaf.pageTabs = {
        backlog: {
            tabs: [
                { kind: 'backlog', props: { filter: 'board' }, title: 'Backlog', history: [] },
                { kind: 'item', props: { id: '7' }, title: 'STORY-0007', history: [] },
            ],
            activeTabIdx: 1,
        },
    };
    return { t, id, leaf };
};

t('a background tab is appended WITHOUT switching to it', () => {
    // The difference the Ctrl-click setting is supposed to make. An ordinary
    // click already opens a record and takes you to it; `transient` — which is
    // what this used — only means "not archived", so the tab arrived and took
    // the screen exactly as a plain click does.
    const tree = new TileTree();
    const root = makeLeaf({ content: { kind: 'queues', props: {} }, title: 'Bugs' });
    tree.setRoot(root);
    const id = root.id;

    tree.appendLeafTab(id, { kind: 'ticket', props: { id: '1' } }, '#1', { background: true });
    assert.equal(root.tabs.length, 2, 'the tab was not appended');
    assert.equal(root.activeTabIdx, 0, 'the background tab took the screen');
    assert.equal(root.tabs[root.activeTabIdx].kind, 'queues', 'the list stopped being what you see');

    // ...and an ordinary one still comes to the front.
    tree.appendLeafTab(id, { kind: 'ticket', props: { id: '2' } }, '#2');
    assert.equal(root.activeTabIdx, 2);
    assert.equal(root.tabs[root.activeTabIdx].props.id, '2');
});

t('a request carrying props is honoured, not dropped', () => {
    // THE BUG: `wantsTarget` was `props.id != null || kind !== targetTopNav`.
    // Opening the backlog board with a FILTER carries neither — no id, and
    // `backlog` IS its own section — so the restore fell through and put back
    // whatever the page last held. Here that is a ticket, so the tile did not
    // visibly change at all.
    const { t, id, leaf } = leafOnBacklog();
    t.swapToPage(id, { kind: 'backlog', props: { expr: { q: 1 }, label: 'On bo' }, title: 'On bo' },
        'queues', 'backlog');
    const active = leaf.tabs[leaf.activeTabIdx];
    assert.equal(active.kind, 'backlog', `landed on a ${active.kind}, not the list`);
});

t('a bare page switch still restores what you were reading', () => {
    // The other half, and why this cannot simply always force the target: a
    // top-nav click carries no props and MUST put back the tab you left open.
    const { t, id, leaf } = leafOnBacklog();
    t.swapToPage(id, { kind: 'backlog', props: {}, title: 'Backlog' }, 'queues', 'backlog');
    const active = leaf.tabs[leaf.activeTabIdx];
    assert.equal(active.kind, 'item', 'a bare page switch threw away the open ticket');
    assert.equal(active.props.id, '7');
});

t('an entity request still wins', () => {
    const { t, id, leaf } = leafOnBacklog();
    t.swapToPage(id, { kind: 'item', props: { id: '9' }, title: 'TASK-0009' }, 'queues', 'backlog');
    const active = leaf.tabs[leaf.activeTabIdx];
    assert.equal(active.kind, 'item');
    assert.equal(active.props.id, '9');
});

/* ── the palette's snippet highlighting ─────────────────────────────
 *
 * The one piece of the search that lives in the browser, and the one that can
 * inject markup if it gets the order wrong: the snippet is somebody's comment,
 * so it can contain anything at all.
 */

console.log('\nsearch highlighting');

const { highlight } = await import(TILING + 'command_palette.js');

t('a term is marked', () =>
    assert.equal(highlight('the importer timed out', 'importer'),
        'the <mark>importer</mark> timed out'));
t('marking is case-insensitive but keeps the original case', () =>
    assert.equal(highlight('The Importer', 'importer'), 'The <mark>Importer</mark>'));
t('every term is marked', () =>
    assert.equal(highlight('importer timed out', 'out importer'),
        '<mark>importer</mark> timed <mark>out</mark>'));
t('a longer term is not broken up by a shorter one', () => {
    // "port" inside "importer" must not split the mark for "importer".
    const out = highlight('the importer', 'port importer');
    assert.equal((out.match(/<mark>/g) || []).length, 1, out);
    assert.match(out, /<mark>importer<\/mark>/);
});
t('markup in the snippet is escaped, not rendered', () => {
    // A comment is prose somebody typed; it can contain anything.
    const out = highlight('<img src=x onerror=alert(1)> boom', 'boom');
    assert.ok(!out.includes('<img'), `unescaped markup: ${out}`);
    assert.match(out, /&lt;img/);
    assert.match(out, /<mark>boom<\/mark>/);
});
t('a term made of markup cannot inject through the mark', () => {
    const out = highlight('a <b>b</b> c', '<b>');
    assert.ok(!/<b>/.test(out), `unescaped tag survived: ${out}`);
    assert.match(out, /<mark>&lt;b&gt;<\/mark>/);
});
t('an empty query marks nothing', () =>
    assert.equal(highlight('nothing to mark', ''), 'nothing to mark'));
t('a regex-special term is matched literally', () =>
    // "c++" or "a.b" must not be compiled as a pattern.
    assert.equal(highlight('the c++ path', 'c++'), 'the <mark>c++</mark> path'));

/* ── live updates ────────────────────────────────────────────────────
 *
 * The event payload is what decides whether an open record silently refreshes
 * or asks the user to choose, so getting "was that my record?" wrong either
 * loses somebody's edits or leaves them staring at stale data. */

console.log('\nlive update events');

const ev = (...changed) => ({ changed, stores: [...new Set(changed.map((c) => c.store))] });
const file = (store, id, deleted = false) => ({ store, id, deleted, file: `X-${id}.md` });

t('a matching record is recognised', () =>
    assert.equal(live.eventTouches(ev(file('bugs', 3)), 'bugs', 3), true));
t('the SAME id in the OTHER store is not', () => {
    // Ids collide across the two stores by design — BUG-0003 and STORY-0003
    // both exist. Matching on id alone would refresh the wrong page.
    assert.equal(live.eventTouches(ev(file('backlog', 3)), 'bugs', 3), false);
});
t('a different id is not', () =>
    assert.equal(live.eventTouches(ev(file('bugs', 4)), 'bugs', 3), false));
t('a string id from props still matches', () =>
    assert.equal(live.eventTouches(ev(file('bugs', 3)), 'bugs', '3'), true));
t('one match among many is found', () =>
    assert.equal(live.eventTouches(ev(file('bugs', 1), file('bugs', 2), file('bugs', 3)), 'bugs', 3), true));
t('an empty or malformed payload is not a match', () => {
    assert.equal(live.eventTouches(null, 'bugs', 3), false);
    assert.equal(live.eventTouches({}, 'bugs', 3), false);
    assert.equal(live.eventTouches(ev(), 'bugs', 3), false);
});
t('deletion is distinguished from modification', () => {
    assert.equal(live.eventDeleted(ev(file('bugs', 3, true)), 'bugs', 3), true);
    assert.equal(live.eventDeleted(ev(file('bugs', 3, false)), 'bugs', 3), false);
});
t('a deletion of another record does not read as ours', () =>
    assert.equal(live.eventDeleted(ev(file('bugs', 9, true)), 'bugs', 3), false));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
