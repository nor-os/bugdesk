/**
 * ticketdesk/bd_table.js — BugDesk's lists on FlexDesk's own DataTable.
 *
 * BugDesk used to ship a copy of the table (`ui/js/ui/components/data_table.js`)
 * for what FlexDesk's lacked. FlexDesk 0.11.0 has it all (its STORY-0010 and
 * STORY-0012), so the copy is gone. This module is the thin seam between the
 * options BugDesk's three lists were written against and FlexDesk's names for
 * the same things — one place, so the queue, the board and the search results
 * cannot each adapt differently:
 *
 *   rowKey(row)                  → getRowKey; and the SELECTION remembered by
 *                                  key across a sort, a refresh and a return to
 *                                  the view (in the table's own state store)
 *   onRowOpen(idx, row, how)     → a click (Ctrl/⌘: 'modified', Shift: nothing),
 *                                  and on the focused table Enter, Ctrl/⌘+Enter,
 *                                  Alt+T / Alt+N / Alt+Shift+H / Alt+Shift+V
 *                                  ('tab', 'window', 'split-h', 'split-v')
 *   contextMenuItems(ctx)        → FlexDesk's (row, rowIdx, ctx)
 *   onContextMenuAction(a, ctx)  → FlexDesk's (a, rowIdx, row, ctx)
 *   seedColWidths {col: px}      → a width used until somebody drags one
 *   selectToggle (passes through) → FlexDesk's select mode (STORY-0029): while
 *                                  it is on, a click or Enter ticks, nothing opens
 *   (always)                     → resetPageOnSort: a sort goes back to page 1
 *   (always)                     → showExportButton: "Download visible rows as
 *                                  CSV" in the strip, through `host` (pass the
 *                                  page's ctx.host) — the native Save dialog in
 *                                  the desktop app, a download in a tab
 *
 * and it adds `getSort()` — `{column, ascending}` — which the board's tree
 * order reads and FlexDesk does not expose.
 */

import { DataTable } from '@flexdesk/widgets';

/** A view's label as a file name: "Open — P1/P2" → "open-p1-p2"; `fallback` when nothing is left. */
export function fileSlug(label, fallback = 'export') {
    return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

/** The gesture a key means on a row, or null for a key that opens nothing. */
export function howOf(ev) {
    const k = String(ev.key || '').toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;
    if (k === 'enter' && !ev.altKey && !ev.shiftKey) return mod ? 'modified' : 'default';
    if (!ev.altKey || mod) return null;
    if (!ev.shiftKey && k === 't') return 'tab';
    if (!ev.shiftKey && k === 'n') return 'window';
    if (ev.shiftKey && k === 'h') return 'split-h';
    if (ev.shiftKey && k === 'v') return 'split-v';
    return null;
}

/**
 * Build a table with BugDesk's options. Everything not listed above passes
 * through to FlexDesk's DataTable unchanged.
 */
export function createTable(el, opts = {}) {
    const {
        rowKey = null, onRowOpen = null, contextMenuItems = null, onContextMenuAction = null,
        seedColWidths = null, onSort = null, onSelectionChange = null, ...rest
    } = opts;
    const store = rest.stateStore || null;
    const key = rest.persistKey || '';

    // A first width, only while nothing is remembered: a width somebody dragged wins.
    if (seedColWidths && store && key) {
        const saved = store.get(key);
        if (!saved?.colWidths || !Object.keys(saved.colWidths).length) store.set(key, { ...(saved || {}), colWidths: { ...seedColWidths } });
    }

    // The sort, as getSort() reports it: what is remembered, then every change.
    const saved = store && key ? store.get(key) : null;
    const sort = { column: saved?.sortColumn ?? null, ascending: saved?.sortAscending ?? true };

    // The selection, remembered by key so it survives a return to the view.
    const selKey = key ? `${key}:selection` : '';
    let table = null;
    let clicking = false;
    let kbKey = '';               // the row the keyboard was last on
    const keysOf = (indices) => (rowKey ? indices.map((i) => table?.config.rows[i]).filter(Boolean).map((r) => String(rowKey(r))) : []);
    // ONCE, when the rows first arrive: after that, FlexDesk's getRowKey keeps the
    // selection on its records through a refresh, and jumping to it on every
    // live update would pull the page out from under somebody reading it.
    let restored = false;
    const restoreSelection = () => {
        if (restored || !rowKey || !store || !selKey || !table || !(table.config.rows || []).length) return;
        restored = true;
        const keys = new Set(store.get(selKey) || []);
        if (!keys.size) return;
        const idx = [];
        (table.config.rows || []).forEach((r, i) => { if (keys.has(String(rowKey(r)))) idx.push(i); });
        if (!idx.length) return;
        table.setSelection(idx);
        try { table.goToRow(idx[0]); table.scrollToRow?.(idx[0]); } catch { /* not on a page yet */ }
    };

    table = new DataTable(el, {
        // BUG-0013: a new order starts on its first page — on every BugDesk list.
        resetPageOnSort: true,
        // STORY-0026: every list exports what it shows (FlexDesk 0.14.1 draws the
        // button on a one-page list too). `host` and `exportFilename` pass through.
        showExportButton: true,
        ...rest,
        ...(rowKey ? { getRowKey: (row) => String(rowKey(row)) } : {}),
        ...(onRowOpen ? {
            keyboardNav: true,
            onRowClick: (idx, row, ev) => {
                // A click OPENS; it does not move the remembered highlight, which
                // is the keyboard's. FlexDesk updates the selection just after
                // this, so that one change is not remembered.
                clicking = true;
                queueMicrotask(() => { clicking = false; });
                if (ev?.shiftKey) return;
                // In select mode a click ticks the row; FlexDesk does that.
                if (table.isSelectMode?.()) return;
                onRowOpen(idx, row, (ev?.ctrlKey || ev?.metaKey) ? 'modified' : 'default', ev);
            },
            onRowKeyDown: (idx, row, ev) => {
                const how = howOf(ev);
                if (!how || table.isSelectMode?.()) return false;
                // A Ctrl-click can take the row off the selection; the keys still
                // mean the row the KEYBOARD was last on, as they always have.
                if (!row && kbKey && rowKey) {
                    idx = (table.config.rows || []).findIndex((r) => String(rowKey(r)) === kbKey);
                    row = idx >= 0 ? table.config.rows[idx] : null;
                }
                if (!row) return false;
                onRowOpen(idx, row, how, ev);
                return true;
            },
        } : {}),
        ...(contextMenuItems ? { contextMenuItems: (_row, _i, ctx) => contextMenuItems(ctx) } : {}),
        ...(onContextMenuAction ? { onContextMenuAction: (action, _i, _row, ctx) => onContextMenuAction(action, ctx) } : {}),
        ...(onSort ? {
            onSort: (column, ascending) => { sort.column = column; sort.ascending = ascending; return onSort(column, ascending); },
        } : {}),
        onSelectionChange: (sel) => {
            // Ticks (select mode) are not the keyboard's highlight: not remembered.
            if (!clicking && rowKey && !table?.isSelectMode?.()) {
                const keys = keysOf([...(sel || [])]);
                if (keys.length) kbKey = keys[0];
                if (store && selKey) store.set(selKey, keys);
            }
            onSelectionChange?.(sel);
        },
    });

    // FlexDesk does not report a sort it made itself (no `onSort` given), so a
    // header click is read back off the persisted state after it.
    const readSort = () => {
        const s = store && key ? store.get(key) : null;
        if (s) { sort.column = s.sortColumn ?? null; sort.ascending = s.sortAscending ?? true; }
    };
    table.getSort = () => { if (!onSort) readSort(); return { ...sort }; };

    // Back to where the selection was, once the rows are in — at mount, or at
    // the first setData of a table that mounts empty (the board).
    const origSetData = table.setData.bind(table);
    table.setData = (data) => { const r = origSetData(data); restoreSelection(); return r; };
    queueMicrotask(restoreSelection);
    return table;
}
