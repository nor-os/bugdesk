/**
 * sfc_view_state.js — shared "viewing" state for SFC tabs.
 *
 * Two pieces of state live here:
 *
 *   viewingTick — which simulation tick is being viewed. `null` ≡ latest.
 *                 The scrubber lives in the sector tab; per-sector and
 *                 cross-sector views all react.
 *
 *   selectedAsset — which asset kind is currently focused. Set by
 *                 sidebar asset-kind clicks; consumed by the sector tab
 *                 to scope its cross-sector / time-series / transactions
 *                 panels. `null` ≡ "show all kinds" / hide the panel.
 */

let _viewingTick = null;
let _selectedAsset = null;
const _tickListeners = new Set();
const _kindListeners = new Set();

export function getViewingTick() {
    return _viewingTick;
}

export function setViewingTick(tick) {
    const next = (tick == null) ? null : Number(tick);
    if (next === _viewingTick) return;
    _viewingTick = next;
    for (const fn of _tickListeners) {
        try { fn(_viewingTick); } catch { /* a bad listener shouldn't break the rest */ }
    }
}

/** Subscribe to viewing-tick changes. Returns an unsubscribe function. */
export function onViewingTickChange(fn) {
    _tickListeners.add(fn);
    return () => _tickListeners.delete(fn);
}

export function getSelectedAsset() {
    return _selectedAsset;
}

export function setSelectedAsset(kindId) {
    const next = kindId ? String(kindId) : null;
    if (next === _selectedAsset) return;
    _selectedAsset = next;
    for (const fn of _kindListeners) {
        try { fn(_selectedAsset); } catch { /* a bad listener shouldn't break the rest */ }
    }
}

/** Subscribe to selected-asset-kind changes. Returns an unsubscribe function. */
export function onSelectedAssetChange(fn) {
    _kindListeners.add(fn);
    return () => _kindListeners.delete(fn);
}
