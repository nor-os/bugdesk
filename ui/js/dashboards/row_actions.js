/**
 * row_actions.js — what a click, a key and a right-click on a list or people
 * tile's row do (STORY-0047). The tiles are FlexDesk's (`flexdesk.list`,
 * `flexdesk.people`); these are BugDesk's answers to their hooks, over the
 * tile's source (sources.js), so a tracker row on a project page opens the
 * tracker's ticket and is deleted through the tracker's API.
 *
 * WHERE A RECORD OPENS: A TAB IN THE DASHBOARD'S OWN TILE, as the old Tracker
 * page did. Not over it: the dashboard stays one tab-click away, which is what
 * makes it a place you work FROM. Not beside it either: a split gives two
 * half-width tiles, and a ticket read at half width wraps every four words.
 * "Open beside" is in the right-click menu, as the deliberate choice it is.
 * A list ("Open as a list", a person, "Everything on …") opens the same way.
 */

import { statusLine } from '../ticketdesk/pages.js';
import { listDrill, personDrill } from './resolve.js';
import { installRecordDragSource, isModifiedOpen, openHowForKey, openModified, openRecordAs } from '../ticketdesk/record_dnd.js';

/** The key a list tile's row carries for record `r` (sources.js `listRow`). */
export const rowKeyOf = (src, r) => String(src.idOf(r));

/**
 * Wire one list or people tile. `get()` answers `{src, binding, scope}` as
 * they are now (the tile's settings and the board's scope change under it).
 * @returns {{destroy(): void}}
 */
export function wireRowTile(tile, kind, { ctx, eventBus, get }) {
    const wm = ctx.wm;
    const openHere = (k, props) => {
        if (wm?.navigate) wm.navigate(k, props, { ctx, dest: 'origin', newTab: true });
        else wm?.openInTabFromContext?.(ctx, k, props);
    };
    const record = (key) => {
        const { src } = get();
        return src?.rows().find((r) => rowKeyOf(src, r) === String(key)) || null;
    };
    const openList = (drill) => {
        const { src } = get();
        if (src && drill) openHere(src.listKind, src.listProps(drill.expr, drill.label));
    };

    tile.onAction = () => {
        const { src, binding, scope } = get();
        openList(src && listDrill(src, binding, tile.config?.title, scope));
    };

    if (kind === 'people') {
        tile.onRowActivate = ({ row }) => {
            const { src, binding, scope } = get();
            openList(src && personDrill(src, binding, row.key, scope));
        };
        return { destroy() {} };
    }

    tile.rowsDraggable = true;
    tile.onRowActivate = ({ row, event }) => {
        const { src } = get();
        const r = record(row.key);
        if (!src || !r) return;
        // Ctrl/⌘ (click or Enter): a floating window or a background tab, per
        // the setting; either way the dashboard stays where it is.
        if (isModifiedOpen(event)) openModified(wm, src.itemKind, src.itemPropsOf(r));
        else openHere(src.itemKind, src.itemPropsOf(r));
    };
    tile.rowMenu = ({ row }) => {
        const { src } = get();
        const r = record(row.key);
        if (!src || !r) return null;
        const who = src.assigneeOf(r);
        const project = src.projectRefOf?.(r);
        return [
            { label: 'Open', icon: 'open_in_new', action: 'open' },
            { label: 'Open beside the dashboard', icon: 'splitscreen_vertical_add', action: 'split' },
            { label: 'Open in a window', icon: 'web_asset', action: 'window' },
            { separator: true },
            { label: `Everything on ${who || 'nobody'}`, icon: 'person', action: 'who' },
            ...(src.projectExpr ? [{ label: 'Everything in this project', icon: 'folder_special', action: 'project', disabled: !project }] : []),
            { separator: true },
            { label: 'Copy reference', icon: 'content_copy', action: 'copy' },
            ...(src.removeItem ? [{ separator: true }, { label: 'Delete…', icon: 'delete', action: 'delete', danger: true }] : []),
        ];
    };
    tile.onRowMenuAction = ({ action, row }) => {
        const { src, binding } = get();
        const r = record(row.key);
        if (!src || !r) return;
        const props = src.itemPropsOf(r);
        if (action === 'open') openHere(src.itemKind, props);
        else if (action === 'split') wm?.navigate?.(src.itemKind, props, { ctx, dest: 'split-h' });
        else if (action === 'window') wm?.navigate?.(src.itemKind, props, { ctx, dest: 'window' });
        else if (action === 'who') {
            // Everything open on them, in this store: not narrowed by the tile's
            // own filter, which is what the menu entry says.
            const who = src.assigneeOf(r);
            openList(personDrill(src, { source: binding.source }, who, 'all'));
        } else if (action === 'project' && src.projectRefOf?.(r)) {
            const ref = src.projectRefOf(r);
            openList({ expr: src.projectExpr(ref), label: `${ref} · open` });
        } else if (action === 'copy') {
            const ref = src.refOf(r);
            navigator.clipboard.writeText(ref)
                .then(() => statusLine(`Copied ${ref}.`))
                .catch((err) => statusLine(`Copy failed: ${err?.message || err}`));
        } else if (action === 'delete' && src.removeItem) {
            src.removeItem(r, { onStatus: statusLine })
                .then((done) => { if (done) eventBus?.emit?.(src.changedEvent, {}); })
                .catch((err) => statusLine(`Not deleted: ${err?.message || err}`));
        }
    };

    // Alt+T / Alt+N / Alt+Shift+H / Alt+Shift+V: the same places as in a
    // table. Enter, Space and Ctrl+Enter are the tile's own (onRowActivate).
    const onKey = (e) => {
        const how = openHowForKey(e, ['Enter', ' ']);
        if (!how || how === 'default' || how === 'modified') return;
        const rowEl = e.target?.closest?.('[data-row-key]');
        const { src } = get();
        const r = rowEl && record(rowEl.dataset.rowKey);
        if (!src || !r) return;
        e.preventDefault();
        e.stopPropagation();
        openRecordAs(wm, ctx, src.itemKind, src.itemPropsOf(r), how);
    };
    tile.contentElement?.addEventListener('keydown', onKey);

    // Drag a row onto any tile to show it there (record_dnd.js).
    const drag = installRecordDragSource(tile.contentElement, (el) => {
        const { src } = get();
        const r = record(el?.closest?.('[data-row-key]')?.dataset.rowKey);
        return src && r ? { kind: src.itemKind, props: src.itemPropsOf(r), label: src.refOf(r) } : null;
    });
    return {
        destroy() {
            tile.contentElement?.removeEventListener('keydown', onKey);
            drag.destroy();
        },
    };
}
