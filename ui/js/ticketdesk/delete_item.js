/**
 * ticketdesk/delete_item.js — removing a record, and asking the one question
 * that actually has to be asked first.
 *
 * TRACKER MODE ONLY, on purpose. In a shared backlog the right way to cancel
 * work is `dropped` — the file stays, with a comment saying why, because the
 * decision not to build something is itself worth keeping and somebody will ask
 * about it in three months. A tracker is the opposite case: it is one person's
 * follow-up list, a mis-filed ticket is noise rather than history, and an intake
 * pass over a long email thread can easily produce a duplicate nobody wants a
 * record of. Both skills still say to drop rather than delete; this is the
 * exception that mode earns, not a general licence.
 *
 * WHAT IT ASKS. Deleting something with work under it has two defensible
 * answers and no safe default:
 *
 *   Delete everything     the project and all of it, when the whole thing was
 *                         a mistake or is finished with
 *   Keep what is under it the descendants take the deleted item's own parent,
 *                         so the tree closes over the gap rather than
 *                         scattering its children to the root
 *
 * The bridge refuses a bare delete of anything with descendants precisely so
 * this question cannot be skipped by accident (see DELETE /api/backlog/{id}).
 *
 * NOTHING IS UNLINKED. The bridge moves the files to `.trash/` beside the
 * store, which matters most here: a tracker's store deliberately lives outside
 * any repo, so there is no `git checkout` to undo a mis-click.
 */

import { ITEMS, itemRef, loadBacklog, typeLabelOf } from './backlog_data.js';

/** Everything below `id`, at any depth — the same set the bridge computes. */
export function descendantsOf(id) {
    const out = [];
    const seen = new Set([Number(id)]);
    const queue = [Number(id)];
    while (queue.length) {
        const parent = queue.shift();
        for (const child of ITEMS.filter((i) => Number(i.parent) === parent)) {
            if (seen.has(Number(child.id))) continue;
            seen.add(Number(child.id));
            out.push(child);
            queue.push(Number(child.id));
        }
    }
    return out;
}

/**
 * Ask, then delete.
 *
 * @param {object} item   the record — needs `id`, `type`, `title`
 * @param {object} [o]
 * @param {Function} [o.onStatus]
 * @returns {Promise<{deleted:number[], promoted:number[]}|null>} null if cancelled.
 */
export async function confirmDelete(item, { onStatus } = {}) {
    if (!item?.id) return null;
    const ref = itemRef(item);
    const kids = descendantsOf(item.id);
    const noun = typeLabelOf(item.type).toLowerCase();

    let children = '';
    if (kids.length === 0) {
        if (!window.confirm(
            `Delete ${ref} — ${item.title}?\n\n`
            + `This ${noun} is not in a git repository, so the only copy is the one on disk. `
            + 'BugDesk moves it to a .trash folder beside the store rather than removing it.'
        )) return null;
    } else {
        // Three-way, and window.confirm only says yes or no — so it is asked as
        // two questions, the destructive one second and named explicitly.
        const keep = window.confirm(
            `${ref} has ${kids.length} item${kids.length === 1 ? '' : 's'} under it.\n\n`
            + `OK — keep them, and move them up to where this ${noun} sat.\n`
            + `Cancel — choose whether to delete them too.`
        );
        if (keep) children = 'promote';
        else {
            const all = window.confirm(
                `Delete ${ref} AND all ${kids.length} item${kids.length === 1 ? '' : 's'} under it?\n\n`
                + kids.slice(0, 8).map((k) => `  ${k.ref}  ${k.title}`).join('\n')
                + (kids.length > 8 ? `\n  …and ${kids.length - 8} more` : '')
                + '\n\nThey are moved to a .trash folder beside the store.'
            );
            if (!all) return null;
            children = 'cascade';
        }
    }

    try {
        const url = `/api/backlog/${item.id}${children ? `?children=${children}` : ''}`;
        const res = await fetch(url, { method: 'DELETE', headers: { accept: 'application/json' } });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        await loadBacklog();
        const n = (j.deleted || []).length;
        onStatus?.(`Deleted ${n} record${n === 1 ? '' : 's'} to ${j.trash || '.trash'}.`
            + ((j.promoted || []).length ? ` ${j.promoted.length} moved up a level.` : ''));
        return { deleted: j.deleted || [], promoted: j.promoted || [] };
    } catch (err) {
        onStatus?.(`Delete failed: ${err?.message || err}`);
        return null;
    }
}
