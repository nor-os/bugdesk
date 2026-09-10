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
 * Reached from Settings › General › Authorship, the hamburger menu, and the
 * change-your-name dialog.
 *
 * A REAL MANAGED WINDOW (openModal), not a hand-rolled overlay. The overlay it
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

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** The conventional agent name for a person — the same rule the server applies
 *  in `ProjectConfig.AgentNameFor`, so the two never disagree about a default. */
export const agentNameFor = (human) => {
    const slug = String(human || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug ? `${slug}_agent` : '';
};

async function fetchRoster() {
    const res = await fetch('/api/project', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /api/project → ${res.status}`);
    const j = await res.json();
    if (!j?.ok) throw new Error('the bridge returned no project config');
    const list = j.config?.collaborators;
    return { path: j.path, collaborators: Array.isArray(list) ? list : [] };
}

/**
 * Open the roster editor. Resolves to the saved list, or null if cancelled.
 */
export async function openCollaborators({ eventBus } = {}) {
    const { openModal } = await import('../ecoagent/ui/modal.js');

    let rows = [];
    let path = '.bugdesk/project.json';

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
            return;
        }
        const agentEl = e.target.closest('[data-agent]');
        if (agentEl) rows[Number(agentEl.dataset.agent)].agent = agentEl.value;
    });

    rowsEl.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove]');
        if (!rm) return;
        rows.splice(Number(rm.dataset.remove), 1);
        render();
    });

    newEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        add(newEl.value);
        newEl.value = '';
        newEl.focus();
    });

    render();
    fetchRoster()
        .then((r) => { rows = r.collaborators.map((c) => ({ ...c })); path = r.path || path; render(); })
        .catch((err) => {
            rowsEl.innerHTML = `<div class="td-dim">Could not load the roster: ${esc(err?.message || String(err))}</div>`;
        });

    const choice = await openModal({
        title: 'Collaborators',
        icon: 'group',
        content: body,
        width: 560,
        height: 420,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Save', value: 'save', primary: true },
        ],
        onMount: () => requestAnimationFrame(() => newEl.focus()),
    });
    if (choice !== 'save') return null;

    // A name typed into the add box but never confirmed with Enter is still
    // something the user asked for.
    add(newEl.value);
    try {
        const res = await fetch('/api/project/collaborators', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                collaborators: rows
                    .map((r) => ({ name: String(r.name || '').trim(), agent: String(r.agent || '').trim() }))
                    .filter((r) => r.name),
            }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        eventBus?.emit?.('toast:show', {
            type: 'info',
            message: 'Collaborators saved. Reload BugDesk for the assignee lists to pick it up.',
        });
        return j.collaborators;
    } catch (err) {
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save: ${err?.message || err}` });
        return null;
    }
}
