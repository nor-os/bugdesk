/**
 * ticketdesk/autosave_setting.js — Settings › Behaviour › Auto-save: whether
 * YOUR record pages save by themselves (STORY-0032).
 *
 * Auto-save used to be a project setting, in project.json beside commit-after-
 * save, so one person's habit was switched on or off for everybody who pulled
 * the repo. It is a habit, so it is now each person's: `autosave` and
 * `autosaveSeconds` in their profile's settings (`POST /api/user/settings`),
 * which the server lays over the project's value in `CONFIG.saving`
 * (GitSettings.ForUser). Until someone chooses, the project's value still
 * applies to them, and "The project's default" says what it is. Choosing that
 * again clears their own (a `null` in the profile).
 *
 * Drawn as a row like the page's others, because it is one value — but its
 * value lives in the profile, not this browser, so it is a panel rather than a
 * schema row the settings store would keep in localStorage.
 */

import { esc } from './data.js';
import { CONFIG, apiUrl } from './instance.js';
import { attachSelect } from './select_field.js';

const PROJECT = 'project';
const MODE_LABEL = { off: 'Only when I press Save', debounce: 'A few seconds after I stop typing' };

/**
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @returns {() => void} cleanup
 */
export function mountAutosaveSetting(el, { eventBus = null } = {}) {
    const s = CONFIG.saving || {};
    const projectMode = s.projectAutosave === 'debounce' ? 'debounce' : 'off';
    const projectSecs = Number(s.projectAutosaveSeconds) || 2;
    let choice = s.ownAutosave ? (s.autosave === 'debounce' ? 'debounce' : 'off') : PROJECT;
    let seconds = String(s.ownAutosave ? (Number(s.autosaveSeconds) || 2) : projectSecs);
    let state = '';
    let select = null;
    let timer = null;

    const projectLabel = `The project's default (${projectMode === 'debounce'
        ? `${projectSecs} s after I stop typing` : 'only when I press Save'})`;

    const render = () => {
        try { select?.destroy(); } catch { /* gone */ }
        el.innerHTML = `
            <div class="settings-page__setting" data-path="bugdesk.autosave">
                <div class="settings-page__setting-info">
                    <label class="settings-page__setting-label">Auto-save</label>
                    <span class="settings-page__setting-desc">Whether a record you are editing saves by itself, and how long after
                        you stop typing. Yours alone: it is saved to your profile, and other people choose their own. Auto-saves
                        commit once you leave the record, or after five quiet minutes, if the project commits after save.
                        Takes effect on records you open from now on.${state ? ` <b>${esc(state)}</b>` : ''}</span>
                </div>
                <div class="settings-page__setting-control bd-autosave-setting">
                    <select data-slot="mode">
                        <option value="${PROJECT}"${choice === PROJECT ? ' selected' : ''}>${esc(projectLabel)}</option>
                        ${Object.entries(MODE_LABEL).map(([v, l]) => `<option value="${v}"${choice === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
                    </select>
                    ${choice === 'debounce' ? `<input type="number" class="settings-number" data-slot="secs" min="1" max="3600"
                        value="${esc(seconds)}" aria-label="Seconds after the last keystroke"> <span class="td-dim">s</span>` : ''}
                </div>
            </div>`;
        const sel = el.querySelector('[data-slot="mode"]');
        select = attachSelect(sel, {
            options: [...sel.options].map((o) => ({ value: o.value, label: o.textContent })),
            value: choice,
            onChange: (v) => { choice = v; save(); render(); },
        });
    };

    const save = async () => {
        const own = choice === PROJECT
            ? { autosave: null, autosaveSeconds: null }
            : { autosave: choice, autosaveSeconds: choice === 'debounce' ? Math.max(1, Math.min(3600, Number(seconds) || 2)) : 0 };
        try {
            const res = await fetch(apiUrl('/user/settings'), {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(own),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            // The record pages read the mode as they open (autosave.js): one opened
            // from now on uses this.
            CONFIG.saving = {
                ...(CONFIG.saving || {}),
                ownAutosave: choice !== PROJECT,
                autosave: choice === PROJECT ? projectMode : choice,
                autosaveSeconds: choice === PROJECT ? projectSecs : (own.autosaveSeconds || 0),
            };
            state = '';
        } catch (err) {
            state = `Not saved: ${err?.message || err}`;
            eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save auto-save: ${err?.message || err}` });
            render();
        }
    };

    el.addEventListener('input', (e) => {
        if (e.target.dataset?.slot !== 'secs') return;
        seconds = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; save(); }, 400);
    });

    render();
    return () => {
        // Leaving the page with seconds still being typed saves them.
        if (timer) { clearTimeout(timer); save(); }
        try { select?.destroy(); } catch { /* gone */ }
    };
}
