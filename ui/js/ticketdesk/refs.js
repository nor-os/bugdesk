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

/* ── the project's numbering ──────────────────────────────────────────
 * A project may rename its prefixes, pad differently, and start or step its
 * numbers its own way (`numbering` in project.json, server/Numbering.cs). New
 * records take the current prefix; records written before keep theirs, so
 * every prefix the store has used still parses. Read straight off the page's
 * config rather than through instance.js, to keep this module import-free —
 * the same test instance.js makes decides which copy's config it is. */
const TRACKER_COPY = /\/ticketdesk@t\//.test(import.meta.url);
const NUMBERING = (typeof window === 'undefined' ? null
    : (TRACKER_COPY ? window.__BUGDESK_TRACKER_CONFIG__ : window.__BUGDESK_CONFIG__)?.numbering) || {};

const DEFAULT_BACKLOG = { project: 'PROJ', epic: 'EPIC', story: 'STORY', task: 'TASK' };

/** The bug store has exactly one prefix; the backlog has one per type. */
export const BUG_PREFIX = String(NUMBERING.bugs?.prefix || 'BUG').toUpperCase();
export const BACKLOG_PREFIXES = Object.fromEntries(Object.entries(DEFAULT_BACKLOG)
    .map(([t, p]) => [t, String(NUMBERING.backlog?.prefix?.[t] || p).toUpperCase()]));

const padOf = (store) => {
    const n = Number(store === 'bugs' ? NUMBERING.bugs?.pad : NUMBERING.backlog?.pad);
    return Number.isInteger(n) && n >= 0 && n <= 8 ? n : 4;
};

/** Every prefix that still names a record — current, replaced, default — with
 *  the store and type it names. What a typed reference is checked against. */
const KNOWN = (() => {
    const out = new Map([[BUG_PREFIX, { store: 'bugs', type: '' }]]);
    for (const p of NUMBERING.bugs?.previous || []) out.set(String(p).toUpperCase(), { store: 'bugs', type: '' });
    if (!out.has('BUG')) out.set('BUG', { store: 'bugs', type: '' });
    for (const [t, p] of Object.entries(BACKLOG_PREFIXES)) if (!out.has(p)) out.set(p, { store: 'backlog', type: t });
    for (const [t, list] of Object.entries(NUMBERING.backlog?.previous || {})) {
        for (const p of list || []) if (!out.has(String(p).toUpperCase())) out.set(String(p).toUpperCase(), { store: 'backlog', type: t });
    }
    for (const [t, p] of Object.entries(DEFAULT_BACKLOG)) if (!out.has(p)) out.set(p, { store: 'backlog', type: t });
    return out;
})();

/** Every prefix a reference may be written with, for the autolinkers. */
export const ALL_PREFIXES = [...KNOWN.keys()];

/** An id padded as the project pads that store's references. */
export const padId = (store, id) => {
    const pad = padOf(store);
    return pad > 0 ? String(id).padStart(pad, '0') : String(Number(id));
};

/* `0*` is load-bearing: the corpus carries both `STORY-0007`, which is what the server writes, and
 * `STORY-7`, which is what a hand types and what BacklogItem.cs's own doc comment prints. Both are
 * the same record and neither is rewritten in place. */
const REF_RE = /^\s*(?:#?(\d+)|([A-Za-z]+)-0*(\d+))\s*$/;

/** The type whose prefix is `p` — current, replaced or default — or '' when
 *  no backlog type claims it. */
const backlogTypeFor = (p) => (KNOWN.get(p)?.store === 'backlog' ? KNOWN.get(p).type : '');

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
    if (KNOWN.get(prefix)?.store === 'bugs') return { store: 'bugs', id, prefix: BUG_PREFIX, type: '' };
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
    // Always the CURRENT prefix: a reference written today uses today's name,
    // whatever the record's file was called when it was made.
    const prefix = ref.store === 'bugs' ? BUG_PREFIX
        : (BACKLOG_PREFIXES[ref.type] || BACKLOG_PREFIXES.task);
    return `${prefix}-${padId(ref.store, Number(ref.id))}`;
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
    return `${BACKLOG_PREFIXES[ref.type] || ref.prefix || BACKLOG_PREFIXES.task}-${padId('backlog', Number(ref.id))}`;
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
        prefix: BACKLOG_PREFIXES[type] || BACKLOG_PREFIXES.task,
        type,
    };
}
