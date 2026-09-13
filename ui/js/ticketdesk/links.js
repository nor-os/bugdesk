/**
 * links.js — relationships between records, ACROSS the two stores.
 *
 * Stored in the record's frontmatter as `links: [blocks 47, implements STORY-0007]`, i.e. a
 * comma-separated list of "<verb> <target>" tokens, exactly the shape `labels` already uses so the
 * bridge's line-based frontmatter parser handles it unchanged.
 *
 * A TARGET IS A REF, NOT A NUMBER. A bare number is store-relative — in a bug's links it names a
 * bug, in a backlog item's links it names an item — so every function here takes the origin store
 * as a parameter rather than assuming bugs, and identity is `{store, id}` throughout (refs.js).
 * Without the store half, bug #7 would claim every `implements STORY-7` in the backlog as pointing
 * at it, because the two stores number their records independently.
 *
 * ONLY THE AUTHORED DIRECTION IS STORED. If #12 says `blocks 47`, then #47 shows "is blocked by
 * #12" without carrying anything in its own file. That is deliberate:
 *   - the two files can never disagree with each other, because there is only one of them;
 *   - removing a link touches one file, not two;
 *   - hand-editing a record .md (which both norman and the AI do) can't leave a dangling half-link.
 * The cost is that listing a record's inverse links means looking at the other records — cheap,
 * since the UI already holds every bug and every item in memory.
 *
 * `blocked-by` is a first-class verb and `related` is a READ-ONLY alias for `relates-to` because
 * the corpus on disk already carries `blocked-by 3`, `blocked-by 7`, `related 5` and `related 10`:
 * four tokens that parsed as nothing and rendered as nothing. Neither addition changes what is
 * WRITTEN — a normalised `relates-to` goes to disk only when somebody authors a new link.
 */

import { parseRef, formatRef, refKey, sameRef } from './refs.js';

/** The relationship vocabulary, in the order the <select> shows it. `inverse` is what the OTHER
 *  record displays. */
export const LINK_TYPES = [
    { type: 'duplicates', label: 'duplicates', inverse: 'is-duplicated-by', inverseLabel: 'is duplicated by' },
    { type: 'blocks', label: 'blocks', inverse: 'is-blocked-by', inverseLabel: 'is blocked by' },
    { type: 'blocked-by', label: 'blocked by', inverse: 'blocks', inverseLabel: 'blocks' },
    { type: 'requires', label: 'requires', inverse: 'is-required-by', inverseLabel: 'is required by' },
    { type: 'caused-by', label: 'caused by', inverse: 'causes', inverseLabel: 'causes' },
    // Symmetric: it reads the same from either end.
    { type: 'relates-to', label: 'relates to', inverse: 'relates-to', inverseLabel: 'relates to' },
    { type: 'implements', label: 'implements', inverse: 'is-implemented-by', inverseLabel: 'is implemented by' },
];

/** Verbs accepted on READ and normalised away. Nothing here is ever written back to disk. */
export const LINK_ALIASES = { related: 'relates-to' };

const BY_TYPE = new Map(LINK_TYPES.map((d) => [d.type, d]));

export function linkTypeDef(type) {
    return BY_TYPE.get(type) || null;
}

/** The <option> markup for a link-type <select>. One definition: a second copy of this list in a
 *  template is how the two detail pages end up offering different verbs. `value` is the TYPE; the
 *  label is display only. The types and labels are module constants, not record data, so there is
 *  nothing here to escape. */
export const linkTypeOptions = (selected = '') => LINK_TYPES.map((d) =>
    `<option value="${d.type}"${d.type === selected ? ' selected' : ''}>${d.label}</option>`).join('');

/* The verb group is `[A-Za-z][A-Za-z-]*` rather than a loose `[a-z-]+`, which would happily eat the
 * `STORY` of a bare `STORY-7` and leave `-7` behind as the target. */
const LINK_RE = /^\s*([A-Za-z][A-Za-z-]*)\s+(\S+)\s*$/;

/**
 * `'blocks 47'` → `{type:'blocks', target:{store:'bugs', id:47, …}}`. `null` when the verb is
 * unknown or the target is not a reference — an unparseable token is skipped, never guessed at.
 *
 * @param {string} token
 * @param {string} [selfStore]  the store of the file the token was written in
 */
export function parseLink(token, selfStore = 'bugs') {
    const m = LINK_RE.exec(String(token || ''));
    if (!m) return null;
    let type = m[1].toLowerCase();
    if (LINK_ALIASES[type]) type = LINK_ALIASES[type];
    if (!BY_TYPE.has(type)) return null;
    const target = parseRef(m[2], selfStore);
    return target ? { type, target } : null;
}

/**
 * The canonical stored form: bare when the target is in the same store as the file, prefixed and
 * zero-padded when it crosses. `target` may be a Ref or anything `parseRef` understands, so the old
 * two-argument numeric calls still work. Returns '' when the ref resolves to nothing — the old
 * `Number(id)` is what silently wrote the literal string `blocks NaN` for a non-numeric target.
 *
 * A caller about to STORE the token passes `canonRef(target)` (records.js) first, so the prefix
 * comes from the record that was actually found rather than from what somebody typed.
 */
export function formatLink(type, target, selfStore = 'bugs') {
    const ref = target && typeof target === 'object' ? target : parseRef(target, selfStore);
    const printed = formatRef(ref, selfStore);
    return printed ? `${type} ${printed}` : '';
}

/**
 * This record's own links, parsed and de-duplicated on `{type, store, id}` — keying on the id alone
 * would collide bug #7 with story #7.
 *
 * Every element carries `raw`, the token EXACTLY as it stood in `record.links`, with the first
 * occurrence winning the de-dup. That is what the remove-link control addresses a link by, and
 * nothing downstream can reconstruct it: `related 5` and `blocks #47` do not round-trip through
 * `formatLink`, so a re-formatted token would make Remove a silent no-op on precisely the legacy
 * records this vocabulary exists to rescue.
 *
 * @param {object} record  a TICKETS or ITEMS row, or a full record — anything with `links`
 * @param {string} [selfStore]  the store `record` lives in
 */
export function outgoingLinks(record, selfStore = 'bugs') {
    const seen = new Set();
    const out = [];
    for (const token of record?.links || []) {
        const link = parseLink(token, selfStore);
        if (!link) continue;
        const key = `${link.type} ${refKey(link.target)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...link, raw: token });
    }
    return out;
}

/**
 * Links other records point AT this one, expressed from this record's side.
 *
 * @param {object|null} selfRef  the Ref of the record being looked at
 * @param {Array} rows  Row[] from records.js — both stores, since a link may cross
 */
export function incomingLinks(selfRef, rows) {
    if (!selfRef) return [];
    const out = [];
    for (const row of rows || []) {
        if (!row || sameRef(row.ref, selfRef)) continue;
        for (const link of outgoingLinks(row.record, row.store)) {
            if (!sameRef(link.target, selfRef)) continue;
            const def = linkTypeDef(link.type);
            if (!def) continue;
            out.push({ type: def.inverse, label: def.inverseLabel, target: row.ref });
        }
    }
    return out;
}

/**
 * `links` with the relationship that `raw` names removed — every spelling of it, not just
 * that one token.
 *
 * `outgoingLinks` collapses two tokens naming the same relationship into ONE row, so a record
 * carrying both `related 5` and `relates-to 5` draws a single "relates to #5". Removing only
 * the exact stored string the row was labelled with left the other spelling behind, the row
 * re-rendered unchanged, and the click read as a no-op with "Links updated." reported. Both
 * spellings reach disk easily: `related` is a legacy token, and the duplicate-of endpoint only
 * skips its append on an exact case-insensitive match.
 *
 * Tokens that do not parse are compared as text, so a line nobody can interpret is still
 * removable and is never dropped by accident.
 */
export function withoutLink(links, raw, selfStore = 'bugs') {
    const target = parseLink(raw, selfStore);
    if (!target) return (links || []).filter((x) => String(x).trim() !== String(raw).trim());
    const key = `${target.type} ${refKey(target.target)}`;
    return (links || []).filter((x) => {
        const link = parseLink(x, selfStore);
        return link ? `${link.type} ${refKey(link.target)}` !== key : true;
    });
}

/**
 * Two spellings of the same statement about this record. `blocked-by` is an authored verb;
 * `is-blocked-by` is what `blocks` derives on the other end. They say the same thing, so a
 * mirror check has to see them as equal — everything else in the vocabulary already agrees
 * with itself (`relates-to` is its own inverse, and `blocks`/`blocked-by` pair up the other way).
 */
const STATEMENT_ALIAS = { 'blocked-by': 'is-blocked-by' };

/** What a verb asserts ABOUT THIS RECORD, in one spelling. */
const statementOf = (type) => STATEMENT_ALIAS[type] || type;

/** Both halves of a record's link pane. What both detail pages call. */
export function linkRows(record, selfRef, selfStore, rows) {
    const outgoing = outgoingLinks(record, selfStore);
    // Keyed on the STATEMENT and the target, not the target alone. An inbound row is a
    // duplicate only when it says the same thing this record already says: BUG-0003 says
    // "blocks 6" and BUG-0006 says "blocked-by 3", so each page would otherwise draw that
    // pair twice, once authored and once derived. Keying on the target alone suppressed far
    // more than that — one `implements STORY-0008` on a bug hid the separate
    // "is blocked by STORY-0008" row, and since only the authored direction is ever stored,
    // that relationship then appeared nowhere on the blocked record at all.
    const mine = new Set(outgoing.map((l) => `${statementOf(l.type)} ${refKey(l.target)}`));
    const incoming = (selfRef ? incomingLinks(selfRef, rows) : [])
        .filter((l) => !mine.has(`${statementOf(l.type)} ${refKey(l.target)}`));
    return { outgoing, incoming };
}

/**
 * Would adding `type -> target` to `record` be a valid, new link? Returns a message or null.
 *
 * The same id in the OTHER store is not a self-link and is accepted: `BUG-0007` linking to
 * `STORY-0007` names two different records.
 */
export function validateNewLink(record, selfRef, type, target, selfStore = 'bugs') {
    if (!BY_TYPE.has(type)) return 'Unknown relationship type.';
    if (!target || !(Number(target.id) > 0)) return 'Pick a ticket to link to.';
    if (sameRef(target, selfRef)) return 'A ticket cannot be linked to itself.';
    if (outgoingLinks(record, selfStore).some((l) => l.type === type && sameRef(l.target, target)))
        return 'That link already exists.';
    return null;
}
