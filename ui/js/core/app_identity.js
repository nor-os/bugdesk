/**
 * app_identity.js — which product this window is: BugDesk, or TicketDesk.
 *
 * One server, two products, and the SERVER decides which: started with
 * `--tracker` it is TicketDesk, otherwise it is BugDesk — always, including on
 * the tracker's own page (/t/) and the Tracker section inside a project. The
 * bridge reports it as `app` in /api/config. Everything user-visible that names
 * the app goes through here, so the two can never disagree within one window.
 *
 * Read lazily, at call time, not at module load: boot.js (and everything it
 * imports) is evaluated BEFORE index.html has resolved the config, so a
 * module-level constant would always say BugDesk. The first-run prompt runs
 * before the config exists at all, so it passes the app in.
 */

const currentApp = () =>
    (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__?.app) || 'bugdesk';

/** "BugDesk" or "TicketDesk". */
export function appName(app = currentApp()) {
    return app === 'ticketdesk' ? 'TicketDesk' : 'BugDesk';
}

/** 'bugdesk' or 'ticketdesk' — a CSS hook for per-product styling (the wordmark font). */
export function appSlug(app = currentApp()) {
    return app === 'ticketdesk' ? 'ticketdesk' : 'bugdesk';
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
export function appIcon(app = currentApp()) {
    return app === 'ticketdesk' ? 'assets/icons/ticketdesk-glyph.svg' : 'assets/icons/bugdesk-glyph.svg';
}
