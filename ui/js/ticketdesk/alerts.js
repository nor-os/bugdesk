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
 * three, the rest wait behind "+N more"); the Alerts tab and the bell are
 * FlexDesk's alert log, pane and NotificationHistory, on `sharedAlertLog`.
 * Nothing here is a copy of any of them.
 */

import { CONFIG, apiUrl, busEvent, ev, storeLabelOf, IS_TRACKER_COPY } from './instance.js';
import { createAlertLog, mountAlertsPane } from '@flexdesk/widgets';
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
    for (const name of [busEvent('bugs:changed'), ev('backlog:changed'), ev('store:changed')]) eventBus?.on?.(name, () => soon(false));
    // A save from this page: the stores may not have been reloaded.
    window.addEventListener('bugdesk:saved', () => soon(true));
}

/* ── the Alerts tab ──────────────────────────────────────────────── */

/*
 * The tab is FlexDesk's (STORY-0031): its alert log (`createAlertLog`), its
 * pane (`mountAlertsPane`) and the bell on the same log. What stays here is
 * what only BugDesk has — the rules, which records match them now, and the log
 * each store copy keeps — handed to FlexDesk as the log's SOURCE and the pane's
 * rules column.
 *
 * One log covers every store copy the page shows (the page's own and, on a
 * project page, the tracker's: `bottomSources` in pages.js). An entry's id and
 * rule id are prefixed with its copy's index, so the two copies' ids never
 * meet; read and dismiss go back to the copy the entry came from, and every
 * `alerts:changed` — from either copy — re-reads the lot.
 */

/** This copy alone, when the caller names no sources. */
const SELF = { inst: { storeLabelOf, IS_TRACKER_COPY }, alerts: { alertRules, ALERT_LOG, matchingNow, stillMatches, markRead, dismiss, openRef } };

let _shared = null;
let _sources = null;
let _heard = false;

const srcs = () => (_sources?.length ? _sources : [SELF]);

/** The log's source: every copy's ALERT_LOG, newest first. */
function mergedSource() {
    const route = (verb, ids) => {
        const list = srcs();
        if (!ids) { for (const s of list) s.alerts[verb](); return; }
        const by = new Map();
        for (const id of ids) {
            const cut = String(id).indexOf(':');
            const si = Number(String(id).slice(0, cut));
            if (!list[si]) continue;
            if (!by.has(si)) by.set(si, []);
            by.get(si).push(String(id).slice(cut + 1));
        }
        for (const [si, own] of by) list[si].alerts[verb](own);
    };
    return {
        load() {
            const entries = srcs().flatMap((s, si) => s.alerts.ALERT_LOG.map((a) => ({
                id: `${si}:${a.id}`, at: a.at, level: a.level, title: a.title, ref: a.ref, read: a.read,
                ruleId: `${si}:${a.ruleId}`, rule: a.rule, store: a.store, key: a.key, si, ownRuleId: a.ruleId,
            }))).sort((x, y) => y.at - x.at);
            return { entries, more: false };
        },
        markRead: (ids) => route('markRead', ids),
        dismiss: (ids) => route('dismiss', ids),
    };
}

/**
 * The one alert log of this page, which the Alerts tab and the bell both read.
 * @param {object} [o]
 * @param {object} [o.eventBus]  its `alerts:changed` re-reads the log
 * @param {Array<{inst: object, alerts: object}>} [o.sources]  store copies; this one by default
 */
export function sharedAlertLog({ eventBus = null, sources = null } = {}) {
    if (sources) _sources = sources;
    if (!_shared) _shared = createAlertLog({ source: mergedSource(), limit: LOG_LIMIT * 2 });
    // The bus may arrive after the log (installAlerts sets `_bus`); hear it once.
    const bus = eventBus || _bus;
    if (bus && !_heard) {
        _heard = true;
        bus.on?.('alerts:changed', () => _shared.refresh());
    }
    if (sources) _shared.refresh();
    return _shared;
}

/**
 * Mount the bottom panel's Alerts tab: the rules on the left with how many
 * records match each now, the log on the right. Returns `{ refresh, destroy }`.
 *
 * @param {HTMLElement} host
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {Array<{inst: object, alerts: object}>} [o.sources]  store copies; this one by default
 * @param {(b:{unread:number, level:string|null}) => void} [o.onBadge]
 * @param {() => void} [o.onEditRules]  Edit rules (Settings › Alerts)
 */
export function mountAlertsTab(host, { eventBus = null, sources = null, onBadge = null, onEditRules = null } = {}) {
    const log = sharedAlertLog({ eventBus, sources });
    const copy = (entry) => srcs()[entry.si] ?? srcs()[0];
    const noRules = () => !srcs().some((s) => s.alerts.alertRules().length);
    return mountAlertsPane(host, {
        log,
        onBadge,
        onOpen: (entry) => copy(entry).alerts.openRef(entry.ref),
        rules: {
            list: () => srcs().flatMap((s, si) => s.alerts.alertRules().map((r) => {
                const n = s.alerts.matchingNow(r.id);
                return {
                    id: `${si}:${r.id}`,
                    name: srcs().length > 1 && s.inst.IS_TRACKER_COPY ? `${r.name} · Tracker` : r.name,
                    level: r.level || 'info',
                    meta: r.enabled === false ? 'off' : n === null ? '' : `${n} now`,
                    off: r.enabled === false,
                };
            })),
            onEdit: onEditRules,
            foot: 'Counts are records matching now. A rule fires when a record starts to match, while BugDesk is open.',
        },
        stillMatches: (entry) => copy(entry).alerts.stillMatches({ ruleId: entry.ownRuleId, key: entry.key }),
        describe: (entry) => copy(entry).inst.storeLabelOf(entry.store),
        status: `Kept across restarts · the last ${LOG_LIMIT} · toasts follow each rule's setting`,
        empty: {
            get none() {
                return noRules()
                    ? 'No alert rules yet. Edit rules to add one: an alert fires when a record starts matching it.'
                    : 'Nothing yet. Alerts appear here when a record starts matching a rule.';
            },
            filtered: 'No alerts match.',
        },
    });
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
