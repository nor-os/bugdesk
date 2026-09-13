/**
 * ticketdesk/records.js — one record shape across both stores.
 *
 * A bug and a backlog item are the same thing to everything that merely POINTS at a record: a link
 * row, a picker row, a cross-store navigation. They are not the same thing to the code that reads
 * them — a bug is `{bugId, summary, rawStatus, subsystem}` and an item is `{id, title, status,
 * phaseLabel}` — so before this module every one of those call sites re-derived "what a reference
 * is" and "which store does this live in" for itself, and each one got to be subtly wrong on its
 * own. `Row` is that derivation, done once.
 *
 * `Row.closed` in particular resolves the two different closed predicates so no caller has to know
 * which store it is looking at: `isClosedItem` is `done|dropped`, `isClosed` is
 * `rawStatus === 'closed'`. A caller that picks the wrong one does not fail loudly — it just shows
 * finished work as live, or hides live work as finished.
 *
 * `openRow` is the one place that knows the two page kinds disagree about ids: the ticket page
 * routes on `'#42'` and the item page on `'7'`.
 */

import { TICKETS, isClosed, typeLabelOf as bugTypeLabel } from './data.js';
import {
    ITEMS, TRACKER, TYPE_ICON, isClosedItem, itemLabel, itemRef,
    typeLabelOf as itemTypeLabel,
} from './backlog_data.js';
import { bugRef, itemRefOf, refKey, sameRef } from './refs.js';
import { isModifiedOpen, openModified } from './record_dnd.js';

/**
 * @typedef {import('./refs.js').Ref} Ref
 * @typedef {{ref:Ref, key:string, store:string, id:number, label:string, tabLabel:string,
 *            title:string, type:string, typeLabel:string, icon:string, status:string,
 *            closed:boolean, meta:string, links:string[], record:object}} Row
 */

/** A TICKETS row as a Row. `null` when it is not a record — a header, a stub, a half-loaded store. */
export function bugRow(t) {
    if (!(Number(t?.bugId) > 0)) return null;
    const id = Number(t.bugId);
    const ref = bugRef(id);
    const label = `#${id}`;
    const title = t.summary || '';
    return {
        ref,
        key: refKey(ref),
        store: 'bugs',
        id,
        label,
        tabLabel: `${label} — ${title}`.trim().replace(/—$/, '').trim(),
        title,
        type: t.type || '',
        typeLabel: bugTypeLabel(t.type),
        icon: 'bug_report',
        status: t.status || '',
        closed: isClosed(t),
        meta: t.subsystem || '',
        links: t.links || [],
        record: t,
    };
}

/** An ITEMS row as a Row. */
export function itemRow(i) {
    if (!(Number(i?.id) > 0)) return null;
    const ref = itemRefOf(i);
    return {
        ref,
        key: refKey(ref),
        store: 'backlog',
        id: Number(i.id),
        label: itemRef(i),
        tabLabel: itemLabel(i),
        title: i.title || '',
        type: i.type || '',
        typeLabel: itemTypeLabel(i.type),
        icon: TYPE_ICON[i.type] || '',
        status: i.statusLabel || i.status || '',
        closed: isClosedItem(i),
        meta: i.phaseLabel || '',
        links: i.links || [],
        record: i,
    };
}

/** Every record the browser currently holds, in the order the stores were asked for. */
export function allRows(stores = ['bugs', 'backlog']) {
    const rows = [];
    if (stores.includes('bugs')) rows.push(...TICKETS.map(bugRow));
    if (stores.includes('backlog')) rows.push(...ITEMS.map(itemRow));
    return rows.filter(Boolean);
}

/** The row a Ref names, or `null`. Matches store AND id — see refs.js's `sameRef`. */
export function findRow(ref) {
    if (!ref) return null;
    return allRows().find((row) => sameRef(row.ref, ref)) || null;
}

/**
 * The ref as the RESOLVED record spells it. A token typed as `EPIC-7` against a story is still
 * item 7, and writing it back unchanged would store a prefix that contradicts the record; this is
 * what a caller runs a ref through before formatting a token for disk.
 */
export function canonRef(ref) {
    return findRow(ref)?.ref ?? ref;
}

/** Which stores a target can live in here. Tracker mode has no bug store at all. */
export function storesAvailable() {
    return TRACKER ? ['backlog'] : ['bugs', 'backlog'];
}

/**
 * Open whatever a Ref names, wherever it lives.
 *
 * THE ONE PLACE THAT KNOWS the two page kinds disagree about ids: the item page routes on a bare
 * `'7'` and the ticket page on `'#42'`. A modified click is handed to `openModified`, which performs
 * the navigation itself and returns nothing.
 *
 * @param {object} wm
 * @param {object} ctx   the leaf the click came from, for `dest: 'origin'`
 * @param {Ref} ref
 * @param {{ev?:Event|null}} [o]
 * @returns {boolean} false when nothing resolves the ref — the caller should say so, not navigate.
 */
export function openRow(wm, ctx, ref, { ev = null } = {}) {
    const row = findRow(ref);
    if (!row) return false;
    const kind = row.store === 'backlog' ? 'item' : 'ticket';
    const props = { id: kind === 'item' ? String(row.id) : `#${row.id}`, label: row.tabLabel };
    if (ev && isModifiedOpen(ev)) { openModified(wm, kind, props); return true; }
    if (wm?.navigate) wm.navigate(kind, props, { ctx, dest: 'origin', newTab: true });
    else wm?.openInTabFromContext?.(ctx, kind, props);
    return true;
}
