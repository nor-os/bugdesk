/**
 * core/page_config.js — which BugDesk this copy of the modules belongs to, and
 * what that BugDesk said about itself.
 *
 * ON BUGDESK'S OWN PAGE nothing here is new. index.html fetches `api/config`,
 * shapes it (`shapePageConfig` below) and publishes it as
 * `window.__BUGDESK_CONFIG__` before any module that reads it is imported, and
 * every API call is RELATIVE, so it follows whatever prefix the page was served
 * under (/p/<name>/, /t/). `pageConfig()` simply hands that object back, read at
 * call time, exactly as the modules used to read the global themselves.
 *
 * EMBEDDED, in another FlexDesk application (EPIC-0051), both are wrong: the
 * document is the host's page, so `api/…` would go to the host's server, and
 * there is no page-wide config — or worse, two projects' copies imported into
 * the same page, which one global could never describe. So a copy takes both
 * from ITS OWN URL instead. This file lives at `<root>/js/core/`, so `<root>` —
 * `/p/<name>/` of the BugDesk that served it, behind whatever proxy prefix — is
 * two levels up; the API is `<root>/api`, and the config is fetched from there
 * with a top-level await, so no module that imports this one (and that is every
 * module that reads config) is evaluated before the copy knows who it is.
 *
 * A copy counts as embedded when there is no page-wide config AND the page is
 * not the copy's own root. Both halves matter: BugDesk's own index.html imports
 * modules that end up here BEFORE it has published the config (app_identity.js,
 * the first-run gate), and those must not go and fetch a second one; and the
 * jsdom tests load the modules from files under an http document, with a config
 * published, and must stay a BugDesk page.
 *
 * Each project prefix loads its own copy of this module (a different URL is a
 * different module instance), so all the state in here — the config, the kind
 * prefix — is per project. The tracker's copy of ticketdesk/ (`ticketdesk@t/`)
 * resolves `../core/` to the same URL as the page's copy, and shares it.
 *
 * Imports nothing, so anything may import it without a cycle.
 */

/** The copy's own root: `<server>/p/<name>/`, `<server>/t/`, or `<server>/`. */
export const COPY_ROOT = new URL('../../', import.meta.url).href;

const pageDir = () => (typeof document !== 'undefined' && document.baseURI
    ? new URL('./', document.baseURI).href : null);

/** True when this copy was imported into somebody else's page. */
export const EMBEDDED = typeof window !== 'undefined'
    && !window.__BUGDESK_CONFIG__
    && pageDir() !== null && pageDir() !== COPY_ROOT;

/** The API of the store this copy was served for. Relative on BugDesk's own
 *  page, as it always was; absolute, from the module's URL, when embedded. */
export const API_BASE = EMBEDDED ? new URL('api', COPY_ROOT).href : 'api';

/** The tracker's API. Always at /t/ of the same server: on BugDesk's own page
 *  that is the absolute `/t/api`, embedded it is beside `p/<name>/` of the URL
 *  the copy came from — which keeps a proxy prefix in front of it. */
export const TRACKER_API_BASE = EMBEDDED
    ? new URL('t/api', COPY_ROOT.replace(/\/(?:p\/[^/]+|t)\/$/, '/')).href
    : '/t/api';

const join = (base, path) => `${base}${String(path).startsWith('/') ? '' : '/'}${path}`;

/** A path under this copy's API — `pageApiUrl('/config')`. */
export const pageApiUrl = (path) => join(API_BASE, path);

/** A path under the tracker's API, as this copy reaches it. */
export const trackerApiUrl = (path) => join(TRACKER_API_BASE, path);

/**
 * The page config, from a `GET api/config` payload. ONE shape, whoever builds
 * it: index.html for BugDesk's own page, this module for an embedded copy.
 * Every field is read at module load somewhere (named below), which is why the
 * whole object has to exist before those modules are evaluated.
 */
export function shapePageConfig(cfg = {}) {
    return {
        // Which app this is: 'bugs' (default) or 'tracker'. Read at module
        // load by kind_taxonomy.js (which top-nav chips exist) and by
        // ticketdesk/backlog_data.js (which types are offered).
        mode: cfg.mode === 'tracker' ? 'tracker' : 'bugs',
        // Which PRODUCT: TicketDesk only when the server was started with
        // --tracker; BugDesk otherwise, whatever store this page is on.
        // See core/app_identity.js.
        app: cfg.app === 'ticketdesk' ? 'ticketdesk' : 'bugdesk',
        // The build serving this window, for the About dialog (boot.js).
        version: cfg.version || '',
        commit: cfg.commit || '',
        // Whether `<name>_agent` is assignable here — false in tracker mode.
        agentsAssignable: cfg.agentsAssignable !== false,
        // True when the names below came from the bridge, not the fallback.
        fromBridge: cfg.ok === true,
        humanAuthor: cfg.humanAuthor || 'reviewer',
        agentAuthor: cfg.agentAuthor || 'agent',
        // The shared roster (bugdesk.json). Every assignee picker reads it,
        // so it has to be resolved before the modules that build those
        // pickers are evaluated — same reason as the two names above.
        collaborators: Array.isArray(cfg.collaborators) ? cfg.collaborators : [],
        assignees: Array.isArray(cfg.assignees) ? cfg.assignees : [],
        // The store this page is on — a project, or the tracker — and the
        // ones around it. The address says which (/p/<name>/, /t/); the
        // bridge says what that store has, since a project may have only
        // bugs or only a backlog.
        store: cfg.store || null,
        // Custom fields, hidden built-ins and custom statuses per record type
        // (project.json's `schema`). Read at module load by ticketdesk/schema.js.
        schema: cfg.schema || null,
        // The move tables, their flows and the custom actions (workflow.js).
        workflow: cfg.workflow || null,
        // Prefixes, padding, and every prefix still read (refs.js).
        numbering: cfg.numbering || null,
        // Auto-save and git (autosave.js, changes_pane.js).
        saving: cfg.saving || null,
        // Alert rules (alerts.js).
        alerts: Array.isArray(cfg.alerts) ? cfg.alerts : [],
        projects: Array.isArray(cfg.projects) ? cfg.projects : [],
        tracker: cfg.tracker || { available: false },
    };
}

/** The tracker copy's config, from the tracker's own `GET /t/api/config`: its
 *  roster, and the name the person uses everywhere (see tiling/install.js). */
export function shapeTrackerConfig(cfg = {}) {
    return {
        mode: 'tracker',
        agentsAssignable: false,
        fromBridge: true,
        humanAuthor: cfg.humanAuthor || 'reviewer',
        agentAuthor: cfg.agentAuthor || 'agent',
        collaborators: Array.isArray(cfg.collaborators) ? cfg.collaborators : [],
        assignees: Array.isArray(cfg.assignees) ? cfg.assignees : [],
        store: cfg.store || { kind: 'tracker', hasBugs: false, hasBacklog: true },
        schema: cfg.schema || null,
        workflow: cfg.workflow || null,
        numbering: cfg.numbering || null,
        saving: cfg.saving || null,
        alerts: Array.isArray(cfg.alerts) ? cfg.alerts : [],
        tracker: cfg.tracker || { available: true },
    };
}

/** GET `<api>/config`, or a clear error naming the address that failed. An
 *  embedded copy with no config would render somebody else's defaults — every
 *  comment signed `reviewer` — so a failure here fails the import instead. */
export async function fetchConfig(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const cfg = await res.json().catch(() => null);
    if (!res.ok || !cfg?.ok) throw new Error(cfg?.error || `GET ${url} → ${res.status}`);
    return cfg;
}

const OWN = EMBEDDED ? shapePageConfig(await fetchConfig(pageApiUrl('/config'))) : null;

/**
 * The config of the page this copy belongs to — read at CALL time on BugDesk's
 * own page, because index.html publishes it after the first of these modules
 * are evaluated, and the first-run gate re-points it later (first_run.js).
 */
export function pageConfig() {
    if (OWN) return OWN;
    return (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__) || {};
}

/* ── content kinds, namespaced for a host ────────────────────────────
 *
 * BugDesk's kinds are plain words — `queues`, `ticket`, `backlog`, `item` — and
 * its saved layouts name them, so they cannot change. Two projects mounted in one
 * host shell would register the same words, and the second would overwrite the
 * first. So a host passes a PREFIX (createTicketDeskContent's `kindPrefix`):
 * this copy's kinds are registered and opened as `<prefix><kind>`, and the
 * events it puts on the host's bus are `<prefix><event>`, while every module of
 * the copy goes on using the plain names among themselves. On BugDesk's own
 * page the prefix is '' and every name is what it always was.
 */
let PREFIX = '';

/** Set once, before the copy's content is built. A second, DIFFERENT prefix
 *  is refused: kinds already handed to a WM would stop matching. */
export function setKindPrefix(prefix = '') {
    const next = String(prefix ?? '');
    if (next === PREFIX) return;
    if (PREFIX) throw new Error(`BugDesk at ${COPY_ROOT} is already namespaced as '${PREFIX}', not '${next}'`);
    PREFIX = next;
}

/** The prefix in force: '' on BugDesk's own page. */
export const kindPrefix = () => PREFIX;

/* A FlexDesk WM knows a panel — the filter rail, the inspector — by nothing but
 * the leading `panel:` of its kind (wm.js `_isPanel`, `primaryLeafId`, the tile
 * chrome, Backspace). So the prefix goes AFTER that marker, not before it:
 * `panel:left` is `panel:<prefix>left`, and stays chrome to the host's WM. A
 * `<prefix>panel:left` would be content, the rail would become the "primary"
 * tile once clicked, and its own openInPrimary would replace it with the list. */
const PANEL = 'panel:';

/** A kind of this copy as the host's WM knows it. Idempotent. */
export const nsKind = (kind) => {
    if (!PREFIX || !kind || localKind(kind) !== null) return kind;
    const k = String(kind);
    return k.startsWith(PANEL) ? `${PANEL}${PREFIX}${k.slice(PANEL.length)}` : `${PREFIX}${k}`;
};

/** A kind from the host's WM as this copy knows it — or null when it is not
 *  one of this copy's (another project's, or the host's own). */
export function localKind(kind) {
    if (!kind) return null;
    if (!PREFIX) return kind;
    const k = String(kind);
    if (k.startsWith(PREFIX)) return k.slice(PREFIX.length);
    if (k.startsWith(PANEL + PREFIX)) return PANEL + k.slice(PANEL.length + PREFIX.length);
    return null;
}
