/**
 * test-embed.mjs — BugDesk's pages imported into ANOTHER application's page
 * (STORY-0052, EPIC-0051), in a process of its own.
 *
 * The page is the host's, `http://host/app/`, with no `window.__BUGDESK_CONFIG__`.
 * Two projects' copies of the modules are imported from where a host would
 * import them, behind a proxy prefix: `http://host/bugdesk/p/alpha/js/…` and
 * `…/p/beta/js/…`. Node cannot fetch modules over http, so a module hook does
 * what the server does — serves `ui/js/` under both prefixes — while each module
 * keeps its http URL, which is the whole point: the URL is what a copy derives
 * its API, its config and its identity from. Bare specifiers (`@flexdesk/wm`)
 * resolve to the ONE vendored FlexDesk, as a host's import map would.
 *
 * Asserted: each copy's API base comes from its own URL, every request and the
 * event stream go there, each copy fetched its own config before it rendered,
 * and the two copies keep separate records, numbering, kinds and bus events.
 *
 * Needs jsdom, so the same node as test-dom.mjs.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI_URL = pathToFileURL(join(ROOT, 'ui', 'js')).href + '/';
const HERE = pathToFileURL(fileURLToPath(import.meta.url)).href;

register('data:text/javascript,' + encodeURIComponent(`
import { readFile } from 'node:fs/promises';
const UI = ${JSON.stringify(UI_URL)};
const HERE = ${JSON.stringify(HERE)};
// <server>/bugdesk/p/<name>/js/<path> — the alias ticketdesk@t/ is ticketdesk/,
// as server/Program.cs serves it.
const SERVED = /^http:\\/\\/host\\/bugdesk\\/(?:p\\/[^/]+|t)\\/js\\/(.*)$/;
export async function resolve(spec, ctx, next) {
    if (SERVED.test(spec)) return { url: spec, format: 'module', shortCircuit: true };
    if (ctx.parentURL && SERVED.test(ctx.parentURL)) {
        if (/^\\.{1,2}\\//.test(spec)) {
            const url = new URL(spec, ctx.parentURL).href;
            return { url, format: 'module', shortCircuit: true };
        }
        // A bare specifier: the host's import map, i.e. the one vendored FlexDesk.
        return next(spec, { ...ctx, parentURL: HERE });
    }
    return next(spec, ctx);
}
export async function load(url, ctx, next) {
    const m = SERVED.exec(url.split('?')[0]);
    if (m) {
        const file = new URL(m[1].replace(/^ticketdesk@t\\//, 'ticketdesk/'), UI);
        return { format: 'module', source: await readFile(file), shortCircuit: true };
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

// The HOST's page: another path, and no BugDesk config on it.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://host/app/' });
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
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

/* ── the BugDesk behind the proxy: two projects, told apart by everything ── */

const PROJECTS = {
    alpha: { human: 'alice', prefix: 'ALP', pad: 4, bug: 'Alpha crashes on save', story: 'Alpha onboarding',
        filters: [{ id: 'f-mine', scope: 'bugs', label: 'Mine', icon: 'person', expr: { kind: 'group', op: 'AND', children: [] } }] },
    beta: { human: 'bob', prefix: 'BET', pad: 3, bug: 'Beta loses the draft', story: 'Beta billing' },
};
const configOf = (name) => {
    const p = PROJECTS[name];
    return {
        ok: true, configured: true, app: 'bugdesk', mode: 'bugs', version: '0.2.0',
        humanAuthor: p.human, agentAuthor: `${p.human}_agent`,
        collaborators: [{ name: p.human, agent: `${p.human}_agent` }], assignees: [p.human, `${p.human}_agent`],
        store: { kind: 'project', name, hasBugs: true, hasBacklog: true, base: `/p/${name}/` },
        numbering: { bugs: { prefix: p.prefix, pad: p.pad }, backlog: { pad: p.pad } },
        tracker: { available: false },
    };
};
const bugOf = (name) => ({
    id: 1, title: PROJECTS[name].bug, status: 'open', severity: 'high', type: 'bug', subsystem: 'ui',
    assignee: PROJECTS[name].human, reporter: PROJECTS[name].human, labels: [], links: [],
    created: '2026-10-01', updated: '2026-10-02', stage: 0, pri: 2, description: `About ${name}.`, comments: [], history: [],
});
const storyOf = (name) => ({
    id: 7, type: 'story', title: PROJECTS[name].story, status: 'refined', parent: 0, assignee: '', reporter: PROJECTS[name].human,
    due: '', points: 3, subsystem: 'ui', labels: [], links: [], criteria: [],
});

/** Every request, in order: `{ url, method }`. */
const requests = [];
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
put('fetch', async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method || 'GET' });
    const m = /^http:\/\/host\/bugdesk\/p\/(alpha|beta)\/api\/(.*)$/.exec(url);
    if (!m) return json({ ok: false, error: `not BugDesk: ${url}` }, 404);
    const [, name, path] = m;
    if (path === 'config') return json(configOf(name));
    if (path === 'bugs') return json({ ok: true, bugs: [bugOf(name)] });
    if (path === 'bugs/1') return json({ ok: true, bug: bugOf(name) });
    if (path === 'meta') return json({ ok: true, byAssignee: { [PROJECTS[name].human]: 1 } });
    if (path === 'backlog') return json({ ok: true, items: [storyOf(name)] });
    if (path === 'backlog/7') return json({ ok: true, item: { ...storyOf(name), description: '', comments: [], history: [] } });
    if (path === 'backlog/meta') return json({ ok: true, phases: [] });
    if (path === 'filters') return json({ ok: true, filters: PROJECTS[name].filters || [] });
    return json({ ok: true, settings: {}, filters: [], items: [] });
});

/** The live stream, as a host page would open it: one per copy. */
const streams = [];
class FakeEventSource {
    static CLOSED = 2;
    constructor(url) { this.url = String(url); this.readyState = 1; this.handlers = {}; streams.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    close() { this.readyState = FakeEventSource.CLOSED; }
    async push(type, data) { for (const fn of this.handlers[type] || []) await fn({ data: JSON.stringify(data) }); }
}
put('EventSource', FakeEventSource);
dom.window.EventSource = FakeEventSource;

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

/** A stand-in for the host's FlexDesk WindowManager: what was opened, with what kind. */
const fakeWm = () => {
    const calls = [];
    return {
        calls,
        desktops: { active: () => null },
        openInPrimary: (kind, props) => calls.push(['openInPrimary', kind, props]),
        openInTabFromContext: (ctx, kind, props) => calls.push(['openInTabFromContext', kind, props]),
        navigate: (kind, props) => calls.push(['navigate', kind, props]),
        navigateUp: (kind, props) => calls.push(['navigateUp', kind, props]),
    };
};

const SERVER = 'http://host/bugdesk/';
const copy = (name) => `${SERVER}p/${name}/js/`;

console.log('\nBugDesk embedded in another page (STORY-0052)');

const { EventBus } = await import('@flexdesk/core');
const { createTaxonomy, TileTree, makeLeaf } = await import('@flexdesk/wm');
const bus = new EventBus();
const emitted = [];
const realEmit = bus.emit.bind(bus);
bus.emit = (name, payload) => { emitted.push(name); return realEmit(name, payload); };

// Importing the entry is all a host does before it builds content: the import
// itself waits for the copy's config (core/page_config.js's top-level await).
const configsBefore = () => requests.filter((r) => r.url.endsWith('/api/config')).map((r) => r.url);
const [alphaEmbed, betaEmbed] = await Promise.all([
    import(`${copy('alpha')}ticketdesk/embed.js`), import(`${copy('beta')}ticketdesk/embed.js`)]);
const configsAtImport = configsBefore();
const [alphaPage, betaPage] = await Promise.all([
    import(`${copy('alpha')}core/page_config.js`), import(`${copy('beta')}core/page_config.js`)]);
const [alphaInst, betaInst] = await Promise.all([
    import(`${copy('alpha')}ticketdesk/instance.js`), import(`${copy('beta')}ticketdesk/instance.js`)]);
const [alphaRefs, betaRefs] = await Promise.all([
    import(`${copy('alpha')}ticketdesk/refs.js`), import(`${copy('beta')}ticketdesk/refs.js`)]);
const [alphaId, betaId] = await Promise.all([
    import(`${copy('alpha')}core/app_identity.js`), import(`${copy('beta')}core/app_identity.js`)]);

await t('a copy imported from another page takes its API base from its own URL', () => {
    assert.equal(document.baseURI, 'http://host/app/');
    assert.equal(alphaPage.EMBEDDED, true);
    assert.equal(alphaPage.COPY_ROOT, 'http://host/bugdesk/p/alpha/');
    assert.equal(alphaPage.API_BASE, 'http://host/bugdesk/p/alpha/api');
    assert.equal(alphaInst.apiUrl('/bugs'), 'http://host/bugdesk/p/alpha/api/bugs');
    assert.equal(betaInst.apiUrl('bugs/1'), 'http://host/bugdesk/p/beta/api/bugs/1');
    // The tracker's copy keeps /t/api — of the same server, behind the same proxy.
    assert.equal(alphaPage.TRACKER_API_BASE, 'http://host/bugdesk/t/api');
});

await t('without window.__BUGDESK_CONFIG__ each copy loaded its own config before anything rendered', () => {
    assert.equal(window.__BUGDESK_CONFIG__, undefined, 'the host page was given a BugDesk config');
    assert.deepEqual([...configsAtImport].sort(),
        ['http://host/bugdesk/p/alpha/api/config', 'http://host/bugdesk/p/beta/api/config']);
    assert.equal(alphaInst.CONFIG.humanAuthor, 'alice');
    assert.equal(betaInst.CONFIG.humanAuthor, 'bob');
    assert.equal(alphaInst.CONFIG.store.name, 'alpha');
    assert.equal(betaPage.pageConfig().store.name, 'beta');
});

await t('module-load constants are each copy\'s own: numbering, identity', () => {
    // refs.js reads numbering at module load: the copy's config was there already.
    assert.equal(alphaRefs.BUG_PREFIX, 'ALP');
    assert.equal(betaRefs.BUG_PREFIX, 'BET');
    assert.equal(alphaRefs.formatRef({ store: 'bugs', id: 1 }, 'backlog'), 'ALP-0001');
    assert.equal(betaRefs.formatRef({ store: 'bugs', id: 1 }, 'backlog'), 'BET-001');
    assert.equal(alphaId.storeHas('bugs'), true);
    assert.equal(alphaId.appName(), 'BugDesk');
    // core/ is per project too: each answers from its own copy's config.
    assert.notEqual(alphaId, betaId);
    assert.equal(betaId.storeHas('backlog'), true);
});

const alpha = await alphaEmbed.createBugDeskEmbed({ eventBus: bus, kindPrefix: 'alpha/' });
const beta = await betaEmbed.createBugDeskEmbed({ eventBus: bus, kindPrefix: 'beta/' });

await t('every API call of a copy went to its own project, none to the host page', () => {
    assert.ok(requests.length > 6, `only ${requests.length} requests`);
    const stray = requests.filter((r) => !/^http:\/\/host\/bugdesk\/p\/(alpha|beta)\/api\//.test(r.url));
    assert.deepEqual(stray, [], 'a request left the project\'s API');
    for (const name of ['alpha', 'beta']) {
        for (const path of ['bugs', 'meta', 'backlog', 'backlog/meta']) {
            assert.ok(requests.some((r) => r.url === `http://host/bugdesk/p/${name}/api/${path}`), `${name} never read ${path}`);
        }
    }
});

await t('content kinds are namespaced for the host; BugDesk\'s own kind names are not renamed', () => {
    for (const [embed, ns] of [[alpha, 'alpha/'], [beta, 'beta/']]) {
        for (const k of ['queues', 'ticket', 'backlog', 'item', 'new-item']) {
            assert.equal(typeof embed.content[`${ns}${k}`], 'function', `${ns}${k} is not registered`);
        }
        // Panels keep FlexDesk's `panel:` marker in front: the prefix goes after it.
        for (const side of ['left', 'right', 'bottom']) {
            assert.equal(typeof embed.content[`panel:${ns}${side}`], 'function', `panel:${ns}${side} is not registered`);
            assert.equal(embed.kind(`panel:${side}`), `panel:${ns}${side}`);
        }
        const page = embed === alpha ? alphaPage : betaPage;
        assert.deepEqual(Object.keys(embed.content).filter((k) => page.localKind(k) === null), [], 'a kind without the prefix');
        assert.equal(page.localKind(`panel:${ns}left`), 'panel:left');
        assert.equal(page.localKind('panel:left'), null);
        assert.equal(embed.kind('ticket'), `${ns}ticket`);
        assert.equal(embed.kind(embed.kind('panel:left')), `panel:${ns}left`, 'nsKind is not idempotent');
    }
    // Inside a copy the kinds are what BugDesk's saved layouts call them.
    assert.deepEqual(alphaInst.KIND, { list: 'backlog', item: 'item', newItem: 'new-item', dashboard: 'tracker' });
});

await t('the kinds are valid entries for a stock FlexDesk taxonomy, both projects in one', () => {
    const host = createTaxonomy({ root: 'home', kinds: { home: { label: 'Home', icon: 'home' }, ...alpha.kinds, ...beta.kinds } });
    assert.equal(host.meta('alpha/ticket').label, 'Bug');
    assert.equal(host.topNavFor('alpha/ticket'), 'alpha/bugs-home');
    assert.equal(host.topNavFor('beta/item'), 'beta/backlog-home');
    assert.equal(host.meta('beta/bugs-home').isTopNav, true);
});

await t('two copies keep separate records: the same id shows each project\'s own bug', async () => {
    const pages = {};
    for (const [name, embed] of [['alpha', alpha], ['beta', beta]]) {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const wm = fakeWm();
        const page = embed.content[`${name}/ticket`](el, { id: '#1' }, { wm });
        pages[name] = { el, page, wm };
    }
    await settle();
    // The title is the mask's Summary field; the description is rendered text.
    const shown = (el) => `${el.querySelector('[data-f="summary"]')?.value ?? ''} | ${el.textContent}`;
    assert.match(shown(pages.alpha.el), /^Alpha crashes on save \|[\s\S]*About alpha\./);
    assert.doesNotMatch(shown(pages.alpha.el), /Beta|About beta|bob/);
    assert.match(shown(pages.beta.el), /^Beta loses the draft \|[\s\S]*About beta\./);
    assert.doesNotMatch(shown(pages.beta.el), /Alpha|About alpha|alice/);
    // The breadcrumb is built from BugDesk's own taxonomy, and walks up to the
    // project's own section, under the host's name for it.
    const crumbs = [...pages.alpha.el.querySelectorAll('.twm-topbar-breadcrumb__link')];
    assert.ok(crumbs.length, 'no breadcrumb links');
    crumbs.at(-1).click();
    assert.ok(pages.alpha.wm.calls.length, 'the crumb opened nothing');
    assert.ok(pages.alpha.wm.calls.every(([, kind]) => String(kind).startsWith('alpha/')),
        JSON.stringify(pages.alpha.wm.calls.map(([fn, kind]) => [fn, kind])));
    for (const { el, page } of Object.values(pages)) { page.destroy?.(); el.remove(); }
});

await t('the filter rail opens the bug list under its own project\'s kind', async () => {
    const wm = fakeWm();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const rail = beta.content[beta.kind('panel:left')](el, { section: 'bugs' }, { wm });
    await settle();
    const row = el.querySelector('[data-filter="open"]');
    assert.ok(row, 'no Open filter in the rail');
    row.click();
    assert.deepEqual(wm.calls.map(([fn, kind]) => [fn, kind]), [['openInPrimary', 'beta/queues']]);
    assert.equal(wm.calls[0][2].filter, 'open');
    rail.destroy?.();
    el.remove();
});

await t('an embedded rail stays chrome to a stock FlexDesk TileTree: clicking it does not make it the primary tile', () => {
    const tree = new TileTree();
    const list = tree.setRoot(makeLeaf({ content: { kind: alpha.kind('queues'), props: {} } }));
    const railId = tree.split(list, 'h');
    tree.setLeafContent(railId, { kind: alpha.kind('panel:left'), props: {} });
    tree.focus(railId);                      // a mousedown on the rail does this
    assert.equal(tree.primaryLeafId(), list, 'the rail became the primary tile: openInPrimary would replace it');
});

await t('a record dropped on an embedded panel tile is not opened over it', async () => {
    const { installRecordDropTargets, RECORD_MIME } = await import(`${copy('alpha')}ticketdesk/record_dnd.js`);
    const kinds = { 'leaf-rail': alpha.kind('panel:left'), 'leaf-list': alpha.kind('queues') };
    const wm = { ...fakeWm(), desktops: { active: () => ({ tree: { get: (id) => ({ content: { kind: kinds[id] } }) } }) } };
    const dnd = installRecordDropTargets({ wm });
    const drop = (leafId) => {
        const tile = document.createElement('div');
        tile.className = 'twm-leaf';
        tile.dataset.leafId = leafId;
        document.body.appendChild(tile);
        const ev = new window.Event('drop', { bubbles: true, cancelable: true });
        const data = { [RECORD_MIME]: JSON.stringify({ kind: alpha.kind('ticket'), props: { id: '#1' } }) };
        Object.defineProperty(ev, 'dataTransfer', { value: { types: [RECORD_MIME], getData: (t) => data[t] || '' } });
        tile.dispatchEvent(ev);
        tile.remove();
    };
    drop('leaf-rail');
    assert.deepEqual(wm.calls, [], 'the drop navigated the rail');
    drop('leaf-list');
    assert.deepEqual(wm.calls.map(([fn, kind]) => [fn, kind]), [['navigate', 'alpha/ticket']]);
    dnd?.destroy?.();
});

await t('saved filters are in filters() when the embed resolves, and changes reach the host bus', async () => {
    const saved = alpha.filters().bugs.find((f) => !f.builtin);
    assert.ok(saved, 'alpha\'s saved filter is missing');
    assert.equal(saved.key, 'f-mine');
    assert.equal(saved.label, 'Mine');
    assert.equal(beta.filters().bugs.filter((f) => !f.builtin).length, 0, 'alpha\'s saved filter leaked into beta');
    emitted.length = 0;
    const store = await import(`${copy('alpha')}ticketdesk/filter_store.js`);
    await store.loadFilters();
    assert.deepEqual(emitted.filter((n) => n.endsWith('filters:changed')), ['alpha/filters:changed']);
    assert.equal(alpha.event('filters:changed'), 'alpha/filters:changed');
});

await t('an embedded copy does not open BugDesk\'s Settings page from the snooze notice', async () => {
    const { snoozeNotice } = await import(`${copy('alpha')}ticketdesk/schema.js`);
    const el = snoozeNotice('bugs', bus);
    assert.ok(el, 'no snooze notice: the test config has a snooze field');
    assert.equal(el.querySelector('button'), null, 'the notice still offers a Settings button');
    assert.match(el.textContent, /Settings › Record types/);
});

await t('filters() counts each project\'s own rows', () => {
    const all = (embed) => embed.filters().bugs.find((f) => f.key === 'all');
    assert.equal(all(alpha).count, 1);
    assert.equal(all(beta).count, 1);
    assert.equal(alpha.filters().backlog.find((f) => f.key === 'all').count, 1);
});

await t('each copy opens its own /api/events stream', async () => {
    await alpha.start({ wm: fakeWm() });
    await beta.start({ wm: fakeWm() });
    assert.deepEqual(streams.map((s) => s.url).sort(),
        ['http://host/bugdesk/p/alpha/api/events', 'http://host/bugdesk/p/beta/api/events']);
});

await t('a store event reloads only its own project and is announced under its own name', async () => {
    const before = requests.length;
    emitted.length = 0;
    const alphaStream = streams.find((s) => s.url.includes('/p/alpha/'));
    await alphaStream.push('store', { stores: ['bugs'], changed: [{ store: 'bugs', id: 1 }] });
    const reloads = requests.slice(before).map((r) => r.url);
    assert.ok(reloads.includes('http://host/bugdesk/p/alpha/api/bugs'), 'alpha did not reload');
    assert.ok(!reloads.some((u) => u.includes('/p/beta/')), 'beta reloaded on alpha\'s change');
    assert.ok(emitted.includes('alpha/bugs:changed'), emitted.join(', '));
    assert.ok(emitted.includes('alpha/store:changed'), emitted.join(', '));
    assert.ok(!emitted.some((n) => n.startsWith('beta/') || n === 'bugs:changed' || n === 'store:changed'), emitted.join(', '));
    assert.equal(alpha.event('bugs:changed'), 'alpha/bugs:changed');
});

await t('a copy cannot be re-namespaced once its kinds are out', () => {
    assert.throws(() => alphaPage.setKindPrefix('other/'), /already namespaced/);
    assert.doesNotThrow(() => alphaPage.setKindPrefix('alpha/'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
