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
 * Toasts are FlexDesk's (NotificationCenter, with `overflow: 'collapse'`: past
 * three, the rest wait behind "+N more"); the bell in the bottom bar is
 * FlexDesk's NotificationHistory. Nothing here is a copy of either.
 */

import { CONFIG, apiUrl, ev } from './instance.js';
import { esc } from './data.js';

const LEVEL = {
    info: { toast: 'info', icon: 'info', label: 'Info' },
    warning: { toast: 'warn', icon: 'warning', label: 'Warning' },
    alert: { toast: 'error', icon: 'notifications_active', label: 'Alert' },
};

/** Every alert raised this session, newest last (the Alerts tab reads it). */
export const ALERT_LOG = [];
const LOG_LIMIT = 300;

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
}

function raise(rule, r) {
    const level = LEVEL[rule.level] || LEVEL.info;
    const entry = { at: new Date(), rule: rule.name, level: rule.level || 'info', ref: r.ref, title: r.title, store: rule.store };
    ALERT_LOG.push(entry);
    if (ALERT_LOG.length > LOG_LIMIT) ALERT_LOG.shift();
    _bus?.emit?.('alerts:new', entry);
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

async function openRef(ref) {
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

/** Mount the bottom panel's Alerts tab: every alert this session, newest first. */
export function mountAlertsPane(host, { eventBus = null } = {}) {
    const render = () => {
        const rows = [...ALERT_LOG].reverse();
        host.innerHTML = `<div class="bd-alerts">
            ${_rules.length ? '' : '<div class="td-dim bd-alerts__empty">No alert rules yet — Settings › Alerts.</div>'}
            ${rows.length ? rows.map((a) => `
                <div class="bd-alerts__row bd-alerts__row--${esc(a.level)}">
                    <span class="material-symbols-outlined">${(LEVEL[a.level] || LEVEL.info).icon}</span>
                    <span class="td-mono td-dim">${a.at.toLocaleTimeString()}</span>
                    <span class="bd-alerts__rule">${esc(a.rule)}</span>
                    <a href="#" class="td-reflink td-mono" data-ref="${esc(a.ref)}">${esc(a.ref)}</a>
                    <span class="bd-alerts__title">${esc(a.title)}</span>
                </div>`).join('')
                : (_rules.length ? '<div class="td-dim bd-alerts__empty">Nothing yet. Alerts appear here when a record starts matching a rule, while BugDesk is open.</div>' : '')}
        </div>`;
    };
    const sub = eventBus?.on?.('alerts:new', render);
    render();
    return { refresh: render, destroy: () => { try { sub?.dispose?.(); sub?.(); } catch { /* gone */ } } };
}

/* ── Settings › Alerts ───────────────────────────────────────────── */

/** Open the rules editor. Resolves true once saved. */
export async function openAlertsEditor({ eventBus = null } = {}) {
    const [{ ManagedWindow }, { openFilterEditor }, bugsF, backF, { TICKETS }, { ITEMS }] = await Promise.all([
        import('@flexdesk/widgets'), import('./filter_editor.js'), import('./filters.js'), import('./backlog_filters.js'),
        import('./data.js'), import('./backlog_data.js'),
    ]);
    const hasBugs = CONFIG.store?.hasBugs !== false && CONFIG.mode !== 'tracker';
    const stores = [...(hasBugs ? ['bugs'] : []), 'backlog'];
    const modelOf = (s) => (s === 'bugs' ? bugsF.MODEL : backF.MODEL);
    let rules = _rules.map((r) => ({ ...r, expr: JSON.parse(JSON.stringify(r.expr || null)) }));
    let problems = [];

    const body = document.createElement('div');
    body.className = 'bd-schema bd-alerts-edit';
    const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const render = () => {
        body.innerHTML = `
            <div class="bd-schema__main" style="grid-column: 1 / -1">
                <p class="td-dim bd-workflow__lede">A rule raises an alert when a record STARTS matching its condition —
                    once, not again while it keeps matching. Alerts show in the bottom panel's Alerts tab and, if you
                    choose, as a toast. They only fire while BugDesk is open: changes made while it was closed are
                    not reported when it opens.</p>
                ${rules.map((r, i) => `
                <div class="ea-modal__row bd-alerts-edit__row" data-rule="${i}">
                    <input type="text" data-k="name" value="${esc(r.name || '')}" placeholder="Crash on me" aria-label="Name">
                    <select data-k="store">${stores.map((s) => opt(s, r.store, s === 'bugs' ? 'Bugs' : (CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog'))).join('')}</select>
                    <select data-k="level">${Object.entries(LEVEL).map(([k, v]) => opt(k, r.level, v.label)).join('')}</select>
                    <label class="td-check"><input type="checkbox" data-k="toast" ${r.toast ? 'checked' : ''}> Toast</label>
                    <label class="td-check" title="A sticky toast closes only with ×"><input type="checkbox" data-k="sticky" ${r.sticky ? 'checked' : ''} ${r.toast ? '' : 'disabled'}> Sticky</label>
                    <button type="button" class="bd-schema__rm" data-rm="${i}" title="Remove this rule"><span class="material-symbols-outlined">close</span></button>
                    <div class="bd-alerts-edit__cond">
                        <span class="td-dim">When</span>
                        <span class="bd-alerts-edit__expr">${r.expr ? esc(modelOf(r.store).describeFilter(r.expr)) : '<i>no condition yet</i>'}</span>
                        <button type="button" class="ea-btn" data-cond="${i}"><span class="material-symbols-outlined">filter_alt</span> ${r.expr ? 'Edit condition' : 'Set condition'}</button>
                    </div>
                </div>`).join('') || '<div class="td-dim bd-schema__empty">No rules yet.</div>'}
                <div class="bd-workflow__foot"><button type="button" class="ea-btn" data-act="add"><span class="material-symbols-outlined">add</span> Add rule</button></div>
                ${problems.length ? `<div class="bd-schema__problems" role="alert"><span class="material-symbols-outlined">error</span><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
            </div>
            <div class="ea-modal__actions bd-schema__actions">
                <span class="td-dim bd-schema__path">Saved to .bugdesk/project.json, shared with everyone on this store.</span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>`;
    };
    body.addEventListener('input', (e) => {
        const row = e.target.closest('[data-rule]');
        if (!row) return;
        const r = rules[Number(row.dataset.rule)];
        const k = e.target.dataset.k;
        if (k === 'name') r.name = e.target.value;
    });
    body.addEventListener('change', (e) => {
        const row = e.target.closest('[data-rule]');
        if (!row) return;
        const r = rules[Number(row.dataset.rule)];
        const k = e.target.dataset.k;
        if (k === 'store') { if (r.store !== e.target.value) r.expr = null; r.store = e.target.value; render(); }
        else if (k === 'level') r.level = e.target.value;
        else if (k === 'toast') { r.toast = e.target.checked; if (!r.toast) r.sticky = false; render(); }
        else if (k === 'sticky') r.sticky = e.target.checked;
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
        if (b.dataset.act === 'cancel') { close(false); return; }
        if (b.dataset.act === 'save') save();
    });
    const save = async () => {
        problems = [];
        try {
            const res = await fetch(apiUrl('/project/alerts'), {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ alerts: rules }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) { problems = j?.problems || [j?.error || `HTTP ${res.status}`]; render(); return; }
            _rules = j.alerts;
            CONFIG.alerts = j.alerts;
            // New rules start from what matches now: no alert for the past.
            _sets.clear();
            await checkAlerts({ quiet: true });
            if (!_ready) installAlerts({ eventBus });
            eventBus?.emit?.('toast:show', { type: 'info', message: 'Alert rules saved.' });
            close(true);
        } catch (err) { problems = [err.message]; render(); }
    };
    let settle;
    const done = new Promise((r) => { settle = r; });
    let closed = false;
    const win = new ManagedWindow({
        id: `bd-alerts-${Date.now()}`, title: 'Alerts', icon: 'notifications', content: body,
        modal: true, canMinimize: false, canMaximize: true, canResize: true, canDrag: true,
        defaultWidth: 860, defaultHeight: 520, onClose: () => close(false),
    });
    function close(saved) {
        if (closed) return;
        closed = true;
        try { win.close({ force: true }); } catch { /* closing */ }
        settle(saved);
    }
    render();
    win.show();
    return done;
}
