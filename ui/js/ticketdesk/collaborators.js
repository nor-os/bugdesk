/**
 * ticketdesk/collaborators.js — the shared roster, edited.
 *
 * `.bugdesk/project.json` lists who works on this repo (see
 * server/ProjectConfig.cs). It is COMMITTED, unlike the per-user profile: an
 * assignee dropdown offering only "me and my agent" cannot express "this is
 * Alice's", which is most of what triage is.
 *
 * The roster mostly maintains itself — setting your name adds you, and the
 * `/bugs` and `/backlog` skills add the people they find in the git history —
 * so this editor exists for the cases that cannot: somebody who has not opened
 * BugDesk yet, a name spelled two ways, a person who has left.
 *
 * Drawn on the Settings page as Settings › Team (`mountTeam`, STORY-0032), and
 * opened as a window from the hamburger menu and the change-your-name dialog,
 * where it is a question you have while looking at something else. Both are the
 * same editor (`rosterEditor`).
 *
 * The window is A REAL MANAGED WINDOW (openModal), not a hand-rolled overlay. The overlay it
 * replaced was written when this could open on top of another modal, which it
 * no longer can — every caller closes its own dialog first — and it cost more
 * than the stacking it bought: no drag, no resize, chrome that only looked like
 * the app's, and inputs that got no styling at all. `.ea-tin` is scoped to
 * `.td-page`/`.td-modal`/`.td-nav`/`.td-rpanel`, and a bare overlay is none of
 * those, so every field in here rendered as an unstyled browser input — white
 * box, wrong font, wrong size — in the middle of a dark app.
 *
 * The roster rows carry `ea-modal__row` for exactly that reason: it is the class
 * the modal stylesheet hangs its input styling off, so the fields look like the
 * fields in every other dialog rather than like a second opinion about what an
 * input is. The grid layout is put back over the top (see backlog.css), because
 * that class also carries a two-column label/field template this does not want.
 */

import { AGENTS_ASSIGNABLE, esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { apiUrl } from './instance.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** The conventional agent name for a person — the same rule the server applies
 *  in `ProjectConfig.AgentNameFor`, so the two never disagree about a default. */
export const agentNameFor = (human) => {
    const slug = String(human || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug ? `${slug}_agent` : '';
};

async function fetchRoster() {
    const res = await fetch(apiUrl('/project'), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /api/project → ${res.status}`);
    const j = await res.json();
    if (!j?.ok) throw new Error('the bridge returned no project config');
    const list = j.config?.collaborators;
    return { path: j.path, collaborators: Array.isArray(list) ? list : [] };
}

/**
 * The roster editor, unattached: its element, and what to do with it.
 * @param {object} [o]
 * @param {() => void} [o.onChange]  after any edit, and once loaded
 */
function rosterEditor({ onChange = () => {} } = {}) {
    let rows = [];
    let path = '.bugdesk/project.json';
    let loaded = '[]';

    const body = document.createElement('div');
    // No Agent column where nobody has one — see AGENTS_ASSIGNABLE in ./data.js.
    // Offering a field that must stay empty is how a roster grows entries no
    // picker can use.
    body.className = `bd-collabs${AGENTS_ASSIGNABLE ? '' : ' bd-collabs--noagents'}`;
    body.innerHTML = `
        <p class="ea-modal__hint bd-collabs__lede">
            Everyone who can be assigned work here. Shared and committed — your own
            name, filters and layout stay private.
        </p>
        <div class="bd-collabs__grid" data-slot="rows"></div>
        <div class="ea-modal__row bd-collabs__addrow">
            <span>Add someone</span>
            <input type="text" data-slot="newname" placeholder="a name, then Enter">
        </div>
        <div class="td-dim bd-collabs__path" data-slot="path"></div>`;

    const rowsEl = body.querySelector('[data-slot="rows"]');
    const newEl = body.querySelector('[data-slot="newname"]');

    const render = () => {
        body.querySelector('[data-slot="path"]').textContent = path;
        rowsEl.innerHTML = rows.length
            ? `<div class="bd-collabs__hdr">
                   <span>Name</span><span>Agent</span><span></span>
               </div>`
              + rows.map((r, i) => `
                <div class="ea-modal__row bd-collabs__row">
                    <input type="text" data-name="${i}" value="${esc(r.name)}"
                           aria-label="Name">
                    <input type="text" class="td-mono" data-agent="${i}" value="${esc(r.agent || '')}"
                           placeholder="${esc(agentNameFor(r.name))}" aria-label="Agent name">
                    <button type="button" class="bd-collabs__rm" data-remove="${i}"
                            title="Remove ${esc(r.name)}"
                            aria-label="Remove ${esc(r.name)}">${icon('close')}</button>
                </div>`).join('')
            : '<div class="td-dim bd-collabs__empty">Nobody yet — add the first person below.</div>';
    };

    const add = (name) => {
        const clean = String(name || '').trim();
        if (!clean) return;
        if (rows.some((r) => r.name.toLowerCase() === clean.toLowerCase())) return;
        rows.push({ name: clean, agent: AGENTS_ASSIGNABLE ? agentNameFor(clean) : '' });
        render();
    };

    rowsEl.addEventListener('input', (e) => {
        const nameEl = e.target.closest('[data-name]');
        if (nameEl) {
            const i = Number(nameEl.dataset.name);
            const before = rows[i].name;
            rows[i].name = nameEl.value;
            // Keep the derived agent following the name, but never overwrite one
            // somebody deliberately chose.
            const agentEl = rowsEl.querySelector(`[data-agent="${i}"]`);
            if (AGENTS_ASSIGNABLE && agentEl
                && (!rows[i].agent || rows[i].agent === agentNameFor(before))) {
                rows[i].agent = agentNameFor(nameEl.value);
                agentEl.value = rows[i].agent;
            }
            onChange();
            return;
        }
        const agentEl = e.target.closest('[data-agent]');
        if (agentEl) { rows[Number(agentEl.dataset.agent)].agent = agentEl.value; onChange(); }
    });

    rowsEl.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove]');
        if (!rm) return;
        rows.splice(Number(rm.dataset.remove), 1);
        render();
        onChange();
    });

    newEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        add(newEl.value);
        newEl.value = '';
        newEl.focus();
        onChange();
    });
    newEl.addEventListener('input', () => onChange());

    /** The list as it would be saved: a name typed into the add box but never
     *  confirmed with Enter is still something the user asked for. */
    const collect = () => {
        const list = rows.map((r) => ({ name: String(r.name || '').trim(), agent: String(r.agent || '').trim() }));
        const typed = String(newEl.value || '').trim();
        if (typed && !list.some((r) => r.name.toLowerCase() === typed.toLowerCase())) {
            list.push({ name: typed, agent: AGENTS_ASSIGNABLE ? agentNameFor(typed) : '' });
        }
        return list.filter((r) => r.name);
    };

    const load = () => fetchRoster()
        .then((r) => {
            rows = r.collaborators.map((c) => ({ ...c }));
            path = r.path || path;
            newEl.value = '';
            loaded = JSON.stringify(collect());
            render();
            onChange();
        })
        .catch((err) => {
            rowsEl.innerHTML = `<div class="td-dim">Could not load the roster: ${esc(err?.message || String(err))}</div>`;
        });

    /** Save; resolves the saved list, or throws. */
    const save = async () => {
        const res = await fetch(apiUrl('/project/collaborators'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ collaborators: collect() }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        return j.collaborators;
    };

    render();
    return { body, newEl, load, save, dirty: () => JSON.stringify(collect()) !== loaded };
}

const savedToast = (eventBus) => eventBus?.emit?.('toast:show', {
    type: 'info',
    message: `Collaborators saved. Reload ${appName()} for the assignee lists to pick it up.`,
});

/**
 * Open the roster editor in a window. Resolves to the saved list, or null if cancelled.
 */
export async function openCollaborators({ eventBus } = {}) {
    const { openModal } = await import('@flexdesk/widgets');
    const ed = rosterEditor();
    ed.load();

    const choice = await openModal({
        title: 'Collaborators',
        icon: 'group',
        content: ed.body,
        width: 560,
        height: 420,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Save', value: 'save', primary: true },
        ],
        onMount: () => requestAnimationFrame(() => ed.newEl.focus()),
    });
    if (choice !== 'save') return null;

    try {
        const saved = await ed.save();
        savedToast(eventBus);
        return saved;
    } catch (err) {
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save: ${err?.message || err}` });
        return null;
    }
}

/**
 * Settings › Team: the same editor, on the page, with its own Save.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @returns {() => void} cleanup
 */
export function mountTeam(el, { eventBus = null } = {}) {
    let saving = false;
    let problem = '';
    const wrap = document.createElement('div');
    wrap.className = 'bd-team';
    wrap.innerHTML = `
        <div class="bd-schema__bar">
            <span class="bd-schema__state td-dim" data-slot="state" aria-live="polite"></span>
            <button type="button" class="ea-btn" data-act="discard">Discard changes</button>
            <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
        </div>`;
    const sync = () => {
        const changed = ed.dirty();
        wrap.querySelector('[data-slot="state"]').textContent = problem || (changed ? 'Unsaved changes' : '');
        for (const b of wrap.querySelectorAll('[data-act]')) b.disabled = saving || !changed;
    };
    const ed = rosterEditor({ onChange: () => sync() });
    wrap.append(ed.body);
    wrap.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'discard') { problem = ''; ed.load(); return; }
        if (act !== 'save') return;
        saving = true; problem = ''; sync();
        try {
            await ed.save();
            savedToast(eventBus);
            await ed.load();
        } catch (err) {
            problem = `Not saved: ${err?.message || err}`;
        }
        saving = false;
        sync();
    });
    sync();
    ed.load();
    el.replaceChildren(wrap);
    return () => {};
}
