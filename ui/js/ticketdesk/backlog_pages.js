/**
 * ticketdesk/backlog_pages.js — BugDesk's backlog content kinds.
 *
 * Registered kinds:
 *   backlog   the tree/list of epics, stories and tasks (a view at a time)
 *   item      one backlog item: record, children, acceptance criteria, comments
 *
 * plus `mountBacklogRail`, the Backlog half of the left panel (see pages.js's
 * mountTicketNav for the Bugs half and the tab strip that switches them).
 *
 * WHY THIS IS A SEPARATE FILE FROM pages.js. The two stores answer different
 * questions and their pages share almost no logic — a bug queue is something you
 * interrogate (hence the filter AST, the expression editor, the per-column
 * filters), a backlog is something you walk down and refine. What they DO share
 * is the scaffold: `shell()` gives both the same breadcrumb strip, floating
 * action slot and scroll region, and `statusLine()` the same place to report to.
 * Both are imported from pages.js rather than reimplemented.
 *
 * REFINEMENT is the one workflow this page is built around. `refinementGaps()`
 * in ./backlog_data.js is the single definition of "refined enough"; the item
 * page LISTS the unmet rules instead of greying out a button, because "why can't
 * I mark this refined" is the question a disabled control always raises and
 * never answers. skills/backlog/SKILL.md applies the same rules.
 */

import { DataTable } from '../ui/components/data_table.js';
import { showContextMenu } from '../ecoagent/ui/context_menu.js';
import { renderMarkdown } from './markdown.js';
import { attachMarkdownEditor } from './md_editor.js';
import { attachTagInput } from './tag_input.js';
import { attachSelect } from './select_field.js';
import { watchRecord } from './live.js';
import { attachParentPicker, childTypesFor, openItemPicker } from './item_picker.js';
import { installRecordDragSource, isModifiedOpen, markDragCell, openModified } from './record_dnd.js';
import { confirmDelete } from './delete_item.js';
import { openFilterEditor } from './filter_editor.js';
import { openNewItem } from './new_item.js';
import { onFiltersChanged } from './filter_store.js';
import { shell, statusLine } from './pages.js';
import { esc, initials, HUMAN_AUTHOR, assigneeChoices, rememberAssignee } from './data.js';
import {
    BUILTIN_FILTERS, DEFAULT_FILTER, MODEL, SCOPE,
    adhocFilter, deleteFilter, describeFilter, duplicateFilter, epicExpr,
    getFilter, listFilters, matcherFor, projectExpr, resolveFilter,
} from './backlog_filters.js';
import {
    ALL_TYPES, ITEMS, PHASES, TRACKER, TYPES, TYPE_ICON,
    DUE_LABEL, collapsibleIds, dueState, duePhrase, fetchItem, humanizeItemStatus,
    dueOf, dueOverrun, isClosedItem, isGated, itemLabel, itemRef, ladderFor,
    loadBacklog, parentTypesFor,
    patchItem, postItemComment,
    REFINEMENT_RULES, refinementGaps, stageActions, stageOf, treeRows,
    typeLabelOf,
} from './backlog_data.js';

/** Set by createBacklogContent at registration, before any mount runs. */
let _eventBus = null;

const md = renderMarkdown;
const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** Status pill. `dropped` is deliberately off the ladder and styled as such. */
const statusPill = (status) =>
    `<span class="bd-status bd-status--${esc(status)}">${esc(humanizeItemStatus(status))}</span>`;

/** Where a target date stands, as a pill. `none` is drawn too: an item nobody
 *  has dated is the gap a tracker exists to surface, not an empty cell. */
const duePill = (item) => {
    const state = dueState(item);
    if (state === 'done') return item.due ? `<span class="bd-due bd-due--done">${esc(item.due)}</span>` : '';
    if (state === 'none') return '<span class="bd-due bd-due--none">no date</span>';
    return `<span class="bd-due bd-due--${state}" title="${esc(DUE_LABEL[state])} — ${esc(item.due)}">${esc(duePhrase(item))}</span>`;
};

const typeGlyph = (type) =>
    `<span class="bd-type bd-type--${esc(type)}" title="${esc(typeLabelOf(type))}">${icon(TYPE_ICON[type] || 'task')}</span>`;

/** "2/3" with a bar, or an italic "none" — an unrefined item having no
 *  criteria is the normal state, not a gap in the data. */
function criteriaCell(done, total) {
    if (!total) return '<span class="bd-crit bd-crit--none">none</span>';
    const pct = Math.round((done / total) * 100);
    return `<span class="bd-crit"><span class="bd-crit__bar"><span class="bd-crit__fill" style="width:${pct}%"></span></span>${done}/${total}</span>`;
}

/* ── collapse state ──────────────────────────────────────────────────
 *
 * Which subtrees are folded is a per-person preference about a shared store, so
 * it lives in the user's profile (`GET`/`POST /api/user/settings`) rather than
 * localStorage: BugDesk is a tool you run from wherever the repo is checked
 * out, and a fold that does not survive moving machines is a fold you re-do
 * every morning.
 *
 * Reads are served from an in-memory cache so a render never awaits; the write
 * is fire-and-forget for the same reason. A failed write costs a fold, which is
 * not worth blocking a click over — but it is still reported, not swallowed.
 */
const COLLAPSE_KEY = 'backlog.collapsed';
let _collapsed = new Set();
let _collapseLoaded = false;

async function loadCollapsed() {
    if (_collapseLoaded) return _collapsed;
    _collapseLoaded = true;
    try {
        const res = await fetch('/api/user/settings', { headers: { accept: 'application/json' } });
        const j = res.ok ? await res.json() : null;
        const ids = j?.settings?.[COLLAPSE_KEY];
        if (Array.isArray(ids)) _collapsed = new Set(ids.map(Number).filter(Boolean));
    } catch (err) {
        console.warn('[bugdesk] could not read collapse state', err);
    }
    return _collapsed;
}

function saveCollapsed() {
    fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ [COLLAPSE_KEY]: Array.from(_collapsed) }),
    }).catch((err) => statusLine(`Could not save the fold state: ${err?.message || err}`));
}

/* ── kind: backlog — the tree ────────────────────────────────────── */

/**
 * The board's columns, as a spec rather than two parallel literals.
 *
 * There used to be a header array, a row-building array and a set of hardcoded
 * column indices in renderCell. That is fine only while the column list is
 * fixed — and it is not: tracker mode adds Due. One conditional column against
 * three hand-kept-in-step lists is how a Status pill ends up painted over an
 * Assignee, so the indices are derived from the spec instead.
 */
const BOARD_COLS = [
    { key: 'ref', label: 'Item', get: (i) => i.ref },
    { key: 'title', label: 'Title', get: (i) => i.title },
    { key: 'type', label: 'Type', get: (i) => i.typeLabel },
    { key: 'status', label: 'Status', get: (i) => i.statusLabel },
    { key: 'points', label: 'Pts', get: (i) => i.points || '' },
    { key: 'criteria', label: 'Criteria',
      get: (i) => (i.criteriaTotal ? `${i.criteriaDone}/${i.criteriaTotal}` : '') },
    { key: 'assignee', label: 'Assignee', get: (i) => i.assignee },
    // Tracker mode only. In a plain backlog the column would be empty on every
    // row — the target date is the axis a follow-up tracker turns on and very
    // little else. The CELL still carries the raw `YYYY-MM-DD` so the column
    // sorts chronologically; the pill is painted over it in renderCell.
    ...(TRACKER ? [{ key: 'due', label: 'Due', get: (i) => i.dueLabel || '' }] : []),
    { key: 'phase', label: 'Phase', get: (i) => i.phaseLabel },
    { key: 'updated', label: 'Updated', get: (i) => i.updated },
];
const BOARD_HEADERS = BOARD_COLS.map((c) => c.label);
/** key → column index, so nothing reads a magic number. */
const COL = Object.fromEntries(BOARD_COLS.map((c, i) => [c.key, i]));
/* The column every "act on this row" command reads back. Reference, not id:
   it is the only cell that survives a sort as a stable key into the store. */
const REF_COL = COL.ref;

const boardRow = (i) => BOARD_COLS.map((c) => c.get(i));

/**
 * The tree drawing for one row's Title cell: guide lines for every ancestor
 * level, then this row's own connector, then a caret if it has children.
 *
 * Guides are spans rather than box-drawing characters so they line up at any
 * font — `└─` in a proportional fallback font is ragged, and this column is
 * where the hierarchy is supposed to be legible at a glance.
 */
function treeGuides(row) {
    if (!row.depth) return '';
    const parts = [];
    // One rail per ancestor level. `ancestorsLast[k]` true means that ancestor
    // was the last of its siblings, so its vertical line has already ended.
    for (let k = 0; k < row.depth - 1; k++) {
        parts.push(`<span class="bd-guide ${row.ancestorsLast[k + 1] ? '' : 'bd-guide--line'}"></span>`);
    }
    parts.push(`<span class="bd-guide bd-guide--${row.isLast ? 'end' : 'tee'}"></span>`);
    return parts.join('');
}

function mountBacklogBoard(host, props, ctx) {
    // props.expr (ad-hoc, e.g. a rail epic click) beats props.filter (a stored
    // key or saved id) — same precedence as the bug queue.
    let view = props?.expr
        ? adhocFilter(props.expr, props.label)
        : resolveFilter(props?.filter);

    host.innerHTML = `
    <div class="td-page">
        <div class="td-page__bar">
            <span class="td-page__title" data-slot="title">${icon(esc(view.icon))} ${esc(view.label)}</span>
            <span class="td-dim" data-slot="count"></span>
            <span class="td-spacer"></span>
            <button class="ea-btn" data-a="expand" title="Expand every item">${icon('unfold_more')}</button>
            <button class="ea-btn" data-a="collapse" title="Collapse every item">${icon('unfold_less')}</button>
            <button class="ea-btn" data-a="savefilter">${icon('filter_alt')} Save as filter</button>
            <span class="bd-newgroup">
                <span class="td-dim">New</span>
                ${TYPES.map((t) => `<button class="ea-btn" data-a="new-${t}"
                        title="New ${esc(typeLabelOf(t).toLowerCase())}">${icon(TYPE_ICON[t])} ${esc(typeLabelOf(t))}</button>`).join('')}
            </span>
        </div>
        <div class="td-tablehost"></div>
    </div>`;

    const openBoard = (p) => {
        if (ctx.wm?.navigate) ctx.wm.navigate('backlog', p, { ctx, dest: 'origin' });
        else ctx.wm?.openInPrimary?.('backlog', p);
    };
    const openItem = (id, opts) => {
        const model = ITEMS.find((x) => Number(x.id) === Number(id));
        const p = { id: String(id), label: itemLabel(model) || `#${id}`, filter: view.key || DEFAULT_FILTER };
        if (ctx.wm?.navigate) ctx.wm.navigate('item', p, { ctx, ...opts });
        else ctx.wm?.openInTabFromContext?.(ctx, 'item', p);
    };
    const openSavedFilter = (f) => openBoard({ filter: f.id, label: f.label });

    /** Row models keyed by their reference, so a SORTED table can still find
     *  the item behind a row — the row index after a sort is not the store
     *  index. Rebuilt on every rows() call. */
    let byRef = new Map();

    const rows = () => {
        const list = treeRows(view.match, _collapsed);
        byRef = new Map(list.map((i) => [i.ref, i]));
        const matched = list.filter((i) => !i.context).length;
        const context = list.length - matched;
        const countEl = host.querySelector('[data-slot="count"]');
        if (countEl) {
            countEl.textContent = context
                ? `${matched} item${matched === 1 ? '' : 's'} · ${context} shown for context`
                : `${matched} item${matched === 1 ? '' : 's'}`;
        }
        return list.map(boardRow);
    };

    const refresh = () => table.setData({ rows: rows() });

    const toggleFold = (id) => {
        if (_collapsed.has(id)) _collapsed.delete(id); else _collapsed.add(id);
        saveCollapsed();
        refresh();
    };

    const menuRefs = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
        .map((r) => r?.[REF_COL]).filter(Boolean);

    const table = new DataTable(host.querySelector('.td-tablehost'), {
        headers: BOARD_HEADERS,
        rows: [],
        pagination: false,
        selectable: true,
        copyable: true,
        // Sorting flattens the hierarchy — a tree sorted by Updated is no longer
        // a tree — so the Item/Title columns keep their tree order and the rest
        // stay sortable for the "just find it" case.
        sortable: true,
        filterable: true,
        mode: 'compact',
        emptyMessage: 'Nothing in this view',
        services: { eventBus: _eventBus },
        contextMenuItems: (cm) => {
            const refs = menuRefs(cm);
            const model = cm.row ? byRef.get(cm.row[REF_COL]) : null;
            return [
                { label: refs.length > 1 ? `Open ${refs.length} items in tabs` : 'Open',
                  icon: 'open_in_new', action: 'open', disabled: !refs.length },
                { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !model },
                { label: 'Open in split right', icon: 'splitscreen_vertical_add', action: 'open-split-h', disabled: !model },
                { separator: true },
                { label: model?.isCollapsed ? 'Expand' : 'Collapse', icon: 'account_tree',
                  action: 'fold', disabled: !model?.hasChildren },
                { label: 'Show only this work package', icon: 'filter_center_focus',
                  action: 'focus-epic', disabled: !model?.epicRef },
                { separator: true },
                // A task cannot hold children, so the entry is greyed rather
                // than hidden — the menu keeps one shape whichever row you hit.
                { label: 'Add child…', icon: 'add', action: 'add-child',
                  disabled: !model || childTypesFor(model.type).length === 0 },
                ...(TRACKER ? [
                    { separator: true },
                    { label: 'Delete…', icon: 'delete', action: 'delete',
                      disabled: !model, danger: true },
                ] : []),
                { separator: true },
                { label: refs.length > 1 ? `Copy ${refs.length} references` : 'Copy reference',
                  icon: 'content_copy', action: 'copy-ref', disabled: !refs.length },
            ];
        },
        onContextMenuAction: async (action, cm) => {
            const refs = menuRefs(cm);
            const model = cm.row ? byRef.get(cm.row[REF_COL]) : null;
            switch (action) {
                case 'open': refs.forEach((r) => { const m = byRef.get(r); if (m) openItem(m.id, { dest: 'origin', newTab: true }); }); break;
                case 'open-window': if (model) openItem(model.id, { dest: 'window' }); break;
                case 'open-split-h': if (model) openItem(model.id, { dest: 'split-h' }); break;
                case 'fold': if (model?.hasChildren) toggleFold(Number(model.id)); break;
                case 'focus-epic':
                    if (model?.epicRef) openBoard({ expr: epicExpr(model.epicRef), label: model.epicRef });
                    break;
                case 'add-child': {
                    if (!model) break;
                    // A new child under a folded parent would land invisible.
                    _collapsed.delete(Number(model.id));
                    openNewItem(ctx.wm, {
                        kind: childTypesFor(model.type)[0] || 'task',
                        parent: model.id, ctx,
                    });
                    break;
                }
                case 'delete':
                    if (model) {
                        const done = await confirmDelete(model, { onStatus: statusLine });
                        if (done) {
                            _eventBus?.emit?.('backlog:changed', {});
                            refresh();
                        }
                    }
                    break;
                case 'copy-ref':
                    if (refs.length) {
                        try {
                            await navigator.clipboard.writeText(refs.join('\n'));
                            statusLine(`Copied ${refs.length} reference${refs.length === 1 ? '' : 's'}.`);
                        } catch (err) {
                            statusLine(`Copy failed: ${err?.message || err}`);
                        }
                    }
                    break;
            }
        },
        renderCell: (td, value, colIdx, rowIdx, row) => {
            const model = byRef.get(row[REF_COL]);
            // Every cell is a drag handle, carrying the row's reference. Marked
            // on the CELL because DataTable renders it detached — see
            // markDragCell in ./record_dnd.js for why that matters.
            markDragCell(td, row[REF_COL]);
            if (colIdx === REF_COL) {
                td.innerHTML = `<span class="bd-item__ref">${esc(value)}</span>`;
                return true;
            }
            if (colIdx === COL.title) {
                // The hierarchy IS this cell: guides, a fold caret, the type
                // glyph, the title. The bridge hands rows back in tree order and
                // treeRows() works out the shape; this only draws it.
                const caret = model?.hasChildren
                    ? `<button type="button" class="bd-caret" data-fold="${model.id}"
                               aria-label="${model.isCollapsed ? 'Expand' : 'Collapse'} ${esc(model.ref)}"
                               aria-expanded="${model.isCollapsed ? 'false' : 'true'}">${icon(model.isCollapsed ? 'chevron_right' : 'expand_more')}</button>`
                    : '<span class="bd-caret bd-caret--none"></span>';
                td.innerHTML = `<span class="bd-item${model?.context ? ' bd-item--context' : ''}">
                    ${treeGuides(model || {})}${caret}${typeGlyph(model?.type || 'task')}<span class="bd-item__title">${esc(value)}</span>
                    ${model?.hidden ? `<span class="bd-item__hidden">+${model.hidden}</span>` : ''}</span>`;
                return true;
            }
            if (colIdx === COL.status) { td.innerHTML = statusPill(model?.status || 'draft'); return true; }
            if (colIdx === COL.criteria) {
                td.innerHTML = criteriaCell(model?.criteriaDone || 0, model?.criteriaTotal || 0);
                return true;
            }
            if (COL.due !== undefined && colIdx === COL.due) {
                const over = model ? dueOverrun(model) : null;
                td.innerHTML = (model ? duePill(model) : '')
                    + (over ? `<span class="bd-duewarn bd-duewarn--dot"
                               title="Due after ${esc(itemRef(over))} (${esc(dueOf(over))})">${icon('warning')}</span>` : '');
                return true;
            }
            return false;
        },
        onRowClick: (rowIdx, row, ev) => {
            const model = byRef.get(row[REF_COL]);
            // Ctrl/Cmd-click opens WITHOUT taking the list off screen — a
            // floating window, or a background tab, per the setting. Shift is
            // left alone: it is the table's range-select and the one selection
            // gesture that has no other home.
            if (isModifiedOpen(ev)) {
                if (model) openModified(ctx.wm, 'item', { id: String(model.id), label: itemLabel(model) });
                return;
            }
            if (ev && ev.shiftKey) return;
            if (model) openItem(model.id, { dest: 'origin', newTab: true });
        },
    });

    // Drag a row onto any tile to display it there. See ./record_dnd.js.
    const drag = installRecordDragSource(host, (el) => {
        const ref = el?.closest?.('[data-drag-key]')?.dataset.dragKey;
        const model = ref ? byRef.get(ref) : null;
        return model
            ? { kind: 'item', props: { id: String(model.id), label: itemLabel(model) }, label: model.ref }
            : null;
    });

    // The caret lives INSIDE a row, so its click would also open the item.
    // Caught in the capture phase, before DataTable's own row handler sees it.
    const onCaret = (e) => {
        const btn = e.target.closest?.('[data-fold]');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        toggleFold(Number(btn.dataset.fold));
    };
    host.addEventListener('click', onCaret, true);

    // Collapse state may not have arrived yet on the very first mount; render
    // what we have, then repaint once it does.
    table.setData({ rows: rows() });
    table.render();
    loadCollapsed().then(() => { if (host.isConnected) refresh(); });
    requestAnimationFrame(() => { if (host.isConnected) table.focus(); });

    const actions = {
        expand: () => { _collapsed.clear(); saveCollapsed(); refresh(); },
        collapse: () => {
            for (const id of collapsibleIds()) _collapsed.add(id);
            saveCollapsed();
            refresh();
        },
        savefilter: () => openFilterEditor({
            model: MODEL, scope: SCOPE,
            seedExpr: view.expr, items: ITEMS,
            rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
            onSaved: openSavedFilter,
        }),
        ...Object.fromEntries(TYPES.map((t) =>
            [`new-${t}`, () => openNewItem(ctx.wm, { kind: t, ctx })])),
    };
    host.querySelector('.td-page__bar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-a]');
        if (btn && actions[btn.dataset.a]) actions[btn.dataset.a]();
    });

    // A save/delete in the editor changes what this view means (or deletes it
    // outright — resolveFilter then lands on the default). Ad-hoc views own
    // their expression, so nothing in the store can move them.
    const unsub = onFiltersChanged(() => {
        if (view.adhoc) return;
        view = resolveFilter(view.key);
        const titleEl = host.querySelector('[data-slot="title"]');
        if (titleEl) titleEl.innerHTML = `${icon(esc(view.icon))} ${esc(view.label)}`;
        refresh();
    });

    // An edit made on an item page changes what this table shows. The bus event
    // is emitted by the item page after every successful write.
    //
    // NOTE the handle: EventBus.on() returns { id, dispose } and off() takes
    // THAT, not (name, handler) — a call shaped like removeEventListener finds
    // no listener id, returns false and leaves the subscription in place.
    const sub = _eventBus?.on?.('backlog:changed', () => {
        if (!view.adhoc) view = resolveFilter(view.key);
        refresh();
    });

    return {
        title: view.label,
        destroy: () => {
            unsub();
            sub?.dispose?.();
            drag.destroy();
            host.removeEventListener('click', onCaret, true);
            table.dispose();
        },
    };
}

/* ── kind: item — one backlog record ─────────────────────────────── */

function mountItem(host, props, ctx) {
    const id = Number(String(props?.id ?? '').replace(/^#/, ''));
    if (!id) {
        host.innerHTML = `<div class="tile-placeholder"><div class="tile-placeholder__title">No item</div>
            <div class="tile-placeholder__hint">no backlog item matched ${esc(String(props?.id ?? ''))}</div></div>`;
        return { title: 'Item' };
    }

    let item = null;                     // the authoritative record, refreshed on every write
    let dirty = false;

    host.innerHTML = `
    <div class="td-page td-ticket">
        <div class="bd-ancestors" data-slot="ancestors"></div>
        <div class="td-stagebar">
            <ol class="td-stages" data-slot="stages"></ol>
        </div>
        <div class="td-stageactions">
            <span class="td-stageactions__title">${icon('bolt')} Actions</span>
            <span data-slot="stageactions"></span>
        </div>
        <div class="td-mask">
            <section class="td-group">
                <div class="td-group__title">${TRACKER ? 'Ticket' : 'Backlog Item'}
                    ${TRACKER ? `<span class="td-group__actions">
                        <button class="ea-btn ea-btn--small ea-btn--danger" data-a="delete"
                                title="Delete this record">${icon('delete')} Delete</button>
                    </span>` : ''}
                </div>
                <div class="td-group__body td-grid2" data-slot="record"></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Refinement</div>
                <div class="td-group__body" data-slot="refinement"></div>
            </section>
            <section class="td-group bd-acceptance">
                <div class="td-group__title">Acceptance criteria</div>
                <div class="td-group__body" data-slot="acceptance"></div>
            </section>
            <section class="td-group" data-slot="childrenbox" hidden>
                <div class="td-group__title">Children
                    <span class="td-group__actions">
                        <button class="ea-btn ea-btn--small" data-a="attachchild"
                                title="Attach an existing item">${icon('search')} Add existing</button>
                        <button class="ea-btn ea-btn--small" data-a="addchild"
                                title="File a new one under this">${icon('add')} New</button>
                    </span>
                </div>
                <div class="td-group__body bd-children" data-slot="children"></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Description
                    <span class="td-group__actions" data-slot="descactions"></span>
                </div>
                <div class="td-group__body" data-slot="desc"><span class="td-dim">Loading…</span></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Comments <span class="td-dim">— posted as ${esc(HUMAN_AUTHOR)}</span></div>
                <div class="td-group__body" data-slot="comments"></div>
            </section>
        </div>
    </div>`;

    const actionsEl = ctx?.pageActions || null;
    if (actionsEl) {
        actionsEl.innerHTML = `
            <div class="td-floatactions">
                <button class="ea-btn" data-a="cancel" disabled>${icon('undo')} Cancel</button>
                <button class="ea-btn ea-btn--primary" data-a="save" disabled>${icon('save')} Save</button>
            </div>`;
    }

    const $ = (s) => host.querySelector(s) || actionsEl?.querySelector(s) || null;
    const fval = (k) => host.querySelector(`[data-f="${k}"]`)?.value?.trim() ?? '';
    const setDirty = (on) => {
        dirty = on;
        const save = $('[data-a="save"]'), cancel = $('[data-a="cancel"]');
        if (save) save.disabled = !on;
        if (cancel) cancel.disabled = !on;
    };

    let tagInput = null;
    let composer = null;
    let acceptanceEditor = null;
    let descEditor = null;
    const fieldSelects = [];      // custom dropdowns replacing the bare <select>s
    let parentPicker = null;      // the shared search control (item_picker.js)
    const destroyWidgets = () => {
        for (const w of [tagInput, composer, acceptanceEditor, descEditor, parentPicker, ...fieldSelects]) {
            try { w?.destroy(); } catch { /* already gone */ }
        }
        fieldSelects.length = 0;
        parentPicker = null;
        tagInput = composer = acceptanceEditor = descEditor = null;
    };

    /* ── record ─────────────────────────────────────────────────── */

    const renderRecord = () => {
        const field = (label, ctrl, span) =>
            `<div class="td-field${span ? ' td-span2' : ''}"><label>${label}</label>${ctrl}</div>`;
        const sel = (k, opts, cur) => `<select class="ea-tin" data-f="${k}">
            ${opts.map((o) => {
                const v = typeof o === 'object' ? o.value : o;
                const l = typeof o === 'object' ? o.label : o;
                return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
            }).join('')}</select>`;
        const tin = (k, v) => `<input class="ea-tin" data-f="${k}" value="${esc(v ?? '')}">`;

        // Which rows this type actually has. `authorsPhase` and `hasParent` are
        // DERIVED — from where the milestone label is written, and from the
        // hierarchy rules in ./backlog_data.js — rather than being a second
        // per-type table here that could disagree with the New item form's.
        /**
         * The date field, plus what is true about it that the input cannot say.
         *
         * A date is INHERITED from the nearest dated ancestor unless this record
         * sets its own — so an empty input is not "no date", it is "the same
         * date as the thing this belongs to", and the placeholder says which.
         * Clearing the field is how you go back to inheriting.
         *
         * The overrun note is the other half: a sub-item due after its parent is
         * allowed (plans slip one piece at a time, and refusing would only make
         * people lie about the date) but it always means the parent's date is
         * already wrong and nobody has moved it yet.
         */
        const dueField = () => {
            const inherited = String(item.effectiveDue || '').trim();
            const own = String(item.due || '').trim();
            const over = dueOverrun(item);
            return `<div class="bd-duefield">
                <input class="ea-tin" type="date" data-f="due" value="${esc(own)}"
                       ${!own && inherited ? `title="Inherited from ${esc(inherited)} — set a date here to override it"` : ''}>
                ${!own && inherited
                    ? `<span class="td-dim bd-duefield__note">inherited ${esc(inherited)}</span>`
                    : ''}
                ${over
                    ? `<span class="bd-duewarn" title="${esc(itemRef(over))} is due ${esc(dueOf(over))}">
                           ${icon('warning')} after ${esc(itemRef(over))} (${esc(dueOf(over))})
                       </span>`
                    : ''}
            </div>`;
        };

        const authorsPhase = item.type === 'project' || item.type === 'epic';
        const hasParent = parentTypesFor(item.type).length > 0;
        const hasPoints = item.type !== 'project';

        $('[data-slot="record"]').innerHTML = `
            ${field('Reference', `<input class="ea-tin td-mono" value="${esc(itemRef(item))}" readonly>`)}
            ${field('Status', `<input class="ea-tin td-mono" data-f="status" value="${esc(humanizeItemStatus(item.status))}" readonly>`)}
            <div class="td-field td-span2"><label class="td-req">Title</label>${tin('title', item.title)}</div>
            ${field('Type', sel('type', TYPES.map((t) => ({ value: t, label: typeLabelOf(t) })), item.type))}
            ${hasPoints ? field('Estimate', tin('points', item.points)) : ''}
            ${hasParent ? field('Parent', tin('parent', item.parent || '')) : ''}
            ${authorsPhase
                ? field('Phase', tin('phase', item.phase))
                : field('Phase', `<input class="ea-tin" value="${esc(item.effectivePhase || '—')}" readonly title="Inherited from the owning project or epic">`)}
            ${field('Assignee', '<select class="ea-tin" data-f="assignee"></select>')}
            ${field('Target date', dueField())}
            ${field('Subsystem', tin('subsystem', item.subsystem))}
            ${field('Reporter', '<select class="ea-tin" data-f="reporter"></select>')}
            <div class="td-field td-span2"><label>Labels</label>${tin('labels', (item.labels || []).join(', '))}</div>
            ${field('Created', `<input class="ea-tin td-mono" value="${esc(item.created || '—')}" readonly>`)}
            ${field('Updated', `<input class="ea-tin td-mono" value="${esc(item.updated || '—')}" readonly>`)}`;

        try { tagInput?.destroy(); } catch { /* first render */ }
        const labelsEl = host.querySelector('[data-f="labels"]');
        tagInput = labelsEl
            ? attachTagInput(labelsEl, {
                suggestions: Array.from(new Set(ITEMS.flatMap((i) => i.labels || []))).sort(),
            })
            : null;

        // Custom controls, replacing the browser's own. Phase ALLOWS A NEW
        // VALUE: the phase vocabulary is not a fixed list, it is extended by
        // naming one, and a dropdown that cannot express "foundation-2" forces
        // the user out to a text file to say it.
        for (const s of fieldSelects) { try { s.destroy(); } catch { /* gone */ } }
        fieldSelects.length = 0;
        const attach = (name, spec) => {
            const el = host.querySelector(`[data-f="${name}"]`);
            if (el && el.tagName === 'SELECT') fieldSelects.push(attachSelect(el, spec));
        };
        // The offered list, plus this item's OWN type if the deployment does not
        // offer it — a PROJ record opened in a plain backlog must still show
        // "Project" in its Type control rather than silently reading as the
        // first entry in a list it is not in.
        const typeChoices = (TYPES.includes(item.type) ? TYPES : ALL_TYPES.filter(
            (t) => TYPES.includes(t) || t === item.type));
        attach('type', {
            options: typeChoices.map((t) => ({ value: t, label: typeLabelOf(t), icon: TYPE_ICON[t] })),
            value: item.type,
        });
        attach('assignee', {
            optionsFor: assigneeChoices,
            value: item.assignee || '', emptyLabel: 'Unassigned', allowNew: true,
            // Naming somebody not on the roster adds them to it — see
            // rememberAssignee in ./data.js.
            onChange: (v) => { rememberAssignee(v); },
        });
        // Who is FOLLOWING THIS UP, as opposed to who is doing it. Editable
        // rather than stamped at creation: handing a follow-up to a colleague is
        // a normal thing to do, and a reporter you cannot correct makes the
        // dashboard's "assigned by me" scope wrong for good.
        attach('reporter', {
            optionsFor: assigneeChoices,
            value: item.reporter || '', emptyLabel: 'Nobody', allowNew: true,
            onChange: (v) => { rememberAssignee(v); },
        });
        // The SAME control the New item page uses — changing an item's parent is
        // the same act whether the item exists yet or not, and a second copy
        // would be a second set of rules about which types may hold which.
        try { parentPicker?.destroy(); } catch { /* first render */ }
        parentPicker = null;
        const parentEl = host.querySelector('[data-f="parent"]');
        if (parentEl) {
            parentPicker = attachParentPicker(parentEl, {
                typeOf: () => item.type,
                value: Number(item.parent) || 0,
                excludeId: () => Number(item.id) || 0,
            });
        }
        const phaseEl = host.querySelector('[data-f="phase"]');
        if (phaseEl && phaseEl.tagName === 'INPUT') {
            const holder = document.createElement('select');
            for (const attr of phaseEl.attributes) holder.setAttribute(attr.name, attr.value);
            phaseEl.replaceWith(holder);
            fieldSelects.push(attachSelect(holder, {
                optionsFor: () => PHASES, value: item.phase || '', allowNew: true,
                emptyLabel: 'No phase',
            }));
        }
    };

    const renderAncestors = () => {
        const chain = Array.isArray(item.ancestors) ? item.ancestors : [];
        const el = $('[data-slot="ancestors"]');
        el.innerHTML = chain.length
            ? chain.map((a) =>
                `<button type="button" class="bd-item__ref" data-goto="${a.id}">${esc(itemRef(a))}</button>
                 <span>${esc(a.title)}</span><span class="bd-ancestors__sep">›</span>`).join('')
              + `<span>${esc(item.title)}</span>`
            : `<span class="td-dim">${item.type === 'epic' ? 'Top-level epic' : 'Not placed under a parent yet'}</span>`;
    };

    /* ── lifecycle ──────────────────────────────────────────────── */

    // The chevrons and the buttons are BOTH derived from this item's own ladder
    // (an epic has no `review`, a task no `refined`), so a type change repaints
    // a different lifecycle rather than offering transitions the server rejects.
    const renderStages = () => {
        const ladder = item.ladder?.length ? item.ladder : ladderFor(item.type);
        const stage = stageOf(item);
        const dropped = item.status === 'dropped';

        $('[data-slot="stages"]').innerHTML = ladder.map((s, i) =>
            `<li class="td-stage ${!dropped && i < stage ? 'td-stage--done' : ''} ${i === stage ? 'td-stage--active' : ''}"
                 data-stage="${i}"><span class="td-stage__num">${i + 1}</span> ${esc(humanizeItemStatus(s))}</li>`).join('')
            + (dropped ? `<li class="td-stage td-stage--active bd-stage--dropped">${esc(humanizeItemStatus('dropped'))}</li>` : '');

        const gaps = refinementGaps(item);
        $('[data-slot="stageactions"]').innerHTML = stageActions(item).map(([label, target], i) => {
            const blocked = isGated(target) && gaps.length > 0;
            return `<button class="ea-btn td-stageaction ${i === 0 && !blocked ? 'ea-btn--primary td-stageaction--primary' : ''}"
                        data-wf="${esc(target)}" ${blocked ? 'disabled' : ''}
                        title="${blocked ? esc(`${gaps.length} thing${gaps.length === 1 ? '' : 's'} still missing — see Refinement`) : ''}">${esc(label)}</button>`;
        }).join('');
    };

    /* ── refinement checklist ───────────────────────────────────── */

    const renderRefinement = () => {
        // A project never passes through `refined` either, and for the same
        // reason a task does not: it has no acceptance criteria of its own. What
        // it does have is a subtree, so the panel answers the question you
        // actually opened a project to ask — how much of it is late.
        if (item.type === 'project') {
            const ref = itemRef(item);
            const inside = ITEMS.filter((x) => x.projectRef === ref && Number(x.id) !== Number(item.id));
            const open = inside.filter((x) => x.status !== 'done' && x.status !== 'dropped');
            const late = open.filter((x) => x.dueState === 'overdue');
            const undated = open.filter((x) => x.dueState === 'none');
            $('[data-slot="refinement"]').innerHTML = inside.length
                ? `<ul class="bd-gaps${late.length ? '' : ' bd-gaps--met'}">
                     <li>${inside.length} item${inside.length === 1 ? '' : 's'} under this project,
                         ${open.length} still open</li>
                     ${late.length ? `<li>${late.length} overdue</li>` : ''}
                     ${undated.length ? `<li>${undated.length} with no target date</li>` : ''}
                   </ul>`
                : '<div class="td-dim">Nothing under this project yet.</div>';
            return;
        }

        // A task never passes through `refined` — it goes draft → in-progress —
        // so the five-check panel would be a checklist it can never satisfy.
        // What it DOES have is acceptance criteria of its own: a task does NOT
        // inherit its parent's. It used to say it did, which was a claim about
        // data that was never true — nothing anywhere copied or resolved them —
        // and it left tasks looking covered by criteria that described something
        // else.
        if (item.type === 'task') {
            const met = (item.criteria || []).filter((c) => c.done).length;
            const total = (item.criteria || []).length;
            $('[data-slot="refinement"]').innerHTML = total
                ? `<ul class="bd-gaps${met === total ? ' bd-gaps--met' : ''}">
                       <li>${met} of ${total} acceptance criteria met</li>
                   </ul>`
                : `<div class="td-dim">A task goes straight from draft to in progress.
                   Give it acceptance criteria below if what "done" means is worth
                   writing down.</div>`;
            return;
        }

        // Read the rules rather than restating them: the skill and this panel
        // must agree on what "refined" means, and a second copy of the list is
        // how they stop agreeing.
        const gapKeys = new Set(refinementGaps(item).map((g) => g.key));
        const met = [], missing = [];
        for (const rule of REFINEMENT_RULES) {
            (gapKeys.has(rule.key) ? missing : met).push(rule.label);
        }

        $('[data-slot="refinement"]').innerHTML = missing.length
            ? `<div class="td-dim" style="margin-bottom:6px">Not refined yet — ${missing.length} of ${missing.length + met.length} checks outstanding.</div>
               <ul class="bd-gaps">${missing.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
               ${met.length ? `<ul class="bd-gaps bd-gaps--met">${met.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`
            : `<ul class="bd-gaps bd-gaps--met">${met.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    };

    /* ── acceptance criteria ────────────────────────────────────── */

    /**
     * Acceptance criteria as a REAL checklist, not markdown you have to hand-edit.
     *
     * Each row is a checkbox you tick, and each edit is one addressed operation
     * on one line (`POST /api/backlog/{id}/criteria`) rather than a rewrite of
     * the whole section. That matters because the section is hand-authored
     * markdown that may carry a sentence of context or a nested sub-bullet —
     * regenerating it from the parsed rows would delete all of that the first
     * time anyone ticked a box.
     *
     * The markdown view is still one click away, for bulk edits and for anything
     * a checklist cannot express.
     */
    let acceptanceRaw = false;      // showing the markdown editor instead

    const criterion = (c, i) => `
        <li class="bd-crit-row${c.done ? ' bd-crit-row--done' : ''}">
            <input type="checkbox" class="bd-crit-row__box" data-crit-toggle="${i}"
                   ${c.done ? 'checked' : ''}
                   aria-label="${esc(c.text)}">
            <button type="button" class="bd-crit-row__text" data-crit-edit="${i}"
                    title="Click to edit">${esc(c.text)}</button>
            <button type="button" class="bd-crit-row__rm" data-crit-remove="${i}"
                    title="Remove" aria-label="Remove criterion">${icon('close')}</button>
        </li>`;

    const renderAcceptance = () => {
        const el = $('[data-slot="acceptance"]');
        try { acceptanceEditor?.destroy(); } catch { /* first render */ }
        acceptanceEditor = null;

        const list = item.criteria || [];
        const done = list.filter((c) => c.done).length;

        if (acceptanceRaw) {
            el.innerHTML = `
                <textarea class="ea-tin td-area" data-f="acceptance"
                    placeholder="- [ ] one checkable outcome per line"></textarea>
                <div class="bd-acceptance__foot">
                    <button class="ea-btn" data-a="save-acceptance">${icon('save')} Save</button>
                    <button class="ea-btn" data-a="acceptance-list">${icon('checklist')} Back to checklist</button>
                </div>`;
            const ta = el.querySelector('textarea');
            // A placeholder body means "nothing authored yet" — showing the
            // literal "_(not refined yet)_" invites saving it back as content.
            ta.value = /^_\(.*\)_$/.test((item.acceptance || '').trim()) ? '' : (item.acceptance || '');
            acceptanceEditor = attachMarkdownEditor(ta, { onStatus: statusLine, minHeight: 130 });
            return;
        }

        el.innerHTML = `
            ${list.length
                ? `<ul class="bd-crit-list">${list.map(criterion).join('')}</ul>`
                : '<div class="td-dim bd-crit-empty">No acceptance criteria yet.</div>'}
            <div class="bd-crit-add">
                ${icon('add')}
                <input class="ea-tin bd-crit-add__input" data-crit-new
                       placeholder="Add a criterion — one checkable outcome">
            </div>
            <div class="bd-acceptance__foot">
                <span class="td-dim">${criteriaCell(done, list.length)}</span>
                <span class="td-spacer"></span>
                <button class="ea-btn ea-btn--small" data-a="acceptance-raw">${icon('edit_note')} Edit as markdown</button>
            </div>`;
    };

    /** One addressed edit, then repaint from what the bridge says it now is. */
    const criteriaOp = async (op, index, value) => {
        try {
            const res = await fetch(`/api/backlog/${item.id}/criteria`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ op, index, value }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            apply(j.item);
            await broadcast();
        } catch (err) {
            statusLine(`Criteria update failed: ${err?.message || err}`);
            renderAcceptance();   // put the checkbox back where the file says it is
        }
    };

    /* ── children ───────────────────────────────────────────────── */

    const renderChildren = () => {
        const box = $('[data-slot="childrenbox"]');
        const kids = Array.isArray(item.childItems) ? item.childItems : [];
        box.hidden = childTypesFor(item.type).length === 0 && kids.length === 0;
        $('[data-slot="children"]').innerHTML = kids.length
            ? kids.map((c) => `
                <div class="bd-childrow">
                    ${typeGlyph(c.type)}
                    <button type="button" class="bd-item__ref" data-goto="${c.id}">${esc(itemRef(c))}</button>
                    <span class="bd-childrow__title">${esc(c.title)}</span>
                    <span class="td-dim">${esc(c.assignee || '')}</span>
                    ${TRACKER ? duePill(c) : `<span class="td-dim">${esc(c.points || '')}</span>`}
                    ${statusPill(c.status)}
                </div>`).join('')
            : '<div class="td-dim">No children yet.</div>';
    };

    /* ── description + comments ─────────────────────────────────── */

    /* ── description ─────────────────────────────────────────────────
     *
     * Editable, which it was not: the mask let you file a description and then
     * never change it, so the one field with room to say WHY was write-once. It
     * is the same shape the acceptance criteria already use — read it as
     * rendered markdown, edit it in the composer one click away, with the same
     * paste-a-screenshot support the create mask has.
     *
     * The placeholder the bridge writes for an empty description
     * (`_(no description provided)_`) is never loaded into the editor: saving it
     * back would turn a placeholder into content. */
    let descRaw = false;

    const renderDesc = () => {
        const el = $('[data-slot="desc"]');
        const actions = $('[data-slot="descactions"]');
        try { descEditor?.destroy(); } catch { /* first render */ }
        descEditor = null;

        if (!descRaw) {
            el.className = 'td-group__body td-md';
            el.innerHTML = md(item.description) || '<span class="td-dim">No description.</span>';
            if (actions) {
                actions.innerHTML = `<button class="ea-btn ea-btn--small" data-a="desc-edit"
                    title="Edit the description">${icon('edit_note')} Edit</button>`;
            }
            return;
        }

        el.className = 'td-group__body';
        el.innerHTML = `<textarea class="ea-tin td-area" data-f="description"
            placeholder="Why this matters, and for whom. Paste a screenshot to attach it."></textarea>`;
        if (actions) {
            actions.innerHTML = `
                <button class="ea-btn ea-btn--small ea-btn--primary" data-a="desc-save">${icon('save')} Save</button>
                <button class="ea-btn ea-btn--small" data-a="desc-cancel">Cancel</button>`;
        }
        const ta = el.querySelector('textarea');
        ta.value = /^_\(.*\)_$/.test((item.description || '').trim()) ? '' : (item.description || '');
        descEditor = attachMarkdownEditor(ta, { onStatus: statusLine, minHeight: 160 });
        requestAnimationFrame(() => ta.focus());
    };

    const saveDescription = async () => {
        try {
            apply(await patchItem(item.id, {
                description: host.querySelector('[data-f="description"]')?.value || '',
            }));
            await broadcast();
            statusLine('Description saved.');
        } catch (err) { statusLine(`Save failed: ${err?.message || err}`); }
    };

    const commentHTML = (c) => `
        <div class="td-wentry td-wentry--${c.author === HUMAN_AUTHOR ? 'human' : 'agent'}">
            <span class="td-avatar">${esc(initials(c.author))}</span>
            <div>
                <div class="td-wentry__head">
                    <b>${esc(c.author)}</b>
                    <span class="td-chip td-chip--${c.author === HUMAN_AUTHOR ? 'internal' : 'public'}">${esc(c.author)}</span>
                    <span class="td-dim td-mono">${esc(c.date)}</span>
                </div>
                <div class="td-wentry__text td-md">${md(c.body)}</div>
            </div>
        </div>`;

    const renderComments = () => {
        const el = $('[data-slot="comments"]');
        try { composer?.destroy(); } catch { /* previous mount already gone */ }
        composer = null;
        // Newest first, composer at the top — the reply you just wrote appears
        // where you are looking. Same reasoning as the bug mask.
        const comments = (item.comments || []).slice().reverse();
        el.innerHTML = `
            <div class="td-composer">
                <span class="td-avatar">${esc(initials(HUMAN_AUTHOR))}</span>
                <div class="td-composer__box">
                    <textarea class="ea-tin td-area" rows="2"
                        placeholder="Add a comment as ${esc(HUMAN_AUTHOR)}… (Enter posts, Alt+Enter for a new line)"></textarea>
                </div>
            </div>
            <div class="td-wstream">${comments.length ? comments.map(commentHTML).join('') : '<div class="td-dim">No comments yet.</div>'}</div>`;

        composer = attachMarkdownEditor(el.querySelector('textarea'), {
            submitLabel: 'Comment',
            onStatus: statusLine,
            onSubmit: async (text) => {
                if (!text) { statusLine('Nothing to post.'); return; }
                try {
                    apply(await postItemComment(item.id, text, HUMAN_AUTHOR));
                    statusLine('Comment added.');
                } catch (err) { statusLine(`Comment failed: ${err?.message || err}`); }
            },
        });
    };

    /* ── attaching an existing child ─────────────────────────────────
     *
     * The same picker the Parent field uses, from the other end: re-parenting
     * X under Y is one operation, and "add a child" and "set my parent" are two
     * views of it. Descendants are excluded because a cycle is the one thing
     * the tree cannot render — the bridge rejects it too, but offering a choice
     * that will be refused is worse than not offering it. */

    const descendantIds = (rootId) => {
        const out = new Set();
        const walk = (pid) => {
            for (const child of ITEMS.filter((i) => Number(i.parent) === Number(pid))) {
                if (out.has(child.id)) continue;
                out.add(child.id);
                walk(child.id);
            }
        };
        walk(rootId);
        return [...out];
    };

    const attachChild = async () => {
        const picked = await openItemPicker({
            title: `Add an existing item under ${itemRef(item)}`,
            types: childTypesFor(item.type),
            excludeIds: [Number(item.id), ...descendantIds(item.id)],
        });
        if (!picked || !picked.id) return;
        try {
            await patchItem(picked.id, { parent: item.id });
            apply(await fetchItem(item.id));
            await broadcast();
            statusLine(`${picked.ref} moved under ${itemRef(item)}.`);
        } catch (err) {
            statusLine(`Could not attach ${picked.ref}: ${err?.message || err}`);
        }
    };

    /* ── the write path ─────────────────────────────────────────── */

    /** One place where a fresh record becomes the rendered page, so no caller
     *  has to remember which six sections a write invalidates. */
    const apply = (fresh) => {
        item = fresh;
        // A repaint means the record moved on; an open editor holding the
        // previous text would silently save it back over the new one.
        descRaw = false;
        renderAncestors();
        renderRecord();
        renderStages();
        renderRefinement();
        renderAcceptance();
        renderChildren();
        renderDesc();
        renderComments();
        setDirty(false);
    };

    /** Re-read the whole backlog so the tree, the rail counts and the parent
     *  pickers agree with what was just written, then tell the other pages. */
    const broadcast = async () => {
        try { await loadBacklog(); } catch (err) { console.warn('[bugdesk] backlog reload failed', err); }
        _eventBus?.emit?.('backlog:changed', { id: item?.id });
    };

    const save = async () => {
        try {
            const patch = {
                title: fval('title'),
                type: fval('type'),
                assignee: fval('assignee'),
                reporter: fval('reporter'),
                due: fval('due'),
                subsystem: fval('subsystem') || 'unsorted',
                labels: fval('labels') ? fval('labels').split(',').map((s) => s.trim()).filter(Boolean) : [],
            };
            // Only send what the rendered form actually had: a row that was not
            // drawn must not reach the record, or retyping a story to a project
            // would post the parent the form never showed.
            if (item.type === 'project' || item.type === 'epic') patch.phase = fval('phase');
            if (parentTypesFor(item.type).length > 0) patch.parent = parentPicker ? parentPicker.value() : 0;
            if (item.type !== 'project') patch.points = fval('points');
            apply(await patchItem(item.id, patch));
            await broadcast();
            live.clear();
            statusLine(`${itemRef(item)} saved.`);
        } catch (err) { statusLine(`Save failed: ${err?.message || err}`); }
    };

    /** Delete, then leave — the page is about a record that no longer exists,
     *  and a live-update banner announcing our own deletion on top of it is
     *  worse than a tile that has moved on. */
    const removeThis = async () => {
        const done = await confirmDelete(item, { onStatus: statusLine });
        if (!done) return;
        live.dispose();
        await broadcast();
        const p = { filter: DEFAULT_FILTER };
        if (ctx.wm?.navigate) ctx.wm.navigate('backlog', p, { ctx, dest: 'origin' });
        else ctx.wm?.openInPrimary?.('backlog', p);
    };

    const cancel = async () => {
        try { apply(await fetchItem(id)); statusLine('Reverted unsaved changes.'); }
        catch (err) { statusLine(`Revert failed: ${err?.message || err}`); }
    };

    const saveAcceptance = async () => {
        try {
            apply(await patchItem(item.id, { acceptance: host.querySelector('[data-f="acceptance"]')?.value || '' }));
            await broadcast();
            statusLine('Acceptance criteria saved.');
        } catch (err) { statusLine(`Save failed: ${err?.message || err}`); }
    };

    const moveTo = async (status) => {
        try {
            apply(await patchItem(item.id, { status }));
            await broadcast();
            statusLine(`${itemRef(item)} → ${humanizeItemStatus(item.status)}.`);
        } catch (err) { statusLine(`Transition failed: ${err?.message || err}`); }
    };

    /* ── wiring ─────────────────────────────────────────────────── */

    host.addEventListener('input', (e) => { if (e.target.matches('[data-f]:not([readonly])')) setDirty(true); });
    host.addEventListener('change', (e) => { if (e.target.matches('[data-f]:not([readonly])')) setDirty(true); });

    // Checklist interaction. Delegated, because renderAcceptance replaces the
    // whole list on every change.
    const onCriteriaChange = (e) => {
        const box = e.target.closest('[data-crit-toggle]');
        if (!box) return;
        criteriaOp('toggle', Number(box.dataset.critToggle), box.checked ? '1' : '0');
    };
    host.addEventListener('change', onCriteriaChange);

    /** Turn a criterion into an input in place. Enter or blur commits; Escape
     *  restores. Editing text is rare next to ticking, so it stays out of the
     *  way until asked for rather than living as a permanent input. */
    const editCriterion = (btn, index) => {
        const input = document.createElement('input');
        input.className = 'ea-tin bd-crit-row__edit';
        input.value = btn.textContent.trim();
        let settled = false;
        const commit = (save) => {
            if (settled) return;
            settled = true;
            const text = input.value.trim();
            if (save && text && text !== btn.textContent.trim()) criteriaOp('edit', index, text);
            else renderAcceptance();
        };
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
        btn.replaceWith(input);
        input.focus();
        input.select();
    };

    const onCriteriaKey = (e) => {
        const add = e.target.closest('[data-crit-new]');
        if (!add || e.key !== 'Enter') return;
        e.preventDefault();
        const text = add.value.trim();
        if (!text) return;
        add.value = '';
        criteriaOp('add', -1, text);
    };
    host.addEventListener('keydown', onCriteriaKey);

    const onClick = async (e) => {
        const critEdit = e.target.closest('[data-crit-edit]');
        if (critEdit) { editCriterion(critEdit, Number(critEdit.dataset.critEdit)); return; }
        const critRm = e.target.closest('[data-crit-remove]');
        if (critRm) { await criteriaOp('remove', Number(critRm.dataset.critRemove), ''); return; }

        const goto = e.target.closest('[data-goto]');
        if (goto) {
            const target = ITEMS.find((x) => Number(x.id) === Number(goto.dataset.goto));
            ctx.wm?.openInTabFromContext?.(ctx, 'item',
                { id: goto.dataset.goto, label: itemLabel(target) || `#${goto.dataset.goto}` });
            return;
        }
        const wf = e.target.closest('[data-wf]');
        if (wf && !wf.disabled) { await moveTo(wf.dataset.wf); return; }

        const act = e.target.closest('[data-a]')?.dataset.a;
        if (act === 'delete') { await removeThis(); return; }
        if (act === 'save') await save();
        else if (act === 'cancel') await cancel();
        else if (act === 'save-acceptance') { await saveAcceptance(); acceptanceRaw = false; renderAcceptance(); }
        else if (act === 'acceptance-raw') { acceptanceRaw = true; renderAcceptance(); }
        else if (act === 'acceptance-list') { acceptanceRaw = false; renderAcceptance(); }
        else if (act === 'desc-edit') { descRaw = true; renderDesc(); }
        else if (act === 'desc-cancel') { descRaw = false; renderDesc(); }
        else if (act === 'desc-save') { await saveDescription(); descRaw = false; renderDesc(); }
        else if (act === 'addchild') {
            openNewItem(ctx.wm, {
                kind: childTypesFor(item.type)[0] || 'task',
                parent: item.id, ctx,
            });
        }
        else if (act === 'attachchild') await attachChild();
    };
    host.addEventListener('click', onClick);
    actionsEl?.addEventListener('click', onClick);

    // Same contract as the bug page: silent when clean, a choice when dirty.
    const live = watchRecord({
        host,
        store: 'backlog',
        id: () => item?.id || id,
        // An OPEN COMPOSER is unsaved work too. `dirty` only tracks the
        // frontmatter fields, so a description or a criteria block being typed
        // into would have been silently replaced by an incoming change — the
        // exact loss this banner exists to prevent, in the one place with room
        // for a paragraph of it.
        isDirty: () => dirty || descRaw || acceptanceRaw,
        onStatus: statusLine,
        eventBus: _eventBus,
        onReload: async () => {
            try { apply(await fetchItem(item?.id || id)); }
            catch (err) { statusLine(`Reload failed: ${err?.message || err}`); }
        },
    });

    (async () => {
        try {
            apply(await fetchItem(id));
        } catch (err) {
            host.querySelector('.td-mask').innerHTML =
                `<div class="td-dim">Failed to load item ${esc(String(id))}: ${esc(err?.message || String(err))}</div>`;
        }
    })();

    return {
        title: itemLabel(ITEMS.find((x) => Number(x.id) === id)) || `Item ${id}`,
        destroy: () => {
            live.dispose();
            host.removeEventListener('change', onCriteriaChange);
            host.removeEventListener('keydown', onCriteriaKey);
            destroyWidgets();
        },
    };
}

/* ── the Backlog half of the left rail ───────────────────────────────
 *
 * Three sections:
 *   "Views"       BUILTIN_FILTERS, in store order (that IS the rail order)
 *   "My filters"  the user's own backlog filters, with the same
 *                 Open/Edit/Duplicate/Delete set the bug rail has
 *   "Work packages"  phases → their epics, as a navigable tree
 *                    (TRACKER mode: "Projects" instead — see trackerSection)
 *
 * The bottom section lists only OPEN work packages, and counts only open items
 * inside them. The rail is a place you navigate FROM, and a finished project is
 * not somewhere you are going; a count that includes everything ever closed
 * under it grows without bound and stops meaning anything actionable. Finished
 * work is reachable through the Done view and through search.
 *
 * The third one is the point. A flat list of views tells you what STATE things
 * are in; the backlog's actual shape is phase → epic → story → task, and the
 * rail is where you navigate that shape rather than scroll it. Clicking an epic
 * opens the board scoped to that whole work package — an ad-hoc `epic is
 * EPIC-0001` expression, which is the same thing "Show only this work package"
 * does from the tree's context menu.
 *
 * Exported for pages.js's `mountTicketNav`, which owns the panel and the
 * Bugs/Backlog tab strip — a panel kind can only be registered once, so the two
 * rails are one mount with two bodies rather than two kinds fighting over
 * `panel:left`.
 */

/** One action button, shared by the click handler and the context menu. */
const navAction = (act, glyph, label, danger = false) =>
    `<button type="button" class="td-nav__action${danger ? ' td-nav__action--danger' : ''}"
             data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon(glyph)}</button>`;

/**
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function mountBacklogRail(host, ctx) {
    const open = (p) => ctx.wm?.openInPrimary?.('backlog', p);
    const openFilter = (f) => open({ filter: f.key || f.id, label: f.label });
    const countFor = (expr) => ITEMS.filter(matcherFor(expr)).length;

    /**
     * TRACKER: projects, each with what sits under it.
     *
     * The rail's bottom section is where you navigate the store's actual SHAPE
     * rather than its states, and the shape differs by mode: a backlog is
     * phase → epic, a tracker is project → the work inside it. One section
     * either way — two similar trees, one of them mostly empty, would just make
     * the reader pick.
     *
     * The "No project" bucket is not a tidy-up prompt: a story you were asked
     * for in a corridor legitimately belongs to no project, and it still has to
     * be reachable.
     */
    const projects = () => {
        const list = ITEMS.filter((i) => i.type === 'project' && !isClosedItem(i));
        const loose = ITEMS.filter((i) => !i.projectRef && i.type !== 'project' && !isClosedItem(i));
        return { list, loose };
    };

    /** Epics grouped by their phase, plus a bucket for the unassigned ones.
     *  Phases come from the store's live vocabulary, so a phase whose epics are
     *  all done still lists — you navigate to finished work too. */
    const workPackages = () => {
        const epics = ITEMS.filter((i) => i.type === 'epic' && !isClosedItem(i));
        const groups = new Map(PHASES.map((p) => [p, []]));
        const loose = [];
        for (const e of epics) {
            const phase = e.phaseLabel || '';
            if (!phase) { loose.push(e); continue; }
            if (!groups.has(phase)) groups.set(phase, []);
            groups.get(phase).push(e);
        }
        const out = Array.from(groups.entries()).map(([phase, list]) => ({ phase, epics: list }));
        if (loose.length) out.push({ phase: '', epics: loose });
        return out;
    };

    /**
     * Items in an epic's whole subtree — the number the epic row shows, since
     * "5" next to a work package means five things in it, not five children.
     *
     * OPEN items only, and the tree itself lists only unfinished work packages.
     * The rail is a place you navigate FROM: a finished epic is not somewhere
     * you are going, and a count that includes everything ever closed under it
     * grows without bound and stops meaning anything you can act on. Closed
     * work is reachable through the Done view and through search.
     */
    const subtreeCount = (ref) =>
        ITEMS.filter((i) => i.epicRef === ref && !isClosedItem(i)).length;

    /** The same for a project, and how many of those are late — which is the
     *  number a manager is actually scanning the rail for. */
    const projectCounts = (ref) => {
        const inside = ITEMS.filter((i) => i.projectRef === ref && !isClosedItem(i));
        return { total: inside.length, late: inside.filter((i) => i.dueState === 'overdue').length };
    };

    const filterRow = (f, custom) => {
        const key = custom ? f.id : f.key;
        return `
        <div class="td-nav__item${custom ? ' td-nav__item--custom' : ''}" data-filter="${esc(key)}"
             data-custom="${custom ? '1' : ''}" role="button" tabindex="0"
             title="${esc(describeFilter(f.expr))}">
            ${icon(esc(f.icon || 'filter_alt'))}
            <span>${esc(f.label)}</span>
            <span class="td-nav__actions">
                ${custom ? navAction('edit', 'edit', `Edit filter ${f.label}`) : ''}
                ${navAction('duplicate', 'content_copy', custom ? `Duplicate filter ${f.label}` : `Duplicate ${f.label} as a filter of your own`)}
                ${navAction('copydef', 'notes', `Copy the definition of ${f.label}`)}
                ${custom ? navAction('delete', 'delete', `Delete filter ${f.label}`, true) : ''}
            </span>
            <span class="td-nav__badge">${countFor(f.expr)}</span>
        </div>`;
    };

    const trackerSection = () => {
        const { list, loose } = projects();
        return `
            <div class="td-nav__section">Projects</div>
            ${list.length
                ? list.map((pr) => {
                    const { total, late } = projectCounts(pr.ref);
                    return `
                    <div class="td-nav__item td-nav__item--epic" data-project="${esc(pr.ref)}"
                         role="button" tabindex="0" title="${esc(pr.title)}">
                        ${typeGlyph('project')}
                        <span>${esc(pr.title)}</span>
                        ${late ? `<span class="td-nav__badge td-nav__badge--late"
                                        title="${late} overdue">${late}</span>` : ''}
                        <span class="td-nav__badge">${total}</span>
                    </div>`;
                }).join('')
                : '<div class="td-nav__item"><span class="td-dim">No open projects</span></div>'}
            ${loose.length
                ? `<div class="td-nav__item td-nav__item--phase" data-loose="1" role="button" tabindex="0"
                        title="Work that belongs to no project">
                       ${icon('inbox')}<span>Not in a project</span>
                       <span class="td-nav__badge">${loose.length}</span>
                   </div>`
                : ''}`;
    };
    const render = () => {
        const custom = listFilters();
        const packages = workPackages();
        host.innerHTML = `
        <div class="td-nav">
            <div class="td-nav__section">Views</div>
            ${BUILTIN_FILTERS.map((f) => filterRow(f, false)).join('')}

            <div class="td-nav__section">My filters</div>
            ${custom.length
                ? custom.map((f) => filterRow(f, true)).join('')
                : '<div class="td-nav__item"><span class="td-dim">No backlog filters yet</span></div>'}
            <div class="td-nav__item" data-new="1" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">New filter</span>
            </div>

            ${TRACKER ? trackerSection() : `
            <div class="td-nav__section">Work packages</div>
            ${packages.length
                ? packages.map((g) => `
                    <div class="td-nav__item td-nav__item--phase" data-phase="${esc(g.phase)}"
                         role="button" tabindex="0"
                         title="${g.phase ? `Everything in phase ${esc(g.phase)}` : 'Epics with no phase set'}">
                        ${icon(g.phase ? 'flag' : 'flag_circle')}
                        <span>${esc(g.phase || 'No phase')}</span>
                        <span class="td-nav__badge">${g.epics.length}</span>
                    </div>
                    ${g.epics.map((e) => `
                        <div class="td-nav__item td-nav__item--epic" data-epic="${esc(e.ref)}"
                             role="button" tabindex="0" title="${esc(e.title)}">
                            ${typeGlyph('epic')}
                            <span>${esc(e.title)}</span>
                            <span class="td-nav__badge">${subtreeCount(e.ref)}</span>
                        </div>`).join('')}`).join('')
                : '<div class="td-nav__item"><span class="td-dim">No open work packages</span></div>'}`}
        </div>`;
    };

    render();

    const newFilter = () => openFilterEditor({
        model: MODEL, scope: SCOPE, items: ITEMS,
        rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
        onSaved: openFilter,
    });

    /** The one command table behind both the buttons and the context menu. */
    const runAction = (act, key, custom) => {
        const f = getFilter(key);
        if (!f) { statusLine(`Filter "${key}" no longer exists.`); return; }
        switch (act) {
            case 'open': openFilter(f); break;
            case 'edit':
                // Builtins have no editor path — they are duplicated instead.
                if (custom) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: f, items: ITEMS,
                    rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
                    onSaved: openFilter,
                });
                break;
            case 'duplicate': {
                const draft = duplicateFilter(key);  // id-less draft → editor opens as "New filter"
                if (draft) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: draft, items: ITEMS,
                    rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
                    onSaved: openFilter,
                });
                break;
            }
            case 'copydef': {
                const text = describeFilter(f.expr);
                navigator.clipboard.writeText(text)
                    .then(() => statusLine(`Copied filter definition: ${text}`))
                    .catch((err) => statusLine(`Copy failed: ${err?.message || err}`));
                break;
            }
            case 'delete':
                if (custom && window.confirm(`Delete filter "${f.label}"?`)) deleteFilter(f.id);
                break;
        }
    };

    const activate = (el, target) => {
        if (el.dataset.epic) { open({ expr: epicExpr(el.dataset.epic), label: el.dataset.epic }); return; }
        if (el.dataset.project) { open({ expr: projectExpr(el.dataset.project), label: el.dataset.project }); return; }
        if (el.dataset.loose) {
            open({ expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'project', op: 'is_empty' }] },
                   label: 'Not in a project' });
            return;
        }
        if (el.dataset.phase !== undefined && el.classList.contains('td-nav__item--phase')) {
            const phase = el.dataset.phase;
            open(phase
                ? { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'phase', op: 'is', value: phase }] }, label: phase }
                : { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'phase', op: 'is_empty' }] }, label: 'No phase' });
            return;
        }
        if (el.dataset.new) { newFilter(); return; }
        if (el.dataset.filter) {
            const btn = target?.closest?.('.td-nav__action');
            runAction(btn ? btn.dataset.act : 'open', el.dataset.filter, !!el.dataset.custom);
        }
    };

    const onClick = (e) => {
        const row = e.target.closest('[data-filter],[data-epic],[data-project],[data-loose],[data-phase],[data-new]');
        if (row) activate(row, e.target);
    };
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.td-nav__action')) return;   // native button, already handled
        const row = e.target.closest('[data-filter],[data-epic],[data-project],[data-loose],[data-phase],[data-new]');
        if (!row) return;
        e.preventDefault();
        activate(row, null);
    };
    const onContextMenu = (e) => {
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        e.preventDefault();
        const custom = !!row.dataset.custom;
        showContextMenu(e.clientX, e.clientY, custom
            ? [
                { label: 'Open', icon: 'open_in_new', action: 'open' },
                { label: 'Edit filter…', icon: 'edit', action: 'edit' },
                { label: 'Duplicate', icon: 'content_copy', action: 'duplicate' },
                { label: 'Copy definition', icon: 'notes', action: 'copydef' },
                { separator: true },
                { label: 'Delete filter', icon: 'delete', action: 'delete', danger: true },
            ]
            : [
                { label: 'Open', icon: 'open_in_new', action: 'open' },
                { label: 'Duplicate as a filter of your own', icon: 'content_copy', action: 'duplicate' },
                { label: 'Copy definition', icon: 'notes', action: 'copydef' },
            ],
        (action) => runAction(action, row.dataset.filter, custom));
    };

    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('contextmenu', onContextMenu);

    const unsub = onFiltersChanged(render);
    const sub = _eventBus?.on?.('backlog:changed', () => render());

    return {
        render,
        destroy: () => {
            unsub();
            sub?.dispose?.();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
            host.removeEventListener('contextmenu', onContextMenu);
        },
    };
}

/* ── content map ─────────────────────────────────────────────────── */

/**
 * Build the backlog's `{ kind: factory }` map. Merged by install.js alongside
 * ticketdesk's — the two own disjoint kinds, so order between them does not
 * matter (unlike the page stubs, which these deliberately shadow).
 */
export function createBacklogContent({ eventBus } = {}) {
    _eventBus = eventBus || null;
    return {
        backlog: shell('backlog', mountBacklogBoard),
        item: shell('item', mountItem),
    };
}
