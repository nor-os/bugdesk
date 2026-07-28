/**
 * tile_tab_menu.js — the popover mounted by a leaf's tab-bar hamburger
 * button (`data-action="tab-menu"`, `.twm-leaf__tab-hamburger`).
 *
 * It lists the OPEN TABS in that leaf, anchored to the hamburger, so the
 * user can pick / switch to a tab when the strip overflows. Selecting an
 * entry activates that tab on the originating leaf.
 *
 * (Previously this opened an entity browser that added NEW tabs — see
 * `install._tileTabMenu` for the wiring that now feeds it the leaf's tab
 * list and a switch-to-tab `onPick`.)
 *
 * Keyboard:
 *   ↑ ↓        move the row cursor
 *   Home/End   jump to first / last
 *   Enter      activate the cursor's tab
 *   Esc        close
 */

import { getKindMeta } from './kind_taxonomy.js';

/**
 * Open the tab list anchored at (x, y) — the top-left of the hamburger
 * button. Because the tab strip sits at the BOTTOM of the tile, the menu
 * opens UPWARD from the button. Closes on Escape, click-outside, or a
 * pick. Returns a teardown closure (the menu also self-disposes).
 *
 * @param {object}   opts
 * @param {number}   opts.x         hamburger left edge (viewport px)
 * @param {number}   opts.y         hamburger top edge (viewport px)
 * @param {Array<{kind:string,title?:string}>} opts.tabs  the leaf's open tabs
 * @param {number}   [opts.activeIdx=0]  index of the currently active tab
 * @param {(idx:number)=>void} opts.onPick  called with the chosen tab index
 */
export function openTileTabMenu({ x, y, tabs, activeIdx = 0, onPick }) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (list.length === 0) return () => {};

    const overlay = document.createElement('div');
    overlay.className = 'twm-tile-tabmenu-overlay';
    overlay.innerHTML = `
        <div class="twm-tile-tabmenu twm-tile-tabmenu--compact"
             role="menu" aria-label="Open tabs">
            <header class="twm-tile-tabmenu__head">
                <span class="material-symbols-outlined twm-tile-tabmenu__head-icon">tab</span>
                <span class="twm-tile-tabmenu__head-label">Open tabs</span>
                <span class="twm-tile-tabmenu__section-count">${list.length}</span>
            </header>
            <ul class="twm-tile-tabmenu__list" data-role="list"></ul>
        </div>
    `;
    document.body.appendChild(overlay);

    const panel = overlay.querySelector('.twm-tile-tabmenu');
    const listEl = overlay.querySelector('[data-role="list"]');

    // Anchor the panel above the hamburger (the tab strip is at the tile
    // bottom). `bottom` grows the menu upward; clamp `left` to the viewport.
    const WIDTH = 260;
    panel.style.position = 'fixed';
    panel.style.width = `${WIDTH}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - WIDTH - 8, x))}px`;
    panel.style.bottom = `${Math.max(8, window.innerHeight - y + 6)}px`;

    let alive = true;
    let cursor = Math.max(0, Math.min(list.length - 1, activeIdx | 0));

    const close = () => {
        if (!alive) return;
        alive = false;
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
    };
    const onOutside = (ev) => { if (!overlay.contains(ev.target)) close(); };
    const pick = (idx) => {
        if (idx < 0 || idx >= list.length) return;
        close();
        try { onPick?.(idx); }
        catch (err) { console.warn('[tile-tab-menu] pick failed', err); }
    };

    const paintCursor = () => {
        listEl.querySelectorAll('.twm-tile-tabmenu__item').forEach((li) => {
            const idx = Number(li.dataset.idx);
            const on = idx === cursor;
            li.classList.toggle('twm-tile-tabmenu__item--cursor', on);
            if (on) li.scrollIntoView({ block: 'nearest' });
        });
    };
    const move = (delta) => {
        cursor = Math.max(0, Math.min(list.length - 1, cursor + delta));
        paintCursor();
    };
    const onKey = (ev) => {
        if (!alive || ev.isComposing) return;
        switch (ev.key) {
            case 'Escape':    ev.preventDefault(); close(); return;
            case 'ArrowDown': ev.preventDefault(); move(+1); return;
            case 'ArrowUp':   ev.preventDefault(); move(-1); return;
            case 'Home':      ev.preventDefault(); cursor = 0; paintCursor(); return;
            case 'End':       ev.preventDefault(); cursor = list.length - 1; paintCursor(); return;
            case 'Enter':     ev.preventDefault(); pick(cursor); return;
        }
    };

    listEl.innerHTML = list.map((t, i) => {
        const meta  = getKindMeta(t.kind);
        const icon  = meta?.icon || 'tab';
        const label = t.title || meta?.label || t.kind || `Tab ${i + 1}`;
        return `
            <li class="twm-tile-tabmenu__item${i === cursor ? ' twm-tile-tabmenu__item--cursor' : ''}${i === activeIdx ? ' twm-tile-tabmenu__item--active' : ''}"
                role="menuitem" data-idx="${i}" title="${_esc(label)}">
                <span class="twm-tile-tabmenu__item-icon material-symbols-outlined">${_esc(icon)}</span>
                <span class="twm-tile-tabmenu__item-label">${_esc(label)}</span>
                ${i === activeIdx ? '<span class="twm-tile-tabmenu__item-hint">current</span>' : ''}
            </li>
        `;
    }).join('');

    listEl.querySelectorAll('.twm-tile-tabmenu__item').forEach((li) => {
        const idx = Number(li.dataset.idx);
        li.addEventListener('mousemove', () => {
            if (cursor !== idx) { cursor = idx; paintCursor(); }
        });
        li.addEventListener('click', () => pick(idx));
    });

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    return close;
}


function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
