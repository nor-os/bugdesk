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


