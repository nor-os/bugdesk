/**
 * test-dashboards-tracker.mjs — tracker records as a dashboard source on a
 * PROJECT page (STORY-0038), in a process of its own.
 *
 * The browser loads the tracker's copy of the ticketdesk modules from an alias,
 * `/js/ticketdesk@t/`, which the bridge serves from the same files (see
 * ticketdesk/instance.js). There is no such directory on disk, so a module hook
 * does what the bridge does: a `ticketdesk@t/` URL is read from `ticketdesk/`
 * but keeps its own URL, so it is a second module instance with its own
 * `ITEMS`, its own config (`__BUGDESK_TRACKER_CONFIG__`) and its API at /t/api.
 *
 * The page config says the tracker is available, so this is "merged" mode; the
 * tracker switched off is covered in test-dashboards-dom.mjs.
 *
 * Needs jsdom, so the same node as test-dom.mjs (>= 22.12).
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'ui', 'js');

register('data:text/javascript,' + encodeURIComponent(`
import { readFile } from 'node:fs/promises';
const ALIAS = '/ticketdesk@t/';
export async function resolve(spec, ctx, next) {
    if (/^(\\.|file:)/.test(spec) && ctx.parentURL) {
        const u = new URL(spec, ctx.parentURL);
        if (u.pathname.includes(ALIAS)) return { url: u.href, format: 'module', shortCircuit: true };
    }
    if (ctx.parentURL && ctx.parentURL.includes(ALIAS)) {
        return next(spec, { ...ctx, parentURL: ctx.parentURL.replace(ALIAS, '/ticketdesk/') });
    }
    return next(spec, ctx);
}
export async function load(url, ctx, next) {
    if (url.includes(ALIAS)) {
        const real = new URL(url.replace(ALIAS, '/ticketdesk/').split('?')[0]);
        return { format: 'module', source: await readFile(real), shortCircuit: true };
    }
    return next(url, ctx);
}
`));

// The import map, as alias packages (see test-dom.mjs).
for (const name of ['canvas', 'core', 'flow', 'host', 'wm', 'widgets', 'tiles', 'charts']) {
    const dir = join(ROOT, 'node_modules', '@flexdesk', name);
    if (existsSync(join(dir, 'index.js'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(
        { name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
    writeFileSync(join(dir, 'index.js'), `export * from '../../../ui/vendor/flexdesk/${name}.js';\n`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1/p/demo/' });
const put = (key, value) => Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
put('window', dom.window);
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
                   'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'getComputedStyle', 'location']) {
    if (dom.window[key]) put(key, dom.window[key]);
}
put('localStorage', dom.window.localStorage);
put('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
put('cancelAnimationFrame', (id) => clearTimeout(id));
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
for (const key of ['ResizeObserver', 'IntersectionObserver']) { put(key, NoopObserver); dom.window[key] = NoopObserver; }
if (dom.window.MutationObserver) put('MutationObserver', dom.window.MutationObserver);

// A project page, with the global tracker beside it.
dom.window.__BUGDESK_CONFIG__ = { humanAuthor: 'alice', agentAuthor: 'alice_agent', tracker: { available: true } };

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const rec = (id, type, parent, assignee, due, extra = {}) => ({
    id, type, title: `Rec ${id}`, status: 'draft', parent, assignee, reporter: 'alice', due, points: '', labels: [], links: [],
    fields: {}, created: '2026-09-01', updated: '2026-09-01T10:00Z', children: 0, comments: 0, history: 0, ...extra,
});
const TRACKER_ITEMS = [
    rec(1, 'project', 0, 'alice', day(40)),
    rec(2, 'task', 1, 'ann', day(-3), { fields: { client: 'Acme' } }),
    rec(3, 'task', 1, 'bob', day(2)),
    rec(4, 'task', 1, 'bob', ''),
    rec(5, 'task', 0, 'ann', day(-1), { status: 'done' }),
];
const PROJECT_ITEMS = [rec(1, 'epic', 0, 'zed', ''), rec(2, 'story', 1, 'zed', '')];

const calls = [];
// project.json's dashboards, per store: the project's (`api/`) and the tracker's (`/t/api/`).
const dashFiles = { project: [], tracker: [] };
const writes = [];
put('fetch', async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const tracker = u.startsWith('/t/api/');
    const path = u.replace(/^.*?api\//, '/').split('?')[0];
    const method = init.method || 'GET';
    const file = dashFiles[tracker ? 'tracker' : 'project'];
    let j = { ok: false, error: 'no route' };
    if (path === '/project/dashboards' && method === 'GET') j = { ok: true, dashboards: JSON.parse(JSON.stringify(file)), broken: null };
    else if (path === '/project/dashboards' && method === 'POST') {
        const d = JSON.parse(init.body).dashboard;
        writes.push({ method, u, d });
        const i = file.findIndex((e) => e.id === d.id);
        if (i >= 0) file[i] = d; else file.push(d);
        j = { ok: true, dashboard: d };
    } else if (path.startsWith('/project/dashboards/') && method === 'DELETE') {
        writes.push({ method, u });
        const id = decodeURIComponent(path.split('/').pop());
        const i = file.findIndex((e) => e.id === id);
        if (i >= 0) file.splice(i, 1);
        j = { ok: true };
    } else if (path === '/personal_state_read') j = { ok: true, result: null };
    else if (path === '/backlog') j = { ok: true, items: JSON.parse(JSON.stringify(tracker ? TRACKER_ITEMS : PROJECT_ITEMS)) };
    else if (path === '/backlog/meta') j = { ok: true, phases: [] };
    else if (path === '/dashboards/status_history' && tracker) j = { ok: true, history: { 5: [{ date: '2026-09-05', from: 'draft', to: 'done' }] } };
    return { ok: !!j.ok, status: j.ok ? 200 : 404, json: async () => j };
});

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
};

const sources = await import(pathToFileURL(join(UI, 'dashboards', 'sources.js')).href);
const resolve = await import(pathToFileURL(join(UI, 'dashboards', 'resolve.js')).href);
const editor = await import(pathToFileURL(join(UI, 'dashboards', 'tile_editor.js')).href);
const pageBacklog = await import(pathToFileURL(join(UI, 'ticketdesk', 'backlog_data.js')).href);
const T = pathToFileURL(join(UI, 'ticketdesk@t')).href + '/';
await pageBacklog.loadBacklog();

console.log('\nDashboards over tracker records, on a project page (STORY-0038)');

await t('the tracker is not a source until the page has loaded its copy', async () => {
    assert.deepEqual(sources.availableSources().map((s) => s.id), ['bugs', 'backlog']);
    assert.equal(await sources.loadTracker(), false, 'loaded without the tracker\'s config');
    assert.ok(!calls.some((c) => c.startsWith('/t/')), 'asked the tracker API');
});

// What tiling/install.js does at start: the tracker's config, then its copy, then its records.
dom.window.__BUGDESK_TRACKER_CONFIG__ = {
    mode: 'tracker', humanAuthor: 'alice', agentAuthor: 'alice_agent', assignees: ['ann', 'bob'], collaborators: [],
    store: { kind: 'tracker', hasBugs: false, hasBacklog: true },
    schema: { types: { backlog: { task: { fields: [{ name: 'client', label: 'Client', type: 'text' }] } } } },
    tracker: { available: true },
};
const trackerData = await import(`${T}backlog_data.js`);
await trackerData.loadBacklog();

await t('with the tracker loaded it is a third source, beside bugs and backlog', async () => {
    assert.equal(await sources.loadTracker(), true);
    assert.deepEqual(sources.availableSources(), [
        { id: 'bugs', label: 'Bugs' }, { id: 'backlog', label: 'Backlog' }, { id: 'tracker', label: 'Tracker' }]);
});

await t('tracker records are read from the tracker\'s copy only, never mixed into the backlog', async () => {
    const trk = sources.getSource('tracker'), blg = sources.getSource('backlog');
    assert.deepEqual(trk.rows().map((r) => `${r.ref}`), ['PROJ-0001', 'TASK-0002', 'TASK-0003', 'TASK-0004', 'TASK-0005']);
    assert.deepEqual(blg.rows().map((r) => r.ref), ['EPIC-0001', 'STORY-0002']);
    assert.equal(pageBacklog.ITEMS.length, 2, 'the project backlog changed');
    assert.ok(calls.includes('/t/api/backlog'), 'not read from /t/api');
});

await t('the tracker\'s own fields, schema, types and views apply', async () => {
    const trk = sources.getSource('tracker');
    for (const k of ['project', 'dueState', 'dueBucket', 'assignee', 'cf.client']) assert.ok(trk.fieldByKey(k), `${k} missing`);
    assert.ok(!sources.getSource('backlog').fieldByKey('cf.client'), 'the tracker\'s custom field leaked into the backlog');
    assert.ok(trk.types().some((x) => x.value === 'project'), 'no project type');
    assert.ok(trk.builtinFilter('overdue'), 'the tracker\'s views are not offered');
    const r = await resolve.resolveTile(trk, { source: 'tracker', plot: 'count', field: 'cf.client' });
    assert.deepEqual(r.data.series[0].x, ['Acme', '(none)']);
});

await t('overdue, due this week and no date per assignee; a click opens the tracker\'s ticket list', async () => {
    const trk = sources.getSource('tracker');
    const b = { source: 'tracker', types: ['task'], plot: 'count', field: 'assignee', split: 'dueBucket' };
    const r = await resolve.resolveTile(trk, b);
    assert.deepEqual(r.data.series[0].x, ['ann', 'bob']);
    assert.deepEqual(Object.fromEntries(r.data.series.map((s) => [s.name, s.y])),
        { Overdue: [1, 0], 'Due this week': [0, 1], 'No date': [0, 1], Closed: [1, 0] });
    const d = resolve.drillExpr(trk, b, ['bob', 'week'], 'Chase');
    const { matcherFor } = await import(`${T}backlog_filters.js`);
    assert.deepEqual(trackerData.ITEMS.filter(matcherFor(d.expr)).map((i) => i.id), [3]);
    assert.equal(trk.listKind, 'tracker-tickets');
    assert.deepEqual(trk.listProps(d.expr, d.label), { expr: d.expr, label: 'Chase: bob · Due this week', flat: true });
    assert.equal(trk.changedEvent, 'tracker/backlog:changed');
});

await t('a burndown scopes to a PROJ record and its descendants, with the tracker\'s History', async () => {
    const trk = sources.getSource('tracker');
    const r = await resolve.resolveTile(trk, { source: 'tracker', plot: 'burndown', unit: 'items', scope: { kind: 'project', id: 1 }, from: '2026-09-01', to: '2026-09-03' }, { today: '2026-09-03' });
    // As an epic's burndown (STORY-0037): what is under the record, not the container itself.
    assert.deepEqual(r.data.series[0].y, [3, 3, 3], 'the project\'s three tasks; TASK-0005 is not under it');
    assert.ok(calls.includes('/t/api/dashboards/status_history?store=backlog'), 'History not read from the tracker');
});

await t('the tile settings offer the tracker, and its projects for a burndown scope', async () => {
    const all = sources.availableSources().map((s) => sources.getSource(s.id));
    const { fields } = editor.dataFields(all, { source: 'tracker', plot: 'burndown', scope: { kind: 'project', id: 1 } }, 'chart');
    const f = (n) => fields.find((x) => x.name === n);
    assert.deepEqual(f('bd_source').options.map((o) => o.value), ['bugs', 'backlog', 'tracker']);
    assert.deepEqual(f('bd_project_tracker').options, [{ value: '1', label: 'PROJ-0001 Rec 1' }]);
    assert.ok(f('bd_split_tracker').options.some((o) => o.value === 'dueBucket'), 'due (week) cannot split');
    const b = editor.bindingFrom({ bd_source: 'tracker', bd_plot: 'burndown', bd_unit: 'items', bd_scope: 'project', bd_project_tracker: '1' }, all, 'chart');
    assert.deepEqual(b, { source: 'tracker', plot: 'burndown', unit: 'items', scope: { kind: 'project', id: 1 } });
});

/* ── the Tracker home (STORY-0047) ─────────────────────────────────
 *
 * The page's own dashboards page, opened as the `tracker` kind with a home:
 * the built-in default over the tracker's records, until something on it is
 * changed, which saves an override in the TRACKER's project.json (`/t/api`),
 * never the project's. Reset to default deletes it. */

console.log('\nThe Tracker home, a standard dashboard (STORY-0047)');

const plotly = { newPlot: async (el) => el, react: async (el) => el, purge: () => {}, Plots: { resize: async () => {} } };
put('Plotly', plotly);
dom.window.Plotly = plotly;
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const page = await import(pathToFileURL(join(UI, 'dashboards', 'page.js')).href);
const homes = await import(pathToFileURL(join(UI, 'dashboards', 'homes.js')).href);
const navigated = [];
const tabProps = [];
const mountHome = async (props = {}) => {
    const host = document.createElement('div');
    document.body.append(host);
    const ctx = { leafId: 'L1', wm: {
        navigate: (kind, p, o) => navigated.push({ kind, props: p, dest: o?.dest, newTab: !!o?.newTab }),
        updateActiveTabProps: (_id, patch) => tabProps.push(patch),
        openInPrimary: (kind, p) => navigated.push({ kind, props: p, how: 'primary' }),
    } };
    const handle = page.createHomeContent({ eventBus: null, section: 'tracker', kind: 'tracker' })(host, props, ctx);
    await handle.ready;
    await tick(20);
    return { host, handle };
};
const leads = (host, id) => [...host.querySelectorAll(`.tile[data-tile-id="${id}"] [data-row-key] .fd-list-tile__lead`)].map((e) => e.textContent);
const people = (host) => [...host.querySelectorAll('.tile[data-tile-id="people"] [data-row-key]')].map((e) => e.dataset.rowKey);
const badge = (host) => host.querySelector('.bd-dash__scope')?.textContent.trim();
const resetBtn = (host) => host.querySelector('[data-action="reset"]');

let home;
await t('with nothing saved, the Tracker home is the built-in default: four tiles over the tracker', async () => {
    home = await mountHome();
    const titles = [...home.host.querySelectorAll('.tile .tile-title')].map((e) => e.textContent);
    assert.deepEqual(titles, ['Overdue', 'Due in the next 7 days', 'Who has what', 'Needs a name or a date']);
    assert.equal(home.host.querySelector('.bd-dash__title').textContent, 'Tracker');
    assert.deepEqual(leads(home.host, 'overdue'), ['TASK-0002'], 'a closed record is not overdue');
    assert.deepEqual(leads(home.host, 'soon'), ['TASK-0003']);
    assert.deepEqual(leads(home.host, 'gaps'), ['TASK-0004']);
    assert.deepEqual(people(home.host), ['ann', 'bob', 'alice'], 'not worst first');
    assert.match(badge(home.host), /Built in/);
    assert.equal(resetBtn(home.host).hidden, true, 'Reset is offered with nothing to reset');
    assert.equal(writes.length, 0, 'opening the home wrote something');
    for (const a of ['rename', 'delete', 'share']) assert.ok(!home.host.querySelector(`[data-action="${a}"]`), `${a} is offered on the home`);
    for (const a of ['add-list', 'add-people', 'add-chart', 'add-kpi', 'copy-personal']) assert.ok(home.host.querySelector(`[data-action="${a}"]`), `no ${a}`);
});

await t('a row opens the tracker\'s ticket, as a tab in the home\'s own tile', async () => {
    navigated.length = 0;
    home.host.querySelector('.tile[data-tile-id="overdue"] [data-row-key]').click();
    assert.deepEqual(navigated.map((n) => [n.kind, n.props.id, n.dest, n.newTab]), [['tracker-item', '2', 'origin', true]]);
    home.host.querySelector('.tile[data-tile-id="people"] [data-row-key="bob"]').click();
    assert.equal(navigated[1].kind, 'tracker-tickets');
    assert.equal(navigated[1].props.label, 'On bob');
});

await t('the scope picker narrows every tile, and is kept with the tab', async () => {
    const buttons = [...home.host.querySelectorAll('.fd-scope-picker button')];
    assert.deepEqual(buttons.map((b) => b.textContent), ['Everyone', 'Assigned by me', 'Out with others']);
    assert.match(buttons[1].title, /reporter is alice/);
    buttons[2].click();
    await tick(20);
    assert.deepEqual(tabProps.at(-1), { scope: 'others' });
    assert.deepEqual(people(home.host), ['ann', 'bob'], 'alice\'s own work is not out with others');
    assert.deepEqual(leads(home.host, 'overdue'), ['TASK-0002']);
    home.handle.destroy();
    home.host.remove();
    home = await mountHome({ scope: 'others' });
    assert.equal(home.host.querySelector('.fd-scope-picker [aria-pressed="true"]').textContent, 'Out with others', 'the scope was not restored');
    assert.deepEqual(people(home.host), ['ann', 'bob']);
});

await t('changing the built-in saves an override in the tracker\'s project.json, never the project\'s', async () => {
    home.handle.grid.removeTile('gaps');
    await tick(page.SAVE_DELAY_MS + 50);
    assert.equal(writes.length, 1, `${writes.length} writes`);
    assert.ok(writes[0].u.startsWith('/t/api/project/dashboards'), writes[0].u);
    assert.equal(writes[0].d.id, 'home-tracker');
    assert.equal(writes[0].d.home, 'tracker');
    assert.deepEqual(writes[0].d.tiles.map((x) => x.id), ['overdue', 'soon', 'people']);
    assert.equal(dashFiles.project.length, 0, 'the project\'s project.json was written');
    assert.match(badge(home.host), /Customised/);
    assert.equal(resetBtn(home.host).hidden, false, 'no Reset to default');
});

await t('the override is the home from then on, and never a dashboard of the rail', async () => {
    home.handle.destroy();
    home.host.remove();
    home = await mountHome();
    assert.equal(home.host.querySelectorAll('.tile').length, 3);
    assert.match(badge(home.host), /Customised/);
    const lib = await import(pathToFileURL(join(UI, 'dashboards', 'library.js')).href);
    dashFiles.project.push({ ...dashFiles.tracker[0] });       // as standalone TicketDesk keeps it: in the listed file
    await lib.loadLibrary();
    assert.ok(!lib.lists.shared.entries.some((e) => e.id === 'home-tracker'), 'the override is listed as a dashboard');
    dashFiles.project.length = 0;
    await lib.loadLibrary();
});

await t('Reset to default asks, deletes the override and shows the built-in again', async () => {
    resetBtn(home.host).click();
    await tick(10);
    const confirm = [...document.querySelectorAll('[data-action="confirm"]')].at(-1);
    assert.ok(confirm, 'Reset did not ask');
    confirm.click();
    await tick(40);
    assert.deepEqual(writes.at(-1), { method: 'DELETE', u: '/t/api/project/dashboards/home-tracker' });
    assert.equal(dashFiles.tracker.length, 0);
    assert.equal(home.host.querySelectorAll('.tile').length, 4, 'the built-in is not back');
    assert.match(badge(home.host), /Built in/);
    assert.equal(resetBtn(home.host).hidden, true);
    home.handle.destroy();
    home.host.remove();
});

await t('the built-in home reads the tracker\'s own views', () => {
    const b = homes.builtinHome('tracker');
    const trk = sources.getSource('tracker');
    for (const tile of b.tiles) {
        const c = resolve.check(trk, tile.config.binding, tile.type === 'flexdesk.people' ? 'people' : 'list');
        assert.ok(!c.empty, `${tile.id}: ${c.empty}`);
    }
    assert.equal(homes.builtinHome('bugs'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
