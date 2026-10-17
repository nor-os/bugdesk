/**
 * model.js — what a stored dashboard is, and which ones the UI can read.
 *
 * Pure: no DOM, no imports, so node tests it directly (scripts/test-dashboards.mjs).
 *
 * A shared dashboard is one element of `dashboards` in the committed
 * `.bugdesk/project.json`:
 *
 *     { "id": "bugs", "name": "Bugs", "version": 1,
 *       "tiles": [ { "id": "t1", "type": "flexdesk.chart", "x": 0, "y": 0, "w": 6, "h": 4,
 *                    "config": { "title": "Open bugs", "chart_type": "bar" } } ] }
 *
 * A tile is a FlexDesk `TileGrid` layout entry, stored as the grid hands it over,
 * so loading and saving round-trip exactly.
 *
 * THE FILE IS HAND-EDITABLE, so an entry may be anything. One the UI cannot read
 * is never dropped: it is shown as broken with the reason, and the server saves
 * one dashboard at a time, so nobody's save rewrites it. Inside a readable
 * dashboard, a tile that cannot be read is kept the same way and written back
 * unchanged after the tiles that can.
 */

export const DASHBOARD_VERSION = 1;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TILE_TYPES = Object.freeze(['flexdesk.chart', 'flexdesk.kpi']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Why a tile cannot be put on the grid, or null when it can. */
export function tileProblem(raw) {
    if (!isObject(raw)) return 'not an object';
    if (typeof raw.id !== 'string' || !raw.id) return 'no id';
    if (!TILE_TYPES.includes(raw.type)) return `unknown tile type ${JSON.stringify(raw.type ?? null)}`;
    if (!['x', 'y', 'w', 'h'].every((k) => isInt(raw[k]))) return 'position is not whole numbers';
    if (raw.config !== undefined && !isObject(raw.config)) return 'config is not an object';
    return null;
}

/**
 * Read one raw entry.
 * @returns {{ok:true, id, name, tiles:object[], keptTiles:any[], raw}
 *          |{ok:false, id:string|null, name:string|null, reason:string, raw}}
 */
export function readEntry(raw) {
    const id = isObject(raw) && typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    const name = isObject(raw) && typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    const broken = (reason) => ({ ok: false, id, name, reason, raw });
    if (!isObject(raw)) return broken('not an object');
    if (!id) return broken('no valid id');
    if (!name) return broken('no name');
    if (raw.tiles !== undefined && !Array.isArray(raw.tiles)) return broken('tiles is not a list');
    if (typeof raw.version === 'number' && raw.version > DASHBOARD_VERSION) {
        return broken(`made by a newer BugDesk (version ${raw.version})`);
    }
    const tiles = [];
    const keptTiles = [];
    // A second tile with an id already used is kept aside too: the grid holds
    // one tile per id, so putting both on it would lose one on the next save.
    const seen = new Set();
    for (const t of raw.tiles || []) {
        const dup = isObject(t) && typeof t.id === 'string' && seen.has(t.id);
        if (isObject(t) && typeof t.id === 'string') seen.add(t.id);
        (dup || tileProblem(t) ? keptTiles : tiles).push(t);
    }
    return { ok: true, id, name, tiles, keptTiles, raw };
}

/**
 * Read the server's raw `dashboards` array. Anything that is not an array reads as none.
 * A later entry repeating an id is broken and has no id: the server saves and
 * deletes by id (the first match), so acting on it would hit the other entry.
 */
export function readEntries(rawArray) {
    const seen = new Set();
    return (Array.isArray(rawArray) ? rawArray : []).map((raw) => {
        const e = readEntry(raw);
        if (!e.id) return e;
        if (seen.has(e.id)) return { ok: false, id: null, name: e.name, reason: `repeats the id "${e.id}"`, raw };
        seen.add(e.id);
        return e;
    });
}

/**
 * The raw entry to save for a readable dashboard whose grid now holds `layout`
 * (`TileGrid.getLayout()`).
 *
 * - Unknown top-level keys of the entry and of each tile are kept.
 * - Tiles that could not be read are written back unchanged, where they were.
 * - A config key the stored tile did not have and whose value is the tile
 *   type's default (`defaultsFor(type)`) is left out: the grid hands back every
 *   default merged in, and writing them all would turn a dashboard dirty in the
 *   Changes pane just because a tile was moved.
 */
export function toEntry(entry, layout, defaultsFor = () => ({})) {
    const before = new Map((entry.tiles || []).map((t) => [t.id, t]));
    const tiles = layout.map((l) => {
        const old = before.get(l.id) || {};
        const oldConfig = isObject(old.config) ? old.config : {};
        const defaults = defaultsFor(l.type) || {};
        const now = l.config || {};
        const config = {};
        // The stored keys first, in their stored order, so an unchanged tile
        // serialises to exactly what was read.
        const keys = [...Object.keys(oldConfig).filter((k) => k in now),
            ...Object.keys(now).filter((k) => !(k in oldConfig))];
        for (const k of keys) {
            const v = now[k];
            if (v === undefined) continue;
            if (!(k in oldConfig) && k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(v)) continue;
            config[k] = v;
        }
        return { ...old, id: l.id, type: l.type, x: l.x, y: l.y, w: l.w, h: l.h, config };
    });
    // In the stored order, unreadable tiles where they were; new tiles last.
    const byId = new Map(tiles.map((t) => [t.id, t]));
    const kept = new Set(entry.keptTiles);
    const ordered = [];
    for (const t of Array.isArray(entry.raw?.tiles) ? entry.raw.tiles : []) {
        if (kept.has(t)) ordered.push(t);
        else if (byId.has(t?.id)) { ordered.push(byId.get(t.id)); byId.delete(t.id); }
    }
    ordered.push(...byId.values());
    return clone({ ...entry.raw, id: entry.id, name: entry.name, tiles: ordered });
}

/* ── sections (STORY-0046) ─────────────────────────────────────────
 *
 * A dashboard is listed in ONE section's rail (Bugs, Backlog or Tracker), or in
 * every one: its `section` key. A dashboard saved before the key existed has
 * none and is listed everywhere, so nobody's dashboard went missing when the
 * Dashboards chip did. A value this BugDesk does not know reads as `all` too,
 * and is written back as it is: the key is the entry's own, like any other.
 */
export const SECTIONS = Object.freeze(['bugs', 'backlog', 'tracker', 'all']);
export const SECTION_LABEL = Object.freeze({
    bugs: 'Bugs', backlog: 'Backlog', tracker: 'Tracker', all: 'All sections',
});

/** The section a raw or read entry is listed in. */
export function sectionOf(entry) {
    const raw = isObject(entry?.raw) ? entry.raw : entry;
    const s = isObject(raw) ? raw.section : undefined;
    return SECTIONS.includes(s) ? s : 'all';
}

/**
 * `raw` listed in `section`, as a copy. A `section` BugDesk does not know reads
 * as 'all' and is kept as it is while 'all' is what the user chose: a rename
 * alone never rewrites it.
 */
export function withSection(raw, section) {
    const copy = JSON.parse(JSON.stringify(raw));
    if (sectionOf(copy) !== section) copy.section = section;
    return copy;
}

/**
 * Whether an entry is listed in `section`'s rail. `present`, the sections this
 * project has: an entry of a section it does not have (a 'bugs' dashboard in a
 * backlog-only project, from a copied project.json) is listed in all of them
 * rather than in none, so it can still be opened, moved or deleted. Not a
 * tracker one: no tracker means it is switched off or not merged here, and its
 * dashboards wait, kept, until it is back.
 */
export const listedIn = (entry, section, present = null) => {
    const s = sectionOf(entry);
    return s === 'all' || s === section || (!!present && s !== 'tracker' && !present.includes(s));
};

/** A new, readable entry, listed in `section` (none: every section). */
export function newEntry(name, id = newId('d'), section = null) {
    const raw = { id, name: name.trim(), version: DASHBOARD_VERSION,
        ...(SECTIONS.includes(section) ? { section } : {}), tiles: [] };
    return readEntry(raw);
}

/** A fresh id: prefix, time, and a little randomness. Always matches ID_RE. */
export function newId(prefix = 'd') {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Whether another entry (not `exceptId`) already has this name, ignoring case and spaces around it. */
export function nameTaken(name, entries, exceptId = null) {
    const want = String(name || '').trim().toLowerCase();
    return entries.some((e) => e.id !== exceptId && (e.name || '').trim().toLowerCase() === want);
}

/** Personal dashboards' file in the profile's state directory (store.js). */
export const PERSONAL_FILE = 'dashboards.json';

/**
 * Read the personal file's text: `{doc, broken}` — the parsed file (an empty
 * one when there is none yet), or, when it cannot be read, `doc` null and why.
 */
export function parsePersonal(text) {
    if (text == null || !String(text).trim()) return { doc: { version: DASHBOARD_VERSION, dashboards: [] }, broken: null };
    let doc;
    try { doc = JSON.parse(text); } catch (err) { return { doc: null, broken: `${PERSONAL_FILE} is not valid JSON (${err.message})` }; }
    if (!isObject(doc) || !Array.isArray(doc.dashboards)) return { doc: null, broken: `${PERSONAL_FILE} has no "dashboards" list` };
    return { doc, broken: null };
}

/** `name`, or "name (copy)", "name (copy 2)", … — the first one no entry in `entries` has. */
export function freeName(name, entries) {
    const base = String(name || '').trim();
    if (!nameTaken(base, entries)) return base;
    for (let n = 1; ; n++) {
        const candidate = `${base} (copy${n === 1 ? '' : ` ${n}`})`;
        if (!nameTaken(candidate, entries)) return candidate;
    }
}
