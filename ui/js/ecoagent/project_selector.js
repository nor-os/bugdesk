/**
 * project_selector.js — full-screen overlay shown when no project is
 * loaded, plus a topbar widget for switching once one is active.
 *
 * Slice 1: project = any directory on disk. The user picks one via a
 * native folder dialog, or creates a new one under `~/Documents/EcoAgent/<name>`.
 * Recently-opened projects live in the user-profile settings; we
 * surface them as a click list.
 *
 * On successful open/create we hard-reload the page so every mode
 * re-initialises against the new project. Slice 2 will hot-swap.
 */

import { openForm } from './ui/modal.js';

export async function installProjectSelector({ eventBus, logger } = {}) {
    const log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
    const current = await window.pywebview?.api?.project_current?.();

    if (current) {
        // The bar-left chip is the sole project-identity surface;
        // clicking it opens a popover anchored to the chip with the
        // project header (name + path) and the actions that operate
        // on the currently-loaded project (Reveal / Copy / Close).
        // The File menu deals only with switching projects.
        _setProjectChip(current);
        _wireProjectChipClick(current);
        return current;
    }
    try {
        await showSelectorOverlay({ eventBus, logger });
    } catch (err) {
        // Boot-blocker: surface in console (the logger may not have
        // a UI yet at this point in the boot sequence).
        console.error('[project_selector] showSelectorOverlay threw', err);
    }
    return null;
}


/** Render (or clear) the bar-left chip. The CSS :empty rule on the
 *  chip collapses it down to nothing when no project is open. */
function _setProjectChip(current) {
    const el = document.getElementById('project-chip');
    if (!el) return;
    if (!current || !current.name) {
        // TicketDesk: the stub bridge answers project calls with an empty
        // shape — a nameless project must collapse the chip, not render
        // the string "undefined".
        el.innerHTML = '';
        return;
    }
    el.dataset.path = current.path || '';
    el.title = current.path
        ? `${current.name} — ${current.path}\nClick for project actions`
        : `${current.name}\nClick for project actions`;
    el.innerHTML = `
        <span class="material-symbols-outlined project-chip__icon">folder</span>
        <span class="project-chip__name">${esc(current.name)}</span>
    `;
}

/** Bind the chip click to a toggleable popover. Idempotent — guarded
 *  by `data-wired` so multiple project loads don't stack listeners. */
function _wireProjectChipClick(current) {
    const chip = document.getElementById('project-chip');
    if (!chip || chip.dataset.wired === '1') return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.getElementById('ea-project-popover')) {
            _closeProjectPopover();
            return;
        }
        // Read the latest current-project from the chip's own
        // attributes — keeps the popover honest after a project
        // switch (the chip is re-rendered, this closure stays).
        const path = chip.dataset.path || (current?.path || '');
        const name = chip.querySelector('.project-chip__name')?.textContent
                  || (current?.name || '');
        _openProjectPopover({ chip, name, path });
    });
}

/** Mount a small popover above the chip with the project header +
 *  Reveal / Copy / Close actions. Pattern mirrors model_status's
 *  issue popover (same positioning + dismissal contract). */
function _openProjectPopover({ chip, name, path }) {
    _closeProjectPopover();
    const pop = document.createElement('div');
    pop.id = 'ea-project-popover';
    pop.className = 'ea-project-popover';
    pop.innerHTML = `
        <header class="ea-project-popover__head">
            <span class="material-symbols-outlined ea-project-popover__icon">folder</span>
            <span class="ea-project-popover__text">
                <span class="ea-project-popover__name">${esc(name || '(unknown)')}</span>
                ${path
                    ? `<span class="ea-project-popover__path" title="${esc(path)}">${esc(path)}</span>`
                    : ''}
            </span>
        </header>
        <div class="ea-project-popover__actions">
            <button type="button" class="menu-entry" data-action="reveal">
                <span class="material-symbols-outlined">folder_open</span>
                Reveal folder
            </button>
            <button type="button" class="menu-entry" data-action="copy">
                <span class="material-symbols-outlined">content_copy</span>
                Copy path
            </button>
            <button type="button" class="menu-entry" data-action="close">
                <span class="material-symbols-outlined">logout</span>
                Close project
            </button>
        </div>
    `;
    document.body.appendChild(pop);

    // Anchor above the chip — the chip is in the bottom bar, so opening
    // *upward* avoids going off-screen. Position after first paint so
    // we have the popover's real dimensions. Mirrors model_status's
    // `_openPopover` placement logic.
    const place = () => {
        if (!pop.isConnected) return;
        const a = chip.getBoundingClientRect();
        const r = pop.getBoundingClientRect();
        const gap = 8;
        let top = a.top - r.height - gap;
        if (top < 8) top = a.bottom + gap;       // flip if no room above
        let left = a.left;
        const vw = window.innerWidth;
        left = Math.max(8, Math.min(left, vw - r.width - 8));
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top  = `${Math.round(top)}px`;
    };
    requestAnimationFrame(() => requestAnimationFrame(place));

    // Action handlers — Reveal/Copy go through the same bridge calls
    // the deleted menu-file-* handlers used; Close calls the existing
    // closeCurrentProject helper exported by this module.
    pop.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        _closeProjectPopover();
        if (action === 'reveal') {
            if (!path) return;
            try {
                const res = await window.pywebview?.api?.path_reveal?.(path);
                if (res && res.ok === false) console.warn('reveal failed', res.error);
            } catch (err) { console.warn('path_reveal threw', err); }
        } else if (action === 'copy') {
            if (!path) return;
            try {
                await navigator.clipboard?.writeText?.(path);
                window.__ecoagent?.eventBus?.emit?.('notification:show', {
                    title: 'Path copied', message: path, severity: 'info',
                });
            } catch (err) { console.warn('clipboard write failed', err); }
        } else if (action === 'close') {
            await closeCurrentProject();
        }
    });

    // Dismissal: outside click + Escape + resize/relayout.
    const onDocDown = (e) => {
        if (pop.contains(e.target) || chip.contains(e.target)) return;
        _closeProjectPopover();
    };
    const onKey = (e) => { if (e.key === 'Escape') _closeProjectPopover(); };
    const onResize = () => place();
    // Defer the document listener so the click that opened the popover
    // doesn't immediately close it.
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    pop.__cleanup = () => {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
    };
}

function _closeProjectPopover() {
    const pop = document.getElementById('ea-project-popover');
    if (!pop) return;
    try { pop.__cleanup?.(); } catch { /* ignore */ }
    pop.remove();
}


/* ----------------------------------------------------- overlay screen */

async function showSelectorOverlay({ eventBus, logger } = {}) {
    const [recents, defaultRoot, templates] = await Promise.all([
        window.pywebview?.api?.projects_recent?.()      ?? [],
        window.pywebview?.api?.projects_default_root?.() ?? '~/Documents/EcoAgent',
        window.pywebview?.api?.templates_list?.()        ?? [],
    ]);

    const root = document.createElement('div');
    root.className = 'ea-project-overlay';
    root.innerHTML = `
        <div class="ea-home">
            <header class="ea-home__hero">
                <div class="ea-home__logo">
                    <span class="material-symbols-outlined">account_balance</span>
                </div>
                <h1 class="ea-home__title">EcoAgent</h1>
                <p class="ea-home__tagline">
                    Agent-based, stock-flow-consistent economic simulation.
                </p>
            </header>

            <div class="ea-home__actions">
                <button class="ea-btn ea-btn--primary" data-action="open">
                    <span class="material-symbols-outlined">folder_open</span>
                    Open project…
                </button>
                <button class="ea-btn" data-action="new">
                    <span class="material-symbols-outlined">create_new_folder</span>
                    New project…
                </button>
            </div>

            ${templates.length === 0 ? '' : `
                <section class="ea-home__section">
                    <h2 class="ea-home__label">Start from a template</h2>
                    <div class="ea-home__templates">
                        ${templates.map(templateCardHtml).join('')}
                    </div>
                </section>
            `}

            <section class="ea-home__section ea-home__recents">
                <h2 class="ea-home__label">Recent projects</h2>
                <div class="ea-home__recents-body">${recentsHtml(recents, defaultRoot)}</div>
            </section>
        </div>
    `;
    document.body.appendChild(root);

    // One delegated handler — survives the recents list being re-rendered.
    root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || !root.contains(btn)) return;
        const path = btn.closest('[data-path]')?.dataset.path;
        switch (btn.dataset.action) {
            case 'open':        return onOpenFolder();
            case 'new':         return onNewProject(defaultRoot);
            case 'template':    return onNewProject(defaultRoot, btn.dataset.template);
            case 'open-recent': if (path) openProjectByPath(path); return;
            case 'forget':
                e.stopPropagation();
                if (!path) return;
                await window.pywebview?.api?.project_forget?.(path);
                return refreshRecents(root, defaultRoot);
        }
    });
}


/** Markup for one template card. */
function templateCardHtml(t) {
    return `
        <button class="ea-home__template" data-action="template" data-template="${esc(t.name)}">
            <span class="material-symbols-outlined ea-home__template-icon">${templateIcon(t.name)}</span>
            <span class="ea-home__template-label">${esc(t.label || t.name)}</span>
            <span class="ea-home__template-desc">${esc(t.description || '')}</span>
        </button>
    `;
}

const TEMPLATE_ICONS = { blank: 'draft', 'capitalist-worker': 'groups' };
function templateIcon(name) {
    return TEMPLATE_ICONS[name] || 'category';
}

/** Markup for the recents list (or its empty state). */
function recentsHtml(recents, defaultRoot) {
    if (recents.length === 0) {
        return `<p class="ea-project-overlay__empty">No recent projects yet. New projects
                default to <code>${esc(defaultRoot)}/&lt;name&gt;</code>.</p>`;
    }
    return `<ul class="ea-project-overlay__list">
        ${recents.map((r) => `
            <li class="ea-project-overlay__item" data-path="${esc(r.path)}">
                <button class="ea-project-overlay__row" data-action="open-recent">
                    <span class="ea-project-overlay__name">${esc(r.name)}</span>
                    <span class="ea-project-overlay__path">${esc(r.path)}</span>
                </button>
                <button class="tree-node__action-btn" data-action="forget"
                        title="Remove from recents">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </li>
        `).join('')}
    </ul>`;
}


async function refreshRecents(root, defaultRoot) {
    const recents = await window.pywebview?.api?.projects_recent?.() ?? [];
    const body = root.querySelector('.ea-home__recents-body');
    if (body) body.innerHTML = recentsHtml(recents, defaultRoot);
}


/** Open the native folder picker (with a path-input fallback) and open
 *  the chosen project. Exported so the File menu can trigger the same
 *  flow the home-screen overlay uses. */
export async function openProjectFromFolderPicker() {
    const path = await window.pywebview?.api?.pick_folder?.('Open project');
    if (!path) {
        // Fallback for non-pywebview hosts.
        const data = await openForm({
            title: 'Open project',
            fields: [
                { name: 'path', label: 'Project path', type: 'text', required: true,
                  placeholder: '/absolute/path/to/project' },
            ],
            submitLabel: 'Open',
        });
        if (!data?.path) return;
        return openProjectByPath(String(data.path).trim());
    }
    return openProjectByPath(path);
}
const onOpenFolder = openProjectFromFolderPicker;

/** Open a project directory by absolute path (used by recents and the
 *  folder picker). Reloads the page on success. */
export async function openProjectByPath(path) {
    const res = await window.pywebview?.api?.project_open?.(path);
    if (res?.ok === false) {
        // Surface the error and keep the overlay up.
        alert(res.error || 'Failed to open project.');
        return;
    }
    window.location.reload();
}

/** Resolve the default parent directory for new projects (cached lookup). */
export async function getDefaultProjectRoot() {
    return await window.pywebview?.api?.projects_default_root?.()
        ?? '~/Documents/EcoAgent';
}

/** Prompt for a new project + create it. Reloads on success. */
export async function newProjectDialog(presetTemplate = null) {
    const defaultRoot = await getDefaultProjectRoot();
    return onNewProject(defaultRoot, presetTemplate);
}

/** Close the currently-open project and return to the selector overlay. */
export async function closeCurrentProject() {
    await window.pywebview?.api?.project_close?.();
    window.location.reload();
}

async function onNewProject(defaultRoot, presetTemplate = null) {
    const templates = await window.pywebview?.api?.templates_list?.() ?? [];
    // Default is the full `mosler` starter (#89). Promote it to the top
    // of the list; everything else follows in registration order.
    const ordered = [...templates].sort((a, b) => {
        if (a.name === 'mosler') return -1;
        if (b.name === 'mosler') return 1;
        return 0;
    });
    const templateOptions = ordered.map((t) => ({
        value: t.name,
        label: t.label || t.name,
    }));
    const data = await openForm({
        title: 'New project',
        fields: [
            { name: 'name', label: 'Project name', type: 'text', required: true,
              placeholder: 'e.g. baseline' },
            { name: 'path', label: 'Parent directory', type: 'text',
              default: defaultRoot,
              placeholder: defaultRoot },
            { name: 'template', label: 'Template', type: 'select',
              options: templateOptions,
              default: presetTemplate ?? (templateOptions[0]?.value || 'mosler') },
        ],
        submitLabel: 'Create',
    });
    if (!data) return;
    const name = String(data.name).trim();
    if (!name) return;
    const parent = String(data.path || defaultRoot).trim() || defaultRoot;
    const full = `${parent.replace(/[/\\]$/, '')}/${name}`;
    const template = String(data.template || '').trim() || null;
    const res = await window.pywebview?.api?.project_create?.(full, template);
    if (res?.ok === false) {
        alert(res.error || 'Failed to create project.');
        return;
    }
    window.location.reload();
}


function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
