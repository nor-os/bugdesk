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

await t('a story may hang under an epic only', () =>
    assert.deepEqual(picker.parentTypesFor('story'), ['epic']));
await t('a task may hang under an epic or a story', () =>
    assert.deepEqual(picker.parentTypesFor('task'), ['epic', 'story']));
await t('an epic has no parent', () =>
    assert.deepEqual(picker.parentTypesFor('epic'), []));
await t('an epic offers stories as children', () =>
    assert.deepEqual(picker.childTypesFor('epic'), ['story']));
await t('a story offers tasks', () =>
    assert.deepEqual(picker.childTypesFor('story'), ['task']));
await t('a task offers nothing', () =>
    assert.deepEqual(picker.childTypesFor('task'), []));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
