/**
 * library.js — the project's dashboards, as the Navigator and the page share
 * them (EPIC-0033).
 *
 * Two views hang off one list: the Navigator (rail.js, the left panel while
 * Dashboards is in front) lists them and opens one; the page (page.js) shows
 * the open one and edits it. Both read `lists` here and repaint on
 * `onLibraryChanged`, so a rename on the page is in the Navigator at once and
 * a dashboard created from the Navigator is what the page opens.
 *
 * Which dashboard is open is still a prop of the page's tab
 * (`props.dashboard`); `selectedKey` only mirrors it so the Navigator can mark
 * the row.
 */

import { openForm } from '@flexdesk/widgets';
import { loadShared, loadPersonal } from './store.js';
import { nameTaken } from './model.js';

/** Both lists. `broken` is why that whole list cannot be read (nothing is
 *  saved to it then), or null. Mutated in place, never replaced. */
export const lists = {
    shared: { entries: [], broken: null },
    personal: { entries: [], broken: null },
};

export const SCOPES = {
    shared: { heading: 'Shared', icon: 'group', file: 'project.json',
        tip: 'Shared: in project.json, committed, seen by everyone on the repo',
        empty: 'No shared dashboards yet.' },
    personal: { heading: 'Personal', icon: 'person', file: 'your personal dashboards.json',
        tip: 'Personal: only you see it; kept with your profile and never committed',
        empty: 'No personal dashboards. Only you see these; they are never committed.' },
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

/** The first readable dashboard, else the first entry, else none. */
export function firstKey() {
    for (const scope of ['shared', 'personal']) {
        const ok = lists[scope].entries.find((e) => e.ok);
        if (ok) return keyOf(scope, ok);
    }
    for (const scope of ['shared', 'personal']) {
        if (lists[scope].entries.length) return keyOf(scope, lists[scope].entries[0], 0);
    }
    return null;
}

export const readable = (scope) => lists[scope].entries.filter((e) => e.ok);

/** Ask for a name no other `scope` dashboard has. */
export async function askName(title, scope, { name = '', exceptId = null, hint, submitLabel = 'Save' } = {}) {
    const r = await openForm({
        title, submitLabel, defaults: { name },
        fields: [{
            name: 'name', label: 'Name', type: 'text', required: true, hint,
            validator: (v) => (!String(v || '').trim() ? 'A dashboard needs a name.'
                : nameTaken(v, readable(scope), exceptId)
                    ? `A ${scope} dashboard is already called "${String(v).trim()}". Choose a different name.` : null),
        }],
    });
    return r ? String(r.name).trim() : null;
}
