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
 * opened as the Team window from the hamburger menu, where it is a question you
 * have while looking at something else.
 * Both are the same editor (`rosterEditor`), drawn the same way: the window used
 * to have a second, plainer layout of its own, and two looks for one list read
 * as two different lists.
 *
 * The window is A REAL MANAGED WINDOW (openModal), not a hand-rolled overlay.
 * Its body sits in `.bd-proj`, the class the Settings editors' input styling
 * hangs off — `.ea-tin` is scoped to `.td-page`/`.td-modal`/`.td-nav`/
 * `.td-rpanel`, and a modal is none of those, so without it every field would
 * render as an unstyled browser input in the middle of a dark app.
 */

import { AGENTS_ASSIGNABLE, HUMAN_AUTHOR, TEAM, esc, initials } from './data.js';
import { appName } from '../core/app_identity.js';
import { apiUrl } from './instance.js';
import { pageBar, projectFoot } from './page_bar.js';

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
    let loaded = '[]';

    const body = document.createElement('div');
    body.className = 'bd-team__roster';
    body.innerHTML = `
        <div class="bd-schema__shead"><h4>People</h4><span class="bd-schema__cnt" data-slot="count"></span></div>
        <div data-slot="rows"></div>
        <div class="bd-team__add">
            <span class="bd-team__av bd-team__av--add"><span class="material-symbols-outlined">add</span></span>
            <input type="text" data-slot="newname" placeholder="Add someone: type a name, then Enter" aria-label="Add someone">
            <button type="button" class="ea-btn" data-act="add">${icon('person_add')} Add person</button>
        </div>
        <p class="td-dim bd-team__hint">Removing someone does not change records already assigned to them.${AGENTS_ASSIGNABLE
            ? ' The agent is the name an AI agent working for them is assigned as; leave it empty for the suggested one.' : ''}</p>`;

    const rowsEl = body.querySelector('[data-slot="rows"]');
    const newEl = body.querySelector('[data-slot="newname"]');

    /** Their bugs, open and closed, as the Inspector counts them; null where nothing is counted. */
    const work = (name) => {
        if (!TEAM.length) return null;
        const t = TEAM.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
        return t ? `<span><b>${t.inc} open</b> · ${t.other} closed</span>` : '<span class="td-dim">nothing yet</span>';
    };

    const render = () => {
        body.querySelector('[data-slot="count"]').textContent = rows.length || '';
        const counted = TEAM.length > 0;
        // No Agent column where nobody has one — see AGENTS_ASSIGNABLE in ./data.js.
        // Offering a field that must stay empty is how a roster grows entries no
        // picker can use.
        body.style.setProperty('--bd-team-cols', ['22px', 'minmax(0, 1fr)', ...(AGENTS_ASSIGNABLE ? ['minmax(0, 1fr)'] : []),
            ...(counted ? ['130px'] : []), '26px'].join(' '));
        rowsEl.innerHTML = rows.length
            ? `<div class="bd-team__grid">
                   <span></span><span class="bd-team__h">Name</span>${AGENTS_ASSIGNABLE ? '<span class="bd-team__h">Agent</span>' : ''}${
                   counted ? '<span class="bd-team__h">Bugs now</span>' : ''}<span></span>
                   ${rows.map((r, i) => {
                       const me = String(r.name || '').trim().toLowerCase() === String(HUMAN_AUTHOR).toLowerCase();
                       return `
                       <span class="bd-team__c"><span class="bd-team__av">${esc(initials(r.name) || '?')}</span></span>
                       <span class="bd-team__c bd-team__name"><input type="text" data-name="${i}" value="${esc(r.name)}" aria-label="Name">${
                           me ? '<span class="bd-team__you">you</span>' : ''}</span>
                       ${AGENTS_ASSIGNABLE ? `<span class="bd-team__c"><input type="text" class="td-mono" data-agent="${i}" value="${esc(r.agent || '')}"
                           placeholder="${esc(agentNameFor(r.name))}" aria-label="Agent name"></span>` : ''}
                       ${counted ? `<span class="bd-team__c bd-team__work">${work(r.name)}</span>` : ''}
                       <span class="bd-team__c"><button type="button" class="bd-schema__rm" data-remove="${i}"
                           title="Remove ${esc(r.name)}" aria-label="Remove ${esc(r.name)}">${icon('close')}</button></span>`;
                   }).join('')}
               </div>`
            : '<div class="td-dim bd-schema__empty">Nobody yet: add the first person below.</div>';
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

    const addTyped = () => {
        add(newEl.value);
        newEl.value = '';
        newEl.focus();
        onChange();
    };
    newEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        addTyped();
    });
    body.querySelector('[data-act="add"]')?.addEventListener('click', addTyped);
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
    message: `Team saved. Reload ${appName()} for the assignee lists to pick it up.`,
});

/**
 * Open Settings › Team's editor in a window. Resolves to the saved list, or null if cancelled.
 */
export async function openCollaborators({ eventBus } = {}) {
    const { openModal } = await import('@flexdesk/widgets');
    const ed = rosterEditor();
    const wrap = document.createElement('div');
    wrap.className = 'bd-proj bd-team';
    wrap.append(ed.body);
    ed.load();

    const choice = await openModal({
        title: 'Team',
        icon: 'group',
        content: wrap,
        width: 640,
        height: 460,
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
export function mountTeam(el, { eventBus = null, actions = null } = {}) {
    let saving = false;
    let problem = '';
    const wrap = document.createElement('div');
    wrap.className = 'bd-proj bd-team';
    const ed = rosterEditor({ onChange: () => sync() });
    ed.body.classList.add('bd-surface');
    wrap.append(ed.body);
    wrap.insertAdjacentHTML('beforeend', projectFoot());
    const bar = pageBar(actions, wrap, async (act) => {
        if (act === 'discard') { problem = ''; ed.load(); return; }
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
    const sync = () => bar.sync({ dirty: ed.dirty(), busy: saving, note: problem });
    sync();
    ed.load();
    el.replaceChildren(wrap);
    return () => bar.remove();
}
