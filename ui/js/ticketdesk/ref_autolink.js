/**
 * ref_autolink.js — "#42" and "#STORY-0007" become record links as you type.
 *
 * In a description or a comment, a `#` reference followed by a space, a newline
 * or punctuation is looked up, and if that record exists the text is rewritten
 * into a link to it:
 *
 *   #42          ->  [#42](#BUG-0042)          a bug: just the number
 *   #STORY-7     ->  [STORY-0007](#STORY-0007) a backlog item: its prefix
 *
 * Esc pressed straight after a conversion, before anything else is typed or
 * clicked, puts the text back as it was typed.
 *
 * WHY THIS LINK SHAPE. It is plain markdown, so the .md file on disk still reads
 * as what was meant, and a `#fragment` target is harmless in any other markdown
 * viewer. The target is the canonical reference, prefix re-derived from the
 * record that resolved (refs.js explains why a typed prefix is never trusted).
 * `markdown.js` renders these targets as record links and this module opens
 * them, so a reference behaves the same wherever it is shown.
 *
 * A BARE NUMBER IS A BUG here, whatever store the text is written in, because
 * that is how a bug is named everywhere in this UI and how the user types it.
 * That differs from link TOKENS in a record's Links section, which are
 * store-relative; those are a different grammar for a different place.
 */

import { BUG_PREFIX, BACKLOG_PREFIXES, formatRef, parseRef } from './refs.js';
import { findRow, openRow, storesAvailable } from './records.js';
import { TICKETS, loadData } from './data.js';
import { ITEMS, loadBacklog } from './backlog_data.js';

const PREFIXES = [BUG_PREFIX, ...Object.values(BACKLOG_PREFIXES)];

/** A rendered record link's target: `#BUG-0042`, `#STORY-0007`. */
export const RECORD_TARGET_RE = new RegExp(`^#((?:${PREFIXES.join('|')})-\\d+)$`, 'i');

/** What ends a reference while typing. */
const BOUNDARY_RE = /[\s.,;:!?)\]]/;

/**
 * The `#reference` that ends right before `boundaryIdx`, or null.
 *
 * Declines where a `#` is not a reference: inside a word (`abc#1`), an HTML
 * entity (`&#39;`), a URL fragment (`/page#2`), a link label or target that is
 * already written (`[#42]`, `](#BUG-0042)`), inline code and fenced code.
 *
 * @param {string} value        the whole text
 * @param {number} boundaryIdx  index of the character that ended the token
 * @returns {{start:number, end:number, token:string}|null}
 */
export function refCandidate(value, boundaryIdx) {
    const before = String(value).slice(0, boundaryIdx);
    const m = /#(\d+|[A-Za-z]+-\d+)$/.exec(before);
    if (!m) return null;
    const start = m.index;
    const prev = before[start - 1];
    if (prev !== undefined && !/[\s("'*_~>]/.test(prev)) return null;
    if (prev === '(' && before[start - 2] === ']') return null;
    const lineStart = before.lastIndexOf('\n', start - 1) + 1;
    if ((before.slice(lineStart, start).match(/`/g) || []).length % 2 === 1) return null;
    const fences = before.slice(0, lineStart).split('\n').filter((l) => /^\s*```/.test(l)).length;
    if (fences % 2 === 1) return null;
    return { start, end: boundaryIdx, token: m[1] };
}

/** The markdown a resolved record is written as. */
export function recordLink(row) {
    const label = row.store === 'bugs' ? `#${row.id}` : row.label;
    return `[${label}](#${formatRef(row.ref, '')})`;
}

/* ── the stores ───────────────────────────────────────────────────── */

let _loading = null;

/** Make sure both stores are in the browser. A bug page never loads the
 *  backlog and vice versa, and a reference can cross. Loaded once. */
function ensureStores() {
    if (_loading) return _loading;
    const stores = storesAvailable();
    _loading = Promise.all([
        stores.includes('bugs') && !TICKETS.length ? loadData().catch(() => null) : null,
        stores.includes('backlog') && !ITEMS.length ? loadBacklog().catch(() => null) : null,
    ]);
    return _loading;
}

/** The record a typed token names, or null. */
function resolve(token) {
    const ref = parseRef(token, 'bugs');
    return ref ? findRow(ref) : null;
}

/* ── the editor side ──────────────────────────────────────────────── */

/** Replace [start,end) through the browser's editing command, so Ctrl+Z still
 *  walks back through it (see md_editor.js's replaceRange for the argument). */
function replace(ta, start, end, text, caret) {
    ta.focus();
    ta.setSelectionRange(start, end);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Convert references in `ta` as they are typed.
 *
 * @param {HTMLTextAreaElement} ta
 * @returns {{flush: () => void, destroy: () => void}}  `flush` converts a
 *   reference that ends the text, for a composer about to submit on Enter.
 */
export function attachRefAutolink(ta) {
    /** The last conversion, while Esc may still undo it. */
    let pending = null;
    let applying = false;
    ensureStores();

    const convert = (cand, row, caret) => {
        const original = ta.value.slice(cand.start, cand.end);
        const link = recordLink(row);
        const after = caret + (link.length - original.length);
        applying = true;
        try { replace(ta, cand.start, cand.end, link, after); } finally { applying = false; }
        pending = { start: cand.start, link, original, caret: after };
    };

    const tryAt = (boundaryIdx, caret) => {
        const cand = refCandidate(ta.value, boundaryIdx);
        if (!cand) return;
        const row = resolve(cand.token);
        if (row) { convert(cand, row, caret); return; }
        // Not in the browser yet? Once the stores are, try again, but only if
        // nothing has been typed since, so a late answer never rewrites text
        // under the caret.
        const snapshot = ta.value;
        ensureStores().then(() => {
            if (ta.value !== snapshot || !ta.isConnected) return;
            const late = resolve(cand.token);
            if (late) convert(cand, late, ta.selectionStart);
        });
    };

    const onInput = (e) => {
        if (applying) return;
        pending = null;
        if (e.inputType && !/^insert(Text|LineBreak|Paragraph)$/.test(e.inputType)) return;
        const caret = ta.selectionStart;
        if (caret !== ta.selectionEnd || caret < 1) return;
        if (!BOUNDARY_RE.test(ta.value[caret - 1])) return;
        tryAt(caret - 1, caret);
    };

    // WINDOW, CAPTURE PHASE. Esc is also "close this" to the shell and to a
    // floating window; an undo must be seen before either of them acts on it.
    const onKey = (e) => {
        if (document.activeElement !== ta || !pending) return;
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        const p = pending;
        pending = null;
        if (e.key !== 'Escape') return;
        if (ta.selectionStart !== p.caret || ta.selectionEnd !== p.caret) return;
        if (ta.value.slice(p.start, p.start + p.link.length) !== p.link) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        applying = true;
        try {
            replace(ta, p.start, p.start + p.link.length, p.original, p.caret - (p.link.length - p.original.length));
        } finally { applying = false; }
    };
    const forget = () => { pending = null; };

    ta.addEventListener('input', onInput);
    ta.addEventListener('mousedown', forget);
    ta.addEventListener('blur', forget);
    window.addEventListener('keydown', onKey, true);

    return {
        flush() {
            const end = ta.value.length;
            if (ta.selectionStart !== end) return;
            const cand = refCandidate(`${ta.value} `, end);
            const row = cand && resolve(cand.token);
            if (row) convert(cand, row, end);
            pending = null;
        },
        destroy() {
            ta.removeEventListener('input', onInput);
            ta.removeEventListener('mousedown', forget);
            ta.removeEventListener('blur', forget);
            window.removeEventListener('keydown', onKey, true);
        },
    };
}

/* ── opening a rendered record link ───────────────────────────────── */

/**
 * One delegated click handler for every record link `markdown.js` renders, in
 * any tile or floating window. It opens the record the way a row click does,
 * as a tab beside the page it was clicked in, and says so when the record is
 * gone rather than doing nothing.
 */
export function installRecordLinkClicks({ wm, onStatus = null } = {}) {
    const onClick = async (e) => {
        const a = e.target?.closest?.('a.td-reflink');
        if (!a) return;
        e.preventDefault();
        const ref = parseRef(a.dataset.ref || '', 'bugs');
        if (!ref) return;
        const win = a.closest('[data-window-id]');
        const leaf = a.closest('.twm-leaf');
        const ctx = win ? { windowId: win.getAttribute('data-window-id') } : { leafId: leaf?.dataset.leafId };
        if (openRow(wm, ctx, ref, { ev: e })) return;
        await ensureStores();
        if (!openRow(wm, ctx, ref, { ev: e })) onStatus?.(`${a.dataset.ref} does not exist (any more).`);
    };
    document.addEventListener('click', onClick);
    return { dispose: () => document.removeEventListener('click', onClick) };
}
