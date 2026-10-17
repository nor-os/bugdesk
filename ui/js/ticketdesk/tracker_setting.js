/**
 * ticketdesk/tracker_setting.js — Settings › You › Behaviour › Tracker: whether
 * YOU see the Tracker section of every project page (STORY-0043).
 *
 * The Tracker is a section somebody either follows work up through or does
 * not, so the switch is each person's: `tracker` in their personal preferences
 * (`POST /api/personal/preferences`), kept in BugDesk's own state folder beside
 * their personal dashboards, so the one choice holds in every project. The
 * server folds it into `CONFIG.tracker.available` (TrackerPayload in
 * server/Program.cs), which is all the rest of the page goes by.
 *
 * `[tracker] enabled = false` in projects.toml stays underneath it as the
 * machine's hard off: the switch then shows off and cannot be turned on.
 *
 * WHY IT RELOADS. The chips, their F-keys and the page kinds come from the
 * taxonomy (tiling/kind_taxonomy.js), which is built once at module load and
 * baked into the window manager and the saved layouts. Rebuilding it live would
 * mean tearing the shell down, so the switch says it reloads, asks first, and
 * then does. Nothing is deleted either way: the tracker's records, its
 * dashboards and its tabs are all where they were.
 */

import { esc } from './data.js';
import { CONFIG, apiUrl } from './instance.js';

/**
 * What the switch shows for a page's config: whether it is on, whether it can be
 * changed, and the note under it. Pure, for the tests.
 *
 * @param {object} cfg  the page's CONFIG (`mode`, `tracker`)
 * @returns {{offered: boolean, on: boolean, disabled: boolean, note: string}}
 */
export function trackerSwitchState(cfg = CONFIG) {
    const t = cfg?.tracker || {};
    if (cfg?.mode === 'tracker') {
        return { offered: false, on: true, disabled: true, note: 'This is TicketDesk: the tracker is the whole app, so there is nothing to switch off.' };
    }
    if (!t.path) {
        return { offered: true, on: false, disabled: true, note: 'No tracker is set up on this machine: add a [tracker] path to projects.toml to have one.' };
    }
    if (t.machineOff) {
        return { offered: true, on: false, disabled: true, note: 'Switched off for this machine: enabled = false under [tracker] in projects.toml. Set it to true there to be able to switch it on.' };
    }
    return { offered: true, on: !t.switchedOff, disabled: false, note: '' };
}

/**
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {Function} [o.confirm]  `openConfirm`-shaped; FlexDesk's by default
 * @param {Function} [o.reload]   what applies the change; a page reload by default
 * @returns {() => void} cleanup
 */
export function mountTrackerSetting(el, { eventBus = null, confirm = null, reload = null } = {}) {
    let state = trackerSwitchState(CONFIG);
    let error = '';
    let busy = false;

    const render = () => {
        // TicketDesk has nothing to switch: only the reason why, and no switch.
        const desc = !state.offered ? esc(state.note) : `Show the Tracker, the follow-up tracker shared by every
            project, as a page in the top bar. Yours alone: it is saved to your profile and holds in every
            project; other people choose their own. Switched off, its chip, its F-key, its dashboards and its
            tickets in search are gone until you switch it back on. Nothing is deleted. BugDesk reloads to
            apply it.${state.note ? ` <b>${esc(state.note)}</b>` : ''}${error ? ` <b>${esc(error)}</b>` : ''}`;
        el.innerHTML = `
            <div class="settings-page__setting" data-path="bugdesk.tracker">
                <div class="settings-page__setting-info">
                    <label class="settings-page__setting-label">Tracker</label>
                    <span class="settings-page__setting-desc">${desc}</span>
                </div>
                ${state.offered ? `<div class="settings-page__setting-control">
                    <button class="settings-toggle${state.on ? ' settings-toggle--on' : ''}" data-slot="tracker-toggle"
                        role="switch" aria-checked="${state.on}" type="button"${state.disabled || busy ? ' disabled' : ''}
                        aria-label="Show the Tracker"></button>
                </div>` : ''}
            </div>`;
    };

    const flip = async () => {
        if (state.disabled || busy) return;
        await switchTracker(!state.on, {
            confirm, reload, eventBus,
            onBusy: () => { busy = true; render(); },
            onError: (msg) => { busy = false; error = msg; state = trackerSwitchState(CONFIG); render(); },
        });
    };

    const onClick = (e) => { if (e.target.closest('[data-slot="tracker-toggle"]')) flip(); };
    el.addEventListener('click', onClick);
    render();
    return () => el.removeEventListener('click', onClick);
}

/**
 * Switch the Tracker on or off for you: ask, save, reload. Resolves to whether
 * it was saved (the page is reloading then); a Cancel saves nothing.
 *
 * @param {boolean} next  true to switch it on
 * @param {object} [o]  `confirm`, `reload`, `eventBus` as for the mount, and
 *   `onBusy()` / `onError(message)` for the row that shows it
 */
export async function switchTracker(next, { confirm = null, reload = null, eventBus = null, onBusy = null, onError = null } = {}) {
    const ask = confirm || (await import('@flexdesk/widgets')).openConfirm;
    const ok = await ask({
        title: next ? 'Switch the Tracker on' : 'Switch the Tracker off',
        message: next
            ? '<p>BugDesk reloads to bring the Tracker back into the top bar, with its dashboards and its tickets in search.</p>'
            : '<p>BugDesk reloads to take the Tracker out of the top bar, the F-keys, the rails and search.</p>'
              + '<p class="td-dim">Nothing is deleted: its tickets and dashboards stay, and come back when you switch it on. Only you are affected.</p>',
        confirmLabel: next ? 'Switch on and reload' : 'Switch off and reload',
        icon: 'space_dashboard',
    });
    if (!ok) return false;
    onBusy?.();
    try {
        const res = await fetch(apiUrl('/personal/preferences'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            // On is the default, so switching back on clears the key.
            body: JSON.stringify({ tracker: next ? null : false }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        CONFIG.tracker = { ...(CONFIG.tracker || {}), ...(j.tracker || {}) };
        (reload || (() => window.location.reload()))();
        return true;
    } catch (err) {
        onError?.(`Not saved: ${err?.message || err}`);
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not switch the Tracker: ${err?.message || err}` });
        return false;
    }
}

/**
 * Behaviour's Reset puts the switch back to its default, on — which, like the
 * switch itself, asks first and reloads. Off for the machine, or with no
 * tracker, there is nothing of yours to reset.
 */
export async function resetTrackerSwitch(o = {}) {
    const state = trackerSwitchState(CONFIG);
    if (!state.offered || state.disabled || state.on) return false;
    return switchTracker(true, o);
}
