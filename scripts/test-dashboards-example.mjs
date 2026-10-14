/**
 * test-dashboards-example.mjs — the example project's dashboards (STORY-0039).
 *
 * `examples/dashboards.json` is what `run.sh --seed` / `run.ps1 --seed` put into
 * a freshly seeded project's `.bugdesk/project.json` (the server adds it; see
 * BUGDESK_SEED_DASHBOARDS in Program.cs). Here both dashboards are opened in the
 * real page, over the example records read straight from `examples/bugs` and
 * `examples/backlog`, and every tile must have something to draw.
 *
 * Needs jsdom, so the same node as test-dom.mjs (>= 22.12).
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
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
put('ResizeObserver', NoopObserver);
dom.window.ResizeObserver = NoopObserver;
for (const key of ['MutationObserver', 'IntersectionObserver']) if (dom.window[key]) put(key, dom.window[key]);
if (!globalThis.IntersectionObserver) put('IntersectionObserver', NoopObserver);
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
dom.window.__BUGDESK_CONFIG__ = { humanAuthor: 'norman', agentAuthor: 'agent' };
const plotly = { newPlot: async (el) => el, react: async (el) => el, purge: () => {}, Plots: { resize: async () => {} }, toImage: async () => '' };
put('Plotly', plotly);
dom.window.Plotly = plotly;

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ── the example records, as the server's API hands them over ────── */

/** Front matter and status History of every record in an example store. */
function readStore(dir) {
    return readdirSync(join(ROOT, 'examples', dir)).filter((n) => n.endsWith('.md')).sort().map((f) => {
        const text = readFileSync(join(ROOT, 'examples', dir, f), 'utf8').replace(/\r\n/g, '\n');
        const fm = Object.fromEntries(text.split('---\n')[1].split('\n').filter((l) => l.includes(':'))
            .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim().replace(/^"(.*)"$/, '$1')]));
        const list = (v) => (v || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        const hist = (text.split('\n## History\n')[1] || '').split('\n## ')[0];
        const history = [...hist.matchAll(/^- (\S+) · \S+ · status: (\S+) -> (\S+)$/gm)]
            .map(([, date, from, to]) => ({ date, from: from === '(unset)' ? '' : from, to: to === '(unset)' ? '' : to }));
        return { file: f, fm: { ...fm, labels: list(fm.labels) }, history };
    });
}
const BUGS = readStore('bugs');
const BACKLOG = readStore('backlog');

const records = {
    '/bugs': { bugs: BUGS.map(({ fm }) => ({
        id: Number(fm.id), title: fm.title, status: fm.status, severity: fm.severity, type: fm.type,
        subsystem: fm.subsystem, assignee: fm.assignee, reporter: fm.reporter, labels: fm.labels, links: [], fields: {},
        created: fm.created, updated: fm.updated, comments: 0, history: 0,
    })) },
    '/meta': { byAssignee: {} },
    '/backlog': { items: BACKLOG.map(({ fm }) => ({
        id: Number(fm.id), type: fm.type, title: fm.title, status: fm.status, parent: Number(fm.parent) || 0,
        phase: fm.phase, assignee: fm.assignee, reporter: fm.reporter, due: fm.due || '', points: fm.points,
        subsystem: fm.subsystem, labels: fm.labels, links: [], fields: {}, created: fm.created, updated: fm.updated,
        children: 0, comments: 0, history: 0,
    })) },
    '/backlog/meta': { phases: [...new Set(BACKLOG.map(({ fm }) => fm.phase).filter(Boolean))] },
};
const historyOf = (store) => Object.fromEntries(store.map(({ fm, history }) => [fm.id, history]));

const DASHBOARDS = JSON.parse(readFileSync(join(ROOT, 'examples', 'dashboards.json'), 'utf8'));
const calls = [];
put('fetch', async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^.*?api\//, '/');
    calls.push({ method, path });
    const route = path.split('?')[0];
    let j = { ok: false, error: 'no route' };
    if (route === '/project/dashboards' && method === 'GET') j = { ok: true, dashboards: JSON.parse(JSON.stringify(DASHBOARDS)), broken: null };
    else if (route === '/workspace_state_read') j = { ok: true, result: null };
    else if (route === '/dashboards/status_history') j = { ok: true, history: historyOf(path.includes('store=bugs') ? BUGS : BACKLOG) };
    else if (method === 'GET' && records[route]) j = { ok: true, ...JSON.parse(JSON.stringify(records[route])) };
    return { ok: !!j.ok, status: j.ok ? 200 : 400, json: async () => j };
});

const bugData = await import(join(UI, 'ticketdesk', 'data.js'));
const backlogData = await import(join(UI, 'ticketdesk', 'backlog_data.js'));
await bugData.loadData();
await backlogData.loadBacklog();
const model = await import(join(UI, 'dashboards', 'model.js'));
const { createDashboardsContent } = await import(join(UI, 'dashboards', 'page.js'));
const { taxonomy } = await import(join(UI, 'tiling', 'kind_taxonomy.js'));
const factory = createDashboardsContent({ eventBus: null }).dashboards;
const ctx = { leafId: 'L1', taxonomy, wm: { updateActiveTabProps: () => {} } };

async function open(id) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = factory(host, { dashboard: id }, ctx);
    await page.ready; await tick(20);
    return { host, page };
}

/** What a tile is drawing, or why it is not. */
function shown(tile) {
    const empty = tile.contentElement.querySelector('.tile-empty, .twm-tile-error');
    if (empty) return { problem: empty.textContent.replace(/\s+/g, ' ').trim() };
    const d = tile.data;
    if (!d) return { problem: 'no data' };
    if ('value' in d) return d.value > 0 ? { ok: true } : { problem: `KPI value ${d.value}` };
    const total = d.series.reduce((n, s) => n + (s.values || s.y || []).reduce((a, v) => a + (Number(v) || 0), 0), 0);
    return total > 0 ? { ok: true } : { problem: 'every value is zero' };
}

console.log('\nexample dashboards (STORY-0039)');

await t('the example ships a Bugs and a Backlog dashboard that the UI can read whole', async () => {
    const entries = model.readEntries(DASHBOARDS);
    assert.deepEqual(entries.map((e) => e.name), ['Bugs', 'Backlog']);
    for (const e of entries) {
        assert.ok(e.ok, `${e.name}: ${e.reason}`);
        assert.deepEqual(e.keptTiles, [], `${e.name} has a tile the UI cannot read`);
    }
    const titles = entries.flatMap((e) => e.tiles.map((x) => x.config.title));
    for (const want of [/by status/, /by severity/, /by assignee/, /Created vs closed/, /Bugs burndown/,
        /Points by status/, /per epic/, /Drafts/, /EPIC-0001 burndown/]) {
        assert.ok(titles.some((x) => want.test(x)), `no tile ${want}`);
    }
});

await t('they are seeded into the shared project config, not a personal file', async () => {
    // run.sh / run.ps1 hand the seed to the server, which writes project.json (UpsertDashboard).
    for (const f of ['run.sh', 'run.ps1']) {
        const src = readFileSync(join(ROOT, f), 'utf8');
        assert.match(src, /BUGDESK_SEED_DASHBOARDS/, `${f} does not ask for the dashboards`);
        // A flag left over in the caller's session (run.ps1's $env: persists) must not
        // re-add example dashboards somebody deleted on a later run without --seed.
        assert.match(src, /(unset BUGDESK_SEED_DASHBOARDS|\$env:BUGDESK_SEED_DASHBOARDS = \$null)[\s\S]*if \(?\[? ?"?\$seed/,
            `${f} does not clear a leftover flag before seeding`);
    }
    const program = readFileSync(join(ROOT, 'server', 'Program.cs'), 'utf8');
    assert.match(program, /BUGDESK_SEED_DASHBOARDS[\s\S]{0,1200}examples", "dashboards\.json"[\s\S]{0,1200}UpsertDashboard/);
    const { page } = await open('example-bugs');
    const nav = document.createElement('div');
    document.body.appendChild(nav);
    const { mountDashboardsRail } = await import(join(UI, 'dashboards', 'rail.js'));
    const rail = mountDashboardsRail(nav, ctx);
    await tick(20);
    const rows = [...nav.querySelectorAll('.bd-dash-nav__item[data-scope="shared"]')];
    assert.deepEqual(rows.map((r) => r.querySelector('span:not(.material-symbols-outlined)').textContent), ['Bugs', 'Backlog']);
    assert.match(nav.textContent, /Shared/);
    rail.destroy();
    page.destroy();
});

await t('the example tracker ships a personal dashboard over its tickets', async () => {
    // Seeded by the server with the example tickets (BUGDESK_SEED_TRACKER), into the
    // seeding profile's own dashboards.json: personal, so never in config. Drawn over
    // the tickets on a real tracker-mode instance; here: readable whole, tracker only.
    const entries = model.readEntries(JSON.parse(readFileSync(join(ROOT, 'examples', 'tracker-dashboards.json'), 'utf8')));
    assert.deepEqual(entries.map((e) => e.name), ['My tracker']);
    const [e] = entries;
    assert.ok(e.ok, e.reason);
    assert.deepEqual(e.keptTiles, []);
    assert.ok(e.tiles.every((x) => x.config.binding.source === 'tracker'), 'a tile reads something other than the tracker');
    assert.ok(e.tiles.some((x) => x.config.binding.plot === 'burndown' && x.config.binding.scope?.kind === 'project'));
    const program = readFileSync(join(ROOT, 'server', 'Program.cs'), 'utf8');
    assert.match(program, /BUGDESK_SEED_TRACKER[\s\S]{0,2000}tracker-dashboards\.json[\s\S]{0,400}ReadState\("dashboards\.json"\) is null[\s\S]{0,400}WriteState\("dashboards\.json"/);
});

for (const [id, name] of [['example-bugs', 'Bugs'], ['example-backlog', 'Backlog']]) {
    await t(`every tile of ${name} shows data on the freshly seeded records`, async () => {
        const { page } = await open(id);
        assert.equal(page.grid.tiles.size, DASHBOARDS.find((d) => d.id === id).tiles.length);
        for (const [tid, tile] of page.grid.tiles) {
            const s = shown(tile);
            assert.ok(s.ok, `${name} › ${tile.config.title || tid}: ${s.problem}`);
        }
        page.destroy();
    });
}

await t('the EPIC-0001 burndown steps down at least once', async () => {
    const { page } = await open('example-backlog');
    const rem = page.grid.tiles.get('epic-burndown').data.series[0];
    assert.match(rem.name, /^Remaining/);
    const drops = rem.y.filter((v, i) => i > 0 && v !== null && rem.y[i - 1] !== null && v < rem.y[i - 1]);
    assert.ok(drops.length >= 1, `no step down in ${JSON.stringify(rem.y)}`);
    page.destroy();
});

await t('example STORY-0005 is still the draft worked example', async () => {
    const s5 = BACKLOG.find((r) => r.file === 'STORY-0005.md').fm;
    assert.equal(s5.status, 'draft');
    assert.equal(s5.points, '');
});

await t('opening the example dashboards writes nothing', async () => {
    await tick(1500);
    assert.deepEqual(calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/workspace_state_')), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
