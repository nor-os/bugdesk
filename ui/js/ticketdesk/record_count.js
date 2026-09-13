/**
 * "12 of 40 open bugs shown" in the bottom bar, for the table you are reading.
 *
 * Open means not closed: a bug in any state but `closed`, an item in any state
 * but `done` or `dropped`. The first figure counts the open records among the
 * rows on screen, after column filters and on the current page. The second is
 * every open record in the store, whatever view you are in, so a narrow filter
 * reads as a narrow slice of the real backlog.
 *
 * A table publishes its figures on its HOST element after every render. The
 * bar reads them from the focused tile, falling back to the primary one, so it
 * follows focus and tab switches without any page knowing about the others. A
 * tile with no table clears the bar.
 */

const HOST_ATTR = 'data-record-count';

let _wm = null;
let _el = null;

/** Attach a table's host to the bar. `compute()` returns `{ shown, total, noun }`
 *  and is called after each render of the table. */
export function publishRecordCount(hostEl, compute) {
    if (!hostEl) return;
    hostEl.setAttribute(HOST_ATTR, '');
    hostEl.__bdRecordCount = compute;
    paintRecordCount();
}

/** Build the bar slot and repaint on every layout or focus change. */
export function installRecordCount(wm) {
    _wm = wm;
    const left = document.querySelector('.global-bottom-bar .bar-left');
    if (!left) return;
    _el = document.createElement('div');
    _el.className = 'bd-record-count';
    _el.hidden = true;
    left.appendChild(_el);
    // A click into a floating window moves no tile focus and fires no WM change,
    // so the bar also looks again after every click.
    document.addEventListener('pointerdown', () => requestAnimationFrame(paintRecordCount), true);
    paintRecordCount();
}

/** Repaint from whichever table the user is looking at. */
export function paintRecordCount() {
    if (!_el) return;
    const figures = _figures();
    if (!figures) { _el.hidden = true; _el.textContent = ''; return; }
    const { shown, total, noun } = figures;
    _el.textContent = `${shown.toLocaleString()} of ${total.toLocaleString()} open ${noun} shown`;
    _el.hidden = false;
}

function _figures() {
    for (const leafEl of _candidateLeaves()) {
        const host = [...leafEl.querySelectorAll(`[${HOST_ATTR}]`)]
            .find((h) => h.isConnected && h.offsetParent !== null && typeof h.__bdRecordCount === 'function');
        if (!host) continue;
        try { return host.__bdRecordCount(); } catch { return null; }
    }
    return null;
}

/** The focused tile first, then the primary tile. A floating window counts
 *  when it holds the focus, because that is the table being read. */
function _candidateLeaves() {
    const out = [];
    const active = document.activeElement?.closest?.('.twm-managed-window');
    if (active) out.push(active);
    const focused = document.querySelector('.twm-leaf--focused');
    if (focused) out.push(focused);
    const tree = _wm?.desktops?.active?.()?.tree;
    const primaryId = tree?.primaryLeafId?.();
    const primary = primaryId
        ? [...document.querySelectorAll('.twm-leaf')].find((el) => el.dataset.leafId === primaryId) : null;
    if (primary) out.push(primary);
    return out;
}
