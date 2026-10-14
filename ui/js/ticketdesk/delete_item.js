/**
 * ticketdesk/delete_item.js — removing a record, and asking the one question
 * that actually has to be asked first.
 *
 * IN EVERY MODE (BUG-0012). It used to be tracker-only: in a shared backlog
 * the right way to cancel work is `dropped`, because the decision not to build
 * something is worth keeping. That still holds, and the skills still say to
 * drop rather than delete — but a mis-filed record, a test entry or a
 * duplicate nobody wants a trace of is noise, not history, and the person
 * triaging has to be able to remove it without a file manager.
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

import { ITEMS, TRACKER, itemRef, loadBacklog, typeLabelOf } from './backlog_data.js';
import { appName } from '../core/app_identity.js';
import { apiUrl } from './instance.js';
import { esc } from './data.js';
import { openModal } from '@flexdesk/widgets';

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

    const body = document.createElement('div');
    let actions;
    let height;
    if (kids.length === 0) {
        body.innerHTML = `<p>Delete <b>${esc(ref)} — ${esc(item.title || '')}</b>?</p>
            <p class="td-dim">${TRACKER ? `This ${esc(noun)} is not in a git repository, so the only copy is the one on disk. ` : ''}
            ${esc(appName())} moves it to a trash folder beside the store rather than removing it.
            ${TRACKER ? '' : 'To keep the decision on record instead, drop it.'}</p>`;
        actions = [
            { label: 'Cancel', value: null },
            { label: 'Delete', value: 'delete', danger: true },
        ];
        height = 175;
    } else {
        // One three-way question, the destructive answer named explicitly and
        // never the default — Esc, the X and Cancel all leave everything alone.
        const n = kids.length;
        const s = n === 1 ? '' : 's';
        const shown = kids.slice(0, 8);
        body.innerHTML = `<p><b>${esc(ref)} — ${esc(item.title || '')}</b> has ${n} item${s} under it:</p>
            <ul class="td-dim bd-delete-kids">
                ${shown.map((k) => `<li><span class="td-mono">${esc(k.ref || itemRef(k))}</span> ${esc(k.title || '')}</li>`).join('')}
                ${n > shown.length ? `<li>…and ${n - shown.length} more</li>` : ''}
            </ul>
            <p><b>Keep them</b> moves them up to where this ${esc(noun)} sat.
            <b>Delete all</b> removes them with it.</p>
            <p class="td-dim">Either way the files are moved to a .trash folder beside the store.</p>`;
        actions = [
            { label: 'Cancel', value: null },
            { label: `Delete all ${n + 1}`, value: 'cascade', danger: true },
            { label: 'Keep them', value: 'promote', primary: true },
        ];
        height = 185 + (shown.length + (n > shown.length ? 1 : 0)) * 18;
    }
    const choice = await openModal({
        title: `Delete ${ref}`, icon: 'delete', content: body, actions, width: 480, height,
    });
    if (!choice) return null;
    const children = choice === 'delete' ? '' : choice;

    try {
        const url = apiUrl(`/backlog/${item.id}${children ? `?children=${children}` : ''}`);
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
