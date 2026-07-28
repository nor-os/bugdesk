/**
 * links.js — bug-to-bug relationships.
 *
 * Stored in the bug's frontmatter as `links: [blocks 47, relates-to 55]`, i.e. a
 * comma-separated list of "<type> <id>" tokens, exactly the shape `labels` already uses so the
 * bridge's line-based frontmatter parser handles it unchanged.
 *
 * ONLY THE AUTHORED DIRECTION IS STORED. If #12 says `blocks 47`, then #47 shows "is blocked by
 * #12" without carrying anything in its own file. That is deliberate:
 *   - the two files can never disagree with each other, because there is only one of them;
 *   - removing a link touches one file, not two;
 *   - hand-editing a bug .md (which both norman and the AI do) can't leave a dangling half-link.
 * The cost is that listing a bug's inverse links means looking at the other bugs — cheap, since the
 * UI already holds every bug in TICKETS.
 */

/** The relationship vocabulary. `inverse` is what the OTHER bug displays. */
export const LINK_TYPES = [
    { type: 'duplicates', label: 'duplicates', inverse: 'is-duplicated-by', inverseLabel: 'is duplicated by' },
    { type: 'blocks', label: 'blocks', inverse: 'is-blocked-by', inverseLabel: 'is blocked by' },
    { type: 'requires', label: 'requires', inverse: 'is-required-by', inverseLabel: 'is required by' },
    { type: 'caused-by', label: 'caused by', inverse: 'causes', inverseLabel: 'causes' },
    // Symmetric: it reads the same from either end.
    { type: 'relates-to', label: 'relates to', inverse: 'relates-to', inverseLabel: 'relates to' },
];

const BY_TYPE = new Map(LINK_TYPES.map((d) => [d.type, d]));

export function linkTypeDef(type) {
    return BY_TYPE.get(type) || null;
}

/** "blocks 47" / "blocks #47" → { type: 'blocks', id: 47 }. null when unparseable. */
export function parseLink(token) {
    const m = /^\s*([a-z-]+)\s+#?(\d+)\s*$/i.exec(String(token || ''));
    if (!m) return null;
    const type = m[1].toLowerCase();
    if (!BY_TYPE.has(type)) return null;
    return { type, id: Number(m[2]) };
}

/** The canonical stored form. */
export function formatLink(type, id) {
    return `${type} ${Number(id)}`;
}

/** This bug's own links, parsed and de-duplicated. */
export function outgoingLinks(ticket) {
    const seen = new Set();
    const out = [];
    for (const raw of ticket?.links || []) {
        const link = parseLink(raw);
        if (!link) continue;
        const key = `${link.type} ${link.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(link);
    }
    return out;
}

/** Links other bugs point AT this one, expressed from this bug's side. */
export function incomingLinks(ticket, allTickets) {
    const selfId = ticket?.bugId;
    if (!selfId) return [];
    const out = [];
    for (const other of allTickets || []) {
        if (!other?.bugId || other.bugId === selfId) continue;
        for (const link of outgoingLinks(other)) {
            if (link.id !== selfId) continue;
            const def = linkTypeDef(link.type);
            if (!def) continue;
            out.push({ type: def.inverse, label: def.inverseLabel, id: other.bugId });
        }
    }
    return out;
}

/** Would adding `type -> targetId` to `ticket` be a valid, new link? */
export function validateNewLink(ticket, type, targetId) {
    if (!BY_TYPE.has(type)) return 'Unknown relationship type.';
    if (!Number.isFinite(targetId) || targetId <= 0) return 'Pick a bug to link to.';
    if (targetId === ticket?.bugId) return 'A bug cannot be linked to itself.';
    if (outgoingLinks(ticket).some((l) => l.type === type && l.id === targetId))
        return 'That link already exists.';
    return null;
}
