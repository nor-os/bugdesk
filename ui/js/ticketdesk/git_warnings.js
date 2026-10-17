/**
 * ticketdesk/git_warnings.js — say so when a store's records are not backed up
 * (STORY-0049).
 *
 * Records are shared, and backed up, only once they are committed and pushed.
 * Two conditions stop that, and each gets a warning of its own:
 *
 *   no-repo    the store is not in a git repository at all — the tracker's
 *              default, since it lives outside every repo (%APPDATA%\BugDesk,
 *              ~/.bugdesk). Offered: Initialize git.
 *   no-remote  it is in a repository that has no remote at all, so commits
 *              never leave this computer. Offered: Add remote….
 *
 * A branch that merely has no upstream is NOT warned about: the repository has
 * somewhere to push, and the Changes pane's "No remote branch" line says the
 * rest, as it always has.
 *
 * BugDesk never runs `git init` or adds a remote by itself — both happen only
 * when somebody presses the button, here, in the Changes pane or in Settings ›
 * Git (the bridge's /git/init and /git/remote).
 *
 * THE WARNING is a sticky toast on FlexDesk's NotificationCenter, the one the
 * alert rules use (alerts.js), shown when BugDesk opens and again whenever a
 * `git` event moves the store into a condition it was not warned about in this
 * session. × closes it until BugDesk opens again. "Don't warn again" closes it
 * for good, for this store and this person: the dismissed condition is saved in
 * the person's state for the store (`git-warnings.json`, beside the layout —
 * never project.json). A dismissal names ONE condition, so it is cleared the
 * moment the store is fine or in the other condition, and a recurrence warns
 * again. A warning whose condition has gone (Initialize git pressed in the
 * Changes pane, say) is closed, through its own × so FlexDesk keeps its history.
 *
 * One copy per store, like the rest of this directory (instance.js): a project
 * page that shows the tracker warns for each of the two on its own.
 */

import { CONFIG, IS_TRACKER_COPY, apiUrl, ev } from './instance.js';

export const WARN_FILE = 'git-warnings.json';

/**
 * Which warning a store's `/git` state calls for: 'no-repo', 'no-remote', or
 * null — fine, or not known (the bridge could not be asked).
 * @param {object|null} state
 */
export function gitCondition(state) {
    if (!state?.ok) return null;
    if (!state.enabled) return 'no-repo';
    return Array.isArray(state.remotes) && state.remotes.length === 0 ? 'no-remote' : null;
}

/**
 * Should `condition` be warned about, given what was dismissed for good? And
 * what is dismissed afterwards: a dismissal outlives only the condition it
 * names, so a store that is fine, or in the other condition, clears it.
 * @param {string|null} condition
 * @param {string|null} dismissed
 * @returns {{ warn: boolean, dismissed: string|null }}
 */
export function decideWarning(condition, dismissed) {
    if (!condition) return { warn: false, dismissed: null };
    if (dismissed === condition) return { warn: false, dismissed };
    return { warn: true, dismissed: null };
}

/** A remote URL the bridge would accept: not empty, no spaces, no leading `-`. */
export function remoteUrlProblem(url) {
    const u = String(url ?? '').trim();
    if (!u) return 'A remote needs a URL.';
    if (u.startsWith('-') || /[\s\u0000-\u001f]/.test(u)) return 'A remote URL may not contain spaces or start with "-".';
    return null;
}

async function post(api, path, body = {}) {
    const res = await fetch(api(path), {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    return j;
}

/** `git init` in the store's folder. Resolves the store's new `/git` state. */
export const initRepo = (api = apiUrl) => post(api, '/git/init');

/**
 * Ask for a URL and add it as `origin`. Resolves the store's new `/git` state,
 * or null when the prompt was cancelled; rejects with the bridge's reason.
 */
export async function promptRemote(api = apiUrl) {
    const { openForm } = await import('@flexdesk/widgets');
    const r = await openForm({
        title: 'Add remote', submitLabel: 'Add remote',
        fields: [{
            name: 'url', label: 'Remote URL', type: 'text', required: true,
            hint: 'Added as origin, e.g. git@github.com:me/records.git or https://…/records.git',
            validator: (v) => remoteUrlProblem(v),
        }],
    });
    if (!r) return null;
    return post(api, '/git/remote', { url: String(r.url).trim() });
}

/** This copy's store, as a warning's title names it. */
export function storeTitle() {
    if (IS_TRACKER_COPY || CONFIG.store?.kind === 'tracker') return 'The tracker';
    return CONFIG.store?.name ? `Project ${CONFIG.store.name}` : 'This project';
}

async function readDismissed() {
    try {
        const res = await fetch(apiUrl('/workspace_state_read'), {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ path: WARN_FILE }),
        });
        const j = await res.json().catch(() => null);
        const saved = j?.result ? JSON.parse(j.result) : null;
        return typeof saved?.dismissed === 'string' ? saved.dismissed : null;
    } catch {
        return null;
    }
}

function writeDismissed(dismissed) {
    return fetch(apiUrl('/workspace_state_write'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: WARN_FILE, data: JSON.stringify({ dismissed }) }),
    }).catch((err) => console.warn('[bugdesk] the git warning dismissal could not be saved', err));
}

let _bus = null;
let _installed = false;
let _warned = null;        // the condition this session has shown a toast for
let _dismissed;            // undefined until read

const toast = (o) => _bus?.emit?.('toast:show', { namespace: 'git', ...o });

/** The warning's notification id: one per store copy and condition. */
const warningId = (condition) => `bugdesk-git-${IS_TRACKER_COPY ? 'tracker' : 'page'}-${condition}`;

/** Close a warning still on screen whose condition has gone. The bus has no
 *  "dismiss", so press its ×, which is FlexDesk's own way out. */
function closeWarning(condition) {
    if (typeof document === 'undefined') return;
    document.querySelector(`[data-notification-id="${warningId(condition)}"] .twm-notification__close`)?.click();
}

/** A sticky warning on FlexDesk's NotificationCenter, under a known id. */
const sticky = (condition, o) => _bus?.emit?.('notification:show', {
    id: warningId(condition), namespace: 'git', severity: 'warn', persistent: true, ...o,
});

/** Press a button: tell the person how it went, and let every git view redraw. */
async function act(run, done) {
    try {
        const state = await run();
        if (!state) return;
        toast({ type: 'success', message: done(state) });
        _bus?.emit?.(ev('git:changed'), {});
    } catch (err) {
        toast({ type: 'error', title: storeTitle(), message: err.message, persistent: true });
    }
}

/** Initialize git, with a toast either way. */
export const initRepoAndSay = () => act(() => initRepo(),
    (s) => `Initialized a git repository in ${s.root || s.home}. Commit the records in the Changes tab to start their history.`);

/** Add remote…, with a toast either way. */
export const addRemoteAndSay = () => act(() => promptRemote(),
    (s) => `Added the remote ${(s.remotes || [])[0] || 'origin'}. Push from the Changes tab.`);

function warn(condition, state) {
    const forGood = {
        label: "Don't warn again",
        handler: () => { _dismissed = condition; writeDismissed(condition); },
    };
    if (condition === 'no-repo') {
        sticky(condition, {
            title: `${storeTitle()} is not in a git repository`,
            message: `Its records in ${state.home || 'its folder'} have no history and no backup: nothing commits or pushes them.`,
            actions: [{ label: 'Initialize git', handler: () => initRepoAndSay() }, forGood],
        });
    } else {
        sticky(condition, {
            title: `${storeTitle()} has no git remote`,
            message: `The repository at ${state.root} has no remote, so commits stay on this computer: nothing is shared or backed up.`,
            actions: [{ label: 'Add remote…', handler: () => addRemoteAndSay() }, forGood],
        });
    }
}

/** Ask the bridge, and warn when the store is in a condition not yet warned
 *  about this session and not dismissed for good. */
export async function checkGitWarnings() {
    let state = null;
    try {
        const res = await fetch(apiUrl('/git'), { headers: { accept: 'application/json' } });
        state = await res.json().catch(() => null);
    } catch { /* no bridge: nothing to say */ }
    const condition = gitCondition(state);
    if (!state?.ok) return null;
    if (_dismissed === undefined) _dismissed = await readDismissed();
    const next = decideWarning(condition, _dismissed);
    if (next.dismissed !== _dismissed) { _dismissed = next.dismissed; writeDismissed(next.dismissed); }
    if (condition !== _warned) {
        if (_warned) closeWarning(_warned);
        _warned = null;
    }
    if (next.warn && _warned !== condition) { _warned = condition; warn(condition, state); }
    return condition;
}

/**
 * Check once now, and again after every `git` event for this store (a commit,
 * a push, Initialize git, Add remote…). Called once the toasts are up (install.js).
 * @param {object} o
 * @param {object} o.eventBus
 */
export async function installGitWarnings({ eventBus } = {}) {
    if (_installed) return;
    _installed = true;
    _bus = eventBus || null;
    let timer = null;
    eventBus?.on?.(ev('git:changed'), () => {
        clearTimeout(timer);
        timer = setTimeout(() => checkGitWarnings().catch(() => {}), 300);
    });
    await checkGitWarnings();
}

/** For tests: forget this session's state. */
export function _resetGitWarnings() {
    _bus = null; _installed = false; _warned = null; _dismissed = undefined;
}
