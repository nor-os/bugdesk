/**
 * project_switcher.js — which project this window is on, and changing it, on
 * FlexDesk's workspace picker.
 *
 * The project field is centred in the top bar; a click or Ctrl+P opens the
 * switcher in its place. Type to narrow, the first match is already selected,
 * Enter goes there. The same list adds a project (the last row, or Enter when
 * nothing matches: the typed text becomes its name) and removes one (the bin on a
 * row, or Shift+Delete). Both only edit projects.toml; removing a project never
 * touches its folders.
 *
 * Switching LOADS the other project's page rather than swapping stores under
 * the open one. Every tile, filter and saved layout belongs to the project it
 * was made in, and a page that had quietly changed stores underneath them
 * would show one project's records in another's tabs. Each project is its own
 * address (/p/<name>/), so a switch is a navigation, the back button returns,
 * and two tabs can sit on two projects.
 *
 * PAGE CHROME, and only BugDesk's own page's. It is reached from install.js's
 * top bar alone, never from the content kinds, so a copy embedded in another
 * application (README, "Embedding BugDesk") never loads it — and must not: a
 * switch here navigates the whole window to another /p/<name>/. So its `api/`
 * stays relative to the page and its project is the page-wide config's.
 */

import { createWorkspacePicker, openConfirm, openForm } from '@flexdesk/widgets';

const currentName = () => (window.__BUGDESK_CONFIG__ || {}).store?.name || '';

/** Projects compare without regard to case, as the server's names do. */
const idOf = (name) => String(name).toLowerCase();

const FIELD_TOOLTIP = 'Project — click or Ctrl+P to switch, add or remove projects';

/** Read fresh on every open: projects.toml is edited by hand, and a switcher
 *  showing the list as it was at page load would hide the edit. */
async function loadProjects() {
    const res = await fetch('api/projects', { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    const status = j.error
        ? { text: `projects.toml: ${j.error} — showing the last version that read cleanly`, error: true }
        : (j.file ? `projects.toml: ${j.file}` : '');
    return { items: j.projects || [], status };
}

/** "bugs + backlog", "backlog only" — which pages the project has. */
function describeStores(p) {
    if (p.hasBugs && p.hasBacklog) return 'bugs + backlog';
    return p.hasBugs ? 'bugs only' : 'backlog only';
}

/**
 * The field, in the top bar, and the switcher it opens.
 * @param {HTMLElement} bar  the top bar
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @returns {{ showAbsent(absent: boolean): void }} `showAbsent` says "n/a" on the
 *   field while something that belongs to no project is in front.
 */
export function installProjectPicker(bar, { eventBus } = {}) {
    const removeProject = async (p) => {
        const ok = await openConfirm({
            title: 'Remove project',
            message: `Remove ${p.name} from projects.toml?\n\n`
                + 'Only the entry goes. Its bugs and backlog stay on disk, and adding it back brings everything back.',
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return false;
        const res = await fetch(`api/projects/${encodeURIComponent(p.name)}`, {
            method: 'DELETE', headers: { accept: 'application/json' },
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        eventBus?.emit?.('toast:show', { type: 'info', message: `Removed ${p.name} from projects.toml.` });
        // Removing the page you are on leaves it at an address that no longer
        // exists; the next request would redirect anyway.
        if (idOf(p.name) === idOf(currentName())) window.location.assign('/');
        return true;
    };

    const picker = createWorkspacePicker(bar, {
        field: {
            layout: 'centered',
            avoid: '.bar-left > *, .twm-top-nav__btn, .bar-right > *',
            icon: 'folder',
            tooltip: FIELD_TOOLTIP,
        },
        chord: 'Ctrl+P',
        label: 'Switch project',
        placeholder: 'Switch project — type to filter, Enter to open',
        glyph: 'folder_open',
        load: loadProjects,
        describe: (p, { current }) => ({
            id: idOf(p.name),
            name: p.name,
            detail: [p.bugs, p.backlog].filter(Boolean).join('  ·  '),
            icon: current ? 'folder_open' : 'folder',
            badge: current ? 'current' : describeStores(p),
            removable: !p.transient,
        }),
        onPick: (p) => window.location.assign(p.base),
        onRemove: removeProject,
        actions: ({ query }) => [{
            id: 'add',
            label: query.trim() ? `Add project “${query.trim()}”…` : 'Add project…',
            detail: 'Point BugDesk at another repo\'s bugs and/or backlog folder',
            icon: 'add',
            always: true,
            run: ({ query: typed }) => addProject({
                eventBus,
                name: typed.trim(),
                // Back in the list with the new project selected: Enter goes there.
                onAdded: (name) => picker.open({ select: idOf(name) }),
            }),
        }],
        footer: () => ({
            keys: [
                { keys: ['Enter'], label: 'open' },
                { keys: ['Shift', 'Del'], label: 'remove' },
                { keys: ['Esc'], label: 'close' },
            ],
        }),
        labels: {
            failed: (err) => `Could not list projects: ${err?.message || err}`,
            remove: (name) => `Remove ${name} from projects.toml (the folders stay)`,
        },
    });
    picker.setCurrent({ name: currentName() });

    return {
        showAbsent(absent) {
            picker.field.update(absent
                ? { name: 'n/a', muted: true,
                    tooltip: 'The tracker is global — it belongs to no project. Click or Ctrl+P to switch project.' }
                : { name: currentName(), muted: false, tooltip: FIELD_TOOLTIP });
        },
    };
}

/**
 * Add a project: a name and its folders. Either folder may be left empty — a
 * repo with only a backlog gets no Bugs page — but not both. Typing the bugs
 * folder fills in the backlog beside it and the name from the repo, as long as
 * those still hold what was filled in for them; anything typed by hand is left
 * alone.
 */
async function addProject({ eventBus, name = '', onAdded }) {
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
            onAdded(values.name);
            return j;
        } catch (err) {
            // The server is what knows whether a folder exists; say what it said
            // and hand the form back as it was typed.
            eventBus?.emit?.('toast:show', { type: 'error', message: `Could not add ${values.name || 'the project'}: ${err?.message || err}` });
        }
    }
}
