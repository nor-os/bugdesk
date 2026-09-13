/**
 * ticketdesk/history.js — rendering a record's `## History` section.
 *
 * NEWEST FIRST, which is the same direction the Comments pane it shares a section with reads.
 * The file is oldest-first because that is how an append-only log is written and read in a diff;
 * flipping the reading direction when you click a tab is the kind of thing nobody notices and
 * everybody misreads.
 *
 * The DISPLAY arrow is `→` while the file stores `->`. The file is ASCII because it is read in a
 * diff and in a commit message; the pane is not.
 *
 * The "filed" row is DERIVED from `created` and `reporter`, never stored. The file already says
 * both, and writing them again as a history line would be a second copy that can disagree with the
 * first — which is why the skills forbid typing one by hand.
 *
 * A NOTE entry (`field === ''`) renders as prose. That is the whole point of the parser's
 * degrade-to-note rule: a hand edit that reads fine to a person must read fine here, rather than
 * vanishing because it did not fit the grammar.
 */

import { esc, HUMAN_AUTHOR } from './data.js';

/**
 * The rows to draw, newest first, with the synthetic "filed" row last.
 *
 * @param {object} record  a full bug or item — `history[]`, `created`, `reporter`
 */
export function historyRows(record) {
    const rows = (Array.isArray(record?.history) ? record.history : [])
        .map((h) => ({ ...h, synthetic: false })).reverse();
    if (record?.created) {
        rows.push({
            date: record.created,
            actor: record.reporter || '',
            field: 'record',
            from: '',
            to: 'filed',
            note: '',
            synthetic: true,
        });
    }
    return rows;
}

/** What one row says after the date and the actor. */
function bodyHTML(r) {
    // An absent reporter is a REAL state — nothing backfills the field — so the row says the date
    // and says it does not know who, rather than naming the configured human as if the file did.
    if (r.synthetic) {
        return r.actor ? 'filed'
            : 'filed <span class="td-dim">(reporter unrecorded)</span>';
    }
    if (r.field) {
        return `${esc(r.field)} <b>${esc(r.from || '(unset)')}</b> `
            + `→ <b>${esc(r.to || '(unset)')}</b>`;
    }
    return esc(r.note || '');
}

/** @param {ReturnType<typeof historyRows>} rows */
export function historyHTML(rows) {
    if (!rows.length) return '<div class="td-dim td-empty">No recorded changes.</div>';
    const body = rows.map((r) => `
        <div${r.synthetic ? ' class="td-audit__synthetic"' : ''}>
            <span class="td-dim td-mono">${esc(r.date || '—')}</span>
            <span class="td-link">${esc(r.actor || HUMAN_AUTHOR)}</span> — ${bodyHTML(r)}
        </div>`).join('');
    return `<div class="td-audit td-audit--inline">${body}</div>`;
}

/** @param {HTMLElement} el @param {object} record */
export function renderHistory(el, record) {
    if (!el) return;
    el.innerHTML = historyHTML(historyRows(record));
}
