/**
 * FileNavigator — left sidebar: project file tree + symbol outline + git.
 *
 * Three panels (toggled by tab):
 *   FILES   — project file tree grouped by type (model, scenarios, modules, tests)
 *   OUTLINE — symbol outline for all project files (namespaces, vars, stocks, flows)
 *   GIT     — source control: branch bar, commit area, changes list, commit graph
 *
 * Uses the shared TreeView component (createTreeCategory, createTreeItem, toggleCategory)
 * so that the sidebar matches the same paradigm used by Functions Page and Data Page.
 *
 * Callbacks from parent (NotebookPage):
 *   onOpenFile(filePath)
 *   onNewFile(fileType, suggestedPath)
 *   onRenameFile(oldPath, newPath)
 *   onDeleteFile(filePath)
 *   onDuplicateFile(filePath)
 *   onRevealInExplorer(filePath)
 *   onOpenDiff(filePath, status)
 *
 * Listens to ProjectModel events via EventBus.
 */

import { ProjectModel } from '../data/project_model.js';
import {
    TreeView,
    createTreeCategory,
    createTreeItem,
    toggleCategory,
    selectItem,
} from '../ui/components/tree_view.js';
import { installOverlayScrollbar } from '../ui/utils/overlay_scrollbar.js';
import { GitPanel } from './git_panel.js';

const FILE_GROUPS = [
    { type: 'namespace', label: 'Namespaces', icon: 'dataset',         newable: true, ext: '.namespace' },
    { type: 'module',    label: 'Modules',    icon: 'extension',       newable: true, dir: 'modules',   ext: '.edf' },
    { type: 'test',      label: 'Tests',      icon: 'fact_check',      newable: true, dir: 'tests',     ext: '.test' },
];

export class FileNavigator {
    /** @type {HTMLElement} */
    #container = null;

    /** @type {object} */
    #project = null;

    /** @type {string} 'files'|'outline'|'git' */
    #activePanel = 'files';

    /** @type {string|null} */
    #activeFile = null;

    /** @type {object[]} */
    #outlineSymbols = [];

    /** @type {object[]} Builtin modules: [{ name, filename, content }] */
    #builtinModules = [];

    /** @type {Set<string>} Tracks which category IDs user has collapsed */
    #collapsedCategories = new Set();

    /** @type {object} callbacks */
    #callbacks = {};

    /** @type {Function[]} */
    #disposers = [];

    /** @type {TreeView|null} */
    #treeView = null;


    /** @type {{ update: Function, cleanup: Function }|null} */
    #filesScrollbar = null;
    /** @type {{ update: Function, cleanup: Function }|null} */
    #outlineScrollbar = null;
    /** @type {{ update: Function, cleanup: Function }|null} */
    #gitScrollbar = null;

    /** @type {GitPanel|null} */
    #gitPanel = null;

    /** @type {Map<string, {text?: string, variant: string}>} Path → badge config */
    #fileBadges = new Map();

    /** @type {HTMLElement|null} */
    #contextMenuEl = null;
    /** @type {Function|null} */
    #boundHideContextMenu = null;

    /** @type {boolean} */
    #isInlineRenaming = false;

    /** Double-click detection (survives tree re-renders that destroy DOM between click events) */
    #lastClickItemId = null;
    #lastClickTime = 0;

    constructor({ eventBus, logger } = {}) {
        this.eventBus = eventBus;
        this.log = logger?.createScope?.('FileNavigator') ?? console;
    }

    /**
     * @param {HTMLElement} container
     * @param {{
     *   project: ProjectModel,
     *   onOpenFile: Function,
     *   onNewFile: Function,
     *   onRenameFile: Function(oldPath, newPath),
     *   onDeleteFile: Function,
     *   onDuplicateFile: Function,
     *   onRevealInExplorer: Function,
     * }} props
     */
    mount(container, { project, onOpenFile, onPinFile, onNewFile, onRenameFile, onDeleteFile, onDuplicateFile, onRevealInExplorer, onOpenBuiltinModule, onImportModule, onOpenDiff } = {}) {
        this.#container = container;
        this.#project = project;
        this.#callbacks = { onOpenFile, onPinFile, onNewFile, onRenameFile, onDeleteFile, onDuplicateFile, onRevealInExplorer, onOpenBuiltinModule, onImportModule, onOpenDiff };
        this.#boundHideContextMenu = () => this.#hideContextMenu();

        this.#render();
        this.#subscribeEvents();
    }

    /** Set the list of builtin modules (fetched from backend). */
    setBuiltinModules(modules) {
        this.#builtinModules = modules ?? [];
        this.#renderFileTree();
    }

    /** Update active file (for highlighting in tree). */
    setActiveFile(filePath) {
        this.#activeFile = filePath;

        // Direct DOM update — toggle .selected on existing tree items
        const treeEl = this.#container?.querySelector('.file-nav-tree');
        if (!treeEl) return;

        if (filePath) {
            selectItem(treeEl, filePath, { scrollIntoView: false, expandParents: true });
        } else {
            // Deselect all
            treeEl.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
        }
    }

    /**
     * Set a badge on a file tree item.
     * @param {string} filePath
     * @param {{ text?: string, variant: string }|null} badge - null to clear
     */
    setFileBadge(filePath, badge) {
        if (badge) {
            this.#fileBadges.set(filePath, badge);
        } else {
            this.#fileBadges.delete(filePath);
        }

        // Direct DOM update — find and update the badge element
        const treeEl = this.#container?.querySelector('.file-nav-tree');
        if (!treeEl) return;

        const item = treeEl.querySelector(`.tree-item[data-item-id="${CSS.escape(filePath)}"]`);
        if (!item) return;

        // Remove existing badge
        const existingBadge = item.querySelector('.tree-item__badge, .tree-item__status-dot');
        if (existingBadge) existingBadge.remove();

        // Add new badge
        if (badge) {
            const variant = badge.variant || 'muted';
            const el = document.createElement('span');
            if (badge.text) {
                el.className = `tree-item__badge tree-item__badge--${variant}`;
                el.textContent = badge.text;
            } else {
                el.className = `tree-item__status-dot tree-item__status-dot--${variant}`;
            }
            // Insert before action buttons if present
            const actions = item.querySelector('.tree-item__actions');
            if (actions) {
                item.insertBefore(el, actions);
            } else {
                item.appendChild(el);
            }
        }
    }

    /**
     * Set badges for multiple files at once.
     * @param {Map<string, {text?: string, variant: string}>} badges
     */
    setFileBadges(badges) {
        for (const [path, badge] of badges) {
            this.setFileBadge(path, badge);
        }
    }

    startRename(filePath) {
        // Defer to next frame so the tree has rendered the new item
        requestAnimationFrame(() => {
            const treeEl = this.#container?.querySelector('.file-nav-tree');
            if (!treeEl) return;
            const item = treeEl.querySelector(`.tree-item[data-item-id="${CSS.escape(filePath)}"]`);
            if (item) this.#startInlineRename(item, filePath);
        });
    }

    setOutlineSymbols(symbols) {
        this.#outlineSymbols = symbols ?? [];
        if (this.#activePanel === 'outline') {
            this.#renderOutline();
        }
    }

    dispose() {
        this.#hideContextMenu();
        for (const d of this.#disposers) d?.();
        this.#disposers = [];
        this.#treeView?.dispose();
        this.#treeView = null;
        this.#filesScrollbar?.cleanup();
        this.#filesScrollbar = null;
        this.#outlineScrollbar?.cleanup();
        this.#outlineScrollbar = null;
        this.#gitScrollbar?.cleanup();
        this.#gitScrollbar = null;
        this.#gitPanel?.dispose();
        this.#gitPanel = null;
    }

    // ─── Rendering ────────────────────────────────────────────────────────────

    #render() {
        this.#container.innerHTML = `
            <header class="fixed-panel-header">
                <span class="material-symbols-outlined">folder_open</span>
                <span>Project</span>
                <span class="fixed-panel-header__spacer"></span>
                <button class="fixed-panel-header__toggle-btn fixed-panel-header__toggle-btn--active" data-panel="files" title="Files">
                    <span class="material-symbols-outlined">folder_open</span>
                </button>
                <button class="fixed-panel-header__toggle-btn" data-panel="outline" title="Outline">
                    <span class="material-symbols-outlined">account_tree</span>
                </button>
                <button class="fixed-panel-header__toggle-btn" data-panel="git" title="Source Control" style="position:relative">
                    <span class="material-symbols-outlined">commit</span>
                </button>
            </header>
            <div class="sidebar-body">
                <div class="sidebar-controls">
                    <span class="material-symbols-outlined sidebar-search-icon">search</span>
                    <input type="search" class="data-page__search" placeholder="Filter\u2026" />
                </div>
                <div class="sidebar-panels">
                    <div class="sidebar-panel sidebar-panel--files" data-panel="files">
                        <div class="tree-view file-nav-tree"></div>
                    </div>
                    <div class="sidebar-panel sidebar-panel--outline" data-panel="outline" hidden>
                        <div class="file-nav-outline"></div>
                    </div>
                    <div class="sidebar-panel sidebar-panel--git" data-panel="git" hidden>
                        <div class="file-nav-git"></div>
                    </div>
                </div>
            </div>
        `;

        // Tab switching (toggle buttons in header)
        this.#container.querySelectorAll('.fixed-panel-header__toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.#container.querySelectorAll('.fixed-panel-header__toggle-btn').forEach(b =>
                    b.classList.remove('fixed-panel-header__toggle-btn--active'));
                btn.classList.add('fixed-panel-header__toggle-btn--active');

                const panelId = btn.dataset.panel;
                this.#activePanel = panelId;

                this.#container.querySelectorAll('.sidebar-panel').forEach(p => {
                    p.toggleAttribute('hidden', p.dataset.panel !== panelId);
                });

                if (panelId === 'outline') this.#renderOutline();
                if (panelId === 'git') this.#ensureGitPanel();
                // Stop git polling when switching away
                if (panelId !== 'git') this.#gitPanel?.stopPolling();
            });
        });

        // Search/filter
        const searchInput = this.#container.querySelector('.data-page__search');
        if (searchInput) {
            searchInput.addEventListener('input', () => this.#filterItems(searchInput.value));
        }

        this.#renderFileTree();

        // Install overlay scrollbars on both panels
        const filesPanel = this.#container.querySelector('.sidebar-panel--files');
        const outlinePanel = this.#container.querySelector('.sidebar-panel--outline');
        if (filesPanel) {
            this.#filesScrollbar = installOverlayScrollbar(filesPanel, {
                orientation: 'vertical',
                watchSubtree: true,
            });
        }
        if (outlinePanel) {
            this.#outlineScrollbar = installOverlayScrollbar(outlinePanel, {
                orientation: 'vertical',
                watchSubtree: true,
            });
        }
    }

    #filterItems(filter) {
        const normalized = (filter || '').toLowerCase().trim();
        const panel = this.#activePanel === 'files'
            ? this.#container.querySelector('.sidebar-panel--files')
            : this.#container.querySelector('.sidebar-panel--outline');
        if (!panel) return;

        const items = panel.querySelectorAll('.tree-item');
        for (const item of items) {
            const label = item.querySelector('.tree-item__label')?.textContent?.toLowerCase() || '';
            item.style.display = (!normalized || label.includes(normalized)) ? '' : 'none';
        }

        // Show all categories (but hide empty ones)
        const categories = panel.querySelectorAll('.tree-category');
        for (const cat of categories) {
            const content = cat.querySelector('.collapsible-content');
            if (!content) continue;
            const visibleItems = content.querySelectorAll('.tree-item:not([style*="display: none"])');
            cat.style.display = (!normalized || visibleItems.length > 0) ? '' : 'none';
        }
    }

    #renderFileTree() {
        const treeEl = this.#container.querySelector('.file-nav-tree');
        if (!treeEl) return;

        if (!this.#project?.isOpen) {
            treeEl.innerHTML = '';
            this.#treeView?.dispose();
            this.#treeView = null;
            return;
        }

        // Snapshot collapsed state before re-render
        for (const cat of treeEl.querySelectorAll('.tree-category')) {
            const id = cat.dataset?.categoryId;
            if (!id) continue;
            const content = cat.querySelector('.collapsible-content');
            if (content && content.style.display === 'none') {
                this.#collapsedCategories.add(id);
            } else {
                this.#collapsedCategories.delete(id);
            }
        }

        // Dispose previous tree view
        this.#treeView?.dispose();
        treeEl.innerHTML = '';

        // Create TreeView instance
        // NOTE: We detect double-clicks manually rather than relying on the DOM
        // dblclick event, because project:file:opened destroys and re-creates
        // the entire tree between the first click and the dblclick event.
        this.#treeView = new TreeView(treeEl, {
            onItemClick: (itemId) => {
                const now = performance.now();
                if (itemId === this.#lastClickItemId && now - this.#lastClickTime < 400) {
                    this.#lastClickItemId = null;
                    this.#lastClickTime = 0;
                    this.#callbacks.onPinFile?.(itemId);
                } else {
                    this.#lastClickItemId = itemId;
                    this.#lastClickTime = now;
                    this.#callbacks.onOpenFile?.(itemId);
                }
            },
        });

        const files = this.#project.files ?? [];
        const openPaths = new Set(this.#project.openFilePaths ?? []);

        for (const group of FILE_GROUPS) {
            const groupFiles = files.filter(f => f.type === group.type);

            // Create category via TreeView component
            const categoryEl = createTreeCategory({
                id: group.type,
                label: group.label,
                icon: group.icon,
                count: group.type === 'module'
                    ? groupFiles.length + this.#builtinModules.length
                    : groupFiles.length,
                expanded: !this.#collapsedCategories.has(group.type),
            });

            // Add "New" button to the header for groups that support it
            if (group.newable) {
                const header = categoryEl.querySelector('.collapsible-header');
                const newBtn = document.createElement('button');
                newBtn.className = 'tree-node__action-btn';
                newBtn.title = group.type === 'module'
                    ? 'New or import module'
                    : `New ${group.label.toLowerCase().replace(/s$/, '')}`;
                newBtn.innerHTML = '<span class="material-symbols-outlined">add</span>';
                newBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (group.type === 'module') {
                        // Module group shows a rich dropdown: New Module + Import Module
                        const rect = newBtn.getBoundingClientRect();
                        this.#showAddMenu(rect.left, rect.bottom + 4, [
                            { icon: 'extension',   title: 'New Module',    desc: 'Reusable equation module (.edf)', action: 'new-module' },
                            { icon: 'upload_file', title: 'Import Module', desc: 'Import module from file',         action: 'import-module' },
                        ], (action) => {
                            if (action === 'new-module') {
                                this.#callbacks.onNewFile?.('module', 'modules/untitled.edf');
                            } else if (action === 'import-module') {
                                this.#callbacks.onImportModule?.();
                            }
                        });
                    } else {
                        const suggestedPath = group.dir
                            ? `${group.dir}/untitled${group.ext}`
                            : `untitled${group.ext}`;
                        this.#callbacks.onNewFile?.(group.type, suggestedPath);
                    }
                });
                header.appendChild(newBtn);

                // Context menu on category header
                header.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.#showCategoryContextMenu(e.clientX, e.clientY, group);
                });
            }

            const content = categoryEl.querySelector('.collapsible-content');

            if (group.type === 'namespace') {
                // Namespace files — must keep at least one
                for (const f of groupFiles) {
                    const fileName = f.path.split('/').pop();
                    const label = fileName.replace(/\.[^.]+$/, '');
                    const item = this.#createFileItem({
                        path: f.path,
                        label,
                        icon: 'dataset',
                        isActive: this.#activeFile === f.path,
                        isOpen: openPaths.has(f.path),
                        canDelete: groupFiles.length > 1,
                        canRename: true,
                        canDuplicate: true,
                    });
                    content.appendChild(item);
                }
            } else if (group.type === 'module') {
                // ── Modules: split into Built-in (readonly) and Project sub-sections ──

                // Built-in sub-category
                if (this.#builtinModules.length > 0) {
                    const builtinCat = createTreeCategory({
                        id: 'module-builtin',
                        label: 'Built-in',
                        icon: 'apps',
                        count: this.#builtinModules.length,
                        expanded: !this.#collapsedCategories.has('module-builtin'),
                    });
                    const builtinContent = builtinCat.querySelector('.collapsible-content');
                    for (const bm of this.#builtinModules) {
                        const virtualPath = `builtin://${bm.filename}`;
                        const item = this.#createFileItem({
                            path: virtualPath,
                            label: bm.name,
                            icon: 'lock',
                            isActive: this.#activeFile === virtualPath,
                            isOpen: openPaths.has(virtualPath),
                            canDelete: false,
                            canRename: false,
                            canDuplicate: false,
                        });
                        // Override click to use builtin module callback
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.#callbacks.onOpenBuiltinModule?.(bm);
                        });
                        builtinContent.appendChild(item);
                    }
                    content.appendChild(builtinCat);
                }

                // Project sub-category (editable .edf files)
                if (groupFiles.length > 0) {
                    const projectCat = createTreeCategory({
                        id: 'module-project',
                        label: 'Project',
                        icon: 'folder_open',
                        count: groupFiles.length,
                        expanded: !this.#collapsedCategories.has('module-project'),
                    });
                    const projectContent = projectCat.querySelector('.collapsible-content');
                    for (const f of groupFiles) {
                        const fileName = f.path.split('/').pop();
                        const label = fileName.replace(/\.[^.]+$/, '');
                        const item = this.#createFileItem({
                            path: f.path,
                            label,
                            icon: 'extension',
                            isActive: this.#activeFile === f.path,
                            isOpen: openPaths.has(f.path),
                            canDelete: true,
                            canRename: true,
                            canDuplicate: true,
                        });
                        projectContent.appendChild(item);
                    }
                    content.appendChild(projectCat);
                }
            } else {
                for (const f of groupFiles) {
                    const fileName = f.path.split('/').pop();
                    const label = fileName.replace(/\.[^.]+$/, '');
                    const item = this.#createFileItem({
                        path: f.path,
                        label,
                        icon: group.icon,
                        isActive: this.#activeFile === f.path,
                        isOpen: openPaths.has(f.path),
                        canDelete: true,
                        canRename: true,
                        canDuplicate: true,
                    });
                    content.appendChild(item);
                }
            }

            treeEl.appendChild(categoryEl);
        }
    }

    /**
     * Create a file item using createTreeItem, adding action buttons for rename/delete
     * and a right-click context menu.
     */
    #createFileItem({ path, label, icon, isActive, isOpen, canDelete, canRename, canDuplicate }) {
        const badge = this.#fileBadges.get(path) ?? null;
        const item = createTreeItem({
            id: path,
            label,
            icon,
            selected: isActive,
            badge,
        });

        if (isOpen) item.classList.add('open');

        // Add hover action buttons (rename / delete)
        if (canRename || canDelete) {
            const actionsEl = document.createElement('span');
            actionsEl.className = 'tree-item__actions';

            if (canRename) {
                const renameBtn = document.createElement('button');
                renameBtn.className = 'tree-node__action-btn';
                renameBtn.title = 'Rename';
                renameBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
                renameBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#startInlineRename(item, path);
                });
                actionsEl.appendChild(renameBtn);
            }

            if (canDelete) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'tree-node__action-btn';
                deleteBtn.title = 'Delete';
                deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#callbacks.onDeleteFile?.(path);
                });
                actionsEl.appendChild(deleteBtn);
            }

            item.appendChild(actionsEl);
        }

        // Context menu on right-click
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.#showFileContextMenu(e.clientX, e.clientY, path, { canRename, canDelete, canDuplicate });
        });

        return item;
    }

    #renderOutline() {
        const outlineEl = this.#container.querySelector('.file-nav-outline');
        if (!outlineEl) return;

        if (!this.#outlineSymbols.length) {
            outlineEl.innerHTML = '<div class="file-nav-outline-empty">No symbols \u2014 open or create a namespace file.</div>';
            return;
        }

        const ICON_MAP = {
            namespace: 'folder',
            stock:     'account_balance',
            flow:      'trending_up',
            variable:  'calculate',
            parameter: 'tune',
            module:    'extension',
            function:  'function',
        };

        // Group symbols by file
        const byFile = new Map();
        for (const sym of this.#outlineSymbols) {
            const key = sym.fileName ?? '__unknown__';
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key).push(sym);
        }

        outlineEl.innerHTML = '';

        for (const [filePath, symbols] of byFile) {
            // File group header — strip directory and extension for display
            const displayName = filePath === '__unknown__' ? 'Unknown'
                : filePath.split('/').pop().replace(/\.\w+$/, '');

            // Skip rendering namespace-kind symbols as separate items when
            // they match the file-level header (avoids duplication).
            const filtered = symbols.filter(s => !(s.kind === 'namespace' && s.line === 0));

            const header = document.createElement('div');
            header.className = 'file-nav-outline__file-group';
            header.innerHTML = `
                <div class="file-nav-outline__file-header">
                    <span class="material-symbols-outlined file-nav-outline__file-icon">description</span>
                    <span class="file-nav-outline__file-name">${this.#escHtml(displayName)}</span>
                    <span class="file-nav-outline__file-count">${filtered.length}</span>
                </div>
            `;
            outlineEl.appendChild(header);

            for (const sym of filtered) {
                const item = createTreeItem({
                    id: `${filePath}::${sym.name}`,
                    label: sym.name,
                    icon: ICON_MAP[sym.kind] ?? 'circle',
                    subtitle: sym.namespace || null,
                });
                item.addEventListener('click', () => {
                    this.eventBus?.emit('notebook:outline:jump', sym);
                });
                header.appendChild(item);
            }
        }
    }

    // ─── Git Panel ────────────────────────────────────────────────────────────

    #ensureGitPanel() {
        const gitEl = this.#container?.querySelector('.file-nav-git');
        if (!gitEl) return;

        if (!this.#gitPanel) {
            this.#gitPanel = new GitPanel();
            this.#gitPanel.mount({
                container: gitEl,
                project: this.#project,
                onOpenDiff: (filePath, status, ref) => {
                    this.#callbacks.onOpenDiff?.(filePath, status, ref);
                },
                onBadgeUpdate: (count) => {
                    this.#updateGitBadge(count);
                },
            });

            // Install overlay scrollbar
            const gitPanel = this.#container.querySelector('.sidebar-panel--git');
            if (gitPanel) {
                this.#gitScrollbar = installOverlayScrollbar(gitPanel, {
                    orientation: 'vertical',
                    watchSubtree: true,
                });
            }
        } else {
            this.#gitPanel.startPolling();
        }
    }

    #updateGitBadge(count) {
        const btn = this.#container?.querySelector('[data-panel="git"]');
        if (!btn) return;

        let badge = btn.querySelector('.git-change-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'git-change-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count > 99 ? '99+' : count;
        } else if (badge) {
            badge.remove();
        }
    }

    // ─── Inline rename ─────────────────────────────────────────────────────────

    #startInlineRename(itemEl, filePath) {
        if (this.#isInlineRenaming) return;

        const labelEl = itemEl.querySelector('.tree-item__label');
        if (!labelEl) return;

        this.#isInlineRenaming = true;

        const oldName = filePath.split('/').pop().replace(/\.[^.]+$/, '');
        const ext = filePath.split('.').pop();

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tree-inline-rename-input';
        input.value = oldName;
        input.style.cssText = `
            font: inherit;
            font-size: 12px;
            background: var(--bg-secondary, #1e1e1e);
            border: 1px solid var(--accent, #3b82f6);
            border-radius: 2px;
            color: var(--text-primary, #fff);
            padding: 1px 4px;
            margin: -2px 0;
            width: calc(100% - 8px);
            min-width: 60px;
            outline: none;
        `;

        labelEl.style.display = 'none';
        labelEl.parentElement.insertBefore(input, labelEl.nextSibling);

        input.focus();
        input.select();

        let committed = false;

        const cleanup = () => {
            this.#isInlineRenaming = false;
            if (input.parentNode) input.remove();
            labelEl.style.display = '';
        };

        const commit = async () => {
            if (committed) return;
            committed = true;

            const newName = input.value.trim();

            if (!newName || newName === oldName) {
                cleanup();
                return;
            }

            // Module files require stricter naming: [a-zA-Z][a-zA-Z0-9_]*
            const namePattern = ext === 'edf' ? /^[a-zA-Z][a-zA-Z0-9_]*$/ : /^[\w][\w.-]*$/;
            if (!namePattern.test(newName)) {
                cleanup();
                return;
            }

            cleanup();
            this.#callbacks.onRenameFile?.(filePath, `${newName}.${ext}`);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
            e.stopPropagation();
        });

        input.addEventListener('blur', () => commit());
    }

    // ─── Context menus ───────────────────────────────────────────────────────

    #showFileContextMenu(x, y, filePath, { canRename, canDelete, canDuplicate }) {
        this.#hideContextMenu();

        const items = [
            { label: 'Open',               icon: 'open_in_new',   action: 'open' },
            { separator: true },
            { label: 'Rename',             icon: 'edit',          action: 'rename',    disabled: !canRename },
            { label: 'Duplicate',          icon: 'content_copy',  action: 'duplicate', disabled: !canDuplicate },
            { label: 'Delete',             icon: 'delete',        action: 'delete',    disabled: !canDelete, danger: true },
            { separator: true },
            { label: 'Reveal in Explorer', icon: 'folder_open',   action: 'reveal' },
        ];

        this.#showContextMenu(x, y, items, (action) => {
            switch (action) {
                case 'open':      this.#callbacks.onOpenFile?.(filePath); break;
                case 'rename': {
                    const treeEl = this.#container.querySelector('.file-nav-tree');
                    const item = treeEl?.querySelector(`.tree-item[data-item-id="${CSS.escape(filePath)}"]`);
                    if (item) this.#startInlineRename(item, filePath);
                    break;
                }
                case 'duplicate': this.#callbacks.onDuplicateFile?.(filePath); break;
                case 'delete':    this.#callbacks.onDeleteFile?.(filePath); break;
                case 'reveal':    this.#callbacks.onRevealInExplorer?.(filePath); break;
            }
        });
    }

    #showCategoryContextMenu(x, y, group) {
        this.#hideContextMenu();

        if (group.type === 'module') {
            // Module group shows New Module + Import Module
            this.#showContextMenu(x, y, [
                { label: 'New Module',    icon: 'extension',   action: 'new-module' },
                { label: 'Import Module', icon: 'upload_file', action: 'import-module' },
            ], (action) => {
                if (action === 'new-module') {
                    this.#callbacks.onNewFile?.('module', 'modules/untitled.edf');
                } else if (action === 'import-module') {
                    this.#callbacks.onImportModule?.();
                }
            });
            return;
        }

        const label = `New ${group.label.toLowerCase().replace(/s$/, '')}`;
        const items = [
            { label, icon: 'add', action: 'new' },
        ];

        this.#showContextMenu(x, y, items, () => {
            const suggestedPath = group.dir
                ? `${group.dir}/untitled${group.ext}`
                : `untitled${group.ext}`;
            this.#callbacks.onNewFile?.(group.type, suggestedPath);
        });
    }

    #showContextMenu(x, y, items, onAction) {
        const menu = document.createElement('div');
        menu.className = 'nb-context-menu';

        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'nb-context-menu__separator';
                menu.appendChild(sep);
                continue;
            }

            const btn = document.createElement('button');
            let cls = 'nb-context-menu__item';
            if (item.danger) cls += ' nb-context-menu__item--danger';
            if (item.disabled) cls += ' nb-context-menu__item--disabled';
            btn.className = cls;
            btn.innerHTML = `<span class="material-symbols-outlined">${item.icon}</span>${this.#escHtml(item.label)}`;

            if (!item.disabled) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#hideContextMenu();
                    onAction(item.action);
                });
            }
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        this.#contextMenuEl = menu;

        // Position with viewport clamping
        const rect = menu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 8);
        const top = Math.min(y, window.innerHeight - rect.height - 8);
        menu.style.left = `${Math.max(0, left)}px`;
        menu.style.top = `${Math.max(0, top)}px`;

        requestAnimationFrame(() => menu.classList.add('visible'));

        setTimeout(() => {
            document.addEventListener('click', this.#boundHideContextMenu, true);
            document.addEventListener('contextmenu', this.#boundHideContextMenu, true);
        }, 0);
        document.addEventListener('keydown', this.#onKeyDown);
    }

    #hideContextMenu() {
        if (!this.#contextMenuEl) return;
        this.#contextMenuEl.remove();
        this.#contextMenuEl = null;
        document.removeEventListener('click', this.#boundHideContextMenu, true);
        document.removeEventListener('contextmenu', this.#boundHideContextMenu, true);
        document.removeEventListener('keydown', this.#onKeyDown);
    }

    #onKeyDown = (e) => {
        if (e.key === 'Escape') this.#hideContextMenu();
    };

    // ─── Rich add-menu (ETL-style dropdown) ──────────────────────────────────

    /**
     * Show a rich dropdown menu with icon + title + description per option.
     * Reuses .fn-add-menu / .fn-add-option CSS from the ETL/functions page.
     */
    #showAddMenu(x, y, items, onAction) {
        this.#hideContextMenu();

        const menu = document.createElement('div');
        menu.className = 'fn-add-menu';
        menu.setAttribute('role', 'menu');

        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'fn-add-menu__separator';
                menu.appendChild(sep);
                continue;
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fn-add-option';
            btn.innerHTML = `
                <span class="material-symbols-outlined">${item.icon}</span>
                <div class="option-text">
                    <span class="option-title">${this.#escHtml(item.title)}</span>
                    <span class="option-desc">${this.#escHtml(item.desc)}</span>
                </div>`;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#hideContextMenu();
                onAction(item.action);
            });
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        this.#contextMenuEl = menu;

        // Position with viewport clamping
        const rect = menu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 8);
        const top = Math.min(y, window.innerHeight - rect.height - 8);
        menu.style.left = `${Math.max(0, left)}px`;
        menu.style.top = `${Math.max(0, top)}px`;

        requestAnimationFrame(() => menu.classList.add('visible'));

        setTimeout(() => {
            document.addEventListener('click', this.#boundHideContextMenu, true);
            document.addEventListener('contextmenu', this.#boundHideContextMenu, true);
        }, 0);
        document.addEventListener('keydown', this.#onKeyDown);
    }

    #escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ─── Event subscriptions ──────────────────────────────────────────────────

    #subscribeEvents() {
        const handlers = [
            [ProjectModel.EVENTS.OPENED,        () => this.#renderFileTree()],
            [ProjectModel.EVENTS.CLOSED,        () => { this.#activeFile = null; this.#renderFileTree(); }],
            [ProjectModel.EVENTS.FILES_CHANGED, () => this.#renderFileTree()],
            [ProjectModel.EVENTS.FILE_OPENED,   () => this.#renderFileTree()],
            [ProjectModel.EVENTS.FILE_CLOSED,   ({ filePath }) => {
                if (this.#activeFile === filePath) {
                    // Pick the project model's current active file, or null
                    this.#activeFile = this.#project?.activeFilePath ?? null;
                }
                this.#renderFileTree();
            }],
        ];

        for (const [event, handler] of handlers) {
            const handle = this.eventBus?.on(event, handler);
            if (handle) this.#disposers.push(() => handle.dispose?.());
        }
    }
}
