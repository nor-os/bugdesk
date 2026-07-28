/**
 * sidebar.js — build sidebar fragments that match Ecosim's Data-page idiom.
 *
 * Structure produced (same as ui/js/ui/pages/data_page.js #buildShell):
 *
 *   .data-browser-panel
 *     header.fixed-panel-header           (icon + title)
 *     .sidebar-controls                   (search input)
 *     .sidebar-body.sidebar-body--accordion
 *       .tree-category.dynamic-sheet-section          (one per section)
 *         .collapsible-header[data-collapsible-header]
 *           button.arrow-toggle > .collapsible-arrow
 *           span (label)
 *           [optional .collapsible-header__action buttons]
 *         .collapsible-content[data-collapsible-content].visible
 *           ul.tree-view
 *             li.tree-item                (per item)
 *
 * The global toggle handler in application_shell.js wires only headers
 * present at app-bootstrap time. Our fragments are added later, so we
 * wire a local handler scoped to this panel.
 */

export function buildBrowserPanel({
    mount,
    icon,
    title,
    sections,        // [{ id, label, addable, addTooltip, defaultExpanded, actions }]
    tabs = [],       // [{ id, icon, title }] — extra header tabs alongside the implicit "main" sections tab
    onTabChange,     // (tabId) => void — fired after tab switch (use to lazy-mount tab contents)
    onSearch,        // (query) => void
    searchPlaceholder = 'Filter…',
} = {}) {
    if (!mount) throw new Error('buildBrowserPanel: mount required');

    mount.innerHTML = '';

    // Inner wrapper carries the `.data-browser-panel` styling. Matches the
    // shape Ecosim's data_page.js #buildShell uses
    // (`#fixed-200 > [data-panel-content] > .data-browser-panel > …`).
    // We use the same class so Ecosim's `:has(.data-browser-panel)` rule
    // strips fixed-200's padding when our mode is active.
    const root = document.createElement('div');
    root.className = 'data-browser-panel ea-browser-panel';
    // Inline sizing so the wrapper doesn't depend on Ecosim's flex parent
    // layout for height — works whether or not the [data-panel-content]
    // un-hide rule fires.
    root.style.cssText = `
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
    `;
    mount.appendChild(root);

    const header = document.createElement('header');
    header.className = 'fixed-panel-header';
    header.innerHTML = `
        <span class="material-symbols-outlined">${icon}</span>
        <span>${title}</span>
    `;
    root.appendChild(header);

    // Tab toggle buttons in the header — first is the implicit "main" sections
    // tab (icon + title from the top-level args), followed by any extras.
    const tabsMap = new Map();
    if (tabs.length > 0) {
        const spacer = document.createElement('span');
        spacer.className = 'fixed-panel-header__spacer';
        header.appendChild(spacer);

        const makeToggleBtn = (tabId, iconName, titleAttr, active) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fixed-panel-header__toggle-btn'
                + (active ? ' fixed-panel-header__toggle-btn--active' : '');
            btn.dataset.panel = tabId;
            btn.title = titleAttr;
            btn.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
            header.appendChild(btn);
            return btn;
        };

        const mainBtn = makeToggleBtn('main', icon, title, true);
        tabsMap.set('main', { btn: mainBtn, panel: null, host: null });

        for (const t of tabs) {
            const btn = makeToggleBtn(t.id, t.icon, t.title, false);
            tabsMap.set(t.id, { btn, panel: null, host: null });
        }
    }

    // Search input is opt-in: pages that don't pass onSearch have no
    // filter bar (e.g. SFC's sectors + asset kinds — tiny static lists).
    let searchInput = null;
    let searchControls = null;
    if (onSearch) {
        searchControls = document.createElement('div');
        searchControls.className = 'sidebar-controls';
        const searchIcon = document.createElement('span');
        searchIcon.className = 'material-symbols-outlined sidebar-search-icon';
        searchIcon.textContent = 'search';
        searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'data-page__search';
        searchInput.placeholder = searchPlaceholder;
        searchInput.addEventListener('input', () => onSearch(searchInput.value));
        searchControls.append(searchIcon, searchInput);
        root.appendChild(searchControls);
    }

    // When tabs are in play, wrap the sections body in a `.sidebar-panel`
    // and add sibling panels (one per extra tab). Without tabs, body lives
    // directly on the root (legacy behavior).
    const body = document.createElement('div');
    body.className = 'sidebar-body sidebar-body--accordion';
    body.dataset.scrollable = '0';

    if (tabs.length > 0) {
        const panelsHost = document.createElement('div');
        panelsHost.className = 'sidebar-panels';
        panelsHost.style.cssText = 'flex:1; min-height:0; display:flex; flex-direction:column;';

        const mainPanel = document.createElement('div');
        mainPanel.className = 'sidebar-panel sidebar-panel--main';
        mainPanel.dataset.panel = 'main';
        mainPanel.style.cssText = 'flex:1; min-height:0; display:flex; flex-direction:column;';
        // Stash the intended display so the swap can restore it
        // verbatim (avoids the `style.display = ''` → fallback-to-
        // block bug where the main panel rendered empty after a
        // Git → Files toggle).
        mainPanel.dataset.activeDisplay = 'flex';
        mainPanel.appendChild(body);
        panelsHost.appendChild(mainPanel);
        tabsMap.get('main').panel = mainPanel;

        for (const t of tabs) {
            const panel = document.createElement('div');
            panel.className = `sidebar-panel sidebar-panel--${t.id}`;
            panel.dataset.panel = t.id;
            panel.hidden = true;
            // Inline display:none beats the cascade tie between
            // `[hidden]` (UA stylesheet) and `.sidebar-panel { flex:1 }`
            // — without it, hidden panels would still occupy the
            // sidebar body alongside the visible one (the "appending"
            // behaviour the user saw before).
            panel.style.cssText = 'flex:1; min-height:0; overflow:auto; display:none;';
            panel.dataset.activeDisplay = 'block';
            const host = document.createElement('div');
            host.className = `ea-${t.id}-host`;
            panel.appendChild(host);
            panelsHost.appendChild(panel);
            const entry = tabsMap.get(t.id);
            entry.panel = panel;
            entry.host = host;
        }
        root.appendChild(panelsHost);

        // Header click handler — swap active tab. Inactive panels get
        // `display: none` (inline, beats cascade); the active one is
        // restored to its default flex layout. `hidden` attribute is
        // kept in sync for a11y / CSS that keys on it.
        header.addEventListener('click', (e) => {
            const btn = e.target.closest('.fixed-panel-header__toggle-btn');
            if (!btn) return;
            const tabId = btn.dataset.panel;
            if (!tabId || !tabsMap.has(tabId)) return;
            for (const [id, entry] of tabsMap) {
                const active = (id === tabId);
                entry.btn.classList.toggle('fixed-panel-header__toggle-btn--active', active);
                if (entry.panel) {
                    entry.panel.hidden = !active;
                    // Restore each panel's intended display (stashed
                    // on `dataset.activeDisplay` at creation) rather
                    // than clearing the inline value — clearing
                    // dropped the main panel's `display:flex` and
                    // left it rendering empty after a tab swap.
                    entry.panel.style.display = active
                        ? (entry.panel.dataset.activeDisplay || 'block')
                        : 'none';
                }
            }
            if (searchControls) searchControls.style.display = tabId === 'main' ? '' : 'none';
            onTabChange?.(tabId);
        });
    } else {
        root.appendChild(body);
    }

    const sectionsMap = new Map();
    for (const cfg of sections) {
        const expanded = cfg.defaultExpanded !== false;

        const box = document.createElement('div');
        box.className = 'tree-category dynamic-sheet-section';
        box.dataset.collapsibleId = cfg.id;
        if (expanded) box.dataset.collapsibleDefault = 'expanded';

        const sHeader = document.createElement('div');
        sHeader.className = 'collapsible-header';
        sHeader.dataset.collapsibleHeader = 'true';

        const arrowToggle = document.createElement('button');
        arrowToggle.type = 'button';
        arrowToggle.className = 'arrow-toggle';
        const arrowIcon = document.createElement('span');
        arrowIcon.className = 'collapsible-arrow material-symbols-outlined';
        arrowIcon.textContent = 'expand_more';
        if (!expanded) arrowIcon.classList.add('collapsed');
        arrowToggle.appendChild(arrowIcon);
        sHeader.appendChild(arrowToggle);

        const labelEl = document.createElement('span');
        labelEl.textContent = cfg.label;
        sHeader.appendChild(labelEl);

        const actions = [];
        for (const action of (cfg.actions || [])) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'collapsible-header__action has-tooltip';
            btn.dataset.tooltip = action.tooltip || '';
            btn.innerHTML = `<span class="material-symbols-outlined">${action.icon}</span>`;
            if (action.onClick) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    action.onClick();
                });
            }
            sHeader.appendChild(btn);
            actions.push(btn);
        }

        let addBtn = null;
        if (cfg.addable) {
            addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'collapsible-header__action has-tooltip';
            addBtn.dataset.tooltip = cfg.addTooltip || `Add ${cfg.label.toLowerCase()}`;
            addBtn.innerHTML = '<span class="material-symbols-outlined">add</span>';
            sHeader.appendChild(addBtn);
        }

        box.appendChild(sHeader);

        const sContent = document.createElement('div');
        sContent.className = 'collapsible-content' + (expanded ? ' visible' : '');
        sContent.dataset.collapsibleContent = 'true';

        const list = document.createElement('ul');
        list.className = 'tree-view';
        list.dataset.role = `${cfg.id}-list`;
        sContent.appendChild(list);

        box.appendChild(sContent);
        body.appendChild(box);

        sectionsMap.set(cfg.id, {
            box, headerEl: sHeader, contentEl: sContent, listEl: list,
            addBtn, actions, arrowIcon,
        });
    }

    // Local collapsible toggle (the global handler at application_shell.js:2145
    // only sees headers present at bootstrap; ours are added later).
    body.addEventListener('click', (e) => {
        const headerEl = e.target.closest('[data-collapsible-header="true"]');
        if (!headerEl) return;
        if (e.target.closest('input, button:not(.arrow-toggle)')) return;
        const box = headerEl.closest('[data-collapsible-id]');
        if (!box) return;
        const content = box.querySelector('[data-collapsible-content="true"]');
        const arrow = headerEl.querySelector('.collapsible-arrow');
        if (!content) return;
        const isVisible = content.classList.contains('visible');
        content.classList.toggle('visible', !isVisible);
        if (arrow) arrow.classList.toggle('collapsed', isVisible);
    });

    return { searchInput, sections: sectionsMap, tabs: tabsMap };
}


/**
 * Lazy-mount Ecosim's GitPanel into a sidebar tab host element, with a
 * pending-changes badge on the tab's toggle button.
 *
 * Idempotent: a second call is a no-op (just resumes polling).
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.host          Container the GitPanel renders into.
 * @param {HTMLElement|null} opts.toggleBtn Header toggle button receiving the
 *                                          numeric badge (optional).
 * @returns {Promise<{panel: any}>}        Resolves with the mounted GitPanel.
 */
// Per-host cache entry: the GitPanel instance + the projectPath it was
// mounted with. A second call to mountGitTab reuses the panel iff the
// project hasn't changed; otherwise it disposes the stale one and
// builds a fresh panel pointed at the new project. Without this check
// the panel kept rendering against whichever project happened to be
// active when its host was first opened, even after the user switched
// projects — that's the "source control view is broken" symptom: the
// status / file list never updates for the new project.
const _gitTabState = new WeakMap();

export async function mountGitTab({ host, toggleBtn } = {}) {
    if (!host) return { panel: null };

    let currentPath = null;
    let currentName = '';
    try {
        const current = await window.pywebview?.api?.project_current?.();
        currentPath = current?.path || null;
        currentName = current?.name || '';
    } catch { /* keep null */ }

    const existing = _gitTabState.get(host);
    if (existing) {
        if ((existing._project?.projectPath || null) === currentPath) {
            // Same project — just resume polling on the existing panel.
            existing.panel.startPolling?.();
            return { panel: existing.panel };
        }
        // Project changed — tear the old panel down before re-mounting,
        // so its polling timer stops and the new panel doesn't double-poll.
        try { existing.panel.dispose?.(); } catch { /* ignore */ }
        _gitTabState.delete(host);
        host.innerHTML = '';
    }

    const { GitPanel } = await import('../../notebook/git_panel.js');
    const project = { projectPath: currentPath, projectName: currentName };
    const panel = new GitPanel();
    panel.mount({
        container: host,
        project,
        onOpenDiff: async (filePath, status) => {
            const { openGitDiffModal } = await import('./git_diff_modal.js');
            openGitDiffModal({ filePath, status });
        },
        onBadgeUpdate: (count) => {
            if (!toggleBtn) return;
            let badge = toggleBtn.querySelector('.ea-git-tab-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'ea-git-tab-badge';
                    toggleBtn.appendChild(badge);
                }
                badge.textContent = String(count);
            } else if (badge) {
                badge.remove();
            }
        },
    });
    _gitTabState.set(host, { panel, _project: project });
    return { panel };
}

/** Drop any cached GitPanel — used when the project changes externally
 *  so the next click on the Source Control tab builds a fresh panel
 *  pointed at the new project. Safe to call with hosts that don't have
 *  a cached panel (no-op). */
export function disposeGitTab(host) {
    if (!host) return;
    const existing = _gitTabState.get(host);
    if (!existing) return;
    try { existing.panel.dispose?.(); } catch { /* ignore */ }
    _gitTabState.delete(host);
    host.innerHTML = '';
}


/**
 * Render an array of items into a .tree-view list, matching the hover-action
 * pattern used by ui/js/notebook/file_navigator.js (.tree-node__action-btn).
 *
 * items: [{ id, label, subtitle?, icon?, children?, expanded? }]
 *
 * An item with a non-empty `children` array gets an expand chevron; when
 * `expanded` is true its children render as indented rows directly below.
 * children: [{ id, label, icon? }]
 *
 * Hooks:
 *   onSelect(id, item)            — left click on row
 *   onDelete(id, item)            — hover trash-can button + Esc-safe
 *   onRename(id, item)            — hover edit button
 *   onContextMenu(id, item, x, y) — right click; caller is expected to
 *                                   open a popup menu (use context_menu.js)
 *   onToggleExpand(id, item)      — click on the expand chevron
 *   onSelectChild(parentId, childId, child) — left click on a child row
 */
export function renderTreeItems(listEl, items, {
    selectedId = null,
    selectedChildId = null,
    emptyMessage = 'Nothing here yet.',
    onSelect = null,
    onDelete = null,
    onRename = null,
    onContextMenu = null,
    onToggleExpand = null,
    onSelectChild = null,
    onAddChild = null,                      // (parentId, parentItem) — shows a + button on parents
    addChildTooltip = 'Add instance',
    deleteTooltip = 'Delete',
    renameTooltip = 'Rename',
} = {}) {
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tree-empty-message';
        empty.textContent = emptyMessage;
        listEl.appendChild(empty);
        return;
    }
    for (const it of items) {
        const li = document.createElement('li');
        li.className = 'tree-item';
        if (it.id === selectedId) li.classList.add('selected');
        li.dataset.itemId = it.id;

        const hasChildren = Array.isArray(it.children) && it.children.length > 0;
        if (hasChildren) {
            const chevron = document.createElement('button');
            chevron.type = 'button';
            chevron.className = 'tree-item__chevron'
                + (it.expanded ? ' tree-item__chevron--expanded' : '');
            chevron.title = it.expanded ? 'Collapse' : 'Expand';
            chevron.innerHTML = '<span class="material-symbols-outlined">chevron_right</span>';
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                onToggleExpand?.(it.id, it);
            });
            li.appendChild(chevron);
        }

        if (it.icon) {
            const ic = document.createElement('span');
            ic.className = 'tree-item__icon';
            ic.innerHTML = `<span class="material-symbols-outlined">${it.icon}</span>`;
            li.appendChild(ic);
        }

        const lab = document.createElement('span');
        lab.className = 'tree-item__label';
        lab.textContent = it.label ?? it.id;
        li.appendChild(lab);

        if (it.subtitle) {
            const sub = document.createElement('span');
            sub.className = 'tree-item__subtitle';
            sub.textContent = it.subtitle;
            li.appendChild(sub);
        }

        const showAddChild = !!onAddChild && hasChildren;
        if (onRename || onDelete || showAddChild) {
            const actions = document.createElement('span');
            actions.className = 'tree-item__actions';
            if (showAddChild) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tree-node__action-btn';
                btn.title = addChildTooltip;
                btn.innerHTML = '<span class="material-symbols-outlined">add</span>';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onAddChild(it.id, it);
                });
                actions.appendChild(btn);
            }
            if (onRename) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tree-node__action-btn';
                btn.title = renameTooltip;
                btn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onRename(it.id, it);
                });
                actions.appendChild(btn);
            }
            if (onDelete) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tree-node__action-btn';
                btn.title = deleteTooltip;
                btn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onDelete(it.id, it);
                });
                actions.appendChild(btn);
            }
            li.appendChild(actions);
        }

        if (onSelect) {
            li.addEventListener('click', (e) => {
                // Double-click on a tree-item with children toggles
                // expand/collapse (handy — the chevron is a small target).
                // We detect it manually rather than via a `dblclick`
                // listener: `onSelect` typically re-renders the whole list,
                // destroying this <li>, so the browser never sees two
                // clicks land on the *same* element and `dblclick` never
                // fires. `listEl` survives the re-render, so we stash the
                // last click on it and treat a quick repeat on the same id
                // as the toggle.
                if (hasChildren && onToggleExpand
                    && !e.target.closest('.tree-item__actions')) {
                    const now = Date.now();
                    const last = listEl.__treeLastClick;
                    if (last && last.id === it.id && now - last.time < 350) {
                        listEl.__treeLastClick = null;
                        onToggleExpand(it.id, it);
                        return;
                    }
                    listEl.__treeLastClick = { id: it.id, time: now };
                }
                onSelect(it.id, it);
            });
        }
        if (onContextMenu) {
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(it.id, it, e.clientX, e.clientY);
            });
        }
        listEl.appendChild(li);

        // Children render as indented sibling rows directly below the
        // parent — keeps the flat <ul.tree-view> markup the sidebar CSS
        // expects rather than nesting another list.
        if (hasChildren && it.expanded) {
            for (const child of it.children) {
                const childLi = document.createElement('li');
                childLi.className = 'tree-item tree-item--child';
                // Child ids are globally unique, so `selectedChildId` alone
                // identifies the active child. Don't also require the parent
                // to equal `selectedId` — for grouped rows the parent id is
                // a synthetic `__arch:<name>` that never matches it.
                if (selectedChildId != null && child.id === selectedChildId) {
                    childLi.classList.add('selected');
                }
                childLi.dataset.itemId = it.id;
                childLi.dataset.childId = child.id;

                if (child.icon) {
                    const ic = document.createElement('span');
                    ic.className = 'tree-item__icon';
                    ic.innerHTML = `<span class="material-symbols-outlined">${child.icon}</span>`;
                    childLi.appendChild(ic);
                }

                const childLab = document.createElement('span');
                childLab.className = 'tree-item__label';
                childLab.textContent = child.label ?? child.id;
                childLi.appendChild(childLab);

                childLi.addEventListener('click', () =>
                    onSelectChild?.(it.id, child.id, child));
                listEl.appendChild(childLi);
            }
        }
    }
}
