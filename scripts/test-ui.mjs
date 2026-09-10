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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ORDER = ['severity', 'parent', 'phase', 'points', 'due'];
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
    assert.deepEqual(visible('epic'), ['phase', 'points', 'due']));
t('a story is asked for a parent, never a phase', () =>
    assert.deepEqual(visible('story'), ['parent', 'points', 'due']));
t('a task matches a story', () =>
    assert.deepEqual(visible('task'), ['parent', 'points', 'due']));
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
t('the default mode has no Tracker chip', () =>
    // The tracker-mode counterpart of this lives in test-tracker.mjs, which
    // runs in its own process — the mode is read once, at module load.
    assert.deepEqual(taxonomyDefault.topNavEntries().map((e) => e.kind), ['queues', 'backlog']));

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

const { readFileSync } = await import('node:fs');
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
