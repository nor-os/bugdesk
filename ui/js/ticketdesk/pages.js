/**
 * ticketdesk/pages.js — BugDesk content kinds for the tiling WM.
 *
 * Registered kinds:
 *   queues         DataTable master list, under the Bugs home (STORY-0048);
 *                  rows open bugs as TABS in the tile
 *   ticket         one mask, three modes: edit (default) / new / search
 *   panel:left     filter rail (builtin filters + the user's own)
 *   panel:right    Inspector — TEAM only
 *   panel:bottom   Alerts and Changes (hidden by default)
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

import { createBottomPanelTabs, mountTileBreadcrumb } from '@flexdesk/wm';
import { activeTopNavKind, taxonomy } from '../tiling/kind_taxonomy.js';
import { installRecordDragSource, markDragCell, openRecordAs } from './record_dnd.js';
import { createTable, fileSlug } from './bd_table.js';
import { openConfirm, showContextMenu } from '@flexdesk/widgets';
import {
    BUILTIN_FILTERS, FILTER_FIELDS, MODEL, SCOPE,
    describeFilter, deleteFilter, duplicateFilter, getFilter,
    listFilters, loadFilters, matcherFor, onFiltersChanged,
} from './filters.js';
import { openFilterEditor } from './filter_editor.js';
import { renderMarkdown } from './markdown.js';
import { attachMarkdownEditor } from './md_editor.js';
import {
    LINK_TYPES, linkTypeDef, linkTypeOptions, formatLink, linkRows, validateNewLink, withoutLink,
} from './links.js';
import { bugRef, displayRef, formatRef, parseKey, parseRef, refKey } from './refs.js';
import { allRows, canonRef, findRow, openRow, storesAvailable } from './records.js';
import { renderHistory } from './history.js';
import { CONFIG, ev, KIND, trackerModule } from './instance.js';
import { attachRecordTypeahead, openRecordPicker } from './item_picker.js';
import { attachSelect, setRowVisible } from './select_field.js';
import { mountCustomFields } from './custom_fields.js';
import {
    customStatus, displayValue, isHidden, snoozeNotice, sortValue as schemaSortValue, statusKnown,
    storeFields as customColumns, withCustomStatuses,
} from './schema.js';
import { RESOLUTIONS, actionsFor, defaultActions, typeActions } from './workflow.js';
import { convertRecord, convertedBanner } from './convert.js';
import { attachAutosave, autosaveMode } from './autosave.js';
import { attachTagInput } from './tag_input.js';
import { ITEMS, isClosedItem, loadBacklog } from './backlog_data.js';
import { watchRecord } from './live.js';
import { bugMovesFor, moveBug, planBugMove } from './bug_transitions.js';
import { bugRecord, itemRecord, massActionBar } from './mass_actions.js';
import { attachCommentEditing, editButtonHTML } from './comment_edit.js';
import { paintRecordCount, publishRecordCount } from './record_count.js';
import {
    esc, STAGES, TICKETS, TEAM, HUMAN_AUTHOR, AGENT_AUTHOR, assigneeOptions, formatStamp,
    fetchBug, patchBug, postComment, createBug, deleteBug, loadData, initials, teamNames,
    machineStatus, machineType, typeCode, typeLabelOf, humanizeStatus, isClosed,
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
            crumb = mountTileBreadcrumb(kind, props, { taxonomy, ...ctx, eventBus: _eventBus });
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
    // The project's own fields (Settings › Record types), after the built-ins
    // so no built-in column moves — hidden until somebody picks them from the
    // header's right-click menu.
    ...customColumns('bugs').map((f) => ({
        header: f.label || f.name, field: `cf.${f.name}`, custom: f,
        cell: (t) => displayValue(f, t.fields?.[f.name]),
        toFilterValue: (v) => (f.type === 'bool' ? (v === 'Yes' ? 'true' : v === 'No' ? 'false' : '') : v),
        cellFilter: f.type !== 'text',
    })),
];
/** Indices of the custom-field columns: hidden by default. */
const QUEUE_CUSTOM_IDX = QUEUE_COLUMNS.map((c, i) => (c.custom ? i : -1)).filter((i) => i >= 0);
/** Part of the table's remembered-state key, so a remembered hidden set and
 *  widths never land on the wrong columns after the schema changed. */
const QUEUE_COLS_SIG = QUEUE_CUSTOM_IDX.length ? `:${QUEUE_CUSTOM_IDX.map((i) => QUEUE_COLUMNS[i].field).join(',')}` : '';
const QUEUE_HEADERS = QUEUE_COLUMNS.map((c) => c.header);

/** Custom fields of both stores, one per name, for the search results. */
const SEARCH_CUSTOM = [...customColumns('bugs'), ...customColumns('backlog')]
    .filter((f, i, all) => all.findIndex((g) => g.name === f.name) === i);
const SEARCH_SIG = SEARCH_CUSTOM.length ? `:${SEARCH_CUSTOM.map((f) => f.name).join(',')}` : '';

/** A bug's status as a position: the built-in order with custom statuses in
 *  their configured place (schema.js), for a sort by Status. */
function bugStatusRank(id) {
    const t = TICKETS.find((x) => x.id === id);
    if (!t) return 999;
    const order = withCustomStatuses('bugs', t.rawType || 'bug', ['open', 'investigation', 'testing', 'closed']);
    const i = order.indexOf(t.rawStatus);
    return i < 0 ? order.length : i;
}
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
 * The live filter row comes from FlexDesk's `getFilters()` — `[{column,
 * header, value}]`, empty boxes left out.
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
    for (const { column: colIdx, value: text } of table.getFilters()) {
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
            <button class="ea-btn" data-a="select" aria-pressed="false" hidden></button>
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
        // Several bugs selected: what they can ALL do (STORY-0029), else the
        // right-clicked bug's status moves, the same list its page offers.
        const many = mass.menuItems();
        return [
            ...(many.length ? many : statusMenuItems(cm.row ? TICKETS.find((x) => x.id === cm.row[QUEUE_ID_COL]) : null)),
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
            { label: 'Delete…', icon: 'delete', action: 'delete', disabled: !cm.row, danger: true },
            { separator: true },
            // Greyed out rather than hidden, so the menu keeps a stable shape
            // whichever cell the user happened to hit.
            { label: cc ? `Filter by ${fieldLabel} “${cc.value}”` : 'Filter by this cell',
              icon: 'filter_alt', action: 'filter-cell', disabled: !cc },
            { label: 'Save as filter…', icon: 'bookmark_add', action: 'filter-cell-save', disabled: !cc },
        ];
    };

    const onContextMenuAction = (action, cm) => {
        if (mass.runMenu(action)) return;
        const ids = menuIds(cm);
        const one = cm.row?.[QUEUE_ID_COL] || ids[0];
        const cc = cellClause(cm);
        if (/^(move|act):/.test(String(action))) {
            runStatusMenuAction(action, cm.row ? TICKETS.find((x) => x.id === cm.row[QUEUE_ID_COL]) : null);
            return;
        }
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
            case 'delete':
                if (cm.row) confirmDeleteBug(TICKETS.find((x) => x.id === cm.row[QUEUE_ID_COL]));
                break;
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

    // One remembered sort / column filters / widths per VIEW: sorting "Active" by
    // summary must not reorder "Open". An ad-hoc view (a rail or Inspector click
    // with an expression and no saved filter) has no stable name, so they share
    // one slot rather than each minting a key that is never seen again. Only set
    // when a store was handed in — a table given a persistKey and no store throws.
    const persistKey = `bugs:queue:${resolved.key || 'adhoc'}${QUEUE_COLS_SIG}`;
    // The Snoozed view in a project with no "Snooze until" field: say how to get one.
    if (resolved.key === 'snoozed') {
        const notice = snoozeNotice('bugs', _eventBus);
        if (notice) host.querySelector('.td-tablehost').before(notice);
    }
    // STORY-0029. The select-mode toggle in the table's header, and the bar of
    // mass actions over the ticked bugs. See ./mass_actions.js.
    const mass = massActionBar(host.querySelector('.td-tablehost'), {
        noun: 'bugs',
        toggle: host.querySelector('[data-a="select"]'),
        recordsOf: (indices, t) => indices.map((i) => t.config.rows[i])
            .map((r) => TICKETS.find((x) => x.id === r?.[QUEUE_ID_COL])).filter(Boolean).map(bugRecord),
        report: statusLine,
        afterChange: async () => { await loadData(); _eventBus?.emit?.('bugs:changed', { store: 'bugs' }); },
    });
    const table = createTable(host.querySelector('.td-tablehost'), {
        ...mass.tableOptions,
        ...(ctx?.tableStore ? { stateStore: ctx.tableStore, persistKey } : {}),
        // The CSV button: the native Save dialog in the desktop app (STORY-0026).
        host: ctx?.host,
        exportFilename: () => `${fileSlug(resolved.label, 'bugs')}.csv`,
        // Priority is a short-badge column (an 8px swatch + "P3"): pinned narrow
        // until somebody drags it wider, when the remembered width wins.
        seedColWidths: { 0: 48 },
        // Status sorts by where a status stands — custom ones in their
        // configured place (Settings › Record types) — not alphabetically.
        sortValue: {
            [QUEUE_COLUMNS.findIndex((c) => c.field === 'status')]: (_v, _c, row) => bugStatusRank(row[QUEUE_ID_COL]),
            // Dates as dates, numbers as numbers — off the RAW value, not the text drawn.
            ...Object.fromEntries(QUEUE_CUSTOM_IDX.map((i) => [i, (_v, _c, row) => {
                const t = TICKETS.find((x) => x.id === row[QUEUE_ID_COL]);
                return schemaSortValue(QUEUE_COLUMNS[i].custom, t?.fields?.[QUEUE_COLUMNS[i].custom.name]) ?? undefined;
            }])),
        },
        ...(QUEUE_CUSTOM_IDX.length ? { hiddenColumns: QUEUE_CUSTOM_IDX, columnChooser: true } : {}),
        // Every ad-hoc view shares the 'adhoc' slot, so its page would land a
        // new filter's results on whatever page the last one was left on.
        persistPage: !!resolved.key,
        headers: QUEUE_HEADERS,
        rows: TICKETS.filter(resolved.match).map(queueRow),
        // A queue can outgrow one page; the strip appears only when it does.
        pagination: true,
        onRender: paintRecordCount,
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
            // Every cell is a drag handle, carrying the row's bug id. Marked on
            // the CELL because DataTable renders it detached — see markDragCell
            // in ./record_dnd.js for why that matters.
            markDragCell(td, row[QUEUE_ID_COL]);
            if (colIdx === 0) {
                td.innerHTML = `<span class="td-pri-cell"><span class="td-pri td-pri--${value}" title="Priority ${value}"></span><span class="td-dim">P${value}</span></span>`;
                return true;
            }
            if (colIdx === 1) { td.innerHTML = `<span class="td-mono td-link">${esc(value)}</span>`; return true; }
            if (colIdx === 2) { td.innerHTML = `<span class="td-chip">${esc(value)}</span>`; return true; }
            return false;
        },
        // The bug id is the row's identity: the keyboard highlight is
        // remembered by it, so it survives a sort, a refresh and a return.
        rowKey: (row) => String(row[QUEUE_ID_COL]),
        // Click and Enter open a new tab; Ctrl/⌘ with either follows the
        // setting; Alt+T / Alt+N / Alt+Shift+H / Alt+Shift+V pick the place.
        // See openRecordAs in ./record_dnd.js.
        onRowOpen: (rowIdx, row, how) => {
            const id = row[QUEUE_ID_COL];
            openRecordAs(ctx.wm, ctx, 'ticket', {
                id, label: ticketLabel(TICKETS.find((x) => x.id === id)) || id,
                filter: resolved.key || DEFAULT_FILTER,
            }, how);
        },
    });

    // Drag a row onto any tile to display it there. See ./record_dnd.js.
    const drag = installRecordDragSource(host, (el) => {
        const id = el?.closest?.('[data-drag-key]')?.dataset.dragKey;
        if (!id) return null;
        const model = TICKETS.find((x) => String(x.id) === String(id));
        return { kind: 'ticket', props: { id, label: ticketLabel(model) || id }, label: `#${id}` };
    });
    // "12 of 40 open bugs shown" in the bottom bar while this queue is in front.
    publishRecordCount(host.querySelector('.td-tablehost'), () => {
        const byId = new Map(TICKETS.map((t) => [String(t.id), t]));
        const shown = table.getDisplayedRows()
            .filter((r) => { const t = byId.get(String(r[QUEUE_ID_COL])); return t && !isClosed(t); }).length;
        return { shown, total: TICKETS.filter((t) => !isClosed(t)).length, noun: 'bugs' };
    });
    table.render();
    mass.attach(table);
    requestAnimationFrame(() => { if (host.isConnected) table.focus(); });

    host.querySelector('[data-a="newbug"]').addEventListener('click', async () => {
        // The same page the backlog's Epic/Story/Task buttons open, preselected
        // — one create mask, not one per store.
        const { openNewItem } = await import('./new_item.js');
        openNewItem(ctx.wm, { kind: 'bug', ctx });
    });

    host.querySelector('[data-a="savefilter"]').addEventListener('click', () => {
        const { expr, skipped } = seedExprFromQueue(table, resolved);
        if (skipped.length)
            statusLine(`Save as filter: column filter${skipped.length === 1 ? '' : 's'} ${skipped.join(', ')} could not be expressed and ${skipped.length === 1 ? 'was' : 'were'} left out.`);
        openFilterEditor({ model: MODEL, scope: SCOPE, seedExpr: expr, items: TICKETS, onSaved: openSavedFilter });
    });

    // The store changed under us — a git pull, an agent, somebody's editor.
    // Nobody is mid-sentence in a table, so this simply repaints.
    const liveSub = _eventBus?.on?.('bugs:changed', () => {
        table.setData({ rows: TICKETS.filter(resolved.match).map(queueRow) });
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
    return {
        title: resolved.label,
        destroy: () => { unsub(); liveSub?.dispose?.(); drag.destroy(); mass.destroy(); table.dispose(); },
    };
}

/* ── ticket mask (edit / new / search) ──────────────────────────── */

/** Lifecycle stage actions, index === state.stage (0..3): the moves in
 *  bug_transitions.js, which the right-click menu offers too. */
const STAGE_ORDER = ['open', 'investigation', 'testing', 'closed'];

/** Where the chevrons stand for a status. A custom one stands where it was
 *  configured to sit after, a finished one at Closed, any other at
 *  Investigation — it is somewhere a bug waits while it is being worked. */
function stageIndexOf(status, type = 'bug') {
    const i = STAGE_ORDER.indexOf(status);
    if (i >= 0) return i;
    if (isClosed({ rawStatus: status, rawType: type })) return 3;
    const after = customStatus('bugs', type, status)?.after;
    const j = STAGE_ORDER.indexOf(after);
    return j >= 0 && j < 3 ? j : 1;
}

/** The status moves of one bug as context-menu entries, then a separator. */
function statusMenuItems(bug) {
    const moves = bug ? bugMovesFor(bug.rawStatus, bug.rawType) : [];
    // The project's own actions (Settings › Workflow), beside the moves.
    const acts = bug ? actionsFor('bugs', bug.rawType || 'bug', bug.rawStatus) : [];
    if (!moves.length && !acts.length) return [];
    return [
        ...moves.map(({ label, to: target }) => ({
            label, icon: target === 'closed' ? 'task_alt' : target === 'open' ? 'undo' : 'swap_horiz',
            action: `move:${target}:${label}`,
        })),
        ...acts.map((a) => ({ label: a.label, icon: 'bolt', action: `act:${a.id}` })),
        { separator: true },
    ];
}

/** Carry out a `move:<target>:<label>` menu entry on `bug`, with its message. */
async function runStatusMenuAction(action, bug) {
    if (!bug) return;
    if (String(action).startsWith('act:')) { await runBugAction(bug, String(action).slice(4)); return; }
    const [, target, ...rest] = String(action).split(':');
    const label = rest.join(':');
    try {
        const saved = await moveBug({ bugId: bug.bugId, from: bug.rawStatus, to: target, label, title: bug.summary });
        if (!saved) { statusLine('Status unchanged.'); return; }
        statusLine(`Bug ${bug.id}: ${humanizeStatus(bug.rawStatus)} → ${humanizeStatus(target)}.`);
        await loadData();
        _eventBus?.emit?.('bugs:changed', { store: 'bugs', id: bug.bugId });
    } catch (err) {
        statusLine(`Could not move bug ${bug.id}: ${err?.message || err}`);
    }
}

/** Run one of the project's actions (Settings › Workflow) on a bug from a list:
 *  its flow, then ONE save — or nothing, when a question was cancelled. */
async function runBugAction(bug, id) {
    const act = actionsFor('bugs', bug.rawType || 'bug', bug.rawStatus).find((a) => a.id === id);
    if (!act) return;
    try {
        const full = await fetchBug(bug.bugId);
        const patch = await planBugMove({
            bugId: bug.bugId, bug: full, move: { label: act.label, message: false, flow: act.flow || null },
            from: bug.rawStatus, title: bug.summary,
        });
        if (!patch) { statusLine(`${act.label}: cancelled, nothing changed.`); return; }
        if (!Object.keys(patch).length) { statusLine(`${act.label}: nothing to do.`); return; }
        await patchBug(bug.bugId, patch);
        statusLine(`Bug ${bug.id}: ${act.label}.`);
        await loadData();
        _eventBus?.emit?.('bugs:changed', { store: 'bugs', id: bug.bugId });
    } catch (err) {
        statusLine(`${act.label} failed on bug ${bug.id}: ${err?.message || err}`);
    }
}

/** A comment's status tag: the header note `status: testing -> closed`, shown
 *  as "Testing → Closed". Any other note is shown as written. */
export function statusTag(note) {
    const text = String(note || '').trim();
    if (!text) return '';
    const m = /^status:\s*(\S+)\s*->\s*(\S+)$/i.exec(text);
    const label = m ? `${humanizeStatus(m[1])} → ${humanizeStatus(m[2])}` : text;
    return `<span class="td-chip td-chip--status" title="${esc(text)}">${esc(label)}</span>`;
}
/** Actions that are NOT a step along the ladder. They sit after the stage
 *  buttons and are offered wherever `when` says they make sense. Duplicate is
 *  the type's DEFAULT action (STORY-0050), a flow like any other: it is drawn
 *  here only while the type has no action list of its own — once it has, the
 *  list says whether (and how) it is offered, among the moves. */
const WORKFLOW_ACTIONS = [
    { id: 'duplicate', label: 'Mark as duplicate and close', icon: 'content_copy',
      title: 'Pick the record this duplicates, link it, and close this one',
      when: (closed, type) => !closed && !typeActions('bugs', type) },
    { id: 'convert', label: 'Convert to backlog item…', icon: 'swap_horiz',
      title: 'It is feature work: move it to the backlog, with its comments and history',
      when: (closed) => !closed && storesAvailable().includes('backlog') },
    { id: 'delete', label: 'Delete…', icon: 'delete',
      title: 'Delete this bug — it is moved to the store\'s trash',
      when: () => true },
];

/**
 * Ask, then delete one bug. The bridge moves the file to the store's trash
 * (beside the store, not in it), so this is undone by moving it back; closing
 * is still the right answer for a bug that was real, and the dialog says so.
 * Resolves to true when the bug was deleted.
 */
async function confirmDeleteBug(bug) {
    if (!bug?.bugId) return false;
    const ok = await openConfirm({
        title: `Delete bug #${bug.bugId}`,
        message: `<p>Delete <b>#${esc(bug.bugId)} — ${esc(bug.summary || '')}</b>?</p>
            <p class="td-dim">The file is moved to the store's trash folder, not erased.
            To record that it was dealt with, Close it instead.</p>`,
        confirmLabel: 'Delete', danger: true, icon: 'delete',
    });
    if (!ok) return false;
    try {
        await deleteBug(bug.bugId);
        statusLine(`Bug #${bug.bugId} deleted (moved to the trash).`);
        await loadData();
        _eventBus?.emit?.('bugs:changed', { store: 'bugs', id: bug.bugId });
        return true;
    } catch (err) {
        statusLine(`Could not delete bug #${bug.bugId}: ${err?.message || err}`);
        return false;
    }
}
const STAGE_STATUS = ['Open', 'Investigation', 'Testing', 'Closed'];

/** How it ended (STORY-0050) — set by Close and Duplicate, editable here. A
 *  value that is not one of the six (typed by hand) is kept as an option of its
 *  own, or the next ordinary save would quietly remove it. */
const resolutionSelect = (cur) => `<select class="ea-tin" data-f="resolution">
    <option value=""${cur ? '' : ' selected'}>—</option>
    ${(cur && !RESOLUTIONS.some(([v]) => v === cur) ? [...RESOLUTIONS, [cur, cur]] : RESOLUTIONS)
        .map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
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
    // A row the project can hide per type (Settings › Record types). Marked, not
    // left out, because the Type select can change which rows apply.
    const hideRow = (name, html) => html.replace('<div class="td-field"', `<div class="td-field" data-row="${name}"`);
    // Status: a filter in search mode; read-only in edit/new — the lifecycle
    // stage buttons drive it.
    const statusCtrl = search
        ? sel('status', STAGE_STATUS, t.status)
        : `<input class="ea-tin td-mono" data-f="status" value="${esc(t.status)}" readonly>`;
    // Assignee and Reporter are both widened with the record's OWN value, because a
    // <select> whose value is off the roster silently falls back to its first option —
    // and under ## History that fallback is not just a wrong save, it is a permanent
    // audit line for a decision nobody made. For the same reason neither one is
    // preselected to HUMAN_AUTHOR: an unassigned bug stays visibly unassigned until
    // somebody assigns it.
    // The link target is typed OR picked, and both go in through one parser. The
    // `<datalist id="td-linktargets">` that used to back the field is gone: its id was
    // a hard-coded global, so two open ticket masks produced duplicate ids and `list=`
    // resolved to whichever came first in the document; it was a snapshot of TICKETS
    // taken at mount time; and it could not express a backlog target at all.
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
            ${hideRow('severity', field('Severity', sel('severity', ['crash', 'high', 'medium', 'low'], t.severity || 'medium'), true))}
            ${hideRow('subsystem', field('Subsystem', tin('subsystem', t.subsystem)))}
            ${mode === 'edit' ? hideRow('resolution', field('Resolution', resolutionSelect(t.resolution))) : ''}
            ${mode === 'search' ? '' : field('Assignee', `<div class="td-assignee">${sel('assignee', assigneeOptions(true, t.assignee), t.assignee || '')}<button type="button" class="ea-btn td-reassign" data-a="reassign" title="Reassign this bug">${icon('person_search')}</button></div>`)}
            ${mode === 'edit' ? field('Reporter', `<div class="td-assignee">${sel('reporter', assigneeOptions(true, t.reporter), t.reporter || '')}<button type="button" class="ea-btn td-reassign" data-a="setreporter" title="Change who this bug goes back to">${icon('person_edit')}</button></div>`) : ''}
            <div class="td-field td-span2" data-row="labels"><label>Labels</label>${tin('labels', (t.labels || []).join(', '))}</div>
            ${mode === 'edit' ? field('Created', `<input class="ea-tin td-mono" value="${esc(t.created || '—')}" readonly>`) : ''}
            ${mode === 'edit' ? field('Updated', `<input class="ea-tin td-mono" data-f="updated" value="${esc(t.sla || '—')}" readonly>`) : ''}
        </div>
    </section>
    ${mode !== 'search' ? `
    <section class="td-group" data-slot="customfields" hidden></section>
    <section class="td-group" data-row="links">
        <div class="td-group__title">Links</div>
        <div class="td-group__body">
            <div data-slot="links"><span class="td-dim">Loading…</span></div>
            <div class="td-linkadd">
                <select class="ea-tin td-linkadd__type" data-f="linktype">${linkTypeOptions()}</select>
                <input class="ea-tin td-mono td-linkadd__target" data-f="linktarget"
                       placeholder="#42, STORY-7, or search…">
                <button class="ea-btn" data-a="picklink" title="Find a record">${icon('search')}</button>
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
    // `status` is the raw status, which may be a custom one (Settings › Record
    // types); `stage` is only where the chevrons stand.
    const state = { stage: t.stage ?? 0, status: t.rawStatus || 'open', dirty: false };

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
                `<li class="td-stage" data-stage="${i}"><span class="td-stage__num">${i + 1}</span><span class="td-stage__label">${s}</span></li>`).join('')}
            </ol>
        </div>
        <div class="td-stageactions">
            <span class="td-stageactions__title">${icon('bolt')} Actions</span>
            <span data-slot="stageactions"></span>
        </div>` : ''}
        ${mode === 'edit' ? '<div data-slot="converted"></div>' : ''}
        <div class="td-mask">${maskSections(t, mode)}
            ${mode === 'edit' ? `
            <section class="td-group">
                <div class="td-group__title td-group__title--tabs">
                    <span class="td-tabs" role="tablist">
                        <button type="button" class="td-tab td-tab--on" role="tab" aria-selected="true"
                                data-tab="comments">Comments</button>
                        <button type="button" class="td-tab" role="tab" aria-selected="false"
                                data-tab="history">History</button>
                    </span>
                    <span class="td-dim" data-slot="tabnote">— posted as ${esc(HUMAN_AUTHOR)}</span>
                </div>
                <div class="td-group__body" data-slot="comments" role="tabpanel"></div>
                <div class="td-group__body td-group__body--flush" data-slot="history" role="tabpanel" hidden></div>
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
                <button class="ea-btn" data-a="reset">Reset</button>
                <span class="td-spacer"></span>
                <label class="td-check" title="Finished work is left out by default">
                    <input type="checkbox" data-f="includeClosed"> Include closed
                </label>`}
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
                <span class="td-savestate" data-slot="savestate" aria-live="polite"></span>
                <button class="ea-btn" data-a="cancel" disabled>${icon('undo')} Cancel</button>
                <button class="ea-btn ea-btn--primary" data-a="save" disabled>${icon('save')} ${autosaveMode().mode === 'off' ? 'Save' : 'Save now'}</button>
            </div>`;
    }

    const $ = (s) => host.querySelector(s) || actionsEl?.querySelector(s) || null;
    const $$ = (s) => Array.from(host.querySelectorAll(s));
    // Auto-save (Settings › Saving and git) — attached once `save` exists, below.
    let autosave = null;
    const fval = (id) => host.querySelector(`[data-f="${id}"]`)?.value?.trim() || '';
    const setV = (id, val) => {
        const el = host.querySelector(`[data-f="${id}"]`);
        if (!el) return;
        el.value = val;
        // A <select> silently becomes "" when handed a value it has no option for,
        // and the option lists were built once, at mount. So a record that changes
        // hands under the page — the agent handing a bug back to its reporter, which
        // is the whole point of the reporter field — reloads with an assignee the
        // list has never seen, the control reads "Unassigned", and the next ordinary
        // save writes that blank back as a real reassignment plus a history line
        // nobody asked for. Widening the list here covers every select at once.
        if (el.tagName === 'SELECT' && val && el.value !== val) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = val;
            el.appendChild(opt);
            el.value = val;
        }
        // Labels render as pills over a hidden carrier input, so writing the
        // carrier is only half the update — repaint the pills too.
        if (id === 'labels') tagInput?.setTags(String(val || '').split(','));
    };

    const setDirty = (on) => {
        state.dirty = on;
        const a = $('[data-a="save"]'), c = $('[data-a="cancel"]');
        if (a) a.disabled = !on;
        if (c) c.disabled = !on;
        // Every edit is counted, so an auto-save can tell whether more arrived
        // while it was on the wire (autosave.js).
        // A value the PAGE wrote (loading the record fills the labels, which
        // fires an input) is not an edit and schedules nothing.
        if (on && !state.applying) { state.edits = (state.edits || 0) + 1; autosave?.edited(); }
        if (!on) autosave?.clean();
    };
    // The link adder's two controls are [data-f] because that is how this mount finds
    // its fields, but typing a link target is not an unsaved edit to the record — and
    // the picker writing into the field must not arm Save either.
    const DIRTY_SKIP = 'linktype,linktarget'.split(',');
    const dirtyish = (el) => el.matches('[data-f]') && !DIRTY_SKIP.includes(el.dataset.f);
    host.addEventListener('input', (e) => { if (dirtyish(e.target)) setDirty(true); });
    // Selects (status/type/severity/assignee/reporter) mark dirty on change too.
    host.addEventListener('change', (e) => { if (dirtyish(e.target)) setDirty(true); });
    // Reassign and set-reporter are the same gesture over two fields: focus the
    // <select> and drop its list open. A second, modal control for the same job is a
    // second thing to teach.
    host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-a="reassign"], [data-a="setreporter"]');
        if (!btn) return;
        const s = $(`[data-f="${btn.dataset.a === 'setreporter' ? 'reporter' : 'assignee'}"]`);
        if (s) { s.focus(); try { s.showPicker?.(); } catch { /* not supported */ } }
    });

    /* ── links ─────────────────────────────────────────────────────────────
       Shared by NEW and EDIT. Outgoing links are this bug's own and removable
       here; incoming ones are stored on the OTHER record (see links.js: only the
       authored direction is ever written) so they show read-only with a note
       saying where they live.

       A target may be in EITHER store, so everything here is addressed by Ref
       rather than by a bare bug number — a bare number is store-relative, and
       bug 7 and STORY-0007 are two different records.

       In `new` mode there is no bug to patch yet, so links are staged on the
       draft and written by Create — you should be able to say "this duplicates
       #52" while filing, not only afterwards. */
    const linkRow = (rel, ref, ownToken) => {
        const row = findRow(ref);
        const shown = row?.label || displayRef(ref);
        return `<div class="td-linkrow">
            <span class="td-linkrow__rel">${esc(rel)}</span>
            <button type="button" class="td-mono td-link" data-open="${esc(refKey(ref))}">${esc(shown)}</button>
            <span class="td-linkrow__title ${row?.closed ? 'td-dim' : ''}">${esc(row?.title
                || (ref.store === 'backlog' ? '(no such item)' : '(no such bug)'))}</span>
            ${ownToken
                ? `<button type="button" class="ea-btn ea-btn--small" data-unlink="${esc(ownToken)}"
                       title="Remove this link">${icon('link_off')}</button>`
                : `<span class="td-dim" title="Stored on ${esc(shown)} — remove it there">from ${esc(shown)}</span>`}
        </div>`;
    };

    const renderLinks = () => {
        const el = $('[data-slot="links"]');
        if (!el) return;
        // A draft has no id, so nothing can point at it yet.
        const selfRef = t.bugId ? bugRef(t.bugId) : null;
        const { outgoing, incoming } = linkRows(t, mode === 'new' ? null : selfRef, 'bugs', allRows());
        el.innerHTML = (outgoing.length || incoming.length)
            // `l.raw` is the token EXACTLY as stored, which is what [data-unlink] has to
            // match: a legacy token does not round-trip through formatLink (`related 5`
            // normalises to `relates-to 5`), so re-formatting it here would make Remove
            // a silent no-op on precisely the records worth rescuing.
            ? outgoing.map((l) => linkRow(linkTypeDef(l.type)?.label || l.type, l.target, l.raw)).join('')
                + incoming.map((l) => linkRow(l.label, l.target, null)).join('')
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

    /** The cross-store picker as a way INTO the target field — the field stays typable,
     *  so there are two ways in and still only one parser reading what comes out. */
    const pickLink = async () => {
        const picked = await openRecordPicker({
            title: 'Link to…',
            stores: storesAvailable(),
            exclude: t.bugId ? bugRef(t.bugId) : 0,
        });
        if (!picked?.target || !host.isConnected) return;
        const f = $('[data-f="linktarget"]');
        if (f) f.value = formatRef(picked.target, 'bugs');
    };

    host.addEventListener('click', async (e) => {
        // [data-open] carries a refKey, not a bare id: backlog_pages.js keeps [data-goto]
        // for bare backlog ids, and one attribute name meaning two different things
        // across two mounts is a silent wrong-store navigation waiting to happen.
        const open = e.target.closest('[data-open]');
        if (open) {
            const ref = parseKey(open.dataset.open);
            if (!ref || !openRow(ctx.wm, ctx, ref, { ev: e }))
                statusLine(`${ref ? displayRef(ref) : open.dataset.open} is not in the store.`);
            return;
        }
        const rm = e.target.closest('[data-unlink]');
        if (rm) {
            await commitLinks(withoutLink(t.links, rm.dataset.unlink, 'bugs'));
            return;
        }
        if (e.target.closest('[data-a="picklink"]')) { await pickLink(); return; }
        if (e.target.closest('[data-a="addlink"]')) {
            const type = $('[data-f="linktype"]')?.value;
            const target = parseRef(($('[data-f="linktarget"]')?.value || '').trim(), 'bugs');
            const selfRef = t.bugId ? bugRef(t.bugId) : null;
            const problem = validateNewLink(t, selfRef, type, target, 'bugs');
            if (problem) { statusLine(problem); return; }
            if (!findRow(target)) { statusLine(`${displayRef(target)} is not in the store.`); return; }
            // canonRef re-derives the prefix from the record actually found, so typing
            // STORY-7 at an epic stores EPIC-0007 rather than a prefix already stale.
            await commitLinks([...(t.links || []), formatLink(type, canonRef(target), 'bugs')]);
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

    /* Custom fields (Settings › Record types) and the built-ins this type hides.
     * Both follow the Type select, because a Regression may carry fields, or
     * hide fields, that a Bug does not. */
    let customFieldsCtl = null;
    const syncTypeRows = () => {
        const type = machineType(fval('type')) || 'bug';
        for (const f of ['severity', 'subsystem', 'labels', 'links', 'resolution']) {
            setRowVisible(host.querySelector(`[data-row="${f}"]`), !isHidden('bugs', type, f));
        }
        customFieldsCtl?.setType(type);
    };
    if (mode !== 'search') {
        const slot = host.querySelector('[data-slot="customfields"]');
        if (slot) {
            customFieldsCtl = mountCustomFields(slot, {
                store: 'bugs', type: machineType(typeLabelOf(t.type)) || 'bug',
                values: t.fields || {}, creating: mode === 'new',
                onChange: () => setDirty(true),
            });
        }
        host.querySelector('[data-f="type"]')?.addEventListener('change', syncTypeRows);
        syncTypeRows();
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

    /* The link adder (BUG-0011): the type is the app's own dropdown rather than
     * the browser's <select>, and the target field searches as you type. Enter
     * in a filled field with no suggestion list open is "Link". */
    const linkWidgets = [];
    if (mode !== 'search') {
        const typeEl = host.querySelector('[data-f="linktype"]');
        if (typeEl) linkWidgets.push(attachSelect(typeEl, { options: LINK_TYPES.map((d) => ({ value: d.type, label: d.label })) }));
        linkWidgets.push(attachRecordTypeahead(host.querySelector('[data-f="linktarget"]'), {
            stores: storesAvailable(), selfStore: 'bugs',
            exclude: () => (t.bugId ? bugRef(t.bugId) : null),
            onEnter: () => host.querySelector('[data-a="addlink"]')?.click(),
        }));
    }

    /** Every sub-widget this mount owns, torn down together. */
    const destroyWidgets = () => {
        for (const w of linkWidgets) { try { w.destroy(); } catch { /* already gone */ } }
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
        let resultsMass = null;
        const disposeResults = () => {
            resultsMass?.destroy();
            resultsMass = null;
            resultsTable?.dispose();
            resultsTable = null;
        };
        const doSearch = () => {
            const text = (fval('summary') + ' ' + fval('desc')).trim().toLowerCase();
            const status = fval('status'), type = fval('type'), subsystem = fval('subsystem').toLowerCase();
            // Finished work is left out unless asked for. A store accumulates
            // closed records forever, and after a year they are most of what a
            // bare search returns — burying the handful of live ones the search
            // was for. Asking for a status explicitly still wins: somebody who
            // typed "closed" into the Status field means it.
            // "#42" is bug 42 and "#STORY-0007" is that item: one record, found
            // whatever its status, the same rule the Search box (Ctrl+K) applies.
            const exact = text.startsWith('#') ? parseRef(text.slice(1), 'bugs') : null;
            const closedWanted = !!exact || host.querySelector('[data-f="includeClosed"]')?.checked
                || (status && status !== '(any)' && status === 'closed');
            const bugs = TICKETS.filter((tk) => {
                if (exact) return exact.store === 'bugs' && Number(tk.bugId) === exact.id;
                if (!closedWanted && isClosed(tk)) return false;
                if (text && !tk.summary.toLowerCase().includes(text)) return false;
                if (subsystem && !String(tk.subsystem || '').toLowerCase().includes(subsystem)) return false;
                if (status && status !== '(any)' && tk.status !== status) return false;
                if (type && type !== '(any)' && typeLabelOf(tk.type) !== type) return false;
                return true;
            }).map((tk) => ({ ...tk, store: 'bugs', ref: tk.id, closed: isClosed(tk) }));

            // BOTH stores. A search that only knows about bugs is a search that
            // cannot find the story you filed ten minutes ago, and there is no
            // reason for the user to have to remember which of the two a thing
            // went into before they can look for it. The bug-only fields
            // (status, type) are ignored for backlog rows rather than excluding
            // them: an unset field means "don't care", not "bugs only".
            const wantsBugFields = (status && status !== '(any)') || (type && type !== '(any)');
            const items = wantsBugFields && !exact ? [] : ITEMS.filter((i) => {
                if (exact) return exact.store === 'backlog' && Number(i.id) === exact.id;
                if (!closedWanted && isClosedItem(i)) return false;
                if (text && !String(i.title || '').toLowerCase().includes(text)) return false;
                if (subsystem && !String(i.subsystem || '').toLowerCase().includes(subsystem)) return false;
                return true;
            }).map((i) => ({
                store: 'backlog', ref: i.ref, id: i.ref, bugId: i.id,
                summary: i.title, type: i.typeLabel, status: i.statusLabel,
                sla: i.updated, assignee: i.assignee, closed: isClosedItem(i), fields: i.fields || {},
            }));

            const matches = [...bugs, ...items];
            disposeResults();
            const heldBugs = closedWanted ? 0 : TICKETS.filter((tk) => isClosed(tk)).length;
            const heldItems = closedWanted ? 0 : ITEMS.filter(isClosedItem).length;
            const held = heldBugs + heldItems;
            resultsEl.innerHTML = `<section class="td-group"><div class="td-group__title">Results — ${bugs.length} bug${bugs.length === 1 ? '' : 's'}${items.length ? `, ${items.length} backlog item${items.length === 1 ? '' : 's'}` : ''}${held ? ` <span class="td-dim">· ${held} closed not searched</span>` : ''}<span class="td-spacer"></span><button class="ea-btn" data-a="select" aria-pressed="false" hidden></button></div><div class="td-tablehost"></div></section>`;
            // Bug id is column 0 here (no Pri column), so the menu's row →
            // id mapping differs from the queue's; the two share nothing but
            // the idea.
            const resultIds = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
                .map((r) => r?.[0]).filter(Boolean);
            const byRef = new Map(matches.map((m) => [m.ref, m]));
            /** A result opens in the page its OWN store uses. */
            /** The page and props a result opens as: its OWN store's page. */
            const resultTarget = (ref) => {
                const m = byRef.get(ref);
                if (!m) return null;
                return m.store === 'backlog'
                    ? { kind: KIND.item, props: { id: String(m.bugId), label: `${m.ref} — ${m.summary}` } }
                    : { kind: 'ticket', props: { id: m.id, label: `${m.id} — ${m.summary}` } };
            };
            const openResult = (ref, opts) => {
                const target = resultTarget(ref);
                if (!target) return;
                if (ctx.wm?.navigate) ctx.wm.navigate(target.kind, target.props, { ctx, ...opts });
                else ctx.wm?.openInTabFromContext?.(ctx, target.kind, target.props);
            };
            // STORY-0029. Mass actions over the ticked results, of either store.
            resultsMass = massActionBar(resultsEl.querySelector('.td-tablehost'), {
                toggle: resultsEl.querySelector('[data-a="select"]'),
                recordsOf: (indices, t) => indices.map((i) => byRef.get(t.config.rows[i]?.[0])).filter(Boolean).map((m) => {
                    if (m.store === 'bugs') { const tk = TICKETS.find((x) => x.id === m.id); return tk ? bugRecord(tk) : null; }
                    const it = ITEMS.find((x) => Number(x.id) === Number(m.bugId));
                    return it ? itemRecord(it) : null;
                }).filter(Boolean),
                report: statusLine,
                afterChange: async () => {
                    await loadData();
                    try { await loadBacklog(); } catch { /* backlog-less store */ }
                    _eventBus?.emit?.('bugs:changed', { store: 'bugs' });
                    _eventBus?.emit?.(ev('backlog:changed'), {});
                    doSearch();
                },
            });
            resultsTable = createTable(resultsEl.querySelector('.td-tablehost'), {
                ...resultsMass.tableOptions,
                // The results are rebuilt on every search, so this is how a sort
                // you chose survives running the next one.
                ...(ctx?.tableStore ? { stateStore: ctx.tableStore, persistKey: `bugs:search${SEARCH_SIG}` } : {}),
                host: ctx?.host,
                exportFilename: 'search-results.csv',
                // A new search starts on its first page, not the last one's.
                persistPage: false,
                headers: ['Ref', 'Store', 'Type', 'Summary', 'Status', 'Updated', 'Assignee',
                          ...SEARCH_CUSTOM.map((f) => f.label || f.name)],
                rows: matches.map((m) => [m.ref, m.store === 'backlog' ? 'Backlog' : 'Bugs',
                                          m.type, m.summary, m.status, m.sla, m.assignee,
                                          ...SEARCH_CUSTOM.map((f) => displayValue(f, m.fields?.[f.name]))]),
                // Custom fields of either store, hidden until picked from the header menu.
                ...(SEARCH_CUSTOM.length ? {
                    hiddenColumns: SEARCH_CUSTOM.map((_, i) => 7 + i), columnChooser: true,
                    sortValue: Object.fromEntries(SEARCH_CUSTOM.map((f, i) => [7 + i, (_v, _c, row) => {
                        const m = byRef.get(row[0]);
                        return schemaSortValue(f, m?.fields?.[f.name]) ?? undefined;
                    }])),
                } : {}),
                pagination: true, selectable: true, copyable: true, sortable: true, mode: 'compact',
                onRender: paintRecordCount,
                emptyMessage: 'Nothing matches the criteria',
                contextMenuItems: (cm) => {
                    const n = resultIds(cm).length;
                    const m = cm.row ? byRef.get(cm.row[0]) : null;
                    const many = resultsMass.menuItems();
                    return [
                        ...(many.length ? many : statusMenuItems(m?.store === 'bugs' ? TICKETS.find((x) => x.id === m.id) : null)),
                        { label: n > 1 ? `Open ${n} in tabs` : 'Open', icon: 'open_in_new', action: 'open', disabled: !n },
                        { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !cm.row },
                        { separator: true },
                        { label: n > 1 ? `Copy ${n} references` : 'Copy reference', icon: 'content_copy', action: 'copy-id', disabled: !n },
                    ];
                },
                onContextMenuAction: (action, cm) => {
                    if (resultsMass.runMenu(action)) return;
                    const refs = resultIds(cm);
                    if (/^(move|act):/.test(String(action))) {
                        const m = cm.row ? byRef.get(cm.row[0]) : null;
                        runStatusMenuAction(action, m?.store === 'bugs' ? TICKETS.find((x) => x.id === m.id) : null)
                            .then(() => doSearch());
                        return;
                    }
                    switch (action) {
                        case 'open': refs.forEach((r) => openResult(r, { dest: 'origin', newTab: true })); break;
                        case 'open-window': if (cm.row?.[0]) openResult(cm.row[0], { dest: 'window' }); break;
                        case 'copy-id':
                            if (refs.length) copyText(refs.join('\n'),
                                `Copied ${refs.length} reference${refs.length === 1 ? '' : 's'}.`);
                            break;
                    }
                },
                renderCell: (td, value, colIdx) => {
                    if (colIdx === 0) { td.innerHTML = `<span class="td-mono td-link">${esc(value)}</span>`; return true; }
                    if (colIdx === 1) { td.innerHTML = `<span class="td-chip">${esc(value)}</span>`; return true; }
                    return false;
                },
                rowKey: (row) => String(row[0]),
                onRowOpen: (i, row, how) => {
                    const target = resultTarget(row[0]);
                    if (target) openRecordAs(ctx.wm, ctx, target.kind, target.props, how);
                },
            });
            const table = resultsTable;
            publishRecordCount(resultsEl.querySelector('.td-tablehost'), () => ({
                shown: table.getDisplayedRows().filter((r) => byRef.get(r[0]) && !byRef.get(r[0]).closed).length,
                total: TICKETS.filter((t) => !isClosed(t)).length + ITEMS.filter((i) => !isClosedItem(i)).length,
                noun: 'records',
            }));
            resultsTable.render();
            resultsMass.attach(resultsTable);
            resultsTable.focus();
            statusLine(`Search: ${matches.length} match${matches.length === 1 ? '' : 'es'} across both stores.`);
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
            const fieldError = customFieldsCtl?.validate();
            if (fieldError) { statusLine(`Create failed: ${fieldError}`); return; }
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
                    fields: customFieldsCtl?.collect() || {},
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
        const strip = $('[data-slot="stageactions"]');
        if (!strip) return;
        const type = machineType(fval('type')) || t.rawType || 'bug';
        const closed = isClosed({ rawStatus: state.status, rawType: type });
        // The workflow buttons are written in this SAME innerHTML: the strip is
        // repainted on every stage change, so anything appended afterwards survives
        // until the first time the user moves the bug and then silently disappears.
        strip.innerHTML = bugMovesFor(state.status, type)
            .map(({ label, to: target }, i) => `<button class="ea-btn td-stageaction ${i === 0 ? 'ea-btn--primary td-stageaction--primary' : ''}" data-wf="${esc(target)}">${esc(label)}</button>`).join('')
            + actionsFor('bugs', type, state.status).map((a) =>
                `<button class="ea-btn td-stageaction td-stageaction--custom" data-wact="${esc(a.id)}">${icon('bolt')} ${esc(a.label)}</button>`).join('')
            + WORKFLOW_ACTIONS.filter((a) => a.when(closed, type)).map((a) =>
                `<button class="ea-btn td-stageaction td-stageaction--alt" data-wfa="${esc(a.id)}"
                         title="${esc(a.title)}">${icon(a.icon)} ${esc(a.label)}</button>`).join('');
    };

    // Move to a stage: reflect it in the read-only Status + chevrons, mark dirty.
    const gotoStatus = (target) => {
        state.status = target;
        state.stage = stageIndexOf(target, machineType(fval('type')) || t.rawType);
        renderStages();
        setV('status', humanizeStatus(target));
        markStatus();
        setDirty(true);
    };
    // A status the schema does not know — removed from Settings › Record types,
    // or typed into the file by hand — is shown as it is and marked, never fixed up.
    const markStatus = () => {
        const el = host.querySelector('[data-f="status"]');
        if (!el || mode === 'search') return;
        const known = statusKnown('bugs', machineType(fval('type')) || t.rawType || 'bug', state.status);
        el.classList.toggle('td-unknown', !known);
        el.title = known ? '' : `'${state.status}' is not a status this project knows. It is kept as it is; move the bug to fix it.`;
    };

    // assignee is EXPLICIT — sent to the bridge like any other field (the reassign picker sets it).
    const collectPatch = () => {
        const patch = {
            title: fval('summary'),
            status: state.status,
            type: machineType(fval('type')),
            severity: fval('severity'),
            subsystem: fval('subsystem') || 'unsorted',
            // No `|| HUMAN_AUTHOR` fallback. That is only safe because the control is
            // rendered over assigneeOptions(true, t.assignee) with no HUMAN_AUTHOR
            // preselect: the option list always contains the record's own value, so an
            // off-roster assignee round-trips and an unassigned bug stays unassigned.
            // Drop the fallback without that widening and this line saves whatever
            // option the browser happened to pick first.
            assignee: fval('assignee'),
            labels: fval('labels') ? fval('labels').split(',').map((s) => s.trim()).filter(Boolean) : [],
        };
        // Sent only when it CHANGED. An ordinary save of a record written before the
        // field existed must not insert a `reporter:` line nobody typed.
        if (fval('reporter') !== (t.reporter || '')) patch.reporter = fval('reporter');
        if (fval('resolution') !== (t.resolution || '')) patch.resolution = fval('resolution');
        // Only the custom fields that changed — see custom_fields.js.
        const fields = customFieldsCtl?.collect() || {};
        if (Object.keys(fields).length) patch.fields = fields;
        // What a move saves besides its status — its message, and whatever its
        // flow set or cleared (Settings › Workflow) — over the form's values: the
        // move ran after them, so its "clear the assignee" wins.
        if (state.moveMessage) {
            const { fields: moveFields, ...rest } = state.moveMessage;
            Object.assign(patch, rest);
            if (moveFields) patch.fields = { ...(patch.fields || {}), ...moveFields };
        }
        return patch;
    };

    const applyBug = (bug) => {
        state.applying = true;
        try { fillBug(bug); } finally { state.applying = false; }
    };
    const fillBug = (bug) => {
        setV('summary', bug.title);
        setV('status', humanizeStatus(bug.status));
        setV('severity', bug.severity);
        setV('subsystem', bug.subsystem || '');
        setV('labels', (bug.labels || []).join(', '));
        setV('type', typeLabelOf(typeCode(bug.type)));
        setV('assignee', bug.assignee || '');
        setV('reporter', bug.reporter || '');
        setV('resolution', bug.resolution || '');
        setV('updated', formatStamp(bug.updated) || '—');
        state.updated = bug.updated || '';
        customFieldsCtl?.set(bug.fields || {});
        syncTypeRows();
        const conv = host.querySelector('[data-slot="converted"]');
        if (conv) conv.innerHTML = convertedBanner(bug);
        state.status = bug.status || 'open';
        state.stage = stageIndexOf(state.status, bug.type);
        renderStages();
        markStatus();
        Object.assign(t, {
            summary: bug.title, status: humanizeStatus(bug.status), rawStatus: bug.status,
            assignee: bug.assignee || HUMAN_AUTHOR, reporter: bug.reporter || '', resolution: bug.resolution || '',
            severity: bug.severity, subsystem: bug.subsystem || 'unsorted',
            stage: bug.stage, sla: formatStamp(bug.updated), type: typeCode(bug.type), pri: SEV_PRI[bug.severity] || 3,
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
    // The author is named ONCE: the badge beside the name repeated it. The
    // human/agent distinction it carried is still there, in the avatar and the
    // note's coloured edge. A status change's message gets the whole entry
    // marked (`--move`) and its tag at the right of the header, so a decision
    // does not read as another remark.
    // `idx` is the comment's position in the FILE (oldest first) — what an edit is
    // addressed by, whatever order the thread is drawn in.
    const commentHTML = (c, idx) => `
        <div class="td-wentry td-wentry--${c.author === HUMAN_AUTHOR ? 'human' : 'agent'}${c.note ? ' td-wentry--move' : ''}" data-cidx="${idx}">
            <span class="td-avatar">${esc(initials(c.author))}</span>
            <div>
                <div class="td-wentry__head">
                    <b>${esc(c.author)}</b>
                    <span class="td-dim td-mono">${esc(formatStamp(c.date))}</span>
                    ${statusTag(c.note)}
                    ${editButtonHTML()}
                </div>
                <div class="td-wentry__text td-md">${md(c.body)}</div>
            </div>
        </div>`;
    // The active tab lives OUT here, not inside the slot renderComments wipes on every
    // post, save, cancel, live reload and initial load. `$$` is host-scoped, so two open
    // ticket tiles cannot cross-toggle each other's tabs.
    let recordTab = 'comments';
    const showTab = (name) => {
        recordTab = name === 'history' ? 'history' : 'comments';
        $$('.td-tab').forEach((b) => {
            const on = b.dataset.tab === recordTab;
            b.classList.toggle('td-tab--on', on);
            b.setAttribute('aria-selected', String(on));
        });
        const c = $('[data-slot="comments"]'), h = $('[data-slot="history"]'), n = $('[data-slot="tabnote"]');
        if (c) c.hidden = recordTab !== 'comments';
        if (h) h.hidden = recordTab !== 'history';
        if (n) n.textContent = recordTab === 'comments' ? `— posted as ${HUMAN_AUTHOR}` : '— newest first';
    };
    // A delegated listener on `host` needs no removal — `host` is the shell's content
    // slot, discarded wholesale on the next mount.
    host.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) showTab(b.dataset.tab);
    });
    // History rides on the bug object from fetchBug / patchBug / postComment /
    // duplicateBug, so painting this pane costs no request.
    const renderHistoryPane = (bug) => {
        const el = $('[data-slot="history"]');
        if (el) renderHistory(el, bug);
    };

    /** One place where a fresh record becomes the rendered page, so no caller has to
     *  remember which panes a write invalidates. */
    const applyRecord = (bug) => {
        applyBug(bug); renderDesc(bug); renderComments(bug); renderHistoryPane(bug); renderLinks();
        showTab(recordTab);
    };

    let composer = null;   // the live markdown editor, torn down on re-render
    let commentEditing = null;   // the pencils on the thread, likewise
    const renderComments = (bug) => {
        const el = cmtHost();
        if (!el) return;
        try { composer?.destroy(); } catch { /* previous mount already gone */ }
        composer = null;
        try { commentEditing?.destroy(); } catch { /* previous mount already gone */ }
        commentEditing = null;
        // NEWEST FIRST. The composer sits at the top, so the reply you just
        // wrote appears where you are looking instead of scrolling away below
        // a year of history.
        const thread = bug.comments || [];
        const comments = thread.map((c, idx) => [c, idx]).reverse();
        el.innerHTML = `
            <div class="td-composer">
                <span class="td-avatar">${esc(initials(HUMAN_AUTHOR))}</span>
                <div class="td-composer__box">
                    <textarea class="ea-tin td-area" rows="2"
                        placeholder="Add a comment as ${esc(HUMAN_AUTHOR)}… (Enter posts, Alt+Enter for a new line, paste a screenshot to attach it)"></textarea>
                </div>
            </div>
            <div class="td-wstream">${comments.length ? comments.map(([c, idx]) => commentHTML(c, idx)).join('') : '<div class="td-dim">No comments yet.</div>'}</div>`;
        if (t.bugId) {
            commentEditing = attachCommentEditing(el.querySelector('.td-wstream'), {
                comments: thread, path: `/bugs/${t.bugId}`, onStatus: statusLine,
                onSaved: (answer) => applyRecord(answer.bug),
            });
        }

        const ta = el.querySelector('textarea');
        const post = async (text) => {
            if (!text) { statusLine('Nothing to post.'); return; }
            if (!t.bugId) { statusLine('Local bug — cannot comment.'); return; }
            try {
                const updated = await postComment(t.bugId, text, HUMAN_AUTHOR);
                applyRecord(updated);
                statusLine('Comment added.');
            } catch (err) { statusLine(`Comment failed: ${err.message}`); }
        };
        composer = attachMarkdownEditor(ta, {
            onSubmit: post,
            submitLabel: 'Comment',
            onStatus: statusLine,
        });
    };

    const save = async ({ auto = false } = {}) => {
        if (!t.bugId) { statusLine('Local bug — nothing to persist.'); return; }
        const fieldError = customFieldsCtl?.validate();
        if (fieldError) {
            statusLine(`Not saved: ${fieldError}`);
            if (auto) throw new Error(fieldError);
            return;
        }
        // AN AUTO-SAVE DOES NOT REDRAW THE FORM: somebody may be typing. It says
        // which version it started from, so a file changed on disk meanwhile is
        // refused rather than overwritten, and it moves the baseline only.
        const editsAtStart = state.edits || 0;
        try {
            const patch = collectPatch();
            if (auto) { patch.autosave = true; if (state.updated) patch.expectUpdated = state.updated; }
            state.moveMessage = null;
            const updated = await patchBug(t.bugId, patch);
            if (auto) {
                state.updated = updated.updated || state.updated;
                customFieldsCtl?.rebase(updated.fields || {});
                setV('updated', formatStamp(updated.updated) || '—');
                if ((state.edits || 0) === editsAtStart) { state.dirty = false; const a = $('[data-a="save"]'), c = $('[data-a="cancel"]'); if (a) a.disabled = true; if (c) c.disabled = true; }
                live.clear();
                return;
            }
            applyRecord(updated);
            live.clear();
            autosave?.saved();
            statusLine(`Bug #${t.bugId} saved.`);
        } catch (err) {
            if (auto) throw err;
            statusLine(`Save failed: ${err.message}`);
        }
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
            applyRecord(bug);
            statusLine('Reverted unsaved changes.');
        } catch (err) { statusLine(`Revert failed: ${err.message}`); }
    };

    // Change stage AND persist it — one POST, which the bridge also records as a
    // `status` line in the record's ## History.
    // A move that needs a message asks for it first (or reuses a comment you
    // posted in the last five minutes); cancelling the dialog cancels the move.
    const applyStage = async (target, label) => {
        if (!target) return;
        if (t.bugId) {
            const type = machineType(fval('type')) || t.rawType || 'bug';
            const moves = bugMovesFor(state.status, type);
            const move = moves.find((m) => m.to === target && m.label === label) || moves.find((m) => m.to === target);
            if (!move) return;
            // The flow reads the record as it is on disk, with its comments for
            // the five-minute message rule; the move is then this page's ONE save.
            let bug = null;
            try { bug = await fetchBug(t.bugId); } catch { /* the plan asks rather than guesses */ }
            let patch;
            try {
                patch = await planBugMove({
                    bugId: t.bugId, bug: bug || { id: t.bugId, status: state.status, comments: [] },
                    move, from: state.status, title: t.summary || '',
                });
            } catch (err) { statusLine(`${label}: ${err?.message || err}`); return; }
            if (!patch) { statusLine('Status unchanged.'); return; }
            const { status: next, ...extra } = patch;
            state.moveMessage = Object.keys(extra).length ? extra : null;
            gotoStatus(next || target);
        } else {
            gotoStatus(target);
        }
        await save();
    };

    // Chevrons are display-only — the lifecycle is driven exclusively by the
    // Action buttons below, so only the moves bugMoves() offers are reachable
    // from the UI.
    host.addEventListener('click', (e) => {
        const wf = e.target.closest('[data-wf]');
        if (wf) { applyStage(wf.dataset.wf, wf.textContent.trim()); return; }
        const wact = e.target.closest('[data-wact]');
        if (wact) applyAction(wact.dataset.wact);
    });

    // One of the project's actions (Settings › Workflow): its flow, then this
    // page's ONE save, as a move is — and a cancelled question saves nothing.
    const applyAction = async (id, given = null) => {
        const type = machineType(fval('type')) || t.rawType || 'bug';
        const act = given || actionsFor('bugs', type, state.status).find((a) => a.id === id);
        if (!act || !t.bugId) return;
        let bug = null;
        try { bug = await fetchBug(t.bugId); } catch { /* the plan asks rather than guesses */ }
        let patch;
        try {
            patch = await planBugMove({
                bugId: t.bugId, bug: bug || { id: t.bugId, status: state.status, comments: [] },
                move: { label: act.label, message: false, flow: act.flow || null }, from: state.status, title: t.summary || '',
            });
        } catch (err) { statusLine(`${act.label}: ${err?.message || err}`); return; }
        if (!patch) { statusLine(`${act.label}: cancelled, nothing changed.`); return; }
        if (!host.isConnected) return;   // the tile closed while a question was open
        const { status: next, ...extra } = patch;
        state.moveMessage = Object.keys(extra).length ? extra : null;
        if (next) gotoStatus(next); else setDirty(true);
        await save();
    };

    autosave = mode === 'edit' && t.bugId ? attachAutosave({
        statusEl: $('[data-slot="savestate"]'),
        isDirty: () => state.dirty,
        save,
        ref: () => `BUG-${t.bugId}`,
    }) : null;

    const actions = { save: () => save(), cancel };
    const onAction = (e) => {
        const btn = e.target.closest('[data-a]');
        if (btn && actions[btn.dataset.a]) actions[btn.dataset.a]();
    };
    host.addEventListener('click', onAction);
    // The floating bar is a sibling of `host`, so the mask's delegation
    // never sees its clicks — bind it too.
    actionsEl?.addEventListener('click', onAction);

    renderStages();

    // The file this page is showing can change under it. Clean → take the new
    // version silently; dirty → the user chooses, because discarding their
    // edits to show somebody else's is not a decision to make for them.
    const live = watchRecord({
        host,
        store: 'bugs',
        id: () => t.bugId,
        isDirty: () => state.dirty,
        onStatus: statusLine,
        eventBus: _eventBus,
        onReload: async () => {
            if (!t.bugId) return;
            try {
                const bug = await fetchBug(t.bugId);
                applyRecord(bug);
            } catch (err) { statusLine(`Reload failed: ${err.message}`); }
        },
    });

    /* Marking a duplicate is ONE act with four consequences — a link, a closed status,
     * a history line, and a comment on each side — so it is one save: the type's
     * default Duplicate action (STORY-0050), whose flow picks the master, adds the
     * link and the courtesy comment on it, sets the resolution and closes. No
     * confirmation dialog: the picker IS the confirmation, and Reopen is one click. */
    const markDuplicate = async () => {
        if (!t.bugId) { statusLine('Local bug — nothing to close.'); return; }
        const type = machineType(fval('type')) || t.rawType || 'bug';
        await applyAction('duplicate', defaultActions('bugs', type)[0]);
    };

    // [data-wfa], not [data-wf]: a `data-wf` value is a target STATUS, and these are not
    // statuses, so they get their own attribute rather than a lookalike one.
    const deleteThis = async () => {
        const stored = TICKETS.find((x) => x.bugId === t.bugId) || t;
        if (!(await confirmDeleteBug(stored))) return;
        live.clear();
        // The record is gone; leave its page the way Backspace would — back to the
        // list it was opened from.
        ctx.wm?.navigateBack?.();
    };
    // Feature work filed as a bug: it moves to the backlog, and this page follows it.
    const convertThis = async () => {
        if (state.dirty) { statusLine('Save or cancel your edits first — the conversion copies what is on disk.'); return; }
        try {
            const made = await convertRecord({ from: formatRef(bugRef(t.bugId), 'backlog'), store: 'bugs', title: t.summary || '' });
            if (!made) { statusLine('Not converted.'); return; }
            await loadData();
            await loadBacklog();
            _eventBus?.emit?.('bugs:changed', { store: 'bugs', id: t.bugId });
            _eventBus?.emit?.(ev('backlog:changed'), { id: made.id });
            live.clear();
            statusLine(`#${t.bugId} converted to ${made.ref}.`);
            openRow(ctx.wm, ctx, { store: 'backlog', id: made.id });
        } catch (err) { statusLine(`Could not convert: ${err?.message || err}`); }
    };
    const WF_ACTIONS = { duplicate: markDuplicate, delete: deleteThis, convert: convertThis };
    host.addEventListener('click', (e) => {
        const a = e.target.closest('[data-wfa]');
        if (a) { WF_ACTIONS[a.dataset.wfa]?.(); }
    });

    (async () => {
        // Inbound cross-store rows cannot be predicted from the record in hand — that is
        // the whole point of deriving them — so the other store is loaded once, up front,
        // never "only if my own links happen to mention it".
        if (!ITEMS.length && storesAvailable().includes('backlog')) {
            try { await loadBacklog(); } catch { /* backlog-less store */ }
            if (!host.isConnected) return;   // the tile closed while we were loading
        }
        if (!t.bugId) {
            const el = $('[data-slot="desc"]');
            if (el) el.innerHTML = '<span class="td-dim">Unsaved local bug — not persisted, no description or comments.</span>';
            renderComments({ comments: [] });
            renderHistoryPane({ comments: [], history: [], created: '' });
            renderLinks();   // never leave the Links slot stuck on "Loading…"
            return;
        }
        try {
            const bug = await fetchBug(t.bugId);
            applyRecord(bug);
        } catch (err) {
            const el = $('[data-slot="desc"]');
            if (el) el.innerHTML = `<span class="td-dim">Failed to load bug ${esc(String(t.bugId))}: ${esc(err.message)}</span>`;
            renderComments({ comments: [] });
            renderHistoryPane({ comments: [], history: [], created: '' });
            renderLinks();   // never leave the Links slot stuck on "Loading…"
        }
    })();

    return {
        title: ticketLabel(t),
        destroy: () => {
            live.dispose();
            destroyWidgets();
            // `actionsEl` is the SHELL's slot, not this mount's DOM, so it outlives the
            // tile and the handler would otherwise pile up one per ticket opened.
            actionsEl?.removeEventListener('click', onAction);
            try { composer?.destroy(); } catch { /* already gone */ }
            try { commentEditing?.destroy(); } catch { /* already gone */ }
            try { customFieldsCtl?.destroy(); } catch { /* already gone */ }
            try { autosave?.destroy(); } catch { /* already gone */ }
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
            ${MODEL.unknownFields(f.expr).length
                ? `<span class="td-nav__warn" title="Names a field this project no longer has: ${esc(MODEL.unknownFields(f.expr).join(', '))}">${icon('warning')}</span>`
                : ''}
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
 *
 * Above the section's own body sits its Dashboards group (STORY-0046,
 * dashboards/rail.js): there is no Dashboards chip, so each section lists the
 * dashboards that belong to it. Its own slot, outside `body`, so the bug rail's
 * delegated handlers never see a dashboard row.
 */
function mountTicketNav(host, props, ctx) {
    const open = (kind, p) => ctx.wm?.openInPrimary?.(kind, p);
    const openFilter = (f) => open('queues', { filter: f.key || f.id, label: f.label });

    // ctx.wm is threaded in by the renderer; the global is the escape hatch for
    // a mount that runs before that happens (the same fallback FlexDesk's breadcrumb uses).
    const getWm = () => ctx?.wm || window.__twm?.wm || null;

    let shown = null;            // 'bugs' | 'backlog' | 'tracker' (see panelSection)
    let backlogRail = null;      // the Backlog body's controller, mounted lazily
    let dashRail = null;         // the Dashboards group's controller, for `dashSection`
    // Bumped by every show() and by destroy. The backlog rail mounts after an
    // await, and `wm:changed` fires in bursts: without this, a switch that
    // finished late mounted the backlog rail over the bug rail (with `shown`
    // still 'bugs', so BOTH click handlers answered), or a second backlog mount
    // replaced the first without destroying it — whose leaked listeners then
    // answered clicks on the bug rail. Either way a filter opened the store
    // you were not in.
    let generation = 0;
    let mounted = 0;             // the generation whose rail is actually on screen

    host.classList.add('bd-rail');
    host.innerHTML = `<div class="bd-rail__body">
        <div class="bd-rail__dashboards" data-slot="dashboards"></div>
        <div data-slot="railbody"></div>
    </div>`;
    const body = host.querySelector('[data-slot="railbody"]');
    const dashBody = host.querySelector('[data-slot="dashboards"]');

    /** The section's dashboards. Standalone TicketDesk's one section is the
     *  tracker, though its rail is this copy's backlog rail. */
    let dashGeneration = 0;
    let dashWanted = null;       // the section asked for last, mounted or on the way
    const showDashboards = async (section) => {
        const dashSection = CONFIG.mode === 'tracker' ? 'tracker' : section;
        if (dashWanted === dashSection) return;
        dashWanted = dashSection;
        const mine = ++dashGeneration;
        const { mountDashboardsRail } = await import('../dashboards/rail.js');
        if (mine !== dashGeneration) return;
        try { dashRail?.destroy(); } catch { /* not mounted */ }
        dashRail = mountDashboardsRail(dashBody, ctx, { section: dashSection, eventBus: _eventBus });
    };

    const show = async (next) => {
        // Already showing it — or already on the way to it.
        if (next === shown && (body.childElementCount || mounted !== generation)) return;
        const mine = ++generation;
        shown = next;
        try { backlogRail?.destroy(); } catch { /* not mounted */ }
        backlogRail = null;
        body.innerHTML = '';
        showDashboards(next);
        if (next === 'bugs') { renderFilters(); mounted = mine; return; }
        // Imported lazily so the bug rail — the thing on screen at boot — never
        // waits on the backlog module to parse.
        const { mountBacklogRail } = next === 'tracker'
            ? await trackerModule('backlog_pages.js')
            : await import('./backlog_pages.js');
        if (mine !== generation) return;     // superseded while loading
        backlogRail = mountBacklogRail(body, ctx);
        mounted = mine;
    };

    /** Follow the top nav. An unresolvable section (nothing focused yet) leaves
     *  whatever is already showing rather than flickering back to Bugs. */
    const syncToTopNav = () => {
        const topNav = activeTopNavKind(getWm());
        if (!topNav) { if (!shown) show('bugs'); return; }
        // The Tracker dashboard is a view over the backlog store, so it gets the
        // backlog rail: its saved filters and its project tree are exactly what
        // you want one click away from "who has what". A dashboard page is a
        // page of its section (STORY-0046), so it gets that section's rail.
        show(panelSection(topNav));
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

    // GUARDED on `shown`. These are delegated onto the shared panel body, which
    // the backlog rail also mounts into — so without the guard a click on a
    // backlog filter row fires this handler too. Both stores have a builtin
    // keyed `active`, so clicking the backlog's "In progress" resolved `active`
    // against the BUG builtins and navigated to Queues.
    const onBugRailClick = (e) => {
        if (shown !== 'bugs') return;
        if (e.target.closest('[data-new]')) { newFilter(); return; }
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        const btn = e.target.closest('.td-nav__action');
        if (btn) { runAction(btn.dataset.act, row.dataset.filter, !!row.dataset.custom); return; }
        runAction('open', row.dataset.filter, !!row.dataset.custom);
    };

    // Keyboard: the rows are role="button", so Enter/Space must activate
    // them like a click. The action buttons are native <button>s and need
    // nothing (their click handler above already covers them).
    const onBugRailKey = (e) => {
        if (shown !== 'bugs') return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.td-nav__action')) return;
        if (e.target.matches('[data-new]')) { e.preventDefault(); newFilter(); return; }
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        e.preventDefault();
        runAction('open', row.dataset.filter, !!row.dataset.custom);
    };

    const onBugRailMenu = (e) => {
        if (shown !== 'bugs') return;
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
    };

    body.addEventListener('click', onBugRailClick);
    body.addEventListener('keydown', onBugRailKey);
    body.addEventListener('contextmenu', onBugRailMenu);

    return {
        title: 'Filters',
        destroy: () => {
            generation++;                    // a backlog mount still loading must not land
            dashGeneration++;
            try { dashRail?.destroy(); } catch { /* not mounted */ }
            unsub();
            focusSub?.dispose?.();
            body.removeEventListener('click', onBugRailClick);
            body.removeEventListener('keydown', onBugRailKey);
            body.removeEventListener('contextmenu', onBugRailMenu);
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
    <div class="td-mrow" data-member="${esc(m.name)}" role="button" tabindex="0"
         title="${esc(m.name)} — ${m.inc} in flight. Click to see them.">
        <span class="td-avatar">${m.initials}<span class="td-presence td-presence--${m.presence}"></span></span>
        <span class="td-mrow__name">${m.me ? `<b>${esc(m.name)} (you)</b>` : esc(m.name)}</span>
        <span class="td-mrow__counts"><span class="td-inc">${m.inc} ${esc(m.openLabel || 'open')}</span> · ${m.other} ${esc(m.doneLabel || 'closed')}</span>
        <span class="td-loadbar"><span class="td-loadbar__fill td-loadbar__fill--${loadClass(m.load)}" style="width:${Math.round(m.load * 100)}%"></span></span>
    </div>`;
}

/** The backlog's equivalent of data.js's TEAM: one row per assignee, weighted
 *  by the items still in flight. Built here rather than in backlog_data.js
 *  because the shape it produces exists only to feed memberRow.
 *
 *  Which names get a row is teamNames()'s decision, shared with the bug store:
 *  the roster, plus anyone carrying work that is still open. */
export function backlogTeam(items) {
    const open = new Map(), done = new Map(), seen = new Map();
    for (const i of items) {
        const who = String(i.assignee || '').trim();
        if (!who) continue;                       // unassigned is not a person
        const key = who.toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: who, open: 0 });
        const bucket = (i.status === 'done' || i.status === 'dropped') ? done : open;
        bucket.set(key, (bucket.get(key) || 0) + 1);
    }
    for (const [key, entry] of seen) entry.open = open.get(key) || 0;

    const names = teamNames(seen);
    const maxOpen = Math.max(1, ...names.map((n) => open.get(n.toLowerCase()) || 0));
    return names.map((name) => {
        const key = name.toLowerCase();
        return {
            name,
            initials: initials(name),
            presence: (open.get(key) || 0) > 0 ? 'online' : 'away',
            inc: open.get(key) || 0,
            other: done.get(key) || 0,
            openLabel: 'in flight',
            doneLabel: 'done',
            load: Math.round(((open.get(key) || 0) / maxOpen) * 100) / 100,
            me: key === HUMAN_AUTHOR.toLowerCase(),
        };
    });
}

function mountTicketInspector(host, props, ctx) {
    const getWm = () => ctx?.wm || window.__twm?.wm || null;

    // Which store the rows are about, remembered from the last paint — a click
    // has to route to the same store the number was counted from, and the
    // top nav can move between the two.
    let showing = null;

    /**
     * Repaint, but ONLY when something is actually different.
     *
     * `wm:changed` fires on every focus change, and focusing happens on
     * MOUSEDOWN — so an unguarded repaint replaced this panel's DOM between the
     * press and the release of the user's own click. The row they pressed no
     * longer existed by mouseup, so the browser dispatched `click` on an
     * ancestor instead, `closest('[data-member]')` found nothing, and clicking a
     * name did nothing at all. It looked like a dead handler; it was the panel
     * pulling the row out from under the click.
     *
     * Invisible to a test that calls `.click()`, which is why this survived
     * three attempts to find it. The left rail never had the bug because it
     * early-returns when the section it is showing has not changed — this now
     * does the same, and the row identity is asserted in the DOM tests.
     */
    const render = async ({ force = false } = {}) => {
        const next = panelSection(activeTopNavKind(getWm()));
        const backlog = next !== 'bugs';
        if (!force && next === showing && host.childElementCount) return;
        showing = next;
        let rows = [];
        let empty = '';
        if (next === 'tracker') {
            // The tracker's own team: its tickets, its roster, its "you".
            const [{ ITEMS }, tracker] = await Promise.all([
                trackerModule('backlog_data.js'), trackerModule('pages.js')]);
            rows = tracker.backlogTeam(ITEMS);
            empty = ITEMS.length ? 'No ticket has an assignee yet.' : 'No tickets yet.';
        } else if (backlog) {
            const { ITEMS } = await import('./backlog_data.js');
            rows = backlogTeam(ITEMS);
            empty = ITEMS.length
                ? 'No backlog item has an assignee yet.'
                : 'No backlog items yet.';
        } else {
            rows = TEAM;
            empty = TICKETS.length ? 'No bug has an assignee yet.' : 'No bugs yet.';
        }
        // Who is actually carrying something, now that the roster puts an
        // idle colleague on the list too. `presence !== 'offline'` counted
        // every row ever built — a badge that could only ever read "N/N".
        const active = rows.filter((m) => m.inc > 0).length;
        host.innerHTML = `
            <div class="td-rpanel">
                <div class="twm-bp__tabs td-rpanel__tabs">
                    <button class="twm-bp__tab twm-bp__tab--on">${
                        next === 'tracker' ? 'Tracker team' : backlog ? 'Backlog team' : 'Bug team'}</button>
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

    /**
     * Clicking a name shows that person's work.
     *
     * A panel that says "bo — 7 in flight" and does nothing when you click the
     * row is a panel that has told you the least interesting half of what it
     * knows. The number is the summary; the seven items are the answer.
     *
     * ACTIVE work only, in both stores — the row's own count is of things in
     * flight, so the list it opens has to be the same set, or the header and the
     * body disagree about what "7" meant.
     */
    const showMember = async (name) => {
        const wm = getWm();
        if (!wm || !name) return;
        if (showing === 'tracker') {
            const [{ assigneeExpr }, { KIND: TRACKER_KIND }] = await Promise.all([
                trackerModule('backlog_filters.js'), trackerModule('instance.js')]);
            wm.openInPrimary(TRACKER_KIND.list, { expr: assigneeExpr(name), label: `On ${name}`, flat: true });
        } else if (showing === 'backlog') {
            const { assigneeExpr } = await import('./backlog_filters.js');
            // `flat`: a person's plate is a LIST. Drawn as a tree it would carry
            // epics and stories that are not theirs (kept for context) and drop
            // the items of theirs that sit under a folded parent — so the table
            // would disagree with the count on the row that opened it.
            wm.openInPrimary(KIND.list, { expr: assigneeExpr(name), label: `On ${name}`, flat: true });
        } else {
            const { assigneeExpr } = await import('./filters.js');
            wm.openInPrimary('queues', { expr: assigneeExpr(name), label: `On ${name}` });
        }
    };

    const onClick = (e) => {
        const row = e.target.closest('[data-member]');
        if (row) showMember(row.dataset.member);
    };
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-member]');
        if (!row) return;
        e.preventDefault();
        showMember(row.dataset.member);
    };
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);

    // A focus change can only change WHICH store is shown; the numbers cannot
    // move without a write, and a write announces itself separately.
    const sub = _eventBus?.on?.('wm:changed', () => render());
    const backlogSub = _eventBus?.on?.(ev('backlog:changed'), () => render({ force: true }));
    const trackerSub = MERGED_TRACKER
        ? _eventBus?.on?.('tracker/backlog:changed', () => render({ force: true })) : null;
    const bugSub = _eventBus?.on?.('bugs:changed', () => render({ force: true }));
    return {
        title: 'Inspector',
        destroy: () => {
            sub?.dispose?.();
            backlogSub?.dispose?.();
            trackerSub?.dispose?.();
            bugSub?.dispose?.();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
        },
    };
}

/* ── panel:bottom — Alerts and Changes (hidden by default) ──────── */

/**
 * The store copies the bottom panel covers: the page's own, and on a project
 * page that shows the global tracker, the tracker's too — its records live in
 * that copy's modules and its own repo (instance.js). Standalone TicketDesk is
 * one copy whose store IS the tracker.
 */
export async function bottomSources() {
    const [inst, alerts] = await Promise.all([import('./instance.js'), import('./alerts.js')]);
    const out = [{ inst, alerts }];
    if (MERGED_TRACKER) {
        try {
            const [ti, ta] = await Promise.all([trackerModule('instance.js'), trackerModule('alerts.js')]);
            out.push({ inst: ti, alerts: ta });
        } catch (err) {
            console.warn('[bugdesk] the tracker is not in the bottom panel', err);
        }
    }
    return out;
}

const BOTTOM_TAB_KEY = 'bugdesk.bottomTab';

/**
 * Two tabs, each with a count: Alerts (unread, in the worst unread level's
 * colour) and Changes (uncommitted records), on FlexDesk's tab host
 * (`createBottomPanelTabs`, STORY-0031). The panel's title is the tab in front
 * — FlexDesk's `ctx.setTitle`. Both panes mount at once (`eager`), so the
 * counts are right before either tab is opened; the last tab used is
 * remembered per browser. `bottompanel:show` with `{ tab }` brings a tab to the
 * front (the bell, and the toasts' "+N more", ask for Alerts).
 *
 * The store copies arrive later than the panel (`bottomSources`), so each pane
 * draws into its element once they have.
 */
function mountTicketBottomPanel(host, props, ctx) {
    let destroyed = false;
    const sourcesP = bottomSources();
    const later = (mount) => (el, store, api) => {
        let inner = null;
        sourcesP.then(async (sources) => {
            if (destroyed) return;
            const made = await mount(el, sources, api);
            if (destroyed) made?.destroy?.();
            else inner = made;
        }).catch((err) => console.warn('[bugdesk] a bottom-panel tab failed', err));
        return {
            onShow: () => inner?.refresh?.(),
            destroy: () => inner?.destroy?.(),
        };
    };
    const tabs = createBottomPanelTabs(host, {
        eventBus: _eventBus,
        remember: {
            read: () => { try { return localStorage.getItem(BOTTOM_TAB_KEY); } catch { return null; } },
            write: (id) => { try { localStorage.setItem(BOTTOM_TAB_KEY, id); } catch { /* no storage */ } },
        },
        onSelect: (id, pane) => ctx?.setTitle?.(pane.label),
        panes: [
            {
                id: 'alerts', label: 'Alerts', eager: true,
                mount: later(async (el, sources, api) => {
                    const { mountAlertsTab } = await import('./alerts.js');
                    return mountAlertsTab(el, {
                        eventBus: _eventBus, sources,
                        onBadge: ({ unread, level }) => api.setBadge('alerts', unread, level),
                        onEditRules: () => sources[0].alerts.openAlertsEditor({ eventBus: _eventBus }),
                    });
                }),
            },
            {
                id: 'changes', label: 'Changes', eager: true,
                mount: later(async (el, sources, api) => {
                    const { mountChangesPane } = await import('./changes_pane.js');
                    return mountChangesPane(el, {
                        eventBus: _eventBus, sources,
                        onCount: (n) => api.setBadge('changes', n),
                    });
                }),
            },
        ],
    });
    return {
        title: tabs.active() === 'changes' ? 'Changes' : 'Alerts',
        destroy: () => {
            destroyed = true;
            tabs.destroy();
        },
    };
}

/* ── the Tracker section, inside a project page ──────────────────── */

/**
 * A project page shows the global tracker as its own section. Its records live
 * in the tracker's copy of these modules (see instance.js), so when that section
 * is in front, the side panels — which this copy owns — show the tracker copy's
 * rail and the tracker copy's team, and a click opens the tracker's kinds.
 * False on a standalone TicketDesk page, whose Tracker section IS this copy.
 */
const MERGED_TRACKER = CONFIG.mode !== 'tracker' && !!CONFIG.tracker?.available;

/** Which body a side panel shows for the section in front. */
function panelSection(topNav) {
    if (topNav === 'tracker' && MERGED_TRACKER) return 'tracker';
    // `backlog-home` is the Backlog chip (STORY-0048); `backlog` is still the
    // tracker-mode Tickets list's kind.
    return topNav === 'backlog-home' || topNav === 'backlog' || topNav === 'tracker' ? 'backlog' : 'bugs';
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
/** The bus this copy's pages talk on. createTicketDeskContent sets it for the
 *  page's copy; the tracker's copy, which registers no bug pages, sets it here
 *  so its breadcrumbs and status lines are wired like everyone else's. */
export function useEventBus(eventBus) {
    _eventBus = eventBus || null;
}

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
    // headless verification of the ticket detail page. Otherwise install.js
    // replaces it with the Bugs home dashboard (STORY-0048); the queue is the
    // fallback for a page whose dashboards could not be registered.
    register('home',
        location.hash === '#ticket' ? shell('ticket', mountTicket)
        : shell('queues', mountQueues));
    register('ticket', shell('ticket', mountTicket));
    register('panel:left', mountTicketNav);
    register('panel:right', mountTicketInspector);
    register('panel:bottom', mountTicketBottomPanel);

    return content;
}
