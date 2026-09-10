/**
 * test-dom.mjs — the checks that need a DOM.
 *
 * `npm test`'s other half exercises pure logic. This half mounts real components
 * into jsdom and asserts what actually lands in the document, because the bugs
 * that have hurt most in this project were not logic errors — they were a
 * control that rendered but did nothing, a row that never appeared, a handler
 * attached to the wrong element. None of those are visible to a unit test over
 * a pure function, and without a browser they were invisible full stop.
 *
 * jsdom is not a browser: no layout, no real paint. So these assert STRUCTURE
 * and BEHAVIOUR — "the row exists", "clicking it calls the thing", "the value
 * survives the round trip" — never appearance.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'ui', 'js');

// Node has no import map; write the equivalent as alias packages. Same files
// ui/index.html maps `@flexdesk/*` to.
for (const name of ['core', 'wm']) {
    const dir = join(ROOT, 'node_modules', '@flexdesk', name);
    if (existsSync(join(dir, 'index.js'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(
        { name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
    writeFileSync(join(dir, 'index.js'),
        `export * from '${join(ROOT, 'ui', 'vendor', 'flexdesk', `${name}.js`)}';\n`);
}

// A real URL, not the default "about:blank": jsdom refuses localStorage on an
// opaque origin, and the settings store reads it at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
});
// Node 24 defines some of these as getter-only on globalThis, so assignment
// throws; defineProperty replaces them regardless of how they were declared.
const put = (key, value) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
put('window', dom.window);
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node',
                   'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    put(key, dom.window[key]);
}
put('localStorage', dom.window.localStorage);
put('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
// jsdom implements no layout, so it ships no ResizeObserver. Components that
// merely OBSERVE size (the overlay scrollbar, the top-bar responsive collapse)
// must still construct without throwing; a stub that never fires is exactly
// right for structural assertions, which is all this file makes.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
put('ResizeObserver', NoopResizeObserver);
dom.window.ResizeObserver = NoopResizeObserver;
// jsdom HAS MutationObserver on its window, but not on the Node global these
// modules resolve against.
for (const key of ['MutationObserver', 'IntersectionObserver']) {
    if (dom.window[key]) put(key, dom.window[key]);
}
// jsdom implements no layout, so scrolling is a no-op rather than an error.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
if (!globalThis.IntersectionObserver) {
    class NoopIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
    put('IntersectionObserver', NoopIntersectionObserver);
}
put('cancelAnimationFrame', (id) => clearTimeout(id));
dom.window.__BUGDESK_CONFIG__ = {
    humanAuthor: 'alice', agentAuthor: 'alice_agent',
    collaborators: [{ name: 'alice', agent: 'alice_agent' }, { name: 'bob', agent: 'bob_agent' }],
    assignees: ['alice', 'alice_agent', 'bob', 'bob_agent'],
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── the Collaborators row in Settings ───────────────────────────────
 *
 * A roster is a list of records, so it is edited by a dialog rather than a
 * scalar control — the settings row is a BUTTON (`type: 'action'`). That is an
 * unusual enough shape in this page that "it renders and its click reaches the
 * handler" is worth asserting rather than assuming. */

console.log('\nSettings › Collaborators');

const settings = await import(join(UI, 'core', 'settings.js'));
settings.registerSettings(settings.BUGDESK_SETTINGS_SLICE);

// A STALE browser-local name, seeded before anything imports ticketdesk/data.js
// — which is the only moment it could win. `__BUGDESK_CONFIG__` above says the
// profile on disk is `alice`; this says somebody typed `stale-bob` into
// Settings once, long ago. The profile has to win, and the rest of this file
// then runs as proof that nothing downstream picked the stale value up.
settings.setSetting('bugdesk.humanName', 'stale-bob');
settings.setSetting('bugdesk.agentName', 'stale-bob_agent');

await t('the setting is registered under General › Authorship', () => {
    const row = settings.getSettingsByCategory('general')
        .find((r) => r.path === 'bugdesk.collaborators');
    assert.ok(row, 'bugdesk.collaborators is not in the general category');
    assert.equal(row.type, 'action');
    assert.equal(row.group, 'Authorship');
    assert.equal(typeof row.onClick, 'function');
});

const { SettingsPage } = await import(join(UI, 'ui', 'pages', 'settings_page.js'));

await t('the row RENDERS, with a button', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = new SettingsPage({ embedded: true });
    page.mount(host);
    await tick();

    const row = host.querySelector('[data-path="bugdesk.collaborators"]');
    assert.ok(row, 'no settings row rendered for bugdesk.collaborators');
    const btn = row.querySelector('[data-action="setting-action"]');
    assert.ok(btn, 'the row rendered without its button');
    assert.match(btn.textContent, /collaborator/i);
    page.dispose();
    host.remove();
});

await t('clicking the button reaches the schema onClick', async () => {
    // The click handler looks the def up by path at click time; a row whose
    // button renders but whose handler cannot find its onClick is exactly the
    // "does nothing" failure this asserts against.
    const schema = settings.getSchema();
    const original = schema['bugdesk.collaborators'].onClick;
    let fired = 0;
    schema['bugdesk.collaborators'].onClick = () => { fired++; };
    try {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const page = new SettingsPage({ embedded: true });
        page.mount(host);
        await tick();
        host.querySelector('[data-path="bugdesk.collaborators"] [data-action="setting-action"]')
            .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await tick();
        assert.equal(fired, 1, 'the button click did not reach onClick');
        page.dispose();
        host.remove();
    } finally {
        schema['bugdesk.collaborators'].onClick = original;
    }
});

/* ── the choice control ──────────────────────────────────────────────
 *
 * It REPLACES the element it is given and keeps it as a hidden value carrier,
 * which is the whole reason it can drop into existing masks — every
 * `[data-f="…"]` read and every delegated `change` listener has to keep
 * working. That contract is invisible until it breaks. */

console.log('\nChoice control');

const { attachSelect } = await import(join(UI, 'ticketdesk', 'select_field.js'));

const mountSelect = (opts) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = '<select class="ea-tin" data-f="thing" name="thing"></select>';
    const handle = attachSelect(host.querySelector('[data-f="thing"]'), opts);
    return { host, handle, cleanup: () => { handle.destroy(); host.remove(); } };
};

await t('the carrier keeps the name and data attributes', () => {
    const { host, cleanup } = mountSelect({ options: ['a', 'b'], value: 'a' });
    const carrier = host.querySelector('[data-f="thing"]');
    assert.ok(carrier, 'the [data-f] hook did not survive');
    assert.equal(carrier.getAttribute('name'), 'thing');
    assert.equal(carrier.value, 'a', 'the value is not readable the old way');
    cleanup();
});

await t('picking an option updates the carrier and fires change', async () => {
    const { host, handle, cleanup } = mountSelect({ options: ['a', 'b', 'c'], value: 'a' });
    let changes = 0;
    // Delegated on the container, exactly as the masks listen.
    host.addEventListener('change', (e) => { if (e.target.matches('[data-f]')) changes++; });
    host.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    const panel = document.querySelector('.bd-sel__panel');
    assert.ok(panel, 'the popup did not open');
    panel.querySelector('[data-value="c"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(handle.value(), 'c');
    assert.equal(host.querySelector('[data-f="thing"]').value, 'c');
    assert.equal(changes, 1, 'no change event reached a delegated listener');
    cleanup();
});

await t('the popup closes after a pick', async () => {
    const { host, cleanup } = mountSelect({ options: ['a', 'b'], value: 'a' });
    host.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    document.querySelector('.bd-sel__panel [data-value="b"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(document.querySelector('.bd-sel__panel'), null, 'the popup stayed open');
    cleanup();
});

await t('allowNew offers the typed value, and picking it commits', async () => {
    const { host, handle, cleanup } = mountSelect({ options: ['foundation'], value: '', allowNew: true });
    host.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    const panel = document.querySelector('.bd-sel__panel');
    const search = panel.querySelector('.bd-sel__search');
    assert.ok(search, 'allowNew did not render a search box');
    search.value = 'hardening';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const create = panel.querySelector('[data-new]');
    assert.ok(create, 'no "use this new value" row appeared');
    create.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(handle.value(), 'hardening');
    cleanup();
});

await t('WITHOUT allowNew a typed value cannot be committed', async () => {
    const { host, cleanup } = mountSelect({ options: ['a', 'b'], value: 'a' });
    host.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    const panel = document.querySelector('.bd-sel__panel');
    assert.equal(panel.querySelector('[data-new]'), null,
        'a value could be invented in a closed vocabulary');
    cleanup();
});

await t('the search box filters', async () => {
    const many = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    const { host, cleanup } = mountSelect({ options: many, value: 'alpha' });
    host.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    const panel = document.querySelector('.bd-sel__panel');
    const search = panel.querySelector('.bd-sel__search');
    assert.ok(search, 'a long list rendered no search box');
    search.value = 'et';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const shown = [...panel.querySelectorAll('[data-value]')].map((el) => el.dataset.value);
    // Matches anywhere, not just the prefix — a datalist's prefix-only matching
    // is precisely what this control replaced.
    assert.deepEqual(shown, ['beta', 'zeta', 'eta', 'theta']);
    cleanup();
});

/* ── hiding a form row ───────────────────────────────────────────────
 *
 * THE regression this file exists for. `el.hidden = true` carries only the UA
 * stylesheet's `display: none`, which any class rule with its own `display`
 * beats — and `.td-field` is a grid. So the New item page marked its
 * type-specific rows hidden, every line of JavaScript agreed they were hidden,
 * and they stayed on screen. jsdom applies no stylesheets, so it cannot see
 * the CSS conflict; what it CAN check is that the fix is in place — the inline
 * style that wins regardless of what any sheet says. */

console.log('\nRow visibility');

const { setRowVisible } = await import(join(UI, 'ticketdesk', 'select_field.js'));

await t('hiding sets BOTH the attribute and an inline display', () => {
    const el = document.createElement('div');
    setRowVisible(el, false);
    assert.equal(el.hidden, true, 'the attribute is missing');
    assert.equal(el.style.display, 'none',
        'no inline display — a class rule with its own display would win');
});

await t('showing clears the inline style rather than forcing a display', () => {
    const el = document.createElement('div');
    setRowVisible(el, false);
    setRowVisible(el, true);
    assert.equal(el.hidden, false);
    // Empty, not 'block': forcing one would override the grid/flex the class
    // wanted and quietly break the row's layout.
    assert.equal(el.style.display, '');
});

await t('a missing element is survivable', () => setRowVisible(null, false));

/* ── which types may hold which ──────────────────────────────────── */

console.log('\nHierarchy rules');

const picker = await import(join(UI, 'ticketdesk', 'item_picker.js'));

// Conventional level FIRST in every list — the picker preselects the whole
// list, but the New item form and "Add child" take [0] as the default type.
await t('a story hangs under an epic, or straight off a project', () =>
    assert.deepEqual(picker.parentTypesFor('story'), ['epic', 'project']));
await t('a task hangs under a story, an epic or a project', () =>
    assert.deepEqual(picker.parentTypesFor('task'), ['story', 'epic', 'project']));
await t('an epic hangs under a project', () =>
    assert.deepEqual(picker.parentTypesFor('epic'), ['project']));
await t('a project is the top of the tree', () =>
    assert.deepEqual(picker.parentTypesFor('project'), []));
await t('a project offers epics, stories and tasks as children', () =>
    // "a story and a task can be added directly to a project": the epic in
    // between is often ceremony, so the picker must not require one.
    assert.deepEqual(picker.childTypesFor('project'), ['epic', 'story', 'task']));
await t('an epic offers stories as children', () =>
    assert.deepEqual(picker.childTypesFor('epic'), ['story']));
await t('a story offers tasks', () =>
    assert.deepEqual(picker.childTypesFor('story'), ['task']));
await t('a task offers nothing', () =>
    assert.deepEqual(picker.childTypesFor('task'), []));

await t('every preselected type gets a chip to unselect it', async () => {
    // Parenting an epic preselects `project`, which a plain backlog does not
    // offer. Without a chip for it the dialog shows nothing and there is no
    // control that explains why or lets the user widen the filter.
    const done = picker.openItemPicker({ types: ['project'], title: 'Parent for this epic' });
    await tick();
    const chips = [...document.querySelectorAll('.bd-picker__chip')].map((c) => c.dataset.type);
    const on = [...document.querySelectorAll('.bd-picker__chip--on')].map((c) => c.dataset.type);
    document.querySelector('.bd-picker [data-a="cancel"]').click();
    assert.equal(await done, null);
    assert.ok(chips.includes('project'), `chips were ${JSON.stringify(chips)}`);
    assert.deepEqual(on, ['project']);
});

await t('parent and child rules are exact mirrors', () => {
    // The two functions are read from opposite ends of the same operation
    // ("set my parent" / "add a child"), so a pair that disagrees means one
    // surface offers a move the other refuses.
    for (const parent of ['project', 'epic', 'story', 'task']) {
        for (const child of picker.childTypesFor(parent)) {
            assert.ok(picker.parentTypesFor(child).includes(parent),
                `${parent} offers a ${child} child, but a ${child} may not sit under a ${parent}`);
        }
    }
});

/* ── who you are ─────────────────────────────────────────────────────
 *
 * "Change your name" wrote the profile on disk and nothing on screen moved,
 * which is indistinguishable from a broken button. Two separate causes, both
 * regression-tested here:
 *
 *   1. the browser-local setting OUTRANKED the profile, permanently — so once
 *      anyone had typed a name into Settings, no later change could ever take
 *      effect, not even across a reload;
 *   2. nothing applied a confirmed change to the running page.
 */

console.log('\nIdentity');

const identity = await import(join(UI, 'ticketdesk', 'first_run.js'));
const ticketData = await import(join(UI, 'ticketdesk', 'data.js'));

await t('the profile on disk outranks a stale browser-local name', () => {
    // The bug: this asserted 'stale-bob', through every reload, for ever.
    assert.equal(ticketData.HUMAN_AUTHOR, 'alice');
    assert.equal(ticketData.AGENT_AUTHOR, 'alice_agent');
});

await t('the stored setting is still the fallback when no bridge answered', () => {
    // Precedence, not deletion: with no `__BUGDESK_CONFIG__` the local value is
    // the only thing left that knows who you are.
    const slot = 'bugdesk.humanName';
    assert.equal(settings.getSetting(slot), 'stale-bob');
});

await t('applying an identity re-points the config every module reads', async () => {
    await identity.applyIdentity(
        { humanAuthor: 'carol', agentAuthor: 'carol_agent', user: 'carol' });
    assert.equal(window.__BUGDESK_CONFIG__.humanAuthor, 'carol');
    assert.equal(window.__BUGDESK_CONFIG__.agentAuthor, 'carol_agent');
});

await t('...and mirrors it into Settings, so no stale value can be left behind', () => {
    assert.equal(settings.getSetting('bugdesk.humanName'), 'carol');
    assert.equal(settings.getSetting('bugdesk.agentName'), 'carol_agent');
});

await t('...and announces it, so the chip in the corner can repaint', async () => {
    const seen = [];
    const bus = { emit: (name, payload) => seen.push([name, payload]) };
    await identity.applyIdentity({ humanAuthor: 'dave', agentAuthor: 'dave_agent' }, { eventBus: bus });
    assert.deepEqual(seen.map(([n]) => n), ['bugdesk:identity-changed']);
    assert.equal(seen[0][1].humanAuthor, 'dave');
});

await t('an unchanged name reports no change, so nothing offers a pointless reload', async () => {
    const { humanChanged, agentChanged } = await identity.applyIdentity(
        { humanAuthor: 'dave', agentAuthor: 'dave_agent' });
    assert.equal(humanChanged, false);
    assert.equal(agentChanged, false);
});

await t('renaming only the agent still counts as a change', async () => {
    // This used to be compared by PROFILE SLUG, which does not move when you
    // rename the agent or fix the capitalisation of your own name — so the
    // reload offer silently never appeared for either.
    const { humanChanged, agentChanged } = await identity.applyIdentity(
        { humanAuthor: 'dave', agentAuthor: 'claude' });
    assert.equal(humanChanged, false);
    assert.equal(agentChanged, true);
});

await t('the write-through does not echo a change that came from the bridge', async () => {
    // applyIdentity mirrors the confirmed pair into Settings, which fires the
    // settings:changed events the write-through listens to. Without a guard
    // that is a second POST of what the server just told us, and a "signed in
    // as…" toast at somebody who did not just sign in.
    const posts = [];
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url, opts) => {
        posts.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true, humanAuthor: 'dave', agentAuthor: 'claude' }) };
    });
    const handlers = new Map();
    const bus = {
        on: (name, fn) => { handlers.set(name, fn); return { dispose() {} }; },
        emit: () => {},
    };
    identity.installAuthorshipWriteThrough({ eventBus: bus, getSetting: settings.getSetting });
    await handlers.get('settings:bugdesk.humanName:changed')();
    put('fetch', realFetchLocal);
    assert.deepEqual(posts, [], `posted ${JSON.stringify(posts)}`);
});

/* ── the children grid ───────────────────────────────────────────────
 *
 * jsdom has no layout, so it cannot see a wrapped grid — which is exactly how
 * the "green circle saying Done" got shipped: a sixth cell was added to a row
 * whose CSS declares five columns, so the status pill wrapped onto an implicit
 * row and landed in the 15px glyph column.
 *
 * What CAN be checked without layout is the arithmetic behind it: the number of
 * cells the template declares against the number the markup emits. That is the
 * whole bug, and it is checkable from the stylesheet text.
 */

console.log('\nChildren row shape');

const { readFileSync: readCss } = await import('node:fs');
const backlogCss = readCss(join(ROOT, 'ui', 'css', 'backlog.css'), 'utf8');

/** The column count `grid-template-columns` declares for one selector. */
const gridColumns = (css, selector) => {
    const block = css.split(selector + ' {')[1];
    if (!block) return null;
    const decl = /grid-template-columns:\s*([^;]+);/.exec(block.split('}')[0]);
    if (!decl) return null;
    // minmax(0, 90px) is ONE column — collapse the parenthesised parts first,
    // or its comma reads as a column break.
    return decl[1].replace(/\([^)]*\)/g, 'x').trim().split(/\s+/).length;
};

await t('the children row declares a column for every cell it renders', () => {
    const declared = gridColumns(backlogCss, '.bd-childrow');
    assert.ok(declared, 'no grid-template-columns for .bd-childrow');
    // glyph, reference, title, assignee, points-or-due, status
    assert.equal(declared, 6,
        `.bd-childrow renders 6 cells but declares ${declared} columns — `
        + 'the extras wrap onto an implicit row');
});

/* ── the Tracker dashboard ───────────────────────────────────────────
 *
 * Mounted for real, over a store loaded through the actual `loadBacklog()` path
 * (fetch is stubbed; everything downstream of it is the shipping code). So this
 * exercises mapItem's derived fields — projectRef, dueState — and the page that
 * reads them, together.
 *
 * The page is mode-AGNOSTIC: only its registration in install.js is gated on
 * tracker mode, so it mounts here without a second process. What the dashboard
 * says about a store is the thing worth pinning down, and most of it is about
 * what it must NOT say: a closed item is not overdue however old its date, and
 * an undated item is not "on time".
 */

console.log('\nTracker dashboard');

const backlogData = await import(join(UI, 'ticketdesk', 'backlog_data.js'));

// Dates relative to the real today — dueState reads the reader's own clock, so
// a fixture with literal dates would start failing on a particular morning.
const shift = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

const FIXTURE = [
    { id: 1, type: 'project', title: 'Vendor migration', status: 'in-progress',
      parent: 0, assignee: 'alice', reporter: 'alice', due: shift(60), criteria: [] },
    { id: 2, type: 'story', title: 'Finance feed cutover', status: 'in-progress',
      parent: 1, assignee: 'bob', reporter: 'alice', due: shift(-9), criteria: [] },
    { id: 3, type: 'task', title: 'DPA to legal', status: 'done',
      parent: 2, assignee: 'bob', reporter: 'alice', due: shift(-40), criteria: [] },
    { id: 4, type: 'story', title: 'Operations feed cutover', status: 'draft',
      parent: 1, assignee: 'bob', reporter: 'carol', due: shift(3), criteria: [] },
    { id: 5, type: 'task', title: 'Confirm analytics owner', status: 'draft',
      parent: 1, assignee: '', reporter: 'alice', due: '', criteria: [] },
];

const realFetch = globalThis.fetch;
put('fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/api/backlog')) {
        return { ok: true, json: async () => ({ ok: true, items: FIXTURE }) };
    }
    if (path.endsWith('/api/backlog/meta')) {
        return { ok: true, json: async () => ({ ok: true, phases: ['q4'] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
});
await backlogData.loadBacklog();

await t('the store derives an owning project for every descendant', () => {
    const byId = new Map(backlogData.ITEMS.map((i) => [i.id, i]));
    assert.equal(byId.get(1).projectRef, 'PROJ-0001');   // a project answers for itself
    assert.equal(byId.get(3).projectRef, 'PROJ-0001');   // two levels down
    assert.equal(byId.get(2).ref, 'STORY-0002');
});

await t('the delete flow sees the same subtree the bridge deletes', async () => {
    // The client computes descendants to WORD the confirmation ("PROJ-0001 has
    // 4 items under it"); the bridge computes them again to act. The two have
    // to agree, or the dialog understates what is about to go.
    const { descendantsOf } = await import(join(UI, 'ticketdesk', 'delete_item.js'));
    assert.deepEqual(descendantsOf(1).map((i) => i.id).sort(), [2, 3, 4, 5]);
    assert.deepEqual(descendantsOf(2).map((i) => i.id), [3]);
    assert.deepEqual(descendantsOf(3), [], 'a leaf claims descendants');
});

// The picker reads the LIVE store, so these belong after the fixture above
// rather than up with the hierarchy rules, which are pure functions.
await t('the picker hides finished work, and says how much', async () => {
    // A store accumulates closed items for ever; after a year they are most of
    // it, and they push the live ones you were looking for off the screen.
    const done = picker.openItemPicker({});
    await tick();
    const refs = () => [...document.querySelectorAll('.bd-picker__ref')].map((e) => e.textContent);
    // TASK-0003 is `done` in the fixture; everything else is open.
    assert.ok(!refs().includes('TASK-0003'), `closed item listed: ${refs().join(', ')}`);
    assert.match(document.querySelector('[data-slot="count"]').textContent, /1 closed hidden/);

    // ...and the chip brings them back.
    document.querySelector('[data-closed]').click();
    assert.ok(refs().includes('TASK-0003'), 'the Closed chip did not reveal it');
    assert.ok(!/closed hidden/.test(document.querySelector('[data-slot="count"]').textContent));

    document.querySelector('.bd-picker [data-a="cancel"]').click();
    assert.equal(await done, null);
});

await t('the item already chosen is never hidden, whatever its status', async () => {
    // Otherwise the field it is filling looks empty the moment the record it
    // points at is closed.
    const done = picker.openItemPicker({ current: 3 });
    await tick();
    const refs = [...document.querySelectorAll('.bd-picker__ref')].map((e) => e.textContent);
    assert.ok(refs.includes('TASK-0003'), 'the current value was filtered out');
    document.querySelector('.bd-picker [data-a="cancel"]').click();
    await done;
});

const { createTrackerContent } = await import(join(UI, 'ticketdesk', 'tracker_pages.js'));

/* A WM stand-in that models the one thing these assertions are about: tiles
 * exist, a split creates one, and navigating an existing tile does not. */
const opened = [];
const panes = new Set();
let paneSeq = 0;
const mountDashboard = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const ctx = {
        leafId: 'dashboard',
        wm: {
            desktops: { active: () => ({ tree: { get: (id) => (panes.has(id) ? { id } : null) } }) },
            navigate: (kind, props, opts) => {
                opened.push({ kind, props, dest: opts?.dest, into: opts?.ctx?.leafId });
                if (opts?.dest !== 'split-h') return opts?.ctx?.leafId || null;
                const id = `pane${++paneSeq}`;
                panes.add(id);
                return id;
            },
            openInPrimary: (kind, props) => opened.push({ how: 'primary', kind, props }),
            openInTabFromContext: (_c, kind, props) => opened.push({ how: 'tab', kind, props }),
        },
    };
    const handle = createTrackerContent({ eventBus: null }).tracker(host, {}, ctx);
    return { host, handle };
};

const sectionRefs = (host, sec) =>
    [...host.querySelectorAll(`[data-sec="${sec}"] [data-open]`)]
        .map((el) => el.querySelector('.tk-row__ref')?.textContent.trim());

const board = mountDashboard();

await t('every section renders, empty or not', () => {
    for (const sec of ['overdue', 'soon', 'people', 'gaps']) {
        assert.ok(board.host.querySelector(`[data-sec="${sec}"]`), `no ${sec} section`);
    }
});

await t('an overdue item is listed, with how late it is and who has it', () => {
    assert.deepEqual(sectionRefs(board.host, 'overdue'), ['STORY-0002']);
    const row = board.host.querySelector('[data-sec="overdue"] [data-open]');
    assert.match(row.textContent, /9 days late/);
    assert.match(row.textContent, /bob/);
});

await t('a CLOSED item is never overdue, however old its date', () =>
    // TASK-0003 is 40 days past its date and done. A date that passed after the
    // work was delivered must not burn red forever.
    assert.ok(!sectionRefs(board.host, 'overdue').includes('TASK-0003')));

await t('an item due inside the week is in "due soon", not in overdue', () => {
    assert.deepEqual(sectionRefs(board.host, 'soon'), ['STORY-0004']);
    assert.ok(!sectionRefs(board.host, 'overdue').includes('STORY-0004'));
});

await t('the gaps section holds what the tracker cannot answer', () => {
    // TASK-0005 has neither an assignee nor a date — one row, not two sections.
    assert.deepEqual(sectionRefs(board.host, 'gaps'), ['TASK-0005']);
    const row = board.host.querySelector('[data-sec="gaps"] [data-open]');
    assert.match(row.textContent, /nobody/);
    assert.match(row.textContent, /no date/);
});

await t('unassigned work gets a person row of its own', () => {
    const names = [...board.host.querySelectorAll('[data-who]')].map((el) => el.dataset.who);
    assert.ok(names.includes(''), `no "nobody" row among ${JSON.stringify(names)}`);
    assert.ok(names.includes('bob'));
});

await t('people are ordered worst-first, not alphabetically', () => {
    // bob holds the only overdue item; alice and "nobody" do not.
    const names = [...board.host.querySelectorAll('[data-who]')].map((el) => el.dataset.who);
    assert.equal(names[0], 'bob', `expected bob first, got ${JSON.stringify(names)}`);
});

await t('clicking a row opens the ticket BESIDE the dashboard, not over it', () => {
    // The reported bug: a click took the dashboard off screen. You clicked a
    // late ticket to see who had it and lost the list of everything else late.
    opened.length = 0;
    board.host.querySelector('[data-sec="overdue"] [data-open]').click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].kind, 'item');
    assert.equal(opened[0].props.id, '2');
    assert.equal(opened[0].dest, 'split-h', 'the dashboard was navigated away from');
});

await t('the next click REUSES that pane instead of splitting again', () => {
    // Otherwise every row costs a pane and the tracker is a sliver by the
    // fourth one.
    opened.length = 0;
    board.host.querySelector('[data-sec="soon"] [data-open]').click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].dest, 'origin');
    assert.equal(opened[0].into, 'pane1');
});

await t('closing that pane makes the next click open a fresh one', () => {
    panes.clear();
    opened.length = 0;
    board.host.querySelector('[data-sec="gaps"] [data-open]').click();
    assert.equal(opened[0].dest, 'split-h', 'navigated a tile that no longer exists');
});

await t('clicking a person opens their list beside the dashboard too', () => {
    opened.length = 0;
    board.host.querySelector('[data-who="bob"]').click();
    assert.equal(opened[0].kind, 'backlog');
    assert.match(JSON.stringify(opened[0].props.expr), /"bob"/);
    assert.equal(opened[0].into, 'pane2');
});

await t('the scope switch narrows to what I handed out', async () => {
    // "Assigned by me" reads REPORTER: STORY-0004 is carol's to chase, so it
    // leaves the board even though bob is doing it.
    board.host.querySelector('[data-scope="byme"]').click();
    await tick();
    assert.deepEqual(sectionRefs(board.host, 'soon'), []);
    assert.deepEqual(sectionRefs(board.host, 'overdue'), ['STORY-0002']);
    board.host.querySelector('[data-scope="all"]').click();
    await tick();
    assert.deepEqual(sectionRefs(board.host, 'soon'), ['STORY-0004']);
});

await t('the page tears down without throwing', () => {
    board.handle.destroy();
    board.host.remove();
});

put('fetch', realFetch);

/* ── dragging a record, and Ctrl-clicking one ────────────────────────
 *
 * Both gestures exist so a list can show you something WITHOUT going away, so
 * what is asserted is mostly where things do NOT land: a modified click must not
 * navigate the tile you are reading, and a drop must land in the tile under the
 * cursor rather than the focused one.
 *
 * jsdom implements no DataTransfer, so one is stubbed. Everything downstream of
 * it — the MIME type, the payload shape, the tile lookup — is the shipping code.
 */

console.log('\nDrag and Ctrl-click');

const dnd = await import(join(UI, 'ticketdesk', 'record_dnd.js'));

const makeTransfer = () => {
    const store = new Map();
    return {
        setData: (t, v) => store.set(t, String(v)),
        getData: (t) => store.get(t) ?? '',
        get types() { return [...store.keys()]; },
        effectAllowed: '', dropEffect: '',
    };
};
const fire = (target, type, dataTransfer) => {
    const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(ev);
    return ev;
};

await t('Ctrl and Cmd mean "open elsewhere"; Shift stays the table\'s own', () => {
    assert.equal(dnd.isModifiedOpen({ ctrlKey: true }), true);
    assert.equal(dnd.isModifiedOpen({ metaKey: true }), true);
    assert.equal(dnd.isModifiedOpen({}), false);
    // Shift is range-select, and the one selection gesture with no other home.
    assert.equal(dnd.isModifiedOpen({ ctrlKey: true, shiftKey: true }), false);
});

await t('the setting decides between a window and a background tab', () => {
    const calls = [];
    const wm = { navigate: (kind, props, opts) => calls.push({ kind, opts }) };

    settings.setSetting('bugdesk.modifierOpen', 'window');
    dnd.openModified(wm, 'item', { id: '7' });
    assert.equal(calls[0].opts.dest, 'window');

    settings.setSetting('bugdesk.modifierOpen', 'tab');
    dnd.openModified(wm, 'item', { id: '7' });
    // `transient` is what "without closing the current view" means: the tab is
    // added but not switched to, so the list stays in front.
    assert.equal(calls[1].opts.dest, 'main');
    assert.equal(calls[1].opts.newTab, true);
    assert.equal(calls[1].opts.transient, true);

    settings.setSetting('bugdesk.modifierOpen', 'window');
});

await t('the setting is read at CALL time, not at module load', () =>
    // A gesture that needs a reload before it obeys a preference is a gesture
    // people stop trusting.
    assert.equal(dnd.modifierOpenMode(), 'window'));

await t('a cell is marked draggable while it is still DETACHED', () => {
    // THE BUG: DataTable calls renderCell(td, ...) BEFORE appending the td to
    // its <tr>, so `td.parentElement` is null at that moment. Marking the row
    // through the cell's parent silently did nothing, and drag shipped working
    // on the dashboard (whose rows carry `draggable` in their markup) and
    // broken in both tables. The test builds the cell the way DataTable does.
    const td = document.createElement('td');
    assert.equal(td.parentElement, null, 'the fixture is not reproducing the bug');
    dnd.markDragCell(td, 'BUG-0042');
    assert.equal(td.draggable, true, 'the cell is not draggable');
    assert.equal(td.dataset.dragKey, 'BUG-0042');

    // ...and only once it is in a row does the delegated resolver find it.
    const tr = document.createElement('tr');
    tr.appendChild(td);
    const inner = document.createElement('span');
    td.appendChild(inner);
    assert.equal(inner.closest('[data-drag-key]')?.dataset.dragKey, 'BUG-0042');
});

await t('a row with no key is left alone', () => {
    const td = document.createElement('td');
    dnd.markDragCell(td, '');
    assert.equal(td.draggable, false);
    dnd.markDragCell(td, undefined);
    assert.equal(td.draggable, false);
});

await t('a DOMStringList of types is accepted, not thrown on', () => {
    // `dataTransfer.types` is a plain array in some engines and a DOMStringList
    // in others, and DOMStringList has no `.includes` — calling it directly
    // threw, which meant no preventDefault and therefore no drop, silently.
    const wm = {
        desktops: { active: () => ({ tree: { get: () => ({ content: { kind: 'backlog' } }) } }) },
        navigate: () => {},
    };
    const targets = dnd.installRecordDropTargets({ wm });
    const tile = document.createElement('div');
    tile.className = 'twm-leaf';
    tile.dataset.leafId = 'leafA';
    tile.innerHTML = '<div class="twm-leaf__body"></div>';
    document.body.appendChild(tile);

    // A types collection with no `.includes`, as older engines hand over.
    const listy = { length: 1, 0: dnd.RECORD_MIME, item: (i) => [dnd.RECORD_MIME][i] };
    Object.defineProperty(listy, Symbol.iterator, { value: [dnd.RECORD_MIME][Symbol.iterator] });
    const dt = { ...makeTransfer(), types: listy };
    const over = fire(tile.querySelector('.twm-leaf__body'), 'dragover', dt);
    assert.equal(over.defaultPrevented, true, 'the drop was refused on a DOMStringList');

    targets.destroy();
    tile.remove();
});

await t('dragging a dashboard row carries what would open it', () => {
    const board2 = mountDashboard();
    const row = board2.host.querySelector('[data-sec="overdue"] [data-open]');
    assert.equal(row.draggable, true, 'the row is not draggable');
    const dt = makeTransfer();
    fire(row, 'dragstart', dt);
    const payload = JSON.parse(dt.getData(dnd.RECORD_MIME));
    assert.equal(payload.kind, 'item');
    assert.equal(payload.props.id, '2');
    // The outside-the-app fallback: dropped into an editor it pastes as a ref.
    assert.equal(dt.getData('text/plain'), 'STORY-0002');
    fire(row, 'dragend', dt);
    board2.handle.destroy();
    board2.host.remove();
});

await t('a drop lands in the tile under the cursor', () => {
    const navigated = [];
    const kinds = { leafA: 'backlog', leafPanel: 'panel:left' };
    const wm = {
        desktops: { active: () => ({ tree: { get: (id) => ({ content: { kind: kinds[id] } }) } }) },
        navigate: (kind, props, opts) => navigated.push({ kind, props, into: opts?.ctx?.leafId }),
    };
    const targets = dnd.installRecordDropTargets({ wm });

    const tile = document.createElement('div');
    tile.className = 'twm-leaf';
    tile.dataset.leafId = 'leafA';
    tile.innerHTML = '<div class="twm-leaf__body"></div>';
    document.body.appendChild(tile);

    const dt = makeTransfer();
    dt.setData(dnd.RECORD_MIME, JSON.stringify({ kind: 'item', props: { id: '9' } }));
    const body = tile.querySelector('.twm-leaf__body');

    const over = fire(body, 'dragover', dt);
    assert.equal(over.defaultPrevented, true, 'the tile refused the drag');
    assert.ok(tile.classList.contains('twm-leaf--droptarget'), 'no drop affordance');

    fire(body, 'drop', dt);
    assert.equal(navigated.length, 1);
    assert.equal(navigated[0].into, 'leafA', 'the record did not land in the hovered tile');
    assert.equal(navigated[0].props.id, '9');
    assert.ok(!tile.classList.contains('twm-leaf--droptarget'), 'the affordance was left behind');

    targets.destroy();
    tile.remove();
});

await t('a panel refuses the drop — it is chrome, not a place for a record', () => {
    const navigated = [];
    const wm = {
        desktops: { active: () => ({ tree: { get: () => ({ content: { kind: 'panel:left' } }) } }) },
        navigate: (...a) => navigated.push(a),
    };
    const targets = dnd.installRecordDropTargets({ wm });

    const panel = document.createElement('div');
    panel.className = 'twm-leaf';
    panel.dataset.leafId = 'leafPanel';
    panel.innerHTML = '<div class="twm-leaf__body"></div>';
    document.body.appendChild(panel);

    const dt = makeTransfer();
    dt.setData(dnd.RECORD_MIME, JSON.stringify({ kind: 'item', props: { id: '9' } }));
    const over = fire(panel.querySelector('.twm-leaf__body'), 'dragover', dt);
    assert.equal(over.defaultPrevented, false, 'a panel offered itself as a drop target');
    assert.ok(!panel.classList.contains('twm-leaf--droptarget'));
    fire(panel.querySelector('.twm-leaf__body'), 'drop', dt);
    assert.equal(navigated.length, 0);

    targets.destroy();
    panel.remove();
});

await t('somebody else\'s drag is ignored entirely', () => {
    const wm = {
        desktops: { active: () => ({ tree: { get: () => ({ content: { kind: 'backlog' } }) } }) },
        navigate: () => assert.fail('navigated on a foreign drag'),
    };
    const targets = dnd.installRecordDropTargets({ wm });
    const tile = document.createElement('div');
    tile.className = 'twm-leaf';
    tile.dataset.leafId = 'leafA';
    tile.innerHTML = '<div class="twm-leaf__body"></div>';
    document.body.appendChild(tile);

    const dt = makeTransfer();
    dt.setData('text/uri-list', 'https://example.invalid');
    const over = fire(tile.querySelector('.twm-leaf__body'), 'dragover', dt);
    assert.equal(over.defaultPrevented, false);
    fire(tile.querySelector('.twm-leaf__body'), 'drop', dt);

    targets.destroy();
    tile.remove();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
