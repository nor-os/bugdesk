/**
 * ticketdesk/alerts.js — tell me when a record starts matching something.
 *
 * A RULE (Settings › Alerts, `alerts` in project.json) is a name, a store, a
 * condition — an expression from the filter editor, over any field, custom ones
 * included — a level (info, warning, alert) and how it shows: in the bottom
 * panel's Alerts tab always, and optionally as a toast, which may be sticky
 * (it closes only with ×).
 *
 * A rule FIRES WHEN A RECORD STARTS TO MATCH, not again while it keeps
 * matching. The page keeps each rule's set of matching records; after every
 * change to a store — somebody's edit in this page, an agent's edit to a file,
 * a `git pull`, reaching the page as a server event (live.js) within a second
 * or two — it compares the new set with the old, and only the newcomers alert.
 * When BugDesk opens it takes the current set as the starting point: changes
 * made while it was closed do not alert, and Settings says so.
 *
 * THE LOG is per user and per store: every alert raised, newest last, at most
 * LOG_LIMIT, saved through the bridge's per-user state (`alerts-log.json`) so a
 * reload or a restart does not lose what came in. Each entry remembers whether
 * it was read; the Alerts tab marks them read, dismisses one, or clears the
 * lot, and asks `stillMatches` whether the record matches its rule today.
 *
 * Toasts are FlexDesk's (NotificationCenter, with `overflow: 'collapse'`: past
 * three, the rest wait behind "+N more"); the bell in the bottom bar is
 * FlexDesk's NotificationHistory. Nothing here is a copy of either.
 */

import { CONFIG, apiUrl, ev } from './instance.js';
import { esc } from './data.js';
import { appName } from '../core/app_identity.js';
import { pageBar, projectFoot } from './page_bar.js';

const LEVEL = {
    info: { toast: 'info', icon: 'info', label: 'Info' },
    warning: { toast: 'warn', icon: 'warning', label: 'Warning' },
    alert: { toast: 'error', icon: 'notifications_active', label: 'Alert' },
};

/** Every alert raised, newest last (the Alerts tab reads it). */
export const ALERT_LOG = [];
export const LOG_LIMIT = 300;
const LOG_FILE = 'alerts-log.json';

let _rules = Array.isArray(CONFIG.alerts) ? CONFIG.alerts : [];
export const alertRules = () => _rules;

const _sets = new Map();        // rule id -> Set of record keys matching it
let _bus = null;
let _ready = false;

async function storeRows(store) {
    if (store === 'bugs') {
        const [{ TICKETS }, { MODEL }] = await Promise.all([import('./data.js'), import('./filters.js')]);
        return { model: MODEL, rows: TICKETS.map((t) => ({ row: t, key: `bugs:${t.bugId}`, ref: t.id, title: t.summary })) };
    }
    const [{ ITEMS }, { MODEL }] = await Promise.all([import('./backlog_data.js'), import('./backlog_filters.js')]);
    return { model: MODEL, rows: ITEMS.map((i) => ({ row: i, key: `backlog:${i.id}`, ref: i.ref, title: i.title })) };
}

/**
 * Compare every rule's matches with the last time; raise the newcomers.
 * `quiet` takes the sets without raising anything — the starting point.
 */
export async function checkAlerts({ quiet = false } = {}) {
    const byStore = {};
    for (const rule of _rules) {
        if (rule.enabled === false || !rule.expr) continue;
        byStore[rule.store] ??= await storeRows(rule.store);
        const { model, rows } = byStore[rule.store];
        let match;
        try { match = model.matcherFor(rule.expr); } catch { continue; }
        const now = new Set();
        const fresh = [];
        for (const r of rows) {
            let hit = false;
            try { hit = !!match(r.row); } catch { hit = false; }
            if (!hit) continue;
            now.add(r.key);
            if (_sets.has(rule.id) && !_sets.get(rule.id).has(r.key)) fresh.push(r);
        }
        const first = !_sets.has(rule.id);
        _sets.set(rule.id, now);
        if (!quiet && !first) for (const r of fresh) raise(rule, r);
    }
    // The rules' "N now" counts and each entry's still-matches move with every check.
    _bus?.emit?.('alerts:changed', {});
}

/* ── the log ─────────────────────────────────────────────────────── */

let _saveTimer = null;
let _loaded = false;

/** Tell the panes, and save a moment later (one write for a burst). */
function changed() {
    _bus?.emit?.('alerts:changed', {});
    if (!_loaded) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        const data = JSON.stringify(ALERT_LOG.map((a) => ({ ...a, at: a.at.toISOString() })));
        fetch(apiUrl('/workspace_state_write'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: LOG_FILE, data }),
        }).catch((err) => console.warn('[bugdesk] the alert log could not be saved', err));
    }, 400);
}

/** Read the saved log. Entries raised before it arrived are kept, after it. */
async function loadLog() {
    try {
        const res = await fetch(apiUrl('/workspace_state_read'), {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ path: LOG_FILE }),
        });
        const j = await res.json().catch(() => null);
        const saved = j?.result ? JSON.parse(j.result) : [];
        if (Array.isArray(saved)) {
            const old = saved.filter((a) => a && a.ref).map((a) => ({ ...a, at: new Date(a.at) }));
            ALERT_LOG.unshift(...old);
            if (ALERT_LOG.length > LOG_LIMIT) ALERT_LOG.splice(0, ALERT_LOG.length - LOG_LIMIT);
        }
    } catch (err) {
        console.warn('[bugdesk] the alert log could not be read', err);
    }
    _loaded = true;
    _bus?.emit?.('alerts:changed', {});
}

/** How many records match `ruleId` now; null before the rule has been checked. */
export const matchingNow = (ruleId) => (_sets.has(ruleId) ? _sets.get(ruleId).size : null);

/** Does the entry's record still match its rule? null when that is not known. */
export function stillMatches(entry) {
    const set = _sets.get(entry.ruleId);
    return set && entry.key ? set.has(entry.key) : null;
}

export const unreadCount = () => ALERT_LOG.filter((a) => !a.read).length;

/** Mark these entries read — all of them when `ids` is omitted. */
export function markRead(ids = null) {
    const want = ids ? new Set(ids) : null;
    let any = false;
    for (const a of ALERT_LOG) if (!a.read && (!want || want.has(a.id))) { a.read = true; any = true; }
    if (any) changed();
}

/** Remove these entries — all of them when `ids` is omitted. */
export function dismiss(ids = null) {
    const want = ids ? new Set(ids) : null;
    const before = ALERT_LOG.length;
    for (let i = ALERT_LOG.length - 1; i >= 0; i--) if (!want || want.has(ALERT_LOG[i].id)) ALERT_LOG.splice(i, 1);
    if (ALERT_LOG.length !== before) changed();
}

let _seq = 0;

function raise(rule, r) {
    const level = LEVEL[rule.level] || LEVEL.info;
    const entry = {
        id: `${Date.now().toString(36)}-${(_seq++).toString(36)}`, at: new Date(),
        ruleId: rule.id, rule: rule.name, level: rule.level || 'info',
        ref: r.ref, title: r.title, store: rule.store, key: r.key, read: false,
    };
    ALERT_LOG.push(entry);
    if (ALERT_LOG.length > LOG_LIMIT) ALERT_LOG.shift();
    _bus?.emit?.('alerts:new', entry);
    changed();
    if (rule.toast) {
        _bus?.emit?.('toast:show', {
            type: level.toast,
            title: `${level.label}: ${rule.name}`,
            message: `${r.ref} — ${r.title}`,
            persistent: !!rule.sticky,
            namespace: 'alerts',
            actions: [{ label: 'Open', handler: () => openRef(r.ref) }],
        });
    }
}

/** Open the record a ref names, in this copy's store. */
export async function openRef(ref) {
    const [{ parseRef }, { openRow }] = await Promise.all([import('./refs.js'), import('./records.js')]);
    const parsed = parseRef(ref, 'bugs');
    const wm = window.__twm?.wm;
    if (parsed && wm) openRow(wm, {}, parsed);
}

/**
 * Start watching. Called once the stores are loaded (install.js).
 * @param {object} o
 * @param {object} o.eventBus
 */
export async function installAlerts({ eventBus } = {}) {
    if (_ready) return;
    _ready = true;
    _bus = eventBus || null;
    await loadLog();
    if (!_rules.length) return;
    await checkAlerts({ quiet: true });
    let timer = null;
    const soon = (reload) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (reload) {
                const [{ loadData }, { loadBacklog }] = await Promise.all([import('./data.js'), import('./backlog_data.js')]);
                await Promise.all([loadData().catch(() => {}), loadBacklog().catch(() => {})]);
            }
            checkAlerts().catch((err) => console.warn('[bugdesk] alert check failed', err));
        }, 300);
    };
    // A change from outside: live.js has already reloaded the stores.
    for (const name of ['bugs:changed', ev('backlog:changed'), ev('store:changed')]) eventBus?.on?.(name, () => soon(false));
    // A save from this page: the stores may not have been reloaded.
    window.addEventListener('bugdesk:saved', () => soon(true));
}

/* ── the Alerts tab ──────────────────────────────────────────────── */

/** This module's own copy, as a source for the Alerts tab. */
const SELF = { alertRules, ALERT_LOG, matchingNow, stillMatches, markRead, dismiss, openRef, LEVEL };
export { LEVEL };

/** "just now", "5 min ago", "3 h ago"; older than a day: the clock time (the day header has the date). */
function ago(at, now) {
    const s = Math.max(0, (now - at) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(at, now) {
    const d = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((t - d) / 86400000);
    if (days === 0) return 'TODAY';
    if (days === 1) return 'YESTERDAY';
    return at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}

/** The worst level among these entries — the badge's colour. */
export function worstLevel(entries) {
    if (entries.some((a) => a.level === 'alert')) return 'alert';
    if (entries.some((a) => a.level === 'warning')) return 'warning';
    return entries.length ? 'info' : null;
}

/**
 * Mount the bottom panel's Alerts tab: the rules on the left with how many
 * records match each now, the log on the right, newest first, filtered by rule,
 * level and text. Returns `{ refresh, destroy }`.
 *
 * @param {HTMLElement} host
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {Array<{inst: object, alerts: object}>} [o.sources]  store copies; this one by default
 * @param {(b:{unread:number, level:string|null}) => void} [o.onBadge]
 * @param {() => void} [o.onEditRules]  Edit rules (Settings › Alerts)
 */
export function mountAlertsPane(host, { eventBus = null, sources = null, onBadge = null, onEditRules = null } = {}) {
    const srcs = sources?.length ? sources : [{ inst: { storeLabelOf: (s) => (s === 'bugs' ? 'Bugs' : 'Backlog') }, alerts: SELF }];
    let rule = null;                // `${si}:${ruleId}` or null for all
    let level = 'all';
    let q = '';

    const entries = () => srcs.flatMap((s, si) => s.alerts.ALERT_LOG.map((a) => ({ a, s, si, key: `${si}:${a.id}` })))
        .sort((x, y) => y.a.at - x.a.at);
    const ruleKey = (x) => `${x.si}:${x.a.ruleId}`;

    const badge = () => {
        const unread = entries().filter((x) => !x.a.read).map((x) => x.a);
        onBadge?.({ unread: unread.length, level: worstLevel(unread) });
    };

    const render = () => {
        const now = new Date();
        const all = entries();
        const byRule = rule ? all.filter((x) => ruleKey(x) === rule) : all;
        const needle = q.trim().toLowerCase();
        const shown = byRule
            .filter((x) => level === 'all' || x.a.level === level)
            .filter((x) => !needle || `${x.a.ref} ${x.a.title}`.toLowerCase().includes(needle));
        const rules = srcs.flatMap((s, si) => s.alerts.alertRules().map((r) => ({ r, si, key: `${si}:${r.id}`, s })));
        const ruleBtn = (key, dot, name, meta, off = false) => `
            <button type="button" class="bd-alerts__rulebtn${rule === key ? ' bd-alerts__rulebtn--on' : ''}${off ? ' bd-alerts__rulebtn--off' : ''}" data-rule="${esc(key ?? '')}" aria-pressed="${rule === key}">
                <span class="bd-alerts__dot${dot ? ` bd-alerts__dot--${esc(dot)}` : ''}"></span>
                <span class="bd-alerts__rulename">${esc(name)}</span>
                <span class="bd-alerts__meta">${esc(meta)}</span>
            </button>`;
        const chip = (k, label) => {
            const n = byRule.filter((x) => k === 'all' || x.a.level === k).length;
            return `<button type="button" class="bd-alerts__chip${level === k ? ' bd-alerts__chip--on' : ''}" data-level="${k}" aria-pressed="${level === k}">${label} <span>${n}</span></button>`;
        };
        let lastDay = '';
        const rows = shown.map((x) => {
            const { a, s } = x;
            const lv = LEVEL[a.level] || LEVEL.info;
            const still = s.alerts.stillMatches(a);
            const day = dayLabel(a.at, now);
            const head = day !== lastDay ? `<div class="bd-alerts__day">${esc(day)}</div>` : '';
            lastDay = day;
            return `${head}
                <div class="bd-alerts__row bd-alerts__row--${esc(a.level)}${a.read ? '' : ' bd-alerts__row--unread'}">
                    <span class="bd-alerts__unread" aria-label="${a.read ? 'Read' : 'Unread'}"></span>
                    <span class="material-symbols-outlined bd-alerts__icon" title="${esc(lv.label)}">${lv.icon}</span>
                    <span class="bd-alerts__time" title="${esc(a.at.toLocaleString())}">${esc(ago(a.at, now))}</span>
                    <span class="bd-alerts__rule">${esc(a.rule)}</span>
                    <span class="bd-alerts__store">${esc(s.inst.storeLabelOf(a.store))}</span>
                    <a href="#" class="bd-alerts__ref" data-open="${esc(x.key)}">${esc(a.ref)}</a>
                    <span class="bd-alerts__title">${esc(a.title)}</span>
                    <span class="bd-alerts__state${still === false ? ' bd-alerts__state--gone' : ''}">${still === true ? 'still matches' : still === false ? 'no longer matches' : ''}</span>
                    <span class="bd-alerts__acts">
                        <button type="button" class="bd-alerts__icon-btn" data-open="${esc(x.key)}" aria-label="Open ${esc(a.ref)}" title="Open">${'<span class="material-symbols-outlined">open_in_new</span>'}</button>
                        <button type="button" class="bd-alerts__icon-btn" data-dismiss="${esc(x.key)}" aria-label="Dismiss this alert" title="Dismiss">${'<span class="material-symbols-outlined">close</span>'}</button>
                    </span>
                </div>`;
        }).join('');
        const noRules = !rules.length;
        const scroll = host.querySelector('.bd-alerts__log')?.scrollTop ?? 0;
        const typing = document.activeElement?.dataset?.slot === 'alert-q' && host.contains(document.activeElement);
        host.innerHTML = `
            <div class="bd-alerts">
                <div class="bd-alerts__rules">
                    <div class="bd-alerts__head">
                        <span class="bd-alerts__caps">RULES</span>
                        <span class="td-spacer"></span>
                        <a href="#" data-act="edit-rules">Edit rules</a>
                    </div>
                    <div class="bd-alerts__rulelist">
                        ${ruleBtn(null, null, 'All alerts', `${all.length}`)}
                        ${rules.map(({ r, s, key }) => {
                            const n = s.alerts.matchingNow(r.id);
                            const meta = r.enabled === false ? 'off' : n === null ? '' : `${n} now`;
                            const name = srcs.length > 1 && s.inst.IS_TRACKER_COPY ? `${r.name} · Tracker` : r.name;
                            return ruleBtn(key, r.level || 'info', name || 'Unnamed rule', meta, r.enabled === false);
                        }).join('')}
                        ${noRules ? '<div class="td-dim bd-alerts__empty">No rules yet.</div>' : ''}
                    </div>
                    <div class="bd-alerts__foot">Counts are records matching now. A rule fires when a record starts to match, while BugDesk is open.</div>
                </div>
                <div class="bd-alerts__main">
                    <div class="bd-alerts__bar">
                        <div class="bd-alerts__chips" role="group" aria-label="Level">
                            ${chip('all', 'All')}${chip('alert', 'Alert')}${chip('warning', 'Warning')}${chip('info', 'Info')}
                        </div>
                        <input type="text" autocomplete="off" spellcheck="false" class="ea-tin bd-alerts__q" data-slot="alert-q" aria-label="Filter alerts" placeholder="Filter by ref or title" value="${esc(q)}">
                        <span class="td-spacer"></span>
                        <button type="button" class="ea-btn" data-act="read-all" ${all.some((x) => !x.a.read) ? '' : 'disabled'}>Mark all read</button>
                        <button type="button" class="ea-btn" data-act="clear" ${all.length ? '' : 'disabled'}>Clear</button>
                    </div>
                    <div class="bd-alerts__log">
                        ${rows || `<div class="td-dim bd-alerts__none">${noRules
                            ? 'No alert rules yet. Edit rules to add one: an alert fires when a record starts matching it.'
                            : all.length ? 'No alerts match.' : 'Nothing yet. Alerts appear here when a record starts matching a rule.'}</div>`}
                    </div>
                    <div class="bd-alerts__status">Kept across restarts · the last ${LOG_LIMIT} · toasts follow each rule's setting</div>
                </div>
            </div>`;
        const log = host.querySelector('.bd-alerts__log');
        if (log) log.scrollTop = scroll;
        if (typing) {
            const input = host.querySelector('[data-slot="alert-q"]');
            input?.focus();
            input?.setSelectionRange(q.length, q.length);
        }
        badge();
    };

    const find = (key) => entries().find((x) => x.key === key);

    host.addEventListener('click', (e) => {
        const r = e.target.closest('[data-rule]');
        if (r) { rule = r.dataset.rule || null; render(); return; }
        const lv = e.target.closest('[data-level]');
        if (lv) { level = lv.dataset.level; render(); return; }
        const open = e.target.closest('[data-open]');
        if (open) {
            e.preventDefault();
            const x = find(open.dataset.open);
            if (!x) return;
            x.s.alerts.markRead([x.a.id]);
            x.s.alerts.openRef(x.a.ref);
            return;
        }
        const dis = e.target.closest('[data-dismiss]');
        if (dis) {
            const x = find(dis.dataset.dismiss);
            if (x) x.s.alerts.dismiss([x.a.id]);
            return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'edit-rules') { e.preventDefault(); onEditRules?.(); }
        else if (act === 'read-all') for (const s of srcs) s.alerts.markRead();
        else if (act === 'clear') for (const s of srcs) s.alerts.dismiss();
    });
    host.addEventListener('input', (e) => {
        if (e.target.dataset?.slot !== 'alert-q') return;
        q = e.target.value;
        render();
    });

    const subs = [eventBus?.on?.('alerts:changed', render)];
    // "5 min ago" has to move on its own.
    const timer = setInterval(render, 60000);
    render();
    return {
        refresh: render,
        destroy: () => {
            clearInterval(timer);
            for (const s of subs) { try { s?.dispose?.(); s?.(); } catch { /* gone */ } }
        },
    };
}

/* ── Settings › Alerts ───────────────────────────────────────────── */

/**
 * The rules editor, unattached: drawn on the Settings page (`mountAlertsRules`,
 * STORY-0032) and in a window from the Alerts tab's Edit rules
 * (`openAlertsEditor`) — which, on a tracker's page, edits the tracker's rules.
 * @param {object} o
 * @param {object} [o.eventBus]
 * @param {() => void} [o.onChange]  after any edit
 * @param {boolean} [o.page]         on the Settings page: no Cancel/Save row
 */
async function alertsRulesEditor({ eventBus = null, onChange = () => {}, page = false } = {}) {
    const [{ openFilterEditor }, bugsF, backF, { TICKETS }, { ITEMS }] = await Promise.all([
        import('./filter_editor.js'), import('./filters.js'), import('./backlog_filters.js'),
        import('./data.js'), import('./backlog_data.js'),
    ]);
    const hasBugs = CONFIG.store?.hasBugs !== false && CONFIG.mode !== 'tracker';
    const stores = [...(hasBugs ? ['bugs'] : []), 'backlog'];
    const modelOf = (s) => (s === 'bugs' ? bugsF.MODEL : backF.MODEL);
    const copy = () => _rules.map((r) => ({ ...r, expr: JSON.parse(JSON.stringify(r.expr || null)) }));
    let rules = copy();
    let base = JSON.stringify(rules);
    let problems = [];

    const body = document.createElement('div');
    // On the page the editor is the surface; in a window it keeps the window's actions row.
    body.className = page ? 'bd-surface bd-alerts-edit' : 'bd-schema bd-alerts-edit';
    const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const sym = (name) => `<span class="material-symbols-outlined">${name}</span>`;
    const render = () => {
        body.innerHTML = `
            <div class="bd-schema__main bd-alerts-edit__main">
                ${problems.length ? `<div class="bd-schema__problems" role="alert">${sym('error')}<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
                <div class="bd-schema__shead"><h4>Rules</h4><span class="bd-schema__cnt">${rules.length || ''}</span>
                    <button type="button" class="ea-btn" data-act="add">${sym('add')} Add rule</button></div>
                ${rules.length ? `<div class="bd-alerts-edit__grid">
                    <span class="bd-alerts-edit__h"></span><span class="bd-alerts-edit__h">Name</span><span class="bd-alerts-edit__h">Records</span>
                    <span class="bd-alerts-edit__h">Level</span><span class="bd-alerts-edit__h">When a record starts matching</span>
                    <span class="bd-alerts-edit__h">Toast</span><span class="bd-alerts-edit__h" title="A sticky toast closes only with ×">Sticky</span><span class="bd-alerts-edit__h"></span>
                    ${rules.map((r, i) => {
                        const off = r.enabled === false ? ' bd-alerts-edit__c--off' : '';
                        const c = `bd-alerts-edit__c${off}`;
                        return `
                    <span class="${c} bd-alerts-edit__on" data-rule="${i}"><input type="checkbox" data-k="enabled" ${off ? '' : 'checked'}
                        title="${off ? 'Off: this rule raises nothing' : 'On'}" aria-label="Rule on"></span>
                    <span class="${c}" data-rule="${i}"><input type="text" data-k="name" value="${esc(r.name || '')}" placeholder="Crash on me" aria-label="Name"></span>
                    <span class="${c}" data-rule="${i}"><select data-k="store" aria-label="Records">${stores.map((s) => opt(s, r.store, s === 'bugs' ? 'Bugs' : (CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog'))).join('')}</select></span>
                    <span class="${c}" data-rule="${i}"><select data-k="level" class="bd-alerts-edit__lvl bd-alerts-edit__lvl--${esc(r.level || 'info')}" aria-label="Level">${
                        Object.entries(LEVEL).map(([k, v]) => opt(k, r.level, v.label)).join('')}</select></span>
                    <span class="${c} bd-alerts-edit__cond" data-rule="${i}">${r.expr
                        ? `<span class="bd-alerts-edit__expr" title="${esc(modelOf(r.store).describeFilter(r.expr))}">${esc(modelOf(r.store).describeFilter(r.expr))}</span>
                           <button type="button" class="bd-schema__rm" data-cond="${i}" title="Edit condition" aria-label="Edit condition">${sym('filter_alt')}</button>`
                        : `<span class="bd-alerts-edit__expr bd-alerts-edit__expr--none">No condition yet</span>
                           <button type="button" class="ea-btn" data-cond="${i}">${sym('filter_alt')} Set condition</button>`}</span>
                    <span class="${c}" data-rule="${i}"><input type="checkbox" data-k="toast" ${r.toast ? 'checked' : ''} aria-label="Toast"></span>
                    <span class="${c}" data-rule="${i}"><input type="checkbox" data-k="sticky" ${r.sticky ? 'checked' : ''} ${r.toast ? '' : 'disabled'} aria-label="Sticky toast"></span>
                    <span class="${c}"><button type="button" class="bd-schema__rm" data-rm="${i}" title="Remove this rule" aria-label="Remove this rule">${sym('close')}</button></span>`;
                    }).join('')}
                </div>` : '<div class="td-dim bd-schema__empty">No rules yet. Add one: an alert fires when a record starts matching its condition.</div>'}
                <div class="bd-alerts-edit__how">
                    <div><b>Fires once</b>A rule raises an alert when a record starts matching, and not again while it keeps matching.</div>
                    <div><b>Where alerts go</b>The bottom panel's Alerts tab, and a toast if the rule asks for one.</div>
                    <div><b>Only while open</b>Changes made while ${esc(appName())} was closed are not reported when it opens.</div>
                </div>
            </div>
            ${page ? '' : `
            <div class="ea-modal__actions bd-schema__actions">
                <span class="td-dim bd-schema__path">Saved to .bugdesk/project.json, shared with everyone on this store.</span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>`}`;
        onChange();
    };
    body.addEventListener('input', (e) => {
        const row = e.target.closest('[data-rule]');
        if (!row) return;
        const r = rules[Number(row.dataset.rule)];
        const k = e.target.dataset.k;
        if (k === 'name') r.name = e.target.value;
        onChange();
    });
    body.addEventListener('change', (e) => {
        const row = e.target.closest('[data-rule]');
        if (!row) return;
        const r = rules[Number(row.dataset.rule)];
        const k = e.target.dataset.k;
        if (k === 'store') { if (r.store !== e.target.value) r.expr = null; r.store = e.target.value; render(); }
        else if (k === 'level') { r.level = e.target.value; render(); }
        else if (k === 'enabled') { r.enabled = e.target.checked; render(); }
        else if (k === 'toast') { r.toast = e.target.checked; if (!r.toast) r.sticky = false; render(); }
        else if (k === 'sticky') r.sticky = e.target.checked;
        onChange();
    });
    body.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'add') {
            rules.push({ id: `rule-${Date.now().toString(36)}`, name: '', store: stores[0], level: 'warning', toast: true, sticky: false, expr: null });
            render(); return;
        }
        if (b.dataset.rm) { rules.splice(Number(b.dataset.rm), 1); render(); return; }
        if (b.dataset.cond) {
            const r = rules[Number(b.dataset.cond)];
            openFilterEditor({
                model: modelOf(r.store), scope: r.store === 'bugs' ? 'bugs' : 'backlog', seedExpr: r.expr,
                items: r.store === 'bugs' ? TICKETS : ITEMS,
                filter: r.expr ? { label: r.name || 'Alert', expr: r.expr } : null,
                onPick: ({ label, expr }) => { r.expr = expr; if (!r.name) r.name = label; render(); },
            });
            return;
        }
        if (b.dataset.act === 'cancel') { onCancel(); return; }
        if (b.dataset.act === 'save') save().then((ok) => ok && onSaved());
    });
    let onCancel = () => {};
    let onSaved = () => {};
    /** Save; resolves true once saved, false with the problems shown. */
    const save = async () => {
        problems = [];
        try {
            const res = await fetch(apiUrl('/project/alerts'), {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ alerts: rules }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) { problems = j?.problems || [j?.error || `HTTP ${res.status}`]; render(); return false; }
            _rules = j.alerts;
            CONFIG.alerts = j.alerts;
            // New rules start from what matches now: no alert for the past.
            _sets.clear();
            await checkAlerts({ quiet: true });
            if (!_ready) installAlerts({ eventBus });
            eventBus?.emit?.('toast:show', { type: 'info', message: 'Alert rules saved.' });
            rules = copy();
            base = JSON.stringify(rules);
            render();
            return true;
        } catch (err) { problems = [err.message]; render(); return false; }
    };
    render();
    return {
        body, save,
        dirty: () => JSON.stringify(rules) !== base,
        discard: () => { rules = copy(); base = JSON.stringify(rules); problems = []; render(); },
        /** The window's own Cancel and Save. */
        onButtons: (cancel, saved) => { onCancel = cancel; onSaved = saved; },
    };
}

/** Open the rules editor in a window. Resolves true once saved. */
export async function openAlertsEditor({ eventBus = null } = {}) {
    const [{ ManagedWindow }, ed] = await Promise.all([import('@flexdesk/widgets'), alertsRulesEditor({ eventBus })]);
    let settle;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-alerts-${Date.now()}`, title: 'Alerts', icon: 'notifications', content: ed.body,
        modal: true, canMinimize: false, canMaximize: true, canResize: true, canDrag: true,
        defaultWidth: 860, defaultHeight: 520, onClose: () => close(false),
    });
    function close(saved) {
        if (closed) return;
        closed = true;
        try { win.close({ force: true }); } catch { /* closing */ }
        settle(saved);
    }
    ed.onButtons(() => close(false), () => close(true));
    win.show();
    return done;
}

/**
 * Settings › Alerts: the rules, on the page, with their own Save.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @returns {Promise<() => void>} cleanup
 */
export async function mountAlertsRules(el, { eventBus = null, actions = null } = {}) {
    let saving = false;
    const wrap = document.createElement('div');
    wrap.className = 'bd-proj bd-alerts-page';
    let ed = null;
    const sync = () => { if (ed) bar.sync({ dirty: ed.dirty(), busy: saving }); };
    const bar = pageBar(actions, wrap, async (act) => {
        if (act === 'discard') { ed.discard(); return; }
        saving = true; sync();
        await ed.save();
        saving = false; sync();
    });
    ed = await alertsRulesEditor({ eventBus, page: true, onChange: () => sync() });
    wrap.append(ed.body);
    wrap.insertAdjacentHTML('beforeend', projectFoot());
    sync();
    el.replaceChildren(wrap);
    return () => bar.remove();
}
