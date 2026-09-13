/**
 * ticketdesk/refs.js — what a record REFERENCE is, on both sides of the store line.
 *
 * IMPORTS NOTHING, deliberately: `scripts/test-ui.mjs` can exercise it with no store stubs and no
 * `fetch`, and it can never create a cycle, so every other ticketdesk module is free to reach for
 * it. `BACKLOG_PREFIXES` is a copy of backlog_data.js's `TYPE_PREFIX` for that same reason; a drift
 * test pins the two together and against `server/BacklogItem.cs`'s `Prefixes`, so the copy cannot
 * wander.
 *
 * A BARE NUMBER IS STORE-RELATIVE — in a bug's links it is a bug, in an item's links it is an
 * item — which is why the origin store is a parameter, never an assumption. `blocks 47` means two
 * different records depending only on which file it was written in.
 *
 * Identity is `{store, id}`, never the printed prefix. Backlog ids are ONE sequence shared by all
 * four types, so `STORY-7` and `EPIC-7` name the same record; the prefix is display sugar plus a
 * store discriminator, and it goes stale the moment somebody retypes an item. Every write path
 * re-derives it from the record it resolved rather than from what was typed.
 */

/** @typedef {{store:'bugs'|'backlog', id:number, prefix:string, type:string}} Ref */

/** The bug store has exactly one prefix; the backlog has one per type. */
export const BUG_PREFIX = 'BUG';
export const BACKLOG_PREFIXES = { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' };

/* `0*` is load-bearing: the corpus carries both `STORY-0007`, which is what the server writes, and
 * `STORY-7`, which is what a hand types and what BacklogItem.cs's own doc comment prints. Both are
 * the same record and neither is rewritten in place. */
const REF_RE = /^\s*(?:#?(\d+)|([A-Za-z]+)-0*(\d+))\s*$/;

const pad4 = (id) => String(id).padStart(4, '0');

/** The type whose prefix is `p`, or '' when no backlog type claims it. */
const backlogTypeFor = (p) =>
    Object.keys(BACKLOG_PREFIXES).find((t) => BACKLOG_PREFIXES[t] === p) || '';

/**
 * Parse one reference token. `null` when it is not a reference — an unknown prefix is never
 * guessed at, because guessing `WIDGET-1` into some store invents a record nobody wrote.
 *
 * @param {string|number|null|undefined} token  `52`, `#52`, `BUG-0052`, `story-7`
 * @param {string} [selfStore]  the store the token was written IN — what a bare number means
 * @returns {Ref|null}
 */
export function parseRef(token, selfStore = 'bugs') {
    const m = REF_RE.exec(String(token ?? ''));
    if (!m) return null;
    if (m[1]) {
        const id = Number(m[1]);
        if (!(id > 0)) return null;
        const store = selfStore === 'backlog' ? 'backlog' : 'bugs';
        return { store, id, prefix: store === 'bugs' ? BUG_PREFIX : '', type: '' };
    }
    const id = Number(m[3]);
    if (!(id > 0)) return null;
    const prefix = m[2].toUpperCase();
    if (prefix === BUG_PREFIX) return { store: 'bugs', id, prefix: BUG_PREFIX, type: '' };
    const type = backlogTypeFor(prefix);
    return type ? { store: 'backlog', id, prefix, type } : null;
}

/**
 * The canonical STORED form: bare when the target sits in the same store as the file holding the
 * link, prefixed and zero-padded when it crosses. It never re-resolves, so a caller that is about
 * to write a token passes `canonRef(ref)` (records.js) first to get the type right.
 *
 * @param {Ref|null} ref
 * @param {string} [selfStore]  the store of the file being written
 * @returns {string} '' when the ref names nothing
 */
export function formatRef(ref, selfStore = 'bugs') {
    if (!(Number(ref?.id) > 0)) return '';
    if (ref.store === selfStore) return String(Number(ref.id));
    const prefix = BACKLOG_PREFIXES[ref.type] || ref.prefix
        || (ref.store === 'bugs' ? BUG_PREFIX : 'TASK');
    return `${prefix}-${pad4(Number(ref.id))}`;
}

/**
 * What a ref looks like on screen when nothing resolved it. A bug reads as `#42` in a link row —
 * that is how a bug is named everywhere else in this UI — which is exactly why the C# `Refs.Display`
 * differs and always prefixes: `#42` inside a prose sentence that crosses stores reads as a
 * fragment. A row that DOES resolve uses `Row.label`, which carries the record's real prefix.
 *
 * @param {Ref|null} ref
 */
export function displayRef(ref) {
    if (!(Number(ref?.id) > 0)) return '';
    if (ref.store === 'bugs') return `#${Number(ref.id)}`;
    return `${BACKLOG_PREFIXES[ref.type] || ref.prefix || 'TASK'}-${pad4(Number(ref.id))}`;
}

/** Store AND id. Without the store half, bug #7 claims every `implements STORY-7` in the backlog. */
export function sameRef(a, b) {
    return !!a && !!b && a.store === b.store && Number(a.id) === Number(b.id);
}

/** `'bugs:52'` — the identity as a string, for Sets, Maps and `[data-*]` attributes. */
export function refKey(ref) {
    return ref ? `${ref.store}:${Number(ref.id)}` : '';
}

/** `'backlog:7'` → Ref. `null` for anything else, including an unknown store. */
export function parseKey(key) {
    const m = /^(bugs|backlog):(\d+)$/.exec(String(key ?? '').trim());
    return m ? parseRef(m[2], m[1]) : null;
}

/** @returns {Ref} */
export function bugRef(id) {
    return { store: 'bugs', id: Number(id), prefix: BUG_PREFIX, type: '' };
}

/** @returns {Ref} the reference an ITEMS row names itself by. */
export function itemRefOf(item) {
    const type = item?.type || '';
    return {
        store: 'backlog',
        id: Number(item?.id),
        prefix: BACKLOG_PREFIXES[type] || 'TASK',
        type,
    };
}
