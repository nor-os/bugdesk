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
    __BUGDESK_CONFIG__: {
        humanAuthor: 'alice', agentAuthor: 'claude', mode: 'tracker',
        agentsAssignable: false, assignees: ['alice', 'bo'],
    },
};

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

const data = await import(UI + 'backlog_data.js');
const bugData = await import(UI + 'data.js');
const filters = await import(UI + 'backlog_filters.js');
const newItem = await import(UI + 'new_item.js');
const picker = await import(UI + 'item_picker.js');
const records = await import(UI + 'records.js');
const refs = await import(UI + 'refs.js');
const links = await import(UI + 'links.js');
const { taxonomy, activeTopNavKind } = await import(TILING + 'kind_taxonomy.js');
const { REF_TOKENS } = await import('./record-fixtures.mjs');

/** The lit chip for a page of `kind`, through the real derivation the top bar
 *  and the left rail both call — a fake WM whose focused leaf holds that kind. */
const activeSection = (kind) => activeTopNavKind({
    desktops: { active: () => ({ tree: {
        focusedLeafId: 'leaf',
        get: () => ({ content: { kind } }),
        primaryLeafId: () => 'leaf',
    } }) },
});

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
t('no bug type is offered — there is no bug store to file into', () => {
    assert.deepEqual(newItem.KINDS.map((k) => k.id),
        ['project', 'epic', 'story', 'task']);
    assert.ok(!newItem.KINDS.some((k) => k.store === 'bugs'));
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
t('a project is the only type not asked for acceptance criteria', () => {
    // It is a container: what "done" means for it is that the work inside it is
    // done. Everything else, TASKS INCLUDED, has its own criteria or none.
    assert.ok(!newItem.fieldsFor('project').acceptance);
    for (const k of ['epic', 'story', 'task']) {
        assert.equal(newItem.fieldsFor(k).acceptance, true, `${k} cannot be given criteria`);
    }
});
t('every offered backlog kind can carry a target date', () => {
    for (const k of ['project', 'epic', 'story', 'task']) {
        assert.equal(newItem.fieldsFor(k).due, true, `${k} cannot be given a date`);
    }
});

t('no <name>_agent is assignable', () => {
    // A tracker records work handed to PEOPLE, none of whom has an assistant in
    // this store — an agent beside every one of them is an entry in every
    // picker that can never legitimately be chosen. The bridge says so
    // (ProjectConfig.AgentsAssignable) and the client seeds accordingly.
    assert.equal(bugData.AGENTS_ASSIGNABLE, false);
    assert.ok(!bugData.ASSIGNEES.some((n) => n.endsWith('_agent')),
        `agents in the picker: ${bugData.ASSIGNEES.join(', ')}`);
    assert.ok(bugData.ASSIGNEES.includes('alice'), 'the human went missing too');
});

/* ── the chrome ──────────────────────────────────────────────────── */

console.log('\ntracker mode: chrome');

t('Tracker is the ONLY top-level section', () =>
    // Everything else is reached from the dashboard. A second chip read as a
    // competing place to be, and moved the user out of the section they were
    // working in the moment they opened a ticket.
    assert.deepEqual(taxonomy.topNavEntries().map((e) => e.kind), ['tracker']));
t('the bug store is absent, not empty', () => {
    // A tracker does not live in a code repo, so there is no bug store for a
    // Bugs chip to lead to.
    assert.equal(taxonomy.meta('queues'), undefined);
    assert.equal(taxonomy.meta('ticket'), undefined);
});
t('Tickets keeps its kind id, and sits UNDER Tracker', () => {
    // The id is baked into saved tile layouts and every props.filter route;
    // renaming it would strand both for a cosmetic gain.
    assert.equal(taxonomy.meta('backlog').label, 'Tickets');
    assert.ok(!taxonomy.meta('backlog').isTopNav);
    assert.equal(taxonomy.topNavFor('backlog'), 'tracker');
});
t('every page declares the section it lives in', () => {
    for (const kind of ['home', 'backlog', 'item', 'new-item', 'tracker']) {
        assert.ok(taxonomy.topNavFor(kind), `${kind} declares no section`);
    }
    // `home` renders the dashboard here, so it must group with it.
    assert.equal(taxonomy.topNavFor('home'), 'tracker');
});

t('the ticket list and a ticket group as ONE page', () => {
    // wm.js groups a tile's tabs by `taxonomy.topNavFor(kind)` — a SINGLE hop.
    // If `item` and `backlog` report different sections, openInPrimary('backlog')
    // from a tile showing an `item` is treated as a CROSS-PAGE swap: it archives
    // the current tabs and restores the other page's, so the props it was given
    // are dropped on the floor and the tile shows whatever was last there.
    // From the outside that looks like the click doing nothing.
    assert.equal(taxonomy.topNavFor('item'), taxonomy.topNavFor('backlog'),
        'item and backlog are in different page groups');
    assert.equal(taxonomy.topNavFor('new-item'), taxonomy.topNavFor('backlog'),
        'new-item is in a different page group from the list it files into');
});

t('opening a ticket keeps you in the Tracker section', () => {
    // THE BUG: `item` -> `backlog` is one hop, and in tracker mode `backlog` is
    // not a chip — so the section derivation has to walk up to `tracker`.
    // Without it the chip went dark and the left rail lost its section the
    // moment you clicked a row on the dashboard.
    assert.equal(activeSection('item'), 'tracker');
    assert.equal(activeSection('backlog'), 'tracker');
    assert.equal(activeSection('new-item'), 'tracker');
    assert.equal(activeSection('tracker'), 'tracker');
});

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

/**
 * Open the record picker against a DOM STAND-IN and hand back the overlay it
 * built, so its chip strip can be read as markup.
 *
 * Why a stand-in and not jsdom, which scripts/test-dom.mjs uses for exactly this
 * kind of assertion: tracker mode is baked in at module-evaluation time, so a
 * tracker-mode picker cannot be mounted in that file at all, and jsdom needs a
 * newer node than this checkout runs. The picker writes its whole dialog into
 * one `innerHTML` string before it reads a single element back, so the stub only
 * has to be inert — every node is a sink that remembers what was written to it.
 */
const stubNode = () => ({
    className: '', innerHTML: '', textContent: '', value: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild() {}, remove() {}, setAttribute() {}, focus() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => stubNode(), querySelectorAll: () => [], closest: () => null,
});

const openPickerHeadless = (opts) => {
    const overlay = stubNode();
    const saved = {
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        requestAnimationFrame: globalThis.requestAnimationFrame,
    };
    globalThis.document = {
        createElement: () => overlay,
        body: stubNode(),
        activeElement: null,
        addEventListener() {}, removeEventListener() {},
    };
    globalThis.HTMLElement = class HTMLElement {};
    globalThis.requestAnimationFrame = () => 0;
    // The promise stays pending — nothing here picks or cancels — which is what
    // we want: the dialog is inspected exactly as it opens.
    picker.openRecordPicker(opts);
    return { overlay, close: () => Object.assign(globalThis, saved) };
};

/* ── records across a store line that is not there ───────────────────
 *
 * A tracker has NO bug store — `run.sh` never creates one and the bridge never
 * serves one — so every cross-store affordance has to degrade rather than offer
 * targets that cannot exist. The reference GRAMMAR, on the other hand, is not
 * mode-dependent: a saved filter, a pasted ref and a link token written in one
 * mode have to keep resolving in the other.
 */

console.log('\ntracker mode: records');

t('there is one store to point at', () =>
    assert.deepEqual(records.storesAvailable(), ['backlog']));

t('a caller asking for both stores gets the backlog only', () => {
    // The picker is what a "mark as duplicate" or "add a link" action opens, and
    // both ask for both stores. A Bugs chip here would filter a list down to
    // records that can never exist, which reads as a broken dialog.
    const { overlay, close } = openPickerHeadless({ stores: ['bugs', 'backlog'] });
    assert.ok(!overlay.innerHTML.includes('data-store="bugs"'), 'a Bugs chip was drawn');
    assert.ok(!overlay.innerHTML.includes('data-store="backlog"'),
        'store chips were drawn for a single store');
    // One store offered, so it falls back to today's type chips, unchanged.
    for (const type of data.TYPES) {
        assert.ok(overlay.innerHTML.includes(`data-type="${type}"`), `no ${type} chip`);
    }
    close();
});

t('the reference grammar is not mode-dependent', () => {
    for (const [token, selfStore, expected] of REF_TOKENS) {
        const got = refs.parseRef(token, selfStore);
        if (expected === null) { assert.equal(got, null, `${token} resolved`); continue; }
        assert.equal(got.store, expected.store, `${token} in ${selfStore}`);
        assert.equal(got.id, expected.id, `${token} in ${selfStore}`);
    }
});

t('the prefix table is the same table here too', () =>
    assert.deepEqual(refs.BACKLOG_PREFIXES, data.TYPE_PREFIX));

t('the link vocabulary is the same list in both modes', () =>
    // A record written in one mode is read in the other — the same store can be
    // opened either way — so a verb that exists in only one of them is a token
    // that renders in one and vanishes in the other.
    assert.deepEqual(links.LINK_TYPES.map((d) => d.type),
        ['duplicates', 'blocks', 'blocked-by', 'requires', 'caused-by', 'relates-to', 'implements']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
