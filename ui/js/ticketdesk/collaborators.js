/**
 * ticketdesk/collaborators.js — the shared roster, edited.
 *
 * `bugdesk.json` beside the stores lists who works on this repo (see
 * server/ProjectConfig.cs). It is COMMITTED, unlike the per-user profile: an
 * assignee dropdown offering only "me and my agent" cannot express "this is
 * Alice's", which is most of what triage is.
 *
 * The roster mostly maintains itself — setting your name adds you, and the
 * `/bugs` and `/backlog` skills add the people they find in the git history —
 * so this editor exists for the cases that cannot: somebody who has not opened
 * BugDesk yet, a name spelled two ways, a person who has left.
 *
 * Reached from Settings › General › Authorship. Its own overlay, in the same
 * z-tier as the filter editor, because it can be opened from a page that is
 * itself inside a modal.
 */

import { esc } from './data.js';

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
export function openCollaborators({ eventBus } = {}) {
    return new Promise((resolve) => {
        let rows = [];
        let path = 'bugdesk.json';

        const overlay = document.createElement('div');
        overlay.className = 'bd-picker bd-collabs';
        overlay.innerHTML = `
            <div class="bd-picker__dialog" role="dialog" aria-modal="true" aria-label="Collaborators">
                <div class="bd-picker__head">
                    ${icon('group')}
                    <span class="bd-collabs__title">Collaborators</span>
                    <button type="button" class="bd-picker__close" data-a="cancel"
                            aria-label="Cancel">${icon('close')}</button>
                </div>
                <div class="bd-collabs__lede td-dim">
                    Everyone who can be assigned work on this repo. Shared and committed —
                    your own name, filters and layout stay private.
                </div>
                <div class="bd-collabs__grid" data-slot="rows"></div>
                <div class="bd-collabs__addrow">
                    ${icon('person_add')}
                    <input class="ea-tin" data-slot="newname" placeholder="Add someone by name">
                </div>
                <div class="bd-picker__foot">
                    <span class="td-dim bd-collabs__path" data-slot="path"></span>
                    <span class="td-spacer"></span>
                    <button type="button" class="ea-btn" data-a="cancel">Cancel</button>
                    <button type="button" class="ea-btn ea-btn--primary" data-a="save">Save</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const rowsEl = overlay.querySelector('[data-slot="rows"]');
        const newEl = overlay.querySelector('[data-slot="newname"]');
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        let settled = false;
        const close = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { returnFocus?.focus(); } catch { /* gone */ }
            resolve(value);
        };

        const render = () => {
            overlay.querySelector('[data-slot="path"]').textContent = path;
            rowsEl.innerHTML = rows.length
                ? `<div class="bd-collabs__hdr">Name</div>
                   <div class="bd-collabs__hdr">Agent</div>
                   <div></div>` + rows.map((r, i) => `
                    <input class="ea-tin" data-name="${i}" value="${esc(r.name)}">
                    <input class="ea-tin td-mono" data-agent="${i}" value="${esc(r.agent || '')}"
                           placeholder="${esc(agentNameFor(r.name))}">
                    <button type="button" class="bd-collabs__rm" data-remove="${i}"
                            title="Remove ${esc(r.name)}" aria-label="Remove ${esc(r.name)}">${icon('close')}</button>`).join('')
                : '<div class="td-dim bd-collabs__empty">Nobody yet — add the first person below.</div>';
        };

        const add = (name) => {
            const clean = String(name || '').trim();
            if (!clean) return;
            if (rows.some((r) => r.name.toLowerCase() === clean.toLowerCase())) return;
            rows.push({ name: clean, agent: agentNameFor(clean) });
            render();
        };

        rowsEl.addEventListener('input', (e) => {
            const nameEl = e.target.closest('[data-name]');
            if (nameEl) {
                const i = Number(nameEl.dataset.name);
                const before = rows[i].name;
                rows[i].name = nameEl.value;
                // Keep the derived agent following the name, but never overwrite
                // one somebody deliberately chose.
                const agentEl = rowsEl.querySelector(`[data-agent="${i}"]`);
                if (agentEl && (!rows[i].agent || rows[i].agent === agentNameFor(before))) {
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
        });

        overlay.addEventListener('click', async (e) => {
            if (e.target === overlay) { close(null); return; }
            const act = e.target.closest('[data-a]')?.dataset.a;
            if (act === 'cancel') { close(null); return; }
            if (act !== 'save') return;

            // A name typed into the add box but never confirmed with Enter is
            // still something the user asked for.
            add(newEl.value);
            newEl.value = '';
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
                    message: `Collaborators saved. Reload BugDesk for the assignee lists to pick it up.`,
                });
                close(j.collaborators);
            } catch (err) {
                eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save: ${err?.message || err}` });
            }
        });

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        };
        document.addEventListener('keydown', onKey, true);

        fetchRoster()
            .then((r) => { rows = r.collaborators.map((c) => ({ ...c })); path = r.path || path; render(); })
            .catch((err) => {
                rowsEl.innerHTML = `<div class="td-dim">Could not load the roster: ${esc(err?.message || String(err))}</div>`;
            });
        render();
        requestAnimationFrame(() => newEl.focus());
    });
}
