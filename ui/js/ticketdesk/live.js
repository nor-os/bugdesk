/**
 * ticketdesk/live.js — the store, as it is right now.
 *
 * BugDesk's records are markdown files, and the point of that is that other
 * things write them: a `git pull`, an agent working through the `/bugs` skill,
 * somebody's editor. Until this existed the UI only ever knew the store as it
 * was at page load — so an agent could move a bug to `testing` and the human
 * would sit looking at `investigation` until they happened to reload, and if
 * they then saved they would silently overwrite the agent.
 *
 * The bridge watches the directories and pushes changes over Server-Sent Events
 * (see server/StoreWatcher.cs, which suppresses the echo of our own writes by
 * content hash). This module receives them and does two different things,
 * because two different situations need different answers:
 *
 *   A LIST is refreshed silently. Nobody is mid-sentence in a table, and a
 *   queue showing yesterday's state is simply wrong.
 *
 *   An OPEN RECORD is refreshed silently ONLY IF you have no unsaved edits.
 *   If you do, discarding them without asking would be destroying your work to
 *   show you somebody else's — so the page says so and offers the choice:
 *   reload and lose your edits, or keep them and overwrite on save. Both are
 *   legitimate; neither is safe to pick on the user's behalf.
 */

import { loadData } from './data.js';
import { loadBacklog } from './backlog_data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _source = null;
let _bus = null;

/**
 * Connect to the bridge's event stream. Idempotent — a second call is a no-op,
 * so a re-install (a shell reload without a page reload) cannot end up with two
 * streams reloading the stores twice per change.
 */
export function installLiveUpdates({ eventBus, logger } = {}) {
    if (_source) return { close: closeLiveUpdates };
    _bus = eventBus || null;
    const log = logger ?? console;

    try {
        _source = new EventSource('/api/events');
    } catch (err) {
        log.warn?.('[bugdesk] live updates unavailable', err);
        return { close: () => {} };
    }

    _source.addEventListener('store', async (e) => {
        let payload;
        try { payload = JSON.parse(e.data); }
        catch (err) { log.warn?.('[bugdesk] unreadable store event', err); return; }

        const stores = new Set(payload?.stores || []);
        // Reload FIRST, announce after: a page reacting to the event must find
        // the new data already in the store, not race the fetch that gets it.
        const loads = [];
        if (stores.has('bugs')) loads.push(loadData().catch((err) => log.warn?.('[bugdesk] bug reload failed', err)));
        if (stores.has('backlog')) loads.push(loadBacklog().catch((err) => log.warn?.('[bugdesk] backlog reload failed', err)));
        await Promise.all(loads);

        if (stores.has('bugs')) _bus?.emit?.('bugs:changed', payload);
        if (stores.has('backlog')) _bus?.emit?.('backlog:changed', payload);
        if (stores.has('project')) _bus?.emit?.('project:changed', payload);
        // Carries the per-file detail, which is what an open record page needs
        // in order to ask "was that me?".
        _bus?.emit?.('store:changed', payload);

        const n = (payload?.changed || []).length;
        if (n) {
            const el = document.getElementById('sim-status');
            if (el) el.textContent = `${n} record${n === 1 ? '' : 's'} changed outside BugDesk — lists refreshed.`;
        }
    });

    // EventSource reconnects on its own; this is only so a persistent failure is
    // visible in the console rather than looking like a store that never changes.
    _source.addEventListener('error', () => {
        if (_source?.readyState === EventSource.CLOSED) {
            log.warn?.('[bugdesk] live update stream closed');
        }
    });

    return { close: closeLiveUpdates };
}

export function closeLiveUpdates() {
    try { _source?.close(); } catch { /* already gone */ }
    _source = null;
}

/** Did this event touch this record? */
export function eventTouches(payload, store, id) {
    return (payload?.changed || []).some(
        (c) => c.store === store && Number(c.id) === Number(id));
}

/** Was this record deleted out from under us? */
export function eventDeleted(payload, store, id) {
    return (payload?.changed || []).some(
        (c) => c.store === store && Number(c.id) === Number(id) && c.deleted);
}

/**
 * Keep one open record page honest about its file.
 *
 * @param {object}   o
 * @param {HTMLElement} o.host      the page element; the banner mounts at its top
 * @param {string}   o.store        'bugs' | 'backlog'
 * @param {() => number} o.id       the record id, read late (a page can be retyped)
 * @param {() => boolean} o.isDirty does the page hold unsaved edits?
 * @param {Function} o.onReload     re-fetch and re-render from disk
 * @param {Function} [o.onStatus]   report a line to the user
 * @param {object}   o.eventBus
 * @returns {{ dispose(): void, clear(): void }}
 */
export function watchRecord({ host, store, id, isDirty, onReload, onStatus, eventBus }) {
    let banner = null;

    const clear = () => { banner?.remove(); banner = null; };

    const show = (deleted) => {
        clear();
        banner = document.createElement('div');
        banner.className = 'bd-conflict';
        banner.innerHTML = deleted
            ? `<span class="material-symbols-outlined">delete_forever</span>
               <span class="bd-conflict__text">
                   This record was <b>deleted</b> outside BugDesk. Your unsaved edits are still here;
                   saving will write the file again.
               </span>
               <button type="button" class="ea-btn" data-conflict="keep">Keep my edits</button>`
            : `<span class="material-symbols-outlined">sync_problem</span>
               <span class="bd-conflict__text">
                   This record changed outside BugDesk while you were editing it.
               </span>
               <button type="button" class="ea-btn" data-conflict="reload">Discard mine, reload</button>
               <button type="button" class="ea-btn" data-conflict="keep">Keep my edits</button>`;

        banner.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-conflict]')?.dataset.conflict;
            if (act === 'reload') {
                clear();
                await onReload?.();
                onStatus?.('Reloaded from disk — your unsaved edits were discarded.');
            } else if (act === 'keep') {
                clear();
                // Nothing is written here: the user is choosing to let their
                // next Save be the one that wins. Saying so is the whole point —
                // an overwrite the user did not know was an overwrite is the
                // thing this feature exists to prevent.
                onStatus?.('Keeping your edits. Saving will overwrite the version on disk.');
            }
        });
        host.insertBefore(banner, host.firstChild);
    };

    const onChange = async (payload) => {
        const rid = id();
        if (!rid || !eventTouches(payload, store, rid)) return;
        if (eventDeleted(payload, store, rid)) { show(true); return; }

        if (isDirty?.()) { show(false); return; }
        // Nothing to lose — take the new version without asking. This is the
        // common case by a wide margin: you are reading, an agent commented.
        clear();
        await onReload?.();
        onStatus?.('Updated from disk.');
    };

    const sub = eventBus?.on?.('store:changed', onChange);
    return {
        clear,
        dispose: () => { sub?.dispose?.(); clear(); },
    };
}

export { esc };
