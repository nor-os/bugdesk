/**
 * desktops.js — independent tile trees per virtual desktop, persisted
 * through the host's `state` capability under the logical key `desktops`
 * (see `@flexdesk/host`'s `createPywebviewHost({ resolvePath })` — install.js
 * wires `resolvePath: (key) => \`.ecoagent/${key}.json\`` so this lands at
 * the exact same `.ecoagent/desktops.json` path it always has).
 *
 * Each desktop = { id, label, tree (TileTree), windows ([]), panels }.
 * Switching desktops swaps the active tree under the renderer.
 *
 * Kept local (not swapped for `@flexdesk/wm`'s desktops.js) for one
 * bugdesk-specific default: the Console (bottom) panel starts CLOSED on a
 * fresh desktop, where the package's own default starts it open. Everything
 * else here — the `seed` injection for the root leaf, the host.state
 * persistence contract — already matches the package's generalized shape.
 */

import { TileTree, makeLeaf } from './tile_tree.js';

const DEFAULT_PANEL_STATE = {
    left: true,
    right: true,
    // Console is HIDDEN by default on boot; the user can still toggle it.
    bottom: false,
};

/**
 * `seed()` yields the leaf a fresh (or emptied) desktop starts with. Comes
 * from the taxonomy's root kind — see wm.js's `_rootLeaf`, which supplies
 * it. There is deliberately no default here: a silent 'home' fallback
 * would re-introduce the exact bug this parameter exists to remove (an
 * embedder with a different ontology getting a kind it never registered).
 */
function _makeDesktop(label, seed) {
    const tree = new TileTree();
    tree.setRoot(makeLeaf(seed()));
    return {
        id: `desk-${Math.random().toString(36).slice(2, 8)}`,
        label,
        tree,
        windows: [],
        // boot default: left + right open, bottom (console) collapsed.
        // Names are assigned by wm._canonicalize via PANEL_TITLES.
        panels: { ...DEFAULT_PANEL_STATE },
    };
}

export class DesktopManager {
    /** @param {{seed: () => object}} opts  `seed` builds the root leaf. Required. */
    constructor({ seed } = {}) {
        if (typeof seed !== 'function') {
            throw new Error('DesktopManager: a `seed` function is required (the taxonomy root leaf)');
        }
        this.seed = seed;
        this.desktops = [_makeDesktop('1', seed)];
        this.activeIdx = 0;
    }

    active() { return this.desktops[this.activeIdx]; }

    switchTo(idx) {
        if (idx < 0 || idx >= this.desktops.length) return false;
        if (idx === this.activeIdx) return false;
        this.activeIdx = idx;
        return true;
    }

    ensureCount(n) {
        while (this.desktops.length < n) {
            this.desktops.push(_makeDesktop(String(this.desktops.length + 1), this.seed));
        }
    }

    addDesktop(label = null) {
        const d = _makeDesktop(label || String(this.desktops.length + 1), this.seed);
        this.desktops.push(d);
        return d;
    }

    serialize() {
        return {
            activeIdx: this.activeIdx,
            desktops: this.desktops.map((d) => ({
                id: d.id, label: d.label,
                tree: d.tree.serialize(),
                panels: { ...d.panels },
                // windows serialized at WM level since we don't own
                // managed-window state in this module.
            })),
        };
    }

    static deserialize(blob, { seed } = {}) {
        const m = new DesktopManager({ seed });
        if (!blob || !Array.isArray(blob.desktops) || blob.desktops.length === 0) return m;
        m.desktops = blob.desktops.map((raw) => ({
            id: raw.id || `desk-${Math.random().toString(36).slice(2,8)}`,
            label: raw.label || '?',
            tree: raw.tree ? TileTree.deserialize(raw.tree) : new TileTree(),
            windows: [],
            panels: { ...DEFAULT_PANEL_STATE, ...(raw.panels || {}) },
        }));
        // Empty tree → seed with the taxonomy root so the desktop is usable.
        for (const d of m.desktops) {
            if (!d.tree.rootId) d.tree.setRoot(makeLeaf(seed()));
        }
        m.activeIdx = Math.min(Math.max(0, blob.activeIdx | 0), m.desktops.length - 1);
        return m;
    }
}

/**
 * Persistence helpers. They take a host `state` capability; a host without
 * one is legal and they no-op. We don't fail loudly — the WM stays functional
 * against a host that cannot persist.
 */

const DESKTOPS_KEY = 'desktops';

export async function loadDesktops(state) {
    if (!state) return null;
    try {
        return await state.read(DESKTOPS_KEY);
    } catch (err) {
        console.warn('[desktops] load failed', err);
        return null;
    }
}

export async function saveDesktops(state, blob) {
    if (!state) return false;
    try {
        await state.write(DESKTOPS_KEY, blob);
        return true;
    } catch (err) {
        console.warn('[desktops] save failed', err);
        return false;
    }
}
