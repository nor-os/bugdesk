/**
 * command_palette.js — Ctrl+K, which in BugDesk is GLOBAL FULLTEXT SEARCH.
 *
 *   +------------------------------------------------------+
 *   | (search)  search everything...                        |
 *   +------------------------------------------------------+
 *   | BUG-0042   Importer times out on large files          |
 *   |   comment  ...the timeout only bites over 50MB...     |
 *   | TASK-0031  wire the OIDC client                       |
 *   +------------------------------------------------------+
 *   | 12 matches        Up/Down navigate  Enter  Esc        |
 *   +------------------------------------------------------+
 *
 * WHAT THIS REPLACED. The palette was an entity picker inherited from the
 * application BugDesk was built out of. It searched the LABELS of things the
 * bridge could list, which here meant bug titles and nothing else — no backlog,
 * no descriptions, no comments. So it could not find either of the two things
 * people actually search for: a phrase somebody wrote in a thread, and anything
 * at all in the second store. A search box that cannot find what you remember is
 * worse than no search box, because you try it first.
 *
 * The matching happens on the BRIDGE (`GET /api/search`), not here, because the
 * browser does not have the bodies: the list endpoints return summaries, so a
 * client-side search can only ever match the columns. See Program.cs for the
 * ranking and the snippet extraction.
 *
 * The snippet is the point of a result row. Three bugs about "the importer" look
 * identical in a list of titles; the one you want is the one whose comment
 * mentions the timeout, and the row says so.
 */

import { taxonomy } from './kind_taxonomy.js';
import { HelpModal } from '../help/help_modal.js';

const ROOT_ID = 'twm-cmdpal';

/** How long to wait after a keystroke before asking the bridge. Long enough
 *  that typing a word is one request, short enough to feel like none. */
const DEBOUNCE_MS = 140;

/* Shown when the box is empty, so the palette never opens blank. Deliberately
 * few: this is a search box, and a list of actions in front of the results
 * pushes down the thing the user came for. */
const STATIC_COMMANDS = [
    {
        command: true,
        label: 'Keyboard shortcuts',
        hint: 'Every key binding (?)',
        icon: 'keyboard',
        run: () => HelpModal.open('keyboard-shortcuts'),
    },
];

export function createCommandPalette({ wm } = {}) {
    let overlay = null;
    let rows = [];          // what is on screen right now
    let active = 0;
    let seq = 0;            // request ordinal, so a slow reply cannot win
    let timer = null;

    const isOpen = () => !!overlay;

    const close = () => {
        if (!overlay) return;
        clearTimeout(timer);
        overlay.remove();
        overlay = null;
        rows = [];
    };

    const open = () => {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = ROOT_ID;
        overlay.className = 'twm-cmdpal-overlay';
        overlay.innerHTML = _markup();
        document.body.appendChild(overlay);

        const input = overlay.querySelector('.twm-cmdpal__input');
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { close(); return; }
            const row = e.target.closest('[data-idx]');
            if (row) commit(Number(row.dataset.idx));
        });
        input.addEventListener('input', () => schedule(input.value));
        input.addEventListener('keydown', onKey);
        setRows(STATIC_COMMANDS, '');
        requestAnimationFrame(() => input.focus());
    };

    const toggle = () => (isOpen() ? close() : open());

    /* ── searching ───────────────────────────────────────────────── */

    const schedule = (q) => {
        clearTimeout(timer);
        const query = q.trim();
        if (!query) { setRows(STATIC_COMMANDS, ''); return; }
        timer = setTimeout(() => run(query), DEBOUNCE_MS);
    };

    const run = async (query) => {
        // Every reply carries the ordinal of the request that asked for it, so
        // a slow answer to "im" cannot land on top of a fast answer to
        // "importer" and leave the user reading results for a half-typed word.
        const mine = ++seq;
        setStatus('Searching...');
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=40`,
                { headers: { accept: 'application/json' } });
            const j = await res.json().catch(() => null);
            if (mine !== seq || !overlay) return;
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            setRows(j.results || [], query, j.count || 0);
        } catch (err) {
            if (mine !== seq || !overlay) return;
            setRows([], query);
            setStatus(`Search failed: ${err?.message || err}`);
        }
    };

    /* ── rendering ───────────────────────────────────────────────── */

    const setStatus = (text) => {
        const el = overlay?.querySelector('[data-role="status"]');
        if (el) el.textContent = text || '';
    };

    const setRows = (next, query, total = null) => {
        rows = next;
        active = 0;
        const list = overlay?.querySelector('[data-role="list"]');
        if (!list) return;

        if (!rows.length) {
            list.innerHTML = query
                ? `<div class="twm-cmdpal__empty">Nothing matches "${_esc(query)}".</div>`
                : '<div class="twm-cmdpal__empty">Type to search titles, descriptions and comments.</div>';
            setStatus('');
            return;
        }
        list.innerHTML = rows.map((r, i) => _row(r, i, query)).join('');
        const n = total ?? rows.length;
        setStatus(query
            ? `${n} match${n === 1 ? '' : 'es'}${n > rows.length ? ` - showing ${rows.length}` : ''}`
            : '');
        paint();
    };

    const paint = () => {
        const els = overlay?.querySelectorAll('[data-idx]') || [];
        els.forEach((el, i) => el.classList.toggle('twm-cmdpal__item--active', i === active));
        els[active]?.scrollIntoView({ block: 'nearest' });
    };

    const commit = (idx) => {
        const row = rows[idx];
        if (!row) return;
        close();
        if (row.command) {
            try { row.run(); } catch (err) { console.error('[palette] command failed', err); }
            return;
        }
        // A bug opens as a `ticket`, a backlog record as an `item`. As a TAB in
        // the main tile rather than over it: you searched from somewhere, and
        // getting back there should be one click, not a re-navigation.
        const kind = row.store === 'backlog' ? 'item' : 'ticket';
        const props = row.store === 'backlog'
            ? { id: String(row.id), label: `${row.ref} - ${row.title}` }
            : { id: `#${row.id}`, label: `#${row.id} - ${row.title}` };
        wm?.navigate?.(kind, props, { dest: 'main', newTab: true });
    };

    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            active = Math.min(active + 1, rows.length - 1);
            paint();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            active = Math.max(active - 1, 0);
            paint();
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); commit(active); }
    };

    return { open, close, toggle, isOpen };
}

/* ── markup ──────────────────────────────────────────────────────── */

function _markup() {
    return `
        <div class="twm-cmdpal" role="dialog" aria-label="Search">
            <div class="twm-cmdpal__inputrow">
                <span class="material-symbols-outlined twm-cmdpal__glyph">search</span>
                <input type="text" class="twm-cmdpal__input" autocomplete="off"
                       placeholder="Search everything - titles, descriptions, comments" />
            </div>
            <div class="twm-cmdpal__list" data-role="list" role="listbox"></div>
            <div class="twm-cmdpal__footer">
                <span data-role="status"></span>
                <span class="twm-cmdpal__keys">
                    <span><kbd>Up</kbd><kbd>Down</kbd> navigate</span>
                    <span><kbd>Enter</kbd> open</span>
                    <span><kbd>Esc</kbd> close</span>
                </span>
            </div>
        </div>`;
}

/** Where a hit matched, as a word. It is WHY the row is in the list, and
 *  without it two results with similar titles are indistinguishable. */
const WHERE_LABEL = {
    reference: 'reference',
    title: 'title',
    description: 'description',
    comment: 'comment',
    field: 'details',
};

function _row(r, i, query) {
    if (r.command) {
        return `<div class="twm-cmdpal__item" data-idx="${i}" role="option">
            <span class="material-symbols-outlined twm-cmdpal__icon">${_esc(r.icon)}</span>
            <span class="twm-cmdpal__main">
                <span class="twm-cmdpal__title">${_esc(r.label)}</span>
                <span class="twm-cmdpal__snippet">${_esc(r.hint || '')}</span>
            </span>
        </div>`;
    }
    const kind = r.store === 'backlog' ? 'item' : 'ticket';
    const icon = taxonomy.meta(kind)?.icon || 'description';
    return `<div class="twm-cmdpal__item" data-idx="${i}" role="option">
        <span class="material-symbols-outlined twm-cmdpal__icon">${icon}</span>
        <span class="twm-cmdpal__main">
            <span class="twm-cmdpal__title">
                <span class="twm-cmdpal__ref">${_esc(r.ref)}</span>${_esc(r.title)}
            </span>
            <span class="twm-cmdpal__snippet">
                <span class="twm-cmdpal__where">${_esc(WHERE_LABEL[r.where] || r.where)}</span>
                ${highlight(r.snippet || '', query)}
            </span>
        </span>
        <span class="twm-cmdpal__meta">${_esc(r.status || '')}${
            r.assignee ? ` - ${_esc(r.assignee)}` : ''}</span>
    </div>`;
}

/**
 * Mark the search terms inside a snippet.
 *
 * ESCAPE FIRST, then mark. The other order runs an escape over markup we just
 * wrote and turns the `<mark>` into visible text — and a snippet is somebody's
 * comment, so it can contain anything at all. Terms are escaped too, so a query
 * containing `&` or `<` still finds the escaped form in the escaped snippet.
 *
 * The text is carried as SEGMENTS rather than as a string with the tags already
 * in it, because a later term would otherwise match inside an earlier term's
 * mark: searching "port importer" produced
 * `<mark>im<mark>port</mark>er</mark>`. A segment that is already marked is
 * skipped, so no term can be found inside another term's match, and the tags go
 * on once at the end.
 */
export function highlight(text, query) {
    const terms = String(query || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(_esc)
        // Longest first, so "importer" claims the word before "port" can.
        .sort((a, b) => b.length - a.length);

    let segments = [{ text: _esc(text), marked: false }];
    for (const term of terms) {
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const next = [];
        for (const seg of segments) {
            if (seg.marked) { next.push(seg); continue; }
            let last = 0;
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(seg.text)) !== null) {
                if (m.index > last) next.push({ text: seg.text.slice(last, m.index), marked: false });
                next.push({ text: m[0], marked: true });
                last = m.index + m[0].length;
                if (m[0].length === 0) re.lastIndex++;   // a term that matches nothing
            }
            if (last < seg.text.length) next.push({ text: seg.text.slice(last), marked: false });
        }
        segments = next;
    }
    return segments.map((s) => (s.marked ? `<mark>${s.text}</mark>` : s.text)).join('');
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
