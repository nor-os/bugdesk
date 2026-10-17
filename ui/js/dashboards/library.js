/**
 * library.js — the project's dashboards, as the Navigator and the page share
 * them (EPIC-0033).
 *
 * Two views hang off one list: the Navigator (rail.js, the Dashboards group at
 * the top of every section's rail, STORY-0046) lists a section's dashboards,
 * opens, renames and deletes them; the page (page.js) shows the open one and
 * edits it. Both read `lists` here and repaint on `onLibraryChanged`, so a
 * rename on the page is in the Navigator at once, a rename in the Navigator is
 * on the page, and a dashboard created from the Navigator is what the page
 * opens.
 *
 * Which dashboard is open is still a prop of the page's tab
 * (`props.dashboard`); `selectedKey` only mirrors it so the Navigator can mark
 * the row.
 */

import { openForm } from '@flexdesk/widgets';
import { loadShared, loadPersonal } from './store.js';
import { SECTIONS, SECTION_LABEL, listedIn, nameTaken } from './model.js';

/** Both lists. `broken` is why that whole list cannot be read (nothing is
 *  saved to it then), or null. Mutated in place, never replaced. */
export const lists = {
    shared: { entries: [], broken: null },
    personal: { entries: [], broken: null },
};

export const SCOPES = {
    shared: { heading: 'Project', icon: 'group', file: 'project.json',
        tip: 'Shared: in project.json, committed, seen by everyone on the repo',
        empty: 'No project dashboards here yet.', emptyTip: 'Shared with everyone on the repo once committed.' },
    personal: { heading: 'Personal', icon: 'person', file: 'your personal dashboards.json',
        tip: 'Personal: only you see it; kept with your profile and never committed',
        empty: 'No personal dashboards here yet.', emptyTip: 'Only you see these; they are never committed.' },
};

const subs = new Set();
let selected = null;
let loading = null;

/** Call `cb` after every change to the lists or the open dashboard. Returns unsubscribe. */
export function onLibraryChanged(cb) {
    subs.add(cb);
    return () => subs.delete(cb);
}

export function notifyLibrary() {
    for (const cb of [...subs]) {
        try { cb(); } catch (err) { console.error('[dashboards] a library listener failed', err); }
    }
}

export const selectedKey = () => selected;
export function setSelectedKey(key) {
    if (key === selected) return;
    selected = key;
    notifyLibrary();
}

const writes = new Set();
/** Note a save in flight, so the next `loadLibrary` reads after it: a click in
 *  the Navigator remounts the page, whose old instance flushes its last change
 *  as the new one reads the lists. */
export function trackWrite(promise) {
    const p = Promise.resolve(promise).catch(() => { /* the writer reports its own failure */ });
    writes.add(p);
    p.finally(() => writes.delete(p));
    return promise;
}

/** Read both lists again (a pull may have changed project.json), after any
 *  save still in flight. Concurrent calls share one read. */
export function loadLibrary() {
    const unreadable = (err) => ({ entries: [], broken: `they could not be loaded (${err.message})` });
    loading ??= Promise.all([...writes])
        .then(() => Promise.all([loadShared().catch(unreadable), loadPersonal().catch(unreadable)]))
        .then(([shared, personal]) => {
            Object.assign(lists.shared, shared);
            Object.assign(lists.personal, personal);
            notifyLibrary();
        })
        .finally(() => { loading = null; });
    return loading;
}

/** How a Navigator row and `props.dashboard` name an entry: its id (a personal
 *  one prefixed `personal:`), or its position when it has no usable id. */
export const keyOf = (scope, e, i) => `${scope === 'personal' ? 'personal:' : ''}${e.id || `#${i}`}`;

/** `{scope, entry}` for a key, or null. */
export function entryFor(key) {
    for (const scope of ['shared', 'personal']) {
        const entry = lists[scope].entries.find((e, i) => keyOf(scope, e, i) === key);
        if (entry) return { scope, entry };
    }
    return null;
}

/** The first readable dashboard listed in `section` (none: in any), else the
 *  first such entry, else none. */
export function firstKey(section = null) {
    const here = (e) => !section || listedIn(e, section);
    for (const scope of ['shared', 'personal']) {
        const ok = lists[scope].entries.find((e) => e.ok && here(e));
        if (ok) return keyOf(scope, ok);
    }
    for (const scope of ['shared', 'personal']) {
        const i = lists[scope].entries.findIndex(here);
        if (i >= 0) return keyOf(scope, lists[scope].entries[i], i);
    }
    return null;
}

export const readable = (scope) => lists[scope].entries.filter((e) => e.ok);

const nameField = (scope, exceptId, hint) => ({
    name: 'name', label: 'Name', type: 'text', required: true, hint,
    validator: (v) => (!String(v || '').trim() ? 'A dashboard needs a name.'
        : nameTaken(v, readable(scope), exceptId)
            ? `A ${scope === 'shared' ? 'project' : scope} dashboard is already called "${String(v).trim()}". Choose a different name.` : null),
});

/** Ask for a name no other `scope` dashboard has. */
export async function askName(title, scope, { name = '', exceptId = null, hint, submitLabel = 'Save' } = {}) {
    const r = await openForm({ title, submitLabel, defaults: { name }, fields: [nameField(scope, exceptId, hint)] });
    return r ? String(r.name).trim() : null;
}

/**
 * Ask for a name and the section a dashboard is listed in (STORY-0046):
 * `{name, section}`, or null when cancelled. `sections` is the ones this page
 * has, `all` always last.
 */
export async function askDetails(title, scope, { name = '', section = 'all', sections = SECTIONS, exceptId = null, submitLabel = 'Save' } = {}) {
    const offered = [...new Set([...sections.filter((s) => s !== 'all'), ...(section !== 'all' ? [section] : []), 'all'])];
    const r = await openForm({
        title, submitLabel, defaults: { name, section: offered.includes(section) ? section : 'all' },
        fields: [nameField(scope, exceptId), {
            name: 'section', label: 'Listed in', type: 'select', required: true,
            options: offered.map((s) => ({ value: s, label: SECTION_LABEL[s] })),
            hint: 'The rail it is listed in. All sections lists it under Bugs, Backlog and Tracker alike.',
        }],
    });
    return r ? { name: String(r.name).trim(), section: SECTIONS.includes(r.section) ? r.section : 'all' } : null;
}
