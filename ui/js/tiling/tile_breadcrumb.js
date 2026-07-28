/**
 * tile_breadcrumb.js — per-tile breadcrumb strip rendered above each
 * page's content.
 *
 * Reuses the existing `topbar-breadcrumb__*` CSS classes so the look
 * matches the rest of the app (notebook editor, etc.). Segments are
 * built from the leaf's content kind + props.id, and clicking a
 * non-current segment routes through `wm.navigate` so the user jumps to
 * that level.
 *
 * The path starts at the top-nav page — Queues › #12, not Project ›
 * Queues › #12. BugDesk has a single workspace, so a project crumb only
 * ever named the one thing there was.
 *
 * Rendering is a three-stage pipeline — `_segments` describes the path,
 * `_bindNav` decides HOW each crumb travels, `_renderInto` draws it —
 * because the right move for a crumb depends on its position in the
 * finished path, which a single pass cannot know while still building
 * that path.
 */

import { getKindMeta, topNavFor } from './kind_taxonomy.js';

/** Build a breadcrumb strip element + render initial state. Returns
 *  `{ el, destroy }`. The strip is wired to the WM: clicking a crumb
 *  routes through `wm.navigate` with the leaf's own ctx. */
export function mountTileBreadcrumb(kind, props, ctx) {
    const root = document.createElement('nav');
    root.className = 'topbar-breadcrumb twm-tile-breadcrumb';
    root.setAttribute('aria-label', 'Tile breadcrumb');

    // Look up wm late (at click time) instead of capturing it once at
    // mount. ctx.wm should always be set by the renderer, but fall
    // back to the global escape hatch (set by install.js after
    // wm.load()) so a closure that lost ctx.wm — or a mount called
    // before the renderer threaded wm through — still navigates.
    const getWm = () => ctx?.wm || window.__twm?.wm || null;

    // Breadcrumb segments route through the canonical `wm.navigate`
    // helper so the same routing (window → replace window, tile →
    // replace active tab, panel/none → primary) lives in one place.
    // Critically, this is what makes the breadcrumb work in WINDOWED
    // mode — passing `ctx` keeps windowId in scope so the segment click
    // stays inside the floating window instead of jumping back to the
    // primary tile.
    //
    // `up` is the Backspace axis: wm's `_navigateUpClose` CLOSES the
    // active drill-in tab so the tab that opened it comes back. It is
    // deliberately blind to `kind`/`props` — it only knows "leave this
    // drill-in", i.e. exactly ONE step up. So only the crumb that IS
    // the current page's parent may set it; see `_bindNav`. Passing it
    // on every ancestor made all clickable crumbs synonyms for "close
    // this tab", so e.g. Project landed on the queue the bug was opened
    // from instead of Home.
    const navigate = (k, p = {}, up = false) => {
        const wm = getWm();
        if (!wm) {
            console.error('[breadcrumb] no WM available — click ignored', k);
            return;
        }
        if (typeof wm.navigate === 'function') {
            wm.navigate(k, p, { ctx, dest: 'origin', up });
        } else if (typeof wm.openInPrimary === 'function') {
            // Fallback for older WM revisions.
            wm.openInPrimary(k, p);
        } else {
            console.error('[breadcrumb] WM has no navigate/openInPrimary');
        }
    };

    const render = () => {
        const segs = _segments(kind, props);
        _bindNav(segs, navigate);
        _renderInto(root, segs);
    };
    render();

    // Nothing to unsubscribe from — the path is derived purely from the
    // leaf's own kind/props. `destroy` stays in the returned shape because
    // every caller invokes it unconditionally.
    return { el: root, destroy: () => {} };
}

/** Build the crumb path for `kind`/`props`.
 *
 *  Segments are DECLARATIVE: an ancestor carries `nav: { kind, props }`
 *  describing where it points, never a bound handler. Binding happens
 *  afterwards in `_bindNav`, which needs to see the whole path to decide
 *  which crumb is the immediate parent (the only one allowed to walk
 *  up). Building handlers here would have to guess that, and every crumb
 *  guessing "I am the parent" is the bug this split fixes. */
function _segments(kind, props) {
    const segs = [];

    // App-global pages (e.g. Settings) sit outside the content hierarchy —
    // render just the page crumb.
    if (getKindMeta(kind)?.appGlobal) {
        const meta = getKindMeta(kind);
        segs.push({ icon: meta.icon, label: meta.label, nav: null });
        return segs;
    }

    // The path starts at the TOP-NAV page (Queues), not at a project root:
    // BugDesk has exactly one workspace, so a "Project" crumb named the
    // only thing there is and cost a click to reach the same landing.

    // Agent Code-tab panes opened in their own tab/window: show the full
    // path Agents › <agent> › <pane>, not just the pane.
    const AGENT_PANE = { agent_signature: 'Signature', agent_code: 'Code', agent_flows: 'Flows' };
    if (AGENT_PANE[kind] && props?.id) {
        const agentsMeta = getKindMeta('agents');
        const agentMeta = getKindMeta('agent');
        segs.push({
            icon: agentsMeta?.icon || 'group', label: agentsMeta?.label || 'Agents',
            nav: { kind: 'agents', props: {} },
        });
        segs.push({
            icon: agentMeta?.icon || 'person', label: props.id,
            nav: { kind: 'agent', props: { id: props.id, label: props.id } },
        });
        segs.push({ icon: 'table_chart', label: AGENT_PANE[kind], nav: null });
        return segs;
    }

    const topNav     = topNavFor(kind);
    const topNavMeta = topNav ? getKindMeta(topNav) : null;
    // Home is the root — it has no ancestor to prepend. Same when the
    // kind isn't in the taxonomy at all.
    if (topNav && topNav !== 'home' && topNavMeta) {
        // Preserve the queue filter a sub-page (e.g. a ticket) was opened from, so the
        // breadcrumb returns to that filtered view rather than the default "all".
        const topNavProps = (topNav === 'queues' && props?.filter) ? { filter: props.filter } : {};
        segs.push({
            icon:  topNavMeta.icon,
            label: topNavMeta.label,
            nav: { kind: topNav, props: topNavProps },
        });
    }

    // Market instance: surface the archetype between Markets and the
    // instance name (`<arch>.<id>` convention).
    if (kind === 'market' && typeof props?.id === 'string') {
        const dot = props.id.indexOf('.');
        if (dot > 0) {
            const archId   = props.id.slice(0, dot);
            const archMeta = getKindMeta('market-archetype');
            const marketMeta = getKindMeta('market');
            segs.push({
                icon:  archMeta?.icon || 'storefront',
                label: archId,
                nav: { kind: 'market-archetype',
                       props: { id: archId, label: archId } },
            });
            segs.push({
                icon:  marketMeta?.icon || 'storefront',
                label: props.label || props.id.slice(dot + 1),
                nav: null,
            });
            return segs;
        }
    }

    const meta = getKindMeta(kind);
    const hasEntity = !!props?.id;
    if (meta) {
        // The kind IS the top-nav (e.g. opening the Archetypes
        // landing). Don't duplicate the chip — the top-nav segment
        // above already names it.
        const kindIsTopNav = (kind === topNav);
        if (hasEntity) {
            segs.push({
                icon:  meta.icon,
                label: props.label || props.id,
                nav: null,
            });
        } else if (!kindIsTopNav) {
            segs.push({
                icon:  meta.icon,
                label: meta.label,
                nav: null,
            });
        }
    } else if (hasEntity) {
        // Kind isn't in the taxonomy yet — still surface the entity
        // name so the user sees where they are, just without an icon.
        segs.push({
            icon:  'description',
            label: props.label || props.id,
            nav: null,
        });
    }
    return segs;
}

/** Turn each segment's `nav` descriptor into the `onClick` handler
 *  `_renderInto` expects, and decide which single crumb walks UP.
 *
 *  wm's up-axis (`_navigateUpClose`) is a fixed ONE-step move: it closes
 *  the active drill-in tab and re-activates the tab that opened it,
 *  without ever looking at the kind the caller asked for. That is only
 *  the right answer for the crumb directly to the left of the current
 *  page — the parent. Any crumb above the parent needs a real
 *  navigation, so it goes with `up: false` and wm replaces the page in
 *  place via `_navigateAuto`.
 *
 *  "Parent" is the LAST clickable crumb, and clickability must be judged
 *  exactly as `_renderInto` judges it: the final segment always renders
 *  as the current page even when it carries a `nav` (a top-nav landing
 *  such as Queues ends on its own crumb), so the scan stops short of it.
 *  Get this wrong and an unclickable crumb absorbs the up-flag while the
 *  real parent silently navigates instead of closing its tab. */
function _bindNav(segs, navigate) {
    let parentIdx = -1;
    for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i].nav) parentIdx = i;
    }
    segs.forEach((seg, i) => {
        if (!seg.nav) { seg.onClick = null; return; }
        const { kind, props } = seg.nav;
        const up = (i === parentIdx);
        seg.onClick = () => navigate(kind, props, up);
    });
}

function _renderInto(container, segments) {
    container.innerHTML = '';
    if (!segments?.length) return;
    const ol = document.createElement('ol');
    ol.className = 'topbar-breadcrumb__list';
    segments.forEach((seg, i) => {
        const li = document.createElement('li');
        li.className = 'topbar-breadcrumb__item';
        const isLast = i === segments.length - 1;
        if (isLast || !seg.onClick) {
            li.classList.add('topbar-breadcrumb__item--current');
            li.innerHTML = `
                <span class="material-symbols-outlined topbar-breadcrumb__icon">${_esc(seg.icon)}</span>
                <span class="topbar-breadcrumb__current">${_esc(seg.label)}</span>
            `;
        } else {
            const btn = document.createElement('button');
            btn.className = 'topbar-breadcrumb__link';
            btn.type = 'button';
            btn.innerHTML = `
                <span class="material-symbols-outlined topbar-breadcrumb__icon">${_esc(seg.icon)}</span>
                <span>${_esc(seg.label)}</span>
            `;
            btn.addEventListener('click', () => {
                btn.classList.add('twm-tile-breadcrumb__link--flash');
                setTimeout(() => {
                    btn.classList.remove('twm-tile-breadcrumb__link--flash');
                }, 180);
                try { seg.onClick(); }
                catch (e) { console.error('[breadcrumb] segment click threw', e); }
            });
            li.appendChild(btn);
            const sep = document.createElement('span');
            sep.className = 'topbar-breadcrumb__separator';
            sep.textContent = '›';
            li.appendChild(sep);
        }
        ol.appendChild(li);
    });
    container.appendChild(ol);
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
