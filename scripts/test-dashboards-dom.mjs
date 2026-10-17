/**
 * test-dashboards-dom.mjs — the Dashboards page (STORY-0034) in jsdom.
 *
 * Mounts the real page factory with the real FlexDesk TileGrid and chart tiles,
 * against a fake server that behaves like /api/project/dashboards (one dashboard
 * per save, every other entry untouched). Plotly is a stand-in global: what is
 * asserted is what the page SENDS and SHOWS, never a figure.
 *
 * Needs jsdom, so the same node as test-dom.mjs (>= 22.12).
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'ui', 'js');

// The import map, as alias packages (see test-dom.mjs).
for (const name of ['canvas', 'core', 'flow', 'host', 'wm', 'widgets', 'tiles', 'charts']) {
    const dir = join(ROOT, 'node_modules', '@flexdesk', name);
    if (existsSync(join(dir, 'index.js'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(
        { name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
    writeFileSync(join(dir, 'index.js'), `export * from '../../../ui/vendor/flexdesk/${name}.js';\n`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true, url: 'http://127.0.0.1/',
});
const put = (key, value) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
put('window', dom.window);
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
                   'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'getComputedStyle', 'location']) {
    if (dom.window[key]) put(key, dom.window[key]);
}
put('localStorage', dom.window.localStorage);
put('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
put('cancelAnimationFrame', (id) => clearTimeout(id));
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
put('ResizeObserver', NoopObserver);
dom.window.ResizeObserver = NoopObserver;
for (const key of ['MutationObserver', 'IntersectionObserver']) {
    if (dom.window[key]) put(key, dom.window[key]);
}
if (!globalThis.IntersectionObserver) put('IntersectionObserver', NoopObserver);
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
dom.window.__BUGDESK_CONFIG__ = { humanAuthor: 'alice', agentAuthor: 'alice_agent' };

// A Plotly stand-in, so FlexDesk's ensurePlotly never fetches anything.
const plotly = { calls: 0, newPlot: async (el) => { plotly.calls++; return el; }, react: async (el) => el,
    purge: () => {}, Plots: { resize: async () => {} }, toImage: async () => '' };
put('Plotly', plotly);
dom.window.Plotly = plotly;

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ── a fake /api/project/dashboards ──────────────────────────────── */

const BROKEN = { id: 'hand-edit', name: 'Hand edit', tiles: 'oops' };
const SEED = () => [
    { id: 'bugs', name: 'Bugs', version: 1, tiles: [
        { id: 't1', type: 'flexdesk.chart', x: 0, y: 0, w: 6, h: 4, config: { title: 'Open bugs', chart_type: 'bar' } },
        { id: 't-odd', type: 'from-the-future', x: 6, y: 0, w: 3, h: 2 },
    ] },
    BROKEN,
    42,
];
const server = { list: SEED(), calls: [], user: 'alice', state: {}, records: {} };
put('fetch', async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^.*?api\//, '/');
    const body = init.body ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, path, body });
    let j = { ok: false, error: 'no route' };
    if (path === '/project/dashboards' && method === 'GET') {
        j = { ok: true, dashboards: JSON.parse(JSON.stringify(server.list)), broken: null };
    } else if (path === '/project/dashboards' && method === 'POST') {
        const i = server.list.findIndex((e) => e && e.id === body.dashboard.id);
        if (i >= 0) server.list[i] = body.dashboard; else server.list.push(body.dashboard);
        j = { ok: true, dashboard: body.dashboard };
    } else if (path === '/personal_state_read') {
        // One state directory per profile; a nameless run has none (UserConfig.StatePath).
        j = { ok: true, result: server.user ? server.state[`${server.user}/${body.path}`] ?? null : null };
    } else if (path === '/personal_state_write' && server.failStateWrites > 0) {
        server.failStateWrites--;
        j = { ok: false, error: 'disk full' };
    } else if (path === '/personal_state_write') {
        if (server.user) server.state[`${server.user}/${body.path}`] = body.data;
        j = { ok: true, result: { ok: !!server.user } };
    } else if (path.startsWith('/project/dashboards/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop());
        server.list = server.list.filter((e) => !(e && e.id === id));
        j = { ok: true };
    } else if (method === 'GET' && server.records[path.split('?')[0]]) {
        // The stores the tiles chart (STORY-0036): /bugs, /backlog, their meta, the history.
        j = { ok: true, ...JSON.parse(JSON.stringify(server.records[path.split('?')[0]])) };
    }
    return { ok: !!j.ok, status: j.ok ? 200 : 400, json: async () => j };
});
const isState = (c) => c.path.startsWith('/personal_state_');
const writes = () => server.calls.filter((c) => c.method !== 'GET' && !isState(c));
const posts = () => server.calls.filter((c) => c.method === 'POST' && !isState(c));
const projectWrites = () => server.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/project/'));
const personalFile = (user = 'alice') => JSON.parse(server.state[`${user}/dashboards.json`] ?? '{"dashboards":[]}');

/** Fill the open form dialog and submit it. */
async function answerForm(values) {
    await tick(); await tick();
    const forms = document.querySelectorAll('form.twm-modal__form');
    const form = forms[forms.length - 1];
    assert.ok(form, 'no dialog opened');
    for (const [k, v] of Object.entries(values)) {
        const input = form.querySelector(`[name="${k}"]`);
        input.value = v;
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
}
async function answerConfirm() {
    await tick(); await tick();
    const buttons = document.querySelectorAll('[data-action="confirm"]');
    assert.ok(buttons.length, 'no confirm dialog opened');
    buttons[buttons.length - 1].click();
    await tick(); await tick();
}

/* ── the page ────────────────────────────────────────────────────── */

const { createDashboardsContent, SAVE_DELAY_MS } = await import(join(UI, 'dashboards', 'page.js'));
const { mountDashboardsRail } = await import(join(UI, 'dashboards', 'rail.js'));
const { taxonomy, DASHBOARD_KIND } = await import(join(UI, 'tiling', 'kind_taxonomy.js'));
const content = createDashboardsContent({ eventBus: null });
const props = [];
const ctx = { leafId: 'L1', taxonomy, wm: { updateActiveTabProps: (leaf, patch) => props.push({ leaf, patch }) } };

/**
 * The page and the Navigator beside it, in one host. A Navigator row calls
 * `openInPrimary`, which the window manager answers by mounting the page again
 * with the new props; the fake does the same, so `m.page` is always the live one.
 */
function mount(p = {}, { section = 'bugs' } = {}) {
    const kind = DASHBOARD_KIND[section];
    const page = content[kind];
    const host = document.createElement('div');
    const nav = document.createElement('div');
    const body = document.createElement('div');
    host.append(nav, body);
    document.body.appendChild(host);
    const m = { host, nav, page: null, rail: null };
    const mctx = { ...ctx, wm: {
        ...ctx.wm,
        openInPrimary: (opened, next) => {
            assert.equal(opened, kind, 'opened under another section');
            props.push({ leaf: 'L1', patch: next });
            m.page.destroy();
            body.innerHTML = '';
            m.page = page(body, next, mctx);
        },
    } };
    m.page = page(body, p, mctx);
    m.rail = mountDashboardsRail(nav, mctx, { section });
    m.destroy = () => { m.page.destroy(); m.rail.destroy(); host.remove(); };
    return m;
}
const rowName = (row) => row.querySelector('span:not(.material-symbols-outlined)').textContent;
/** Click a Navigator row and wait for the page it opens. */
async function pick(m, row) {
    row.click();
    await tick();
    await m.page.ready;
    await tick(10);
}
const settle = () => tick(SAVE_DELAY_MS + 100);

console.log('\nDashboards page (STORY-0034)');

let m;
await t('the Navigator lists the shared dashboards, the unreadable ones with their reason', async () => {
    m = mount();
    await m.page.ready;
    assert.ok(!m.page.grid || !m.host.querySelector('.bd-dash__main aside'), 'the page still has its own list');
    const rows = [...m.nav.querySelectorAll('.bd-dash-nav__item')];
    assert.equal(rows.length, 3);
    assert.equal(rowName(rows[0]), 'Bugs');
    assert.ok(rows[1].classList.contains('is-broken'));
    assert.match(rowName(rows[1]) + rows[1].title, /Hand edit.*tiles is not a list/);
    assert.match(rows[2].title, /not an object/);
    assert.ok(rows[0].classList.contains('is-selected'), 'the readable one is not the one opened');
    assert.equal(m.host.querySelectorAll('.tile').length, 1, 'the readable tile is not on the grid');
    assert.match(m.host.textContent, /1 tile could not be read/);
});

await t('opening a dashboard writes nothing', async () => {
    await settle();
    assert.deepEqual(writes(), []);
});

await t('a moved and resized tile is saved after the delay, with the unreadable tile unchanged', async () => {
    const g = m.page.grid;
    g.layout[0].x = 3; g.layout[0].w = 8;
    g._emitLayoutChanged();
    assert.equal(posts().length, 0, 'saved before the delay');
    await settle();
    assert.equal(posts().length, 1);
    const saved = posts()[0].body.dashboard;
    assert.deepEqual(saved.tiles[0], { id: 't1', type: 'flexdesk.chart', x: 3, y: 0, w: 8, h: 4,
        config: { title: 'Open bugs', chart_type: 'bar' } }, 'defaults leaked into the config, or the move was lost');
    assert.deepEqual(saved.tiles[1], SEED()[0].tiles[1]);
    assert.deepEqual(server.list[1], BROKEN, 'the broken entry changed');
    assert.equal(server.list[2], 42);
});

await t('a chart and a KPI can be added, and a tile removed', async () => {
    const before = posts().length;
    m.host.querySelector('[data-action="add-chart"]').click();
    m.host.querySelector('[data-action="add-kpi"]').click();
    await settle();
    assert.equal(posts().length, before + 1, 'two quick additions should be one save');
    let tiles = server.list[0].tiles;
    assert.deepEqual(tiles.map((x) => x.type), ['flexdesk.chart', 'from-the-future', 'flexdesk.chart', 'flexdesk.kpi']);
    assert.equal(m.host.querySelectorAll('.tile').length, 3);
    const victim = m.page.grid.tiles.get(tiles[2].id);
    victim.element.dispatchEvent(new dom.window.CustomEvent('tile:remove-request', { bubbles: true, detail: { tileId: tiles[2].id } }));
    await answerConfirm();
    await settle();
    tiles = server.list[0].tiles;
    assert.deepEqual(tiles.map((x) => x.type), ['flexdesk.chart', 'from-the-future', 'flexdesk.kpi']);
});

await t('a tile is configured through its settings dialog', async () => {
    const tile = m.page.grid.tiles.get('t1');
    tile._onConfigClick();
    await answerForm({ title: 'Open by severity', unit: 'bugs' });
    await settle();
    const saved = server.list[0].tiles.find((x) => x.id === 't1');
    assert.equal(saved.config.title, 'Open by severity');
    assert.equal(saved.config.unit, 'bugs');
    assert.equal(m.host.querySelector('.tile .tile-title')?.textContent, 'Open by severity');
});

await t('a dashboard is created from the Navigator, opened, and remembered in the tab', async () => {
    m.nav.querySelector('[data-new="shared"]').click();
    await answerForm({ name: 'Backlog' });
    await m.page.ready; await tick(10);
    const created = server.list.find((e) => e && e.name === 'Backlog');
    assert.ok(created, 'not saved');
    assert.deepEqual(created.tiles, []);
    assert.equal(props.at(-1).patch.dashboard, created.id);
    assert.equal(m.host.querySelector('.bd-dash__title').textContent, 'Backlog');
});

await t('a duplicate name is refused in the dialog', async () => {
    const before = writes().length;
    m.host.querySelector('[data-action="rename"]').click();
    await answerForm({ name: ' bugs ' });
    assert.equal(writes().length, before);
    assert.ok(document.querySelector('.twm-is-invalid'), 'no inline error');
    document.querySelectorAll('[data-action="cancel"]').forEach((b) => b.click());
    await tick();
});

await t('a dashboard is renamed and deleted', async () => {
    m.host.querySelector('[data-action="rename"]').click();
    await answerForm({ name: 'Backlog health' });
    await tick(10);
    const id = props.at(-1).patch.dashboard;
    assert.equal(server.list.find((e) => e && e.id === id).name, 'Backlog health');
    assert.match(m.nav.textContent, /Backlog health/, 'the Navigator still has the old name');
    m.host.querySelector('[data-action="delete"]').click();
    await answerConfirm();
    await tick(10);
    assert.ok(!server.list.some((e) => e && e.id === id), 'not deleted');
    assert.equal(writes().at(-1).method, 'DELETE');
    assert.equal(m.host.querySelector('.bd-dash__title').textContent, 'Bugs', 'the next one is not shown');
});

await t('a broken entry, opened, is shown with its reason and never written', async () => {
    await pick(m, m.nav.querySelectorAll('.bd-dash-nav__item')[1]);
    assert.match(m.host.querySelector('.bd-dash__broken').textContent, /tiles is not a list/);
    assert.equal(props.at(-1).patch.dashboard, 'hand-edit');
    for (const p of posts()) assert.notEqual(p.body.dashboard.id, 'hand-edit');
    assert.deepEqual(server.list.find((e) => e && e.id === 'hand-edit'), BROKEN);
});

await t('a change still pending when the page goes away is saved, not lost', async () => {
    m.destroy();
    const n = mount({ dashboard: 'bugs' });
    await n.page.ready;
    const before = posts().length;
    const g = n.page.grid;
    g.layout[0].y = 5;
    g._emitLayoutChanged();
    n.destroy();
    await tick(10);
    assert.equal(posts().length, before + 1);
    assert.equal(server.list[0].tiles[0].y, 5);
});

await t('the reopened page opens the dashboard its tab remembered', async () => {
    const n = mount({ dashboard: 'hand-edit' });
    await n.page.ready;
    assert.ok(n.nav.querySelector('.bd-dash-nav__item.is-selected.is-broken'));
    n.destroy();
});


console.log('\nPersonal dashboards (STORY-0035)');

const section = (host, scope) => [...host.querySelectorAll(`.bd-dash-nav__item[data-scope="${scope}"]`)];

await t('the list has a Personal section under Shared, empty at first', async () => {
    m = mount({ dashboard: 'bugs' });
    await m.page.ready;
    const headings = [...m.nav.querySelectorAll('.td-nav__section')].map((h) => h.textContent);
    assert.deepEqual(headings, ['Project dashboards', 'Personal dashboards']);
    assert.equal(section(m.host, 'personal').length, 0);
    assert.match(m.nav.innerHTML, /Only you see these; they are never committed/);
    assert.equal(m.host.querySelector('.bd-dash__scope').textContent, 'groupProject');
});

await t('a personal dashboard is created in the profile state, never in project.json', async () => {
    const before = projectWrites().length;
    m.nav.querySelector('[data-new="personal"]').click();
    await answerForm({ name: 'Mine' });
    await m.page.ready; await tick(10);
    assert.equal(projectWrites().length, before, 'project.json was written');
    const file = personalFile();
    assert.equal(file.version, 1);
    assert.equal(file.dashboards.length, 1);
    assert.equal(file.dashboards[0].name, 'Mine');
    const rows = section(m.host, 'personal');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].classList.contains('is-selected'));
    assert.ok(rows[0].classList.contains('bd-dash-nav__item--personal'));
    assert.equal(rows[0].querySelector('.material-symbols-outlined').textContent, 'person');
    assert.match(rows[0].title, /only you/i);
    assert.equal(m.host.querySelector('.bd-dash__scope--personal')?.textContent, 'personPersonal');
    assert.equal(props.at(-1).patch.dashboard, `personal:${file.dashboards[0].id}`);
});

await t('editing a personal dashboard saves to the personal file only', async () => {
    const before = projectWrites().length;
    m.host.querySelector('[data-action="add-kpi"]').click();
    await settle();
    assert.equal(projectWrites().length, before);
    assert.deepEqual(personalFile().dashboards[0].tiles.map((x) => x.type), ['flexdesk.kpi']);
});

await t('another user of the same repo does not see it', async () => {
    m.destroy();
    server.user = 'bob';
    const b = mount();
    await b.page.ready;
    assert.equal(section(b.host, 'personal').length, 0);
    assert.equal(section(b.host, 'shared').length, server.list.length);
    b.destroy();
    server.user = 'alice';
});

await t('the tab reopens a personal dashboard it remembered', async () => {
    const id = personalFile().dashboards[0].id;
    m = mount({ dashboard: `personal:${id}` });
    await m.page.ready;
    assert.ok(section(m.host, 'personal')[0].classList.contains('is-selected'));
    assert.equal(m.host.querySelector('.bd-dash__title').textContent, 'Mine');
});

await t('a shared dashboard is copied to a personal one, unreadable tiles and all', async () => {
    await pick(m, section(m.host, 'shared')[0]);
    const before = projectWrites().length;
    const shared = JSON.parse(JSON.stringify(server.list[0]));
    m.host.querySelector('[data-action="copy-personal"]').click();
    await tick(10);
    m.host.querySelector('[data-action="copy-personal"]')?.click();   // the copy is open: no such button
    await tick(10);
    assert.equal(projectWrites().length, before, 'copying wrote project.json');
    assert.deepEqual(server.list[0], shared, 'the shared one changed');
    const copy = personalFile().dashboards.at(-1);
    assert.match(copy.id, /^p-/);
    assert.equal(copy.name, 'Bugs');
    assert.deepEqual(copy.tiles, shared.tiles);
    assert.equal(m.host.querySelector('.bd-dash__title').textContent, 'Bugs');
    assert.ok(m.host.querySelector('.bd-dash__scope--personal'), 'the copy is not the one opened');
    // A second copy gets a free name.
    await pick(m, section(m.host, 'shared')[0]);
    m.host.querySelector('[data-action="copy-personal"]').click();
    await tick(10);
    assert.equal(personalFile().dashboards.at(-1).name, 'Bugs (copy)');
});

await t('sharing under a taken name asks for another, and never overwrites the shared one', async () => {
    const copy = personalFile().dashboards.find((d) => d.name === 'Bugs');
    await pick(m, section(m.host, 'personal').find((r) => rowName(r) === 'Bugs'));
    const shared = JSON.parse(JSON.stringify(server.list[0]));
    const before = projectWrites().length;
    m.host.querySelector('[data-action="share"]').click();
    await answerForm({});                                   // the name as offered: "Bugs"
    assert.equal(projectWrites().length, before, 'shared under a taken name');
    const dialog = [...document.querySelectorAll('form.twm-modal__form')].at(-1);
    assert.match(dialog.textContent, /A project dashboard is already called "Bugs"/);
    assert.ok(dialog.querySelector('.twm-is-invalid'), 'no inline error');
    await answerForm({ name: 'Bugs by component' });
    await tick(10);
    assert.equal(projectWrites().length, before + 1);
    assert.deepEqual(server.list[0], shared, 'the shared dashboard was overwritten');
    const added = server.list.find((e) => e && e.name === 'Bugs by component');
    assert.ok(added, 'not added to the shared ones');
    assert.notEqual(added.id, copy.id);
    assert.deepEqual(added.tiles, copy.tiles);
    assert.ok(!personalFile().dashboards.some((d) => d.id === copy.id), 'still personal too');
    assert.equal(props.at(-1).patch.dashboard, added.id);
    assert.ok(m.nav.querySelector('.bd-dash-nav__item.is-selected[data-scope="shared"]'));
});

await t('a share after failed personal saves does not leave a personal copy behind', async () => {
    m.nav.querySelector('[data-new="personal"]').click();
    await answerForm({ name: 'Flaky' });
    await m.page.ready; await tick(10);
    const id = personalFile().dashboards.find((d) => d.name === 'Flaky').id;
    server.failStateWrites = 2;                       // the autosave and the flush before sharing
    m.host.querySelector('[data-action="add-kpi"]').click();
    await settle();
    assert.match(m.host.querySelector('.bd-dash__status').textContent, /Not saved/);
    m.host.querySelector('[data-action="share"]').click();
    await answerForm({});
    await tick(10);
    const added = server.list.find((e) => e && e.name === 'Flaky');
    assert.deepEqual(added?.tiles.map((x) => x.type), ['flexdesk.kpi'], 'the grid as shown was not shared');
    assert.ok(!personalFile().dashboards.some((d) => d.id === id), 'the personal one was written back after the share');
});

await t('a personal file that does not parse is shown as broken and never written over', async () => {
    m.destroy();
    server.state['alice/dashboards.json'] = '{oops';
    const n = mount({ dashboard: 'bugs' });
    await n.page.ready;
    assert.match(n.nav.textContent, /Personal dashboards cannot be read: dashboards\.json is not valid JSON/);
    assert.ok(!n.nav.querySelector('[data-new="personal"]'), 'a new personal dashboard is still offered');
    assert.ok(n.host.querySelector('[data-action="copy-personal"]').disabled);
    assert.equal(server.state['alice/dashboards.json'], '{oops');
    n.destroy();
});

await t('without a profile, a personal save says so instead of pretending', async () => {
    server.user = null;
    const n = mount({ dashboard: 'bugs' });
    await n.page.ready;
    n.host.querySelector('[data-action="copy-personal"]').click();
    await tick(10);
    assert.match(n.host.querySelector('.bd-dash__status').textContent, /Not copied: no profile/);
    n.destroy();
    server.user = 'alice';
});

/* ── STORY-0046: dashboards per section, in the rail ─────────────── */

console.log('\nDashboards in each section\'s rail (STORY-0046)');

const names = (host, scope) => section(host, scope).map(rowName);

await t('every dashboard kind is this one page, and the Bugs one keeps its old id', () => {
    assert.deepEqual(Object.keys(content).sort(), ['backlog-dashboard', 'dashboards']);
    assert.equal(DASHBOARD_KIND.bugs, 'dashboards');
});

await t('a section lists its own dashboards and the ones listed everywhere, nothing else', async () => {
    delete server.state['alice/dashboards.json'];
    server.list.push({ id: 'bl', name: 'Backlog only', version: 1, section: 'backlog', tiles: [] },
        { id: 'tr', name: 'Tracker only', version: 1, section: 'tracker', tiles: [] },
        { id: 'ev', name: 'Everywhere', version: 1, section: 'all', tiles: [] });
    const b = mount({}, { section: 'bugs' });
    await b.page.ready;
    const bugs = names(b.host, 'shared');
    assert.ok(bugs.includes('Bugs') && bugs.includes('Everywhere'), `bugs rail: ${bugs}`);
    assert.ok(!bugs.includes('Backlog only') && !bugs.includes('Tracker only'), `bugs rail: ${bugs}`);
    b.destroy();
    const k = mount({}, { section: 'backlog' });
    await k.page.ready;
    const backlog = names(k.host, 'shared');
    // `bugs` has no section (saved before there were any): listed everywhere.
    assert.ok(backlog.includes('Backlog only') && backlog.includes('Everywhere') && backlog.includes('Bugs'), `backlog rail: ${backlog}`);
    assert.ok(!backlog.includes('Tracker only'));
    assert.equal(k.nav.querySelector('.bd-dash-nav').dataset.section, 'backlog');
    k.destroy();
});

await t('with no dashboard asked for, a section opens its own first one', async () => {
    // Only unreadable ones listed everywhere: a readable one of Backlog's comes first.
    server.list = server.list.filter((e) => !(e && e.tiles && Array.isArray(e.tiles) && !['backlog', 'tracker'].includes(e.section)));
    const k = mount({}, { section: 'backlog' });
    await k.page.ready;
    assert.equal(k.host.querySelector('.bd-dash__title').textContent, 'Backlog only');
    k.destroy();
    server.list = SEED().concat(server.list.filter((e) => e && ['bl', 'tr'].includes(e.id)));
});

let k;
await t('New dashboard in the Backlog rail is listed in Backlog, opens there, and only there', async () => {
    k = mount({}, { section: 'backlog' });
    await k.page.ready;
    k.nav.querySelector('[data-new="shared"]').click();
    await answerForm({ name: 'Sprint' });
    await tick(10);
    await k.page.ready;
    await tick(10);
    const saved = server.list.find((e) => e && e.name === 'Sprint');
    assert.equal(saved?.section, 'backlog');
    assert.equal(k.host.querySelector('.bd-dash__title').textContent, 'Sprint');
    assert.deepEqual(props.at(-1).patch, { dashboard: saved.id, label: 'Sprint' });
    const b = mount({}, { section: 'bugs' });
    await b.page.ready;
    assert.ok(!names(b.host, 'shared').includes('Sprint'), 'a backlog dashboard in the Bugs rail');
    b.destroy();
});

await t('a personal dashboard made in a rail is listed in that section too', async () => {
    k.nav.querySelector('[data-new="personal"]').click();
    await answerForm({ name: 'My sprint' });
    await tick(10);
    await k.page.ready;
    assert.equal(personalFile().dashboards.find((d) => d.name === 'My sprint')?.section, 'backlog');
    assert.ok(names(k.host, 'personal').includes('My sprint'));
});

await t('renaming the open dashboard from the rail renames it on the page, and its tiles are kept', async () => {
    await pick(k, section(k.host, 'shared').find((r) => rowName(r) === 'Sprint'));
    k.host.querySelector('[data-action="add-kpi"]').click();
    await settle();
    const row = section(k.host, 'shared').find((r) => rowName(r) === 'Sprint');
    row.querySelector('.td-nav__action[data-act="rename"]').click();
    await answerForm({ name: 'Sprint 12' });
    await tick(10);
    assert.equal(k.host.querySelector('.bd-dash__title').textContent, 'Sprint 12');
    assert.ok(names(k.host, 'shared').includes('Sprint 12'));
    const saved = server.list.find((e) => e && e.name === 'Sprint 12');
    assert.equal(saved.tiles.length, 1, 'the tile was lost');
    // A later change on the page writes the new name, not the old one back.
    k.host.querySelector('[data-action="add-chart"]').click();
    await settle();
    const again = server.list.find((e) => e && e.id === saved.id);
    assert.equal(again.name, 'Sprint 12');
    assert.equal(again.tiles.length, 2);
});

await t('moving a dashboard to another section takes it out of this rail', async () => {
    const row = section(k.host, 'shared').find((r) => rowName(r) === 'Sprint 12');
    row.querySelector('.td-nav__action[data-act="rename"]').click();
    await tick(); await tick();
    const select = [...document.querySelectorAll('form.twm-modal__form')].at(-1).querySelector('[name="section"]');
    assert.deepEqual([...select.options].map((o) => o.value), ['bugs', 'backlog', 'all']);
    assert.equal(select.value, 'backlog');
    await answerForm({ section: 'bugs' });
    await tick(10);
    assert.equal(server.list.find((e) => e && e.name === 'Sprint 12').section, 'bugs');
    assert.ok(!names(k.host, 'shared').includes('Sprint 12'));
    const b = mount({}, { section: 'bugs' });
    await b.page.ready;
    assert.ok(names(b.host, 'shared').includes('Sprint 12'));
    b.destroy();
});

await t('the right-click menu opens, renames and deletes', async () => {
    const row = section(k.host, 'shared').find((r) => rowName(r) === 'Backlog only');
    row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    const menu = document.querySelector('.twm-context-menu');
    assert.ok(menu, 'no menu');
    assert.match(menu.textContent, /Open[\s\S]*Rename or move…[\s\S]*Delete dashboard/);
    menu.remove();
});

await t('deleting the open dashboard from the rail asks first, then the page moves on', async () => {
    await pick(k, section(k.host, 'shared').find((r) => rowName(r) === 'Backlog only'));
    assert.equal(k.host.querySelector('.bd-dash__title').textContent, 'Backlog only');
    const row = section(k.host, 'shared').find((r) => rowName(r) === 'Backlog only');
    const before = server.list.length;
    row.querySelector('.td-nav__action[data-act="delete"]').click();
    await answerConfirm();
    await tick(20);
    assert.equal(server.list.length, before - 1);
    assert.ok(!server.list.some((e) => e && e.id === 'bl'));
    assert.ok(!names(k.host, 'shared').includes('Backlog only'));
    assert.notEqual(k.host.querySelector('.bd-dash__title')?.textContent, 'Backlog only');
    await settle();
    assert.ok(!server.list.some((e) => e && e.id === 'bl'), 'the page saved it back');
    k.destroy();
    server.list = SEED();
    delete server.state['alice/dashboards.json'];
});

await t('a rename alone keeps a section BugDesk does not know; a move replaces it', async () => {
    server.list.push({ id: 'weird', name: 'Weird', version: 1, section: 'reports', tiles: [] });
    const b = mount({}, { section: 'bugs' });
    await b.page.ready;
    const row = () => section(b.host, 'shared').find((r) => rowName(r).startsWith('Weird'));
    row().querySelector('.td-nav__action[data-act="rename"]').click();
    await answerForm({ name: 'Weird 2' });
    await tick(10);
    let saved = server.list.find((e) => e && e.id === 'weird');
    assert.equal(saved.name, 'Weird 2');
    assert.equal(saved.section, 'reports', 'the unknown section was overwritten');
    row().querySelector('.td-nav__action[data-act="rename"]').click();
    await answerForm({ section: 'backlog' });
    await tick(10);
    saved = server.list.find((e) => e && e.id === 'weird');
    assert.equal(saved.section, 'backlog');
    b.destroy();
    server.list = SEED();
});

await t('a row is marked only in the section whose page shows it, and only while it does', async () => {
    const b = mount({}, { section: 'bugs' });
    await b.page.ready;
    await tick(10);
    const marked = (host) => [...host.querySelectorAll('.bd-dash-nav__item.is-selected')].map(rowName);
    assert.deepEqual(marked(b.nav), ['Bugs']);
    // Another section's rail, its own page not open: 'Bugs' is listed there (no section), not marked.
    const other = document.createElement('div');
    document.body.appendChild(other);
    const rail = mountDashboardsRail(other, ctx, { section: 'backlog' });
    await tick(10);
    assert.ok(names(other, 'shared').includes('Bugs'));
    assert.deepEqual(marked(other), [], 'marked in a section where it is not open');
    rail.destroy(); other.remove();
    // The main area shows the queue: the section's own rail has no mark either.
    const bus = { subs: new Set(), on(n, fn) { this.subs.add(fn); return { dispose: () => this.subs.delete(fn) }; } };
    let shown = 'dashboards';
    const tree = { primaryLeafId: () => 'L1', get: () => ({ content: { kind: shown } }) };
    const wmCtx = { ...ctx, wm: { ...ctx.wm, desktops: { active: () => ({ tree }) } } };
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const rail2 = mountDashboardsRail(host2, wmCtx, { section: 'bugs', eventBus: bus });
    await tick(10);
    assert.deepEqual(marked(host2), ['Bugs']);
    shown = 'queues';
    for (const fn of bus.subs) fn();
    assert.deepEqual(marked(host2), [], 'still marked while the queue shows');
    shown = 'dashboards';
    for (const fn of bus.subs) fn();
    assert.deepEqual(marked(host2), ['Bugs']);
    rail2.destroy(); host2.remove();
    assert.equal(bus.subs.size, 0, 'the rail kept listening after it went');
    // The page closes: its mark goes with it.
    b.page.destroy();
    await tick();
    assert.deepEqual(marked(b.nav), []);
    b.rail.destroy(); b.host.remove();
});

await t('the pane header reads the open dashboard\'s name', async () => {
    const titles = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const p = content.dashboards(host, { label: 'Bugs' }, { ...ctx, setTitle: (t) => titles.push(t) });
    assert.equal(p.title, 'Bugs');
    await p.ready;
    assert.equal(titles.at(-1), 'Bugs');
    p.destroy(); host.remove();
});

/* ── STORY-0036: what the tiles show ─────────────────────────────── */

console.log('\nDashboard tiles over records (STORY-0036)');

const schema = await import(join(UI, 'ticketdesk', 'schema.js'));
const bugData = await import(join(UI, 'ticketdesk', 'data.js'));
const backlogData = await import(join(UI, 'ticketdesk', 'backlog_data.js'));

const WITH_RISK = { types: { backlog: {
    story: { fields: [{ name: 'risk', label: 'Risk', type: 'number' }, { name: 'team', label: 'Team', type: 'text' }] },
    task: { fields: [{ name: 'risk', label: 'Risk', type: 'number' }] },
} } };
schema.setSchema(WITH_RISK);

const item = (id, type, status, assignee, points, extra = {}) => ({
    id, type, title: `Item ${id}`, status, parent: 0, assignee, reporter: 'alice', points, labels: [], links: [],
    fields: {}, created: '2026-09-01', updated: '2026-09-02T10:00Z', children: 0, comments: 0, history: 0, ...extra,
});
const ITEMS = () => [
    item(1, 'story', 'draft', 'ann', '5', { fields: { risk: '3', team: 'red' } }),
    item(2, 'story', 'in-progress', 'bob', 'M', { fields: { risk: '1' } }),
    item(3, 'task', 'review', 'bob', '2'),
    item(4, 'task', 'done', 'ann', '?', { created: '2026-09-10', updated: '2026-10-01T10:00Z' }),
];
server.records['/backlog'] = { items: ITEMS() };
server.records['/backlog/meta'] = { phases: [] };
server.records['/bugs'] = { bugs: [
    { id: 7, type: 'bug', title: 'Crash', status: 'open', severity: 'crash', pri: 1, assignee: 'ann', created: '2026-09-01', updated: '2026-09-01T10:00Z' },
] };
server.records['/meta'] = { byAssignee: {} };
server.records['/dashboards/status_history'] = { history: { 4: [{ date: '2026-09-12', from: 'review', to: 'done' }] } };
await bugData.loadData();
await backlogData.loadBacklog();

server.list.push({ id: 'data', name: 'Data', version: 1, tiles: [
    { id: 'c-new', type: 'flexdesk.chart', x: 0, y: 0, w: 6, h: 4, config: {} },
    { id: 'k-pts', type: 'flexdesk.kpi', x: 6, y: 0, w: 3, h: 2,
      config: { binding: { source: 'backlog', plot: 'sum', valueField: 'points' } } },
    { id: 'c-risk', type: 'flexdesk.chart', x: 0, y: 4, w: 6, h: 4,
      config: { chart_type: 'bar', binding: { source: 'backlog', plot: 'avg', field: 'type', valueField: 'cf.risk' } } },
] });

const bus = (() => {
    const subs = new Map();
    return {
        on: (name, fn) => { (subs.get(name) || subs.set(name, new Set()).get(name)).add(fn); return { dispose: () => subs.get(name).delete(fn) }; },
        emit: (name, payload) => { for (const fn of subs.get(name) || []) fn(payload); },
        count: (name) => subs.get(name)?.size || 0,
    };
})();
const opened = [];
const liveCtx = { ...ctx, wm: { ...ctx.wm, openInPrimary: (kind, p) => opened.push({ kind, p }) } };
const liveFactory = createDashboardsContent({ eventBus: bus }).dashboards;
function mountLive() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return { host, page: liveFactory(host, { dashboard: 'data' }, liveCtx) };
}
const tileOf = (p, id) => p.grid.tiles.get(id);
const kpiValue = (p, id) => tileOf(p, id).contentElement.querySelector('.fd-kpi__value')?.textContent;
const tileText = (p, id) => tileOf(p, id).contentElement.textContent.replace(/\s+/g, ' ').trim();

/** Fill the open dialog: selects and text by value, checkboxes by checked; `change` fires, as a person's edit would. */
async function fillForm(values) {
    await tick(); await tick();
    const forms = document.querySelectorAll('form.twm-modal__form');
    const form = forms[forms.length - 1];
    assert.ok(form, 'no dialog opened');
    for (const [k, v] of Object.entries(values)) {
        const input = form.querySelector(`[name="${k}"]`);
        assert.ok(input, `no field ${k}`);
        if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
    return form;
}
const submit = async (form) => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick(10);
};
const options = (form, name) => [...form.querySelectorAll(`[name="${name}"] option`)].map((o) => o.value);

let L;
await t('a tile with no data settings says how to set them', async () => {
    L = mountLive();
    await L.page.ready; await tick(10);
    assert.match(tileText(L.page, 'c-new'), /no data settings yet/);
});

await t('the field picker lists every field, custom ones included; the number picker only number fields', async () => {
    tileOf(L.page, 'c-new')._onConfigClick();
    const form = await fillForm({ bd_source: 'backlog' });
    const all = options(form, 'bd_field_backlog');
    for (const k of ['status', 'statusCategory', 'type', 'assignee', 'reporter', 'phase', 'subsystem', 'labels', 'points', 'cf.risk', 'cf.team']) {
        assert.ok(all.includes(k), `${k} is not offered to group by`);
    }
    const numeric = options(form, 'bd_value_backlog');
    assert.ok(numeric.includes('points') && numeric.includes('cf.risk'), 'points or the custom number field is missing');
    for (const k of ['cf.team', 'status', 'labels', 'assignee']) assert.ok(!numeric.includes(k), `${k} offered as a number`);
    const plot = options(form, 'bd_plot');
    assert.deepEqual(plot, ['count', 'sum', 'avg', 'histogram', 'perWeek', 'burndown']);
    // The number picker is only shown for the numeric plots.
    assert.ok(form.querySelector('[data-field-row="bd_value_backlog"]').hidden, 'number field shown for a count');
    await fillForm({ bd_plot: 'sum' });
    assert.ok(!form.querySelector('[data-field-row="bd_value_backlog"]').hidden, 'number field hidden for a sum');
    document.querySelectorAll('[data-action="cancel"]').forEach((b) => b.click());
    await tick();
});

await t('a bar tile counts per value, is saved with its binding, and a click opens the records', async () => {
    tileOf(L.page, 'c-new')._onConfigClick();
    const form = await fillForm({ bd_source: 'backlog', bd_plot: 'count', bd_field_backlog: 'assignee',
        bd_filter_backlog: 'key:all', 'bd_t_backlog_story': true, title: 'Stories by assignee' });
    assert.equal(form.querySelector('[name="chart_type"]').value, 'bar', 'a new count tile is not a bar chart');
    await submit(form);
    const tile = tileOf(L.page, 'c-new');
    assert.deepEqual(tile.data.series[0].x, ['ann', 'bob']);
    assert.deepEqual(tile.data.series[0].y, [1, 1]);
    await settle();
    const saved = server.list.find((e) => e && e.id === 'data').tiles.find((x) => x.id === 'c-new');
    assert.deepEqual(saved.config.binding, { source: 'backlog', types: ['story'], filter: { key: 'all' }, plot: 'count', field: 'assignee' });
    assert.equal(saved.config.chart_type, 'bar');
    tile.onPointClick({ customdata: 'bob' });
    const last = opened.at(-1);
    assert.equal(last.kind, 'backlog');
    assert.equal(last.p.label, 'Stories by assignee: bob');
    assert.equal(last.p.flat, true);
    const { matcherFor } = await import(join(UI, 'ticketdesk', 'backlog_filters.js'));
    assert.deepEqual(backlogData.ITEMS.filter(matcherFor(last.p.expr)).map((i) => i.id), [2], 'the list would not show the clicked records');
});

await t('a pie of a status category, clicked, opens the statuses behind the slice', async () => {
    const tile = tileOf(L.page, 'c-new');
    tile.update(null, { ...tile.config, chart_type: 'pie', binding: { source: 'backlog', plot: 'count', field: 'statusCategory' } });
    bus.emit('backlog:changed', {});
    await tick(150);
    assert.deepEqual(tile.data.series[0].customdata, ['active', 'finished']);
    tile.onPointClick({ customdata: 'finished' });
    assert.deepEqual(opened.at(-1).p.expr.children.at(-1), { kind: 'clause', field: 'status', op: 'one_of', value: ['done'] });
});

await t('a KPI sums points and notes the M and ? it left out', async () => {
    assert.equal(kpiValue(L.page, 'k-pts'), '7', 'not the sum of 5 and 2');
    assert.match(tileText(L.page, 'k-pts'), /2 non-numeric Estimate values \(like M or \?\) left out/);
});

await t('an average over a custom number field is drawn per group', async () => {
    const tile = tileOf(L.page, 'c-risk');
    assert.deepEqual(tile.data.series[0].x, ['Story']);
    assert.deepEqual(tile.data.series[0].y, [2]);
});

await t('an edited record updates the tiles without a reload', async () => {
    server.records['/backlog'] = { items: ITEMS().map((i) => (i.id === 3 ? { ...i, points: '8' } : i)) };
    await backlogData.loadBacklog();
    bus.emit('backlog:changed', {});
    await tick(150);
    assert.equal(kpiValue(L.page, 'k-pts'), '13', 'the KPI did not follow the edit');
});

await t('a histogram and a created/finished-per-week tile draw from the same records', async () => {
    const tile = tileOf(L.page, 'c-new');
    tile.update(null, { ...tile.config, chart_type: 'histogram', binding: { source: 'backlog', plot: 'histogram', valueField: 'points' } });
    bus.emit('backlog:changed', {});
    await tick(150);
    assert.deepEqual(tile.data.series[0].values, [5, 8]);
    tile.update(null, { ...tile.config, chart_type: 'line', binding: { source: 'backlog', plot: 'perWeek', from: '2026-08-31', to: '2026-09-20' } });
    bus.emit('backlog:changed', {});
    await tick(150);
    const [created, finished] = tile.data.series;
    assert.deepEqual(created.x, ['2026-08-31', '2026-09-07', '2026-09-14']);
    assert.deepEqual(created.y, [3, 1, 0]);
    assert.deepEqual(finished.y, [0, 1, 0], 'finished is not read from History');
});

await t('a tile whose field was removed from the schema names it in its empty state', async () => {
    L.page.destroy();
    assert.equal(bus.count('backlog:changed'), 0, 'the page still listens after it is gone');
    schema.setSchema({ types: { backlog: { story: { fields: [{ name: 'team', label: 'Team', type: 'text' }] } } } });
    L = mountLive();
    await L.page.ready; await tick(10);
    const tile = tileOf(L.page, 'c-risk');
    assert.ok(tile.contentElement.querySelector('.tile-empty'), 'not the empty state');
    assert.match(tileText(L.page, 'c-risk'), /The field 'risk' is no longer in this project's schema/);
    assert.ok(!tile.contentElement.querySelector('.twm-tile-error'), 'shown as an error');
    L.page.destroy();
    schema.setSchema(WITH_RISK);
});

await t('History that changed while no dashboard was open is read again on the next open', async () => {
    server.records['/dashboards/status_history'] = { history: { 4: [{ date: '2026-09-02', from: 'review', to: 'done' }] } };
    L = mountLive();
    await L.page.ready; await tick(10);
    const tile = tileOf(L.page, 'c-risk');
    tile.update(null, { ...tile.config, chart_type: 'line', binding: { source: 'backlog', plot: 'perWeek', from: '2026-08-31', to: '2026-09-20' } });
    bus.emit('bugs:changed', {});           // redraws every tile, drops only the bugs history
    await tick(150);
    assert.deepEqual(tile.data.series[1].y, [1, 0, 0], 'finished from the History cached by the previous page');
    L.page.destroy();
});


/* ── STORY-0037: burndown ────────────────────────────────────────── */

console.log('\nBurndown tile (STORY-0037)');

await t('the burndown settings switch unit and scope, and the tile draws step, ideal, today and the footer', async () => {
    const epicItems = [
        item(5, 'epic', 'in-progress', 'ann', '', { phase: 'p1', effectivePhase: 'p1' }),
        ...ITEMS().map((i) => (i.id === 1 || i.id === 4 ? { ...i, parent: 5 } : i)),
    ];
    server.records['/backlog'] = { items: epicItems };
    server.records['/backlog/meta'] = { phases: ['p1'] };
    server.records['/dashboards/status_history'] = { history: { 4: [{ date: '2026-09-12', from: 'review', to: 'done' }] } };
    await backlogData.loadBacklog();
    L = mountLive();
    await L.page.ready; await tick(10);
    tileOf(L.page, 'c-new')._onConfigClick();
    const form = await fillForm({ bd_source: 'backlog', bd_plot: 'burndown', bd_t_backlog_story: false, bd_filter_backlog: '' });
    const row = (n) => form.querySelector(`[data-field-row="${n}"]`);
    assert.ok(!row('bd_unit').hidden && !row('bd_scope').hidden, 'unit or scope hidden for a burndown');
    assert.ok(row('bd_epic_backlog').hidden && row('bd_phase_backlog').hidden, 'epic or phase shown for all of the backlog');
    assert.equal(form.querySelector('[name="chart_type"]').value, 'line');
    await fillForm({ bd_scope: 'phase' });
    assert.ok(!row('bd_phase_backlog').hidden && row('bd_epic_backlog').hidden, 'phase picker not shown for a phase scope');
    assert.deepEqual(options(form, 'bd_phase_backlog'), ['p1']);
    await fillForm({ bd_scope: 'epic', bd_epic_backlog: '5', bd_unit: 'items' });
    assert.ok(!row('bd_epic_backlog').hidden, 'epic picker not shown for an epic scope');
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await fillForm({ bd_from: '2026-09-01', bd_to: end });
    await submit(form);
    await tick(20);
    const tile = tileOf(L.page, 'c-new');
    assert.deepEqual(tile.config.binding, { source: 'backlog', plot: 'burndown', unit: 'items', scope: { kind: 'epic', id: 5 }, from: '2026-09-01', to: end });
    const [rem, , ideal] = tile.data.series;
    assert.equal(rem.interpolation, 'step');
    assert.deepEqual(rem.y.slice(0, 12), [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1], 'items 1 and 4 under the epic: 4 created 09-10, done 09-12');
    assert.equal(ideal.lineStyle, 'dashed');
    assert.deepEqual(ideal.x, ['2026-09-01', end]);
    assert.deepEqual(tile.data.markers, [{ x: today, label: 'Today' }]);
    assert.doesNotMatch(tileText(L.page, 'c-new'), /Points are current estimates/);
    // Points: the footer says they are current estimates.
    tile.update(null, { ...tile.config, binding: { ...tile.config.binding, unit: 'points' } });
    bus.emit('backlog:changed', {});
    await tick(150);
    assert.equal(tile.data.series[0].y[0], 5);
    assert.match(tile.contentElement.querySelector('.fd-chart-tile__note')?.textContent || '', /Points are current estimates/);
    L.page.destroy();
    server.records['/backlog'] = { items: ITEMS() };
    server.records['/backlog/meta'] = { phases: [] };
    await backlogData.loadBacklog();
});

console.log('\nTracker records, tracker switched off (STORY-0038)');

await t('without a tracker the source is not offered, and a saved tracker tile explains itself', async () => {
    const before = server.calls.length;
    server.list.push({ id: 'trk', name: 'Tracker tiles', version: 1, tiles: [
        { id: 'c-trk', type: 'flexdesk.chart', x: 0, y: 0, w: 6, h: 4,
          config: { chart_type: 'bar-stacked', binding: { source: 'tracker', plot: 'count', field: 'assignee', split: 'dueBucket' } } },
    ] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const T = liveFactory(host, { dashboard: 'trk' }, liveCtx);
    await T.ready; await tick(10);
    assert.match(tileText(T, 'c-trk'), /The tracker is not available here/);
    assert.ok(tileOf(T, 'c-trk').contentElement.querySelector('.tile-empty'), 'not shown as an empty state');
    assert.ok(!tileOf(T, 'c-trk').contentElement.querySelector('.twm-tile-error'), 'shown as an error');
    tileOf(T, 'c-trk')._onConfigClick();
    const form = await fillForm({});
    // Its own source is kept as the only choice, so Save cannot quietly turn
    // it into a bugs tile (STORY-0043); no other store is offered in its place.
    assert.deepEqual(options(form, 'bd_source'), ['tracker'], 'the tile can be switched to another store');
    document.querySelectorAll('[data-action="cancel"]').forEach((b) => b.click());
    await tick();
    assert.deepEqual(server.calls.slice(before).filter((c) => /\/t\//.test(c.path)), [], 'the tracker API was asked');
    T.destroy();
});

await t('due (week) per assignee is offered as a split and saved with the tile', async () => {
    L = mountLive();
    await L.page.ready; await tick(10);
    tileOf(L.page, 'c-new')._onConfigClick();
    const form = await fillForm({ bd_source: 'backlog', bd_plot: 'count', bd_field_backlog: 'assignee', bd_split_backlog: 'dueBucket', bd_filter_backlog: '' });
    assert.ok(!form.querySelector('[data-field-row="bd_split_backlog"]').hidden, 'split hidden for a count');
    await submit(form);
    const tile = tileOf(L.page, 'c-new');
    assert.equal(tile.config.binding.split, 'dueBucket');
    assert.deepEqual(tile.data.series.map((x) => x.name), ['No date', 'Closed']);
    tile.onPointClick({ customdata: tile.data.series[0].customdata[0] });
    assert.deepEqual(opened.at(-1).p.expr.children.at(-1), { kind: 'clause', field: 'dueState', op: 'one_of', value: ['none'] });
    L.page.destroy();
});

console.log('\nList and people tiles, and the board\'s scope (STORY-0047)');

await t('a list and a people tile are added, configured and saved like any tile', async () => {
    L = mountLive();
    await L.page.ready; await tick(10);
    const before = L.page.grid.layout.length;
    L.host.querySelector('[data-action="add-list"]').click();
    L.host.querySelector('[data-action="add-people"]').click();
    await tick(10);
    const added = L.page.grid.layout.slice(before);
    assert.deepEqual(added.map((x) => x.type), ['flexdesk.list', 'flexdesk.people']);
    const [list, people] = added.map((x) => tileOf(L.page, x.id));
    assert.match(tileText(L.page, list.id), /no data settings yet/);
    list._onConfigClick();
    let form = await fillForm({ bd_source: 'backlog' });
    assert.ok(!form.querySelector('[name="bd_plot"]'), 'a list tile asks what to plot');
    assert.deepEqual(options(form, 'bd_sort'), ['due', 'updated', 'created', 'ref']);
    assert.ok(form.querySelector('[name="empty_text"]') && form.querySelector('[name="max_rows"]'), 'FlexDesk\'s own settings are not offered');
    form = await fillForm({ bd_source: 'backlog', bd_t_backlog_story: true, bd_sort: 'ref', title: 'Stories', empty_text: 'No stories.' });
    await submit(form);
    assert.deepEqual([...list.contentElement.querySelectorAll('[data-row-key]')].map((r) => r.dataset.rowKey), ['1', '2']);
    assert.match(list.contentElement.textContent, /STORY-0001.*Item 1.*ann/s);
    people._onConfigClick();
    form = await fillForm({ bd_source: 'backlog' });
    await submit(form);
    assert.deepEqual([...people.contentElement.querySelectorAll('[data-row-key]')].map((r) => r.dataset.rowKey), ['bob', 'ann']);
    await settle();
    const saved = server.list.find((e) => e && e.id === 'data').tiles;
    const sl = saved.find((x) => x.id === list.id);
    assert.deepEqual(sl.config.binding, { source: 'backlog', types: ['story'], sort: 'ref' });
    assert.equal(sl.config.empty_text, 'No stories.');
    assert.deepEqual(saved.find((x) => x.id === people.id).config.binding, { source: 'backlog' });
});

await t('the scope picker sits in every dashboard\'s header; every tile follows it and the tab keeps it', async () => {
    const buttons = [...L.host.querySelectorAll('.bd-dash__head .fd-scope-picker button')];
    assert.deepEqual(buttons.map((b) => b.textContent), ['Everyone', 'Assigned by me', 'Out with others']);
    const kpiBefore = kpiValue(L.page, 'k-pts');
    buttons[2].click();
    await tick(30);
    assert.deepEqual(props.at(-1).patch, { scope: 'others' });
    // Out with others: on somebody who is not alice. Every item here is on ann or bob.
    assert.equal(kpiValue(L.page, 'k-pts'), kpiBefore);
    buttons[1].click();
    await tick(30);
    // Assigned by me: every item's reporter is alice.
    assert.equal(kpiValue(L.page, 'k-pts'), kpiBefore);
    server.records['/backlog'] = { items: ITEMS().map((i) => (i.id === 1 ? { ...i, reporter: 'carol' } : i)) };
    await backlogData.loadBacklog();
    bus.emit('backlog:changed', {});
    await tick(150);
    const list = [...L.page.grid.tiles.values()].find((x) => x.constructor.TYPE === 'flexdesk.list');
    assert.deepEqual([...list.contentElement.querySelectorAll('[data-row-key]')].map((r) => r.dataset.rowKey), ['2'], 'the list does not follow the scope');
    assert.ok(!server.list.find((e) => e && e.id === 'data').scope, 'the scope was written into the dashboard');
    L.page.destroy();
    server.records['/backlog'] = { items: ITEMS() };
    await backlogData.loadBacklog();
});

await t('a home override in project.json is never listed in a rail', async () => {
    server.list.push({ id: 'home-bugs', home: 'bugs', name: 'Bugs home', version: 1, tiles: [] });
    const r = mount();
    await r.page.ready; await tick(10);
    const names = [...r.nav.querySelectorAll('.bd-dash-nav__item')].map(rowName);
    assert.ok(!names.includes('Bugs home'), `listed: ${names.join(', ')}`);
    r.destroy();
    server.list = server.list.filter((e) => !(e && e.id === 'home-bugs'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
