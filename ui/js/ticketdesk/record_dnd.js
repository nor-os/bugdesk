/**
 * ticketdesk/record_dnd.js — moving a record onto a tile, and opening one
 * without losing what you were looking at.
 *
 * Two gestures, one module, because they answer the same question — "show me
 * this, over there" — and because both need the same thing from a list row: the
 * `{kind, props}` that would open it.
 *
 *   DRAG a row onto any tile          → that tile displays the record
 *   CTRL/⌘-CLICK a row                → a floating window, or a background tab
 *
 * WHY BOTH EXIST. Every list in BugDesk opens things by replacing something:
 * the row you clicked takes over the tile you were in, or arrives as a tab in
 * front of it. That is right for "I am working through this queue" and wrong for
 * "I want these two side by side", which is most of triage — a bug and the story
 * it blocks, a person's overdue list and the one item you are about to ask them
 * about. Neither gesture is discoverable on its own, so neither replaces the
 * plain click; they sit beside it.
 *
 * The drag payload is a JSON `{kind, props}` under a BugDesk-specific MIME type,
 * with a plain-text fallback carrying the reference. The fallback is not
 * decoration: a drag that leaves the app entirely — into an editor, a chat
 * window, a commit message — should paste as `BUG-0042`, which is the only thing
 * an outside program could usefully do with it.
 */

import { getSetting } from '../core/settings.js';

/** Our own type, so a drag from anywhere else is ignored rather than guessed at. */
export const RECORD_MIME = 'application/x-bugdesk-record';

/**
 * What a modified click should do. A SETTING because the two answers are both
 * reasonable and the difference is about how someone works, not about which is
 * correct: a floating window is for comparing two records at once, a background
 * tab is for queueing up a morning's reading without leaving the list.
 *
 * Read at call time, not at module load — this one genuinely can change while
 * the app is running, unlike the identity constants, and a gesture that needs a
 * reload before it obeys a preference is a gesture people stop trusting.
 */
export const modifierOpenMode = () =>
    (getSetting('bugdesk.modifierOpen') === 'tab' ? 'tab' : 'window');

/** Did this click ask for the alternative opening? */
export const isModifiedOpen = (ev) => !!(ev && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey);

/**
 * Open a record the way a modified click asks for.
 *
 * `window` promotes it to a floating window; `tab` appends a tab to the primary
 * tile WITHOUT switching to it — which is the entire difference between this
 * gesture and an ordinary click, since a plain click already opens the record
 * and takes you straight to it.
 *
 * @param {object} wm
 * @param {string} kind   'ticket' | 'item'
 * @param {object} props
 */
export function openModified(wm, kind, props) {
    if (!wm) return;
    if (modifierOpenMode() === 'tab') {
        // BACKGROUND. An ordinary click already opens a record and takes you to
        // it; the whole difference this gesture makes is that the list you are
        // reading stays in front and the record waits in a tab.
        wm.navigate?.(kind, props, { dest: 'main', newTab: true, background: true });
    } else {
        wm.navigate?.(kind, props, { dest: 'window' });
    }
}

/* ── dragging a row out ──────────────────────────────────────────── */

/**
 * Make one table CELL a drag handle for its row.
 *
 * THE CELL, not the row, and this is not a stylistic choice. DataTable calls
 * `renderCell(td, …)` while the `td` is still detached — it is appended to its
 * `<tr>` afterwards — so `td.parentElement` is null at that moment and
 * `td.parentElement.draggable = true` silently did nothing at all. That is
 * exactly how drag-and-drop shipped not working from either table while working
 * fine on the dashboard, whose rows carry `draggable` in their markup.
 *
 * Called for EVERY column, so the whole row is a drag handle rather than just
 * the reference cell — nobody aims for a particular column to start a drag.
 *
 * @param {HTMLElement} td
 * @param {string|number} key  what identifies the row to the resolver
 */
export function markDragCell(td, key) {
    if (!td || key === undefined || key === null || key === '') return;
    td.draggable = true;
    td.dataset.dragKey = String(key);
}

/**
 * Make the rows inside `host` draggable, and describe what is being dragged.
 *
 * Delegated rather than per-row: every one of these lists re-renders its rows
 * wholesale (a filter change, a live update, a sort), and listeners attached to
 * the rows themselves would be attached to the wrong elements within seconds.
 *
 * @param {HTMLElement} host
 * @param {(el: HTMLElement) => ({kind: string, props: object, label: string}|null)} resolve
 *        given the dragged element, what should open — or null for "not a row".
 * @returns {{ destroy(): void }}
 */
export function installRecordDragSource(host, resolve) {
    if (!host) return { destroy() {} };

    const onDragStart = (ev) => {
        const payload = resolve(ev.target);
        if (!payload?.kind) return;
        try {
            ev.dataTransfer.setData(RECORD_MIME, JSON.stringify(payload));
            // The outside-the-app fallback. Firefox also refuses to start a
            // drag at all unless text/plain is set.
            ev.dataTransfer.setData('text/plain', payload.label || '');
            ev.dataTransfer.effectAllowed = 'copy';
        } catch { /* a browser that will not carry the payload cannot drop it either */ }
        document.body.classList.add('bd-dragging-record');
    };
    const onDragEnd = () => document.body.classList.remove('bd-dragging-record');

    host.addEventListener('dragstart', onDragStart);
    host.addEventListener('dragend', onDragEnd);
    return {
        destroy() {
            host.removeEventListener('dragstart', onDragStart);
            host.removeEventListener('dragend', onDragEnd);
            document.body.classList.remove('bd-dragging-record');
        },
    };
}

/** Read the payload back off a drop. Null when this is somebody else's drag. */
export function readRecordDrag(ev) {
    try {
        const raw = ev.dataTransfer?.getData(RECORD_MIME);
        if (!raw) return null;
        const payload = JSON.parse(raw);
        return payload?.kind ? payload : null;
    } catch { return null; }
}

/**
 * Accept dropped records on every tile, and show which one would take it.
 *
 * ONE listener pair on the document rather than per-tile wiring: tiles are
 * created, destroyed and re-rendered constantly by the WM, and a drop target
 * bound to a tile element is a drop target that stops working the first time
 * that tile repaints. `.twm-leaf[data-leaf-id]` is the stable contract (see
 * tiling/tile_renderer.js), and it is the WM's own DOM, so nothing here has to
 * know how a tile is built.
 *
 * Panels are excluded. The left rail and the inspector are chrome; dropping a
 * bug onto the filter list means nothing, and a drop zone that lights up over
 * something that cannot accept it is worse than one that does not light up.
 *
 * @param {object} o
 * @param {object} o.wm
 * @returns {{ destroy(): void }}
 */
export function installRecordDropTargets({ wm } = {}) {
    let lit = null;

    const tileUnder = (target) => {
        const leaf = target?.closest?.('.twm-leaf[data-leaf-id]');
        if (!leaf) return null;
        const id = leaf.dataset.leafId;
        // A tile's content kind is not in its DOM, so ask the tree. Panels — the
        // left rail, the inspector — are chrome: dropping a bug onto a filter
        // list means nothing, and a zone that lights up over something it cannot
        // accept is worse than one that never lights up.
        const content = wm?.desktops?.active?.()?.tree?.get?.(id)?.content?.kind || '';
        if (String(content).startsWith('panel:')) return null;
        return { leaf, id };
    };

    const clear = () => {
        lit?.classList.remove('twm-leaf--droptarget');
        lit = null;
    };

    const onDragOver = (ev) => {
        // `types` is readable during dragover where `getData` is not — but it is
        // a plain array in some engines and a DOMStringList in others, and
        // DOMStringList has no `.includes`. Calling it directly threw, which
        // meant no preventDefault and therefore no drop, silently.
        if (!Array.from(ev.dataTransfer?.types || []).includes(RECORD_MIME)) return;
        const hit = tileUnder(ev.target);
        if (!hit) { clear(); return; }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        if (lit !== hit.leaf) {
            clear();
            lit = hit.leaf;
            lit.classList.add('twm-leaf--droptarget');
        }
    };

    const onDrop = (ev) => {
        const payload = readRecordDrag(ev);
        const hit = tileUnder(ev.target);
        clear();
        if (!payload || !hit) return;
        ev.preventDefault();
        wm?.navigate?.(payload.kind, payload.props || {},
            { ctx: { leafId: hit.id }, dest: 'origin' });
    };

    const onLeave = (ev) => { if (!ev.relatedTarget) clear(); };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragend', clear);

    return {
        destroy() {
            clear();
            document.removeEventListener('dragover', onDragOver);
            document.removeEventListener('drop', onDrop);
            document.removeEventListener('dragleave', onLeave);
            document.removeEventListener('dragend', clear);
        },
    };
}
