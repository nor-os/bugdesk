/**
 * test-tracker-off.mjs — the Tracker switched off for you (STORY-0043), in a
 * process of its own.
 *
 * Which chips exist is read ONCE, at module load (tiling/kind_taxonomy.js), so
 * the page config here says what /api/config says when a person has switched
 * the Tracker off: a tracker path, `available: false`, `switchedOff: true`. The
 * help, the tile notes and the switch itself read the config at call time, so
 * those are also checked with the Tracker on, and with it off for the machine.
 *
 * Needs jsdom, so the same node as test-dom.mjs (>= 22.12).
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// A project page whose person has switched the Tracker off.
const OFF = { available: false, base: '/t/', path: '/home/x/tracker', switchedOff: true, machineOff: false };
const ON = { available: true, base: '/t/', path: '/home/x/tracker', switchedOff: false, machineOff: false };
const MACHINE_OFF = { available: false, base: '/t/', path: '/home/x/tracker', switchedOff: false, machineOff: true };
dom.window.__BUGDESK_CONFIG__ = {
    mode: 'bugs', app: 'bugdesk', humanAuthor: 'alice', agentAuthor: 'alice_agent',
    store: { kind: 'project', name: 'demo', hasBugs: true, hasBacklog: true, base: '/p/demo/' },
    tracker: { ...OFF },
};
const setTracker = (t) => { dom.window.__BUGDESK_CONFIG__.tracker = { ...t }; };

const calls = [];
let answer = { ok: true, preferences: { tracker: false }, tracker: OFF };
put('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: !!answer.ok, status: answer.ok ? 200 : 409, json: async () => answer };
});

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
};
const mod = (p) => import(pathToFileURL(join(UI, p)).href);

const tax = await mod('tiling/kind_taxonomy.js');
const help = await mod('help/help_service.js');
const resolve = await mod('dashboards/resolve.js');
const identity = await mod('core/app_identity.js');
const setting = await mod('ticketdesk/tracker_setting.js');

console.log('\nThe Tracker switched off for you (STORY-0043)');

await t('no Tracker chip: Bugs and Backlog are the top bar, so F1 and F2 are theirs', () => {
    assert.equal(tax.MERGED_TRACKER, false);
    assert.deepEqual(tax.taxonomy.topNavEntries().map((e) => e.kind), ['queues', 'backlog']);
    // Kept as kinds, without a chip, so a saved tracker tab says it is switched
    // off rather than being dropped from the layout.
    for (const k of ['tracker', 'tracker-tickets', 'tracker-item', 'tracker-new', 'tracker-dashboard']) {
        const meta = tax.taxonomy.meta(k);
        assert.ok(meta, `${k} is no longer a kind, so a saved tab of it is dropped`);
        assert.ok(!meta.isTopNav, `${k} is a chip`);
        assert.equal(meta.topNav, 'home');
    }
    assert.deepEqual([...tax.DASHBOARD_SECTIONS], ['bugs', 'backlog'], 'the Tracker still has a dashboards rail');
});

await t('the help offers no Tracker topic, and its pages and keys leave it out', async () => {
    const svc = help.getHelpService();
    assert.ok(!('tracker' in svc.getTopics()), 'the Tracker topic is offered');
    assert.deepEqual(svc.searchTopics('ticketdesk'), [], 'search still finds the Tracker topic');
    await assert.rejects(svc.loadTopic('tracker'), /Unknown help topic/);
    const md = async (id) => (await svc.loadTopic(id)).markdown;
    const start = await md('getting-started');
    assert.ok(!start.includes('| **Tracker** |'), 'Getting started lists the Tracker chip');
    assert.match(start, /The Tracker is switched off \(Settings › You › Behaviour › Tracker\)/);
    assert.ok(!/tracker\) plus every command/.test(start), 'the palette still searches the tracker');
    const keys = await md('keyboard-shortcuts');
    assert.match(keys, /\(Bugs, Backlog\) \| \*\*F1 … F2\*\* \|/);
    assert.ok(!/F1 … F3/.test(keys));
    const dash = await md('dashboards');
    assert.ok(!/Tracker|tracker tickets/.test(dash), 'Dashboards still names the Tracker');
});

await t('every help edit still matches its topic, so none can silently stop applying', () => {
    for (const [id, edits] of Object.entries(help.TRACKER_OFF_EDITS)) {
        for (const [from] of edits) assert.ok(help.HELP_TOPICS[id].markdown.includes(from), `${id} no longer says: ${from}`);
    }
});

await t('a tile over tracker records says the Tracker is switched off, and where to switch it on', () => {
    const r = resolve.check(null, { source: 'tracker', plot: 'count', field: 'assignee' });
    assert.match(r.empty, /switched off for you/);
    assert.match(r.empty, /Settings › You › Behaviour › Tracker/);
    assert.match(identity.trackerOffReason(), /switched off for you/);
});

await t('switched off for the machine, the note names projects.toml', () => {
    setTracker(MACHINE_OFF);
    try {
        assert.match(resolve.check(null, { source: 'tracker' }).empty, /enabled = false under \[tracker\] in projects\.toml/);
    } finally { setTracker(OFF); }
});

await t('with the Tracker on, the help lists it again (F1 … F3) and offers its topic', async () => {
    setTracker(ON);
    try {
        const svc = new help.HelpService();
        assert.ok('tracker' in svc.getTopics());
        assert.match((await svc.loadTopic('keyboard-shortcuts')).markdown, /F1 … F3/);
        assert.match((await svc.loadTopic('tracker')).markdown, /Settings › You › Behaviour › Tracker/);
        assert.equal(identity.trackerOffReason(), null);
    } finally { setTracker(OFF); }
});

await t('the switch: on and changeable normally, off when you switched it off', () => {
    assert.deepEqual(setting.trackerSwitchState({ mode: 'bugs', tracker: ON }), { offered: true, on: true, disabled: false, note: '' });
    assert.deepEqual(setting.trackerSwitchState({ mode: 'bugs', tracker: OFF }), { offered: true, on: false, disabled: false, note: '' });
});

await t('the switch: disabled under projects.toml\'s hard off and with no tracker; not offered in TicketDesk', () => {
    const hard = setting.trackerSwitchState({ mode: 'bugs', tracker: MACHINE_OFF });
    assert.equal(hard.on, false); assert.equal(hard.disabled, true); assert.match(hard.note, /projects\.toml/);
    const none = setting.trackerSwitchState({ mode: 'bugs', tracker: { available: false, path: null } });
    assert.equal(none.disabled, true); assert.match(none.note, /No tracker is set up/);
    assert.equal(setting.trackerSwitchState({ mode: 'tracker', tracker: { available: true, path: '/x' } }).offered, false);
});

const host = document.createElement('div');
document.body.appendChild(host);
const toggle = () => host.querySelector('[data-slot="tracker-toggle"]');
const tick = () => new Promise((r) => setTimeout(r, 0));

await t('Cancel on the confirm leaves the Tracker as it was and saves nothing', async () => {
    let asked = null, reloaded = 0;
    const stop = setting.mountTrackerSetting(host, {
        confirm: async (o) => { asked = o; return false; }, reload: () => { reloaded++; },
    });
    assert.equal(toggle().getAttribute('aria-checked'), 'false', 'switched off, the switch shows on');
    const before = calls.length;
    toggle().click();
    await tick(); await tick();
    assert.match(asked.title, /Switch the Tracker on/);
    assert.match(asked.message, /reloads/);
    assert.equal(calls.length, before, 'saved on Cancel');
    assert.equal(reloaded, 0);
    stop();
});

await t('OK saves your preference (on clears it back to the default) and reloads', async () => {
    let reloaded = 0;
    answer = { ok: true, preferences: {}, tracker: ON };
    const stop = setting.mountTrackerSetting(host, { confirm: async () => true, reload: () => { reloaded++; } });
    toggle().click();
    await tick(); await tick(); await tick();
    const last = calls.at(-1);
    assert.equal(last.method, 'POST');
    assert.match(last.url, /personal\/preferences$/);
    assert.deepEqual(last.body, { tracker: null });
    assert.equal(reloaded, 1);
    stop();
});

await t('switching off asks with "nothing is deleted" and posts tracker: false', async () => {
    let asked = null, reloaded = 0;
    dom.window.__BUGDESK_CONFIG__.tracker = { ...ON };
    const cfg = (await mod('ticketdesk/instance.js')).CONFIG;
    cfg.tracker = { ...ON };
    answer = { ok: true, preferences: { tracker: false }, tracker: OFF };
    const stop = setting.mountTrackerSetting(host, { confirm: async (o) => { asked = o; return true; }, reload: () => { reloaded++; } });
    assert.equal(toggle().getAttribute('aria-checked'), 'true');
    toggle().click();
    await tick(); await tick(); await tick();
    assert.match(asked.message, /Nothing is deleted/);
    assert.deepEqual(calls.at(-1).body, { tracker: false });
    assert.equal(reloaded, 1);
    stop();
});

await t('a refused save says so and does not reload', async () => {
    let reloaded = 0;
    answer = { ok: false, error: 'no user profile yet' };
    const stop = setting.mountTrackerSetting(host, { confirm: async () => true, reload: () => { reloaded++; } });
    toggle().click();
    await tick(); await tick(); await tick();
    assert.equal(reloaded, 0);
    assert.match(host.textContent, /Not saved: no user profile yet/);
    stop();
});

await t('with projects.toml\'s hard off the switch cannot be pressed', async () => {
    const cfg = (await mod('ticketdesk/instance.js')).CONFIG;
    cfg.tracker = { ...MACHINE_OFF };
    const stop = setting.mountTrackerSetting(host, { confirm: async () => { throw new Error('asked'); } });
    assert.equal(toggle().disabled, true);
    assert.match(host.textContent, /enabled = false under \[tracker\] in projects\.toml/);
    stop();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
