/**
 * ticketdesk/pages.js — BugDesk content kinds for the tiling WM.
 *
 * Registered kinds:
 *   queues         DataTable master list (also the default 'home' leaf);
 *                  rows open bugs as TABS in the tile
 *   ticket         one mask, three modes: edit (default) / new / search
 *   panel:left     filter rail (builtin filters + the user's own)
 *   panel:right    Inspector — TEAM only
 *   panel:bottom   Console (hidden by default)
 *
 * Lifecycle: open → investigation ⇄ testing → closed. `open` is entry-only
 * (nothing returns to it); `closed` only from `testing`.
 *
 * ── FILTER ARCHITECTURE ──────────────────────────────────────────────
 * This file no longer OWNS any filter logic. It used to carry a
 * `QUEUE_FILTERS` map of eight hand-written closures; those closures are
 * now expressions in ./filters.js (BUILTIN_FILTERS), which also holds the
 * user's own filters and persists them through the bridge. pages.js is a
 * pure consumer:
 *
 *   resolveFilter(key)   builtin key OR custom filter id → a view model
 *                        { key, label, icon, expr, builtin, adhoc, match }.
 *                        Unknown / deleted ids fall back to the default — a stale
 *                        tab or a restored layout must never throw.
 *   matcherFor(expr)     compiles the expression into the row predicate.
 *   openFilterEditor()   the modal that authors an expression (filter_editor.js).
 *
 * Three ways a queue view comes into existence:
 *   props.filter = 'open'      a BUILTIN (rail order is BUILTIN_FILTERS order)
 *   props.filter = 'f1a2b3'    a CUSTOM filter id from the store
 *   props.expr   = { ... }     an AD-HOC, unsaved expression (a context-menu
 *                              "filter by this cell"). Nothing persists it;
 *                              the bar offers "Save as filter" to promote it.
 *
 * The store is loaded once at registration and every mount subscribes to
 * onFiltersChanged, so a save/delete in the editor re-renders the rail AND
 * the open queue without a reload.
 */

import { mountTileBreadcrumb } from '../tiling/tile_breadcrumb.js';
import { activeTopNavKind } from '../tiling/kind_taxonomy.js';
import { DataTable } from '../ui/components/data_table.js';
import { showContextMenu } from '../ecoagent/ui/context_menu.js';
import {
    BUILTIN_FILTERS, FILTER_FIELDS, MODEL, SCOPE,
    describeFilter, deleteFilter, duplicateFilter, getFilter,
    listFilters, loadFilters, matcherFor, onFiltersChanged,
} from './filters.js';
import { openFilterEditor } from './filter_editor.js';
import { renderMarkdown } from './markdown.js';
import { attachMarkdownEditor } from './md_editor.js';
import {
    LINK_TYPES, linkTypeDef, formatLink, outgoingLinks, incomingLinks, validateNewLink,
} from './links.js';
import { attachTagInput } from './tag_input.js';
import {
    esc, STAGES, TICKETS, TEAM, HUMAN_AUTHOR, AGENT_AUTHOR, assigneeOptions,
    fetchBug, patchBug, postComment, createBug, loadData, initials,
    machineStatus, machineType, typeCode, typeLabelOf, humanizeStatus,
} from './data.js';

/* Descriptions and comments render through the shared renderer in
 * ./markdown.js — tables, images, task lists and code fences included. */
const md = renderMarkdown;

/** Tab / tile-chrome label for a bug: the id alone identifies it, but "#44"
 *  tells you nothing about which bug you left open in that tile. */
const ticketLabel = (t) => (t?.summary ? `${t.id} — ${t.summary}` : (t?.id || 'Bug'));

let _eventBus = null;

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;
const loadClass = (l) => l < 0.6 ? 'low' : l < 0.85 ? 'mid' : 'high';

/** The one status line, in the bottom bar. Exported because the backlog pages
 *  report through the same strip — two "where did that message go" surfaces
 *  would be one too many. */
export function statusLine(msg) {
    const el = document.getElementById('sim-status');
    if (el) el.textContent = msg;
}

/** Wrap a mount function in the standard page shell: breadcrumb on top,
 *  content below, plus an ACTIONS slot floating over the breadcrumb row.
 *
 *  The actions slot is a sibling of the content, not a child of it, on
 *  purpose: both `.twm-page-shell__content` and `.td-page` clip and scroll
 *  their overflow, so a bar rendered inside the page could never reach up
 *  over the breadcrumb strip. Pages that want it (the ticket mask's
 *  Save/Cancel) render into `ctx.pageActions`; the rest leave it empty and
 *  it stays click-through. */
export function shell(kind, mountFn) {
    return (host, props, ctx) => {
        host.classList.add('twm-page-shell', 'td-shell');
        host.innerHTML = '';
        const breadcrumbSlot = document.createElement('div');
        breadcrumbSlot.className = 'twm-page-shell__breadcrumb';
        const actionsSlot = document.createElement('div');
        actionsSlot.className = 'td-shell__actions';
        const contentSlot = document.createElement('div');
        contentSlot.className = 'twm-page-shell__content';
        contentSlot.tabIndex = -1;
        host.appendChild(breadcrumbSlot);
        host.appendChild(actionsSlot);
        host.appendChild(contentSlot);
        let crumb = null;
        try {
            crumb = mountTileBreadcrumb(kind, props, { ...ctx, eventBus: _eventBus });
            breadcrumbSlot.appendChild(crumb.el);
        } catch (err) { console.warn('[bugdesk] breadcrumb failed', err); }
        const ret = mountFn(contentSlot, props, { ...ctx, pageActions: actionsSlot }) || {};
        return {
            title: ret.title,
            destroy: () => { try { crumb?.destroy?.(); } catch {} ret.destroy?.(); },
        };
    };
}

/* ── filter plumbing (thin adapter over ./filters.js) ────────────────
 *
 * Everything below is view-model glue: resolve a routing key to something
 * renderable, count it, and translate between the DataTable's column world
 * and the filter model's field world. No matching logic lives here. */

// The queue you land on excludes closed bugs — finished work should not be in
// the way of the work in front of you. "All Bugs" is one click away in the rail.
const DEFAULT_FILTER = 'active';

const clone = (v) => JSON.parse(JSON.stringify(v));
const clause = (field, op, value) => ({ kind: 'clause', field, op, value });
const andGroup = (children) => ({ kind: 'group', op: 'AND', children });
const fieldDef = (key) => FILTER_FIELDS.find((f) => f.key === key);
const isEmptyGroup = (e) => !e || (e.kind === 'group' && !(e.children || []).length);

/** Builtin key OR custom filter id → the queue's view model. An unknown id
 *  (deleted filter, stale restored tab) degrades to the default filter instead of
 *  throwing — a layout restore must never be able to break the page. */
function resolveFilter(key) {
    const f = getFilter(key) || getFilter(DEFAULT_FILTER);
    return {
        key: f.key || f.id,
        label: f.label,
        icon: f.icon || 'filter_alt',
        expr: f.expr,
        builtin: !!f.builtin,
        adhoc: false,
        match: matcherFor(f.expr),
    };
}

/** An unsaved expression (context-menu "filter by this cell") dressed up as
 *  a view model. It has no key, so nothing tries to look it up in the store. */
function adhocFilter(expr) {
    return {
        key: null, label: 'Ad-hoc filter', icon: 'filter_alt',
        expr, builtin: false, adhoc: true, match: matcherFor(expr),
    };
}

const countFor = (expr) => TICKETS.filter(matcherFor(expr)).length;

/** Copy to the clipboard and SAY so on the status line — including the
 *  failure, which is real (a denied permission silently copying nothing is
 *  exactly the kind of masked failure this project forbids). */
async function copyText(text, okMsg) {
    try {
        await navigator.clipboard.writeText(text);
        statusLine(okMsg);
    } catch (err) {
        statusLine(`Copy failed: ${err?.message || err}`);
    }
}

/* ── queue columns ───────────────────────────────────────────────────
 *
 * The single source of truth for the queue table's shape: header, the row
 * value, and the FILTER_FIELDS key the column maps onto. `toFilterValue`
 * converts the DISPLAYED value back to the COMPARABLE one — Status shows
 * "Investigation" but the `status` field compares the raw machine status. */
const QUEUE_COLUMNS = [
    { header: 'Pri',      field: 'pri',       cell: (t) => t.pri,       toFilterValue: (v) => v },
    { header: 'Bug',      field: 'id',        cell: (t) => t.id,        toFilterValue: (v) => v },
    { header: 'Type',     field: 'type',      cell: (t) => t.type,      toFilterValue: (v) => v },
    // `cellFilter: false` — "Filter by Summary ‘<the whole title>’" can only
    // ever match the one bug you right-clicked, so the menu omits it there.
    { header: 'Summary',  field: 'summary',   cell: (t) => t.summary,   toFilterValue: (v) => v, cellFilter: false },
    { header: 'Status',   field: 'status',    cell: (t) => t.status,    toFilterValue: (v) => machineStatus(v) },
    { header: 'Updated',  field: 'updated',   cell: (t) => t.sla,       toFilterValue: (v) => v },
    { header: 'Assignee', field: 'assignee',  cell: (t) => t.assignee,  toFilterValue: (v) => v },
];
const QUEUE_HEADERS = QUEUE_COLUMNS.map((c) => c.header);
const queueRow = (t) => QUEUE_COLUMNS.map((c) => c.cell(t));
/* The column every "act on this bug" command reads — derived, so reordering
   QUEUE_COLUMNS moves the row click, the menu and the seeding together. */
const QUEUE_ID_COL = QUEUE_COLUMNS.findIndex((c) => c.field === 'id');

/** Enum options may be plain strings or {value|id,label} — both are legal
 *  in FILTER_FIELDS, so normalise before comparing. */
const optionValues = (def) => (def.options || [])
    .map((o) => (typeof o === 'string' ? o : (o.value ?? o.id ?? '')))
    .filter(Boolean);

/**
 * Translate ONE per-column DataTable filter box into a filter clause.
 *
 * The column filter is free text with DataTable's own numeric mini-syntax
 * (`>3`, `1..2`, `!=4`); the filter model wants typed operators. Returns
 * null when the text cannot be expressed honestly for that field type
 * (e.g. "las" typed into the Updated date column) — the caller REPORTS the
 * dropped ones rather than pretending they were folded in.
 */
function clauseFromColumnFilter(fieldKey, text) {
    const def = fieldDef(fieldKey);
    const s = String(text ?? '').trim();
    if (!def || !s) return null;

    if (def.type === 'number') {
        const range = s.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
        if (range) return clause(fieldKey, 'between', [range[1], range[2]]);
        const cmp = s.match(/^(>=|<=|!=|>|<|=)\s*(-?[\d.]+)$/);
        if (cmp) {
            const op = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte', '!=': 'is_not', '=': 'is' }[cmp[1]];
            return clause(fieldKey, op, cmp[2]);
        }
        return /^-?[\d.]+$/.test(s) ? clause(fieldKey, 'is', s) : null;
    }
    if (def.type === 'date') {
        // Only a full ISO day is expressible; the date operators have no
        // substring form to fall back on.
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? clause(fieldKey, 'is', s) : null;
    }
    if (def.type === 'enum') {
        // enum has no `contains`, so a partial match widens into `one_of`
        // over the options that contain the typed text — same rows the
        // column box was showing.
        const opts = optionValues(def);
        const exact = opts.find((o) => o.toLowerCase() === s.toLowerCase());
        if (exact) return clause(fieldKey, 'is', exact);
        const near = opts.filter((o) => o.toLowerCase().includes(s.toLowerCase()));
        return near.length ? clause(fieldKey, 'one_of', near) : null;
    }
    return clause(fieldKey, 'contains', s); // text + set
}

/**
 * Seed a NEW filter expression from what the user is looking at RIGHT NOW.
 *
 *   selection wins → `id one_of [#12, #13]` (an explicit pick beats a query)
 *   otherwise      → the active filter's expression AND every per-column
 *                    filter box that can be translated.
 *
 * Returns { expr, skipped } — `skipped` names the column boxes that had no
 * faithful clause so the caller can say so out loud.
 *
 * NOTE: `table._state.filters` is DataTable-private (a Map colIdx→text).
 * There is no public accessor for the live filter row — `_saveState()`
 * serialises the same Map — so this reads it directly and is the one place
 * that knows the field is private.
 */
function seedExprFromQueue(table, resolved) {
    const skipped = [];
    const rows = table.config.rows || [];
    const selection = table.getSelection();
    if (selection.length) {
        const ids = selection.map((i) => rows[i]?.[QUEUE_ID_COL]).filter(Boolean);
        if (ids.length) return { expr: andGroup([clause('id', 'one_of', ids)]), skipped };
    }

    const children = [];
    // The active expression goes in as ONE child, not spread: an OR filter
    // spread into an AND root would change its meaning.
    if (!isEmptyGroup(resolved.expr)) children.push(clone(resolved.expr));
    for (const [colIdx, text] of table._state.filters) {
        const col = QUEUE_COLUMNS[colIdx];
        if (!col || !String(text ?? '').trim()) continue;
        const c = clauseFromColumnFilter(col.field, text);
        if (c) children.push(c);
        else skipped.push(`${col.header} "${text}"`);
    }
    return { expr: andGroup(children), skipped };
}

function mountQueues(host, props, ctx) {
    // props.expr (ad-hoc, unsaved) beats props.filter (a stored key/id).
    let resolved = props?.expr ? adhocFilter(props.expr) : resolveFilter(props?.filter);

    // New Bug sits HERE, beside Save as filter, mirroring the backlog board's
    // Epic/Story/Task group: filing belongs next to the list the new record
    // will appear in. The top bar carries the cross-store "New item" dialog
    // instead — this button opens the full bug mask, which is richer (markdown
    // editor, link staging) and is the reason it is a page and not a dialog.
    host.innerHTML = `
    <div class="td-page">
        <div class="td-page__bar">
            <span class="td-page__title" data-slot="title">${icon(esc(resolved.icon))} ${esc(resolved.label)}</span>
            <span class="td-dim" data-slot="subtitle">${resolved.adhoc
                ? esc(describeFilter(resolved.expr))
                : 'Ctrl+K quick-searches bugs'}</span>
            <span class="td-spacer"></span>
            <button class="ea-btn" data-a="savefilter">${icon('filter_alt')} Save as filter</button>
            <span class="bd-newgroup">
                <span class="td-dim">New</span>
                <button class="ea-btn" data-a="newbug"
                        title="File a new bug">${icon('bug_report')} Bug</button>
            </span>
        </div>
        <div class="td-tablehost"></div>
    </div>`;

    /* ── navigation helpers ─────────────────────────────────────── */

    const openTicket = (id, opts) => {
        // Carry the queue's active filter so the ticket's breadcrumb can route
        // back to the SAME filtered view (e.g. "needs my reply"), not the default.
        // The tab/tile label carries the summary too — a strip of "#41 #44
        // #52" says nothing about which bug is where. `_tabTitle` reads
        // props.label, so the name has to be right at OPEN time.
        const p = { id, label: ticketLabel(TICKETS.find((x) => x.id === id)) || id,
                    filter: resolved.key || DEFAULT_FILTER };
        if (ctx.wm?.navigate) ctx.wm.navigate('ticket', p, { ctx, ...opts });
        else ctx.wm?.openInTabFromContext?.(ctx, 'ticket', p);
    };
    const openQueue = (p) => {
        if (ctx.wm?.navigate) ctx.wm.navigate('queues', p, { ctx, dest: 'origin' });
        else ctx.wm?.openInPrimary?.('queues', p);
    };
    const openSavedFilter = (f) => openQueue({ filter: f.id, label: f.label });

    /* ── right-click menu ───────────────────────────────────────── */

    /** Bug ids the menu acts on: the whole selection (the right-clicked row
     *  is selected by DataTable before the ctx is built), else nothing. */
    const menuIds = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
        .map((r) => r?.[QUEUE_ID_COL]).filter(Boolean);

    /** The clicked CELL as a filter clause, or null when the column does not
     *  map to a field or the cell is empty. */
    const cellClause = (cm) => {
        const col = cm.colIdx == null ? null : QUEUE_COLUMNS[cm.colIdx];
        if (!col || col.cellFilter === false || cm.value == null) return null;
        const value = col.toFilterValue(cm.value);
        if (value === '' || value == null) return null;
        return { col, value, clause: clause(col.field, 'is', value) };
    };

    const contextMenuItems = (cm) => {
        const n = menuIds(cm).length;
        const cc = cellClause(cm);
        const fieldLabel = cc ? (fieldDef(cc.col.field)?.label || cc.col.header) : '';
        return [
            { label: n > 1 ? `Open ${n} bugs in tabs` : 'Open', icon: 'open_in_new', action: 'open', disabled: !n },
            { label: 'Open in new tab', icon: 'tab', action: 'open-tab', disabled: !n },
            { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !cm.row },
            { label: 'Open in split right', icon: 'splitscreen_vertical_add', action: 'open-split-h', disabled: !cm.row },
            // `splitscreen_add`, not `splitscreen_horizontal_add`: the latter
            // is absent from the vendored icon font, and Material Symbols
            // prints an unknown ligature as its literal name.
            { label: 'Open in split below', icon: 'splitscreen_add', action: 'open-split-v', disabled: !cm.row },
            { separator: true },
            { label: n > 1 ? `Copy ${n} bug IDs` : 'Copy bug ID', icon: 'content_copy', action: 'copy-id', disabled: !n },
            { separator: true },
            // Greyed out rather than hidden, so the menu keeps a stable shape
            // whichever cell the user happened to hit.
            { label: cc ? `Filter by ${fieldLabel} “${cc.value}”` : 'Filter by this cell',
              icon: 'filter_alt', action: 'filter-cell', disabled: !cc },
            { label: 'Save as filter…', icon: 'bookmark_add', action: 'filter-cell-save', disabled: !cc },
        ];
    };

    const onContextMenuAction = (action, cm) => {
        const ids = menuIds(cm);
        const one = cm.row?.[QUEUE_ID_COL] || ids[0];
        const cc = cellClause(cm);
        switch (action) {
            // A queue row ALWAYS opens as a tab (that is what a row click
            // does), so "Open" and "Open in new tab" are the same journey —
            // one tab per selected bug. They share the branch rather than
            // pretending to differ.
            case 'open':
            case 'open-tab':
                ids.forEach((id) => openTicket(id, { dest: 'origin', newTab: true }));
                break;
            case 'open-window': if (one) openTicket(one, { dest: 'window' }); break;
            case 'open-split-h': if (one) openTicket(one, { dest: 'split-h' }); break;
            case 'open-split-v': if (one) openTicket(one, { dest: 'split-v' }); break;
            case 'copy-id':
                if (ids.length) copyText(ids.join('\n'),
                    `Copied ${ids.length} bug ID${ids.length === 1 ? '' : 's'}.`);
                break;
            case 'filter-cell': {
                if (!cc) break;
                const expr = andGroup([cc.clause]);
                openQueue({ expr, label: describeFilter(expr) });
                break;
            }
            case 'filter-cell-save':
                if (cc) openFilterEditor({
                    model: MODEL, scope: SCOPE,
                    seedExpr: andGroup([cc.clause]), items: TICKETS,
                    onSaved: openSavedFilter,
                });
                break;
        }
    };

    /* ── the table ──────────────────────────────────────────────── */

    const table = new DataTable(host.querySelector('.td-tablehost'), {
        headers: QUEUE_HEADERS,
        rows: TICKETS.filter(resolved.match).map(queueRow),
        pagination: false,
        selectable: true,
        copyable: true,
        sortable: true,
        filterable: true,
        mode: 'compact',
        emptyMessage: 'No bugs in this filter',
        services: { eventBus: _eventBus },
        contextMenuItems,
        onContextMenuAction,
        renderCell: (td, value, colIdx, rowIdx, row) => {
            if (colIdx === 0) {
                td.innerHTML = `<span class="td-pri-cell"><span class="td-pri td-pri--${value}" title="Priority ${value}"></span><span class="td-dim">P${value}</span></span>`;
                return true;
            }
            if (colIdx === 1) { td.innerHTML = `<span class="td-mono td-link">${esc(value)}</span>`; return true; }
            if (colIdx === 2) { td.innerHTML = `<span class="td-chip">${esc(value)}</span>`; return true; }
            return false;
        },
        onRowClick: (rowIdx, row, ev) => {
            if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
            openTicket(row[QUEUE_ID_COL], { dest: 'origin', newTab: true });
        },
    });
    // Priority is a short-badge column (an 8px swatch + "P3"), so pin it
    // narrow. colWidths overrides are honored verbatim by the fit pass
    // (never grown to fill), and _restorePersisted stamps the column
    // signature so the width survives the first render. Column 0 = Pri
    // (showRowNumbers is off, so there is no leading row-number column).
    table._restorePersisted?.({ colWidths: { 0: 48 } });
    table.render();
    requestAnimationFrame(() => { if (host.isConnected) table.focus(); });

    host.querySelector('[data-a="newbug"]').addEventListener('click', () => {
        ctx.wm?.openInPrimary?.('ticket', { mode: 'new', label: 'New Bug' });
    });

    host.querySelector('[data-a="savefilter"]').addEventListener('click', () => {
        const { expr, skipped } = seedExprFromQueue(table, resolved);
        if (skipped.length)
            statusLine(`Save as filter: column filter${skipped.length === 1 ? '' : 's'} ${skipped.join(', ')} could not be expressed and ${skipped.length === 1 ? 'was' : 'were'} left out.`);
        openFilterEditor({ model: MODEL, scope: SCOPE, seedExpr: expr, items: TICKETS, onSaved: openSavedFilter });
    });

    // A save/delete in the editor changes what this view means (or deletes
    // it outright — resolveFilter then lands on 'all'). Ad-hoc views own
    // their expression, so nothing in the store can move them.
    const unsub = onFiltersChanged(() => {
        if (resolved.adhoc) return;
        resolved = resolveFilter(resolved.key);
        const titleEl = host.querySelector('[data-slot="title"]');
        if (titleEl) titleEl.innerHTML = `${icon(esc(resolved.icon))} ${esc(resolved.label)}`;
        table.setData({ rows: TICKETS.filter(resolved.match).map(queueRow) });
    });

    // DataTable's teardown is dispose() — it removes the body-level context
    // menu and its four global listeners, the tbody handlers and the
    // ResizeObserver. Call it unconditionally: `table` is always a live
    // DataTable here, so an optional call would only hide a future rename,
    // which is precisely how this leaked every queue mount before.
    return { title: resolved.label, destroy: () => { unsub(); table.dispose(); } };
}

/* ── ticket mask (edit / new / search) ──────────────────────────── */

/** Lifecycle stage actions. Index === state.stage (0..3). Each button
 *  carries the target status the action moves the bug to.
 *   0 open        → start investigation (one-way out of open)
 *   1 investigation → hand to testing
 *   2 testing     → back to investigation OR close
 *   3 closed      → reopen (to investigation) */
const STAGE_ACTIONS = [
    [['Start investigation', 'investigation']],                                  // open
    [['Hand to testing', 'testing']],                                            // investigation
    [['Back to investigation', 'investigation'], ['Close', 'closed']],           // testing
    [['Reopen', 'investigation']],                                               // closed
];
const STAGE_STATUS = ['Open', 'Investigation', 'Testing', 'Closed'];
const SEV_PRI = { crash: 1, high: 2, medium: 3, low: 4 };

function maskSections(t, mode) {
    const search = mode === 'search';
    const field = (label, ctrl, req) =>
        `<div class="td-field"><label class="${req && !search ? 'td-req' : ''}">${label}</label>${ctrl}</div>`;
    const sel = (id, opts, cur) => `<select class="ea-tin" data-f="${id}">
        ${search ? '<option selected>(any)</option>' : ''}
        ${opts.map((o) => `<option ${!search && o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const tin = (id, val, cls = '') =>
        `<input class="ea-tin ${cls}" data-f="${id}" value="${esc(search ? '' : (val ?? ''))}">`;
    // Status: a filter in search mode; read-only in edit/new (the lifecycle
    // stage buttons drive it, and assignee is derived from it server-side).
    const statusCtrl = search
        ? sel('status', STAGE_STATUS, t.status)
        : `<input class="ea-tin td-mono" data-f="status" value="${esc(t.status)}" readonly>`;
    return `
    <section class="td-group">
        <div class="td-group__title">Bug Record</div>
        <div class="td-group__body td-grid2">
            ${mode === 'edit'
                ? field('Bug ID', `<input class="ea-tin td-mono" value="${esc(t.id)}" readonly>`)
                : (mode === 'new'
                    ? field('Bug ID', `<input class="ea-tin td-mono" value="(assigned on create)" readonly>`)
                    : '')}
            ${field('Status', statusCtrl)}
            <div class="td-field td-span2"><label class="${search ? '' : 'td-req'}">Title</label>${tin('summary', t.summary)}</div>
            ${field('Type', sel('type', ['Bug', 'Regression', 'Chore'], typeLabelOf(t.type)), true)}
            ${field('Severity', sel('severity', ['crash', 'high', 'medium', 'low'], t.severity || 'medium'), true)}
            ${field('Subsystem', tin('subsystem', t.subsystem))}
            ${mode === 'search' ? '' : field('Assignee', `<div class="td-assignee">${sel('assignee', assigneeOptions(), t.assignee || HUMAN_AUTHOR)}<button type="button" class="ea-btn td-reassign" data-a="reassign" title="Reassign this bug">${icon('person_search')}</button></div>`)}
            <div class="td-field td-span2"><label>Labels</label>${tin('labels', (t.labels || []).join(', '))}</div>
            ${mode === 'edit' ? field('Created', `<input class="ea-tin td-mono" value="${esc(t.created || '—')}" readonly>`) : ''}
            ${mode === 'edit' ? field('Updated', `<input class="ea-tin td-mono" data-f="updated" value="${esc(t.sla || '—')}" readonly>`) : ''}
        </div>
    </section>
    ${mode !== 'search' ? `
    <section class="td-group">
        <div class="td-group__title">Links</div>
        <div class="td-group__body">
            <div data-slot="links"><span class="td-dim">Loading…</span></div>
            <div class="td-linkadd">
                <select class="ea-tin td-linkadd__type" data-f="linktype">
                    ${LINK_TYPES.map((d) => `<option value="${esc(d.type)}">${esc(d.label)}</option>`).join('')}
                </select>
                <input class="ea-tin td-mono td-linkadd__target" data-f="linktarget"
                       list="td-linktargets" placeholder="#id or title…">
                <datalist id="td-linktargets">
                    ${TICKETS.filter((x) => x.bugId && x.bugId !== t.bugId)
                        .map((x) => `<option value="#${x.bugId}">${esc(x.summary || '')}</option>`).join('')}
                </datalist>
                <button class="ea-btn" data-a="addlink">${icon('add_link')} Link</button>
            </div>
        </div>
    </section>` : ''}
    <section class="td-group">
        <div class="td-group__title">${search ? 'Full-text' : 'Description'}</div>
        <div class="td-group__body">
            ${mode === 'edit'
                ? `<div class="td-md" data-slot="desc"><span class="td-dim">Loading…</span></div>`
                : `<textarea class="ea-tin td-area" rows="${search ? 2 : 4}" data-f="desc" placeholder="${search ? 'Search in bug titles…' : ''}"></textarea>`}
        </div>
    </section>`;
}

function mountTicket(host, props, ctx) {
    const mode = props?.mode === 'new' ? 'new' : props?.mode === 'search' ? 'search' : 'edit';
    const t = mode === 'edit'
        ? (TICKETS.find((x) => x.id === props?.id) || TICKETS[0])
        : { id: '', bugId: null, pri: 3, type: 'BUG', summary: '', status: 'Open', rawStatus: 'open',
            sla: '', assignee: HUMAN_AUTHOR, subsystem: '', severity: 'medium', labels: [], links: [] };

    if (mode === 'edit' && !t) {
        host.innerHTML = `<div class="tile-placeholder"><div class="tile-placeholder__title">No bug</div>
            <div class="tile-placeholder__hint">no bug matched ${esc(props?.id || '')}</div></div>`;
        return { title: 'Bug' };
    }
    const state = { stage: t.stage ?? 0, dirty: false };

    const banner = mode === 'new'
        ? `<div class="td-banner">${icon('add_circle')} <b>New Bug</b> — fill in the mask and Create. The bug ID is assigned automatically on save.</div>`
        : mode === 'search'
        ? `<div class="td-banner">${icon('search')} <b>Bug Search</b> — enter criteria into the mask, empty fields are ignored. Results open as tabs.</div>`
        : '';

    host.innerHTML = `
    <div class="td-page td-ticket">
        ${banner}
        ${mode === 'edit' ? `
        <div class="td-stagebar">
            <ol class="td-stages">${STAGES.map((s, i) =>
                `<li class="td-stage" data-stage="${i}"><span class="td-stage__num">${i + 1}</span> ${s}</li>`).join('')}
            </ol>
        </div>
        <div class="td-stageactions">
            <span class="td-stageactions__title">${icon('bolt')} Actions</span>
            <span data-slot="stageactions"></span>
        </div>` : ''}
        <div class="td-mask">${maskSections(t, mode)}
            ${mode === 'edit' ? `
            <section class="td-group">
                <div class="td-group__title">Comments <span class="td-dim">— posted as ${esc(HUMAN_AUTHOR)}</span></div>
                <div class="td-group__body" data-slot="comments"></div>
            </section>` : ''}
            <div data-slot="results"></div>
        </div>
        ${mode === 'edit' ? '' : `
        <div class="td-actionbar">
            ${mode === 'new' ? `
                <button class="ea-btn ea-btn--primary" data-a="create">${icon('add')} Create Bug</button>
                <button class="ea-btn" data-a="reset">Reset</button>
                <span class="td-spacer"></span>
                <button class="ea-btn" data-a="gosearch">${icon('search')} Search bugs</button>`
            : `
                <button class="ea-btn ea-btn--primary" data-a="dosearch">${icon('search')} Search</button>
                <button class="ea-btn" data-a="reset">Reset</button>`}
        </div>`}
    </div>`;

    // Save/Cancel live in the shell's floating actions slot — over the
    // breadcrumb strip, outside the mask's scroll region (see `shell()`).
    // They stay reachable through `$` and the action dispatcher below, so
    // nothing else in this mount has to know where they ended up.
    const actionsEl = mode === 'edit' ? (ctx?.pageActions || null) : null;
    if (actionsEl) {
        actionsEl.innerHTML = `
            <div class="td-floatactions">
                <button class="ea-btn" data-a="cancel" disabled>${icon('undo')} Cancel</button>
                <button class="ea-btn ea-btn--primary" data-a="save" disabled>${icon('save')} Save</button>
            </div>`;
    }

    const $ = (s) => host.querySelector(s) || actionsEl?.querySelector(s) || null;
    const $$ = (s) => Array.from(host.querySelectorAll(s));
    const fval = (id) => host.querySelector(`[data-f="${id}"]`)?.value?.trim() || '';
    const setV = (id, val) => {
        const el = host.querySelector(`[data-f="${id}"]`);
        if (!el) return;
        el.value = val;
        // Labels render as pills over a hidden carrier input, so writing the
        // carrier is only half the update — repaint the pills too.
        if (id === 'labels') tagInput?.setTags(String(val || '').split(','));
    };

    const setDirty = (on) => {
        state.dirty = on;
        const a = $('[data-a="save"]'), c = $('[data-a="cancel"]');
        if (a) a.disabled = !on;
        if (c) c.disabled = !on;
    };
    host.addEventListener('input', (e) => { if (e.target.matches('[data-f]')) setDirty(true); });
    // Selects (status/type/severity/assignee) mark dirty on change too.
    host.addEventListener('change', (e) => { if (e.target.matches('[data-f]')) setDirty(true); });
    // The reassign affordance opens the assignee picker.
    host.addEventListener('click', (e) => {
        if (!e.target.closest('[data-a="reassign"]')) return;
        const s = $('[data-f="assignee"]');
        if (s) { s.focus(); try { s.showPicker?.(); } catch { /* not supported */ } }
    });

    /* ── links ─────────────────────────────────────────────────────────────
       Shared by NEW and EDIT. Outgoing links are this bug's own and removable
       here; incoming ones are stored on the OTHER bug (see links.js: only the
       authored direction is ever written) so they show read-only with a note
       saying where they live.

       In `new` mode there is no bug to patch yet, so links are staged on the
       draft and written by Create — you should be able to say "this duplicates
       #52" while filing, not only afterwards. */
    const linkRow = (rel, id, ownToken) => {
        const target = TICKETS.find((x) => x.bugId === id);
        return `<div class="td-linkrow">
            <span class="td-linkrow__rel">${esc(rel)}</span>
            <button type="button" class="td-mono td-link" data-goto="${id}">#${id}</button>
            <span class="td-linkrow__title">${esc(target?.summary || '(no such bug)')}</span>
            ${ownToken
                ? `<button type="button" class="ea-btn ea-btn--small" data-unlink="${esc(ownToken)}"
                       title="Remove this link">${icon('link_off')}</button>`
                : `<span class="td-dim" title="Stored on #${id} — remove it there">from #${id}</span>`}
        </div>`;
    };

    const renderLinks = () => {
        const el = $('[data-slot="links"]');
        if (!el) return;
        const own = outgoingLinks(t);
        // A draft has no id, so nothing can point at it yet.
        const inbound = mode === 'new' ? [] : incomingLinks(t, TICKETS);
        el.innerHTML = (own.length || inbound.length)
            ? own.map((l) => linkRow(linkTypeDef(l.type)?.label || l.type, l.id, formatLink(l.type, l.id))).join('')
                + inbound.map((l) => linkRow(l.label, l.id, null)).join('')
            : `<div class="td-dim">${mode === 'new' ? 'No links yet — they are saved with the bug.' : 'No links.'}</div>`;
    };

    const commitLinks = async (next) => {
        if (mode === 'new') {
            // Staged on the draft; Create writes them with the bug.
            t.links = next;
            renderLinks();
            return;
        }
        if (!t.bugId) { statusLine('Local bug — cannot link.'); return; }
        try {
            const bug = await patchBug(t.bugId, { links: next });
            t.links = Array.isArray(bug.links) ? bug.links : next;
            // Keep the shared store in step so the other bug derives its inverse.
            const stored = TICKETS.find((x) => x.bugId === t.bugId);
            if (stored) stored.links = t.links;
            renderLinks();
            statusLine('Links updated.');
        } catch (err) {
            statusLine('Link update failed: ' + (err?.message || err));
        }
    };

    host.addEventListener('click', async (e) => {
        const goto = e.target.closest('[data-goto]');
        if (goto) {
            const id = Number(goto.dataset.goto);
            const target = TICKETS.find((x) => x.bugId === id);
            if (target) {
                ctx.wm?.openInTabFromContext?.(ctx, 'ticket',
                    { id: `#${id}`, label: ticketLabel(target) || `#${id}` });
            }
            return;
        }
        const rm = e.target.closest('[data-unlink]');
        if (rm) {
            await commitLinks((t.links || []).filter((x) => String(x).trim() !== rm.dataset.unlink));
            return;
        }
        if (e.target.closest('[data-a="addlink"]')) {
            const type = $('[data-f="linktype"]')?.value;
            const raw = ($('[data-f="linktarget"]')?.value || '').trim();
            const id = Number(raw.replace(/^#/, ''));
            const problem = validateNewLink(t, type, id);
            if (problem) { statusLine(problem); return; }
            if (!TICKETS.some((x) => x.bugId === id)) { statusLine(`No bug #${id}.`); return; }
            await commitLinks([...(t.links || []), formatLink(type, id)]);
            const field = $('[data-f="linktarget"]');
            if (field) field.value = '';
        }
    });

    /* Labels become removable pills with autocomplete over the vocabulary
     * already in the store — see tag_input.js for why that matters. Search
     * mode keeps the plain box: there, a label is a substring to match, not
     * a set to build. */
    let tagInput = null;
    if (mode !== 'search') {
        const labelsEl = host.querySelector('[data-f="labels"]');
        if (labelsEl) {
            tagInput = attachTagInput(labelsEl, {
                suggestions: Array.from(new Set(TICKETS.flatMap((x) => x.labels || []))).sort(),
            });
        }
    }

    /* The description box in NEW mode gets the full markdown editor. In edit
     * mode the description is rendered, not edited — changing it is a store
     * concern the mask does not own yet. */
    let descEditor = null;
    if (mode === 'new') {
        const descEl = host.querySelector('[data-f="desc"]');
        // The description is where you actually write, so it opens at a usable
        // size instead of one line — the comment composer keeps growing from small.
        if (descEl) descEditor = attachMarkdownEditor(descEl, { onStatus: statusLine, minHeight: 200 });
    }

    /** Every sub-widget this mount owns, torn down together. */
    const destroyWidgets = () => {
        try { tagInput?.destroy(); } catch { /* already gone */ }
        try { descEditor?.destroy(); } catch { /* already gone */ }
    };

    /* mode: search — local filter over the fetched TICKETS store */
    if (mode === 'search') {
        const resultsEl = $('[data-slot="results"]');
        // The results table is rebuilt on every search. DataTable appends a
        // context-menu node to document.body and registers four global
        // listeners, so dropping the old instance on the floor (its DOM goes
        // with resultsEl.innerHTML, its listeners do not) leaks one set per
        // search. Keep the handle and dispose it before each replacement.
        let resultsTable = null;
        const disposeResults = () => {
            resultsTable?.dispose();
            resultsTable = null;
        };
        const doSearch = () => {
            const text = (fval('summary') + ' ' + fval('desc')).trim().toLowerCase();
            const status = fval('status'), type = fval('type'), subsystem = fval('subsystem').toLowerCase();
            const matches = TICKETS.filter((tk) => {
                if (text && !tk.summary.toLowerCase().includes(text)) return false;
                if (subsystem && !String(tk.subsystem || '').toLowerCase().includes(subsystem)) return false;
                if (status && status !== '(any)' && tk.status !== status) return false;
                if (type && type !== '(any)' && typeLabelOf(tk.type) !== type) return false;
                return true;
            });
            disposeResults();
            resultsEl.innerHTML = `<section class="td-group"><div class="td-group__title">Results — ${matches.length} bug${matches.length === 1 ? '' : 's'}</div><div class="td-tablehost"></div></section>`;
            // Bug id is column 0 here (no Pri column), so the menu's row →
            // id mapping differs from the queue's; the two share nothing but
            // the idea.
            const resultIds = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
                .map((r) => r?.[0]).filter(Boolean);
            const openResult = (id, opts) => {
                const p = { id, label: id };
                if (ctx.wm?.navigate) ctx.wm.navigate('ticket', p, { ctx, ...opts });
                else ctx.wm?.openInTabFromContext?.(ctx, 'ticket', p);
            };
            resultsTable = new DataTable(resultsEl.querySelector('.td-tablehost'), {
                headers: ['Bug', 'Type', 'Summary', 'Status', 'Updated', 'Assignee'],
                rows: matches.map((m) => [m.id, m.type, m.summary, m.status, m.sla, m.assignee]),
                pagination: false, selectable: true, copyable: true, sortable: true, mode: 'compact',
                emptyMessage: 'No bugs match the criteria',
                contextMenuItems: (cm) => {
                    const n = resultIds(cm).length;
                    return [
                        { label: n > 1 ? `Open ${n} bugs in tabs` : 'Open', icon: 'open_in_new', action: 'open', disabled: !n },
                        { label: 'Open in new tab', icon: 'tab', action: 'open-tab', disabled: !n },
                        { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !cm.row },
                        { separator: true },
                        { label: n > 1 ? `Copy ${n} bug IDs` : 'Copy bug ID', icon: 'content_copy', action: 'copy-id', disabled: !n },
                    ];
                },
                onContextMenuAction: (action, cm) => {
                    const ids = resultIds(cm);
                    switch (action) {
                        case 'open':
                        case 'open-tab': ids.forEach((id) => openResult(id, { dest: 'origin', newTab: true })); break;
                        case 'open-window': if (cm.row?.[0]) openResult(cm.row[0], { dest: 'window' }); break;
                        case 'copy-id':
                            if (ids.length) copyText(ids.join('\n'),
                                `Copied ${ids.length} bug ID${ids.length === 1 ? '' : 's'}.`);
                            break;
                    }
                },
                renderCell: (td, value, colIdx) => {
                    if (colIdx === 0) { td.innerHTML = `<span class="td-mono td-link">${esc(value)}</span>`; return true; }
                    return false;
                },
                onRowClick: (i, row, ev) => {
                    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
                    ctx.wm?.openInTabFromContext?.(ctx, 'ticket',
                        { id: row[0], label: ticketLabel(TICKETS.find((x) => x.id === row[0])) || row[0] });
                },
            });
            resultsTable.render();
            resultsTable.focus();
            statusLine(`Search: ${matches.length} match${matches.length === 1 ? '' : 'es'}.`);
        };
        $('[data-a="dosearch"]').addEventListener('click', doSearch);
        $('[data-a="reset"]').addEventListener('click', () => {
            $$('[data-f]').forEach((el) => { el.value = ''; });
            disposeResults();
            resultsEl.innerHTML = '';
        });
        // No New Bug cross-nav here: filing is not part of searching, and the top bar already
        // carries New Bug from anywhere. (The reverse link still exists on the New Bug screen,
        // where reaching search from a half-filled mask is genuinely useful.)
        return { title: 'Bug Search', destroy: () => { disposeResults(); destroyWidgets(); } };
    }

    /* mode: new — persisted via the bridge; the ID is assigned automatically on save */
    if (mode === 'new') {
        $('[data-a="create"]').addEventListener('click', async () => {
            const summary = fval('summary');
            if (!summary) { statusLine('Create failed: Title is required.'); host.querySelector('[data-f="summary"]')?.focus(); return; }
            const btn = $('[data-a="create"]');
            if (btn) btn.disabled = true;
            try {
                const bug = await createBug({
                    title: summary,
                    severity: fval('severity') || 'medium',
                    type: machineType(fval('type') || 'Bug'),
                    subsystem: fval('subsystem') || 'unsorted',
                    assignee: fval('assignee') || HUMAN_AUTHOR,
                    labels: fval('labels') ? fval('labels').split(',').map((s) => s.trim()).filter(Boolean) : [],
                    // Relationships staged in the Links section while filing.
                    links: t.links || [],
                    description: fval('desc') || '',
                });
                await loadData(); // refresh the store so the new bug shows up in the queue
                statusLine(`Bug #${bug.id} created.`);
                ctx.wm?.openInTabFromContext?.(ctx, 'ticket', { id: `#${bug.id}`, label: `#${bug.id}` });
            } catch (e) {
                statusLine('Create failed: ' + (e?.message || e));
                if (btn) btn.disabled = false;
            }
        });
        $('[data-a="reset"]').addEventListener('click', () => $$('[data-f]').forEach((el) => { el.value = ''; }));
        // Cross-nav: reach Bug Search from the new-bug view.
        $('[data-a="gosearch"]')?.addEventListener('click', () =>
            ctx.wm?.openInTabFromContext?.(ctx, 'ticket', { mode: 'search', label: 'Bug Search' }));
        renderLinks();
        return { title: 'New Bug', destroy: destroyWidgets };
    }

    /* ── mode: edit — live bug detail wired to the bridge ─────────── */

    const renderStages = () => {
        $$('.td-stage').forEach((el) => {
            const i = Number(el.dataset.stage);
            el.classList.toggle('td-stage--done', i < state.stage);
            el.classList.toggle('td-stage--active', i === state.stage);
        });
        $('[data-slot="stageactions"]').innerHTML = STAGE_ACTIONS[state.stage]
            .map(([label, target], i) => `<button class="ea-btn td-stageaction ${i === 0 ? 'ea-btn--primary td-stageaction--primary' : ''}" data-wf="${esc(target)}">${esc(label)}</button>`).join('');
    };

    // Move to a stage: reflect it in the read-only Status + chevrons, mark dirty.
    const gotoStage = (i) => {
        state.stage = Math.max(0, Math.min(STAGE_STATUS.length - 1, i));
        renderStages();
        setV('status', STAGE_STATUS[state.stage]);
        setDirty(true);
    };

    // assignee is EXPLICIT — sent to the bridge like any other field (the reassign picker sets it).
    const collectPatch = () => ({
        title: fval('summary'),
        status: machineStatus(fval('status')),
        type: machineType(fval('type')),
        severity: fval('severity'),
        subsystem: fval('subsystem') || 'unsorted',
        assignee: fval('assignee') || HUMAN_AUTHOR,
        labels: fval('labels') ? fval('labels').split(',').map((s) => s.trim()).filter(Boolean) : [],
    });

    const applyBug = (bug) => {
        setV('summary', bug.title);
        setV('status', humanizeStatus(bug.status));
        setV('severity', bug.severity);
        setV('subsystem', bug.subsystem || '');
        setV('labels', (bug.labels || []).join(', '));
        setV('type', typeLabelOf(typeCode(bug.type)));
        setV('updated', bug.updated || '—');
        state.stage = bug.stage ?? 0;
        renderStages();
        Object.assign(t, {
            summary: bug.title, status: humanizeStatus(bug.status), rawStatus: bug.status,
            assignee: bug.assignee || HUMAN_AUTHOR, severity: bug.severity, subsystem: bug.subsystem || 'unsorted',
            stage: bug.stage, sla: bug.updated || '', type: typeCode(bug.type), pri: SEV_PRI[bug.severity] || 3,
            labels: Array.isArray(bug.labels) ? bug.labels : [],
            links: Array.isArray(bug.links) ? bug.links : [],
            comments: (bug.comments || []).length,
            lastCommentAuthor: (bug.comments || []).length ? bug.comments[bug.comments.length - 1].author : null,
        });
        setDirty(false);
    };

    const renderDesc = (bug) => {
        const el = $('[data-slot="desc"]');
        if (el) el.innerHTML = md(bug.description) || '<span class="td-dim">No description.</span>';
    };

    const cmtHost = () => $('[data-slot="comments"]');
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
    let composer = null;   // the live markdown editor, torn down on re-render
    const renderComments = (bug) => {
        const el = cmtHost();
        if (!el) return;
        try { composer?.destroy(); } catch { /* previous mount already gone */ }
        composer = null;
        // NEWEST FIRST. The composer sits at the top, so the reply you just
        // wrote appears where you are looking instead of scrolling away below
        // a year of history.
        const comments = (bug.comments || []).slice().reverse();
        el.innerHTML = `
            <div class="td-composer">
                <span class="td-avatar">${esc(initials(HUMAN_AUTHOR))}</span>
                <div class="td-composer__box">
                    <textarea class="ea-tin td-area" rows="2"
                        placeholder="Add a comment as ${esc(HUMAN_AUTHOR)}… (Enter posts, Alt+Enter for a new line, paste a screenshot to attach it)"></textarea>
                </div>
            </div>
            <div class="td-wstream">${comments.length ? comments.map(commentHTML).join('') : '<div class="td-dim">No comments yet.</div>'}</div>`;

        const ta = el.querySelector('textarea');
        const post = async (text) => {
            if (!text) { statusLine('Nothing to post.'); return; }
            if (!t.bugId) { statusLine('Local bug — cannot comment.'); return; }
            try {
                const updated = await postComment(t.bugId, text, HUMAN_AUTHOR);
                applyBug(updated); renderDesc(updated); renderComments(updated); renderLinks();
                statusLine('Comment added.');
            } catch (err) { statusLine(`Comment failed: ${err.message}`); }
        };
        composer = attachMarkdownEditor(ta, {
            onSubmit: post,
            submitLabel: 'Comment',
            onStatus: statusLine,
        });
    };

    const save = async () => {
        if (!t.bugId) { statusLine('Local bug — nothing to persist.'); return; }
        try {
            const updated = await patchBug(t.bugId, collectPatch());
            applyBug(updated); renderDesc(updated); renderComments(updated); renderLinks();
            statusLine(`Bug #${t.bugId} saved.`);
        } catch (err) { statusLine(`Save failed: ${err.message}`); }
    };
    // Cancel: discard unsaved edits and restore the saved state. For a
    // persisted bug that means re-fetching the authoritative record from
    // the bridge; for an unsaved local bug it restores the in-memory
    // record's field values. Either way the dirty flag is cleared.
    const cancel = async () => {
        if (!t.bugId) {
            setV('summary', t.summary);
            setV('status', t.status);
            setV('severity', t.severity);
            setV('subsystem', t.subsystem || '');
            setV('labels', (t.labels || []).join(', '));
            setV('type', typeLabelOf(t.type));
            state.stage = t.stage ?? 0;
            renderStages();
            setDirty(false);
            statusLine('Reverted unsaved changes.');
            return;
        }
        try {
            const bug = await fetchBug(t.bugId);
            applyBug(bug); renderDesc(bug); renderComments(bug); renderLinks();
            statusLine('Reverted unsaved changes.');
        } catch (err) { statusLine(`Revert failed: ${err.message}`); }
    };

    // Change stage AND persist it (the transition POSTs to the bridge,
    // which derives the assignee from the new status).
    const applyStage = async (i) => { gotoStage(i); await save(); };

    // Chevrons are display-only — the lifecycle is driven exclusively by the
    // Action buttons below, so no invalid transition (e.g. back to open, or
    // close from investigation) is reachable from the UI.
    host.addEventListener('click', (e) => {
        const wf = e.target.closest('[data-wf]');
        if (!wf) return;
        applyStage(STAGE_STATUS.indexOf(humanizeStatus(wf.dataset.wf)));
    });

    const actions = { save, cancel };
    const onAction = (e) => {
        const btn = e.target.closest('[data-a]');
        if (btn && actions[btn.dataset.a]) actions[btn.dataset.a]();
    };
    host.addEventListener('click', onAction);
    // The floating bar is a sibling of `host`, so the mask's delegation
    // never sees its clicks — bind it too.
    actionsEl?.addEventListener('click', onAction);

    renderStages();

    (async () => {
        if (!t.bugId) {
            const el = $('[data-slot="desc"]');
            if (el) el.innerHTML = '<span class="td-dim">Unsaved local bug — not persisted, no description or comments.</span>';
            renderComments({ comments: [] });
            renderLinks();   // never leave the Links slot stuck on "Loading…"
            return;
        }
        try {
            const bug = await fetchBug(t.bugId);
            applyBug(bug); renderDesc(bug); renderComments(bug); renderLinks();
        } catch (err) {
            const el = $('[data-slot="desc"]');
            if (el) el.innerHTML = `<span class="td-dim">Failed to load bug ${esc(String(t.bugId))}: ${esc(err.message)}</span>`;
            renderComments({ comments: [] });
            renderLinks();   // never leave the Links slot stuck on "Loading…"
        }
    })();

    return {
        title: ticketLabel(t),
        destroy: () => {
            destroyWidgets();
            try { composer?.destroy(); } catch { /* already gone */ }
        },
    };
}

/* ── panel:left — the queue filter rail ─────────────────────────────
 *
 * Two sections over one row template:
 *   "Filters"     BUILTIN_FILTERS, in store order (that IS the rail order).
 *                 Not editable, not deletable — a builtin can only be
 *                 duplicated into a custom filter or copied as text.
 *   "My filters"  the user's own, with the full Open/Edit/Duplicate/Delete
 *                 set, plus a "New filter" row.
 *
 * Every row carries hover-revealed <button> actions (`.td-nav__actions`,
 * ticketdesk_filters.css) AND the same commands on right-click. The buttons
 * are real buttons with aria-labels, so tabbing into one reveals the group
 * through :focus-within; the rows themselves are role="button" + tabindex,
 * so the rail is reachable without a mouse at all. */

/** One action button. `act` is the command id shared by the click handler
 *  and the context menu, so there is a single command table. */
const navAction = (act, glyph, label, danger = false) =>
    `<button type="button" class="td-nav__action${danger ? ' td-nav__action--danger' : ''}"
             data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon(glyph)}</button>`;

/** A filter row. `f` is a builtin ({key}) or a custom filter ({id}). */
function navFilterRow(f, custom) {
    const key = custom ? f.id : f.key;
    return `
        <div class="td-nav__item${custom ? ' td-nav__item--custom' : ''}" data-filter="${esc(key)}"
             data-custom="${custom ? '1' : ''}" role="button" tabindex="0"
             title="${esc(describeFilter(f.expr))}">
            ${icon(esc(f.icon || 'filter_alt'))}
            <span>${esc(f.label)}</span>
            <span class="td-nav__actions">
                ${custom ? navAction('edit', 'edit', `Edit filter ${f.label}`) : ''}
                ${navAction('duplicate', 'content_copy', custom ? `Duplicate filter ${f.label}` : `Duplicate ${f.label} as a custom filter`)}
                ${navAction('copydef', 'notes', `Copy the definition of ${f.label}`)}
                ${custom ? navAction('delete', 'delete', `Delete filter ${f.label}`, true) : ''}
            </span>
            <span class="td-nav__badge ${key === 'needs-reply' ? 'td-breach' : ''}">${countFor(f.expr)}</span>
        </div>`;
}

/**
 * The left panel — one `panel:left` kind serving both stores.
 *
 * A panel kind can only be registered once, and BugDesk has two things that want
 * to live there: the bug queue's filters and the backlog's views. The rail does
 * NOT offer its own switch between them. Which one you get follows the TOP NAV
 * — the same `activeTopNavKind(wm)` that decides which chip is lit — because a
 * rail with its own tabs is a second, competing answer to a question the top bar
 * has already answered, and the two can then disagree: BACKLOG lit above, bug
 * filters below.
 *
 * So there is one navigation axis, at the top, and the rail is a consequence of
 * it.
 */
function mountTicketNav(host, props, ctx) {
    const open = (kind, p) => ctx.wm?.openInPrimary?.(kind, p);
    const openFilter = (f) => open('queues', { filter: f.key || f.id, label: f.label });

    // ctx.wm is threaded in by the renderer; the global is the escape hatch for
    // a mount that runs before that happens (same fallback tile_breadcrumb uses).
    const getWm = () => ctx?.wm || window.__twm?.wm || null;

    let shown = null;            // 'bugs' | 'backlog'
    let backlogRail = null;      // the Backlog body's controller, mounted lazily

    host.classList.add('bd-rail');
    host.innerHTML = '<div class="bd-rail__body" data-slot="railbody"></div>';
    const body = host.querySelector('[data-slot="railbody"]');

    const show = async (next) => {
        if (next === shown && body.childElementCount) return;
        shown = next;
        try { backlogRail?.destroy(); } catch { /* not mounted */ }
        backlogRail = null;
        body.innerHTML = '';
        if (next === 'bugs') { renderFilters(); return; }
        // Imported lazily so the bug rail — the thing on screen at boot — never
        // waits on the backlog module to parse.
        const { mountBacklogRail } = await import('./backlog_pages.js');
        backlogRail = mountBacklogRail(body, ctx);
    };

    /** Follow the top nav. An unresolvable section (nothing focused yet) leaves
     *  whatever is already showing rather than flickering back to Bugs. */
    const syncToTopNav = () => {
        const topNav = activeTopNavKind(getWm());
        if (!topNav) { if (!shown) show('bugs'); return; }
        show(topNav === 'backlog' ? 'backlog' : 'bugs');
    };
    const renderFilters = () => {
        const custom = listFilters();
        body.innerHTML = `
        <div class="td-nav">
            <div class="td-nav__section">Filters</div>
            ${BUILTIN_FILTERS.map((f) => navFilterRow(f, false)).join('')}
            <div class="td-nav__section">My filters</div>
            ${custom.length
                ? custom.map((f) => navFilterRow(f, true)).join('')
                : '<div class="td-nav__item"><span class="td-dim">No custom filters yet</span></div>'}
            <div class="td-nav__item" data-new="1" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">New filter</span>
            </div>
        </div>`;
    };
    // Subscribe only once `renderFilters` is initialised — `show()` calls it,
    // and a `wm:changed` arriving in between would hit it in the temporal dead
    // zone.
    syncToTopNav();
    const focusSub = _eventBus?.on?.('wm:changed', syncToTopNav);

    // listFilters() hands back the LIVE array, so a full re-render is the whole
    // update — never cache a copy of it. Only repaint when the BUG rail is the
    // one on screen; the backlog rail keeps its own subscription for its own
    // filters.
    const unsub = onFiltersChanged(() => { if (shown === 'bugs') renderFilters(); });

    const newFilter = () => openFilterEditor({
        model: MODEL, scope: SCOPE, items: TICKETS, onSaved: openFilter });

    /** The one command table behind both the buttons and the menu. */
    const runAction = (act, key, custom) => {
        const f = getFilter(key);
        if (!f) { statusLine(`Filter "${key}" no longer exists.`); return; }
        switch (act) {
            case 'open': openFilter(f); break;
            case 'edit':
                // Builtins have no editor path — they are duplicated instead.
                if (custom) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: f, items: TICKETS, onSaved: openFilter });
                break;
            case 'duplicate': {
                const draft = duplicateFilter(key); // id-less draft → editor opens as "New filter"
                if (draft) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: draft, items: TICKETS, onSaved: openFilter });
                break;
            }
            case 'copydef': {
                const text = describeFilter(f.expr);
                copyText(text, `Copied filter definition: ${text}`);
                break;
            }
            case 'delete':
                if (custom && window.confirm(`Delete filter "${f.label}"?`)) deleteFilter(f.id);
                break;
        }
    };

    body.addEventListener('click', (e) => {
        if (e.target.closest('[data-new]')) { newFilter(); return; }
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        const btn = e.target.closest('.td-nav__action');
        if (btn) { runAction(btn.dataset.act, row.dataset.filter, !!row.dataset.custom); return; }
        runAction('open', row.dataset.filter, !!row.dataset.custom);
    });

    // Keyboard: the rows are role="button", so Enter/Space must activate
    // them like a click. The action buttons are native <button>s and need
    // nothing (their click handler above already covers them).
    body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.td-nav__action')) return;
        if (e.target.matches('[data-new]')) { e.preventDefault(); newFilter(); return; }
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        e.preventDefault();
        runAction('open', row.dataset.filter, !!row.dataset.custom);
    });

    body.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        e.preventDefault();
        const custom = !!row.dataset.custom;
        const items = custom
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
                { label: 'Duplicate as custom filter', icon: 'content_copy', action: 'duplicate' },
                { label: 'Copy definition', icon: 'notes', action: 'copydef' },
            ];
        showContextMenu(e.clientX, e.clientY, items,
            (action) => runAction(action, row.dataset.filter, custom));
    });

    return {
        title: 'Filters',
        destroy: () => {
            unsub();
            focusSub?.dispose?.();
            try { backlogRail?.destroy(); } catch { /* not mounted */ }
        },
    };
}

/* ── panel:right — Inspector ─────────────────────────────────────────
 *
 * Who is carrying what, for whichever store you are in. It used to read the bug
 * store only, so on the Backlog page — or on any project that files feature work
 * before it has bugs — it rendered a header and nothing else, with no
 * indication whether that meant "nobody is assigned" or "this panel is broken".
 *
 * It follows the top nav for the same reason the left rail does: one navigation
 * axis, and no panel quietly answering a question about the store you are not
 * looking at. */

function memberRow(m) {
    return `
    <div class="td-mrow" title="${esc(m.name)} — ${m.presence}, load ${Math.round(m.load * 100)}%">
        <span class="td-avatar">${m.initials}<span class="td-presence td-presence--${m.presence}"></span></span>
        <span class="td-mrow__name">${m.me ? `<b>${esc(m.name)} (you)</b>` : esc(m.name)}</span>
        <span class="td-mrow__counts"><span class="td-inc">${m.inc} ${esc(m.openLabel || 'open')}</span> · ${m.other} ${esc(m.doneLabel || 'closed')}</span>
        <span class="td-loadbar"><span class="td-loadbar__fill td-loadbar__fill--${loadClass(m.load)}" style="width:${Math.round(m.load * 100)}%"></span></span>
    </div>`;
}

/** The backlog's equivalent of data.js's TEAM: one row per assignee, weighted
 *  by the items still in flight. Built here rather than in backlog_data.js
 *  because the shape it produces exists only to feed memberRow. */
function backlogTeam(items) {
    const open = {}, done = {};
    for (const i of items) {
        const who = i.assignee || '';
        if (!who) continue;                       // unassigned is not a person
        if (i.status === 'done' || i.status === 'dropped') done[who] = (done[who] || 0) + 1;
        else open[who] = (open[who] || 0) + 1;
    }
    const names = Array.from(new Set([...Object.keys(open), ...Object.keys(done)])).sort();
    const maxOpen = Math.max(1, ...names.map((n) => open[n] || 0));
    return names.map((name) => ({
        name,
        initials: initials(name),
        presence: (open[name] || 0) > 0 ? 'online' : 'away',
        inc: open[name] || 0,
        other: done[name] || 0,
        openLabel: 'in flight',
        doneLabel: 'done',
        load: Math.round(((open[name] || 0) / maxOpen) * 100) / 100,
        me: name.toLowerCase() === HUMAN_AUTHOR.toLowerCase(),
    }));
}

function mountTicketInspector(host, props, ctx) {
    const getWm = () => ctx?.wm || window.__twm?.wm || null;

    const render = async () => {
        const backlog = activeTopNavKind(getWm()) === 'backlog';
        let rows = [];
        let empty = '';
        if (backlog) {
            const { ITEMS } = await import('./backlog_data.js');
            rows = backlogTeam(ITEMS);
            empty = ITEMS.length
                ? 'No backlog item has an assignee yet.'
                : 'No backlog items yet.';
        } else {
            rows = TEAM;
            empty = TICKETS.length ? 'No bug has an assignee yet.' : 'No bugs yet.';
        }
        const active = rows.filter((m) => m.presence !== 'offline').length;
        host.innerHTML = `
            <div class="td-rpanel">
                <div class="twm-bp__tabs td-rpanel__tabs">
                    <button class="twm-bp__tab twm-bp__tab--on">${backlog ? 'Backlog team' : 'Bug team'}</button>
                </div>
                <div class="td-rpanel__body">
                    <div class="td-nav__section">Assignees
                        <span class="td-nav__badge">${active}/${rows.length} active</span></div>
                    ${rows.length
                        ? rows.map(memberRow).join('')
                        : `<div class="td-nav__item"><span class="td-dim">${esc(empty)}</span></div>`}
                </div>
            </div>`;
    };
    render();

    const sub = _eventBus?.on?.('wm:changed', render);
    const backlogSub = _eventBus?.on?.('backlog:changed', render);
    return {
        title: 'Inspector',
        destroy: () => { sub?.dispose?.(); backlogSub?.dispose?.(); },
    };
}

/* ── panel:bottom — Console (hidden by default) ─────────────────── */

function mountTicketBottomPanel(host, props, ctx) {
    const byStatus = {};
    for (const t of TICKETS) byStatus[t.rawStatus] = (byStatus[t.rawStatus] || 0) + 1;
    const line = ['open', 'investigation', 'testing', 'closed']
        .map((s) => `${humanizeStatus(s)}: ${byStatus[s] || 0}`).join(' · ');
    const needs = TICKETS.filter((t) => t.lastCommentAuthor === AGENT_AUTHOR).length;
    host.innerHTML = `
        <div class="twm-bp">
            <div class="twm-bp__tabs" role="tablist">
                <button class="twm-bp__tab twm-bp__tab--on" role="tab">Console</button>
            </div>
            <div class="twm-bp__body" role="tabpanel">
                <div class="td-audit">
                    <div><span class="td-dim td-mono">—</span> <span class="td-link">bugdesk</span> — markdown bug store is the source of truth (BUGDESK_BUGS)</div>
                    <div><span class="td-dim td-mono">—</span> <span class="td-link">store</span> — ${esc(line)}</div>
                    <div><span class="td-dim td-mono">—</span> <span class="td-link">needs my reply</span> — ${needs} bug${needs === 1 ? '' : 's'} awaiting ${esc(HUMAN_AUTHOR)}</div>
                </div>
            </div>
        </div>`;
    return { title: 'Console' };
}

/* ── content map ────────────────────────────────────────────────── */

/**
 * Build BugDesk's own content map — `{ kind: factory }` — for the kinds
 * this file owns (queues / home / ticket / the three panel kinds).
 *
 * Used to call a module-level `register(kind, factory)` from the now-
 * deleted content_registry.js. install.js now merges this map AFTER
 * page_stubs.js's (so these entries win for the shared kinds: 'home',
 * 'panel:left', 'panel:right', 'panel:bottom') and hands the result to
 * `@flexdesk/wm`'s `createContentRegistry(...)`.
 */
export function createTicketDeskContent({ eventBus } = {}) {
    _eventBus = eventBus || null;
    // Pull the user's custom filters. This is deliberately NOT awaited —
    // createTicketDeskContent is synchronous and install.js builds the
    // content map right before the first mount. Until the store lands,
    // listFilters() is [] (the rail shows only builtins and a queue on a
    // custom id resolves to 'all'); the notify() at the end of loadFilters
    // then re-renders the rail and every open queue through their
    // onFiltersChanged subscription.
    loadFilters().catch((err) => console.warn('[bugdesk] filter store load failed', err));

    const content = {};
    const register = (kind, factory) => { content[kind] = factory; };

    register('queues', shell('queues', mountQueues));
    // WM default leaf is 'home'. A #ticket hash retargets it — used for
    // headless verification of the ticket detail page.
    register('home',
        location.hash === '#ticket' ? shell('ticket', mountTicket)
        : shell('queues', mountQueues));
    register('ticket', shell('ticket', mountTicket));
    register('panel:left', mountTicketNav);
    register('panel:right', mountTicketInspector);
    register('panel:bottom', mountTicketBottomPanel);

    return content;
}
