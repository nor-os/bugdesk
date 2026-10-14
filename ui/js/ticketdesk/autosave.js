/**
 * ticketdesk/autosave.js — record edits saved without pressing Save.
 *
 * Settings › Saving and git (`git.autosave` in project.json) picks the mode:
 *   off       — as before: Save saves
 *   debounce  — N seconds after the last keystroke
 *
 * WHAT IS SHOWN IS WHAT IS ON DISK: Unsaved, Saving…, Saved at hh:mm, Save
 * failed (retrying in Ns), or the conflict. A failed save is retried after 2 s,
 * 4 s, 8 s … at most 60 s, and nothing typed is lost meanwhile — the edits stay
 * in the form and the next attempt sends them all.
 *
 * NEVER OVER SOMEBODY ELSE'S EDIT. Each auto-save tells the bridge which version
 * it started from; if the file changed on disk since (an agent, a pull), the
 * bridge refuses, auto-save stops, and the page says so — the person decides,
 * as with any change under an edited page (live.js).
 *
 * AND NOT A COMMIT PER KEYSTROKE. Auto-saves write without committing; when the
 * page is left, or after five quiet minutes, the record is settled: one commit,
 * if the project commits after save (STORY-0006).
 */

import { CONFIG, apiUrl } from './instance.js';

const SETTLE_AFTER_MS = 5 * 60 * 1000;
const BACKOFF = [2, 4, 8, 16, 32, 60];

/** The configured mode: `{ mode: 'off'|'debounce', seconds }`. */
export function autosaveMode() {
    const s = CONFIG.saving || {};
    const mode = s.autosave === 'debounce' ? 'debounce' : 'off';
    return { mode, seconds: Math.max(1, Number(s.autosaveSeconds) || 2) };
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Attach auto-save to a record page.
 *
 * @param {object} o
 * @param {HTMLElement} o.statusEl   where the save state is written
 * @param {() => boolean} o.isDirty
 * @param {(o:{auto:boolean}) => Promise<void>} o.save   saves; throws on failure
 *                                    (an Error with `conflict: true` for a 409)
 * @param {() => string} o.ref        the record's reference, for the settle
 * @returns {{ edited(): void, clean(): void, saved(): void, destroy(): void, enabled: boolean }}
 */
export function attachAutosave({ statusEl, isDirty, save, ref }) {
    const { mode, seconds } = autosaveMode();
    const enabled = mode !== 'off';
    let timer = null;
    let retryTimer = null;
    let settleTimer = null;
    let attempt = 0;
    let stopped = false;          // a conflict: auto-save stays off until reload
    let unsettled = false;        // auto-saved since the last commit
    let saving = false;

    const show = (text, tone = '') => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.dataset.tone = tone;
    };

    const settle = () => {
        if (!unsettled) return;
        unsettled = false;
        const body = JSON.stringify({ ref: ref() });
        // sendBeacon survives the page going away; fetch is the fallback.
        try {
            if (navigator.sendBeacon?.(apiUrl('/git/settle'), new Blob([body], { type: 'application/json' }))) return;
        } catch { /* fall through */ }
        fetch(apiUrl('/git/settle'), { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
            .catch(() => { /* the Changes pane still lists it */ });
    };

    const run = async () => {
        timer = null;
        if (stopped || saving || !isDirty()) return;
        saving = true;
        show('Saving…', 'busy');
        try {
            await save({ auto: true });
            attempt = 0;
            unsettled = true;
            clearTimeout(settleTimer);
            settleTimer = setTimeout(settle, SETTLE_AFTER_MS);
            show(`Saved at ${hhmm(new Date())}`, 'ok');
        } catch (err) {
            if (err?.conflict) {
                stopped = true;
                show('Not saved — changed on disk since it was opened. Reload, or Save to keep yours.', 'err');
            } else {
                const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
                attempt++;
                show(`Save failed — retrying in ${wait} s (${err?.message || err})`, 'err');
                clearTimeout(retryTimer);
                retryTimer = setTimeout(run, wait * 1000);
            }
        } finally {
            saving = false;
        }
        // Edits typed while that save was on the wire get their own.
        if (!stopped && isDirty() && !retryTimer) schedule();
    };

    function schedule() {
        if (!enabled || stopped) return;
        clearTimeout(timer);
        timer = setTimeout(run, seconds * 1000);
    }

    if (enabled) show('Auto-save on', '');
    return {
        enabled,
        /** An edit was made: Unsaved, and a save is scheduled. */
        edited() {
            if (!enabled) return;
            show('Unsaved', 'warn');
            schedule();
        },
        /** The page is clean again (loaded, reverted): nothing to save. */
        clean() {
            clearTimeout(timer); timer = null;
            if (statusEl?.dataset.tone === 'warn') show('Auto-save on', '');
        },
        /** A save by hand succeeded: nothing pending. */
        saved() {
            clearTimeout(timer); timer = null;
            clearTimeout(retryTimer); retryTimer = null;
            attempt = 0;
            stopped = false;
            if (enabled) show(`Saved at ${hhmm(new Date())}`, 'ok');
        },
        destroy() {
            clearTimeout(timer); clearTimeout(retryTimer); clearTimeout(settleTimer);
            settle();
        },
    };
}
