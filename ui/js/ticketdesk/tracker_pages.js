/**
 * ticketdesk/tracker_pages.js — the Tracker dashboard (kind: `tracker`).
 *
 * TRACKER MODE exists for a different job than the rest of BugDesk. A bug queue
 * and a backlog are things you work IN: you pick something up, you change it,
 * you close it. A tracker is something you work FROM — a manager's record of
 * work handed to other people, most of whom never open this checkout and some
 * of whom have no idea it exists. Nobody else updates it. Its value is entirely
 * in whether the person holding it can see, in one glance, what is late and
 * whose it is.
 *
 * So the dashboard is not a queue with a filter on it. It leads with the two
 * things a filter cannot say by itself:
 *
 *   WHAT IS LATE, worst first, with a name attached to every row. "3 overdue"
 *   is a number you nod at; "Priya, 9 days late, the migration sign-off" is one
 *   you act on, so the row carries the person and the phrase rather than a date
 *   the reader has to subtract today from.
 *
 *   WHAT THE TRACKER CANNOT ANSWER — work with no assignee, and work with no
 *   target date. These are given a section of their own rather than being left
 *   out of the schedule they have no place in. A tool that reports only on the
 *   work it knows about is most confident exactly where it is least complete,
 *   and an undated item is invisible to every other question on this page.
 *
 * Everything here is derived from the SAME `ITEMS` the board and the rail read,
 * through the same `dueState` in ./backlog_data.js. This page owns no data and
 * caches nothing: it re-renders from the live store on `backlog:changed`, which
 * the item pages emit after every write and live.js emits after an external
 * one.
 */

import { showContextMenu } from '../ecoagent/ui/context_menu.js';
import { shell, statusLine } from './pages.js';
import { esc, HUMAN_AUTHOR } from './data.js';
import { openNewItem } from './new_item.js';
import { installRecordDragSource, isModifiedOpen, openModified } from './record_dnd.js';
import { confirmDelete } from './delete_item.js';
import { assigneeExpr, dueStateExpr, projectExpr } from './backlog_filters.js';
import {
    DUE_SOON_DAYS, ITEMS, TYPE_ICON,
    daysBetween, dueState, duePhrase, humanizeItemStatus, itemLabel, itemRef,
    todayISO, typeLabelOf,
} from './backlog_data.js';

/** Set by createTrackerContent at registration, before any mount runs. */
let _eventBus = null;

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

const typeGlyph = (type) =>
    `<span class="bd-type bd-type--${esc(type)}" title="${esc(typeLabelOf(type))}">${icon(TYPE_ICON[type] || 'task')}</span>`;

const statusPill = (status) =>
    `<span class="bd-status bd-status--${esc(status)}">${esc(humanizeItemStatus(status))}</span>`;

/** Open work only. `done` and `dropped` are finished business — a tracker that
 *  keeps reporting them is a tracker nobody scrolls to the bottom of. */
const isOpen = (i) => i.status !== 'done' && i.status !== 'dropped';

/* ── the scope ───────────────────────────────────────────────────────
 *
 * "What I assigned" is `reporter`, not `assignee` — see BacklogItem.Reporter on
 * the bridge. It is a SCOPE the user chooses rather than the default, because
 * `reporter` was added after the format existed: every record written before it
 * carries none, and a dashboard that silently hid all of them would look like a
 * tracker with nothing in it.
 */
const SCOPES = [
    { id: 'all', label: 'Everyone', hint: 'every item in the store' },
    { id: 'byme', label: 'Assigned by me', hint: `items whose reporter is ${HUMAN_AUTHOR}` },
    { id: 'others', label: 'Out with others', hint: 'assigned to somebody who is not me' },
];

const scopeFilter = (scope) => (i) => {
    if (scope === 'byme') return i.reporter === HUMAN_AUTHOR;
    if (scope === 'others') return !!i.assignee && i.assignee !== HUMAN_AUTHOR;
    return true;
};

/* ── row rendering ───────────────────────────────────────────────── */

const dueCell = (i) => {
    const state = dueState(i);
    if (state === 'none') return '<span class="bd-due bd-due--none">no date</span>';
    return `<span class="bd-due bd-due--${state}" title="${esc(i.due)}">${esc(duePhrase(i))}</span>`;
};

const itemRow = (i) => `
    <div class="tk-row" data-open="${i.id}" role="button" tabindex="0" draggable="true">
        ${typeGlyph(i.type)}
        <span class="bd-item__ref tk-row__ref">${esc(i.ref)}</span>
        <span class="tk-row__title">${esc(i.title)}</span>
        <span class="tk-row__who">${i.assignee
            ? esc(i.assignee)
            : '<span class="tk-row__nobody">nobody</span>'}</span>
        <span class="tk-row__due">${dueCell(i)}</span>
        ${statusPill(i.status)}
    </div>`;

/**
 * One section. An empty one still renders, with a line saying what empty means
 * here — "no overdue work" is the single most valuable thing this page can say,
 * and a section that disappears when it is empty cannot say it.
 */
const section = (id, glyph, title, rows, emptyText, action = '') => `
    <section class="tk-sec" data-sec="${id}">
        <div class="tk-sec__head">
            ${icon(glyph)}
            <b>${esc(title)}</b>
            <span class="td-dim">${rows.length}</span>
            <span class="td-spacer"></span>
            ${action}
        </div>
        <div class="tk-sec__body">
            ${rows.length ? rows.map(itemRow).join('')
                : `<div class="tk-empty">${esc(emptyText)}</div>`}
        </div>
    </section>`;

/* ── the page ────────────────────────────────────────────────────── */

function mountTracker(host, props, ctx) {
    let scope = props?.scope && SCOPES.some((s) => s.id === props.scope) ? props.scope : 'all';

    /* ── where a click goes ──────────────────────────────────────────
     *
     * BESIDE the dashboard, never over it.
     *
     * Every row here used to open in the dashboard's own tile, which took the
     * dashboard off screen — you clicked a late ticket to see who had it and
     * lost the list of everything else that was late. That is the wrong shape
     * for a dashboard: it is a place you work FROM, and you come back to it
     * after every single row.
     *
     * So the first click splits a detail pane off to the right, and every click
     * after that REUSES it. One stable two-pane layout — the tracker on the
     * left, whatever you are looking at on the right — rather than a pane per
     * click, which is what a plain `dest: 'split-h'` would give.
     *
     * `detailLeaf` is re-checked against the live tree each time rather than
     * trusted: the user can close that pane, and a stale id would silently
     * navigate nothing.
     */
    let detailLeaf = null;

    const openBeside = (kind, props) => {
        const tree = ctx.wm?.desktops?.active?.()?.tree;
        if (detailLeaf && tree?.get(detailLeaf)) {
            ctx.wm?.navigate?.(kind, props, { ctx: { ...ctx, leafId: detailLeaf }, dest: 'origin' });
            return;
        }
        detailLeaf = ctx.wm?.navigate?.(kind, props, { ctx, dest: 'split-h' }) || null;
        // No WM, or a tile that cannot be split (it is already the only one in a
        // window): fall back to the old behaviour rather than silently doing
        // nothing at all.
        if (!detailLeaf) ctx.wm?.openInTabFromContext?.(ctx, kind, props);
    };

    const openBoard = (p) => openBeside('backlog', p);
    const openItem = (id) => {
        const model = ITEMS.find((x) => Number(x.id) === Number(id));
        openBeside('item', { id: String(id), label: itemLabel(model) || `#${id}` });
    };

    /** Everything this dashboard is talking about, under the current scope. */
    const scoped = () => ITEMS.filter(scopeFilter(scope));

    /**
     * Who has open work, worst first.
     *
     * Sorted by overdue count and then by how late the worst item is — not
     * alphabetically. The list is read top-down and stopped at, so the order has
     * to BE the priority. Unassigned work is a row here too, named "Nobody":
     * it is a real and urgent bucket, not an absence to leave out of the table.
     */
    const people = () => {
        const today = todayISO();
        const by = new Map();
        for (const i of scoped()) {
            if (!isOpen(i)) continue;
            const who = i.assignee || '';
            if (!by.has(who)) by.set(who, { who, open: 0, overdue: 0, undated: 0, worst: 0, next: '' });
            const row = by.get(who);
            row.open++;
            const state = dueState(i, today);
            if (state === 'overdue') {
                row.overdue++;
                row.worst = Math.max(row.worst, -daysBetween(today, i.due));
            } else if (state === 'none') {
                row.undated++;
            } else if (i.due && (!row.next || i.due < row.next)) {
                row.next = i.due;
            }
        }
        return [...by.values()].sort((a, b) =>
            b.overdue - a.overdue || b.worst - a.worst || b.open - a.open
            || String(a.who).localeCompare(String(b.who)));
    };

    const personRow = (p) => `
        <div class="tk-person" data-who="${esc(p.who)}" role="button" tabindex="0"
             title="Show everything open on ${esc(p.who || 'nobody')}">
            ${icon(p.who ? (p.who.endsWith('_agent') ? 'smart_toy' : 'person') : 'person_off')}
            <span class="tk-person__name${p.who ? '' : ' tk-row__nobody'}">${esc(p.who || 'Nobody')}</span>
            <span class="tk-person__bar">${
                p.overdue ? `<span class="tk-pill tk-pill--overdue">${p.overdue} overdue</span>` : ''
            }${
                p.undated ? `<span class="tk-pill tk-pill--none">${p.undated} undated</span>` : ''
            }${
                p.next ? `<span class="tk-pill">next ${esc(p.next)}</span>` : ''
            }</span>
            <span class="tk-person__count">${p.open} open</span>
        </div>`;

    const render = () => {
        const today = todayISO();
        const all = scoped();
        const open = all.filter(isOpen);
        const withState = (s) => open.filter((i) => dueState(i, today) === s);

        const overdue = withState('overdue')
            .sort((a, b) => daysBetween(today, a.due) - daysBetween(today, b.due));
        const soon = [...withState('today'), ...withState('soon')]
            .sort((a, b) => String(a.due).localeCompare(String(b.due)));
        // The two gaps, in one section: an item with nobody on it and an item
        // with no date are the same failure from the tracker's point of view —
        // it cannot tell you anything about either.
        const gaps = open.filter((i) => !i.assignee || dueState(i, today) === 'none');
        const plates = people();

        host.innerHTML = `
        <div class="td-page tk-page">
            <div class="td-page__bar">
                <span class="td-page__title">${icon('space_dashboard')} Tracker</span>
                <span class="td-dim">${open.length} open · ${overdue.length} overdue</span>
                <span class="td-spacer"></span>
                <span class="tk-scopes" role="group" aria-label="Scope">
                    ${SCOPES.map((s) => `
                        <button type="button" class="ea-btn tk-scope${s.id === scope ? ' tk-scope--on' : ''}"
                                data-scope="${s.id}" aria-pressed="${s.id === scope}"
                                title="${esc(s.hint)}">${esc(s.label)}</button>`).join('')}
                </span>
                <button class="ea-btn ea-btn--primary" data-a="new">${icon('add')} New</button>
            </div>

            <div class="tk-grid">
                ${section('overdue', 'running_with_errors', 'Overdue', overdue,
                    'Nothing is late.',
                    `<button class="ea-btn ea-btn--small" data-board="overdue">Open as a list</button>`)}
                ${section('soon', 'event_upcoming', `Due in the next ${DUE_SOON_DAYS} days`, soon,
                    'Nothing falls due this week.',
                    `<button class="ea-btn ea-btn--small" data-board="soon">Open as a list</button>`)}

                <section class="tk-sec" data-sec="people">
                    <div class="tk-sec__head">
                        ${icon('groups')}<b>Who has what</b>
                        <span class="td-dim">${plates.length}</span>
                    </div>
                    <div class="tk-sec__body">
                        ${plates.length
                            ? plates.map(personRow).join('')
                            : '<div class="tk-empty">Nothing is open.</div>'}
                    </div>
                </section>

                ${section('gaps', 'help', 'Needs a name or a date', gaps,
                    'Everything open has somebody on it and a date to hit.',
                    `<button class="ea-btn ea-btn--small" data-board="undated">Open as a list</button>`)}
            </div>
        </div>`;
    };
    render();

    const onClick = (e) => {
        const scopeBtn = e.target.closest('[data-scope]');
        if (scopeBtn) { scope = scopeBtn.dataset.scope; render(); return; }

        const board = e.target.closest('[data-board]')?.dataset.board;
        if (board === 'overdue') { openBoard({ expr: dueStateExpr('overdue'), label: 'Overdue' }); return; }
        if (board === 'soon') { openBoard({ filter: 'duesoon' }); return; }
        if (board === 'undated') { openBoard({ filter: 'undated' }); return; }

        const person = e.target.closest('[data-who]');
        if (person) {
            const who = person.dataset.who;
            openBoard({ expr: assigneeExpr(who), label: who ? `On ${who}` : 'Nobody on it' });
            return;
        }
        const row = e.target.closest('[data-open]');
        if (row) {
            // Ctrl/Cmd-click: a floating window, or a background tab, per the
            // setting — either way the dashboard stays where it is.
            const model = ITEMS.find((x) => Number(x.id) === Number(row.dataset.open));
            if (isModifiedOpen(e) && model) {
                openModified(ctx.wm, 'item', { id: String(model.id), label: itemLabel(model) });
                return;
            }
            openItem(row.dataset.open);
            return;
        }

        if (e.target.closest('[data-a="new"]')) openNewItem(ctx.wm, { kind: 'task', ctx });
    };

    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-open],[data-who]');
        if (!row) return;
        e.preventDefault();
        // The rows are role="button", so Enter/Space must do what a click does.
        // One handler rather than two: a second copy is how a keyboard path
        // quietly stops matching the mouse one.
        onClick({ target: row });
    };

    const onMenu = (e) => {
        const row = e.target.closest('[data-open]');
        if (!row) return;
        const model = ITEMS.find((x) => Number(x.id) === Number(row.dataset.open));
        if (!model) return;
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Open beside the tracker', icon: 'open_in_new', action: 'open' },
            { label: 'Open in a window', icon: 'web_asset', action: 'window' },
            { separator: true },
            { label: `Everything on ${model.assignee || 'nobody'}`, icon: 'person', action: 'who' },
            { label: 'Everything in this project', icon: 'folder_special', action: 'project',
              disabled: !model.projectRef },
            { separator: true },
            { label: 'Copy reference', icon: 'content_copy', action: 'copy' },
            { separator: true },
            { label: 'Delete…', icon: 'delete', action: 'delete', danger: true },
        ], (action) => {
            if (action === 'open') openItem(model.id);
            else if (action === 'window') {
                ctx.wm?.navigate?.('item', { id: String(model.id), label: itemLabel(model) },
                    { ctx, dest: 'window' });
            } else if (action === 'who') {
                openBoard({ expr: assigneeExpr(model.assignee), label: model.assignee ? `On ${model.assignee}` : 'Nobody on it' });
            } else if (action === 'project' && model.projectRef) {
                openBoard({ expr: projectExpr(model.projectRef), label: model.projectRef });
            } else if (action === 'delete') {
                confirmDelete(model, { onStatus: statusLine })
                    .then((done) => { if (done) { _eventBus?.emit?.('backlog:changed', {}); render(); } });
            } else if (action === 'copy') {
                navigator.clipboard.writeText(itemRef(model))
                    .then(() => statusLine(`Copied ${itemRef(model)}.`))
                    .catch((err) => statusLine(`Copy failed: ${err?.message || err}`));
            }
        });
    };

    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('contextmenu', onMenu);

    // Drag a row onto any tile to display it there. See ./record_dnd.js.
    const drag = installRecordDragSource(host, (el) => {
        const id = el?.closest?.('[data-open]')?.dataset.open;
        const model = id ? ITEMS.find((x) => Number(x.id) === Number(id)) : null;
        return model
            ? { kind: 'item', props: { id: String(model.id), label: itemLabel(model) }, label: model.ref }
            : null;
    });

    // Repaint on any write, ours or somebody else's. NOTE the handle:
    // EventBus.on() returns { id, dispose } and off() takes THAT — a call
    // shaped like removeEventListener silently leaves the subscription behind.
    const sub = _eventBus?.on?.('backlog:changed', render);

    return {
        title: 'Tracker',
        destroy: () => {
            sub?.dispose?.();
            drag.destroy();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
            host.removeEventListener('contextmenu', onMenu);
        },
    };
}

/** The content map. Registered by install.js only in tracker mode. */
export function createTrackerContent({ eventBus } = {}) {
    _eventBus = eventBus || null;
    const page = shell('tracker', mountTracker);
    return {
        tracker: page,
        // `home` is the WM's default leaf, and ticketdesk/pages.js points it at
        // the bug queue. In tracker mode that would open the app on a store this
        // deployment is not about, with the Tracker chip lit above it — the top
        // bar and the tile disagreeing on the first screen you ever see.
        // install.js merges this map last, so this wins.
        home: page,
    };
}
