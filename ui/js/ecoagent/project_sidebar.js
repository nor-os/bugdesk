/**
 * project_sidebar.js — left-rail file tree for the Project mode.
 *
 * The Project fl-bar mode is the project's "home" — it owns the
 * canonical setup file (`project.json`) and gives the user a
 * filesystem-style view of every other authored file. Each leaf
 * routes to its existing workspace tab provider so the rest of the
 * app stays exactly as it was.
 *
 *   project.json   →  project-setup tab (currencies + countries + FX)
 *   world.py       →  sfc-overview tab
 *   agents/X.py    →  agent tab for archetype X
 *   markets.py     →  markets-list landing tab (kind 'markets-list')
 *   scenarios.py   →  scenario tab
 *   dashboards.py  →  the Live workspace dashboard tab
 *
 * Reads the project state on mount + on bridge change notifications.
 * The tree uses Ecosim's `TreeView` primitive so the visual language
 * matches the rest of the app (sidebar.css covers the tree-* CSS).
 */

import { buildBrowserPanel, mountGitTab } from './ui/sidebar.js';
import { openConfirm, openForm } from './ui/modal.js';

const LIVE_DASHBOARD_ID = '_live';

/** Lower-snake-ish id derived from a human label, used as a fallback
 *  when the user doesn't bother typing an explicit id in the
 *  new-entity dialog. Mirrors right_panel_setup.js / sfc_sidebar.js. */
function slugify(s) {
    return String(s || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}

export class ProjectSidebar {
    constructor({ eventBus, sidebarMount, logger, workspaceTabs } = {}) {
        this.eventBus = eventBus;
        this.sidebarMount = sidebarMount;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs;
        this._archetypes = [];
        this._sectors = [];
        this._assetKinds = [];
        this._scenarios = [];
        this._dashboards = [];
        this._events = [];
        this._markets = [];
        this._marketArchetypes = [];
        this._kpis = [];
        this._sectionRefs = null;
        this._activeId = null;
        this._filter = '';
        // Folder expand state — sticky per session. When a filter is
        // active we transiently auto-expand everything (so matches
        // deep in the tree are visible) without overwriting this set.
        this._expanded = new Set(['agents']);
    }

    /** Match against the active filter. Empty filter matches
     *  everything. Case-insensitive substring against the row label
     *  AND, when supplied, an extra haystack of the entity's deep
     *  content (params, accounts, postings, …). Lets the user type
     *  `wage` and find every archetype that *defines* a `wage*`
     *  param or account — not just files whose filename happens to
     *  contain "wage". */
    _matchesFilter(label, haystack = '') {
        if (!this._filter) return true;
        const q = this._filter;
        if (String(label || '').toLowerCase().includes(q)) return true;
        if (haystack && String(haystack).toLowerCase().includes(q)) return true;
        return false;
    }

    /** When filtering, all folders auto-expand so matches deep in
     *  the tree are visible. The sticky `_expanded` set is preserved
     *  for when the user clears the filter. */
    _isExpanded(id) {
        return this._filter ? true : this._expanded.has(id);
    }

    mount() {
        this._renderSidebar();
        this._onTabActivated = ({ kind, entityId }) => {
            const next = this._idForActiveTab(kind, entityId);
            if (next === this._activeId) return;
            this._activeId = next;
            this._refreshHighlight();
        };
        this.eventBus?.on?.('workspace:tabs:activated', this._onTabActivated);
        // Re-load the agent list when archetypes change so the tree
        // gains/loses agents/*.py rows live.
        this._onArchsChanged = () => this._refresh();
        this.eventBus?.on?.('ecoagent:archetypes:changed', this._onArchsChanged);
        // Non-entity project files (calibrations/, etl/) are written outside
        // the archetype path, so refresh the tree on the generic
        // project-changed signal too — otherwise a new calibration/pipeline
        // file doesn't appear until a mode switch / reopen.
        this.eventBus?.on?.('ecoagent:project:changed', this._onArchsChanged);
        this._onModeChanged = ({ mode }) => {
            if (mode === 'project') this._ensureDefaultTab();
        };
        this.eventBus?.on?.('extra-mode:changed', this._onModeChanged);
        // Surface "File > New…" / shortcut-driven create requests
        // through the same per-type form flow as the in-sidebar +
        // button + folder right-click. One place owns the create
        // logic; everyone else asks it nicely via this event.
        this._onNewEntity = ({ type } = {}) => {
            if (type) this._createEntity(type);
        };
        this.eventBus?.on?.('ecoagent:project:new-entity', this._onNewEntity);
        // Cross-app rename propagation. The file tree's leaf labels
        // are filename slugs (e.g. `households.sector.json`) so a
        // label-only rename doesn't change them, but per-entity
        // haystacks DO carry the label — patch the cache and re-render
        // so filtering by the new label finds the right row, without
        // re-hitting the bridge.
        this._onEntityRenamed = ({ kind, entityId, label } = {}) => {
            if (label && entityId) {
                const bucketByKind = {
                    sector:    this._sectors,
                    scenario:  this._scenarios,
                    kpi:       this._kpis,
                    agent:     this._archetypes,
                    dashboard: this._dashboards,
                };
                const bucket = bucketByKind[kind];
                if (bucket) {
                    const idKey = kind === 'agent' ? 'archetype' : 'id';
                    const it = bucket.find((x) => x[idKey] === entityId);
                    if (it) { it.label = label; this._renderTree(); return; }
                }
            }
            this._refresh();
        };
        this.eventBus?.on?.('ecoagent:entity:renamed', this._onEntityRenamed);
        this._refresh();
    }

    show()  { this._refresh(); }
    hide()  {}
    dispose() {
        if (this._onTabActivated) {
            this.eventBus?.off?.('workspace:tabs:activated', this._onTabActivated);
        }
        if (this._onArchsChanged) {
            this.eventBus?.off?.('ecoagent:archetypes:changed', this._onArchsChanged);
        }
        if (this._onModeChanged) {
            this.eventBus?.off?.('extra-mode:changed', this._onModeChanged);
        }
        if (this._onNewEntity) {
            this.eventBus?.off?.('ecoagent:project:new-entity', this._onNewEntity);
        }
        if (this._onEntityRenamed) {
            this.eventBus?.off?.('ecoagent:entity:renamed', this._onEntityRenamed);
        }
    }

    /** Open the project-setup tab when entering Project mode if no
     *  Project-mode tab is already active. Other modes' tabs stay open
     *  (they live in the shared workspace tab strip). */
    _ensureDefaultTab() {
        const open = this.workspaceTabs?.getOpenTabs?.() || [];
        if (open.some((t) => t.kind === 'project-setup')) return;
        this._openProjectSetupTab();
    }

    _renderSidebar() {
        if (!this.sidebarMount) return;
        // Mount through the shared browser-panel primitive so we land
        // inside `.data-browser-panel > .sidebar-body` — the DOM shape
        // Ecosim's #fixed-200 un-hide rule expects AND the scope under
        // which `tree-*` styles from sidebar.css resolve. One section
        // ("Files") holds the entire file tree.
        const { sections, tabs } = buildBrowserPanel({
            mount: this.sidebarMount,
            icon: 'folder',
            title: 'Project',
            // Filter strip narrows the tree to rows whose label
            // matches the typed substring. Matching is
            // case-insensitive and runs against the leaf labels
            // (e.g. `households.sector.json`, `gdp.kpi.json`).
            // Empty filter restores the full tree.
            onSearch: (q) => {
                this._filter = String(q || '').trim().toLowerCase();
                this._renderTree();
            },
            searchPlaceholder: 'Filter files…',
            sections: [
                { id: 'tree', label: 'Files',
                  addable: true, addTooltip: 'New entity…',
                  defaultExpanded: true },
            ],
            // Git lives only on the Project page — the project file
            // tree IS what gets committed, so this is the natural
            // home for it. Toggling between Files and Source Control
            // swaps which panel is visible (the other goes `hidden`,
            // not appended underneath).
            tabs: [
                { id: 'git', icon: 'commit', title: 'Source Control' },
            ],
            onTabChange: (tabId) => {
                if (tabId === 'git') {
                    const g = this._tabRefs?.get('git');
                    mountGitTab({ host: g?.host, toggleBtn: g?.btn });
                }
            },
        });
        this._sectionRefs = sections;
        this._tabRefs = tabs;
        // Files section "+" → opens the new-entity dropdown menu.
        sections.get('tree').addBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openNewEntityMenu(sections.get('tree').addBtn);
        });
    }

    async _refresh() {
        // The file tree is a LITERAL filesystem walk of the project
        // (docs/CLASS_AUTHORED_ENTITIES.md §8): one bridge call returns the
        // real folders + files, each file node carrying server-derived
        // routing `{kind, entityId}`. The rail shows exactly what's on disk
        // and routes reliably — no synthesizing leaf paths from entity lists.
        try {
            const api = window.pywebview?.api;
            this._tree = (await api?.project_file_tree?.()) || { children: [] };
        } catch (err) {
            this.logger.warn?.('project sidebar refresh failed', { err });
            this._tree = { children: [] };
        }
        this._renderTree();           // builds `this._routes` (path → {kind,entityId})
        // Seed active highlight from the currently active tab.
        const t = this.workspaceTabs?.getActiveTab?.();
        this._activeId = t ? this._idForActiveTab(t.kind, t.entityId) : null;
        this._refreshHighlight();
    }

    /** Build a real file-tree using EcoSim's `.tree-node` (folder) +
     *  `.tree-item` (leaf) primitives. Mirrors the on-disk per-entity
     *  layout: each typed directory is a folder, every entity file
     *  inside is a leaf. Clicking a leaf opens the editor for that
     *  specific entity. The CSS from `sidebar.css` + `main_new.css`
     *  handles hover, active, chevron rotation, and indentation —
     *  this method just stamps the DOM. */
    _renderTree() {
        const ref = this._sectionRefs?.get('tree');
        if (!ref) return;
        const root = ref.listEl;
        root.className = 'tree-view ea-project-tree';
        root.innerHTML = '';
        // Route map (real path -> {kind, entityId}) rebuilt every render from
        // the walked tree; _onItemClick / _entityFromId / _idForActiveTab all
        // dispatch through it.
        this._routes = {};
        const tree = this._tree || { children: [] };
        this._renderNodes(root, tree.children || [], 0);
    }

    /** Recursively render the walked filesystem tree. Folders become
     *  `.tree-node` (expand/collapse via `this._expanded`); files become
     *  `.tree-item` whose click routes via `this._routes[path]`. The active
     *  filter keeps files whose name matches and folders with any match. */
    _renderNodes(parent, nodes, level) {
        for (const node of nodes || []) {
            if (node.folder) {
                if (!this._nodeMatchesFilter(node)) continue;
                const id = node.path || node.name;
                const folder = this._appendFolder(parent, {
                    id, label: node.name, icon: 'folder',
                    count: (node.children || []).length,
                    expanded: this._isExpanded(id), level,
                });
                this._renderNodes(folder.children, node.children || [], level + 1);
            } else {
                if (!this._nodeMatchesFilter(node)) continue;
                if (node.kind && node.entityId != null) {
                    this._routes[node.path] = { kind: node.kind, entityId: node.entityId };
                }
                this._appendItem(parent, {
                    id: node.path, label: this._displayLabel(node.name),
                    icon: this._iconForKind(node.kind), level,
                    tier: node.tier || null, abstract: !!node.abstract,
                });
            }
        }
    }

    /** Cosmetic leaf label: drop the file extension (and the compound
     *  per-entity suffix like `.sub_sector.json`). `node.name`/`node.path`
     *  stay the real on-disk file — this only affects what's shown, so
     *  `project.json` reads as `project`, `oil.commodity.market.json` as
     *  `oil`-style cleanliness, `cash.py` as `cash`. */
    _displayLabel(name) {
        const n = String(name || '');
        const compound = n.match(
            /^(.*?)\.(?:sub_sector|sector|scenario|kpi|dashboard|registry|agent|market|asset)\.json$/);
        if (compound) return compound[1];
        return n.replace(/\.(?:json|py)$/i, '');
    }

    /** Filter match: a file matches its own name; a folder matches its own
     *  name OR any descendant. Empty filter matches everything. */
    _nodeMatchesFilter(node) {
        if (!this._filter) return true;
        if (this._matchesFilter(node.name)) return true;
        if (node.folder) return (node.children || []).some((c) => this._nodeMatchesFilter(c));
        return false;
    }

    /** Material-symbol icon for a routed file kind. */
    _iconForKind(kind) {
        return ({
            agent: 'group',
            'market': 'storefront', 'market-archetype': 'storefront',
            'market-kind': 'category',
            asset_kind: 'category', 'asset-kind-base': 'category',
            sector: 'account_tree', scenario: 'science',
            kpi: 'analytics', dashboard: 'monitoring', home: 'settings',
        }[kind]) || 'description';
    }

    _appendItem(parent, { id, label, icon, level = 0, tier = null, abstract = false }) {
        const el = document.createElement('div');
        // A tier tag + type/instance class so it's clear at a glance what is
        // merely a TYPE (abstract — defines structure, can't be instantiated,
        // e.g. a market kind can't have branches) vs an actual OBJECT.
        el.className = 'tree-item'
            + (tier ? (abstract ? ' tree-item--type' : ' tree-item--instance') : '');
        if (level > 0) el.style.paddingLeft = `${level * 16 + 18}px`;
        if (id === this._activeId) el.classList.add('selected');
        el.dataset.itemId = id;
        const tag = tier
            ? `<span class="tree-item__tier" title="${abstract
                ? 'a type — defines structure; not a runtime object (cannot be instantiated)'
                : 'an instance — an actual object'}">${tier}</span>`
            : '';
        el.innerHTML = `
            <span class="tree-item__icon">
                <span class="material-symbols-outlined">${icon || 'description'}</span>
            </span>
            <span class="tree-item__label">${label}</span>
            ${tag}
        `;
        el.addEventListener('click', () => this._onItemClick(id));
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._openItemContextMenu(id, label, e);
        });
        parent.appendChild(el);
        return el;
    }

    /** Append a `.tree-node` folder with header + (initially hidden
     *  unless expanded) children container. Returns `{ header,
     *  children }` so callers can stuff leaf items into the body.
     *
     *  Right-clicking a folder offers a context-aware "New <type>"
     *  matching the folder it points at (e.g. right-clicking
     *  `markets/` proposes "New market"). */
    _appendFolder(parent, { id, label, icon, count, expanded = false, level = 0 }) {
        const node = document.createElement('div');
        node.className = 'tree-node';
        node.dataset.nodeId = id;
        const header = document.createElement('div');
        header.className = 'tree-node__header';
        if (level > 0) header.style.paddingLeft = `${level * 16}px`;
        header.innerHTML = `
            <span class="tree-node__toggle">
                <span class="material-symbols-outlined">${expanded ? 'expand_more' : 'chevron_right'}</span>
            </span>
            <span class="tree-node__icon">
                <span class="material-symbols-outlined">${icon || 'folder'}</span>
            </span>
            <span class="tree-node__label">${label}</span>
            <span class="tree-node__count">${count ?? ''}</span>
        `;
        const children = document.createElement('div');
        children.className = 'tree-node__children';
        children.style.display = expanded ? 'block' : 'none';
        header.addEventListener('click', () => {
            if (this._expanded.has(id)) this._expanded.delete(id);
            else this._expanded.add(id);
            this._renderTree();
        });
        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._openFolderContextMenu(id, label, e);
        });
        node.appendChild(header);
        node.appendChild(children);
        parent.appendChild(node);
        return { node, header, children };
    }

    /** Map a folder id (e.g. "markets") to the entity type the
     *  context menu should propose as "New …". Returns null when
     *  the folder doesn't correspond to one of the canonical types
     *  (e.g. nested archetype folders inside markets). */
    _typeForFolder(folderId) {
        if (typeof folderId !== 'string') return null;
        // Keyed on the REAL top-level directory names the walk surfaces.
        const map = {
            sub_sectors: 'sector',
            agents:      'agent',
            market:      'market',
            scenarios:   'scenario',
            kpis:        'kpi',
            dashboards:  'dashboard',
        };
        return map[folderId] || null;
    }

    _openFolderContextMenu(folderId, label, evt) {
        document.querySelectorAll('.ea-project-menu').forEach((el) => el.remove());
        const focused = this._typeForFolder(folderId);
        const items = focused
            ? [
                // Folder-specific shortcut on top.
                { action: `new:${focused}`, label: `New ${focused}`,
                  icon: ProjectSidebar.NEW_ENTITY_TYPES.find((t) => t.type === focused)?.icon
                        || 'add' },
                { sep: true },
                // Then every other creatable type, so the user isn't
                // forced to click around to add an off-folder entity.
                ...ProjectSidebar.NEW_ENTITY_TYPES
                    .filter((t) => t.type !== focused)
                    .map((t) => ({ action: `new:${t.type}`, label: `New ${t.label.toLowerCase()}`, icon: t.icon })),
            ]
            : ProjectSidebar.NEW_ENTITY_TYPES.map(
                (t) => ({ action: `new:${t.type}`, label: `New ${t.label.toLowerCase()}`, icon: t.icon }));
        const menu = document.createElement('div');
        menu.className = 'ea-project-menu';
        menu.innerHTML = items.map((it) => {
            if (it.sep) return `<div class="ea-project-menu__sep"></div>`;
            return `
                <button type="button" class="ea-project-menu__item"
                        data-action="${it.action}">
                    <span class="material-symbols-outlined">${it.icon}</span>
                    <span>${it.label}</span>
                </button>`;
        }).join('');
        menu.style.position = 'fixed';
        menu.style.top  = `${evt.clientY}px`;
        menu.style.left = `${evt.clientX}px`;
        menu.style.zIndex = '10000';
        document.body.appendChild(menu);
        const close = () => {
            menu.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDocDown = (e) => { if (!menu.contains(e.target)) close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        menu.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                close();
                const action = btn.dataset.action || '';
                if (action.startsWith('new:')) {
                    await this._createEntity(action.slice('new:'.length));
                }
            });
        });
    }

    /** The on-disk path to highlight for the active workspace tab — the
     *  reverse of `_onItemClick`, by matching its (kind, entityId) against
     *  the route map. */
    _idForActiveTab(kind, entityId) {
        const routes = this._routes || {};
        for (const [path, r] of Object.entries(routes)) {
            if (r.kind === kind && String(r.entityId) === String(entityId)) {
                return path;
            }
        }
        // `project-setup`/`home` both land on the project descriptor file.
        if (kind === 'project-setup' || kind === 'home') {
            for (const [path, r] of Object.entries(routes)) {
                if (r.kind === 'home') return path;
            }
        }
        return null;
    }

    /** Re-render so the selected row gets the `.selected` class.
     *  Cheap — the items array is tiny. */
    _refreshHighlight() {
        this._renderTree();
    }

    _onItemClick(id) {
        if (typeof id !== 'string') return;
        const r = (this._routes || {})[id];
        if (!r) return;                       // raw/unrouted file — nothing to open
        if (r.kind === 'home') return this._openProjectSetupTab();
        this.workspaceTabs?.openTab({
            kind: r.kind, entityId: r.entityId,
            label: r.label || r.entityId, icon: this._iconForKind(r.kind),
            preview: true, from: 'project-tree',
        });
    }

    _openProjectSetupTab() {
        // Clicking the top-level `project.json` row lands on Home —
        // the merged home/project-settings surface (currencies,
        // countries, FX, MtM all live there). The old standalone
        // `project-setup` tab kind is still supported for direct
        // callers, but the file-tree row now goes to Home so the
        // first thing the user sees is their project overview.
        this.workspaceTabs?.openTab({
            kind: 'home', entityId: 'home',
            label: 'Home', icon: 'home',
            preview: true, from: 'project-tree',
        });
    }

    // ─── Right-click context menu for tree leaves ──────────────────
    //
    // Parses the file id to figure out the entity kind, then offers
    // Open / Rename / Delete with the appropriate bridge endpoints.
    // The (+) dropdown above uses the same `.ea-project-menu` chrome.

    /** Decode an entity descriptor from a tree-item id.
     *  Returns `{kind, entityId}` or null when the id has no
     *  rename/delete affordance (e.g. project.json itself). */
    /** Entity descriptor for a tree-item path, from the route map — drives
     *  the right-click Rename/Delete affordances. None for files with no
     *  entity route (raw code/behavior files, the project descriptor). */
    _entityFromId(id) {
        const r = (this._routes || {})[id];
        if (!r || r.kind === 'home') return null;
        return { kind: r.kind, entityId: r.entityId };
    }

    _openItemContextMenu(id, label, evt) {
        document.querySelectorAll('.ea-project-menu').forEach((el) => el.remove());
        const entity = this._entityFromId(id);
        const menu = document.createElement('div');
        menu.className = 'ea-project-menu';
        const items = [
            { action: 'open',   label: 'Open',   icon: 'open_in_new' },
        ];
        if (entity) {
            items.push({ action: 'rename', label: 'Rename…', icon: 'edit' });
            items.push({ sep: true });
            items.push({ action: 'delete', label: 'Delete',  icon: 'delete',
                         danger: true });
        }
        menu.innerHTML = items.map((it) => {
            if (it.sep) return `<div class="ea-project-menu__sep"></div>`;
            const danger = it.danger ? ' ea-project-menu__item--danger' : '';
            return `
                <button type="button" class="ea-project-menu__item${danger}"
                        data-action="${it.action}">
                    <span class="material-symbols-outlined">${it.icon}</span>
                    <span>${it.label}</span>
                </button>`;
        }).join('');
        menu.style.position = 'fixed';
        menu.style.top  = `${evt.clientY}px`;
        menu.style.left = `${evt.clientX}px`;
        menu.style.zIndex = '10000';
        document.body.appendChild(menu);
        const close = () => {
            menu.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDocDown = (e) => { if (!menu.contains(e.target)) close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        menu.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                close();
                const action = btn.dataset.action;
                if (action === 'open') return this._onItemClick(id);
                if (action === 'rename') return this._renameEntity(entity, label);
                if (action === 'delete') return this._deleteEntity(entity, label);
            });
        });
    }

    async _renameEntity({ kind, entityId }, label) {
        const api = window.pywebview?.api;
        if (!api) return;
        // Rule (project policy): the user never types an id; they
        // type a label. Renaming changes the entity's display label
        // and re-derives the id (filename + cross-references) from
        // the new slug. The dialog defaults to the current label.
        const data = await openForm({
            title: `Rename ${kind}`,
            fields: [
                { name: 'label', label: 'New label', type: 'text', required: true,
                  default: label || entityId,
                  hint: 'Renaming re-derives the id and updates cross-references.' },
            ],
            submitLabel: 'Rename',
        });
        if (!data) return;
        const newLabel = String(data.label || '').trim();
        if (!newLabel) return;
        const newId = slugify(newLabel);
        if (!newId || newId === entityId) return;
        let res;
        switch (kind) {
            case 'sector':
                res = await api.sector_update?.(entityId, null, null, null, newId, null);
                break;
            case 'asset_kind':
                // No first-class rename endpoint — surface a friendly
                // message instead of silently doing nothing.
                await openConfirm({
                    title: 'Rename not supported',
                    message: 'Asset kinds can\'t be renamed in-place — references would break. Delete and recreate.',
                    confirmLabel: 'OK',
                });
                return;
            case 'agent': {
                // The archetype endpoint is `archetype_rename`.
                res = await api.archetype_rename?.(entityId, newId);
                break;
            }
            case 'market':
                // No rename endpoint; markets are keyed on id everywhere.
                await openConfirm({
                    title: 'Rename not supported',
                    message: 'Markets are keyed by id across the world model. Delete and recreate to change the id.',
                    confirmLabel: 'OK',
                });
                return;
            case 'scenario':
                // scenario_save with same id won't rename; user must
                // create a new + delete old.
                await openConfirm({
                    title: 'Rename not supported',
                    message: 'Scenarios can\'t be renamed in-place — duplicate to a new id and delete the old.',
                    confirmLabel: 'OK',
                });
                return;
            case 'dashboard':
                await openConfirm({
                    title: 'Rename not supported',
                    message: 'Dashboards can\'t be renamed in-place — duplicate and delete the old.',
                    confirmLabel: 'OK',
                });
                return;
        }
        if (res?.ok === false) this.logger.warn?.(res.error);
        await this._refresh();
    }

    async _deleteEntity({ kind, entityId }, label) {
        const api = window.pywebview?.api;
        if (!api) return;
        const ok = await openConfirm({
            title: `Delete ${kind} "${entityId}"`,
            message: 'This is permanent. Continue?',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        let res;
        switch (kind) {
            case 'sector':     res = await api.sector_remove?.(entityId); break;
            case 'asset_kind': res = await api.asset_remove?.(entityId); break;
            case 'agent':      res = await api.agent_remove?.(entityId); break;
            case 'market': {
                // entityId is the full `archetype.instance` market id.
                const dot = entityId.indexOf('.');
                if (dot > 0) {
                    res = await api.market_instance_remove?.(
                        entityId.slice(0, dot), entityId.slice(dot + 1),
                    );
                }
                break;
            }
            case 'scenario':   res = await api.scenario_delete?.(entityId); break;
            case 'dashboard':  res = await api.analytics_dashboard_delete?.(entityId); break;
        }
        if (res?.ok === false) this.logger.warn?.(res.error);
        // Close the tab if it was open.
        if (this.workspaceTabs?.closeTab) {
            try { this.workspaceTabs.closeTab(`${kind}:${entityId}`); }
            catch { /* ignore */ }
        }
        await this._refresh();
    }

    // ─── New-entity dropdown + per-type create flows ────────────────
    //
    // Triggered by the (+) button on the Files section header. One
    // entry per typed directory. Picking an entry opens a small form
    // dialog asking for id / label / minimal required fields, then
    // calls the matching bridge endpoint and refreshes the tree.

    /** Canonical "creatable entity types" list — drives the (+) menu,
     *  the top-bar File > New submenu, and any future context-menu
     *  "New …" entry. Asset kinds + events are NOT here: they're
     *  registries / aggregated lists managed via the project setup
     *  tab rather than as standalone files. */
    static NEW_ENTITY_TYPES = [
        { type: 'sector',            label: 'Sector',           icon: 'account_tree' },
        { type: 'agent',             label: 'Agent archetype',  icon: 'group' },
        { type: 'market',            label: 'Market',           icon: 'storefront' },
        { type: 'market-archetype',  label: 'Market', icon: 'category' },
        { type: 'scenario',          label: 'Scenario',         icon: 'science' },
        { type: 'dashboard',         label: 'Dashboard',        icon: 'monitoring' },
        { type: 'kpi',               label: 'KPI',              icon: 'analytics' },
    ];

    /** Open the new-entity dropdown anchored under `anchorEl`. Used
     *  by both the (+) button (per-instance) and the top-bar
     *  "File > New…" menu entry (static, no sidebar instance
     *  needed). When triggered without an instance, dispatches the
     *  selected create action via an event so the live sidebar can
     *  handle it. */
    static openNewEntityMenuAt(anchorEl, eventBus, opts = {}) {
        if (!anchorEl) return;
        document.querySelectorAll('.ea-project-menu').forEach((el) => el.remove());
        // Optional `only: [type, ...]` filter — used by markets_sidebar's
        // (+) button to surface just "Market" + "Market archetype".
        const onlySet = Array.isArray(opts.only) ? new Set(opts.only) : null;
        const items = onlySet
            ? ProjectSidebar.NEW_ENTITY_TYPES.filter((t) => onlySet.has(t.type))
            : ProjectSidebar.NEW_ENTITY_TYPES;
        const menu = document.createElement('div');
        menu.className = 'ea-project-menu';
        menu.innerHTML = items.map((it) => `
            <button type="button" class="ea-project-menu__item" data-type="${it.type}">
                <span class="material-symbols-outlined">${it.icon}</span>
                <span>${it.label}</span>
            </button>
        `).join('');
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top  = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.zIndex = '10000';
        document.body.appendChild(menu);
        const close = () => {
            menu.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDocDown = (e) => { if (!menu.contains(e.target)) close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        menu.querySelectorAll('[data-type]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                close();
                // Route through the eventBus so the live ProjectSidebar
                // instance can run its `_createEntity` flow.
                eventBus?.emit?.('ecoagent:project:new-entity',
                    { type: btn.dataset.type });
            });
        });
    }

    /** Anchor a popup menu under `anchorEl` listing every entity
     *  type the user can create. Closes on outside click / Escape. */
    _openNewEntityMenu(anchorEl) {
        if (!anchorEl) return;
        document.querySelectorAll('.ea-project-menu').forEach((el) => el.remove());
        const items = ProjectSidebar.NEW_ENTITY_TYPES;
        const menu = document.createElement('div');
        menu.className = 'ea-project-menu';
        menu.innerHTML = items.map((it) => `
            <button type="button" class="ea-project-menu__item" data-type="${it.type}">
                <span class="material-symbols-outlined">${it.icon}</span>
                <span>${it.label}</span>
            </button>
        `).join('');
        // Position the menu just below the trigger.
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.zIndex = '10000';
        document.body.appendChild(menu);
        const close = () => {
            menu.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDocDown = (e) => {
            if (!menu.contains(e.target)) close();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        menu.querySelectorAll('[data-type]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                close();
                await this._createEntity(btn.dataset.type);
            });
        });
    }

    /** Create-then-edit, no modal. Mint a placeholder entity with a
     *  unique "Untitled <Type>" label + sensible default settings,
     *  then open its tab in autoEditTitle mode so the user renames
     *  + reconfigures inline (matches macOS File > New behavior).
     *  See `_createKpi` for the original precedent of this pattern. */
    async _createEntity(type) {
        const api = window.pywebview?.api;
        if (!api) return;

        // Mint a unique "Untitled X" label by checking the cached
        // entity list and incrementing until no collision.
        const mintLabel = (typeLabel, existingList) => {
            const usedIds = new Set((existingList || []).map((e) => e.id));
            let label = `Untitled ${typeLabel}`;
            let id = slugify(label);
            let n = 2;
            while (id && usedIds.has(id)) {
                label = `Untitled ${typeLabel} ${n}`;
                id = slugify(label);
                n++;
                if (n > 999) break;
            }
            return { id, label };
        };

        switch (type) {
            case 'sector': {
                const { id, label } = mintLabel('Sector', this._sectors);
                if (!id) return;
                const res = await api.sector_add?.(id, label, 'real');
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'sector', entityId: id, label,
                    icon: 'account_tree', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'agent': {
                const { id, label } = mintLabel('Agent', this._archetypes);
                if (!id) return;
                const res = await api.agent_add?.(id, label, null, 1, 'non_bank');
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'agent', entityId: id, label,
                    icon: 'group', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'market': {
                // Every market is an archetype with at least one instance.
                // Adding from the (+) menu creates a 1-instance archetype.
                const { id, label } = mintLabel('Market', this._markets);
                if (!id) return;
                const res = await api.market_add?.(
                    id, 'ContinuousDoubleAuction', {}, ['default']);
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'market', entityId: `${id}.default`, label,
                    icon: 'storefront', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'market-archetype': {
                // Mint against the cached archetype list. The project
                // sidebar doesn't cache archetypes yet (markets_sidebar
                // does), so fetch once here — cheap relative to user
                // typing speed and only fires on File > New.
                let existing = [];
                try {
                    existing = (await api.markets_list?.()) || [];
                } catch { /* fall through with empty list */ }
                const { id, label } = mintLabel('Archetype', existing);
                if (!id) return;
                const res = await api.market_add?.(id, 'ContinuousDoubleAuction', {}, []);
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'market-archetype', entityId: id, label,
                    icon: 'category', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'scenario': {
                const { id, label } = mintLabel('Scenario', this._scenarios);
                if (!id) return;
                const res = await api.scenario_save?.(id, label, '', {});
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'scenario', entityId: id, label,
                    icon: 'science', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'dashboard': {
                const { id, label } = mintLabel('Dashboard', this._dashboards);
                if (!id) return;
                const res = await api.analytics_dashboard_save?.(id, label, [], null);
                if (res?.ok === false) { this.logger.warn?.(res.error); return; }
                await this._refresh();
                this.workspaceTabs?.openTab({
                    kind: 'dashboard', entityId: id, label,
                    icon: 'monitoring', preview: false, from: 'project-tree',
                    autoEditTitle: true,
                });
                return;
            }
            case 'kpi': {
                await this._createKpi(api);
                return;
            }
        }
    }

    /** Create-then-edit: no modal. Mint a unique placeholder KPI
     *  and immediately open its tab — the tab carries the whole
     *  authoring surface (rename inline, country / kind, template
     *  picker with parameter mapping, Monaco expression, delete). */
    async _createKpi(api) {
        // The python bridge currently has no `kpi_save` endpoint
        // (KpiSpec is defined in `ecoagent/sim/kpis.py` but never
        // exposed through `ecoagent/bridge/api.py`). Fail loudly so
        // the user knows it's a backend-side gap, not a silent UI bug.
        if (typeof api.kpi_save !== 'function') {
            const { toastWarn } = await import('./ui/toast.js');
            toastWarn('KPI creation unavailable',
                'The python bridge has no `kpi_save` endpoint yet — KPIs can be authored in code but not from the UI. Add `kpi_save` / `kpis_list` / `kpi_remove` to `ecoagent/bridge/api.py` to enable this.');
            return;
        }
        const existing = Array.isArray(this._kpis) ? this._kpis : [];
        const usedIds = new Set(existing.map((k) => k.id));
        let label = 'Untitled KPI';
        let id = slugify(label);
        let n = 2;
        while (usedIds.has(id)) {
            label = `Untitled KPI ${n}`;
            id = slugify(label);
            n++;
            if (n > 999) break;
        }
        const res = await api.kpi_save?.(
            id, label, null, 'ratio', '', '0.0', '',
        );
        if (res?.ok === false) {
            this.logger.warn?.(res.error);
            return;
        }
        await this._refresh();
        this.workspaceTabs?.openTab({
            kind: 'kpi', entityId: id, label,
            icon: 'analytics', preview: false, from: 'project-tree',
            autoEditTitle: true,
        });
    }
}
