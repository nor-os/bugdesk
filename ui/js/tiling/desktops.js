/**
 * desktops.js — independent tile trees per virtual desktop, persisted
 * per-project in `.ecoagent/desktops.json` via the pywebview bridge.
 *
 * Each desktop = { id, label, tree (TileTree), windows ([]), panels }.
 * Switching desktops swaps the active tree under the renderer.
 */

import { TileTree, makeLeaf } from './tile_tree.js';

const DEFAULT_PANEL_STATE = {
    left: true,
    right: true,
    // Console is HIDDEN by default on boot; the user can still toggle it.
    bottom: false,
};

function _makeDesktop(label) {
    const tree = new TileTree();
    tree.setRoot(makeLeaf({
        content: { kind: 'home', props: {} },
        title: 'Home',
    }));
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
    constructor() {
        this.desktops = [_makeDesktop('1')];
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
            this.desktops.push(_makeDesktop(String(this.desktops.length + 1)));
        }
    }

    addDesktop(label = null) {
        const d = _makeDesktop(label || String(this.desktops.length + 1));
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

    static deserialize(blob) {
        const m = new DesktopManager();
        if (!blob || !Array.isArray(blob.desktops) || blob.desktops.length === 0) return m;
        m.desktops = blob.desktops.map((raw) => ({
            id: raw.id || `desk-${Math.random().toString(36).slice(2,8)}`,
            label: raw.label || '?',
            tree: raw.tree ? TileTree.deserialize(raw.tree) : new TileTree(),
            windows: [],
            panels: { ...DEFAULT_PANEL_STATE, ...(raw.panels || {}) },
        }));
        // Empty tree → seed with home so the desktop is usable.
        for (const d of m.desktops) {
            if (!d.tree.rootId) {
                d.tree.setRoot(makeLeaf({
                    content: { kind: 'home', props: {} }, title: 'Home',
                }));
            }
        }
        m.activeIdx = Math.min(Math.max(0, blob.activeIdx | 0), m.desktops.length - 1);
        return m;
    }
}

/**
 * Persistence helpers. They use the pywebview API if the methods exist
 * on the bridge; otherwise no-op. We don't fail loudly — the WM should
 * remain functional in dev when those methods aren't wired yet.
 */

export async function loadDesktops(api) {
    if (!api?.workspace_state_read) return null;
    try {
        const blob = await api.workspace_state_read({ path: '.ecoagent/desktops.json' });
        if (!blob) return null;
        return typeof blob === 'string' ? JSON.parse(blob) : blob;
    } catch (err) {
        console.warn('[desktops] load failed', err);
        return null;
    }
}

export async function saveDesktops(api, blob) {
    if (!api?.workspace_state_write) return false;
    try {
        await api.workspace_state_write({
            path: '.ecoagent/desktops.json',
            data: JSON.stringify(blob),
        });
        return true;
    } catch (err) {
        console.warn('[desktops] save failed', err);
        return false;
    }
}
