/**
 * content_registry.js — maps a content kind string to a factory that
 * mounts that content into a tile body element.
 *
 * A content factory has the shape:
 *
 *     (hostEl, props, ctx) -> { destroy?(), title?, ... }
 *
 * The tile renderer calls the factory once when the leaf is first
 * mounted with a given (kind, props) pair, and `destroy()` on unmount.
 *
 * Kinds are registered up-front by the shell. Page-content kinds
 * (home / sfc / markets / agents / analytics / settings) get registered
 * as they are ported into the new shell; until then they fall back to a
 * placeholder so the WM is usable for layout work.
 */

const _factories = new Map();

export function register(kind, factory) {
    if (typeof factory !== 'function') {
        throw new TypeError(`content_registry: factory for "${kind}" must be a function`);
    }
    _factories.set(kind, factory);
}

export function has(kind) { return _factories.has(kind); }

export function mount(kind, hostEl, props, ctx) {
    const factory = _factories.get(kind) || _placeholder(kind);
    try {
        return factory(hostEl, props || {}, ctx || {}) || {};
    } catch (err) {
        console.error('[content_registry] mount failed for', kind, err);
        hostEl.innerHTML = `<div class="tile-error">Mount failed: ${err && err.message || err}</div>`;
        return {};
    }
}

function _placeholder(kind) {
    return (hostEl) => {
        hostEl.innerHTML = `
            <div class="tile-placeholder">
                <div class="tile-placeholder__title">${kind}</div>
                <div class="tile-placeholder__hint">no factory registered yet</div>
            </div>
        `;
        return { title: kind };
    };
}

// KIND_CATALOG is now derived from the canonical kind taxonomy so
// the top-nav chip strip and the command palette share one source of
// truth with the breadcrumb + Backspace navigation. Add a top-level
// page in `kind_taxonomy.js` (with `isTopNav: true`) and it shows up
// here automatically.
import { topNavEntries } from './kind_taxonomy.js';

export const KIND_CATALOG = topNavEntries();
