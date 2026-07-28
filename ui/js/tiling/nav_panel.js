/**
 * nav_panel.js — left navigation panel-tile.
 *
 *   ┌─[ files ][ project ][ git ]──┐   mode tabs
 *   │ ┌──────────────────────────┐ │
 *   │ │ Filter files…            │ │   unified filter (sidebar-controls)
 *   │ └──────────────────────────┘ │
 *   │ ┌──────────────────────────┐ │
 *   │ │ (pane body)              │ │
 *   │ └──────────────────────────┘ │
 *
 *   files    →  ProjectSidebar           (header + own filter hidden via CSS)
 *   project  →  renderTreeItems          (categories ▸ entities ▸ sub-views;
 *                                         context-sensitive drill-down per
 *                                         kind — e.g. an agent expands into
 *                                         settings + brain loops)
 *   git      →  mountGitTab → GitPanel   (filter best-effort, hides non-
 *                                         matching file-list rows)
 */

import { ProjectSidebar } from '../ecoagent/project_sidebar.js';
import { mountGitTab, disposeGitTab, renderTreeItems } from '../ecoagent/ui/sidebar.js';
import { mountObjectNavView } from '../ecoagent/object_nav_view.js';

const MODES = [
    { id: 'files',   icon: 'folder',       label: 'Files' },
    // The "project" pane is now the contextual OBJECT nav — relative to the
    // entity open in main (parent chain + children + instances), not a static
    // category browse. Id stays `project` so existing wiring keeps working.
    { id: 'project', icon: 'account_tree', label: 'Object' },
    { id: 'git',     icon: 'fork_right',   label: 'Git' },
];

// Per-archetype sub-views — same vocabulary the existing agent page uses.
const AGENT_SUB_VIEWS = [
    { id: 'settings',   label: 'Settings',   icon: 'tune' },
    { id: 'init_brain', label: 'init_brain', icon: 'code' },
    { id: 'observe',    label: 'observe',    icon: 'code' },
    { id: 'execute',    label: 'execute',    icon: 'code' },
    { id: 'adjust',     label: 'adjust',     icon: 'code' },
];

// Top-level categories shown in the Project tree.
const CATEGORIES = [
    { id: 'sectors',     label: 'Sectors',     icon: 'category',     kind: 'sector'     },
    { id: 'asset_kinds', label: 'Assets',      icon: 'category',     kind: 'asset_kind' },
    { id: 'agents',      label: 'Agents',      icon: 'group',        kind: 'agent'      },
    { id: 'markets',     label: 'Markets',     icon: 'storefront',   kind: 'market'     },
    // Flows panel removed (godley-declarative): the world-flow templates are
    // gone — booking is declarative Godley rows on each agent. Bookings are
    // viewable in the ledger TFM / per-agent Godley.
    { id: 'scenarios',   label: 'Scenarios',   icon: 'science',      kind: 'scenario'   },
    { id: 'dashboards',  label: 'Dashboards',  icon: 'monitoring',   kind: 'dashboard'  },
    { id: 'kpis',        label: 'KPIs',        icon: 'analytics',    kind: 'kpi'        },
    // Calibration/ETL retired from the UI: market-parameter tuning was a
    // band-aid over a static economy (zeroed-noise test → flat price), and
    // ETL's only remaining use (real market history) is a separate replay
    // feature, not the core problem. Tab + backend kept dormant for a possible
    // future "backtest strategies on real prices" use; not deleted.
];

export function mountNavPanel(hostEl, { wm, eventBus, api }) {
    hostEl.classList.add('twm-nav');
    hostEl.innerHTML = `
        <div class="twm-nav__modes" data-role="modes"></div>
        <div class="sidebar-controls twm-nav__filter">
            <span class="material-symbols-outlined sidebar-search-icon">search</span>
            <input class="data-page__search twm-nav__filter-input"
                   type="search" placeholder="Filter files…"
                   autocomplete="off" />
        </div>
        <div class="twm-nav__body" data-role="body"></div>
    `;
    const modesEl = hostEl.querySelector('[data-role="modes"]');
    const bodyEl  = hostEl.querySelector('[data-role="body"]');
    const filterEl = hostEl.querySelector('.twm-nav__filter-input');

    modesEl.innerHTML = MODES.map((m) => `
        <button class="twm-nav__mode has-tooltip" data-mode="${m.id}"
                data-tooltip="${m.label}">
            <span class="material-symbols-outlined">${m.icon}</span>
            <span>${m.label}</span>
        </button>
    `).join('');

    const tabsShim = {
        openTab: ({ kind, entityId, label, icon, subTab }) => {
            wm.navigate(kind, { id: entityId, label, icon, subTab }, { dest: 'main' });
        },
        closeTab: () => {},
        registerProvider: () => {},
        getActiveTab: () => null,
    };

    const hosts = {};
    let projectSidebar = null;
    let objectNavView = null;
    // Project-tree state.
    const projectData = { sectors: [], asset_kinds: [], agents: [],
                          markets: [], flows: [], scenarios: [],
                          dashboards: [], kpis: [] };
    const expanded = new Set(['agents']); // expand agents by default
    let projectTreeListEl = null;
    // Currently-active entity in the project tree, formatted as
    // `<kind>:<id>` to match the row ids built by _renderProjectTree.
    let projectSelectedId = null;

    let mode = 'files';
    const filterByMode = { files: '', project: '', git: '' };

    // Map content-kinds onto the project-tree category id so the
    // bus event `workspace:tabs:activated` can highlight the right row.
    const KIND_TO_CAT = {
        sector: 'sector',
        agent: 'agent',
        market: 'market', 'market-archetype': 'market',
        scenario: 'scenario',
        dashboard: 'dashboard', kpi: 'kpi',
    };
    // Last entity activated in main — seeds the contextual Object nav so it
    // shows the current object even when you switch to it AFTER opening an
    // entity (no fresh activation event to wait for).
    let lastActivated = null;
    const _onActivated = ({ kind, entityId, subTab } = {}) => {
        lastActivated = kind ? { kind, entityId } : null;
        const catKind = KIND_TO_CAT[kind];
        if (!catKind || !entityId) {
            projectSelectedId = null;
        } else if (kind === 'agent' && subTab) {
            projectSelectedId = `${catKind}:${entityId}:${subTab}`;
        } else {
            projectSelectedId = `${catKind}:${entityId}`;
        }
        if (mode === 'project') _renderProjectTree();
    };
    eventBus?.on?.('workspace:tabs:activated', _onActivated);

    const ensureHost = (id) => {
        if (hosts[id]) return hosts[id];
        const el = document.createElement('div');
        el.className = `twm-nav__pane twm-nav__pane--${id}`;
        el.style.display = 'none';
        bodyEl.appendChild(el);
        hosts[id] = el;
        return el;
    };

    const activate = async (next) => {
        mode = next;
        for (const m of MODES) {
            ensureHost(m.id).style.display = (m.id === next) ? 'flex' : 'none';
        }
        modesEl.querySelectorAll('[data-mode]').forEach((b) =>
            b.classList.toggle('twm-nav__mode--on', b.dataset.mode === next));
        filterEl.value = filterByMode[next] || '';

        if (next === 'files') {
            if (!projectSidebar) {
                // Insert our own "+ new" action row above the sidebar
                // mount — the ProjectSidebar's collapsible-header (with
                // its own + button) is hidden via CSS in nav.css, so
                // we provide a discoverable single action here.
                const actionRow = document.createElement('div');
                actionRow.className = 'twm-nav__files-actions';
                const newBtn = document.createElement('button');
                newBtn.type = 'button';
                newBtn.className = 'ea-action-btn twm-nav__files-new';
                newBtn.innerHTML = '<span class="material-symbols-outlined">add</span><span>New file</span>';
                newBtn.addEventListener('click', () => {
                    // Delegate to the hidden ProjectSidebar + button so we
                    // reuse its new-entity menu logic without duplicating.
                    const addBtn = hosts.files.querySelector(
                        '.collapsible-header__action');
                    addBtn?.click();
                });
                actionRow.appendChild(newBtn);
                hosts.files.appendChild(actionRow);

                const sidebarMount = document.createElement('div');
                sidebarMount.className = 'twm-nav__files-mount';
                hosts.files.appendChild(sidebarMount);

                projectSidebar = new ProjectSidebar({
                    eventBus, sidebarMount,
                    logger: null, workspaceTabs: tabsShim,
                });
                // Patch ProjectSidebar._renderTree to preserve scroll
                // position. Without this, every click that fires
                // workspace:tabs:activated re-renders the tree (to
                // update the .selected highlight) and the user loses
                // their scroll position. We restore synchronously
                // AND on the next animation frame so any layout
                // mutation in between can't clamp scrollTop back to 0.
                const origRenderTree = projectSidebar._renderTree.bind(projectSidebar);
                projectSidebar._renderTree = function patchedRenderTree(...args) {
                    const ref = this._sectionRefs?.get('tree');
                    const root = ref?.listEl;
                    let sc = root?.parentElement;
                    while (sc && sc !== document.body) {
                        const ov = getComputedStyle(sc).overflowY;
                        if (ov === 'auto' || ov === 'scroll') break;
                        sc = sc.parentElement;
                    }
                    const saved = sc?.scrollTop || 0;
                    const ret = origRenderTree.apply(this, args);
                    if (sc) {
                        sc.scrollTop = saved;
                        requestAnimationFrame(() => {
                            if (sc) sc.scrollTop = saved;
                        });
                    }
                    return ret;
                };
                try { projectSidebar.mount(); }
                catch (err) { console.error('[nav] ProjectSidebar mount failed', err); }
            }
            _applyFilter();
        } else if (next === 'project') {
            // Contextual object nav — relative to whatever is open in main.
            if (!objectNavView) {
                hosts.project.innerHTML = '';
                const body = document.createElement('div');
                body.className = 'sidebar-body twm-nav__onav-body';
                hosts.project.appendChild(body);
                objectNavView = mountObjectNavView(body, {
                    api, wm, eventBus, initial: lastActivated });
            } else {
                objectNavView.setCurrent?.(lastActivated);
            }
        } else if (next === 'git') {
            try { await mountGitTab({ host: hosts.git, toggleBtn: null }); }
            catch (err) { console.error('[nav] git mount failed', err); }
            _applyFilter();
        }
    };

    const _ensureProjectTree = async () => {
        const host = hosts.project;
        if (!projectTreeListEl) {
            host.innerHTML = '';
            // Sidebar-body wraps the list so the existing `.tree-item`
            // styles in sidebar.css apply (indentation, hover, icons).
            // `.tree-view` is the canonical list class used by
            // buildBrowserPanel sections.
            const body = document.createElement('div');
            body.className = 'sidebar-body twm-nav__tree-body';
            const list = document.createElement('ul');
            list.className = 'tree-view';
            body.appendChild(list);
            host.appendChild(body);
            projectTreeListEl = list;
        }
        await _loadProjectData();
    };

    const _loadProjectData = async () => {
        if (!api) return;
        // Each bridge call goes through its own try/catch so a single
        // failing endpoint doesn't blank out the whole tree, and the
        // result is coerced to an array regardless of the actual shape
        // (some endpoints return {items:[...]}, some dicts, some null).
        const callList = async (fnName, key) => {
            try {
                const v = await api[fnName]?.();
                if (Array.isArray(v)) return v;
                if (v && typeof v === 'object') {
                    if (Array.isArray(v[key])) return v[key];
                    if (Array.isArray(v.items)) return v.items;
                    // Dict-of-records shape — return the values.
                    return Object.values(v);
                }
                return [];
            } catch (err) {
                console.warn(`[nav] ${fnName} failed`, err);
                return [];
            }
        };
        const [sectors, assetKinds, archs, markets, scenarios, dashboards, kpis,
               calibrations] =
            await Promise.all([
                callList('sectors_list',              'sectors'),
                callList('assets_list',          'asset_kinds'),
                callList('agents_list',           'archetypes'),
                callList('market_instances_list',              'markets'),
                callList('scenarios_list',            'scenarios'),
                callList('analytics_dashboards_list', 'dashboards'),
                callList('kpis_list',                 'kpis'),
                callList('calibrations_list',         'calibrations'),
            ]);
        projectData.sectors     = sectors.map((s)    => ({ id: s.id, label: s.label || s.id }));
        projectData.asset_kinds = assetKinds.map((k) => ({ id: k.id, label: k.id }));
        projectData.agents      = archs.map((a)      => ({ id: a.archetype || a.id, label: a.label || a.archetype || a.id }));
        projectData.markets     = markets.map((m)    => ({ id: m.id, label: m.label || m.id }));
        projectData.scenarios   = scenarios.map((s)  => ({ id: s.id, label: s.label || s.id }));
        projectData.dashboards  = dashboards.map((d) => ({ id: d.id, label: d.label || d.id }));
        projectData.kpis        = kpis.map((k)       => ({ id: k.id, label: k.label || k.id }));
        projectData.calibration = calibrations.map((c) => ({ id: c.id, label: c.name || c.id }));
    };

    const _renderProjectTree = () => {
        if (!projectTreeListEl) return;
        // Preserve scroll position across re-renders so clicking a row
        // (which triggers a re-render to update the .selected highlight)
        // doesn't jump the list back to the top.
        const scrollHost = projectTreeListEl.parentElement;
        const savedScroll = scrollHost?.scrollTop || 0;
        const q = (filterByMode.project || '').toLowerCase().trim();
        const matchLabel = (l) => !q || String(l || '').toLowerCase().includes(q);

        const items = [];
        for (const cat of CATEGORIES) {
            const dataKey = cat.id;
            const list = projectData[dataKey] || [];
            const children = list
                .filter((e) => matchLabel(e.label) || matchLabel(e.id))
                .map((e) => {
                    const node = {
                        id: `${cat.kind}:${e.id}`,
                        label: e.label,
                        icon: cat.icon,
                        _kind: cat.kind,
                        _entityId: e.id,
                    };
                    // Agents expand into per-archetype sub-views.
                    if (cat.kind === 'agent') {
                        node.children = AGENT_SUB_VIEWS.map((sv) => ({
                            id: `${cat.kind}:${e.id}:${sv.id}`,
                            label: sv.label,
                            icon: sv.icon,
                            _kind: cat.kind,
                            _entityId: e.id,
                            _subTab: sv.id,
                        }));
                        node.expanded = expanded.has(node.id);
                    }
                    return node;
                });
            // Auto-expand a category if its label or any child matches the
            // filter, OR if the user has it sticky-expanded.
            const stickyExpand = expanded.has(cat.id);
            const autoExpand = q && (children.length > 0 || matchLabel(cat.label));
            items.push({
                id: cat.id,
                label: cat.label,
                icon: cat.icon,
                subtitle: String(list.length),
                children,
                expanded: stickyExpand || autoExpand,
            });
        }

        // Determine which row should be marked selected. The active id
        // may be a top-level entity (`agent:foo`) or a sub-view
        // (`agent:foo:observe`). renderTreeItems exposes `selectedId`
        // (top-level) and `selectedChildId` (one nesting level deeper).
        let selectedId = null;
        let selectedChildId = null;
        if (projectSelectedId) {
            const parts = projectSelectedId.split(':');
            if (parts.length === 3) {
                // agent sub-view
                selectedId = `${parts[0]}:${parts[1]}`;
                selectedChildId = projectSelectedId;
            } else {
                selectedId = projectSelectedId;
            }
        }

        renderTreeItems(projectTreeListEl, items, {
            selectedId, selectedChildId,
            onToggleExpand: (id) => {
                if (expanded.has(id)) expanded.delete(id);
                else expanded.add(id);
                _renderProjectTree();
            },
            onSelect: (id, item) => {
                if (item._kind && item._entityId) {
                    wm.navigate(item._kind, {
                        id: item._entityId, label: item.label,
                    }, { dest: 'main' });
                }
            },
            onSelectChild: (parentId, childId, child) => {
                if (child._kind && child._entityId) {
                    wm.navigate(child._kind, {
                        id: child._entityId,
                        label: child.label,
                        subTab: child._subTab,
                    }, { dest: 'main' });
                }
            },
            emptyMessage: 'no entities',
        });
        // Restore scroll after the list is rebuilt — once immediately
        // and once on the next animation frame so any in-between
        // layout step (innerHTML clear → reflow at height 0) can't
        // clamp scrollTop back to zero between save and restore.
        if (scrollHost) {
            scrollHost.scrollTop = savedScroll;
            requestAnimationFrame(() => {
                if (scrollHost) scrollHost.scrollTop = savedScroll;
            });
        }
    };

    const _applyFilter = () => {
        const q = filterByMode[mode] || '';
        if (mode === 'files' && projectSidebar) {
            projectSidebar._filter = q.trim().toLowerCase();
            try { projectSidebar._renderTree?.(); } catch {}
        } else if (mode === 'project') {
            _renderProjectTree();
        } else if (mode === 'git') {
            const host = hosts.git;
            if (!host) return;
            const norm = q.trim().toLowerCase();
            const rows = host.querySelectorAll('.git-changes__list [data-path], .git-file');
            rows.forEach((el) => {
                const path = el.dataset?.path
                    || el.querySelector?.('[data-path]')?.dataset?.path
                    || el.textContent || '';
                const match = !norm || path.toLowerCase().includes(norm);
                el.style.display = match ? '' : 'none';
            });
        }
    };

    filterEl.addEventListener('input', () => {
        filterByMode[mode] = filterEl.value;
        _applyFilter();
    });

    modesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mode]');
        if (btn) activate(btn.dataset.mode);
    });

    activate(mode);

    return {
        refresh: () => activate(mode),
        destroy: () => {
            try { projectSidebar?.dispose?.(); } catch {}
            try { disposeGitTab(hosts.git); } catch {}
        },
    };
}
