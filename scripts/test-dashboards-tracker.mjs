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
put('fetch', async (url) => {
    const u = String(url);
    calls.push(u);
    const tracker = u.startsWith('/t/api/');
    const path = u.replace(/^.*?api\//, '/').split('?')[0];
    let j = { ok: false, error: 'no route' };
    if (path === '/backlog') j = { ok: true, items: JSON.parse(JSON.stringify(tracker ? TRACKER_ITEMS : PROJECT_ITEMS)) };
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
