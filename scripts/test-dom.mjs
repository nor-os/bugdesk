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
for (const name of ['canvas', 'core', 'flow', 'host', 'wm', 'widgets']) {
    const dir = join(ROOT, 'node_modules', '@flexdesk', name);
    if (existsSync(join(dir, 'index.js'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(
        { name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
    writeFileSync(join(dir, 'index.js'),
        // Relative, so the alias works for Linux and Windows node alike.
        `export * from '../../../ui/vendor/flexdesk/${name}.js';\n`);
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
                   'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
                   // ticketdesk/pages.js reads location.hash at registration
                   // (the #ticket headless-verification hook).
                   'location']) {
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

/* ── Settings, sorted by who a change affects (STORY-0032) ─────────────
 *
 * The sidebar is two headed sections: "You" (your profile, this browser) and
 * "This project" (project.json / bugdesk.json, committed — everyone who pulls).
 * Every project editor is drawn on the page; none opens a window. These assert
 * what lands in the document, because "a row that renders but does nothing"
 * and "a heading over the wrong things" are exactly what a unit test misses.
 */

console.log('\nSettings, sorted by who a change affects');

const settings = await import(join(UI, 'core', 'settings.js'));
settings.registerSettings(settings.BUGDESK_SETTINGS_SLICE);

// A STALE browser-local name, seeded before anything imports ticketdesk/data.js
// — which is the only moment it could win. `__BUGDESK_CONFIG__` above says the
// profile on disk is `alice`; this says somebody typed `stale-bob` into
// Settings once, long ago. The profile has to win, and the rest of this file
// then runs as proof that nothing downstream picked the stale value up.
settings.setSetting('bugdesk.humanName', 'stale-bob');
settings.setSetting('bugdesk.agentName', 'stale-bob_agent');

const { SettingsPage } = await import(join(UI, 'ui', 'pages', 'settings_page.js'));

/** Mount the page, wait for it, and hand it back with its host. */
const mountSettings = async (opts = {}) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = new SettingsPage({ embedded: true, ...opts });
    page.mount(host);
    await tick();
    return { host, page, done: () => { page.dispose(); host.remove(); } };
};

await t('the sidebar is You (Profile, Behaviour), then This project (Record types, Workflow, Team, Alerts, Git)', async () => {
    const { host, done } = await mountSettings();
    const nav = [...host.querySelectorAll('.settings-page__sidebar .tree-view > *')].map((el) =>
        el.classList.contains('settings-page__section') ? `# ${el.textContent.trim()}` : el.dataset.category);
    assert.deepEqual(nav, ['# You', 'profile', 'behaviour',
        '# This project', 'recordTypes', 'workflow', 'team', 'alerts', 'git']);
    done();
});

await t('it opens on Profile, and General and Windows are gone', async () => {
    const { host, done } = await mountSettings();
    assert.equal(host.querySelector('.tree-item.selected')?.dataset.category, 'profile');
    assert.equal(host.querySelector('[data-category="general"]'), null, 'General is still listed');
    assert.equal(host.querySelector('[data-category="window"]'), null, 'Windows is still listed');
    for (const path of ['bugdesk.humanName', 'bugdesk.agentName']) {
        assert.ok(host.querySelector(`[data-path="${path}"]`), `${path} is not on Profile`);
    }
    assert.equal(host.querySelector('[data-action="reset-category"]'), null,
        'Reset on Profile would blank your name, which switches profile');
    assert.equal(host.querySelector('.settings-page__shared'), null, 'Profile is yours, not shared');
    done();
});

await t('Behaviour holds Ctrl-click, animate minimize and auto-save', async () => {
    const { host, page, done } = await mountSettings();
    page._switchCategory('behaviour');
    await tick(); await tick();
    for (const path of ['bugdesk.modifierOpen', 'window.animateMinimize']) {
        assert.ok(host.querySelector(`[data-path="${path}"]`), `${path} is not on Behaviour`);
    }
    assert.ok(host.querySelector('[data-panel="bugdesk.autosave"] [data-path="bugdesk.autosave"]'),
        'the auto-save row is not drawn');
    const titles = [...host.querySelectorAll('.settings-page__group-title')].map((h) => h.textContent.trim());
    assert.deepEqual(titles, ['Records', 'Saving', 'Windows']);
    done();
});

await t('every This project page says it applies to everyone, and no row opens a window', async () => {
    const schema = settings.getSchema();
    for (const path of settings.VISIBLE_SETTINGS) {
        assert.notEqual(schema[path].type, 'action', `${path} is still a button that opens a window`);
    }
    // Stand the editors in, so this asserts the page, not five editors' fetches.
    const project = ['bugdesk.recordTypes', 'bugdesk.workflow', 'bugdesk.collaborators', 'bugdesk.alerts', 'bugdesk.git'];
    const original = Object.fromEntries(project.map((p) => [p, schema[p].mount]));
    const seen = [];
    for (const p of project) schema[p].mount = (el) => { seen.push(p); return () => {}; };
    try {
        const { host, page, done } = await mountSettings();
        for (const [cat, path] of [['recordTypes', 'bugdesk.recordTypes'], ['workflow', 'bugdesk.workflow'],
            ['team', 'bugdesk.collaborators'], ['alerts', 'bugdesk.alerts'], ['git', 'bugdesk.git']]) {
            page._switchCategory(cat);
            await tick();
            assert.match(host.querySelector('.settings-page__shared')?.textContent || '',
                /everyone who pulls this repo/, `${cat} does not say it is shared`);
            assert.ok(host.querySelector(`[data-panel="${path}"]`), `${cat} does not draw its editor on the page`);
        }
        assert.deepEqual(seen, project);
        done();
    } finally {
        for (const p of project) schema[p].mount = original[p];
    }
});

await t('the filter still finds rows by name, and offers to go to a page', async () => {
    const { host, page, done } = await mountSettings();
    for (const [q, path] of [['Your name', 'bugdesk.humanName'], ['Ctrl-click', 'bugdesk.modifierOpen'],
        ['Collaborators', 'bugdesk.collaborators'], ['Auto-save', 'bugdesk.autosave'], ['Record types', 'bugdesk.recordTypes']]) {
        page._handleSearch(q);
        assert.ok(host.querySelector(`[data-path="${path}"]`), `filtering for "${q}" does not find ${path}`);
    }
    page._handleSearch('Collaborators');
    host.querySelector('[data-action="goto-category"][data-category="team"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(host.querySelector('.tree-item.selected')?.dataset.category, 'team');
    done();
});

await t('Settings can be opened on a page, with props for its editor', async () => {
    const schema = settings.getSchema();
    const original = schema['bugdesk.recordTypes'].mount;
    const got = [];
    schema['bugdesk.recordTypes'].mount = (el, props) => { got.push(props.store || null); return () => {}; };
    try {
        const { host, page, done } = await mountSettings({ category: 'recordTypes', panelProps: { store: 'backlog' } });
        await tick();
        assert.equal(host.querySelector('.tree-item.selected')?.dataset.category, 'recordTypes');
        page._switchCategory('profile'); await tick();
        page._switchCategory('recordTypes'); await tick();
        assert.deepEqual(got, ['backlog', null], 'the props are for the first time it is drawn only');
        done();
    } finally {
        schema['bugdesk.recordTypes'].mount = original;
    }
});

await t('Settings › Workflow is drawn on the page, and let go of when the page changes (STORY-0028, STORY-0030)', async () => {
    // A `type: 'panel'` row is mounted into the page, not opened in a window:
    // the editor gets its element, and its cleanup runs on leaving the page.
    const schema = settings.getSchema();
    const original = schema['bugdesk.workflow'].mount;
    const seen = [];
    schema['bugdesk.workflow'].mount = (el) => { seen.push(el.dataset.panel); return () => seen.push('cleanup'); };
    try {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const page = new SettingsPage({ embedded: true });
        page.mount(host);
        await tick();
        page._switchCategory('workflow');
        await tick();
        assert.ok(host.querySelector('[data-panel="bugdesk.workflow"]'), 'no panel element on the Workflow page');
        assert.equal(host.querySelector('[data-action="setting-action"]'), null, 'the Workflow page has no button to open a window');
        assert.equal(host.querySelector('[data-action="reset-category"]'), null, 'nothing on it for Reset to reset');
        assert.deepEqual(seen, ['bugdesk.workflow']);
        page._switchCategory('profile');
        await tick();
        assert.deepEqual(seen, ['bugdesk.workflow', 'cleanup'], 'the editor was not let go of');
        page._handleSearch('mass actions for ticked');
        const go = host.querySelector('[data-action="goto-category"][data-category="workflow"]');
        assert.ok(go, 'search finds the Workflow page and offers to go there');
        go.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await tick();
        assert.equal(seen.length, 3, 'going there mounts it again');
        page.dispose();
        await tick();
        assert.equal(seen.at(-1), 'cleanup', 'dispose lets go of it');
        host.remove();
    } finally {
        schema['bugdesk.workflow'].mount = original;
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

/* ── the settings page tells the truth about what it controls ──────── */

console.log('\nSettings');

await t('only settings this app actually reads are offered', () => {
    // The inherited schema describes a different application — ETL pipelines,
    // an AI assistant, an autosaving editor. BugDesk reads a fraction of it, so
    // the rest were controls that changed nothing, with no way for the user to
    // tell which was which.
    const gone = ['workspace.autosave.enabled', 'workspace.autosave.intervalSeconds',
                  'etl.parallelWorkers', 'ai.defaultMode', 'ai.maxToolCalls',
                  'editor.autosaveDelayMs', 'data.tablePageSize', 'projects.directory',
                  'notifications.durationMs', 'workspace.undoHistoryLimit',
                  'debug.logSettingsAccess', 'data.defaultResampleMethod',
                  // Read on boot, but by a module loader looking for an EcoSim
                  // modules directory a bug tracker does not have.
                  'modules.autoCreateDefaults'];
    for (const path of gone) {
        assert.ok(!settings.VISIBLE_SETTINGS.has(path), `${path} is still advertised`);
    }
    assert.ok(settings.VISIBLE_SETTINGS.has('bugdesk.humanName'));
});

const { readFileSync: rfSettings, readdirSync: rdSettings } = await import('node:fs');
const walkJs = (dir) => rdSettings(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkJs(join(dir, e.name)) : (e.name.endsWith('.js') ? [join(dir, e.name)] : []));
const allSource = walkJs(join(ROOT, 'ui', 'js')).map((f) => rfSettings(f, 'utf8')).join('\n');

await t('every offered setting is read somewhere, or is a button', () => {
    // The allow-list keeps itself honest: add a setting and this says list it;
    // delete the code that reads one and this says the row is now a lie. The
    // vendored FlexDesk counts: its managed windows read `window.*` for us.
    const vendor = join(ROOT, 'ui', 'vendor', 'flexdesk');
    const source = allSource + '\n' + rdSettings(vendor).filter((f) => f.endsWith('.js'))
        .map((f) => rfSettings(join(vendor, f), 'utf8')).join('\n');
    const schema = settings.getSchema();

    for (const path of settings.VISIBLE_SETTINGS) {
        const def = schema[path];
        assert.ok(def, `${path} is offered but not in the schema`);
        if (def.type === 'action' || def.type === 'panel') continue;      // a button or an editor, not a value
        assert.ok(source.includes(`getSetting('${path}'`) || source.includes(`getSetting("${path}"`),
            `${path} is offered in Settings but nothing reads it`);
    }
});

await t('every setting that IS read is offered', () => {
    // The other direction: a setting the app honours but never shows is a
    // preference the user cannot reach.
    const read = new Set();
    for (const m of allSource.matchAll(/getSetting\(['"]([^'"]+)['"]/g)) read.add(m[1]);
    for (const path of read) {
        if (path.startsWith('simulation')) continue;   // only named inside a comment
        assert.ok(settings.VISIBLE_SETTINGS.has(path) || settings.HIDDEN_SETTINGS.has(path),
            `${path} is read by the app but neither offered in Settings nor `
            + 'listed in HIDDEN_SETTINGS with a reason');
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

await t('at boot the confirmed names reach Settings, which used to show them empty', async () => {
    settings.setSetting('bugdesk.humanName', '');
    settings.setSetting('bugdesk.agentName', '');
    await identity.mirrorIdentityIntoSettings({ humanAuthor: 'erin', agentAuthor: 'erin_agent' });
    assert.equal(settings.getSetting('bugdesk.humanName'), 'erin');
    assert.equal(settings.getSetting('bugdesk.agentName'), 'erin_agent');
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

await t('the children list declares a column for every cell a row renders', () => {
    // The columns live on the LIST and every row is a subgrid of them, so a
    // column lines up across rows (BUG-0020); a grid per row sized its `auto`
    // columns per row.
    const declared = gridColumns(backlogCss, '.bd-children');
    assert.ok(declared, 'no grid-template-columns for .bd-children');
    // glyph, reference, title, assignee, points-or-due, status
    assert.equal(declared, 6,
        `.bd-childrow renders 6 cells but .bd-children declares ${declared} columns — `
        + 'the extras wrap onto an implicit row');
    const row = backlogCss.split('.bd-childrow {')[1]?.split('}')[0] || '';
    assert.match(row, /grid-template-columns:\s*subgrid/, '.bd-childrow is not a subgrid of the list');
    assert.match(row, /grid-column:\s*1\s*\/\s*-1/, '.bd-childrow does not span every column');
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

// The UI's API calls are RELATIVE (`api/backlog`) — each page is served under
// its project's prefix and talks to that project's store. A browser resolves
// them against the page's address before they reach the network; the fakes
// below match on the result, so they resolve them the same way.
const pageUrl = (url) => new URL(String(url), 'http://bugdesk.test/p/test/').pathname;

const realFetch = globalThis.fetch;
put('fetch', async (url) => {
    const path = pageUrl(url);
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
const { createBacklogContent } = await import(join(UI, 'ticketdesk', 'backlog_pages.js'));

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
                opened.push({ kind, props, dest: opts?.dest, newTab: !!opts?.newTab,
                              into: opts?.ctx?.leafId });
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

await t('clicking a row opens a TAB in the dashboard\'s own tile', () => {
    // Not over the dashboard — it stays, one tab-click away — and not beside
    // it: a split gives two half-width tiles, and a ticket read at half width
    // is a ticket whose description wraps every four words.
    opened.length = 0;
    board.host.querySelector('[data-sec="overdue"] [data-open]').click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].kind, 'item');
    assert.equal(opened[0].props.id, '2');
    assert.equal(opened[0].dest, 'origin', 'left the dashboard tile');
    assert.equal(opened[0].newTab, true, 'replaced the dashboard instead of adding a tab');
});

await t('every click lands in the same tile — no pane per row', () => {
    opened.length = 0;
    board.host.querySelector('[data-sec="soon"] [data-open]').click();
    board.host.querySelector('[data-sec="gaps"] [data-open]').click();
    assert.equal(opened.length, 2);
    assert.ok(opened.every((o) => o.dest === 'origin' && o.newTab),
        `a click escaped the tile: ${JSON.stringify(opened)}`);
});

await t('clicking a person opens their list the same way', () => {
    opened.length = 0;
    board.host.querySelector('[data-who="bob"]').click();
    assert.equal(opened[0].kind, 'backlog');
    assert.match(JSON.stringify(opened[0].props.expr), /"bob"/);
    assert.equal(opened[0].dest, 'origin');
    assert.equal(opened[0].newTab, true);
    // A LIST, not the tree: a person's plate is not a work package, and drawn
    // as a tree it carries rows that are not theirs and folds away rows that
    // are. See `flat` in mountBacklogBoard.
    assert.equal(opened[0].props.flat, true, 'the person list opens as a tree');
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
    // BACKGROUND is the whole difference from an ordinary click, which already
    // opens a record and takes you to it. `transient` was the wrong flag: in
    // this WM it means "not archived", not "not switched to", so the tab
    // arrived and took the screen exactly as a plain click does.
    assert.equal(calls[1].opts.dest, 'main');
    assert.equal(calls[1].opts.newTab, true);
    assert.equal(calls[1].opts.background, true, 'the tab would steal the screen');

    settings.setSetting('bugdesk.modifierOpen', 'window');
});

await t('the setting is read at CALL time, not at module load', () =>
    // A gesture that needs a reload before it obeys a preference is a gesture
    // people stop trusting.
    assert.equal(dnd.modifierOpenMode(), 'window'));

await t('Ctrl-click opens a background tab unless Settings says a window', () => {
    assert.equal(settings.getSchema()['bugdesk.modifierOpen'].defaultValue, 'tab');
});

await t('one map from a list gesture to a place, shared by every list', () => {
    const calls = [];
    const wm = { navigate: (kind, props, opts) => calls.push({ how: null, dest: opts?.dest, newTab: !!opts?.newTab, background: !!opts?.background, leaf: opts?.ctx?.leafId }) };
    const ctx = { leafId: 'L1' };
    settings.setSetting('bugdesk.modifierOpen', 'tab');
    for (const how of ['default', 'modified', 'tab', 'window', 'split-h', 'split-v']) dnd.openRecordAs(wm, ctx, 'ticket', { id: '#1' }, how);
    settings.setSetting('bugdesk.modifierOpen', 'window');
    assert.deepEqual(calls.map(({ dest, newTab, background, leaf }) => [dest, newTab, background, leaf]), [
        ['origin', true, false, 'L1'],     // click / Enter: a new tab, in front
        ['main', true, true, undefined],   // Ctrl: a background tab (the setting)
        ['origin', true, false, 'L1'],     // Alt+T: a new tab, whatever the setting
        ['window', false, false, undefined],
        ['split-h', false, false, 'L1'],
        ['split-v', false, false, 'L1'],
    ]);
});

await t('the keys that open a row, for lists that are not a table', () => {
    const k = (key, mods = {}) => dnd.openHowForKey({ key, ...mods }, ['Enter', ' ']);
    assert.deepEqual(
        [k('Enter'), k(' '), k('Enter', { ctrlKey: true }), k('Enter', { metaKey: true }), k('t', { altKey: true }),
         k('n', { altKey: true }), k('H', { altKey: true, shiftKey: true }), k('V', { altKey: true, shiftKey: true }),
         k('Enter', { shiftKey: true }), k('t'), k('h', { altKey: true })],
        ['default', 'default', 'modified', 'modified', 'tab', 'window', 'split-h', 'split-v', null, null, null]);
});

/* ── a table remembers the keyboard highlight, and opens rows by key ── */

{
    // BugDesk's lists on FlexDesk's DataTable since STORY-0008 — the adapter
    // that keeps these behaviours (bd_table.js).
    const { createTable } = await import(join(UI, 'ticketdesk', 'bd_table.js'));
    const rows = [['#1', 'b'], ['#2', 'c'], ['#3', 'a']];
    const saved = new Map();
    const stateStore = { ready: async () => {}, get: (key) => saved.get(key), set: (key, v) => saved.set(key, v) };
    const mountKeys = (opts = {}) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const opened = [];
        const table = createTable(host, {
            headers: ['Id', 'Summary'], rows: opts.rows || rows, sortable: true, selectable: true,
            stateStore, persistKey: 'keys',
            rowKey: (row) => row[0],
            onRowOpen: (idx, row, how) => opened.push([row[0], how]),
        });
        table.render();
        // The remembered highlight is put back once the rows are in (a microtask).
        const settle = () => new Promise((r) => setTimeout(r, 0));
        const press = (key, mods = {}) => {
            const ev = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
            table._tableEl.dispatchEvent(ev);
            return ev;
        };
        const highlighted = () => [...host.querySelectorAll('tbody tr.selected')].map((tr) => tr.children[0].textContent);
        return { host, table, opened, press, highlighted, settle, done: () => { table.dispose(); host.remove(); } };
    };

    await t('the row you moved to with the keyboard is highlighted again when you come back', async () => {
        saved.clear();
        const a = mountKeys();
        a.press('ArrowDown'); a.press('ArrowDown');
        assert.deepEqual(a.highlighted(), ['#2']);
        a.done();
        const b = mountKeys();
        await b.settle();
        assert.deepEqual(b.highlighted(), ['#2'], 'the highlight was forgotten');
        b.press('Enter');
        assert.deepEqual(b.opened, [['#2', 'default']], 'Enter did not open the remembered row');
        b.done();
    });

    await t('it follows the RECORD, not the position, through a sort and a refresh', () => {
        saved.clear();
        const a = mountKeys();
        a.press('ArrowDown');                       // #1
        a.table.sortBy(1);                          // by summary: #3 a, #1 b, #2 c
        a.table.setData({ rows: [['#9', 'z'], ...rows] });
        assert.deepEqual(a.highlighted(), ['#1']);
        a.press('Enter');
        assert.deepEqual(a.opened, [['#1', 'default']]);
        a.done();
    });

    await t('a click opens a row and leaves the remembered highlight alone', async () => {
        saved.clear();
        const a = mountKeys();
        a.press('ArrowDown');                       // #1 remembered
        a.host.querySelectorAll('tbody tr')[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(a.opened, [['#3', 'default']]);
        await a.settle();
        a.done();
        const b = mountKeys();
        await b.settle();
        assert.deepEqual(b.highlighted(), ['#1'], 'a click moved what is remembered');
        b.done();
    });

    await t('Ctrl+Enter is Ctrl-click, and the Alt chords open the row, not the tile', () => {
        saved.clear();
        const a = mountKeys();
        a.press('ArrowDown');
        let reachedShell = 0;
        const shell = () => { reachedShell++; };
        document.addEventListener('keydown', shell);
        a.press('Enter', { ctrlKey: true });
        a.host.querySelectorAll('tbody tr')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        a.press('t', { altKey: true });
        a.press('n', { altKey: true });
        a.press('H', { altKey: true, shiftKey: true });
        a.press('V', { altKey: true, shiftKey: true });
        document.removeEventListener('keydown', shell);
        assert.deepEqual(a.opened.map(([, how]) => how), ['modified', 'modified', 'tab', 'window', 'split-h', 'split-v']);
        assert.equal(reachedShell, 0, 'an Alt chord also reached the shell, which would act on the tile');
        a.done();
    });

    await t('a record changing on disk does not take the keyboard away from the list', () => {
        saved.clear();
        const a = mountKeys();
        a.table._tableEl.focus();
        a.press('ArrowDown');
        a.table.setData({ rows: [...rows, ['#4', 'd']] });   // what a live reload does
        assert.equal(document.activeElement, a.table._tableEl, 'focus fell to the page when the table re-rendered');
        a.press('ArrowDown');
        assert.deepEqual(a.highlighted(), ['#2']);
        a.done();
    });

    await t('a click on a column edge changes nothing; a double-click hands it back to auto', () => {
        saved.clear();
        const a = mountKeys();
        a.table._syncHeaderWidths?.();
        const grip = a.host.querySelector('.twm-dt-col-resizer');
        if (grip) {
            grip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100 }));
            document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 100 }));
            assert.deepEqual(a.table._colWidths, {}, 'a click pinned widths');
        }
        // FlexDesk's rule since STORY-0008: a double-click FITS the column to its
        // content (Tables' rule too), where BugDesk's copy dropped the pin. Both
        // undo a dragged width; jsdom has no layout to measure, so the gesture
        // is asserted to reach the fit.
        let fitted = null;
        a.table.autoSizeColumn = (i) => { fitted = i; return true; };
        const g = a.host.querySelectorAll('.twm-dt-col-resizer')[1];
        assert.ok(g, 'no grip on the second column');
        g.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
        assert.equal(fitted, 1, 'a double-click on the column edge did not fit the column');
        a.done();
    });
}

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

/* ── editing a description ───────────────────────────────────────────
 *
 * The item page rendered the description and offered no way to change it, so
 * the one field with room to say WHY was write-once: you could set it while
 * filing and never again. This mounts the real page over a stubbed bridge and
 * walks the round trip, because the failure this replaces was not a wrong
 * value — it was a control that did not exist.
 */

console.log('\nEditing a description');

await t('the description can be edited and saved', async () => {
    const record = {
        id: 2, type: 'story', title: 'Finance feed cutover', status: 'in-progress',
        stage: 2, ladder: ['draft', 'refined', 'in-progress', 'review', 'done'],
        parent: 1, phase: '', effectivePhase: 'q4', assignee: 'bob', reporter: 'alice',
        due: '', points: '5', subsystem: 'vendors', labels: [], links: [],
        created: '2026-09-01', updated: '2026-09-09',
        description: 'The original text.', acceptance: '', criteria: [],
        comments: [], children: 0, ancestors: [], childItems: [],
    };
    const posts = [];
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url, opts) => {
        const path = pageUrl(url);
        if (opts?.method === 'POST' && /\/api\/backlog\/2$/.test(path)) {
            const patch = JSON.parse(opts.body);
            posts.push(patch);
            Object.assign(record, patch);
            return { ok: true, json: async () => ({ ok: true, item: record }) };
        }
        if (/\/api\/backlog\/2$/.test(path)) return { ok: true, json: async () => ({ ok: true, item: record }) };
        if (path.endsWith('/api/backlog')) return { ok: true, json: async () => ({ ok: true, items: FIXTURE }) };
        if (path.endsWith('/api/backlog/meta')) return { ok: true, json: async () => ({ ok: true, phases: ['q4'] }) };
        return { ok: true, json: async () => ({ ok: true, settings: {} }) };
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null }).item(host, { id: '2' }, { wm: null });
    await tick(); await tick(); await tick();

    // It reads as rendered markdown, with an Edit button.
    assert.match(host.querySelector('[data-slot="desc"]').textContent, /The original text/);
    const edit = host.querySelector('[data-a="desc-edit"]');
    assert.ok(edit, 'no way to edit the description');

    edit.click();
    const ta = host.querySelector('[data-f="description"]');
    assert.ok(ta, 'clicking Edit produced no editor');
    assert.equal(ta.value, 'The original text.', 'the editor did not load the current text');

    ta.value = 'Rewritten, with a link: https://example.com/a';
    host.querySelector('[data-a="desc-save"]').click();
    await tick(); await tick();

    assert.equal(posts.length, 1, `expected one save, got ${posts.length}`);
    assert.equal(posts[0].description, 'Rewritten, with a link: https://example.com/a');
    // ...and it comes back rendered, with the URL clickable.
    const desc = host.querySelector('[data-slot="desc"]');
    assert.match(desc.innerHTML, /<a href="https:\/\/example\.com\/a"/);
    assert.ok(!host.querySelector('[data-f="description"]'), 'the editor stayed open after saving');

    page.destroy?.();
    host.remove();
    put('fetch', realFetchLocal);
});

const dueRecord = () => ({
    id: 4, type: 'task', title: 'x', status: 'draft',
    ladder: ['draft', 'in-progress', 'done'],
    parent: 1, phase: '', effectivePhase: '', assignee: '', reporter: '',
    due: '', effectiveDue: '2026-12-15',      // inherited; none of its own
    points: '', subsystem: 'unsorted', labels: [], links: [], created: '', updated: '',
    description: '', acceptance: '', criteria: [], comments: [],
    children: 0, ancestors: [], childItems: [],
});

/** Mount the item page over a stubbed bridge, collecting what it POSTs. */
const mountItemPage = async (record) => {
    const posts = [];
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url, opts) => {
        if (opts?.method === 'POST' && /\/api\/backlog\/4$/.test(pageUrl(url))) {
            posts.push(JSON.parse(opts.body));
            return { ok: true, json: async () => ({ ok: true, item: record }) };
        }
        if (/\/api\/backlog\/4$/.test(pageUrl(url))) {
            return { ok: true, json: async () => ({ ok: true, item: record }) };
        }
        return { ok: true, json: async () => ({ ok: true, items: FIXTURE, phases: [], settings: {} }) };
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null }).item(host, { id: '4' }, { wm: null });
    await tick(); await tick(); await tick();
    return {
        host, posts,
        done: () => { page.destroy?.(); host.remove(); put('fetch', realFetchLocal); },
    };
};

await t('an inherited date is shown IN the field, badged, and writable', async () => {
    const m = await mountItemPage(dueRecord());
    const due = m.host.querySelector('[data-f="due"]');
    assert.ok(due, 'no target date field');
    // IN the field, not on a second line: an empty input beside a line of text
    // reads as "no date" when there is one.
    assert.equal(due.value, '2026-12-15', 'the inherited date is not in the input');
    assert.equal(due.readOnly, false, 'the field is not writable');
    assert.ok(m.host.querySelector('[data-slot="duebadge"]'), 'nothing says it is inherited');
    m.done();
});

await t('saving an untouched page keeps it inheriting', async () => {
    // Adopting the value on screen would quietly stop the item tracking its
    // parent, with nothing on screen having said so.
    const m = await mountItemPage(dueRecord());
    const title = m.host.querySelector('[data-f="title"]');
    title.value = 'renamed';
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    m.host.querySelector('[data-a="save"]').click();
    await tick(); await tick();
    assert.equal(m.posts.at(-1).due, '',
        `an untouched inherited date was adopted as its own: ${m.posts.at(-1).due}`);
    m.done();
});

await t('editing the date makes it this record own, and drops the badge', async () => {
    const m = await mountItemPage(dueRecord());
    const due = m.host.querySelector('[data-f="due"]');
    due.value = '2026-11-01';
    due.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    // The badge stops being true the moment it is edited, not after a save.
    assert.ok(!m.host.querySelector('[data-slot="duebadge"]'), 'still badged as inherited');
    assert.ok(!due.classList.contains('bd-duefield__in--inherited'));
    m.host.querySelector('[data-a="save"]').click();
    await tick(); await tick();
    assert.equal(m.posts.at(-1).due, '2026-11-01', 'the override was not sent');
    m.done();
});

await t('the overrun warning is inline with the date, as a pill', async () => {
    // Beside the input on the same line, like the inherited badge — not on a
    // line of its own, where it reads as a separate paragraph about the record
    // rather than as something about that field.
    const record = dueRecord();
    record.due = '2099-01-01';          // its own, and well after PROJ-0001's
    record.effectiveDue = '2099-01-01';
    const m = await mountItemPage(record);

    const field = m.host.querySelector('.bd-duefield');
    const warn = m.host.querySelector('[data-slot="duewarn"]');
    assert.ok(warn, 'no overrun warning at all');
    assert.equal(warn.parentElement, field, 'the warning is not inline with the date input');
    assert.ok(warn.classList.contains('bd-duewarn--pill'), 'not styled as a pill');
    assert.match(warn.textContent, /after PROJ-0001/);
    // The one it overruns is named in the title, with ITS date — read from the
    // fixture rather than written literally, since the fixture dates are
    // relative to today (dueState reads the reader's own clock).
    assert.ok(warn.title.includes(FIXTURE[0].due),
        `the parent's date is missing from "${warn.title}"`);
    // An owned date is not badged as inherited.
    assert.ok(!m.host.querySelector('[data-slot="duebadge"]'));
    m.done();
});

await t('the placeholder for an empty description is never loaded as text', async () => {
    // The bridge writes `_(no description provided)_` for an empty one. Loading
    // it into the editor would turn a placeholder into content on the next save.
    const record = {
        id: 9, type: 'task', title: 'x', status: 'draft', ladder: ['draft', 'in-progress', 'done'],
        parent: 0, phase: '', effectivePhase: '', assignee: '', reporter: '', due: '',
        points: '', subsystem: 'unsorted', labels: [], links: [], created: '', updated: '',
        description: '_(no description provided)_', acceptance: '', criteria: [],
        comments: [], children: 0, ancestors: [], childItems: [],
    };
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url) => (/\/api\/backlog\/9$/.test(pageUrl(url))
        ? { ok: true, json: async () => ({ ok: true, item: record }) }
        : { ok: true, json: async () => ({ ok: true, items: FIXTURE, phases: [], settings: {} }) }));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null }).item(host, { id: '9' }, { wm: null });
    await tick(); await tick(); await tick();
    host.querySelector('[data-a="desc-edit"]').click();
    assert.equal(host.querySelector('[data-f="description"]').value, '');

    page.destroy?.();
    host.remove();
    put('fetch', realFetchLocal);
});

/* ── the Inspector's team rows ───────────────────────────────────── */

console.log('\nTeam overview');

const { createTicketDeskContent } = await import(join(UI, 'ticketdesk', 'pages.js'));

/* WHO GETS A ROW. The roster in bugdesk.json is the spine — everyone
 * assignable is listed, so this panel and the assignee picker cannot disagree
 * about who works here — and beyond it only somebody actually carrying open
 * work. A name that reached the store once and has nothing open is a fossil of
 * an old assignment; it used to sit in this list forever with nothing pointing
 * at it and no way to remove it. */
const { teamNames } = await import(join(UI, 'ticketdesk', 'data.js'));

await t('the roster is listed in full, busy or not', () => {
    // Nobody is carrying anything at all here: the four roster names are still
    // the four rows.
    assert.deepEqual(teamNames(new Map()), ['alice', 'alice_agent', 'bob', 'bob_agent']);
});

await t('somebody off the roster is listed only while they are carrying work', () => {
    const seen = new Map([
        ['carol', { name: 'carol', open: 1 }],   // not on the roster, but busy
        ['dave', { name: 'dave', open: 0 }],     // not on the roster, all done
    ]);
    const names = teamNames(seen);
    assert.ok(names.includes('carol'), `carol is carrying work: ${names}`);
    assert.ok(!names.includes('dave'), `dave has nothing open and is on no roster: ${names}`);
});

await t('one person with two spellings is one row, spelled as the roster does', () => {
    const names = teamNames(new Map([['bob', { name: 'Bob', open: 3 }]]));
    assert.deepEqual(names.filter((n) => n.toLowerCase() === 'bob'), ['bob']);
});

await t('every roster member has a row in the panel, including the idle ones', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wm = {
        desktops: { active: () => ({ tree: {
            focusedLeafId: 'leaf',
            get: () => ({ content: { kind: 'backlog' } }),
            primaryLeafId: () => 'leaf',
        } }) },
        openInPrimary: () => {},
    };
    const panel = createTicketDeskContent({ eventBus: null })['panel:right'](host, {}, { wm });
    await tick(); await tick();

    const rows = [...host.querySelectorAll('[data-member]')].map((e) => e.dataset.member);
    // The backlog fixture only ever assigns alice and bob; the two agents are
    // on the roster and carry nothing, and they are listed all the same.
    assert.deepEqual(rows, ['alice', 'alice_agent', 'bob', 'bob_agent'],
        `the panel and the roster disagree: ${JSON.stringify(rows)}`);

    panel.destroy?.();
    host.remove();
});

await t('clicking a name opens that person\'s OPEN work in the main tile', async () => {
    const opened2 = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wm = {
        // The panel asks which section it is reporting on; say Backlog.
        desktops: { active: () => ({ tree: {
            focusedLeafId: 'leaf',
            get: () => ({ content: { kind: 'backlog' } }),
            primaryLeafId: () => 'leaf',
        } }) },
        openInPrimary: (kind, props) => opened2.push({ kind, props }),
    };
    const panel = createTicketDeskContent({ eventBus: null })['panel:right'](host, {}, { wm });
    await tick(); await tick();

    const rows = [...host.querySelectorAll('[data-member]')].map((e) => e.dataset.member);
    assert.ok(rows.includes('bob'), `no row for bob among ${JSON.stringify(rows)}`);

    host.querySelector('[data-member="bob"]').click();
    await tick();
    assert.equal(opened2.length, 1, 'the click reached nothing');
    assert.equal(opened2[0].kind, 'backlog', 'opened the wrong store');
    const expr = JSON.stringify(opened2[0].props.expr);
    assert.match(expr, /"bob"/, 'the filter is not about bob');
    // OPEN work: the row's own count is of things in flight, so the list it
    // opens has to be the same set or the number and the body disagree.
    // "Open" is its own status not finished — done, dropped, or a project's own
    // finished status (STORY-0024) — hence `ownFinished`, not a status list.
    assert.match(expr, /"ownFinished","op":"is","value":"no"/, `not restricted to open work: ${expr}`);

    panel.destroy?.();
    host.remove();
});

/* ── the Team window ────────────────────────────────────── */

console.log('\nTeam window');

await t('it opens as a real managed window, not a hand-rolled overlay', async () => {
    const realFetchLocal = globalThis.fetch;
    put('fetch', async () => ({
        ok: true,
        json: async () => ({ ok: true, path: '.bugdesk/project.json',
                             config: { collaborators: [{ name: 'bob', agent: 'bob_agent' }] } }),
    }));
    const { openCollaborators } = await import(join(UI, 'ticketdesk', 'collaborators.js'));
    const done = openCollaborators({ eventBus: null });
    await tick(); await tick(); await tick();

    const win = document.querySelector('.twm-managed-window');
    assert.ok(win, 'no ManagedWindow — it is still a bare overlay');
    assert.ok(win.classList.contains('twm-managed-window--modal'));
    assert.ok(!document.querySelector('.bd-picker'), 'the old overlay is still being built');

    // The same editor as Settings › Team, not a second layout of its own.
    assert.equal(win.querySelector('.twm-managed-window__title')?.textContent.trim(), 'Team');
    const body = document.querySelector('.twm-managed-window .bd-proj .bd-team__roster');
    assert.ok(body, 'the Team editor did not mount in the window');
    assert.ok(body.querySelector('.bd-team__grid input[data-name]'), 'no roster rows');
    assert.ok(body.querySelector('.bd-team__add [data-act="add"]'), 'no add row');

    // THE STYLING BUG: `.ea-tin` is scoped to .td-page/.td-modal/.td-nav/
    // .td-rpanel, so in a modal it styles nothing and the fields render as raw
    // browser inputs. `.bd-proj` is what the Settings editors' input styling
    // hangs off, so every field has to live inside one.
    const fields = [...body.querySelectorAll('input')];
    assert.ok(fields.length >= 2, `expected name and add fields, got ${fields.length}`);
    for (const f of fields) {
        assert.ok(f.closest('.bd-proj'),
            `an input is outside .bd-proj and will render unstyled: ${f.outerHTML}`);
        assert.ok(!f.classList.contains('ea-tin'),
            'still using .ea-tin, which is scoped to surfaces this is not one of');
    }

    // Cancel: the window closes and nothing is saved.
    // FlexDesk's openModal since 0.11.0 (STORY-0022): its classes are `twm-`.
    const cancel = [...document.querySelectorAll('.twm-modal__actions .twm-btn')]
        .find((b) => b.textContent.trim() === 'Cancel');
    assert.ok(cancel, 'no Cancel action');
    cancel.click();
    assert.equal(await done, null);
    put('fetch', realFetchLocal);
});

/* ── the project editors, on the Settings page (STORY-0032) ──────────── */

console.log('\nSettings editors on the page');

/** Answer the editors' fetches from `routes` (`'GET /api/x'` → body), and record every POST. */
const fakeApi = (routes) => {
    const posts = [];
    put('fetch', async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = `/${String(url).replace(/^.*?\bapi\//, 'api/')}`;
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (method === 'POST') posts.push({ path, body });
        const answer = routes[`${method} ${path}`];
        const j = typeof answer === 'function' ? answer(body) : answer;
        return { ok: !!j?.ok, status: j?.ok ? 200 : 400, json: async () => j };
    });
    return posts;
};

await t('Record types: a prefix is set beside its type, and Save sends only the numbering that changed', async () => {
    const realFetchLocal = globalThis.fetch;
    const { CONFIG } = await import(join(UI, 'ticketdesk', 'instance.js'));
    CONFIG.numbering = { bugs: { prefix: 'BUG', pad: 4, start: 1, step: 1 },
        backlog: { prefix: { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' }, pad: 4, start: 1, step: 1 } };
    let refuse = true;
    const posts = fakeApi({
        'POST /api/project/numbering': (b) => (refuse ? { ok: false, error: 'prefix "EPIC" is used by two types' }
            : { ok: true, numbering: b.numbering }),
    });
    const { mountRecordTypes } = await import(join(UI, 'ticketdesk', 'schema_editor.js'));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const cleanup = mountRecordTypes(el, { store: 'backlog', type: 'story' });
    const save = () => el.querySelector('[data-act="save"]');
    assert.ok(save().disabled, 'Save is offered with nothing changed');
    const prefix = el.querySelector('[data-num="prefix"]');
    assert.equal(prefix.value, 'STORY');
    prefix.value = 'US';
    prefix.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.match(el.querySelector('[data-slot="sample"]').textContent, /^US-0001$/);
    assert.equal(el.querySelector('[data-slot="state"]').textContent, 'Unsaved changes');
    assert.ok(!save().disabled);

    // Refused: the reason is on the page, and what was typed is still there.
    save().click();
    await tick(); await tick();
    assert.match(el.querySelector('.bd-schema__problems')?.textContent || '', /used by two types/);
    assert.equal(el.querySelector('[data-num="prefix"]').value, 'US');
    assert.deepEqual(posts.map((x) => x.path), ['/api/project/numbering'], 'the unchanged schema was sent too');
    assert.equal(posts[0].body.numbering.backlog.prefix.story, 'US');

    refuse = false;
    save().click();
    await tick(); await tick();
    assert.equal(el.querySelector('.bd-schema__problems'), null);
    assert.ok(save().disabled, 'still unsaved after saving');
    assert.equal(CONFIG.numbering.backlog.prefix.story, 'US');
    cleanup();
    el.remove();
    put('fetch', realFetchLocal);
});

await t('Record types: unsaved changes are still there when you come back', async () => {
    const realFetchLocal = globalThis.fetch;
    fakeApi({});
    const { mountRecordTypes } = await import(join(UI, 'ticketdesk', 'schema_editor.js'));
    const el = document.createElement('div');
    let cleanup = mountRecordTypes(el, { store: 'backlog', type: 'epic' });
    const pad = el.querySelector('[data-num="pad"]');
    pad.value = '6';
    pad.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    cleanup();
    cleanup = mountRecordTypes(el);
    assert.equal(el.querySelector('[data-num="pad"]').value, '6');
    assert.match(el.querySelector('.bd-schema__h').textContent, /Epic/, 'not back on the type you left');
    el.querySelector('[data-act="discard"]').click();
    assert.notEqual(el.querySelector('[data-num="pad"]').value, '6');
    cleanup();
    put('fetch', realFetchLocal);
});

await t('Team: the roster on the page, saved with its own Save', async () => {
    const realFetchLocal = globalThis.fetch;
    const posts = fakeApi({
        'GET /api/project': { ok: true, path: '.bugdesk/project.json', config: { collaborators: [{ name: 'bob', agent: 'bob_agent' }] } },
        'POST /api/project/collaborators': (b) => ({ ok: true, collaborators: b.collaborators }),
    });
    const { mountTeam } = await import(join(UI, 'ticketdesk', 'collaborators.js'));
    const el = document.createElement('div');
    mountTeam(el);
    await tick(); await tick();
    assert.equal(document.querySelector('.twm-managed-window'), null, 'it opened a window');
    assert.equal(el.querySelector('[data-name="0"]').value, 'bob');
    assert.ok(el.querySelector('[data-act="save"]').disabled);
    const add = el.querySelector('[data-slot="newname"]');
    add.value = 'carol';
    add.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(!el.querySelector('[data-act="save"]').disabled);
    el.querySelector('[data-act="save"]').click();
    await tick(); await tick(); await tick();
    assert.deepEqual(posts[0].body.collaborators.map((c) => c.name), ['bob', 'carol']);
    put('fetch', realFetchLocal);
});

await t('Git: the two switches apply as flipped, and leave the project auto-save alone', async () => {
    const realFetchLocal = globalThis.fetch;
    const posts = fakeApi({
        'GET /api/git': { ok: true, enabled: true, settings: { commitAfterSave: false, pushAfterCommit: false, autosave: 'debounce', autosaveSeconds: 3 } },
        'POST /api/project/git': (b) => ({ ok: true, enabled: true, settings: { ...b, autosave: 'debounce', autosaveSeconds: 3 } }),
    });
    const { mountGitSettings } = await import(join(UI, 'ticketdesk', 'changes_pane.js'));
    const el = document.createElement('div');
    await mountGitSettings(el);
    assert.ok(el.querySelector('[data-set="pushAfterCommit"]').disabled, 'push is offered without commit');
    const commit = el.querySelector('[data-set="commitAfterSave"]');
    commit.checked = true;
    commit.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    assert.deepEqual(posts[0].body, { commitAfterSave: true, pushAfterCommit: false });
    assert.ok(!el.querySelector('[data-set="pushAfterCommit"]').disabled);
    put('fetch', realFetchLocal);
});

await t('Auto-save is yours: chosen in your profile, and the project default clears it', async () => {
    const realFetchLocal = globalThis.fetch;
    const { CONFIG } = await import(join(UI, 'ticketdesk', 'instance.js'));
    const { autosaveMode } = await import(join(UI, 'ticketdesk', 'autosave.js'));
    CONFIG.saving = { commitAfterSave: false, pushAfterCommit: false, autosave: 'off', autosaveSeconds: 0,
        ownAutosave: false, projectAutosave: 'off', projectAutosaveSeconds: 0 };
    const posts = fakeApi({ 'POST /api/user/settings': { ok: true, settings: {} } });
    const { mountAutosaveSetting } = await import(join(UI, 'ticketdesk', 'autosave_setting.js'));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const cleanup = mountAutosaveSetting(el);
    assert.match(el.querySelector('.settings-page__setting-desc').textContent, /Yours alone/);
    const pick = async (value) => {
        el.querySelector('.bd-sel__button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await tick();
        document.querySelector(`.bd-sel__panel [data-value="${value}"]`)
            .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await tick(); await tick();
    };
    await pick('debounce');
    assert.deepEqual(posts.at(-1), { path: '/api/user/settings', body: { autosave: 'debounce', autosaveSeconds: 2 } });
    assert.deepEqual(autosaveMode(), { mode: 'debounce', seconds: 2 }, 'a record opened now does not auto-save');
    await pick('project');
    assert.deepEqual(posts.at(-1).body, { autosave: null, autosaveSeconds: null });
    assert.equal(autosaveMode().mode, 'off');
    cleanup();
    el.remove();
    put('fetch', realFetchLocal);
});

/* ── the left rail follows the right store ───────────────────────────
 *
 * Filters on the rail "sometimes" opened the other store. Two causes: the
 * backlog rail mounts after an await, so a switch that finished late landed on
 * top of the bug rail (or a second backlog mount leaked the first's listeners);
 * and pressing a rail row focuses the PANEL, which resolved to the primary tile
 * rather than the one the user was in, swapping the rail under the pointer. */

const railHarness = (leaves, focused) => {
    const handlers = new Map();
    const bus = {
        on: (name, fn) => {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(fn);
            return { dispose() {} };
        },
        emit: (name, payload) => (handlers.get(name) || []).forEach((f) => f(payload)),
    };
    const opened = [];
    const tree = {
        focusedLeafId: focused,
        get: (id) => (leaves[id] ? { content: { kind: leaves[id] } } : null),
        primaryLeafId: () => 'primary',
    };
    const wm = {
        desktops: { active: () => ({ tree }) },
        openInPrimary: (kind, props) => opened.push({ kind, props }),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = createTicketDeskContent({ eventBus: bus })['panel:left'](host, {}, { wm });
    return { bus, tree, opened, host, panel };
};
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

await t('a rail switch that finishes late does not land on top of the other store', async () => {
    const r = railHarness({ primary: 'backlog', side: 'queues' }, 'primary');
    // The backlog rail is still importing when the user moves to Bugs...
    r.tree.focusedLeafId = 'side';
    r.bus.emit('wm:changed', {});
    await settle();
    // ...and back and forth in a burst, ending on Bugs.
    r.tree.focusedLeafId = 'primary';
    r.bus.emit('wm:changed', {});
    r.bus.emit('wm:changed', {});
    r.tree.focusedLeafId = 'side';
    r.bus.emit('wm:changed', {});
    await settle();

    const row = r.host.querySelector('[data-filter="active"]');
    assert.ok(row, 'the bug rail is not showing');
    assert.ok(!r.host.querySelector('[data-epic],[data-phase],[data-project]'),
        'a backlog rail landed on top of the bug rail');
    row.click();
    assert.deepEqual(r.opened.map((o) => o.kind), ['queues'],
        'a bug filter opened something other than the bug queue');
    r.panel.destroy();
    r.host.remove();
});

await t('pressing the rail keeps the store of the tile you were in, not the primary', async () => {
    const r = railHarness({ primary: 'backlog', side: 'queues', rail: 'panel:left' }, 'side');
    await settle();
    const before = r.host.querySelector('[data-filter="active"]');
    assert.ok(before, 'the bug rail is not showing');
    // Mousedown on a rail row focuses the rail panel.
    r.tree.focusedLeafId = 'rail';
    r.bus.emit('wm:changed', {});
    await settle();
    assert.equal(r.host.querySelector('[data-filter="active"]'), before,
        'focusing the rail swapped it to the primary tile\'s store');
    r.panel.destroy();
    r.host.remove();
});

await t('a focus change does NOT rebuild the panel under the pointer', async () => {
    // THE BUG, and the reason it survived three attempts to find it: `wm:changed`
    // fires on every focus change, and focusing happens on MOUSEDOWN. Repainting
    // there replaced this panel's DOM between the press and the release of the
    // user's own click, so the row they pressed no longer existed at mouseup and
    // the browser dispatched `click` on an ancestor instead. A test that calls
    // .click() never sees it — there is no press, no release and no repaint in
    // between — so what is asserted here is the thing that actually matters:
    // the row must be the SAME NODE afterwards.
    const handlers = new Map();
    const bus = {
        on: (name, fn) => {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(fn);
            return { dispose() {} };
        },
        emit: (name, payload) => (handlers.get(name) || []).forEach((f) => f(payload)),
    };
    const wm = {
        desktops: { active: () => ({ tree: {
            focusedLeafId: 'leaf',
            get: () => ({ content: { kind: 'backlog' } }),
            primaryLeafId: () => 'leaf',
        } }) },
        openInPrimary: () => {},
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = createTicketDeskContent({ eventBus: bus })['panel:right'](host, {}, { wm });
    await tick(); await tick();

    const before = host.querySelector('[data-member="bob"]');
    assert.ok(before, 'no row to press on');

    // What the WM does on mousedown, several times over — a click, a drag, a
    // tab switch all land here.
    bus.emit('wm:changed', {});
    bus.emit('wm:changed', {});
    await tick(); await tick();

    assert.equal(host.querySelector('[data-member="bob"]'), before,
        'the panel rebuilt its rows on a focus change — a press-and-release is torn in half');

    // A real change still repaints, or the panel would go stale.
    const spy = [];
    const wm2 = { ...wm, openInPrimary: (kind, props) => spy.push({ kind, props }) };
    bus.emit('backlog:changed', {});
    await tick(); await tick();
    assert.ok(host.querySelector('[data-member="bob"]'), 'a write repaint lost the rows');

    // ...and the row still routes.
    host.querySelector('[data-member="bob"]').click();
    await tick();
    void wm2; void spy;

    panel.destroy?.();
    host.remove();
});

/* ── the whole path, with a REAL WindowManager ───────────────────────
 *
 * Everything above this point tests one layer at a time, and "clicking a name
 * in the Inspector does nothing" survived two rounds of that: the click was
 * fine, the handler was fine, the call was fine, and the request was still
 * being lost. So this builds the actual window manager over the actual content
 * registry and asserts what the user can see — what is in the primary tile
 * afterwards.
 */

/* ── a person's plate is a LIST ──────────────────────────────────────
 *
 * The backlog page draws a tree, which is right for a backlog and wrong for
 * "everything on bob": the tree keeps his items' ANCESTORS as context rows
 * (work that is not his, in a list of his work), and it drops any of his items
 * that sit under a folded parent — so the table can contradict the count on the
 * row that opened it. `flat` is what the Inspector and the dashboard pass.
 */

console.log('\nEverything on one person');

await t('a flat board lists that person\'s open items and nothing else', async () => {
    const { assigneeExpr } = await import(join(UI, 'ticketdesk', 'backlog_filters.js'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null })
        .backlog(host, { expr: assigneeExpr('bob'), label: 'On bob', flat: true }, { wm: null });
    await tick(); await tick();

    const refs = [...host.querySelectorAll('tbody tr')]
        .map((tr) => tr.querySelector('.bd-item__ref')?.textContent?.trim())
        .filter(Boolean);
    // bob's open work, and only that: STORY-0003 is done, TASK-0005 is nobody's,
    // and the project the two stories hang from is alice's.
    assert.deepEqual(refs.sort(), ['STORY-0002', 'STORY-0004'],
        `a flat list of bob's work should be exactly his open items: ${refs}`);
    assert.equal(host.querySelector('.bd-item--context'), null,
        'a context row from the tree survived into the flat list');
    assert.equal(host.querySelector('[data-a="collapse"]'), null,
        'the fold controls are still offered for a list with no hierarchy');

    page.destroy?.();
    host.remove();
});

await t('the tree is still a tree when it is not a person\'s list', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null })
        .backlog(host, { filter: 'all' }, { wm: null });
    await tick(); await tick();

    assert.ok(host.querySelector('[data-a="collapse"]'), 'the board lost its fold controls');
    const refs = [...host.querySelectorAll('tbody tr')]
        .map((tr) => tr.querySelector('.bd-item__ref')?.textContent?.trim())
        .filter(Boolean);
    assert.ok(refs.includes('PROJ-0001'), `the whole store should be here: ${refs}`);

    page.destroy?.();
    host.remove();
});

/* "Collapsing works for bugs but not for the backlog." BugDesk kept its own
 * breadcrumb, which marked only the crumb directly above the page as the way
 * back, and for an item that crumb is the story or epic, not "Backlog". The
 * fork is gone: FlexDesk's breadcrumb reads the item's chain from the taxonomy
 * and EVERY crumb climbs through `wm.navigateUp`, where the WM applies the same
 * rule Backspace does. */
await t('an item\'s breadcrumb is its hierarchy, and every crumb climbs through the WM', async () => {
    const { mountTileBreadcrumb } = await import('@flexdesk/wm');
    const { taxonomy: tax } = await import(join(UI, 'tiling', 'kind_taxonomy.js'));
    const climbed = [];
    const navigated = [];
    const wm = {
        navigateUp: (kind, props) => climbed.push([kind, props?.id ?? null]),
        navigate: (kind, props) => navigated.push([kind, props?.id ?? null]),
    };
    const crumb = mountTileBreadcrumb('item', { id: '3', label: 'TASK-0003 — whatever' }, { taxonomy: tax, wm });
    const labels = [...crumb.el.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').replace('›', '').trim());
    assert.deepEqual(labels.map((l) => l.replace(/^\S+ /, '')), ['Backlog', 'PROJ-0001', 'STORY-0002', 'TASK-0003'],
        `the chain is not the hierarchy: ${JSON.stringify(labels)}`);
    for (const btn of crumb.el.querySelectorAll('button')) btn.click();
    assert.deepEqual(climbed, [['backlog', null], ['item', '1'], ['item', '2']]);
    assert.deepEqual(navigated, [], 'a crumb went around navigateUp');
    crumb.destroy();
});

/* The bug queue's right-click menu offers "Filter by <field> <this cell>"; the
 * backlog board's did not. It filters by the ITEM's stored value, not by the
 * cell text: the Status cell reads "In progress" where the store says
 * `in-progress`, and a filter on the label would match nothing. */
await t('right-click a board cell and filter the board by it', async () => {
    const navigated = [];
    const wm = { navigate: (kind, props) => navigated.push({ kind, props }) };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createBacklogContent({ eventBus: null })
        .backlog(host, { filter: 'all', flat: true }, { wm });
    await tick(); await tick();

    const headers = [...host.querySelectorAll('.twm-preview-table-header-wrap thead tr:first-child th')]
        .map((th) => th.textContent.trim());
    const statusCol = headers.findIndex((h) => h.startsWith('Status'));
    const titleCol = headers.findIndex((h) => h.startsWith('Title'));
    const row = host.querySelector('tbody tr');
    const ref = row.querySelector('td:not(.twm-dt-select-cell)').textContent.trim();
    const item = backlogData.ITEMS.find((i) => i.ref === ref);

    const menuFor = async (col) => {
        row.children[col].dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        await new Promise((r) => setTimeout(r, 5));
        return [...document.querySelectorAll('.data-context-menu .twm-context-menu-item')];
    };

    const onStatus = await menuFor(statusCol);
    const filterItem = onStatus.find((el) => /Filter by/.test(el.textContent));
    assert.ok(filterItem, `no Filter by entry: ${onStatus.map((e) => e.textContent.trim())}`);
    assert.match(filterItem.textContent, /Filter by Status/);
    assert.ok(!filterItem.classList.contains('disabled') && !filterItem.classList.contains('twm-disabled'), 'filter by a status cell is greyed out');
    assert.ok(onStatus.some((el) => /Save as filter/.test(el.textContent)), 'no Save as filter entry');
    filterItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(navigated.length, 1, 'the board did not navigate');
    assert.equal(navigated[0].kind, 'backlog');
    assert.deepEqual(navigated[0].props.expr.children, [{ kind: 'clause', field: 'status', op: 'is', value: item.status }]);

    const onTitle = await menuFor(titleCol);
    assert.ok(onTitle.find((el) => /Filter by/.test(el.textContent)).classList.contains('disabled'),
        'a whole title is offered as a filter');

    page.destroy?.();
    host.remove();
});

/* A tile mounts only its ACTIVE tab, so opening an item in a new tab destroys
 * the board and going back builds a fresh one. Its sort used to die with it.
 * The table's state lives in the shell's table store, keyed by the view. */
await t('a board\'s sort survives being unmounted and mounted again', async () => {
    const saved = new Map();
    const tableStore = { ready: async () => {}, get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
    const sortArrows = (host) => [...host.querySelectorAll('thead th')].flatMap((th) =>
        [...th.querySelectorAll('.material-symbols-outlined')].map((i) => i.textContent.trim())
            .filter((x) => x === 'arrow_upward' || x === 'arrow_downward')
            .map((x) => `${th.textContent.replace(/arrow_(up|down)ward/, '').trim()} ${x}`));
    const mount = async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const page = createBacklogContent({ eventBus: null })
            .backlog(host, { filter: 'all', flat: true }, { wm: null, tableStore });
        await tick(); await tick();
        return { host, page };
    };

    const first = await mount();
    const title = [...first.host.querySelectorAll('thead th')].find((th) => /^Title/.test(th.textContent.trim()));
    assert.ok(title, 'no Title column to sort by');
    title.click(); await tick();
    title.click(); await tick();
    const before = sortArrows(first.host);
    assert.equal(before.length, 1, `expected one sorted column, got ${JSON.stringify(before)}`);
    first.page.destroy?.();
    first.host.remove();

    assert.ok([...saved.keys()].some((k) => k.startsWith('backlog:board:')), `nothing was stored: ${[...saved.keys()]}`);
    const second = await mount();
    assert.deepEqual(sortArrows(second.host), before, 'the remounted board forgot its sort');
    second.page.destroy?.();
    second.host.remove();
});

/* "Too many bugs and I cannot see them all": the table cut every view to its
 * first hundred rows even with the page controls switched off, so the rest of
 * the store was unreachable and nothing said so. */
// FlexDesk's DataTable since STORY-0008, through BugDesk's adapter.
const { createTable: createPaged } = await import(join(UI, 'ticketdesk', 'bd_table.js'));
const PagedTable = function PagedTable(host, opts) { return createPaged(host, opts); };
// The first row DRAWN — FlexDesk's getDisplayedRows() is every page's rows (in
// order), so "which page am I on" is read off the body itself.
const firstShown = (host) => host.querySelector('tbody tr')?.children[0]?.textContent.trim();
const manyRows = Array.from({ length: 250 }, (_, i) => [`#${i + 1}`, `row ${i + 1}`]);

await t('a table with pagination off shows every row, not the first hundred', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const table = new PagedTable(host, { headers: ['Id', 'Summary'], rows: manyRows, pagination: false });
    table.render();
    assert.equal(host.querySelectorAll('tbody tr').length, 250);
    assert.equal(table.getDisplayedRows().length, 250);
    table.dispose();
    host.remove();
});

await t('a table with more rows than a page offers the page controls, and they move', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let renders = 0;
    const table = new PagedTable(host, { headers: ['Id', 'Summary'], rows: manyRows, pagination: true,
                                         onRender: () => { renders++; } });
    table.render();
    const strip = host.querySelector('.twm-pagination-controls');
    assert.ok(strip, 'no pagination strip for 250 rows');
    assert.match(strip.textContent, /1–100 of 250/);
    assert.equal(host.querySelectorAll('tbody tr').length, 100);
    const next = [...strip.querySelectorAll('button')].find((b) => /Next page/.test(b.getAttribute('aria-label') || b.title || b.dataset.tooltip || ''));
    assert.ok(next, 'no Next page button');
    next.click();
    assert.match(host.querySelector('.twm-pagination-controls').textContent, /101–200 of 250/);
    assert.equal(firstShown(host), '#101');
    assert.ok(renders >= 2, 'onRender was not called on each render');
    table.dispose();
    host.remove();
});

await t('the page you were on survives a remount, and a page past the end lands on the last', () => {
    const saved = new Map();
    const stateStore = { ready: async () => {}, get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
    const mount = (rows) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const table = new PagedTable(host, { headers: ['Id', 'Summary'], rows, pagination: true,
                                             stateStore, persistKey: 'paged', persistPage: true });
        table.render();
        return { host, table };
    };
    const a = mount(manyRows);
    a.table.goToPage(2);
    a.table.dispose(); a.host.remove();

    const b = mount(manyRows);
    assert.equal(firstShown(b.host), '#201', 'came back on page 1');
    b.table.dispose(); b.host.remove();

    const c = mount(manyRows.slice(0, 150));
    assert.equal(firstShown(c.host), '#101', 'a stale page past the end showed nothing');
    c.table.dispose(); c.host.remove();
});

/* BUG-0013, "filtering and sorting only work on the current page": they always
 * covered every row, but the table stayed on the page you were on — sorted
 * descending from page 3 of 250, it showed rows 50…1 — and a table sharing a
 * key across different row sets (ad-hoc views, search) reopened on the last
 * one's page. */
await t('a sort starts at the first page of the new order', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rows = Array.from({ length: 250 }, (_, i) => [i + 1, `row ${i + 1}`]);
    const table = new PagedTable(host, { headers: ['Id', 'Summary'], rows, pagination: true, sortable: true });
    table.render();
    table.goToPage(2);
    table.sortBy(0, false);
    assert.equal(table.getDisplayedRows()[0][0], 250, 'the sort kept the old page');
    assert.match(host.querySelector('.twm-pagination-controls').textContent, /1–100 of 250/);
    table.dispose();
    host.remove();
});

await t('persistPage: false keeps the sort but not the page', () => {
    const saved = new Map([['shared', { sortColumn: 0, sortAscending: false, filters: [], offset: 200 }]]);
    const stateStore = { ready: async () => {}, get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const table = new PagedTable(host, { headers: ['Id', 'Summary'], rows: manyRows, pagination: true, sortable: true,
                                         stateStore, persistKey: 'shared', persistPage: false });
    table.render();
    assert.equal(table.getDisplayedRows()[0][0], '#99', 'the sort was not restored, or the page was');
    table.dispose();
    host.remove();
});


console.log('\nInspector, end to end');

const { WindowManager } = await import('@flexdesk/wm');
const { createContentRegistry } = await import('@flexdesk/wm');
const { taxonomy } = await import(join(UI, 'tiling', 'kind_taxonomy.js'));

await t('clicking a name puts that person\'s list in the primary tile', async () => {
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url) => {
        const path = pageUrl(url);
        if (path.endsWith('/api/backlog')) return { ok: true, json: async () => ({ ok: true, items: FIXTURE }) };
        if (path.endsWith('/api/backlog/meta')) return { ok: true, json: async () => ({ ok: true, phases: [] }) };
        return { ok: true, json: async () => ({ ok: true, settings: {}, filters: [] }) };
    });

    const root = document.createElement('div');
    document.body.appendChild(root);

    const td = createTicketDeskContent({ eventBus: null });
    const bl = createBacklogContent({ eventBus: null });
    const content = createContentRegistry({ ...td, ...bl });

    const wm = new WindowManager({
        rootEl: root,
        content,
        taxonomy,
        // No persisted layout, and nothing to persist to.
        host: { state: { read: async () => null, write: async () => true } },
        ctx: {},
        onChange: () => {},
    });
    await wm.load();

    // Put a BACKLOG page in the primary tile and drill into a ticket, which is
    // the ordinary state when somebody glances at the team panel: you are
    // reading something, and you want to see what else is on that person.
    wm.openInPrimary('backlog', { filter: 'board' });
    wm.openInPrimary('item', { id: '2', label: 'STORY-0002' });

    const tree = wm.desktops.active().tree;
    const primary = () => tree.get(tree.primaryLeafId());
    const activeTab = () => { const l = primary(); return l.tabs[l.activeTabIdx]; };
    assert.equal(activeTab().kind, 'item', 'the fixture did not set up a drilled-in tile');

    // Now the thing the Inspector does.
    const { assigneeExpr } = await import(join(UI, 'ticketdesk', 'backlog_filters.js'));
    wm.openInPrimary('backlog', { expr: assigneeExpr('bob'), label: 'On bob' });

    const tab = activeTab();
    assert.equal(tab.kind, 'backlog', `the primary tile shows a ${tab.kind}, not the list`);
    assert.match(JSON.stringify(tab.props.expr || {}), /"bob"/,
        `the list is not filtered to bob: ${JSON.stringify(tab.props)}`);

    root.remove();
    put('fetch', realFetchLocal);
});

/* ── the ticket History tab ──────────────────────────────────────────
 *
 * The History pane shares a section with Comments, and `renderComments` wipes
 * its own slot on five separate paths — initial load, a post, a save, a cancel
 * and a live reload. That is why the active tab is remembered OUTSIDE the slot,
 * and why "post a comment and the tab you were on is still the tab you are on"
 * is asserted here rather than assumed.
 *
 * The tab strip is `.td-tab`, deliberately NOT `.twm-bp__tab`:
 * `ui/js/tiling/keymap.js` binds Shift+Left/Right to every `.twm-bp__tabs
 * .twm-bp__tab` in the document and finds "current" by the single `--on`, so
 * borrowing the bottom panel's class makes a documented shortcut start clicking
 * a ticket's tabs. Asserted rather than described.
 */

console.log('\nThe ticket History tab');

/** A full bug, as `GET /api/bugs/42` returns it. */
const bug42 = (over = {}) => ({
    id: 42, title: 'Save button does nothing on the settings page',
    status: 'testing', severity: 'medium', type: 'bug', subsystem: 'settings',
    assignee: 'alice', reporter: 'norman', labels: [], links: [],
    created: '2026-07-14', updated: '2026-09-12', stage: 2, pri: 3,
    description: 'Steps to reproduce, expected vs. actual.', comments: [],
    history: [
        { date: '2026-09-11', actor: 'alice_agent', field: 'status', from: 'open', to: 'investigation', note: '' },
        { date: '2026-09-11', actor: 'alice_agent', field: 'assignee', from: 'alice', to: 'alice_agent', note: '' },
        { date: '2026-09-12', actor: 'alice_agent', field: 'status', from: 'investigation', to: 'testing', note: '' },
    ],
    ...over,
});

const STORY_7 = {
    id: 7, type: 'story', title: 'Log in with the company SSO provider',
    status: 'refined', parent: 0, assignee: '', reporter: 'alice',
    due: '', points: 5, subsystem: 'auth', labels: [], links: [], criteria: [],
};

/**
 * Mount the ticket detail page over a stubbed bridge, collecting every POST.
 *
 * `mountTicket` finds its record by `props.id` in the LIVE store, exactly as a
 * real navigation does, so `loadData()` has to run behind the stub first — the
 * same shape the backlog sections above use with `loadBacklog()`.
 */
const mountTicketPage = async (bug, {
    items = [], others = [], postBug = null, target = null, targetNoted = true, wm = null,
} = {}) => {
    const posts = [];
    const realFetchLocal = globalThis.fetch;
    put('fetch', async (url, opts) => {
        const path = pageUrl(url);
        if (opts?.method === 'POST') {
            posts.push({ path, body: JSON.parse(opts.body) });
            return { ok: true, json: async () => ({ ok: true, bug: postBug || bug, target, targetNoted }) };
        }
        if (/\/api\/bugs\/\d+$/.test(path)) return { ok: true, json: async () => ({ ok: true, bug }) };
        if (path.endsWith('/api/bugs')) return { ok: true, json: async () => ({ ok: true, bugs: [bug, ...others] }) };
        if (path.endsWith('/api/meta')) return { ok: true, json: async () => ({ ok: true, byAssignee: {} }) };
        if (path.endsWith('/api/backlog')) return { ok: true, json: async () => ({ ok: true, items }) };
        if (path.endsWith('/api/backlog/meta')) return { ok: true, json: async () => ({ ok: true, phases: [] }) };
        return { ok: true, json: async () => ({ ok: true, settings: {}, filters: [] }) };
    });
    const bugsData = await import(join(UI, 'ticketdesk', 'data.js'));
    await bugsData.loadData();
    // ITEMS is emptied deliberately: the page is supposed to load the other
    // store ITSELF, so leaving a previous section's fixture in place would hide
    // exactly the failure invariant 15 is about.
    await backlogData.loadBacklog();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = createTicketDeskContent({ eventBus: null }).ticket(host, { id: `#${bug.id}` }, { wm });
    await tick(); await tick(); await tick();
    return {
        host, posts,
        done: () => { page.destroy?.(); host.remove(); put('fetch', realFetchLocal); },
    };
};

await t('a bug can go back to open from every later stage, and the move is saved', async () => {
    for (const status of ['investigation', 'testing', 'closed']) {
        const m = await mountTicketPage(bug42({ status, stage: { investigation: 1, testing: 2, closed: 3 }[status], comments: [] }));
        const back = [...m.host.querySelectorAll('[data-wf]')].find((b) => b.dataset.wf === 'open');
        assert.ok(back, `no way back to open from ${status}`);
        assert.equal(back.textContent.trim(), status === 'closed' ? 'Reopen' : 'Back to open');
        if (status !== 'closed') assert.ok(!back.classList.contains('td-stageaction--primary'), `Back to open is the primary action on ${status}`);
        back.click();
        for (let i = 0; i < 6; i++) await tick();
        const ta = document.querySelector('.twm-managed-window textarea, .managed-window textarea');
        assert.ok(ta, `no message dialog for Back to open from ${status}`);
        ta.value = 'Not ours to fix yet.';
        ta.closest('form').querySelector('button[type="submit"]').click();
        for (let i = 0; i < 6; i++) await tick();
        const saved = m.posts.find((p) => /\/api\/bugs\/42$/.test(p.path));
        assert.equal(saved?.body.status, 'open', `the move from ${status} did not save status: open`);
        m.done();
    }
    const fresh = await mountTicketPage(bug42({ status: 'open', stage: 0 }));
    assert.ok(![...fresh.host.querySelectorAll('[data-wf]')].some((b) => b.dataset.wf === 'open'),
        'an open bug offers to go back to open');
    fresh.done();
});

/* ── a status move and its message ────────────────────────────────── */

const moves = await import(join(UI, 'ticketdesk', 'bug_transitions.js'));
const moveBugData = await import(join(UI, 'ticketdesk', 'data.js'));
const me = moveBugData.HUMAN_AUTHOR;
const stampNow = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().slice(0, 16) + 'Z';

await t('every move but "Start investigation" needs a message; Closed has one Reopen, to open', () => {
    assert.equal(moves.needsMessage('open', 'investigation'), false);
    for (const [from, list] of Object.entries(moves.BUG_TRANSITIONS)) {
        for (const [, to] of list) if (!(from === 'open' && to === 'investigation')) assert.equal(moves.needsMessage(from, to), true, `${from} -> ${to}`);
    }
    assert.deepEqual(moves.BUG_TRANSITIONS.closed, [['Reopen', 'open']]);
});

await t('your own comment from the last five minutes is the message; older, someone else\'s or date-only is not', () => {
    const c = (date, author = me, note = '') => [{ date, author, body: 'x', note }];
    assert.ok(moves.recentMessage(c(stampNow(60 * 1000)), me));
    assert.equal(moves.recentMessage(c(stampNow(6 * 60 * 1000)), me), null, 'six minutes ago still counted');
    assert.equal(moves.recentMessage(c(stampNow(60 * 1000), 'someone_else'), me), null, 'somebody else\'s comment counted');
    assert.equal(moves.recentMessage(c(new Date().toISOString().slice(0, 10)), me), null, 'a date-only header counted');
    assert.equal(moves.recentMessage(c(stampNow(60 * 1000), me, 'status: open -> investigation'), me), null, 'a comment that is already a message counted twice');
});

/** Click a stage action on a mounted bug page; resolve once the page settled. */
const clickMove = async (m, target) => {
    const btn = [...m.host.querySelectorAll('[data-wf]')].find((b) => b.dataset.wf === target);
    assert.ok(btn, `no ${target} action`);
    btn.click();
    for (let i = 0; i < 6; i++) await tick();
};
const modalTextarea = () => document.querySelector('.twm-managed-window textarea, .managed-window textarea');

await t('Close asks for a close message in a modal and saves it with the move', async () => {
    const m = await mountTicketPage(bug42({ status: 'testing', stage: 2, comments: [] }));
    await clickMove(m, 'closed');
    const ta = modalTextarea();
    assert.ok(ta, 'no message dialog opened');
    assert.match(ta.closest('form').textContent, /Close message/);
    assert.equal(m.posts.length, 0, 'the move saved before the message was given');
    ta.value = 'Fixed by the parser change.';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    ta.closest('form').querySelector('button[type="submit"]').click();
    for (let i = 0; i < 6; i++) await tick();
    const saved = m.posts.find((p) => /\/api\/bugs\/42$/.test(p.path));
    assert.equal(saved?.body.status, 'closed');
    assert.equal(saved?.body.comment, 'Fixed by the parser change.');
    m.done();
});

await t('cancelling the message dialog cancels the move', async () => {
    const m = await mountTicketPage(bug42({ status: 'testing', stage: 2, comments: [] }));
    await clickMove(m, 'open');
    const form = modalTextarea()?.closest('form');
    assert.ok(form, 'no dialog for Back to open');
    form.querySelector('[data-action="cancel"]').click();
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(m.posts.length, 0, 'the move was saved anyway');
    m.done();
});

await t('a comment you posted moments ago is the message: no dialog, and the bridge tags it', async () => {
    const m = await mountTicketPage(bug42({ status: 'investigation', stage: 1,
        comments: [{ date: stampNow(90 * 1000), author: me, body: 'Found it: the regex.', note: '' }] }));
    await clickMove(m, 'testing');
    assert.equal(modalTextarea(), null, 'a dialog asked for a message that already exists');
    const saved = m.posts.find((p) => /\/api\/bugs\/42$/.test(p.path));
    assert.equal(saved?.body.status, 'testing');
    assert.equal(saved?.body.tagRecentComment, true);
    assert.equal(saved?.body.comment, undefined);
    m.done();
});

await t('Start investigation needs no message', async () => {
    const m = await mountTicketPage(bug42({ status: 'open', stage: 0, comments: [] }));
    await clickMove(m, 'investigation');
    assert.equal(modalTextarea(), null);
    assert.equal(m.posts.find((p) => /\/api\/bugs\/42$/.test(p.path))?.body.status, 'investigation');
    m.done();
});

await t('a status change\'s message shows its tag in the thread', async () => {
    const m = await mountTicketPage(bug42({ comments: [
        { date: '2026-09-13T14:05Z', author: me, body: 'Verified.', note: 'status: testing -> closed' },
        { date: '2026-09-12', author: me, body: 'Plain.', note: '' },
    ] }));
    const tags = [...m.host.querySelectorAll('[data-slot="comments"] .td-chip--status')].map((e) => e.textContent.trim());
    assert.deepEqual(tags, ['Testing → Closed']);
    // The message is marked as a whole, and the tag sits last in its header.
    const entries = [...m.host.querySelectorAll('[data-slot="comments"] .td-wentry')];
    const moved = entries.map((e) => e.classList.contains('td-wentry--move'));
    assert.deepEqual(moved.filter(Boolean).length, 1, `exactly one entry is a status message: ${moved}`);
    const head = entries[moved.indexOf(true)].querySelector('.td-wentry__head');
    // Last but for the edit pencil, which always closes the header.
    assert.ok(head.lastElementChild.matches('[data-a="edit-comment"]'), 'no edit pencil at the end of the header');
    assert.equal(head.lastElementChild.previousElementSibling.className, 'td-chip td-chip--status');
    // The author is named once: the badge beside the name repeated it.
    assert.deepEqual([...head.querySelectorAll('.td-chip')].map((c) => c.className),
        ['td-chip td-chip--status'], 'the author is named twice in the header');
    assert.equal(head.querySelector('b').textContent, me);
    m.done();
});

/* BUG-0012: a comment can be edited. The pencil addresses the comment by its
 * position in the FILE — the thread is drawn newest first — plus the date and
 * author shown, and only the text goes to the bridge. */
await t('editing a comment posts its file index, date, author and the new text', async () => {
    const realFetchLocal = globalThis.fetch;
    const m = await mountTicketPage(bug42({ comments: [
        { date: '2026-09-12', author: 'alice', body: 'Oldest.', note: '' },
        { date: '2026-09-13T14:05Z', author: me, body: 'Newest.', note: '' },
    ] }));
    let posted = null;
    put('fetch', async (url, init) => {
        if (init?.method === 'POST' && /\/bugs\/42\/comments\/\d+$/.test(String(url))) {
            posted = { url: String(url), body: JSON.parse(init.body) };
            return new Response(JSON.stringify({ ok: true, bug: { id: 42, title: 'x', status: 'open', comments: [], history: [] } }),
                                { headers: { 'content-type': 'application/json' } });
        }
        return realFetchLocal(url, init);
    });
    try {
        const entries = [...m.host.querySelectorAll('[data-slot="comments"] .td-wentry')];
        const oldest = entries.find((e) => e.textContent.includes('Oldest.'));
        assert.equal(oldest.dataset.cidx, '0', 'the oldest comment is not file index 0');
        oldest.querySelector('[data-a="edit-comment"]').click();
        const ta = oldest.querySelector('.td-wentry__editor textarea');
        assert.ok(ta, 'no editor opened');
        assert.equal(ta.value, 'Oldest.');
        ta.value = 'Oldest, edited.';
        oldest.querySelector('.td-mde__submit').click();
        for (let i = 0; i < 20 && !posted; i++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(posted, 'nothing was posted');
        assert.match(posted.url, /\/bugs\/42\/comments\/0$/);
        assert.deepEqual(posted.body, { date: '2026-09-12', author: 'alice', body: 'Oldest, edited.' });
    } finally {
        put('fetch', realFetchLocal);
        m.done();
    }
});

await t('the History pane exists, starts hidden, and Comments does not', async () => {
    const m = await mountTicketPage(bug42());
    const h = m.host.querySelector('[data-slot="history"]');
    const c = m.host.querySelector('[data-slot="comments"]');
    assert.ok(h, 'no history pane');
    assert.equal(h.hidden, true, 'the history pane opened instead of Comments');
    assert.equal(c.hidden, false, 'the comments pane is hidden on arrival');
    m.done();
});

await t('three stored rows and one derived "filed" row, newest first', async () => {
    const m = await mountTicketPage(bug42());
    const rows = [...m.host.querySelectorAll('.td-audit--inline > div')];
    assert.equal(rows.length, 4, `${rows.length} rows, expected 3 stored + 1 derived`);
    assert.ok(rows.at(-1).classList.contains('td-audit__synthetic'),
        'the derived "filed" row is not last');
    assert.ok(!rows.slice(0, 3).some((r) => r.classList.contains('td-audit__synthetic')),
        'a stored row is marked as derived');
    const dates = rows.map((r) => r.querySelector('.td-dim.td-mono')?.textContent.trim());
    assert.deepEqual(dates, ['2026-09-12', '2026-09-11', '2026-09-11', '2026-07-14']);
    for (const r of rows) {
        assert.ok(r.querySelector('.td-dim.td-mono'), 'a row has no date');
        assert.ok(r.querySelector('.td-link'), 'a row has no actor');
    }
    m.done();
});

await t('clicking History moves the tab, both panes and the note', async () => {
    const m = await mountTicketPage(bug42());
    const note = () => m.host.querySelector('[data-slot="tabnote"]').textContent;
    const before = note();
    m.host.querySelector('[data-tab="history"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(m.host.querySelector('[data-tab="history"]').classList.contains('td-tab--on'));
    assert.ok(!m.host.querySelector('[data-tab="comments"]').classList.contains('td-tab--on'));
    assert.equal(m.host.querySelector('[data-slot="history"]').hidden, false);
    assert.equal(m.host.querySelector('[data-slot="comments"]').hidden, true);
    assert.notEqual(note(), before, 'the note beside the tabs did not change');
    m.done();
});

await t('posting a comment leaves the History tab active', async () => {
    // renderComments replaces the whole comments slot, which is why `recordTab`
    // lives outside it. Without that, every post silently snapped the reader
    // back to Comments.
    const m = await mountTicketPage(bug42());
    m.host.querySelector('[data-tab="history"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const ta = m.host.querySelector('[data-slot="comments"] textarea');
    ta.value = 'still looking at the audit trail';
    m.host.querySelector('[data-slot="comments"] .td-mde__submit')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick(); await tick();
    assert.equal(m.posts.at(-1).path.endsWith('/api/bugs/42/comments'), true);
    assert.equal(m.host.querySelector('[data-slot="history"]').hidden, false,
        'the post snapped the pane back to Comments');
    m.done();
});

await t('a record with nothing recorded says so', async () => {
    const m = await mountTicketPage(bug42({ history: [], created: '' }));
    assert.ok(m.host.querySelector('[data-slot="history"] .td-dim.td-empty'),
        'an empty history rendered as an empty box, not as a sentence');
    m.done();
});

await t('the tab strip is not the bottom panel\'s', async () => {
    // Shift+Left/Right is bound to `.twm-bp__tabs .twm-bp__tab` across the whole
    // document; a ticket borrowing the class makes that shortcut click here.
    const m = await mountTicketPage(bug42());
    assert.equal(m.host.querySelectorAll('.td-tab').length, 2);
    assert.equal(m.host.querySelectorAll('.twm-bp__tab').length, 0,
        'the record tabs use the bottom panel\'s class');
    m.done();
});

/* ── cross-store link rows ───────────────────────────────────────────
 *
 * The link pane is the one place a bug and a backlog item meet, and the two page
 * kinds disagree about ids: the ticket page routes on `'#42'` and the item page
 * on `'7'`. `records.openRow` is the only new code that knows that, so what is
 * asserted here is the navigation it produces, not the markup around it.
 */

console.log('\nCross-store link rows');

const navSpy = () => {
    const calls = [];
    return { calls, navigate: (kind, props, opts) => calls.push({ kind, props, opts }) };
};

await t('an outgoing cross-store link resolves, shows and navigates', async () => {
    const wm = navSpy();
    const m = await mountTicketPage(bug42({ links: ['implements STORY-0007'] }),
        { items: [STORY_7], wm });
    const row = m.host.querySelector('[data-slot="links"] .td-linkrow');
    assert.ok(row, 'no link row at all');
    assert.match(row.textContent, /STORY-0007/);
    assert.match(row.textContent, /company SSO/, 'the item resolved to (no such item)');
    const btn = row.querySelector('[data-open]');
    assert.equal(btn.dataset.open, 'backlog:7');
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(wm.calls.at(-1).kind, 'item');
    assert.equal(wm.calls.at(-1).props.id, '7', 'the item page was routed with a #-prefixed id');
    m.done();
});

await t('a same-store link still routes as a ticket, on the #-prefixed id', async () => {
    // The asymmetry `openRow` exists to hold: a bare number in a bug's links is a
    // BUG, and the ticket page routes on `'#47'` while the item page routes on `'7'`.
    const wm = navSpy();
    const m = await mountTicketPage(bug42({ links: ['blocks 47'] }),
        { others: [{ ...bug42(), id: 47, title: 'The other one' }], wm });
    const btn = m.host.querySelector('[data-slot="links"] [data-open]');
    assert.equal(btn.dataset.open, 'bugs:47');
    assert.equal(btn.textContent.trim(), '#47');
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(wm.calls.at(-1).kind, 'ticket');
    assert.equal(wm.calls.at(-1).props.id, '#47');
    m.done();
});

await t('an inbound cross-store row appears with ITEMS empty at mount', async () => {
    // The page loads the other store itself, so a story carrying `blocks BUG-0042`
    // produces an "is blocked by STORY-0008" row without the user ever having
    // opened a backlog page. Nothing is written on the bug's own file.
    const story8 = { ...STORY_7, id: 8, title: 'Export a queue to CSV and JSON',
        links: ['blocks BUG-0042'] };
    const m = await mountTicketPage(bug42({ links: [] }), { items: [story8] });
    const row = m.host.querySelector('[data-slot="links"] .td-linkrow');
    assert.ok(row, 'the derived row never appeared');
    assert.match(row.textContent, /is blocked by/);
    assert.match(row.textContent, /STORY-0008/);
    // Derived, so it is not removable from here.
    assert.equal(row.querySelector('[data-unlink]'), null, 'a derived row offers Remove');
    assert.match(row.textContent, /from STORY-0008/);
    m.done();
});

await t('a Ctrl-click does not navigate the tile you are reading', async () => {
    const wm = navSpy();
    const m = await mountTicketPage(bug42({ links: ['implements STORY-0007'] }),
        { items: [STORY_7], wm });
    m.host.querySelector('[data-slot="links"] [data-open]')
        .dispatchEvent(new dom.window.MouseEvent('click', { ctrlKey: true, bubbles: true }));
    await tick();
    assert.ok(!wm.calls.some((c) => c.opts?.dest === 'origin'),
        'a modified click navigated in place instead of going through openModified');
    m.done();
});

/* ── duplicate and close ─────────────────────────────────────────────
 *
 * One request for one act: link, close, record the transition, comment on both
 * records. Two requests would be a half-applied duplicate whenever the second
 * one failed, and the record would then be closed with nothing saying why.
 */

console.log('\nDuplicate and close');

await t('the picker offers both stores and finds a master by TITLE', async () => {
    const m = await mountTicketPage(bug42(), { items: [STORY_7] });
    m.host.querySelector('[data-wfa="duplicate"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    const picker = document.querySelector('.bd-picker');
    assert.ok(picker, 'no picker opened');
    // BUG-0011: a modal ManagedWindow like every other dialog, not a bare overlay.
    const win = picker.closest('.twm-managed-window');
    assert.ok(win, 'the picker is not in a ManagedWindow');
    assert.ok(win.classList.contains('twm-managed-window--modal'), 'the picker window is not modal');
    assert.ok(picker.querySelector('[data-store="bugs"]'), 'the Bugs store is not offered');
    assert.ok(picker.querySelector('[data-store="backlog"]'), 'the Backlog store is not offered');
    // Searching by title is the primary way a master is found: "what is #42 a
    // duplicate of?" is answered with a word somebody remembers, not with an id.
    const input = picker.querySelector('.bd-picker__input');
    input.value = 'SSO';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    assert.ok(picker.querySelector('[data-pick="backlog:7"]'), 'a title search lost the row');
    picker.querySelector('[data-a="cancel"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    m.done();
});

await t('picking a master issues exactly ONE post, and repaints from it', async () => {
    const closed = bug42({ status: 'closed', stage: 3, links: ['duplicates STORY-0007'] });
    const m = await mountTicketPage(bug42(), {
        items: [STORY_7],
        postBug: closed,
        target: { store: 'backlog', id: 7, ref: 'STORY-0007', title: STORY_7.title },
    });
    m.host.querySelector('[data-wfa="duplicate"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    document.querySelector('.bd-picker [data-pick="backlog:7"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick(); await tick();

    assert.equal(m.posts.length, 1,
        `${m.posts.length} writes for one act: ${JSON.stringify(m.posts)}`);
    assert.ok(m.posts[0].path.endsWith('/api/bugs/42/duplicate-of'), m.posts[0].path);
    assert.equal(m.posts[0].body.target, 'STORY-0007');
    // Repainted from the response, with no follow-up GET.
    assert.ok(m.host.querySelector('.td-stage--active')?.textContent.includes('Closed'));
    assert.match(m.host.querySelector('[data-slot="links"]').textContent, /duplicates/);
    assert.match(m.host.querySelector('[data-slot="links"]').textContent, /STORY-0007/);
    m.done();
});

await t('escaping the picker writes nothing at all', async () => {
    const m = await mountTicketPage(bug42(), { items: [STORY_7] });
    m.host.querySelector('[data-wfa="duplicate"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(); await tick();
    assert.deepEqual(m.posts, [], `a cancelled duplicate wrote ${JSON.stringify(m.posts)}`);
    m.done();
});

await t('a closed bug is not offered the action', async () => {
    const m = await mountTicketPage(bug42({ status: 'closed', stage: 3 }));
    assert.equal(m.host.querySelector('[data-wfa="duplicate"]'), null,
        'a closed bug can be closed again as a duplicate');
    m.done();
});

/* ── reporter is shown, never guessed ────────────────────────────────
 *
 * `reporter == ""` means "the configured human" and is never backfilled: a guess
 * written as a fact stops looking like a gap. So the control has to be able to
 * hold a name that is off the roster, and an ordinary save of a legacy record
 * must not insert a `reporter:` line nobody typed.
 */

console.log('\nReporter');

await t('Reporter is a real select, over a list containing its own value', async () => {
    const m = await mountTicketPage(bug42({ reporter: 'norman' }));   // off the stubbed roster
    const sel = m.host.querySelector('[data-f="reporter"]');
    assert.ok(sel, 'no reporter control');
    assert.equal(sel.tagName, 'SELECT');
    assert.ok([...sel.options].some((o) => o.value === 'norman'),
        'the record\'s own reporter is not on the list, so a save would rewrite it');
    assert.equal(sel.value, 'norman');
    m.done();
});

await t('an unchanged reporter is not sent', async () => {
    const m = await mountTicketPage(bug42({ reporter: '' }));
    const title = m.host.querySelector('[data-f="summary"]');
    title.value = 'renamed';
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    m.host.querySelector('[data-a="save"]').click();
    await tick(); await tick();
    assert.ok(!('reporter' in m.posts.at(-1).body),
        'saving a legacy record would insert a reporter: line nobody typed');
    m.done();
});

await t('a changed reporter IS sent', async () => {
    const m = await mountTicketPage(bug42({ reporter: '' }));
    const sel = m.host.querySelector('[data-f="reporter"]');
    sel.value = 'bob';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    m.host.querySelector('[data-a="save"]').click();
    await tick(); await tick();
    assert.equal(m.posts.at(-1).body.reporter, 'bob');
    m.done();
});

await t('the reassign button focuses the field it names', async () => {
    const m = await mountTicketPage(bug42());
    const btn = m.host.querySelector('[data-a="setreporter"]');
    assert.ok(btn, 'no set-reporter button');
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(document.activeElement, m.host.querySelector('[data-f="reporter"]'));
    m.done();
});

await t('the assignee select cannot fabricate a value', async () => {
    // `agent` is not in the stubbed roster. Without the option list being widened
    // with the record's own value, the browser falls back to the first option and
    // merely opening and saving a record REASSIGNS it — and with ## History it
    // stamps that as a recorded decision.
    const m = await mountTicketPage(bug42({ assignee: 'agent' }));
    const sel = m.host.querySelector('[data-f="assignee"]');
    assert.equal(sel.value, 'agent', 'the select could not hold an off-roster assignee');
    m.host.querySelector('[data-f="summary"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    m.host.querySelector('[data-a="save"]').click();
    await tick(); await tick();
    assert.equal(m.posts.at(-1).body.assignee, 'agent');
    m.done();
});

/* ── the item page reaches parity ────────────────────────────────────
 *
 * The item page had no Links section at all, so a link written into an item was
 * invisible from the item — readable only from whichever bug happened to point
 * back. Same vocabulary, same hooks, same tabs as the ticket page.
 */

console.log('\nItem page parity');

const itemRecord = (over = {}) => ({
    id: 4, type: 'story', title: 'Operations feed cutover', status: 'draft',
    ladder: ['draft', 'refined', 'in-progress', 'review', 'done'],
    parent: 1, phase: '', effectivePhase: '', assignee: 'bob', reporter: 'alice',
    due: '', effectiveDue: '', points: '', subsystem: 'unsorted',
    labels: [], links: [], created: '2026-09-02', updated: '2026-09-12',
    description: 'x', acceptance: '', criteria: [], comments: [], history: [],
    children: 0, ancestors: [], childItems: [],
    ...over,
});

await t('an item link row points at a bug, by ref', async () => {
    const m = await mountItemPage(itemRecord({ links: ['blocks BUG-0042'] }));
    const slot = m.host.querySelector('[data-slot="links"]');
    assert.ok(slot, 'the item page still has no Links section');
    const btn = slot.querySelector('[data-open]');
    assert.ok(btn, 'no link row');
    assert.equal(btn.dataset.open, 'bugs:42');
    m.done();
});

await t('the item page has the same History tab', async () => {
    const m = await mountItemPage(itemRecord({
        history: [{ date: '2026-09-11', actor: 'alice_agent', field: 'status', from: 'draft', to: 'refined', note: '' }],
    }));
    const h = m.host.querySelector('[data-slot="history"]');
    assert.ok(h, 'no history pane on the item page');
    assert.equal(h.hidden, true);
    m.host.querySelector('[data-tab="history"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(h.hidden, false);
    assert.equal(m.host.querySelector('[data-slot="comments"]').hidden, true);
    m.done();
});

await t('an open item is offered the duplicate action and a dropped one is not', async () => {
    const open = await mountItemPage(itemRecord());
    assert.ok(open.host.querySelector('[data-wfa="duplicate"]'), 'a draft item cannot be duplicated');
    open.done();
    const dropped = await mountItemPage(itemRecord({ status: 'dropped' }));
    assert.equal(dropped.host.querySelector('[data-wfa="duplicate"]'), null,
        'a dropped item can be dropped again as a duplicate');
    dropped.done();
});

await t('typing a link target is not an unsaved edit to the record', async () => {
    // The two link controls are `[data-f]` because that is how the mount finds
    // its fields — but arming Save from them would make the picker's own write
    // into the field look like a pending change to the item.
    const m = await mountItemPage(itemRecord());
    const field = m.host.querySelector('[data-f="linktarget"]');
    field.value = 'BUG-0042';
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(m.host.querySelector('[data-a="save"]').disabled, true,
        'typing a link target armed Save');
    m.done();
});

/* ── #references become record links while typing ──────────────────── */

console.log('\nRecord references while typing');

{
    const realFetchRefs = globalThis.fetch;
    put('fetch', async (url) => {
        const path = pageUrl(url);
        if (path.endsWith('/api/bugs')) return { ok: true, json: async () => ({ ok: true, bugs: [bug42()] }) };
        if (path.endsWith('/api/meta')) return { ok: true, json: async () => ({ ok: true, byAssignee: {} }) };
        if (path.endsWith('/api/backlog')) return { ok: true, json: async () => ({ ok: true, items: FIXTURE }) };
        if (path.endsWith('/api/backlog/meta')) return { ok: true, json: async () => ({ ok: true, phases: [] }) };
        return { ok: true, json: async () => ({ ok: true, settings: {}, filters: [] }) };
    });
    const refBugs = await import(join(UI, 'ticketdesk', 'data.js'));
    await refBugs.loadData();
    await backlogData.loadBacklog();
    const auto = await import(join(UI, 'ticketdesk', 'ref_autolink.js'));
    const { renderMarkdown: md } = await import(join(UI, 'ticketdesk', 'markdown.js'));

    /** A textarea with the autolink on, and a way to type into it. */
    const editor = () => {
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        const handle = auto.attachRefAutolink(ta);
        ta.focus();
        const type = (text) => {
            for (const ch of text) {
                const at = ta.selectionStart;
                ta.value = ta.value.slice(0, at) + ch + ta.value.slice(ta.selectionEnd);
                ta.setSelectionRange(at + 1, at + 1);
                ta.dispatchEvent(new dom.window.InputEvent('input',
                    { bubbles: true, inputType: ch === '\n' ? 'insertLineBreak' : 'insertText', data: ch }));
            }
        };
        const key = (k) => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        return { ta, type, key, done: () => { handle.destroy(); ta.remove(); } };
    };

    await t('a # reference is found only where a person would mean one', () => {
        const at = (text) => auto.refCandidate(text, text.length)?.token ?? null;
        assert.equal(at('see #42'), '42');
        assert.equal(at('#STORY-7'), 'STORY-7');
        assert.equal(at('(see #42'), '42');
        assert.equal(at('abc#42'), null, 'inside a word');
        assert.equal(at('&#39'), null, 'an HTML entity');
        assert.equal(at('page/#42'), null, 'a URL fragment');
        assert.equal(at('[#42](#BUG-0042'), null, 'an existing link target');
        assert.equal(at('`code #42'), null, 'inline code');
        assert.equal(at('```\nfenced #42'), null, 'a fenced block');
        assert.equal(at('#todo'), null, 'not a reference at all');
    });

    await t('#42 then a space becomes a link to bug 42', () => {
        const e = editor();
        e.type('see #42 ');
        assert.equal(e.ta.value, 'see [#42](#BUG-0042) ');
        assert.equal(e.ta.selectionStart, e.ta.value.length, 'the caret did not follow the rewrite');
        e.done();
    });

    await t('#TASK-2 links item 2 under the prefix its record really has', () => {
        const e = editor();
        e.type('blocked by #TASK-2.');
        assert.equal(e.ta.value, 'blocked by [STORY-0002](#STORY-0002).');
        e.done();
    });

    await t('a reference to nothing is left as typed', () => {
        const e = editor();
        e.type('see #999 and #STORY-404 ');
        assert.equal(e.ta.value, 'see #999 and #STORY-404 ');
        e.done();
    });

    await t('Esc right after the conversion puts back what was typed', () => {
        const e = editor();
        e.type('see #42 ');
        e.key('Escape');
        assert.equal(e.ta.value, 'see #42 ');
        assert.equal(e.ta.selectionStart, 'see #42 '.length);
        e.done();
    });

    await t('Esc after typing on is an ordinary Esc, and undoes nothing', () => {
        const e = editor();
        e.type('see #42 now');
        e.key('Escape');
        assert.equal(e.ta.value, 'see [#42](#BUG-0042) now');
        e.done();
    });

    await t('a rendered record link opens in the app, not in a browser tab', () => {
        const html = md('see [#42](#BUG-0042) and [STORY-0002](#story-0002) and [docs](https://example.com)');
        const box = document.createElement('div');
        box.innerHTML = html;
        const [bug, story, web] = box.querySelectorAll('a');
        assert.equal(bug.className, 'td-reflink');
        assert.equal(bug.dataset.ref, 'BUG-0042');
        assert.equal(bug.getAttribute('target'), null);
        assert.equal(story.dataset.ref, 'STORY-0002');
        assert.equal(web.getAttribute('target'), '_blank', 'an ordinary link changed');
    });

    await t('clicking a record link opens that record beside the page', async () => {
        const opened = [];
        const wm = { navigate: (kind, props, opts) => opened.push({ kind, id: props.id, newTab: !!opts?.newTab }) };
        const clicks = auto.installRecordLinkClicks({ wm });
        const box = document.createElement('div');
        box.innerHTML = md('[#42](#BUG-0042) [STORY-0002](#STORY-0002)');
        document.body.appendChild(box);
        for (const a of box.querySelectorAll('a')) a.click();
        await tick();
        assert.deepEqual(opened, [{ kind: 'ticket', id: '#42', newTab: true }, { kind: 'item', id: '2', newTab: true }]);
        clicks.dispose();
        box.remove();
    });

    put('fetch', realFetchRefs);
}

/* ── `updated` to the minute ─────────────────────────────────────────── */

console.log('\nUpdated, to the minute');

{
    const stampData = await import(join(UI, 'ticketdesk', 'data.js'));
    const engine = await import(join(UI, 'ticketdesk', 'filter_engine.js'));
    const { formatStamp } = stampData;
    const local = (iso) => {
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    await t('a UTC stamp reads as the reader\'s local time to the minute', () => {
        assert.equal(formatStamp('2026-09-13T14:05Z'), local('2026-09-13T14:05:00Z'));
        assert.match(formatStamp('2026-09-13T14:05Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    await t('a stamp with no zone is UTC; an explicit offset is honoured', () => {
        assert.equal(formatStamp('2026-09-13 14:05'), local('2026-09-13T14:05:00Z'));
        assert.equal(formatStamp('2026-09-13T14:05+02:00'), local('2026-09-13T12:05:00Z'));
        assert.equal(formatStamp('2026-09-13T14:05:59Z'), local('2026-09-13T14:05:00Z'));
    });

    await t('a date from before timestamps, or nothing, is shown as written', () => {
        assert.equal(formatStamp('2026-07-14'), '2026-07-14');
        assert.equal(formatStamp(''), '');
        assert.equal(formatStamp(undefined), '');
        assert.equal(formatStamp('soon'), 'soon');
    });

    await t('the date filters still read a timestamped Updated by its date', () => {
        const { createFilterModel } = engine;
        const model = createFilterModel({ fields: [{ key: 'updated', label: 'Updated', type: 'date', get: (r) => r.updated }] });
        const rows = [{ updated: '2026-09-13 16:05' }, { updated: '2026-09-12' }, { updated: '2026-09-12 23:59' }];
        const on12 = rows.filter(model.matcherFor({ kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'updated', op: 'is', value: '2026-09-12' }] }));
        assert.deepEqual(on12.map((r) => r.updated), ['2026-09-12', '2026-09-12 23:59']);
    });
}

/* ── record schema: custom fields, hidden built-ins, custom statuses ──
 *
 * EPIC-0003. The schema arrives with the config (project.json's `schema`); these
 * set it directly, then check what each surface derives from it. */

console.log('\nRecord schema');
{
    const schema = await import(join(UI, 'ticketdesk', 'schema.js'));
    const moves = await import(join(UI, 'ticketdesk', 'bug_transitions.js'));
    const { mountCustomFields } = await import(join(UI, 'ticketdesk', 'custom_fields.js'));
    const { createFilterModel } = await import(join(UI, 'ticketdesk', 'filter_engine.js'));
    const SCHEMA = {
        types: {
            bugs: {
                bug: {
                    fields: [
                        { name: 'not_before', label: 'Not before', type: 'date', required: false, values: [] },
                        { name: 'env', label: 'Environment', type: 'choice', required: true, values: ['prod', 'staging'] },
                        { name: 'cost', label: 'Cost', type: 'number', required: false, values: [] },
                        { name: 'paid', label: 'Paid', type: 'bool', required: false, values: [] },
                    ],
                    hidden: ['subsystem'],
                    statuses: [
                        { name: 'blocked', label: 'Blocked', category: 'waiting', after: 'investigation' },
                        { name: 'wontfix', label: "Won't fix", category: 'finished', after: '' },
                    ],
                },
                regression: { fields: [], hidden: ['subsystem'], statuses: [] },
            },
        },
        warnings: [],
    };
    schema.setSchema(SCHEMA);

    await t('a custom status sorts where it was put, a finished one at the end', () => {
        assert.deepEqual(schema.withCustomStatuses('bugs', 'bug', ['open', 'investigation', 'testing', 'closed']),
            ['open', 'investigation', 'blocked', 'testing', 'closed', 'wontfix']);
    });

    await t('a status counts as its category; an unknown one stays open', () => {
        assert.equal(schema.statusCategory('bugs', 'bug', 'blocked'), 'waiting');
        assert.equal(schema.isFinished('bugs', 'bug', 'wontfix'), true);
        assert.equal(schema.isFinished('bugs', 'bug', 'closed'), true);
        assert.equal(schema.isFinished('bugs', 'bug', 'gone-from-the-schema'), false);
        // Custom statuses are per type: a regression has none.
        assert.equal(schema.customStatus('bugs', 'regression', 'blocked'), null);
    });

    await t('an open bug is offered a move into each custom status, after its own', () => {
        assert.deepEqual(moves.bugMoves('investigation', 'bug').map(([, to]) => to),
            ['testing', 'closed', 'open', 'blocked', 'wontfix']);
        assert.deepEqual(moves.bugMoves('closed', 'bug'), [['Reopen', 'open']]);
    });

    await t('a bug in a custom status goes back to where the status sits', () => {
        assert.deepEqual(moves.bugMoves('blocked', 'bug').map(([, to]) => to), ['investigation', 'closed', 'wontfix']);
        assert.deepEqual(moves.bugMoves('wontfix', 'bug').map(([, to]) => to), ['investigation', 'open']);
    });

    await t('a field is hidden for a list only when every type in it hides it', () => {
        assert.equal(schema.isHidden('bugs', 'bug', 'subsystem'), true);
        assert.equal(schema.hiddenForAll('bugs', 'subsystem'), false, 'chores still show it');
        assert.equal(schema.hiddenForAll('bugs', 'subsystem', ['bug', 'regression']), true);
    });

    await t('custom fields filter with the operators of their type', () => {
        const fields = schema.customFilterFields('bugs');
        const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
        assert.equal(byKey['cf.not_before'].type, 'date');
        assert.equal(byKey['cf.env'].type, 'enum');
        assert.deepEqual(byKey['cf.env'].options, ['prod', 'staging']);
        assert.equal(byKey['cf.cost'].type, 'number');
        assert.equal(byKey['cf.paid'].type, 'enum');
        const model = createFilterModel({ fields });
        const rows = [{ fields: { cost: '12', paid: 'yes', not_before: '2026-11-01' } }, { fields: { cost: '3' } }, { fields: {} }];
        const q = (field, op, value) => rows.filter(model.matcherFor({ kind: 'group', op: 'AND', children: [{ kind: 'clause', field, op, value }] })).length;
        assert.equal(q('cf.cost', 'gt', 5), 1, 'numbers compare as numbers');
        assert.equal(q('cf.paid', 'is', 'true'), 1, 'a yes/no reads "yes" as true');
        assert.equal(q('cf.not_before', 'after', '2026-10-01'), 1);
    });

    await t('a filter naming a removed field says so instead of quietly matching nothing', () => {
        const model = createFilterModel({ fields: schema.customFilterFields('bugs') });
        const expr = { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'cf.gone', op: 'is', value: 'x' }] };
        assert.deepEqual(model.unknownFields(expr), ['cf.gone']);
        assert.match(model.describeFilter(expr), /unknown field “gone”/);
    });

    await t('the fields section sends only what changed, and refuses a cleared required field', () => {
        const slot = document.createElement('section');
        document.body.appendChild(slot);
        const cf = mountCustomFields(slot, { store: 'bugs', type: 'bug', values: { env: 'prod', legacy: 'kept' } });
        assert.ok(slot.querySelector('[data-cf="not_before"]'), 'no date control');
        assert.equal(slot.querySelector('[data-cf="not_before"]').type, 'date');
        assert.ok(slot.querySelector('.td-cf-orphan'), 'a value the schema does not name is not shown');
        assert.deepEqual(cf.collect(), {}, 'an untouched record sends nothing');
        const nb = slot.querySelector('[data-cf="not_before"]');
        nb.value = '2026-12-24';
        nb.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.deepEqual(cf.collect(), { not_before: '2026-12-24' });
        assert.equal(cf.validate(), null);
        cf.destroy();
        slot.remove();
    });

    await t('a new record is asked for every required field; an old one is not', () => {
        const slot = document.createElement('section');
        const fresh = mountCustomFields(slot, { store: 'bugs', type: 'bug', creating: true });
        assert.match(fresh.validate() || '', /Environment is required/);
        fresh.destroy();
        const old = mountCustomFields(slot, { store: 'bugs', type: 'bug', values: {} });
        assert.equal(old.validate(), null, 'a record written before the field existed must still save');
        old.destroy();
    });

    await t('a type with no fields and no stray values draws no section', () => {
        const slot = document.createElement('section');
        const cf = mountCustomFields(slot, { store: 'bugs', type: 'regression' });
        assert.equal(slot.innerHTML, '');
        assert.equal(slot.style.display, 'none');
        cf.destroy();
    });

    await t('a record is snoozed while its "Snooze until" date is ahead, and only on a type that has the field', () => {
        schema.setSchema({ types: { bugs: { bug: { fields: [schema.SNOOZE_FIELD], hidden: [], statuses: [] } } } });
        const ahead = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
        const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
        assert.equal(schema.snoozeConfigured('bugs'), true);
        assert.equal(schema.snoozeConfigured('backlog'), false);
        assert.equal(schema.isSnoozed('bugs', 'bug', { not_before: ahead }), true);
        assert.equal(schema.isSnoozed('bugs', 'bug', { not_before: past }), false, 'its day has come');
        assert.equal(schema.isSnoozed('bugs', 'regression', { not_before: ahead }), false, 'regressions have no such field');
        assert.equal(schema.isSnoozed('bugs', 'bug', {}), false);
    });

    await t('the Snoozed view says how to set it up where nothing has the field', () => {
        schema.setSchema(null);
        const notice = schema.snoozeNotice('backlog');
        assert.ok(notice, 'no notice');
        assert.match(notice.textContent, /Snooze until/);
        assert.ok(notice.querySelector('button'), 'no button to set it up');
        schema.setSchema({ types: { backlog: { story: { fields: [schema.SNOOZE_FIELD], hidden: [], statuses: [] } } } });
        assert.equal(schema.snoozeNotice('backlog'), null, 'a notice where the field exists');
    });

    schema.setSchema(null);
}

/* ── workflow: configured moves and their flows (STORY-0018) ────────── */

console.log('\nWorkflow');
{
    const wf = await import(join(UI, 'ticketdesk', 'workflow.js'));
    const flow = (nodes, links) => ({
        nodes: [{ id: 'start', type: 'start', config: {} }, ...nodes],
        connections: links.map(([source, target, sourcePort = 'out']) => ({ source, target, sourcePort, targetPort: 'in' })),
    });

    await t('with nothing configured, a store moves the built-in way', () => {
        wf.setWorkflow(null);
        const moves = wf.movesFor('bugs', 'bug', 'open', [['Start investigation', 'investigation'], ['Close', 'closed']]);
        assert.deepEqual(moves.map((m) => [m.label, m.to, m.message]),
            [['Start investigation', 'investigation', false], ['Close', 'closed', true]]);
    });

    await t('a configured table replaces them, and "*" offers a move from every other status', () => {
        wf.setWorkflow({ bugs: { moves: [
            { from: 'open', label: 'Begin', to: 'investigation' },
            { from: '*', label: 'Close', to: 'closed', message: true },
        ] } });
        assert.deepEqual(wf.movesFor('bugs', 'bug', 'open', [['X', 'testing']]).map((m) => m.label), ['Begin', 'Close']);
        assert.deepEqual(wf.movesFor('bugs', 'bug', 'closed', []).map((m) => m.label), [], 'never a move to where it already is');
        wf.setWorkflow(null);
    });

    await t('a flow that clears the assignee saves it cleared, in the same patch as the move', async () => {
        const graph = flow([{ id: 'c', type: 'clear-field', config: { field: 'assignee' } }], [['start', 'c']]);
        const patch = await wf.planMove({ store: 'backlog', record: { status: 'refined', assignee: 'bob' },
            move: { to: 'in-progress', message: false, flow: graph }, ask: async () => null, askMessage: async () => null });
        assert.deepEqual(patch, { status: 'in-progress', assignee: '' });
    });

    await t('an answer reaches a later step, and If … otherwise reads the record', async () => {
        const graph = flow([
            { id: 'why', type: 'prompt', config: { question: 'Why?' } },
            { id: 'if', type: 'condition', config: { field: 'severity', op: 'is', value: 'crash' } },
            { id: 'loud', type: 'add-comment', config: { body: 'URGENT: ${input.why}', tag: 'blocked' } },
            { id: 'quiet', type: 'add-comment', config: { body: 'Blocked: ${input.why} on ${record.title}' } },
        ], [['start', 'why'], ['why', 'if'], ['if', 'loud', 'true'], ['if', 'quiet', 'false']]);
        const ask = async () => ({ answer: 'waiting on the vendor' });
        const crash = await wf.planMove({ store: 'bugs', record: { status: 'open', severity: 'crash', title: 'T' },
            move: { to: 'investigation', flow: graph }, ask, askMessage: async () => null });
        assert.equal(crash.comment, 'URGENT: waiting on the vendor');
        assert.equal(crash.commentNote, 'blocked');
        const low = await wf.planMove({ store: 'bugs', record: { status: 'open', severity: 'low', title: 'T' },
            move: { to: 'investigation', flow: graph }, ask, askMessage: async () => null });
        assert.equal(low.comment, 'Blocked: waiting on the vendor on T');
    });

    await t('the comment a move asks for is an answer too, whether the move or the flow asked', async () => {
        const graph = flow([
            { id: 'message', type: 'require-message', config: { prompt: 'What is wrong again?' } },
            { id: 'why', type: 'set-field', config: { field: 'title', value: 'Reopened: ${input.message}' } },
        ], [['start', 'message'], ['message', 'why']]);
        const byFlow = await wf.planMove({ store: 'bugs', record: { status: 'closed' },
            move: { to: 'open', flow: graph }, ask: async () => null, askMessage: async () => ({ comment: 'still crashes' }) });
        assert.deepEqual(byFlow, { status: 'open', title: 'Reopened: still crashes', comment: 'still crashes' });
        const byMove = await wf.planMove({ store: 'bugs', record: { status: 'closed' },
            move: { to: 'open', message: true, flow: graph }, ask: async () => null, askMessage: async () => ({ comment: 'again' }) });
        assert.deepEqual(byMove, { status: 'open', title: 'Reopened: again', comment: 'again' }, 'asked once, by the move');
    });

    await t('the flow editor names an answer by its question, never by the step id it is stored as', async () => {
        const { mountFlowEditor } = await import(join(UI, 'ticketdesk', 'workflow_editor.js'));
        const host = document.createElement('div');
        document.body.appendChild(host);
        const graph = flow([
            { id: 'prompt-2', type: 'prompt', config: { question: 'What is it blocked on?' } },
            { id: 'note', type: 'add-comment', config: { body: 'Blocked: ${input.prompt-2} on ${record.severity}' } },
        ], [['start', 'prompt-2'], ['prompt-2', 'note']]);
        const ed = mountFlowEditor(host, { store: 'bugs', types: ['bug'], graph });
        try {
            [...host.querySelectorAll('.twm-flow-outline__row')].find((r) => r.textContent.includes('Add a comment'))?.click();
            const chips = [...host.querySelectorAll('.twm-flow-chip')];
            const label = (ref) => chips.find((c) => c.dataset.ref === ref)?.textContent;
            assert.equal(label('${input.prompt-2}'), 'Answer: What is it blocked on?');
            assert.equal(label('${record.severity}'), 'Severity');
            assert.ok(host.textContent.includes('Blocked: ‹Answer: What is it blocked on?› on ‹Severity›'), 'the outline line names it too');
        } finally { ed.destroy(); host.remove(); }
    });

    await t('cancelling a prompt cancels the whole move — nothing to save', async () => {
        const graph = flow([{ id: 'q', type: 'prompt', config: { question: 'Sure?' } },
                            { id: 'c', type: 'clear-field', config: { field: 'assignee' } }], [['start', 'q'], ['q', 'c']]);
        assert.equal(await wf.planMove({ store: 'bugs', record: { status: 'open' },
            move: { to: 'closed', flow: graph }, ask: async () => null, askMessage: async () => null }), null);
        assert.equal(await wf.planMove({ store: 'bugs', record: { status: 'open' },
            move: { to: 'closed', message: true }, ask: async () => null, askMessage: async () => null }), null);
    });

    await t('a flow naming an unknown field or step is found, on that step', () => {
        const graph = flow([
            { id: 'bad', type: 'set-field', config: { field: 'nope', value: '${input.ghost}' } },
            { id: 'loop', type: 'loop-over-rows', config: {} },
        ], [['start', 'bad']]);
        const found = wf.checkFlow(graph, 'bugs', ['bug']);
        assert.deepEqual(found.map((f) => [f.code, f.node_id]).sort(),
            [['unknown_field', 'bad'], ['unknown_reference', 'bad'], ['unknown_step', 'loop']].sort());
    });

    await t('an action is offered only where it says, and moves the record itself', async () => {
        wf.setWorkflow({ actions: { bugs: { bug: [{ id: 'blocked', label: 'Blocked', when: ['open', 'investigation'], flow: flow([
            { id: 'why', type: 'prompt', config: { question: 'Blocked on?' } },
            { id: 'note', type: 'add-comment', config: { body: 'Blocked: ${input.why}', tag: 'blocked' } },
            { id: 'go', type: 'set-status', config: { status: 'blocked' } },
        ], [['start', 'why'], ['why', 'note'], ['note', 'go']]) }] } } });
        assert.deepEqual(wf.actionsFor('bugs', 'bug', 'open').map((a) => a.id), ['blocked']);
        assert.deepEqual(wf.actionsFor('bugs', 'bug', 'closed'), []);
        assert.deepEqual(wf.actionsFor('bugs', 'regression', 'open'), [], 'actions are per record type');
        const act = wf.actionsFor('bugs', 'bug', 'open')[0];
        const patch = await wf.planMove({ store: 'bugs', record: { status: 'open' }, move: { label: act.label, flow: act.flow },
            ask: async () => ({ answer: 'the vendor' }), askMessage: async () => null });
        assert.deepEqual(patch, { status: 'blocked', comment: 'Blocked: the vendor', commentNote: 'blocked' });
        assert.equal(wf.checkFlow(act.flow, 'bugs', ['bug']).some((f) => f.code === 'unknown_step'), false,
            'a move\'s flow shows its status change as a step too (STORY-0028)');
        wf.setWorkflow(null);
    });

    await t('a move names a flow by id, and a flow stored inside a row still runs (STORY-0028)', async () => {
        const ask = flow([{ id: 'why', type: 'prompt', config: { question: 'Why?' } },
            { id: 'note', type: 'add-comment', config: { body: 'Because ${input.why}' } }], [['start', 'why'], ['why', 'note']]);
        wf.setWorkflow({ flows: [{ id: 'ask-why', label: 'Ask why', store: 'bugs', flow: ask }],
            bugs: { moves: [{ from: 'open', label: 'Close', to: 'closed', flow: 'ask-why' }] } });
        assert.equal(wf.flowGraph('ask-why'), ask);
        assert.equal(wf.flowGraph('gone'), null, 'a name that is no flow runs nothing');
        assert.equal(wf.flowGraph(ask), ask, 'a graph stored the old way is itself');
        const move = wf.movesFor('bugs', 'bug', 'open')[0];
        const patch = await wf.planMove({ store: 'bugs', record: { status: 'open' }, move,
            ask: async () => ({ answer: 'done' }), askMessage: async () => null });
        assert.deepEqual(patch, { status: 'closed', comment: 'Because done' });
        assert.deepEqual(wf.configuredFlows('backlog'), [], 'flows are per store');
        wf.setWorkflow(null);
    });

    await t('an editor lifts flows stored inside rows out into named ones, and finds what uses each', () => {
        const g = flow([{ id: 'c', type: 'clear-field', config: { field: 'assignee' } }], [['start', 'c']]);
        const draft = {
            flows: [{ id: 'close', label: 'Taken', store: 'bugs', flow: g }],
            bugs: { moves: [{ from: 'open', label: 'Close', to: 'closed', flow: JSON.parse(JSON.stringify(g)) },
                            { from: 'testing', label: 'Close', to: 'closed', flow: 'close' }] },
            actions: { backlog: { story: [{ id: 'park', label: 'Park', flow: JSON.parse(JSON.stringify(g)) }] } },
        };
        assert.equal(wf.liftInlineFlows(draft), 2);
        assert.deepEqual(draft.flows.map((f) => [f.id, f.label, f.store]),
            [['close', 'Taken', 'bugs'], ['park', 'Park', 'backlog']],
            'named after the row; the move whose steps ARE "Taken" now uses it, and the action\'s (other store) is its own');
        assert.equal(draft.bugs.moves[0].flow, 'close');
        assert.equal(draft.actions.backlog.story[0].flow, 'park');
        assert.deepEqual(wf.flowUses(draft, 'close').map((u) => u.owner), ['Bugs › Close', 'Bugs › Close']);
        assert.deepEqual(wf.flowUses(draft, 'park').map((u) => [u.owner, u.actions]), [['Story › Park (action)', true]]);
        assert.equal(wf.liftInlineFlows(draft), 0, 'nothing left to lift');
        assert.equal(wf.newFlowId('  Ask: why? ', [{ id: 'ask-why' }]), 'ask-why-2');
        assert.equal(wf.newFlowId('', []), 'flow');
    });

    await t('the same steps on several rows are lifted into ONE flow they share', () => {
        const g = () => flow([{ id: 'c', type: 'clear-field', config: { field: 'assignee' } }], [['start', 'c']]);
        const draft = { actions: { bugs: {
            bug: [{ id: 'blocked', label: 'Blocked', flow: g() }],
            regression: [{ id: 'blocked', label: 'Blocked', flow: g() }],
            task: [{ id: 'blocked', label: 'Blocked', flow: g() }],
        } } };
        assert.equal(wf.liftInlineFlows(draft), 3);
        assert.deepEqual(draft.flows.map((f) => f.id), ['blocked'], 'one flow, not blocked, blocked-2, blocked-3');
        assert.equal(wf.flowUses(draft, 'blocked').length, 3);
    });

    await t('a flow for any record offers what both stores have, and every row may use it', () => {
        const fields = wf.fieldChoices(wf.ANY_STORE, []).map(([n]) => n);
        assert.ok(fields.includes('assignee') && fields.includes('labels'), 'what both have is offered');
        assert.ok(!fields.includes('severity') && !fields.includes('phase'), 'what one store has is not');
        const sets = (field) => flow([{ id: 's', type: 'set-field', config: { field, value: 'x' } }], [['start', 's']]);
        assert.deepEqual(wf.checkFlow(sets('assignee'), wf.ANY_STORE, []), []);
        assert.equal(wf.checkFlow(sets('severity'), wf.ANY_STORE, [])[0]?.code, 'unknown_field');
        const flows = [{ id: 'a', store: 'any' }, { id: 'b', store: 'bugs' }, { id: 'k', store: 'backlog' }];
        assert.deepEqual(wf.configuredFlows('bugs', flows).map((f) => f.id), ['a', 'b']);
        assert.deepEqual(wf.configuredFlows('backlog', flows).map((f) => f.id), ['a', 'k']);
    });

    await t('the built-in moves are what the pages offer, custom statuses included', async () => {
        const { builtinTable } = await import(join(UI, 'ticketdesk', 'builtin_moves.js'));
        const story = builtinTable('backlog', ['story']);
        assert.ok(story.some((m) => m.from === 'refined' && m.to === 'in-progress' && m.label === 'Start work'));
        assert.ok(story.some((m) => m.from === 'dropped' && m.to === 'draft'));
        const bugs = builtinTable('bugs', ['bug']);
        assert.equal(bugs.filter((m) => !m.message).length, 1, 'only starting work skips the message');
        assert.ok(bugs.every((m) => !m.message || m.prompt), 'a move that asks says what it asks');
    });
}

/* ── conversion between the stores (STORY-0001) ─────────────────────── */

/* ── mass actions over ticked rows (STORY-0029) ───────────────────── */

/* ── one workflow: a type's actions run flows, a flow makes the move (STORY-0030) ── */

console.log('\nOne workflow');
{
    const wf = await import(join(UI, 'ticketdesk', 'workflow.js'));
    const model = await import(join(UI, 'ticketdesk', 'workflow_model.js'));
    const TYPES = [
        ...['bug', 'regression', 'task'].map((type) => ({ store: 'bugs', type, storeLabel: 'Bugs' })),
        ...['epic', 'story', 'task'].map((type) => ({ store: 'backlog', type, storeLabel: 'Backlog' })),
    ];
    const flowOf = (w, id) => w.flows.find((f) => f.id === id);

    await t('every type is a list of actions, the built-in moves among them, each running a flow that makes the move', () => {
        const view = model.withTypeActions({}, TYPES);
        const close = view.types.bugs.bug.find((a) => a.label === 'Close');
        assert.deepEqual(close.when, ['open', 'investigation', 'testing'], 'one action, offered where the move was');
        const g = flowOf(view, close.flow).flow;
        assert.deepEqual(g.nodes.map((n) => n.type), ['start', 'require-message', 'set-status']);
        assert.equal(wf.statusStep(g), 'closed');
        assert.equal(view.types.bugs.regression.find((a) => a.label === 'Close').flow, close.flow, 'shared by the bug types');
        const refine = flowOf(view, view.types.backlog.story.find((a) => a.label === 'Mark refined').flow);
        assert.deepEqual(refine.types, ['epic', 'story'], 'a flow made here is available to the types that use it');
        assert.equal(view.bugs, undefined, 'the older keys are gone from the view');
        const reopen = (store, type) => flowOf(view, view.types[store][type].find((a) => a.label === 'Reopen').flow).label;
        assert.deepEqual([reopen('bugs', 'bug'), reopen('backlog', 'epic'), reopen('backlog', 'story'), reopen('backlog', 'task')],
            ['Reopen', 'Reopen (→ in-progress)', 'Reopen (→ review)', 'Reopen (→ in-progress)'], 'same name, other steps: told apart by where they go');
    });

    await t('saved, only a type that differs is written; the rest keep what they had', () => {
        const stored = { actions: { bugs: { bug: [{ id: 'park', label: 'Park', when: ['open'], flow: null }] } } };
        const view = model.withTypeActions(stored, TYPES);
        assert.deepEqual(view.types.bugs.bug.at(-1), { id: 'park', label: 'Park', when: ['open'], flow: null }, 'custom actions follow the moves');
        assert.deepEqual(model.withoutTypeActions(view, stored, TYPES), stored, 'nothing changed, nothing written');
        const edited = JSON.parse(JSON.stringify(view));
        edited.types.backlog.story.find((a) => a.label === 'Drop').label = 'Abandon';
        const saved = model.withoutTypeActions(edited, stored, TYPES);
        assert.deepEqual(Object.keys(saved.types), ['backlog']);
        assert.deepEqual(Object.keys(saved.types.backlog), ['story']);
        assert.deepEqual(saved.actions, stored.actions, 'the bug type still on its older keys keeps them');
        assert.ok(saved.flows.every((f) => wf.flowUses(saved, f.id).length), 'no flow nothing uses');
        assert.deepEqual(model.withoutTypeActions(model.withTypeActions(saved, TYPES), saved, TYPES), saved, 'and it stays put');
    });

    await t('a type\'s own list is what its records offer: the actions that change the status are its moves', () => {
        const view = model.withTypeActions({}, TYPES);
        wf.setWorkflow({ types: { bugs: { bug: view.types.bugs.bug } }, flows: view.flows });
        assert.deepEqual(wf.movesFor('bugs', 'bug', 'open', [['ignored', 'x']]).map((m) => [m.label, m.to]),
            [['Start investigation', 'investigation'], ['Close', 'closed']]);
        assert.deepEqual(wf.actionsFor('bugs', 'bug', 'open'), [], 'no action here leaves the status alone');
        assert.equal(wf.typeActions('bugs', 'regression'), null, 'a type not listed keeps its older way');
        wf.setWorkflow(null);
    });

    await t('an older move\'s flow gets the move put into it: the message, then the status change', () => {
        const side = { nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'c', type: 'clear-field', config: { field: 'assignee' } }],
                       connections: [{ source: 'start', sourcePort: 'out', target: 'c', targetPort: 'in' }] };
        const stored = { flows: [{ id: 'unassign', label: 'Unassign', store: 'bugs', flow: side }],
                         bugs: { moves: [{ from: 'testing', label: 'Close', to: 'closed', message: true, flow: 'unassign' }] } };
        const view = model.withTypeActions(stored, TYPES);
        const a = view.types.bugs.bug[0];
        const g = flowOf(view, a.flow).flow;
        assert.deepEqual(g.nodes.map((n) => n.type), ['start', 'clear-field', 'require-message', 'set-status']);
        const order = []; let at = 'start';
        while (at) { order.push(at); at = g.connections.find((c) => c.source === at)?.target; }
        assert.deepEqual(order.map((id) => g.nodes.find((n) => n.id === id).type), ['start', 'require-message', 'set-status', 'clear-field']);
        assert.deepEqual(flowOf(view, 'unassign').flow, side, 'the older flow itself is left as it was');
    });
}

console.log('\nMass actions');
{
    const wf = await import(join(UI, 'ticketdesk', 'workflow.js'));
    const mass = await import(join(UI, 'ticketdesk', 'mass_actions.js'));
    const bug = (id, status, type = 'bug') => mass.bugRecord({ bugId: id, id: `#${id}`, rawStatus: status, rawType: type });
    const story = (id, status, extra = {}) => mass.itemRecord({ id, ref: `STORY-${id}`, type: 'story', status,
        title: 'A story with a title', description: 'Why', criteria: ['x'], points: '3', parent: 1, ...extra });
    const io = (store) => ({
        fetch: async (r) => ({ id: r.id, status: r.status, type: r.type, assignee: '', comments: [], fields: {} }),
        save: async (r, patch) => { store.push([r.ref, patch]); },
    });

    await t('only targets EVERY ticked record can reach are offered', () => {
        wf.setWorkflow(null);
        const to = mass.commonTargets([bug(1, 'open'), bug(2, 'investigation')]).map((x) => x.to);
        assert.deepEqual(to, ['closed'], 'open can start investigation, investigation cannot; only Close is shared');
        assert.deepEqual(mass.commonTargets([bug(1, 'open'), bug(2, 'closed')]).map((x) => x.to), [], 'a closed bug can only reopen');
        assert.deepEqual(mass.commonTargets([bug(1, 'open'), story(2, 'draft')]), [], 'two stores share no status');
    });

    await t('a gated move is not offered when any ticked item fails its checks', () => {
        wf.setWorkflow(null);
        const ok = mass.commonTargets([story(1, 'draft'), story(2, 'draft')]).map((x) => x.to);
        assert.ok(ok.includes('refined'), `refined offered when both pass: ${ok}`);
        const gap = mass.commonTargets([story(1, 'draft'), story(2, 'draft', { criteria: [] })]).map((x) => x.to);
        assert.ok(!gap.includes('refined'), 'refined offered although one has no criteria');
        assert.ok(gap.includes('dropped'));
    });

    await t('a configured move table decides, per record', () => {
        wf.setWorkflow({ bugs: { moves: [
            { from: 'open', label: 'Park', to: 'testing' },
            { from: 'investigation', label: 'Ready', to: 'testing', message: true },
        ] } });
        const [x] = mass.commonTargets([bug(1, 'open'), bug(2, 'investigation')]);
        assert.equal(x.to, 'testing');
        assert.equal(x.label, 'Move to Testing', 'labels that differ give way to the status');
        assert.equal(x.message, true, 'one of them needs a message');
        wf.setWorkflow(null);
    });

    await t('the message is asked ONCE and saved on every record', async () => {
        wf.setWorkflow(null);
        const recs = [bug(1, 'open'), bug(2, 'testing'), bug(3, 'investigation')];
        const target = mass.commonTargets(recs).find((x) => x.to === 'closed');
        let asked = 0;
        const saved = [];
        const msg = await mass.massMove(recs, target, { ask: async () => { asked++; return { message: 'Fixed in 1.2' }; }, ...io(saved) });
        assert.equal(asked, 1);
        assert.deepEqual(saved, recs.map((r) => [r.ref, { status: 'closed', comment: 'Fixed in 1.2' }]));
        assert.match(msg, /3 records changed/);
    });

    await t('cancelling the question saves nothing anywhere', async () => {
        const recs = [bug(1, 'open'), bug(2, 'testing')];
        const target = mass.commonTargets(recs).find((x) => x.to === 'closed');
        const saved = [];
        const msg = await mass.massMove(recs, target, { ask: async () => null, ...io(saved) });
        assert.deepEqual(saved, []);
        assert.match(msg, /cancelled, nothing changed/);
    });

    await t('a flow asks its questions once and runs per record', async () => {
        const g = { nodes: [{ id: 'start', type: 'start', config: {} },
            { id: 'why', type: 'prompt', config: { question: 'Why?' } },
            { id: 'note', type: 'add-comment', config: { body: '${input.why} (#${record.id})' } }],
            connections: [{ source: 'start', target: 'why', sourcePort: 'out' }, { source: 'why', target: 'note', sourcePort: 'out' }] };
        wf.setWorkflow({ actions: { bugs: { bug: [{ id: 'park', label: 'Park', flow: g }] } } });
        const recs = [bug(4, 'open'), bug(5, 'testing')];
        let asked = 0;
        const saved = [];
        await mass.massAction(recs, 'park', { ask: async () => { asked++; return { answer: 'later' }; }, ...io(saved) });
        assert.equal(asked, 1);
        assert.deepEqual(saved, [['#4', { comment: 'later (#4)' }], ['#5', { comment: 'later (#5)' }]]);
        wf.setWorkflow(null);
    });

    await t('the assignee is asked once, and a record already on them is left alone', async () => {
        const saved = [];
        const recs = [bug(1, 'open'), bug(2, 'open')];
        const msg = await mass.massAssign(recs, { ask: async () => ({ assignee: 'alice' }), fetch: async (r) => ({ assignee: r.id === 2 ? 'alice' : 'bob' }),
            save: async (r, patch) => { saved.push([r.ref, patch]); } });
        assert.deepEqual(saved, [['#1', { assignee: 'alice' }]]);
        assert.match(msg, /1 already so/);
    });

    await t('what a selection offers: every type\'s mass actions in common, defaults when unconfigured', () => {
        wf.setWorkflow(null);
        assert.deepEqual(mass.offeredMassActions([bug(1, 'open')]).map((a) => a.key), ['assignee', 'status']);
        wf.setWorkflow({
            actions: { bugs: { bug: [{ id: 'park', label: 'Park', when: ['open'] }], regression: [{ id: 'park', label: 'Park' }] } },
            massActions: { bugs: { bug: ['assignee', 'action:park'], regression: ['status', 'assignee', 'action:park'] } },
        });
        assert.deepEqual(mass.offeredMassActions([bug(1, 'open'), bug(2, 'open', 'regression')]).map((a) => a.key), ['assignee', 'action:park']);
        assert.deepEqual(mass.offeredMassActions([bug(1, 'testing'), bug(2, 'open', 'regression')]).map((a) => a.key), ['assignee'],
            'an action is offered only where every record offers it in its status');
        assert.deepEqual(mass.offeredMassActions([bug(3, 'open', 'task')]).map((a) => a.key), ['assignee', 'status'], 'an unlisted type has the defaults');
        wf.setWorkflow(null);
    });

    await t('the page bar\'s Select button turns the mode on and off, and says which', () => {
        const host = document.createElement('div');
        host.innerHTML = '<button data-a="select" hidden></button><div class="td-tablehost"></div>';
        document.body.appendChild(host);
        const btn = host.querySelector('[data-a="select"]');
        const bar = mass.massActionBar(host.querySelector('.td-tablehost'), {
            noun: 'bugs', toggle: btn, recordsOf: () => [], report: () => {} });
        let on = false;
        const table = { isSelectMode: () => on, getSelection: () => [], clearSelection() {},
            setSelectMode(v) { on = v; bar.tableOptions.onSelectModeChange(v); } };
        assert.equal(btn.hidden, true, 'shown before a table is attached');
        bar.attach(table);
        assert.equal(btn.hidden, false);
        assert.match(btn.textContent, /Select/);
        assert.equal(btn.getAttribute('aria-pressed'), 'false');
        btn.click();
        assert.equal(on, true, 'the button did not start select mode');
        assert.match(btn.textContent, /Done selecting/);
        assert.equal(btn.getAttribute('aria-pressed'), 'true');
        assert.equal(bar.el.hidden, false, 'no mass action bar in select mode');
        btn.click();
        assert.equal(on, false);
        assert.equal(bar.el.hidden, true);
        const old = { getSelection: () => [], clearSelection() {} };   // a FlexDesk before 0.12.0
        const btn2 = document.createElement('button');
        mass.massActionBar(host.querySelector('.td-tablehost'), { toggle: btn2, recordsOf: () => [], report: () => {} }).attach(old);
        assert.equal(btn2.hidden, true, 'offered on a table without select mode');
        host.remove();
    });
}

console.log('\nConversion');
{
    const { convertedBanner } = await import(join(UI, 'ticketdesk', 'convert.js'));
    await t('a converted record says where it went, as a link the app opens', () => {
        const box = document.createElement('div');
        box.innerHTML = convertedBanner({ convertedTo: 'STORY-0031' });
        const a = box.querySelector('a.td-reflink');
        assert.ok(a, 'no record link');
        assert.equal(a.dataset.ref, 'STORY-0031');
        assert.match(box.textContent, /Converted to/);
    });
    await t('the new record says where it came from; an ordinary one says nothing', () => {
        assert.match(convertedBanner({ convertedFrom: 'BUG-0042' }), /Converted from/);
        assert.equal(convertedBanner({}), '');
    });
}

/* ── auto-save (STORY-0020) ─────────────────────────────────────────── */

console.log('\nAuto-save');
{
    const inst = await import(join(UI, 'ticketdesk', 'instance.js'));
    const { attachAutosave } = await import(join(UI, 'ticketdesk', 'autosave.js'));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const make = (saveImpl) => {
        inst.CONFIG.saving = { autosave: 'debounce', autosaveSeconds: 1 };
        const el = document.createElement('span');
        let dirty = false;
        const calls = [];
        const a = attachAutosave({ statusEl: el, isDirty: () => dirty, ref: () => 'BUG-0001',
            save: async (o) => { calls.push(o); return saveImpl(() => { dirty = false; }); } });
        return { a, el, calls, edit: () => { dirty = true; a.edited(); } };
    };

    await t('off by default: nothing is scheduled', () => {
        inst.CONFIG.saving = null;
        const a = attachAutosave({ statusEl: null, isDirty: () => true, save: async () => { throw new Error('saved'); }, ref: () => '' });
        assert.equal(a.enabled, false);
        a.destroy();
    });

    await t('debounced: one save a second after the last edit, and the state says so', async () => {
        const m = make(async (clean) => clean());
        m.edit(); await wait(400); m.edit();
        assert.equal(m.el.textContent, 'Unsaved');
        await wait(700);
        assert.equal(m.calls.length, 0, 'saved before the debounce ran out');
        await wait(600);
        assert.equal(m.calls.length, 1);
        assert.deepEqual(m.calls[0], { auto: true });
        assert.match(m.el.textContent, /^Saved at \d\d:\d\d$/);
        m.a.destroy();
    });

    await t('a failed save is retried after 2 s, and says so meanwhile', async () => {
        let n = 0;
        const m = make(async (clean) => { n++; if (n === 1) throw new Error('offline'); clean(); });
        m.edit(); await wait(1200);
        assert.match(m.el.textContent, /retrying in 2 s/);
        await wait(2200);
        assert.equal(m.calls.length, 2);
        assert.match(m.el.textContent, /^Saved at/);
        m.a.destroy();
    });

    await t('a conflict stops auto-save instead of saving over the file', async () => {
        const m = make(async () => { const e = new Error('changed'); e.conflict = true; throw e; });
        m.edit(); await wait(1200);
        assert.match(m.el.textContent, /changed on disk/);
        m.edit(); await wait(1200);
        assert.equal(m.calls.length, 1, 'tried again after a conflict');
        m.a.destroy();
    });
    inst.CONFIG.saving = null;
}

console.log('\nBottom panel: Changes and Alerts');
{
    const rd = await import(join(UI, 'ticketdesk', 'record_diff.js'));
    const before = '---\nid: 3\ntitle: "Export to CSV"\nseverity: high\nlabels:\n  - data\n---\n\nThe body.\nSecond line.\n';
    const after = '---\nid: 3\ntitle: "Export to CSV"\nseverity: critical\nlabels:\n  - data\n  - csv\n---\n\nThe body.\nSecond line.\nAdded.\n';

    await t('a record diff reads front matter as fields, not YAML lines', () => {
        const f = rd.fieldChanges(before, after);
        assert.deepEqual(f.map((c) => [c.name, c.from, c.to]), [
            ['Severity', 'high', 'critical'],
            ['Labels', '- data', '- data\n  - csv'.replace('\n  ', '\n  ')],
        ]);
        assert.equal(rd.fieldLabel('dueDate'), 'Due date');
        assert.equal(rd.fieldLabel('snooze_until'), 'Snooze until');
        assert.deepEqual(rd.fieldChanges(before, before), [], 'an unchanged file has field changes');
        // A field that went away reads as a dash, not as nothing.
        const gone = rd.fieldChanges('---\na: 1\nb: 2\n---\n', '---\na: 1\n---\n');
        assert.deepEqual(gone.map((c) => [c.name, c.from, c.to]), [['B', '2', '—']]);
    });

    await t('the text diff is the body only, numbered as in the file, without git headers', () => {
        const lines = rd.textChanges(before, after);
        const added = lines.filter((l) => l.sign === '+');
        assert.deepEqual(added.map((l) => [l.n, l.text]), [['12', 'Added.']], 'line 12 of the new file');
        assert.ok(!lines.some((l) => /^(diff --git|index |---|\+\+\+)/.test(l.text)), 'git headers leaked into Text');
        assert.deepEqual(rd.textChanges('---\na: 1\n---\nsame\n', '---\na: 2\n---\nsame\n'), [], 'a field edit shows up as a text change');
        assert.equal(rd.changeSummary(before, after, 'modified'), '2 fields, +1 line');
        assert.equal(rd.changeSummary('', after, 'new'), 'new');
    });

    await t('the Changes pane groups by store, commits only the ticked files, and opens on Fields', async () => {
        const posted = [];
        const files = [
            { path: 'bugs/BUG-0003.md', status: 'modified', store: 'bugs', ref: 'BUG-0003', title: 'Export to CSV' },
            { path: 'backlog/STORY-0002.md', status: 'modified', store: 'backlog', ref: 'STORY-0002', title: 'One tree' },
        ];
        const state = () => ({ ok: true, enabled: true, branch: 'main', ahead: -1, settings: {}, files, others: ['.bugdesk/project.json'], pushing: false, lastPush: null });
        const realFetchLocal = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            const reply = (j) => ({ ok: true, status: 200, json: async () => j });
            if (u.endsWith('/git')) return reply(state());
            if (u.includes('/git/diff')) {
                return reply(u.includes('BUG-0003') ? { ok: true, diff: 'diff --git a b', before, after }
                    : { ok: true, diff: '', before: '---\nid: 2\n---\nold\n', after: '---\nid: 2\n---\nold\nnew\n' });
            }
            if (u.endsWith('/git/commit')) { posted.push(JSON.parse(init.body)); return reply(state()); }
            return reply({ ok: true });
        };
        const { mountChangesPane } = await import(join(UI, 'ticketdesk', 'changes_pane.js'));
        const host = document.createElement('div');
        document.body.appendChild(host);
        let count = null;
        const pane = mountChangesPane(host, { onCount: (n) => { count = n; } });
        for (let i = 0; i < 20 && !host.querySelector('.bd-fields'); i++) await new Promise((r) => setTimeout(r, 10));
        try {
            assert.equal(count, 2);
            assert.deepEqual([...host.querySelectorAll('.bd-changes__group')].map((g) => g.textContent.replace(/\d+$/, '')), ['BUGS', 'BACKLOG']);
            assert.match(host.querySelector('.bd-changes__file').textContent, /BUG-0003\s+Export to CSV\s+2 fields, \+1 line/);
            assert.match(host.querySelector('.bd-changes__others').textContent, /\.bugdesk\/project\.json \(settings\)/);
            assert.match(host.querySelector('.bd-fields').textContent, /Severity\s*high.*critical/s, 'the first file did not open on Fields');
            assert.ok(host.querySelector('[data-act="push"]').disabled, 'Push offered with no remote branch');
            // Untick the bug: the button says so, and only the story is committed.
            const box = host.querySelector('[data-check="0:bugs/BUG-0003.md"]');
            box.checked = false;
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
            assert.match(host.querySelector('[data-act="commit"]').textContent, /Commit 1 of 2/);
            assert.match(host.querySelector('[data-slot="message"]').placeholder, /^STORY-0002: record edits/);
            host.querySelector('[data-act="commit"]').click();
            for (let i = 0; i < 20 && !posted.length; i++) await new Promise((r) => setTimeout(r, 10));
            assert.deepEqual(posted[0].files, ['backlog/STORY-0002.md']);
            // Text view of the story: the added line, numbered.
            host.querySelector('[data-file="0:backlog/STORY-0002.md"]').click();
            for (let i = 0; i < 20 && !host.querySelector('.bd-diff__line--add'); i++) await new Promise((r) => setTimeout(r, 10));
            assert.match(host.querySelector('.bd-diff__line--add').textContent, /^5\+new$/);
        } finally {
            pane.destroy();
            host.remove();
            globalThis.fetch = realFetchLocal;
        }
    });

    await t('the Alerts tab (FlexDesk\'s pane on one log over every copy) counts per rule and level, filters, and badges the unread', async () => {
        const { mountAlertsTab, sharedAlertLog } = await import(join(UI, 'ticketdesk', 'alerts.js'));
        const { NotificationHistory } = await import('@flexdesk/widgets');
        const fake = (entries, rules, matching) => {
            const opened = [];
            return {
                opened,
                ALERT_LOG: entries,
                alertRules: () => rules,
                matchingNow: (id) => matching[id] ?? null,
                stillMatches: (a) => a.key === 'bugs:2',
                markRead: (ids) => { for (const a of entries) if (!ids || ids.includes(a.id)) a.read = true; },
                dismiss: (ids) => { for (let i = entries.length - 1; i >= 0; i--) if (!ids || ids.includes(entries[i].id)) entries.splice(i, 1); },
                openRef: (ref) => opened.push(ref),
            };
        };
        const alerts = fake([
            { id: 'a', at: new Date(Date.now() - 60000), ruleId: 'r1', rule: 'P1 opened', level: 'alert', ref: '#2', title: 'Crash', store: 'bugs', key: 'bugs:2', read: false },
            { id: 'b', at: new Date(Date.now() - 600000), ruleId: 'r2', rule: 'On agent', level: 'warning', ref: 'TASK-0004', title: 'Inherit', store: 'backlog', key: 'backlog:4', read: true },
        ], [{ id: 'r1', name: 'P1 opened', level: 'alert' }, { id: 'r2', name: 'On agent', level: 'warning' }], { r1: 2, r2: 5 });
        // The tracker's copy, on a project page: the same ids, kept apart.
        const tracker = fake([
            { id: 'a', at: new Date(Date.now() - 120000), ruleId: 'r1', rule: 'New ticket', level: 'info', ref: 'T-1', title: 'Hello', store: 'bugs', key: 'bugs:1', read: false },
        ], [{ id: 'r1', name: 'New ticket', level: 'info' }], { r1: 1 });
        const sources = [
            { inst: { IS_TRACKER_COPY: false, storeLabelOf: (s) => (s === 'bugs' ? 'Bugs' : 'Backlog') }, alerts },
            { inst: { IS_TRACKER_COPY: true, storeLabelOf: () => 'Tracker' }, alerts: tracker },
        ];
        const host = document.createElement('div');
        document.body.appendChild(host);
        let badge = null;
        const pane = mountAlertsTab(host, { sources, onBadge: (b) => { badge = b; } });
        const rows = () => [...host.querySelectorAll('.twm-alerts__row')];
        const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
        try {
            await settle();
            assert.deepEqual(badge, { unread: 2, level: 'alert' });
            const metas = [...host.querySelectorAll('.twm-alerts__rulebtn .twm-alerts__meta')].map((m) => m.textContent);
            assert.deepEqual(metas, ['3', '2 now', '5 now', '1 now']);
            assert.match(host.querySelectorAll('.twm-alerts__rulename')[3].textContent, /New ticket · Tracker/);
            assert.equal(rows().length, 3);
            assert.match(rows()[0].textContent, /1 min ago\s*P1 opened\s*Bugs\s*#2\s*Crash\s*still matches/);
            assert.match(rows()[1].textContent, /2 min ago\s*New ticket\s*Tracker\s*T-1/);
            assert.match(rows()[2].textContent, /no longer matches/);
            assert.equal(host.querySelector('.twm-alerts__day').textContent, 'TODAY');
            host.querySelector('[data-level="warning"]').click();
            assert.equal(rows().length, 1, 'level filter');
            host.querySelector('[data-level="all"]').click();
            host.querySelector('[data-rule="0:r1"]').click();
            assert.equal(rows().length, 1, 'rule filter: the tracker\'s r1 is another rule');
            host.querySelector('[data-rule=""]').click();
            rows()[0].querySelector('[data-open]').click();
            assert.deepEqual(alerts.opened, ['#2']);
            await settle();
            assert.equal(alerts.ALERT_LOG[0].read, true, 'Open marks the entry read in its own copy');
            assert.equal(tracker.ALERT_LOG[0].read, false, '…and not the tracker\'s entry with the same id');
            assert.deepEqual(badge, { unread: 1, level: 'info' });
            rows()[1].querySelector('[data-open]').click();
            assert.deepEqual(tracker.opened, ['T-1'], 'a tracker entry opens in the tracker\'s copy');
            await settle();

            // The bell reads the same log: nothing unread, no badge.
            const bellHost = document.createElement('div');
            document.body.appendChild(bellHost);
            const bell = new NotificationHistory({ notificationCenter: { history: [] }, alertLog: sharedAlertLog(), mountPoint: bellHost, onOpen: () => {} });
            bell.mount();
            const bellBadge = () => bellHost.querySelector('.twm-notification-history__badge');
            assert.equal(bellBadge().style.display, 'none', 'all read: the bell has no count');
            tracker.ALERT_LOG.push({ id: 'c', at: new Date(), ruleId: 'r1', rule: 'New ticket', level: 'warning', ref: 'T-2', title: 'Again', store: 'bugs', key: 'bugs:3', read: false });
            await sharedAlertLog().refresh();
            assert.equal(bellBadge().textContent, '1', 'a new alert in either copy counts on the bell');
            assert.ok(bellBadge().classList.contains('twm-notification-history__badge--warning'));
            bell.unmount();
            bellHost.remove();

            assert.match(rows()[0].textContent, /T-2/, 'the newest row is the tracker\'s new alert');
            rows()[0].querySelector('[data-dismiss]').click();
            await settle();
            assert.equal(rows().length, 3, 'dismiss');
            assert.equal(tracker.ALERT_LOG.length, 1, 'dismissed in its own copy');
        } finally {
            pane.destroy();
            host.remove();
        }
    });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
