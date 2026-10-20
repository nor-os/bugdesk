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
 *
 * The config is THIS COPY'S (core/page_config.js): the page's own on BugDesk's
 * page, the one fetched from the copy's own API when embedded in another
 * application, where the page-wide global is not BugDesk's to read.
 */

import { pageConfig } from './page_config.js';

const currentApp = () => pageConfig().app || 'bugdesk';

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
    const store = pageConfig().store;
    if (!store) return true;
    return half === 'bugs' ? store.hasBugs !== false : store.hasBacklog !== false;
}

/**
 * Why this project page has no Tracker, in a sentence, or null when it has one
 * or there is none to have (STORY-0043). Two switches can hide it: the
 * person's own (Settings › You › Behaviour, `switchedOff`) and the machine's
 * (`[tracker] enabled = false` in projects.toml, `machineOff`). Said the same
 * way wherever a tracker page or tile would have been.
 */
export function trackerOffReason() {
    const t = pageConfig().tracker;
    if (!t || t.available) return null;
    if (t.machineOff) return 'The Tracker is switched off for this machine: enabled = false under [tracker] in projects.toml.';
    if (t.switchedOff) return 'The Tracker is switched off for you. Switch it back on under Settings › You › Behaviour › Tracker.';
    return null;
}

/** The small badge used for the top bar and the favicon, relative to ui/. */
export function appIcon(app = currentApp()) {
    return app === 'ticketdesk' ? 'assets/icons/ticketdesk-glyph.svg' : 'assets/icons/bugdesk-glyph.svg';
}
