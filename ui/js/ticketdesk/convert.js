/**
 * ticketdesk/convert.js — a bug becomes a backlog item, or an item a bug.
 *
 * A bug that turns out to be feature work, or a story that turns out to be a
 * defect, moves to the store it belongs in. The bridge does it as one act
 * (POST /api/convert): the new record is written first with the title,
 * description, reporter, comments and history, and a comment listing every
 * value the other store has no field for; only then is the original closed (a
 * bug) or dropped (an item), linked `duplicates <new>` and marked with where it
 * went. Cancelling the dialog creates nothing.
 *
 * Both record pages show where a converted record went, and where a new one came
 * from (`convertedTo` / `convertedFrom`), as a banner with a link.
 */

import { IS_TRACKER_COPY, apiUrl } from './instance.js';
import { esc } from './data.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
/** A record link the app's one delegated handler opens (ref_autolink.js). */
const refLink = (ref) => `<a href="#" class="td-reflink td-mono" data-ref="${esc(ref)}"${
    IS_TRACKER_COPY ? ' data-copy="tracker"' : ''}>${esc(ref)}</a>`;

const ITEM_TYPES = [{ value: 'story', label: 'Story' }, { value: 'epic', label: 'Epic' }, { value: 'task', label: 'Task' }];
const BUG_TYPES = [{ value: 'bug', label: 'Bug' }, { value: 'regression', label: 'Regression' }, { value: 'task', label: 'Chore' }];

/**
 * Ask, then convert. Resolves `{store, id, ref, type, title}` of the new record,
 * or null when cancelled.
 *
 * @param {object} o
 * @param {string} o.from      the original's reference (`BUG-0042`, `STORY-0007`)
 * @param {'bugs'|'backlog'} o.store   the ORIGINAL's store
 * @param {string} [o.title]
 * @param {string} [o.actor]
 */
export async function convertRecord({ from, store, title = '', actor = '' }) {
    const { openForm } = await import('@flexdesk/widgets');
    const toBacklog = store === 'bugs';
    const answer = await openForm({
        title: `${toBacklog ? 'Convert to a backlog item' : 'Convert to a bug'} — ${from}${title ? ` ${title}` : ''}`,
        fields: [
            { name: 'type', label: toBacklog ? 'Item type' : 'Bug type', type: 'select', required: true,
              options: toBacklog ? ITEM_TYPES : BUG_TYPES },
            ...(toBacklog ? [] : [{ name: 'severity', label: 'Severity', type: 'select', required: true,
                options: ['crash', 'high', 'medium', 'low'] }]),
        ],
        defaults: { type: toBacklog ? 'story' : 'bug', severity: 'medium' },
        submitLabel: 'Convert',
    });
    if (!answer) return null;
    const res = await fetch(apiUrl('/convert'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ from, type: answer.type, severity: answer.severity || '', actor }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `conversion failed (${res.status})`);
    return j.created;
}

/** The banner a converted record shows — where it went, or where it came from. */
export function convertedBanner(record) {
    const to = String(record?.convertedTo || '').trim();
    const from = String(record?.convertedFrom || '').trim();
    if (to) {
        return `<div class="td-banner td-banner--converted">${icon('swap_horiz')}
            <b>Converted to ${refLink(to)}</b>
            — carry on there. This record stays for its links.</div>`;
    }
    if (from) {
        return `<div class="td-banner td-banner--converted td-banner--quiet">${icon('swap_horiz')}
            Converted from ${refLink(from)}.</div>`;
    }
    return '';
}
