/**
 * test-tracker.mjs — TRACKER MODE, in a process of its own.
 *
 * WHY A SEPARATE FILE. The mode is read ONCE, at module-evaluation time, from
 * `window.__BUGDESK_CONFIG__.mode` — deliberately, because it cannot change
 * without restarting the bridge and a getter would only invite the belief that
 * it can. Three modules bake it in: kind_taxonomy.js (which top-nav chips
 * exist), backlog_data.js (which types are offered) and, through that,
 * new_item.js and backlog_filters.js.
 *
 * That makes one process one mode. A `?mode=tracker` query on the specifier
 * does give a fresh module instance — but only for the file named: its own
 * relative imports resolve without the query and come back from the cache in
 * the OTHER mode, so `new_item.js?mode=tracker` was quietly built on a
 * bug-mode `backlog_data.js`. Two processes is the honest way to test a
 * launch-time switch; scripts/test-ui.mjs covers the default mode.
 *
 * MODULE RESOLUTION is the same trick test-ui.mjs uses — see the note there.
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

const _store = new Map();
globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
};

// THE POINT OF THIS FILE: set before the first import, never touched again.
globalThis.window = {
    __BUGDESK_CONFIG__: { humanAuthor: 'alice', agentAuthor: 'claude', mode: 'tracker' },
};

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

const data = await import(UI + 'backlog_data.js');
const filters = await import(UI + 'backlog_filters.js');
const newItem = await import(UI + 'new_item.js');
const picker = await import(UI + 'item_picker.js');
const { taxonomy } = await import(TILING + 'kind_taxonomy.js');

/* ── the mode reaches every module that reads it ─────────────────── */

console.log('\ntracker mode: types');

t('the mode is on', () => {
    assert.equal(data.MODE, 'tracker');
    assert.equal(data.TRACKER, true);
});
t('project is offered as a type', () =>
    assert.deepEqual(data.TYPES, ['project', 'epic', 'story', 'task']));
t('Project appears in the New item Type select', () => {
    const project = newItem.KINDS.find((k) => k.id === 'project');
    assert.ok(project, 'no Project entry');
    assert.equal(project.store, 'backlog');
    assert.equal(project.value, 'project');
});
t('a project is filed with a phase and a date, and no parent', () => {
    const f = newItem.fieldsFor('project');
    assert.equal(f.parent, false);      // nothing sits above a project
    assert.equal(f.phase, true);
    assert.equal(f.due, true);
    assert.ok(!f.points);               // a container is not estimated
});
t('an epic gains a Parent row, because there is now a project to hold it', () =>
    assert.equal(newItem.fieldsFor('epic').parent, true));
t('every offered backlog kind can carry a target date', () => {
    for (const k of ['project', 'epic', 'story', 'task']) {
        assert.equal(newItem.fieldsFor(k).due, true, `${k} cannot be given a date`);
    }
});

/* ── the chrome ──────────────────────────────────────────────────── */

console.log('\ntracker mode: chrome');

t('the Tracker chip exists and leads the strip', () =>
    assert.deepEqual(taxonomy.topNavEntries().map((e) => e.kind),
        ['tracker', 'queues', 'backlog']));
t('Backlog keeps its kind id and reads as Tickets', () => {
    // The id is baked into saved tile layouts and every props.filter route;
    // renaming it would strand both for a cosmetic gain.
    assert.equal(taxonomy.meta('backlog').label, 'Tickets');
    assert.ok(taxonomy.meta('backlog').isTopNav);
});
t('the Bugs chip is still there — tracker mode adds, it does not remove', () =>
    assert.equal(taxonomy.meta('queues').label, 'Bugs'));
t('the item page still belongs to the backlog section', () =>
    assert.equal(taxonomy.topNavFor('item'), 'backlog'));
t('the create mask files into the ticket section, not the bug queue', () =>
    assert.equal(taxonomy.topNavFor('new-item'), 'backlog'));

/* ── the rail ────────────────────────────────────────────────────── */

console.log('\ntracker mode: views');

const view = (key) => filters.BUILTIN_FILTERS.find((v) => v.key === key);
const match = (key, item) => filters.matcherFor(view(key).expr)(item);

t('what is late leads the rail', () =>
    assert.equal(filters.BUILTIN_FILTERS[0].key, 'overdue'));
t('the rail carries the two gaps a schedule cannot show', () => {
    assert.ok(view('unassigned'), 'no "nobody on it" view');
    assert.ok(view('undated'), 'no "no target date" view');
});
t('`board` resolves in both modes', () => {
    // A restored tab or a saved tile layout routes on this key.
    assert.ok(view('board'), 'tracker mode has no `board` view');
    assert.equal(filters.DEFAULT_FILTER, 'board');
});
t('Overdue selects an overdue item and nothing else', () => {
    assert.equal(match('overdue', { dueState: 'overdue', status: 'in-progress' }), true);
    assert.equal(match('overdue', { dueState: 'soon', status: 'in-progress' }), false);
    assert.equal(match('overdue', { dueState: 'none', status: 'in-progress' }), false);
});
t('a closed item is never overdue', () =>
    // dueState() collapses done/dropped to `done`, so the view cannot match it
    // however old the date is.
    assert.equal(match('overdue', { dueState: 'done', status: 'done', due: '2020-01-01' }), false));
t('"No target date" is open work only', () => {
    assert.equal(match('undated', { dueState: 'none', status: 'draft', assignee: 'bo' }), true);
    assert.equal(match('undated', { dueState: 'done', status: 'done', assignee: 'bo' }), false);
});
t('"Nobody on it" matches an empty assignee', () => {
    assert.equal(match('unassigned', { status: 'draft', assignee: '' }), true);
    assert.equal(match('unassigned', { status: 'draft', assignee: 'bo' }), false);
});
t('"Assigned by me" reads reporter, not assignee', () => {
    assert.equal(match('byme', { status: 'draft', reporter: 'alice', assignee: 'bo' }), true);
    // The pair is the whole point: work I am DOING is not work I handed out.
    assert.equal(match('byme', { status: 'draft', reporter: 'bo', assignee: 'alice' }), false);
});
t('a project filter selects a whole subtree by projectRef', () => {
    const m = filters.matcherFor(filters.projectExpr('PROJ-0003'));
    assert.equal(m({ projectRef: 'PROJ-0003' }), true);
    assert.equal(m({ projectRef: 'PROJ-0009' }), false);
    assert.equal(m({ projectRef: '' }), false);
});
t('the field catalogue is the same in both modes', () => {
    // A filter someone saved in one mode has to keep resolving in the other,
    // so only the VIEWS differ.
    for (const key of ['project', 'reporter', 'due', 'dueState', 'epic', 'phase']) {
        assert.ok(filters.FILTER_FIELDS.some((f) => f.key === key), `no ${key} field`);
    }
});

/* ── hierarchy, from the picker's side ───────────────────────────── */

console.log('\ntracker mode: hierarchy');

t('a project sits at the top and holds all three levels', () => {
    assert.deepEqual(picker.parentTypesFor('project'), []);
    assert.deepEqual(picker.childTypesFor('project'), ['epic', 'story', 'task']);
});
t('a story or a task may be filed straight onto a project', () => {
    assert.ok(picker.parentTypesFor('story').includes('project'));
    assert.ok(picker.parentTypesFor('task').includes('project'));
});
t('"Add child" defaults to the conventional level below', () => {
    // The picker preselects the whole list; the New button takes [0].
    assert.equal(picker.childTypesFor('project')[0], 'epic');
    assert.equal(picker.childTypesFor('epic')[0], 'story');
    assert.equal(picker.childTypesFor('story')[0], 'task');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
