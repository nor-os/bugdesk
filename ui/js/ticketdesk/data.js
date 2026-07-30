/**
 * ticketdesk/data.js — BugDesk domain data.
 *
 * The data is fetched live from the BugDesk bridge (same-origin JSON API):
 *
 *   GET  /api/bugs            -> summary list (incl. lastCommentAuthor/Date)
 *   GET  /api/bugs/{id}       -> full bug (description + comments)
 *   POST /api/bugs/{id}       -> patch frontmatter (assignee derived server-side)
 *   POST /api/bugs/{id}/comments -> append a comment
 *   GET  /api/meta            -> aggregate counts
 *
 * TICKETS / TEAM are exported with `let` and REASSIGNED by loadData();
 * ES-module live bindings mean every importer sees the populated arrays
 * as long as it reads them at call time. loadData() is awaited before the
 * first page renders (install.js does this before registering the pages).
 */

import { getSetting } from '../core/settings.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function now() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* Lifecycle stage chevrons. Index === bug.stage:
   0 open · 1 investigation · 2 testing · 3 closed. */
export const STAGES = ['Open', 'Investigation', 'Testing', 'Closed'];

/* The two configured roles — a human (files/triages/tests through this UI)
 * and an agent (investigates, typically via the /bugs skill).
 *
 * Resolution order, highest precedence first:
 *   1. the settings store's `bugdesk.humanName` / `bugdesk.agentName` — a
 *      per-browser override set from Settings → General → Authorship
 *      (core/settings.js), non-empty string wins.
 *   2. window.__BUGDESK_CONFIG__ — index.html populates this from
 *      GET /api/config before this module (or anything that imports it) is
 *      ever evaluated, so it's already resolved by the time we read it here.
 *   3. the hardcoded generic fallback ('reviewer' / 'agent').
 *
 * Both are still plain consts evaluated ONCE at module load — same
 * reasoning as the original config-prefetch design (see filters.js's
 * BUILTIN_FILTERS/FILTER_FIELDS, which embed these values into object
 * literals built at that same load time) — so a settings change here only
 * takes effect on the next reload; settings_page.js's `reloadHint` flag on
 * both schema entries says so in the UI. */
const _cfg = (typeof window !== 'undefined' && window.__BUGDESK_CONFIG__) || {};
export const HUMAN_AUTHOR = getSetting('bugdesk.humanName') || _cfg.humanAuthor || 'reviewer';
export const AGENT_AUTHOR = getSetting('bugdesk.agentName') || _cfg.agentAuthor || 'agent';

/* ── status / type humanisation ─────────────────────────────────── */

const STATUS_LABEL = {
    'open': 'Open',
    'investigation': 'Investigation',
    'testing': 'Testing',
    'closed': 'Closed',
};
const STATUS_MACHINE = Object.fromEntries(
    Object.entries(STATUS_LABEL).map(([k, v]) => [v, k]));

export const humanizeStatus = (s) => STATUS_LABEL[s]
    || String(s || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const machineStatus = (label) => STATUS_MACHINE[label]
    || String(label || '').toLowerCase().replace(/\s+/g, '-');

const TYPE_CODE = { bug: 'BUG', regression: 'REG', task: 'TASK' };
const TYPE_LABEL = { BUG: 'Bug', REG: 'Regression', TASK: 'Task' };
const TYPE_MACHINE = { Bug: 'bug', Regression: 'regression', Task: 'task' };
export const typeCode = (t) => TYPE_CODE[t] || 'TASK';
export const typeLabelOf = (code) => TYPE_LABEL[code] || 'Task';
export const machineType = (label) => TYPE_MACHINE[label] || String(label || '').toLowerCase();

/* A bug is "closed" only in the closed state. */
export const isClosed = (t) => t.rawStatus === 'closed';

export function initials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const parts = s.split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
}

/* ── bridge client (same-origin) ────────────────────────────────── */

async function apiGet(path) {
    const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}
async function apiPost(path, body) {
    const res = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
    return res.json();
}

/** Full bug (description markdown + comments thread). */
export async function fetchBug(id) {
    const j = await apiGet(`/bugs/${id}`);
    if (!j.ok) throw new Error(j.error || 'not found');
    return j.bug;
}
/** Patch frontmatter (status/severity/subsystem/type/title/labels).
 *  assignee is derived from status by the bridge — don't send it. */
export async function patchBug(id, patch) {
    const j = await apiPost(`/bugs/${id}`, patch);
    if (!j.ok) throw new Error(j.error || 'update failed');
    return j.bug;
}
/** Create a new bug. The ID is assigned automatically by the bridge — never sent. */
export async function createBug(fields) {
    const j = await apiPost('/bugs', fields);
    if (!j.ok) throw new Error(j.error || 'create failed');
    return j.bug;
}
/** Append a comment. author defaults to HUMAN_AUTHOR — this UI is the human's. */
export async function postComment(id, body, author = HUMAN_AUTHOR) {
    const j = await apiPost(`/bugs/${id}/comments`, { author, body });
    if (!j.ok) throw new Error(j.error || 'comment failed');
    return j.bug;
}

/* ── live store (populated by loadData) ─────────────────────────── */

export let TICKETS = [];
export let TEAM = [];

/** Map a bridge bug-summary onto the ticket shape the pages expect.
 *  There is NO SLA in BugDesk, so the "SLA" column carries `updated`. */
function mapBug(b) {
    return {
        id: `#${b.id}`,          // display id (routing key)
        bugId: b.id,             // numeric id (for /api/bugs/{id} calls)
        pri: b.pri,              // 1..4 from severity (crash/high/medium/low)
        type: typeCode(b.type),  // BUG | REG | TASK
        summary: b.title,
        status: humanizeStatus(b.status),
        rawStatus: b.status,
        assignee: b.assignee || HUMAN_AUTHOR,
        stage: b.stage,          // 0..3 → STAGES chevrons
        subsystem: b.subsystem || 'unsorted',
        severity: b.severity,
        labels: Array.isArray(b.labels) ? b.labels : [],
        // Relationships to other bugs ("blocks 47"). Only this bug's own side —
        // see links.js for why the inverse is derived rather than stored.
        links: Array.isArray(b.links) ? b.links : [],
        created: b.created || '',
        sla: b.updated || '',    // no SLA concept — show `updated`
        comments: b.comments || 0,
        // Fields that power the left filter rail's "needs my reply".
        lastCommentAuthor: b.lastCommentAuthor || null,
        lastCommentDate: b.lastCommentDate || null,
    };
}

/** Fetch /api/bugs + /api/meta and (re)populate the live store. */
export async function loadData() {
    const [bugsRes, metaRes] = await Promise.all([apiGet('/bugs'), apiGet('/meta')]);
    const bugs = Array.isArray(bugsRes.bugs) ? bugsRes.bugs : [];
    TICKETS = bugs.map(mapBug);

    const byAssignee = metaRes.byAssignee || {};

    // TEAM: one row per assignee. `inc` = open bugs,
    // `other` = closed, `load` = open relative to the busiest assignee.
    const openByAssignee = {}, closedByAssignee = {};
    for (const t of TICKETS) {
        const a = t.assignee || HUMAN_AUTHOR;
        if (isClosed(t)) closedByAssignee[a] = (closedByAssignee[a] || 0) + 1;
        else openByAssignee[a] = (openByAssignee[a] || 0) + 1;
    }
    const names = Object.keys(byAssignee).length
        ? Object.keys(byAssignee)
        : Array.from(new Set(TICKETS.map((t) => t.assignee)));
    const maxOpen = Math.max(1, ...names.map((n) => openByAssignee[n] || 0));
    TEAM = names.sort().map((name) => {
        const inc = openByAssignee[name] || 0;
        const other = closedByAssignee[name] || 0;
        const presence = inc > 0 ? 'online' : 'away';
        return {
            name,
            initials: initials(name),
            presence,
            inc,
            other,
            load: Math.round((inc / maxOpen) * 100) / 100,
            me: name.toLowerCase() === HUMAN_AUTHOR.toLowerCase(),
        };
    });

    return { count: bugs.length };
}
