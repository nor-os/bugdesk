/**
 * store.js — the shared dashboards, through the server, and the personal ones.
 *
 * They live in the project's committed `.bugdesk/project.json` under
 * `dashboards` (server/ProjectConfig.cs), so a change is a config edit like the
 * schema or the workflow: it shows in the Changes pane and is committed with the
 * rest. The server saves one dashboard at a time and leaves every other entry as
 * it is — which is what keeps an entry nobody can read from being dropped.
 */

import { apiUrl } from '../ticketdesk/instance.js';
import { readEntries, parsePersonal, PERSONAL_FILE } from './model.js';

async function call(path, init, api = apiUrl) {
    const res = await fetch(api(path), {
        ...init,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `the server answered ${res.status}`);
    return j;
}

/**
 * `{entries, broken}` — `broken` is why the whole key cannot be read, or null.
 * `api` is another store's API: the tracker's, for the Tracker home's override
 * on a project page (homes.js, STORY-0047).
 */
export async function loadShared(api = apiUrl) {
    const j = await call('/project/dashboards', { method: 'GET' }, api);
    return { entries: readEntries(j.dashboards), broken: j.broken || null };
}

/** Save one raw entry (adds it, or replaces the one with its id). */
export async function saveShared(raw, api = apiUrl) {
    await call('/project/dashboards', { method: 'POST', body: JSON.stringify({ dashboard: raw }) }, api);
}

export async function deleteShared(id, api = apiUrl) {
    await call(`/project/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' }, api);
}

/* ── personal dashboards ────────────────────────────────────────────
 * One person's own dashboards, in `dashboards.json` of their profile's folder
 * in BugDesk's own state directory, through the personal_state endpoints. Not
 * in a project's `.bugdesk/`: a personal dashboard reads the tracker and any
 * project, so it is listed in every project and in the tracker alike (the
 * server folds the old per-project files in; see StoreRegistry.ReadPersonal).
 * It never reaches a commit, and another profile reads its own file, never
 * this one.
 *
 * File shape: `{ "version": 1, "dashboards": [ <entry as in project.json> ] }`.
 * Saved one dashboard at a time, re-reading the file first, so another tab's
 * new dashboard and an entry nobody can read both stay as they are. A file that
 * does not parse is never written over.
 */

async function readPersonalText() {
    const j = await call('/personal_state_read', { method: 'POST', body: JSON.stringify({ path: PERSONAL_FILE }) });
    return typeof j.result === 'string' ? j.result : null;
}

/** `{entries, broken}`, like loadShared. */
export async function loadPersonal() {
    const { doc, broken } = parsePersonal(await readPersonalText());
    return { entries: readEntries(doc?.dashboards), broken };
}

/** Re-read the file, let `change(list)` edit its dashboards, write it back. */
async function editPersonal(change) {
    const { doc, broken } = parsePersonal(await readPersonalText());
    if (broken) throw new Error(`${broken}; it is not written over`);
    doc.dashboards = change(doc.dashboards);
    const j = await call('/personal_state_write', {
        method: 'POST', body: JSON.stringify({ path: PERSONAL_FILE, data: `${JSON.stringify(doc, null, 2)}\n` }),
    });
    if (j.result?.ok !== true) throw new Error('no profile is active, so personal dashboards cannot be saved');
}

/** Save one raw entry (adds it, or replaces the first one with its id). */
export function savePersonal(raw) {
    return editPersonal((list) => {
        const i = list.findIndex((e) => e && typeof e === 'object' && e.id === raw.id);
        if (i >= 0) list[i] = raw; else list.push(raw);
        return list;
    });
}

export function deletePersonal(id) {
    return editPersonal((list) => {
        const i = list.findIndex((e) => e && typeof e === 'object' && e.id === id);
        if (i >= 0) list.splice(i, 1);
        return list;
    });
}
