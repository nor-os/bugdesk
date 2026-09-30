/**
 * project_switcher.js — which project this window is on, and changing it.
 *
 *   +------------------------------------------------------+
 *   | (folder)  bugd|                                       |
 *   +------------------------------------------------------+
 *   | bugdesk    C:\repos\bugdesk\bugs · …\backlog  current |
 *   | tables     C:\repos\tables\backlog       backlog only |
 *   | + Add project "bugd"…                                |
 *   +------------------------------------------------------+
 *   | projects.toml: C:\repos\bugdesk\projects.toml   Enter |
 *   +------------------------------------------------------+
 *
 * Opened from the project chip in the bottom bar. Type to narrow, the first
 * match is already selected, Enter goes there. The same list adds a project
 * (the last row, or Enter when nothing matches — the typed text becomes its
 * name) and removes one (the bin on a row, or Shift+Delete). Both only edit
 * projects.toml; removing a project never touches its folders.
 *
 * Switching LOADS the other project's page rather than swapping stores under
 * the open one. Every tile, filter and saved layout belongs to the project it
 * was made in, and a page that had quietly changed stores underneath them
 * would show one project's records in another's tabs. Each project is its own
 * address (/p/<name>/), so a switch is a navigation, the back button returns,
 * and two tabs can sit on two projects.
 *
 * Styled as the Ctrl+K palette (it reuses its classes): one keyboard model for
 * "type, arrow, Enter" wherever BugDesk offers it.
 */

const ROOT_ID = 'twm-projects';

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const currentName = () => (window.__BUGDESK_CONFIG__ || {}).store?.name || '';

/** Fetch the list fresh each time: projects.toml is edited by hand, and a
 *  switcher showing the list as it was at page load would hide the edit. */
async function fetchProjects() {
    const res = await fetch('api/projects', { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    return j;
}

/** "bugs + backlog", "backlog only" — which pages the project has. */
function describe(p) {
    if (p.hasBugs && p.hasBacklog) return 'bugs + backlog';
    return p.hasBugs ? 'bugs only' : 'backlog only';
}

/** Ctrl+P: open the switcher, or close it when it is already open. */
export function toggleProjectSwitcher({ eventBus } = {}) {
    const open = document.getElementById(ROOT_ID);
    if (open) { open.remove(); return; }
    openProjectSwitcher({ eventBus });
}

export function openProjectSwitcher({ eventBus, select = null } = {}) {
    if (document.getElementById(ROOT_ID)) return;

    let data = null;       // the last /api/projects answer
    let rows = [];         // what is on screen: projects, then the add row
    let active = 0;

    const overlay = document.createElement('div');
    overlay.id = ROOT_ID;
    overlay.className = 'twm-cmdpal-overlay';
    overlay.innerHTML = `
        <div class="twm-cmdpal twm-projects" role="dialog" aria-label="Switch project">
            <div class="twm-cmdpal__inputrow">
                <span class="material-symbols-outlined twm-cmdpal__glyph">folder_open</span>
                <input type="text" class="twm-cmdpal__input" autocomplete="off" spellcheck="false"
                       placeholder="Switch project — type to filter, Enter to open" />
            </div>
            <div class="twm-cmdpal__list" data-role="list" role="listbox"></div>
            <div class="twm-cmdpal__footer">
                <span data-role="status" class="twm-projects__file"></span>
                <span class="twm-cmdpal__keys">
                    <span><kbd>Enter</kbd> open</span>
                    <span><kbd>Shift</kbd><kbd>Del</kbd> remove</span>
                    <span><kbd>Esc</kbd> close</span>
                </span>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.twm-cmdpal__input');
    const list = overlay.querySelector('[data-role="list"]');
    const status = overlay.querySelector('[data-role="status"]');

    const close = () => overlay.remove();

    const render = () => {
        const q = input.value.trim().toLowerCase();
        const projects = (data?.projects || []).filter((p) => !q
            || p.name.toLowerCase().includes(q)
            || String(p.bugs || '').toLowerCase().includes(q)
            || String(p.backlog || '').toLowerCase().includes(q));
        // Name matches before path matches: "tab" should find the project
        // called tables before one whose path merely passes through a folder
        // called tab-something.
        projects.sort((a, b) => Number(!a.name.toLowerCase().includes(q)) - Number(!b.name.toLowerCase().includes(q)));
        rows = [...projects.map((p) => ({ kind: 'project', project: p })), { kind: 'add', name: input.value.trim() }];
        active = Math.min(active, rows.length - 1);

        list.innerHTML = rows.map((r, i) => {
            if (r.kind === 'add') {
                return `<div class="twm-cmdpal__item" data-idx="${i}" role="option">
                    <span class="material-symbols-outlined twm-cmdpal__icon">add</span>
                    <span class="twm-cmdpal__main">
                        <span class="twm-cmdpal__title">${r.name ? `Add project “${_esc(r.name)}”…` : 'Add project…'}</span>
                        <span class="twm-cmdpal__snippet">Point BugDesk at another repo's bugs and/or backlog folder</span>
                    </span>
                </div>`;
            }
            const p = r.project;
            const here = p.name.toLowerCase() === currentName().toLowerCase();
            const paths = [p.bugs, p.backlog].filter(Boolean).join('  ·  ');
            return `<div class="twm-cmdpal__item${here ? ' twm-projects__item--current' : ''}" data-idx="${i}" role="option">
                <span class="material-symbols-outlined twm-cmdpal__icon">${here ? 'folder_open' : 'folder'}</span>
                <span class="twm-cmdpal__main">
                    <span class="twm-cmdpal__title">${_esc(p.name)}</span>
                    <span class="twm-cmdpal__snippet">${_esc(paths)}</span>
                </span>
                <span class="twm-cmdpal__meta">${here ? 'current' : _esc(describe(p))}</span>
                ${p.transient ? '' : `<button type="button" class="twm-projects__remove has-tooltip" data-remove="${i}"
                        data-tooltip="Remove from projects.toml (the folders stay)" aria-label="Remove ${_esc(p.name)}">
                    <span class="material-symbols-outlined">delete</span>
                </button>`}
            </div>`;
        }).join('');

        const err = data?.error ? `projects.toml: ${data.error} — showing the last version that read cleanly` : '';
        status.textContent = err || (data?.file ? `projects.toml: ${data.file}` : '');
        status.classList.toggle('twm-projects__file--error', !!err);
        paint();
    };

    const paint = () => {
        const els = list.querySelectorAll('[data-idx]');
        els.forEach((el, i) => el.classList.toggle('twm-cmdpal__item--active', i === active));
        els[active]?.scrollIntoView({ block: 'nearest' });
    };

    const load = async (selectName = null) => {
        try {
            data = await fetchProjects();
        } catch (err) {
            status.textContent = `Could not list projects: ${err?.message || err}`;
            return;
        }
        active = 0;
        render();
        if (selectName) {
            const i = rows.findIndex((r) => r.kind === 'project' && r.project.name === selectName);
            if (i >= 0) { active = i; paint(); }
        }
    };

    const commit = (idx) => {
        const row = rows[idx];
        if (!row) return;
        if (row.kind === 'add') { close(); addProject({ eventBus, name: row.name }); return; }
        const p = row.project;
        close();
        if (p.name.toLowerCase() === currentName().toLowerCase()) return;
        window.location.assign(p.base);
    };

    const remove = async (idx) => {
        const p = rows[idx]?.kind === 'project' ? rows[idx].project : null;
        if (!p || p.transient) return;
        const { openConfirm } = await import('../ui/components/modal.js');
        const ok = await openConfirm({
            title: 'Remove project',
            message: `Remove <b>${_esc(p.name)}</b> from projects.toml?<br><br>`
                + 'Only the entry goes. Its bugs and backlog stay on disk, and adding it back brings everything back.',
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) { input.focus(); return; }
        try {
            const res = await fetch(`api/projects/${encodeURIComponent(p.name)}`, {
                method: 'DELETE', headers: { accept: 'application/json' },
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            data = j;
            render();
            input.focus();
            eventBus?.emit?.('toast:show', { type: 'info', message: `Removed ${p.name} from projects.toml.` });
            // Removing the page you are on leaves it at an address that no
            // longer exists; the next request would redirect anyway.
            if (p.name.toLowerCase() === currentName().toLowerCase()) window.location.assign('/');
        } catch (err) {
            eventBus?.emit?.('toast:show', { type: 'error', message: `Could not remove ${p.name}: ${err?.message || err}` });
            input.focus();
        }
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { close(); return; }
        const rm = e.target.closest('[data-remove]');
        if (rm) { e.stopPropagation(); remove(Number(rm.dataset.remove)); return; }
        const row = e.target.closest('[data-idx]');
        if (row) commit(Number(row.dataset.idx));
    });
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); return; }
        if (e.key === 'Enter') { e.preventDefault(); commit(active); return; }
        if (e.key === 'Delete' && e.shiftKey) { e.preventDefault(); remove(active); }
    });

    requestAnimationFrame(() => input.focus());
    load(select);
}

/**
 * Add a project: a name and its folders. Either folder may be left empty — a
 * repo with only a backlog gets no Bugs page — but not both. Typing the bugs
 * folder fills in the backlog beside it and the name from the repo, as long as
 * those still hold what was filled in for them; anything typed by hand is left
 * alone.
 */
export async function addProject({ eventBus, name = '' } = {}) {
    const { openForm } = await import('../ui/components/modal.js');
    const sep = (p) => (p.includes('\\') ? '\\' : '/');
    const parent = (p) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
    const leaf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    const derived = { name: '', backlog: '' };

    let values = { name, bugs: '', backlog: '' };
    for (;;) {
        const result = await openForm({
            title: 'Add project',
            submitLabel: 'Add',
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true,
                  placeholder: 'e.g. tables', hint: 'Shown in the bottom bar and in the address: /p/<name>/' },
                { name: 'bugs', label: 'Bugs folder', type: 'text',
                  placeholder: 'C:\\repos\\tables\\bugs', hint: 'Leave empty for a project with only a backlog.' },
                { name: 'backlog', label: 'Backlog folder', type: 'text',
                  placeholder: 'C:\\repos\\tables\\backlog', hint: 'Leave empty for a project with only bugs.' },
            ],
            defaults: values,
            onFieldChange: (field, value, api) => {
                if (field !== 'bugs') return;
                const bugs = String(value || '').trim();
                const root = parent(bugs);
                if (!root) return;
                const backlog = String(api.get('backlog') || '').trim();
                if (!backlog || backlog === derived.backlog) {
                    derived.backlog = `${root}${sep(bugs)}backlog`;
                    api.set('backlog', derived.backlog);
                }
                const nm = String(api.get('name') || '').trim();
                if (!nm || nm === derived.name) {
                    derived.name = leaf(root);
                    api.set('name', derived.name);
                }
            },
        });
        if (!result) return null;
        values = {
            name: String(result.name || '').trim(),
            bugs: String(result.bugs || '').trim(),
            backlog: String(result.backlog || '').trim(),
        };
        try {
            const res = await fetch('api/projects', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(values),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            eventBus?.emit?.('toast:show', { type: 'success', message: `Added ${values.name} to projects.toml.` });
            // Back in the list with the new project selected: Enter goes there.
            openProjectSwitcher({ eventBus, select: values.name });
            return j;
        } catch (err) {
            // The server is what knows whether a folder exists; say what it said
            // and hand the form back as it was typed.
            eventBus?.emit?.('toast:show', { type: 'error', message: `Could not add ${values.name || 'the project'}: ${err?.message || err}` });
        }
    }
}
