/**
 * object_nav_view.js — the contextual "object nav" panel body.
 *
 * Always RELATIVE to the entity currently open in the main tile. Driven by the
 * `object_nav(kind, id)` bridge endpoint, which walks the registry `parent`
 * chain to ANY depth (no fixed tiers), so this renders:
 *
 *   ▴ Inherits from   — the ancestor chain (parent … root)
 *   ◆ <self>          — the open entity (abstract kind / concrete · N)
 *   ▾ Contains        — recursive children + grandchildren (the subtree)
 *   ● Instances       — running agents / markets under the subtree
 *
 * Every row has a small "open" button that loads it into the main tile. When a
 * landing / navigation page (no specific entity) is open, a short quick-guide
 * is shown instead.
 *
 * Self-contained: subscribes to `workspace:tabs:activated` and reads the
 * current entity from the window manager on mount; no edits to the WM needed.
 */

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Safety net for an OLDER bridge that hands back the browser navKind rather
// than the registered tab kind: `asset` isn't a registered tab (the asset
// editor is `asset_kind`). Current bridge already returns registered kinds, so
// this is a no-op then. Only map kinds that are NEVER valid tab kinds — never
// remap `asset_kind`/`agent`/`market`, which ARE registered.
const OPEN_KIND_FIX = { asset: 'asset_kind' };

/** Read the (kind, id) of the entity in the primary/main tile, defensively. */
function _currentFromWm(wm) {
    try {
        const tree = wm?._tree?.();
        const leafId = tree?.primaryLeafId?.();
        const leaf = leafId ? tree.get(leafId) : null;
        const kind = leaf?.content?.kind;
        const id = leaf?.content?.props?.id;
        return (kind && id) ? { kind, id } : (kind ? { kind, id: '' } : null);
    } catch { return null; }
}

function _statusChip(node) {
    if (node.abstract) {
        return '<span class="ea-onav__chip ea-onav__chip--abstract">abstract kind</span>';
    }
    if (node.instantiates) {
        return '<span class="ea-onav__chip">concrete</span>';
    }
    return '';
}

/** One clickable row: label + flags + an "open in main" button. */
function _row(node, { role, depth = 0, current = false } = {}) {
    const pad = 8 + depth * 14;
    return `
        <div class="ea-onav__row${current ? ' ea-onav__row--current' : ''}"
             style="padding-left:${pad}px"
             data-onav-kind="${esc(node.nav_kind || node.kind)}"
             data-onav-id="${esc(node.id)}"
             data-onav-label="${esc(node.label || node.id)}">
            <span class="ea-onav__role material-symbols-outlined">${esc(role || 'chevron_right')}</span>
            <span class="ea-onav__label" title="${esc(node.kind)}:${esc(node.id)}">${esc(node.label || node.id)}</span>
            ${_statusChip(node)}
            <button type="button" class="ea-onav__open" title="Open in main"
                    data-onav-open>
                <span class="material-symbols-outlined">open_in_new</span>
            </button>
        </div>`;
}

function _childTree(nodes, depth) {
    if (!Array.isArray(nodes) || nodes.length === 0) return '';
    return nodes.map((n) =>
        _row(n, { role: n.children?.length ? 'account_tree' : 'subdirectory_arrow_right', depth })
        + _childTree(n.children || [], depth + 1)
    ).join('');
}

function _guideHtml() {
    return `
        <div class="ea-onav__guide">
            <p class="ea-onav__guide-title">Object navigation</p>
            <p>This panel is relative to whatever you open in the main view. Open
               an entity (an agent, market, asset, …) from the file tree or a
               landing page and it will show:</p>
            <ul>
                <li><strong>Inherits from</strong> — its kind / ancestor chain</li>
                <li><strong>Contains</strong> — its children &amp; their children</li>
                <li><strong>Instances</strong> — running agents / markets</li>
            </ul>
        </div>`;
}

export function mountObjectNavView(hostEl, { api, wm, eventBus, initial } = {}) {
    if (!hostEl) return { destroy() {} };
    hostEl.classList.add('ea-onav');
    // Seed from the caller's last-known entity (reliable), falling back to
    // reading the window manager directly.
    let cur = (initial && initial.kind)
        ? { kind: initial.kind, id: initial.entityId || '' }
        : _currentFromWm(wm);

    const open = (rawKind, id, label) => {
        const kind = OPEN_KIND_FIX[rawKind] || rawKind;
        console.log('[object-nav] open click', { rawKind, kind, id,
            hasNavigate: typeof wm?.navigate === 'function' });
        if (!id || !kind) return;
        try {
            if (typeof wm?.navigate === 'function') {
                wm.navigate(kind, { id, label }, { dest: 'main' });
            } else if (typeof wm?.openInPrimary === 'function') {
                wm.openInPrimary(kind, { id, label });
            } else {
                console.warn('[object-nav] no wm.navigate / openInPrimary', wm);
            }
        } catch (err) {
            console.error('[object-nav] open failed', kind, id, err);
        }
    };

    const render = async () => {
        if (!cur || !cur.id) { hostEl.innerHTML = _guideHtml(); return; }
        let res = null;
        try { res = await api?.object_nav?.(cur.kind, cur.id); }
        catch { res = null; }
        if (!res || res.ok === false) {
            hostEl.innerHTML = _guideHtml();
            return;
        }
        const ancestors = (res.ancestors || []).slice().reverse();   // root → parent
        const children = res.children || [];
        const instances = res.instances || [];
        const parts = [];
        if (ancestors.length) {
            parts.push('<div class="ea-onav__sec-title">Inherits from</div>');
            ancestors.forEach((a, i) => parts.push(_row(a, { role: 'arrow_upward', depth: i })));
        }
        parts.push(_row(res.self, { role: 'adjust', depth: ancestors.length, current: true }));
        if (children.length) {
            parts.push('<div class="ea-onav__sec-title">Contains</div>');
            parts.push(_childTree(children, 0));
        }
        if (instances.length) {
            parts.push(`<div class="ea-onav__sec-title">Instances (${instances.length})</div>`);
            instances.forEach((n) => parts.push(_row(n, { role: 'radio_button_checked' })));
        }
        if (!children.length && !instances.length) {
            parts.push('<div class="ea-onav__empty">No children or instances yet.</div>');
        }
        hostEl.innerHTML = parts.join('');
        // Wire each row directly (matches the working sidebar pattern — more
        // reliable than delegation when innerHTML is replaced).
        hostEl.querySelectorAll('[data-onav-kind]').forEach((row) => {
            row.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                open(row.dataset.onavKind, row.dataset.onavId, row.dataset.onavLabel);
            });
        });
    };

    const onActivated = ({ kind, entityId } = {}) => {
        cur = kind ? { kind, id: entityId || '' } : null;
        render();
    };
    eventBus?.on?.('workspace:tabs:activated', onActivated);

    render();

    return {
        refresh: render,
        setCurrent(entity) {
            cur = (entity && entity.kind)
                ? { kind: entity.kind, id: entity.entityId || '' } : cur;
            render();
        },
        destroy() {
            try { eventBus?.off?.('workspace:tabs:activated', onActivated); } catch { /* noop */ }
        },
    };
}
