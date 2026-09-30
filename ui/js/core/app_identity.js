/**
 * app_identity.js — which product this window is: BugDesk, or TicketDesk.
 *
 * One server, two products. `--tracker` starts the follow-up tracker, and to
 * the person using it that is TicketDesk — its own name, its own icon — not a
 * BugDesk in a different mode. Everything user-visible that names the app goes
 * through here, so the two can never disagree within one window.
 *
 * Both read the mode lazily, at call time, not at module load: boot.js (and
 * everything it imports) is evaluated BEFORE index.html has resolved the
 * config, so a module-level constant would always say BugDesk. The first-run
 * prompt runs before the config exists at all, so it passes the mode in.
 */

const currentMode = () =>
    (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__?.mode) || 'bugs';

/** "BugDesk" or "TicketDesk". */
export function appName(mode = currentMode()) {
    return mode === 'tracker' ? 'TicketDesk' : 'BugDesk';
}

/** 'bugdesk' or 'ticketdesk' — a CSS hook for per-product styling (the wordmark font). */
export function appSlug(mode = currentMode()) {
    return mode === 'tracker' ? 'ticketdesk' : 'bugdesk';
}

/**
 * Whether this page's store has its bugs or its backlog half. A project in
 * projects.toml may name only one of them, and the page for the other must then
 * not be offered at all — not as a chip, not as a type to file, not as Home.
 * True when the bridge said nothing (an older server): both, as always.
 *
 * @param {'bugs'|'backlog'} half
 */
export function storeHas(half) {
    const store = typeof window !== 'undefined' ? window.__BUGDESK_CONFIG__?.store : null;
    if (!store) return true;
    return half === 'bugs' ? store.hasBugs !== false : store.hasBacklog !== false;
}

/** The small badge used for the top bar and the favicon, relative to ui/. */
export function appIcon(mode = currentMode()) {
    return mode === 'tracker' ? 'assets/icons/ticketdesk-glyph.svg' : 'assets/icons/bugdesk-glyph.svg';
}
