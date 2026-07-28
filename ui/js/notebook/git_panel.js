/**
 * git_panel.js
 *
 * Git source control panel for the notebook sidebar.
 * Provides branch management, staging/committing, change list, and commit graph.
 */

import { showConfirmDialog } from '../ui/components/confirm_dialog.js';
import { GitGraph } from './git_graph.js';

/** Status badge letter + CSS modifier */
const STATUS_LABELS = {
    M: 'M', A: 'A', D: 'D', U: 'U', R: 'R', C: 'C',
};

/**
 * @typedef {Object} GitFile
 * @property {string} path
 * @property {string} status  - M/A/D/U/R/C
 * @property {boolean} staged
 * @property {string} [renamedFrom]
 */

export class GitPanel {

    get #api() { return window.pywebview?.api; }

    /** @type {HTMLElement} */        #container;
    /** @type {object} */             #project;       // ProjectModel
    /** @type {Function} */           #onOpenDiff;    // callback(filePath, status)
    /** @type {number|null} */        #pollTimer = null;
    /** @type {string} */             #cachedStatusJson = '';
    /** @type {boolean} */            #isRepo = false;
    /** @type {boolean} */            #busy = false;
    /** @type {string} */             #branch = '';
    /** @type {number} */             #ahead = 0;
    /** @type {number} */             #behind = 0;
    /** @type {boolean} */            #hasUpstream = false;
    /** @type {GitFile[]} */          #files = [];
    /** @type {boolean} */            #changesExpanded = true;
    /** @type {boolean} */            #graphExpanded = false;
    /** @type {GitGraph|null} */      #gitGraph = null;
    /** @type {HTMLElement|null} */   #activeMenu = null;
    /** @type {HTMLElement|null} */   #branchDropdownEl = null;
    /** @type {Function|null} */      #onBadgeUpdate = null;

    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.container
     * @param {object} opts.project - ProjectModel instance
     * @param {Function} opts.onOpenDiff - (filePath, status) => void
     * @param {Function} [opts.onBadgeUpdate] - (count) => void
     */
    mount({ container, project, onOpenDiff, onBadgeUpdate }) {
        this.#container = container;
        this.#project = project;
        this.#onOpenDiff = onOpenDiff;
        this.#onBadgeUpdate = onBadgeUpdate || null;
        this.#render();
        this.startPolling();
    }

    dispose() {
        this.stopPolling();
        this.#closeMenu();
        this.#gitGraph?.dispose();
        this.#gitGraph = null;
        this.#closeBranchDropdown();
        if (this.#container) this.#container.innerHTML = '';
    }

    startPolling() {
        if (this.#pollTimer) return;
        this.#fetchStatus();
        this.#pollTimer = setInterval(() => this.#fetchStatus(), 3000);
    }

    stopPolling() {
        if (this.#pollTimer) {
            clearInterval(this.#pollTimer);
            this.#pollTimer = null;
        }
    }

    // ─── Rendering ──────────────────────────────────────────────────────

    #render() {
        this.#container.innerHTML = `
            <div class="git-panel">
                <div class="git-panel__empty">
                    <span class="material-symbols-outlined">hourglass_empty</span>
                    Checking repository…
                </div>
            </div>
        `;
    }

    #renderFull() {
        const panel = this.#container.querySelector('.git-panel');
        if (!panel) return;

        panel.innerHTML = `
            ${this.#busy ? '<div class="git-panel__busy-bar"></div>' : ''}
            <div class="git-branch-bar">
                <button class="git-branch-bar__name" data-action="branch-dropdown">
                    <span class="material-symbols-outlined">commit</span>
                    <span class="git-branch-bar__name-label">${this.#esc(this.#branch)}</span>
                </button>
                ${this.#renderBadges()}
                <div class="git-branch-bar__actions">
                    <button class="git-branch-bar__btn${this.#busy ? ' git-branch-bar__btn--busy' : ''}"
                            data-action="fetch" title="Fetch">
                        <span class="material-symbols-outlined">sync</span>
                    </button>
                    <button class="git-branch-bar__btn${this.#busy ? ' git-branch-bar__btn--busy' : ''}"
                            data-action="pull" title="Pull">
                        <span class="material-symbols-outlined">arrow_downward</span>
                    </button>
                    <button class="git-branch-bar__btn${this.#busy ? ' git-branch-bar__btn--busy' : ''}"
                            data-action="push" title="Push">
                        <span class="material-symbols-outlined">arrow_upward</span>
                    </button>
                    <button class="git-branch-bar__btn" data-action="overflow" title="More actions">
                        <span class="material-symbols-outlined">more_horiz</span>
                    </button>
                </div>
            </div>

            <div class="git-commit-area">
                <textarea class="git-commit-area__textarea" placeholder="Commit message (Ctrl+Enter to commit)"
                          rows="1"></textarea>
                <div class="git-commit-area__actions">
                    <button class="git-commit-area__commit-btn" data-action="commit">Commit</button>
                    <button class="git-commit-area__dropdown-btn" data-action="commit-dropdown">
                        <span class="material-symbols-outlined">expand_more</span>
                    </button>
                </div>
            </div>

            <div class="git-changes">
                <div class="collapsible-header" data-action="toggle-changes">
                    <span class="material-symbols-outlined collapsible-arrow${this.#changesExpanded ? '' : ' collapsible-arrow--collapsed'}">expand_more</span>
                    Changes
                    <span class="collapsible-header__count">${this.#files.length}</span>
                </div>
                <div class="git-changes__list" ${this.#changesExpanded ? '' : 'hidden'}>
                    ${this.#renderFileList()}
                </div>
            </div>

            <div class="git-graph">
                <div class="collapsible-header" data-action="toggle-graph">
                    <span class="material-symbols-outlined collapsible-arrow${this.#graphExpanded ? '' : ' collapsible-arrow--collapsed'}">expand_more</span>
                    Graph
                </div>
                <div class="git-graph__container" ${this.#graphExpanded ? '' : 'hidden'}>
                </div>
            </div>
        `;

        this.#wireEvents(panel);
        this.#wireTextareaAutoGrow(panel);
        this.#wireCommitDropdown(panel);

        if (this.#graphExpanded) this.#ensureGraph();
    }

    #renderNoProject() {
        const panel = this.#container.querySelector('.git-panel');
        if (!panel) return;
        panel.innerHTML = `
            <div class="git-panel__empty">
                <span class="material-symbols-outlined">folder_off</span>
                No project open
            </div>
        `;
    }

    #renderNotRepo() {
        const panel = this.#container.querySelector('.git-panel');
        if (!panel) return;
        panel.innerHTML = `
            <div class="git-panel__empty">
                <span class="material-symbols-outlined">source</span>
                Not a git repository
                <button class="git-panel__init-btn" data-action="init-repo">Initialize Repository</button>
            </div>
        `;
        panel.querySelector('[data-action="init-repo"]')?.addEventListener('click', () => this.#initRepo());
    }

    #renderBadges() {
        if (!this.#hasUpstream) return '';
        const parts = [];
        if (this.#ahead > 0)  parts.push(`<span class="git-branch-bar__badge">↑${this.#ahead}</span>`);
        if (this.#behind > 0) parts.push(`<span class="git-branch-bar__badge">↓${this.#behind}</span>`);
        if (parts.length === 0) return '';
        return `<div class="git-branch-bar__badges">${parts.join('')}</div>`;
    }

    #renderFileList() {
        if (this.#files.length === 0) {
            return '<div class="git-panel__empty" style="padding:8px 12px">No changes</div>';
        }
        return this.#files.map(f => `
            <div class="git-changes__file" data-action="open-diff" data-path="${this.#esc(f.path)}" data-status="${f.status}">
                <span class="git-status-badge git-status-badge--${f.status}">${STATUS_LABELS[f.status]}</span>
                <span class="git-changes__file-name" title="${this.#esc(f.path)}">${this.#esc(this.#fileName(f.path))}</span>
                <div class="git-changes__file-actions">
                    ${f.status !== 'U' && !f.staged ? `
                        <button class="git-changes__action-btn" data-action="stage" data-path="${this.#esc(f.path)}" title="Stage">
                            <span class="material-symbols-outlined">add</span>
                        </button>
                    ` : ''}
                    ${f.staged ? `
                        <button class="git-changes__action-btn" data-action="unstage" data-path="${this.#esc(f.path)}" title="Unstage">
                            <span class="material-symbols-outlined">remove</span>
                        </button>
                    ` : ''}
                    <button class="git-changes__action-btn" data-action="discard" data-path="${this.#esc(f.path)}" data-status="${f.status}" title="Discard changes">
                        <span class="material-symbols-outlined">undo</span>
                    </button>
                </div>
            </div>
        `).join('');
    }

    // ─── Event Wiring ───────────────────────────────────────────────────

    #wireEvents(panel) {
        panel.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;

            switch (action) {
                case 'branch-dropdown':
                    this.#toggleBranchDropdown();
                    break;
                case 'fetch':
                    await this.#runOp(() => this.#api.git_fetch(this.#payload()));
                    break;
                case 'pull':
                    await this.#runOp(() => this.#api.git_pull(this.#payload()));
                    break;
                case 'push':
                    await this.#runOp(() => this.#api.git_push(this.#payload()));
                    break;
                case 'overflow':
                    this.#showOverflowMenu(btn);
                    break;
                case 'commit':
                    await this.#doCommit('commit');
                    break;
                case 'toggle-changes':
                    this.#changesExpanded = !this.#changesExpanded;
                    this.#renderFull();
                    break;
                case 'toggle-graph':
                    this.#graphExpanded = !this.#graphExpanded;
                    this.#renderFull();
                    break;
                case 'open-diff':
                    this.#onOpenDiff?.(btn.dataset.path, btn.dataset.status);
                    break;
                case 'stage':
                    e.stopPropagation();
                    await this.#runOp(() => this.#api.git_stage({ ...this.#payload(), paths: [btn.dataset.path] }));
                    break;
                case 'unstage':
                    e.stopPropagation();
                    await this.#runOp(() => this.#api.git_unstage({ ...this.#payload(), paths: [btn.dataset.path] }));
                    break;
                case 'discard':
                    e.stopPropagation();
                    await this.#doDiscard(btn.dataset.path, btn.dataset.status);
                    break;
            }
        });

        // Ctrl+Enter to commit from textarea
        const textarea = panel.querySelector('.git-commit-area__textarea');
        if (textarea) {
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.#doCommit('commit');
                }
            });
        }
    }

    #wireTextareaAutoGrow(panel) {
        const textarea = panel.querySelector('.git-commit-area__textarea');
        if (!textarea) return;
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px';
        });
    }

    #wireCommitDropdown(panel) {
        const trigger = panel.querySelector('[data-action="commit-dropdown"]');
        if (!trigger) {
            return;
        }
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#showMenu(trigger, [
                { action: 'commit',     label: 'Commit',         icon: 'check' },
                { action: 'amend',      label: 'Commit (Amend)', icon: 'edit' },
                { separator: true },
                { action: 'commitPush', label: 'Commit & Push',  icon: 'arrow_upward' },
                { action: 'commitSync', label: 'Commit & Sync',  icon: 'sync' },
            ], (action) => this.#doCommit(action));
        });
    }

    // ─── Operations ─────────────────────────────────────────────────────

    async #initRepo() {
        const projectPath = this.#project?.projectPath;
        if (!this.#api || !projectPath) return;
        const result = await this.#api.git_init({ projectPath });
        if (result?.ok) {
            this.#isRepo = true;
            this.#cachedStatusJson = '';
            await this.#fetchStatus();
        } else {
            console.error('[git] init failed:', result?.error);
        }
    }

    async #fetchStatus() {
        const projectPath = this.#project?.projectPath;
        if (!this.#api) return;

        if (!projectPath) {
            this.#renderNoProject();
            this.#onBadgeUpdate?.(0);
            return;
        }

        try {
            // First check if it's a repo (re-check each poll in case user runs git init)
            if (!this.#isRepo) {
                const check = await this.#api.git_is_repo({ projectPath });
                if (!check?.ok || !check.isRepo) {
                    this.#isRepo = false;
                    this.#renderNotRepo();
                    this.#onBadgeUpdate?.(0);
                    return;
                }
                this.#isRepo = true;
            }

            const result = await this.#api.git_status({ projectPath });
            if (!result?.ok) return;

            const json = JSON.stringify(result);
            if (json === this.#cachedStatusJson) return; // no change
            this.#cachedStatusJson = json;

            this.#branch = result.branch;
            this.#ahead = result.ahead;
            this.#behind = result.behind;
            this.#hasUpstream = result.hasUpstream;
            this.#files = result.files || [];

            this.#onBadgeUpdate?.(this.#files.length);
            this.#renderFull();
        } catch (e) {
            console.error('[git] fetchStatus failed:', e);
        }
    }

    async #runOp(fn) {
        if (this.#busy) return;
        this.#busy = true;
        this.#renderFull();
        try {
            const result = await fn();
            if (result && !result.ok) {
                console.error('[git]', result.error);
                // TODO: surface error in UI (notification)
            }
        } catch (e) {
            console.error('[git] operation failed:', e);
        } finally {
            this.#busy = false;
            this.#cachedStatusJson = ''; // force re-render
            await this.#fetchStatus();
        }
    }

    async #doCommit(mode) {
        const textarea = this.#container.querySelector('.git-commit-area__textarea');
        const message = textarea?.value?.trim();

        if (!message && mode !== 'amend') {
            textarea?.focus();
            return;
        }

        const payload = this.#payload();

        await this.#runOp(async () => {
            // Stage all if nothing is staged
            const hasStaged = this.#files.some(f => f.staged);
            if (!hasStaged) {
                const stageResult = await this.#api.git_stage({ ...payload, paths: 'all' });
                if (!stageResult?.ok) return stageResult;
            }

            const commitResult = await this.#api.git_commit({
                ...payload,
                message: message || '',
                amend: mode === 'amend',
            });
            if (!commitResult?.ok) return commitResult;

            // Clear textarea on success
            if (textarea) textarea.value = '';

            if (mode === 'commitPush') {
                return await this.#api.git_push(payload);
            }
            if (mode === 'commitSync') {
                const pullResult = await this.#api.git_pull(payload);
                if (!pullResult?.ok) return pullResult;
                return await this.#api.git_push(payload);
            }
            return commitResult;
        });

        // Refresh graph if expanded
        if (this.#graphExpanded && this.#gitGraph) {
            this.#gitGraph.refresh();
        }
    }

    async #doDiscard(filePath, status) {
        const confirmed = await showConfirmDialog({
            title: 'Discard Changes',
            message: `Discard all changes to "${this.#fileName(filePath)}"?`,
            icon: 'warning',
            okLabel: 'Discard',
            okVariant: 'danger',
        });
        if (!confirmed) return;

        await this.#runOp(() => this.#api.git_discard({
            ...this.#payload(),
            filePath,
            status,
        }));
    }

    // ─── Branch Dropdown ────────────────────────────────────────────────

    async #toggleBranchDropdown() {
        if (this.#branchDropdownEl) {
            this.#closeBranchDropdown();
            return;
        }

        const result = await this.#api?.git_branches(this.#payload());
        if (!result?.ok) return;

        const branches = result.branches || [];
        const local = branches.filter(b => !b.isRemote);
        const remote = branches.filter(b => b.isRemote);

        const dd = document.createElement('div');
        dd.className = 'git-branch-dropdown';

        let html = '';
        if (local.length) {
            html += '<div class="git-branch-dropdown__section-label">Local</div>';
            for (const b of local) {
                const cls = b.isCurrent ? ' git-branch-dropdown__item--current' : '';
                html += `<button class="git-branch-dropdown__item${cls}" data-ref="${this.#esc(b.name)}">
                    <span class="material-symbols-outlined">${b.isCurrent ? 'check' : 'commit'}</span>
                    ${this.#esc(b.name)}
                </button>`;
            }
        }
        if (remote.length) {
            html += '<div class="git-branch-dropdown__separator"></div>';
            html += '<div class="git-branch-dropdown__section-label">Remote</div>';
            for (const b of remote) {
                html += `<button class="git-branch-dropdown__item" data-ref="${this.#esc(b.name)}">
                    <span class="material-symbols-outlined">cloud</span>
                    ${this.#esc(b.name)}
                </button>`;
            }
        }
        html += '<div class="git-branch-dropdown__separator"></div>';
        html += `<div class="git-branch-dropdown__input">
            <input type="text" placeholder="Create new branch…" data-action="create-branch-input" />
        </div>`;

        dd.innerHTML = html;

        // Wire clicks
        dd.addEventListener('click', async (e) => {
            const item = e.target.closest('[data-ref]');
            if (item) {
                this.#closeBranchDropdown();
                await this.#runOp(() => this.#api.git_checkout({ ...this.#payload(), ref: item.dataset.ref }));
                return;
            }
        });

        // Wire create branch input
        const input = dd.querySelector('[data-action="create-branch-input"]');
        if (input) {
            input.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    const name = input.value.trim();
                    if (!name) return;
                    this.#closeBranchDropdown();
                    await this.#runOp(() => this.#api.git_create_branch({ ...this.#payload(), name }));
                }
                if (e.key === 'Escape') {
                    this.#closeBranchDropdown();
                }
            });
        }

        // Outside click to close
        const closeHandler = (e) => {
            if (!dd.contains(e.target) && !e.target.closest('[data-action="branch-dropdown"]')) {
                this.#closeBranchDropdown();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);

        const bar = this.#container.querySelector('.git-branch-bar');
        if (bar) bar.appendChild(dd);
        this.#branchDropdownEl = dd;

        // Focus the create input
        setTimeout(() => input?.focus(), 50);
    }

    #closeBranchDropdown() {
        if (this.#branchDropdownEl) {
            this.#branchDropdownEl.remove();
            this.#branchDropdownEl = null;
        }
    }

    // ─── Overflow Menu ──────────────────────────────────────────────────

    #showOverflowMenu(trigger) {
        this.#showMenu(trigger, [
            { action: 'stash',    label: 'Stash',          icon: 'archive' },
            { action: 'stashPop', label: 'Pop Stash',      icon: 'unarchive' },
            { separator: true },
            { action: 'merge',    label: 'Merge…',         icon: 'merge' },
            { action: 'rebase',   label: 'Rebase…',        icon: 'rebase_edit' },
            { separator: true },
            { action: 'remotes',  label: 'Remotes…',       icon: 'cloud' },
            { action: 'tags',     label: 'Tags…',          icon: 'sell' },
        ], async (action) => {
            switch (action) {
                case 'stash':
                    await this.#runOp(() => this.#api.git_stash(this.#payload()));
                    break;
                case 'stashPop':
                    await this.#runOp(() => this.#api.git_stash_pop(this.#payload()));
                    break;
                case 'merge':
                    await this.#doBranchOp('merge');
                    break;
                case 'rebase':
                    await this.#doBranchOp('rebase');
                    break;
                case 'remotes':
                    await this.#showRemotesDialog();
                    break;
                case 'tags':
                    await this.#showTagsMenu();
                    break;
            }
        });
    }

    async #doBranchOp(op) {
        // Show branch picker for merge/rebase target
        const result = await this.#api?.git_branches(this.#payload());
        if (!result?.ok) return;

        const branches = (result.branches || []).filter(b => !b.isCurrent && !b.isRemote);
        if (branches.length === 0) return;

        // Simple prompt-style: use first non-current branch or ask
        const branchName = prompt(`${op === 'merge' ? 'Merge' : 'Rebase onto'} branch:`);
        if (!branchName) return;

        if (op === 'merge') {
            await this.#runOp(() => this.#api.git_merge({ ...this.#payload(), branch: branchName }));
        } else {
            await this.#runOp(() => this.#api.git_rebase({ ...this.#payload(), onto: branchName }));
        }
    }

    async #showTagsMenu() {
        const result = await this.#api?.git_tag_list(this.#payload());
        if (!result?.ok) return;

        const name = prompt('Create tag (leave empty to cancel):');
        if (!name) return;
        await this.#runOp(() => this.#api.git_tag_create({ ...this.#payload(), name }));
    }

    // ─── Remotes ─────────────────────────────────────────────────────────

    async #showRemotesDialog() {
        const result = await this.#api?.git_remote_list(this.#payload());
        if (!result?.ok) return;

        const remotes = result.remotes || [];
        const items = [];

        for (const r of remotes) {
            items.push({ label: r.name, description: r.url, icon: 'cloud', action: `remove:${r.name}`, danger: true });
        }
        if (remotes.length > 0) items.push({ separator: true });
        items.push({ label: 'Add Remote…', icon: 'add', action: 'add' });

        const bar = this.#container.querySelector('.git-branch-bar__actions') || this.#container;
        this.#showMenu(bar, items, async (action) => {
            if (action === 'add') {
                const name = prompt('Remote name (e.g. origin):');
                if (!name) return;
                const url = prompt('Remote URL:');
                if (!url) return;
                const res = await this.#api.git_remote_add({ ...this.#payload(), name, url });
                if (!res?.ok) console.error('[git] remote add failed:', res?.error);
            } else if (action.startsWith('remove:')) {
                const remoteName = action.slice(7);
                const confirmed = await showConfirmDialog({
                    title: 'Remove Remote',
                    message: `Remove remote "${remoteName}"?`,
                    icon: 'warning',
                    okLabel: 'Remove',
                    okVariant: 'danger',
                });
                if (!confirmed) return;
                const res = await this.#api.git_remote_remove({ ...this.#payload(), name: remoteName });
                if (!res?.ok) console.error('[git] remote remove failed:', res?.error);
            }
            // Force re-fetch status (upstream may have changed)
            this.#cachedStatusJson = '';
            await this.#fetchStatus();
        });
    }

    // ─── Context Menu ────────────────────────────────────────────────────

    /**
     * Show a context menu anchored to a trigger element.
     * Uses the nb-context-menu pattern for consistent EcoSim UX.
     * @param {HTMLElement} anchor
     * @param {Array<{action?: string, label?: string, icon?: string, separator?: boolean, danger?: boolean, description?: string}>} items
     * @param {Function} onAction - (action: string) => void
     * @param {'above'|'below'} [position='below']
     */
    #showMenu(anchor, items, onAction, position = 'below') {
        this.#closeMenu();

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
            btn.className = cls;

            let html = '';
            if (item.icon) html += `<span class="material-symbols-outlined">${item.icon}</span>`;
            html += `<span>${this.#esc(item.label)}</span>`;
            if (item.description) html += `<span class="nb-context-menu__shortcut">${this.#esc(item.description)}</span>`;
            btn.innerHTML = html;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#closeMenu();
                onAction(item.action);
            });
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        this.#activeMenu = menu;

        // Position relative to anchor
        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();

        let left = anchorRect.right - menuRect.width;
        let top = position === 'above'
            ? anchorRect.top - menuRect.height - 4
            : anchorRect.bottom + 4;

        // Viewport clamping
        left = Math.max(4, Math.min(left, window.innerWidth - menuRect.width - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - menuRect.height - 4));

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        requestAnimationFrame(() => menu.classList.add('visible'));

        const close = (e) => {
            if (!menu.contains(e.target)) {
                this.#closeMenu();
                document.removeEventListener('mousedown', close, true);
            }
        };
        const escClose = (e) => {
            if (e.key === 'Escape') {
                this.#closeMenu();
                document.removeEventListener('keydown', escClose, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', close, true);
            document.addEventListener('keydown', escClose, true);
        }, 0);
    }

    #closeMenu() {
        if (this.#activeMenu) {
            this.#activeMenu.remove();
            this.#activeMenu = null;
        }
    }

    // ─── Graph ──────────────────────────────────────────────────────────

    #ensureGraph() {
        const container = this.#container.querySelector('.git-graph__container');
        if (!container) return;

        if (!this.#gitGraph) {
            this.#gitGraph = new GitGraph();
        }
        this.#gitGraph.mount({
            container,
            projectPath: this.#project?.projectPath,
            onOpenDiff: this.#onOpenDiff,
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    #payload() {
        return { projectPath: this.#project?.projectPath };
    }

    #fileName(path) {
        const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts[parts.length - 1] || path;
    }

    #esc(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}
