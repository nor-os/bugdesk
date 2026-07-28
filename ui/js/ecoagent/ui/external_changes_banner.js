/**
 * external_changes_banner.js — surfaces edits made to project files
 * outside the app.
 *
 * Background: the Bridge holds the project's in-memory state as a
 * mirror of `<project>/*.json` + `<project>/agents/*.py`. Edits made
 * through the app's editors keep the mirror in sync. Edits made from
 * a text editor, `git pull`, or any other tool DON'T — the mirror
 * goes stale silently until `project_reload()` runs.
 *
 * This watcher polls `external_file_changes` every 5 s. When the
 * Bridge reports a non-empty diff it shows a small banner at the top
 * of the page: "<N> project files changed on disk — [Reload] [×]".
 * Clicking Reload calls `project_reload`; dismissing hides the banner
 * until the next change is detected.
 *
 * No background thread, no `watchdog` dependency — the polling is
 * cheap (`os.stat` per file, no I/O beyond that) and the cadence is
 * well below human reaction time for "I edited a file and want it
 * picked up".
 */

const POLL_MS = 5_000;

export function installExternalChangesBanner({ api, eventBus } = {}) {
    if (!api?.external_file_changes) {
        return { stop: () => {} };
    }
    const banner = document.createElement('div');
    banner.className = 'ea-ext-banner';
    banner.hidden = true;
    document.body.appendChild(banner);

    let lastSummary = null;
    let timerId    = null;

    const tick = async () => {
        let res = null;
        try { res = await api.external_file_changes(); } catch { return; }
        if (!res || res.ok === false) return;
        const changed = res.changed?.length || 0;
        const added   = res.added?.length   || 0;
        const removed = res.removed?.length || 0;
        const total   = changed + added + removed;
        if (total === 0) {
            banner.hidden = true;
            lastSummary = null;
            return;
        }
        // Build a stable summary so repeat polls don't re-render
        // identically while the user is reading the banner.
        const summary = `${total} project file${total === 1 ? '' : 's'} changed on disk`
            + (removed > 0 ? ` (${removed} removed)` : '')
            + (added > 0   ? ` (${added} added)`     : '');
        if (summary === lastSummary && !banner.hidden) return;
        lastSummary = summary;
        banner.innerHTML = `
            <span class="material-symbols-outlined ea-ext-banner__icon">sync</span>
            <span class="ea-ext-banner__msg">${_esc(summary)}</span>
            <button type="button" class="ea-ext-banner__btn"
                    data-action="reload">Reload</button>
            <button type="button" class="ea-ext-banner__close"
                    data-action="dismiss" title="Dismiss">
                <span class="material-symbols-outlined">close</span>
            </button>
        `;
        banner.hidden = false;
        banner.querySelector('[data-action="reload"]')
            ?.addEventListener('click', async () => {
                try { await api.project_reload?.(); } catch { /* ignore */ }
                banner.hidden = true;
                lastSummary = null;
                eventBus?.emit?.('ecoagent:project:changed',
                    { source: 'external-reload' });
            });
        banner.querySelector('[data-action="dismiss"]')
            ?.addEventListener('click', () => {
                banner.hidden = true;
                lastSummary = null;
            });
    };

    // Kick off the first call immediately so the bridge establishes
    // its mtime baseline; then poll on a 5s cadence.
    tick();
    timerId = setInterval(tick, POLL_MS);

    return {
        stop: () => {
            if (timerId != null) clearInterval(timerId);
            timerId = null;
            try { banner.remove(); } catch { /* already detached */ }
        },
    };
}

function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
